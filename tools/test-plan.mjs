// Unit tests for the generative plan engine (tools/plan-core.mjs), run against
// the REAL knowledge base so the invariants hold on shipping data.
import { readdirSync, readFileSync } from "node:fs";
import { generatePlan, chooseSplit, targetWeeklySets, critiquePlan, deriveSpecialization, specializationActive, SPEC_MAX_BLOCKS, explainPersonalization,
  accessibleExercises, candidatePool, bestSubstitutes, easierSubstitutes, applySubstitution, orderSessionItems, contraRegion, volumeLevers, timeFitOptions, FIT_GRACE_MIN } from "./plan-core.mjs";
import { sessionMinutes as dayMinutes } from "./derive-core.mjs";
import { volumeVsLandmarks } from "./derive-core.mjs";
import { perMuscleWeeklyVolume } from "./derive-core.mjs";

const load = (d) => readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`${d}/${f}`)));
const exercises = load("data/exercises");
const muscles = load("data/muscles");
const contraindications = JSON.parse(readFileSync("data/injury-contraindications.json"));
const registry = new Set(JSON.parse(readFileSync("citations/registry.json")).citations.map((c) => c.key));
const exIds = new Set(exercises.map((e) => e.id));
const guidelines = load("data/guidelines");
const kb = { exercises, muscles, contraindications, guidelines };
const muscleById = new Map(muscles.map((m) => [m.id, m]));

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)); };

// --- split selection ---
const s4 = chooseSplit({ days_per_week: 4, training_status: "intermediate" });
ok("4d intermediate → upper-lower, 4 sessions", s4.split === "upper-lower" && s4.sessions.length === 4);
ok("6d → push-pull-legs, 6 sessions", chooseSplit({ days_per_week: 6, training_status: "advanced" }).split === "push-pull-legs");
ok("2d → full-body", chooseSplit({ days_per_week: 2, training_status: "beginner" }).split === "full-body");

// --- volume target math (side-delts: mev8 mav12-20 mrv24-26) ---
const sd = muscleById.get("side-delts").landmarks;
ok("beginner → MEV.min (8)", targetWeeklySets(sd, { experience: "beginner", isPriority: false }).target === 8);
ok("intermediate → bottom of MAV (12) — mid-MAV summed targets were undeliverable in a capped week", targetWeeklySets(sd, { experience: "intermediate", isPriority: false }).target === 12);
ok("advanced → MAV.max (20)", targetWeeklySets(sd, { experience: "advanced", isPriority: false }).target === 20);
ok("intermediate priority → ×1.3 (16)", targetWeeklySets(sd, { experience: "intermediate", isPriority: true }).target === 16);
const chestLm = muscleById.get("chest").landmarks;
ok("target never exceeds MRV.max", targetWeeklySets(chestLm, { experience: "advanced", isPriority: true }).target <= chestLm.mrv.max);

// --- full generated plan (intermediate, hypertrophy, 4d, full gym + bodyweight, priority side-delts) ---
const profile = { user_id: "test-1", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], priority_muscles: ["side-delts"], session_length_min: 60 };
const p = generatePlan(profile, kb);
const allEx = p.program.sessions.flatMap((s) => s.exercises);
ok("program id matches ^[a-z0-9-]+$", /^[a-z0-9-]+$/.test(p.program.id));
ok("split is a valid enum value", ["full-body", "upper-lower", "push-pull-legs", "body-part", "push-pull", "other"].includes(p.program.split));
ok("every exercise id resolves to a real exercise", allEx.every((e) => exIds.has(e.exercise)));
ok("every set count is 1-10", allEx.every((e) => Number.isInteger(e.sets) && e.sets >= 1 && e.sets <= 10));

// --- Daily Undulating Periodization: auto-derived smart default (roadmap #9 + Goal 2) ---
const mechOf = (id) => exercises.find((x) => x.id === id)?.mechanic;
const compoundRanges = (plan) => new Set(plan.program.sessions.flatMap((s) => s.exercises).filter((e) => mechOf(e.exercise) === "compound").map((e) => e.rep_range));
// Advanced + muscle-building goal auto-undulates with NO flag set (minimal customization).
const advAuto = compoundRanges(generatePlan({ ...profile, days_per_week: 6, training_status: "advanced" }, kb));
ok("DUP smart default: an advanced hypertrophy profile auto-undulates (>=2 bands incl. heavy 4-6), no flag", advAuto.size >= 2 && advAuto.has("4-6"));
// Regression: DUP must vary PER ARCHETYPE, not just plan-wide — a 6-day PPL split
// (Push A/Push B, ...) repeats every archetype at an interval that evenly divides
// the 3-band cycle, so a bug keying the band off the session's absolute index
// (rather than its occurrence within its own archetype) made every repeat of the
// SAME muscle group land on the identical band while the plan-wide set still
// looked diverse (Push ≠ Pull ≠ Legs) — the check above couldn't catch it.
const bandsByName = (plan) => Object.fromEntries(plan.program.sessions.map((s) => [s.name, new Set(s.exercises.filter((e) => mechOf(e.exercise) === "compound").map((e) => e.rep_range))]));
const adv6 = bandsByName(generatePlan({ ...profile, days_per_week: 6, training_status: "advanced" }, kb));
ok("DUP per-archetype: Push A and Push B use different compound bands", [...adv6["Push A"]].join() !== [...adv6["Push B"]].join());
ok("DUP per-archetype: Pull A and Pull B use different compound bands", [...adv6["Pull A"]].join() !== [...adv6["Pull B"]].join());
ok("DUP per-archetype: Legs A and Legs B use different compound bands", [...adv6["Legs A"]].join() !== [...adv6["Legs B"]].join());
// A split where no archetype repeats (5-day PUSH/PULL/LEGS/UPPER/LOWER) has no
// same-archetype exposure to vary — the smart default should still land on >=2
// distinct bands across the week (falls back to day-position variety).
const adv5 = compoundRanges(generatePlan({ ...profile, days_per_week: 5, training_status: "advanced" }, kb));
ok("DUP still varies across a week with no repeated archetype (5-day split)", adv5.size >= 2);
// Intermediate stays linear by default (the method best suits advanced trainees).
const intAuto = compoundRanges(generatePlan({ ...profile, days_per_week: 6, training_status: "intermediate" }, kb));
ok("intermediate stays linear by default (single base band, no auto-undulation)", intAuto.size === 1 && intAuto.has("6-10"));
// The profile field is a respected OVERRIDE both ways.
ok("override: periodization 'linear' forces an advanced user back to one band", compoundRanges(generatePlan({ ...profile, days_per_week: 6, training_status: "advanced", periodization: "linear" }, kb)).size === 1);
ok("override: periodization 'undulating' turns it on for an intermediate (heavy 4-6 present)", compoundRanges(generatePlan({ ...profile, days_per_week: 6, training_status: "intermediate", periodization: "undulating" }, kb)).has("4-6"));
// Gating: a strength goal never undulates (its bands are already goal-specific).
const strRanges = compoundRanges(generatePlan({ ...profile, days_per_week: 6, training_status: "advanced", primary_goal: "strength", periodization: "undulating" }, kb));
ok("DUP gating: a strength goal ignores undulation (compounds stay the strength base 3-6)", strRanges.size === 1 && strRanges.has("3-6"));
ok("every exercise has a rep_range string", allEx.every((e) => typeof e.rep_range === "string" && /\d+-\d+/.test(e.rep_range)));
ok("no exercise exceeds 5 sets", allEx.every((e) => e.sets <= 5));
ok("no session exceeds 8 exercises", p.program.sessions.every((s) => s.exercises.length <= 8));
ok("every citation resolves in the registry", p.program.citations.every((c) => registry.has(c)));
// priority raises the TARGET (projected volume is separately budget-limited, and
// compound-driven muscles accumulate more free secondary volume — that's expected).
const vols = p.rationale.volume_by_muscle;
const topTarget = Object.entries(vols).sort((a, b) => b[1].target_sets - a[1].target_sets)[0][0];
ok("priority side-delts has the highest target volume", topTarget === "side-delts");
ok("priority side-delts lands in a productive range (>= MEV)", vols["side-delts"].projected_sets >= muscleById.get("side-delts").landmarks.mev.min);

// --- INVARIANT: no muscle is programmed over its MRV ---
const overMrv = Object.entries(vols).filter(([m, r]) => { const lm = muscleById.get(m)?.landmarks; return lm && r.projected_sets > lm.mrv.max; });
ok("no muscle is programmed over MRV", overMrv.length === 0);

// --- INVARIANT (#5 quality): no COMPOUND is ever prescribed at just 1 set ---
// Nobody does a single set of squats/rows/presses; a 1-set compound was a
// budget/coverage/MRV-trim artifact. Checked across the whole profile grid.
const exMechanic = Object.fromEntries(exercises.map((e) => [e.id, e.mechanic]));
const oneSetCompoundGrid = ["beginner", "intermediate", "advanced"].flatMap((st) =>
  [3, 4, 5].flatMap((days) => [["barbell", "dumbbell", "machine", "cable", "bodyweight"], ["dumbbell", "bodyweight"]].map((eqp) =>
    generatePlan({ user_id: `q-${st}-${days}-${eqp.length}`, training_status: st, primary_goal: "hypertrophy", days_per_week: days, session_length_min: 60, available_equipment: eqp }, kb))))
  .flatMap((pl) => pl.program.sessions.flatMap((s) => s.exercises))
  .filter((e) => e.sets === 1 && exMechanic[e.exercise] === "compound");
ok("no COMPOUND is ever prescribed at 1 set (across the whole profile grid)", oneSetCompoundGrid.length === 0);

// --- #5 quality: prefer progressively-loadable exercises when a full gym is available.
// A full-gym lifter should not be handed non-loadable bodyweight compounds (bodyweight
// lunge/squat, inverted row, single-leg RDL) when a loaded version of the same job
// exists — those cap out and can't be overloaded. Loadable bodyweight (chin-up, dip)
// is exempt, and bodyweight-only users are unaffected (tested separately).
// Scoped to intermediate/advanced: they can handle the loaded versions, so a
// capped bodyweight lift is never the right pick for them. (A BEGINNER may still
// correctly get a beginner-difficulty bodyweight lift like single-leg RDL when the
// loaded alternatives are intermediate+ — the difficulty gate rightly outranks the
// loadable-preference there.)
// Swept across 3–6 days AND both loaded-equipment profiles: high-frequency splits
// give a muscle many slots, and the block-rotation counter used to walk onto the
// capped bodyweight lift once loaded variants were spent (a 6-day back day picking
// inverted-row, a 3-day picking single-leg RDL) — the day=4-only grid missed both.
const fullGymGrid = ["intermediate", "advanced"].flatMap((st) =>
  [3, 4, 5, 6].flatMap((days) => [["barbell", "dumbbell", "machine", "cable", "bodyweight"], ["dumbbell", "bodyweight"]].map((eqp) =>
    generatePlan({ user_id: `bw-${st}-${days}-${eqp.length}`, training_status: st, primary_goal: "hypertrophy", days_per_week: days, session_length_min: 60, available_equipment: eqp }, kb))));
const cappedBodyweight = new Set(["bodyweight-lunge", "bodyweight-squat", "inverted-row", "single-leg-romanian-deadlift"]);
const cappedBwLeaks = fullGymGrid.flatMap((pl) => pl.program.sessions.flatMap((s) => s.exercises)).filter((e) => cappedBodyweight.has(e.exercise));
ok("#5 an int/adv loaded plan never rotates onto a capped bodyweight lift (3–6 days, full-gym & dumbbell)", cappedBwLeaks.length === 0);

// #13 loaded carries are a time/distance movement — the rep-based generator must
// never prescribe one (a "3×6–10" suitcase carry is nonsense). Swept over the
// kettlebell users who actually own them; abs/forearms keep other options.
const exPattern = Object.fromEntries(exercises.map((e) => [e.id, e.movement_pattern]));
const carryGrid = ["beginner", "intermediate", "advanced"].flatMap((st) =>
  [3, 4, 5, 6].map((days) =>
    generatePlan({ user_id: `carry-${st}-${days}`, training_status: st, primary_goal: "hypertrophy", days_per_week: days, session_length_min: 60, available_equipment: ["kettlebell", "bodyweight"] }, kb)));
const carryLeaks = carryGrid.flatMap((pl) => pl.program.sessions.flatMap((s) => s.exercises)).filter((e) => exPattern[e.exercise] === "carry");
ok("#13 no generated plan prescribes a loaded carry as rep-based work (kettlebell grid)", carryLeaks.length === 0);

// #8-1 `neck` is in no session archetype, so the plan can never program it — a
// "below MEV, add a direct neck exercise" nag would otherwise fire on EVERY plan.
// It must stay silent unless the user prioritises neck (then it is actionable).
const neckGrid = ["beginner", "intermediate", "advanced"].flatMap((st) =>
  [2, 3, 4, 5, 6].map((days) =>
    generatePlan({ user_id: `neck-${st}-${days}`, training_status: st, primary_goal: "hypertrophy", days_per_week: days, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] }, kb)));
const neckNags = neckGrid.flatMap((pl) => pl.rationale.warnings ?? []).filter((w) => w.muscle === "neck");
ok("#8-1 no plan nags to add direct neck work when neck was never prioritised", neckNags.length === 0);
const neckPri = generatePlan({ user_id: "neck-pri", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], priority_muscles: ["neck"] }, kb);
ok("#8-1 a neck-priority user IS still told to add direct neck work (the plan can't fit it)", (neckPri.rationale.warnings ?? []).some((w) => w.muscle === "neck"));

