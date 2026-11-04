// Thin binder: feeds the bundled KB into the pure generative engine. Mirrors how
// coach.mjs binds derive-core. Runs unchanged on Node and Cloudflare Workers.
import { exercises, muscles, contraindications, guidelines } from "./kb-data.mjs";
import { contraRegion, generatePlan, timeFitOptions, timeFitQuestion, SPEC_MAX_BLOCKS, critiquePlan, accessibleExercises, explainPersonalization, specializationActive, bestSubstitutes, easierSubstitutes, applySubstitution, sweepDanglingSupersets, contentSig } from "../../tools/plan-core.mjs";

const KB = { exercises, muscles, contraindications, guidelines };

export function generateUserPlan(profile, opts = {}) {
  return generatePlan(profile, KB, opts);
}

// THE THREE WAYS BACK, measured when Today asks (W305c, Burst 8 review #13 #14 #26 #39) — once stored at build time,
// which left a legacy plan with none, a swapped plan with the old plan's numbers, and a later block's card unseen. From
// the plan the user HAS, against alternatives built exactly as the button's rebuild builds them (rebuildPlan for a
// schedule change: block 0, the per-muscle tune kept, a finished specialization block stays finished, today's stalls).
// Two generatePlan runs (~0.35 ms each); deterministic for the same stored plan.
export function userTimeFit(user, { stalledExercises = [] } = {}) {
  if (!user?.program?.sessions?.length || user.program.custom) return null;
  const tune = { volumeAdjust: user.plan_meta?.volume_adjust ?? {}, stalledExercises,
    specSpent: !!user.plan_meta?.spec_spent || (user.plan_meta?.block_index ?? 0) >= SPEC_MAX_BLOCKS };
  // A schedule change rebuilds at block 0; a REFIT (a plan from an older engine, no change asked) rebuilds at the
  // CURRENT block — rebuildPlan's cosmetic path (W305h, fix C2).
  return timeFitOptions(user.profile ?? {}, KB, { program: user.program, rationale: user.plan_rationale ?? null, meta: user.plan_meta ?? null },
    planOptsFor(user, { blockIndex: 0, ...tune }), { customExercises: user.custom_exercises || [], refitOpts: planOptsFor(user, { blockIndex: user.plan_meta?.block_index ?? 0, ...tune }) });
}
// The question alone — the plan as it is, no alternatives — for the keep door and the explanation (W305h, C0/C10, K0).
export function userTimeFitQuestion(user) {
  if (!user?.program?.sessions?.length || user.program.custom) return null;
  return timeFitQuestion(user.profile ?? {}, KB, { program: user.program, rationale: user.plan_rationale ?? null, meta: user.plan_meta ?? null },
    { customExercises: user.custom_exercises || [] });
}

// The user-derived generatePlan opts every door shares (W301, considerations iteration — Burst 7). One place, so a
// door can never forget one: the injury door alone omitted specSpent and re-armed a FINISHED specialization block
// after a schedule rebuild. Door-specific values (blockIndex, volumeAdjust, stalledExercises) and a door's deliberate
// override (rebuildPlan's own specSpent: new priorities start a new block) ride in `extra`, which wins. Later
// per-user inputs (the learned session cap, preference scores) join here, so every door — and every forecast of
// the next plan — sees them at once.
export function planOptsFor(user, extra = {}) {
  return { ...(user?.plan_meta?.spec_spent === true ? { specSpent: true } : {}), ...extra };
}

// "Can't do this one?" (W272): ranked replacements for one lift, and the permanent
// swap — bound to the bundled KB and the user's OWN profile, plan, rationale, custom
// lifts and block (specialization ordering depends on where they are in it).
export function userSubstitutes(user, exId, { sessionName = null, stalled = [], live = null, scope = "always", exclude = [] } = {}) {
  return bestSubstitutes(exId, { profile: user.profile, kb: KB, program: user.program, rationale: user.plan_rationale ?? null,
    sessionName, stalled, live, scope, exclude, customExercises: user.custom_exercises || [] });
}
// The fitting substitutes that are easier on a tired body (Burst 6), easiest first — the custom library bound in.
export function userEasierSubstitutes(user, exId, fitting, known = []) {
  return easierSubstitutes(fitting, exId, { kb: KB, customExercises: user.custom_exercises || [], known });
}
export function userApplySubstitution(user, exId, { sessionName = null, stalled = [] } = {}) {
  return applySubstitution(user.program, user.plan_rationale ?? null, exId, { profile: user.profile, kb: KB, stalled, sessionName,
    customExercises: user.custom_exercises || [], blockIndex: user.plan_meta?.block_index ?? 0, specSpent: !!user.plan_meta?.spec_spent });
}
export { sweepDanglingSupersets, contentSig };

// Is this profile running an all-in specialization block? Bound here because the
// answer needs the KB's muscle→area groups, and because there must be exactly ONE
// answer: Wave 179 made specialization DERIVED but left `/api/today`'s volume-auto-tune
// gate reading the raw `profile.specialization` field. A derived-specialization user
// has no stored field at all, so that read was falsy for every account created since —
// and the tune it was supposed to freeze went on folding in the "stalls" of muscles the
// block deliberately holds at maintenance, spuriously bumping their targets, which then
// land the moment specialization ends. Precisely the failure that gate's own comment
// describes. Anything asking "is this user specializing?" must come through here.
// `blockIndex` is required, not optional-with-a-default, because a specialization block
// EXPIRES (plan-core's SPEC_MAX_BLOCKS): the answer is a function of where the user is in
// their mesocycle, and a caller that forgets it would silently freeze the volume auto-tune
// forever for anyone who ever picked a priority muscle — the same class of bug as reading
// the raw `profile.specialization` field this helper was created to replace.
// …and a SPENT block (plan_meta.spec_spent — a schedule rebuild resets block_index to 0) is not specializing (W301b
// review: ignoring the flag froze the block-boundary tune for a whole block after a days or equipment change).
export function isSpecializing(profile, blockIndex, spent = false) {
  return specializationActive(profile, muscles, blockIndex, spent === true);
}

// "What your answers changed" — read straight off the plan the engine just built, so
// the explanation and the program can never disagree about what was done.
export function explainUserPlan(profile, rationale, program, live = null) {
  return explainPersonalization(profile, rationale, program, live);
}

// KB critique of any program (generated or user-built), including the user's
// custom exercises so a plan that uses them is scored correctly.
export function critiqueUserPlan(program, customEx = [], experience = "intermediate", priority = [], generated = false, sessionMinutes = null, trimmed = null) {
  return critiquePlan(program, { exercises: [...exercises, ...customEx], muscles }, { experience, priority, generated, sessionMinutes, trimmed });
}

// The exercises a user may swap into / add — equipment + injury filtered — plus
// their own custom exercises (always theirs to use).
// Which reported injury rules this lift out (null when none does) — a swap's "why" (W283 review).
export function injuryRegionFor(profile, exId) {
  const ex = exercises.find((e) => e.id === exId);
  return ex ? contraRegion(ex, profile?.injuries ?? [], contraindications) : null;
}

export function userExercises(profile, customEx = []) {
  return [...accessibleExercises(profile, { exercises, contraindications }), ...customEx];
}

export { exercises as kbExercises, muscles as kbMuscles };
