#!/usr/bin/env node
// Unit tests for the derive-metrics engine. Controlled inline fixtures with
// hand-computed expected values. Zero dependencies (node:assert). Exit non-zero on failure.

import assert from "node:assert/strict";
import {
  estimate1RM,
  countsForE1RM,
  RELIABLE_1RM_REPS,
  stallDetect,
  isoWeekKey,
  isHardSet,
  perMuscleWeeklyVolume,
  volumeVsLandmarks,
  volumeResponse,
  bodyweightTrend,
  classifyEnergyBalance,
  progressionByExercise,
  proximityFromRepDropoff,
  restTimes,
  readinessIndex,
} from "./derive-metrics.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// A tiny controlled exercise->muscle map (independent of the real DB).
const exIndex = new Map([
  ["bench", { name: "Bench", primary: ["chest"], secondary: ["front-delts", "triceps"] }],
  ["row", { name: "Row", primary: ["upper-back", "lats"], secondary: ["biceps"] }],
]);
const muscleIndex = new Map([
  ["chest", { unit: "weekly_hard_sets", mev: { min: 8, max: 10 }, mav: { min: 12, max: 18 }, mrv: { min: 20, max: 22 } }],
]);

check("estimate1RM Epley + single-rep", () => {
  assert.equal(estimate1RM(100, 5).e1rm, 116.67);
  assert.equal(estimate1RM(100, 1).e1rm, 100);
  assert.equal(estimate1RM(100, 5).confidence, "high");
  assert.equal(estimate1RM(100, 20).confidence, "low");
});

check("isHardSet gates warmups and sub-threshold effort", () => {
  assert.equal(isHardSet({ set_type: "warmup", rpe: 9 }), false);
  assert.equal(isHardSet({ set_type: "work", rpe: 8 }), true);
  assert.equal(isHardSet({ set_type: "work", rpe: 6 }), false); // too easy
  assert.equal(isHardSet({ set_type: "work", rir: 5 }), false); // too far from failure
  assert.equal(isHardSet({ set_type: "work" }), true); // no effort logged -> counts
});

check("isoWeekKey groups by ISO week", () => {
  assert.equal(isoWeekKey("2026-06-01T18:00:00Z"), isoWeekKey("2026-06-03T18:00:00Z"));
  assert.notEqual(isoWeekKey("2026-06-03T18:00:00Z"), isoWeekKey("2026-06-10T18:00:00Z"));
});

check("perMuscleWeeklyVolume: primary=1, secondary=0.5, warmups excluded", () => {
  const sessions = [{
    date: "2026-06-01T18:00:00Z",
    sets: [
      { exercise: "bench", set_type: "warmup", weight_kg: 60, reps: 8 },
      { exercise: "bench", set_type: "work", weight_kg: 100, reps: 8, rpe: 8 },
      { exercise: "bench", set_type: "work", weight_kg: 100, reps: 8, rpe: 8 },
      { exercise: "bench", set_type: "work", weight_kg: 100, reps: 8, rpe: 9 },
    ],
  }];
  const wk = isoWeekKey("2026-06-01T18:00:00Z");
  const vol = perMuscleWeeklyVolume(sessions, exIndex);
  assert.equal(vol[wk].chest, 3); // 3 hard sets, warmup excluded
  assert.equal(vol[wk]["front-delts"], 1.5); // secondary 0.5 x3
  assert.equal(vol[wk].triceps, 1.5);
});

check("perMuscleWeeklyVolume: unknown exercise skipped, not guessed", () => {
  const sessions = [{ date: "2026-06-01T18:00:00Z", sets: [{ exercise: "made-up", set_type: "work", weight_kg: 50, reps: 10 }] }];
  const vol = perMuscleWeeklyVolume(sessions, exIndex);
  const wk = isoWeekKey("2026-06-01T18:00:00Z");
  assert.deepEqual(vol[wk], {});
});

check("volumeVsLandmarks ties volume to KB MEV/MAV/MRV", () => {
  assert.equal(volumeVsLandmarks({ chest: 3 }, muscleIndex).chest.status, "below-MEV");
  assert.equal(volumeVsLandmarks({ chest: 14 }, muscleIndex).chest.status, "in-productive-range");
  assert.equal(volumeVsLandmarks({ chest: 25 }, muscleIndex).chest.status, "over-MRV");
  assert.equal(volumeVsLandmarks({ chest: 19 }, muscleIndex).chest.status, "approaching-MRV");
});

