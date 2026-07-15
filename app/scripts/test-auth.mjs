// Unit tests for the passwordless email backup logic, exercised against the real
// file store (so the store's account/magic-link methods are covered too).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import {
  requestMagicLink, consumeMagicLink, normalizeEmail, canonicalEmail, sha256hex, generateToken, TTL_MS,
} from "../src/auth.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)); };

const path = join(tmpdir(), `hb-auth-test-${process.pid}.json`);
const store = createFileStore(path);

try {
  // --- helpers ---
  ok("normalizeEmail trims + lowercases", normalizeEmail("  Foo@Bar.COM ") === "foo@bar.com");
  ok("normalizeEmail rejects junk", normalizeEmail("not-an-email") === null);
  const { token, tokenHash } = await generateToken();
  ok("token hash matches sha256hex(token)", (await sha256hex(token)) === tokenHash);
  ok("two tokens differ", (await generateToken()).token !== (await generateToken()).token);

  // --- claim: a new email binds to the caller's anonymous user_id ---
  const anon = "anon-user-1";
  const claim = await requestMagicLink(store, { email: "Claim@T.com", anonUserId: anon });
  ok("claim: purpose is 'claim'", claim.purpose === "claim");
  ok("claim: binds the anon user_id", claim.boundUserId === anon);
  ok("claim: email normalized", claim.email === "claim@t.com");

  const consumed = await consumeMagicLink(store, { token: claim.token });
  ok("claim consume returns the anon user_id", consumed.user_id === anon);
  ok("claim consume returns the email", consumed.email === "claim@t.com");
  ok("account now exists", (await store.getAccountByEmail("claim@t.com"))?.user_id === anon);

  // --- single use ---
  const reused = await consumeMagicLink(store, { token: claim.token });
  ok("a consumed link can't be reused", reused.error === "used");

  // --- restore: existing email hands back its user_id to a fresh device ---
  const restore = await requestMagicLink(store, { email: "claim@t.com" }); // no anon id (new device)
  ok("restore: purpose is 'restore'", restore.purpose === "restore");
  ok("restore: binds the account's user_id", restore.boundUserId === anon);
  const restored = await consumeMagicLink(store, { token: restore.token });
  ok("restore consume returns the account user_id", restored.user_id === anon);

  // --- expiry ---
  const T = 1_000_000_000_000;
  const exp = await requestMagicLink(store, { email: "expire@t.com", anonUserId: "u2", now: T });
  const expResult = await consumeMagicLink(store, { token: exp.token, now: T + TTL_MS + 1 });
  ok("an expired link is rejected", expResult.error === "expired");
  const inTime = await requestMagicLink(store, { email: "intime@t.com", anonUserId: "u3", now: T });
  ok("a link within TTL is accepted", (await consumeMagicLink(store, { token: inTime.token, now: T + TTL_MS - 1 })).user_id === "u3");

  // --- validation + abuse ---
  ok("invalid email is rejected", (await requestMagicLink(store, { email: "nope", anonUserId: "u" })).error === "invalid-email");
  ok("bad token is invalid", (await consumeMagicLink(store, { token: "deadbeef" })).error === "invalid");
  ok("restore for unknown email with no anon id -> no-user", (await requestMagicLink(store, { email: "ghost@t.com" })).error === "no-user");

  let last;
  for (let i = 0; i < 6; i++) last = await requestMagicLink(store, { email: "rate@t.com", anonUserId: "u4" });
  ok("6th request for one email in the window is rate-limited", last.error === "rate-limited");

  // --- abuse hardening (from adversarial review) ---
  ok("canonicalEmail strips gmail +tag and dots", canonicalEmail("v.i.c.t.i.m+promo@gmail.com") === "victim@gmail.com");
  ok("canonicalEmail strips +tag but keeps dots on non-gmail", canonicalEmail("a.b+x@outlook.com") === "a.b@outlook.com");

  // +tag variants of one inbox share a bucket -> can't bypass the per-email cap
  let bomb;
  for (let i = 0; i < 6; i++) bomb = await requestMagicLink(store, { email: `victim+${i}@gmail.com`, anonUserId: "b" });
  ok("gmail +tag variants can't bypass the per-email cap (email bombing)", bomb.error === "rate-limited");

  // per-IP cap: distinct emails from one IP are still capped
  let ipcap;
  for (let i = 0; i < 21; i++) ipcap = await requestMagicLink(store, { email: `ipuser${i}@x.com`, anonUserId: "i", ip: "10.9.9.9" });
  ok("21st request from one IP is rate-limited", ipcap.error === "rate-limited");

  // first-claim-wins: a duplicate claim of a still-unbound email adopts the first, not clobbers it
  const dupA = await requestMagicLink(store, { email: "dup@t.com", anonUserId: "userA" });
  const dupB = await requestMagicLink(store, { email: "dup@t.com", anonUserId: "userB" });
  const firstConsumed = await consumeMagicLink(store, { token: dupA.token });
  const secondConsumed = await consumeMagicLink(store, { token: dupB.token });
  ok("first claim binds userA", firstConsumed.user_id === "userA");
  ok("second claim of same email ADOPTS userA (no clobber)", secondConsumed.user_id === "userA");
  ok("account still points at the first claimant", (await store.getAccountByEmail("dup@t.com")).user_id === "userA");

  console.log(`\n${pass} auth test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
