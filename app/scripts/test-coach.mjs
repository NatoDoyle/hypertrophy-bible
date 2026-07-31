// Coach-logic unit tests (no web server, no deps). node:assert.
import assert from "node:assert/strict";
import { selectProgram, exerciseById } from "../src/kb.mjs";
import { buildToday, suggestWeight, estimateStartingWeight, sessionRecap, progressReport, nextSessionIndex, dailyReadiness, computeVolumeAdjust, waveRir, taperPhase, taperRir, reactiveDeloadDue, stalledExerciseIds, blockPhase } from "../src/coach.mjs";
import { isLuckySet, LUCKY_SET_XP, bodyweightTrend, isoWeekKey } from "../../tools/derive-core.mjs";

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

check("buildToday flags `beginner` from training_status (Goal 3: gates RIR jargon on the set screen)", () => {
  assert.equal(buildToday(user, []).beginner, true); // fixture user is training_status: "beginner"
  const intermediateUser = { ...user, profile: { ...user.profile, training_status: "intermediate" } };
  assert.equal(buildToday(intermediateUser, []).beginner, false);
  const noProfileUser = { ...user, profile: {} };
  assert.equal(buildToday(noProfileUser, []).beginner, true); // unset training_status defaults to the plainer copy
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

check("rotation_base rebases the cycle and ignores foreign-program sessions", () => {
  const prog = { id: "gen-mine", name: "P", sessions: [{ name: "A", exercises: [] }, { name: "B", exercises: [] }, { name: "C", exercises: [] }] };
  const mine = (n) => ({ date: `2026-06-0${n + 1}T18:00:00Z`, program_ref: "gen-mine", sets: [] });
  const foreign = (n) => ({ date: `2026-05-0${n + 1}T18:00:00Z`, program_ref: "gen-other", sets: [] });
  // 3 foreign + 5 own sessions; base counted with the SAME predicate = 5 own.
  const sessions = [foreign(0), foreign(1), foreign(2), mine(0), mine(1), mine(2), mine(3), mine(4)];
  const u = { profile: { days_per_week: 3 }, plan_meta: { rotation_base: 5 }, program: prog };
  assert.equal(buildToday(u, sessions).index, 0); // fresh plan opens at Day A
  // one more own session -> Day B (the cycle advances from the rebased zero)
  assert.equal(buildToday(u, [...sessions, mine(5)]).index, 1);
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

check("estimateStartingWeight: a body-scaled guess, rounded down to the load increment, erring light", () => {
  const bench = exerciseById.get("barbell-bench-press"); // horizontal-push, barbell, compound
  assert.equal(estimateStartingWeight(bench, 80, "barbell-bench-press"), 35); // 80*0.45*1=36 -> floor to 2.5kg increment
  assert.equal(estimateStartingWeight(bench, null, "barbell-bench-press"), null); // no bodyweight on file -> no guess
  const pullup = exerciseById.get("pull-up"); // bodyweight equipment -> never a loaded guess
  if (pullup) assert.equal(estimateStartingWeight(pullup, 80, "pull-up"), null);
});

check("buildToday: first-timer's suggested weight is body-scaled for a non-beginner, still null for a true beginner", () => {
  const prog = { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }] }] };
  const intermediate = { profile: { training_status: "intermediate", days_per_week: 3 }, program: prog };
  const t = buildToday(intermediate, [], null, [], null, 80);
  assert.equal(t.exercises[0].suggested_kg, 35); // confirm-not-guess: pre-filled from bodyweight
  assert.match(t.exercises[0].suggestion_note, /starting estimate/);
  // Same lift, no bodyweight on file -> falls back to the pre-existing null (empty-bar) behavior.
  assert.equal(buildToday(intermediate, [], null, [], null, null).exercises[0].suggested_kg, null);
  // A true beginner NEVER gets the body-scaled guess, even with a bodyweight on file —
  // they keep the safe empty-bar default + the "let's find your weight" ramp-up card.
  const beginnerU = { profile: { training_status: "beginner", days_per_week: 3 }, program: prog };
  assert.equal(buildToday(beginnerU, [], null, [], null, 80).exercises[0].suggested_kg, null);
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

// The mesocycle advances on TRAINED weeks, not calendar weeks (Wave 167), so these
// fixtures log a session in each intervening week. `day(n)` is still the calendar
// offset — with a session banked every week the two clocks coincide exactly, which
// is the point: a consistent lifter sees byte-identical behaviour to before.
const START = "2026-01-05T00:00:00Z";
const dayFrom = (start) => (n) => new Date(+new Date(start) + n * 86400000).toISOString();
// One session per week for `weeks` weeks, starting at block week 1.
const weeklyLog = (start, weeks, exercise = "barbell-bench-press") =>
  Array.from({ length: weeks }, (_, i) => ({
    date: new Date(+new Date(start) + i * 7 * 86400000).toISOString(),
    sets: [{ exercise, set_type: "work", weight_kg: 60, reps: 8 }],
  }));

check("mesocycle: sets ramp 70%->peak across weeks 1-5, deload halves week 6, then cycles", () => {
  const day = dayFrom(START);
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, plan_meta: { block_start: START },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  // At calendar day n the user has trained every week up to (but not including) this one.
  const setsAt = (n) => buildToday(u, weeklyLog(START, Math.floor(n / 7) + 1), null, [], day(n)).exercises[0].sets;
  assert.equal(setsAt(0), 3);   // wk1: 4 × 0.7 → 3
  assert.equal(setsAt(14), 4);  // wk3: 4 × 0.9 → 4
  assert.equal(setsAt(28), 4);  // wk5 peak: full
  assert.equal(setsAt(35), 2);  // wk6 deload: half
  assert.equal(setsAt(42), 3);  // next block wk1 again — cycles automatically
  const deload = buildToday(u, weeklyLog(START, 6), null, [], day(35));
  assert.equal(deload.block.phase, "deload");
  assert.equal(deload.exercises[0].rir, "3-4"); // comfortably shy of failure
});

check("#2D the mesocycle advances on TRAINED weeks — six quiet weeks are not a block", () => {
  const day = dayFrom(START);
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, plan_meta: { block_start: START },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  // Six calendar weeks in, having trained only twice: the wall-clock version served
  // "Week 6 — deload" to someone who had barely started the block.
  const sparse = [
    { date: day(1), sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 8 }] },
    { date: day(9), sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 8 }] },
  ];
  const t = buildToday(u, sparse, null, [], day(38));
  assert.equal(t.block.week, 3, "two trained weeks behind them → week 3, not week 6");
  assert.notEqual(t.block.phase, "deload", "no phantom deload for work that never happened");
});

