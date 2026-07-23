// Pure derive-metrics core (NO fs) — the single source of truth for the derivation logic,
// shared by tools/derive-metrics.mjs (adds fs loaders + CLI) and app/ (portable to Cloudflare Workers).

// ---------------------------------------------------------------------------
// Core derivations
// ---------------------------------------------------------------------------

// Estimated 1RM (Epley). Reliability drops as reps rise, so we flag it.
export function estimate1RM(weightKg, reps) {
  if (reps <= 0 || weightKg <= 0) return { e1rm: 0, confidence: "none" };
  const e1rm = reps === 1 ? weightKg : weightKg * (1 + reps / 30);
  // Epley's error grows past ~5-6 reps (at 10 reps the estimate is already a 33%
  // extrapolation above the load lifted), so the "high" band is honest only up to
  // ~6. Labels only — e1rm values and countsForE1RM (RELIABLE_1RM_REPS=12) unchanged.
  const confidence = reps <= 6 ? "high" : reps <= 10 ? "moderate" : "low";
  return { e1rm: Math.round(e1rm * 100) / 100, confidence };
}

// Above this rep count the Epley estimate is guesswork: a deliberately light
// 20-rep back-off set "beats" a genuinely heavier triple. Anything that reports
// strength (PRs, progression trends) MUST filter through countsForE1RM so the
// surfaces can never disagree — this constant is the single source of truth.
export const RELIABLE_1RM_REPS = 12;
export const countsForE1RM = (set) =>
  (set.set_type ?? "work") !== "warmup" &&
  typeof set.reps === "number" && set.reps > 0 && set.reps <= RELIABLE_1RM_REPS &&
  typeof set.weight_kg === "number" && set.weight_kg > 0;

// ISO week key "YYYY-Www" for grouping weekly volume.
export function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// A session's week key, preferring the device's local calendar day but falling
// back to the UTC `date` if local_date is malformed (an "NaN-WNaN" key sorts
// after every real ISO week and would hijack the "latest week" logic — and a
// bad string can arrive from any client, since auth is possession-of-UUID).
export const sessionWeekKey = (s) => {
  const k = isoWeekKey(s.local_date ?? s.date);
  return k.includes("NaN") ? isoWeekKey(s.date) : k;
};

// Is a set a "hard working set" that counts toward hypertrophy volume?
// Warm-ups never count. If effort is logged, it must be near failure (RPE>=gate / RIR<=4).
// If effort is NOT logged, a work set counts (we don't penalize missing data).
export function isHardSet(set, { hardSetRpe = 7 } = {}) {
  const type = set.set_type ?? "work";
  if (type === "warmup") return false;
  if (typeof set.rpe === "number" && set.rpe < hardSetRpe) return false;
  if (typeof set.rir === "number" && set.rir > 4) return false;
  return true;
}

// Per-muscle effective weekly volume (hard sets). Primary muscle = 1.0 set,
// secondary = fractional (default 0.5). This is THE model's currency.
export function perMuscleWeeklyVolume(sessions, exIndex, opts = {}) {
  const secondaryWeight = opts.secondaryWeight ?? 0.5;
  const weeks = {};
  for (const s of sessions) {
    const wk = sessionWeekKey(s);
    weeks[wk] ??= {};
    for (const set of s.sets ?? []) {
      if (!isHardSet(set, opts)) continue;
      const ex = exIndex.get(set.exercise);
      if (!ex) continue; // unknown/custom exercise: skip rather than guess
      for (const m of ex.primary) weeks[wk][m] = (weeks[wk][m] ?? 0) + 1;
      for (const m of ex.secondary) weeks[wk][m] = (weeks[wk][m] ?? 0) + secondaryWeight;
    }
  }
  // round fractional sums to 1dp
  for (const wk of Object.keys(weeks))
    for (const m of Object.keys(weeks[wk]))
      weeks[wk][m] = Math.round(weeks[wk][m] * 10) / 10;
  return weeks;
}

