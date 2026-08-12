// The prose-recommends-a-liftable-movement gate (Tier-1 #1, Wave 204).
//
// Every SPECIFIC movement a content page names in plain prose must resolve to a
// real data/exercises id (directly, via MOVEMENT_ALIASES, or as a justified
// MOVEMENT_GENERIC_OK category) — the chest.md "low-to-high cable fly" incident
// class, enforced instead of remembered. Linked picks are check-links' job and are
// excluded here. All logic lives in movement-core.mjs; this file is the loader,
// the report, and the exit code.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkMovements, extractorBlindSpot, MOVEMENT_GATE, MOVEMENT_ALIASES, MOVEMENT_GENERIC_OK,
} from "./movement-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(root, "content");
const EXERCISES = join(root, "data", "exercises");

const pages = [];
for (const pillar of readdirSync(CONTENT)) {
  const dir = join(CONTENT, pillar);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name === "index.md") continue;   // index pages are TOCs, not prose
    pages.push({ slug: `${pillar}/${basename(name, ".md")}`, md: readFileSync(join(dir, name), "utf8") });
  }
}
const exercises = readdirSync(EXERCISES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(EXERCISES, f), "utf8")));

const r = checkMovements(pages, exercises);
const blind = extractorBlindSpot(exercises);

console.log(`movements: ${pages.length} pages scanned against ${exercises.length} exercises.`);
console.log(`  ${r.candidates} modifier+noun phrases found; ${r.resolved} resolve (names/ids, ${MOVEMENT_ALIASES.size} aliases, ${MOVEMENT_GENERIC_OK.size} generic-category entries).`);
// Lesson 35: a gate that narrows its input must report the narrowing as a count.
console.log(`  blind spot: ${blind.length}/${exercises.length} exercise names the extractor could never see and resolve in prose (no reachable head noun).`);

const fail = [];
if (r.dangling.length) {
  fail.push(`${r.dangling.length} alias(es) point at a nonexistent exercise id:`);
  for (const [name, id] of r.dangling) fail.push(`    "${name}" -> ${id}`);
}
if (r.staleAliases.length) {
  fail.push(`${r.staleAliases.length} stale alias(es) — no page uses them, remove them (the escape hatch must not quietly widen):`);
  for (const n of r.staleAliases) fail.push(`    "${n}"`);
}
if (r.staleGeneric.length) {
  fail.push(`${r.staleGeneric.length} stale generic-category entr(ies) — no page uses them, remove them:`);
  for (const p of r.staleGeneric) fail.push(`    "${p}"`);
}

if (r.flagged.length) {
  console.log(`  ⚠ ${r.flagged.length} unresolvable movement phrase(s) — prose recommends what the app cannot program:`);
  for (const f of r.flagged.sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
    console.log(`      ${f.slug} — "${f.phrase}"${f.count > 1 ? ` ×${f.count}` : ""}`);
  }
} else {
  console.log(`  ✓ every specific movement the prose recommends resolves to a programmable exercise.`);
}
for (const line of fail) console.log(`  ✗ ${line}`);

const failing = fail.length > 0 || (!MOVEMENT_GATE.warnOnly && r.flagged.length > 0);
console.log(`${r.flagged.length} flagged phrase(s)${MOVEMENT_GATE.warnOnly ? " — advisory, not blocking (MOVEMENT_GATE.warnOnly)" : failing ? " — FAILING" : " — gate ENFORCED and green"}.`);
process.exit(failing ? 1 : 0);