// --- #14 programming-quality invariants. Each is anchored to a KB evidence page
// (see the comments in plan-core.mjs); provenance: Wave 14 cross-checked the
// engine's output against current Olympia-tier splits, then Waves 14c/14d
// re-audited every rule against the KB itself — the science is the authority,
// elite practice only ever corroborates (the KB grades elite comparisons a
// contaminated benchmark: genetics + PEDs).
{
  const exMeta = Object.fromEntries(exercises.map((e) => [e.id, e]));
  const FULLG = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  const grid = ["beginner", "intermediate", "advanced"].flatMap((st) =>
    [2, 3, 4, 5, 6].map((days) =>
      generatePlan({ user_id: `pro-${st}-${days}`, training_status: st, primary_goal: "hypertrophy", days_per_week: days, session_length_min: 60, available_equipment: FULLG }, kb)));
  // (a) no 1-set scatter: every prescription is >= 2 sets (maintenance micro-doses
  // only exist under specialization, which this grid doesn't use)
  const oneSets = grid.flatMap((pl) => pl.program.sessions.flatMap((s) => s.exercises)).filter((e) => e.sets < 2);
  ok("#14a no default plan prescribes a 1-set exercise (scatter) anywhere", oneSets.length === 0);
  // (b) weekly variety: no exercise appears in 3+ sessions of one week
  const overUsed = grid.flatMap((pl) => {
    const cnt = {};
    for (const s of pl.program.sessions) for (const e of s.exercises) cnt[e.exercise] = (cnt[e.exercise] ?? 0) + 1;
    return Object.entries(cnt).filter(([, n]) => n > 2);
  });
  ok("#14b no exercise is programmed in 3+ sessions of the same week", overUsed.length === 0);
  // (c) per-session pattern cap: never 3 compounds of the same raw movement pattern
  const patternStacks = grid.flatMap((pl) => pl.program.sessions.filter((s) => {
    const cnt = {};
    for (const e of s.exercises) { const x = exMeta[e.exercise]; if (x?.mechanic === "compound") cnt[x.movement_pattern] = (cnt[x.movement_pattern] ?? 0) + 1; }
    return Object.values(cnt).some((n) => n > 2);
  }));
  ok("#14c no session stacks 3+ compounds of the same movement pattern (e.g. triple hinge)", patternStacks.length === 0);
  // (d) direct arm + delt work at EVERY training status (3+ days): curls, triceps
  // isolation, and lateral-raise family appear somewhere in the week — compound
  // credit alone never covers them. Beginners included (Wave 14d: the KB's own
  // beginner template programs curls/extensions/laterals, and the engine does too).
  const iaGrid = grid.filter((pl) => pl.meta.generated_from.days_per_week >= 3);
  const missingDirect = iaGrid.filter((pl) => {
    const isoFor = (m) => pl.program.sessions.flatMap((s) => s.exercises).some((e) => { const x = exMeta[e.exercise]; return x?.mechanic === "isolation" && (x.primary_muscles ?? []).includes(m); });
    return !(isoFor("biceps") && isoFor("triceps") && isoFor("side-delts"));
  });
  ok("#14d every 3+-day week includes DIRECT biceps + triceps + side-delt isolation work", missingDirect.length === 0);
  // (e) weekly knee-flexion: hinges don't train the hamstrings' short head — every
  // int/adv full-gym week includes a leg-curl-pattern exercise. Scoped to >=4 days:
  // a 3-day 60-min full-body (48 quality sets across 11 muscles) is the one shape
  // where forcing a leg curl would displace a dose the week needs more — canonical
  // full-body templates treat it as optional there too. (The 4b slot-preference
  // still places one whenever hamstring residual exists.)
  const kfGrid = iaGrid.filter((pl) => pl.meta.generated_from.days_per_week >= 4);
  const missingKF = kfGrid.filter((pl) => !pl.program.sessions.flatMap((s) => s.exercises).some((e) => exMeta[e.exercise]?.movement_pattern === "isolation-knee-flexion"));
  ok("#14e int/adv weeks (4+ days) include >=1 knee-flexion (leg-curl pattern) exercise", missingKF.length === 0);
  // (f) heavy-first ordering: within a session, exercise tier (high-CNS compound ->
  // compound -> isolation) never goes backwards
  const tier = (id) => { const x = exMeta[id]; if (!x) return 9; if (x.mechanic === "isolation") return 3; return x.cns_cost === "high" ? 0 : x.cns_cost === "moderate" ? 1 : 2; };
  const misordered = grid.flatMap((pl) => pl.program.sessions.filter((s) => {
    for (let i = 1; i < s.exercises.length; i++) if (tier(s.exercises[i].exercise) < tier(s.exercises[i - 1].exercise)) return true;
    return false;
  }));
  ok("#14f sessions read heaviest-first (high-CNS compounds -> compounds -> isolations)", misordered.length === 0);
  // (g) pump band: small-muscle isolations (laterals/calves/abs/forearms) run 12-20
  const wrongBand = grid.flatMap((pl) => pl.program.sessions.flatMap((s) => s.exercises)).filter((e) => {
    const x = exMeta[e.exercise];
    if (!x || x.mechanic !== "isolation") return false;
    const pump = (x.primary_muscles ?? []).every((m) => ["side-delts", "rear-delts", "calves", "abs", "forearms", "neck"].includes(m));
    return pump && e.rep_range !== "12-20";
  });
  ok("#14g small-muscle isolation work runs the 12-20 pump band", wrongBand.length === 0);
  // (h) isolation RIR follows the KB (proximity-to-failure, Grade B): 0-1 on
  // isolation/machine work for every growth goal — failure there is safe and
  // cheap. Wave 14d: the engine ran isolations at 0-2 while its own priority
  // isolations and all five KB program templates said 0-1. Strength keeps a
  // deliberate reserve on accessories.
  const growthGoals = ["hypertrophy", "recomposition", "fat-loss"].flatMap((goal) =>
    ["beginner", "advanced"].map((st) =>
      generatePlan({ user_id: `rir-${goal}-${st}`, training_status: st, primary_goal: goal, days_per_week: 4, session_length_min: 60, available_equipment: FULLG }, kb)));
  const wrongRir = [...grid, ...growthGoals].flatMap((pl) => pl.program.sessions.flatMap((s) => s.exercises))
    .filter((e) => exMeta[e.exercise]?.mechanic === "isolation" && e.rir !== "0-1");
  ok("#14h isolation work is prescribed at 0-1 RIR on every growth goal (KB Grade B)", wrongRir.length === 0);
  const strengthPlan = generatePlan({ user_id: "rir-strength", training_status: "intermediate", primary_goal: "strength", days_per_week: 4, session_length_min: 60, available_equipment: FULLG }, kb);
  ok("#14h strength keeps an RIR reserve on isolations (fatigue budget goes to the heavy lifts)", strengthPlan.program.sessions.flatMap((s) => s.exercises).every((e) => exMeta[e.exercise]?.mechanic !== "isolation" || e.rir !== "0-1"));
  // (i) per-muscle SESSION-QUALITY cap (KB frequency page, Grade C: ~6-10 hard
  // sets per muscle per session before quality drops — "add a day rather than
  // cramming"). Wave 14d: opts.perMuscleSessionCap was declared and never
  // enforced; advanced Lower days stacked 12 direct glute sets via cross-credit
  // (squat/hinge variants each placed for a different muscle). Checked on every
  // dose path — add, top-up, and superset rescue — including priority profiles.
  const directDose = (pl) => pl.program.sessions.flatMap((s) => {
    const d = {};
    for (const e of s.exercises) for (const m of exMeta[e.exercise]?.primary_muscles ?? []) d[m] = (d[m] ?? 0) + e.sets;
    return Object.values(d);
  });
  const prioGrid = [["chest"], ["side-delts"], ["biceps", "triceps"]].map((pm) =>
    generatePlan({ user_id: `cap-${pm.join("-")}`, training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 90, available_equipment: FULLG, priority_muscles: pm }, kb));
  ok("#14i no session gives any muscle more than 10 direct sets (KB session-quality window)", [...grid, ...prioGrid].every((pl) => directDose(pl).every((n) => n <= 10)));
  const tightCap = generatePlan({ user_id: "cap-knob", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 90, available_equipment: FULLG }, kb, { perMuscleSessionCap: 6 });
  ok("#14i the perMuscleSessionCap knob actually binds (a declared cap must be enforced)", directDose(tightCap).every((n) => n <= 6));

  // --- #40 goal-aware equipment scoring (#1/#5): hypertrophy favours stable
  // machines/cables (tension per unit fatigue), strength favours the barbell
  // (specificity). Directional invariant across the same profile + full gym. ---
  const FULLPLUS = ["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "band"];
  const eqMix = (goal) => {
    const p = generatePlan({ user_id: `eq-${goal}`, training_status: "intermediate", primary_goal: goal, days_per_week: 4, session_length_min: 60, available_equipment: FULLPLUS }, kb);
    const m = {};
    for (const e of p.program.sessions.flatMap((s) => s.exercises)) { const q = exMeta[e.exercise]?.equipment; m[q] = (m[q] ?? 0) + 1; }
    return m;
  };
  const hyMix = eqMix("hypertrophy"), stMix = eqMix("strength");
  ok("#40 strength uses more barbell than hypertrophy (specificity)", (stMix.barbell ?? 0) > (hyMix.barbell ?? 0));
  ok("#40 hypertrophy uses more machine+cable than strength (stable, low-fatigue tension)",
    ((hyMix.machine ?? 0) + (hyMix.cable ?? 0)) > ((stMix.machine ?? 0) + (stMix.cable ?? 0)));
  // the preference must not become a monoculture — a full-gym hypertrophy plan
  // still uses >=3 distinct equipment types and still has compounds.
  ok("#40 hypertrophy equipment stays varied (>=3 types, compounds present)",
    Object.keys(hyMix).length >= 3);

  // --- #37 a frequency override is surfaced, never silent ---
  const freq1 = generatePlan({ user_id: "freq-1", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 1, session_length_min: 60, available_equipment: FULLG }, kb);
  ok("#37 days_per_week=1 delivers 2 sessions WITH a frequency-adjusted warning (never silent)",
    freq1.program.sessions.length === 2 && (freq1.rationale.warnings ?? []).some((w) => w.code === "frequency-adjusted"));
  const freq7 = generatePlan({ user_id: "freq-7", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 7, session_length_min: 60, available_equipment: FULLG }, kb);
  ok("#37 days_per_week=7 clamps to 6 WITH a frequency-adjusted warning", (freq7.rationale.warnings ?? []).some((w) => w.code === "frequency-adjusted"));
  const freq4 = generatePlan({ user_id: "freq-4", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: FULLG }, kb);
  ok("#37 an in-range frequency (4) emits NO frequency-adjusted warning", !(freq4.rationale.warnings ?? []).some((w) => w.code === "frequency-adjusted"));

  // --- #15 Wave-15: coverage-floor and top-up delivery invariants ---
  // (a) the coverage floor serves UNSERVED muscles — a priority muscle already
  // served this session must not double-dip it. The regression: beginner 2-day
  // arm-priority weeks shipped a session with ONE compound and four arm
  // isolations; glutes projected 1 set vs a 4-set MEV.
  const armPri = generatePlan({ user_id: "w15-arm-pri", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 2, session_length_min: 90, available_equipment: FULLG, priority_muscles: ["biceps", "triceps"] }, kb);
  ok("#15a arm-priority beginner sessions still carry >=2 compounds each (no isolation takeover)",
    armPri.program.sessions.every((s) => s.exercises.filter((e) => exMeta[e.exercise]?.mechanic === "compound").length >= 2));
  ok("#15a arm-priority beginner week still serves glutes at >= MEV",
    armPri.rationale.volume_by_muscle.glutes.projected_sets >= muscleById.get("glutes").landmarks.mev.min);
  // W303 (deliberate): the 4c rescue had been cramming 2 unbilled arm sets past the beginner's 12-set ceiling on this
  // exact week; with the ceiling honoured, a 2-day beginner's 24 weekly sets can't hold full arm targets beside
  // full-body coverage (biceps 7/10, triceps 7.5/8 measured) — the plan's options card offers the third day.
  ok("#15a the priority arms are served inside the 12-set ceiling (each within 3 of target)",
    armPri.program.sessions.every((s) => s.exercises.reduce((a, e) => a + e.sets, 0) <= 12)
    && ["biceps", "triceps"].every((m) => armPri.rationale.volume_by_muscle[m].projected_sets >= armPri.rationale.volume_by_muscle[m].target_sets - 3));
  // (b) specialization actually DELIVERS: top-up must not sit behind the
  // 8-exercise cap (it grows existing lifts, needing set budget only), and the
  // priority muscle may take a second exercise before coverage passes fill the
  // slots. The regression: chest spec delivered 8 of a 22-set target while
  // sessions left 4 budgeted sets unused.
  const chestSpec = generatePlan({ user_id: "w15-chest-spec", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 90, available_equipment: FULLG, priority_muscles: ["chest"], specialization: true }, kb);
  ok("#15b chest specialization delivers >= 12 weekly sets toward its ceiling (was 8)",
    chestSpec.rationale.volume_by_muscle.chest.projected_sets >= 12);
}

// --- #1 cns_cost-aware: no session stacks more than 2 high-CNS COMPOUNDS. Squat +
// a deadlift is already a hard day; a 3rd heavy barbell lift over-taxes recovery.
const exCns = Object.fromEntries(exercises.map((e) => [e.id, e.cns_cost]));
const highCnsOverflow = ["beginner", "intermediate", "advanced"].flatMap((st) =>
  [3, 4, 5, 6].flatMap((days) => [["barbell", "dumbbell", "machine", "cable", "bodyweight"], ["dumbbell", "bodyweight"]].map((eqp) =>
    generatePlan({ user_id: `cns-${st}-${days}-${eqp.length}`, training_status: st, primary_goal: "hypertrophy", days_per_week: days, session_length_min: 60, available_equipment: eqp }, kb))))
  .flatMap((pl) => pl.program.sessions)
  .filter((s) => s.exercises.filter((e) => exCns[e.exercise] === "high").length > 2);
ok("#1 no session stacks more than 2 high-CNS compounds (across the whole grid)", highCnsOverflow.length === 0);

// --- determinism ---
ok("same profile → byte-identical program", JSON.stringify(generatePlan(profile, kb).program) === JSON.stringify(p.program));

// --- equipment filtering ---
const bw = generatePlan({ user_id: "test-bw", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: ["bodyweight"] }, kb);
ok("bodyweight-only plan uses only bodyweight exercises", bw.program.sessions.flatMap((s) => s.exercises).every((e) => exercises.find((x) => x.id === e.exercise).equipment === "bodyweight"));
ok("bodyweight-only plan still produces sessions (graceful, no crash)", bw.program.sessions.length === 3 && bw.program.sessions.every((s) => s.exercises.length > 0));

// --- injury filtering ---
const inj = generatePlan({ ...profile, user_id: "test-inj", injuries: [{ region: "shoulder", severity: "moderate" }] }, kb);
const injPatterns = new Set(inj.program.sessions.flatMap((s) => s.exercises).map((e) => exercises.find((x) => x.id === e.exercise).movement_pattern));
ok("shoulder injury excludes overhead pressing (no vertical-push)", !injPatterns.has("vertical-push"));
ok("shoulder injury (moderate) also cautions horizontal-push", !injPatterns.has("horizontal-push"));
// #11: moderate/severe injuries must pull the region's OWN named aggravators, not
// just leave them in. A knee-pain user was still handed barbell back squats + full-
// ROM leg extensions; a shoulder-pain user still got the painful-arc lateral raise.
const kneeInj = generatePlan({ ...profile, user_id: "test-knee", injuries: [{ region: "knee", severity: "moderate" }] }, kb);
const kneePatterns = new Set(kneeInj.program.sessions.flatMap((s) => s.exercises).map((e) => exercises.find((x) => x.id === e.exercise).movement_pattern));
ok("#11 moderate knee pulls loaded knee flexion (no squat/lunge/knee-extension patterns)",
  !kneePatterns.has("squat") && !kneePatterns.has("lunge") && !kneePatterns.has("isolation-knee-extension"));
ok("#11 knee-injured plan still builds full sessions (graceful, trains around the knee)",
  kneeInj.program.sessions.length === profile.days_per_week && kneeInj.program.sessions.every((s) => s.exercises.length > 0));
ok("#11 MILD knee keeps its options (caution only bites at moderate/severe)",
  new Set(generatePlan({ ...profile, user_id: "test-knee-mild", injuries: [{ region: "knee", severity: "mild" }] }, kb)
    .program.sessions.flatMap((s) => s.exercises).map((e) => exercises.find((x) => x.id === e.exercise).movement_pattern)).has("squat"));
ok("#11 moderate shoulder pulls the lateral-raise abduction arc",
  !injPatterns.has("isolation-shoulder-abduction"));

// --- difficulty is a HARD gate: a beginner is never prescribed an advanced
//     exercise while an easier one trains the muscle; intermediates never get an
//     advanced one under the same condition. (Pistol squats and Nordic curls were
//     reaching day-one beginners via the soft penalty + small-pool rotation.) ---
const diffOf = Object.fromEntries(exercises.map((e) => [e.id, e.difficulty ?? "intermediate"]));
ok("beginner plans (any equipment) never contain an advanced exercise",
  [["bodyweight"], ["dumbbell", "bodyweight"], ["barbell", "dumbbell", "machine", "cable", "bodyweight"]].every((eqp) =>
    generatePlan({ user_id: "dg-" + eqp.join(""), training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: eqp }, kb)
      .program.sessions.every((s) => s.exercises.every((e) => diffOf[e.exercise] !== "advanced"))));
ok("beginner bodyweight hamstring work is now a beginner movement",
  (() => {
    const p2 = generatePlan({ user_id: "bw-ham", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: ["bodyweight"] }, kb);
    const ids = p2.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise));
    const ham = ids.filter((id) => (exercises.find((x) => x.id === id).primary_muscles ?? []).includes("hamstrings"));
    return ham.length > 0 && ham.every((id) => diffOf[id] === "beginner");
  })());

// --- first-serve: default intermediate/advanced plans leave NO directly-trained
//     muscle at zero weekly sets (the quality cap was letting big-muscle compounds
//     double up while calves/abs/side-delts got nothing all week) ---
// BEGINNERS INCLUDED — the invariant's original grid was int/adv only, and the
// Wave-237 last-chance floor silently zeroed beginners' abs on the DEFAULT 2d/3d
// profiles (their 12-set budget can't rescue seven muscles on one final day, and
// abs are second-to-last in PLACE_ORDER, so they lost the race every time —
// while the grid that guarded exactly this class never generated a beginner).
ok("no directly-trained muscle gets zero weekly sets (beginner + intermediate + advanced defaults)",
  [{ user_id: "fs-b2", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 2, session_length_min: 60 },
   { user_id: "fs-b3", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60 },
   { user_id: "fs-i", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60 },
   { user_id: "fs-a", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 90 }]
    .every((prof) => Object.values(generatePlan(prof, kb).rationale.volume_by_muscle)
      .every((r) => r.frequency === 0 || r.projected_sets > 0)));

// --- session quality ceiling: time is not a licence to fill a session with hard
//     sets. Per-set effort collapses long before the clock runs out (user-reported
//     ~12; the KB's per-muscle quality window points the same way), so sessions cap
//     by training age regardless of session_length_min ---
const CAPS = { beginner: 12, intermediate: 16, advanced: 20 };
ok("sessions never exceed the per-level quality cap (+ at most 2 superset-paired bonus sets)",
  Object.entries(CAPS).every(([lvl, cap]) =>
    generatePlan({ user_id: "cap-" + lvl, training_status: lvl, primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 120 }, kb)
      .program.sessions.every((s) => {
        // The rescue adds at most ONE 2-set isolation above the cap; its paired
        // partner was already inside the budget. Paired sets ride the partner's
        // rest, so the time cost is ~2 minutes, not ~6.
        const rescues = s.exercises.filter((e) => e.superset_with && e.sets === 2);
        return s.exercises.reduce((a, e) => a + e.sets, 0) <= cap + 2 && rescues.length <= 2;
      })));

// --- recovery ceiling: the engine trims to MRV, so no generated plan prescribes
//     past what the KB says you can recover from (#13), across demanding profiles ---
const demanding = [
  { user_id: "adv-6", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 90 },
  { user_id: "adv-pri", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 90, priority_muscles: ["chest", "side-delts", "lats"] },
  { user_id: "int-5", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 75 },
];
ok("no generated plan emits an over-MRV warning (trimmed to the ceiling)",
  demanding.every((prof) => !generatePlan(prof, kb).rationale.warnings.some((w) => w.code === "over-mrv")));

// --- the explanation must describe the plan the user actually gets (post-trim) ---
// exerciseChoices is built while filling sessions; the MRV trim then mutates them.
// If the two drift, "Why this plan?" cites sets/exercises that aren't prescribed.
ok("rationale.exercise_choices matches the trimmed program (no ghosts, no stale set counts)",
  demanding.concat([profile]).every((prof) => {
    const { program, rationale } = generatePlan(prof, kb);
    const actual = new Map();
    for (const s of program.sessions) for (const e of s.exercises) actual.set(`${s.name}|${e.exercise}`, e.sets);
    const claimed = new Map();
    for (const c of rationale.exercise_choices) claimed.set(`${c.session}|${c.exercise}`, c.sets);
    if (claimed.size !== actual.size) return false;
    for (const [k, v] of claimed) if (actual.get(k) !== v) return false;
    return true;
  }));

// --- coverage floor + specialization maintenance (iteration 3) ---
// forearms/neck are legitimately grip-/indirect-trained and hard to always give
// DIRECT work (same reason check-data-refs allowlists them) — assert the coverage
// floor on every OTHER in-split muscle.
const COVERAGE_EXEMPT = new Set(["forearms", "neck"]);
ok("no major directly-trained muscle gets zero weekly sets across the int/adv grid",
  ["intermediate", "advanced"].every((lvl) => [2, 3, 4, 5].every((days) => [45, 60, 90].every((min) =>
    Object.entries(generatePlan({ user_id: `cf-${lvl}-${days}-${min}`, training_status: lvl, primary_goal: "hypertrophy", days_per_week: days, session_length_min: min }, kb).rationale.volume_by_muscle)
      .every(([m, r]) => r.frequency === 0 || r.projected_sets > 0 || COVERAGE_EXEMPT.has(m))))));
{
  const sp = generatePlan({ user_id: "sp-mv", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 75, priority_muscles: ["side-delts"], specialization: true }, kb);
  ok("specialization maintenance dose uses the KB's MV landmark, not half-MEV",
    sp.rationale.volume_by_muscle["chest"].target_sets === muscleById.get("chest").landmarks.mv.min);
  ok("specialization emits no growth-warning noise for maintenance or eased muscles",
    !sp.rationale.warnings.some((w) => (w.code === "below-mev" || w.code === "below-mev-indirect" || w.code === "under-target") && (sp.rationale.volume_by_muscle[w.muscle]?.maintenance || sp.rationale.volume_by_muscle[w.muscle]?.eased)));
  ok("specialization never programs over MRV", !sp.rationale.warnings.some((w) => w.code === "over-mrv"));
}

// --- elite features: specialization, supersets, block rotation ---
const specP = generatePlan({ user_id: "sp", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 75, priority_muscles: ["side-delts", "chest"], specialization: true }, kb);
ok("specialization: priority targets push to the MRV ceiling", specP.rationale.volume_by_muscle["side-delts"].target_sets === muscleById.get("side-delts").landmarks.mrv.max);
ok("specialization: non-priority muscles run reduced (eased-to-MEV here) with no below-MEV noise",
  specP.rationale.volume_by_muscle["quadriceps"].projected_status === "eased" &&
  specP.rationale.warnings.filter((w) => w.code === "below-mev").length === 0);
ok("specialization: still never over MRV", specP.rationale.warnings.filter((w) => w.code === "over-mrv").length === 0);
// #1 (rewritten by the Wave-255 owner ruling): a muscle UNRELATED to the priorities
// (quads, when the priorities are side-delts+chest) is EASED to its minimum effective
// dose when the day's budget has slack — still growing slowly, never quietly grown
// past MEV, and never held at MV while the budget could fund more.
const specQuad = specP.rationale.volume_by_muscle["quadriceps"];
ok("#1 a non-synergist muscle with budget slack eases to exactly MEV, not past it",
  specQuad.eased === true && specQuad.target_sets === muscleById.get("quadriceps").landmarks.mev.min);
ok("#1 an eased muscle stays within ~1.5 sets of its (MEV) target",
  specQuad.projected_sets <= specQuad.target_sets + 1.5);
// A synergist of the priority lifts (e.g. triceps under a chest priority) will pick
// up unavoidable SECONDARY volume and overshoot — that's physiology, not a bug — but
// its rationale must then say so HONESTLY, not keep claiming "holds what you've built".
const overshootSyn = Object.entries(specP.rationale.volume_by_muscle)
  .find(([m, r]) => r.maintenance && r.projected_sets >= (muscleById.get(m)?.landmarks?.mev?.min ?? Infinity))?.[1];
