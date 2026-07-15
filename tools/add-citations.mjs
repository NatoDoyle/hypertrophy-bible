#!/usr/bin/env node
// Merge new citation objects into citations/registry.json (dedupe by key, keep sorted).
// Usage: node tools/add-citations.mjs <path-to-json>  (file is an array of citation objects)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const regPath = join(root, "citations", "registry.json");
const inPath = process.argv[2];
if (!inPath) {
  console.error("usage: node tools/add-citations.mjs <new-citations.json>");
  process.exit(2);
}

const reg = JSON.parse(readFileSync(regPath, "utf8"));
const incoming = JSON.parse(readFileSync(inPath, "utf8"));
const list = Array.isArray(incoming) ? incoming : incoming.citations;

const byKey = new Map(reg.citations.map((c) => [c.key, c]));
let added = 0;
let updated = 0;
for (const c of list) {
  if (byKey.has(c.key)) updated++;
  else added++;
  byKey.set(c.key, c);
}
const merged = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
writeFileSync(regPath, JSON.stringify({ citations: merged }, null, 2) + "\n");
console.log(`Merged: +${added} added, ${updated} updated, ${merged.length} total.`);
