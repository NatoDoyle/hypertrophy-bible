// Verification for the RFC 8291 push-payload encryption (src/push-encrypt.mjs).
// ROUND-TRIP: encrypt a message to a freshly-generated "subscription" public key,
// then decrypt with that subscription's private key. This exercises the FULL path —
// ECDH (both sides must derive the same secret), HKDF (both must derive the same
// CEK/nonce from the RFC info-strings), AES-GCM with its auth tag, and the salt +
// header byte-framing. Any inconsistency in any of those fails the round-trip.
// This suite ALSO includes a byte-exact RFC 8291 §5 known-answer test (below) that
// injects the RFC's fixed AS keypair + salt and asserts the module reproduces the
// spec's published encrypted body — proving RFC-compliance of the constants, not just
// self-consistency. A real push-service send (201) remains the final gate before wiring.
import assert from "node:assert";
import { encryptPushPayload, decryptPushPayload, bytesToB64u, b64uToBytes } from "../src/push-encrypt.mjs";

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

// RFC 8291 §5 KNOWN-ANSWER TEST — the compliance check the round-trips above can't give.
// A round-trip only proves the module agrees with ITSELF; it would still pass if an
// info-string, the record delimiter, or the header framing were subtly non-standard.
// This injects the RFC's fixed application-server keypair + salt (the only two random
// inputs in production) and asserts the module reproduces the RFC's exact aes128gcm
// body BYTE-FOR-BYTE. Match ⇒ the IKM/"WebPush: info", CEK/nonce "Content-Encoding:"
// strings, the 0x02 last-record delimiter, rs=4096, and the salt‖rs‖idlen‖keyid‖ct
// framing are all RFC-compliant — the module can be trusted against real push services.
//
// Vectors are transcribed VERBATIM from RFC 8291 Section 5 "Push Message Encryption
// Example" and cross-checked character-for-character against BOTH rfc-editor.org and
// datatracker.ietf.org. (The famous "watermelon" example; do not "fix" any value.)
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ua_public: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  as_public: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  as_private: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  // The push message body the RFC arrives at (salt‖rs‖idlen‖as_public‖ciphertext+tag).
  expected_body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

await check("RFC 8291 §5 known-answer: reproduces the spec's exact encrypted body byte-for-byte", async () => {
  // Rebuild the RFC's application-server keypair: private key from its `d` scalar
  // (with x/y from the public point, as WebCrypto's JWK import requires), public key
  // from the raw 65-byte point. encryptPushPayload consumes { publicKey, privateKey }.
  const asRaw = b64uToBytes(RFC8291.as_public);
  const asJwk = { kty: "EC", crv: "P-256", x: bytesToB64u(asRaw.slice(1, 33)), y: bytesToB64u(asRaw.slice(33, 65)), d: RFC8291.as_private, ext: true };
  const privateKey = await crypto.subtle.importKey("jwk", asJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", asRaw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const { body, headers } = await encryptPushPayload({
    p256dh: RFC8291.ua_public, auth: RFC8291.auth, plaintext: RFC8291.plaintext,
    salt: RFC8291.salt, asKeyPair: { publicKey, privateKey },
  });
  assert.equal(headers["Content-Encoding"], "aes128gcm");
  assert.equal(bytesToB64u(body), RFC8291.expected_body, "module output must equal RFC 8291 §5's published body");
});

console.log(`\n${pass} push-encrypt test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
