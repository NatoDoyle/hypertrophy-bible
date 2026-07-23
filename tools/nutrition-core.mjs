// Pure nutrition engine (NO fs, no Date.now/Math.random) — the calorie/macro/TDEE
// core, portable to Node and Cloudflare Workers, deterministic. Ports the design
// of the user's tracking spreadsheet (Katch-McArdle base TDEE, adaptive TDEE from
// logged intake vs weight change, calorie target from a weekly weight-change goal,
// protein/fat/carb split), with the NUMBERS grounded in the KB's evidence where it
// has it (protein g/kg, deficit/surplus rates) rather than arbitrary constants.
//
// The app tracks nutrition as explicit calorie/macro targets + logging (a product
// decision to reverse the earlier "no calorie counting" stance): the engine gives
// the user targets to hit and, once they log intake and bodyweight for ~2 weeks,
// re-derives their REAL maintenance from the data (the formula is only a starting
// point; individual TDEE varies widely).

const KCAL_PER_KG = 7700;   // ~7700 kcal per kg of body mass (the deficit/surplus currency)
const KCAL_PER_LB = 3500;

// --- Body fat % via the U.S. Navy tape formula (optional; a user can enter BF%
// directly instead). height/neck/waist (and hip for women) in cm. Returns a
// percentage. This is a circumference ESTIMATE, not DEXA — good enough to seed TDEE.
export function navyBodyFat({ sex, height_cm, neck_cm, waist_cm, hip_cm }) {
  if (!height_cm || !neck_cm || !waist_cm) return null;
  const log10 = (x) => Math.log(x) / Math.LN10;
  let bf;
  if (sex === "female") {
    if (!hip_cm) return null;
    bf = 163.205 * log10(waist_cm + hip_cm - neck_cm) - 97.684 * log10(height_cm) - 78.387;
  } else {
    if (waist_cm - neck_cm <= 0) return null;
    bf = 86.010 * log10(waist_cm - neck_cm) - 70.041 * log10(height_cm) + 36.76;
  }
  return bf > 0 && bf < 75 ? Math.round(bf * 10) / 10 : null;
}

// --- Base TDEE (Katch-McArdle RMR × activity), the spreadsheet's formula.
// RMR = 370 + 21.6 × lean body mass(kg); LBM = weight × (1 − BF%/100). Activity
// multiplier defaults to ~1.5 ("moderately active" — a lifter with a normal job);
// the adaptive path below corrects individual error once real data exists.
export const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.5, active: 1.725, very_active: 1.9 };
export function baseTDEE({ weight_kg, bf_pct, activity = "moderate" }) {
  if (!(weight_kg > 0) || bf_pct == null || bf_pct < 0 || bf_pct >= 100) return null;
  const lbm = weight_kg * (1 - bf_pct / 100);
  const rmr = 370 + 21.6 * lbm;
  return Math.round(rmr * (ACTIVITY[activity] ?? 1.5));
}