// Compare a week's per-muscle volume against the KB's MEV/MAV/MRV landmarks.
// This is the loop that ties raw logs back to the graded knowledge base.
export function volumeVsLandmarks(weekVolume, muscleIndex) {
  const out = {};
  for (const [muscle, sets] of Object.entries(weekVolume)) {
    const lm = muscleIndex.get(muscle);
    if (!lm) { out[muscle] = { sets, status: "no-landmark" }; continue; }
    const mevMin = lm.mev?.min, mavMax = lm.mav?.max, mrvMax = lm.mrv?.max;
    let status;
    if (mevMin != null && sets < mevMin) status = "below-MEV";
    else if (mrvMax != null && sets > mrvMax) status = "over-MRV";
    else if (mavMax != null && sets > mavMax) status = "approaching-MRV";
    else status = "in-productive-range";
    out[muscle] = { sets, status, mev: lm.mev, mav: lm.mav, mrv: lm.mrv };
  }
  return out;
}

// ADAPTIVE VOLUME RESPONSE — the foundation of the self-learning plan. For each
// trained muscle it combines the user's CURRENT weekly volume (vs the KB MEV/MAV/MRV
// landmarks) with whether a lift for that muscle has STALLED, into an honest,
// data-driven "do you need more/less volume here?" signal. Two hard safety rails:
// (1) it is COACHING ONLY — the caller surfaces it as advice and never auto-applies
// it silently; (2) every suggestion is bounded by the recoverable range — it never
// pushes a target above MAV.max, and once a muscle is stalled AT its ceiling it says
// "change/deload", not "add more", so volume can never run away.
// `weekVolume` is { muscleId: sets } (effective sets); `stalledMuscleIds` is the set
// of muscle ids whose primary lift stallDetect flagged. Returns one entry per muscle.
export function volumeResponse(weekVolume, muscleIndex, stalledMuscleIds = new Set()) {
  const out = [];
  for (const [m, sets] of Object.entries(weekVolume)) {
    const lm = muscleIndex.get(m);
    if (!lm || lm.mev?.min == null || lm.mav?.max == null || lm.mrv?.max == null) continue;
    const mevMin = lm.mev.min, mavMax = lm.mav.max, mrvMax = lm.mrv.max;
    const stalled = stalledMuscleIds.has(m);
    let signal, advice;
    if (sets < mevMin) {
      signal = "add";
      advice = `only ~${sets} sets/wk — below the ~${mevMin} it needs to grow. Add sets.`;
    } else if (sets > mrvMax) {
      signal = "reduce";
      advice = `~${sets} sets/wk is above your recoverable ceiling (~${mrvMax}) — trim a set or two.`;
    } else if (stalled && sets < mavMax) {
      signal = "add";
      advice = `progress has stalled and you're at ~${sets} of a possible ${mavMax} productive sets — try adding ~2 sets here.`;
    } else if (stalled) {
      signal = "change";
      advice = `stalled near your recoverable ceiling (~${mrvMax}) — a deload or a different exercise will help more than piling on volume.`;
    } else {
      signal = "hold";
      advice = `~${sets} sets/wk, progressing in a productive range — hold here.`;
    }
    out.push({ muscle: m, sets, signal, advice });
  }
  // Surface the actionable ones first (add/reduce/change before hold).
  const rank = { reduce: 0, change: 1, add: 2, hold: 3 };
  return out.sort((a, b) => (rank[a.signal] - rank[b.signal]) || (b.sets - a.sets));
}

// AUTO-TUNE: turn the per-muscle response into a persistent volume ADJUSTMENT the
// plan applies next block. This is the actual "learn from the data it's fed" step
// (#2): a muscle that keeps stalling with headroom gets more sets over time; one
// stalled at its recoverable ceiling (or over it) gets eased. Gentle and bounded:
// ±2 sets per block, ACCUMULATED across blocks (so a persistent responder keeps
// climbing until it responds or hits the ceiling), and each muscle's total delta is
// clamped to its own MEV↔MRV range so volume can never run away. Below-MEV is NOT a
// response signal (it's a plan-fit/time constraint, surfaced as a warning), so it
// never drives an adjustment. `prevAdjust` is the accumulated map so far (or {}).
// `context` (Increment A) carries a recovery/energy read: `{ underRecovered,
// inDeficit }`. A stall while persistently under-recovered or in an energy deficit
// is a recovery/fuel problem, not a volume one — adding sets you can't recover makes
// it worse — so the "add volume" response is SUPPRESSED then (the muscle holds).
// Easing (over-ceiling, stalled-at-ceiling) always still fires: pulling back is safe
// regardless of recovery. Absent context → permissive (add allowed), so existing
// callers/behaviour are unchanged. See docs/adaptive-algorithm.md.
export function deriveVolumeAdjust(prevAdjust, weekVolume, muscleIndex, stalledMuscleIds = new Set(), context = {}) {
  const out = { ...(prevAdjust || {}) };
  const canAdd = !(context.underRecovered || context.inDeficit);
  for (const [m, sets] of Object.entries(weekVolume || {})) {
    const lm = muscleIndex.get(m);
    if (!lm || lm.mev?.min == null || lm.mav?.max == null || lm.mrv?.max == null) continue;
    let step = 0;
    if (sets > lm.mrv.max) step = -2;                                              // over the ceiling → ease
    else if (stalledMuscleIds.has(m)) step = sets < lm.mav.max ? (canAdd ? 2 : 0) : -2; // stalled: add if room AND recovered, else hold/ease
    // not stalled and within range → progressing fine → hold (no change)
    const prev = prevAdjust?.[m] ?? 0;
    const range = lm.mrv.max - lm.mev.min;
    const next = Math.max(-range, Math.min(range, prev + step));
    if (next === 0) delete out[m]; else out[m] = next;
  }
  return out;
}

