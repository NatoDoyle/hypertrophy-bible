// One cron tick (wrangler.toml [triggers]: every CRON_TICK_MINUTES). worker.mjs binds it to
// the real env; the collaborators are injectable so WHICH tick runs WHAT is tested
// (scripts/test-push.mjs) — the failure it guards is a 5-minute cron re-running hourly work.
import { createD1Store } from "./store-d1.mjs";
import { createComebackSender, createSocialEmailSender } from "./email.mjs";
import { runComebackSweep } from "./nudge.mjs";
import { runPushSweep, cronTick, CRON_TICK_MINUTES } from "./push.mjs";

export function runScheduled(now, env, ctx, { makeStore = createD1Store, pushSweep = runPushSweep, comebackSweep = runComebackSweep } = {}) {
  const tick = cronTick(now);
  const store = makeStore(env.DB);
  // The EMAIL comeback sweep stays a once-daily 16:00-UTC job — gated here so its cadence is
  // unchanged by the cron ticking every few minutes.
  if (tick.comebackEmail) {
    const send = createComebackSender({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
    ctx.waitUntil(comebackSweep(store, send, now).then((r) => console.log("comeback sweep", JSON.stringify(r))));
  }
  // Push sweep runs whenever EITHER delivery channel is configured: real push
  // (VAPID_PRIVATE_JWK is a wrangler secret, VAPID_PUBLIC_KEY a var) or the email
  // fallback (RESEND_API_KEY, already required for the comeback sweep above) for
  // users with no push subscription at all. Absent BOTH is a no-op. This matters
  // even before VAPID is ever configured (BLOCKERS.md #4): without this branch,
  // the whole social-event pipeline (nudge/challenge/cheer/streak-freeze) would
  // never reach anyone, push OR email, until that secret exists. Runs every tick:
  // the reminders' picked times need the fine cadence, while runPushSweep keeps the
  // social events and the email-only accounts to the hourly ticks (cronTick).
  const hasVapid = !!(env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC_KEY);
  if (hasVapid || env.RESEND_API_KEY) {
    const vapid = hasVapid
      ? { privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), publicKeyB64u: env.VAPID_PUBLIC_KEY, subject: "mailto:hello@hypertrophybible.com" }
      : null; // no real push possible, but the email fallback still runs
    const sendSocialEmail = env.RESEND_API_KEY ? createSocialEmailSender({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM }) : null;
    ctx.waitUntil(pushSweep(store, vapid, now, undefined, sendSocialEmail, { tickMinutes: CRON_TICK_MINUTES }).then((r) => console.log("push sweep", JSON.stringify(r))));
  }
  return tick;
}
