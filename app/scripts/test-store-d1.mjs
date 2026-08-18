// Parity tests: src/store.mjs (file, local) and src/store-d1.mjs (D1, prod)
// implement the SAME async interface and CLAUDE.md requires they behave
// identically — "a method or dedup behavior in one but not the other is a
// bug." Until now nothing exercised store-d1.mjs directly (store-d1.mjs's own
// header comment on reassignUserData: "reviewed by hand for parity" — see
// PR that added merge-profile.mjs). This runs the two stores side by side —
// the D1 store backed by real SQLite via node:sqlite (the same engine D1
// itself runs on, wrapped by scripts/d1-shim.mjs) — through an IDENTICAL
// sequence of operations per scenario and asserts they land on the same
// observable state, not just "looks right by inspection."
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import { createD1Store } from "../src/store-d1.mjs";
import { createD1Shim, sqliteAvailable } from "./d1-shim.mjs";

// This suite is the ONLY coverage of store-d1.mjs — the store production actually
// runs on. It used to print "SKIPPED" and exit 0 on Node < 22.5 (no node:sqlite),
// so on a machine running Node 20 the app gate went green having tested the prod
// store not at all: a maintainer editing store-d1.mjs got a full-green `npm test`
// as evidence about code no assertion had touched. A suite that skips on exit 0
// reads as a suite that passed.
//
// So it no longer skips — it RE-EXECS itself under a Node that has node:sqlite.
// Coverage, rather than a nag the reader learns to scroll past. Only if that is
// impossible (offline, no npx) does it fail, loudly, naming the one command that
// runs it. HB_D1_NO_REEXEC=1 opts out for a caller that genuinely cannot.
if (!(await sqliteAvailable())) {
  const NODE_WITH_SQLITE = "node@25";
  if (process.env.HB_D1_NO_REEXEC === "1") {
    console.error(`store-d1 parity suite CANNOT RUN — node:sqlite needs Node >= 22.5 (current ${process.version}).`);
    console.error(`This suite is the only coverage of the PRODUCTION store, so this is a failure, not a skip.`);
    console.error(`Run: npx --yes ${NODE_WITH_SQLITE} app/scripts/test-store-d1.mjs`);
    process.exit(1);
  }
  const { spawnSync } = await import("node:child_process");
  console.log(`store-d1 parity suite: node:sqlite needs Node >= 22.5 (current ${process.version}) — re-running under ${NODE_WITH_SQLITE}.`);
  const here = fileURLToPath(import.meta.url);
  const r = spawnSync("npx", ["--yes", NODE_WITH_SQLITE, here], { stdio: "inherit", env: { ...process.env, HB_D1_NO_REEXEC: "1" } });
  if (r.error || r.status == null) {
    console.error(`store-d1 parity suite COULD NOT RE-EXEC (${r.error?.message ?? "no exit status"}).`);
    console.error(`This suite is the only coverage of the PRODUCTION store, so this is a failure, not a skip.`);
    console.error(`Run it yourself with: npx --yes ${NODE_WITH_SQLITE} app/scripts/test-store-d1.mjs`);
    process.exit(1);
  }
  process.exit(r.status);
}

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)); };
const same = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b));
// Order-independent comparison for lists whose row order the store interface
// doesn't promise to match (only listSessions/listBodyweights/listCheckins/
// listNutritionLog promise an ORDER BY; things like listPushSubscriptions do not).
const sameSet = (name, a, b, keyFn) => {
  const norm = (arr) => [...arr].map((x) => JSON.stringify(x)).sort();
  const sa = norm(a), sb = norm(b);
  ok(name, JSON.stringify(sa) === JSON.stringify(sb));
};

const tmpPath = join(tmpdir(), `hb-store-d1-test-${process.pid}.json`);
let file, d1, shim;

function freshStores() {
  file = createFileStore(tmpPath);
  shim = createD1Shim();
  // fileURLToPath, not `.pathname`: a URL pathname is percent-ENCODED, so any
  // space in the checkout path ("…/Hypertrophy Bible/…") arrives as "%20" and the
  // read ENOENTs. Combined with the node:sqlite skip above, that meant this whole
  // parity suite had never actually executed on a dev machine with a space in its
  // path — it skipped on old Node, and would have thrown on new Node.
  const schema = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "schema.sql"), "utf8");
  shim.exec(schema);
  d1 = createD1Store(shim);
}

