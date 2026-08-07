// The generative training-plan engine — pure, deterministic, fs-free (runs in
// the Cloudflare Worker bundle and in Node). Turns a profile + the knowledge
// base (volume landmarks + exercise database) into a concrete weekly program
// PLUS a machine-readable rationale that explains every decision from the KB.
//
// Currency is EFFECTIVE weekly hard sets (primary muscle = 1.0/set, secondary =
// 0.5/set) — the exact same model as derive-core's perMuscleWeeklyVolume, which
// we reuse for a closed-loop self-check so plan-time and log-time volume agree.
import { perMuscleWeeklyVolume, volumeVsLandmarks, supportedCompound, repScheme } from "./derive-core.mjs";

// --- session archetypes: which muscles a session may train ---
const ARCH = {
  FULL: ["quadriceps", "hamstrings", "glutes", "chest", "upper-back", "lats", "side-delts", "biceps", "triceps", "abs", "calves"],
  UPPER: ["chest", "upper-back", "lats", "side-delts", "front-delts", "rear-delts", "triceps", "biceps", "forearms"],
  LOWER: ["quadriceps", "hamstrings", "glutes", "calves", "abs", "spinal-erectors"],
  PUSH: ["chest", "front-delts", "side-delts", "triceps"],
  PULL: ["upper-back", "lats", "rear-delts", "biceps", "forearms"],
  LEGS: ["quadriceps", "hamstrings", "glutes", "calves", "abs", "spinal-erectors"],
};

// Every muscle any archetype can program. A muscle NOT in this set (only `neck`,
// which is niche opt-in work and appears in no split) can never receive volume from
// the generative plan, so a "below MEV — add a direct exercise" nag for it is noise
// on 100% of plans — suppressed unless the user explicitly prioritises it.
const PROGRAMMABLE_MUSCLES = new Set(Object.values(ARCH).flat());

// split by days_per_week × training_status → ordered list of archetypes
const SPLIT_TABLE = {
  "2": { "*": ["FULL", "FULL"] },
  "3": { beginner: ["FULL", "FULL", "FULL"], intermediate: ["FULL", "FULL", "FULL"], advanced: ["UPPER", "LOWER", "FULL"] },
  "4": { "*": ["UPPER", "LOWER", "UPPER", "LOWER"] },
  "5": { "*": ["PUSH", "PULL", "LEGS", "UPPER", "LOWER"] },
  "6": { "*": ["PUSH", "PULL", "LEGS", "PUSH", "PULL", "LEGS"] },
};

const SPLIT_NAME = (names) => {
  const u = new Set(names);
  if ([...u].every((n) => n === "FULL")) return "full-body";
  if ([...u].every((n) => n === "UPPER" || n === "LOWER")) return "upper-lower";
  if ([...u].every((n) => n === "PUSH" || n === "PULL" || n === "LEGS")) return "push-pull-legs";
  return "other";
};

// place bigger / compound-driven muscles first within a session
const PLACE_ORDER = ["quadriceps", "chest", "upper-back", "lats", "hamstrings", "glutes", "front-delts", "side-delts", "triceps", "biceps", "rear-delts", "spinal-erectors", "calves", "abs", "forearms", "neck"];

// RIR/rep bands per goal now live in derive-core (`REP_SCHEMES`/`repScheme`,
// imported above) so the PRESCRIPTION here and the effort lever that grades logged
// rir against it read one table — the same single-source-of-truth move Wave 171
// made for `supportedCompound`. Keeping a second copy here is what let the effort
// lever score strength-goal accessories against the hypertrophy band.

// THE MIDDLE EFFORT TIER (considerations #1, finding 1B). The KB's effort table has
// THREE rows — heavy compounds 1-3 RIR · "moderate compounds and most machine
// presses/rows" 0-2 · isolation 0-1 — and the engine implemented two, keying only
// off `mechanic`. So a leg press, a hack squat, a machine chest press and a
// chest-supported row all got the heavy-barbell reserve of 1-3.
//
// That was self-contradictory as well as unfaithful: the ranker gives machines the
// LARGEST equipment bonus (EQUIP_TIER_HYPERTROPHY machine −1.4) precisely because
// they're stable enough to push near failure safely — then the prescription told
// the user not to. The engine preferentially selected those lifts and then left
// their stimulus on the table.
//
// `stability: "high"` is the data that already encodes the KB's row: it resolves to
// exactly the leg presses, hack squats, machine/smith presses, lat pulldowns and
// chest-supported rows the page names. The `cns_cost` half expresses the page's
// SECOND stated reason for the heavy reserve (fatiguing and slow to recover, as
// distinct from technically risky) — it binds nothing in today's data, where every
// high-stability compound is low or moderate CNS, but a stable yet systemically
// heavy machine (a belt squat, say) must not be pushed to 0-2 just for being stable.
// The classifier itself (`supportedCompound`) lives in derive-core (Wave 171), the
// single source of truth shared with the effort lever — prescription and diagnosis
// can never disagree about an exercise's target band.
const supported = supportedCompound;
// One notch closer to failure than the goal's own heavy-compound band, floored at 0
// — derived rather than four more literal tuples, so it can never drift from them.
const easeToward = (band) => {
  const m = /^(\d+)-(\d+)$/.exec(band ?? "");
  if (!m) return band;
  return `${Math.max(0, +m[1] - 1)}-${Math.max(0, +m[2] - 1)}`;
};

// Daily Undulating Periodization (roadmap #9, first slice): an OPT-IN advanced
// option (profile.periodization === "undulating") that varies the rep/intensity
// band by TRAINING DAY across the week — the classic heavy/moderate/light rotation
// — instead of the same band every session. A muscle trained 2-3×/week then gets a
// genuinely different stimulus each exposure (heavier mechanical-tension work one
// day, higher-rep metabolic work another), the recognised intermediate+ method the
// single linear scheme couldn't express. Only applied to the hypertrophy family
// (whose base band is moderate); left off for strength/fat-loss, whose bands are
// already goal-specific. Default ("linear"/unset) returns the base scheme unchanged,
// so a plan generated without opting in is byte-identical to before.
// Only the COMPOUND (mechanical-tension) work undulates — heavy on one day, higher-rep
// on another. ISOLATIONS deliberately stay in their evidence-based higher-rep, near-failure
// band EVERY day (the KB's stance: heavy low-rep isolation like a 5-rep lateral raise is
// poor practice), so undulation never drags a curl or a fly into a 6-rep band.
const UNDULATION_COMPOUND = { heavy: ["4-6", "2-3"], light: ["10-15", "1-2"] }; // moderate = the goal's base compound
const UNDULATION_ORDER = ["heavy", "moderate", "light"];
const undulatesForGoal = (goal) => goal === "hypertrophy" || goal === "recomposition";

// Whether a profile's plan undulates, as a PURE function of the profile — the same
// condition generatePlan applies, in one place so the generator and the explanation
// can't drift. Exported because `explainPersonalization` needs it for rationales stored
// before `goal_prescription.undulating` existed (see its note on bounded reach).
export function undulatesForProfile(profile) {
  const goal = profile?.primary_goal ?? "hypertrophy";
  const experience = profile?.training_status ?? "intermediate";
  return undulatesForGoal(goal) && (
    profile?.periodization === "undulating" ||
    (profile?.periodization !== "linear" && experience === "advanced")
  );
}
// Pick a session's scheme from its OCCURRENCE within its own archetype (Push A's
// 1st exposure, Push B's 2nd, ...) — not the session's absolute index in the week.
// Keying off the absolute index made every repeat of an archetype whose interval
// divides evenly into 3 (e.g. every PPL split, at 2 or 6 days/week) land on the
// identical band every time — Push A and Push B both "heavy," never anything else
// — which is exactly the "same band every session" problem DUP exists to fix.
// Keying off the archetype's own repeat count guarantees each exposure of a given
// muscle group cycles through a genuinely different band, independent of how many
// total sessions share its phase. Only the compound band shifts.
function sessionRepScheme(baseScheme, undulating, archetypeOccurrence) {
  if (!undulating) return baseScheme;
  const band = UNDULATION_ORDER[archetypeOccurrence % UNDULATION_ORDER.length];
  return band === "moderate" ? baseScheme : { ...baseScheme, compound: UNDULATION_COMPOUND[band] };
}

// Small muscles whose isolation work runs higher-rep "pump" ranges in practice.
// This is the KB's own guidance (intensity page: hypertrophy is load-flexible
// ~5-30 reps near failure; "isolation and machine work often going a bit higher,
// ~12-20... very light high reps for small muscles and finishing work") — a
// practical time/joint-stress choice, NOT a fiber-type responsiveness claim
// (the KB grades muscle-specific rep-range claims as weak). Matches how every
// current top-level program runs laterals/rear-delts/calves/abs/forearms.
// ("neck" was removed as inert: no session archetype trains it, so the entry
// could never fire — a dead entry reads like live behavior. Test #8-1 covers
// the real neck path: the plan warns a neck-priority user to add direct work.)
const PUMP_MUSCLES = new Set(["side-delts", "rear-delts", "calves", "abs", "forearms"]);

// Muscles whose PRIMARY movement is an isolation (KB muscle guides): the
// shoulders guide names lateral raises the side-delt priority — pressing
// already covers the front delts — and the arms guide's best picks are curl
// and extension variants, with the arm compounds (chin-ups, dips, close-grip
// pressing) entering the plan through the lats/chest slots they actually
// belong to. The engine placing a compound first here was spending the biceps
// budget on a third vertical pull and calling the arms trained.
const ISO_FIRST = new Set(["side-delts", "biceps", "triceps"]);

// Muscles that get DIRECT isolation work even when compound secondary/primary
// credit already "covers" their volume on paper — the KB arms guide: growth
// follows volume (Grade A) and the compounds-only evidence for arms is mixed,
// so these muscles get focused, full-range sets of their own. Chin-ups do not
// replace curls, close-grip pressing does not replace pushdowns, presses do
// not replace laterals. (Current top-level splits corroborate: dedicated arm +
// delt finishing work.)
const DIRECT_ISO = new Set(["biceps", "triceps", "side-delts"]);

// Movement-pattern FAMILY of a pattern — shared by the coverage pass (serve every
// family before doubling one) and the per-session family cap (no 3rd hinge/squat
// variant in one session; redundant fatigue, no new stimulus).
const famOf = (pat) =>
  pat === "squat" || pat === "lunge" ? "knee"
  : pat === "hinge" ? "hip"
  : pat === "horizontal-push" || pat === "vertical-push" ? "push"
  : pat === "horizontal-pull" || pat === "vertical-pull" ? "pull"
  : pat;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n) => Math.round(n);

