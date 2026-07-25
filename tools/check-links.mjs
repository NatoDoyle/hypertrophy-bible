#!/usr/bin/env node
// Internal-link integrity + interconnection gate (Goal 1: the KB should be "a neural
// network" — a densely interconnected graph, not flat standalone pages).
//
// FAILS (exit 1) on a BROKEN internal link: any relative Markdown link to a `.md` or
// `.json` file that doesn't resolve to a real file on disk. Broken cross-references are
// real bugs (a dead "see [Volume]") and silently erode the graph as pages move/rename.
//
// WARNS (never fails) on ORPHAN content pages — a non-index page that NOTHING else links
// to. Orphans are the opposite of a network: knowledge you can only reach by already
// knowing it's there. The warning makes interconnection measurable so it can be improved
// deliberately (and so a newly-added page that nobody links to is visible immediately).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const mdFiles = walk(join(root, "content"));
// Every relative Markdown link to a .md/.json file: ](path) or ](path#anchor).
const LINK = /\]\((?!https?:|mailto:|#)([^)\s]+?\.(?:md|json))(?:#[^)]*)?\)/g;

let errors = 0;
const inbound = new Map(mdFiles.map((f) => [f, new Set()]));

for (const file of mdFiles) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(LINK)) {
    const target = resolve(dirname(file), m[1]);
    if (!existsSync(target)) {
      console.error(`  ✗ ${relative(root, file)} → ${m[1]} (target missing)`);
      errors++;
      continue;
    }
    // Track the content→content graph for the orphan report. A pillar index.md is a
    // table of contents that links to every page in its pillar — that's NAVIGATION, not
    // interconnection, so index pages don't count as inbound sources here. What matters
    // for "a neural network" is whether a real CONTENT page links to this one.
    if (target.endsWith(".md") && inbound.has(target) && target !== file && !isIndex(file)) inbound.get(target).add(file);
  }
}

function isIndex(f) { return f.endsWith("index.md"); }
const orphans = mdFiles.filter((f) => !isIndex(f) && inbound.get(f).size === 0);

console.log(`\n${mdFiles.length} content pages, links checked. ${errors} broken link(s).`);
if (orphans.length) {
  console.log(`\n⚠ ${orphans.length} conceptual-orphan page(s) — no CONTENT page links to them, only a TOC (interconnection gap, not a failure):`);
  for (const f of orphans) console.log(`    ${relative(root, f)}`);
}
if (errors) { console.error(`\n${errors} broken internal link(s) — fix before shipping.`); process.exit(1); }
