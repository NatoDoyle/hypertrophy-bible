// Cloudflare Workers entry. The SAME Hono app as local dev (src/app.mjs), just
// with the D1 store instead of the file store, and static assets served by the
// platform's [assets] binding. No build step, no framework lock-in.
import { createApp } from "./src/app.mjs";
import { createD1Store } from "./src/store-d1.mjs";
import { createEmailSender } from "./src/email.mjs";
import { runScheduled } from "./src/scheduled.mjs";
import { RestAlarm, doRestAlarm } from "./src/rest-alarm.mjs";

// The rest alarm's Durable Object class (wrangler.toml [[durable_objects.bindings]], W286).
export { RestAlarm };

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
      statsKey: env.STATS_KEY ?? null, // wrangler secret; absent -> /api/stats is a 404
      restAlarm: env.REST_ALARM ? doRestAlarm(env.REST_ALARM) : null,
    });
    return app.fetch(request, env, ctx);
  },
  // The cron ([triggers] in wrangler.toml) ticks every few minutes so reminders land at the
  // times users pick (W285); src/scheduled.mjs decides what each tick runs, read off the tick's
  // SCHEDULED time so a late start still lands in its own slot.
  async scheduled(event, env, ctx) {
    runScheduled(event.scheduledTime ?? Date.now(), env, ctx);
  },
};
