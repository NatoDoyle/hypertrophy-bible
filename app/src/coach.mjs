// The coach: decides today's session and prefills every weight, so the user just
// confirms and taps Done. Reuses the KB's derive-core engine for all derivations.
import {
  perMuscleWeeklyVolume, volumeVsLandmarks, progressionByExercise,
  bodyweightTrend, classifyEnergyBalance, proximityFromRepDropoff, stallDetect, volumeResponse,
  deriveVolumeAdjust, recoverySignal, progressionCadence, adaptiveStallWindow, isoWeekKeyLocal, sessionWeekKey, peakWeeklyVolume,
  detectPersonalRecords, priorPersonalBests, PR_XP, allPersonalRecords, luckySetsInSession, LUCKY_SET_XP,
  interferenceSignal, regressionDetect, trainedWeeksInBlock, effortSignal, restSeconds, loadForReps, repTargets, priorOverlapSets, orderLoss, contextLoad, ORDER_MIN_DELTA_SETS, completionShortfall, graduatedStatus, WEEK_DAY_KEYS, weekDayKey, commitmentForDay, sessionDayKey, localDayKey, shiftDayKey } from "../../tools/derive-core.mjs";
import { exIndex, muscleIndex, exerciseById, exerciseName, muscleById, guidelineById } from "./kb.mjs";
import { isSpecializing, generateUserPlan, userExercises, userApplySubstitution, injuryRegionFor } from "./planner.mjs";

const parseRange = (s) => {
  const m = String(s ?? "8-12").match(/(\d+)\s*-\s*(\d+)/);
  return m ? { min: +m[1], max: +m[2] } : { min: 8, max: 12 };
};
const loadIncrement = (exId, byId = exerciseById) => {
  const e = byId.get(exId);
  if (!e) return 2.5;
  if (e.mechanic === "isolation" && (e.equipment === "dumbbell" || e.equipment === "cable")) return 1;
  return 2.5;
};

// Lookups augmented with a user's custom exercises (or the globals when there are
// none), so custom moves resolve everywhere: Today, recap, progress, volume.
function resolveEx(customEx) {
  if (!customEx || !customEx.length) return { byId: exerciseById, index: exIndex, name: exerciseName };
  const byId = new Map(exerciseById), index = new Map(exIndex);
  for (const e of customEx) {
    byId.set(e.id, e);
    index.set(e.id, { name: e.name, primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] });
  }
  return { byId, index, name: (id) => byId.get(id)?.name ?? id };
}

// All working sets of an exercise from a flat list of sessions, newest last.
const workingSetsFor = (sessions, exId) =>
  sessions.flatMap((s) => (s.sets ?? []).filter((set) => set.exercise === exId && (set.set_type ?? "work") === "work"));

// The most recent session that contained this exercise, with its date (for
// progression + layoff detection). Returns { sets, date } or null.
function lastSetsForExercise(sessions, exId) {
  return recentWorkSets(sessions, exId, 1)[0] ?? null;
}
// The anchor of one session's sets for a lift: the heaviest weight with a set at or above
// `min` (proved in the range), else set 1's weight; `judged` = the sets AT that weight,
// `first` = the freshest of them. See suggestWeight.
function anchorOf(sets, min) {
  const proved = sets.filter((s) => s.reps >= min).map((s) => s.weight_kg ?? 0);
  const weight = proved.length ? Math.max(...proved) : (sets[0].weight_kg ?? 0);
  const judged = sets.filter((s) => (s.weight_kg ?? 0) === weight);
  return { weight, judged, first: judged[0] };
}
// The bottom of the range a past session was DONE in — its stored target (W280) when it
// has one, else today's range (older sessions).
const ownMin = (entry, repRange) => parseRange(entry.target?.rep_range ?? repRange).min;

// The last `k` sessions holding non-deload WORK sets for this lift, newest first — the
// anchor and, for W279's two-strike rule, the one before it.
function recentWorkSets(sessions, exId, k) {
  const out = [];
  for (let i = sessions.length - 1; i >= 0 && out.length < k; i--) {
    // Deload sets are planned-easy — anchoring double progression to them would
    // leave every next block permanently one increment behind. Skip them.
    const sets = (sessions[i].sets ?? []).filter((s) => s.exercise === exId && (s.set_type ?? "work") === "work" && !s.deload);
    if (sets.length) out.push({ sets, date: sessions[i].date ?? null, target: (sessions[i].targets ?? []).find((t) => t.exercise === exId) ?? null, name: sessions[i].session_name ?? null });
  }
  return out;
}

// The most recent date this exercise was trained AT ALL — deload/comeback
// sessions included, because a comeback session is still training. Layoff
// detection must anchor here: anchoring on the last NON-deload session made the
// session after a comeback re-fire the ease from the pre-layoff date with false
// "It's been N days" copy, and those re-eased sets logged untagged into the
// e1RM trend (the exact fabricated strength loss the tagging exists to prevent).
function lastAnyDateForExercise(sessions, exId) {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if ((sessions[i].sets ?? []).some((s) => s.exercise === exId && (s.set_type ?? "work") === "work")) return sessions[i].date ?? null;
  }
  return null;
}

// A gap this long since an exercise was last trained triggers a deload on return —
// coming back heavier than you left is how people get hurt after a layoff.
// EXPORTED because the adherence engine's "welcome back — I've eased your weights"
// message must fire at exactly the same threshold; a hardcoded copy drifted once
// (10 vs 12 days) and the app promised eased weights while prescribing heavier.
export const COMEBACK_GAP_DAYS = 12;
const COMEBACK_DELOAD = 0.88; // ease ~12% and let it climb back as it feels easy

// Rough BODY-SCALED starting guess for a lift the user has never logged, so a
// non-beginner sees a plausible number to confirm/adjust instead of an empty bar
// (roadmap #4's last slice). True beginners keep the safe empty-bar default
// (app.js's startWeightDefault) — they haven't trained enough yet to judge whether
// a body-scaled guess fits them. Deliberately erred light and rounded DOWN to the
// exercise's own load increment: a fast climb over the first couple of sets is
// safe, a heavy first guess risks form breakdown before the ramp-up card's "start
// light, add a little each set" advice even lands. Patterns/equipment with no
// sane bodyweight ratio (carries, unmapped "other", bands) return null and fall
// back to the same empty-bar default.
const PATTERN_BW_RATIO = {
  squat: 0.5, hinge: 0.6, lunge: 0.2,
  "horizontal-push": 0.45, "vertical-push": 0.3,
  "horizontal-pull": 0.4, "vertical-pull": 0.4,
};
const ISOLATION_BW_RATIO = 0.1;
const EQUIPMENT_LOAD_SCALE = { barbell: 1, "smith-machine": 1, machine: 0.9, cable: 0.7, kettlebell: 0.6, dumbbell: 0.45 };
export function estimateStartingWeight(e, bodyweightKg, exId, byId = exerciseById) {
  if (!e || !(bodyweightKg > 0) || e.equipment === "bodyweight") return null;
  const ratio = e.movement_pattern?.startsWith("isolation-") ? ISOLATION_BW_RATIO : PATTERN_BW_RATIO[e.movement_pattern];
  const eqScale = EQUIPMENT_LOAD_SCALE[e.equipment];
  if (ratio == null || eqScale == null) return null;
  const inc = loadIncrement(exId, byId);
  const rounded = Math.floor((bodyweightKg * ratio * eqScale) / inc) * inc;
  // A barbell can't weigh less than the bar (W283 review: the barbell Jefferson curl's guess was
  // 7.5 kg at 80 kg bodyweight) — the empty bar is the first guess, as its own steps say.
  if (e.equipment === "barbell") return Math.max(rounded, EMPTY_BAR_KG);
  return rounded > 0 ? rounded : inc;
}
const EMPTY_BAR_KG = 20;

// THE STORED-PLAN SCREEN (W283 review). A plan is generated against the rules of its day; a rule
// can tighten afterwards (W283 excluded the Jefferson curl for a lower back) or an exercise can
// change kit (it became a barbell lift). Every lift the user's CURRENT pool rejects — injuries,
// equipment, lifts marked unavailable (their own custom exercises are always theirs) — is swapped
// through the permanent-swap door (applySubstitution), on a generated plan and a hand-built one
// alike: an injury the user reported outranks a hand edit. Null when nothing needs it; a lift
// with no fitting replacement stays, reported in `kept`.
export function screenPlan(user, sessions, nowISO) {
  const program = user.program;
  if (!program?.sessions?.length) return null;
  const pool = new Set(userExercises(user.profile, user.custom_exercises || []).map((e) => e.id));
  const out = [...new Set(program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)))].filter((id) => !pool.has(id));
  if (!out.length) return null;
  const stalled = swapStalls(user, sessions, nowISO);
  let cur = user;
  const swaps = [], kept = [];
  for (const id of out) {
    const r = userApplySubstitution(cur, id, { stalled });
    if (r.error) { kept.push(id); continue; }
    cur = { ...cur, program: r.program, plan_rationale: r.rationale };
    const region = injuryRegionFor(user.profile, id);
    swaps.push({ from: id, to: r.replaced_by ?? null, reason: region ? "injury" : "equipment", ...(region ? { region } : {}) });
  }
  return { program: cur.program, rationale: cur.plan_rationale, swaps, kept };
}
// The screen's one-time word on Today (until a session is logged after it).
function swapNoteFor(swaps, name) {
  return swaps.map((w) => `I swapped your ${name(w.from)} for ${w.to ? name(w.to) : "another lift"} — ${w.reason === "injury"
    ? `it's one of the lifts I keep away from your ${String(w.region).replace(/-/g, " ")}`
    : "it needs equipment that isn't in your kit"}.`).join(" ");
}

// Double progression: hit the top of the range on every set last time -> add load;
// otherwise keep the load and aim to add reps. First time -> no suggestion (user picks).
// `now` (ISO) enables layoff-aware deloading so the "I eased your weights" copy is true.
// `holdLoad` (taper): suppress BOTH progression bumps (RIR-surplus and hit-top-of-
// range) so the numbers actually match the taper card's "the weight stays where it
// is" — chasing a PR into an event contradicts the freshness the taper exists to
// buy. The layoff-comeback ease still overrides (safety first; buildToday makes
// the taper copy honest about it), and the failure/hold paths are unchanged.
export function suggestWeight(sessions, exId, repRange, byId = exerciseById, now = null, prescribedRir = null, holdLoad = false) {
  const last = lastSetsForExercise(sessions, exId);
  const { min, max } = parseRange(repRange);
  if (!last) return { suggested_kg: null, note: "First time — pick a weight where the last rep is ~2–3 reps from failure." };
  // THE ANCHOR is the heaviest weight PROVED in the range — a set that reached the bottom of
  // the range that session was done in (its stored target; else today's) — and set 1's
  // weight when nothing reached it (Burst 1 review). Set-1 anchoring punished following
  // the player's own "go heavier" hint (W279b): 60×14 then the hinted 62.5×10,10 suggested
  // 60 next time. A heavier set that FAILED the range (a one-off heavy single) never anchors,
  // and a lighter back-off is still a different load, never evidence (C14). Reps/RIR are
  // judged only over the sets AT the anchor weight. Straight sets are byte-identical.
  const anchor = anchorOf(last.sets, ownMin(last, repRange));
  const lastWeight = anchor.weight;
  const judged = anchor.judged;
  const allHitTop = judged.every((s) => s.reps >= max);
  const base = { last_kg: lastWeight, last_reps: judged.map((s) => s.reps), last_sets: last.sets.map((s) => [s.weight_kg ?? 0, s.reps]) };
  // Layoff deload: if it's been a while, ease the load and suppress the progression
  // bump — overrides everything below so a comeback never loads heavier than before.
  // Measured from the last time the exercise was trained AT ALL (comeback/deload
  // sessions count as training); the progression ANCHOR stays on non-deload sets.
  const lastAny = lastAnyDateForExercise(sessions, exId);
  const layoffDays = now && lastAny ? Math.round((+new Date(now) - +new Date(lastAny)) / 86400000) : 0;
  if (layoffDays >= COMEBACK_GAP_DAYS) {
    const eased = Math.round(lastWeight * COMEBACK_DELOAD * 4) / 4;
    return { suggested_kg: eased, note: `It's been ${layoffDays} days — I eased this to ${eased} kg so you ramp back in safely. Add load as it feels easy.`, layoff_days: layoffDays, ...base };
  }
  // RIR autoregulation (only when effort was logged): MORE left in the tank than
  // the prescription asked for -> go up. The threshold is relative to the
  // prescribed band's top (default 2 -> bump at 3, the historical behavior):
  // a week-1 lifter told "3-4 RIR" who complies at 3.5 is following the eased
  // wave, not sandbagging — bumping their load would undo the easy week.
  const rirs = judged.map((s) => s.rir).filter((r) => typeof r === "number");
  const band = /(\d+)\s*-\s*(\d+)/.exec(prescribedRir ?? "");
  const avgRir = rirs.length ? rirs.reduce((a, b) => a + b, 0) / rirs.length : null;
  if (rirs.length) {
    const bandTop = band ? +band[2] : 2;
    if (!holdLoad && avgRir >= bandTop + 1) {
      const inc = loadIncrement(exId, byId) * (avgRir >= bandTop + 2 ? 2 : 1);
      return { suggested_kg: Math.round((lastWeight + inc) * 4) / 4, note: `You left ~${Math.round(avgRir)} reps in reserve last time — add ${inc} kg.`, ...base };
    }
  }
  // BELOW THE RANGE (W279, the owner's call): the KB's own double-progression rule is "pick
  // a weight you can do for at least the bottom of the range" (how-to-read-a-workout.md,
  // Grade D). Judged on set 1 — the freshest, so a later set's fatigue drop-off is not
  // evidence — and only when it was near failure (RIR unlogged or ≤ 1: a set stopped early
  // wasn't too heavy). Two reps short eases now; one short holds once, then eases if it
  // repeats at the same or a heavier weight. The new load is the Epley e1RM of set 1 carried
  // to the bottom of the range at the band's near edge, floored to the lift's increment,
  // at least one increment down and at most ~20% (one set is not a re-test). Never during a
  // taper (its loads hold); never tagged as a comeback, so the eased load anchors normally.
  // Fires only when NO set at the anchor reached today's range (a set that did means the
  // weight works — the rest is fatigue or a slip, not evidence), judged on the freshest of
  // them. Today's range, so a heavy-day load is converted for a lighter-day range too; the
  // two-strike lookback judges the previous session against the range IT was done in, so a
  // set that met its own range is never a strike (Burst 1 review).
  const s1 = anchor.first;
  const s1Rir = typeof s1.rir === "number" ? s1.rir : null;
  if (!holdLoad && lastWeight > 0 && judged.every((s) => s.reps < min) && (s1Rir == null || s1Rir <= 1)) {
    const prev = recentWorkSets(sessions, exId, 2)[1];
    const prevA = prev ? anchorOf(prev.sets, ownMin(prev, repRange)) : null;
    const prevUnder = !!prevA && prevA.weight >= lastWeight && prevA.first.reps < ownMin(prev, repRange);
    if (min - s1.reps >= 2 || prevUnder) {
      const inc = loadIncrement(exId, byId);
      const near = band ? +band[1] : 1;
      const raw = loadForReps(lastWeight, s1.reps, s1Rir ?? 0, min, near);
      const floored = Math.floor(raw / inc + 1e-9) * inc;
      const lowest = Math.ceil((lastWeight * 0.8) / inc - 1e-9) * inc;
      const eased = Math.round(Math.min(lastWeight - inc, Math.max(lowest, floored)) * 4) / 4;
      // The model aims the FIRST set at the range's bottom, so that is all the copy promises —
      // and when the ~20% cap binds, not even that.
      const tail = floored < lowest ? " (as far as I'll drop it in one go)." : " — your first set should land in the range.";
      if (eased > 0) return { suggested_kg: eased, note: `Your first set at ${lastWeight} kg came in at ${s1.reps} — under the ${min}–${max} range — so I've lightened this to ${eased} kg${tail}`, ...base };
    } else {
      return { suggested_kg: lastWeight, note: `Just under the range last time (${s1.reps}; it starts at ${min}) — keep the weight. If it happens again, I'll lighten it.`, ...base };
    }
  }
  if (rirs.length && avgRir <= 0 && !allHitTop) return { suggested_kg: lastWeight, note: "You hit failure last time — keep the weight and build reps first.", ...base };
  if (allHitTop) {
    if (holdLoad) return { suggested_kg: lastWeight, note: "Taper — hold this weight. You'd normally add load here; save that push for after the event.", ...base };
    // Every PRESCRIBED set at the top earns the bump (W280, the owner's call: "hold until
    // every set is done") — a skipped set or a workout ended early didn't show it. Read from
    // the anchor session's stored target; a session without one (older builds) is unchanged.
    const planned = last.target && !last.target.deload ? last.target.sets : null;
    if (Number.isInteger(planned) && last.sets.length < planned) {
      return { suggested_kg: lastWeight, note: `You did ${last.sets.length} of ${planned} sets last time — get all ${planned} to the top of the range, then I'll add weight.`, ...base };
    }
    return { suggested_kg: Math.round((lastWeight + loadIncrement(exId, byId)) * 4) / 4, note: `Last time you hit the top of the range — add ${loadIncrement(exId, byId)} kg.`, ...base };
  }
  return { suggested_kg: lastWeight, note: "Keep the weight and try to add a rep or two.", ...base };
}

