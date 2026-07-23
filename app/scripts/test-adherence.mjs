// Unit tests for the adherence & gamification engine (src/adherence.mjs).
import { weeksConsistent, xpAndLevel, milestones, adherenceStatus, weeklySummary, adherenceReport } from "../src/adherence.mjs";
import { COMEBACK_GAP_DAYS } from "../src/coach.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)); };
const sess = (date, hard = 3) => ({ date, sets: Array.from({ length: hard }, () => ({ set_type: "work", weight_kg: 100, reps: 8 })) });

// consecutive weeks (W02, W03, W04), "today" in W04
const three = [sess("2026-01-05"), sess("2026-01-12"), sess("2026-01-19")];
ok("streak counts consecutive trained weeks", weeksConsistent(three, "2026-01-21") === 3);
ok("grace: not training the current week yet doesn't break the streak", weeksConsistent(three, "2026-01-22") === 3);
// one missed week (W03) is forgiven
ok("streak bridges a single missed week", weeksConsistent([sess("2026-01-05"), sess("2026-01-19")], "2026-01-21") === 2);
ok("no sessions -> streak 0", weeksConsistent([], "2026-01-21") === 0);
// #15: streak survives an ISO-year boundary. 4 of 5 weekly sessions (W52 2023 genuinely
// missed, then bridged) across 2023->2024. The old year*53+week ordinal left a phantom
// week at the boundary that ate the forgiveness token and capped this at 2.
const acrossYear = ["2023-12-11", "2023-12-18", "2024-01-01", "2024-01-08"].map((d) => sess(d));
ok("streak survives the year boundary (no phantom-week token burn)", weeksConsistent(acrossYear, "2024-01-08") === 4);

// #19 (CRITICAL rail): an injury/illness pause must FREEZE the streak, not reset it.
// `three` builds a 3-week streak ending W04 (2026-01-19). The user then gets injured
// and pauses from W05 (2026-01-26); "now" is ~5 weeks into the pause (2026-02-23).
const injuredNow = "2026-02-23";
ok("WITHOUT a pause, a 5-week layoff correctly resets the streak (control)",
  weeksConsistent(three, injuredNow) === 0);
ok("#19 a pause freezes the streak at its pre-pause value (injured user stays 'safe')",
  weeksConsistent(three, injuredNow, { from: "2026-01-26" }) === 3);
ok("#19 adherenceReport threads user.paused so the reported streak survives the pause",
  adherenceReport({ paused: { from: "2026-01-26" } }, three, injuredNow).streak_weeks === 3);
ok("#19 a legacy dateless pause neutralizes only the current week (safe minimal fallback)",
  weeksConsistent(three, injuredNow, true) === 0);
ok("#19 a pause never RETROACTIVELY bridges a real gap before it (no free streak)",
  // trained W02 only (2026-01-05), missed W03+, pause starts W06 (2026-02-02): the
  // W03/W04/W05 gap is BEFORE the pause and still breaks — streak counts just W02.
  weeksConsistent([sess("2026-01-05")], injuredNow, { from: "2026-02-02" }) === 0);

// XP + level: 3 sessions × (100 + 3 hard sets ×5) = 3×115 = 345 -> level 1
const xl = xpAndLevel(three);
ok("xp = 100/session + 5/hard-set", xl.xp === 345);
ok("level starts at 1", xl.level === 1 && xl.xp_to_next === 500 - 345);
// 5 sessions of 5 hard sets = 5×125 = 625 -> level 2
ok("levels up past 500 XP", xlLevel(5, 5) === 2);
function xlLevel(n, hard) { return xpAndLevel(Array.from({ length: n }, () => sess("2026-01-05", hard))).level; }

// milestones
const ms = milestones(8);
ok("milestones reached include 8", ms.reached.some((r) => r.at === 8) && ms.latest.at === 8);
ok("milestones next points beyond current", ms.next.at === 20);

// status states
ok("status new when no sessions", adherenceStatus([], "2026-01-21", false).state === "new");
ok("status paused overrides everything", adherenceStatus(three, "2026-01-21", true).state === "paused");
ok("status on-track when trained this week", adherenceStatus(three, "2026-01-21", false).state === "on-track");
ok("status at-risk when not trained this week", adherenceStatus([sess("2026-01-12")], "2026-01-21", false).state === "at-risk");
ok("status comeback after a long gap", adherenceStatus([sess("2026-01-05")], "2026-01-21", false).state === "comeback");
// The comeback MESSAGE must fire at exactly the same threshold as the coach's
// weight deload (COMEBACK_GAP_DAYS) — it once promised eased weights at 10 days
// while the engine eased at 12, prescribing HEAVIER loads under a safety banner.
ok("comeback fires at exactly the deload threshold (>= " + COMEBACK_GAP_DAYS + "d), not before", (() => {
  const day = (n) => new Date(+new Date("2026-03-01T18:00:00Z") + n * 86400000).toISOString();
  const s = [{ date: "2026-03-01T18:00:00Z", sets: [] }];
  const before = adherenceStatus(s, day(COMEBACK_GAP_DAYS - 1), false).state;
  const at = adherenceStatus(s, day(COMEBACK_GAP_DAYS), false).state;
  return before !== "comeback" && at === "comeback";
})());