try {
  freshStores();

  // --- users: get/save/update, including the CAS-on-missing-row contract ---
  same("getUser: both null for a missing user", await file.getUser("nope"), await d1.getUser("nope"));
  const u1 = { profile: { training_status: "intermediate" }, xp: 0 };
  same("saveUser: both return the saved user", await file.saveUser("u1", u1), await d1.saveUser("u1", u1));
  same("getUser: both return the saved user", await file.getUser("u1"), await d1.getUser("u1"));
  const mut = (u) => { u.xp = (u.xp ?? 0) + 10; return u; };
  same("updateUser: both apply the mutator identically", await file.updateUser("u1", mut), await d1.updateUser("u1", mut));
  same("updateUser: both return null for a missing user (CAS contract)", await file.updateUser("ghost", mut), await d1.updateUser("ghost", mut));

  // --- sessions: chronological order + insertion-order tiebreak + idempotency ---
  await file.saveUser("s1", {}); await d1.saveUser("s1", {});
  const sessA = { session_id: "sa", date: "2026-07-10", exercises: [] };
  const sessB = { session_id: "sb", date: "2026-07-08", exercises: [] };
  const sessC = { session_id: "sc", date: "2026-07-10", exercises: [] }; // same date as A, added after -> tiebreak by insertion
  for (const s of [sessA, sessB, sessC]) { await file.addSession("s1", s); await d1.addSession("s1", s); }
  same("listSessions: identical chronological + insertion-tiebreak order", await file.listSessions("s1"), await d1.listSessions("s1"));
  await file.addSession("s1", sessA); await d1.addSession("s1", sessA); // replayed duplicate
  ok("addSession: file store is idempotent on session_id", (await file.listSessions("s1")).length === 3);
  ok("addSession: D1 store is idempotent on session_id", (await d1.listSessions("s1")).length === 3);

  // --- bodyweights: same-day replace, not duplicate ---
  await file.saveUser("bw1", {}); await d1.saveUser("bw1", {});
  await file.addBodyweight("bw1", { date: "2026-07-01", kg: 80 });
  await d1.addBodyweight("bw1", { date: "2026-07-01", kg: 80 });
  await file.addBodyweight("bw1", { date: "2026-07-01", kg: 81 }); // same-day correction
  await d1.addBodyweight("bw1", { date: "2026-07-01", kg: 81 });
  same("addBodyweight: both replace (not append) a same-day retry", await file.listBodyweights("bw1"), await d1.listBodyweights("bw1"));

  // --- checkins: one per day, replace on conflict ---
  await file.saveUser("ci1", {}); await d1.saveUser("ci1", {});
  await file.addCheckin("ci1", { date: "2026-07-02", sleep: 3 });
  await d1.addCheckin("ci1", { date: "2026-07-02", sleep: 3 });
  await file.addCheckin("ci1", { date: "2026-07-02", sleep: 7 });
  await d1.addCheckin("ci1", { date: "2026-07-02", sleep: 7 });
  same("addCheckin: both replace a same-day entry", await file.listCheckins("ci1"), await d1.listCheckins("ci1"));

  // --- nutrition log: one per day, replace on conflict ---
  await file.saveUser("nl1", {}); await d1.saveUser("nl1", {});
  await file.addNutritionLog("nl1", { date: "2026-07-03", kcal: 2000 });
  await d1.addNutritionLog("nl1", { date: "2026-07-03", kcal: 2000 });
  await file.addNutritionLog("nl1", { date: "2026-07-03", kcal: 2200 });
  await d1.addNutritionLog("nl1", { date: "2026-07-03", kcal: 2200 });
  same("addNutritionLog: both replace a same-day entry", await file.listNutritionLog("nl1"), await d1.listNutritionLog("nl1"));

  // --- accounts ---
  // created_at is independently stamped by each store at the instant of the
  // call (new Date().toISOString()) — genuinely different values by design,
  // so compare everything EXCEPT it exactly, then check its shape/format
  // matches instead of its value (the bug this guards: D1's schema DEFAULT
  // for created_at rendered SQLite's own "YYYY-MM-DD HH:MM:SS", which
  // `new Date(...)` parses as LOCAL time rather than UTC — same lesson-22
  // class as calendar-vs-instant bugs elsewhere in this codebase).
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  await file.saveAccount("a@t.com", "acct-u", "2026-07-01T00:00:00.000Z");
  await d1.saveAccount("a@t.com", "acct-u", "2026-07-01T00:00:00.000Z");
  const { created_at: fCreated, ...fAcct } = await file.getAccountByEmail("a@t.com");
  const { created_at: dCreated, ...dAcct } = await d1.getAccountByEmail("a@t.com");
  same("getAccountByEmail matches (excluding the independently-stamped created_at)", fAcct, dAcct);
  ok("getAccountByEmail: both stores' created_at is ISO-8601 UTC, same format", ISO_RE.test(fCreated) && ISO_RE.test(dCreated));
  const { created_at: _fc2, ...fAcct2 } = await file.getAccountByUserId("acct-u");
  const { created_at: _dc2, ...dAcct2 } = await d1.getAccountByUserId("acct-u");
  same("getAccountByUserId matches (excluding created_at)", fAcct2, dAcct2);
  ok("getAccountByEmail: both null for an unknown email", (await file.getAccountByEmail("nope@t.com")) === null && (await d1.getAccountByEmail("nope@t.com")) === null);

  // --- magic links: single-use atomic flip + rate-limit counters ---
  const link = { token_hash: "hash1", email: "a@t.com", rl_key: "a@t.com", ip: "1.2.3.4", user_id: "acct-u", purpose: "claim", expires_at: Date.now() + 6e5, used: 0, created_at: Date.now() };
  await file.createMagicLink(link); await d1.createMagicLink(link);
  same("getMagicLink matches", await file.getMagicLink("hash1"), await d1.getMagicLink("hash1"));
  ok("markMagicLinkUsed: both true on first consume", (await file.markMagicLinkUsed("hash1")) === true && (await d1.markMagicLinkUsed("hash1")) === true);
  ok("markMagicLinkUsed: both false on second consume (no double-spend)", (await file.markMagicLinkUsed("hash1")) === false && (await d1.markMagicLinkUsed("hash1")) === false);
  ok("countRecentLinks matches", (await file.countRecentLinks("a@t.com", 0)) === (await d1.countRecentLinks("a@t.com", 0)));
  ok("countRecentByIp matches", (await file.countRecentByIp("1.2.3.4", 0)) === (await d1.countRecentByIp("1.2.3.4", 0)));

  // --- push subscriptions: upsert by endpoint, scoped vs unscoped delete ---
  await file.saveUser("px1", {}); await d1.saveUser("px1", {});
  const sub = { endpoint: "https://push/ep1", keys: { p256dh: "p", auth: "a" } };
  await file.savePushSubscription("px1", sub); await d1.savePushSubscription("px1", sub);
  await file.markPushDelivered(sub.endpoint, 1234567890); await d1.markPushDelivered(sub.endpoint, 1234567890);
  sameSet("listPushSubscriptions matches after one save", (await file.listPushSubscriptions()).map(({ created_at, ...r }) => r), (await d1.listPushSubscriptions()).map(({ created_at, ...r }) => r));
  await file.deletePushSubscription("https://push/ep1", "wrong-owner"); await d1.deletePushSubscription("https://push/ep1", "wrong-owner");
  ok("deletePushSubscription: both no-op when userId doesn't match owner (file)", (await file.listPushSubscriptions()).length === 1);
  ok("deletePushSubscription: both no-op when userId doesn't match owner (D1)", (await d1.listPushSubscriptions()).length === 1);
  await file.deletePushSubscription("https://push/ep1", "px1"); await d1.deletePushSubscription("https://push/ep1", "px1");
  ok("deletePushSubscription: both delete when userId matches (file)", (await file.listPushSubscriptions()).length === 0);
  ok("deletePushSubscription: both delete when userId matches (D1)", (await d1.listPushSubscriptions()).length === 0);
  // Delivery evidence is opaque endpoint data. It must disappear with the
  // subscription, and a late successful-send callback cannot recreate it after
  // the person has unsubscribed.
  await file.markPushDelivered(sub.endpoint, 1234567999); await d1.markPushDelivered(sub.endpoint, 1234567999);
  const fileAfterUnsub = JSON.parse(readFileSync(tmpPath, "utf8"));
  const d1AfterUnsub = await shim.prepare("SELECT endpoint FROM push_deliveries WHERE endpoint = ?").bind(sub.endpoint).first();
  ok("push delivery evidence is deleted on unsubscribe and cannot be recreated without an active endpoint",
    !fileAfterUnsub.push_deliveries?.[sub.endpoint] && !d1AfterUnsub);

  // --- latestSessionDate / listAccountLastSessions ---
  ok("latestSessionDate matches", (await file.latestSessionDate("s1")) === (await d1.latestSessionDate("s1")));
  ok("latestSessionDate: both null with no sessions", (await file.latestSessionDate("nope")) === null && (await d1.latestSessionDate("nope")) === null);

  // --- shares + cheers: rotate-on-recreate, revoke drops cheers too ---
  await file.saveUser("sh1", {}); await d1.saveUser("sh1", {});
  await file.createShare("sh1", "share-1", 1000); await d1.createShare("sh1", "share-1", 1000);
  await file.addShareCheer("share-1"); await file.addShareCheer("share-1");
  await d1.addShareCheer("share-1"); await d1.addShareCheer("share-1");
  ok("getShareCheers matches after two cheers", (await file.getShareCheers("share-1")) === (await d1.getShareCheers("share-1")));
  await file.createShare("sh1", "share-2", 2000); await d1.createShare("sh1", "share-2", 2000); // re-share rotates
  ok("createShare: old token resolves to no user after rotation (file)", (await file.getShareUserId("share-1")) === null);
  ok("createShare: old token resolves to no user after rotation (D1)", (await d1.getShareUserId("share-1")) === null);
  ok("getShareIdForUser reflects the rotated token (file)", (await file.getShareIdForUser("sh1")) === "share-2");
  ok("getShareIdForUser reflects the rotated token (D1)", (await d1.getShareIdForUser("sh1")) === "share-2");
  await file.deleteShare("sh1"); await d1.deleteShare("sh1");
  ok("deleteShare drops the share (file)", (await file.getShareIdForUser("sh1")) === null);
  ok("deleteShare drops the share (D1)", (await d1.getShareIdForUser("sh1")) === null);

  console.log(`  (${pass} passed so far — starting the reassignUserData merge scenario)`);

  // --- reassignUserData: the highest-risk method (merges 8 record types, a
  // real merge deletes the `from` user). Build overlapping state on BOTH
  // stores identically, run the merge, then compare every surface it touches.
  for (const [id, store] of [["m-from", file], ["m-from", d1], ["m-to", file], ["m-to", d1]]) {
    await store.saveUser(id, {
      custom_exercises: id === "m-from" ? [{ id: "ce-1", name: "From Curl" }, { id: "ce-shared", name: "Shared" }] : [{ id: "ce-shared", name: "Shared (kept)" }],
      // Nutrition profile stats: `to` has ONLY height set (must survive), `from`
      // has height (must be ignored) + bf_pct/activity (must be adopted, gap-fill).
      nutrition: id === "m-from" ? { height_cm: 200, bf_pct: 14, activity: "very_active" } : { height_cm: 178 },
    });
  }
  // Session ids here are DISTINCT across from/to (unlike bodyweights/checkins/
  // nutrition below, which deliberately collide by date). A same-session_id
  // collision across two DIFFERENT users can't be built the same way on both
  // stores: session_id is scoped PER USER in the file store (db.sessions[id])
  // but is a database-wide PRIMARY KEY in the D1 schema, so addSession's
  // `ON CONFLICT(session_id) DO NOTHING` silently drops the second user's
  // write before a merge ever runs — verified directly (not assumed) below,
  // in its own scenario, rather than folded into this one where it would
  // desync the two stores' starting states before reassignUserData even ran.
  const mergeSessions = { from: [{ session_id: "ms-1", date: "2026-06-01", exercises: [] }, { session_id: "ms-2", date: "2026-06-02", exercises: [] }], to: [{ session_id: "ms-3", date: "2026-06-03", exercises: [] }] };
  const mergeBw = { from: [{ date: "2026-06-01", kg: 70 }, { date: "2026-06-05", kg: 71 }], to: [{ date: "2026-06-05", kg: 99 }] }; // 06-05 collides: to's should survive
  const mergeCi = { from: [{ date: "2026-06-01", sleep: 5 }, { date: "2026-06-06", sleep: 4 }], to: [{ date: "2026-06-06", sleep: 9 }] }; // 06-06 collides: to's should survive
  const mergeNl = { from: [{ date: "2026-06-01", kcal: 1800 }, { date: "2026-06-07", kcal: 1900 }], to: [{ date: "2026-06-07", kcal: 2500 }] }; // 06-07 collides: to's should survive
  for (const [fromTo, store] of [["from", file], ["from", d1], ["to", file], ["to", d1]]) {
    const id = fromTo === "from" ? "m-from" : "m-to";
    for (const s of mergeSessions[fromTo]) await store.addSession(id, s);
    for (const b of mergeBw[fromTo]) await store.addBodyweight(id, b);
    for (const c of mergeCi[fromTo]) await store.addCheckin(id, c);
    for (const n of mergeNl[fromTo]) await store.addNutritionLog(id, n);
  }
  await file.savePushSubscription("m-from", { endpoint: "https://push/merge-ep", keys: {} });
  await d1.savePushSubscription("m-from", { endpoint: "https://push/merge-ep", keys: {} });
  await file.createShare("m-from", "merge-share", 3000);
  await d1.createShare("m-from", "merge-share", 3000);

  const fileMoved = await file.reassignUserData("m-from", "m-to");
  const d1Moved = await d1.reassignUserData("m-from", "m-to");
  same("reassignUserData: both report identical moved counts", fileMoved, d1Moved);

  same("merge: sessions land identically on the survivor (dedup by session_id)", await file.listSessions("m-to"), await d1.listSessions("m-to"));
  same("merge: bodyweights land identically (target's same-date row wins)", await file.listBodyweights("m-to"), await d1.listBodyweights("m-to"));
  same("merge: checkins land identically (target's same-date row wins)", await file.listCheckins("m-to"), await d1.listCheckins("m-to"));
  same("merge: nutrition logs land identically (target's same-date row wins)", await file.listNutritionLog("m-to"), await d1.listNutritionLog("m-to"));
  same("merge: custom_exercises dedup by id identically", (await file.getUser("m-to")).custom_exercises, (await d1.getUser("m-to")).custom_exercises);
  same("merge: nutrition stats merge identically (to's height kept, from's bf_pct/activity gap-filled)", (await file.getUser("m-to")).nutrition, (await d1.getUser("m-to")).nutrition);
  ok("merge: nutrition kept to's own height_cm, not from's (file)", (await file.getUser("m-to")).nutrition.height_cm === 178);
  ok("merge: nutrition kept to's own height_cm, not from's (D1)", (await d1.getUser("m-to")).nutrition.height_cm === 178);
  ok("merge: nutrition gap-filled bf_pct/activity from from's side (file)", (await file.getUser("m-to")).nutrition.bf_pct === 14 && (await file.getUser("m-to")).nutrition.activity === "very_active");
  ok("merge: nutrition gap-filled bf_pct/activity from from's side (D1)", (await d1.getUser("m-to")).nutrition.bf_pct === 14 && (await d1.getUser("m-to")).nutrition.activity === "very_active");
  ok("merge: bodyweight collision kept the TARGET's value, not the source's (file)", (await file.listBodyweights("m-to")).find((b) => b.date === "2026-06-05")?.kg === 99);
  ok("merge: bodyweight collision kept the TARGET's value, not the source's (D1)", (await d1.listBodyweights("m-to")).find((b) => b.date === "2026-06-05")?.kg === 99);

  ok("merge: the from-user is gone (file)", (await file.getUser("m-from")) === null);
  ok("merge: the from-user is gone (D1)", (await d1.getUser("m-from")) === null);
  ok("merge: the from-user's sessions are gone (file)", (await file.listSessions("m-from")).length === 0);
  ok("merge: the from-user's sessions are gone (D1)", (await d1.listSessions("m-from")).length === 0);

  ok("merge: push subscription follows the survivor (file)", (await file.listPushSubscriptions()).find((s) => s.endpoint === "https://push/merge-ep")?.user_id === "m-to");
  ok("merge: push subscription follows the survivor (D1)", (await d1.listPushSubscriptions()).find((s) => s.endpoint === "https://push/merge-ep")?.user_id === "m-to");

  ok("merge: the share (no prior share on the target) follows the survivor (file)", (await file.getShareIdForUser("m-to")) === "merge-share");
  ok("merge: the share (no prior share on the target) follows the survivor (D1)", (await d1.getShareIdForUser("m-to")) === "merge-share");
  ok("merge: the old share_id no longer resolves post-transfer (file)", (await file.getShareUserId("merge-share")) === "m-to");
  ok("merge: the old share_id no longer resolves post-transfer (D1)", (await d1.getShareUserId("merge-share")) === "m-to");

  // --- reassignUserData: BOTH sides already have a share -> the merged-away
  // one must be DROPPED (shares are UNIQUE per user), not silently orphaned.
  await file.saveUser("m2-from", {}); await d1.saveUser("m2-from", {});
  await file.saveUser("m2-to", {}); await d1.saveUser("m2-to", {});
  await file.createShare("m2-from", "m2-from-share", 4000); await d1.createShare("m2-from", "m2-from-share", 4000);
  await file.createShare("m2-to", "m2-to-share", 4100); await d1.createShare("m2-to", "m2-to-share", 4100);
  await file.addShareCheer("m2-from-share"); await d1.addShareCheer("m2-from-share");
  await file.reassignUserData("m2-from", "m2-to"); await d1.reassignUserData("m2-from", "m2-to");
  ok("merge: target's own share is preserved when it already had one (file)", (await file.getShareIdForUser("m2-to")) === "m2-to-share");
  ok("merge: target's own share is preserved when it already had one (D1)", (await d1.getShareIdForUser("m2-to")) === "m2-to-share");
  ok("merge: the merged-away share (and its cheers) are dropped, not orphaned (file)", (await file.getShareUserId("m2-from-share")) === null);
  ok("merge: the merged-away share (and its cheers) are dropped, not orphaned (D1)", (await d1.getShareUserId("m2-from-share")) === null);
  ok("merge: the dropped share's cheer tally is gone, not resurrectable (file)", (await file.getShareCheers("m2-from-share")) === 0);
  ok("merge: the dropped share's cheer tally is gone, not resurrectable (D1)", (await d1.getShareCheers("m2-from-share")) === 0);

  // --- session_id uniqueness scope: verified, real, and DELIBERATELY not a
  // parity requirement. store.mjs's reassignUserData has merge-time dedup
  // logic explicitly commented "parity with D1's PRIMARY KEY" — for a
  // same-session_id write to reach that dedup path in the file store, TWO
  // DIFFERENT users must each independently own a row with the same
  // session_id before any merge runs (e.g. lesson 11's two-tab offline-flush
  // race straddling an account switch). Confirmed directly here, not assumed:
  // in D1, session_id is the sessions table's actual PRIMARY KEY (schema.sql),
  // so the SECOND such write is silently absorbed by addSession's
  // `ON CONFLICT(session_id) DO NOTHING` at write time — D1 can never reach
  // the state the file store's dedup guards against, so it doesn't need
  // equivalent merge-time logic. This is confirmed BENIGN, not a data-loss
  // bug: session_id is a fresh crypto.randomUUID() minted once per session
  // object and submitted once (app.js `finish()`), so two genuinely
  // different workouts colliding on session_id doesn't happen in practice —
  // only a resubmit of the literal same workout event could collide, and
  // "keep exactly one copy of the same event" is the correct outcome either
  // way. Locking in current, already-correct behavior on both stores.
  await file.saveUser("collide-from", {}); await d1.saveUser("collide-from", {});
  await file.saveUser("collide-to", {}); await d1.saveUser("collide-to", {});
  const collideSession = { session_id: "collide-1", date: "2026-06-10", exercises: [] };
  await file.addSession("collide-from", collideSession); await d1.addSession("collide-from", collideSession);
  await file.addSession("collide-to", collideSession); await d1.addSession("collide-to", collideSession);
  ok("file store: session_id uniqueness is scoped PER USER — both users independently own a copy", (await file.listSessions("collide-from")).length === 1 && (await file.listSessions("collide-to")).length === 1);
  ok("D1: session_id is a database-wide PRIMARY KEY — the second user's write is silently absorbed, not duplicated", (await d1.listSessions("collide-from")).length === 1 && (await d1.listSessions("collide-to")).length === 0);
  const fileCollideMoved = await file.reassignUserData("collide-from", "collide-to");
  const d1CollideMoved = await d1.reassignUserData("collide-from", "collide-to");
  ok("file store: merge-time dedup declines to move the colliding session (the target already had its own copy)", fileCollideMoved.sessions === 0 && (await file.listSessions("collide-to")).length === 1);
  ok("D1: the merge moves it (D1 never had a second copy to dedupe against)", d1CollideMoved.sessions === 1 && (await d1.listSessions("collide-to")).length === 1);
  same("Despite the differently-explained path, both stores land on exactly one surviving copy of the event", await file.listSessions("collide-to"), await d1.listSessions("collide-to"));

  // --- SAME-DATE tiebreak across a merge: a second real, narrow, VERIFIED
  // divergence (session_id, order — not counted, not data loss). Both
  // listSessions implementations promise "date ASC, tiebreak = insertion
  // order" (store-d1.mjs's own comment: "coach rotation + PR detection
  // depend on it"), but "insertion order" resolves differently across a
  // merge: D1's tiebreak is `rowid`, fixed at each row's ORIGINAL insert
  // time and untouched by the merge's UPDATE (only user_id changes) — so a
  // same-date session keeps its original relative position regardless of
  // which user currently owns it. The file store's merge instead APPENDS
  // the source's remaining sessions after the target's pre-existing array
  // (`dst.push(s)` for each of the source's sessions), so on a same-date
  // tie, anything already on the TARGET before the merge always sorts
  // first — regardless of which session was chronologically logged first.
  // In practice `date` is a full ISO timestamp (app.js's `sess.startedAt`),
  // so an exact millisecond collision between two genuinely different
  // sessions merged from different accounts is vanishingly rare — this is
  // real but low-severity, so it's documented and locked in here rather
  // than "fixed" blind against a live D1 migration in this pass.
  await file.saveUser("tie-from", {}); await d1.saveUser("tie-from", {});
  const tieDate = "2026-06-20T08:00:00.000Z";
  const tieFrom = { session_id: "tie-from-own", date: tieDate, exercises: [] };
  await file.addSession("tie-from", tieFrom); await d1.addSession("tie-from", tieFrom); // source's session logged FIRST (chronologically earlier)
  await file.saveUser("tie-to", {}); await d1.saveUser("tie-to", {});
  const tieTo = { session_id: "tie-to-own", date: tieDate, exercises: [] };
  await file.addSession("tie-to", tieTo); await d1.addSession("tie-to", tieTo); // target's own session logged SECOND (chronologically later), then the merge runs
  await file.reassignUserData("tie-from", "tie-to"); await d1.reassignUserData("tie-from", "tie-to");
  const fileTieOrder = (await file.listSessions("tie-to")).map((s) => s.session_id);
  const d1TieOrder = (await d1.listSessions("tie-to")).map((s) => s.session_id);
  ok("file store: a same-date merge collision sorts the target's PRE-EXISTING session first, regardless of which was chronologically logged first (merge-append order)", fileTieOrder.join(",") === "tie-to-own,tie-from-own");
  ok("D1: the SAME collision sorts by ORIGINAL chronological insertion order instead (rowid is untouched by the ownership UPDATE) — the source's earlier session comes first", d1TieOrder.join(",") === "tie-from-own,tie-to-own");
  ok("CONFIRMED, NOT a test artifact: the two stores land on genuinely OPPOSITE orders for this scenario", fileTieOrder.join(",") !== d1TieOrder.join(","));

  // --- voiding + editing a logged session (Wave 163) -----------------------
  // The riskiest parity surface in this wave: the file store filters voided
  // sessions in JS, D1 does it in SQL via json_extract on the blob. Two different
  // mechanisms for one rule is exactly where a "method in one store but not the
  // other" bug lives, so every observable is compared side by side.
  await file.saveUser("v1", {}); await d1.saveUser("v1", {});
  await file.saveAccount("v@t.com", "v1", "2026-07-01T00:00:00.000Z");
  await d1.saveAccount("v@t.com", "v1", "2026-07-01T00:00:00.000Z");
  const vA = { session_id: "va", date: "2026-07-01T10:00:00.000Z", sets: [{ exercise: "bench", weight_kg: 60, reps: 8 }] };
  const vB = { session_id: "vb", date: "2026-07-05T10:00:00.000Z", sets: [{ exercise: "bench", weight_kg: 999, reps: 8 }] };
  for (const x of [vA, vB]) { await file.addSession("v1", x); await d1.addSession("v1", x); }

  same("updateSession: both return null for a session that isn't this user's", await file.updateSession("v1", "nope", (x) => x), await d1.updateSession("v1", "nope", (x) => x));
  same("updateSession: a mutator returning null leaves the record untouched (declined != not-found)",
    await file.updateSession("v1", "va", () => null), await d1.updateSession("v1", "va", () => null));

  const voidIt = (x) => { x.voided_at = "2026-07-06T00:00:00.000Z"; return x; };
  same("updateSession: both persist a void identically", await file.updateSession("v1", "vb", voidIt), await d1.updateSession("v1", "vb", voidIt));
  same("listSessions: both HIDE the voided session by default", await file.listSessions("v1"), await d1.listSessions("v1"));
  ok("listSessions: the void is actually in effect (one session left, the un-voided one)", (await file.listSessions("v1")).length === 1 && (await file.listSessions("v1"))[0].session_id === "va");
  same("listSessions({includeVoided}): both SHOW it again, so the history screen can offer undo", await file.listSessions("v1", { includeVoided: true }), await d1.listSessions("v1", { includeVoided: true }));
  ok("listSessions({includeVoided}): both return the full set", (await file.listSessions("v1", { includeVoided: true })).length === 2 && (await d1.listSessions("v1", { includeVoided: true })).length === 2);

  // The nudge sweep reads these two directly, NOT via listSessions — a voided
  // session must not read as "last trained" or a corrected-away workout would
  // silently suppress the comeback email the user should get.
  same("latestSessionDate: both ignore the voided session", await file.latestSessionDate("v1"), await d1.latestSessionDate("v1"));
  ok("latestSessionDate: falls back to the earlier surviving session, not the voided later one", (await file.latestSessionDate("v1")).slice(0, 10) === "2026-07-01");
  const fileAcct = (await file.listAccountLastSessions()).find((a) => a.user_id === "v1");
  const d1Acct = (await d1.listAccountLastSessions()).find((a) => a.user_id === "v1");
  same("listAccountLastSessions: both ignore the voided session in the aggregate", fileAcct, d1Acct);
  ok("listAccountLastSessions: the aggregate skipped the voided later session too", (fileAcct.last_date ?? "").slice(0, 10) === "2026-07-01");

  const unvoid = (x) => { delete x.voided_at; return x; };
  same("updateSession: un-voiding restores it in both (void is a toggle, never a delete)", await file.updateSession("v1", "vb", unvoid), await d1.updateSession("v1", "vb", unvoid));
  same("listSessions: both show it again after un-voiding", await file.listSessions("v1"), await d1.listSessions("v1"));

  // Editing must keep the `date` COLUMN in sync with the blob in D1 — the ORDER BY
  // and every MAX(date) aggregate read the column, not the JSON, so a blob-only
  // update would leave the two stores ordering the same history differently.
  const redate = (x) => { x.date = "2026-06-01T10:00:00.000Z"; x.sets = [{ exercise: "bench", weight_kg: 62.5, reps: 8 }]; return x; };
  await file.updateSession("v1", "vb", redate); await d1.updateSession("v1", "vb", redate);
  same("updateSession: an edit that moves the date re-sorts identically in both stores", await file.listSessions("v1"), await d1.listSessions("v1"));
  ok("updateSession: D1's date COLUMN followed the blob (the edited session now sorts first)", (await d1.listSessions("v1"))[0].session_id === "vb");
  same("latestSessionDate: both agree after the edit moved the newest session backwards", await file.latestSessionDate("v1"), await d1.latestSessionDate("v1"));

  // --- Wave 210: stats() + markPushDelivered parity — the owner stats endpoint
  // reads whichever store the runtime has, so the numbers must not depend on it.
  // Assertions on the seeded scenario use DELTAS (before vs after) so earlier
  // scenarios' fixtures in these long-lived stores can never pollute them.
  const S_NOW = Date.now();
  const dIso = (days) => new Date(S_NOW - days * 86400000).toISOString();
  const stBefore = await file.stats(S_NOW);
  same("stats: both stores agree BEFORE the scenario too", stBefore, await d1.stats(S_NOW));
  for (const s of [file, d1]) {
    await s.saveUser("st1", { profile: {} }); await s.saveUser("st2", { profile: {} }); await s.saveUser("st3", { profile: {} });
    await s.addSession("st1", { session_id: "st1-a", date: dIso(2), sets: [] });
    await s.addSession("st1", { session_id: "st1-b", date: dIso(10), sets: [] });
    await s.addSession("st2", { session_id: "st2-a", date: dIso(10), sets: [] });
    await s.addSession("st3", { session_id: "st3-a", date: dIso(40), sets: [] });
    await s.savePushSubscription("st1", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/st1", keys: { p256dh: "k", auth: "a" } });
    await s.savePushSubscription("st2", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/st2", keys: { p256dh: "k", auth: "a" } });
    await s.markPushDelivered("https://updates.push.services.mozilla.com/wpush/v2/st1", S_NOW - 3600e3);
    await s.markPushDelivered("https://updates.push.services.mozilla.com/wpush/v2/st2", S_NOW - 9 * 86400000); // aged out of the 7d window
    await s.markPushDelivered("https://updates.push.services.mozilla.com/wpush/v2/ghost", S_NOW); // no subscription -> never counted
  }
  const stFile = await file.stats(S_NOW);
  same("stats: byte-identical aggregates from both stores after the scenario", stFile, await d1.stats(S_NOW));
  ok("stats deltas: actives, sessions, subscriptions and delivery evidence all read correctly",
    stFile.users_total - stBefore.users_total === 3
    && stFile.active_7d - stBefore.active_7d === 1
    && stFile.active_prev_7d - stBefore.active_prev_7d === 2
    && stFile.sessions_7d - stBefore.sessions_7d === 1
    && stFile.sessions_28d - stBefore.sessions_28d === 3
    && stFile.push_subscriptions - stBefore.push_subscriptions === 2
    && stFile.push_delivered_7d - stBefore.push_delivered_7d === 1);

  // --- Wave 211 (BLOCKERS #6b): merge TOMBSTONES the from-row in both stores —
  // reads as absent everywhere, but the raw row survives with the audit marker.
  for (const s of [file, d1]) {
    await s.saveUser("tb-from", { profile: { commitment: { week: "2026-W01", days: ["mon"] } } });
    await s.saveUser("tb-to", { profile: {} });
    await s.reassignUserData("tb-from", "tb-to");
  }
  same("tombstone: both stores read the merged-away user identically (absent)", await file.getUser("tb-from"), await d1.getUser("tb-from"));
  ok("tombstone: reads as absent (null)", (await file.getUser("tb-from")) === null);
  const tbRaw = await shim.prepare("SELECT data FROM users WHERE id = ?").bind("tb-from").first();
  ok("tombstone: the D1 row still EXISTS, carrying the audit marker", JSON.parse(tbRaw?.data ?? "{}")._merged_into === "tb-to");
  same("tombstone: stats users_total agrees across stores and excludes tombstones",
    (await file.stats(S_NOW)).users_total, (await d1.stats(S_NOW)).users_total);

  // --- Wave 215: recoverable merge archives ---------------------------------
  // A normal merge deliberately keeps the survivor's same-day daily rows. That
  // was safe for the survivor but previously made the source-side collision
  // permanently unreachable. Archive the ENTIRE source graph before the move,
  // expose only an owner-scoped summary, and materialize a separate, safe copy
  // on restore. This fixture contains every private collection the archive owns
  // plus a collision in every daily collection.
  const ARC_ID = "archive-parity-1";
  const ARC_MERGED_AT = "2026-08-17T12:34:56.000Z";
  const ARC_RESTORED_AT = "2026-08-17T13:45:56.000Z";
  const ARC_SOURCE_ID = "arc-from";
  const ARC_SURVIVOR_ID = "arc-to";
  const ARC_COPY_ID = "arc-safe-copy";
  const copyFixture = (value) => JSON.parse(JSON.stringify(value));
  const arcSourceUser = {
    top_level_source_only: { proof: "full-document-preserved" },
    custom_exercises: [{ id: "arc-curl", name: "Archive Curl" }],
    program: { name: "Archived source programme" },
    profile: {
      user_id: ARC_SOURCE_ID,
      units: "imperial",
      disclaimer_ack: { version: "health-v1", acknowledged_at: "2026-08-01T00:00:00.000Z" },
      // Live device/social state is intentionally archived but must not become
      // active on a restored copy.
      celebration: { at: "2026-08-16T00:00:00.000Z" },
      commitment: { week: "2026-W33", days: ["mon"] },
      following: ["someone-else"],
      followers_count: 9,
      challenges: [{ id: "challenge-1" }],
      cheers_pushed: 2,
      cheers_seen: 2,
    },
  };
  const arcSurvivorUser = {
    top_level_survivor_only: { proof: "survivor-must-not-change-on-restore" },
    program: { name: "Survivor programme" },
    profile: { user_id: ARC_SURVIVOR_ID, units: "metric" },
  };
  const arcSourceSessions = [
    {
      session_id: "arc-session-work",
      date: "2026-06-14T10:00:00.000Z",
      local_date: "2026-06-14",
      sets: [{ exercise: "archive-bench", set_type: "work", weight_kg: 80, reps: 8 }],
    },
    {
      session_id: "arc-session-voided",
      date: "2026-06-15T10:00:00.000Z",
      local_date: "2026-06-15",
      sets: [],
      voided_at: "2026-06-16T00:00:00.000Z",
    },
  ];
  const arcSourceDaily = {
    bodyweights: [{ date: "2026-06-13", kg: 70 }, { date: "2026-06-15", kg: 71 }],
    checkins: [{ date: "2026-06-13", sleep: 5 }, { date: "2026-06-16", sleep: 4 }],
    nutrition: [{ date: "2026-06-13", kcal: 1800 }, { date: "2026-06-17", kcal: 1900 }],
  };
  const arcSurvivorDaily = {
    bodyweights: [{ date: "2026-06-15", kg: 99 }],
    checkins: [{ date: "2026-06-16", sleep: 9 }],
    nutrition: [{ date: "2026-06-17", kcal: 2500 }],
  };
  const arcPush = { endpoint: "https://push/archive-source", keys: { p256dh: "arc-p", auth: "arc-a" } };
  const arcMagic = {
    token_hash: "archive-source-magic", email: "archive@example.test", rl_key: "archive@example.test",
    ip: "203.0.113.7", user_id: ARC_SOURCE_ID, purpose: "restore", expires_at: 9876543210,
    used: 0, created_at: 1234567890,
  };
  for (const store of [file, d1]) {
    await store.saveUser(ARC_SOURCE_ID, copyFixture(arcSourceUser));
    await store.saveUser(ARC_SURVIVOR_ID, copyFixture(arcSurvivorUser));
    for (const session of arcSourceSessions) await store.addSession(ARC_SOURCE_ID, copyFixture(session));
    for (const row of arcSourceDaily.bodyweights) await store.addBodyweight(ARC_SOURCE_ID, copyFixture(row));
    for (const row of arcSourceDaily.checkins) await store.addCheckin(ARC_SOURCE_ID, copyFixture(row));
    for (const row of arcSourceDaily.nutrition) await store.addNutritionLog(ARC_SOURCE_ID, copyFixture(row));
    for (const row of arcSurvivorDaily.bodyweights) await store.addBodyweight(ARC_SURVIVOR_ID, copyFixture(row));
    for (const row of arcSurvivorDaily.checkins) await store.addCheckin(ARC_SURVIVOR_ID, copyFixture(row));
    for (const row of arcSurvivorDaily.nutrition) await store.addNutritionLog(ARC_SURVIVOR_ID, copyFixture(row));
    await store.savePushSubscription(ARC_SOURCE_ID, copyFixture(arcPush));
    await store.markPushDelivered(arcPush.endpoint, 2222222222);
    await store.createShare(ARC_SOURCE_ID, "archive-source-share", 3333333333);
    await store.addShareCheer("archive-source-share");
    await store.addShareCheer("archive-source-share");
    await store.createMagicLink(copyFixture(arcMagic));
  }
  same("archive merge: both stores report the same rows moved",
    await file.reassignUserData(ARC_SOURCE_ID, ARC_SURVIVOR_ID, { archiveId: ARC_ID, now: ARC_MERGED_AT }),
    await d1.reassignUserData(ARC_SOURCE_ID, ARC_SURVIVOR_ID, { archiveId: ARC_ID, now: ARC_MERGED_AT }));

  const expectedArchiveSummary = {
    archive_id: ARC_ID, created_at: ARC_MERGED_AT, state: "available", restored_at: null,
    // push_subscriptions/shares are RECORDED as counts and never as material, so
    // the owner-facing summary can say what the source account had while the
    // snapshot holds nothing that could act on their behalf.
    counts: { sessions: 2, bodyweights: 2, checkins: 2, nutrition_logs: 2, push_subscriptions: 1, shares: 1 },
  };
  const fileArchiveList = await file.listMergeArchives(ARC_SURVIVOR_ID);
  const d1ArchiveList = await d1.listMergeArchives(ARC_SURVIVOR_ID);
  same("archive list: file/D1 return the same owner-safe summary", fileArchiveList, d1ArchiveList);
  same("archive list: the public summary has expected counts and state", fileArchiveList, [expectedArchiveSummary]);
  ok("archive list: no raw snapshot, source identity, restored identity, push endpoint, or magic token leaks",
    Object.keys(fileArchiveList[0] ?? {}).sort().join(",") === "archive_id,counts,created_at,restored_at,state"
      && !JSON.stringify(fileArchiveList[0] ?? {}).includes(ARC_SOURCE_ID)
      && !JSON.stringify(fileArchiveList[0] ?? {}).includes(arcPush.endpoint)
      && !JSON.stringify(fileArchiveList[0] ?? {}).includes(arcMagic.token_hash));
  same("archive list: a non-owner sees no archive in either store", await file.listMergeArchives("arc-not-owner"), await d1.listMergeArchives("arc-not-owner"));
  ok("archive list: a non-owner receives an empty list", (await file.listMergeArchives("arc-not-owner")).length === 0 && (await d1.listMergeArchives("arc-not-owner")).length === 0);

  // The public summary is intentionally small, but the raw archive and the
  // source tombstone must retain the source document and every source-only row.
  const fileRawDb = JSON.parse(readFileSync(tmpPath, "utf8"));
  const fileRawArchive = fileRawDb.merge_archives?.[ARC_ID];
  const d1RawArchive = await shim.prepare("SELECT snapshot FROM merge_archives WHERE archive_id = ?").bind(ARC_ID).first();
  const d1Snapshot = JSON.parse(d1RawArchive?.snapshot ?? "{}");
  const archiveGraphIsComplete = (snapshot) =>
    snapshot.user?.top_level_source_only?.proof === "full-document-preserved"
      && snapshot.user?.profile?.disclaimer_ack?.version === "health-v1"
      && snapshot.sessions?.map((s) => s.session_id).join(",") === "arc-session-work,arc-session-voided"
      && snapshot.bodyweights?.find((x) => x.date === "2026-06-15")?.kg === 71
      && snapshot.checkins?.find((x) => x.date === "2026-06-16")?.sleep === 4
      && snapshot.nutrition_logs?.find((x) => x.date === "2026-06-17")?.kcal === 1900
      // What the archive RECORDS about revoked-capability collections is a count,
      // never the material. This assertion is the inverse of the one it replaces:
      // it used to require the endpoint keys, share token and magic-link hash to be
      // present, which is the state that made an unsubscribe survivable in a copy
      // nothing purges. The flip is the point — never relax it back.
      && snapshot.revoked_counts?.push_subscriptions === 1
      && snapshot.revoked_counts?.push_deliveries === 1
      && snapshot.revoked_counts?.shares === 1
      && snapshot.revoked_counts?.magic_links >= 1
      && snapshot.push_subscriptions === undefined
      && snapshot.push_deliveries === undefined
      && snapshot.shares === undefined
      && snapshot.magic_links === undefined;
  ok("archive raw snapshot: file contains the complete pre-merge source graph", archiveGraphIsComplete(fileRawArchive?.snapshot));
  ok("archive raw snapshot: D1 contains the complete pre-merge source graph", archiveGraphIsComplete(d1Snapshot));

  // The retention property stated as a string search over the RAW stored blob, not
  // as a shape check: a capability that reappears under a different key name would
  // pass the structural assertions above and still be a permanent plaintext copy of
  // a credential in a row nothing ever deletes.
  const rawArchiveText = (typeof fileRawArchive?.snapshot === "string" ? fileRawArchive.snapshot : JSON.stringify(fileRawArchive?.snapshot ?? {}))
    + (d1RawArchive?.snapshot ?? "");
  ok("archive raw snapshot: no push endpoint, encryption key, share token or magic-link hash is stored anywhere in it",
    !rawArchiveText.includes(arcPush.endpoint)
    && !rawArchiveText.includes(arcPush.p256dh) && !rawArchiveText.includes(arcPush.auth)
    && !rawArchiveText.includes("archive-source-share")
    && !rawArchiveText.includes(arcMagic.token_hash));
  ok("archive summary: the owner still learns WHAT the source had, without what it took to use it",
    (await file.listMergeArchives(ARC_SURVIVOR_ID))[0]?.counts?.push_subscriptions === 1
    && (await d1.listMergeArchives(ARC_SURVIVOR_ID))[0]?.counts?.shares === 1);
  const d1TombstoneRow = await shim.prepare("SELECT data FROM users WHERE id = ?").bind(ARC_SOURCE_ID).first();
  const tombstonePreservesSource = (user) =>
    user?.top_level_source_only?.proof === "full-document-preserved"
      && user?.profile?.disclaimer_ack?.version === "health-v1"
      && user?._merged_into === ARC_SURVIVOR_ID
      && user?._merged_at === ARC_MERGED_AT
      && user?._merge_archive_id === ARC_ID;
  ok("archive tombstone: file keeps the full source document as an audit row", tombstonePreservesSource(fileRawDb.users?.[ARC_SOURCE_ID]));
  ok("archive tombstone: D1 keeps the full source document as an audit row", tombstonePreservesSource(JSON.parse(d1TombstoneRow?.data ?? "{}")));

  const survivorSnapshot = async (store) => ({
    user: await store.getUser(ARC_SURVIVOR_ID),
    sessions: await store.listSessions(ARC_SURVIVOR_ID, { includeVoided: true, includeQuarantined: true }),
    bodyweights: await store.listBodyweights(ARC_SURVIVOR_ID),
    checkins: await store.listCheckins(ARC_SURVIVOR_ID),
    nutrition: await store.listNutritionLog(ARC_SURVIVOR_ID),
    subscriptions: (await store.listPushSubscriptions()).filter((s) => s.user_id === ARC_SURVIVOR_ID),
    share_id: await store.getShareIdForUser(ARC_SURVIVOR_ID),
  });
  const fileSurvivorBeforeRestore = await survivorSnapshot(file);
  const d1SurvivorBeforeRestore = await survivorSnapshot(d1);
  const survivorKeptItsCollisions = (state) =>
    state.bodyweights.find((x) => x.date === "2026-06-15")?.kg === 99
      && state.checkins.find((x) => x.date === "2026-06-16")?.sleep === 9
      && state.nutrition.find((x) => x.date === "2026-06-17")?.kcal === 2500;
  ok("archive fixture: the survivor retained its own collision rows before restore (file)", survivorKeptItsCollisions(fileSurvivorBeforeRestore));
  ok("archive fixture: the survivor retained its own collision rows before restore (D1)", survivorKeptItsCollisions(d1SurvivorBeforeRestore));

  const fileRestore = await file.restoreMergeArchive(ARC_SURVIVOR_ID, ARC_ID, ARC_COPY_ID, ARC_RESTORED_AT);
  const d1Restore = await d1.restoreMergeArchive(ARC_SURVIVOR_ID, ARC_ID, ARC_COPY_ID, ARC_RESTORED_AT);
  same("archive restore: file/D1 return the same new safe-copy identity and safe summary", fileRestore, d1Restore);
  ok("archive restore: response names a fresh copy and marks the immutable archive restored",
    fileRestore?.user_id === ARC_COPY_ID && fileRestore?.program_name === "Archived source programme"
      && fileRestore?.units === "imperial" && fileRestore?.archive?.state === "restored"
      && fileRestore?.archive?.restored_at === ARC_RESTORED_AT);
  const fileRestoreRetry = await file.restoreMergeArchive(ARC_SURVIVOR_ID, ARC_ID, "must-not-create-a-second-copy", "2026-08-17T14:00:00.000Z");
  const d1RestoreRetry = await d1.restoreMergeArchive(ARC_SURVIVOR_ID, ARC_ID, "must-not-create-a-second-copy", "2026-08-17T14:00:00.000Z");
  same("archive restore: retries are idempotent and return the original safe-copy identity", fileRestoreRetry, d1RestoreRetry);
  ok("archive restore: a retry did not mint a second user", fileRestoreRetry?.user_id === ARC_COPY_ID && d1RestoreRetry?.user_id === ARC_COPY_ID
    && (await file.getUser("must-not-create-a-second-copy")) === null && (await d1.getUser("must-not-create-a-second-copy")) === null);

  const restoredGraph = async (store) => ({
    user: await store.getUser(ARC_COPY_ID),
    sessions: await store.listSessions(ARC_COPY_ID, { includeVoided: true, includeQuarantined: true }),
    bodyweights: await store.listBodyweights(ARC_COPY_ID),
    checkins: await store.listCheckins(ARC_COPY_ID),
    nutrition: await store.listNutritionLog(ARC_COPY_ID),
  });
  const fileRestoredGraph = await restoredGraph(file);
  const d1RestoredGraph = await restoredGraph(d1);
  same("archive restore: file/D1 materialize exactly the same safe source graph", fileRestoredGraph, d1RestoredGraph);
  const recoveredEverySourceRow = (state) => {
    const restoredWork = state.sessions.find((s) => s.lucky_seed === "arc-session-work");
    return state.user?.top_level_source_only?.proof === "full-document-preserved"
      && state.user?.custom_exercises?.[0]?.id === "arc-curl"
      && state.user?.profile?.user_id === ARC_COPY_ID
      && state.user?.profile?.disclaimer_ack?.version === "health-v1"
      // No live subscription/social state follows a historical copy.
      && !Object.hasOwn(state.user?.profile ?? {}, "celebration")
      && !Object.hasOwn(state.user?.profile ?? {}, "commitment")
      && !Object.hasOwn(state.user?.profile ?? {}, "following")
      && !Object.hasOwn(state.user?.profile ?? {}, "challenges")
      && state.sessions.length === 2
      && !state.sessions.some((s) => s.session_id === "arc-session-work" || s.session_id === "arc-session-voided")
      && restoredWork?.session_id !== "arc-session-work"
      && restoredWork?.lucky_seed === "arc-session-work"
      && state.bodyweights.find((x) => x.date === "2026-06-15")?.kg === 71
      && state.checkins.find((x) => x.date === "2026-06-16")?.sleep === 4
      && state.nutrition.find((x) => x.date === "2026-06-17")?.kcal === 1900;
  };
  ok("archive restore: the source document, sessions, and collision-losing daily rows are all recovered (file)", recoveredEverySourceRow(fileRestoredGraph));
  ok("archive restore: the source document, sessions, and collision-losing daily rows are all recovered (D1)", recoveredEverySourceRow(d1RestoredGraph));
  same("archive restore: the survivor is byte-for-byte unchanged by creating a separate copy (file)", fileSurvivorBeforeRestore, await survivorSnapshot(file));
  same("archive restore: the survivor is byte-for-byte unchanged by creating a separate copy (D1)", d1SurvivorBeforeRestore, await survivorSnapshot(d1));
  const noExternalCapabilitiesOnCopy = async (store) =>
    !(await store.listPushSubscriptions()).some((s) => s.user_id === ARC_COPY_ID)
      && (await store.getShareIdForUser(ARC_COPY_ID)) === null;
  ok("archive restore: no push subscription or share is reactivated for the copy (file)", await noExternalCapabilitiesOnCopy(file));
  ok("archive restore: no push subscription or share is reactivated for the copy (D1)", await noExternalCapabilitiesOnCopy(d1));

  // `ensureExtensions` must be scoped to an individual D1 binding. The primary
  // shim above has already initialized it; a fresh binding with all extension
  // tables removed should still create shares, cheer tallies, deliveries, and
  // merge archives rather than inheriting a stale module-global ready promise.
  const extensionSchema = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "schema.sql"), "utf8");
  const secondShim = createD1Shim();
  secondShim.exec(extensionSchema);
  secondShim.exec("DROP TABLE merge_archives; DROP TABLE push_deliveries; DROP TABLE share_cheers; DROP TABLE shares;");
  const secondD1 = createD1Store(secondShim);
  let freshBindingError = null;
  let freshBindingTables = [];
  try {
    await secondD1.saveUser("fresh-ext-from", {});
    await secondD1.saveUser("fresh-ext-to", {});
    await secondD1.createShare("fresh-ext-from", "fresh-ext-share", 1);
    await secondD1.addShareCheer("fresh-ext-share");
    await secondD1.savePushSubscription("fresh-ext-from", { endpoint: "https://push/fresh-binding", keys: {} });
    await secondD1.markPushDelivered("https://push/fresh-binding", 1);
    await secondD1.reassignUserData("fresh-ext-from", "fresh-ext-to", { archiveId: "fresh-ext-archive", now: "2026-08-17T15:00:00.000Z" });
    await secondD1.listMergeArchives("fresh-ext-to");
    freshBindingTables = (await secondShim.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('shares', 'share_cheers', 'push_deliveries', 'merge_archives') ORDER BY name").all()).results.map((r) => r.name);
  } catch (error) {
    freshBindingError = error;
  }
  ok("D1 extensions: a second binding recreates every extension table after they were dropped", !freshBindingError
    && freshBindingTables.join(",") === "merge_archives,push_deliveries,share_cheers,shares");

  // A stale device can have passed a route's getUser() check just before a merge
  // commits. Child writers therefore fence tombstoned owners at the store boundary:
  // they must not recreate a source-only record that the archive transaction could
  // not have captured. Missing owner rows remain legal low-level fixture inputs;
  // this specifically protects an existing _merged_into tombstone.
  const FENCE_FROM = "fence-from", FENCE_TO = "fence-to";
  for (const store of [file, d1]) {
    await store.saveUser(FENCE_FROM, { profile: {} });
    await store.saveUser(FENCE_TO, { profile: {} });
    await store.reassignUserData(FENCE_FROM, FENCE_TO, { archiveId: "fence-archive", now: "2026-08-17T16:00:00.000Z" });
  }
  const staleChildWrites = async (store) => ({
    session: await store.addSession(FENCE_FROM, { session_id: "fence-late-session", date: "2026-08-17T16:01:00.000Z", sets: [] }),
    bodyweight: await store.addBodyweight(FENCE_FROM, { date: "2026-08-17", kg: 80 }),
    checkin: await store.addCheckin(FENCE_FROM, { date: "2026-08-17", energy: 4 }),
    nutrition: await store.addNutritionLog(FENCE_FROM, { date: "2026-08-17", kcal: 2000 }),
    push: await store.savePushSubscription(FENCE_FROM, { endpoint: "https://push/fence-late", keys: {} }),
    share: await store.createShare(FENCE_FROM, "fence-late-share", 1),
  });
  const fileStaleWrites = await staleChildWrites(file);
  const d1StaleWrites = await staleChildWrites(d1);
  same("tombstone writer fence: file/D1 refuse every stale child write identically", fileStaleWrites, d1StaleWrites);
  ok("tombstone writer fence: stale writes cannot recreate source rows or capabilities (file)",
    (await file.listSessions(FENCE_FROM, { includeVoided: true, includeQuarantined: true })).length === 0
      && (await file.listBodyweights(FENCE_FROM)).length === 0
      && (await file.listCheckins(FENCE_FROM)).length === 0
      && (await file.listNutritionLog(FENCE_FROM)).length === 0
      && !(await file.listPushSubscriptions()).some((s) => s.endpoint === "https://push/fence-late")
      && (await file.getShareIdForUser(FENCE_FROM)) == null);
  ok("tombstone writer fence: stale writes cannot recreate source rows or capabilities (D1)",
    (await d1.listSessions(FENCE_FROM, { includeVoided: true, includeQuarantined: true })).length === 0
      && (await d1.listBodyweights(FENCE_FROM)).length === 0
      && (await d1.listCheckins(FENCE_FROM)).length === 0
      && (await d1.listNutritionLog(FENCE_FROM)).length === 0
      && !(await d1.listPushSubscriptions()).some((s) => s.endpoint === "https://push/fence-late")
      && (await d1.getShareIdForUser(FENCE_FROM)) == null);

  // --- the merge PRECONDITION, in both stores ---------------------------------
  // The file store gained "refuse if either side is missing or already a
  // tombstone" and D1 did not, so D1's batch ran unconditionally: the whole source
  // graph moved onto an id getUser resolves to null, and the source was tombstoned
  // anyway. Reachable as a race between the route's getUser and this call.
  for (const [label, s0] of [["file", file], ["D1", d1]]) {
    await s0.saveUser("pre-live", { profile: { user_id: "pre-live" } });
    await s0.saveUser("pre-src", { profile: { user_id: "pre-src" } });
    await s0.addSession("pre-src", { session_id: `pre-s-${label}`, date: "2026-08-10T10:00:00.000Z", sets: [] });

    // (a) target does not exist at all
    ok(`merge precondition: a missing target is REFUSED, not merged into (${label})`,
      (await s0.reassignUserData("pre-src", "pre-ghost")) === null);
    ok(`merge precondition: a refused merge moves nothing and tombstones nobody (${label})`,
      (await s0.listSessions("pre-src", { includeVoided: true, includeQuarantined: true })).length === 1
      && (await s0.getUser("pre-src")) != null);

    // (b) target is a tombstone
    await s0.saveUser("pre-dead", { profile: { user_id: "pre-dead" } });
    await s0.reassignUserData("pre-dead", "pre-live", { archiveId: `pre-arc-${label}`, now: "2026-08-11T10:00:00.000Z" });
    ok(`merge precondition: a TOMBSTONED target is refused (${label})`,
      (await s0.reassignUserData("pre-src", "pre-dead")) === null);

    // (c) source is already a tombstone — the double merge. The archive INSERT was
    // already guarded; the tombstone UPDATE beside it was not, so it re-pointed
    // `_merge_archive_id` at an archive that had never been written.
    const beforeArchives = (await s0.listMergeArchives("pre-live")).length;
    ok(`merge precondition: an already-merged SOURCE is refused (${label})`,
      (await s0.reassignUserData("pre-dead", "pre-live", { archiveId: `pre-arc2-${label}` })) === null);
    ok(`merge precondition: a refused double merge writes no second archive (${label})`,
      (await s0.listMergeArchives("pre-live")).length === beforeArchives);
    // The surviving pointer must still name the archive that actually exists.
    const arcIds = new Set((await s0.listMergeArchives("pre-live")).map((a) => a.archive_id));
    ok(`merge precondition: the source's archive pointer still names a REAL archive (${label})`,
      arcIds.has(`pre-arc-${label}`) && !arcIds.has(`pre-arc2-${label}`));

    // A legitimate merge still succeeds and still reports counts (the refusal
    // signal must not swallow the normal path).
    const good = await s0.reassignUserData("pre-src", "pre-live", { archiveId: `pre-arc3-${label}`, now: "2026-08-12T10:00:00.000Z" });
    ok(`merge precondition: a legitimate merge still returns its moved counts (${label})`,
      good != null && good.sessions === 1);
  }

  // --- addSession's return must describe what the store ACTUALLY did -----------
  // NOT a parity assertion, deliberately. The session_id SCOPE divergence is
  // analysed and locked in above ("uniqueness is scoped PER USER" vs D1's
  // database-wide PRIMARY KEY) and both stores still land on exactly one surviving
  // copy of the event — that stays as recorded, and a later sweep should not
  // "fix" it (attempting to, here, broke the two tests that exist to lock it in).
  // What WAS wrong is narrower and was D1-only: on a cross-user collision D1
  // absorbed the write via ON CONFLICT DO NOTHING and still returned the session,
  // so the route built a full recap — day number, PRs, XP — from a row it had not
  // stored. Each store must now answer the question truthfully ABOUT ITSELF.
  for (const [label, s0] of [["file", file], ["D1", d1]]) {
    await s0.saveUser(`col-a-${label}`, { profile: { user_id: `col-a-${label}` } });
    await s0.saveUser(`col-b-${label}`, { profile: { user_id: `col-b-${label}` } });
    const sid = `col-shared-${label}`;
    const row = { session_id: sid, date: "2026-08-10T10:00:00.000Z", sets: [] };
    ok(`addSession: a first write is reported as stored (${label})`,
      (await s0.addSession(`col-a-${label}`, row)) != null);
    ok(`addSession: the owner's own replay stays idempotent-success (${label})`,
      (await s0.addSession(`col-a-${label}`, row)) != null);
    // The invariant that matters, and it holds for BOTH stores: the return value
    // and the stored state agree. Where the row lands the store says so; where it
    // does not, the store says null — never "here is your workout" over nothing.
    const returned = await s0.addSession(`col-b-${label}`, row);
    const landed = (await s0.listSessions(`col-b-${label}`, { includeVoided: true, includeQuarantined: true })).length === 1;
    ok(`addSession: the return value matches whether the row actually landed (${label})`,
      (returned != null) === landed);
  }

  // --- restoreMergeArchive reads a tombstone as ABSENT, in both stores ---------
  // A restored copy is anonymous, so it is itself a legal merge source. Once it is
  // merged away, the file store used to read its retained document straight out of
  // db.users and report a merged-away identity as live, while D1 returned null.
  for (const [label, s0] of [["file", file], ["D1", d1]]) {
    const src = `res-src-${label}`, own = `res-own-${label}`, arc = `res-arc-${label}`;
    await s0.saveUser(own, { profile: { user_id: own } });
    await s0.saveUser(src, { profile: { user_id: src, units: "imperial" }, program: { name: "Archived source programme" } });
    await s0.reassignUserData(src, own, { archiveId: arc, now: "2026-08-13T10:00:00.000Z" });
    const first = await s0.restoreMergeArchive(own, arc, `res-copy-${label}`, "2026-08-13T11:00:00.000Z");
    ok(`restore: the fresh copy reports its own programme (${label})`, first?.program_name === "Archived source programme");
    // now merge the restored copy away, then ask again
    await s0.saveUser(`res-next-${label}`, { profile: { user_id: `res-next-${label}` } });
    await s0.reassignUserData(first.user_id, `res-next-${label}`, { archiveId: `res-arc2-${label}`, now: "2026-08-14T10:00:00.000Z" });
    const again = await s0.restoreMergeArchive(own, arc, `res-copy2-${label}`, "2026-08-14T11:00:00.000Z");
    ok(`restore: a merged-away restored copy reads as absent, not live (${label})`,
      again?.program_name === null && again?.units === null);
  }

  // --- the SQL prefilter must be a SUPERSET of the JS predicate ---------------
  // D1 narrows on SHAPE in SQL so the timing rules can be enforced without shipping
  // every session blob to the Worker. That puts a second, weaker copy of a rule in
  // a second language — the exact arrangement that lets a gate and its product
  // drift apart. It is only safe while SQL never says "no" to a row the JS
  // predicate would keep, so assert precisely that, over the awkward cases.
  const shapeRows = [
    ["plain calendar day", "2026-08-10", null],
    ["full ISO in UTC", "2026-08-11T10:00:00.000Z", null],
    // The reason the prefilter carries a day of headroom: this row's leading
    // calendar day is the 12th while the instant it denotes is the 11th in UTC.
    ["full ISO with a +13:00 offset", "2026-08-12T01:00:00+13:00", null],
    ["a day that does not exist", "2026-02-29", null],
    ["free text", "yesterday", null],
    ["empty", "", null],
    ["far future", "2099-01-01T00:00:00.000Z", null],
    ["valid instant, impossible local_date", "2026-08-09T10:00:00.000Z", "2026-13-01"],
    ["valid instant, valid local_date", "2026-08-08T10:00:00.000Z", "2026-08-08"],
    // THE case the prefilter's day of headroom exists for, pinned to SHAPE_NOW's
    // ceiling. Its leading calendar day (2030-06-03) is one past the UTC ceiling
    // the JS predicate uses, while the instant it denotes (2030-06-02T12:00Z) is
    // inside it — so JS keeps this row and a prefilter without headroom would drop
    // it, breaking the superset property silently. Without this fixture the
    // headroom can be deleted and every other assertion still passes.
    ["at the ceiling, +13:00 offset — derivable, but its calendar prefix is a day later", "2030-06-03T01:00:00+13:00", null],
  ];
  // Deliberately NOT "around now": if both stores quietly used their own clock,
  // a fixture dated today would agree by coincidence and prove nothing. Pinning it
  // years ahead makes the far-future row genuinely far-future for D1 and — only if
  // the parameter is really honoured — for the file store too.
  const SHAPE_NOW = Date.parse("2030-06-01T12:00:00.000Z");
  for (const [i, [label, date, local_date]] of shapeRows.entries()) {
    const row = { session_id: `shape-${i}`, date, ...(local_date ? { local_date } : {}), sets: [] };
    await file.saveUser(`shape-u-${i}`, { profile: { user_id: `shape-u-${i}` } });
    await d1.saveUser(`shape-u-${i}`, { profile: { user_id: `shape-u-${i}` } });
    await file.addSession(`shape-u-${i}`, row);
    await d1.addSession(`shape-u-${i}`, row);
    const f = await file.latestSessionDate(`shape-u-${i}`, SHAPE_NOW);
    const d = await d1.latestSessionDate(`shape-u-${i}`, SHAPE_NOW);
    ok(`prefilter superset: file and D1 agree on "${label}" (${JSON.stringify(f)})`, f === d);
  }
  // ...and the same over ONE user holding all of them at once, so the winner is
  // chosen from a mixed set rather than each row being judged in isolation.
  await file.saveUser("shape-all", { profile: { user_id: "shape-all" } });
  await d1.saveUser("shape-all", { profile: { user_id: "shape-all" } });
  for (const [i, [, date, local_date]] of shapeRows.entries()) {
    const row = { session_id: `shape-all-${i}`, date, ...(local_date ? { local_date } : {}), sets: [] };
    await file.addSession("shape-all", row);
    await d1.addSession("shape-all", row);
  }
  const fileAll = await file.latestSessionDate("shape-all", SHAPE_NOW);
  const d1All = await d1.latestSessionDate("shape-all", SHAPE_NOW);
  ok("prefilter superset: the latest derivable row is the same in both stores", fileAll === d1All);
  ok("prefilter superset: it is a REAL answer, not both stores returning null (a vacuous pass)", fileAll != null);
  ok("prefilter superset: the far-future and malformed rows never win", fileAll === "2030-06-03T01:00:00+13:00");

  // listAccountLastSessions is the sweep's first statement; it must agree too.
  await file.saveAccount("shape@example.com", "shape-all", "2026-08-01T00:00:00.000Z");
  await d1.saveAccount("shape@example.com", "shape-all", "2026-08-01T00:00:00.000Z");
  const fileAcc = (await file.listAccountLastSessions(SHAPE_NOW)).find((a) => a.user_id === "shape-all");
  const d1Acc = (await d1.listAccountLastSessions(SHAPE_NOW)).find((a) => a.user_id === "shape-all");
  same("prefilter superset: listAccountLastSessions agrees across stores", fileAcc, d1Acc);

  console.log(`\n${pass} store-d1 parity test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(tmpPath); } catch {}
}
process.exit(fail ? 1 : 0);
