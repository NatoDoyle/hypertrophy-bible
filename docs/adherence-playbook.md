# The adherence playbook

Goal 4 is adherence above all else. This page is the working catalogue for it: every piece of data we could collect,
every engagement lever we know of scored against an honest line, and a ranked build queue. It was written in Burst 11
(2026-11-10) from the owner's note: "I really haven't been enjoying the gym for a long time but fortunately it's so
engrained in my life that I keep going. The app should be using the plain sight project and anything else it can find
to brainstorm and come up with creative ways to keep people consistent, adherent and committed. List every type of data
you can possibly suck out of the users directly and indirectly."

**The line (owner decision, 2026-11-10).** Go as hard as possible inside the Plain Sight five tests
(`plain-sight/defenses/engagement-design-audit.md`), applied per feature:

1. **Disclosure.** The rule could be printed where the feature lives and it would still work.
2. **True cue.** Every number, deadline and crowd is real and comes from the lifter's own logs.
3. **Benefit flow.** It serves the goal the lifter stated, and they can decline it on a day they shouldn't train. Training
   beyond their own plan counts as a cost. "It's free" does not settle this one.
4. **Vulnerability.** It never presses harder on the lapsed, the injured, the anxious or the young.
5. **The "no" test.** Muting, skipping, pausing and leaving produce silence, the data stays theirs, and there's no lecture
   on the way back.

On top of the five sits the **motivation-quality check**: does it make them *want* to come back, or make them *afraid
not to*? Across 66 exercise studies, autonomous motivation predicts long-term adherence and guilt-driven motivation
mostly doesn't (Teixeira 2012). The largest field test found incentive effects that faded once the programme stopped
(Milkman 2021). Pressure buys this month at next year's expense, and the tiebreak is "still training in 3 years".

## 1. The real constraint (read this before building anything)

Prod `/api/stats`, 2026-11-10:

