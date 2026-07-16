// Thin binder: feeds the bundled KB into the pure generative engine. Mirrors how
// coach.mjs binds derive-core. Runs unchanged on Node and Cloudflare Workers.
import { exercises, muscles, contraindications } from "./kb-data.mjs";
import { generatePlan, critiquePlan } from "../../tools/plan-core.mjs";

export function generateUserPlan(profile) {
  return generatePlan(profile, { exercises, muscles, contraindications });
}

// KB critique of any program (generated or user-built), including the user's
// custom exercises so a plan that uses them is scored correctly.
export function critiqueUserPlan(program, customEx = []) {
  return critiquePlan(program, { exercises: [...exercises, ...customEx], muscles });
}

export { exercises as kbExercises, muscles as kbMuscles };
