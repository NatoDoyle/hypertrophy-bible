# The improvement loop

A closed loop that keeps driving the project toward three goals, and keeps itself honest.

## The four goals (the only scoring function)

1. **The world's best source of knowledge for hypertrophy.** Every claim web-verified, graded,
   and honest about uncertainty. A neural network.
2. **The world's best coaching app built on that KB — for everyone.** From "I have never heard
   of a gym" to "I am trying to win Mr. Olympia." Both ends, not just one. It should have as
   little manual customization as possible, we ask the right questions at the start and then everything is else is done for them.
3. **Someone with no brain whatsoever can use it.** Zero cognitive load is a hard requirement,
   not a nice-to-have.
4. **Use every possible form of manipulation to get them to use the app.** Adherence and consistency 
   are the most imoportant things above all else, increase them by any means possible. it's not 
   unethical because they're not being charged and their life only improves the more they 
   use the app.

A change is only worth making if it moves one of these. "Does this make someone more likely to
still be training in 3 years?" remains the tiebreak (`docs/app-design-spec.md`).

## The loop

```
  ┌─> AUDIT ──> VERIFY ──> PRIORITISE ──> IMPLEMENT ──> TEST ──> DEPLOY ─┐
  │   (find)   (refute)    (by goal)      (in waves)   (prove)  (prod)   │
  └──────────────────────────── LEARN ───────────────────────────────────┘
                    (record what the audit got WRONG)
```

**AUDIT** — parallel adversarial auditors, one per dimension, over the real code/content.
Dimensions rotate; the standing set is: elite/advanced fitness-for-purpose, KB science depth,
KB citation integrity, novice UX, engine correctness, integration/data-loss, security.

**VERIFY** — every finding is adversarially refuted by independent skeptics *before* it counts.
Default to "refuted" when uncertain. **This step is mandatory.** See "Why" below.

**PRIORITISE** — rank by goal impact: safety > data-loss/correctness > blocks a novice >
blocks an advanced lifter > KB accuracy > polish.

**IMPLEMENT** — in waves, each its own PR, each with regression tests that lock the fix in.

**TEST** — `npm test` (root: schemas, citations, data-refs, derive, plan) + `cd app && npm test`
(coach, auth, adherence) + a real browser walkthrough for anything user-facing. Claims of
"fixed" require observed evidence, not inference.

**DEPLOY** — `cd app && npm run deploy` **as its own step** (never chained after a git pull —
that races and ships stale assets). Then prod-smoke.

**LEARN** — the part that makes it *self*-correcting: record where the audit itself was wrong,
and where a fix was incomplete. Feed that back as a lens in the next audit.

## Lessons the loop has already learned (feed these forward)

These are real failures from previous iterations. Each is now a standing check.

1. **A fix applied to one call site and not the other.** Wave 1 gated fake 1RM PRs in
   `coach.mjs` but not in `derive-core.mjs`, so the Progress screen kept inventing strength
   gains and *contradicted* the recap. → **Standing lens:** for every fix, hunt every other
   call site. Prefer a single exported source of truth over a duplicated constant.
2. **The audit itself can be factually wrong.** An audit claimed the push/pull balance "guesses"
   without the `force` field and that per-side counting undercut `unilateral`. Neither existed
   in the code. Two waves shipped partly on that bad rationale. → **Standing rule:** verify a
   finding's *premise* against the code before acting, not just its conclusion. Hence VERIFY.
3. **Fixes create new bugs.** The MRV trim (a Wave 1 fix) silently desynced the plan's own
   rationale. → **Standing lens:** audit the code the *last* wave introduced.
4. **Only the beginner end was ever audited.** Goal #2 covers novice → Mr. Olympia; every audit
   until now scored only the novice end. → **Standing dimension:** elite/advanced.
5. **The app *prescribed* something it couldn't *execute*.** The plan cued a superset; the player
   could only run exercises sequentially. A feature isn't shipped when the plan mentions it —
   only when the surface the user touches actually carries it out. → **Standing lens:** for every
   coaching instruction the plan emits (superset, unilateral, deload, stretch-focus), confirm the
   *player* honours it, not just the plan JSON.
