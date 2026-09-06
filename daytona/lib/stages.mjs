// Shared gate stages. Both gate.mjs and tournament.mjs run commands through these so the
// classification rules live in one place.
//
// Classification honesty (improvement-loop lesson 52 applied to the gate itself):
//   - 'ci'   stages (npm ci): a non-zero exit or timeout, after one retry, is INFRA — never a
//            code verdict. npm ci mostly fails on the registry/network; a red gate must mean code.
//   - 'test' stages (npm test, build-data, git diff, fitness): non-zero = FAIL, timeout = FAIL
//            (a hung test is a real problem worth surfacing). These are the verdict-bearing stages.
//   - 'smoke' is experimental and clearly labelled.

import { runStep } from './sandbox.mjs';

const STATUS = { PASS: 'pass', FAIL: 'fail', INFRA: 'infra', SKIP: 'skip' };

function tailOf(output, n = 40) {
  const lines = (output || '').replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

// Run one classified stage. Returns { name, kind, status, exitCode, wallSec, tail, note }.
export async function runStage(sandbox, { name, kind = 'test', command, cwd, deadlineSec, onLine }) {
  const attempt = () => runStep(sandbox, command, { cwd, deadlineSec, label: name, onLine });

  let r = await attempt();
  if (kind === 'ci' && (r.timedOut || r.exitCode !== 0)) {
    onLine?.(`[${name}] first attempt failed — retrying once`);
    r = await attempt();
  }

  const base = { name, kind, exitCode: r.exitCode, wallSec: r.wallSec, tail: tailOf(r.output) };

  if (r.timedOut) {
    return kind === 'ci'
      ? { ...base, status: STATUS.INFRA, note: `timed out after ${deadlineSec}s (treated as infra for a ci stage)` }
      : { ...base, status: STATUS.FAIL, note: `TIMED OUT after ${deadlineSec}s` };
  }
  if (r.exitCode === 0) return { ...base, status: STATUS.PASS };
  return kind === 'ci'
    ? { ...base, status: STATUS.INFRA, note: 'npm ci failed after retry — usually network/registry; check tail for a lockfile error' }
    : { ...base, status: STATUS.FAIL };
}

// The staleness gate: build-data, THEN `git diff --quiet` as a SEPARATE command whose exit code
// is read as an answer, not an error (lesson 18 — never gate a required mutation behind a check).
export async function stalenessStage(sandbox, dir, { onLine } = {}) {
  const build = await runStage(sandbox, {
    name: 'staleness:build-data', kind: 'test',
    command: 'npm run build-data', cwd: `${dir}/app`, deadlineSec: 300, onLine,
  });
  if (build.status !== STATUS.PASS) return { ...build, name: 'staleness' };

  // git diff --quiet: 0 = clean, 1 = drift. Read the exit code directly.
  const r = await runStep(sandbox, 'git diff --quiet', { cwd: dir, deadlineSec: 60, label: 'staleness:diff' });
  if (r.exitCode === 0) {
    return { name: 'staleness', kind: 'test', status: STATUS.PASS, exitCode: 0, wallSec: r.wallSec, tail: '' };
  }
  if (r.exitCode === 1) {
    const stat = await runStep(sandbox, 'git diff --stat', { cwd: dir, deadlineSec: 60, label: 'staleness:stat' });
    return {
      name: 'staleness', kind: 'test', status: STATUS.FAIL, exitCode: 1, wallSec: r.wallSec,
      tail: tailOf(stat.output),
      note: 'build-data changed committed files — the generated bundle (kb-data.mjs / learn-data.js) is stale in the shipped tree',
    };
  }
  return { name: 'staleness', kind: 'test', status: STATUS.INFRA, exitCode: r.exitCode, wallSec: r.wallSec, tail: tailOf(r.output), note: 'git diff exited abnormally' };
}

// Experimental workerd smoke: init local D1, boot `wrangler dev`, probe two routes, kill it.
// Default OFF (gate --smoke). First run may download the workerd binary (slow/flaky).
export async function smokeStage(sandbox, dir, { onLine } = {}) {
  const script = [
    'npm run db:init:local >/tmp/dbinit.log 2>&1 || { echo DBINIT_FAIL; tail -5 /tmp/dbinit.log; exit 1; }',
    'npm run build-data >/dev/null 2>&1',
    '(wrangler dev --port 8787 --ip 127.0.0.1 >/tmp/wd.log 2>&1 &)',
    'ok=0; for i in $(seq 1 40); do sleep 2; curl -sf -o /dev/null http://127.0.0.1:8787/ && { ok=1; break; }; done',
    'code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/today)',
    'echo "root_up=$ok today_status=$code"',
    'pkill -f "wrangler dev" 2>/dev/null || true',
    // Home page must serve and /api/today must answer (401 unauth or 200) — the door responds.
    'test "$ok" = "1" && { [ "$code" = "401" ] || [ "$code" = "200" ]; }',
  ].join('\n');
  const r = await runStage(sandbox, {
    name: 'smoke', kind: 'test', command: script, cwd: `${dir}/app`, deadlineSec: 300, onLine,
  });
  if (r.status === STATUS.FAIL) r.note = `${r.note ? r.note + '; ' : ''}workerd smoke is experimental — a fail here may be a workerd/wrangler-dev quirk, not the app`;
  return r;
}

// The full gate sequence (gate.mjs). Fail-fast: after the first non-pass, remaining stages are SKIP.
export async function runFullGate(sandbox, dir, { smoke = false, onLine } = {}) {
  const specs = [
    { name: 'root-ci', kind: 'ci', command: 'npm ci --prefer-offline --no-audit --no-fund --cache /opt/npm-cache', cwd: dir, deadlineSec: 300 },
    { name: 'root-test', kind: 'test', command: 'npm test', cwd: dir, deadlineSec: 600 },
    { name: 'app-ci', kind: 'ci', command: 'npm ci --prefer-offline --no-audit --no-fund --cache /opt/npm-cache', cwd: `${dir}/app`, deadlineSec: 480 },
    { name: 'app-test', kind: 'test', command: 'npm test', cwd: `${dir}/app`, deadlineSec: 900 },
  ];

  const results = [];
  let aborted = false;
  for (const spec of specs) {
    if (aborted) { results.push({ name: spec.name, kind: spec.kind, status: STATUS.SKIP }); continue; }
    onLine?.(`── stage ${spec.name} ──`);
    const res = await runStage(sandbox, { ...spec, onLine });
    results.push(res);
    if (res.status !== STATUS.PASS) aborted = true;
  }

  // staleness stage
  if (aborted) results.push({ name: 'staleness', kind: 'test', status: STATUS.SKIP });
  else {
    onLine?.('── stage staleness ──');
    const res = await stalenessStage(sandbox, dir, { onLine });
    results.push(res);
    if (res.status !== STATUS.PASS) aborted = true;
  }

  // optional smoke
  if (smoke) {
    if (aborted) results.push({ name: 'smoke', kind: 'test', status: STATUS.SKIP });
    else { onLine?.('── stage smoke (experimental) ──'); results.push(await smokeStage(sandbox, dir, { onLine })); }
  }

  return results;
}

// Install deps so a freshly-prepared repo is testable (tournament runs this BEFORE the agent works).
export async function installDeps(sandbox, dir, { onLine } = {}) {
  const root = await runStage(sandbox, { name: 'root-ci', kind: 'ci', command: 'npm ci --prefer-offline --no-audit --no-fund --cache /opt/npm-cache', cwd: dir, deadlineSec: 300, onLine });
  if (root.status !== STATUS.PASS) return [root, { name: 'app-ci', kind: 'ci', status: STATUS.SKIP }];
  const app = await runStage(sandbox, { name: 'app-ci', kind: 'ci', command: 'npm ci --prefer-offline --no-audit --no-fund --cache /opt/npm-cache', cwd: `${dir}/app`, deadlineSec: 480, onLine });
  return [root, app];
}

// The verdict-bearing chain the tournament runs AFTER the agent works (deps already installed).
export async function runMeasureChain(sandbox, dir, { onLine } = {}) {
  const results = [];
  let aborted = false;
  for (const spec of [
    { name: 'root-test', kind: 'test', command: 'npm test', cwd: dir, deadlineSec: 600 },
    { name: 'app-test', kind: 'test', command: 'npm test', cwd: `${dir}/app`, deadlineSec: 900 },
  ]) {
    if (aborted) { results.push({ name: spec.name, kind: spec.kind, status: STATUS.SKIP }); continue; }
    const res = await runStage(sandbox, { ...spec, onLine });
    results.push(res);
    if (res.status !== STATUS.PASS) aborted = true;
  }
  results.push(aborted ? { name: 'staleness', kind: 'test', status: STATUS.SKIP } : await stalenessStage(sandbox, dir, { onLine }));
  return results;
}

export { STATUS, tailOf };
