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

console.log(`\n${pass} service-worker test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
