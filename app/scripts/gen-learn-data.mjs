// Bundle the beginner on-ramp library (content/09-getting-started) into a client
// module the app can render in-app and offline. The nervous never-been-to-a-gym
// user gets the glossary, first-session walkthrough, starting-weight method, etc.
// without ever leaving the app. Data only — no build framework, no deps.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../content/09-getting-started");
const OUT = join(here, "../public/learn-data.js");

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
  t = t.replace(/\[Grade ([A-D])\]/g, '<span class="gradetag">Grade $1</span>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    if (/^https?:\/\//.test(url)) return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    const m = url.match(/^([a-z0-9-]+)\.md(?:#.*)?$/); // sibling page in this pillar
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
    const h = line.match(/^(#{2,4}) (.+)/);
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

const files = Object.fromEntries(
  readdirSync(SRC).filter((f) => f.endsWith(".md")).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(SRC, f), "utf8")])
);
// Every page we ship is a valid deep-link target, so cross-references inside the
// prose become tappable instead of dead text. Must be filled BEFORE any toHtml().
for (const slug of Object.keys(files)) if (slug !== "index") BUNDLED.add(slug);
const index = parseIndex(files["index"] || "");
const pages = {};
const seen = new Set();
for (const cat of index) {
  for (const it of cat.items) {
    const md = files[it.slug];
    if (!md) { console.warn("  ! index references missing page:", it.slug); continue; }
    const { title, tldr, html } = toHtml(md);
    pages[it.slug] = { title: title || it.title, tldr, html };
    seen.add(it.slug);
  }
}
// Any getting-started page not listed in the index still gets bundled (reachable
// via deep-links), appended under a catch-all so nothing is silently dropped.
const extras = [];
for (const [slug, md] of Object.entries(files)) {
  if (slug === "index" || seen.has(slug)) continue;
  const { title, tldr, html } = toHtml(md);
  pages[slug] = { title, tldr, html };
  extras.push({ slug, title, desc: "" });
}
if (extras.length) index.push({ category: "More", items: extras });

const banner = "// AUTO-GENERATED by app/scripts/gen-learn-data.mjs — do not edit by hand.\n";
writeFileSync(OUT, `${banner}export const LEARN_INDEX = ${JSON.stringify(index)};\nexport const LEARN_PAGES = ${JSON.stringify(pages)};\n`);
console.log(`Wrote public/learn-data.js — ${Object.keys(pages).length} pages, ${index.length} categories.`);
