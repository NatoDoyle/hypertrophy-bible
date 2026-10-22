// Coach-logic unit tests (no web server, no deps). node:assert.
import assert from "node:assert/strict";
import { selectProgram, exerciseById } from "../src/kb.mjs";
import { isSpecializing } from "../src/planner.mjs";
import { generateUserPlan, userApplySubstitution } from "../src/planner.mjs";
import { applySubstitution } from "../../tools/plan-core.mjs";
import { exercises as kbExercises, muscles as kbMuscles, contraindications as kbContra, guidelines as kbGuidelines } from "../src/kb-data.mjs";
import { buildToday, todayCard, suggestWeight, estimateStartingWeight, sessionRecap, progressReport, nextSessionIndex, rotationState, upcomingSessions, gentleGapDays, dailyReadiness, computeVolumeAdjust, waveRir, taperPhase, taperRir, reactiveDeloadDue, sessionReadout, blockTuneDecision, swapStalls, stalledExerciseIds, nerdReport, trainingContext } from "../src/coach.mjs";
import { isLuckySet, LUCKY_SET_XP, bodyweightTrend, isoWeekKey, isoWeekKeyLocal } from "../../tools/derive-core.mjs";
import { servedLift } from "../src/coach.mjs";
import * as deriveCore from "../../tools/derive-core.mjs";

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
  // Anchored to a NON-first session on purpose. `buildToday(user, [])` is day one,
  // and a true beginner's day one is now capped at 4 exercises — so both sides of
  // this comparison would land on 4 and the assertion would pass or fail for a
  // reason that has nothing to do with readiness. This test is about the readiness
  // lever, so it must run where the readiness lever is the only thing moving.
  const prior = [{ session_id: "rdy-prior", date: new Date(Date.now() - 3 * 86400000).toISOString(), sets: [] }];
  const normalDay = buildToday(user, prior);
  const lowDay = buildToday(user, prior, { level: "low" });
  assert.ok(lowDay.exercises.length < normalDay.exercises.length); // trimmed the last accessory
  assert.ok(lowDay.coach_note); // and told the user why, kindly
  assert.equal(normalDay.first_session, null, "and neither side is a first session");
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

// Shared fixtures for the rotation-pointer tests below (skip / swap / gap note).
const rotProg = { id: "gen-mine", name: "P", sessions: [{ name: "A", exercises: [] }, { name: "B", exercises: [] }, { name: "C", exercises: [] }] };
const rotMine = (n) => ({ session_id: `rot-${n}`, date: `2026-06-0${n + 1}T18:00:00Z`, program_ref: "gen-mine", sets: [] });
const rotToday = (meta, sessions = []) => buildToday({ profile: { days_per_week: 3 }, plan_meta: meta, program: rotProg }, sessions);

check("rotation_skips advances the pointer without a session, and the skipped day returns next cycle", () => {
  assert.equal(rotToday({}).index, 0, "precondition: no skips opens at Day A");
  assert.equal(rotToday({ rotation_skips: 1 }).index, 1); // day-one skip: A skipped -> B due (works with zero sessions)
  assert.equal(rotToday({ rotation_skips: 1 }, [rotMine(0), rotMine(1)]).index, 0); // B and C logged -> cycle 1 opens at A: the skip cost one cycle, not the day
  assert.equal(rotToday({ rotation_skips: 2 }).index, 2); // double-skip is two slots
});

check("cycle_swap trades two days for THIS cycle, nothing dropped or doubled, then expires with the cycle", () => {
  const swap = { program: "gen-mine", cycle: 0, map: [2, 1, 0] }; // A<->C traded
  assert.equal(rotToday({ cycle_swap: swap }).index, 2);                          // slot 0 now serves C
  assert.equal(rotToday({ cycle_swap: swap }, [rotMine(0)]).index, 1);            // B keeps its slot
  assert.equal(rotToday({ cycle_swap: swap }, [rotMine(0), rotMine(1)]).index, 0); // A lands in C's old slot — displaced, never dropped
  // Cycle 1: rawIdx 0 again, but the map (which would send 0 -> 2) is expired — natural order resumes.
  assert.equal(rotToday({ cycle_swap: swap }, [rotMine(0), rotMine(1), rotMine(2)]).index, 0);
});

check("cycle_swap self-expires on a foreign program, wrong cycle, or malformed map — never errors", () => {
  assert.equal(rotToday({ cycle_swap: { program: "gen-other", cycle: 0, map: [2, 1, 0] } }).index, 0);
  assert.equal(rotToday({ cycle_swap: { program: "gen-mine", cycle: 1, map: [2, 1, 0] } }).index, 0);
  assert.equal(rotToday({ cycle_swap: { program: "gen-mine", cycle: 0, map: [2, 1] } }).index, 0);    // day count changed (plan edit)
  assert.equal(rotToday({ cycle_swap: { program: "gen-mine", cycle: 0, map: [2, 2, 0] } }).index, 0); // not a permutation
  assert.equal(rotToday({ cycle_swap: { program: "gen-mine", cycle: 0, map: "abc" } }).index, 0);     // not an array
});

check("a skip skips the DISPLAYED day when a swap is active (skip composes on top of the map)", () => {
  const swap = { program: "gen-mine", cycle: 0, map: [1, 0, 2] }; // A<->B traded: slot 0 shows B
  assert.equal(rotToday({ cycle_swap: swap }).index, 1, "precondition: the swap alone serves B first");
  assert.equal(rotToday({ cycle_swap: swap, rotation_skips: 1 }).index, 0); // skipping the displayed B serves A (slot 1)
});

check("todayCard headline and buildToday name agree under skips + swaps (lesson 1: one rotation pointer)", () => {
  const u = { profile: { days_per_week: 3 }, plan_meta: { rotation_skips: 2, cycle_swap: { program: "gen-mine", cycle: 0, map: [1, 0, 2] } }, program: rotProg };
  assert.equal(todayCard(u, []).headline, buildToday(u, []).name);
  const st = rotationState(rotProg, [], u.plan_meta);
  assert.equal(rotProg.sessions[st.idx].name, buildToday(u, []).name); // and the exported helper is that same pointer
});

// C16 (W277): the week strip lays the rotation onto the committed days, so the NEXT k
// sessions must come from the very pointer buildToday serves (lesson 1): slot j is what
// Today serves after j more sessions, with a day swap honoured only inside its own cycle.
const rotSwaps = [undefined, { program: "gen-mine", cycle: 0, map: [2, 1, 0] }, { program: "gen-mine", cycle: 1, map: [1, 0, 2] },
  { program: "gen-mine", cycle: 0, map: [0, 2, 1] }, { program: "gen-other", cycle: 0, map: [2, 1, 0] },
  { program: "gen-mine", cycle: 0, map: [2, 2, 0] }, { program: "gen-mine", cycle: 0, map: [1, 0] }];
check("#week upcomingSessions slot j IS what Today serves after j more sessions — over skips, live/stale/foreign/malformed swaps, and a rebase ABOVE the logged count", () => {
  let cases = 0;
  // rotation_base above the own count happens for real: a block rollover rebases to the
  // own count, then voiding an older workout drops the count below it (W277 review) — the
  // pointer clamps at Day A until the count catches up, and the projection must too.
  for (const cycle_swap of rotSwaps) for (let skips = 0; skips <= 3; skips++) for (let logged = 0; logged <= 4; logged++) for (const base of [0, 2, 5]) {
    const meta = { ...(cycle_swap ? { cycle_swap } : {}), ...(skips ? { rotation_skips: skips } : {}), ...(base ? { rotation_base: base } : {}) };
    const sessions = Array.from({ length: logged }, (_, i) => rotMine(i));
    const up = upcomingSessions(rotProg, sessions, meta, 4);
    assert.equal(up.length, 4);
    assert.equal(up[0], rotationState(rotProg, sessions, meta).idx, "slot 0 is the pointer itself");
    for (let j = 0; j < 4; j++) {
      const later = [...sessions, ...Array.from({ length: j }, (_, i) => rotMine(logged + i))];
      assert.equal(up[j], rotToday(meta, later).index, `swap ${JSON.stringify(cycle_swap)} skips ${skips} logged ${logged} base ${base}: slot ${j}`);
      cases++;
    }
  }
  assert.ok(cases >= 1500, `ran ${cases}`);
});
check("#week a day swap stops at its cycle's edge in the projection too (B·A·B, not B·C·B)", () => {
  const names = upcomingSessions(rotProg, [rotMine(0), rotMine(1)], { cycle_swap: { program: "gen-mine", cycle: 0, map: [0, 2, 1] } }, 3).map((i) => rotProg.sessions[i].name);
  assert.deepEqual(names, ["B", "A", "B"]);
  assert.deepEqual(upcomingSessions({ id: "x", sessions: [] }, [], {}, 3), [], "no sessions → nothing to project");
  assert.deepEqual(upcomingSessions(rotProg, [], {}, 0), []);
});

// W278 review: a SPENT specialization block (plan_meta.spec_spent, kept through a schedule
// rebuild) must reach the permanent "No machine" swap too — it re-orders the session, and
// would otherwise order it as if the block were still running (151 of 366 swaps measured).
check("#spec-spent the permanent swap honours a spent specialization block — the binder passes the flag the plan was built with", () => {
  const profile = { user_id: "spent-swap", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], priority_muscles: ["chest"] };
  const gen = generateUserPlan(profile, { blockIndex: 0, specSpent: true });
  const user = { profile, program: gen.program, plan_rationale: gen.rationale, plan_meta: { block_index: 0, spec_spent: true } };
  const kb = { exercises: kbExercises, muscles: kbMuscles, contraindications: kbContra, guidelines: kbGuidelines };
  let checked = 0, matters = 0;
  for (const s of gen.program.sessions) for (const e of s.exercises) {
    const viaBinder = userApplySubstitution(user, e.exercise, { sessionName: s.name });
    if (viaBinder.error) continue;
    checked++;
    const spent = applySubstitution(gen.program, gen.rationale, e.exercise, { profile, kb, blockIndex: 0, specSpent: true, sessionName: s.name });
    const running = applySubstitution(gen.program, gen.rationale, e.exercise, { profile, kb, blockIndex: 0, specSpent: false, sessionName: s.name });
    assert.deepEqual(viaBinder.program, spent.program, `${s.name}/${e.exercise}`);
    if (JSON.stringify(running.program) !== JSON.stringify(spent.program)) matters++;
  }
  assert.ok(checked > 3 && matters > 0, `the flag must change some swap here (checked ${checked}, matters ${matters})`);
});

