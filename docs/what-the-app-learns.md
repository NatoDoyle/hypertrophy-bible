# What the app learns from you, and when you'll see it

This is the ground truth: every piece of data the app stores about you, what reads it back, and what
changes for you as a result. It is written from the code, not from intentions. Where an older design
doc promises more, this page wins. If the code changes, this page changes in the same commit.

**The short version.**
- **Your weights learn from every workout.** The next session's weight comes from what you just lifted.
- **Your rest, your session length and your daily dose learn within weeks.** These are small, bounded steps.
- **Your plan itself learns at block boundaries.** Sets per muscle and which lifts you do change every 6
  *trained* weeks, and only where the data shows a problem (a lift gone flat). If everything keeps
  progressing, the plan stays as it is on purpose: it's working.
- **Some learning is offered, not applied.** The learned session ceiling is an example: you say yes first.

So "it isn't learning" usually means one of three things:
1. Everything is progressing, so there is nothing to change.
2. You haven't reached a block boundary yet.
3. You're in a case where plan learning doesn't run (see "Why you might not see it").

## The ledger: datum → what reads it → what changes → when

Refs are `file:line` at the time of writing; search for the function name if a line has moved.

### Learns every workout

| You give it | Stored as | Read back by | What changes for you | When / gate |
|---|---|---|---|---|
| Each set: weight, reps, reps-in-reserve (RIR) | `sessions[].sets` (`POST /api/session`, `app/src/app.mjs` normalizeSet) | `suggestWeight` (`app/src/coach.mjs`) | **Next session's weight.** All sets at the top of the range at the planned effort → up one step. Reps left over (RIR above the band) → up. Two or more reps under the range → eased. A shortfall holds. Each change comes with its reason. | Next session, every lift. RIR is asked only of non-beginners; beginners progress on reps alone (the KB's double progression). |
| Exercise order you actually did (`targets[].moved`) | session targets | `orderShift` (`coach.mjs`) | A lift moved later after hard sets gets its weight adjusted for the fatigue, and says so. | Next time the same order happens. |
| Time between your sets (set timestamps + `targets[].rest_s`) | `sets[].completed_at` | `restAdapt` (`tools/response-core.mjs`) | **Rest timer ±30 s, inside the KB's band.** Longer if your next set kept falling under the range after the current rest. Shorter for isolations whose sets held, on days that run past your minutes. | Needs the lift's last 3 workouts, with 2 showing it. |
| Same timestamps | `plan_meta.pace` (`paceProfile`, `response-core.mjs`) | `planOptsFor` → the plan's fit-to-time (`tools/plan-core.mjs`) and Today's minutes | **How many sets fit your session length**, at your real pace instead of a textbook 3 min/set. | Learned after every workout once a rest tier has ≥12 samples. The plan picks it up at the next rebuild (block boundary, a Settings change, an injury report). |
| Fade marks (stopped early, skipped the last lift, too tired) and "how did the last sets feel?" | `sessions[].fade_marks`, `/api/session/feel` | `sessionTolerance` → `sessionCapOffer` (`coach.mjs`) | **Your session ceiling** (for example "you fade past 12 sets"). Today offers it once; a yes rebuilds the plan under it. | ≥3 fades in your last 8 workouts. It is an **offer**: nothing changes until you accept. |
| Check-in: sleep, energy, mood, stress | `checkins` (`POST /api/checkin`) | `dailyReadiness` (`coach.mjs`) | **Today only:** a low score drops the last accessory and says why. | Same day. |
| Your history overall | sessions | `graduatedStatus` (`tools/derive-core.mjs`) | **You graduate** beginner → intermediate (26 trained weeks and 40 sessions) → advanced (130 and 250). Graduation rebuilds the plan with bigger targets and announces it once. | At those thresholds. |
| A lift you can't do: "No machine for this" | `profile.unavailable_exercises` | `candidatePool` (`plan-core.mjs`) | That lift never comes back until you tap "Bring back". | Immediately, every rebuild. |
| A lift you'd rather not do: "Just not for me", or the preference quiz | `profile.training_prefs.avoid` | `rankPool` (`plan-core.mjs`) | Swapped for one as good; kept (and said) where nothing appropriate replaces it. | Immediately, every rebuild. |
| Why you swapped a lift today (busy / pick / tired) | `sessions[].targets[].swap_why` | `swapPreferences` → `plan_meta.pref_scores` → `planOptsFor` | A lift you picked something else over 3× in 8 weeks leaves at the next rebuild where something as good fits (else kept, and said), named once, and stays out until Bring back. | Next block boundary or refit. Busy and tired swaps never count. |
| "It hurts" | `profile.injuries` | the injury filter, then a history-aware rebuild | Lifts that load that region are swapped out. | Immediately. |