// --- Adaptive TDEE from logged data (the spreadsheet's headline trick, and the
// honest way to find maintenance): TDEE = average daily intake − energy stored/lost.
// energy change = (weight change over the window, kg) × 7700, spread over the days.
// entries: [{ date, kcal, weight_kg }] — needs >=~10 days spanning a real weight
// trend to be trustworthy; returns null until then so the caller falls back to
// baseTDEE. `unit` "kg"|"lb" (weights are stored in the user's unit).
export function adaptiveTDEE(entries, { minDays = 10, unit = "kg" } = {}) {
  const withKcal = (entries ?? []).filter((e) => typeof e.kcal === "number" && e.kcal > 0 && e.date);
  const withWeight = (entries ?? []).filter((e) => typeof e.weight_kg === "number" && e.weight_kg > 0 && e.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (withKcal.length < minDays || withWeight.length < 2) return null;
  const avgIntake = withKcal.reduce((a, e) => a + e.kcal, 0) / withKcal.length;
  const first = withWeight[0], last = withWeight[withWeight.length - 1];
  const spanDays = Math.max(1, Math.round((+new Date(last.date) - +new Date(first.date)) / 86400000));
  const perKg = unit === "lb" ? KCAL_PER_LB : KCAL_PER_KG;
  const weightChangeEnergy = (last.weight_kg - first.weight_kg) * perKg; // + if gained
  // maintenance = what you ate minus what you banked (gain) / plus what you burned (loss)
  const tdee = avgIntake - weightChangeEnergy / spanDays;
  return tdee > 800 && tdee < 8000 ? Math.round(tdee) : null;
}

// --- Recommended weekly weight change (kg/week), KB-grounded (energy-balance +
// building-muscle-in-a-deficit): lean-gain ~0.1–0.5%/wk of bodyweight (slower as
// you advance), fat-loss a moderate ~0.5–1%/wk, recomposition/maintenance ~0.
// Returned as an absolute kg/week (sign: + gain, − loss).
export function recommendedWeeklyChange({ weight_kg, goal, training_status = "intermediate" }) {
  const w = weight_kg > 0 ? weight_kg : 80;
  const gainPct = { beginner: 0.005, intermediate: 0.0035, advanced: 0.002 }[training_status] ?? 0.0035; // % of bw/wk
  const lossPct = { beginner: 0.0075, intermediate: 0.0065, advanced: 0.005 }[training_status] ?? 0.0065;
  if (goal === "hypertrophy" || goal === "strength") return Math.round(w * gainPct * 100) / 100;
  if (goal === "fat-loss") return -Math.round(w * lossPct * 100) / 100;
  return 0; // recomposition / general-fitness / maintenance: hold
}

// --- Daily calorie target: maintenance ± the weekly goal spread over 7 days,
// floored so a target is never dangerously low.
export function calorieTarget({ tdee, weekly_change_kg = 0, unit = "kg", floor = 1500 }) {
  if (!(tdee > 0)) return null;
  const perKg = unit === "lb" ? KCAL_PER_LB : KCAL_PER_KG;
  return Math.max(floor, Math.round(tdee + (weekly_change_kg * perKg) / 7));
}

// --- Macro targets. Protein is KB-grounded and goal-aware: ~1.6 g/kg is the
// muscle-building ceiling at maintenance/surplus (protein.md, Grade A), but a
// DEFICIT protects lean mass better at ~2.0–2.4 g/kg (building-muscle-in-a-deficit,
// Grade B — the 2025 meta-regression found no plateau). Fat ~25% of calories
// (a middle of the 15–30% healthy band); carbs fill the remainder (fuel training).
export function macroTargets({ calories, weight_kg, goal, fat_pct = 0.25 }) {
  if (!(calories > 0) || !(weight_kg > 0)) return null;
  const proteinPerKg = goal === "fat-loss" ? 2.2 : 1.8; // deficit -> protect lean mass; else comfortably above the 1.6 ceiling
  const protein_g = Math.round(weight_kg * proteinPerKg);
  const fat_g = Math.round((calories * fat_pct) / 9);
  const carbs_g = Math.max(0, Math.round((calories - protein_g * 4 - fat_g * 9) / 4));
  return { protein_g, fat_g, carbs_g, protein_per_kg: proteinPerKg };
}

// --- Assemble the whole plan from a profile (+ optional logged history for the
// adaptive TDEE). Returns targets the UI shows and the "why". `history` is the
// [{date,kcal,weight_kg}] log; when it has enough data the maintenance estimate
// switches from formula to data-derived.
export function nutritionPlan(profile, history = []) {
  const { weight_kg, bf_pct, sex, goal = "hypertrophy", training_status = "intermediate", activity = "moderate", unit = "kg" } = profile ?? {};
  if (!(weight_kg > 0) || bf_pct == null) return null;
  const base = baseTDEE({ weight_kg, bf_pct, activity });
  const adaptive = adaptiveTDEE(history, { unit });
  const tdee = adaptive ?? base;
  const weekly_change_kg = recommendedWeeklyChange({ weight_kg, goal, training_status });
  const calories = calorieTarget({ tdee, weekly_change_kg, unit });
  const macros = macroTargets({ calories, weight_kg, goal });
  return {
    tdee, tdee_basis: adaptive ? "logged" : "estimated", base_tdee_estimate: base,
    weekly_change_kg, calorie_target: calories, ...macros,
    note: adaptive
      ? `Maintenance re-estimated from your logged food and weight: ~${tdee} kcal/day.`
      : `Starting maintenance estimate ~${tdee} kcal/day — log food + weight for ~2 weeks and I'll dial it in to your real numbers.`,
  };
}