| Measure | Value |
|---|---|
| Users onboarded | 145 (most predate cohort tagging; many are the project's own test traffic) |
| Ever logged a workout | 15 (activation 10.3%) |
| Active in the last 7 days | 1 |
| Push subscriptions | **0** |
| Recent cohort (since the timezone writer, 2026-08-04) | 20 users: 14 reached Today, **13 of those never started a workout**, 6 never reached Today |
| Days from onboarding to first workout (median) | 0 (n=7): whoever trains, trains the day they join |

**What follows from this.**
- Retention mechanics act on a population of about one.
- Reminders reach nobody: there are 0 push subscribers.
- The binding constraint is the step between seeing Today and starting the first set.
- We don't know why people stop there, because nothing measures it. **Measure first** (the W298–W301 lesson).

## 2. Every datum we could collect

Rules for every row:
- **First-party only.** Never sold, shared or sent to an ad or analytics vendor.
- **Visible.** Anything that changes the plan is listed in `docs/what-the-app-learns.md`.
- **Optional unless it's a workout.** Workouts are the one thing that must be logged.
- **Undoable.** Every learned thing can be turned off by the "no" test.

### Asked directly

| Datum | Collected? | What it could improve | Goal |
|---|---|---|---|
| Experience, goal, days, minutes, equipment, priority muscles, injuries (+severity) | Yes (onboarding) | The whole plan | 2 |
| What they enjoy: styles, routine vs variety, lifts to skip, cardio | **Yes since W321** | Exercise selection inside the optimal set | 2, 4 |
| Goal event date | Yes (Settings) | Taper | 2 |
| Daily check-in: sleep, energy, mood, stress, motivation | Yes (optional) | Today's dose; block gate | 2 |
| Bodyweight, tape measurements, sex, height | Yes (Fuel, optional) | Energy balance, TDEE, BF% | 2 |
| Calories, macros | Yes (Fuel, optional) | Adaptive maintenance | 2 |
| "Which days will you train this week?" | Yes | Commitment device, reminders | 4 |
| How the last sets felt (strong / fading / empty) | Yes | Session ceiling | 2 |
| Why they train: health, look, strength, sport, stress, social | **No** | Copy that speaks to their own reason (autonomy); which wins to show | 4 |
| What stopped them last time they quit | **No** | The comeback plan (shorter, different days, different lifts) | 4 |
| Preferred training time of day | **No** (derivable, see below) | Reminder timing | 4 |
| Training alone or with someone | **No** | Partner features, pre-filled invite | 4 |
| Music / podcast while training | **No** | Nothing actionable yet: skip | none |

### Logged as they train (behavioural)

| Datum | Collected? | What it could improve | Goal |
|---|---|---|---|
| Every set: weight, reps, RIR, set type, timestamp | Yes | Progression, volume, PRs, pace, rest | 2 |
| Estimated sets ("forgot the numbers") | Yes | Honest gaps in the evidence | 2 |
| Skips (set, lift, round), "do later", reorders | Yes (`targets.moved`, skips) | Which lifts they put off: a dislike signal | 2, 4 |
| Swaps and **why** (busy / pick / tired) | **Yes since W323** | Learned dislikes and likings | 2, 4 |
| "Just not for me" | **Yes since W323** | Soft skip list | 2, 4 |
| "Too tired" | Yes | Today's dose; fatigue pattern by weekday | 2, 4 |
| Fade marks (stopped early, skipped the last lift) | Yes | Session ceiling | 2 |
| Rest timer used vs actual gap | Yes | Rest adaptation | 2 |
| Hand edits to the plan | Yes (`custom`) | "Learning paused" (W320) | 2 |
| Pause / rest day / streak freeze use | Yes | Forgiveness, reminders | 4 |
| Cheers, follows, challenges | Yes | Social | 4 |

### Derived without asking (indirect)

| Datum | Collected? | What it could improve | Goal |
|---|---|---|---|
| Usual training time and weekday (from `completed_at`) | Derivable, **not computed** | Reminders at the time they actually train; the planned-day default | 4 |
| Weekday reliability (which committed days actually happen) | Derivable, **not computed** | Suggest moving a day that never happens | 4 |
| Time from onboarding to first set; where the first session stops | **No: the biggest gap** | Activation: the binding constraint | 4 |
| Today viewed / workout started / first set banked / finished | **No** | The activation funnel | 4 |
| Where in a session people abandon (lift index, minute) | Partly (the fade marks) | Session length and order | 2, 4 |
| Session start latency after a reminder | **No** (0 subscribers) | Reminder value | 4 |
| Notification taps | **No** (`sw.js` handles the click but records nothing) | Which reminders help vs nag | 4 |
| App opens without training | **No** | Intent without action: friction on Today | 4 |
| Set-entry corrections and typo guards hit | Partly | Input friction | 3 |
| Installed as an app vs browser | **No** | Push availability on iPhone | 4 |
| Device locale / timezone | Yes | Units, quiet hours | 3 |
| Lifts with PRs vs lifts that stall | Yes | Variety and swap decisions | 2 |
| Rate of progression vs the population | **No** (needs population data) | "Faster/slower than most": a true social-proof cue | 4 |

### Not collected, on purpose

| Datum | Why not |
|---|---|
| Location / GPS | The app gains nothing it can't get from the lifter's own logs, and the privacy cost is high |
| Contacts | Invitations are sent by the lifter's choice only (test 3) |
| Wearable HRV and sleep | Not built. The readiness index that would use them isn't either (`what-the-app-learns.md`) |
| Body photos | Optional progress photos are specced but unbuilt. Safety: body tracking stays off until the lifter turns it on |

## 3. Every lever, scored

✅ passes all five tests · ⚠️ passes once the named fix ships · ❌ fails (with the disqualifying test).

### Shipped: the honest audit of what we already have

| Feature | Verdict | Why / fix |
|---|---|---|
| Forgiving weekly streak + freezes | ✅ | Counts planned weeks; the miss rule is printed; pause freezes it; freezes are earned, never sold. Emergency reserves are evidenced (Sharif & Shu 2017/2021). |
| Comeback emails (2 days, 4 days, 14 days, then stop) | ✅ | The count stops on its own, "no streak lost, nothing to make up", and the next session is eased, never bigger. |
| Pause for sickness or injury | ✅ | All pressure off, streak safe. |
| "Too tired" | ✅ | Declining today costs nothing and never sets the lift back. |
| Reminders | ✅ | Only scheduled ones; quiet on rest and pause days; stop after 21 days of lapse. |
| Commitment days | ✅ | The lifter's own days, one tap to change, "No fixed days" offered. |
| PR toasts, trophy shelf, recap | ✅ | Every win traces to a logged set. |
| **Lucky set** (1 in 8, hidden) | ⚠️ → **W325** | Fails **disclosure (1)**: the rule isn't printed where it fires. Fix: say the rule on the toast. Plain Sight: "no bonus is the clean pass"; a disclosed small bonus is the honest game mechanic. |
| **XP: +5 per hard set** | ⚠️ → **W325** | Fails **benefit flow (3)**: points grow when you do more than your plan. Fix: hard-set XP stops at the plan's own sets. |
| **Milestone copy: "This is just who you are now"** | ⚠️ → **W325** | Identity framing turns a lapse into a statement about the person, which is the engine of the "I've blown it" spiral (Marlatt). Fix: a verifiable count only. |
| **"Keep the chain alive"** | ⚠️ → **W325** | Loss-framed, aimed at the at-risk state (test 4). Fix: say what's left to do this week, gain-framed. |
| **Weekly race / leaderboard, default on, "actual urgency"** | ⚠️ → **W325** | The opt-in should come first (test 5); comparison is on effort only. Fix: opt-in and calm copy. The one RCT favours the harsh version (Zhang 2016), which is exactly why the line is drawn here. |
| 1v1 challenges, cheers, partner nudge | ✅ | Opt-in, people you know, leavable. |

### New ideas, brainstormed against the KB and Plain Sight

Ranked within each block by expected effect on the binding constraint.

**Activation: Today → the first set (the constraint).**

| Idea | Verdict | Evidence / note |
|---|---|---|
| **Measure the first-workout funnel** (Today seen → Start → first set → finished, first-timestamps per user, aggregated in `/api/stats`) | ✅ **Build (W327)** | We can't fix what we can't see; this is the "measure first" lesson. Disclosed in `what-the-app-learns.md`. |
| A first workout of three lifts, "15 minutes, then you're done" | ✅ Next | The KB's own beginner page: "A first session of 20–40 minutes is plenty"; W287 already shortens it. Test a shorter door once the funnel shows the drop. |
| "Try one set": start with a single guided set, no commitment to the whole workout | ✅ Next | Foot-in-the-door in its honest form (a real first step, nothing extracted). Folk-graded. |
| A 60-second "what a set is" demo before the first set | ✅ Blocked on demo media (BLOCKERS #1) | |
| Showing "12 people started today" | ❌ Test 2 unless true, and it isn't at this scale | Fake social proof is banned outright (FTC 2024). |

**Enjoyment: the owner's note, and the strongest long-run lever.**

How exercise *feels while you do it* predicts coming back; how it feels afterwards doesn't (Rhodes & Kates 2015).
Autonomy predicts adherence (Teixeira 2012).

| Idea | Verdict | Evidence / note |
|---|---|---|
| **"Your pick"**: when two lifts rank as near-equals, Today offers the other with one optional tap, and the choice teaches the plan | ✅ **Build (W326)** | Autonomy-supportive coaching: choices offered, reasons given, "not today" accepted. Zero load if ignored (Goal 3). Feeds W323. |
| Preference quiz + "Just not for me" + learned swaps | ✅ **Shipped (W321–W323)** | |
| End the session on a lift they enjoy | ✅ Next | Ramping intensity *down* raised remembered and forecasted pleasure (Zenko, Ekkekakis & Ariely 2016, PMID 27390185; 15 min of cycling, n=46). Applying it to lifting is an extrapolation, so test it before claiming it. |
| A "fun day" option once a block: their picks only, still on-plan for volume | ✅ Later | Novelty inside the KB's variation band; must not cost the progression baselines. |
| PR targets they choose ("bench 100 kg by summer") | ✅ Later | Self-set goals plus monitoring: d≈0.40 (Harkin 2016). The goal is the lifter's, not ours. |
| Music / playlist integration | ❌ Not now | No evidence it moves adherence in an app; cost high. |

**Consistency: weeks 2–12.**

| Idea | Verdict | Evidence / note |
|---|---|---|
| Reminders at the time they actually train (derived from `completed_at`), offered and never silently moved | ✅ Deferred | Reminder nudges are the weakest category (Mertens/Maier 2022), and 0 subscribers means it reaches nobody. Re-rank when push has users. |
| Notification-tap recording | ✅ With the funnel, later | Tells us which reminders help. |
| "This day never happens; move it?" from weekday reliability | ✅ Later | A true cue from their own logs; one tap to decline. |
| Fresh-start prompts on real landmarks only (new week / month) | ✅ Later | Gym visits +33% at a new week (Dai 2014). Never a manufactured Monday. |
| A token "welcome back" bonus after a missed week | ✅ Later, small | The megastudy's best arm, but the effect faded within a month (Milkman 2021). Small, disclosed and unbuyable, or not at all. |
| Weekly coach check-in story card | ✅ Later | Self-monitoring plus feedback is the best-evidenced cluster (0.42 vs 0.26, Michie 2009). |
| Day streaks | ❌ Test 5 | A rest day breaks them. Already rejected in the spec. |
| "Don't lose your N weeks" | ❌ Test 4 | Loss copy aimed at the lapsing. |
| Escalating "we miss you" | ❌ Test 5 | Hoovering. |

**With other people.**

| Idea | Verdict | Evidence / note |
|---|---|---|
| A small, opt-in training circle (2–5 people the lifter names), effort-only | ✅ Later | Comparison doubled attendance in the one RCT (Zhang 2016); opt-in and small is the harm-limited form. |
| A pre-written invite for "I train with a friend" | ✅ Later | Their choice to send (test 3). |
| Global leaderboards, body comparisons | ❌ Test 4 | |

## 4. Build queue (this burst, then next)

1. **W325**: fix the five shipped features above (⚠️).
2. **W326**: "Your pick" (enjoyment and autonomy; feeds the learning loop).
3. **W327**: the first-workout funnel (activation is the binding constraint; measure before redesigning).
   - Swapped in for "reminders at your real time", which the burst plan had named: 0 push subscribers means it
     would reach nobody. Recorded per the plan's own rule.
4. Next burst, in order:
   - read the funnel
   - fix the biggest drop ("Try one set" / a 15-minute first workout)
   - end on a lift they enjoy
   - weekday reliability
   - reminder-time learning, once push has subscribers

## Sources

Through Plain Sight's verified bibliography (`plain-sight/defenses/engagement-design-audit.md`, sources 1–24):
- Teixeira 2012 (IJBNPA 9:78)
- Deci, Koestner & Ryan 1999
- Milkman 2021 (Nature 600:478)
- Sharif & Shu 2017/2021
- Silverman & Barasch 2023
- Dai, Milkman & Riis 2014
- Michie 2009
- Harkin 2016
- Rhodes & Kates 2015
- Zhang 2016
- Mertens 2022 / Maier 2022
- Marlatt & Gordon 1985

Verified here via PubMed E-utilities (2026-11-10):
- Zenko Z, Ekkekakis P, Ariely D (2016). J Sport Exerc Psychol 38(2):149–59. doi:10.1123/jsep.2015-0286. PMID 27390185.

None of these are added to `citations/registry.json` until a KB page makes the claim.
