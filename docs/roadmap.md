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
   110. Remaining undercited targets: `weak-point-prioritization` (0 graded — mostly synthesis),
   `breaking-advanced-plateaus`, `long-term-and-annual-planning`, and the getting-started pillar.
7. **[Goal 1] Muscle-guide depth upgrade** — rebuild the guides into region-by-region
   authoritative treatments, feeding the app's exercise engine. *STARTED:* **`back.md` done
   (Wave 93)** — the exemplar: 5 regions (lats/width, mid-back thickness, upper traps, rear delts,
   erectors), each with function + a hypertrophy-ranked pick list pulled from the exercise DB
   (mirroring the engine's lengthened→equipment→fatigue ranking), per-region cues, week-assembly
   summary, and an honest regional-hypertrophy nuance (Varovic 2025). **Reassessed (Wave 95):**
   `chest` (568w, 4 cites), `shoulders` (591w, 3 cites), and `legs` (740w, direct Maeo evidence)
   are already decent region-by-region treatments — back.md was the outlier, so this item is lower
   priority than the audit implied. Thinnest remaining if revisited: `core` (480w), `neck` (489w).
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
   adults per Therdyothin 2025, a health supplement not a muscle-builder). Still to add: EAAs, and
   debunks (glutamine, ashwagandha, ZMA, tart cherry).

### Tier 3 — big bets
9. **[Goal 2 elite] Real periodization + peaking** — *STARTED (Waves 98+100):* **Daily Undulating
   Periodization**, now **auto-derived** (Wave 100, per the Goal-2 minimal-customization
   refinement): advanced trainees on a muscle-building goal get heavy/moderate/light-by-day
   automatically — no question asked — while beginners/intermediates keep the byte-identical linear
   default; `profile.periodization` stays a respected override. Undulates only the COMPOUND band;
   isolations keep their higher-rep near-failure band every day (the KB isolation invariants caught
   and enforce this). Prod-verified (advanced auto-undulates, intermediate stays linear). Still to build:
   BLOCK periodization (accumulation→intensification→peak), a taper/peak phase, contest-prep mode,
   deeper autoregulation (velocity/RIR-driven). Serves the "win Mr. Olympia" end.
10. **[Goal 4] Social layer** — friends/accountability/challenges/leaderboards (the single biggest
    retention lever). *STARTED (Wave 102):* **shareable progress card shipped** — opt-in, revocable,
    read-only card via an unguessable capability token (NOT the user_id); `GET /api/share/:token`
    is public and returns a strict non-PII allowlist (streak/level/sessions) via `publicShareCard`
    (double-tested: unit allowlist + route no-PII). The D1 reverse index is solved with a runtime
    `CREATE TABLE IF NOT EXISTS shares` self-init (no CLI migration needed) — **prod-verified the
    table self-creates and the full mint→public-read→revoke flow works**. Still to build (needs
    multi-user infra): friends/accountability pairs, challenges, leaderboards — the interactive
    social loop beyond a shareable card.

## How the loop uses this
Each iteration pulls the top unfinished item that fits its token budget, ships it as a verified
wave (both gates green, deployed + prod-smoked when an authed session; PR-only in the cloud),
and checks it off here. When a whole tier empties, re-run the gap audit and repopulate. The
codebase being "swept" of defects does NOT mean the goals are met — they are not close.