check("gap_note: fires for a real miss scaled to days_per_week, never beside the comeback, never for a first-timer", () => {
  assert.equal(gentleGapDays(3), 5);
  assert.equal(gentleGapDays(2), 6);
  assert.equal(gentleGapDays(6), 4); // floor: never nags sooner than 4 days
  const now = "2026-06-10T18:00:00Z";
  const at = (daysAgo) => [{ session_id: "gap", date: new Date(+new Date(now) - daysAgo * 86400000).toISOString(), program_ref: "gen-mine", sets: [] }];
  const dpw3 = { profile: { days_per_week: 3 }, program: rotProg };
  assert.ok(buildToday(dpw3, at(5), null, [], now).gap_note, "5-day gap at 3/wk is a miss worth reassuring");
  assert.equal(buildToday(dpw3, at(3), null, [], now).gap_note, null, "3-day gap at 3/wk is routine rest");
  const dpw2 = { profile: { days_per_week: 2 }, program: rotProg };
  assert.equal(buildToday(dpw2, at(5), null, [], now).gap_note, null, "5-day gap at 2/wk is by design, not a miss");
  assert.ok(buildToday(dpw2, at(7), null, [], now).gap_note);
  const comeback = buildToday(dpw3, at(12), null, [], now);
  assert.ok(comeback.comeback, "precondition: 12 days is the comeback threshold");
  assert.equal(comeback.gap_note, null, "the comeback branch owns that card");
  assert.equal(buildToday(dpw3, [], null, [], now).gap_note, null, "never trained: there is no gap to reassure about");
  const both = buildToday(dpw3, at(5), { level: "normal", score: 3 }, [], now);
  assert.ok(both.gap_note && both.coach_note, "gap note and readiness note coexist without contradiction");
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

// --- W279 (owner: "ease the weight" when even the FIRST set falls below the range). The
// KB's own double-progression rule: "pick a weight you can do for at least the bottom of
// the range" (how-to-read-a-workout.md, Grade D). Margin: ≥ 2 reps short, or 1 short
// twice running; only when set 1 was near failure (RIR unlogged or ≤ 1); never during a
// taper; the comeback ease still comes first; never tagged as a comeback (it must anchor).
const brSet = (w, reps, extra = {}) => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: w, reps, ...extra });
const brDay = (d, ...sets) => ({ date: `2026-06-${String(d).padStart(2, "0")}T18:00:00Z`, sets });
check("#below-range set 1 two+ reps under the range eases to the load that lands in it (60×5 on 8-12 → 52.5)", () => {
  const r = suggestWeight([brDay(1, brSet(60, 5), brSet(60, 4))], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.equal(r.suggested_kg, 52.5);
  assert.match(r.note, /first set at 60 kg came in at 5 — under the 8–12 range — so I've lightened this to 52\.5 kg/);
  assert.equal(r.layoff_days, undefined, "never tagged as a comeback: the eased load must anchor next time");
  // a far miss is capped at about −20% (100×1 → 80, not 77.5): one set is not a re-test
  assert.equal(suggestWeight([brDay(1, brSet(100, 1))], "barbell-bench-press", "8-12", undefined, null, "1-3").suggested_kg, 80);
  // a dumbbell isolation eases in its own 1 kg steps (10×8 on 12-20 → 8)
  const lat = (w, reps) => ({ exercise: "dumbbell-lateral-raise", set_type: "work", weight_kg: w, reps });
  assert.equal(suggestWeight([brDay(1, lat(10, 8))], "dumbbell-lateral-raise", "12-20", undefined, null, "1-3").suggested_kg, 8);
});
check("#below-range one rep short holds the first time — and eases when it happens twice running", () => {
  const once = suggestWeight([brDay(1, brSet(60, 7))], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.equal(once.suggested_kg, 60);
  assert.match(once.note, /just under the range.*if it happens again, I'll lighten it/i);
  const twice = suggestWeight([brDay(1, brSet(60, 7)), brDay(3, brSet(60, 7))], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.equal(twice.suggested_kg, 55, "74 e1RM → 56.9 → 55 (a full increment down)");
  // a miss at a LIGHTER weight last time is no evidence at today's heavier anchor
  assert.equal(suggestWeight([brDay(1, brSet(57.5, 7)), brDay(3, brSet(60, 7))], "barbell-bench-press", "8-12", undefined, null, "1-3").suggested_kg, 60);
});
check("#below-range never eases a set stopped early (RIR ≥ 2), under a taper, at bodyweight, or ahead of a comeback", () => {
  assert.equal(suggestWeight([brDay(1, brSet(60, 5, { rir: 3 }))], "barbell-bench-press", "8-12", undefined, null, "1-3").suggested_kg, 60, "stopped with 3 in the tank: not too heavy");
  assert.equal(suggestWeight([brDay(1, brSet(60, 5))], "barbell-bench-press", "8-12", undefined, null, "1-3", true).suggested_kg, 60, "taper: the load holds");
  assert.equal(suggestWeight([brDay(1, brSet(0, 5))], "barbell-bench-press", "8-12", undefined, null, "1-3").suggested_kg, 0, "bodyweight: nothing to ease");
  const back = suggestWeight([brDay(1, brSet(60, 5))], "barbell-bench-press", "8-12", undefined, "2026-06-20T18:00:00Z", "1-3");
  assert.match(back.note, /It's been 19 days/, "the comeback ease still comes first");
});
// --- W280 (owner: "hold until every set is done"): double progression adds load once EVERY
// prescribed set reaches the top of the range (how-to-read-a-workout.md: "on all your sets").
// When the anchor session's stored target shows fewer sets done than planned — a skipped
// set, or a workout ended early — that wasn't shown, so the top-of-range bump waits.
const tgt3 = [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3", suggested_kg: 100 }];
const withTargets = (targets, ...sets) => ({ date: "2026-06-01T18:00:00Z", sets, ...(targets ? { targets } : {}) });
check("#skipped-hold 2 of 3 planned sets at the top of the range: the weight holds, and says what earns the bump", () => {
  const r = suggestWeight([withTargets(tgt3, brSet(100, 10), brSet(100, 10))], "barbell-bench-press", "6-10", undefined, null, "1-3");
  assert.equal(r.suggested_kg, 100);
  assert.match(r.note, /You did 2 of 3 sets last time — get all 3 to the top of the range, then I'll add weight\./);
  assert.equal(suggestWeight([withTargets(tgt3, brSet(100, 10), brSet(100, 10), brSet(100, 10))], "barbell-bench-press", "6-10", undefined, null, "1-3").suggested_kg, 102.5, "all 3 → the bump");
});
check("#skipped-hold no targets (an older session) is byte-identical; logged effort that says 'too light' still bumps", () => {
  assert.deepEqual(suggestWeight([withTargets(null, brSet(100, 10), brSet(100, 10))], "barbell-bench-press", "6-10", undefined, null, "1-3"),
    { suggested_kg: 102.5, note: "Last time you hit the top of the range — add 2.5 kg.", last_kg: 100, last_reps: [10, 10], last_sets: [[100, 10], [100, 10]] });
  assert.ok(suggestWeight([withTargets(tgt3, brSet(100, 8, { rir: 5 }), brSet(100, 8, { rir: 5 }))], "barbell-bench-press", "6-10", undefined, null, "1-3").suggested_kg > 100,
    "RIR 5 against a 1-3 band is direct evidence the load is light — a skipped set doesn't cancel it");
  assert.equal(suggestWeight([withTargets([{ ...tgt3[0], sets: 2 }], brSet(100, 10), brSet(100, 10), brSet(100, 10))], "barbell-bench-press", "6-10", undefined, null, "1-3").suggested_kg, 102.5,
    "an extra set beyond the plan is no shortfall");
});

check("#next-set buildToday rows carry the lift's real load step — 2.5 kg for a barbell compound, 1 kg for a dumbbell isolation", () => {
  const prog = { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }, { exercise: "dumbbell-lateral-raise", sets: 3, rep_range: "12-20", rir: "1-3" }] }] };
  const rows = buildToday({ profile: { training_status: "intermediate", days_per_week: 3 }, program: prog }, []).exercises;
  assert.deepEqual(rows.map((r) => r.inc_kg), [2.5, 1]);
});
// --- Burst 1 review: the ANCHOR is the heaviest weight proved in the range (a set at or
// above its bottom), else set 1. Set-1 anchoring punished following W279b's own "go heavier"
// hint (60×14 → hinted 62.5×10,10 suggested 60 next time) and a warm-up-style ramp.
const rSet = (w, reps, extra = {}) => brSet(w, reps, extra);
check("#anchor taking the heavier hint is never punished: the next suggestion starts from the hinted weight", () => {
  const sug = (...sets) => suggestWeight([brDay(1, ...sets)], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.equal(sug(rSet(60, 14), rSet(62.5, 10), rSet(62.5, 10)).suggested_kg, 62.5, "62.5 × 10, 10: keep 62.5, add reps");
  assert.equal(sug(rSet(60, 14), rSet(62.5, 12), rSet(62.5, 12)).suggested_kg, 65, "62.5 at the top of the range: add load FROM 62.5");
  assert.equal(sug(rSet(60, 14), rSet(62.5, 10)).suggested_kg, 62.5, "a 2-set lift too");
  assert.equal(sug(rSet(40, 12), rSet(50, 12), rSet(60, 10)).suggested_kg, 60, "a ramp anchors on the weight it climbed to");
});
check("#anchor a heavier set that FAILED the range never becomes the anchor (a one-off heavy single is ignored)", () => {
  const r = suggestWeight([brDay(1, rSet(60, 10), rSet(60, 10), rSet(60, 10), rSet(80, 3))], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.equal(r.suggested_kg, 60);
  assert.deepEqual(r.last_sets, [[60, 10], [60, 10], [60, 10], [80, 3]], "the player can still show every set honestly");
});
check("#below-range a set AT the anchor that reached the range means the weight works — no ease (60×6, 60×9, 60×9)", () => {
  assert.equal(suggestWeight([brDay(1, rSet(60, 6), rSet(60, 9), rSet(60, 9))], "barbell-bench-press", "8-12", undefined, null, "1-3").suggested_kg, 60);
});
check("#anchor taking the LIGHTER hint holds at the weight that worked (100×6 then 90×9, 90×8 → 90)", () => {
  const r = suggestWeight([brDay(1, rSet(100, 6), rSet(90, 9), rSet(90, 8))], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.equal(r.suggested_kg, 90);
  assert.equal(r.last_kg, 90);
});
check("#below-range the RIR band moves the load (a '2-3' band eases further than '1-3'; the band's near edge is read)", () => {
  assert.equal(suggestWeight([brDay(1, rSet(60, 6))], "barbell-bench-press", "8-12", undefined, null, "2-3").suggested_kg, 52.5, "60·1.2/(1+10/30) = 54 → 52.5");
  assert.equal(suggestWeight([brDay(1, rSet(60, 6))], "barbell-bench-press", "8-12", undefined, null, "1-3").suggested_kg, 55, "60·1.2/1.3 = 55.4 → 55");
});
check("#below-range at least one increment down: a near-zero ease still moves (and never claims a change it didn't make)", () => {
  // 60×5 @ RIR 1 on 6-10, band "0-1", twice: raw = 60·1.2/1.2 = 60 exactly → clamped to 57.5
  const r = suggestWeight([brDay(1, rSet(60, 5, { rir: 1 })), brDay(3, rSet(60, 5, { rir: 1 }))], "barbell-bench-press", "6-10", undefined, null, "0-1");
  assert.equal(r.suggested_kg, 57.5);
  assert.ok(!/to 60 kg/.test(r.note), r.note);
});
check("#below-range judged against the range each session was DONE in (its stored target), not today's", () => {
  // 100×5 on a 4-6 heavy day (in range), then 100×9 on today's 10-15: one miss, not two
  const heavy = { ...brDay(1, rSet(100, 5)), targets: [{ exercise: "barbell-bench-press", sets: 1, rep_range: "4-6", rir: "1-3", suggested_kg: 100 }] };
  const r = suggestWeight([heavy, brDay(3, rSet(100, 9))], "barbell-bench-press", "10-15", undefined, null, "1-3");
  assert.equal(r.suggested_kg, 100, "the 4-6 day was in ITS range — no second strike");
  assert.match(r.note, /just under the range/i);
  // …while TODAY's range still converts the load: 100×5 from a 4-6 day is far too heavy for 10-15
  const own = { ...brDay(1, rSet(100, 5)), targets: [{ exercise: "barbell-bench-press", sets: 1, rep_range: "4-6", rir: "1-3", suggested_kg: 100 }] };
  assert.ok(suggestWeight([own], "barbell-bench-press", "10-15", undefined, null, "1-3").suggested_kg < 90, "a heavy-day load is converted for a light-day range");
});
check("#below-range the ease's copy promises only what the model computes: the FIRST set lands in the range", () => {
  const r = suggestWeight([brDay(1, rSet(60, 5))], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.match(r.note, /your first set should land in the range/);
  assert.doesNotMatch(r.note, /every set/);
  const capped = suggestWeight([brDay(1, rSet(100, 1))], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.match(capped.note, /as far as I'll drop it in one go/, "when the 20% cap binds, the first set may still miss — say so");
});
// The suggestion's reason now reaches the set screen (Burst 1 review), so it must describe
// the weight actually pre-filled: in a deload week buildToday serves min(suggestion, last×0.9),
// and "add 2.5 kg" beside a weight 10% lighter would contradict the screen.
check("#note a deload week's lighter weight comes with a deload reason, never the progression's 'add 2.5 kg'", () => {
  const now = "2026-06-10T18:00:00Z";
  const prog = { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }] }] };
  const u = { profile: { training_status: "intermediate", days_per_week: 3 }, program: prog,
    plan_meta: { block_start: "2026-05-01T00:00:00Z", reactive_deload: { block: 0, week: isoWeekKeyLocal(now, null) } } };
  const row = buildToday(u, [{ date: "2026-06-08T18:00:00Z", program_ref: "p", sets: [brSet(100, 10), brSet(100, 10), brSet(100, 10)] }], null, [], now).exercises[0];
  assert.equal(row.suggested_kg, 90, "precondition: the deload eases 10% (min(102.5, 90))");
  assert.doesNotMatch(row.suggestion_note, /add 2\.5 kg/);
  assert.match(row.suggestion_note, /Deload week/);
});
check("#below-range anything in the range is byte-identical to before", () => {
  const r = suggestWeight([brDay(1, brSet(60, 9), brSet(60, 8))], "barbell-bench-press", "8-12", undefined, null, "1-3");
  assert.deepEqual(r, { suggested_kg: 60, note: "Keep the weight and try to add a rep or two.", last_kg: 60, last_reps: [9, 8], last_sets: [[60, 9], [60, 8]] });
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

check("suggestWeight: back-off sets don't corrupt the top set's progression (C14)", () => {
  // The anchor is set 1's weight, but reps/RIR were judged across ALL sets — so a
  // lighter back-off could both deny an earned bump and fabricate an unearned one.
  // (a) Earned: the top set hit the range ceiling; a lighter back-off that didn't
  // is a different load, not a failure at the anchor weight.
  const pyramid = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 80, reps: 8 },
  ] }];
  assert.equal(suggestWeight(pyramid, "barbell-bench-press", "6-10").suggested_kg, 102.5,
    "the 80 kg back-off is not evidence against the 100 kg top set");
  // (b) Fabricated: very easy back-offs must not average a load bump onto a top
  // set that had nothing left (rir 1 at the anchor weight).
  const polluted = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, rir: 1 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 80, reps: 8, rir: 6 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 80, reps: 8, rir: 6 },
  ] }];
  assert.equal(suggestWeight(polluted, "barbell-bench-press", "6-10").suggested_kg, 100,
    "rir 1 at the anchor weight is not a green light, whatever the back-offs say");
  // Straight sets are byte-identical to the old read (every set IS at the anchor).
  const straight = [{ date: "2026-06-01T18:00:00Z", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 },
  ] }];
  assert.equal(suggestWeight(straight, "barbell-bench-press", "6-10").suggested_kg, 102.5);
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
  // a lone first week is still shown (no earlier week to fall back to) AND
  // gets the same "still in progress" honesty note as the fallback case above —
  // this is every brand-new user's very first Progress-tab visit.
  const lone = full(["2026-06-08", "2026-06-10"]);
  const repLone = progressReport(user, lone, [], [], now);
  assert.equal(repLone.latest_week, "2026-W24");
  assert.ok(repLone.volume_note && /in progress/i.test(repLone.volume_note));
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

check("#19b specialization EASED muscles read 'eased' (slow growth), and 'add volume' stays suppressed", () => {
  // Wave 255: an eased muscle is deliberately capped at MEV — below-MEV raw numbers
  // are the block working, not under-dosing, and "add sets" advice would fight the
  // plan. Over-MRV honesty must still pass (the eased dose can never explain that).
  const now = "2026-06-10T10:00:00Z";
  const user = { profile: { training_status: "advanced", primary_goal: "recomposition", days_per_week: 4 },
    plan_rationale: { volume_by_muscle: { chest: { eased: true, target_sets: 8 } } } };
  const sessions = [{ session_id: "e1", date: "2026-06-02", sets: [
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 },
    { exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 },
  ] }];
  const rep = progressReport(user, sessions, [], [], now);
  const chest = rep.volumeByMuscle.find((v) => v.id === "chest");
  assert.equal(chest.status, "eased");
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
  const adj = computeVolumeAdjust({ chest: 6 }, sessions).adjust;
  assert.equal(adj.chest, 4, `stalled at ceiling should EASE +6→+4, got ${adj.chest}`);
});

