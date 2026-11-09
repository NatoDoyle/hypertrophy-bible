// Pure UI helpers (app/public/ui-helpers.mjs) — the testable half of the Wave-244
// path shorteners. app.js itself cannot be imported under Node (top-level DOM), so
// anything with real logic lives here, red-first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupSessionsByWeek, mondayOf, weekLabelOf, seedCalendarDays, filterExercises, linePath, sideCue, shiftDay, dayLabel, hubWorkoutState, calendarDrift, calendarAdvice, bringBackCopy, swapUndoCopy, weekStrip, weekChipLabel, nextSessionLine, crossesBlockEnd, offPlanLabel, offPlanPreview, planFitCopy, planFitRequest, planFitVisible, timeFitCopy, timeFitRequest, noteInUnit, hintCopy, readoutLists, MUSCLE_LABEL, friendlyMuscle, friendlyList , notifyOffer, trainingDaysHint, DEVICE_PREFS } from "../public/ui-helpers.mjs";
import * as uiHelpers from "../public/ui-helpers.mjs"; // Burst 5's new exports, read so a missing one fails its own check
import { suggestWeight, MUSCLE_PLAIN, servedLift } from "../src/coach.mjs";
import { prefillInUnit } from "../public/session-core.mjs";
import * as sessionCore from "../public/session-core.mjs"; // Burst 8 review: the hint/alternative helpers, read so a missing one fails its own check

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };
const checkAsync = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

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

check("filterExercises (W283): word by word, plural-tolerant, alias-aware, any order — 'Jefferson curls' finds the Jefferson curl", () => {
  const list = [
    { name: "Barbell Jefferson Curl", aliases: ["Jefferson curl", "Jefferson curls"], primary_muscles: ["spinal-erectors"], equipment: "barbell" },
    { name: "Lat Pulldown", primary_muscles: ["lats"], equipment: "cable" },
    { name: "Barbell Curl", primary_muscles: ["biceps"], equipment: "barbell" },
    { name: "Romanian Deadlift", aliases: ["RDL"], primary_muscles: ["hamstrings"], equipment: "barbell" },
  ];
  const names = (q) => filterExercises(list, q).map((e) => e.name);
  assert.deepEqual(names("Jefferson curls"), ["Barbell Jefferson Curl"]);
  assert.deepEqual(names("curl jefferson"), ["Barbell Jefferson Curl"], "any word order");
  assert.deepEqual(names("jeff"), ["Barbell Jefferson Curl"], "type-ahead");
  assert.deepEqual(names("lat pulldowns"), ["Lat Pulldown"]);
  assert.deepEqual(names("curls"), ["Barbell Jefferson Curl", "Barbell Curl"]);
  assert.deepEqual(names("rdl"), ["Romanian Deadlift"], "an alias alone finds it");
  assert.deepEqual(names("barbell curl"), ["Barbell Jefferson Curl", "Barbell Curl"], "every word must match somewhere");
  assert.deepEqual(names("lats pulldown"), ["Lat Pulldown"], "a muscle word and a name word together");
  assert.deepEqual(names("jefferson press"), [], "no partial credit");
});

// W283 review: the search a lifter actually does, over BOTH row shapes — the editor's (muscle ids)
// and the library's (display names + muscle_ids) must answer every query the same.
check("filterExercises (W283 review): '-ups' plurals, muscle words, mid-word, no stem false-friends — identically in the editor and the library", () => {
  const DISPLAY = { lats: "Latissimus Dorsi (Lats)", chest: "Chest (Pectoralis Major)", quadriceps: "Quadriceps", "side-delts": "Lateral Deltoid", biceps: "Biceps Brachii", neck: "Neck Flexors & Extensors", triceps: "Triceps Brachii", hamstrings: "Hamstrings", glutes: "Gluteus Maximus", abs: "Abdominals (Rectus Abdominis & Obliques)", "upper-back": "Upper Back (Trapezius & Rhomboids)", "spinal-erectors": "Spinal Erectors (Erector Spinae)" };
  const rows = [
    ["Pull-Up", ["lats"], "bodyweight"], ["Push-Up", ["chest"], "bodyweight"], ["Chin-Up", ["lats"], "bodyweight"], ["Dumbbell Step-Up", ["quadriceps"], "dumbbell"],
    ["Lat Pulldown", ["lats"], "cable"], ["Cable Lateral Raise", ["side-delts"], "cable"], ["Hammer Curl", ["biceps"], "dumbbell"], ["Lying Lateral Neck Flexion", ["neck"], "bodyweight"],
    ["Triceps Pushdown", ["triceps"], "cable"], ["Romanian Deadlift", ["hamstrings"], "barbell", ["RDL"]], ["Reverse Hyperextension", ["glutes"], "machine"], ["Glute Kickback", ["glutes"], "cable"],
    ["Hip Abduction Machine", ["glutes"], "machine"], ["Cable Crunch", ["abs"], "cable"], ["Barbell Shrug", ["upper-back"], "barbell"], ["T-Bar Row", ["upper-back"], "barbell"],
    ["Close-Grip Bench Press", ["triceps"], "barbell"], ["Dumbbell Flye", ["chest"], "dumbbell"], ["Barbell Jefferson Curl", ["spinal-erectors"], "barbell", ["Jefferson curl", "Jefferson curls"]],
  ];
  const api = rows.map(([name, ids, equipment, aliases = []]) => ({ name, aliases, primary_muscles: ids, equipment }));
  const lib = rows.map(([name, ids, equipment, aliases = []]) => ({ name, aliases, primary_muscles: ids.map((m) => DISPLAY[m]), muscle_ids: ids, equipment }));
  const expect = {
    "pull ups": ["Pull-Up"], "push-ups": ["Push-Up"], "pullups": ["Pull-Up"], "chin ups": ["Chin-Up"], "step ups": ["Dumbbell Step-Up"],
    "flies": ["Dumbbell Flye"], "flyes": ["Dumbbell Flye"], "db flye": ["Dumbbell Flye"],
    "abs": ["Cable Crunch"], "traps": ["Barbell Shrug", "T-Bar Row"], "pecs": ["Push-Up", "Dumbbell Flye"], "lower back": ["Barbell Jefferson Curl"], "quads": ["Dumbbell Step-Up"],
    "down": ["Lat Pulldown", "Triceps Pushdown"], "lift": ["Romanian Deadlift"], "extension": ["Reverse Hyperextension"],
    "lats": ["Pull-Up", "Chin-Up", "Lat Pulldown"], "hams": ["Romanian Deadlift"], "t-bar": ["T-Bar Row"],
    "jefferson curls": ["Barbell Jefferson Curl"], "rdl": ["Romanian Deadlift"],
  };
  for (const [q, want] of Object.entries(expect)) {
    assert.deepEqual(filterExercises(api, q).map((e) => e.name), want, `editor: "${q}"`);
    assert.deepEqual(filterExercises(lib, q).map((e) => e.name), want, `library: "${q}"`);
  }
  assert.ok(filterExercises(api, "back").some((e) => e.name === "Glute Kickback"), "'back' still finds a kickback (mid-word)");
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

// --- The Today hub's ONE workout decision (W271): day one, rest, missed and unplanned
// can't drift apart when one function decides. A never-trained user's first workout is
// ALWAYS the hero — saving days on the day-one card must not demote it (critic, W271).
check("hubWorkoutState: done and rest win; a first-ever workout and a comeback are always 'start'", () => {
  const base = { daily: { workout_logged: false, rest_day: false, planned_today: false, missed_planned_day: null }, session: { never_trained: false }, status: { state: "on-track" } };
  const st = (patch) => hubWorkoutState({ daily: { ...base.daily, ...patch.daily }, session: { ...base.session, ...patch.session }, status: { ...base.status, ...patch.status } });
  assert.equal(st({ daily: { workout_logged: true } }), "done");
  assert.equal(st({ daily: { rest_day: true } }), "rest");
  assert.equal(st({ session: { never_trained: true } }), "start", "day one beats an off-plan day");
  assert.equal(st({ status: { state: "comeback" } }), "start", "a returner isn't gated behind an old schedule");
  assert.equal(st({}), "unplanned");
  assert.equal(st({ daily: { missed_planned_day: { day: "mon", date: "2026-10-12" } } }), "missed");
  assert.equal(st({ daily: { planned_today: true } }), "start");
  assert.equal(st({ daily: { planned_today: null } }), "start", "no plan at all: exactly as before");
  // W271 review: a PAUSED (sick/injured) user is promised no pressure — never "Missed Monday? Catch up today".
  assert.notEqual(st({ daily: { missed_planned_day: { day: "mon", date: "2026-10-12" } }, status: { state: "paused" } }), "missed");
});

// --- The week strip (C16, W277): the rotation's next sessions laid onto the days still
// ahead, with the HUB's decision about today (so the two can never disagree), past days
// from what was logged, and never the word "missed". W41: Mon 2026-10-05 .. Sun 10-11.
const wkDays = (patch = {}) => ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day, i) => ({
  date: `2026-10-${String(5 + i).padStart(2, "0")}`, day, committed: ["mon", "wed", "fri"].includes(day), bound: ["mon", "wed", "fri"].includes(day), trained: [], rest: false, ...(patch[day] ?? {}) }));
const PPL = ["Push A", "Pull A", "Legs A", "Push A", "Pull A", "Legs A", "Push A", "Pull A"];
const strip = (wp, opts) => { const s = weekStrip(wp, opts); return s && { line: s.entries.map(weekChipLabel).join(" | "), next_week: s.next_week }; };
check("weekStrip: an on-plan week reads Mon ✓ · Today · Fri, and names nothing for next week (it starts where it always does)", () => {
  const wp = { days: wkDays({ mon: { trained: ["Push A"] } }), upcoming: PPL.slice(1) };
  assert.deepEqual(strip(wp, { todayKey: "2026-10-07", hubState: "start" }), { line: "Mon ✓ Push A | Today · Pull A | Fri · Legs A", next_week: null });
});
check("weekStrip: a missed Monday slides everything along — a plain dash, the catch-up today, and the session the week runs out before", () => {
  const wp = { days: wkDays(), upcoming: PPL };
  const s = strip(wp, { todayKey: "2026-10-07", hubState: "missed" });
  assert.deepEqual(s, { line: "Mon – | Today · Push A | Fri · Pull A", next_week: "Legs A" });
  assert.ok(!/missed|✗|failed/i.test(s.line + s.next_week), "never shame (guardrail)");
});
check("weekStrip: in a block's LAST week the strip names nothing for next week — a fresh block opens at Day A, so 'X starts next week' would be a broken promise", () => {
  const wp = { days: wkDays(), upcoming: PPL };
  assert.deepEqual(strip(wp, { todayKey: "2026-10-07", hubState: "missed", blockEnds: true }), { line: "Mon – | Today · Push A | Fri · Pull A", next_week: null });
});
check("weekStrip: today follows the HUB — an unplanned day takes no slot, a catch-up (missed) or first-ever workout does", () => {
  const wp = { days: wkDays(), upcoming: PPL };
  assert.equal(strip(wp, { todayKey: "2026-10-06", hubState: "unplanned" }).line, "Mon – | Wed · Push A | Fri · Pull A", "Tuesday off-plan: next is Wednesday (Push A) — the hub's own line");
  assert.equal(strip(wp, { todayKey: "2026-10-06", hubState: "missed" }).line, "Mon – | Today · Push A | Wed · Pull A | Fri · Legs A", "Tuesday catch-up: the week is whole again");
  assert.equal(strip(wp, { todayKey: "2026-10-06", hubState: "start" }).line, "Mon – | Today · Push A | Wed · Pull A | Fri · Legs A", "a first-ever workout or a comeback is the hero on any day");
});
check("weekStrip: done today shows what was done, and the rest of the week starts from the NEXT session", () => {
  const wp = { days: wkDays({ mon: { trained: ["Push A"] }, wed: { trained: ["Pull A"] } }), upcoming: PPL.slice(2) };
  assert.deepEqual(strip(wp, { todayKey: "2026-10-07", hubState: "done" }), { line: "Mon ✓ Push A | Wed ✓ Pull A | Fri · Legs A", next_week: null });
});
check("weekStrip: a committed day marked REST today takes no slot — the hub says rest, so the week starts from the next day", () => {
  const wp = { days: wkDays({ wed: { rest: true } }), upcoming: PPL };
  assert.equal(strip(wp, { todayKey: "2026-10-07", hubState: "rest" }).line, "Mon – | Wed 🌿 rest | Fri · Push A");
});
check("weekStrip: two workouts on one day show both, and neither is named again for next week", () => {
  const wp = { days: wkDays({ mon: { trained: ["Push A", "Pull A"] } }), upcoming: ["Legs A", "Push A", "Pull A", "Legs A"] };
  assert.deepEqual(strip(wp, { todayKey: "2026-10-07", hubState: "start" }), { line: "Mon ✓ Push A + Pull A | Today · Legs A | Fri · Push A", next_week: null });
});
check("weekStrip: rest marks, unbound days (a plan made mid-week), extra days and unnamed rows", () => {
  const wp = { days: wkDays({ mon: { bound: false }, tue: { trained: [null] }, wed: { rest: true } }), upcoming: PPL.slice(1) };
  assert.equal(strip(wp, { todayKey: "2026-10-08", hubState: "unplanned" }).line, "Tue ✓ | Wed 🌿 rest | Fri · Pull A",
    "Mon predates the promise (no claim); Tuesday's extra workout shows; Wednesday rested");
});
check("weekStrip: fewer days than the plan has sessions — the next one is named for next week; more days repeat in order", () => {
  const four = ["Upper A", "Lower A", "Upper B", "Lower B", "Upper A", "Lower A", "Upper B", "Lower B"];
  assert.deepEqual(strip({ days: wkDays(), upcoming: four }, { todayKey: "2026-10-05", hubState: "start" }),
    { line: "Today · Upper A | Wed · Lower A | Fri · Upper B", next_week: "Lower B" });
  const two = { days: wkDays(), upcoming: ["Full A", "Full B", "Full A", "Full B", "Full A", "Full B", "Full A", "Full B"] };
  assert.deepEqual(strip(two, { todayKey: "2026-10-05", hubState: "start" }), { line: "Today · Full A | Wed · Full B | Fri · Full A", next_week: null });
  assert.equal(weekStrip(null, { todayKey: "2026-10-05" }), null);
  assert.equal(weekStrip({ days: [], upcoming: [] }, { todayKey: "2026-10-05" }), null);
});
// A training block's last week, once trained, rolls over next week to Day A (W277 review):
// every line that names NEXT week's session must stop naming it — one predicate, three lines.
check("crossesBlockEnd: only when the block rolls over AND the next workout is past this Sunday (or unknown)", () => {
  const at = (nextDate, rolls = true) => crossesBlockEnd({ rollsOver: rolls, nextDate, todayKey: "2026-10-09" }); // a Friday
  assert.equal(at("2026-10-11"), false, "Sunday is still this week — no rollover before it");
  assert.equal(at("2026-10-12"), true, "Monday is the new block");
  assert.equal(at(null), true, "no plan: whenever it is, it's not this week's pointer");
  assert.equal(at("2026-10-12", false), false);
  assert.equal(crossesBlockEnd({ rollsOver: true, nextDate: "2026-10-12", todayKey: "2026-10-11" }), true, "on the Sunday itself");
});
check("nextSessionLine / offPlanLabel / offPlanPreview: across a block rollover they name the day, never next week's session", () => {
  const mon = { day: "mon", date: "2026-10-12" };
  assert.equal(nextSessionLine({ nextDay: mon, todayKey: "2026-10-09", name: "Lower B", crossesBlock: true }), "Next: Monday — a new training block starts.");
  assert.equal(nextSessionLine({ nextDay: null, todayKey: "2026-10-09", name: "Lower B", crossesBlock: true }), "A new training block starts next week.");
  assert.equal(offPlanLabel({ nextDay: mon, name: "Lower B", crossesBlock: false }), "Not a training day — next: Monday (Lower B)");
  assert.equal(offPlanLabel({ nextDay: mon, name: "Lower B", crossesBlock: true }), "Not a training day — next: Monday, when a new training block starts");
  assert.equal(offPlanLabel({ nextDay: null, name: "Lower B", crossesBlock: false }), "Not a training day — next: your next training day (Lower B)");
  assert.equal(offPlanPreview({ nextDay: mon, name: "Lower B", crossesBlock: false }), "Preview Monday's workout — Lower B");
  assert.equal(offPlanPreview({ nextDay: mon, name: "Lower B", crossesBlock: true }), "Preview Lower B — what “Train anyway” starts today");
});
check("nextSessionLine: the next workout by day — tomorrow, a weekday, or (no plan) just next up", () => {
  assert.equal(nextSessionLine({ nextDay: { day: "thu", date: "2026-10-08" }, todayKey: "2026-10-07", name: "Legs A" }), "Next: tomorrow — Legs A.");
  assert.equal(nextSessionLine({ nextDay: { day: "fri", date: "2026-10-09" }, todayKey: "2026-10-07", name: "Legs A" }), "Next: Friday — Legs A.");
  assert.equal(nextSessionLine({ nextDay: null, todayKey: "2026-10-07", name: "Legs A" }), "Next up: Legs A.");
  assert.equal(nextSessionLine({ nextDay: null, todayKey: "2026-10-07", name: "" }), "");
});