6. **A UX reorder was actually load-bearing correctness.** Superset pairs are *not* adjacent in
   the session (the engine appends the bonus isolation, then a stable sort can leave an exercise
   between them). "Pull the pair together" looked cosmetic but prevented the between-exercise from
   being silently dropped by the post-station advance. → verifying the *structural premise* in the
   engine (lens 2 used well) turned a nicety into a data-loss guard.
7. **The service worker served STALE code during live testing.** `sw.js` is stale-while-revalidate,
   so the first reload after an edit runs the *old* cached asset; a live test "failed" that the
   fix had already cured. → **Standing checks:** (a) when browser-testing a fresh edit, clear the
   SW + caches first; (b) any NEW asset an existing asset imports (e.g. an ESM module) MUST be
   added to the SW `SHELL` precache list *and* `VERSION` bumped, or offline users get a broken
   import.
8. **The generated `kb-data.mjs` bundle drifted from its source JSON.** A wave committed the
   source `data/**.json` but not the regenerated `app/src/kb-data.mjs`; prod was correct (the
   deploy runs `build-data`) but the committed repo was inconsistent, so `npm start` (no build)
   would serve stale data. → **Standing check:** any change under `data/` must be followed by
   `npm run build-data` and the regenerated `kb-data.mjs` committed in the SAME wave.
9. **The audit's premise was wrong — again — and so were some of its numbers.** #10 claimed
   `weight_kg=0` "zeroes volume"; it doesn't (`isHardSet` counts bodyweight work sets). The Enes
   citation finding cited "~52 sets tested" — not in the abstract. → verify BOTH the audit's code
   premise AND any scientific numbers it quotes against the primary source before writing them
   into the KB; write to what the source actually says, not what the audit asserted.
10. **A derived status must never contradict the user's own direct input.** A low-readiness
   check-in on an already-short session fell through a `length > 3` gate and told the user
   "you're in your normal range" — fabricating a status against the sleep/energy/stress they
   just reported, and teaching them the check-in is fake. → **Standing lens:** whenever the app
   shows a status derived from user input (readiness, streak, PR), prove it can never render a
   value that contradicts what the user directly told it. Branch on the meaning, not on whether
   the downstream action happens to apply.
11. **A per-tab/per-realm guard does not serialize across tabs.** The offline queue's `flushing`
   boolean lived in one tab's JS realm, so two tabs both flushed on reconnect and a
   position-based `slice(1)` dropped an undelivered workout. → **Standing rule:** never mutate
   shared client storage (localStorage) by POSITION under possible concurrency — remove by a
   stable identity (stamp an id at write). Lens C also caught this AND a security comment that
   overclaimed its own protection: review the last wave's code *and its comments* — a comment
   that promises a guarantee the code doesn't provide is worse than none.
12. **A fix can be physiologically bounded — then LABEL the remainder, don't force it.** The
   specialization cap holds *unrelated* muscles at maintenance, but a synergist of the priority
   lifts (triceps under a chest priority) picks up secondary volume no cap can remove. The honest
   move was to relabel the rationale ("carried above maintenance by secondary work"), not to
   distort the plan chasing a number the body won't allow. → when a metric can't be hit without
   lying about the training, make the *explanation* honest instead.
13. **A diagnosed "quality issue" is a hypothesis — verify it's a real defect before fixing.** A
   plan-quality diagnostic flagged "uneven sessions in a rotation" (one day had 4 exercises vs 7).
   Measuring the actual VOLUME showed the sparse day carried the same total sets (12 vs 12) — just
   more sets per exercise, which is legitimate focused programming. "Fixing" it (forcing more
   exercises) would have exceeded the weekly target or created junk volume — degrading quality to
   satisfy a cosmetic metric. Same for "redundant same-family compounds": 3 pushes on a Push day
   is correct, not a bug. → count/surface metrics point you at *candidates*; confirm each is a real
   defect (measure the thing that matters — here, volume — not the proxy) before changing tuned
   code. Two of the four diagnosed plan issues were real (1-set filler, bodyweight-when-loaded) and
   got fixed; two were not, and were deliberately left alone.

