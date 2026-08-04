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
import { extractPage, buildGraph, formatReasons, parseContentsIndex, renderableLinkSlug } from "../../tools/graph-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, "../../content");
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
    // Shared with the graph + the gate (graph-core's renderableLinkSlug) so the three
    // can never drift about what the reader can actually click.
    const slug = renderableLinkSlug(url);
    if (slug && BUNDLED.has(slug)) return `<button class="learnlink" data-learn="${slug}">${label}</button>`;
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

const banner = "// AUTO-GENERATED by app/scripts/gen-learn-data.mjs — do not edit by hand.\n";
writeFileSync(OUT, `${banner}export const LEARN_INDEX = ${JSON.stringify(index)};\nexport const LEARN_PAGES = ${JSON.stringify(pages)};\n`);
console.log(`Wrote public/learn-data.js — ${Object.keys(pages).length} pages, ${index.length} categories, ${graph.metrics.edgeCount} graph edges.`);
