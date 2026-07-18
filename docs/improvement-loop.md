# The improvement loop

A closed loop that keeps driving the project toward three goals, and keeps itself honest.

## The four goals (the only scoring function)

1. **The world's best source of knowledge for hypertrophy.** Every claim web-verified, graded,
   and honest about uncertainty.
2. **The world's best coaching app built on that KB — for everyone.** From "I have never heard
   of a gym" to "I am trying to win Mr. Olympia." Both ends, not just one.
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

## Guardrails (never traded away for a metric)

- **Never fabricate a citation.** PubMed + Crossref verified, or it doesn't ship
  (`citations/registry.json`). Absence of evidence is stated, not filled in.
- **Never shame the user.** Gamification never pressures training through injury or illness;
  the pause is penalty-free and the streak is forgiving.
- **Never claim more certainty than exists.** Grades are honest; extrapolations are labelled.
- **Never lose logged data.** Offline-first, idempotent writes, crash-safe sessions.

## State

- **Blocked on the human:** `BLOCKERS.md` (I add to it; the loop never waits on it).
- **Live:** https://hypertrophybible.com · repo: github.com/NatoDoyle/hypertrophy-bible
- **History:** each iteration ships as PR'd waves; see git log.
