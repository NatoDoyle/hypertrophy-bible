// Web Push tests: the VAPID JWT is verified END-TO-END with WebCrypto (sign
// here, verify against the public key — not just shape-checked), the sweep runs
// against the real file store with an injected fetch, and dead subscriptions
// are pruned. No network, no Date.now in assertions.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import { buildVapidAuth, sendEmptyPush, shouldPush, shouldPushForCommitment, runPushSweep, isAllowedPushEndpoint, PUSH_MIN_LAPSE_DAYS, PUSH_MAX_LAPSE_DAYS, isUserPushHour } from "../src/push.mjs";
import { isoWeekKey, weekDayKey } from "../../tools/derive-core.mjs";

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

// --- #25 endpoint host allowlist (SSRF guard on the outbound sweep) ---
for (const good of [
  "https://updates.push.services.mozilla.com/wpush/v2/abc",
  "https://fcm.googleapis.com/fcm/send/xyz",
  "https://android.googleapis.com/gcm/send/xyz",
  "https://foo.notify.windows.com/w/?token=x",
  "https://web.push.apple.com/abc",
]) ok(`allows real push host: ${new URL(good).hostname}`, isAllowedPushEndpoint(good) === true);
for (const bad of [
  "https://169.254.169.254/latest/meta-data/",       // cloud metadata
  "https://attacker.example.com/collect",              // arbitrary host
  "http://fcm.googleapis.com/fcm/send/x",              // not https
  "https://fcm.googleapis.com.attacker.example/x",     // suffix-spoof attempt
  "https://evil-push.services.mozilla.com.attacker/x", // lookalike
  "https://storage.googleapis.com/attacker-bucket/o",  // #29: generic Google API host, NOT a push service
  "https://www.googleapis.com/upload/x",               // #29: same umbrella, must be rejected
  "not-a-url",
]) ok(`rejects non-push endpoint: ${bad.slice(0, 40)}`, isAllowedPushEndpoint(bad) === false);

// --- shouldPush decision table ---
ok("trained yesterday -> no push", shouldPush({ lastSessionAt: daysAgo(1), now: NOW }) === false);
ok(`lapse of ${PUSH_MIN_LAPSE_DAYS}d -> push`, shouldPush({ lastSessionAt: daysAgo(2), now: NOW }) === true);
ok(`lapse past ${PUSH_MAX_LAPSE_DAYS}d goes quiet (email owns the long tail)`, shouldPush({ lastSessionAt: daysAgo(30), now: NOW }) === false);
ok("paused users are NEVER pushed", shouldPush({ lastSessionAt: daysAgo(5), paused: true, now: NOW }) === false);
ok("reminders_off is a hard opt-out for push too", shouldPush({ lastSessionAt: daysAgo(5), remindersOff: true, now: NOW }) === false);
ok("never-trained: activation push after a day", shouldPush({ lastSessionAt: null, subscribedAt: daysAgo(2), now: NOW }) === true);
ok("never-trained: not within the first hours of subscribing", shouldPush({ lastSessionAt: null, subscribedAt: new Date(NOW - 3600e3).toISOString(), now: NOW }) === false);

