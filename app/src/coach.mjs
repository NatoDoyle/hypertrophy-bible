// The coach: decides today's session and prefills every weight, so the user just
// confirms and taps Done. Reuses the KB's derive-core engine for all derivations.
import {
  estimate1RM, countsForE1RM, perMuscleWeeklyVolume, volumeVsLandmarks, progressionByExercise,
  bodyweightTrend, classifyEnergyBalance, proximityFromRepDropoff, stallDetect,
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

// Best estimated 1RM for an exercise across the given sessions — reliable sets only.
// Uses derive-core's countsForE1RM so this and the Progress screen's progression
// trend can never disagree about what counts as a strength number.
const bestE1RM = (sessions, exId) =>
  Math.max(0, ...workingSetsFor(sessions, exId)
    .filter(countsForE1RM)
    .map((set) => estimate1RM(set.weight_kg, set.reps).e1rm));

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

// A gap this long since an exercise was last trained triggers a deload on return —
// coming back heavier than you left is how people get hurt after a layoff.
// EXPORTED because the adherence engine's "welcome back — I've eased your weights"
// message must fire at exactly the same threshold; a hardcoded copy drifted once
// (10 vs 12 days) and the app promised eased weights while prescribing heavier.
export const COMEBACK_GAP_DAYS = 12;
const COMEBACK_DELOAD = 0.88; // ease ~12% and let it climb back as it feels easy

// Double progression: hit the top of the range on every set last time -> add load;
// otherwise keep the load and aim to add reps. First time -> no suggestion (user picks).
// `now` (ISO) enables layoff-aware deloading so the "I eased your weights" copy is true.
export function suggestWeight(sessions, exId, repRange, byId = exerciseById, now = null) {
  const last = lastSetsForExercise(sessions, exId);
  const { max } = parseRange(repRange);
  if (!last) return { suggested_kg: null, note: "First time — pick a weight where the last rep is ~2–3 reps from failure." };
  const lastWeight = last.sets[0].weight_kg;
  const allHitTop = last.sets.every((s) => s.reps >= max);
  const base = { last_kg: lastWeight, last_reps: last.sets.map((s) => s.reps) };
  // Layoff deload: if it's been a while, ease the load and suppress the progression
  // bump — overrides everything below so a comeback never loads heavier than before.
  const layoffDays = now && last.date ? Math.round((+new Date(now) - +new Date(last.date)) / 86400000) : 0;
  if (layoffDays >= COMEBACK_GAP_DAYS) {
    const eased = Math.round(lastWeight * COMEBACK_DELOAD * 4) / 4;
    return { suggested_kg: eased, note: `It's been ${layoffDays} days — I eased this to ${eased} kg so you ramp back in safely. Add load as it feels easy.`, layoff_days: layoffDays, ...base };
  }
  // RIR autoregulation (only when effort was logged): lots left in the tank -> go up.
  const rirs = last.sets.map((s) => s.rir).filter((r) => typeof r === "number");
  if (rirs.length) {
    const avgRir = rirs.reduce((a, b) => a + b, 0) / rirs.length;
    if (avgRir >= 3) {
      const inc = loadIncrement(exId, byId) * (avgRir >= 4 ? 2 : 1);
      return { suggested_kg: Math.round((lastWeight + inc) * 4) / 4, note: `You left ~${Math.round(avgRir)} reps in reserve last time — add ${inc} kg.`, ...base };
    }
    if (avgRir <= 0 && !allHitTop) return { suggested_kg: lastWeight, note: "You hit failure last time — keep the weight and build reps first.", ...base };
  }
  if (allHitTop) {
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
      ? `Deload week — about half the sets, a little lighter, and stop 3–4 reps shy of failure. Recovery is where the growth you've built this block shows up.`
      : phase === "peak"
        ? `Week ${week} of ${BLOCK_WEEKS} — peak volume. Push your sets hard (1–2 in the tank); the deload is coming.`
        : `Week ${week} of ${BLOCK_WEEKS} — building. Volume ramps up each week toward your peak.`,
  };
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
export function buildToday(user, sessions, readiness = null, customEx = [], now = null) {
  const { byId, name } = resolveEx(customEx);
  const program = user.program;
  // Where are we in the mesocycle? (null for beginners — flat, simple weeks.)
  const block = blockPhase(now, user.plan_meta?.block_start ?? user.created_at, user.profile?.training_status);
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
    coach_note = "You're fresh today — if a lift feels easy, add a back-off set.";
  } else if (readiness) {
    // The common case must never be silent: a user who checked in and saw nothing
    // change concludes it didn't work. Acknowledge, then confirm the plan stands.
    coach_note = "Checked in ✓ — you're in your normal range, so today's session stands as planned.";
  }
  // A fresh mesocycle rotated the accessories — say so ONCE (until a session is
  // logged under the new block), so the changed exercise list never feels random.
  const rotatedAt = user.plan_meta?.rotated_at;
  if (rotatedAt && !sessions.some((s) => s.date && s.date > rotatedAt)) {
    const msg = "New block — I rotated your accessory exercises for fresh stimulus. Your main lifts stay, so your progression carries over.";
    coach_note = coach_note ? `${msg} ${coach_note}` : msg;
  }
  // Layoff → the suggested weights below are actually eased; say so honestly, so the
  // Coach's "welcome back — I eased your weights" claim matches what's on the card.
  const lastSessionMs = Math.max(0, ...sessions.filter((s) => s.date).map((s) => +new Date(s.date)));
  const layoffDays = now && lastSessionMs ? Math.round((+new Date(now) - lastSessionMs) / 86400000) : 0;
  if (layoffDays >= COMEBACK_GAP_DAYS) {
    const welcome = `Welcome back — it's been ${layoffDays} days, so I eased today's weights to ramp you in safely. They'll climb again fast.`;
    coach_note = coach_note ? `${welcome} ${coach_note}` : welcome;
  }
  const exercises = templateExercises.map((ex) => {
    const e = byId.get(ex.exercise);
    const sug = suggestWeight(sessions, ex.exercise, ex.rep_range, byId, now);
    // Apply the mesocycle wave: sets scale with the block week (never below 1);
    // on a deload the suggested load also eases ~10% so effort genuinely drops.
    const sets = block ? Math.max(1, Math.round(ex.sets * block.setScale)) : ex.sets;
    // Deload load must ease from last week's ACTUAL weight, not the progressed
    // suggestion — otherwise the +load bump (or an RIR-in-the-tank double bump) can
    // make the "~10% lighter" deload come out as heavy as, or heavier than, the peak
    // week (e.g. (40+5)*0.9 = 40.5 > 40). Anchor on `last_kg` and take the MIN with
    // whatever suggestWeight already returned, so a deload can never be heavier than
    // the prior real week and never undoes a lighter ease (a layoff comeback at
    // 0.88× stays at 0.88×, not bumped back up to 0.9×).
    const suggested_kg = block?.phase === "deload" && sug.suggested_kg != null
      ? Math.min(sug.suggested_kg, Math.round((sug.last_kg ?? sug.suggested_kg) * 0.9 * 4) / 4)
      : sug.suggested_kg;
    return {
      exercise: ex.exercise,
      name: name(ex.exercise),
      sets,
      rep_range: ex.rep_range,
      rir: block?.phase === "deload" ? "3-4" : ex.rir ?? "1-3",
      primary_muscles: e?.primary_muscles ?? [], // slugs — the client renders friendly labels
      unilateral: !!e?.unilateral,               // → "each side", so a novice doesn't do half the work
      lengthened_bias: !!e?.lengthened_bias,     // → "stretch-focused" tag; the science the engine already applies, made visible
      cue: (e?.cues ?? [])[0] ?? null,
      equipment: e?.equipment ?? null,
      suggested_kg,
      suggestion_note: sug.note,
      ...(ex.superset_with ? { superset_with: ex.superset_with, superset_with_name: name(ex.superset_with) } : {}),
    };
  });
  return { index: idx, day_number: sessions.length + 1, name: templateSession.name, program_name: program.name, exercises, coach_note, readiness: readiness?.level ?? null, block };
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

  // PRs (estimated 1RM) per exercise in the new session.
  const seen = new Set();
  for (const set of newSession.sets ?? []) {
    if ((set.set_type ?? "work") !== "work" || seen.has(set.exercise)) continue;
    seen.add(set.exercise);
    const newBest = bestE1RM([newSession], set.exercise);
    const priorBest = bestE1RM(prior, set.exercise);
    // Require a real margin (>0.5 kg) so estimator noise isn't dressed up as a PR.
    // Structured (not a pre-baked "N kg" string) so the client renders the reward
    // in the unit the user actually chose — a lb user's PR shouldn't arrive in kg.
    if (priorBest > 0 && newBest - priorBest > 0.5) {
      wins.push({ kind: "pr", name: name(set.exercise), e1rm_kg: newBest, delta_kg: Math.round((newBest - priorBest) * 10) / 10 });
    }
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

  if (!wins.length) wins.push("✅ Session logged. Consistency is what builds muscle — see you next time.");
  return { day_number: allSessions.length, wins };
}

// The Progress tab payload: everything derived, nothing asked.
export function progressReport(user, sessions, bodyweights, customEx = []) {
  const { index } = resolveEx(customEx);
  const weekly = perMuscleWeeklyVolume(sessions, index);
  const weeks = Object.keys(weekly).sort();
  const latest = weeks[weeks.length - 1];
  const volume = latest ? volumeVsLandmarks(weekly[latest], muscleIndex) : {};
  const volumeByMuscle = Object.entries(volume).map(([id, v]) => ({ muscle: muscleById.get(id)?.name ?? id, id, sets: v.sets, status: v.status }))
    .sort((a, b) => b.sets - a.sets);
  const stalls = stallDetect(sessions, index);
  const stalledIds = new Set(stalls.map((x) => x.exercise));
  // Stalled lifts are pinned into the list — a plateau must never scroll out of sight.
  const allProg = progressionByExercise(sessions, index).filter((p) => p.weeks > 1);
  const progression = [...allProg.filter((p) => stalledIds.has(p.exercise)), ...allProg.filter((p) => !stalledIds.has(p.exercise))]
    .slice(0, 8)
    .map((p) => ({ ...p, stalled: stalledIds.has(p.exercise) }));
  const bwSeries = bodyweights.map((b) => ({ date: b.date, bodyweight_kg: b.kg }));
  const trend = bodyweightTrend(bwSeries);
  const energy = classifyEnergyBalance(trend, user.profile.primary_goal);
  return { sessions_logged: sessions.length, bodyweights_logged: bodyweights.length, latest_week: latest ?? null, volumeByMuscle, progression, stalls, bodyweight_trend: trend, energy_balance: energy };
}
