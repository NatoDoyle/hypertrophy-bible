// Bundle the beginner on-ramp library (content/09-getting-started) into a client
// module the app can render in-app and offline. The nervous never-been-to-a-gym
// user gets the glossary, first-session walkthrough, starting-weight method, etc.
// without ever leaving the app. Data only — no build framework, no deps.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// The KB graph engine (pure core, same module the check-links gate runs) — bakes each
// page's ranked connections + "also connected" suggestions into the bundle, and parses
// BOTH pillar-index formats (09's bullets, 00–08's tables) so curated order/descriptions
// reach the Learn list.
import { extractPage, buildGraph, formatReasons, parseContentsIndex, linkTarget } from "../../tools/graph-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, "../../content");
const EXERCISES_DIR = join(here, "../../data/exercises");
const OUT = join(here, "../public/learn-data.js");

// Every pillar ships. The beginner on-ramp leads (tier "start", curated
// categories); the evidence pillars follow under "Go deeper" (tier "deeper") —
// the KB's ~75 graded science pages previously shipped to nobody.
const PILLARS = [
  { dir: "09-getting-started", tier: "start" },
  { dir: "00-foundations", tier: "deeper", title: "🧬 How muscle grows" },
  { dir: "01-training-variables", tier: "deeper", title: "🎛️ Training variables" },
  { dir: "03-programming", tier: "deeper", title: "🗓️ Programming" },
  { dir: "02-muscle-guides", tier: "deeper", title: "💪 Muscle guides" },
  { dir: "04-nutrition", tier: "deeper", title: "🍽️ Nutrition" },
  { dir: "05-recovery", tier: "deeper", title: "😴 Recovery" },
  { dir: "06-individualization", tier: "deeper", title: "🧍 Individualization" },
  { dir: "07-tracking", tier: "deeper", title: "📊 Tracking & plateaus" },
  { dir: "08-myths", tier: "deeper", title: "🚫 Myths & BS detection" },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Slugs bundled into the app — a link to one of these becomes a real in-app jump.
// Populated before conversion runs.
const BUNDLED = new Set();

// Every exercise the KB could link to. Read from disk rather than importing
// app/src/kb-data.mjs so the two generators have no run-order dependency.
// Populated up front for the same reason BUNDLED is: `inline()` consults it.
const EX_IDS = new Set(readdirSync(EXERCISES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
// Only the exercises the prose actually references get bundled — all 171 would
// cost ~235 KB raw where the referenced 64 cost ~87 KB, on an asset the service
// worker precaches. Collected while rendering.
const EX_REFS = new Set();
let exRefTotal = 0;

// Inline markdown → HTML on already-escaped text.
//   - links to a SIBLING page we bundle  → a tappable in-app deep link (data-learn)
//   - external http links                → kept, opened in a new tab
//   - links to other pillars (../…)      → plain text (that content isn't in the app)
// NOTE: esc() runs FIRST, so any quote/angle bracket in a URL is already an entity
// by the time it lands in an attribute, and only http(s) targets ever become hrefs
// (so a `javascript:` URL renders as inert text).
function inline(text) {
  let t = esc(text);
  t = t.replace(/\[\^[^\]\s]+\]/g, ""); // inline footnote markers — refs live on the site, not in-app
  t = t.replace(/\[Grade ([A-D])\]/g, '<span class="gradetag">Grade $1</span>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    if (/^https?:\/\//.test(url)) return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    // sibling (volume.md) OR cross-pillar (../03-programming/warm-up.md) — every
    // bundled page is a valid in-app jump now that all pillars ship
    // Shared with the graph + the gate (graph-core's `rendersAsLink`, which carries
    // BOTH halves: the .md shape AND "we actually ship that page"). Importing the whole
    // predicate rather than half of it is what makes the three agree by construction —
    // when this file applied `BUNDLED.has` locally, the gate didn't, and index links
    // rendered as text while being counted as live jumps.
    // ONE classifier for both kinds of in-app jump. A muscle guide's ranked pick
    // list links `../../data/exercises/<id>.json`; those used to render as bare
    // label text, so the region-by-region recommendations those guides exist for
    // were unreachable from inside the app (back.md alone dropped 22 of them).
    // The id is `[a-z0-9-]+` by construction, so it cannot carry anything into
    // the attribute — the safety property comes from the predicate's alphabet,
    // not from trusting the source.
    const t = linkTarget(url, BUNDLED, EX_IDS);
    if (t?.kind === "page") return `<button class="learnlink" data-learn="${t.id}">${label}</button>`;
    if (t?.kind === "exercise") { EX_REFS.add(t.id); exRefTotal++; return `<button class="learnlink exlink" data-ex="${t.id}">${label}</button>`; }
    return label;
  });
  t = t.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, "<strong>$1</strong>"); // tolerates *italics* inside **bold** (11 pages rendered literal ** before)
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return t;
}

