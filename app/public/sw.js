// Offline shell cache. Strategy: stale-while-revalidate for the static shell
// (instant offline open; updates land one load later), API requests untouched.
// Bump VERSION on breaking asset changes to drop old caches.
const VERSION = "hb-shell-v197";
const SHELL = ["/", "/app.js", "/session-core.mjs", "/movement-demo.mjs", "/ui-helpers.mjs", "/account-adopt.mjs", "/styles.css", "/learn-data.js", "/manifest.webmanifest", "/icon.svg"];

// The app's ES modules update ATOMICALLY. app.js statically imports named exports from
// the helper modules, so a NEW app.js cached beside an OLD helper (that one file's
// refresh failed on a flaky deploy-day load) fails its imports and blanks the app on
// the next open — an in-progress workout included. When a module changes, re-fetch
// every module and cache all of them or none (app/scripts/test-sw.mjs).
const MODULES = SHELL.filter((p) => p === "/app.js" || p.endsWith(".mjs"));
async function refreshModules(cache) {
  const fresh = await Promise.all(MODULES.map((p) => fetch(p).then((r) => (r.ok ? r : Promise.reject(new Error(`${p} ${r.status}`))))));
  await Promise.all(MODULES.map((p, i) => cache.put(p, fresh[i])));
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // API is always live — never cached
  // The sign-in page spends a single-use credential: a stale cached copy (from before
  // its iOS guard) could spend the code a Home-Screen user still needs, and caching it
  // keeps token-bearing URLs in Cache Storage. Always live — under BOTH spellings:
  // production's asset handling 307s /verify.html?token=… to /verify?token=….
  if (url.pathname === "/verify.html" || url.pathname === "/verify") return;

  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request);
      // Copy BEFORE the cached body is handed to the page (a used body can't be cloned).
      const cachedCopy = cached ? cached.clone() : null;
      const isModule = MODULES.includes(url.pathname);
      const refresh = fetch(e.request)
        .then(async (res) => {
          if (!res.ok) return res;
          if (!isModule) { await cache.put(e.request, res.clone()); return res; }
          // A module: if it changed, the whole module graph moves together — or not at all.
          const before = cachedCopy ? await cachedCopy.text() : null;
          if (before !== (await res.clone().text())) await refreshModules(cache).catch(() => {});
          return res;
        })
        .catch(() => null);
      // Hold the background revalidation with waitUntil, or the browser can kill
      // the SW the moment the cached response is returned — before cache.put
      // finishes — so the "updates land one load later" self-heal never completes
      // and a stale asset persists across reloads. (On the no-cache path we await
      // refresh anyway, so this only matters when serving from cache.)
      e.waitUntil(refresh);
      // Serve cache instantly when we have it; otherwise wait for the network.
      return cached || (await refresh) || new Response("Offline", { status: 503 });
    })
  );
});

// --- Web Push device reminders (#4). The daily/commitment reminder is an
// EMPTY payload (no user data transits the push service) and falls back to
// static copy here. A discrete social event (e.g. a training-partner nudge,
// push.mjs's sendPush) instead carries an RFC 8291 encrypted JSON payload —
// the browser's push subsystem decrypts it before this handler ever sees
// `e.data`, so reading it here needs no crypto of our own. Either way,
// tapping the notification opens (or focuses) the app.
self.addEventListener("push", (e) => {
  let title = "The Hypertrophy Bible";
  let body = "Your next session is ready — it adjusts to wherever you're at today.";
  let tag = "hb-reminder";
  if (e.data) {
    try {
      const data = e.data.json();
      if (data.title) title = data.title;
      if (data.body) body = data.body;
      if (data.tag) tag = data.tag;
    } catch {} // malformed/foreign payload: keep the safe static reminder copy
  }
  // Rest's up (W286) must ALERT on every rest. A same-tag replacement can land silently (Safari
  // has no `renotify` — W286 review), so each rest's alert is its OWN notification, the earlier
  // ones cleared first so the tray holds one — and it buzzes where vibration exists.
  const rest = tag === "hb-rest";
  e.waitUntil((async () => {
    if (rest) { try { for (const n of await self.registration.getNotifications()) if (n.tag?.startsWith("hb-rest")) n.close(); } catch {} }
    await self.registration.showNotification(title, {
      body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: rest ? `hb-rest-${Date.now()}` : tag, // one notification per tag at a time — a new one replaces the old
      ...(rest ? { vibrate: [200, 100, 200] } : {}),
    });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const w = wins.find((x) => x.url.includes(self.registration.scope));
    return w ? w.focus() : self.clients.openWindow("/");
  }));
});
