// Unit tests for the generative plan engine (tools/plan-core.mjs), run against
// the REAL knowledge base so the invariants hold on shipping data.
import { readdirSync, readFileSync } from "node:fs";
import { generatePlan, chooseSplit, targetWeeklySets, critiquePlan } from "./plan-core.mjs";

const load = (d) => readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`${d}/${f}`)));
const exercises = load("data/exercises");
const muscles = load("data/muscles");
const contraindications = JSON.parse(readFileSync("data/injury-contraindications.json"));
const registry = new Set(JSON.parse(readFileSync("citations/registry.json")).citations.map((c) => c.key));
const exIds = new Set(exercises.map((e) => e.id));
const kb = { exercises, muscles, contraindications };
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

console.log(`\n${pass} plan test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
