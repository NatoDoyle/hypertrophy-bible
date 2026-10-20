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
  await store.saveUser("lifter", {});
  const ep = (name) => `https://updates.push.services.mozilla.com/wpush/v2/${name}`;
  for (const name of ["phone", "laptop"]) await store.savePushSubscription("lifter", { endpoint: ep(name), keys: { p256dh: ua.p256dh, auth: ua.auth } });
  const phone = { endpoint: ep("phone"), p256dh: ua.p256dh, auth: ua.auth };
  let clock = NOW;
  const sends = [];
  let respond = () => ({ ok: true, status: 201 });
  const fetchFn = async (url, opts) => { sends.push({ url, headers: opts.headers, body: opts.body }); const r = await respond(url); if (r instanceof Error) throw r; return r; };
  const st = fakeState();
  const obj = new RestAlarm(st, env, { makeStore: () => store, fetchFn, now: () => clock });

  const payload = restAlertPayload("Bench press — set 2 of 3");
  let r = await (await call(obj, { op: "arm", at: 1, ends_at: NOW + 90e3, payload, sub: phone })).json();
  ok("arm: the alarm is set for the rest's end, with what to say and the ONE device to say it to", r.armed === true && st.peek().alarm === NOW + 90e3 && st.peek().alert?.sub?.endpoint === ep("phone"));
  ok("…and the object never holds the user's id (it's their credential)", !JSON.stringify(st.peek().alert).includes("lifter"));
  await call(obj, { op: "arm", at: 2, ends_at: NOW + 120e3, payload, sub: phone });
  ok("arming again (+30 s) MOVES the one alarm", st.peek().alarm === NOW + 120e3 && st.peek().alert.ends_at === NOW + 120e3);
  await call(obj, { op: "arm", at: 1, ends_at: NOW + 60e3, payload, sub: phone });
  ok("W286 review: an OLDER arm arriving late (quick ±30 s taps race) changes nothing", st.peek().alarm === NOW + 120e3);
  r = await (await call(obj, { op: "disarm", at: 3 })).json();
  ok("disarm (\"I'm ready\", the next set banked, the workout over): no alarm, nothing kept", r.armed === false && st.peek().alarm === null && st.peek().alert === null);
  await call(obj, { op: "arm", at: 5, ends_at: NOW + 90e3, payload, sub: phone });
  await call(obj, { op: "disarm", at: 4 });
  ok("W286 review: an older disarm arriving after a newer arm (the hand-over racing a lock) leaves the arm", st.peek().alarm === NOW + 90e3);
  ok("a malformed request is refused and changes nothing", (await call(obj, { op: "arm", at: 6, ends_at: "soon", payload, sub: phone })).status === 400 && st.peek().alarm === NOW + 90e3);

  clock = NOW + 90e3 + 400;
  await obj.alarm();
  ok("the alarm pushes to the resting device ONLY — not every device on the account (W286 review)",
    JSON.stringify(sends.map((s) => s.url.split("/").pop())) === JSON.stringify(["phone"]), JSON.stringify(sends.map((s) => s.url)));
  const shown = JSON.parse(await decryptPushPayload({ body: sends[0].body, uaPrivateJwk: ua.privJwk, auth: ua.auth }));
  ok("…saying what's next", JSON.stringify(shown) === JSON.stringify(payload), JSON.stringify(shown));
  ok("…marked urgent and short-lived: a rest alert a minute late is noise, so the push service drops it",
    sends.every((s) => s.headers.Urgency === "high" && s.headers.TTL === "60"), JSON.stringify(sends[0].headers));
  ok("…and the alert is spent", st.peek().alert === null);

  sends.length = 0;
  await call(obj, { op: "arm", at: 7, ends_at: NOW + 200e3, payload, sub: phone });
  clock = NOW + 200e3 + REST_ALERT_STALE_MS + 1;
  await obj.alarm();
  ok("an alarm that runs long after the rest ended stays silent", sends.length === 0 && st.peek().alert === null);
  await obj.alarm();
  ok("an alarm with nothing armed (disarmed just before it ran) stays silent", sends.length === 0);

  // W286 review: a send that fails on the network THROWS, so the platform's retry (2 s, 4 s, …)
  // can deliver it — the alert is kept until it's sent.
  await call(obj, { op: "arm", at: 8, ends_at: NOW + 300e3, payload, sub: phone });
  clock = NOW + 300e3;
  respond = () => new Error("network");
  let threw = false;
  try { await obj.alarm(); } catch { threw = true; }
  ok("a network failure throws (the platform retries) and keeps the alert", threw && st.peek().alert?.ends_at === NOW + 300e3);
  respond = () => ({ ok: true, status: 201 }); sends.length = 0; clock = NOW + 302e3;
  await obj.alarm();
  ok("…and the retry delivers it", sends.length === 1 && st.peek().alert === null);
  // A new rest armed WHILE the last one's alert is sending must survive it.
  await call(obj, { op: "arm", at: 9, ends_at: NOW + 400e3, payload, sub: phone });
  clock = NOW + 400e3;
  // The next rest's arm COMPLETES while this alert is in flight (the push service still answering).
  respond = async () => { await call(obj, { op: "arm", at: 10, ends_at: NOW + 500e3, payload, sub: phone }); return { ok: true, status: 201 }; };
  await obj.alarm();
  ok("a rest armed while the last alert was sending keeps its alarm and its alert", st.peek().alert?.ends_at === NOW + 500e3 && st.peek().alarm === NOW + 500e3, JSON.stringify(st.peek()));
  respond = () => ({ ok: true, status: 201 });

  respond = (url) => (url.endsWith("/laptop") ? { ok: false, status: 410 } : { ok: true, status: 201 });
  const vapidKeys = { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64u: env.VAPID_PUBLIC_KEY };
  const gone = await sendRestAlert(store, vapidKeys, { endpoint: ep("laptop"), p256dh: ua.p256dh, auth: ua.auth }, payload, fetchFn);
  ok("a device the push service says is gone (410) is pruned", gone.sent === 0 && !(await store.listPushSubscriptions()).some((s) => s.endpoint === ep("laptop")) && (await store.listPushSubscriptions()).some((s) => s.endpoint === ep("phone")));
  sends.length = 0;
  await sendRestAlert(store, vapidKeys, { endpoint: "https://evil.example/collect", p256dh: ua.p256dh, auth: ua.auth }, payload, fetchFn);
  ok("W286 review: a non-push-service endpoint is never POSTed to", sends.length === 0);
  await sendRestAlert(store, null, phone, payload, fetchFn);
  ok("no VAPID keys: nothing sent, nothing thrown", sends.length === 0);

  // The worker's binder, through a namespace that hands out one object per name. Its stubs
  // behave like the runtime's: fetch(url, init) reaches the object as a Request.
  const objects = new Map();
  const ns = { idFromName: (name) => `id:${name}`, get: (id) => {
    if (!objects.has(id)) { const st2 = fakeState(); objects.set(id, { st: st2, obj: new RestAlarm(st2, env, { makeStore: () => store, fetchFn, now: () => clock }) }); }
    const { obj: o } = objects.get(id);
    return { fetch: (url, init) => o.fetch(new Request(url, init)) };
  } };
  const bound = doRestAlarm(ns);
  await bound.arm("lifter", NOW + 5000, payload, phone, 1);
  await bound.arm("other", NOW + 9000, payload, phone, 1);
  const names = [...objects.keys()];
  ok("the binder: each user's alarm lives in that user's own object", names.length === 2 && objects.get(names[0]).st.peek().alarm === NOW + 5000 && objects.get(names[1]).st.peek().alarm === NOW + 9000);
  ok("W286 review: …named by a hash of the user_id, never the credential itself", names.every((n) => !n.includes("lifter") && !n.includes("other") && /^id:rest:[0-9a-f]{64}$/.test(n)), JSON.stringify(names));
  await bound.disarm("lifter", 2);
  ok("…and disarming one leaves the other's alone", objects.get(names[0]).st.peek().alarm === null && objects.get(names[1]).st.peek().alarm === NOW + 9000);
  let refused = false;
  try { await bound.arm("lifter", NOW + 5000, payload, null, 3); } catch { refused = true; }
  ok("W286 review: an object that refuses (400) is an error at the route, not a silent 'armed'", refused);
} finally { try { rmSync(path); } catch {} }

console.log(`\n${pass} rest-alarm test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
