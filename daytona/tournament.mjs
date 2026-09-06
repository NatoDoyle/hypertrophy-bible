// Variant tournament: N sandboxes each implement a different approach to the same task with
// headless Claude Code, then each is measured by the SAME pre-registered fitness metric. The
// winner is reported — never applied. You apply the winner's patch locally and verify it inline
// before committing (docs/improvement-loop.md "Token discipline" rule 8).
//
//   npm run tournament -- briefs/<name>.md [--yes] [--dirty] [--allow-4]
//
// Without --yes it prints the plan + cost estimate and exits (a dry preview). Requires
// DAYTONA_API_KEY and ANTHROPIC_API_KEY in the environment.

import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { getClient, createSandbox, teardown, runStep } from './lib/sandbox.mjs';
import { prepareRepo, describeTree } from './lib/bundle.mjs';
import { installDeps, runMeasureChain, STATUS } from './lib/stages.mjs';
import { parseBrief, variantPrompt } from './lib/brief.mjs';
import { writeReport } from './lib/report.mjs';
import { RESOURCES } from './lib/image.mjs';
import { parseArgs, makeRunId, fmtDur, EXIT, InfraError } from './lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// Last stdout line's first number is the metric.
function extractMetric(text) {
  const lines = (text || '').replace(/\s+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/-?\d+(?:\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return null;
}

function runLocalFitness(cmd) {
  try {
    const out = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, value: extractMetric(out), output: out };
  } catch (err) {
    return { ok: false, value: null, output: `${err?.stdout || ''}${err?.stderr || ''}` };
  }
}

// Rough compute estimate; Claude tokens dominate and are billed separately.
function computePlan(n, maxWallMin) {
  const perHr = RESOURCES.cpu * 0.0504 + RESOURCES.memory * 0.0162 + RESOURCES.disk * 0.000108;
  const compute = n * (maxWallMin / 60) * perHr;
  return { perHr, computeMax: compute };
}

async function runVariant(daytona, { brief, variant, runId, dirty, runDir, baseLabel }) {
  const tag = `[${variant.id}]`;
  const onLine = (l) => process.stderr.write(`  ${tag} ${l}\n`);
  const localDir = `${runDir}/${variant.id}`;
  mkdirSync(localDir, { recursive: true });
  const out = { variant: variant.id, title: variant.title, status: 'infra', gates: [], gatesPass: false, fitness: { value: null }, claude: {}, changedLines: null };

  let sandbox;
  try {
    onLine('creating sandbox…');
    sandbox = await createSandbox(daytona, {
      purpose: 'tournament', runId, variant: variant.id,
      autoStopInterval: 0, ttlMinutes: 90,
      envVars: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    });
    const { dir, baseSha } = await prepareRepo(sandbox, { repoRoot: REPO_ROOT, dirty, log: onLine });
    const parent = dir.replace(/\/repo$/, '');

    onLine('installing deps…');
    const ci = await installDeps(sandbox, dir, { onLine });
    out.gates.push(...ci);
    if (ci.some((s) => s.status !== STATUS.PASS)) {
      out.note = 'dependency install did not complete — cannot measure this variant';
      return out;
    }

    // Hand the brief to headless Claude via stdin (avoids argv length limits). The brief lives
    // beside the repo (../brief.md), so it never enters the variant's diff.
    const prompt = variantPrompt(brief, variant);
    await sandbox.fs.uploadFile(Buffer.from(prompt, 'utf8'), `${parent}/brief.md`);
    onLine(`running Claude (${brief.model}, ≤$${brief.maxBudgetUsd}, ≤${brief.maxWallMin}m)…`);
    // The shell `timeout` binary bounds the run so Claude self-terminates cleanly at the wall
    // clock — no racing a still-writing process before we commit. --output-format json buffers
    // the result to the end (no incremental output), so a silence watchdog would be useless;
    // the wall-clock cap + --max-budget-usd are the real guards. Relative paths avoid any
    // space-in-home issues. Exit 124 = the shell timeout fired.
    const claudeCmd =
      `timeout ${brief.maxWallMin}m bash -c "cat ../brief.md | claude -p --dangerously-skip-permissions ` +
      `--model ${brief.model} --max-budget-usd ${brief.maxBudgetUsd} --output-format json" > ../claude-result.json 2> ../claude.err`;
    // Give my poller a buffer past the shell timeout so `timeout` does the killing, not me.
    const cl = await runStep(sandbox, claudeCmd, { cwd: dir, deadlineSec: brief.maxWallMin * 60 + 180, label: `${variant.id}:claude`, onLine: () => {} });
    out.claude.exitCode = cl.exitCode;
    out.claude.wallTimeout = cl.exitCode === 124;
    out.claude.pollerAborted = cl.timedOut; // should be rare: even timeout+buffer didn't return
    if (out.claude.wallTimeout) onLine(`Claude hit the ${brief.maxWallMin}m wall-clock cap — measuring whatever it completed`);
    else if (cl.timedOut) onLine('Claude did not return even after the timeout buffer — measuring current tree');

    // Commit whatever the agent left, then capture its diff vs BASE.
    const idflags = `-c user.name='hb-daytona' -c user.email='hb-daytona@local'`;
    await runStep(sandbox, `git ${idflags} add -A && git ${idflags} commit -q --allow-empty -m VARIANT`, { cwd: dir, deadlineSec: 90, label: `${variant.id}:commit` });
    const stat = await runStep(sandbox, `git diff '${baseSha}' HEAD > '${parent}/patch.diff'; git diff --shortstat '${baseSha}' HEAD`, { cwd: dir, deadlineSec: 90, label: `${variant.id}:diff` });
    const ins = /(\d+) insertion/.exec(stat.output); const del = /(\d+) deletion/.exec(stat.output);
    out.changedLines = (ins ? +ins[1] : 0) + (del ? +del[1] : 0);

    onLine('measuring (tests + staleness)…');
    const measure = await runMeasureChain(sandbox, dir, { onLine });
    out.gates.push(...measure);
    out.gatesPass = out.gates.every((s) => s.status === STATUS.PASS);

    onLine('measuring fitness…');
    const fit = await runStep(sandbox, brief.fitness, { cwd: dir, deadlineSec: 300, label: `${variant.id}:fitness` });
    out.fitness = { value: extractMetric(fit.output), exitCode: fit.exitCode };

    // Bring the artifacts home.
    try {
      await sandbox.fs.downloadFile(`${parent}/patch.diff`, `${localDir}/patch.diff`);
      await sandbox.fs.downloadFile(`${parent}/claude-result.json`, `${localDir}/claude-result.json`);
    } catch (err) { onLine(`WARN artifact download: ${err?.message || err}`); }

    // Parse Claude's cost/usage from the result it wrote.
    let parsedResult = false;
    try {
      const j = JSON.parse(execSync(`cat '${localDir}/claude-result.json'`, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
      out.claude.costUsd = j.total_cost_usd ?? null;
      out.claude.tokensOut = j.usage?.output_tokens ?? null;
      out.claude.tokensIn = j.usage?.input_tokens ?? null;
      out.claude.turns = j.num_turns ?? null;
      out.claude.isError = j.is_error ?? null;
      parsedResult = true;
    } catch { /* result may be absent if Claude never started */ }

    // A hard Claude failure (auth/config): no parseable result, a non-success/non-timeout exit,
    // AND it left no edits at all. (A budget- or wall-capped run that DID edit is measured on its
    // partial work, not discarded.) This stops a "did nothing" tree reading as a valid green variant.
    if (!parsedResult && cl.exitCode !== 0 && cl.exitCode !== 124 && out.changedLines === 0) {
      const err = await runStep(sandbox, `tail -5 '${parent}/claude.err' 2>/dev/null`, { cwd: dir, deadlineSec: 30, label: `${variant.id}:err` });
      out.status = 'infra';
      out.note = `Claude did not run (exit ${cl.exitCode}, no edits) — likely auth/config. ${(err.output || '').trim().slice(-200)}`;
      onLine(out.note);
      return out;
    }

    out.status = out.gatesPass ? 'measured' : 'gates-failed';
    out.patchPath = `${localDir}/patch.diff`;
    onLine(`done — gates ${out.gatesPass ? 'GREEN' : 'RED'}, fitness ${out.fitness.value}`);
    return out;
  } catch (err) {
    out.note = err instanceof InfraError ? `infra: ${err.message}` : `error: ${err?.message || err}`;
    onLine(out.note);
    return out;
  } finally {
    await teardown(daytona, sandbox, { quiet: true });
  }
}

function pickWinner(results, direction) {
  const eligible = results.filter((r) => r.gatesPass && r.fitness.value != null);
  if (!eligible.length) return null;
  const better = (a, b) => (direction === 'min' ? a < b : a > b);
  return eligible.reduce((best, r) => {
    if (better(r.fitness.value, best.fitness.value)) return r;
    if (r.fitness.value === best.fitness.value && (r.changedLines ?? Infinity) < (best.changedLines ?? Infinity)) return r;
    return best;
  });
}

function printTable(results, baseline, direction, winner) {
  const line = '─'.repeat(72);
  console.log('\n' + line);
  console.log(`  variant            gates    fitness (base ${baseline})   Δ       tokens_out  wall`);
  console.log(line);
  for (const r of results) {
    const g = r.gatesPass ? 'GREEN' : (r.status === 'infra' ? 'infra' : 'RED  ');
    const f = r.fitness.value == null ? '—' : String(r.fitness.value);
    const d = r.fitness.value == null ? '—' : (r.fitness.value - baseline > 0 ? '+' : '') + (r.fitness.value - baseline).toFixed(2);
    const tok = r.claude.tokensOut != null ? String(r.claude.tokensOut) : '—';
    const win = winner && winner.variant === r.variant ? '  ◄ winner' : '';
    console.log(`  ${(r.variant + ' ' + r.title).slice(0, 18).padEnd(18)} ${g.padEnd(7)} ${f.padStart(10)}       ${d.padStart(7)}   ${tok.padStart(10)}  ${win}`);
  }
  console.log(line);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const briefArg = args._[0];
  if (!briefArg || args.help) {
    console.log('Usage: npm run tournament -- briefs/<name>.md [--yes] [--dirty] [--allow-4]');
    process.exitCode = briefArg ? EXIT.OK : EXIT.USAGE; return;
  }

  const briefPath = resolve(process.cwd(), briefArg);
  let brief;
  try { brief = parseBrief(briefPath); }
  catch (err) { console.error(`Brief error: ${err.message}`); process.exitCode = EXIT.USAGE; return; }

  const n = brief.variants.length;
  if (n > 4) { console.error(`Too many variants (${n}). Max 4, and 4 needs --allow-4 (Tier-1 quota).`); process.exitCode = EXIT.USAGE; return; }
  if (n === 4 && !args['allow-4']) { console.error('4 variants needs --allow-4 (4×2 vCPU = 8 of Tier-1\'s 10).'); process.exitCode = EXIT.USAGE; return; }

  // Pre-registration: the metric must exist and be numeric at HEAD BEFORE the race (lessons 25/30).
  console.log(`Pre-registering fitness at HEAD:  ${brief.fitness}`);
  const base = runLocalFitness(brief.fitness);
  if (!base.ok || base.value == null) {
    console.error('  ✗ refusing to race: the fitness command must succeed and print a number on its last stdout line at HEAD.');
    console.error('    ' + (base.output || '').trim().split('\n').slice(-3).join('\n    '));
    process.exitCode = EXIT.USAGE; return;
  }
  console.log(`  ✓ baseline = ${base.value}  (direction: ${brief.direction})`);

  const tree = describeTree(REPO_ROOT, { dirty: !!args.dirty });
  const plan = computePlan(n, brief.maxWallMin);
  console.log(`\nTournament plan:`);
  console.log(`  ${n} variants: ${brief.variants.map((v) => v.id).join(', ')}`);
  console.log(`  shipping ${args.dirty ? 'WORKING TREE' : 'HEAD'} @ ${tree.head}`);
  console.log(`  compute ≤ $${plan.computeMax.toFixed(2)} (${n}×${RESOURCES.cpu}vCPU, ≤${brief.maxWallMin}m each)`);
  console.log(`  Claude API ≤ $${(n * brief.maxBudgetUsd).toFixed(2)} (${n}×$${brief.maxBudgetUsd} budget cap) — the dominant cost, billed separately.`);

  if (!args.yes) {
    console.log('\n  Dry preview — re-run with --yes to launch. This counts as the iteration\'s one workflow.');
    process.exitCode = EXIT.OK; return;
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new InfraError('ANTHROPIC_API_KEY is required for a tournament (headless Claude).', 'export ANTHROPIC_API_KEY=…');

  const runId = makeRunId('tourn');
  const runDir = resolve(HERE, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  console.log(`\nLaunching ${runId}…`);
  const daytona = getClient();
  const t0 = Date.now();

  const results = await Promise.all(
    brief.variants.map((variant) => runVariant(daytona, { brief, variant, runId, dirty: !!args.dirty, runDir })),
  );

  const winner = pickWinner(results, brief.direction);
  printTable(results, base.value, brief.direction, winner);
  console.log(`  elapsed ${fmtDur((Date.now() - t0) / 1000)}`);

  const report = {
    runId, kind: 'tournament', brief: briefArg, fitness: brief.fitness, direction: brief.direction,
    baseline: base.value, shipped: tree, results, winner: winner ? winner.variant : null, at: new Date().toISOString(),
  };
  writeReport(runDir, report);

  if (winner) {
    console.log(`\n  Winner: ${winner.variant} — ${winner.title}  (fitness ${winner.fitness.value} vs base ${base.value})`);
    console.log('  NOT applied. To adopt, verify inline locally first:');
    console.log(`    git checkout -b daytona-${winner.variant} && git apply ${winner.patchPath}`);
    console.log('    …then run BOTH chains + tamper the winner\'s new tests (lesson 54) before committing.');
  } else {
    console.log('\n  No variant passed the gates with a numeric fitness — nothing to adopt. See report.json.');
  }
  process.exitCode = EXIT.OK; // the tournament itself succeeded even if no variant won
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