// Which program session is due today (simple rotation by sessions completed).
export function nextSessionIndex(program, sessionCount) {
  const n = program.sessions.length;
  return ((sessionCount % n) + n) % n;
}

// Exported so the swap ROUTE starts its write from the same validity predicate
// this file reads with — two slightly different "is this map live?" checks would
// let a map one side honors and the other ignores slip between them (lesson 1).
export const isPermutation = (map, n) =>
  Array.isArray(map) && map.length === n && new Set(map).size === n && map.every((v) => Number.isInteger(v) && v >= 0 && v < n);

// THE rotation pointer — the single source of truth for "which program session is
// due" (lesson 1: buildToday, todayCard, and the skip/swap routes all read this;
// two copies of the offset math would let the card and the served session drift).
// On top of the base rotation (own-program session count minus rotation_base):
//   - `plan_meta.rotation_skips` — user skips; each advances the pointer one slot
//     without a logged session. Program-agnostic on purpose: a brand-new user with
//     zero sessions can skip Day A and must see Day B.
//   - `plan_meta.cycle_swap` — `{ program, cycle, map }`, a user-made permutation
//     of THIS cycle's day order ("do Legs today; Push takes its old slot").
//     Honored only while the program id and cycle number still match and `map` is
//     a real permutation of the current day count — anything else (regenerated
//     plan, rolled-over cycle, edited day list) makes it self-expire, never error.
// Both fields die whenever plan_meta is rebuilt wholesale (block boundary,
// graduation, training-change regenerate) — the rebase to Day A is their intended
// expiry, not a leak.
export function rotationState(program, sessions, planMeta) {
  const n = program.sessions.length;
  const effCount = rotationCount(ownSessionCount(program, sessions), planMeta);
  return { n, effCount, ...rotationAt(program, planMeta, effCount) };
}

// THE pointer's count, in one place: own-program sessions past the rebase (clamped at
// zero — a void of an older workout can drop the count below `rotation_base`), plus the
// user's skips. The projection feeds it `own + j` rather than adding j after the clamp,
// so a clamped pointer's repeat shows in the week strip exactly as Today will serve it.
const ownSessionCount = (program, sessions) => sessions.filter((s) => !s.program_ref || s.program_ref === program.id).length;
const rotationCount = (own, planMeta) => Math.max(0, own - (planMeta?.rotation_base ?? 0)) + Math.max(0, planMeta?.rotation_skips ?? 0);

// ONE slot of the rotation: the cycle `effCount` falls in, and that cycle's day swap
// only if the map was made for THAT cycle. Shared by the pointer (slot 0) and the week
// strip's projection (slots ahead), so a projected day can never name a different
// session than the one Today will serve (lesson 1).
function rotationAt(program, planMeta, effCount) {
  const n = program.sessions.length;
  const cycle = Math.floor(effCount / n);
  const rawIdx = effCount % n;
  const sw = planMeta?.cycle_swap;
  const map = sw && sw.program === program.id && sw.cycle === cycle && isPermutation(sw.map, n) ? sw.map : null;
  return { cycle, rawIdx, idx: map ? map[rawIdx] : rawIdx };
}

// The next k sessions the rotation will serve, in order (C16, W277): slot 0 is the
// pointer itself, slot j is what Today serves after j more sessions (or skips). The
// rotation stays the training truth — a missed day never drops a session — and the
// week strip only SHOWS where it lands on the committed days.
export function upcomingSessions(program, sessions, planMeta, k) {
  if (!program?.sessions?.length) return [];
  const own = ownSessionCount(program, sessions);
  return Array.from({ length: Math.max(0, k) }, (_, j) => rotationAt(program, planMeta, rotationCount(own + j, planMeta)).idx);
}

// The reassurance threshold for the missed-a-day note: a gap long enough to be a
// real miss for THIS schedule, not a routine rest gap. A 2-day/week lifter sits
// 3-4 days between sessions by design — flagging that as "missed" would read as
// nagging, the exact opposite of the note's job. Always below COMEBACK_GAP_DAYS,
// where the comeback ease owns the card with its own copy.
export const gentleGapDays = (dpw) => Math.max(4, Math.ceil(7 / Math.max(1, dpw || 3)) + 2);

// ---------------------------------------------------------------------------
// The mesocycle: the KB's volume wave (volume-progression-and-deloads.md) made
// real. Weeks 1-5 ramp set volume from ~70% toward the plan's generated target.
// That target is MRV-TRIMMED, which is not the same as being AT MRV — an
// intermediate's is mav.min — so the ramp peaks at the plan's target, not at the
// recoverable ceiling the KB's own wave table describes. That's deliberate
// (plan-core's targetWeeklySets explains why summed mid-MAV targets are
// undeliverable in a typical week) and the adaptive tune walks the target up from
// the user's own evidence instead; this comment used to claim the ceiling outright.
// week 6 is a deload — roughly half volume on the multi-set lifts (the 2-set
// floor means short 2-day programs cut less set-wise and deload mostly through
// the ~10% load ease + RIR 3-4; measured Wave 261: median weekly cut 31%,
// 2-day plans ~11%), comfortably shy of failure — then the next block starts
// automatically. Beginners are exempt: that is THIS APP'S design choice (double
// progression carries a novice a long way, and their UX stays maximally
// simple), grounded in the KB's "beginners estimate RIR poorly — simple double
// progression is often better" (periodization-and-progression.md) and its
// beginner carve-out on the wave page; the KB pages don't prescribe the
// exemption outright, so don't cite them as if they did (C9, Wave 261).
// ---------------------------------------------------------------------------
export const BLOCK_WEEKS = 6;
const BLOCK_SET_SCALE = [0.7, 0.8, 0.9, 1.0, 1.0, 0.5]; // w1..w5 build->peak, w6 deload
// The wave's average, so "the sets the plan delivers" reads ~1.0 for someone who does every
// one (consideration #1's completion test — completionFor below).
const BLOCK_MEAN_SCALE = BLOCK_SET_SCALE.reduce((a, b) => a + b, 0) / BLOCK_SET_SCALE.length;
// Consideration #1's ONE sample, read identically by the block-boundary tune and the Progress
// card: the muscles getting well under the sets the plan already delivers. A hand-built plan's
// stored rationale may not describe it, so it is never judged (permissive, as before).
// The week in progress (`now`'s local ISO week) is never judged, and only the current plan's
// weeks count (from its block's start — a training change resets it).
const weekOf = (iso, tz) => (iso ? isoWeekKeyLocal(iso, tz) : null);
function completionFor(weekly, user, now = null, tz = user?.profile?.tz_offset_min ?? null) {
  if (user?.program?.custom) return {};
  const beginner = (user?.profile?.training_status ?? "beginner") === "beginner";
  return completionShortfall(weekly, user?.plan_rationale?.volume_by_muscle, { meanScale: beginner ? 1 : BLOCK_MEAN_SCALE, excludeWeek: weekOf(now, tz), sinceWeek: weekOf(user?.plan_meta?.block_start, tz) });
}
// Plain-English muscle names for every sentence the server writes (W282) — the Progress tab's
// own words ("back (lats)", "front of shoulders"), never the anatomy ("Latissimus Dorsi"). A
// copy of the client's map (ui-helpers MUSCLE_LABEL), pinned equal by test-ui-helpers.
export const MUSCLE_PLAIN = {
  "front-delts": "front of shoulders", "side-delts": "shoulders (side)", "rear-delts": "rear shoulders",
  "lats": "back (lats)", "upper-back": "upper back", "spinal-erectors": "lower back",
  "quadriceps": "thighs (quads)", "hamstrings": "hamstrings", "glutes": "glutes", "calves": "calves",
  "biceps": "biceps", "triceps": "triceps", "forearms": "forearms", "chest": "chest", "abs": "abs", "neck": "neck",
};
const plainMuscle = (m) => MUSCLE_PLAIN[m] ?? String(m).replace(/-/g, " ");
// "a", "a and b", "a, b and c", "a, b, c and 2 more" — a sentence never carries a roll call.
const listJoin = (xs, max = 3) => {
  const shown = xs.slice(0, max), more = xs.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length <= 2 ? shown.join(" and ") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
};
// `trainedWeeks` = completed TRAINED weeks since block_start (derive-core's
// trainedWeeksInBlock), not calendar weeks. See that function for why: a wall-clock
// mesocycle handed a phantom "Week 6 — deload" to someone who trained twice in six
// weeks, and could put "peak volume — push hard" on the same card as a comeback ease.
export function blockPhase(trainedWeeks, experience) {
  if (experience === "beginner") return null;
  if (!Number.isFinite(trainedWeeks) || trainedWeeks < 0) return null;
  const week = (Math.floor(trainedWeeks) % BLOCK_WEEKS) + 1; // 1..6, cycles forever
  const phase = week === BLOCK_WEEKS ? "deload" : week >= 4 ? "peak" : "build";
  return {
    week, of: BLOCK_WEEKS, phase,
    setScale: BLOCK_SET_SCALE[week - 1],
    note: phase === "deload"
      ? `Deload week — the big lifts drop to about half their sets, loads ease off, and you stop 3–4 reps shy of failure. Recovery is where the growth you've built this block shows up.`
      : phase === "peak"
        ? `Week ${week} of ${BLOCK_WEEKS} — peak volume. Push your sets hard (1–2 in the tank); the deload is coming.`
        : week === 1
          ? `Week 1 of ${BLOCK_WEEKS} — building. Start comfortably: an extra rep in the tank this week; volume and effort both ramp from here.`
          : `Week ${week} of ${BLOCK_WEEKS} — building. Volume and effort ramp up each week toward your peak.`,
  };
}

// The KB wave creeps EFFORT alongside volume (volume-progression-and-deloads.md:
// W1 ~2-3 RIR → build weeks creep toward ~0-1 → peak "hard, near failure" →
// deload 3-4). Derived from the PLAN's own band so every goal and exercise
// class keeps its identity: week 1 backs off by one rep; weeks 4-5 pull the far
// edge to within one rep of the near edge. The near edge itself never moves —
// the proximity-to-failure page keeps heavy compounds shy of failure (Grade C),
// so a "1-3" compound peaks at "1-2", never "0-x". Deload is handled separately.
export function waveRir(band, week) {
  const m = /^(\d+)-(\d+)$/.exec(band ?? "");
  if (!m) return band;
  const lo = +m[1], hi = +m[2];
  if (week === 1) return `${lo + 1}-${Math.min(hi + 1, lo + 2)}`;
  if (week >= 4 && hi > lo + 1) return `${lo}-${lo + 1}`;
  return band;
}

// Tapering toward a goal event: when a user sets one (a meet, a show, a
// strength test), the closing ~2 weeks trade volume for freshness — strength/
// skill EXPRESSION on the day, distinct from the hypertrophy stimulus the rest
// of the plan chases (periodization-and-progression.md covers the general
// periodization picture). Date-driven, not cyclical, so it OVERRIDES the
// mesocycle wave above in buildToday rather than compounding with it — a
// scheduled deload landing in the same week as a taper would double-cut
// volume for no reason. Intensity (load) is deliberately left alone here,
// unlike a real deload: a taper's whole point is staying strong while doing
// less, so only set count and how close to failure you go come down.
const TAPER_WINDOW_DAYS = 14;
export function taperPhase(now, goalEventDate, experience, tzOffsetMin = null) {
  if (experience === "beginner" || !now || !goalEventDate) return null;
  // Day-granular, in the USER'S local frame. `now` is a full UTC instant while
  // goal_event_date is a calendar date ("YYYY-MM-DD" parses as UTC midnight), so
  // the old instant-subtraction + floor made the taper VANISH on event day (the
  // negative fraction floored to -1 → "peak volume, push hard" on meet morning)
  // and lagged the countdown by a day for most of each UTC day — worst west of
  // UTC, where a Friday-evening session already read as Saturday. Shift `now` to
  // the user's local date first (tz_offset_min = minutes EAST of UTC, the same
  // convention isUserPushHour uses; absent → UTC date), then compare CALENDAR
  // DATES: an exact integer, 0 on the event day itself (the taper holds through
  // the day of the event, never flips back to the mesocycle wave).
  const localMs = +new Date(now) + (Number.isFinite(tzOffsetMin) ? tzOffsetMin * 60000 : 0);
  if (!Number.isFinite(localMs)) return null;
  const todayLocal = new Date(localMs).toISOString().slice(0, 10);
  const daysUntil = Math.round((+new Date(goalEventDate) - +new Date(todayLocal)) / 86400000);
  if (!Number.isFinite(daysUntil) || daysUntil < 0 || daysUntil > TAPER_WINDOW_DAYS) return null;
  const early = daysUntil > 7;
  return {
    daysUntil,
    phase: "taper",
    setScale: early ? 0.6 : 0.4,
    rirFloor: early ? 2 : 3,
    // The carb-load line only appears in the FINAL week (not the early taper) — it's
    // "peak week" advice, and stacking it onto the 2-week-out note would answer a
    // question the user isn't asking yet. Grounded in periodization-and-progression.md
    // (Henselmans 2022): unlike an endurance event, a single lift/session isn't
    // reliably glycogen-limited, so there's no evidence-based reason to carb-load.
    note: early
      ? `${daysUntil} days to go — taper starting. Sets drop from here so you're fresh for it; the weight stays where it is.`
      : `${daysUntil} day${daysUntil === 1 ? "" : "s"} to go — final taper. Sets are cut hard, but the weight stays real. This is what makes you feel strong on the day. No need to carb-load beforehand — that's an endurance-sport trick; the evidence doesn't show it helps strength performance.`,
  };
}

