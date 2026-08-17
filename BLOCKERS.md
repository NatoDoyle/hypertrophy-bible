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

---

## 🟡 Unlocks something

### 2b. Subscribe to push on a real device — prod has ZERO subscribers *(5 minutes, sharpened 2026-08-14)*
**Why — and this is the burst's key finding:** the stats endpoint's first live reading
(Wave 210) showed **`push_subscriptions: 0`** — in the entire life of the app, no real
device has ever granted push permission. ~15 waves of push machinery (reminders,
commitment nudges, challenge events, cheers, celebration echo, comeback — all tested,
VAPID and RFC 8291 verified against published vectors) currently reach **nobody** on
the push channel; only the email fallback carries events. The old ask ("verify a push
arrives") was unverifiable for a simpler reason than the last-hop problem: there was
never a subscription to deliver to.
**What changed in code:** the sweep now records every live push-service acceptance
(2xx) automatically, and `/api/stats` reports `push_subscriptions` and
`push_delivered_7d` — so once one real device subscribes, the server half verifies
itself within a day, no vigil needed.
**What I need (5 min):** open https://hypertrophybible.com on your phone — **on
iPhone: Share → Add to Home Screen first** (iOS only allows push for installed
PWAs), then open it from the home screen — and allow notifications when the app
offers. Then just live your life; the stats numbers flip on their own, and the only
thing left for a human to confirm is that the notification actually *displays*.
Tell me if it doesn't.

### 3. Donations / Open Collective
**Blocked on:** you creating the account. `DONATE_URL` in `app/public/app.js` is `""`, so the
support button stays hidden by design (never a dead or fake donation link). The copy is
already written (`docs/donation-page.md`).
**What I need:** an Open Collective (or GitHub Sponsors) URL → I'll set it and the button appears.

### 6. Advanced/elite ground truth
**Why:** goal #2 now includes "people trying to win Mr. Olympia." The KB has the science, but
I have no access to how elite prep actually runs week-to-week.
**What I need (nice to have):** any contact with a competitive bodybuilder or coach willing to
sanity-check the advanced features (mesocycle/deload/specialisation logic) once I build them.
Without it I'll build strictly to what the literature supports and label the uncertainty.


---

## ⚪ Optional

### 8. Custom domain email replies *(app half done 2026-08-14 — routing still yours, optional)*
`hello@hypertrophybible.com` sends via Resend but nothing receives. **The honest half
shipped (Wave 211):** every email footer now says plainly "Replies to this address aren't
read — this mailbox only sends", so nobody replies into a void believing they reached a
human. If you ever want to actually BE reachable, set up forwarding (Cloudflare Email
Routing is free) and I'll remove that line.

### 9. Cloud-loop sandbox can't verify citations (environment, not the web)
**Why:** the cloud/autonomous sessions' egress proxy denies CONNECT to
`eutils.ncbi.nlm.nih.gov` and `api.crossref.org` (`connect_rejected` policy denial, confirmed
across many cloud sessions in late July 2026). **Both endpoints verified working (HTTP 200) from
the local environment on 2026-08-03** — so this is a sandbox proxy allowlist issue, not an
outage. Effect: cloud iterations can't add or verify KB citations (correctly refusing to
fabricate per the guardrail) and keep re-reporting the "outage". **What I need:** if you control
the cloud environment's network policy, allowlist those two hosts; otherwise KB-citation work
simply stays local-session-only (which is how it's being handled now — no loop work is blocked).


Until both exist, the honest position holds: **the KB landmarks stay the priors; per-user signals
move each plan *within* the recoverable range, never outside it.** Nothing here blocks the current
loop — the per-user algorithm is live and improving.

---

## Done

### 5. Medical / liability disclaimer — SHIPPED *(Wave 209, 2026-08-14)*
Under your blanket go-ahead ("attack all the blockers, do what you think is best"), option
(a) shipped: the welcome screen carries "By starting you agree this is training guidance,
not medical advice — the honest details" (one muted line, no checkbox), linking the full
plain-English Health & safety note (coach-not-a-doctor, see-a-professional-first cases,
pain is a stop sign, lift at your own risk, injury guidance is a comfort feature, Fuel
targets are estimates for healthy adults). Always reachable from the Me tab. Acceptance is
stamped server-side at onboard (`profile.disclaimer_ack`) and follows the user through
merges. If you'd still like a qualified human review (the old option b), that stands as a
worthwhile extra — but the app is no longer disclaimer-less.

### 7. Analytics — the stats endpoint SHIPPED *(Wave 210, 2026-08-14)*
Exactly the zero-new-collection proposal: secret-gated `GET /api/stats`, aggregates only
(users, actives, week-over-week retention, sessions, push subscriptions + deliveries),
computed from rows D1 already stored, no per-user view, no PII, nothing added to the
client. Usage: `curl -H "X-HB-Stats-Key: <key>" https://hypertrophybible.com/api/stats` —
the key was handed to you in the 2026-08-14 session summary (deliberately NOT in this
repo); rotate it any time with `cd app && npx wrangler secret put STATS_KEY`. **First live
reading (2026-08-14):** 135 user rows · 13 ever logged a session · 1 active in the last
7 days · **0 push subscriptions** (see #2b above — that zero is the reading that matters).
If you'd rather this endpoint not exist after all, say so and I'll remove it and the
STATS_KEY secret.

### 6b. Merge/delete security model — option (b) SHIPPED; safe archive/restore extension implemented locally *(Wave 211; local Waves 213–216, 2026-08-17)*
The recorded lean, executed under the same go-ahead: `/api/auth/merge` no longer deletes
the from-row — it tombstones it (`_merged_into` audit marker), and every reader treats a
tombstone as absent, so route behavior is byte-identical. The app now has **no destructive
primitive at all**: nothing any caller can do permanently destroys a user row. Option (c)
(non-forgeable per-device tokens) remains a possible future hardening, not urgent.

The local follow-up closes the recoverability gap a tombstone alone leaves: before a merge,
the source account's full data graph is snapshotted into an owner-scoped archive; the Me tab
can show only safe archive summaries and, after confirmation, restore a separate account copy.
That copy deliberately starts capability-free — no revived push subscription, share, or social
state — while leaving the surviving account untouched. Route and store-parity coverage has run
locally. This extension is not yet deployed or represented as a PR.

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
