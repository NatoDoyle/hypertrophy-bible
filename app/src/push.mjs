import { isoWeekKey, weekDayKey } from "../../tools/derive-core.mjs";
import { encryptPushPayload } from "./push-encrypt.mjs";
import { settleChallenge, streakFreezeState } from "./adherence.mjs";

// Web Push reminders (#4 adherence) — the device-native sibling of the email
// comeback nudges. The daily/commitment reminder is EMPTY-payload by design:
// it needs no RFC 8291 payload encryption, only VAPID auth (RFC 8292) — a
// short-lived ES256 JWT signed with our P-256 keypair via crypto.subtle (zero
// dependencies, runs identically on Node and Workers) — and the service
// worker shows static copy, so no user data ever transits the push service
// for it. A discrete social event worth naming (e.g. a training-partner
// nudge) instead goes through `sendPush`, which DOES carry a small encrypted
// payload (RFC 8291 aes128gcm, push-encrypt.mjs) — still no user_id or
// anything not already public via a share token. Guardrails mirror the email
// nudges structurally either way: paused users and reminders_off are never
// pushed, and the reminder's window is bounded (a lapsed user stops getting
// daily pushes after ~3 weeks — the email path owns the long tail).

// Push endpoints only ever originate from a browser's push service. Restricting
// stored endpoints to these hosts stops a subscriber from registering an
// arbitrary URL and turning the daily server-side sweep into an SSRF / outbound-
// request cannon (the Worker POSTs to every stored endpoint once a day). Suffix
// match on the host, https only. Checked at subscribe AND at send (defense in
// depth for any row that predates the check).
// Suffixes are only used where the suffix is ITSELF push-specific. Google's
// push hosts live under the generic *.googleapis.com umbrella (which also covers
// storage./sheets./www.googleapis.com etc.), so those are matched as EXACT hosts
// — a `.googleapis.com` suffix would have admitted every Google API endpoint,
// defeating the SSRF containment this allowlist exists to provide.
const PUSH_HOST_SUFFIXES = [
  ".push.services.mozilla.com",   // Firefox
  ".notify.windows.com",          // Edge/Windows (WNS)
  ".push.apple.com",              // Safari (web/api.push.apple.com)
];
const PUSH_HOST_EXACT = new Set([
  "fcm.googleapis.com",           // Chrome/Android (FCM HTTP v1 + legacy)
  "android.googleapis.com",       // Chrome/Android (legacy GCM)
]);
export function isAllowedPushEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (PUSH_HOST_EXACT.has(host)) return true;
  return PUSH_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
}

const te = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uJson = (obj) => b64u(te.encode(JSON.stringify(obj)));

