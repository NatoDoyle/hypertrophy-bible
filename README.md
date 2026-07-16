# The Hypertrophy Bible

An open-source, evidence-based, fully-cited knowledge base for maximizing muscle growth — and a
free coaching app built on top of it, live at **[hypertrophybible.com](https://hypertrophybible.com)**.

**Two goals:** the knowledge base aims to be the gold standard for hypertrophy *science*; the app aims
to be the gold standard for *coaching that applies it*. Free, no ads, no premium tier, no selling data.

Every substantive claim here is backed by a **real, web-verified study** (with a DOI or PMID) and
carries an **A–D evidence grade**. Where the science is uncertain, we say so — that honesty is the
point. See [`STYLE.md`](STYLE.md) for the authoring rules and [the design spec](docs/superpowers/specs/2026-07-15-hypertrophy-kb-design.md) for the full rationale.

## The app

A mobile-first PWA: anonymous one-tap start → a single "Today" card → one exercise at a time → a
derived recap → progress inferred from your logs (per-muscle volume vs. the KB's landmarks,
estimated-1RM trends, energy balance from bodyweight — no calorie counting). Optional passwordless
email backup syncs across devices. One codebase runs on Node locally and Cloudflare Workers + D1 in
production. To run it, see **[`app/README.md`](app/README.md)**.

## How this is organized

The knowledge base has two synchronized halves:

- **`content/`** — readable prose, organized into ten pillars. New to the gym? Start at [Getting Started](content/09-getting-started/index.md).
- **`data/`** — the same knowledge as machine-readable JSON (validated against schemas in
  `data/schemas/`). This is the contract the future app consumes.

Citations live once in [`citations/registry.json`](citations/registry.json) and are referenced by key
from both prose and data. A human-readable bibliography is generated at `citations/registry.md`.

## The ten pillars

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
| 09 | [Getting Started](content/09-getting-started/index.md) | Total-beginner on-ramp: gym basics, equipment, safety, first sessions, the full-arc roadmap | ✅ Complete |

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
npm run validate     # every data/ + examples/ file validates against its schema (+ landmark ordering)
npm run check        # citation integrity + data cross-reference integrity (exercises/muscles/progressions resolve)
npm run check-refs   # data cross-reference integrity only
npm run build-bib    # regenerate citations/registry.md from registry.json
npm run derive       # demo the derive-metrics engine over examples/
npm run test-derive  # unit tests for the derive-metrics engine
npm test             # everything: validate + check + derive tests
```

## App data & learning layer

The KB is designed to power a self-learning training app. The data contract and feature-derivation
layer are built and tested (the app UI/backend is downstream):

- **`data/schemas/{onboarding-profile,workout-session,daily-checkin,body-metric}.schema.json`** — the
  data contract for what the app collects.
- **`examples/`** — validating sample data (an onboarding profile, a two-week workout log, daily
  check-ins, body metrics).
- **`tools/derive-metrics.mjs`** — the "derive-don't-ask" engine: computes per-muscle weekly volume
  (vs the KB's own MEV/MRV landmarks), estimated-1RM progression, energy balance *inferred from the
  bodyweight trend* (no calorie counting), objective proximity-to-failure, and personal-baseline
  readiness — all from low-burden primitives.
- **[`docs/data-and-learning-spec.md`](docs/data-and-learning-spec.md)** — the full strategy: signal vs
  noise per stream, confidence tiers, the accuracy playbook, and the prior→personalize→aggregate→
  feed-back-into-the-KB self-learning architecture.

## Project status

**Ten pillars complete, audited, expanded, and depth-reviewed.** The knowledge base spans 99 content
pages backed by 87 web-verified citations (each confirmed to exist via PubMed, with 20 independently
cross-checked against Crossref), plus a data layer of 16 muscle files, 59 exercises, 5 program
templates, 2 progression rules, and 8 supplement entries — all passing schema validation, citation
integrity, and cross-reference integrity checks.

A dedicated **Getting Started** pillar now provides the total-beginner on-ramp the science pillars
assumed away — gym basics, equipment operation, a glossary, safety (spotting, failing/bailing, red-flag
symptoms), first sessions, gym anxiety, and a full-arc roadmap from "never trained" to "approaching your
genetic ceiling" — plus advanced pages (long-term planning, weak-point specialization, advanced
plateau-breaking, the genetic-ceiling journey) so the KB honestly spans the entire journey.

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

**The app is built and live** at [hypertrophybible.com](https://hypertrophybible.com) — onboarding,
KB-derived sessions, one-exercise-at-a-time logging, derived progress, offline support, and passwordless
email backup, on Cloudflare's free tier. Active work: making the coaching itself gold-standard —
generating plans directly from the KB's volume landmarks and exercise database, explaining the "why,"
and capturing effort/readiness. See [`app/README.md`](app/README.md).

## License

[MIT](LICENSE) © 2026 Nathan Doyle. Educational content — not medical advice.
