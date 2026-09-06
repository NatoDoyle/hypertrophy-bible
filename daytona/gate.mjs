// Clean-room verification gate: runs the repo's full gates in a fresh Daytona sandbox.
//
//   npm run gate            # ship committed HEAD
//   npm run gate -- --dirty # ship the working tree (uncommitted edits included)
//   npm run gate -- --smoke # also run the experimental workerd smoke stage
//
// Exit: 0 = all green · 1 = a stage failed (the code) · 2 = inconclusive (infra) · 3 = usage.
// A red gate (1) always means the code. See docs/improvement-loop.md "Token discipline" rule 8.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient, createSandbox, teardown } from './lib/sandbox.mjs';
import { prepareRepo, describeTree } from './lib/bundle.mjs';
import { runFullGate } from './lib/stages.mjs';
import { printReport, writeReport, verdictFromStages } from './lib/report.mjs';
import { parseArgs, makeRunId, EXIT, InfraError } from './lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run gate [-- --dirty] [--smoke]\n  --dirty  ship the working tree (default: committed HEAD)\n  --smoke  also run the experimental workerd smoke stage');
    process.exitCode = EXIT.OK; return;
  }

  const dirty = !!args.dirty;
  const smoke = !!args.smoke;
  const runId = makeRunId('gate');
  const runDir = resolve(HERE, 'runs', runId);

  const tree = describeTree(REPO_ROOT, { dirty });
  console.log(`Daytona clean-room gate  (${runId})`);
  console.log(`  shipping: ${dirty ? 'WORKING TREE' : 'HEAD'} @ ${tree.head}${dirty ? `  (${tree.dirtyFiles} dirty file(s))` : ''}`);
  console.log(`  smoke: ${smoke ? 'on' : 'off'}`);

  const onLine = (l) => process.stderr.write(`  · ${l}\n`);
  const daytona = getClient();
  let sandbox;
  try {
    console.log('  creating sandbox…');
    sandbox = await createSandbox(daytona, { purpose: 'gate', runId, autoStopInterval: 30, ttlMinutes: 40 });
    const { dir } = await prepareRepo(sandbox, { repoRoot: REPO_ROOT, dirty, log: onLine });

    const stages = await runFullGate(sandbox, dir, { smoke, onLine });

    const v = verdictFromStages(stages);
    const report = { runId, kind: 'gate', shipped: tree, smoke, stages, verdict: v, at: new Date().toISOString() };
    const path = writeReport(runDir, report);
    printReport(stages, { title: `Gate ${runId}` });
    console.log(`\n  report: ${path}`);
    process.exitCode = v.code;
  } finally {
    await teardown(daytona, sandbox);
  }
}

main().catch((err) => {
  if (err instanceof InfraError) {
    console.error(`\nINCONCLUSIVE (infra): ${err.message}`);
    if (err.hint) console.error(`  → ${err.hint}`);
    process.exitCode = EXIT.INFRA;
  } else {
    console.error('\nUnexpected error:', err?.stack || err);
    process.exitCode = EXIT.INFRA; // an orchestrator crash is not a code verdict
  }
});
