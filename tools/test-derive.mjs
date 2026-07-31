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
  sessionWeekKey,
  graduatedStatus,
  trainedWeeksInBlock,
  regressionDetect,
  GRADUATION,
  isHardSet,
  perMuscleWeeklyVolume,
  volumeVsLandmarks,
  volumeResponse,
  deriveVolumeAdjust,
  recoverySignal,
  interferenceSignal,
  LOWER_BODY_MUSCLES,
  progressionCadence,
  adaptiveStallWindow,
  bodyweightTrend,
  classifyEnergyBalance,
  progressionByExercise,
  proximityFromRepDropoff,
  restTimes,
  readinessIndex,
  detectPersonalRecords,
  priorPersonalBests,
  checkSetPR,
  allPersonalRecords,
  isLuckySet,
  luckySetsInSession,
  LUCKY_SET_XP,
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
  // #29: the "high" band ends at 6 — a 10-rep Epley estimate is a 33% extrapolation, only "moderate"
  assert.equal(estimate1RM(100, 6).confidence, "high");
  assert.equal(estimate1RM(100, 10).confidence, "moderate");
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

check("bodyweightTrend ignores non-positive weights and never yields NaN", () => {
  // A spurious 0/negative entry (bad data) must be filtered, not corrupt the trend
  // or produce a NaN pct_per_week (a zero average would divide by zero).
  const series = [
    { date: "2026-06-01", bodyweight_kg: 80.0 },
    { date: "2026-06-05", bodyweight_kg: 0 },      // garbage — must be dropped
    { date: "2026-06-08", bodyweight_kg: 80.5 },
    { date: "2026-06-15", bodyweight_kg: 81.0 },
    { date: "2026-06-22", bodyweight_kg: -5 },     // garbage — must be dropped
    { date: "2026-06-29", bodyweight_kg: 82.0 },
  ];
  const t = bodyweightTrend(series);
  assert.equal(t.n, 4, "only the 4 valid weigh-ins count");
  assert.ok(Number.isFinite(t.pct_per_week) && Number.isFinite(t.slope_kg_per_week), "no NaN in the trend");
  // all-zero (degenerate) input: filtered to nothing → null, never a NaN object
  assert.equal(bodyweightTrend([{ date: "2026-06-01", bodyweight_kg: 0 }, { date: "2026-06-08", bodyweight_kg: 0 }, { date: "2026-06-15", bodyweight_kg: 0 }]), null);
});

check("classifyEnergyBalance from weight trend + goal (no calories)", () => {
  const gaining = { pct_per_week: 0.3 };
  assert.equal(classifyEnergyBalance(gaining, "hypertrophy").direction, "surplus");
  assert.equal(classifyEnergyBalance(gaining, "hypertrophy").matchesGoal, true);
  const losing = { pct_per_week: -0.4 };
  assert.equal(classifyEnergyBalance(losing, "hypertrophy").matchesGoal, false); // wrong way for muscle gain
  assert.equal(classifyEnergyBalance(losing, "fat-loss").matchesGoal, true);
  // #29: at exactly the 0.1%/wk boundary, direction and advice must agree (were >/>= split)
  const edge = classifyEnergyBalance({ pct_per_week: 0.1 }, "hypertrophy");
  assert.equal(edge.direction, "surplus");
  assert.equal(edge.matchesGoal, true); // "lean-gain on target" — never "maintenance" + on-target
  assert.equal(classifyEnergyBalance({ pct_per_week: 0.0 }, "recomposition").direction, "maintenance");
});

check("#27 sessionWeekKey uses local_date but falls back to UTC date on a malformed one", () => {
  assert.equal(sessionWeekKey({ local_date: "2026-07-20", date: "2026-07-19T23:00:00Z" }), isoWeekKey("2026-07-20"));
  assert.equal(sessionWeekKey({ local_date: "20/07/2026", date: "2026-07-19T23:00:00Z" }), isoWeekKey("2026-07-19T23:00:00Z")); // bad -> UTC fallback, never "NaN-WNaN"
  assert.ok(!sessionWeekKey({ local_date: "garbage", date: "2026-07-19T23:00:00Z" }).includes("NaN"));
  assert.equal(sessionWeekKey({ date: "2026-07-19T23:00:00Z" }), isoWeekKey("2026-07-19T23:00:00Z")); // no local_date at all
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

check("#19 stallDetect sees pump-band (12-20 rep) lifts via the LOAD path — Epley is guesswork past 12 reps", () => {
  const hw = (n, kg, reps, extra = {}) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString(), sets: [{ exercise: "laterals", set_type: "work", weight_kg: kg, reps, ...extra }] });
  // same 10 kg dumbbell for 4 weeks of 15-rep laterals -> a real plateau the e1RM path was blind to
  const flat = [hw(0, 10, 15), hw(1, 10, 16), hw(2, 10, 15), hw(3, 10, 17)];
  const s = stallDetect(flat, exIndex);
  assert.equal(s.length, 1);
  assert.equal(s[0].basis, "load");
  assert.equal(s[0].best_load_kg, 10);
  // load creeping up -> NOT stalled
  const rising = [hw(0, 8, 15), hw(1, 9, 15), hw(2, 10, 15), hw(3, 11, 15)];
  assert.equal(stallDetect(rising, exIndex).length, 0);
  // deload-flagged high-rep sets stay out of the load path too
  const withDeload = [hw(0, 8, 15), hw(1, 5, 15, { deload: true }), hw(2, 9, 15), hw(3, 10, 15), hw(4, 11, 15)];
  assert.equal(stallDetect(withDeload, exIndex).length, 0);
  // an exercise with BOTH heavy and pump work is judged by the e1RM path only (no double flag)
  const mixed = [0, 1, 2, 3].map((n) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString(), sets: [
    { exercise: "bench", set_type: "work", weight_kg: 100 + n * 2.5, reps: 5 },
    { exercise: "bench", set_type: "work", weight_kg: 60, reps: 18 },
  ] }));
  assert.equal(stallDetect(mixed, exIndex).length, 0);
});

