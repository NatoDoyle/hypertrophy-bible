import { isoWeekKeyLocal, weekHasPassed, weekDayKey } from "../../tools/derive-core.mjs";
import { encryptPushPayload } from "./push-encrypt.mjs";
import { settleChallenge, streakFreezeState, challengeSlots, normalizeChallengeProfile } from "./adherence.mjs";

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

// BLOCKERS.md #4 promised "quiet hours" alongside the push handler itself; the
// daily/commitment reminder already gets one via isUserPushHour's single local
// slot, but the discrete social events (nudge/challenge/cheer/result) fire on
// the NEXT hourly tick by design, at ANY local hour — fine for "someone cheered
// you at 2pm", not fine for waking a subscriber at 3am, which risks the user
// revoking notification permission entirely (killing every future push, the
// opposite of Goal 4). This gate delays a social push to the sweep's next tick
// OUTSIDE the window — the underlying pending condition (nudge.at, challenge
// created_at/accepted_at, cheer count, settled-but-not-pushed result) is
// untouched, so nothing is lost, only deferred to a decent hour (at-least-once,
// same as every other guard in this sweep). Unknown timezone can't compute a
// local hour, so it is NOT restricted — the same "don't starve delivery over
// missing data" choice isUserPushHour makes for its own legacy slot.
export const SOCIAL_PUSH_QUIET_START_HOUR = 0; // local midnight...
export const SOCIAL_PUSH_QUIET_END_HOUR = 7;   // ...through 7am local (exclusive)
export function isSocialPushQuietHours(tzOffsetMin, now) {
  if (!Number.isFinite(tzOffsetMin)) return false;
  const localHour = new Date(+new Date(now) + tzOffsetMin * 60000).getUTCHours();
  return localHour >= SOCIAL_PUSH_QUIET_START_HOUR && localHour < SOCIAL_PUSH_QUIET_END_HOUR;
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
//
// isoWeekKey/weekDayKey read UTC calendar fields off whatever they're handed —
// correct for a bare local_date string, but `now` here is a raw UTC instant.
// tzOffsetMin (minutes EAST of UTC, same convention as isUserPushHour/
// isSocialPushQuietHours) localizes it first: without this, a west-of-UTC user
// whose local PUSH_TARGET_LOCAL_HOUR falls after UTC midnight (offset <= -420 —
// US Mountain/Pacific/Alaska/Hawaii) gets the NEXT calendar day's weekday here,
// so a commitment for "today" never matches at all (lesson 1/16: a scoping fix
// applied to this file's other tz-aware functions, but not this sibling call).
// Missing tz falls back to raw UTC, same "don't starve delivery over missing
// data" choice isUserPushHour makes for its own legacy slot.
export function shouldPushForCommitment({ commitment, lastSessionAt, now, paused, remindersOff, tzOffsetMin }) {
  if (paused || remindersOff || !commitment?.days?.length) return false;
  const offsetMs = Number.isFinite(tzOffsetMin) ? tzOffsetMin * 60000 : 0;
  const localNow = +new Date(now) + offsetMs;
  // Chronological, not merely different: an equality test also dropped the reminder
  // when the stored key read as the FUTURE relative to the freshly-computed one, which
  // is what a tz change (first capture, DST, travel) looks like between stamp and read.
  // For a Goal-4 reminder the user explicitly asked for, ambiguity resolves toward
  // delivering it, not toward silence.
  if (weekHasPassed(commitment.week, localNow, 0)) return false;
  if (!commitment.days.includes(weekDayKey(localNow))) return false;
  if (!lastSessionAt) return true;
  const localLast = +new Date(lastSessionAt) + offsetMs;
  return new Date(localLast).toISOString().slice(0, 10) !== new Date(localNow).toISOString().slice(0, 10);
}

// One daily sweep. Injectable sender/fetch so the whole thing unit-tests on the
// file store; dead subscriptions (404/410) are pruned as we go. `sendSocialEmail`
// is optional (omitted call sites keep today's push-only behavior) — when given,
// it's the email fallback for a user with NO live push subscription at all, for
// the discrete per-event notifications only (nudge/challenge/cheer/streak-freeze).
// The daily/commitment reminder stays push-only here; its own email equivalent is
// nudge.mjs's twice-per-lapse comeback sweep, run separately — this fallback must
// never duplicate that, so it only ever fires from the same event blocks that
// already gate on paused/reminders_off/seen-once markers.
export async function runPushSweep(store, vapid, now = Date.now(), fetchFn = fetch, sendSocialEmail = null) {
  const subs = await store.listPushSubscriptions();
  const byUser = new Map();
  for (const sub of subs) { const l = byUser.get(sub.user_id) ?? []; l.push(sub); byUser.set(sub.user_id, l); }
  // Email-bound accounts with ZERO push subscriptions join the sweep too (empty
  // device list), so the per-event blocks below still evaluate them and fall
  // back to email — otherwise a user who never granted push permission is
  // invisible to this whole sweep and hears about a challenge/nudge/cheer/streak-
  // freeze event only if they happen to reopen the app.
  const emailByUser = new Map();
  if (sendSocialEmail) {
    for (const a of await store.listAccountLastSessions()) {
      emailByUser.set(a.user_id, a.email);
      if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
    }
  }
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
  for (const [userId, userSubs] of byUser) {
    try {
      let user = await store.getUser(userId);
      if (!user) { for (const s of userSubs) { await store.deletePushSubscription(s.endpoint); pruned++; checked++; } continue; }
      const email = emailByUser.get(userId) ?? null;
      checked += userSubs.length || (email ? 1 : 0);
      const paused = !!user.paused;
      const remindersOff = user.profile?.reminders_off === true;
      const quietHours = isSocialPushQuietHours(user.profile?.tz_offset_min, now);
      const gone = new Set(); // endpoints pruned mid-user; later sends skip them
      // Send an encrypted payload to every capable device; returns how many the
      // push service ACCEPTED. One dead endpoint prunes and moves on; one thrown
      // send never blocks the user's other devices. A user with NO push devices
      // at all falls back to email (never a user who merely had a send fail this
      // tick — that case already retries via push next tick, so adding a second
      // channel there would risk a duplicate notification for no reliability gain).
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
        if (ok === 0 && userSubs.length === 0 && email && sendSocialEmail) {
          try {
            const res = await sendSocialEmail(email, { subject: payload.subject ?? payload.title, body: payload.body });
            if (res?.ok) { ok = 1; sent++; }
          } catch { /* one bad send never blocks the rest of the sweep */ }
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
      if (!paused && !remindersOff && !quietHours && pendingNudge && pendingNudge.at > (user.profile?.nudge_pushed_at ?? 0)) {
        const ok = await fanOut({ title: "The Hypertrophy Bible", subject: "Your training partner nudged you", body: "Your training partner nudged you — jump back in.", tag: "hb-nudge" });
        if (ok) await stamp("nudge_pushed_at", pendingNudge.at);
      }

      // Challenge INVITE + ACCEPT pushes (Waves 126/137, multi-slot since Wave 198):
      // iterate every slot. The pushed-markers live ON each slot as booleans
      // (invite_pushed / accept_pushed) — the per-USER scalar watermarks collided the
      // moment two invites could land in one sweep tick: a shared high-water mark
      // stamped by the first send made the second invite's created_at read as already
      // pushed, suppressing it forever (lesson 23, the exact failure the roadmap named
      // when it scoped this feature). challengeSlots maps the legacy scalars onto the
      // slot booleans for un-migrated rows, so nothing old re-fires and nothing
      // un-pushed is lost. Stamp only on >= 1 delivered send (all-failed retries next
      // tick), precondition inside the mutator so a raced slot replacement can't be
      // mis-stamped.
      const markSlot = async (slotId, key) => {
        try {
          await store.updateUser(userId, (u) => {
            const cur = challengeSlots(u.profile);
            if (!cur.some((ch) => ch.id === slotId)) return u; // slot replaced — nothing to mark
            u.profile = normalizeChallengeProfile(u.profile, cur.map((ch) => ch.id === slotId ? { ...ch, [key]: true } : ch));
            return u;
          });
        } catch { /* worst case: one repeat push next tick, never a lost event */ }
      };
      const slots = challengeSlots(user.profile);
      for (const ch of slots) {
        if (paused || remindersOff || quietHours) break;
        // The invite: only the opponent's own still-PENDING, still-current invite.
        if (ch.role === "opponent" && ch.status === "pending" && !ch.invite_pushed
            && !weekHasPassed(ch.week, now, user.profile?.tz_offset_min)) {
          const ok = await fanOut({ title: "The Hypertrophy Bible", subject: "You've been challenged to a weekly race", body: "Your training partner challenged you to a weekly race — respond before the week's up.", tag: "hb-challenge" });
          if (ok) await markSlot(ch.id, "invite_pushed");
        }
        // The accept: the CHALLENGER hears the race is on. accepted_at is stamped on
        // their copy at respond time; a pre-137 active slot has none and never fires.
        // Declines deliberately do NOT push.
        if (ch.role === "challenger" && ch.status === "active" && ch.accepted_at != null && !ch.accept_pushed
            && !weekHasPassed(ch.week, now, user.profile?.tz_offset_min)) {
          const ok = await fanOut({ title: "The Hypertrophy Bible", subject: "Challenge on — your race has started", body: "Challenge on — your partner accepted. Most sessions this week wins.", tag: "hb-challenge" });
          if (ok) await markSlot(ch.id, "accept_pushed");
        }
      }

      // A share-card CHEER (the last of Tier-3 #10's social events to reach push): unlike
      // nudge/challenge, a cheer has no single event instant to use as a high-water
      // mark — cheers accumulate as a running count on the share row (store.getShareCheers),
      // keyed by share_id, not by user. So the marker here is the COUNT itself
      // (cheers_pushed) rather than an `at` timestamp: `stamp`'s `>= at` guard works
      // identically for a monotonic count. Only users who opted into sharing (a live
      // share token exists) are ever looked up; most users have none and this is a
      // single cheap no-op lookup. Fires on the next hourly tick, same as nudge/challenge,
      // since a cheer is a discrete "someone did something nice for you" moment, not a
      // daily cadence.
      if (!paused && !remindersOff && !quietHours) {
        const shareId = await store.getShareIdForUser(userId);
        if (shareId) {
          const cheers = await store.getShareCheers(shareId);
          const pushedCount = user.profile?.cheers_pushed ?? 0;
          if (cheers > pushedCount) {
            const delta = cheers - pushedCount;
            const body = delta === 1
              ? "Someone cheered your progress on the Hypertrophy Bible — keep it up!"
              : `${delta} people cheered your progress on the Hypertrophy Bible — keep it up!`;
            const ok = await fanOut({ title: "The Hypertrophy Bible", subject: "Someone cheered your progress", body, tag: "hb-cheer" });
            if (ok) await stamp("cheers_pushed", cheers);
          }
        }
      }

      // Challenge RESULTS (Waves 138/139, multi-slot): if a week ended and this user
      // never reopened the app, GET /api/challenge's self-transition never ran —
      // settle here with the SAME shared logic (settleChallenge settles every needy
      // slot in one call, never a second copy), then push results off the PERSISTED
      // fields.
      if (!paused && !remindersOff && slots.some((ch) => ch.status === "active"
          && weekHasPassed(ch.week, now, user.profile?.tz_offset_min))) {
        await settleChallenge(store, userId, user, now);
        user = (await store.getUser(userId)) ?? user; // the push path reads the settled slots
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
      // NOTE: the guard below is a DELIBERATE exact match and must stay one. It asks
      // "is this the week that JUST ended" (a one-week window that stops old completed
      // challenges firing retroactively), not "has this week passed" — the two other
      // comparisons in this file were the same shape as the bug and this one is not.
      for (const settledCh of challengeSlots(user.profile)) {
        if (paused || remindersOff || quietHours) break;
        if (settledCh.status !== "completed" || settledCh.result_pushed) continue;
        if (settledCh.week !== isoWeekKeyLocal(now - 7 * 86400e3, user.profile?.tz_offset_min)) continue;
        // Entry lookup by challenge ID first (two challenges can now end in the SAME
        // week — a week-keyed lookup collides); legacy entries predate ids and fall
        // back to the week, safe because the single-slot world couldn't collide.
        const entry = (user.profile?.challenge_history ?? []).find((h) => h.id === settledCh.id)
          ?? (user.profile?.challenge_history ?? []).find((h) => h.id == null && h.week === settledCh.week);
        if (entry) {
          const body = entry.result === "win"
            ? `🏆 You won this week's challenge ${entry.my_count}–${entry.opponent_count}!`
            : entry.result === "lose"
              ? `Challenge over — your partner took this week ${entry.opponent_count}–${entry.my_count}. Rematch?`
              : `Challenge over — dead heat at ${entry.my_count}–${entry.opponent_count}.`;
          const ok = await fanOut({ title: "The Hypertrophy Bible", subject: "Your weekly challenge result is in", body, tag: "hb-challenge" });
          if (ok) await markSlot(settledCh.id, "result_pushed");
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
          const ok = await fanOut({ title: "The Hypertrophy Bible", subject: "Protect your streak before it's gone", body: "You missed a week, but a streak freeze can still save it — protect it before it's gone.", tag: "hb-freeze" });
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
          || shouldPushForCommitment({ commitment: user.profile?.commitment ?? null, lastSessionAt, paused, remindersOff, now, tzOffsetMin: user.profile?.tz_offset_min });
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
