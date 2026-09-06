// The ONLY place sandbox lifecycle and command execution happen.
//
// Every command runs through a long-running session with an explicit orchestrator-side
// deadline — never bare `process.executeCommand`, whose default timeout is 10 seconds
// (the SDK's #1 footgun). Keeping all exec here means that rule is enforced in one place.

import { Daytona } from '@daytona/sdk';
import { SNAPSHOT_NAME, RESOURCES, hbImage } from './image.mjs';
import { sleep, nowMs, fmtDur, InfraError, loadEnv } from './util.mjs';

// Every entry script imports this module, so loading daytona/.env here covers all of them.
loadEnv();

const SESSION = 'hb-main';
const POLL_MS = 3000;

export function getClient() {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new InfraError(
      'DAYTONA_API_KEY is not set.',
      'export DAYTONA_API_KEY=... (see daytona/README.md). Never commit it.',
    );
  }
  const cfg = { apiKey };
  if (process.env.DAYTONA_API_URL) cfg.apiUrl = process.env.DAYTONA_API_URL;
  if (process.env.DAYTONA_TARGET) cfg.target = process.env.DAYTONA_TARGET;
  return new Daytona(cfg);
}

// Create a sandbox from the pre-built snapshot (fast, resources baked in). If HB_USE_IMAGE=1
// is set, build from the Image definition instead (slower first create; useful before the
// snapshot has ever been built). Any create failure is InfraError — never a code verdict.
export async function createSandbox(daytona, { purpose, runId, variant, envVars = {}, autoStopInterval, ttlMinutes }) {
  const labels = { hb: '1', purpose, runId };
  if (variant) labels.variant = variant;

  const base = {
    labels,
    envVars,
    ephemeral: true,          // auto-deleted on stop — first line of the delete-aggressively defense
    autoDeleteInterval: 0,    // 0 = delete immediately on stop
    autoStopInterval,         // gate: 30 (idle stop ok between runs); tournament: 0 (never idle-stop a live Claude run)
    ttlMinutes,               // wall-clock hard kill regardless of state — the real backstop
  };

  let params;
  if (process.env.HB_USE_IMAGE === '1') {
    params = { ...base, image: hbImage(), resources: RESOURCES };
  } else {
    params = { ...base, snapshot: SNAPSHOT_NAME };
  }

  try {
    const onSnapshotCreateLogs = process.env.HB_USE_IMAGE === '1' ? (l) => process.stderr.write(`  [image] ${l}\n`) : undefined;
    const sandbox = await daytona.create(params, { timeout: 300, onSnapshotCreateLogs });
    await sandbox.process.createSession(SESSION);
    return sandbox;
  } catch (err) {
    throw new InfraError(
      `Sandbox create failed (${purpose}${variant ? '/' + variant : ''}): ${err?.message || err}`,
      process.env.HB_USE_IMAGE === '1'
        ? 'Check DAYTONA_API_KEY, org quota, and network.'
        : `The '${SNAPSHOT_NAME}' snapshot may be missing or deactivated (snapshots deactivate after 2 weeks unused). Run: npm run snapshot:build  (or HB_USE_IMAGE=1 to build from the image inline).`,
    );
  }
}

// Resolve the absolute repo path once (container home is usually /root, but ask to be safe).
export async function repoDir(sandbox) {
  let root;
  try { root = await sandbox.getUserRootDir(); } catch { /* fall through */ }
  root = root || '/root';
  return `${root.replace(/\/$/, '')}/work/repo`;
}

// Run one command to completion (or deadline). Streams new output through onLine.
// Returns { exitCode, output, timedOut, silent, wallSec }. exitCode is null iff timedOut/aborted.
export async function runStep(sandbox, command, { cwd, deadlineSec, label, onLine, silenceSec } = {}) {
  const wrapped = cwd ? `cd '${cwd}' && ${command}` : command;
  const started = nowMs();
  let cmdId;
  try {
    const res = await sandbox.process.executeSessionCommand(SESSION, { command: wrapped, runAsync: true });
    cmdId = res.cmdId;
  } catch (err) {
    // Session dispatch failure is infra, not a code failure.
    throw new InfraError(`Could not dispatch command${label ? ' [' + label + ']' : ''}: ${err?.message || err}`);
  }

  let seenLen = 0;
  let lastGrowth = nowMs();
  const readLogs = async () => {
    try {
      const r = await sandbox.process.getSessionCommandLogs(SESSION, cmdId);
      return r?.output ?? '';
    } catch { return null; }
  };

  while (true) {
    let cmd;
    try {
      cmd = await sandbox.process.getSessionCommand(SESSION, cmdId);
    } catch {
      cmd = null; // transient; keep polling until deadline
    }

    const logs = await readLogs();
    if (logs != null && logs.length > seenLen) {
      const delta = logs.slice(seenLen);
      seenLen = logs.length;
      lastGrowth = nowMs();
      if (onLine) for (const line of delta.split('\n')) if (line) onLine(line);
    }

    if (cmd && cmd.exitCode != null) {
      const finalLogs = (await readLogs()) ?? logs ?? '';
      return { exitCode: cmd.exitCode, output: finalLogs, timedOut: false, silent: false, wallSec: (nowMs() - started) / 1000 };
    }

    const wallSec = (nowMs() - started) / 1000;
    if (deadlineSec && wallSec > deadlineSec) {
      return { exitCode: null, output: logs ?? '', timedOut: true, silent: false, wallSec };
    }
    if (silenceSec && (nowMs() - lastGrowth) / 1000 > silenceSec) {
      return { exitCode: null, output: logs ?? '', timedOut: false, silent: true, wallSec };
    }
    await sleep(POLL_MS);
  }
}

// Best-effort teardown. Deletion is the primary quota defense (stopped sandboxes still
// consume disk); ephemeral + ttlMinutes are the backstops if this throws.
export async function teardown(daytona, sandbox, { quiet } = {}) {
  if (!sandbox) return;
  try {
    await daytona.delete(sandbox);
    if (!quiet) process.stderr.write('  sandbox deleted\n');
  } catch (err) {
    process.stderr.write(`  WARN: delete failed (${err?.message || err}); ephemeral+TTL will reap it\n`);
  }
}

export { fmtDur };