check("bodyweightTrend regresses ~0.5 kg/week", () => {
  const series = [
    { date: "2026-06-01", bodyweight_kg: 80.0 },
    { date: "2026-06-08", bodyweight_kg: 80.5 },
    { date: "2026-06-15", bodyweight_kg: 81.0 },
    { date: "2026-06-22", bodyweight_kg: 81.5 },
    { date: "2026-06-29", bodyweight_kg: 82.0 },
  ];
  const t = bodyweightTrend(series);
  assert.ok(Math.abs(t.slope_kg_per_week - 0.5) < 0.01, `slope ${t.slope_kg_per_week}`);
});

check("classifyEnergyBalance from weight trend + goal (no calories)", () => {
  const gaining = { pct_per_week: 0.3 };
  assert.equal(classifyEnergyBalance(gaining, "hypertrophy").direction, "surplus");
  assert.equal(classifyEnergyBalance(gaining, "hypertrophy").matchesGoal, true);
  const losing = { pct_per_week: -0.4 };
  assert.equal(classifyEnergyBalance(losing, "hypertrophy").matchesGoal, false); // wrong way for muscle gain
  assert.equal(classifyEnergyBalance(losing, "fat-loss").matchesGoal, true);
  assert.equal(classifyEnergyBalance({ pct_per_week: 0.0 }, "recomposition").direction, "maintenance");
});

check("progressionByExercise ignores unreliable high-rep sets (no fake strength gains)", () => {
  // A light 20-rep back-off set must NOT register as strength over a heavier triple —
  // this screen has to agree with the session recap's PR logic (both use countsForE1RM).
  const sessions = [
    { date: "2026-06-01T18:00:00Z", sets: [{ exercise: "bench", set_type: "work", weight_kg: 45, reps: 3 }] },
    { date: "2026-06-08T18:00:00Z", sets: [{ exercise: "bench", set_type: "work", weight_kg: 32, reps: 20 }] },
  ];
  const p = progressionByExercise(sessions, exIndex).find((x) => x.exercise === "bench");
  assert.equal(p.weeks, 1);            // week 2 contributed nothing
  assert.equal(p.change_pct, 0);       // and certainly not a "gain"
  assert.equal(p.last_e1rm, 49.5);     // still the real 45x3
});

check("#3 progressionByExercise excludes the deload week (no fabricated regression)", () => {
  // A real +8% block that ENDS on a purposely-eased deload week. The trend must
  // read the last WORKING week (108), not the lighter deload (100) — else the
  // Progress screen shows a strength LOSS on the recovery week.
  const wk = (n, kg, extra = {}) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString(), sets: [{ exercise: "bench", set_type: "work", weight_kg: kg, reps: 5, ...extra }] });
  const block = [wk(0, 100), wk(1, 103), wk(2, 105), wk(3, 108), wk(4, 100, { deload: true })];
  const p = progressionByExercise(block, exIndex).find((x) => x.exercise === "bench");
  assert.equal(p.weeks, 4);                    // the deload week is not counted
  assert.ok(p.change_pct > 0, `expected a gain, got ${p.change_pct}%`); // real progress, never a fake loss
  // last reflects the top working week (108x5), not the eased 100x5
  assert.equal(p.last_e1rm, estimate1RM(108, 5).e1rm);
});

check("countsForE1RM gates warmups, high reps, and junk", () => {
  assert.equal(countsForE1RM({ set_type: "work", weight_kg: 100, reps: 5 }), true);
  assert.equal(countsForE1RM({ set_type: "work", weight_kg: 100, reps: RELIABLE_1RM_REPS }), true);
  assert.equal(countsForE1RM({ set_type: "work", weight_kg: 100, reps: RELIABLE_1RM_REPS + 1 }), false);
  assert.equal(countsForE1RM({ set_type: "warmup", weight_kg: 100, reps: 5 }), false);
  assert.equal(countsForE1RM({ set_type: "work", weight_kg: 0, reps: 5 }), false);
  assert.equal(countsForE1RM({ set_type: "work", weight_kg: 100, reps: 0 }), false);
});

check("stallDetect flags a lift flat for 4+ weeks, ignores progress and deloads", () => {
  const wk = (n, kg, extra = {}) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString(), sets: [{ exercise: "bench", set_type: "work", weight_kg: kg, reps: 5, ...extra }] });
  // four flat weeks -> stalled
  const flat = [wk(0, 100), wk(1, 100), wk(2, 101), wk(3, 100)];
  assert.equal(stallDetect(flat, exIndex).length, 1);
  // still nudging up -> NOT stalled
  const rising = [wk(0, 100), wk(1, 102.5), wk(2, 105), wk(3, 107.5)];
  assert.equal(stallDetect(rising, exIndex).length, 0);
  // SLOW steady progress inside the noise band, latest week is the best -> NOT
  // stalled (the original guard was a tautology and flagged exactly this lifter)
  const slow = [wk(0, 100), wk(1, 100.5), wk(2, 101), wk(3, 101.5)];
  assert.equal(stallDetect(slow, exIndex).length, 0);
  // DEAD FLAT: identical numbers every week -> the textbook plateau -> stalled
  // (the over-corrected `< hi - 0.01` guard missed this because latest == max)
  const deadFlat = [wk(0, 100), wk(1, 100), wk(2, 100), wk(3, 100)];
  assert.equal(stallDetect(deadFlat, exIndex).length, 1);
  // a deload week inside the window is ignored, not read as a crash/plateau signal
  const withDeload = [wk(0, 100), wk(1, 90, { deload: true }), wk(2, 102.5), wk(3, 105), wk(4, 107.5)];
  assert.equal(stallDetect(withDeload, exIndex).length, 0);
});

