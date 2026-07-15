# The Hypertrophy Bible

An evidence-based, fully-cited knowledge base for maximizing muscle growth — built to eventually power
a web app for personalized training plans and workout tracking.

Every substantive claim here is backed by a **real, web-verified study** (with a DOI or PMID) and
carries an **A–D evidence grade**. Where the science is uncertain, we say so — that honesty is the
point. See [`STYLE.md`](STYLE.md) for the authoring rules and [the design spec](docs/superpowers/specs/2026-07-15-hypertrophy-kb-design.md) for the full rationale.

## How this is organized

The knowledge base has two synchronized halves:

- **`content/`** — readable prose, organized into nine pillars. Start here.
- **`data/`** — the same knowledge as machine-readable JSON (validated against schemas in
  `data/schemas/`). This is the contract the future app consumes.

Citations live once in [`citations/registry.json`](citations/registry.json) and are referenced by key
from both prose and data. A human-readable bibliography is generated at `citations/registry.md`.

## The nine pillars

| # | Pillar | What it covers | Status |
|---|--------|----------------|--------|
| 00 | [Foundations](content/00-foundations/index.md) | Physiology & mechanisms of hypertrophy | ✅ Complete |
| 01 | [Training Variables](content/01-training-variables/index.md) | Volume, load, frequency, failure, rest, tempo, ROM, exercise selection | ✅ Complete (exemplar) |
| 02 | [Muscle Guides](content/02-muscle-guides/index.md) | Per-muscle anatomy, function, exercise selection, volume | ✅ Complete |
| 03 | [Programming](content/03-programming/index.md) | Splits, periodization, progression, deloads | ✅ Complete |
| 04 | [Nutrition](content/04-nutrition/index.md) | Energy balance, protein, timing, supplements | ✅ Complete |
| 05 | [Recovery](content/05-recovery/index.md) | Sleep, stress, deloads, injury management | ✅ Complete |
| 06 | [Individualization](content/06-individualization/index.md) | Training status, age, sex, genetics, populations | ✅ Complete |
| 07 | [Tracking](content/07-tracking/index.md) | Metrics, RPE/RIR, progress assessment | ✅ Complete |
| 08 | [Myths](content/08-myths/index.md) | Common misconceptions, corrected | ✅ Complete |

Legend: ✅ Complete · 🚧 In progress · 🔲 Outlined (table of contents + stubs only)

## Evidence grades

| Grade | Meaning |
|-------|---------|
| **A** | Strong — consistent across multiple RCTs/meta-analyses. Act on it confidently. |
| **B** | Moderate — supported but with some inconsistency or limited populations. |
| **C** | Limited — few studies, mixed results, or mostly untrained/short-term. |
| **D** | Mechanistic/practice-based — physiology or coaching consensus, little direct RCT support. |

Model-based numbers (e.g. volume landmarks) are estimates, graded honestly — never presented as fact.

## Tooling

```bash
npm install          # one dependency: ajv (JSON Schema validation)
npm run validate     # every data/ file validates against its schema (+ landmark ordering)
npm run check        # citation integrity + data cross-reference integrity (exercises/muscles/progressions resolve)
npm run check-refs   # data cross-reference integrity only
npm run build-bib    # regenerate citations/registry.md from registry.json
```

## Project status

**All nine pillars complete, audited, expanded, and depth-reviewed.** The knowledge base spans 70
content pages backed by 87 web-verified citations (each confirmed to exist via PubMed, with 20
independently cross-checked against Crossref), plus a data layer of 16 muscle files, 59 exercises, 5
program templates, 2 progression rules, and 8 supplement entries — all passing schema validation,
citation integrity, and cross-reference integrity checks.

A full audit corrected one factual error (older-adult training volume), reconciled internal
inconsistencies, and closed a data-integrity gap by adding a referential-integrity checker
(`npm run check-refs`) and landmark-ordering validation.

A subsequent evidence-quality pass deliberately diversified the source base (no single research group
exceeds ~18% of citations, across 60+ distinct lead authors), added recent syntheses (2021–2025), and
**refined several positions to match current evidence** — the proximity-to-failure and
lengthened-training debates are now presented as genuinely unsettled, and load, protein, and frequency
claims are corroborated by multiple independent meta-analyses. New Foundations coverage (regional &
architectural hypertrophy, connective-tissue adaptation, and a "reading the evidence" methodology page)
rounds out the physiology.

**Verify it yourself:**

```bash
npm install && npm run validate && npm run check
```

**Next up:** the original goal — building the web app on top of the `data/` layer, which now covers
every muscle with multiple exercises and resolves cleanly by id.
