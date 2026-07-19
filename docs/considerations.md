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

- **#3 Expand the exercise library — IN PROGRESS (you chose this first).** Extended the
  exercise schema with the metadata you asked for, all optional so nothing breaks while I
  backfill + author: `loading_bias` (lengthened / shortened / mid-range / uniform — the richer
  version of the old lengthened/shortened boolean), `execution_steps` (step-by-step how-to),
  `good_when` / `bad_when` (when it's a good vs bad pick), `cns_cost` (low/moderate/high systemic
  fatigue). Equipment already supports barbell/dumbbell/machine/cable/smith-machine/bodyweight/
  band/kettlebell. Added a consistency gate so `lengthened_bias` (engine) and `loading_bias`
  (reader) can never disagree. Next: author new exercises + backfill existing 93 in
  accuracy-verified batches (target ~150-200), covering every muscle × equipment, then re-enable
  band/kettlebell in onboarding once they have real pools.
- **#5 Fix the plans — QUEUED after #3, per your sequencing.** I diagnosed concrete issues to fix:
  1-set filler exercises (budget/coverage artifacts), uneven sessions within a rotation (a
  beginner day had 4 exercises vs 7), bodyweight moves picked even with a full gym, and redundant
  patterns in a session. These are real; I'll fix the plan-core allocation once the library is richer.
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

