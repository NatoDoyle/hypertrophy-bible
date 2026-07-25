// Verification for the RFC 8291 push-payload encryption (src/push-encrypt.mjs).
// ROUND-TRIP: encrypt a message to a freshly-generated "subscription" public key,
// then decrypt with that subscription's private key. This exercises the FULL path —
// ECDH (both sides must derive the same secret), HKDF (both must derive the same
// CEK/nonce from the RFC info-strings), AES-GCM with its auth tag, and the salt +
// header byte-framing. Any inconsistency in any of those fails the round-trip.
// (A byte-exact RFC 8291 §5 known-answer test would additionally prove RFC-compliance
// of the constants; it's a fast-follow — the constants here are per RFC 8291 §3.4 /
// RFC 8188 §2.1, and a real push-service send is the ultimate compliance check.)
import assert from "node:assert";
import { encryptPushPayload, decryptPushPayload, bytesToB64u } from "../src/push-encrypt.mjs";

let pass = 0, fail = 0;
const check = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); } };

// A fake subscription: a real UA-generated ECDH keypair + a random auth secret.
async function fakeSubscription() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const auth = bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
  return { p256dh, auth, privJwk };
}

await check("round-trips: decrypt recovers the exact plaintext", async () => {
  const sub = await fakeSubscription();
  const plaintext = "💪 Someone cheered your 12-week streak!";
  const { body, headers } = await encryptPushPayload({ p256dh: sub.p256dh, auth: sub.auth, plaintext });
  assert.equal(headers["Content-Encoding"], "aes128gcm");
  const out = await decryptPushPayload({ body, uaPrivateJwk: sub.privJwk, auth: sub.auth });
  assert.equal(out, plaintext);
});

await check("header framing: salt(16) + rs=4096 + idlen=65 + 65-byte key", async () => {
  const sub = await fakeSubscription();
  const { body } = await encryptPushPayload({ p256dh: sub.p256dh, auth: sub.auth, plaintext: "hi" });
  assert.equal(body.slice(16, 20).join(","), "0,0,16,0", "record size = 4096");
  assert.equal(body[20], 65, "keyid length = an uncompressed P-256 point");
  // salt(16)+rs(4)+idlen(1)+key(65)=86 header; +ciphertext(record 3 bytes: 'hi'+0x02)+tag(16)=19 → 105
  assert.equal(body.length, 86 + 3 + 16, "body length = header + ciphertext + GCM tag");
});

await check("deterministic under an injected salt + ephemeral key (same in → same body)", async () => {
  const sub = await fakeSubscription();
  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const a = await encryptPushPayload({ p256dh: sub.p256dh, auth: sub.auth, plaintext: "same", salt, asKeyPair });
  const b = await encryptPushPayload({ p256dh: sub.p256dh, auth: sub.auth, plaintext: "same", salt, asKeyPair });
  assert.equal(bytesToB64u(a.body), bytesToB64u(b.body), "identical inputs → identical body");
});

await check("tamper detection: a flipped ciphertext byte fails the GCM auth tag", async () => {
  const sub = await fakeSubscription();
  const { body } = await encryptPushPayload({ p256dh: sub.p256dh, auth: sub.auth, plaintext: "secret" });
  body[body.length - 1] ^= 0xff; // corrupt the tag
  await assert.rejects(decryptPushPayload({ body, uaPrivateJwk: sub.privJwk, auth: sub.auth }));
});

await check("a different subscription can't decrypt (per-recipient keys)", async () => {
  const alice = await fakeSubscription(), bob = await fakeSubscription();
  const { body } = await encryptPushPayload({ p256dh: alice.p256dh, auth: alice.auth, plaintext: "for alice" });
  await assert.rejects(decryptPushPayload({ body, uaPrivateJwk: bob.privJwk, auth: bob.auth }), "bob's keys must not decrypt alice's message");
});

console.log(`\n${pass} push-encrypt test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
