// Build (register) the named snapshot the gate and tournament create sandboxes from.
// Run once up front, and again when the image definition changes (new Claude Code, a dep major
// bump) or after a snapshot deactivates (Daytona deactivates snapshots after 2 weeks unused).
//
//   npm run snapshot:build
//
// To change the image, edit lib/image.mjs and bump SNAPSHOT_NAME (hb-node24-v1 → v2), so old
// sandboxes/snapshots don't collide with the new definition.

import { getClient } from './lib/sandbox.mjs';
import { SNAPSHOT_NAME, RESOURCES, hbImage } from './lib/image.mjs';
import { EXIT, InfraError, fmtDur } from './lib/util.mjs';

async function main() {
  const daytona = getClient();
  console.log(`Building snapshot '${SNAPSHOT_NAME}'  (${RESOURCES.cpu} vCPU / ${RESOURCES.memory} GiB / ${RESOURCES.disk} GiB)`);
  console.log('  this installs Claude Code and warms the npm cache — a few minutes the first time.\n');
  const t0 = Date.now();
  try {
    await daytona.snapshot.create(
      { name: SNAPSHOT_NAME, image: hbImage(), resources: RESOURCES },
      { onLogs: (l) => process.stdout.write(`  ${l}\n`) },
    );
    console.log(`\n  snapshot '${SNAPSHOT_NAME}' ready in ${fmtDur((Date.now() - t0) / 1000)}`);
    process.exitCode = EXIT.OK;
  } catch (err) {
    const msg = String(err?.message || err);
    if (/exist/i.test(msg)) {
      console.error(`\n  A snapshot named '${SNAPSHOT_NAME}' already exists.`);
      console.error('  → Delete it in the Daytona dashboard, or bump SNAPSHOT_NAME in lib/image.mjs, then re-run.');
      process.exitCode = EXIT.INFRA;
      return;
    }
    throw new InfraError(`snapshot build failed: ${msg}`, 'Check DAYTONA_API_KEY, org quota, and network.');
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
