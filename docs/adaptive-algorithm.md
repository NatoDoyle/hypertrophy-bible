# The adaptive algorithm — design & roadmap

The long-term north star for the coaching engine: **the plan adjusts itself to keep
progress going, using every signal it has, and learns each individual over time.**
The user's framing (considerations #1):

> The algorithm should be looking at everything — sets, reps, RIR, exercises,
> calories, weight, frequency, volume, intensity, mood, sleep, motivation, stress.
> Examine how these have fluctuated and how they affect each other, and adjust the
> program so progress continues. Over days/weeks/months of data the algorithm should
> learn and improve. Our research is the starting point, but as we gather our own data
> we form our own conclusions.

And the load-bearing constraint the user added:

> People see progress at different intervals — some after 4 weeks, others after 6
> months of consistency. This is why an adaptive self-learning algorithm is essential.

That second point is the spine of the whole design: **timescales are individual.** A
fixed 4-week "stall" window and a fixed 6-week adjustment cadence are wrong for a
population whose response rates vary by an order of magnitude. Churning a slow-but-real
responder's program every 6 weeks destroys the consistency that was about to pay off;
waiting a fixed 4 weeks on a fast responder wastes adaptation. The algorithm must learn
each person's cadence and calibrate its own patience to it.

## The decision, stated precisely

Each adaptation cycle, per muscle / per lift, the algorithm chooses **push · hold ·
ease**, and which *lever* to pull:

| Lever | When | Evidence basis |
|---|---|---|
| **Volume** (± sets) | progress stalled, recovery + effort are fine, room below MAV | volume dose-response [A] |
| **Intensity / effort** (closer to failure) | stalled but RIR is consistently *above* target (training too easy) | proximity-to-failure [B] |
| **Exercise variation / deload** | stalled at the recoverable ceiling (MRV) | variation [C], deload [C/D] |
| **Recovery / fuel** (hold volume, flag food/sleep) | stalled *and* under-recovered or in an energy deficit | stimulus-fatigue-recovery-adaptation [B] |
| **Hold** | progressing at the individual's own demonstrated cadence | don't fix what's working |

The crucial ordering: **diagnose *why* a lift stalled before choosing a lever.** The
old engine had exactly one response to a stall with headroom — add volume — regardless
of whether the athlete was sleeping four hours, cutting on 1,600 kcal, or leaving three
reps in the tank. Adding volume to an under-recovered or under-fed lifter makes the
stall worse. This is the "how the variables affect each other" the user asked for:
volume, recovery, and energy are not independent knobs.

## The signals, grouped by role

- **Outcome** (is progress happening?): est-1RM / load trend per lift, rep progression,
  bodyweight trend (for mass goals).
- **Stimulus** (what's being done): weekly volume per muscle, frequency, load
  (intensity), proximity-to-failure (RIR / rep drop-off).
- **Recovery** (can they adapt?): readiness (sleep, HRV, resting HR, stress),
  motivation, energy balance (weight trend vs goal — no calorie counting required, though
  logged intake sharpens it).

## Individualized cadence — the core learning behavior

Progress is judged against the **individual's own demonstrated rhythm**, not a fixed
window. From a user's logged progression history we can estimate their typical
inter-improvement interval (median gap between est-1RM PRs on their staple lifts). The
stall window and the adjustment patience scale to a bounded multiple of *that*, floored
and ceilinged to sane values so a brand-new or noisy history falls back to the KB
default. A lifter who has historically PR'd every ~8 weeks is not "stalled" at week 4;
one who normally PRs every 2 weeks and has gone flat for 5 is genuinely stalled.

## The honesty guardrail (this is a science-first product)

"Form our own conclusions from our data" is right *and* has a trap. Two tiers:

1. **Per-user adaptation** (safe now): learn *this person's* volume response, recovery
   tolerance, and cadence, and tune *their* plan within evidence-based bounds. This is
   just autoregulation — well supported, and already partly built.
2. **Cross-user conclusions that revise the published science** (the far vision): only
   with rigor that matches the evidence being challenged — adequate n, confound control,
   held-out validation. Early, noisy aggregate data must **never** silently override a
   Grade-A landmark. The KB's own "reading the evidence" stance applies to our own data
   too. Until then the KB landmarks remain the priors; per-user signals move the plan
   *within* the recoverable range, never outside it.

## Safety rails (non-negotiable, already enforced)

- Volume adjustments are **bounded** (±2 sets per cycle) and **clamped to each muscle's
  MEV↔MRV** — the tune can never run away.
- The math lives in the **pure core** (`tools/derive-core.mjs`), `Date.now`/`Math.random`
  -free, so it is deterministic and runs identically on Node and Workers. Only the binder
  (`app/src/coach.mjs`) and route (`app/src/app.mjs`) read wall-clock/store.
- Adaptation is **quiet until there's enough data** to be trustworthy; new users get the
  evidence-based default plan.

## Increment roadmap

- **[done] Per-muscle volume auto-tune** — at each block boundary, stalled muscles with
  headroom gain sets, ceiling-bound ones ease; accumulates across blocks, clamped
  MEV↔MRV (`deriveVolumeAdjust` / `computeVolumeAdjust`). Advisory "what to adjust" card
  removed (Wave 53) — the plan just does it.
- **[next · Increment A] Recovery- & energy-aware volume tune** — never *add* volume to a
  stalled muscle when the athlete is under-recovered (low block-average readiness) or in
  an energy deficit; hold instead, because the stall is then a recovery/fuel problem.
- **[Increment B] Individualized adaptation cadence** — learn each user's inter-PR
  interval and scale the stall window / patience to it (the user's "different intervals"
  point).
- **[Increment C] Effort-aware lever** — when a stall coincides with RIR consistently
  above target, prescribe effort/intensity, not volume.
- **[far vision] Cross-user learning** — aggregate (privacy-preserving) response data to
  refine the priors themselves, under the honesty guardrail above.

Each increment ships as its own verified wave (both test gates green, deployed and
prod-smoked), extends the pure core with new *inputs* while preserving determinism and
the bounds, and is traceable back to this document.
