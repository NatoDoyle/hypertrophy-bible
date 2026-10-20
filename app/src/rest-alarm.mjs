// Rest's up (W286, consideration #2): a notification the moment a rest ends, even with the
// phone locked. The cron's minutes are far too coarse for a 90-second rest, so one Durable
// Object per user holds that user's current rest end and pushes at that instant from its
// alarm, to the ONE device that's resting (W286 review: the account's every device got it).
// One rest at a time: arming again moves the alarm. Named by a hash of the user_id, and it
// never stores the id — that's the account's credential. A classic-API class (no
// `cloudflare:workers` import), so the tests run it under Node.
import { createD1Store } from "./store-d1.mjs";
import { sendPush, isAllowedPushEndpoint } from "./push.mjs";
import { sha256hex } from "./auth.mjs";

export const REST_ALERT_MAX_MS = 15 * 60e3; // past the player's longest rest (10 min), with room; further is refused
export const REST_ALERT_SKEW_MS = 5000;     // a device clock a few seconds behind still arms
export const REST_ALERT_STALE_MS = 60e3;    // an alarm that runs later than this (a retry) stays silent
const PUSH_OPTS = { ttl: 60, urgency: "high" }; // the push service drops it if it can't deliver within a minute

export function parseRestAlert(body, now) {
  const endsAt = typeof body?.ends_at === "number" ? body.ends_at : NaN;
  if (!Number.isFinite(endsAt) || endsAt < now - REST_ALERT_SKEW_MS || endsAt > now + REST_ALERT_MAX_MS) return null;
  const label = typeof body?.label === "string" ? body.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
  return { endsAt: Math.round(endsAt), label };
}
// What the phone shows. No user data beyond the lift's name: the payload is encrypted end to
// end (RFC 8291), and it never carries the user_id.
export function restAlertPayload(label) {
  return { title: "Rest's up", body: label ? `Next: ${label}` : "Time for your next set.", tag: "hb-rest" };
}

// The resting device. Gone (404/410) is pruned; a network failure or a push-service 5xx
// THROWS, so the platform retries the alarm (2 s, 4 s, …) while it still matters.
export async function sendRestAlert(store, vapid, sub, payload, fetchFn = fetch) {
  if (!vapid || !sub || !isAllowedPushEndpoint(sub.endpoint) || !sub.p256dh || !sub.auth) return { sent: 0 };
  const res = await sendPush(sub, vapid, payload, fetchFn, PUSH_OPTS);
  if (res.gone) { try { await store.deletePushSubscription(sub.endpoint); } catch {} return { sent: 0 }; }
  if (res.status === 0 || res.status >= 500) throw new Error(`rest alert not delivered (${res.status})`);
  if (res.ok) { try { await store.markPushDelivered(sub.endpoint, Date.now()); } catch { /* evidence is optional */ } }
  return { sent: res.ok ? 1 : 0 };
}

const vapidFrom = (env) => (env?.VAPID_PRIVATE_JWK && env?.VAPID_PUBLIC_KEY
  ? { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64u: env.VAPID_PUBLIC_KEY, subject: "mailto:hello@hypertrophybible.com" }
  : null);

export class RestAlarm {
  // The runtime constructs it with (state, env); `deps` exists for the tests. fetch stays
  // wrapped: the Workers fetch throws "Illegal invocation" when called as a method.
  constructor(state, env, { makeStore = createD1Store, fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
    this.state = state; this.env = env; this.makeStore = makeStore; this.fetchFn = fetchFn; this.now = now;
  }
  async fetch(request) {
    const b = await request.json().catch(() => ({}));
    const storage = this.state.storage;
    // Requests can arrive out of order (quick ±30 s taps; a hand-over disarm racing a re-arm
    // when the phone locks): the newest the device SENT wins (`at`, its clock), and an older
    // straggler changes nothing (W286 review).
    const at = Number.isFinite(b.at) ? b.at : 0;
    if (at && at < ((await storage.get("last_at")) ?? 0)) return Response.json({ stale: true });
    if (b.op === "disarm") {
      if (at) await storage.put("last_at", at);
      await storage.deleteAlarm(); await storage.delete("alert");
      return Response.json({ armed: false });
    }
    if (b.op !== "arm" || !Number.isFinite(b.ends_at) || !b.payload || typeof b.sub?.endpoint !== "string") return Response.json({ error: "bad-request" }, { status: 400 });
    if (at) await storage.put("last_at", at);
    await storage.put("alert", { ends_at: b.ends_at, payload: b.payload, sub: { endpoint: b.sub.endpoint, p256dh: b.sub.p256dh, auth: b.sub.auth } });
    await storage.setAlarm(b.ends_at);
    return Response.json({ armed: true });
  }
  async alarm() {
    const storage = this.state.storage;
    const alert = await storage.get("alert");
    if (!alert) return;
    const lateMs = this.now() - alert.ends_at;
    if (lateMs > REST_ALERT_STALE_MS) { await storage.delete("alert"); console.log("rest alarm", JSON.stringify({ stale: true, late_ms: lateMs })); return; }
    // A throw here keeps the alert, so the platform's retry can still deliver it (W286 review).
    const { sent } = await sendRestAlert(this.makeStore(this.env.DB), vapidFrom(this.env), alert.sub, alert.payload, this.fetchFn);
    // Spent — unless a new rest was armed while this one was sending.
    if ((await storage.get("alert"))?.ends_at === alert.ends_at) await storage.delete("alert");
    console.log("rest alarm", JSON.stringify({ sent, late_ms: lateMs })); // counts only — never the user
  }
}

// The worker's side (createApp's `restAlarm`): the user's own object, named by a hash of the
// user_id. An object that refuses is an error at the route (a 502 the client retries), never a
// silent "armed".
export function doRestAlarm(namespace) {
  const send = async (userId, body) => {
    const res = await namespace.get(namespace.idFromName(`rest:${await sha256hex(userId)}`)).fetch("https://rest-alarm/", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`rest alarm refused (${res.status})`);
  };
  return {
    arm: (userId, endsAt, payload, sub, at) => send(userId, { op: "arm", at, ends_at: endsAt, payload, sub }),
    disarm: (userId, at) => send(userId, { op: "disarm", at }),
  };
}
