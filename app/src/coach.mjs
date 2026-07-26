// The coach: decides today's session and prefills every weight, so the user just
// confirms and taps Done. Reuses the KB's derive-core engine for all derivations.
import {
  estimate1RM, countsForE1RM, perMuscleWeeklyVolume, volumeVsLandmarks, progressionByExercise,
  bodyweightTrend, classifyEnergyBalance, proximityFromRepDropoff, stallDetect, volumeResponse,
  deriveVolumeAdjust, recoverySignal, progressionCadence, adaptiveStallWindow, isoWeekKey, sessionWeekKey,
  detectPersonalRecords, priorPersonalBests, PR_XP, allPersonalRecords, luckySetsInSession, LUCKY_SET_XP,
} from "../../tools/derive-core.mjs";
import { exIndex, muscleIndex, exerciseById, exerciseName, muscleById } from "./kb.mjs";

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
  for (let i = sessions.length - 1; i >= 0; i--) {
    // Deload sets are planned-easy — anchoring double progression to them would
    // leave every next block permanently one increment behind. Skip them.
    const sets = (sessions[i].sets ?? []).filter((s) => s.exercise === exId && (s.set_type ?? "work") === "work" && !s.deload);
    if (sets.length) return { sets, date: sessions[i].date ?? null };
  }
  return null;
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
  return rounded > 0 ? rounded : inc;
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
  const { max } = parseRange(repRange);
  if (!last) return { suggested_kg: null, note: "First time — pick a weight where the last rep is ~2–3 reps from failure." };
  const lastWeight = last.sets[0].weight_kg;
  const allHitTop = last.sets.every((s) => s.reps >= max);
  const base = { last_kg: lastWeight, last_reps: last.sets.map((s) => s.reps) };
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
  const rirs = last.sets.map((s) => s.rir).filter((r) => typeof r === "number");
  if (rirs.length) {
    const bandTop = (() => { const m = /(\d+)\s*-\s*(\d+)/.exec(prescribedRir ?? ""); return m ? +m[2] : 2; })();
    const avgRir = rirs.reduce((a, b) => a + b, 0) / rirs.length;
    if (!holdLoad && avgRir >= bandTop + 1) {
      const inc = loadIncrement(exId, byId) * (avgRir >= bandTop + 2 ? 2 : 1);
      return { suggested_kg: Math.round((lastWeight + inc) * 4) / 4, note: `You left ~${Math.round(avgRir)} reps in reserve last time — add ${inc} kg.`, ...base };
    }
    if (avgRir <= 0 && !allHitTop) return { suggested_kg: lastWeight, note: "You hit failure last time — keep the weight and build reps first.", ...base };
  }
  if (allHitTop) {
    if (holdLoad) return { suggested_kg: lastWeight, note: "Taper — hold this weight. You'd normally add load here; save that push for after the event.", ...base };
    return { suggested_kg: Math.round((lastWeight + loadIncrement(exId, byId)) * 4) / 4, note: `Last time you hit the top of the range — add ${loadIncrement(exId, byId)} kg.`, ...base };
  }
  return { suggested_kg: lastWeight, note: "Keep the weight and try to add a rep or two.", ...base };
}

// Which program session is due today (simple rotation by sessions completed).
export function nextSessionIndex(program, sessionCount) {
  const n = program.sessions.length;
  return ((sessionCount % n) + n) % n;
}

