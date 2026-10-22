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
   If no set at your working weight reaches the range (the first falls clearly short), the next
   session lightens the load so your first set lands in it (W279). A lift that comes after more
   work for the same muscles than it did last time is served lighter, and one that comes earlier is
   served heavier (W290). Nothing else moves a weight: no percentages, no calendar. The reason for
   each suggested weight shows under it on the lift's first set. The reps stepper starts on each
   set's own aim — last time's reps plus one at a held weight (W289) — and a mid-workout miss gets a
   next-set weight that allows for the reps you lose from set to set (W288).
2. **How do periodization and deloads work?** A 6-week mesocycle counted in weeks you actually
   trained: sets ramp 70% → 80% → 90% → 100% → 100% of the plan's targets, effort creeps up, and
   week 6 halves the multi-set lifts, eases loads ~10%, and sits at RIR 3–4. There are four
   distinct deload mechanisms (scheduled, reactive, per-lift comeback, event taper), each with its
   own trigger.
3. **What must be true before volume changes?** At each block boundary the engine re-reads your
   log per muscle: stalled with room below your ceiling → +2 weekly sets, but only if you're
   actually getting through the sets the plan already has for it, recovered, not in an energy
   deficit, not regressing, and not sandbagging (logged effort clearly easier than prescribed);
   over your recoverable ceiling, or stalled at it → −2. Every change accumulates and is clamped
   to the muscle's own MEV↔MRV span. (Training inconsistently? See §4a.)
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
| 3 | **no set at the anchor weight reached the range**, the first of them near failure (RIR unlogged or ≤ 1): **≥ 2 reps short**, or 1 short twice running at the same or a heavier weight (each earlier session judged against the range *it* was done in) | **eased** to the load that lands that first set at the range's bottom (Epley e1RM, at the band's near edge), floored to the lift's increment: at least one increment down, at most ~20% (when that cap binds, the note says the first set may still fall short). A *first* one-rep miss holds, with a warning (W279) |
| 4 | logged RIR ≤ 0 without hitting top of range | hold — build reps first |
| 5 | every set at the anchor weight hit the top of the range | +**2.5 kg** (isolation dumbbell/cable: +**1 kg**) — but only when every **prescribed** set was done: a skipped set or a workout ended early holds the weight until a full session shows it (the workout carries its plan as `targets`, W280) |
| 6 | otherwise | hold — add a rep or two |
| + | **after** the rule above: the lift's position differs from the anchor session's by **≥ 2 weighted sets** of same-muscle work before it (both read from the **plan**: today's day and the anchor's own day) — never for a comeback, a taper or added bodyweight load | the weight carried to today's position (W290, below), rounded to the **nearest** step; the reason says so |

Rule 3 is the KB's own double-progression rule ("pick a weight you can do for at least the bottom
of the range", Grade D), applied when a set proves the weight wrong. It is judged on the first set
at the anchor weight, and only when none of them reached the range: a later set's fatigue drop-off
is normal, not evidence. It never fires during an event taper (loads hold) and is never tagged as a
comeback, so the eased weight anchors the next progression normally.