14. **A declared-but-unused tunable is a silent contradiction.** `perMuscleSessionCap` sat in
   `plan-core.mjs` with a sensible default for three waves, reading like a working guard — while
   advanced sessions stacked 12 direct glute sets. Two halves to the lesson: (a) **grep every
   tunable/option for a live use site** — a knob that binds nothing actively hides the gap it
   names; (b) **enforce an invariant at the point of mutation, not in the target arithmetic** —
   the 12-set day had legal per-muscle target math; the overshoot accumulated through
   cross-credit side-paths (squat/hinge variants each placed for a *different* muscle, all
   crediting glutes as primary), so capping `perTarget` alone could never have fixed it. Bonus
   Lesson-13 confirmation: two of the audit's four candidate contradictions were falsified before
   fixing — one by the KB's own template data (the variety cap "forbidding" a 3×/week lift the
   beginner template never actually programs), one by reading the KB's permissive language
   closely ("can... sometimes should" is not a prescription).

15. **A status with full client styling and zero producers is dead UI that reads as shipped.**
   The Progress legend explained the `s-maint` "holding steady" status — styled, labelled,
   documented — but nothing ever emitted `"maintenance"`, so specialization users were told to
   "add volume" to muscles their plan deliberately holds at MV (contradicting the plan, lesson
   10's sibling). → **Standing lens:** for every status/enum a surface can render, grep for the
   producer; for every producer, grep for the renderer (the same check that caught `volume_note`
   needing a display line in the same wave it was added).
16. **A new field added to one code path must be carried through — and validated at — every
   consumer.** The iteration-25 audit found three variants of the same shape in one burst of new
   code: (a) `local_date` (Wave 21) was stored with only `slice(0,10)`, so a malformed value
   became an `"NaN-WNaN"` week key that sorts after every real week and hijacked the reference-week
   logic while dropping the session from the streak; (b) the per-session `comeback` flag (Wave 19)
   didn't cover the per-*exercise* layoff ease, so a rotated-back accessory logged a fabricated
   strength drop; (c) `push_subscriptions` (Wave 23) was added to the schema but not to
   `reassignUserData`, so a merge orphaned it. → **Standing lens when adding a field:** (1) validate
   it at the trust boundary (a client-supplied value is hostile until parsed — auth here is
   possession-of-UUID, so *any* client can post), and provide a fallback for bad data already
   stored; (2) grep every consumer of the surrounding record (`git grep` the sibling fields) and
   confirm the new one is handled — merges, sweeps, week-banking, and every derived view, not just
   the happy path that introduced it.
17. **Audit yield decays; adapt the cadence to codebase maturity instead of auditing on a fixed
   clock.** After a burst of aggressive multi-lens audits (iterations 15–39), findings converged to
   *polish, self-churn, and clean lenses* — including a clean sweep of the highest-risk surface
   (session-core crash-safety). Two tells that a surface is swept: (a) the same lens returns nothing
   twice running, and (b) a growing share of "findings" are regressions the *current* burst just
   introduced, not pre-existing defects. When both hold, re-auditing swept code is negative-yield
   churn. → **Standing rule:** when audits stop finding pre-existing correctness/data-loss/security
   defects, STOP the fixed-cadence sweeps and shift the loop to (1) work genuinely gated on new
   inputs — KB currency as new research lands, prod-smoke of live issues; (2) net-new goal-serving
   features when a real gap exists; or (3) surfacing the human-blocked item (`BLOCKERS.md`) that gates
   the next real gain. A slower heartbeat in a swept codebase is correct pacing, not stopping.
18. **A state-changing command chained behind a check in an `&&` sequence silently no-ops when the
   check "fails".** Wave 53 bundled `grep -c … && sed -i … sw.js && …` in one `&&` chain; the `grep -c`
   correctly returned 0 (no dangling refs) which is exit code 1, so the chain stopped *before* the
   `sed` that bumps the SW version ran. The app.js change shipped with the SW still on the old version
   (the exact `public/`-asset-without-SW-bump invariant CLAUDE.md forbids), needing a follow-up wave to
   repair. → **Standing rule:** never gate a required mutation (version bump, migration, write) behind a
   `grep`/`test`/`diff` in an `&&` chain — those exit non-zero as a normal *answer*, not an error. Run
   mutations as their own statements, and after shipping a `public/` asset verify the invariant directly
   (`curl …/sw.js | grep hb-shell-vN`) rather than trusting the pipeline ran end to end. (Wave-171
   refinement: the custom domain's edge cache can serve the OLD asset for a few seconds after a
   successful deploy — a failing first curl is not yet a failed deploy. Re-check with a cache-buster
   (`?nocache=…`) or against the workers.dev origin before diagnosing; only a stale ORIGIN is a real
   failure.)

18b. **`npm run deploy` ships the WORKING TREE, not `main` — never let it run from an unmerged
   branch.** Reconciling a cloud PR: a `git merge` (no conflicts) auto-committed, then a follow-up
   `git add -A && git commit --no-edit` aborted (nothing to say / empty message), breaking the `&&`
   chain — so `git push`, `gh pr merge`, and `git checkout main` all silently skipped, yet a later
   `; … && npm run deploy` still ran and pushed the branch's working tree (with an *uncommitted* SW
   bump) straight to prod. Result: prod briefly ran code that wasn't on `main` — the repo/prod drift
   CLAUDE.md forbids, arrived at from the opposite direction (prod ahead of main, not behind). →
   **Standing rule:** deploy ONLY after the PR is merged and you are on a freshly-pulled `main`
   (`git checkout main && git pull` as its own step, then `npm run deploy`). Don't chain a deploy
   after git steps that can no-op. If a deploy ran from a branch, re-deploy from clean `main` once
   merged (idempotent) so prod == main. And never `commit --no-edit` right after a conflict-free
   merge — the merge already committed; a second commit with nothing new aborts and breaks the chain.

