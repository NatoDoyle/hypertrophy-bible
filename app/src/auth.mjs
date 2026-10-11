// Passwordless email backup. No passwords, no sessions to manage: an email is
// bound to the user_id that owns its data, and a single-use, short-lived,
// hashed magic-link token proves ownership. Uses WebCrypto only, so the exact
// same code runs on Node (global crypto) and Cloudflare Workers.
//
// Two flows, auto-detected server-side from whether the email already has an
// account:
//   claim   — email is new → bind it to the caller's current (anonymous) user_id
//   restore — email exists → hand its user_id back so a new device adopts it
// (A re-request by the account's own user is a claim of itself. `kind` in
// requestMagicLink names the finer situation, which only the email copy reads.)

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

// The 6-digit sign-in code (W270). On iPhone an emailed link opens in Safari, whose
// storage is separate from the Home-Screen app the app asks iOS users to install —
// so the link can sign SAFARI in but never the app itself. The code is typed into
// the app instead. Uniform over 000000-999999: draw 32 bits, rejecting the top
// sliver that would bias `% 1e6` (2^32 mod 1e6 = 967296).
const CODE_SPACE = 1e6, CODE_REJECT_AT = 2 ** 32 - (2 ** 32 % CODE_SPACE);
export function generateCode() {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= CODE_REJECT_AT);
  return String(buf[0] % CODE_SPACE).padStart(6, "0");
}
// A code is only 10^6 guesses, so the store hash is defence in depth; the real
// protection is the 30-minute expiry, single use, NEWEST-code-only, and these caps
// (checked BEFORE any comparison, so a locked address can't be probed even with
// the right code). Per address per day: ~1e-5 odds a day for a targeted guesser.
export const CODE_FAILS_PER_EMAIL = 10; // per canonical address, per 24h
export const CODE_FAILS_PER_IP = 30;    // per requester IP, per hour
const codeHash = (tokenHash, code) => sha256hex(`${tokenHash}:${code}`);

export async function requestMagicLink(store, { email, anonUserId, ip = null, now = Date.now(), ttlMs = TTL_MS }) {
  const norm = normalizeEmail(email);
  if (!norm) return { error: "invalid-email" };

  const since = now - RATE_WINDOW_MS;
  const rlKey = canonicalEmail(norm);
  if ((await store.countRecentLinks(rlKey, since)) >= MAX_LINKS_PER_EMAIL) return { error: "rate-limited" };
  if (ip && (await store.countRecentByIp(ip, since)) >= MAX_LINKS_PER_IP) return { error: "rate-limited" };

  const existing = await store.getAccountByEmail(norm);
  // WHICH situation this request is in decides what the EMAIL says — never the HTTP
  // answer, which stays a generic {sent:true} so the route can't probe for accounts;
  // the inbox is the one place it's safe to say "you already have an account". Every
  // request for a bound email used to be a bare "restore", so a device backing up its
  // own fresh workout was mailed "Restore your progress" (owner report), and the bound
  // user asking again minted a merge grant nothing could ever spend.
  //   new       — no account yet: bind it to this device's user (claim)
  //   reconfirm — the account IS this device's user: a claim of itself, nothing to merge
  //   merge     — another account, and this device's user has none: its workouts can come along
  //   switch    — this device's user is bound to a different email: switch, never merge
  //   signin    — no device user (a fresh device signing in)
  let kind, purpose, boundUserId;
  if (!existing) { kind = "new"; purpose = "claim"; boundUserId = anonUserId; }
  else if (anonUserId && existing.user_id === anonUserId) { kind = "reconfirm"; purpose = "claim"; boundUserId = anonUserId; }
  else {
    purpose = "restore";
    boundUserId = existing.user_id;
    kind = !anonUserId ? "signin" : (await store.accountEmail(anonUserId)) ? "switch" : "merge";
  }
  if (!boundUserId) return { error: "no-user" }; // a new email with no anon id: nothing to bind

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
  const code = generateCode();
  await store.saveLinkCode({ token_hash: tokenHash, rl_key: rlKey, code_hash: await codeHash(tokenHash, code), created_at: now });
  return { token, code, purpose, kind, email: norm, boundUserId };
}

