// RESPONSE CORE — what the app learns about how ONE lifter responds (considerations iteration, Burst 10: "it learns
// you"). Pure, fs-free, Date.now/Math.random-free, like every engine here: the binder (app/src/coach.mjs) passes the
// priors in — the KB's session ceiling for the lifter's training age, the comeback gap — so it imports nothing.
import { repsEstimated } from "./derive-core.mjs";

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