19. **A pure core's docstring states an input contract the BINDER must actually honor — a
   comment is not enforcement.** The recovery gate (`recoverySignal`) averages the check-ins
   it's handed, and its comment literally says "The block AVERAGE" — but the `/api/today`
   binder passed the user's ENTIRE check-in and bodyweight history, so "block average" was
   silently a *lifetime* average: an established lifter wrecked *this* block never tripped the
   under-recovery gate, and a long-past cut read as a current deficit for months, each
   defeating the exact Increment-A/B behaviour the code was built for. The pure function was
   correct in isolation; the binder violated a contract that lived only in prose. → **Standing
   lens:** when a pure function's doc/comment promises a SCOPED input ("block", "recent", "this
   week", "last N"), grep its call sites and confirm the binder actually windows the data — a
   scoping contract stated only in a comment is not enforced, and the pure-core test can't
   catch it because the test hands it already-scoped fixtures. (Same burst re-confirmed lesson
   16: the Wave-49 "~null kcal/day" NaN class returned through a NEW unvalidated field —
   `activity`, whose `ACTIVITY[key] ?? default` lookup resolved an `Object.prototype` key to a
   function — because the boundary guard `bf_pct` got in Wave 49 was never extended to it.
   Every new field needs the boundary check, not just the one that first exposed the class.)
   Meta: this audit — 10 real defects across the nutrition + adaptive-engine code that had
   shipped since iteration-37 — is lesson 17's positive case in action: yield came from
   genuinely UN-audited new code, not from re-sweeping surfaces already swept.

20. **'/loop' command is banned, do not use it** you should follow the loop explained in this 
   file.