### Learns at the block boundary (every 6 trained weeks)

At each boundary, `blockTuneDecision` (`coach.mjs`) reads the block you just finished. The trigger is in
`app/src/app.mjs` (search "NEW MESOCYCLE").

| Signal | What changes | Gate |
|---|---|---|
| A lift flat for your own stall window (`stallDetect` + `adaptiveStallWindow`, 4–10 weeks scaled to how often you train) | **That lift is swapped** for a different angle on the same muscle (if one exists in your equipment). The coach note names only lifts actually dropped. | The stall must be recent (trained in the last 21 days). |
| A muscle stalled with room below its ceiling | **+2 weekly sets** for that muscle, clamped to its own MEV↔MRV span | Only if you're completing the sets already planned, recovered (check-ins), not in a deficit (bodyweight trend), not regressing, and not logging efforts clearly easier than prescribed. |
| A muscle over its recoverable ceiling, or stalled at it | **−2 weekly sets** | — |
| Stalled at the ceiling mid-block (week ≥3) | **A deload week brought forward** (`reactiveDeloadStampDue`) | Once per block. |
| Accessories | **Rotate** one step among the top-ranked options per muscle (variety, not learning) | Every boundary. |

**Beginners get a refit at the same 6-trained-week clock (W319).** A beginner runs no mesocycle (no wave, deload,
accessory rotation or volume tune; those arrive at graduation). But their flat lifts are swapped and the plan is rebuilt
at their learned pace, announced only if something changed. It has its own counter (`plan_meta.refit_index`), so the
beginner is never treated as mid-block.

Recovery check-ins and the bodyweight trend can only **hold back** a +2 at a boundary (`recoverySignal`,
`classifyEnergyBalance`). They never add volume.

### Learns from what you eat (Fuel tab)

| You give it | Read back by | What changes | Gate |
|---|---|---|---|
| Calories logged + bodyweight | `adaptiveTDEE` (`tools/nutrition-core.mjs`) | **Your maintenance estimate**, replacing the formula's guess with what your intake and weight change actually show | ≥10 logged days in the last 28, with weigh-ins on those same dates spanning ≥10 days. |
| Tape measurements, height | `navyBodyFat`, Katch-McArdle | Your starting targets | Immediately. |

## Why you might not see it

These are the honest gaps, as of Burst 10 (each is being closed in Burst 11; this section is updated as they land).

1. ~~**Beginners get no block-boundary learning.**~~ **Fixed in W319:** beginners get a refit every 6 trained
   weeks (flat lifts swapped, the plan rebuilt at their pace). The volume tune still waits for graduation.
   W319 also fixed a quieter loss: the block boundary, graduation and Settings saves rebuilt `plan_meta` whole
   and dropped your learned pace and a declined session ceiling (`learnedMeta`, `app/src/planner.mjs`).
2. **A hand-edited plan pauses plan learning.** Any edit in the plan editor marks the plan `custom`. From then
   on the boundary tune, stall swaps, accessory rotation, the brought-forward deload, graduation's step-up, the
   session ceiling offer and fit-to-time are all off; weights, rest and the wave still run. **Since W320** the
   Plan tab says so ("Plan learning is paused") with one tap back: "Let the coach take over again" rebuilds from
   your answers and history (a bare `/api/plan/regenerate`), keeping every logged workout.
