#!/usr/bin/env node
// Validate every data/** instance (and the citation registry) against its JSON Schema.
// Exit non-zero on any validation failure.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemasDir = join(root, "data", "schemas");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// Load all schemas, key them by the short name before ".schema.json".
const schemaIdByName = {};
for (const f of readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"))) {
  const schema = JSON.parse(readFileSync(join(schemasDir, f), "utf8"));
  ajv.addSchema(schema);
  schemaIdByName[f.replace(".schema.json", "")] = schema.$id;
}

// data subdirectory -> schema short name
const dirToSchema = {
  exercises: "exercise",
  muscles: "muscle",
  programs: "program-template",
  progressions: "progression-rule",
  supplements: "supplement",
};

let checked = 0;
let errors = 0;

function report(label, validate) {
  errors++;
  console.error(`  ✗ ${label}`);
  for (const e of validate.errors ?? []) {
    console.error(`      ${e.instancePath || "/"} ${e.message}`);
  }
}

function validateInstance(data, schemaName, label) {
  const validate = ajv.getSchema(schemaIdByName[schemaName]);
  if (!validate) {
    errors++;
    console.error(`  ✗ ${label}: no schema '${schemaName}'`);
    return;
  }
  if (validate(data)) checked++;
  else report(label, validate);
}

// Volume landmarks are model estimates, but must at least be internally sane:
// each range has min <= max, and landmarks are monotonic (mv <= mev <= mav <= mrv).
function checkLandmarks(data, label) {
  const lm = data?.landmarks;
  if (!lm) return;
  const order = ["mv", "mev", "mav", "mrv"];
  for (const k of order) {
    if (lm[k] && lm[k].min > lm[k].max) {
      errors++;
      console.error(`  ✗ ${label}: landmark ${k} has min (${lm[k].min}) > max (${lm[k].max})`);
    }
  }
  const present = order.filter((k) => lm[k]);
  for (let i = 1; i < present.length; i++) {
    const lo = lm[present[i - 1]], hi = lm[present[i]];
    if (lo.min > hi.min || lo.max > hi.max) {
      errors++;
      console.error(
        `  ✗ ${label}: landmarks out of order (${present[i - 1]} ${lo.min}-${lo.max} should not exceed ${present[i]} ${hi.min}-${hi.max})`
      );
    }
  }
}

for (const [dir, schemaName] of Object.entries(dirToSchema)) {
  const dpath = join(root, "data", dir);
  if (!existsSync(dpath)) continue;
  for (const f of readdirSync(dpath).filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(join(dpath, f), "utf8"));
    validateInstance(data, schemaName, `data/${dir}/${f}`);
    if (dir === "muscles") checkLandmarks(data, `data/${dir}/${f}`);
  }
}

// Citation registry: validate each entry against the citation schema.
const regPath = join(root, "citations", "registry.json");
if (existsSync(regPath)) {
  const reg = JSON.parse(readFileSync(regPath, "utf8"));
  const list = Array.isArray(reg.citations) ? reg.citations : [];
  list.forEach((c, i) =>
    validateInstance(c, "citation", `citations/registry.json[${i}] (${c.key ?? "?"})`)
  );
}

console.log(`\n${checked} instance(s) valid, ${errors} error(s).`);
process.exit(errors ? 1 : 0);
