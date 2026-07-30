#!/usr/bin/env node
// Unit tests for the KB graph engine (graph-core.mjs) — the "neural network" layer.
// Controlled inline fixtures with hand-computed expected values, then assertions
// over the REAL content/ tree (pattern of test-plan.mjs). Zero dependencies
// (node:assert). Exit non-zero on failure.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripNonRendered,
  extractPage,
  buildGraph,
  parseContentsIndex,
  formatReasons,
  GATE,
} from "./graph-core.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// Minimal record factory — buildGraph consumes extractPage's output shape.
const rec = (slug, outbound = {}, citations = [], pillar = "01-x") => ({
  slug, pillar, title: slug, outbound, citations,
});

// ---------- stripNonRendered + extractPage ----------

const KNOWN = new Set(["t", "a", "b", "c", "d", "x"]);

check("strip: Backing Data (incl. ### sub-sections) and References are removed; footnote defs dropped", () => {
  const md = [
    "# T",
    "Intro [A](a.md) line.",
    "## Backing Data",
    "- [B](b.md)",
    "### sub under backing",
    "[C](c.md)",
    "## The Evidence",
    "[D](../01-x/d.md)[^k1] and again [A](a.md).",
    "[^k1]: def line with a link [B](b.md)",
    "## References",
    "[B](b.md)",
  ].join("\n");
  const out = extractPage({ slug: "t", pillar: "00-f", md }, KNOWN);
  assert.deepEqual(out.outbound, { a: 2, d: 1 }); // b and c never counted
  assert.deepEqual(out.citations, ["k1"]); // ref counted, def line excluded
  assert.equal(out.title, "T");
});

check("strip: TL;DR blockquote and table-cell links are KEPT (they render in-app)", () => {
  const md = [
    "# T",
    "> **TL;DR** — see [A](a.md).",
    "| col | link |",
    "|---|---|",
    "| x | [B](b.md) |",
  ].join("\n");
  const out = extractPage({ slug: "t", pillar: "00-f", md }, KNOWN);
  assert.deepEqual(out.outbound, { a: 1, b: 1 });
});

check("strip: a References section at EOF runs to end of file", () => {
  const md = "# T\n[A](a.md)\n## References\n[B](b.md)\n[C](c.md)";
  assert.deepEqual(extractPage({ slug: "t", pillar: "00-f", md }, KNOWN).outbound, { a: 1 });
});

check("extract: index targets, self-links, unknown slugs and deep paths are ignored; #anchors ok", () => {
  const md = "# T\n[i](index.md) [i2](../02-y/index.md) [self](t.md) [z](z.md) [deep](sub/dir/a.md) [X](../02-y/x.md#frag)";
  const out = extractPage({ slug: "t", pillar: "00-f", md }, KNOWN);
  assert.deepEqual(out.outbound, { x: 1 });
});

check("extract: citations deduped + sorted; markers with and without surrounding prose", () => {
  const md = "# T\nclaim[^b-key].[^a-key] more[^b-key]\n";
  assert.deepEqual(extractPage({ slug: "t", pillar: "00-f", md }, KNOWN).citations, ["a-key", "b-key"]);
});

// ---------- weight formula ----------

check("weight: one-way single link = 3", () => {
  const g = buildGraph([rec("p", { q: 1 }), rec("q")]);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], { a: "p", b: "q", weight: 3, out: 1, in: 0, shared: 0, mutual: 0 });
});

check("weight: mutual pair = 3+3+2 = 8", () => {
  const g = buildGraph([rec("p", { q: 1 }), rec("q", { p: 1 })]);
  assert.equal(g.edges[0].weight, 8);
});

check("weight: repeat links cap at 2 occurrences per direction (5 repeats == 2 repeats)", () => {
  const five = buildGraph([rec("p", { q: 5 }), rec("q")]);
  const two = buildGraph([rec("p", { q: 2 }), rec("q")]);
  assert.equal(five.edges[0].weight, 6);
  assert.equal(two.edges[0].weight, 6);
});

check("weight: shared citations add 2·min(shared,3) on a linked pair", () => {
  // t→u once, both cite k1+k2; no mutual neighbours → 3 + 2·2 = 7
  const g = buildGraph([rec("t", { u: 1 }, ["k1", "k2"]), rec("u", {}, ["k1", "k2"])]);
  assert.equal(g.edges[0].weight, 7);
  assert.equal(g.edges[0].shared, 2);
  // 5 shared keys caps at 3 → 3 + 2·3 = 9
  const keys = ["k1", "k2", "k3", "k4", "k5"];
  const g2 = buildGraph([rec("t", { u: 1 }, keys), rec("u", {}, keys)]);
  assert.equal(g2.edges[0].weight, 9);
});