// Eases the near edge of a RIR band no closer than `floor` reps shy of
// failure — same shape as waveRir, but keyed to the taper window rather than
// the weekly wave, and it can only ever move the band AWAY from failure.
export function taperRir(band, floor) {
  const m = /^(\d+)-(\d+)$/.exec(band ?? "");
  if (!m) return band;
  const lo = +m[1], hi = +m[2];
  if (lo >= floor) return band;
  return `${floor}-${Math.max(floor + 1, hi)}`;
}

// Immediate same-day readiness from an optional check-in (1-5 fields; stress
// inverted). Gentle + honest: a low day eases the session, never blocks or guilts.
export function dailyReadiness(checkin) {
  if (!checkin) return null;
  const parts = [];
  if (typeof checkin.sleep_quality === "number") parts.push(checkin.sleep_quality);
  if (typeof checkin.energy === "number") parts.push(checkin.energy);
  if (typeof checkin.mood === "number") parts.push(checkin.mood);
  if (typeof checkin.stress === "number") parts.push(6 - checkin.stress);
  if (!parts.length) return null;
  const score = parts.reduce((a, b) => a + b, 0) / parts.length; // 1-5
  return { score: Math.round(score * 10) / 10, level: score < 2.75 ? "low" : score > 4 ? "high" : "normal" };
}

// Build today's session card: every exercise pre-filled with a suggested weight.
// A low-readiness check-in trims the last accessory and adds a caring coach note.
// Dropping an exercise can orphan half a superset pair, and the player reads
// `superset_with` to build its station — a dangling reference renders "🔗 superset
// with undefined" and the post-station advance can skip the survivor. Any code
// path that shortens a session must run its result through this. It exists as a
// function because there are now two such paths (a low-readiness trim and the
// first-session trim below), and a second copy is how they drift apart.
const unlinkOrphanSupersets = (list) => {
  const ids = new Set(list.map((e) => e.exercise));
  return list.map((e) => (e.superset_with && !ids.has(e.superset_with) ? { ...e, superset_with: undefined } : e));
};

// The KB's own beginner page (`09-getting-started/your-first-session.md`) says
// plainly: "Short is fine. A first session of 20–40 minutes is plenty. You're
// establishing a pattern, not setting records." The engine did not know that — it
// built the same 7-exercise, 14-set session on day one as on day one hundred, and
// beginners are exempt from the mesocycle wave (`blockPhase` returns null for
// them), so the least experienced user was the ONLY one who got no ramp at all.
// At the engine's own ~3 min/set that is ~36 minutes of counted work before a
// warm-up, ramp-up sets on five different stations, or finding those stations for
// the first time.
//
// This is a coaching correctness fix, not a funnel tweak: the app was contradicting
// its own knowledge base on the single most important session a user ever does.
// It lives in buildToday — the layer that already decides "what should today
// actually be" (readiness trims, comeback eases, deload and taper scaling) — so
// plan-core is untouched: the programme still has 7 exercises and the plan screen
// still shows the real week.
//
// The head, not the tail: exercises are emitted in lift order, so the first four
// are the pattern-coverage compounds the generator worked to place.
//
// Weekly volume check, which is what actually matters: a beginner's week 1 goes
// 14+14+12 = 40 sets to 8+14+12 = 34, i.e. 0.85x — still LESS eased than the
// intermediate's by-design week-1 BLOCK_SET_SCALE of 0.70x.
const FIRST_SESSION_EXERCISES = 4;

// WHERE TRAINING STANDS on `now` — the mesocycle week (with a stamped reactive deload folded
// in) and any event taper. ONE derivation shared by buildToday (what to do today) and the
// post-workout read-out (what it means — Burst 2), so the two can never describe different
// weeks (lesson 1). Fresh objects every call: buildToday rewrites the notes for a comeback.
export function trainingContext(user, sessions, now = null) {
  // beginner: gates plain-effort language on the set screen (Goal 3) — a true
  // novice sees "leave a couple in the tank", not the "RIR" acronym; someone with
  // real training history keeps the term. Also gates the body-scaled starting-
  // weight guess below (a true novice hasn't trained enough to judge one).
  // Defaults to beginner (the safe, plainer default) when training_status is unset.
  const beginner = (user.profile?.training_status ?? "beginner") === "beginner";
  // Where are we in the mesocycle? (null for beginners — flat, simple weeks.)
  let block = blockPhase(trainedWeeksInBlock(sessions, user.plan_meta?.block_start ?? user.created_at, now, user.profile?.tz_offset_min), user.profile?.training_status);
  // A REACTIVE deload, brought forward because training said so rather than
  // because the calendar did (the KB's third plateau lever). /api/today decides
  // whether one is due and stamps the ISO WEEK it fired in — a week, not a day, so
  // the whole week deloads consistently no matter which days the user opens the app,
  // and the stamp can't slide forward mid-week as new sessions change the signal.
  // Rewrites the phase in place so every downstream deload branch (sets, RIR, load
  // ease) applies unchanged — one mechanism, two triggers.
  // The stamp is read in the user's LOCAL week frame — the same frame the block
  // clock (trainedWeeksInBlock) and the stamp writer use. Raw isoWeekKey here made
  // a UTC-8 user's Sunday-evening deload land in a week they weren't in (lesson 22).
  if (block && now && user.plan_meta?.reactive_deload?.week === isoWeekKeyLocal(now, user.profile?.tz_offset_min)) {
    block = {
      ...block,
      phase: "deload",
      setScale: 0.5,
      note: `Deload week — brought forward. Your hardest lifts have gone flat at the top of what you can recover from, and at that point more sets is the one thing that can't help. Your big lifts drop to about half their sets, ~10% lighter, well shy of failure: this is where the work you've already done turns into growth.`,
    };
  }
  // Is a goal event close enough to taper for? (null unless the user set one AND
  // it's inside the taper window — see taperPhase's comment for why this
  // OVERRIDES the mesocycle wave below rather than compounding with it.)
  const taper = taperPhase(now, user.profile?.goal_event_date, user.profile?.training_status, user.profile?.tz_offset_min);
  return { beginner, block, taper };
}

// EXERCISE ORDER (W290, Burst 5 — owner: "Exercise order isn't taken into consideration when
// suggesting weights"): the same lift after more same-muscle work than last time gets fewer reps (Simão
// et al. 2005, 2012). Both positions are read from the PLAN — today's session, and the anchor session's
// own day by name — with their planned (unscaled) sets, so a stable slot never moves, a deferred lift
// never drifts, and the wave's set ramp never nudges a plate. Only when the difference is 2+ weighted
// sets (derive-core's ORDER_MIN_DELTA_SETS), only for a weight that came from history (the comeback ease
// and the taper stand alone), never on added bodyweight load. The capacity converted is the one AT the
// base rule's weight, in the anchor's position, from the anchor's e1RM — so an earned step up and a
// position change never compound — and the result is rounded to the NEAREST step (floor would ratchet
// alternating days downward). Null when nothing applies; else the losses (they shape the aims too) and,
// when the weight moved, its reason.
const musclesFor = (byId) => (id) => { const e = byId.get(id); return e ? { primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] } : null; };
const setsWord = (n) => `${n} set${n === 1 ? "" : "s"}`;
function orderShift(ex, last, sug, slot, byId, anchorNear) {
  if (!slot?.program?.sessions || !last?.name || byId.get(ex.exercise)?.equipment === "bodyweight") return null;
  const today = slot.session?.exercises ?? [], anchorDay = slot.program.sessions.find((s) => s.name === last.name)?.exercises ?? [];
  const ti = today.findIndex((e) => e.exercise === ex.exercise), ai = anchorDay.findIndex((e) => e.exercise === ex.exercise);
  if (ti < 0 || ai < 0) return null;
  const now = priorOverlapSets(today, ti, musclesFor(byId)), then = priorOverlapSets(anchorDay, ai, musclesFor(byId));
  if (Math.abs(now.sets - then.sets) < ORDER_MIN_DELTA_SETS) return null;
  const fromLoss = orderLoss(then.sets), toLoss = orderLoss(now.sets);
  if (fromLoss === toLoss) return null; // both positions cost the same (e.g. both at the cap): nothing to move (Burst 5 review)
  const anchorMin = ownMin(last, ex.rep_range);
  const anchor = anchorOf(last.sets, anchorMin), s1 = anchor.first;
  const rho = typeof s1.rir === "number" ? s1.rir : s1.reps < anchorMin ? 0 : anchorNear;
  const W = sug.suggested_kg, La = anchor.weight;
  if (!(W > 0) || !(La > 0)) return null;
  const e1rmFresh = La * (1 + (s1.reps + rho) / (30 * (1 - fromLoss)));
  const capAtW = (1 - fromLoss) * 30 * (e1rmFresh / W - 1);
  if (!(capAtW > 0)) return null;
  const inc = loadIncrement(ex.exercise, byId);
  // Move from the weight's OWN grid by whole steps (Burst 5 review): rounding the absolute load moved a
  // pounds user's 18.14 kg (40 lb) lighter on a fresher day, and a typed 32 kg heavier on a harder one.
  // A barbell never goes under the empty bar.
  const steps = Math.round((contextLoad(W, capAtW, fromLoss, toLoss) - W) / inc);
  const harder = now.sets > then.sets;
  const muscles = listJoin((harder ? now : then).muscles.map(plainMuscle));
  const where = `This time it comes after ${setsWord(now.count)} that also work your ${muscles} (last time it came ${then.count ? `after ${setsWord(then.count)}` : "first"})`;
  // When the weight can't move (under half a step, or the bar) but a harder position still lowers the aim, the
  // reason says so — only for a held weight; a bump or an ease keeps its own reason (fix verification).
  const stays = (kgNow) => ({ fromLoss, toLoss, kg: W, note: harder && W === La ? `${where} — the same ${kgNow} kg, with today's aim allowing for that.` : null });
  if (steps === 0) return stays(W); // under half a step: the weight stays exactly as it was
  let kg = Math.round((W + steps * inc) * 100) / 100;
  if (byId.get(ex.exercise)?.equipment === "barbell") kg = Math.max(kg, Math.min(W, EMPTY_BAR_KG));
  if (!(kg > 0) || kg === W) return stays(W);
  const earned = W > La && kg <= La ? " — you'd earned a step up, but this position cancels it"
    : W > La ? " — the step up you'd earned, adjusted for the order"
    : W < La && kg < La ? " — the lighter weight your last session called for, adjusted for the order" : "";
  // "This time … (last time …)" reads right on Today AND in the read-out's "next time" (Burst 5 review).
  const note = harder
    ? `${where}, so I've made it ${kg} kg${earned}.`
    : `This time it comes ${now.count ? `after only ${setsWord(now.count)} that also work your ${muscles}` : "first"} (last time it came after ${setsWord(then.count)} that also work your ${muscles}), so I've made it ${kg} kg${earned}.`;
  return { fromLoss, toLoss, kg, note };
}

// What the app SERVES for one lift of the plan in a training context: the RIR band shown
// (it IS the prescription autoregulation measures against), the set count after the wave or
// taper, and the weight with its reason. The single door for "what will this lift be" —
// buildToday serves it, and the read-out's "next time" quotes it, so the promise test can pin
// the two equal (Burst 2, lesson 60). `slot` ({ program, session }) is where the lift sits in
// the plan today, for the exercise-order rule (W290).
export function servedLift(ex, sessions, ctx, byId = exerciseById, now = null, slot = null) {
  const { block, taper } = ctx;
  const rirBand = taper ? taperRir(ex.rir ?? "1-3", taper.rirFloor)
    : block?.phase === "deload" ? "3-4"
    : block ? waveRir(ex.rir ?? "1-3", block.week)
    : ex.rir ?? "1-3";
  const sug = suggestWeight(sessions, ex.exercise, ex.rep_range, byId, now, rirBand, !!taper);
  // Apply the mesocycle wave: sets scale with the block week — but never below 2
  // when the plan prescribed >= 2. A ramp/deload drops sets from the BIG doses
  // (4→3, 4→2), it doesn't turn every 2-set isolation into 1-set scatter (the
  // plan engine's own no-1-set rule holds through the wave; week-1 users were
  // seeing five 1-set entries). Deload recovery still lands via the halved big
  // lifts, the ~10% load ease below, and RIR 3-4. A taper uses its OWN scale
  // instead (see taperPhase) — it overrides the wave rather than compounding.
  const sets = taper ? Math.max(Math.min(ex.sets, 2), Math.round(ex.sets * taper.setScale))
    : block ? Math.max(Math.min(ex.sets, 2), Math.round(ex.sets * block.setScale))
    : ex.sets;
  const last = sug.suggested_kg != null ? lastSetsForExercise(sessions, ex.exercise) : null;
  const { min, max } = parseRange(ex.rep_range);
  const nearOf = (b) => { const m = /(\d+)\s*-\s*(\d+)/.exec(b ?? ""); return m ? +m[1] : 1; };
  const anchorNear = nearOf(last?.target?.rir ?? ex.rir);
  // The exercise-order rule (W290) moves the history weight first; never during a taper or a comeback.
  const order = last && !taper && sug.layoff_days == null ? orderShift(ex, last, sug, slot, byId, anchorNear) : null;
  const base = order ? order.kg : sug.suggested_kg;
  // Deload load must ease from last week's ACTUAL weight, not the progressed
  // suggestion — otherwise the +load bump (or an RIR-in-the-tank double bump) can
  // make the "~10% lighter" deload come out as heavy as, or heavier than, the peak
  // week (e.g. (40+5)*0.9 = 40.5 > 40). Anchor on `last_kg` and take the MIN with
  // whatever suggestWeight already returned, so a deload can never be heavier than
  // the prior real week and never undoes a lighter ease (a layoff comeback at
  // 0.88× stays at 0.88×, not bumped back up to 0.9×). Never during a taper — a
  // taper's whole point is holding the load while sets come down.
  const deloadKg = !taper && block?.phase === "deload" && sug.suggested_kg != null ? Math.round((sug.last_kg ?? sug.suggested_kg) * 0.9 * 4) / 4 : null;
  const suggested_kg = deloadKg != null ? Math.min(base, deloadKg) : base;
  // The reason travels to the set screen (Burst 1 review), so it must describe the weight
  // actually served: when the deload ease lowered it, the progression's note ("add 2.5 kg")
  // would contradict the pre-filled number; when the order moved it, the order says why.
  // A band further from failure than the one the anchor was SERVED with (its stored target) aims lower.
  const bandShift = last?.target?.rir ? nearOf(rirBand) - nearOf(last.target.rir) : 0;
  const anchorKg = last ? anchorOf(last.sets, ownMin(last, ex.rep_range)).weight : null;
  const fewer = bandShift === 1 ? "a rep" : `${bandShift} reps`;
  const suggestion_note = deloadKg != null && deloadKg < base
    ? `Deload week — about 10% lighter than last time on purpose (${suggested_kg} kg). Your progression picks up again after this week.`
    : order?.note
      ?? (bandShift > 0 && suggested_kg === anchorKg && sug.layoff_days == null
        // the aim drops below last time's reps, so the reason must not say "add a rep or two" (fix verification)
        ? (taper ? `Taper — same weight, more left in the tank (${rirBand.replace("-", "–")} in reserve), so aim for ${fewer} fewer per set than last time.`
          : `Same weight as last time — this week asks for ${rirBand.replace("-", "–")} reps in reserve (${bandShift} more than last time), so aim for ${fewer} fewer per set.`)
        : sug.note);
  // Each set's rep AIM (W289): from last session's sets, against the weight actually served (after the
  // order rule and the deload ease), so the reps stepper starts on a number this set can hit.
  // A comeback's eased row keeps last time's reps (the ease is the point), and only sets at or above the
  // anchor weight set the aim (a ramp logged as work sets is no evidence at today's load) — Burst 5 review.
  const rep_targets = last ? repTargets(last.sets, { sets, weightKg: suggested_kg, min, max, near: nearOf(rirBand), anchorNear,
    fromLoss: order?.fromLoss ?? 0, toLoss: order?.toLoss ?? 0, floorKg: Math.min(suggested_kg, anchorKg), ceilKg: anchorKg,
    keepReps: byId.get(ex.exercise)?.equipment === "bodyweight" || sug.layoff_days != null, bandShift }) : null;
  return { rirBand, sets, sug, suggested_kg, suggestion_note, rep_targets };
}

