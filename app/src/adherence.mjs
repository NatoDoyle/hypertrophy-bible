// The adherence & gamification engine — pure, derived from logged sessions.
// Aggressive engagement (XP, levels, streaks, loss-aversion, identity milestones)
// with two hard SAFETY RAILS baked in:
//   1. Never incentivize training through injury/illness — a pause suspends all
//      pressure/streak-risk with zero penalty.
//   2. The "streak" is forgiving (counts weeks trained, bridges one missed week,
//      grace on the in-progress week) and framed as identity, never shame.
import { isoWeekKey, isHardSet, sessionWeekKey, detectPersonalRecords, PR_XP, luckySetsInSession, LUCKY_SET_XP } from "../../tools/derive-core.mjs";
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
// `frozenWeeks` (user.streak_freezes: ISO week keys the user spent a freeze token
// on) are treated as NEUTRAL, exactly like an injury pause — a spent freeze is just
// a single-week pause the user chose. Reusing the tested neutral-week path (not a
// new branch in the forgiveness walk) keeps this bug-prone walker unchanged in
// spirit: a freeze can never *break* a streak, only bridge a gap the one free
// forgiveness didn't cover.
export function weeksConsistent(sessions, now, paused = null, pauseHistory = [], frozenWeeks = []) {
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
  const frozen = new Set((frozenWeeks ?? []).map(weekOrdinal));
  const inPause = (w) => w >= pauseStartWeek || windows.some(([a, b]) => w >= a && w <= b) || frozen.has(w); // the walk only ever visits w <= cur
  let w = trained.has(cur) ? cur : cur - 1; // grace: not training THIS week yet doesn't break it
  let streak = 0, forgiven = false;
  while (w > 0) {
    if (trained.has(w)) { streak++; w--; }
    else if (inPause(w)) { w--; } // injured/ill OR frozen week — neutral: no penalty, no forgiveness spent
    else if (!forgiven && (trained.has(w - 1) || inPause(w - 1))) { forgiven = true; w--; } // bridge a single miss — a paused predecessor counts as trained-equivalent, so a miss right after a pause can't collapse the pre-pause streak
    else break;
  }
  return streak;
}

// --- Streak-freeze tokens (#4 adherence): a user-HELD protection the roadmap calls
// out as missing. Distinct from the automatic single-miss forgiveness already in the
// walker — a freeze is a token the user earns by training and chooses to spend to
// neutralise a missed week, so it survives a SECOND miss the free forgiveness can't.
// Loss-aversion + the endowment effect: a balance you can see and don't want to lose.
export const STREAK_FREEZE_MAX = 3;       // most you can hold at once (Duolingo-style cap)
export const WEEKS_PER_FREEZE = 4;        // earn one per ~month of weeks actually trained
export const FREEZE_LOOKBACK_WEEKS = 6;   // how far back a token may reach (no reviving ancient streaks)

// Distinct weeks the user has trained — the SAME device-local week banking the streak
// walker uses. Freezes are earned from this (a monotone count), NOT from the streak
// value, so a freeze can never feed back into the streak it protects.
export function trainedWeekCount(sessions) {
  return new Set((sessions ?? []).filter((s) => s.local_date || s.date).map((s) => weekOrdinal(sessionWeekKey(s)))).size;
}

// Freeze wallet + what's protectable right now. `earnedTotal` grows without bound as
// you train; the holdable BALANCE is capped at STREAK_FREEZE_MAX, replenishing as you
// spend and keep training. `protectable_week` is the single most-recent missed week a
// token could still reach (the clear one-tap "protect last week" case); `freezable`
// lists every reachable missed week for a client that wants to offer a choice.
export function streakFreezeState(sessions, now, freezes = [], paused = null, pauseHistory = []) {
  const used = (freezes ?? []).length;
  const earnedTotal = Math.floor(trainedWeekCount(sessions) / WEEKS_PER_FREEZE);
  const balance = Math.max(0, Math.min(STREAK_FREEZE_MAX, earnedTotal - used));
  const cur = weekOrdinal(now);
  const trained = new Set((sessions ?? []).filter((s) => s.local_date || s.date).map((s) => weekOrdinal(sessionWeekKey(s))));
  const frozenOrd = new Set((freezes ?? []).map(weekOrdinal));
  const pauseStartWeek = paused ? (paused.from ? weekOrdinal(paused.from) : cur) : Infinity;
  const windows = (pauseHistory ?? []).filter((p) => p?.from && p?.to).map((p) => [weekOrdinal(p.from), weekOrdinal(p.to)]);
  const neutral = (w) => w >= pauseStartWeek || windows.some(([a, b]) => w >= a && w <= b) || frozenOrd.has(w);
  // Candidate = a PAST week (never the in-progress current week, still trainable),
  // within lookback, that was missed and isn't already neutral.
  const freezable = [];
  for (let w = cur - 1; w >= cur - FREEZE_LOOKBACK_WEEKS && w > 0; w--) {
    if (!trained.has(w) && !neutral(w)) freezable.push(isoWeekKeyFromOrdinal(w));
  }
  return { earned_total: earnedTotal, used, balance, max: STREAK_FREEZE_MAX, freezable, protectable_week: freezable[0] ?? null };
}

