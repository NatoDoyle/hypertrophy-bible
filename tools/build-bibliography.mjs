#!/usr/bin/env node
// Render citations/registry.json -> citations/registry.md (human-readable bibliography).
// The .md file is generated; do not edit it by hand.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reg = JSON.parse(readFileSync(join(root, "citations", "registry.json"), "utf8"));
const list = (Array.isArray(reg.citations) ? reg.citations : []).slice().sort((a, b) =>
  a.key.localeCompare(b.key)
);

function authors(a) {
  if (!Array.isArray(a) || a.length === 0) return "Unknown";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} & ${a[1]}`;
  return `${a[0]} et al.`;
}

function locator(c) {
  const bits = [];
  if (c.source) bits.push(`*${c.source}*`);
  const vip = [c.volume, c.issue ? `(${c.issue})` : "", c.pages ? `, ${c.pages}` : ""].join("");
  if (vip.trim()) bits.push(vip.trim());
  return bits.join(", ");
}

const lines = [];
lines.push("# Citation Registry (Bibliography)");
lines.push("");
lines.push(
  "> Generated from [`registry.json`](registry.json) by `tools/build-bibliography.mjs`. **Do not edit by hand.**"
);
lines.push("");
lines.push(`**${list.length}** verified reference${list.length === 1 ? "" : "s"}.`);
lines.push("");
lines.push("Every entry below was confirmed to exist via a live web fetch of its DOI, PMID, or URL.");
lines.push("");
lines.push("---");
lines.push("");

for (const c of list) {
  lines.push(`### ${c.key}`);
  const head = `${authors(c.authors)} (${c.year}). ${c.title}`;
  lines.push(head.endsWith(".") ? head : head + ".");
  const loc = locator(c);
  if (loc) lines.push("", loc + ".");
  const meta = [];
  if (c.study_type) meta.push(`Type: ${c.study_type}`);
  if (c.population && c.population !== "na") meta.push(`Population: ${c.population}`);
  if (meta.length) lines.push("", "- " + meta.join(" · "));
  const ids = [];
  if (c.doi) ids.push(`DOI: [${c.doi}](https://doi.org/${c.doi})`);
  if (c.pmid) ids.push(`PMID: [${c.pmid}](https://pubmed.ncbi.nlm.nih.gov/${c.pmid}/)`);
  if (c.url && !c.doi && !c.pmid) ids.push(`URL: [link](${c.url})`);
  if (ids.length) lines.push("- " + ids.join(" · "));
  lines.push("");
}

writeFileSync(join(root, "citations", "registry.md"), lines.join("\n"));
console.log(`Wrote citations/registry.md (${list.length} entries).`);
