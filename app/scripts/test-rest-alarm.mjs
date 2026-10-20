// Rest's up (W286, consideration #2): a notification the moment a rest ends, even with the
// phone locked. The Durable Object is the classic-API class, so it runs here on a fake
// storage; the push goes through the real RFC 8291 encryption to a fake push service and is
// decrypted back, to prove what the phone would show. No network, no wall clock.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import { parseRestAlert, restAlertPayload, RestAlarm, sendRestAlert, doRestAlarm, REST_ALERT_MAX_MS, REST_ALERT_STALE_MS } from "../src/rest-alarm.mjs";
import { decryptPushPayload, bytesToB64u } from "../src/push-encrypt.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name + (detail ? `\n      ${String(detail).slice(0, 300)}` : ""))); };
const NOW = 1_800_000_000_000;

// --- the request ---
ok("an end ninety seconds away arms", parseRestAlert({ ends_at: NOW + 90e3, label: "Bench press — set 2 of 3" }, NOW)?.endsAt === NOW + 90e3);
ok("an end in the past (beyond 5 s of clock skew), too far ahead, or not a number is refused",
  [NOW - 6000, NOW + REST_ALERT_MAX_MS + 1, "soon", null, undefined, NaN, Infinity].every((e) => parseRestAlert({ ends_at: e }, NOW) === null));
ok("…while a few seconds of skew still arms", parseRestAlert({ ends_at: NOW - 4000 }, NOW) !== null);
ok("the label is plain text on one line, at most 80 characters",
  parseRestAlert({ ends_at: NOW + 1000, label: "a\nb\u0000c" + "x".repeat(100) }, NOW).label === "a b c" + "x".repeat(75)
  && parseRestAlert({ ends_at: NOW + 1000, label: 42 }, NOW).label === "");
ok("the copy: what's next under a 'Rest's up' title, one tag so a newer alert replaces an older one",
  JSON.stringify(restAlertPayload("Squat — set 3 of 4")) === JSON.stringify({ title: "Rest's up", body: "Next: Squat — set 3 of 4", tag: "hb-rest" }));
ok("…and a plain line without a label", restAlertPayload("").body === "Time for your next set.");

