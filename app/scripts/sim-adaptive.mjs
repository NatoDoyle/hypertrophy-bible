// Adaptive-algorithm simulation (considerations #2): drive the REAL engine with
// fake-but-realistic data for two archetypes — a SLOW responder and a FAST responder —
// and show how it adjusts over 4 / 12 / 24-week timelines. This is both a readable
// report (run: `node scripts/sim-adaptive.mjs`) and a regression guard (it asserts the
// behaviours that must hold; non-zero exit on any failure). It exercises the same
// functions /api/today runs at each block boundary: individualized stall cadence
// (Increment B) + the recovery/energy gate (Increment A) + the bounded volume tune.
//
// Model: both lifters train chest via barbell bench (primary chest 1.0/set; secondary
// front-delts + triceps 0.5/set) at 12 base sets/week — inside the productive range,
// with room below chest's MAV ceiling. Each 6-week block, the algorithm reads their own
// logged e1RM history and tunes NEXT block's volume; the sim then trains that new volume,
// closing the loop exactly as a real user would. e1RM per week is converted to a bench
// weight (Epley: e1RM = weight × (1 + reps/30)) at a fixed 8 reps.
import assert from "node:assert/strict";
import { computeVolumeAdjust } from "../src/coach.mjs";
import { progressionCadence, adaptiveStallWindow, stallDetect } from "../../tools/derive-core.mjs";
import { exIndex } from "../src/kb.mjs";

const REPS = 8;
const BLOCK = 6;                        // weeks per mesocycle block (matches /api/today)
const BASE_SETS = 12;                   // weekly chest sets a lifter trains before any tune
const weightForE1rm = (e1rm) => Math.round((e1rm / (1 + REPS / 30)) * 2) / 2; // to 0.5 kg

// e1RM trajectories over 24 weeks --------------------------------------------------
// SLOW responder: a real +4% PR every 6 weeks — genuine progress, but any single
// 4-week window looks flat. A fixed 4-week "stalled" rule would churn them every block.
const slowE1rm = Array.from({ length: 24 }, (_, w) => Math.round(100 * 1.04 ** Math.floor(w / BLOCK) * 100) / 100);
// FAST responder: +1.5%/wk for 8 weeks, then a hard plateau — a genuine stall the tune
// SHOULD answer with more volume.
const fastE1rm = Array.from({ length: 24 }, (_, w) => Math.round(120 * 1.015 ** Math.min(w, 8) * 100) / 100);

const genWeek = (w, e1rm, sets, totalWeeks) => ({
  // most-recent week is ~7 days ago so nothing reads as a layoff; older weeks step back by 7d each
  local_date: new Date(Date.now() - (totalWeeks - w) * 7 * 86400000).toISOString(),
  sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: weightForE1rm(e1rm), reps: REPS })),
});

// Run one archetype block-by-block, tuning volume from its own logged response.
// `checkinFor(weekIdx)` optionally returns a daily check-in (recovery gate); default none.
function simulate(e1rmByWeek, { checkinFor = () => null } = {}) {
  let adjust = {};
  const sessions = [];
  const checkins = [];
  const timeline = [];
  const totalWeeks = e1rmByWeek.length;
  for (let blk = 0; blk * BLOCK < totalWeeks; blk++) {
    const setsThisBlock = Math.max(1, BASE_SETS + (adjust.chest ?? 0)); // train the tune's recommendation
    for (let w = blk * BLOCK; w < Math.min((blk + 1) * BLOCK, totalWeeks); w++) {
      sessions.push(genWeek(w, e1rmByWeek[w], setsThisBlock, totalWeeks));
      const ck = checkinFor(w);
      if (ck) checkins.push({ date: new Date(Date.now() - (totalWeeks - w) * 7 * 86400000).toISOString().slice(0, 10), ...ck });
    }
    const throughWeek = Math.min((blk + 1) * BLOCK, totalWeeks);
    const cadence = progressionCadence(sessions, exIndex);
    const window = adaptiveStallWindow(cadence);
    const stalled = stallDetect(sessions, exIndex, { minWeeks: window }).some((s) => s.exercise === "barbell-bench-press");
    adjust = computeVolumeAdjust(adjust, sessions, [], { checkins, goal: "hypertrophy" });
    timeline.push({ throughWeek, setsTrained: setsThisBlock, cadence, window, stalled, chestAdjustForNext: adjust.chest ?? 0 });
  }
  return timeline;
}