3. **The plan changes only when something stalls.** A lifter whose lifts keep climbing sees the same plan
   block after block. That is deliberate (don't fix what works), but it looks like "not learning".
4. ~~**Today-only swaps teach nothing.**~~ **Since W323** every today-only swap records why
   (`targets[].swap_why`: busy / pick / tired). A planned lift you **picked something else over** 3 times in
   8 weeks ("Pick one myself" or "Your pick") is learned as a dislike; a lift you pick yourself twice is a small
   liking (`tools/response-core.mjs` `swapPreferences`, re-learned after every workout into
   `plan_meta.pref_scores`). **Busy, tired and "It hurts" swaps never count**: they're about the day or your body,
   and the injury filter already handles pain (`swap_why`: busy / pick / tired / hurt / picked_over; the rule is
   `swapWhyFor` in `app/public/session-core.mjs`, proved by `npm run sweep:swaps`). The pick screens say the learning out loud. It lands at the next rebuild (block boundary or
   refit): the lift is swapped wherever something as good can take its place (the bounded skip — it never trades
   down), the new-block note names it, and the Plan tab lists it with Bring back. Where nothing as good fits, it
   stays, and the plan card says so ("Kept: …"). A learned
   dislike **sticks until Bring back** (`plan_meta.pref_kept`), even after its picks age past 8 weeks and
   through a trip without that kit, so the lift never sneaks back. (A pick followed by a busy swap of the picked
   lift is recorded as `picked_over`: it still counts against the plan's lift, but the busy stand-in isn't
   counted as liked.) Bring back on the "No machine" or skip card answers only that card. The Can't-do sheet also has "Just not for me": a soft, reversible skip
   (`training_prefs.avoid`), swapped now where a rebuild would agree, kept and explained where nothing
   appropriate replaces it.
5. **Nothing asked what you enjoy.** **Since W321** onboarding (and Settings → "What you enjoy") asks, on one
   optional screen: equipment styles you enjoy, routine vs variety, lifts you'd rather skip, cardio you'd do.
   Stored as `profile.training_prefs` (sanitized in `app/src/planner.mjs` `sanitizeTrainingPrefs`).
   **W322 — how the plan uses it** (`tools/plan-core.mjs` `prefRankOpts` / `rankPool`), bounded so it only reorders
   near-equals: an enjoyed style ranks at the top of the equipment ladder but never above the lengthened-bias signal;
   a lift you'd skip is demoted by a bounded 2.9: it yields to anything that still ranks above it (including an
   isolation, when it was the muscle's only compound), but never to a clearly worse lift, and is kept (and named on
   the plan card) when nothing appropriate ranks above it; "master the same" rotates accessories every second block, "keep it fresh" every
   block among the top four (main lifts never rotate); a liked cardio modality becomes the structured pick.
   "What your answers changed" says what each preference did, including where the optimal choice won.

## Stored but not used for learning

| Datum | Where it's used today |
|---|---|
| `rir_est` (an estimated RIR when you forgot) | History display only. Deliberately never treated as evidence. |
| `rpe` | Accepted by the API, but the app never asks for it. |
| Protein, carbs, fat logged on Fuel | Display against your targets only. |
| `motivation` (check-in) | Only the block-boundary recovery gate; it does not affect today's readiness trim. |
| Notification taps | Not recorded at all. |
| First-workout funnel (W327): when you first saw Today, opened the player, banked a set, saved a workout | `user.funnel`, first time each, only before your first workout. Read only as counts in the owner's `/api/stats`, to find where new lifters stop. Never per user, never for anyone who has already trained. |

## Not built (things older docs describe as if they were)

- A readiness index scored against your own baseline (z-scores of HRV, sleep, resting heart rate). The app
  uses fixed thresholds.
- Confidence-weighting of inputs by source, and learned per-user logging bias (for example a chronic RIR
  under-call).
- Learning your personal MEV/MRV. The landmarks stay the KB's; only a bounded ± sets offset is learned.
- Population learning across users, and the KB upgrading its own estimates from user data.
- Within-user experiments (n-of-1).
- Wearable data (HRV, resting heart rate, sleep).
