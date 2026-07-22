// The generative training-plan engine — pure, deterministic, fs-free (runs in
// the Cloudflare Worker bundle and in Node). Turns a profile + the knowledge
// base (volume landmarks + exercise database) into a concrete weekly program
// PLUS a machine-readable rationale that explains every decision from the KB.
//
// Currency is EFFECTIVE weekly hard sets (primary muscle = 1.0/set, secondary =
// 0.5/set) — the exact same model as derive-core's perMuscleWeeklyVolume, which
// we reuse for a closed-loop self-check so plan-time and log-time volume agree.
import { perMuscleWeeklyVolume, volumeVsLandmarks } from "./derive-core.mjs";

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

// RIR: isolations run 0-1 across all growth goals — the KB's proximity-to-failure
// page (Grade B): "take isolation and machine work to 0-1 RIR (where failure is
// safe and cheap)"; heavy compounds keep 1-3 to protect technique and recovery.
// Strength keeps a deliberate extra reserve on accessories (fatigue budget goes
// to the heavy lifts, where the goal lives).
const REP_SCHEMES = {
  hypertrophy: { compound: ["6-10", "1-3"], isolation: ["10-15", "0-1"], priorityIso: ["12-20", "0-1"], pumpIso: ["12-20", "0-1"] },
  recomposition: { compound: ["6-10", "1-3"], isolation: ["10-15", "0-1"], priorityIso: ["12-20", "0-1"], pumpIso: ["12-20", "0-1"] },
  strength: { compound: ["3-6", "2-3"], isolation: ["6-10", "1-3"], priorityIso: ["8-12", "1-2"], pumpIso: ["10-15", "1-2"] },
  "fat-loss": { compound: ["8-12", "1-3"], isolation: ["12-20", "0-1"], priorityIso: ["12-20", "0-1"], pumpIso: ["15-20", "0-1"] },
};
const repScheme = (goal) => REP_SCHEMES[goal] ?? REP_SCHEMES.hypertrophy;

// Small muscles whose isolation work runs higher-rep "pump" ranges in practice.
// This is the KB's own guidance (intensity page: hypertrophy is load-flexible
// ~5-30 reps near failure; "isolation and machine work often going a bit higher,
// ~12-20... very light high reps for small muscles and finishing work") — a
// practical time/joint-stress choice, NOT a fiber-type responsiveness claim
// (the KB grades muscle-specific rep-range claims as weak). Matches how every
// current top-level program runs laterals/rear-delts/calves/abs/forearms.
const PUMP_MUSCLES = new Set(["side-delts", "rear-delts", "calves", "abs", "forearms", "neck"]);

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
  sessions.forEach((s) => { s.name = label[s.arch] + (multi[s.arch] > 1 ? " " + "ABCDEF"[s.letter - 1] : ""); });
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
function rankPool(pool, { experience, seed, blockJitter = 0 }) {
  const diffRank = { beginner: 0, intermediate: 1, advanced: 2 };
  const userLvl = diffRank[experience] ?? 1;
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
      score += (((seed ^ hashStr(e.id)) + blockJitter * 2654435761) % 100) / 1000; // deterministic jitter; blockJitter rotates ties each mesocycle
      return { e, score };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.e);
}
function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

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

export function generatePlan(profile, kb, opts = {}) {
  const { exercises, muscles, contraindications } = kb;
  const experience = profile.training_status ?? "intermediate";
  const goal = profile.primary_goal ?? "hypertrophy";
  const priority = new Set(profile.priority_muscles ?? []);
  const injuries = profile.injuries ?? [];
  const equip = new Set(profile.available_equipment ?? ["barbell", "dumbbell", "machine", "cable", "bodyweight"]);
  const seed = seedFromProfile(profile);
  const specialization = !!profile.specialization; // all-in block: priorities to the ceiling, the rest to maintenance
  const blockIndex = opts.blockIndex ?? 0;         // rotates ACCESSORIES each mesocycle; compounds stay stable
  const compoundSets = experience === "advanced" ? 4 : 3;
  const perSessionCap = opts.perMuscleSessionCap ?? 10;
  const scheme = repScheme(goal);

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
    compoundPool[m.id] = rankPool(gate(avail.filter((e) => e.mechanic === "compound" && (e.primary_muscles ?? []).includes(m.id))), { experience, seed });
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
    isoPool[m.id] = rankPool(gate(avail.filter((e) => e.mechanic === "isolation" && (e.primary_muscles ?? []).includes(m.id))), { experience, seed, blockJitter: blockIndex });
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
  const weekServed = new Set(); // muscles with a direct exercise ANYWHERE this week
  const weekUseCount = {};      // exercise id → sessions used this week (variety: cap at 2)
  let weekKneeFlexion = false;  // has ANY session placed knee-flexion hamstring work yet?
  const outSessions = sessionSpecs.map((spec, sIdx) => {
    const mset = ARCH[spec.arch];
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
      const s = iso ? (priority.has(forMuscle) ? scheme.priorityIso : PUMP_MUSCLES.has(forMuscle) ? scheme.pumpIso : scheme.isolation) : scheme.compound;
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
    const priorityBudget = Math.max(compoundSets + 1, Math.ceil(setBudget / 2));
    for (const m of order) {
      if (!priority.has(m) || setsUsed >= priorityBudget || (credited[m] ?? 0) >= perTarget(m)) continue;
      const pool = poolFor(m);
      if (!pool.length) continue;
      const ex = pickFrom(pool, m);
      if (ex) add(ex, Math.min(perTarget(m), 3, EX_SET_CAP), m, ["priority muscle — served first", ex.lengthened_bias ? "lengthened-biased" : "primary for " + m]);
    }

    // 4a¼) WEEKLY COVERAGE FLOOR: before this session doubles up on big muscles,
    // every muscle it trains that NO session has served yet this week gets one
    // exercise (~2 sets). One 16-set session can't serve 11 muscles, but the week
    // must — abs/calves were getting zero all week on 2-day splits (last in
    // PLACE_ORDER), and specialization-maintenance muscles were dropping to zero
    // rather than their maintenance floor. Runs BEFORE pattern-coverage doubling.
    for (const m of order) {
      if (weekServed.has(m) || (credited[m] ?? 0) >= perTarget(m) || !room()) continue;
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
        if (residual < 1 || !room()) break;
        if (topUp(m, residual)) continue;
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
          const sch = priority.has(m) ? scheme.priorityIso : PUMP_MUSCLES.has(m) ? scheme.pumpIso : scheme.isolation; // same band logic as add()
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
        const tier = x.mechanic === "isolation" ? 3 : x.cns_cost === "high" ? 0 : x.cns_cost === "moderate" ? 1 : 2;
        const pri = (x.primary_muscles ?? []).some((m) => priority.has(m)) ? 0 : 1;
        return tier * 2 + pri;
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
    citations,
  };
  const rationale = {
    split: { choice: split, days_per_week: sessionSpecs.length, training_status: experience, reason: splitReason, citations: splitCites },
    goal_prescription: {
      primary_goal: goal, rep_scheme: scheme,
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
