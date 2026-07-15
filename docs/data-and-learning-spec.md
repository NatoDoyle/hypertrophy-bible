# Data & Learning Spec — Turning the KB into a Self-Learning System

**Status:** Foundation built and tested (schemas + derive engine + fixtures + tests).
**Scope:** the data contract and feature-derivation layer. The app UI, backend, and ML training
pipelines are downstream of this and out of scope here.

## Goal

Turn the evidence-based knowledge base into a system that **personalizes** each user's training and
**improves over time** from real data. The machine learns one causal chain, per person and in aggregate:

> **training stimulus → (moderated by recovery + adherence) → adaptation**, conditioned on individual traits.

Every data point must earn its place by measuring one of four things: the **stimulus** (inputs), the
**adaptation** (outputs), a **mediator/moderator** (recovery, adherence, traits), or it's **noise**.

## Governing principles

1. **Adherence is the fuel — minimize burden ruthlessly.** One thing must be logged well (workouts).
   Everything else is optional or passive. Missing data on a low-value stream is fine; missing workout
   data is fatal.
2. **Derive, don't ask.** Per-muscle volume, rest times, energy balance, proximity-to-failure, and
   progression are **computed** from primitives — never self-reported. See `tools/derive-metrics.mjs`.
3. **Passive/objective beats active/subjective.** Wearables, smart scales, and timestamps beat manual
   sleep/calorie/mood entry.
4. **Confidence-weight every input.** Model the *accuracy* of each stream; never let a low-confidence
   calorie log override a high-confidence bodyweight trend.
5. **Collect by value-of-information.** Only ask for a data point when it would change a recommendation.

## The four data streams (the contract)

Schemas live in `data/schemas/`; validating examples in `examples/`.

| Stream | Schema | Burden | Verdict |
|--------|--------|--------|---------|
| **Onboarding profile** | `onboarding-profile.schema.json` | One-time, short | Sets priors; only the first-program minimum is required, the rest is collected progressively |
| **Workout session** | `workout-session.schema.json` | Per set (the one must-log) | **Crown jewel** — objective primitives; everything higher-order is derived |
| **Daily check-in** | `daily-checkin.schema.json` | Passive (wearable) / seconds | Mediators; every field optional, provenance tracked for confidence |
| **Body metric** | `body-metric.schema.json` | Monthly | Lagging outcomes (measurements, photos, DEXA) |

### Signal / derive / noise verdicts

**Log (objective primitives):** exercise · weight · reps · set type; bodyweight (as a *trend*);
wearable sleep + HRV/resting-HR; periodic measurements/photos.

**Derive (never ask):** per-muscle weekly effective volume · estimated 1RM & progression rate · rest
times · proximity-to-failure · **energy-balance direction (from the weight trend, not calorie counts)** ·
readiness.

**Optional, low-burden:** RPE/RIR (experienced users) · soreness · one daily mood/stress/energy tap ·
protein "hit target? yes/roughly/no" · menstrual phase.

**Noise — do NOT collect:** precise calorie counts · carbs/fat/micronutrients/water logging · daily
bodyweight as a point value · steps · "pump"/subjective size ratings · anything computable from something else.

## Confidence tiers

| Tier | Sources | Rule |
|------|---------|------|
| **High** | Logged weight×reps, timestamps, wearable sleep/HRV, smart-scale weight | Trust directly |
| **Moderate** | RPE/RIR (calibratable), manual sleep, soreness | Trust with learned per-user bias correction |
| **Low** | Self-reported calories/quality/mood | Weak prior only — never overrides High |

Provenance is captured in `daily-checkin.source` and mapped by `confidenceTier()` in the engine.

## Derived metrics (implemented + unit-tested)

`tools/derive-metrics.mjs` (tests in `tools/test-derive.mjs`). Key functions:

- **`estimate1RM(w, reps)`** — Epley (`w·(1+reps/30)`), confidence-flagged by rep count.
- **`perMuscleWeeklyVolume()`** — hard work sets per muscle per ISO week; **primary = 1.0, secondary =
  0.5**; warm-ups and sub-threshold-effort sets excluded; unknown exercises skipped (not guessed). Uses
  the KB's exercise→muscle map.