ok("#1 an overshooting synergist gets an honest 'secondary work' reason, not a false maintenance claim",
  !overshootSyn || (/secondary work/.test(overshootSyn.reasons[0]) && !/holds what you've built/.test(overshootSyn.reasons[0])));

// --- Wave 257 (self-audit of the ease-to-MEV pass): honesty at the two ends the
// funding pass can't control — a held muscle the week can't serve AT ALL, and an
// eased muscle whose placement falls short of the MEV its reason quotes. Both
// measured real across a 720-config battery (9 held-at-zero configs, 18
// eased-undershoot configs) before these tests were written.
{
  // (a) 2-day 30-min block, three priorities: lats is held at MV and the week
  // delivers literally NOTHING for it — the rationale must say so (not "holds
  // what you've built") and a warning must name it (the feasibility warning the
  // roadmap named after the Wave-254 abs record; lats is its sibling).
  const tight = generatePlan({ user_id: "t-held0", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 2, session_length_min: 30, priority_muscles: ["side-delts", "biceps", "triceps"] }, kb);
  const lats = tight.rationale.volume_by_muscle["lats"];
  ok("#HZ fixture reaches the branch: lats held at MV, delivered zero, status not-reached",
    lats.maintenance === true && lats.projected_sets === 0 && lats.projected_status === "not-reached");
  ok("#HZ a held muscle at zero tells the truth instead of claiming a dose it never got",
    !/holds what you've built/.test(lats.reasons[0]) && /couldn't fit|didn't fit|gets nothing/.test(lats.reasons[0]));
  ok("#HZ ...and a warning names it (held-not-reached)",
    tight.rationale.warnings.some((w) => w.code === "held-not-reached" && w.muscle === "lats"));
  // (b) 6-day glute block: chest eases to MEV 8 but placement delivers 6 — the
  // reason must quote the DELIVERED number, matching the critique caveat that
  // already says 6 (two surfaces, one answer).
  const six = generatePlan({ user_id: "t-eased-under", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 60, priority_muscles: ["glutes"] }, kb);
  const chest = six.rationale.volume_by_muscle["chest"];
  ok("#EU fixture reaches the branch: chest eased, delivered < MEV - 1.5",
    chest.eased === true && chest.projected_sets < muscleById.get("chest").landmarks.mev.min - 1.5);
  ok("#EU an under-delivered eased muscle's reason quotes what the week actually gives",
    new RegExp(`~${chest.projected_sets} sets`).test(chest.reasons[0]) && !new RegExp(`~${chest.target_sets} sets, the KB's minimum`).test(chest.reasons[0]));
}
// #2/#4: an under-target warning for an ALREADY-priority muscle must not tell the
// user to "mark it a priority muscle" (they already did / it's a specialization
// target). It should point at the real levers (more days / longer sessions).
const priorityUnderTarget = specP.rationale.warnings.filter((w) => w.code === "under-target" && specP.rationale.volume_by_muscle[w.muscle]?.is_priority);
ok("#2/#4 a priority muscle's under-target warning never says 'mark it a priority'",
  priorityUnderTarget.every((w) => !/marking it a priority/.test(w.message)));
// and a NON-priority under-target warning keeps the (valid) 'mark it a priority' lever
const tightUnder = generatePlan({ user_id: "tu", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 2, session_length_min: 40, priority_muscles: ["side-delts"] }, kb)
  .rationale.warnings.filter((w) => w.code === "under-target");
ok("#2/#4 a non-priority under-target warning still offers the 'mark it a priority' lever",
  tightUnder.filter((w) => w.muscle !== "side-delts").every((w) => /marking it a priority/.test(w.message)));

const tightP = generatePlan({ user_id: "tb", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 40 }, kb);
ok("supersets: pairs are mutual, in-session, and non-competing (or absent)",
  tightP.program.sessions.every((s) => {
    const ids = new Set(s.exercises.map((e) => e.exercise));
    return s.exercises.every((e) => {
      if (!e.superset_with) return true;
      if (!ids.has(e.superset_with)) return false;
      const a = exercises.find((x) => x.id === e.exercise), b = exercises.find((x) => x.id === e.superset_with);
      const am = new Set([...(a.primary_muscles ?? []), ...(a.secondary_muscles ?? [])]);
      return ![...(b.primary_muscles ?? []), ...(b.secondary_muscles ?? [])].some((m) => am.has(m));
    });
  }));

const rotA = generatePlan({ user_id: "rot", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 90 }, kb, { blockIndex: 0 });
const rotB = generatePlan({ user_id: "rot", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 90 }, kb, { blockIndex: 1 });
const kindOf = (p, iso) => p.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)).filter((id) => (exercises.find((x) => x.id === id).mechanic === "isolation") === iso).join(",");
ok("block rotation: compounds stable, accessories rotate, deterministic",
  kindOf(rotA, false) === kindOf(rotB, false) && kindOf(rotA, true) !== kindOf(rotB, true) &&
  JSON.stringify(rotB.program) === JSON.stringify(generatePlan({ user_id: "rot", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 90 }, kb, { blockIndex: 1 }).program));

// --- KB critique ---
const badPlan = { name: "Bad", split: "other", days_per_week: 1, sessions: [{ name: "Day 1", exercises: [
  { exercise: "barbell-bench-press", sets: 10, rep_range: "6-10" },
  { exercise: "incline-dumbbell-press", sets: 10, rep_range: "6-10" },
  { exercise: "triceps-pushdown", sets: 5, rep_range: "10-15" },
  { exercise: "barbell-bench-press", sets: 5, rep_range: "6-10" },
] }] };
const crit = critiquePlan(badPlan, kb);
ok("critique flags over-MRV on an overloaded muscle", crit.findings.some((f) => /above MRV/.test(f.msg) && f.muscle === "chest"));
ok("critique flags major muscles with no volume", crit.findings.some((f) => /no direct or indirect volume/.test(f.msg) && f.muscle === "upper-back"));
ok("critique flags a compound placed after an isolation", crit.findings.some((f) => /comes after an isolation/.test(f.msg)));
const goodCrit = critiquePlan(p.program, kb);
ok("critique summarizes a generated plan without over-MRV warnings", !goodCrit.findings.some((f) => /above MRV/.test(f.msg)));

// #D2: a beginner is BUILT at ~MEV under a session cap, so their own generated plan
// sits a little below MEV on many muscles BY DESIGN. Critiquing it must not greet
// them with a pile of red "worth fixing" warnings (the plan the app just called
// "ready 🎉"). For a beginner a modest shortfall is a gentle info; the same plan
// judged at the default (intermediate) bar shows them as warns.
const begPlan = generatePlan({ user_id: "begc", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60 }, kb);
const begCrit = critiquePlan(begPlan.program, kb, { experience: "beginner" });
const begCritDefault = critiquePlan(begPlan.program, kb); // default = intermediate bar
const infoBelowBeg = begCrit.findings.filter((f) => f.severity === "info" && /below MEV/.test(f.msg)).length;
const warnBelowDefault = begCritDefault.findings.filter((f) => f.severity === "warn" && /below MEV/.test(f.msg)).length;
ok("#D2 a beginner's own plan reports modest below-MEV as gentle info, not 'worth fixing'", infoBelowBeg > 0);
ok("#D2 the same shortfalls are warns under the default (intermediate) bar", warnBelowDefault >= infoBelowBeg);
ok("#D2 a SEVERELY short muscle (< 0.6×MEV) is still a warn even for a beginner",
  critiquePlan({ sessions: [{ name: "D", exercises: [{ exercise: "cable-crunch", sets: 1, rep_range: "10-15" }] }] }, kb, { experience: "beginner" })
    .findings.some((f) => f.severity === "warn" && /below MEV/.test(f.msg) && f.muscle === "abs"));

// --- the exercise-change lever (Wave 165) --------------------------------
// The KB's plateau playbook is an ORDER — volume → effort → deload → change
// exercise (logging-and-plateaus.md) — and only the first was implemented.
// Accessories rotated every block unconditionally (variety, not a response to
// anything) and compounds never rotated at all, so a stalled bench press could not
// be swapped by any code path in the app.
const stallProfile = { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], user_id: "stall-test" };
const pickedOf = (plan) => plan.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise));
const stallBase = generatePlan(stallProfile, kb, {});
const stallPicked = pickedOf(stallBase);
const stallAfter = pickedOf(generatePlan(stallProfile, kb, { stalledExercises: stallPicked }));
const stallUnchanged = stallAfter.filter((id) => stallPicked.includes(id));
// Some muscles genuinely have only one accessible exercise, so a few legitimately
// stay — what must not happen is the plan coming back unchanged.
ok("stalled lifts are replaced by alternatives for the same muscle", stallPicked.length > 0 && stallUnchanged.length < stallPicked.length);

const exByIdT = new Map(exercises.map((e) => [e.id, e]));
const stallCompounds = stallPicked.filter((id) => exByIdT.get(id)?.mechanic === "compound");
const rotatedOnly = pickedOf(generatePlan(stallProfile, kb, { blockIndex: 1 }));
ok("block rotation alone still never moves a compound (the documented behaviour this lever bypasses)",
  stallCompounds.length > 0 && stallCompounds.every((id) => rotatedOnly.includes(id)));
const swappedCompounds = pickedOf(generatePlan(stallProfile, kb, { stalledExercises: stallCompounds }));
ok("but a STALLED compound is swappable — the gap that left a plateaued bench unchangeable",
  stallCompounds.some((id) => !swappedCompounds.includes(id)));

// Demotion, not exclusion: stalling every option a thin pool has must still yield
// a real plan rather than an empty one.
const thinProfile = { training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 45,
  available_equipment: ["bodyweight"], user_id: "stall-thin" };
const thinPicked = pickedOf(generatePlan(thinProfile, kb, {}));
const thinAfter = generatePlan(thinProfile, kb, { stalledExercises: thinPicked });
ok("a muscle's ONLY option is still prescribed — demotion, not exclusion",
  thinAfter.program.sessions.reduce((a, s) => a + s.exercises.length, 0) > 0);

const detProfile = { training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 75,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], user_id: "stall-determinism" };
ok("absent, the plan is byte-identical — the determinism guarantee holds",
  JSON.stringify(generatePlan(detProfile, kb, {})) === JSON.stringify(generatePlan(detProfile, kb, { stalledExercises: [] })));

// --- cardio prescription (Wave 168) --------------------------------------
// The KB has carried real cardio numbers since Wave 161 and the plan engine emitted
// NOTHING (`grep cardio tools/plan-core.mjs` → zero hits), so a user asking "how
// much cardio should I do?" got nothing actionable from the app.
const cardioGuide = guidelines.find((g) => g.id === "cardio-concurrent-training");
const cardioProfile = (over = {}) => ({ training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 60,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], user_id: "cardio", ...over });
const c6 = generatePlan(cardioProfile(), kb, {}).program.cardio;
ok("the plan now prescribes a cardio dose at all", !!c6 && !!c6.steps_per_day && !!c6.sessions_per_week);
ok("every number comes from the guideline, not from the engine",
  c6.steps_per_day.min === cardioGuide.dose_by_goal.hypertrophy.steps_per_day.min &&
  c6.minutes_per_session.max === cardioGuide.dose_by_goal.hypertrophy.minutes_per_session.max);
ok("the dose is goal-specific (fat-loss asks for more than a gaining phase)",
  generatePlan(cardioProfile({ primary_goal: "fat-loss" }), kb, {}).program.cardio.steps_per_day.max > c6.steps_per_day.max);
ok("it carries the guideline's own Grade D — the dose ranges are practical models, not measured constants", c6.evidence_grade === "D");
ok("walking leads: the only modality the KB rates as costing nothing", c6.modality?.interference === "none");

// Placement is DERIVED from the split the engine chose, not guessed.
ok("#cardio on a 6-day PPL, hard cardio is placed only after non-leg-adjacent days",
  c6.placement.best_after.length > 0 && c6.placement.best_after.every((n) => /push/i.test(n)));
ok("#cardio and it names the leg sessions to keep away from", c6.placement.avoid_around.every((n) => /leg/i.test(n)));
// The honest empty answer: on a 4-day upper/lower EVERY day is a leg day or the day
// before one, so there is no safe slot — and saying so beats inventing one.
const c4 = generatePlan(cardioProfile({ days_per_week: 4 }), kb, {}).program.cardio;
ok("#cardio on a 4-day upper/lower no lifting day is safe, and the plan says so rather than inventing a slot",
  c4.placement.best_after.length === 0 && c4.placement.avoid_around.length === 2);

// Degrades cleanly: a KB without the guideline simply omits the block.
const noGuide = generatePlan(cardioProfile(), { exercises, muscles, contraindications }, {}).program;
ok("#cardio a KB with no guideline omits the block rather than inventing numbers", noGuide.cardio === undefined);

// --- KB fidelity trio (Wave 169) -----------------------------------------
// 1B: the KB's effort table has THREE rows — heavy compounds 1-3 RIR, "moderate
// compounds and most machine presses/rows" 0-2, isolation 0-1 — and the engine
// implemented two, keying only off `mechanic`. Self-contradictory as well as
// unfaithful: the ranker gives machines the LARGEST equipment bonus precisely
// because they're stable enough to push near failure, then said not to.
const rirProfile = { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 60,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], user_id: "rir-tier" };
const rirPlan = generatePlan(rirProfile, kb, {});
const exByIdR = new Map(exercises.map((e) => [e.id, e]));
const rirRows = rirPlan.program.sessions.flatMap((x) => x.exercises).map((e) => ({ ...e, ex: exByIdR.get(e.exercise) }));
const supportedRows = rirRows.filter((r) => r.ex?.mechanic === "compound" && r.ex?.stability === "high" && r.ex?.cns_cost !== "high");
const heavyRows = rirRows.filter((r) => r.ex?.mechanic === "compound" && !(r.ex?.stability === "high" && r.ex?.cns_cost !== "high"));
ok("#1B supported compounds (machines, smith, chest-supported) get the KB's middle tier, 0-2 RIR",
  supportedRows.length > 0 && supportedRows.every((r) => r.rir === "0-2"));
ok("#1B heavy free-weight compounds keep the 1-3 reserve",
  heavyRows.length > 0 && heavyRows.every((r) => r.rir === "1-3"));
ok("#1B isolations are untouched by the new tier", rirRows.filter((r) => r.ex?.mechanic === "isolation").every((r) => /^0-1$|^0-2$/.test(r.rir) === (r.rir === "0-1")));

// 1C: the KB's weak-point table says the priority muscle is "Trained first, when
// you're fresh" — the old tier*2+pri key could never deliver it, because tier
// always dominated, so a side-delt specialist's laterals sat behind every compound.
const specProfile = { training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 75,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], priority_muscles: ["side-delts"], specialization: true, user_id: "spec-order" };
const specPlan = generatePlan(specProfile, kb, {});
const upper = specPlan.program.sessions.find((x) => (x.exercises ?? []).some((e) => (exByIdR.get(e.exercise)?.primary_muscles ?? []).includes("side-delts")));
const firstEx = exByIdR.get(upper.exercises[0].exercise);
ok("#1C in a specialization block the priority muscle's work leads the session",
  (firstEx?.primary_muscles ?? []).includes("side-delts"));
// ...but never at the cost of burying genuinely heavy work behind an isolation.
const specLower = specPlan.program.sessions.find((x) => (x.exercises ?? []).some((e) => exByIdR.get(e.exercise)?.cns_cost === "high"));
{
  // UNCONDITIONAL, so the check count is stable: since the Wave-250 maintenance
  // consolidation a spec plan may contain no high-CNS lift at all (the 1-set
  // deadlift micro-doses are gone), and an `if` around ok() made the check
  // silently disappear — a skip that reads as a pass (lesson 52's shape). The
  // grid-wide #14f heaviest-first test still guards ordering universally.
  const idxHigh = specLower ? specLower.exercises.findIndex((e) => exByIdR.get(e.exercise)?.cns_cost === "high") : -1;
  const idxIso = specLower ? specLower.exercises.findIndex((e) => exByIdR.get(e.exercise)?.mechanic === "isolation") : -1;
  ok("#1C high-CNS compounds still lead when present — promotion doesn't bury a squat behind a raise", !specLower || idxIso === -1 || idxHigh < idxIso);
}
// An ORDINARY priority plan (no specialization) is byte-identical to before.
// This fixture used to switch specialization off with a stored `specialization: false`.
// Wave 187 stopped honouring that value (the old client wrote it for every user who was
// never shown the question, which froze the derivation out of everyone who already had
// an account), so the profile now reaches the no-block path the way a real user does:
// THREE priority areas, which the KB says is a volume tilt and not a block —
// "you can't specialize everything at once". The assertion is unchanged; only the route
// into the state it tests is, and side-delts is still a priority, so this still proves
// the promotion is gated on specialization rather than on priority.
const priOnly = { ...specProfile, specialization: undefined, priority_muscles: ["side-delts", "chest", "quadriceps"], user_id: "spec-order-off" };
ok("#1C without specialization the ordering is unchanged — the promotion is gated",
  generatePlan(priOnly, kb, {}).program.sessions.every((sn, i) => sn.exercises.every((e, j) => {
    const x = exByIdR.get(e.exercise);
    const prev = j > 0 ? exByIdR.get(sn.exercises[j - 1].exercise) : null;
    return !prev || !(prev.mechanic === "isolation" && x.mechanic === "compound"); // no isolation-before-compound
  })));

// 1C part two: a target the split can never deliver was silently missed. An advanced
// side-delt specialist targets mrv.max 26 but 2 sessions x the 10-set quality cap is
// 20 — and the under-target warning never fired, because 20 clears 0.6 x 26.
const capWarn = specPlan.rationale.warnings.find((w) => w.code === "frequency-capped" && w.muscle === "side-delts");
ok("#1C a target the split can't deliver is now stated, not silently missed", !!capWarn);
ok("#1C and it gives the KB's own answer — another day, not a longer session", /another training day/i.test(capWarn?.message ?? ""));

// 1D: general-fitness is a valid goal in the schema with no scheme, so it fell
// through a silent `?? hypertrophy` fallback (lesson 14: declared != supported).
const gf = generatePlan({ ...rirProfile, primary_goal: "general-fitness", user_id: "gf" }, kb, {});
ok("#1D general-fitness is now an explicit scheme, not a silent fallback",
  gf.program.sessions.flatMap((x) => x.exercises).every((e) => !!e.rir && !!e.rep_range));
// --- broad sweep: generatePlan + critiquePlan must never throw or produce a
// structurally invalid plan across the input space, not just the handful of
// hand-picked profiles above. A prior cloud-loop iteration hand-tested a wide
// cartesian sweep (training_status × days_per_week × primary_goal × equipment ×
// priority × specialization × session_length, plus every injury region ×
// severity) inline and found zero defects — this locks that coverage in as a
// permanent regression net instead of letting the one-off finding evaporate.
const regionList = Object.keys(contraindications.regions);
const sweepProfiles = [];
for (const training_status of ["beginner", "intermediate", "advanced"]) {
  for (const days_per_week of [2, 3, 4, 5, 6]) {
    for (const primary_goal of ["hypertrophy", "strength", "fat-loss", "recomposition"]) {
      sweepProfiles.push({ user_id: `sweep-${training_status}-${days_per_week}-${primary_goal}`, training_status, days_per_week, primary_goal, session_length_min: 60 });
    }
  }
}
// injury contraindications: the dimension most likely to exhaust an exercise
// pool (an equipment-restricted, injury-restricted advanced 6-day week) — swept
// separately since crossing it with every status/day/goal above would be
// combinatorially wasteful for a committed test.
for (const region of regionList) {
  for (const severity of ["mild", "moderate", "severe"]) {
    sweepProfiles.push({ user_id: `sweep-inj-${region}-${severity}`, training_status: "advanced", days_per_week: 6, primary_goal: "hypertrophy", available_equipment: ["bodyweight"], injuries: [{ region, severity }], session_length_min: 45 });
  }
}
// specialization + priority + a tight session, the other axis a pool can run dry on
for (const priority_muscles of [["chest"], ["side-delts", "biceps"], ["calves", "forearms", "abs"]]) {
  for (const specialization of [false, true]) {
    sweepProfiles.push({ user_id: `sweep-spec-${priority_muscles.join("+")}-${specialization}`, training_status: "advanced", days_per_week: 6, primary_goal: "recomposition", priority_muscles, specialization, session_length_min: 45 });
  }
}

let sweepThrew = null, sweepBadSets = null, sweepBadTargets = null, sweepCritiqueThrew = null;
for (const profile of sweepProfiles) {
  let sp;
  try {
    sp = generatePlan(profile, kb);
  } catch (err) {
    sweepThrew = { profile, err }; break;
  }
  const allEx = sp.program.sessions.flatMap((s) => s.exercises);
  if (!allEx.every((e) => Number.isInteger(e.sets) && e.sets >= 1 && e.sets <= 10)) { sweepBadSets = profile; break; }
  if (!Object.values(sp.rationale.volume_by_muscle).every((r) => Number.isFinite(r.target_sets) && r.target_sets >= 0)) { sweepBadTargets = profile; break; }
  try {
    const c = critiquePlan(sp.program, kb, { experience: profile.training_status });
    if (!c || typeof c.summary !== "string") { sweepCritiqueThrew = { profile, err: new Error("no summary") }; break; }
  } catch (err) {
    sweepCritiqueThrew = { profile, err }; break;
  }
}
if (sweepThrew) console.error("  sweep profile that threw:", JSON.stringify(sweepThrew.profile), sweepThrew.err.message);
ok(`sweep (${sweepProfiles.length} profiles across status/days/goal/injury/specialization): generatePlan never throws`, !sweepThrew);
ok("sweep: every generated set count is a 1-10 integer", !sweepBadSets);
ok("sweep: every volume rationale target is a finite, non-negative number", !sweepBadTargets);
if (sweepCritiqueThrew) console.error("  sweep profile whose critique threw:", JSON.stringify(sweepCritiqueThrew.profile), sweepCritiqueThrew.err.message);
ok("sweep: critiquePlan never throws and always returns a summary", !sweepCritiqueThrew);

// --- specialization is DERIVED, not asked (Wave 179, considerations #1) ----
// The app used to ask "How hard should I push those muscles?". That is a programming
// decision, and a lifter who could answer it wouldn't need the app to write their
// program. WHICH muscles they want is still theirs; HOW HARD is now the KB's call.
ok("deriveSpecialization: a beginner never gets a specialization block",
  deriveSpecialization({ training_status: "beginner", priority_muscles: ["chest"] }, muscles) === false);
ok("deriveSpecialization: no priority muscles → nothing to specialize",
  deriveSpecialization({ training_status: "advanced", priority_muscles: [] }, muscles) === false);
ok("deriveSpecialization: past the beginner phase, one or two areas → a real block",
  deriveSpecialization({ training_status: "intermediate", priority_muscles: ["chest"] }, muscles) === true
  && deriveSpecialization({ training_status: "advanced", priority_muscles: ["biceps", "triceps"] }, muscles) === true);
// "You can't specialize everything at once — that's just more volume everywhere,
// which recovery won't support" (variation-and-specialization.md).
ok("deriveSpecialization: three or more AREAS is NOT a specialization block",
  deriveSpecialization({ training_status: "advanced", priority_muscles: ["chest", "lats", "quadriceps"] }, muscles) === false);

// AREAS, not ids (Wave 187). The client's chips map to id ARRAYS — "Back" is
// ["lats","upper-back"], "Arms" is ["biceps","triceps"] — so counting ids made the
// threshold depend on the chip→id mapping instead of the rule the code cites.
ok("deriveSpecialization: Back alone is ONE area (two ids), so it still specializes",
  deriveSpecialization({ training_status: "intermediate", priority_muscles: ["lats", "upper-back"] }, muscles) === true);
ok("deriveSpecialization: Back + Arms is TWO areas (four ids) — the pairing the KB blesses",
  deriveSpecialization({ training_status: "intermediate", priority_muscles: ["lats", "upper-back", "biceps", "triceps"] }, muscles) === true);
// The falsifying case that proved this was a real defect and not a preference: the KB
// SHIPS this exact block as a program template, and the engine refused to build it.
const delrArms = ["side-delts", "biceps", "triceps"];
ok("deriveSpecialization: the KB's own specialization-delts-arms-4day shape (3 ids, 2 areas) is a block",
  deriveSpecialization({ training_status: "intermediate", priority_muscles: delrArms }, muscles) === true);
ok("deriveSpecialization: an unknown id counts as its own area, never silently merged",
  deriveSpecialization({ training_status: "advanced", priority_muscles: ["made-up-a", "made-up-b", "made-up-c"] }, muscles) === false);

// The stored value (Wave 187). `true` was only reachable by an explicit tap, so it is
// a real decision and still wins. `false` was written by the OLD client for every user
// who skipped the optional priority question and every beginner (the step's showIf hid
// it), so it cannot be told apart from silence — honouring it froze this derivation out
// of the entire pre-existing population while every test passed on fresh fixtures.
ok("deriveSpecialization: an explicit opt-IN still wins, even for a beginner",
  deriveSpecialization({ training_status: "beginner", priority_muscles: ["chest"], specialization: true }, muscles) === true);