21. **A read that also writes must report what it PERSISTED, not its optimistic local guess.**
   Wave 128's `GET /api/challenge` computed a win/loss and flipped status locally, then persisted
   via `store.updateUser`, whose CAS guard (`u.profile?.challenge?.id !== ch.id`) legitimately
   *no-ops* the write when a concurrent propose replaced the slot (reachable because Wave-127's
   `isChallengeOpen` frees a week-over challenge) — yet the response still returned the fabricated
   trophy the store never recorded. The Wave-128 review (mine) called this path "effectively
   correct" under concurrency; it wasn't, and the diff-scoped audit two waves later caught it. →
   **Standing lens:** when a GET/read handler also writes (self-transition, a seen-once watermark,
   a completion record), derive the response from `updateUser`'s RETURN value (the actually-persisted
   state), never from the pre-write local computation; confirm `updateUser`'s return contract holds
   identically in BOTH stores; and guard its `null` return (a row can vanish between the handler's
   read and its write). This is lesson 10 (a derived status must never contradict what's stored) at
   the *response* layer, under concurrency. Meta (token discipline): this fix was code-groundable and
   was fully verified inline before a redundant 3-agent verify-workflow (~177k tokens) merely
   re-confirmed it and the one nit already spotted inline — exactly the verify-agent fan-out
   Token-discipline rule 1 forbids. Verify code claims inline; reserve agents for domain judgment.

22. **Never subtract a UTC instant from a calendar date — compare calendar dates, in the
   user's frame.** Wave 132's taper floored `(dateOnlyEvent - fullInstantNow)/day`: the negative
   fraction on event day floored to -1, so the taper VANISHED on meet morning and the mesocycle
   wave ("peak volume — push hard") came back; the countdown lagged a day, 15-days-out flickered
   in as 14, and west-of-UTC users lost a further day (a Friday-evening session read as Saturday).
   The same wave's date PICKER had the sibling bug client-side (`toISOString()` min = UTC date).
   → **Standing lens:** when a feature involves a calendar date (event dates, week keys,
   streaks), every comparison must be date-vs-date in the user's local frame (`tz_offset_min`,
   falling back to UTC date), never instant-vs-date arithmetic — grep for `new Date(` near any
   `YYYY-MM-DD` field and check which frame each side is in.

23. **State granularity must match loop granularity: a per-USER marker stamped inside a
   per-DEVICE loop loses events.** Waves 131/134 stamped `nudge_pushed_at`/`challenge_pushed_at`
   after the FIRST subscription's 201 inside the flat per-subscription sweep — a two-device user
   got the social push on one arbitrary device, and a stale-but-accepting endpoint could consume
   the event for the device the user actually carries (the daily reminder beside it fanned out
   correctly). → **Standing lens:** when a write marks an event "handled", ask what SCOPE the
   marker has (user? device? event?) and make the loop iterate at that scope: fan out to all
   members first, stamp once, only on ≥1 success (all-failed must retry), precondition inside
   the mutator so a concurrent stamp can't rewind.

24. **Copy that reconciles two mechanisms must trigger off the SAME scope the mechanism it
   describes actually fires at — not the nearest convenient signal.** Wave 147 made the taper
   card honest when a comeback ease overlaps a taper ("the weight stays real" would sit beside
   "I eased this to X kg"), but gated that note rewrite on the SESSION-level layoff (max over all
   sessions) — while the ease it was reconciling fires PER-EXERCISE (`lastAnyDateForExercise`).
   Same threshold, different scope: one lift untrained ≥12 days while the user trained something
   else 3 days ago got an eased card, but the note stayed stock, resurfacing the exact
   contradiction the rewrite existed to kill (found by the Waves 135–155 audit, fixed Wave 156).
   This is [[23]]'s sibling for explanatory copy, and a scope-flavored [[1]] (fix every path, not
   the one path in front of you). → **Standing lens:** when copy asserts "X holds / Y is why X
   changed", find EVERY code path that can flip X or trigger Y (per-exercise vs per-session,
   per-device vs per-user, per-week vs per-block) and make the copy's own trigger cover all of
   them — the tell is a boolean/threshold computed at one granularity gating a message about a
   value computed at another. The mechanism often already exposes the right-scope signal (here the
   per-exercise `eased` tag already existed for the client); reuse it rather than re-deriving a
   coarser one.

