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
      await db
        .prepare("INSERT INTO sessions (session_id, user_id, date, data) VALUES (?, ?, ?, ?)")
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
  };
}