**Exercise order (W290, Burst 5).** An exercise done later in a session gets fewer reps on every
set (Simão et al. 2005; review 2012 — [exercise order](../content/01-training-variables/exercise-selection-and-order.md),
Grade B for the acute effect). Before a lift, each earlier lift of the planned day counts its sets ×1
when its primary muscle is this lift's primary, ×0.5 for a primary↔secondary overlap. Each weighted
set costs **5%** of the lift's rep capacity, at most **25%**, and a difference under **2** weighted
sets — or two positions that cost the same (both at the cap) — is ignored. Engine estimates, not
findings. The weight moves from its own grid by whole steps: never the wrong way, never at all under
half a step, never under the empty bar for a barbell lift. A lift swapped in for today reads its anchor
from the stored plan — unless it was appended by a second today-swap, whose position is unknown. When the
weight can't move (under half a step, or the bar), the position still shapes the aim and is added to
the weight's own reason as its own sentence. Every sentence reads "This time it comes after… (last
time…)", so it is right on Today and in the read-out's "next time" (Burst 5 review). Both positions come from the plan with its planned
sets, so a stable slot never moves, a deferred lift never drifts and the wave's set ramp never nudges
a plate. The capacity converted is the one **at the base rule's weight** in the anchor's position (from
the anchor's e1RM), so an earned step up and a position change never compound; rounding to the
nearest step keeps alternating days from ratcheting down. A first-time body-scaled estimate gets the
same discount for today's position (never under the empty bar). Measured on generated plans, repeated
lifts usually have similar same-muscle work before them (Δ 0–1.5 for intermediates), so this mostly
moves weights in advanced plans, hand-built plans, swaps and first-time estimates.

**Each set's aim (W289).** The reps stepper starts on a per-set aim, from last session's sets in order:
at the same load, last time's reps **+ 1**, capped at the top of the range (150×5,4,5 → 6 · 5 · 6); at a
moved load (a bump, an ease, a deload, the order rule), each set's capacity (reps + RIR) carried to
today's load by Epley, less the band's near edge. The "+1" is for the same effort: when today's band
sits further from failure than the band last time's session was served with (a taper, a block's first
week — its stored target), the aim is last time's reps less that shift. A comeback's eased row keeps
last time's reps (the ease is the point). A set that is no evidence at today's load (a ramp set under
the lighter of today's weight and the anchor, a back-off, or a heavier set that failed the range) is
read as the nearest earlier set that is (the first one for a leading ramp), so set k stays aligned with
last time's set k and a later aim never climbs back to the freshest set's. At the same load with a
position change (W290), the aim keeps its "+1" less the position's cost in reps.

**The reason is composed (Burst 5 review).** The weight's own reason leads: the progression's, the
W279 two-strike warning, W280's "get all 3 to the top", "you hit failure". The band and the position
that shape today's aim are added as their own sentences, each naming only its own fact ("This week
asks for 2–3 reps in reserve, 1 more than last time. This time it comes after 2 sets that also work
your chest (last time it came first). The rep aim allows for that."). The generic "add a rep or two"
gives way to "Same weight as last time." when a sentence lowers the aim, and so does any hold's ask
("You did 3 of 4 sets last time — same weight.", "You hit failure last time — same weight."): an aim
under the top can't sit beside "get all 4 to the top". The band sentence appears only where the aim
applies the band (not on a weighted bodyweight lift whose load moved). The deload ease keeps its own
note, and a position that moves the weight leads with it ("…so I've made it 27.5 kg."). The aim is derived from the row
and the banked count on every render, never stored, so a resume lands on the same number; once you move
the weight off the served one (by half the lift's own step or more: 1 kg on a dumbbell isolation, a
5 lb plate in pounds — a kg/lb toggle doesn't count: it re-stamps an untouched served pre-fill exactly
in the new unit), the stepper carries your last banked reps instead.

**The next set allows for fatigue (W288).** The mid-workout "more appropriate weight" carries the banked
set's capacity to the next set **less what the next set loses**: ~20% after a set ending at ≤ 1 RIR (or
unlogged), ~10% at 2–3, none from 4. These are engine estimates. The cited studies (Richmond & Godard
2004; Willardson & Burkett 2005/2006 — [rest periods](../content/01-training-variables/rest-periods.md),
Grade B for "reps fall on the next set") took every set to failure, so the 2–3 and 4+ tiers are
extrapolations. 70×5 at failure on 6–10 / 1–2 now says 62.5 kg; the fresh-set formula said 65, which after
a failure set leaves ~6.7 reps in the tank. "Use X kg" fills the reps the same model predicts at the
weight actually offered (a pounds user's next 5-lb plate, not the kg it rounds from), kept in the range
(7 there), and the "heavier" hint never offers a step the model says would land under the range. Added
load on a bodyweight lift is not the whole load, so none of that Epley applies there: its hint aims at
the range edge it moves toward. A set that met its own aim (W289) at the effort that aim assumed (effort
unlogged, or at least the band's near edge) is never called a miss, even when the aim sits under the
range; whether the aim applies is judged by the weight that set was banked at (Burst 5 review).

Details that matter: the anchor is the **heaviest weight with a set that reached the bottom of the
range** that session was done in (set 1's weight when none did), and reps/RIR are judged **only over
the sets at that weight**. A lighter back-off set is a different load, not evidence (Wave 258), and
a heavier set that failed the range (a one-off heavy single) never anchors. So taking the player's
own mid-workout "go heavier" hint (W279b) carries forward instead of being thrown away (Burst 1
review). In pounds, a weight the engine moves always moves at least one 5-lb plate on screen: a
1 kg step (isolation dumbbells and cables) is under half a plate, and rounding used to pre-fill the
very weight just lifted, so those lifts never progressed for a pounds user (Burst 1 review).
Deload- and comeback-tagged sets never anchor progression and never enter the strength trends, so
an eased week can't drag your history. During a deload week the suggestion is
`min(normal suggestion incl. the order rule, last weight × 0.9)`, and when that lowers it the reason shown is the
deload's, never the progression's "add 2.5 kg"; during an event taper the load holds entirely.

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
| **Scheduled** (week 6) | five trained weeks in the block | sets ×0.5 (floor 2), load `min(suggestion incl. order, last×0.9)`, RIR 3–4 |
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
stalled and below MAV.max       → +2 sets, IF getting its planned sets AND recovered AND not in
                                   a deficit AND not regressing AND not sandbagging — else hold, and SAY WHY
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
- "Getting its planned sets": see §4a.

## 4a. When you're inconsistent (owner consideration #1)

*"The program follows a 6-week block, but how does it adapt when someone misses workouts or
doesn't finish them?"* Measured against the code, not assumed:

- **The block waits for you.** Its clock counts weeks you trained (§2), so a missed week is a
  pause, never a skipped week of the wave. Partial weeks still count as trained weeks.
- **Nothing is dropped.** The session rotation moves with you: miss Tuesday and Tuesday's session
  is simply next (§6). Every muscle keeps its share of the plan however your weeks fall.
- **Unfinished sets hold that lift's weight increase** until a full session shows it (W280, §1
  rule 5), and a set you skip is recorded as skipped, not as a failure.
- **The gap was here (fixed in Burst 2):** the tune reads each muscle's *peak* week, so one full
  week vouched for a block of half-weeks, and flat lifts on half the work read as a plateau. A
  4-day plan done 2 days a week with flat lifts earned **+2 sets on all 10 muscles** and had **9
  stalled lifts swapped out** (measured through the real block rollover). More sets on paper, and
  a fresh exercise that resets progression, for someone who wasn't getting to the sets already
  planned.
- **Now a completion test runs first** (`completionShortfall`): each muscle's *mean* weekly sets
  over the last 6 trained weeks against the sets the plan delivers (`projected_sets`) × the block
  wave's average scale (so someone doing every set reads ~100%). Below **70%** the muscle is
  "not completing". Its stall **holds** instead of +2, its lifts are **kept** (not swapped), and
  the new-block note and Progress card say so in plain words, with the lever: get through more
  of the planned sets, or set fewer training days and the plan is rebuilt around them. Three of
  four sessions every week reads ~75% and still earns its +2. A hand-built plan is never judged:
  its stored numbers may not describe it.
- **"Most weeks" needs most weeks.** No verdict on fewer than 3 finished trained weeks, and the
  week in progress is never judged (it's partial by definition). Without that, a first workout
  was told "most weeks you get 19% of your sets" (caught by the W282 walkthrough).
- **Only the current plan's weeks count.** The sample starts at the week the block started, and
  every real training change resets it. Otherwise a lifter who did every set of a 3-day plan and
  rebuilt to 5 days was told they skip most of their sets (W282 review).
- **The boundary's verdict is the block's.** The muscles it spares are stored with the block
  (`plan_meta.spared_muscles`). Every rebuild in that block (a Settings save, a permanent swap,
  the substitute ranking) spares the same lifts through one door (`swapStalls`). A units-only save
  right after a boundary used to swap out every lift the boundary had just kept (W282 review).

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
- Session order is a rotation (sessions completed modulo plan length, plus your skips and
  day swaps). Since Wave 277 the app **projects** it onto your committed weekdays and shows
  where it lands: Today's week strip ("Mon ✓ Push A · Today · Pull A · Fri · Legs A"), the
  done line ("Next: Friday — Legs A") and "Up next" on the Plan tab all read the one rotation
  pointer. A miss never drops a session: the week slides along and the strip says so ("Legs A
  starts next week — nothing gets dropped"). "Legs always lands on Monday" therefore holds
  exactly when you commit as many days as your plan has sessions and train each of them —
  the only case where it can hold without dropping a session. Weekday pinning was measured
  and rejected: a chronically missed weekday took the muscles trained only in that day's
  session to 0% of their weekly volume, where the rotation keeps every muscle at (n−1)/n.

## 7. Where you see each mechanism

Every lever above has a surface: the per-exercise suggestion note (progression, comeback, taper
holds, the order rule — shown under the weight on a lift's first set since Burst 1), the per-set aim
(the reps stepper's start, and "Today's aim: 6 · 5 · 6 reps" on a lift's first set, W289), the
next-set hint (W279b/W288), the block card (week/phase +
deload notes), the plateau card (deload-brought-forward / push-harder / adding-sets /
**held-for-recovery** since Wave 258 / **not-a-plateau** for missing work since W282a), the
**post-workout read-out** (W282: what happened, from the workout itself, works offline; what it
means, from its own door after the save lands. That covers today's aim and each lift's next
weight. The weight is computed for the week that lift's next session falls in: committed days
left, or days per week minus days already trained. It's exactly what that session serves, pinned
by a promise test that checks next-week weights a week later. No weight is promised into a new
block. Then this block, and from week 4 what the boundary would decide if it came today. Block
lines show only while the workout is still this week. A queued workout's read-out reaches Today
once it syncs, and History offers it for the latest workout), the reduce card (over-ceiling),
the regression card, the new-block coach note (rotation, tune deltas **and holds**, real swaps),
the plan screen's per-muscle reasons ("adaptive: +2 sets from your logged response"), and the
graduation note, and **Nerd Mode** (W284, a Progress toggle): every muscle's sets against its
landmarks, the block's maths, the boundary's own next-block decision (parity-tested against the
rollover), and each lift's strength numbers. Still computed-but-unsurfaced, deliberately:
`readinessIndex` and `confidenceTier` (they need HRV/sleep-hours data the app never collects).
