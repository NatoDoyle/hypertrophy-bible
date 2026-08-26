# How the program engine works

The owner's four questions (considerations #1, answered Wave 261), then the detail. Every number
here is read from the code, not invented; file references are to the pure cores (`tools/`) and the
binder (`app/src/coach.mjs`). Where a mechanism deliberately diverges from the KB's prose, that is
stated, with the reasoning.

**The four answers in brief:**

1. **How does weight progression work?** Double progression per exercise: hold the weight until
   every set at the anchor load hits the top of its rep range, then add 2.5 kg (1 kg for
   dumbbell/cable isolations). If you log effort (RIR), leaving a full rep more than the plan asked
   for moves the weight up a step without waiting for the rep ceiling; hitting failure holds it.
   Nothing else moves a weight: no percentages, no calendar.
2. **How do periodization and deloads work?** A 6-week mesocycle counted in weeks you actually
   trained: sets ramp 70% → 80% → 90% → 100% → 100% of the plan's targets, effort creeps up, and
   week 6 halves the multi-set lifts, eases loads ~10%, and sits at RIR 3–4. There are four
   distinct deload mechanisms (scheduled, reactive, per-lift comeback, event taper), each with its
   own trigger.
3. **What must be true before volume changes?** At each block boundary the engine re-reads your
   log per muscle: stalled with room below your ceiling → +2 weekly sets, but only if you're
   recovered, not in an energy deficit, not regressing, and not sandbagging (logged effort
   clearly easier than prescribed); over your recoverable ceiling, or stalled at it → −2. Every
   change accumulates and is clamped to the muscle's own MEV↔MRV span.
4. **Does experience change this? When do exercises rotate?** Experience changes nearly
   everything (targets, splits, session caps, and whether waves/deloads/tapers exist at all —
   beginners get none of them until graduation). Accessories rotate every block; compounds never
   rotate on a schedule — a compound changes only when *you* stall on it.

---

## 1. Weight progression (`suggestWeight`, app/src/coach.mjs)

Decision order per exercise, first match wins:

| # | Condition | Suggestion |
|---|-----------|------------|
| 0 | never trained it | none — you pick (non-beginners get a body-scaled starting estimate) |
| 1 | that lift untrained ≥ **12 days** | last weight × **0.88**, progression suppressed (comeback ease) |
| 2 | logged RIR ≥ band-top + 1 | +1 increment (+2 increments at band-top + 2) |
| 3 | logged RIR ≤ 0 without hitting top of range | hold — build reps first |
| 4 | every set at the anchor weight hit the top of the range | +**2.5 kg** (isolation dumbbell/cable: +**1 kg**) |
| 5 | otherwise | hold — add a rep or two |

Details that matter: the anchor is set 1's weight, and reps/RIR are judged **only over sets at
that weight or heavier** (a lighter back-off set is a different load, not evidence — Wave 258).
Deload- and comeback-tagged sets never anchor progression and never enter the strength trends, so
an eased week can't drag your history. During a deload week the suggestion is
`min(normal suggestion, last weight × 0.9)`; during an event taper the load holds entirely.

## 2. The mesocycle (`blockPhase`, `trainedWeeksInBlock`)

- **The clock is trained weeks, not calendar weeks** (distinct ISO weeks, in your own timezone,
  containing at least one logged set since the block started). Skip three weeks and the block
  waits for you; a "week 6 deload" can only follow five weeks that actually happened.
- Set scale by week: **0.7 / 0.8 / 0.9 / 1.0 / 1.0 / 0.5**, applied to each exercise's planned
  sets with a floor of 2. The peak is *your plan's* target — which for an intermediate is the
  bottom of the adaptive range (MAV.min), not the recoverable ceiling the KB's wave table
  describes. That is deliberate: summed mid-MAV targets don't fit in a real week, and the adaptive
  tune (below) walks your target upward from your own response instead. "Peak volume" on the card
  means the peak of your block.
- **Effort waves** with it: week 1 backs the near edge off by a rep; weeks 4–5 pull the far edge
  in; the near edge never moves closer to failure than the plan's own band (heavy compounds keep
  their 1–3 RIR even at peak — the KB's proximity-to-failure rule wins over its wave table's
  "0–1", now reconciled on both pages).
- **Daily undulation** (heavy 4–6 / moderate / light 10–15 compound bands across the week) is on
  for advanced hypertrophy/recomposition lifters automatically, or by choosing "undulating".
- At each boundary the plan **regenerates**: accessories rotate, the volume tune applies, stalled
  lifts are swapped (below), and the block index advances. A settings save mid-block keeps every
  mid-block stamp (deload state, announcements, demotions — Wave 257); a real training change
  starts a fresh block 0.

## 3. The four deloads

| Mechanism | Trigger | What changes |
|---|---|---|
| **Scheduled** (week 6) | five trained weeks in the block | sets ×0.5 (floor 2), load `min(suggestion, last×0.9)`, RIR 3–4 |
| **Reactive** (brought forward) | a muscle stalled **at its recoverable ceiling** (the "change" signal), block week ≥ 3, once per block *of training* | the same deload, this week, in your local week; an untrained stamped week re-arms (Wave 257) |
| **Comeback ease** (per lift or session) | ≥ 12 days since that lift (or any training) | ×0.88 load, one session, tagged so trends ignore it |
| **Event taper** | a goal event within 14 days (non-beginners) | sets ×0.6 (×0.4 in the final week), RIR floor 2–3, **loads untouched**, overrides the wave |

