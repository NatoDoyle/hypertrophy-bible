// The service worker's module refresh must be ATOMIC (W271c, from the W271-W274
// pre-mortem's completeness critic). app.js statically imports named exports from
// /session-core.mjs, /ui-helpers.mjs and /account-adopt.mjs. Revalidating them one file
// at a time let a flaky deploy-day load cache a NEW app.js beside an OLD helper module —
// the next (offline) open fails its imports and the app is blank, with an in-progress
// workout unreachable. Loads sw.js in node:vm with stubbed caches/fetch, red-first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let pass = 0, fail = 0;
const check = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };
const src = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://app.test";

function harness(net) {
  const stored = new Map();
  const listeners = {};
  const pathOf = (req) => new URL(typeof req === "string" ? req : req.url, ORIGIN).pathname;
  const res = (body) => ({ ok: true, status: 200, body, clone() { return res(body); }, text: async () => body });
  const cache = {
    match: async (req) => (stored.has(pathOf(req)) ? res(stored.get(pathOf(req))) : undefined),
    put: async (req, r) => { stored.set(pathOf(req), r.body); },
    addAll: async () => {},
  };
  const ctx = vm.createContext({
    self: { addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim() {} }, registration: {} },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    location: { origin: ORIGIN },
    fetch: async (req) => { const b = net[pathOf(req)]; if (b === undefined || b instanceof Error) throw new Error("network"); return res(b); },
    URL, Promise, console, setTimeout,
    Response: class { constructor(b, o) { this.body = b; this.status = o?.status ?? 200; this.ok = this.status < 400; } },
  });
  vm.runInContext(src, ctx);
  const fire = async (path) => {
    const waits = [];
    let responded;
    listeners.fetch({ request: { url: ORIGIN + path, method: "GET" }, respondWith: (p) => { responded = p; }, waitUntil: (p) => { waits.push(p); } });
    await responded;
    await Promise.all(waits);
    return { handled: responded !== undefined };
  };
  return { stored, fire };
}
const MODULES = ["/app.js", "/session-core.mjs", "/movement-demo.mjs", "/ui-helpers.mjs", "/account-adopt.mjs"];
const seedOld = (h) => { for (const p of [...MODULES, "/styles.css"]) h.stored.set(p, `OLD${p}`); };

await check("a changed app.js whose sibling module fails to download is NOT cached alone — the old module graph stays whole", async () => {
  const net = Object.fromEntries(MODULES.map((p) => [p, `NEW${p}`]));
  net["/session-core.mjs"] = new Error("dropped on a flaky deploy-day load");
  const h = harness(net); seedOld(h);
  await h.fire("/app.js");
  for (const p of MODULES) assert.equal(h.stored.get(p), `OLD${p}`, `${p} must stay old`);
});

await check("…and when every module downloads, they all move together", async () => {
  const h = harness(Object.fromEntries(MODULES.map((p) => [p, `NEW${p}`]))); seedOld(h);
  await h.fire("/app.js");
  for (const p of MODULES) assert.equal(h.stored.get(p), `NEW${p}`);
});

await check("an unchanged module triggers no graph refresh (nothing new to pair)", async () => {
  const net = Object.fromEntries(MODULES.map((p) => [p, `OLD${p}`]));
  net["/ui-helpers.mjs"] = `NEW/ui-helpers.mjs`; // would only land via a graph refresh
  const h = harness(net); seedOld(h);
  await h.fire("/app.js");
  assert.equal(h.stored.get("/ui-helpers.mjs"), "OLD/ui-helpers.mjs");
});

await check("a non-module asset (styles.css) still refreshes on its own", async () => {
  const h = harness({ "/styles.css": "NEW/styles.css" }); seedOld(h);
  await h.fire("/styles.css");
  assert.equal(h.stored.get("/styles.css"), "NEW/styles.css");
});

await check("the sign-in page is never handled or cached, under EITHER spelling (prod 307s /verify.html?token= to /verify?token=)", async () => {
  // Review C6: this was a source grep, green whatever the guard's logic. Fire real
  // fetch events through the handler: the browser must go straight to the network.
  const h = harness({ "/verify": "PAGE", "/verify.html": "PAGE" });
  for (const p of ["/verify?token=abc", "/verify.html?token=abc"]) {
    const { handled } = await h.fire(p);
    assert.equal(handled, false, `${p} must not be answered by the service worker`);
  }
  assert.equal(h.stored.size, 0, "nothing token-bearing lands in Cache Storage");
  assert.equal((await h.fire("/styles.css")).handled, true, "control: an ordinary asset IS handled (else this proves nothing)");
});

// W286: a rest alert must ALERT — even when it replaces the last one (same tag) — and buzz.
function pushHarness() {
  const shown = [];
  const listeners = {};
  const ctx = vm.createContext({
    self: { addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim() {} }, registration: { showNotification: async (title, opts) => { shown.push({ title, opts }); } } },
    caches: { open: async () => ({}), keys: async () => [], delete: async () => true }, location: { origin: ORIGIN }, URL, Promise, console,
  });
  vm.runInContext(src, ctx);
  const push = async (payload) => { const waits = []; listeners.push({ data: payload === undefined ? null : { json: () => payload }, waitUntil: (p) => waits.push(p) }); await Promise.all(waits); return shown.at(-1); };
  return { push };
}
await check("a rest alert re-alerts and vibrates; every other notification keeps its quiet replace", async () => {
  const h = pushHarness();
  const rest = await h.push({ title: "Rest's up", body: "Next: Squat — set 3 of 4", tag: "hb-rest" });
  assert.equal(rest.title, "Rest's up");
  assert.equal(rest.opts.tag, "hb-rest");
  assert.equal(rest.opts.renotify, true, "a second rest's alert must not land silently on the first one's tag");
  assert.ok(Array.isArray(rest.opts.vibrate) && rest.opts.vibrate.length > 0);
  const other = await h.push({ title: "The Hypertrophy Bible", body: "x", tag: "hb-nudge" });
  assert.ok(!other.opts.renotify && !other.opts.vibrate, "control: the other kinds are unchanged");
  const empty = await h.push(undefined);
  assert.equal(empty.opts.tag, "hb-reminder", "control: the empty daily reminder keeps its static copy");
});

console.log(`\n${pass} service-worker test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
