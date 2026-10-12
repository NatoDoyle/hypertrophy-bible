// Pure UI helpers (app/public/ui-helpers.mjs) — the testable half of the Wave-244
// path shorteners. app.js itself cannot be imported under Node (top-level DOM), so
// anything with real logic lives here, red-first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupSessionsByWeek, mondayOf, weekLabelOf, seedCalendarDays, filterExercises, linePath, sideCue, shiftDay, dayLabel, hubWorkoutState, calendarDrift, calendarAdvice } from "../public/ui-helpers.mjs";

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

console.log(`\n${pass} ui-helper test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
