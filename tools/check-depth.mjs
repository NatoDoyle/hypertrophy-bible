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
import { extractPage, pageDepth, depthReport, classifyRenderedLinks, DEPTH_GATE, DEPTH_EXEMPT, GATE } from "./graph-core.mjs";

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
const warn = (label, rows, fmt) => {
  if (!rows.length) return void console.log(`  ✓ ${label}: none`);
  console.log(`  ⚠ ${label} (${rows.length}):`);
  for (const r of rows) console.log(`      ${fmt(r)}`);
};

const report = depthReport(depths, outDegree);

console.log(`\ndepth floors (WARN${DEPTH_GATE.warnOnly ? "" : " — ENFORCED"}): minWords=${DEPTH_GATE.minWords}, minNumericDensity=${DEPTH_GATE.minNumericDensity}/100w`);
warn("below the word floor", report.belowWords, (d) => `${d.pillar}/${d.slug} — ${d.words}w`);
warn("below the numeric-density floor (answers in adjectives, not numbers)", report.belowDensity,
  (d) => `${d.pillar}/${d.slug} — ${d.numbers} numbers in ${d.words}w (${d.numericDensity}/100w)`);
warn(`BOTH TELLS — thin/number-free AND out-degree <= ${GATE.minOut} (the shortlist worth reading)`, report.shortlist,
  (d) => `${d.pillar}/${d.slug} — ${d.words}w, ${d.numericDensity}/100w, out=${outDegree.get(d.slug)}, ${d.tableRows} table rows`);

// Links the reader can SEE but not follow — the class check-links is structurally
// blind to (its canonical check is .md-only, so a data/*.json link is verified to
// exist and never checked for reachability). Reported with counts, never forbidden:
// most degrade fine because the label carries the meaning. Baseline when this shipped
// (2026-08-04): 69 dropped links across 13 pages, led by back.md at 22 — the roadmap's
// own exemplar page, which is exactly why this is not a failure condition.
//
// CORRECTED (Wave 186): that 69 was itself under-reported. The check duplicated only
// half the renderer's predicate — the `.md` shape, not `BUNDLED.has(slug)` — so the 23
// cross-pillar `index.md` links, which render as plain text, were counted as live
// jumps by the report built to find exactly that. The true figure is 92 across 22
// pages. A gate that narrows its own input is a blind spot (lesson 35), and this one
// narrowed it in the direction that flattered the result.
//
// Deliberately NO per-page "this one is suspicious" annotation. The obvious candidate
// (dropped > live) fires on back.md, supplements and core — all three legitimate, since
// their labels are exercise and supplement NAMES that still read as prose once the link
// is gone. A flag that is usually wrong trains everyone to skip the line it sits on.
// What actually distinguished program-templates was that its dropped links were in
// table cells whose other columns were pure metadata, so the prescription lived nowhere
// else on the page — a judgement made by reading, which is what the counts are for.
// Exercise refs became traversable in Wave 221 (a muscle guide's ranked picks now
// open the app's exercise sheet), which REMOVES them from the dropped count. That
// is exactly the movement a report must not make silently: "fixed" and "filtered
// out of the metric" look identical in a shrinking total. So the classes are
// itemised, the newly-traversable links are counted on their own line, and the two
// are reconciled against the pre-change baseline below.
const EX_IDS = new Set(readdirSync(join(root, "data", "exercises")).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")));
const classified = pages.map((pg) => ({ slug: pg.slug, pillar: pg.pillar, out: outDegree.get(pg.slug) ?? 0, ...classifyRenderedLinks(pg.md, known, EX_IDS) }));
const dropped = classified
  .map((x) => ({ ...x, n: x.dropped.length }))
  .filter((x) => x.n > 0)
  .sort((a, b) => b.n - a.n);
const droppedTotal = dropped.reduce((a, x) => a + x.n, 0);
const exJumps = classified.map((x) => x.jumps.filter((j) => j.kind === "exercise").length);
const exJumpTotal = exJumps.reduce((a, n) => a + n, 0);
const exJumpPages = exJumps.filter((n) => n > 0).length;
const byClass = new Map();
for (const pg of classified) for (const d of pg.dropped) byClass.set(d.cls, (byClass.get(d.cls) ?? 0) + 1);
console.log(`\ninvisible links (rendered, but not traversable in-app): ${droppedTotal} across ${dropped.length} page(s)`);
const SHOWN = 8;
for (const x of dropped.slice(0, SHOWN)) {
  console.log(`      ${(x.pillar + "/" + x.slug).padEnd(46)} ${String(x.n).padStart(3)} dropped, ${x.out} live`);
}
// Say what was withheld. Truncating the list is itself a narrowing of the report's
// own input (lesson 35), and it stopped being harmless the moment the fixed predicate
// grew this list from 13 pages to 22 — more than half of it below the fold.
if (dropped.length > SHOWN) {
  const rest = dropped.slice(SHOWN);
  console.log(`      …and ${rest.length} more page(s) carrying ${rest.reduce((a, x) => a + x.n, 0)} dropped link(s).`);
}
// The class breakdown is never truncated: it is small, and it is the line that
// says WHY each remaining link is unreachable — which is what turns a number into
// something a future wave can act on.
console.log(`  by class — stated as counts so a narrowing can never hide inside a total:`);
for (const [cls, n] of [...byClass].sort((a, b) => b[1] - a[1])) {
  const why = cls === "pillar index TOC" ? "the app ships no index page; a pillar's ## Contents becomes the Learn list"
    : cls === "data/exercises" ? "a DIRECTORY link carries no id, so there is nothing to open"
    : "no in-app surface renders this data type yet";
  console.log(`      ${cls.padEnd(22)} ${String(n).padStart(3)}   ${why}`);
}
console.log(`  now traversable — counted here because the renderer OPENS them, not because the gate stopped looking:`);
console.log(`      ${"data/exercises".padEnd(22)} ${String(exJumpTotal).padStart(3)}   across ${exJumpPages} page(s) → the in-app exercise sheet`);
// The baseline is a LITERAL, measured once and written down. It used to be
// `droppedTotal + exJumpTotal` — derived from the same run it was checking — so the
// reconciliation balanced by construction and would have kept printing "clean" even
// if the classifier stopped matching everything (lesson 42: a check written in terms
// of the thing it checks cannot falsify it). Pinned, it moves when the corpus moves,
// which is the only way the line carries information.
const RENDERED_NONPAGE_BASELINE = 122;   // measured 2026-08-18, before Wave 221
const total = droppedTotal + exJumpTotal;
console.log(`  reconciliation: ${droppedTotal} dropped + ${exJumpTotal} traversable = ${total} rendered non-page links`);
console.log(`      (baseline 2026-08-18: ${RENDERED_NONPAGE_BASELINE} dropped, 0 traversable${
  total === RENDERED_NONPAGE_BASELINE
    ? " — conserved, so the delta is renderer coverage, not a filtered input.)"
    : `; the corpus has since moved by ${total - RENDERED_NONPAGE_BASELINE}. Authoring changes this legitimately — confirm that is why.)`}`);