// deterministic seed from the user id (FNV-1a) — no Math.random in this file
function seedFromProfile(profile) {
  const s = String(profile.user_id ?? profile.id ?? "default");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// weekly effective-set target for a muscle, from its landmarks + the profile
export function targetWeeklySets(landmarks, { experience, isPriority }) {
  const reasons = [];
  if (!landmarks) return { target: 0, reasons: ["no landmarks"] };
  const { mev, mav, mrv } = landmarks;
  let base;
  if (experience === "beginner") { base = mev.min; reasons.push(`beginner → start near MEV (${mev.min})`); }
  else if (experience === "advanced") { base = mav.max; reasons.push(`advanced → top of MAV (${mav.max})`); }
  else { base = mav.min; reasons.push(`intermediate → bottom of MAV (${mav.min})`); }
  // (Intermediate was mid-MAV, but summed mid-MAV targets across all muscles are
  // undeliverable inside a typical 3-4 day week under the session quality cap —
  // guaranteeing under-target warnings on every default plan. Bottom-of-MAV is
  // still above MEV and grows; users wanting more add days or priority muscles.)
  let target = base;
  if (isPriority) { target = round(target * 1.3); reasons.push(`priority muscle → ×1.3 (${target})`); }
  const clamped = clamp(target, mev.min, mrv.max);
  if (clamped !== target) reasons.push(`clamped to ${clamped <= mev.min ? `MEV.min ${mev.min}` : `MRV.max ${mrv.max}`}`);
  return { target: clamped, reasons, landmark: { mev, mav, mrv, evidence_grade: landmarks.evidence_grade, citations: landmarks.citations ?? [] } };
}

export function chooseSplit({ days_per_week, training_status }) {
  const days = clamp(days_per_week ?? 3, 2, 6);
  const byExp = SPLIT_TABLE[String(days)] ?? SPLIT_TABLE["3"];
  const names = byExp[training_status] ?? byExp["*"] ?? SPLIT_TABLE["3"].intermediate;
  const split = SPLIT_NAME(names);
  const counts = {};
  const sessions = names.map((n) => { counts[n] = (counts[n] ?? 0) + 1; return { arch: n, letter: counts[n] }; });
  const multi = Object.fromEntries(Object.entries(counts).map(([n, c]) => [n, c]));
  const label = { FULL: "Full Body", UPPER: "Upper", LOWER: "Lower", PUSH: "Push", PULL: "Pull", LEGS: "Legs" };
  sessions.forEach((s) => { s.name = label[s.arch] + (multi[s.arch] > 1 ? " " + "ABCDEF"[s.letter - 1] : ""); s.of = multi[s.arch]; });
  return {
    split, sessions,
    reason: `${days} days × ${training_status ?? "intermediate"} → ${/^[aeiou]/i.test(split) ? "an" : "a"} ${split} split, hitting each muscle ~${split === "full-body" ? days : 2}×/week within the 6–10 hard-sets-per-session quality window.`,
    citations: ["schoenfeld-2019-frequency-meta", "grgic-2018-frequency-strength"],
  };
}

// rank a pool of exercises for a muscle: lengthened-bias + difficulty-fit first,
// deterministic tie-break by seed. Returns a new sorted array (best first).
// Bodyweight moves you can load with a belt/plate (pull-ups, dips, muscle-ups) are
// top-tier and progress fine — never penalized. Other bodyweight moves (lunges,
// inverted rows, single-leg RDLs) cap out once you can do them for reps.
const LOADABLE_BODYWEIGHT = /pull-up|chin-up|dip|muscle-up/;
// Equipment-quality preference (goal-aware). For HYPERTROPHY, machines and cables
// give stable, guided, near-constant resistance you can push closer to failure
// with less stabilizer + systemic fatigue — more effective tension per unit of
// fatigue (KB exercise-selection: "stable enough to train near failure", load the
// muscle through its range). This is a MILD preference, not "machines grow more
// muscle" (free weights are broadly equivalent at matched effort/volume); it's
// kept smaller than the lengthened-bias bonus (−2) so lengthened loading stays the
// top hypertrophy signal, and below one difficulty step (3) so it never overrides
// the difficulty gate. Bands rank lowest for hypertrophy — ascending resistance is
// lightest exactly where the muscle is lengthened, the opposite of the goal. For a
// STRENGTH goal, specificity flips the ladder toward the barbell/free weights.
const EQUIP_TIER_HYPERTROPHY = { machine: -1.4, cable: -1.1, dumbbell: -0.5, kettlebell: -0.4, barbell: -0.2, band: 0.2, bodyweight: 0 };
const EQUIP_TIER_STRENGTH = { barbell: -1.2, dumbbell: -0.5, kettlebell: -0.3, machine: -0.2, cable: -0.2, band: 0, bodyweight: 0 };
// Systemic-fatigue preference (hypertrophy-oriented goals): for the same role,
// favour the option that buys its tension with less whole-body fatigue. Small, so
// it refines ties without burying a great high-CNS lift; works WITH the ≤2
// high-CNS-per-session cap. Strength embraces heavy systemic work, so it opts out.
const CNS_PENALTY = { high: 0.6, moderate: 0.25, low: 0 };
const EMPTY_SET = new Set();
// Bigger than every other ranking signal combined (lengthened −2, equipment −1.4,
// bodyweight +2.5, difficulty +3), so a stalled lift always sorts behind a
// non-stalled alternative regardless of how good it otherwise looks.
const STALLED_DEMOTION = 12;

function rankPool(pool, { experience, seed, blockJitter = 0, goal = "hypertrophy", stalled = EMPTY_SET }) {
  const diffRank = { beginner: 0, intermediate: 1, advanced: 2 };
  const userLvl = diffRank[experience] ?? 1;
  const equipTier = goal === "strength" ? EQUIP_TIER_STRENGTH : EQUIP_TIER_HYPERTROPHY;
  const fatigueAware = goal !== "strength";
  // Only prefer loaded exercises when the pool actually offers one — a
  // bodyweight-only user's ranking is left completely unchanged.
  const hasLoaded = pool.some((e) => e.equipment !== "bodyweight");
  return [...pool]
    .map((e) => {
      let score = 0;
      if (e.lengthened_bias) score -= 2;                 // KB: bias toward lengthened loading
      const d = diffRank[e.difficulty] ?? 1;
      if (d > userLvl) score += 3 * (d - userLvl);       // too advanced → penalize
      // Prefer progressively-loadable exercises: when a loaded option exists, a
      // non-loadable bodyweight move (lunge, inverted row, single-leg RDL) ranks
      // below EVERY loaded option for that muscle, because it can't be overloaded once
      // mastered — the #1 driver of long-term growth. The penalty (2.5) is decisive:
      // big enough that even a lengthened-biased bodyweight move (−2) still sorts
      // above 0 (a loaded non-lengthened option), so the block rotation exhausts all
      // loadable variants before ever reaching the capped one. Kept below one
      // difficulty step (3) so a too-advanced loaded lift can still yield to an
      // appropriate bodyweight move. `hasLoaded` gates it entirely, so a
      // bodyweight-only user's ranking is unchanged and the lengthened move wins there.
      if (hasLoaded && e.equipment === "bodyweight" && !LOADABLE_BODYWEIGHT.test(e.id)) score += 2.5;
      // THE EXERCISE-VARIATION LEVER (KB logging-and-plateaus.md: volume → effort →
      // deload → CHANGE EXERCISE). A lift the user has genuinely plateaued on sinks
      // below every alternative for that muscle, so the next block gives them a
      // different angle instead of the same stalled movement. Decisive by design —
      // larger than any quality signal above — because "keep doing the thing that
      // stopped working" is the one outcome this lever exists to prevent. It's a
      // demotion, not an exclusion: if a muscle has only one accessible exercise,
      // that exercise is still last in a pool of one and still gets picked.
      // Applies to COMPOUNDS too, which rotateTopK deliberately never touches — a
      // stalled bench press could previously never be swapped by anything.
      if (stalled.has(e.id)) score += STALLED_DEMOTION;
      // #1/#5: prefer stable, low-fatigue equipment (machines/cables) for growth —
      // more effective tension per unit of systemic fatigue; barbell for strength.
      score += equipTier[e.equipment] ?? 0;
      if (fatigueAware) score += CNS_PENALTY[e.cns_cost] ?? 0;
      score += (((seed ^ hashStr(e.id)) + blockJitter * 2654435761) % 100) / 1000; // deterministic jitter; blockJitter rotates ties each mesocycle
      return { e, score };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.e);
}
function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
// Cyclically shift the top `k` of a quality-ranked pool by `shift` (the block
// index) — mesocycle accessory variation that only ever swaps among the best
// options, never drifting to a worse one. shift 0 (default block) is a no-op, so
// the byte-identical determinism guarantee holds. Rest of the pool stays put.
function rotateTopK(arr, shift, k = 3) {
  const n = Math.min(k, arr.length);
  if (n <= 1) return arr;
  const s = (((shift | 0) % n) + n) % n;
  if (s === 0) return arr;
  return [...arr.slice(s, n), ...arr.slice(0, s), ...arr.slice(n)];
}

function contraExcluded(ex, injuries, contraindications) {
  if (!injuries?.length || !contraindications) return false;
  const regions = contraindications.regions ?? contraindications;
  for (const inj of injuries) {
    const rule = regions[inj.region];
    if (!rule) continue;
    // exclude_patterns apply at any severity; caution_patterns also apply unless "mild".
    const strict = inj.severity !== "mild";
    const patterns = strict ? [...(rule.exclude_patterns ?? []), ...(rule.caution_patterns ?? [])] : (rule.exclude_patterns ?? []);
    if (patterns.includes(ex.movement_pattern)) return true;
    if ((rule.exclude_muscles ?? []).some((m) => (ex.primary_muscles ?? []).includes(m))) return true;
  }
  return false;
}

// The exercises a given profile can actually perform — the SAME equipment +
// injury-contraindication filter the generator applies. The plan editor's swap /
// add pickers use this so they never offer a lift the generator deliberately
// excluded: an unavailable-equipment one (a dead end for a novice) or a
// contraindicated one (an injury risk the generator removed for safety).
export function accessibleExercises(profile, kb) {
  const { exercises, contraindications } = kb;
  const equip = new Set(profile?.available_equipment ?? ["barbell", "dumbbell", "machine", "cable", "bodyweight"]);
  const injuries = profile?.injuries ?? [];
  return exercises.filter((e) => equip.has(e.equipment) && !contraExcluded(e, injuries, contraindications));
}

// CARDIO — prescribed, not just described (considerations #1, finding 1A).
// The KB has carried real numbers since Wave 161 (dose by goal, a modality
// interference ranking, timing rules) and the plan engine emitted NOTHING: `grep
// cardio tools/plan-core.mjs` returned zero hits. The only cardio surfaces in the
// whole app were a REACTIVE Progress-tab card that fires in one narrow pattern and
// a passing sentence on the Fuel tab, so a user asking "how much cardio should I
// do?" got nothing actionable — while the KB page had the answer all along.
//
// Every number here comes from data/guidelines/cardio-concurrent-training.json;
// nothing is invented, and the guideline's own Grade D rides along so the surface
// can label it honestly ("practical models, not measured constants" — its words).
//
// Placement is DERIVED rather than guessed, because the engine already knows which
// sessions are leg-loaded. The guideline's first timing rule is "keep hard
// lower-body cardio off the day of, and the day before, a leg session", so a
// rotation slot is unsafe if it IS leg work or the NEXT slot is (wrapping, since
// the rotation cycles). On some perfectly normal splits — 4-day upper/lower, where
// every day is a leg day or the day before one — NOTHING is safe, and the honest
// answer is rest days and walking rather than pretending a slot exists.
const LEG_LOADED = new Set(["LEGS", "LOWER", "FULL"]);
function buildCardio(guideline, goal, sessionSpecs) {
  if (!guideline) return null;
  const dose = guideline.dose_by_goal?.[goal] ?? guideline.dose_by_goal?.hypertrophy;
  if (!dose) return null;
  const modalities = guideline.modalities ?? [];
  const byInterference = { none: 0, low: 1, moderate: 2, high: 3 };
  const ranked = [...modalities].sort((a, b) => (byInterference[a.interference] ?? 9) - (byInterference[b.interference] ?? 9));
  const legDays = sessionSpecs.map((spec) => LEG_LOADED.has(spec.arch));
  const n = sessionSpecs.length;
  const safeSlots = sessionSpecs
    .map((spec, i) => ({ name: spec.name, safe: !legDays[i] && !legDays[(i + 1) % n] }))
    .filter((x) => x.safe)
    .map((x) => x.name);
  const legSessionNames = sessionSpecs.filter((_, i) => legDays[i]).map((spec) => spec.name);
  return {
    steps_per_day: dose.steps_per_day ?? null,
    sessions_per_week: dose.sessions_per_week ?? null,
    minutes_per_session: dose.minutes_per_session ?? null,
    // Walking first — the only modality the KB rates as costing nothing, and the
    // reason steps come before structured cardio. The structured pick is the
    // lowest-interference option that isn't just walking again.
    modality: ranked[0] ? { id: ranked[0].id, name: ranked[0].name, interference: ranked[0].interference } : null,
    structured_modality: (() => { const m = ranked.find((x) => x.id !== ranked[0]?.id); return m ? { id: m.id, name: m.name, interference: m.interference } : null; })(),
    // Where the hard sessions go. Empty `best_after` is a real answer, not a gap.
    placement: {
      best_after: safeSlots,
      avoid_around: legSessionNames,
      rule: guideline.timing_rules?.[0]?.rule ?? null,
    },
    note: dose.note ?? guideline.summary ?? null,
    evidence_grade: dose.evidence_grade ?? guideline.evidence_grade ?? "D",
    citations: dose.citations ?? [],
  };
}

// WHICH muscles matter to you is a preference only you can supply. HOW HARD to push
// them is a programming decision — and the app was asking the user to make it ("How
// hard should I push those muscles?" → balanced vs all-in), which is exactly backwards
// against Goal 2: ask the right questions at the start, then decide everything else
// for them. A lifter who knew whether they wanted an all-in specialization block
// wouldn't need the app to write their program.
//
// So it is derived, from the KB's own rule rather than an invented one:
//   - "Once you're past the beginner phase" (weak-point-prioritization TL;DR) — a
//     beginner grows everything on a general plan and has no lagging muscle to
//     diagnose yet, so never.
//   - "Specialize one or two areas at a time ... You can't specialize everything at
//     once — that's just 'more volume everywhere', which recovery won't support"
//     (variation-and-specialization). So 1-2 areas → a real block; 3+ → the
//     priority tilt without the maintenance trade, because there is nothing left to
//     harvest the recovery budget FROM.
//
// AREAS, not muscle ids — and the distinction is not pedantic, it inverted the rule.
// `priority_muscles` stores IDS: the client's "Back" chip is `["lats","upper-back"]`
// and "Arms" is `["biceps","triceps"]`, so counting ids made the threshold depend on
// an implementation detail of the chip→id mapping rather than on the rule it cites.
// Back ALONE (one area, two ids) specialized; Back + Arms (the two areas the KB
// blesses, four ids) did not. The falsifying case is in the KB's own data: the shipped
// `specialization-delts-arms-4day` template — "Shoulders & Arms Specialization",
// described there as a real 4-6 week block — is side-delts + biceps + triceps, THREE
// ids across TWO areas, and the engine refused to build its own template's shape.
// `data/muscles/*.json` already carries `group` (lats→back, triceps→arms), so the area
// unit is the KB's, not a constant duplicated here (lesson 1). An id with no known
// group counts as its own area, so an unrecognised entry can never silently merge.
//
// A stored `true` still wins: it was only ever reachable by an explicit tap on "All-in
// specialization block", so it is unambiguously a decision, and honouring it means
// nobody who deliberately opted in has it taken away. A stored `false` is NOT honoured,
// because it was never necessarily an answer — the old client wrote
// `specialization: priority.length ? answers.specialization === true : false`, so every
// user who skipped the optional priority question, and every beginner (the step's
// `showIf` hid it from them), had `false` written for them by a question they were
// never shown. Treating that silence as a decision is what froze this derivation out
// of the ENTIRE pre-existing population while every test passed on fresh fixtures —
// lesson 34, one wave after lesson 34 was written: a fix's reach is bounded by the
// population of the field it reads, and no test can tell you, because the fixtures
// supply the field.
export function deriveSpecialization(profile, muscles = []) {
  if (profile?.specialization === true) return true;
  const ids = profile?.priority_muscles ?? [];
  if (!ids.length) return false;
  if ((profile?.training_status ?? "beginner") === "beginner") return false;
  const groupOf = new Map((muscles ?? []).map((m) => [m.id, m.group]));
  const areas = new Set(ids.map((id) => groupOf.get(id) ?? id));
  return areas.size <= 2;
}

export function generatePlan(profile, kb, opts = {}) {
  const { exercises, muscles, contraindications } = kb;
  const experience = profile.training_status ?? "intermediate";
  const goal = profile.primary_goal ?? "hypertrophy";
  const priority = new Set(profile.priority_muscles ?? []);
  const injuries = profile.injuries ?? [];
  const equip = new Set(profile.available_equipment ?? ["barbell", "dumbbell", "machine", "cable", "bodyweight"]);
  const seed = seedFromProfile(profile);
  const specialization = deriveSpecialization(profile, muscles); // all-in block: priorities to the ceiling, the rest to maintenance
  const blockIndex = opts.blockIndex ?? 0;         // rotates ACCESSORIES each mesocycle; compounds stay stable
  // Lifts this person has genuinely plateaued on — demoted below every alternative
  // for their muscle so the next block offers a different angle (the KB's
  // change-exercise lever). Empty by default, so a plan generated without it is
  // byte-identical to before and the determinism guarantee holds.
  const stalled = new Set(opts.stalledExercises ?? []);
  const cardioGuideline = (kb.guidelines ?? []).find((g) => g.id === "cardio-concurrent-training") ?? null;
  const compoundSets = experience === "advanced" ? 4 : 3;
  const perSessionCap = opts.perMuscleSessionCap ?? 10;
  const scheme = repScheme(goal);
  // Daily undulation (roadmap #9), auto-derived to keep manual customization minimal
  // (Goal 2): ADVANCED trainees on a muscle-building goal get heavy/moderate/light-by-day
  // automatically — the method most suits them and they shouldn't have to ask for it —
  // while beginners/intermediates keep the simpler linear default. `profile.periodization`
  // is a respected OVERRIDE either way ("undulating" forces it on, "linear" forces it off),
  // but nothing needs to be set: the right default is chosen from training status.
  // One predicate, shared with explainPersonalization's legacy-rationale path, so the
  // generator and the explanation can never disagree about whether the week undulates.
  const undulating = undulatesForProfile({ ...profile, primary_goal: goal, training_status: experience });

  const muscleById = new Map(muscles.map((m) => [m.id, m]));
  // Loaded carries (suitcase/bottoms-up) are a time-and-distance movement — there is
  // no honest "3×6–10 reps" for them, so the rep-based generator would prescribe a
  // nonsensical set/rep count. They stay in the library (searchable, swappable,
  // addable with their real execution cues) but never auto-fill a hypertrophy slot.
  // Every muscle a carry serves (abs, forearms) keeps other options, so excluding
  // them never starves the coverage invariant.
  const avail = exercises.filter((e) => equip.has(e.equipment) && e.movement_pattern !== "carry" && !contraExcluded(e, injuries, contraindications));

  // 1) split
  const { split, sessions: sessionSpecs, reason: splitReason, citations: splitCites } = chooseSplit({ days_per_week: profile.days_per_week, training_status: experience });
  // Cardio rides on the split, since its placement rule is about leg days.
  const cardio = buildCardio(cardioGuideline, goal, sessionSpecs);

  // 2) weekly target per muscle
  // opts.volumeAdjust is the ADAPTIVE per-muscle delta (#2): how the user's own
  // logged response has nudged each muscle's target up or down over past blocks.
  // Applied to the landmark-derived base and re-clamped to [MEV.min, MRV.max] so an
  // adaptive bump can never push a muscle past its recoverable ceiling.
  const volumeAdjust = opts.volumeAdjust ?? {};
  const targets = {};
  const volumeRationale = {};
  for (const m of muscles) {
    const t = targetWeeklySets(m.landmarks, { experience, isPriority: priority.has(m.id) });
    const delta = volumeAdjust[m.id];
    if (delta && m.landmarks) {
      const tuned = clamp(t.target + delta, m.landmarks.mev.min, m.landmarks.mrv.max);
      if (tuned !== t.target) { t.reasons.push(`adaptive: ${tuned - t.target > 0 ? "+" : ""}${tuned - t.target} set${Math.abs(tuned - t.target) === 1 ? "" : "s"} from your logged response`); t.target = tuned; }
    }
    targets[m.id] = t.target;
    volumeRationale[m.id] = { target_sets: t.target, is_priority: priority.has(m.id), landmark: t.landmark, reasons: t.reasons, ...(volumeAdjust[m.id] ? { adaptive_delta: volumeAdjust[m.id] } : {}) };
    // SPECIALIZATION BLOCK (KB: weak-point-prioritization): the user goes all-in —
    // priority muscles push to the recoverable ceiling while everything else drops
    // to a maintenance dose (~half MEV keeps muscle; detraining-and-maintenance).
    // The freed recovery budget is what pays for the specialization.
    if (specialization && priority.size && m.landmarks) {
      if (priority.has(m.id)) {
        targets[m.id] = m.landmarks.mrv.max; // the MRV trim keeps the projection legal
        volumeRationale[m.id].target_sets = targets[m.id];
        volumeRationale[m.id].reasons = [`specialization block → push to the ceiling (${targets[m.id]})`];
      } else {
        // Maintenance = the KB's own MV (maintenance volume) landmark, NOT a
        // guessed half-MEV: mv.min actually holds muscle, ceil(mev/2) was below MV
        // for ~15 of 16 muscles and would slowly detrain what it claims to protect.
        const maint = m.landmarks.mv?.min ?? Math.max(2, Math.ceil(m.landmarks.mev.min / 2));
        targets[m.id] = maint;
        volumeRationale[m.id].target_sets = maint;
        volumeRationale[m.id].maintenance = true; // the muscle's maintenance dose — holds it, frees recovery
        volumeRationale[m.id].reasons = [`maintenance during specialization (~${maint} sets, the KB's maintenance volume — holds what you've built)`];
      }
    }
  }

  // 3) how many sessions each muscle appears in (its frequency)
  const freq = {};
  for (const spec of sessionSpecs) for (const m of ARCH[spec.arch]) freq[m] = (freq[m] ?? 0) + 1;

  // A non-priority muscle inside a specialization block is HELD at its maintenance
  // dose: the block's whole mechanism is to free recovery by NOT growing everything
  // else. Direct allocation to such a muscle is capped at its (maintenance) target
  // so the plan can't quietly grow it past what the "holds what you've built"
  // rationale promises. Priority muscles and non-specialization plans are untouched.
  const holdMaint = (m) => specialization && priority.size > 0 && !priority.has(m) && !!volumeRationale[m]?.maintenance;

  // pools per muscle (filtered + ranked), and a rotation counter for variety
  const compoundPool = {}, isoPool = {}, rot = {};
  for (const m of muscles) {
    // Difficulty is a HARD gate, not a soft penalty: rotation through a small pool
    // was handing pistol squats and Nordic curls to day-one beginners. Keep only
    // exercises at or below the user's level — falling back to the next tier up
    // ONLY when nothing easier trains the muscle (honest > empty).
    const diffRank = { beginner: 0, intermediate: 1, advanced: 2 };
    const userLvl = diffRank[experience] ?? 1;
    // A BEGINNER never gets an advanced exercise, even as a last resort — the whole
    // reason this is a hard gate (day-one lifters were getting pistol squats and
    // sissy squats). So a beginner's fallback ceiling is intermediate; if that
    // leaves an ISOLATION pool empty for some muscle, the compound pool still trains
    // it (and the coverage invariant holds). Intermediate/advanced can fall back to
    // advanced as before so a muscle is never left with an empty pool for them.
    const ceil = userLvl === 0 ? 1 : 2;
    const gate = (pool) => {
      for (let lvl = userLvl; lvl <= ceil; lvl++) {
        const ok = pool.filter((e) => (diffRank[e.difficulty] ?? 1) <= lvl);
        if (ok.length) return ok;
      }
      return pool.filter((e) => (diffRank[e.difficulty] ?? 1) <= ceil); // may be empty for a beginner — that's fine, compounds cover the muscle
    };
    compoundPool[m.id] = rankPool(gate(avail.filter((e) => e.mechanic === "compound" && (e.primary_muscles ?? []).includes(m.id))), { experience, seed, goal, stalled });
    // Progressive-overload guard: a loaded user never rotates onto a non-loadable
    // bodyweight COMPOUND (lunge, inverted row, single-leg RDL). rankPool already
    // sorts these last, but the block-rotation counter still periodically lands on
    // one for a high-frequency muscle on a 5–6-day split, and an int/adv lifter who
    // owns a barbell should overload a loaded variant instead. Drop them outright
    // when ≥1 loadable compound survives; keep them only as the sole fallback, so a
    // bodyweight-only pool (all non-loadable) is left completely untouched.
    {
      const loadable = compoundPool[m.id].filter((e) => e.equipment !== "bodyweight" || LOADABLE_BODYWEIGHT.test(e.id));
      if (loadable.length) compoundPool[m.id] = loadable;
    }
    // Accessories rotate with the mesocycle (fresh stimulus, KB: variation), while
    // compounds keep their ranking so double-progression baselines survive blocks.
    // Accessories: rank by quality (lengthened → equipment → low-fatigue), then
    // CYCLE the top few each mesocycle for variation (KB: rotate accessories every
    // block or two). Rotating only within the top band keeps every rotated option
    // high-quality — and since the equipment tier (Wave 41) now separates options
    // by more than a score-jitter could flip, an explicit top-K rotation is what
    // actually varies them (jitter alone left the single best-equipment move
    // pinned every block). Compounds keep their stable ranking (double-progression).
    isoPool[m.id] = rotateTopK(rankPool(gate(avail.filter((e) => e.mechanic === "isolation" && (e.primary_muscles ?? []).includes(m.id))), { experience, seed, goal, stalled }), blockIndex);
    rot[m.id] = 0;
  }
  const exById = new Map(avail.map((e) => [e.id, e]));

  // 4) build each session, within a realistic time budget AND a quality ceiling.
  // Time alone is not a licence to fill a session with hard sets: per-set effort
  // collapses well before the clock runs out (the KB's per-muscle 6-10 quality
  // window and Schoenfeld 2015's per-set-quality mechanism both point here, and
  // real lifters report effort degrading after ~a dozen hard sets). The ceiling
  // scales with training age — beginners need far less to grow and can sustain
  // less; advanced lifters tolerate more.
  const SESSION_QUALITY_CAP = { beginner: 12, intermediate: 16, advanced: 20 };
  const sessionMin = clamp(profile.session_length_min ?? 60, 30, 120);
  const setBudget = Math.min(Math.round(sessionMin / 3), SESSION_QUALITY_CAP[experience] ?? 16); // ~3 min/set incl. rest, capped for quality
  const EX_SET_CAP = 5;   // no single exercise exceeds 5 sets
  const EX_BUDGET = 8;    // no session exceeds 8 exercises
  const exerciseChoices = [];
  const compoundBands = [];     // the compound rep band each session actually got (see the push below)
  const weekServed = new Set(); // muscles with a direct exercise ANYWHERE this week
  const weekUseCount = {};      // exercise id → sessions used this week (variety: cap at 2)
  let weekKneeFlexion = false;  // has ANY session placed knee-flexion hamstring work yet?
  const outSessions = sessionSpecs.map((spec, sIdx) => {
    const mset = ARCH[spec.arch];
    // This day's rep/intensity band: the base scheme, or (auto/opt-in DUP) a
    // heavy/moderate/light variant. When this archetype repeats in the week
    // (spec.of > 1, e.g. Push A/B), key off ITS OWN occurrence count so every
    // repeat of the same muscle group cycles through a different band — the
    // guarantee the feature promises. When it doesn't repeat (every archetype
    // in the split is unique, e.g. the 5-day PUSH/PULL/LEGS/UPPER/LOWER split),
    // there's no same-archetype exposure to vary, so fall back to the day's
    // absolute position for whatever incidental week-to-week variety that gives.
    const sessScheme = sessionRepScheme(scheme, undulating, spec.of > 1 ? spec.letter - 1 : sIdx);
    // What the week ACTUALLY prescribes for compounds, banked as it is decided. The
    // rationale used to carry only the pre-undulation base scheme, so the plan screen's
    // "What your answers changed" panel told an advanced hypertrophy lifter "compounds
    // run 6-10" while the session list directly above it read 4-6 / 6-10 / 10-15.
    compoundBands.push(sessScheme.compound?.[0]);
    const credited = {};      // effective sets credited to each muscle THIS session
    const direct = {};        // DIRECT primary sets per muscle this session (KB session-quality cap)
    const isoCredited = {};   // DIRECT isolation sets per muscle this session (arm/delt floor)
    const famCount = {};      // compound movement-pattern families this session (cap: 2 per family)
    const placed = new Set(); // exercise ids already in this session
    const items = [];
    let setsUsed = 0;
    let highCns = 0;          // count of high-CNS-cost lifts placed this session
    const room = () => setsUsed < setBudget && items.length < EX_BUDGET;
    const add = (ex, sets, forMuscle, why) => {
      if (placed.has(ex.id) || !room()) return false;
      // Weekly variety cap: the same lift in a 3rd session is a programming smell
      // (the engine was prescribing upright-rows and close-grip benches 3×/week).
      // KB variation page (Grade C): keep a stable core of 2-4 exercises per
      // muscle and vary the rest — twice a week is a staple, a 3rd exposure adds
      // repetition, not coverage; the dose itself is practice-based [D].
      // Selection loops prefer un-capped candidates, so this is a backstop.
      if ((weekUseCount[ex.id] ?? 0) >= 2) return false;
      // Per-session movement-PATTERN cap for COMPOUNDS: a 3rd hinge (or squat,
      // lunge, horizontal-press…) variant in ONE session is redundant fatigue — an
      // advanced leg day was generating good-morning + deadlift + RDL + single-leg
      // RDL back to back. KB exercise-selection page (Grade C): cover a muscle's
      // functions with 2-4 DIFFERENT exercises — a 3rd copy of one pattern adds
      // fatigue, not a new angle. Capped at the RAW pattern (not the famOf
      // family) so a back day still runs 2 rows AND 2 vertical pulls.
      if (ex.mechanic === "compound" && (famCount[ex.movement_pattern] ?? 0) >= 2) return false;
      // No more than 2 maximal-systemic-fatigue (high cns_cost) COMPOUNDS per
      // session: squat + a deadlift is already a hard day, and a 3rd heavy barbell
      // lift (typically a redundant 2nd squat or hinge variant on an advanced lower
      // day) over-taxes recovery for little extra stimulus. By the time a session
      // has 2 high-CNS lifts the muscles they train are already covered, so refusing
      // the 3rd never starves anything — later isolation passes fill the budget with
      // lower-CNS work. Isolations are never high-CNS, so this only touches compounds.
      if (ex.cns_cost === "high" && ex.mechanic === "compound" && highCns >= 2) return false;
      const iso = ex.mechanic === "isolation";
      // Rep band: priority isolations highest, small-muscle "pump" isolations
      // 12-20 (the KB intensity page's own isolation band), other isolations
      // 10-15, compounds heavy.
      const s = iso
        ? (priority.has(forMuscle) ? sessScheme.priorityIso : PUMP_MUSCLES.has(forMuscle) ? sessScheme.pumpIso : sessScheme.isolation)
        : supported(ex)
          ? [sessScheme.compound[0], easeToward(sessScheme.compound[1])] // the KB's middle effort tier
          : sessScheme.compound;
      // Held-at-maintenance muscles never receive more direct volume than their
      // (maintenance) target still has room for — so a full compoundSets can't blow
      // a small maintenance dose past its ceiling. `credited` is effective volume
      // (primary 1.0 + secondary 0.5), so this counts incidental secondary work too.
      const want = holdMaint(forMuscle)
        ? Math.min(sets, Math.max(1, Math.ceil(Math.ceil((targets[forMuscle] ?? 0) / Math.max(1, freq[forMuscle] ?? 1)) - (credited[forMuscle] ?? 0))))
        : sets;
      // PER-MUSCLE SESSION-QUALITY CAP (KB frequency page, Grade C: "roughly 6-10
      // hard sets in a single session is about as much as most people can do for
      // one muscle before per-set quality drops... add a day rather than
      // cramming"). Direct primary sets per muscle are capped at perSessionCap
      // (default 10) — bounding CROSS-CREDIT too: an advanced Lower day was
      // stacking 12 direct glute sets via squat/hinge variants each placed for a
      // different muscle, every one crediting glutes as a primary.
      const headroom = Math.min(setBudget - setsUsed, ...(ex.primary_muscles ?? []).map((m) => perSessionCap - (direct[m] ?? 0)));
      // No 1-set EXERCISES, compound or isolation: a 1-set curl or lateral raise
      // is scatter, not a dose — multi-set superiority is Grade A (volume page,
      // Krieger 2010), so the engine concentrates: fewer exercises, 2-5 sets
      // each. Residual top-ups grow an EXISTING exercise instead. The one
      // exception: a held-at-maintenance muscle, where a deliberate 1-set
      // micro-dose IS the prescription (KB: maintenance volume can be that low).
      if (Math.min(want, headroom) < (holdMaint(forMuscle) ? 1 : 2)) return false;
      const setN = clamp(Math.min(want, EX_SET_CAP, headroom), 1, 10);
      placed.add(ex.id); setsUsed += setN;
      weekUseCount[ex.id] = (weekUseCount[ex.id] ?? 0) + 1;
      if (ex.mechanic === "compound") famCount[ex.movement_pattern] = (famCount[ex.movement_pattern] ?? 0) + 1;
      if (iso) for (const m of ex.primary_muscles ?? []) isoCredited[m] = (isoCredited[m] ?? 0) + setN;
      if (ex.movement_pattern === "isolation-knee-flexion") weekKneeFlexion = true;
      items.push({ exercise: ex.id, sets: setN, rep_range: s[0], rir: s[1] });
      if (ex.cns_cost === "high") highCns++;
      for (const m of ex.primary_muscles ?? []) { credited[m] = (credited[m] ?? 0) + setN; direct[m] = (direct[m] ?? 0) + setN; }
      for (const m of ex.secondary_muscles ?? []) credited[m] = (credited[m] ?? 0) + setN * 0.5;
      exerciseChoices.push({ exercise: ex.id, for_muscle: forMuscle, session: spec.name, sets: setN, rep_range: s[0], rir: s[1], why, difficulty: ex.difficulty, citations: ex.citations ?? [] });
      return true;
    };
    // Per-session share of the weekly target, capped at the session-quality window
    // (perSessionCap): when weekly target / frequency exceeds what one session can
    // deliver at quality, the under-target warning says so — the KB's answer is
    // "add a day rather than cramming" (frequency page), not a 13-set session.
    const perTarget = (m) => Math.min(perSessionCap, Math.ceil((targets[m] ?? 0) / Math.max(1, freq[m] ?? 1)));
    // muscles this session trains, priority ones first so they win contested budget
    const order = [...PLACE_ORDER].filter((m) => mset.includes(m)).sort((a, b) => (priority.has(b) ? 1 : 0) - (priority.has(a) ? 1 : 0));
    // ISO_FIRST muscles draw from their isolation pool first (laterals before
    // upright-rows); everyone else compounds-first as before.
    const poolFor = (m) => ISO_FIRST.has(m)
      ? (isoPool[m].length ? isoPool[m] : compoundPool[m])
      : (compoundPool[m].length ? compoundPool[m] : isoPool[m]);
    // Rotation pick that skips exercises already placed this session OR already
    // used in 2 sessions this week (variety). Returns null when nothing qualifies —
    // by the time the week cap can bind, the muscle has already been served twice.
    const pickFrom = (pool, m) => {
      for (let t = 0; t < pool.length; t++) {
        const cand = pool[(rot[m] + t) % pool.length];
        if (!placed.has(cand.id) && (weekUseCount[cand.id] ?? 0) < 2) { rot[m] += t + 1; return cand; }
      }
      return null;
    };

    // 4a0) PRIORITY muscles get FIRST dibs on budget — but not ALL of it. A
    // side-delts+biceps priority at a short session length was producing three
    // identical curl+raise days with no squat, hinge, or press. Each priority gets
    // ONE exercise of ≤3 sets here (the 4b residual pass tops it up later), and the
    // whole pass stops at half the budget so pattern coverage below can still run.
    // Under a SPECIALIZATION block the priority muscle takes a SECOND exercise in
    // this pass (still inside priorityBudget): the block's contract is that
    // maintenance-dosed muscles freed the budget to pay for the priority, but the
    // first-serve/staple passes were filling all 8 exercise slots (wrist curls
    // included) before the priority could double — chest specialization was
    // delivering 8 of a 22-set target with budget left unused.
    const priorityBudget = Math.max(compoundSets + 1, Math.ceil(setBudget / 2));
    for (const round of specialization ? [0, 1] : [0]) {
      for (const m of order) {
        if (!priority.has(m) || setsUsed >= priorityBudget || (credited[m] ?? 0) >= perTarget(m)) continue;
        const pool = poolFor(m);
        if (!pool.length) continue;
        const ex = pickFrom(pool, m);
        if (ex) add(ex, Math.min(perTarget(m), 3, EX_SET_CAP), m, ["priority muscle — served first", ex.lengthened_bias ? "lengthened-biased" : "primary for " + m]);
      }
    }

    // 4a¼) WEEKLY COVERAGE FLOOR: before this session doubles up on big muscles,
    // every muscle it trains that NO session has served yet this week gets one
    // exercise (~2 sets). One 16-set session can't serve 11 muscles, but the week
    // must — abs/calves were getting zero all week on 2-day splits (last in
    // PLACE_ORDER), and specialization-maintenance muscles were dropping to zero
    // rather than their maintenance floor. Runs BEFORE pattern-coverage doubling.
    for (const m of order) {
      // (direct[m] > 0): a muscle already holding direct sets THIS session (the
      // 4a0 priority pass, or a compound placed for a neighbour) is served — the
      // floor exists for muscles with NOTHING, and `order` is priority-first, so
      // without this check a priority arm just served by 4a0 took a SECOND
      // isolation labeled "weekly coverage" while chest/lats/glutes had zero
      // (beginner 2-day arm-priority weeks shipped with one compound total).
      if (weekServed.has(m) || (direct[m] ?? 0) > 0 || (credited[m] ?? 0) >= perTarget(m) || !room()) continue;
      const pool = poolFor(m);
      if (!pool.length) continue;
      const ex = pickFrom(pool, m);
      if (ex) add(ex, Math.min(2, perTarget(m), EX_SET_CAP), m, ["weekly coverage — every muscle gets served before any doubles up", ex.lengthened_bias ? "lengthened-biased" : "primary for " + m]);
    }

    // 4a) one compound per compound-driven muscle — but under a scarce quality
    // budget, cover every fundamental MOVEMENT PATTERN before doubling one. The
    // 12-set beginner budget was filling with squat+push+row+chin-up (two pulls)
    // and no hinge, leaving hamstrings untrained. Pass 0 serves unseen pattern
    // families; pass 1 doubles up only if budget remains.
    const fams = new Set(items.map((it) => famOf(exById.get(it.exercise)?.movement_pattern)));
    const servedFor = new Set(exerciseChoices.filter((c) => c.session === spec.name).map((c) => c.for_muscle));
    for (const pass of [0, 1]) {
      for (const m of order) {
        // ISO_FIRST muscles (side-delts) don't take a compound slot — their
        // isolation IS the primary movement; pressing already covers the region.
        if (ISO_FIRST.has(m)) continue;
        if (!room() || (credited[m] ?? 0) >= perTarget(m) || !compoundPool[m].length) continue;
        // peek the next USABLE candidate (not placed, not week-capped) without
        // consuming rotation — rotate only on actual placement, as before.
        let tPick = -1;
        for (let t = 0; t < compoundPool[m].length; t++) {
          const cand = compoundPool[m][(rot[m] + t) % compoundPool[m].length];
          if (!placed.has(cand.id) && (weekUseCount[cand.id] ?? 0) < 2) { tPick = t; break; }
        }
        if (tPick < 0) continue;
        const ex = compoundPool[m][(rot[m] + tPick) % compoundPool[m].length];
        if (pass === 0 && fams.has(famOf(ex.movement_pattern))) continue;
        rot[m] += tPick + 1;
        if (add(ex, compoundSets, m, ["compound before isolations", `${ex.equipment} available`, ex.lengthened_bias ? "lengthened-biased" : "primary for " + m])) {
          fams.add(famOf(ex.movement_pattern));
          servedFor.add(m);
        }
      }
      // 4a½) FIRST-SERVE before any doubling: every muscle this session trains gets
      // ONE exercise (isolations allowed, 2-3 sets) before any muscle gets seconds.
      // The quality cap was letting quad/chest compounds double up while side-delts,
      // calves, abs, and biceps got ZERO sets — failing the engine's own MEV checks.
      // One session's budget can't serve every muscle — but the WEEK must. Muscles
      // no session has served yet jump the queue, so the same last-in-order
      // muscles (calves, abs) can't lose every single day.
      if (pass === 0) {
        const fsOrder = [...order].sort((a, b) => (weekServed.has(a) ? 1 : 0) - (weekServed.has(b) ? 1 : 0));
        for (const m of fsOrder) {
          if (servedFor.has(m) || !room() || (credited[m] ?? 0) >= perTarget(m)) continue;
          const pool = poolFor(m);
          if (!pool.length) continue;
          const ex = pickFrom(pool, m);
          if (!ex) continue;
          if (add(ex, Math.min(3, Math.max(2, perTarget(m))), m, ["every muscle served before any doubles up", ex.lengthened_bias ? "lengthened-biased" : "primary for " + m])) {
            fams.add(famOf(ex.movement_pattern));
            servedFor.add(m);
          }
        }
      }
      // 4a¾) STAPLE FINISHERS — placed BETWEEN coverage (pass 0) and compound
      // doubling (pass 1): a leg curl or a set of curls beats a second chest
      // compound for the remaining budget — an uncovered function (KB: knee
      // flexion, direct arm work) is worth more than a redundant pattern's
      // diminishing returns. (When these ran after doubling, intermediates'
      // tighter budgets were spent before the staples could ever fire.)
      // (a) DIRECT arm/delt isolation: chin-ups don't replace curls, close-grip
      //     pressing doesn't replace pushdowns, presses don't replace laterals.
      //     When a DIRECT_ISO muscle this session trains has a meaningful target
      //     but no isolation placed yet, it gets one (2-3 sets) even though
      //     compound credit already "covers" it on paper.
      if (pass === 0) {
        for (const m of order) {
          if (!DIRECT_ISO.has(m) || (isoCredited[m] ?? 0) >= 2 || perTarget(m) < 3 || holdMaint(m) || !room()) continue;
          const ex = pickFrom(isoPool[m], m);
          if (ex) add(ex, Math.min(3, Math.max(2, perTarget(m) - Math.floor(credited[m] ?? 0))), m, ["dedicated isolation — focused, full-range sets of its own", ex.lengthened_bias ? "lengthened-biased" : "isolation for " + m]);
        }
        // (b) WEEKLY KNEE-FLEXION for hamstrings: hip hinges leave the short head
        //     of the biceps femoris untrained (it only crosses the knee) — leg
        //     curls are a leg-day canon staple for a reason. Guarantee ≥1
        //     knee-flexion exercise somewhere in the week when equipment allows.
        if (!weekKneeFlexion && mset.includes("hamstrings") && !holdMaint("hamstrings") && room()) {
          const kf = (isoPool["hamstrings"] ?? []).find((e) => e.movement_pattern === "isolation-knee-flexion" && !placed.has(e.id) && (weekUseCount[e.id] ?? 0) < 2);
          if (kf) add(kf, Math.min(3, Math.max(2, perTarget("hamstrings"))), "hamstrings", ["knee-flexion work — the hamstrings' short head only works when the knee bends", kf.lengthened_bias ? "lengthened-biased" : "leg-curl pattern"]);
        }
      }
    }
    // 4b) fill each muscle's residual: FIRST grow an isolation already in this
    // session (concentrated 3-5 set doses, the way humans actually program) —
    // only then add a new exercise (up to 2 per muscle), never a 1-set orphan.
    const topUp = (m, residual) => {
      // Grow the PRIMARY lift first — residual volume belongs to the compound (a
      // 3-4 set dose; concentrated doses on a stable core lift are what the KB's
      // double-progression model progresses, Grade B), and only then to an
      // isolation. No isolation balloons past 4 sets: 5×10-15 shrugs next to a
      // 2-set row is programming upside-down.
      const tiers = [
        { mech: "compound", cap: compoundSets },
        { mech: "isolation", cap: 4 },
      ];
      for (const { mech, cap } of tiers) {
        for (const it of items) {
          const x = exById.get(it.exercise);
          if (!x || x.mechanic !== mech || it.superset_with || !(x.primary_muscles ?? []).includes(m)) continue;
          // growth is bounded by every primary muscle's session-cap headroom, not
          // just the topped-up muscle's — same cross-credit rule as add()
          const grow = Math.min(round(residual), cap - it.sets, setBudget - setsUsed, ...(x.primary_muscles ?? []).map((mm) => perSessionCap - (direct[mm] ?? 0)));
          if (grow < 1) continue;
          it.sets += grow; setsUsed += grow;
          for (const mm of x.primary_muscles ?? []) { credited[mm] = (credited[mm] ?? 0) + grow; direct[mm] = (direct[mm] ?? 0) + grow; if (mech === "isolation") isoCredited[mm] = (isoCredited[mm] ?? 0) + grow; }
          for (const mm of x.secondary_muscles ?? []) credited[mm] = (credited[mm] ?? 0) + grow * 0.5;
          const ch = exerciseChoices.find((c) => c.session === spec.name && c.exercise === it.exercise);
          if (ch) ch.sets = it.sets;
          return true;
        }
      }
      return false;
    };
    for (const m of order) {
      for (let k = 0; k < 2; k++) {
        const residual = perTarget(m) - (credited[m] ?? 0);
        // topUp GROWS an existing exercise — it needs set budget, not an exercise
        // slot, so it must not sit behind room()'s 8-exercise cap (the staple
        // passes routinely fill a session to exactly 8 with sets to spare, which
        // was silently disabling every top-up: chest specialization delivered 8
        // of a 22-set target while sessions left 4 budgeted sets unused).
        if (residual < 1 || setsUsed >= setBudget) break;
        if (topUp(m, residual)) continue;
        if (!room()) break; // adding a NEW exercise still needs a free slot
        if (!isoPool[m].length) break;
        // While the week still lacks knee-flexion work, a hamstring isolation slot
        // is a LEG-CURL slot — the hinge work already placed covers everything but
        // the short head, which only a knee-flexion movement reaches.
        const kfPick = m === "hamstrings" && !weekKneeFlexion
          ? isoPool[m].find((e) => e.movement_pattern === "isolation-knee-flexion" && !placed.has(e.id) && (weekUseCount[e.id] ?? 0) < 2)
          : null;
        const ex = kfPick ?? pickFrom(isoPool[m], m);
        if (!ex) break;
        add(ex, clamp(round(residual), 2, EX_SET_CAP), m, ex.lengthened_bias ? ["fills residual volume", "lengthened-biased"] : ["fills residual volume for " + m]);
      }
    }
    // 4c) SUPERSET rescue for time-boxed sessions (KB: advanced-techniques —
    // "accents, not the meal"): if the budget is spent AND a muscle this session
    // trains is still short of target with an isolation available, pair ONE bonus
    // isolation (2 sets) with an existing NON-COMPETING isolation. Alternating
    // non-competing isolations costs roughly half the rest, so two paired sets
    // add ~2 minutes, not ~6 — honest time math for the lifter whose session
    // length is the binding constraint.
    if (setsUsed >= setBudget && items.length < EX_BUDGET) { // the rescue is a bonus exercise — still honour the per-session exercise cap
      const isoItems = items.filter((it) => exById.get(it.exercise)?.mechanic === "isolation" && !it.superset_with);
      outer: for (const m of order) {
        if ((credited[m] ?? 0) >= perTarget(m) || !isoPool[m].length) continue;
        if (volumeRationale[m]?.maintenance) continue; // the one rescue slot serves growth, not a muscle we're only holding
        for (let t = 0; t < isoPool[m].length; t++) {
          const cand = isoPool[m][(rot[m] + t) % isoPool[m].length];
          if (placed.has(cand.id) || (weekUseCount[cand.id] ?? 0) >= 2) continue; // same weekly-variety cap as everywhere
          if ((cand.primary_muscles ?? []).some((mm) => (direct[mm] ?? 0) + 2 > perSessionCap)) continue; // session-quality cap holds on the rescue path too
          const candMuscles = new Set([...(cand.primary_muscles ?? []), ...(cand.secondary_muscles ?? [])]);
          const partner = isoItems.find((it) => {
            const p = exById.get(it.exercise);
            return ![...(p.primary_muscles ?? []), ...(p.secondary_muscles ?? [])].some((mm) => candMuscles.has(mm));
          });
          if (!partner) continue;
          rot[m] += t + 1;
          const sN = 2;
          placed.add(cand.id); // NOTE: deliberately not counted in setsUsed — the pairing pays the time
          weekUseCount[cand.id] = (weekUseCount[cand.id] ?? 0) + 1; // rescue placements count toward the weekly-variety cap too
          const sch = priority.has(m) ? sessScheme.priorityIso : PUMP_MUSCLES.has(m) ? sessScheme.pumpIso : sessScheme.isolation; // same band logic as add() — undulates with the day
          items.push({ exercise: cand.id, sets: sN, rep_range: sch[0], rir: sch[1], superset_with: partner.exercise });
          partner.superset_with = cand.id;
          for (const mm of cand.primary_muscles ?? []) { credited[mm] = (credited[mm] ?? 0) + sN; direct[mm] = (direct[mm] ?? 0) + sN; }
          for (const mm of cand.secondary_muscles ?? []) credited[mm] = (credited[mm] ?? 0) + sN * 0.5;
          exerciseChoices.push({ exercise: cand.id, for_muscle: m, session: spec.name, sets: sN, rep_range: sch[0], rir: sch[1], why: ["superset — fits extra volume into your session length", "paired with " + partner.exercise], difficulty: cand.difficulty, citations: cand.citations ?? [] });
          break outer; // at most ONE rescue pair per session — an accent, not the meal
        }
      }
    }
    for (const c of exerciseChoices) if (c.session === spec.name) weekServed.add(c.for_muscle);
    // Emit in the order you should LIFT it (stable within each tier): the heaviest
    // systemic work first while you're fresh — high-CNS compounds (squats,
    // deadlifts), then the remaining compounds, then isolations (KB exercise-order
    // page: hardest and most fatiguing first, isolation later — Grade D,
    // practice-based). The engine was burying deadlifts mid-session behind
    // whatever pass happened to place first. Within each tier,
    // PRIORITY-muscle exercises lead (KB exercise-order page: do priority work
    // early while fresh — Grade D, effects modest, so we honour it without
    // breaking compound-before-isolation, which the app's own critique checks).
    items.sort((a, b) => {
      const key = (it) => {
        const x = exById.get(it.exercise);
        if (!x) return 99;
        const isPri = (x.primary_muscles ?? []).some((m) => priority.has(m));
        let tier = x.mechanic === "isolation" ? 3 : x.cns_cost === "high" ? 0 : x.cns_cost === "moderate" ? 1 : 2;
        // In a SPECIALIZATION block only, the priority muscle's work is promoted so
        // it lands while the user is fresh. The KB's weak-point page is explicit
        // about this — its Placement row reads "Trained first, when you're fresh" —
        // and the plain tier*2+pri key could never deliver it, because tier always
        // dominated: a side-delt specialist's lateral raises sat behind every
        // compound on the day, which is the exact opposite of the prescription, and
        // it went wrong for precisely the users who opted into specialization.
        // Still behind genuinely heavy work (a squat outranks a lateral raise even
        // in a delt block — burying the compound would trade a modest, Grade-D
        // ordering effect for a real one). Gated on `specialization`, so an ordinary
        // priority plan is byte-identical to before.
        if (specialization && isPri && tier > 1) tier = 1;
        return tier * 2 + (isPri ? 0 : 1);
      };
      return key(a) - key(b);
    });
    return { name: spec.name, exercises: items };
  });

  // helpers to score the generated week with the REAL tracker engine, so plan-time
  // volume can never disagree with what the user later sees on Progress.
  const exIndex = new Map(avail.map((e) => [e.id, { name: e.name, primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] }]));
  const muscleIndex = new Map(muscles.map((m) => [m.id, m.landmarks ?? null]));
  const projectWeek = () => {
    const pseudo = [{ date: "2026-01-05", sets: outSessions.flatMap((s) => s.exercises.flatMap((e) => Array.from({ length: e.sets }, () => ({ exercise: e.exercise, set_type: "work" })))) }];
    const w = perMuscleWeeklyVolume(pseudo, exIndex);
    return w[Object.keys(w)[0]] ?? {};
  };

  // 5) enforce recovery ceilings. Secondary credit from compounds can stack a muscle
  // above MRV even when its direct target was within range — the KB says that's more
  // than you can recover from. Trim its isolation sets until it's back under the
  // ceiling, so the plan can never prescribe past what the science allows.
  for (let guard = 0; guard < 80; guard++) {
    const proj = projectWeek();
    let worst = null, worstOver = 0;
    for (const m of muscles) {
      const cap = m.landmarks?.mrv?.max;
      if (cap == null) continue;
      const over = (proj[m.id] ?? 0) - cap;
      if (over > 0 && over > worstOver) { worstOver = over; worst = m.id; }
    }
    if (!worst) break;
    // Reduce DIRECT work on the over muscle only (exercises where it's the primary
    // target). Prefer isolations, then compounds; shave a set before dropping a whole
    // exercise. If nothing directly loads it, the overshoot is pure secondary spillover
    // from compounds needed for OTHER muscles — leave it and warn honestly below.
    const primaryLoads = (it) => (exById.get(it.exercise)?.primary_muscles ?? []).includes(worst);
    const isIso = (it) => exById.get(it.exercise)?.mechanic === "isolation";
    let trimmed = false;
    // Shave only while the exercise stays >= 2 sets — the no-1-set rule holds for
    // isolations AND compounds now (a 1-set shrug is scatter, not a dose). Anything
    // already at 2 that still needs trimming is DROPPED whole by the branches below.
    for (const s of outSessions) { const it = s.exercises.find((x) => primaryLoads(x) && isIso(x) && x.sets > 2); if (it) { it.sets--; trimmed = true; break; } }
    if (!trimmed) for (const s of outSessions) { const it = s.exercises.find((x) => primaryLoads(x) && x.sets > 2); if (it) { it.sets--; trimmed = true; break; } }
    if (!trimmed) for (const s of outSessions) { const i = s.exercises.findIndex((x) => primaryLoads(x) && isIso(x)); if (i >= 0) { s.exercises.splice(i, 1); trimmed = true; break; } }
    if (!trimmed) for (const s of outSessions) { const i = s.exercises.findIndex(primaryLoads); if (i >= 0) { s.exercises.splice(i, 1); trimmed = true; break; } }
    if (!trimmed) break;
  }

  // 5b) reconcile the rationale with the TRIMMED plan. exerciseChoices was built
  // while filling sessions, i.e. BEFORE the trim above mutated them — left alone it
  // reports set counts the plan no longer prescribes (and cites exercises the trim
  // removed). The explanation must describe the plan the user actually gets.
  {
    const kept = new Map();
    for (const s of outSessions) for (const e of s.exercises) kept.set(`${s.name}|${e.exercise}`, e.sets);
    const reconciled = exerciseChoices
      .filter((c) => kept.has(`${c.session}|${c.exercise}`))
      .map((c) => ({ ...c, sets: kept.get(`${c.session}|${c.exercise}`) }));
    exerciseChoices.length = 0;
    exerciseChoices.push(...reconciled);
    // the trim can remove one half of a superset pair — never leave a dangling link
    for (const sess of outSessions) {
      const ids = new Set(sess.exercises.map((e) => e.exercise));
      for (const e of sess.exercises) if (e.superset_with && !ids.has(e.superset_with)) delete e.superset_with;
    }
  }

  // 6) closed-loop self-check on the FINAL (trimmed) plan → rationale + warnings.
  const warnings = [];
  // Honesty on a frequency override: chooseSplit clamps to 2-6 sessions (a
  // productive hypertrophy program needs >=2, and the split table tops out at
  // 6), so a request for 1 or 7 days/week is delivered as 2 or 6. The onboarding
  // UI already bounds the stepper to 2-6, but a direct API caller can send 1/7 —
  // tell them their frequency was adjusted rather than silently changing it.
  const reqDays = profile.days_per_week;
  if (Number.isFinite(reqDays) && reqDays !== sessionSpecs.length) {
    warnings.push({ code: "frequency-adjusted", message: reqDays < sessionSpecs.length
      ? `You asked for ${reqDays} day${reqDays === 1 ? "" : "s"}/week; a productive program needs at least ${sessionSpecs.length} sessions, so this plan schedules ${sessionSpecs.length} — do them whenever you can.`
      : `You asked for ${reqDays} days/week; this plan covers everything well in ${sessionSpecs.length}, so the extra day is yours to rest or repeat a favourite session.` });
  }
  const weekVol = projectWeek();
  const vsLm = volumeVsLandmarks(weekVol, muscleIndex);
  for (const [m, r] of Object.entries(volumeRationale)) {
    const proj = weekVol[m] ?? 0;
    const f = freq[m] ?? 0;
    r.projected_sets = proj;
    r.frequency = f;
    r.projected_status = f ? (vsLm[m]?.status ?? "no-data") : "not-in-split";
    if (r.target_sets <= 0) continue; // NOTE: the field is target_sets — `r.target` was undefined here, which silently killed the under-target warning below for every profile
    // A maintenance muscle (specialization block) is INTENTIONALLY low — its status
    // is "maintenance" and it earns no growth warnings; warning that a muscle we're
    // deliberately only holding is "below MEV" would contradict the block's whole point.
    if (r.maintenance) {
      r.projected_status = proj > 0 ? "maintenance" : "not-reached";
      // Honesty: a maintenance muscle that is ALSO a synergist of the priority lifts
      // picks up unavoidable secondary volume and can sit above pure maintenance (you
      // can't press for a priority chest without working triceps/front-delts). When
      // that lands it at/above MEV, say so — don't keep claiming "~target sets, holds
      // what you've built" when the plan is really giving it growth-range volume.
      const mev = muscleById.get(m)?.landmarks?.mev?.min;
      if (mev != null && proj >= mev) {
        r.reasons = [`~${proj} sets/wk — carried above pure maintenance by secondary work from your priority lifts (unavoidable, and fine); the recovery cost still falls mostly on the priorities`];
      }
      continue;
    }
    if (f === 0) {
      // Muscle not directly trained this split — it may still get secondary credit;
      // warn when even that indirect volume leaves it under MEV (so it won't grow).
      // But stay silent for a muscle no archetype can ever program (neck) unless the
      // user prioritised it — otherwise every plan nags to bolt on a niche muscle the
      // guided flow never trains, drowning the genuinely actionable warnings.
      const mev = muscleById.get(m)?.landmarks?.mev?.min;
      if (mev != null && proj < mev && (PROGRAMMABLE_MUSCLES.has(m) || priority.has(m)))
        warnings.push({ code: "below-mev-indirect", muscle: m, message: `${m} only gets ~${proj} indirect sets/wk (below MEV ${mev}) — add a direct ${m} exercise if you want it to grow.` });
      continue;
    }
    const hasExercise = compoundPool[m].length || isoPool[m].length;
    if (proj === 0 && !hasExercise) warnings.push({ code: "no-coverage", muscle: m, message: `No exercise trains ${m} with your equipment — add one (custom exercise) or broaden your equipment.` });
    else if (proj === 0) warnings.push({ code: "not-reached", muscle: m, message: `Direct ${m} work didn't fit your ${sessionMin}-min sessions — longer sessions or an extra day would add it.` });
    else if (r.projected_status === "over-MRV") warnings.push({ code: "over-mrv", muscle: m, message: `Projected ${proj} sets/wk is above MRV for ${m}.` });
    else if (proj < (muscleById.get(m)?.landmarks?.mev?.min ?? 0)) warnings.push({ code: "below-mev", muscle: m, message: `${m} gets ~${proj} sets/wk — below the ~${muscleById.get(m).landmarks.mev.min} it needs to grow. More days or longer sessions would fix it.` });
    // FREQUENCY CEILING (considerations #1, finding 1C). A muscle's weekly target is
    // split across the sessions that train it and capped at the session-quality
    // window, so `freq × perSessionCap` is the hard maximum this split can EVER
    // deliver. Above that, the plan silently under-delivers: an advanced side-delt
    // specialist targets mrv.max 26 but can only receive 2 × 10 = 20, and the
    // under-target warning never fires because 20 clears its 0.6 × 26 threshold.
    // The KB's weak-point page answers this directly — the priority muscle's
    // Frequency row reads "often bumped to ~3x/week" — and its frequency page says
    // "add a day rather than cramming". Say so, rather than quietly missing.
    else if (r.target_sets > (freq[m] ?? 0) * perSessionCap) warnings.push({ code: "frequency-capped", muscle: m,
      message: `${m} is targeted at ${r.target_sets} sets/wk, but ${freq[m]} session${(freq[m] ?? 0) === 1 ? "" : "s"} a week can only deliver about ${(freq[m] ?? 0) * perSessionCap} at quality — past roughly 10 hard sets for one muscle in a session, the later ones stop counting for much. The fix is another training day that hits it, not a longer session.` });
    else if (proj < r.target_sets * 0.6) warnings.push({ code: "under-target", muscle: m,
      // Priority-aware: a muscle you've ALREADY prioritised (or set as a
      // specialization target, whose ceiling is mrv.max and never fits under the
      // session-quality cap) must not be told to "mark it a priority" — it reads as
      // broken, contradictory coaching. Give the only real levers left instead.
      message: priority.has(m)
        ? `Only ~${proj} of a targeted ${r.target_sets} sets/wk fit for ${m} — its ceiling is more than these ${sessionSpecs.length} days can recover; an extra training day or longer sessions would close the gap.`
        : `Only ~${proj} of a targeted ${r.target_sets} sets/wk fit for ${m} — more days, or marking it a priority muscle in Settings, would close the gap.` });
  }

  const citations = [...new Set([...splitCites, ...exerciseChoices.flatMap((c) => c.citations), ...Object.values(volumeRationale).flatMap((r) => r.landmark?.citations ?? [])])];
  const goalLabel = { hypertrophy: "hypertrophy", strength: "strength", "fat-loss": "fat loss", recomposition: "recomposition" }[goal] ?? goal;
  const program = {
    id: "gen-" + seed.toString(36),
    name: `${split === "full-body" ? "Full Body" : split === "upper-lower" ? "Upper/Lower" : split === "push-pull-legs" ? "Push/Pull/Legs" : "Custom"} · ${sessionSpecs.length} days · ${goalLabel}`,
    split,
    days_per_week: sessionSpecs.length,
    experience_level: [experience],
    target_population: `Generated for a ${experience} lifter training ${sessionSpecs.length} days/week for ${goalLabel}${priority.size ? `, prioritizing ${[...priority].join(", ")}` : ""}.`,
    progression_ref: "double-progression",
    sessions: outSessions,
    ...(cardio ? { cardio } : {}),
    citations,
  };
  const rationale = {
    split: { choice: split, days_per_week: sessionSpecs.length, training_status: experience, reason: splitReason, citations: splitCites },
    goal_prescription: {
      primary_goal: goal, rep_scheme: scheme,
      // The bands the week REALLY runs, in session order, deduped. Equal to
      // [rep_scheme.compound[0]] unless daily undulation is active, in which case the
      // base scheme alone understates the single most advanced thing the engine does.
      compound_bands: [...new Set(compoundBands.filter(Boolean))],
      undulating,
      // The session ceiling, stated so the plan can explain itself: quality beats quantity.
      session_budget: { hard_sets: setBudget, minutes: sessionMin,
        reason: `Capped at ${setBudget} hard sets per session — per-set effort drops off well before time runs out, and spreading volume across sessions beats cramming it (see frequency).` },
    },
    volume_by_muscle: volumeRationale,
    frequency_by_muscle: Object.fromEntries(muscles.map((m) => [m.id, freq[m.id] ?? 0])),
    exercise_choices: exerciseChoices,
    warnings,
  };
  return { program, rationale, meta: { engine_version: "1.0.0", seed, generated_from: { days_per_week: sessionSpecs.length, training_status: experience, primary_goal: goal, available_equipment: [...equip], priority_muscles: [...priority], injuries } } };
}

// Critique any program (generated OR user-built) against the KB: per-muscle
// weekly volume vs MEV/MRV, missing major muscles, push/pull balance, and
// compound-before-isolation order. Reuses the SAME volume model as the tracker.
// WHAT YOUR ANSWERS CHANGED — the personalization, made visible.
//
// The engine already tailors hard: dumbbells-only shares only ~a third of its lifts
// with a full-gym plan, a strength goal rewrites every rep range, 30-minute sessions
// deliver 48 weekly sets where a 6-day week delivers 103. But NOTHING ever told the
// user that, so the honest report from the owner was "there's like 10 questions and
// the plans don't seem to change much" — invisible personalization is indistinguishable
// from none, and it costs exactly the trust the questions were asked to earn.
//
// Every line below is READ OUT OF the plan and its rationale — never re-derived, never
// asserted. If the engine stops doing a thing, the line describing it disappears with
// it, so this can't become the "we do X" comment that outlives X (lesson 11/15).
export function explainPersonalization(profile, rationale, program) {
  const out = [];
  const say = (input, answer, effect) => out.push({ input, answer, effect });
  const p = profile ?? {}, r = rationale ?? {};

  if (r.split?.reason) say("days_per_week", `${p.days_per_week} days a week`, r.split.reason);
  const budget = r.goal_prescription?.session_budget;
  if (budget?.hard_sets) {
    say("session_length_min", `${budget.minutes ?? p.session_length_min}-minute sessions`,
      `each session is capped at ${budget.hard_sets} hard sets — long enough to do the work, short enough that the last sets still count.`);
  }
  const scheme = r.goal_prescription?.rep_scheme;
  if (scheme?.compound) {
    // Read the bands the plan ACTUALLY shipped, not the base scheme it started from.
    // For an advanced hypertrophy lifter the generator undulates the compound band per
    // exposure and discards `rep_scheme.compound` — so quoting it here printed "6-10"
    // directly above a session list reading 4-6 / 6-10 / 10-15, on the one surface
    // built to prove the plan is honest (lesson 10), and understated the most advanced
    // personalization the engine performs on the very card meant to make it visible.
    // `compound_bands` is banked at generation time, so a rationale STORED BEFORE that
    // field existed doesn't have it — and `/api/plan/explain` reads the stored rationale
    // rather than regenerating, so those users would keep seeing the old, wrong single
    // band until their next block boundary. That is the fix having bounded reach, which
    // is lesson 37 recurring inside the wave that wrote lesson 37.
    //
    // The bands can't be recovered from the stored plan: the "light" undulation band is
    // 10-15, which collides with the isolation band, and a small split never uses all
    // three — so subtracting isolations from the shipped rep ranges is ambiguous, and
    // reconstructing all three would overstate. Verified before attempting it.
    //
    // So for a legacy rationale, say what is certainly true and invent no numbers:
    // `undulating` is a pure function of the profile, so we can always tell THAT the
    // week cycles even when we can't tell exactly which bands it landed on.
    const bands = r.goal_prescription.compound_bands?.length ? r.goal_prescription.compound_bands : null;
    const undulates = r.goal_prescription.undulating ?? undulatesForProfile(p);
    const compoundCopy = bands && bands.length > 1
      ? `compounds cycle ${bands.slice(0, -1).join(", ")} and ${bands[bands.length - 1]} reps across the week — each muscle gets a heavier and a lighter exposure instead of the same session twice`
      : !bands && undulates
        ? "compounds cycle through heavier and lighter rep ranges across the week — each muscle gets a different exposure each time rather than the same session twice"
        : `compounds run ${(bands ?? [scheme.compound[0]])[0]} reps at ${scheme.compound[1]} reps in reserve`;
    say("primary_goal", GOAL_LABEL[r.goal_prescription.primary_goal] ?? r.goal_prescription.primary_goal,
      `${compoundCopy}, isolations ${scheme.isolation?.[0]} at ${scheme.isolation?.[1]}.`);
  }

  // The priority answer is the one the owner flagged: it must show its own arithmetic.
  const priorities = p.priority_muscles ?? [];
  if (priorities.length) {
    const vol = r.volume_by_muscle ?? {};
    // `projected_sets` (what the week ACTUALLY delivers), never `target_sets` — the
    // target can exceed what the split can fit at quality (the engine's own
    // frequency-capped warning says so), and a card promising a number the plan
    // doesn't deliver is the derived-status-contradicting-reality trap, on the one
    // surface built to prove the plan is honest.
    const named = priorities.filter((m) => vol[m]).map((m) => `${MUSCLE_LABEL[m] ?? m} ${vol[m].projected_sets ?? vol[m].target_sets} sets/wk`);
    // `projected_sets > 0`, not just the `maintenance` flag — the same
    // what-the-week-DELIVERS rule the line above documents, applied to the count. `neck`
    // carries the flag but no session archetype trains it, so it projects 0 sets and its
    // own status reads "not-reached": a plan cannot hold at a maintenance dose something
    // it never doses. It was being counted, so this card claimed 15 muscles held when 14
    // were. Small, and exactly the kind of overstatement this card exists not to make.
    const held = Object.entries(vol)
      .filter(([, v]) => v.maintenance && (v.projected_sets ?? 0) > 0)
      .map(([m]) => MUSCLE_LABEL[m] ?? m);
    if (named.length) {
      say("priority_muscles", `you want to grow ${priorities.map((m) => MUSCLE_LABEL[m] ?? m).join(" and ")}`,
        held.length
          ? `${named.join(", ")} — pushed toward the ceiling, and ${held.length} other muscle${held.length === 1 ? "" : "s"} held at a maintenance dose to pay for the recovery it costs.`
          : `${named.join(", ")} — more volume than they'd otherwise get.`);
    }
  }

  const equip = p.available_equipment ?? [];
  if (equip.length && program?.sessions) {
    const lifts = new Set(program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)));
    say("available_equipment", equip.join(", "),
      `all ${lifts.size} exercises in your week are ones you can actually do with this.`);
  }

  const injuries = (p.injuries ?? []).map((i) => i.region).filter(Boolean);
  if (injuries.length) {
    say("injuries", `training around ${injuries.join(", ")}`,
      `movements that load ${injuries.length === 1 ? "it" : "them"} hardest are left out — the rest of your week is unchanged.`);
  }
  return out;
}
const GOAL_LABEL = {
  hypertrophy: "building muscle", strength: "getting stronger",
  "fat-loss": "losing fat while keeping muscle", recomposition: "recomposition",
  "general-fitness": "general fitness",
};
const MUSCLE_LABEL = {
  "upper-back": "upper back", "front-delts": "front delts", "side-delts": "side delts",
  "rear-delts": "rear delts", "spinal-erectors": "spinal erectors",
};

