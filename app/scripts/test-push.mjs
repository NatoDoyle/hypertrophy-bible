// Web Push tests: the VAPID JWT is verified END-TO-END with WebCrypto (sign
// here, verify against the public key — not just shape-checked), the sweep runs
// against the real file store with an injected fetch, and dead subscriptions
// are pruned. No network, no Date.now in assertions.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import { buildVapidAuth, sendEmptyPush, sendPush, shouldPush, shouldPushForCommitment, runPushSweep, isAllowedPushEndpoint, PUSH_MIN_LAPSE_DAYS, PUSH_MAX_LAPSE_DAYS, isUserPushHour } from "../src/push.mjs";
import { decryptPushPayload, bytesToB64u } from "../src/push-encrypt.mjs";
import { isoWeekKey, weekDayKey } from "../../tools/derive-core.mjs";

// A fake browser subscription: a real UA-generated ECDH keypair + a random auth
// secret (same pattern as test-push-encrypt.mjs), so sendPush's encryption runs
// for real and a test can decrypt the result to check the app never sends the
// static-reminder path a payload it can't handle.
async function fakeUaSubscription() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const auth = bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
  return { p256dh, auth, privJwk };
}

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

// --- sendPush: a content-bearing (RFC 8291) push encrypts, and the UA can decrypt it ---
{
  const ua = await fakeUaSubscription();
  let seen = null;
  const okFetch = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 201 }; };
  const payload = { title: "The Hypertrophy Bible", body: "Your training partner nudged you — jump back in.", tag: "hb-nudge" };
  const r1 = await sendPush({ endpoint: "https://push.example.com/x", p256dh: ua.p256dh, auth: ua.auth }, vapid, payload, okFetch);
  ok("sendPush POSTs an encrypted body with aes128gcm headers", r1.ok
    && seen.opts.headers["Content-Encoding"] === "aes128gcm"
    && seen.opts.headers["Content-Type"] === "application/octet-stream"
    && /^vapid /.test(seen.opts.headers.Authorization)
    && seen.opts.body instanceof Uint8Array && seen.opts.body.length > 0);
  const decrypted = await decryptPushPayload({ body: seen.opts.body, uaPrivateJwk: ua.privJwk, auth: ua.auth });
  ok("the UA's own keys decrypt it back to the exact JSON payload", JSON.parse(decrypted).body === payload.body && JSON.parse(decrypted).tag === "hb-nudge");
  const r410 = await sendPush({ endpoint: "https://push.example.com/x", p256dh: ua.p256dh, auth: ua.auth }, vapid, payload, async () => ({ ok: false, status: 410 }));
  ok("sendPush also detects a gone subscription", r410.gone === true);
  const rBadKeys = await sendPush({ endpoint: "https://push.example.com/x", p256dh: "not-valid-keys", auth: "x" }, vapid, payload, okFetch);
  ok("sendPush fails soft (not throw) on undecryptable subscription keys", rBadKeys.ok === false && rBadKeys.gone === false);
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

