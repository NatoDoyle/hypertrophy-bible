// Passwordless email backup. No passwords, no sessions to manage: an email is
// bound to the user_id that owns its data, and a single-use, short-lived,
// hashed magic-link token proves ownership. Uses WebCrypto only, so the exact
// same code runs on Node (global crypto) and Cloudflare Workers.
//
// Two flows, auto-detected server-side from whether the email already has an
// account:
//   claim   — email is new → bind it to the caller's current (anonymous) user_id
//   restore — email exists → hand its user_id back so a new device adopts it

const enc = new TextEncoder();

export const TTL_MS = 30 * 60 * 1000; // magic links expire in 30 minutes
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_LINKS_PER_EMAIL = 5; // per canonical email per hour
const MAX_LINKS_PER_IP = 20; // per requester IP per hour (generous for shared IPs)

export function normalizeEmail(email) {
  const e = String(email ?? "").trim().toLowerCase();
  // Deliberately minimal: catch obvious junk, let the mail server be the judge.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Collapse provider aliases so victim+1@gmail / v.i.c.t.i.m@gmail share ONE
// rate-limit bucket — otherwise the per-email cap is trivially bypassed to bomb
// a single inbox. Used only for throttling; mail is still sent to the real address.
export function canonicalEmail(normalized) {
  const at = normalized.lastIndexOf("@");
  if (at < 0) return normalized;
  let local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  local = local.split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A 256-bit random token; we persist only its hash so a DB leak can't be replayed.
export async function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  return { token, tokenHash: await sha256hex(token) };
}

export async function requestMagicLink(store, { email, anonUserId, ip = null, now = Date.now(), ttlMs = TTL_MS }) {
  const norm = normalizeEmail(email);
  if (!norm) return { error: "invalid-email" };

  const since = now - RATE_WINDOW_MS;
  const rlKey = canonicalEmail(norm);
  if ((await store.countRecentLinks(rlKey, since)) >= MAX_LINKS_PER_EMAIL) return { error: "rate-limited" };
  if (ip && (await store.countRecentByIp(ip, since)) >= MAX_LINKS_PER_IP) return { error: "rate-limited" };

  const existing = await store.getAccountByEmail(norm);
  const purpose = existing ? "restore" : "claim";
  const boundUserId = existing ? existing.user_id : anonUserId;
  if (!boundUserId) return { error: "no-user" }; // restore for an unknown email with no anon id

  const { token, tokenHash } = await generateToken();
  await store.createMagicLink({
    token_hash: tokenHash,
    email: norm,
    rl_key: rlKey,
    ip,
    user_id: boundUserId,
    purpose,
    expires_at: now + ttlMs,
    used: 0,
    created_at: now,
  });
  return { token, purpose, email: norm, boundUserId };
}

export async function consumeMagicLink(store, { token, now = Date.now() }) {
  if (!token) return { error: "no-token" };
  const link = await store.getMagicLink(await sha256hex(token));
  if (!link) return { error: "invalid" };
  if (link.used) return { error: "used" };
  if (now > link.expires_at) return { error: "expired" };

  await store.markMagicLinkUsed(link.token_hash);
  // First claim wins: if this email was already bound by an earlier consumed link,
  // adopt that binding rather than clobbering it (which would orphan the first
  // claimant's data). Turns a duplicate claim into a restore of the same account.
  const current = await store.getAccountByEmail(link.email);
  const boundUserId = current ? current.user_id : link.user_id;
  await store.saveAccount(link.email, boundUserId, new Date(now).toISOString());
  return { user_id: boundUserId, email: link.email, purpose: link.purpose };
}