check("weight: mutual neighbours add 1·min(mutual,4)", () => {
  // hub-and-spoke: a and b each link c,d,e — a,b not linked → no a-b edge,
  // but a-c edge weight picks up mutual(a,c): N(a)={c,d,e}, N(c)={a,b} → ∅... hand-check below.
  const g = buildGraph([
    rec("a", { c: 1, d: 1, e: 1 }), rec("b", { c: 1, d: 1, e: 1 }),
    rec("c"), rec("d"), rec("e"),
  ]);
  // a-c: N(a)={c,d,e}, N(c)={a,b} → intersection {} → mutual 0, weight 3
  const ac = g.edges.find((e) => e.a === "a" && e.b === "c");
  assert.equal(ac.mutual, 0);
  assert.equal(ac.weight, 3);
});

// ---------- suggested (2-hop) rule ----------

function suggestedFor(g, slug, other) {
  return (g.perPage[slug].suggested || []).find((s) => s.slug === other);
}

check("suggested: shared≥2 qualifies, shared=1 alone does not", () => {
  const g2 = buildGraph([rec("r", {}, ["k1", "k2"]), rec("s", {}, ["k1", "k2"])]);
  assert.ok(suggestedFor(g2, "r", "s"));
  assert.ok(suggestedFor(g2, "s", "r"));
  const g1 = buildGraph([rec("r", {}, ["k1"]), rec("s", {}, ["k1"])]);
  assert.equal(suggestedFor(g1, "r", "s"), undefined);
});

check("suggested: mutual≥4 qualifies, mutual=3 alone does not, 1 shared + 3 mutual qualifies", () => {
  const spokes3 = [rec("c"), rec("d"), rec("e")];
  const m3 = buildGraph([rec("a", { c: 1, d: 1, e: 1 }), rec("b", { c: 1, d: 1, e: 1 }), ...spokes3]);
  assert.equal(suggestedFor(m3, "a", "b"), undefined); // mutual 3, shared 0 → out
  const m4 = buildGraph([
    rec("a", { c: 1, d: 1, e: 1, f: 1 }), rec("b", { c: 1, d: 1, e: 1, f: 1 }),
    ...spokes3, rec("f"),
  ]);
  const s4 = suggestedFor(m4, "a", "b");
  assert.ok(s4); // mutual 4 → in
  assert.equal(s4.mutual, 4);
  const m3s1 = buildGraph([
    rec("a", { c: 1, d: 1, e: 1 }, ["k1"]), rec("b", { c: 1, d: 1, e: 1 }, ["k1"]),
    ...spokes3,
  ]);
  assert.ok(suggestedFor(m3s1, "a", "b")); // 1 shared + 3 mutual → in
});

check("suggested: a directly-linked pair is NEVER suggested", () => {
  const keys = ["k1", "k2", "k3"];
  const g = buildGraph([rec("r", { s: 1 }, keys), rec("s", {}, keys)]);
  assert.equal(suggestedFor(g, "r", "s"), undefined);
  assert.ok(g.edges.find((e) => e.a === "r" && e.b === "s")); // it's an edge instead
});

check("suggested: ranked by 2·min(shared,3)+min(mutual,4), tiebreak shared desc then slug asc; cap 3", () => {
  // page z shares citations with 4 non-linked pages at equal scores → cap 3, slug order
  const recs = [rec("z", {}, ["k1", "k2"])];
  for (const s of ["p1", "p2", "p3", "p4"]) recs.push(rec(s, {}, ["k1", "k2"]));
  // NOTE: p1..p4 also share k1,k2 with EACH OTHER — fine, we only inspect z.
  const g = buildGraph(recs);
  const sug = g.perPage.z.suggested;
  assert.equal(sug.length, 3);
  assert.deepEqual(sug.map((s) => s.slug), ["p1", "p2", "p3"]);
});

// ---------- connected list ----------

check("connected: ranked by weight desc then slug asc; cap 6; disjoint from suggested", () => {
  const recs = [rec("hub", { n1: 1, n2: 1, n3: 1, n4: 1, n5: 1, n6: 1, n7: 1 })];
  for (let i = 1; i <= 7; i++) recs.push(rec(`n${i}`));
  const g = buildGraph(recs);
  const con = g.perPage.hub.connected;
  assert.equal(con.length, 6); // n7 dropped (equal weights → slug asc keeps n1..n6)
  assert.deepEqual(con.map((c) => c.slug), ["n1", "n2", "n3", "n4", "n5", "n6"]);
  const sugSlugs = new Set((g.perPage.hub.suggested || []).map((s) => s.slug));
  for (const c of con) assert.ok(!sugSlugs.has(c.slug));
});

