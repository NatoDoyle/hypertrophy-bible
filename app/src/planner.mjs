// Thin binder: feeds the bundled KB into the pure generative engine. Mirrors how
// coach.mjs binds derive-core. Runs unchanged on Node and Cloudflare Workers.
import { exercises, muscles, contraindications, guidelines } from "./kb-data.mjs";
import { generatePlan, critiquePlan, accessibleExercises, explainPersonalization, deriveSpecialization } from "../../tools/plan-core.mjs";

export function generateUserPlan(profile, opts = {}) {
  return generatePlan(profile, { exercises, muscles, contraindications, guidelines }, opts);
}

// Is this profile running an all-in specialization block? Bound here because the
// answer needs the KB's muscle→area groups, and because there must be exactly ONE
// answer: Wave 179 made specialization DERIVED but left `/api/today`'s volume-auto-tune
// gate reading the raw `profile.specialization` field. A derived-specialization user
// has no stored field at all, so that read was falsy for every account created since —
// and the tune it was supposed to freeze went on folding in the "stalls" of muscles the
// block deliberately holds at maintenance, spuriously bumping their targets, which then
// land the moment specialization ends. Precisely the failure that gate's own comment
// describes. Anything asking "is this user specializing?" must come through here.
export function isSpecializing(profile) {
  return deriveSpecialization(profile, muscles);
}

// "What your answers changed" — read straight off the plan the engine just built, so
// the explanation and the program can never disagree about what was done.
export function explainUserPlan(profile, rationale, program) {
  return explainPersonalization(profile, rationale, program);
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
