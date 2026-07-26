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
  // #15: the adopted claim IS a restore from userB's side — reporting "claim"
  // suppressed the merge grant + merge offer, stranding userB's synced workouts
  // on an unreachable anonymous user forever.
  ok("first claim (bound its own user) stays purpose 'claim'", firstConsumed.purpose === "claim");
  ok("second claim (adopted a DIFFERENT user) reports purpose 'restore' so the merge path opens", secondConsumed.purpose === "restore");
  // two claim links minted while unbound, both consumed by the SAME user:
  // the second adopts its own binding — nothing to merge, stays a claim
  const sameA = await requestMagicLink(store, { email: "dup2@t.com", anonUserId: "userA" });
  const sameB = await requestMagicLink(store, { email: "dup2@t.com", anonUserId: "userA" });
  await consumeMagicLink(store, { token: sameA.token });
  ok("duplicate claim by the SAME user stays purpose 'claim' (nothing to merge)", (await consumeMagicLink(store, { token: sameB.token })).purpose === "claim");

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

  // --- merge reassigns SHARES (a distributed share link must not die on restore) ---
  await store.saveUser("share-from", { profile: { cheers_pushed: 2, cheers_seen: 2 } });
  await store.saveUser("share-to", { profile: {} });
  await store.createShare("share-from", "shr-token-1", 1000);
  await store.addShareCheer("shr-token-1"); await store.addShareCheer("shr-token-1");
  await store.reassignUserData("share-from", "share-to");
  ok("merge reassigns the share to the survivor (the link stays alive)", (await store.getShareUserId("shr-token-1")) === "share-to");
  ok("merge keeps the share's cheer tally", (await store.getShareCheers("shr-token-1")) === 2);
  ok("merge: getShareIdForUser follows to the survivor", (await store.getShareIdForUser("share-to")) === "shr-token-1");
  ok("merge deletes the from-user's ghost (no dangling share owner)", (await store.getUser("share-from")) === null);
  // Cloud loop: `to` had no share of its own, so it inherits from's cheers_pushed/
  // cheers_seen watermarks along with the share — otherwise the push sweep and the
  // in-app banner would both read these 2 pre-existing cheers as "new" the moment
  // `to` takes over a share it never had before (a fabricated "2 people cheered
  // you!" right after merging, for cheers `from` already knew about).
  const shareToUser = await store.getUser("share-to");
  ok("merge adopts from's cheers_pushed watermark onto the share it just inherited", shareToUser.profile.cheers_pushed === 2);
  ok("merge adopts from's cheers_seen watermark onto the share it just inherited", shareToUser.profile.cheers_seen === 2);
  // When BOTH already share, the survivor keeps theirs and the merged-away one is dropped (UNIQUE per user).
  await store.saveUser("share-from2", { profile: { cheers_pushed: 9, cheers_seen: 9 } });
  await store.saveUser("share-to2", { profile: { cheers_pushed: 1, cheers_seen: 1 } });
  await store.createShare("share-to2", "shr-keep", 1000);
  await store.createShare("share-from2", "shr-drop", 1000);
  await store.reassignUserData("share-from2", "share-to2");
  ok("merge with both sharing: survivor keeps their own share", (await store.getShareIdForUser("share-to2")) === "shr-keep");
  ok("merge with both sharing: the merged-away share is dropped (no dead link)", (await store.getShareUserId("shr-drop")) === null);
  // The dropped share's watermarks must NOT overwrite the survivor's own live ones
  // (from's cheers never applied to to's still-live share — adopting them would
  // wrongly suppress a real pending cheer push/banner on to's own share).
  const shareTo2User = await store.getUser("share-to2");
  ok("merge with both sharing: survivor's own cheers_pushed is untouched", shareTo2User.profile.cheers_pushed === 1);
  ok("merge with both sharing: survivor's own cheers_seen is untouched", shareTo2User.profile.cheers_seen === 1);

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

  // --- Cloud loop: merge additively carries forward streak-freeze/pause/social
  // state that lived on the user doc (the same "field added, reassignUserData
  // never updated" gap lesson 16 caught for push_subscriptions) ---
  await store.saveUser("mp-to", {
    profile: { following: ["tok-shared", "tok-to-only"], challenge_history: [{ week: "2026-W20", result: "win", my_count: 4, opponent_count: 2 }] },
    streak_freezes: ["2026-W18"],
    pause_history: [{ from: "2026-06-01", to: "2026-06-07" }],
  });
  await store.saveUser("mp-from", {
    profile: {
      following: ["tok-shared", "tok-from-only"],
      challenge_history: [{ week: "2026-W22", result: "lose", my_count: 1, opponent_count: 3 }],
      commitment: { week: "2026-W23", days: ["mon", "wed"] },
      challenge: { id: "live-1", role: "challenger", partner_token: "tok-x", week: "2026-W23", status: "active", created_at: 1 },
    },
    streak_freezes: ["2026-W18", "2026-W19"], // W18 overlaps `to`'s own freeze — must dedup, not double-count
    pause_history: [{ from: "2026-05-01", to: "2026-05-03" }],
  });
  await store.reassignUserData("mp-from", "mp-to");
  const mpTo = await store.getUser("mp-to");
  ok("merge unions streak-freeze weeks and dedups the overlap", mpTo.streak_freezes.length === 2 && new Set(mpTo.streak_freezes).size === 2);
  ok("merge concatenates pause history from both sides", mpTo.pause_history.length === 2);
  ok("merge unions the partner list and dedups the shared token", mpTo.profile.following.length === 3 && new Set(mpTo.profile.following).size === 3);
  ok("merge concatenates challenge history from both sides, newest week first", mpTo.profile.challenge_history.length === 2 && mpTo.profile.challenge_history[0].week === "2026-W22");
  ok("merge adopts from's commitment when to has none", mpTo.profile.commitment?.week === "2026-W23");
  ok("merge deliberately does NOT lift the live challenge slot (two-sided token mirror, out of scope)", mpTo.profile.challenge === undefined);

  // to's OWN commitment/streak-freeze balance must never be clobbered by from's
  await store.saveUser("mp2-to", { profile: { commitment: { week: "2026-W23", days: ["fri"] } }, streak_freezes: ["2026-W10"] });
  await store.saveUser("mp2-from", { profile: { commitment: { week: "2026-W23", days: ["sat"] } }, streak_freezes: ["2026-W10"] });
  await store.reassignUserData("mp2-from", "mp2-to");
  const mp2To = await store.getUser("mp2-to");
  ok("merge keeps to's own commitment over from's", mp2To.profile.commitment.days[0] === "fri");
  ok("merge dedups an identical streak-freeze week instead of duplicating it", mp2To.streak_freezes.length === 1);

  // --- Cloud loop: freeze_pushed_week (Wave 145/146, added after Wave 142's
  // merge audit) must merge too, or a week already pushed-about on `from` can
  // resurface as a fresh "duplicate" push on `to` once merged session/freeze
  // history makes it protectable again on the survivor's timeline ---
  await store.saveUser("mp3-to", { profile: { freeze_pushed_week: "2026-W10" } });
  await store.saveUser("mp3-from", { profile: { freeze_pushed_week: "2026-W16" } });
  await store.reassignUserData("mp3-from", "mp3-to");
  const mp3To = await store.getUser("mp3-to");
  ok("merge adopts from's freeze_pushed_week when it's the more recent (later) week", mp3To.profile.freeze_pushed_week === "2026-W16");

  await store.saveUser("mp4-to", { profile: { freeze_pushed_week: "2026-W20" } });
  await store.saveUser("mp4-from", { profile: { freeze_pushed_week: "2026-W16" } });
  await store.reassignUserData("mp4-from", "mp4-to");
  const mp4To = await store.getUser("mp4-to");
  ok("merge keeps to's own freeze_pushed_week when it's already the more recent week", mp4To.profile.freeze_pushed_week === "2026-W20");

  await store.saveUser("mp5-to", { profile: {} });
  await store.saveUser("mp5-from", { profile: { freeze_pushed_week: "2026-W16" } });
  await store.reassignUserData("mp5-from", "mp5-to");
  const mp5To = await store.getUser("mp5-to");
  ok("merge adopts from's freeze_pushed_week when to has none", mp5To.profile.freeze_pushed_week === "2026-W16");

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