// --- W278 (the owner's option 1): the plan's size vs the days actually committed. The copy
// says what the mismatch costs, what a rebuild changes, and that it starts a fresh block.
// W304 (considerations iteration, Burst 8): the three ways back, worded. Ranked as the owner ranked them; every option
// says what it wins or costs (measured by the engine, never promised); keep says what stays short.
// W305c (Burst 8 review #6 #15 #17 #19 #21 #27 #29 #30 #41 #49): every option says what it wins AND what it newly
// leaves short; keep says only what it forgoes (and any day it leaves long); a landmark is "the usual starting point for
// growth (an estimate)", never "the minimum that builds muscle"; no verb has to agree with a muscle's name; the minutes
// compared are like for like (longest workout, now vs then); a beginner has no block to restart; days still past their
// minutes are said even when sets were cut — and even when no option helps (keep alone, to acknowledge).
const FIT_SHORT = { days: 4, minutes: 60, blocks: true, trimmed_sets: 0, unfit_days: 0, over: [], mev_deficit: 4.5, mev_short: ["chest", "side-delts", "calves"], max_minutes: 49.4, key: "k1",
  options: [
    { kind: "add_day", days: 5, minutes: 60, trimmed_sets: 0, unfit_days: 0, over: [], mev_deficit: 1, mev_short: ["calves", "abs"], max_minutes: 50.7, lifted: ["chest", "side-delts"], newly: ["abs"] },
    { kind: "longer", days: 4, minutes: 75, trimmed_sets: 0, unfit_days: 0, over: [], mev_deficit: 2, mev_short: ["calves"], max_minutes: 61.1, lifted: ["chest", "side-delts"], newly: [] },
    { kind: "keep", days: 4, minutes: 60, trimmed_sets: 0, unfit_days: 0, over: [], mev_deficit: 4.5, mev_short: ["chest", "side-delts", "calves"], max_minutes: 49.4, lifted: [], newly: [], forgoes: ["chest", "side-delts"] }] };
check("timeFitCopy: what's short is 'below the usual starting point for growth (an estimate)' — never 'the minimum that builds muscle' (#6 #19)", () => {
  const c = timeFitCopy(FIT_SHORT);
  assert.equal(c.title, "4 workouts of 60 min leave some muscles short");
  assert.equal(c.body, "Below the usual starting point for growth (an estimate): chest, shoulders (side) and calves.");
  for (const o of c.options) assert.doesNotMatch(`${c.body} ${o.detail}`, /minimum that builds|builds muscle|stays? under the minimum/);
});
check("timeFitCopy: an option says what it lifts AND what it newly leaves short; keep names only what it forgoes (#15 #17)", () => {
  const c = timeFitCopy(FIT_SHORT);
  assert.deepEqual(c.options.map((o) => o.kind), ["add_day", "longer", "keep"]);
  assert.equal(c.options[0].label, "Train 5 days a week");
  assert.match(c.options[0].detail, /^brings chest and shoulders \(side\) up to it · leaves abs below it · /);
  assert.doesNotMatch(c.options[1].detail, /leaves/, "nothing newly short → nothing said about it");
  assert.equal(c.options[2].label, "Keep 4 × 60 min");
  assert.equal(c.options[2].detail, "leaves chest and shoulders (side) below it", "calves are short whatever you pick — not keep's cost");
});
check("timeFitCopy: no verb has to agree with a muscle's name — calves, abs, hamstrings read right alone (#30)", () => {
  const one = { ...FIT_SHORT, mev_short: ["calves"], options: [{ ...FIT_SHORT.options[0], lifted: ["calves"], newly: [], mev_short: [] }, { ...FIT_SHORT.options[2], mev_short: ["calves"], forgoes: ["calves"] }] };
  const c = timeFitCopy(one);
  assert.doesNotMatch(`${c.body} ${c.options.map((o) => o.detail).join(" ")}`, /\b(gets|reaches its|stays)\b/);
  assert.match(c.body, /: calves\.$/);
  assert.match(c.options[0].detail, /^brings calves up to it/);
});
check("timeFitCopy: minutes are compared like for like — the longest workout, then and now (#29 #41)", () => {
  const c = timeFitCopy(FIT_SHORT);
  assert.match(c.options[0].detail, /longest workout about 51 min \(now 49\)/);
  assert.match(c.options[1].detail, /longest workout about 61 min \(now 49\)/, "'Make workouts 75 min' shows what the days would really take");
  assert.doesNotMatch(c.options[0].detail, /min a day/);
});
check("timeFitCopy: a block restart is said only where there are blocks — a beginner has none (#27)", () => {
  assert.match(timeFitCopy(FIT_SHORT).options[0].detail, /starts a fresh 6-week block$/);
  const beg = timeFitCopy({ ...FIT_SHORT, blocks: false });
  for (const o of beg.options) assert.doesNotMatch(o.detail, /block/);
});
check("timeFitCopy: days still past their minutes are said even when sets were cut — never 'to fit', and keep names the overrun (#49)", () => {
  const fit = { days: 4, minutes: 30, blocks: true, trimmed_sets: 5, unfit_days: 2, over: [{ session: "Lower A", minutes: 35.7 }, { session: "Upper A", minutes: 31.2 }],
    mev_deficit: 0, mev_short: [], max_minutes: 35.7, key: "k2",
    options: [{ kind: "longer", days: 4, minutes: 45, trimmed_sets: 0, unfit_days: 0, over: [], mev_deficit: 0, mev_short: [], max_minutes: 41, lifted: [], newly: [] },
      { kind: "keep", days: 4, minutes: 30, trimmed_sets: 5, unfit_days: 2, over: [{ session: "Lower A", minutes: 35.7 }, { session: "Upper A", minutes: 31.2 }], mev_deficit: 0, mev_short: [], max_minutes: 35.7, lifted: [], newly: [], forgoes: [] }] };
  const c = timeFitCopy(fit);
  assert.equal(c.title, "2 workouts run past 30 minutes");
  assert.match(c.body, /^Lower A takes about 36 min, the longest of 2\. 5 sets already came out to save time\.$/);
  assert.doesNotMatch(c.body, /To fit/);
  assert.match(c.options[0].detail, /^every workout fits · longest workout about 41 min \(now 36\)/);
  assert.equal(c.options[1].detail, "Lower A stays about 36 min, and 1 more past 30");
});
check("timeFitCopy: a day past its minutes that no option fixes is still said — keep alone, to acknowledge (#21)", () => {
  const fit = { days: 2, minutes: 30, blocks: true, trimmed_sets: 0, unfit_days: 1, over: [{ session: "Full Body A", minutes: 36.3 }], mev_deficit: 0, mev_short: [], max_minutes: 36.3, key: "k3",
    options: [{ kind: "keep", days: 2, minutes: 30, trimmed_sets: 0, unfit_days: 1, over: [{ session: "Full Body A", minutes: 36.3 }], mev_deficit: 0, mev_short: [], max_minutes: 36.3, lifted: [], newly: [], forgoes: [] }] };
  const c = timeFitCopy(fit);
  assert.equal(c.title, "Full Body A runs past 30 minutes");
  assert.match(c.body, /^Full Body A takes about 36 min\. What's left is your main lifts and the sets your muscles need\.$/);
  assert.deepEqual(c.options.map((o) => [o.kind, o.label, o.detail]), [["keep", "Keep 2 × 30 min", "Full Body A stays about 36 min"]]);
});
// W305h (fix C2): a plan from an older engine is said to be one — never "what's left is what your muscles need" about a
// day nothing was ever trimmed from — and its REFIT keeps the days, the minutes and the block.
check("timeFitCopy: a plan from an older engine says so, and its refit keeps the days and the block (fix C2)", () => {
  const over = [{ session: "Upper B", minutes: 47.2 }];
  const fit = { days: 4, minutes: 45, blocks: true, fitted: false, trimmed_sets: 0, unfit_days: 1, over, mev_deficit: 0, mev_short: [], max_minutes: 47.2, key: "k4",
    options: [{ kind: "refit", days: 4, minutes: 45, trimmed_sets: 0, unfit_days: 0, over: [], mev_deficit: 0, mev_short: [], max_minutes: 44, lifted: [], newly: [] },
      { kind: "keep", days: 4, minutes: 45, trimmed_sets: 0, unfit_days: 1, over, mev_deficit: 0, mev_short: [], max_minutes: 47.2, lifted: [], newly: [], forgoes: [], fitted: false }] };
  const c = timeFitCopy(fit);
  assert.equal(c.body, "Upper B takes about 47 min. Your plan was built before workouts were sized to your minutes.");
  assert.doesNotMatch(c.body, /What's left/);
  assert.equal(c.options[0].label, "Refit to 45 min");
  assert.equal(c.options[0].detail, "every workout fits · same days, same block · longest workout about 44 min (now 47)");
  assert.doesNotMatch(c.options[0].detail, /fresh 6-week block/);
  assert.equal(timeFitCopy({ ...fit, blocks: false }).options[0].detail, "every workout fits · same days · longest workout about 44 min (now 47)", "a beginner has no block to keep");
  assert.deepEqual(timeFitRequest({ kind: "refit", days: 4, minutes: 45 }), { profile: {} }, "a refit asks for no change: the Settings door rebuilds at the same block");
});
check("timeFitCopy: nothing to say → no card", () => {
  assert.equal(timeFitCopy(null), null);
  assert.equal(timeFitCopy({ unfit_days: 0, options: [{ kind: "keep" }] }), null, "keep alone, with nothing over its minutes, is no question");
});
check("timeFitRequest: more days or minutes go through the Settings door; keep has no rebuild", () => {
  assert.deepEqual(timeFitRequest({ kind: "add_day", days: 5 }), { profile: { days_per_week: 5 } });
  assert.deepEqual(timeFitRequest({ kind: "longer", minutes: 60 }), { profile: { session_length_min: 60 } });
  assert.equal(timeFitRequest({ kind: "keep" }), null);
});
check("planFitCopy: fewer days than workouts — they roll into next week, your muscles get less; the rebuild fits the week", () => {
  assert.deepEqual(planFitCopy({ plan_days: 4, committed_days: 3 }), {
    title: "Fit your plan to your 3 days?",
    body: "You've been picking 3 days a week, but your plan has 4 workouts — so workouts keep rolling into the next week, and your muscles get less than the plan was built for. Rebuilt for 3 days, every workout fits your week. It starts a fresh training block.",
    rebuild: "Rebuild for 3 days", keep: "Keep my 4-day plan", key: "4:3", days: 3,
    notice: "🗓️ Rebuilt for 3 days a week — a fresh training block starts with your next workout.", // W305j (J2): the tap's notice, here
  });
});
check("planFitCopy: more days than workouts — they repeat, your muscles get more; no offer without a mismatch", () => {
  const c = planFitCopy({ plan_days: 3, committed_days: 5 });
  assert.equal(c.body, "You've been picking 5 days a week, but your plan has 3 workouts — so workouts repeat within the week, and your muscles get more than the plan was built for. Rebuilt for 5 days, each day gets its own workout. It starts a fresh training block.");
  assert.equal(c.rebuild, "Rebuild for 5 days"); assert.equal(c.keep, "Keep my 3-day plan"); assert.equal(c.key, "3:5");
  assert.equal(planFitCopy(null), null);
  assert.equal(planFitCopy({ plan_days: 4, committed_days: 4 }), null);
});

check("planFitRequest / planFitVisible: the exact request the card sends, and the Keep gate (one pair, this device)", () => {
  const fit = planFitCopy({ plan_days: 4, committed_days: 3 });
  assert.deepEqual(planFitRequest(fit), { profile: { days_per_week: 3 } }, "the COMMITTED count, inside the profile patch the Settings door merges");
  assert.equal(planFitRequest(null), null);
  assert.equal(planFitVisible(fit, null), true);
  assert.equal(planFitVisible(fit, "4:3"), false, "kept: hidden");
  assert.equal(planFitVisible(fit, "4:2"), true, "a different pair is a new situation");
  assert.equal(planFitVisible(null, null), false);
});

// --- The phone-calendar file is the one reminder the app can't change (W271 review):
// when the days in the app no longer match the days last exported, say which.
check("calendarDrift: names the calendar's stale days when the plan changed, nothing when they match or nothing was exported", () => {
  assert.deepEqual(calendarDrift([0, 3], ["mon", "wed"]), { stale: ["Mon", "Thu"] }, "exported Mon/Thu, now Mon/Wed");
  assert.equal(calendarDrift([0, 2], ["wed", "mon"]), null, "same days, any order");
  assert.equal(calendarDrift(null, ["mon"]), null, "never exported");
  assert.equal(calendarDrift([], ["mon"]), null);
  assert.deepEqual(calendarDrift([1], []), { stale: ["Tue"] }, "days cleared but the calendar still reminds");
});

// Review C2/C9: the card must never tell someone to delete the calendar event that
// holds the days the SAME card says are coming back.
check("calendarAdvice: compares the export with the days really in force (or coming back), and says what to do", () => {
  assert.equal(calendarAdvice([0, 2], { days: [], resumeDays: ["mon", "wed"] }), null, "cleared this week, the same days come back: keep the event");
  assert.deepEqual(calendarAdvice([0, 2], { days: [], resumeDays: ["fri"] }), { stale: ["Mon", "Wed"], advice: "delete-if-done" });
  assert.deepEqual(calendarAdvice([0, 2], { days: [], resumeDays: null }), { stale: ["Mon", "Wed"], advice: "save-or-delete" }, "no plan at all (e.g. an expired pre-W271 answer)");
  assert.deepEqual(calendarAdvice([0, 2], { days: ["mon", "thu"] }), { stale: ["Mon", "Wed"], advice: "replace" });
  assert.equal(calendarAdvice([0, 3], { days: ["thu", "mon"] }), null);
  assert.equal(calendarAdvice(null, { days: [] }), null, "never exported");
});

// "Can't do this one?" (W272): the copy says what the server REALLY did (lesson 60).
check("bringBackCopy: exact restore, a rebuild that used it, a rebuild that didn't, and a hand-built plan each say what happened", () => {
  assert.equal(bringBackCopy({ mode: "exact", name: "Hack squat" }), "Hack squat is back in your plan.");
  assert.equal(bringBackCopy({ mode: "rebuilt", restored: 1, name: "Hack squat" }), "Hack squat is back — your plan was rebuilt with it available.");
  assert.equal(bringBackCopy({ mode: "rebuilt", restored: 0, name: "Hack squat" }), "Hack squat is available again — your plan will use it when it fits.");
  assert.equal(bringBackCopy({ mode: "lifted", name: "Hack squat" }), "Hack squat is available again — add it back in the plan editor whenever you like.");
});
check("swapUndoCopy: an Undo that put the lift back vs one the live session refused (a set of the substitute is banked)", () => {
  assert.equal(swapUndoCopy({ revertedLive: true, permanent: true, from: "Hack squat", to: "Leg press" }), "Hack squat is back — in today's workout and your plan.");
  assert.equal(swapUndoCopy({ revertedLive: false, permanent: true, from: "Hack squat", to: "Leg press" }), "Leg press stays for today (you've started it) — Hack squat is back from your next session.");
  assert.equal(swapUndoCopy({ revertedLive: true, permanent: false, from: "Hack squat", to: "Leg press" }), "Hack squat is back.");
  assert.equal(swapUndoCopy({ revertedLive: true, permanent: false, from: "Hack squat", to: "Hack squat", same: true }), "Hack squat is back as it was.", "undoing a tired ease (Burst 6 round 3): as it was, skips included");
});

// --- Day chooser math (owner report: "I can't log yesterday's weight or calories").
// Calendar-day arithmetic on YYYY-MM-DD strings: subtracting 24h from an instant
// skips or repeats a day across a DST change (the retro-log's localDayAgo did).
check("shiftDay: whole calendar days across month, year and leap edges — no clock, no DST", () => {
  assert.equal(shiftDay("2026-10-11", -1), "2026-10-10");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDay("2028-03-01", -1), "2028-02-29"); // leap year
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDay("2026-10-11", -30), "2026-09-11");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDay("not-a-day", -1), null);
});