ok("deriveSpecialization: a stored `false` no longer blocks the derivation — it was never necessarily an answer",
  deriveSpecialization({ training_status: "intermediate", priority_muscles: ["chest"], specialization: false }, muscles) === true);

// --- a specialization block ENDS (Wave 192) ------------------------------
// It used to re-derive on every generation with no counter, so one tap on one muscle
// chip held every other muscle at a maintenance dose forever. The KB: "Specialize one
// or two areas at a time, for ~4-8 weeks, then rebalance."
{
  const specProf = { user_id: "spec-expiry", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 4, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], priority_muscles: ["chest"] };
  ok("specializationActive: the profile still WANTS a block regardless of where it is",
    deriveSpecialization(specProf, muscles) === true);
  ok("specializationActive: block 0 is running one",
    specializationActive(specProf, muscles, 0) === true);
  ok("specializationActive: once SPEC_MAX_BLOCKS is reached the block is over",
    specializationActive(specProf, muscles, SPEC_MAX_BLOCKS) === false
    && specializationActive(specProf, muscles, SPEC_MAX_BLOCKS + 3) === false);
  // LITERAL indices, deliberately not written in terms of SPEC_MAX_BLOCKS: a test that
  // reads the same constant as the code cannot detect that constant being wrong. Found
  // by raising it to 9999 and watching this whole block stay green. The KB's window is
  // ~4-8 weeks and BLOCK_WEEKS is 6, so ONE block is the value being pinned here.
  ok("specialization is over by block 1 — the constant itself is pinned, not just its use",
    SPEC_MAX_BLOCKS === 1
    && specializationActive(specProf, muscles, 0) === true
    && specializationActive(specProf, muscles, 1) === false);
  // ...and the PLAN must actually rebalance, not just the predicate flip.
  const during = generatePlan(specProf, kb, { blockIndex: 0 });
  const after = generatePlan(specProf, kb, { blockIndex: SPEC_MAX_BLOCKS });
  const heldDuring = Object.values(during.rationale.volume_by_muscle).filter((v) => v.maintenance || v.eased).length;
  const heldAfter = Object.values(after.rationale.volume_by_muscle).filter((v) => v.maintenance || v.eased).length;
  ok("a finished specialization block takes every other muscle OFF maintenance (and off the eased dose)",
    heldDuring > 0 && heldAfter === 0);
  // The priority tilt survives — ending the block must not cost them their priority.
  const chestDuring = during.rationale.volume_by_muscle.chest.target_sets;
  const chestAfter = after.rationale.volume_by_muscle.chest.target_sets;
  const noPriority = generatePlan({ ...specProf, priority_muscles: [] }, kb, { blockIndex: SPEC_MAX_BLOCKS });
  ok("...while the priority muscle still gets MORE than an unprioritised one",
    chestAfter > noPriority.rationale.volume_by_muscle.chest.target_sets && chestDuring >= chestAfter);
  // And the card explains the transition instead of silently dropping the holds.
  const lineAfter = explainPersonalization(specProf, after.rationale, after.program).find((l) => l.input === "priority_muscles");
  ok("...and the plan card SAYS the block ran its course rather than quietly reverting",
    /run its course/.test(lineAfter.effect) && /back off maintenance/.test(lineAfter.effect));
  // W278 review: block_index resets on ANY training change, so a schedule change (Settings
  // days, the plan-fit "Rebuild for N days") re-armed a block that had already run. The
  // spent state rides its own flag: only a change of WHAT is prioritised starts another.
  ok("specializationActive: a SPENT block stays over at block 0 (a rebuild for a new schedule)",
    specializationActive(specProf, muscles, 0, true) === false && specializationActive(specProf, muscles, 0, false) === true);
  const spent = generatePlan(specProf, kb, { blockIndex: 0, specSpent: true });
  const heldSpent = Object.values(spent.rationale.volume_by_muscle).filter((v) => v.maintenance || v.eased).length;
  ok("...and the plan rebalances as an expired block does (block 0 WITHOUT the flag still specializes — the control), and says so",
    spent.rationale.goal_prescription.specialization.wants === true && spent.rationale.goal_prescription.specialization.active === false
    && heldSpent === 0 && heldDuring > 0
    && /run its course/.test(explainPersonalization(specProf, spent.rationale, spent.program).find((l) => l.input === "priority_muscles").effect));
  const lineDuring = explainPersonalization(specProf, during.rationale, during.program).find((l) => l.input === "priority_muscles");
  ok("...while a block still running says what it is costing, as before",
    /maintenance dose/.test(lineDuring.effect) && !/run its course/.test(lineDuring.effect));
  // A profile that never wanted a block is never held at maintenance in ANY block.
  // (Not a byte-identical check: accessory rotation legitimately varies projected sets
  // between block indices, which is what the first draft of this assertion caught.)
  const plainA = generatePlan({ ...specProf, priority_muscles: [] }, kb, { blockIndex: 0 });
  ok("a profile with no priorities is never maintenance-held, in either block",
    Object.values(plainA.rationale.volume_by_muscle).every((v) => !v.maintenance)
    && Object.values(noPriority.rationale.volume_by_muscle).every((v) => !v.maintenance)
    && plainA.rationale.goal_prescription.specialization.wants === false);
}

// The derivation must actually reach the plan — a pure predicate nothing calls is
// the declared-but-unused shape (lesson 14).
{
  const prof = { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], priority_muscles: ["chest"] };
  const { rationale } = generatePlan(prof, kb);
  const held = Object.values(rationale.volume_by_muscle).filter((v) => v.maintenance).length;
  ok("a priority muscle with NO specialization answer still gets a real block (derived)", held > 0);
  const three = generatePlan({ ...prof, priority_muscles: ["chest", "lats", "quadriceps"] }, kb);
  const heldThree = Object.values(three.rationale.volume_by_muscle).filter((v) => v.maintenance).length;
  ok("...while three priorities tilt volume without holding everything else at maintenance", heldThree === 0);
}

// --- the personalization is VISIBLE (Wave 179, considerations #1) ---------
{
  const prof = { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60,
    available_equipment: ["dumbbell", "bodyweight"], priority_muscles: ["chest"], injuries: [{ region: "lower-back", severity: "moderate" }] };
  const { program, rationale } = generatePlan(prof, kb);
  const lines = explainPersonalization(prof, rationale, program);
  const inputs = lines.map((l) => l.input);
  ok("explainPersonalization names every answer that shaped the plan",
    ["days_per_week", "session_length_min", "primary_goal", "priority_muscles", "available_equipment", "injuries"].every((k) => inputs.includes(k)));
  const pri = lines.find((l) => l.input === "priority_muscles");
  // It must quote what the week DELIVERS, not the target the split can't fit — this
  // card exists to prove the plan is honest, so it cannot itself overstate.
  const projected = rationale.volume_by_muscle.chest.projected_sets;
  ok("...and quotes the sets the week actually delivers, not the unreachable target",
    pri.effect.includes(`${projected} sets/wk`) && !pri.effect.includes(`${rationale.volume_by_muscle.chest.target_sets} sets/wk`));
  ok("...and says what the specialization trade actually cost", /maintenance/.test(pri.effect));
  // It must not count a muscle the plan never doses. `neck` carries the maintenance flag
  // but no session archetype trains it (projected 0, status "not-reached"). Since the
  // Wave-255 owner ruling the card reports TWO groups — eased-to-MEV (still growing)
  // and held-at-MV — each counted from its own flag, dosed muscles only.
  {
    const vol = rationale.volume_by_muscle;
    const flagged = Object.values(vol).filter((v) => v.maintenance).length;
    const dosedHeld = Object.values(vol).filter((v) => v.maintenance && (v.projected_sets ?? 0) > 0).length;
    const dosedEased = Object.values(vol).filter((v) => v.eased && (v.projected_sets ?? 0) > 0).length;
    const claimedEased = Number((pri.effect.match(/(\d+) other muscles? eased/) ?? [])[1]);
    const claimedHeld = Number((pri.effect.match(/(\d+) (?:more|other muscles?) held/) ?? [])[1]);
    ok("...and counts only the muscles it actually doses, never one projected at zero sets",
      (dosedEased === 0 || claimedEased === dosedEased)
      && (dosedHeld === 0 || claimedHeld === dosedHeld)
      && (dosedEased + dosedHeld) > 0
      && (vol.neck?.maintenance ? dosedHeld < flagged : true));
  }
  // A profile that answered nothing optional still explains the answers it DID give.
  const bare = { training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 45, available_equipment: ["bodyweight"] };
  const b = generatePlan(bare, kb);
  const bareLines = explainPersonalization(bare, b.rationale, b.program);
  ok("explainPersonalization never invents a line for an answer the user didn't give",
    bareLines.length > 0 && !bareLines.some((l) => l.input === "priority_muscles" || l.input === "injuries"));

  // The rep band must match the plan rendered directly above it (Wave 187). An advanced
  // hypertrophy lifter undulates: the generator discards `rep_scheme.compound`, so
  // quoting it printed "6-10" above a session list reading 4-6 / 6-10 / 10-15.
  const adv = { ...prof, training_status: "advanced", days_per_week: 6, session_length_min: 75,
    available_equipment: ["barbell", "dumbbell", "machine", "cable"] };
  const a = generatePlan(adv, kb);
  const advGoal = explainPersonalization(adv, a.rationale, a.program).find((l) => l.input === "primary_goal");
  const shipped = new Set(a.program.sessions.flatMap((s) => s.exercises.map((e) => e.rep_range)));
  ok("explainPersonalization: an undulating plan says so instead of quoting one discarded band",
    a.rationale.goal_prescription.undulating === true
    && a.rationale.goal_prescription.compound_bands.length > 1
    && a.rationale.goal_prescription.compound_bands.every((b) => shipped.has(b))
    && /cycle/.test(advGoal.effect));
  ok("...and every band it names is genuinely present in the built week",
    a.rationale.goal_prescription.compound_bands.every((b) => advGoal.effect.includes(b)));
  // The non-undulating path must be byte-identical to before.
  const lin = { ...prof, primary_goal: "strength" };
  const l2 = generatePlan(lin, kb);
  const linGoal = explainPersonalization(lin, l2.rationale, l2.program).find((l) => l.input === "primary_goal");
  // A rationale STORED BEFORE compound_bands existed: /api/plan/explain reads the stored
  // rationale rather than regenerating, so those users kept seeing the old wrong single
  // band. The card must not invent numbers it can't recover (the light band collides
  // with the isolation band, and a small split never uses all three), but it CAN always
  // tell that the week undulates, because that's a pure function of the profile.
  {
    const legacy = JSON.parse(JSON.stringify(a.rationale));
    delete legacy.goal_prescription.compound_bands;
    delete legacy.goal_prescription.undulating;
    const line = explainPersonalization(adv, legacy, a.program).find((l) => l.input === "primary_goal");
    ok("explainPersonalization: a pre-compound_bands rationale still says the week cycles",
      /cycle/.test(line.effect));
    ok("...and invents no band numbers it cannot recover from the stored plan",
      !/\d+-\d+ reps at/.test(line.effect) && !/6-10 reps/.test(line.effect));
    // The same legacy shape on a NON-undulating profile must keep the precise old copy.
    const legacyLin = JSON.parse(JSON.stringify(l2.rationale));
    delete legacyLin.goal_prescription.compound_bands;
    delete legacyLin.goal_prescription.undulating;
    const linLine = explainPersonalization(lin, legacyLin, l2.program).find((l) => l.input === "primary_goal");
    ok("...while a legacy NON-undulating rationale is unchanged, numbers and all",
      /reps in reserve/.test(linLine.effect) && !/cycle/.test(linLine.effect));
  }
  ok("...while a non-undulating plan still states one band with its RIR, exactly as before",
    l2.rationale.goal_prescription.compound_bands.length === 1
    && /reps in reserve/.test(linGoal.effect) && !/cycle/.test(linGoal.effect));
}

// --- the templates page must agree with the template DATA (Wave 181) ------
// The page used to link each template as `../../data/programs/*.json`, which the
// app renders as PLAIN TEXT — so an in-app reader of a page promising worked
// programs got five names and no prescription. The fix inlines the numbers, which
// is only safe if they can't drift: this parses them back out and recomputes them.
{
  const md = readFileSync("content/03-programming/program-templates.md", "utf8");
  const NAME_TO_ID = {
    "Beginner Full-Body": "beginner-full-body-3day", "Upper/Lower": "upper-lower-4day",
    "5-Day Hybrid": "five-day-hybrid", "Push/Pull/Legs": "push-pull-legs-6day",
    "Shoulders & Arms Specialization": "specialization-delts-arms-4day",
  };
  const idx = new Map(exercises.map((e) => [e.id, { name: e.name, primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] }]));
  const GROUP = { chest: "chest", lats: "back", "upper-back": "back", quadriceps: "legs", hamstrings: "legs",
    glutes: "legs", biceps: "arms", triceps: "arms", "side-delts": "delts", "front-delts": "delts", "rear-delts": "delts" };
  let mismatches = [];
  for (const [name, id] of Object.entries(NAME_TO_ID)) {
    const row = md.split("\n").find((l) => l.startsWith(`| ${name} |`) && /\| \d+ \| \d+ \|/.test(l));
    if (!row) { mismatches.push(`${name}: no numeric row on the page`); continue; }
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    const [, days, total, chest, back, legs, delts, arms] = cells;
    const prog = JSON.parse(readFileSync(`data/programs/${id}.json`));
    const rounds = Math.round(prog.days_per_week / prog.sessions.length);
    const sets = [];
    for (let r = 0; r < rounds; r++) for (const sn of prog.sessions) for (const e of sn.exercises)
      for (let i = 0; i < e.sets; i++) sets.push({ exercise: e.exercise, set_type: "work", weight_kg: 50, reps: 10 });
    const v = perMuscleWeeklyVolume([{ date: "2026-01-05", sets }], idx)["2026-W02"] || {};
    const g = {};
    for (const [m, n] of Object.entries(v)) { const k = GROUP[m]; if (k) g[k] = (g[k] || 0) + n; }
    const want = { days: prog.days_per_week, total: sets.length, chest: Math.round(g.chest || 0),
      back: Math.round(g.back || 0), legs: Math.round(g.legs || 0), delts: Math.round(g.delts || 0), arms: Math.round(g.arms || 0) };
    const got = { days: +days, total: +total, chest: +chest, back: +back, legs: +legs, delts: +delts, arms: +arms };
    for (const k of Object.keys(want)) if (want[k] !== got[k]) mismatches.push(`${name}.${k}: page ${got[k]} vs data ${want[k]}`);
  }
  ok("program-templates.md's set counts are recomputed from data/programs and match", mismatches.length === 0);
  if (mismatches.length) console.error("   ", mismatches.join("; "));
}

// The plan screen is the surface that exists to prove the plan is honest, so a
// number printed there must be one the plan contains. `hard_sets` used to report
// the INPUT budget while the 4c superset rescue legitimately places sets it does
// not bill — printing "capped at 12" above a 14-set session. The invariant is >=,
// not a magic 14: disable the rescue and this must still hold.
// beginner / 60 min / full gym is the input that REACHES the superset rescue — a
// 30-minute beginner never fires it and the fixture would prove nothing.
// W303: the rescue now fires only when MINUTES bind the set budget (a 30-minute beginner: budget 10 under the 12 cap),
// and survives only when its pair still fits the clock — so the fixture moved from 60 to 30 minutes.
const budgetPlan = generatePlan({ user_id: "budget-1", training_status: "beginner", primary_goal: "hypertrophy",
  days_per_week: 3, session_length_min: 30,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] }, kb);
const budgetBiggest = Math.max(...budgetPlan.program.sessions.map((s) => s.exercises.reduce((a, e) => a + e.sets, 0)));
const budgetRep = budgetPlan.rationale.goal_prescription.session_budget;
ok("session_budget.hard_sets is never less than the plan's biggest session",
  budgetRep.hard_sets >= budgetBiggest);
ok("...and this fixture actually reaches the superset rescue, so it isn't vacuous",
  budgetBiggest > budgetRep.budget);
ok("the personalization card quotes the delivered number, not the input cap",
  (explainPersonalization({ training_status: "beginner", days_per_week: 3, session_length_min: 60 },
    budgetPlan.rationale, budgetPlan.program).find((x) => x.input === "session_length_min")?.effect ?? "")
    .includes(String(budgetBiggest)));

// --- SECONDARY_SERVED tier (Wave 237, owner considerations #1) ---
// The KB's own prose is the specification here, and the generator was
// contradicting it: back.md — "Erectors need little direct work — deadlifts,
// RDLs, squats, rows, and carries already load them heavily; add back extensions
// only if they lag" [Grade C]; arms.md — forearm "dedicated work is optional
// unless grip or forearm size is a specific goal" [Grade C]. Measured before the
// fix: every Upper day carried a 2-set wrist curl that still left forearms at
// 2/6 MEV (fragmenting 8-muscle days into 8 exercises × 2 sets), and every
// int/adv Lower day summoned conventional-deadlift FOR spinal-erectors beside
// the hamstring RDL — two heavy hinges, one placed for a muscle the KB says the
// other already covers.
const ssProfile = { user_id: "ss-1", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], session_length_min: 60 };
const ssPlan = generatePlan(ssProfile, kb);
const ssFor = new Set(ssPlan.rationale.exercise_choices.map((c) => c.for_muscle));
ok("#SS no exercise is placed FOR forearms on a default plan (arms.md: optional unless prioritized)",
  !ssFor.has("forearms"));
ok("#SS no exercise is placed FOR spinal-erectors on a default plan (back.md: compounds already cover them)",
  !ssFor.has("spinal-erectors"));
// The KB's coverage claim, asserted the way the KB makes it. back.md's mechanism
// is EXPOSURE to heavy compound loading ("deadlifts, RDLs, squats, rows... already
// load them heavily"), so assert real exposure: several weekly hard sets of lifts
// that list the erectors as a secondary. The fractional 0.5-credit projection is
// deliberately NOT compared against the MV landmark here — bracing a heavy RDL is
// understated by half-credit arithmetic, and the landmark numbers are themselves
// Grade-C model estimates; where the prose and the proxy disagree, the prose is
// the specification (the depth gate's own lesson about proxies).
const ssErectorExposure = ssPlan.program.sessions.flatMap((s) => s.exercises)
  .filter((e) => (kb.exercises.find((x) => x.id === e.exercise)?.secondary_muscles ?? []).includes("spinal-erectors"))
  .reduce((a, e) => a + e.sets, 0);
ok("#SS ...and the erectors really ARE covered: ≥4 weekly hard sets of heavy compounds load them as a secondary",
  ssErectorExposure >= 4 && (ssPlan.rationale.volume_by_muscle["spinal-erectors"]?.projected_sets ?? 0) > 0);
ok("#SS the rationale says WHY per muscle — forearms is a GRIP story, not a set-count story",
  (ssPlan.rationale.volume_by_muscle["forearms"]?.reasons ?? []).join(" ").toLowerCase().includes("grip")
  && (ssPlan.rationale.volume_by_muscle["spinal-erectors"]?.reasons ?? []).join(" ").toLowerCase().includes("deadlift"));
// The "if they lag / specific goal" door the KB leaves open: prioritizing the
// muscle restores full direct work.
const ssPriPlan = generatePlan({ ...ssProfile, user_id: "ss-2", priority_muscles: ["forearms", "spinal-erectors"] }, kb);
const ssPriFor = new Set(ssPriPlan.rationale.exercise_choices.map((c) => c.for_muscle));
ok("#SS prioritizing forearms brings direct forearm work back", ssPriFor.has("forearms"));
ok("#SS prioritizing spinal-erectors brings direct erector work back", ssPriFor.has("spinal-erectors"));
// The critique must share the same tier (one exported set, lesson 35's
// one-predicate rule): a muscle the KB says to serve by secondary credit is not
// "worth fixing" for sitting below a direct-work MEV on a default plan.
const ssCrit = critiquePlan(ssPlan.program, kb, { experience: "intermediate" });
ok("#SS the critique never warns below-MEV for forearms/erectors on a default plan",
  !ssCrit.findings.some((f) => f.severity === "warn" && (f.muscle === "forearms" || f.muscle === "spinal-erectors")));
// The freed budget must land where the KB says growth needs it: chest and lats
// were sitting at 7 vs MEV 8 and 7 vs MEV 10 on this exact profile pre-fix.
const ssProj = (m) => ssPlan.rationale.volume_by_muscle[m]?.projected_sets ?? 0;
// W303 (deliberate): chest reached MEV here only because the 4c rescue crammed 2 unbilled sets past the intermediate's
// 16-set ceiling. With the ceiling honoured, chest's shortfall is NAMED with the lever that closes it (an extra day,
// which the options card offers) — never closed by cramming.
ok("#SS chest's shortfall on the flagship 4d/60m profile is named with the extra-day lever, inside the 16-set ceiling",
  ssPlan.program.sessions.every((s) => s.exercises.reduce((a, e) => a + e.sets, 0) <= 16)
  && (ssProj("chest") >= muscleById.get("chest").landmarks.mev.min
    || (ssPlan.rationale.warnings ?? []).some((w) => w.muscle === "chest" && /extra training day/.test(w.message))));
