// The API. Pure Hono, no filesystem, store injected — the SAME app runs on
// @hono/node-server (local) and Cloudflare Workers (prod).
import { Hono } from "hono";
import { selectProgram, exerciseById, muscleById, programs } from "./kb.mjs";
import { buildToday, todayCard, sessionRecap, progressReport } from "./coach.mjs";
import { classifyEnergyBalance, bodyweightTrend } from "../../tools/derive-core.mjs";
import { requestMagicLink, consumeMagicLink, generateToken, sha256hex } from "./auth.mjs";

export function createApp(store, config = {}) {
  const app = new Hono();
  const sendEmail = config.sendEmail ?? (async () => ({ dev: true }));
  // Return the magic link in the HTTP response ONLY in local dev. Never in the
  // deployed Worker — otherwise anyone could pull a valid link for any email.
  const exposeDevLink = config.exposeDevLink === true;

  app.get("/api/health", (c) => c.json({ ok: true, programs: programs.length }));

  // Onboarding: minimal profile -> program selection -> user created.
  app.post("/api/onboard", async (c) => {
    const { profile } = await c.req.json();
    if (!profile?.training_status || !profile?.primary_goal) return c.json({ error: "missing profile fields" }, 400);
    const user_id = crypto.randomUUID();
    profile.user_id = user_id;
    profile.units ??= "metric";
    profile.days_per_week ??= 3;
    const program = selectProgram(profile);
    const user = { profile, program, created_at: new Date().toISOString() };
    await store.saveUser(user_id, user);
    return c.json({ user_id, program: { id: program.id, name: program.name, days_per_week: program.days_per_week, split: program.split } });
  });

  const requireUser = async (c) => {
    const id = c.req.query("u") || (await c.req.json().catch(() => ({}))).user_id;
    if (!id) return { error: c.json({ error: "no user" }, 400) };
    const user = await store.getUser(id);
    if (!user) return { error: c.json({ error: "unknown user" }, 404) };
    return { id, user };
  };

  // Today: the one-decision card + the fully pre-filled session.
  app.get("/api/today", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    const sessions = await store.listSessions(id);
    return c.json({ card: todayCard(user, sessions), session: buildToday(user, sessions) });
  });

  // Log a completed session -> derived recap (the reward).
  app.post("/api/session", async (c) => {
    const body = await c.req.json();
    const id = body.user_id;
    const user = id && (await store.getUser(id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    const session = {
      session_id: body.session_id ?? crypto.randomUUID(),
      user_id: id,
      date: body.date ?? new Date().toISOString(),
      program_ref: user.program.id,
      session_name: body.session_name ?? null,
      sets: (body.sets ?? []).map((s) => ({
        exercise: s.exercise,
        set_type: s.set_type ?? "work",
        weight_kg: Number(s.weight_kg) || 0,
        reps: Math.max(0, Math.round(Number(s.reps) || 0)),
        ...(s.rpe != null ? { rpe: Number(s.rpe) } : {}),
        completed_at: s.completed_at ?? new Date().toISOString(),
      })),
    };
    await store.addSession(id, session);
    const all = await store.listSessions(id);
    return c.json(sessionRecap(user, all, session));
  });

  // Progress: everything derived, nothing asked.
  app.get("/api/progress", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    const [sessions, bodyweights] = await Promise.all([store.listSessions(id), store.listBodyweights(id)]);
    return c.json(progressReport(user, sessions, bodyweights));
  });

  // Bodyweight quick-add -> energy-balance inference (no calorie counting).
  app.post("/api/bodyweight", async (c) => {
    const { user_id, kg, date } = await c.req.json();
    const user = user_id && (await store.getUser(user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    await store.addBodyweight(user_id, { date: date ?? new Date().toISOString().slice(0, 10), kg: Number(kg) });
    const bw = (await store.listBodyweights(user_id)).map((b) => ({ date: b.date, bodyweight_kg: b.kg }));
    const trend = bodyweightTrend(bw);
    return c.json({ count: bw.length, trend, energy_balance: classifyEnergyBalance(trend, user.profile.primary_goal) });
  });

  // Request a magic link to back up (claim) or restore progress. We always
  // respond {sent:true} on anything but a malformed email, so the response can't
  // be used to probe whether an email has an account (enumeration). The dev link
  // is returned ONLY when no real email was sent (no Resend key configured).
  app.post("/api/auth/request", async (c) => {
    const { email, user_id } = await c.req.json().catch(() => ({}));
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
    const result = await requestMagicLink(store, { email, anonUserId: user_id, ip });
    if (result.error === "invalid-email") return c.json({ error: "invalid-email" }, 400);
    if (result.error) return c.json({ sent: true }); // rate-limited / no-user: stay generic
    const origin = new URL(c.req.url).origin;
    const link = `${origin}/verify.html?token=${encodeURIComponent(result.token)}`;
    const sent = await sendEmail({ email: result.email, link, purpose: result.purpose });
    // A real send that failed: tell the client so it can offer a retry, rather
    // than a false "check your inbox". (Only reachable after a valid request, so
    // this never reveals whether an unknown email has an account.)
    if (sent && sent.dev === false && sent.ok === false) return c.json({ sent: false, error: "send-failed" }, 502);
    return c.json({ sent: true, ...(sent?.dev && exposeDevLink ? { dev_link: link } : {}) });
  });

  // Consume a magic link -> bind the account and hand back its user_id so the
  // device can adopt it. Called by /verify.html (a POST, not the emailed GET,
  // so inbox link-scanners can't burn the single-use token before the user taps).
  app.post("/api/auth/consume", async (c) => {
    const { token } = await c.req.json().catch(() => ({}));
    const result = await consumeMagicLink(store, { token });
    if (result.error) return c.json({ error: result.error }, 400);
    const user = await store.getUser(result.user_id);
    // Issue a short-lived, single-use grant so the device that JUST restored this
    // account can fold its local data in (see /api/auth/merge). Reuses the
    // magic_links machinery; purpose 'merge-grant' is never emailed.
    const now = Date.now();
    const { token: grant, tokenHash } = await generateToken();
    await store.createMagicLink({
      token_hash: tokenHash, email: result.email, rl_key: result.email, ip: null,
      user_id: result.user_id, purpose: "merge-grant", expires_at: now + 10 * 60 * 1000, used: 0, created_at: now,
    });
    return c.json({
      user_id: result.user_id,
      email: result.email,
      purpose: result.purpose,
      program_name: user?.program?.name ?? null,
      merge_grant: grant,
    });
  });

  // Merge a device's anonymous logs into a restored account (offered by
  // verify.html after a restore, so nothing logged pre-backup is stranded).
  // Possession of both ids is the auth model, same as every other route; the
  // from-user must be anonymous so an email binding is never left dangling.
  app.post("/api/auth/merge", async (c) => {
    const { from_user_id, to_user_id, grant } = await c.req.json().catch(() => ({}));
    if (!from_user_id || !to_user_id || from_user_id === to_user_id || !grant) return c.json({ error: "bad-request" }, 400);
    // Require a valid merge grant tied to to_user_id: only a caller who just
    // restored `to` can merge into it (not anyone holding two UUIDs).
    const link = await store.getMagicLink(await sha256hex(grant));
    if (!link || link.used || link.purpose !== "merge-grant" || link.user_id !== to_user_id || Date.now() > link.expires_at) {
      return c.json({ error: "bad-grant" }, 403);
    }
    await store.markMagicLinkUsed(link.token_hash);
    const [from, to] = await Promise.all([store.getUser(from_user_id), store.getUser(to_user_id)]);
    if (!from || !to) return c.json({ error: "unknown user" }, 404);
    if (await store.getAccountByUserId(from_user_id)) return c.json({ error: "from-user-has-account" }, 409);
    const moved = await store.reassignUserData(from_user_id, to_user_id);
    return c.json({ merged: true, ...moved });
  });

  // Exercise detail (the "how do I do this?" tap).
  app.get("/api/exercise/:id", (c) => {
    const e = exerciseById.get(c.req.param("id"));
    if (!e) return c.json({ error: "not found" }, 404);
    return c.json({
      id: e.id, name: e.name, cues: e.cues ?? [], common_errors: e.common_errors ?? [],
      equipment: e.equipment,
      primary_muscles: (e.primary_muscles ?? []).map((m) => muscleById.get(m)?.name ?? m),
      secondary_muscles: (e.secondary_muscles ?? []).map((m) => muscleById.get(m)?.name ?? m),
    });
  });

  return app;
}
