// The adherence & gamification engine — pure, derived from logged sessions.
// Aggressive engagement (XP, levels, streaks, loss-aversion, identity milestones)
// with two hard SAFETY RAILS baked in:
//   1. Never incentivize training through injury/illness — a pause suspends all
//      pressure/streak-risk with zero penalty.
//   2. The "streak" is forgiving (counts weeks trained, bridges one missed week,
//      grace on the in-progress week) and framed as identity, never shame.
import { isoWeekKey, isHardSet, sessionWeekKey } from "../../tools/derive-core.mjs";
import { COMEBACK_GAP_DAYS } from "./coach.mjs"; // ONE threshold — the message and the deload must fire together

// Epoch-ms of the Monday that starts ISO week `week` of ISO year `year`.
function isoWeekMondayMs(year, week) {
  const jan4 = Date.UTC(year, 0, 4);                       // Jan 4 is always in ISO week 1
  const jan4Dow = new Date(jan4).getUTCDay() || 7;         // 1=Mon .. 7=Sun
  const week1Monday = jan4 - (jan4Dow - 1) * 86400000;
  return week1Monday + (week - 1) * 7 * 86400000;
}

// A strictly sequential week index: consecutive calendar weeks always differ by
// exactly 1. (year*53+week left a phantom slot at ISO-year boundaries that the
// streak walker mistook for a missed week, silently burning its one forgiveness
// token.) Normalizing through isoWeekKey keeps raw dates and keys consistent.
const weekOrdinal = (dateOrKey) => {
  const key = typeof dateOrKey === "string" && /-W\d/.test(dateOrKey) ? dateOrKey : isoWeekKey(dateOrKey);
  const m = key.match(/(\d+)-W(\d+)/);
  return m ? Math.round(isoWeekMondayMs(+m[1], +m[2]) / (7 * 86400000)) : 0;
};

// Weeks-consistent streak: consecutive trained weeks, forgiving one missed week,
// with grace for the current (in-progress) week. Rest days never threaten it.
// A pause (injury/illness) makes every week from its start date onward NEUTRAL —
// those weeks neither extend nor break the streak and never spend the one
// forgiveness token — so the streak FREEZES at its pre-pause value instead of
// silently collapsing. This is rail #1 made literally true: the app tells a paused
// user "your streak is safe", and now it is (before, weeksConsistent never saw the
// pause, so any layoff > ~2 weeks reset an injured user to "0 weeks strong" — the
// exact demotivation the rail exists to prevent). `paused` is user.paused:
// { from: "YYYY-MM-DD", reason } or falsy; a legacy pause with no date neutralizes
// only the current week.
export function weeksConsistent(sessions, now, paused = null, pauseHistory = []) {
  // local_date (the device's calendar day, when the client sent one) banks the
  // session to the week the USER experienced — a Monday-morning session in
  // UTC+12 is Monday, not the previous ISO week's Sunday.
  const trained = new Set(sessions.filter((s) => s.local_date || s.date).map((s) => weekOrdinal(sessionWeekKey(s))));
  if (!trained.size) return 0;
  const cur = weekOrdinal(now);
  const pauseStartWeek = paused ? (paused.from ? weekOrdinal(paused.from) : cur) : Infinity;
  // ARCHIVED pause windows stay neutral forever: resuming used to null the
  // record, retroactively turning the frozen weeks into misses and collapsing
  // the streak the pause card promised was safe.
  const windows = (pauseHistory ?? []).filter((p) => p?.from && p?.to).map((p) => [weekOrdinal(p.from), weekOrdinal(p.to)]);
  const inPause = (w) => w >= pauseStartWeek || windows.some(([a, b]) => w >= a && w <= b); // the walk only ever visits w <= cur
  let w = trained.has(cur) ? cur : cur - 1; // grace: not training THIS week yet doesn't break it
  let streak = 0, forgiven = false;
  while (w > 0) {
    if (trained.has(w)) { streak++; w--; }
    else if (inPause(w)) { w--; } // injured/ill week — neutral: no penalty, no forgiveness spent
    else if (!forgiven && (trained.has(w - 1) || inPause(w - 1))) { forgiven = true; w--; } // bridge a single miss — a paused predecessor counts as trained-equivalent, so a miss right after a pause can't collapse the pre-pause streak
    else break;
  }
  return streak;
}