check("computeVolumeAdjust recovery gate (Increment A): under-recovery holds the bump the tune would otherwise make", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const wk = (n, sets) => ({ date: day(n), sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  // chest (bench primary) stalled at 12 working sets/wk — room below MAV.max — flat e1RM 5 weeks.
  const sessions = [wk(35, 12), wk(28, 12), wk(21, 12), wk(14, 12), wk(7, 12)];
  // no recovery context → the tune ADDS volume to the stalled-with-room muscle (+2 from +2 → +4)
  assert.equal(computeVolumeAdjust({ chest: 2 }, sessions).adjust.chest, 4);
  // 5 low check-ins (avg readiness ~2/5) → under-recovered → the add is SUPPRESSED, holds at +2
  const lowCheckins = Array.from({ length: 5 }, (_, i) => ({ date: `2026-06-0${i + 1}`, sleep_quality: 2, energy: 2, stress: 4, mood: 2, motivation: 2 }));
  assert.equal(computeVolumeAdjust({ chest: 2 }, sessions, [], { checkins: lowCheckins }).adjust.chest, 2);
  // losing bodyweight on a gain goal → energy deficit → likewise holds (stall needs fuel, not sets)
  const bwDown = Array.from({ length: 6 }, (_, i) => ({ date: `2026-06-0${i + 1}`, kg: 85 - i * 0.3 }));
  assert.equal(computeVolumeAdjust({ chest: 2 }, sessions, [], { bodyweights: bwDown, goal: "hypertrophy" }).adjust.chest, 2);
});

check("computeVolumeAdjust individualized patience (Increment B): a slow responder's own rhythm isn't a stall", () => {
  const wkDate = (i) => { const d = new Date(Date.UTC(2026, 0, 5)); d.setUTCDate(d.getUTCDate() + i * 7); return d.toISOString().slice(0, 10); };
  // 12 chest sets/wk (room below MAV.max); bench PRs only every ~5 weeks (slow but real), then 4 flat weeks.
  const week = (i, kg) => ({ local_date: wkDate(i), sets: Array.from({ length: 12 }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: kg, reps: 8 })) });
  const full = []; for (let i = 0; i < 15; i++) full.push(week(i, 100 + Math.floor(i / 5) * 10));
  // personal cadence ~5wk → the stall window stretches to ~8 → the recent 4-week flat is NOT a plateau → no bump
  assert.equal(computeVolumeAdjust({}, full).adjust.chest, undefined);
  // the SAME recent flat weeks WITHOUT the track record (cadence unknown → default 4-week window) DO read as a
  // stall → bump. This is the whole point of Increment B: identical recent data, different verdict by history.
  assert.equal(computeVolumeAdjust({}, full.slice(9)).adjust.chest, 2);
});

check("computeVolumeAdjust effort gate (Increment C): a sandbagged stall HOLDS — the fix is effort, not sets", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const wk = (n, rir) => ({ date: day(n), sets: Array.from({ length: 12 }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, ...(rir != null ? { rir } : {}) })) });
  // chest stalled at 12 sets/wk with room below MAV.max, 5 flat weeks — the Increment-A baseline fixture.
  const noRir = [wk(35), wk(28), wk(21), wk(14), wk(7)];
  const easy = [wk(35, 4), wk(28, 4), wk(21, 4), wk(14, 4), wk(7, 4)];
  // no effort data → +2 exactly as today (the binder-level absent-data guard)
  assert.equal(computeVolumeAdjust({ chest: 2 }, noRir).adjust.chest, 4);
  // 60 recent sets averaging rir 4 vs bench's tier target 3 (stability "moderate" → heavy band "1-3")
  // → clear logged surplus → the add is HELD; more sets would just be more easy sets
  assert.equal(computeVolumeAdjust({ chest: 2 }, easy).adjust.chest, 2);
  // compliant effort (rir 3 = the band top) never trips the gate — the bump still fires
  const compliant = [wk(35, 3), wk(28, 3), wk(21, 3), wk(14, 3), wk(7, 3)];
  assert.equal(computeVolumeAdjust({ chest: 2 }, compliant).adjust.chest, 4);
});

check("computeVolumeAdjust reports WHO was held and WHY — a suppressed add must not be silent (Wave 258)", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const wk = (n, sets) => ({ date: day(n), sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  const sessions = [wk(35, 12), wk(28, 12), wk(21, 12), wk(14, 12), wk(7, 12)];
  // Ungated: the add fires, nothing is held.
  assert.deepEqual(computeVolumeAdjust({ chest: 2 }, sessions).held, []);
  // Recovery-gated: the add is suppressed AND the suppression is reported, so the
  // new-block note can say WHY instead of saying nothing (the gate was invisible:
  // a gated add produced no delta, no delta produced no sentence).
  const lowCheckins = Array.from({ length: 5 }, (_, i) => ({ date: `2026-06-0${i + 1}`, sleep_quality: 2, energy: 2, stress: 4, mood: 2, motivation: 2 }));
  assert.deepEqual(computeVolumeAdjust({ chest: 2 }, sessions, [], { checkins: lowCheckins }).held, [{ muscle: "chest", reason: "recovery" }]);
  // Deficit-gated: same shape, deficit reason (deficit outranks recovery in the label).
  const bwDown = Array.from({ length: 6 }, (_, i) => ({ date: `2026-06-0${i + 1}`, kg: 85 - i * 0.3 }));
  assert.deepEqual(computeVolumeAdjust({ chest: 2 }, sessions, [], { bodyweights: bwDown, goal: "hypertrophy" }).held, [{ muscle: "chest", reason: "deficit" }]);
});

// --- Consideration #1: "how does the program adapt when someone is inconsistent?" A stall on
// about half the planned sets is under-training, not a plateau: the tune holds (and says
// why), the Progress card says the same thing, and a custom plan (whose rationale may not
// describe it) stays permissive.
const cWk = (n, sets) => ({ date: new Date(Date.now() - n * 86400000).toISOString(), sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
const halfDone = [cWk(35, 6), cWk(28, 6), cWk(21, 6), cWk(14, 6), cWk(7, 6)];
const fullDone = [cWk(35, 12), cWk(28, 12), cWk(21, 12), cWk(14, 12), cWk(7, 12)];
const planVol = { chest: { projected_sets: 12 } };
check("#completion the tune HOLDS a stall on about half the planned sets, and reports why; a completing stall still adds", () => {
  assert.equal(computeVolumeAdjust({}, halfDone).adjust.chest, 2, "precondition: without the plan's numbers it adds");
  const r = computeVolumeAdjust({}, halfDone, [], { planVolume: planVol });
  assert.equal(r.adjust.chest, undefined);
  assert.deepEqual(r.held, [{ muscle: "chest", reason: "completion", realized: 6, planned: 12 }]);
  assert.deepEqual(r.notCompleting, ["chest"]);
  assert.equal(computeVolumeAdjust({}, fullDone, [], { planVolume: planVol }).adjust.chest, 2, "12 of 12: a real plateau still earns +2");
  const lowCheckins = Array.from({ length: 5 }, (_, i) => ({ date: `2026-06-0${i + 1}`, sleep_quality: 2, energy: 2, stress: 4, mood: 2, motivation: 2 }));
  assert.equal(computeVolumeAdjust({}, halfDone, [], { planVolume: planVol, checkins: lowCheckins }).held[0].reason, "completion", "the missing work is named before recovery");
});
check("#completion the Progress card agrees with the tune: 'finish the planned sets', never 'add sets' (one sample, C6)", () => {
  const user = { profile: { primary_goal: "hypertrophy", training_status: "intermediate" }, program: { id: "p", sessions: [] }, plan_rationale: { volume_by_muscle: planVol } };
  const now = new Date().toISOString();
  const a = progressReport(user, halfDone, [], [], now).adaptive.find((x) => x.muscle === "chest");
  assert.equal(a?.signal, "complete", JSON.stringify(a));
  assert.match(a.advice, /about 6 of the ~12 sets a week/);
  const custom = { ...user, program: { ...user.program, custom: true } };
  assert.notEqual(progressReport(custom, halfDone, [], [], now).adaptive.find((x) => x.muscle === "chest")?.signal, "complete", "a hand-built plan: permissive");
});
check("#completion the new-block note says why a stalled muscle's sets didn't move — kindly, with the lever", () => {
  const prog = { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }] }] };
  const u = { profile: { training_status: "intermediate", days_per_week: 4 }, program: prog,
    plan_meta: { block_start: "2026-01-01T00:00:00Z", rotated_at: "2026-06-01T00:00:00Z", tuned_this_block: { bumped: [], eased: [], held: [{ muscle: "chest", reason: "completion", realized: 6, planned: 12 }] } } };
  const note = buildToday(u, [], null, [], "2026-06-02T09:00:00Z").coach_note;
  assert.match(note, /Chest/i);
  assert.match(note, /about 6 of its ~12 planned sets/);
  assert.match(note, /held/);
  assert.doesNotMatch(note, /deficit|recovery's been short/);
});
check("progressReport's adaptive signal reads the PEAK sample the tune acts on — the card can't promise the opposite of the action (C6)", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const wk = (n, sets) => ({ date: day(n), sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  // Chest peaked at 18 sets (>= mav.max 18) five weeks ago, settled at 12, stalled
  // throughout: the card read the reference week (12 < 18 → "add… I'm adding sets
  // next block") while the tune read the peak (18 >= 18 → −2). Measured live before
  // this test was written. One sample now feeds both.
  const sessions = [wk(35, 18), wk(28, 12), wk(21, 12), wk(14, 12), wk(7, 12)];
  const u = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };
  const rep = progressReport(u, sessions, [], [], new Date().toISOString());
  const chest = (rep.adaptive || []).find((a) => a.muscle === "chest");
  assert.equal(chest?.signal, "change", "peak >= mav.max is the ceiling — the same read the tune eases on");
  const { adjust } = computeVolumeAdjust({}, sessions);
  assert.equal(adjust.chest, -2, "…and the tune agrees from the same sample");
});

check("an add signal under the whole-athlete deficit/recovery gate carries `gated` (the card must not promise sets the tune won't add)", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const wk = (n, sets) => ({ date: day(n), sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  const sessions = [wk(35, 12), wk(28, 12), wk(21, 12), wk(14, 12), wk(7, 12)];
  const u = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };
  // Declining bodyweight inside the 42-day window → deficit → every add is gated.
  const bwDown = Array.from({ length: 6 }, (_, i) => ({ date: day(30 - i * 5).slice(0, 10), kg: 85 - i * 0.3 }));
  const rep = progressReport(u, sessions, bwDown, [], new Date().toISOString());
  const chest = (rep.adaptive || []).find((a) => a.muscle === "chest");
  assert.equal(chest?.signal, "add", "fixture sanity: stalled with room reads add");
  assert.equal(chest?.gated, "deficit", "…and the row says the tune will hold it");
  // Without the gate, no marker.
  const clean = progressReport(u, sessions, [], [], new Date().toISOString());
  assert.equal((clean.adaptive || []).find((a) => a.muscle === "chest")?.gated, undefined);
});

check("progressReport ships the FULL progression and PR lists beside the capped ones (owner #3: Full progress views)", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const lifts = ["barbell-bench-press", "barbell-back-squat", "conventional-deadlift", "barbell-overhead-press", "barbell-row", "lat-pulldown", "leg-press", "dumbbell-bench-press", "romanian-deadlift", "skullcrusher"];
  // 10 lifts × 3 rising weeks → progression stays capped at 8, _all carries all 10;
  // every weekly best is a PR event, so the full PR list far exceeds the 8-row feed.
  const sessions = [3, 2, 1].map((w) => ({ session_id: `pw-${w}`, date: day(w * 7), sets: lifts.map((ex) => ({ exercise: ex, set_type: "work", weight_kg: 100 + (3 - w) * 5, reps: 8 })) }));
  const u = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };
  const rep = progressReport(u, sessions, [], [], new Date().toISOString());
  assert.equal(rep.progression.length, 8, "the display list keeps its 8-row contract");
  assert.equal(rep.progression_all.length, 10, "…while _all carries every lift with 2+ weeks");
  assert.ok(rep.progression_all.every((p) => Array.isArray(p.series) && p.series.every((pt) => pt.week && typeof pt.value === "number")), "each row ships its dated series");
  assert.equal(rep.personal_records.length, 8, "the PR feed keeps its 8-row contract");
  assert.equal(rep.personal_records_all.length, rep.pr_count, "…while _all is the complete history the count already promised");
  assert.ok(rep.personal_records_all.every((pr) => pr.name && pr.date), "each PR row is renderable (name + date)");
});

check("bodyweight_series spans the FULL history while bodyweight_trend keeps the 42-day window", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  // ≥3 recent points AND an old row — without the old row the sparse fallback makes
  // windowed and full history silently identical, and this test would pass on the
  // old code (lesson 54's exact class, caught twice before).
  const bw = [{ date: day(100), kg: 100 }, { date: day(20), kg: 80 }, { date: day(12), kg: 80.2 }, { date: day(5), kg: 80.1 }, { date: day(1), kg: 80 }];
  const u = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };
  const rep = progressReport(u, [], bw, [], new Date().toISOString());
  assert.equal(rep.bodyweight_series.length, 5, "the drawn series carries the whole log, incl. the 100-day-old row");
  assert.equal(rep.bodyweight_trend.n, 4, "…while the trend stays on the 42-day window (the adaptive read is untouched)");
});

check("an over-MRV muscle's reduce signal survives the adaptive filter chain (C7's server half)", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const wk = (n, sets) => ({ date: day(n), sets: Array.from({ length: sets }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  // 24 weekly chest sets > mrv.max 22 — no stall required; reduce ranks first.
  const sessions = [wk(21, 24), wk(14, 24), wk(7, 24)];
  const u = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };
  const rep = progressReport(u, sessions, [], [], new Date().toISOString());
  const chest = (rep.adaptive || []).find((a) => a.muscle === "chest");
  assert.equal(chest?.signal, "reduce", "over-MRV must reach the client as an instruction, not only a chip");
});

check("progressReport effort lever (Increment C): a too-easy stall reads 'effort'; the same history without rir reads 'add'", () => {
  const now = "2026-06-10T10:00:00Z"; // Wed of 2026-W24 → latest full week is W23
  const user = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3 } };
  const wkDates = ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", "2026-06-01"]; // W19..W23
  const week = (d, rir) => ({ session_id: "e" + d, date: d, sets: Array.from({ length: 12 }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, ...(rir != null ? { rir } : {}) })) });
  const easy = wkDates.map((d) => week(d, 4));
  const noRir = wkDates.map((d) => week(d));
  const effRow = progressReport(user, easy, [], [], now).adaptive.find((a) => a.muscle === "chest");
  assert.equal(effRow?.signal, "effort");
  assert.ok(/closer|failure|reserve/i.test(effRow.advice), "the advice names the effort fix");
  const addRow = progressReport(user, noRir, [], [], now).adaptive.find((a) => a.muscle === "chest");
  assert.equal(addRow?.signal, "add"); // absent effort data → today's behavior, untouched
});