check("#20 progressionByExercise charts pump-band lifts by top-set LOAD (they never charted at all)", () => {
  const hw = (n, kg) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString(), sets: [{ exercise: "laterals", set_type: "work", weight_kg: kg, reps: 15 }] });
  const rows = progressionByExercise([hw(0, 8), hw(1, 9), hw(2, 10)], exIndex);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].basis, "load");
  assert.equal(rows[0].first_load_kg, 8);
  assert.equal(rows[0].last_load_kg, 10);
  assert.equal(rows[0].change_pct, 25);
  // heavy data present -> the e1RM entry covers the exercise; no duplicate load row
  const mixed = [0, 1].map((n) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString(), sets: [
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 },
    { exercise: "bench", set_type: "work", weight_kg: 60, reps: 18 },
  ] }));
  assert.equal(progressionByExercise(mixed, exIndex).length, 1);
  assert.equal(progressionByExercise(mixed, exIndex)[0].basis, undefined);
});

check("#21 one grinding 12-rep week must not hide a pump lift's load history (majority-of-weeks basis)", () => {
  // week 0: a single 12-rep top set (the BOTTOM of the 12-20 band -> routes to e1RM);
  // weeks 1-4: dead-flat 10 kg pump work. The all-time suppression made both the
  // stall and the chart row vanish — the exact bug Wave 20 claimed to fix.
  const w = (n, sets) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString(), sets });
  const sessions = [
    w(0, [{ exercise: "laterals", set_type: "work", weight_kg: 10, reps: 12 }]),
    ...[1, 2, 3, 4].map((n) => w(n, [{ exercise: "laterals", set_type: "work", weight_kg: 10, reps: 15 + (n % 2) }])),
  ];
  const stalls = stallDetect(sessions, exIndex);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].basis, "load");
  const rows = progressionByExercise(sessions, exIndex);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].basis, "load");
  assert.equal(rows[0].weeks, 4); // the 4 pump weeks chart; the lone e1RM week defers
});

check("#cloud-loop stallDetect must not double-flag one exercise from BOTH the e1RM and load paths when both are flat", () => {
  // A common real pattern: a flat 5-rep top set logged for only 4 of 5 weeks (one
  // week the lifter skipped the heavy set but still did the backoff/pump work) +
  // a flat 15-rep backoff set logged every week — the load path has MORE weeks
  // than the e1RM path, so the byExLoad loop's own majority-of-weeks guard does
  // NOT skip it. Before the fix, the e1RM (byEx) loop had no reciprocal guard at
  // all — unlike its sibling progressionByExercise, which guards BOTH directions
  // — so this pushed TWO stall entries for one exercise, rendering the Progress
  // tab's plateau card as "2 lifts have plateaued: Bench Press, Bench Press" (a
  // literal duplicated name + wrong count).
  const w = (n, sets) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString(), sets });
  const sessions = [0, 1, 2, 3, 4].map((n) => {
    const sets = [{ exercise: "bench", set_type: "work", weight_kg: 60, reps: 15 }];
    if (n < 4) sets.push({ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 });
    return w(n, sets);
  });
  const stalls = stallDetect(sessions, exIndex);
  assert.equal(stalls.length, 1, `expected exactly one stall entry, got ${stalls.length}`);
  assert.equal(stalls[0].exercise, "bench");
  assert.equal(stalls[0].basis, "load"); // the load path has MORE weeks (5 vs 4), so majority-of-weeks routes it there
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

check("deriveVolumeAdjust accumulates ±2 from stalls, bounded to MEV↔MRV, ignores below-MEV", () => {
  const mIndex = new Map([["chest", { mev: { min: 10 }, mav: { max: 20 }, mrv: { max: 24 } }]]);
  // stalled with headroom (12 < MAV.max 20) → +2, accumulating from a prior +2 → +4
  assert.equal(deriveVolumeAdjust({ chest: 2 }, { chest: 12 }, mIndex, new Set(["chest"])).chest, 4);
  // stalled AT the ceiling (22 >= MAV.max) → ease -2
  assert.equal(deriveVolumeAdjust({ chest: 4 }, { chest: 22 }, mIndex, new Set(["chest"])).chest, 2);
  // over MRV (26 > 24) → ease -2 even if not flagged stalled
  assert.equal(deriveVolumeAdjust({}, { chest: 26 }, mIndex, new Set()).chest, -2);
  // progressing in range, not stalled → hold (prior adjust persists)
  assert.equal(deriveVolumeAdjust({ chest: 4 }, { chest: 14 }, mIndex, new Set()).chest, 4);
  // BELOW MEV is a plan-fit issue, NOT a response signal → no adjustment created
  assert.equal(deriveVolumeAdjust({}, { chest: 6 }, mIndex, new Set()).chest, undefined);
  // the accumulated delta can never exceed the muscle's own MEV↔MRV range (24-10=14)
  let adj = { chest: 14 };
  adj = deriveVolumeAdjust(adj, { chest: 18 }, mIndex, new Set(["chest"])); // another +2 attempt
  assert.equal(adj.chest, 14); // clamped, doesn't run away
  // a delta returning to 0 is dropped from the map
  assert.equal(deriveVolumeAdjust({ chest: 2 }, { chest: 26 }, mIndex, new Set()).chest, undefined);
});