Honest magnitude note (measured, Wave 261): because of the 2-set floor, the scheduled deload cuts
the *week's* sets by ~31% on a median plan and only ~11% on a 2-day plan — short programs deload
mostly through the load ease and RIR 3–4, which the KB's "cut volume **and/or** back off
proximity to failure" always allowed. The cards' copy is scoped to match ("your big lifts drop to
about half their sets").

Adjacent but not a deload: a low-readiness check-in trims the last accessory from that day (or,
if the day is already short, keeps it and eases the effort advice).

## 4. The volume auto-tune (`deriveVolumeAdjust`, tools/derive-core.mjs)

Runs once per block boundary, per muscle, on the **peak** weekly volume of the last 6 logged weeks
(a block ends on a deload, so "latest week" would blind the ease branches — and since Wave 258 the
Progress card reads the same peak, so the advice and the action can't disagree):

```
over MRV.max                    → −2 sets
stalled and below MAV.max       → +2 sets, IF recovered AND not in a deficit
                                   AND not regressing AND not sandbagging — else hold, and SAY WHY
stalled at/above MAV.max        → −2 sets
progressing in range            → no change
```

- "Stalled" is judged against **your own progression cadence** (a lifter who PRs every ~6 weeks
  isn't called stalled at week 4).
- "Recovered": ≥ 4 daily check-ins in the current 42-day window averaging ≤ 2.6/5 blocks adds.
  "Deficit": the bodyweight trend reads as a cut — a deliberately-cutting user's stalls are
  answered with "fuel first", never more sets (the KB's building-muscle-in-a-deficit rule; the
  gate is right, and since Wave 258 it's also *visible*).
- "Sandbagging": ≥ 10 recent logged sets averaging ≥ 1 RIR easier than your plan's own band →
  the card says "push closer to failure" and the sets hold.
- Changes accumulate across blocks, clamped to each muscle's **MEV↔MRV** span, and freeze during
  a specialization block (a held muscle's by-design "stall" must not earn volume that lands when
  the block ends).

## 5. Experience gating and graduation

| Surface | Beginner | Intermediate | Advanced |
|---|---|---|---|
| Weekly target per muscle | MEV.min | MAV.min | MAV.max |
| Session hard-set cap | 12 | 16 | 20 |
| Compound set dose | 3 | 3 | 4 |
| Exercise difficulty ceiling | intermediate (hard gate) | advanced | advanced |
| Mesocycle wave / deloads / taper / specialization / tune | **none** | all | all |
| Daily undulation default | off | off | on (hypertrophy/recomp) |
| RIR chips | hidden (plain-effort copy) | on | on |
| First session | trimmed to 4 exercises | full | full |

Beginners run flat MEV-level plans on pure double progression — that is this app's design choice
(novices estimate RIR poorly and accumulate little fatigue debt; the KB now carries the carve-out
explicitly). **Graduation** is automatic and promote-only: 26 distinct trained weeks **and** 40
sessions → intermediate; 130 weeks and 250 sessions → advanced. Promotion starts a fresh block 0,
so week 1's 0.7× ramp walks you into the bigger targets, and the app announces it once.

## 6. When exercises rotate

- **Accessories**: every block boundary, the top 3 ranked isolations per muscle cycle one step —
  variety without touching anything you're building a progression on.
- **Compounds: never on a schedule.** A compound changes only when it **stalls**: a lift flat for
  your own stall window gets a ranking demotion bigger than every quality signal combined, so the
  next block picks a different angle — unless it's the only lift for that muscle in your
  equipment, in which case it's re-picked and the app no longer claims otherwise (Wave 257: the
  "I've swapped it" note names only lifts actually dropped). Demotion expires after ~21 days
  untrained, so a swapped-out lift can return later.
- **You**: mid-session swap (this session only) and the injury door (permanent regeneration)
  always exist. A hand-edited (custom) plan is never rotated, tuned, or swapped at all.
- Session order is a pure rotation (sessions completed modulo plan length) — it does not track
  weekday commitments; "legs always lands on Monday" is not a current property (recorded as a
  roadmap candidate, not a bug).

## 7. Where you see each mechanism

Every lever above has a surface: the per-exercise suggestion note (progression, comeback, taper
holds), the block card (week/phase + deload notes), the plateau card (deload-brought-forward /
push-harder / adding-sets / **held-for-recovery** since Wave 258), the reduce card (over-ceiling),
the regression card, the new-block coach note (rotation, tune deltas **and holds**, real swaps),
the plan screen's per-muscle reasons ("adaptive: +2 sets from your logged response"), and the
graduation note. Computed-but-unsurfaced signals are tracked deliberately: `readinessIndex`,
`confidenceTier` and `buildFeatureReport` are the un-shipped "Nerd Mode" payload (design spec §
Nerd Mode, deferred on the roadmap), not dead code.
