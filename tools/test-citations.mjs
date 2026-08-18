#!/usr/bin/env node
// Unit coverage for the reference/definition rule the citation gate enforces.
// check-citations.mjs had no tests at all, which is how an exclusion rule that
// silently disarmed the "never fabricate a citation" guardrail survived ten waves
// while the gate printed a green summary every run.
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { definitionKeys, referenceKeys } from "./citation-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); }
};

// The exact shape that disarmed the guardrail. A colon is ordinary prose
// punctuation — it introduces a list, a definition, a quote — so a rule that
// treats "followed by a colon" as "is a definition" makes citations invisible in
// some of the most natural sentences an author writes.
check("a marker followed by a prose colon is a REFERENCE, not a definition", () => {
  const md = "The consensus distinguishes three states[^meeusen-2013]:\n\n- one\n- two\n";
  assert.deepEqual([...referenceKeys(md)], ["meeusen-2013"]);
  assert.deepEqual([...definitionKeys(md)], []);
});

// THE assertion this file exists for. If this ever goes green-by-accident again,
// a fabricated source can enter the KB unchallenged.
check("a FABRICATED key followed by a colon is visible to the gate (the guardrail hole)", () => {
  const md = "Three states[^totally-fake-key]: one, two.\n";
  const refs = referenceKeys(md);
  assert.ok(refs.has("totally-fake-key"), "the dangling-reference check can only fire on what it can see");
  // ...and the rule that hid it is stated here so the mistake is not reinvented.
  const OLD_BROKEN_RULE = /\[\^([^\]]+)\](?!:)/g;
  assert.equal([...md.matchAll(OLD_BROKEN_RULE)].length, 0,
    "documenting the defect: the previous rule matched nothing here, so neither the dangling nor the missing-definition error could fire");
});

check("a definition line is a definition and NOT also a reference", () => {
  const md = "[^smith-2020]: Smith J (2020). *A title: with a colon.* DOI: 10.1/x.\n";
  assert.deepEqual([...definitionKeys(md)], ["smith-2020"]);
  assert.deepEqual([...referenceKeys(md)], [], "the definition's own marker must not count as a use");
});

check("a definition whose TEXT contains further colons or markers stays one definition", () => {
  const md = "Body cites[^a].\n\n[^a]: Author A (2020). *Title: subtitle.* See also [^b] discussion.\n[^b]: Author B (2021).\n";
  assert.deepEqual([...definitionKeys(md)].sort(), ["a", "b"]);
  // `[^b]` inside a's definition text is part of the definition LINE, so it is not
  // a prose use — the reference scan removes whole definition lines rather than
  // trying to reason about what follows each marker.
  assert.deepEqual([...referenceKeys(md)], ["a"]);
});

check("indented definitions still register (list-nested references)", () => {
  const md = "  [^c]: Author C (2022).\n";
  assert.deepEqual([...definitionKeys(md)], ["c"]);
  assert.deepEqual([...referenceKeys(md)], []);
});

check("multiple markers in one sentence, one of them colon-terminated", () => {
  const md = "Both trials[^a][^b] agree on this[^c]: more is better.\n";
  assert.deepEqual([...referenceKeys(md)].sort(), ["a", "b", "c"]);
});

// Corpus-level: the rule has to hold over the real KB, not just fixtures.
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : (p.endsWith(".md") ? [p] : []);
});
check("every reference in content/ has a definition on its own page", () => {
  const offenders = [];
  for (const file of walk(join(root, "content"))) {
    const text = readFileSync(file, "utf8");
    const defs = definitionKeys(text);
    for (const k of referenceKeys(text)) if (!defs.has(k)) offenders.push(`${relative(root, file)}: [^${k}]`);
  }
  assert.deepEqual(offenders, []);
});
check("the registry has no orphans — the count the false warning used to spoil", () => {
  const reg = JSON.parse(readFileSync(join(root, "citations", "registry.json"), "utf8"));
  const keys = new Set((reg.citations ?? []).map((c) => c.key));
  const used = new Set();
  for (const file of walk(join(root, "content"))) for (const k of referenceKeys(readFileSync(file, "utf8"))) used.add(k);
  for (const file of walk(join(root, "data"))) {
    if (!file.endsWith(".json") || file.includes("schemas")) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/"([a-z0-9][a-z0-9-]*)"/g)) if (keys.has(m[1])) used.add(m[1]);
  }
  const orphans = [...keys].filter((k) => !used.has(k));
  assert.deepEqual(orphans, [], "an entry nothing cites is either a drafting leftover or a reference the gate cannot see");
});

console.log(`\n${pass} citation test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