check("deriveVolumeAdjust recovery gate (Increment A): under-recovery/deficit suppress ADDING, never easing", () => {
  const mIndex = new Map([["chest", { mev: { min: 10 }, mav: { max: 20 }, mrv: { max: 24 } }]]);
  const stalledRoom = new Set(["chest"]);
  // baseline: stalled with headroom → +2
  assert.equal(deriveVolumeAdjust({ chest: 2 }, { chest: 12 }, mIndex, stalledRoom).chest, 4);
  // under-recovered → the +2 add is SUPPRESSED; the prior adjustment holds (no bump)
  assert.equal(deriveVolumeAdjust({ chest: 2 }, { chest: 12 }, mIndex, stalledRoom, { underRecovered: true }).chest, 2);
  // energy deficit → likewise suppresses the add (a stall while cutting isn't a volume problem)
  assert.equal(deriveVolumeAdjust({ chest: 2 }, { chest: 12 }, mIndex, stalledRoom, { inDeficit: true }).chest, 2);
  // easing is ALWAYS safe: over-ceiling still eases even under-recovered
  assert.equal(deriveVolumeAdjust({}, { chest: 26 }, mIndex, new Set(), { underRecovered: true }).chest, -2);
  // stalled AT the ceiling still eases under-recovered (pull back, don't hold high volume)
  assert.equal(deriveVolumeAdjust({ chest: 4 }, { chest: 22 }, mIndex, stalledRoom, { underRecovered: true }).chest, 2);
});

check("recoverySignal: block-average readiness + energy deficit gate the tune", () => {
  const lowCheckins = Array.from({ length: 5 }, (_, i) => ({ date: `2026-06-0${i + 1}`, sleep_quality: 2, energy: 2, stress: 4, mood: 2, motivation: 2 }));
  const rLow = recoverySignal(lowCheckins, { direction: "surplus" });
  assert.equal(rLow.underRecovered, true); // 5 check-ins averaging ~2 → under-recovered
  assert.equal(rLow.inDeficit, false);
  // good recovery, enough check-ins → not under-recovered
  const goodCheckins = Array.from({ length: 5 }, (_, i) => ({ date: `2026-06-0${i + 1}`, sleep_quality: 4, energy: 4, stress: 2, mood: 4, motivation: 4 }));
  assert.equal(recoverySignal(goodCheckins, null).underRecovered, false);
  // too few check-ins → never flags under-recovered (one bad night isn't a trend)
  assert.equal(recoverySignal(lowCheckins.slice(0, 2), null).underRecovered, false);
  // deficit is read from the energy-balance direction
  assert.equal(recoverySignal([], { direction: "deficit" }).inDeficit, true);
  // no data at all → permissive (the tune stays as capable as before)
  const rNone = recoverySignal([], null);
  assert.equal(rNone.underRecovered, false);
  assert.equal(rNone.inDeficit, false);
  assert.equal(rNone.avgReadiness, null);
});

check("progressionCadence learns the personal rhythm; adaptiveStallWindow scales patience (Increment B)", () => {
  const wkDate = (i) => { const d = new Date(Date.UTC(2026, 0, 5)); d.setUTCDate(d.getUTCDate() + i * 7); return d.toISOString().slice(0, 10); };
  const bench = (i, kg) => ({ local_date: wkDate(i), sets: [{ exercise: "bench", set_type: "work", weight_kg: kg, reps: 8 }] });
  // FAST responder: a real PR every week → cadence 1
  const fast = [0, 1, 2, 3, 4].map((i) => bench(i, 100 + i * 5));
  assert.equal(progressionCadence(fast, new Map()), 1);
  // SLOW responder: steps up only every 5th week → cadence 5
  const slow = [];
  for (let i = 0; i < 15; i++) slow.push(bench(i, 100 + Math.floor(i / 5) * 10));
  assert.equal(progressionCadence(slow, new Map()), 5);
  // too little of a track record → null (caller falls back to the KB default)
  assert.equal(progressionCadence([bench(0, 100), bench(1, 100)], new Map()), null);
  // window scaling: null → floor(4); fast(1) → 4 (floored — never LESS patient than the reliable minimum);
  // slow(5) → 8 (round 5×1.5); a huge cadence is ceilinged at 10 (even a dead lift warrants a look)
  assert.equal(adaptiveStallWindow(null), 4);
  assert.equal(adaptiveStallWindow(1), 4);
  assert.equal(adaptiveStallWindow(5), 8);
  assert.equal(adaptiveStallWindow(20), 10);
});

check("detectPersonalRecords: e1rm PR on heavy work, with a noise margin", () => {
  const prior = [{ session_id: "a", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] }]; // e1rm ~116.67
  const beat = { session_id: "b", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 6 }] };     // e1rm ~120
  const [pr] = detectPersonalRecords(beat, prior);
  assert.equal(pr.kind, "e1rm");
  assert.equal(pr.exercise, "bench");
  assert.ok(Math.abs(pr.e1rm_kg - 120) < 0.5 && pr.delta_kg > 3 && pr.delta_kg < 4);
  // matching the prior best is NOT a PR (no margin)
  const same = { session_id: "c", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] };
  assert.equal(detectPersonalRecords(same, prior).length, 0);
  // a first-ever performance is not a PR (no prior best)
  assert.equal(detectPersonalRecords(beat, []).length, 0);
});

