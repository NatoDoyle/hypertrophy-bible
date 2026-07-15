// The API. Pure Hono, no filesystem, store injected — the SAME app runs on
// @hono/node-server (local) and Cloudflare Workers (prod).
import { Hono } from "hono";
import { selectProgram, exerciseById, programs } from "./kb.mjs";
import { buildToday, todayCard, sessionRecap, progressReport } from "./coach.mjs";
import { classifyEnergyBalance, bodyweightTrend } from "../../tools/derive-core.mjs";

export function createApp(store) {
  const app = new Hono();

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

  // Exercise detail (the "how do I do this?" tap).
  app.get("/api/exercise/:id", (c) => {
    const e = exerciseById.get(c.req.param("id"));
    if (!e) return c.json({ error: "not found" }, 404);
    return c.json({ id: e.id, name: e.name, cues: e.cues ?? [], common_errors: e.common_errors ?? [], equipment: e.equipment, primary_muscles: e.primary_muscles });
  });

  return app;
}
