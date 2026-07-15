// KB access layer: builds the derive-engine's Maps from the bundled data and
// selects a program template. No filesystem — portable to Node and Workers.
import { exercises, muscles, programs } from "./kb-data.mjs";

// Rich exercise lookup for the app UI (cues, equipment, muscles).
export const exerciseById = new Map(exercises.map((e) => [e.id, e]));
export const muscleById = new Map(muscles.map((m) => [m.id, m]));

// Lean Maps in the exact shape derive-core expects.
export const exIndex = new Map(
  exercises.map((e) => [e.id, { name: e.name, primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] }])
);
export const muscleIndex = new Map(muscles.map((m) => [m.id, m.landmarks ?? null]));

export { programs };
export const programById = new Map(programs.map((p) => [p.id, p]));

// Pick the best program for a profile. Scores by days match, experience match,
// and avoids specialization blocks as a default.
export function selectProgram({ days_per_week, training_status }) {
  let best = null, bestScore = Infinity;
  for (const p of programs) {
    let score = 0;
    score += Math.abs((p.days_per_week ?? 3) - (days_per_week ?? 3)) * 10;
    if (!(p.experience_level ?? []).includes(training_status)) score += 5;
    if (/special/i.test(p.id)) score += 100; // never a default
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best ?? programs.find((p) => p.id === "beginner-full-body-3day") ?? programs[0];
}

// Human-friendly exercise name.
export const exerciseName = (id) => exerciseById.get(id)?.name ?? id;
