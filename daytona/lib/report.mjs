// Console table + report.json for a run. No dependencies; degrades to plain text when
// stdout is not a TTY or NO_COLOR is set.

import { mkdirSync, writeFileSync } from 'node:fs';
import { EXIT, fmtDur } from './util.mjs';
import { STATUS } from './stages.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const paint = {
  [STATUS.PASS]: (s) => c('32', s),
  [STATUS.FAIL]: (s) => c('31', s),
  [STATUS.INFRA]: (s) => c('33', s),
  [STATUS.SKIP]: (s) => c('90', s),
};
const mark = { [STATUS.PASS]: 'PASS', [STATUS.FAIL]: 'FAIL', [STATUS.INFRA]: 'INFRA', [STATUS.SKIP]: 'skip' };

// First non-pass stage decides the verdict; fail-fast means there is at most one.
export function verdictFromStages(stages) {
  const bad = stages.find((s) => s.status === STATUS.FAIL || s.status === STATUS.INFRA);
  if (!bad) return { code: EXIT.OK, label: 'PASS', stage: null };
  return bad.status === STATUS.FAIL
    ? { code: EXIT.FAIL, label: 'FAIL', stage: bad.name }
    : { code: EXIT.INFRA, label: 'INCONCLUSIVE (infra)', stage: bad.name };
}

export function printReport(stages, { title } = {}) {
  const line = '─'.repeat(52);
  console.log('\n' + line);
  if (title) console.log(title);
  console.log(line);
  for (const s of stages) {
    const status = (paint[s.status] || ((x) => x))(mark[s.status].padEnd(5));
    const dur = s.wallSec != null ? fmtDur(s.wallSec).padStart(7) : '   —   ';
    const ec = s.exitCode != null ? ` exit ${s.exitCode}` : '';
    console.log(`  ${status}  ${s.name.padEnd(22)} ${dur}${ec}`);
    if (s.note) console.log(`         ${c('90', s.note)}`);
  }
  const v = verdictFromStages(stages);
  console.log(line);
  const vpaint = v.code === EXIT.OK ? paint[STATUS.PASS] : v.code === EXIT.FAIL ? paint[STATUS.FAIL] : paint[STATUS.INFRA];
  console.log('  Verdict: ' + vpaint(v.label) + (v.stage ? c('90', `  (at ${v.stage})`) : ''));
  console.log(line);

  // Show the failing/infra stage's log tail so the reason is visible without digging into report.json.
  const bad = stages.find((s) => s.status === STATUS.FAIL || s.status === STATUS.INFRA);
  if (bad && bad.tail) {
    console.log(`\nLast output from ${bad.name}:`);
    console.log(bad.tail.split('\n').map((l) => '  │ ' + l).join('\n'));
  }
  return v;
}

export function writeReport(runDir, obj) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(`${runDir}/report.json`, JSON.stringify(obj, null, 2));
  return `${runDir}/report.json`;
}