// THE BINDER half of the goal-aware effort band. derive-core's own tests prove
// effortBandTop reads the goal; only a test through the binder can prove coach.mjs
// actually PASSES it (lesson 19: a scoping contract stated in a comment isn't
// enforced, and the pure-core test can't catch it — it's handed the goal directly).
check("progressReport effort lever is goal-aware THROUGH the binder: strength's reserved accessory band isn't sandbagging", () => {
  const now = "2026-06-10T10:00:00Z"; // Wed of 2026-W24 → latest full week is W23
  const wkDates = ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", "2026-06-01"]; // W19..W23
  // rir 2 curls: compliant with strength's prescribed isolation band ("1-3"),
  // genuinely under-effort against hypertrophy's ("0-1"). Same history both times.
  const sessions = wkDates.map((d) => ({ session_id: "g" + d, date: d, sets: Array.from({ length: 12 }, () => ({ exercise: "band-biceps-curl", set_type: "work", weight_kg: 20, reps: 12, rir: 2 })) }));
  const forGoal = (primary_goal) => progressReport({ profile: { training_status: "intermediate", primary_goal, days_per_week: 3 } }, sessions, [], [], now)
    .adaptive.find((a) => a.muscle === "biceps");
  assert.equal(forGoal("hypertrophy")?.signal, "effort", "0-1 band: rir 2 really is short of the prescription");
  assert.notEqual(forGoal("strength")?.signal, "effort", "1-3 band: the same rir 2 is exactly what the plan asked for");
});

