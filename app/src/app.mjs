// The API. Pure Hono, no filesystem, store injected — the SAME app runs on
// @hono/node-server (local) and Cloudflare Workers (prod).
import { Hono } from "hono";
import { exerciseById, muscleById, programs, contraindications } from "./kb.mjs";
import { buildToday, todayCard, sessionRecap, progressReport, dailyReadiness, computeVolumeAdjust, stalledExerciseIds, reactiveDeloadDue, blockPhase, BLOCK_WEEKS } from "./coach.mjs";
import { classifyEnergyBalance, bodyweightTrend, isoWeekKey, isoWeekKeyLocal, weekHasPassed, WEEK_DAY_KEYS, graduatedStatus, trainedWeeksInBlock } from "../../tools/derive-core.mjs";
import { requestMagicLink, consumeMagicLink, generateToken, sha256hex } from "./auth.mjs";
import { generateUserPlan, critiqueUserPlan, userExercises, explainUserPlan, isSpecializing } from "./planner.mjs";
import { adherenceReport, streakFreezeState, publicShareCard, settleChallenge, challengeSlots, normalizeChallengeProfile, MAX_OPEN_CHALLENGES, celebrationEvent } from "./adherence.mjs";
import { isAllowedPushEndpoint } from "./push.mjs";
import { nutritionPlan, navyBodyFat, bmiBodyFat, ACTIVITY } from "../../tools/nutrition-core.mjs";
import { normalizeSessionLocalDate, normalizeSessionTiming, validLocalDate } from "./session-time.mjs";
import { stripServerOwnedProfile } from "./merge-archive.mjs";

// The injury regions the ENGINE can actually act on, read from the KB rather than
// hand-listed — a hand-listed copy is how the client came to offer 6 of the 8
// regions data/injury-contraindications.json supports.
const VALID_INJURY_REGIONS = new Set(Object.keys(contraindications?.regions ?? {}));

// Hard bounds on a logged set's numbers. `rir` has been clamped at this door for
// waves — `weight_kg` and `reps` sitting unbounded right beside it is lesson 16
// exactly (the boundary guard applied to ONE field of a record), and auth here is
// possession-of-UUID so any client can post. The blast radius of one bad number is
// permanent and wide: it's celebrated as a PR (+50 XP), becomes that week's best in
// progressionByExercise / stallDetect / progressionCadence, and suggestWeight then
// adds an increment ON TOP of it. These ceilings sit far above anything a human
// lifts (the raw deadlift record is ~500 kg; no prescribed band goes past 30 reps),
// so they only ever catch garbage — the *ergonomic* guard against a realistic typo
// (a stray zero, lb typed into a kg field) is the player's confirm, which judges a
// set against that lift's OWN history. Clamp rather than reject: a 400 here would
// strand a queued offline session, and losing logged data is the worse failure.
export const MAX_SET_WEIGHT_KG = 1000;
export const MAX_SET_REPS = 500;
const boundedNum = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
};

// The same door, for a WEIGH-IN — lesson 27's "look at the validated field's
// siblings", one level up: `/api/checkin` regex-validated its `date` while
// `/api/bodyweight` passed the identical field through untouched, and neither
// bounded `kg`. A weigh-in is stored ONE PER DATE and read newest-last, so a
// client-supplied `date: "9999-12-31"` (auth is possession-of-UUID — any client can
// post) becomes the permanently-latest weigh-in: it feeds nutritionInputs' current
// weight, the bodyweight trend and the energy-balance read forever, and unlike a bad
// set it could never be taken back, because the correction path is "log that same
// date again" and no UI can reach a date the calendar doesn't offer.
//
// Falls back rather than 400s, matching /api/checkin and the set bounds above: a
// rejected write strands a queued offline weigh-in, and losing logged data is the
// worse failure. A day of future slack is deliberate — a user east of UTC really is
// on tomorrow's date relative to the server, and that's a real weigh-in, not junk.
//
// THERE ARE THREE DOORS, not two. The wave that added this guard wired it into
// `/api/checkin` and `/api/bodyweight` and wrote "both weigh-in doors" — because it
// had grepped the ROUTE names. The third, `/api/nutrition/profile` (the Fuel stats
// form), reaches the same sink from a route whose name says nothing about weight, and
// shipped unguarded for a wave. Grep the SINK (`addBodyweight`), never the route, and
// note that `test-routes.mjs` now walks all three so this list can't silently grow.
export const MAX_BODYWEIGHT_KG = 500;

// The date half, on its own, because TWO kinds of dated row are written from the same
// client-supplied `b.date` and only one of them used to be bounded.
//
// `/api/checkin` writes a CHECK-IN row and (optionally) a WEIGH-IN row, three lines
// apart, both from `b.date`. The weigh-in went through sanitizeBodyweight; the check-in
// carried a format-only regex and no ceiling — lesson 27 ("look at the validated field's
// SIBLINGS") one level up again, at row scope rather than field scope, in the very
// handler the guard below was added to. The inline comment saying `day` "is already
// validated above" is what made it look covered: true of the FORMAT, silent about the
// range, and lesson 33's confident-comment tell.
//
// It matters because every consumer window is open-ended at the top —
// `inBlockWindow` is `date >= blockWindowStart` with no ceiling — so a future-dated
// check-in never ages out of the 42-day block window that `recoverySignal` averages.
// Four such rows below the midpoint pin `underRecovered: true` permanently, which
// gates `deriveVolumeAdjust` from ever adding volume again. And check-ins are stored
// ONE PER DATE, so the correction path is "check in again on that date" — unreachable
// for a date no calendar will offer.
//
// The realistic vector is not an attacker: the client sends `date: localDay()` from
// the DEVICE clock, so a phone with a wrong year posts it in the ordinary flow.
export function boundLocalDate(date, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const tomorrow = new Date(nowMs + 86400000).toISOString().slice(0, 10);
  // A day of future slack is deliberate — a user east of UTC really is on tomorrow's
  // date relative to the server, and that's a real entry, not junk.
  return validLocalDate(date) && date <= tomorrow ? date : today;
}

export function sanitizeBodyweight(date, kg, nowMs = Date.now()) {
  return { date: boundLocalDate(date, nowMs), kg: Math.min(MAX_BODYWEIGHT_KG, Number(kg)) };
}

// The SAME door for injuries. `/api/profile/injury` checked the region against the
// KB's own keys and whitelisted the severity — while `/api/onboard` and
// `/api/plan/regenerate` (which spreads `body.profile` wholesale, `injuries` among
// its TRAINING_FIELDS) took whatever a client sent (lesson 1: the guard landed on
// the one call site the bug was found at). An unknown region is not inert: it sits
// in the profile forever matching no contraindication rule, so it filters nothing
// while the user believes they're being trained around it — and it poisons the
// escalation ladder above, whose `rank[stored.severity]` reads `undefined` for a
// junk severity, so a later honest report can never raise it.
// The device's UTC offset, in minutes EAST of UTC — the user's CLOCK.
//
// This used to be captured in exactly one place: `POST /api/push/subscribe`. Which
// meant the timezone-correctness work of Wave 173 (the mesocycle clock counting the
// user's own calendar days and weeks) was INERT for every user who never enabled
// notifications, while its unit and route tests all passed because their fixtures
// supplied the field. Correct code over data almost nobody had.
//
// Now every authed request carries it as a header, so the frame is a property of the
// request rather than of one opt-in feature. Validated to the real ±14h range: an
// out-of-range or non-numeric value returns null and the caller falls back to what's
// stored, so a hostile header can't clobber a good value (auth is possession-of-UUID).
export function parseTzOffset(v) {
  // `Number("")` and `Number(null)` are both 0 — a perfectly valid offset (UTC). So an
  // ABSENT or blank header would parse as "this user is in London" and overwrite a real
  // stored clock, which a route test caught. Require digits before trusting the value.
  if (typeof v !== "string" && typeof v !== "number") return null;
  const raw = String(v).trim();
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && Math.abs(n) <= 840 ? n : null;
}

export const INJURY_SEVERITIES = ["mild", "moderate", "severe"];
export function sanitizeInjuries(injuries) {
  if (!Array.isArray(injuries)) return [];
  const seen = new Set();
  const out = [];
  for (const inj of injuries) {
    const region = String(inj?.region ?? "");
    if (!VALID_INJURY_REGIONS.has(region) || seen.has(region)) continue;
    seen.add(region);
    out.push({ ...inj, region, severity: INJURY_SEVERITIES.includes(inj?.severity) ? inj.severity : "moderate" });
  }
  return out;
}

// The ONE normalizer every write path for a logged set goes through — the log
// route and the edit route both call it, so a bound tightened in one can never be
// missing from the other (lesson 1: prefer a single source of truth to a fix
// applied at one call site). Whitelisting is deliberate: an unknown field is
// dropped, and `deload` MUST survive — progression anchoring and stall detection
// both filter on it, and the whitelist silently dropping it once made the entire
// deload-aware pipeline inert in production while unit tests (which bypass this
// route) stayed green.
const normalizeSet = (s) => ({
  exercise: s.exercise,
  set_type: s.set_type ?? "work",
  weight_kg: boundedNum(s.weight_kg, MAX_SET_WEIGHT_KG),
  reps: Math.round(boundedNum(s.reps, MAX_SET_REPS)),
  // Effort fields: finite-or-dropped, never NaN (Number("x") used to survive the
  // rir clamp as NaN → JSON null), and rpe clamped beside rir — lesson 27's exact
  // pattern was recurring three lines from where it was learned.
  ...(s.rpe != null && Number.isFinite(Number(s.rpe)) ? { rpe: Math.max(0, Math.min(10, Number(s.rpe))) } : {}),
  ...(s.rir != null && Number.isFinite(Number(s.rir)) ? { rir: Math.max(0, Math.min(10, Math.round(Number(s.rir)))) } : {}),
  ...(s.deload ? { deload: true } : {}),
  completed_at: s.completed_at ?? new Date().toISOString(),
});

