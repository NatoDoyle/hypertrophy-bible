// Coach-logic unit tests (no web server, no deps). node:assert.
import assert from "node:assert/strict";
import { selectProgram } from "../src/kb.mjs";
import { buildToday, suggestWeight, sessionRecap, progressReport, nextSessionIndex, dailyReadiness } from "../src/coach.mjs";

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

check("a normal-readiness check-in is ACKNOWLEDGED, never silent", () => {
  const t = buildToday(user, [], { level: "normal", score: 3 });
  assert.ok(t.coach_note && /checked in/i.test(t.coach_note)); // majority path must confirm receipt
});

check("dailyReadiness scores a check-in and buildToday eases a low day", () => {
  assert.equal(dailyReadiness(null), null);
  assert.equal(dailyReadiness({ sleep_quality: 5, energy: 5, stress: 1, mood: 5 }).level, "high");
  assert.equal(dailyReadiness({ sleep_quality: 1, energy: 2, stress: 5, mood: 2 }).level, "low");
  assert.equal(dailyReadiness({ sleep_quality: 3, energy: 3, stress: 3, mood: 3 }).level, "normal");
  const normalDay = buildToday(user, []);
  const lowDay = buildToday(user, [], { level: "low" });
  assert.ok(lowDay.exercises.length < normalDay.exercises.length); // trimmed the last accessory
  assert.ok(lowDay.coach_note); // and told the user why, kindly
});

check("buildToday resolves a custom exercise from the injected library", () => {
  const custom = [{ id: "custom-my-move", name: "My Move", primary_muscles: ["chest"], equipment: "dumbbell", mechanic: "isolation" }];
  const u = { profile: { days_per_week: 3 }, program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "custom-my-move", sets: 3, rep_range: "8-12" }] }] } };
  const t = buildToday(u, [], null, custom);
  assert.equal(t.exercises[0].name, "My Move");            // custom name resolves
  assert.equal(t.exercises[0].primary_muscles.length, 1);  // custom muscle resolves
  assert.equal(buildToday(u, [], null, custom).exercises[0].exercise, "custom-my-move");
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

check("mesocycle: sets ramp 70%->peak across weeks 1-5, deload halves week 6, then cycles", () => {
  const start = "2026-01-05T00:00:00Z";
  const day = (n) => new Date(+new Date(start) + n * 86400000).toISOString();
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, plan_meta: { block_start: start },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  const setsAt = (n) => buildToday(u, [], null, [], day(n)).exercises[0].sets;
  assert.equal(setsAt(0), 3);   // wk1: 4 × 0.7 → 3
  assert.equal(setsAt(14), 4);  // wk3: 4 × 0.9 → 4
  assert.equal(setsAt(28), 4);  // wk5 peak: full
  assert.equal(setsAt(35), 2);  // wk6 deload: half
  assert.equal(setsAt(42), 3);  // next block wk1 again — cycles automatically
  const deload = buildToday(u, [], null, [], day(35));
  assert.equal(deload.block.phase, "deload");
  assert.equal(deload.exercises[0].rir, "3-4"); // comfortably shy of failure
});

check("mesocycle: deload eases the suggested load ~10%", () => {
  const start = "2026-01-05T00:00:00Z";
  const u = { profile: { training_status: "advanced", days_per_week: 3 }, plan_meta: { block_start: start },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  const last = [{ date: "2026-02-08T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] }];
  const deloadDay = new Date(+new Date(start) + 36 * 86400000).toISOString(); // inside week 6
  const t = buildToday(u, last, null, [], deloadDay);
  assert.equal(t.exercises[0].suggested_kg, 90); // held weight 100 → 90 on deload
});

check("mesocycle: beginners are exempt — flat sets, no block", () => {
  const u = { profile: { training_status: "beginner", days_per_week: 3 }, plan_meta: { block_start: "2026-01-05T00:00:00Z" },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10" }] }] } };
  const t = buildToday(u, [], null, [], "2026-01-06T00:00:00Z");
  assert.equal(t.block, null);
  assert.equal(t.exercises[0].sets, 3);
});

check("suggestWeight: a layoff eases the load instead of piling on more (comeback safety)", () => {
  const last = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
  ] }];
  // 20 days later (>= comeback gap) -> deload ~12%, never heavier than before.
  const back = suggestWeight(last, "barbell-bench-press", "6-10", undefined, "2026-06-21T18:00:00Z");
  assert.equal(back.suggested_kg, 88);
  assert.ok(back.layoff_days >= 12 && /eased/i.test(back.note));
  // 2 days later (no layoff) -> normal double progression still adds load.
  assert.equal(suggestWeight(last, "barbell-bench-press", "6-10", undefined, "2026-06-03T18:00:00Z").suggested_kg, 102.5);
});

check("buildToday: comeback copy is TRUE — weights are actually eased on a layoff", () => {
  const u = { profile: { days_per_week: 3 }, program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [
    { exercise: "barbell-bench-press", sets: 3, rep_range: "6-10" }] }] } };
  const last = [{ date: "2026-06-01T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 }] }];
  const card = buildToday(u, last, null, [], "2026-06-25T18:00:00Z"); // 24-day gap
  assert.ok(/welcome back/i.test(card.coach_note));                 // says it eased
  assert.ok(card.exercises[0].suggested_kg < 100);                  // and actually did
});

check("buildToday surfaces unilateral so the card can say 'each side'", () => {
  const custom = [
    { id: "custom-uni", name: "Uni Move", primary_muscles: ["chest"], equipment: "dumbbell", mechanic: "isolation", unilateral: true },
    { id: "custom-bi", name: "Bi Move", primary_muscles: ["chest"], equipment: "dumbbell", mechanic: "isolation" },
  ];
  const u = { profile: { days_per_week: 3 }, program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [
    { exercise: "custom-uni", sets: 3, rep_range: "8-12" }, { exercise: "custom-bi", sets: 3, rep_range: "8-12" }] }] } };
  const t = buildToday(u, [], null, custom);
  assert.equal(t.exercises[0].unilateral, true);
  assert.equal(t.exercises[1].unilateral, false); // always a boolean, never undefined
});

check("no fake 1RM PR from a light high-rep back-off set (#1 confidence gate)", () => {
  const heavyTriple = { date: "2026-06-01T18:00:00Z", session_id: "a", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 45, reps: 3 }] };
  const lightBackoff = { date: "2026-06-08T18:00:00Z", session_id: "b", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 32, reps: 20 }] };
  const recap = sessionRecap(user, [heavyTriple, lightBackoff], lightBackoff);
  assert.ok(!recap.wins.some((w) => w.kind === "pr" || /1RM/i.test(w))); // 32×20 must not "beat" 45×3
});

check("sessionRecap returns derived wins (PR detection)", () => {
  const s1 = { date: "2026-06-01T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] };
  const s2 = { date: "2026-06-08T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 105, reps: 8 }] };
  const recap = sessionRecap(user, [s1, s2], s2);
  assert.ok(Array.isArray(recap.wins) && recap.wins.length > 0);
  const pr = recap.wins.find((w) => w.kind === "pr"); // structured: client formats in the user's unit
  assert.ok(pr && pr.e1rm_kg > 0 && pr.delta_kg > 0 && pr.name); // new e1RM PR detected
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