// The in-progress LOCAL week must never be read as the "last full week" (Wave 180).
// Sunday 23:30 in California is already Monday 06:30 UTC: the user is mid-week, the
// server's calendar has rolled. sessionWeekKey reads local_date, so the sessions sat
// in the local week while nowWeek read the UTC one — the in-progress week wasn't
// excluded, so a week with a single session became the reference the volume card
// judges against, and a compliant lifter was told to add sets.
check("progressReport: the current week is the USER's week, not the server's", () => {
  const u = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, tz_offset_min: -480 } };
  const sess = (localDate, n) => ({ session_id: "w" + localDate, date: `${localDate}T20:00:00.000Z`, local_date: localDate,
    sets: Array.from({ length: n }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  // Two full local weeks of real work, then ONE session in the week still in progress.
  const sessions = [sess("2026-06-29", 12), sess("2026-07-06", 12), sess("2026-07-12", 2)];
  const nowUTCMonday = "2026-07-13T06:30:00.000Z";  // Sun 23:30 local, Mon 06:30 UTC
  const local = progressReport(u, sessions, [], [], nowUTCMonday, [], -480);
  assert.notEqual(local.latest_week, "2026-W28", "the week the user is still training in must not be the reference");
  // Without the frame it picks the in-progress week — the pre-fix behaviour.
  const utc = progressReport({ profile: { ...u.profile, tz_offset_min: undefined } }, sessions, [], [], nowUTCMonday, [], null);
  assert.equal(utc.latest_week, "2026-W28");
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

check("reactiveDeloadDue: a stamped week that passed UNTRAINED re-arms; a trained or current one doesn't (C15)", () => {
  const meta = { reactive_deload: { block: 0, week: "2026-W30" } };
  // The stamped week came and went with no session — the deload never happened, so
  // the block's one reactive deload was never actually spent (lesson 28: a deload
  // must mean a deload that HAPPENED, not a week the user skipped).
  assert.equal(reactiveDeloadDue(atCeiling, blk(4), meta, 0, { stampedWeekTrained: false, stampedWeekOver: true }), true, "untrained past week re-arms");
  // The stamped week was trained — the deload was delivered; once per block holds.
  assert.equal(reactiveDeloadDue(atCeiling, blk(4), meta, 0, { stampedWeekTrained: true, stampedWeekOver: true }), false, "a delivered deload is spent");
  // The stamped week is still current — the deload is in progress, never re-stamp
  // (lesson 40: the ambiguous direction is the inert one).
  assert.equal(reactiveDeloadDue(atCeiling, blk(4), meta, 0, { stampedWeekTrained: false, stampedWeekOver: false }), false, "an in-progress week is not re-armed");
});

check("buildToday: the reactive-deload stamp is read in the user's LOCAL week frame, not raw UTC (C2)", () => {
  // Monday 02:00 UTC = Sunday evening at UTC-8: the user's local week is still the
  // PREVIOUS ISO week. A stamp written in their frame must deload their session,
  // and a raw-UTC stamp must not — the same lesson-22 class trainedWeeksInBlock
  // already fixed, at the deload stamp's read.
  const now = "2026-01-05T02:00:00.000Z"; // Monday, UTC week 2026-W02
  const tz = -480;
  const localWk = isoWeekKeyLocal(now, tz); // 2026-W01 (their Sunday)
  assert.notEqual(localWk, isoWeekKey(now), "fixture sanity: the frames disagree at this instant");
  const prog = selectProgram({ training_status: "intermediate", days_per_week: 4 });
  const base = { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, tz_offset_min: tz }, program: prog };
  const blockStart = "2025-12-21T00:00:00.000Z";
  const localStamp = buildToday({ ...base, plan_meta: { block_start: blockStart, reactive_deload: { block: 0, week: localWk } } }, [], null, [], now);
  assert.equal(localStamp.block.phase, "deload", "a stamp in the user's own week frame deloads their session");
  const utcStamp = buildToday({ ...base, plan_meta: { block_start: blockStart, reactive_deload: { block: 0, week: isoWeekKey(now) } } }, [], null, [], now);
  assert.notEqual(utcStamp.block.phase, "deload", "a raw-UTC week the user is not in must not deload");
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

// --- the first session matches the KB -----------------------------------------
// `your-first-session.md`: "Short is fine. A first session of 20-40 minutes is
// plenty." The engine built the same 7-exercise day on day one as on day one
// hundred, and beginners are exempt from the mesocycle wave, so the least
// experienced user got no ramp at all.
// A PRE-Wave-237 stored program, byte-shaped like the engine's OLD output: seven
// 2-set exercises per day. The cap serves TWO populations: plans STORED before
// the Wave-237 floor change (this fixture, kept legacy-shaped on purpose —
// lesson 45), and the fresh generated plans whose day one still exceeds 4 (the
// Wave-240 spill rescues re-lengthened some, e.g. a 4-day dumbbell-only
// beginner opens at 6 — the live-engine test below covers that door, so the cap
// is never tested through hand-written fixtures alone). An earlier version of
// this comment claimed fresh plans were ≤4 "across every combination"; that
// was measured mid-change and was false — both doors are tested now.
const legacySeven = () => ["goblet-squat", "dumbbell-romanian-deadlift", "dumbbell-bench-press",
  "chest-supported-row", "cable-lateral-raise", "machine-crunch", "seated-calf-raise"]
  .map((id) => ({ exercise: id, sets: 2, rep_range: "6-10", rir: "2-3" }));
const legacyBeginnerProgram = () => ({ id: "p-legacy-7", name: "Legacy Full Body", days_per_week: 3, split: "full-body",
  sessions: ["Full Body A", "Full Body B", "Full Body C"].map((name) => ({ name, exercises: legacySeven() })) });

check("a true beginner's FIRST session is short, and says so", () => {
  const profile = { units: "metric", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const program = legacyBeginnerProgram();
  const u = { profile, program, plan_meta: { block_start: new Date().toISOString() } };
  const full = program.sessions[0].exercises.length;
  assert.ok(full > 4, "precondition: the stored day must be longer than the cap, or nothing is being tested");

  const day1 = buildToday(u, []);
  assert.equal(day1.exercises.length, 4);
  assert.deepEqual(day1.first_session, { shown: 4, full });
  // NOT `coach_note`. The client renders coach_note only when readiness != null, so
  // a note set on the ordinary day-one path was invisible to everyone — this test
  // used to assert a string no user could ever see (lesson 15). `first_session` is
  // the signal the first-timer card actually consumes.
  assert.equal(day1.coach_note, null, "the explanation belongs to first_session, not an unrendered note");

  // Session TWO is the full session — the cap is first-session-only, not a
  // permanent downgrade.
  const day2 = buildToday(u, [{ session_id: "s1", date: new Date(Date.now() - 86400000).toISOString(), program_ref: program.id, sets: [] }]);
  assert.ok(day2.exercises.length > 4);
  assert.equal(day2.first_session, null);
});

check("the first-session cap fires on LIVE engine output too (a 4d dumbbell-only beginner opens at 6)", () => {
  const profile = { units: "metric", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 4, session_length_min: 60, available_equipment: ["dumbbell", "bodyweight"] };
  const { program } = generateUserPlan({ ...profile });
  const full = program.sessions[0].exercises.length;
  assert.ok(full > 4, "precondition: this generated day must exceed the cap, or the live door is untested");
  const day1 = buildToday({ profile, program, plan_meta: { block_start: new Date().toISOString() } }, []);
  assert.equal(day1.exercises.length, 4);
  assert.deepEqual(day1.first_session, { shown: 4, full });
});

check("the first-session cap is beginner-only", () => {
  const profile = { units: "metric", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const program = legacyBeginnerProgram(); // 7-exercise stored day — only the STATUS may gate the cap
  const day1 = buildToday({ profile, program, plan_meta: { block_start: new Date().toISOString() } }, []);
  assert.ok(day1.exercises.length > 4, "an intermediate's day one is untouched");
  assert.equal(day1.first_session, null);
});

check("a shortened first session never leaves a dangling superset partner", () => {
  // Hand-built so the PAIR STRADDLES the cut. In the real generated beginner plan
  // the pair sits at indices 4 and 6, so a 4-slice drops both and the unlink is
  // never exercised — the fixture has to put one survivor and one casualty either
  // side of the boundary or it proves nothing (lesson 54).
  const ex = (id, extra = {}) => ({ exercise: id, sets: 2, rep_range: "6-10", rir: "1-3", ...extra });
  const program = { id: "p-super", name: "P", days_per_week: 3, split: "full-body", sessions: [{
    name: "A", exercises: [
      ex("barbell-back-squat"), ex("dumbbell-bench-press"), ex("chest-supported-row"),
      ex("cable-lateral-raise", { superset_with: "leg-extension" }),   // index 3 — SURVIVES
      ex("leg-extension", { superset_with: "cable-lateral-raise" }),   // index 4 — CUT
      ex("plank"),
    ],
  }] };
  const u = { profile: { training_status: "beginner", units: "metric" }, program, plan_meta: { block_start: new Date().toISOString() } };
  const day1 = buildToday(u, []);
  assert.equal(day1.exercises.length, 4);
  const ids = new Set(day1.exercises.map((e) => e.exercise));
  const dangling = day1.exercises.filter((e) => e.superset_with && !ids.has(e.superset_with));
  assert.deepEqual(dangling, [], "a survivor pointing at a cut partner renders '🔗 superset with undefined'");
  // ...and the fixture really did straddle the cut, or the assertion is vacuous.
  assert.ok(ids.has("cable-lateral-raise") && !ids.has("leg-extension"));
});

check("first_session.full reports the TEMPLATE's size, not the post-trim size", () => {
  const profile = { units: "metric", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const program = legacyBeginnerProgram(); // the 7-exercise STORED shape the cap still serves (see fixture above)
  const u = { profile, program, plan_meta: { block_start: new Date().toISOString() } };
  const full = program.sessions[0].exercises.length;
  // A low-readiness day one trims an accessory BEFORE the first-session cap runs.
  // Reading `full` off the already-trimmed list reported one fewer than the plan
  // screen shows, so the card said "4 instead of 6" over a 7-exercise plan.
  assert.equal(buildToday(u, [], { level: "low" }).first_session.full, full);
  assert.equal(buildToday(u, []).first_session.full, full);
});

check("a user whose only sessions are quarantined is NOT treated as a first-timer", () => {
  const profile = { units: "metric", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const program = legacyBeginnerProgram(); // the 7-exercise STORED shape the cap still serves (see fixture above)
  const u = { profile, program, plan_meta: { block_start: new Date().toISOString() } };
  // `sessions` is the DERIVABLE list, so it is empty for someone whose only workout
  // has an unparseable legacy date — but they HAVE trained, and History is showing
  // them a "Date needs correcting" banner right now. hasAnySession = true.
  const asFirstTimer = buildToday(u, [], null, [], null, null, false);
  const hasTrained = buildToday(u, [], null, [], null, null, true);
  assert.deepEqual(asFirstTimer.first_session, { shown: 4, full: program.sessions[0].exercises.length });
  assert.equal(hasTrained.first_session, null, "they have trained — no 'day one' claim");
  assert.ok(hasTrained.exercises.length > 4, "and no beginner trim either");
  // The payload must carry the distinction itself: the client's whole first-timer
  // greeting ("👋 First workout? You've got this") gated on day_number === 1, and
  // day_number derives from the same FILTERED list — so the voided/quarantined-only
  // user this fix exists for was still greeted as a first-timer by the card one
  // line above the paragraph the fix corrected (lesson 1: the premise lives in
  // every field derived from the filter, not just the branch you fixed).
  assert.equal(asFirstTimer.never_trained, true);
  assert.equal(hasTrained.never_trained, false);
  assert.equal(hasTrained.day_number, 1, "day_number still reads 1 here — which is why it cannot be the client's gate");
});

check("a normal check-in on a shortened first session never says the session stands as planned", () => {
  const profile = { units: "metric", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const program = legacyBeginnerProgram(); // the 7-exercise STORED shape the cap still serves (see fixture above)
  const day1 = buildToday({ profile, program, plan_meta: { block_start: new Date().toISOString() } }, [], { level: "normal" });
  // The first-timer card says "4 instead of 7" on the same screen. A note claiming
  // the session stands as planned directly contradicts it (lesson 24).
  assert.ok(day1.first_session, "precondition: the trim applied, or this proves nothing");
  assert.ok(!/stands as planned/.test(day1.coach_note ?? ""), day1.coach_note ?? "");
});

check("a low-readiness FIRST session gets one note, not two contradictory ones", () => {
  const profile = { units: "metric", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const program = legacyBeginnerProgram(); // the 7-exercise STORED shape the cap still serves (see fixture above)
  const day1 = buildToday({ profile, program, plan_meta: { block_start: new Date().toISOString() } }, [], { level: "low" });
  const note = day1.coach_note ?? "";
  assert.ok(note.length > 0);
  // Both levers trim; only one narrates. "deliberately short" beside "I trimmed the
  // last accessory" would be two true mechanisms describing each other's opposite.
  assert.ok(!(/deliberately short/i.test(note) && /trimmed the last accessory/i.test(note)));
  assert.ok(/low sleep|energy/i.test(note), "the readiness note wins — it is the more specific truth about today");
  // ...but the low note must not claim ITS lever did the trimming: it drops one
  // accessory, the first-session cap then drops to 4, and the card beside it says
  // "4 instead of your usual 7". "I trimmed the last accessory" credits the wrong
  // mechanism with the wrong count (lesson 24, the branch the rewrite missed).
  assert.ok(!/trimmed the last accessory/i.test(note), note);
});

check("a high-readiness FIRST session never invites a back-off set", () => {
  const profile = { units: "metric", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const program = legacyBeginnerProgram(); // the 7-exercise STORED shape the cap still serves (see fixture above)
  const day1 = buildToday({ profile, program, plan_meta: { block_start: new Date().toISOString() } }, [], { level: "high", score: 5 });
  // The first-timer card says day one "is not for setting records"; the stock
  // high note says "if a lift feels easy, add a back-off set". Same screen,
  // opposite coaching (lesson 24's shape, third branch).
  assert.ok(day1.first_session, "precondition: the trim applied, or this proves nothing");
  assert.ok(!/back-off set/i.test(day1.coach_note ?? ""), day1.coach_note ?? "");
});

// --- Burst 2 (W282): the post-workout read-out — what the workout MEANS. "Next time" quotes
// the same door buildToday serves through, so it is a promise (the route test pins it).
const roNow = "2026-06-10T18:00:00Z"; // a Wednesday
const roDay = (n) => new Date(Date.parse(roNow) - n * 86400000).toISOString();
const roProg = { id: "p", name: "P", sessions: [{ name: "A", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }, { exercise: "lat-pulldown", sets: 3, rep_range: "8-12", rir: "1-3" }] }] };
const roUser = (status, blockStartDaysAgo, extra = {}) => ({ profile: { training_status: status, primary_goal: "hypertrophy", days_per_week: 3, tz_offset_min: 0, ...extra },
  program: roProg, plan_meta: { block_start: roDay(blockStartDaysAgo) }, created_at: roDay(blockStartDaysAgo) });
const roSess = (iso, id, bench, pull, tag = {}) => ({ session_id: id, date: iso, local_date: iso.slice(0, 10), program_ref: "p", session_name: "A",
  sets: [...bench.map(([kg, r]) => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: kg, reps: r, ...tag })), ...pull.map(([kg, r]) => ({ exercise: "lat-pulldown", set_type: "work", weight_kg: kg, reps: r, ...tag }))] });
const three = (kg, r) => [[kg, r], [kg, r], [kg, r]];
const roBench = (d, id, n, kg = 60) => ({ session_id: id, date: roDay(d), local_date: roDay(d).slice(0, 10), program_ref: "p", session_name: "A",
  sets: Array.from({ length: n }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: kg, reps: 8 })) });
const roFri = "2026-06-12T18:00:00Z"; // the Friday of roNow's week
const fromFri = (n) => new Date(Date.parse(roFri) - n * 86400000).toISOString();
// k prior weekly sessions (k weeks back … 1 week back), then today's
const roHistory = (k, today) => [...Array.from({ length: k }, (_, i) => roSess(roDay((k - i) * 7), `w${i}`, three(60, 8), three(50, 10))), today];
const quotesServed = (u, all, ro) => { const served = buildToday(u, all, null, [], roNow).exercises; return ro.next.every((n) => n.kg === served.find((e) => e.exercise === n.exercise)?.suggested_kg); };
check("#readout week 2: the objective is the block's, and 'next time' is exactly what buildToday will serve", () => {
  const today = roSess(roNow, "t", three(60, 10), three(50, 9));
  const u = roUser("intermediate", 10), all = roHistory(1, today);
  const ro = sessionReadout(u, all, today, { now: roNow });
  assert.match(ro.objective, /^Week 2 of 6 — building/);
  assert.deepEqual(ro.next.map((n) => [n.exercise, n.kg]), [["barbell-bench-press", 62.5], ["lat-pulldown", 50]]);
  assert.equal(ro.next[0].note, "Last time you hit the top of the range — add 2.5 kg.");
  assert.ok(quotesServed(u, all, ro));
  assert.deepEqual([ro.beginner, ro.bodyweight], [false, null]);
});
check("#readout week 5: says the next TRAINING week is the deload", () => {
  const today = roSess(roNow, "t", three(60, 9), three(50, 10));
  const ro = sessionReadout(roUser("intermediate", 31), roHistory(4, today), today, { now: roNow });
  assert.match(ro.objective, /^Week 5 of 6 — peak volume/);
  assert.ok(ro.block.some((l) => /Next training week is your deload/.test(l)), JSON.stringify(ro.block));
});
check("#readout a deload week: recovery is the aim, and the weights don't move on its account", () => {
  const today = roSess(roNow, "t", three(54, 8), three(45, 10), { deload: true });
  const u = roUser("intermediate", 38), all = roHistory(5, today);
  const ro = sessionReadout(u, all, today, { now: roNow });
  assert.match(ro.objective, /^Recover/);
  assert.ok(ro.block.some((l) => /doesn't move your progression/.test(l)), JSON.stringify(ro.block));
  assert.ok(quotesServed(u, all, ro), "still the served (deload-eased) weights");
});
check("#readout a lift flat at the top of what you recover from: the deload comes forward — and 'next time' already says so", () => {
  const big = (iso, id) => ({ session_id: id, date: iso, local_date: iso.slice(0, 10), program_ref: "p", session_name: "A", sets: Array.from({ length: 18 }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 })) });
  const today = big(roNow, "t");
  const all = [35, 28, 21, 14, 7].map((d, i) => big(roDay(d), `b${i}`)).concat(today);
  const u = roUser("intermediate", 22);
  const ro = sessionReadout(u, all, today, { now: roNow });
  assert.match(ro.block[0] ?? "", /bringing your deload forward/);
  assert.equal(ro.next.find((n) => n.exercise === "barbell-bench-press").kg, 90, "100 × 0.9: the deload the next /api/today will stamp");
});
check("#readout a taper: stay strong while doing less — and the weight holds", () => {
  const today = roSess(roNow, "t", three(60, 10), three(50, 12));
  const u = roUser("intermediate", 10, { goal_event_date: roDay(-10).slice(0, 10) }), all = roHistory(1, today);
  const ro = sessionReadout(u, all, today, { now: roNow });
  assert.match(ro.objective, /10 days to your event/);
  assert.equal(ro.next[0].kg, 60, "a taper holds the load even at the top of the range");
  assert.ok(quotesServed(u, all, ro));
});
check("#readout a beginner: one plain aim, the weights for next time — no block talk, no forecasts", () => {
  const today = roSess(roNow, "t", three(40, 10), three(30, 12));
  const ro = sessionReadout(roUser("beginner", 10), roHistory(1, today), today, { now: roNow });
  assert.match(ro.objective, /one session at a time/);
  assert.deepEqual([ro.beginner, ro.block, ro.next_block, ro.bodyweight], [true, [], [], null]);
  assert.equal(ro.next.length, 2);
});
check("#readout 'most weeks' needs most weeks: a first week never claims it — three finished thin weeks do (in plain words)", () => {
  const withPlan = (u) => ({ ...u, plan_rationale: { volume_by_muscle: { chest: { projected_sets: 12 }, lats: { projected_sets: 12 } } } });
  const first = roSess(roNow, "t", three(60, 9), three(50, 10));
  const ro1 = sessionReadout(withPlan(roUser("intermediate", 3)), [first], first, { now: roNow });
  assert.ok(!ro1.block.some((l) => /Most weeks/.test(l)), JSON.stringify(ro1.block));
  const thin = (d, id) => roSess(roDay(d), id, [[60, 9]], [[50, 10]]);
  const today = roSess(roNow, "t2", [[60, 9]], [[50, 10]]);
  const ro2 = sessionReadout(withPlan(roUser("intermediate", 24)), [thin(21, "a"), thin(14, "b"), thin(7, "c"), today], today, { now: roNow });
  assert.ok(ro2.block.some((l) => /^Your chest and back \(lats\) have been flat — and most weeks they get about 8% of the sets/.test(l)), JSON.stringify(ro2.block));
});
// The week in progress is never judged (W282 walkthrough): three finished weeks at 8 of the
// plan's 12 chest sets is completing (the line sits at 0.7 × 12 × the wave's 0.82 ≈ 6.9);
// counting this week's single set so far would drag the mean to 6.25 and flip it. Each
// reader passes the current week — the read-out, the Progress card, the boundary decision.
check("#completion the week in progress never counts against you — read-out, Progress card and boundary alike", () => {
  const plan = { volume_by_muscle: { chest: { projected_sets: 12 } } };
  const benchWeek = (d, id, n) => ({ session_id: id, date: roDay(d), local_date: roDay(d).slice(0, 10), program_ref: "p", session_name: "A",
    sets: Array.from({ length: n }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 8 })) });
  const today = benchWeek(0, "t", 1);
  const all = [benchWeek(28, "a", 8), benchWeek(21, "b", 8), benchWeek(14, "c", 8), benchWeek(7, "d", 8), today];
  const u = { ...roUser("intermediate", 31), plan_rationale: plan };
  assert.ok(!sessionReadout(u, all, today, { now: roNow }).block.some((l) => /Most weeks/.test(l)), "read-out");
  assert.notEqual(progressReport(u, all, [], [], roNow).adaptive.find((a) => a.muscle === "chest")?.signal, "complete", "Progress card");
  assert.ok(!blockTuneDecision(u, all, {}, roNow).tuned.held.some((h) => h.reason === "completion"), "boundary decision");
});
check("#readout a falling bodyweight says what it means — and only when the tune's own deficit gate would", () => {
  const today = roSess(roNow, "t", three(60, 9), three(50, 10));
  const down = Array.from({ length: 6 }, (_, i) => ({ date: roDay(30 - i * 5).slice(0, 10), kg: 85 - i * 0.4 }));
  const ro = sessionReadout(roUser("intermediate", 10), roHistory(1, today), today, { now: roNow, bodyweights: down });
  assert.match(ro.bodyweight ?? "", /trending down/);
  const flat = down.map((b) => ({ ...b, kg: 85 }));
  assert.equal(sessionReadout(roUser("intermediate", 10), roHistory(1, today), today, { now: roNow, bodyweights: flat }).bodyweight, null);
});

// --- Burst 2 review (W282d) -----------------------------------------------------------------
check("#completion a rebuild starts the count again: weeks under the old plan never count against the new one", () => {
  const all = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `o${i}`, 6)); // every set of a smaller plan, flat
  const today = roBench(0, "t", 6);
  const plan = { volume_by_muscle: { chest: { projected_sets: 12 } } };
  const rebuilt = { ...roUser("intermediate", 2), plan_rationale: plan }; // a training change reset the block this week
  assert.notEqual(progressReport(rebuilt, [...all, today], [], [], roNow).adaptive.find((a) => a.muscle === "chest")?.signal, "complete");
  assert.ok(!sessionReadout(rebuilt, [...all, today], today, { now: roNow }).block.some((l) => /most weeks/i.test(l)));
  const sameBlock = { ...roUser("intermediate", 45), plan_rationale: plan }; // control: the same weeks under THIS plan
  assert.equal(progressReport(sameBlock, [...all, today], [], [], roNow).adaptive.find((a) => a.muscle === "chest")?.signal, "complete");
});
check("#completion a muscle the plan serves through compound credit, or caps on purpose, never shows 'complete' on Progress", () => {
  const short = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `s${i}`, 3));
  for (const flag of ["secondary_served", "eased"]) {
    const u = { ...roUser("intermediate", 45), plan_rationale: { volume_by_muscle: { chest: { projected_sets: 12, [flag]: true } } } };
    assert.notEqual(progressReport(u, short, [], [], roNow).adaptive.find((a) => a.muscle === "chest")?.signal, "complete", flag);
  }
});
check("#completion ONE door for the lifts any rebuild swaps: what the boundary spares, every rebuild spares", () => {
  const plan = { volume_by_muscle: { chest: { projected_sets: 12 } } };
  const u = { ...roUser("intermediate", 45), plan_rationale: plan };
  const quarter = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `q${i}`, 3)); // 3 of 12 sets a week, flat
  assert.deepEqual(stalledExerciseIds(quarter, [], roNow), ["barbell-bench-press"], "precondition: flat");
  assert.deepEqual(swapStalls(u, quarter, roNow), [], "trained a quarter as often as planned: spared");
  assert.deepEqual(blockTuneDecision(u, quarter, {}, roNow).stalledExercises, [], "…and the boundary agrees");
  const full = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `f${i}`, 12));
  assert.deepEqual(swapStalls(u, full, roNow), ["barbell-bench-press"], "a real plateau is still swapped");
  // The boundary's verdict IS the block's: a rebuild later in the block reuses the muscles it
  // spared (the new block's plan would judge the same weeks differently — the W282 review saw an
  // abs accessory flip on a units-only save); the boundary itself always decides afresh.
  const stamped = (block) => ({ ...u, plan_meta: { ...u.plan_meta, block_index: 1, spared_muscles: { block, muscles: ["chest"] } } });
  assert.deepEqual(swapStalls(stamped(1), full, roNow), [], "this block's stored verdict spares chest");
  assert.deepEqual(swapStalls(stamped(0), full, roNow), ["barbell-bench-press"], "an older block's verdict is ignored");
  assert.deepEqual(swapStalls(stamped(1), full, roNow, { fresh: true }), ["barbell-bench-press"], "the boundary decides afresh");
  assert.deepEqual(blockTuneDecision(u, quarter, {}, roNow).spared, ["chest"], "…and hands the rollover what it spared, to store");
  assert.deepEqual(blockTuneDecision(stamped(1), full, {}, roNow).stalledExercises, ["barbell-bench-press"], "at the next boundary, last block's verdict never overrides what this block shows");
});
check("#readout-week a Friday's 'next time' is NEXT week's weight — in week 5 that's the deload, exactly what Monday serves", () => {
  const wk = (d, id) => roSess(fromFri(d), id, three(60, 10), three(50, 10));
  const all = [...[32, 25, 18, 11].map((d, i) => wk(d, `p${i}`)), wk(4, "mon"), wk(2, "wed"), roSess(roFri, "fri", three(60, 10), three(50, 10))];
  const fri = all[all.length - 1];
  const u = { ...roUser("intermediate", 0), plan_meta: { block_start: fromFri(35) } }; // 4 finished weeks → week 5
  const ro = sessionReadout(u, all, fri, { now: roFri });
  const monday = buildToday(u, all, null, [], "2026-06-15T09:00:00Z").exercises;
  assert.ok(monday[0].suggested_kg < 62.5, "precondition: next Monday is the deload");
  assert.deepEqual(ro.next.map((n) => [n.exercise, n.kg, n.when]), monday.map((e) => [e.exercise, e.suggested_kg, "next-week"]));
});
check("#readout-week a deload Friday: the next sessions are a NEW block — no per-lift promise, and the block line says why", () => {
  const all = [...[39, 32, 25, 18, 11].map((d, i) => roSess(fromFri(d), `p${i}`, three(60, 8), three(50, 10))),
    ...[4, 2, 0].map((d, i) => roSess(fromFri(d), `d${i}`, three(54, 8), three(45, 10), { deload: true }))];
  const u = { ...roUser("intermediate", 0), plan_meta: { block_start: fromFri(42), block_index: 0 } }; // 5 finished weeks → week 6
  const ro = sessionReadout(u, all, all[all.length - 1], { now: roFri });
  assert.deepEqual(ro.next, []);
  assert.ok(ro.block.some((l) => /new block starts next week/i.test(l)), JSON.stringify(ro.block));
});
check("#readout-week with Friday still committed, Wednesday's 'next time' is THIS week's weight", () => {
  const all = [...[30, 23, 16, 9].map((d, i) => roSess(fromFri(d), `p${i}`, three(60, 10), three(50, 10))), roSess(fromFri(4), "mon", three(60, 10), three(50, 10)), roSess(roNow, "wed", three(60, 10), three(50, 10))];
  const u = { ...roUser("intermediate", 0, { commitment: { week: "2026-W24", days: ["mon", "wed", "fri"], set_on: "2026-06-01" } }), plan_meta: { block_start: fromFri(35) } };
  const ro = sessionReadout(u, all, all[all.length - 1], { now: roNow });
  assert.deepEqual(ro.next.map((n) => [n.kg, n.when]), [[62.5, "this-week"], [50, "this-week"]]);
  assert.ok(quotesServed(u, all, ro));
  // Only Mon + Wed committed: nothing left this week, so next time is next week's deload —
  // where 3 days a week with no plan would still guess one more session this week.
  const u2 = { ...u, profile: { ...u.profile, commitment: { week: "2026-W24", days: ["mon", "wed"], set_on: "2026-06-01" } } };
  assert.deepEqual(sessionReadout(u2, all, all[all.length - 1], { now: roNow }).next.map((n) => [n.kg, n.when]), [[54, "next-week"], [45, "next-week"]]);
});
check("#readout a flat lift on a hand-built plan: no 'next block' promise (it never rolls over) — the lever is named instead", () => {
  const flat = [28, 21, 14, 7].map((d, i) => roSess(roDay(d), `c${i}`, three(60, 8), three(50, 10)));
  const today = roSess(roNow, "t", three(60, 8), three(50, 10));
  const u = { ...roUser("intermediate", 31), program: { ...roProg, custom: true } };
  const line = sessionReadout(u, [...flat, today], today, { now: roNow }).block.find((l) => /flat/.test(l)) ?? "";
  assert.match(line, /plan you built/);
  assert.doesNotMatch(line, /next block/);
});
check("#readout a flat lift the next block would pick again gets no 'fresh angle' promise", () => {
  const mcp = (d, id) => ({ session_id: id, date: roDay(d), local_date: roDay(d).slice(0, 10), program_ref: "p", session_name: "A", sets: Array.from({ length: 3 }, () => ({ exercise: "machine-chest-press", set_type: "work", weight_kg: 60, reps: 8 })) });
  const all = [mcp(28, "a"), mcp(21, "b"), mcp(14, "c"), mcp(7, "d"), mcp(0, "t")];
  const ro = sessionReadout(roUser("intermediate", 31, { available_equipment: ["machine"] }), all, all[4], { now: roNow });
  const line = ro.block.find((l) => /Machine Chest Press/i.test(l)) ?? "";
  assert.ok(line, `precondition: the flat lift is named — ${JSON.stringify(ro.block)}`);
  assert.doesNotMatch(line, /fresh angle/);
});
check("#readout the missing-sets line speaks only where lifts are flat — a lifter whose lifts are moving never hears it", () => {
  const plan = { volume_by_muscle: { chest: { projected_sets: 12 }, lats: { projected_sets: 12 } } };
  const moving = [21, 14, 7].map((d, i) => roSess(roDay(d), `m${i}`, [[50 + i * 5, 9]], [[40 + i * 5, 10]]));
  const today = roSess(roNow, "t", [[65, 9]], [[55, 10]]);
  const ro = sessionReadout({ ...roUser("intermediate", 24), plan_rationale: plan }, [...moving, today], today, { now: roNow });
  assert.ok(!ro.block.some((l) => /most weeks|been flat/i.test(l)), JSON.stringify(ro.block));
});
check("#readout a workout that earns a step up never ALSO says 'next week is your deload' (the fresh plan restarts the block)", () => {
  const hist = [];
  for (let w = 131; w >= 1; w--) for (const off of [0, 2]) hist.push(roSess(roDay(w * 7 - off), `g${w}-${off}`, three(60, 8), three(50, 10)));
  const today = roSess(roNow, "t", three(60, 8), three(50, 10));
  const ro = sessionReadout(roUser("intermediate", 31), [...hist, today], today, { now: roNow });
  assert.match(ro.block[0] ?? "", /step up/);
  assert.ok(!ro.block.some((l) => /Next training week is your deload/.test(l)), JSON.stringify(ro.block));
});
check("#readout a workout from an earlier week: 'next time' still holds, but this-block forecasts aren't re-told from a week that has passed", () => {
  const last = roSess(roDay(7), "last", three(60, 10), three(50, 10));
  const all = [...[35, 28, 21, 14].map((d, i) => roSess(roDay(d), `e${i}`, three(60, 8), three(50, 10))), last];
  const u = roUser("intermediate", 38);
  const ro = sessionReadout(u, all, last, { now: roNow });
  assert.deepEqual([ro.block, ro.next_block], [[], []]);
  assert.ok(ro.next.length > 0 && quotesServed(u, all, ro), "next time is computed for now");
});