export function buildToday(user, sessions, readiness = null, customEx = [], now = null, bodyweightKg = null, hasAnySession = false) {
  const { byId, name } = resolveEx(customEx);
  const program = user.program;
  const ctx = trainingContext(user, sessions, now);
  const { beginner, taper } = ctx;
  let { block } = ctx;
  // Rotate by sessions of THIS program only, so merged sessions from a different
  // program (e.g. an earlier device) don't phase-shift the cycle.
  // rotation_base rebases the cycle at the last regenerate: the deterministic
  // program id is reused, so without it old sessions phase-shift a fresh plan.
  // rotationState folds in the user's skips and this cycle's day swaps on top.
  const { idx } = rotationState(program, sessions, user.plan_meta);
  const templateSession = program.sessions[idx];
  let templateExercises = templateSession.exercises;
  let coach_note = null;
  if (readiness?.level === "low") {
    // Branch on the LEVEL, never on whether we can trim. A low day always earns an
    // honest easing note — trimming is just the primary lever when the session is
    // long enough. On an already-short (≤3-exercise) session we keep it whole but
    // still ease effort; the one thing we must never do is tell someone who reported
    // awful sleep/energy that they're "in their normal range" (that fabricates a
    // status against their own input and teaches them the check-in is fake).
    if (templateExercises.length > 3) {
      templateExercises = unlinkOrphanSupersets(templateExercises.slice(0, -1)); // drop the last accessory
      coach_note = "You flagged low sleep/energy today, so I trimmed the last accessory. Showing up is the win — rest is training too.";
    } else {
      coach_note = "You flagged low sleep/energy today. It's already a short session, so keep it — but take a little extra rest and stop 2–3 reps short of failure. Showing up is the win.";
    }
  } else if (readiness?.level === "high") {
    // Never invite added volume during a deload: the block card is simultaneously
    // telling the user to cut sets and recover, so "add a back-off set" would be a
    // direct contradiction on the same screen and undercuts the one week the program
    // exists to de-fatigue. Acknowledge the good day, but hold the deload line.
    // Taper FIRST: everywhere else in buildToday the taper overrides the mesocycle
    // wave (sets, RIR, load-ease, the block card itself is nulled) — so the note
    // must follow the same precedence, or a week-6 deload overlapping a taper
    // window produced a "keep it a genuine deload; the volume comes back next
    // week" note beside a taper card, referencing a deload that was neither
    // rendered nor applied (and "next week" is the event, not returning volume).
    coach_note = taper
      ? "You're feeling fresh — the taper's doing its job. Keep the sets where they are; that's the point."
      : block?.phase === "deload"
        ? "You're feeling fresh — good sign the deload is working. Still keep it a genuine deload; the volume comes back next week."
        : "You're fresh today — if a lift feels easy, add a back-off set.";
  } else if (readiness) {
    // The common case must never be silent: a user who checked in and saw nothing
    // change concludes it didn't work. Acknowledge, then confirm the plan stands.
    coach_note = "Checked in ✓ — you're in your normal range, so today's session stands as planned.";
  }
  // A fresh mesocycle rotated the accessories — say so ONCE (until a session is
  // logged under the new block), so the changed exercise list never feels random.
  const rotatedAt = user.plan_meta?.rotated_at;
  if (rotatedAt && !sessions.some((s) => s.date && s.date > rotatedAt)) {
    // If the adaptive tune moved a muscle's volume THIS block, say so — announce only
    // what changed this block (not the whole accumulated total, which would re-claim
    // "I added volume for X" every block long after the one-time bump).
    const changed = user.plan_meta?.tuned_this_block ?? {};
    const mName = plainMuscle; // the Progress tab's plain words (W282), never the anatomy
    const bumped = (changed.bumped ?? []).map((m) => mName(m));
    const eased = (changed.eased ?? []).map((m) => mName(m));
    const tuned = bumped.length || eased.length
      ? ` Based on how you've been responding, I've ${[bumped.length ? `added volume for your ${bumped.join(", ")}` : "", eased.length ? `eased off your ${eased.join(", ")}` : ""].filter(Boolean).join(" and ")}.`
      : "";
    // A gated add must not be SILENT (Wave 258): a stalled muscle with room whose
    // +2 the recovery/fuel gate suppressed produced no delta, so the note said
    // nothing — and the user was left wondering why a flagged plateau changed
    // nothing. One plain sentence, only when it happened.
    const held = changed.held ?? [];
    const gateHeld = held.filter((h) => h.reason === "deficit" || h.reason === "recovery");
    const gateNote = gateHeld.length
      ? ` Your ${gateHeld.map((h) => mName(h.muscle)).join(", ")} ${gateHeld.length === 1 ? "has" : "have"} stalled with room to grow, but ${gateHeld[0].reason === "deficit" ? "you're eating in a deficit" : "your check-ins say recovery's been short"} — I've held ${gateHeld.length === 1 ? "its" : "their"} sets until that turns around. Fuel and sleep beat any programming change there.`
      : "";
    // Consideration #1: a stall on well under the planned sets. Said kindly, with the lever.
    const doneHeld = held.filter((h) => h.reason === "completion");
    const share = doneHeld.length > 1 ? Math.round((100 * doneHeld.reduce((a, h) => a + h.realized, 0)) / doneHeld.reduce((a, h) => a + h.planned, 0)) : null;
    const doneNote = doneHeld.length
      ? ` Your ${doneHeld.map((h) => mName(h.muscle)).join(", ")} ${doneHeld.length === 1 ? "has" : "have"} stalled, but most weeks ${doneHeld.length === 1 ? `it's getting about ${doneHeld[0].realized} of its ~${doneHeld[0].planned} planned sets` : `they're getting about ${share}% of their planned sets`} — so I've held ${doneHeld.length === 1 ? "its" : "their"} volume rather than add more on paper. Getting through more of the planned sets is what will move ${doneHeld.length === 1 ? "it" : "them"}; if your weeks can't fit them, set fewer training days and I'll rebuild the plan around what you can do.`
      : "";
    const heldNote = gateNote + doneNote;
    // If a lift got CHANGED because it plateaued (not just rotated for variety),
    // name it — an exercise vanishing from your plan without explanation reads as
    // the app losing track, and this one is a deliberate coaching decision.
    const swapped = (user.plan_meta?.swapped_this_block ?? []).map((id) => name(id));
    const swapNote = swapped.length
      ? ` Your ${swapped.join(", ")} had gone flat for weeks, so I've swapped ${swapped.length === 1 ? "it" : "them"} for a different angle on the same muscle — a stalled lift needs a change, not more sets.`
      : "";
    const msg = `New block — I rotated your accessory exercises for fresh stimulus. Your main lifts stay, so your progression carries over.${tuned}${heldNote}${swapNote}`;
    coach_note = coach_note ? `${msg} ${coach_note}` : msg;
  }
  // GRADUATION: the user's logged training age crossed a tier, so the plan just
  // stepped up. Announce it as the win it is (Goal 4) rather than letting a bigger,
  // differently-structured program appear unexplained. Rides the same
  // announced-once window as the block rotation above (`rotated_at`), so it clears
  // itself the moment a session is logged under the new block.
  const graduatedTo = user.plan_meta?.graduated_to;
  if (graduatedTo && rotatedAt && !sessions.some((s) => s.date && s.date > rotatedAt)) {
    const win = graduatedTo === "advanced"
      ? `🎓 You've trained long enough to be programmed as an ADVANCED lifter. Your volume targets step up, your hardest sessions get bigger, and your rep ranges now vary day to day. This is years of showing up, paying off.`
      : `🎓 You're not a beginner any more — and I've stopped programming you like one. From today your volume steps up, your weeks build toward a peak and then deload, and your accessories refresh each block. You earned this by showing up.`;
    coach_note = coach_note ? `${win} ${coach_note}` : win;
  }
  // Layoff → the suggested weights below are actually eased; say so honestly, so the
  // Coach's "welcome back — I eased your weights" claim matches what's on the card.
  const lastSessionMs = Math.max(0, ...sessions.filter((s) => s.date).map((s) => +new Date(s.date)));
  const layoffDays = now && lastSessionMs ? Math.round((+new Date(now) - lastSessionMs) / 86400000) : 0;
  if (layoffDays >= COMEBACK_GAP_DAYS) {
    const welcome = `Welcome back — it's been ${layoffDays} days, so I eased today's weights to ramp you in safely. They'll climb again fast.`;
    coach_note = coach_note ? `${welcome} ${coach_note}` : welcome;
    // A comeback INSIDE a taper window: the load ease is correct (safety first),
    // but the taper card's stock "the weight stays where it is / stays real" line
    // would sit right next to per-exercise "I eased this to X kg" notes. Lesson 12:
    // when the numbers are right, make the EXPLANATION honest — don't let two true
    // mechanisms describe each other's opposite.
    if (taper) taper.note = `${taper.daysUntil} day${taper.daysUntil === 1 ? "" : "s"} to go — taper, plus you're coming back from a break: sets stay low and the weights are eased a touch, so you arrive fresh, not rusty.`;
    // Same reconciliation for the BLOCK card (lesson 24's sibling — the taper copy was
    // fixed and this one was not). Since Wave 167 the mesocycle only advances on
    // TRAINED weeks, so a layoff no longer *pushes* anyone into a peak week — but it
    // can still resume ON one, and "peak volume — push hard" sitting beside eased
    // weights and "welcome back, I ramped you in safely" is two true mechanisms
    // describing each other's opposite. The volume is right; make the wording honest.
    if (block && block.phase !== "deload") {
      block.note = `Week ${block.week} of ${block.of} — picking up where you left off. Your block waited for you: it only advances on weeks you train, so nothing was missed. Today's weights are eased to ramp you back in; they'll climb again fast.`;
    }
  }
  // The all-time bests BEFORE today, per exercise — the exact ceiling sessionRecap will
  // compare this session against once it's logged (same `sessions` array, nothing added
  // yet). Carried onto each exercise below as `pr_watch` so the live player can celebrate
  // a personal record the moment it happens, not only after the whole session ends.
  const prBests = priorPersonalBests(sessions);
  // First-ever session for a true beginner. Applied AFTER the readiness branch so
  // the two levers can never both narrate: a low-readiness day already has its own
  // honest note, and printing "deliberately short" beside "I trimmed the last
  // accessory" would be two true mechanisms describing each other's opposite. The
  // trim still applies; only the note defers.
  // `sessions` is the DERIVABLE list — it excludes voided and timing-quarantined
  // rows — so `sessions.length === 0` means "nothing that counts", not "never
  // trained". Someone whose only workout carries a legacy unparseable date has
  // trained, is being shown a "Date needs correcting" banner in History at this
  // very moment, and must not be handed a first-timer card calling today "day one
  // for finding the machines". The activation email had the identical false
  // premise and was fixed one call site earlier in this same wave; this is the
  // other one (lesson 1).
  const neverTrained = sessions.length === 0 && !hasAnySession;
  // Missed-a-day reassurance (its own field, NOT coach_note — the client renders
  // coach_note only when a readiness check-in exists, so a gap note folded in
  // there would be invisible to exactly the person coming back from a gap).
  // Bounded below COMEBACK_GAP_DAYS: at >=12 days the comeback branch above owns
  // the card and eases the weights; here nothing changed and the copy says so.
  // The stored-plan screen's word (W283 review), said until a session is logged after it.
  const screened = user.plan_meta?.screen_swaps;
  const swap_note = screened?.swaps?.length && !sessions.some((s) => s.date && s.date > screened.at) ? swapNoteFor(screened.swaps, name) : null;
  const gap_note = !neverTrained && layoffDays >= gentleGapDays(user.profile?.days_per_week) && layoffDays < COMEBACK_GAP_DAYS
    ? `It's been ${layoffDays} days — no problem. Your plan doesn't punish a gap: today's workout simply moved with you, nothing was skipped or lost, and your weights are unchanged.`
    : null;
  // The FULL session is the template's, captured before any trim. Reading it from
  // `templateExercises` meant a low-readiness day one had already dropped an
  // accessory, so the card reported "4 instead of 6" while the plan screen showed 7.
  const firstSessionFull = templateSession.exercises.length;
  const firstSession = beginner && neverTrained && templateExercises.length > FIRST_SESSION_EXERCISES;
  if (firstSession) {
    templateExercises = unlinkOrphanSupersets(templateExercises.slice(0, FIRST_SESSION_EXERCISES));
    // No `coach_note` here. The client gates `coach_note` on `readiness != null`,
    // so a note set on the ordinary day-one path (nobody has checked in yet) was
    // never rendered to anyone — a producer with no consumer, asserted by a test
    // over a string no user could see. `first_session` below is the real signal and
    // the first-timer card is its real consumer.
    //
    // A readiness note written before this trim can contradict the card beside it
    // (lesson 24), so EVERY branch that reaches here is reconciled — the first cut
    // rewrote only "stands as planned" while claiming the high note was covered
    // too (lesson 33): the low note kept crediting its one-accessory trim under a
    // card saying "4 instead of 7", and the high note invited a back-off set on
    // the same screen that says day one is not for setting records.
    if (coach_note && /stands as planned/.test(coach_note)) {
      coach_note = "Checked in ✓ — you're in your normal range. Today is still your short first session; the full one is back next time.";
    } else if (readiness?.level === "low") {
      coach_note = "You flagged low sleep/energy — good thing today is already your short first session. Take a little extra rest between sets and stop a few reps short of failure. Showing up is the win.";
    } else if (readiness?.level === "high") {
      coach_note = "You're feeling fresh — great day for your first session. Keep the weights comfortable anyway; day one is for learning the movements, not chasing records.";
    }
  }
  const exercises = templateExercises.map((ex) => {
    const e = byId.get(ex.exercise);
    // The band, the wave-scaled sets and the weight with its reason — through the one door
    // the read-out's "next time" also uses (servedLift).
    // The anchor's day is looked up in the STORED plan: a today-swap's patched copy (substituteRow) moves
    // the swapped-in lift out of its own day, where its anchor lives (Burst 5 review).
    const served = servedLift(ex, sessions, { block, taper }, byId, now, { program: user.stored_program ?? program, session: templateSession });
    const { rirBand, sets, sug } = served;
    let { suggested_kg, suggestion_note } = served;
    // No history for this lift: a non-beginner gets a body-scaled starting guess
    // to confirm/adjust instead of an empty bar (roadmap #4's last slice); a true
    // beginner keeps the null (the client's safe empty-bar default + ramp-up card).
    if (suggested_kg == null && !beginner && bodyweightKg) {
      const estimate = estimateStartingWeight(e, bodyweightKg, ex.exercise, byId);
      if (estimate != null) {
        // A first-time lift after same-muscle work starts a little lighter (W290): its position's cost
        // against a fresh start, at the range's bottom near the band (rounded to the nearest step, and
        // never under the empty bar — the estimate already errs light).
        const today = templateSession.exercises, ti = today.findIndex((x) => x.exercise === ex.exercise);
        const before = ti > 0 ? priorOverlapSets(today, ti, musclesFor(byId)) : null;
        const { min } = parseRange(ex.rep_range), near = +((/^(\d+)\s*-/.exec(rirBand) ?? [, 1])[1]);
        const inc = loadIncrement(ex.exercise, byId);
        const eased = before && before.sets >= ORDER_MIN_DELTA_SETS && e?.equipment !== "bodyweight"
          ? Math.max(e?.equipment === "barbell" ? EMPTY_BAR_KG : inc, Math.round(Math.round(contextLoad(estimate, min + near, 0, orderLoss(before.sets)) / inc) * inc * 4) / 4) : estimate;
        suggested_kg = Math.min(estimate, eased);
        suggestion_note = "No history yet — a starting estimate scaled to your bodyweight. Adjust it up or down until the last rep is right around the target effort."
          + (suggested_kg < estimate ? ` It comes after ${setsWord(before.count)} that also work your ${listJoin(before.muscles.map(plainMuscle))}, so I've started it a little lighter.` : "");
      }
    }
    return {
      exercise: ex.exercise,
      name: name(ex.exercise),
      sets,
      rep_range: ex.rep_range,
      rir: rirBand,
      primary_muscles: e?.primary_muscles ?? [], // slugs — the client renders friendly labels
      unilateral: !!e?.unilateral,               // → "each side", so a novice doesn't do half the work
      alternating: !!e?.alternating,             // → the side cue says "alternate every rep", never "all sets left first" (walking lunge)
      rest_s: restSeconds(e),                    // → the player's rest timer: the KB table for THIS lift (W273), adjustable in the player
      lengthened_bias: !!e?.lengthened_bias,     // → "stretch-focused" tag; the science the engine already applies, made visible
      cue: (e?.cues ?? [])[0] ?? null,
      equipment: e?.equipment ?? null,
      inc_kg: loadIncrement(ex.exercise, byId),  // → the player's next-set hint moves in this lift's real steps (W279b)
      movement_pattern: e?.movement_pattern ?? null, // → the inline line-art demo on the set screen
      suggested_kg,
      suggestion_note,
      // Per-exercise layoff ease (this lift returned after >=12 days even though
      // the session isn't a whole-session comeback — e.g. a rotated-back
      // accessory): its sets are planned-easy and must be deload-tagged too, or
      // the 0.88x ease logs as a fabricated ~12% strength drop. buildToday's
      // session-level `comeback` covers the whole-session case; this covers the rest.
      ...(sug.layoff_days != null ? { eased: true } : {}),
      ...(ex.superset_with ? { superset_with: ex.superset_with, superset_with_name: name(ex.superset_with) } : {}),
      pr_watch: { e1rm_kg: prBests.e1rm[ex.exercise] ?? null, load_kg: prBests.load[ex.exercise] ?? null },
      // What they actually lifted on THIS exercise last time. Already computed by
      // suggestWeight; carried through so the player can spot a typo (a stray zero,
      // lb into a kg field) against the lift's own history before banking it — see
      // session-core's isImplausibleSet. Display/guard only, never stored.
      last_kg: sug.last_kg ?? null,
      // ...and the reps that went with it, so the set screen can say
      // "Last time: 40 kg × 8, 7" (owner #3) — last_kg rode for the typo guard
      // while last_reps was silently dropped here (the route-whitelist class).
      last_reps: sug.last_reps ?? null,
      // The reps above are the sets AT last_kg (the anchor). When the weight changed between
      // sets — the next-set hint, a ramp — every set as done: [[kg, reps], …] (Burst 1 review).
      last_sets: sug.last_sets ?? null,
      // Each set's rep aim (W289) — the player's reps stepper starts here. Absent without history.
      ...(served.rep_targets ? { rep_targets: served.rep_targets } : {}),
    };
  });
  // The comeback ease can also fire PER-EXERCISE (a rotated-back accessory
  // untrained >=12 days) while the SESSION-level comeback branch above did NOT
  // (the user trained other lifts recently, so `layoffDays` < the gap) — the two
  // use the same threshold on different scopes (whole-session vs this-exercise).
  // Either way, if any weight on today's card is eased, the taper's stock "the
  // weight stays where it is / stays real" copy is false for that card. Align the
  // note here (only when the session-level branch didn't already rewrite it, whose
  // wholesale "coming back from a break" copy is more accurate for a full comeback).
  if (taper && layoffDays < COMEBACK_GAP_DAYS && exercises.some((e) => e.eased)) {
    taper.note = `${taper.daysUntil} day${taper.daysUntil === 1 ? "" : "s"} to go — taper. Most weights hold, but a lift or two you haven't trained in a while are eased a touch to ease you back in.`;
  }
  // comeback: the layoff ease (0.88×) is a deliberate deload of its own — the
  // client tags this session's sets `deload` so the eased weights never enter
  // the e1RM/stall trends as a fabricated ~12% strength loss.
  // A taper supersedes the block card entirely (they'd otherwise show two
  // conflicting "here's why volume changed this week" explanations at once).
  // Cardio, answered for TODAY rather than left as a page the user has to go read.
  // `hard_cardio_ok` resolves the guideline's leg-day rule against the session that
  // is actually on the card, so the copy can be specific instead of conditional.
  const cardio = program.cardio
    ? { ...program.cardio, hard_cardio_ok: (program.cardio.placement?.best_after ?? []).includes(templateSession.name) }
    : null;
  // `day_number` counts DERIVABLE sessions, which is right for "session N of your
  // plan" but must never gate a "first workout ever" claim — it reads 1 for a user
  // whose only workout is voided or quarantined. `never_trained` is that claim's
  // own signal, carried explicitly so no consumer re-derives it from the filter.
  // A specialization block's maintenance day says WHY it's light, on the day
  // itself (rationale.session_notes, Wave 250 — lesson 36's show-the-mechanism).
  return { index: idx, day_number: sessions.length + 1, never_trained: neverTrained, name: templateSession.name, program_name: program.name, exercises, coach_note, gap_note, swap_note,
    maintenance_note: user.plan_rationale?.session_notes?.[templateSession.name] ?? null,
    // Told, not silently done: the plan screen says 7 and Today would say 4, and an
    // unexplained gap between them is exactly the kind of thing that makes an app
    // feel broken. Rendered by the existing first-timer card.
    first_session: firstSession ? { shown: templateExercises.length, full: firstSessionFull } : null, readiness: readiness?.level ?? null, block: taper ? null : block, taper: taper ? { days_until: taper.daysUntil, note: taper.note } : null, comeback: layoffDays >= COMEBACK_GAP_DAYS, beginner, cardio };
}

