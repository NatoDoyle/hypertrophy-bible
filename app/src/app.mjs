// The API. Pure Hono, no filesystem, store injected — the SAME app runs on
// @hono/node-server (local) and Cloudflare Workers (prod).
import { Hono } from "hono";
import { selectProgram, exerciseById, muscleById, programs } from "./kb.mjs";
import { buildToday, todayCard, sessionRecap, progressReport, dailyReadiness } from "./coach.mjs";
import { classifyEnergyBalance, bodyweightTrend } from "../../tools/derive-core.mjs";
import { requestMagicLink, consumeMagicLink, generateToken, sha256hex } from "./auth.mjs";
import { generateUserPlan, critiqueUserPlan } from "./planner.mjs";
import { adherenceReport } from "./adherence.mjs";

export function createApp(store, config = {}) {
  const app = new Hono();
  const sendEmail = config.sendEmail ?? (async () => ({ dev: true }));
  // Return the magic link in the HTTP response ONLY in local dev. Never in the
  // deployed Worker — otherwise anyone could pull a valid link for any email.
  const exposeDevLink = config.exposeDevLink === true;

  // Every failure answers in JSON the client can actually parse. A "write-conflict"
  // means updateUser's compare-and-swap lost 5 races (two devices/tabs writing at
  // once) — that's a retry, not a crash, so it gets a 409 rather than an opaque 500.
  app.onError((err, c) => {
    if (err?.message === "write-conflict") {
      return c.json({ error: "busy", message: "Another change landed first — please try again." }, 409);
    }
    console.error("unhandled:", err?.stack || err);
    return c.json({ error: "server-error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, programs: programs.length }));

  // Onboarding: profile -> a plan GENERATED from the KB (volume landmarks +
  // exercise DB + equipment/injuries), with a rationale we can explain.
  app.post("/api/onboard", async (c) => {
    const { profile } = await c.req.json().catch(() => ({})); // empty/non-JSON -> clean 400, not a 500
    if (!profile?.training_status || !profile?.primary_goal) return c.json({ error: "missing profile fields" }, 400);
    const user_id = crypto.randomUUID();
    profile.user_id = user_id;
    profile.units ??= "metric";
    profile.days_per_week ??= 3;
    const { program, rationale, meta } = generateUserPlan(profile);
    const user = { profile, program, plan_rationale: rationale, plan_meta: { ...meta, block_start: new Date().toISOString() }, created_at: new Date().toISOString() };
    await store.saveUser(user_id, user);
    return c.json({ user_id, program: { id: program.id, name: program.name, days_per_week: program.days_per_week, split: program.split } });
  });

  // The coach explaining the plan: split reasoning, per-muscle volume vs the KB
  // landmarks, why each exercise, evidence grades, and any honest warnings.
  app.get("/api/plan/explain", async (c) => {
    const { user, error } = await requireUser(c);
    if (error) return error;
    return c.json({ program: { name: user.program.name, split: user.program.split, days_per_week: user.program.days_per_week, sessions: user.program.sessions }, rationale: user.plan_rationale ?? null, profile: user.profile ?? null });
  });

  // Regenerate the plan from the stored profile (after a profile edit).
  app.post("/api/plan/regenerate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.user_id;
    if (!id || !(await store.getUser(id))) return c.json({ error: "unknown user" }, 404);
    // CAS so a concurrent write (double-tap, second tab) can't be clobbered —
    // this route now backs the Settings screen, so it will see real traffic.
    const priorSessions = await store.listSessions(id);
    const nowISO = new Date().toISOString();
    // Compare arrays order-insensitively — a settings save that RE-ORDERS
    // priority_muscles/equipment/injuries (prefill order ≠ original tap order) is
    // not a real change and must not restart the mesocycle.
    const canon = (v) => Array.isArray(v) ? JSON.stringify([...v].map((x) => JSON.stringify(x)).sort()) : JSON.stringify(v);
    const TRAINING_FIELDS = ["training_status", "primary_goal", "days_per_week", "session_length_min", "available_equipment", "priority_muscles", "injuries", "specialization"];
    let out = null;
    const updated = await store.updateUser(id, (u) => {
      const before = u.profile;
      const next = body.profile ? { ...u.profile, ...body.profile, user_id: id } : u.profile;
      const trainingChanged = TRAINING_FIELDS.some((k) => canon(before?.[k]) !== canon(next[k]));
      // Cosmetic edit (units, sex): keep the CURRENT block's accessory rotation and
      // mesocycle position. Training change: fresh block 0 (week-1 ramp, rebased rotation).
      const blockIndex = trainingChanged ? 0 : (u.plan_meta?.block_index ?? 0);
      u.profile = next;
      const { program, rationale, meta } = generateUserPlan(u.profile, { blockIndex });
      u.program = program; u.plan_rationale = rationale;
      u.plan_meta = {
        ...meta,
        block_start: trainingChanged || !u.plan_meta?.block_start ? nowISO : u.plan_meta.block_start,
        block_index: blockIndex, // carry it through — dropping it made the next /api/today re-rotate
        // Rebase rotation with buildToday's OWN-program predicate (merged foreign
        // sessions once froze Today on Day A), only on a real training change.
        rotation_base: trainingChanged
          ? priorSessions.filter((s) => !s.program_ref || s.program_ref === program.id).length
          : (u.plan_meta?.rotation_base ?? 0),
      };
      out = program;
      return u;
    }).catch((e) => { if (e?.message === "write-conflict") return null; throw e; });
    if (!updated) return c.json({ error: "busy", message: "Another change landed first — please try again." }, 409);
    return c.json({ program: { id: out.id, name: out.name, split: out.split, days_per_week: out.days_per_week } });
  });

  // KB critique of the current (or a supplied) plan: volume vs landmarks, gaps,
  // balance, ordering — the same analysis for a generated or a user-built plan.
  app.post("/api/plan/critique", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = b.user_id && (await store.getUser(b.user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    return c.json(critiqueUserPlan(b.program || user.program, user.custom_exercises || []));
  });

  // Save an edited/custom plan (sanitized: real exercise ids, sets 1-10), then
  // return its KB critique so the builder shows feedback immediately.
  app.post("/api/plan/save", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = b.user_id && (await store.getUser(b.user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    const p = b.program;
    if (!p?.sessions?.length) return c.json({ error: "bad-program" }, 400);
    const customIds = new Set((user.custom_exercises || []).map((x) => x.id));
    const sessions = p.sessions
      .map((s) => ({
        name: String(s.name || "Day"),
        exercises: (s.exercises || [])
          .filter((e) => exerciseById.has(e.exercise) || customIds.has(e.exercise))
          .map((e) => ({ exercise: e.exercise, sets: Math.max(1, Math.min(10, Math.round(Number(e.sets) || 3))), rep_range: String(e.rep_range || "8-12"), ...(e.rir ? { rir: String(e.rir) } : {}), ...(e.superset_with ? { superset_with: String(e.superset_with) } : {}) })),
      }))
      .filter((s) => s.exercises.length);
    if (!sessions.length) return c.json({ error: "empty-program" }, 400);
    // an edit can remove one half of a superset pair — never keep a dangling link
    for (const sess of sessions) {
      const ids = new Set(sess.exercises.map((e) => e.exercise));
      for (const e of sess.exercises) if (e.superset_with && !ids.has(e.superset_with)) delete e.superset_with;
    }
    let program = null;
    const updated = await store.updateUser(b.user_id, (u) => {
      // Only mark the plan `custom` (which permanently opts it out of mesocycle
      // accessory rotation) when the saved exercises ACTUALLY differ from the
      // generated ones — a no-op "Save & re-check" must not silently freeze a
      // generated plan out of its rotation forever.
      const sig = (ss) => JSON.stringify((ss || []).map((s) => s.exercises.map((e) => `${e.exercise}:${e.sets}:${e.rep_range}`)));
      const changed = !!u.program?.custom || sig(u.program?.sessions) !== sig(sessions);
      program = { ...u.program, name: String(p.name || u.program.name), split: u.program.split || "other", days_per_week: sessions.length, sessions, ...(changed ? { custom: true } : {}) };
      u.program = program;
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ ok: true, critique: critiqueUserPlan(program, updated.custom_exercises || []) });
  });

  // Lean exercise list for the plan builder's swap pickers (includes the user's
  // own custom exercises when the X-HB-User header identifies them).
  app.get("/api/exercises", async (c) => {
    const id = c.req.header("X-HB-User");
    const user = id ? await store.getUser(id) : null;
    const all = [...exerciseById.values(), ...(user?.custom_exercises || [])];
    return c.json(all.map((e) => ({ id: e.id, name: e.name, primary_muscles: e.primary_muscles ?? [], equipment: e.equipment, mechanic: e.mechanic, custom: !!e.custom })));
  });

  // Add a custom exercise to the user's personal library. Resolves everywhere
  // (plan editor, Today, recap, progress, critique) via the merged lookups.
  app.post("/api/exercise/custom", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = b.user_id && (await store.getUser(b.user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    const ex = b.exercise || {};
    const exName = String(ex.name || "").trim().slice(0, 60);
    const primary = (ex.primary_muscles || []).filter((m) => muscleById.has(m));
    if (!exName || !primary.length) return c.json({ error: "need a name and at least one primary muscle" }, 400);
    const equipment = ["barbell", "dumbbell", "machine", "cable", "bodyweight", "band", "kettlebell", "other"].includes(ex.equipment) ? ex.equipment : "other";
    const mechanic = ex.mechanic === "compound" ? "compound" : "isolation";
    const secondary = (ex.secondary_muscles || []).filter((m) => muscleById.has(m));
    const slug = exName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "exercise";
    // Concurrency-safe append: the id is derived and pushed inside the CAS mutator
    // so two near-simultaneous adds can't collide or clobber one another (#20).
    let custom = null;
    const updated = await store.updateUser(b.user_id, (u) => {
      u.custom_exercises = u.custom_exercises || [];
      const taken = new Set([...exerciseById.keys(), ...u.custom_exercises.map((x) => x.id)]);
      let id = `custom-${slug}`, n = 2; while (taken.has(id)) id = `custom-${slug}-${n++}`;
      custom = { id, name: exName, primary_muscles: primary, ...(secondary.length ? { secondary_muscles: secondary } : {}), equipment, mechanic, movement_pattern: mechanic === "compound" ? "other" : "isolation-other", custom: true, ...(Array.isArray(ex.cues) ? { cues: ex.cues.slice(0, 4).map(String) } : {}) };
      u.custom_exercises.push(custom);
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ ok: true, exercise: custom });
  });

  const requireUser = async (c) => {
    // The user_id IS the full account credential (possession model), so it must
    // NEVER travel in a URL — a `?u=` query string leaks it into access logs,
    // browser history, and any copied/shared link. Accept it only from the
    // X-HB-User header (GETs) or the POST body, both of which stay out of URLs.
    const id = c.req.header("X-HB-User") || (await c.req.json().catch(() => ({}))).user_id;
    if (!id) return { error: c.json({ error: "no user" }, 400) };
    const user = await store.getUser(id);
    if (!user) return { error: c.json({ error: "unknown user" }, 404) };
    return { id, user };
  };

  // Today: the one-decision card + the fully pre-filled session.
  app.get("/api/today", async (c) => {
    let { id, user, error } = await requireUser(c);
    if (error) return error;
    const [sessions, checkins] = await Promise.all([store.listSessions(id), store.listCheckins(id)]);
    const nowISO = new Date().toISOString();
    // NEW MESOCYCLE -> rotate the accessories. Compounds keep their ranking so
    // double-progression baselines survive; isolations get a fresh deterministic
    // shuffle (blockIndex feeds the tie-break jitter). Custom-edited plans are
    // sacred and never auto-regenerated; beginners don't run blocks.
    const blockStart = user.plan_meta?.block_start;
    if (blockStart && user.profile?.training_status !== "beginner" && !user.program?.custom) {
      const blockIndex = Math.max(0, Math.floor((Date.now() - +new Date(blockStart)) / (7 * 6 * 86400000)));
      if (blockIndex !== (user.plan_meta.block_index ?? 0)) {
        const updated = await store.updateUser(id, (u) => {
          // Re-check the FRESH CAS-read state: the outer guard (L203) saw a stale
          // copy. If, in the race window, a concurrent /api/plan/save made the plan
          // custom, or another request already rotated to this block, leave it
          // untouched — otherwise the rotation silently clobbers a just-saved custom
          // plan. (Every other mutator here re-checks its precondition inside the CAS.)
          if (u.program?.custom || blockIndex === (u.plan_meta?.block_index ?? 0)) return u;
          const { program, rationale, meta } = generateUserPlan(u.profile, { blockIndex });
          u.program = program; u.plan_rationale = rationale;
          u.plan_meta = {
            ...meta,
            block_start: u.plan_meta.block_start, // the cycle continues; only content rotates
            block_index: blockIndex,
            rotation_base: sessions.filter((s) => !s.program_ref || s.program_ref === program.id).length,
            rotated_at: nowISO, // buildToday shows "new block" once (until a session is logged under it)
          };
          return u;
        }).catch((e) => { if (e?.message === "write-conflict") return null; throw e; }); // a lost race retries next request; a real bug must surface, not be swallowed
        if (updated) user = updated;
      }
    }
    const today = nowISO.slice(0, 10);
    const readiness = dailyReadiness(checkins.find((ck) => (ck.date || "").slice(0, 10) === today));
    return c.json({ card: todayCard(user, sessions), session: buildToday(user, sessions, readiness, user.custom_exercises || [], nowISO) });
  });

  // Optional daily check-in (sleep/energy/stress/mood, 1-5). One per day; returns
  // an immediate readiness read that gently shapes today's session.
  app.post("/api/checkin", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = b.user_id && (await store.getUser(b.user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    const checkin = { user_id: b.user_id, date: b.date || new Date().toISOString().slice(0, 10), source: "manual" };
    for (const k of ["sleep_quality", "energy", "stress", "mood"]) if (b[k] != null) checkin[k] = Math.max(1, Math.min(5, Math.round(Number(b[k]))));
    await store.addCheckin(b.user_id, checkin);
    return c.json({ ok: true, readiness: dailyReadiness(checkin) });
  });

  // Adherence & gamification: streak, XP/level, milestones, motivational state.
  app.get("/api/adherence", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    const sessions = await store.listSessions(id);
    return c.json(adherenceReport(user, sessions));
  });

  // Safety rail: pause suspends all streak pressure with zero penalty (illness/injury).
  app.post("/api/pause", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const paused = b.on ? { from: new Date().toISOString().slice(0, 10), reason: b.reason ?? null } : null;
    const updated = await store.updateUser(b.user_id, (u) => { u.paused = paused; return u; }); // CAS: won't clobber a concurrent write (#20)
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ paused: !!updated.paused });
  });

  app.get("/api/checkin/today", async (c) => {
    const { id, error } = await requireUser(c);
    if (error) return error;
    const checkins = await store.listCheckins(id);
    const today = new Date().toISOString().slice(0, 10);
    const ck = checkins.find((x) => (x.date || "").slice(0, 10) === today) || null;
    return c.json({ done: !!ck, checkin: ck, readiness: dailyReadiness(ck) });
  });

  // Log a completed session -> derived recap (the reward).
  app.post("/api/session", async (c) => {
    const body = await c.req.json().catch(() => ({})); // empty/non-JSON body -> clean 404 below, not a 500
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
        ...(s.rir != null ? { rir: Math.max(0, Math.min(10, Math.round(Number(s.rir)))) } : {}),
        // deload MUST round-trip: progression anchoring and stall detection both
        // filter on it — the whitelist silently dropping it made the entire
        // deload-aware pipeline inert in production while unit tests (which
        // bypass this route) stayed green.
        ...(s.deload ? { deload: true } : {}),
        completed_at: s.completed_at ?? new Date().toISOString(),
      })),
    };
    await store.addSession(id, session);
    const all = await store.listSessions(id);
    return c.json(sessionRecap(user, all, session, user.custom_exercises || []));
  });

  // Progress: everything derived, nothing asked.
  app.get("/api/progress", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    const [sessions, bodyweights] = await Promise.all([store.listSessions(id), store.listBodyweights(id)]);
    return c.json(progressReport(user, sessions, bodyweights, user.custom_exercises || []));
  });

  // Bodyweight quick-add -> energy-balance inference (no calorie counting).
  app.post("/api/bodyweight", async (c) => {
    const { user_id, kg, date } = await c.req.json().catch(() => ({})); // guard empty/non-JSON body
    const user = user_id && (await store.getUser(user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    if (!Number.isFinite(Number(kg)) || Number(kg) <= 0) return c.json({ error: "bad-weight" }, 400);
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
    // Issue the merge grant ONLY for a restore — the one flow that folds a device's
    // local logs into a re-adopted account. A claim binds the caller's OWN user, so
    // there is nothing to merge; minting a grant there would hand out a "move + delete
    // any anonymous user" primitive far broader than intended (#19).
    let merge_grant = null;
    if (result.purpose === "restore") {
      const now = Date.now();
      const { token: grant, tokenHash } = await generateToken();
      await store.createMagicLink({
        // Distinct rl_key bucket: server-minted grants must never consume the
        // user's 5/hour email budget (the 4th restore in a sitting was silently
        // sending nothing because internal grants had filled the bucket).
        token_hash: tokenHash, email: result.email, rl_key: "grant:" + result.email, ip: null,
        user_id: result.user_id, purpose: "merge-grant", expires_at: now + 10 * 60 * 1000, used: 0, created_at: now,
      });
      merge_grant = grant;
    }
    return c.json({
      user_id: result.user_id,
      email: result.email,
      purpose: result.purpose,
      program_name: user?.program?.name ?? null,
      units: user?.profile?.units ?? null, // so a fresh device shows weights in the user's unit immediately
      merge_grant,
    });
  });

  // Merge a device's anonymous logs into a restored account (offered by
  // verify.html after a restore, so nothing logged pre-backup is stranded).
  // Possession of both ids is the auth model, same as every other route; the
  // from-user must be anonymous so an email binding is never left dangling.
  app.post("/api/auth/merge", async (c) => {
    const { from_user_id, to_user_id, grant } = await c.req.json().catch(() => ({}));
    if (!from_user_id || !to_user_id || from_user_id === to_user_id || !grant) return c.json({ error: "bad-request" }, 400);
    // Merge is the ONLY route that permanently DELETES a user (its final step drops
    // the from-user row), so it needs proof of BOTH ids, not just knowledge of one.
    // The grant (below) proves the caller just restored `to`; this proves they also
    // hold `from` — the caller must present it as their own X-HB-User, exactly like
    // every other authenticated route. Without this, anyone who merely LEARNS an
    // anonymous user's UUID could move that victim's data into their own account and
    // then delete the victim — a destructive escalation beyond the read/write that
    // bare possession already grants.
    if (c.req.header("X-HB-User") !== from_user_id) return c.json({ error: "from-not-authorized" }, 403);
    // Require a valid merge grant tied to to_user_id: only a caller who just
    // restored `to` can merge into it (not anyone holding two UUIDs).
    const link = await store.getMagicLink(await sha256hex(grant));
    if (!link || link.used || link.purpose !== "merge-grant" || link.user_id !== to_user_id || Date.now() > link.expires_at) {
      return c.json({ error: "bad-grant" }, 403);
    }
    // Atomically consume the grant: if a concurrent merge already spent it,
    // markMagicLinkUsed returns false and we refuse — the destructive move runs once.
    if (!(await store.markMagicLinkUsed(link.token_hash))) return c.json({ error: "bad-grant" }, 403);
    const [from, to] = await Promise.all([store.getUser(from_user_id), store.getUser(to_user_id)]);
    if (!from || !to) return c.json({ error: "unknown user" }, 404);
    if (await store.getAccountByUserId(from_user_id)) return c.json({ error: "from-user-has-account" }, 409);
    const moved = await store.reassignUserData(from_user_id, to_user_id);
    return c.json({ merged: true, ...moved });
  });

  // Exercise detail (the "how do I do this?" tap) — resolves custom exercises too.
  app.get("/api/exercise/:id", async (c) => {
    const uid = c.req.header("X-HB-User");
    const user = uid ? await store.getUser(uid) : null;
    const e = exerciseById.get(c.req.param("id")) || (user?.custom_exercises || []).find((x) => x.id === c.req.param("id"));
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
