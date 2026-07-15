#!/usr/bin/env node
// Derive-don't-ask engine (fs loaders + CLI). Pure functions live in ./derive-core.mjs and are re-exported here.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeatureReport } from "./derive-core.mjs";
export * from "./derive-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadExerciseIndex(dir = join(root, "data", "exercises")) {
  const idx = new Map();
  if (!existsSync(dir)) return idx;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const e = JSON.parse(readFileSync(join(dir, f), "utf8"));
    idx.set(e.id, {
      name: e.name,
      primary: e.primary_muscles ?? [],
      secondary: e.secondary_muscles ?? [],
    });
  }
  return idx;
}

export function loadMuscleIndex(dir = join(root, "data", "muscles")) {
  const idx = new Map();
  if (!existsSync(dir)) return idx;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8"));
    idx.set(m.id, m.landmarks ?? null);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// CLI demo over examples/
// ---------------------------------------------------------------------------
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

function runDemo() {
  const ex = loadExerciseIndex();
  const mu = loadMuscleIndex();
  const exDir = join(root, "examples");
  const profile = readJson(join(exDir, "onboarding-profile.example.json"));
  const sessions = readJson(join(exDir, "workout-log.example.json"));
  const checkins = readJson(join(exDir, "daily-checkins.example.json"));
  const bodyMetrics = readJson(join(exDir, "body-metrics.example.json"));
  const report = buildFeatureReport({ profile, sessions, checkins, bodyMetrics }, ex, mu);

  console.log("=== Derived feature report (demo-user-001) ===\n");
  console.log(`Goal: ${report.goal} | status: ${report.training_status}`);
  const t = report.bodyweight_trend;
  if (t) console.log(`Bodyweight trend: ${t.slope_kg_per_week >= 0 ? "+" : ""}${t.slope_kg_per_week} kg/wk (${t.pct_per_week}%/wk) over ${t.days} days`);
  console.log(`Energy balance: ${report.energy_balance.direction} — ${report.energy_balance.suggestion}`);
  if (report.readiness) console.log(`Readiness (latest, personal baseline): ${report.readiness.latest}/100`);
  console.log(`\nLatest week (${report.latest_week}) volume vs KB landmarks:`);
  for (const [m, v] of Object.entries(report.latest_week_vs_landmarks))
    console.log(`  ${m.padEnd(16)} ${String(v.sets).padStart(4)} sets  -> ${v.status}`);
  console.log(`\nProgression (est. 1RM change across log):`);
  for (const p of report.progression.slice(0, 6))
    console.log(`  ${p.name.padEnd(30)} ${p.first_e1rm} -> ${p.last_e1rm} kg  (${p.change_pct >= 0 ? "+" : ""}${p.change_pct}%)`);
  console.log("\n(full machine-readable report is the return value of buildFeatureReport)");
}

if (process.argv[1] && process.argv[1].endsWith("derive-metrics.mjs")) runDemo();

