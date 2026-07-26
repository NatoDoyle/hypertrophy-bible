# Roadmap — the distance to the four goals

This is the loop's **work queue**. It exists because the loop drifted into low-leverage
citation maintenance while treating a mature-*looking* codebase as "nearly done." Measured
against the four goals in `improvement-loop.md`, this project is **early-stage**. Pull the
next build from here (Tier 1 first); drop to marginal polish (single-citation currency,
cosmetic tweaks) ONLY when a genuinely high-value gap appears — never as default filler.

Grounded assessment date: **2026-07-24** (a repo-wide, file-grounded gap audit; redo when a tier empties).

## Honest distance to each goal

**Goal 1 — world's best knowledge source: FAR.** The recently-waved "hot" pages
(`mechanisms`, `volume`, `proximity-to-failure`) are genuinely world-class. But the whole KB
rests on **~110 sources** (Wave 92–95 additions since this paragraph's original count of 99) —
MASS reviews ~150–200 studies/year; Schoenfeld's textbook cites hundreds. Coverage is bimodal:
most of the 24-page `09-getting-started` pillar is practical/logistics content with no gradeable
claims to cite (not a gap — see Tier-2 #6's reassessment); `energy-balance` and `sleep` are now
cited (Wave 92/95), and `weak-point-prioritization` picked up 4 citations (PR #184).
`breaking-advanced-plateaus` and `long-term-and-annual-planning` stay honestly Grade C/D —
planning heuristics no trial has directly tested, not an oversight. The **7 muscle guides —
the product backbone** — are 480–893-word quick cards for most regions (back.md is the
exemplar depth upgrade, Wave 93), not yet authoritative treatments everywhere. Missing whole
topics: fiber-type×rep-range and tendinopathy were checked and are NOT gaps (already covered);
menopause/HRT and pregnancy/postpartum shipped (Waves 89/91). Supplements: 15 entries now
(creatine, caffeine, protein, beta-alanine, citrulline, HMB, BCAAs, EAAs, vitamin D, omega-3,
ashwagandha, glutamine, ZMA, tart cherry, testosterone-boosters) — this breadth item is done.
"Every claim web-verified" is materially higher than "a third of the surface" now, but still
short of comprehensive — this whole paragraph is due a fresh grounded re-audit, not incremental
hand-edits, once Tier 1/2 next empties.

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
proactive habit-cue is now delivered (a commitment-day nudge at a sensible local hour). Biggest
remaining Goal-4 lever: anything **social** (friends/accountability/challenges — needs multi-user
infra, the one genuinely large build left here).

## Build queue (pull from the top)

### Tier 1 — highest leverage, buildable now
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
   The genuinely-remaining elite work is narrower, evidence-supported, but INPUT-GATED (a larger feature,
   not a clean first slice): a **taper/peak toward a goal date** (tapering has real strength-EXPRESSION
   evidence, distinct from hypertrophy) and a **contest-prep mode** — both need a new “goal/meet/show
   date” onboarding input + a peaking protocol; deeper velocity-driven autoregulation needs hardware the
   app can’t collect. So this item serves the strength/peaking/contest end, NOT general hypertrophy —
   and only once a goal-date input exists.
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

## How the loop uses this
Each iteration pulls the top unfinished item that fits its token budget, ships it as a verified
wave (both gates green, deployed + prod-smoked when an authed session; PR-only in the cloud),
and checks it off here. When a whole tier empties, re-run the gap audit and repopulate. The
codebase being "swept" of defects does NOT mean the goals are met — they are not close.