25. **A goal stated as an adjective stays unmeasured — turn it into an invariant a gate can fail
   on.** Goal 1 said "a neural network" for many waves and `check-links.mjs` reported a clean
   sweep the whole time — because it only gated *broken* links and *orphans*, both of which were
   already zero. The moment the graph was actually measured (Waves 159–160), the KB turned out to
   have **15 dead-end pages and 26 below two outbound links**, with per-pillar density ranging 0.8
   (myths) to 6.0 (getting-started). Nothing had regressed; the metric that would have shown the
   gap had never been computed. Two sub-lessons: (a) **a green gate proves only what it measures**
   — when a goal is qualitative, ask what number would falsify it and compute that number before
   concluding the surface is swept (lesson 17's blind spot: "the lens returns nothing" can mean the
   lens is pointed at the wrong thing); (b) **five of those dead ends were dead only because their
   links pointed at pillar `index.md` TOCs** — real links in the source that the app renders as
   plain text, i.e. Wave-104/105's lesson recurring silently because it was written as prose
   guidance rather than an enforced invariant. → **Standing rule:** when a fix depends on authors
   remembering a rendering constraint, encode the constraint in the gate (Wave 159 made
   non-canonical/invisible links a hard failure) — and ship the gate in WARN in the wave that adds
   it, flipping to FAIL only in the wave whose authoring makes it pass, so the bar never lands red.
   Corollary for the flip: the unit test asserting the pre-flip state is *supposed* to fail on the
   flip — update it to lock the enforced state, never relax the gate to make a thin new page pass.

