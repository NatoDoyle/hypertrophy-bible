# Roadmap — the distance to the four goals

This is the loop's **work queue**. It exists because the loop drifted into low-leverage
citation maintenance while treating a mature-*looking* codebase as "nearly done." Measured
against the four goals in `improvement-loop.md`, this project is **early-stage**. Pull the
next build from here (Tier 1 first); drop to marginal polish (single-citation currency,
cosmetic tweaks) ONLY when a genuinely high-value gap appears — never as default filler.

Grounded assessment date: **2026-08-24** (Waves 240-241: the self-audit of the
Waves 237-239 engine burst found **five confirmed defects — all mine, headed by
the last-chance coverage floor zeroing beginners' abs on the default onboarding
profiles** (the guarding test's grid never generated a beginner), and my own
commit's "majors clear MEV" claim measured mid-implementation and false on the
shipped code. Fixed: a bounded SPILL rule (zero-volume configs 127 → 55, better
than the pre-tier 63; the unguarded first cut was caught by the Wave-15
invariant re-creating the isolation takeover — the old tests defending against
the fixer), the Progress tab joining the SECONDARY_SERVED tier (it was telling
users to "add volume" to the muscles the plan screen calls "covered by
compounds"), advice levers derived from the same constants that clamp the
budget (a beginner's 45- and 90-minute plans are byte-identical, so "longer
sessions" was a dead lever), per-muscle secondary-served rationale (forearms is
a grip story set-counting can't see), and live-engine first-session-cap
coverage restored. See lesson 63 and telemetry 7n.) The prior grounding:
(Waves 237-239: the owner's
program-engine report, measured claim by claim (lesson 36) and mostly confirmed —
the generator was contradicting the KB's own prose. back.md and arms.md both say
erectors/forearms need no default direct work, yet every Upper day carried a wrist
curl and every int/adv lower day summoned conventional-deadlift FOR spinal-erectors
beside the hamstring RDL; and the weekly-coverage floor ran on every session, so
each archetype's first day fragmented into 2-set placements (36% of all generated
days) while day B accidentally got the intended shape. One exported
`SECONDARY_SERVED` tier + a last-chance coverage floor fixed both (fragmentation →
7.5%, median 5 exercises/day, majors clear MEV on the flagship profile, RDL owns
the hypertrophy hinge with conv-deadlift now a strength-goal lift), and the
critique now speaks in CAVEATS on the app's own untouched output (was: "N things
worth fixing" on 120/120 fresh plans) while keeping the full guard-rail for hand
edits. Refuted and recorded: 1-set exercises are specialization maintenance
micro-doses by design; the kettlebell side bend is core.md's own pick. Fresh
beginner plans now open at ≤4 exercises structurally — the KB's "20-40 minutes is
plenty" delivered by allocation rather than by trim. See lesson 62 and telemetry
7o.) The prior grounding, same day: (Waves 234-236: the self-audit of Waves
230-232 confirmed **six defects** — five from the one finder that survived a
session limit (5-for-5, a first), one from inline reading, and the inline one was
the severe one: **stopping `hb_email` from being planted on SEND (Wave 230) did
nothing for every install the old code had already mislabelled** — a user who
never clicked their link kept "✓ signed in / your progress is saved" over an
account that does not exist, a false backup promise living in localStorage where
no migration can reach it (lesson 61). `/api/adherence` now carries the server's
own `account_email` and the client reconciles against it, verified in a real
browser by planting the stale flag and watching it clear. Also fixed: D1's
"deterministic" address pick was really last-row-in-SQL-order, with its own
regression test passing only in the lucky insertion order (lesson 54 — which then
also caught my first replacement fixture); the first-timer greeting still keyed
on `day_number`, a sibling field of the exact filtered-list premise Wave 230
fixed; the readiness notes contradicting the first-session trim on the same
screen; an unbounded whole-sessions-table scan at the head of both sweeps; and
custom lifts shipping as raw slugs in the plan email. Push subscriptions: unread
this iteration — no STATS_KEY is available locally (BLOCKERS #10 is the
30-second fix); the 2026-08-21 reading, still 0, stands. The prior grounding was
2026-08-21, Waves 230-232: a self-audit that found
**eight defects, seven of them mine**, and the completion of the KB traversability
work. The audit's theme is one false premise propagating: "no DERIVABLE sessions"
is not "never trained", so a user whose only workout is voided or carries a legacy
unparseable date was emailed "your first session, whenever you want it" AND shown a
day-one beginner card — while History displayed that same workout under a "Date
needs correcting" banner (lesson 58). Also: a kg/lb toggle was reaching the
plan-REBUILD door and silently destroying hand-edited plans (lesson 59); three
pieces of shipped copy promised things the code did not do, including an email card
offering "your week" wired to a bare magic link (lesson 60); and my own Wave-224
"parity fix" turned out to be built on a false premise and was reverted with the
reasoning recorded. **Wave 231 finished what Wave 221 started:** supplements and
muscles now open in-app sheets, so `supplements.md` — the corpus's worst
dropped/live ratio, and the page whose SAFETY notes were unreachable in-app — is
fully traversable. Invisible links **50 → 30**, reconciliation conserved at 122,
and no class reached zero (every remaining data drop is a directory link, which has
no id to open). Push subscriptions: still 0. The prior grounding was 2026-08-19, Waves 224-229: one full turn, prod ==
main. **The headline result is a premise that dissolved.** The previous grounding
called 9.6% activation the project's frontier. Building the instrument to split
those 122 users showed the number cannot bear that weight: `tz_offset_min` — the
only proxy for "reached the Today tab" — is written by a header that shipped
2026-08-04, so **125 of 135 users predate the instrument** and the measurable
cohort is **10**; and `onboards_by_day` puts **84% of every onboard in
2026-07-15..07-26, the fortnight this repo took 266 commits**, collapsing to ~1/day
after, with a single IP holding 25% of the rate-limit markers. **The 135 are
dominated by our own development and smoke traffic.** There was probably never an
activation failure — there was an unexamined denominator (lesson 55). Smoke traffic
tags itself from now on and `app/scripts/prod-smoke.mjs` is what carries it, so the
next reading is honest by construction. Two build waves shipped anyway, because
both were chosen on the "right even if the number is noise" test (lesson 56): the
engine contradicted the KB's own *"a first session of 20-40 minutes is plenty"* and
now serves a beginner 4 exercises on day one (Wave 227), and five verified locks
left a never-trained user unreachable on EVERY channel simultaneously, now closed by
one activation email, an email ask at peak value, and a commitment card that no
longer promises a push nobody has (Wave 228). The self-audit found the previous
burst's flagship fix never worked (lesson 57) and that its two regression tests were
built so they could not catch it. **Push subscriptions: still 0.** The prior
grounding was 2026-08-18, Waves 217-223: one full loop turn, ending
with prod == main. The **un-landed Waves 213-216 burst** (draft PR #299, 1507
insertions, never audited or deployed) was audited before it shipped — **ten
confirmed defects** fixed as Waves 217-219, headed by a wholesale profile patch
that could forge `following`/`challenges` past four route guards, and a D1 merge
that ran its whole batch with no precondition. Then Waves 220-222 off fresh main:
the citation gate's exclusion rule was disarming the anti-fabrication guardrail;
`app npm test` was silently skipping the only coverage of the production store;
and **the KB's densest cross-references became traversable** — the 7 muscle
guides' ranked pick lists now open the app's own exercise sheet (invisible links
**122 → 50 dropped + 72 traversable**, reconciled). **The new Goal-4 ground truth,
read live 2026-08-18 after rotating STATS_KEY:** 135 users · 13 ever trained ·
**122 onboarded and never trained — activation 9.6%** · 0 active/7d · **0 push
subscriptions** still · and the one new signal, **median days-to-first-session = 0
(n=5)**: whoever trains, trains the same day they onboard. The frontier is
therefore **activation**, not retention mechanism — every adherence feature this
project has built sits downstream of a door ~90% of people never walk through.
Note `users_unclassified: 135`: the loop's own prod smokes have always used the
same door that creates a user row, so the historical denominator cannot be split,
and that split was deliberately not invented. Smoke traffic tags itself from now
on. The prior grounding was 2026-08-14, Waves 209-212: under the owner's blanket
go-ahead, four human-blocked items shipped as code — the health & safety note (#5),
the owner stats endpoint (#7), recorded push-delivery evidence (#2b's server half),
and the merge tombstone (#6b) — plus #8's honest email footers. **The stats
endpoint's first live reading is the new ground truth for Goal 4:** 135 user rows ·
13 ever logged a session · 1 active in the last 7 days · **0 push subscriptions**
(lesson 48). The frontier is now adoption/distribution and the remaining human
BLOCKERS (#1 media, #2b subscribe-on-a-phone, #3 donations, #6 elite ground truth),
not more mechanism. The prior grounding was 2026-08-13, Waves 206-208: the Waves 203-205 self-audit
shipped two confirmed fixes — the merge-door celebration re-earn and the honest
movement-gate blind-spot measure — and **the first dedicated KB currency sweep ran
(Wave 207)**: 8 topics, 75 PMIDs screened, 5 dual-verified additions across 4 hot
pages, registry 139 → 144, honest nulls recorded for sleep/protein/frequency.
**Currency horizon: PubMed swept 2026-08-13 over a 2025/06–2026/08 window** for
volume / failure / muscle-length / frequency / protein / mechanisms / sleep /
periodization — the next sweep is gated on literature NEWER than that window, not
on the calendar. Tier 1 remains empty; the 2026-08-07 re-audit verdict still
stands. The prior grounding was 2026-08-09, Waves 203-205: the Waves 201-202 self-audit
shipped one confirmed fix — lesson 47 — and **Tier-1 #1, the
prose-recommends-a-liftable-movement gate, SHIPPED and ENFORCED (Wave 204), emptying
Tier 1 again**. The 2026-08-07 goal-distance re-audit's verdict STANDS — two days and
three waves changed nothing material about the frontier, so it was not re-run as
churn: the binding constraints on all four goals remain the human inputs in
BLOCKERS.md (#1 media, #5 disclaimer, #6 elite ground truth, #7 the analytics values
call, 2b the real-device push check) plus Tier-2 cadence work gated on new
literature. The prior grounding was 2026-08-07, Waves 201-202: Tier-1 #3 — every social
event reaches a device — SHIPPED and prod-smoked; **Tier 1 emptied and the scheduled
goal-distance re-audit RAN** — its verdict is the Waves 201-202 progress entry below,
and Tier 1 is repopulated from it. The prior grounding was Waves 198-200: Tier-1 #2 —
multiple concurrent challenges — shipped and prod-smoked. The prior grounding was Waves 194-197: Tier-1 #1 CLOSED — the depth
gate now ENFORCES with every flag authored or justified; the prior grounding was
Waves 190-193: a self-audit of the prior burst
plus its two deferred items — the tz/challenge hypothesis and the never-ending
specialization block — and the last muscle-guide rebuild; the prior grounding was
Waves 186-189: a diff-scoped correctness audit of
`8f488cf..HEAD` plus the chest.md depth rebuild; the prior grounding was Waves 173-176:
`5171a37..HEAD` plus the KB's first DEPTH measurement; redo when a tier empties).

## Honest distance to each goal

**Goal 1 — world's best knowledge source: FAR.** The recently-waved "hot" pages
(`mechanisms`, `volume`, `proximity-to-failure`) are genuinely world-class — and as of
Wave 207 they carry the 2025/26 literature (the 2026 ACSM position stand, the
297-participant lengthened-partials RCT, the Phillips-lab mechanisms review), with a
recorded currency horizon so staleness is now tellable from done. The whole KB
rests on **144 verified sources** (2026-08-13; 131 on 2026-08-04, ~110 for several waves before) —
MASS reviews ~150–200 studies/year; Schoenfeld's textbook cites hundreds. Coverage is bimodal:
most of the 24-page `09-getting-started` pillar is practical/logistics content with no gradeable
claims to cite (not a gap — see Tier-2 #6's reassessment); `energy-balance` and `sleep` are now
cited (Wave 92/95), and `weak-point-prioritization` picked up 4 citations (PR #184).
`breaking-advanced-plateaus` and `long-term-and-annual-planning` stay honestly Grade C/D —
planning heuristics no trial has directly tested, not an oversight. The **7 muscle guides —
the product backbone** — were 480–893-word quick cards for most regions; the three that
carry the most traffic are now full region-by-region treatments (back.md Wave 93,
**chest.md ~1300w Wave 188, shoulders.md ~1640w Wave 190**), and **no muscle guide
remains on the rebuild list** — the rest were reassessed as genuinely adequate
(Waves 95/123). Worth carrying forward from those rebuilds: its prose recommended a movement
(“low-to-high cable fly”) that **has no entry in `data/exercises`**, so the app could
never program its own KB's advice. Nothing measured that, and nothing does yet — a
prose-recommends-a-liftable-movement check is a candidate gate whenever a guide is
touched. Missing whole
topics: fiber-type×rep-range and tendinopathy were checked and are NOT gaps (already covered);
menopause/HRT and pregnancy/postpartum shipped (Waves 89/91). Supplements: 15 entries now
(creatine, caffeine, protein, beta-alanine, citrulline, HMB, BCAAs, EAAs, vitamin D, omega-3,
ashwagandha, glutamine, ZMA, tart cherry, testosterone-boosters) — this breadth item is done.
"Every claim web-verified" is materially higher than "a third of the surface" now, but still
short of comprehensive. **The re-audit this paragraph kept asking for happened (Waves 173-176)
and changed the question**: coverage was never the binding constraint — DEPTH was, and nothing
measured it. `npm run depth` now does (Wave 175), and it found 8 pages below the corpus word floor
and 12 giving essentially no numbers at all, while every existing gate stayed green. Judge Goal 1
against that report from here, not against a source count.

**Goal 2 — best coaching app, novice → Mr. Olympia:**
- *Bottom end + Goal 3 (zero cognitive load): the YouTube punt is gone.* Onboarding and the
  crash-safe player are strong, and the app no longer sends a never-trained user off-app to a
  raw YouTube search — v0 inline line-art movement demos now ship on the set screen (Tier-1 #3,
  below). Real per-exercise footage is still the eventual bar (BLOCKERS.md #1, blocked on
  licensed/filmed media) and the v0 glyphs are a generic stand-in, not real form video — so this
  is real progress, not a closed gap. (The other novice-friction items this paragraph used to
  list — specialization question shown to beginners, the Fuel tape-measure wall, RIR jargon,
  day-1 emphasis — are already resolved per Tier-1 #4 below; don't re-list them here as open.)
- *Top end (elite): FAR.* The engine runs one linear mesocycle wave + block-boundary volume
  auto-tune + a specialization cap. No block/undulating/conjugate periodization, no
  peaking/taper/contest-prep, no velocity/advanced autoregulation. A serious intermediate
  outgrows it.

**Goal 4 — adherence by every means (the STATED top priority): FAR, and least developed.**
Has the skeleton — forgiving weeks-streak, XP/levels, session-count milestones, comeback
email + push, at-risk warnings. Much of the high-powered space is now built: variable/intermittent
rewards (lucky-set XP, Wave "cloud loop"), **PR/achievement celebration** (Waves 79–86), a "when
will you train this week?" commitment device (Wave cloud loop), a **user-held streak freeze**
(Wave 96 — earn a token per ~4 trained weeks, hold up to 3, spend one to protect a missed week;
reuses the walker's neutral-week path so it can only bridge, never break), and **timezone-aware
push timing** (Wave 97 — the commitment-day nudge now fires at ~17:00 the user's LOCAL time via an
hourly sweep gated per-user, instead of 16:00 UTC for everyone; email cadence unchanged). The
proactive habit-cue is now delivered (a commitment-day nudge at a sensible local hour).

**Social is no longer the untouched lever this paragraph used to call it** (verified against the
code, 2026-08-04): share cards, cheers, training partners, a mini-leaderboard, mutual-only nudges,
1v1 weekly challenges with history, the referral follow-loop, RFC 8291 payload-encrypted push for
five social event types, quiet hours, and an email fallback for push-less users have all shipped.
Both items that paragraph used to scope are now SHIPPED: **multiple concurrent
challenges** (Waves 198-199) and **push for every remaining event — new follower,
PR, level-up, streak milestone, plus the comeback on the push channel** (Wave 201).
The mechanism layer of Goal 4 is built out; what the 2026-08-07 re-audit found
genuinely open was that **nothing measures the goal itself** — closed Wave 210:
`GET /api/stats` (BLOCKERS #7's proposal, shipped under the owner's go-ahead) now
reports the goal's own numbers. **First reading, 2026-08-14:** 135 user rows ·
13 ever logged a session · 1 active in the last 7 days · retention n/1 · **0 push
subscriptions** — i.e. every push mechanism this section lists currently reaches
nobody on the push channel (email fallback only), because no real device has ever
subscribed (lesson 48). The honest conclusion: Goal 4's binding constraint is no
longer mechanism *or* measurement — it is **adoption**, which is a distribution
question mostly outside the loop's reach (BLOCKERS #1 demo media and the owner's
own sharing of the app are the levers). Judge future Goal-4 work against these
numbers moving, not against feature count.

## Build queue (pull from the top)

### Tier 1 — highest leverage, buildable now

**Tier 1 was empty as of 2026-07-31** (items 1–5 all shipped, Tier-2 6–8 reassessed done).
The considerations #1/#2 audit (Waves 162–169) refilled it and then cleared it again — the
ten confirmed findings are all shipped; see `docs/considerations.md` for the write-up. What
that audit leaves genuinely open, in priority order:

- **[Goal 2 elite] The effort/RIR lever — SHIPPED (Wave 171).** Both halves in one wave,
  exactly in the order this item prescribed (signal first, then the lever). The signal:
  the buried `hb_rir` opt-in became a one-tap "Reps left in the tank?" chip row (0/1/2/3/4+),
  default-visible for non-beginners (tri-state `hb_rir`: force-on/force-off/auto), **never
  pre-selected — an unanswered set sends no `rir` at all** (the old stepper auto-seeded 2,
  which would have fabricated "at target" data and blinded the lever permanently; a new
  `sess.eff` state key makes old crash-mirror blobs' seeds unreachable). Beginners never see
  it (KB: novice RIR calls are noise) and inherit it at Wave-164 graduation. The lever:
  `effortSignal` (derive-core, shared-classifier `effortBandTop` with plan-core's
  prescription) marks a muscle "too easy" only on positive evidence (≥10 logged sets in the
  last 6 trained weeks averaging ≥+1 over the KB tier target, deload sets excluded);
  `deriveVolumeAdjust` then HOLDS a too-easy stalled muscle instead of adding sets, and the
  plateau card says "push closer to failure" via `volumeResponse`'s new `"effort"` signal —
  the KB's own volume → effort → deload → variation order, finally complete. Absent effort
  data is byte-identical to before, locked by regression tests at all three layers
  (derive/coach/routes). Also in the wave: `normalizeSet` now clamps `rpe` and drops
  non-finite effort values (lesson 27's sibling fields), and the never-read `rir_calibrated`
  came out of the onboarding schema (lesson 14). Design record: `adaptive-algorithm.md`
  Increment C.
- **[Goal 1] Cross-user learning** (`adaptive-algorithm.md` far vision) — still needs a
  multi-user dataset that doesn't exist yet, under the honesty guardrail (noisy aggregates
  must never override a Grade-A landmark).
- **Audit follow-through:** the graduation thresholds (Wave 164) and the reactive-deload
  bounds (Wave 165) are practice-based Grade-D choices made on no direct evidence. They're
  labelled as such in the KB, but they're the two numbers in this burst most worth
  revisiting once there's real usage data to check them against.

**Waves 178–184 progress (2026-08-04, same day).** The iteration that followed did the
diff-scoped lesson-3 review of its own predecessor and then pulled from this tier:

- **KB depth (item 1): 4 of the named pages cleared.** `program-templates` (its five
  template links rendered as PLAIN TEXT in the app — a page promising worked programs
  gave an in-app reader five names and no prescription), `splits`, `what-to-track` and
  `assessing-progress` are all off the report; `recovery-modalities-and-injury` gained
  the verdict table it had been promising. **Depth: 17 pages / 23 flags → 14 / 17.**
  Graph edges 314 → 334, median out-degree 3 → 4. Registry 131 → 134.
- **Still open from item 1** *(updated 2026-08-07)*: the muscle-guide rebuilds are
  **all done** — `chest.md` (Wave 188) and `shoulders.md` (Wave 190). The
  both-tells shortlist is now **3** entries, and all three need a recorded *exemption*
  rather than authoring (two myth pages and a returning-lifters page — a rebuttal built
  on null findings has nothing to quantify, lesson 13), per the re-specified flip
  criterion below.
- **Invisible-link baseline recorded:** 69 rendered-but-untraversable links across 13
  pages, now reported by `npm run depth`. NOT a failure condition — `back.md`, the
  roadmap's own exemplar, has the most of any page and degrades fine.
- **New, from `docs/considerations.md`:** the specialization question is gone (derived
  from the KB's own rule now), and the plan screen shows **"What your answers changed"**.
  The owner's report that "the plans don't seem to change much" was mechanically refuted
  (measured: chest 7→10 weekly sets on a priority, 7→14 in a block; dumbbell-only shares
  ~33% of its lifts with a full-gym plan) — but nothing had ever *told* the user, and
  invisible personalization is indistinguishable from none.
- **Items 2 and 3 (multi-challenge, the social events with no push) remain untouched
  and cloud-eligible** — unchanged and still correctly scoped.

**Waves 240–241 progress (2026-08-24). The engine burst's self-audit: five
confirmed, all mine; the coverage floor's deferral had zeroed beginners' abs.**

- **Wave 240.** (a) The spill rule: when the muscles one session from their last
  chance outweigh the final day's budget, a bounded few rescues (setBudget/4,
  tail-of-order first) fire early — under a compound-reserve so the spill can
  never re-create the Wave-15 isolation takeover (the unguarded cut did, and the
  old invariant caught it). Beginner defaults get their abs back; zero-volume
  configs 127 → 55 across 600, all remaining warned and structural. The
  invariant test's grid now generates beginners. (b) Progress joins the
  SECONDARY_SERVED tier — status "covered by compounds", no "add sets" advice
  for tier muscles; stored pre-tier rationales keep their old honest statuses
  (lesson 41 respected). Legend updated. (c) `volumeLevers`: advice offers only
  levers that BIND, shared by generator warnings and critique caveats. (d)
  Forearms' rationale tells the grip story instead of claiming countable
  coverage set-counting contradicts. (e) The first-session cap's "every
  combination" comment corrected and its live-engine door re-tested (a 4d
  dumbbell-only beginner opens at 6). Plus: needy-first residual ordering
  (aggregate MEV deficit 1903.5 → 1886.5; the two-level water-fill was tried,
  measured at ~0.2% further, and deliberately NOT shipped — recorded in code so
  the margin isn't re-chased), and an aggregate flagship distribution pin
  replacing the single-muscle pin my own mid-implementation claim hid behind.
- **Wave 241 (LEARN).** Lesson 63, telemetry 7n, this entry.
- **Evidence:** 169 plan · 95 derive · 79 coach · 361 route · app chain exit 0 ·
  root exit 0; five tampers each red on exactly their own test; 3/3 Progress
  browser checks; the finder's three refutations recorded.

**Waves 237–239 progress (2026-08-23, second turn). The owner's program-engine
report: the generator contradicted the KB's own prose, and the critique
red-flagged the app's own output.**

- **Wave 237 (the engine).** One exported `SECONDARY_SERVED` tier (forearms,
  spinal-erectors — each with the KB's "only if it lags / unless prioritized"
  clause quoted at the definition) carried through generator AND critique;
  prioritizing the muscle restores full direct work. The weekly-coverage floor
  now fires only at a muscle's LAST chance, so day A concentrates 3-4-set doses
  and day B leads with the rest — the KB templates' own A/B shape. Measured
  end-to-end: fragmented days 36% → 7.5% of 480, median 5 exercises/day,
  conventional-deadlift 13 placements (11 on strength plans, where
  barbell-first is correct), chest/lats/side-delts/biceps clear MEV on the
  flagship intermediate 4d/60m profile. Fresh beginner day-ones are ≤4
  exercises structurally, so the first-session trim's tests moved to
  deliberately legacy-shaped stored-plan fixtures (lesson 45).
- **Wave 238 (the framing, consideration #2 verbatim).** `critiquePlan` gains
  `generated: true`: on the app's own untouched output, shortfalls render as
  constraint caveats naming the lever ("an extra training day, or longer
  sessions..."), info severity, builder's-voice summary — never "worth fixing".
  Hand-edited plans keep the critical framing byte-for-byte. Plan screen
  renders the new "covered by compounds" status only beside a real indirect
  dose.
- **Wave 239 (LEARN).** Lesson 62, telemetry 7o, this entry; both considerations
  deleted per the owner's rule with refutations recorded in the file's note.
- **Evidence:** 166 plan · 95 derive · 359 route · 199 parity · 78 coach; four
  tampers each red on exactly their own test; 6/6 browser walkthrough; root
  gate green (the dead-import gate caught a leftover import of mine).

**Waves 234–236 progress (2026-08-23). The Waves 230-232 self-audit: six
confirmed defects, headed by a false backup promise no migration could reach.**

- **Wave 234 (account truth).** `/api/adherence` now answers "does this user
  actually have an account" (`account_email`, via ONE shared `preferAccount` in
  `merge-profile.mjs` — the per-store copies had already diverged in effect); the
  client adopts or clears `hb_email` against it, so installs the old set-on-SEND
  code mislabelled stop claiming a backup that does not exist. D1's per-user
  address pick genuinely keys on `verified_at` now (it was last-row-in-SQL-order —
  repro'd against both stores before fixing, with regression fixtures covering
  BOTH adverse insertion arrangements), and `has_any_session` rides the sweep
  query as an EXISTS column instead of a second unbounded whole-table scan.
- **Wave 235.** `buildToday` carries `never_trained`; the first-timer greeting
  gates on it instead of `day_number === 1` (the same filtered-list premise Wave
  230 fixed, at its third surface — a voided-only user was still greeted "First
  workout?"). Every readiness note now reconciles with the first-session trim
  (low credited its one-accessory trim under a card saying "4 instead of 7"; high
  invited a back-off set beside "not for setting records"). The emailed plan
  resolves custom lifts by name.
- **Wave 236 (LEARN).** Lesson 61, telemetry 7p, this entry, BLOCKERS #10.
- **Evidence:** 359 route · 199 parity · 78 coach · 77 adherence · 31 nudge · 86
  auth · 163 push · 18 learn-data; every new regression observed red pre-fix;
  five tampers each turned exactly their own test red (two only after the tamper
  exposed the fixture); 10/10 real-browser walkthrough including the
  planted-stale-flag reconcile.

**Waves 230–232 progress (2026-08-21). A self-audit with eight findings, and the
KB's last dead text made reachable.**

- **Wave 230 (audit of Waves 224-229).** Eight defects, seven mine: the activation
  email and `buildToday` both treating "no derivable sessions" as "never trained";
  a display toggle reaching the plan-rebuild door; `hb_email` set on SEND so the app
  claimed an account that did not exist; an email card promising the plan and
  sending a magic link; a short-first-session promise made to non-beginners;
  `first_session.full` reporting the post-trim size; and my own Wave-224 account
  re-keying, reverted as built on a false premise.
- **Wave 231 (the build).** One generalized predicate (`dataRefId`/`rendersAsData`
  over a kind map) now carries exercises, supplements and muscles. Supplement sheets
  surface tier, dose, timing and safety; muscle sheets surface the MV/MEV/MAV/MRV
  landmarks the engine runs on, labelled as estimates. Five link labels that were
  literal file paths were authored into names.
- **Wave 232 (LEARN).** Lessons 58-60, telemetry 7q, this entry.
- **Evidence:** 354 route · 193 parity · 77 coach · 31 nudge · 18 learn-data · 53
  graph; regressions observed failing pre-fix and tamper-verified; browser
  walkthrough 14/14 including offline.

**Waves 224–229 progress (2026-08-19). The activation premise, measured and mostly
refuted; two fixes that stand regardless.**

- **Wave 224 (self-audit of Waves 217-223).** Five defects, four mine. The Wave-218
  quarantine repair never worked — it widened the correction door's ceiling and left
  the read predicate flat, so a far-east user's repair was accepted, announced as
  fixed, and re-quarantined by the next read (lesson 57). Both of its regression
  tests were built so they could not catch it (lesson 54, in the commit that wrote
  it). Wave 222's activation rate still divided by the contaminated denominator with
  a test pinning it. Plus a store-parity divergence and an archive-summary fallback.
- **Wave 225 (measure first).** The cohorted reach split, the falsy-zero trap
  (`tz_offset_min === 0` is a real value) with a fixture on it and a tamper, and the
  burst-shape aggregates that replaced the traffic-source question the owner could
  not answer.
- **Wave 226.** The plan screen printed "capped at 12 hard sets" above a 14-set
  session — the engine was right and the explanation was wrong. `sex` moved to the
  Fuel tab (zero references in the training engine; its copy claimed otherwise) and
  `units` derives from locale, with all three of its write sites moved together.
  Onboarding: 11 steps → 9, and 6 screens for a beginner in the real browser.
- **Wave 227.** A beginner's first session is 4 exercises, in `buildToday` only —
  week 1 goes 40 → 34 sets (0.85×), still less eased than an intermediate's 0.70×.
- **Wave 228.** One activation email anchored on account creation; the email ask
  moved off the far side of a completed workout; the commitment card unblocked on
  day 1 with honest copy; the `.ics` no longer starts in January.
- **Wave 229 (LEARN).** Lessons 55-57, telemetry 7r, this entry, BLOCKERS.
- **Evidence:** 354 route · 189 parity · 74 coach · 28 nudge · 12 session-time; every
  regression observed failing pre-fix with a tamper proving its fixture reaches the
  branch; a 12/12 browser walkthrough run twice, once pinned to UTC.

**Waves 217–223 progress (2026-08-18). One full loop turn; prod == main.**

- **Waves 217–219 (the audit of the un-landed burst).** PR #299 had sat as a draft
  with 1507 un-audited insertions. Ten confirmed defects, fixed before it landed:
  a wholesale profile patch that could forge `following`/`challenges` past four
  route guards (one shared `SERVER_OWNED_PROFILE_FIELDS`, walked by an enumerable
  test); D1's `reassignUserData` running its whole batch with no precondition
  (observed pre-fix moving a source graph onto an unreachable id); a merge refusal
  indistinguishable from success with the grant already burnt; a timing-quarantine
  repair path that was a dead end for far-east users and reported every rejection
  as a network fault; a repair card promising voided workouts would count; and
  quarantined rows sorted by the very field whose invalidity quarantined them.
  Plus lesson 50 (archives kept capabilities revocation never reached) and a D1
  query-shape regression that would have killed both cron sweeps at scale.
- **Wave 220 (the gates).** The citation gate's `(?!:)` meant "not followed by a
  colon", not "not a definition" — a fabricated key followed by a colon tripped
  neither the dangling nor the missing-definition error (lesson 51). And
  `app npm test` skipped the production store's only suite with exit 0 on Node 20;
  it re-execs now (lesson 52).
- **Wave 221 (the feature pull).** The 7 muscle guides' ranked pick lists are
  tappable: 72 exercise references across 64 movements now open the app's own
  exercise sheet, bundled (87 KB raw / 21 KB gzip) so they work offline. Exercise
  refs are deliberately NOT page edges — a test asserts a page whose only links are
  exercise refs still reads as under-linked. **Invisible links 122 → 50 dropped +
  72 traversable, reconciled** (lesson 53).
- **Wave 222 (Goal 4).** `stats()` reports activation separately; owner smoke
  traffic tags itself, gated on `STATS_KEY` so nobody can opt themselves out of the
  metric; historical rows are not retroactively classified.
- **Wave 223 (LEARN).** Lessons 50–54, telemetry 7s, this entry, BLOCKERS.
- **Evidence:** 339 route · 172 store/D1 parity · 14 learn-data · 13 session-time ·
  8 citation tests; two browser walkthroughs (15/15, 13/13); deployed from clean
  `main` and prod-smoked on the custom domain and the workers.dev origin.

**Waves 209–212 progress (2026-08-14). The blocker burst: four human-blocked items
became shipped code under the owner's blanket authorization.**

- **Wave 209 (#5):** the health & safety note — welcome-screen agree-line + full
  plain-English note (Me-tab reachable), acceptance stamped server-side at onboard
  and carried through merges. Real-browser walkthrough green.
- **Wave 210 (#7 + #2b server half):** `GET /api/stats` — secret-gated, aggregates
  only, zero new collection — plus the sweep stamping every live push-service 2xx
  into a self-init `push_deliveries` table (both send doors). Verified live against
  prod D1 the same hour; first reading recorded in the grounding note above.
- **Wave 211 (#6b + #8 half):** merge tombstones the from-row instead of deleting
  it (the app's only destructive primitive removed; 94-test D1 parity on Node 25),
  and every email footer states the mailbox only sends.
- **Wave 212 (LEARN):** lesson 48 (measure the funnel's mouth before building more
  tail), telemetry 7u, this grounding, and the BLOCKERS rewrite — #5/#6b/#7 moved
  to Done; what remains open is genuinely human (#1, #2b, #3, #6, #8-routing, #9).

**Waves 206–208 progress (2026-08-13). The Waves 203-205 self-audit shipped two
confirmed fixes, and the first dedicated KB currency sweep ran.**

- **Wave 206 (from the diff-scoped audit):** (a) the MERGE door now re-earns a
  pending celebration from the combined history — a survivor's "PR" armed against
  its short pre-merge history could be refuted by merged-in heavier sessions yet
  still pushed, and the merged-away account's pending echo died with the deleted
  row (lesson 47's third door + the partner_nudge lesson-16 class on Wave 201's
  field). 9 new tests observed failing pre-fix. (b) The movement gate's blind-spot
  count now simulates the real extractor: 17/171 → **52/171**, a 3× under-report
  of the narrowing lesson 35 requires stating. Four other candidates refuted
  inline and recorded in telemetry 7v. Deployed and prod-smoked.
- **Wave 207 (the currency sweep — the 2026-08-07 re-audit's named frontier):**
  8 topics via PubMed E-utilities over a 2025/06–2026/08 window, 75 PMIDs
  screened, **5 dual-verified additions** on 4 hot pages: the **2026 ACSM
  position stand** (consensus for ≥10 weekly sets on `volume.md` and for
  failure-optional on `proximity-to-failure.md`), **Van Every 2025** (mechanisms:
  hormones/metabolic stress/swelling not supported; sarcoplasmic hypertrophy
  lacks evidence), the **Gschneidner 2025 multi-site RCT** (n=297: lengthened
  partials ≈ full ROM — `range-of-motion.md`'s "sometimes superior" phrasing
  removed, the honest direction), **Wolf 2025** (longitudinal growth: mixed),
  **Camargo 2025** (volume saturation: not yet establishable). Honest nulls for
  sleep/protein/frequency. Registry **139 → 144**. The mechanisms.md addition
  cleared its depth floor and the stale DEPTH_EXEMPT entry failed red as
  designed (lesson 43's guard, first live firing) — entry removed, 9 remain.
- **Wave 208 (LEARN):** telemetry 7v; this grounding entry; no new numbered
  lesson (the iteration's meta-moments were recurrences of 39/43/47, recorded
  in telemetry). Tier 1 remains empty; the frontier is unchanged — the human
  BLOCKERS items plus currency work now gated on literature newer than the
  recorded horizon.

**Waves 203–205 progress (2026-08-09). The Waves 201-202 self-audit shipped its one
confirmed fix, and Tier-1 #1 — the movement gate — is SHIPPED and ENFORCED.**

- **Wave 203 (from the diff-scoped audit; lesson 47):** a pending celebration push
  now re-earns from corrected data on ANY session edit/void, not only when the
  edited session is the celebrated one — the fat-fingered weight that fabricates a
  "PR" can live in a PRIOR session, and voiding an older session invalidated a
  pending count-milestone claim. Five other audit candidates were refuted inline
  against the code and are recorded in telemetry 7w so they aren't re-raised.
  Deployed and prod-smoked.
- **Wave 204 (Tier-1 #1):** `npm run check` now fails when content prose recommends
  a movement that resolves to no `data/exercises` id — the chest.md incident class,
  enforced. `tools/movement-core.mjs` + `check-movements.mjs` + 12 unit tests;
  measured-first calibration (125 candidates / 61 flags read in context / zero real
  gaps); enforced same-wave under lesson 25's flip rule; tamper-verified both
  directions. Worth carrying forward: the corpus's unlinked prose was CLEAN — the
  gate's value from here is regression-catching on every future authored page.
- **Wave 205 (LEARN):** lesson 47 + telemetry 7w written; the owner's new
  considerations rule (delete once implemented) processed — consideration #1
  verified implemented and removed from the file. **Tier 1 is empty again; the
  2026-08-07 re-audit verdict stands** (not re-run after two days — that would be
  churn, lesson 17): the frontier is the human-blocked BLOCKERS items and
  literature-gated currency work.

**Waves 201–202 progress (2026-08-07). Tier-1 #3 — every social event reaches a
device — is SHIPPED, Tier 1 emptied, and the scheduled goal-distance re-audit RAN.**

- **Wave 201:** the celebration echo (PR / level-up / session-count milestone /
  weeks-streak milestone at 4/12/26/52, literal-pinned) is stamped at the session
  door as ONE consolidated marker and pushed on the next tick — never one
  notification per event; edit/void re-earns it from corrected data, so a
  fat-fingered PR weight taken back is never praised (lessons 27/10). A new
  follower bumps a monotonic count on the owner (the cheers_pushed shape, batches
  between ticks, carries no identity). The comeback reaches the push channel via
  the SAME pure comebackStage the email sweep uses, rides the user's one local
  push hour, and REPLACES that day's generic empty reminder rather than stacking
  beside it. 43 new tests; sweep suite observed failing pre-feature; prod-smoked
  on real D1. The push-notification layer now covers every event the app can
  name: reminder, commitment, nudge, challenge invite/accept/result, cheer,
  streak-freeze, follower, celebration, comeback.
- **The goal-distance re-audit (scheduled "when a tier empties"), measured:**
  - *Goal 1:* depth gate ENFORCED and green (10 flagged / 10 justified exemptions
    / 0 enforceable); registry 139, all verified; graph gates green. The named
    backlogs (depth, muscle guides, supplements, breadth) are all closed. What
    remains is CURRENCY (re-checking hot pages as 2026+ literature lands —
    local-session-only per BLOCKERS #9) and one carried-forward buildable gate:
    nothing checks that a movement the PROSE recommends exists in
    `data/exercises` (chest.md shipped a nonexistent "low-to-high cable fly" for
    waves — the app could not program its own KB's advice). That gate is the new
    Tier-1 #1.
  - *Goal 2:* bottom end strong (v0 demos shipped; real footage = BLOCKERS #1).
    Top end: the evidence-supported elite slices (DUP, taper/peak, specialization
    blocks, volume auto-tune, effort lever) are ALL shipped; what remains
    (contest-prep mode, velocity autoregulation) is blocked on elite ground truth
    (BLOCKERS #6) and hardware the app can't collect — building either without
    those inputs would assert what the KB can't back.
  - *Goal 3:* every identified friction item is closed; no new ones surfaced this
    audit. Watch, don't manufacture.
  - *Goal 4 (the stated top priority):* after Wave 201 the MECHANISM layer is
    genuinely built out — every event reaches a device, dual-channel, quiet-hours
    aware. The honest gap is now lesson 25's: **the goal itself has no number.**
    Nothing measures whether adherence is actually rising — and BLOCKERS #7
    records that analytics is the OWNER'S values call, so the loop must not ship
    it unilaterally. Sharpened #7 into a decision-ready zero-new-collection
    proposal (aggregates over rows D1 already holds) and added the cheap
    real-device push check as a new blocker ask. Also still open when usage data
    exists: the two Grade-D tunables (graduation thresholds, reactive-deload
    bounds) that have never been checked against a real user.
  - **Verdict:** the buildable frontier has narrowed to one clean gate item
    (below); the binding constraints on all four goals are now mostly HUMAN
    inputs — BLOCKERS #1 (media), #5 (disclaimer), #6 (elite ground truth), #7
    (analytics call), plus the new real-device push verification. Surfacing that
    IS the work (lesson 17); filler would hide it.

**Tier 1, repopulated by the 2026-08-07 re-audit — and emptied again 2026-08-09:**

1. ~~**[Goal 1 + 2] The prose-recommends-a-liftable-movement gate.**~~ — **SHIPPED
   and ENFORCED (Wave 204; see the Waves 203-205 entry above).** Every prescription
   the item made held: the mapping layer exists (22 aliases + 16 justified
   generic-category entries, each placed by reading its corpus context), the
   measured first run came BEFORE strictness (125 candidates / 61 flags / zero real
   missing movements), and lesson 25's flip rule was satisfied same-wave because
   the calibration landed the bar green honestly. Stale/dangling map entries fail
   red; the extractor's blind spot is a printed count (17/171 names).

*(Nothing else qualifies for Tier 1 without manufacturing: KB currency sweeps are
Tier-2 cadence work gated on new literature; cross-user learning stays blocked on a
dataset; everything else is in BLOCKERS. The 2026-08-07 re-audit verdict stands —
see the grounding note at the top of this file.)*

**Waves 198–200 progress (2026-08-08). Tier-1 #2 — multiple concurrent challenges —
is SHIPPED,** exactly along the lines the 2026-08-04 scoping laid down (and that
scoping held up: no real table needed, respond needed challenge_id, the per-user push
markers were the lesson-23 trap):

- **Wave 198 (backend):** `profile.challenges` bounded array with ONE normalization
  helper reading legacy-scalar and array rows identically; per-slot push markers
  (regression test: two invites in one sweep tick BOTH push — the collision the
  scoping predicted); per-pair busy rule + 3-open cap, re-checked inside every CAS
  mutator with a rollback when the opponent's side refuses (lesson 46); respond takes
  `challenge_id` with a no-guessing rule for multiple pending invites; history entries
  carry the challenge id (two challenges can end in the same week). Legacy rows are
  covered by tests seeded byte-for-byte as un-migrated D1 rows (lesson 45).
- **Wave 199 (frontend):** the four mutually exclusive cards became a per-slot list;
  each invite card answers with its own id; the ⚔️ button gates per pair. Real-browser
  verified: two concurrent invites rendered together, answered independently, server
  state matching per side. Prod-smoked on real D1.
- ~~Tier 1 now holds ONLY item #3~~ **superseded: #3 shipped (Wave 201), the
  re-audit ran, and Tier 1 was repopulated — see the Waves 201-202 entry above.**

**Waves 194–197 progress (2026-08-07, same day). Tier-1 #1 — the KB depth backlog —
is CLOSED.** The flip criterion re-specified on 2026-08-04 ("every remaining entry
either cleared or carries a recorded, justified exemption") is now ASSERTED BY THE
BUILD, not claimed by prose:

- **Wave 194** — self-audit of the prior burst, inline, zero agents: one confirmed
  defect (a tautological test assertion), one accepted behaviour recorded, four
  hypotheses refuted with evidence.
- **Wave 195** — the authoring half of the 13 judgment calls: `nutrient-timing` got its
  own source's numbers (0.4 g/kg/meal × ≥4 meals; 0.55 at the 2.2 g/kg/day bound);
  `logging-and-plateaus` got "how flat is flat" (±2.5% × 4 weeks / −5% = decline, the
  app's own thresholds, labelled practice); `connective-tissue-adaptation` got Bohm
  2015's real findings (≥8-week interventions, intensity-dependent); the overtraining
  page got the FOR/NFOR/OTS ladder with the ONE verifiable duration and no invented
  month-figures. Registry 137 → 139 (a third add was caught as a duplicate of an
  existing key and merged instead — lesson 44).
- **Wave 196** — `DEPTH_EXEMPT`: per-page justifications (10 entries, each page read
  before listing), enforcement-only (the report still prints everything), stale
  entries fail the build, floors untouched and literal-pinned, warn-mode test replaced
  by one locking the enforced state. Verified failing in both tamper directions.
- **Current state: 10 flagged / 10 exempt / 0 enforceable — gate ENFORCED and green.**
  Registry 139. Depth work is DONE as a backlog; it continues only as the gate
  catching regressions and new pages.

~~What Tier 1 still holds: items #2 and #3~~ **superseded 2026-08-07: both shipped
(Waves 198-199 and 201), the tier emptied, the goal-distance re-audit ran, and the
current Tier 1 is the repopulated list in the Waves 201-202 entry above.**

**Waves 190–193 progress (2026-08-07).** A self-audit of the previous burst plus the two
items that burst had explicitly recorded as deferred. All deployed and prod-smoked.

- **Wave 190 — `shoulders.md` rebuilt** (624w → ~1640w, 3 → 5 live links). The last
  muscle guide on the depth list; **that whole sub-item is now closed.** The find that
  mattered wasn't the word count: the old page implied cables beat dumbbells for side
  delts, and Larsen 2025 tested exactly that — one arm each, ROM matched, 8 weeks — and
  found **no difference**. The page now says so *and* says precisely what the result
  does and doesn't license (it tested the implement with ROM held constant, so it can't
  speak to lengthened-position loading, and the engine's lengthened-bias ranking stays
  defensible). Registry 136 → 137. Searched for evidence on the page's strongest claim
  (pressing covers the front delt) and found **none** — it stays Grade C inference and
  now says so.
- **Wave 191 — the deferred tz/challenge hypothesis was REAL.** Recorded last iteration
  as "plausible arithmetic, not confirmed"; a ten-line reproduction settled a
  **one-hour-old** challenge. Fixed at six sites via one ordinal `weekHasPassed`
  predicate (lesson 40), with one lookalike deliberately left alone because it's a
  genuine one-week window. Also: Wave 187's plan-card fix reached **nobody**, because
  `/api/plan/explain` reads the stored rationale (lesson 41). And `boundLocalDate` was
  **refuted** — tested across ±14h, it's correct as written.
- **Wave 192 — a specialization block now ENDS**, the other deferred item. One 6-week
  block, matching the KB's "~4–8 weeks, then rebalance"; **no new state** (the existing
  `block_index` already resets when `priority_muscles` changes, so "start another block"
  is "change your priorities" — the rotation the KB itself describes). The plan card
  explains the transition rather than letting the maintenance holds silently vanish.
- **Depth: 13 flagged pages / 16 flags**, unchanged from the last burst — shoulders was
  never *below* a floor, it was thin relative to the exemplar. Registry 137.
- **Still deliberately open:** the depth-gate flip (unchanged reasoning — all-or-nothing
  enforcement, no per-page exemption mechanism, 11 density-floor pages each needing an
  individual call). Nothing else from the previous burst's deferred list remains.

**Waves 186–189 progress (2026-08-06).** A diff-scoped lesson-3 audit of the previous
burst (`8f488cf..HEAD`, Waves 178–185) plus the next KB-depth pull. Three shipping waves,
all deployed and prod-smoked:

- **Wave 186 — two trust-boundary doors and a gate that flattered itself.**
  `/api/checkin` bounded the weigh-in row it writes but not the CHECK-IN row, from the
  same `b.date` three lines apart; since every consumer window is `date >= start` with no
  ceiling, a future-dated check-in never aged out of the 42-day block window
  `recoverySignal` averages, and one-row-per-date made it uncorrectable. The realistic
  vector was a wrong DEVICE clock, not an attacker. `parseTzOffset` also didn't reach the
  profile PUT. And the invisible-links report was under-counting **69 → 92** because it
  duplicated only half the renderer's predicate (index links render as plain text).
- **Wave 187 — the Wave-179 specialization derivation reached almost nobody.** It counted
  muscle ids while citing a rule about areas (so it refused the KB's own
  `specialization-delts-arms-4day` shape); it honoured a stored `false` the old client had
  written for every user who was never shown the question; `/api/today`'s auto-tune freeze
  still read the raw field; the "What your answers changed" card quoted a rep band the
  generator discards for advanced lifters (`6-10` above a plan reading 4-6/6-10/10-15) and
  counted `neck` among muscles "held at maintenance" though nothing trains it. See
  lessons 37–39.
- **Wave 188 — `chest.md` rebuilt** (the item below named it as needing its own wave):
  430w → ~1300w, 3 → 7 live links, three regions with ranked picks from real
  `data/exercises` ids, and the reader's actual question answered in degrees (~30° incline,
  never past 45°) from two newly dual-verified sources — both labelled Grade C and set
  directly against Varovic 2025, because both measured acute activation, not growth. It
  also removed a prescribed "low-to-high cable fly" that **does not exist in the exercise
  DB**, so the app could never program the movement its own KB recommended. Registry
  134 → 136.
- **Depth now: 13 flagged pages / 16 flags** (was 14/17), **2** below the word floor
  (was 3), 11 below the density floor, shortlist still 3.
- **Deliberately NOT done, recorded so it isn't re-raised as new:** (a) the depth-gate
  FLIP stays deferred — enforcement is all-or-nothing (`!warnOnly && flaggedPages.size > 0`)
  and there is still no per-page exemption mechanism, so flipping needs an exemption list
  plus an individual judgement call on each of the 11 density-floor pages; forcing it
  would land the bar red, which lesson 30 says is worse than no gate. (b) **A derived
  specialization block never ENDS** — `deriveSpecialization` re-runs on every plan
  generation with no block counter, while the KB (and the deleted question's own copy)
  says a block is one or two 6-week runs, "not forever". Real, larger than this wave, and
  the natural next pull: `plan_meta.block_index` already exists to hang it on. (c) One
  finder claimed the first-ever tz capture could retroactively settle a challenge stamped
  in the old UTC frame; the arithmetic is plausible and the window is a few hours per
  week, but it was **not verified and not acted on** — treat it as an open hypothesis,
  not a finding.

**Repopulated 2026-08-04 by the Waves 173–176 iteration** (a diff-scoped correctness audit
of `5171a37..HEAD` plus the KB's first DEPTH measurement). Pull from the top:

1. **[Goal 1] KB depth backlog — now measurable, and the measure is in the build.**
   `npm run depth` (`tools/check-depth.mjs`, Wave 175) reports per-page word count, numeric
   density, table rows and out-degree; `DEPTH_GATE` ships **WARN-only** at corpus-derived
   floors (words p10 = 454, density p10 = 0.22 numbers/100w). Wave 176 cleared `alcohol` and
   `muscle-soreness-doms`; Waves 181–183 and 188 cleared five more. **Current
   (2026-08-06): 13 flagged pages / 16 flags — 2 below the word floor, 11 below the
   density floor, 3 on the both-tells shortlist.** In priority order, verified as real gaps
   by the Waves 173–176 audit rather than assumed (entries struck through below are done):
   - `07-tracking/assessing-progress.md` (394w, 1 citation) — the page the Progress tab's
     concepts rest on, and it gives no measurement-noise numbers: no normal day-to-day
     bodyweight swing, no weigh-in cadence, no tape-change threshold, no photo interval. It
     cites Haun 2019 — *a paper about measurement error* — and extracts only its qualitative
     sentence. Also contradicts its own sibling on the assessment window (this page says
     8–12+ weeks, `what-to-track.md` says 4–12+) and the two pages don't link each other.
   - `07-tracking/what-to-track.md` (out-degree 1) — recommends logging load × reps and
     "weekly hard sets" without ever saying how to turn them into one comparable number
     (the engine's own est-1RM and its >0.5 kg noise margin appear nowhere in the KB), or
     what counts as a hard set. Registry already holds verified `baz-valle-2021-counting-sets`
     and `zourdos-2021-rir-accuracy`, uncited here.
   - `03-programming/program-templates.md` — **routing is broken for app readers**: every
     template link is `../../data/programs/*.json`, which the renderer shows as plain text,
     so an in-app reader gets five names and no prescription. Says "three worked templates"
     twice while listing five, and a rendered sentence still calls the plan engine "the
     future app". The number a reader chooses a template BY — weekly sets per muscle — is in
     neither the page nor the JSON.
   - `03-programming/splits.md` — the per-session set ceiling is stated as "without any
     single session becoming a quality-killing marathon", and the 3×/week threshold as "very
     high volumes" while `frequency.md:40` already owns the number (20+ weekly sets). No
     2-day row. Doesn't link `frequency.md`, which links to it.
   - `05-recovery/recovery-modalities-and-injury.md` — promises a verdict on gadgets and
     adjudicates two (foam rolling, cold water). Sauna, compression, massage guns and NSAIDs
     appear **nowhere in `content/`** and have no registry citation — needs verification
     first, and an honest "not yet reviewed" beats an invented verdict.
   - ~~`02-muscle-guides/chest.md` (430w)~~ **DONE (Wave 188)**, ~~then `shoulders.md`~~
     **DONE (Wave 190) — this sub-item is CLOSED; no muscle guide remains on the list.**
     Kept for the pattern, which the next guide-touching wave should copy. back.md is the exemplar (region-by-region ranked
     picks with cues); shoulders is still a 3-row table. A ~600-word rebuild with real
     `data/exercises` ids, so too large to author honestly inline alongside other work —
     its own wave. **Not** a coverage gap: all 16 `data/muscles` regions are already
     addressed across the 7 guides (verified), so don't add guides, deepen this one.
     Chest's rebuild is the worked pattern to copy, including the part worth repeating:
     check that every movement the prose recommends actually EXISTS in `data/exercises`
     (chest's did not — it prescribed a "low-to-high cable fly" the engine cannot program).
   - **Flip criterion for the gate — RE-SPECIFIED 2026-08-04.** It used to read "when the
     both-tells shortlist is empty". That is unreachable and was mis-specified: of the 5
     remaining entries, two are **myth pages** and one is a returning-lifters page, and
     `check-depth.mjs`'s own header says a rebuttal built on null findings has nothing to
     quantify (lesson 13). "Empty the list" could then only be satisfied by authoring
     numbers onto pages that legitimately have none — the exact pressure lesson 31 warns
     about. Flip when every remaining entry is **either cleared or carries a recorded,
     justified exemption**, the same pattern `check-claim-coverage` already uses for its
     two by-reference synthesis pages. The test asserting the pre-flip state is *supposed*
     to fail on the flip — update it to lock the enforced state, never relax a floor to
     make a thin page pass.
2. ~~**[Goal 4] Multiple concurrent challenges**~~ — **SHIPPED (Waves 198-199).** The
   2026-08-04 scoping below is kept because every one of its predictions held; see the
   progress entry above for what landed.
   *(Original scoping:)*
   The roadmap has said for several waves that this "needs a real table". **It does not:**
   `app/schema.sql` stores the whole user as a JSON blob (`users.data`), so single-slot →
   bounded N-slot array is a shape change with zero migration, and `settleChallenge` is
   already stateless per-challenge (it re-derives from `sessionsInWeek` on read). What it
   genuinely needs: `isChallengeOpen` becomes a count-of-open-slots busy check on both sides;
   `POST /api/challenge/respond` needs a `challenge_id` in the body (no such param today);
   **`challenge_pushed_at`/`challenge_accept_pushed_at` are per-USER scalars and must move
   onto the slot** (as `result_pushed` already did) or two invites in one sweep tick collide
   and one is suppressed forever — lesson 23 exactly; and the frontend's four mutually
   exclusive cards become a list. **Cloud-eligible** (pure code, no citation network needed).
3. ~~**[Goal 4] Social events that still never reach a device.**~~ — **SHIPPED
   (Wave 201; see the Waves 201-202 entry above).** Every named event now reaches a
   device: the celebration echo (PR/level-up/session milestone/streak milestone,
   consolidated to one push), the new-follower event, and the comeback on the push
   channel. The marker-scope question this item flagged (lesson 23) was answered
   per event: per-session, count high-water, and per-lapse+stage respectively.
4. **[Goal 1] Citation-network work is LOCAL-SESSION-ONLY** (`BLOCKERS.md` #9): PubMed
   E-utilities and Crossref return 200 here and are CONNECT-denied in the cloud sandbox. So a
   local session should spend itself on KB depth (items 1 and 4 above) and leave the pure-code
   items (2, 3) to cloud iterations — that is a comparative-advantage rule, not a preference.


1. **[Goal 4] Wins & PR celebration.** — *PARTIALLY SHIPPED (Wave 79 + 81 + this reconcile).* Done:
   reusable pure `detectPersonalRecords` (est-1RM PRs for heavy work AND load PRs for higher-rep
   hypertrophy work — the pump-band gap), wired into the recap with a celebratory "🎉 New personal
   record!" banner (Wave 79); bonus XP for a PR — +50 XP per record, surfaced as "+N XP" in the
   recap banner and banked into the level (Wave 81; `PR_XP` is the single source of truth shared by
   the engine and the recap); **(b) the in-player PR moment** — `priorPersonalBests`/`checkSetPR`
   (`derive-core.mjs`) give `buildToday` a `pr_watch` ceiling per exercise, and the live player
   (`app.js` + `session-core.mjs`'s browser-safe duplicate, cross-tested for agreement) fires a
   toast the instant a logged set beats it, not only at the end of the session; **(c) the wins feed**
   — `allPersonalRecords` (`derive-core.mjs`) replays the full PR history, surfaced on the Progress
   tab as a "🏆 Personal records" card with a count and the recent records (the trophy shelf you
   return to). **✅ ITEM #1 COMPLETE.**
2. **[Goal 4] Variable rewards + proactive habit reminders.** — *SHIPPED (Cloud loop wave).*
   Done: the weekly "when will you train?" commitment device — `POST /api/commitment` (pinned to
   the current ISO week, `tools/derive-core.mjs`'s `isoWeekKey`/`WEEK_DAY_KEYS`/`weekDayKey`) lets
   a user state which days this week they intend to train; `push.mjs`'s new
   `shouldPushForCommitment` gives the daily push sweep a genuinely *proactive* trigger — a
   committed day the user hasn't trained yet — independent of `shouldPush`'s lapse-reactive
   days-since-last-session gate (which alone can't fire the day right after training, exactly
   when a same-day commitment reminder should); a `Today`-tab card lets the user set/edit the
   plan and reinforces it once set, suppressed on day 1 (novice-friction). **Lucky-set bonus XP**
   (the remaining slice): `tools/derive-core.mjs`'s `isLuckySet`/`luckySetsInSession` hash a
   session's own random `session_id` with the exercise + its hard-set position to decide,
   deterministically but unpredictably to the user, whether a hard set pays a `LUCKY_SET_XP` (15)
   bonus on top of the fixed 100/session + 5/hard-set schedule (~1-in-8 hard sets) — the
   variable-ratio schedule the fully-predictable XP couldn't provide. Fires as an in-player "🍀
   Lucky set!" toast the instant the set is banked (`session-core.mjs`'s duplicate, cross-tested
   against the server in `test-session.mjs`, same pattern as the PR toast) and is summed into
   `xpAndLevel`'s `lucky_xp` + surfaced as a recap win line, so the live celebration, the recap,
   and the banked XP total can never disagree.
3. **[Goal 2 bottom / Goal 3] Inline exercise demos, v0.** — *SHIPPED (Cloud loop wave).*
   `app/public/movement-demo.mjs` (pure, DOM-free, unit-tested like `session-core.mjs`) maps
   all 23 `movement_pattern` values to a `[kind, caption]` pair — a small static line-art figure
   + one animated glyph (vertical bounce / bounce-rotated-90°-for-side / rotate-bend / pulse,
   `prefers-reduced-motion`-aware) plus a plain-language caption. Keyed off `movement_pattern`
   (already on every exercise) rather than a new per-exercise field, so all 171 exercises get a
   demo with zero new data authored — deliberately **not** the literal "add a `media` field to
   the schema" the roadmap originally specified: an unused field is exactly the standing lesson-14
   anti-pattern ("a declared-but-unused tunable is a silent contradiction"), and `movement_pattern`
   already fully determines the v0 animation. Wired inline on the live set screen (first set of
   each exercise only, to avoid repeat-set clutter), the superset station (first round), and the
   "How do I do this?" sheet, which also had the YouTube-search punt **deleted** entirely.
   `movement_pattern` now flows through `/api/today` (`coach.mjs`) and `/api/exercises`
   (`app.mjs`) so a mid-workout **swap** carries the right demo too, not just the original pick
   (lesson 1: fixed at every call site, not just the first). Verified in a real browser
   (Playwright + the pre-installed Chromium): the demo renders correctly for Leg Press (squat →
   "Bend your knees…") and survives a swap into Barbell Back Squat; the YouTube link is
   confirmed gone from the rendered page. 5 new unit tests assert full schema-enum coverage (no
   pattern silently falls through) plus 2 new route tests for the today/swap wiring. Upgrading to
   real per-exercise clips (BLOCKERS.md #1, still blocked on licensed/filmed media) becomes a
   fallback-preserving override later — this file doesn't need to change for that to land.
4. **[Goal 3] Novice-friction quick wins.** — *PARTIALLY SHIPPED (Wave 81 + this reconcile).* Done: the
   set screen's "leave about N in the tank" target no longer surfaces the bare "what's RIR?" glossary
   link to a true novice (`buildToday` now returns `beginner` from `training_status`, gating the term
   client-side; non-beginners keep it). Also done (Wave 83): the specialization question
   ("All-in specialization block…") is hidden from beginners — a programming decision a novice
   can't make, now gated on `training_status !== "beginner"` in the onboarding `showIf`. Also done
   (Wave 84): on day 1 the workout is the highlighted hero, not the optional morning check-in.
   Also done (Wave 87): the **Fuel tape-measure wall is gone** — `bmiBodyFat` (Deurenberg, a rough
   BMI-based BF% seed the adaptive TDEE later corrects) is the last fallback in `nutritionInputs`,
   so the Fuel form works from **weight + height alone**; BF% and tape measures are now optional
   "sharper estimate" fields. **Also done (Cloud loop wave):** the first-set weight is now
   body-scaled for a non-beginner with no history on a lift — `coach.mjs`'s `estimateStartingWeight`
   scales the latest logged bodyweight (`/api/today` now fetches it) by a movement-pattern ratio
   (squat/hinge/lunge/push/pull, isolation) × an equipment load-scale (barbell/machine/cable/
   dumbbell/kettlebell), rounded DOWN to the lift's own load increment so the guess errs light —
   a confirm-and-adjust number instead of the empty-bar blind guess. True beginners are
   deliberately excluded (`buildToday`'s existing `beginner` gate) and keep the safe empty-bar
   default + the "let's find your weight" ramp-up card; a lift with no bodyweight on file, or an
   equipment/pattern combo with no sane ratio (bodyweight moves, carries, "other"), falls back to
   the same pre-existing null. **ITEM #4 NOW FULLY SHIPPED** (all four novice-friction items done).
5. **[Goal 1] Citation-coverage gate.** — *SHIPPED.* `tools/check-claim-coverage.mjs` runs in
   `npm run check` and fails the build when a content page makes a [Grade A]/[Grade B] claim but
   carries zero `[^footnote]` citations. Two plain-language getting-started synthesis pages (which
   cite by reference to their evidence pillars, as STYLE.md §1 permits) are on a short, justified
   allowlist; Grade C/D claims are exempt. Makes "every claim web-verified" measurable and blocks
   regression. Documented in STYLE.md §1. (The deeper per-claim proximity check remains Tier-2 #6.)

### Tier 2 — high value, larger
6. **[Goal 1] Citation-completeness pass** on the undercited core pages (getting-started pillar,
   energy-balance, sleep, weak-point, plateaus…), expanding the registry well past 99. *STARTED:*
   **energy-balance done (Wave 92)** — was 1 effective citation for 4 graded claims; now grounds
   the "keep the surplus modest / excess becomes fat" claim (Garthe 2013) and the surplus-size +
   0.25–0.5%/wk rate heuristic (Iraki 2019), both dual-verified. **`sleep` done (Wave 95)** — was
   2 citations; grounded the headline "7–9 h" claim (Hirshkowitz 2015 NSF consensus) and added the
   missing direct sleep→muscle mechanism (Saner 2020, myofibrillar protein synthesis). Registry now
   119 (Wave 122 EAAs + Wave 123 neck). Reassessed (Wave 123 + cloud-loop cross-check): the
   remaining "undercited" pages are largely NOT genuine gaps — `weak-point-prioritization` now
   carries 4 citations (Varovic 2025, Attarieh 2025, Larsen 2026, Maeo 2023; PR #184);
   `breaking-advanced-plateaus` (all Grade C/D) and `long-term-and-annual-planning` (all Grade D)
   are honest synthesis/practice pages by design, densely cross-linked to their evidence pillars —
   citing them would be manufacturing, not grounding. Genuinely thin remaining: the getting-started
   pillar (much of it is Grade C/D practical guidance, so lower-priority than the raw zero-citation
   count implied; its two graded exceptions, `what-actually-matters.md` and
   `starting-out-as-a-woman.md`, are already citation-coverage-ALLOWLISTED by-reference synthesis).
   **Tier-2 #6 is effectively done** — no further concrete target found without a fresh audit.
7. **[Goal 1] Muscle-guide depth upgrade** — rebuild the guides into region-by-region
   authoritative treatments, feeding the app's exercise engine. *STARTED:* **`back.md` done
   (Wave 93)** — the exemplar: 5 regions (lats/width, mid-back thickness, upper traps, rear delts,
   erectors), each with function + a hypertrophy-ranked pick list pulled from the exercise DB
   (mirroring the engine's lengthened→equipment→fatigue ranking), per-region cues, week-assembly
   summary, and an honest regional-hypertrophy nuance (Varovic 2025). **Reassessed (Wave 95):**
   `chest` (568w, 4 cites), `shoulders` (591w, 3 cites), and `legs` (740w, direct Maeo evidence)
   are already decent region-by-region treatments — back.md was the outlier, so this item is lower
   priority than the audit implied. Reassessed (Wave 123): `core` is now a full region-by-region
   treatment (858w, 3 regions + ranked picks + 3 cites) and `neck` (522w) is appropriately concise
   for a niche/optional muscle and was grounded this wave (collins-2014 concussion association +
   hrysomallis-2016 review, honestly caveated). **No muscle guide is a genuine depth gap anymore** —
   don't rebuild these unless a specific claim is wrong or a real audience need appears.
8. **[Goal 1] Breadth pages** — *STARTED.* Menopause & Training shipped (Wave 89: defends
   muscle+bone through the transition; Zhao 2025 BMD meta + Radaelli 2025 muscle; HRT framed as a
   medical decision). **Pregnancy & Postpartum Training shipped (Wave 91)** — the honest
   evidence-based consensus (exercise incl. resistance training is safe/recommended in an
   *uncomplicated* pregnancy; lowers GDM/hypertensive-disorder + prenatal/postpartum-depression
   risk) with strong medical-clearance framing, a build→maintain goal shift, trimester
   modifications, and a pelvic-floor-first postpartum return; 4 dual-verified citations (ACOG 804,
   2019 Canadian guideline, Davenport 2018 GDM/HTN + depression metas). Verified NOT gaps (already
   covered — don't rebuild): recomposition (`building-muscle-in-a-deficit.md` covers it fully),
   plant-based (protein.md has the core guidance), tendon adaptation
   (`connective-tissue-adaptation.md`). **fiber-type × rep-range: verified NOT a gap (Wave 95)** —
   `01-training-variables/intensity-load-and-rep-ranges.md` already covers rep ranges and fiber
   type. No obvious breadth gaps remain; propose new ones only against a real audience need.
   **DEPTH gaps are a different axis, and the breadth audit is blind to them (Wave 161):** a user
   asked when cardio helps vs hinders growth, what the actual dose is, and how to tell which way
   it's going — and `03-programming/cardio-and-concurrent-training.md` existed (so no breadth gap
   showed) while answering none of the three. It carried zero numbers: `NEAT`, `step count`,
   `zone 2`, `LISS`, `HIIT`, `VO2max` and any minutes-per-week figure appeared **nowhere in
   `content/`**. That's lesson 25 at page scope — "moderate" and "manage sensibly" are adjectives
   no gate can fail on. **When a tier empties, re-audit for DEPTH (does each page answer the
   questions a reader actually arrives with, in numbers?), not only for missing titles** — and
   treat a thin page's out-degree as the tell: this one sat at exactly `GATE.minOut` and was
   unreachable from the training side of the graph, which is what a page nobody has revisited
   looks like.
   Supplement data: **vitamin D + omega-3 added (Wave 90)** — both honestly graded (vitamin D
   fixes a deficiency, no ergogenic boost when replete; omega-3 has NO MPS effect in healthy
   adults per Therdyothin 2025, a health supplement not a muscle-builder). **Supplement breadth now
   CLOSED (Wave 123 reassessment):** the debunks (glutamine, ashwagandha, ZMA, tart cherry) all
   shipped since the audit and **EAAs shipped (Wave 122)** — an honest "complete stimulus but
   redundant with adequate protein" entry (Børsheim 2002 + Church 2020, dual-verified). 15
   supplement entries now cover the field; don't re-investigate supplements as a gap.

### Tier 3 — big bets
9. **[Goal 2 elite] Real periodization + peaking** — *STARTED (Waves 98+100):* **Daily Undulating
   Periodization**, now **auto-derived** (Wave 100, per the Goal-2 minimal-customization
   refinement): advanced trainees on a muscle-building goal get heavy/moderate/light-by-day
   automatically — no question asked — while beginners/intermediates keep the byte-identical linear
   default; `profile.periodization` stays a respected override. Undulates only the COMPOUND band;
   isolations keep their higher-rep near-failure band every day (the KB isolation invariants caught
   and enforce this). Prod-verified (advanced auto-undulates, intermediate stays linear). **Reassessed
   (Wave 124) against the KB’s own evidence — a full BLOCK-periodization _hypertrophy_ engine is NOT a
   genuine gap:** `periodization-and-progression.md` (Moesgaard 2022 meta) states periodization “does not
   clearly beat sensible non-periodized progression when volume is matched” for hypertrophy, and
   `long-term-and-annual-planning.md` grades block sequencing Grade D throughout (its value is
   _organization/adherence_, not extra stimulus). Building a macro-emphasis engine
   (accumulation→intensification→peak shifts across mesocycles) for a bodybuilder would assert a benefit
   the KB refutes — the Varovic lesson at the ENGINE level — and the app ALREADY ships the evidence-aligned
   pieces: the within-mesocycle build→peak→deload wave (`blockPhase`), block-boundary volume auto-tune,
   recovery-gated volume (`deriveVolumeAdjust` context), undulating-for-advanced, and exercise rotation.
   The genuinely-remaining elite work is narrower, evidence-supported: a **taper/peak toward a goal
   date** (tapering has real strength-EXPRESSION evidence, distinct from hypertrophy) and a **contest-prep
   mode**; deeper velocity-driven autoregulation needs hardware the app can't collect.
   **Taper/peak SHIPPED (Waves 132/133/135, merged on `main`):** a `goal_event_date` input
   (Settings-only — deliberately gated out of first-run onboarding per Goals 2/3's minimal-customization
   principle; a competitive lifter opts in later, non-beginners only) drives `taperPhase` (`coach.mjs`) —
   a 14-day window trading volume for freshness (sets scale down, RIR eases, load HOLDS — strength
   expression, not a hypertrophy claim), grounded in evidence (Bosquet 2007 meta) and correctness-audited
   (local-frame date math, Wave 135). **This closes the "only once a goal-date input exists" gate** the
   paragraph above used to describe as blocking — it no longer blocks anything. The peak-week carb-loading
   myth debunk (Henselmans 2022: no benefit found in the trials that tested short-term carb manipulation
   before an event) also SHIPPED (Wave 147) — surfaced in the final-week taper note and grounded in the
   periodization page; don't re-propose it. What's still genuinely open, narrower than before: a full
   **contest-prep mode**
   beyond taper + nutrition (peak-week logistics, posing-adjacent guidance) would need real elite ground
   truth this project doesn't have (`BLOCKERS.md` #6) to build honestly rather than invent — not a clean
   buildable slice, don't force it.
   **Audit fix (Cloud loop wave):** the auto-derived DUP itself
   (Wave 100) had a live bug in `sessionRepScheme`/`tools/plan-core.mjs` — it keyed a session's
   heavy/moderate/light band off its ABSOLUTE index in the week, not its occurrence within its own
   archetype. Any split repeating an archetype at an interval that divides evenly into 3 — which
   includes the two most common advanced hypertrophy splits, 6-day PPL (`PUSH, PULL, LEGS, PUSH, PULL,
   LEGS`) and 2-day full-body — landed every repeat of the SAME muscle group on the IDENTICAL band
   (confirmed by generating a real 6-day advanced plan: Push A and Push B both `4-6`, Pull A/B both
   `6-10`, Legs A/B both `10-15`), making the flagship "advanced trainee gets a genuinely different
   stimulus each exposure" promise fully inert on the split it's most likely to actually run on. The
   existing test only checked plan-WIDE band diversity (Push ≠ Pull ≠ Legs), which stayed green through
   the whole bug since different archetypes still differed — it never checked a single archetype's own
   repeats against each other. Fixed by keying the band off `spec.letter` (the archetype's own 1-based
   occurrence count) whenever that archetype repeats (`spec.of > 1`), falling back to the day's absolute
   position only when no archetype repeats at all (e.g. the 5-day PUSH/PULL/LEGS/UPPER/LOWER split, where
   there's no same-archetype exposure to vary) — preserving the pre-existing incidental variety there
   instead of collapsing every session to "heavy." 5 new regression tests in `tools/test-plan.mjs` lock
   in per-archetype variety (Push A ≠ Push B, Pull A ≠ Pull B, Legs A ≠ Legs B on the 6-day split) and
   confirm the no-repeat fallback still varies across a 5-day week.

10. **[Goal 4] Social layer** — friends/accountability/challenges/leaderboards (the single biggest
    retention lever). *STARTED (Wave 102):* **shareable progress card shipped** — opt-in, revocable,
    read-only card via an unguessable capability token (NOT the user_id); `GET /api/share/:token`
    is public and returns a strict non-PII allowlist (streak/level/sessions) via `publicShareCard`
    (double-tested: unit allowlist + route no-PII). The D1 reverse index is solved with a runtime
    `CREATE TABLE IF NOT EXISTS shares` self-init (no CLI migration needed) — **prod-verified the
    table self-creates and the full mint→public-read→revoke flow works**. **Cheer counter shipped
    (Wave 108):** a public 💪 tally on the card (a viewer taps, the sharer sees "N cheered you on") —
    a second self-init table `share_cheers`, bounded, PII-safe, client-guarded; prod-verified the
    table self-creates and cheers increment/reflect. **Training partners shipped (Wave 115):** an
    accountability first slice — follow a friend's share link (its public token stored on your
    profile.following, capped/deduped) and their streak/level/cheers show on your Coach tab via a
    lazy authed GET; one-directional, partner-unaware, PII-safe (no user_id), revoked partners show
    inactive/prunable; reuses the share reverse-index, no new tables. Cheer rate-limit also shipped
    (Wave 109, per-IP via the magic_links bucket). **You-vs-partners mini-leaderboard shipped
    (Wave 116):** a pure `rankPartners(you, partners)` (`session-core.mjs`) ranks you + active
    partners by streak then level on the Coach tab, your row tagged — reuses data the tab already
    fetches, no new backend. **Reciprocal/mutual accountability + a partner nudge shipped (this
    slice):** `GET /api/following` now flags each partner `mutual: true` when THEY follow you back
    too (derived by checking their `profile.following` for your own current share token — no new
    field to store, no reciprocal access granted, either side's user_id still never crosses the
    wire); `POST /api/following/nudge` is a one-tap encouragement gated to CONFIRMED mutual pairs
    only (a one-directional follower nudging someone unaware they're being followed was the
    creepy failure mode being guarded against) — stores a single pending marker on the receiver's
    profile, surfaced exactly once via `/api/adherence`'s `nudged` flag (the same seen-once pattern
    `new_cheers` already uses) on BOTH the Today landing tab and the Coach tab (a lesson-15-class
    bug caught before shipping: the notification is a byproduct of any `/api/adherence` read, and
    Today calls it first — a banner only in `renderCoach()` would have been silently consumed
    before the user ever saw it). Real-browser-verified end to end (mutual detection, nudge gating,
    seen-once). **Payload-encrypted (RFC 8291) push — crypto core landed + RFC-verified (Waves
    118, 120):** `app/src/push-encrypt.mjs` is a pure WebCrypto `encryptPushPayload` (aes128gcm,
    ECDH→HKDF→AES-128-GCM) that Wave 118 proved by round-trip and Wave 120 proved RFC-compliant
    via a byte-exact known-answer test against RFC 8291 §5's published "watermelon" example (vectors
    cross-checked against rfc-editor.org + datatracker). NOT yet wired into the sweep/SW — the last
    gate before wiring is a live push-service send returning 201 (needs a real browser subscription,
    likely infeasible headless). Still to build (needs deeper infra): challenges; wiring the verified
    encryption into the push sweep + a SW that reads the payload so a cheer/partner/nudge event can
    reach a device NOT currently in the app (the current push is empty-payload, so it can't say
    "someone nudged you" until that layer is wired). **Wiring shipped (Cloud loop wave, PR #202):**
    `push.mjs`'s new `sendPush` builds an RFC 8291-encrypted body via `encryptPushPayload` and
    POSTs it (`Content-Encoding: aes128gcm`) alongside the existing VAPID auth; `runPushSweep`
    checks each subscriber's `profile.partner_nudge` on every hourly tick (not gated to their one
    local reminder hour — a social nudge is a discrete event, not a daily cadence) and sends a
    content-bearing "your training partner nudged you" push, stamping a NEW `nudge_pushed_at`
    seen-once marker (deliberately separate from the in-app `nudge_seen_at` `/api/adherence`
    already uses, since a push must reach a device that never reopens the app) so the same nudge
    never re-fires. `sw.js`'s `push` handler now reads `e.data.json()` when present (the browser
    decrypts before the SW ever sees it — no client-side crypto needed) and falls back to the old
    static reminder copy when absent, so the empty-payload daily reminder is untouched. Verified
    with a real ECDH+HKDF+AES-GCM round-trip in tests (encrypt via `sendPush`, decrypt with the
    fake subscriber's own keys, assert the exact JSON survives) plus sweep-level tests for
    dedup/re-fire/pause-gating. Cheers and challenge events aren't wired into push the same way yet
    (no natural single-event marker like the nudge's `at` timestamp — would need a per-cheer-count
    high-water-mark design, or an equivalent for challenge propose/respond). The
    live-push-service-send-201 check (needs a real browser subscription) stays the last
    production-readiness gate, unchanged from Wave 120 — infeasible to verify headless. **Weekly
    race shipped (Wave 125):** the all-time streak/level leaderboard (Wave 116) never resets, so a
    lapsed partner still outranks someone training hard *this* week — no short-horizon urgency.
    `publicShareCard` (the same non-PII allowlist `GET /api/share/:token` and `GET /api/following`
    already return) now also carries `sessions_this_week` (reusing `weeklySummary`, the same window
    `/api/adherence` shows you for yourself); a new pure `weeklyRaceStatus(youThisWeek,
    partnerThisWeek)` (`session-core.mjs`, unit-tested alongside `rankPartners`) compares you to
    each partner and the Coach tab's partner row now shows "🏁 you're ahead this week" / "they're
    ahead this week" / "tied this week" next to the existing streak/level line — resets naturally
    every week with no new persisted state, no propose/accept flow, no push wiring (in-app only,
    same shipped-alone precedent as the cheer counter and the mini-leaderboard). Both PII-allowlist
    tests (`test-adherence.mjs`, `test-routes.mjs`) updated to the new 4-key card shape; a route
    test locks in that `sessions_this_week` actually flows through `GET /api/following`, not just
    the public share endpoint. **1v1 weekly challenges shipped (Wave 126):** the accept/decline
    state machine the item above deliberately left out. v0 scope: at most ONE challenge per user at
    a time (challenger or opponent), no history — `POST /api/challenge` (propose, mutual-partners
    only, reuses the same not-following/not-mutual checks as nudge), `POST /api/challenge/respond`
    (only the opponent can accept/decline — a challenger "accepting" their own proposal would skip
    the consent step the whole feature exists to add), `GET /api/challenge` (live tally for both
    sides via the new `sessionsInWeek(sessions, weekKey)` — unlike `weeklySummary`, scores a
    SPECIFIC week key so it stays correct after that week has ended, needing no snapshot or cron).
    No new store table: a mirrored `profile.challenge` object on BOTH sides (each side writes its
    own half, plus the other's on propose/respond — the same two-sided-write shape `following`'s
    reciprocal check already reads). A challenge self-transitions to a terminal state ("completed"
    if it was active, "declined" if a proposal just went unanswered) the next time EITHER side reads
    it past its week or after its opponent's share vanishes — which also reopens that user's slot.
    Caught and fixed one real bug before shipping: the "already open" guard on propose originally
    trusted stored status literally, so a stale-but-not-yet-read challenge could wrongly block a
    fresh propose as "opponent-busy" even though its week had already ended — fixed with a shared
    `isChallengeOpen` predicate that also checks the week, not just the status. Coach tab renders a
    "⚔️ challenge" button per mutual partner (hidden while a slot is occupied), a pending
    accept/decline card, an in-progress tally, and a final win/lose/tie result. 21 new route tests
    (propose/mutual/self-target/already-open/opponent-busy/decline/accept/live-tally/week-over-
    resolution/slot-reopening, all from both sides) + 4 new `sessionsInWeek` unit tests. Still not
    the full "challenges" vision (only ONE concurrent challenge, no history/win-loss record, no
    push notification when challenged) — those are natural v1 follow-ons once a real table is
    justified by the need for multiple concurrent challenges or a history view. **Audit fix
    (Cloud loop wave):** `isChallengeOpen`'s week-freshness check (Wave 126) was applied to
    `POST /api/challenge` (propose) but not to `POST /api/challenge/respond` — the normal UI
    always calls `GET /api/challenge` first, which self-transitions a pending-past-its-week
    challenge to "declined" before ever rendering accept/decline buttons, but `respond` is
    reachable directly (possession-of-UUID auth means any client can call it without going
    through GET first), so a stale pending challenge could be revived into "active" via a late
    accept — later resolving into a fabricated "completed" result from training logged before
    either side had agreed to compete. Fixed by enforcing the same week check in `respond`
    directly; 3 new route tests lock in the stale-accept/decline refusal and confirm no
    "active" residue survives on the challenger's side. **Challenge history / win-loss record
    shipped (Cloud loop wave, PR pending):** the one still-open gap the wave above flagged
    ("no history/win-loss record"). No new store table — `profile.challenge_history` (capped
    at 20, oldest dropped, same cap convention as `following`) lives beside the existing
    single-slot `profile.challenge` mirror, on both sides independently. `GET /api/challenge`
    now computes both sides' tallies ONCE up front and reuses them for both the live-tally
    response AND the history write when a challenge genuinely completes, so the two can never
    disagree. A result is recorded ONLY when an ACTIVE challenge ran its course against a
    still-active opponent (win/lose/tie from the two counts already fetched) — an opponent's
    share vanishing mid-week or an unanswered (declined) invite has no real score, so neither
    writes a history entry (same "don't manufacture a result" stance the rest of the feature
    already takes). Re-reading a terminal challenge is a no-op (status is no longer
    pending/active, so the write path never re-fires). The Coach tab shows a persistent
    "📊 Challenge record: NW – ML across K challenges" card beneath the single current-challenge
    card, so a win/loss history survives past the next challenge overwriting the live slot.
    6 new route tests (win recorded correctly, the mirror loss on the opponent's own side, no
    entry on decline, no duplicate on re-read, the 20-entry cap drops the oldest). Real-browser-
    verified with Playwright (pre-installed Chromium): completed a real challenge through the
    HTTP API, loaded the Coach tab, and confirmed the record card renders "1W – 0L across 1
    challenge" beneath the win/lose result card. Not done: no way to see PAST opponents by
    identity (deliberately — the feature stores no PII/user_id, only aggregate W/L/T), and
    multiple concurrent challenges / a full history LIST view remain the v1 follow-ons the prior
    wave already named. **History LIST view shipped (Wave 129):** frontend-only — the per-entry
    list (icon/result/week/score) now renders beneath the aggregate record card; `formatWeekLabel`
    (pure, unit-tested) turns the internal ISO week key into a readable label. Only "multiple
    concurrent challenges" remains an unclaimed v1 follow-on (needs a real table, a bigger change).
    **Referral loop closed (Cloud loop wave):** every prior social-layer wave assumed BOTH sides
    already had an account — the public share card (`share.html`) had a "Start your own — free"
    link that dumped a new visitor at `/` with zero memory of which friend's card sent them there,
    and an EXISTING app user who opened a friend's card had no way to become their training partner
    except leaving the page, finding the Coach tab, and pasting the URL back in by hand — real
    friction on exactly the feature Goal 4 needs most (net-new users arriving with a built-in
    accountability partner from session one). Two small, code-groundable additions, no new store
    table: (1) `share.html` now checks `localStorage.getItem("hb_user")` (same-origin, so it's
    already there for a returning app user) — if present, it shows a "🤝 Follow their progress"
    button that calls the existing `POST /api/following` directly from the share page (one tap,
    reuses `SOCIAL_ERROR_COPY`'s existing self-follow copy for the token's-your-own-card case);
    if absent, the CTA link now carries the share token forward (`/?follow=TOKEN`) instead of
    dropping it. (2) `app.js` stashes that token in `localStorage` (`tryPendingFollow`, consumed
    once and removed so it can never re-fire into a follow loop) and auto-follows the instant a
    `uid` exists — either immediately at boot (an existing user who opened the link directly) or
    right after `submitOnboarding` succeeds (a brand-new signup). `POST /api/following` already had
    no session-count gate (confirmed against the existing route tests, which follow with a
    zero-session fresh account), so this needed no backend change at all. Best-effort throughout: a
    dead/self/already-followed token silently no-ops, same posture as every other background social
    action in this codebase. Real-browser-verified (Playwright, pre-installed Chromium) end to end:
    an existing user landing on a friend's share card and tapping the button shows up as an active,
    following partner server-side; a brand-new visitor arriving via `/?follow=TOKEN`, completing the
    real onboarding wizard through the UI, ends up following that same friend with no manual paste
    step. No `data/`/`content/` touched (no `build-data` regen needed); `public/app.js`,
    `public/share.html` changed so `sw.js` `VERSION` bumped (v130→v131); no new imported file, so no
    `SHELL` precache change needed. Root `npm test` + `npm run check` and app `npm test` (full
    suite incl. `test-routes.mjs`) green — the feature is pure client glue over an already-tested
    endpoint, so no new unit test was added beyond the existing `#following` coverage this reuses;
    verified instead via the real-browser walkthrough above, per CLAUDE.md's UI-change rule.
    Citation work was skipped again this wave: PubMed E-utilities and Crossref both still return
    `403` for this session (re-confirmed directly via `WebFetch` against both hosts), so per
    CLAUDE.md's "never fabricate a citation" rule no KB content was touched. Avoided the four other
    open cloud-loop PRs' pattern (diff-scoped audit fixes inside `push.mjs`/`merge-profile.mjs`/
    `adherence.mjs`, PRs #238-#241) by picking a genuinely new, unclaimed capability instead of a
    fifth pass over the same small surface.
    **Audit fix (Cloud loop wave):** `GET /api/challenge`'s completion write reported the
    optimistically-computed win/loss to the client even when the CAS guard no-op'd the actual
    store write — reachable because `isChallengeOpen` (Wave 127) already treats a week-over
    challenge as free, so a fresh `POST /api/challenge` propose can legitimately race in and
    replace this user's challenge id between the read and the write. The response now reflects
    exactly what `store.updateUser` actually persisted, never the optimistic guess — a phantom
    "trophy" the store never recorded is no longer possible. 2 new route tests simulate the race
    (a monkey-patched `store.updateUser` swaps the challenge id mid-request) and confirm neither
    the response nor the store shows a fabricated entry; verified the new test fails without the
    fix and passes with it.
    **Audit fix (Cloud loop wave, diff-scoped over Waves 144-146):** `merge-profile.mjs`'s own
    header cites lesson 16 ("a field added to the user record after reassignUserData was written
    silently orphans on merge") as the exact reason the file exists — yet two NEW profile push
    markers Waves 145/146 added (`freeze_pushed_week`, and `cheers_pushed`/`cheers_seen` at the
    share-reassignment site) were never wired into it, since both post-date the file's last
    lesson-16 audit at Wave 142. Two distinct real gaps, not one: (1) `streak_freezes` and session
    history already merge additively, so `streakFreezeState`'s `protectable_week` is recomputed
    fresh from the SURVIVOR's combined timeline post-merge — a week already pushed-about on the
    departing account can resurface as "new" and fire a duplicate streak-freeze nudge; fixed by
    adopting the lexically-later (ISO week keys are zero-padded, so string order is chronological
    order) of the two markers, never a raw overwrite. (2) When a share is reassigned onto a
    survivor with none of its own (the existing `else` branch in both `store.mjs` and
    `store-d1.mjs`'s `reassignUserData`), the share's lifetime cheer COUNT transfers but the
    survivor's own watermark defaults to 0 — the push sweep and the in-app "N new cheers" banner
    would both read the inherited share's full history as brand new, a fabricated "N people
    cheered you!" for cheers the user already saw pre-merge; fixed by adopting the departing
    user's watermarks exactly when (and only when) its share is the one that survives — confirmed
    the OTHER branch (both users already share, the departing one is dropped) leaves the
    survivor's own watermarks untouched, since adopting there would wrongly suppress a real
    pending cheer notification on the survivor's still-live share. Both fixes live once in the
    stores/merge-profile.mjs shared by file + D1 (parity preserved, confirmed via the
    `test-store-d1.mjs` side-by-side harness). 8 new regression tests across `test-auth.mjs`
    (freeze-week adopt-when-later/keep-when-later/adopt-when-empty; cheers-watermark adopt-on-
    inherit and untouched-when-dropped) plus existing D1 parity coverage, all green; root
    `npm test` + `npm run check` and app `npm test` (full suite incl. `test-routes.mjs` and the
    D1 parity harness) green. Docs/code only where noted — no `data/`/`content/`/`public/` file
    touched, so no `build-data` regen or SW `VERSION` bump needed.

## Audit fix (Cloud loop wave, outside the tiers above)
**`stallDetect` (`tools/derive-core.mjs`) could double-flag one exercise from BOTH its e1RM
and load paths, rendering a duplicated name on the Progress tab's plateau card.** The function
tracks two independent per-exercise week-maps — `byEx` (reliable low-rep e1RM data) and
`byExLoad` (high-rep pump-band load data) — with a majority-of-weeks guard meant to route each
exercise through exactly one path (mirroring the same dual guard already correct in its sibling
`progressionByExercise`). The `byExLoad` loop had its half of the guard; the `byEx` loop never
got the reciprocal check. Whenever an exercise's load-path week-count exceeded its e1RM-path
week-count (e.g. a lifter logs a backoff/pump set every week but skips the heavy top set one
week), both loops pushed a stall entry for the same exercise — `progressReport` returns this
`stalls` array unfiltered and `app.js` renders it as `"2 lifts have plateaued: Bench Press,
Bench Press"`, a literal duplicated name and a wrong count on a coaching surface that's supposed
to build trust (Goal 2/3). Fixed by adding the same reciprocal guard `progressionByExercise`
already uses. One new regression test in `tools/test-derive.mjs`, verified to fail on the
pre-fix code (2 entries) and pass on the fix (1, `basis: "load"` since majority-of-weeks routes
it there). Entirely contained in `tools/derive-core.mjs` + its test file — no `data/`/`content/`/
`app/src`/`public/` file touched, so no `build-data` regen or SW `VERSION` bump needed. Root
`npm test` + `npm run check` and app `npm test` (full suite) all green.

## Audit fix (Cloud loop wave, outside the tiers above)
**Progress screen's bodyweight trend/energy-balance was averaging the user's ENTIRE
lifetime weigh-in history, not the current phase (lesson 19 recurring).** `/api/today`'s
recovery gate already windows `bodyweightTrend`'s input to the last 42 days, with a comment
explaining exactly why (Wave 69: unwindowed, "block-average" silently became a lifetime
average). `progressReport` (the Progress tab's `/api/progress`) and the `POST /api/bodyweight`
response called the SAME `bodyweightTrend`/`classifyEnergyBalance` pair with the full,
unwindowed history — so a user who bulked for months, then genuinely cut for 3 weeks, still
saw "surplus" / "Lean-gain rate looks on target" on the Progress screen, because the
least-squares regression line was dominated by the larger, older dataset; `/api/today`'s
autoregulation gate, reading the same underlying data with its 42-day window, would correctly
read "deficit" the same day — two contradictory energy-balance readings for one user (lesson
10: a derived status must never contradict what's actually known). Fixed in `app/src/coach.mjs`
(`progressReport`) and `app/src/app.mjs` (`POST /api/bodyweight`): both now window to the same
42-day block, falling back to the full history when the window has fewer than 3 points
(`bodyweightTrend`'s own floor) — the safe direction, never worse than before for a sparse
logger. New regression test in `app/scripts/test-coach.mjs` proves a 5-month-old stale bulk and
a genuine recent 3-week cut diverge in direction, and that the fix picks the recent one.

    **Quiet hours for social pushes shipped (Cloud loop wave):** `BLOCKERS.md` #4 promised "the
    push handler + quiet hours + self-tapering" but only the daily/commitment reminder ever got
    an hour gate (`isUserPushHour`'s single local slot); the discrete social events — a training-
    partner nudge, a challenge invite/accept/result, a share-card cheer — were deliberately built
    (and tested) to fire on the sweep's very next hourly tick regardless of local time, favoring
    immediacy over politeness. That means a subscriber could be woken at 3am local by a cheer, a
    real risk for Goal 4: a bad-time push is a plausible reason someone revokes notification
    permission entirely, killing every future push. `app/src/push.mjs`'s new
    `isSocialPushQuietHours(tzOffsetMin, now)` gates only those five discrete social-push sites
    (never the settle/bookkeeping step, and never the already-targeted daily reminder) to a local
    00:00–07:00 window; unknown-timezone subscribers are left unrestricted (same "don't starve
    delivery over missing data" choice `isUserPushHour` already makes for its own legacy slot).
    The gate only DEFERS — the underlying pending condition (nudge `at`, challenge `created_at`/
    `accepted_at`, cheer count, settled-but-unpushed result) is untouched, so a quiet-hours push
    fires on the sweep's next non-quiet tick instead of being lost (same at-least-once contract as
    every other guard in the sweep). 8 new tests in `app/scripts/test-push.mjs`: the boundary
    (midnight quiet, 6am quiet, 7am not quiet — window end exclusive, noon not quiet, unknown tz
    never gated) plus an end-to-end sweep proving a pending nudge is silent during quiet hours and
    still fires, unaltered, on the next eligible tick. No `data/`/`content/`/`public/` touched, so
    no `build-data` regen or SW bump needed; both gates green (root `npm test`+`npm run check`,
    app `npm test` incl. `test-routes.mjs`).


## Audit fix (Cloud loop wave, outside the tiers above)
**Ran the loop's own escape valve (lesson 17) instead of forcing filler.** Tier 1 and Tier 2 are
both fully shipped/closed; every remaining named Tier-3 item was either already shipped, claimed
by an open PR (#228, email fallback for push-less social events — verified it's real and current:
the code it targets, `worker.mjs`'s `scheduled()` VAPID gate, is unchanged on `main`), or confirmed
too large for one iteration by multiple prior sessions (1v1 challenge → multiple-concurrent needs
a new store table + a redesigned matching/self-transition model, not a bounded-array tweak — the
existing single-slot mirror already threads through routes, push, merge-profile, and D1/file
parity, and multiplying that by N concurrent slots multiplies every one of those surfaces, not
just storage). Rather than force an oversized slice or manufacture a marginal citation add (the
exact "single-citation currency as default filler" this file already warns against), ran two
inline-verified audits per token discipline: (1) a diff-scoped correctness sweep over
`bc586cc..HEAD` (Waves 147–155, the range since the last audit burst) against the standing lessons
(esp. 16/19/21/22/23, since that range touches new push markers, D1/file store merge parity, and
calendar-date math) — read the actual diffs for `merge-profile.mjs`, `push.mjs`, `store.mjs`,
`store-d1.mjs`; no defect found, the watermark-adoption and quiet-hours logic is correctly reasoned
and already tested; (2) a fresh security audit (a dimension not recently exercised) of every route
in `app.mjs` plus `auth.mjs`/`store.mjs`/`store-d1.mjs`/`email.mjs`/`push.mjs` for ownership
bypasses, injection, PII leaks via the share card, and rate-limiting gaps on the newer social
routes — clean beyond the already-documented and accepted `#6b` merge/delete risk. **What shipped
instead:** `BLOCKERS.md` #4 (the VAPID secret) was briefly escalated 🟡→🔴 on the *hypothesis*
that the secret might be unset (which would have meant ~15 waves of Goal-4 push code — nudges,
challenge events, cheers — shipping fully tested but never firing a single real push in prod).
**RESOLVED (Wave 158, verified 2026-07-26):** `wrangler secret list` on the prod Worker shows
both `VAPID_PRIVATE_JWK` and `RESEND_API_KEY` present, so `worker.mjs`'s cron gate passes and the
hourly `runPushSweep` **has been live all along** — the hypothesis is disproven, #4 is moved to
`BLOCKERS.md`'s Done section, and PR #228's email fallback is now purely a product choice (whether
to *also* email push-less users), not a fix for broken push. Registry currency check: `citations/registry.json` is at
121 verified citations (was 119 at the last count in this file, Wave 122/123; +2 since, consistent
with Wave 147's Henselmans 2022 addition — not itself evidence of drift, just a housekeeping note
for the next full re-audit). **This paragraph is the honest state as of this wave:** per lesson 17,
a swept codebase is not a met goal — the next iteration should either check PR #228's merge status
and build the next genuinely new slice once "multiple concurrent challenges" gets scoped down to
something table-sized, or run a fresh, larger Goal-1 KB gap audit (the "Honest distance to each
goal" section above is itself flagged as due for one now that Tier 1/2 have emptied) rather than
re-running this same clean-audit pass a third time.

## Audit fix (Cloud loop wave, outside the tiers above)
**`/api/reminders` and `/api/pause` could 500 in prod instead of a clean 404 on a malformed
request.** (Authored while 14 cloud-loop PRs were queued unreviewed — that backlog was cleared by
Wave 172 below; the point-in-time backlog/citation-outage narration this section used to open with
is superseded and was trimmed at land time.) This wave scoped a
targeted Explore search to files NONE of the then-open PRs touch (`planner.mjs`, `movement-demo.mjs`,
`kb.mjs`, `auth.mjs`'s core magic-link logic, the exercise-swap/custom-exercise/nutrition-log/
share/following routes in `app.mjs`, and a fresh pass over `session-core.mjs`) and verified its one
finding inline before fixing: `app.mjs`'s `/api/reminders` (line ~444) and `/api/pause` (line
~456) both called `store.updateUser(b.user_id, ...)` with no guard on a missing `user_id` — unlike
their siblings `/api/commitment` and `/api/streak/freeze`, which already carry the exact documented
fix for this (Wave 82: `store.updateUser(undefined)` returns `null` on the file store, harmlessly
producing a 404, but *throws* on D1 because `db.prepare(...).bind(id)` rejects an `undefined` bind
param — confirmed directly against this project's own D1 shim, which raised exactly
`"Provided value cannot be bound to SQLite parameter 1"`). A malformed or premature POST to either
route (e.g. a client racing onboarding, or local storage not yet populated) would 200/404 locally
but 500 in prod. Fixed with the identical one-line guard (`if (!b.user_id) return c.json({error:
"unknown user"}, 404)`) the two sibling routes already use, at the same call-site position (before
the store call). Added 4 new regression tests in `app/scripts/test-routes.mjs` (no-`user_id` 404
for both routes, plus a normal-path sanity check for `/api/reminders`, which had no existing test
coverage at all) — following the same file-store-only test pattern the sibling fixes used (the
divergence is real only against D1, which this test harness doesn't exercise directly; the D1
throw was verified separately, out-of-band, against the D1 shim). No `data/`/`content/`/`public/`
file touched, so no `build-data` regen or SW `VERSION` bump needed. Root `npm test` + `npm run
check` and app `npm test` (full suite incl. `test-routes.mjs`): all green.

## Audit fix (Cloud loop wave, outside the tiers above)
**The proactive weekly-commitment push (Tier-1 #2, Goal 4's flagship "when will you train
this week?" nudge) silently never fired for west-of-UTC users on the day it exists to catch.**
`app/src/push.mjs`'s `shouldPushForCommitment` computed "is today one of the
committed days" via `weekDayKey(now)`/`isoWeekKey(now)` on the RAW UTC sweep instant — unlike its
siblings in the same file (`isUserPushHour`, `isSocialPushQuietHours`), which already localize
`now` by the user's stored `tz_offset_min` before reading UTC calendar fields (lesson 1/16: a
scoping fix landed on some call sites, not this sibling one). For any `tzOffsetMin <= -420`
(US Mountain/Pacific/Alaska/Hawaii), the sweep's own `PUSH_TARGET_LOCAL_HOUR` (17:00 local) falls
on the NEXT UTC calendar day, so `weekDayKey` read tomorrow's weekday and a Tuesday commitment
could never match on a real Tuesday — silently dead for the entire lifetime of that offset, for
every affected user, not an occasional miss. The same unlocalized `now` also broke the "already
trained today" check (`toISOString().slice(0,10)` compares UTC dates, not the user's local
calendar day). Fixed by localizing both `now` and `lastSessionAt` with the same
`+new Date(x) + tzOffsetMin*60000` pattern `isUserPushHour` already uses, falling back to raw
UTC when `tzOffsetMin` is unknown (same "don't starve delivery over missing data" choice the
sibling functions make); `runPushSweep`'s call site now passes `user.profile?.tz_offset_min`
through. 5 new regression tests in `app/scripts/test-push.mjs`: the pure-function bug reproduced
directly (a Mountain-time Tuesday commitment now matches; a regression guard confirms it fails
without `tzOffsetMin`), the localized "already trained"/"trained yesterday" cases, and a full
`runPushSweep` end-to-end test proving the actual plumbing (not just the pure function) fires the
push at the user's real local hour. The existing UTC+12 end-to-end test never caught this because
a positive offset at the 17:00-local target hour never rolls the UTC calendar day backward — only
a negative offset does, which is exactly why this shipped unnoticed. App `npm test` (full suite)
and root `npm test` + `npm run check`: both green. No `data/`/`content/`/`public/` file touched,
so no `build-data` regen or SW `VERSION` bump needed.

## Wave 172 — the cloud-loop PR backlog, reviewed and landed
The 16 open cloud-loop PRs (2026-07-26/29, all predating the entire Waves 162–171 landing) were
each re-reviewed against current main — premise re-verified with file:line evidence, staleness
and conflicts mapped — then **14 landed** on one integration branch and **2 closed as obsolete**:
- **Landed:** #251 (reminders/pause user_id guard — the D1 undefined-bind 500), #238
  (commitment-push localized to the user's frame), #250 (challenge/commitment week keys stored
  AND consumed in the user's local frame — `isoWeekKeyLocal`), #239/#241 (merge-profile lesson-16
  gaps: pending partner nudge, Fuel nutrition stats), #240 (`settleChallenge` returns the
  PERSISTED state on a raced no-op write, lesson 21), #245 (`progressionCadence` dual-path
  double-count, the same majority-of-weeks guard its siblings had), #247 (deload/comeback-eased
  sets can no longer fabricate an all-time PR — e1RM's rep bonus made a light 90×10 "beat" a real
  100×5), #243 (bodyweight logs stamp the LOCAL day; Fuel form no longer crashes for non-female
  users), #244 (honest "week in progress" note on a first Progress visit), #242 (share-card
  referral loop: a visitor who taps "train with me" lands following the sharer), #248/#249
  (permanent deterministic fuzz sweeps over plan-core and derive-core), #228 (email fallback so
  push-less users still hear about nudges/challenges/cheers — rebased onto the quiet-hours
  refactor; its "push may be inert" motivation was already disproven, the reach gap was real).
- **Landing adjustments beyond the PRs themselves:** #250's fix was extended to the four
  challenge-week CONSUMPTION sites in `push.mjs` it missed (a west-of-UTC Sunday-evening invite
  stored the local week while the raw-UTC comparison had already rolled — the invite/accept push
  could never fire; new boundary regression test in `test-push.mjs`); #249's sweep gained
  Wave 171's `"effort"` signal in its allowed list; one SW bump to v144 for the whole batch.
- **Closed:** #246 (its refuted store-parity finding has been durably recorded in
  `test-store-d1.mjs` since Wave 141 — the dedup divergence is intentional and locked by the
  collide-from/collide-to tests; do not re-investigate), #252 (its "citation network down" claim
  is refuted from this environment — PubMed E-utilities and Crossref both return 200; the real
  residue, that the CLOUD sandbox's egress proxy denies CONNECT to those hosts, moved to
  BLOCKERS.md as an environment note).

## How the loop uses this
Each iteration pulls the top unfinished item that fits its token budget, ships it as a verified
wave (both gates green, deployed + prod-smoked when an authed session; PR-only in the cloud),
and checks it off here. When a whole tier empties, re-run the gap audit and repopulate. The
codebase being "swept" of defects does NOT mean the goals are met — they are not close.