// Block-level recovery read for the auto-tune. Manual check-ins score 1-5 on
// sleep_quality/energy/mood/motivation and stress (inverted, so a calm 1 → 5). The
// block AVERAGE sitting below the neutral midpoint — with enough check-ins that it's
// a real trend, not one bad night — means recovery, not volume, is the limiter.
// Energy deficit is read from the bodyweight trend (a precomputed classifyEnergyBalance
// object). Both gate "add volume" in deriveVolumeAdjust. Pure: everything is passed in
// as data (no fs, no Date.now). Absent/insufficient data → not-under-recovered (the
// tune stays as capable as before; recovery only ever RESTRAINS adding, never forces).
export function recoverySignal(checkins = [], energyBalance = null, { minCheckins = 4, lowThreshold = 2.6 } = {}) {
  const scores = [];
  for (const c of checkins || []) {
    const parts = [];
    if (typeof c.sleep_quality === "number") parts.push(c.sleep_quality);
    if (typeof c.energy === "number") parts.push(c.energy);
    if (typeof c.mood === "number") parts.push(c.mood);
    if (typeof c.motivation === "number") parts.push(c.motivation);
    if (typeof c.stress === "number") parts.push(6 - c.stress); // low stress = high recovery
    if (parts.length) scores.push(parts.reduce((a, b) => a + b, 0) / parts.length);
  }
  const n = scores.length;
  const avgReadiness = n ? Math.round((scores.reduce((a, b) => a + b, 0) / n) * 100) / 100 : null;
  const underRecovered = n >= minCheckins && avgReadiness != null && avgReadiness <= lowThreshold;
  const inDeficit = energyBalance?.direction === "deficit";
  return { underRecovered, inDeficit, avgReadiness, n };
}

// Bodyweight trend via least-squares regression (kg/week). Daily weight is noise;
// the slope of the trend is the signal — and doubles as the energy-balance sensor.
export function bodyweightTrend(series) {
  const pts = series
    .filter((p) => p.date && typeof p.bodyweight_kg === "number")
    .map((p) => ({ t: new Date(p.date).getTime() / 86400000, w: p.bodyweight_kg }))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 3) return null;
  const n = pts.length;
  const t0 = pts[0].t;
  const xs = pts.map((p) => p.t - t0);
  const ys = pts.map((p) => p.w);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slopePerDay = den === 0 ? 0 : num / den;
  const slopePerWeek = slopePerDay * 7;
  const avgW = my;
  return {
    n,
    days: xs[n - 1] - xs[0],
    avg_kg: Math.round(avgW * 100) / 100,
    slope_kg_per_week: Math.round(slopePerWeek * 1000) / 1000,
    pct_per_week: Math.round((slopePerWeek / avgW) * 10000) / 100,
  };
}