check("#2D a week in progress isn't counted as finished the moment its first session lands", () => {
  const day = dayFrom(START);
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, plan_meta: { block_start: START },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  const mondayOfWeek1 = [{ date: day(0), sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 8 }] }];
  assert.equal(buildToday(u, mondayOfWeek1, null, [], day(2)).block.week, 1, "still week 1 on Wednesday, with the rest of it ahead");
});

check("#16 mesocycle wave creeps EFFORT like the KB table: W1 eased, W2-3 plan band, W4-5 tightened, deload 3-4", () => {
  const day = dayFrom(START);
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, plan_meta: { block_start: START },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [
      { exercise: "barbell-bench-press", sets: 4, rep_range: "6-10", rir: "1-3" },
      { exercise: "dumbbell-lateral-raise", sets: 3, rep_range: "12-20", rir: "0-1" },
    ] }] } };
  const rirAt = (n) => buildToday(u, weeklyLog(START, Math.floor(n / 7) + 1), null, [], day(n)).exercises.map((e) => e.rir);
  assert.deepEqual(rirAt(0), ["2-3", "1-2"]);  // wk1: one extra rep in the tank (KB: ~2-3 RIR)
  assert.deepEqual(rirAt(14), ["1-3", "0-1"]); // wk3: the plan's own band
  assert.deepEqual(rirAt(28), ["1-2", "0-1"]); // wk5 peak: far edge pulled in; compounds never cross 1 RIR
  assert.deepEqual(rirAt(35), ["3-4", "3-4"]); // wk6 deload: comfortable
});

check("#16 waveRir never pushes a compound's near edge toward failure and passes junk through", () => {
  assert.equal(waveRir("2-3", 1), "3-4");   // strength compounds ease too
  assert.equal(waveRir("2-3", 5), "2-3");   // already a 1-wide band: peak leaves it alone
  assert.equal(waveRir("0-1", 4), "0-1");   // isolations already at the KB edge
  assert.equal(waveRir(undefined, 2), undefined); // no band -> untouched
});

check("#19 a layoff-comeback session is flagged so its eased weights stay out of e1RM/stall trends", () => {
  const now = "2026-06-01T10:00:00Z";
  const day = (n) => new Date(+new Date(now) - n * 86400000).toISOString();
  const prog = { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }] }] };
  const mkSession = (n) => ({ session_id: "s" + n, date: day(n), sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] });
  const backAfterLayoff = buildToday({ profile: { training_status: "beginner", days_per_week: 3 }, program: prog }, [mkSession(15)], null, [], now);
  assert.equal(backAfterLayoff.comeback, true);  // 15 days off -> the 0.88x ease is a deload of its own
  const regular = buildToday({ profile: { training_status: "beginner", days_per_week: 3 }, program: prog }, [mkSession(2)], null, [], now);
  assert.equal(regular.comeback, false);
});

check("#19 autoregulation measures compliance against the PRESCRIBED band, not a hardcoded 3", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const sessions = [{ session_id: "s1", date: day(3), sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, rir: 3 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, rir: 3 },
  ] }];
  // week-1 / deload prescription "3-4": logging 3 RIR is COMPLIANCE -> hold the load
  const eased = suggestWeight(sessions, "barbell-bench-press", "6-10", undefined, day(0), "3-4");
  assert.equal(eased.suggested_kg, 100);
  // same log against the default band -> the historical bump still fires
  const dflt = suggestWeight(sessions, "barbell-bench-press", "6-10", undefined, day(0));
  assert.ok(dflt.suggested_kg > 100);
  // sandbagging even the eased band (5 in the tank vs "3-4") -> bump
  const sandbag = [{ session_id: "s2", date: day(3), sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, rir: 5 }] }];
  assert.ok(suggestWeight(sandbag, "barbell-bench-press", "6-10", undefined, day(0), "3-4").suggested_kg > 100);
});

check("#19 Progress samples an honest reference week: deload and in-progress weeks don't trigger 'add sets'", () => {
  // fixed Wednesday "now" so the current ISO week is knowable
  const now = "2026-06-10T10:00:00Z"; // Wed of ISO week 2026-W24
  const user = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };
  const full = (dates, extra = {}) => dates.map((d, i) => ({ session_id: "f" + d, date: d, sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, ...extra },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, ...extra },
  ] }));
  // W23 (Jun 1-7): a full training week. W24 (Jun 8-14): deload-flagged sets.
  const sessions = [...full(["2026-06-01", "2026-06-03", "2026-06-05"]), ...full(["2026-06-08"], { deload: true })];
  const rep = progressReport(user, sessions, [], [], now);
  assert.equal(rep.latest_week, "2026-W23"); // the deload week is skipped
  assert.ok(rep.volume_note && /deload/i.test(rep.volume_note));
  // in-progress week (no deload): one Monday session in W24 with a full W23 behind it
  const inProg = [...full(["2026-06-01", "2026-06-03", "2026-06-05"]), ...full(["2026-06-08"])];
  const rep2 = progressReport(user, inProg, [], [], now);
  assert.equal(rep2.latest_week, "2026-W23");
  assert.ok(rep2.volume_note && /in progress/i.test(rep2.volume_note));
  // a lone first week is still shown (no earlier week to fall back to)
  const lone = full(["2026-06-08", "2026-06-10"]);
  assert.equal(progressReport(user, lone, [], [], now).latest_week, "2026-W24");
});

