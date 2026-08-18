// D1-backed store: the production implementation of the store interface used by
// src/app.mjs. Same async shape as createFileStore (src/store.mjs), so the Hono
// app and every route are byte-for-byte identical on Node and on Workers.
// Rows hold a JSON blob per record — the app owns the shape, D1 is just durable
// key/value with an index. See schema.sql for the tables.
import { mergeUserProfile } from "./merge-profile.mjs";
import { isDerivableSession, parseSessionInstant, sessionTimingIssue, SESSION_FUTURE_SLACK_MS } from "./session-time.mjs";
import { archiveSummary, restoredSession, restoredUser } from "./merge-archive.mjs";

// A session the user has voided (corrected away) is still stored — "never lose
// logged data" — but must be invisible to every engine that reads history. The
// flag lives in the JSON blob, so this predicate is how SQL asks about it.
const notVoided = (col = "data") => `json_extract(${col}, '$.voided_at') IS NULL`;

// A SQL prefilter for "this row could conceivably be derivable" — narrowing on
// SHAPE only, never deciding derivability. isDerivableSession() in session-time.mjs
// stays the single authority; this exists so the timing rules can be enforced
// without pulling every session blob into the Worker.
//
// Why it is a provable superset of what the JS predicate accepts:
//   - every date JS can parse begins with a literal YYYY-MM-DD, so the GLOB can
//     only ever drop rows JS would reject anyway;
//   - the ceiling is compared against the row's leading calendar day, which for a
//     full ISO timestamp carrying a positive offset can read ONE DAY LATER than the
//     UTC day JS judges. Hence the extra day of headroom: erring loose keeps this a
//     filter, and lets the JS predicate remain the only thing that says "no".
// A gate that narrows its input has to say so; a parity test asserts the SQL never
// excludes a row the JS predicate would have kept.
const DERIVABLE_SHAPE = `date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND substr(date, 1, 10) <= ?`;
const derivableShapeBound = (nowMs) =>
  new Date(nowMs + SESSION_FUTURE_SLACK_MS + 86400000).toISOString().slice(0, 10);
// A child write may race an account merge after the route performed its initial
// getUser() check. Keep the guard in the SQL statement itself: a tombstoned
// source must never grow a new, unarchived session/daily/device row. A missing
// user remains permitted for low-level fixture/backfill compatibility; routes
// already require a real active user.
const notTombstonedOwner = "NOT EXISTS (SELECT 1 FROM users WHERE id = ? AND json_extract(data, '$._merged_into') IS NOT NULL)";

