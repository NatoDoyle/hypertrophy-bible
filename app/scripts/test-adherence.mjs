// Unit tests for the adherence & gamification engine (src/adherence.mjs).
import { weeksConsistent, xpAndLevel, milestones, adherenceStatus, weeklySummary, adherenceReport, streakFreezeState, trainedWeekCount, STREAK_FREEZE_MAX, publicShareCard, sessionsInWeek, settleChallenge } from "../src/adherence.mjs";
import { COMEBACK_GAP_DAYS } from "../src/coach.mjs";
import { isLuckySet, LUCKY_SET_XP, isoWeekKey, isoWeekKeyLocal } from "../../tools/derive-core.mjs";

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

// --- Streak-freeze tokens (#4 adherence): a user-HELD protection, distinct from the
// automatic single-miss forgiveness. A spent freeze neutralises a week exactly like a
// pause, so it can bridge a SECOND gap the free forgiveness already spent.
const twoGaps = [sess("2026-01-05"), sess("2026-01-19"), sess("2026-02-02")]; // W02, W04, W06 — misses W03 & W05
ok("streak-freeze: the free forgiveness bridges only ONE of two gaps (control)", weeksConsistent(twoGaps, "2026-02-04") === 2);
ok("streak-freeze: a frozen week bridges the SECOND gap (2 -> 3)", weeksConsistent(twoGaps, "2026-02-04", null, [], ["2026-W05"]) === 3);
ok("streak-freeze: freezing an already-TRAINED week never inflates the streak", weeksConsistent(twoGaps, "2026-02-04", null, [], ["2026-W04"]) === 2);
// The subtle boundary: freeze + the free forgiveness STACK to cover TWO consecutive
// misses. Trained W02 & W05, missed W03 & W04 (adjacent). Freezing W03 protects it,
// and the free token then bridges W04 (whose predecessor W03 is now neutral — the
// `inPause(w-1)` branch), so the pre-gap W02 still counts.
const twoAdjacentGaps = [sess("2026-01-05"), sess("2026-01-26")]; // W02, W05; W03 & W04 missed
ok("streak-freeze: without a freeze, two adjacent misses break the streak (control)", weeksConsistent(twoAdjacentGaps, "2026-01-28") === 1);
ok("streak-freeze: freeze one of two ADJACENT misses + forgiveness bridges the other (frozen-predecessor branch)", weeksConsistent(twoAdjacentGaps, "2026-01-28", null, [], ["2026-W03"]) === 2);
// Token economics: earn one per 4 trained weeks, hold at most STREAK_FREEZE_MAX, replenish as you spend.
const consec = (count, start = "2026-01-05") => Array.from({ length: count }, (_, i) => sess(new Date(Date.parse(start) + i * 7 * 86400000).toISOString().slice(0, 10)));
const eight = consec(8); // 8 distinct trained weeks (W02..W09)
ok("streak-freeze: trainedWeekCount counts DISTINCT trained weeks", trainedWeekCount(eight) === 8);
ok("streak-freeze: earn one token per 4 trained weeks", streakFreezeState(eight, "2026-02-25", []).earned_total === 2);
ok("streak-freeze: balance = earned - used", streakFreezeState(eight, "2026-02-25", ["2020-W01"]).balance === 1);
ok("streak-freeze: held balance is capped at the max", streakFreezeState(consec(20), new Date(Date.parse("2026-01-05") + 19 * 7 * 86400000).toISOString(), []).balance === STREAK_FREEZE_MAX);
// Protectable-week detection: a recent missed week, with a token held, is offered.
const freezeGap = [sess("2026-01-05"), sess("2026-01-12"), sess("2026-01-19"), sess("2026-01-26")]; // W02..W05 trained, miss W06, now W07
const fzState = streakFreezeState(freezeGap, "2026-02-11", []);
ok("streak-freeze: a recent missed week is protectable when a token is held", fzState.balance === 1 && !!fzState.protectable_week && fzState.freezable.includes(fzState.protectable_week));
ok("streak-freeze: the in-progress current week is never offered as protectable", !fzState.freezable.includes("2026-W07"));
ok("streak-freeze: adherenceReport surfaces the freeze wallet", adherenceReport({ streak_freezes: [] }, eight, "2026-02-25").streak_freeze.earned_total === 2);

// --- publicShareCard (#10 social): a hard PII boundary — allowlist ONLY. A user
// object stuffed with PII must yield exactly four non-identifying aggregate keys.
const pii = { email: "a@b.com", user_id: "secret-uuid", profile: { sex: "male", bodyweight: 90 }, paused: null, streak_freezes: [] };
const card = publicShareCard(pii, eight, "2026-02-25");
ok("publicShareCard exposes EXACTLY streak_weeks/level/sessions_logged/sessions_this_week", JSON.stringify(Object.keys(card).sort()) === JSON.stringify(["level", "sessions_logged", "sessions_this_week", "streak_weeks"]));
ok("publicShareCard leaks no email/user_id/profile anywhere in its output", !JSON.stringify(card).includes("secret-uuid") && !JSON.stringify(card).includes("a@b.com"));
ok("publicShareCard reports real aggregate values", card.sessions_logged === eight.length && card.level >= 1);
ok("publicShareCard sessions_this_week matches weeklySummary for the same window", card.sessions_this_week === weeklySummary(eight, "2026-02-25").sessions);

