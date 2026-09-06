# Daytona cloud-sandbox tooling

Two things, both driven from this directory, both self-contained (the only dependency is
`@daytona/sdk`, so the repo root keeps its "single dep: ajv" invariant):

1. **A clean-room verification gate** — runs the repo's full gates in a fresh cloud sandbox on
   Node 24, so a burst is proven outside this one Node-20 machine before it merges.
2. **A variant tournament** — N sandboxes each implement a different approach to the same task
   with headless Claude Code, then each is measured by the same pre-registered fitness metric.
   The winner is reported, never applied.

See `docs/improvement-loop.md` → "Token discipline" rule 8 for when each is sanctioned. Sandboxes
**never deploy or push**: they clone from an uploaded tarball, so they have no git remote and no
Cloudflare/Resend/VAPID credential (lessons 18b/29).

## Setup

```bash
cd daytona
npm install                      # @daytona/sdk (node_modules is git-ignored)
```

Credentials — put them in `daytona/.env` (git-ignored) or export them; a shell export wins:

```
DAYTONA_API_KEY=dtn_...
ANTHROPIC_API_KEY=sk-ant-...     # only needed for tournaments (headless Claude)
# DAYTONA_TARGET=us              # optional region
```

Build the sandbox image once (installs Claude Code, warms the npm cache; a few minutes):

```bash
npm run snapshot:build           # registers the 'hb-node24-v1' snapshot
npm run smoke                    # sanity: Node 24 + git + Claude present, then deletes the sandbox
```

Snapshots deactivate after 2 weeks unused — if a run reports the snapshot is missing, just
re-run `npm run snapshot:build`. (Or set `HB_USE_IMAGE=1` to build from the image inline on
each create, skipping the snapshot entirely — slower first create, no pre-build step.)

## The gate

```bash
npm run gate                     # ship committed HEAD (~10 min, ~$0.03)
npm run gate -- --dirty          # ship the working tree, uncommitted edits included
npm run gate -- --smoke          # also run the experimental workerd (wrangler dev) stage
```

Exit codes: **0** all green · **1** a stage failed — *this means the code* · **2** inconclusive
(auth/quota/snapshot/network — never a code verdict) · **3** usage. A per-stage table prints, and
the full result lands in `runs/<runId>/report.json`. The gate is pre-merge *evidence in addition
to* the local chains, not a replacement for inline verification.

Stages: root `npm ci` → root `npm test` → app `npm ci` → app `npm test` (Node 24 runs
`test-store-d1.mjs` natively — no lesson-52 re-exec) → **staleness** (`build-data` then
`git diff --quiet`, catching a stale `kb-data.mjs`/`learn-data.js` bundle) → optional smoke.

## The tournament

```bash
npm run tournament -- briefs/dryrun.md            # dry preview: plan + cost, no sandboxes
npm run tournament -- briefs/dryrun.md --yes      # actually run it
npm run tournament -- briefs/mybrief.md --yes --dirty
```

Write a brief from `briefs/_template.md`. The runner **refuses to race** unless the `fitness`
command succeeds and prints a number at HEAD (the baseline must exist *before* the race —
lessons 25/30). It then fans out ≤3 sandboxes (4 needs `--allow-4`), runs Claude in each, commits
and measures each variant (both test chains + staleness + fitness), and prints a judge table.
Artifacts per variant land in `runs/<runId>/<variant>/` (`patch.diff`, `claude-result.json`).

**Adopting a winner** (the tournament never does this for you):

```bash
git checkout -b daytona-<variant>
git apply daytona/runs/<runId>/<variant>/patch.diff
# then run BOTH chains locally AND tamper the winner's new tests (lesson 54) before committing.
```

## Housekeeping

```bash
npm run cleanup                  # delete any sandbox this tooling left behind (labelled hb=1)
```

Stopped sandboxes still consume disk quota, so runs delete their sandbox in a `finally` and set
`ephemeral` + `ttlMinutes` as backstops. `cleanup` is the safety net for a crashed run.

## What this is NOT for

The inner loop (local chains are seconds and free), deploys/prod secrets, browser-walkthrough
evidence, and citation agents (PubMed/Crossref aren't on the sandbox network whitelist) all stay
local. See the plan and `docs/improvement-loop.md` rule 8.