check("detectPersonalRecords: HIGHER-REP work gets a LOAD PR (the pump-band gap)", () => {
  // 15-rep leg curl: Epley is guesswork here, so it's tracked by top LOAD, not e1rm.
  const prior = [{ session_id: "a", sets: [{ exercise: "leg-curl", set_type: "work", weight_kg: 40, reps: 15 }] }];
  const heavier = { session_id: "b", sets: [{ exercise: "leg-curl", set_type: "work", weight_kg: 45, reps: 15 }] };
  const [pr] = detectPersonalRecords(heavier, prior);
  assert.equal(pr.kind, "load");
  assert.equal(pr.load_kg, 45);
  assert.equal(pr.prev_kg, 40);
  assert.equal(pr.reps, 15);
  // same load again → no PR
  assert.equal(detectPersonalRecords({ session_id: "c", sets: [{ exercise: "leg-curl", set_type: "work", weight_kg: 40, reps: 16 }] }, prior).length, 0);
});

check("detectPersonalRecords: warm-ups and deloads never manufacture a PR", () => {
  const prior = [{ session_id: "a", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] }];
  // a heavy WARM-UP single must not count as a PR
  const warmup = { session_id: "b", sets: [{ exercise: "bench", set_type: "warmup", weight_kg: 200, reps: 1 }, { exercise: "bench", set_type: "work", weight_kg: 90, reps: 5 }] };
  assert.equal(detectPersonalRecords(warmup, prior).length, 0);
  // a deload week is intentionally light and can't out-lift a real best
  const deload = { session_id: "c", sets: [{ exercise: "bench", set_type: "work", weight_kg: 60, reps: 5, deload: true }] };
  assert.equal(detectPersonalRecords(deload, prior).length, 0);
});

check("priorPersonalBests: the shared ceiling detectPersonalRecords and checkSetPR both read", () => {
  const prior = [
    { session_id: "a", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] },        // e1rm ~116.67
    { session_id: "b", sets: [{ exercise: "leg-curl", set_type: "work", weight_kg: 40, reps: 15 }] },       // load 40
  ];
  const { e1rm, load } = priorPersonalBests(prior);
  assert.ok(Math.abs(e1rm.bench - 116.67) < 0.01);
  assert.equal(load["leg-curl"], 40);
  assert.equal(e1rm["leg-curl"], undefined); // never crosses bands
  assert.equal(load.bench, undefined);
});

check("checkSetPR: fires for the exact set that would make detectPersonalRecords report a PR", () => {
  const prior = [{ session_id: "a", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] }]; // e1rm ~116.67
  const bests = priorPersonalBests(prior);
  const beat = { exercise: "bench", set_type: "work", weight_kg: 100, reps: 6 }; // e1rm ~120
  const pr = checkSetPR(beat, bests);
  assert.equal(pr.kind, "e1rm");
  assert.ok(pr.delta_kg > 3 && pr.delta_kg < 4);
  // cross-check: logging this same set as a whole session must agree with detectPersonalRecords
  const [sessionPr] = detectPersonalRecords({ session_id: "b", sets: [beat] }, prior);
  assert.equal(sessionPr.kind, pr.kind);
  assert.ok(Math.abs(sessionPr.delta_kg - pr.delta_kg) < 0.01);
  // matching (not beating) the prior best is not a PR
  assert.equal(checkSetPR({ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }, bests), null);
  // a first-ever exercise (no prior entry) is not a PR
  assert.equal(checkSetPR({ exercise: "squat", set_type: "work", weight_kg: 100, reps: 5 }, bests), null);
  // a warm-up never counts, even if heavy enough to beat the prior best
  assert.equal(checkSetPR({ exercise: "bench", set_type: "warmup", weight_kg: 200, reps: 1 }, bests), null);
});

check("checkSetPR: higher-rep LOAD band agrees with detectPersonalRecords too", () => {
  const prior = [{ session_id: "a", sets: [{ exercise: "leg-curl", set_type: "work", weight_kg: 40, reps: 15 }] }];
  const bests = priorPersonalBests(prior);
  const heavier = { exercise: "leg-curl", set_type: "work", weight_kg: 45, reps: 15 };
  const pr = checkSetPR(heavier, bests);
  assert.equal(pr.kind, "load");
  assert.equal(pr.load_kg, 45);
  assert.equal(pr.reps, 15);
  const [sessionPr] = detectPersonalRecords({ session_id: "b", sets: [heavier] }, prior);
  assert.equal(sessionPr.load_kg, pr.load_kg);
});

check("allPersonalRecords: full history, most-recent-first, judged chronologically", () => {
  const s1 = { local_date: "2026-03-01", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] };
  const s2 = { local_date: "2026-03-08", sets: [{ exercise: "bench", set_type: "work", weight_kg: 105, reps: 5 }] }; // PR vs s1
  const s3 = { local_date: "2026-03-15", sets: [{ exercise: "bench", set_type: "work", weight_kg: 102, reps: 5 }] }; // NOT a PR (< 105)
  const prs = allPersonalRecords([s2, s3, s1]); // unsorted input on purpose
  assert.equal(prs.length, 1);            // only s2 beat a prior best; s1 is a first, s3 is below s2
  assert.equal(prs[0].kind, "e1rm");
  assert.equal(prs[0].date, "2026-03-08");
  assert.equal(allPersonalRecords([]).length, 0);
});

