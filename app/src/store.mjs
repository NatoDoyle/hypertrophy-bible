// Storage interface + a file-backed implementation for local development.
// The Hono app depends only on this async interface, so production can swap in a
// D1-backed store (see worker.mjs) with zero route changes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createFileStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  let db = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { users: {}, sessions: {}, bodyweights: {} };
  const flush = () => writeFileSync(path, JSON.stringify(db, null, 2));

  return {
    async getUser(id) { return db.users[id] ?? null; },
    async saveUser(id, user) { db.users[id] = user; flush(); return user; },
    async listSessions(id) { return db.sessions[id] ?? []; },
    async addSession(id, session) {
      (db.sessions[id] ??= []).push(session); flush(); return session;
    },
    async listBodyweights(id) { return db.bodyweights[id] ?? []; },
    async addBodyweight(id, entry) {
      (db.bodyweights[id] ??= []).push(entry); flush(); return entry;
    },
  };
}
