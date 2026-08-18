#!/usr/bin/env node
// The SHIPPED bundle, asserted — not the generator's intentions.
//
// app/public/learn-data.js is auto-generated and precached by the service worker,
// so a predicate change that silently stopped matching would ship a page whose
// buttons had all quietly become plain text again, and the HTML would look fine.
// These read the built artifact.
import assert from "node:assert";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileStore } from "../src/store.mjs";
import { createApp } from "../src/app.mjs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");
const { LEARN_PAGES, LEARN_EXERCISES } = await import(join(here, "../public/learn-data.js"));

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); }
};

const EX_ON_DISK = new Set(readdirSync(join(ROOT, "data", "exercises")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
const allButtons = () => Object.entries(LEARN_PAGES).flatMap(([slug, pg]) =>
  [...pg.html.matchAll(/data-ex="([a-z0-9-]+)"/g)].map((m) => [slug, m[1]]));

check("the bundle ships an exercise sheet set", () => {
  assert.ok(LEARN_EXERCISES && typeof LEARN_EXERCISES === "object");
  assert.equal(Object.keys(LEARN_EXERCISES).length, 64, "only the referenced ids are bundled — all 171 would cost ~235 KB raw against ~87 KB");
  for (const id of Object.keys(LEARN_EXERCISES)) assert.ok(EX_ON_DISK.has(id), `bundled sheet ${id} has no data file`);
});

check("every rendered button can open a sheet — no button opens a blank screen", () => {
  const buttons = allButtons();
  assert.equal(buttons.length, 72, "the measured count of per-id exercise refs in rendered prose");
  for (const [slug, id] of buttons) assert.ok(LEARN_EXERCISES[id], `${slug} links ${id} with no bundled sheet`);
});

check("back.md — the exemplar — renders its whole pick list as buttons, not prose", () => {
  const html = LEARN_PAGES.back?.html ?? "";
  assert.equal([...html.matchAll(/data-ex="/g)].length, 22, "back.md dropped 22 exercise links before this wave");
  assert.ok(!html.includes("data/exercises"), "no raw data path may survive into the shipped HTML");
});

check("no page leaks a raw data/ path into the shipped HTML", () => {
  const leaky = Object.entries(LEARN_PAGES).filter(([, pg]) => /data\/exercises\/[a-z0-9-]+\.json/.test(pg.html)).map(([s]) => s);
  assert.deepEqual(leaky, []);
});

check("each sheet carries every field renderExerciseSheet reads", () => {
  const NEEDED = ["id", "name", "execution_steps", "cues", "common_errors", "primary_muscles", "movement_pattern"];
  for (const [id, d] of Object.entries(LEARN_EXERCISES)) {
    for (const f of NEEDED) assert.ok(Object.hasOwn(d, f), `${id} is missing ${f}`);
  }
});

check("muscles are DISPLAY names, not raw ids — the sheet renders them directly", () => {
  const withMuscles = Object.values(LEARN_EXERCISES).filter((d) => d.primary_muscles.length);
  assert.ok(withMuscles.length > 0);
  // ids are kebab-case slugs; names are human text. A raw id here would render as
  // "upper-back" in the muscle line.
  assert.ok(withMuscles.some((d) => /[A-Z ]/.test(d.primary_muscles[0])), "expected human-readable muscle names");
});

// THE parity assertion. One sheet, two sources: the Learn tab reads the bundle
// (so it works offline), the player fetches GET /api/exercise/:id. "Identical by
// construction" is exactly the kind of claim this project has learned to back with
// an enumerable check instead of a comment.
const storePath = join(tmpdir(), `hb-learn-data-test-${process.pid}.json`);
try {
  const app = createApp(createFileStore(storePath), {});
  const sample = Object.keys(LEARN_EXERCISES).slice(0, 8);
  for (const id of sample) {
    const res = await app.request(`/api/exercise/${id}`);
    const api = await res.json();
    check(`bundled sheet === GET /api/exercise/${id}`, () => {
      // movement_pattern rides along for the inline demo; the API adds it too.
      const bundled = LEARN_EXERCISES[id];
      for (const k of Object.keys(api)) {
        assert.deepEqual(bundled[k], api[k], `field "${k}" differs between the bundle and the API`);
      }
    });
  }
} finally {
  try { rmSync(storePath); } catch {}
}

console.log(`\n${pass} learn-data test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