// Block-level markdown → HTML. Handles headings, paragraphs, ul/ol, tables,
// blockquotes. Returns { title, tldr, html }.
function toHtml(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  let title = "";
  const out = [];
  let tldr = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // title (first h1)
    const h1 = line.match(/^# (.+)/);
    if (h1 && !title) { title = h1[1].trim(); i++; continue; }
    if (/^\[\^[^\]]+\]:/.test(line)) { i++; continue; } // footnote definitions (References live on the site)
    const h = line.match(/^(#{2,4}) (.+)/);
    if (h && /^(references|backing data)$/i.test(h[2].trim())) {
      // Skip the WHOLE section, not just its heading — leaving the body produced
      // orphaned "None (conceptual)…" fragments dangling at the end of 53 pages.
      const lvl = h[1].length;
      i++;
      while (i < lines.length) {
        const nh = lines[i].match(/^(#{1,4}) /);
        if (nh && nh[1].length <= lvl) break;
        i++;
      }
      continue;
    }
    if (h) { const lvl = Math.min(4, h[1].length); out.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`); i++; continue; }
    // table
    if (line.startsWith("|") && lines[i + 1] && /^\|[\s:|-]+\|/.test(lines[i + 1])) {
      const head = line.split("|").slice(1, -1).map((c) => `<th>${inline(c.trim())}</th>`).join("");
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push("<tr>" + lines[i].split("|").slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join("") + "</tr>");
        i++;
      }
      out.push(`<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`);
      continue;
    }
    // blockquote (first one becomes the TL;DR pulled out of the body)
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      const inner = inline(buf.join(" ").replace(/\*\*TL;DR\*\*\s*—?\s*/i, "").trim());
      if (!tldr) tldr = inner; else out.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }
    // unordered list
    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^[-*] /, ""))}</li>`); i++; }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    // ordered list
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\d+\. /, ""))}</li>`); i++; }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    // paragraph (join following non-blank, non-special lines)
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^([#>|]|[-*] |\d+\. )/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { title, tldr, html: out.join("\n") };
}

// Load every pillar's pages up front (slugs are globally unique — verified),
// so BUNDLED is complete BEFORE any toHtml() runs and cross-pillar links resolve.
const byPillar = new Map(); // dir -> { slug -> md }
for (const p of PILLARS) {
  const dir = join(CONTENT, p.dir);
  const files = Object.fromEntries(
    readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")])
  );
  byPillar.set(p.dir, files);
  for (const slug of Object.keys(files)) if (slug !== "index") BUNDLED.add(slug);
}

const index = [];
const pages = {};
for (const p of PILLARS) {
  const files = byPillar.get(p.dir);
  const cats = parseContentsIndex(files["index"] || "");
  const seen = new Set();
  for (const cat of cats) {
    const items = [];
    for (const it of cat.items) {
      const md = files[it.slug];
      if (!md) { console.warn(`  ! ${p.dir} index references missing page:`, it.slug); continue; }
      const { title, tldr, html } = toHtml(md);
      pages[it.slug] = { title: title || it.title, tldr, html };
      seen.add(it.slug);
      items.push(it);
    }
    // Table-format indexes (00–08) carry no **Category** groups — those pages list
    // under the pillar title alone, in the index's curated order with its "Covers" descs.
    const label = cat.category
      ? (p.tier === "deeper" ? `${p.title} · ${cat.category}` : cat.category)
      : (p.tier === "deeper" ? p.title : "More");
    if (items.length) index.push({ category: label, tier: p.tier, items });
  }
  // Pages a pillar's index doesn't list still ship (deep-linkable), never dropped.
  const extras = [];
  for (const [slug, md] of Object.entries(files)) {
    if (slug === "index" || seen.has(slug)) continue;
    const { title, tldr, html } = toHtml(md);
    pages[slug] = { title, tldr, html };
    extras.push({ slug, title, desc: "" });
  }
  if (extras.length) index.push({ category: p.tier === "deeper" ? `${p.title} · More` : "More", tier: p.tier, items: extras });
}

// ---------- the neural-network layer: per-page connections baked at build time ----------
// Same engine, same records the gate checks — the graph users traverse IS the graph the
// gate enforces. Each entry ships as [slug, whyGloss]; titles resolve client-side.
const records = [];
for (const p of PILLARS) {
  for (const [slug, md] of Object.entries(byPillar.get(p.dir))) {
    if (slug !== "index") records.push(extractPage({ slug, pillar: p.dir, md }, BUNDLED));
  }
}
const graph = buildGraph(records);
let connectedTotal = 0;
for (const [slug, pg] of Object.entries(pages)) {
  const pp = graph.perPage[slug];
  if (!pp) throw new Error(`graph is missing bundled page "${slug}" — extractor drift?`);
  pg.connected = pp.connected.map((c) => [c.slug, formatReasons(c)]);
  connectedTotal += pg.connected.length;
  if (pp.suggested.length) pg.suggested = pp.suggested.map((s) => [s.slug, formatReasons(s)]);
}
if (connectedTotal === 0) throw new Error("graph produced zero connections — extractor/renderer drift?");

// ---------- the exercise sheets those refs open ----------
// EXACTLY the field set GET /api/exercise/:id returns, so the sheet the Learn tab
// renders offline and the sheet the player fetches are the same sheet. A parity
// test walks both, because "identical by construction" is the kind of claim this
// project has learned not to make in prose.
const MUSCLE_NAME = new Map(readdirSync(join(here, "../../data/muscles")).filter((f) => f.endsWith(".json"))
  .map((f) => { const m = JSON.parse(readFileSync(join(here, "../../data/muscles", f), "utf8")); return [m.id, m.name]; }));
const muscleNames = (ids) => (ids ?? []).map((id) => MUSCLE_NAME.get(id) ?? id);
const learnExercises = {};
for (const id of [...EX_REFS].sort()) {
  const e = JSON.parse(readFileSync(join(EXERCISES_DIR, `${id}.json`), "utf8"));
  learnExercises[id] = {
    id: e.id, name: e.name, cues: e.cues ?? [], common_errors: e.common_errors ?? [],
    equipment: e.equipment ?? null,
    primary_muscles: muscleNames(e.primary_muscles), secondary_muscles: muscleNames(e.secondary_muscles),
    execution_steps: e.execution_steps ?? [], good_when: e.good_when ?? [], bad_when: e.bad_when ?? [],
    loading_bias: e.loading_bias ?? null, cns_cost: e.cns_cost ?? null, difficulty: e.difficulty ?? null,
    resistance_profile: e.resistance_profile ?? null, movement_pattern: e.movement_pattern ?? null,
  };
}
// Drift tripwires, in this file's existing style: a predicate change that silently
// stops matching would otherwise ship a bundle whose buttons all vanished, and the
// page HTML would look fine.
if (exRefTotal === 0) throw new Error("zero exercise refs rendered — predicate/renderer drift?");
for (const [slug, pg] of Object.entries(pages)) {
  for (const m of pg.html.matchAll(/data-ex="([a-z0-9-]+)"/g)) {
    if (!learnExercises[m[1]]) throw new Error(`page "${slug}" links exercise "${m[1]}" with no bundled sheet`);
  }
}

const banner = "// AUTO-GENERATED by app/scripts/gen-learn-data.mjs — do not edit by hand.\n";
writeFileSync(OUT, `${banner}export const LEARN_INDEX = ${JSON.stringify(index)};\nexport const LEARN_PAGES = ${JSON.stringify(pages)};\nexport const LEARN_EXERCISES = ${JSON.stringify(learnExercises)};\n`);
console.log(`Wrote public/learn-data.js — ${Object.keys(pages).length} pages, ${index.length} categories, ${graph.metrics.edgeCount} graph edges, ${exRefTotal} exercise refs → ${Object.keys(learnExercises).length} sheets.`);