// --- W284: Nerd Mode — the numbers behind Progress, from the SAME derivations (no second calc).
check("#estimate a barbell lift's body-scaled first guess never goes below the empty bar (the Jefferson curl at 80 kg was 7.5)", () => {
  assert.equal(estimateStartingWeight(exerciseById.get("jefferson-curl"), 80, "jefferson-curl"), 20);
  assert.ok(estimateStartingWeight(exerciseById.get("barbell-bench-press"), 80, "barbell-bench-press") > 20, "heavier guesses are untouched");
});
check("#nerd volume vs landmarks (labelled estimates), the plan's numbers, the tune's sample and its adjustment, per muscle", () => {
  const all = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `n${i}`, 12));
  const u = { ...roUser("intermediate", 45), plan_rationale: { volume_by_muscle: { chest: { projected_sets: 12, target_sets: 12 } } }, plan_meta: { block_start: roDay(45), block_index: 0, volume_adjust: { chest: 2 } } };
  const n = nerdReport(u, all, [], [], roNow, null, progressReport(u, all, [], [], roNow));
  const chest = n.volume.find((v) => v.id === "chest");
  assert.deepEqual(chest.landmarks.mev, { min: 8, max: 10 }, "the KB's own landmark ranges");
  assert.equal(chest.estimate, true, "model estimates, labelled as such");
  assert.deepEqual([chest.name, chest.planned, chest.target, chest.adjust, chest.peak], ["chest", 12, 12, 2, 12]);
});
check("#nerd the block's maths and the next block's decision are trainingContext and blockTuneDecision themselves", () => {
  const all = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `b${i}`, 12));
  const u = { ...roUser("intermediate", 45), plan_rationale: { volume_by_muscle: { chest: { projected_sets: 12 } } } };
  const n = nerdReport(u, all, [], [], roNow, null, progressReport(u, all, [], [], roNow));
  const ctx = trainingContext(u, all, roNow), d = blockTuneDecision(u, all, {}, roNow);
  assert.deepEqual([n.block.week, n.block.phase, n.block.set_scale], [ctx.block.week, ctx.block.phase, ctx.block.setScale]);
  assert.deepEqual([n.next_block.bumped, n.next_block.eased, n.next_block.held], [d.tuned.bumped, d.tuned.eased, d.tuned.held]);
  assert.ok(Array.isArray(n.next_block.swaps));
  // …holds included: a quarter of the planned sets, flat — the boundary holds chest for completion
  const thin = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `t${i}`, 3));
  const nt = nerdReport(u, thin, [], [], roNow, null, progressReport(u, thin, [], [], roNow));
  const dt = blockTuneDecision(u, thin, {}, roNow);
  assert.ok(dt.tuned.held.some((h) => h.reason === "completion"), "precondition: something is held");
  assert.deepEqual(nt.next_block.held, dt.tuned.held);
});
check("#readout a specialization block: the next-block lines name its swaps — never 'your volume carries over' (the tune is frozen, the swaps aren't)", () => {
  const all = [...[28, 21, 14, 7].map((d, i) => roSess(roDay(d), `sp${i}`, three(60, 8), three(50, 10))), roSess(roNow, "t", three(60, 8), three(50, 10))];
  const u = roUser("intermediate", 31, { priority_muscles: ["lats"] });
  assert.ok(isSpecializing(u.profile, 0), "precondition: a specialization block");
  const ro = sessionReadout(u, all, all[4], { now: roNow });
  assert.ok(!ro.next_block.some((l) => /carries over/.test(l)), JSON.stringify(ro.next_block));
  assert.ok(ro.next_block.some((l) => /fresh angle/.test(l)), JSON.stringify(ro.next_block));
  // …and with nothing to swap (lifts climbing), it says nothing rather than "carries over" — the
  // block's end rebalances volume, so that line would be false.
  const climbing = [...[28, 21, 14, 7].map((d, i) => roSess(roDay(d), `sc${i}`, three(50 + i * 5, 8), three(40 + i * 5, 10))), roSess(roNow, "t2", three(70, 8), three(60, 10))];
  assert.deepEqual(sessionReadout(u, climbing, climbing[4], { now: roNow }).next_block, []);
});
check("#nerd strength (W283 review): the margin under the 8-week peak is the right sign and window, and a regression is named", () => {
  const dip = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `dp${i}`, 3, [60, 70, 70, 65, 65, 65][i]));
  const u = roUser("intermediate", 45);
  const rep = progressReport(u, dip, [], [], roNow);
  const b = nerdReport(u, dip, [], [], roNow, null, rep).strength.find((x) => x.exercise === "barbell-bench-press");
  assert.equal(b.under_peak_pct, 7.2, "88.67 → 82.33");
  assert.equal(b.regressing, true);
  assert.equal(b.drop_pct, rep.regressions.find((r) => r.exercise === "barbell-bench-press").drop_pct);
  // the peak counts only inside the last 8 logged weeks: an old high doesn't make today "25% under"
  const old = [84, 77, 70, 63, 56, 49, 42, 35, 28, 21].map((d, i) => roBench(d, `ol${i}`, 3, i === 0 ? 80 : 60));
  assert.equal(nerdReport(u, old, [], [], roNow, null, progressReport(u, old, [], [], roNow)).strength.find((x) => x.exercise === "barbell-bench-press").under_peak_pct, 0);
  // the % beside the last 4 weeks is THEIR change (not the lifetime one), and load-tracked lifts say so
  const climb = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `cl${i}`, 3, [40, 50, 60, 60, 60, 60][i]));
  const c = nerdReport(u, climb, [], [], roNow, null, progressReport(u, climb, [], [], roNow)).strength.find((x) => x.exercise === "barbell-bench-press");
  assert.equal(c.window_pct, 0, "flat over the four weeks drawn");
  assert.ok(c.change_pct > 0, "precondition: the lifetime change is positive");
  assert.equal(c.basis, "e1rm");
});
check("#nerd an EASED muscle is previewed too (the boundary's own decision, not an empty list)", () => {
  const over = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `ov${i}`, 26));
  const u = roUser("intermediate", 45);
  const d = blockTuneDecision(u, over, {}, roNow);
  assert.ok(d.tuned.eased.includes("chest"), "precondition: 26 sets over the ceiling eases chest");
  assert.deepEqual(nerdReport(u, over, [], [], roNow, null, progressReport(u, over, [], [], roNow)).next_block.eased, d.tuned.eased);
});
check("#nerd block maths name the block the trained-week clock is in (a boundary may be pending)", () => {
  const all = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `bi${i}`, 12));
  const n = nerdReport(roUser("intermediate", 45), all, [], [], roNow, null, progressReport(roUser("intermediate", 45), all, [], [], roNow));
  assert.deepEqual([n.block.index, n.block.week], [1, 1], "6 trained weeks: block 2, week 1 — though block_index is still 0");
});
check("#nerd a hand-built plan's stored tune shows as PAUSED (the editor says tuning stops), and a specialization block still previews its swaps", () => {
  const all = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `cu${i}`, 12));
  const cu = { ...roUser("intermediate", 45), program: { ...roProg, custom: true }, plan_meta: { block_start: roDay(45), volume_adjust: { chest: 4 } } };
  const row = nerdReport(cu, all, [], [], roNow, null, progressReport(cu, all, [], [], roNow)).volume.find((v) => v.id === "chest");
  assert.deepEqual([row.adjust, row.adjust_paused], [4, true]);
  const spec = { ...roUser("intermediate", 45, { priority_muscles: ["lats"] }), plan_meta: { block_start: roDay(45), block_index: 0 } };
  const sn = nerdReport(spec, all, [], [], roNow, null, progressReport(spec, all, [], [], roNow));
  assert.ok(sn.next_block, "the boundary still swaps stalled lifts in a specialization block, so the preview says so");
  assert.deepEqual(sn.next_block.swaps.length >= 0 && [sn.next_block.bumped, sn.next_block.eased], [[], []], "the tune is frozen: nothing bumped or eased");
  assert.equal(sn.next_block.specialization, true);
});
check("#nerd strength: each lift's weekly e1RM, its personal stall window, how flat it is, and how far under its 8-week peak", () => {
  const all = [42, 35, 28, 21, 14, 7].map((d, i) => roBench(d, `s${i}`, 3, i < 2 ? 60 + i * 5 : 65));
  const n = nerdReport(roUser("intermediate", 45), all, [], [], roNow, null, progressReport(roUser("intermediate", 45), all, [], [], roNow));
  const b = n.strength.find((x) => x.exercise === "barbell-bench-press");
  assert.ok(b.series.length >= 5 && Number.isInteger(b.stall_window) && b.stall_window >= 4, JSON.stringify(b));
  assert.equal(typeof b.under_peak_pct, "number");
  assert.equal(b.weeks_flat >= 4, true);
  assert.equal(nerdReport({ ...roUser("beginner", 45) }, all, [], [], roNow, null, progressReport(roUser("beginner", 45), all, [], [], roNow)).block, null, "beginners run no blocks");
});


