// Cloudflare Workers entry. The SAME Hono app as local dev (src/app.mjs), just
// with the D1 store instead of the file store, and static assets served by the
// platform's [assets] binding. No build step, no framework lock-in.
import { createApp } from "./src/app.mjs";
import { createD1Store } from "./src/store-d1.mjs";
import { createEmailSender, createComebackSender } from "./src/email.mjs";
import { runComebackSweep } from "./src/nudge.mjs";
import { runPushSweep } from "./src/push.mjs";

let app; // cached per isolate; env is stable for the isolate's lifetime

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Static files (index.html, app.js, styles.css, verify.html, manifest, icon)
    // are served directly by the assets binding; only the API reaches the Worker.
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    app ??= createApp(createD1Store(env.DB), {
      sendEmail: createEmailSender({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM }),
      vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
    });
    return app.fetch(request, env, ctx);
  },
  // Daily cron ([triggers] in wrangler.toml): comeback emails + device pushes.
  async scheduled(event, env, ctx) {
    const store = createD1Store(env.DB);
    const send = createComebackSender({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
    ctx.waitUntil(runComebackSweep(store, send, Date.now()).then((r) => console.log("comeback sweep", JSON.stringify(r))));
    // Push sweep runs only when the keypair is configured (VAPID_PRIVATE_JWK is
    // a wrangler secret; VAPID_PUBLIC_KEY a var) — absent config is a no-op.
    if (env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC_KEY) {
      const vapid = { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64u: env.VAPID_PUBLIC_KEY, subject: "mailto:hello@hypertrophybible.com" };
      ctx.waitUntil(runPushSweep(store, vapid, Date.now()).then((r) => console.log("push sweep", JSON.stringify(r))));
    }
  },
};
