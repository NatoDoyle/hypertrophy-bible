// The shared account-adoption module (public/account-adopt.mjs): ONE decision tree
// for both doors that sign a device in — verify.html (the emailed link) and the
// app's code box (the 6-digit code, for a link that opened in another browser).
// Dependencies are injected, so the whole tree runs under Node, red-first.
import assert from "node:assert/strict";
import { adoptAccount, resolveAdoption, adoptionMessage, isIOSBrowserTab, retireOldReminder, verifyBootAction, pendingCode, rememberPendingCode, CODE_PENDING_MS } from "../public/account-adopt.mjs";

let pass = 0, fail = 0;
const check = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };
const memStorage = (init = {}) => { const m = new Map(Object.entries(init)); return {
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => Object.fromEntries(m) }; };
// A fake server: answers by path, records every call.
// Unknown paths THROW: a probe of any route the fixture didn't name (e.g. /api/adherence,
// whose GET advances seen-once watermarks) fails the test instead of passing silently.
const fakeServer = (routes) => { const calls = []; const fetchJson = async (path, opts = {}) => { calls.push({ path, ...opts }); if (!(path in routes)) throw new Error(`unexpected request to ${path}`); const r = routes[path]; if (r instanceof Error) throw r; return typeof r === "function" ? r(opts) : r; }; return { calls, fetchJson }; };
const consumed = (over = {}) => ({ user_id: "acct", email: "me@t.com", purpose: "restore", program_name: "PPL", units: "imperial", exercise_units: { "leg-press": "imperial" }, merge_grant: "grant-1", ...over });

await check("adoptAccount: takes the account's identity, units and plan name, and re-points queued workouts at it", () => {
  const storage = memStorage({ hb_user: "phone", hb_queue: JSON.stringify([{ id: "q1", path: "/api/session", body: JSON.stringify({ user_id: "phone", session_id: "s1" }) }]) });
  adoptAccount(consumed(), { storage });
  const d = storage.dump();
  assert.equal(d.hb_user, "acct"); assert.equal(d.hb_email, "me@t.com"); assert.equal(d.hb_program, "PPL"); assert.equal(d.hb_units, "imperial");
  assert.deepEqual(JSON.parse(d.hb_ex_units), { "leg-press": "imperial" });
  assert.equal(JSON.parse(JSON.parse(d.hb_queue)[0].body).user_id, "acct");
});

await check("adoptAccount: an account with no per-exercise units clears the previous account's map", () => {
  const storage = memStorage({ hb_user: "phone", hb_ex_units: JSON.stringify({ "x": "imperial" }) });
  adoptAccount(consumed({ exercise_units: {} }), { storage });
  assert.equal(storage.getItem("hb_ex_units"), null);
});

await check("resolveAdoption: the same user (a claim or re-confirm) adopts silently — no question, no merge", async () => {
  const storage = memStorage({ hb_user: "acct" }); const asked = []; const srv = fakeServer({});
  const r = await resolveAdoption(consumed({ purpose: "claim", merge_grant: null }), { current: "acct", storage, fetchJson: srv.fetchJson, ask: async (q) => { asked.push(q); return true; } });
  assert.deepEqual([r.adopted, r.merged, asked.length, srv.calls.length], [true, false, 0, 0]);
});

await check("resolveAdoption: a restore onto a phone with its own workouts asks, then merges with from-side possession", async () => {
  const storage = memStorage({ hb_user: "phone" }); const asked = [];
  const srv = fakeServer({ "/api/progress": { sessions_logged: 2, bodyweights_logged: 0, account_email: null }, "/api/auth/merge": { merged: true } });
  const r = await resolveAdoption(consumed(), { current: "phone", storage, fetchJson: srv.fetchJson, ask: async (q) => { asked.push(q); return true; } });
  const merge = srv.calls.find((c) => c.path === "/api/auth/merge");
  assert.equal(r.adopted, true); assert.equal(r.merged, true);
  assert.match(asked[0], /workouts logged on it/);
  assert.equal(merge.headers["X-HB-User"], "phone");
  assert.deepEqual(JSON.parse(merge.body), { grant: "grant-1", from_user_id: "phone", to_user_id: "acct" });
  assert.equal(storage.getItem("hb_user"), "acct");
});

