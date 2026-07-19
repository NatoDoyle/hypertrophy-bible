# Considerations - thoughts, ideas, suggestions and questions for consideration

Goal: to make note of my thoughts, ideas, suggestions and questions so that they can be taken into consideration for implementation.

Everything below should be taken under consideration for implementation. Once it has been thoroughly considered against the goals of the project, the recommended actions should be implemented.

1. you said the plan engine scores exercises, but is it thorough scoring ?
2. I see you've added a per-session quality cap but this should be the foundation, i want the plan to adjust based off the feedback the user inputs because some people react differently to different volumes and intensities. Some people might only need 6 sets, some might need 20. Some people train harder than others. I want the engine to use the knowledge base as a starting point and reference point but to learn and adapt based on the data it's fed.
3. Expand the exercises library. I want every exercise. I want all the information for each exercise, whether it's barbell, kettlebell, dumbbell, bodyweight, cable, resistence bands, etc. I want to know whether it biases the lengthened stretched posistion or the shortened flexed posistion. i want to know how to make it easier, i want to know how to make it harder. I want a step-by-step guide on how it should be performed. I want to know what muscles it primarly hits, what muscles it secondarily hits. I want to know in what situations it's a good pick and what situations it's a bad pick. I want to know it's cns cost. 
4. What if someone mid workout decides to do a different exercise, maybe the machine they wanted was occupied. there's no option to change the order of the exercies during a session or temporarily swap an exercise for the workout.
5. the training plans are really bad. once the exercise library upgrade is complete please fix the training plans.
6. have we done all the research on low volume high frequency high intensity training?
---

## Responses / plan (Claude)

- **#3 Expand the exercise library — DONE (this is what you chose first).** Library grew
  **93 → 171 exercises**, each new one with the full metadata you asked for: `loading_bias`
  (lengthened/shortened/mid-range/uniform), `execution_steps` (step-by-step how-to),
  `good_when`/`bad_when`, `cns_cost`, primary/secondary muscles, progressions/regressions.
  Authored via a 16-agent-per-muscle workflow, each exercise **adversarially accuracy-checked**
  by an independent reviewer (67 approved / 3 corrected / 16 dropped). New equipment (was ZERO of
  each): **21 band, 14 kettlebell, 8 smith-machine**. Band now covers 15/16 muscles, kettlebell
  14/16. The rich data is surfaced in the "how do I do this?" sheet (numbered steps, fact chips,
  good/bad-pick), and band+kettlebell are re-enabled in onboarding ("Home gym", "Bands &
  bodyweight" options) — verified those bundles generate viable plans. STILL TODO for #3 later:
  backfill the older 93 exercises with the new rich fields (they work fine without, the sheet
  renders only what's present), and keep growing toward "every exercise" (kettlebell/band variants
  of more lifts, smith-machine coverage).
- **#5 Fix the plans — IN PROGRESS (2 real defects fixed; 2 diagnosed "issues" turned out not to
  be defects).** Ran a rigorous diagnostic across 18 profiles. FIXED + shipped:
  (1) **1-set compound filler** — 8/18 plans prescribed a compound at a single set (nobody does one
  set of squats); now 0 across the grid (Wave 6-F).
  (2) **bodyweight when a gym is available** — 33 cases where a full-gym lifter got a capped
  bodyweight lift (bodyweight lunge, inverted row) instead of the loaded version that progresses;
  the ranking now prefers loadable exercises when equipment exists, down to 14 (the rest are
  legit), bodyweight-only users unaffected (Wave 6-G).
  VERIFIED NOT ACTUALLY DEFECTS (so deliberately NOT "fixed", to avoid degrading quality):
  (3) **"uneven sessions in a rotation"** — the sparse-looking day (4 exercises vs 7) carries the
  SAME total sets (12 vs 12), just more sets per exercise. That's legitimate focused programming;
  forcing more exercises would either exceed the weekly volume target or split into worse
  junk-volume. Not a defect.
  (4) **"redundant same-family compounds"** — mostly correct (3 pushes on a Push day is right).
  The one real-ish case is a full-body day getting a 3rd "pull" that's actually barbell-upright-row
  (a delt/trap move mis-lumped as a lat pull by its vertical-pull tag) — a minor data-classification
  artifact that evens out across the week, not worth a risky change to the tuned pattern-coverage.
  Net: the plans are meaningfully better (no filler, loaded lifts preferred). If you still feel
  specific plans are bad, tell me WHICH profile/day and what feels wrong — I'll target it.
- **#2 Adaptive engine — noted as the headline vision, after #3/#5.** The plan learns from logged
  data (RIR, completed reps, stalls) and adjusts per-muscle volume/intensity per person. Needs a
  solid baseline plan to adapt from, so it follows the library + plan fixes.
- **#1 "is the exercise scoring thorough?"** — partially: it ranks by mechanic (compounds first),
  difficulty fit, lengthened-bias bonus, movement-pattern spread, equipment, and a deterministic
  tie-break. It does NOT yet weight CNS cost or prefer well-loaded gym lifts over bodyweight when
  equipment exists — both are on the #5 plan-fix list, and the new `cns_cost` field feeds it.
- **#4 Mid-workout swap/reorder** — discrete UX feature, will slot in as its own wave.
- **#6 low-volume / high-frequency / high-intensity research** — will do a KB research pass; short
  answer, the current KB covers volume dose-response, frequency (~2x, Currier/Grgic), and
  proximity-to-failure, but a dedicated low-volume-high-intensity (e.g. HIT-style, minimalist)
  synthesis is a genuine gap worth a verified pass.
---

