#!/usr/bin/env node
// Data-layer referential integrity: every cross-reference between data files must resolve.
//
// FAILS (exit 1) on:
//   - a program's session exercise that resolves to no exercise (by id, slugified name, or alias)
//   - a program's progression_ref that matches no progression id
//   - an exercise's primary/secondary muscle that matches no muscle id
// WARNS on:
//   - a muscle with zero primary exercises (coverage gap)
//   - a program exercise matched by name/alias rather than a direct id (portability nudge)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function loadDir(name) {
  const dir = join(dataDir, name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

const exercises = loadDir("exercises");
const muscles = loadDir("muscles");
const programs = loadDir("programs");
const progressions = loadDir("progressions");

const muscleIds = new Set(muscles.map((m) => m.id));
const progressionIds = new Set(progressions.map((p) => p.id));

// Exercise resolution index: id (exact) + slugified name/aliases -> exercise id
const exerciseIds = new Set(exercises.map((e) => e.id));
const exerciseBySlug = new Map();
for (const e of exercises) {
  exerciseBySlug.set(e.id, e.id);
  exerciseBySlug.set(slug(e.name), e.id);
  for (const a of e.aliases ?? []) exerciseBySlug.set(slug(a), e.id);
}
function resolveExercise(ref) {
  if (exerciseIds.has(ref)) return { id: ref, byId: true };
  const hit = exerciseBySlug.get(slug(ref));
  return hit ? { id: hit, byId: false } : null;
}

let errors = 0;
const warn = [];
const primaryCount = new Map(muscleIds.size ? [...muscleIds].map((id) => [id, 0]) : []);

// Exercises -> muscle refs
for (const e of exercises) {
  for (const key of ["primary_muscles", "secondary_muscles"]) {
    for (const m of e[key] ?? []) {
      if (!muscleIds.has(m)) {
        console.error(`  ✗ exercise '${e.id}': ${key} '${m}' matches no muscle`);
        errors++;
      }
    }
  }
  for (const m of e.primary_muscles ?? []) {
    if (primaryCount.has(m)) primaryCount.set(m, primaryCount.get(m) + 1);
  }
  // The plan engine reads the boolean `lengthened_bias`; `loading_bias` is the
  // richer reader-facing field. They must not disagree — a lengthened_bias:true
  // exercise whose loading_bias says "shortened" would train the opposite of what
  // the engine thinks it does.
  if (e.loading_bias != null && e.lengthened_bias != null) {
    const shouldBe = e.loading_bias === "lengthened";
    if (e.lengthened_bias !== shouldBe) {
      console.error(`  ✗ exercise '${e.id}': lengthened_bias (${e.lengthened_bias}) disagrees with loading_bias ('${e.loading_bias}')`);
      errors++;
    }
  }
}

// Programs -> exercise + progression refs
for (const p of programs) {
  if (p.progression_ref && !progressionIds.has(p.progression_ref)) {
    console.error(`  ✗ program '${p.id}': progression_ref '${p.progression_ref}' matches no progression`);
    errors++;
  }
  for (const s of p.sessions ?? []) {
    for (const ex of s.exercises ?? []) {
      const r = resolveExercise(ex.exercise);
      if (!r) {
        console.error(`  ✗ program '${p.id}' / ${s.name}: exercise '${ex.exercise}' resolves to nothing`);
        errors++;
      } else if (!r.byId) {
        warn.push(`  ⚠ program '${p.id}': '${ex.exercise}' matched by name → id '${r.id}' (consider referencing the id)`);
      }
    }
  }
}

// Coverage warnings
for (const [id, c] of primaryCount) {
  if (c === 0) warn.push(`  ⚠ muscle '${id}' has no primary exercise (coverage gap)`);
}

// Coverage matrix: every muscle should have a primary exercise for each realistic
// equipment set, so the plan engine never has to leave a muscle untrained.
// full-gym coverage is REQUIRED (fails); the two limited sets warn. A few gaps are
// legitimately impossible (no pure-bodyweight side-delt exercise exists) — allowlist them.
const cell = new Map([...muscleIds].map((m) => [m, {}]));
for (const e of exercises) for (const m of e.primary_muscles ?? []) if (cell.has(m)) cell.get(m)[e.equipment] = (cell.get(m)[e.equipment] ?? 0) + 1;
const EQUIP_SETS = {
  "full-gym": ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  "dumbbell-only": ["dumbbell", "bodyweight"],
  "bodyweight": ["bodyweight"],
};
const ALLOW_UNCOVERED = { "full-gym": ["neck"], "dumbbell-only": ["neck"], "bodyweight": ["neck", "side-delts"] };
for (const [setName, eq] of Object.entries(EQUIP_SETS)) {
  for (const m of muscleIds) {
    if (ALLOW_UNCOVERED[setName].includes(m)) continue;
    const covered = eq.some((e) => (cell.get(m)[e] ?? 0) > 0);
    if (covered) continue;
    if (setName === "full-gym") { console.error(`  ✗ coverage: muscle '${m}' has no primary exercise for a full gym`); errors++; }
    else warn.push(`  ⚠ coverage: muscle '${m}' has no primary exercise for '${setName}'`);
  }
}

// Beginner reachability: a muscle whose ONLY exercise for an equipment set is
// advanced forces the plan engine's difficulty fallback to hand a day-one novice
// an advanced movement (this shipped: Nordic curls were the sole bodyweight
// hamstring option). Warn so the gap gets an easier variant, not a silent pass.
for (const [setName, eq] of Object.entries(EQUIP_SETS)) {
  for (const m of muscleIds) {
    if (ALLOW_UNCOVERED[setName].includes(m)) continue;
    const pool = exercises.filter((e) => (e.primary_muscles ?? []).includes(m) && eq.includes(e.equipment));
    if (pool.length && !pool.some((e) => (e.difficulty ?? "intermediate") !== "advanced")) {
      warn.push(`  ⚠ beginner-reachability: every '${setName}' exercise for '${m}' is advanced (${pool.map((e) => e.id).join(", ")}) — add an easier variant`);
    }
  }
}

for (const w of warn) console.warn(w);
console.log(
  `\n${exercises.length} exercises, ${muscles.length} muscles, ${programs.length} programs checked. ${errors} error(s), ${warn.length} warning(s).`
);
process.exit(errors ? 1 : 0);
