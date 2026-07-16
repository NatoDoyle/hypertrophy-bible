// The coach: decides today's session and prefills every weight, so the user just
// confirms and taps Done. Reuses the KB's derive-core engine for all derivations.
import {
  estimate1RM, perMuscleWeeklyVolume, volumeVsLandmarks, progressionByExercise,
  bodyweightTrend, classifyEnergyBalance, proximityFromRepDropoff,
} from "../../tools/derive-core.mjs";
import { exIndex, muscleIndex, exerciseById, exerciseName, muscleById } from "./kb.mjs";

const parseRange = (s) => {
  const m = String(s ?? "8-12").match(/(\d+)\s*-\s*(\d+)/);
  return m ? { min: +m[1], max: +m[2] } : { min: 8, max: 12 };
};
const loadIncrement = (exId) => {
  const e = exerciseById.get(exId);
  if (!e) return 2.5;
  if (e.mechanic === "isolation" && (e.equipment === "dumbbell" || e.equipment === "cable")) return 1;
  return 2.5;
};

// All working sets of an exercise from a flat list of sessions, newest last.
const workingSetsFor = (sessions, exId) =>
  sessions.flatMap((s) => (s.sets ?? []).filter((set) => set.exercise === exId && (set.set_type ?? "work") === "work"));

// Best estimated 1RM for an exercise across the given sessions.
const bestE1RM = (sessions, exId) =>
  Math.max(0, ...workingSetsFor(sessions, exId).map((set) => estimate1RM(set.weight_kg, set.reps).e1rm));

// The most recent session that contained this exercise (for progression).
function lastSetsForExercise(sessions, exId) {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const sets = (sessions[i].sets ?? []).filter((s) => s.exercise === exId && (s.set_type ?? "work") === "work");
    if (sets.length) return sets;
  }
  return null;
}

// Double progression: hit the top of the range on every set last time -> add load;
// otherwise keep the load and aim to add reps. First time -> no suggestion (user picks).
export function suggestWeight(sessions, exId, repRange) {
  const last = lastSetsForExercise(sessions, exId);
  const { max } = parseRange(repRange);
  if (!last) return { suggested_kg: null, note: "First time — pick a weight where the last rep is ~2–3 reps from failure." };
  const lastWeight = last[0].weight_kg;
  const allHitTop = last.every((s) => s.reps >= max);
  if (allHitTop) {
    return { suggested_kg: Math.round((lastWeight + loadIncrement(exId)) * 4) / 4, note: `Last time you hit the top of the range — add ${loadIncrement(exId)} kg.`, last_kg: lastWeight, last_reps: last.map((s) => s.reps) };
  }
  return { suggested_kg: lastWeight, note: "Keep the weight and try to add a rep or two.", last_kg: lastWeight, last_reps: last.map((s) => s.reps) };
}

// Which program session is due today (simple rotation by sessions completed).
export function nextSessionIndex(program, sessionCount) {
  const n = program.sessions.length;
  return ((sessionCount % n) + n) % n;
}

// Build today's session card: every exercise pre-filled with a suggested weight.
export function buildToday(user, sessions) {
  const program = user.program;
  // Rotate by sessions of THIS program only, so merged sessions from a different
  // program (e.g. an earlier device) don't phase-shift the cycle.
  const rotCount = sessions.filter((s) => !s.program_ref || s.program_ref === program.id).length;
  const idx = nextSessionIndex(program, rotCount);
  const templateSession = program.sessions[idx];
  const exercises = templateSession.exercises.map((ex) => {
    const e = exerciseById.get(ex.exercise);
    const sug = suggestWeight(sessions, ex.exercise, ex.rep_range);
    return {
      exercise: ex.exercise,
      name: exerciseName(ex.exercise),
      sets: ex.sets,
      rep_range: ex.rep_range,
      rir: ex.rir ?? "1-3",
      primary_muscles: (e?.primary_muscles ?? []).map((m) => muscleById.get(m)?.name ?? m),
      cue: (e?.cues ?? [])[0] ?? null,
      equipment: e?.equipment ?? null,
      suggested_kg: sug.suggested_kg,
      suggestion_note: sug.note,
    };
  });
  return { index: idx, day_number: sessions.length + 1, name: templateSession.name, program_name: program.name, exercises };
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
export function sessionRecap(user, allSessions, newSession) {
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
    if (newBest > priorBest && priorBest > 0) {
      wins.push(`🏆 ${exerciseName(set.exercise)}: new estimated 1RM of ${newBest} kg (+${Math.round((newBest - priorBest) * 10) / 10}).`);
    }
  }

  // Proximity to failure inferred from rep drop-off.
  const prox = proximityFromRepDropoff(newSession);
  const closeToFailure = Object.entries(prox).filter(([, v]) => v.inferred === "trained-close-to-failure");
  if (closeToFailure.length) {
    const ex = closeToFailure[0][0].split("@")[0];
    wins.push(`🔥 You trained ${exerciseName(ex)} close to failure — that's where growth happens.`);
  }

  // Weekly per-muscle volume vs the KB's landmarks.
  const weekly = perMuscleWeeklyVolume(allSessions, exIndex);
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
export function progressReport(user, sessions, bodyweights) {
  const weekly = perMuscleWeeklyVolume(sessions, exIndex);
  const weeks = Object.keys(weekly).sort();
  const latest = weeks[weeks.length - 1];
  const volume = latest ? volumeVsLandmarks(weekly[latest], muscleIndex) : {};
  const volumeByMuscle = Object.entries(volume).map(([id, v]) => ({ muscle: muscleById.get(id)?.name ?? id, id, sets: v.sets, status: v.status }))
    .sort((a, b) => b.sets - a.sets);
  const progression = progressionByExercise(sessions, exIndex).filter((p) => p.weeks > 1).slice(0, 8);
  const bwSeries = bodyweights.map((b) => ({ date: b.date, bodyweight_kg: b.kg }));
  const trend = bodyweightTrend(bwSeries);
  const energy = classifyEnergyBalance(trend, user.profile.primary_goal);
  return { sessions_logged: sessions.length, bodyweights_logged: bodyweights.length, latest_week: latest ?? null, volumeByMuscle, progression, bodyweight_trend: trend, energy_balance: energy };
}
