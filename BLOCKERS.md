# Blockers — things only you can do

Work that's genuinely blocked on **you** (accounts, money, secrets, legal, licensing, real
humans). I add to this whenever the improvement loop hits something I can't do myself, and
I'll keep building around it in the meantime — nothing here stops the loop.

**How to use:** do them whenever you get a chance, tick the box, and tell me. I'll wire up
whatever it unblocks. If you'd rather I drop an item entirely, say so and I'll remove it and
the code that anticipates it.

Status key: 🔴 blocking real work · 🟡 unlocks something nice · ⚪ optional / someday

---

## 🔴 Blocking

### 1. Exercise demo media (real footage, not the v0 stand-in)
**Update:** the urgent half of this shipped in code — the app no longer sends anyone to a raw
YouTube search. `app/public/movement-demo.mjs` now renders a small inline line-art figure +
animated glyph for all 171 exercises (keyed off `movement_pattern`, zero new data authored),
wired into the set screen, the superset station, and the "How do I do this?" sheet; the old
YouTube link is gone from every one of those surfaces. **Why it's still open:** the v0 glyphs
are a generic stand-in (e.g. every squat-pattern lift gets the same "bend your knees" figure),
not real per-exercise form video — that still needs *content that legally exists*, which I
can't fabricate and won't hotlink without a licence.

**What I need from you — pick ONE:**
- **(a) Licence a library.** Buy/subscribe to a stock exercise-animation set that permits
  redistribution in an app (e.g. a 3D-anatomy animation pack). Give me the asset files or an
  account and I'll wire all 171 exercises to them as a fallback-preserving override (v0 stays
  the default where a clip is missing).
- **(b) Film them.** Even a phone on a tripod, 3–5s loops per movement. Give me a folder;
  I'll compress to WebP/GIF loops and bundle them offline.
- **(c) Curate links.** Give me a list of specific, vetted YouTube URLs (one per exercise)
  you're happy to endorse and I'll surface those exact links alongside the inline demo instead
  of a blind search. **Cheapest option.**
- **(d) Tell me to drop it** and keep the v0 line-art demo as the permanent answer.

