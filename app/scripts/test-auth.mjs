// Unit tests for the passwordless email backup logic, exercised against the real
// file store (so the store's account/magic-link methods are covered too).
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import { magicLinkEmail } from "../src/email.mjs";
import {
  requestMagicLink, consumeMagicLink, consumeMagicCode, normalizeEmail, canonicalEmail, sha256hex, generateToken, TTL_MS,
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

  // --- Cloud loop: partner_nudge/nudge_pushed_at/nudge_seen_at (Wave 115/119,
  // also added after Wave 142's merge audit) must merge too, or a pending
  // "your training partner nudged you" notification silently vanishes with the
  // deleted `from` row ---
  await store.saveUser("mp6-to", { profile: { partner_nudge: { at: 100 }, nudge_pushed_at: 100, nudge_seen_at: 100 } });
  await store.saveUser("mp6-from", { profile: { partner_nudge: { at: 500 }, nudge_pushed_at: 500, nudge_seen_at: 0 } });
  await store.reassignUserData("mp6-from", "mp6-to");
  const mp6To = await store.getUser("mp6-to");
  ok("merge adopts from's more recent partner_nudge", mp6To.profile.partner_nudge.at === 500);
  ok("merge adopts from's OWN watermarks alongside its nudge, not to's stale ones", mp6To.profile.nudge_pushed_at === 500 && mp6To.profile.nudge_seen_at === 0);

  await store.saveUser("mp7-to", { profile: { partner_nudge: { at: 900 }, nudge_pushed_at: 900, nudge_seen_at: 900 } });
  await store.saveUser("mp7-from", { profile: { partner_nudge: { at: 500 }, nudge_pushed_at: 500, nudge_seen_at: 500 } });
  await store.reassignUserData("mp7-from", "mp7-to");
  const mp7To = await store.getUser("mp7-to");
  ok("merge keeps to's own partner_nudge when it's already the more recent one", mp7To.profile.partner_nudge.at === 900 && mp7To.profile.nudge_seen_at === 900);

  await store.saveUser("mp8-to", { profile: {} });
  await store.saveUser("mp8-from", { profile: { partner_nudge: { at: 500 }, nudge_pushed_at: 500, nudge_seen_at: 0 } });
  await store.reassignUserData("mp8-from", "mp8-to");
  const mp8To = await store.getUser("mp8-to");
  ok("merge adopts from's partner_nudge when to has none", mp8To.profile.partner_nudge.at === 500 && mp8To.profile.nudge_seen_at === 0);
  // --- Cloud loop: nutrition profile stats (user.nutrition — height/neck/
  // waist/hip/bf_pct/activity, the Fuel tab's inputs) must merge too, or a
  // user who set them up on `from` has to re-measure everything post-merge.
  await store.saveUser("mp9-to", { profile: {} });
  await store.saveUser("mp9-from", { profile: {}, nutrition: { height_cm: 180, neck_cm: 38, waist_cm: 85, bf_pct: 15, activity: "active" } });
  await store.reassignUserData("mp9-from", "mp9-to");
  const mp9To = await store.getUser("mp9-to");
  ok("merge adopts from's nutrition stats when to has none", mp9To.nutrition?.height_cm === 180 && mp9To.nutrition?.bf_pct === 15 && mp9To.nutrition?.activity === "active");

  // to's OWN entered stats must never be clobbered by from's — but a field to
  // never set should still be filled in from from's side (per-field, not a
  // whole-object decision).
  await store.saveUser("mp10-to", { profile: {}, nutrition: { height_cm: 170, bf_pct: 20 } });
  await store.saveUser("mp10-from", { profile: {}, nutrition: { height_cm: 190, bf_pct: 12, activity: "sedentary" } });
  await store.reassignUserData("mp10-from", "mp10-to");
  const mp10To = await store.getUser("mp10-to");
  ok("merge keeps to's own height/bf_pct over from's", mp10To.nutrition.height_cm === 170 && mp10To.nutrition.bf_pct === 20);
  ok("merge fills in a field to never set (activity) from from's side", mp10To.nutrition.activity === "sedentary");

  // to already has SOME nutrition object but from has nothing to add — must not throw / must leave to untouched.
  await store.saveUser("mp11-to", { profile: {}, nutrition: { height_cm: 175 } });
  await store.saveUser("mp11-from", { profile: {} });
  await store.reassignUserData("mp11-from", "mp11-to");
  const mp11To = await store.getUser("mp11-to");
  ok("merge with no nutrition on from leaves to's nutrition untouched", mp11To.nutrition.height_cm === 175);

  // --- Wave 206: a pending (unpushed) celebration echo must follow the user
  // through a merge — Wave 201 added the marker after this file's last lesson-16
  // sweep, so a not-yet-delivered "PR!"/milestone push silently died with the
  // deleted `from` row (the exact class partner_nudge above already fixed).
  // Adoption is the pure half tested here; the route-level RE-EARN against the
  // merged history lives in test-routes.mjs (sessions the merge brings in can
  // refute the adopted claim). ---
  await store.saveUser("cel1-to", { profile: {} });
  await store.saveUser("cel1-from", { profile: { celebration: { session_id: "s-1", at: 500, kind: "pr", count: 1 } } });
  await store.reassignUserData("cel1-from", "cel1-to");
  ok("merge adopts from's pending celebration when to has none",
    (await store.getUser("cel1-to")).profile.celebration?.session_id === "s-1");
  // --- Wave 211 (BLOCKERS #6b, option b): the merge TOMBSTONES the from-row
  // instead of deleting it — the app's only destructive primitive is gone. The
  // row survives with an audit marker, but every reader sees it as absent.
  ok("merge leaves a tombstone row (audit trail), not a deletion",
    JSON.parse(readFileSync(path, "utf8")).users["cel1-from"]?._merged_into === "cel1-to");
  ok("the tombstoned user reads as absent via getUser", (await store.getUser("cel1-from")) === null);
  ok("updateUser on a tombstone is a null no-op", (await store.updateUser("cel1-from", (u) => u)) === null);

  await store.saveUser("cel2-to", { profile: { celebration: { session_id: "s-mine", at: 900, kind: "milestone", count: 3 } } });
  await store.saveUser("cel2-from", { profile: { celebration: { session_id: "s-theirs", at: 500, kind: "pr", count: 1 } } });
  await store.reassignUserData("cel2-from", "cel2-to");
  ok("merge never stomps to's own pending celebration with from's",
    (await store.getUser("cel2-to")).profile.celebration?.session_id === "s-mine");

  await store.saveUser("cel3-to", { profile: {} });
  await store.saveUser("cel3-from", { profile: { celebration: { session_id: "s-old", at: 500, kind: "pr", count: 1, pushed: true } } });
  await store.reassignUserData("cel3-from", "cel3-to");
  ok("merge never adopts an already-pushed celebration (that notification is out)",
    (await store.getUser("cel3-to")).profile.celebration == null);

  await store.saveUser("cel4-to", { profile: { celebration: { session_id: "s-done", at: 900, kind: "pr", count: 1, pushed: true } } });
  await store.saveUser("cel4-from", { profile: { celebration: { session_id: "s-new", at: 500, kind: "milestone", count: 1 } } });
  await store.reassignUserData("cel4-from", "cel4-to");
  ok("merge adopts from's pending celebration over to's already-delivered one",
    (await store.getUser("cel4-to")).profile.celebration?.session_id === "s-new");

  // --- Wave 209: the disclaimer acknowledgement follows the person through a
  // merge — adopt from's stamp only when the survivor has none (pre-209 rows). ---
  await store.saveUser("ack1-to", { profile: {} });
  await store.saveUser("ack1-from", { profile: { disclaimer_ack: { v: 1, at: "2026-08-14T00:00:00.000Z" } } });
  await store.reassignUserData("ack1-from", "ack1-to");
  ok("merge adopts from's disclaimer_ack when to has none",
    (await store.getUser("ack1-to")).profile.disclaimer_ack?.v === 1);

  await store.saveUser("ack2-to", { profile: { disclaimer_ack: { v: 1, at: "2026-01-01T00:00:00.000Z" } } });
  await store.saveUser("ack2-from", { profile: { disclaimer_ack: { v: 1, at: "2026-08-14T00:00:00.000Z" } } });
  await store.reassignUserData("ack2-from", "ack2-to");
  ok("merge keeps to's own (earlier) disclaimer_ack",
    (await store.getUser("ack2-to")).profile.disclaimer_ack?.at === "2026-01-01T00:00:00.000Z");

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

  // --- #kind (W269): which situation a request is in decides what the EMAIL says ---
  // Owner report: "it asked me to sign up with my email to save progress but then
  // sent me a link to restore my progress." Every request for an already-bound email
  // was a "restore" — even a device backing up its own fresh workout, even the bound
  // user asking again (which then minted a merge grant nothing could ever use).
  for (const u of ["kindA", "kindB", "kindC"]) await store.saveUser(u, { profile: {} });
  const kNew = await requestMagicLink(store, { email: "kind@t.com", anonUserId: "kindA" });
  ok("#kind a never-seen email from a device is 'new' (stored as a claim)", kNew.kind === "new" && kNew.purpose === "claim");
  await consumeMagicLink(store, { token: kNew.token }); // kind@t.com → kindA
  const kRe = await requestMagicLink(store, { email: "kind@t.com", anonUserId: "kindA" });
  ok("#reconfirm the account's own user asking again is 'reconfirm', stored as a CLAIM", kRe.kind === "reconfirm" && kRe.purpose === "claim" && kRe.boundUserId === "kindA");
  ok("#reconfirm …so consuming it stays a claim (no merge grant for a merge that can't happen)", (await consumeMagicLink(store, { token: kRe.token })).purpose === "claim");
  const kMerge = await requestMagicLink(store, { email: "kind@t.com", anonUserId: "kindB" });
  ok("#kind another device's anonymous user asking for a bound email is 'merge' (a restore of the account)",
    kMerge.kind === "merge" && kMerge.purpose === "restore" && kMerge.boundUserId === "kindA");
  await store.saveAccount("other@t.com", "kindC", new Date().toISOString());
  const kSwitch = await requestMagicLink(store, { email: "kind@t.com", anonUserId: "kindC" });
  ok("#kind a device already signed in to a DIFFERENT account is 'switch' (an account is never merged away)", kSwitch.kind === "switch" && kSwitch.purpose === "restore");
  const kSignin = await requestMagicLink(store, { email: "kind@t.com" });
  ok("#kind no device user at all is 'signin'", kSignin.kind === "signin" && kSignin.purpose === "restore");

  // --- #email-copy (W269): the mail says what tapping it will actually do (lesson 60) ---
  const mlink = "https://x.test/verify.html?token=abc";
  const mNew = magicLinkEmail({ link: mlink, kind: "new" });
  ok("#email-copy new: confirm your email to save your progress", mNew.subject === "Confirm your email to save your progress");
  const mRe = magicLinkEmail({ link: mlink, kind: "reconfirm" });
  ok("#email-copy reconfirm: says the progress is already saved to this address", mRe.subject === "Confirm your email" && /already saved to this email/.test(mRe.html));
  const mMerge = magicLinkEmail({ link: mlink, kind: "merge" });
  ok("#email-copy merge: 'You already have an account' — and the word 'restore' appears nowhere",
    mMerge.subject === "You already have a Hypertrophy Bible account" && !/restore/i.test(mMerge.subject + mMerge.html));
  ok("#email-copy merge: promises only what the merge does — this phone's workouts come along, the saved plan comes back",
    /workouts/.test(mMerge.html) && /saved plan/.test(mMerge.html));
  const mSwitch = magicLinkEmail({ link: mlink, kind: "switch" });
  ok("#email-copy switch: says the phone switches accounts and promises no merge", /switches this phone/.test(mSwitch.html) && !/workouts/.test(mSwitch.html));
  const mSignin = magicLinkEmail({ link: mlink, kind: "signin" });
  ok("#email-copy signin: sign-in copy", mSignin.subject === "Sign in to your Hypertrophy Bible account");
  const mPlan = magicLinkEmail({ link: mlink, kind: "new", plan: { name: "PPL", sessions: [{ name: "Push <A>", exercises: [{ name: "Bench", sets: 3, rep_range: "8-12" }] }] } });
  ok("#email-copy a backup that carries the plan keeps the plan-screen's 'Your training week' promise (escaped)",
    mPlan.subject === "Your training week" && /Bench — 3 × 8-12/.test(mPlan.html) && mPlan.html.includes("Push &lt;A&gt;"));
  ok("#email-copy every kind carries the link", [mNew, mRe, mMerge, mSwitch, mSignin, mPlan].every((m) => m.html.includes(mlink)));

  const withCode = ["new", "reconfirm", "merge", "switch", "signin"].map((kind) => magicLinkEmail({ link: mlink, code: "482913", kind }));
  ok("#email-copy every kind carries the code BEFORE the button (a Home-Screen user reads it first)",
    withCode.every((m) => m.html.includes("482 913") && m.html.indexOf("482 913") < m.html.indexOf(mlink)));
  ok("#email-copy the code never rides in a subject line", withCode.every((m) => !m.subject.includes("482")));
  // W270b review: the button and the code are ONE credential (a resend also replaces
  // the code), so "each work once" was false; and a 6-digit code that hands out the
  // account is the classic phishing ask, so the mail must say never to share it.
  ok("#email-copy says the truth about the credential: either one, once, and a resend replaces the code",
    withCode.every((m) => /either one, once, within 30 minutes/.test(m.html) && /replaces this code/.test(m.html) && !/each work once/.test(m.html)));
  ok("#email-copy every code comes with 'never share it — we'll never ask'",
    withCode.every((m) => /Never share this code/.test(m.html) && /never ask you for it/.test(m.html)));

  // --- #code (W270): a 6-digit code in every magic-link email, typed into the app. On
  // iPhone an emailed link opens in Safari, whose storage is separate from the
  // Home-Screen app, so a link alone can never sign the app itself in.
  for (const u of ["codeA", "codeB"]) await store.saveUser(u, { profile: {} });
  const c1 = await requestMagicLink(store, { email: "Code+x@T.com", anonUserId: "codeA" });
  ok("#code every link carries a 6-digit code", /^\d{6}$/.test(c1.code ?? ""));
  const c2 = await requestMagicLink(store, { email: "code@t.com", anonUserId: "codeA" }); // same canonical address, newer
  ok("#code an older email's code is dead once a newer one exists — only the newest counts",
    c1.code === c2.code || (await consumeMagicCode(store, { email: "code@t.com", code: c1.code, ip: "9.9.9.1" })).error === "invalid");
  const viaCode = await consumeMagicCode(store, { email: "CODE@t.com", code: `${c2.code.slice(0, 3)} ${c2.code.slice(3)}`, ip: "9.9.9.1" });
  ok("#code the right code (any case of the address, a space allowed) consumes the link", viaCode.user_id === "codeA" && viaCode.purpose === "claim");
  ok("#code …and spends the TOKEN with it — one link, two doors, single use", (await consumeMagicLink(store, { token: c2.token })).error === "used");
  const c3 = await requestMagicLink(store, { email: "code@t.com", anonUserId: "codeB" });
  await consumeMagicLink(store, { token: c3.token });
  ok("#code a code whose link its token already spent answers 'used'", (await consumeMagicCode(store, { email: "code@t.com", code: c3.code, ip: "9.9.9.1" })).error === "used");
  ok("#code an unknown address and a wrong code get the identical answer", (await consumeMagicCode(store, { email: "nobody@t.com", code: "123456", ip: "9.9.9.5" })).error === "invalid");
  ok("#code a malformed code is just 'invalid'", (await consumeMagicCode(store, { email: "code@t.com", code: "12ab56", ip: "9.9.9.5" })).error === "invalid");
  // Lockouts are checked BEFORE comparing: a locked address can't be probed even with the right code.
  await store.saveUser("lockU", { profile: {} });
  const lk = await requestMagicLink(store, { email: "lock@t.com", anonUserId: "lockU" });
  const wrong = lk.code === "000000" ? "000001" : "000000";
  const lkBefore = { email: await store.countRecentLinks(canonicalEmail("lock@t.com"), 0), ip: await store.countRecentByIp("9.9.9.2", 0) };
  for (let i = 0; i < 10; i++) await consumeMagicCode(store, { email: "lock@t.com", code: wrong, ip: "9.9.9.2" });
  ok("#code after 10 wrong codes in a day the RIGHT code is refused too (lock before compare)",
    (await consumeMagicCode(store, { email: "lock@t.com", code: lk.code, ip: "9.9.9.6" })).error === "too-many-attempts");
  ok("#code failure markers never spend the address's email budget or the IP's link budget",
    (await store.countRecentLinks(canonicalEmail("lock@t.com"), 0)) === lkBefore.email && (await store.countRecentByIp("9.9.9.2", 0)) === lkBefore.ip);
  ok("#code …and the emailed LINK still works while the code door is locked", (await consumeMagicLink(store, { token: lk.token })).user_id === "lockU");
  await store.saveUser("ipU", { profile: {} });
  const ipLink = await requestMagicLink(store, { email: "ipvictim@t.com", anonUserId: "ipU" });
  for (let i = 0; i < 30; i++) await consumeMagicCode(store, { email: `spray${i}@t.com`, code: "123456", ip: "9.9.9.3" });
  ok("#code 30 failures from one IP in an hour lock that IP out, whatever address it tries next",
    (await consumeMagicCode(store, { email: "ipvictim@t.com", code: ipLink.code, ip: "9.9.9.3" })).error === "too-many-attempts");
  ok("#code …without locking the address for anyone else", (await consumeMagicCode(store, { email: "ipvictim@t.com", code: ipLink.code, ip: "9.9.9.4" })).user_id === "ipU");
  // --- #code-race (W270b, review finding): the lockout used to be check-then-act — every
  // request read the failure count BEFORE any request wrote its marker, so one parallel
  // burst of 500 wrong codes + the real one signed an attacker in (reproduced). A try is
  // now RESERVED (inserted) before anything is compared and the count includes it, so no
  // interleaving lets more than the cap's worth of tries reach the comparison.
  await store.saveUser("raceU", { profile: {} });
  await store.saveAccount("race@t.com", "raceU", new Date().toISOString());
  const raceLink = await requestMagicLink(store, { email: "race@t.com" }); // attacker-initiated signin
  const raceWrong = (i) => String((Number(raceLink.code) + 1 + i) % 1e6).padStart(6, "0");
  const burst = await Promise.all([...Array.from({ length: 50 }, (_, i) => consumeMagicCode(store, { email: "race@t.com", code: raceWrong(i), ip: `7.7.${i}.1` })),
    consumeMagicCode(store, { email: "race@t.com", code: raceLink.code, ip: "7.7.99.1" })]);
  ok("#code-race a parallel burst can't buy more tries than the cap: at most 10 answers aren't 'too-many-attempts'",
    burst.filter((r) => r.error !== "too-many-attempts").length <= 10);
  ok("#code-race …so the real code at the end of a 51-try burst does NOT sign anyone in", !burst.at(-1).user_id);
  // A refused try must leave NOTHING behind: magic_links is never pruned, so a locked
  // door that still wrote a row per request let one IP grow the table without bound.
  for (let i = 0; i < 40; i++) await consumeMagicCode(store, { email: "spam@t.com", code: "123456", ip: "7.8.9.10" });
  ok("#code-race a door spammed 40 times from one IP keeps at most its caps' worth of rows (10 address, 30 IP)",
    (await store.countRecentLinks("codetry:spam@t.com", 0)) <= 10 && (await store.countRecentLinks("codetry-ip:7.8.9.10", 0)) <= 30);

  // --- #code-windows (W270b): both lockout windows pinned with literal times (lesson 42) —
  // shrinking the address's 24h to 1h, or stretching the IP's 1h to 24h, was invisible.
  const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
  await store.saveUser("winU", { profile: {} });
  const winLink = await requestMagicLink(store, { email: "win@t.com", anonUserId: "winU", now: T0 });
  for (let i = 0; i < 10; i++) await consumeMagicCode(store, { email: "win@t.com", code: winLink.code === "111111" ? "222222" : "111111", now: T0 + i * 1000 });
  const winRight = (at) => consumeMagicCode(store, { email: "win@t.com", code: winLink.code, now: at });
  ok("#code-windows the address stays locked 2 hours later…", (await winRight(T0 + 2 * 3600e3)).error === "too-many-attempts");
  ok("#code-windows …and 23 hours later", (await winRight(T0 + 23 * 3600e3)).error === "too-many-attempts");
  const winFresh = await requestMagicLink(store, { email: "win@t.com", anonUserId: "winU", now: T0 + 25 * 3600e3 });
  ok("#code-windows …and a fresh code works once the day has passed", (await consumeMagicCode(store, { email: "win@t.com", code: winFresh.code, now: T0 + 25 * 3600e3 + 1000 })).user_id === "winU");
  for (let i = 0; i < 30; i++) await consumeMagicCode(store, { email: `ipwin${i}@t.com`, code: "123456", ip: "8.8.1.1", now: T0 + i * 1000 });
  ok("#code-windows an IP that spent its 30 tries is still locked 59 minutes later",
    (await consumeMagicCode(store, { email: "ipwin-x@t.com", code: "123456", ip: "8.8.1.1", now: T0 + 59 * 60e3 })).error === "too-many-attempts");
  ok("#code-windows …and free again 61 minutes later",
    (await consumeMagicCode(store, { email: "ipwin-y@t.com", code: "123456", ip: "8.8.1.1", now: T0 + 61 * 60e3 })).error === "invalid");

  // --- #code-canonical (W270b): the code is looked up under the CANONICAL address, the
  // same bucket the request saved it in — a dotted or +aliased Gmail must still work.
  // Both directions, each with an address whose canonical form DIFFERS from what is typed
  // (a fixture that types the canonical form itself can't tell canonical keying from
  // normalized keying — the first draft of this test survived exactly that tamper).
  for (const u of ["canonU", "canonW", "canonV"]) await store.saveUser(u, { profile: {} });
  const canonSaved = await requestMagicLink(store, { email: "First.Last+hb@gmail.com", anonUserId: "canonU" });
  ok("#code-canonical requested as First.Last+hb@gmail.com, accepted as firstlast@gmail.com (save keys the canonical form)",
    (await consumeMagicCode(store, { email: "firstlast@gmail.com", code: canonSaved.code })).user_id === "canonU");
  const canonPlain = await requestMagicLink(store, { email: "second@gmail.com", anonUserId: "canonW" });
  ok("#code-canonical requested as second@gmail.com, accepted as Sec.Ond+x@gmail.com (lookup keys the canonical form)",
    (await consumeMagicCode(store, { email: "Sec.Ond+x@gmail.com", code: canonPlain.code })).user_id === "canonW");
  const canonOld = await requestMagicLink(store, { email: "nl@t.com", anonUserId: "canonV" });
  const canonNew = await requestMagicLink(store, { email: "nl+x@t.com", anonUserId: "canonV" });
  ok("#code-canonical newest-only spans aliases: the plain address's older code is dead once an alias asked again",
    canonOld.code === canonNew.code || (await consumeMagicCode(store, { email: "NL+y@t.com", code: canonOld.code })).error === "invalid");
  ok("#code-canonical …and the newer code is accepted under a third spelling", (await consumeMagicCode(store, { email: "NL+y@t.com", code: canonNew.code })).user_id === "canonV");

  // --- #code-expired (W270b): a code past its 30 minutes reads exactly like a wrong one.
  // Telling "expired" apart would reveal that an address had a code minted — and an
  // attacker can mint one only for an address that HAS an account (a no-user_id request
  // for an unknown address creates nothing), which would make this door an account probe.
  await store.saveUser("expU", { profile: {} });
  await store.saveAccount("exp@t.com", "expU", new Date().toISOString());
  const expLink = await requestMagicLink(store, { email: "exp@t.com", now: T0 });
  ok("#code-expired the right code 31 minutes later is just 'invalid' (no existence oracle)",
    (await consumeMagicCode(store, { email: "exp@t.com", code: expLink.code, now: T0 + 31 * 60e3 })).error === "invalid");
  ok("#code-expired …the same answer an address with no account at all gets",
    (await consumeMagicCode(store, { email: "never-here@t.com", code: expLink.code, now: T0 + 31 * 60e3 })).error === "invalid");

  // One consume core for both doors: a restore mints its merge grant there, and a grant
  // (or any non-link row) can never be spent as a link.
  const gReq = await requestMagicLink(store, { email: "code@t.com" });
  const gCons = await consumeMagicLink(store, { token: gReq.token });
  ok("#code a restore mints its merge grant inside the shared consume core", gCons.purpose === "restore" && typeof gCons.merge_grant === "string");
  ok("#code a merge grant can never be spent at the link door", (await consumeMagicLink(store, { token: gCons.merge_grant })).error === "invalid");

  console.log(`\n${pass} auth test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
