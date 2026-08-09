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

30. **A metric you invent measures your intent; a metric you calibrate measures the corpus.
   Compute the distribution BEFORE choosing the threshold.** Waves 173–176 finally measured
   KB depth (lesson 25's own prescription) — and the first draft of the gate was wrong twice,
   in the two ways a new metric is always wrong. (a) It counted digits in the RAW markdown, so
   citation keys (`[^smith-2017]`) and link targets (`../03-programming/x.md`) scored as
   "numbers": the densest bibliographies would have measured as the most quantified guidance,
   grading the reference list instead of the advice. Fixed by measuring only what the app
   RENDERS, reusing the same `stripNonRendered` the graph gate already uses — the metric and
   the product must agree about what the reader sees. (b) The thresholds were invented
   (`minNumericDensity: 1.5`) and would have flagged **~65% of the KB**; the measured corpus
   median was 0.96 and the 10th percentile 0.22. A gate that flags two-thirds of everything
   teaches everyone to ignore it, which is strictly worse than no gate. Shipped floors are
   the measured p10, flagging a real 7-page tail. → **Standing rule:** for any new metric,
   run it over the whole corpus and read the percentiles FIRST, then set the bar; and state
   in the code what the distribution was when you set it, so the next person can tell drift
   from a bad threshold. Corollary, learned the same wave: an AND-composed shortlist
   (`thin AND poorly-linked`) necessarily HIDES items failing one tell — `alcohol.md`, the
   KB's clearest "dose page with no doses", escaped it purely by linking out well — so report
   each component on its own line too. "A green gate proves only what it measures" applies to
   the gates you write, in the wave you write them.

31. **The audit's NUMBERS are hypotheses even when its diagnosis is right — and the honest
   move when they don't verify is to ship the gap, not the number.** The KB-depth finder
   correctly identified that `muscle-soreness-doms.md` contained no time value anywhere, and
   supplied the familiar "onset 12–24 h, peaks 24–72 h, resolves 5–7 days" attributed to
   Cheung 2003. Fetching that abstract showed it says none of those things (nor does Hyldahl
   2017 quantify repeated-bout protection). The page shipped with the numbers that source
   ACTUALLY gives — reduce intensity and duration for 1–2 days, phase novel eccentric work in
   over 1–2 weeks — plus a Key Uncertainty stating plainly that the time course is not pinned
   down here. This is lesson 9 recurring in its exact original form, three dozen waves later,
   which is the tell that it is a *structural* hazard and not a one-off: a finder that has
   correctly diagnosed a gap is at its most persuasive precisely when it hands you the
   plausible number to fill it with. → **Standing rule:** verify every quoted figure against
   the primary source before it enters the KB, and when it doesn't verify, write the
   uncertainty — a page that says "we don't know the exact time course, judge by how you're
   moving" is worth more than one that says a confident wrong number. (Same wave, same
   shape: two new registry entries failed schema validation on an invented `population`
   value — "athletes" is not in the enum. The gate caught what the author didn't.)

32. **Ask what an ambiguous signal was PRESCRIBED to be, not what it looks like in
   isolation.** Wave 171's effort lever graded every logged RIR against the hypertrophy band
   table, because the exercise's own metadata (isolation/compound/supported) looked like
   sufficient context. It isn't: the plan prescribes bands PER GOAL, and strength deliberately
   reserves more on accessories (`isolation "1-3"`). So a strength lifter logging a compliant
   RIR 2 curl was scored +1 over target — the plateau card told them to push closer to failure
   than their own plan card had asked for (lesson 10 at the coaching layer), and the auto-tune
   HELD the sets their stalled, compliant muscle had earned, which is precisely the
   "never withhold volume from a disciplined lifter" failure the Increment-C deferral claimed
   was honoured by construction. The tell was available and was misread: Wave 171's own
   comment said the classifier was "shared with plan-core's prescription, single source of
   truth" — true of the metadata tier it had just moved, and false of the goal-specific rows
   still sitting in a second table. → **Standing lens:** when code judges a user's input
   against a target, confirm the target is the one the app actually ASKED them for, through
   the same table that asked; a "single source of truth" comment describes the half that was
   unified, so grep for the other half. When the graded value is ambiguous (a logged set
   doesn't record which plan slot it filled), read the most LENIENT applicable target — for a
   lever that withholds, ambiguity must resolve toward doing nothing.

33. **A wave that CITES a lesson applies it exactly as far as the finding that prompted
   it — and writing the citation is what stops the search.** Wave 174 added a weigh-in
   guard, grepped `/api/bodyweight`, found two routes, wired both, and wrote *"both
   weigh-in doors apply one identical guard (lesson 1)"*. There were **three**:
   `POST /api/nutrition/profile` reaches `store.addBodyweight` from a route whose name
   says nothing about weight, and shipped unguarded for a wave with the exact
   uncorrectable-future-date hole the guard's own header documents. The comment's
   confidence came from the grep, and the grep was of the wrong noun. → **Standing
   rule:** grep the **SINK**, never the route or the caller — `addBodyweight` finds
   three doors where `/api/bodyweight` finds two. And when a fix's comment claims
   coverage ("both doors", "every call site", "single source of truth"), that claim
   must be backed by an *enumerable check in the same wave* — a shared helper every
   writer must route through, or a test that walks them — never by prose. This is
   lesson 32's shape sighted a second time in consecutive bursts, which makes it
   structural: **the moment you write the confident comment, you stop looking.**

34. **A fix's reach is bounded by the population of the field it reads — and no test
   can tell you, because the fixtures supply the field.** Wave 173's timezone work was
   correct code: the mesocycle clock counted the user's own calendar days and weeks,
   locked by tests at three layers. It reached almost nobody. `tz_offset_min` had
   exactly ONE writer — `POST /api/push/subscribe` — so every user who declined or
   never saw the notification prompt had `undefined`, every localizer silently fell
   back to UTC, and half the fix was inert. Every test passed because each fixture set
   the field by hand. → **Standing lens, the WRITER-side twin of lesson 15:** lesson 15
   asks "for every status a surface renders, who produces it?" — for a *stored* field
   the failure runs the other way: many readers, one narrow writer. So for every
   profile field a decision depends on, grep its **writers** and ask *what fraction of
   real users pass through that door*. Prefer capturing at a choke point every user
   already crosses (here: the one `api()` helper, as a request header) over the one
   door that happens to be nearby. A green test suite is evidence the logic is right,
   never evidence the data exists.

35. **"Absent from the metric" is not "measured as zero" — a gate that FILTERS an
   input can never report on it.** `program-templates.md` linked all five of its
   programs as `../../data/programs/*.json`; the renderer matches `.md` and silently
   returns the bare label, so the shipped bundle rendered a table of names with no
   prescription anywhere on the page. `check-links` could not have caught it: its
   canonical check iterates a `.md`-only regex, so a `.json` link is verified to
   **exist on disk** and never checked for **reachability** — green, while guaranteeing
   the reader can't follow it. Sixty-nine such links were invisible to both that gate
   and the depth report's out-degree. → **Standing rule:** when a gate narrows its
   input, that narrowing is itself a blind spot and must be **reported as a count**,
   not silently applied. Corollary from the fix: the rule for "will the app render this
   as a link?" existed in THREE copies (the graph's regex, the gate's, and the
   renderer's inline one) — which is precisely how the gate and the product were free
   to disagree for waves. One exported predicate, imported by all three.
   Second corollary, learned by writing it: the obvious "suspicious page" annotation
   (dropped > live) fires on the three pages that are entirely legitimate, so it was
   removed before shipping — **a flag that is usually wrong trains everyone to skip the
   line it sits on**, which is worse than no flag.

36. **When the owner reports a problem, measure all of it — the refuted parts are as
   load-bearing as the confirmed one.** `considerations.md` said the specialization
   question shouldn't be asked, that priority muscles don't change plan volume, and
   that ten questions barely change the plan. Measured: the question **was** a real
   Goal-2 violation (it asks a non-beginner to make a programming decision, and a
   lifter who could answer it wouldn't need the app) — but priority muscles move chest
   from 7 to 10 weekly sets, or 14 in a specialization block, and one changed answer
   can rewrite every rep range or two-thirds of the exercise list. Had I "fixed" the
   volume claim I'd have distorted a working engine to satisfy a complaint about
   something else. The *perception* was still real data: nothing in the app ever told
   the user what their answers changed, and **invisible personalization is
   indistinguishable from none** — it costs exactly the trust the questions were asked
   to earn. → **Standing rule:** measure every claim in a report separately before
   acting on any of it, record the refutations in the wave so a later audit doesn't
   re-raise them (lesson 13), and when a mechanism is right but unbelieved, the fix is
   to **show the mechanism**, not to change it.

37. **When you replace a QUESTION with a DERIVATION, the stored answers are mostly not
   answers — and the consumers don't follow the field automatically.** Wave 179 deleted
   the specialization question and derived the value from the KB's rule, keeping
   `if (profile.specialization != null) return !!profile.specialization` so nobody who
   had answered would have their plan rewritten. Humane, and it meant the derivation
   reached **nobody who already had an account**: the old client wrote
   `specialization: priority.length ? answers.specialization === true : false` — a hard
   boolean on BOTH branches — so every user who skipped the optional priority question
   and every beginner (the step's `showIf` hid it from them) had `false` stored *for*
   them by a question that was never rendered. The override was honouring silence as if
   it were consent, and the UI that could have changed it had been deleted in the same
   commit. Every test passed throughout, on fresh fixtures that had no stored field —
   lesson 34's exact shape, sighted one wave after lesson 34 was written, which makes it
   structural. Two halves: (a) **read the OLD client's write** to find which stored
   values were user input and which were client defaults, and only honour the ones a
   user could actually have caused (here: `true`, reachable only by an explicit tap);
   (b) **a field becoming derived is only the producer half** — `/api/today`'s
   volume-auto-tune freeze still read the raw `profile.specialization`, so for every
   account created after Wave 179 the freeze never engaged and the tune went on folding
   in the by-design "stalls" of muscles the block holds at maintenance. Grep every raw
   read of a field the moment it acquires a derivation, and give the answer one home.

38. **A threshold's UNIT must be the unit the rule it cites is written in — and your own
   data usually holds the falsification test.** `deriveSpecialization` cited the KB's
   "specialize one or two **areas** at a time" and counted muscle **ids**. The client's
   chips map to id arrays ("Back" = `["lats","upper-back"]`), so the threshold tracked
   the chip→id mapping rather than the rule: Back alone (1 area, 2 ids) specialized,
   Back + Arms (2 areas, 4 ids) did not. Counting ids is *defensible* as a recovery-budget
   proxy, so first-principles argument could have gone either way and lesson 13 says not
   to "fix" a tuned engine on a hunch. What settled it was the KB's own data: the shipped
   `specialization-delts-arms-4day` template — described there as a real 4–6 week block —
   is side-delts + biceps + triceps, **three ids across two areas**, and the engine
   refused to build its own template's shape. → When a threshold's correctness is
   arguable, **look for a worked example already in your data before arguing from first
   principles**; a contradiction between the engine and the KB's own artifacts is
   evidence, an opinion about physiology is not. (`data/muscles/*.json` already carried
   `group`, so the fix needed no new constant — lesson 1's "one source of truth".)

39. **The audit's NUMBERS are still hypotheses — including the ones two auditors agree a
   defect exists about.** Both finders this iteration independently found that the
   invisible-links gate duplicated only half the renderer's predicate. They reported the
   size of the gap as **36** and **23**. Measuring it directly gave **23** (69 reported
   vs 92 real). The diagnosis was right twice and one of the magnitudes was invented —
   lesson 31 recurring, now with the refinement that *agreement between finders is not
   corroboration of the number they disagree about*. Measure it yourself before it goes
   in a commit message or a doc. Meta, and the reason this class keeps recurring: that
   gate was written one wave earlier by an author who had *just* absorbed lesson 35 and
   wrote "the graph, the gate and the shipped HTML answer the question identically by
   construction" — a coverage claim in prose, over a predicate they had split in half.
   Lesson 33 again: the confident comment is written at the exact moment the search stops.

40. **An ORDINAL question asked with an EQUALITY test fires on skew in both
   directions.** "Has this week finished?" was written six times as
   `stored !== isoWeekKeyLocal(now, tz)`. That is true when the stamp is genuinely
   past — and equally true when the freshly-computed key reads *earlier* than the
   stamp, which is exactly what a change in the user's own tz offset looks like
   between the stamp and the read (first capture, DST, travel). Reproduced: a UTC-8
   user proposing at 18:00 their Sunday banks the UTC week, and the first read after
   their clock is known computes the previous local week — settling a **one-hour-old**
   challenge. The same `!==` also freed the challenge slot early (letting a new propose
   overwrite a live one), refused a legitimate accept, and suppressed the invite,
   accept and commitment pushes. → **Standing lens:** when a comparison's question is
   "has X passed / is X still current", write it ordinally, not as equality, and make
   the ambiguous direction the inert one — a branch that permanently ends something the
   user did not ask to end must not fire on a tie-break it cannot justify (lesson 32's
   "ambiguity resolves toward doing nothing", at the comparison operator). ISO week keys
   are zero-padded so string order *is* chronological order; the ordinal form was always
   available. Corollary learned in the same sweep: **not every instance of the pattern is
   the same defect** — `settledCh.week === isoWeekKeyLocal(now - 7d, tz)` is a deliberate
   one-week *window* ("the week that just ended"), and changing it would have broken it.
   It now carries a comment saying so, so the next sweep doesn't "fix" it (lesson 13).

41. **A fix that writes into a STORED artifact does not reach artifacts already
   stored.** Lesson 37's twin, one layer down. Wave 187 fixed the plan card by banking
   `compound_bands` at *generation* time — but `/api/plan/explain` reads the STORED
   rationale rather than regenerating, so every user whose plan predated the wave kept
   seeing the old wrong band until their next block boundary. The fix was correct and
   inert, and every test passed because fixtures are always generated fresh. Note this
   happened *inside the wave that wrote lesson 37*, which is the tell that "does this
   reach existing rows?" has to be a checklist question, not a thing you notice in
   hindsight. → **Standing lens:** for any fix that adds a field to a derived-and-stored
   artifact, ask what the READ path does when the field is absent, and whether the
   absence is silent. And when the old value genuinely cannot be reconstructed — here
   the light undulation band collides with the isolation band, and small splits never
   use all three, so any reconstruction would have been a guess — **say the part that is
   certainly true and invent no numbers**, rather than reaching for the precise-looking
   answer (lesson 31's shape, at the migration layer).

42. **A test written in terms of the constant it is testing cannot falsify that
   constant.** The specialization-expiry suite asserted
   `specializationActive(profile, muscles, SPEC_MAX_BLOCKS) === false` and friends —
   all of which stay green when `SPEC_MAX_BLOCKS` is changed to **9999**, i.e. when the
   feature is entirely disabled. Discovered by accident, not by design (a `grep -c`
   returning 0 exits non-zero and broke an `&&` chain mid-experiment — lesson 18 firing
   live while testing something else). → **Standing rule:** when a constant encodes a
   product decision, pin the VALUE with a literal in at least one assertion, and assert
   the behaviour at literal boundaries either side of it, so the test fails if the
   decision silently changes. The symbolic assertions are still worth keeping — they
   document intent — but they verify the plumbing, not the number.

43. **A metric that counts DIGITS cannot see an answer written in WORDS — know which
   blind spot you're looking at before you author.** Wave 195 genuinely quantified the
   overtraining page (the FOR/NFOR/OTS ladder, with the one duration the open-access
   literature verifiably states) and the depth report still scored it "0 numbers":
   its durations are "days" and "weeks to months" because the ECSS/ACSM consensus
   deliberately refuses digits, and `numericDensity` counts digits. Two wrong responses
   were available — pad the page with digits the sources don't state (fabricating
   precision, lesson 31), or teach the metric to count duration-words (chasing the
   metric with complexity). The right one was a RECORDED EXEMPTION whose justification
   states the mismatch: the page is quantified, the metric measures a proxy, and the
   proxy is wrong exactly here. Lesson 30's family: a metric you calibrate measures the
   corpus — and a page can be right while the proxy is wrong, provided the gate carries
   a place to say so. Related, same burst: an exemption list must FAIL on a stale entry
   (a page that no longer trips the floor), or the escape hatch quietly widens — the
   same one-way-door logic as lesson 25's flip rule, applied to the allowlist itself.

44. **When you verify citations by machine, key them by IDENTITY, not by name — the
   registry nearly gained the same paper twice.** Wave 195 added `bohm-2015-tendon-
   adaptation-meta` after dual-verifying it; the page it was written for turned out to
   already cite the same PMID as `bohm-2015-tendon` from an earlier wave. `npm run
   check` could not have caught it: both entries were real, verified, and referenced —
   just the same paper under two keys, which would silently split the graph's
   shared-citation coupling (the "neural network" weights) and overstate the registry
   count. Caught only because the authoring read the page before writing to it. →
   **Standing rule:** before adding a registry entry, grep the registry for the PMID
   and the DOI, not just the key you were about to mint; and a duplicate found late
   is resolved by MERGING onto the pre-existing key (the one content already
   references), moving the richer verification notes onto it, never by a second key.

45. **A shape migration's test suite is where the old shape survives — seed fixtures as
   REAL legacy rows, and keep some that way forever.** Migrating `profile.challenge`
   (scalar) → `profile.challenges` (array) broke 15 route tests, 3 push tests and 5
   adherence tests — and almost every failure was a FIXTURE writing or reading the
   legacy scalar, not the feature misbehaving. Two distinct values fell out of fixing
   them properly instead of mechanically: (a) fixtures that mutate stored state must go
   through the SAME normalization helper production writes use (a fixture writing the
   retired field is silently inert — the test passes while testing nothing); (b) a few
   fixtures should deliberately STAY in the legacy shape, because they are now the only
   tests proving an un-migrated D1 row still works — the push suite's scalar-seeded
   users are exactly that, and the route suite gained an explicit one (`#legacy`,
   seeded byte-for-byte as a pre-migration row, watermark mapping asserted). A
   migration with only migrated-shape tests has no evidence about the rows that
   actually exist in prod. Corollary: when a behaviour-change wave DELETES a
   limitation, the test that asserted the limitation flips into the test of the
   feature — "a third party can't challenge a busy opponent" became "a second partner
   CAN challenge an already-challenged opponent", same fixture, inverted assertion.

46. **A two-sided write needs a rollback for the second side's refusal.** Propose
   writes the challenger's slot, then the opponent's; the opponent's CAS mutator can
   refuse (their slots filled in the race window). Without rolling back the
   challenger's just-written half, the pair ends in a one-sided invite that later
   settles as a phantom decline — a fabricated "they said no" nobody said. The
   single-slot world never had this: its busy check was one global boolean read
   pre-write on both sides, so the second write could only clobber, not refuse.
   → **Standing lens:** when a logical operation writes N rows and any writer past the
   first can refuse inside its mutator, either the operation is idempotent-retryable
   or every earlier write needs an explicit compensating rollback — check which one
   you shipped, and test the refusal path from BOTH directions.

47. **A recompute/invalidate hook must key on what the derived value READS, not on
   what the request names.** Wave 201's celebration marker re-earned itself only when
   the EDITED session was the celebrated one — but `celebrationEvent` reads the user's
   whole history (a "PR" means *beats every prior session*), so correcting the
   fat-fingered typo in the PRIOR session that fabricated the PR left the pending
   praise armed, and voiding an older session left a stale "[3] sessions" milestone
   claim standing. The wave's own comment named the exact hazard ("the realistic edit
   is a fat-fingered weight wrongly celebrated as a PR") and guarded one of its two
   doors — lesson 33's confident-comment shape, at the invalidation layer. →
   **Standing lens:** for every stamped/cached derived value with an invalidation
   hook, list what the derivation READS (its true dependency set) and confirm the
   hook fires on writes to ALL of it. The tell is a guard comparing the request's id
   to the marker's id when the derivation never took that id as its only input.
   (Fixed Wave 203: the trigger is now "a pending unpushed marker exists", recomputing
   the celebrated session against corrected history; two route-door regression tests
   observed failing pre-fix.)

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
7w. **Telemetry (Waves 203–205, 2026-08-09).** Zero agents — fourth iteration
   running. The diff-scoped audit of Waves 201–202 (~230 production insertions) ran
   inline in one read: six candidates, five refuted against the code (the
   celebration streak math matches `weeksConsistent`'s real week-frame and field
   contracts; the comeback push IS hour-gated by the enclosing `isUserPushHour`
   continue; a vanished-row follow can't phantom-bump the owner; the
   `followers_pushed` stamp preconditions forward-only inside its mutator), one
   CONFIRMED and shipped as Wave 203 (lesson 47), deployed and prod-smoked. Wave
   204 then closed the repopulated Tier-1 #1 fully inline: the gate's measured
   first run (125 candidates, 61 flags) was read flag-by-flag in context — 22
   aliases, 16 justified generics, 1 tokenizer fix, ZERO real missing movements —
   and enforced same-wave with 12 unit tests. Two meta-moments worth keeping:
   (a) the first tamper test silently "passed" because the injected phrase landed
   BELOW the References heading, in the region `stripNonRendered` drops — a tamper
   must land inside the gate's measured region to prove anything; (b) a comment
   claiming "block is deliberately absent from the vocab" shipped with the entry
   still present for one run — the gate's own re-run caught the prose/enforcement
   gap the gate exists to catch, in its own source file. Owner input processed
   under the new considerations rule (implemented items get deleted from the
   file): consideration #1 verified implemented (Waves 179–184) and removed; the
   record lives in the roadmap and lessons 36–38.

7x. **Telemetry (Waves 201–202, 2026-08-07).** Zero agents again — third iteration
   running. The diff-scoped self-audit of Waves 198–200 (~475 insertions) ran
   inline in one read: five candidates raised and all five refuted against the
   code (the legacy-watermark → slot-boolean mapping preserves high-water
   semantics; the propose rollback's ghost-opponent edge self-heals through
   settle; the null-updateUser fallback matches pre-existing single-slot
   behavior; the respond tz-asymmetry predates the wave; the client's duplicated
   cap literal is cosmetic with the server enforcing) — zero fix waves shipped
   and none padded into existence. Wave 201 then closed Tier-1 #3 entirely
   inline: 43 new tests across three suites, the sweep suite observed FAILING
   against pre-feature push.mjs before commit, prod-smoked on real D1. With
   Tier 1 empty, the scheduled goal-distance re-audit ran (recorded in the
   roadmap): the buildable frontier has genuinely narrowed — one clean gate item
   repopulates Tier 1, and the binding constraints on all four goals are now
   mostly HUMAN inputs (demo media, the liability disclaimer, the analytics
   values call, elite ground truth, a real-device push check). That is lesson
   17's third branch — surface the human-blocked items — executed as written,
   not treated as an excuse to manufacture filler.

7y. **Telemetry (Waves 198–200, 2026-08-08).** Zero agents again — two feature waves
   (Tier-1 #2 end to end: backend + frontend) plus this LEARN wave, all inline. The
   self-audit of the prior burst found it clean in one read (it was 4 pages of content
   and a well-tested mechanism), so no Wave-fix shipped and none was padded into
   existence. The feature's correctness burden was carried by 23 new/updated tests and
   a real-browser walkthrough, not by reviewers: the browser run caught nothing the
   tests missed, which is the outcome you want and only get by writing the tests
   first. Prod-smoked on real D1 including a respond-by-id against two live
   concurrent slots.

7z. **Telemetry (Waves 194–197, 2026-08-07).** **ZERO agents of any kind** — the first
   iteration with no finder launch at all, applying 7a's own conclusion instead of
   re-learning it. Four waves shipped: the self-audit ran inline (one confirmed defect
   — a tautological assertion — plus one accepted behaviour and four refuted
   hypotheses, all from reading my own ~491-line diff); the 13 depth judgment calls
   were made by reading 13 short pages inline (rule 5: small text tasks never needed
   agents); the two new citations were dual-verified inline. Tier-1 #1 closed:
   authored 4 pages, exempted 10 with recorded justifications, FLIPPED the depth gate
   to enforcing with its floors untouched. The cost centre of this iteration was not
   tokens at all — it was the discipline of reading pages before judging them, which
   no fan-out can buy.

7a. **Telemetry (Waves 190–193, 2026-08-07).** Two finder agents launched; **BOTH died
   on session limits before returning a single candidate**, and the iteration shipped
   three waves anyway. Every finding came from inline work: the challenge week-key bug
   from writing a ten-line reproduction of a hypothesis the previous iteration had filed
   as unverified; the stored-rationale reach gap from reading `/api/plan/explain` and
   asking what it does when a new field is absent; the refutation of `boundLocalDate`
   from running it across the full ±14h range. Zero verify agents, zero workflows.
   **The lesson is not "agents are useless"** — it is that the finder's job is
   *pointing*, and when the surface is a ~600-line diff you wrote yourself, you already
   know where to point. Match the apparatus to the surface (rule 8): a self-review of
   one burst does not need an agent at all, and the loop should stop launching one out
   of habit. The two genuinely agent-shaped jobs remain broad un-audited surfaces and
   independent domain judgment.

7b. **Telemetry (Waves 186–189, 2026-08-06).** **2 finder agents, ZERO verify agents,
   zero workflows** — three shipping waves plus this one. The audit was a diff-scoped
   read of `8f488cf..HEAD` (Waves 178–185, ~950 insertions) through two read-only
   Explore finders run in parallel; one died mid-run on a session limit and its half was
   simply not re-run, because the surviving finder plus inline verification already
   produced more confirmed work than the iteration could ship. ~143k subagent tokens
   against the previous iteration's zero and the 472k before that. Every candidate was
   verified inline by the main loop — by reading the code, by running the real engine
   against the real KB, and by measuring the disputed link count directly — and every
   regression test was observed FAILING on pre-fix code before being committed
   (temporarily reverting each fix individually), which is cheaper than a verify agent
   and strictly better evidence. The one number both finders asserted and neither had
   measured was wrong (lesson 39). Rule 1 held; the finders' value was entirely in
   *pointing*, never in concluding.

8. **Telemetry (Waves 178–184, 2026-08-04).** **ZERO workflows, zero finder agents,
   zero verify agents** — six waves shipped. The audit was a diff-scoped lesson-3 read
   of the previous burst's own diff (`4e42595..HEAD`) through two read-only Explore
   agents, and every candidate was verified inline. The highest-severity finding of the
   iteration (an uncorrectable weigh-in door) came from re-reading a diff with no
   agents at all. Against the previous iteration's 472k and July's ~4.8M across six
   workflows. **The scaling rule that falls out:** a 10-commit range does not need a
   4-finder workflow; match the audit apparatus to the size of the un-audited surface,
   not to the ambition of the iteration.
9. **Telemetry (Waves 173–176, 2026-08-04).** One workflow, 4 finders, **472k subagent
   tokens** — against the July baseline of ~4.8M across six workflows. It returned 10 code
   candidates (7 confirmed, 2 rescoped, 1 refuted) and a KB-depth shortlist, all verified
   inline by the main loop in a handful of tool calls with **zero verify agents**, and all
   authoring done inline. Rules 1–5 held and the iteration shipped four waves. The finding
   that justifies the whole cadence: the highest-value defect of the burst (the effort lever
   grading strength lifters against the wrong band) came from the diff-scoped lens over
   genuinely un-audited new code — lesson 17's positive case, again.

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
