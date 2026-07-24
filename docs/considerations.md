# Considerations - thoughts, ideas, suggestions and questions for consideration

Goal: to make note of my thoughts, ideas, suggestions and questions so that they can be taken into consideration for implementation.

Everything below should be taken under consideration for implementation. Once it has been thoroughly considered against the goals of the project, the recommended actions should be implemented.

1. the 'what to adjust section' on the 'progress tab' shouldn't exist. Adjustments should be done automatically by the plan algorithm. we need to have a long think about the algoritm but it should be something like this :The algorithm should be looking at everything. sets, reps, rir, exercises, calories, weight, frequency, volume, intensity, mood, sleep, motivation, stress, etc. it should examine how all these variables have been fluctuating over the past however long and how they affect each other and automatically adjust the program to ensure progress continues to be made. Over days, weeks and months of users inputing data the algorithm should learn, adapt and improve the algorithm. our research is the starting point but as we gather our own data we need to form our own conclusions.
2. test the algorithm using fake but realistic data for 2 different users, 1 slow responder and 1 fast responder. test how the algorithm adjusts for both people over a 4-week, 12-week and 24-week timeline to ensure it's working correctly.
3. how is volume counted for secondary muscles? for example how much does bench press add to the total volume for triceps?
4. we currently consider primary and secondary activation for exercises but what about tertiary activation?
5. most people underestimate how much reps they have left in the tank. In most situations if someone put a gun to their head and said keep going, they would get a lot more. This makes me apprehensive about instructing people to leave 2-3 in reserve. I personally aim for failure on each set because i know even when im trying hard it’s not true failure.  What are your thoughts?
6. I read a study about how only the last 5 reps of a set matter, have we covered that study in our research?
7. Read & review the strength pyramid, pure bodybuilding. What do they do better than us and what do we do better than them ?

---

## Responses (Claude) — all seven addressed; here is each answer

