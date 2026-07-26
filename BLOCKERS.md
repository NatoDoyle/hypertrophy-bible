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


---

## 🟡 Unlocks something

### 3. Donations / Open Collective
**Blocked on:** you creating the account. `DONATE_URL` in `app/public/app.js` is `""`, so the
support button stays hidden by design (never a dead or fake donation link). The copy is
already written (`docs/donation-page.md`).
**What I need:** an Open Collective (or GitHub Sponsors) URL → I'll set it and the button appears.

### 4. Web-push reminders
**Update:** the code side is done, not pending — `app/src/push.mjs` already implements the
send/encrypt/sweep/quiet-hours logic (daily reminder, commitment nudge, PR/streak-freeze
nudges, and every social event: partner nudge, challenge propose/accept/result, cheers), all
unit- and route-tested. `VAPID_PUBLIC_KEY` is already committed as a plain `[vars]` entry in
`app/wrangler.toml` (safe to publish — it's the public half). **Blocked on:** one Worker
secret only — `npx wrangler secret put VAPID_PRIVATE_JWK` in `app/`, pasting the private JWK
paired to that committed public key. **This corrects an error in a prior version of this
file**, which named the secret `VAPID_PRIVATE_KEY` — that name doesn't match anything the code
reads (`worker.mjs`'s cron gate checks `env.VAPID_PRIVATE_JWK`), so running that exact command
would silently leave the entire push sweep a no-op. **What I need:** confirm whether
`VAPID_PRIVATE_JWK` was ever actually set (`npx wrangler secret list` in `app/` from an authed
session) — if it wasn't (or was set under the wrong name), several waves of push-based
adherence work may have shipped fully tested but never actually fired in production. If you
don't have the matching private JWK anymore, tell me and I'll generate a fresh P-256 keypair,
give you the exact `wrangler secret put` command with the new value, and update the committed
public key to match.
**Caveat:** iOS PWA push requires the user to "Add to Home Screen" first — real but limited.

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
_(nothing yet — I'll move items here as you tick them off)_
