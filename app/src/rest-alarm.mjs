// Rest's up (W286, consideration #2): a notification the moment a rest ends, even with the
// phone locked. The cron's minutes are far too coarse for a 90-second rest, so one Durable
// Object per user (addressed by idFromName(user_id)) holds that user's current rest end and
// pushes at that instant from its alarm. One rest at a time: arming again moves the alarm.
// A classic-API class (no `cloudflare:workers` import), so the tests run it under Node.
import { createD1Store } from "./store-d1.mjs";
import { sendPush, isAllowedPushEndpoint } from "./push.mjs";

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

// Every one of the user's devices; a device the push service says is gone is pruned.
export async function sendRestAlert(store, vapid, userId, payload, fetchFn = fetch) {
  if (!vapid) return { sent: 0 };
  let sent = 0;
  for (const s of await store.listUserPushSubscriptions(userId)) {
    if (!isAllowedPushEndpoint(s.endpoint) || !s.p256dh || !s.auth) continue;
    const res = await sendPush(s, vapid, payload, fetchFn, PUSH_OPTS);
    if (res.gone) { try { await store.deletePushSubscription(s.endpoint); } catch {} continue; }
    if (res.ok) { sent++; try { await store.markPushDelivered(s.endpoint, Date.now()); } catch { /* evidence is optional */ } }
  }
  return { sent };
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
    if (b.op === "disarm") { await storage.deleteAlarm(); await storage.delete("alert"); return Response.json({ armed: false }); }
    if (b.op !== "arm" || typeof b.user_id !== "string" || !Number.isFinite(b.ends_at) || !b.payload) return Response.json({ error: "bad-request" }, { status: 400 });
    await storage.put("alert", { user_id: b.user_id, ends_at: b.ends_at, payload: b.payload });
    await storage.setAlarm(b.ends_at);
    return Response.json({ armed: true });
  }
  async alarm() {
    const storage = this.state.storage;
    const alert = await storage.get("alert");
    if (!alert) return;
    await storage.delete("alert");
    const lateMs = this.now() - alert.ends_at;
    if (lateMs > REST_ALERT_STALE_MS) { console.log("rest alarm", JSON.stringify({ stale: true, late_ms: lateMs })); return; }
    const { sent } = await sendRestAlert(this.makeStore(this.env.DB), vapidFrom(this.env), alert.user_id, alert.payload, this.fetchFn);
    console.log("rest alarm", JSON.stringify({ sent, late_ms: lateMs })); // counts only — never the user
  }
}

// The worker's side (createApp's `restAlarm`): the user's own object, by name.
export function doRestAlarm(namespace) {
  const send = (userId, body) => namespace.get(namespace.idFromName(userId)).fetch("https://rest-alarm/", { method: "POST", body: JSON.stringify(body) });
  return {
    arm: async (userId, endsAt, payload) => { await send(userId, { op: "arm", user_id: userId, ends_at: endsAt, payload }); },
    disarm: async (userId) => { await send(userId, { op: "disarm" }); },
  };
}