check("isLuckySet: deterministic (same inputs -> same verdict, always)", () => {
  const a = isLuckySet("sess-1", "bench", 3);
  for (let i = 0; i < 20; i++) assert.equal(isLuckySet("sess-1", "bench", 3), a);
});
check("isLuckySet: no session id -> never lucky (legacy/synthetic fixtures stay unaffected)", () => {
  assert.equal(isLuckySet(null, "bench", 0), false);
  assert.equal(isLuckySet(undefined, "bench", 0), false);
  assert.equal(isLuckySet("", "bench", 0), false);
});
check("isLuckySet: lands on roughly 1-in-8 hard-set slots across many sessions (variable-ratio, not fixed)", () => {
  let hits = 0;
  const trials = 4000;
  for (let i = 0; i < trials; i++) if (isLuckySet(`sess-${i}`, "bench", 0)) hits++;
  const rate = hits / trials;
  assert.ok(rate > 0.08 && rate < 0.17, `expected ~12.5% lucky rate, got ${(rate * 100).toFixed(1)}%`); // loose band: this is a hash, not a true RNG
  assert.ok(hits > 0 && hits < trials); // never always-lucky, never never-lucky
});
check("luckySetsInSession: warm-ups are never lucky (only hard work sets count)", () => {
  // Brute-force a session_id/exercise pair where index 0 IS lucky, so a false result
  // would only be possible via the warmup gate, not bad luck.
  let sid = null;
  for (let i = 0; i < 1000; i++) if (isLuckySet(`w-${i}`, "bench", 0)) { sid = `w-${i}`; break; }
  assert.ok(sid, "test setup: could not find a lucky seed");
  const warmupOnly = { session_id: sid, sets: [{ exercise: "bench", set_type: "warmup", weight_kg: 60, reps: 5 }] };
  assert.equal(luckySetsInSession(warmupOnly).length, 0);
  const asWorkSet = { session_id: sid, sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] };
  assert.equal(luckySetsInSession(asWorkSet).length, 1);
});
check("luckySetsInSession: per-exercise hard-set index replays in logged order, matching isLuckySet directly", () => {
  const sid = "sess-order-check";
  const sets = [
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 },
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 },
    { exercise: "row", set_type: "work", weight_kg: 80, reps: 8 },
    { exercise: "bench", set_type: "warmup", weight_kg: 40, reps: 5 }, // never lucky, never consumes a bench index
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 },
  ];
  const expected = [
    isLuckySet(sid, "bench", 0), isLuckySet(sid, "bench", 1), isLuckySet(sid, "row", 0), isLuckySet(sid, "bench", 2),
  ].filter(Boolean).length;
  assert.equal(luckySetsInSession({ session_id: sid, sets }).length, expected);
});
check("LUCKY_SET_XP is a positive flat bonus, smaller than the PR bonus", () => {
  assert.ok(LUCKY_SET_XP > 0 && LUCKY_SET_XP < 50);
});

// ---------------------------------------------------------------------------
// interferenceSignal — the concurrent-training read. It consumes already-derived
// inputs, so the fixtures are plain literals. The must-not-fire cases matter more
// than the fire case: this card is silent for almost everyone, and a false positive
// on a surface the user is supposed to trust costs more than a missed true one.
// ---------------------------------------------------------------------------
const IF_EX = new Map([
  ["back-squat", { name: "Back Squat", primary: ["quadriceps"], secondary: ["glutes"] }],
  ["romanian-deadlift", { name: "Romanian Deadlift", primary: ["hamstrings"], secondary: ["glutes"] }],
  ["leg-press", { name: "Leg Press", primary: ["quadriceps"], secondary: [] }],
  ["bench-press", { name: "Bench Press", primary: ["chest"], secondary: ["triceps"] }],
  ["barbell-row", { name: "Barbell Row", primary: ["lats"], secondary: ["biceps"] }],
  ["overhead-press", { name: "Overhead Press", primary: ["front-delts"], secondary: ["triceps"] }],
]);
const IF_MUSCLES = new Map([
  ["quadriceps", { mev: { min: 8, max: 10 }, mav: { min: 12, max: 18 }, mrv: { min: 20, max: 22 } }],
  ["hamstrings", { mev: { min: 6, max: 8 }, mav: { min: 10, max: 16 }, mrv: { min: 18, max: 20 } }],
  ["chest", { mev: { min: 8, max: 10 }, mav: { min: 12, max: 18 }, mrv: { min: 20, max: 22 } }],
]);
const IF_STALLS = [
  { exercise: "back-squat", name: "Back Squat", weeks_flat: 5, best_e1rm: 140 },
  { exercise: "romanian-deadlift", name: "Romanian Deadlift", weeks_flat: 5, best_e1rm: 120 },
];
const IF_PROG = [
  { exercise: "bench-press", name: "Bench Press", weeks: 5, change_pct: 6.2 },
  { exercise: "barbell-row", name: "Barbell Row", weeks: 5, change_pct: 4.8 },
  { exercise: "overhead-press", name: "Overhead Press", weeks: 4, change_pct: 3.1 },
];
const ifInput = (over = {}) => ({
  stalls: IF_STALLS, progression: IF_PROG,
  weekVolume: { quadriceps: 14, hamstrings: 10, chest: 14 }, // both inside MEV..MAV
  energyBalance: { direction: "deficit" }, recovery: { underRecovered: false },
  goal: "hypertrophy", injuries: [], ...over,
});
const ifRun = (over, guideline = null) => interferenceSignal(ifInput(over), IF_EX, IF_MUSCLES, guideline);

