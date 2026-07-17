// Bundle the beginner on-ramp library (content/09-getting-started) into a client
// module the app can render in-app and offline. The nervous never-been-to-a-gym
// user gets the glossary, first-session walkthrough, starting-weight method, etc.
// without ever leaving the app. Data only — no build framework, no deps.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
    const m = url.match(/^(?:\.\.\/[a-z0-9-]+\/)?([a-z0-9-]+)\.md(?:#.*)?$/);
    if (m && BUNDLED.has(m[1])) return `<button class="learnlink" data-learn="${m[1]}">${label}</button>`;
    return label;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
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
    if (h && /^(references|backing data)$/i.test(h[2].trim())) { i++; continue; } // headers for stripped sections
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

// Parse the "## Contents" section of index.md into ordered categories with the
// curated one-line descriptions — that's the on-ramp's intended reading order.
function parseIndex(md) {
  const cats = [];
  let cur = null;
  const inContents = md.split(/^## Contents/m)[1] || "";
  for (const raw of inContents.split("\n")) {
    const catM = raw.match(/^\*\*(.+?)\*\*\s*$/);
    if (catM) { cur = { category: catM[1].trim(), items: [] }; cats.push(cur); continue; }
    const itemM = raw.match(/^- \[([^\]]+)\]\(([^)]+)\.md\)\s*(?:—\s*(.+))?/);
    if (itemM && cur) cur.items.push({ slug: itemM[2], title: itemM[1], desc: (itemM[3] || "").trim() });
  }
  return cats;
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
  const cats = parseIndex(files["index"] || "");
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
    if (items.length) index.push({ category: p.tier === "deeper" ? `${p.title} · ${cat.category.replace(/\*\*/g, "")}` : cat.category, tier: p.tier, items });
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

const banner = "// AUTO-GENERATED by app/scripts/gen-learn-data.mjs — do not edit by hand.\n";
writeFileSync(OUT, `${banner}export const LEARN_INDEX = ${JSON.stringify(index)};\nexport const LEARN_PAGES = ${JSON.stringify(pages)};\n`);
console.log(`Wrote public/learn-data.js — ${Object.keys(pages).length} pages, ${index.length} categories.`);
