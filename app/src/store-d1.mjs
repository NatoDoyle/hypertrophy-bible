// D1-backed store: the production implementation of the store interface used by
// src/app.mjs. Same async shape as createFileStore (src/store.mjs), so the Hono
// app and every route are byte-for-byte identical on Node and on Workers.
// Rows hold a JSON blob per record — the app owns the shape, D1 is just durable
// key/value with an index. See schema.sql for the tables.
export function createD1Store(db) {
  return {
    async getUser(id) {
      const row = await db.prepare("SELECT data FROM users WHERE id = ?").bind(id).first();
      return row ? JSON.parse(row.data) : null;
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
        if (!row) return null;
        const next = JSON.stringify(mutator(JSON.parse(row.data)));
        const res = await db.prepare("UPDATE users SET data = ? WHERE id = ? AND data = ?").bind(next, id, row.data).run();
        if ((res.meta?.changes ?? 0) === 1) return JSON.parse(next);
      }
      throw new Error("write-conflict");
    },
    async listSessions(id) {
      // rowid tiebreak keeps same-timestamp sessions in insertion order,
      // matching the file store (coach rotation + PR detection depend on it).
      const { results } = await db
        .prepare("SELECT data FROM sessions WHERE user_id = ? ORDER BY date ASC, rowid ASC")
        .bind(id)
        .all();
      return results.map((r) => JSON.parse(r.data));
    },
    async addSession(id, session) {
      // Idempotent on the session_id PK: a replayed offline workout is a no-op.
      await db
        .prepare("INSERT INTO sessions (session_id, user_id, date, data) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING")
        .bind(session.session_id, id, session.date ?? null, JSON.stringify(session))
        .run();
      return session;
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
        db.prepare("DELETE FROM bodyweights WHERE user_id = ? AND date = ?").bind(id, entry.date ?? null),
        db.prepare("INSERT INTO bodyweights (user_id, date, data) VALUES (?, ?, ?)").bind(id, entry.date ?? null, JSON.stringify(entry)),
      ]);
      return entry;
    },
    async listCheckins(id) {
      const { results } = await db.prepare("SELECT data FROM checkins WHERE user_id = ? ORDER BY date ASC").bind(id).all();
      return results.map((r) => JSON.parse(r.data));
    },
    async addCheckin(id, entry) {
      // one per user per day: replace on the (user_id, date) primary key
      await db
        .prepare("INSERT INTO checkins (user_id, date, data) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data")
        .bind(id, entry.date, JSON.stringify(entry))
        .run();
      return entry;
    },
    // --- nutrition daily intake log (kcal + macros), one row per day (parity) ---
    async listNutritionLog(id) {
      const { results } = await db.prepare("SELECT data FROM nutrition_logs WHERE user_id = ? ORDER BY date ASC").bind(id).all();
      return results.map((r) => JSON.parse(r.data));
    },
    async addNutritionLog(id, entry) {
      await db
        .prepare("INSERT INTO nutrition_logs (user_id, date, data) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET data = excluded.data")
        .bind(id, entry.date, JSON.stringify(entry))
        .run();
      return entry;
    },

    // --- passwordless email backup ---
    async getAccountByEmail(email) {
      return (await db.prepare("SELECT email, user_id, verified_at FROM accounts WHERE email = ?").bind(email).first()) ?? null;
    },
    async getAccountByUserId(userId) {
      return (await db.prepare("SELECT email, user_id, verified_at FROM accounts WHERE user_id = ?").bind(userId).first()) ?? null;
    },
    // Merge-on-restore: move ALL of one user's data onto another, then drop the
    // empty shell. Sessions, bodyweights, checkins, AND the custom-exercise
    // library move — otherwise moved sets reference custom-* ids that no longer
    // resolve (silent volume/PR corruption) and check-in history is orphaned.
    async reassignUserData(fromId, toId) {
      // custom exercises live on the user doc → migrate before deleting it (dedup by id).
      const [fromRow, toRow] = await Promise.all([
        db.prepare("SELECT data FROM users WHERE id = ?").bind(fromId).first(),
        db.prepare("SELECT data FROM users WHERE id = ?").bind(toId).first(),
      ]);
      // Every statement in ONE db.batch = one implicit transaction. As seven
      // sequential awaits, a Worker death mid-sequence left a half-merged
      // account (sessions moved, checkins orphaned, or the from-user deleted
      // early) with the single-use grant already burnt — no retry possible.
      // The to-user's custom_exercises merge goes through the CAS updateUser
      // (its precondition is inside the mutator) BEFORE the batch — a raw
      // `UPDATE users SET data` in the batch has no compare-and-swap and would
      // clobber a concurrent write to the surviving user. The id-dedup merge is
      // idempotent, so a CAS retry is safe.
      if (fromRow && toRow) {
        const fromU = JSON.parse(fromRow.data);
        if (fromU.custom_exercises?.length) {
          await this.updateUser(toId, (u) => {
            u.custom_exercises = u.custom_exercises || [];
            const have = new Set(u.custom_exercises.map((x) => x.id));
            for (const ex of fromU.custom_exercises) if (!have.has(ex.id)) { u.custom_exercises.push(ex); have.add(ex.id); }
            return u;
          });
        }
      }
      const stmts = [];
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
      stmts.push(db.prepare("DELETE FROM users WHERE id = ?").bind(fromId));
      const results = await db.batch(stmts);
      return { sessions: results[sIdx]?.meta?.changes ?? 0, bodyweights: results[bIdx]?.meta?.changes ?? 0 };
    },
    // --- Web Push subscriptions (device reminders) — parity with the file store ---
    async savePushSubscription(user_id, sub) {
      await db
        .prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth")
        .bind(sub.endpoint, user_id, sub.keys?.p256dh ?? null, sub.keys?.auth ?? null, Date.now())
        .run();
      return { endpoint: sub.endpoint, user_id };
    },
    // userId scopes the delete to its owner (route callers); the internal sweep
    // passes null to prune unconditionally. Parity with the file store.
    async deletePushSubscription(endpoint, userId = null) {
      if (userId == null) { await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run(); }
      else { await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(endpoint, userId).run(); }
    },
    async listPushSubscriptions() {
      const { results } = await db.prepare("SELECT endpoint, user_id, p256dh, auth, created_at FROM push_subscriptions").all();
      return results;
    },
    async latestSessionDate(user_id) {
      const row = await db.prepare("SELECT MAX(date) AS d FROM sessions WHERE user_id = ?").bind(user_id).first();
      return row?.d ?? null;
    },
    // Comeback-nudge sweep: every email-bound user with their latest session
    // date (null when they've never logged one). Parity with the file store.
    async listAccountLastSessions() {
      const { results } = await db
        .prepare("SELECT a.email, a.user_id, MAX(s.date) AS last_date FROM accounts a LEFT JOIN sessions s ON s.user_id = a.user_id GROUP BY a.email, a.user_id")
        .all();
      return results.map((r) => ({ email: r.email, user_id: r.user_id, last_date: r.last_date ?? null }));
    },
    async saveAccount(email, user_id, verified_at) {
      await db
        .prepare("INSERT INTO accounts (email, user_id, verified_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, verified_at = excluded.verified_at")
        .bind(email, user_id, verified_at ?? null)
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
    async getMagicLink(tokenHash) {
      return (await db
        .prepare("SELECT token_hash, email, user_id, purpose, expires_at, used, created_at FROM magic_links WHERE token_hash = ?")
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
  };
}
