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
- **[done · Increment A] Recovery- & energy-aware volume tune** — the tune won't *add*
  volume to a stalled muscle when the athlete is under-recovered (low block-average
  readiness) or in an energy deficit; it holds instead, because the stall is then a
  recovery/fuel problem (`recoverySignal`, `deriveVolumeAdjust` context).
- **[done · Increment B] Individualized adaptation cadence** — the stall window scales to
  each user's demonstrated inter-PR interval (`progressionCadence` → `adaptiveStallWindow`),
  so a slow-but-real responder isn't judged plateaued on a fixed 4-week clock and their
  program isn't churned before it pays off. Bounded to only ever *stretch* patience past
  the reliable-signal minimum, never shrink it. Directly answers the "people progress at
  different intervals" constraint.
- **[done · Increment D] Exercise-variation + deload levers** — the decision table
  above named both from the start ("Exercise variation / deload — stalled at the
  recoverable ceiling"), the increment roadmap never staged either, and no code
  implemented either: accessories rotated every block UNCONDITIONALLY (variety, not
  a response to anything) and compounds never rotated at all, so a stalled bench
  press could not be swapped by any path in the app; the only deloads were the
  calendar week-6 one and the layoff comeback ease. Now: `stalledExerciseIds` →
  `generatePlan`'s `stalledExercises` demotes a plateaued lift below every
  alternative for its muscle at the next block boundary (recency-filtered, or a
  swapped-out lift would stay flagged forever and never return), and
  `reactiveDeloadDue` brings the deload FORWARD for a muscle stalled at its
  ceiling — bounded to once per block, never in weeks 1-2, never doubling a
  scheduled deload. `volumeResponse`'s `"change"` signal, computed on every
  progress read since it was written and never once rendered, is now what drives
  both and what the plateau card actually says.
  **Meta (a lesson worth keeping): this table was the checklist all along.** Three
  of its five rows were live, one was explicitly deferred, and one had quietly
  never been built — a design doc's own decision table is only honest if each row
  is periodically grepped for a live code path.
- **[done · Increment C] Effort-aware lever** — when a stall coincides with effort
  consistently easier than target (too many reps left in reserve), prescribe effort, not
  volume. This was deferred for waves with the recorded rationale that neither available
  signal cleared the bar: explicit RIR logging was off by default (niche), and the
  rep-drop-off proxy (`proximityFromRepDropoff`) is *ambiguous in the direction this
  needs* — "no drop-off" reads identically for "trained too easy" and for a disciplined
  trainee who correctly stops ~2 reps short. That inference rationale still stands (the
  proxy remains a recap flourish only); what changed is the explicit signal (Wave 171):
  - **The unblock — one-tap effort chips, default-visible for non-beginners.** The old
    buried opt-in stepper became a plain-language "Reps left in the tank?" chip row
    (0/1/2/3/4+) on every set screen, on by default past the beginner stage (`hb_rir` is
    now tri-state: force-on / force-off / auto-by-training-status). Two honesty rules:
    **no chip is ever pre-selected — an unanswered set sends NO `rir`** (the old code
    auto-seeded 2, which would have mass-fabricated "at target" and blinded the lever
    forever); and beginners are never asked (the KB: novice RIR calls are noise; they
    inherit the chips at Wave-164 graduation). "4+" stores 4, not 5 — `isHardSet` drops
    `rir > 4`, so 5 would erase the too-easy sets from volume and set the volume card
    ("add sets") against the effort card ("too easy") from a single tap.
  - **The lever** — `effortSignal` (derive-core): over the last 6 distinct trained weeks
    (the same window the volume tune samples), the average logged surplus above the band
    **the plan actually prescribed** (`effortBandTop(ex, goal)`). Under the hypertrophy
    family that is heavy compound 3, supported/stable compound 2, isolation 1; **strength
    deliberately reserves more on accessories** (isolation "1-3", priority/pump "1-2"), so
    the band is read per goal from `REP_SCHEMES` — which now lives in derive-core and is
    imported *back* by plan-core, the same single-source-of-truth move Wave 171 made for
    `supportedCompound`. Wave 171 shipped only the metadata classifier as shared and
    described that as the whole story: the goal-specific rows were a second table in
    plan-core, so a strength lifter obeying their own accessory prescription was scored
    +1 over target and had volume held for sandbagging they never did (Wave 173).
    Isolation reads the **most lenient** of the goal's three isolation rows, since a
    logged set doesn't record which slot the plan filled it from — ambiguity can only
    under-fire the lever. A muscle is "too easy" only on **positive evidence**: ≥10 logged sets AND
    avg surplus ≥ +1 (the same +1 distance `suggestWeight`'s per-lift bump already uses).
    Deload/eased sets are excluded (an easy band is *prescribed* there — compliance, not
    sandbagging). Absent data → empty set → every consumer byte-identical to before,
    locked by regression test — the deferral's "never withhold volume from a disciplined
    lifter on ambiguous data" concern, honored by construction. Consumers: the block
    tune (`deriveVolumeAdjust` holds a too-easy stalled muscle instead of +2 sets) and
    `volumeResponse`'s new `"effort"` signal, which the Progress plateau card renders as
    "push closer to failure before we add volume" (the KB's own lever order:
    volume → effort → deload → variation).
  - **Honesty notes.** The direction is robust to miscalibration — a called "4+" is far
    from failure whichever way it's wrong, which is exactly the miscalibration mode the
    KB documents (most people underestimate reps left). This also superseded the spec'd
    "RIR calibration mini-game" gate (`rir_calibrated`, removed from the onboarding
    schema — it had zero readers/writers, lesson 14): instead of gating trust in the
    person, the thresholds tolerate the error. Known conservatism: the tier target is
    static while `waveRir` tightens prescribed bands in peak weeks, so the lever
    under-fires slightly during peaks — the safe direction for a hold-volume lever.
- **[far vision] Cross-user learning** — aggregate (privacy-preserving) response data to
  refine the priors themselves, under the honesty guardrail above.

Each increment ships as its own verified wave (both test gates green, deployed and
prod-smoked), extends the pure core with new *inputs* while preserving determinism and
the bounds, and is traceable back to this document.

## External validation

The two design choices at the core of this engine are not just ours — they match the
current authoritative programming synthesis (Helms/Morgan/Valdez, *The Muscle & Strength
Pyramid: Training*, 3rd ed. 2025), reviewed for considerations #7:

- **Diagnose before dosing.** When performance stalls, the recommended response is to
  first rule out recovery causes (sleep, nutrition, life stress) before changing volume —
  only add sets once recovery and organization are dialed in. This is exactly Increment A:
  the tune suppresses a volume increase when the athlete is under-recovered or in an energy
  deficit, because the stall is then a recovery/fuel problem, not a volume one.
- **Judge plateaus against the individual's expected rate.** A plateau is defined relative
  to the progression rate appropriate for a lifter's *training age*, not a fixed clock —
  which is precisely what Increment B does by scaling the stall window to each user's own
  demonstrated cadence.

That the engine converges on the same logic from data that a leading evidence-based text
reaches from the literature is reassuring, not a coincidence — both are reasoning from the
same stimulus-fatigue-recovery-adaptation model.
