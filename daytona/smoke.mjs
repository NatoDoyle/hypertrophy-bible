// Tooling self-test: create a sandbox from the snapshot, confirm the toolchain is present
// (Node 24, git, Claude Code), then delete it. Proves auth + snapshot + image contents before
// the gate or a tournament depends on them. Costs a few cents.
//
//   npm run smoke

import { getClient, createSandbox, teardown, runStep } from './lib/sandbox.mjs';
import { makeRunId, EXIT, InfraError, fmtDur } from './lib/util.mjs';

async function check(sandbox, label, command) {
  const r = await runStep(sandbox, command, { deadlineSec: 60, label });
  const first = (r.output || '').trim().split('\n')[0] || '(no output)';
  const ok = r.exitCode === 0;
  console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label.padEnd(14)} ${first}`);
  return ok;
}

async function main() {
  const runId = makeRunId('smoke');
  console.log(`Daytona tooling smoke  (${runId})`);
  const daytona = getClient();
  let sandbox;
  const t0 = Date.now();
  try {
    console.log('  creating sandbox…');
    sandbox = await createSandbox(daytona, { purpose: 'smoke', runId, autoStopInterval: 15, ttlMinutes: 15 });
    console.log(`  up in ${fmtDur((Date.now() - t0) / 1000)}`);

    const results = [];
    results.push(await check(sandbox, 'node', 'node --version'));
    results.push(await check(sandbox, 'git', 'git --version'));
    results.push(await check(sandbox, 'claude-code', 'claude --version || claude-code --version'));
    results.push(await check(sandbox, 'sqlite', "node -e \"require('node:sqlite'); console.log('node:sqlite present')\""));

    const allOk = results.every(Boolean);
    console.log(allOk ? '\n  smoke PASSED — snapshot is healthy' : '\n  smoke INCOMPLETE — see MISS rows above');
    process.exitCode = allOk ? EXIT.OK : EXIT.FAIL;
  } finally {
    await teardown(daytona, sandbox);
  }
}

main().catch((err) => {
  if (err instanceof InfraError) {
    console.error(`\nINCONCLUSIVE (infra): ${err.message}`);
    if (err.hint) console.error(`  → ${err.hint}`);
  } else {
    console.error('\nUnexpected error:', err?.stack || err);
  }
  process.exitCode = EXIT.INFRA;
});
