import { isoWeekKey, weekDayKey } from "../../tools/derive-core.mjs";

// Web Push reminders (#4 adherence) — the device-native sibling of the email
// comeback nudges. EMPTY-payload design: an empty push needs no RFC 8291
// payload encryption, only VAPID auth (RFC 8292) — a short-lived ES256 JWT
// signed with our P-256 keypair via crypto.subtle (zero dependencies, runs
// identically on Node and Workers). The service worker shows a static
// notification and deep-links into the app, so no user data ever transits the
// push service. Guardrails mirror the email nudges structurally: paused users
// and reminders_off are never pushed, and the window is bounded (a lapsed user
// stops getting daily pushes after ~3 weeks — the email path owns the long tail).

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
  for (const sub of subs) {
    checked++;
    try {
      const user = await store.getUser(sub.user_id);
      if (!user) { await store.deletePushSubscription(sub.endpoint); pruned++; continue; }
      // Timezone-aware timing: only nudge in this user's one eligible hour/day, so an
      // hourly sweep never lands at 3am and never fires 24×. (Gate before any further
      // work — a user who isn't in their window this hour is simply skipped.)
      if (!isUserPushHour(user.profile?.tz_offset_min, now)) continue;
      const lastSessionAt = await store.latestSessionDate(sub.user_id);
      const paused = !!user.paused;
      const remindersOff = user.profile?.reminders_off === true;
      // Two independent reasons to push, one send: lapse-reactive (shouldPush)
      // OR the user's own weekly commitment (shouldPushForCommitment). The push
      // itself carries no payload either way (see the file header), so a single
      // boolean OR is correct — never a double send for the same day.
      const hit = shouldPush({ lastSessionAt, subscribedAt: sub.created_at ? new Date(sub.created_at).toISOString() : null, paused, remindersOff, now })
        || shouldPushForCommitment({ commitment: user.profile?.commitment ?? null, lastSessionAt, paused, remindersOff, now });
      if (!hit) continue;
      // Never POST to a non-push-service host, even if an old row slipped one in.
      if (!isAllowedPushEndpoint(sub.endpoint)) { await store.deletePushSubscription(sub.endpoint); pruned++; continue; }
      const res = await sendEmptyPush(sub, vapid, fetchFn);
      if (res.gone) { await store.deletePushSubscription(sub.endpoint); pruned++; continue; }
      if (res.ok) sent++;
    } catch {
      // one bad subscription/user must never abort the sweep
    }
  }
  return { checked, sent, pruned };
}