// XP + level: 3 sessions × (100 + 3 hard sets ×5) = 3×115 = 345 -> level 1
const xl = xpAndLevel(three);
ok("xp = 100/session + 5/hard-set", xl.xp === 345);
ok("level starts at 1", xl.level === 1 && xl.xp_to_next === 500 - 345);
// 5 sessions of 5 hard sets = 5×125 = 625 -> level 2
ok("levels up past 500 XP", xlLevel(5, 5) === 2);
function xlLevel(n, hard) { return xpAndLevel(Array.from({ length: n }, () => sess("2026-01-05", hard))).level; }

// Wave 81 (Goal 4): a personal record earns bonus XP — the peak reward pays.
const prS1 = { date: "2026-03-01", sets: [{ set_type: "work", exercise: "bench", weight_kg: 100, reps: 5 }] };
const prS2 = { date: "2026-03-08", sets: [{ set_type: "work", exercise: "bench", weight_kg: 105, reps: 5 }] }; // new e1rm best → PR
const xpWithPr = xpAndLevel([prS1, prS2]);
ok("a PR earns +50 bonus XP on top of the base", xpWithPr.xp === 210 + 50 && xpWithPr.pr_xp === 50);
ok("no PR (identical repeat) earns no bonus XP", xpAndLevel([prS1, { ...prS1, date: "2026-03-15" }]).pr_xp === 0);

// Roadmap #2's remaining slice: a "lucky set" variable-ratio bonus on top of the
// fixed schedule. Brute-force a session_id where the exercise's first hard set is
// known-lucky so the test doesn't depend on a specific hash implementation detail
// beyond isLuckySet itself (the single source of truth adherence.mjs also reads).
let luckySid = null;
for (let i = 0; i < 1000; i++) if (isLuckySet(`lucky-${i}`, "squat", 0)) { luckySid = `lucky-${i}`; break; }
const luckySession = { date: "2026-04-01", session_id: luckySid, sets: [{ exercise: "squat", set_type: "work", weight_kg: 100, reps: 5 }] };
const xlLucky = xpAndLevel([luckySession]);
ok("a lucky set earns +LUCKY_SET_XP on top of the base 100+5", xlLucky.xp === 105 + LUCKY_SET_XP && xlLucky.lucky_xp === LUCKY_SET_XP);
// same session_id but no exercise history (no session_id at all) never triggers luck
ok("without a session_id, no set can ever be lucky (legacy sessions unaffected)",
  xpAndLevel([{ ...luckySession, session_id: undefined }]).lucky_xp === 0);
ok("a warm-up set is never lucky even under a known-lucky seed/index",
  xpAndLevel([{ date: "2026-04-01", session_id: luckySid, sets: [{ exercise: "squat", set_type: "warmup", weight_kg: 100, reps: 5 }] }]).lucky_xp === 0);

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

// --- sessionsInWeek (#10 social — 1v1 weekly challenges): unlike weeklySummary,
// scores a SPECIFIC week key, not just the week containing `now` — so a
// challenge can be scored for its own target week even long after it ended.
{
  const w1 = isoWeekKey("2026-01-05"), w2 = isoWeekKey("2026-01-19");
  const sessions = [sess("2026-01-05"), sess("2026-01-06"), sess("2026-01-19")];
  ok("sessionsInWeek counts only sessions matching the given week key", sessionsInWeek(sessions, w1) === 2);
  ok("sessionsInWeek scores a different week independently", sessionsInWeek(sessions, w2) === 1);
  ok("sessionsInWeek is 0 for a week with no sessions", sessionsInWeek(sessions, isoWeekKey("2026-02-02")) === 0);
  ok("sessionsInWeek treats a missing sessions array as empty", sessionsInWeek(undefined, w1) === 0);
}