// --- shouldPushForCommitment: proactive, keyed to the user's OWN weekly plan ---
const THIS_WEEK = isoWeekKey(NOW);
const TODAY_KEY = weekDayKey(NOW);
ok("today is a committed day, never trained -> push", shouldPushForCommitment({ commitment: { week: THIS_WEEK, days: [TODAY_KEY] }, lastSessionAt: null, now: NOW }) === true);
ok("today is a committed day, already trained TODAY -> no push", shouldPushForCommitment({ commitment: { week: THIS_WEEK, days: [TODAY_KEY] }, lastSessionAt: NOW, now: NOW }) === false);
ok("today is a committed day, trained YESTERDAY (not today) -> still push", shouldPushForCommitment({ commitment: { week: THIS_WEEK, days: [TODAY_KEY] }, lastSessionAt: daysAgo(1), now: NOW }) === true);
ok("today is NOT a committed day -> no push", shouldPushForCommitment({ commitment: { week: THIS_WEEK, days: ["not-a-real-day-that-matches-today"] }, lastSessionAt: null, now: NOW }) === false);
ok("no commitment set -> no push", shouldPushForCommitment({ commitment: null, lastSessionAt: null, now: NOW }) === false);
ok("a commitment from a PRIOR week is stale and never fires", shouldPushForCommitment({ commitment: { week: "2020-W01", days: [TODAY_KEY] }, lastSessionAt: null, now: NOW }) === false);
ok("paused users are NEVER pushed for a commitment either", shouldPushForCommitment({ commitment: { week: THIS_WEEK, days: [TODAY_KEY] }, lastSessionAt: null, paused: true, now: NOW }) === false);
ok("reminders_off is a hard opt-out for commitment pushes too", shouldPushForCommitment({ commitment: { week: THIS_WEEK, days: [TODAY_KEY] }, lastSessionAt: null, remindersOff: true, now: NOW }) === false);
// Same-day-after-training is exactly the case shouldPush's PUSH_MIN_LAPSE_DAYS gate would block —
// the commitment path fires anyway because it's a DIFFERENT reason (the user's own stated plan).
ok("shouldPush alone would block a same-day-after-training push (the gate this feature bypasses)", shouldPush({ lastSessionAt: daysAgo(1), now: NOW }) === false);

// --- timezone-aware push timing: the hourly sweep gives each user ONE eligible hour ---
const atUtc = (iso) => +new Date(iso);
ok("no timezone stored -> fires only at the legacy 16:00 UTC hour", isUserPushHour(undefined, atUtc("2026-07-10T16:30:00Z")) === true);
ok("no timezone stored -> silent at other UTC hours", isUserPushHour(undefined, atUtc("2026-07-10T15:30:00Z")) === false);
ok("US Eastern (-300) fires at ~17:00 local (22:00 UTC)", isUserPushHour(-300, atUtc("2026-07-10T22:00:00Z")) === true);
ok("US Eastern (-300) silent at 16:00 UTC (noon local)", isUserPushHour(-300, atUtc("2026-07-10T16:00:00Z")) === false);
ok("UTC+12 (+720) fires at ~17:00 local (05:00 UTC) — the 3am-nudge case this fixes", isUserPushHour(720, atUtc("2026-07-10T05:00:00Z")) === true);
ok("UTC+12 (+720) silent at 16:00 UTC (04:00 local — the old bad slot)", isUserPushHour(720, atUtc("2026-07-10T16:00:00Z")) === false);
ok("a tz-known UTC user shifts to 17:00 local, not the legacy 16:00", isUserPushHour(0, atUtc("2026-07-10T17:00:00Z")) === true && isUserPushHour(0, atUtc("2026-07-10T16:00:00Z")) === false);

