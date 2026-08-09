// Unit tests for the prose-recommends-a-liftable-movement gate (movement-core.mjs).
// The load-bearing assertions: the original incident class ("low-to-high cable
// fly") FLAGS even though a shorter suffix ("cable fly") resolves via alias — no
// suffix fallback, ever — and the gate's product decisions (enforcement on, the
// escape hatches stale-checked) are literal-pinned so a silent flip fails a test
// (lesson 42).
import assert from "node:assert/strict";
import {
  normPhrase, tokenize, checkMovements, extractorBlindSpot,
  MOVEMENT_ALIASES, MOVEMENT_GENERIC_OK, MOVEMENT_GATE,
} from "./movement-core.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const EX = [
  { id: "cable-crossover", name: "Cable Crossover" },
  { id: "barbell-row", name: "Barbell Row" },
  { id: "barbell-back-squat", name: "Barbell Back Squat" },
  { id: "back-extension", name: "Back Extension" },
  { id: "romanian-deadlift", name: "Romanian Deadlift" },
  { id: "good-morning", name: "Good Morning" },
];
const page = (md) => [{ slug: "t/fixture", md }];

check("the incident class flags: a specific unprogrammable movement in plain prose", () => {
  const r = checkMovements(page("Finish with a low-to-high cable fly for the upper chest."), EX,
    { aliases: new Map([["cable fly", "cable-crossover"]]), genericOk: new Map() });
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].phrase, "low-to-high cable fly");
});

check("NO suffix fallback: the alias for 'cable fly' must not excuse the longer phrase", () => {
  // Same fixture as above — the point stated as its own test: resolution is
  // whole-phrase only, so a resolvable suffix is irrelevant.
  const aliases = new Map([["cable fly", "cable-crossover"]]);
  const hit = checkMovements(page("Do a cable fly."), EX, { aliases, genericOk: new Map() });
  assert.equal(hit.flagged.length, 0, "the exact alias phrase itself resolves");
  const miss = checkMovements(page("Do a low-to-high cable fly."), EX, { aliases, genericOk: new Map() });
  assert.equal(miss.flagged.length, 1, "the extended phrase must still flag");
});

check("a degree adjective stops the phrase: 'a heavy barbell row' resolves", () => {
  const r = checkMovements(page("Start with a heavy barbell row, then accessories."), EX,
    { aliases: new Map(), genericOk: new Map() });
  assert.equal(r.flagged.length, 0);
});

check("bare head nouns are category prose, never flagged", () => {
  const r = checkMovements(page("Every week do one vertical pull, a row, and a press."), EX,
    { aliases: new Map(), genericOk: new Map() });
  assert.equal(r.flagged.length, 0);
});

check("anatomy pairs are jobs, not movements: 'shoulder extension' passes, 'back extension' resolves", () => {
  const r = checkMovements(page("Job: shoulder extension and adduction. Add a back extension if the erectors lag."), EX,
    { aliases: new Map(), genericOk: new Map() });
  assert.equal(r.flagged.length, 0);
});

check("linked picks are excluded — the link gates own them", () => {
  const r = checkMovements(page("Try the [low-to-high cable fly](../../data/exercises/nope.json) today."), EX,
    { aliases: new Map(), genericOk: new Map() });
  assert.equal(r.flagged.length, 0);
});

check("plurals normalize: 'barbell back squats' and 'Romanian deadlifts' resolve by name", () => {
  const r = checkMovements(page("Program barbell back squats and Romanian deadlifts weekly."), EX,
    { aliases: new Map(), genericOk: new Map() });
  assert.equal(r.flagged.length, 0);
});

check("a dangling alias fails, and an unused alias reads as stale", () => {
  const r = checkMovements(page("Nothing relevant here."), EX, {
    aliases: new Map([["ghost press", "no-such-id"], ["unused row", "barbell-row"]]),
    genericOk: new Map([["unused fly", "justification long enough to satisfy the contract here"]]),
  });
  assert.equal(r.dangling.length, 1);
  assert.deepEqual(r.staleAliases, ["unused row"]);
  assert.deepEqual(r.staleGeneric, ["unused fly"]);
});

check("the blind spot is reported: names ending in no head noun are counted, not hidden", () => {
  assert.ok(extractorBlindSpot(EX).includes("good-morning"));
});

check("the shipped maps are corpus-clean: no dangling targets (validated against real data in check-movements)", () => {
  // The CLI validates against the real exercise list; here we pin the CONTRACTS:
  for (const [, why] of MOVEMENT_GENERIC_OK) {
    assert.ok(typeof why === "string" && why.length >= 40, "every generic entry needs a real justification");
  }
  for (const [name, id] of MOVEMENT_ALIASES) {
    assert.ok(/^[a-z0-9-]+$/.test(id), `alias "${name}" must map to an id, not prose`);
    assert.notEqual(normPhrase(name), normPhrase(id.replace(/-/g, " ")), `alias "${name}" merely shadows its own id`);
  }
});

check("MOVEMENT_GATE is ENFORCED — a silent flip back to warn fails here (lesson 42)", () => {
  assert.equal(MOVEMENT_GATE.warnOnly, false);
});

check("tokenizer: slashes split alternation lists into separate phrases", () => {
  assert.deepEqual(tokenize("incline/behind-the-body curls").filter((t) => t !== "¶"),
    ["incline", "behind-the-body", "curl"]);
  const r = checkMovements(page("Use incline/behind-the-body curls."), EX, {
    aliases: new Map(), genericOk: new Map([["behind-the-body curl", "a position family, justified at proper length here"]]),
  });
  // "incline" is orphaned before the slash boundary and forms no candidate;
  // "behind-the-body curl" is generic-ok — so nothing flags.
  assert.equal(r.flagged.length, 0);
});

console.log(`${passed} movement test(s) passed.`);
