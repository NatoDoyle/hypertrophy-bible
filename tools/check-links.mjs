#!/usr/bin/env node
// Internal-link integrity + the interconnection GATE (Goal 1: the KB should be "a neural
// network" — a densely interconnected graph, not flat standalone pages).
//
// FAILS (exit 1) on:
//   - a BROKEN internal link: any relative Markdown link to a `.md`/`.json` file that
//     doesn't resolve on disk (a dead "see [Volume]" silently erodes the graph);
//   - a NON-CANONICAL page link in a rendered section: it resolves on disk but doesn't
//     match the sibling/`../pillar/` form the app's renderer accepts, so it would render
//     as plain text — invisible in-app (the Wave-104/105 lesson made an invariant);
//   - a FRAGMENTED graph (more than one connected component) — a network has no islands;
//   - an ORPHAN page: no rendered link from any content page reaches it;
//   - duplicate slugs across pillars (slugs are the app's global page ids);
//   - out-degree below GATE.minOut once GATE.enforceMinOut is flipped (Wave 160).
//
// WARNS on: out-degree below GATE.minOut while enforcement is off, and pages missing
// from their pillar's `## Contents` (curated navigation should know every page).
//
// Always REPORTS the network shape: pages, edges, components, degree stats, per-pillar
// link density — so densification is measurable, not vibes.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractPage, buildGraph, parseContentsIndex, stripNonRendered, ANY_MD_LINK_RE, GATE,
} from "./graph-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(root, "content");

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const mdFiles = walk(CONTENT);
const texts = new Map(mdFiles.map((f) => [f, readFileSync(f, "utf8")]));
const isIndex = (f) => f.endsWith(`${sep}index.md`) || f.endsWith("/index.md");
const rel = (f) => relative(root, f);

let errors = 0;
let warnings = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); errors++; };
const warn = (msg) => { console.log(`  ⚠ ${msg}`); warnings++; };

// ---------- pass 1: broken internal links (all files, .md and .json targets) ----------
// Every relative Markdown link to a .md/.json file: ](path) or ](path#anchor).
const LINK = /\]\((?!https?:|mailto:|#)([^)\s]+?\.(?:md|json))(?:#[^)]*)?\)/g;
for (const file of mdFiles) {
  for (const m of texts.get(file).matchAll(LINK)) {
    const target = resolve(dirname(file), m[1]);
    if (!existsSync(target)) fail(`${rel(file)} → ${m[1]} (target missing)`);
  }
}

// ---------- pass 2: the rendered page→page graph ----------
const contentPages = mdFiles.filter((f) => !isIndex(f));
const known = new Set(contentPages.map((f) => basename(f, ".md")));

// Canonical-form invariant: a rendered-section link to a real content PAGE must use the
// form the app renders as an in-app jump. (Links to index.md are tolerated navigation —
// they render as plain text by design; graph edges never count them.)
const CANONICAL = /^(?:\.\.\/[a-z0-9-]+\/)?[a-z0-9-]+\.md$/;
for (const f of contentPages) {
  for (const m of stripNonRendered(texts.get(f)).matchAll(ANY_MD_LINK_RE)) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target) || !target.startsWith(CONTENT + sep) || isIndex(target)) continue;
    if (!CANONICAL.test(m[1])) fail(`non-canonical page link (invisible in-app): ${rel(f)} → ${m[1]}`);
  }
}

let graph = null;
try {
  graph = buildGraph(contentPages.map((f) => extractPage({
    slug: basename(f, ".md"), pillar: basename(dirname(f)), md: texts.get(f),
  }, known)));
} catch (e) {
  fail(e.message);
}

if (graph) {
  const m = graph.metrics;
  if (m.components.length > 1) {
    fail(`graph fragmented into ${m.components.length} components (sizes: ${m.components.join(", ")}) — the KB must be ONE connected network`);
  }
  for (const s of m.orphans) fail(`orphan page — no rendered link from any content page reaches it: ${s}`);
  if (m.underlinked.length) {
    if (GATE.enforceMinOut) {
      fail(`${m.underlinked.length} page(s) below ${GATE.minOut} rendered outbound page links:`);
      for (const s of m.underlinked) console.error(`      ${s}`);
    } else {
      warn(`${m.underlinked.length} page(s) below ${GATE.minOut} rendered outbound page links (interconnection gap — becomes a FAILURE when GATE.enforceMinOut flips):`);
      for (const s of m.underlinked) console.log(`      ${s}`);
    }
  }

  // Curated-navigation coverage: every page should appear in its pillar's ## Contents.
  for (const dir of readdirSync(CONTENT)) {
    const p = join(CONTENT, dir);
    if (!statSync(p).isDirectory() || !existsSync(join(p, "index.md"))) continue;
    const listed = new Set(parseContentsIndex(texts.get(join(p, "index.md"))).flatMap((c) => c.items.map((i) => i.slug)));
    for (const f of contentPages) {
      if (dirname(f) !== p) continue;
      const slug = basename(f, ".md");
      if (!listed.has(slug)) warn(`${dir}/index.md ## Contents doesn't list: ${slug}`);
    }
  }

  console.log(`\n${mdFiles.length} content files checked. network: ${m.pages} pages, ${m.edgeCount} edges, ${m.components.length} component(s), ${m.deadEnds.length} dead end(s); out-degree median ${m.degreeOut.median}, max ${m.degreeOut.max}.`);
  console.log(`  density (avg distinct outbound page links/page): ${Object.entries(m.perPillar).map(([k, v]) => `${k}=${v.avgOut.toFixed(1)}`).join("  ")}`);
}

if (warnings) console.log(`\n⚠ ${warnings} warning(s).`);
if (errors) { console.error(`\n${errors} graph error(s) — fix before shipping.`); process.exit(1); }
