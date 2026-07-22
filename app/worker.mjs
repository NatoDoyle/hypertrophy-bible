// Cloudflare Workers entry. The SAME Hono app as local dev (src/app.mjs), just
// with the D1 store instead of the file store, and static assets served by the
// platform's [assets] binding. No build step, no framework lock-in.
import { createApp } from "./src/app.mjs";
import { createD1Store } from "./src/store-d1.mjs";
import { createEmailSender, createComebackSender } from "./src/email.mjs";
import { runComebackSweep } from "./src/nudge.mjs";

let app; // cached per isolate; env is stable for the isolate's lifetime

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Static files (index.html, app.js, styles.css, verify.html, manifest, icon)
    // are served directly by the assets binding; only the API reaches the Worker.
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    app ??= createApp(createD1Store(env.DB), {
      sendEmail: createEmailSender({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM }),
    });
    return app.fetch(request, env, ctx);
  },
  // Daily cron ([triggers] in wrangler.toml): the comeback-nudge sweep.
  async scheduled(event, env, ctx) {
    const store = createD1Store(env.DB);
    const send = createComebackSender({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
    ctx.waitUntil(runComebackSweep(store, send, Date.now()).then((r) => console.log("comeback sweep", JSON.stringify(r))));
  },
};