26. **A design doc's own decision table is a CHECKLIST — grep every row for a live code
   path.** `docs/adaptive-algorithm.md` opened with a five-lever table ("the algorithm
   chooses push · hold · ease, and which lever to pull"). Three levers were live, one was
   explicitly deferred with recorded rationale — and one, *"Exercise variation / deload —
   stalled at the recoverable ceiling"*, was named in the table, never staged in the
   increment roadmap below it, and implemented by nothing. It read as shipped for waves
   because the table said it existed. The tell was available the whole time: `volumeResponse`
   had been emitting `signal:"change"` ("a deload or a different exercise will help more than
   piling on volume") on every `/api/progress` call since it was written, and **nothing
   rendered it and nothing acted on it** — lesson 15's producer-with-no-consumer, sitting on
   the exact signal the two missing levers needed. → **Standing lens:** treat every row of a
   design doc's decision/lever/capability table as an assertion to verify, the same way
   lesson 14 treats a declared tunable; and when you find a computed-but-unconsumed signal,
   ask what feature it was computed FOR before deleting it — it's often the missing half.

27. **A boundary guard applied to ONE field of a record is lesson 16 waiting to happen.**
   `POST /api/session`'s set mapper clamped `rir` to 0-10 and left `weight_kg` and `reps`
   unbounded in the same object literal, three lines apart, for many waves. Auth is
   possession-of-UUID, so any client can post — and the blast radius was permanent and wide:
   a fat-fingered weight is celebrated as a PR, banked as that week's best in
   progressionByExercise / stallDetect / progressionCadence, and then `suggestWeight` adds an
   increment ON TOP of it. The compounding half: there were **no edit or delete routes of any
   kind and no history screen**, so a bad number was unfixable short of wiping the account.
   → **Standing lens:** when you find a validated field, look at its SIBLINGS in the same
   literal — a whitelist that guards one number and waves through the two beside it is a
   half-applied fix (lesson 1 at field scope). And for any value the engines treat as
   ground truth, ask the second question too: *if this arrives wrong, can the user ever take
   it back?* A write path with no correction path is a one-way door.

28. **"Six weeks" must mean six weeks of the THING, not six weeks of calendar.** The
   mesocycle advanced on wall-clock, so a user who trained twice in six weeks still got
   "Week 6 — deload" — a deload from work that never happened — and `POST /api/pause` froze
   the streak and the comeback emails but not the block clock, so a deliberately paused user
   advanced through phases they never trained. The fix needed no new state (distinct trained
   ISO weeks are derivable from sessions the store already has) and is a no-op for anyone
   consistent, which is the tell that it was always the right unit. → **Standing lens:** when
   a period is named after an activity (a training block, a streak week, an adherence month),
   check whether the code counts the ACTIVITY or merely the elapsed time — and note that
   pause/layoff semantics usually fall out for free once the unit is right, instead of each
   needing its own special case.

29. **A stale branch's FIX ages just like its premise — re-compute its blast radius against
   code written after it.** Wave 172 landed a 16-PR backlog that predated ten newer waves.
   Verdict-review caught what per-PR premise checks alone would not: PR #250 localized the
   challenge-week STAMPS but its call-site list was frozen at authoring time, so the four
   raw-UTC week COMPARISONS in `push.mjs` (written/kept since) would have become actively
   wrong the moment the localized stamps landed — the invite/accept push could never fire for
   the exact users the fix served. Landing a stale change means asking lesson 1's question
   fresh: not "did the author fix every call site" but "what are the call sites NOW" — and a
   frame/scope change (lesson 22/23/24) must land storage and consumption together, never
   split across a merge boundary. Same review: two PRs were closed as obsolete because their
   claims were point-in-time observations (an "outage" that was really a sandbox proxy
   policy; a backlog description the landing itself dissolved) — a PR whose value is a status
   report goes stale the way a fix does not, and should be re-expressed fresh, not merged.

## Token discipline (the loop must be affordable to keep running)

Session telemetry (July 2026): ~4.8M subagent tokens across 6 audit/backfill workflows, twice
wiped mid-flight by usage limits — while confirmed yield per audit had converged to 2–10 defects
and every confirmed finding was re-verified inline by the main loop before fixing anyway. Rules:

1. **Inline verification by default.** Finder agents return candidates; the main loop verifies
   each by reading the code before fixing — no verify-agent fan-out for code-groundable claims.
   At most ONE skeptic agent, only for domain-judgment claims (exercise science, evidence grades)
   where an independent perspective genuinely adds signal. (Iteration-13 proof: 4 candidates
   verified inline in a handful of tool calls; the 8 planned verify agents would have cost ~10×.)
2. **Effort caps in workflows.** Agents never inherit session effort: finders `effort:'high'`;
   mechanical stages (grep sweeps, test runs) `effort:'low'` and/or `model:'haiku'`.
3. **Diff-scoped audits.** Lens-C audits read `git diff <last-audited>..HEAD`, not whole
   surfaces. Full-surface sweeps only for surfaces never audited before.
4. **Fan-out caps.** ≤4 finders per audit, ≤5 candidates each, one workflow per iteration.
5. **Small data tasks go inline.** Short-text authoring (≲30 items) is done in the main loop —
   the 29-line resistance_profile backfill cost 1.07M tokens via 33 agents; inline is ~10× cheaper.
6. **Resume, never relaunch.** After a limit wipe: `Workflow({scriptPath, resumeFromRunId})` —
   completed agents replay free from cache. A relaunch re-buys everything.
7. **Cadence.** Audit every 2–3 implementation waves, not after each; deploy once per burst.

## Guardrails (never traded away for a metric)

- **Never fabricate a citation.** PubMed + Crossref verified, or it doesn't ship
  (`citations/registry.json`). Absence of evidence is stated, not filled in.
- **Never shame the user.** Gamification never pressures training through injury or illness;
  the pause is penalty-free and the streak is forgiving.
- **Never claim more certainty than exists.** Grades are honest; extrapolations are labelled.
- **Never lose logged data.** Offline-first, idempotent writes, crash-safe sessions.

## State

- **Work queue:** `docs/roadmap.md` — the prioritized build list toward the four goals.
  **Pull the next build from Tier 1.** The goals are measured against "world's best" and
  "win Mr. Olympia" and "zero cognitive load" — against that bar this is an **early-stage**
  project, not a nearly-finished one. A codebase swept of defects is NOT the same as the
  goals being met. Single-citation currency and cosmetic polish are **not** Tier-1 work — do
  them only when a genuinely high-value gap surfaces, never as default filler. (Lesson: the
  loop spent a burst adding one citation per iteration while Goal 4 — the *stated* top
  priority, adherence — sat at a skeleton. Don't mistake a swept surface for a met goal.)
- **Blocked on the human:** `BLOCKERS.md` (I add to it; the loop never waits on it).
- **Live:** https://hypertrophybible.com · repo: github.com/NatoDoyle/hypertrophy-bible
- **History:** each iteration ships as PR'd waves; see git log.
