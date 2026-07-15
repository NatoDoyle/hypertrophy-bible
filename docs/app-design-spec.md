# App Design Spec — The Hypertrophy Bible

**Status:** Design proposal (UI/UX layer). Downstream of the built data + learning layer
(`docs/data-and-learning-spec.md`, `tools/derive-metrics.mjs`, `data/schemas/`).
**Purpose:** One coherent app design that a total novice can use on day one and that still walks a
dedicated user to their genetic ceiling — hosted feasibly on a near-zero-cost Cloudflare stack.

This spec unifies three independent senior designs (one prioritizing *opinionated automation*, one
prioritizing *don't-let-them-quit consistency*, one prioritizing *a coach that just knows*). Where they
agreed — and they agreed on almost everything structural — that consensus becomes law here. Where they
conflicted (tab count, north-star metric, how hard to push scheduling), the reconciliation is called out
inline.

---

## 1. The one-sentence product

> A pocket coach that has already made every training decision, asks the user to do exactly one thing
> well — log the set in front of them — and derives everything else silently, so a brainless beginner and
> an advanced lifter use the **same** app: the floor is two taps, the ceiling is uncapped.

The science is already solved and sitting in the knowledge base. Reaching genetic potential is therefore
not a knowledge problem but a **consistency-over-years** problem. Every design decision is scored by a
single question: *does this make someone more or less likely to still be training in three years?*

---

## 2. North star & metric hierarchy

The three designs proposed three different north stars. They are not in conflict — they are three points
on one funnel. We adopt all three as a hierarchy:

| Tier | Metric | Owner design | Why it matters |
|------|--------|-------------|----------------|
| **Activation** (leading) | % of never-trained signups completing **8 sessions in their first 4 weeks** | A | Proves the on-ramp works; predicts everything downstream. |
| **Retention** (core) | Share of activated users still hitting their **planned minimum in a rolling 8-week window, out to 52+ weeks** | B | Consistency-weeks, not day-streaks or DAU. The true determinant. |
| **Outcome** (ultimate) | % still logging ≥ planned sessions **and** showing a positive est-1RM / volume trend at **6 and 12 months** | C | Adherence-weighted progression — the thing that actually equals muscle. |

**Explicitly not optimized:** DAU, time-in-app, session count, daily opens. A healthy user opens the app
briefly on training days and ignores it on rest days. Any mechanic that spikes short-term engagement at
the cost of long-term burnout, guilt, or quitting is rejected.

**Guardrails:** time-to-first-completed-session (< 24h from install); notifications-sent-per-completed-
session (must stay low); "silent-change trust" — rate of users tapping *"why did you change this?"* then
reverting, which should trend to zero as explanations land.

---

## 3. Design principles (the laws)

These are the non-negotiables every screen is checked against. They are direct operationalizations of the
data-and-learning spec's governing principles.

1. **One primary action per screen.** Never two primary buttons. The home screen collapses to a single
   decision. Empty states ship pre-filled with the recommended path; every choice has a smart default
   already selected. Nothing is ever a blank logger.
2. **Log one thing well; derive the rest.** The user's only real job is logging workouts, pre-filled down
   to ~2 taps per set. Per-muscle volume, energy balance, readiness, proximity-to-failure, rest, and
   progression are **computed** (`tools/derive-metrics.mjs`), never asked. *(Spec principle 2.)*
3. **Ask almost nothing upfront.** Onboarding collects only the schema's seven required fields. Everything
   else is gathered just-in-time, in context, over the first weeks. *(Spec principle 5: value-of-info.)*
4. **Passive/objective beats active/subjective.** Wearables, smart scales, and timestamps beat manual
   sleep/mood/calorie entry. No calorie counting, ever. *(Spec principle 3.)*
5. **Every derived metric maps to exactly ONE visible coaching action** — and never appears as a raw number
   in the default experience. The engine is the product; the UI is its bedside manner.
6. **Explain just-in-time, not upfront.** The 10 KB pillars are shattered into ~200 tiny "coach moments,"
   each fired by a trigger, each 1–3 sentences. The KB comes to the user; the user never browses a wiki
   to succeed.
7. **Depth is deferred, never removed.** A rank beginner sees a single "do this" card; the same screens,
   for an advanced user, expose every dial (RIR input, volume tuning, mesocycle planning, n-of-1
   experiments). Complexity is **unlocked by earned competence and accrued data**, not dumped upfront.
   This is how radical simplicity does not cap the ceiling.
8. **Forgiveness is engineered in, not bolted on.** Missing sessions is normal and expected. The app
   catches the fall and kills the guilt spiral the KB names as the true habit-killer. Metrics ("you
   lifted X kg") are reframed as identity ("you're becoming someone who trains").
9. **Confidence-tiering is enforced as UX.** A low-confidence self-report never overrides high-confidence
   objective data, so the advice the user sees is always coherent. Confidence governs *tone*: a
   high-confidence signal speaks assertively; a low-confidence one hedges and asks.
10. **Every recommendation carries a one-tap "why?" and a two-tap override.** Autonomy without burden.
    Nothing changes silently without a legible, user-data-attributed reason.

---

## 4. Information architecture / screen inventory

### 4.1 Navigation shell

**Four tabs. Session Player is a full-screen mode, not a tab. Learn is present but pull-only.**

> *Conflict resolved:* Designs A and C proposed 3 tabs; B proposed 4. We take B's four-destination shell
> because it gives progress-as-story its own home *and* a stable settings/body surface without burying
> either behind an avatar. But we honor A/C's minimalism: the daily user lives entirely on **Today** and
> may never open the other three.

```
┌─────────────────────────────────────────────┐
│                  (content)                    │
│                                               │
├──────────┬──────────┬──────────┬─────────────┤
│  Today   │ Progress │  Learn   │     Me       │
└──────────┴──────────┴──────────┴─────────────┘
        ▲ default landing
```

- **Today** — the coach's decision for *right now*. Default landing.
- **Progress** — progress-as-story (opt-in depth, safe to ignore); hosts the hidden **Nerd Mode**.
- **Learn** — the KB library; almost never navigated to directly (content is pushed just-in-time).
- **Me** — profile, program & schedule, integrations, body log, privacy, Advanced-mode toggle.

### 4.2 Screen inventory

| Surface | Type | One-line job |
|---------|------|--------------|
| **Splash / Welcome** | Onboarding | One promise, one button. No signup wall. |
| **Onboarding (5–6 taps)** | Onboarding | Collect only the 7 required profile fields; reveal the plan. |
| **Today card** | Tab (home) | Exactly one card = one decision (train / rest / lighter / welcome-back). |
| **Session Player** | Full-screen mode | The crown-jewel logger. One exercise at a time, ~2 taps/set, offline-first. |
| **Starting-weight finder** | In-Player flow | Live 3-tap "too easy / just right / too hard" ramp for any brand-new lift. |
| **Session Summary** | Post-workout | Chain +1, PRs, one genuine derived win, ≤1 optional tap. |
| **Progress** | Tab | Consistency calendar, e1RM trends, volume dots, bodyweight line, photo compare. |
| **Nerd Mode** | Toggle within Progress | The full `buildFeatureReport` for advanced users. Same engine, unlocked surface. |
| **Weekly Coach Check-in** | Weekly modal | Batches all volume/energy/deload decisions; pre-schedules next week. |
| **Learn** | Tab | 10 pillars, searchable; destination of "tell me more" deep-links. |
| **Me** | Tab | Program/schedule, reminders, integrations, body log, units, privacy, Advanced mode. |
| **Coach Moment** | Ambient component | Dismissible 1–3 sentence just-in-time card fired by a trigger, on any screen. |
| **Coach Note** | Ambient component | The single actionable derived-insight line on Today (value-of-information gated). |
| **Glossary tooltip** | Ambient component | Any jargon anywhere is a tap-to-define dotted underline. |

### 4.3 The three "coach voice" tiers (a component system, not screens)

All personalization speaks through exactly three surfaces, so intelligence stays invisible until it
matters:

1. **Coach Note** — one line on Today, only when actionable ("You've been crushing rows — I nudged them up
   2.5 kg"). This is where daily derived insight lives.
2. **Coach Moment** — just-in-time education, trigger-fired, dismissible (see §8).
3. **Weekly Coach Check-in** — the ~15-second story card that batches everything non-urgent so nothing
   nags daily (see §7).

---

## 5. Progressive onboarding flow

**Goal: under ~90 seconds, mostly single taps, every step skippable, and a never-trained person is holding
a real plan and heading into a first workout.** Onboarding writes exactly the seven required fields of
`onboarding-profile.schema.json` (`user_id`, `units`, `sex`, `training_status`, `primary_goal`,
`days_per_week`, `available_equipment`). `user_id` is minted silently; `units` is auto-detected from
locale. **Everything else in the schema is deferred.**

| # | Screen | Interaction | Writes / triggers |
|---|--------|-------------|-------------------|
| 0 | **Splash** | "Tell me what you want. I'll handle the rest." → **Start**. No account wall. | Silent local `user_id`. |
| 1 | **Experience fork** | "Have you lifted weights before?" → **Never / A little / I train regularly**. | `training_status`. **"Never"** silently switches on **Beginner Mode** and flags the Getting-Started track; shows a reassuring interstitial: *"Perfect — we'll teach you everything."* |
| 2 | **Goal** | "What do you want most?" image cards, **Build muscle pre-selected**. | `primary_goal` (hypertrophy default; strength / recomposition / fat-loss / general-fitness). |
| 3 | **Days** | Stepper defaulted to **3**, honest nudge: *"nailing 3 beats missing 5."* | `days_per_week`. |
| 4 | **Place** | "Where will you train?" **Full gym pre-selected** / Home with weights / Bodyweight only. | `available_equipment` (preset → array; never a checklist). |
| 5 | **Identity** | "You are…" male / female / intersex / prefer-not-to-say, with inline *"why we ask — it tunes your starting weights and recovery, one tap."* | `sex`. |
| 6 | **Generating (2s)** | "Building your plan…" — engine picks a `program-template` from the required fields (e.g. never-trained + 3 days + full gym → `beginner-full-body-3day`). | Program selection seeded from KB prior. |
| 7 | **Meet your plan** | "Here's your plan: Full-Body, 3 days. We'll refine it as I learn your body." **Primary: Start first session.** **Secondary: Schedule my days.** | Renders the real template. |
| 8 | **Schedule (the adherence keystone)** | Pick a day + time per session → drop into phone calendar → reminders on. Auto-suggests non-consecutive days. Skippable. | Reminders + a night-before "pack your bag" nudge. |
| 9 | **Soft save (deferred)** | Passkey / Apple / Google / magic-link, **or continue as guest**. | Offered *after* the plan is in hand — commitment asked only once value is obvious. |

> *Conflict resolved — scheduling:* A treated reminders as a light later nudge; B made
> calendar-scheduling *the* highest-leverage onboarding step. We side with **B**: fixing the *when and
> where* is the single biggest adherence lever in the Getting-Started pillar
> (`building-the-training-habit.md`). But per **A/C** we keep it a skippable secondary path so it never
> becomes friction that blocks the first session.

**Deferred, collected just-in-time (never in onboarding):** `height_cm`, `bodyweight_kg`, `birth_year`,
`injuries`, `wearable`, `priority_muscles`, `dietary_pattern`, `menstrual_tracking`, `experience_years`,
`session_length_min`, `rir_calibrated`. Collection triggers:

- **Bodyweight** → first optional weigh-in prompt (trend-only framing).
- **Injuries** → only when a user skips or flinches at an exercise ("that one bugging you? I'll swap it").
- **Wearable** → offered ~day 7, when readiness would start helping.
- **Priority muscles** → ~week 2 ("anything you especially want to bring up?").
- **RIR calibration** → via a calibration mini-game once the user is experienced enough for it to matter.

### 5.1 First-time journey for the never-trained (the whole ballgame)

Because Screen 1 was **"Never,"** Beginner Mode is on and Today greets them *before any lifting* with a
beginner-only card: *"Before your first session, here's the 2-minute how-a-gym-works — so you walk in
confident,"* surfacing `what-a-gym-is-and-the-equipment.md` and `overcoming-gym-anxiety.md` (skippable).
Then, in the Session Player, for the **first-ever set of each new exercise**:

1. A 20-second **form cue** plays (`form-fundamentals.md` / the exercise's own cues).
2. The **starting-weight finder** runs live (`choosing-your-starting-weight.md` executed as taps, not
   reading): *"We don't know your weight yet. Put just the bar on. Do 10. I'll ask how it felt."* → one
   tap: **Easy / Hard but doable / Barely made it** → ramps until ~2–3 RIR → *"That's your working weight
   — locked in, we start here next time."*
3. Before the first meaningful squat load, a **bracing** moment fires (`bracing-and-breathing.md`); before
   the first bench, a **bail-out** moment (`spotting-failing-and-bailing-safely.md`) — *"here's how to
   fail safely; you'll never need it, but now you know."*

End of Day 1: a big, genuine celebration — *"You just did your first workout. You're now someone who
trains."* — Chain = 1, next session scheduled. **The user walked in anxious and walked out with logged
numbers, a habit hook, and a coach that now knows their starting point — having made essentially zero
decisions and read essentially nothing.**

---

## 6. Daily-use flow (the "what do I do today" primary loop)

```
OPEN → TODAY (one card) → START → SESSION PLAYER (2 taps/set) → SUMMARY (1 win) → done
                     ↘ rest day → calm card, asks for nothing
```

**1. Open → Today.** The coach has already decided. Exactly one of these mutually-exclusive states, each
with a single primary button — **never two primary buttons:**

- **Training day:** *"Today: Push · ~40 min · 5 moves"* + **Start** + at most one Coach Note reflecting a
  silent engine decision.
- **Rest day:** *"Rest day — muscle is built now. One thing: hit your protein."* Asks for nothing.
- **Readiness-trimmed day:** *"Rough night — I trimmed today to the big lifts. Push if you feel good."*
- **Welcome-back day (after a lapse):** *"Welcome back — I've eased your weights so you ramp in safely."*

**2. Start → Session Player.** Opens on exercise 1 with **weight + reps already pre-filled** from the
engine's suggestion (`progressionByExercise` + double-progression: *"Last time 3×10 @ 40 kg → try 42.5
today"*). One exercise at a time, large steppers, a giant **Log set** button that auto-starts the rest
timer.

**3. Log a set in ~2 taps** — confirm the pre-filled numbers, or nudge them. Weight and reps are the
**only** inputs. Rest timer auto-starts (learned from the user's real `restTimes`), buzzes on completion
so you never watch the screen, and shows the next target. Total taps per set: ~2.

**4. Effort is invisible for beginners.** Proximity-to-failure is inferred from rep drop-off
(`proximityFromRepDropoff`); RIR/RPE is **never** demanded. Advanced users (post-calibration) see an
optional 1-tap RIR chip after the last set.

**5. Live in-set nudges (autoregulation in the moment).** After a set, if rep drop-off says reps barely
fell: *"Looked like you had more in the tank — let's add 2.5 kg next set."* If a heavy compound is next, a
one-line safety moment fires. All framed as help, never correction.

**6. Swap anytime.** One-tap, equipment-aware substitution if a machine is taken, a lift feels wrong, or a
beginner wants a friendlier variant.

**7. Finish → Session Summary.** Chain +1; any est-1RM PR called out (*"New best on bench 🎉"*); **one**
specific, genuine derived win; *"Logged. Next up: Legs, Thursday."* At most one optional tap (energy 1–5).
Then done — **no forms.** Optional private "Add a progress photo."

**8. Passive, between sessions (zero screens).** Overnight, a Worker pulls wearable sleep/HRV/RHR, updates
`readinessIndex` against the user's own baseline, recomputes `perMuscleWeeklyVolume` vs landmarks and the
`bodyweightTrend`, and **silently rewrites tomorrow's prescription.** The user experiences this only as
tomorrow's card being already correct.

**9. Offline-first.** The Session Player logs to local storage (IndexedDB) and syncs when signal returns —
essential in basement/concrete gyms. A failed save must never cost a logged set or break the habit.

---

## 7. Weekly & long-term loop (progression, deloads, autoregulation surfaced simply)

The user never sees a mesocycle spreadsheet. Long-term structure surfaces through **one** weekly card and
a handful of felt "the plan adjusted" moments.

### 7.1 Weekly Coach Check-in (~15s, once/week, batched)

A short story card that surfaces the week's accumulated decisions so they never nag daily:

> *"This week: I added a set to back (it's been recovering fast), your bench trend is up 4%, and your
> weight's tracking for a clean lean-gain. Next week is a deload for legs — you've stalled there and
> you've earned the rest."*

This single card is where **volume changes, energy-balance guidance, and deload timing all live**, and it
**pre-schedules next week** (building a durable weekly rhythm).

> *Conflict resolved:* B called this a "Sunday Weekly Review ritual"; C called it a "Weekly Coach
> Check-in story card." Same mechanic — we adopt C's plain-language story format inside B's fixed weekly
> ritual slot.

### 7.2 Progression (felt, never decided)

Double-progression (`data/progressions/double-progression.json`) is **executed for** the user: hit the top
of the rep range for all sets last time → today's rows already show +2.5 kg loaded and reps reset to the
bottom. The user "accepts" simply by lifting. A novice never reasons about it.

### 7.3 Volume vs landmarks (dots, not numbers)

`perMuscleWeeklyVolume` → `volumeVsLandmarks` classifies each muscle vs the KB's MEV/MAV/MRV. The app
**silently adds a set** to a muscle sitting below-MEV and **holds or backs off** one approaching/over-MRV,
mentioning it once, attributed to the user's own data (*"I added a set of rows — your back's ready for a
bit more"*). The user sees a body-map dot filling toward a healthy band, never "your back is at 14 sets."

### 7.4 Deloads (inferred and framed as earned)

Deload timing is **inferred** from stalled `progressionByExercise` (e1RM) + `approaching-MRV`/`over-MRV`
volume + falling `readinessIndex`, scheduled automatically, and framed positively (*"you've earned the
rest"*). First-ever deload fires a 20-second Coach Moment (`03-programming` deload rationale).

### 7.5 Readiness (pre-applied, never shown as a score)

`readinessIndex` (personal-baseline z-score of HRV/sleep/RHR/stress) pre-adjusts *today's* session before
the user opens it — a red day arrives already trimmed to key lifts, a green day may add a back-off set.
The score itself is never surfaced (except in Nerd Mode). Framed as care, never a block or guilt trip.

### 7.6 The beginner → advanced arc (earned unlocks)

Depth unlocks as the user demonstrates competence and accrues data — progression the user can *feel*:

- **Weeks 0–4:** double-progression, full-body template, dense safety/how-to Coach Moments, effort
  inferred from rep drop-off. Pure Beginner Mode.
- **~Weeks 4–12:** RIR calibration mini-game offered → passing sets `rir_calibrated: true` and unlocks the
  optional RIR effort chip and RIR-autoregulation progression
  (`data/progressions/rir-autoregulation.json`).
- **Intermediate:** split graduates (e.g. `upper-lower-4day`, `push-pull-legs-6day`) as frequency capacity
  grows; readiness-based autoregulation becomes visible; priority-muscle specialization
  (`specialization-delts-arms-4day`) once the base is built.
- **Advanced:** Nerd Mode, manual overrides, custom exercises, volume dials, mesocycle planning, and
  opt-in n-of-1 experiments — all reachable, none forced.

---

## 8. Getting-Started education, woven in just-in-time

The 10 pillars (~70 pages) are **never** presented as a manual. They are atomized into ~200 **Coach
Moments** — each 1–3 sentences, each bound to a trigger, each a dismissible card on the exact screen where
it becomes relevant. Four delivery mechanisms, all pull-not-push:

1. **Just-in-time trigger cards.** First time performing an exercise → a form cue
   (`form-fundamentals.md`). First heavy compound → `bracing-and-breathing.md`. Before first bench →
   `spotting-failing-and-bailing-safely.md`. Stalled e1RM → the plateau/deload explainer
   (`03-programming`) attached to the deload the engine already scheduled. Flat bodyweight against a gain
   goal → the energy-balance explainer + 3 concrete snacks (`04-nutrition`; **never a calorie target**).
   Any at-risk weigh-in pattern → `healthy-relationship-with-training-and-food.md`.
2. **The guided Getting-Started track for never-trained users.** The beginner pillar (what a gym is, the
   equipment, bracing, choosing a starting weight, failing safely, gym anxiety) delivered as swipeable
   ~20-second cards interleaved with the first sessions — *"Today, before you lift: what a rack is"* — not
   a wall of docs.
3. **A three-level depth ladder on every recommendation.** Default = just the action. Optional **"Why?"**
   expands one plain paragraph (the KB's own TL;DR). That links to the full graded, cited pillar page for
   the curious. Nobody is forced past level one, but the ceiling of rigor is always reachable.
4. **Ambient glossary.** Any jargon anywhere (RIR, MEV, hard set, deload, hypertrophy) is a dotted-
   underline, tap-to-define tooltip pulling from `content/09-getting-started/glossary.md`. Nothing is ever
   unexplained; nothing is ever pre-explained.

**Density auto-tunes to the user.** Beginner Mode fires more moments in simpler prose; Advanced Mode
suppresses basics and unlocks the mechanistic/foundations/"reading the evidence" pages. **Evidence grades
(A–D)** ride along as quiet, tappable chips so the KB's hard-won credibility is carried without ever
putting study talk in a beginner's face. The **Learn** tab exists for the curious (a beginner-first
"Start here" path on top) but is always optional — the same content is pushed just-in-time everywhere
else, so the tab is almost never needed.

---

## 9. Invisible personalization (derive-metrics, energy balance, n-of-1, population learning)

**The governing rule:** the user never sets a value the engine can derive, and every derived metric
surfaces as an **action**, not a number. The mapping is one-to-one and invisible.

| Engine function | What it computes | How the user experiences it |
|-----------------|------------------|-----------------------------|
| `estimate1RM` | Epley e1RM per set, confidence-flagged | In-session PR celebrations; the strength trend in Progress. |
| `progressionByExercise` | Best e1RM/week + change | Pre-filled weight on each set row; "bench up 4%" in the weekly card. |
| `perMuscleWeeklyVolume` | Hard sets/muscle/week (primary 1.0, secondary 0.5) | Body-map dots (never a set count). |
| `volumeVsLandmarks` | Classify vs KB MEV/MAV/MRV | App silently adds/holds a set; one attributed sentence. |
| `bodyweightTrend` | Least-squares kg/week slope | A trend **line** in Progress — never a daily number. |
| `classifyEnergyBalance` | Surplus/maintenance/deficit vs goal | Behavioral nudge only, when it would change a rec: *"flat 3 weeks; add one of these 3 snacks."* **Zero calorie counting.** |
| `proximityFromRepDropoff` | Effort from rep decay at fixed load | Live "more in the tank → go up" / "that was a grinder → hold" nudges; replaces asking novices for RIR. |
| `readinessIndex` | Personal-baseline z-score | Today's session pre-trimmed or pre-boosted; score itself hidden. |
| `restTimes` | Avg rest from timestamps | Auto-starting rest timer at the user's learned rest. |
| `confidenceTier` | Provenance → high/moderate/low | Governs tone; Low never overrides High. |
| `buildFeatureReport` | The full feature object | The entire **Nerd Mode** view — same engine, unlocked surface. |

### 9.1 Energy balance from the weight trend (no calorie counting)

The single most error-prone task in fitness apps is deleted. Daily bodyweight is **noise**; only the
smoothed multi-week `bodyweightTrend` slope is read, and `classifyEnergyBalance` turns it into a plain,
**actionable** sentence — surfaced only when it would change a recommendation (value-of-information
gating), and always behavioral (*"add a snack — here are 3"*), never a number. The daily weight is hidden
to prevent anxiety. Needs ≥3 weigh-ins; until then the app stays honestly silent rather than guessing.

### 9.2 n-of-1 personalization (the Bayesian shrink, made legible)

Early on, the plan follows the **KB population prior** (the muscle landmarks, currently Grade-C
estimates). As a user's data accrues, the model shrinks from that prior toward *their* response — learning
their personal MEV/MRV, recovery rate, and volume tolerance. This surfaces as a delightful, plain-language
reveal, framed as a coach getting to know you: *"I've learned your back recovers fast, so it gets more
volume than average; your chest needs more rest, so it gets less."* Early copy is honest — *"starting from
what works for most people"* → later *"based on how YOU respond."*

### 9.3 Active learning (opt-in experiments)

n-of-1 experiments are offered as opt-in, good-for-you probes, not data extraction: *"Want me to give your
side delts extra volume for 3 weeks and compare? I'll tell you what works for you."* This turns active
learning into a motivating game.

### 9.4 Population learning (feeds back into the KB)

Pooled, anonymized (input → outcome) data builds real dose-response curves and **upgrades the KB's own
graded landmarks** — a C-grade estimate becomes a data-backed value. This runs as a **batched offline
job**, never per-user real-time ML, keeping the stack cheap (§13).

### 9.5 Confidence-tiering as UX, and trust

The scale trend always beats anything typed about food; self-reported RIR is **distrusted**
(`rir_calibrated: false`) until the calibration mini-game passes; a low-confidence check-in never overrides
high-confidence objective data. Every silent change carries a one-sentence **"why,"** attributed to the
user's own data, with a **"why did you change this?"** tap available on any adjustment — the antidote to
the "the app just decided" trust gap.

---

## 10. Retention & habit mechanics

Retention is engineered as **friction-removal + forgiveness + honest celebration** — never manipulation.
Every mechanic is designed to survive a bad week, because the users who reach their potential are simply
the ones who didn't quit.

1. **The core loop *is* the reward.** Every Session Summary delivers a concrete, *derived, true* win
   (weight up, a volume milestone, close-to-failure, "most consistent month yet"). Progression is the
   dopamine — never fake confetti, never points.
2. **The Chain, done right.** Counts **planned sessions completed**, not calendar days, so rest days never
   threaten it; expressed as **weeks-consistent** ("12 weeks strong") — the real unit of progress. A miss
   reschedules in one tap and never punitively breaks anything.
3. **The 2-day rule as a first-class feature.** *"Never miss twice."* One miss is forgiven silently ("a
   blip, not a trend"). Illness/travel auto-applies a shame-free "life happens" pause with a one-tap "I'm
   back." Killing the guilt spiral is an explicit design target.
4. **Identity over metrics.** Milestones are framed as *who you're becoming* ("you've trained 12 weeks —
   you're a lifter now"). Consistency badges outrank PR badges.
5. **Frictionless comeback.** A lapsed user returns to *"Welcome back — I've eased your weights so you ramp
   in safely"* (an auto-deload on return, which is also evidence-correct for detraining). The highest-churn
   moment becomes a warm one.
6. **Minimal, self-tapering, non-guilt notifications.** A reminder at the user's chosen session time; a
   single gentle "still on for today?" only if untrained by evening; the warm comeback ping; the Weekly
   Check-in. Quiet hours respected; frequency auto-tapers if ignored. The app earns the right to notify.
7. **Deload/readiness management** quietly prevents the burnout that causes quitting.
8. **The relationship as switching cost.** The coach remembers you, references your history, and gets
   measurably smarter the longer you stay — your accumulated n-of-1 model can't be exported to a
   competitor. Leaving means starting over with a coach that doesn't know you.
9. **Leading-indicator progress in the messy middle.** Months 3–9 (slow visible results) is the top quit
   window; Progress foregrounds e1RM creeping up, volume dots, consistency, and photo comparisons so slow
   months still feel rewarding. A yearly "your year in lifting" recap re-engages.

---

## 11. Accessibility & inclusivity

Designed for the real conditions of logging mid-set — sweaty, gloved, one-handed, bright or dim gym light,
bad signal, a cheap phone, possibly never having touched a barbell. Good gym-floor design *is* good
accessibility.

- **Thumb-first, one-handed.** All logging controls bottom-anchored with large tap targets and stepper
  controls (no tiny numeric fields); nothing critical requires reaching the top of the screen. Core
  numbers legible from three feet at the rack.
- **Eyes-free.** Haptics confirm every logged set and announce the rest timer; the timer can speak. An
  optional hands-free "Log set" (voice / large gesture).
- **Vision.** High-contrast, large default type, dark mode by default (bright screens wash out under gym
  lights), full dynamic-type scaling, honored `reduce-motion` (celebration animation is decoration, never
  load-bearing).
- **No meaning by color alone.** Volume status and readiness always pair an **icon + label + shape** with
  the tint, for colorblind users.
- **Offline-first PWA.** The logger works fully offline and syncs later; a small, cached, low-data
  footprint runs on cheap phones (which also keeps the Cloudflare stack cheap).
- **Numeracy accessibility — the core thesis.** No one needs to understand MEV, RIR, 1RM, or "volume" to
  succeed; Beginner Mode hides all of it and the plan simply says what to do. Jargon is always
  tap-to-define, never required.
- **Reading level ~grade 7**, all jargon tappable — so low-literacy and ESL users aren't blocked.
- **No gatekeeping hardware.** Everything works from just workout logs + an occasional weigh-in; wearables,
  scales, and photos are optional add-ons. A user with a $100 phone and no watch reaches the same coaching
  at slightly lower readiness confidence (graceful degradation).
- **Inclusion.** `sex` includes intersex and prefer-not-to-say; first-class support for older starters
  (`starting-later-in-life.md`), women (`starting-out-as-a-woman.md`), teens
  (`starting-young-teens-and-parents.md`), and optional menstrual-phase tracking.
- **Psychological safety.** Bodyweight is **trend-only, never a daily number**, and fully opt-out; no
  calorie counting exists; the app can be paused entirely. `healthy-relationship-with-training-and-food.md`
  is surfaced to anyone showing risk — a deliberately reduced surface for disordered-eating patterns.
- **Anxiety accessibility.** `overcoming-gym-anxiety.md` and the equipment primer are offered *before* the
  first visit, so a frightened first-timer walks in oriented.

---

## 12. Surface → schema + derive-metrics mapping (the contract)

Every app surface reads and writes the existing data contract; **no knowledge is re-extracted.**

| App surface | Schema(s) written | Schema(s) / data read | Derive functions consumed |
|-------------|-------------------|-----------------------|---------------------------|
| Onboarding (5–6 taps) | `onboarding-profile` (7 required fields) | `data/programs/*` (template selection) | — |
| Progressive profile fill (weeks) | `onboarding-profile` (deferred fields) | — | — |
| Today card | — | `onboarding-profile`, `program-template`, `progression-rule` | `readinessIndex`, `volumeVsLandmarks`, `progressionByExercise`, `buildFeatureReport` |
| Session Player | `workout-session` (`sets`: `exercise`, `weight_kg`, `reps`, `set_type`, `completed_at`) | `data/exercises/*` (muscle map, cues), `double-progression` | `progressionByExercise`, `estimate1RM` (prefill); `proximityFromRepDropoff` (live nudge); `restTimes` (timer) |
| Starting-weight finder | `workout-session` (feeler + work sets) | `choosing-your-starting-weight.md` | — (sets the first-session priors) |
| Effort chip (advanced) | `workout-session` `set.rpe` / `set.rir`; `onboarding-profile.rir_calibrated` | `rir-autoregulation` | `isHardSet` (effort gate), `confidenceTier` |
| Session Summary | optional `daily-checkin.energy` | `workout-session` | `estimate1RM` (PRs), `progressionByExercise`, `volumeVsLandmarks`, `proximityFromRepDropoff` |
| Progress tab | `body-metric` (photos, measurements) | `workout-session`, `daily-checkin` | `perMuscleWeeklyVolume`, `volumeVsLandmarks`, `progressionByExercise`, `bodyweightTrend` |
| Nerd Mode | — | all streams | `buildFeatureReport` (full) |
| Weigh-in / Body log | `daily-checkin.bodyweight_kg` (`source: smart-scale/manual`), `body-metric` | — | `bodyweightTrend`, `classifyEnergyBalance` |
| Passive readiness (overnight Worker) | `daily-checkin` (`sleep_hours`, `hrv_ms`, `resting_hr`, `stress`, `source: wearable`) | — | `readinessIndex`, `confidenceTier` |
| Weekly Coach Check-in | — | all streams | `classifyEnergyBalance`, `volumeVsLandmarks` (deltas), deload inference (`progressionByExercise` + landmarks + `readinessIndex`) |
| Coach Moments / Glossary / Learn | — | `content/**` (10 pillars, `glossary.md`), evidence grades | — (education layer) |
| Me / Settings | `onboarding-profile` (`wearable`, `menstrual_tracking`, `dietary_pattern`, `units`, `injuries`, `priority_muscles`) | — | — |

---

## 13. MVP scope vs later

Directly inherits the data-and-learning spec's minimum-viable-data-set roadmap.

### MVP (ships the whole loop; barely works without these)

- Onboarding writing the 7 required profile fields → program-template selection.
- **Session Player** with pre-filled double-progression, offline-first logging, auto rest timer, live
  rep-drop-off nudges, one-tap swap, starting-weight finder.
- Today card (train / rest / trimmed / welcome-back states) + one Coach Note.
- Session Summary with derived wins + Chain.
- Bodyweight trend intake (manual or smart-scale) → `classifyEnergyBalance`.
- Progress tab (consistency, e1RM trend, volume dots, weight line).
- Just-in-time Coach Moments + ambient glossary + the Getting-Started beginner track.
- Weekly Coach Check-in; forgiving Chain + 2-day rule + comeback flow; minimal notifications.

> This MVP already powers autoregulated progression and energy-balance inference **on day one from logs +
> occasional bodyweight alone** — no wearable, scale, or account required.

### High-value add-ons (opt-in, post-MVP)

- Wearable sleep/HRV/RHR → `readinessIndex` and readiness-trimmed sessions.
- RIR calibration mini-game → `rir_calibrated` → RIR effort chip + RIR-autoregulation.
- Protein adherence (yes/roughly/no), soreness taps.
- Advanced/Nerd Mode, manual overrides, custom exercises (mapped to muscles so volume isn't under-counted).

### Later

- Mood/stress daily tap; measurements/photos + computer-vision progress; menstrual-phase tracking; DEXA
  uploads; n-of-1 active-learning experiments; population-learning KB feedback loop.

### Never (per the spec)

Calorie counting; carbs/fat/micros/water logging; daily-bodyweight-as-a-number; steps; subjective
"pump"/size ratings; anything computable from something already logged.

---

## 14. Feasibility on the near-zero-cost Cloudflare stack

The architecture is chosen so the whole thing runs at hobby-tier cost.

- **Cloudflare Pages** hosts the ~70 static, pre-rendered KB pages + the PWA shell — cached at the edge,
  effectively free. Education never touches a server.
- **PWA + IndexedDB** = offline-first logging on the client. The crown-jewel input never depends on the
  network; the client does the heavy lifting.
- **Cloudflare Workers (thin edge)** do only three things: **sync** (accept batched writes), run the
  **deterministic derive/autoregulate step** (`tools/derive-metrics.mjs` is pure, cheap functions — no
  per-user ML at request time), and dispatch **push**. Per-user payloads are small.
- **D1** stores the four data streams. **Writes are batched at session end** (not per set) to respect D1
  write limits and keep the app well within free/cheap tiers.
- **Cron Triggers** run the overnight recompute (pull wearable data, recompute readiness/volume/trend,
  pre-write tomorrow's card) and the weekly digest — batched, off the request path.
- **R2 / on-device** for private physique photos (default on-device; R2 only if the user opts into
  cross-device sync). Photos never become social.
- **Population learning is a batched offline job**, never real-time inference — deliberately kept off the
  hot path so scale doesn't blow the budget.
- **Graceful degradation** (no wearable/scale/account still works) doubles as cost control: the fully
  functional baseline is tiny.

---

## 15. Key risks & resolutions (carried from all three designs)

| Risk | Resolution |
|------|-----------|
| **Automation opacity** ("the app decided" erodes trust) | Always-present one-tap "why?", two-tap override, and every silent change attributed to the user's own data. |
| **Rep-drop-off effort inference misreads a sandbagging/ego-lifting novice** | Conservative starting weights via the finder, double-progression, mandatory safety/bail primer; RIR distrusted until calibrated. Biggest beginner correctness risk — watch it. |
| **Energy balance invisible without ≥3 weigh-ins** | Passive smart-scale nudge; never block; stay honestly silent rather than guess. |
| **Depth-vs-simplicity: advanced users feel capped** | Earned progressive unlocks + always-reachable Advanced/Nerd Mode + manual overrides + raw-data export. Validate with real advanced-user testing. |
| **Streak/gamification backfire → training sick/injured, or churn-inducing shame** | Weekly forgiving Chain, freezable pauses, 2-day rule, identity framing over loss-aversion; copy policed. |
| **Safety liability for never-trained users under load** | Primer, conservative loads, machine-first substitutions, "when in doubt go lighter," fail-safely education; consider heavier gating on true barbell max-effort work. |
| **Disordered-eating harm** | Trend-only weight, full opt-out of body metrics, no calorie counting, non-judgmental copy, healthy-relationship content surfaced to at-risk users. |
| **KB landmarks are Grade-C estimates** | Never presented as fact ("a good starting point; I'll learn your body"); population-learning loop upgrades them; grade chips stay honest. |
| **Notification fatigue kills the primary channel** | One weekly batched check-in + training-day reminders only; self-tapering, non-guilt. |
| **Self-misclassified experience → wrong program** | Engine quietly re-grades from observed loads/progression and swaps the template without blame. |
| **Cost/scope creep** | Static-prerendered education, offline-first local logging, thin edge (sync + deterministic derive + push), batched population learning. |

---

## Appendix — reconciliation summary (what came from where)

- **From Design A (opinionated automation):** the one-decision Today card with mutually-exclusive states;
  weight-and-reps as the only inputs; the confidence-tier-governs-tone rule; the activation north-star as
  the leading metric.
- **From Design B (don't-let-them-quit):** the 4-tab shell; calendar-scheduling as the adherence keystone;
  the weekly-consistency retention metric; the 2-day rule and forgiving weekly Chain as first-class
  features; "nailing 3 beats missing 5" honesty.
- **From Design C (a coach that just knows):** ~200 atomized Coach Moments with the three-level depth
  ladder; the Weekly Coach Check-in as a plain-language story card; Nerd Mode as an unlocked surface over
  `buildFeatureReport`; the outcome north-star (adherence-weighted progression at 6/12 months); the
  relationship-as-switching-cost framing.
- **Conflicts resolved:** tab count → 4 (B), with A/C minimalism preserved by keeping the daily user on
  Today only. Scheduling → adopted as a keystone (B) but skippable (A/C). North star → a three-tier
  hierarchy rather than one metric. Session Player → a full-screen mode, not a tab (A/B over C).
