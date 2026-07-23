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
      const hit = shouldPush({
        lastSessionAt: await store.latestSessionDate(sub.user_id),
        subscribedAt: sub.created_at ? new Date(sub.created_at).toISOString() : null,
        paused: !!user.paused,
        remindersOff: user.profile?.reminders_off === true,
        now,
      });
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
