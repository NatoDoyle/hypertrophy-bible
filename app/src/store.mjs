// Storage interface + a file-backed implementation for local development.
// The Hono app depends only on this async interface, so production can swap in a
// D1-backed store (see worker.mjs) with zero route changes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { mergeUserProfile } from "./merge-profile.mjs";

export function createFileStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  let db = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { users: {}, sessions: {}, bodyweights: {}, accounts: {}, magic_links: {}, checkins: {} };
  db.accounts ??= {};        // tolerate stores written before email backup existed
  db.magic_links ??= {};
  db.checkins ??= {};
  db.shares ??= {};          // opt-in shareable progress cards (share_id → user_id)
  db.share_cheers ??= {};    // public "cheer" tally per share (share_id → count)
  const flush = () => writeFileSync(path, JSON.stringify(db, null, 2));
  // Match the D1 store's "ORDER BY date ASC, rowid ASC": chronological, with
  // insertion order as a stable tiebreak. Keeps coach output identical on both.
  const byDate = (arr) =>
    (arr ?? []).map((x, i) => [x, i]).sort((a, b) => {
      const da = a[0].date ?? "", db_ = b[0].date ?? "";
      return da < db_ ? -1 : da > db_ ? 1 : a[1] - b[1];
    }).map((p) => p[0]);

  return {
    async getUser(id) { return db.users[id] ?? null; },
    async saveUser(id, user) { db.users[id] = user; flush(); return user; },
    // Read-modify-write with last-writer-protection: mutate a copy and commit.
    // (Node is single-threaded so this can't interleave; the D1 store does a real
    // compare-and-swap. Same signature, so routes are identical on both.)
    async updateUser(id, mutator) {
      const cur = db.users[id];
      if (cur === undefined || cur === null) return null;
      const next = mutator(JSON.parse(JSON.stringify(cur)));
      db.users[id] = next; flush(); return next;
    },
    async listSessions(id) { return byDate(db.sessions[id]); },
    async addSession(id, session) {
      const list = (db.sessions[id] ??= []);
      // Idempotent on session_id: a replayed offline workout is a no-op.
      if (session.session_id && list.some((s) => s.session_id === session.session_id)) return session;
      list.push(session); flush(); return session;
    },
    async listBodyweights(id) { return byDate(db.bodyweights[id]); },
    async addBodyweight(id, entry) {
      // One weigh-in per day (mirrors check-ins): a replayed offline log with the
      // same date replaces rather than duplicating, so the trend can't be skewed.
      // Replace ALL same-date rows (parity with D1's DELETE-then-INSERT): a merge
      // can leave two rows on one date, and replacing only the first kept a
      // duplicate forever.
      db.bodyweights[id] = (db.bodyweights[id] ?? []).filter((b) => b.date !== entry.date);
      db.bodyweights[id].push(entry);
      flush(); return entry;
    },
    async listCheckins(id) { return byDate(db.checkins[id]); },
    async addCheckin(id, entry) {
      const arr = (db.checkins[id] ??= []);
      const i = arr.findIndex((c) => c.date === entry.date); // one per day: replace
      if (i >= 0) arr[i] = entry; else arr.push(entry);
      flush();
      return entry;
    },
    // --- nutrition daily intake log (kcal + macros), one row per day ---
    async listNutritionLog(id) { return byDate(db.nutrition_logs?.[id]); },
    async addNutritionLog(id, entry) {
      db.nutrition_logs ??= {};
      const arr = (db.nutrition_logs[id] ??= []);
      const i = arr.findIndex((e) => e.date === entry.date); // one per day: replace
      if (i >= 0) arr[i] = entry; else arr.push(entry);
      flush();
      return entry;
    },

    // --- passwordless email backup ---
    async getAccountByEmail(email) { return db.accounts[email] ?? null; },
    async getAccountByUserId(userId) {
      return Object.values(db.accounts).find((a) => a.user_id === userId) ?? null;
    },
    // Merge-on-restore: move ALL of one user's data onto another, then drop the
    // empty shell. Sessions, bodyweights, checkins, AND the custom-exercise
    // library are moved — otherwise moved sets reference custom-* ids that no
    // longer resolve (silent volume/PR corruption) and today's check-in is lost.
    async reassignUserData(fromId, toId) {
      // Count what ACTUALLY lands on the target (after same-id / same-date dedup),
      // not the raw source lengths — otherwise this diverges from D1, which returns
      // the true rows changed. Parity matters the moment any surface shows "N imported".
      const moved = { sessions: 0, bodyweights: 0 };
      // custom exercises live on the user doc → migrate before deleting it (dedup by id).
      const fromU = db.users[fromId], toU = db.users[toId];
      if (fromU?.custom_exercises?.length && toU) {
        toU.custom_exercises = toU.custom_exercises || [];
        const have = new Set(toU.custom_exercises.map((x) => x.id));
        for (const ex of fromU.custom_exercises) if (!have.has(ex.id)) { toU.custom_exercises.push(ex); have.add(ex.id); }
      }
      // Streak-freeze balance, pause history, partner list, commitment, and
      // challenge history all live on the user doc too — merge them additively
      // (see merge-profile.mjs) before the doc is deleted below, or they're lost.
      if (toU) mergeUserProfile(fromU, toU);
      if (db.sessions[fromId]?.length) {
        // Skip duplicate session_ids (parity with D1's PRIMARY KEY): a replayed
        // queue item on both users would otherwise double-count volume and PRs.
        const dst = (db.sessions[toId] ??= []);
        const have = new Set(dst.map((s) => s.session_id));
        for (const s of db.sessions[fromId]) if (!s.session_id || !have.has(s.session_id)) { dst.push(s); moved.sessions++; if (s.session_id) have.add(s.session_id); }
      }
      if (db.bodyweights[fromId]?.length) {
        // One weigh-in per day survives the merge: keep the TARGET's same-date row.
        const dst = (db.bodyweights[toId] ??= []);
        const dates = new Set(dst.map((b) => b.date));
        for (const b of db.bodyweights[fromId]) if (!dates.has(b.date)) { dst.push(b); moved.bodyweights++; dates.add(b.date); }
      }
      // checkins: keep the target's row on a same-day conflict.
      if (db.checkins[fromId]?.length) {
        const dst = (db.checkins[toId] ??= []);
        const dates = new Set(dst.map((c) => c.date));
        for (const c of db.checkins[fromId]) if (!dates.has(c.date)) dst.push(c);
      }
      // Push subscriptions follow the user, or the merged-away device's reminders
      // are orphaned onto a deleted user and the daily sweep prunes them — the
      // restoring device silently loses reminders while its UI still shows them on.
      for (const ep of Object.keys(db.push_subscriptions ?? {})) if (db.push_subscriptions[ep].user_id === fromId) db.push_subscriptions[ep].user_id = toId;
      // nutrition logs follow the user, keeping the target's row on a same-day clash
      if (db.nutrition_logs?.[fromId]?.length) {
        const dst = (db.nutrition_logs[toId] ??= []);
        const dates = new Set(dst.map((e) => e.date));
        for (const e of db.nutrition_logs[fromId]) if (!dates.has(e.date)) dst.push(e);
      }
      // Shares follow the user too, or the merged-away user's share row points at a
      // DELETED user — a dead public link + orphaned cheers (the same trap the push
      // move above avoids). Reassign it to the survivor so a link they already
      // distributed keeps working; if the survivor already has one (UNIQUE per user),
      // drop the merged-away share + its cheers instead.
      const fromShareId = Object.keys(db.shares ?? {}).find((sid) => db.shares[sid].user_id === fromId);
      if (fromShareId) {
        const toHasShare = Object.values(db.shares).some((r) => r.user_id === toId);
        if (toHasShare) { delete db.shares[fromShareId]; delete (db.share_cheers ??= {})[fromShareId]; }
        else {
          db.shares[fromShareId].user_id = toId; // share_id + its cheers (keyed by share_id) preserved
          // `to` never had a share, so its OWN cheers_pushed/cheers_seen watermarks
          // (0, or stale leftovers from a share it revoked earlier) don't describe
          // this inherited share's history — without this, the push sweep and the
          // in-app "N new cheers" banner would both read the share's full lifetime
          // cheer count as brand new the instant `to` inherits it, even though
          // `from` already saw/was pushed every one of them pre-merge.
          if (toU) toU.profile = { ...(toU.profile ?? {}), cheers_pushed: fromU?.profile?.cheers_pushed ?? 0, cheers_seen: fromU?.profile?.cheers_seen ?? 0 };
        }
      }
      delete db.nutrition_logs?.[fromId];
      delete db.sessions[fromId];
      delete db.bodyweights[fromId];
      delete db.checkins[fromId];
      delete db.users[fromId];
      flush();
      return moved;
    },
    async saveAccount(email, user_id, verified_at) {
      db.accounts[email] = {
        email, user_id, verified_at: verified_at ?? null,
        created_at: db.accounts[email]?.created_at ?? new Date().toISOString(),
      };
      flush();
      return db.accounts[email];
    },
    // --- Web Push subscriptions (device reminders) ---
    async savePushSubscription(user_id, sub) {
      db.push_subscriptions ??= {};
      db.push_subscriptions[sub.endpoint] = { endpoint: sub.endpoint, user_id, p256dh: sub.keys?.p256dh ?? null, auth: sub.keys?.auth ?? null, created_at: db.push_subscriptions[sub.endpoint]?.created_at ?? Date.now() };
      flush();
      return db.push_subscriptions[sub.endpoint];
    },
    // userId scopes the delete to its owner (route callers); the internal sweep
    // passes null to prune unconditionally. A userId that doesn't match is a no-op.
    async deletePushSubscription(endpoint, userId = null) {
      const row = db.push_subscriptions?.[endpoint];
      if (row && (userId == null || row.user_id === userId)) { delete db.push_subscriptions[endpoint]; flush(); }
    },
    async listPushSubscriptions() { return Object.values(db.push_subscriptions ?? {}); },
    async latestSessionDate(user_id) {
      return (db.sessions[user_id] ?? []).reduce((m, s) => (s.date && (!m || s.date > m) ? s.date : m), null);
    },
    // Comeback-nudge sweep: every email-bound user with their latest session
    // date (null when they've never logged one). Mirrors the D1 LEFT JOIN.
    async listAccountLastSessions() {
      return Object.values(db.accounts).map((a) => ({
        email: a.email, user_id: a.user_id,
        last_date: (db.sessions[a.user_id] ?? []).reduce((m, s) => (s.date && (!m || s.date > m) ? s.date : m), null),
      }));
    },
    async createMagicLink(row) { db.magic_links[row.token_hash] = row; flush(); return row; },
    async getMagicLink(tokenHash) { return db.magic_links[tokenHash] ?? null; },
    // Atomic single-use flip: returns true only if THIS call consumed the link
    // (0 -> 1). A second concurrent consume gets false, so a token can't be
    // spent twice (and a duplicate merge grant can't be minted).
    async markMagicLinkUsed(tokenHash) {
      const link = db.magic_links[tokenHash];
      if (link && !link.used) { link.used = 1; flush(); return true; }
      return false;
    },
    async countRecentLinks(rlKey, sinceMs) {
      return Object.values(db.magic_links).filter((l) => l.rl_key === rlKey && l.created_at >= sinceMs).length;
    },
    async countRecentByIp(ip, sinceMs) {
      return Object.values(db.magic_links).filter((l) => l.ip === ip && l.created_at >= sinceMs).length;
    },

    // --- Shareable progress cards (opt-in social) — parity with store-d1.mjs ---
    // One share per user: creating rotates (revokes the old token) by first dropping
    // any existing row for this user, then inserting the new share_id.
    async createShare(userId, shareId, now) {
      for (const [sid, row] of Object.entries(db.shares)) if (row.user_id === userId) delete db.shares[sid];
      db.shares[shareId] = { share_id: shareId, user_id: userId, created_at: now };
      flush(); return shareId;
    },
    async getShareUserId(shareId) { return db.shares[shareId]?.user_id ?? null; },
    async getShareIdForUser(userId) {
      const hit = Object.values(db.shares).find((r) => r.user_id === userId);
      return hit?.share_id ?? null;
    },
    async deleteShare(userId) {
      // Revoking a share drops its cheer tally too — the count belongs to that
      // share_id, so it must die with it (no orphaned rows; a future share is fresh).
      for (const [sid, row] of Object.entries(db.shares)) if (row.user_id === userId) { delete db.shares[sid]; delete (db.share_cheers ??= {})[sid]; }
      flush();
    },
    // Public "cheer" tally — parity with store-d1.mjs (bounded).
    async addShareCheer(shareId) {
      db.share_cheers ??= {};
      db.share_cheers[shareId] = Math.min((db.share_cheers[shareId] ?? 0) + 1, 1000000);
      flush(); return db.share_cheers[shareId];
    },
    async getShareCheers(shareId) { return (db.share_cheers ?? {})[shareId] ?? 0; },
  };
}