// weekly summary
ok("weeklySummary counts this week's sessions + hard sets", (() => { const w = weeklySummary(three, "2026-01-21"); return w.sessions === 1 && w.hard_sets === 3; })());

// full report shape
const rep = adherenceReport({ paused: null }, three, "2026-01-21");
ok("adherenceReport bundles streak + level + status", rep.streak_weeks === 3 && rep.level >= 1 && rep.status.state === "on-track");
ok("paused user -> report reflects the safety rail", adherenceReport({ paused: { from: "2026-01-20" } }, three, "2026-01-21").status.state === "paused");


// --- #21: resuming from a pause must not retroactively break the streak ---
{
  // 10 consecutive trained weeks (W02..W11 of 2026), then a 4-week pause, then resume + train
  const weeks10 = Array.from({ length: 10 }, (_, i) => sess(new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10)));
  const pauseFrom = "2026-03-16"; // W12
  const resumedTrain = sess("2026-04-13"); // W16 — back in the gym
  const now = "2026-04-15";
  ok("#21 streak is frozen WHILE paused", weeksConsistent(weeks10, now, { from: pauseFrom }, []) === 10);
  ok("#21 the OLD bug: resume with no archive collapsed the streak", weeksConsistent([...weeks10, resumedTrain], now, null, []) <= 2);
  ok("#21 resume with the window ARCHIVED keeps the streak and grows it",
    weeksConsistent([...weeks10, resumedTrain], now, null, [{ from: pauseFrom, to: "2026-04-12" }]) === 11);
  ok("#21 adherenceReport wires user.pause_history through",
    adherenceReport({ paused: null, pause_history: [{ from: pauseFrom, to: "2026-04-12" }], profile: {} }, [...weeks10, resumedTrain], now).streak_weeks === 11);
  // #27: a single missed week IMMEDIATELY after a pause window must still bridge —
  // the pre-pause streak was collapsing to 1 (the bridge only checked trained.has).
  const missAfterPause = sess("2026-04-27"); // W18 trained; W17 (right after the W12-16 pause) missed
  ok("#27 a miss right after a pause bridges, keeping the pre-pause streak",
    weeksConsistent([...weeks10, missAfterPause], "2026-04-29", null, [{ from: pauseFrom, to: "2026-04-19" }]) === 11);
}

// --- #27: malformed local_date never breaks streak banking (UTC fallback) ---
{
  const good = { date: "2026-02-02T12:00:00Z", local_date: "2026-02-02", sets: [{ set_type: "work", weight_kg: 100, reps: 8 }] };
  const bad = { date: "2026-02-09T12:00:00Z", local_date: "2026-13-45", sets: [{ set_type: "work", weight_kg: 100, reps: 8 }] }; // format-shaped but not a real date -> NaN week key -> UTC fallback
  ok("#27 a session with a malformed local_date still counts (falls back to its UTC date)",
    weeksConsistent([good, bad], "2026-02-10") === 2);
}

// --- #21: sessions bank to the user's LOCAL calendar week when the client sends one ---
{
  // Sunday 20:00 UTC = Monday 09:00 in UTC+13 — the user experienced Monday.
  const utcSunday = { date: "2026-01-25T20:00:00Z", local_date: "2026-01-26", sets: [{ set_type: "work", weight_kg: 100, reps: 8 }] };
  const now = "2026-01-27T20:00:00Z"; // Tuesday UTC (still the user's Monday week either way)
  ok("#21 local_date banks the session to the week the user experienced (streak on-track, not at-risk)",
    adherenceStatus([utcSunday], now, false).state === "on-track");
  const utcOnly = { ...utcSunday }; delete utcOnly.local_date;
  ok("#21 without local_date the same session still counts by UTC date (backward compatible)",
    adherenceStatus([utcOnly], now, false).state === "at-risk"); // the documented bug for legacy sessions — fixed only when the client stamps local_date
}

console.log(`\n${pass} adherence test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
