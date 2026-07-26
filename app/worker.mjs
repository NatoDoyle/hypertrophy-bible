// Cloudflare Workers entry. The SAME Hono app as local dev (src/app.mjs), just
// with the D1 store instead of the file store, and static assets served by the
// platform's [assets] binding. No build step, no framework lock-in.
import { createApp } from "./src/app.mjs";
import { createD1Store } from "./src/store-d1.mjs";
import { createEmailSender, createComebackSender, createSocialEmailSender } from "./src/email.mjs";
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
  // Hourly cron ([triggers] in wrangler.toml). The PUSH sweep needs the fine cadence
  // to nudge each user at their own local hour (timezone-aware). The EMAIL comeback
  // sweep stays a once-daily 16:00-UTC job — gated here so its behaviour is byte-for-
  // byte unchanged by the switch to an hourly trigger.
  async scheduled(event, env, ctx) {
    const now = Date.now();
    const store = createD1Store(env.DB);
    if (new Date(now).getUTCHours() === 16) {
      const send = createComebackSender({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
      ctx.waitUntil(runComebackSweep(store, send, now).then((r) => console.log("comeback sweep", JSON.stringify(r))));
    }
    // Push sweep runs whenever EITHER delivery channel is configured: real push
    // (VAPID_PRIVATE_JWK is a wrangler secret, VAPID_PUBLIC_KEY a var) or the email
    // fallback (RESEND_API_KEY, already required for the comeback sweep above) for
    // users with no push subscription at all. Absent BOTH is a no-op. This matters
    // even before VAPID is ever configured (BLOCKERS.md #4): without this branch,
    // the whole social-event pipeline (nudge/challenge/cheer/streak-freeze) would
    // never reach anyone, push OR email, until that secret exists. Runs every hour;
    // runPushSweep gates each user to their one eligible local hour internally for
    // the daily reminder (the per-event social notifications fire on every tick).
    const hasVapid = !!(env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC_KEY);
    if (hasVapid || env.RESEND_API_KEY) {
      const vapid = hasVapid
        ? { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64u: env.VAPID_PUBLIC_KEY, subject: "mailto:hello@hypertrophybible.com" }
        : null; // no real push possible, but the email fallback below still runs
      const sendSocialEmail = env.RESEND_API_KEY ? createSocialEmailSender({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM }) : null;
      ctx.waitUntil(runPushSweep(store, vapid, now, undefined, sendSocialEmail).then((r) => console.log("push sweep", JSON.stringify(r))));
    }
  },
};