check("a maintenance day's 'light on purpose' note rides the /api/today payload", () => {
  // The rationale produces it (Wave 250); a producer without this consumer is the
  // exact lesson-15 shape — the note must reach the screen the question arises on.
  const profile = { units: "metric", training_status: "advanced", primary_goal: "recomposition",
    days_per_week: 4, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "band", "kettlebell"],
    priority_muscles: ["side-delts", "biceps", "triceps"] };
  const { program, rationale } = generateUserPlan({ ...profile });
  const noted = Object.keys(rationale.session_notes ?? {});
  assert.ok(noted.length > 0, "precondition: this profile produces a noted session, or nothing is tested");
  const idx = program.sessions.findIndex((s) => noted.includes(s.name));
  const sessions = [];
  // advance the rotation to the noted day by logging the earlier sessions
  for (let i = 0; i < idx; i++) sessions.push({ session_id: `mn-${i}`, date: new Date(Date.now() - (idx - i) * 86400000).toISOString(), program_ref: program.id, sets: [] });
  const u = { profile, program, plan_meta: { block_start: new Date().toISOString() }, plan_rationale: rationale };
  const t = buildToday(u, sessions);
  assert.equal(t.name, program.sessions[idx].name, "precondition: today IS the noted day");
  assert.match(t.maintenance_note ?? "", /light on purpose/i);
});

// --- W289 (Burst 5 — owner: "I had done 150kg x 5,4,5 last workout and now it is suggesting 150kg x
// 10,10,10"). The weight held, rightly (W279: one short holds once), but the reps stepper seeded the
// TOP of the range on every set. The aim is now per set, from last session's sets in order: at the same
// load, beat each by a rep (double progression's "add a rep"), capped at the top; at a moved load, each
// set's capacity (reps + RIR) carried to today's load by Epley, less the band's near edge.
const sqSet = (w, reps, extra = {}) => ({ exercise: "barbell-back-squat", set_type: "work", weight_kg: w, reps, ...extra });
const aim = (exercise, rep_range, rir, sets, sessions, ctx = {}) => servedLift({ exercise, sets, rep_range, rir }, sessions, ctx, undefined, null);
check("#rep-aim the owner's case: 150×5,4,5 held at 150 → aim 6 · 5 · 6, never 10 · 10 · 10", () => {
  const s = aim("barbell-back-squat", "6-10", "1-2", 3, [brDay(1, sqSet(150, 5), sqSet(150, 4), sqSet(150, 5))]);
  assert.equal(s.suggested_kg, 150, "precondition: the W279 hold");
  assert.deepEqual(s.rep_targets, [6, 5, 6]);
});
check("#rep-aim more sets today than last time: the extra set reuses the last one's aim; the top of the range caps it", () => {
  assert.deepEqual(aim("barbell-back-squat", "6-10", "1-2", 4, [brDay(1, sqSet(150, 5), sqSet(150, 4), sqSet(150, 5))]).rep_targets, [6, 5, 6, 6]);
  // "You did 2 of 3 sets last time" holds at 100 — beating 10 is capped at 10
  const held = aim("barbell-bench-press", "6-10", "1-3", 3, [withTargets([{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }], brSet(100, 10), brSet(100, 10))]);
  assert.equal(held.suggested_kg, 100, "precondition: the W280 shortfall hold");
  assert.deepEqual(held.rep_targets, [10, 10, 10]);
});
check("#rep-aim the weight moved: each set's capacity carried to the new load (a bump; an ease)", () => {
  const bump = aim("barbell-bench-press", "6-10", "1-2", 3, [brDay(1, brSet(100, 10), brSet(100, 10), brSet(100, 10))]);
  assert.equal(bump.suggested_kg, 102.5);
  assert.deepEqual(bump.rep_targets, [9, 9, 9], "30·((100/102.5)·(1 + 11/30) − 1) − 1 = 9");
  const ease = aim("barbell-bench-press", "8-12", "1-3", 3, [brDay(1, brSet(100, 6), brSet(100, 5), brSet(100, 5))]);
  assert.equal(ease.suggested_kg, 90);
  assert.deepEqual(ease.rep_targets, [9, 8, 8], "under the range, unlogged effort reads as failure (W279's reading)");
});
check("#rep-aim a deload week: fewer sets at ~90%, aimed from the effort they were done at, capped at the top", () => {
  const d = aim("barbell-bench-press", "6-10", "1-2", 3, [brDay(1, brSet(100, 10), brSet(100, 10), brSet(100, 9))], { block: { phase: "deload", week: 6, setScale: 0.5 } });
  assert.equal(d.suggested_kg, 90);
  assert.deepEqual(d.rep_targets, [10, 10]);
});
check("#rep-aim a weight changed mid-lift last time: each set reads its own load (70×5 then 62.5×7,6 → 8 · 8 · 7)", () => {
  const m = aim("barbell-bench-press", "6-10", "1-2", 3, [brDay(1, brSet(70, 5), brSet(62.5, 7), brSet(62.5, 6))]);
  assert.equal(m.suggested_kg, 62.5, "precondition: anchored on the weight proved in the range");
  assert.deepEqual(m.rep_targets, [8, 8, 7]);
});
check("#rep-aim no history → no aim; a bodyweight lift beats its own reps, and never runs Epley on added load", () => {
  assert.equal(aim("barbell-bench-press", "6-10", "1-2", 3, []).rep_targets ?? null, null);
  const pu = (w, reps) => ({ exercise: "pull-up", set_type: "work", weight_kg: w, reps });
  assert.deepEqual(aim("pull-up", "6-10", "1-2", 3, [brDay(1, pu(0, 8), pu(0, 7), pu(0, 6))]).rep_targets, [9, 8, 7]);
  const loaded = aim("pull-up", "6-10", "1-2", 3, [brDay(1, pu(10, 10), pu(10, 10), pu(10, 10))]);
  assert.ok(loaded.suggested_kg > 10, "precondition: the top of the range adds load");
  assert.deepEqual(loaded.rep_targets, [10, 10, 10], "added load is not the whole load — no Epley on it");
});
check("#rep-aim Today's rows carry the aim (through buildToday)", () => {
  const prog = { id: "p", name: "P", sessions: [{ name: "D", exercises: [{ exercise: "barbell-back-squat", sets: 3, rep_range: "6-10", rir: "1-2" }] }] };
  const row = buildToday({ profile: { training_status: "intermediate", days_per_week: 3 }, program: prog }, [brDay(1, sqSet(150, 5), sqSet(150, 4), sqSet(150, 5))]).exercises[0];
  assert.equal(row.suggested_kg, 150);
  assert.deepEqual(row.rep_targets, [6, 5, 6].slice(0, row.sets), JSON.stringify({ sets: row.sets, rep_targets: row.rep_targets }));
});

// --- W290 (Burst 5 — owner: "Exercise order isn't taken into consideration when suggesting weights";
// the cases the owner named: the same lift on different days, and later lifts in general). A lift done
// after more hard sets for the same muscles than last time gets fewer reps (Simão 2005, 2012), so its
// weight and aims carry the DIFFERENCE between today's position and the anchor session's — both read
// from the PLAN (unscaled sets), so a stable slot never moves; under 2 weighted sets is ignored.
const ordProg = { id: "op", name: "Order", sessions: [
  { name: "A", exercises: [{ exercise: "incline-dumbbell-press", sets: 3, rep_range: "6-10", rir: "1-3" }] },
  { name: "B", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }, { exercise: "incline-dumbbell-press", sets: 3, rep_range: "6-10", rir: "1-3" }] },
] };
const inc = (w, reps, extra = {}) => ({ exercise: "incline-dumbbell-press", set_type: "work", weight_kg: w, reps, ...extra });
const onDay = (session_name, d, ...sets) => ({ ...brDay(d, ...sets), session_name });
const slotOf = (program, name) => ({ program, session: program.sessions.find((s) => s.name === name) });
const incEx = (program, name) => slotOf(program, name).session.exercises.find((e) => e.exercise === "incline-dumbbell-press");
const ordServed = (name, sessions, ctx = {}, now = null, program = ordProg) => servedLift(incEx(program, name), sessions, ctx, undefined, now, slotOf(program, name));
const musclesOf = (id) => ({ primary: exerciseById.get(id)?.primary_muscles ?? [], secondary: exerciseById.get(id)?.secondary_muscles ?? [] });
check("#order priorOverlapSets: an earlier lift counts its sets × 1 when its primary is this lift's, × 0.5 for a primary↔secondary overlap", () => {
  const list = [{ exercise: "barbell-bench-press", sets: 3 }, { exercise: "dumbbell-overhead-triceps-extension", sets: 2 }, { exercise: "lat-pulldown", sets: 3 }, { exercise: "incline-dumbbell-press", sets: 3 }];
  const p = deriveCore.priorOverlapSets(list, 3, musclesOf);
  assert.equal(p.sets, 3 * 1 + 2 * 0.5, "bench chest∩chest; triceps extension triceps∩secondary; the pulldown nothing");
  assert.equal(p.count, 5, "the overlapping hard sets, unweighted (for the note)");
  assert.deepEqual(p.muscles, ["chest", "triceps"]);
  assert.deepEqual(deriveCore.priorOverlapSets(list, 0, musclesOf), { sets: 0, count: 0, muscles: [] }, "the first lift of the day");
});
check("#order orderLoss is 5% of capacity per weighted set, capped at 25%; contextLoad there and back is the starting weight", () => {
  assert.deepEqual([0, 1.5, 3, 5, 9].map(deriveCore.orderLoss), [0, 0.075, 0.15, 0.25, 0.25]);
  for (const kg of [20, 57.5, 100]) for (const c of [6, 10, 14]) for (const [a, b] of [[0, 0.15], [0.1, 0.25], [0.2, 0]])
    assert.ok(Math.abs(deriveCore.contextLoad(deriveCore.contextLoad(kg, c, a, b), c, b, a) - kg) < 1e-9, `${kg} ${c} ${a}→${b}`);
});
check("#order the same lift after more same-muscle work than last time is lighter, and says why (first last time → after 3 bench sets: 27.5)", () => {
  const s = ordServed("B", [onDay("A", 1, inc(30, 9), inc(30, 9), inc(30, 8))]);
  assert.equal(s.suggested_kg, 27.5, "30·(1 + 10/30)/(1 + 10/25.5) = 28.73 → the nearest 2.5");
  assert.deepEqual(s.rep_targets, [10, 10, 10]);
  assert.match(s.suggestion_note, /^This time it comes after 3 sets that also work your chest \(last time it came first\), so I've made it 27\.5 kg\.$/,
    "no 'Today': the read-out quotes this note about the NEXT session (Burst 5 review C20)");
});
check("#order the reverse — fresher than last time: the earned step up, with the order in the aims (27.5×10,10,10 after bench → 30 × 8 · 8 · 8)", () => {
  const s = ordServed("A", [onDay("B", 1, inc(27.5, 10), inc(27.5, 10), inc(27.5, 10))]);
  assert.equal(s.suggested_kg, 30, "capacity AT 30 carried over: 31.11 → 30. The anchor's own capacity would say 32.5 — ~5 reps at 1 RIR, under 6-10");
  assert.deepEqual(s.rep_targets, [8, 8, 8], "without the order the aim would be 7 · 7 · 7");
  assert.match(s.suggestion_note, /top of the range — add 2\.5 kg/, "the order didn't move the weight, so the reason is the base rule's");
});
check("#order a stable slot, or a difference under 2 weighted sets, changes nothing (byte-identical)", () => {
  const same = [onDay("B", 1, inc(30, 9), inc(30, 9), inc(30, 8))];
  assert.deepEqual(ordServed("B", same), servedLift(incEx(ordProg, "B"), same, {}, undefined, null), "the same day as last time");
  const tri = { ...ordProg, sessions: [ordProg.sessions[0], { name: "T", exercises: [{ exercise: "dumbbell-overhead-triceps-extension", sets: 3, rep_range: "10-15", rir: "1-3" }, { exercise: "incline-dumbbell-press", sets: 3, rep_range: "6-10", rir: "1-3" }] }] };
  const fromA = [onDay("A", 1, inc(30, 9), inc(30, 9), inc(30, 8))];
  assert.deepEqual(ordServed("T", fromA, {}, null, tri), servedLift(incEx(tri, "T"), fromA, {}, undefined, null), "3 triceps sets × 0.5 = 1.5: under the gate");
  const gone = [{ ...fromA[0], session_name: "Retired day" }];
  assert.deepEqual(ordServed("B", gone), servedLift(incEx(ordProg, "B"), gone, {}, undefined, null), "the anchor's day isn't in the plan any more: no adjustment");
});
check("#order never during a comeback or a taper; a deload week takes the lighter of the two", () => {
  const hist = [onDay("A", 1, inc(30, 9), inc(30, 9), inc(30, 8))];
  assert.equal(ordServed("B", hist, {}, new Date(Date.parse(hist[0].date) + 20 * 86400000).toISOString()).suggested_kg, 26.5, "the comeback ease (30 × 0.88) stands alone");
  assert.equal(ordServed("B", hist, { taper: { setScale: 0.6, rirFloor: 2, daysUntil: 5 } }).suggested_kg, 30, "a taper holds the load");
  assert.equal(ordServed("B", hist, { block: { phase: "deload", week: 6, setScale: 0.5 } }).suggested_kg, 27, "min(27.5, 30 × 0.9)");
});
check("#order a first-time lift after same-muscle work starts a plate lighter (squat after 4 leg-press sets: 40 → 37.5)", () => {
  const prog = { id: "q", name: "Q", sessions: [{ name: "L", exercises: [{ exercise: "leg-press", sets: 4, rep_range: "10-15", rir: "1-3" }, { exercise: "barbell-back-squat", sets: 3, rep_range: "6-10", rir: "1-2" }] }] };
  const sq = buildToday({ profile: { training_status: "intermediate", days_per_week: 3 }, program: prog }, [], null, [], null, 80).exercises.find((r) => r.exercise === "barbell-back-squat");
  assert.equal(sq.suggested_kg, 37.5, "40·(1 + 7/30)/(1 + 7/24) = 38.19 → 37.5");
  assert.match(sq.suggestion_note, /after 4 sets that also work your thighs \(quads\)/);
});
check("#order alternating days never ratchet: performing exactly as aimed, the weights come back to where they started", () => {
  // A 6-12 range keeps every aim under the top, so the base rule holds and only the order moves the weight.
  const p12 = { ...ordProg, sessions: ordProg.sessions.map((s) => ({ ...s, exercises: s.exercises.map((e) => ({ ...e, rep_range: "6-12" })) })) };
  let hist = [onDay("A", 1, inc(30, 9), inc(30, 9), inc(30, 8))];
  const seen = [];
  for (let k = 0; k < 6; k++) {
    const day = k % 2 === 0 ? "B" : "A";
    const s = ordServed(day, hist, {}, null, p12);
    seen.push([s.suggested_kg, s.rep_targets.join(",")]);
    hist = [...hist, onDay(day, 2 + k, ...s.rep_targets.map((r) => inc(s.suggested_kg, r)))];
  }
  assert.deepEqual(seen, [[27.5, "11,11,10"], [30, "9,9,8"], [27.5, "11,11,10"], [30, "9,9,8"], [27.5, "11,11,10"], [30, "9,9,8"]],
    "B after bench is 27.5 × 11 · 11 · 10; doing exactly that brings A back to 30 × 9 · 9 · 8 — where it began");
});

