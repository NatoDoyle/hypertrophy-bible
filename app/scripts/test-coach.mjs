// Coach-logic unit tests (no web server, no deps). node:assert.
import assert from "node:assert/strict";
import { selectProgram } from "../src/kb.mjs";
import { buildToday, suggestWeight, sessionRecap, progressReport, nextSessionIndex } from "../src/coach.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

check("selectProgram matches days + experience", () => {
  assert.equal(selectProgram({ training_status: "beginner", days_per_week: 3 }).id, "beginner-full-body-3day");
  assert.equal(selectProgram({ training_status: "intermediate", days_per_week: 4 }).id, "upper-lower-4day");
  assert.ok(!/special/.test(selectProgram({ training_status: "intermediate", days_per_week: 4 }).id)); // never a specialization default
});

const user = { profile: { training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3 }, program: selectProgram({ training_status: "beginner", days_per_week: 3 }) };

check("buildToday: first-timer gets a session with no pre-filled weight", () => {
  const today = buildToday(user, []);
  assert.ok(today.exercises.length > 0);
  assert.equal(today.exercises[0].suggested_kg, null); // first time -> user picks
  assert.ok(today.name && today.day_number === 1);
});

check("nextSessionIndex rotates through the program", () => {
  const p = user.program;
  assert.equal(nextSessionIndex(p, 0), 0);
  assert.equal(nextSessionIndex(p, p.sessions.length), 0); // wraps
  assert.equal(nextSessionIndex(p, 1), 1 % p.sessions.length);
});

check("suggestWeight: double progression adds load only when top of range is hit", () => {
  // barbell-bench-press rep_range in the beginner program is "6-10"
  const hitTop = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
  ] }];
  assert.equal(suggestWeight(hitTop, "barbell-bench-press", "6-10").suggested_kg, 102.5);
  const missedTop = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 },
  ] }];
  assert.equal(suggestWeight(missedTop, "barbell-bench-press", "6-10").suggested_kg, 100); // hold, add reps
  assert.equal(suggestWeight([], "barbell-bench-press", "6-10").suggested_kg, null); // first time
});

check("suggestWeight: RIR autoregulation raises load when reps are left in reserve", () => {
  // missed top of range (reps 8/10) but left 3-4 RIR -> go up anyway
  const easy = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, rir: 4 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, rir: 4 },
  ] }];
  assert.equal(suggestWeight(easy, "barbell-bench-press", "6-10").suggested_kg, 105); // +2×2.5 (avg RIR 4)
  // hit failure (RIR 0), didn't hit top -> hold
  const failed = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 7, rir: 0 },
  ] }];
  assert.equal(suggestWeight(failed, "barbell-bench-press", "6-10").suggested_kg, 100);
});

check("sessionRecap returns derived wins (PR detection)", () => {
  const s1 = { date: "2026-06-01T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] };
  const s2 = { date: "2026-06-08T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 105, reps: 8 }] };
  const recap = sessionRecap(user, [s1, s2], s2);
  assert.ok(Array.isArray(recap.wins) && recap.wins.length > 0);
  assert.ok(recap.wins.some((w) => /estimated 1RM/i.test(w))); // new e1RM PR detected
});

check("progressReport infers energy balance from bodyweight trend (no calories)", () => {
  const sessions = [{ date: "2026-06-01T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] }];
  const bodyweights = [
    { date: "2026-06-01", kg: 80.0 }, { date: "2026-06-08", kg: 80.4 }, { date: "2026-06-15", kg: 80.9 }, { date: "2026-06-22", kg: 81.3 },
  ];
  const r = progressReport(user, sessions, bodyweights);
  assert.equal(r.energy_balance.direction, "surplus"); // gaining -> surplus, on-target for hypertrophy
  assert.ok(r.bodyweight_trend.slope_kg_per_week > 0);
});

console.log(`\n${passed} coach test(s) passed.`);