// The AGGREGATE pin, because the single-muscle one above proved too narrow: a
// mid-implementation measurement of this profile once claimed four majors clear
// MEV, and a later allocation change silently traded two of them away while the
// chest pin stayed green (lesson 39, against our own commit message). The
// flagship 4d/60m week is structurally MEV-short (the muscles' MEV sum exceeds
// its budget — the caveat's "add a day" is the true fix), so pin the measured
// distribution: most upper-body muscles clear, and the total shortfall stays
// bounded. Goes red on a real allocation regression; tolerates ±1-set drift.
const ssUpper = ["chest", "lats", "upper-back", "side-delts", "rear-delts", "biceps", "triceps"];
const ssClears = ssUpper.filter((m) => ssProj(m) >= muscleById.get(m).landmarks.mev.min);
const ssDeficit = ssUpper.reduce((a, m) => a + Math.max(0, muscleById.get(m).landmarks.mev.min - ssProj(m)), 0);
// (W303 re-measure, ceiling honoured: 4 of 7 clear, deficit 5.0 — was 5 and ≤6 with the rescue's unbilled sets.)
ok(`#SS flagship distribution: >=4 of 7 upper muscles clear MEV (got ${ssClears.length}) with total deficit <=6 (got ${ssDeficit.toFixed(1)})`,
  ssClears.length >= 4 && ssDeficit <= 6);

// --- caveat framing for GENERATED plans (Wave 238, owner considerations #2) ---
// "When a program is built there shouldn't be any things 'worth fixing' — it
// should be perfect as built... maybe a 'caveats' note where it explains a
// sacrifice that had to be made and how a small adjustment would let the app
// build a better program." Measured pre-fix: 120/120 freshly generated plans
// opened the Edit & review screen under "N things worth fixing" — the app
// red-flagging its own untouched output, on the cohort Goal 3 exists for.
const cvProfile = { user_id: "cv-1", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 2,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], session_length_min: 30 };
const cvPlan = generatePlan(cvProfile, kb);
const cvGen = critiquePlan(cvPlan.program, kb, { experience: "beginner", generated: true });
ok("#CV a generated plan's critique carries NO warn-severity findings — constraints become caveats",
  cvGen.findings.every((f) => f.severity !== "warn"));
ok("#CV ...and the summary never says 'worth fixing'",
  !/worth fixing/i.test(cvGen.summary));
ok("#CV a caveat names the LEVER (days or session length), not a defect",
  cvGen.findings.length > 0 && cvGen.findings.some((f) => /day|session/i.test(f.msg)));
// A DEAD lever must never be offered (the caveat's whole job is naming what
// would actually buy more): a beginner's budget is clamped by the QUALITY cap
// from 36 minutes up — 45- and 90-minute beginner plans are byte-identical — so
// "longer sessions" is inert for them, and only the day lever is real.
const cvB = generatePlan({ user_id: "cv-b", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3,
  available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], session_length_min: 60 }, kb);
const cvGenB = critiquePlan(cvB.program, kb, { experience: "beginner", generated: true, sessionMinutes: 60 });
ok("#CV no caveat offers 'longer sessions' to a quality-capped beginner — only the real day lever",
  cvGenB.findings.length > 0 && !cvGenB.findings.some((f) => /longer session/i.test(f.msg))
  && cvGenB.findings.some((f) => /extra training day/i.test(f.msg)));
ok("#CV the generator's own warnings drop the dead lever too",
  (cvB.rationale.warnings ?? []).length > 0 && !cvB.rationale.warnings.some((w) => /longer session/i.test(w.message ?? "")));

// The same program judged as a USER EDIT keeps the full critical framing —
// byte-identical to the pre-Wave-238 behavior (the critique still guards edits).
const cvEdit = critiquePlan(cvPlan.program, kb, { experience: "beginner" });
ok("#CV the un-generated path still warns (the critique keeps guarding hand edits)",
  cvEdit.findings.some((f) => f.severity === "warn") && /worth fixing/i.test(cvEdit.summary));

// --- maintenance days say so (Wave 250, owner report: "why is my leg day volume
// so low?") — the mechanism was right and unbelieved, which lesson 36 says means
// SHOW it: a session whose direct work is entirely held-at-maintenance muscles
// carries a rationale note the plan screens render at day level, where the
// question actually arises. Keyed by session name in the rationale (the
// compound_bands pattern) — the program stays schema-byte-compatible.
const mnProfile = { user_id: "mn-1", training_status: "advanced", primary_goal: "recomposition", days_per_week: 4,
  session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "band", "kettlebell"],
  priority_muscles: ["side-delts", "biceps", "triceps"] };
const mnPlan = generatePlan(mnProfile, kb);
ok("#MN the owner's exact profile runs a specialization block (premise)",
  mnPlan.rationale.goal_prescription.specialization.active === true);
const mnLower = mnPlan.program.sessions.filter((s) => /Low|Leg/i.test(s.name));
ok("#MN every reduced-dose day carries a 'light on purpose' rationale note naming its dose",
  mnLower.length > 0 && mnLower.every((s) => /light on purpose/i.test(mnPlan.rationale.session_notes?.[s.name] ?? "")
    && /growing|maintenance/i.test(mnPlan.rationale.session_notes[s.name])));
ok("#MN priority days carry NO such note",
  !Object.keys(mnPlan.rationale.session_notes ?? {}).some((n) => /Upper|Push|Pull/i.test(n) && !/Low|Leg/i.test(n)));
const mnPlain = generatePlan({ ...mnProfile, user_id: "mn-2", priority_muscles: [] }, kb);
ok("#MN a non-specialization plan has no session notes at all",
  Object.keys(mnPlain.rationale.session_notes ?? {}).length === 0);
// ...and the consolidation half of the same report: maintenance is a real dose,
// never 1-set scatter (three 1-set lifts shipped on one leg day).
ok("#MN a specialization plan prescribes NO 1-set exercises anywhere",
  mnPlan.program.sessions.every((s) => s.exercises.every((e) => e.sets >= 2)));

// --- the coverage floor keeps its own promise at 1-set headroom (Wave 254 audit) ---
// The Wave-250 >=2-set consolidation removed the old 1-set exception EVERYWHERE,
// including the last-chance weekly-coverage rescue — so on tight splits (2-day
// specialization) a held muscle whose final session had 1 set of budget left was
// rejected outright and went from a 1-set hold to ZERO for the whole week, silently
// detraining what its rationale claimed to hold (calves on this fixture). The
// restored door opens ONLY for a zero-credit muscle at its last chance — a muscle
// with any fractional credit keeps the 2-set floor, so residual scatter (the thing
// Wave 250 rightly killed: pre-250 this fixture ALSO shipped a 1-set RDL residual)
// stays dead. abs at zero here is a PRE-EXISTING infeasibility of a 2-day
// two-priority week (verified identical on the pre-250 engine), not this
// regression — dose-feasibility gating is recorded work, not this fix.
{
  const tight = generatePlan({ user_id: "cf-tight", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 2,
    session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], priority_muscles: ["side-delts", "chest"] }, kb);
  const tv = tight.rationale.volume_by_muscle;
  ok("#CF the last-chance rescue keeps a held muscle off zero (the Wave-250 calves regression)",
    tv.calves.projected_sets > 0);
  const tightOnes = tight.program.sessions.flatMap((s) => s.exercises.filter((e) => e.sets === 1).map((e) => e.exercise));
  ok("#CF ...via at most ONE single-set placement, and only for a zero-week muscle (no residual scatter)",
    tightOnes.length <= 1);
}

// --- the adaptive specialization dose (Wave 255, owner ruling): "non priority
// muscles should drop to MV when total weekly volume is high and recovery is of
// concern. Otherwise they should drop to MEV. This should be done automatically."
// Mechanism: an ease-to-MEV funding pass — a non-priority muscle rises from MV to
// MEV only when (a) no priority exercise reaches it (overlap-served muscles are
// already fed) and (b) every day serving it still fits the session budget with the
// priorities' full share counted FIRST. Fat-loss (a deficit) funds nothing.
{
  const adProfile = { user_id: "ad-1", training_status: "advanced", primary_goal: "recomposition", days_per_week: 4,
    session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "band", "kettlebell"],
    priority_muscles: ["side-delts", "biceps", "triceps"] };
  const ad = generatePlan(adProfile, kb);
  const vol = ad.rationale.volume_by_muscle;
  ok("#AD owner profile: lower-body muscles ease to exactly MEV (still growing), not held at MV",
    ["quadriceps", "hamstrings", "glutes", "calves", "abs"].every((m) =>
      vol[m].eased === true && !vol[m].maintenance && vol[m].target_sets === muscleById.get(m).landmarks.mev.min));
  ok("#AD eased muscles carry the 'eased' status, not 'maintenance'",
    vol.quadriceps.projected_status === "eased");
  ok("#AD overlap-served muscles (fed by the priority lifts) stay at MV",
    ["chest", "upper-back", "lats", "front-delts"].every((m) => vol[m].maintenance === true && !vol[m].eased));
  ok("#AD a budget-denied muscle stays at MV even without overlap (rear-delts on packed upper days)",
    vol["rear-delts"].maintenance === true && !vol["rear-delts"].eased);
  // W303 (deliberate): upper days now hold the advanced 20-set ceiling the rescue used to break (22), so side-delts
  // measured 13, not 16+ — still the most-served muscle, its shortfall the extra day's to close.
  ok("#AD priorities are untouched by the easing (side-delts keeps the most direct work, inside the 20-set ceiling)",
    vol["side-delts"].projected_sets >= 12 && ad.program.sessions.every((s) => s.exercises.reduce((a, e) => a + e.sets, 0) <= 20)
    && Object.entries(vol).every(([m, r]) => m === "side-delts" || (r.projected_sets ?? 0) <= vol["side-delts"].projected_sets));
  ok("#AD no growth warnings for eased muscles (deliberately capped is not under-dosed)",
    !ad.rationale.warnings.some((w) => ["below-mev", "below-mev-indirect", "under-target"].includes(w.code) && vol[w.muscle]?.eased));
  ok("#AD an eased muscle overshot by secondary credit gets an honest reason, not a stale MEV claim",
    Object.entries(vol).filter(([, v]) => v.eased).every(([m, v]) =>
      v.projected_sets <= muscleById.get(m).landmarks.mev.min + 1.5 || /secondary work/.test(v.reasons[0])));
  // The redistribution invariant (KB weak-point page: "don't specialize everything at
  // once — that's just more volume everywhere"): the spec week's direct sets never
  // exceed what the same profile would train with no block at all.
  const directTotal = (plan) => plan.program.sessions.reduce((a, s) => a + s.exercises.reduce((b, e) => b + e.sets, 0), 0);
  const adPlain = generatePlan({ ...adProfile, user_id: "ad-plain", priority_muscles: [] }, kb);
  ok("#AD redistribution, not addition: spec total direct sets <= the non-spec week's",
    directTotal(ad) <= directTotal(adPlain));
  ok("#AD fat-loss: nothing eases — a deficit already taxes recovery, MV is the honest dose",
    Object.values(generatePlan({ ...adProfile, user_id: "ad-cut", primary_goal: "fat-loss" }, kb)
      .rationale.volume_by_muscle).every((v) => !v.eased));
  // TAMPER pair (lesson 54): the budget gate must actually gate. A slackless 3-day
  // block (full-body days already at the budget) funds NOTHING while the owner's
  // 4-day block funds several. Remove the demand check and both fund everything;
  // remove the pass and both fund nothing — either tamper turns exactly one red.
  const adTight = generatePlan({ user_id: "ad-3d", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3,
    session_length_min: 45, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], priority_muscles: ["chest"], specialization: true }, kb);
  ok("#AD tamper pair: a slackless 3-day block funds zero eased muscles...",
    Object.values(adTight.rationale.volume_by_muscle).every((v) => !v.eased));
  ok("#AD ...while the owner's 4-day block funds several — the gate gates",
    Object.values(vol).filter((v) => v.eased).length >= 4);
  // Flag invariants, landmarks read from DATA (a tampered constant can't stay green):
  // the two flags are exclusive and each pins its own landmark.
  const adSweep = [ad, adPlain, adTight];
  ok("#AD invariant: eased XOR maintenance; eased => MEV.min, maintenance => MV.min",
    adSweep.every((plan) => Object.entries(plan.rationale.volume_by_muscle).every(([m, v]) =>
      !(v.eased && v.maintenance)
      && (!v.eased || v.target_sets === muscleById.get(m).landmarks.mev.min)
      && (!v.maintenance || v.target_sets === (muscleById.get(m).landmarks.mv?.min ?? v.target_sets)))));
}

// --- #golden (W272): a byte-level pin of the engine's whole output. The determinism
// checks above compare the engine to ITSELF (run twice, absent vs empty), so a refactor
// that changes what it emits stays green there (lesson 66). This pins program +
// rationale + meta over a fixed grid — every status × day count × two lengths × every
// goal × three equipment sets, plus the opts paths a default profile never touches
// (block rotation, stalled demotion, the adaptive tune, injuries, priorities,
// specialization on and expired, forced undulation, a clamped day count) — against a
// digest computed on the engine BEFORE W272 touched it.
// The KB is FROZEN in tools/fixtures/golden-kb.json (exercises cut to the fields the
// engine reads: id, name, primary/secondary_muscles, movement_pattern, mechanic,
// equipment, lengthened_bias, difficulty, cns_cost, citations, and — for the session-time
// model (W300, added before generatePlan reads them, so this pin did not move; easierSubstitutes already reads
// unilateral, outside this pin) — unilateral and alternating where the KB sets them; muscles,
// contraindications and the cardio guideline whole), so a KB data wave never moves
// this pin — only an engine change does. If the engine's output is MEANT to change,
// re-pin deliberately and say why in the commit; never re-pin to make it pass.
{
  const { createHash } = await import("node:crypto");
  const gkb = JSON.parse(readFileSync("tools/fixtures/golden-kb.json"));
  const EQ = { full: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], db: ["dumbbell", "bodyweight"], bw: ["bodyweight"] };
  const grid = [];
  for (const status of ["beginner", "intermediate", "advanced"])
    for (const days of [2, 3, 4, 5, 6])
      for (const len of [45, 90])
        for (const goal of ["hypertrophy", "strength", "fat-loss", "recomposition"])
          for (const eq of Object.keys(EQ))
            grid.push({ profile: { user_id: `g-${status}-${days}-${len}-${goal}-${eq}`, training_status: status, primary_goal: goal, days_per_week: days, session_length_min: len, available_equipment: EQ[eq] }, opts: {} });
  const bases = [
    { user_id: "o-int-4", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: EQ.full },
    { user_id: "o-adv-6", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 75, available_equipment: EQ.full },
    { user_id: "o-beg-3", training_status: "beginner", primary_goal: "strength", days_per_week: 3, session_length_min: 45, available_equipment: EQ.db },
  ];
  for (const b of bases) {
    const first = generatePlan(b, gkb).program.sessions[0].exercises.map((e) => e.exercise);
    for (const blockIndex of [1, 2]) grid.push({ profile: b, opts: { blockIndex } });
    grid.push({ profile: b, opts: { stalledExercises: first.slice(0, 2) } });
    grid.push({ profile: b, opts: { blockIndex: 1, stalledExercises: first.slice(0, 1), volumeAdjust: { chest: 2, biceps: -1, quadriceps: 3 } } });
    grid.push({ profile: { ...b, injuries: [{ region: "lower-back", severity: "moderate" }, { region: "shoulder", severity: "mild" }] }, opts: {} });
    grid.push({ profile: { ...b, priority_muscles: ["side-delts", "chest"] }, opts: {} });
    grid.push({ profile: { ...b, priority_muscles: ["side-delts"], specialization: true }, opts: { blockIndex: 0 } });
    grid.push({ profile: { ...b, priority_muscles: ["side-delts"], specialization: true }, opts: { blockIndex: 1 } });
    grid.push({ profile: { ...b, periodization: "undulating" }, opts: {} });
    grid.push({ profile: { ...b, days_per_week: 7 }, opts: {} });
  }
  const digestOf = (pts) => createHash("sha256").update(JSON.stringify(pts.map(({ profile, opts }) => generatePlan(profile, gkb, opts)))).digest("hex");
  // Re-pinned ONCE, deliberately (Wave 276): the only change across all 390 plans was the
  // side-delts warning on the 80 bodyweight-only plans — "below-mev" ("an extra training
  // day would let the plan give it more") became the honest "no-coverage" (no bodyweight
  // lift trains side delts directly). Programs, meta and every other rationale field were
  // diffed byte-identical against the previous engine before re-pinning. Re-pinned a
  // second time in the same wave, after its review: specialization-HELD muscles take the
  // same honesty — the one change was o-beg-3's neck (maintenance, nothing in
  // dumbbells+bodyweight trains it) losing its "an extra training day" lever.
  // Re-pinned a third time, DELIBERATELY, in W303 (considerations iteration — "60 minutes means 60 minutes"). Measured
  // against main over the 360 base plans before re-pinning: 344 programs changed (913 sessions). Sessions past their
  // quality ceiling went 712 → 0 (the 4c rescue now fires only when minutes bind the set budget, and its sets count
  // against the ceiling); 92 plans shed 544 sets to fit their minutes at the measured pace (pass 5a — nearly all at
  // 45 min); 94 days still over their minutes are flagged in meta.time_trim.unfit; 50 sessions keep a time-bought pair.
  // Every plan's meta gains time_trim. The volume levers now know when the clock bound (timeBound).
  // Re-pinned a fourth time, DELIBERATELY, in W305b/c (the Burst 8 review). Measured against 9524500 over all 390 plans:
  // 82 programs changed (153 sessions). The clock cuts 304 sets instead of 544 (72 plans instead of 92): an over-long
  // day now PAIRS two non-competing isolations first (23 new pairs, every set kept), a day within a minute of its length
  // is not over (the model is medians), and every shed tier keeps every guard — so 13 more days stay a little past their
  // minutes (75 → 88, all flagged and said on Today) rather than lose a muscle's last lift or its MEV. 0 days past the
  // quality ceiling. 59 plans' warnings changed: "longer sessions" is now offered per muscle, only where it helps. meta.
  // time_trim gains taken/paired; session_budget gains time_cut/over (for the explanation's honest line).
  // …and once more in W305h (the fix verification, C1/C13): 5a re-tries its pairing whenever a shed leaves a day
  // pair-free (the rescue pair's bonus gone). Measured against 9524500 again: 89 programs changed (183 sessions); the
  // clock now cuts 254 sets (was 304 at W305b, 544 before the review), days past their minutes 71 (was 88; 75 before),
  // 72 days pair instead of cutting, still 0 past the quality ceiling.
  ok("#golden the engine's output over the fixed grid (390 plans, opts paths included) is byte-identical to the pin",
    grid.length === 390 && digestOf(grid) === "eaa1fac692dd5ff3308a67a4a3f22435772d82423e72dee8d3de9c87e2e16390");
}

