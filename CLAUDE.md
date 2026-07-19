# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two synchronized deliverables in one repo:
1. **The knowledge base** — an evidence-based, fully-cited hypertrophy KB. Prose in `content/` (ten pillars) mirrored as machine-readable JSON in `data/` (validated against `data/schemas/`). Every substantive claim carries a real web-verified citation (PMID/DOI) and an A–D evidence grade.
2. **The coaching app** (`app/`) — a no-build vanilla-JS PWA + a Hono API that turns the KB into one screen a day. Runs from **one codebase** on Node locally (file store) and Cloudflare Workers + D1 in production.

The north star and the self-improvement process live in `docs/improvement-loop.md`; authoring rules in `STYLE.md`.

## Commands

**KB (repo root):**
```bash
npm install            # single dep: ajv
npm run validate       # every data/ + examples/ file vs its JSON Schema (+ landmark ordering)
npm run check          # citation integrity + data cross-ref integrity (both gates)
npm run check-refs     # data cross-ref only (exercise/muscle/progression ids resolve)
npm run build-bib      # regenerate citations/registry.md from registry.json
npm test               # validate + check + test-derive + test-plan  (the full KB gate)
node tools/test-plan.mjs      # plan-engine tests only
node tools/test-derive.mjs    # derive-engine tests only
```

**App (`cd app`):**
```bash
npm run dev            # build-data, then serve on :8787 (PORT=8788 to override)
npm test               # coach + auth + adherence + routes + session unit tests
node scripts/test-routes.mjs  # a single suite, e.g. the HTTP route tests
npm run deploy         # build-data + wrangler deploy (prod)
npm run cf:dev         # run the Workers build locally (exercises the D1 store)
```

There is no lint step and no frontend build step. Local app data lives in `app/.data/store.json` (git-ignored); delete it to reset.

## Critical workflow rules (these have each caused real bugs)

- **`app/src/kb-data.mjs` is AUTO-GENERATED** from `data/**` by `build-data`. After ANY change under `data/`, run it **and commit the regenerated `kb-data.mjs` in the same change** — otherwise `npm start` (no build) serves stale data and the repo drifts from prod. **The script lives ONLY in `app/package.json` — run `cd app && npm run build-data`. There is NO root `build-data` script, so running `npm run build-data` from the repo root silently no-ops and leaves the bundle stale.** Verify with a clean-tree rebuild: `cd app && npm run build-data` then `git diff --quiet` (any diff = the bundle was stale).
- **Bump the service worker** (`app/public/sw.js` `VERSION`) whenever a `public/` asset changes; `sw.js` is stale-while-revalidate. If an existing asset gains a **new imported file** (e.g. an ESM module), add it to the `SHELL` precache array too, or offline users get a broken import.
- **Deploy is a SEPARATE step from `git pull`.** Chaining them races and ships stale assets. After merging, `git pull` first, then `cd app && npm run deploy` on its own.
- **Two test chains both matter.** Root `npm test` guards the KB + engines; `app npm test` guards the API. `app/scripts/test-routes.mjs` exists because unit tests that fed data straight into `coach.mjs` missed a route whitelist silently dropping a field — **test through the same door the client uses.** Route/coach tests that hit `/api/today` read the REAL `now` (for mesocycle/layoff logic), so date any fixture sessions **relative to `Date.now()`**, not fixed calendar dates — fixed past dates read as a multi-week layoff and silently change the suggested weight.
- **When browser-testing a fresh edit locally,** clear the SW + caches first (`navigator.serviceWorker.getRegistrations()` → unregister; `caches.keys()` → delete) or you'll test stale cached code.

## Architecture: the pure-core + binder split

The engines are **pure, fs-free, `Date.now`/`Math.random`-free** so they run identically in Node and on Cloudflare Workers and stay deterministic. Each has a thin binder that injects the bundled KB:

| Pure core (`tools/`) | Binder (`app/src/`) | Does |
|---|---|---|
| `derive-core.mjs` | `coach.mjs` | Per-muscle weekly volume vs KB MV/MEV/MAV/MRV landmarks, est-1RM progression, stall detection, energy balance from bodyweight trend (no calorie counting), readiness, the adaptive volume-response signal |
| `plan-core.mjs` (`generatePlan`) | `planner.mjs` (`generateUserPlan`) | Deterministic generative plan engine: split → per-muscle set targets from landmarks → equipment/injury-filtered exercise pools → ranked allocation within a session budget → MRV trim → self-check → `critiquePlan` |

The generated program is byte-compatible with `data/schemas/program-template.schema.json`, so `buildToday`/`suggestWeight` in `coach.mjs` consume it unchanged. `plan-core.mjs` is **deterministic** — a byte-identical-output test guards it; never introduce `Date.now`/`Math.random` into the generative path.

## Architecture: the app (one codebase, two runtimes)

- `app/src/app.mjs` — the Hono API. The **store is injected**, so the same routes run on Node and Workers.
- `app/src/store.mjs` (file, local) and `app/src/store-d1.mjs` (D1, prod) **must keep parity** — a method or dedup behavior in one but not the other is a bug. `store.updateUser(id, mutator)` is an optimistic compare-and-swap on the JSON blob; put write-conflict-sensitive preconditions **inside** the mutator, not around the outer read.
- Entry points: `server.node.mjs` (file store + static files), `worker.mjs` (D1 store + `[assets]` binding).
- Frontend is `app/public/app.js` (single-file SPA) + `session-core.mjs` (pure, crash-safety-critical session/superset logic, unit-tested via `app/scripts/test-session.mjs`). The **session player is crash-safe by design** — the live session mirrors to `localStorage` on every change; progress is derived from banked sets, never a trusted cursor. Treat this as the highest-risk surface to modify.
- Auth is **passwordless email magic links** (`app/src/auth.mjs`, `email.mjs` via Resend); the model is possession-of-UUID. The `user_id` is the full credential — never put it in a URL/query string (it leaks into logs); use the `X-HB-User` header or POST body.

## KB conventions

- **Citations** live once in `citations/registry.json` (referenced by key from prose footnotes and `data/**` `citations` arrays). Never fabricate one — web-verify via PubMed E-utilities / Crossref before adding, and set `verified: true` with `verified_via`. `citations/registry.md` is generated (`build-bib`); a staleness gate flags drift.
- **Every content page follows the exact section order in `STYLE.md`** (TL;DR → Quick recommendations → Practical Application → The Evidence → Key Uncertainties → Backing Data → References). Grades are honest; model-based numbers (volume landmarks) are labelled estimates, never fact.
- Exercise entries are **data, not claims** — they don't need citations, but their metadata (primary/secondary muscles, `movement_pattern`, `loading_bias`) must be accurate; `check-refs` enforces that `lengthened_bias === (loading_bias === "lengthened")`.
- Volume landmarks per muscle: **MV < MEV < MAV < MRV** (maintenance / minimum-effective / max-adaptive / max-recoverable), validated for ordering in `validate.mjs`.