// Infer energy-balance direction from the weight trend + goal. No calorie counting.
export function classifyEnergyBalance(trend, goal) {
  if (!trend) return { direction: "unknown", note: "need >=3 bodyweight points" };
  const pct = trend.pct_per_week;
  // Boundaries are INCLUSIVE and match the goal-branch thresholds below (which
  // treat pct===0.1 as on-target lean-gain): a hair over 0.1%/wk is a small
  // surplus, so `direction` must not say "maintenance" while the advice says
  // "lean-gain on target" — the two fields were computed with `>` vs `>=`.
  let direction;
  if (pct >= 0.1) direction = "surplus";
  else if (pct <= -0.1) direction = "deficit";
  else direction = "maintenance";

  const wantsGain = goal === "hypertrophy" || goal === "strength";
  const wantsLoss = goal === "fat-loss";
  const wantsHold = goal === "recomposition" || goal === "general-fitness";

  let matchesGoal, suggestion;
  if (wantsGain) {
    if (direction === "deficit") { matchesGoal = false; suggestion = "Goal is muscle gain but you're losing weight — add ~200-300 kcal/day."; }
    else if (pct > 0.5) { matchesGoal = "partly"; suggestion = "Gaining fast (>0.5%/wk); trim the surplus to keep gains leaner."; }
    else if (pct >= 0.1) { matchesGoal = true; suggestion = "Lean-gain rate looks on target (~0.1-0.5%/wk)."; }
    else { matchesGoal = "partly"; suggestion = "Roughly maintaining; a small surplus (~+150-300 kcal) would speed gaining."; }
  } else if (wantsLoss) {
    if (direction === "surplus") { matchesGoal = false; suggestion = "Goal is fat loss but you're gaining — increase the deficit."; }
    else if (pct < -1.0) { matchesGoal = "partly"; suggestion = "Losing fast (>1%/wk); ease the deficit to protect muscle."; }
    else if (direction === "deficit") { matchesGoal = true; suggestion = "Fat-loss rate looks appropriate."; }
    else { matchesGoal = "partly"; suggestion = "Maintaining; a moderate deficit is needed to lose fat."; }
  } else {
    // recomposition / general
    matchesGoal = direction === "maintenance" ? true : "partly";
    suggestion = direction === "maintenance" ? "Weight stable — good for recomposition." : `Trending toward ${direction}; hold closer to maintenance for recomp.`;
  }
  return { direction, rate_pct_per_week: pct, matchesGoal, suggestion };
}

// Progression per exercise: best est-1RM per week and the change across the log.
export function progressionByExercise(sessions, exIndex) {
  const byEx = {};
  const byExLoad = {}; // pump-band lifts (reps > RELIABLE_1RM_REPS): track weekly best LOAD, same as stallDetect
  for (const s of sessions) {
    const wk = sessionWeekKey(s);
    for (const set of s.sets ?? []) {
      // Reliable rep ranges only — otherwise a light high-rep back-off set shows
      // up as a strength GAIN, and this screen contradicts the session recap.
      // Deload weeks are eased ~10% ON PURPOSE, so their e1RM must NOT anchor the
      // trend — otherwise the block-ending recovery week reads as a fabricated ~10%
      // strength LOSS, shown precisely when the coach copy says growth shows up.
      // (Mirrors stallDetect and suggestWeight, which both already exclude deloads —
      // this was the one "deload-aware progression" sibling the guard missed.)
      if (set.deload) continue;
      if (countsForE1RM(set)) {
        const { e1rm } = estimate1RM(set.weight_kg, set.reps);
        byEx[set.exercise] ??= {};
        byEx[set.exercise][wk] = Math.max(byEx[set.exercise][wk] ?? 0, e1rm);
      } else if ((set.set_type ?? "work") !== "warmup" && typeof set.reps === "number" && set.reps > RELIABLE_1RM_REPS && typeof set.weight_kg === "number" && set.weight_kg > 0) {
        // Without this path, a lifter's laterals/calves (the plan's own 12-20
        // band) never chart at all — "Your lifts" showed only the heavy work.
        byExLoad[set.exercise] ??= {};
        byExLoad[set.exercise][wk] = Math.max(byExLoad[set.exercise][wk] ?? 0, set.weight_kg);
      }
    }
  }
  const out = [];
  // Basis by MAJORITY of weeks, not all-time existence: one grinding 12-rep set
  // (the BOTTOM of the plan's own 12-20 band) used to route an exercise into the
  // e1RM path forever, hiding its entire load history — the exact "never charted
  // at all" bug this path exists to fix. Ties go to e1RM (the stronger signal).
  for (const [ex, weekMap] of Object.entries(byExLoad)) {
    if (Object.keys(byEx[ex] ?? {}).length >= Object.keys(weekMap).length) continue; // e1RM covers it
    const weeks = Object.keys(weekMap).sort();
    const first = weekMap[weeks[0]], last = weekMap[weeks[weeks.length - 1]];
    out.push({
      exercise: ex, name: exIndex.get(ex)?.name ?? ex, weeks: weeks.length,
      first_load_kg: first, last_load_kg: last, basis: "load",
      change_pct: first ? Math.round(((last - first) / first) * 10000) / 100 : 0,
    });
  }
  for (const [ex, weekMap] of Object.entries(byEx)) {
    if (Object.keys(byExLoad[ex] ?? {}).length > Object.keys(weekMap).length) continue; // the load row above covers it
    const weeks = Object.keys(weekMap).sort();
    const first = weekMap[weeks[0]], last = weekMap[weeks[weeks.length - 1]];
    out.push({
      exercise: ex,
      name: exIndex.get(ex)?.name ?? ex,
      weeks: weeks.length,
      first_e1rm: first,
      last_e1rm: last,
      change_pct: first ? Math.round(((last - first) / first) * 10000) / 100 : 0,
    });
  }
  return out.sort((a, b) => b.change_pct - a.change_pct);
}