// End-to-end: the sweep skips a user outside their local window and pushes them inside it.
{
  const tzPath = join(tmpdir(), `hb-push-tz-test-${process.pid}.json`);
  const tzStore = createFileStore(tzPath);
  try {
    await tzStore.saveUser("tzu", { profile: { tz_offset_min: 720, commitment: { week: THIS_WEEK, days: [TODAY_KEY] } } }); // UTC+12, committed today
    await tzStore.savePushSubscription("tzu", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/tz", keys: { p256dh: "k", auth: "a" } });
    const h1 = []; await runPushSweep(tzStore, vapid, atUtc("2026-07-10T16:00:00Z"), async (u) => { h1.push(u); return { ok: true, status: 201 }; });
    ok("sweep at 16:00 UTC does NOT push a UTC+12 user (would be 4am local)", h1.length === 0);
    const h2 = []; await runPushSweep(tzStore, vapid, atUtc("2026-07-10T05:00:00Z"), async (u) => { h2.push(u); return { ok: true, status: 201 }; });
    ok("sweep at their 17:00 local (05:00 UTC) DOES push the UTC+12 user", h2.length === 1);
  } finally { try { rmSync(tzPath); } catch {} }
}

// --- sweep against the real file store ---
const path = join(tmpdir(), `hb-push-test-${process.pid}.json`);
const store = createFileStore(path);
try {
  await store.saveUser("lapsed", { profile: {} });
  await store.saveUser("fresh", { profile: {} });
  await store.saveUser("pausedu", { profile: {}, paused: { from: daysAgo(1) } });
  // Trained YESTERDAY (same as "fresh" — shouldPush alone would stay silent), but
  // committed to training TODAY: the commitment path must push anyway.
  await store.saveUser("committed", { profile: { commitment: { week: THIS_WEEK, days: [TODAY_KEY] } } });
  await store.addSession("lapsed", { session_id: "l1", date: daysAgo(4), sets: [] });
  await store.addSession("fresh", { session_id: "f1", date: daysAgo(1), sets: [] });
  await store.addSession("pausedu", { session_id: "p1", date: daysAgo(4), sets: [] });
  await store.addSession("committed", { session_id: "c1", date: daysAgo(1), sets: [] });
  for (const [u, ep] of [["lapsed", "https://updates.push.services.mozilla.com/wpush/v2/l"], ["fresh", "https://updates.push.services.mozilla.com/wpush/v2/f"], ["pausedu", "https://updates.push.services.mozilla.com/wpush/v2/p"], ["committed", "https://updates.push.services.mozilla.com/wpush/v2/c"], ["ghost-user", "https://updates.push.services.mozilla.com/wpush/v2/g"]])
    await store.savePushSubscription(u, { endpoint: ep, keys: { p256dh: "k", auth: "a" } });

  const hits = [];
  const fakeFetch = async (url) => { hits.push(url); return (url.endsWith("/l") || url.endsWith("/c")) ? { ok: true, status: 201 } : { ok: false, status: 410 }; };
  const r = await runPushSweep(store, vapid, NOW, fakeFetch);
  ok("sweep pushes the lapsed opted-in user AND the committed-but-not-yet-trained-today user, nobody else",
    hits.length === 2 && hits.includes("https://updates.push.services.mozilla.com/wpush/v2/l") && hits.includes("https://updates.push.services.mozilla.com/wpush/v2/c") && r.sent === 2);
  ok("a subscription whose user is gone is pruned without a send", r.pruned >= 1 && !(await store.listPushSubscriptions()).some((s) => s.user_id === "ghost-user"));
  // "committed" trains TODAY between sweeps, so the next sweep's 410 must prune
  // only "lapsed" — proves the commitment reminder stops once its day is trained.
  await store.addSession("committed", { session_id: "c2", date: new Date(NOW).toISOString(), sets: [] });
  const again = await runPushSweep(store, vapid, new Date(NOW).getTime(), async (url) => { hits.push(url); return { ok: false, status: 410 }; });
  ok("a 410 on send prunes that subscription", again.pruned === 1 && !(await store.listPushSubscriptions()).some((s) => s.endpoint === "https://updates.push.services.mozilla.com/wpush/v2/l"));

  // #26 scoped unsubscribe: another user's user_id can't delete your subscription
  await store.saveUser("owner", { profile: {} });
  await store.savePushSubscription("owner", { endpoint: "https://fcm.googleapis.com/fcm/send/owned", keys: {} });
  await store.deletePushSubscription("https://fcm.googleapis.com/fcm/send/owned", "attacker");
  ok("#26 unsubscribe with a mismatched user_id is a no-op", (await store.listPushSubscriptions()).some((s) => s.endpoint === "https://fcm.googleapis.com/fcm/send/owned"));
  await store.deletePushSubscription("https://fcm.googleapis.com/fcm/send/owned", "owner");
  ok("#26 unsubscribe with the owning user_id removes it", !(await store.listPushSubscriptions()).some((s) => s.endpoint === "https://fcm.googleapis.com/fcm/send/owned"));

  // #26 merge moves push subscriptions to the surviving user (not orphaned -> pruned)
  await store.saveUser("mfrom", { profile: {} });
  await store.saveUser("mto", { profile: {} });
  await store.savePushSubscription("mfrom", { endpoint: "https://fcm.googleapis.com/fcm/send/merge", keys: {} });
  await store.reassignUserData("mfrom", "mto");
  const moved = (await store.listPushSubscriptions()).find((s) => s.endpoint === "https://fcm.googleapis.com/fcm/send/merge");
  ok("#26 a merged-away device's push subscription follows to the surviving user", moved && moved.user_id === "mto");

  console.log(`\n${pass} push test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
