// Unit tests for the pure movement-demo mapping (public/movement-demo.mjs) — the
// v0 inline line-art stand-in for real per-exercise footage (BLOCKERS.md #1).
// Exists to catch exactly the "declared-but-unused"/"enum drift" class of bug:
// if the exercise schema ever grows a new movement_pattern, this fails loudly
// instead of that pattern silently falling through to the generic pulse fallback.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MOVEMENT_DEMO, EXERCISE_DEMO, renderMovementDemo } from "../public/movement-demo.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); } };

const schemaPath = fileURLToPath(new URL("../../data/schemas/exercise.schema.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const patternEnum = schema.properties.movement_pattern.enum;

check("every movement_pattern in the exercise schema has a MOVEMENT_DEMO entry", () => {
  const missing = patternEnum.filter((p) => !MOVEMENT_DEMO[p]);
  assert.deepStrictEqual(missing, []);
});

check("MOVEMENT_DEMO has no stale entries outside the schema enum", () => {
  const stale = Object.keys(MOVEMENT_DEMO).filter((p) => !patternEnum.includes(p));
  assert.deepStrictEqual(stale, []);
});

check("every entry is a [kind, caption] pair with a known kind and non-empty caption", () => {
  const KNOWN_KINDS = new Set(["bounce", "side", "bend", "pulse"]);
  for (const [pattern, [kind, caption]] of Object.entries(MOVEMENT_DEMO)) {
    assert.ok(KNOWN_KINDS.has(kind), `${pattern} has unknown kind "${kind}"`);
    assert.ok(caption && caption.length > 5, `${pattern} caption is too short/empty`);
  }
});

check("renderMovementDemo renders an SVG + the exact caption for a known pattern", () => {
  const html = renderMovementDemo("squat");
  assert.ok(html.includes("<svg"), "no <svg> in output");
  assert.ok(html.includes(MOVEMENT_DEMO.squat[1]), "caption missing from output");
});

check("renderMovementDemo falls back to 'other' for an unknown/missing pattern (never throws, never empty)", () => {
  for (const bad of [undefined, null, "", "not-a-real-pattern"]) {
    const html = renderMovementDemo(bad);
    assert.ok(html.includes("<svg"));
    assert.ok(html.includes(MOVEMENT_DEMO.other[1]));
  }
});

// W283: a pattern's words don't fit every lift in it — a Jefferson curl rolls DOWN through the
// spine, a hanging leg raise curls the hips, an ab-wheel rollout resists extension.
check("W283 per-exercise captions where the pattern's words don't fit; every other lift keeps its pattern's", () => {
  assert.match(renderMovementDemo("isolation-spinal-flexion", "jefferson-curl"), /Roll down one vertebra at a time/);
  assert.match(renderMovementDemo("isolation-spinal-flexion", "cable-crunch"), /Curl your torso in/);
  assert.match(renderMovementDemo("isolation-spinal-flexion"), /Curl your torso in/);
  for (const [id, entry] of Object.entries(EXERCISE_DEMO)) {
    const ex = JSON.parse(readFileSync(new URL(`../../data/exercises/${id}.json`, import.meta.url), "utf8"));
    assert.ok(ex.id === id && Array.isArray(entry) && entry.length === 2 && entry[1].length > 10, id);
  }
  assert.deepStrictEqual(Object.keys(EXERCISE_DEMO).sort(), ["ab-wheel-rollout", "hanging-leg-raise", "jefferson-curl"]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
