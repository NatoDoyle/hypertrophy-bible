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
1. **[Goal 4] Wins & PR celebration.** — *PARTIALLY SHIPPED (Wave 79).* Done: reusable pure
   `detectPersonalRecords` (est-1RM PRs for heavy work AND load PRs for higher-rep hypertrophy
   work — the pump-band gap), wired into the recap with a celebratory "🎉 New personal record!"
   banner. **Remaining slices (build next):** (a) bonus XP for a PR (adherence.mjs `xpAndLevel` —
   the engine now supports replaying PRs over history); (b) an in-*player* PR moment (celebrate
   mid-session when a set beats a best, not only in the recap); (c) a persistent "wins"/PR feed
   + PR count (a lookback surface — progress-dopamine).
2. **[Goal 4] Variable rewards + proactive habit reminders.** Surprise "lucky set"/bonus XP on
   top of fixed XP; a weekly "when will you train?" commitment device; push reminders keyed to
   the user's *own* logged training times, not just lapse-reactive.
3. **[Goal 2 bottom / Goal 3] Inline exercise demos, v0.** Add a `media` field to the exercise
   schema; ship one looping line-art/silhouette animation per `movement_pattern` (~20 cover all
   171 exercises) inline on the set screen; delete the YouTube-search punt. Upgrade to
   per-exercise clips over time. (Real footage remains BLOCKERS #1.)
4. **[Goal 3] Novice-friction quick wins.** *PARTIALLY SHIPPED (Wave 81).* Done: the set screen's
   "leave about N in the tank" target no longer surfaces the bare "what's RIR?" glossary link to
   a true novice (`buildToday` now returns `beginner` from `training_status`, gating the term
   client-side; non-beginners keep it). **Remaining slices:** hide the specialization question
   from beginners; make the workout the day-1 hero over the optional check-in; collapse the Fuel
   wall to bodyweight+activity with an inferred BF% estimate.
5. **[Goal 1] Citation-coverage gate.** `tools/check-claim-coverage.mjs` in `npm run check`: fail
   when a page with [Grade A]/[Grade B] markers has zero `[^key]` citations (allowlist framework
   pages). Makes "every claim web-verified" measurable and stops regression.

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