_(Web-push VAPID secret — was #4 here — RESOLVED 2026-07-26; moved to Done below.)_

### 2. Citation-verification network access is down (blocks ALL Goal-1 KB work)
**What's happening:** every cloud-loop session's outbound HTTPS goes through a pre-configured
proxy. For at least the last **3+ days** (first hit 2026-07-26, still failing as of this wave,
2026-07-29), that proxy has been rejecting CONNECT tunnels to `eutils.ncbi.nlm.nih.gov` and
`api.crossref.org` with a flat `403` — confirmed directly this wave (`curl` to both hosts:
`CONNECT tunnel failed, response 403`) and via the proxy's own status endpoint
(`$HTTPS_PROXY/__agentproxy/status`), whose `recentRelayFailures` shows
`connect_rejected` / "policy denial or upstream failure" for both hosts specifically. This is not
a transient blip — at least 6 independent cloud-loop sessions across 3+ days have hit and logged
the identical failure (see `docs/roadmap.md`'s recent "Cloud loop" wave entries).
**Why it matters:** `CLAUDE.md`'s "never fabricate a citation" rule requires web-verifying every
new citation via PubMed E-utilities *and* Crossref before it can ship — with both blocked, the
loop cannot add a single new citation, update KB content that needs one, or run the overdue fresh
Goal-1 gap audit `docs/roadmap.md` has been flagging as ready since Tier 1/2 emptied. Every KB
build this loop could otherwise do is stalled behind this one proxy rule.
**What I need:** allow the proxy to reach `eutils.ncbi.nlm.nih.gov` and `api.crossref.org` (both
plain read-only REST APIs, no auth needed) — or tell me if there's a different verification path
you'd prefer the loop use instead.

### 3. Cloud-loop PR review/merge backlog (14 open, oldest 3+ days)
**What's happening:** the hourly cloud loop keeps shipping verified, tested waves as PRs (per its
instructions, it cannot merge or deploy itself), but none have been reviewed or merged since
**2026-07-26**. As of this wave there are **14 open "Cloud loop:" PRs** on
`natodoyle/hypertrophy-bible` (#228, #238–#251), each independently green on both test gates.
**Why it matters:** this is a review-capacity bottleneck, not a build-capacity one — the loop can
keep producing verified fixes indefinitely, but none of them reach production (and every merge
gets a little riskier the longer the queue grows, e.g. the recurring `sw.js` VERSION-bump
collision every wave hits). A swept-but-unmerged codebase doesn't move any of the four goals.
**What I need:** review and merge the backlog (oldest-first minimizes conflict pain), then
`git pull && cd app && npm run deploy` as its own step per `CLAUDE.md`. If some of the 14 turn out
to be redundant with each other after merging a few, closing the rest is fine — the loop will pick
up whatever real territory is left on the next iteration.

---

## 🟡 Unlocks something

### 3. Donations / Open Collective
**Blocked on:** you creating the account. `DONATE_URL` in `app/public/app.js` is `""`, so the
support button stays hidden by design (never a dead or fake donation link). The copy is
already written (`docs/donation-page.md`).
**What I need:** an Open Collective (or GitHub Sponsors) URL → I'll set it and the button appears.

### 5. Medical / liability review
**Blocked on:** a human who accepts the risk. The app tells people to lift heavy things and
now prescribes loads. There's safety content and injury contraindications, but **no disclaimer
or terms anywhere**, and I'm not qualified to sign off on liability.
**What I need:** either (a) confirm you accept the risk and I'll write a plain-English
"this isn't medical advice, stop if it hurts, see a professional" disclaimer + surface it at
onboarding, or (b) get it reviewed by someone qualified. Say the word and I'll draft (a) today.

### 6. Advanced/elite ground truth
**Why:** goal #2 now includes "people trying to win Mr. Olympia." The KB has the science, but
I have no access to how elite prep actually runs week-to-week.
**What I need (nice to have):** any contact with a competitive bodybuilder or coach willing to
sanity-check the advanced features (mesocycle/deload/specialisation logic) once I build them.
Without it I'll build strictly to what the literature supports and label the uncertainty.

### 6b. Merge/delete security-model decision *(a design call, not code I should make alone)*
**Why:** `/api/auth/merge` is the only route that permanently **deletes** a user (the anonymous
`from` row, after moving its data). Under the bare-UUID possession model, its auth (a `to`-bound
grant + the from-user being anonymous + an X-HB-User consistency check) does **not** stop an
attacker who already *knows* an anonymous victim's UUID — they can delete that anonymous row.
Reading/writing that user is already possible under the possession model; deletion is the only
added power. It's a narrow, accepted residual risk today (noted honestly in the code comment),
**not** a silent hole.
**What I need — your call on ONE:** (a) accept it as-is (bare-UUID model, low stakes: anonymous
accounts, no PII, recoverable by re-logging); (b) have me stop *deleting* the `from` row on merge
(keep it orphaned/tombstoned instead — cheap, removes the destructive primitive entirely); or
(c) move to a real per-device signed token so possession is non-forgeable (bigger change). I lean
(b) — say the word and I'll ship it.

---

## ⚪ Optional

### 7. Analytics
No telemetry exists (deliberate — no ads, no selling data). So I cannot see where users drop
off. A privacy-respecting, self-hosted counter (e.g. anonymous funnel counts, no PII) would
tell the loop what to fix next. **Needs your call** — it's a values decision, not a technical one.

### 8. Custom domain email replies
`hello@hypertrophybible.com` sends via Resend but nothing receives. If a confused beginner
replies to a magic-link email, it goes nowhere. Set up forwarding (Cloudflare Email Routing is
free) if you want to be reachable.


Until both exist, the honest position holds: **the KB landmarks stay the priors; per-user signals
move each plan *within* the recoverable range, never outside it.** Nothing here blocks the current
loop — the per-user algorithm is live and improving.

---

## Done

### 4. Web-push reminders — the VAPID secret IS set *(verified 2026-07-26)*
`npx wrangler secret list` on the prod Worker shows **both** `VAPID_PRIVATE_JWK` and
`RESEND_API_KEY` present. So `worker.mjs`'s `scheduled()` gate
(`env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC_KEY`) passes and the hourly `runPushSweep` **has been
running in production** — the ~15 waves of Goal-4 push code (daily/commitment reminder, PR &
streak-freeze nudges, partner nudge, challenge propose/accept/result, cheers, quiet hours) fire
for real; the earlier red-flag fear that it was silently inert is disproven. `VAPID_PUBLIC_KEY`
is the committed `[vars]` public half; the private JWK was set under the correct name (the wrong
`VAPID_PRIVATE_KEY` naming was only ever a doc typo, fixed Wave 155). Nothing left to unblock —
what remains is operational (real subscriber uptake, per-send delivery monitoring), not a
blocker. **Caveat that stands:** iOS PWA push requires "Add to Home Screen" before a device can
subscribe — a platform limit, not ours. (This also settles the *premise* behind PR #228's email
fallback: push is live, so that PR is now purely a product choice about whether to *also* email
push-less users, not a workaround for broken push.)