// The Today card state machine: one decision only.
export function todayCard(user, sessions) {
  const daysPerWeek = user.profile.days_per_week ?? 3;
  return {
    state: "train",
    headline: buildToday(user, sessions).name,
    subline: `${user.program.name} · day ${sessions.length + 1}`,
    training_days_per_week: daysPerWeek,
  };
}

// Derived wins for the post-session recap — the reward, straight from the engine.
export function sessionRecap(user, allSessions, newSession, customEx = []) {
  const { index, name } = resolveEx(customEx);
  // Identify the just-logged session by id, not array position — once sessions
  // are ordered chronologically a backfilled date can land it mid-array.
  const prior = newSession.session_id
    ? allSessions.filter((s) => s.session_id !== newSession.session_id)
    : allSessions.slice(0, -1);
  const wins = [];

  // PRs — estimated 1RM for heavy work AND top LOAD for higher-rep hypertrophy work —
  // from the pure engine (detectPersonalRecords), which mirrors the est-1RM/load split so
  // a celebrated PR can never disagree with the progression trend, and now catches the
  // pump-band work the old e1rm-only check silently ignored (a 15-rep leg curl beating its
  // best weight used to be told nothing). Structured, not a pre-baked "N kg" string, so
  // the client renders the reward in the unit the user actually chose.
  const prs = detectPersonalRecords(newSession, prior);
  for (const pr of prs) {
    // `exercise` travels so the client can render the win in THAT lift's unit
    // (per-exercise kg/lb overrides), not just the global preference.
    if (pr.kind === "e1rm") wins.push({ kind: "pr", exercise: pr.exercise, name: name(pr.exercise), e1rm_kg: pr.e1rm_kg, delta_kg: pr.delta_kg });
    else if (pr.kind === "load") wins.push({ kind: "pr-load", exercise: pr.exercise, name: name(pr.exercise), load_kg: pr.load_kg, reps: pr.reps });
  }

  // Proximity to failure inferred from rep drop-off.
  const prox = proximityFromRepDropoff(newSession);
  const closeToFailure = Object.entries(prox).filter(([, v]) => v.inferred === "trained-close-to-failure");
  if (closeToFailure.length) {
    const ex = closeToFailure[0][0].split("@")[0];
    wins.push(`🔥 You trained ${name(ex)} close to failure — that's where growth happens.`);
  }

  // Weekly per-muscle volume vs the KB's landmarks.
  const weekly = perMuscleWeeklyVolume(allSessions, index);
  const weeks = Object.keys(weekly).sort();
  const latest = weeks[weeks.length - 1];
  if (latest) {
    const vsLm = volumeVsLandmarks(weekly[latest], muscleIndex);
    const inRange = Object.entries(vsLm).filter(([, v]) => v.status === "in-productive-range" || v.status === "approaching-MRV");
    if (inRange.length) {
      const m = inRange[0][0];
      wins.push(`📈 Your ${muscleById.get(m)?.name ?? m} is in the productive volume range this week.`);
    }
  }

  // Lucky sets — the variable-ratio surprise (roadmap #2's remaining slice): unlike the
  // PR bonus, this can land on ANY session, not just a strength milestone, so a quieter
  // session still has a shot at a reward.
  const luckyHits = luckySetsInSession(newSession);
  if (luckyHits.length) wins.unshift(`🍀 Lucky set${luckyHits.length > 1 ? "s" : ""}! +${luckyHits.length * LUCKY_SET_XP} bonus XP.`);

  if (!wins.length) wins.push("✅ Session logged. Consistency is what builds muscle — see you next time.");
  // pr_xp/lucky_xp: the bonus XP earned this session, so the recap can show the reward
  // at the moment it lands (the same constants the gamification engine banks into the level).
  return { day_number: allSessions.length, wins, pr_xp: prs.length * PR_XP, lucky_xp: luckyHits.length * LUCKY_SET_XP };
}

// ---------------------------------------------------------------------------
// THE POST-WORKOUT READ-OUT (Burst 2, W282 — owner: "a post-workout recap … what was the
// objective, did we hit the targets, what went well, what didn't … how this affects the
// following workouts, the training block, the next training block"). The client derives WHAT
// HAPPENED from the workout itself (session-core localReadout: it works offline); this is
// WHAT IT MEANS, and every number in it is quoted from the engine, never re-derived (lesson 1):
//   objective  — the day's aim, from the trainingContext buildToday used that day;
//   next       — per lift, the weight the next /api/today WILL serve (servedLift on the context
//                /api/today will build — a reactive deload this workout tips folded in first):
//                a promise the route test pins (lesson 60);
//   block      — at most two plain lines on this block;
//   next_block — from week 4, what the boundary would decide if it came today
//                (blockTuneDecision — the very function the rollover runs);
//   bodyweight — a falling trend, said exactly when the tune's own deficit gate holds.
// Beginners get the aim and the weights only (Goal 3). `sessions` is the derivable list
// INCLUDING `session`; ctx = { now, tz, checkins, bodyweights, customEx }.
function objectiveLine(ctx, gapDays) {
  if (gapDays >= COMEBACK_GAP_DAYS) return `Ease back in after ${gapDays} days off — lighter weights to ramp you back up safely.`;
  if (ctx.taper) return `Stay strong while doing less — ${ctx.taper.daysUntil} day${ctx.taper.daysUntil === 1 ? "" : "s"} to your event.`;
  const b = ctx.block;
  if (!b) return "Add a rep or a little weight where you can — that's how you get stronger, one session at a time.";
  if (b.phase === "deload") return "Recover — fewer sets and lighter weights, well shy of failure. This is when the block's work turns into growth.";
  if (b.phase === "peak") return `Week ${b.week} of ${b.of} — peak volume: hard sets, about 1–2 reps in the tank.`;
  return b.week === 1 ? `Week 1 of ${b.of} — building: start comfortably; volume and effort ramp from here.` : `Week ${b.week} of ${b.of} — building volume and effort toward your peak.`;
}
// The training slots this local week still holds after `todayKey` (W282 review): the
// committed days left (rest-marked days excepted), or — with no commitment — days_per_week
// minus the days already trained this week, never more than the days the week has left.
function slotsLeftThisWeek(user, sessions, todayKey) {
  if (!todayKey) return 0;
  const wd = WEEK_DAY_KEYS.indexOf(weekDayKey(todayKey));
  const eff = commitmentForDay(user.profile?.commitment, todayKey);
  if (eff) return eff.days.filter((d) => { const k = WEEK_DAY_KEYS.indexOf(d); return k > wd && !(user.rest_days ?? []).includes(shiftDayKey(todayKey, k - wd)); }).length;
  const monday = shiftDayKey(todayKey, -wd);
  const trained = new Set(sessions.map(sessionDayKey).filter((d) => d && d >= monday && d <= todayKey)).size;
  return Math.max(0, Math.min(6 - wd, (user.profile?.days_per_week ?? 3) - trained));
}
// Noon (local) on the Monday after `todayKey`, as an instant — "next week" for the block clock.
function nextMondayInstant(todayKey, tz) {
  const key = shiftDayKey(todayKey, 7 - WEEK_DAY_KEYS.indexOf(weekDayKey(todayKey)));
  return new Date(Date.parse(`${key}T12:00:00Z`) - (Number.isFinite(tz) ? tz : 0) * 60000).toISOString();
}