export function critiquePlan(program, kb, { experience = "intermediate" } = {}) {
  const { exercises, muscles } = kb;
  const exIndex = new Map(exercises.map((e) => [e.id, { name: e.name, primary: e.primary_muscles ?? [], secondary: e.secondary_muscles ?? [] }]));
  const muscleIndex = new Map(muscles.map((m) => [m.id, m.landmarks ?? null]));
  const muscleById = new Map(muscles.map((m) => [m.id, m]));
  const exById = new Map(exercises.map((e) => [e.id, e]));
  const name = (m) => muscleById.get(m)?.name ?? m;

  const pseudo = [{ date: "2026-01-05", sets: (program.sessions ?? []).flatMap((s) => (s.exercises ?? []).flatMap((e) => Array.from({ length: e.sets || 0 }, () => ({ exercise: e.exercise, set_type: "work" })))) }];
  const week = perMuscleWeeklyVolume(pseudo, exIndex);
  const wk = Object.keys(week)[0];
  const vol = wk ? week[wk] : {};
  const vsLm = wk ? volumeVsLandmarks(vol, muscleIndex) : {};

  const findings = [];
  const add = (severity, msg, extra = {}) => findings.push({ severity, msg, ...extra });

  // per-muscle vs landmarks
  for (const [m, r] of Object.entries(vsLm)) {
    const lm = muscleById.get(m)?.landmarks;
    if (!lm) continue;
    const grade = lm.evidence_grade || "C";
    if (r.status === "over-MRV") add("warn", `${name(m)}: ${r.sets} hard sets/wk is above MRV (~${lm.mrv.max}) — likely more than you can recover from. [Grade ${grade}]`, { muscle: m, citations: lm.citations ?? [] });
    else if (r.status === "below-MEV") {
      // A BEGINNER is deliberately built at ~MEV under a session-quality cap the
      // generator cannot exceed, so most muscles sit a little under MEV BY DESIGN.
      // Flagging that as a red "worth fixing" contradicts the app's own "your plan
      // is ready 🎉" and demoralizes the most fragile cohort — so for beginners a
      // modest shortfall is a gentle suggestion (info), and only a SEVERE one
      // (< 0.6×MEV, mirroring the generator's own under-target threshold) is a warn.
      // Intermediate/advanced genuinely need the volume, so below-MEV stays a warn.
      const severe = r.sets < lm.mev.min * 0.6;
      const soft = experience === "beginner" && !severe;
      add(soft ? "info" : "warn", `${name(m)}: ${r.sets} hard sets/wk is below MEV (~${lm.mev.min}) — ${soft ? "a little under the ideal, which is normal on a starter plan; you'll add more as you get more days or time" : "probably too little to grow it"}. [Grade ${grade}]`, { muscle: m, citations: lm.citations ?? [] });
    }
  }
  // major muscles with no volume
  const MAJOR = ["chest", "upper-back", "lats", "quadriceps", "hamstrings", "glutes", "side-delts"];
  for (const m of MAJOR) if (!(vol[m] > 0)) add("warn", `${name(m)}: no direct or indirect volume — a balanced plan trains every major muscle.`, { muscle: m });
  // push/pull balance
  const sum = (arr) => arr.reduce((a, m) => a + (vol[m] || 0), 0);
  const push = sum(["chest", "front-delts", "triceps"]), pull = sum(["upper-back", "lats", "rear-delts", "biceps"]);
  if (push > 0 && pull > 0) {
    if (push / pull > 1.5) add("info", `Push volume (${push.toFixed(1)}) is well above pull (${pull.toFixed(1)}) — add back/pull work to balance the shoulders.`);
    else if (pull / push > 1.5) add("info", `Pull volume (${pull.toFixed(1)}) is well above push (${push.toFixed(1)}) — add pressing to balance.`);
  }
  // compound-before-isolation order per session
  for (const s of program.sessions ?? []) {
    let seenIso = false;
    for (const e of s.exercises ?? []) {
      const ex = exById.get(e.exercise);
      if (!ex) continue;
      if (ex.mechanic === "isolation") seenIso = true;
      else if (seenIso) { add("info", `${s.name}: ${ex.name} (a compound) comes after an isolation — compounds usually go first while you're fresh.`, { session: s.name }); break; }
    }
  }

  const warns = findings.filter((f) => f.severity === "warn").length;
  const summary = warns === 0
    ? (findings.length ? "Solid plan — a couple of small tweaks below." : "This plan checks out against the KB — well balanced and in the productive volume ranges. 💪")
    : `${warns} thing${warns === 1 ? "" : "s"} worth fixing, plus a few suggestions.`;
  return { summary, findings, volume_by_muscle: Object.fromEntries(Object.entries(vsLm).map(([m, r]) => [m, { name: name(m), sets: r.sets, status: r.status }])) };
}
