// Offline shell cache. Strategy: stale-while-revalidate for the static shell
// (instant offline open; updates land one load later), API requests untouched.
// Bump VERSION on breaking asset changes to drop old caches.
const VERSION = "hb-shell-v152";
const SHELL = ["/", "/app.js", "/session-core.mjs", "/movement-demo.mjs", "/styles.css", "/learn-data.js", "/manifest.webmanifest", "/icon.svg"];

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
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag, // one notification per tag at a time — a new one replaces the old
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const w = wins.find((x) => x.url.includes(self.registration.scope));
    return w ? w.focus() : self.clients.openWindow("/");
  }));
});
