#!/usr/bin/env node
// Enforce citation referential integrity across prose and data.
//
// FAILS (exit 1) on:
//   - a [^key] used in prose with no matching registry entry            (dangling reference)
//   - a citations[] key in a data file with no matching registry entry  (dangling reference)
//   - a [^key] used on a page with no footnote definition on that page  (won't render)
//   - a registry entry missing a resolvable id (doi/pmid/url) or verified!==true
//   - duplicate keys in the registry
// WARNS (no failure) on:
//   - a registry entry never referenced anywhere                        (orphan)

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, pred) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}

// --- Registry ---------------------------------------------------------------
const reg = JSON.parse(readFileSync(join(root, "citations", "registry.json"), "utf8"));
const registryList = Array.isArray(reg.citations) ? reg.citations : [];
const registryKeys = new Set();
let errors = 0;
const warn = [];

for (const c of registryList) {
  if (registryKeys.has(c.key)) {
    console.error(`  ✗ duplicate registry key: ${c.key}`);
    errors++;
  }
  registryKeys.add(c.key);
  if (!(c.doi || c.pmid || c.url)) {
    console.error(`  ✗ registry '${c.key}' has no doi/pmid/url`);
    errors++;
  }
  if (c.verified !== true) {
    console.error(`  ✗ registry '${c.key}' is not verified (verified !== true)`);
    errors++;
  }
}

// --- Prose references -------------------------------------------------------
const usedKeys = new Set();
const refRe = /\[\^([^\]]+)\](?!:)/g; // reference, not a definition
const defRe = /^\s*\[\^([^\]]+)\]:/gm; // definition line

for (const file of walk(join(root, "content"), (p) => p.endsWith(".md"))) {
  const text = readFileSync(file, "utf8");
  const rel = relative(root, file);
  const refs = new Set([...text.matchAll(refRe)].map((m) => m[1]));
  const defs = new Set([...text.matchAll(defRe)].map((m) => m[1]));
  for (const k of refs) {
    usedKeys.add(k);
    if (!registryKeys.has(k)) {
      console.error(`  ✗ ${rel}: [^${k}] not in registry (dangling)`);
      errors++;
    }
    if (!defs.has(k)) {
      console.error(`  ✗ ${rel}: [^${k}] used but has no footnote definition on the page`);
      errors++;
    }
  }
}

// --- Data references --------------------------------------------------------
for (const file of walk(join(root, "data"), (p) => p.endsWith(".json") && !p.includes("schemas"))) {
  const text = readFileSync(file, "utf8");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    continue;
  }
  const rel = relative(root, file);
  for (const k of collectCitationKeys(json)) {
    usedKeys.add(k);
    if (!registryKeys.has(k)) {
      console.error(`  ✗ ${rel}: citation '${k}' not in registry (dangling)`);
      errors++;
    }
  }
}

function collectCitationKeys(node, acc = []) {
  if (Array.isArray(node)) {
    for (const v of node) collectCitationKeys(v, acc);
  } else if (node && typeof node === "object") {
    for (const [key, val] of Object.entries(node)) {
      if (key === "citations" && Array.isArray(val)) acc.push(...val.filter((x) => typeof x === "string"));
      else collectCitationKeys(val, acc);
    }
  }
  return acc;
}

// --- Orphans (warn only) ----------------------------------------------------
for (const k of registryKeys) {
  if (!usedKeys.has(k)) warn.push(`  ⚠ registry '${k}' is never referenced (orphan)`);
}
// --- Published bibliography staleness (error) --------------------------------
// citations/registry.md is generated from registry.json; a registry entry
// missing from the published bibliography means someone forgot `npm run
// build-bib` (this shipped: 87 vs 88, missing a load-bearing Maeo 2021 entry).
try {
  const bib = readFileSync(new URL("../citations/registry.md", import.meta.url), "utf8");
  for (const k of registryKeys) {
    if (!bib.includes(k)) { console.error(`  ✗ citations/registry.md is stale — missing '${k}'. Run: npm run build-bib`); errors++; }
  }
} catch { console.error("  ✗ citations/registry.md missing. Run: npm run build-bib"); errors++; }

for (const w of warn) console.warn(w);

const entryWord = registryKeys.size === 1 ? "entry" : "entries";
console.log(
  `\n${registryKeys.size} registry ${entryWord}, ${usedKeys.size} referenced. ${errors} error(s), ${warn.length} warning(s).`
);
process.exit(errors ? 1 : 0);