await check("resolveAdoption: a failed merge the user then declines leaves this phone exactly as it was", async () => {
  const storage = memStorage({ hb_user: "phone" });
  const srv = fakeServer({ "/api/progress": { sessions_logged: 1, account_email: null }, "/api/auth/merge": { error: "nope" } });
  let n = 0;
  const r = await resolveAdoption(consumed(), { current: "phone", storage, fetchJson: srv.fetchJson, ask: async () => (++n === 1) });
  assert.equal(r.adopted, false);
  assert.deepEqual(storage.dump(), { hb_user: "phone" });
});

await check("resolveAdoption: a phone signed in to ANOTHER account is offered a switch, never a merge that can't happen", async () => {
  const storage = memStorage({ hb_user: "phone" }); const asked = [];
  const srv = fakeServer({ "/api/progress": { sessions_logged: 3, account_email: "other@t.com" }, "/api/auth/merge": { merged: true } });
  const r = await resolveAdoption(consumed(), { current: "phone", storage, fetchJson: srv.fetchJson, ask: async (q) => { asked.push(q); return true; } });
  assert.equal(r.adopted, true); assert.equal(r.merged, false);
  assert.ok(!srv.calls.some((c) => c.path === "/api/auth/merge"), "no merge POST");
  assert.match(asked[0], /other@t\.com/);
});

await check("resolveAdoption: an empty phone adopts a restore without asking anything", async () => {
  const storage = memStorage({ hb_user: "phone" }); const asked = [];
  const srv = fakeServer({ "/api/progress": { sessions_logged: 0, bodyweights_logged: 0, account_email: null } });
  const r = await resolveAdoption(consumed(), { current: "phone", storage, fetchJson: srv.fetchJson, ask: async (q) => { asked.push(q); return true; } });
  assert.deepEqual([r.adopted, r.merged, asked.length], [true, false, 0]);
});

await check("resolveAdoption: an unreachable probe assumes the phone HAS data and asks, rather than silently discarding", async () => {
  const storage = memStorage({ hb_user: "phone" }); const asked = [];
  const srv = fakeServer({ "/api/progress": new Error("offline"), "/api/auth/merge": { merged: true } });
  await resolveAdoption(consumed(), { current: "phone", storage, fetchJson: srv.fetchJson, ask: async (q) => { asked.push(q); return true; } });
  assert.ok(asked.length >= 1);
});

await check("resolveAdoption: beforeAdopt runs after the questions and before the switch — and a declined switch never reaches it", async () => {
  const order = []; const storage = memStorage({ hb_user: "phone" });
  const srv = fakeServer({ "/api/progress": { sessions_logged: 1, account_email: null }, "/api/auth/merge": { merged: true } });
  await resolveAdoption(consumed(), { current: "phone", storage, fetchJson: srv.fetchJson, ask: async () => { order.push("ask"); return true; }, beforeAdopt: async ({ merged }) => order.push(`before:${merged}:${storage.getItem("hb_user")}`) });
  assert.deepEqual(order, ["ask", "before:true:phone"]);
  let reached = false;
  const declined = await resolveAdoption(consumed({ purpose: "claim" }), { current: "phone", storage: memStorage({ hb_user: "phone" }), fetchJson: fakeServer({ "/api/progress": { sessions_logged: 1, account_email: null } }).fetchJson, ask: async () => false, beforeAdopt: async () => { reached = true; } });
  assert.equal(declined.adopted, false); assert.equal(reached, false);
});

await check("adoptionMessage: says what the email promised — the saved plan back on a restore, saved progress on a claim", () => {
  assert.equal(adoptionMessage(consumed({ purpose: "claim" })).sub, "Your progress is saved to me@t.com.");
  assert.match(adoptionMessage(consumed(), { merged: true }).sub, /workouts are in your account now\. Your saved plan, “PPL”, is back\./);
  assert.match(adoptionMessage(consumed({ program_name: null })).sub, /^This phone now uses your account for me@t\.com\.$/);
});

