// RFC 8291 (Message Encryption for Web Push) with the "aes128gcm" content-encoding
// (RFC 8188). PURE — WebCrypto only, no deps, runs on Node and Workers — so it can be
// unit-tested exactly as it runs in the worker. This module ONLY produces the encrypted
// body + headers; wiring it into the push sweep + a SW that reads the payload is a
// SEPARATE later step. Nothing here logs keys or plaintext.
//
// Verification: test-push-encrypt.mjs (a) round-trips (encrypt to a UA public key,
// then decrypt with that UA's private key) — exercising the full ECDH/HKDF/AES-GCM
// path — AND (b) runs a byte-exact KNOWN-ANSWER TEST against RFC 8291 §5's published
// "watermelon" example: injecting the RFC's fixed AS keypair + salt reproduces the
// RFC's exact aes128gcm body, which proves the info-strings, 0x02 delimiter, rs=4096,
// and header framing below are RFC-compliant (not merely self-consistent). The only
// remaining check is a live push-service send returning 201 before production wiring.

const te = new TextEncoder();
const concat = (...arrs) => { const n = arrs.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
export const b64uToBytes = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
export const bytesToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// HKDF(salt, ikm, info, L) = HKDF-Expand(HKDF-Extract(salt, ikm), info, L), SHA-256.
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// A raw 65-byte uncompressed P-256 point (0x04 || X32 || Y32) → an EC JWK.
function rawPointToJwk(raw, d = null) {
  const x = bytesToB64u(raw.slice(1, 33)), y = bytesToB64u(raw.slice(33, 65));
  return d ? { kty: "EC", crv: "P-256", x, y, d, ext: true } : { kty: "EC", crv: "P-256", x, y, ext: true };
}

// Encrypt `plaintext` (string) for a Web Push subscription's keys. Returns the
// aes128gcm body (Uint8Array) + the Content-Encoding header. `salt`/`asKeyPair` are
// injectable ONLY for deterministic tests; production generates both at random.
export async function encryptPushPayload({ p256dh, auth, plaintext, salt = null, asKeyPair = null }) {
  const uaPublic = b64uToBytes(p256dh);       // 65 bytes (0x04||X||Y)
  const authSecret = b64uToBytes(auth);       // 16 bytes
  salt = salt ? (typeof salt === "string" ? b64uToBytes(salt) : salt) : crypto.getRandomValues(new Uint8Array(16));

  const kp = asKeyPair ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); // 65 bytes

  const uaPubKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPubKey }, kp.privateKey, 256)); // 32 bytes

  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info"||0x00||ua_public||as_public, 32)
  const keyInfo = concat(te.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  // RFC 8188 §2.1: CEK/nonce = HKDF(salt, IKM, "Content-Encoding: aes128gcm"/"nonce"||0x00, 16/12)
  const cek = await hkdf(salt, ikm, concat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(te.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  // Single record: plaintext || 0x02 (last-record delimiter); no extra padding.
  const record = concat(te.encode(plaintext), new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record)); // ciphertext||16-byte tag

  // Header (RFC 8188): salt(16) || rs(4 BE, 4096) || idlen(1) || keyid(=as_public) || ciphertext
  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // 4096
  const body = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
  return { body, headers: { "Content-Encoding": "aes128gcm" } };
}

// TEST/VERIFICATION ONLY — the reverse operation a user agent performs. Lets the unit
// test round-trip a message (encrypt → decrypt → original plaintext), proving the
// derivation and framing are self-consistent. The production server never decrypts.
export async function decryptPushPayload({ body, uaPrivateJwk, auth }) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const authSecret = typeof auth === "string" ? b64uToBytes(auth) : auth;

  const uaPriv = await crypto.subtle.importKey("jwk", uaPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const asPubKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asPubKey }, uaPriv, 256));

  const uaPublic = concat(new Uint8Array([0x04]), b64uToBytes(uaPrivateJwk.x), b64uToBytes(uaPrivateJwk.y));
  const keyInfo = concat(te.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, concat(te.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(te.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, ct));
  // strip the last-record delimiter (0x02) and any zero padding
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0x00) end--;
  return new TextDecoder().decode(record.slice(0, end)); // end is the index of 0x02
}
