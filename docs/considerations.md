# Considerations - thoughts, ideas, suggestions and questions for consideration

Goal: to make note of my thoughts, ideas, suggestions and questions so that they can be taken into consideration for implementation.

Everything below should be taken under consideration for implementation. Once it has been thoroughly considered against the goals of the project, the recommended actions should be implemented.

1. you said the plan engine scores exercises, but is it thorough scoring ?
2. I see you've added a per-session quality cap but this should be the foundation, i want the plan to adjust based off the feedback the user inputs because some people react differently to different volumes and intensities. Some people might only need 6 sets, some might need 20. Some people train harder than others. I want the engine to use the knowledge base as a starting point and reference point but to learn and adapt based on the data it's fed.
---

## Responses (updated as items are actioned — newest first)

### 1. Program volume — you were right, and it was worse than it looked ✅ implemented
Measured before the fix: a **beginner got 20 direct hard sets/session (29 effective with
secondary credit); advanced up to 30 direct (41 effective)**. The engine's session budget was
purely time-based (`minutes / 3`), so a longer session simply meant more hard sets — no
quality ceiling existed anywhere.

Implemented: a **per-session quality cap that scales with training age — 12 (beginner) /
16 (intermediate) / 20 (advanced)** — applied on top of the time budget. Your "~12 hard sets"
observation matches both the KB's per-muscle 6–10 quality window and the frequency evidence
(volume spread across sessions preserves per-set quality), so the cap is now also documented
in `content/01-training-variables/frequency.md` with an honest Grade C label.

Two knock-on fixes this forced:
- **Priority muscles are now served first.** Under a scarcer budget, compounds were eating
  every set before isolation-fed muscles got a turn — a user prioritising side-delts got ONE
  direct set. Priority muscles now get their exercise placed before the general pass
  (12 sets/wk projected vs MEV 8, was 4).
- The **under-target warning was dead code** (a field-name mismatch, `target` vs
  `target_sets`) — with a tighter budget, honestly warning about shortfalls matters, so it's
  fixed and firing.

### 2. Lengthened-position emphasis — the engine did it invisibly; now it shows ✅ implemented
The plan engine has always *scored* lengthened-biased exercises higher when selecting (and
the KB covers the science in depth) — but nothing in the UI ever told you. Now:
- Exercises with a stretch bias carry a **"🎯 stretch-focused" tag** on the Today list, and
- the session player shows a cue: *"this move loads the muscle in its stretched position —
  where the growth signal is strongest… don't cut that part short."*

More for the intermediate/advanced audience (mesocycles, volume progression MEV→MRV,
reachable deloads, a settings screen to update your training status) is the core of the
current improvement-loop iteration — the audit confirmed it's the app's weakest dimension
and it's being built next.

### 3. Accounts ✅ reframed — and a question for you
The app already has an account system: the email backup **is** a passwordless account
(email-bound identity, magic-link sign-in, cross-device restore, merge-on-restore). It was
just presented so modestly ("back up your progress") that it didn't feel like one. The Me tab
now presents it as **"Your account / Create your account — one email, no password ever"**,
with a signed-in state.

**Question for you:** if what you miss is something specific — e.g. *sign out*, *switch
account on a shared device*, *see my data across devices*, or genuinely *a password* — tell
me which, and I'll build that. I deliberately did not add passwords: they'd add a credential
database, reset flows, and a whole attack surface for strictly less security than single-use
email links. If you disagree, say so and I'll reconsider properly.