check("#19 specialization maintenance muscles read 'holding steady', never 'add volume'", () => {
  const now = "2026-06-10T10:00:00Z";
  const user = { profile: { training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 4 },
    plan_rationale: { volume_by_muscle: { chest: { maintenance: true, target_sets: 6 } } } };
  // one maintenance-dose chest session in a past full week -> below MEV on raw numbers
  const sessions = [{ session_id: "m1", date: "2026-06-02", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 },
  ] }];
  const rep = progressReport(user, sessions, [], [], now);
  const chest = rep.volumeByMuscle.find((v) => v.id === "chest");
  assert.equal(chest.status, "maintenance"); // the client's s-maint legend finally has a producer
  assert.ok(!rep.adaptive.some((a) => a.muscle === "chest" && a.signal === "add"));
});

check("#21 the session AFTER a comeback does not re-fire the layoff ease (deload-tagged sessions still count as training)", () => {
  const now = "2026-06-20T10:00:00Z";
  const day = (n) => new Date(+new Date(now) - n * 86400000).toISOString();
  const sessions = [
    { session_id: "pre", date: day(18), sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] },
    { session_id: "cb", date: day(3), sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 88, reps: 8, deload: true }] },
  ];
  const sug = suggestWeight(sessions, "barbell-bench-press", "6-10", undefined, now);
  assert.equal(sug.layoff_days, undefined); // trained 3 days ago — NOT a layoff
  assert.ok(!/It's been/.test(sug.note));   // no false "It's been 18 days" copy
  assert.equal(sug.last_kg, 100);           // progression anchor stays on the non-deload session
});

check("#21 an all-deload recent history shows the NEWEST week with an honest note (never the oldest)", () => {
  const now = "2026-06-17T10:00:00Z";
  const user = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };
  const dl = (d) => ({ session_id: "d" + d, date: d, sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 90, reps: 8, deload: true },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 90, reps: 8, deload: true },
  ] });
  const rep = progressReport(user, [dl("2026-06-01"), dl("2026-06-08")], [], [], now);
  assert.equal(rep.latest_week, "2026-W24"); // the NEWER deload week, not W23
  assert.ok(/deload/i.test(rep.volume_note) && !/Skipping/i.test(rep.volume_note)); // honest: we're SHOWING a deload, not skipping one
});

check("#27 a per-exercise layoff (one lift back after 12+ days, session not a whole-session comeback) is tagged eased", () => {
  const now = "2026-06-20T10:00:00Z";
  const day = (n) => new Date(+new Date(now) - n * 86400000).toISOString();
  const prog = { id: "p", name: "P", sessions: [{ name: "D", exercises: [
    { exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" },
    { exercise: "barbell-back-squat", sets: 3, rep_range: "6-10", rir: "1-3" },
  ] }] };
  // squat trained 2 days ago (continuous); bench last done 20 days ago (rotated back)
  const sessions = [
    { session_id: "s1", date: day(20), sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] },
    { session_id: "s2", date: day(2), sets: [{ exercise: "barbell-back-squat", set_type: "work", weight_kg: 140, reps: 8 }] },
  ];
  const today = buildToday({ profile: { training_status: "beginner", days_per_week: 3 }, program: prog }, sessions, null, [], now);
  assert.equal(today.comeback, false); // the SESSION isn't a comeback (squat trained 2 days ago)
  const bench = today.exercises.find((e) => e.exercise === "barbell-bench-press");
  const squat = today.exercises.find((e) => e.exercise === "barbell-back-squat");
  assert.equal(bench.eased, true);       // the rotated-back bench IS eased per-exercise
  assert.equal(squat.eased, undefined);  // the continuous squat is not
});

check("#14 mesocycle wave never scales a 2-set dose into 1-set scatter", () => {
  const start = "2026-01-05T00:00:00Z";
  const day = (n) => new Date(+new Date(start) + n * 86400000).toISOString();
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, plan_meta: { block_start: start },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [
      { exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" },
      { exercise: "dumbbell-lateral-raise", sets: 2, rep_range: "12-20" },
    ] }] } };
  const setsAt = (n) => buildToday(u, weeklyLog(start, Math.floor(n / 7) + 1), null, [], day(n)).exercises.map((e) => e.sets);
  assert.deepEqual(setsAt(0), [3, 2]);  // wk1 (0.7): 4→3, but 2 stays 2 — never 1
  assert.deepEqual(setsAt(35), [2, 2]); // wk6 deload (0.5): 4→2 halves, 2 floors at 2
});

check("#8-3 high-readiness never invites a back-off set during a deload week", () => {
  const start = "2026-01-05T00:00:00Z";
  const day = (n) => new Date(+new Date(start) + n * 86400000).toISOString();
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, plan_meta: { block_start: start },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  const high = { level: "high", score: 4.5 };
  const deload = buildToday(u, weeklyLog(start, 6), high, [], day(35)); // wk6 deload
  assert.equal(deload.block.phase, "deload");
  assert.ok(deload.coach_note && !/back-off set/i.test(deload.coach_note)); // no "add volume" during recovery
  assert.ok(/deload/i.test(deload.coach_note)); // holds the deload line
  const peak = buildToday(u, weeklyLog(start, 5), high, [], day(28)); // wk5 peak — adding volume IS fine
  assert.ok(/back-off set/i.test(peak.coach_note));
});