check("LOWER_BODY_MUSCLES excludes the muscles both halves train", () => {
  for (const m of ["quadriceps", "hamstrings", "glutes", "calves"]) assert.ok(LOWER_BODY_MUSCLES.has(m), m);
  for (const m of ["spinal-erectors", "abs", "chest", "lats"]) assert.ok(!LOWER_BODY_MUSCLES.has(m), m);
});
check("interferenceSignal: fires on legs-flat/upper-climbing + an unintended deficit", () => {
  const r = ifRun();
  assert.equal(r.pattern, "lower-body-stall-asymmetry");
  assert.deepEqual(r.corroborators, ["unintended-deficit"]);
  assert.equal(r.upper_progressing, 3);
  assert.deepEqual(r.stalled_lower.map((s) => s.exercise), ["back-squat", "romanian-deadlift"]);
  assert.ok(r.note.includes("Back Squat") && r.note.includes("Romanian Deadlift"));
  assert.ok(r.note.includes("about 5 weeks"));
  // Honesty bound: names cardio as a candidate, never as the cause, and always
  // offers the non-cardio explanation in the same breath.
  assert.ok(r.note.includes("one common cause"));
  assert.ok(r.note.includes("If cardio isn't part of your week"));
});
check("interferenceSignal: fires on persistent under-recovery with a flat bodyweight", () => {
  const r = ifRun({ energyBalance: { direction: "maintenance" }, recovery: { underRecovered: true } });
  assert.deepEqual(r.corroborators, ["under-recovered"]);
  assert.ok(r.note.includes("check-ins have been reading low"));
});
check("interferenceSignal: quotes the KB guideline's scale-back test rather than restating it", () => {
  const r = ifRun({}, { scale_back_protocol: "HALVE-IT-SENTINEL." });
  assert.ok(r.note.endsWith("HALVE-IT-SENTINEL."));
});
check("interferenceSignal: silent without a corroborator — flat legs alone are not a story", () => {
  assert.equal(ifRun({ energyBalance: { direction: "maintenance" }, recovery: { underRecovered: false } }), null);
  assert.equal(ifRun({ energyBalance: null, recovery: null }), null);
});
check("interferenceSignal: silent when the upper body is stalled too (systemic, not interference)", () => {
  const r = ifRun({
    stalls: [...IF_STALLS,
      { exercise: "bench-press", name: "Bench Press", weeks_flat: 5 },
      { exercise: "barbell-row", name: "Barbell Row", weeks_flat: 5 }],
  });
  assert.equal(r, null); // only overhead-press still progressing → below minUpperProgressing
});
check("interferenceSignal: silent when a lower-body lift is still progressing", () => {
  assert.equal(ifRun({ progression: [...IF_PROG, { exercise: "leg-press", name: "Leg Press", weeks: 5, change_pct: 5 }] }), null);
});
check("interferenceSignal: silent when only one lower-body lift has stalled", () => {
  assert.equal(ifRun({ stalls: [IF_STALLS[0]] }), null);
});
check("interferenceSignal: THE DISCRIMINATOR — silent outside the productive volume range", () => {
  // Over MAV: that's a lifting-volume problem; volumeResponse already says "reduce/change".
  assert.equal(ifRun({ weekVolume: { quadriceps: 20, hamstrings: 10, chest: 14 } }), null);
  // Below MEV: that's under-stimulus; volumeResponse already says "add".
  assert.equal(ifRun({ weekVolume: { quadriceps: 5, hamstrings: 10, chest: 14 } }), null);
  // Boundaries are inclusive — a muscle sitting exactly on MEV.min or MAV.max still counts as inside.
  assert.ok(ifRun({ weekVolume: { quadriceps: 8, hamstrings: 16, chest: 14 } }));
});
check("interferenceSignal: silent when volume can't be judged at all", () => {
  assert.equal(ifRun({ weekVolume: null }), null);
  assert.equal(ifRun({ weekVolume: {} }), null);              // no sets for the stalled muscles
  assert.equal(interferenceSignal(ifInput(), IF_EX, new Map(), null), null); // no landmarks
});
check("interferenceSignal: silent on a fat-loss goal, where the deficit is the plan", () => {
  assert.equal(ifRun({ goal: "fat-loss" }), null);
  assert.equal(ifRun({ goal: "recomposition" }), null);
  assert.equal(ifRun({ goal: null }), null);
  assert.ok(ifRun({ goal: "strength" }));
});
check("interferenceSignal: silent when a lower-body injury better explains the stall", () => {
  for (const region of ["knee", "hip", "ankle", "lower-back"]) assert.equal(ifRun({ injuries: [{ region }] }), null);
  assert.equal(ifRun({ injuries: ["knee"] }), null);          // bare-string form too
  assert.ok(ifRun({ injuries: [{ region: "shoulder" }] }));   // an upper-body injury doesn't suppress it
});
check("interferenceSignal: an unknown/custom exercise is skipped, never guessed into a half", () => {
  const r = ifRun({ stalls: [...IF_STALLS, { exercise: "mystery-machine", name: "Mystery Machine", weeks_flat: 5 }] });
  assert.deepEqual(r.stalled_lower.map((s) => s.exercise), ["back-squat", "romanian-deadlift"]);
});

// --- graduation (Wave 164): training_status was captured once at onboarding and
// changed by nothing afterwards, so a beginner stayed on beginner volume, with no
// mesocycle, no deload and no volume tune, forever. ---
const gradSessions = (weeks, perWeek = 2) => {
  const out = [];
  for (let w = 0; w < weeks; w++) for (let n = 0; n < perWeek; n++) {
    const d = new Date(Date.UTC(2026, 0, 5) + w * 7 * 86400000 + n * 86400000);
    out.push({ date: d.toISOString(), sets: [{ exercise: "barbell-bench-press", weight_kg: 60, reps: 8 }] });
  }
  return out;
};

check("graduatedStatus: a beginner with enough logged training age is promoted", () => {
  assert.equal(graduatedStatus(gradSessions(GRADUATION.intermediate.weeks, 2), "beginner"), "intermediate");
});