export function sessionReadout(user, sessions, session, ctx = {}) {
  const { now = session?.date ?? null, tz = user.profile?.tz_offset_min ?? null, checkins = [], bodyweights = [], customEx = user.custom_exercises || [] } = ctx;
  const { byId, index, name } = resolveEx(customEx);
  const program = user.program;
  const before = sessions.filter((s) => s.session_id !== session.session_id);
  const todayCtx = trainingContext(user, before, session.date ?? now);
  const beginner = todayCtx.beginner;
  const liftIds = [...new Set((session.sets ?? []).filter((s) => (s.set_type ?? "work") === "work").map((s) => s.exercise))];
  const lastBeforeMs = Math.max(0, ...before.filter((s) => s.date).map((s) => +new Date(s.date)));
  const gapDays = lastBeforeMs && session.date ? Math.round((+new Date(session.date) - lastBeforeMs) / 86400000) : 0;
  const objective = objectiveLine(todayCtx, gapDays);

  // What the next /api/today will do first: a graduation or a pending block rollover starts a
  // different plan (no per-lift promise can be made about it); a reactive deload this workout
  // tips is stamped, so it is folded into the context the promise is computed on.
  const graduating = !program?.custom && !!graduatedStatus(sessions, user.profile?.training_status);
  const blockStart = user.plan_meta?.block_start;
  const blockIndex = user.plan_meta?.block_index ?? 0;
  const rolling = !graduating && !beginner && !program?.custom && !!blockStart
    && Math.floor(trainedWeeksInBlock(sessions, blockStart, now, tz) / BLOCK_WEEKS) !== blockIndex;
  const rd = !graduating && !rolling ? reactiveDeloadStampDue(user, sessions, bodyweights, checkins, now, tz) : null;
  const nextUser = rd ? { ...user, plan_meta: { ...user.plan_meta, reactive_deload: { block: rd.block, week: rd.week } } } : user;
  const nextCtx = trainingContext(nextUser, sessions, now);
  // WHICH WEEK each lift's next appearance lands in (W282 review): the rotation's slot j is this
  // week only while this week still has a slot for it. A slot past it is promised in NEXT week's
  // context — the block clock counts this week by then, so week 5's "next time" is the deload's
  // weight — and never across a block boundary: a new plan sets those weights.
  const todayKey = now ? localDayKey(now, tz) : null;
  const slotsLeft = slotsLeftThisWeek(user, sessions, todayKey);
  const nextWeekNow = todayKey ? nextMondayInstant(todayKey, tz) : now;
  const rollingNextWeek = !graduating && !rolling && !beginner && !program?.custom && !!blockStart
    && Math.floor(trainedWeeksInBlock(sessions, blockStart, nextWeekNow, tz) / BLOCK_WEEKS) !== blockIndex;
  const nextWeekCtx = trainingContext(user, sessions, nextWeekNow);
  const order = !graduating && !rolling && program?.sessions?.length ? upcomingSessions(program, sessions, nextUser.plan_meta, program.sessions.length) : [];
  const next = [];
  for (const id of liftIds) {
    let hit = null;
    order.forEach((idx, j) => { if (!hit) { const ex = program.sessions[idx].exercises.find((e) => e.exercise === id); if (ex) hit = { ex, idx, j }; } });
    if (!hit) continue; // a session-only substitute: not in the plan, so no promise to make
    const thisWeek = hit.j < slotsLeft;
    if (!thisWeek && rollingNextWeek) continue; // the new block's plan sets that weight
    const served = servedLift(hit.ex, sessions, thisWeek ? nextCtx : nextWeekCtx, byId, thisWeek ? now : nextWeekNow, { program, session: program.sessions[hit.idx] });
    if (served.suggested_kg == null) continue;
    next.push({ exercise: id, name: name(id), kg: served.suggested_kg, last_kg: served.sug.last_kg ?? null, note: served.suggestion_note, session: program.sessions[hit.idx].name, when: thisWeek ? "this-week" : "next-week" });
  }

  const block = [];
  const next_block = [];
  let bodyweight = null;
  // A step up is a win, said plainly to everyone (beginners graduate too).
  if (graduating) block.push("You've trained long enough to step up — your next session starts a fresh plan built for where you are now.");
  // This-block and next-block lines speak about the week this workout is in, so only while it
  // still IS this week: a History read-out a week later must not re-tell a forecast the
  // boundary may already have acted on (W282 review).
  const sameWeek = !!now && sessionWeekKey(session) === isoWeekKeyLocal(now, tz);
  if (!beginner && sameWeek) {
    if (rolling) block.push("Your next session starts a new block — your accessories rotate and your main lifts carry over.");
    else if (rd && !nextCtx.taper) block.push("Your hardest lifts have gone flat at the top of what you can recover from, so I'm bringing your deload forward — the rest of this week is lighter. That's where this block's work turns into growth.");
    else if (todayCtx.block?.phase === "deload" && !todayCtx.taper) block.push("A deload session doesn't move your progression — your weights pick up again after this week.");
    if (rollingNextWeek) block.push("A new block starts next week — your accessories rotate and your main lifts carry over; their next weights come with the new plan.");
    if (!graduating && todayCtx.block && !todayCtx.taper && !rd && !rolling && todayCtx.block.phase !== "deload" && todayCtx.block.week === BLOCK_WEEKS - 1) {
      block.push("Next training week is your deload — fewer sets and lighter weights, to bank this block's work.");
    }
    const regress = regressionDetect(sessions, index).filter((r) => liftIds.includes(r.exercise));
    if (regress.length) block.push(`Your ${listJoin(regress.map((r) => name(r.exercise)))} ${regress.length === 1 ? "is" : "are"} down about ${regress[0].drop_pct}% from ${regress.length === 1 ? "its" : "their"} recent best — usually sleep or food, not training. I won't add volume there until it turns around.`);
    // Consideration #1, said where it applies — the same population the tune and the Progress
    // card act on: muscles whose lifts are FLAT and that get well under their planned sets.
    const flat = stalledExerciseIds(sessions, customEx, now);
    const flatMuscles = new Set(flat.flatMap((id) => index.get(id)?.primary ?? []));
    const completion = completionFor(perMuscleWeeklyVolume(sessions, index), user, now, tz);
    const short = [...new Set(liftIds.flatMap((id) => index.get(id)?.primary ?? []))].filter((m) => completion[m] && flatMuscles.has(m));
    if (short.length) {
      const one = short.length === 1;
      const share = one ? `about ${completion[short[0]].realized} of the ~${completion[short[0]].planned} sets a week your plan has for it`
        : `about ${Math.round((100 * short.reduce((a, m) => a + completion[m].realized, 0)) / short.reduce((a, m) => a + completion[m].planned, 0))}% of the sets your plan has for them`;
      block.push(`Your ${listJoin(short.map(plainMuscle))} ${one ? "has" : "have"} been flat — and most weeks ${one ? "it gets" : "they get"} ${share}. Getting through more of those sets is what will move ${one ? "it" : "them"}.`);
    }
    // What the boundary would decide — computed once, only when something needs it.
    let decision = null;
    const decide = () => {
      if (decision) return decision;
      const d = blockTuneDecision(user, sessions, { checkins, bodyweights }, now);
      let out = [];
      if (d.stalledExercises.length) {
        const nextPlan = generateUserPlan(user.profile, { blockIndex: blockIndex + 1, volumeAdjust: d.volumeAdjust, stalledExercises: d.stalledExercises }).program;
        out = d.stalledExercises.filter((sid) => !nextPlan.sessions.some((x) => x.exercises.some((e) => e.exercise === sid)));
      }
      return (decision = { ...d, out });
    };
    const spared = new Set(Object.keys(completion));
    const stalled = flat.filter((id) => liftIds.includes(id) && !regress.some((r) => r.exercise === id) && !(index.get(id)?.primary ?? []).every((m) => spared.has(m)));
    if (stalled.length) {
      const has = (xs) => (xs.length === 1 ? "has" : "have");
      if (program?.custom) {
        block.push(`Your ${listJoin(stalled.map(name))} ${has(stalled)} been flat for a few weeks — on a plan you built, swapping ${stalled.length === 1 ? "it" : "them"} for a different angle is the lever.`);
      } else {
        // Only a lift the next block's plan actually DROPS gets the "fresh angle" promise; a
        // lift it picks again (your only option with this equipment) is told what does work.
        const out = new Set(decide().out);
        const fresh = stalled.filter((id) => out.has(id)), kept = stalled.filter((id) => !out.has(id));
        if (fresh.length) block.push(`Your ${listJoin(fresh.map(name))} ${has(fresh)} been flat for a few weeks. If ${fresh.length === 1 ? "it stays" : "they stay"} flat, the next block gives ${fresh.length === 1 ? "it" : "them"} a fresh angle.`);
        if (kept.length) block.push(`Your ${listJoin(kept.map(name))} ${has(kept)} been flat for a few weeks — taking the last set of each closer to failure, with steady sleep and food, is what moves a plateau.`);
      }
    }
    block.splice(graduating ? 3 : 2);

    // From week 4: what the boundary would decide if it came today — the rollover's own function.
    // A specialization block's tune is frozen, but its boundary still swaps stalled lifts — so the
    // swaps are said and nothing else (W283 review).
    const specializing = isSpecializing(user.profile, blockIndex);
    if (!program?.custom && todayCtx.block && !todayCtx.taper && !graduating && !rolling && todayCtx.block.week >= 4) {
      const d = decide();
      const muscles = (ms) => listJoin(ms.map(plainMuscle));
      if (d.tuned.bumped.length) next_block.push(`More sets for your ${muscles(d.tuned.bumped)} — stalled with room to grow.`);
      if (d.tuned.eased.length) next_block.push(`Fewer sets for your ${muscles(d.tuned.eased)} — at the top of what you can recover from.`);
      const heldBy = (r) => d.tuned.held.filter((h) => h.reason === r).map((h) => h.muscle);
      if (heldBy("completion").length) next_block.push(`Your ${muscles(heldBy("completion"))} hold — get through more of the planned sets first.`);
      if (heldBy("deficit").length) next_block.push(`Your ${muscles(heldBy("deficit"))} hold — you're in a deficit, so fuel comes first.`);
      if (heldBy("recovery").length) next_block.push(`Your ${muscles(heldBy("recovery"))} hold — recovery's been short, so sleep comes first.`);
      if (d.out.length) next_block.push(`${listJoin(d.out.map(name))} ${d.out.length === 1 ? "gets" : "get"} a fresh angle — flat for weeks.`);
      if (!next_block.length && !specializing) next_block.push("Your volume carries over as it is, and your accessories rotate for variety.");
      next_block.splice(3);
    }
  }
  if (!beginner) {
    // The tune's deficit gate, read exactly as it reads it (the 42-day window, no fallback).
    const windowStart = now ? new Date(+new Date(now) - 42 * 86400000).toISOString().slice(0, 10) : "";
    const energy = classifyEnergyBalance(bodyweightTrend(bodyweights.filter((b) => (b.date || "").slice(0, 10) >= windowStart).map((b) => ({ date: b.date, bodyweight_kg: b.kg }))), user.profile?.primary_goal);
    if (energy.direction === "deficit") bodyweight = user.profile?.primary_goal === "fat-loss"
      ? "You're in the deficit you're aiming for — holding your strength is the win, and I won't add volume while it lasts."
      : "Your bodyweight is trending down — some strength dips are normal in a deficit, and I won't add volume while it lasts.";
  }
  return { beginner, objective, next, block, next_block, bodyweight };
}

// NERD MODE (W284 — owner: "add nerd mode"; design spec: a toggle within Progress). The numbers
// behind every card, read from the SAME derivations the cards and the engine use — no second
// calculation (lesson 1): per muscle, the week's sets and the 6-week peak the tune reads against
// the KB's MV/MEV/MAV/MRV (model estimates, labelled so), the plan's projected and target sets and
// the running adjustment; the block's maths (trainingContext); what the boundary would decide now
// (blockTuneDecision and the swaps the next plan would make — the rollover's own steps); per lift
// the weekly e1RM, the personal stall window, weeks flat and the margin under the 8-week peak.
// Computed only when asked (/api/progress?nerd=1): progressReport also runs inside every
// /api/today (reactiveDeloadStampDue), which must not pay for this.
export function nerdReport(user, sessions, bodyweights, checkins, nowISO, tz, report) {
  const { index } = resolveEx(user.custom_exercises || []);
  const weekly = perMuscleWeeklyVolume(sessions, index);
  const peak = peakWeeklyVolume(weekly);
  const rationale = user.plan_rationale?.volume_by_muscle ?? {};
  const adjust = user.plan_meta?.volume_adjust ?? {};
  const signals = Object.fromEntries((report.adaptive ?? []).map((a) => [a.muscle, a]));
  const rows = report.volumeByMuscle ?? [];
  const ids = [...new Set([...rows.map((v) => v.id).filter(Boolean), ...Object.keys(rationale)])];
  const volume = ids.map((m) => {
    const lm = muscleIndex.get(m) ?? null;
    const row = rows.find((v) => v.id === m);
    return {
      id: m, name: plainMuscle(m), sets: row?.sets ?? 0, status: row?.status ?? null, peak: peak[m] ?? 0,
      planned: rationale[m]?.projected_sets ?? null, target: rationale[m]?.target_sets ?? null, adjust: adjust[m] ?? 0,
      // A hand-built plan doesn't apply the stored tune (the editor says tuning stops) — shown as paused.
      adjust_paused: !!user.program?.custom,
      signal: signals[m]?.signal ?? null, gated: signals[m]?.gated ?? null,
      landmarks: lm ? { mv: lm.mv ?? null, mev: lm.mev ?? null, mav: lm.mav ?? null, mrv: lm.mrv ?? null } : null,
      grade: lm?.evidence_grade ?? null, estimate: true,
    };
  }).sort((a, b) => b.peak - a.peak || a.name.localeCompare(b.name));
  const ctx = trainingContext(user, sessions, nowISO);
  const blockStart = user.plan_meta?.block_start ?? user.created_at;
  const trainedIndex = Math.floor(trainedWeeksInBlock(sessions, blockStart, nowISO, tz) / BLOCK_WEEKS);
  const block = ctx.block ? { index: trainedIndex, week: ctx.block.week, of: ctx.block.of, phase: ctx.block.phase, set_scale: ctx.block.setScale,
    taper: ctx.taper ? { days_until: ctx.taper.daysUntil, set_scale: ctx.taper.setScale, rir_floor: ctx.taper.rirFloor } : null } : null;
  let next_block = null;
  const storedIndex = user.plan_meta?.block_index ?? 0;
  // Every block the rollover would act on — a specialization block too: its tune is frozen, but
  // the boundary still swaps stalled lifts (W283 review: the preview went blank and 14 lifts changed).
  if (block && !user.program?.custom) {
    const d = blockTuneDecision(user, sessions, { checkins, bodyweights }, nowISO);
    let swaps = [];
    if (d.stalledExercises.length) {
      // The block index the rollover will build: the trained-week clock's (a pending boundary),
      // else the next one.
      const nextPlan = generateUserPlan(user.profile, { blockIndex: Math.max(storedIndex + 1, trainedIndex), volumeAdjust: d.volumeAdjust, stalledExercises: d.stalledExercises }).program;
      swaps = d.stalledExercises.filter((sid) => !nextPlan.sessions.some((x) => x.exercises.some((e) => e.exercise === sid)));
    }
    next_block = { bumped: d.tuned.bumped, eased: d.tuned.eased, held: d.tuned.held, swaps, volume_adjust: d.volumeAdjust, specialization: isSpecializing(user.profile, storedIndex) };
  }
  const stallWindow = adaptiveStallWindow(progressionCadence(sessions, index));
  const stallBy = Object.fromEntries((report.stalls ?? []).map((x) => [x.exercise, x]));
  const regressBy = Object.fromEntries((report.regressions ?? []).map((x) => [x.exercise, x]));
  const strength = (report.progression_all ?? []).map((p) => {
    const recent = (p.series ?? []).slice(-8).map((x) => x.value);
    const top = recent.length ? Math.max(...recent) : 0, latest = recent[recent.length - 1] ?? 0;
    // The change over the four logged weeks the card draws — the lifetime % beside them read as a
    // gain over weeks that were flat (W283 review).
    const drawn = (p.series ?? []).slice(-4).map((x) => x.value);
    const window_pct = drawn.length > 1 && drawn[0] > 0 ? Math.round(((drawn[drawn.length - 1] - drawn[0]) / drawn[0]) * 1000) / 10 : 0;
    return { exercise: p.exercise, name: p.name, series: p.series, change_pct: p.change_pct, window_pct, basis: p.basis ?? "e1rm", stall_window: stallWindow,
      weeks_flat: stallBy[p.exercise]?.weeks_flat ?? 0, stalled: !!p.stalled,
      under_peak_pct: top > 0 ? Math.round(((top - latest) / top) * 1000) / 10 : 0,
      regressing: !!regressBy[p.exercise], drop_pct: regressBy[p.exercise]?.drop_pct ?? null };
  });
  return { volume, block, next_block, strength };
}