check("dayLabel: today / yesterday in words, older days as a short weekday + date", () => {
  assert.equal(dayLabel("2026-10-11", "2026-10-11"), "today");
  assert.equal(dayLabel("2026-10-10", "2026-10-11"), "yesterday");
  assert.equal(dayLabel("2026-10-05", "2026-10-11"), "Mon 5 Oct");
  assert.equal(dayLabel("2025-12-31", "2026-01-01"), "yesterday");
});

// --- Side cues (owner report: "walking lunges say do one leg at a time, which is
// impossible"). The player banks ONE set per ✓, so a cue must describe one set as
// both sides; an alternating lift must never be told to finish one side first.
check("sideCue: an alternating lift alternates every rep and counts each leg (never 'all sets left first')", () => {
  const cue = sideCue({ unilateral: true, alternating: true, movement_pattern: "lunge", rep_range: "8-12" });
  assert.match(cue, /Alternate legs every rep/);
  assert.match(cue, /8-12 each leg is 16-24 steps in total/);
  assert.match(cue, /Tap ✓ when the set's done/);
  assert.doesNotMatch(cue, /all \d+ sets|left\b/i);
});

check("sideCue: a one-side-at-a-time lift does left then right inside ONE set (one ✓ per set, matching how sets bank)", () => {
  const cue = sideCue({ unilateral: true, movement_pattern: "horizontal-pull", rep_range: "10" });
  assert.match(cue, /each set is your <b>left<\/b> side, then straight into your <b>right<\/b>/);
  assert.match(cue, /Tap ✓ once both are done/);
  assert.doesNotMatch(cue, /all \d+ sets with your/);
});

check("sideCue: superset station rounds say the same thing in round terms", () => {
  assert.match(sideCue({ unilateral: true, rep_range: "10-15" }, { station: true }), /this round is one set with your <b>left<\/b> and one with your <b>right<\/b>/);
  assert.match(sideCue({ unilateral: true, alternating: true, movement_pattern: "lunge", rep_range: "10" }, { station: true }), /Alternate legs every rep.*10 each leg is 20 steps in total.*One round is one set like that/);
});

check("sideCue: bilateral lifts get no cue; an unreadable rep range drops the arithmetic, never prints raw text", () => {
  assert.equal(sideCue({ unilateral: false, alternating: true }), "");
  assert.equal(sideCue(null), "");
  const odd = sideCue({ unilateral: true, alternating: true, movement_pattern: "lunge", rep_range: "AMRAP<script>" });
  assert.match(odd, /count each leg\./);
  assert.doesNotMatch(odd, /script|AMRAP/);
});

// --- iOS gesture invariants (owner report: "double-tapping + zooms the screen") ---
// Static source checks, because the zoom itself only reproduces on a real iPhone:
// what CAN be pinned here is the CSS that tells Safari not to treat two quick taps
// as a zoom gesture, and that no form control is small enough to focus-zoom.
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const appJs = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const cssRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sels: sel.split(",").map((s) => s.trim()), body }));

check("iOS: two quick taps never zoom — touch-action:manipulation on the page and every tappable control, pinch-zoom kept", () => {
  const opted = cssRules.filter((r) => /touch-action\s*:\s*manipulation/.test(r.body)).flatMap((r) => r.sels);
  for (const sel of ["html", "button", "a", "input", "select", "label"]) assert.ok(opted.includes(sel), `touch-action:manipulation missing on ${sel}`);
  // Disabling zoom outright would fix the gesture by breaking accessibility.
  assert.doesNotMatch(indexHtml, /user-scalable\s*=\s*no|maximum-scale/);
});

check("iOS: every form control renders at >= 16px (anything smaller zooms the page on focus)", () => {
  const base = cssRules.find((r) => r.sels.includes("input") && r.sels.includes("select") && r.sels.includes("textarea"));
  assert.ok(base && /font-size\s*:\s*16px/.test(base.body), "a base input/select/textarea rule must set font-size:16px");
  const small = [];
  for (const [tag] of appJs.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
    const fs = tag.match(/font-size\s*:\s*([\d.]+)(rem|em|px)/);
    if (!fs) continue;
    const px = fs[2] === "px" ? Number(fs[1]) : Number(fs[1]) * 16;
    if (px < 16) small.push(tag.match(/id="([^"]+)"/)?.[1] ?? tag.slice(0, 50));
  }
  assert.deepEqual(small, [], `form controls below 16px: ${small.join(", ")}`);
});

check("the hidden attribute always wins over a class's display (a hidden .btn must never show)", () => {
  // .btn{display:block} outranks the browser's own [hidden] rule, so verify.html's
  // hidden "Open the app" link showed on every screen — on the iPhone prompt it
  // would open Safari's copy, not the Home-Screen app the copy tells you to use.
  assert.ok(cssRules.some((r) => r.sels.includes("[hidden]") && /display\s*:\s*none\s*!important/.test(r.body)), "need [hidden]{display:none !important}");
});

// --- Offline shell invariant (lesson 7, enforced instead of remembered): every ESM
// module the app shell imports must be precached, or an offline open fails on a
// broken import. W270 added account-adopt.mjs — imported by app.js AND verify.html.
check("sw.js precaches every module app.js and verify.html import", () => {
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const verify = readFileSync(new URL("../public/verify.html", import.meta.url), "utf8");
  const shell = JSON.parse(sw.match(/const SHELL = (\[[^\]]*\]);/)[1]);
  const imported = [...`${appJs}\n${verify}`.matchAll(/^\s*import\s[^;]*?from\s+"(\/[^"]+\.mjs)"/gm)].map((m) => m[1]);
  assert.ok(imported.includes("/account-adopt.mjs"), "the scan must see the new module (else this check proves nothing)");
  const missing = [...new Set(imported)].filter((p) => !shell.includes(p));
  assert.deepEqual(missing, [], `imported but not precached: ${missing.join(", ")}`);
});

// (The /verify cache bypass is proven through the real fetch handler in test-sw.mjs.)

