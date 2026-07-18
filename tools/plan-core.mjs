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

const REP_SCHEMES = {
  hypertrophy: { compound: ["6-10", "1-3"], isolation: ["10-15", "0-2"], priorityIso: ["12-20", "0-1"] },
  recomposition: { compound: ["6-10", "1-3"], isolation: ["10-15", "0-2"], priorityIso: ["12-20", "0-1"] },
  strength: { compound: ["3-6", "2-3"], isolation: ["6-10", "1-3"], priorityIso: ["8-12", "1-2"] },
  "fat-loss": { compound: ["8-12", "1-3"], isolation: ["12-20", "0-2"], priorityIso: ["12-20", "0-1"] },
};
const repScheme = (goal) => REP_SCHEMES[goal] ?? REP_SCHEMES.hypertrophy;

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
function rankPool(pool, { experience, seed, blockJitter = 0 }) {
  const diffRank = { beginner: 0, intermediate: 1, advanced: 2 };
  const userLvl = diffRank[experience] ?? 1;
  return [...pool]
    .map((e) => {
      let score = 0;
      if (e.lengthened_bias) score -= 2;                 // KB: bias toward lengthened loading
      const d = diffRank[e.difficulty] ?? 1;
      if (d > userLvl) score += 3 * (d - userLvl);       // too advanced → penalize
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
  const avail = exercises.filter((e) => equip.has(e.equipment) && !contraExcluded(e, injuries, contraindications));

  // 1) split
  const { split, sessions: sessionSpecs, reason: splitReason, citations: splitCites } = chooseSplit({ days_per_week: profile.days_per_week, training_status: experience });

  // 2) weekly target per muscle
  const targets = {};
  const volumeRationale = {};
  for (const m of muscles) {
    const t = targetWeeklySets(m.landmarks, { experience, isPriority: priority.has(m.id) });
    targets[m.id] = t.target;
    volumeRationale[m.id] = { target_sets: t.target, is_priority: priority.has(m.id), landmark: t.landmark, reasons: t.reasons };
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
        const maint = Math.max(2, Math.ceil(m.landmarks.mev.min / 2));
        targets[m.id] = maint;
        volumeRationale[m.id].target_sets = maint;
        volumeRationale[m.id].maintenance = true; // intentionally below MEV — holds muscle, frees recovery
        volumeRationale[m.id].reasons = [`maintenance during specialization (~${maint} sets holds what you've built)`];
      }
    }
  }

  // 3) how many sessions each muscle appears in (its frequency)
  const freq = {};
  for (const spec of sessionSpecs) for (const m of ARCH[spec.arch]) freq[m] = (freq[m] ?? 0) + 1;

  // pools per muscle (filtered + ranked), and a rotation counter for variety
  const compoundPool = {}, isoPool = {}, rot = {};
  for (const m of muscles) {
    // Difficulty is a HARD gate, not a soft penalty: rotation through a small pool
    // was handing pistol squats and Nordic curls to day-one beginners. Keep only
    // exercises at or below the user's level — falling back to the next tier up
    // ONLY when nothing easier trains the muscle (honest > empty).
    const diffRank = { beginner: 0, intermediate: 1, advanced: 2 };
    const userLvl = diffRank[experience] ?? 1;
    const gate = (pool) => {
      for (let lvl = userLvl; lvl <= 2; lvl++) {
        const ok = pool.filter((e) => (diffRank[e.difficulty] ?? 1) <= lvl);
        if (ok.length) return ok;
      }
      return pool;
    };
    compoundPool[m.id] = rankPool(gate(avail.filter((e) => e.mechanic === "compound" && (e.primary_muscles ?? []).includes(m.id))), { experience, seed });
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
  const outSessions = sessionSpecs.map((spec, sIdx) => {
    const mset = ARCH[spec.arch];
    const credited = {};      // effective sets credited to each muscle THIS session
    const placed = new Set(); // exercise ids already in this session
    const items = [];
    let setsUsed = 0;
    const room = () => setsUsed < setBudget && items.length < EX_BUDGET;
    const add = (ex, sets, forMuscle, why) => {
      if (placed.has(ex.id) || !room()) return false;
      const iso = ex.mechanic === "isolation";
      const s = iso ? (priority.has(forMuscle) ? scheme.priorityIso : scheme.isolation) : scheme.compound;
      const setN = clamp(Math.min(sets, EX_SET_CAP, setBudget - setsUsed), 1, 10);
      placed.add(ex.id); setsUsed += setN;
      items.push({ exercise: ex.id, sets: setN, rep_range: s[0], rir: s[1] });
      for (const m of ex.primary_muscles ?? []) credited[m] = (credited[m] ?? 0) + setN;
      for (const m of ex.secondary_muscles ?? []) credited[m] = (credited[m] ?? 0) + setN * 0.5;
      exerciseChoices.push({ exercise: ex.id, for_muscle: forMuscle, session: spec.name, sets: setN, rep_range: s[0], rir: s[1], why, difficulty: ex.difficulty, citations: ex.citations ?? [] });
      return true;
    };
    const perTarget = (m) => Math.ceil((targets[m] ?? 0) / Math.max(1, freq[m] ?? 1));
    // muscles this session trains, priority ones first so they win contested budget
    const order = [...PLACE_ORDER].filter((m) => mset.includes(m)).sort((a, b) => (priority.has(b) ? 1 : 0) - (priority.has(a) ? 1 : 0));

    // 4a0) PRIORITY muscles are served before anything else. Under a scarce
    // quality budget the general compound pass would otherwise consume every set
    // and an isolation-fed priority muscle (side-delts, biceps) would get scraps —
    // but "I especially want to grow X" is the user's most explicit instruction.
    for (const m of order) {
      if (!priority.has(m) || !room() || (credited[m] ?? 0) >= perTarget(m)) continue;
      const pool = compoundPool[m].length ? compoundPool[m] : isoPool[m];
      if (!pool.length) continue;
      const ex = pool[rot[m]++ % pool.length];
      add(ex, Math.min(perTarget(m), EX_SET_CAP), m, ["priority muscle — served first", ex.lengthened_bias ? "lengthened-biased" : "primary for " + m]);
    }
    // 4a) one compound per compound-driven muscle — but under a scarce quality
    // budget, cover every fundamental MOVEMENT PATTERN before doubling one. The
    // 12-set beginner budget was filling with squat+push+row+chin-up (two pulls)
    // and no hinge, leaving hamstrings untrained. Pass 0 serves unseen pattern
    // families; pass 1 doubles up only if budget remains.
    const famOf = (pat) =>
      pat === "squat" || pat === "lunge" ? "knee"
      : pat === "hinge" ? "hip"
      : pat === "horizontal-push" || pat === "vertical-push" ? "push"
      : pat === "horizontal-pull" || pat === "vertical-pull" ? "pull"
      : pat;
    const fams = new Set(items.map((it) => famOf(exById.get(it.exercise)?.movement_pattern)));
    const servedFor = new Set(exerciseChoices.filter((c) => c.session === spec.name).map((c) => c.for_muscle));
    for (const pass of [0, 1]) {
      for (const m of order) {
        if (!room() || (credited[m] ?? 0) >= perTarget(m) || !compoundPool[m].length) continue;
        const ex = compoundPool[m][rot[m] % compoundPool[m].length]; // peek (rotate only on placement)
        if (pass === 0 && fams.has(famOf(ex.movement_pattern))) continue;
        rot[m]++;
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
          const pool = compoundPool[m].length ? compoundPool[m] : isoPool[m];
          if (!pool.length) continue;
          let ex = null;
          for (let t = 0; t < pool.length; t++) {
            const cand = pool[(rot[m] + t) % pool.length];
            if (!placed.has(cand.id)) { ex = cand; rot[m] += t + 1; break; }
          }
          if (!ex) continue;
          if (add(ex, Math.min(3, Math.max(2, perTarget(m))), m, ["every muscle served before any doubles up", ex.lengthened_bias ? "lengthened-biased" : "primary for " + m])) {
            fams.add(famOf(ex.movement_pattern));
            servedFor.add(m);
          }
        }
      }
    }
    // 4b) up to 2 isolations per muscle fill the residual (per-exercise capped)
    for (const m of order) {
      for (let k = 0; k < 2; k++) {
        const residual = perTarget(m) - (credited[m] ?? 0);
        if (residual < 1 || !room() || !isoPool[m].length) break;
        let ex = null; // next un-placed isolation in the rotated pool
        for (let t = 0; t < isoPool[m].length; t++) {
          const cand = isoPool[m][(rot[m] + t) % isoPool[m].length];
          if (!placed.has(cand.id)) { ex = cand; rot[m] += t + 1; break; }
        }
        if (!ex) break;
        add(ex, clamp(round(residual), 1, EX_SET_CAP), m, ex.lengthened_bias ? ["fills residual volume", "lengthened-biased"] : ["fills residual volume for " + m]);
      }
    }
    // 4c) SUPERSET rescue for time-boxed sessions (KB: advanced-techniques —
    // "accents, not the meal"): if the budget is spent AND a muscle this session
    // trains is still short of target with an isolation available, pair ONE bonus
    // isolation (2 sets) with an existing NON-COMPETING isolation. Alternating
    // non-competing isolations costs roughly half the rest, so two paired sets
    // add ~2 minutes, not ~6 — honest time math for the lifter whose session
    // length is the binding constraint.
    if (setsUsed >= setBudget) {
      const isoItems = items.filter((it) => exById.get(it.exercise)?.mechanic === "isolation" && !it.superset_with);
      outer: for (const m of order) {
        if ((credited[m] ?? 0) >= perTarget(m) || !isoPool[m].length) continue;
        for (let t = 0; t < isoPool[m].length; t++) {
          const cand = isoPool[m][(rot[m] + t) % isoPool[m].length];
          if (placed.has(cand.id)) continue;
          const candMuscles = new Set([...(cand.primary_muscles ?? []), ...(cand.secondary_muscles ?? [])]);
          const partner = isoItems.find((it) => {
            const p = exById.get(it.exercise);
            return ![...(p.primary_muscles ?? []), ...(p.secondary_muscles ?? [])].some((mm) => candMuscles.has(mm));
          });
          if (!partner) continue;
          rot[m] += t + 1;
          const sN = 2;
          placed.add(cand.id); // NOTE: deliberately not counted in setsUsed — the pairing pays the time
          const sch = priority.has(m) ? scheme.priorityIso : scheme.isolation;
          items.push({ exercise: cand.id, sets: sN, rep_range: sch[0], rir: sch[1], superset_with: partner.exercise });
          partner.superset_with = cand.id;
          for (const mm of cand.primary_muscles ?? []) credited[mm] = (credited[mm] ?? 0) + sN;
          for (const mm of cand.secondary_muscles ?? []) credited[mm] = (credited[mm] ?? 0) + sN * 0.5;
          exerciseChoices.push({ exercise: cand.id, for_muscle: m, session: spec.name, sets: sN, rep_range: sch[0], rir: sch[1], why: ["superset — fits extra volume into your session length", "paired with " + partner.exercise], difficulty: cand.difficulty, citations: cand.citations ?? [] });
          break outer; // at most ONE rescue pair per session — an accent, not the meal
        }
      }
    }
    for (const c of exerciseChoices) if (c.session === spec.name) weekServed.add(c.for_muscle);
    // Emit compound-before-isolation (stable within each group): the 4a0 priority
    // pass reserves budget first, which is right — but a session should still READ
    // in the order you should lift it, and the app's own critique checks this.
    items.sort((a, b) => {
      const iso = (it) => (exById.get(it.exercise)?.mechanic === "isolation" ? 1 : 0);
      return iso(a) - iso(b);
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
    for (const s of outSessions) { const it = s.exercises.find((x) => primaryLoads(x) && isIso(x) && x.sets > 1); if (it) { it.sets--; trimmed = true; break; } }
    if (!trimmed) for (const s of outSessions) { const it = s.exercises.find((x) => primaryLoads(x) && x.sets > 1); if (it) { it.sets--; trimmed = true; break; } }
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
    if (f === 0) {
      // Muscle not directly trained this split — it may still get secondary credit;
      // warn when even that indirect volume leaves it under MEV (so it won't grow).
      const mev = muscleById.get(m)?.landmarks?.mev?.min;
      if (mev != null && proj < mev) warnings.push({ code: "below-mev-indirect", muscle: m, message: `${m} only gets ~${proj} indirect sets/wk (below MEV ${mev}) — add a direct ${m} exercise if you want it to grow.` });
      continue;
    }
    const hasExercise = compoundPool[m].length || isoPool[m].length;
    if (proj === 0 && !hasExercise) warnings.push({ code: "no-coverage", muscle: m, message: `No exercise trains ${m} with your equipment — add one (custom exercise) or broaden your equipment.` });
    else if (proj === 0) warnings.push({ code: "not-reached", muscle: m, message: `Direct ${m} work didn't fit your ${sessionMin}-min sessions — longer sessions or an extra day would add it.` });
    else if (r.projected_status === "over-MRV") warnings.push({ code: "over-mrv", muscle: m, message: `Projected ${proj} sets/wk is above MRV for ${m}.` });
    else if (r.maintenance) { r.projected_status = "maintenance"; } // intentionally low — holds muscle while the specialization runs
    else if (proj < (muscleById.get(m)?.landmarks?.mev?.min ?? 0)) warnings.push({ code: "below-mev", muscle: m, message: `${m} gets ~${proj} sets/wk — below the ~${muscleById.get(m).landmarks.mev.min} it needs to grow. More days or longer sessions would fix it.` });
    else if (proj < r.target_sets * 0.6) warnings.push({ code: "under-target", muscle: m, message: `Only ~${proj} of a targeted ${r.target_sets} sets/wk fit for ${m} — more days, or marking it a priority muscle in Settings, would close the gap.` });
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
export function critiquePlan(program, kb) {
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
    else if (r.status === "below-MEV") add("warn", `${name(m)}: ${r.sets} hard sets/wk is below MEV (~${lm.mev.min}) — probably too little to grow it. [Grade ${grade}]`, { muscle: m, citations: lm.citations ?? [] });
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