// The Progress tab payload: everything derived, nothing asked.
// AUTO-TUNE binder (#2): fold the just-completed block's response into the running
// per-muscle volume adjustment. Called at each mesocycle boundary so the NEXT block
// is generated with volumeAdjust applied — a muscle that keeps stalling gets more
// volume over time, one at its ceiling gets eased, all bounded to MEV↔MRV. Pure
// derive-core does the math; this just resolves the muscle index + stalled muscles.
// THE EXERCISE-VARIATION LEVER (considerations #2, finding 2B). The KB's plateau
// playbook is an ORDER — volume → effort → deload → change exercise
// (logging-and-plateaus.md, Grade C) — and the engine implemented only the first.
// Accessories rotated every block UNCONDITIONALLY (variety, not a response to
// anything) and compounds never rotated at all, so a stalled bench press could
// never be swapped by any code path in the app.
//
// Which lifts to swap: the ones stallDetect flags AND that were actually trained
// recently. The recency filter is load-bearing, not a nicety — stallDetect reads
// the last N weeks that HAVE data, so an exercise that stops being trained keeps
// its final flat weeks forever and stays flagged for good. Without this, one
// plateau would exile a lift from the plan permanently.
const STALE_STALL_DAYS = 21;
// `spareMuscles` (consideration #1): a lift whose every primary muscle is getting well under
// its planned sets (computeVolumeAdjust's `notCompleting`) is flat because it's trained half
// as often, not because the movement stopped working — swapping it would only reset its
// progression. Those lifts are never offered for the swap.
export function stalledExerciseIds(sessions, customEx = [], now = null, spareMuscles = []) {
  const { index } = resolveEx(customEx);
  const window = adaptiveStallWindow(progressionCadence(sessions, index));
  const spare = new Set(spareMuscles);
  const flagged = stallDetect(sessions, index, { minWeeks: window }).map((x) => x.exercise)
    .filter((exId) => { const p = index.get(exId)?.primary ?? []; return !(spare.size && p.length && p.every((m) => spare.has(m))); });
  if (!now) return flagged;
  const nowMs = +new Date(now);
  return flagged.filter((exId) => {
    const last = lastAnyDateForExercise(sessions, exId);
    return last != null && (nowMs - +new Date(last)) / 86400000 <= STALE_STALL_DAYS;
  });
}

// THE DELOAD LEVER (the same finding). The KB puts "manage fatigue (deload)"
// third, BEFORE changing the exercise — but the only deloads that existed were the
// calendar week-6 one and the layoff comeback ease, neither of which is a response
// to how training is actually going, and the user couldn't ask for one either.
//
// Fires only for a muscle stalled AT its recoverable ceiling — `volumeResponse`'s
// "change" signal, which the engine computed on every /api/progress call and threw
// away for several waves (nothing rendered it, nothing acted on it: lesson 15's
// producer with no consumer). This function is what finally acts on it, and the
// Progress plateau card renders it. Adding sets there is the one thing that can't
// help, which is exactly why the KB reaches for a deload instead.
//
// Bounded hard: never in week 1-2 (a block that has barely started has no fatigue
// to shed), never during a scheduled deload week, and at most ONCE per block.
const REACTIVE_DELOAD_MIN_WEEK = 3;
export function reactiveDeloadDue(responses, block, plan_meta, blockIndex, opts = {}) {
  if (!block || block.phase === "deload") return false;
  if (block.week < REACTIVE_DELOAD_MIN_WEEK) return false;
  if ((plan_meta?.reactive_deload?.block ?? null) === blockIndex) {
    // Once per block — per block of TRAINING (lesson 28): a stamped week the user
    // never trained delivered no deload, so it re-arms once that week is strictly
    // past in the user's frame. The ambiguous directions stay inert (lesson 40):
    // a still-current week is in progress, and a trained week is spent. Callers
    // that don't pass the flags keep the old hard once-per-block behavior.
    const { stampedWeekTrained = true, stampedWeekOver = false } = opts;
    if (stampedWeekTrained || !stampedWeekOver) return false;
  }
  return (responses ?? []).some((r) => r.signal === "change");
}

// The reactive-deload STAMP /api/today writes, decided here (Burst 2) so the post-workout
// read-out can say what the next /api/today WILL do — one definition, two readers. The
// route keeps its compare-and-swap re-check on the fresh stored copy; this is the decision.
// Returns { block, week, trainedKeys } when a stamp is due, else null.
export function reactiveDeloadStampDue(user, sessions, bodyweights, checkins, nowISO, tz) {
  const blockStart = user.plan_meta?.block_start;
  const trainedWeeks = trainedWeeksInBlock(sessions, blockStart ?? user.created_at, nowISO, tz);
  const block = blockPhase(trainedWeeks, user.profile?.training_status);
  if (!block || !blockStart || user.program?.custom) return null;
  const blockIndex = Math.floor(trainedWeeks / BLOCK_WEEKS);
  // Read from progressReport rather than re-deriving: one definition of the signal,
  // not two that can drift (the maintenance/hold filtering matters here too — a
  // muscle a specialization block deliberately holds low must never trigger this).
  const report = progressReport(user, sessions, bodyweights, user.custom_exercises || [], nowISO, checkins, tz);
  // The stamp lives in the user's LOCAL week frame — the same frame the block
  // clock and buildToday's read use; raw isoWeekKey put a UTC-8 user's Sunday
  // deload in a week they weren't in (lesson 22, storage+consumption together).
  const week = isoWeekKeyLocal(nowISO, tz);
  // Re-arm context (C15): sessionWeekKey is already local (it prefers
  // local_date), and ISO week keys are zero-padded, so string order IS
  // chronological order (lesson 40 — the ordinal form, not equality).
  const trainedKeys = new Set(sessions.map(sessionWeekKey).filter(Boolean));
  const stamp = user.plan_meta?.reactive_deload;
  const opts = {
    stampedWeekTrained: stamp ? trainedKeys.has(stamp.week) : true,
    stampedWeekOver: stamp ? stamp.week < week : false,
  };
  return reactiveDeloadDue(report.adaptive, block, user.plan_meta, blockIndex, opts) ? { block: blockIndex, week, trainedKeys } : null;
}

// The too-easy Set effortSignal's per-muscle read reduces to: only muscles with
// POSITIVE logged evidence of surplus effort (≥10 recent sets averaging ≥1 rep
// above their tier target). Shared by the tune and the Progress card so the two
// can never disagree about who's sandbagging.
const tooEasySet = (eff) => new Set(Object.entries(eff).filter(([, v]) => v.too_easy).map(([m]) => m));

export function computeVolumeAdjust(prevAdjust, sessions, customEx = [], context = {}) {
  const { byId, index } = resolveEx(customEx);
  const weekly = perMuscleWeeklyVolume(sessions, index);
  if (!Object.keys(weekly).length) return { adjust: prevAdjust || {}, held: [] };
  // Sample each muscle's PEAK weekly volume over the recent block — NOT the last
  // logged week (see peakWeeklyVolume: a mesocycle ends on a deload, so the latest
  // week makes the ease branches unreachable). Shared with progressReport's adaptive
  // card so the advice and the action can never read different numbers (C6).
  const peak = peakWeeklyVolume(weekly);
  // Individualized patience (Increment B): judge "stalled" against THIS person's own
  // demonstrated progression cadence, not a fixed 4 weeks — a slow-but-real responder
  // isn't plateaued at week 4 if their history shows they PR on a ~6-week rhythm.
  const window = adaptiveStallWindow(progressionCadence(sessions, index));
  const stalledMuscleIds = new Set(stallDetect(sessions, index, { minWeeks: window }).flatMap((x) => index.get(x.exercise)?.primary ?? []));
  // Recovery-/energy-aware gate (Increment A, docs/adaptive-algorithm.md): a stall
  // under persistent under-recovery or an energy deficit is a recovery/fuel problem —
  // adding volume there worsens it — so suppress the "add" response (easing still
  // fires). Energy balance is read from the bodyweight trend; readiness from the daily
  // check-ins. Both default to permissive when the data isn't there.
  const { checkins = [], bodyweights = [], goal = null, planVolume = null, currentWeek = null, sinceWeek = null } = context;
  const bwSeries = bodyweights.map((b) => ({ date: b.date, bodyweight_kg: b.kg }));
  const energyBalance = classifyEnergyBalance(bodyweightTrend(bwSeries), goal);
  const recovery = recoverySignal(checkins, energyBalance);
  // A muscle whose lifts are DECLINING must never be answered with more volume.
  // Without this, a real regression eventually looks like an ordinary plateau (once
  // the pre-drop weeks roll out of the stall window) and earns +2 sets — piling work
  // onto someone already failing to recover from what they were doing.
  const regressingMuscleIds = new Set(regressionDetect(sessions, index).flatMap((x) => index.get(x.exercise)?.primary ?? []));
  // Effort gate (Increment C): a stall whose logged effort sits clearly above the
  // KB target is sandbagged — the fix is effort, not sets. Positive evidence only;
  // with no logged rir the Set is empty and the tune is byte-identical to before.
  // The goal MUST be passed: effortBandTop grades a logged rir against the band the
  // plan prescribed, and strength deliberately reserves more on accessories — omit it
  // and a compliant strength lifter's sets are withheld for "sandbagging" they never did.
  const tooEasyMuscleIds = tooEasySet(effortSignal(sessions, byId, { goal }));
  // Completion gate (consideration #1): a stall on well under the sets the plan delivers is
  // under-training, not a plateau. `planVolume` is the plan's volume_by_muscle (the caller
  // passes null for a hand-built plan); absent → {} and the tune is byte-identical.
  const completion = completionShortfall(weekly, planVolume, { meanScale: BLOCK_MEAN_SCALE, excludeWeek: currentWeek, sinceWeek });
  const notCompletingMuscleIds = new Set(Object.keys(completion));
  const adjust = deriveVolumeAdjust(prevAdjust || {}, peak, muscleIndex, stalledMuscleIds, { ...recovery, regressingMuscleIds, tooEasyMuscleIds, notCompletingMuscleIds });
  // WHO was held and WHY (Wave 258): the whole-athlete gate (deficit/under-recovery)
  // suppresses an add SILENTLY — a gated add produces no delta, and no delta produced
  // no new-block sentence — so report the suppression beside the map, derived from
  // the SAME values the decision used (lesson 24: one derivation, never a second one
  // that can drift). Regression and effort holds are deliberately not listed here:
  // each already has its own standing card explaining itself.
  const gate = recovery.inDeficit ? "deficit" : recovery.underRecovered ? "recovery" : null;
  const held = [...stalledMuscleIds].filter((m) => {
    const lm = muscleIndex.get(m);
    if (!lm || lm.mav?.max == null || lm.mrv?.max == null) return false;
    const sets = peak[m] ?? 0;
    // Mirrors deriveVolumeAdjust's add branch exactly: these are the muscles
    // that WOULD have taken +2 but for a gate.
    return sets <= lm.mrv.max && sets < lm.mav.max && !regressingMuscleIds.has(m) && !tooEasyMuscleIds.has(m);
  }).sort()
    // The missing work is named first: it explains the stall before recovery or fuel can.
    .map((m) => (notCompletingMuscleIds.has(m) ? { muscle: m, reason: "completion", ...completion[m] } : gate ? { muscle: m, reason: gate } : null))
    .filter(Boolean);
  // `notCompleting` also spares those muscles' stalled LIFTS from the block's exercise swap:
  // a lift trained half as often as planned hasn't plateaued, and swapping it would only
  // reset its progression (the rollover filters with it).
  return { adjust, held, notCompleting: [...notCompletingMuscleIds].sort() };
}

// WHAT THE BLOCK BOUNDARY DECIDES — the volume tune and the stalled-lift swaps — if it came
// at `nowISO` (Burst 2). The /api/today rollover applies it; the read-out describes it ("if
// your block ended today…"), so the forecast and the action can never differ (lesson 1).
// The recovery/energy gate reads only the JUST-COMPLETED block, not the user's whole history:
// recoverySignal and bodyweightTrend average whatever they're handed, so the full log turned
// "block-average readiness" into a LIFETIME average (an athlete wrecked THIS block but with
// months of good prior check-ins never tripped the gate, and a long-past cut kept reading as a
// current deficit). Window to the block length (6 weeks); a sparse window falls back to
// permissive — the safe direction, since the gate only ever RESTRAINS adding. DURING a
// specialization block, non-priority muscles are deliberately maintenance-dosed, so their lifts
// "stall" by design — the tune is frozen (the prior carried forward), judged against the block
// that JUST COMPLETED (block_index as stored), never the one being entered.
export function blockTuneDecision(user, sessions, { checkins = [], bodyweights = [] } = {}, nowISO) {
  const windowStart = new Date(+new Date(nowISO) - 42 * 86400000).toISOString().slice(0, 10);
  const inWindow = (d) => (d || "").slice(0, 10) >= windowStart;
  const prevAdjust = user.plan_meta?.volume_adjust ?? {};
  // `planVolume` (consideration #1): the sets this plan delivers per muscle, so a stall on
  // well under them holds instead of earning +2 on paper. A hand-built plan's stored
  // rationale may not describe it → null (permissive).
  const { adjust, held, notCompleting = [] } = isSpecializing(user.profile, user.plan_meta?.block_index ?? 0)
    ? { adjust: prevAdjust, held: [] }
    : computeVolumeAdjust(prevAdjust, sessions, user.custom_exercises || [], { checkins: checkins.filter((c) => inWindow(c.date)), bodyweights: bodyweights.filter((b) => inWindow(b.date)), goal: user.profile?.primary_goal, planVolume: user.program?.custom ? null : user.plan_rationale?.volume_by_muscle, currentWeek: weekOf(nowISO, user.profile?.tz_offset_min), sinceWeek: weekOf(user.plan_meta?.block_start, user.profile?.tz_offset_min) });
  // What CHANGED this block — so the new-block coach note announces the actual adjustment,
  // not the whole accumulated total re-announced every block. `held` carries the adds a gate
  // suppressed, so the note can say WHY a stalled muscle's sets didn't move (Wave 258).
  const tuned = {
    bumped: Object.keys(adjust).filter((m) => (adjust[m] ?? 0) > (prevAdjust[m] ?? 0)),
    eased: Object.keys(adjust).filter((m) => (adjust[m] ?? 0) < (prevAdjust[m] ?? 0)),
    held,
  };
  // THE EXERCISE-CHANGE LEVER: lifts this person has genuinely plateaued on are demoted below
  // every alternative for their muscle — through the one door every rebuild uses (swapStalls),
  // decided afresh here; `spared` goes back to the rollover to store as the block's verdict.
  void notCompleting;
  return { volumeAdjust: adjust, tuned, stalledExercises: swapStalls(user, sessions, nowISO, { fresh: true }), spared: sparedMuscles(user, sessions, nowISO) };
}

