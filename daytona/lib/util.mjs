// Tiny shared helpers for the Daytona orchestrators. Plain Node — this is host-side
// tooling, so Date.now()/timers are fine here (the no-Date.now rule is for the pure
// engine cores and Workflow scripts, not this).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load daytona/.env (git-ignored) into process.env without a dotenv dependency. Existing
// env vars win, so a shell export always overrides the file. Call once at each entry point.
export function loadEnv() {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const nowMs = () => Date.now();

export function fmtDur(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// A short run id without Math.random dependence issues (host-side, so both are allowed,
// but a timestamp id keeps runs sortable on disk).
export function makeRunId(prefix = 'run') {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}-${stamp}`;
}

// Minimal argv parser: --flag → true, --key value / --key=value → string, bare → positional.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Exit codes shared across the tools. 2 = infra-inconclusive; must NEVER be a code verdict.
export const EXIT = { OK: 0, FAIL: 1, INFRA: 2, USAGE: 3 };

// Thrown for anything that means "we could not obtain a code verdict" — auth, quota,
// snapshot inactive, upload failure, a deadline on a network/ci stage. Callers map it to EXIT.INFRA.
export class InfraError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'InfraError';
    this.hint = hint;
  }
}