// --- W272 "Can't do this one?" — exclusions, ranked substitutes, the permanent swap ---
{
  const FULL = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  const exOf = new Map(exercises.map((e) => [e.id, e]));
  const placed = (plan) => new Set(plan.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)));
  const base = { user_id: "x-intermediate-4", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: FULL };
  const basePlan = generatePlan(base, kb);

  // #exclude — one predicate, read from the profile, so every rebuild door honours it
  // with no call-site edits (onboard, regenerate, graduation, block boundary, injury).
  const victims = [...placed(basePlan)].slice(0, 6);
  ok("#exclude an excluded lift is never placed — each of six lifts the default plan uses",
    victims.length === 6 && victims.every((id) => !placed(generatePlan({ ...base, unavailable_exercises: [{ id }] }, kb)).has(id)));
  ok("#exclude …on every opts path too (block rotation, stalled demotion)",
    [{ blockIndex: 2 }, { stalledExercises: [victims[1]] }].every((opts) => !placed(generatePlan({ ...base, unavailable_exercises: [{ id: victims[0] }] }, kb, opts)).has(victims[0])));
  ok("#exclude the editor's pool hides it as well — a lift you said isn't there is never offered back",
    !accessibleExercises({ ...base, unavailable_exercises: [{ id: victims[0] }] }, kb).some((e) => e.id === victims[0])
    && accessibleExercises(base, kb).some((e) => e.id === victims[0]));
  ok("#exclude an empty list is byte-identical to no list (every user today)",
    JSON.stringify(generatePlan({ ...base, unavailable_exercises: [] }, kb)) === JSON.stringify(basePlan));
  const kbUser = { ...base, available_equipment: [...FULL, "kettlebell"] };
  ok("#exclude ONE pool filter: carries are addable in the editor but never auto-placed",
    candidatePool(kbUser, kb, { includeCarries: true }).some((e) => e.movement_pattern === "carry")
    && !candidatePool(kbUser, kb).some((e) => e.movement_pattern === "carry"));

  // #subs — the ranked replacements for X in one session.
  const lowerB = basePlan.program.sessions.find((s) => s.exercises.some((e) => e.exercise === "hack-squat"));
  const hackSubs = bestSubstitutes("hack-squat", { profile: base, kb, program: basePlan.program, rationale: basePlan.rationale, sessionName: lowerB?.name });
  const hackTop = hackSubs.find((c) => c.fits);
  ok("#subs hack-squat → its best fitting replacement is a knee-dominant quad compound (same mechanic, same family)",
    !!lowerB && hackTop && exOf.get(hackTop.id).mechanic === "compound" && ["squat", "lunge"].includes(exOf.get(hackTop.id).movement_pattern)
    && exOf.get(hackTop.id).primary_muscles.includes("quadriceps") && hackTop.tier === 1);
  // The fit is judged with X's OWN slot removed: counting the lift being replaced made
  // every same-pattern option look like a 3rd copy (premortem cant-do-engine-2).
  const beg = { user_id: "x-beginner-4", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 45, available_equipment: FULL };
  const begPlan = generatePlan(beg, kb);
  const upperA = begPlan.program.sessions.find((s) => s.exercises.some((e) => e.exercise === "chest-supported-row") && s.exercises.some((e) => e.exercise === "chest-supported-rear-delt-row"));
  const rowTop = bestSubstitutes("chest-supported-row", { profile: beg, kb, program: begPlan.program, rationale: begPlan.rationale, sessionName: upperA?.name }).find((c) => c.fits);
  ok("#subs a row beside another row: the best fitting replacement is still a row (X's slot doesn't count against the pattern cap)",
    !!upperA && rowTop && exOf.get(rowTop.id).movement_pattern === "horizontal-pull");
  const begSubs = begPlan.program.sessions.flatMap((s) => s.exercises.flatMap((e) => bestSubstitutes(e.exercise, { profile: beg, kb, program: begPlan.program, rationale: begPlan.rationale, sessionName: s.name })));
  ok("#subs a beginner is never offered an advanced lift (the generator's hard gate, shared)",
    begSubs.length > 20 && begSubs.every((c) => exOf.get(c.id).difficulty !== "advanced"));
  ok("#subs never a carry, never X itself, never a lift already in the session",
    begPlan.program.sessions.every((s) => s.exercises.every((e) => bestSubstitutes(e.exercise, { profile: beg, kb, program: begPlan.program, rationale: begPlan.rationale, sessionName: s.name })
      .every((c) => exOf.get(c.id).movement_pattern !== "carry" && c.id !== e.exercise && (!c.fits || !s.exercises.some((o) => o.exercise === c.id))))));
  const stalledTop = bestSubstitutes("hack-squat", { profile: base, kb, program: basePlan.program, rationale: basePlan.rationale, sessionName: lowerB?.name, stalled: [hackTop?.id] }).find((c) => c.fits);
  ok("#subs a lift the user has stalled on is never the first pick when another fits", stalledTop && stalledTop.id !== hackTop?.id);
  ok("#subs a lift ruled out earlier today (exclude) is never handed back by a second 'Can't do' (W275 review)",
    hackTop && !bestSubstitutes("hack-squat", { profile: base, kb, program: basePlan.program, rationale: basePlan.rationale, sessionName: lowerB?.name, scope: "today", exclude: [hackTop.id] }).some((c) => c.id === hackTop.id));
  ok("#subs today's scope judges the LIVE session: a lift already swapped in today is never offered twice",
    !bestSubstitutes("hack-squat", { profile: base, kb, program: basePlan.program, rationale: basePlan.rationale, sessionName: lowerB?.name, scope: "today", live: [...lowerB.exercises.map((e) => e.exercise), hackTop?.id] })
      .some((c) => c.fits && c.id === hackTop?.id));

  // #always — the permanent swap: every slot X holds, progressively, all-or-nothing, and
  // never a program the generator itself could not have emitted.
  const PATTERN_CAP = 2, HIGH_CNS_CAP = 2;
  let applied = 0, refused = 0;
  const bad = [];
  const grid = [];
  for (const status of ["beginner", "intermediate", "advanced"])
    for (const days of [3, 4, 5, 6])
      for (const [eqName, eq] of Object.entries({ full: FULL, db: ["dumbbell", "bodyweight"], bw: ["bodyweight"] }))
        for (const goal of ["hypertrophy", "strength"])
          // 30 as well as 60 minutes (W303): the rescue pairs that these swaps must keep honest now appear only where the
          // clock binds — a 60-minute day is ceiling-bound, so a 60-only grid would test no pairing at all.
          for (const len of [30, 60])
            grid.push({ profile: { user_id: `al-${status}-${days}-${eqName}-${goal}${len === 30 ? "-30" : ""}`, training_status: status, primary_goal: goal, days_per_week: days, session_length_min: len, available_equipment: eq }, blockIndex: 0 });
  // W275 review: priority and specialization reorder sessions — swaps must keep THAT order
  // (an active block promotes the priority muscle; an expired one reverts to plain order).
  for (const days of [4, 5])
    for (const blockIndex of [0, 1])
      grid.push({ profile: { user_id: `al-spec-${days}-${blockIndex}`, training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: days, session_length_min: 60, available_equipment: FULL, priority_muscles: ["side-delts"], specialization: true }, blockIndex });
  grid.push({ profile: { user_id: "al-pri", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 75, available_equipment: FULL, priority_muscles: ["chest", "biceps"] }, blockIndex: 0 });
  const musclesIdx = new Map(muscles.map((m) => [m.id, m.landmarks ?? null]));
  const freshVolume = (program) => {
    const exIdx = new Map(exercises.map((e) => [e.id, { name: e.name, primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] }]));
    const w = perMuscleWeeklyVolume([{ date: "2026-01-05", sets: program.sessions.flatMap((s) => s.exercises.flatMap((e) => Array.from({ length: e.sets }, () => ({ exercise: e.exercise, set_type: "work" })))) }], exIdx);
    return w[Object.keys(w)[0]] ?? {};
  };
  let pairKept = 0, pairLostWithAPairingOption = 0;
  for (const { profile, blockIndex } of grid) {
          const plan = generatePlan(profile, kb, { blockIndex });
          const spec = specializationActive(profile, muscles, blockIndex);
          const before = JSON.stringify(plan);
          for (const X of placed(plan)) {
            const r = applySubstitution(plan.program, plan.rationale, X, { profile, kb, blockIndex });
            if (r.error) { refused++; continue; }
            applied++;
            const ses = r.program.sessions;
            const tag = `${profile.user_id}/${X}`;
            if (ses.some((s) => s.exercises.some((e) => e.exercise === X))) bad.push(`${tag}: X still in the plan`);
            const weekUse = {};
            for (const s of ses) {
              const ids = s.exercises.map((e) => e.exercise);
              if (new Set(ids).size !== ids.length) bad.push(`${tag}: duplicate in ${s.name}`);
              for (const id of new Set(ids)) weekUse[id] = (weekUse[id] ?? 0) + 1;
              const fam = {}; let high = 0;
              for (const e of s.exercises) { const x = exOf.get(e.exercise); if (x.mechanic === "compound") { fam[x.movement_pattern] = (fam[x.movement_pattern] ?? 0) + 1; if (x.cns_cost === "high") high++; } }
              if (Object.values(fam).some((n) => n > PATTERN_CAP)) bad.push(`${tag}: 3 of one pattern in ${s.name}`);
              if (high > HIGH_CNS_CAP) bad.push(`${tag}: 3 high-CNS in ${s.name}`);
              for (const e of s.exercises) if (e.superset_with) {
                const p = s.exercises.find((o) => o.exercise === e.superset_with);
                const mus = (x) => new Set([...(x.primary_muscles ?? []), ...(x.secondary_muscles ?? [])]);
                if (!p) bad.push(`${tag}: dangling superset in ${s.name}`);
                else if (exOf.get(e.exercise).mechanic !== "isolation" || exOf.get(p.exercise).mechanic !== "isolation" || [...mus(exOf.get(e.exercise))].some((m) => mus(exOf.get(p.exercise)).has(m))) bad.push(`${tag}: a superset that isn't two non-competing isolations in ${s.name}`);
              }
              const sorted = JSON.stringify(orderSessionItems(s.exercises.map((e) => ({ ...e })), exOf, { priority: new Set(profile.priority_muscles ?? []), specialization: spec }));
              if (sorted !== JSON.stringify(s.exercises)) bad.push(`${tag}: ${s.name} not in lifting order`);
            }
            if (Object.values(weekUse).some((n) => n > 2)) bad.push(`${tag}: a lift in 3 sessions`);
            const choices = r.rationale.exercise_choices;
            if (choices.some((c) => c.exercise === X)) bad.push(`${tag}: rationale still explains X`);
            for (const { session, to } of r.replaced) {
              if (to == null) continue; // a superset bonus that couldn't be re-paired leaves (checked below)
              const c = choices.find((cc) => cc.session === session && cc.exercise === to);
              if (!c || !c.why.some((w) => /isn't available/.test(w))) bad.push(`${tag}: no honest 'why' for ${to} in ${session}`);
            }
            // W275 review: the rationale's weekly volumes describe the plan AS SWAPPED.
            const fresh = freshVolume(r.program);
            const vsLm = volumeVsLandmarks(fresh, musclesIdx);
            for (const [m, v] of Object.entries(r.rationale.volume_by_muscle ?? {})) {
              if ((v.projected_sets ?? 0) !== (fresh[m] ?? 0)) bad.push(`${tag}: ${m} projected ${v.projected_sets}, the plan gives ${fresh[m] ?? 0}`);
              const plain = !v.secondary_served && !v.eased && !v.maintenance;
              if (plain && v.frequency && v.projected_status !== (vsLm[m]?.status ?? "no-data")) bad.push(`${tag}: ${m} status ${v.projected_status} ≠ ${vsLm[m]?.status}`);
            }
            // …and a superset slot keeps its pairing whenever any fitting replacement could.
            for (const s of plan.program.sessions) for (const e of s.exercises) if (e.exercise === X && e.superset_with) {
              const after = r.program.sessions.find((x) => x.name === s.name);
              const partnerStill = after.exercises.find((x) => x.exercise === e.superset_with);
              const couldPair = bestSubstitutes(X, { profile, kb, program: plan.program, rationale: plan.rationale, sessionName: s.name }).some((c) => c.fits && c.keeps_pair);
              if (partnerStill?.superset_with) pairKept++;
              else if (couldPair) { pairLostWithAPairingOption++; bad.push(`${tag}: ${s.name} lost its superset though a pairing replacement fitted`); }
              // Wave 276: whichever member X was, a rescue BONUS never runs unpaired (its time is
              // paid only by a pairing): it is re-paired with another non-competing isolation in
              // the session — the generator's own rescue rule — or it leaves.
              for (const c of r.rationale.exercise_choices) {
                if (c.session !== s.name || !/^superset — fits extra volume/.test(c.why?.[0] ?? "")) continue;
                const item = after.exercises.find((x) => x.exercise === c.exercise);
                if (!item?.superset_with) bad.push(`${tag}: ${s.name}'s bonus ${c.exercise} runs unpaired`);
              }
              // Every "paired with Z" the rationale states is a real, mutual pairing in the plan.
              for (const c of r.rationale.exercise_choices) for (const w of c.why ?? []) {
                const z = /^paired with (.+)$/.exec(w)?.[1];
                if (!z) continue;
                const sess2 = r.program.sessions.find((x) => x.name === c.session);
                const it = sess2?.exercises.find((x) => x.exercise === c.exercise), mate = sess2?.exercises.find((x) => x.exercise === z);
                if (it?.superset_with !== z || mate?.superset_with !== c.exercise) bad.push(`${tag}: ${c.session} says ${c.exercise} is paired with ${z}, the plan disagrees`);
              }
              // A rescue BONUS (its time is paid only by the pairing) never stays as a lone extra lift.
              const bonusWhy = (plan.rationale.exercise_choices.find((c) => c.session === s.name && c.exercise === X)?.why ?? [])[0] ?? "";
              if (/^superset — fits extra volume/.test(bonusWhy) && !partnerStill?.superset_with && after.exercises.some((x) => !plan.program.sessions.find((y) => y.name === s.name).exercises.some((y) => y.exercise === x.exercise) && !x.superset_with))
                bad.push(`${tag}: the bonus became an unpaired extra lift in ${s.name}`);
            }
          }
          if (JSON.stringify(plan) !== before) bad.push(`${profile.user_id}: applySubstitution mutated its input`);
  }
  // …and the re-pairing path is really exercised (not vacuously green).
  let rePaired = 0, bonusDropped = 0;
  for (const { profile, blockIndex } of grid) {
    const plan = generatePlan(profile, kb, { blockIndex });
    for (const s of plan.program.sessions) for (const e of s.exercises) {
      if (!e.superset_with) continue;
      const bonus = plan.rationale.exercise_choices.find((c) => c.session === s.name && c.exercise === e.superset_with && /^superset — fits extra volume/.test(c.why?.[0] ?? ""));
      if (!bonus) continue; // e is the bonus itself, or not a rescue pair
      const r = applySubstitution(plan.program, plan.rationale, e.exercise, { profile, kb, blockIndex, sessionName: s.name });
      if (r.error) continue;
      const after = r.program.sessions.find((x) => x.name === s.name);
      const b = after.exercises.find((x) => x.exercise === bonus.exercise);
      if (b?.superset_with && b.superset_with !== e.exercise && !r.replaced.some((x) => x.to === b.superset_with)) rePaired++;
      if (!b) bonusDropped++;
    }
  }
  // Generated plans essentially never reach the RE-PAIR branch (a rescue's partner is
  // usually the session's only free non-competing isolation), so the hand-built "Mix"
  // session below is that branch's coverage; this sweep proves the drop path is real.
  // W303: the rescue's pairs now live only on clock-bound days, where a partner's replacement can always pair — the
  // sweep still guards every generated swap (bad is empty), and the DROP path gets its own hand-built session below.
  ok(`#always every generated partner swap keeps the generator's invariants (${bonusDropped} dropped, ${rePaired} re-paired in generated plans)`, bad.length === 0);
  // The drop path, on a session built to need it: leg extension carries the rescue bonus (a cable curl); every other quad
  // isolation is excluded, so its replacement must be a compound — which can't pair — and nothing else in the session
  // can carry the curl. The bonus goes, rather than staying as an unpaired lift whose time nothing pays.
  {
    const prof = { user_id: "drop-1", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: FULL,
      unavailable_exercises: exercises.filter((e) => e.mechanic === "isolation" && e.primary_muscles.includes("quadriceps") && e.id !== "leg-extension").map((e) => ({ id: e.id })) };
    const program = { id: "gen-test", sessions: [{ name: "Solo", exercises: [
      { exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-2" },
      { exercise: "leg-extension", sets: 3, rep_range: "10-15", rir: "1-2", superset_with: "cable-curl" },
      { exercise: "cable-curl", sets: 2, rep_range: "10-15", rir: "1-2", superset_with: "leg-extension" }] }] };
    const rationale = { exercise_choices: [
      { exercise: "barbell-bench-press", for_muscle: "chest", session: "Solo", why: ["compound before isolations"] },
      { exercise: "leg-extension", for_muscle: "quadriceps", session: "Solo", why: ["fills residual volume for quadriceps"] },
      { exercise: "cable-curl", for_muscle: "biceps", session: "Solo", why: ["superset — fits extra volume into your session length", "paired with leg-extension"] }] };
    const r = applySubstitution(program, rationale, "leg-extension", { profile: prof, kb, sessionName: "Solo" });
    const solo = r.program?.sessions[0].exercises ?? [];
    ok("#always a partner swap whose replacement can't pair takes the bonus out when nothing else can pair it",
      !r.error && exOf.get(r.replaced?.[0]?.to)?.mechanic === "compound" && !solo.some((e) => e.exercise === "cable-curl") && solo.every((e) => !e.superset_with));
  }
  // The re-pair path, on a session built to need it: leg extension (quads) carries the
  // rescue bonus (a cable curl); a triceps extension sits unpaired beside them; every
  // other quad isolation is excluded, so leg extension's replacement must be a compound —
  // which can't pair. The curl's time is still paid by a pairing: it moves to the
  // triceps extension (non-competing), exactly as the generator's 4c rescue would.
  {
    const prof = { user_id: "repair-1", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: FULL,
      unavailable_exercises: exercises.filter((e) => e.mechanic === "isolation" && e.primary_muscles.includes("quadriceps") && e.id !== "leg-extension").map((e) => ({ id: e.id })) };
    const program = { id: "gen-test", sessions: [{ name: "Mix", exercises: [
      { exercise: "barbell-bench-press", sets: 3, rep_range: "6-10", rir: "1-2" },
      { exercise: "leg-extension", sets: 3, rep_range: "10-15", rir: "1-2", superset_with: "cable-curl" },
      { exercise: "overhead-cable-triceps-extension", sets: 3, rep_range: "10-15", rir: "1-2" },
      { exercise: "cable-curl", sets: 2, rep_range: "10-15", rir: "1-2", superset_with: "leg-extension" }] }] };
    const rationale = { exercise_choices: [
      { exercise: "barbell-bench-press", for_muscle: "chest", session: "Mix", why: ["compound before isolations"] },
      { exercise: "leg-extension", for_muscle: "quadriceps", session: "Mix", why: ["fills residual volume for quadriceps"] },
      { exercise: "overhead-cable-triceps-extension", for_muscle: "triceps", session: "Mix", why: ["fills residual volume for triceps"] },
      { exercise: "cable-curl", for_muscle: "biceps", session: "Mix", why: ["superset — fits extra volume into your session length", "paired with leg-extension"] }] };
    const r = applySubstitution(program, rationale, "leg-extension", { profile: prof, kb, sessionName: "Mix" });
    const mix = r.program?.sessions[0].exercises ?? [];
    const curl = mix.find((e) => e.exercise === "cable-curl"), tri = mix.find((e) => e.exercise === "overhead-cable-triceps-extension");
    const quadSub = r.replaced?.[0]?.to;
    ok("#always a partner swap that can't keep the pair RE-PAIRS the bonus with another non-competing isolation (the 4c rule), why updated",
      !r.error && exOf.get(quadSub)?.mechanic === "compound" && curl?.superset_with === "overhead-cable-triceps-extension" && tri?.superset_with === "cable-curl"
      && r.rationale.exercise_choices.find((c) => c.exercise === "cable-curl")?.why.includes("paired with overhead-cable-triceps-extension") && !r.dropped.length);
  }
  ok(`#always the permanent swap keeps every generator invariant (${applied} applied, ${refused} refused with no write; ${pairKept} pairings kept)${bad.length ? " — " + bad.slice(0, 3).join("; ") : ""}`,
    applied > 1000 && bad.length === 0 && pairKept > 0 && grid.length === 149);
  // A muscle emptied by the user's OWN exclusions is told the lever that will help.
  const calfIds = candidatePool(base, kb).filter((e) => e.primary_muscles.includes("calves")).map((e) => e.id);
  const noCalves = generatePlan({ ...base, unavailable_exercises: calfIds.map((id) => ({ id })) }, kb).rationale.warnings.find((w) => w.code === "no-coverage" && w.muscle === "calves");
  ok("#exclude a muscle your exclusions emptied names THAT lever (bring one back on the Plan tab) — even with indirect credit from other lifts",
    calfIds.length > 0 && noCalves && /marked unavailable/.test(noCalves.message) && /bring one back/.test(noCalves.message)
    && !generatePlan({ ...base, unavailable_exercises: calfIds.map((id) => ({ id })) }, kb).rationale.warnings.some((w) => w.muscle === "calves" && w.code !== "no-coverage"));
  const absIds = candidatePool(base, kb).filter((e) => e.primary_muscles.includes("abs")).map((e) => e.id);
  const noAbs = generatePlan({ ...base, unavailable_exercises: absIds.map((id) => ({ id })) }, kb).rationale.warnings.find((w) => w.code === "no-coverage" && w.muscle === "abs");
  ok("#exclude …and with none at all", noAbs && /marked unavailable/.test(noAbs.message) && !/other lifts give it/.test(noAbs.message));
  const dbAbs = generatePlan({ ...base, available_equipment: ["dumbbell"] }, kb).rationale.warnings.find((w) => w.code === "no-coverage" && w.muscle === "abs");
  ok("#exclude …while a gap no exclusion caused keeps the equipment copy", dbAbs && !/unavailable/.test(dbAbs.message) && /your equipment/.test(dbAbs.message));
  // Wave 276: a muscle NOTHING the plan could place trains directly (side delts with
  // bodyweight only — no KB bodyweight lift trains them as a primary) was told "an extra
  // training day would let the plan give it more". No day, minute or priority can add
  // direct work there; the honest warning names what other lifts give it and the levers
  // that CAN help.
  const bwNc = generatePlan({ user_id: "nc-bw", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: ["bodyweight"] }, kb);
  const sdW = bwNc.rationale.warnings.filter((w) => w.muscle === "side-delts");
  ok("#no-direct side delts with bodyweight only: one honest warning — no direct exercise, what other lifts give it — never 'an extra training day'",
    sdW.length === 1 && sdW[0].code === "no-coverage" && /directly/.test(sdW[0].message) && /sets\/wk/.test(sdW[0].message) && !/training day|session time|session length|priority/i.test(sdW[0].message));
  const ncBad = [];
  for (const [en, eq] of Object.entries({ bw: ["bodyweight"], dbonly: ["dumbbell"], band: ["band", "bodyweight"], kbell: ["kettlebell", "bodyweight"] }))
    for (const st of ["beginner", "intermediate", "advanced"]) for (const d of [2, 4, 6]) for (const pri of [null, ["chest"], ["chest", "lats"]]) {
      // W276 review: specialization HOLDS non-priority muscles — their maintenance/eased
      // branches must keep the same honesty (a block can't add an exercise either).
      const prof = { user_id: `nc-${en}-${st}-${d}-${pri?.join("+") ?? "none"}`, training_status: st, primary_goal: "hypertrophy", days_per_week: d, session_length_min: 60, available_equipment: eq,
        ...(pri ? { priority_muscles: pri, specialization: true } : {}) };
      const pool = candidatePool(prof, kb);
      for (const w of generatePlan(prof, kb).rationale.warnings)
        if (w.muscle && !pool.some((e) => (e.primary_muscles ?? []).includes(w.muscle)) && /training day|session time|longer session|priority muscle/i.test(w.message)) ncBad.push(`${prof.user_id}/${w.muscle}/${w.code}`);
    }
  ok(`#no-direct no muscle without a placeable exercise is ever sent to a day/time/priority lever${ncBad.length ? " — " + ncBad.slice(0, 3).join(", ") : ""}`, ncBad.length === 0);
  // W276 review: the honest no-coverage copy QUOTES what other lifts give the muscle — so
  // after a permanent swap moves that number, the quote must move with it.
  {
    const staleQuotes = [];
    for (const [en, eq] of Object.entries({ bw: ["bodyweight"], machine: ["machine"], band: ["band", "bodyweight"] }))
      for (const st of ["beginner", "intermediate", "advanced"]) for (const d of [2, 4]) {
        const prof = { user_id: `nq-${en}-${st}-${d}`, training_status: st, primary_goal: "hypertrophy", days_per_week: d, session_length_min: 60, available_equipment: eq };
        const plan = generatePlan(prof, kb);
        for (const X of placed(plan)) {
          const r = applySubstitution(plan.program, plan.rationale, X, { profile: prof, kb });
          if (r.error) continue;
          for (const w of r.rationale.warnings) {
            const q = w.code === "no-coverage" && /~([\d.]+) sets\/wk/.exec(w.message);
            if (q && Number(q[1]) !== (r.rationale.volume_by_muscle[w.muscle]?.projected_sets ?? 0)) staleQuotes.push(`${prof.user_id}/${X}: ${w.muscle} quotes ~${q[1]}, projected ${r.rationale.volume_by_muscle[w.muscle]?.projected_sets}`);
          }
        }
      }
    ok(`#no-direct after a permanent swap the no-coverage copy quotes the plan AS SWAPPED${staleQuotes.length ? " — " + staleQuotes.slice(0, 2).join("; ") : ""}`, staleQuotes.length === 0);
  }
  ok("#always all-or-nothing: a refusal names why and returns no program", (() => {
    const r = applySubstitution(basePlan.program, basePlan.rationale, "not-a-lift-in-this-plan", { profile: base, kb });
    return r.error === "not-in-plan" && !r.program;
  })());
}

// W283: a NAMED exercise can be cautioned for an injury region, beside the pattern rules. The
// lower-back rule's own note names loaded spinal flexion, yet no pattern rule caught the Jefferson
// curl (its pattern, isolation-spinal-flexion, is shared with every crunch).
{
  const gym = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  const pool = (sev) => accessibleExercises({ available_equipment: gym, injuries: [{ region: "lower-back", severity: sev }] }, kb).map((e) => e.id);
  ok("W283 a moderate or severe low-back injury keeps the Jefferson curl out of every pool", !pool("moderate").includes("jefferson-curl") && !pool("severe").includes("jefferson-curl"));
  // W283 review: excluded at ANY severity — loaded end-range spinal flexion is this lift's whole
  // purpose, and it is the aggravator the lower-back rule's own note names (unlike a hinge or a
  // squat, which load a neutral spine and sit in the caution tier).
  ok("W283 …and a mild one too: the rule's own note names loaded spinal flexion", !pool("mild").includes("jefferson-curl"));
  ok("W283 contraRegion names WHY a lift is out (for the swap note)", contraRegion(exercises.find((e) => e.id === "jefferson-curl"), [{ region: "lower-back", severity: "mild" }], contraindications) === "lower-back"
    && contraRegion(exercises.find((e) => e.id === "cable-crunch"), [{ region: "lower-back", severity: "severe" }], contraindications) === null);
  const cauKb = { ...kb, contraindications: { regions: { knee: { exclude_patterns: [], caution_patterns: [], caution_exercises: ["jefferson-curl"] } } } };
  const kneePool = (sev) => accessibleExercises({ available_equipment: gym, injuries: [{ region: "knee", severity: sev }] }, cauKb).map((e) => e.id);
  ok("W283 caution_exercises keeps its tiers: moderate excludes, mild allows", !kneePool("moderate").includes("jefferson-curl") && kneePool("mild").includes("jefferson-curl"));
  ok("W283 …and only the named lift: crunches (same pattern) stay available at moderate", pool("moderate").includes("cable-crunch"));
  const exKb = { ...kb, contraindications: { regions: { knee: { exclude_patterns: [], caution_patterns: [], exclude_exercises: ["jefferson-curl"] } } } };
  ok("W283 exclude_exercises applies at ANY severity", !accessibleExercises({ available_equipment: gym, injuries: [{ region: "knee", severity: "mild" }] }, exKb).some((e) => e.id === "jefferson-curl"));
}

// #easier (Burst 6 — owner: "I was too tired after doing leg press and RDLs to do Bulgarian split squats. There is
// currently no solution… besides 'skip this one'"). Of the lifts that FIT today's slot, the ones easier on a tired body:
// no worse on systemic cost, stability or skill, and strictly better on cost or stability — easiest first; within a
// class, one the user has history on first (its weight comes pre-filled), then the slot's own ranking.
{
  const lower = { sessions: [{ name: "Lower", exercises: ["leg-press", "romanian-deadlift", "bulgarian-split-squat", "lying-leg-curl", "standing-calf-raise"].map((exercise) => ({ exercise, sets: 3, rep_range: "8-12", rir: "1-3" })) }] };
  const FULL = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  const live = lower.sessions[0].exercises.map((e) => e.exercise);
  const easier = (equip, X = "bulgarian-split-squat", known = []) => {
    const profile = { user_id: "tired-1", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60, available_equipment: equip };
    const fitting = bestSubstitutes(X, { profile, kb, program: lower, sessionName: "Lower", scope: "today", live }).filter((s) => s.fits);
    return easierSubstitutes(fitting, X, { kb, known }).map((s) => s.id);
  };
  const full = easier(FULL);
  ok("#easier a full gym, split squats after leg press and RDLs: leg extension first (low cost, stable), then the steadier squats",
    JSON.stringify(full) === JSON.stringify(["leg-extension", "hack-squat", "goblet-squat"]));
  ok("#easier dumbbells only: the goblet squat (two feet down) — never the walking lunge or step-up (no steadier), never the sissy squat (skill)",
    JSON.stringify(easier(["dumbbell", "bodyweight"])) === JSON.stringify(["goblet-squat"]));
  ok("#easier bodyweight only: the squat, then the plain lunge (a unilateral lift of unknown stability counts as unsteady, but it costs less)",
    JSON.stringify(easier(["bodyweight"])) === JSON.stringify(["bodyweight-squat", "bodyweight-lunge"]));
  ok("#easier the easiest lift already: nothing easier", easier(FULL, "leg-extension").length === 0);
  ok("#easier within a class, a lift the user has history on comes first; otherwise the slot's own ranking",
    JSON.stringify(easierSubstitutes([{ id: "hack-squat" }, { id: "leg-press" }], "bulgarian-split-squat", { kb, known: ["leg-press"] }).map((s) => s.id)) === JSON.stringify(["leg-press", "hack-squat"])
    && JSON.stringify(easierSubstitutes([{ id: "hack-squat" }, { id: "leg-press" }], "bulgarian-split-squat", { kb }).map((s) => s.id)) === JSON.stringify(["hack-squat", "leg-press"]));
  ok("#easier deterministic, and an unknown lift has nothing to compare against", JSON.stringify(easier(FULL)) === JSON.stringify(full) && easierSubstitutes([{ id: "leg-extension" }], "no-such-lift", { kb }).length === 0);
}

// --- W303 (considerations iteration, Burst 8 — owner: "My leg day has 22 sets. 1 minute to do each set with 3 minutes
// rest between each set equates to 88 mins not the 60 per workout I chose"). The superset rescue only ever buys TIME:
// it fires only when minutes bind the set budget, and its sets count against the quality cap. A day still over its
// minutes at the measured pace sheds sets (pass 5a) and records them (meta.time_trim), so the plan can offer the three
// ways to get them back — never silently shipping less, never silently running long.
{
  const exById = new Map(exercises.map((e) => [e.id, e]));
  const CAP = { beginner: 12, intermediate: 16, advanced: 20 };
  const FULL = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  let sessions = 0, overCap = 0, overTime = 0, unflagged = 0;
  for (const st of ["beginner", "intermediate", "advanced"]) for (const days of [2, 3, 4, 5, 6]) for (const len of [30, 45, 60, 75, 90])
    for (const goal of ["hypertrophy", "strength", "fat-loss", "recomposition"]) for (const eq of [FULL, ["dumbbell", "bodyweight"]]) {
      const g = generatePlan({ user_id: `tf-${st}-${days}-${len}-${goal}-${eq.length}`, training_status: st, primary_goal: goal, days_per_week: days, session_length_min: len, available_equipment: eq }, kb);
      for (const s of g.program.sessions) {
        sessions++;
        if (s.exercises.reduce((a, e) => a + e.sets, 0) > CAP[st]) overCap++;
        // W305b (review #24): "over" is past the minute's grace — the model is medians, so 45.3 min is "about 45".
        if (dayMinutes(s.exercises, exById) > len + FIT_GRACE_MIN) { overTime++; if (!g.meta.time_trim?.unfit?.includes(s.name)) unflagged++; }
      }
    }
  ok(`#time-fit no generated day passes its quality cap — the rescue counts against it (${overCap} of ${sessions} did)`, overCap === 0);
  ok(`#time-fit a day still over its minutes is FLAGGED in meta.time_trim.unfit, never silent (${overTime} over, ${unflagged} unflagged, of ${sessions})`, unflagged === 0);
  const owner = generatePlan({ user_id: "owner-adv-4", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: FULL }, kb);
  const ownerDays = owner.program.sessions.map((s) => [s.name, s.exercises.reduce((a, e) => a + e.sets, 0), dayMinutes(s.exercises, exById)]);
  ok(`#time-fit the owner's case (advanced, 4 days, 60 min): every day ≤ 20 sets and within the minute's grace of 60 at the measured pace — ${JSON.stringify(ownerDays)}`,
    ownerDays.every(([, n, m]) => n <= 20 && m <= 60 + FIT_GRACE_MIN));
  ok("#time-fit what the clock cut is recorded, per muscle, so the plan can offer it back",
    typeof owner.meta.time_trim?.removed_sets === "number" && typeof owner.meta.time_trim?.by_muscle === "object" && Array.isArray(owner.meta.time_trim?.unfit));
  // W305b: the 4d/40 chest fixture now fits by pairing and the minute's grace (nothing cut), so a day that still sheds sets
  // carries the check — and #fit-guards sweeps every priority, primary and secondary.
  const pri30 = generatePlan({ user_id: "p-beginner-3-30-hypertrophy-full-side-delts", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 30, available_equipment: FULL, priority_muscles: ["side-delts"] }, kb);
  ok(`#time-fit the clock never takes a PRIORITY muscle's sets (beginner 3d/30, side-delt priority: trimmed ${JSON.stringify(pri30.meta.time_trim.by_muscle)})`,
    pri30.meta.time_trim.removed_sets > 0 && !pri30.meta.time_trim.by_muscle["side-delts"]);
  ok("#time-fit volumeLevers offers 'longer sessions' exactly when the clock, not the quality cap, bound the day",
    /longer sessions/.test(volumeLevers({ days: 4, sessionMin: 60, experience: "advanced", timeBound: true }))
    && !/longer sessions/.test(volumeLevers({ days: 4, sessionMin: 60, experience: "advanced", timeBound: false })));
}

// --- W305b (Burst 8 review #0 #43 #44 #24): the clock's trim keeps EVERY guard on EVERY tier — never a muscle's last
// direct lift, never the week's knee-flexion staple, never a priority muscle's sets (direct or secondary), and every
// muscle a cut lift credits (secondary at half, as the tracker counts it) stays at or above MEV. It PAIRS two
// non-competing isolations before it cuts anything (the 4c partner rule; KB rest-periods "superset smartly" — time saved,
// volume kept), and a day is "over" only past a minute's grace (the model is medians; 45.3 min is "about 45").
{
  const exById = new Map(exercises.map((e) => [e.id, e]));
  const FULL = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  const prim = (id) => exById.get(id)?.primary_muscles ?? [];
  const credits = (id) => [...prim(id).map((m) => [m, 1]), ...(exById.get(id)?.secondary_muscles ?? []).map((m) => [m, 0.5])];
  const isKf = (id) => exById.get(id)?.movement_pattern === "isolation-knee-flexion";
  const exIx = new Map(exercises.map((e) => [e.id, { name: e.name, primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] }]));
  const weekOf = (program) => {
    const w = perMuscleWeeklyVolume([{ date: "2026-01-05", sets: program.sessions.flatMap((s) => s.exercises.flatMap((e) => Array.from({ length: e.sets }, () => ({ exercise: e.exercise, set_type: "work" })))) }], exIx);
    return w[Object.keys(w)[0]] ?? {};
  };
  const growth = (r) => r && r.target_sets > 0 && !r.maintenance && !r.eased && !r.secondary_served;
  let plans = 0, withTake = 0;
  const bad = { mev: [], pri: [], last: [], kf: [], grace: [], pairs: [], unrecorded: [], said: [] };
  for (const st of ["beginner", "intermediate", "advanced"]) for (const days of [2, 3, 4, 5, 6]) for (const len of [30, 35, 45, 60, 75, 90])
    for (const goal of ["hypertrophy", "fat-loss"]) for (const eq of [FULL, ["dumbbell", "bodyweight"], ["bodyweight"]]) for (const pri of [[], ["hamstrings"], ["chest"]]) {
      const id = `g5-${st}-${days}-${len}-${goal}-${eq.length}-${pri.join("+")}`;
      const g = generatePlan({ user_id: id, training_status: st, primary_goal: goal, days_per_week: days, session_length_min: len, available_equipment: eq, priority_muscles: pri }, kb);
      plans++;
      const tt = g.meta.time_trim, week = weekOf(g.program), vbm = g.rationale.volume_by_muscle;
      if (!Array.isArray(tt.taken)) { bad.unrecorded.push(id); continue; }
      if (tt.taken.length) withTake++;
      if (tt.taken.reduce((a, t) => a + t.sets, 0) !== tt.removed_sets) bad.unrecorded.push(id);
      for (const t of tt.taken) {
        for (const [m] of credits(t.exercise)) {
          if (pri.includes(m)) bad.pri.push(`${id} ${t.exercise}→${m}`);
          if (growth(vbm[m]) && (week[m] ?? 0) < (muscleById.get(m)?.landmarks?.mev?.min ?? 0)) bad.mev.push(`${id} ${t.exercise}→${m} ${week[m] ?? 0}`);
        }
        if (t.dropped) {
          for (const m of prim(t.exercise)) if (!g.program.sessions.some((s) => s.exercises.some((e) => prim(e.exercise).includes(m)))) bad.last.push(`${id} ${t.exercise}→${m}`);
          if (isKf(t.exercise) && !g.program.sessions.some((s) => s.exercises.some((e) => isKf(e.exercise)))) bad.kf.push(`${id} ${t.exercise}`);
        }
      }
      for (const c of g.rationale.exercise_choices) for (const w of c.why ?? []) {
        const z = /^paired with (.+)$/.exec(w)?.[1];
        if (!z) continue;
        const sx = g.program.sessions.find((x) => x.name === c.session);
        if (sx?.exercises.find((e) => e.exercise === c.exercise)?.superset_with !== z || sx?.exercises.find((e) => e.exercise === z)?.superset_with !== c.exercise) bad.said.push(`${id} ${c.session}: ${c.exercise} ~ ${z}`);
      }
      for (const s of g.program.sessions) {
        const over = dayMinutes(s.exercises, exById) > Math.min(120, Math.max(30, len)) + 1;
        if (over !== tt.unfit.includes(s.name)) bad.grace.push(`${id} ${s.name} ${dayMinutes(s.exercises, exById)}`);
        if (s.exercises.filter((e) => e.superset_with).length > 2) bad.pairs.push(`${id} ${s.name}`);
      }
    }
  const show = (xs) => `${xs.length}${xs.length ? ` e.g. ${xs.slice(0, 2).join(" | ")}` : ""}`;
  ok(`#fit-guards every trim is recorded lift by lift (time_trim.taken sums to removed_sets) — ${plans} plans, ${withTake} trimmed; unrecorded ${show(bad.unrecorded)}`, bad.unrecorded.length === 0 && withTake > 0);
  ok(`#fit-guards the clock never leaves a muscle a cut lift credits (secondary at half) under MEV (#0 #43): ${show(bad.mev)}`, bad.mev.length === 0);
  ok(`#fit-guards the clock never takes a set that credits a PRIORITY muscle, directly or as a secondary (#43): ${show(bad.pri)}`, bad.pri.length === 0);
  ok(`#fit-guards never a muscle's last direct lift of the week, on any tier — the rescue included (#0): ${show(bad.last)}`, bad.last.length === 0);
  ok(`#fit-guards never the week's last knee-flexion lift (#0): ${show(bad.kf)}`, bad.kf.length === 0);
  ok(`#fit-grace a day is flagged over its minutes exactly when it runs more than a minute past them (#24): ${show(bad.grace)}`, bad.grace.length === 0);
  ok(`#fit-pair the pairing step never stacks a second pair on a day (one pair a session — accents, not the meal): ${show(bad.pairs)}`, bad.pairs.length === 0);
  ok(`#fit-pair every "paired with Z" the plan's explanation says is a real, mutual pair after the trim (W305h): ${show(bad.said)}`, bad.said.length === 0);
  const bw2 = generatePlan({ user_id: "g5-bw-2-30", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 2, session_length_min: 30, available_equipment: ["bodyweight"] }, kb);
  ok(`#fit-guards the review's beginner 2d/30 bodyweight case keeps its knee-flexion lift and its hamstring work (${JSON.stringify(bw2.meta.time_trim.by_muscle)})`,
    bw2.program.sessions.some((s) => s.exercises.some((e) => isKf(e.exercise))) && !bw2.meta.time_trim.by_muscle.hamstrings);
  // The review's case was the owner's 4d/60 full gym (Upper B 60.2 min) — inside the grace now; the same profile on
  // dumbbells runs a day past it, so that is where the pairing has to do the work.
  const owner = generatePlan({ user_id: "p-advanced-4-60-hypertrophy-db-", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: ["dumbbell", "bodyweight"] }, kb);
  const pairedDay = owner.program.sessions.find((s) => (owner.meta.time_trim.paired ?? []).includes(s.name));
  const unpaired = pairedDay ? pairedDay.exercises.map(({ superset_with, ...e }) => e) : [];
  ok(`#fit-pair advanced 4d/60: a day over its minutes pairs two non-competing isolations instead of losing a set (#44) — ${JSON.stringify(owner.meta.time_trim)}; unpaired ${dayMinutes(unpaired, exById)} min, paired ${pairedDay ? dayMinutes(pairedDay.exercises, exById) : "-"}`,
    owner.meta.time_trim.removed_sets === 0 && owner.meta.time_trim.unfit.length === 0 && !!pairedDay
    && dayMinutes(unpaired, exById) > 60 + FIT_GRACE_MIN && dayMinutes(pairedDay.exercises, exById) <= 60 + FIT_GRACE_MIN);
  const pairIds = pairedDay?.exercises.filter((e) => e.superset_with).map((e) => e.exercise) ?? [];
  ok(`#fit-pair the pair it makes is two isolations sharing no muscle, primary or secondary (${pairIds.join(" + ")})`,
    pairIds.length === 2 && pairIds.every((x) => exById.get(x)?.mechanic === "isolation")
    && !credits(pairIds[0]).some(([m]) => credits(pairIds[1]).some(([n]) => n === m)));
  const c45 = generatePlan({ user_id: "g5-int-4-45-chest", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 45, available_equipment: FULL, priority_muscles: ["chest"] }, kb);
  ok(`#fit-grace intermediate 4d/45 chest: no day within a minute of 45 is flagged (#24) — ${JSON.stringify(c45.program.sessions.map((s) => dayMinutes(s.exercises, exById)))} unfit ${JSON.stringify(c45.meta.time_trim.unfit)}`,
    c45.program.sessions.every((s) => dayMinutes(s.exercises, exById) > 46 || !c45.meta.time_trim.unfit.includes(s.name)));
}

// --- W305c (Burst 8 review #2 #32 #33 #42): "longer sessions would let the plan give it more" is said of a muscle only
// when it is TRUE for that muscle — the minutes bound the set budget, or the clock cut that muscle's sets — on the plan's
// warnings and the critique's caveats alike (one day running over adds no set to a ceiling-bound muscle). And the
// explanation never calls the minutes "long enough to do the work" on a plan whose days run past them or lost sets to them.
{
  const FULL = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  const CAP = { beginner: 12, intermediate: 16, advanced: 20 };
  const bad = { gen: [], crit: [], explain: [] };
  let genChecked = 0, critChecked = 0, explained = 0;
  for (const st of ["beginner", "intermediate", "advanced"]) for (const days of [2, 3, 4, 6]) for (const len of [30, 45, 60, 90])
    for (const [en, eq] of Object.entries({ full: FULL, bw: ["bodyweight"] })) {
      const id = `lv-${st}-${days}-${len}-${en}`;
      const profile = { user_id: id, training_status: st, primary_goal: "hypertrophy", days_per_week: days, session_length_min: len, available_equipment: eq };
      const g = generatePlan(profile, kb);
      const minuteBound = Math.round(len / 3) < CAP[st];
      const helps = (m) => minuteBound || (g.meta.time_trim.by_muscle[m] ?? 0) > 0;
      for (const w of g.rationale.warnings) if (w.muscle && /longer sessions/.test(w.message)) { genChecked++; if (!helps(w.muscle)) bad.gen.push(`${id} ${w.muscle}: ${w.message.slice(0, 60)}`); }
      const c = critiquePlan(g.program, kb, { experience: st, generated: true, sessionMinutes: len, trimmed: g.meta.time_trim.by_muscle });
      for (const f of c.findings) if (f.muscle && /longer sessions/.test(f.msg)) { critChecked++; if (!helps(f.muscle)) bad.crit.push(`${id} ${f.muscle}`); }
      const line = explainPersonalization(profile, g.rationale, g.program).find((x) => x.input === "session_length_min")?.effect ?? "";
      if (g.meta.time_trim.unfit.length || g.meta.time_trim.removed_sets) {
        explained++;
        if (/long enough to do the work/.test(line)) bad.explain.push(`${id}: ${line}`);
        if (g.meta.time_trim.unfit.length && !/past/.test(line)) bad.explain.push(`${id} (over, unsaid): ${line}`);
        if (g.meta.time_trim.removed_sets && !new RegExp(`${g.meta.time_trim.removed_sets} set`).test(line)) bad.explain.push(`${id} (cut, unsaid): ${line}`);
      }
    }
  const show = (xs) => `${xs.length}${xs.length ? ` e.g. ${xs.slice(0, 2).join(" | ")}` : ""}`;
  ok(`#levers the plan's warnings offer longer sessions only for a muscle they'd help (${genChecked} said) (#2): ${show(bad.gen)}`, bad.gen.length === 0 && genChecked > 0);
  ok(`#levers …and so do the critique's caveats, from the same rule (${critChecked} said) (#32): ${show(bad.crit)}`, bad.crit.length === 0 && critChecked > 0);
  ok(`#levers the explanation says what the minutes cost on ${explained} plans that ran over or lost sets — never "long enough to do the work" (#33 #42): ${show(bad.explain)}`, bad.explain.length === 0 && explained > 0);
}

// --- W304 (considerations iteration, Burst 8 — owner: "If the necessary amount of volume can't fit within the chosen
// workout length preference please suggest to the user 3 options in order of best to worst: increase no. of workouts
// per week, increase workout length or decrease volume"), made HONEST by W305c (Burst 8 review #1 #3 #15 #17 #19 #20
// #21 #29 #31 #50). Measured from the plan the user actually HAS (its stored program — a swap, a legacy plan, a block
// rotation all count), against alternatives built the way the button would build them (block 0). An option is offered
// only when it is no worse on any measure — days over the minutes, muscles short of their starting point (MEV; 60% of
// it for a beginner, the critique's own bar), the summed shortfall — and NAMEABLY better: a day fitted, or more muscles
// lifted than newly left short (those it does leave short are carried, never hidden). A muscle the split trains but the
// week gives zero sets is short, not "no data". Days past the minutes are always said, even when no option helps.
{
  const FULL = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  const exById = new Map(exercises.map((e) => [e.id, e]));
  const exIx = new Map(exercises.map((e) => [e.id, { name: e.name, primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] }]));
  const weekOf = (program) => {
    const w = perMuscleWeeklyVolume([{ date: "2026-01-05", sets: program.sessions.flatMap((s) => s.exercises.flatMap((e) => Array.from({ length: e.sets }, () => ({ exercise: e.exercise, set_type: "work" })))) }], exIx);
    return w[Object.keys(w)[0]] ?? {};
  };
  const cur = (g) => ({ program: g.program, rationale: g.rationale, meta: g.meta });
  const fitFor = (profile, opts = {}) => timeFitOptions(profile, kb, cur(generatePlan(profile, kb, opts)), { ...opts, blockIndex: 0 });
  let cards = 0, offered = 0, keepOnly = 0, withNewly = 0, longerOffered = 0;
  const bad = { worse: [], gain: [], newly: [], zero: [], order: [], silent: [], bar: [], rank: [], keep: [], own: [] };
  for (const st of ["beginner", "intermediate", "advanced"]) for (const days of [2, 3, 4, 5, 6]) for (const len of [30, 45, 60, 90])
    for (const [en, eq] of Object.entries({ full: FULL, db: ["dumbbell", "bodyweight"], bw: ["bodyweight"] })) for (const pri of [[], ["chest"], ["hamstrings", "side-delts"]]) {
      const id = `fo-${st}-${days}-${len}-${en}-${pri.join("+")}`;
      const profile = { user_id: id, training_status: st, primary_goal: "hypertrophy", days_per_week: days, session_length_min: len, available_equipment: eq, priority_muscles: pri };
      const g = generatePlan(profile, kb), f = timeFitOptions(profile, kb, cur(g), { blockIndex: 0 });
      const overDays = g.program.sessions.filter((s) => dayMinutes(s.exercises, exById) > len + FIT_GRACE_MIN).length;
      if (overDays && !f) bad.silent.push(id);
      if (!f) continue;
      cards++;
      if (f.unfit_days !== overDays) bad.silent.push(`${id} says ${f.unfit_days} over, ${overDays} are`);
      const week = weekOf(g.program);
      for (const [m, r] of Object.entries(g.rationale.volume_by_muscle)) {
        const mev = muscleById.get(m)?.landmarks?.mev?.min;
        if (!(r?.target_sets > 0) || !(r.frequency > 0) || r.maintenance || r.eased || r.secondary_served || !mev) continue;
        const shortNow = (week[m] ?? 0) < mev * (st === "beginner" ? 0.6 : 1);
        if (shortNow !== f.mev_short.includes(m)) ((week[m] ?? 0) === 0 ? bad.zero : bad.bar).push(`${id} ${m} ${week[m] ?? 0}/${mev} listed=${f.mev_short.includes(m)}`);
      }
      const lastPri = f.mev_short.reduce((a, m, i) => (pri.includes(m) ? i : a), -1), firstOther = f.mev_short.findIndex((m) => !pri.includes(m));
      if (firstOther >= 0 && lastPri > firstOther) bad.order.push(`${id} ${f.mev_short.join(",")}`);
      const kinds = f.options.map((o) => o.kind);
      if (kinds.join(">") !== ["add_day", "longer", "keep"].filter((k) => kinds.includes(k)).join(">") || kinds.at(-1) !== "keep") bad.rank.push(`${id} ${kinds}`);
      if (kinds.length === 1) keepOnly++;
      for (const o of f.options) {
        if (o.kind === "keep") {
          const forgoes = f.mev_short.filter((m) => f.options.some((x) => x.lifted?.includes(m)));
          if (JSON.stringify(o.forgoes) !== JSON.stringify(forgoes)) bad.keep.push(`${id} keep forgoes ${o.forgoes} want ${forgoes}`);
          continue;
        }
        offered++; if (o.kind === "longer") longerOffered++;
        if (o.over.some((d) => !(d.minutes > o.minutes + FIT_GRACE_MIN)) || o.unfit_days !== o.over.length) bad.own.push(`${id} ${o.kind} ${o.minutes}: ${JSON.stringify(o.over)}`);
        if (o.unfit_days > f.unfit_days || o.mev_short.length > f.mev_short.length || o.mev_deficit > f.mev_deficit) bad.worse.push(`${id} ${o.kind}: unfit ${f.unfit_days}->${o.unfit_days} short ${f.mev_short.length}->${o.mev_short.length} def ${f.mev_deficit}->${o.mev_deficit}`);
        if (!(o.unfit_days < f.unfit_days || o.lifted.length > o.newly.length)) bad.gain.push(`${id} ${o.kind}`);
        const newly = o.mev_short.filter((m) => !f.mev_short.includes(m)), lifted = f.mev_short.filter((m) => !o.mev_short.includes(m));
        if (JSON.stringify(o.newly) !== JSON.stringify(newly) || JSON.stringify(o.lifted) !== JSON.stringify(lifted)) bad.newly.push(`${id} ${o.kind}`);
        if (newly.length) withNewly++;
      }
    }
  const show = (xs) => `${xs.length}${xs.length ? ` e.g. ${xs.slice(0, 2).join(" | ")}` : ""}`;
  ok(`#fit-options ${cards} cards, ${offered} options (${longerOffered} longer, ${withNewly} carrying a newly-short muscle), ${keepOnly} keep-only`, cards > 50 && offered > 30 && longerOffered > 0);
  ok(`#fit-options an offered option is never WORSE on days over, muscles short or the summed shortfall (review #1 #3 #15): ${show(bad.worse)}`, bad.worse.length === 0);
  ok(`#fit-options …and nameably better: a day fitted, or more muscles lifted than left short: ${show(bad.gain)}`, bad.gain.length === 0);
  ok(`#fit-options each option's days are judged against ITS OWN minutes (a 60-min option's 55-min day isn't "over"): ${show(bad.own)}`, bad.own.length === 0);
  ok(`#fit-options what an option lifts AND what it newly leaves short are both carried, exactly (#15 #17): ${show(bad.newly)}`, bad.newly.length === 0);
  ok(`#fit-options a muscle the split trains but the week gives ZERO sets is short, never "no data" (#20): ${show(bad.zero)}`, bad.zero.length === 0);
  ok(`#fit-options short means under MEV — under 60% of it for a beginner, the critique's own bar (#19): ${show(bad.bar)}`, bad.bar.length === 0);
  ok(`#fit-options the user's priority muscles lead the short list (#50): ${show(bad.order)}`, bad.order.length === 0);
  ok(`#fit-options a day past its minutes is ALWAYS said — keep-only when no option helps (#21): ${show(bad.silent)}`, bad.silent.length === 0);
  ok(`#fit-options ranked as the owner ranked them, keep last: ${show(bad.rank)}`, bad.rank.length === 0);
  ok(`#fit-options keep names exactly what it forgoes — what some option would lift, nothing every option leaves short (#17): ${show(bad.keep)}`, bad.keep.length === 0);
  const flag = { user_id: "ss-1", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: FULL };
  const f1 = fitFor(flag);
  ok(`#fit-options the flagship 4d/60 (ceiling-bound): no 'longer' — a longer session can't add a set to a full day: ${JSON.stringify(f1?.options?.map((o) => o.kind))}`,
    !f1 || !f1.options.some((o) => o.kind === "longer"));
  const m45 = { user_id: "fo-int-4-45-open", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 45, available_equipment: FULL };
  const f45 = fitFor(m45), l45 = f45?.options?.find((o) => o.kind === "longer");
  ok(`#fit-options a minute-bound plan that trims nothing still gets 'longer' when it lifts muscles (#31): ${JSON.stringify(l45 ? { lifted: l45.lifted, newly: l45.newly } : f45?.options?.map((o) => o.kind))}`,
    !!l45 && l45.minutes === 60 && l45.lifted.length > 0);
  ok("#fit-options a 6-day plan is never offered a 7th day, a 120-minute plan never 'longer'",
    !(fitFor({ ...flag, user_id: "ss-6", days_per_week: 6 })?.options ?? []).some((o) => o.kind === "add_day")
    && !(fitFor({ ...m45, user_id: "fo-120", session_length_min: 120 })?.options ?? []).some((o) => o.kind === "longer"));
  const easy = { user_id: "fit-none", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 90, available_equipment: FULL };
  ok("#fit-options nothing short, nothing over → no card at all (null)", fitFor(easy) === null);
  ok("#fit-options deterministic: the same plan gives the same offer", JSON.stringify(fitFor(m45)) === JSON.stringify(f45));
  // The plan the user HAS, not the one the engine would build today (review #13 #26): a stored program whose day runs
  // long (a pre-W303 plan, a swap) is measured as it is.
  const g45 = generatePlan(m45, kb), stuffed = JSON.parse(JSON.stringify(g45));
  stuffed.program.sessions[0].exercises.forEach((e) => { e.sets += 2; });
  const fs = timeFitOptions(m45, kb, cur(stuffed), { blockIndex: 0 });
  ok(`#fit-options measured from the STORED program: a day made long after generation is said (${JSON.stringify(fs?.over)})`,
    !!fs && fs.unfit_days >= 1 && fs.over[0].session === stuffed.program.sessions[0].name && fs.over[0].minutes > 46);
  ok("#fit-options the payload says whether a block restart is a real cost (a beginner has no blocks — #27)",
    fitFor({ ...m45, user_id: "fo-beg", training_status: "beginner", session_length_min: 30 })?.blocks === false && f45?.blocks === true);
}

