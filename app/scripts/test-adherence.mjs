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

console.log(`\n${pass} adherence test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