// --- settleChallenge (#10 social): a call whose own write LOSES a race must
// never report a `result` it didn't actually persist. The push sweep and a
// user's own GET /api/challenge can both call settleChallenge for the same
// challenge in the same tick (the sweep iterates many users while a request
// can land concurrently); whichever call's updateUser mutator finds the
// challenge ALREADY terminal must treat itself as a no-op, not as having just
// completed it with its own (possibly stale) locally-recomputed counts.
{
  const persistedChallenge = { id: "c1", status: "completed", partner_token: "tok-opp", week: "2020-W01" };
  const persistedHistory = [{ week: "2020-W01", result: "win", my_count: 5, opponent_count: 3 }];
  const raceLostStore = {
    async getShareUserId() { return "opponent-id"; },
    async listSessions() { return []; }, // this call's own (stale) reads see 0-0, NOT 5-3
    async updateUser(id, mutator) {
      // The row is already in the terminal state a concurrent writer landed first.
      const cur = { profile: { challenge: { ...persistedChallenge }, challenge_history: [...persistedHistory] } };
      return mutator(cur);
    },
  };
  const staleUser = { profile: { challenge: { id: "c1", status: "active", partner_token: "tok-opp", week: "2020-W01" } } };
  const lost = await settleChallenge(raceLostStore, "me", staleUser, Date.now());
  // The bug (pre-fix): this call's own listSessions reads (0-0, stale relative to
  // the winner's already-persisted 5-3) got wrapped into a fabricated `result`
  // (a "tie 0-0") purely because the post-write status happened to match this
  // call's own locally-computed nextStatus — even though its mutator no-op'd.
  // push.mjs sends a push built directly from `settled.result`, so this would
  // have notified the user of a score that disagrees with `challenge_history`.
  ok("settleChallenge: a raced no-op write never fabricates a result", lost.result === null);

  // Control: when this call's own write genuinely performs the transition (no
  // race), it correctly reports the result it just persisted.
  const store = { users: { me: { profile: { challenge: { id: "c2", status: "active", partner_token: "tok-opp", week: "2020-W01" } } } } };
  const wonStore = {
    async getShareUserId() { return "opponent-id"; },
    async listSessions(id) { return id === "me" ? [sess("2020-01-01"), sess("2020-01-02")] : [sess("2020-01-01")]; },
    async updateUser(id, mutator) { store.users[id] = mutator(JSON.parse(JSON.stringify(store.users[id]))); return store.users[id]; },
  };
  const freshUser = { profile: { challenge: { id: "c2", status: "active", partner_token: "tok-opp", week: "2020-W01" } } };
  const won = await settleChallenge(wonStore, "me", freshUser, Date.now());
  ok("settleChallenge: a genuine (unraced) write reports the result it actually persisted",
    won.result?.result === "win" && won.history[0]?.result === "win");
}

// --- settleChallenge (tz bug): a raw-UTC week_over check can end a west-of-UTC
// user's challenge up to a day before their OWN local week is actually over —
// the same class of bug PR #238 fixed for the weekly-commitment push, now fixed
// here via isoWeekKeyLocal (tools/derive-core.mjs), shared by app.mjs's
// propose/respond/isChallengeOpen checks and the commitment feature too.
{
  // 2026-06-01 is a Monday. 02:00 UTC on that Monday is 19:00 the PRIOR Sunday
  // for a -420 (UTC-7) offset — the raw UTC calendar day has already rolled to
  // Monday, but it's still Sunday, and still the OLD ISO week, for the user.
  const MONDAY_EARLY_UTC = new Date("2026-06-01T02:00:00Z").getTime();
  const MOUNTAIN = -420;
  const localWeek = isoWeekKeyLocal(MONDAY_EARLY_UTC, MOUNTAIN);
  ok("sanity: at this instant, raw UTC already disagrees with the user's local week (the case this test guards)",
    isoWeekKey(new Date(MONDAY_EARLY_UTC).toISOString()) !== localWeek);

  const tzStore = {
    async getShareUserId() { return "opponent-id"; },
    async listSessions() { return []; },
    async updateUser(id, mutator) {
      const cur = { profile: { challenge: { id: "c3", status: "active", partner_token: "tok-opp", week: localWeek }, tz_offset_min: MOUNTAIN } };
      return mutator(cur);
    },
  };
  const tzUser = { profile: { challenge: { id: "c3", status: "active", partner_token: "tok-opp", week: localWeek }, tz_offset_min: MOUNTAIN } };
  const stillRunning = await settleChallenge(tzStore, "me", tzUser, MONDAY_EARLY_UTC);
  ok("settleChallenge: a west-of-UTC user's challenge stays open while it's still their OWN local week, even though the raw UTC instant already rolled to the next calendar week",
    stillRunning.week_over === false && stillRunning.challenge.status === "active" && stillRunning.result === null);

  // Control: the SAME instant, with no tz_offset_min on the CALLING user, falls
  // back to raw UTC (matching push.mjs's own "don't starve delivery over
  // missing data" convention) — so it DOES read as week-over, proving the
  // assertion above is meaningful and not just "week_over is always false".
  const noTzUser = { profile: { challenge: { id: "c3", status: "active", partner_token: "tok-opp", week: localWeek } } };
  const noTzResult = await settleChallenge(tzStore, "me", noTzUser, MONDAY_EARLY_UTC);
  ok("control: without a stored tz_offset_min, the same instant falls back to raw UTC and DOES read as week-over",
    noTzResult.week_over === true);
}

console.log(`\n${pass} adherence test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