check("mesocycle: deload eases the suggested load ~10%", () => {
  const start = "2026-01-05T00:00:00Z";
  const u = { profile: { training_status: "advanced", days_per_week: 3 }, plan_meta: { block_start: start },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  // Five trained weeks behind them puts this session in block week 6 (the deload),
  // plus the recent heavy session the ease is measured from.
  const last = [...weeklyLog(start, 5, "goblet-squat"), { date: "2026-02-08T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] }];
  const deloadDay = new Date(+new Date(start) + 36 * 86400000).toISOString(); // inside week 6
  const t = buildToday(u, last, null, [], deloadDay);
  assert.equal(t.exercises[0].suggested_kg, 90); // held weight 100 → 90 on deload
});

check("#A2 deload never prescribes >= the prior real week (eases from last load, not the progressed target)", () => {
  const start = "2026-01-05T00:00:00Z";
  const u = { profile: { training_status: "advanced", days_per_week: 3 }, plan_meta: { block_start: start },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  // Last week hit the TOP of the range at a LIGHT load → suggestWeight ADDS load.
  // The old deload multiplied that bumped target by 0.9 and came out HEAVIER than 20.
  const last = [...weeklyLog(start, 5, "goblet-squat"), { date: "2026-02-08T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 20, reps: 10 }] }];
  const deloadDay = new Date(+new Date(start) + 36 * 86400000).toISOString();
  const t = buildToday(u, last, null, [], deloadDay);
  assert.equal(t.block.phase, "deload");
  assert.ok(t.exercises[0].suggested_kg < 20, `deload ${t.exercises[0].suggested_kg} must be lighter than the 20kg peak week`);
});

check("#A1 a low check-in on an already-short session is eased honestly, never told 'normal range'", () => {
  const u = { profile: { training_status: "beginner", days_per_week: 3 },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [
      { exercise: "barbell-bench-press", sets: 3, rep_range: "6-10" },
      { exercise: "barbell-row", sets: 3, rep_range: "6-10" },
      { exercise: "goblet-squat", sets: 3, rep_range: "6-10" }] }] } };
  const t = buildToday(u, [], { level: "low", score: 1.5 });
  assert.equal(t.exercises.length, 3);                          // ≤3 → nothing to trim, keep it whole
  assert.ok(t.coach_note && !/normal range/i.test(t.coach_note), "must NOT fabricate a 'normal range' status on a low day");
  assert.ok(/short session|extra rest|reps short/i.test(t.coach_note), "must give an honest low-day easing note");
});

check("mesocycle: beginners are exempt — flat sets, no block", () => {
  const u = { profile: { training_status: "beginner", days_per_week: 3 }, plan_meta: { block_start: "2026-01-05T00:00:00Z" },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10" }] }] } };
  const t = buildToday(u, [], null, [], "2026-01-06T00:00:00Z");
  assert.equal(t.block, null);
  assert.equal(t.exercises[0].sets, 3);
});

check("suggestWeight anchors past deload sets — the next block resumes at pre-deload load", () => {
  const hist = [
    { date: "2026-06-01T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 }] },
    { date: "2026-06-08T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 90, reps: 8, deload: true }] },
  ];
  // anchored to the 100x10 (top of range) -> progress to 102.5, NOT held at 90
  assert.equal(suggestWeight(hist, "barbell-bench-press", "6-10", undefined, "2026-06-10T18:00:00Z").suggested_kg, 102.5);
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

check("computeVolumeAdjust samples PEAK block volume, not the deload week (ease branch reachable)", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const wk = (n, sets) => ({ date: day(n), sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  // chest (bench primary) stalled at 20 working sets/wk (= its MAV.max), block ends on a
  // deload week at 10. Sampling the deload (10 < MAV.max) would BUMP; sampling the peak
  // (20 >= MAV.max) correctly EASES a ceiling-stalled muscle.
  const sessions = [wk(42, 20), wk(35, 20), wk(28, 20), wk(21, 20), wk(14, 20), wk(7, 10)];
  const adj = computeVolumeAdjust({ chest: 6 }, sessions);
  assert.equal(adj.chest, 4, `stalled at ceiling should EASE +6→+4, got ${adj.chest}`);
});

check("computeVolumeAdjust recovery gate (Increment A): under-recovery holds the bump the tune would otherwise make", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const wk = (n, sets) => ({ date: day(n), sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  // chest (bench primary) stalled at 12 working sets/wk — room below MAV.max — flat e1RM 5 weeks.
  const sessions = [wk(35, 12), wk(28, 12), wk(21, 12), wk(14, 12), wk(7, 12)];
  // no recovery context → the tune ADDS volume to the stalled-with-room muscle (+2 from +2 → +4)
  assert.equal(computeVolumeAdjust({ chest: 2 }, sessions).chest, 4);
  // 5 low check-ins (avg readiness ~2/5) → under-recovered → the add is SUPPRESSED, holds at +2
  const lowCheckins = Array.from({ length: 5 }, (_, i) => ({ date: `2026-06-0${i + 1}`, sleep_quality: 2, energy: 2, stress: 4, mood: 2, motivation: 2 }));
  assert.equal(computeVolumeAdjust({ chest: 2 }, sessions, [], { checkins: lowCheckins }).chest, 2);
  // losing bodyweight on a gain goal → energy deficit → likewise holds (stall needs fuel, not sets)
  const bwDown = Array.from({ length: 6 }, (_, i) => ({ date: `2026-06-0${i + 1}`, kg: 85 - i * 0.3 }));
  assert.equal(computeVolumeAdjust({ chest: 2 }, sessions, [], { bodyweights: bwDown, goal: "hypertrophy" }).chest, 2);
});

check("computeVolumeAdjust individualized patience (Increment B): a slow responder's own rhythm isn't a stall", () => {
  const wkDate = (i) => { const d = new Date(Date.UTC(2026, 0, 5)); d.setUTCDate(d.getUTCDate() + i * 7); return d.toISOString().slice(0, 10); };
  // 12 chest sets/wk (room below MAV.max); bench PRs only every ~5 weeks (slow but real), then 4 flat weeks.
  const week = (i, kg) => ({ local_date: wkDate(i), sets: Array.from({ length: 12 }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: kg, reps: 8 })) });
  const full = []; for (let i = 0; i < 15; i++) full.push(week(i, 100 + Math.floor(i / 5) * 10));
  // personal cadence ~5wk → the stall window stretches to ~8 → the recent 4-week flat is NOT a plateau → no bump
  assert.equal(computeVolumeAdjust({}, full).chest, undefined);
  // the SAME recent flat weeks WITHOUT the track record (cadence unknown → default 4-week window) DO read as a
  // stall → bump. This is the whole point of Increment B: identical recent data, different verdict by history.
  assert.equal(computeVolumeAdjust({}, full.slice(9)).chest, 2);
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

check("buildToday attaches pr_watch — the exact ceiling sessionRecap will compare the live session against", () => {
  const noHistory = buildToday(user, []);
  assert.deepEqual(noHistory.exercises[0].pr_watch, { e1rm_kg: null, load_kg: null }); // nothing to beat yet
  // program_ref from a DIFFERENT program: doesn't advance today's own rotation index
  // (buildToday would otherwise open Day B instead of Day A, which may not carry
  // bench), but priorPersonalBests still reads it since it scans every session handed in.
  const heavy = { date: "2026-06-01T18:00:00Z", session_id: "a", program_ref: "some-other-program", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 5 }] };
  const withHistory = buildToday(user, [heavy]);
  const bench = withHistory.exercises.find((e) => e.exercise === "barbell-bench-press");
  assert.ok(Math.abs(bench.pr_watch.e1rm_kg - 116.67) < 0.01); // matches estimate1RM(100, 5)
  assert.equal(bench.pr_watch.load_kg, null); // no >12-rep work logged for it
  // must agree with what sessionRecap will actually compare the NEXT session against
  const nextSession = { session_id: "b", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 105, reps: 5 }] };
  const recap = sessionRecap(user, [heavy], nextSession);
  const pr = recap.wins.find((w) => w.kind === "pr");
  assert.ok(pr && Math.abs(pr.e1rm_kg - bench.pr_watch.e1rm_kg - (pr.delta_kg)) < 0.1); // recap's prior implicit in delta_kg matches pr_watch
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
  assert.equal(recap.pr_xp, 50); // Wave 81: the PR's bonus XP is surfaced in the recap (+50)
});

check("sessionRecap now celebrates HIGHER-REP work — a load PR (Wave 79, Goal 4)", () => {
  // higher-rep hypertrophy work (>12 reps) is tracked by top LOAD, not e1rm — beating your
  // best weight there used to be told nothing; now it's a pr-load win.
  const s1 = { date: "2026-06-01T18:00:00Z", session_id: "a", sets: [{ exercise: "leg-curl", set_type: "work", weight_kg: 40, reps: 15 }] };
  const s2 = { date: "2026-06-08T18:00:00Z", session_id: "b", sets: [{ exercise: "leg-curl", set_type: "work", weight_kg: 45, reps: 15 }] };
  const recap = sessionRecap(user, [s1, s2], s2);
  const pr = recap.wins.find((w) => w.kind === "pr-load");
  assert.ok(pr && pr.load_kg === 45 && pr.reps === 15 && pr.name); // structured, client formats the unit
});

check("sessionRecap surfaces a lucky-set win + lucky_xp (roadmap #2's remaining slice)", () => {
  let luckySid = null;
  for (let i = 0; i < 1000; i++) if (isLuckySet(`lucky-${i}`, "barbell-bench-press", 0)) { luckySid = `lucky-${i}`; break; }
  const s = { date: "2026-06-01T18:00:00Z", session_id: luckySid, sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 8 }] };
  const recap = sessionRecap(user, [], s);
  assert.equal(recap.lucky_xp, LUCKY_SET_XP);
  assert.ok(recap.wins.some((w) => typeof w === "string" && /Lucky set/i.test(w)));
});
check("sessionRecap: no lucky_xp when the session isn't seeded to hit (no session_id)", () => {
  const s = { date: "2026-06-01T18:00:00Z", sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 8 }] };
  assert.equal(sessionRecap(user, [], s).lucky_xp, 0);
});

// ---------------------------------------------------------------------------
// The concurrent-training read, through the binder. progressReport takes `now`
// explicitly, so fixed dates are safe here (unlike the route suite).
// ---------------------------------------------------------------------------
const IF_NOW = "2026-02-16T10:00:00Z"; // Monday of 2026-W08; the fixture's last full week is W07
// 6 weeks: squat + RDL dead flat, bench/row/press climbing 2.5 kg a week. Squat twice
// a week puts quads at 10 sets and hamstrings at 9 — both inside their MEV..MAV range,
// which is what makes this a recovery story rather than a volume one.
const ifSessions = () => {
  const set = (ex, w, r) => ({ exercise: ex, set_type: "work", weight_kg: w, reps: r });
  const out = [];
  for (let n = 0; n < 6; n++) {
    const base = 100 + n * 2.5;
    const D = (o) => new Date(Date.UTC(2026, 0, 5 + n * 7 + o)).toISOString().slice(0, 10);
    out.push(
      { session_id: "a" + n, date: D(0), sets: [...Array(5).fill(set("barbell-back-squat", 140, 5)), ...Array(4).fill(set("barbell-bench-press", base, 6))] },
      { session_id: "b" + n, date: D(2), sets: [...Array(4).fill(set("romanian-deadlift", 120, 8)), ...Array(4).fill(set("barbell-row", base - 20, 8)), ...Array(3).fill(set("barbell-overhead-press", base - 40, 6))] },
      { session_id: "c" + n, date: D(4), sets: [...Array(5).fill(set("barbell-back-squat", 140, 5)), ...Array(4).fill(set("barbell-bench-press", base, 6))] },
    );
  }
  return out;
};
const ifBw = (kgAt) => Array.from({ length: 6 }, (_, n) => ({ date: new Date(Date.UTC(2026, 0, 5 + n * 7)).toISOString().slice(0, 10), kg: kgAt(n) }));
const ifUser = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };

check("progressReport surfaces the interference read when legs stall, upper climbs, and weight is falling", () => {
  const rep = progressReport(ifUser, ifSessions(), ifBw((n) => 82 - n * 0.3), [], IF_NOW);
  assert.ok(rep.interference, "expected the pattern to fire");
  assert.equal(rep.interference.pattern, "lower-body-stall-asymmetry");
  assert.deepEqual(rep.interference.corroborators, ["unintended-deficit"]);
  // The two Progress surfaces must never name different lifts — both read one `stalls` array.
  const stalledIds = new Set(rep.stalls.map((s) => s.exercise));
  for (const s of rep.interference.stalled_lower) assert.ok(stalledIds.has(s.exercise), `${s.exercise} missing from stalls`);
  assert.deepEqual(rep.interference.stalled_lower.map((s) => s.exercise).sort(), ["barbell-back-squat", "romanian-deadlift"]);
  // The prescribed test comes from data/guidelines/, not from copy restated in the engine.
  assert.ok(/Halve your structured cardio/.test(rep.interference.note));
});

check("progressReport: the same pattern fires on persistent low check-ins with a flat bodyweight", () => {
  const checkins = Array.from({ length: 5 }, (_, n) => ({
    date: new Date(Date.UTC(2026, 1, 5 + n)).toISOString().slice(0, 10),
    sleep_quality: 2, energy: 2, mood: 2, motivation: 2, stress: 4,
  }));
  const rep = progressReport(ifUser, ifSessions(), ifBw(() => 82), [], IF_NOW, checkins);
  assert.ok(rep.interference);
  assert.deepEqual(rep.interference.corroborators, ["under-recovered"]);
});

check("progressReport: silent when nothing corroborates it — a plateau alone is just a plateau", () => {
  const rep = progressReport(ifUser, ifSessions(), ifBw((n) => 82 + n * 0.3), [], IF_NOW);
  assert.ok(rep.stalls.length >= 2, "the lifts should still read as stalled"); // the plateau card still fires
  assert.equal(rep.interference, null);
});

check("progressReport: interference stays null for a user with no data at all", () => {
  assert.equal(progressReport(ifUser, [], [], [], IF_NOW).interference, null);
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

check("#cloud-loop progressReport's bodyweight trend reflects the RECENT window, not a lifetime blend", () => {
  const now = "2026-07-26T10:00:00Z";
  const dAgo = (n) => new Date(+new Date(now) - n * 86400000).toISOString().slice(0, 10);
  // a past bulk: 20 weekly weigh-ins, steadily gaining, all well outside the 42-day window
  const staleGain = Array.from({ length: 20 }, (_, i) => ({ date: dAgo(185 - i * 7), kg: 78 + i * 0.3 }));
  // the last 3 weeks: a genuine cut, entirely inside the window
  const recentCut = [
    { date: dAgo(21), kg: 84.0 }, { date: dAgo(14), kg: 83.3 }, { date: dAgo(7), kg: 82.6 }, { date: dAgo(0), kg: 82.0 },
  ];
  const allBw = [...staleGain, ...recentCut];
  const lifetime = bodyweightTrend(allBw.map((b) => ({ date: b.date, bodyweight_kg: b.kg })));
  assert.ok(lifetime.slope_kg_per_week > 0, "the unwindowed lifetime series genuinely diverges (a meaningful test, not a wash)");
  const rep = progressReport(user, [], allBw, [], now);
  assert.equal(rep.energy_balance.direction, "deficit"); // the recent cut must win, not the 5-month-old bulk
  assert.ok(rep.bodyweight_trend.slope_kg_per_week < 0);
});

check("taperPhase: gates on beginner, missing date, the 14-day window, and past events", () => {
  assert.equal(taperPhase("2026-07-25", null, "intermediate"), null); // no goal date set
  assert.equal(taperPhase("2026-07-25", "2026-07-30", "beginner"), null); // programmatic peaking isn't a beginner decision
  assert.equal(taperPhase("2026-07-25", "2026-07-01", "intermediate"), null); // event already passed -> no-op, not an error
  assert.equal(taperPhase("2026-07-01", "2026-07-30", "intermediate"), null); // 29 days out, outside the 14-day window
  const early = taperPhase("2026-07-20", "2026-07-30", "intermediate"); // 10 days out
  assert.equal(early.setScale, 0.6);
  assert.equal(early.rirFloor, 2);
  const late = taperPhase("2026-07-27", "2026-07-30", "intermediate"); // 3 days out
  assert.equal(late.setScale, 0.4);
  assert.equal(late.rirFloor, 3);
});

check("taperPhase: final-week note corrects the carb-loading myth (Henselmans 2022) — not the early note", () => {
  const early = taperPhase("2026-07-20", "2026-07-30", "intermediate"); // 10 days out
  const late = taperPhase("2026-07-27", "2026-07-30", "intermediate"); // 3 days out
  assert.ok(/carb-load/i.test(late.note), "final taper week names carb-loading directly");
  assert.ok(!/carb-load/i.test(early.note), "the 2-week-out note doesn't front-load peak-week advice");
});

check("taperRir only ever eases the near edge AWAY from failure, never toward it", () => {
  assert.equal(taperRir("1-3", 2), "2-3");
  assert.equal(taperRir("0-1", 3), "3-4"); // hi is also below the floor -> widen to floor+1
  assert.equal(taperRir("3-4", 2), "3-4"); // already easier than the floor -> untouched
  assert.equal(taperRir(undefined, 2), undefined);
});

check("buildToday: an active taper OVERRIDES the mesocycle wave rather than compounding with it", () => {
  const intermediateUser = {
    profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, goal_event_date: "2026-07-30" },
    program: selectProgram({ training_status: "intermediate", days_per_week: 3 }),
    plan_meta: { block_start: "2026-06-01T00:00:00Z" },
    created_at: "2026-06-01T00:00:00Z",
  };
  const taperDay = buildToday(intermediateUser, [], null, [], "2026-07-27T12:00:00Z");
  assert.equal(taperDay.block, null); // never shown alongside the taper card — one explanation, not two
  assert.ok(taperDay.taper && taperDay.taper.days_until <= 7);
  assert.ok(/taper/i.test(taperDay.taper.note));
  const rawEx = intermediateUser.program.sessions[taperDay.index].exercises;
  taperDay.exercises.forEach((e) => {
    const raw = rawEx.find((r) => r.exercise === e.exercise);
    assert.ok(e.sets <= raw.sets); // taper never adds sets
    assert.ok(+e.rir.split("-")[0] >= 3); // 3 days out -> rirFloor 3, so every band's near edge is >= 3
  });

  const noTaperUser = { ...intermediateUser, profile: { ...intermediateUser.profile, goal_event_date: null } };
  const normalDay = buildToday(noTaperUser, [], null, [], "2026-07-27T12:00:00Z");
  assert.equal(normalDay.taper, null);
  assert.ok(normalDay.block); // clearing the goal date lets the mesocycle wave resume
});

check("taperPhase: day-granular local-frame math — survives event day, no off-by-one, no 15-day flicker", () => {
  // Event MORNING (a full UTC timestamp after midnight): the old instant-floor made
  // daysUntil -1 and returned the full mesocycle wave ("peak volume") on meet day.
  const eventDay = taperPhase("2026-07-30T09:00:00Z", "2026-07-30", "intermediate");
  assert.ok(eventDay, "the taper must hold ON the event day, not vanish");
  assert.equal(eventDay.daysUntil, 0);
  assert.equal(eventDay.setScale, 0.4);
  // Countdown is calendar-exact: the evening before the event is 1 day out, not 0.
  assert.equal(taperPhase("2026-07-29T18:00:00Z", "2026-07-30", "intermediate").daysUntil, 1);
  // 15 calendar days out, late in the day: the old fractional floor read 14.04 as 14
  // and flickered the taper on a day early — calendar math says 15 -> outside the window.
  assert.equal(taperPhase("2026-07-15T23:00:00Z", "2026-07-30", "intermediate"), null);
  // West of UTC (tz_offset_min = -420, US Pacific): Friday 17:01 local is Saturday
  // 00:01Z — the LOCAL frame is still Friday, so a Saturday event is 1 day out
  // (the old code, and the UTC fallback, would already call it event day).
  assert.equal(taperPhase("2026-08-01T00:01:00Z", "2026-08-01", "intermediate", -420).daysUntil, 1);
  assert.equal(taperPhase("2026-08-01T00:01:00Z", "2026-08-01", "intermediate").daysUntil, 0); // no tz known -> UTC date fallback
});

check("suggestWeight holdLoad (taper): both progression bumps are suppressed so the numbers match the card", () => {
  const hitTop = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
  ] }];
  const held = suggestWeight(hitTop, "barbell-bench-press", "6-10", undefined, null, null, true);
  assert.equal(held.suggested_kg, 100); // would be 102.5 outside a taper
  assert.ok(/hold this weight/i.test(held.note));
  const easy = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, rir: 4 },
  ] }];
  assert.equal(suggestWeight(easy, "barbell-bench-press", "6-10", undefined, null, null, true).suggested_kg, 100); // would be 105
});