check("progressionByExercise: est-1RM rises across the log", () => {
  const sessions = [
    { date: "2026-06-01T18:00:00Z", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] },
    { date: "2026-06-08T18:00:00Z", sets: [{ exercise: "bench", set_type: "work", weight_kg: 105, reps: 5 }] },
  ];
  const p = progressionByExercise(sessions, exIndex).find((x) => x.exercise === "bench");
  assert.equal(p.first_e1rm, 116.67);
  assert.equal(p.last_e1rm, 122.5);
  assert.ok(p.change_pct > 4 && p.change_pct < 6, `change ${p.change_pct}`);
});

check("proximityFromRepDropoff infers effort from rep decay", () => {
  const session = { sets: [
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 8 },
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 6 },
  ] };
  const out = proximityFromRepDropoff(session);
  assert.equal(out["bench@100"].rep_dropoff, 2);
  assert.equal(out["bench@100"].inferred, "trained-close-to-failure");
});

check("restTimes derived from timestamps", () => {
  const session = { sets: [
    { exercise: "bench", weight_kg: 100, reps: 8, completed_at: "2026-06-01T18:06:00Z" },
    { exercise: "bench", weight_kg: 100, reps: 8, completed_at: "2026-06-01T18:09:00Z" },
  ] };
  assert.equal(restTimes(session).bench, 180); // 3 minutes
});

check("readinessIndex uses personal baseline (returns 0-100 or null)", () => {
  const checkins = [
    { date: "2026-06-01", hrv_ms: 60, sleep_hours: 7.5, resting_hr: 54, stress: 2 },
    { date: "2026-06-02", hrv_ms: 50, sleep_hours: 6.0, resting_hr: 58, stress: 4 },
    { date: "2026-06-03", hrv_ms: 70, sleep_hours: 8.5, resting_hr: 50, stress: 1 },
  ];
  const r = readinessIndex(checkins);
  assert.ok(r && r.latest >= 0 && r.latest <= 100, `readiness ${JSON.stringify(r)}`);
  assert.equal(readinessIndex([{ date: "2026-06-01" }]), null); // insufficient data
});

check("volumeResponse gives honest, MEV<->MRV-bounded per-muscle advice", () => {
  // landmarks: MEV 10, MAV 14-20, MRV 24 (chest-like); MEV 8 for a smaller muscle
  const mIndex = new Map([
    ["chest", { mev: { min: 10 }, mav: { max: 20 }, mrv: { max: 24 } }],
    ["biceps", { mev: { min: 8 }, mav: { max: 16 }, mrv: { max: 20 } }],
  ]);
  const below = volumeResponse({ chest: 6 }, mIndex).find((x) => x.muscle === "chest");
  assert.equal(below.signal, "add"); // below MEV → add

  const overMrv = volumeResponse({ chest: 26 }, mIndex).find((x) => x.muscle === "chest");
  assert.equal(overMrv.signal, "reduce"); // above MRV → reduce

  // stalled with room below MAV.max → add ~2 sets
  const stalledRoom = volumeResponse({ chest: 12 }, mIndex, new Set(["chest"])).find((x) => x.muscle === "chest");
  assert.equal(stalledRoom.signal, "add");

  // stalled AT the ceiling → CHANGE/deload, never "add more" (the runaway rail)
  const stalledCeil = volumeResponse({ chest: 22 }, mIndex, new Set(["chest"])).find((x) => x.muscle === "chest");
  assert.equal(stalledCeil.signal, "change");

  // progressing in range, not stalled → hold
  const holding = volumeResponse({ chest: 14 }, mIndex).find((x) => x.muscle === "chest");
  assert.equal(holding.signal, "hold");

  // no-landmark muscles are skipped, actionable signals sort before "hold"
  const mixed = volumeResponse({ chest: 14, biceps: 4 }, mIndex);
  assert.equal(mixed[0].muscle, "biceps"); // biceps below-MEV "add" sorts before chest "hold"
  assert.equal(volumeResponse({ unknown: 5 }, mIndex).length, 0); // no landmark → skipped
});

console.log(`\n${passed} test(s) passed.`);