// Inverse of weekOrdinal: the ISO "YYYY-Www" key for a sequential week index, so the
// freeze state can hand the client/route real week keys to store and re-parse.
function isoWeekKeyFromOrdinal(ord) {
  return isoWeekKey(new Date(ord * 7 * 86400000 + 3 * 86400000).toISOString()); // +3d → land mid-week, away from any boundary
}

// The public shareable card (opt-in social). A deliberate ALLOWLIST of non-PII
// aggregate stats — never a filtered dump of adherenceReport, so a field added
// there later can't silently leak. NO email, user_id, name, bodyweight, nutrition,
// check-ins, injuries, or raw sessions ever cross this boundary.
export function publicShareCard(user, sessions, now = new Date().toISOString()) {
  const streak = weeksConsistent(sessions, now, user.paused || null, user.pause_history || [], user.streak_freezes || []);
  const { level } = xpAndLevel(sessions);
  // sessions_this_week (#10 social — weekly race): the SAME aggregate-only allowlist
  // model as the other three fields, just resetting every week instead of all-time —
  // it's what turns the static streak/level leaderboard into a comparison with actual
  // urgency (a partner can be "ahead" only until Sunday, not forever).
  return { streak_weeks: streak, level, sessions_logged: (sessions ?? []).length, sessions_this_week: weeklySummary(sessions ?? [], now).sessions };
}

export function xpAndLevel(sessions) {
  // 100 XP per session + 5 per hard set — engagement tied to real training.
  const base = (sessions ?? []).reduce((a, s) => a + 100 + (s.sets ?? []).filter((set) => isHardSet(set)).length * 5, 0);
  // Bonus XP for personal records — the peak reward, so beating a best actually PAYS. Replay
  // PR detection in chronological order: each session is judged only against what came before
  // it (a PR is beating your PRIOR best), so the bonus banked exactly matches what that
  // session's recap celebrated at the time. Beginners PR often — an intentional early windfall
  // when adherence matters most.
  const chron = [...(sessions ?? [])].sort((a, b) => ((a.local_date ?? a.date ?? "") < (b.local_date ?? b.date ?? "") ? -1 : 1));
  let prBonus = 0;
  for (let i = 0; i < chron.length; i++) prBonus += detectPersonalRecords(chron[i], chron.slice(0, i)).length * PR_XP;
  // Lucky-set bonus — a variable-ratio reward layered on top of the fixed schedule
  // (roadmap #2's remaining slice). Deterministic per session (isLuckySet hashes the
  // session's own session_id), so this total can never drift from what the live
  // player toasted or the recap showed.
  let luckyBonus = 0;
  for (const s of sessions ?? []) luckyBonus += luckySetsInSession(s).length * LUCKY_SET_XP;
  const xp = base + prBonus + luckyBonus;
  const level = Math.floor(xp / 500) + 1;           // ~a level every ~5 sessions
  const into = xp - (level - 1) * 500;
  return { xp, level, level_progress_pct: Math.round((into / 500) * 100), xp_to_next: 500 - into, pr_xp: prBonus, lucky_xp: luckyBonus };
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

// Session count for a SPECIFIC ISO week key (e.g. "2026-W30"), not just "this
// week" — unlike weeklySummary (which always answers for the week containing
// `now`), this lets a 1v1 challenge (#10 social) be scored for its OWN target
// week even after that week has ended, with no snapshot to take and no cron to
// run: the tally is just re-derived from the same logged sessions on read.
export function sessionsInWeek(sessions, weekKey) {
  return (sessions ?? []).filter((s) => (s.local_date || s.date) && sessionWeekKey(s) === weekKey).length;
}

// The whole adherence payload for the app.
export function adherenceReport(user, sessions, now = new Date().toISOString()) {
  const paused = !!user.paused;
  const freezes = user.streak_freezes || [];
  const streak = weeksConsistent(sessions, now, user.paused || null, user.pause_history || [], freezes);
  return {
    streak_weeks: streak,
    ...xpAndLevel(sessions),
    sessions_logged: sessions.length,
    milestones: milestones(sessions.length),
    status: adherenceStatus(sessions, now, paused),
    week: weeklySummary(sessions, now),
    paused,
    streak_freeze: streakFreezeState(sessions, now, freezes, user.paused || null, user.pause_history || []),
  };
}
