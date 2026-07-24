#!/usr/bin/env node
// Claim-coverage gate (Goal 1: "every claim web-verified" — make it MEASURABLE).
//
// FAILS (exit 1) when a content page makes a [Grade A] or [Grade B] claim but carries
// ZERO [^footnote] citations. A graded claim with no visible evidence is exactly the gap
// between "looks authoritative" and "is authoritative"; this catches the worst case — a
// fully-uncited graded page — and stops it regressing as new pages ship.
//
// ALLOWLIST: plain-language on-ramp / synthesis pages whose graded claims are the SAME
// claims cited on the dedicated evidence pages they explicitly link to ("See [Volume]").
// Citing by reference is legitimate for an overview — but a NEW page not on this list must
// carry its own citation. Keep this list SHORT and each entry justified.
//
// (Deeper coverage — every individual claim sitting near its own citation — is Tier-2
// completeness work, docs/roadmap.md #6. This gate is the floor, not the ceiling.)

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

// Plain-language getting-started pages that cite by reference (each graded claim links
// to its dedicated, fully-cited evidence page). Justified, and deliberately short.
const ALLOWLIST = new Set([
  "content/09-getting-started/what-actually-matters.md",   // priority-hierarchy synthesis; every rung links "See [dedicated cited page]"
  "content/09-getting-started/starting-out-as-a-woman.md", // beginner on-ramp; its one protein claim is the cited protein.md claim, restated plainly
]);

const files = walk(join(root, "content"), (p) => p.endsWith(".md"));
const offenders = [];
for (const f of files) {
  const rel = relative(root, f).split("\\").join("/"); // forward-slash for stable matching
  const t = readFileSync(f, "utf8");
  const graded = (t.match(/\[Grade [AB]\]/g) || []).length;
  const refs = new Set([...t.matchAll(/\[\^([a-z0-9-]+)\]/g)].map((m) => m[1])).size;
  if (graded > 0 && refs === 0 && !ALLOWLIST.has(rel)) offenders.push({ rel, graded });
}

if (offenders.length) {
  console.error(`claim-coverage: ${offenders.length} page(s) make Grade A/B claims with ZERO citations:`);
  for (const o of offenders) console.error(`  - ${o.rel} (${o.graded} graded claim(s), 0 citations)`);
  console.error(`Fix: add a [^footnote] citation (web-verified in citations/registry.json). If it's a plain-language`);
  console.error(`synthesis page that links to its cited source, add it to the ALLOWLIST in tools/check-claim-coverage.mjs`);
  console.error(`with a one-line justification.`);
  process.exit(1);
}
console.log(`claim-coverage: ${files.length} content pages checked; ${ALLOWLIST.size} allowlisted synthesis page(s); 0 uncited graded pages.`);
