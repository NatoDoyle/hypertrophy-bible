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
npm run validate     # every data/ file validates against its schema
npm run check        # citation referential integrity (no dangling/orphan keys)
npm run build-bib    # regenerate citations/registry.md from registry.json
```

## Project status

**All nine pillars complete.** The knowledge base spans 57 content pages backed by 63 web-verified
citations (each confirmed to exist via PubMed, with a sample independently cross-checked against
Crossref), 15 muscle data files, 10 exercises, 3 program templates, 2 progression rules, and 3
supplement entries — all passing schema validation and citation-integrity checks.

**Verify it yourself:**

```bash
npm install && npm run validate && npm run check
```

**Next up:** growing the exercise database toward comprehensive coverage, adding more program
templates, and (the original goal) building the web app on top of the `data/` layer.
