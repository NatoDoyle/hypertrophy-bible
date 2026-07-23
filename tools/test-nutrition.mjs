// Nutrition-core tests. Validates the engine against the SOURCE SPREADSHEET's own
// computed values (weight 85.9 kg, BF% 15, male, intermediate) so the port is
// faithful, plus the KB-grounded macro/rate logic. Zero deps; no Date.now.
import assert from "node:assert/strict";
import { navyBodyFat, baseTDEE, adaptiveTDEE, recommendedWeeklyChange, calorieTarget, macroTargets, nutritionPlan } from "./nutrition-core.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)); };

// --- base TDEE reproduces the spreadsheet's Katch-McArdle formula exactly ---
// (370 + 21.6 × 85.9×0.85) × 1.5 = 2920.686 in the sheet (cell AN22).
ok("baseTDEE matches the sheet's sample (85.9kg, 15% BF, moderate) ≈ 2921", baseTDEE({ weight_kg: 85.9, bf_pct: 15, activity: "moderate" }) === 2921);
ok("baseTDEE scales with activity", baseTDEE({ weight_kg: 85.9, bf_pct: 15, activity: "sedentary" }) < baseTDEE({ weight_kg: 85.9, bf_pct: 15, activity: "active" }));
ok("baseTDEE rejects nonsense", baseTDEE({ weight_kg: 0, bf_pct: 15 }) === null && baseTDEE({ weight_kg: 80, bf_pct: 120 }) === null);

// --- Navy BF% (male, height 176, neck 38, waist 85 → a plausible ~15–20%) ---
const bf = navyBodyFat({ sex: "male", height_cm: 176, neck_cm: 38, waist_cm: 88 });
ok("navyBodyFat returns a plausible male BF%", bf > 8 && bf < 30);
ok("navyBodyFat needs the female hip measure", navyBodyFat({ sex: "female", height_cm: 165, neck_cm: 32, waist_cm: 74 }) === null);
ok("navyBodyFat guards degenerate input", navyBodyFat({ sex: "male", height_cm: 176, neck_cm: 90, waist_cm: 80 }) === null);

// --- adaptive TDEE from logged data: ate 3000/day, lost 0.5 kg over 14 days ---
// maintenance = 3000 − (−0.5 × 7700)/14 = 3000 + 275 = 3275
const hist = [];
for (let d = 0; d < 14; d++) hist.push({ date: `2026-06-${String(d + 1).padStart(2, "0")}`, kcal: 3000, weight_kg: 85 - d * (0.5 / 13) });
const at = adaptiveTDEE(hist, { unit: "kg" });
// lost 0.5 kg over the 13-day span while eating 3000/day → maintenance is HIGHER
// than intake: 3000 + (0.5 × 7700)/13 ≈ 3296.
ok("adaptiveTDEE = avg intake minus stored/lost energy (~3296 for the loss case)", at > 3000 && Math.abs(at - 3296) <= 5);
ok("adaptiveTDEE returns null below the data threshold", adaptiveTDEE(hist.slice(0, 5)) === null);

// --- recommended weekly change: gain for muscle (slower when advanced), loss for fat-loss, 0 for recomp ---
ok("lean-gain rate is positive and slows with training age",
  recommendedWeeklyChange({ weight_kg: 80, goal: "hypertrophy", training_status: "beginner" }) >
  recommendedWeeklyChange({ weight_kg: 80, goal: "hypertrophy", training_status: "advanced" }) &&
  recommendedWeeklyChange({ weight_kg: 80, goal: "hypertrophy", training_status: "advanced" }) > 0);
ok("fat-loss rate is negative", recommendedWeeklyChange({ weight_kg: 80, goal: "fat-loss" }) < 0);
ok("recomposition holds at zero", recommendedWeeklyChange({ weight_kg: 80, goal: "recomposition" }) === 0);

// --- calorie target: maintenance ± the weekly goal / 7, floored ---
ok("a surplus goal raises the target above TDEE", calorieTarget({ tdee: 2900, weekly_change_kg: 0.28 }) > 2900);
ok("a deficit goal lowers it below TDEE", calorieTarget({ tdee: 2900, weekly_change_kg: -0.5 }) < 2900);
ok("the floor protects against a dangerous target", calorieTarget({ tdee: 1200, weekly_change_kg: -1 }) === 1500);

// --- macros: protein KB-grounded and goal-aware, carbs fill the remainder ---
const mMaint = macroTargets({ calories: 2900, weight_kg: 85, goal: "hypertrophy" });
const mCut = macroTargets({ calories: 2200, weight_kg: 85, goal: "fat-loss" });
ok("maintenance protein sits comfortably above the 1.6 g/kg ceiling (1.8)", mMaint.protein_per_kg === 1.8 && mMaint.protein_g === 153);
ok("a deficit raises protein to protect lean mass (2.2 g/kg)", mCut.protein_per_kg === 2.2 && mCut.protein_g === 187);
ok("macros account for the whole calorie budget (±a rounding kcal)",
  Math.abs((mMaint.protein_g * 4 + mMaint.fat_g * 9 + mMaint.carbs_g * 4) - 2900) <= 6);

// --- full plan assembly ---
const planEst = nutritionPlan({ weight_kg: 85.9, bf_pct: 15, sex: "male", goal: "hypertrophy", training_status: "intermediate" });
ok("nutritionPlan (no history) uses the ESTIMATED basis", planEst.tdee_basis === "estimated" && planEst.tdee === 2921);
ok("nutritionPlan returns a full target set", planEst.calorie_target > 0 && planEst.protein_g > 0 && planEst.carbs_g >= 0 && /log food/.test(planEst.note));
const planLogged = nutritionPlan({ weight_kg: 85, bf_pct: 15, sex: "male", goal: "hypertrophy", training_status: "intermediate" }, hist);
ok("nutritionPlan switches to the LOGGED basis once enough data exists", planLogged.tdee_basis === "logged");
ok("nutritionPlan returns null on incomplete stats", nutritionPlan({ weight_kg: 85 }) === null);
ok("#49 an impossible body-fat % yields no plan (never a '~null kcal/day' plan)", nutritionPlan({ weight_kg: 80, bf_pct: 100, sex: "male" }) === null);
ok("#49 a plausible high body-fat still computes a real plan", nutritionPlan({ weight_kg: 120, bf_pct: 45, sex: "male" })?.calorie_target > 0);

console.log(`\n${pass} nutrition test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
