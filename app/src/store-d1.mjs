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
      await db.prepare("DELETE FROM bodyweights WHERE user_id = ? AND date = ?").bind(id, entry.date ?? null).run();
      await db
        .prepare("INSERT INTO bodyweights (user_id, date, data) VALUES (?, ?, ?)")
        .bind(id, entry.date ?? null, JSON.stringify(entry))
        .run();
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
      if (fromRow && toRow) {
        const fromU = JSON.parse(fromRow.data), toU = JSON.parse(toRow.data);
        if (fromU.custom_exercises?.length) {
          toU.custom_exercises = toU.custom_exercises || [];
          const have = new Set(toU.custom_exercises.map((x) => x.id));
          for (const ex of fromU.custom_exercises) if (!have.has(ex.id)) { toU.custom_exercises.push(ex); have.add(ex.id); }
          await db.prepare("UPDATE users SET data = ? WHERE id = ?").bind(JSON.stringify(toU), toId).run();
        }
      }
      const s = await db.prepare("UPDATE sessions SET user_id = ? WHERE user_id = ?").bind(toId, fromId).run();
      // One weigh-in per day survives the merge: drop from-rows whose date the
      // target already has (keep the target's), THEN move the rest.
      await db.prepare("DELETE FROM bodyweights WHERE user_id = ? AND date IN (SELECT date FROM bodyweights WHERE user_id = ?)").bind(fromId, toId).run();
      const b = await db.prepare("UPDATE bodyweights SET user_id = ? WHERE user_id = ?").bind(toId, fromId).run();
      // checkins share a (user_id, date) PK → move what doesn't collide, keeping
      // the target's same-day row, then drop any leftover from-user rows.
      await db.prepare("UPDATE OR IGNORE checkins SET user_id = ? WHERE user_id = ?").bind(toId, fromId).run();
      await db.prepare("DELETE FROM checkins WHERE user_id = ?").bind(fromId).run();
      await db.prepare("DELETE FROM users WHERE id = ?").bind(fromId).run();
      return { sessions: s.meta?.changes ?? 0, bodyweights: b.meta?.changes ?? 0 };
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