// --- The old identity's reminder (W270b review): this policy lived inline in app.js,
// untested; it's here now so every branch is pinned, including a failed unsubscribe.
const removeSpy = (fail = false) => { const calls = []; return { calls, remove: async (id) => { calls.push(id); if (fail) throw new Error("offline"); } }; };
await check("retireOldReminder: nothing to retire — no old identity, same identity, a merge (the subscription moved with it), or no reminder on", async () => {
  for (const [label, args] of [["no old", { before: null, newUser: "acct", merged: false }], ["same", { before: "acct", newUser: "acct", merged: false }],
    ["merged", { before: "phone", newUser: "acct", merged: true }], ["no push", { before: "phone", newUser: "acct", merged: false, push: null }]]) {
    const storage = memStorage(args.push === null ? {} : { hb_push: "1" }); const spy = removeSpy();
    const note = await retireOldReminder({ ...args, storage, remove: spy.remove });
    assert.equal(spy.calls.length, 0, label); assert.equal(note, "", label);
    assert.equal(storage.getItem("hb_push"), args.push === null ? null : "1", label);
  }
});
await check("retireOldReminder: a switch away from an identity with reminders turns them off for the new account — and says so", async () => {
  const storage = memStorage({ hb_push: "1" }); const spy = removeSpy();
  const note = await retireOldReminder({ before: "phone", newUser: "acct", merged: false, storage, remove: spy.remove });
  assert.deepEqual(spy.calls, ["phone"]); assert.equal(storage.getItem("hb_push"), null);
  assert.match(note, /turn them back on in Me/);
});
await check("retireOldReminder: a FAILED unsubscribe never blocks the sign-in, never leaves Me claiming reminders are on, and says what may happen", async () => {
  const storage = memStorage({ hb_push: "1" }); const spy = removeSpy(true);
  const note = await retireOldReminder({ before: "phone", newUser: "acct", merged: false, storage, remove: spy.remove });
  assert.equal(storage.getItem("hb_push"), null);
  assert.match(note, /may still get a reminder meant for its old setup/);
});

await check("verifyBootAction: no token → missing; an iPhone/iPad Safari tab → ask first (never spend the code the app needs); anything else → consume", () => {
  assert.equal(verifyBootAction({ token: null, iosTab: true }), "missing");
  assert.equal(verifyBootAction({ token: "t", iosTab: true }), "ask");
  assert.equal(verifyBootAction({ token: "t", iosTab: false }), "consume");
});

await check("pendingCode: a sent email's code stays enterable for its 30 minutes, then forgets itself", () => {
  const storage = memStorage(); const T = Date.UTC(2026, 0, 5, 9);
  rememberPendingCode(storage, "me@t.com", T);
  assert.deepEqual(pendingCode(storage, T + 29 * 60e3), { email: "me@t.com" });
  assert.equal(CODE_PENDING_MS, 30 * 60e3);
  assert.equal(pendingCode(storage, T + 31 * 60e3), null);
  assert.equal(storage.getItem("hb_code_pending"), null, "an expired memory is cleared, not left to lie");
  storage.setItem("hb_code_pending", "{not json");
  assert.equal(pendingCode(storage, T), null);
});

await check("isIOSBrowserTab: an iPhone or iPad Safari TAB is one; the Home-Screen app and Android are not", () => {
  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", platform: "iPhone", maxTouchPoints: 5 };
  assert.equal(isIOSBrowserTab({ ...iphone, standalone: false }), true);
  assert.equal(isIOSBrowserTab({ ...iphone, standalone: true }), false);
  assert.equal(isIOSBrowserTab({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5, standalone: false }), true); // iPadOS
  assert.equal(isIOSBrowserTab({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 0, standalone: false }), false); // a real Mac
  assert.equal(isIOSBrowserTab({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile", platform: "Linux armv8l", maxTouchPoints: 5, standalone: false }), false);
});

console.log(`\n${pass} account-adopt test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
