// Thin binder: feeds the bundled KB into the pure generative engine. Mirrors how
// coach.mjs binds derive-core. Runs unchanged on Node and Cloudflare Workers.
import { exercises, muscles, contraindications } from "./kb-data.mjs";
import { generatePlan, critiquePlan, accessibleExercises } from "../../tools/plan-core.mjs";

export function generateUserPlan(profile, opts = {}) {
  return generatePlan(profile, { exercises, muscles, contraindications }, opts);
}

// KB critique of any program (generated or user-built), including the user's
// custom exercises so a plan that uses them is scored correctly.
export function critiqueUserPlan(program, customEx = [], experience = "intermediate") {
  return critiquePlan(program, { exercises: [...exercises, ...customEx], muscles }, { experience });
}

// The exercises a user may swap into / add — equipment + injury filtered — plus
// their own custom exercises (always theirs to use).
export function userExercises(profile, customEx = []) {
  return [...accessibleExercises(profile, { exercises, contraindications }), ...customEx];
}

export { exercises as kbExercises, muscles as kbMuscles };
