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
rests on **99 sources** — MASS reviews ~150–200 studies/year; Schoenfeld's textbook cites
hundreds. Coverage is bimodal: the entire 24-page `09-getting-started` pillar has **zero**
citations; core pages carry 0–1 (`energy-balance` 1, `sleep` 2, `weak-point-prioritization` 0,
`breaking-advanced-plateaus` 0, `long-term-and-annual-planning` 0). The **7 muscle guides —
the product backbone** — are 480–893-word quick cards, not authoritative treatments. Missing
whole topics: menopause/HRT, pregnancy/postpartum, plant-based, recomposition,
fiber-type×rep-range, tendinopathy. Supplements: only 8 entries (no vitamin D, omega-3, EAAs,
and no evidence-based debunks). "Every claim web-verified" is true for ~a third of the surface.

**Goal 2 — best coaching app, novice → Mr. Olympia:**
- *Bottom end + Goal 3 (zero cognitive load): one disqualifying hole.* Onboarding and the
  crash-safe player are strong, but there are **no embedded exercise demos** — the app punts a
  never-trained user to a YouTube search and asks them to self-judge "avoid ego-lifting clips"
  at peak anxiety. Every best-in-class app shows an inline loop on the set screen. Plus small
  friction: the specialization question is shown to beginners, the Fuel tab is a 6-field
  tape-measure wall, RIR jargon sits on the set screen, and day 1 highlights the *optional*
  check-in over the workout.
- *Top end (elite): FAR.* The engine runs one linear mesocycle wave + block-boundary volume
  auto-tune + a specialization cap. No block/undulating/conjugate periodization, no
  peaking/taper/contest-prep, no velocity/advanced autoregulation. A serious intermediate
  outgrows it.

**Goal 4 — adherence by every means (the STATED top priority): FAR, and least developed.**
Has the skeleton — forgiving weeks-streak, XP/levels, session-count milestones, comeback
email + push, at-risk warnings. Missing most of the high-powered space: variable/intermittent
rewards (XP is fully predictable), **PR/achievement celebration** moments (est-1RM is computed
but a personal best is never celebrated), proactive habit reminders (push only *reacts* to
lapses), a "when will you train this week?" commitment device, a streak freeze/repair the user
can hold, and anything **social** (friends/accountability/challenges — the biggest lever, needs
multi-user infra).

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
   toast the instant a logged set beats it, not only at the end of the session. **Remaining slice:**
   (c) a persistent "wins"/PR feed + PR count (a lookback surface — progress-dopamine).
2. **[Goal 4] Variable rewards + proactive habit reminders.** — *PARTIALLY SHIPPED (commitment device).*
   Done: the weekly "when will you train?" commitment device — `POST /api/commitment` (pinned to
   the current ISO week, `tools/derive-core.mjs`'s `isoWeekKey`/`WEEK_DAY_KEYS`/`weekDayKey`) lets
   a user state which days this week they intend to train; `push.mjs`'s new
   `shouldPushForCommitment` gives the daily push sweep a genuinely *proactive* trigger — a
   committed day the user hasn't trained yet — independent of `shouldPush`'s lapse-reactive
   days-since-last-session gate (which alone can't fire the day right after training, exactly
   when a same-day commitment reminder should); a `Today`-tab card lets the user set/edit the
   plan and reinforces it once set, suppressed on day 1 (novice-friction). **Remaining slice:**
   surprise "lucky set"/bonus XP on top of fixed XP.
3. **[Goal 2 bottom / Goal 3] Inline exercise demos, v0.** Add a `media` field to the exercise
   schema; ship one looping line-art/silhouette animation per `movement_pattern` (~20 cover all
   171 exercises) inline on the set screen; delete the YouTube-search punt. Upgrade to
   per-exercise clips over time. (Real footage remains BLOCKERS #1.)
4. **[Goal 3] Novice-friction quick wins.** *PARTIALLY SHIPPED (Wave 81).* Done: the set screen's
   "leave about N in the tank" target no longer surfaces the bare "what's RIR?" glossary link to
   a true novice (`buildToday` now returns `beginner` from `training_status`, gating the term
   client-side; non-beginners keep it). Also done (Wave 83): the specialization question
   ("All-in specialization block…") is hidden from beginners — a programming decision a novice
   can't make, now gated on `training_status !== "beginner"` in the onboarding `showIf`.
   **Remaining slices:** make the workout the day-1 hero over the optional check-in; collapse the
   Fuel wall to bodyweight+activity with an inferred BF% estimate; seed the first-set weight to a
   body-scaled estimate.
5. **[Goal 1] Citation-coverage gate.** — *SHIPPED.* `tools/check-claim-coverage.mjs` runs in
   `npm run check` and fails the build when a content page makes a [Grade A]/[Grade B] claim but
   carries zero `[^footnote]` citations. Two plain-language getting-started synthesis pages (which
   cite by reference to their evidence pillars, as STYLE.md §1 permits) are on a short, justified
   allowlist; Grade C/D claims are exempt. Makes "every claim web-verified" measurable and blocks
   regression. Documented in STYLE.md §1. (The deeper per-claim proximity check remains Tier-2 #6.)

### Tier 2 — high value, larger
6. **[Goal 1] Citation-completeness pass** on the undercited core pages (getting-started pillar,
   energy-balance, sleep, weak-point, plateaus…), expanding the registry well past 99.
7. **[Goal 1] Muscle-guide depth upgrade** — rebuild the 7 guides into region-by-region
   authoritative treatments (`back.md` as exemplar), feeding the app's exercise engine.
8. **[Goal 1] Breadth pages** — menopause/HRT, plant-based, recomposition, fiber-type,
   pregnancy/postpartum, tendinopathy; expand supplement data (vitamin D, omega-3, EAAs, debunks).

### Tier 3 — big bets
9. **[Goal 2 elite] Real periodization + peaking** — block/undulating options, a taper/peak
   phase, contest-prep mode, deeper autoregulation. Serves the "win Mr. Olympia" end.
10. **[Goal 4] Social layer** — friends/accountability/challenges/leaderboards (needs multi-user
    infra; the single biggest retention lever).

## How the loop uses this
Each iteration pulls the top unfinished item that fits its token budget, ships it as a verified
wave (both gates green, deployed + prod-smoked when an authed session; PR-only in the cloud),
and checks it off here. When a whole tier empties, re-run the gap audit and repopulate. The
codebase being "swept" of defects does NOT mean the goals are met — they are not close.
