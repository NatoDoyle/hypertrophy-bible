// Offline shell cache. Strategy: stale-while-revalidate for the static shell
// (instant offline open; updates land one load later), API requests untouched.
// Bump VERSION on breaking asset changes to drop old caches.
const VERSION = "hb-shell-v18";
const SHELL = ["/", "/app.js", "/styles.css", "/learn-data.js", "/manifest.webmanifest", "/icon.svg"];

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

  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(e.request);
      const refresh = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => null);
      // Serve cache instantly when we have it; otherwise wait for the network.
      return cached || (await refresh) || new Response("Offline", { status: 503 });
    })
  );
});