// --- Burst 5 review fixes. Each case below was confirmed by a reproducer and a refuter.
// C7: a comeback ease (×0.88) aims at last time's reps — the ease is the point; Epley must not convert it back.
check("#rep-aim a comeback row aims at last time's reps (the ease is the point), not the range top", () => {
  const hist = [brDay(1, brSet(100, 8), brSet(100, 8), brSet(100, 8))];
  const s = aim("barbell-bench-press", "8-12", "1-3", 3, hist);
  const back = servedLift({ exercise: "barbell-bench-press", sets: 3, rep_range: "8-12", rir: "1-3" }, hist, {}, undefined, new Date(Date.parse(hist[0].date) + 20 * 86400000).toISOString());
  assert.equal(back.suggested_kg, 88, "precondition: the comeback ease");
  assert.deepEqual(back.rep_targets, [8, 8, 8], "was [12,12,12]: Epley undid the ease");
  assert.deepEqual(s.rep_targets, [9, 9, 9], "a normal hold still beats last time");
});
// C8: the same load beats last time by a rep only at the same effort; a taper or a week-1 band further from
// failure lowers the aim by the band shift.
check("#rep-aim a band further from failure today (taper, week 1) lowers the aim — the +1 is for the same effort", () => {
  // The band the anchor was served with is its stored target (W280) — what every finished workout sends.
  const hist = [withTargets([{ exercise: "barbell-bench-press", sets: 3, rep_range: "8-12", rir: "1-2" }], brSet(100, 8), brSet(100, 8), brSet(100, 7))];
  const taper = aim("barbell-bench-press", "8-12", "1-2", 3, hist, { taper: { setScale: 0.6, rirFloor: 3, daysUntil: 5 } });
  assert.equal(taper.rirBand, "3-4", "precondition");
  assert.deepEqual(taper.rep_targets, [6, 6], "8 + 1 in reserve − 3: inside the taper's 3-4 band (was [9,9]: 0 in reserve)");
  const wk1 = aim("barbell-bench-press", "8-12", "1-2", 3, hist, { block: { week: 1, setScale: 0.7 } });
  assert.equal(wk1.rirBand, "2-3", "precondition");
  assert.deepEqual(wk1.rep_targets, [7, 7]);
  const noBand = aim("barbell-bench-press", "8-12", "1-2", 3, [brDay(1, brSet(100, 8), brSet(100, 8), brSet(100, 7))], { block: { week: 1, setScale: 0.7 } });
  assert.deepEqual(noBand.rep_targets, [9, 9], "a session without its served band (an older build) keeps the +1: no shift is known");
});
// C10: a ramp logged as work sets (or a warm-up not marked) must not set today's aim: only last time's sets at or
// above the anchor weight count.
check("#rep-aim a ramp logged as work sets doesn't drag the aim down (80×12, 90×10, 100×8 → 9 · 9 · 9, not 3 · 6 · 9)", () => {
  const ramp = aim("barbell-bench-press", "8-12", "1-3", 3, [brDay(1, brSet(80, 12), brSet(90, 10), brSet(100, 8))]);
  assert.equal(ramp.suggested_kg, 100, "precondition: anchored on 100");
  assert.deepEqual(ramp.rep_targets, [9, 9, 9]);
  assert.deepEqual(aim("barbell-bench-press", "6-10", "1-2", 3, [brDay(1, brSet(60, 10), brSet(100, 8), brSet(100, 8))]).rep_targets, [9, 9, 9], "an unmarked warm-up");
  assert.deepEqual(aim("barbell-bench-press", "6-10", "1-2", 3, [brDay(1, brSet(70, 5), brSet(62.5, 7), brSet(62.5, 6))]).rep_targets, [8, 8, 7], "a heavier first set still counts (unchanged)");
});
// C3 + C9: the position only ever moves the weight its own way, from the weight's own grid: a later slot is never
// heavier, an earlier slot never lighter, and equal position costs (both at the 25% cap) move nothing.
const ordP = (sessions) => ({ id: "op2", name: "Order 2", sessions });
const incE = { exercise: "incline-dumbbell-press", sets: 3, rep_range: "6-10", rir: "1-3" };
check("#order an off-grid weight never moves the wrong way (a pounds user's 40 lb = 18.14 kg; a typed 32 kg)", () => {
  const p = ordP([{ name: "A", exercises: [incE] }, { name: "B2", exercises: [{ exercise: "barbell-bench-press", sets: 2, rep_range: "6-10", rir: "1-3" }, incE] }]);
  const fresher = ordServed("A", [onDay("B2", 1, inc(18.14, 7), inc(18.14, 7), inc(18.14, 6))], {}, null, p);
  assert.equal(fresher.suggested_kg, 18.14, "first today, after 2 bench sets last time: never lighter (was 17.5)");
  const harder = ordServed("B2", [onDay("A", 1, inc(32, 7), inc(32, 7), inc(32, 6))], {}, null, p);
  assert.equal(harder.suggested_kg, 32, "after 2 bench sets today, first last time: never heavier (was 32.5)");
  assert.equal(harder.suggestion_note, "This time it comes after 2 sets that also work your chest (last time it came first) — the same 32 kg, with today's aim allowing for that.",
    "the weight didn't move, but the position lowers the aim: the note says why (fix verification R11)");
  assert.deepEqual(harder.rep_targets, [7, 7, 6], "last time + 1, less the position's cost (8 reps of capacity × 10% = 0.8)");
  // A full step moves from the weight's OWN grid: 90 lb (40.82 kg) after 5 bench sets is one 2.5 kg step lighter,
  // 38.32 — not the absolute grid's 37.5.
  const p5 = ordP([{ name: "A", exercises: [incE] }, { name: "B5", exercises: [{ exercise: "barbell-bench-press", sets: 5, rep_range: "6-10", rir: "1-3" }, incE] }]);
  assert.equal(ordServed("B5", [onDay("A", 1, inc(40.82, 7), inc(40.82, 7), inc(40.82, 6))], {}, null, p5).suggested_kg, 38.32);
});
check("#order positions that cost the same (both at the 25% cap) move nothing", () => {
  const p = ordP([{ name: "A5", exercises: [{ exercise: "barbell-bench-press", sets: 5, rep_range: "6-10", rir: "1-3" }, incE] },
    { name: "C8", exercises: [{ exercise: "barbell-bench-press", sets: 8, rep_range: "6-10", rir: "1-3" }, incE] }]);
  const hist = [onDay("A5", 1, inc(32, 7), inc(32, 7), inc(32, 6))];
  const s = ordServed("C8", hist, {}, null, p);
  assert.deepEqual(s, servedLift(incEx(p, "C8"), hist, {}, undefined, null), "5 and 8 sets both cost 25%: byte-identical to no slot (was 32.5 under a 'comes later' note)");
});
// C5: a barbell lift never goes under the empty bar.
check("#order never serves a barbell lift under the empty bar", () => {
  const curl = { exercise: "barbell-curl", sets: 3, rep_range: "8-12", rir: "1-3" };
  const p = ordP([{ name: "A", exercises: [curl] }, { name: "B", exercises: [{ exercise: "chin-up", sets: 3, rep_range: "6-10", rir: "1-3" }, { exercise: "hammer-curl", sets: 3, rep_range: "8-12", rir: "1-3" }, curl] }]);
  const cs = (w, reps) => ({ exercise: "barbell-curl", set_type: "work", weight_kg: w, reps });
  const s = servedLift(curl, [onDay("A", 1, cs(20, 12), cs(20, 11), cs(20, 10))], {}, undefined, null, { program: p, session: p.sessions[1] });
  assert.equal(s.suggested_kg, 20, "the order said 17.5; a barbell can't weigh less than the bar");
});
// C6: the note never calls a weight no heavier than last time "the step up you'd earned".
check("#order when the order cancels an earned step up, the note says so", () => {
  const p = ordP([{ name: "A", exercises: [incE] }, { name: "B4", exercises: [{ exercise: "barbell-bench-press", sets: 4, rep_range: "6-10", rir: "1-3" }, incE] }]);
  const s = ordServed("B4", [onDay("A", 1, inc(30, 10), inc(30, 10), inc(30, 10))], {}, null, p);
  assert.equal(s.suggested_kg, 30, "the base rule's 32.5, carried to after 4 bench sets");
  assert.match(s.suggestion_note, /you'd earned a step up, but this position cancels it/);
  assert.doesNotMatch(s.suggestion_note, /the step up you'd earned, adjusted/);
});
// C17: in a deload week the order still runs, and the lighter of the two wins — here the order's.
check("#order in a deload week the order's weight wins when it is the lighter, with its own reason", () => {
  const fly = { exercise: "dumbbell-fly", sets: 3, rep_range: "15-20", rir: "1-3" };
  const p = ordP([{ name: "A", exercises: [fly] }, { name: "D", exercises: [{ exercise: "barbell-bench-press", sets: 5, rep_range: "6-10", rir: "1-3" }, fly] }]);
  const fs = (w, reps) => ({ exercise: "dumbbell-fly", set_type: "work", weight_kg: w, reps });
  const s = servedLift(fly, [onDay("A", 1, fs(30, 19), fs(30, 19), fs(30, 18))], { block: { phase: "deload", week: 6, setScale: 0.5 } }, undefined, null, { program: p, session: p.sessions[1] });
  assert.equal(s.suggested_kg, 26, "30·(1 + 20/30)/(1 + 20/22.5) = 26.47 → 26, under the deload's 27");
  assert.match(s.suggestion_note, /^This time it comes after 5 sets that also work your chest/);
});

// --- Burst 5 fix verification (R2): on a day served lighter than the anchor (a W279 ease), last time's sets AT
// today's load still count — the ramp floor is the lighter of the two.
check("#rep-aim a lighter day than the anchor keeps last time's sets at today's load (70×5, 62.5×7,6 eased to 62.5 → 8 · 8 · 7)", () => {
  const s = aim("barbell-bench-press", "8-12", "1-3", 3, [brDay(1, brSet(70, 5), brSet(62.5, 7), brSet(62.5, 6))]);
  assert.equal(s.suggested_kg, 62.5, "precondition: the W279 ease from set 1 at 70");
  assert.deepEqual(s.rep_targets, [8, 8, 7], "was [8,8,8]: set 3's own 6 at 62.5 was thrown out");
});
// --- (R3) a heavier set that failed the range is no evidence for the aim, just as it never anchors.
check("#rep-aim a failed heavy single never sets the aim (110×1, 100×8, 100×8 → 9 · 9 · 9, not 3 · 9 · 9)", () => {
  const s = aim("barbell-bench-press", "6-10", "1-2", 3, [brDay(1, brSet(110, 1, { rir: 0 }), brSet(100, 8, { rir: 1 }), brSet(100, 8, { rir: 1 }))]);
  assert.equal(s.suggested_kg, 100);
  assert.deepEqual(s.rep_targets, [9, 9, 9]);
});
// --- (R10) when this week's band lowers the aim, the reason says so — never "try to add a rep or two".
check("#rep-aim a band-shifted aim comes with its own reason (a block's first week; a taper)", () => {
  const hist = [withTargets([{ exercise: "barbell-bench-press", sets: 3, rep_range: "8-12", rir: "1-2" }], brSet(100, 8), brSet(100, 8), brSet(100, 7))];
  const wk1 = aim("barbell-bench-press", "8-12", "1-2", 3, hist, { block: { week: 1, setScale: 0.7 } });
  assert.equal(wk1.suggestion_note, "Same weight as last time — this week asks for 2–3 reps in reserve (1 more than last time), so aim for a rep fewer per set.");
  const taper = aim("barbell-bench-press", "8-12", "1-2", 3, hist, { taper: { setScale: 0.6, rirFloor: 3, daysUntil: 5 } });
  assert.equal(taper.suggestion_note, "Taper — same weight, more left in the tank (3–4 in reserve), so aim for 2 reps fewer per set than last time.");
});
// --- (R11) the position still shapes the aim when the weight can't move (the bar, under half a step): +1, less its cost.
check("#order a position that can't move the weight still explains the lower aim (a barbell curl at the bar)", () => {
  const curl = { exercise: "barbell-curl", sets: 3, rep_range: "8-12", rir: "1-3" };
  const p = ordP([{ name: "A", exercises: [curl] }, { name: "B", exercises: [{ exercise: "chin-up", sets: 3, rep_range: "6-10", rir: "1-3" }, { exercise: "hammer-curl", sets: 3, rep_range: "8-12", rir: "1-3" }, curl] }]);
  const cs = (w, reps) => ({ exercise: "barbell-curl", set_type: "work", weight_kg: w, reps });
  const s = servedLift(curl, [onDay("A", 1, cs(20, 12), cs(20, 11), cs(20, 10))], {}, undefined, null, { program: p, session: p.sessions[1] });
  assert.equal(s.suggested_kg, 20);
  assert.equal(s.suggestion_note, "This time it comes after 6 sets that also work your biceps (last time it came first) — the same 20 kg, with today's aim allowing for that.");
  assert.deepEqual(s.rep_targets, [10, 9, 8], "13 − 13·0.25, 12 − 12·0.25, 11 − 11·0.25: the +1 survives, less the cost");
});

console.log(`\n${passed} coach test(s) passed.`);