check("buildToday: taper precedence in the high-readiness note, and honest copy on a comeback-in-taper", () => {
  const user = {
    profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, goal_event_date: "2026-07-15" },
    program: selectProgram({ training_status: "intermediate", days_per_week: 3 }),
    plan_meta: { block_start: "2026-06-01T00:00:00Z" }, // 2026-07-08 = day 37 -> mesocycle week 6 (deload)
    created_at: "2026-06-01T00:00:00Z",
  };
  // Week-6 deload overlapping the taper window + a high check-in: the note must
  // follow the taper (which governs the sets/RIR/card), never reference a deload
  // that is neither rendered nor applied.
  const t = buildToday(user, [], { level: "high", score: 5 }, [], "2026-07-08T12:00:00Z");
  assert.ok(t.taper, "taper active 7 days out");
  assert.ok(/taper/i.test(t.coach_note), "high-readiness note follows the taper");
  assert.ok(!/deload/i.test(t.coach_note), "the unrendered deload never narrates the screen");
  // A 13-day layoff ending inside the taper: loads are (correctly) eased, so the
  // taper card must not claim "the weight stays real" beside "I eased this" notes.
  const back = buildToday(user, [{ date: "2026-06-25T12:00:00Z", sets: [] }], null, [], "2026-07-08T12:00:00Z");
  assert.equal(back.comeback, true);
  assert.ok(/eased/i.test(back.taper.note), "taper copy is honest about the comeback ease");
  assert.ok(!/stays real|stays where it is/i.test(back.taper.note));
});

