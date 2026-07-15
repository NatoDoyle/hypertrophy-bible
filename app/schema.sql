-- D1 schema for The Hypertrophy Bible.
-- Apply locally:  npx wrangler d1 execute hypertrophy-bible --local  --file=./schema.sql
-- Apply in prod:  npx wrangler d1 execute hypertrophy-bible --remote --file=./schema.sql
-- Each table stores an app-owned JSON blob per record (see src/store-d1.mjs).

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  date       TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS bodyweights (
  user_id TEXT NOT NULL,
  date    TEXT,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bodyweights_user ON bodyweights(user_id);

-- Passwordless email backup ------------------------------------------------
-- accounts: an email address bound to the canonical user_id whose data it owns.
CREATE TABLE IF NOT EXISTS accounts (
  email       TEXT PRIMARY KEY,   -- normalized (trimmed + lowercased)
  user_id     TEXT NOT NULL,
  verified_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- magic_links: single-use, short-lived login tokens. We store only the SHA-256
-- hash of the token, never the token itself, so a DB leak can't be replayed.
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,       -- the address the link is delivered to
  rl_key     TEXT NOT NULL,       -- canonicalized email, for rate-limit bucketing
  ip         TEXT,                -- requester IP, for a provider-agnostic per-IP cap
  user_id    TEXT NOT NULL,       -- the user_id this link will bind/restore
  purpose    TEXT NOT NULL,       -- 'claim' | 'restore'
  expires_at INTEGER NOT NULL,    -- epoch ms
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL     -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_magic_links_rlkey ON magic_links(rl_key);
CREATE INDEX IF NOT EXISTS idx_magic_links_ip ON magic_links(ip);
