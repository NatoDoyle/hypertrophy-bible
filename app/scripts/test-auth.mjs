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
  // The anon user always exists (onboarding created it) before backup; consume
  // now guards against binding to a nonexistent user, so tests must create them.
  const anon = "anon-user-1";
  for (const u of [anon, "u3", "userA", "userB"]) await store.saveUser(u, { profile: {} });
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

  // --- merge-on-restore (store level) ---
  await store.saveUser("acct-user", { profile: {} });
  await store.saveUser("anon-dev", { profile: {} });
  await store.addSession("anon-dev", { session_id: "s-1", date: "2026-07-01", sets: [] });
  await store.addSession("anon-dev", { session_id: "s-2", date: "2026-07-03", sets: [] });
  await store.addBodyweight("anon-dev", { date: "2026-07-01", kg: 80 });
  const moved = await store.reassignUserData("anon-dev", "acct-user");
  ok("merge moves sessions", moved.sessions === 2 && (await store.listSessions("acct-user")).length === 2);
  ok("merge moves bodyweights", moved.bodyweights === 1 && (await store.listBodyweights("acct-user")).length === 1);
  ok("merge deletes the from-user shell", (await store.getUser("anon-dev")) === null);
  ok("from-user has nothing left", (await store.listSessions("anon-dev")).length === 0);
  ok("getAccountByUserId finds a bound account", (await store.getAccountByUserId(anon))?.email === "claim@t.com");
  ok("getAccountByUserId is null for anonymous users", (await store.getAccountByUserId("acct-user")) === null);

  // consume must refuse to bind an account to a user that was deleted (e.g. merged
  // away) — otherwise the account points at a ghost and the app can't load.
  await store.saveUser("ghost-user", { profile: {} });
  const ghostLink = await requestMagicLink(store, { email: "ghostbind@t.com", anonUserId: "ghost-user" });
  await store.reassignUserData("ghost-user", "acct-user"); // deletes ghost-user
  ok("consuming a link bound to a deleted user is rejected", (await consumeMagicLink(store, { token: ghostLink.token })).error === "invalid");

  // --- Wave 3: merge moves custom exercises + checkins, not just sessions/bw ---
  await store.saveUser("m-to", { profile: {}, custom_exercises: [{ id: "custom-a", name: "A" }] });
  await store.saveUser("m-from", { profile: {}, custom_exercises: [{ id: "custom-b", name: "B" }, { id: "custom-a", name: "dupe" }] });
  await store.addCheckin("m-from", { date: "2026-07-10", energy: 4 });
  await store.addCheckin("m-to", { date: "2026-07-11", energy: 3 });
  await store.reassignUserData("m-from", "m-to");
  const mTo = await store.getUser("m-to");
  ok("merge migrates custom exercises (dedup by id)", mTo.custom_exercises.length === 2 && mTo.custom_exercises.some((x) => x.id === "custom-b"));
  ok("merge keeps the target's copy on an id collision", mTo.custom_exercises.find((x) => x.id === "custom-a").name === "A");
  ok("merge moves check-ins", (await store.listCheckins("m-to")).length === 2);
  ok("merge deletes the from-user's check-ins", (await store.listCheckins("m-from")).length === 0);

  // --- It2/W6: the merge respects idempotency invariants ---
  await store.saveUser("p-to", { profile: {} });
  await store.saveUser("p-from", { profile: {} });
  await store.addSession("p-to", { session_id: "dup-1", date: "2026-07-01", sets: [] });
  await store.addSession("p-from", { session_id: "dup-1", date: "2026-07-01", sets: [] }); // same id on both (replayed queue)
  await store.addBodyweight("p-to", { date: "2026-07-02", kg: 80 });
  await store.addBodyweight("p-from", { date: "2026-07-02", kg: 99 });
  await store.reassignUserData("p-from", "p-to");
  ok("merge skips duplicate session_ids (no double-counted volume)", (await store.listSessions("p-to")).length === 1);
  const bwAfter = await store.listBodyweights("p-to");
  ok("merge keeps ONE weigh-in per day (the target's)", bwAfter.length === 1 && bwAfter[0].kg === 80);

  // --- Wave 3: bodyweight is one-per-day (a replayed offline log can't dup) ---
  await store.saveUser("bw-u", { profile: {} });
  await store.addBodyweight("bw-u", { date: "2026-07-12", kg: 80 });
  await store.addBodyweight("bw-u", { date: "2026-07-12", kg: 80 }); // retry
  ok("duplicate same-day bodyweight replaces, not appends", (await store.listBodyweights("bw-u")).length === 1);

  // --- Wave 3: single-use magic-link flip is atomic (true once, false after) ---
  await store.createMagicLink({ token_hash: "tok-x", email: "x@t.com", rl_key: "x@t.com", user_id: "bw-u", purpose: "merge-grant", expires_at: Date.now() + 6e5, used: 0, created_at: Date.now() });
  ok("markMagicLinkUsed returns true the first time", (await store.markMagicLinkUsed("tok-x")) === true);
  ok("markMagicLinkUsed returns false the second time", (await store.markMagicLinkUsed("tok-x")) === false);

  // --- Wave 3: updateUser is a guarded read-modify-write ---
  const upd = await store.updateUser("bw-u", (u) => { u.paused = { from: "2026-07-12" }; return u; });
  ok("updateUser applies the mutation", upd.paused?.from === "2026-07-12");
  ok("updateUser on a missing user returns null", (await store.updateUser("nope", (u) => u)) === null);

  console.log(`\n${pass} auth test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
