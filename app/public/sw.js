// Offline shell cache. Strategy: stale-while-revalidate for the static shell
// (instant offline open; updates land one load later), API requests untouched.
// Bump VERSION on breaking asset changes to drop old caches.
const VERSION = "hb-shell-v75";
const SHELL = ["/", "/app.js", "/session-core.mjs", "/styles.css", "/learn-data.js", "/manifest.webmanifest", "/icon.svg"];

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

// --- Web Push device reminders (#4). Empty-payload pushes: the notification
// copy is static (no user data transits the push service) and tapping it
// opens (or focuses) the app on the Today screen.
self.addEventListener("push", (e) => {
  e.waitUntil(self.registration.showNotification("The Hypertrophy Bible", {
    body: "Your next session is ready — it adjusts to wherever you're at today.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: "hb-reminder", // one reminder at a time — a new one replaces the old
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const w = wins.find((x) => x.url.includes(self.registration.scope));
    return w ? w.focus() : self.clients.openWindow("/");
  }));
});