check("buildToday: a PER-EXERCISE comeback ease inside a taper (session-level layoff < 12) still makes the taper copy honest", () => {
  // The audit case: buildToday's comeback branch keys off SESSION-level layoff, but
  // suggestWeight eases PER-EXERCISE — a lift untrained >=12 days while the user
  // trained something else recently gets an eased weight, yet the taper card used to
  // still claim "the weight stays real." now = 5 days before the event (final taper).
  const now = "2026-07-27T12:00:00Z";
  const prog = selectProgram({ training_status: "intermediate", days_per_week: 3 });
  const n = prog.sessions.length;
  const todayIdx = 2 % n; // two fixture sessions logged below -> nextSessionIndex = 2 % n
  const Y = prog.sessions[todayIdx].exercises[0].exercise; // a lift on TODAY's card
  const user = {
    profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, goal_event_date: "2026-08-01" },
    program: prog,
    plan_meta: { block_start: "2026-07-01T00:00:00Z" },
    created_at: "2026-06-01T00:00:00Z",
  };
  const sessions = [
    // A recent session 3 days ago (empty sets) -> SESSION-level layoff = 3 (< 12),
    // so the whole-session comeback branch does NOT fire. It logs no Y sets, so Y's
    // OWN last-trained date stays the old session below.
    { date: "2026-07-24T12:00:00Z", sets: [] },
    // Y last trained 20 days ago -> per-exercise layoff 20 (>= 12) -> suggestWeight eases it.
    { date: "2026-07-07T12:00:00Z", sets: [
      { exercise: Y, set_type: "work", weight_kg: 100, reps: 8 },
      { exercise: Y, set_type: "work", weight_kg: 100, reps: 8 },
    ] },
  ];
  const t = buildToday(user, sessions, null, [], now);
  assert.ok(t.taper && t.taper.days_until === 5, "taper active, final week");
  assert.equal(t.comeback, false, "session-level comeback flag stays false (trained 3 days ago)");
  assert.equal(t.exercises.find((e) => e.exercise === Y)?.eased, true, "the untrained lift is per-exercise eased");
  assert.ok(!/stays real|stays where it is/i.test(t.taper.note), "taper note no longer claims the weight holds");
  assert.ok(/eased|haven't trained/i.test(t.taper.note), "taper note acknowledges the partial ease");
});

