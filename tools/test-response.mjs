// Response-core tests (W315, considerations iteration Burst 10 — owner note 7: "I really start to struggle once I get past
// 12 sets in one workout and once I get to 16 sets I'm pretty empty. The app should be able to learn this from my data.
// Other users will be different."). The learners are pure and deterministic: the binder passes the priors in.
import assert from "node:assert/strict";
import { sessionTolerance } from "./response-core.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

const day = (n) => new Date(Date.UTC(2026, 9, 1) + n * 86400000).toISOString();
const W = (extra = {}) => ({ exercise: "bench", set_type: "work", weight_kg: 60, reps: 8, ...extra });
// A workout of `n` work sets on day `d`, with optional fade marks / a feel answer / per-set extras.
const workout = (d, n, { marks = null, feel = null, set = {} } = {}) => ({ session_id: `s${d}`, date: day(d), sets: Array.from({ length: n }, () => W(set)),
  ...(marks ? { fade_marks: marks } : {}), ...(feel ? { feel } : {}) });
// Eight workouts two days apart, `fadeAt` the indexes that fade, built by `make`.
const eight = (make) => Array.from({ length: 8 }, (_, i) => make(i * 2, i));

check("#tolerance nothing logged, or a lifter who never fades: no ceiling to learn — it never moves", () => {
  assert.equal(sessionTolerance([], { prior: 16 }), null);
  assert.equal(sessionTolerance(eight((d) => workout(d, 18, { feel: "strong" })), { prior: 16 }), null);
  assert.equal(sessionTolerance(eight((d) => workout(d, 18)), { prior: 16 }), null);
});
check("#tolerance late skips at set 13 in 4 of the last 8: the ceiling is 13", () => {
  const s = eight((d, i) => workout(d, 18, i % 2 ? { marks: [{ kind: "skip", at: 13, of: 18 }] } : {}));
  assert.deepStrictEqual(sessionTolerance(s, { prior: 16 }), { cap: 13, fades: 4, eligible: 8, points: [13, 13, 13, 13] });
});
check("#tolerance an early skip isn't a fade (the last third of the planned sets only); an early end with work left and a too-tired moment are", () => {
  const early = eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 3, of: 18 }] }));
  assert.equal(sessionTolerance(early, { prior: 16 }), null, "skipped set 4 of 18: not fatigue");
  const ends = eight((d, i) => workout(d, 12, i < 3 ? { marks: [{ kind: "early", at: 12, of: 18 }] } : {}));
  assert.equal(sessionTolerance(ends, { prior: 16 })?.cap, 12);
  const tired = eight((d, i) => workout(d, 18, i < 4 ? { marks: [{ kind: "tired", at: 14, of: 18 }] } : {}));
  assert.equal(sessionTolerance(tired, { prior: 16 })?.cap, 14);
});
check("#tolerance 'fading' or 'empty' in the read-out: the fade began about the last few sets — the workout's sets less 2", () => {
  const s = eight((d, i) => workout(d, 16, i < 3 ? { feel: i === 0 ? "empty" : "fading" } : {}));
  assert.equal(sessionTolerance(s, { prior: 16 })?.cap, 14);
});
check("#tolerance two fades in eight is not a pattern; only the last 8 workouts that can show one count", () => {
  assert.equal(sessionTolerance(eight((d, i) => workout(d, 18, i < 2 ? { marks: [{ kind: "skip", at: 13, of: 18 }] } : {})), { prior: 16 }), null);
  const old = eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 13, of: 18 }] }));
  const recent = Array.from({ length: 8 }, (_, i) => workout(20 + i * 2, 18));
  assert.equal(sessionTolerance([...old, ...recent], { prior: 16 }), null, "the old fades are past the window");
});
check("#tolerance deload weeks, comebacks and estimate-heavy workouts don't count — their fades say nothing about the ceiling", () => {
  const deload = eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 13, of: 18 }], set: { deload: true } }));
  assert.equal(sessionTolerance(deload, { prior: 16 }), null, "every set planned easy: a deload week");
  const est = eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 13, of: 18 }], set: { est: ["reps"] } }));
  assert.equal(sessionTolerance(est, { prior: 16 }), null, "the numbers were guesses");
  const back = [workout(0, 18), workout(30, 18, { marks: [{ kind: "skip", at: 13, of: 18 }] }), workout(32, 18), workout(34, 18)];
  assert.equal(sessionTolerance(back, { prior: 16, minFades: 1 }), null, "the first workout back after a 30-day gap");
  const tiredLift = eight((d, i) => ({ ...workout(d, 18, i < 3 ? { marks: [{ kind: "tired", at: 13, of: 18 }] } : {}), sets: [...Array(13).fill(W()), ...Array(5).fill(W({ deload: true }))] }));
  assert.equal(sessionTolerance(tiredLift, { prior: 16 })?.cap, 13, "one tired-eased lift isn't a deload week");
});
check("#tolerance bounded: never under 10, never at or above the KB's own ceiling for the lifter (nothing to change there)", () => {
  assert.equal(sessionTolerance(eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 7, of: 9 }] })), { prior: 16 })?.cap, 10);
  assert.equal(sessionTolerance(eight((d) => workout(d, 20, { marks: [{ kind: "skip", at: 17, of: 20 }] })), { prior: 16 }), null, "fades past the KB ceiling: the ceiling already binds");
  assert.equal(sessionTolerance(eight((d) => workout(d, 20, { marks: [{ kind: "skip", at: 15, of: 20 }] })), { prior: 16 })?.cap, 15);
});
check("#tolerance deterministic: the same log, the same answer — in any input order", () => {
  const s = eight((d, i) => workout(d, 18, i % 2 ? { marks: [{ kind: "skip", at: 12 + (i % 3), of: 18 }] } : {}));
  const a = sessionTolerance(s, { prior: 16 }), b = sessionTolerance([...s].reverse(), { prior: 16 });
  assert.deepStrictEqual(a, b);
});

console.log(`\n${pass} response test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