// A challenge (#10 social) still occupies its owner's one-at-a-time slot only
// if it's non-terminal AND its target week hasn't passed yet — a stale
// pending/active record whose week already ended is NOT open, even before
// either side has read GET /api/challenge to self-transition it. Without this,
// a propose could be wrongly refused as "opponent-busy" against a challenge
// that's actually over but simply hasn't been read since.
// tzOffsetMin localizes "now" to the SIDE being checked (a challenger and
// opponent can be in different timezones; each side's own staleness is judged
// in their own local week, matching settleChallenge's per-user week_over).
// `!weekHasPassed`, not `===`: an equality test also called the challenge closed when
// the freshly-computed key read EARLIER than the stamp (a tz change between stamp and
// read — first capture, DST, travel), which here frees the slot early and lets a new
// propose overwrite a live challenge. Chronological comparison makes that skew inert.
const isChallengeOpen = (challenge, tzOffsetMin) =>
  !!challenge && (challenge.status === "pending" || challenge.status === "active")
  && !weekHasPassed(challenge.week, Date.now(), tzOffsetMin);

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

  // Owner-only aggregate stats (BLOCKERS #7 — the zero-new-collection proposal,
  // authorized by the owner 2026-08-13: "attack all the blockers, do what you
  // think is best"). Computed entirely from rows the store already holds:
  // aggregates only, no per-user view, no PII, nothing added to the client.
  // Gated on a deploy-time secret (STATS_KEY): unless it's configured AND the
  // caller presents it exactly, the route answers the same 404 an unknown path
  // would — never an auth hint. The one new stored byte in this feature is the
  // push-delivery stamp (push_deliveries), which exists to answer BLOCKERS
  // #2b's "does a live push service actually accept our sends" with recorded
  // 2xx evidence instead of a human vigil.
  app.get("/api/stats", async (c) => {
    if (!config.statsKey || c.req.header("X-HB-Stats-Key") !== config.statsKey) return c.json({ error: "not found" }, 404);
    return c.json(await store.stats(Date.now()));
  });

  // Onboarding: profile -> a plan GENERATED from the KB (volume landmarks +
  // exercise DB + equipment/injuries), with a rationale we can explain.
  app.post("/api/onboard", async (c) => {
    const { profile: posted } = await c.req.json().catch(() => ({})); // empty/non-JSON -> clean 400, not a 500
    // The FIRST of the two wholesale client->profile doors. Whatever arrives here
    // becomes the stored profile verbatim, so the server-owned set is stripped
    // before any other line reads it — an account cannot be BORN holding forged
    // social/push state any more than it can acquire it later (the sibling door
    // below). One shared set, walked by an enumerable test (merge-archive.mjs).
    const profile = stripServerOwnedProfile(posted);
    if (!profile?.training_status || !profile?.primary_goal) return c.json({ error: "missing profile fields" }, 400);
    // A client-supplied date is hostile until parsed (possession-of-UUID auth means
    // any client can post): junk silently drops to null rather than corrupting the
    // taper engine with an un-parseable goalEventDate.
    if (profile.goal_event_date != null && !validLocalDate(profile.goal_event_date)) profile.goal_event_date = null;
    if (profile.injuries != null) profile.injuries = sanitizeInjuries(profile.injuries);
    if (profile.tz_offset_min != null) profile.tz_offset_min = parseTzOffset(profile.tz_offset_min);
    // Per-IP throttle: this is the only unauthenticated route that both burns
    // plan-engine CPU and writes a fresh users row per call, so an unthrottled
    // loop could exhaust the D1 write quota. Mirrors the auth route's cap using
    // the same magic_links rate-limit buckets (marker rows: used=1, a purpose
    // consume never accepts — they can only ever be counted). Real devices
    // onboard once; 10/hr absorbs a shared gym IP, and the cap itself bounds
    // the marker rows the throttle writes.
    const onboardIp = c.req.header("CF-Connecting-IP") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
    if (onboardIp) {
      const now = Date.now();
      if ((await store.countRecentLinks("onboard:" + onboardIp, now - 60 * 60 * 1000)) >= 10) return c.json({ error: "rate-limited" }, 429);
      // ip stays NULL: countRecentByIp (the AUTH per-IP cap) counts every row
      // matching the ip column with no purpose filter, so storing the IP here
      // made onboard markers eat half the magic-link budget of a shared gym
      // NAT. The onboard count reads the rl_key bucket, which carries the IP.
      await store.createMagicLink({ token_hash: crypto.randomUUID(), email: "", rl_key: "onboard:" + onboardIp, ip: null, user_id: "onboard-marker", purpose: "onboard-marker", expires_at: now, used: 1, created_at: now });
    }
    const user_id = crypto.randomUUID();
    profile.user_id = user_id;
    // Health-note acceptance (BLOCKERS #5): the welcome screen carries "By
    // starting you agree this is training guidance, not medical advice" before
    // this request can exist, so the acceptance is stamped HERE, server-side —
    // never trusted from the client (overwrite whatever was posted), and never
    // asked as a checkbox (Goal 3: zero cognitive load).
    profile.disclaimer_ack = { v: 1, at: new Date().toISOString() };
    // Owner smoke traffic identifies itself. Every prod smoke across ~40 waves has
    // POSTed this route — the only thing that creates a user row — so the app's own
    // activation number counts an unknown amount of us in its denominator, and
    // nothing separated the two before conclusions were drawn from the ratio.
    // Gated on the STATS_KEY rather than a plain header on purpose: a flag any
    // client could set would let anyone quietly remove themselves from the metric,
    // which is the same defect pointed the other way. `smoke` is in the
    // server-owned strip set, so the ONLY way to acquire it is this line.
    if (config.statsKey && c.req.header("X-HB-Stats-Key") === config.statsKey) profile.smoke = true;
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
    // `cardio` must survive this whitelist — a dropped field silently disables its
    // whole surface (the deload-flag lesson, and the reason test-routes.mjs exists).
    // `personalization` answers "what did my answers actually change?" — computed
    // here rather than stored, so an old plan_rationale can never describe a newer
    // program. Null when the plan is user-customised (its rationale is cleared then,
    // and inventing an explanation for a plan the engine didn't build is the lie this
    // card exists to prevent).
    const personalization = user.plan_rationale
      ? explainUserPlan(user.profile, user.plan_rationale, user.program) : null;
    return c.json({ program: { name: user.program.name, split: user.program.split, days_per_week: user.program.days_per_week, sessions: user.program.sessions, cardio: user.program.cardio ?? null }, rationale: user.plan_rationale ?? null, profile: user.profile ?? null, personalization });
  });

  // Regenerate the plan from the stored profile (after a profile edit).
  app.post("/api/plan/regenerate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = body.user_id;
    if (!id || !(await store.getUser(id))) return c.json({ error: "unknown user" }, 404);
    // A profile edit is a generic spread boundary, so make a private editable copy
    // BEFORE validating or merging it. This used to strip `disclaimer_ack` alone,
    // under a comment citing "guard the siblings" — the sixteen server-owned
    // fields beside it stayed writable, so a patch could forge `following`
    // (skipping the live-share check, the self-follow check, the 20-token cap and
    // the followers_count bump that is the share owner's ONLY notification) or an
    // unbounded `challenges` array (skipping MAX_OPEN_CHALLENGES and billing a
    // listSessions per forged slot to every sweep tick). Now both wholesale doors
    // pass through one shared set, and a test walks it rather than a comment
    // claiming coverage (lesson 33).
    const profilePatch = stripServerOwnedProfile(body.profile ?? null);
    // Same trust-boundary guard as /api/onboard: junk collapses to null.
    if (profilePatch?.goal_event_date != null && !validLocalDate(profilePatch.goal_event_date)) profilePatch.goal_event_date = null;
    if (profilePatch?.injuries != null) profilePatch.injuries = sanitizeInjuries(profilePatch.injuries);
    // The THIRD field in this literal that a client can set and the engines then treat
    // as ground truth. `parseTzOffset` was built as the one canonical validator when
    // the clock moved to a request header, and it reached the header and
    // /api/push/subscribe — but a profile PUT spreads `body.profile` wholesale, so this
    // door stayed open (lesson 27: guard the siblings, not just the field that exposed
    // the class). It matters more here than at the header, because the hourly push
    // sweep and settleChallenge read the STORED value with no request to re-derive
    // from: a finite-but-absurd offset has no self-heal path.
    if (profilePatch?.tz_offset_min != null) profilePatch.tz_offset_min = parseTzOffset(profilePatch.tz_offset_min);
    // CAS so a concurrent write (double-tap, second tab) can't be clobbered —
    // this route now backs the Settings screen, so it will see real traffic.
    const priorSessions = await store.listSessions(id);
    const nowISO = new Date().toISOString();
    // Compare arrays order-insensitively — a settings save that RE-ORDERS
    // priority_muscles/equipment/injuries (prefill order ≠ original tap order) is
    // not a real change and must not restart the mesocycle.
    const canon = (v) => Array.isArray(v) ? JSON.stringify([...v].map((x) => JSON.stringify(x)).sort()) : JSON.stringify(v);
    const TRAINING_FIELDS = ["training_status", "primary_goal", "days_per_week", "session_length_min", "available_equipment", "priority_muscles", "injuries", "specialization", "periodization"];
    let out = null;
    const updated = await store.updateUser(id, (u) => {
      const before = u.profile;
      const next = profilePatch ? { ...u.profile, ...profilePatch, user_id: id } : u.profile;
      const trainingChanged = TRAINING_FIELDS.some((k) => canon(before?.[k]) !== canon(next[k]));
      // Cosmetic edit (units, sex): keep the CURRENT block's accessory rotation and
      // mesocycle position. Training change: fresh block 0 (week-1 ramp, rebased rotation).
      const blockIndex = trainingChanged ? 0 : (u.plan_meta?.block_index ?? 0);
      u.profile = next;
      // Preserve the adaptive per-muscle tune across a settings edit — a change in
      // days/equipment doesn't invalidate "this person's chest responds to more
      // volume". (Specialization muscles ignore it; their target is overridden.)
      const volumeAdjust = u.plan_meta?.volume_adjust ?? {};
      const { program, rationale, meta } = generateUserPlan(u.profile, { blockIndex, volumeAdjust });
      u.program = program; u.plan_rationale = rationale;
      u.plan_meta = {
        ...meta,
        block_start: trainingChanged || !u.plan_meta?.block_start ? nowISO : u.plan_meta.block_start,
        block_index: blockIndex, // carry it through — dropping it made the next /api/today re-rotate
        volume_adjust: volumeAdjust,
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
    return c.json(critiqueUserPlan(b.program || user.program, user.custom_exercises || [], user.profile?.training_status));
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
      // The generated plan_rationale (per-muscle volumes, grades, warnings shown on
      // "Why this plan?") described the OLD plan. Once the user edits the exercises,
      // it's stale — showing it beside the new session list is silent misinformation.
      // Clear it on a real edit; the explain screen falls back to the live critique.
      if (changed) u.plan_rationale = null;
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ ok: true, critique: critiqueUserPlan(program, updated.custom_exercises || [], updated.profile?.training_status) });
  });

  // Lean exercise list for the plan builder's swap pickers (includes the user's
  // own custom exercises when the X-HB-User header identifies them).
  app.get("/api/exercises", async (c) => {
    const id = c.req.header("X-HB-User");
    const user = id ? await store.getUser(id) : null;
    // Filter to what THIS user can actually perform (their equipment, minus injury
    // contraindications) so the editor's swap/add pickers never offer a lift the
    // generator itself excluded for safety or unavailable kit. Anonymous callers
    // (no user) get the full library. Custom exercises are always the user's to use.
    const all = user
      ? userExercises(user.profile, user.custom_exercises || [])
      : [...exerciseById.values()];
    // unilateral / lengthened_bias / movement_pattern travel with the row so a
    // mid-workout swap can carry the "one side at a time", "stretch-focused", and
    // inline-demo cues onto the new lift instead of silently dropping them.
    return c.json(all.map((e) => ({ id: e.id, name: e.name, primary_muscles: e.primary_muscles ?? [], equipment: e.equipment, mechanic: e.mechanic, unilateral: !!e.unilateral, lengthened_bias: !!e.lengthened_bias, movement_pattern: e.movement_pattern ?? null, custom: !!e.custom })));
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

  // `body` is optional: a POST route that has ALREADY parsed its body passes it in
  // rather than making this re-read the stream. (Hono does cache a parsed body, but
  // depending on that is a silent coupling — an explicit hand-off can't rot.)
  const requireUser = async (c, body = null) => {
    // The user_id IS the full account credential (possession model), so it must
    // NEVER travel in a URL — a `?u=` query string leaks it into access logs,
    // browser history, and any copied/shared link. Accept it only from the
    // X-HB-User header (GETs) or the POST body, both of which stay out of URLs.
    const id = c.req.header("X-HB-User") || (body ?? await c.req.json().catch(() => ({}))).user_id;
    if (!id) return { error: c.json({ error: "no user" }, 400) };
    const user = await store.getUser(id);
    if (!user) return { error: c.json({ error: "unknown user" }, 404) };
    // The user's CLOCK, returned here so no route has to remember to ask for it.
    // Prefers the live header (the device recomputes it every request, so DST and
    // travel self-heal) and falls back to whatever was last stored. Null when neither
    // exists, which every caller already treats as "use UTC".
    const tz = parseTzOffset(c.req.header("X-HB-TZ")) ?? user.profile?.tz_offset_min ?? null;
    return { id, user, tz };
  };

  // Today: the one-decision card + the fully pre-filled session.
  app.get("/api/today", async (c) => {
    let { id, user, tz, error } = await requireUser(c);
    if (error) return error;
    // Persist the device's clock, ONLY when it differs from what's stored. This is the
    // boot request, so it lands on first open and then only when DST shifts or the
    // user moves — never a write per read. The hourly push sweep has no request
    // context, so storage is the only way it can learn the frame at all.
    if (tz != null && tz !== user.profile?.tz_offset_min) {
      const moved = await store.updateUser(id, (u) => {
        if (u.profile?.tz_offset_min === tz) return u;  // re-checked INSIDE the CAS
        u.profile = { ...(u.profile ?? {}), tz_offset_min: tz };
        return u;
      }).catch((e) => { if (/conflict/i.test(e?.message ?? "")) return null; throw e; });
      if (moved) user = moved;   // read-your-own-write, so this response uses the new frame
    }
    const [sessions, checkins, bodyweights] = await Promise.all([store.listSessions(id), store.listCheckins(id), store.listBodyweights(id)]);
    const nowISO = new Date().toISOString();
    // The user's LOCAL calendar day (client passes ?d=YYYY-MM-DD; a date is not a
    // credential so it's fine in the query, unlike user_id). Drives the daily-flow
    // done-state so "logged today" matches the day the user is actually living.
    const clientDay = (() => { const d = c.req.query("d"); return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : nowISO.slice(0, 10); })();
    // GRADUATION (considerations #2, finding 2F). training_status was set once at
    // onboarding and changed by NOTHING afterwards, so a user who joined as a
    // beginner and has trained hard ever since stayed on beginner volume with no
    // mesocycle, no deload, no accessory rotation and no volume tune — forever.
    // Checked BEFORE the block-boundary rotation below, because a promotion starts
    // a fresh block; the rotation then sees block_index 0 and correctly no-ops.
    const earnedStatus = graduatedStatus(sessions, user.profile?.training_status);
    if (earnedStatus && !user.program?.custom) {
      const promoted = await store.updateUser(id, (u) => {
        // Re-check inside the CAS on the FRESH read: a concurrent Settings save may
        // already have changed the status (or made the plan custom), and this must
        // not clobber it. Re-derive from the fresh copy rather than trusting the
        // outer read (lesson 21: act on what's actually stored).
        const fresh = graduatedStatus(sessions, u.profile?.training_status);
        if (!fresh || u.program?.custom) return u;
        u.profile = { ...u.profile, training_status: fresh };
        // A promotion RAISES the volume target (mev.min -> mav.min, or -> mav.max).
        // Start a fresh block so the mesocycle's own week-1 ramp (0.7x) walks them
        // into it, instead of the new target landing whole overnight.
        const { program, rationale, meta } = generateUserPlan(u.profile, { blockIndex: 0, volumeAdjust: u.plan_meta?.volume_adjust ?? {} });
        u.program = program; u.plan_rationale = rationale;
        u.plan_meta = {
          ...meta,
          block_start: nowISO,
          block_index: 0,
          rotation_base: sessions.filter((x) => !x.program_ref || x.program_ref === program.id).length,
          rotated_at: nowISO,
          volume_adjust: u.plan_meta?.volume_adjust ?? {},
          // Announced ONCE (buildToday clears it the moment a session is logged
          // under the new block) — a step up you earned is a win to celebrate
          // (Goal 4), not a settings change to discover.
          graduated_to: fresh,
        };
        return u;
      }).catch((e) => { if (e?.message === "write-conflict") return null; throw e; });
      if (promoted) user = promoted;
    }
    // NEW MESOCYCLE -> rotate the accessories. Compounds keep their ranking so
    // double-progression baselines survive; isolations get a fresh deterministic
    // shuffle (blockIndex feeds the tie-break jitter). Custom-edited plans are
    // sacred and never auto-regenerated; beginners don't run blocks.
    // The adaptive tune's recovery/energy gate must read only the JUST-COMPLETED block,
    // not the user's whole history. recoverySignal and bodyweightTrend average whatever
    // they're handed, so feeding the full log turned "block-average readiness" into a
    // LIFETIME average: an athlete wrecked THIS block but with months of good prior
    // check-ins never tripped the gate, and a long-past cut kept reading as a current
    // deficit for months (suppressing volume the recent block had earned). Window to the
    // block length (6 weeks); a sparse window falls back to permissive — the safe
    // direction, since the gate only ever RESTRAINS adding, never forces it.
    const blockWindowStart = new Date(Date.now() - 42 * 86400000).toISOString().slice(0, 10);
    const inBlockWindow = (d) => (d || "").slice(0, 10) >= blockWindowStart;
    const recentCheckins = checkins.filter((ck) => inBlockWindow(ck.date));
    const recentBodyweights = bodyweights.filter((b) => inBlockWindow(b.date));
    const blockStart = user.plan_meta?.block_start;
    if (blockStart && user.profile?.training_status !== "beginner" && !user.program?.custom) {
      // TRAINED weeks, not calendar weeks (Wave 167) — the same clock blockPhase
      // reads, so the boundary that rotates the plan and the phase shown on the card
      // can never disagree about which block the user is in.
      const blockIndex = Math.floor(trainedWeeksInBlock(sessions, blockStart, nowISO, tz) / BLOCK_WEEKS);
      if (blockIndex !== (user.plan_meta.block_index ?? 0)) {
        const updated = await store.updateUser(id, (u) => {
          // Re-check the FRESH CAS-read state: the outer guard (L203) saw a stale
          // copy. If, in the race window, a concurrent /api/plan/save made the plan
          // custom, or another request already rotated to this block, leave it
          // untouched — otherwise the rotation silently clobbers a just-saved custom
          // plan. (Every other mutator here re-checks its precondition inside the CAS.)
          if (u.program?.custom || blockIndex === (u.plan_meta?.block_index ?? 0)) return u;
          // ADAPTIVE (#2): fold the just-completed block's response into the running
          // per-muscle volume adjustment, so the new block's targets are tuned to how
          // THIS person actually responded — stalled muscles get more, ceiling-bound
          // ones get eased, all bounded to MEV↔MRV. Accumulates across blocks.
          // DURING a SPECIALIZATION block, non-priority muscles are DELIBERATELY
          // maintenance-dosed (low), so their lifts "stall" by design — folding that
          // in would spuriously bump their target, which then lands once specialization
          // ends. So freeze the tune during a spec block (carry the prior forward).
          const prevAdjust = u.plan_meta?.volume_adjust ?? {};
          // Recovery-/energy-aware context (Increment A): the tune won't ADD volume to
          // a stalled muscle while the athlete is persistently under-recovered or in an
          // energy deficit — that stall needs recovery/fuel, not more sets.
          // The index of the block whose data we're reading — the one that JUST
          // COMPLETED — not the one being entered. The question is "were those stalls
          // held-at-maintenance by design when they were logged?", so it must be
          // answered against the block that produced them. Using the new index would
          // un-freeze the tune exactly at the boundary where a specialization block
          // ends, folding in a whole block of by-design stalls in one go.
          const completedBlockIndex = u.plan_meta?.block_index ?? 0;
          const volumeAdjust = isSpecializing(u.profile, completedBlockIndex)
            ? prevAdjust
            : computeVolumeAdjust(prevAdjust, sessions, u.custom_exercises || [], { checkins: recentCheckins, bodyweights: recentBodyweights, goal: u.profile?.primary_goal });
          // What CHANGED this block — so the new-block coach note announces the actual
          // adjustment, not the whole accumulated total re-announced every block.
          const tunedThisBlock = {
            bumped: Object.keys(volumeAdjust).filter((m) => (volumeAdjust[m] ?? 0) > (prevAdjust[m] ?? 0)),
            eased: Object.keys(volumeAdjust).filter((m) => (volumeAdjust[m] ?? 0) < (prevAdjust[m] ?? 0)),
          };
          // THE EXERCISE-CHANGE LEVER (the KB's 4th plateau lever, previously absent):
          // lifts this person has genuinely plateaued on are demoted below every
          // alternative for their muscle, so the new block offers a different angle
          // rather than the same stalled movement. Recency-filtered, or a swapped-out
          // lift would stay flagged forever and never come back (see stalledExerciseIds).
          const stalledExercises = stalledExerciseIds(sessions, u.custom_exercises || [], nowISO);
          const { program, rationale, meta } = generateUserPlan(u.profile, { blockIndex, volumeAdjust, stalledExercises });
          u.program = program; u.plan_rationale = rationale;
          u.plan_meta = {
            ...meta,
            block_start: u.plan_meta.block_start, // the cycle continues; only content rotates
            swapped_this_block: stalledExercises, // what got changed, for the coach note
            block_index: blockIndex,
            rotation_base: sessions.filter((s) => !s.program_ref || s.program_ref === program.id).length,
            rotated_at: nowISO, // buildToday shows "new block" once (until a session is logged under it)
            volume_adjust: volumeAdjust, // the running adaptive tune, carried forward
            tuned_this_block: tunedThisBlock, // what changed THIS block, for the coach note
          };
          return u;
        }).catch((e) => { if (e?.message === "write-conflict") return null; throw e; }); // a lost race retries next request; a real bug must surface, not be swallowed
        if (updated) user = updated;
      }
    }
    // REACTIVE DELOAD (considerations #2, finding 2B — the KB's third plateau lever,
    // "manage fatigue", which had no code path at all). Fires when a muscle is
    // stalled AT its recoverable ceiling — `volumeResponse`'s "change" signal, which
    // the engine has been computing on every progress read and discarding (nothing
    // rendered it, nothing acted on it). Adding sets there is the one response that
    // can't help, which is exactly why the KB reaches for a deload instead.
    //
    // Read from progressReport rather than re-deriving: one definition of the signal,
    // not two that can drift (the maintenance/hold filtering matters here too — a
    // muscle a specialization block deliberately holds low must never trigger this).
    const rdBlockStart = user.plan_meta?.block_start;
    const rdTrainedWeeks = trainedWeeksInBlock(sessions, rdBlockStart ?? user.created_at, nowISO, tz);
    const rdBlock = blockPhase(rdTrainedWeeks, user.profile?.training_status);
    if (rdBlock && rdBlockStart && !user.program?.custom) {
      const rdBlockIndex = Math.floor(rdTrainedWeeks / BLOCK_WEEKS);
      const rdReport = progressReport(user, sessions, bodyweights, user.custom_exercises || [], nowISO, checkins, tz);
      if (reactiveDeloadDue(rdReport.adaptive, rdBlock, user.plan_meta, rdBlockIndex)) {
        const stamped = await store.updateUser(id, (u) => {
          // Precondition re-checked inside the CAS against the FRESH read — a
          // concurrent request may have stamped this block already, and stamping
          // twice would move the week forward and deload two weeks running.
          if ((u.plan_meta?.reactive_deload?.block ?? null) === rdBlockIndex) return u;
          u.plan_meta = { ...(u.plan_meta ?? {}), reactive_deload: { block: rdBlockIndex, week: isoWeekKey(nowISO) } };
          return u;
        }).catch((e) => { if (e?.message === "write-conflict") return null; throw e; });
        if (stamped) user = stamped; // act on what was PERSISTED, not the local guess (lesson 21)
      }
    }
    const readiness = dailyReadiness(checkins.find((ck) => (ck.date || "").slice(0, 10) === clientDay));
    // Daily-flow status (considerations #6): the three things a user does across a
    // day — morning check-in (incl. weight), the workout, and evening calories — so
    // the Today hub can show, at a glance, what's done and what's next.
    const nutrition = await store.listNutritionLog(id); // bodyweights already fetched above (block-boundary recovery context)
    const onDay = (d) => (d || "").slice(0, 10) === clientDay;
    const daily = {
      day: clientDay,
      checked_in: checkins.some((ck) => onDay(ck.date)),
      weight_logged: bodyweights.some((b) => onDay(b.date)),
      workout_logged: sessions.some((s) => onDay(s.local_date ?? s.date)),
      calories_logged: nutrition.some((e) => onDay(e.date)),
    };
    // Latest logged bodyweight (kg) — feeds buildToday's body-scaled starting-weight
    // guess for a lift with no history. `bodyweights` is ASC-sorted (byDate), so the
    // last entry is the most recent; no log yet -> null, and buildToday falls back
    // to the safe empty-bar default the client already applies.
    const latestBodyweightKg = bodyweights.length ? bodyweights[bodyweights.length - 1].kg : null;
    return c.json({ card: todayCard(user, sessions), session: buildToday(user, sessions, readiness, user.custom_exercises || [], nowISO, latestBodyweightKg), daily });
  });

  // Optional daily check-in (sleep/energy/stress/mood, 1-5). One per day; returns
  // an immediate readiness read that gently shapes today's session.
  app.post("/api/checkin", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = b.user_id && (await store.getUser(b.user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    // ONE bound, applied before either row is written — the check-in row and the
    // weigh-in row below it come from this same field, and the format-only regex that
    // used to live here left the check-in permanently inside every block window.
    const day = boundLocalDate(b.date);
    const checkin = { user_id: b.user_id, date: day, source: "manual" };
    for (const k of ["sleep_quality", "energy", "stress", "mood", "motivation"]) if (b[k] != null) checkin[k] = Math.max(1, Math.min(5, Math.round(Number(b[k]))));
    if (!(await store.addCheckin(b.user_id, checkin))) return c.json({ error: "unknown user" }, 404);
    // The morning check-in is also where weight is logged (considerations #6 — one
    // morning flow, not a separate trip to Progress). Weight is optional.
    let weight_logged = false;
    if (Number.isFinite(Number(b.weight_kg)) && Number(b.weight_kg) > 0) {
      // `day` is already bounded above by the same helper sanitizeBodyweight uses, so
      // the two rows this handler writes can no longer disagree about what a valid
      // date is; sanitizeBodyweight still bounds the kg.
      if (!(await store.addBodyweight(b.user_id, sanitizeBodyweight(day, b.weight_kg)))) return c.json({ error: "unknown user" }, 404);
      weight_logged = true;
    }
    return c.json({ ok: true, readiness: dailyReadiness(checkin), weight_logged });
  });

  // Adherence & gamification: streak, XP/level, milestones, motivational state.
  app.get("/api/adherence", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    const sessions = await store.listSessions(id);
    // Only surface a commitment for THE CURRENT iso week — a stale one from a
    // prior week reads back as unset so the client re-prompts naturally,
    // without needing its own copy of the iso-week algorithm. Localized by the
    // user's own tz (isoWeekKeyLocal) so this agrees with the commitment's own
    // localized storage below AND with push.mjs's localized consumption check
    // — a raw UTC week here would silently disagree with both near the
    // UTC week boundary for anyone west of UTC.
    const curWeek = isoWeekKeyLocal(Date.now(), user.profile?.tz_offset_min);
    const commitment = user.profile?.commitment?.week === curWeek ? user.profile.commitment : null;
    // Surface the cheer tally on the main Coach view (not just buried in the share
    // box) so the social validation actually lands where the user looks. Only an
    // extra read for users who've opted into sharing; null/0 otherwise.
    const shareId = await store.getShareIdForUser(id);
    const shareCheers = shareId ? await store.getShareCheers(shareId) : 0;
    // A mutual partner's nudge (POST /api/following/nudge) surfaces exactly ONCE, the
    // same seen-once pattern as new_cheers: pending iff its timestamp is newer than the
    // watermark, then the watermark advances so a repeat /api/adherence read (every
    // Coach load) doesn't re-show a stale toast.
    const pendingNudge = user.profile?.partner_nudge;
    const nudged = !!pendingNudge && pendingNudge.at > (user.profile?.nudge_seen_at ?? 0);
    if (nudged) await store.updateUser(id, (u) => { u.profile = { ...(u.profile ?? {}), nudge_seen_at: pendingNudge.at }; return u; });
    return c.json({ ...adherenceReport(user, sessions), reminders_off: user.profile?.reminders_off === true, commitment, share_cheers: shareCheers, nudged });
  });

  // Weekly training commitment (#4 adherence, roadmap item #2): the user states
  // which days THIS week they intend to train — an implementation-intention /
  // commitment-consistency lever, distinct from the fixed days_per_week cadence.
  // Lives on the profile so it survives merges. `week` pins it to the ISO week
  // it was made for (isoWeekKey, the same one push.mjs checks against) so a
  // stale prior week's commitment can't silently linger or drive a reminder
  // days after the user meant it.
  app.post("/api/commitment", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    // Guard a missing user_id BEFORE the store call: store.updateUser(undefined) returns
    // null on the file store (→ 404) but THROWS on D1 (an undefined bind param → 500 in
    // prod). Validate at the door so both stores answer a malformed request identically.
    if (!b.user_id) return c.json({ error: "unknown user" }, 404);
    const days = Array.isArray(b.days) ? [...new Set(b.days.filter((d) => WEEK_DAY_KEYS.includes(d)))] : [];
    const updated = await store.updateUser(b.user_id, (u) => {
      // Localized by the user's OWN stored tz (isoWeekKeyLocal) — a raw UTC stamp
      // can already read as next week while it's still today for anyone west of
      // UTC, silently disagreeing with push.mjs's own localized consumption check.
      u.profile = { ...(u.profile ?? {}), commitment: { week: isoWeekKeyLocal(Date.now(), u.profile?.tz_offset_min), days } };
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ commitment: updated.profile.commitment });
  });

  // --- Web Push device reminders (#4): subscribe/unsubscribe + the public key.
  // The endpoint URL is the subscription's identity (unguessable); subscribing
  // requires possession of the user_id, unsubscribing knowledge of the endpoint.
  app.get("/api/push/key", (c) => c.json({ key: config.vapidPublicKey ?? null }));
  app.post("/api/push/subscribe", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = b.user_id && (await store.getUser(b.user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    if (!b.subscription?.endpoint || !isAllowedPushEndpoint(b.subscription.endpoint)) return c.json({ error: "bad-subscription" }, 400);
    if (!(await store.savePushSubscription(b.user_id, b.subscription))) return c.json({ error: "unknown user" }, 404);
    // Capture the device's UTC offset so the hourly push sweep can nudge at a sensible
    // LOCAL hour instead of 16:00 UTC for everyone. Stored on the profile (a JSON blob,
    // so no schema change); validated to the real ±14h timezone range.
    // Same validator as the X-HB-TZ header path (one definition, not two).
    const subTz = parseTzOffset(b.tz_offset_min);
    if (subTz != null) {
      await store.updateUser(b.user_id, (u) => { u.profile = { ...(u.profile ?? {}), tz_offset_min: subTz }; return u; });
    }
    return c.json({ subscribed: true });
  });
  app.post("/api/push/unsubscribe", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.endpoint) return c.json({ error: "missing endpoint" }, 400);
    // Scope the delete to the caller's own user_id: the endpoint is possession-
    // based, but if one leaks (a log, a shared device) an attacker must ALSO
    // hold the matching, still-active user_id to kill a victim's reminders. The
    // unscoped store deletion is reserved for the internal 410-pruning sweep;
    // exposing it here would turn a leaked endpoint into a public unsubscribe
    // capability and let a merged-away identity act on the survivor's device.
    if (!b.user_id || !(await store.getUser(b.user_id))) return c.json({ error: "unknown user" }, 404);
    await store.deletePushSubscription(b.endpoint, b.user_id);
    return c.json({ subscribed: false });
  });

  // Reminders opt-out (#4 nudges): a hard switch the comeback-email sweep
  // respects unconditionally. Lives on the profile so it survives merges.
  app.post("/api/reminders", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.user_id) return c.json({ error: "unknown user" }, 404); // parity: undefined bind THROWS on D1 → guard at the door
    const updated = await store.updateUser(b.user_id, (u) => {
      u.profile = { ...(u.profile ?? {}), reminders_off: b.off === true };
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ reminders_off: updated.profile.reminders_off === true });
  });

  // Safety rail: pause suspends all streak pressure with zero penalty (illness/injury).
  app.post("/api/pause", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.user_id) return c.json({ error: "unknown user" }, 404); // parity: undefined bind THROWS on D1 → guard at the door
    const paused = b.on ? { from: new Date().toISOString().slice(0, 10), reason: b.reason ?? null } : null;
    const updated = await store.updateUser(b.user_id, (u) => { // CAS: won't clobber a concurrent write (#20)
      // Resuming ARCHIVES the window instead of erasing it: the streak walker
      // must treat those weeks as neutral forever, or "your streak is safe"
      // collapses to ~1 the moment the user comes back (rail #1 broken exactly
      // when it mattered). Capped so the blob can't grow unboundedly.
      if (!b.on && u.paused) u.pause_history = [...(u.pause_history ?? []), { from: u.paused.from ?? null, to: new Date().toISOString().slice(0, 10) }].slice(-24);
      u.paused = paused; return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ paused: !!updated.paused });
  });

  // Spend a held streak-freeze token to neutralise a missed week (#4 adherence —
  // the user-held protection the roadmap called out). The token check and the
  // already-frozen guard live INSIDE the mutator so the CAS store can't double-spend
  // under a concurrent write; sessions (which decide what's freezable) are read once
  // outside — they don't race a freeze in practice.
  app.post("/api/streak/freeze", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.user_id) return c.json({ error: "unknown user" }, 404); // parity: undefined bind THROWS on D1 → guard at the door
    const now = new Date().toISOString();
    const sessions = await store.listSessions(b.user_id);
    let frozenWeek = null, reason = null;
    const updated = await store.updateUser(b.user_id, (u) => {
      const freezes = u.streak_freezes || [];
      const state = streakFreezeState(sessions, now, freezes, u.paused || null, u.pause_history || []);
      // Client may name a week to protect; else default to the most recent missed one.
      const week = b.week ? (state.freezable.includes(b.week) ? b.week : null) : state.protectable_week;
      if (state.balance <= 0) { reason = "no-tokens"; return u; }
      if (!week) { reason = b.week ? "week-not-freezable" : "nothing-to-protect"; return u; }
      if (freezes.includes(week)) { reason = "already-frozen"; return u; }
      u.streak_freezes = [...freezes, week].slice(-24); // cap blob growth (parity with pause_history)
      frozenWeek = week;
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    if (!frozenWeek) return c.json({ error: reason || "cannot-freeze" }, 400);
    return c.json({ frozen_week: frozenWeek, ...adherenceReport(updated, sessions, now) });
  });

  // --- Shareable progress card (opt-in social, #10) --------------------------
  // Opt in: mint (or return the existing) unguessable share token for this user.
  // The token is a capability, NOT the user_id — it only ever exposes the non-PII
  // aggregate card below, and the user can revoke it. Stable across taps so a link
  // already shared keeps working; /revoke drops it, and the next opt-in makes a fresh one.
  app.post("/api/share", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.user_id || !(await store.getUser(b.user_id))) return c.json({ error: "unknown user" }, 404);
    let shareId = await store.getShareIdForUser(b.user_id);
    if (!shareId) {
      shareId = await store.createShare(b.user_id, crypto.randomUUID(), Date.now());
      if (!shareId) return c.json({ error: "unknown user" }, 404);
    }
    const cheers = await store.getShareCheers(shareId);
    // Surface how many cheers arrived SINCE the user last looked — the motivating
    // signal (a total that never visibly grows is easy to ignore) — then mark seen.
    let newCheers = 0;
    await store.updateUser(b.user_id, (u) => {
      newCheers = Math.max(0, cheers - (u.profile?.cheers_seen ?? 0));
      u.profile = { ...(u.profile ?? {}), cheers_seen: cheers };
      return u;
    });
    return c.json({ share_id: shareId, cheers, new_cheers: newCheers });
  });
  app.post("/api/share/revoke", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.user_id) return c.json({ error: "unknown user" }, 404);
    await store.deleteShare(b.user_id);
    // Revoking clears share_cheers, so a future re-share counts from 0 — the
    // cheer-push high-water mark (profile.cheers_pushed, a COUNT not a timestamp)
    // must reset with it, or the stale high mark silently suppresses cheer pushes
    // on the new card until its count surpasses the old lifetime total.
    await store.updateUser(b.user_id, (u) => {
      if (!u.profile?.cheers_pushed) return u;
      u.profile = { ...u.profile, cheers_pushed: 0 };
      return u;
    });
    return c.json({ revoked: true });
  });
  // PUBLIC (no auth): resolve a share token to its owner and return ONLY the
  // allowlisted non-PII card. The user_id is never exposed; an unknown/revoked
  // token is an indistinguishable 404. A malformed token can't hit the store as a
  // user_id (it's looked up in the shares index, a separate namespace).
  app.get("/api/share/:shareId", async (c) => {
    const shareId = c.req.param("shareId");
    if (!shareId || shareId.length > 100) return c.json({ error: "not found" }, 404);
    const userId = await store.getShareUserId(shareId);
    if (!userId) return c.json({ error: "not found" }, 404);
    const user = await store.getUser(userId);
    if (!user) return c.json({ error: "not found" }, 404);
    const sessions = await store.listSessions(userId);
    return c.json({ ...publicShareCard(user, sessions), cheers: await store.getShareCheers(shareId) });
  });
  // PUBLIC: a viewer cheers a share card (social proof). No auth — the share token is
  // the capability; validated to resolve to a real user so a bad/revoked token 404s.
  // The tally is bounded in the store; a client-side per-share guard stops casual
  // double-taps (a vanity counter, so scripted inflation is low-harm — noted).
  app.post("/api/share/:shareId/cheer", async (c) => {
    const shareId = c.req.param("shareId");
    if (!shareId || shareId.length > 100) return c.json({ error: "not found" }, 404);
    const userId = await store.getShareUserId(shareId);
    if (!userId) return c.json({ error: "not found" }, 404);
    // Per-IP rate-limit on this public write, reusing the same magic_links bucket the
    // onboard throttle uses (ip column left NULL so cheer markers don't eat the auth
    // per-IP budget of a shared NAT). 30/hr is generous for a real viewer cheering a
    // few cards but caps scripted write-amplification of the vanity counter.
    const ip = c.req.header("CF-Connecting-IP") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
    const now = Date.now();
    if (ip) {
      if ((await store.countRecentLinks("cheer:" + ip, now - 60 * 60 * 1000)) >= 30) return c.json({ error: "rate-limited", cheers: await store.getShareCheers(shareId) }, 429);
      await store.createMagicLink({ token_hash: crypto.randomUUID(), email: "", rl_key: "cheer:" + ip, ip: null, user_id: "cheer-marker", purpose: "cheer-marker", expires_at: now, used: 1, created_at: now });
    }
    return c.json({ cheers: await store.addShareCheer(shareId) });
  });

  // --- Training partners (#10 social, accountability) — follow a friend's share
  // card by its token so their streak shows on your Coach tab. Following stores only
  // the partner's PUBLIC capability token on your profile (no PII, no reciprocal
  // access); the partner is unaware and unaffected. Reuses the share reverse-index.
  app.post("/api/following", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.user_id || !(await store.getUser(b.user_id))) return c.json({ error: "unknown user" }, 404);
    const token = typeof b.token === "string" ? b.token.trim() : "";
    if (!token || token.length > 100) return c.json({ error: "bad-token" }, 400);
    const ownerId = await store.getShareUserId(token);           // must be a real, live share
    if (!ownerId) return c.json({ error: "not-found" }, 404);
    if (ownerId === b.user_id) return c.json({ error: "cannot-follow-self" }, 400);
    // `isNew` decided INSIDE the mutator (CAS re-runs see fresh data): only a token
    // not already on the list is a new-follower EVENT for the owner below.
    let isNew = false;
    const updated = await store.updateUser(b.user_id, (u) => {
      const cur = u.profile?.following ?? [];
      isNew = !cur.includes(token);
      const list = cur.filter((t) => t !== token); // dedup, most-recent first, capped
      u.profile = { ...(u.profile ?? {}), following: [token, ...list].slice(0, 20) };
      return u;
    });
    // New-follower event (Tier-1 #3, Wave 201): sharing is opt-in and the card is
    // public by the owner's own choice, but nothing ever TOLD them someone started
    // watching — the strongest "your streak has an audience" signal the app has, and
    // it reached no device. A monotonic count on the owner's profile (same shape as
    // share cheers) that the push sweep compares against followers_pushed; carries
    // no identity because the follower has none to leak (following is anonymous by
    // design). Best-effort: the follow itself must never fail on the owner's write.
    if (isNew) {
      try {
        await store.updateUser(ownerId, (u) => {
          u.profile = { ...(u.profile ?? {}), followers_count: (u.profile?.followers_count ?? 0) + 1 };
          return u;
        });
      } catch { /* the follow stands; the owner hears about the next one */ }
    }
    return c.json({ following: updated.profile.following.length });
  });
  app.post("/api/following/remove", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.user_id) return c.json({ error: "unknown user" }, 404);
    const updated = await store.updateUser(b.user_id, (u) => {
      u.profile = { ...(u.profile ?? {}), following: (u.profile?.following ?? []).filter((t) => t !== b.token) };
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ following: updated.profile.following.length });
  });
  // Fetch the followed partners' PUBLIC cards (lazy — its own screen, not every Coach
  // load). A revoked/dead token resolves to { active:false } instead of vanishing, so
  // the user can see and prune it. Never exposes any partner's user_id (allowlist card).
  app.get("/api/following", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    // Reciprocal accountability (roadmap #10's next slice): following is one-directional
    // by design, but a partner who follows YOU BACK is a stronger, mutually-aware bond —
    // flagged here (never a new field to store; derived by checking whether the partner's
    // OWN following list contains your current share token) so the client can distinguish
    // it and unlock the nudge below, without either side learning the other's user_id.
    const myToken = await store.getShareIdForUser(id);
    const partners = [];
    for (const token of user.profile?.following ?? []) {
      const ownerId = await store.getShareUserId(token);
      const owner = ownerId && await store.getUser(ownerId);
      if (!owner) { partners.push({ token, active: false }); continue; }
      const sessions = await store.listSessions(ownerId);
      const mutual = !!myToken && (owner.profile?.following ?? []).includes(myToken);
      partners.push({ token, active: true, mutual, ...publicShareCard(owner, sessions), cheers: await store.getShareCheers(token) });
    }
    return c.json({ partners });
  });
  // A one-tap encouragement, but ONLY between confirmed mutual partners (both sides
  // follow each other) — a one-directional follower nudging someone unaware they're
  // being followed would be the creepy failure mode this guards against. Stored as a
  // single pending marker on the RECEIVER's profile (no history, no identity of the
  // sender beyond "a training partner") and surfaced once via /api/adherence, the same
  // seen-once pattern share cheers already use.
  app.post("/api/following/nudge", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const sender = b.user_id && (await store.getUser(b.user_id));
    if (!sender) return c.json({ error: "unknown user" }, 404);
    const token = typeof b.token === "string" ? b.token.trim() : "";
    if (!token || token.length > 100 || !(sender.profile?.following ?? []).includes(token)) return c.json({ error: "not-following" }, 400);
    const ownerId = await store.getShareUserId(token);
    if (!ownerId) return c.json({ error: "not-found" }, 404);
    const myToken = await store.getShareIdForUser(b.user_id);
    const owner = await store.getUser(ownerId);
    if (!myToken || !(owner.profile?.following ?? []).includes(myToken)) return c.json({ error: "not-mutual" }, 403);
    await store.updateUser(ownerId, (u) => { u.profile = { ...(u.profile ?? {}), partner_nudge: { at: Date.now() } }; return u; });
    return c.json({ nudged: true });
  });

  // --- 1v1 weekly challenges (#10 social, the accept/decline state machine the
  // roadmap calls out as still missing beyond the passive weekly race). v0 scope,
  // deliberately: at most ONE challenge per user at a time (challenger or
  // opponent), no history — a real product feature, but the smallest coherent
  // slice, same "ship the narrow thing first" precedent as the cheer counter and
  // the mini-leaderboard. Lives entirely as a mirrored `profile.challenge` object
  // on BOTH sides (no new store table): each side only ever writes ITS OWN half
  // plus, on propose/respond, the other party's half via their share token — the
  // same two-sided-write shape `following`'s reciprocal check already reads, just
  // now also written. Resolution needs no snapshot or cron: sessionsInWeek
  // re-derives each side's tally for the challenge's OWN week key on every read,
  // so it's correct whether read mid-week or long after the week ended.
  app.post("/api/challenge", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const sender = b.user_id && (await store.getUser(b.user_id));
    if (!sender) return c.json({ error: "unknown user" }, 404);
    const token = typeof b.token === "string" ? b.token.trim() : "";
    if (!token || token.length > 100) return c.json({ error: "bad-token" }, 400);
    if (!(sender.profile?.following ?? []).includes(token)) return c.json({ error: "not-following" }, 400);
    const ownerId = await store.getShareUserId(token);
    if (!ownerId) return c.json({ error: "not-found" }, 404);
    if (ownerId === b.user_id) return c.json({ error: "cannot-challenge-self" }, 400);
    const myToken = await store.getShareIdForUser(b.user_id);
    const owner = await store.getUser(ownerId);
    if (!myToken || !(owner.profile?.following ?? []).includes(myToken)) return c.json({ error: "not-mutual" }, 403);
    // Multi-challenge (Wave 198): the busy check is now (a) at most ONE open challenge
    // per partner PAIR — you can't stack invites on the same person — and (b) a
    // per-user cap on open slots, both sides. Checked on the pre-write reads here for
    // clean errors, and re-checked INSIDE each mutator (CAS) so a concurrent propose
    // can't overshoot the cap in the race window.
    const senderOpen = challengeSlots(sender.profile).filter((ch) => isChallengeOpen(ch, sender.profile?.tz_offset_min));
    const ownerOpen = challengeSlots(owner.profile).filter((ch) => isChallengeOpen(ch, owner.profile?.tz_offset_min));
    if (senderOpen.some((ch) => ch.partner_token === token)) return c.json({ error: "already-challenging" }, 409);
    if (senderOpen.length >= MAX_OPEN_CHALLENGES) return c.json({ error: "challenge-slots-full" }, 409);
    if (ownerOpen.some((ch) => ch.partner_token === myToken)) return c.json({ error: "already-challenging" }, 409);
    if (ownerOpen.length >= MAX_OPEN_CHALLENGES) return c.json({ error: "opponent-busy" }, 409);
    const id = crypto.randomUUID();
    // The challenger's OWN local week — a raw UTC stamp can already read as the
    // NEXT week while it's still today for anyone west of UTC (see
    // isoWeekKeyLocal), silently shortening this week's challenge by up to a day.
    const week = isoWeekKeyLocal(Date.now(), sender.profile?.tz_offset_min);
    const createdAt = Date.now();
    // The slot is APPENDED, with the pair/cap preconditions re-checked inside the
    // mutator on the fresh CAS read (a concurrent propose in the race window must
    // lose cleanly, not overshoot the cap or double-book the pair). `refused` is
    // reset per retry — only the last run's verdict is real.
    let refused = null;
    const addSlot = (slot, tz, pairToken) => (u) => {
      refused = null;
      const cur = challengeSlots(u.profile);
      const open = cur.filter((ch) => isChallengeOpen(ch, tz));
      if (open.some((ch) => ch.partner_token === pairToken)) { refused = "already-challenging"; return u; }
      if (open.length >= MAX_OPEN_CHALLENGES) { refused = "challenge-slots-full"; return u; }
      u.profile = normalizeChallengeProfile(u.profile, [...cur, slot]);
      return u;
    };
    await store.updateUser(b.user_id, addSlot({ id, role: "challenger", partner_token: token, week, status: "pending", created_at: createdAt }, sender.profile?.tz_offset_min, token));
    if (refused) return c.json({ error: refused }, 409);
    await store.updateUser(ownerId, addSlot({ id, role: "opponent", partner_token: myToken, week, status: "pending", created_at: createdAt }, owner.profile?.tz_offset_min, myToken));
    if (refused) {
      // The opponent's side refused (their own race) — roll back our half so the
      // pair can't end up with a one-sided invite that settles as a phantom decline.
      await store.updateUser(b.user_id, (u) => {
        u.profile = normalizeChallengeProfile(u.profile, challengeSlots(u.profile).filter((ch) => ch.id !== id));
        return u;
      });
      return c.json({ error: refused === "challenge-slots-full" ? "opponent-busy" : refused }, 409);
    }
    return c.json({ challenged: true, week, challenge_id: id });
  });
  // Only the OPPONENT can respond (a challenger accepting their own proposal
  // would skip the consent step the whole feature exists to add).
  app.post("/api/challenge/respond", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const responder = b.user_id && (await store.getUser(b.user_id));
    if (!responder) return c.json({ error: "unknown user" }, 404);
    // Multi-challenge (Wave 198): respond names WHICH invite via `challenge_id` —
    // the parameter the roadmap noted didn't exist. Fallback for one stale cached
    // client generation: with no id, respond to the single pending invite IF exactly
    // one exists; with two or more, refuse rather than guess (answering an invite
    // the user didn't see is the consent failure this route exists to prevent).
    const pendingMine = challengeSlots(responder.profile).filter((ch) => ch.role === "opponent" && ch.status === "pending");
    const mine = typeof b.challenge_id === "string"
      ? pendingMine.find((ch) => ch.id === b.challenge_id)
      : (pendingMine.length === 1 ? pendingMine[0] : null);
    if (!mine && !b.challenge_id && pendingMine.length > 1) return c.json({ error: "challenge-id-required" }, 400);
    // The normal UI always calls GET /api/challenge first, which self-transitions a
    // pending-past-its-week challenge to "declined" before offering accept/decline
    // buttons — but this route is reachable directly (possession-of-UUID auth means
    // any client can call it), so it must enforce the SAME week-freshness rule
    // itself (chronological, weekHasPassed). Without this, a late accept could revive
    // a challenge whose week already ended into "active" — a fabricated "completed"
    // result from training that predates any agreement to compete.
    if (!mine || weekHasPassed(mine.week, Date.now(), responder.profile?.tz_offset_min))
      return c.json({ error: "no-pending-challenge" }, 400);
    const status = b.accept === true ? "active" : "declined";
    // On ACCEPT, stamp accepted_at on the CHALLENGER's copy: the push sweep uses it
    // as the per-slot event marker to tell them the race is on. Declines don't
    // stamp — nothing consumes it (the in-app card shows the decline, and a "they
    // said no" notification helps nobody train).
    const acceptedAt = Date.now();
    const setStatus = (slotId, extra = {}) => (u) => {
      const cur = challengeSlots(u.profile);
      const slot = cur.find((ch) => ch.id === slotId);
      if (!slot || (slot.status !== "pending")) return u; // replaced or already answered — don't resurrect
      u.profile = normalizeChallengeProfile(u.profile, cur.map((ch) => ch.id === slotId ? { ...ch, status, ...extra } : ch));
      return u;
    };
    await store.updateUser(b.user_id, setStatus(mine.id));
    const challengerId = mine.partner_token && (await store.getShareUserId(mine.partner_token));
    if (challengerId) {
      await store.updateUser(challengerId, setStatus(mine.id, status === "active" ? { accepted_at: acceptedAt } : {}));
    }
    return c.json({ status, challenge_id: mine.id });
  });
  // Live (or final, once the target week has passed) state of the caller's own
  // challenge, incl. both sides' tallies for the challenge's OWN week — so this
  // reads correctly whether the week is still running or long over. A challenge
  // self-transitions to a terminal state on read — ONLY this side's copy,
  // mirroring the rest of this feature's one-side-writes-its-own-half design —
  // once its week ends or its opponent's share vanishes: an ACTIVE one
  // "completed" (it ran and has a result), a still-PENDING one "declined" (never
  // answered, so there's no result to show). Either terminal state reopens this
  // user's challenge slot for a new propose (the OPEN check in POST
  // /api/challenge only blocks "pending"/"active").
  app.get("/api/challenge", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    // All transition rules (week-over completion, opponent-vanished, decline of an
    // unanswered invite, the persisted-not-optimistic reporting) live in ONE place:
    // settleChallenge (adherence.mjs), shared with the push sweep so a result can
    // land even for a user who never reopens the app — never two copies (lesson 1).
    const s = await settleChallenge(store, id, user);
    // `challenges` is the real shape now: every slot, each carrying its own
    // opponent_active / my_count / opponent_count / week_over. The legacy singular
    // keys mirror the FIRST slot for one stale-cached-client generation (SW
    // stale-while-revalidate serves the old app.js for at most one load).
    const first = s.challenges[0] ?? null;
    return c.json({
      challenges: s.challenges,
      history: s.history,
      challenge: first,
      ...(first && first.opponent_active ? { my_count: first.my_count, opponent_count: first.opponent_count, week_over: first.week_over } : {}),
    });
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
    // One shared trust boundary for both the instant and the device calendar
    // day. Invalid clocks fall back to server now rather than strand an offline
    // workout; a valid historical local day remains intact for week banking.
    const nowMs = Date.now();
    const timing = normalizeSessionTiming({ date: body.date, local_date: body.local_date }, nowMs);
    const session = {
      session_id: body.session_id ?? crypto.randomUUID(),
      user_id: id,
      date: timing.date,
      // The device's LOCAL calendar day — streak/volume weeks bank to the day
      // the user experienced, not the UTC instant (a Monday-morning session in
      // UTC+12 must not land in last week). Whitelisted explicitly (the deload
      // lesson below: a dropped field silently disables its whole pipeline).
      // Only a real and server-tomorrow-bounded local day is stored. Otherwise
      // engines fall back to the sanitized instant rather than accepting a
      // rollover date or a far-future week key.
      ...(timing.local_date ? { local_date: timing.local_date } : {}),
      program_ref: user.program.id,
      session_name: body.session_name ?? null,
      sets: (body.sets ?? []).map(normalizeSet),
    };
    // The store repeats the tombstone fence in its atomic write. A merge can land
    // after the read above; reporting a recap for a row that was safely refused
    // would be an optimistic lie, so surface the lost identity instead.
    if (!(await store.addSession(id, session))) return c.json({ error: "unknown user" }, 404);
    const all = await store.listSessions(id);
    // Celebration marker (Tier-1 #3, Wave 201): the single most celebration-worthy
    // event this session caused, stamped here — the ONE door every session enters
    // through (lesson 33: this is the sink; addSession has no other caller) — and
    // delivered later by the push sweep as a device-side echo of the in-app moment.
    // Keyed to the session_id so a replayed offline POST (addSession dedups) can
    // never re-arm a marker the sweep already pushed. Best-effort: a failed stamp
    // must never fail the session save the user is waiting on.
    try {
      const prior = all.filter((s) => s.session_id !== session.session_id);
      // The streak half of celebrationEvent compares week ordinals — computed in the
      // SESSION'S own banked calendar day (local_date when the client sent one), the
      // same frame the streak walker banks weeks in, never the server's UTC instant
      // (lesson 22: a Sunday-evening session west of UTC must not read as next week).
      const cel = celebrationEvent(session, prior, user, session.local_date ?? session.date);
      if (cel) {
        await store.updateUser(id, (u) => {
          if (u.profile?.celebration?.session_id === session.session_id) return u; // replay — keep the original (possibly pushed) marker
          u.profile = { ...(u.profile ?? {}), celebration: { session_id: session.session_id, at: Date.now(), ...cel } };
          return u;
        });
      }
    } catch { /* the echo is optional; the logged session is not */ }
    return c.json(sessionRecap(user, all, session, user.custom_exercises || []));
  });

  // ANY rewrite of history while a celebration is pending must RE-EARN it from
  // the corrected data — an edit, a void, or a merge (all three doors call this)
  // — the realistic edit is a fat-fingered weight that was wrongly
  // celebrated as a PR (the exact hazard lesson 27's edit routes exist to correct),
  // and pushing praise for a number the user just took back would teach them the
  // celebrations are fake (lesson 10's sibling). The corrected session is NOT
  // always the celebrated one: a typo'd 10 kg in a PRIOR session fabricates the
  // next session's "PR", and voiding an older session drops the count a milestone
  // marker still claims — so the trigger is "a pending marker exists", never "the
  // edited session is the marker's" (Wave 201 shipped the narrower guard; the
  // Wave-203 audit caught it — lesson 33's shape). Already-pushed markers are left
  // alone: the notification is out, and rewriting history helps nobody. A voided
  // celebrated session vanishes from listSessions, so `sess` is null and the
  // marker clears.
  const recomputeCelebration = async (userId, user) => {
    try {
      const pending = user?.profile?.celebration;
      if (!pending || pending.pushed) return;
      const all = await store.listSessions(userId);
      const sess = all.find((s) => s.session_id === pending.session_id) ?? null;
      const cel = sess ? celebrationEvent(sess, all.filter((s) => s.session_id !== pending.session_id), user, sess.local_date ?? sess.date) : null;
      await store.updateUser(userId, (u) => {
        const cur = u.profile?.celebration;
        if (cur?.session_id !== pending.session_id || cur.pushed) return u; // replaced or already delivered — don't touch
        const { celebration, ...rest } = u.profile;
        u.profile = cel ? { ...rest, celebration: { session_id: cur.session_id, at: cur.at, ...cel } } : rest;
        return u;
      });
    } catch { /* best-effort, same as the stamp itself */ }
  };

  // Report an injury from inside a workout (considerations #2, finding 2E).
  // docs/app-design-spec.md described this reactive path — "only when a user skips
  // or flinches at an exercise... I'll swap it" — and nothing implemented it: the
  // mid-session swap button was generic, explicitly session-only, and never wrote
  // anything down, so the app could watch someone avoid the same lift every week
  // and never learn. This is the write half; the plan regenerates immediately, so
  // the alternatives list (equipment + injury filtered) reflects it on the spot.
  app.post("/api/profile/injury", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { id, error } = await requireUser(c, body);
    if (error) return error;
    const region = String(body.region ?? "");
    // Validated against the KB's own region keys — an unknown region would sit in
    // the profile forever, matching no contraindication and filtering nothing.
    if (!VALID_INJURY_REGIONS.has(region)) return c.json({ error: "unknown region" }, 400);
    const severity = ["mild", "moderate", "severe"].includes(body.severity) ? body.severity : "moderate";
    const updated = await store.updateUser(id, (u) => {
      const injuries = [...(u.profile?.injuries ?? [])];
      const i = injuries.findIndex((x) => x.region === region);
      // Reporting pain on a lift is evidence it's at least this bad — so an existing
      // entry is never DOWNgraded by a repeat report, only raised.
      const rank = { mild: 0, moderate: 1, severe: 2 };
      if (i >= 0) injuries[i] = { ...injuries[i], severity: rank[severity] > rank[injuries[i].severity] ? severity : injuries[i].severity };
      else injuries.push({ region, severity });
      u.profile = { ...u.profile, injuries };
      // Regenerate now rather than at the next block: an aggravating exercise must
      // not sit in the plan for another five weeks. The mesocycle is deliberately
      // NOT reset — an injury shouldn't cost the user their block progress (unlike
      // /api/plan/regenerate, where a training-field change means a different plan).
      const { program, rationale, meta } = generateUserPlan(u.profile, { blockIndex: u.plan_meta?.block_index ?? 0, volumeAdjust: u.plan_meta?.volume_adjust ?? {} });
      if (!u.program?.custom) { u.program = program; u.plan_rationale = rationale; u.plan_meta = { ...u.plan_meta, ...meta, block_start: u.plan_meta?.block_start, block_index: u.plan_meta?.block_index ?? 0, volume_adjust: u.plan_meta?.volume_adjust ?? {} }; }
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    return c.json({ ok: true, injuries: updated.profile?.injuries ?? [] });
  });

  // ---- Correcting the log (Wave 163) -------------------------------------
  // Until now a logged set was permanent: no edit, no delete, no route of any
  // kind. One fat-fingered weight was celebrated as a PR, anchored the next
  // session's suggestion, and sat in the plateau/cadence trends forever — fixable
  // only by wiping the whole account. Wave 162 stopped the worst of them arriving;
  // this is how a user fixes one that did.
  //
  // Voiding is a FLAG, never a DELETE. "Never lose logged data" is a standing
  // guardrail, so the row survives untouched and stays visible on this screen —
  // it's just excluded from every engine that reads history (the stores filter it
  // inside listSessions). That also makes it reversible: void is a toggle.

  // The history screen: recent sessions INCLUDING voided ones, because you can't
  // offer "undo" for something you refuse to show.
  app.get("/api/sessions", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    // History is the correction surface, so it alone receives quarantined raw
    // rows. Never let the usual recent-history cap hide a record the user needs
    // in order to make it safe for coaching again.
    const all = await store.listSessions(id, { includeVoided: true, includeQuarantined: true });
    // Resolve display names here rather than shipping the exercise DB to a screen
    // that only needs labels — and include custom exercises, or a user's own lift
    // would show as a raw slug on the one screen where they have to recognise it.
    const custom = new Map((user.custom_exercises || []).map((e) => [e.id, e.name]));
    const label = (exId) => custom.get(exId) ?? exerciseById.get(exId)?.name ?? exId;
    const quarantined = all.filter((s) => s.timing_issue);
    const ordinary = all.filter((s) => !s.timing_issue).slice(-60);
    // Newest first for ordinary records; quarantined rows stay PINNED above them.
    // They used to be concatenated first and then re-sorted by `date` — the very
    // field whose invalidity caused the quarantine. An unparseable or empty date
    // collapses to "" and sorts LAST, so the rows carrying the only repair
    // affordance landed beneath all sixty ordinary cards, contradicting the
    // comment directly above them; a far-future date sorted first. Sorting only
    // the rows whose sort key is trustworthy is the whole fix.
    // `.reverse()` rather than a comparator: `all` arrives ordered date ASC then
    // insertion order, so reversing keeps same-day siblings newest-first, which a
    // stable sort on `date` alone would silently flip to oldest-first.
    const visible = [...quarantined, ...ordinary.reverse()];
    return c.json({ sessions: visible.map(({ timing_issue, ...sess }) => ({
      ...sess,
      ...(timing_issue ? { time_quarantine: timing_issue } : {}),
      sets: (sess.sets ?? []).map((set) => ({ ...set, name: label(set.exercise) })),
    })) });
  });

  // Fix the numbers on a session already logged. Replaces the whole `sets` array
  // (the client edits a session as a unit) through the SAME normalizer the log
  // route uses, so an edit can't smuggle past a bound the original had to clear.
  app.post("/api/session/update", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { id, user, error } = await requireUser(c, body);
    if (error) return error;
    if (!body.session_id) return c.json({ error: "session_id required" }, 400);
    const correctingDate = Object.hasOwn(body, "corrected_local_date");
    if (!Array.isArray(body.sets) && !correctingDate) return c.json({ error: "sets required" }, 400);
    // A session with no sets left is a session that didn't happen — void it rather
    // than storing an empty husk that still counts as a trained day for the streak.
    const sets = Array.isArray(body.sets) ? body.sets.map(normalizeSet).filter((x) => x.exercise) : null;
    // A new session is intentionally lenient: a temporarily wrong offline clock
    // falls back to server time so the workout is not stranded. A correction is a
    // deliberate, small form with one field, so silently changing an invalid choice
    // to today would be misleading. Reject it and leave the raw record intact.
    const correctionNow = Date.now();
    // The correction is judged by the SAME rule the read path uses to decide
    // whether a row is derivable. That is the whole contract: this door must never
    // accept a date that `sessionTimingIssue` will then re-quarantine, or the user
    // gets "it now counts toward your trends" over a row that still counts for
    // nothing. A previous wave made this door tz-aware and left the read predicate
    // flat, which is exactly that failure. Both call `tomorrowLocalDate`; the
    // client's picker computes the same ceiling.
    if (correctingDate && !normalizeSessionLocalDate(body.corrected_local_date, correctionNow)) {
      return c.json({ error: "bad-date" }, 400);
    }
    const timing = correctingDate
      ? normalizeSessionTiming({ date: body.corrected_local_date, local_date: body.corrected_local_date }, correctionNow)
      : null;
    const updated = await store.updateSession(id, body.session_id, (sess) => {
      if (sets) {
        sess.sets = sets;
        sess.edited_at = new Date().toISOString(); // an edited record says so
        if (!sets.length) sess.voided_at = sess.voided_at ?? new Date().toISOString();
      }
      if (timing) {
        sess.date = timing.date;
        // corrected_local_date is required to pass through the same strict
        // calendar guard; it is never silently replaced with today.
        if (timing.local_date) sess.local_date = timing.local_date;
        else delete sess.local_date;
        sess.timing_corrected_at = new Date().toISOString();
      }
      return sess;
    });
    if (!updated) return c.json({ error: "unknown session" }, 404);
    await recomputeCelebration(id, user);
    // Report what was PERSISTED, not the local guess (lesson 21).
    return c.json({ ok: true, session: updated });
  });

  // Void / un-void. Idempotent both ways: re-voiding keeps the ORIGINAL timestamp
  // rather than sliding it forward, so "when did I take this back" stays true.
  app.post("/api/session/void", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { id, user, error } = await requireUser(c, body);
    if (error) return error;
    if (!body.session_id) return c.json({ error: "session_id required" }, 400);
    const voided = body.voided !== false;
    const updated = await store.updateSession(id, body.session_id, (sess) => {
      if (voided) sess.voided_at = sess.voided_at ?? new Date().toISOString();
      else delete sess.voided_at;
      return sess;
    });
    if (!updated) return c.json({ error: "unknown session" }, 404);
    await recomputeCelebration(id, user);
    return c.json({ ok: true, voided: !!updated.voided_at, session: updated });
  });

  // Progress: everything derived, nothing asked.
  app.get("/api/progress", async (c) => {
    const { id, user, tz, error } = await requireUser(c);
    if (error) return error;
    // Check-ins feed the concurrent-training read's readiness corroborator;
    // progressReport windows them to the same 42-day block as the bodyweight trend.
    const [sessions, bodyweights, checkins] = await Promise.all([store.listSessions(id), store.listBodyweights(id), store.listCheckins(id)]);
    return c.json(progressReport(user, sessions, bodyweights, user.custom_exercises || [], new Date().toISOString(), checkins, tz));
  });

  // Bodyweight quick-add -> energy-balance inference (no calorie counting).
  app.post("/api/bodyweight", async (c) => {
    const { user_id, kg, date } = await c.req.json().catch(() => ({})); // guard empty/non-JSON body
    const user = user_id && (await store.getUser(user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    if (!Number.isFinite(Number(kg)) || Number(kg) <= 0) return c.json({ error: "bad-weight" }, 400);
    if (!(await store.addBodyweight(user_id, sanitizeBodyweight(date, kg)))) return c.json({ error: "unknown user" }, 404);
    const all = await store.listBodyweights(user_id);
    // Same 42-day windowing as progressReport (lesson 1 — fix every call site of
    // bodyweightTrend, not just the one that showed the bug); a sparse window falls
    // back to the full history, same safe-direction fallback as the other call site.
    const bwWindowStart = new Date(Date.now() - 42 * 86400000).toISOString().slice(0, 10);
    const recent = all.filter((b) => (b.date || "") >= bwWindowStart);
    const bw = (recent.length >= 3 ? recent : all).map((b) => ({ date: b.date, bodyweight_kg: b.kg }));
    const trend = bodyweightTrend(bw);
    return c.json({ count: all.length, trend, energy_balance: classifyEnergyBalance(trend, user.profile.primary_goal) });
  });

  // --- Nutrition: calorie/macro targets + adaptive TDEE (considerations #4).
  // Assemble the stats the engine needs from the user doc + logs; compute BF% via
  // the Navy formula when tape measures are given and no BF% is set directly.
  const nutritionInputs = async (user, id) => {
    const n = user.nutrition ?? {};
    const bw = await store.listBodyweights(id);
    const weight_kg = bw.length ? bw[bw.length - 1].kg : n.weight_kg;
    // BF% fallback chain: a directly-entered value → the Navy tape estimate → a rough
    // BMI-based estimate from weight+height alone (so the Fuel plan works without ANY tape
    // measurement; the adaptive TDEE corrects it from logged data within ~2 weeks).
    const bf_pct = n.bf_pct
      ?? navyBodyFat({ sex: user.profile?.sex, height_cm: n.height_cm, neck_cm: n.neck_cm, waist_cm: n.waist_cm, hip_cm: n.hip_cm })
      ?? bmiBodyFat({ sex: user.profile?.sex, height_cm: n.height_cm, weight_kg });
    const profile = { weight_kg, bf_pct, sex: user.profile?.sex, goal: user.profile?.primary_goal, training_status: user.profile?.training_status, activity: n.activity ?? "moderate", unit: "kg" };
    // adaptive TDEE history: pair the daily intake log with the day's bodyweight.
    // adaptiveTDEE averages whatever it's handed (same shape as recoverySignal /
    // bodyweightTrend, Wave 69's "lifetime vs block" bug) — its own promised contract
    // is RECENT data ("log food + weight for ~2 weeks and I'll dial it in", the note
    // nutritionPlan itself shows). Unwindowed, a user who has logged for months gets a
    // maintenance estimate averaged across unrelated diet phases (e.g. a past bulk's
    // high intake blended into a current cut), which is the opposite of "adaptive" and
    // gets slower to correct the longer someone logs. Window to the last ~4 weeks; a
    // sparse window naturally falls back to the formula estimate (adaptiveTDEE returns
    // null below its own thresholds) — the safe direction.
    const ADAPTIVE_WINDOW_DAYS = 28;
    const windowStart = new Date(Date.now() - ADAPTIVE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    const wByDate = new Map(bw.map((b) => [b.date, b.kg]));
    const history = (await store.listNutritionLog(id))
      .filter((e) => (e.date || "") >= windowStart)
      .map((e) => ({ date: e.date, kcal: e.kcal, weight_kg: wByDate.get(e.date) }));
    return { profile, history };
  };

  app.post("/api/nutrition/profile", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = b.user_id && (await store.getUser(b.user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
    // Body fat only within a plausible human range (a fat-fingered 100 makes TDEE
    // uncomputable and used to surface a "~null kcal/day" plan).
    const bf = (v) => (Number.isFinite(Number(v)) && Number(v) >= 2 && Number(v) < 60 ? Number(v) : undefined);
    // The enum is the schema's, not a second literal: `sex` moved out of onboarding
    // and into this form (it drives only the body-fat formula, never the plan), so
    // this became a client-writable profile field and needs the same boundary
    // treatment as its neighbours — an unknown value is DROPPED, never stored, and
    // an absent one leaves the existing value alone.
    const SEX_VALUES = new Set(["male", "female", "intersex", "prefer-not-to-say"]);
    const updated = await store.updateUser(b.user_id, (u) => {
      if (typeof b.sex === "string" && SEX_VALUES.has(b.sex)) u.profile = { ...(u.profile ?? {}), sex: b.sex };
      u.nutrition = {
        ...(u.nutrition ?? {}),
        ...(num(b.height_cm) ? { height_cm: num(b.height_cm) } : {}),
        ...(num(b.neck_cm) ? { neck_cm: num(b.neck_cm) } : {}),
        ...(num(b.waist_cm) ? { waist_cm: num(b.waist_cm) } : {}),
        ...(num(b.hip_cm) ? { hip_cm: num(b.hip_cm) } : {}),
        ...(bf(b.bf_pct) != null ? { bf_pct: bf(b.bf_pct) } : {}),
        // Bounded like the weigh-in below (lesson 27 — the sibling in the same
        // literal): this is a SECOND stored copy of "current weight", and two copies
        // that can disagree is what produced this finding in the first place.
        ...(num(b.weight_kg) ? { weight_kg: Math.min(MAX_BODYWEIGHT_KG, num(b.weight_kg)) } : {}),
        // Only a KNOWN activity level — an arbitrary string reaches baseTDEE's
        // multiplier lookup, and an Object.prototype key there poisons TDEE to NaN.
        ...(typeof b.activity === "string" && Object.hasOwn(ACTIVITY, b.activity) ? { activity: b.activity } : {}),
      };
      return u;
    });
    if (!updated) return c.json({ error: "unknown user" }, 404);
    // A weight typed into the stats form is a fresh weigh-in — record it as one so it
    // becomes the LATEST bodyweight the plan reads. Without this, nutritionInputs takes
    // the most recent logged weigh-in even when it's months stale, and the value the
    // user just entered is silently ignored (the plan contradicts their own input).
    // Routed through the SAME guard as the other two doors rather than re-deriving a
    // date check here — re-deriving it is exactly how this door came to be the one
    // that was missed (see sanitizeBodyweight's header).
    if (num(b.weight_kg) && !(await store.addBodyweight(b.user_id, sanitizeBodyweight(b.date, b.weight_kg)))) return c.json({ error: "unknown user" }, 404);
    const { profile, history } = await nutritionInputs(updated, b.user_id);
    return c.json({ nutrition: nutritionPlan(profile, history), profile });
  });

  app.get("/api/nutrition", async (c) => {
    const { id, user, error } = await requireUser(c);
    if (error) return error;
    const { profile, history } = await nutritionInputs(user, id);
    const plan = nutritionPlan(profile, history);
    // Today's logged intake (client passes ?d= its local day) so the Fuel tab can
    // show progress AGAINST the target — closing the tracker loop.
    const day = (() => { const d = c.req.query("d"); return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10); })();
    const todayLog = (await store.listNutritionLog(id)).find((e) => (e.date || "").slice(0, 10) === day) || null;
    // sex is surfaced so the stats form can ask for the hip measure the Navy formula
    // requires for women (without it a female tape-measure estimate silently fails).
    return c.json({ nutrition: plan, needs_stats: !plan, has_bf: profile.bf_pct != null, has_weight: profile.weight_kg != null, logged_days: history.filter((h) => h.kcal).length, sex: user.profile?.sex ?? null, today: todayLog && { kcal: todayLog.kcal, protein_g: todayLog.protein_g } });
  });

  app.post("/api/nutrition/log", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const user = b.user_id && (await store.getUser(b.user_id));
    if (!user) return c.json({ error: "unknown user" }, 404);
    if (!Number.isFinite(Number(b.kcal)) || Number(b.kcal) <= 0) return c.json({ error: "bad-kcal" }, 400);
    // Macros are non-negative grams and bounded to a sane day — a client can post any
    // value (possession-of-UUID auth), and a negative protein_g would render as a
    // negative intake bar, a huge kcal as an absurd "today so far". Clamp at the door.
    const macro = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(2000, Math.round(n))) : undefined; };
    if (!(await store.addNutritionLog(b.user_id, {
      date: (b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : new Date().toISOString().slice(0, 10)),
      kcal: Math.min(20000, Math.round(Number(b.kcal))),
      ...(macro(b.protein_g) != null ? { protein_g: macro(b.protein_g) } : {}),
      ...(macro(b.carbs_g) != null ? { carbs_g: macro(b.carbs_g) } : {}),
      ...(macro(b.fat_g) != null ? { fat_g: macro(b.fat_g) } : {}),
    }))) return c.json({ error: "unknown user" }, 404);
    const { profile, history } = await nutritionInputs(user, b.user_id);
    return c.json({ logged: true, nutrition: nutritionPlan(profile, history), logged_days: history.filter((h) => h.kcal).length });
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
    // Merge is the only route that retires an active identity. Its final store step
    // archives the complete source graph and hides a provenance tombstone; it never
    // drops user data. Its REAL boundaries are two: (1) the grant below is bound
    // to `to`, so only a caller who just restored `to` can merge into it; (2) the
    // from-user must be anonymous (no email account), so an email-bound account can
    // never be merged away. The X-HB-User === from_user_id check below is a
    // consistency / CSRF guard only — NOT a strong boundary: like every route under
    // the bare-UUID possession model, an attacker who already KNOWS an anonymous
    // victim's UUID can set both the header and the body to it. That is an accepted
    // residual risk of the possession model (such an attacker can already read/write
    // that user); the only EXTRA power merge grants is retiring the anonymous row.
    // Genuinely hardening this (a non-forgeable possession token for `from`) is a
    // security-design decision tracked in BLOCKERS.md.
    if (c.req.header("X-HB-User") !== from_user_id) return c.json({ error: "from-not-authorized" }, 403);
    // Require a valid merge grant tied to to_user_id: only a caller who just
    // restored `to` can merge into it (not anyone holding two UUIDs).
    const link = await store.getMagicLink(await sha256hex(grant));
    if (!link || link.used || link.purpose !== "merge-grant" || link.user_id !== to_user_id || Date.now() > link.expires_at) {
      return c.json({ error: "bad-grant" }, 403);
    }
    // Every refusable check runs BEFORE the grant is spent. It used to run after,
    // so a plain 404 or a from-user-has-account 409 consumed a single-use grant and
    // left the caller unable to retry a merge that had not happened — the grant is
    // the scarce thing here, so nothing that can say "no" should cost one.
    const [from, to] = await Promise.all([store.getUser(from_user_id), store.getUser(to_user_id)]);
    if (!from || !to) return c.json({ error: "unknown user" }, 404);
    if (await store.getAccountByUserId(from_user_id)) return c.json({ error: "from-user-has-account" }, 409);
    // Atomically consume the grant: if a concurrent merge already spent it,
    // markMagicLinkUsed returns false and we refuse — the destructive move runs once.
    if (!(await store.markMagicLinkUsed(link.token_hash))) return c.json({ error: "bad-grant" }, 403);
    const moved = await store.reassignUserData(from_user_id, to_user_id);
    // The store REFUSED (null): between the reads above and the write, a concurrent
    // merge tombstoned one of the two rows. Nothing moved, so say nothing moved —
    // `{merged:true, sessions:0}` is indistinguishable from a legitimately empty
    // source, and the client acts on it by clearing the offline queue it was about
    // to hand over. Report it and let the caller ask for a fresh link.
    if (!moved) return c.json({ error: "merge-unavailable" }, 409);
    // The merge just rewrote the survivor's session history, and merge-profile may
    // have adopted a pending echo computed against the OTHER account's history —
    // re-earn any pending marker from the combined truth before the sweep pushes
    // it (the same recompute the edit/void doors run: lesson 47's dependency set
    // has a third door, and this is it). Best-effort inside, like every
    // celebration write — a failed echo must never fail the merge.
    await recomputeCelebration(to_user_id, await store.getUser(to_user_id));
    return c.json({ merged: true, ...moved });
  });

  // The survivor, and only the survivor, can see that a recoverable source
  // exists. Summaries intentionally omit source UUIDs, snapshots, endpoints,
  // email/token metadata, and every other capability-like value.
  app.get("/api/merge-archives", async (c) => {
    const { id, error } = await requireUser(c);
    if (error) return error;
    return c.json({ archives: await store.listMergeArchives(id) });
  });

  // Restore makes a separate anonymous account. It never rewrites the survivor,
  // never reactivates push/share/social capability records, and is idempotent so
  // a retry after a dropped response cannot create a second copy.
  app.post("/api/merge-archives/:archiveId/restore", async (c) => {
    const { id, error } = await requireUser(c);
    if (error) return error;
    const restored = await store.restoreMergeArchive(id, c.req.param("archiveId"));
    if (!restored) return c.json({ error: "not found" }, 404);
    return c.json({ restored: true, ...restored });
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
      // The rich per-exercise metadata the user asked for (present on all newly
      // authored exercises; older entries may omit some — the client renders only
      // what's here). loading_bias/cns_cost are short labels; the rest are lists.
      execution_steps: e.execution_steps ?? [],
      good_when: e.good_when ?? [], bad_when: e.bad_when ?? [],
      loading_bias: e.loading_bias ?? null, cns_cost: e.cns_cost ?? null,
      difficulty: e.difficulty ?? null,
      // Where in the ROM the lift is hardest and why — the sheet renders it as a
      // one-line coaching note. (This whitelist has silently dropped a field
      // before; test-routes asserts the contract.)
      resistance_profile: e.resistance_profile ?? null,
    });
  });

  return app;
}