// --- the deload lever (Wave 165) -----------------------------------------
// The KB puts "manage fatigue (deload)" THIRD in its plateau order, before
// changing the exercise — but the only deloads that existed were the calendar
// week-6 one and the layoff comeback ease, neither of which responds to how
// training is actually going, and the user couldn't ask for one either.
const atCeiling = [{ muscle: "chest", signal: "change" }];
const roomToAdd = [{ muscle: "chest", signal: "add" }];
const blk = (week) => ({ week, of: 6, phase: week === 6 ? "deload" : week >= 4 ? "peak" : "build", setScale: 1 });

check("reactiveDeloadDue: fires for a muscle stalled AT its recoverable ceiling", () => {
  assert.equal(reactiveDeloadDue(atCeiling, blk(4), {}, 0), true);
});

check("reactiveDeloadDue: does NOT fire when there's still room below the ceiling", () => {
  // More sets is the right answer there — that's the volume lever, not this one.
  assert.equal(reactiveDeloadDue(roomToAdd, blk(4), {}, 0), false);
  assert.equal(reactiveDeloadDue([], blk(4), {}, 0), false);
});

check("reactiveDeloadDue: never in the first weeks of a block — there's no fatigue to shed yet", () => {
  assert.equal(reactiveDeloadDue(atCeiling, blk(1), {}, 0), false);
  assert.equal(reactiveDeloadDue(atCeiling, blk(2), {}, 0), false);
  assert.equal(reactiveDeloadDue(atCeiling, blk(3), {}, 0), true, "week 3 is the floor");
});

