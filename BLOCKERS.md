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

### 1. Exercise demo media (the biggest remaining beginner gap)
**Why it's blocked:** every fix so far has been code. This one needs *content that legally
exists*. The app currently sends a novice to a **raw YouTube search** for "how do I do this?"
— unvetted, possibly bad-form, mid-workout, off-app. I can't fabricate demo footage and I
won't hotlink someone's video without a licence.

**What I need from you — pick ONE:**
- **(a) Licence a library.** Buy/subscribe to a stock exercise-animation set that permits
  redistribution in an app (e.g. a 3D-anatomy animation pack). Give me the asset files or an
  account and I'll wire all 88 exercises to them.
- **(b) Film them.** Even a phone on a tripod, 3–5s loops per movement. Give me a folder;
  I'll compress to WebP/GIF loops and bundle them offline.
- **(c) Curate links.** Give me a list of specific, vetted YouTube URLs (one per exercise)
  you're happy to endorse and I'll replace the blind search with those exact links. **Cheapest
  option, and a big improvement over today.**
- **(d) Tell me to drop it** and keep the honest "this is a search, pick a calm demo" framing.

### 2. Real beginner testers
**Why it's blocked:** I can audit the UI to death, but I cannot tell you whether a genuinely
nervous first-timer succeeds. I've been the only user. Everything I claim about
"zero cognitive load" is *inference*, not evidence.

**What I need:** 2–3 people who have never trained, given the URL and no explanation.
Watch them (or just ask afterwards): did they finish a workout? Where did they hesitate?
What word confused them? Send me the notes — that's the highest-value input available for
goal #3, and I can't generate it.

---

## 🟡 Unlocks something

### 3. Donations / Open Collective
**Blocked on:** you creating the account. `DONATE_URL` in `app/public/app.js` is `""`, so the
support button stays hidden by design (never a dead or fake donation link). The copy is
already written (`docs/donation-page.md`).
**What I need:** an Open Collective (or GitHub Sponsors) URL → I'll set it and the button appears.

### 4. Web-push reminders
**Blocked on:** a Worker secret. Calendar `.ics` export already ships as the fallback, but
scheduled reminders are the single biggest adherence lever in the KB.
**What I need:** run `npx wrangler secret put VAPID_PRIVATE_KEY` in `app/` — I'll generate the
keypair and give you the exact command, and write the push handler + quiet hours + self-tapering.
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

### 9. Cross-user learning — "form our own conclusions from our own data" (the algorithm's far vision)
**Why it's blocked (data scale + a values call, not code).** The adaptive algorithm now learns
*each individual* — their recovery, their energy state, their progression cadence — and tunes
their plan within the KB's evidence-based bounds (see `docs/adaptive-algorithm.md`, Increments A/B,
shipped). The next tier you described — aggregating across users to *refine the priors themselves*
(the volume landmarks, the response models) and form our own conclusions — needs two things I
can't conjure:
- **(a) Enough users, logging enough data.** A conclusion that revises a Grade-A landmark has to
  clear the same bar as the science it challenges — adequate n, confound control, held-out
  validation. Early, noisy data from a handful of users would *overfit*, and silently overriding
  published evidence is exactly the trap the KB's own "reading the evidence" stance forbids. This
  unblocks itself only as the userbase grows.
- **(b) Your values call on data aggregation.** Today there is deliberately **zero telemetry** (no
  ads, no data selling — see item 7). Cross-user learning means collecting and aggregating training
  data across people. That's a product/privacy decision only you can make: opt-in? anonymised/
  differential-privacy aggregates only? self-hosted? **Tell me the guardrails and I'll design the
  aggregation + the statistical rigor to match.**

Until both exist, the honest position holds: **the KB landmarks stay the priors; per-user signals
move each plan *within* the recoverable range, never outside it.** Nothing here blocks the current
loop — the per-user algorithm is live and improving.

---

## Done
_(nothing yet — I'll move items here as you tick them off)_