// Plateau detection: an exercise is STALLED when its best weekly e1RM has been
// flat (within a noise band) for >= minWeeks consecutive training weeks. The
// data always existed (progressionByExercise); nothing consumed it — a stalled
// bench got "add a rep" forever. Deload-tagged sets are excluded (an easy week
// is planned recovery, not a plateau).
export function stallDetect(sessions, exIndex, { minWeeks = 4, noisePct = 2.5 } = {}) {
  const byEx = {};
  const byExLoad = {}; // high-rep (pump-band) work: > RELIABLE_1RM_REPS, where Epley is guesswork — track best LOAD instead
  for (const s of sessions) {
    const wk = sessionWeekKey(s);
    for (const set of s.sets ?? []) {
      if (set.deload) continue;
      if (countsForE1RM(set)) {
        const { e1rm } = estimate1RM(set.weight_kg, set.reps);
        byEx[set.exercise] ??= {};
        byEx[set.exercise][wk] = Math.max(byEx[set.exercise][wk] ?? 0, e1rm);
      } else if ((set.set_type ?? "work") !== "warmup" && typeof set.reps === "number" && set.reps > RELIABLE_1RM_REPS && typeof set.weight_kg === "number" && set.weight_kg > 0) {
        // The plan itself prescribes 12-20 (pump band) — without this path a
        // lateral-raise plateau was invisible to every progression surface.
        byExLoad[set.exercise] ??= {};
        byExLoad[set.exercise][wk] = Math.max(byExLoad[set.exercise][wk] ?? 0, set.weight_kg);
      }
    }
  }
  // Stalled = the recent window sits inside the noise band AND shows NO net
  // progress across it (the latest week is not meaningfully above the earliest).
  // This flags the textbook plateau (identical numbers every week: latest ==
  // earliest) and shallow declines, while still exempting genuine slow progress
  // (latest clearly above earliest). Two earlier versions each missed one end:
  // `< hi + 0.01` was a tautology (flagged everyone); `< hi - 0.01` missed the
  // dead-flat plateau (latest ties the max). Compare ends, not to the max.
  const flatWindow = (weekMap) => {
    const weeks = Object.keys(weekMap).sort();
    if (weeks.length < minWeeks) return null;
    const recent = weeks.slice(-minWeeks).map((w) => weekMap[w]);
    const hi = Math.max(...recent), lo = Math.min(...recent);
    const flat = hi > 0 && ((hi - lo) / hi) * 100 <= noisePct && recent[recent.length - 1] <= recent[0] + 0.01;
    return flat ? hi : null;
  };
  const out = [];
  for (const [ex, weekMap] of Object.entries(byEx)) {
    const hi = flatWindow(weekMap);
    if (hi != null) out.push({ exercise: ex, name: exIndex.get(ex)?.name ?? ex, weeks_flat: minWeeks, best_e1rm: hi });
  }
  for (const [ex, weekMap] of Object.entries(byExLoad)) {
    // Majority-of-weeks rule (mirrors progressionByExercise): a single reliable
    // low-rep week must not blind the load path to a 4-week pump plateau.
    if (Object.keys(byEx[ex] ?? {}).length >= Object.keys(weekMap).length) continue;
    const hi = flatWindow(weekMap);
    if (hi != null) out.push({ exercise: ex, name: exIndex.get(ex)?.name ?? ex, weeks_flat: minWeeks, best_load_kg: hi, basis: "load" });
  }
  return out;
}