// --- W305h (Burst 8 fix verification — lesson 99): the fixes' own interactions.
// (C1/C13) 5a re-tries its pairing whenever a shed leaves the day pair-free (the rescue pair gone) — never "runs past"
// while one pairing would fit it. (C12) an option must beat a rebuild at the SAME schedule built the same way (block 0,
// today's stalls): a gain the rebuild alone brings (a stall swap) is no reason to add a day or minutes. (C2) a plan built
// before the fit-to-time pass is said to be one, and offered a refit at the same days and block — never told "what's left
// is what your muscles need". (K0) the explanation reads the same live measure as Today's card.
{
  const FULL = ["barbell", "dumbbell", "machine", "cable", "bodyweight"];
  const exById = new Map(exercises.map((e) => [e.id, e]));
  const credits = (id) => [...(exById.get(id)?.primary_muscles ?? []), ...(exById.get(id)?.secondary_muscles ?? [])];
  const cur = (g) => ({ program: g.program, rationale: g.rationale, meta: g.meta });
  let pairable = [];
  for (const st of ["beginner", "intermediate", "advanced"]) for (const days of [2, 3, 4, 5, 6]) for (const len of [30, 45, 60])
    for (const [en, eq] of Object.entries({ full: FULL, db: ["dumbbell", "bodyweight"] })) for (const goal of ["hypertrophy", "fat-loss"]) {
      const g = generatePlan({ training_status: st, primary_goal: goal, days_per_week: days, session_length_min: len, available_equipment: eq, user_id: `pr-${st}-${days}-${len}-${en}-${goal}` }, kb);
      for (const s of g.program.sessions) {
        if (!g.meta.time_trim.unfit.includes(s.name) || s.exercises.some((e) => e.superset_with)) continue;
        const isos = s.exercises.filter((e) => exById.get(e.exercise)?.mechanic === "isolation");
        for (let i = 0; i < isos.length; i++) for (let j = i + 1; j < isos.length; j++) {
          if (credits(isos[i].exercise).some((m) => credits(isos[j].exercise).includes(m))) continue;
          const tried = s.exercises.map((e) => e === isos[i] ? { ...e, superset_with: isos[j].exercise } : e === isos[j] ? { ...e, superset_with: isos[i].exercise } : e);
          if (dayMinutes(tried, exById) <= len + FIT_GRACE_MIN) pairable.push(`${st}-${days}-${len}-${en}-${goal} ${s.name} ${dayMinutes(s.exercises, exById)}→${dayMinutes(tried, exById)}`);
        }
      }
    }
  ok(`#fit-pair a day flagged over its minutes never has one 5a pairing left that would fit it (C1/C13): ${pairable.length}${pairable.length ? " e.g. " + pairable.slice(0, 2).join(" | ") : ""}`, pairable.length === 0);
  // C12: intermediate 6×60, leg press stalled — the stall swap (not 15 more minutes) brings abs up.
  const six = { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 60, available_equipment: FULL };
  const gs = generatePlan(six, kb);
  const fs = timeFitOptions(six, kb, cur(gs), { blockIndex: 0, stalledExercises: ["leg-press"] });
  ok(`#fit-options an option must beat a rebuild at the SAME schedule: a stall swap's gain is never credited to longer workouts (C12) — ${JSON.stringify(fs?.options?.map((o) => [o.kind, o.lifted]))}`,
    !(fs?.options ?? []).some((o) => o.kind === "longer" && o.lifted.includes("abs")));
  // C2: a legacy plan (no meta.time_trim) whose day runs over: said as legacy, offered a refit at the same block.
  const m45 = { user_id: "fo-int-4-45-open", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 45, available_equipment: ["dumbbell", "bodyweight"] };
  const g45 = generatePlan(m45, kb), legacy = JSON.parse(JSON.stringify(cur(g45)));
  delete legacy.meta.time_trim;
  legacy.program.sessions.forEach((s) => s.exercises.forEach((e) => { e.superset_with = undefined; delete e.superset_with; if (exById.get(e.exercise)?.mechanic === "isolation") e.sets += 1; }));
  const fl = timeFitOptions(m45, kb, legacy, { blockIndex: 0 }, { refitOpts: { blockIndex: 2 } });
  const refit = fl?.options?.find((o) => o.kind === "refit");
  ok(`#fit-options a plan built before the fit-to-time pass is said to be one (fitted:false) and offered a refit at the same days (C2) — ${JSON.stringify(fl && { fitted: fl.fitted, unfit: fl.unfit_days, kinds: fl.options.map((o) => o.kind), refit: refit && [refit.days, refit.minutes, refit.unfit_days] })}`,
    fl?.fitted === false && fl.unfit_days > 0 && !!refit && refit.days === 4 && refit.minutes === 45 && refit.unfit_days < fl.unfit_days
    && fl.options.map((o) => o.kind).indexOf("refit") === fl.options.length - 2);
  // …never for a plan that went through the pass, even where another block's rebuild would fit a day (a rotation is
  // the block boundary's business, not a card's): beginner 6×30 dumbbells, 1 day over at block 0, 0 at block 1.
  const rb = { user_id: "rf-beginner-6-30-db", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 6, session_length_min: 30, available_equipment: ["dumbbell", "bodyweight"] };
  const grb = generatePlan(rb, kb, { blockIndex: 0 });
  const frb = timeFitOptions(rb, kb, cur(grb), { blockIndex: 0 }, { refitOpts: { blockIndex: 1 } });
  ok(`#fit-options …a plan that went through the pass is never offered a refit, and says so (fitted:true) — ${JSON.stringify(frb && { fitted: frb.fitted, unfit: frb.unfit_days, kinds: frb.options.map((o) => o.kind), block1Unfit: generatePlan(rb, kb, { blockIndex: 1 }).meta.time_trim.unfit.length })}`,
    grb.meta.time_trim.unfit.length > 0 && generatePlan(rb, kb, { blockIndex: 1 }).meta.time_trim.unfit.length < grb.meta.time_trim.unfit.length
    && frb?.fitted === true && !frb.options.some((o) => o.kind === "refit"));
  // K0: the explanation reads the live measure the card reads — a legacy plan's over-long day is said there too.
  const line = explainPersonalization(m45, legacy.rationale, legacy.program, { over: fl?.over?.map((d) => d.session) ?? [], trimmed_sets: 0 })
    .find((x) => x.input === "session_length_min")?.effect ?? "";
  ok(`#levers the explanation reads the card's live measure: a legacy plan's day past its minutes is said, never "long enough" (K0) — ${line}`,
    /past them/.test(line) && !/long enough to do the work/.test(line));
}

