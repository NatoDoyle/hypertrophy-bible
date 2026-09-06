// The one place the sandbox image and its resources are defined.
// Used by snapshot.mjs (to register a named snapshot) and, as a fallback,
// by lib/sandbox.mjs when no pre-built snapshot exists.
//
// node:24-bookworm gives us native `node:sqlite` (>=22.5) — so app/scripts/test-store-d1.mjs
// runs directly instead of re-execing itself (improvement-loop lesson 52) — plus a git binary
// (needed for the staleness stage's `git diff --quiet`). Claude Code is installed globally for
// the tournament runner; the npm cache is warmed with the repo's real deps so `npm ci` inside
// the sandbox is fast and resilient to a flaky registry.

import { Image } from '@daytona/sdk';

// Bump the version suffix whenever this definition changes (new Claude Code, dep major bump).
export const SNAPSHOT_NAME = process.env.HB_SNAPSHOT || 'hb-node24-v1';

// Per-sandbox resources. Baked into the snapshot; the org ceiling is 4 vCPU / 8 GiB / 10 GiB.
export const RESOURCES = { cpu: 2, memory: 4, disk: 5 };

// The repo's real runtime deps (verified against ./package.json and app/package.json).
// Warming these into the npm cache is a best-effort speedup, not a correctness dependency:
// `npm ci` still reads the committed lockfiles and fetches any delta from the registry.
const WARM_DEPS = ['ajv@8', 'ajv-formats@3', 'hono@4', '@hono/node-server@1', 'wrangler@3'];

export function hbImage() {
  return Image.base('node:24-bookworm')
    .env({ CI: 'true', WRANGLER_SEND_METRICS: 'false', npm_config_fund: 'false', npm_config_audit: 'false' })
    .runCommands(
      'npm install -g @anthropic-ai/claude-code',
      `mkdir -p /opt/npm-cache && cd /tmp && npm install --no-save --cache /opt/npm-cache ${WARM_DEPS.join(' ')} >/dev/null 2>&1 || true`,
      'rm -rf /tmp/node_modules /tmp/package*.json',
    );
}