// Read-only snapshot at an arbitrary horizon (for the 4-week mark, pre-first-boundary).
function readAt(e1rmByWeek, weeks) {
  const sessions = [];
  for (let w = 0; w < weeks; w++) sessions.push(genWeek(w, e1rmByWeek[w], BASE_SETS, weeks));
  const cadence = progressionCadence(sessions, exIndex);
  const window = adaptiveStallWindow(cadence);
  const stalled = stallDetect(sessions, exIndex, { minWeeks: window }).some((s) => s.exercise === "barbell-bench-press");
  return { cadence, window, stalled };
}

const fmtCad = (c) => (c == null ? "n/a (no PR yet)" : `${c}wk`);
function printUser(title, timeline, e1rmByWeek) {
  console.log(`\n${title}`);
  const wk4 = readAt(e1rmByWeek, 4);
  console.log(`  wk 4  (pre-first-block): cadence ${fmtCad(wk4.cadence)}, stall-window ${wk4.window}wk, reads-stalled=${wk4.stalled} → no tune yet (first boundary is wk 6)`);
  for (const r of timeline) {
    console.log(`  wk ${String(r.throughWeek).padStart(2)}: trained ${r.setsTrained} chest sets · learned cadence ${fmtCad(r.cadence).padEnd(14)} · stall-window ${r.window}wk · stalled=${String(r.stalled).padEnd(5)} → chest volume tune for next block: ${r.chestAdjustForNext >= 0 ? "+" : ""}${r.chestAdjustForNext}`);
  }
}

const slow = simulate(slowE1rm);
const fast = simulate(fastE1rm);
printUser("SLOW responder — real +4% PR every 6 weeks (slow but genuine):", slow, slowE1rm);
printUser("FAST responder — +1.5%/wk for 8 weeks, then a hard plateau:", fast, fastE1rm);

// Recovery variant: the FAST responder plateaus AND logs persistent poor recovery →
// the tune must NOT pile on volume (a stall you can't recover isn't a volume problem).
const fastUnderRecovered = simulate(fastE1rm, { checkinFor: (w) => (w >= 8 ? { sleep_quality: 2, energy: 2, stress: 4, mood: 2, motivation: 2 } : null) });
printUser("FAST responder BUT under-recovered from wk 8 (recovery gate):", fastUnderRecovered, fastE1rm);

// ---- Assertions: the behaviours that must hold (regression guard) -----------------
let checks = 0; const ok = (name, cond) => { assert.ok(cond, name); checks++; };

// SLOW: once the algorithm has seen a PR (by wk 12+), it LEARNS the ~6-week rhythm, the
// window stretches past 4, and it stops flagging the normal slow cadence as a plateau.
const slow12 = slow.find((r) => r.throughWeek === 12);
const slow24 = slow.find((r) => r.throughWeek === 24);
ok("slow responder's cadence is learned as slow (>=5wk) by wk 12 (after its first PR interval)", slow12.cadence >= 5);
ok("slow responder's stall window stretches past the fixed 4 by wk 12", slow12.window > 4);
ok("slow responder is NOT read as stalled at wk 12 (its one PR is recognised, not churned)", slow12.stalled === false);
ok("slow responder is NOT read as stalled at wk 24 either", slow24.stalled === false);
// only the single unavoidable wk-6 bump (no history yet); learned by wk 12 → held, never churned toward the ceiling
ok("slow responder is churned at most once before the rhythm locks — tune stays at +2 through wk 24", slow24.chestAdjustForNext <= 2);

// FAST: a genuine plateau IS answered — volume is added, promptly, and accumulates while
// the plateau persists (bounded, never runaway).
const fast12 = fast.find((r) => r.throughWeek === 12);
const fast24 = fast.find((r) => r.throughWeek === 24);
ok("fast responder is read as stalled once plateaued (wk 12)", fast12.stalled === true);
ok("fast responder gets a prompt volume bump at the first plateaued block (wk 12)", fast12.chestAdjustForNext >= 2);
ok("fast responder's bump accumulates while the plateau persists (wk 24 > wk 12)", fast24.chestAdjustForNext > fast12.chestAdjustForNext);
ok("fast responder's accumulated tune stays bounded (never runs away)", fast24.chestAdjustForNext <= 14);

// RECOVERY GATE: same plateau, but under persistent under-recovery → NO volume added.
const fr12 = fastUnderRecovered.find((r) => r.throughWeek === 12);
const fr24 = fastUnderRecovered.find((r) => r.throughWeek === 24);
ok("under-recovered fast responder gets NO volume bump at wk 12 (recovery gate holds)", fr12.chestAdjustForNext === 0);
ok("under-recovered fast responder still gets NO bump at wk 24", fr24.chestAdjustForNext === 0);

console.log(`\n${checks} simulation assertion(s) passed.`);