// --- W315b (Burst 10 — owner note 7): a lifter's own session ceiling (opts.sessionCap — learned from their fade signals,
// accepted on Today) caps every day's sets under the KB's, the superset rescue included; at or over the KB's it changes
// nothing, and absent the plan is byte-identical (the golden digest above).
{
  const dayMax = (plan) => Math.max(...plan.program.sessions.map((s) => s.exercises.reduce((a, e) => a + (e.sets ?? 0), 0)));
  for (const [status, days, min] of [["advanced", 4, 90], ["intermediate", 3, 75], ["advanced", 6, 120]]) {
    const pr = { ...profile, training_status: status, days_per_week: days, session_length_min: min };
    const free = generatePlan(pr, kb), capped = generatePlan(pr, kb, { sessionCap: 13 });
    ok(`#cap (W315b) ${status} ${days}d/${min} min: no day past the lifter's own 13 (uncapped: ${dayMax(free)}, capped: ${dayMax(capped)})`, dayMax(capped) <= 13 && dayMax(free) > 13);
  }
  ok("#cap (W315b) a cap at or over the KB's changes nothing", JSON.stringify(generatePlan(profile, kb, { sessionCap: 30 }).program) === JSON.stringify(generatePlan(profile, kb).program));
  ok("#cap (W315b) the levers judge 'longer sessions' against the lifter's own ceiling (45 min holds 15 sets — past a cap of 13)",
    volumeLevers({ days: 4, sessionMin: 45, experience: "advanced", sessionCap: 13 }) === volumeLevers({ days: 4, sessionMin: 45, experience: "advanced", timeBound: false }));
}
console.log(`\n${pass} plan test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