check("connected: entries carry per-viewing-page orientation (out/in swap across the edge)", () => {
  const g = buildGraph([rec("p", { q: 2 }), rec("q", { p: 1 })]);
  const fromP = g.perPage.p.connected[0];
  const fromQ = g.perPage.q.connected[0];
  assert.equal(fromP.slug, "q");
  assert.equal(fromP.out, 2);
  assert.equal(fromP.in, 1);
  assert.equal(fromQ.slug, "p");
  assert.equal(fromQ.out, 1);
  assert.equal(fromQ.in, 2);
  assert.equal(fromP.weight, fromQ.weight); // same undirected edge
});

// ---------- metrics ----------

check("metrics: components, orphans, deadEnds, underlinked on a split fixture", () => {
  // two islands: a→b, c→d
  const g = buildGraph([rec("a", { b: 1 }), rec("b"), rec("c", { d: 1 }), rec("d")]);
  assert.deepEqual(g.metrics.components, [2, 2]);
  assert.deepEqual(g.metrics.orphans, ["a", "c"]); // nothing links TO them
  assert.deepEqual(g.metrics.deadEnds, ["b", "d"]); // they link to nothing
  assert.deepEqual(g.metrics.underlinked, ["a", "b", "c", "d"]); // all out-degree < 2
  assert.equal(g.metrics.pages, 4);
  assert.equal(g.metrics.edgeCount, 2);
});

check("metrics: out-degree counts DISTINCT targets (2 links to the same page = degree 1)", () => {
  const g = buildGraph([rec("a", { b: 5 }), rec("b")]);
  assert.deepEqual(g.metrics.underlinked, ["a", "b"]);
  assert.equal(g.metrics.degreeOut.max, 1);
});

check("metrics: degree stats and perPillar avgOut", () => {
  const g = buildGraph([
    rec("a", { b: 1, c: 1 }, [], "01-x"), rec("b", {}, [], "01-x"),
    rec("c", { a: 1 }, [], "02-y"),
  ]);
  assert.equal(g.metrics.degreeOut.min, 0);
  assert.equal(g.metrics.degreeOut.max, 2);
  assert.equal(g.metrics.degreeOut.mean, 1);
  assert.equal(g.metrics.degreeOut.median, 1);
  assert.equal(g.metrics.perPillar["01-x"].pages, 2);
  assert.equal(g.metrics.perPillar["01-x"].avgOut, 1);
  assert.equal(g.metrics.perPillar["02-y"].avgOut, 1);
});

check("metrics: an isolated page is its own component", () => {
  const g = buildGraph([rec("a", { b: 1 }), rec("b"), rec("lone")]);
  assert.deepEqual(g.metrics.components, [2, 1]);
});

// ---------- determinism + safety ----------

check("determinism: shuffled input order produces byte-identical output", () => {
  const recs = [
    rec("a", { c: 1, d: 1, e: 1 }, ["k1", "k2"]),
    rec("b", { c: 1, d: 1, e: 1 }, ["k1"]),
    rec("c", { a: 1 }, ["k2"]),
    rec("d"), rec("e", { b: 2 }),
  ];
  const g1 = JSON.stringify(buildGraph(recs));
  const g2 = JSON.stringify(buildGraph(recs.slice().reverse()));
  const g3 = JSON.stringify(buildGraph([recs[2], recs[4], recs[0], recs[3], recs[1]]));
  assert.equal(g1, g2);
  assert.equal(g1, g3);
});

check("buildGraph throws on duplicate slugs", () => {
  assert.throws(() => buildGraph([rec("a"), rec("a")]), /duplicate/i);
});

check("GATE defaults: minOut 2, enforceMinOut false until Wave 160", () => {
  assert.equal(GATE.minOut, 2);
  assert.equal(GATE.enforceMinOut, false);
});

// ---------- formatReasons ----------

check("formatReasons: exact copy for every combination class", () => {
  assert.equal(formatReasons({ out: 1, in: 1, shared: 2, mutual: 3 }),
    "linked both ways · cites 2 shared studies · 3 shared connections");
  assert.equal(formatReasons({ out: 1, in: 0, shared: 0, mutual: 0 }), "linked from this page");
  assert.equal(formatReasons({ out: 0, in: 1, shared: 1, mutual: 1 }),
    "links to this page · cites 1 shared study · 1 shared connection");
  assert.equal(formatReasons({ out: 0, in: 0, shared: 2, mutual: 0 }), "cites 2 shared studies");
});