export function xpAndLevel(sessions) {
  // 100 XP per session + 5 per hard set — engagement tied to real training.
  const xp = sessions.reduce((a, s) => a + 100 + (s.sets ?? []).filter((set) => isHardSet(set)).length * 5, 0);
  const level = Math.floor(xp / 500) + 1;           // ~a level every ~5 sessions
  const into = xp - (level - 1) * 500;
  return { xp, level, level_progress_pct: Math.round((into / 500) * 100), xp_to_next: 500 - into };
}

const MILESTONES = [
  [1, "First session logged 💪 — you're someone who trains now."],
  [3, "Three sessions in — the habit is taking root."],
  [8, "Eight sessions — you've cleared the hardest part: starting."],
  [20, "Twenty sessions. This is just who you are now."],
  [50, "Fifty sessions of showing up."],
  [100, "One hundred sessions. That's a serious lifter."],
  [200, "Two hundred. Most people never get close."],
];
export function milestones(sessionCount) {
  const reached = MILESTONES.filter(([n]) => sessionCount >= n).map(([at, msg]) => ({ at, msg }));
  const next = MILESTONES.find(([n]) => sessionCount < n);
  return { reached, latest: reached[reached.length - 1] ?? null, next: next ? { at: next[0], msg: next[1] } : null };
}

// Motivational state — powers the Today header. Suppressed to "paused" when the
// user has flagged injury/illness (rail #1: no pressure, no guilt, ever).
export function adherenceStatus(sessions, now, paused) {
  if (paused) return { state: "paused", message: "Paused — heal up. Nothing's at stake and your streak is safe." };
  const times = sessions.filter((s) => s.date).map((s) => +new Date(s.date)).sort((a, b) => b - a);
  if (!times.length) return { state: "new", message: "Log your first session to start your streak." };
  const daysSince = (+new Date(now) - times[0]) / 86400000;
  // Same threshold AND same rounding as suggestWeight's layoff deload, so this
  // message is only ever shown when the weights really are eased.
  if (Math.round(daysSince) >= COMEBACK_GAP_DAYS) return { state: "comeback", days_since: Math.round(daysSince), message: "Welcome back — I've eased your weights so you ramp in safely. Picking the chain right back up." };
  const trainedThisWeek = sessions.some((s) => (s.local_date || s.date) && weekOrdinal(sessionWeekKey(s)) === weekOrdinal(now));
  if (!trainedThisWeek) return { state: "at-risk", message: "Keep the chain alive — one session this week protects your streak." };
  return { state: "on-track", message: "On track this week. Nice." };
}

export function weeklySummary(sessions, now) {
  const cur = weekOrdinal(now);
  const wk = sessions.filter((s) => (s.local_date || s.date) && weekOrdinal(sessionWeekKey(s)) === cur);
  const hardSets = wk.reduce((a, s) => a + (s.sets ?? []).filter((set) => isHardSet(set)).length, 0);
  return { sessions: wk.length, hard_sets: hardSets };
}

// The whole adherence payload for the app.
export function adherenceReport(user, sessions, now = new Date().toISOString()) {
  const paused = !!user.paused;
  const streak = weeksConsistent(sessions, now, user.paused || null, user.pause_history || []);
  return {
    streak_weeks: streak,
    ...xpAndLevel(sessions),
    sessions_logged: sessions.length,
    milestones: milestones(sessions.length),
    status: adherenceStatus(sessions, now, paused),
    week: weeklySummary(sessions, now),
    paused,
  };
}
