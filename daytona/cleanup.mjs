// Sweep-delete every sandbox this tooling created (labelled hb=1). A safety net for runs that
// crashed before their `finally` teardown — stopped sandboxes still consume disk quota, so
// leftovers can block new creates on Tier 1.
//
//   npm run cleanup

import { getClient } from './lib/sandbox.mjs';
import { EXIT, InfraError } from './lib/util.mjs';

async function main() {
  const daytona = getClient();
  console.log('Sweeping sandboxes labelled hb=1…');
  let found = 0, deleted = 0;
  for await (const sandbox of daytona.list({ labels: { hb: '1' } })) {
    found++;
    const id = sandbox.id || '(id pending)';
    try {
      await daytona.delete(sandbox);
      deleted++;
      console.log(`  deleted ${id}`);
    } catch (err) {
      console.log(`  WARN could not delete ${id}: ${err?.message || err}`);
    }
  }
  console.log(found === 0 ? '  nothing to clean' : `  ${deleted}/${found} deleted`);
  process.exitCode = EXIT.OK;
}

main().catch((err) => {
  if (err instanceof InfraError) {
    console.error(`INCONCLUSIVE (infra): ${err.message}`);
    if (err.hint) console.error(`  → ${err.hint}`);
  } else {
    console.error('Unexpected error:', err?.stack || err);
  }
  process.exitCode = EXIT.INFRA;
});
