# The Hypertrophy Bible — app

A coach that has already made every decision. The app turns the knowledge base
(`../data`, `../content`) into one screen a day: it picks your program, pre-fills
every set, and derives your progress from what you log — no plans to read, no
numbers to choose, no calorie counting.

It runs two ways from **one** codebase:

- **Locally** on plain Node (file-backed store) — for building and testing.
- **In production** on Cloudflare Workers + D1 (free tier) — same Hono app, same
  routes, just a different store. No build step, no framework lock-in.

## What's here

```
app/
  public/            Frontend (vanilla JS SPA + PWA). No build, no framework.
    index.html         shell + bottom nav
    app.js             onboarding → Today → session player → recap → progress
    styles.css         mobile-first dark theme
    manifest.webmanifest, icon.svg
  src/
    app.mjs            the Hono API (store injected — identical on Node & Workers)
    kb.mjs             program selection + exercise/muscle indexes
    kb-data.mjs        AUTO-GENERATED bundle of ../data (run `npm run build-data`)
    coach.mjs          double-progression, session rotation, derived recap
    store.mjs          file-backed store   (local dev)
    store-d1.mjs       D1-backed store      (production)
  server.node.mjs      local entry: file store + static files
  worker.mjs           Workers entry: D1 store + [assets] binding
  wrangler.toml        Cloudflare config (free tier)
  schema.sql           D1 tables
  scripts/
    gen-kb-data.mjs    reads ../data/** → writes src/kb-data.mjs
    test-coach.mjs     unit tests for the coach logic
```

The coach's math (per-muscle weekly volume, estimated 1RM, energy balance from
the bodyweight trend, readiness) lives in `../tools/derive-core.mjs` — pure
functions, no filesystem — so the exact same engine that powers the knowledge
base powers the app.

## Run it locally

```bash
cd app
npm install
npm run dev          # builds the KB data bundle, then serves on :8787
```

Open <http://localhost:8787>. Override the port with `PORT=8788 npm run dev`.

Local data is written to `app/.data/store.json` (git-ignored). Delete that file
to reset all users.

### Tests

```bash
npm test             # coach logic (double progression, rotation, recap, energy balance)
```

### API, end to end

```
GET  /api/health
POST /api/onboard        { profile:{ training_status, primary_goal, days_per_week, available_equipment, sex } } → { user_id, program }
GET  /api/today?u=ID     → { card, session }   (session pre-filled, weights null until you have history)
POST /api/session        { user_id, session_name, sets:[{exercise,weight_kg,reps}] } → { wins, ... }  (recap)
GET  /api/progress?u=ID  → { volumeByMuscle, e1rm, bodyweight, ... }
POST /api/bodyweight     { user_id, kg } → { trend, energy_balance }
GET  /api/exercise/:id   → { name, cues, common_errors, ... }
```

## Deploy to Cloudflare (free)

One-time setup:

```bash
npm install                       # installs wrangler (devDependency)
npx wrangler login                # opens the browser once
npx wrangler d1 create hypertrophy-bible
```

Paste the printed `database_id` into `wrangler.toml`, then create the tables and
deploy:

```bash
npm run db:init:remote            # runs schema.sql against the prod D1
npm run deploy                    # builds the KB bundle + publishes the Worker
```

You get a free `https://hypertrophy-bible.<your-subdomain>.workers.dev` URL. Add
a custom domain later in the Cloudflare dashboard if you want one.

### Test the Workers build locally first

```bash
npm run db:init:local             # tables in a local SQLite (via wrangler)
npm run cf:dev                    # runs worker.mjs on Workers' local runtime
```

This exercises the D1 store and the `[assets]` binding exactly as production
does, without deploying.

## Why this stack

- **Cloudflare free tier** has no non-commercial restriction and permits a
  donation link — unlike Vercel Hobby. See `../docs/hosting.md`.
- **Hono** runs unchanged on Node and Workers, so local dev and prod never drift.
- **No build step** on the frontend keeps the whole thing inspectable and cheap
  to host (static files at the edge, Worker only for `/api/*`).