// ONE consume core for both doors (the emailed token and the typed code): a code is
// only a pointer to its link row, so single use across the two comes for free, and
// the merge grant is minted in exactly one place.
async function consumeLinkRow(store, link, now) {
  if (!link) return { error: "invalid" };
  // Only a real sign-in link is consumable here — never a merge grant or a
  // rate-limit marker row that happens to live in the same table.
  if (link.purpose !== "claim" && link.purpose !== "restore") return { error: "invalid" };
  if (link.used) return { error: "used" };
  if (now > link.expires_at) return { error: "expired" };

  // First claim wins: if this email was already bound by an earlier consumed link,
  // adopt that binding rather than clobbering it (which would orphan the first
  // claimant's data). Turns a duplicate claim into a restore of the same account.
  const current = await store.getAccountByEmail(link.email);
  const boundUserId = current ? current.user_id : link.user_id;
  // Guard against binding to a user that no longer exists (e.g. deleted by a
  // merge) — otherwise the account points at a ghost and the app can't load.
  if (!(await store.getUser(boundUserId))) return { error: "invalid" };
  // Atomically claim the token: if a concurrent request already consumed it,
  // markMagicLinkUsed returns false and we bail — the link is truly single-use.
  if (!(await store.markMagicLinkUsed(link.token_hash))) return { error: "used" };
  await store.saveAccount(link.email, boundUserId, new Date(now).toISOString());
  // Return the EFFECTIVE purpose: a claim that adopted an EARLIER binding (a
  // different user than this link's own) IS a restore from the caller's side —
  // their device holds its own anonymous user whose synced workouts would be
  // stranded on switch. Reporting "claim" here suppressed the merge grant and
  // the merge offer in verify.html, silently abandoning that data. A claim that
  // bound its own user stays a claim (nothing to merge).
  const purpose = link.purpose === "claim" && boundUserId !== link.user_id ? "restore" : link.purpose;
  // The merge grant goes ONLY with a restore — the one flow that folds a device's
  // local logs into a re-adopted account. A claim binds the caller's OWN user, so
  // there is nothing to merge; minting a grant there would hand out a "move + delete
  // any anonymous user" primitive far broader than intended (#19). Distinct rl_key
  // bucket: server-minted grants must never consume the user's 5/hour email budget.
  let merge_grant = null;
  if (purpose === "restore") {
    const { token: grant, tokenHash } = await generateToken();
    await store.createMagicLink({
      token_hash: tokenHash, email: link.email, rl_key: "grant:" + link.email, ip: null,
      user_id: boundUserId, purpose: "merge-grant", expires_at: now + 10 * 60 * 1000, used: 0, created_at: now,
    });
    merge_grant = grant;
  }
  return { user_id: boundUserId, email: link.email, purpose, merge_grant };
}

export async function consumeMagicLink(store, { token, now = Date.now() }) {
  if (!token) return { error: "no-token" };
  return consumeLinkRow(store, await store.getMagicLink(await sha256hex(token)), now);
}

// The typed-code door. Every failure — unknown address, no live code, wrong code,
// malformed input — answers the same "invalid" and leaves marker rows in their own
// buckets (ip NULL, so the link-request caps never see them).
export async function consumeMagicCode(store, { email, code, ip = null, now = Date.now() }) {
  const norm = normalizeEmail(email);
  const rlKey = norm ? canonicalEmail(norm) : null;
  if (ip && (await store.countRecentLinks("codefail-ip:" + ip, now - 60 * 60 * 1000)) >= CODE_FAILS_PER_IP) return { error: "too-many-attempts" };
  if (rlKey && (await store.countRecentLinks("codefail:" + rlKey, now - 24 * 60 * 60 * 1000)) >= CODE_FAILS_PER_EMAIL) return { error: "too-many-attempts" };
  const failed = async () => {
    const marker = (rl_key) => store.createMagicLink({ token_hash: crypto.randomUUID(), email: "", rl_key, ip: null, user_id: "codefail-marker", purpose: "codefail-marker", expires_at: now, used: 1, created_at: now });
    if (rlKey) await marker("codefail:" + rlKey);
    if (ip) await marker("codefail-ip:" + ip);
    return { error: "invalid" };
  };
  const typed = String(code ?? "").replace(/\s+/g, "");
  if (!rlKey || !/^\d{6}$/.test(typed)) return failed();
  const row = await store.latestLinkCode(rlKey, now - TTL_MS);
  if (!row || (await codeHash(row.token_hash, typed)) !== row.code_hash) return failed();
  return consumeLinkRow(store, await store.getMagicLink(row.token_hash), now);
}