- **`volumeVsLandmarks()`** — classifies each muscle's week vs the KB's **MEV/MAV/MRV** landmarks
  (`below-MEV`, `in-productive-range`, `approaching-MRV`, `over-MRV`). *This is the loop back to the KB.*
- **`bodyweightTrend()`** — least-squares slope in kg/week (daily weight is noise; the slope is signal).
- **`classifyEnergyBalance(trend, goal)`** — infers surplus/maintenance/deficit and whether it matches
  the goal — **with zero calorie logging.**
- **`progressionByExercise()`** — best est-1RM per week and change across the log (the primary hypertrophy proxy).
- **`restTimes()`** — from set timestamps.
- **`proximityFromRepDropoff()`** — infers effort objectively from rep decay at fixed load (bypasses unreliable RIR).
- **`readinessIndex()`** — composite vs the user's **own baseline** (z-scores of HRV/sleep/RHR/stress), not absolute values.
- **`buildFeatureReport()`** — the full feature object an autoregulator / ML model consumes.

Run `npm run derive` for a worked demo over `examples/`.

## Accuracy playbook (answering "can people input accurate data?")

- **Energy balance from the scale, not the food log** — removes the single most error-prone task in fitness apps.
- **Objective proximity-to-failure** — velocity-based (camera/wearable) or rep-drop-off inference; reserve
  self-reported RIR for experienced users and rely on double-progression for novices.
- **Learn and correct per-user logging bias** (chronic RIR under-call, scale-timing drift) once enough data exists.
- **Confidence-tiered data fusion** — High > Moderate > Low; Low never overrides High.
- **Input sanity-checks** — flag implausible loads, unit confusion, wearable-contradicted manual entries.
- **Progressive onboarding, not a long upfront questionnaire** — collect the "extensive" data over the first weeks, in context, to avoid drop-off.

## The self-learning architecture

1. **Prior = the KB.** Every user starts at the evidence-based prescription. The volume landmarks are
   currently **Grade C estimates** — placeholders to be replaced by data.
2. **Personalize (n-of-1).** As a user's data accrues, shrink from the population prior toward *their*
   response (Bayesian: strong prior early, individualized later) — learn their MEV/MRV, recovery rate, volume tolerance.
3. **Aggregate (population learning).** Pool anonymized (input → outcome) data to build real dose-response
   curves and discover what predicts high vs low response.
4. **Feed back into the KB.** Population data **upgrades the KB's own graded estimates** — a C-grade
   landmark becomes a data-backed value. The knowledge base literally improves itself.
5. **Active learning / n-of-1 experiments.** Don't just observe — probe. Run controlled within-user tests
   (e.g., higher vs lower volume on matched muscles) that are both good for the user and maximally
   informative. Treat **adherence itself as a first-class predicted variable** and optimize for it.

## Minimum viable data set → roadmap

- **MVP (barely works without):** short onboarding + per-set workout logs + bodyweight trend. Powers
  autoregulated progression and energy-balance inference on day one.
- **High-value add-ons (opt-in):** wearable sleep/HRV, RPE (experienced), protein adherence, soreness.
- **Later:** mood/stress check-in, measurements/photos + computer vision, menstrual phase, DEXA uploads.
- **Never:** calorie counting, carbs/fat/water/micros, daily-weight-as-a-number.

## How this maps to the repo

- `data/schemas/{onboarding-profile,workout-session,daily-checkin,body-metric}.schema.json` — the contract.
- `examples/*.example.json` — validating sample data (`npm run validate`).
- `tools/derive-metrics.mjs` — the derive-don't-ask engine (`npm run derive`).
- `tools/test-derive.mjs` — unit tests with hand-computed expectations (`npm run test-derive`).
- The engine consumes the existing `data/exercises` (muscle map) and `data/muscles` (volume landmarks),
  so the app and KB share one contract — no knowledge is re-extracted.
