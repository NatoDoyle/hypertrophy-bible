# Considerations - thoughts, ideas, suggestions and questions for consideration

Goal: to make note of my thoughts, ideas, suggestions and questions so that they can be taken into consideration for implementation.

Everything below should be taken under consideration for implementation. Once it has been thoroughly considered against the goals of the project, the recommended actions should be implemented.

1. Audit the program/training plan engine/system/algoritm against the kb.  Verify exercise selection, exercise order, sets, reps, intensity, daily volume, weekly volume, cardio pressciption, etc  
2. audit the adaptive progression model. How does it deal with plateau's, injuries, missed workouts, strength jumps, strengths drops, etc. 

---

## Responses (Claude) — both audited, 10 confirmed gaps, all shipped (Waves 162–169)

Three parallel maps (plan engine, adaptive model, KB prescriptions), then every
candidate verified inline against the code before it counted. **Ten findings survived;
three were refuted and deliberately left alone** — recorded at the bottom so a later
audit doesn't re-raise them.

### #1 — the plan engine vs the KB

- **Cardio was prescribed by the KB and by nothing in the app — FIXED (Wave 168).** This
  was the biggest gap in the whole audit. Wave 161 gave cardio real numbers (dose by goal,
  a modality interference ranking, timing rules) and then `grep cardio tools/plan-core.mjs`
  returned **zero hits**. The only cardio surfaces in the entire app were a *reactive*
  Progress-tab card that fires in one narrow diagnostic pattern, and a passing sentence on
  the Fuel tab — so "how much cardio should I do?" had no answer in the app while the KB
  had it all along. The plan now prescribes it: steps/day, sessions/week, minutes/session,
  straight from the guideline file with its own Grade D riding along. **Placement is
  derived, not guessed** — the engine already knows which sessions are leg-loaded, so the
  guideline's "off the day of, and the day before, a leg session" resolves itself. On a
  6-day PPL that's the Push days. On a 4-day upper/lower it's **nothing** — every training
  day is a leg day or the day before one — and the app says so (rest days, or walking,
  which costs nothing) instead of inventing a slot.
- **The KB's effort table has three tiers; the engine had two — FIXED (Wave 169).** Heavy
  compounds 1-3 RIR · *moderate compounds and most machine presses/rows 0-2* · isolation
  0-1. The engine keyed only off `mechanic`, so leg press, hack squat, machine chest press
  and chest-supported row all got the heavy-barbell reserve. It was self-contradictory too:
  the ranker gives machines the **largest** equipment bonus precisely because they're
  stable enough to push near failure — then the prescription told you not to. It
  preferentially picked those lifts and left their stimulus on the table.
- **Specialization contradicted the KB twice — FIXED (Wave 169).** (a) The weak-point
  page's Placement row says the priority muscle is "trained first, when you're fresh"; the
  sort key made exercise *tier* always dominate, so a side-delt specialist's lateral raises
  sat behind every compound — wrong for exactly the users who opted in. (b) An advanced
  side-delt specialist targets MRV 26 while 2 sessions × the 10-set quality cap can only
  deliver 20 — and the under-target warning never fired, because 20 clears its threshold.
  The plan quietly handed over 17 of 26 and said nothing. It now says so, with the KB's own
  answer: another day, not a longer session.
- **`general-fitness` was a declared goal with no rep scheme — FIXED (Wave 169).** It fell
  through a silent `?? hypertrophy`. Now an explicit alias, not an invented fifth scheme —
  the KB gives no separate prescription for general fitness, and making one up would be
  worse than saying plainly that it's the same.

**Everything else in item #1 checked out.** Exercise selection, ordering, sets, reps, daily
and weekly volume all trace correctly to the KB: the lengthened-bias-first ranking, the
1.0/0.5 effective-set convention, the MV<MEV<MAV<MRV clamps, the 12/16/20 session-quality
ceiling, the no-1-set rule, the MRV trim. The engine is in good shape; the gaps were at its
edges.

### #2 — the adaptive progression model

- **Strength JUMPS: one typo poisoned the engine permanently — FIXED (Waves 162–163).**
  `rir` had been clamped at the door for waves while `weight_kg` and `reps` sat unbounded in
  the same object. A fat-fingered weight was celebrated as a PR, anchored the next session's
  suggestion, and sat in the plateau trends forever — and there were **no edit or delete
  routes of any kind and no history screen**, so it was unfixable short of wiping the
  account. Now: bounded at the API door, an in-player "that's a big jump — sure?" judged
  against the lift's own history, and a workout history you can correct. Taking a workout
  back **voids** rather than deletes it (never lose logged data): it stays on the list,
  greyed, and goes straight back if you tap again.