// ---------------------------------------------------------------------------
// The mesocycle: the KB's volume wave (volume-progression-and-deloads.md) made
// real. Weeks 1-5 ramp set volume from ~70% toward the plan's generated target
// (which is already MRV-trimmed, so the ramp PEAKS at the recoverable ceiling);
// week 6 is a deload — roughly half volume, ~10% lighter, comfortably shy of
// failure — then the next block starts automatically. Beginners are exempt:
// they progress by load/reps and don't yet need volume waves (KB: periodization
// -and-progression.md), and their UX stays maximally simple.
// ---------------------------------------------------------------------------
export const BLOCK_WEEKS = 6;
const BLOCK_SET_SCALE = [0.7, 0.8, 0.9, 1.0, 1.0, 0.5]; // w1..w5 build->peak, w6 deload
export function blockPhase(now, blockStart, experience) {
  if (experience === "beginner" || !now || !blockStart) return null;
  const days = Math.floor((+new Date(now) - +new Date(blockStart)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return null;
  const week = (Math.floor(days / 7) % BLOCK_WEEKS) + 1; // 1..6, cycles forever
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
export function buildToday(user, sessions, readiness = null, customEx = [], now = null, bodyweightKg = null) {
  const { byId, name } = resolveEx(customEx);
  const program = user.program;
  // beginner: gates plain-effort language on the set screen (Goal 3) — a true
  // novice sees "leave a couple in the tank", not the "RIR" acronym; someone with
  // real training history keeps the term. Also gates the body-scaled starting-
  // weight guess below (a true novice hasn't trained enough to judge one).
  // Defaults to beginner (the safe, plainer default) when training_status is unset.
  const beginner = (user.profile?.training_status ?? "beginner") === "beginner";
  // Where are we in the mesocycle? (null for beginners — flat, simple weeks.)
  const block = blockPhase(now, user.plan_meta?.block_start ?? user.created_at, user.profile?.training_status);
  // Is a goal event close enough to taper for? (null unless the user set one AND
  // it's inside the taper window — see taperPhase's comment for why this
  // OVERRIDES the mesocycle wave below rather than compounding with it.)
  const taper = taperPhase(now, user.profile?.goal_event_date, user.profile?.training_status, user.profile?.tz_offset_min);
  // Rotate by sessions of THIS program only, so merged sessions from a different
  // program (e.g. an earlier device) don't phase-shift the cycle.
  // rotation_base rebases the cycle at the last regenerate: the deterministic
  // program id is reused, so without it old sessions phase-shift a fresh plan.
  const rotCount = Math.max(0, sessions.filter((s) => !s.program_ref || s.program_ref === program.id).length - (user.plan_meta?.rotation_base ?? 0));
  const idx = nextSessionIndex(program, rotCount);
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
      templateExercises = templateExercises.slice(0, -1); // drop the last accessory
      // the dropped accessory may have been half a superset pair — unlink survivors
      const ids = new Set(templateExercises.map((e) => e.exercise));
      templateExercises = templateExercises.map((e) => e.superset_with && !ids.has(e.superset_with) ? { ...e, superset_with: undefined } : e);
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
    const mName = (m) => (muscleById.get(m)?.name ?? m).replace(/\s*\([^)]*\)/, ""); // drop the "(Pectoralis Major)" scientific suffix
    const bumped = (changed.bumped ?? []).map((m) => mName(m));
    const eased = (changed.eased ?? []).map((m) => mName(m));
    const tuned = bumped.length || eased.length
      ? ` Based on how you've been responding, I've ${[bumped.length ? `added volume for your ${bumped.join(", ")}` : "", eased.length ? `eased off your ${eased.join(", ")}` : ""].filter(Boolean).join(" and ")}.`
      : "";
    const msg = `New block — I rotated your accessory exercises for fresh stimulus. Your main lifts stay, so your progression carries over.${tuned}`;
    coach_note = coach_note ? `${msg} ${coach_note}` : msg;
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
  }
  // The all-time bests BEFORE today, per exercise — the exact ceiling sessionRecap will
  // compare this session against once it's logged (same `sessions` array, nothing added
  // yet). Carried onto each exercise below as `pr_watch` so the live player can celebrate
  // a personal record the moment it happens, not only after the whole session ends.
  const prBests = priorPersonalBests(sessions);
  const exercises = templateExercises.map((ex) => {
    const e = byId.get(ex.exercise);
    // The rir band shown to the user IS the prescription the autoregulation
    // measures compliance against — compute it first and pass it through.
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
    // Deload load must ease from last week's ACTUAL weight, not the progressed
    // suggestion — otherwise the +load bump (or an RIR-in-the-tank double bump) can
    // make the "~10% lighter" deload come out as heavy as, or heavier than, the peak
    // week (e.g. (40+5)*0.9 = 40.5 > 40). Anchor on `last_kg` and take the MIN with
    // whatever suggestWeight already returned, so a deload can never be heavier than
    // the prior real week and never undoes a lighter ease (a layoff comeback at
    // 0.88× stays at 0.88×, not bumped back up to 0.9×). Never during a taper — a
    // taper's whole point is holding the load while sets come down.
    let suggested_kg = !taper && block?.phase === "deload" && sug.suggested_kg != null
      ? Math.min(sug.suggested_kg, Math.round((sug.last_kg ?? sug.suggested_kg) * 0.9 * 4) / 4)
      : sug.suggested_kg;
    // No history for this lift: a non-beginner gets a body-scaled starting guess
    // to confirm/adjust instead of an empty bar (roadmap #4's last slice); a true
    // beginner keeps the null (the client's safe empty-bar default + ramp-up card).
    let suggestion_note = sug.note;
    if (suggested_kg == null && !beginner && bodyweightKg) {
      const estimate = estimateStartingWeight(e, bodyweightKg, ex.exercise, byId);
      if (estimate != null) {
        suggested_kg = estimate;
        suggestion_note = "No history yet — a starting estimate scaled to your bodyweight. Adjust it up or down until the last rep is right around the target effort.";
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
      lengthened_bias: !!e?.lengthened_bias,     // → "stretch-focused" tag; the science the engine already applies, made visible
      cue: (e?.cues ?? [])[0] ?? null,
      equipment: e?.equipment ?? null,
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
    };
  });
  // comeback: the layoff ease (0.88×) is a deliberate deload of its own — the
  // client tags this session's sets `deload` so the eased weights never enter
  // the e1RM/stall trends as a fabricated ~12% strength loss.
  // A taper supersedes the block card entirely (they'd otherwise show two
  // conflicting "here's why volume changed this week" explanations at once).
  return { index: idx, day_number: sessions.length + 1, name: templateSession.name, program_name: program.name, exercises, coach_note, readiness: readiness?.level ?? null, block: taper ? null : block, taper: taper ? { days_until: taper.daysUntil, note: taper.note } : null, comeback: layoffDays >= COMEBACK_GAP_DAYS, beginner };
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
    if (pr.kind === "e1rm") wins.push({ kind: "pr", name: name(pr.exercise), e1rm_kg: pr.e1rm_kg, delta_kg: pr.delta_kg });
    else if (pr.kind === "load") wins.push({ kind: "pr-load", name: name(pr.exercise), load_kg: pr.load_kg, reps: pr.reps });
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

// The Progress tab payload: everything derived, nothing asked.
// AUTO-TUNE binder (#2): fold the just-completed block's response into the running
// per-muscle volume adjustment. Called at each mesocycle boundary so the NEXT block
// is generated with volumeAdjust applied — a muscle that keeps stalling gets more
// volume over time, one at its ceiling gets eased, all bounded to MEV↔MRV. Pure
// derive-core does the math; this just resolves the muscle index + stalled muscles.
export function computeVolumeAdjust(prevAdjust, sessions, customEx = [], context = {}) {
  const { index } = resolveEx(customEx);
  const weekly = perMuscleWeeklyVolume(sessions, index);
  const weeks = Object.keys(weekly).sort();
  if (!weeks.length) return prevAdjust || {};
  // Sample each muscle's PEAK weekly volume over the recent block — NOT the last
  // logged week. A mesocycle ends on a DELOAD (~half volume), so sampling the latest
  // week would make every "at/over the recoverable ceiling → ease" branch unreachable
  // (deload volume is always well below MAV.max), leaving the tune able only to
  // ratchet UP. Peak volume reflects the working load the muscle actually stalled at.
  const recent = weeks.slice(-6);
  const peak = {};
  for (const wk of recent) for (const [m, sets] of Object.entries(weekly[wk] ?? {})) peak[m] = Math.max(peak[m] ?? 0, sets);
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
  const { checkins = [], bodyweights = [], goal = null } = context;
  const bwSeries = bodyweights.map((b) => ({ date: b.date, bodyweight_kg: b.kg }));
  const energyBalance = classifyEnergyBalance(bodyweightTrend(bwSeries), goal);
  const recovery = recoverySignal(checkins, energyBalance);
  return deriveVolumeAdjust(prevAdjust || {}, peak, muscleIndex, stalledMuscleIds, recovery);
}

export function progressReport(user, sessions, bodyweights, customEx = [], now = null) {
  const { index, name } = resolveEx(customEx);
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
  const nowWeek = now ? isoWeekKey(now) : null;
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
  } else if (newest) {
    latest = newest;
    volume_note = "Your recent weeks are deloads — volume is intentionally low, exactly as planned.";
  }
  const volume = latest ? volumeVsLandmarks(weekly[latest], muscleIndex) : {};
  // Specialization honesty: a muscle the plan deliberately holds at its
  // maintenance dose is "holding steady", not "add volume" — the client's
  // s-maint status/legend exist for exactly this (they were never emitted).
  const maintIds = new Set(Object.entries(user.plan_rationale?.volume_by_muscle ?? {}).filter(([, r]) => r.maintenance).map(([id]) => id));
  const volumeByMuscle = Object.entries(volume).map(([id, v]) => ({ muscle: muscleById.get(id)?.name ?? id, id, sets: v.sets, status: maintIds.has(id) && v.status === "below-MEV" ? "maintenance" : v.status }))
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
  const adaptive = latest ? volumeResponse(weekly[latest], muscleIndex, stalledMuscleIds)
    .filter((a) => a.signal !== "hold") // surface only the actionable adjustments
    .filter((a) => !maintIds.has(a.muscle)) // never tell a specialization user to "add" to a deliberately-held muscle
    .map((a) => ({ ...a, muscle_name: muscleById.get(a.muscle)?.name ?? a.muscle })) : [];
  // Stalled lifts are pinned into the list — a plateau must never scroll out of sight.
  const allProg = progressionByExercise(sessions, index).filter((p) => p.weeks > 1);
  const progression = [...allProg.filter((p) => stalledIds.has(p.exercise)), ...allProg.filter((p) => !stalledIds.has(p.exercise))]
    .slice(0, 8)
    .map((p) => ({ ...p, stalled: stalledIds.has(p.exercise) }));
  const bwSeries = bodyweights.map((b) => ({ date: b.date, bodyweight_kg: b.kg }));
  const trend = bodyweightTrend(bwSeries);
  const energy = classifyEnergyBalance(trend, user.profile.primary_goal);
  // Personal-record history (roadmap #1c): the full PR list for a count, plus the most
  // recent few for a lookback "wins" feed. Structured (weights, not pre-baked strings) so
  // the client renders in the user's unit.
  const prHistory = allPersonalRecords(sessions);
  const personal_records = prHistory.slice(0, 8).map((pr) => ({ ...pr, name: name(pr.exercise) }));
  return { sessions_logged: sessions.length, bodyweights_logged: bodyweights.length, latest_week: latest ?? null, volume_note, volumeByMuscle, progression, stalls, adaptive, bodyweight_trend: trend, energy_balance: energy, personal_records, pr_count: prHistory.length };
}