// --- the Durable Object ---
function fakeState() {
  const data = new Map(); let alarm = null;
  return {
    storage: {
      get: async (k) => data.get(k), put: async (k, v) => { data.set(k, structuredClone(v)); }, delete: async (k) => data.delete(k),
      setAlarm: async (t) => { alarm = t; }, deleteAlarm: async () => { alarm = null; }, getAlarm: async () => alarm,
    },
    peek: () => ({ alarm, alert: data.get("alert") ?? null }),
  };
}
const call = (obj, body) => obj.fetch(new Request("https://rest-alarm/", { method: "POST", body: JSON.stringify(body) }));
async function fakeUa() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return { p256dh: bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))), privJwk: await crypto.subtle.exportKey("jwk", kp.privateKey), auth: bytesToB64u(crypto.getRandomValues(new Uint8Array(16))) };
}
const vkp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const env = { VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", vkp.privateKey)), VAPID_PUBLIC_KEY: b64u(await crypto.subtle.exportKey("raw", vkp.publicKey)) };

const path = join(tmpdir(), `hb-rest-alarm-test-${process.pid}.json`);
try {
  const store = createFileStore(path);
  const ua = await fakeUa();
  await store.saveUser("lifter", {}); await store.saveUser("other", {});
  const ep = (name) => `https://updates.push.services.mozilla.com/wpush/v2/${name}`;
  for (const [who, name] of [["lifter", "phone"], ["lifter", "tablet"], ["other", "theirs"]]) await store.savePushSubscription(who, { endpoint: ep(name), keys: { p256dh: ua.p256dh, auth: ua.auth } });
  let clock = NOW;
  const sends = [];
  let respond = () => ({ ok: true, status: 201 });
  const fetchFn = async (url, opts) => { sends.push({ url, headers: opts.headers, body: opts.body }); return respond(url); };
  const st = fakeState();
  const obj = new RestAlarm(st, env, { makeStore: () => store, fetchFn, now: () => clock });

  const payload = restAlertPayload("Bench press — set 2 of 3");
  let r = await (await call(obj, { op: "arm", user_id: "lifter", ends_at: NOW + 90e3, payload })).json();
  ok("arm: the alarm is set for the rest's end, with what to say", r.armed === true && st.peek().alarm === NOW + 90e3 && st.peek().alert?.user_id === "lifter");
  await call(obj, { op: "arm", user_id: "lifter", ends_at: NOW + 120e3, payload });
  ok("arming again (+30 s) MOVES the one alarm", st.peek().alarm === NOW + 120e3 && st.peek().alert.ends_at === NOW + 120e3);
  r = await (await call(obj, { op: "disarm" })).json();
  ok("disarm (\"I'm ready\", the next set banked, the workout over): no alarm, nothing kept", r.armed === false && st.peek().alarm === null && st.peek().alert === null);
  ok("a malformed request is refused and changes nothing", (await call(obj, { op: "arm", user_id: "lifter", ends_at: "soon" })).status === 400 && st.peek().alarm === null);

  await call(obj, { op: "arm", user_id: "lifter", ends_at: NOW + 90e3, payload });
  clock = NOW + 90e3 + 400;
  await obj.alarm();
  ok("the alarm fires one push to each of the lifter's devices — and no one else's",
    JSON.stringify(sends.map((s) => s.url.split("/").pop()).sort()) === JSON.stringify(["phone", "tablet"]), JSON.stringify(sends.map((s) => s.url)));
  const shown = JSON.parse(await decryptPushPayload({ body: sends[0].body, uaPrivateJwk: ua.privJwk, auth: ua.auth }));
  ok("…saying what's next", JSON.stringify(shown) === JSON.stringify(payload), JSON.stringify(shown));
  ok("…marked urgent and short-lived: a rest alert a minute late is noise, so the push service drops it",
    sends.every((s) => s.headers.Urgency === "high" && s.headers.TTL === "60"), JSON.stringify(sends[0].headers));
  ok("…and the alert is spent", st.peek().alert === null);

  sends.length = 0;
  await call(obj, { op: "arm", user_id: "lifter", ends_at: NOW + 200e3, payload });
  clock = NOW + 200e3 + REST_ALERT_STALE_MS + 1;
  await obj.alarm();
  ok("an alarm that runs long after the rest ended (a retry) stays silent", sends.length === 0 && st.peek().alert === null);
  await obj.alarm();
  ok("an alarm with nothing armed (disarmed just before it ran) stays silent", sends.length === 0);

  respond = (url) => (url.endsWith("/tablet") ? { ok: false, status: 410 } : { ok: true, status: 201 });
  const res = await sendRestAlert(store, { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64u: env.VAPID_PUBLIC_KEY }, "lifter", payload, fetchFn);
  ok("a device the push service says is gone (410) is pruned; the rest still get it",
    res.sent === 1 && !(await store.listPushSubscriptions()).some((s) => s.endpoint === ep("tablet")) && (await store.listPushSubscriptions()).some((s) => s.endpoint === ep("phone")));
  sends.length = 0;
  await sendRestAlert(store, null, "lifter", payload, fetchFn);
  ok("no VAPID keys: nothing sent, nothing thrown", sends.length === 0);

  // The worker's binder, through a namespace that hands out one object per name. Its stubs
  // behave like the runtime's: fetch(url, init) reaches the object as a Request.
  const objects = new Map();
  const ns = { idFromName: (name) => `id:${name}`, get: (id) => {
    if (!objects.has(id)) { const st = fakeState(); objects.set(id, { st, obj: new RestAlarm(st, env, { makeStore: () => store, fetchFn, now: () => clock }) }); }
    const { obj } = objects.get(id);
    return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
  } };
  const bound = doRestAlarm(ns);
  await bound.arm("lifter", NOW + 5000, payload);
  await bound.arm("other", NOW + 9000, payload);
  ok("the binder: each user's alarm lives in that user's own object", objects.get("id:lifter").st.peek().alarm === NOW + 5000 && objects.get("id:other").st.peek().alarm === NOW + 9000);
  await bound.disarm("lifter");
  ok("…and disarming one leaves the other's alone", objects.get("id:lifter").st.peek().alarm === null && objects.get("id:other").st.peek().alarm === NOW + 9000);
} finally { try { rmSync(path); } catch {} }

console.log(`\n${pass} rest-alarm test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
