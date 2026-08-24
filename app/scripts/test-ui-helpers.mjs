// Pure UI helpers (app/public/ui-helpers.mjs) — the testable half of the Wave-244
// path shorteners. app.js itself cannot be imported under Node (top-level DOM), so
// anything with real logic lives here, red-first.
import assert from "node:assert/strict";
import { groupSessionsByWeek, mondayOf, weekLabelOf, seedCalendarDays, filterExercises, linePath } from "../public/ui-helpers.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

check("mondayOf: any day maps to its week's Monday, across month/year edges", () => {
  assert.equal(mondayOf("2026-08-19"), "2026-08-17"); // Wed → Mon
  assert.equal(mondayOf("2026-08-17"), "2026-08-17"); // Mon → itself
  assert.equal(mondayOf("2026-08-23"), "2026-08-17"); // Sun belongs to the week it ends
  assert.equal(mondayOf("2026-01-01"), "2025-12-29"); // year boundary
});

check("groupSessionsByWeek: groups in given order, null-calendar rows lead as their own group", () => {
  const cal = (s) => s.cal;
  const list = [
    { id: "q1", cal: null },                 // quarantined/unparseable — pinned
    { id: "a", cal: "2026-08-21" }, { id: "b", cal: "2026-08-19" },
    { id: "c", cal: "2026-08-14" },
  ];
  const g = groupSessionsByWeek(list, cal);
  assert.equal(g.length, 3);
  assert.equal(g[0].week, null);
  assert.deepEqual(g[0].sessions.map((s) => s.id), ["q1"]);
  assert.equal(g[1].week, "2026-08-17");
  assert.deepEqual(g[1].sessions.map((s) => s.id), ["a", "b"]);
  assert.equal(g[2].week, "2026-08-10");
});

check("weekLabelOf: readable, includes day and month", () => {
  assert.match(weekLabelOf("2026-08-17"), /Week of 17 Aug 2026/);
});

check("seedCalendarDays: commitment wins, else stored, else empty — Monday-0 indices", () => {
  assert.deepEqual(seedCalendarDays(["mon", "wed", "fri"], [5]), [0, 2, 4]);
  assert.deepEqual(seedCalendarDays(null, [1, 3]), [1, 3]);
  assert.deepEqual(seedCalendarDays(undefined, undefined), []);
  assert.deepEqual(seedCalendarDays([], [6]), [6]); // empty commitment = no signal
  assert.deepEqual(seedCalendarDays(["sun"], null), [6]);
  // hostile stored values never produce out-of-range indices
  assert.deepEqual(seedCalendarDays(null, [9, -1, "x", 2]), [2]);
});

check("filterExercises: name, muscle and equipment substrings; empty query returns all", () => {
  const list = [
    { name: "Barbell Bench Press", primary_muscles: ["chest"], equipment: "barbell" },
    { name: "Seated Leg Curl", primary_muscles: ["hamstrings"], equipment: "machine" },
  ];
  assert.equal(filterExercises(list, "").length, 2);
  assert.deepEqual(filterExercises(list, "bench").map((e) => e.name), ["Barbell Bench Press"]);
  assert.deepEqual(filterExercises(list, "HAMSTR").map((e) => e.name), ["Seated Leg Curl"]);
  assert.deepEqual(filterExercises(list, "machine").map((e) => e.name), ["Seated Leg Curl"]);
  assert.equal(filterExercises(list, "zzz").length, 0);
});

check("linePath: spreads x across the width, inverts y, pads, and centers a flat series", () => {
  const { pts, min, max } = linePath([80, 82, 81], 100, 50, 5);
  assert.equal(pts.length, 3);
  assert.equal(pts[0][0], 5); assert.equal(pts[2][0], 95);            // x spread pad..w-pad
  assert.ok(pts[1][1] < pts[0][1] && pts[1][1] < pts[2][1]);          // higher value = smaller y (SVG)
  assert.equal(min, 80); assert.equal(max, 82);
  assert.ok(pts.every(([x, y]) => y >= 5 && y <= 45));                // padded frame
  const flat = linePath([70, 70], 100, 50, 5);
  assert.ok(flat.pts.every(([, y]) => y === 25), "a flat series draws at the midline, never divides by zero");
  assert.deepEqual(linePath([], 100, 50).pts, []);
  assert.deepEqual(linePath([80], 100, 50, 5).pts, [[50, 25]], "a single point centers");
});

console.log(`\n${pass} ui-helper test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