// The individual's demonstrated progression CADENCE: the typical number of training
// weeks between meaningful improvements on their own lifts. People progress at wildly
// different rates — some PR every fortnight, others over months of consistency — so a
// fixed "4 flat weeks = stalled" churns a slow-but-real responder's program before it
// pays off, and destroys the very consistency that was about to work. This LEARNS the
// personal rhythm from logged data so the stall window can scale to it (see
// adaptiveStallWindow). Returns null until there's a real track record (then the caller
// falls back to the KB default). Pure; deload sets excluded (planned easy weeks aren't
// plateaus). Gaps are in PRESENT training weeks, matching how stallDetect slices its
// window — a missed week isn't a training week. See docs/adaptive-algorithm.md.
// `minGaps` = how many demonstrated improvement INTERVALS are needed before we trust a
// personal cadence. One real PR interval is already strong evidence a lifter is slow, and
// because the window only ever STRETCHES patience (never shrinks below the floor), acting
// on a single interval is low-risk and recognises a slow responder a full PR-cycle sooner
// — the sim (scripts/sim-adaptive.mjs) showed a 6-week responder was otherwise bumped
// twice before the rhythm locked. Zero intervals (a brand-new/flat history) still → null.
export function progressionCadence(sessions, exIndex, { noisePct = 2.5, minGaps = 1 } = {}) {
  const byEx = {};      // reliable-rep e1RM, weekly best
  const byExLoad = {};  // pump-band (high-rep) load, weekly best — Epley is guesswork there
  for (const s of sessions) {
    const wk = sessionWeekKey(s);
    for (const set of s.sets ?? []) {
      if (set.deload) continue;
      if (countsForE1RM(set)) {
        const { e1rm } = estimate1RM(set.weight_kg, set.reps);
        (byEx[set.exercise] ??= {})[wk] = Math.max(byEx[set.exercise][wk] ?? 0, e1rm);
      } else if ((set.set_type ?? "work") !== "warmup" && typeof set.reps === "number" && set.reps > RELIABLE_1RM_REPS && typeof set.weight_kg === "number" && set.weight_kg > 0) {
        (byExLoad[set.exercise] ??= {})[wk] = Math.max(byExLoad[set.exercise][wk] ?? 0, set.weight_kg);
      }
    }
  }
  const gaps = [];
  const collect = (weekMap) => {
    const weeks = Object.keys(weekMap).sort();
    if (weeks.length < 2) return;
    let lastBest = weekMap[weeks[0]], lastImproveIdx = 0;
    for (let i = 1; i < weeks.length; i++) {
      if (weekMap[weeks[i]] > lastBest * (1 + noisePct / 100)) { // a real improvement beyond the noise band
        gaps.push(i - lastImproveIdx);                           // training weeks since the last improvement
        lastBest = weekMap[weeks[i]]; lastImproveIdx = i;
      }
    }
  };
  for (const m of Object.values(byEx)) collect(m);
  for (const m of Object.values(byExLoad)) collect(m);
  if (gaps.length < minGaps) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2; // median gap (robust to outliers)
}

// Turn a personal progression cadence into the stall window — how many FLAT training
// weeks count as a plateau for THIS person. Bounded so it can never get LESS patient
// than the KB default (floor): a false "stalled" churns a program that's actually
// working, which is the costlier error, so we only ever STRETCH patience for a
// demonstrated slow responder, never shrink it below the reliable-signal minimum. And
// never past a ceiling (even a slow responder's truly dead lift warrants a look). Null
// cadence (too little data) → the default. Pure.
export function adaptiveStallWindow(cadence, { floor = 4, ceiling = 10, factor = 1.5 } = {}) {
  if (cadence == null || !(cadence > 0)) return floor;
  return Math.max(floor, Math.min(ceiling, Math.round(cadence * factor)));
}

// Rest times derived from set timestamps (never asked). Returns avg seconds per exercise.
export function restTimes(session) {
  const byEx = {};
  const sets = (session.sets ?? []).filter((s) => s.completed_at);
  for (let i = 1; i < sets.length; i++) {
    if (sets[i].exercise !== sets[i - 1].exercise) continue;
    const dt = (new Date(sets[i].completed_at) - new Date(sets[i - 1].completed_at)) / 1000;
    if (dt <= 0 || dt > 1800) continue;
    (byEx[sets[i].exercise] ??= []).push(dt);
  }
  const out = {};
  for (const [ex, arr] of Object.entries(byEx))
    out[ex] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  return out;
}