// RFC 8292 Authorization header. crypto.subtle's ECDSA signature is raw r||s
// (64 bytes) — exactly the JWS ES256 wire format, no DER conversion needed.
export async function buildVapidAuth(endpoint, { privateJwk, publicKeyB64u, subject = "mailto:hello@hypertrophybible.com", now = Date.now() }) {
  const aud = new URL(endpoint).origin;
  const signingInput = `${b64uJson({ typ: "JWT", alg: "ES256" })}.${b64uJson({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(signingInput));
  return `vapid t=${signingInput}.${b64u(sig)}, k=${publicKeyB64u}`;
}

export async function sendEmptyPush(subscription, vapid, fetchFn = fetch) {
  try {
    const res = await fetchFn(subscription.endpoint, {
      method: "POST",
      headers: { Authorization: await buildVapidAuth(subscription.endpoint, vapid), TTL: "86400", Urgency: "normal" },
    });
    // 404/410 = the browser dropped the subscription — the caller prunes it.
    return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch {
    return { ok: false, gone: false, status: 0 }; // network blip: keep the subscription, retry tomorrow
  }
}

// A CONTENT-BEARING push (RFC 8291 aes128gcm), for the rare event worth naming —
// unlike the daily reminder above, which is deliberately empty so no user data
// ever transits the push service. `payload` is a small plain object the SW turns
// straight into a notification ({ title, body, tag }); it never carries a user_id
// or anything a `hb-share`-style token wouldn't already make public. Requires the
// subscription's stored p256dh/auth (always present for a real browser
// subscription — see savePushSubscription); the caller checks for them.
export async function sendPush(subscription, vapid, payload, fetchFn = fetch) {
  try {
    const { body, headers } = await encryptPushPayload({
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      plaintext: JSON.stringify(payload),
    });
    const res = await fetchFn(subscription.endpoint, {
      method: "POST",
      headers: { Authorization: await buildVapidAuth(subscription.endpoint, vapid), TTL: "86400", Urgency: "normal", "Content-Type": "application/octet-stream", ...headers },
      body,
    });
    return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch {
    return { ok: false, gone: false, status: 0 }; // network/crypto blip: keep the subscription, retry next tick
  }
}

export const PUSH_MIN_LAPSE_DAYS = 2;   // don't nag someone who trained yesterday
export const PUSH_MAX_LAPSE_DAYS = 21;  // after ~3 weeks the daily push goes quiet (email owns the long tail)
export const PUSH_TARGET_LOCAL_HOUR = 17; // ~5pm local — late afternoon, actionable before evening training
export const PUSH_LEGACY_UTC_HOUR = 16;   // users with no stored timezone keep the old single 16:00-UTC slot

// The sweep now runs HOURLY (wrangler cron), so each user must be eligible in exactly
// ONE hour per day or an hourly sweep would push up to 24×. If we know the device's
// UTC offset (captured at subscribe), that hour is their local PUSH_TARGET_LOCAL_HOUR;
// otherwise they keep the legacy 16:00-UTC slot, so nothing changes for older installs.
// tzOffsetMin is minutes EAST of UTC (US Eastern = -300; UTC+12 = +720).
export function isUserPushHour(tzOffsetMin, now) {
  const utcHour = new Date(now).getUTCHours();
  if (!Number.isFinite(tzOffsetMin)) return utcHour === PUSH_LEGACY_UTC_HOUR;
  const localHour = new Date(+new Date(now) + tzOffsetMin * 60000).getUTCHours();
  return localHour === PUSH_TARGET_LOCAL_HOUR;
}

// Pure decision: should this subscriber get today's reminder push?
export function shouldPush({ lastSessionAt, subscribedAt, paused, remindersOff, now }) {
  if (paused || remindersOff) return false;
  if (!lastSessionAt) {
    // Never trained: one activation window — subscribed at least a day, at most the cap.
    if (!subscribedAt) return false;
    const days = Math.floor((+new Date(now) - +new Date(subscribedAt)) / 86400000);
    return days >= 1 && days <= PUSH_MAX_LAPSE_DAYS;
  }
  const days = Math.floor((+new Date(now) - +new Date(lastSessionAt)) / 86400000);
  return Number.isFinite(days) && days >= PUSH_MIN_LAPSE_DAYS && days <= PUSH_MAX_LAPSE_DAYS;
}

// A commitment reminder fires when TODAY is a day the user THEMSELVES said
// they'd train this week (`user.profile.commitment`, set via /api/commitment)
// and they haven't trained yet today — proactive and keyed to the user's own
// stated plan, unlike shouldPush's reactive "N days since last session" check
// (which also can't fire the day right after training, exactly when a same-day
// commitment reminder should). A commitment from a PRIOR iso week is stale and
// never fires — the user meant "this week", not forever.
export function shouldPushForCommitment({ commitment, lastSessionAt, now, paused, remindersOff }) {
  if (paused || remindersOff || !commitment?.days?.length) return false;
  if (commitment.week !== isoWeekKey(now)) return false;
  if (!commitment.days.includes(weekDayKey(now))) return false;
  if (!lastSessionAt) return true;
  return new Date(lastSessionAt).toISOString().slice(0, 10) !== new Date(now).toISOString().slice(0, 10);
}

// One daily sweep. Injectable sender/fetch so the whole thing unit-tests on the
// file store; dead subscriptions (404/410) are pruned as we go.
export async function runPushSweep(store, vapid, now = Date.now(), fetchFn = fetch) {
  const subs = await store.listPushSubscriptions();
  let checked = 0, sent = 0, pruned = 0;
  // Group subscriptions per USER first. The social seen-once markers
  // (nudge_pushed_at / challenge_pushed_at) are per-user, but sends are
  // per-subscription — evaluating the marker inside a flat per-subscription loop
  // meant the FIRST device whose push service said 201 stamped the marker and
  // every other device was silently skipped for good (worst case: a stale but
  // still-accepting endpoint consumed the event and the device the user actually
  // carries never heard about it). Social events now fan out to ALL of a user's
  // devices, then stamp ONCE — mirroring how the daily reminder already reaches
  // every subscription.
  const byUser = new Map();
  for (const sub of subs) { const l = byUser.get(sub.user_id) ?? []; l.push(sub); byUser.set(sub.user_id, l); }
  for (const [userId, userSubs] of byUser) {
    try {
      let user = await store.getUser(userId);
      if (!user) { for (const s of userSubs) { await store.deletePushSubscription(s.endpoint); pruned++; checked++; } continue; }
      checked += userSubs.length;
      const paused = !!user.paused;
      const remindersOff = user.profile?.reminders_off === true;
      const gone = new Set(); // endpoints pruned mid-user; later sends skip them
      // Send an encrypted payload to every capable device; returns how many the
      // push service ACCEPTED. One dead endpoint prunes and moves on; one thrown
      // send never blocks the user's other devices.
      const fanOut = async (payload) => {
        let ok = 0;
        for (const s of userSubs) {
          if (gone.has(s.endpoint) || !isAllowedPushEndpoint(s.endpoint) || !s.p256dh || !s.auth) continue;
          try {
            const res = await sendPush(s, vapid, payload, fetchFn);
            if (res.gone) { await store.deletePushSubscription(s.endpoint); gone.add(s.endpoint); pruned++; continue; }
            if (res.ok) { ok++; sent++; }
          } catch { /* one bad subscription never blocks the rest */ }
        }
        return ok;
      };
      // Stamp a seen-once marker AFTER at least one device accepted — with the
      // precondition INSIDE the mutator (store contract): a concurrent stamp that
      // already advanced the marker makes this a no-op instead of a rewind, and a
      // CAS write-conflict is swallowed so the failure mode is a possible repeat
      // push next tick (at-least-once), never a lost reminder/challenge below.
      const stamp = async (field, at) => {
        try {
          await store.updateUser(userId, (u) => {
            if ((u.profile?.[field] ?? 0) >= at) return u;
            u.profile = { ...(u.profile ?? {}), [field]: at };
            return u;
          });
        } catch { /* retried next sweep; the guard above makes the re-send idempotent per event */ }
      };
      // Same seen-once contract as `stamp`, but for a marker that is a WEEK KEY, not
      // a timestamp — the streak-freeze nudge below tracks `protectable_week`, which
      // can move BACKWARD (freezing the nearest miss can uncover an OLDER still-open
      // one). A forward-only `>=` guard would permanently block re-notifying about
      // that still-real, still-actionable gap, so this compares by equality instead.
      const stampIfChanged = async (field, value) => {
        try {
          await store.updateUser(userId, (u) => {
            if ((u.profile?.[field] ?? null) === value) return u;
            u.profile = { ...(u.profile ?? {}), [field]: value };
            return u;
          });
        } catch { /* retried next sweep; worst case one repeat push for the same value */ }
      };

      // A training-partner nudge (Wave 119) is a discrete social event, not a daily
      // cadence — push it on the NEXT hourly tick rather than waiting for the user's
      // one local reminder hour. `nudge_pushed_at` is separate from the in-app
      // `nudge_seen_at` (app.mjs /api/adherence): two surfaces, never gating each other.
      const pendingNudge = user.profile?.partner_nudge;
      if (!paused && !remindersOff && pendingNudge && pendingNudge.at > (user.profile?.nudge_pushed_at ?? 0)) {
        const ok = await fanOut({ title: "The Hypertrophy Bible", body: "Your training partner nudged you — jump back in.", tag: "hb-nudge" });
        if (ok) await stamp("nudge_pushed_at", pendingNudge.at);
      }

      // A challenge PROPOSAL (Wave 126): the OPPONENT hears on the next hourly tick —
      // a challenge only has until the end of ITS week to be answered. created_at
      // (stamped at propose) is the high-water mark against challenge_pushed_at.
      // Only the opponent's own still-PENDING, current-week invite pushes.
      const pendingChallenge = user.profile?.challenge;
      if (!paused && !remindersOff && pendingChallenge && pendingChallenge.role === "opponent" && pendingChallenge.status === "pending"
          && pendingChallenge.week === isoWeekKey(new Date(now).toISOString())
          && pendingChallenge.created_at > (user.profile?.challenge_pushed_at ?? 0)) {
        const ok = await fanOut({ title: "The Hypertrophy Bible", body: "Your training partner challenged you to a weekly race — respond before the week's up.", tag: "hb-challenge" });
        if (ok) await stamp("challenge_pushed_at", pendingChallenge.created_at);
      }

      // A challenge ACCEPT (Wave 137): the CHALLENGER hears the race is on —
      // completing the propose→accept event loop the invite push above started.
      // accepted_at (stamped on the challenger's copy at respond time) is the
      // high-water mark vs challenge_accept_pushed_at. Pre-137 active challenges
      // have no accepted_at and can never fire. Declines deliberately do NOT
      // push — the in-app card shows them, and a "they said no" notification
      // helps nobody train.
      if (!paused && !remindersOff && pendingChallenge && pendingChallenge.role === "challenger" && pendingChallenge.status === "active"
          && pendingChallenge.week === isoWeekKey(new Date(now).toISOString())
          && pendingChallenge.accepted_at > (user.profile?.challenge_accept_pushed_at ?? 0)) {
        const ok = await fanOut({ title: "The Hypertrophy Bible", body: "Challenge on — your partner accepted. Most sessions this week wins.", tag: "hb-challenge" });
        if (ok) await stamp("challenge_accept_pushed_at", pendingChallenge.accepted_at);
      }

      // A challenge RESULT (Waves 138/139): if the week ended and this user never
      // reopened the app, GET /api/challenge's self-transition never ran — settle
      // it here with the SAME shared logic (settleChallenge, never a second copy),
      // then push the result below off the PERSISTED fields.
      if (!paused && !remindersOff && pendingChallenge && pendingChallenge.status === "active"
          && pendingChallenge.week !== isoWeekKey(new Date(now).toISOString())) {
        await settleChallenge(store, userId, user, now);
        user = (await store.getUser(userId)) ?? user; // the push path reads the settled slot
      }
      // The result push itself (design adopted from PR #216): driven entirely off
      // persisted state — a COMPLETED challenge for the week that JUST ended, with
      // its recorded history entry and no result_pushed marker on the slot — so a
      // tick where every device send fails simply retries next tick from the same
      // stored fields (at-least-once), instead of losing the payoff moment. The
      // marker lives ON the slot (auto-scoped: the next propose replaces it), and
      // the just-ended-week guard keeps pre-existing old completed challenges from
      // ever firing retroactively. A vanished-opponent completion has no history
      // entry -> no push (never manufacture a trophy); declines stay silent.
      const settledCh = user.profile?.challenge;
      if (!paused && !remindersOff && settledCh && settledCh.status === "completed" && !settledCh.result_pushed
          && settledCh.week === isoWeekKey(new Date(now - 7 * 86400e3).toISOString())) {
        const entry = (user.profile?.challenge_history ?? []).find((h) => h.week === settledCh.week);
        if (entry) {
          const body = entry.result === "win"
            ? `🏆 You won this week's challenge ${entry.my_count}–${entry.opponent_count}!`
            : entry.result === "lose"
              ? `Challenge over — your partner took this week ${entry.opponent_count}–${entry.my_count}. Rematch?`
              : `Challenge over — dead heat at ${entry.my_count}–${entry.opponent_count}.`;
          const ok = await fanOut({ title: "The Hypertrophy Bible", body, tag: "hb-challenge" });
          if (ok) {
            try {
              await store.updateUser(userId, (u) => {
                if (u.profile?.challenge?.id !== settledCh.id) return u; // slot replaced — nothing to mark
                u.profile = { ...u.profile, challenge: { ...u.profile.challenge, result_pushed: true } };
                return u;
              });
            } catch { /* worst case: one repeat push next tick, never a lost result */ }
          }
        }
      }

      // Timezone-aware daily reminder: only in this user's one eligible hour/day.
      if (!isUserPushHour(user.profile?.tz_offset_min, now)) continue;

      // A protectable streak (#4 adherence, loss-aversion): a held freeze token can
      // retroactively save a missed week, but today that only ever surfaces if the
      // user reopens the Progress card — the same "you have to come back to find
      // out" gap the other proactive nudges above close. Piggybacked on the user's
      // ONE daily local-hour slot (not every hourly tick like the discrete social
      // events above), since streakFreezeState needs a full session-history read
      // that would be wasteful to run 24x/day for every subscriber. Fires once per
      // DISTINCT protectable week (`freeze_pushed_week`, via stampIfChanged).
      if (!paused && !remindersOff) {
        const sessions = await store.listSessions(userId);
        const freeze = streakFreezeState(sessions, now, user.streak_freezes || [], user.paused || null, user.pause_history || []);
        if (freeze.balance > 0 && freeze.protectable_week && freeze.protectable_week !== (user.profile?.freeze_pushed_week ?? null)) {
          const week = freeze.protectable_week;
          const ok = await fanOut({ title: "The Hypertrophy Bible", body: "You missed a week, but a streak freeze can still save it — protect it before it's gone.", tag: "hb-freeze" });
          if (ok) await stampIfChanged("freeze_pushed_week", week);
        }
      }

      const lastSessionAt = await store.latestSessionDate(userId);
      for (const sub of userSubs) {
        if (gone.has(sub.endpoint)) continue;
        // Two independent reasons to push, one send: lapse-reactive (shouldPush)
        // OR the user's own weekly commitment. subscribedAt is PER-SUBSCRIPTION
        // (a brand-new device shouldn't be nagged on day one), so this stays in
        // the per-subscription loop.
        const hit = shouldPush({ lastSessionAt, subscribedAt: sub.created_at ? new Date(sub.created_at).toISOString() : null, paused, remindersOff, now })
          || shouldPushForCommitment({ commitment: user.profile?.commitment ?? null, lastSessionAt, paused, remindersOff, now });
        if (!hit) continue;
        // Never POST to a non-push-service host, even if an old row slipped one in.
        if (!isAllowedPushEndpoint(sub.endpoint)) { await store.deletePushSubscription(sub.endpoint); pruned++; continue; }
        const res = await sendEmptyPush(sub, vapid, fetchFn);
        if (res.gone) { await store.deletePushSubscription(sub.endpoint); pruned++; continue; }
        if (res.ok) sent++;
      }
    } catch {
      // one bad user must never abort the sweep
    }
  }
  return { checked, sent, pruned };
}
