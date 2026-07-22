// Web Push tests: the VAPID JWT is verified END-TO-END with WebCrypto (sign
// here, verify against the public key — not just shape-checked), the sweep runs
// against the real file store with an injected fetch, and dead subscriptions
// are pruned. No network, no Date.now in assertions.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import { buildVapidAuth, sendEmptyPush, shouldPush, runPushSweep, PUSH_MIN_LAPSE_DAYS, PUSH_MAX_LAPSE_DAYS } from "../src/push.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)); };

const NOW = +new Date("2026-07-10T16:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

// --- a real throwaway keypair for the crypto round-trip ---
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const vapid = { privateJwk, publicKeyB64u: b64u(rawPub), subject: "mailto:test@t.com" };

// --- VAPID JWT: structure + a real signature verification ---
{
  const auth = await buildVapidAuth("https://fcm.googleapis.com/fcm/send/abc123", { ...vapid, now: NOW });
  ok("auth header carries vapid t= and k=", /^vapid t=.+, k=.+$/.test(auth));
  const jwt = auth.match(/t=([^,]+),/)[1];
  const [h, c, s] = jwt.split(".");
  const header = JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/")));
  const claims = JSON.parse(atob(c.replace(/-/g, "+").replace(/_/g, "/")));
  ok("JWT header is ES256", header.alg === "ES256" && header.typ === "JWT");
  ok("aud is the push service ORIGIN only", claims.aud === "https://fcm.googleapis.com");
  ok("exp is ~12h out and sub is the contact", claims.exp === Math.floor(NOW / 1000) + 12 * 3600 && claims.sub === "mailto:test@t.com");
  ok("signature is raw r||s (64 bytes, the JWS ES256 wire format)", unb64u(s).length === 64);
  const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, unb64u(s), new TextEncoder().encode(`${h}.${c}`));
  ok("signature VERIFIES against the public key (full crypto round-trip)", verified === true);
}

// --- sendEmptyPush: headers + dead-subscription detection ---
{
  let seen = null;
  const okFetch = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 201 }; };
  const r1 = await sendEmptyPush({ endpoint: "https://push.example.com/x" }, vapid, okFetch);
  ok("push POSTs the endpoint with TTL and Authorization, no body", r1.ok && seen.opts.method === "POST" && seen.opts.headers.TTL === "86400" && /^vapid /.test(seen.opts.headers.Authorization) && !("body" in seen.opts));
  const r410 = await sendEmptyPush({ endpoint: "https://push.example.com/x" }, vapid, async () => ({ ok: false, status: 410 }));
  ok("410 marks the subscription gone", r410.gone === true);
  const rNet = await sendEmptyPush({ endpoint: "https://push.example.com/x" }, vapid, async () => { throw new Error("net"); });
  ok("a network error keeps the subscription (retry tomorrow)", rNet.ok === false && rNet.gone === false);
}

// --- shouldPush decision table ---
ok("trained yesterday -> no push", shouldPush({ lastSessionAt: daysAgo(1), now: NOW }) === false);
ok(`lapse of ${PUSH_MIN_LAPSE_DAYS}d -> push`, shouldPush({ lastSessionAt: daysAgo(2), now: NOW }) === true);
ok(`lapse past ${PUSH_MAX_LAPSE_DAYS}d goes quiet (email owns the long tail)`, shouldPush({ lastSessionAt: daysAgo(30), now: NOW }) === false);
ok("paused users are NEVER pushed", shouldPush({ lastSessionAt: daysAgo(5), paused: true, now: NOW }) === false);
ok("reminders_off is a hard opt-out for push too", shouldPush({ lastSessionAt: daysAgo(5), remindersOff: true, now: NOW }) === false);
ok("never-trained: activation push after a day", shouldPush({ lastSessionAt: null, subscribedAt: daysAgo(2), now: NOW }) === true);
ok("never-trained: not within the first hours of subscribing", shouldPush({ lastSessionAt: null, subscribedAt: new Date(NOW - 3600e3).toISOString(), now: NOW }) === false);

// --- sweep against the real file store ---
const path = join(tmpdir(), `hb-push-test-${process.pid}.json`);
const store = createFileStore(path);
try {
  await store.saveUser("lapsed", { profile: {} });
  await store.saveUser("fresh", { profile: {} });
  await store.saveUser("pausedu", { profile: {}, paused: { from: daysAgo(1) } });
  await store.addSession("lapsed", { session_id: "l1", date: daysAgo(4), sets: [] });
  await store.addSession("fresh", { session_id: "f1", date: daysAgo(1), sets: [] });
  await store.addSession("pausedu", { session_id: "p1", date: daysAgo(4), sets: [] });
  for (const [u, ep] of [["lapsed", "https://p.example/l"], ["fresh", "https://p.example/f"], ["pausedu", "https://p.example/p"], ["ghost-user", "https://p.example/g"]])
    await store.savePushSubscription(u, { endpoint: ep, keys: { p256dh: "k", auth: "a" } });

  const hits = [];
  const fakeFetch = async (url) => { hits.push(url); return url.endsWith("/l") ? { ok: true, status: 201 } : { ok: false, status: 410 }; };
  const r = await runPushSweep(store, vapid, NOW, fakeFetch);
  ok("sweep pushes ONLY the lapsed opted-in user", hits.length === 1 && hits[0] === "https://p.example/l" && r.sent === 1);
  ok("a subscription whose user is gone is pruned without a send", r.pruned >= 1 && !(await store.listPushSubscriptions()).some((s) => s.user_id === "ghost-user"));
  const again = await runPushSweep(store, vapid, new Date(NOW).getTime(), async (url) => { hits.push(url); return { ok: false, status: 410 }; });
  ok("a 410 on send prunes that subscription", again.pruned === 1 && !(await store.listPushSubscriptions()).some((s) => s.endpoint === "https://p.example/l"));

  console.log(`\n${pass} push test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