check("reactiveDeloadDue: never doubles up on a scheduled deload week", () => {
  assert.equal(reactiveDeloadDue(atCeiling, blk(6), {}, 0), false);
});

check("reactiveDeloadDue: at most ONCE per block", () => {
  assert.equal(reactiveDeloadDue(atCeiling, blk(4), { reactive_deload: { block: 0, week: "2026-W30" } }, 0), false, "already fired this block");
  assert.equal(reactiveDeloadDue(atCeiling, blk(4), { reactive_deload: { block: 0, week: "2026-W30" } }, 1), true, "a NEW block may fire again");
});

check("reactiveDeloadDue: beginners have no block at all, so nothing to bring forward", () => {
  assert.equal(reactiveDeloadDue(atCeiling, null, {}, 0), false);
});

check("buildToday: a stamped reactive-deload week actually deloads the session", () => {
  const now = new Date().toISOString();
  const wk = isoWeekKey(now);
  const prog = selectProgram({ training_status: "intermediate", days_per_week: 4 });
  const base = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4 }, program: prog };
  // Mid-block (week 3) so the scheduled wave is NOT a deload — any deload seen here
  // can only have come from the reactive stamp.
  const blockStart = new Date(Date.now() - 15 * 86400000).toISOString();
  const normal = buildToday({ ...base, plan_meta: { block_start: blockStart } }, [], null, [], now);
  const reactive = buildToday({ ...base, plan_meta: { block_start: blockStart, reactive_deload: { block: 0, week: wk } } }, [], null, [], now);
  assert.notEqual(normal.block.phase, "deload", "fixture sanity: the scheduled wave is not a deload this week");
  assert.equal(reactive.block.phase, "deload");
  assert.ok(/brought forward/i.test(reactive.block.note), "the card must explain WHY it arrived early");
  // Every downstream deload branch must follow, not just the label.
  assert.ok(reactive.exercises.every((e) => e.rir === "3-4"), "effort eases");
  const setsOf = (t) => t.exercises.reduce((a, e) => a + e.sets, 0);
  assert.ok(setsOf(reactive) < setsOf(normal), "volume drops");
});

check("buildToday: a stamp from a DIFFERENT week doesn't deload this one", () => {
  const now = new Date().toISOString();
  const prog = selectProgram({ training_status: "intermediate", days_per_week: 4 });
  const t = buildToday({ profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4 }, program: prog,
    plan_meta: { block_start: new Date(Date.now() - 15 * 86400000).toISOString(), reactive_deload: { block: 0, week: "2020-W01" } } }, [], null, [], now);
  assert.notEqual(t.block.phase, "deload");
});

check("#2D a comeback never lands beside 'peak volume — push hard' (lesson 24's sibling)", () => {
  const start = new Date(Date.now() - 120 * 86400000).toISOString();
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, plan_meta: { block_start: start },
    program: { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10" }] }] } };
  // Four trained weeks behind them (→ block week 5, "peak"), then a long layoff.
  const sessions = Array.from({ length: 4 }, (_, i) => ({
    date: new Date(+new Date(start) + i * 7 * 86400000).toISOString(),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }],
  }));
  const t = buildToday(u, sessions, null, [], new Date().toISOString());
  assert.equal(t.comeback, true, "fixture sanity: this IS a comeback");
  assert.ok(t.exercises[0].suggested_kg < 100, "fixture sanity: the weight is genuinely eased");
  assert.ok(!/push hard|push your sets hard/i.test(t.block?.note ?? ""),
    `the block card must not say "push hard" beside eased weights — got: ${t.block?.note}`);
  assert.ok(/picking up where you left off/i.test(t.block?.note ?? ""));
});

console.log(`\n${passed} coach test(s) passed.`);