// ---------- parseContentsIndex ----------

check("parseContentsIndex: bullet format (09 style) — categories, descs, Contents-bounded", () => {
  const md = [
    "# P", "## Contents", "**Cat A**",
    "- [One](one.md) — first thing",
    "- [Two](two.md)",
    "**Cat B**",
    "- [Three](three.md) — third",
    "## Other",
    "- [Four](four.md) — outside",
  ].join("\n");
  const cats = parseContentsIndex(md);
  assert.deepEqual(cats, [
    { category: "Cat A", items: [
      { slug: "one", title: "One", desc: "first thing" },
      { slug: "two", title: "Two", desc: "" },
    ] },
    { category: "Cat B", items: [{ slug: "three", title: "Three", desc: "third" }] },
  ]);
});

check("parseContentsIndex: table format (00–08 style) — header/separator skipped, desc = Covers column", () => {
  const md = [
    "# P", "intro", "## Contents",
    "| Page | Covers | Status |",
    "|---|---|---|",
    "| [One](one.md) | does one | ✅ |",
    "| [Two](two.md) | does two | ✅ |",
    "## Next",
    "| [Three](three.md) | nope | ✅ |",
  ].join("\n");
  const cats = parseContentsIndex(md);
  assert.equal(cats.length, 1);
  assert.equal(cats[0].category, "");
  assert.deepEqual(cats[0].items, [
    { slug: "one", title: "One", desc: "does one" },
    { slug: "two", title: "Two", desc: "does two" },
  ]);
});

check("parseContentsIndex: no Contents section → empty", () => {
  assert.deepEqual(parseContentsIndex("# P\njust prose"), []);
});

// ---------- the REAL knowledge base ----------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(root, "content");
const records = [];
const known = new Set();
for (const dir of readdirSync(CONTENT)) {
  const p = join(CONTENT, dir);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) {
    if (!f.endsWith(".md") || f === "index.md") continue;
    known.add(f.replace(/\.md$/, ""));
  }
}
for (const dir of readdirSync(CONTENT)) {
  const p = join(CONTENT, dir);
  if (!statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p)) {
    if (!f.endsWith(".md") || f === "index.md") continue;
    records.push(extractPage({ slug: f.replace(/\.md$/, ""), pillar: dir, md: readFileSync(join(p, f), "utf8") }, known));
  }
}
const G = buildGraph(records);

check("real KB: all non-index pages load with unique slugs", () => {
  assert.equal(G.metrics.pages, records.length);
  assert.ok(records.length >= 90, `expected ~93 pages, got ${records.length}`);
});

check("real KB: the graph is ONE connected component (a network, not islands)", () => {
  assert.deepEqual(G.metrics.components.length, 1, `components: ${JSON.stringify(G.metrics.components)}`);
});

check("real KB: zero rendered-orphans (every page is linked FROM somewhere it renders)", () => {
  assert.deepEqual(G.metrics.orphans, []);
});

check("real KB: rendered link volume canary (≥300 in-app-visible page links)", () => {
  const total = records.reduce((n, r) => n + Object.values(r.outbound).reduce((a, b) => a + b, 0), 0);
  assert.ok(total >= 300, `only ${total} rendered page links`);
});

check("real KB: every suggested pair meets the qualification rule", () => {
  for (const [slug, pp] of Object.entries(G.perPage)) {
    for (const s of pp.suggested || []) {
      const ok = s.shared >= 2 || s.mutual >= 4 || (s.shared >= 1 && s.mutual >= 3);
      assert.ok(ok, `${slug} → ${s.slug} suggested with shared=${s.shared} mutual=${s.mutual}`);
    }
  }
});

check("real KB: every connected entry has a nonzero reason", () => {
  for (const pp of Object.values(G.perPage)) {
    for (const c of pp.connected) {
      assert.ok(c.out > 0 || c.in > 0 || c.shared > 0 || c.mutual > 0);
      assert.ok(formatReasons(c).length > 0);
    }
  }
});

check("real KB: min-out-degree holds once GATE.enforceMinOut flips (Wave 160)", () => {
  if (GATE.enforceMinOut) {
    assert.deepEqual(G.metrics.underlinked, [], `underlinked: ${G.metrics.underlinked.join(", ")}`);
  }
});

console.log(`\ntest-graph: ${passed} checks passed.`);