check("graduatedStatus: not yet — each threshold is required on its own", () => {
  assert.equal(graduatedStatus(gradSessions(GRADUATION.intermediate.weeks - 1, 2), "beginner"), null, "enough sessions, too few distinct weeks");
  // 26 distinct weeks but only ONE session each: showing up occasionally is not a
  // training history, and the session floor is what says so.
  assert.equal(graduatedStatus(gradSessions(GRADUATION.intermediate.weeks, 1), "beginner"), null, "enough weeks, too few sessions");
});

check("graduatedStatus: PROMOTES ONLY — a layoff or a quiet month never takes tools away", () => {
  assert.equal(graduatedStatus(gradSessions(2, 2), "intermediate"), null, "a thin log never demotes a declared intermediate");
  assert.equal(graduatedStatus(gradSessions(GRADUATION.intermediate.weeks, 2), "intermediate"), null, "already at what the log earned — no change");
  assert.equal(graduatedStatus(gradSessions(300, 3), "advanced"), null, "advanced is the top — nothing above it to earn");
});

check("graduatedStatus: the advanced tier needs its own, much longer horizon", () => {
  assert.equal(graduatedStatus(gradSessions(GRADUATION.advanced.weeks, 2), "intermediate"), "advanced");
  assert.equal(graduatedStatus(gradSessions(GRADUATION.advanced.weeks - 1, 2), "intermediate"), null);
  // A beginner whose log clears the advanced bar skips straight there — the log is
  // the evidence, not a ladder that has to be climbed one rung at a time.
  assert.equal(graduatedStatus(gradSessions(GRADUATION.advanced.weeks, 2), "beginner"), "advanced");
});

check("graduatedStatus: empty sessions don't count toward training age", () => {
  const empty = gradSessions(GRADUATION.intermediate.weeks, 2).map((s) => ({ ...s, sets: [] }));
  assert.equal(graduatedStatus(empty, "beginner"), null, "an emptied/voided session is not a trained day");
  assert.equal(graduatedStatus([], "beginner"), null);
  assert.equal(graduatedStatus(undefined, "beginner"), null, "no history never throws");
});

check("graduatedStatus: it is TRAINING AGE, not a reward for progressing", () => {
  // Every session identical — zero progress across the whole history. A stalled
  // lifter is exactly who needs the mesocycle wave and the volume tune, so the
  // promotion must not be gated on results.
  assert.equal(graduatedStatus(gradSessions(GRADUATION.intermediate.weeks, 2), "beginner"), "intermediate");
});

// --- regression (Wave 166): going BACKWARDS, which nothing could see. -----
// stallDetect structurally CANNOT flag a decline (it requires the window inside a
// 2.5% noise band, and a real drop blows past it), so a lifter losing strength was
// invisible — and once the pre-drop weeks rolled out of the window the new lower
// level read as an ordinary plateau, whose answer is +2 sets. Exactly backwards.
const regIdx = new Map([["bench", { name: "Bench Press", primary: ["chest"] }]]);
// Weekly e1RM is Epley: w * (1 + reps/30). At 8 reps that's w * 1.2667.
const regWeek = (weeksAgo, kg, extra = {}) => ({
  date: new Date(Date.UTC(2026, 0, 5) + (20 - weeksAgo) * 7 * 86400000).toISOString(),
  sets: [{ exercise: "bench", set_type: "work", weight_kg: kg, reps: 8, ...extra }],
});

check("regressionDetect: a sustained decline is flagged", () => {
  // 100, 100 -> 88, 86: the last two weeks are both >5% below the 100 peak.
  const r = regressionDetect([regWeek(4, 100), regWeek(3, 100), regWeek(2, 88), regWeek(1, 86)], regIdx);
  assert.equal(r.length, 1);
  assert.equal(r[0].exercise, "bench");
  assert.ok(r[0].drop_pct >= 5, `expected a real drop, got ${r[0].drop_pct}%`);
});

check("regressionDetect: ONE bad week is not a regression", () => {
  // The classic false positive: illness, a bad night, a missed meal. It bounces
  // back, and treating it as a decline would pull volume for no reason.
  assert.deepEqual(regressionDetect([regWeek(4, 100), regWeek(3, 100), regWeek(2, 85), regWeek(1, 101)], regIdx), []);
  // Even a drop that is still in progress needs TWO weeks before it counts.
  assert.deepEqual(regressionDetect([regWeek(4, 100), regWeek(3, 100), regWeek(2, 100), regWeek(1, 85)], regIdx), []);
});

check("regressionDetect: normal noise and genuine progress are never flagged", () => {
  assert.deepEqual(regressionDetect([regWeek(4, 100), regWeek(3, 99), regWeek(2, 100), regWeek(1, 99)], regIdx), [], "±1% is noise");
  assert.deepEqual(regressionDetect([regWeek(4, 90), regWeek(3, 95), regWeek(2, 100), regWeek(1, 105)], regIdx), [], "climbing");
});

check("regressionDetect: a planned DELOAD is not a decline", () => {
  // The whole point of a deload is lighter weeks. Counting them as regression would
  // fire on every single mesocycle, every six weeks, forever.
  const withDeload = [regWeek(4, 100), regWeek(3, 100), regWeek(2, 80, { deload: true }), regWeek(1, 80, { deload: true })];
  assert.deepEqual(regressionDetect(withDeload, regIdx), []);
});

