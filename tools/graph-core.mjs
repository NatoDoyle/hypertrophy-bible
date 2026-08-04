// The KB graph engine — Goal 1's "neural network" made real and measurable.
//
// Pure core (pattern of derive-metrics/plan-core): fs-free, Date.now/Math.random-free,
// deterministic — byte-identical output for the same records regardless of input order.
// Consumed by BOTH app/scripts/gen-learn-data.mjs (bakes each page's connections into
// the client bundle) and tools/check-links.mjs (the interconnection gate), so the graph
// the app renders and the graph the gate enforces are the same object by construction.
//
// Nodes are content pages. Edges exist only where pages actually link; weights and
// "suggested" (2-hop) connections are derived exclusively from verifiable signals —
// link occurrences, bidirectionality, shared registry citations, shared neighbours —
// so every surfaced connection can state WHY (formatReasons), never an invented score.

// ---------- link + section grammar (must mirror the app's renderer) ----------

// A link the app can render as an in-app jump (gen-learn-data.mjs inline()): a sibling
// page (volume.md) or a one-level cross-pillar page (../03-programming/warm-up.md).
export const PAGE_LINK_RE = /\]\((?:\.\.\/[a-z0-9-]+\/)?([a-z0-9-]+)\.md(?:#[^)]*)?\)/g;

// Any relative .md link at all (the gate uses this to catch links that would resolve on
// disk but NOT match PAGE_LINK_RE — i.e. links invisible in-app).
export const ANY_MD_LINK_RE = /\]\((?!https?:|mailto:|#)([^)\s]+?\.md)(?:#[^)]*)?\)/g;

// Drop exactly what the app's toHtml() never renders: footnote-definition lines and the
// whole "References" / "Backing Data" sections (##–#### heading through the next heading
// of equal-or-shallower level). A link that only exists there is invisible to users —
// the Wave-104/105 lesson — so it must not count toward the traversable graph.
export function stripNonRendered(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\[\^[^\]]+\]:/.test(line)) { i++; continue; }
    const h = line.match(/^(#{2,4}) (.+)/);
    if (h && /^(references|backing data)$/i.test(h[2].trim())) {
      const lvl = h[1].length;
      i++;
      while (i < lines.length) {
        const nh = lines[i].match(/^(#{1,4}) /);
        if (nh && nh[1].length <= lvl) break;
        i++;
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

const bySlugAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => bySlugAsc(a, b)));

// One content page → its graph record. `outbound` counts RENDERED page→page link
// occurrences (index targets, self-links and unknown slugs dropped); `citations` is the
// page's deduped set of footnote reference keys (definitions excluded by the (?!:)).
export function extractPage({ slug, pillar, md }, knownSlugs) {
  const title = (md.match(/^# (.+)$/m) || [, slug])[1].trim();
  const outbound = {};
  for (const m of stripNonRendered(md).matchAll(PAGE_LINK_RE)) {
    const target = m[1];
    if (target === "index" || target === slug || !knownSlugs.has(target)) continue;
    outbound[target] = (outbound[target] || 0) + 1;
  }
  const cit = new Set();
  for (const m of md.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) cit.add(m[1]);
  return { slug, pillar, title, outbound: sortObj(outbound), citations: [...cit].sort(bySlugAsc) };
}

// The gate's single flip point. Wave 159 shipped enforceMinOut=false (warn) while 26
// pages sat below the bar; Wave 160's authoring pass cleared them, so it is now ENFORCED:
// every content page must carry at least `minOut` distinct rendered outbound page links.
// test-graph.mjs and check-links.mjs both read it, so npm test and npm run check enforce
// the same bar automatically — a new page that links to nothing fails the build.
export const GATE = { minOut: 2, enforceMinOut: true };

// ---------- depth grammar (Wave 175) ----------

// The prose a reader actually reads, with everything that carries digits but conveys
// no answer removed: footnote markers ([^smith-2017]), link TARGETS (../03-programming/
// x.md — the link TEXT stays, it's rendered), code spans, and the non-rendered sections
// stripNonRendered already drops. Without this, a densely-cited page scores as
// "full of numbers" purely from its citation keys — measuring the bibliography
// instead of the guidance, which is the exact self-deception lesson 25 warns about.
export function renderedProse(md) {
  return stripNonRendered(md)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[\^[^\]]+\]/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/^\s*\|[-: |]+\|\s*$/gm, " ");   // table separator rows are not prose
}

// A "number a reader can act on": any whitespace-delimited token carrying a digit.
// Counts 7–9, 1.6, 20–40, 0.25–0.5%/wk once each. Deliberately generous — the point
// is to separate pages that quantify from pages that gesture, not to grade precision.
const NUMERIC_TOKEN = /(^|\s)[^\s]*\d[^\s]*/g;

// Per-page DEPTH record. Depth is the axis Goal 1 is actually judged on and nothing
// measured it: check-links proved the graph was connected, check-claim-coverage proved
// graded claims carried citations, and both were green while pages answered the reader's
// "how much / how long / how do I know" in adjectives. A green gate proves only what it
// measures (lesson 25), so this computes the numbers that would falsify "deep enough".
export function pageDepth({ slug, pillar, md }) {
  const prose = renderedProse(md);
  const words = (prose.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length;
  const numbers = (prose.match(NUMERIC_TOKEN) ?? []).length;
  const tableRows = (prose.match(/^\s*\|.*\|\s*$/gm) ?? []).length;
  return {
    slug, pillar, words, numbers, tableRows,
    // Numbers per 100 words: a long page and a short one are held to the same bar.
    numericDensity: words ? Math.round((numbers / words) * 10000) / 100 : 0,
  };
}

// The bar, and the single flip point (mirrors GATE above). Ships WARN-ONLY: lesson 25's
// own corollary is to introduce a gate in warn mode in the wave that adds it and flip it
// to fail only in the wave whose authoring makes it pass, so the bar never lands red.
//
// Thresholds are read OFF THE CORPUS, not invented. Measured over the 93 content pages
// when this shipped: words p10/p25/median = 454/518/659, numeric density (numbers per
// 100 words) p10/p25/median = 0.22/0.40/0.96. So both floors sit at roughly the 10th
// percentile — they flag the genuine tail, not a round number that felt right. The
// first draft of this file guessed minNumericDensity: 1.5, which would have flagged
// ~65% of the KB and taught everyone to ignore the report; measuring first is the whole
// discipline (a gate nobody believes is worse than no gate).
export const DEPTH_GATE = { minWords: 450, minNumericDensity: 0.25, warnOnly: true };

// The two tells the Waves 159-161 lessons named, TOGETHER: a page that is both thin (or
// number-free) and poorly connected is what "nobody has revisited this" looks like.
// Either alone is often legitimate — a focused rebuttal is short, a hub page is long and
// links widely — so this AND is a priority shortlist, not a verdict.
//
// Because it is an AND it necessarily HIDES pages that fail one tell while passing the
// other (alcohol.md: 363 words and 0.28 numbers/100w, but 3 outbound links, so it never
// appears here — and it is the KB's clearest "dose page that gives no doses"). That is
// this composition's blind spot stated plainly, which is why check-depth.mjs reports
// each floor on its own line as well: a green gate proves only what it measures, and
// that applies to gates I write too.
// `minOut` defaults from GATE but is read OFF THE PASSED GATE — the first version took
// two thresholds from the argument and silently read the third from the module global,
// so a caller injecting a custom gate got a half-overridden predicate with no error.
export const DEPTH_DEFAULTS = () => ({ ...DEPTH_GATE, minOut: GATE.minOut });
export const isUnderDeveloped = (depth, outDegree, gate = DEPTH_DEFAULTS()) =>
  (depth.words < gate.minWords || depth.numericDensity < gate.minNumericDensity)
  && outDegree <= (gate.minOut ?? GATE.minOut);

// The whole selection, in the pure core so it can be tested without a filesystem.
//
// `flaggedPages` is the honest headline: the shortlist is DERIVED from the two floors,
// so summing the three list lengths counts a page failing everything three times. The
// first version reported "23 depth warnings" for 17 distinct pages — a 35% overstatement
// that would have landed in the FAILURE message the moment the gate flips to enforcing.
// Count pages, report flags alongside.
export function depthReport(depths, outDegreeBySlug, gate = DEPTH_DEFAULTS()) {
  const belowWords = depths.filter((d) => d.words < gate.minWords);
  const belowDensity = depths.filter((d) => d.numericDensity < gate.minNumericDensity);
  const shortlist = depths.filter((d) => isUnderDeveloped(d, outDegreeBySlug.get(d.slug) ?? 0, gate));
  const flaggedPages = new Set([...belowWords, ...belowDensity].map((d) => d.slug));
  return { belowWords, belowDensity, shortlist, flaggedPages, flagCount: belowWords.length + belowDensity.length + shortlist.length };
}

// Records → the whole graph. Weights (integers, max 24) — every term a checkable fact:
//   3·min(n_ab,2) + 3·min(n_ba,2)  direct links each way, diminishing after the 2nd
// + 2 if linked both ways           bidirectionality bonus
// + 2·min(shared,3)                 shared verified citations (bibliographic coupling)
// + 1·min(mutual,4)                 shared direct-link neighbours
// "Suggested" pairs (no direct link) qualify only on real coupling: shared≥2 OR
// mutual≥4 OR (shared≥1 AND mutual≥3), ranked by 2·min(shared,3)+min(mutual,4).
export function buildGraph(records) {
  const recs = [...records].sort((x, y) => bySlugAsc(x.slug, y.slug));
  const bySlug = new Map();
  for (const r of recs) {
    if (bySlug.has(r.slug)) throw new Error(`duplicate slug: ${r.slug}`);
    bySlug.set(r.slug, r);
  }
  const slugs = [...bySlug.keys()];

  // Directed pair counts + undirected adjacency + citation sets.
  const dir = new Map(); // "a|b" (a<b) → { ab, ba }
  const adj = new Map(slugs.map((s) => [s, new Set()]));
  const inDeg = new Map(slugs.map((s) => [s, 0]));
  for (const r of recs) {
    for (const [t, n] of Object.entries(r.outbound)) {
      if (!bySlug.has(t)) throw new Error(`outbound target not in record set: ${r.slug} → ${t}`);
      const k = r.slug < t ? `${r.slug}|${t}` : `${t}|${r.slug}`;
      const e = dir.get(k) || { ab: 0, ba: 0 };
      if (r.slug < t) e.ab += n; else e.ba += n;
      dir.set(k, e);
      adj.get(r.slug).add(t);
      adj.get(t).add(r.slug);
      inDeg.set(t, inDeg.get(t) + 1); // outbound keys are distinct per source
    }
  }
  const cit = new Map(recs.map((r) => [r.slug, new Set(r.citations || [])]));
  const shared = (a, b) => { let n = 0; for (const k of cit.get(a)) if (cit.get(b).has(k)) n++; return n; };
  const mutual = (a, b) => { let n = 0; for (const s of adj.get(a)) if (adj.get(b).has(s)) n++; return n; };

  const edges = [];
  for (const [k, e] of dir.entries()) {
    const [a, b] = k.split("|");
    const sh = shared(a, b);
    const mu = mutual(a, b);
    const weight = 3 * Math.min(e.ab, 2) + 3 * Math.min(e.ba, 2)
      + (e.ab > 0 && e.ba > 0 ? 2 : 0)
      + 2 * Math.min(sh, 3) + Math.min(mu, 4);
    edges.push({ a, b, weight, out: e.ab, in: e.ba, shared: sh, mutual: mu });
  }
  edges.sort((x, y) => bySlugAsc(x.a, y.a) || bySlugAsc(x.b, y.b));

  const perPage = {};
  for (const s of slugs) perPage[s] = { connected: [], suggested: [] };
  for (const e of edges) {
    perPage[e.a].connected.push({ slug: e.b, weight: e.weight, out: e.out, in: e.in, shared: e.shared, mutual: e.mutual });
    perPage[e.b].connected.push({ slug: e.a, weight: e.weight, out: e.in, in: e.out, shared: e.shared, mutual: e.mutual });
  }
  for (let i = 0; i < slugs.length; i++) {
    for (let j = i + 1; j < slugs.length; j++) {
      const a = slugs[i], b = slugs[j];
      if (adj.get(a).has(b)) continue;
      const sh = shared(a, b);
      const mu = mutual(a, b);
      if (!(sh >= 2 || mu >= 4 || (sh >= 1 && mu >= 3))) continue;
      const score = 2 * Math.min(sh, 3) + Math.min(mu, 4);
      perPage[a].suggested.push({ slug: b, weight: score, shared: sh, mutual: mu });
      perPage[b].suggested.push({ slug: a, weight: score, shared: sh, mutual: mu });
    }
  }
  for (const s of slugs) {
    perPage[s].connected.sort((x, y) => y.weight - x.weight || bySlugAsc(x.slug, y.slug));
    perPage[s].connected = perPage[s].connected.slice(0, 6);
    perPage[s].suggested.sort((x, y) => y.weight - x.weight || y.shared - x.shared || bySlugAsc(x.slug, y.slug));
    perPage[s].suggested = perPage[s].suggested.slice(0, 3);
  }

  // Metrics. Out-degree counts DISTINCT targets (linking the same page twice is one
  // connection); in-degree counts distinct sources.
  const outDeg = new Map(slugs.map((s) => [s, Object.keys(bySlug.get(s).outbound).length]));
  const stats = (vals) => {
    const v = [...vals].sort((x, y) => x - y);
    if (!v.length) return { min: 0, max: 0, mean: 0, median: 0 };
    const mid = v.length / 2;
    return {
      min: v[0], max: v[v.length - 1],
      mean: v.reduce((a, b) => a + b, 0) / v.length,
      median: v.length % 2 ? v[(v.length - 1) / 2] : (v[mid - 1] + v[mid]) / 2,
    };
  };
  const perPillar = {};
  for (const r of recs) {
    const p = perPillar[r.pillar] || (perPillar[r.pillar] = { pages: 0, avgOut: 0 });
    p.pages++;
    p.avgOut += outDeg.get(r.slug); // running total; divided below
  }
  for (const p of Object.values(perPillar)) p.avgOut = p.avgOut / p.pages;

  const seen = new Set();
  const components = [];
  for (const s of slugs) {
    if (seen.has(s)) continue;
    let size = 0;
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      for (const n of [...adj.get(cur)].sort(bySlugAsc)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    components.push(size);
  }
  components.sort((a, b) => b - a);

  const metrics = {
    pages: slugs.length,
    edgeCount: edges.length,
    components,
    orphans: slugs.filter((s) => inDeg.get(s) === 0),
    deadEnds: slugs.filter((s) => outDeg.get(s) === 0),
    underlinked: slugs.filter((s) => outDeg.get(s) < GATE.minOut),
    degreeOut: stats(outDeg.values()),
    degreeIn: stats(inDeg.values()),
    perPillar: sortObj(perPillar),
  };
  return { edges, perPage, metrics };
}

// {out,in,shared,mutual} → the human WHY, from the viewing page's perspective.
// Single source of truth for this copy: baked into the bundle by gen-learn-data.mjs
// and printed by the gate's report. Suggested entries have no out/in — reasons then
// state only the real coupling ("cites 2 shared studies · 3 shared connections").
export function formatReasons(r) {
  const o = r.out || 0, i = r.in || 0, sh = r.shared || 0, mu = r.mutual || 0;
  const parts = [];
  if (o > 0 && i > 0) parts.push("linked both ways");
  else if (o > 0) parts.push("linked from this page");
  else if (i > 0) parts.push("links to this page");
  if (sh > 0) parts.push(`cites ${sh} shared ${sh === 1 ? "study" : "studies"}`);
  if (mu > 0) parts.push(`${mu} shared connection${mu === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// Parse a pillar index.md's "## Contents" into ordered categories with curated
// descriptions. Understands BOTH formats in use: 09's bullet groups
// ("**Category**" + "- [Title](slug.md) — desc") and 00–08's tables
// ("| [Title](slug.md) | covers | … |", header/separator rows skipped). Bounded to the
// Contents section. Table rows with no preceding **Category** land in category "" —
// the caller labels those with the pillar title alone.
export function parseContentsIndex(md) {
  const m = md.match(/^## Contents\s*$/m);
  if (!m) return [];
  const rest = md.slice(m.index + m[0].length);
  const endM = rest.match(/^## /m);
  const body = endM ? rest.slice(0, endM.index) : rest;
  const cats = [];
  let cur = null;
  const push = (it) => {
    if (!cur) { cur = { category: "", items: [] }; cats.push(cur); }
    cur.items.push(it);
  };
  for (const raw of body.split("\n")) {
    const catM = raw.match(/^\*\*(.+?)\*\*\s*$/);
    if (catM) { cur = { category: catM[1].trim(), items: [] }; cats.push(cur); continue; }
    const bulletM = raw.match(/^- \[([^\]]+)\]\(([^)]+)\.md\)\s*(?:—\s*(.+))?/);
    if (bulletM) { push({ slug: bulletM[2].replace(/^.*\//, ""), title: bulletM[1], desc: (bulletM[3] || "").trim() }); continue; }
    if (raw.trim().startsWith("|")) {
      const cells = raw.split("|").slice(1, -1).map((c) => c.trim());
      const linkM = cells[0] && cells[0].match(/^\[([^\]]+)\]\(([^)]+)\.md\)$/);
      if (linkM) push({ slug: linkM[2].replace(/^.*\//, ""), title: linkM[1], desc: (cells[1] || "").trim() });
    }
  }
  return cats.filter((c) => c.items.length);
}
