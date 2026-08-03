#!/usr/bin/env node
// The DEPTH report — Goal 1's other half, and the number that was never computed.
//
// `check-links` proves the KB is a connected graph. `check-claim-coverage` proves a
// graded claim carries a citation. Both were green for waves while pages answered the
// reader's real questions — "how much, how long, how do I know it's working" — in
// ADJECTIVES: "modest", "excessive", "sequence thoughtfully", "creeping up". A green
// gate proves only what it measures (lesson 25), and nothing measured whether a page
// actually says a number.
//
// So this reports, per page: rendered word count, numeric density (numbers per 100
// words of prose, with citation keys and link targets stripped so a bibliography can't
// masquerade as substance), table rows, and out-degree.
//
// WARN-ONLY (DEPTH_GATE.warnOnly). Lesson 25's corollary: ship a new gate in warn mode
// in the wave that adds it, and flip it to fail only in the wave whose authoring makes
// it pass, so the bar never lands red on arrival. Flipping means setting
// `warnOnly: false` in graph-core's DEPTH_GATE — and updating the test that asserts the
// pre-flip state, never relaxing the floors to make a thin page pass.
//
// A flag here is a CANDIDATE, not a defect (lesson 13). Some pages are legitimately
// number-free: gym etiquette and what-to-wear are logistics, and a myth rebuttal built
// on null findings has nothing to quantify. Read the page before "fixing" the metric.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPage, pageDepth, isUnderDeveloped, DEPTH_GATE, GATE } from "./graph-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(root, "content");

const pages = [];
for (const pillar of readdirSync(CONTENT)) {
  const dir = join(CONTENT, pillar);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name === "index.md") continue;   // index pages are TOCs, not prose
    pages.push({ slug: basename(name, ".md"), pillar, md: readFileSync(join(dir, name), "utf8") });
  }
}

const known = new Set(pages.map((p) => p.slug));
const outDegree = new Map(pages.map((p) => [p.slug, Object.keys(extractPage(p, known).outbound).length]));
const depths = pages.map(pageDepth).sort((a, b) => (a.pillar + a.slug < b.pillar + b.slug ? -1 : 1));

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * p)] ?? 0; };
const words = depths.map((d) => d.words);
const dens = depths.map((d) => d.numericDensity);

console.log(`depth: ${depths.length} content pages (index TOCs excluded).`);
console.log(`  words           p10=${pct(words, 0.1)}  p25=${pct(words, 0.25)}  median=${pct(words, 0.5)}  p75=${pct(words, 0.75)}`);
console.log(`  numbers/100w    p10=${pct(dens, 0.1)}  p25=${pct(dens, 0.25)}  median=${pct(dens, 0.5)}  p75=${pct(dens, 0.75)}`);

// Per-pillar, so a whole pillar drifting thin is visible before any single page is.
const byPillar = new Map();
for (const d of depths) {
  const agg = byPillar.get(d.pillar) ?? { n: 0, words: 0, numbers: 0, tables: 0 };
  agg.n++; agg.words += d.words; agg.numbers += d.numbers; agg.tables += d.tableRows;
  byPillar.set(d.pillar, agg);
}
console.log("  per pillar (avg words · numbers/100w · table rows):");
for (const [pillar, a] of [...byPillar].sort()) {
  const density = a.words ? Math.round((a.numbers / a.words) * 10000) / 100 : 0;
  console.log(`    ${pillar.padEnd(24)} ${String(Math.round(a.words / a.n)).padStart(4)}w  ${String(density).padStart(5)}  ${String(a.tables).padStart(3)} rows`);
}

// Each floor reported on its OWN line as well as in the combined shortlist: the
// shortlist is an AND, so on its own it would hide a thin page that happens to be
// well-linked (see isUnderDeveloped's note).
let warnings = 0;
const warn = (label, rows, fmt) => {
  if (!rows.length) return void console.log(`  ✓ ${label}: none`);
  warnings += rows.length;
  console.log(`  ⚠ ${label} (${rows.length}):`);
  for (const r of rows) console.log(`      ${fmt(r)}`);
};

console.log(`\ndepth floors (WARN${DEPTH_GATE.warnOnly ? "" : " — ENFORCED"}): minWords=${DEPTH_GATE.minWords}, minNumericDensity=${DEPTH_GATE.minNumericDensity}/100w`);
warn("below the word floor", depths.filter((d) => d.words < DEPTH_GATE.minWords),
  (d) => `${d.pillar}/${d.slug} — ${d.words}w`);
warn("below the numeric-density floor (answers in adjectives, not numbers)",
  depths.filter((d) => d.numericDensity < DEPTH_GATE.minNumericDensity),
  (d) => `${d.pillar}/${d.slug} — ${d.numbers} numbers in ${d.words}w (${d.numericDensity}/100w)`);
warn(`BOTH TELLS — thin/number-free AND out-degree <= ${GATE.minOut} (the shortlist worth reading)`,
  depths.filter((d) => isUnderDeveloped(d, outDegree.get(d.slug))),
  (d) => `${d.pillar}/${d.slug} — ${d.words}w, ${d.numericDensity}/100w, out=${outDegree.get(d.slug)}, ${d.tableRows} table rows`);

const enforced = !DEPTH_GATE.warnOnly && warnings > 0;
console.log(`\n${warnings} depth warning(s)${DEPTH_GATE.warnOnly ? " — advisory, not blocking (DEPTH_GATE.warnOnly)" : ""}.`);
process.exit(enforced ? 1 : 0);
