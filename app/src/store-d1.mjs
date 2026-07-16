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
      await db
        .prepare("INSERT INTO bodyweights (user_id, date, data) VALUES (?, ?, ?)")
        .bind(id, entry.date ?? null, JSON.stringify(entry))
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
    // Merge-on-restore: move one user's logs to another, then drop the empty shell.
    async reassignUserData(fromId, toId) {
      const s = await db.prepare("UPDATE sessions SET user_id = ? WHERE user_id = ?").bind(toId, fromId).run();
      const b = await db.prepare("UPDATE bodyweights SET user_id = ? WHERE user_id = ?").bind(toId, fromId).run();
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
    async markMagicLinkUsed(tokenHash) {
      await db.prepare("UPDATE magic_links SET used = 1 WHERE token_hash = ?").bind(tokenHash).run();
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