- **#1 "What to adjust" shouldn't exist; the algorithm should adjust automatically — DONE (the
  card is gone, the engine adjusts itself), with the full vision as a staged arc.** The Progress
  card was removed in Wave 53 (replaced by one quiet line: "Your plan retunes itself each block
  from all of this — you don't have to adjust anything"). What the engine now does on its own, at
  each block boundary: per-muscle volume auto-tune (bounded ±2 sets/cycle, hard-clamped MEV↔MRV so
  it can never run away); it is **recovery- and energy-aware** (Wave 54 — it will NOT add volume to
  a stalled muscle when your check-ins show you're under-recovered or your bodyweight trend shows a
  deficit, because that stall is a fuel/sleep problem and more volume makes it worse — this is the
  "how the variables affect each other" you asked for); and the stall window itself is **learned
  from your own demonstrated PR rhythm** (Wave 55 — a ~6-week responder isn't judged "plateaued" on
  a fixed 4-week clock, and the window only ever stretches patience, never shrinks it). Signals now
  consumed: sets, reps, est-1RM trend, volume vs landmarks, frequency, sleep/energy/mood/motivation/
  stress (check-ins), bodyweight trend / energy balance, and logged calories where present. Two
  pieces deliberately staged rather than shipped: the **effort/RIR lever** was evaluated and
  deferred with recorded rationale (the available signal is ambiguous — "no rep drop-off" reads the
  same for "trained too easy" and for a disciplined lifter correctly stopping 2 short; gating volume
  on it would wrongly withhold volume from people training well); and **cross-user learning** ("form
  our own conclusions from our data") is the recorded far vision with an honesty guardrail — noisy
  early aggregate data must never silently override Grade-A evidence, and it genuinely needs a
  multi-user dataset we don't have yet (BLOCKERS #9). Full design + roadmap:
  `docs/adaptive-algorithm.md`. Bonus from your #7: the Muscle & Strength Pyramid's plateau
  framework independently validates both core choices (diagnose-before-dosing; judge plateaus
  against the individual's own rate).
- **#2 Test the algorithm on a slow and a fast responder over 4/12/24 weeks — DONE (Wave 59), and
  it caught a real flaw.** `app/scripts/sim-adaptive.mjs` drives the REAL engine (the same
  functions `/api/today` runs) with fake-but-realistic data; it's a readable report
  (`cd app && npm run sim`) AND a permanent regression guard (11 assertions inside the app test
  gate). Results: the slow responder (+4% PR every ~6 weeks) gets one unavoidable early bump, then
  by week 12 the engine has learned the rhythm, stretches its stall window to ~9 weeks, and HOLDS —
  never churned across 24 weeks. The fast responder (+1.5%/week, then a hard plateau) has the
  genuine stall detected promptly and answered with bounded accumulating volume (+2/+4/+6). The
  same fast responder under-recovered from week 8: every bump held at +0 by the recovery gate. The
  flaw the sim surfaced: cadence-learning originally needed TWO demonstrated PR intervals to lock,
  so a slow responder was over-bumped early; one interval is already strong evidence and the window
  only stretches patience (safe direction), so it now locks after the FIRST.
- **#3 How is secondary-muscle volume counted? — Direct answer: a hard set counts 1.0 for each
  primary muscle and 0.5 for each secondary.** So one bench press set = 1.0 chest + 0.5 triceps +
  0.5 front delts. That's the "effective sets" convention the volume landmarks were built on, and
  it's why a muscle's weekly total can show a half (e.g. "9.5 sets"). This had never been explained
  anywhere a user could find it, so Wave 60 added a plain-language glossary entry ("Effective sets —
  why you might see a half", bench→triceps as the worked example) next to the Volume definition the
  Progress tab links to.
- **#4 What about tertiary activation? — Considered answer: NO, deliberately.** The fractional
  two-tier scheme (1.0 / 0.5) is the method with the strongest relative evidence in the 2026
  dose-response meta-regression (Pelland 2026, verified in the registry). There is no established
  weighting for a third tier: a muscle that merely stabilizes sees too little mechanical tension —
  the primary growth driver — to add meaningful hypertrophy, and counting it would be false
  precision that inflates weekly totals against MEV/MRV landmarks built on the two-tier convention.
  Wave 61 wrote this reasoning into `volume.md` (Grade-C bullet) so the answer is on the record,
  not just in this file.
- **#5 "People underestimate reps in reserve — I aim for failure. Thoughts?" — You're right, and
  the KB now says so explicitly (Waves 62 + 65).** The evidence agrees people typically
  under-estimate RIR: told "leave 2-3", many stop at a true 4-5 — too easy. Which means when
  someone AIMS for failure they usually land about a rep short anyway — an effectively ideal
  proximity. So for safe isolation/machine work, "push hard, aim for failure" is often the more
  honest cue than a precise RIR number, and that's now the page's stated position. The 1-3 RIR
  reserve stays justified on heavy compounds — but for the honest reason: fatigue, technique
  breakdown, and recovery cost (protecting your quality volume), NOT because the last reps lack
  stimulus. Wave 65 added the load nuance: heavy loads recruit the high-threshold motor units from
  the first hard reps, so the growth stimulus is reached a little further from failure there —
  proximity matters most on lighter work.
- **#6 "Only the last 5 reps of a set matter" — that's the "effective reps" (a.k.a. "stimulating
  reps") model, and the KB now names and assesses it (Wave 62).** We had covered the underlying
  truth (reps near failure are the most stimulating) but never the model itself. Honest assessment:
  it's a mechanistic hypothesis, not an established finding — the strict "only the last ~5" version
  has no direct support, and the proximity-to-failure syntheses already cited (Refalo 2023,
  Robinson 2024) find the effect small and NON-linear, not an all-or-nothing rep-count switch.
  Useful intuition ("the hard reps at the end are why the set works"), not a number to chase.
- **#7 Muscle & Strength Pyramid + Pure Bodybuilding review — DONE (Waves 63–66), adoptions
  shipped.** What THEY do better → taken: (a) the Pyramids' signature explicit priority hierarchy —
  we had the ordering buried in a pillar index; now there's a top-level "What actually matters (in
  priority order)" getting-started page (consistency → volume → effort → protein/calories → sleep →
  … → "what to basically ignore for now"), closing with "the app already does the ordering for
  you"; (b) the load-dependent proximity nuance above (Wave 65) — a real KB gap the book surfaced;
  (c) Pure Bodybuilding's biggest edge is its per-exercise demo VIDEO library — that's already our
  top human-blocked item (BLOCKERS #1: licence/film/curate — it needs you). What WE do better:
  the engine is adaptive and individualized where a book is static (and their own Level-3 plateau
  framework validates our design — recorded as external validation in
  `docs/adaptive-algorithm.md`); every claim is machine-checked against a web-verified citation
  registry with honest A–D grades; and the app executes the priority ordering for the user instead
  of teaching them to self-program.

**Where things stand:** all seven items answered and shipped; prod is current. Still open from
this batch: the effort/RIR lever (deferred until a clean signal exists) and cross-user learning
(needs real multi-user data). If any answer above should go further — or a plan/screen still feels
wrong — name it and the loop picks it up next.
---