export function createD1Store(db) {
  const isTombstoned = async (id) => {
    const row = await db.prepare("SELECT data FROM users WHERE id = ?").bind(id).first();
    return !!row && !!JSON.parse(row.data)?._merged_into;
  };
  return {
    // A merge TOMBSTONES the from-row instead of deleting it (BLOCKERS #6b,
    // option (b), Wave 211) — every reader treats a tombstone as absent, so the
    // app behaves exactly as if the row were gone (404 "unknown user"), but the
    // destructive primitive is gone: nothing can permanently destroy a user row,
    // and a mistaken or malicious merge leaves an audit trail (_merged_into).
    async getUser(id) {
      const row = await db.prepare("SELECT data FROM users WHERE id = ?").bind(id).first();
      const u = row ? JSON.parse(row.data) : null;
      return !u || u._merged_into ? null : u;
    },
    async saveUser(id, user) {
      await db
        .prepare("INSERT INTO users (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
        .bind(id, JSON.stringify(user))
        .run();
      return user;
    },
    // Optimistic concurrency: read the current blob, apply the mutation, and
    // commit only if the blob is unchanged (compare-and-swap on the exact JSON,
    // so no schema/version column is needed). Retries a few times if a concurrent
    // write (double-tap, second tab) slipped in — otherwise one change is lost.
    async updateUser(id, mutator) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const row = await db.prepare("SELECT data FROM users WHERE id = ?").bind(id).first();
        if (!row || JSON.parse(row.data)?._merged_into) return null; // tombstone = absent (parity with file store)
        const next = JSON.stringify(mutator(JSON.parse(row.data)));
        const res = await db.prepare("UPDATE users SET data = ? WHERE id = ? AND data = ?").bind(next, id, row.data).run();
        if ((res.meta?.changes ?? 0) === 1) return JSON.parse(next);
      }
      throw new Error("write-conflict");
    },
    // Voided sessions are excluded HERE, at the single source (parity with the file
    // store's filter) — see its comment for why not at each call site. The predicate
    // is SQL rather than a JS post-filter so latestSessionDate/listAccountLastSessions
    // below can reuse it inside their aggregates without pulling every blob.
    // `voided_at` lives in the JSON blob, so no column and no migration is needed —
    // SQLite's JSON1 (built into D1) reads it directly.
    async listSessions(id, { includeVoided = false, includeQuarantined = false, nowMs = Date.now() } = {}) {
      const { results } = await db
        .prepare(`SELECT data FROM sessions WHERE user_id = ?${includeVoided ? "" : " AND " + notVoided()} ORDER BY date ASC, rowid ASC`)
        .bind(id)
        .all();
      return results
        .map((r) => JSON.parse(r.data))
        .filter((s) => includeQuarantined || isDerivableSession(s, nowMs))
        .map((s) => {
          const timing_issue = sessionTimingIssue(s, nowMs);
          return timing_issue ? { ...s, timing_issue } : s;
        });
    },
    async addSession(id, session) {
      // Idempotent on the session_id PK: a replayed offline workout is a no-op.
      const res = await db
        .prepare(`INSERT INTO sessions (session_id, user_id, date, data)
          SELECT ?, ?, ?, ? WHERE ${notTombstonedOwner}
          ON CONFLICT(session_id) DO NOTHING`)
        .bind(session.session_id, id, session.date ?? null, JSON.stringify(session), id)
        .run();
      if (res?.meta?.changes) return session;                    // stored now
      // Nothing was written. Two reasons, and only one of them used to be
      // detected: a tombstoned owner (below), or `session_id` colliding with a row
      // that already exists. `session_id` is a DATABASE-WIDE primary key here, so
      // the collision can be this user's own replayed offline workout — genuinely
      // idempotent, report success — or another user's row entirely, which is a
      // write that silently did not happen. The route builds its recap from the
      // returned value, so reporting success for the second case is exactly the
      // optimistic lie the tombstone guard beside it was added to prevent.
      const mine = await db.prepare("SELECT 1 AS ok FROM sessions WHERE session_id = ? AND user_id = ?")
        .bind(session.session_id, id).first();
      return mine ? session : null;
    },
    // Edit or void ONE logged session in place — parity with the file store,
    // including the null-means-not-found / unchanged-means-declined contract.
    // The user_id is part of the WHERE, so possession of a session_id alone can
    // never edit someone else's workout. `date` is kept in sync with the blob
    // because the ORDER BY and the MAX() aggregates read the column, not the JSON.
    async updateSession(id, sessionId, mutator) {
      const row = await db.prepare(`SELECT data FROM sessions WHERE session_id = ? AND user_id = ? AND ${notTombstonedOwner}`).bind(sessionId, id, id).first();
      if (!row) return null;
      const cur = JSON.parse(row.data);
      const next = mutator(JSON.parse(row.data));
      if (next == null) return cur;
      const res = await db
        .prepare(`UPDATE sessions SET data = ?, date = ? WHERE session_id = ? AND user_id = ? AND ${notTombstonedOwner}`)
        .bind(JSON.stringify(next), next.date ?? null, sessionId, id, id)
        .run();
      return (res.meta?.changes ?? 0) === 1 ? next : null;
    },
    async listBodyweights(id) {
      const { results } = await db
        .prepare("SELECT data FROM bodyweights WHERE user_id = ? ORDER BY date ASC, rowid ASC")
        .bind(id)
        .all();
      return results.map((r) => JSON.parse(r.data));
    },
    async addBodyweight(id, entry) {
      // One weigh-in per user per day: clear any existing same-day row first, so a
      // replayed offline log (lost response on flaky gym wifi) replaces instead of
      // duplicating and skewing the bodyweight trend. (No unique column needed.)
      // batch = one implicit transaction: a Worker death between a lone DELETE
      // and INSERT would erase the day's existing weigh-in without replacing it.
      await db.batch([
        db.prepare(`DELETE FROM bodyweights WHERE user_id = ? AND date = ? AND ${notTombstonedOwner}`).bind(id, entry.date ?? null, id),
        db.prepare(`INSERT INTO bodyweights (user_id, date, data) SELECT ?, ?, ? WHERE ${notTombstonedOwner}`).bind(id, entry.date ?? null, JSON.stringify(entry), id),
      ]);
      return (await isTombstoned(id)) ? null : entry;
    },
    async listCheckins(id) {
      const { results } = await db.prepare("SELECT data FROM checkins WHERE user_id = ? ORDER BY date ASC").bind(id).all();
      return results.map((r) => JSON.parse(r.data));
    },
    async addCheckin(id, entry) {
      // one per user per day: replace on the (user_id, date) primary key
      await db
        .prepare(`INSERT INTO checkins (user_id, date, data) SELECT ?, ?, ? WHERE ${notTombstonedOwner} ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data`)
        .bind(id, entry.date, JSON.stringify(entry), id)
        .run();
      return (await isTombstoned(id)) ? null : entry;
    },
    // --- nutrition daily intake log (kcal + macros), one row per day (parity) ---
    async listNutritionLog(id) {
      const { results } = await db.prepare("SELECT data FROM nutrition_logs WHERE user_id = ? ORDER BY date ASC").bind(id).all();
      return results.map((r) => JSON.parse(r.data));
    },
    async addNutritionLog(id, entry) {
      await db
        .prepare(`INSERT INTO nutrition_logs (user_id, date, data) SELECT ?, ?, ? WHERE ${notTombstonedOwner} ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data`)
        .bind(id, entry.date, JSON.stringify(entry), id)
        .run();
      return (await isTombstoned(id)) ? null : entry;
    },

    // --- passwordless email backup ---
    // SELECT every column the row actually has (parity with the file store's
    // full-object return) — a caller added later that reads e.g. created_at
    // must not silently get undefined only in production.
    async getAccountByEmail(email) {
      return (await db.prepare("SELECT email, user_id, verified_at, created_at FROM accounts WHERE email = ?").bind(email).first()) ?? null;
    },
    async getAccountByUserId(userId) {
      return (await db.prepare("SELECT email, user_id, verified_at, created_at FROM accounts WHERE user_id = ?").bind(userId).first()) ?? null;
    },
    // Merge-on-restore: archive the complete source graph in the SAME D1
    // transaction that transfers it. A JavaScript pre-read here would race a
    // last-minute device write and silently omit collision-losing history.
    async reassignUserData(fromId, toId, { archiveId = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
      // custom exercises live on the user doc → migrate before deleting it (dedup by id).
      const [fromRow, toRow] = await Promise.all([
        db.prepare("SELECT data FROM users WHERE id = ?").bind(fromId).first(),
        db.prepare("SELECT data FROM users WHERE id = ?").bind(toId).first(),
      ]);
      // The file store gained this precondition and this one did not — lesson 1
      // inside the very commit that wrote the guard. Without it the batch below
      // ran unconditionally: a `toId` that vanished or became a tombstone between
      // the route's getUser and this call still received every session, weigh-in,
      // check-in, nutrition log, push subscription and share, and `fromId` was
      // still tombstoned — the whole graph moved onto an id getUser resolves to
      // null, so neither account can ever reach it again. Refuse instead, with the
      // same null the file store returns (see its note on refusal-vs-empty).
      const fromDoc = fromRow ? JSON.parse(fromRow.data) : null;
      const toDoc = toRow ? JSON.parse(toRow.data) : null;
      if (!fromDoc || fromDoc._merged_into || !toDoc || toDoc._merged_into) return null;
      // Every state-changing statement below is in ONE db.batch. As seven
      // sequential awaits, a Worker death mid-sequence left a half-merged
      // account (sessions moved, checkins orphaned, or the from-user deleted
      // early) with the single-use grant already burnt — no retry possible.
      // The to-user's custom_exercises merge goes through the CAS updateUser
      // (its precondition is inside the mutator) BEFORE the batch — a raw
      // `UPDATE users SET data` in the batch has no compare-and-swap and would
      // clobber a concurrent write to the surviving user. The id-dedup merge is
      // idempotent, so a CAS retry is safe.
      // Shares follow the user, or the merged-away user's share row points at a
      // DELETED user (dead public link + orphaned cheers). Reassign to the survivor
      // so a distributed link keeps working; if the survivor already has a share
      // (UNIQUE per user), drop the merged-away one + its cheers instead. Read
      // before building the batch (and before the profile merge below, which needs
      // to know whether a share is about to be inherited); the shares table may not
      // exist yet if neither user ever shared, so ensure it first.
      await ensureExtensions(db);
      const [fromShareRow, toShareRow] = await Promise.all([
        db.prepare("SELECT share_id FROM shares WHERE user_id = ?").bind(fromId).first(),
        db.prepare("SELECT share_id FROM shares WHERE user_id = ?").bind(toId).first(),
      ]);
      const shareReassigns = !!(fromShareRow && !toShareRow);
      {
        const fromU = fromDoc;
        await this.updateUser(toId, (u) => {
          if (fromU.custom_exercises?.length) {
            u.custom_exercises = u.custom_exercises || [];
            const have = new Set(u.custom_exercises.map((x) => x.id));
            for (const ex of fromU.custom_exercises) if (!have.has(ex.id)) { u.custom_exercises.push(ex); have.add(ex.id); }
          }
          // Streak-freeze balance, pause history, partner list, commitment, and
          // challenge history all live on the user doc too — merge them additively
          // (see merge-profile.mjs, shared with the file store) before the from-row
          // is deleted below, or they're lost.
          u = mergeUserProfile(fromU, u);
          // `to` never had a share, so its OWN cheers_pushed/cheers_seen watermarks
          // (0, or stale leftovers from a share it revoked earlier) don't describe
          // the share it's about to inherit below — without this, the push sweep
          // and the in-app "N new cheers" banner would both read the inherited
          // share's full lifetime cheer count as brand new, even though `from`
          // already saw/was pushed every one of them pre-merge.
          if (shareReassigns) u.profile = { ...(u.profile ?? {}), cheers_pushed: fromU.profile?.cheers_pushed ?? 0, cheers_seen: fromU.profile?.cheers_seen ?? 0 };
          return u;
        });
      }
      const stmts = [];
      // JSON1 constructs the snapshot from the source rows at transaction time,
      // before any move/drop statement can make a losing collision unrecoverable.
      stmts.push(db.prepare(`
        INSERT INTO merge_archives (archive_id, owner_user_id, source_user_id, created_at, snapshot, state, restored_user_id, restored_at)
        SELECT ?, ?, ?, ?, json_object(
          'user', json(u.data),
          'sessions', json(COALESCE((SELECT json_group_array(json(data)) FROM (SELECT data FROM sessions WHERE user_id = ? ORDER BY date ASC, rowid ASC)), '[]')),
          'bodyweights', json(COALESCE((SELECT json_group_array(json(data)) FROM (SELECT data FROM bodyweights WHERE user_id = ? ORDER BY date ASC, rowid ASC)), '[]')),
          'checkins', json(COALESCE((SELECT json_group_array(json(data)) FROM (SELECT data FROM checkins WHERE user_id = ? ORDER BY date ASC, rowid ASC)), '[]')),
          'nutrition_logs', json(COALESCE((SELECT json_group_array(json(data)) FROM (SELECT data FROM nutrition_logs WHERE user_id = ? ORDER BY date ASC, rowid ASC)), '[]')),
          'revoked_counts', json_object(
            'push_subscriptions', (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?),
            'push_deliveries', (SELECT COUNT(*) FROM push_deliveries d WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.endpoint = d.endpoint AND p.user_id = ?)),
            'shares', (SELECT COUNT(*) FROM shares WHERE user_id = ?),
            'magic_links', (SELECT COUNT(*) FROM magic_links WHERE user_id = ?))
        ), 'available', NULL, NULL
        FROM users u
        WHERE u.id = ? AND json_extract(u.data, '$._merged_into') IS NULL
      `).bind(archiveId, toId, fromId, now, fromId, fromId, fromId, fromId, fromId, fromId, fromId, fromId, fromId));
      // Archives belonging to an intermediate survivor remain recoverable after
      // that survivor itself is merged into a later canonical account.
      stmts.push(db.prepare("UPDATE merge_archives SET owner_user_id = ? WHERE owner_user_id = ?").bind(toId, fromId));
      if (fromShareRow) {
        if (toShareRow) {
          stmts.push(db.prepare("DELETE FROM share_cheers WHERE share_id = ?").bind(fromShareRow.share_id));
          stmts.push(db.prepare("DELETE FROM shares WHERE user_id = ?").bind(fromId));
        } else {
          stmts.push(db.prepare("UPDATE shares SET user_id = ? WHERE user_id = ?").bind(toId, fromId)); // cheers follow (keyed by share_id)
        }
      }
      const sIdx = stmts.push(db.prepare("UPDATE sessions SET user_id = ? WHERE user_id = ?").bind(toId, fromId)) - 1;
      // One weigh-in per day survives the merge: drop from-rows whose date the
      // target already has (keep the target's), THEN move the rest.
      stmts.push(db.prepare("DELETE FROM bodyweights WHERE user_id = ? AND date IN (SELECT date FROM bodyweights WHERE user_id = ?)").bind(fromId, toId));
      const bIdx = stmts.push(db.prepare("UPDATE bodyweights SET user_id = ? WHERE user_id = ?").bind(toId, fromId)) - 1;
      // checkins share a (user_id, date) PK → move what doesn't collide, keeping
      // the target's same-day row, then drop any leftover from-user rows.
      stmts.push(db.prepare("UPDATE OR IGNORE checkins SET user_id = ? WHERE user_id = ?").bind(toId, fromId));
      stmts.push(db.prepare("DELETE FROM checkins WHERE user_id = ?").bind(fromId));
      // nutrition logs follow the user (same (user_id,date) PK collision handling as checkins)
      stmts.push(db.prepare("UPDATE OR IGNORE nutrition_logs SET user_id = ? WHERE user_id = ?").bind(toId, fromId));
      stmts.push(db.prepare("DELETE FROM nutrition_logs WHERE user_id = ?").bind(fromId));
      // Push subscriptions follow the user (endpoint is globally unique, so no
      // collision) — otherwise the merged-away device's reminders orphan onto a
      // deleted user and the sweep prunes them, silently killing reminders.
      stmts.push(db.prepare("UPDATE push_subscriptions SET user_id = ? WHERE user_id = ?").bind(toId, fromId));
      // Keep the raw document on the hidden tombstone too. json_set reads the
      // current row inside this transaction, so source-only future fields survive.
      // The archive INSERT above is guarded by `_merged_into IS NULL`; this
      // statement was not, so on an already-tombstoned source the INSERT would be
      // skipped while this line still overwrote `_merge_archive_id` — pointing the
      // row at an archive that was never written and destroying the pointer to the
      // real one. Two halves of one transaction disagreeing about the same
      // precondition. They agree now.
      stmts.push(db.prepare("UPDATE users SET data = json_set(data, '$._merged_into', ?, '$._merged_at', ?, '$._merge_archive_id', ?) WHERE id = ? AND json_extract(data, '$._merged_into') IS NULL")
        .bind(toId, now, archiveId, fromId));
      const results = await db.batch(stmts);
      return { sessions: results[sIdx]?.meta?.changes ?? 0, bodyweights: results[bIdx]?.meta?.changes ?? 0 };
    },
    async listMergeArchives(ownerId) {
      await ensureExtensions(db);
      const { results } = await db.prepare("SELECT archive_id, owner_user_id, source_user_id, created_at, snapshot, state, restored_user_id, restored_at FROM merge_archives WHERE owner_user_id = ? ORDER BY created_at DESC")
        .bind(ownerId).all();
      return results.map((r) => archiveSummary({ ...r, snapshot: JSON.parse(r.snapshot) }));
    },
    async restoreMergeArchive(ownerId, archiveId, restoredUserId = crypto.randomUUID(), now = new Date().toISOString()) {
      await ensureExtensions(db);
      let archive = await db.prepare("SELECT archive_id, owner_user_id, source_user_id, created_at, snapshot, state, restored_user_id, restored_at FROM merge_archives WHERE archive_id = ? AND owner_user_id = ?")
        .bind(archiveId, ownerId).first();
      if (!archive) return null;
      if (!archive.restored_user_id) {
        const claim = await db.prepare("UPDATE merge_archives SET restored_user_id = ?, state = 'restoring' WHERE archive_id = ? AND owner_user_id = ? AND restored_user_id IS NULL AND state = 'available'")
          .bind(restoredUserId, archiveId, ownerId).run();
        if ((claim.meta?.changes ?? 0) === 1) archive = { ...archive, restored_user_id: restoredUserId, state: "restoring" };
        else {
          archive = await db.prepare("SELECT archive_id, owner_user_id, source_user_id, created_at, snapshot, state, restored_user_id, restored_at FROM merge_archives WHERE archive_id = ? AND owner_user_id = ?")
            .bind(archiveId, ownerId).first();
          if (!archive) return null;
        }
      }
      const id = archive.restored_user_id;
      if (archive.state === "restored") {
        const existing = await this.getUser(id);
        return {
          user_id: id,
          program_name: existing?.program?.name ?? null,
          units: existing?.profile?.units ?? null,
          archive: archiveSummary({ ...archive, snapshot: JSON.parse(archive.snapshot) }),
        };
      }
      const snapshot = JSON.parse(archive.snapshot);
      const user = restoredUser(snapshot.user, id);
      const sessions = (snapshot.sessions ?? []).map((s, i) => restoredSession(s, archiveId, id, i));
      // The archive's durable `restoring` claim makes this batch safe to retry
      // after an interrupted Worker invocation. Every child write is idempotent
      // or replaces the fresh copy's complete collection in the same transaction.
      const stmts = [
        db.prepare("INSERT INTO users (id, data) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").bind(id, JSON.stringify(user)),
        db.prepare("DELETE FROM bodyweights WHERE user_id = ?").bind(id),
        db.prepare("DELETE FROM checkins WHERE user_id = ?").bind(id),
        db.prepare("DELETE FROM nutrition_logs WHERE user_id = ?").bind(id),
      ];
      for (const s of sessions) stmts.push(db.prepare("INSERT INTO sessions (session_id, user_id, date, data) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING")
        .bind(s.session_id, id, s.date ?? null, JSON.stringify(s)));
      for (const row of snapshot.bodyweights ?? []) stmts.push(db.prepare("INSERT INTO bodyweights (user_id, date, data) VALUES (?, ?, ?)")
        .bind(id, row.date ?? null, JSON.stringify(row)));
      for (const row of snapshot.checkins ?? []) stmts.push(db.prepare("INSERT INTO checkins (user_id, date, data) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data")
        .bind(id, row.date, JSON.stringify(row)));
      for (const row of snapshot.nutrition_logs ?? []) stmts.push(db.prepare("INSERT INTO nutrition_logs (user_id, date, data) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data")
        .bind(id, row.date, JSON.stringify(row)));
      stmts.push(db.prepare("UPDATE merge_archives SET state = 'restored', restored_at = COALESCE(restored_at, ?) WHERE archive_id = ? AND owner_user_id = ? AND restored_user_id = ?")
        .bind(now, archiveId, ownerId, id));
      await db.batch(stmts);
      const finalArchive = await db.prepare("SELECT archive_id, owner_user_id, source_user_id, created_at, snapshot, state, restored_user_id, restored_at FROM merge_archives WHERE archive_id = ? AND owner_user_id = ?")
        .bind(archiveId, ownerId).first();
      return {
        user_id: id,
        program_name: user.program?.name ?? null,
        units: user.profile?.units ?? null,
        archive: archiveSummary({ ...finalArchive, snapshot: JSON.parse(finalArchive.snapshot) }),
      };
    },
    // --- Web Push subscriptions (device reminders) — parity with the file store ---
    async savePushSubscription(user_id, sub) {
      await db
        .prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
          SELECT ?, ?, ?, ?, ? WHERE ${notTombstonedOwner}
          ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
        .bind(sub.endpoint, user_id, sub.keys?.p256dh ?? null, sub.keys?.auth ?? null, Date.now(), user_id)
        .run();
      return (await isTombstoned(user_id)) ? null : { endpoint: sub.endpoint, user_id };
    },
    // userId scopes the delete to its owner (route callers); the internal sweep
    // passes null to prune unconditionally. Parity with the file store.
    async deletePushSubscription(endpoint, userId = null) {
      await ensureExtensions(db);
      const scoped = userId == null
        ? { where: "endpoint = ?", binds: [endpoint] }
        : { where: "endpoint = ? AND user_id = ?", binds: [endpoint, userId] };
      // Delete evidence first, guarded by the same owner predicate. If a caller
      // guesses another user's endpoint, neither record changes.
      await db.batch([
        db.prepare(`DELETE FROM push_deliveries WHERE endpoint = ? AND EXISTS (SELECT 1 FROM push_subscriptions WHERE ${scoped.where})`)
          .bind(endpoint, ...scoped.binds),
        db.prepare(`DELETE FROM push_subscriptions WHERE ${scoped.where}`).bind(...scoped.binds),
      ]);
    },
    async listPushSubscriptions() {
      const { results } = await db.prepare("SELECT endpoint, user_id, p256dh, auth, created_at FROM push_subscriptions").all();
      return results;
    },
    // Delivery evidence is stamped only while the endpoint is still subscribed;
    // an in-flight 2xx must not recreate a retention row after an unsubscribe.
    async markPushDelivered(endpoint, at) {
      await ensureExtensions(db);
      await db.prepare("INSERT INTO push_deliveries (endpoint, last_ok_at) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ?) ON CONFLICT(endpoint) DO UPDATE SET last_ok_at = excluded.last_ok_at")
        .bind(endpoint, at, endpoint).run();
    },
    // Owner-only aggregates (BLOCKERS #7 — the zero-new-collection proposal):
    // counts only, no per-user view, no PII. Valid voided sessions remain
    // activity; quarantined timing rows are deliberately absent from all
    // derived telemetry just as they are from coaching and reminders.
    async stats(now = Date.now()) {
      await ensureExtensions(db);
      const d7 = now - 7 * 86400000, d14 = now - 14 * 86400000, d28 = now - 28 * 86400000;
      const one = async (sql, ...binds) => {
        const q = db.prepare(sql);
        return (await (binds.length ? q.bind(...binds) : q).first())?.c ?? 0;
      };
      // Same shape-narrowing as above: the aggregate needs a user_id and an
      // instant, never a whole workout. `SELECT user_id, data FROM sessions` with
      // no WHERE pulled every blob in the database into the Worker on each call.
      const { results } = await db
        .prepare(`SELECT user_id, date, json_extract(data, '$.local_date') AS local_date FROM sessions
          WHERE ${DERIVABLE_SHAPE}`)
        .bind(derivableShapeBound(now)).all();
      const safe = results
        .map((r) => ({ user_id: r.user_id, ms: isDerivableSession({ date: r.date, local_date: r.local_date ?? null }, now) ? parseSessionInstant(r.date) : null }))
        .filter((r) => r.ms != null);
      const activeIn = (from, to = null) => new Set(safe.filter((r) => r.ms >= from && (to == null || r.ms < to)).map((r) => r.user_id));
      const cur = activeIn(d7), prev = activeIn(d14, d7);
      const active_prev_7d = prev.size;
      const returned = [...prev].filter((id) => cur.has(id)).length;
      return {
        users_total: await one("SELECT COUNT(*) c FROM users WHERE json_extract(data, '$._merged_into') IS NULL"), // tombstones aren't users
        users_with_session: new Set(safe.map((r) => r.user_id)).size,
        active_7d: cur.size,
        active_prev_7d,
        retention_wow: active_prev_7d ? returned / active_prev_7d : null,
        sessions_7d: safe.filter((r) => r.ms >= d7).length,
        sessions_28d: safe.filter((r) => r.ms >= d28).length,
        push_subscriptions: await one("SELECT COUNT(*) c FROM push_subscriptions"),
        push_delivered_7d: await one(
          "SELECT COUNT(*) c FROM push_deliveries d WHERE d.last_ok_at >= ? AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.endpoint = d.endpoint)",
          now - 7 * 86400000),
      };
    },
    // Voided sessions must not count as "last trained" (parity with the file store).
    async latestSessionDate(user_id, nowMs = Date.now()) {
      // Timing quarantine is a JS predicate, so this can no longer be a bare
      // SQL MAX(date). It briefly became "pull every session blob and parse it",
      // which is O(all sessions) per user and, through listAccountLastSessions
      // below, ran once per email account on every cron tick. Neither extreme is
      // needed: SQL narrows on shape and projects the only TWO fields the
      // predicate reads, so no blob crosses the wire and the decision still
      // belongs entirely to isDerivableSession.
      const { results } = await db
        .prepare(`SELECT date, json_extract(data, '$.local_date') AS local_date FROM sessions
          WHERE user_id = ? AND ${notVoided()} AND ${DERIVABLE_SHAPE} ORDER BY date DESC`)
        .bind(user_id, derivableShapeBound(nowMs)).all();
      for (const row of results) {
        if (isDerivableSession({ date: row.date, local_date: row.local_date ?? null }, nowMs)) return row.date;
      }
      return null;
    },
    // Comeback-nudge sweep: every email-bound user with their latest session
    // date (null when they've never logged one). Parity with the file store.
    async listAccountLastSessions(nowMs = Date.now()) {
      // ONE round trip. This was a single LEFT JOIN ... GROUP BY, then became one
      // latestSessionDate() call per account — and both the push sweep and the
      // comeback sweep call it as their FIRST statement, outside the per-user
      // try/catch each of them carefully builds. Past the subrequest budget the
      // whole sweep dies for every user at once, which is the opposite of the
      // isolation those loops were written for.
      const bound = derivableShapeBound(nowMs);
      const { results } = await db
        .prepare(`SELECT a.email, a.user_id, s.date AS date, json_extract(s.data, '$.local_date') AS local_date
          FROM accounts a
          LEFT JOIN sessions s ON s.user_id = a.user_id AND ${notVoided("s.data")}
            AND s.date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND substr(s.date, 1, 10) <= ?
          ORDER BY s.date DESC`)
        .bind(bound).all();
      const best = new Map();   // user_id -> {email, last_date}
      for (const r of results) {
        if (!best.has(r.user_id)) best.set(r.user_id, { email: r.email, user_id: r.user_id, last_date: null });
        const acc = best.get(r.user_id);
        if (acc.last_date == null && r.date != null
          && isDerivableSession({ date: r.date, local_date: r.local_date ?? null }, nowMs)) acc.last_date = r.date;
      }
      return [...best.values()];
    },
    // created_at is written explicitly in the same ISO-8601 format the file
    // store uses (new Date().toISOString()), not left to the accounts table's
    // `datetime('now')` DEFAULT — that default renders SQLite's own
    // "YYYY-MM-DD HH:MM:SS" (no 'T', no 'Z'), which `new Date(...)` parses as
    // LOCAL time, not UTC (the lesson-22 class of timezone bug: same instant,
    // different stored/parsed representation between the two stores). Only
    // set on first insert — ON CONFLICT doesn't touch it, so a restore/re-claim
    // preserves the account's original creation time (parity with the file
    // store's `?? db.accounts[email]?.created_at`).
    async saveAccount(email, user_id, verified_at) {
      await db
        .prepare("INSERT INTO accounts (email, user_id, verified_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, verified_at = excluded.verified_at")
        .bind(email, user_id, verified_at ?? null, new Date().toISOString())
        .run();
      return { email, user_id, verified_at: verified_at ?? null };
    },
    async createMagicLink(row) {
      await db
        .prepare("INSERT INTO magic_links (token_hash, email, rl_key, ip, user_id, purpose, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(row.token_hash, row.email, row.rl_key, row.ip ?? null, row.user_id, row.purpose, row.expires_at, row.used ?? 0, row.created_at)
        .run();
      return row;
    },
    // SELECT every column (parity with the file store's full-row return,
    // including rl_key/ip) — a caller reading them off getMagicLink's result
    // (rather than the dedicated countRecentLinks/countRecentByIp queries)
    // must not silently get undefined only in production.
    async getMagicLink(tokenHash) {
      return (await db
        .prepare("SELECT token_hash, email, rl_key, ip, user_id, purpose, expires_at, used, created_at FROM magic_links WHERE token_hash = ?")
        .bind(tokenHash)
        .first()) ?? null;
    },
    // Atomic single-use flip guarded by `used = 0`: returns true only if THIS
    // call consumed the link, so two concurrent consumes can't both succeed
    // (defeating the single-use guarantee / a duplicate merge grant).
    async markMagicLinkUsed(tokenHash) {
      const res = await db.prepare("UPDATE magic_links SET used = 1 WHERE token_hash = ? AND used = 0").bind(tokenHash).run();
      return (res.meta?.changes ?? 0) === 1;
    },
    async countRecentLinks(rlKey, sinceMs) {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE rl_key = ? AND created_at >= ?").bind(rlKey, sinceMs).first();
      return row?.n ?? 0;
    },
    async countRecentByIp(ip, sinceMs) {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE ip = ? AND created_at >= ?").bind(ip, sinceMs).first();
      return row?.n ?? 0;
    },

    // --- Shareable progress cards (opt-in social) ---
    // The `shares` table is self-initialized at runtime (CREATE TABLE IF NOT EXISTS)
    // because the D1 query CLI can't run a migration in this project (7403). Memoized
    // per worker instance so it's a one-time cost, not per request.
    async createShare(userId, shareId, now) {
      await ensureExtensions(db);
      // One share per user (UNIQUE user_id): opting in again ROTATES the token and
      // revokes the old link in a single write.
      await db.prepare(`INSERT INTO shares (share_id, user_id, created_at)
        SELECT ?, ?, ? WHERE ${notTombstonedOwner}
        ON CONFLICT(user_id) DO UPDATE SET share_id = excluded.share_id, created_at = excluded.created_at`)
        .bind(shareId, userId, now, userId).run();
      return (await isTombstoned(userId)) ? null : shareId;
    },
    async getShareUserId(shareId) {
      await ensureExtensions(db);
      const row = await db.prepare("SELECT user_id FROM shares WHERE share_id = ?").bind(shareId).first();
      return row?.user_id ?? null;
    },
    async getShareIdForUser(userId) {
      await ensureExtensions(db);
      const row = await db.prepare("SELECT share_id FROM shares WHERE user_id = ?").bind(userId).first();
      return row?.share_id ?? null;
    },
    async deleteShare(userId) {
      await ensureExtensions(db);
      // Drop the cheer tally with the share (the count belongs to that share_id).
      // One implicit transaction so a Worker death can't leave a half-revoke.
      await db.batch([
        db.prepare("DELETE FROM share_cheers WHERE share_id IN (SELECT share_id FROM shares WHERE user_id = ?)").bind(userId),
        db.prepare("DELETE FROM shares WHERE user_id = ?").bind(userId),
      ]);
    },
    // A public "cheer" tally on a share card (social proof). Bounded so it can't grow
    // absurdly; the caller validates the share_id resolves before incrementing.
    async addShareCheer(shareId) {
      await ensureExtensions(db);
      await db.prepare("INSERT INTO share_cheers (share_id, count) VALUES (?, 1) ON CONFLICT(share_id) DO UPDATE SET count = MIN(count + 1, 1000000)").bind(shareId).run();
      const row = await db.prepare("SELECT count FROM share_cheers WHERE share_id = ?").bind(shareId).first();
      return row?.count ?? 0;
    },
    async getShareCheers(shareId) {
      await ensureExtensions(db);
      const row = await db.prepare("SELECT count FROM share_cheers WHERE share_id = ?").bind(shareId).first();
      return row?.count ?? 0;
    },
  };
}

// Extension tables are self-initialized because this project cannot rely on a
// production D1 migration CLI. Readiness is PER BINDING: a module-global promise
// incorrectly declared an unrelated test/preview database ready after the first
// Worker binding had run its CREATE statements.
const extensionReady = new WeakMap();
function ensureExtensions(db) {
  let ready = extensionReady.get(db);
  if (!ready) {
    ready = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS shares (share_id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS share_cheers (share_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)"),
      db.prepare("CREATE TABLE IF NOT EXISTS push_deliveries (endpoint TEXT PRIMARY KEY, last_ok_at INTEGER NOT NULL)"),
      db.prepare("CREATE TABLE IF NOT EXISTS merge_archives (archive_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, source_user_id TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'available', restored_user_id TEXT, restored_at TEXT)"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_merge_archives_owner ON merge_archives(owner_user_id, created_at)"),
    ]).catch((e) => { extensionReady.delete(db); throw e; });
    extensionReady.set(db, ready);
  }
  return ready;
}
