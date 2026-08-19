// Storage interface + a file-backed implementation for local development.
// The Hono app depends only on this async interface, so production can swap in a
// D1-backed store (see worker.mjs) with zero route changes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { mergeUserProfile } from "./merge-profile.mjs";
import { isDerivableSession, parseSessionInstant, sessionTimingIssue } from "./session-time.mjs";
import { activationFunnel, archiveSnapshot, archiveSummary, clone, restoredSession, restoredUser } from "./merge-archive.mjs";

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
  db.push_subscriptions ??= {};
  db.push_deliveries ??= {};
  db.nutrition_logs ??= {};
  db.merge_archives ??= {};  // immutable pre-merge source graphs (archive_id → archive)
  const flush = () => writeFileSync(path, JSON.stringify(db, null, 2));
  // Match the D1 store's "ORDER BY date ASC, rowid ASC": chronological, with
  // insertion order as a stable tiebreak. Keeps coach output identical on both.
  const byDate = (arr) =>
    (arr ?? []).map((x, i) => [x, i]).sort((a, b) => {
      const da = a[0].date ?? "", db_ = b[0].date ?? "";
      return da < db_ ? -1 : da > db_ ? 1 : a[1] - b[1];
    }).map((p) => p[0]);
  // A merge's source identity becomes a tombstone. Direct store callers exist in
  // tests and background code, so do not rely solely on a route's earlier
  // getUser() check: a stale device must not recreate a source-only child row
  // after its complete graph has already been archived and moved.
  const isTombstoned = (id) => !!db.users[id]?._merged_into;

  return {
    // A merge TOMBSTONES the from-row instead of deleting it (BLOCKERS #6b,
    // option (b), Wave 211) — every reader treats a tombstone as absent, so the
    // app behaves exactly as if the row were gone (404 "unknown user"), but the
    // destructive primitive is gone: nothing can permanently destroy a user row,
    // and a mistaken or malicious merge leaves an audit trail (_merged_into).
    async getUser(id) { const u = db.users[id]; return !u || u._merged_into ? null : u; },
    async saveUser(id, user) { db.users[id] = user; flush(); return user; },
    // Read-modify-write with last-writer-protection: mutate a copy and commit.
    // (Node is single-threaded so this can't interleave; the D1 store does a real
    // compare-and-swap. Same signature, so routes are identical on both.)
    async updateUser(id, mutator) {
      const cur = db.users[id];
      if (cur === undefined || cur === null || cur._merged_into) return null; // tombstone = absent
      const next = mutator(JSON.parse(JSON.stringify(cur)));
      db.users[id] = next; flush(); return next;
    },
    // Voided sessions are filtered HERE, at the single source, not at each of the
    // dozen call sites — a per-call-site filter is lesson 1 waiting to happen (one
    // consumer forgotten = a corrected workout still counting toward a streak, a
    // stall, or a PR). `includeVoided` is for the history screen alone, which has to
    // show a voided session in order to offer un-voiding it.
    async listSessions(id, { includeVoided = false, includeQuarantined = false, nowMs = Date.now() } = {}) {
      const all = byDate(db.sessions[id]);
      return all
        .filter((s) => includeVoided || !s.voided_at)
        .filter((s) => includeQuarantined || isDerivableSession(s, nowMs))
        .map((s) => {
          const timing_issue = sessionTimingIssue(s, nowMs);
          return timing_issue ? { ...s, timing_issue } : s;
        });
    },
    async addSession(id, session) {
      if (isTombstoned(id)) return null;
      const list = (db.sessions[id] ??= []);
      // Idempotent on session_id: a replayed offline workout is a no-op.
      if (session.session_id && list.some((s) => s.session_id === session.session_id)) return session;
      list.push(session); flush(); return session;
    },
    // Edit or void ONE logged session in place. The mutator gets a deep copy and
    // returns the replacement; returning null/undefined means "leave it alone".
    // Returns the stored session (updated or not), or null when there is no such
    // session for this user — so a caller can tell "declined" from "not found".
    // session_id is the identity: never address a session by position (lesson 11).
    async updateSession(id, sessionId, mutator) {
      if (isTombstoned(id)) return null;
      const list = db.sessions[id] ?? [];
      const i = list.findIndex((s) => s.session_id === sessionId);
      if (i < 0) return null;
      const next = mutator(JSON.parse(JSON.stringify(list[i])));
      if (next == null) return list[i];
      list[i] = next; flush(); return next;
    },
    async listBodyweights(id) { return byDate(db.bodyweights[id]); },
    async addBodyweight(id, entry) {
      if (isTombstoned(id)) return null;
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
      if (isTombstoned(id)) return null;
      const arr = (db.checkins[id] ??= []);
      const i = arr.findIndex((c) => c.date === entry.date); // one per day: replace
      if (i >= 0) arr[i] = entry; else arr.push(entry);
      flush();
      return entry;
    },
    // --- nutrition daily intake log (kcal + macros), one row per day ---
    async listNutritionLog(id) { return byDate(db.nutrition_logs?.[id]); },
    async addNutritionLog(id, entry) {
      if (isTombstoned(id)) return null;
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
    // Merge-on-restore: capture the COMPLETE source graph before moving anything.
    // The survivor receives the same additive merge it always did; the archive is
    // what makes collision-losing rows and source-only fields recoverable later.
    async reassignUserData(fromId, toId, { archiveId = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
      // Count what ACTUALLY lands on the target (after same-id / same-date dedup),
      // not the raw source lengths — otherwise this diverges from D1, which returns
      // the true rows changed. Parity matters the moment any surface shows "N imported".
      const moved = { sessions: 0, bodyweights: 0 };
      const fromU = db.users[fromId], toU = db.users[toId];
      // A REFUSAL, reported as null — never as an empty `moved`. Those two states
      // are opposites that used to be byte-identical: "the source had nothing to
      // move" is a successful merge, while "one side vanished or is already a
      // tombstone" means nothing happened and the caller's single-use grant bought
      // it nothing. The route can only roll back or apologise for what it can see
      // (lesson 46), and `null` is the same not-possible signal `updateUser`
      // already returns, so callers need no new vocabulary.
      if (!fromU || fromU._merged_into || !toU || toU._merged_into) return null;

      const sourceSubs = Object.values(db.push_subscriptions ?? {}).filter((s) => s.user_id === fromId);
      const sourceShares = Object.entries(db.shares ?? {})
        .filter(([, row]) => row.user_id === fromId)
        .map(([share_id, row]) => ({ ...row, share_id, cheers: db.share_cheers?.[share_id] ?? 0 }));
      db.merge_archives[archiveId] = {
        archive_id: archiveId,
        owner_user_id: toId,
        source_user_id: fromId,
        created_at: now,
        state: "available",
        restored_user_id: null,
        restored_at: null,
        snapshot: archiveSnapshot({
          user: fromU,
          sessions: db.sessions[fromId] ?? [],
          bodyweights: db.bodyweights[fromId] ?? [],
          checkins: db.checkins[fromId] ?? [],
          nutrition_logs: db.nutrition_logs[fromId] ?? [],
          push_subscriptions: sourceSubs,
          push_deliveries: sourceSubs.map((s) => ({ endpoint: s.endpoint, last_ok_at: db.push_deliveries?.[s.endpoint] ?? null })).filter((x) => x.last_ok_at != null),
          shares: sourceShares,
          magic_links: Object.values(db.magic_links ?? {}).filter((l) => l.user_id === fromId),
        }),
      };
      // A survivor may itself later merge into another account. Recovery rights
      // follow that survivor, never the now-hidden intermediate identity.
      for (const archive of Object.values(db.merge_archives)) if (archive.owner_user_id === fromId) archive.owner_user_id = toId;

      // custom exercises live on the user doc → migrate before tombstoning it (dedup by id).
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
      // A tombstone stays externally absent, but preserves the source document as
      // a row-level audit trail in addition to the full graph archive.
      db.users[fromId] = { ...clone(fromU), _merged_into: toId, _merged_at: now, _merge_archive_id: archiveId };
      flush();
      return moved;
    },
    async listMergeArchives(ownerId) {
      return Object.values(db.merge_archives ?? {})
        .filter((a) => a.owner_user_id === ownerId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map(archiveSummary);
    },
    async restoreMergeArchive(ownerId, archiveId, restoredUserId = crypto.randomUUID(), now = new Date().toISOString()) {
      const archive = db.merge_archives?.[archiveId];
      if (!archive || archive.owner_user_id !== ownerId) return null;
      // Once claimed, every retry returns the same identity. The file store's
      // synchronous mutation plus one flush is its all-or-nothing transaction.
      const id = archive.restored_user_id ?? restoredUserId;
      if (archive.state !== "restored") {
        archive.restored_user_id = id;
        archive.state = "restoring";
        const snap = archive.snapshot ?? {};
        if (!db.users[id]) {
          db.users[id] = restoredUser(snap.user, id);
          db.sessions[id] = (snap.sessions ?? []).map((s, i) => restoredSession(s, archiveId, id, i));
          db.bodyweights[id] = clone(snap.bodyweights ?? []);
          db.checkins[id] = clone(snap.checkins ?? []);
          db.nutrition_logs[id] = clone(snap.nutrition_logs ?? []);
        }
        archive.state = "restored";
        archive.restored_at ??= now;
        flush();
      }
      // Read the restored copy through the SAME tombstone rule getUser applies: a
      // restored copy can itself later be merged away, and D1 resolves that row to
      // null while this store used to read the retained document straight out of
      // `db.users`, reporting a merged-away identity as live. Two stores, two
      // answers, same inputs — the parity break CLAUDE.md names as a bug.
      const restored = await this.getUser(id);
      return {
        user_id: id,
        program_name: restored?.program?.name ?? null,
        units: restored?.profile?.units ?? null,
        archive: archiveSummary(archive),
      };
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
      if (isTombstoned(user_id)) return null;
      db.push_subscriptions ??= {};
      db.push_subscriptions[sub.endpoint] = { endpoint: sub.endpoint, user_id, p256dh: sub.keys?.p256dh ?? null, auth: sub.keys?.auth ?? null, created_at: db.push_subscriptions[sub.endpoint]?.created_at ?? Date.now() };
      flush();
      return db.push_subscriptions[sub.endpoint];
    },
    // userId scopes the delete to its owner (route callers); the internal sweep
    // passes null to prune unconditionally. A userId that doesn't match is a no-op.
    async deletePushSubscription(endpoint, userId = null) {
      const row = db.push_subscriptions?.[endpoint];
      if (row && (userId == null || row.user_id === userId)) {
        delete db.push_subscriptions[endpoint];
        delete db.push_deliveries?.[endpoint];
        flush();
      }
    },
    async listPushSubscriptions() { return Object.values(db.push_subscriptions ?? {}); },
    // Delivery evidence (BLOCKERS #2b): stamped by the push sweep ONLY when a
    // real push service accepted a send (2xx). Kept in a separate map keyed by
    // endpoint — the D1 store mirrors this as its own self-init table. Evidence
    // exists only while that endpoint remains an active subscription.
    async markPushDelivered(endpoint, at) {
      if (db.push_subscriptions?.[endpoint]) {
        (db.push_deliveries ??= {})[endpoint] = at;
        flush();
      }
    },
    // Owner-only aggregates (BLOCKERS #7 — the zero-new-collection proposal):
    // computed entirely from rows this store already holds; counts only, no
    // per-user view, no PII. Valid voided sessions still count as activity, but
    // quarantined timing rows must not distort aggregate adoption/retention.
    async stats(now = Date.now()) {
      const d7 = now - 7 * 86400000, d14 = now - 14 * 86400000, d28 = now - 28 * 86400000;
      const safeMs = (s) => isDerivableSession(s, now) ? parseSessionInstant(s.date) : null;
      const activeIn = (from, to) => {
        const s = new Set();
        for (const [uid, list] of Object.entries(db.sessions ?? {}))
          if (list.some((x) => { const ms = safeMs(x); return ms != null && ms >= from && (!to || ms < to); })) s.add(uid);
        return s;
      };
      const cur = activeIn(d7, null), prev = activeIn(d14, d7);
      let sessions_7d = 0, sessions_28d = 0, users_with_session = 0;
      for (const list of Object.values(db.sessions ?? {})) {
        const valid = list.map((x) => [x, safeMs(x)]).filter(([, ms]) => ms != null);
        if (valid.length) users_with_session++;
        for (const [, ms] of valid) { if (ms >= d7) sessions_7d++; if (ms >= d28) sessions_28d++; }
      }
      const returned = [...prev].filter((u) => cur.has(u)).length;
      const subs = Object.values(db.push_subscriptions ?? {});
      // ACTIVATION — the mouth of the funnel. A user row exists only after someone
      // finishes onboarding, so "onboarded but never trained" is a real, separable
      // number, and it is the one every retention mechanism is downstream of.
      // It is also the number the loop's own prod smokes pollute: every smoke test
      // POSTs /api/onboard against prod, so an unknown share of the historical
      // denominator is us. Rows minted with the owner's stats key from now on say
      // so; rows created BEFORE this wave carry no marker and are NOT retroactively
      // guessed at (inventing that split would be a fabricated number).
      const live = Object.entries(db.users ?? {}).filter(([, u]) => !u._merged_into);
      const smoke = live.filter(([, u]) => u.profile?.smoke === true);
      const firstMs = new Map();
      for (const [uid, list] of Object.entries(db.sessions ?? {})) {
        const ms = list.map(safeMs).filter((x) => x != null).sort((a, b) => a - b)[0];
        if (ms != null) firstMs.set(uid, ms);
      }
      const lags = live
        .map(([uid, u]) => [Date.parse(u.created_at ?? ""), firstMs.get(uid)])
        .filter(([c, f]) => Number.isFinite(c) && f != null && f >= c)
        .map(([c, f]) => (f - c) / 86400000)
        .sort((a, b) => a - b);
      // Smoke rows that logged a session must leave the numerator too — a prod
      // smoke usually DOES log one, so counting it as an activation is the same
      // contamination from the other side.
      const smokeIds = new Set(smoke.map(([uid]) => uid));
      const smokeWithSession = [...smokeIds].filter((uid) => (db.sessions[uid] ?? []).some((x) => safeMs(x) != null)).length;
      const funnel = activationFunnel({ liveCount: live.length, smokeCount: smoke.length, usersWithSession: users_with_session, smokeWithSession, lags });
      return {
        users_total: live.length, // tombstones aren't users
        users_with_session,
        ...funnel,
        active_7d: cur.size,
        active_prev_7d: prev.size,
        retention_wow: prev.size ? returned / prev.size : null,
        sessions_7d, sessions_28d,
        push_subscriptions: subs.length,
        push_delivered_7d: subs.filter((s) => (db.push_deliveries?.[s.endpoint] ?? 0) >= now - 7 * 86400000).length,
      };
    },
    // Voided sessions must not count as "last trained" — a user who corrects away
    // their only recent workout genuinely hasn't trained, and the comeback nudge
    // should say so. Same exclusion as listSessions (D1 does it in SQL).
    // `nowMs` is a real parameter, not decoration: derivability depends on the
    // clock (a far-future row stops being far-future once time reaches it), and D1
    // takes one. A store that silently used its own clock while the other honoured
    // the argument would make every parity test agree only on the day it was run.
    async latestSessionDate(user_id, nowMs = Date.now()) {
      let latest = null, latestMs = null;
      for (const s of db.sessions[user_id] ?? []) {
        const ms = !s.voided_at && isDerivableSession(s, nowMs) ? parseSessionInstant(s.date) : null;
        if (ms != null && (latestMs == null || ms > latestMs)) { latest = s.date; latestMs = ms; }
      }
      return latest;
    },
    // Comeback-nudge sweep: every email-bound user with their latest session
    // date (null when they've never logged one). Mirrors the D1 LEFT JOIN.
    async listAccountLastSessions(nowMs = Date.now()) {
      return Promise.all(Object.values(db.accounts).map(async (a) => ({
        email: a.email, user_id: a.user_id,
        last_date: await this.latestSessionDate(a.user_id, nowMs),
      })));
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
      if (isTombstoned(userId)) return null;
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
