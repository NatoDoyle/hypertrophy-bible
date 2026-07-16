// Thin binder: feeds the bundled KB into the pure generative engine. Mirrors how
// coach.mjs binds derive-core. Runs unchanged on Node and Cloudflare Workers.
import { exercises, muscles, contraindications } from "./kb-data.mjs";
import { generatePlan } from "../../tools/plan-core.mjs";

export function generateUserPlan(profile) {
  return generatePlan(profile, { exercises, muscles, contraindications });
}