- **Strength DROPS were invisible, and the response was backwards — FIXED (Wave 166).**
  `stallDetect` structurally *cannot* see a decline (it requires the window inside a 2.5%
  noise band, and a real drop blows past it). So a lifter losing strength was invisible
  while it happened — and once the pre-drop weeks rolled out, the new lower level went flat
  and read as an ordinary plateau, whose answer is **+2 sets**: more volume, to someone
  already failing to recover. The failure wasn't silence, it was the wrong direction.
  `regressionDetect` now sees it, the volume gate is per-muscle, and the card never shames
  — a decline is nearly always fuel, sleep or life, it isn't lost muscle, and it comes back.
- **Plateaus: the engine pulled 1 of the KB's 4 levers — FIXED (Wave 165).**
  `logging-and-plateaus.md` orders the response *volume → effort → deload → change
  exercise*. Only volume existed. Worse, `docs/adaptive-algorithm.md`'s own decision table
  named "exercise variation / deload" from the start, the roadmap never staged it, and no
  code implemented it — accessories rotated every block *unconditionally* and compounds
  never rotated at all, so a stalled bench could not be swapped by any path in the app.
  Meanwhile `volumeResponse` had been emitting "a deload or a different exercise will help
  more than piling on volume" on every progress read since it was written, and **nothing
  rendered it and nothing acted on it**. Both levers now exist and that signal drives them.
  (The effort lever stays deferred with its recorded rationale — RIR logging is still
  opt-in, so the signal genuinely isn't there.)
- **Missed workouts: the mesocycle ran on wall-clock — FIXED (Wave 167).** Train twice in
  six weeks and you still got "Week 6 — deload", a deload from work that never happened.
  Come back from a five-week layoff and you could land on "peak volume — push hard" on the
  very card that eased your loads 12% for a comeback. `POST /api/pause` froze the streak and
  the emails but not this. The block now advances on **trained** weeks: a consistent lifter
  sees no change at all, pause and layoff stop the clock for free, and the card can say
  something newly true — your block waited for you.
- **Injuries could be described, never reported — FIXED (Wave 169).** `neck` and `ankle`
  were filterable by the engine and offered by nobody (the UI listed 6 of 8 regions).
  Severity was hardcoded "moderate", making the engine's `mild` leniency branch unreachable
  from the shipped client — a whole path that existed and could never run. And
  `app-design-spec.md` described a reactive path ("only when a user skips or flinches at an
  exercise... I'll swap it") that nothing implemented: the mid-session swap was generic,
  session-only, and never wrote anything down, so the app could watch you avoid the same
  lift every week and never learn. "Did this hurt?" now persists and regenerates on the
  spot — without resetting your mesocycle, because an injury shouldn't cost you your block.
- **BONUS, and the biggest one: beginners never graduated — FIXED (Wave 164).**
  `training_status` was captured once at onboarding and changed by *nothing* afterwards. A
  beginner is excluded from the mesocycle wave (so **no deload, ever**), the accessory
  rotation, the volume auto-tune, DUP, the taper, and the body-scaled first weight. So
  someone who joined as a beginner and trained hard for eighteen months was still on
  `mev.min` volume, a 12-set session cap, and a plan that had **literally never changed**.
  Goal 2's "never heard of a gym → Mr. Olympia" arc was failing at its very first
  transition, silently, for exactly the people who'd earned the next step. Promotion is now
  derived from logged training age — deliberately *not* gated on progressing (training age
  isn't a reward for results, and a stalled lifter is exactly who needs the deloads and
  tuning the next tier unlocks) and it only ever promotes.

### Refuted — deliberately not acted on

- *"Plan warnings never reach the user."* False — they render on the plan-explain screen.
- *"The volume auto-tune fires on sparse data."* False — `stallDetect` returns nothing below
  its minimum week count, so a barely-trained block produces no bumps.
- *"The engine peaks at MAV.min, contradicting the KB's MEV→MRV wave."* A documented,
  deliberate choice: summed mid-MAV targets are undeliverable in a typical week and would
  warn on every default plan, and the adaptive tune walks targets up from your own evidence
  instead. Only the *comment* overclaimed, and that was corrected.

**Where things stand:** both items answered and shipped across Waves 162–169. Still
deliberately open: the effort/RIR lever (no clean signal while RIR logging is opt-in) and
cross-user learning (needs a multi-user dataset). Two things fell out of the audit worth
knowing: the D1 store-parity suite had **never once run** on this machine (a percent-encoded
path plus an old Node), and the program schema forbade `superset_with`, a field the engine
has always emitted — so no generated plan had ever validated against its own schema. Both
fixed.
---
