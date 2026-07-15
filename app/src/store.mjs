// Storage interface + a file-backed implementation for local development.
// The Hono app depends only on this async interface, so production can swap in a
// D1-backed store (see worker.mjs) with zero route changes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createFileStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  let db = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { users: {}, sessions: {}, bodyweights: {}, accounts: {}, magic_links: {} };
  db.accounts ??= {};        // tolerate stores written before email backup existed
  db.magic_links ??= {};
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
    async listSessions(id) { return byDate(db.sessions[id]); },
    async addSession(id, session) {
      (db.sessions[id] ??= []).push(session); flush(); return session;
    },
    async listBodyweights(id) { return byDate(db.bodyweights[id]); },
    async addBodyweight(id, entry) {
      (db.bodyweights[id] ??= []).push(entry); flush(); return entry;
    },

    // --- passwordless email backup ---
    async getAccountByEmail(email) { return db.accounts[email] ?? null; },
    async saveAccount(email, user_id, verified_at) {
      db.accounts[email] = {
        email, user_id, verified_at: verified_at ?? null,
        created_at: db.accounts[email]?.created_at ?? new Date().toISOString(),
      };
      flush();
      return db.accounts[email];
    },
    async createMagicLink(row) { db.magic_links[row.token_hash] = row; flush(); return row; },
    async getMagicLink(tokenHash) { return db.magic_links[tokenHash] ?? null; },
    async markMagicLinkUsed(tokenHash) {
      if (db.magic_links[tokenHash]) { db.magic_links[tokenHash].used = 1; flush(); }
    },
    async countRecentLinks(rlKey, sinceMs) {
      return Object.values(db.magic_links).filter((l) => l.rl_key === rlKey && l.created_at >= sinceMs).length;
    },
    async countRecentByIp(ip, sinceMs) {
      return Object.values(db.magic_links).filter((l) => l.ip === ip && l.created_at >= sinceMs).length;
    },
  };
}