check("regressionDetect: a SLOW grind downward is caught, not just a cliff", () => {
  // -1.5%/week compounding is -6% in a month and unambiguously a problem, but each
  // week is barely below the one before it — measuring the drop against only the
  // last few weeks could never accumulate enough to cross the threshold. This is
  // why the peak lookback is wider than the sustained-for-two-weeks check.
  const grind = Array.from({ length: 9 }, (_, i) => regWeek(9 - i, Math.round(120 * 0.985 ** i * 100) / 100));
  const r = regressionDetect(grind, regIdx);
  assert.equal(r.length, 1, "a sustained slow decline must be visible");
  assert.ok(r[0].drop_pct >= 5);
});

check("regressionDetect: a new, STABLE lower baseline eventually stops being a decline", () => {
  // Dropped long ago and flat ever since: that's the level they train at now — a
  // plateau, for the plateau levers to answer, not a decline to keep flagging.
  const settled = [
    ...Array.from({ length: 2 }, (_, i) => regWeek(12 - i, 120)),
    ...Array.from({ length: 9 }, (_, i) => regWeek(9 - i, 100)),
  ];
  assert.deepEqual(regressionDetect(settled, regIdx), []);
});

check("regressionDetect: too little history is silent, never a guess", () => {
  assert.deepEqual(regressionDetect([regWeek(2, 100), regWeek(1, 80)], regIdx), []);
  assert.deepEqual(regressionDetect([], regIdx), []);
});

check("deriveVolumeAdjust: a REGRESSING muscle is never given more volume", () => {
  const idx = new Map([["chest", { mev: { min: 8 }, mav: { max: 18 }, mrv: { max: 22 } }]]);
  const stalled = new Set(["chest"]);
  // Baseline: stalled with headroom and recovered -> the engine adds. This is the
  // exact branch a regression used to fall into once its drop went flat.
  assert.deepEqual(deriveVolumeAdjust({}, { chest: 12 }, idx, stalled, {}), { chest: 2 });
  assert.deepEqual(deriveVolumeAdjust({}, { chest: 12 }, idx, stalled, { regressingMuscleIds: new Set(["chest"]) }), {}, "holds instead of adding");
});

check("deriveVolumeAdjust: the regression gate is PER-MUSCLE, not whole-athlete", () => {
  const idx = new Map([
    ["chest", { mev: { min: 8 }, mav: { max: 18 }, mrv: { max: 22 } }],
    ["back", { mev: { min: 10 }, mav: { max: 20 }, mrv: { max: 24 } }],
  ]);
  const out = deriveVolumeAdjust({}, { chest: 12, back: 12 }, idx, new Set(["chest", "back"]), { regressingMuscleIds: new Set(["chest"]) });
  assert.deepEqual(out, { back: 2 }, "a fine back still earns its volume while a declining chest holds");
});

check("deriveVolumeAdjust: EASING still fires for a regressing muscle at its ceiling", () => {
  // Pulling volume back is always safe — only the ADD branch is gated.
  const idx = new Map([["chest", { mev: { min: 8 }, mav: { max: 18 }, mrv: { max: 22 } }]]);
  assert.deepEqual(deriveVolumeAdjust({}, { chest: 24 }, idx, new Set(["chest"]), { regressingMuscleIds: new Set(["chest"]) }), { chest: -2 });
});

// --- the mesocycle clock (Wave 167) --------------------------------------
// It used to be wall-clock, so six quiet weeks still delivered "Week 6 — deload".
const BLK_START = "2026-01-05T00:00:00.000Z"; // a Monday
const tw = (dayOffsets, nowOffset) => trainedWeeksInBlock(
  dayOffsets.map((d) => ({ date: new Date(+new Date(BLK_START) + d * 86400000).toISOString(), sets: [{ exercise: "x", weight_kg: 60, reps: 8 }] })),
  BLK_START,
  new Date(+new Date(BLK_START) + nowOffset * 86400000).toISOString(),
);

check("trainedWeeksInBlock: counts distinct trained weeks, not calendar weeks", () => {
  assert.equal(tw([], 42), 0, "six calendar weeks with nothing logged is not a block");
  assert.equal(tw([1, 8, 15, 22, 29], 40), 5, "five trained weeks behind the current one");
});

check("trainedWeeksInBlock: several sessions in one week still count once", () => {
  assert.equal(tw([1, 2, 3, 4, 5], 14), 1);
});

check("trainedWeeksInBlock: the CURRENT week isn't counted as finished", () => {
  // Trained on Monday of the current week; the rest of that week is still ahead.
  assert.equal(tw([14], 16), 0, "this week's own sessions don't advance the clock");
  assert.equal(tw([7, 14], 16), 1, "only the completed week counts");
});

check("trainedWeeksInBlock: sessions before block_start belong to the previous block", () => {
  assert.equal(tw([-14, -7, 7], 21), 1);
});

check("trainedWeeksInBlock: an emptied/voided session is not a trained week", () => {
  const sessions = [{ date: "2026-01-06T00:00:00.000Z", sets: [] }, { date: "2026-01-13T00:00:00.000Z", sets: [{ exercise: "x", weight_kg: 60, reps: 8 }] }];
  assert.equal(trainedWeeksInBlock(sessions, BLK_START, "2026-01-26T00:00:00.000Z"), 1);
});

check("trainedWeeksInBlock: missing/garbage inputs return 0 rather than throwing", () => {
  assert.equal(trainedWeeksInBlock([], null, "2026-01-26T00:00:00.000Z"), 0);
  assert.equal(trainedWeeksInBlock(undefined, BLK_START, "2026-01-26T00:00:00.000Z"), 0);
  assert.equal(trainedWeeksInBlock([{ date: "nonsense", sets: [{ exercise: "x" }] }], BLK_START, "2026-01-26T00:00:00.000Z"), 0);
});

console.log(`\n${passed} test(s) passed.`);