// Infer proximity-to-failure objectively from rep drop-off at a fixed load
// (bypasses unreliable self-reported RIR). Returns a heuristic per exercise.
export function proximityFromRepDropoff(session) {
  const byExLoad = {};
  for (const set of session.sets ?? []) {
    if ((set.set_type ?? "work") !== "work") continue;
    const key = `${set.exercise}@${set.weight_kg}`;
    (byExLoad[key] ??= []).push(set.reps);
  }
  const out = {};
  for (const [key, reps] of Object.entries(byExLoad)) {
    if (reps.length < 2) continue;
    const drop = reps[0] - reps[reps.length - 1];
    out[key] = {
      reps,
      rep_dropoff: drop,
      inferred: drop >= 2 ? "trained-close-to-failure" : drop === 1 ? "moderate-proximity" : "left-reps-in-reserve",
    };
  }
  return out;
}

// Readiness relative to the user's OWN baseline (z-scores), not absolute values —
// the correct way to use HRV/sleep. 0-100, higher = more recovered. Null if no data.
export function readinessIndex(checkins) {
  const rows = checkins.filter((c) => c.hrv_ms != null || c.sleep_hours != null);
  if (rows.length < 3) return null;
  const stat = (key, invert = false) => {
    const vals = rows.map((r) => r[key]).filter((v) => typeof v === "number");
    if (vals.length < 3) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    return { mean, sd, invert };
  };
  const specs = { hrv_ms: stat("hrv_ms"), sleep_hours: stat("sleep_hours"), resting_hr: stat("resting_hr", true), stress: stat("stress", true) };
  const score = (c) => {
    let z = 0, w = 0;
    const weights = { hrv_ms: 0.4, sleep_hours: 0.3, resting_hr: 0.2, stress: 0.1 };
    for (const [k, s] of Object.entries(specs)) {
      if (!s || typeof c[k] !== "number") continue;
      let zk = (c[k] - s.mean) / s.sd;
      if (s.invert) zk = -zk;
      z += weights[k] * zk; w += weights[k];
    }
    if (w === 0) return null;
    const norm = z / w; // ~z-score
    return Math.max(0, Math.min(100, Math.round(50 + norm * 20)));
  };
  const latest = rows[rows.length - 1];
  return { latest: score(latest), latest_date: latest.date, method: "personal-baseline z-score" };
}

// Confidence tier for a metric, from its provenance.
export function confidenceTier(source) {
  if (source === "wearable" || source === "smart-scale") return "high";
  if (source === "manual") return "moderate";
  return "low";
}

// ---------------------------------------------------------------------------
// The full feature report an autoregulator / ML model consumes for one user.
// ---------------------------------------------------------------------------
export function buildFeatureReport({ profile, sessions = [], checkins = [], bodyMetrics = [] }, exIndex, muscleIndex) {
  const weekly = perMuscleWeeklyVolume(sessions, exIndex);
  const weeks = Object.keys(weekly).sort();
  const latestWeek = weeks[weeks.length - 1];
  const bwSeries = [...checkins, ...bodyMetrics].filter((r) => r.bodyweight_kg != null).map((r) => ({ date: r.date, bodyweight_kg: r.bodyweight_kg }));
  const trend = bodyweightTrend(bwSeries);
  return {
    user_id: profile?.user_id ?? null,
    goal: profile?.primary_goal ?? null,
    training_status: profile?.training_status ?? null,
    weekly_volume_by_muscle: weekly,
    latest_week: latestWeek ?? null,
    latest_week_vs_landmarks: latestWeek ? volumeVsLandmarks(weekly[latestWeek], muscleIndex) : {},
    bodyweight_trend: trend,
    energy_balance: classifyEnergyBalance(trend, profile?.primary_goal),
    progression: progressionByExercise(sessions, exIndex),
    readiness: readinessIndex(checkins),
    rest_times_latest_session: sessions.length ? restTimes(sessions[sessions.length - 1]) : {},
    proximity_latest_session: sessions.length ? proximityFromRepDropoff(sessions[sessions.length - 1]) : {},
  };
}