// Exemptions (Wave 196): every flagged-but-exempt page prints WITH its justification —
// enforcement skips them, the report never does (a silently-filtered input is a blind
// spot, lesson 35). A stale exemption (its page no longer flagged) is itself reported:
// the wave that clears a page must clear its entry, or the escape hatch quietly widens.
const exempted = [...report.flaggedPages].filter((s) => DEPTH_EXEMPT.has(s)).sort();
if (exempted.length) {
  console.log(`\nexempt from the floors, with recorded justifications (${exempted.length}):`);
  for (const s of exempted) console.log(`      ${s} — ${DEPTH_EXEMPT.get(s)}`);
}
if (report.staleExemptions.length) {
  console.log(`\n  ⚠ STALE exemption(s) — page cleared or renamed; remove the entry (${report.staleExemptions.length}): ${report.staleExemptions.join(", ")}`);
}

// PAGES, not flags. The shortlist is derived from the two floors above it, so summing
// the three lists counts a page failing everything three times — this reported "23
// warnings" for 17 distinct pages until Wave 178, and that inflated number would have
// gone into the failure message the moment the gate starts enforcing.
//
// ENFORCED (Wave 196, DEPTH_GATE.warnOnly=false): a NON-EXEMPT page below a floor now
// fails the build. Shipped only once every flagged page was either authored (Waves
// 176/181-183/188/190/195) or carried a recorded exemption — the flip criterion the
// roadmap re-specified on 2026-08-04. Stale exemptions also fail: an entry must not
// outlive the flag that justified it.
const enforced = !DEPTH_GATE.warnOnly && (report.enforceable.length > 0 || report.staleExemptions.length > 0);
console.log(`\n${report.flaggedPages.size} page(s) below a depth floor (${report.flagCount} flags across 3 lists); ${exempted.length} exempt, ${report.enforceable.length} enforceable${DEPTH_GATE.warnOnly ? " — advisory, not blocking (DEPTH_GATE.warnOnly)" : report.enforceable.length || report.staleExemptions.length ? " — FAILING" : " — gate ENFORCED and green"}.`);
if (enforced && report.enforceable.length) console.log(`  fix or justify: ${report.enforceable.join(", ")}`);
process.exit(enforced ? 1 : 0);
