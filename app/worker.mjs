// Cloudflare Workers entry. The SAME Hono app as local dev (src/app.mjs), just
// with the D1 store instead of the file store, and static assets served by the
// platform's [assets] binding. No build step, no framework lock-in.
import { createApp } from "./src/app.mjs";
import { createD1Store } from "./src/store-d1.mjs";

let app; // cached per isolate; env.DB is stable for the isolate's lifetime

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Static files (index.html, app.js, styles.css, manifest, icon) are served
    // directly by the assets binding; only the API reaches the Worker.
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    app ??= createApp(createD1Store(env.DB));
    return app.fetch(request, env, ctx);
  },
};