// --- runPushSweep: a pending training-partner nudge sends an ENCRYPTED, content-bearing
// push (not the empty reminder), fires regardless of the user's local reminder hour, and
// never repeats once delivered. ---
{
  const nudgePath = join(tmpdir(), `hb-push-nudge-test-${process.pid}.json`);
  const nudgeStore = createFileStore(nudgePath);
  try {
    const ua = await fakeUaSubscription();
    await nudgeStore.saveUser("nudgee", { profile: { tz_offset_min: -300, partner_nudge: { at: NOW } } }); // 22:00 UTC local hour, NOT their push hour at NOW
    await nudgeStore.savePushSubscription("nudgee", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/nudge", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    let sentBody = null;
    const captureFetch = async (url, opts) => { sentBody = opts.body; return { ok: true, status: 201 }; };
    const r1 = await runPushSweep(nudgeStore, vapid, NOW, captureFetch);
    ok("a pending nudge sends even OUTSIDE the user's local reminder hour", r1.sent === 1 && sentBody instanceof Uint8Array);
    const decrypted = JSON.parse(await decryptPushPayload({ body: sentBody, uaPrivateJwk: ua.privJwk, auth: ua.auth }));
    ok("the delivered push is the nudge copy, not the empty reminder", decrypted.tag === "hb-nudge" && /nudged you/.test(decrypted.body));
    const nudgee = await nudgeStore.getUser("nudgee");
    ok("nudge_pushed_at is stamped with the nudge's own timestamp (seen-once marker)", nudgee.profile.nudge_pushed_at === NOW);

    sentBody = "unset";
    const r2 = await runPushSweep(nudgeStore, vapid, NOW + 3600e3, captureFetch);
    ok("the SAME nudge is never pushed twice", r2.sent === 0 && sentBody === "unset");

    // A fresh nudge (later timestamp) fires again — proves it's keyed to the event, not a one-shot lock.
    await nudgeStore.updateUser("nudgee", (u) => { u.profile = { ...(u.profile ?? {}), partner_nudge: { at: NOW + 7200e3 } }; return u; });
    const r3 = await runPushSweep(nudgeStore, vapid, NOW + 7200e3, captureFetch);
    ok("a NEW nudge event fires its own push", r3.sent === 1 && sentBody instanceof Uint8Array);

    // Paused/reminders_off users never get the nudge push either (same guardrail as the reminder).
    await nudgeStore.saveUser("nudgee-paused", { profile: { partner_nudge: { at: NOW } }, paused: { from: daysAgo(1) } });
    await nudgeStore.savePushSubscription("nudgee-paused", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/nudge-paused", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    const r4 = await runPushSweep(nudgeStore, vapid, NOW, captureFetch);
    ok("a paused user with a pending nudge is NOT pushed", r4.sent === 0 && sentBody === "unset");
  } finally { try { rmSync(nudgePath); } catch {} }
}

// --- runPushSweep: a pending challenge INVITE (the opponent's still-pending half)
// sends an ENCRYPTED, content-bearing push, fires regardless of the user's local
// reminder hour, never repeats once delivered, and never fires for the CHALLENGER's
// own half or a non-pending status. ---
{
  const chalPath = join(tmpdir(), `hb-push-challenge-test-${process.pid}.json`);
  const chalStore = createFileStore(chalPath);
  try {
    const ua = await fakeUaSubscription();
    const week = isoWeekKey(new Date(NOW).toISOString());
    await chalStore.saveUser("opponent", { profile: { tz_offset_min: -300, challenge: { id: "c1", role: "opponent", status: "pending", week, created_at: NOW } } }); // 22:00 UTC local hour, NOT their push hour at NOW
    await chalStore.savePushSubscription("opponent", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/challenge", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    let sentBody = null;
    const captureFetch = async (url, opts) => { sentBody = opts.body; return { ok: true, status: 201 }; };
    const r1 = await runPushSweep(chalStore, vapid, NOW, captureFetch);
    ok("a pending challenge invite sends even OUTSIDE the user's local reminder hour", r1.sent === 1 && sentBody instanceof Uint8Array);
    const decrypted = JSON.parse(await decryptPushPayload({ body: sentBody, uaPrivateJwk: ua.privJwk, auth: ua.auth }));
    ok("the delivered push is the challenge copy, not the empty reminder", decrypted.tag === "hb-challenge" && /challenged you/.test(decrypted.body));
    const opponent = await chalStore.getUser("opponent");
    ok("challenge_pushed_at is stamped with the challenge's own created_at (seen-once marker)", opponent.profile.challenge_pushed_at === NOW);

    sentBody = "unset";
    const r2 = await runPushSweep(chalStore, vapid, NOW + 3600e3, captureFetch);
    ok("the SAME challenge invite is never pushed twice", r2.sent === 0 && sentBody === "unset");

    // A fresh challenge (later created_at) fires again — proves it's keyed to the event.
    await chalStore.updateUser("opponent", (u) => { u.profile = { ...(u.profile ?? {}), challenge: { ...u.profile.challenge, id: "c2", created_at: NOW + 7200e3 } }; return u; });
    const r3 = await runPushSweep(chalStore, vapid, NOW + 7200e3, captureFetch);
    ok("a NEW challenge event fires its own push", r3.sent === 1 && sentBody instanceof Uint8Array);

    // The CHALLENGER's own half (role: "challenger") never pushes — they proposed it, nothing to announce.
    await chalStore.saveUser("challenger", { profile: { challenge: { id: "c3", role: "challenger", status: "pending", week, created_at: NOW } } });
    await chalStore.savePushSubscription("challenger", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/challenger", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    const r4 = await runPushSweep(chalStore, vapid, NOW, captureFetch);
    ok("the challenger's own pending half is NOT pushed", r4.sent === 0 && sentBody === "unset");

    // An ACTIVE (already-accepted) challenge is not a new invite — nothing to push.
    await chalStore.saveUser("active-opp", { profile: { challenge: { id: "c4", role: "opponent", status: "active", week, created_at: NOW } } });
    await chalStore.savePushSubscription("active-opp", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/active-opp", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    const r5 = await runPushSweep(chalStore, vapid, NOW, captureFetch);
    ok("an already-active challenge is NOT pushed as a new invite", r5.sent === 0 && sentBody === "unset");

    // A challenge from a STALE (already-ended) week never pushes, even if never read via GET yet.
    const staleWeek = isoWeekKey(new Date(NOW - 20 * 86400000).toISOString());
    await chalStore.saveUser("stale-opp", { profile: { challenge: { id: "c5", role: "opponent", status: "pending", week: staleWeek, created_at: NOW } } });
    await chalStore.savePushSubscription("stale-opp", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/stale-opp", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    const r6 = await runPushSweep(chalStore, vapid, NOW, captureFetch);
    ok("a challenge whose week has already ended is NOT pushed", r6.sent === 0 && sentBody === "unset");

    // Paused/reminders_off users never get the challenge push either.
    await chalStore.saveUser("opponent-paused", { profile: { challenge: { id: "c6", role: "opponent", status: "pending", week, created_at: NOW } }, paused: { from: daysAgo(1) } });
    await chalStore.savePushSubscription("opponent-paused", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/opponent-paused", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    const r7 = await runPushSweep(chalStore, vapid, NOW, captureFetch);
    ok("a paused user with a pending challenge invite is NOT pushed", r7.sent === 0 && sentBody === "unset");

    // --- accept push (Wave 137): the CHALLENGER hears when the opponent accepts ---
    await chalStore.saveUser("challenger", { profile: { tz_offset_min: -300, challenge: { id: "c9", role: "challenger", status: "active", week, created_at: NOW - 3600e3, accepted_at: NOW } } });
    await chalStore.savePushSubscription("challenger", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/accept", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    let acceptHits = 0; sentBody = "unset";
    const acceptFetch = async (url, opts) => { if (url.includes("/accept")) { acceptHits++; sentBody = opts.body; } return { ok: true, status: 201 }; };
    await runPushSweep(chalStore, vapid, NOW, acceptFetch);
    ok("an accepted challenge pushes 'challenge on' to the CHALLENGER, any hour", acceptHits === 1 && sentBody instanceof Uint8Array);
    const aMsg = JSON.parse(await decryptPushPayload({ body: sentBody, uaPrivateJwk: ua.privJwk, auth: ua.auth }));
    ok("the accept push carries the challenge-on copy", aMsg.tag === "hb-challenge" && /accepted/.test(aMsg.body));
    ok("challenge_accept_pushed_at is stamped (seen-once)", (await chalStore.getUser("challenger")).profile.challenge_accept_pushed_at === NOW);
    acceptHits = 0;
    await runPushSweep(chalStore, vapid, NOW + 3600e3, acceptFetch);
    ok("the SAME accept never pushes twice", acceptHits === 0);
    // A pre-137 active challenge (no accepted_at) can never fire; a declined one has no consumer.
    await chalStore.saveUser("chal-old", { profile: { tz_offset_min: -300, challenge: { id: "c10", role: "challenger", status: "active", week, created_at: NOW } } });
    await chalStore.savePushSubscription("chal-old", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/accept-old", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    await chalStore.saveUser("chal-declined", { profile: { tz_offset_min: -300, challenge: { id: "c11", role: "challenger", status: "declined", week, created_at: NOW, accepted_at: NOW } } });
    await chalStore.savePushSubscription("chal-declined", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/accept-decl", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    let oldDeclHits = 0;
    await runPushSweep(chalStore, vapid, NOW, async (url, opts) => { if (url.includes("accept-old") || url.includes("accept-decl")) oldDeclHits++; return { ok: true, status: 201 }; });
    ok("a pre-accepted_at active challenge and a declined one never accept-push", oldDeclHits === 0);
  } finally { try { rmSync(chalPath); } catch {} }
}

// --- runPushSweep: a challenge RESULT (this slice) — before this, a completed
// challenge only ever surfaced on the user's OWN next `GET /api/challenge`;
// someone who never reopens the app after their week ends never learned
// whether they won. The sweep now resolves + pushes proactively, using the
// SAME resolveChallenge (push.mjs) the route itself calls (lesson 1). ---
{
  const resPath = join(tmpdir(), `hb-push-challenge-result-test-${process.pid}.json`);
  const resStore = createFileStore(resPath);
  try {
    const ua = await fakeUaSubscription();
    const pastWeekDate = new Date(NOW - 8 * 7 * 86400000).toISOString();
    const pastWeek = isoWeekKey(pastWeekDate);
    const bench = (id, date) => ({ session_id: id, date, sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });

    // Winner side: 2 sessions vs the opponent's 1 -> a real WIN, pushed proactively.
    await resStore.createShare("loser-opp", "share-loser-opp", NOW);
    await resStore.saveUser("winner", { profile: { tz_offset_min: -300, challenge: { id: "r1", role: "challenger", partner_token: "share-loser-opp", week: pastWeek, status: "active", created_at: NOW, accepted_at: NOW } } });
    await resStore.saveUser("loser-opp", { profile: {} });
    await resStore.addSession("winner", bench("res-w1", pastWeekDate));
    await resStore.addSession("winner", bench("res-w2", pastWeekDate));
    await resStore.addSession("loser-opp", bench("res-l1", pastWeekDate));
    await resStore.savePushSubscription("winner", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/result-win", keys: { p256dh: ua.p256dh, auth: ua.auth } });

    let sentBody = "unset";
    const captureFetch = async (url, opts) => { sentBody = opts.body; return { ok: true, status: 201 }; };
    const r1 = await runPushSweep(resStore, vapid, NOW, captureFetch);
    ok("a completed challenge pushes the WIN result proactively", r1.sent === 1 && sentBody instanceof Uint8Array);
    const decrypted = JSON.parse(await decryptPushPayload({ body: sentBody, uaPrivateJwk: ua.privJwk, auth: ua.auth }));
    ok("the result push names the win and the score", decrypted.tag === "hb-challenge" && /won 2–1/.test(decrypted.body));
    const winner = await resStore.getUser("winner");
    ok("the challenge slot itself is resolved to completed with the result recorded on it", winner.profile.challenge.status === "completed" && winner.profile.challenge.result === "win");
    ok("history also records the win (same write resolveChallenge already made for GET)", winner.profile.challenge_history?.[0]?.result === "win");
    ok("challenge_result_pushed_at is stamped to the challenge's own completed_at (seen-once)", winner.profile.challenge_result_pushed_at === winner.profile.challenge.completed_at);

    sentBody = "unset";
    const r2 = await runPushSweep(resStore, vapid, NOW + 3600e3, captureFetch);
    ok("the SAME result is never pushed twice", r2.sent === 0 && sentBody === "unset");

    // Mirror: the opponent's own side independently resolves to a LOSE.
    await resStore.createShare("winner", "share-winner", NOW);
    await resStore.saveUser("loser-opp", { profile: { tz_offset_min: -300, challenge: { id: "r1", role: "opponent", partner_token: "share-winner", week: pastWeek, status: "active", created_at: NOW } } });
    await resStore.savePushSubscription("loser-opp", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/result-lose", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    await runPushSweep(resStore, vapid, NOW, captureFetch);
    const loseMsg = JSON.parse(await decryptPushPayload({ body: sentBody, uaPrivateJwk: ua.privJwk, auth: ua.auth }));
    ok("the mirror side gets its own LOSE push, independently derived", loseMsg.tag === "hb-challenge" && /lost 1–2/.test(loseMsg.body));

    // A still-running (week not over) active challenge is never resolved or pushed.
    const thisWeek = isoWeekKey(new Date(NOW).toISOString());
    await resStore.createShare("live-opp", "share-live-opp", NOW);
    await resStore.saveUser("live", { profile: { tz_offset_min: -300, challenge: { id: "r2", role: "challenger", partner_token: "share-live-opp", week: thisWeek, status: "active", created_at: NOW } } });
    await resStore.saveUser("live-opp", { profile: {} });
    await resStore.savePushSubscription("live", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/result-live", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    const rLive = await runPushSweep(resStore, vapid, NOW, captureFetch);
    ok("a mid-week active challenge is not touched by the result push", sentBody === "unset" && (await resStore.getUser("live")).profile.challenge.status === "active");

    // An opponent whose share vanished has no real score — completes, but no
    // result is recorded, so nothing gets pushed (never manufacture a trophy).
    await resStore.saveUser("vanished", { profile: { tz_offset_min: -300, challenge: { id: "r3", role: "challenger", partner_token: "share-gone-forever", week: pastWeek, status: "active", created_at: NOW } } });
    await resStore.savePushSubscription("vanished", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/result-vanished", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    await runPushSweep(resStore, vapid, NOW, captureFetch);
    ok("a vanished opponent completes the slot with NO result and NO push", sentBody === "unset"
      && (await resStore.getUser("vanished")).profile.challenge.status === "completed"
      && (await resStore.getUser("vanished")).profile.challenge.result === undefined);

    // A stale PENDING invite (never answered, week over) is left for GET to
    // self-transition to "declined" — the sweep's result push never touches it.
    await resStore.saveUser("stale-pending", { profile: { tz_offset_min: -300, challenge: { id: "r4", role: "opponent", partner_token: "share-loser-opp", week: pastWeek, status: "pending", created_at: NOW } } });
    await resStore.savePushSubscription("stale-pending", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/result-stale-pending", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    await runPushSweep(resStore, vapid, NOW, captureFetch);
    ok("a stale pending invite is not resolved/pushed by the result sweep (GET's job)", sentBody === "unset" && (await resStore.getUser("stale-pending")).profile.challenge.status === "pending");

    // Retry-safe: a challenge already resolved to "completed" with a result (e.g. a
    // prior tick's push send failed) is pushed straight off the STORED fields —
    // no re-fetch, no re-write — the moment a live device is available.
    await resStore.saveUser("retry", { profile: { tz_offset_min: -300, challenge: { id: "r5", status: "completed", week: pastWeek, result: "tie", completed_at: NOW - 3600e3, my_count: 2, opponent_count: 2 } } });
    await resStore.savePushSubscription("retry", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/result-retry", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    sentBody = "unset";
    await runPushSweep(resStore, vapid, NOW, captureFetch);
    const retryMsg = JSON.parse(await decryptPushPayload({ body: sentBody, uaPrivateJwk: ua.privJwk, auth: ua.auth }));
    ok("an already-resolved result retries straight off the stored fields", retryMsg.tag === "hb-challenge" && /tied 2–2/.test(retryMsg.body));
    ok("the retry stamps the seen-once marker too", (await resStore.getUser("retry")).profile.challenge_result_pushed_at === NOW - 3600e3);
  } finally { try { rmSync(resPath); } catch {} }
}

// --- multi-device fan-out (Wave 136): the per-USER social markers must not let the
// FIRST device's successful send consume the event for every other device. ---
{
  const mdPath = join(tmpdir(), `hb-push-multidev-test-${process.pid}.json`);
  const mdStore = createFileStore(mdPath);
  try {
    const ua = await fakeUaSubscription();
    await mdStore.saveUser("multi", { profile: { tz_offset_min: -300, partner_nudge: { at: NOW } } });
    await mdStore.savePushSubscription("multi", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/md-laptop", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    await mdStore.savePushSubscription("multi", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/md-phone", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    let hits = [];
    const recordFetch = async (url) => { hits.push(url); return { ok: true, status: 201 }; };
    const r1 = await runPushSweep(mdStore, vapid, NOW, recordFetch);
    ok("a nudge fans out to BOTH of a user's devices, not just the first", r1.sent === 2 && hits.filter((u) => u.includes("md-")).length === 2);
    ok("the marker is stamped ONCE after the fan-out", (await mdStore.getUser("multi")).profile.nudge_pushed_at === NOW);
    hits = [];
    const r2 = await runPushSweep(mdStore, vapid, NOW + 3600e3, recordFetch);
    ok("after the fan-out, the same nudge never re-fires on either device", r2.sent === 0 && hits.length === 0);

    // First device's subscription is dead (410): it's pruned, the second still hears,
    // and the marker still stamps — the event is never consumed by a dead endpoint.
    await mdStore.saveUser("multi2", { profile: { tz_offset_min: -300, partner_nudge: { at: NOW } } });
    await mdStore.savePushSubscription("multi2", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/m2-dead", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    await mdStore.savePushSubscription("multi2", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/m2-live", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    const mixedFetch = async (url) => url.includes("m2-dead") ? { ok: false, status: 410 } : { ok: true, status: 201 };
    const r3 = await runPushSweep(mdStore, vapid, NOW, mixedFetch);
    ok("a dead first device is pruned while the live one still receives", r3.sent === 1 && r3.pruned === 1);
    ok("the marker stamps because a live device accepted", (await mdStore.getUser("multi2")).profile.nudge_pushed_at === NOW);

    // EVERY send fails (network): the marker must NOT stamp, so the next tick retries.
    await mdStore.saveUser("multi3", { profile: { tz_offset_min: -300, partner_nudge: { at: NOW } } });
    await mdStore.savePushSubscription("multi3", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/m3-a", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    const failFetch = async () => { throw new Error("network down"); };
    await runPushSweep(mdStore, vapid, NOW, failFetch);
    ok("an all-failed fan-out leaves the marker unstamped (retry next tick)", ((await mdStore.getUser("multi3")).profile.nudge_pushed_at ?? 0) === 0);
    const retry = await runPushSweep(mdStore, vapid, NOW + 3600e3, async () => ({ ok: true, status: 201 }));
    ok("the retry tick then delivers and stamps", retry.sent >= 1 && (await mdStore.getUser("multi3")).profile.nudge_pushed_at === NOW);

    // A challenge invite fans out the same way.
    await mdStore.saveUser("multi4", { profile: { tz_offset_min: -300, challenge: { id: "c1", role: "opponent", status: "pending", week: isoWeekKey(new Date(NOW).toISOString()), created_at: NOW } } });
    await mdStore.savePushSubscription("multi4", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/m4-a", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    await mdStore.savePushSubscription("multi4", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/m4-b", keys: { p256dh: ua.p256dh, auth: ua.auth } });
    let m4hits = [];
    const r4 = await runPushSweep(mdStore, vapid, NOW, async (url) => { m4hits.push(url); return { ok: true, status: 201 }; });
    ok("a challenge invite fans out to BOTH devices too", m4hits.filter((u) => u.includes("m4-")).length === 2 && (await mdStore.getUser("multi4")).profile.challenge_pushed_at === NOW);
  } finally { try { rmSync(mdPath); } catch {} }
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
