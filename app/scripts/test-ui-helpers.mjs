// Pure UI helpers (app/public/ui-helpers.mjs) — the testable half of the Wave-244
// path shorteners. app.js itself cannot be imported under Node (top-level DOM), so
// anything with real logic lives here, red-first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupSessionsByWeek, mondayOf, weekLabelOf, seedCalendarDays, filterExercises, linePath, sideCue, shiftDay, dayLabel, hubWorkoutState, calendarDrift, calendarAdvice, bringBackCopy, swapUndoCopy, weekStrip, weekChipLabel, nextSessionLine, crossesBlockEnd, offPlanLabel, offPlanPreview, planFitCopy, planFitRequest, planFitVisible, noteInUnit, hintCopy, readoutLists, MUSCLE_LABEL, friendlyMuscle, friendlyList , notifyOffer, trainingDaysHint, DEVICE_PREFS } from "../public/ui-helpers.mjs";
import { suggestWeight, MUSCLE_PLAIN } from "../src/coach.mjs";
import { prefillInUnit } from "../public/session-core.mjs";

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
check("planFitCopy: fewer days than workouts — they roll into next week, your muscles get less; the rebuild fits the week", () => {
  assert.deepEqual(planFitCopy({ plan_days: 4, committed_days: 3 }), {
    title: "Fit your plan to your 3 days?",
    body: "You've been picking 3 days a week, but your plan has 4 workouts — so workouts keep rolling into the next week, and your muscles get less than the plan was built for. Rebuilt for 3 days, every workout fits your week. It starts a fresh training block.",
    rebuild: "Rebuild for 3 days", keep: "Keep my 4-day plan", key: "4:3", days: 3,
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
// The next-set hint says what actually happened: reps under, reps over — or reps IN the range
// with far more left in the tank than planned (that hint fires on effort; "over the range"
// was a false statement there).
check("#hint-copy each kind of hint says what actually happened", () => {
  const j = (c) => `${c.lead} — ${c.why}. Try ${c.tryW} ${c.tail}`;
  assert.equal(j(hintCopy({ kind: "lighter", reps: 6, min: 8, max: 12, rir: null, band: "1-3" }, { setNo: 1, fromW: "60 kg", toW: "55 kg" })),
    "Set 1: 6 reps at 60 kg — under the 8–12 range. Try 55 kg for this one to land in it, allowing for the rep or so each hard set costs.");
  assert.equal(j(hintCopy({ kind: "heavier", reps: 15, min: 8, max: 12, rir: null, band: "1-3" }, { setNo: 2, fromW: "40 kg", toW: "42.5 kg" })),
    "Set 2: 15 reps at 40 kg — over the 8–12 range. Try 42.5 kg for this one to land in it.");
  assert.equal(j(hintCopy({ kind: "heavier", reps: 10, min: 8, max: 12, rir: 5, band: "1-3" }, { setNo: 1, fromW: "40 kg", toW: "45 kg" })),
    "Set 1: 10 reps at 40 kg — in the range, but with about 5 left in the tank (the plan says 1–3). Try 45 kg for this one.");
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
const L = (exercise, o) => ({ exercise, planned: 3, done: 3, min: 8, max: 12, reps: [], kg: [], top: false, under: 0, easy: false, failure: false, easyDay: false, rir: null, band: "1-3", ...o });
const nm = (id) => ({ a: "Bench Press", b: "Row", c: "Curl" })[id] ?? id;
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
  assert.match(appJs, /\$\{round === 0 \? whyLine\(m\) : ""\}/);
});
check("player: every stepper starts on the plate-aware suggestion (single lift AND station), and the hint speaks through hintCopy", () => {
  assert.doesNotMatch(appJs, /sess\.weights\[[^\]]+\] = dispWeightFor\(startWeightDefault\(/, "a pre-fill site still rounds the raw suggestion");
  assert.equal((appJs.match(/= startWeightDisp\((e|m)\);/g) ?? []).length, 2);
  assert.match(appJs, /hintCopy\(hint, \{ setNo: sess\.set,/);
});
check("player (W289): both reps steppers start on the per-set aim (repSeed, from the BANKED count), both bank handlers drop the stale value, the hint fills its reps", () => {
  assert.doesNotMatch(appJs, /topReps\((e|m)\.rep_range\)/, "a seed site still starts on the range's top");
  assert.equal((appJs.match(/= repSeed\((e|m), loggedSetCount\((e|m)\.exercise\), \{ lastReps: lastWorkReps\(sess\.logged, (e|m)\.exercise\), atServed: /g) ?? []).length, 2, "single lift AND station seed through repSeed");
  assert.match(fnBody(appJs, '$("#done").onclick = () => {', 3000), /delete sess\.eff\[sess\.i\]; \/\/ each set is its own call[^\n]*\n\s*delete sess\.reps\[sess\.i\];/, "the single lift's bank re-derives the next set's aim");
  assert.match(fnBody(appJs, '$("#doner").onclick = () => {', 3000), /delete sess\.eff\[idx\]; \/\/ each set is its own call[^\n]*\n\s*delete sess\.reps\[idx\];/, "the station's bank too");
  assert.match(appJs, /sess\.reps\[sess\.i\] = hint\.target_reps/, "Use X kg also sets the reps it aims at");
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
check("trainingDaysHint (W285): the person's own days in week order — or what happens without any", () => {
  assert.equal(trainingDaysHint(["fri", "mon", "wed"]), "On Mon, Wed and Fri, if you haven't trained yet.");
  assert.equal(trainingDaysHint(["sun"]), "On Sun, if you haven't trained yet.");
  for (const none of [[], null, undefined]) assert.match(trainingDaysHint(none), /^Pick your training days on Today.*a nudge after two days off\.$/);
});

console.log(`\n${pass} ui-helper test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
