// RESPONSE CORE — what the app learns about how ONE lifter responds (considerations iteration, Burst 10: "it learns
// you"). Pure, fs-free, Date.now/Math.random-free, like every engine here: the binder (app/src/coach.mjs) passes the
// priors in — the KB's session ceiling for the lifter's training age, the comeback gap — so it imports nothing.
import { repsEstimated, paceAggregate, restSeconds, restTier } from "./derive-core.mjs";

// THE SESSION CEILING (W315 — owner note 7: "I really start to struggle once I get past 12 sets in one workout and once
// I get to 16 sets I'm pretty empty. The app should be able to learn this from my data. Other users will be different.").
// The KB gives a ceiling by training age (frequency.md: ~12/16/20 hard sets a session [C], "add a day rather than
// cramming") — a population prior. A miss rate can't learn a person's from the log: aims already adapt to position and
// history, and the order is fixed, so a late lift that misses reads the same as a tired lifter. The evidence is the
// lifter's OWN fade signals instead (W314):
//   - an early end with work left, a skip in the last third of the planned sets, a too-tired moment — at the hard
//     sets done when it happened;
//   - "fading" or "empty" for the last few sets in the read-out — the fade began about there: the workout's sets less 2.
// A workout's fade point is the earliest of them. Over the last `window` workouts that can show one — not a deload week
// (every set planned easy), not the first back after a layoff, not one whose numbers were mostly estimates — a ceiling is
// proposed only when fades show in at least `minFades`: their median, never under `floor`, and only when it's under the
// KB's own (at or over it, the KB's already binds). Null otherwise — a lifter who doesn't fade never moves.
export const TOLERANCE_WINDOW = 8, TOLERANCE_MIN_FADES = 3, TOLERANCE_FLOOR = 10;
const work = (s) => (s?.sets ?? []).filter((x) => x && (x.set_type ?? "work") === "work");
export function fadePoint(session) {
  const n = work(session).length, points = [];
  for (const m of session?.fade_marks ?? []) {
    if (!Number.isInteger(m?.at)) continue;
    if (m.kind === "early" || m.kind === "tired") points.push(m.at);
    else if (m.kind === "skip" && Number.isInteger(m.of) && m.at >= (2 * m.of) / 3) points.push(m.at); // the last third only
  }
  if (session?.feel === "fading" || session?.feel === "empty") points.push(Math.max(1, n - 2));
  const p = points.filter((x) => x >= 1);
  return p.length ? Math.min(...p) : null;
}
export function sessionTolerance(sessions, { prior, comebackDays = 12, window = TOLERANCE_WINDOW, minFades = TOLERANCE_MIN_FADES, floor = TOLERANCE_FLOOR } = {}) {
  if (!Number.isFinite(prior)) return null;
  const dated = (sessions ?? []).filter((s) => s?.date && Number.isFinite(Date.parse(s.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || String(a.session_id ?? "").localeCompare(String(b.session_id ?? "")));
  const eligible = dated.filter((s, i) => {
    const w = work(s);
    if (!w.length) return false;
    if (w.every((x) => x.deload === true)) return false; // a deload week: every set planned easy
    if (w.filter(repsEstimated).length >= 0.3 * w.length) return false; // mostly guesses
    const prev = dated[i - 1];
    return !(prev && (Date.parse(s.date) - Date.parse(prev.date)) / 86400000 >= comebackDays); // the first back after a layoff
  }).slice(-window);
  const points = eligible.map(fadePoint).filter((x) => x != null);
  if (points.length < minFades) return null;
  const sorted = [...points].sort((a, b) => a - b), h = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
  const cap = Math.max(floor, Math.round(median));
  return cap < prior ? { cap, fades: points.length, eligible: eligible.length, points } : null;
}

// THE LIFTER'S OWN PACE (W316 — note 5's "60 minutes means 60 minutes", at THEIR pace): the time between their sets per
// rest tier, their lift changes and the time from start to first set, from the stamps every banked set carries
// (derive-core paceAggregate — the owner-only stats' own reader — on ONE lifter's log). A tier counts only once it has
// `minN` samples and a median a real workout has (a phone left on the bench is no pace); the KB-calibrated defaults
// (derive-core SESSION_PACE_DEFAULTS) stand in for the rest. Null with nothing to say. Rounded to whole seconds.
export const PACE_MIN_N = 12, PACE_MIN_LEADS = 6;
export function paceProfile(sessions, restTierOf, { minN = PACE_MIN_N, minLeads = PACE_MIN_LEADS } = {}) {
  const a = paceAggregate(sessions, restTierOf), out = {};
  const take = (key, x, n, lo, hi) => { if (x?.n >= n && x.median >= lo && x.median <= hi) out[key] = Math.round(x.median); };
  for (const t of ["heavy", "moderate", "isolation"]) take(t, a.between_sets_s?.[t], minN, 45, 600);
  take("transition", a.transition_s, minN, 30, 900);
  take("lead", a.start_to_first_set_s, minLeads, 0, 1800);
  return Object.keys(out).length ? out : null;
}


// REST THAT ADAPTS (W317 — owner note 1: "track the time between logged sets… use that data to maybe suggest longer or
// shorter rest times"). ONE step (30 s) from the KB's default for the lift's tier (derive-core restSeconds), never out of
// the KB's band (rest-periods.md: heavy multi-joint 2–3 min "sometimes more", moderate 1.5–2.5, isolation 1–2), always
// with its reason:
//   - LONGER [B — "rest until you can hit your target reps at the target effort"]: a set in the range, then the next one
//     under it, after a rest no longer than the timer that workout RAN (targets.rest_s, else the default) plus 30 s — in
//     `need` of the lift's last `window` workouts. A rest that ran longer and still fell short says rest isn't the lever.
//   - SHORTER [C — "shorter rests only to save time on lower-stakes accessory work"]: an isolation lift whose sets all held
//     the range in its last `window` workouts, while the workouts run past their minutes (`timeBinds`).
// Estimated counts and planned-easy sets are no evidence. Null when the KB's default stands. Pure.
export const REST_STEP_S = 30;
export const REST_BAND = { heavy: [120, 240], moderate: [90, 150], isolation: [60, 120] };
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
export function restAdapt(ex, sessions, { timeBinds = false, window = 3, need = 2 } = {}) {
  if (!ex?.id) return null;
  const tier = restTier(ex), base = restSeconds(ex), [lo, hi] = REST_BAND[tier] ?? [base, base];
  const real = (s) => (s?.sets ?? []).filter((x) => x?.exercise === ex.id && (x.set_type ?? "work") === "work" && !x.deload && !repsEstimated(x) && Number.isFinite(Date.parse(x.completed_at ?? "")));
  const recent = (sessions ?? []).filter((s) => s?.date && real(s).length).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(-window);
  if (recent.length < window) return null;
  let shows = 0, ranAt = base, held = true;
  for (const s of recent) {
    const t = (s.targets ?? []).find((x) => x?.exercise === ex.id);
    const m = /(\d+)\s*-\s*(\d+)/.exec(t?.rep_range ?? ""), min = m ? +m[1] : null;
    const timer = Number.isInteger(t?.rest_s) ? t.rest_s : base;
    const sets = real(s);
    if (min == null || sets.some((x) => x.reps < min)) held = false;
    let missed = false;
    for (let k = 1; k < sets.length; k++) {
      const gap = (Date.parse(sets[k].completed_at) - Date.parse(sets[k - 1].completed_at)) / 1000;
      if (min != null && sets[k - 1].reps >= min && sets[k].reps < min && gap > 0 && gap <= timer + REST_STEP_S) missed = true;
    }
    if (missed) { shows++; ranAt = timer; }
  }
  if (shows >= need && base + REST_STEP_S <= hi) {
    const r = base + REST_STEP_S;
    return { rest_s: r, reason: `Rest ${clock(r)} — your next set kept falling under the range after a ${clock(ranAt)} rest (${shows} of your last ${recent.length} workouts).` };
  }
  if (timeBinds && tier === "isolation" && held && base - REST_STEP_S >= lo) {
    const r = base - REST_STEP_S;
    return { rest_s: r, reason: `Rest ${clock(r)} — your sets held at ${clock(base)}, and your workouts run past your minutes.` };
  }
  return null;
}
