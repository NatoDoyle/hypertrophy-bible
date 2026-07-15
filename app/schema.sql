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
