// Unit tests for the generative plan engine (tools/plan-core.mjs), run against
// the REAL knowledge base so the invariants hold on shipping data.
import { readdirSync, readFileSync } from "node:fs";
import { generatePlan, chooseSplit, targetWeeklySets, critiquePlan, deriveSpecialization, specializationActive, SPEC_MAX_BLOCKS, explainPersonalization } from "./plan-core.mjs";
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
  ok("#15a the priority muscles themselves stay fully served",
    ["biceps", "triceps"].every((m) => armPri.rationale.volume_by_muscle[m].projected_sets >= armPri.rationale.volume_by_muscle[m].target_sets - 1));
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
ok("no directly-trained muscle gets zero weekly sets (intermediate + advanced defaults)",
  [{ user_id: "fs-i", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60 },
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
  ok("specialization emits no growth-warning noise for maintenance muscles",
    !sp.rationale.warnings.some((w) => (w.code === "below-mev" || w.code === "below-mev-indirect" || w.code === "under-target") && sp.rationale.volume_by_muscle[w.muscle]?.maintenance));
  ok("specialization never programs over MRV", !sp.rationale.warnings.some((w) => w.code === "over-mrv"));
}

// --- elite features: specialization, supersets, block rotation ---
const specP = generatePlan({ user_id: "sp", training_status: "advanced", primary_goal: "hypertrophy", days_per_week: 5, session_length_min: 75, priority_muscles: ["side-delts", "chest"], specialization: true }, kb);
ok("specialization: priority targets push to the MRV ceiling", specP.rationale.volume_by_muscle["side-delts"].target_sets === muscleById.get("side-delts").landmarks.mrv.max);
ok("specialization: non-priority muscles run at labelled maintenance with no below-MEV noise",
  specP.rationale.volume_by_muscle["quadriceps"].projected_status === "maintenance" &&
  specP.rationale.warnings.filter((w) => w.code === "below-mev").length === 0);
ok("specialization: still never over MRV", specP.rationale.warnings.filter((w) => w.code === "over-mrv").length === 0);
// #1: the block's promise is to HOLD non-priority muscles at maintenance and free
// recovery for the priorities. A muscle UNRELATED to the priorities (quads, when
// the priorities are side-delts+chest) must actually sit near its maintenance dose,
// NOT be quietly grown into MEV/growth range as it was before (target 6 -> proj 10).
const specQuad = specP.rationale.volume_by_muscle["quadriceps"];
ok("#1 a non-synergist maintenance muscle is HELD below its growth threshold (MEV)",
  specQuad.projected_sets < muscleById.get("quadriceps").landmarks.mev.min);
ok("#1 a held maintenance muscle stays within ~1.5 sets of its maintenance target",
  specQuad.projected_sets <= specQuad.target_sets + 1.5);
// A synergist of the priority lifts (e.g. triceps under a chest priority) will pick
// up unavoidable SECONDARY volume and overshoot — that's physiology, not a bug — but
// its rationale must then say so HONESTLY, not keep claiming "holds what you've built".
const overshootSyn = Object.entries(specP.rationale.volume_by_muscle)
  .find(([m, r]) => r.maintenance && r.projected_sets >= (muscleById.get(m)?.landmarks?.mev?.min ?? Infinity))?.[1];
ok("#1 an overshooting synergist gets an honest 'secondary work' reason, not a false maintenance claim",
  !overshootSyn || (/secondary work/.test(overshootSyn.reasons[0]) && !/holds what you've built/.test(overshootSyn.reasons[0])));
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
if (specLower) {
  const idxHigh = specLower.exercises.findIndex((e) => exByIdR.get(e.exercise)?.cns_cost === "high");
  const idxIso = specLower.exercises.findIndex((e) => exByIdR.get(e.exercise)?.mechanic === "isolation");
  ok("#1C high-CNS compounds still lead — promotion doesn't bury a squat behind a raise", idxIso === -1 || idxHigh < idxIso);
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
  const heldDuring = Object.values(during.rationale.volume_by_muscle).filter((v) => v.maintenance).length;
  const heldAfter = Object.values(after.rationale.volume_by_muscle).filter((v) => v.maintenance).length;
  ok("a finished specialization block takes every other muscle OFF maintenance",
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
  // but no session archetype trains it (projected 0, status "not-reached").
  {
    const vol = rationale.volume_by_muscle;
    const flagged = Object.values(vol).filter((v) => v.maintenance).length;
    const dosed = Object.values(vol).filter((v) => v.maintenance && (v.projected_sets ?? 0) > 0).length;
    const claimed = Number((pri.effect.match(/and (\d+) other muscles?/) ?? [])[1]);
    ok("...and counts only the muscles it actually doses, never one projected at zero sets",
      Number.isFinite(claimed) && claimed === dosed && (vol.neck?.maintenance ? dosed < flagged : true));
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
const budgetPlan = generatePlan({ user_id: "budget-1", training_status: "beginner", primary_goal: "hypertrophy",
  days_per_week: 3, session_length_min: 60,
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

console.log(`\n${pass} plan test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