// The muscles whose stalled lifts are spared from a swap: those getting well under the sets the
// plan delivers (consideration #1 — trained half as often isn't a plateau).
function sparedMuscles(user, sessions, nowISO) {
  const { index } = resolveEx(user.custom_exercises || []);
  return Object.keys(completionFor(perMuscleWeeklyVolume(sessions, index), user, nowISO)).sort();
}
// The stalled lifts a rebuild may swap out — ONE door for the block boundary, a Settings
// rebuild and the substitute ranker (W282 review: a units-only Settings save right after a
// boundary swapped out every lift the completion gate had just kept). stallDetect's recent
// flat lifts, minus the spared muscles' lifts. The BOUNDARY's verdict is the block's: within
// the block every rebuild reuses the muscles it stored (`plan_meta.spared_muscles`) — the new
// block's plan would judge the same weeks against different numbers; `fresh` is the boundary
// deciding anew.
export function swapStalls(user, sessions, nowISO, { fresh = false } = {}) {
  const stored = user.plan_meta?.spared_muscles;
  const spare = !fresh && stored && stored.block === (user.plan_meta?.block_index ?? 0) && Array.isArray(stored.muscles)
    ? stored.muscles : sparedMuscles(user, sessions, nowISO);
  return stalledExerciseIds(sessions, user.custom_exercises || [], nowISO, spare);
}

// `tz` is the user's UTC offset in minutes east — REQUIRED for the week arithmetic
// below to agree with itself. Session week keys come from `sessionWeekKey`, which
// prefers the device's own `local_date`; comparing those against a raw-UTC "current
// week" meant that around every ISO week boundary the in-progress week wasn't
// excluded, so a week with one session became the "last full week" reference and the
// card told a compliant lifter to add sets. Falls back to UTC when unknown, exactly
// as before.
export function progressReport(user, sessions, bodyweights, customEx = [], now = null, checkins = [], tz = null) {
  const { byId, index, name } = resolveEx(customEx);
  const weekly = perMuscleWeeklyVolume(sessions, index);
  const weeks = Object.keys(weekly).sort();
  // Pick the REFERENCE week honestly: the raw latest ISO week understates
  // volume when it's a deload (halved by design) or still in progress (it's
  // Tuesday), and "add sets" advice off an understated week contradicts the
  // mesocycle. Walk back from the latest week, skipping deload-dominant weeks
  // and the current in-progress week (when an earlier full week exists).
  const deloadFrac = {};
  for (const s of sessions) {
    const wk = sessionWeekKey(s); // local calendar day, malformed local_date -> UTC fallback
    for (const set of s.sets ?? []) {
      if ((set.set_type ?? "work") === "warmup") continue;
      (deloadFrac[wk] ??= { d: 0, t: 0 }).t++;
      if (set.deload) deloadFrac[wk].d++;
    }
  }
  const isDeloadWeek = (wk) => (deloadFrac[wk]?.t ?? 0) > 0 && deloadFrac[wk].d / deloadFrac[wk].t > 0.5;
  const nowWeek = now ? isoWeekKeyLocal(now, tz ?? user?.profile?.tz_offset_min) : null;
  // Prefer the newest CLEAN, FULL week; fall back to the newest clean week
  // (in-progress is better than nothing), then to the newest week of all with
  // an honest note — never the oldest (the old walk accepted index 0
  // unconditionally, so an all-deload history showed the EARLIEST deload week
  // under a note claiming deloads were skipped).
  const clean = weeks.filter((w) => !isDeloadWeek(w));
  const full = clean.filter((w) => w !== nowWeek);
  const newest = weeks[weeks.length - 1] ?? null;
  let latest = null, volume_note = null;
  if (full.length) {
    latest = full[full.length - 1];
    if (latest !== newest) {
      const reasons = [];
      if (weeks.slice(weeks.indexOf(latest) + 1).some(isDeloadWeek)) reasons.push("your deload week is skipped (its volume is intentionally low)");
      if (newest === nowWeek && !isDeloadWeek(newest)) reasons.push("this week is still in progress");
      if (reasons.length) volume_note = `Showing your last full week — ${reasons.join("; ")}.`;
    }
  } else if (clean.length) {
    latest = clean[clean.length - 1];
    // No earlier full week to fall back to, so the ONLY clean week shown is
    // the in-progress one itself (every brand-new user's first-ever visit).
    // Without this note, below-MEV/missing-muscle readings on literally the
    // first Progress-tab view read as "the plan already isn't working" —
    // the `full.length` branch above already explains the same situation
    // when an earlier week exists to show instead; this is its sibling for
    // when there isn't one.
    if (latest === nowWeek) volume_note = "This week is still in progress — the numbers below fill in as you log more sessions.";
  } else if (newest) {
    latest = newest;
    volume_note = "Your recent weeks are deloads — volume is intentionally low, exactly as planned.";
  }
  const volume = latest ? volumeVsLandmarks(weekly[latest], muscleIndex) : {};
  // Specialization honesty: a muscle the plan deliberately holds at its
  // maintenance dose is "holding steady", not "add volume" — the client's
  // s-maint status/legend exist for exactly this (they were never emitted).
  const maintIds = new Set(Object.entries(user.plan_rationale?.volume_by_muscle ?? {}).filter(([, r]) => r.maintenance).map(([id]) => id));
  // ...and its EASED sibling (Wave 255): a muscle the block deliberately caps at its
  // minimum effective dose is "slow growth", not "below MEV" — the cap is the plan
  // working. Older stored plans have no eased flags and keep their old statuses.
  const easedIds = new Set(Object.entries(user.plan_rationale?.volume_by_muscle ?? {}).filter(([, r]) => r.eased).map(([id]) => id));
  // The tier's THIRD consumer (the generator and the critique are the first two):
  // a muscle the plan deliberately serves through compound credit must not be told
  // "add volume" here while the plan screen calls the same state "covered by
  // compounds" — one user, three surfaces, one answer (lesson 10 at the coaching
  // layer; the exact s-maint shape handled one line up). Read from the STORED
  // rationale, so a pre-tier plan — which really does program wrist curls — keeps
  // its old, equally honest statuses until its next regeneration.
  const secServedIds = new Set(Object.entries(user.plan_rationale?.volume_by_muscle ?? {}).filter(([, r]) => r.secondary_served).map(([id]) => id));
  const volumeByMuscle = Object.entries(volume).map(([id, v]) => ({ muscle: muscleById.get(id)?.name ?? id, id, sets: v.sets,
    status: secServedIds.has(id) && v.status === "below-MEV" ? "secondary-served" : maintIds.has(id) && v.status === "below-MEV" ? "maintenance" : easedIds.has(id) && v.status === "below-MEV" ? "eased" : v.status }))
    .sort((a, b) => b.sets - a.sets);
  // Individualized patience (Increment B): the plateau surface uses the SAME personal
  // stall window as the auto-tune, so a slow responder isn't told they've plateaued at
  // 4 weeks when that's just their normal rhythm.
  const stalls = stallDetect(sessions, index, { minWeeks: adaptiveStallWindow(progressionCadence(sessions, index)) });
  const stalledIds = new Set(stalls.map((x) => x.exercise));
  // ADAPTIVE volume-response signal (#2 foundation): map stalled lifts → their
  // primary muscles, then let volumeResponse turn "current volume vs landmarks +
  // stalled?" into honest, MEV↔MRV-bounded per-muscle advice. Coaching only — the
  // user sees it and decides; the plan is never silently auto-changed. Only
  // meaningful with a few weeks of data (stallDetect needs 4 weeks), so it stays
  // quiet for new users beyond the below-MEV nudge.
  const stalledMuscleIds = new Set(stalls.flatMap((x) => index.get(x.exercise)?.primary ?? []));
  // Going BACKWARDS is a different thing from a plateau and needs different copy —
  // and until now nothing anywhere could see it (stallDetect structurally can't: a
  // real decline blows past its noise band).
  const regressions = regressionDetect(sessions, index).map((r) => ({ ...r, name: name(r.exercise) }));
  // Effort lever (Increment C): the same positive-evidence effort read the auto-tune
  // uses, so the card and the tune can never disagree about who's sandbagging. A
  // stalled muscle with clear logged-effort surplus reads "effort", not "add".
  // Same goal argument as computeVolumeAdjust's call, for the same reason — the two
  // must grade against the identical band or the card and the tune diverge.
  const tooEasyMuscleIds = tooEasySet(effortSignal(sessions, byId, { goal: user.profile?.primary_goal ?? null }));
  // Bodyweight trend/energy-balance must reflect the CURRENT phase, not the user's
  // whole lifetime history — the exact "lifetime vs block" bug /api/today's recovery
  // gate already guards against (L266 above) for this SAME bodyweightTrend function;
  // progressReport's own call to it was never scoped. Unwindowed, a user who bulked
  // for months then genuinely cuts for weeks still reads "surplus" on the Progress
  // screen long after the recent trend flipped, because the least-squares line is
  // dominated by the larger, older dataset. Window to the same 42-day block; a sparse
  // window falls back to the full history (bodyweightTrend's own 3-point floor), the
  // safe direction — never worse than the unwindowed behavior for a sparse logger.
  // (Hoisted above the adaptive assembly: the gated-add marker below needs the same
  // recovery read the tune's gate uses.)
  const bwWindowStart = now ? new Date(+new Date(now) - 42 * 86400000).toISOString().slice(0, 10) : null;
  const recentBodyweights = bwWindowStart ? bodyweights.filter((b) => (b.date || "").slice(0, 10) >= bwWindowStart) : bodyweights;
  const bwSeries = (recentBodyweights.length >= 3 ? recentBodyweights : bodyweights).map((b) => ({ date: b.date, bodyweight_kg: b.kg }));
  const trend = bodyweightTrend(bwSeries);
  const energy = classifyEnergyBalance(trend, user.profile.primary_goal);
  // Windowed to the same 42-day block — recoverySignal averages whatever it's
  // handed, and a lifetime blend is the exact bug /api/today's gate guards against.
  const recentCheckins = bwWindowStart ? (checkins || []).filter((c) => (c.date || "").slice(0, 10) >= bwWindowStart) : (checkins || []);
  const recovery = recoverySignal(recentCheckins, energy);
  // The volume SAMPLE is the same 6-week PEAK the block-boundary tune acts on (C6):
  // sampled from the reference week instead, the card said "add… I'm adding sets
  // next block" from a 12-set recent week while the tune's peak read 18 >= mav.max
  // and eased the same muscle −2 (measured live). One sample, one story.
  const regressingMuscleIdSet = new Set(regressions.flatMap((r) => index.get(r.exercise)?.primary ?? []));
  const addGate = recovery.inDeficit ? "deficit" : recovery.underRecovered ? "recovery" : null;
  const adaptive = latest ? volumeResponse(peakWeeklyVolume(weekly), muscleIndex, stalledMuscleIds, tooEasyMuscleIds, completionFor(weekly, user, now, tz))
    .filter((a) => a.signal !== "hold") // surface only the actionable adjustments
    .filter((a) => !maintIds.has(a.muscle)) // never tell a specialization user to "add" to a deliberately-held muscle
    .filter((a) => !(secServedIds.has(a.muscle) && (a.signal === "add" || a.signal === "complete"))) // ...nor "add sets" (or "before adding more") to a muscle the plan serves by compound credit (over-MRV honesty still passes)
    .filter((a) => !(easedIds.has(a.muscle) && (a.signal === "add" || a.signal === "complete"))) // ...nor to a muscle the block deliberately caps at MEV — the cap IS the plan (over-MRV still passes)
    .map((a) => {
      // An "add" the tune will NOT act on must say so — the card's promise ("I'm
      // adding sets there next block") was false under the recovery/fuel gate and
      // for a regressing muscle. Marked at the gate's own scope (lesson 24):
      // per-muscle for regression, whole-athlete for deficit/recovery.
      const gated = a.signal === "add" ? (regressingMuscleIdSet.has(a.muscle) ? "regression" : addGate) : null;
      return { ...a, ...(gated ? { gated } : {}), muscle_name: muscleById.get(a.muscle)?.name ?? a.muscle };
    }) : [];
  // Stalled lifts are pinned into the list — a plateau must never scroll out of sight.
  const allProg = progressionByExercise(sessions, index).filter((p) => p.weeks > 1);
  const progression = [...allProg.filter((p) => stalledIds.has(p.exercise)), ...allProg.filter((p) => !stalledIds.has(p.exercise))]
    .slice(0, 8)
    .map((p) => ({ ...p, stalled: stalledIds.has(p.exercise) }));
  // The FULL list beside the capped feed (owner #3, "Full progress views"): the
  // engine always computed every lift's dated series and threw all but 8 rows away.
  // Additive — `progression`'s 8-row contract is pinned by tests and stays.
  const progression_all = allProg.map((p) => ({ ...p, stalled: stalledIds.has(p.exercise) }));
  // Personal-record history (roadmap #1c): the full PR list for a count, plus the most
  // recent few for a lookback "wins" feed. Structured (weights, not pre-baked strings) so
  // the client renders in the user's unit.
  const prHistory = allPersonalRecords(sessions);
  const personal_records = prHistory.slice(0, 8).map((pr) => ({ ...pr, name: name(pr.exercise) }));
  // ...and the complete list the count had always promised (owner #3): every PR
  // event, renderable (name + date), newest first.
  const personal_records_all = prHistory.map((pr) => ({ ...pr, name: name(pr.exercise) }));
  // Concurrent-training read. Fed the FULL progression list (not the 8-row display
  // slice) so a climbing upper-body lift can never be truncated out of the asymmetry
  // check, and the same `stalls` array the plateau card renders, so the two surfaces
  // can't name different lifts.
  const interference = latest ? interferenceSignal({
    stalls, progression: allProg, weekVolume: weekly[latest], energyBalance: energy,
    recovery,
    goal: user.profile?.primary_goal ?? null, injuries: user.profile?.injuries ?? [],
  }, index, muscleIndex, guidelineById.get("cardio-concurrent-training")) : null;
  return { sessions_logged: sessions.length, bodyweights_logged: bodyweights.length, latest_week: latest ?? null, volume_note, volumeByMuscle, progression, progression_all, stalls, regressions, adaptive, bodyweight_trend: trend, energy_balance: energy, personal_records, personal_records_all, pr_count: prHistory.length, interference,
    // The raw weigh-in series the client DRAWS spans the full log (owner #3 —
    // "see my progress" means all of it), while `bodyweight_trend` above keeps its
    // 42-day window: the drawn history and the adaptive read are different
    // questions, split deliberately (Wave 259).
    bodyweight_series: bodyweights.map((b) => ({ date: (b.date || "").slice(0, 10), kg: b.kg })) };
}
