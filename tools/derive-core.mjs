// Pure derive-metrics core (NO fs) — the single source of truth for the derivation logic,
// shared by tools/derive-metrics.mjs (adds fs loaders + CLI) and app/ (portable to Cloudflare Workers).

// ---------------------------------------------------------------------------
// Core derivations
// ---------------------------------------------------------------------------

// Estimated 1RM (Epley). Reliability drops as reps rise, so we flag it.
export function estimate1RM(weightKg, reps) {
  if (reps <= 0 || weightKg <= 0) return { e1rm: 0, confidence: "none" };
  const e1rm = reps === 1 ? weightKg : weightKg * (1 + reps / 30);
  const confidence = reps <= 10 ? "high" : reps <= 15 ? "moderate" : "low";
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
    const wk = isoWeekKey(s.date);
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
  let direction;
  if (pct > 0.1) direction = "surplus";
  else if (pct < -0.1) direction = "deficit";
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
  for (const s of sessions) {
    const wk = isoWeekKey(s.date);
    for (const set of s.sets ?? []) {
      // Reliable rep ranges only — otherwise a light high-rep back-off set shows
      // up as a strength GAIN, and this screen contradicts the session recap.
      if (!countsForE1RM(set)) continue;
      const { e1rm } = estimate1RM(set.weight_kg, set.reps);
      byEx[set.exercise] ??= {};
      byEx[set.exercise][wk] = Math.max(byEx[set.exercise][wk] ?? 0, e1rm);
    }
  }
  const out = [];
  for (const [ex, weekMap] of Object.entries(byEx)) {
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
  for (const s of sessions) {
    const wk = isoWeekKey(s.date);
    for (const set of s.sets ?? []) {
      if (!countsForE1RM(set) || set.deload) continue;
      const { e1rm } = estimate1RM(set.weight_kg, set.reps);
      byEx[set.exercise] ??= {};
      byEx[set.exercise][wk] = Math.max(byEx[set.exercise][wk] ?? 0, e1rm);
    }
  }
  const out = [];
  for (const [ex, weekMap] of Object.entries(byEx)) {
    const weeks = Object.keys(weekMap).sort();
    if (weeks.length < minWeeks) continue;
    const recent = weeks.slice(-minWeeks).map((w) => weekMap[w]);
    const hi = Math.max(...recent), lo = Math.min(...recent);
    // Flat = the whole recent window sits inside the noise band AND the latest
    // week is STRICTLY below the window's best. If the newest week ties or sets
    // the best, the lifter is still nudging up — slow progress is not a plateau.
    // (The original `< hi + 0.01` was a tautology: the latest week is <= hi by
    // definition, so steady +0.5/wk progress inside the band got flagged.)
    const flat = hi > 0 && ((hi - lo) / hi) * 100 <= noisePct && recent[recent.length - 1] < hi - 0.01;
    if (flat) out.push({ exercise: ex, name: exIndex.get(ex)?.name ?? ex, weeks_flat: minWeeks, best_e1rm: hi });
  }
  return out;
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
