# Design Spec — The Hypertrophy Bible

**Date:** 2026-07-15
**Status:** Approved — Milestone 1 in progress

## Problem & Goal

Build the world's best knowledge base on hypertrophy (muscle growth) and muscle-building
optimization. "Best" here means **genuinely authoritative**: every substantive claim is backed by a
real, web-verified scientific study (with a DOI or PMID) and carries an explicit A–D evidence grade.
The knowledge base later powers a web app that generates personalized training plans and tracks
workouts — so the knowledge must exist in two synchronized forms: readable prose for humans, and a
structured, schema-validated data layer the app can consume without re-extraction.

The app itself is **out of scope** for now. This project is the knowledge base only.

## Non-Goals (for now)

- Building the web app, its UI, or its personalization engine.
- User accounts, workout logging, or any runtime features.
- Comprehensive exercise coverage on day one (the exercise DB grows over milestones).

## Core Design Decisions

1. **Dual representation.** Human-readable Markdown in `content/`; machine-readable JSON in `data/`,
   validated against JSON Schemas. The two are kept in sync — prose numbers must match the data files
   they cite as "Backing Data".
2. **Single citation source of truth.** `citations/registry.json`. Both prose (`[^key]` footnotes)
   and data files (`citations: [key]`) reference entries by stable key. One bibliography, no drift.
3. **No fabricated citations, ever.** A citation may enter the registry only after a live web
   search/fetch confirms the paper exists and its true metadata (title, authors, year, journal,
   DOI/PMID) has been captured. Unverifiable claims are reworded, downgraded, or dropped.
4. **Evidence grading (A–D)** applied at the claim/recommendation level, per a documented rubric.
   Model-based constructs (e.g. volume landmarks) are labeled estimates and graded honestly.
5. **Layered voice.** Every content page: TL;DR → Quick recommendations → Practical Application →
   The Evidence → Key Uncertainties → Backing Data → References. Serves beginners through coaches and
   maps cleanly onto a future app's summary-vs-detail views.
6. **Skeleton first, then depth.** All nine pillars are outlined up front; content depth is added one
   pillar at a time, training science first.

## Architecture

```
content/            Prose, nine pillars (00-foundations … 08-myths)
data/schemas/       JSON Schema (draft 2020-12) — the app contract
data/{exercises,muscles,programs,progressions,supplements}/   Data instances
citations/          registry.json (source of truth) + registry.md (generated)
tools/              validate.mjs, check-citations.mjs, build-bibliography.mjs
```

### The nine pillars
1. **Foundations** — physiology & mechanisms (mechanical tension, the stimulus→fatigue→adaptation loop).
2. **Training Variables** — volume, load/rep ranges, frequency, proximity to failure, rest, tempo,
   range of motion, exercise selection & order. *(Exemplar — built first.)*
3. **Muscle Guides** — per-muscle anatomy, function, exercise selection, volume.
4. **Programming** — splits, periodization, progression, autoregulation, deloads.
5. **Nutrition** — energy balance, protein, nutrient timing, hydration, supplements.
6. **Recovery** — sleep, stress, deloads, injury management.
7. **Individualization** — training status, age, sex, genetics, special populations.
8. **Tracking** — metrics, RPE/RIR, progress assessment, autoregulation in practice.
9. **Myths** — common misconceptions and errors, corrected with evidence.

### Data schemas (the app contract)
- **exercise** — anatomy targeted, mechanic, equipment, resistance profile, ROM, cues, errors, progressions.
- **muscle** — heads/regions, functions, volume landmarks `{mv, mev, mav, mrv}` (weekly hard sets), frequency/recovery notes.
- **volume-landmarks** — the graded, cited landmark set referenced by muscle files and the Volume page.
- **progression-rule** — method, triggers, thresholds, applicable contexts.
- **program-template** — split, days/week, prescribed sessions, progression reference, target population.
- **supplement** — evidence tier, effect size, dosing, timing, safety.
- **citation** — the registry entry shape (see below).

### Citation registry entry
`key`, `authors[]`, `year`, `title`, `source`, `volume`, `issue`, `pages`, `doi`, `pmid`, `url`,
`study_type` (meta-analysis | systematic-review | RCT | cohort | mechanistic | narrative-review),
`population` (trained | untrained | mixed | animal | na), `verified` (true), `verified_via` (URL/DOI fetched).

### Evidence grading rubric
- **A — Strong:** consistent across multiple RCTs/meta-analyses, ideally trained populations.
- **B — Moderate:** several studies, some inconsistency or limited populations.
- **C — Limited:** few studies, mixed results, or mostly untrained/short-duration.
- **D — Mechanistic/Practice-based:** physiology or coaching consensus; little direct hypertrophy RCT support.

## Tooling

Node scripts (single dependency: `ajv` + `ajv-formats`):
- `validate.mjs` — every `data/**` instance validates against its schema.
- `check-citations.mjs` — every prose `[^key]` and data `citations` key resolves to a registry entry;
  every registry entry has a DOI/PMID/URL; reports orphan (unused) and dangling (missing) keys; non-zero exit on violation.
- `build-bibliography.mjs` — renders `registry.json` → `registry.md`.

## Milestones

- **M1 (this deliverable):** scaffold + all schemas + citation system + tooling + the **Training
  Variables** pillar built to gold standard, with backing muscle volume-landmark data and an exercise
  seed. Ends at user review — the exemplar sets the quality bar.
- **M2+:** one pillar per pass — Muscle Guides → Programming → Nutrition → Recovery/Individualization →
  Tracking → Myths — plus growing the exercise database.

## Verification

`npm run validate` and `npm run check` exit 0; a live spot-check confirms sampled citations resolve to
the stated papers; the Training Variables pillar reads end-to-end with correct layered structure, every
substantive claim cited and graded, and prose numbers matching backing data; `npm run build-bib`
regenerates the bibliography and README links resolve.