// --- Burst 1 review: the engine's reason for a weight, shown under it, in the LIFT's unit.
// Every figure the engine writes is the suggested weight, the last weight, or the step
// between them, so each converts to exactly what the screen shows.
const lbD = (kg) => Math.round((kg * 2.2046226) / 5) * 5;
check("#why-unit in kilograms the engine's reason is shown exactly as written", () => {
  const n = "Last time you hit the top of the range — add 2.5 kg.";
  assert.equal(noteInUnit(n, { suggested_kg: 102.5, last_kg: 100 }, "kg", (k) => k, 102.5), n);
});
check("#why-unit in pounds every figure is the lift's own: a weight as the stepper shows it, a step as the plates moved", () => {
  assert.equal(noteInUnit("Last time you hit the top of the range — add 1 kg.", { suggested_kg: 10.07, last_kg: 9.07 }, "lb", lbD, 25),
    "Last time you hit the top of the range — add 5 lb.");
  assert.equal(noteInUnit("Your first set at 9.07 kg came in at 5 — under the 8–12 range — so I've lightened this to 8 kg — your first set should land in the range.", { suggested_kg: 8, last_kg: 9.07 }, "lb", lbD, 15),
    "Your first set at 20 lb came in at 5 — under the 8–12 range — so I've lightened this to 15 lb — your first set should land in the range.");
  assert.equal(noteInUnit("It's been 14 days — I eased this to 88 kg so you ramp back in safely. Add load as it feels easy.", { suggested_kg: 88, last_kg: 100 }, "lb", lbD, 195),
    "It's been 14 days — I eased this to 195 lb so you ramp back in safely. Add load as it feels easy.");
  assert.equal(noteInUnit("Keep the weight and try to add a rep or two.", { suggested_kg: 60, last_kg: 60 }, "lb", lbD, 130), "Keep the weight and try to add a rep or two.");
});
check("#why-unit a reason that would contradict the screen is dropped, never shown ('add' while the stepper shows last time's weight)", () => {
  assert.equal(noteInUnit("Last time you hit the top of the range — add 1 kg.", { suggested_kg: 10.07, last_kg: 9.07 }, "lb", lbD, 20), null);
});
check("#why-unit property: every reason the REAL engine writes reaches a pounds user in pounds, never kg — and never dropped", () => {
  const at = (n) => new Date(Date.UTC(2026, 5, 20 - n, 18)).toISOString();
  const day = (id, n, sets) => ({ date: at(n), program_ref: "p", sets: sets.map(([kg, reps, rir]) => ({ exercise: id, set_type: "work", weight_kg: kg, reps, ...(rir != null ? { rir } : {}) })) });
  assert.match(suggestWeight([day("cable-lateral-raise", 1, [[9.07, 15]])], "cable-lateral-raise", "10-15", undefined, at(0), "1-3").note, /add 1 kg/, "precondition: a 1 kg-increment lift");
  let seen = 0;
  for (const id of ["cable-lateral-raise", "barbell-bench-press"]) for (const kg of [9.07, 20.41, 58.97, 99.79]) for (const [min, max] of [[6, 10], [8, 12], [10, 15]]) {
    const histories = [[[kg, max], [kg, max]], [[kg, min + 1, 5]], [[kg, min - 3]], [[kg, min - 1]], [[kg, min + 1]], [[kg, min + 1, 0]]];
    for (const [k, sets] of histories.entries()) for (const gap of [1, 20]) {
      const r = suggestWeight([day(id, gap, sets)], id, `${min}-${max}`, undefined, at(0), "1-3");
      if (r.suggested_kg == null) continue;
      const row = { suggested_kg: r.suggested_kg, last_kg: r.last_kg };
      const out = noteInUnit(r.note, row, "lb", lbD, prefillInUnit(row, lbD, 5));
      assert.ok(out != null && !/\bkg\b/.test(out), `${id} ${kg} kg ${min}-${max} #${k} gap ${gap}: ${r.note} → ${out}`);
      seen++;
    }
  }
  assert.ok(seen >= 250, `scenarios exercised: ${seen}`);
});
check("#why-unit (W290) the order note reaches a pounds user in pounds, never kg — and never dropped", () => {
  const prog = { sessions: [{ name: "A", exercises: [{ exercise: "incline-dumbbell-press", sets: 3, rep_range: "6-10", rir: "1-3" }] },
    { name: "B", exercises: [{ exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-3" }, { exercise: "incline-dumbbell-press", sets: 3, rep_range: "6-10", rir: "1-3" }] }] };
  let seen = 0;
  for (const kg of [9.07, 20.41, 30, 58.97]) {
    const hist = [{ date: "2026-06-01T18:00:00Z", session_name: "A", sets: [9, 9, 8].map((reps) => ({ exercise: "incline-dumbbell-press", set_type: "work", weight_kg: kg, reps })) }];
    const s = servedLift(prog.sessions[1].exercises[1], hist, {}, undefined, null, { program: prog, session: prog.sessions[1] });
    if (!/comes after/.test(s.suggestion_note ?? "")) continue;
    const row = { suggested_kg: s.suggested_kg, last_kg: s.sug.last_kg };
    const out = noteInUnit(s.suggestion_note, row, "lb", lbD, prefillInUnit(row, lbD, 5));
    assert.ok(out != null && !/\bkg\b/.test(out), `${kg}: ${s.suggestion_note} → ${out}`);
    seen++;
  }
  assert.ok(seen >= 2, `order notes exercised: ${seen}`);
});
// --- Burst 8 review #7/#25 (R6/R7): the held note's "or use X" and the 'Use X' button always agree — the note names
// exactly what the player offers (altOffer), in the lift's unit, or names nothing when nothing is offered.
check("#why-unit (Burst 8 review #7) the held note's alternative is the one offered — or none, in kg as in pounds", () => {
  const n = "Just under the range last time (7; it starts at 8) — keep the weight and aim for 8, or use 8 kg if it felt like too much. If it happens again, I'll lighten it.";
  const row = { suggested_kg: 9.07, last_kg: 9.07, alt_kg: 8 };
  assert.equal(noteInUnit(n, row, "lb", lbD, 20, null), "Just under the range last time (7; it starts at 8) — keep the weight and aim for 8. If it happens again, I'll lighten it.");
  assert.equal(noteInUnit(n, row, "lb", lbD, 20, 15), "Just under the range last time (7; it starts at 8) — keep the weight and aim for 8, or use 15 lb if it felt like too much. If it happens again, I'll lighten it.");
  assert.equal(noteInUnit(n, row, "kg", (k) => k, 9, null), "Just under the range last time (7; it starts at 8) — keep the weight and aim for 8. If it happens again, I'll lighten it.", "a tired row in kg: no alternative named");
  assert.equal(noteInUnit(n, row, "kg", (k) => k, 9, 8), n);
  assert.equal(noteInUnit(n, row, "lb", lbD, 20), "Just under the range last time (7; it starts at 8) — keep the weight and aim for 8, or use 20 lb if it felt like too much. If it happens again, I'll lighten it.", "no offer given (another caller): as before");
});
check("#why-unit (Burst 8 review #7) the real engine → the player: a pounds user at 20 lb gets no same-plate 'or use 20 lb' — and no button", () => {
  const sets = [7, 6, 6].map((reps) => ({ exercise: "dumbbell-lateral-raise", set_type: "work", weight_kg: 9.07, reps, rir: 0 }));
  const s = servedLift({ exercise: "dumbbell-lateral-raise", sets: 3, rep_range: "8-12", rir: "1-2" }, [{ date: "2026-06-01T18:00:00Z", sets, targets: [{ exercise: "dumbbell-lateral-raise", sets: 3, rep_range: "8-12", rir: "1-2" }] }], {}, undefined, null);
  assert.deepEqual([s.suggested_kg, s.alt_kg], [9.07, 8], "precondition: held at 9.07 kg with 8 kg beside it");
  const lbK = (v) => Math.round((v / 2.2046226) * 100) / 100;
  for (const [kg, unit, toDisp, step] of [[9.07, "lb", lbD, 5], [13.61, "lb", lbD, 5], [9.07, "kg", (k) => Math.round(k * 4) / 4, 2.5]]) {
    const hist = [{ date: "2026-06-01T18:00:00Z", sets: sets.map((x) => ({ ...x, weight_kg: kg })), targets: [{ exercise: "dumbbell-lateral-raise", sets: 3, rep_range: "8-12", rir: "1-2" }] }];
    const sv = servedLift({ exercise: "dumbbell-lateral-raise", sets: 3, rep_range: "8-12", rir: "1-2" }, hist, {}, undefined, null);
    const row = { equipment: "dumbbell", rep_range: "8-12", rir: "1-2", suggested_kg: sv.suggested_kg, last_kg: sv.sug.last_kg, alt_kg: sv.alt_kg, alt_reps: sv.alt_reps };
    const served = prefillInUnit(row, toDisp, step);
    const offer = sessionCore.altOffer(row, { toDisp, toKg: unit === "lb" ? lbK : (v) => v, step, served, unit });
    const note = noteInUnit(sv.suggestion_note, row, unit, toDisp, served, offer?.w ?? null);
    const named = /or use ([\d.]+) (?:lb|kg)/.exec(note)?.[1];
    assert.equal(named == null ? null : +named, offer?.w ?? null, `${kg} kg in ${unit}: the note names ${named}, the button ${offer?.w} — ${note}`);
    if (offer) assert.ok(offer.w < served, `a real step under the served ${served}: ${offer.w}`);
  }
});
// The next-set hint says what actually happened: reps under, reps over — or reps IN the range
// with far more left in the tank than planned (that hint fires on effort; "over the range"
// was a false statement there).
check("#hint-copy each kind of hint says what actually happened", () => {
  const j = (c) => `${c.lead} — ${c.why}. Try ${c.tryW} ${c.tail}`;
  assert.equal(j(hintCopy({ kind: "lighter", reps: 6, min: 8, max: 12, rir: null, band: "1-3" }, { setNo: 1, fromW: "60 kg", toW: "55 kg" })),
    "Set 1: 6 reps at 60 kg — under the 8–12 range. Try 55 kg for this one to land in it, allowing for the rep or so each hard set costs.");
  assert.equal(j(hintCopy({ kind: "heavier", reps: 15, min: 8, max: 12, rir: null, band: "1-3" }, { setNo: 2, fromW: "40 kg", toW: "42.5 kg" })),
    "Set 2: 15 reps at 40 kg — over the 8–12 range. Try 42.5 kg for this one to land in it.");
  // W305: the two new answers say what actually happened too.
  assert.equal(j(hintCopy({ kind: "same", reps: 7, min: 8, max: 12, rir: 3, band: "1-3", target_reps: 8 }, { setNo: 1, fromW: "100 kg", toW: "100 kg" })),
    "Set 1: 7 reps at 100 kg — under the 8–12 range, with about 3 left in the tank. Try 100 kg again and aim for 8 — you had the reps.");
  // (Burst 8 review #4/#28/#45, deliberate: W305's in-range "lighter" — and its "after a set that hard" copy — is gone.)
  assert.equal(j(hintCopy({ kind: "heavier", reps: 10, min: 8, max: 12, rir: 5, band: "1-3" }, { setNo: 1, fromW: "40 kg", toW: "45 kg" })),
    "Set 1: 10 reps at 40 kg — in the range, but with about 5 left in the tank (the plan says 1–3). Try 45 kg for this one.");
});
// Burst 8 review #28: a set OVER the range was called "in the range" and told to go lighter. Through the real hint and
// its copy: a 'lighter' only ever follows a set under the range, and says so.
check("#hint-copy (Burst 8 review #28) a 'lighter' hint only ever follows a set UNDER the range — and says so", () => {
  let seen = 0;
  for (const [rep_range, min, max] of [["6-10", 6, 10], ["8-12", 8, 12], ["10-15", 10, 15]]) for (const rir of ["0-1", "1-2", "2-3"]) for (let reps = 1; reps <= max + 1; reps++) for (const r of [null, 0, 1, 2, 3]) {
    for (const nextAim of [null, min - 1, min + 1, max]) {
      const h = sessionCore.nextSetHint({ exercise: "x", set_type: "work", weight_kg: 60, reps, ...(r != null ? { rir: r } : {}) }, { rep_range, rir, inc_kg: 2.5 }, { nextAim });
      if (h?.kind !== "lighter") continue;
      seen++;
      assert.ok(h.reps < min, `${reps} reps @${r} on ${rep_range} (${rir}), next aim ${nextAim}: lighter`);
      assert.match(hintCopy(h, { setNo: 1, fromW: "60 kg", toW: `${h.kg} kg` }).why, /^under the /);
    }
  }
  assert.ok(seen > 50, `lighter hints exercised: ${seen}`);
});

// One plain-English muscle vocabulary for every screen (W282): the server's read-out and
// new-block lines name muscles the way the Progress tab does ("back (lats)", never "Latissimus
// Dorsi"), from a copy of the client's map pinned equal here; and lists stay short.
check("muscle names: the server's copy of the plain-English map IS the client's (parity), and lists stay short", () => {
  assert.deepEqual(MUSCLE_PLAIN, MUSCLE_LABEL);
  assert.equal(friendlyMuscle("front-delts"), "front of shoulders");
  assert.equal(friendlyMuscle("some-new-muscle"), "some new muscle");
  assert.equal(friendlyList(["a"]), "a");
  assert.equal(friendlyList(["a", "b"]), "a and b");
  assert.equal(friendlyList(["a", "b", "c"]), "a, b and c");
  assert.equal(friendlyList(["a", "b", "c", "d", "e"]), "a, b, c and 2 more");
});
// --- W282: the read-out's words for WHAT HAPPENED — a headline that never shames (Goal 4), what
// went well, and what's worth a look. Beginners get the headline only (the weights for next
// time come from the server lines).
const L = (exercise, o) => ({ exercise, planned: 3, done: 3, min: 8, max: 12, reps: [], kg: [], top: false, graded_all: true, past_band: false, under: 0, easy: false, failure: false, easyDay: false, rir: null, rir_all: null, in_band: null, band: "1-3", ...o });
const nm = (id) => ({ a: "Bench Press", b: "Row", c: "Curl" })[id] ?? id;
// Burst 6 (owner: "the end of session recap is contradictory"): a top reached only past the band is worth a look, never
// "top of the range" or "time to go up" (the engine holds it); "Effort right" only when every rated lift averaged inside
// its band — beside the engine's "you left ~3 in reserve" or a below-band average it was false.
check("#readout-copy a top reached only past the band is worth a look — never 'top of the range', 'go up' or 'effort right'", () => {
  const r = readoutLists({ planned: 3, done: 3, lifts: [L("a", { past_band: true, band: "2-3", rir: 1, in_band: false })] }, { nameOf: nm });
  assert.equal(r.headline, "Every set done, every lift in its range — a session that moves you forward.");
  assert.deepEqual(r.went_well, []);
  assert.deepEqual(r.watch, ["Bench Press: top of the range, but closer to failure than the 2–3 in reserve the plan asked for."]);
  const f = readoutLists({ planned: 3, done: 3, lifts: [L("a", { past_band: true, failure: true, band: "1-2", rir: 0, in_band: false })] }, { nameOf: nm });
  assert.deepEqual(f.watch, ["Bench Press: taken to failure — the plan wanted 1–2 in reserve."], "the failure line says it; never both");
});
check("#readout-copy (round 4) a lift kept easy today is named, and 'every lift' claims only the others", () => {
  const easyLift = L("b", { easyDay: true, done: 2, planned: 2, reps: [8, 7] });
  assert.equal(readoutLists({ planned: 5, done: 5, lifts: [L("a", { top: true }), easyLift] }, { nameOf: nm }).headline,
    "Every set done — Row kept easy, and every other lift at the top of its range: time to go up.");
  assert.equal(readoutLists({ planned: 5, done: 5, lifts: [L("a"), easyLift] }, { nameOf: nm }).headline,
    "Every set done — Row kept easy, and every other lift in its range: a session that moves you forward.");
  assert.equal(readoutLists({ planned: 8, done: 8, lifts: [L("a", { top: true }), L("c"), easyLift] }, { nameOf: nm }).headline,
    "Every set done — Row kept easy, and every other lift in its range: 1 at the top, ready to go up.");
  assert.equal(readoutLists({ planned: 2, done: 2, lifts: [easyLift] }, { nameOf: nm }).headline, "Easy day done — recovery is part of the plan.", "all easy: unchanged");
  assert.equal(readoutLists({ planned: 8, done: 2, lifts: [easyLift, L("a", { planned: 3, done: 0 }), L("c", { planned: 3, done: 0 })] }, { nameOf: nm }).headline,
    "2 of 8 planned sets done — every one of them counts.", "round 5: a tired lift and the rest never started is a short day, not a planned easy one");
});
check("#readout-copy (round 3) one set is 'set', never '1 of 1 sets'", () => {
  const r = readoutLists({ planned: 1, done: 1, lifts: [L("a", { planned: 1, done: 1, under: 1, min: 10, max: 15 })] }, { nameOf: nm });
  assert.ok(r.watch.includes("Bench Press: 1 of 1 set under the 10–15 range."), JSON.stringify(r.watch));
  assert.ok(readoutLists({ planned: 2, done: 1, lifts: [L("a", { planned: 2, done: 1 })] }, { nameOf: nm }).watch.includes("Bench Press: 1 of 2 sets."));
});
check("#readout-copy (round 2) 'top of the range on every set' only when every set was graded; otherwise it names the working weight", () => {
  assert.deepEqual(readoutLists({ planned: 3, done: 3, lifts: [L("a", { top: true })] }, { nameOf: nm }).went_well, ["Bench Press: top of the range on every set."]);
  const ramp = readoutLists({ planned: 3, done: 3, lifts: [L("a", { top: true, graded_all: false, under: 1 })] }, { nameOf: nm });
  assert.deepEqual(ramp.went_well, ["Bench Press: top of the range at your working weight."], "never 'on every set' beside '1 of 3 sets under the range'");
});
check("#readout-copy 'Effort right where the plan wanted it' only when every rated lift averaged inside its band", () => {
  const eff = (lifts) => readoutLists({ planned: 6, done: 6, lifts }, { nameOf: nm }).went_well.includes("Effort right where the plan wanted it.");
  assert.equal(eff([L("a", { rir: 1.5, in_band: true }), L("b", { rir: 2, in_band: true })]), true);
  assert.equal(eff([L("a", { rir: 3, band: "1-2", in_band: false }), L("b", { rir: 2, in_band: true })]), false, "a full rep more than asked — the engine adds weight for it");
  assert.equal(eff([L("a", { rir: 0.7, band: "1-2", in_band: false }), L("b", { rir: 2, in_band: true })]), false, "closer to failure than asked, though not 'to failure'");
  assert.equal(eff([L("a", { rir: 1.5, in_band: true }), L("b", { past_band: true, in_band: null })]), false);
  assert.equal(eff([L("a", { rir: 5, in_band: null }), L("b", { rir: 2, in_band: true })]), false, "review K1: effort logged on too few sets to grade is never called 'right' (the engine still acts on it)");
});
check("#readout-copy every set done, every lift in range — and the ones at the top are named as wins", () => {
  const r = readoutLists({ planned: 9, done: 9, lifts: [L("a", { top: true }), L("b"), L("c")] }, { nameOf: nm });
  assert.equal(r.headline, "Every set done, every lift in its range — 1 at the top, ready to go up.");
  assert.deepEqual(r.went_well, ["Bench Press: top of the range on every set.", "All 9 planned sets done."]);
  assert.deepEqual(r.watch, []);
});
check("#readout-copy sets left undone: the headline counts what WAS done; the list names it neutrally", () => {
  const r = readoutLists({ planned: 9, done: 7, lifts: [L("a", { done: 1 }), L("b"), L("c", { done: 3 })] }, { nameOf: nm });
  assert.equal(r.headline, "7 of 9 planned sets done — every one of them counts.");
  assert.deepEqual(r.watch, ["Bench Press: 1 of 3 sets."]);
  assert.doesNotMatch(JSON.stringify(r), /fail|missed|only/i, "never framed as failure");
});
check("#readout-copy under the range, and effort off the band, are worth a look — said plainly, at most three", () => {
  const r = readoutLists({ planned: 9, done: 9, lifts: [L("a", { under: 2 }), L("b", { easy: true, rir: 5 }), L("c", { failure: true, rir: 0 }), L("d", { under: 1 })] }, { nameOf: nm });
  assert.equal(r.headline, "Every set done — 2 lifts came in under their range, and next time is set up for that.");
  assert.deepEqual(r.watch, ["Bench Press: 2 of 3 sets under the 8–12 range.", "Row: about 5 reps left in the tank — the plan asked for 1–3.", "Curl: taken to failure — the plan wanted 1–3 in reserve."]);
});
check("#readout-copy a workout with no saved plan claims nothing about a plan — no 'in its range', no 'planned sets'", () => {
  const noPlan = { planned: 4, done: 4, hasPlan: false, lifts: [L("a", { planned: null, min: null, max: null, done: 3 }), L("b", { planned: null, min: null, max: null, done: 1 })] };
  const r = readoutLists(noPlan, { nameOf: nm });
  assert.equal(r.headline, "4 sets logged — every one of them counts.");
  assert.deepEqual([r.went_well, r.watch], [[], []]);
  assert.doesNotMatch(JSON.stringify(r), /range|planned|plan wanted/);
});
check("#readout-copy an easy (deload) day is a win in itself; a beginner sees only the headline", () => {
  assert.equal(readoutLists({ planned: 4, done: 4, lifts: [L("a", { easyDay: true }), L("b", { easyDay: true })] }, { nameOf: nm }).headline, "Easy day done — recovery is part of the plan.");
  const b = readoutLists({ planned: 9, done: 9, lifts: [L("a", { under: 2 })] }, { nameOf: nm, beginner: true });
  assert.deepEqual([b.went_well, b.watch], [[], []]);
  assert.match(b.headline, /Every set done/);
});

// --- Burst 1 review: the player's wiring of the W280/W281 engine pieces. The pure pieces are
// proven in test-session and the server side through the route (#client-wiring); these pin the
// few lines in app.js that connect them, so a refactor can't drop one silently.
const fnBody = (src, head, len = 1500) => { const at = src.indexOf(head); assert.ok(at >= 0, `missing: ${head}`); return src.slice(at, at + len); };
check("player: a workout stamps each lift's PLANNED count at start, and finish sends the plan it ran (targets)", () => {
  assert.match(appJs, /orderSupersetAdjacent\(templateSession\.exercises\)\.map\(\(x\) => \(\{ \.\.\.x, planned_sets: x\.sets \}\)\)/);
  assert.match(appJs, /const payload = \{[^}]*\btargets: buildTargets\(sess\)/);
});
check("player: the reason for the pre-filled weight is on screen (single lift and superset station)", () => {
  assert.match(appJs, /\$\{sess\.set === 0 && !firstEver \? whyLine\(e\) : ""\}/);
  assert.match(appJs, /\$\{round === 0 \? whyLine\(m, idx\) : ""\}/, "(W305: the station passes its leg, for the held weight's alternative)");
});
check("player: every stepper starts on the plate-aware suggestion (single lift AND station), and the hint speaks through hintCopy", () => {
  assert.doesNotMatch(appJs, /sess\.weights\[[^\]]+\] = dispWeightFor\(startWeightDefault\(/, "a pre-fill site still rounds the raw suggestion");
  assert.equal((appJs.match(/= startWeightDisp\((e|m)\);/g) ?? []).length, 2);
  // W305: ONE hint computation (setHintFor) speaks for the set screen, the rest screen and each superset leg.
  assert.match(fnBody(appJs, "function setHintFor(e) {", 2500), /hintCopy\(hint, \{ setNo: done,/);
  assert.match(fnBody(appJs, "function renderPlayer() {", 9000), /const \{ hint, hintW, hc \} = setHintFor\(e\);/, "the set screen");
  assert.match(fnBody(appJs, "function renderPlayer() {", 9000), /const rh = rest\.kind === "set" \|\| rest\.kind === "remainder" \? setHintFor\(e\) : null;/, "the rest screen, where the plates get changed");
  assert.match(fnBody(appJs, "function renderSupersetStation(L, P) {", 6000), /const lh = setHintFor\(m\);/, "each superset leg");
});
check("player (Burst 8 review #8) a 'same' hint, and every hint's lead, name the weight BANKED at the precision typed", () => {
  const body = fnBody(appJs, "function setHintFor(e) {", 2500);
  assert.match(body, /hintInUnit\(rawHint, \(kg\) => dispWeightFor\(kg, e\.exercise\), wIncFor\(e\.exercise\), unitFor\(e\.exercise\)\)/, "the unit, so 'same' keeps 22.5 lb");
  assert.match(body, /fromW: `\$\{\+editDisplay\(hint\.from_kg, unitFor\(e\.exercise\)\)\} \$\{unitLabelFor\(e\.exercise\)\}`/, "'Set 1: 7 reps at 22.5 lb' — never the 25-lb plate");
});
check("read-out (Burst 8 review #7) the next-time line names the alternative the player OFFERS — the same altOffer, or none", () => {
  const ro = fnBody(appJs, "function readoutCardHtml(", 3000);
  assert.match(ro, /const alt = n\.alt_kg \? altOffer\(\{ \.\.\.n, suggested_kg: n\.kg \}, \{ toDisp, toKg: \(v\) => toKgFor\(v, n\.exercise\), step: wIncFor\(n\.exercise\), served: disp, unit: unitFor\(n\.exercise\) \}\) : undefined;/);
  assert.match(ro, /noteInUnit\(n\.note, row, unitFor\(n\.exercise\), toDisp, disp, alt === undefined \? undefined : alt\?\.w \?\? null\)/, "an alternative the player can't offer is dropped from the note");
});
check("player (Burst 8 review #7/#25/#34) the held weight's alternative: ONE offer (altOffer) for the note, the button and the tap", () => {
  assert.match(appJs, /const altFor = \(e\) => altOffer\(e, \{ toDisp: \(kg\) => dispWeightFor\(kg, e\.exercise\), toKg: \(v\) => toKgFor\(v, e\.exercise\), step: wIncFor\(e\.exercise\), served: startWeightDisp\(e\), unit: unitFor\(e\.exercise\) \}\);/);
  const why = fnBody(appJs, "const whyLine = (e, idx = sess?.i) => {", 900);
  assert.match(why, /const alt = altFor\(e\);/);
  assert.match(why, /noteInUnit\(e\.suggestion_note, e, unitFor\(e\.exercise\), \(kg\) => dispWeightFor\(kg, e\.exercise\), startWeightDisp\(e\), alt\?\.w \?\? null\)/, "#7: the note names what the button offers, or nothing");
  assert.match(why, /const altBtn = alt && Number\(sess\?\.weights\?\.\[idx\]\) === startWeightDisp\(e\)/);
  assert.match(why, /Use \$\{alt\.w\} \$\{unitLabelFor\(e\.exercise\)\}/);
  assert.doesNotMatch(why, /dispWeightFor\(e\.alt_kg/, "#7: never the plain plate-rounding (it collapses onto the served plate)");
  const wire = fnBody(appJs, "function wireAltWeight(rerender) {", 600);
  assert.match(wire, /const idx = \+b\.dataset\.altWeight, e = sess\.ex\[idx\], a = altFor\(e\);/);
  assert.match(wire, /sess\.weights\[idx\] = a\.w;/);
  assert.match(wire, /sess\.reps\[idx\] = a\.reps;/, "#34: the reps the model predicts there");
  assert.doesNotMatch(wire, /rep_range/, "#34: never the range's bottom");
});

// --- Burst 8 review (W305f): the rest screen's hint and the station's leg hints. app.js can't run under Node, so these
// pin the wiring by its exact text (the rest of this file's convention); a real-browser walkthrough backs them.
const between = (src, head, end) => { const a = src.indexOf(head); assert.ok(a >= 0, `missing: ${head}`); const b = src.indexOf(end, a + head.length); assert.ok(b > a, `missing after ${head}: ${end}`); return src.slice(a, b); };
const stationRest = () => between(appJs, "function renderSupersetStation(L, P) {", "const memberBlock = (idx) => {");
const playerRest = () => between(appJs, "const rest = activeRest(sess, Date.now());\n  if (rest) {\n    quitPending = false;\n    // The next set's hint", "const firstEver =");
const restHintWire = () => between(appJs, "function wireRestHint(idx, shown, named) {", "\n}\n");
check("#10 station: a leg hint's or the alt weight's tap disarms 'End workout early' and judges the typo guard afresh, like the straight player", () => {
  const st = fnBody(appJs, "function renderSupersetStation(L, P) {", 12000);
  assert.match(st, /wireAltWeight\(\(\) => \{ clearSetConfirm\(\); quitPending = false; renderSupersetStation\(L, P\); \}\);/, "the station's alt weight");
  assert.match(between(st, "const b = $(`#leg-hint-${idx}`);", "$(\"#doner\").onclick"), /if \(b\) b\.onclick = \(\) => \{\s*clearSetConfirm\(\); quitPending = false;/, "each leg's hint button");
});
check("#11 rest hint: a superset's remainder rest and every round rest carry the hint (per leg, with its own button)", () => {
  assert.match(playerRest(), /rest\.kind === "remainder"/, "the remainder rest is between sets of the same lift");
  const sr = stationRest();
  assert.match(sr, /const legs = \[L, P\]\.map\(\(idx\) => \[idx, setHintFor\(sess\.ex\[idx\]\)\]\);/, "each leg's hint on the round rest");
  assert.match(sr, /legs\.map\(\(\[idx, rh\]\) => restHintHtml\(idx, sess\.ex\[idx\], rh, true\)\)\.join\(""\)/);
  assert.match(sr, /for \(const \[idx, rh\] of legs\) if \(rh\.hc\) wireRestHint\(idx, rh, true\);/);
  assert.match(playerRest(), /restHintHtml\(sess\.i, e, rh, false\)/);
  assert.match(playerRest(), /if \(rh\?\.hc\) wireRestHint\(sess\.i, rh, false\);/);
});
check("#12 rest hint: 'Use X' re-judges the advice at the tap — a set fixed during the rest never pushes the stale weight", () => {
  const w = restHintWire();
  assert.match(w, /const m = sess\.ex\[idx\], rh = setHintFor\(m\), line = \$\(`#rest-hint-\$\{idx\}`\);/, "recomputed at click time");
  assert.match(w, /rh\.hint && rh\.hint\.kind === shown\.hint\.kind && rh\.hintW === shown\.hintW && rh\.hint\.target_reps === shown\.hint\.target_reps/, "applied only when it is still what the button said");
  assert.ok(w.indexOf("applyHint(") > w.indexOf("const still ="), "applyHint is gated on the fresh judgement");
  assert.match(w, /else if \(rh\.hc\) \{ line\.innerHTML = restHintBody\(idx, m, rh, named\); wireRestHint\(idx, rh, named\); \}\s*else line\.remove\(\);/, "otherwise only the line is repainted");
  assert.doesNotMatch(playerRest(), /applyHint\(/, "no render-time closure applies a hint any more");
});
check("#35 rest hint: the tap repaints ONLY its line — no redraw to wipe the readiness ticks, an open fix or re-announce the rest", () => {
  const w = restHintWire();
  assert.doesNotMatch(w, /renderPlayer|renderSupersetStation|showRest|innerHTML = `<div|app\.innerHTML|say\(/);
  assert.match(w, /applyHint\(idx, m, rh\.hint, rh\.hintW\); saveSess\(\);\s*line\.innerHTML = `✓ /, "a short confirmation in place");
  // (fix C9 then sends it on to the next leg's waiting hint before "I'm ready")
  assert.match(w, /if \(had\) \(\$\(`#rest-use-hint-\$\{idx\}`\) \?\? app\.querySelector\('\[id\^="rest-use-hint-"\]'\) \?\? \$\("#skip"\)\)\?\.focus\(\);/, "focus never drops to the page when the tapped button goes");
});
check("#36 rest hint: the rest's one announcement carries each hint (focus lands on 'I'm ready', after it)", () => {
  assert.match(playerRest(), /, \$\{e\.name\}\.\$\{restHintSay\(e, rh, false\)\}`/);
  assert.match(stationRest(), /with \$\{B\.name\}\.\$\{legs\.map\(\(\[idx, rh\]\) => restHintSay\(sess\.ex\[idx\], rh, true\)\)\.join\(""\)\}`/);
  assert.match(fnBody(appJs, "function showRest(", 2000), /say\(announce\);\n\s*\$\("#skip"\)\.focus\(\);/, "said once, at render");
});
check("#47 typing after a typo prompt removes ONLY the confirm cue — the set hint and each leg's hint (and their buttons) stay", () => {
  const dismiss = fnBody(appJs, "function dismissConfirmCueInPlace() {", 400);
  assert.match(dismiss, /app\.querySelectorAll\("\[data-confirm-cue\]"\)\.forEach\(\(el\) => el\.remove\(\)\);/);
  assert.doesNotMatch(dismiss, /role="status"/);
  assert.equal((appJs.match(/<div class="cue" role="status" data-confirm-cue>\$\{setConfirmCue\((sess\.i|idx)\)\}<\/div>/g) ?? []).length, 2, "both confirm cues carry the marker");
  assert.equal((appJs.match(/setConfirmCue\(/g) ?? []).length, 2, "…and there is no third, unmarked one");
  // The hints the dismissal must spare, as rendered: none carries the marker.
  const setHint = between(appJs, 'const hintHtml = hc ? `<div class="cue" id="set-hint"', "</div>`");
  const legHint = between(appJs, "const lh = setHintFor(m); return lh.hc ?", "</div>`");
  for (const h of [setHint, legHint, restHintWire(), between(appJs, "const restHintHtml =", ";\n")]) assert.doesNotMatch(h, /data-confirm-cue/);
});
check("time-fit card (Burst 8 review #9 #16 #18 #46 #48 #51): keep names its question; the extra-day picker asks for EVERY day the plan needs — in a labelled, spoken group with a confirm — and a failed days save is said", () => {
  const tf = between(appJs, "  if (tfit) {", "  if ($(\"#fit-keep\"))");
  assert.match(tf, /JSON\.stringify\(\{ user_id: uid, choice: "keep", key: tfit\.key \}\)/, "#16 the keep names the question it answers");
  assert.match(tf, /if \(r\?\.stale\) \{ refreshToday\(\); return; \}/, "#16 a stale card shows the question asked now");
  assert.match(tf, /need = o\.days - usual\.length;/, "#18 every day the new plan needs, not one");
  assert.match(tf, /<div role="group" aria-labelledby="tfit-q"><p class="muted" id="tfit-q"/, "#48 a labelled group");
  assert.match(tf, /say\(q\);/, "#48 its question is spoken");
  assert.match(tf, /aria-pressed="false" aria-label="\$\{DAY_LONG\[d\]\}"/, "#51 full day names, toggled");
  assert.match(tf, /<button class="btn secondary" id="tfit-go" disabled/, "#51 a confirm — one stray tap never rebuilds");
  assert.match(tf, /\$\("#tfit-go"\)\.disabled = picked\(\)\.length !== need;/);
  // W305i (H6, deliberate): the requests and notices moved into timeFitApply (behaviour-tested in #fit-apply) — days
  // first, then the rebuild; the card hands it the usual days and this week's, and says whatever it returns.
  assert.match(tf, /const res = await timeFitApply\(\{ o, days, cleared, usual, thisWeek: adh\.commitment\?\.days \?\? \[\], blocks: dy\.plan_time_fit\?\.blocks !== false, uid,/, "#46 the new day joins the usual ones");
  assert.match(tf, /if \(!res\.refresh\) \{ lockFit\(false\); if \(!stale\(\)\) alertBar\(res\.notice\); return; \}/, "#9 a failure is said, never swallowed");
  assert.doesNotMatch(tf, /catch \{\}/, "#9 no silent catch");
});
check("time-fit card (fix verification C7 C8 C9 C14 #9): the usual days in a cleared week, the confirm guarded after a failure, focus to the next hint, one card at a time, a failed save said after the refresh", () => {
  const tf = between(appJs, "  if (tfit) {", "  if ($(\"#fit-keep\"))");
  assert.match(tf, /const cleared = \(adh\.commitment_resume_days\?\.length \?\? 0\) > 0;/, "C7: a clear in force — one-off days or not");
  assert.match(tf, /const usual = cleared \? adh\.commitment_resume_days : \(adh\.commitment\?\.days \?\? \[\]\);/, "C7: the usual days, never this week's one-off");
  assert.match(tf, /timeFitApply\(\{ o, days, cleared, usual, thisWeek: adh\.commitment\?\.days \?\? \[\]/, "C7: this week stays as it is (the cleared form: #fit-apply, W305i)");
  assert.match(tf, /const lockFit = \(on\) => \{[^}]*\$\("#tfit-go"\)[^}]*picked/, "C8: the confirm comes back only with the days picked");
  assert.match(tf, /pendingNotice = res\.notice;/, "#9: the notice rides the refresh, never wiped by it (W305i)");
  assert.doesNotMatch(tf, /alertBar\("📴 Your plan was rebuilt/, "#9: no alert the refresh erases");
  const rest = fnBody(appJs, "function wireRestHint(idx, shown, named) {", 2000);
  assert.match(rest, /\[id\^="rest-use-hint-"\]/, "C9: focus moves on to the next leg's hint, not past it");
  assert.match(appJs, /const tfit = planFitVisible\(fit, fitKey\) \? null : timeFitCopy\(dy\.plan_time_fit\);/, "C14: one schedule question at a time, the device's own keep respected");
});
// W306 (Burst 9 — owner note 2): the workout list. Opened from the header on the set screen AND the station (the top of
// the screen — never below the fold); each later lift can be done next; "Do this later" is the same pure permutation;
// after a defer or a lift-ending skip the player offers "Pick a different one"; a moved lift says its weight was
// planned for its usual place (no direction claimed — lesson 60).
check("player (W306) the workout list: a header button on both screens, the list from workoutList, Do this next through moveToCurrent", () => {
  const set = fnBody(appJs, "function renderPlayer() {", 9000), st = fnBody(appJs, "function renderSupersetStation(L, P) {", 9000);
  for (const [name, body] of [["set screen", set], ["station", st]]) assert.match(body, /\$\{exListBtn\(\)\}/, `${name}: the list button sits in the header`);
  assert.doesNotMatch(set, /<span class="num">\$\{sess\.i \+ 1\}\/\$\{total\}<\/span>/, "the position counter (wrong after a move) is gone");
  assert.match(st, /<h1 tabindex="-1" id="ex-head">🔗 Superset<\/h1>/, "the station gets a focus target");
  assert.match(st, /wireListDoors\(\);\s*\$\("#ex-head"\)\?\.focus\(\);/, "…and focus lands on it, as on the set screen");
  const list = fnBody(appJs, "function renderWorkoutList() {", 4000);
  assert.match(list, /const rows = workoutList\(sess\)/);
  assert.match(list, /data-move="\$\{r\.idx\}"/);
  assert.match(list, /const r = moveToCurrent\(sess, \+b\.dataset\.move\);/);
  assert.match(list, /confirmSet\.clear\(\); skipPending = false; quitPending = false;/, "a move judges the next set afresh, like a skip");
  assert.match(list, /if \(had\) syncRestAlert\(\);/, "a dropped rest disarms its alarm (lesson 91)");
  assert.match(list, /\$\("#list-head"\)\?\.focus\(\);/);
});
check("player (W306) 'Do this later' is the pure deferToEnd; after it or a lift-ending skip, 'Pick a different one'; a moved lift says so", () => {
  const later = fnBody(appJs, "function deferCurrentExercise() {", 1200);
  assert.match(later, /const r = deferToEnd\(sess\);/);
  assert.doesNotMatch(later, /const remap = /, "one permutation, in session-core");
  assert.match(later, /offerPick: \{ kind: "later", name: moved\.name \}/);
  // (W307: the window widened deliberately — applySkip now first drops a skipped lift's pending estimate.)
  assert.match(fnBody(appJs, "function applySkip(r, redraw) {", 1600), /offerPick: \{ kind: "skip", name: prev\.name \}/, "a skip that ends a lift offers the pick too");
  const set = fnBody(appJs, "function renderPlayer() {", 9000);
  assert.match(set, /\$\{pickCue\(\)\}/);
  assert.match(set, /sess\.set === 0 && e\.moved \? `<div class="cue" id="moved-cue">\$\{movedCue\(e, \{ deload: sess\.deload \}\)\}<\/div>` : ""/, "the cue's words: movedCue (Burst 9 review copy#3)");
  for (const h of ["$(\"#done\").onclick = () => {", "$(\"#doner\").onclick = () => {"]) assert.match(fnBody(appJs, h, 2500), /delete sess\.offerPick;/, `${h}: a banked set answers the offer`);
});
check("player (W289): both reps steppers start on the per-set aim (repSeed, from the BANKED count), both bank handlers drop the stale value, the hint fills its reps", () => {
  assert.doesNotMatch(appJs, /topReps\((e|m)\.rep_range\)/, "a seed site still starts on the range's top");
  assert.equal((appJs.match(/= repSeed\((e|m), loggedSetCount\((e|m)\.exercise\), \{ lastReps: lastWorkReps\(sess\.logged, (e|m)\.exercise\), atServed: sameLoad\(sess\.weights\[(sess\.i|idx)\], startWeightDisp\((e|m)\), stepFor\((e|m)\)\) \}\);/g) ?? []).length, 2,
    "single lift AND station seed through repSeed, 'at the served weight' within half a display step (Burst 5 review C2/C18)");
  // Burst 8 review #23: today's aims belong to the SERVED load — the set's own aim AND the next set's apply only while the
  // judged set was banked at it (as repSeed's atServed), never to a weight the lifter moved to.
  assert.match(appJs, /const rawHint = nextSetHint\(prevWork, e, \{ aim: prevAim, nextAim: atServed \? aims\[done\] \?\? null : null \}\);/, "the hint judges the banked set against ITS aim (Burst 5 review C1), and the next set against ITS aim (W305) — both only at the served load (Burst 8 review #23)");
  assert.match(appJs, /const atServed = !!prevWork && !!aims && sameLoad\(dispWeightFor\(prevWork\.weight_kg, e\.exercise\), startWeightDisp\(e\), stepFor\(e\)\);\n\s*const prevAim = atServed \? aims\[Math\.min\(done - 1, aims\.length - 1\)\] \?\? null : null;/,
    "the aim applies by the weight the judged set was BANKED at, not what the stepper holds now (fix verification R1)");
  assert.match(appJs, /const stepFor = \(e\) => servedStep\(unitFor\(e\.exercise\), e\.inc_kg\);/, "the lift's own step (fix verification R4)");
  assert.doesNotMatch(appJs, /phone locked|phone is locked|iPhone's Settings/, "device-neutral notification copy (fix verification R6/R7)");
  assert.match(appJs, /const hint = rawHint && rawW != null \? finalizeHint\(rawHint, prevWork, e, toKgFor\(rawW, e\.exercise\)\) : null;/, "the hint is judged at the weight actually offered (round 2 N9)");
  assert.match(fnBody(appJs, "function normalizeSessUnits() {", 1200), /servedIn: \(k, u\) => \{ const x = sess\.ex\[k\]; return x\?\.suggested_kg != null \? prefillInUnit\(x, \(kg\) => dispW\(kg, u\), wIncIn\(u\)\) : null; \},/, "a unit toggle re-stamps the served pre-fill (round 2 N10)");
  assert.match(fnBody(appJs, '$("#done").onclick = () => {', 3000), /delete sess\.eff\[sess\.i\]; \/\/ each set is its own call[^\n]*\n\s*delete sess\.reps\[sess\.i\];/, "the single lift's bank re-derives the next set's aim");
  assert.match(fnBody(appJs, '$("#doner").onclick = () => {', 3000), /delete sess\.eff\[idx\]; \/\/ each set is its own call[^\n]*\n\s*delete sess\.reps\[idx\];/, "the station's bank too");
  assert.match(fnBody(appJs, "function applyHint(idx, e, hint, hintW) {", 600), /sess\.reps\[idx\] = hint\.target_reps/, "Use X kg also sets the reps it aims at (W305: one applyHint for every screen)");
  // Burst 6: every typo-guard door reads today's banked sets through ONE binder; the cue names what the guard
  // judged against; the editor leaves out the entry being edited; one rep ceiling.
  assert.match(appJs, /const setLooksLikeTypo = \(idx\) => isImplausibleSet\(bankKg\(idx\), sess\.reps\[idx\], typoOpts\(idx\)\);/);
  assert.match(fnBody(appJs, "const setConfirmCue = (idx) => {", 1500), /typoReference\(typoOpts\(idx\)\)/);
  assert.match(fnBody(appJs, "const apply = () => {", 1500), /typoOpts\(sess\.ex\.findIndex\(\(x\) => x\.exercise === ed\.exercise\), ed\.idx\)/);
  assert.doesNotMatch(appJs, /reps > 50/, "the cue's rep ceiling is IMPLAUSIBLE_REPS");
  // Burst 6 — "Too tired for this one?": the first-screen line only through the pure offer; both doors (the line and the
  // sheet's first reason) one handler; a swap's trimmed dose and its Undo; the ease on the lift's KG step; nothing that
  // promises effort the slot's band doesn't ask for.
  assert.match(appJs, /\$\{tiredOffer\(sess\) \? `<button class="btn ghost inline" id="tired"/);
  assert.match(appJs, /if \(\$\("#tired"\)\) \$\("#tired"\)\.onclick = \(\) => tiredSwap\(\);/);
  assert.match(fnBody(appJs, "async function renderCantDo() {", 9000), /\$\("#cd-tired"\)\.onclick = \(\) => tiredSwap\(\);/);
  assert.match(fnBody(appJs, "async function tiredSwap() {", 2500), /reason: "tired"/);
  assert.match(fnBody(appJs, "async function tiredSwap() {", 2500), /slot_of: cur\.slot_of \?\? null/);
  assert.match(fnBody(appJs, "function easeInPlace(", 2500), /easeSlot\(sess, sess\.i, \{ expect: cur\.exercise, stepKg: cur\.inc_kg > 0 \? cur\.inc_kg : 2\.5,/);

  assert.doesNotMatch(appJs, /push it close/);
  assert.doesNotMatch(appJs, /your sets and reps stay the same/, "a tired swap changes the sets");
  // Review round 1: a slot already made easier never offers it again (K5); the card names the PLAN's lift (K13); the sheet
  // promises fewer sets only when it cuts them (K12); the ease is judged on what the stepper shows, never under the bar (K4, K7).
  assert.match(fnBody(appJs, "async function renderCantDo() {", 9000), /\$\{cur\.tired \? "" : `<button class="choice reason" id="cd-tired">/);
  assert.match(fnBody(appJs, "async function tiredSwap() {", 3000), /if \(!cur \|\| sess\.set !== 0 \|\| cur\.tired\) return;/);

  assert.match(fnBody(appJs, "async function renderCantDo() {", 9000), /Something easier, just for today\$\{tiredDose\(cur\) < cur\.sets \? " — fewer sets" : ""\}/);
  assert.match(fnBody(appJs, "function easeInPlace(", 2500), /floorKg: cur\.equipment === "barbell" \? \(unitFor\(cur\.exercise\) === "lb" \? toKgIn\(EMPTY_BAR_LB, "lb"\) : EMPTY_BAR_KG\) : 0, shown: startWeightDisp \}\)/);
  // Round 2: Undo restores the saved count AND its plan (a skip stays taken); "1 set", never "1 sets"; the card says what's
  // back next time only when the server could name it; Nerd Mode's average covers the sets it prints.
  assert.match(fnBody(appJs, "async function undoSwap() {", 1600), /u\.saved, \{ expect: u\.to, sets: u\.saved\.sets, plannedSets: u\.saved\.planned_sets \}\)/);
  assert.doesNotMatch(fnBody(appJs, "async function tiredSwap() {", 3000) + fnBody(appJs, "function easeInPlace(", 2500), /\$\{n\} sets/);
  assert.match(fnBody(appJs, "async function tiredSwap() {", 3000), /\$\{r\.planned_name \? ` \$\{r\.planned_name\} is back next time\.` : ""\}/);
  // Round 3: Nerd Mode compares the GRADED average with the band, saying which weight it's for when back-offs weren't graded;
  // "Target: 1 set"; a tired first-time lift isn't told it's finding its weight; after an easier day "last time" is named for
  // what it is; the bodyweight ease says "bodyweight"; the tired Undo brings a skip's own Undo back.
  assert.match(appJs, /const avg = l\.easyDay \? \(l\.rir_all \?\? l\.rir\) : l\.rir;/);
  assert.match(appJs, /Target: \$\{setsN\(e\.sets\)\}/);
  assert.match(appJs, /\$\{firstEver \? \(e\.tired \? \(e\.tried_easy \? `<div class="card info"><b>Still finding your weight, on a tired day 🎯<\/b>/);
  assert.match(appJs, /<b>New lift, on a tired day 🎯<\/b>/);
  assert.match(appJs, /\$\{e\.last_easy \? "Last regular session" : "Last time"\}:/);
  // Round 4: a tired SWAP's substitute is planned-easy too (its first exposure, tired, never sets its starting weight).
  assert.match(fnBody(appJs, "async function tiredSwap() {", 3000), /applyReplacement\(cur\.exercise, tiredSwapRow\(r\.row\),/);
  // Round 5: a lift tried only on an easier day isn't "New lift"; the typo cue names the last REGULAR session after one.
  assert.match(appJs, /e\.tried_easy \? `<div class="card info"><b>Finding your weight 🎯<\/b>/);
  // Round 6: tired AND tried-easy is never "New lift"; on a planned-easy session (a comeback, a deload week) no card promises
  // that today's sets set the starting weight — they bank planned-easy.
  assert.match(appJs, /e\.tried_easy \? `<div class="card info"><b>Still finding your weight, on a tired day 🎯<\/b>/);
  assert.match(appJs, /const easyToday = !!sess\.deload;/);
  // Round 8: every door that replaces a slot from the Can't-do sheet (busy, pick, no machine — and the tired swap) goes
  // through applyReplacement, which keeps a tired slot's substitute the tired day (session-core swapInRow); only Undo
  // restores a saved row as it was.
  assert.match(appJs, /const r = replaceSlot\(sess, i, swapInRow\(sess\.ex\[i\], row\), \{ expect, \.\.\.\(sets \? \{ sets \} : \{\}\) \}\);/);
  assert.equal((appJs.match(/replaceSlot\(/g) ?? []).length, 2, "applyReplacement and undoSwap are the only slot writers in the player");
  assert.match(appJs, /\$\{easyToday \? "today's an easier day too, so your next regular session will\." : "today's sets will\."\}/);
  assert.match(appJs, /easyToday \? `<div class="card info"><b>New lift — keep it light today 🎯<\/b>/);
  assert.match(fnBody(appJs, "const setConfirmCue = (idx) => {", 1500), /ex\?\.last_easy \? ` from the \$\{refW\} in your last regular session`/);
  assert.match(fnBody(appJs, "function easeInPlace(", 2500), /"bodyweight"/);
  assert.match(fnBody(appJs, "async function undoSwap() {", 1600), /\.\.\.\(back\.ok && u\.lastSkip \? \{ lastSkip: u\.lastSkip \} : \{\}\)/);
  assert.match(fnBody(appJs, "function easeInPlace(", 2500), /lastSkip: skip/);
  assert.match(fnBody(appJs, "async function tiredSwap() {", 3000), /lastSkip: sess\.lastSkip \?\? null/);
  assert.match(appJs, /Today's aim: \$\{aim\.slice\(0, e\.sets\)\.join\(" · "\)\} reps/);
});
check("read-out wiring (W282): finish reads what happened BEFORE dropping the session, the recap shows it, and a queued workout's read-out reaches Today once it syncs", () => {
  const fin = fnBody(appJs, "async function finish() {", 5000);
  const drop = fin.indexOf("// Accepted or safely queued — now it's safe to drop the in-progress copy.\n  clearSess();");
  assert.ok(drop > 0 && fin.indexOf("localReadout(payload.targets, payload.sets)") > 0 && fin.indexOf("localReadout(payload.targets, payload.sets)") < drop, "captured before the session is dropped (the names live only on it)");
  assert.match(fin, /if \(res\.queued\) \{ try \{ localStorage\.setItem\(RKEY/);
  assert.match(fnBody(appJs, "function renderRecap(recap) {", 5000), /readoutCardHtml\(\{ local: recap\.local, ro: recap\.readout/);
  assert.match(fnBody(appJs, "async function flushQueueOnce() {", 5000), /if \(item\.path === "\/api\/session"\) markReadoutReady\(parsed\.session_id\)/);
  assert.match(appJs, /\$\{dailyHub\}\$\{readoutReadyCard\}/);
  assert.match(appJs, /id="hd-readout"/);
});
check("read-out wiring (W282 review): the save stays lean — the recap shows at once and fills in the read-out from its door", () => {
  const fin = fnBody(appJs, "async function finish() {", 6000);
  assert.match(fin, /if \(res\.ok\) \{[^}]*clearPendingReadout\(\)/, "an online save retires an older pending read-out");
  assert.match(fin, /fillReadout\(session_id/, "the read-out is fetched after the save, not computed in it");
  assert.match(fnBody(appJs, "async function fillReadout(", 2000), /fetchReadout\(sessionId\)/);
});
check("read-out wiring (W282 review): a door that says 'past' or errors is explained, and a workout whose date needs fixing has no Read-out", () => {
  assert.match(fnBody(appJs, "async function fetchReadout(", 600), /r\?\.error/);
  assert.match(fnBody(appJs, 'if ($("#ro-open")) $("#ro-open").onclick', 1500), /r\.past/);
  assert.match(appJs, /voided \|\| sess\.time_quarantine\s*\?/);
});
check("W283 wiring: an offline Exercise library in Learn (its sheets come back to it), every demo told which lift it shows, and a fair warning before a plan becomes hand-built", () => {
  assert.match(fnBody(appJs, "async function renderLearn() {", 4000), /id="learn-library"/);
  const lib = fnBody(appJs, "async function renderExerciseLibrary() {", 3000);
  assert.match(lib, /filterExercises\(/);
  assert.match(lib, /from: "library"/);
  assert.match(fnBody(appJs, "async function renderLearnData(", 2500), /from === "library"/);
  assert.match(appJs, /const resetLearnNav = \(\) => \{[^}]*learnLibrary = false/);
  // the three call sites, pinned exactly (W283 review: a comma-only check let `null` through)
  assert.deepEqual((appJs.match(/renderMovementDemo\([^)]*\)/g) ?? []).sort(), [
    "renderMovementDemo(d?.movement_pattern ?? ex.movement_pattern, ex.exercise ?? d?.id)",
    "renderMovementDemo(e.movement_pattern, e.exercise)",
    "renderMovementDemo(m.movement_pattern, m.exercise)",
  ]);
  assert.match(fnBody(appJs, "function renderAddExercise(si) {", 2500), /!editState\.custom \?/);
  // W283 review: back from a sheet restores the reader's place and focus
  assert.match(lib, /learnLibraryReturn = \{ id: b\.dataset\.lib, y: window\.scrollY \}/);
  assert.match(fnBody(appJs, "async function renderExerciseLibrary() {", 4000), /window\.scrollTo\(0, back\.y\)/);
});
check("W284 wiring: Nerd Mode is a remembered Progress toggle that asks for the numbers only when on, and survives an account switch like the RIR chips", () => {
  const prog = fnBody(appJs, "async function renderProgress() {", 1200);
  assert.match(prog, /nerdOn\(\) \? "\?nerd=1" : ""/);
  assert.match(appJs, /id="nerd-toggle"[^>]*aria-pressed=/);
  // W283 review: a fixed name (the state lives in aria-pressed), and focus comes back after the redraw
  assert.match(appJs, /aria-pressed="\$\{nerdOn\(\)\}"[^>]*>🤓 Nerd mode<\/button>/);
  assert.match(appJs, /renderProgress\(\)\.then\(\(\) => \$\("#nerd-toggle"\)\?\.focus\(\)\)/);
  assert.match(appJs, /s\.basis === "load" \? "top load" : "est\. 1RM"/, "load-tracked lifts aren't called 1RMs");
  assert.ok(DEVICE_PREFS.has("hb_nerd") && DEVICE_PREFS.has("hb_rir") && DEVICE_PREFS.has("hb_rest"));
  assert.match(appJs, /key\?\.startsWith\("hb_"\) && !DEVICE_PREFS\.has\(key\)/, "the account switch clears by that one set");
});
check("player: 'Use it' re-arms the typo guard (a new weight is judged afresh), and Unlink retires a round skip's undo", () => {
  assert.match(fnBody(appJs, '$("#use-hint").onclick = () => {').split("\n").slice(0, 3).join("\n"), /clearSetConfirm\(\)/);
  assert.match(fnBody(appJs, '$("#unlink").onclick = () => {'), /delete sess\.lastSkip/);
});

check("DEVICE_PREFS (W286/W287): the rest alert switch and the one-time invite stay with the DEVICE across an account switch; the account's own state goes", () => {
  assert.deepEqual([...DEVICE_PREFS].sort(), ["hb_nerd", "hb_notify_invite", "hb_rest", "hb_rest_alert", "hb_rir"]);
  for (const accountKey of ["hb_user", "hb_push", "hb_email", "hb_program", "hb_units", "hb_session"]) assert.ok(!DEVICE_PREFS.has(accountKey), `${accountKey} belongs to the account`);
});
check("notifyOffer (W285): the turn-on door each device can actually use", () => {
  assert.equal(notifyOffer({ supported: true, permission: "default", on: false }), "enable");
  assert.equal(notifyOffer({ supported: true, permission: "denied", on: false }), "blocked", "said no in the browser: say where to undo it, don't re-ask");
  assert.equal(notifyOffer({ supported: true, permission: "granted", on: true }), null, "already on");
  assert.equal(notifyOffer({ supported: false, ios: true, standalone: false, on: false }), "home-screen", "an iPhone in Safari: Web Push lives in the Home-Screen app");
  assert.equal(notifyOffer({ supported: false, ios: false, standalone: false, on: false }), null, "a browser without Web Push");
  assert.equal(notifyOffer({ supported: false, ios: true, standalone: true, on: false }), null, "a Home-Screen app on an iOS too old for Web Push");
});
// --- W291 (Burst 5 — owner, on an iPhone: "I clicked the 'Enable notifications' button, and it just told me to
// turn it on in my settings"). No prompt appeared and the app wasn't listed in iPhone Settings → Notifications:
// iOS never received a request. Push only works from the Home-Screen app, so an iPhone outside it is sent
// there even when Safari exposes PushManager; and a refusal says what actually happened.
check("notifyOffer (W291): an iPhone outside the Home-Screen app is sent there — even when Safari exposes PushManager", () => {
  assert.equal(notifyOffer({ supported: true, ios: true, standalone: false, permission: "default", on: false }), "home-screen", "a Safari tab never shows the prompt");
  assert.equal(notifyOffer({ supported: true, ios: true, standalone: false, permission: "denied", on: false }), "home-screen");
  assert.equal(notifyOffer({ supported: true, ios: true, standalone: true, permission: "default", on: false }), "enable", "the Home-Screen app asks");
  assert.equal(notifyOffer({ supported: true, ios: true, standalone: false, permission: "granted", on: true }), null, "already on stays on");
  assert.equal(notifyOffer({ supported: true, ios: false, standalone: false, permission: "default", on: false }), "enable", "a desktop or Android browser tab asks");
});
check("permissionOutcome (W291): granted is on; still 'default' afterwards means nothing was asked or decided; 'denied' is blocked", () => {
  assert.equal(uiHelpers.permissionOutcome("granted", "granted"), "on");
  assert.equal(uiHelpers.permissionOutcome("denied", "default"), "not-asked", "WebKit refused without asking: nothing is stored");
  assert.equal(uiHelpers.permissionOutcome("default", "default"), "not-asked", "the prompt was dismissed");
  assert.equal(uiHelpers.permissionOutcome("denied", "denied"), "blocked");
  assert.equal(uiHelpers.permissionOutcome(undefined, "default"), "not-asked");
});
check("notifyOutcome (W291): each outcome says what actually happened — and only a real 'no' points at Settings", () => {
  const notAsked = uiHelpers.notifyOutcome("not-asked", { ios: true, standalone: true, activation: true });
  assert.equal(notAsked.mark, false, "the invite stays: nothing was answered");
  assert.equal(notAsked.text, "Your device didn't show the question, so nothing is switched off — tap the button again. (Detail: tap counted ✓ · Home-Screen app ✓)",
    "an iPad is iOS too: 'device', not 'phone' (Burst 5 review C13)");
  assert.doesNotMatch(notAsked.text, /Settings/);
  assert.match(uiHelpers.notifyOutcome("not-asked", { ios: true, standalone: false, activation: false }).text, /\(Detail: tap counted ✗ · Home-Screen app ✗\)$/);
  const elsewhere = uiHelpers.notifyOutcome("not-asked", { ios: false, standalone: false, activation: null }).text;
  assert.equal(elsewhere, "Nothing was decided, so nothing is switched off — tap the button again when you're ready. (Detail: tap counted ? · browser tab)",
    "off iOS, a closed prompt is the usual cause: never claim it didn't show (Burst 5 review C12)");
  const blockedIos = uiHelpers.notifyOutcome("blocked", { ios: true, standalone: true });
  assert.equal(blockedIos.mark, true);
  assert.equal(blockedIos.text, "Notifications are switched off for this app. In Settings → Notifications, find it (the name under its Home-Screen icon), switch on Allow Notifications, then come back and tap the button.");
  assert.match(uiHelpers.notifyOutcome("blocked", { ios: false }).text, /browser's site settings/);
  assert.equal(uiHelpers.notifyOutcome("unavailable", {}).text, "Notifications aren't available right now.");
  assert.equal(uiHelpers.notifyOutcome("unavailable", {}).mark, false);
});
check("enablePush (W285, kept by W291): the permission is asked BEFORE any await — Safari shows the prompt only inside the tap", () => {
  const body = fnBody(appJs, "async function enablePush() {", 1200);
  assert.ok(body.indexOf("Notification.requestPermission()") > 0 && body.indexOf("Notification.requestPermission()") < body.indexOf("await"), "the ask comes first");
  assert.match(body, /const activation = navigator\.userActivation\?\.isActive \?\? null;\n\s*const permission = Notification\.requestPermission\(\);/, "the tap's activation is read just before the ask");
  assert.match(body, /permissionOutcome\(await permission, notifyPermission\(\)\)/, "the outcome is re-read afterwards");
});
check("notification doors (W291): the post-workout invite and Me both speak through notifyOutcome — no 'allow it in your settings' for a question never asked", () => {
  assert.doesNotMatch(appJs, /No problem — you can allow notifications any time in your settings\./);
  assert.equal((appJs.match(/notifyOutcome\(res\.outcome, \{ ios: isIOS\(\), standalone: isStandalone\(\), activation: res\.activation \}\)/g) ?? []).length, 2);
  assert.match(fnBody(appJs, "function wireNotifyInvite() {", 2500), /if \(o\.mark\) markNotifyInvite\(\); msg\(o\.text\); return;/, "a question never asked keeps the one-time invite");
});
check("trainingDaysHint (W285): the person's own days in week order — or what happens without any", () => {
  assert.equal(trainingDaysHint(["fri", "mon", "wed"]), "On Mon, Wed and Fri, if you haven't trained yet.");
  assert.equal(trainingDaysHint(["sun"]), "On Sun, if you haven't trained yet.");
  for (const none of [[], null, undefined]) assert.match(trainingDaysHint(none), /^Pick your training days on Today.*a nudge after two days off\.$/);
});

// --- W305i (the W305h check — H6/H7/H8): a way back that adds a day saves the DAYS first, then rebuilds. A failed days
// save changes nothing (said so); a failed rebuild after saved days leaves the plan-fit card offering the rebuild FORWARD
// (to the committed days) — never a state whose only door is the undo. Block wording only where there are blocks; the
// add-a-day question never calls a week "free" when it keeps a day picked for it.
{
  const { timeFitApply, timeFitDayQuestion } = uiHelpers;
  const fake = (fails = []) => { const calls = []; return { calls, post: async (path, body) => { calls.push([path, body]); if (fails.includes(path)) throw new Error("offline"); return path === "/api/commitment" ? { commitment: { days: body.days } } : { program: { name: "P" } }; } }; };
  const add = { kind: "add_day", days: 5, minutes: 45 };
  await checkAsync("#fit-apply (H6) days first: a failed days save never rebuilds, and says nothing changed", async () => {
    const f = fake(["/api/commitment"]);
    const r = await timeFitApply({ o: add, days: ["wed"], cleared: true, usual: ["mon", "tue", "thu", "fri"], thisWeek: [], uid: "u", post: f.post });
    assert.deepStrictEqual(f.calls.map((c) => c[0]), ["/api/commitment"], "no rebuild after a failed days save");
    assert.deepStrictEqual(f.calls[0][1], { user_id: "u", days: [], resume_days: ["mon", "tue", "thu", "fri", "wed"] }, "a cleared week: the usual days take the new one");
    assert.equal(r.refresh, false);
    assert.match(r.notice, /^📴 Couldn't save your days — nothing changed\./);
  });
  // W305j (J0, deliberate): a failed rebuild after saved days now puts the days back — "nothing changed" is true, and the
  // partial state (said, refreshed) is left only when that put-back fails too (the W305j checks).
  await checkAsync("#fit-apply (H6) saved days, failed rebuild: the days go back as they were, and that's said — never the days card", async () => {
    const f = fake(["/api/plan/regenerate"]);
    const r = await timeFitApply({ o: add, days: ["wed"], usual: ["mon", "tue", "thu", "fri"], thisWeek: ["mon", "tue", "thu", "fri"], uid: "u", post: f.post });
    assert.deepStrictEqual(f.calls.map((c) => c[0]), ["/api/commitment", "/api/plan/regenerate", "/api/commitment"]);
    assert.deepStrictEqual(f.calls[0][1], { user_id: "u", days: ["mon", "tue", "thu", "fri", "wed"] });
    assert.deepStrictEqual(f.calls[2][1], { user_id: "u", days: ["mon", "tue", "thu", "fri"] });
    assert.equal(r.refresh, false);
    assert.match(r.notice, /^📴 Couldn't rebuild your plan — nothing changed\./);
    assert.doesNotMatch(r.notice, /days card/, "never points at a door that can't set the usual days");
  });
  await checkAsync("#fit-apply (H8) block wording only where there are blocks: a beginner's notices never mention one", async () => {
    for (const [o, days] of [[add, ["wed"]], [{ kind: "longer", days: 4, minutes: 60 }, []], [{ kind: "refit", days: 4, minutes: 45 }, []]]) {
      const yes = await timeFitApply({ o, days, usual: ["mon", "tue", "thu", "fri"], thisWeek: ["mon", "tue", "thu", "fri"], uid: "u", post: fake().post, blocks: true });
      const no = await timeFitApply({ o, days, usual: ["mon", "tue", "thu", "fri"], thisWeek: ["mon", "tue", "thu", "fri"], uid: "u", post: fake().post, blocks: false });
      assert.equal(yes.refresh && no.refresh, true);
      assert.match(yes.notice, /block/, `${o.kind}: blocks named for a lifter who has them`);
      assert.doesNotMatch(no.notice, /block/, `${o.kind}: ${no.notice}`);
    }
    const f = fake(["/api/plan/regenerate"]);
    const r = await timeFitApply({ o: { kind: "refit", days: 4, minutes: 45 }, uid: "u", post: f.post });
    assert.deepStrictEqual([r.refresh, f.calls.length], [false, 1], "no days to save: a failed rebuild changes nothing");
    assert.match(r.notice, /^📴 Couldn't rebuild your plan — nothing changed\./);
  });
  check("#fit-question (H7) the week is 'free' only when it is — a cleared week that keeps a picked day isn't", () => {
    assert.equal(timeFitDayQuestion(1, { cleared: true, thisWeek: [] }), "Which day will you add? It starts next week — this week stays free.");
    assert.equal(timeFitDayQuestion(2, { cleared: true, thisWeek: ["sun"] }), "Which 2 days will you add? They start next week.");
    assert.equal(timeFitDayQuestion(1, { cleared: false, thisWeek: ["mon"] }), "Which day will you add?");
  });
}

// --- W305j (the W305i check — J0/J1/J2): a rebuild that failed after the days saved is CHECKED, not assumed — one that
// happened (its answer lost) is said as done (J1); one that didn't puts the days back, so "nothing changed" is true and a
// later Keep keeps what it says (J0); only if that also fails is the partial state said. The plan-fit card — the other
// forward door — names a block only where there are blocks (J2).
{
  const { timeFitApply } = uiHelpers;
  const add = { kind: "add_day", days: 5, minutes: 45 };
  const four = ["mon", "tue", "thu", "fri"];
  const run = async ({ regen = "throw", sessions = 4, rollback = "ok", getFails = false, cleared = false, thisWeek = four } = {}) => {
    const calls = [];
    const post = async (path, body) => {
      calls.push([path, body]);
      if (path === "/api/plan/regenerate") { if (regen === "throw") throw new Error("lost"); return { program: { name: "P" } }; }
      if (calls.filter((c) => c[0] === "/api/commitment").length > 1 && rollback === "fail") throw new Error("offline");
      return { commitment: { days: body.days } };
    };
    const get = async (path) => { calls.push([path]); if (getFails) throw new Error("offline"); return { program: { name: "P", sessions: Array.from({ length: sessions }, (_, i) => ({ name: `D${i}` })) } }; };
    const r = await timeFitApply({ o: add, days: ["wed"], cleared, usual: four, thisWeek, uid: "u", post, get });
    return { r, calls };
  };
  await checkAsync("#fit-apply (W305j J1) a rebuild whose answer was lost but which happened: said as done, and refreshed", async () => {
    const { r, calls } = await run({ sessions: 5 });
    assert.deepStrictEqual(calls.map((c) => c[0]), ["/api/commitment", "/api/plan/regenerate", "/api/plan/explain"]);
    assert.deepStrictEqual([r.refresh, /^🗓️ Rebuilt for 5 days a week/.test(r.notice)], [true, true], r.notice);
  });
  await checkAsync("#fit-apply (W305j J0) a rebuild that truly failed puts the days back — 'nothing changed' is then true", async () => {
    const { r, calls } = await run({ sessions: 4 });
    assert.deepStrictEqual(calls.map((c) => c[0]), ["/api/commitment", "/api/plan/regenerate", "/api/plan/explain", "/api/commitment"]);
    assert.deepStrictEqual(calls[3][1], { user_id: "u", days: four }, "the days as they were");
    assert.deepStrictEqual([r.refresh, r.notice], [false, "📴 Couldn't rebuild your plan — nothing changed. Try again in a moment."]);
    const cl = await run({ sessions: 4, cleared: true, thisWeek: [] });
    assert.deepStrictEqual(cl.calls[3][1], { user_id: "u", days: [], resume_days: four }, "a cleared week: the usual days go back as they were, this week's stay");
    const unknown = await run({ getFails: true });
    assert.deepStrictEqual(unknown.calls.map((c) => c[0]).at(-1), "/api/commitment", "the check itself offline: treated as failed, the days put back");
  });
  await checkAsync("#fit-apply (W305j J0) only when the put-back fails too is the partial state said — and refreshed so the card shows it", async () => {
    const { r } = await run({ sessions: 4, rollback: "fail" });
    assert.deepStrictEqual([r.refresh, /^📴 Your days saved, but the plan couldn't rebuild/.test(r.notice)], [true, true], r.notice);
  });
}
check("#plan-fit (W305j J2) the plan-fit card and its notice name a block only where there are blocks", () => {
  const b = planFitCopy({ plan_days: 2, committed_days: 3, blocks: false });
  assert.doesNotMatch(b.body + b.notice, /block/, JSON.stringify(b));
  assert.equal(b.notice, "🗓️ Rebuilt for 3 days a week — your new plan starts with your next workout.");
  assert.equal(planFitCopy({ plan_days: 4, committed_days: 3 }).notice, "🗓️ Rebuilt for 3 days a week — a fresh training block starts with your next workout.");
});

// --- W307: "Last time" groups each weight's reps, an estimated count shown with a ~ (last_sets [kg, reps, true]).
check("#est lastTimeGroups: every set as done, an estimate with a ~; an older payload (no last_sets) still reads", () => {
  const { lastTimeGroups } = uiHelpers;
  assert.deepStrictEqual(lastTimeGroups({ last_sets: [[100, 10], [100, 9, true], [95, 8]] }), [{ kg: 100, reps: ["10", "~9"] }, { kg: 95, reps: ["8"] }]);
  assert.deepStrictEqual(lastTimeGroups({ last_sets: [[60, 12, true], [60, 11, true]], last_reps: [], last_kg: 60 }), [{ kg: 60, reps: ["~12", "~11"] }], "all estimated: still shown, never hidden");
  assert.deepStrictEqual(lastTimeGroups({ last_reps: [10, 9], last_kg: 100 }), [{ kg: 100, reps: ["10", "9"] }]);
  assert.deepStrictEqual(lastTimeGroups({}), []);
});
check("#est the read-out never grades a lift on estimates: all-estimated is said as such — never 'in its range', never 'easy day'", () => {
  const t = [{ exercise: "bench", sets: 2, rep_range: "8-12", rir: "1-2" }];
  const E = (reps) => ({ exercise: "bench", set_type: "work", weight_kg: 100, reps, est: ["reps"] });
  const all = readoutLists(sessionCore.localReadout(t, [E(10), E(10)]), { nameOf: () => "Bench press" });
  assert.equal(all.headline, "Every set done — logged as estimates, so next time keeps the weight.");
  const mixT = [...t, { exercise: "row", sets: 1, rep_range: "8-12", rir: "1-2" }];
  const nameOf = (id) => (id === "bench" ? "Bench press" : "Row");
  const mix = readoutLists(sessionCore.localReadout(mixT, [E(10), E(10), { exercise: "row", set_type: "work", weight_kg: 60, reps: 10, rir: 1 }]), { nameOf });
  assert.equal(mix.headline, "Every set done — Bench press logged as estimates, and every other lift in its range: a session that moves you forward.");
  const part = readoutLists(sessionCore.localReadout(t, [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 10, rir: 1 }, E(9)]), { nameOf });
  assert.ok(part.watch.includes("Bench press: 1 set logged as an estimate — only real sets move your weights."), JSON.stringify(part.watch));
  assert.equal(readoutLists(sessionCore.localReadout(t, [E(10), E(10)]), { nameOf, beginner: true }).headline, "Every set done — logged as estimates, so next time keeps the weight.", "a beginner gets the same honest headline");
});
check("#est player wiring: both bank handlers bank the estimate per field, and a PR never celebrates an estimated count", () => {
  assert.equal((appJs.match(/const ef = estimatedFields\(sess\.estPending\?\.\[(e|m)\.exercise\], \{ setNo: loggedSetCount\((e|m)\.exercise\), reps: sess\.reps\[(sess\.i|idx)\], eff: sess\.eff\[(sess\.i|idx)\] \}\);/g) ?? []).length, 2);
  assert.equal((appJs.match(/\.\.\.\(ef\.rir != null \? \{ rir: ef\.rir \} : \{\}\), \.\.\.\(ef\.estReps \? \{ est: \["reps"\] \} : \{\}\), \.\.\.\(ef\.rir_est != null \? \{ rir_est: ef\.rir_est \} : \{\}\)/g) ?? []).length, 2);
  assert.equal((appJs.match(/checkAndCelebratePR\((e|m), loggedSet\.weight_kg, loggedSet\.reps, loggedSet\.deload, repsEstimated\(loggedSet\)\)/g) ?? []).length, 2);
  assert.match(appJs, /function checkAndCelebratePR\(exObj, weightKg, reps, deload, estReps = false\) \{/);
});

check("#rest-read player wiring (W308): every rest records the timer it ran — a superset round for both legs — and Every lift shows the time between sets", () => {
  assert.match(appJs, /const startRest = \(kind, length, ex, legs = ex \? \[ex\] : \[\]\) => \{ sess\.rest = newRest\(\{ kind, length, ex, logged: sess\.logged\.length \}, Date\.now\(\)\); sess\.restUsed = \{ \.\.\.\(sess\.restUsed \?\? \{\}\), \.\.\.Object\.fromEntries\(legs\.map\(\(id\) => \[id, length\]\)\) \};/);
  assert.match(appJs, /startRest\("round", 60, null, \[sess\.ex\[L\]\.exercise, sess\.ex\[P\]\.exercise\]\)/);
  assert.match(appJs, /l\.gap_s \? ` · ≈\$\{formatRest\(l\.gap_s\)\} between sets\$\{l\.rest_s \? ` \(timer \$\{formatRest\(l\.rest_s\)\}\)` : ""\}` : ""/);
  assert.match(appJs, /\$\{\(l\.reps_shown \?\? l\.reps\)\.join\(", "\)\} reps at/);
});

check("#est (review D3) History's workout detail shows an estimate as one: ~reps, and an estimated RIR as @~N", () => {
  assert.match(appJs, /const setText = \(s\) => `\$\{dispWeightFor\(s\.weight_kg, s\.exercise\)\} × \$\{repsShown\(s\)\}\$\{typeof s\.rir === "number" \? ` @\$\{s\.rir\}` : typeof s\.rir_est === "number" \? ` @~\$\{s\.rir_est\}` : ""\}/);
});

check("#moved (review copy#3/#4) the moved cue promises a hint only where one can fire; the estimate note says 'either' only when both were filled", () => {
  const { movedCue } = sessionCore;
  assert.match(movedCue({ equipment: "barbell", suggested_kg: 60 }, {}), /after set 1 the hint adjusts/);
  assert.doesNotMatch(movedCue({ equipment: "bodyweight", suggested_kg: 0 }, {}), /hint/, "a bodyweight lift has no next-set hint");
  assert.doesNotMatch(movedCue({ equipment: "barbell", suggested_kg: 60, eased: true }, {}), /hint/, "a tired-eased lift has none");
  assert.doesNotMatch(movedCue({ equipment: "barbell", suggested_kg: 60 }, { deload: true }), /hint/, "nor a deload week");
  assert.match(appJs, /change \$\{p\?\.rirChip != null \? "either" : "it"\} if you remember/);
});

check("#w310 wiring: a skip drops the skipped lift's guessed numbers (dropSkipped); the editor edits from what it opened with (base)", () => {
  assert.match(fnBody(appJs, "function applySkip(r, redraw) {", 1600), /sess = dropSkipped\(before, r\.sess\);/);
  assert.match(fnBody(appJs, "function applySkip(r, redraw) {", 1800), /redraw\(\);\n\s*sess = noteSeeded\(sess\); saveSess\(\); \/\/ what the screen seeded/, "the seeded snapshot follows the redraw (W312)");
  // (W311, the fix check player#0: the keystroke write carries the base; "Forgot" applies to the entry as it stands now —
  // a weight or RIR typed just before it stays.)
  assert.equal((appJs.match(/editLoggedSet\(sess\.logged, ed\.idx, patch, \{ exercise: ed\.exercise, completed_at: ed\.completed_at, base: entry0 \}\)/g) ?? []).length, 1, "the keystroke write carries the base");
  assert.match(appJs, /editLoggedSet\(sess\.logged, idx, \{ estimate: \{ reps: est\.reps, rir: est\.rir \} \}, \{ exercise: entry0\.exercise, completed_at: entry0\.completed_at \?\? null \}\);/, "Forgot: on the entry as it stands");
  assert.match(fnBody(appJs, '$("#doner").onclick = () => {', 3000), /const at = new Date\(\)\.toISOString\(\); \/\/ ONE stamp per round/, "a round banks with one stamp (fix check player#2)");
});

check("#announce (W313) Today shows an announcement in its own card, never behind the check-in; Progress says 'retunes itself' only where it does", () => {
  assert.match(appJs, /const announceCard = s\.announcement \? `<div class="card" id="announcement"><p>📣 \$\{esc\(s\.announcement\)\}<\/p><\/div>` : "";/);
  assert.match(appJs, /const readinessCard = s\.readiness != null && s\.coach_note \?/, "the readiness note keeps its own gate");
  assert.match(appJs, /const autoAdaptNote = p\.tunes && p\.sessions_logged >= 4/);
});

console.log(`\n${pass} ui-helper test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
