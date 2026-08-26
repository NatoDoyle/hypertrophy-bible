// ROUTE-LEVEL tests: exercise the real HTTP surface (createApp + file store via
// Hono's app.request), not the internals. Exists because a whitelist in
// POST /api/session silently dropped the `deload` flag while every unit test —
// which fed sessions straight into coach.mjs — stayed green. What the client
// sends must be tested through the same door the client uses.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import { createApp } from "../src/app.mjs";
import { requestMagicLink } from "../src/auth.mjs";
import { isoWeekKey, isoWeekKeyLocal, GRADUATION } from "../../tools/derive-core.mjs";
import { adaptiveTDEE } from "../../tools/nutrition-core.mjs";
import { challengeSlots as challengeSlotsT, MAX_OPEN_CHALLENGES as MAX_OPEN_T } from "../src/adherence.mjs";
import { SERVER_OWNED_PROFILE_FIELDS } from "../src/merge-archive.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)); };
const path = join(tmpdir(), `hb-routes-test-${process.pid}.json`);

try {
  const store = createFileStore(path);
  const app = createApp(store, {});
  const json = async (method, url, body) => {
    const res = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  // Onboard an intermediate (mesocycle-eligible) user through the real route.
  const onboard = await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } });
  ok("onboard returns a user_id", onboard.status === 200 && !!onboard.data.user_id);
  const uid = onboard.data.user_id;

  // Log a normal week-1 session, then a deload-stamped session — through the route.
  // Date them RELATIVE to now (a week ago, then yesterday): /api/today reads the
  // REAL current time, so fixed past dates would look like a 40+ day LAYOFF and ease
  // the weight — polluting the deload-anchoring check this test is actually about,
  // and making it flaky (it only fired when the randomly-seeded plan happened to put
  // bench in today's session). Recent dates isolate the deload behaviour deterministically.
  const dAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const s1 = await json("POST", "/api/session", { user_id: uid, session_id: "rt-1", date: dAgo(8),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 }] });
  ok("work session accepted", s1.status === 200);
  const s2 = await json("POST", "/api/session", { user_id: uid, session_id: "rt-2", date: dAgo(1),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 90, reps: 8, deload: true }] });
  ok("deload session accepted", s2.status === 200);

  // The flag must ROUND-TRIP through the sanitizer into the store.
  const stored = await store.listSessions(uid);
  const deloadSet = stored.find((s) => s.session_id === "rt-2")?.sets?.[0];
  ok("deload flag survives the /api/session whitelist", deloadSet?.deload === true);

  // And the coach, reading THROUGH the store, must anchor past the deload:
  // 100x10 hit the top of 6-10 -> progress to 102.5, never "hold at 90".
  const today = await app.request("/api/today", { headers: { "X-HB-User": uid } });
  const t = await today.json();
  const bench = (t.session?.exercises ?? []).find((e) => e.exercise === "barbell-bench-press");
  ok("progression anchors past the deload end-to-end", !bench || bench.suggested_kg == null || bench.suggested_kg > 90);

  // #exercise-demo: movement_pattern must reach /api/today so the client can pick
  // the right inline line-art demo without an extra round-trip per exercise.
  ok("#exercise-demo /api/today's session.exercises carry movement_pattern",
    !bench || bench.movement_pattern === "horizontal-push");

  // roadmap #4's last slice, end-to-end through the real route: a non-beginner
  // with a bodyweight on file gets a body-scaled starting guess for a lift they've
  // never logged (a confirm, not a blind pick from an empty bar).
  const bwUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  await json("POST", "/api/bodyweight", { user_id: bwUser, kg: 80 });
  const bwToday = await (await app.request("/api/today", { headers: { "X-HB-User": bwUser } })).json();
  const bwExercises = bwToday.session?.exercises ?? [];
  ok("#4 a non-beginner with a bodyweight on file gets a body-scaled first-time weight (not a blind null)",
    bwExercises.some((e) => e.suggested_kg != null && /starting estimate/.test(e.suggestion_note ?? "")));

  // Junk must still be stripped (the whitelist's actual job).
  const s3 = await json("POST", "/api/session", { user_id: uid, session_id: "rt-3", date: "2026-06-09T18:00:00Z",
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, evil: "<script>", deload: false }] });
  ok("junk session accepted", s3.status === 200);
  const stored3 = (await store.listSessions(uid)).find((s) => s.session_id === "rt-3")?.sets?.[0];
  ok("junk fields stripped; falsy deload omitted", stored3 && !("evil" in stored3) && !("deload" in stored3));

  // A new mesocycle auto-rotates accessories through the real route. The clock is
  // TRAINED weeks (Wave 167), so backdating block_start is no longer enough on its
  // own — the block only advances for weeks the user actually trained.
  await store.updateUser(uid, (u) => {
    u.plan_meta = { ...u.plan_meta, block_start: new Date(Date.now() - 60 * 86400000).toISOString(), block_index: 0 };
    return u;
  });
  for (let w = 1; w <= 7; w++) {
    await json("POST", "/api/session", { user_id: uid, session_id: `rt-blk-${w}`, date: new Date(Date.now() - w * 7 * 86400000).toISOString(),
      sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 80, reps: 8 }] });
  }
  const before = (await store.getUser(uid)).program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)).join(",");
  const rolled = await app.request("/api/today", { headers: { "X-HB-User": uid } });
  ok("today succeeds across a block boundary", rolled.status === 200);
  const after = await store.getUser(uid);
  ok("new mesocycle bumps block_index and keeps block_start", after.plan_meta.block_index === 1 && !!after.plan_meta.block_start);
  const afterIds = after.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)).join(",");
  ok("accessories rotated at the boundary", afterIds !== before);

  // A cosmetic settings save mid-block must NOT reset the mesocycle or re-rotate.
  await store.updateUser(uid, (u) => { u.plan_meta = { ...u.plan_meta, block_start: new Date(Date.now() - 44 * 86400000).toISOString(), block_index: 1 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": uid } }); // settle at block 1
  const preMeta = (await store.getUser(uid)).plan_meta;
  const preIds = (await store.getUser(uid)).program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)).join(",");
  const cosmetic = await json("POST", "/api/plan/regenerate", { user_id: uid, profile: { units: "imperial" } });
  ok("cosmetic settings save succeeds", cosmetic.status === 200);
  const postMeta = (await store.getUser(uid)).plan_meta;
  ok("cosmetic edit preserves block_start and block_index", postMeta.block_start === preMeta.block_start && postMeta.block_index === preMeta.block_index);
  const postIds = (await store.getUser(uid)).program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)).join(",");
  // rotated_at must be UNCHANGED — not re-stamped (that would re-announce a rotation
  // that didn't happen) and not dropped (Wave 257b: the old `!postMeta.rotated_at`
  // clause pinned the amnesia this route used to inflict on every mid-block stamp).
  ok("cosmetic edit does not re-rotate accessories", postIds === preIds && postMeta.rotated_at === preMeta.rotated_at);

  // A no-op plan-editor save must NOT flip the plan to custom (which freezes rotation).
  const gen = await store.getUser(uid);
  const noop = await json("POST", "/api/plan/save", { user_id: uid, program: { name: gen.program.name, sessions: gen.program.sessions } });
  ok("no-op plan save succeeds", noop.status === 200);
  ok("an unchanged plan save does not flip custom:true", !(await store.getUser(uid)).program.custom);

  // --- Wave 4-B: auth + data-loss guardrails ---

  // #16: the credential must NOT be accepted from a URL query string anymore — a
  // GET with ?u= and no header must NOT authenticate (it used to leak into logs).
  const viaQuery = await app.request(`/api/today?u=${uid}`); // no X-HB-User header
  ok("#16 ?u= query no longer authenticates a GET (credential kept out of URLs)", viaQuery.status === 400);
  const viaHeader = await app.request("/api/today", { headers: { "X-HB-User": uid } });
  ok("#16 the X-HB-User header still authenticates the same GET", viaHeader.status === 200);

  // #17: merge is the only route that deletes a user, so it now demands proof the
  // caller HOLDS from_user_id (X-HB-User), not merely knowledge of it. A victim's
  // UUID alone (no matching header) must be rejected before any destructive move.
  const victim = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const attacker = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const noProof = await app.request("/api/auth/merge", {
    method: "POST", headers: { "content-type": "application/json" }, // NO X-HB-User for `from`
    body: JSON.stringify({ from_user_id: victim, to_user_id: attacker, grant: "anything" }),
  });
  ok("#17 merge without from-side possession (X-HB-User) is refused 403", noProof.status === 403);
  ok("#17 the victim's account is untouched (never reached the destructive move)", !!(await store.getUser(victim)));

  // #6: a block-boundary /api/today must never clobber a plan that became custom.
  // Flip the user custom + backdate the block so rotation WOULD fire, then confirm
  // the CAS mutator leaves the custom plan intact.
  await store.updateUser(uid, (u) => {
    u.program.custom = true;
    u.plan_meta = { ...(u.plan_meta || {}), block_start: "2020-01-01T00:00:00Z", block_index: 0 };
    return u;
  });
  const customName = (await store.getUser(uid)).program.name;
  await app.request("/api/today", { headers: { "X-HB-User": uid } }); // would rotate if unguarded
  const afterRotate = await store.getUser(uid);
  ok("#6 block rotation leaves a custom plan untouched (no silent clobber)",
    afterRotate.program.custom === true && afterRotate.program.name === customName);

  // --- Wave 5-D: plan-editor integrity ---

  // #D1: the editor's exercise list (swap/add pickers) is filtered to what the user
  // can actually perform — no equipment they lack, no injury-contraindicated lift.
  const dbUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["dumbbell", "bodyweight"] } })).data.user_id;
  const dbEx = await (await app.request("/api/exercises", { headers: { "X-HB-User": dbUser } })).json();
  ok("#D1 /api/exercises excludes equipment the user lacks (no barbell/machine/cable for dumbbell-only)",
    dbEx.length > 0 && dbEx.every((e) => e.custom || ["dumbbell", "bodyweight"].includes(e.equipment)));
  const kneeUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
    injuries: [{ region: "knee", severity: "moderate" }] } })).data.user_id;
  const kneeEx = await (await app.request("/api/exercises", { headers: { "X-HB-User": kneeUser } })).json();
  ok("#D1 /api/exercises drops injury-contraindicated lifts (no back squat / leg extension for a knee injury)",
    !kneeEx.some((e) => e.id === "barbell-back-squat" || e.id === "leg-extension"));
  // #12 the swap picker needs unilateral / lengthened_bias on every row so a
  // mid-workout swap carries the "each side" / "stretch-focused" cues onto the new
  // lift. A known unilateral+lengthened lift must report both true.
  const bss = dbEx.find((e) => e.id === "bulgarian-split-squat");
  ok("#12 /api/exercises carries unilateral + lengthened_bias for swap cue preservation",
    dbEx.every((e) => typeof e.unilateral === "boolean" && typeof e.lengthened_bias === "boolean")
    && !!bss && bss.unilateral === true && bss.lengthened_bias === true);
  // #exercise-demo: movement_pattern must also survive a mid-workout SWAP (a
  // different call site than /api/today — lesson 1: fix every call site, not just
  // the one that first exposed the gap), or the swapped-in lift falls back to the
  // generic pulse demo instead of its real animation.
  ok("#exercise-demo /api/exercises carries movement_pattern for the swap picker",
    dbEx.every((e) => e.custom || typeof e.movement_pattern === "string")
    && bss?.movement_pattern === "lunge");

  // #D3: a custom plan edit clears the now-stale generated rationale (the "Why this
  // plan?" science block must not describe a plan the user no longer has).
  const rUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  ok("#D3 a fresh generated plan has a rationale", !!(await store.getUser(rUser)).plan_rationale);
  const genPlan = (await store.getUser(rUser)).program;
  const edited = { name: genPlan.name, sessions: genPlan.sessions.map((s, i) => i === 0 ? { ...s, exercises: s.exercises.slice(0, -1) } : s) };
  await json("POST", "/api/plan/save", { user_id: rUser, program: edited });
  const rAfter = await store.getUser(rUser);
  ok("#D3 saving a custom edit clears the stale plan_rationale (and marks custom)", rAfter.plan_rationale == null && rAfter.program.custom === true);

  // #6-C: the exercise-detail route surfaces the rich metadata (step-by-step,
  // good/bad-pick, loading bias, CNS cost) the library expansion added.
  const kbSwing = await (await app.request("/api/exercise/kettlebell-swing")).json();
  ok("exercise detail includes step-by-step execution + good/bad-pick + bias/cns",
    Array.isArray(kbSwing.execution_steps) && kbSwing.execution_steps.length > 0 &&
    Array.isArray(kbSwing.good_when) && Array.isArray(kbSwing.bad_when) &&
    kbSwing.loading_bias === "mid-range" && kbSwing.cns_cost === "moderate");
  // #13-2 resistance_profile must survive the route whitelist (100% data coverage
  // shipped in Wave 12 was unreachable by the client until this contract existed).
  ok("#13-2 exercise detail carries resistance_profile through the whitelist",
    typeof kbSwing.resistance_profile === "string" && kbSwing.resistance_profile.length > 10);

  // #2 AUTO-TUNE: a lift that stalls across a block bumps that muscle's volume in the
  // NEXT block (bounded to MEV↔MRV), driven by the user's own logged response.
  const atUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  // 7 weekly FLAT bench sessions (identical e1RM → stalled), recent so no layoff.
  // Seven, not five: the mesocycle clock counts TRAINED weeks (Wave 167), so the
  // boundary needs six trained weeks behind it — backdating block_start alone no
  // longer advances a block the user never trained.
  for (let w = 0; w < 7; w++) await json("POST", "/api/session", { user_id: atUser, session_id: `at-${w}`, date: dayAgo(49 - w * 7),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] });
  const chestBefore = (await store.getUser(atUser)).plan_rationale?.volume_by_muscle?.chest?.target_sets;
  // backdate block_start so a mesocycle boundary has passed → /api/today rotates + auto-tunes
  await store.updateUser(atUser, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(56), block_index: 0 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": atUser } });
  const atAfter = await store.getUser(atUser);
  ok("#2 auto-tune records a positive volume_adjust for a stalled muscle", (atAfter.plan_meta?.volume_adjust?.chest ?? 0) > 0);
  ok("#2 the new block's chest target increased from the adaptive bump", atAfter.plan_rationale?.volume_by_muscle?.chest?.target_sets > chestBefore);

  // --- Wave 257b: honest swap claims (C3) + plan_meta truth through Settings (C5) ---
  // C3: STALLED_DEMOTION is a ranking demotion, not an exclusion — a stalled lift
  // whose muscle has a POOL OF ONE is re-picked by the new block. The boundary used
  // to stamp the whole stalled list as swapped_this_block, so the coach note said
  // "I've swapped it for a different angle" about a lift still in the plan
  // (lesson 60: copy is a promise the code has to keep). Machine-only equipment
  // makes machine-chest-press the only chest compound — deterministic re-pick.
  const atIds = atAfter.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise));
  ok("#C3 swapped_this_block ⊆ lifts actually absent from the new program (full-gym pin)",
    (atAfter.plan_meta.swapped_this_block ?? []).every((sid) => !atIds.includes(sid)));
  const poolOne = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["machine"] } })).data.user_id;
  for (let w = 0; w < 7; w++) await json("POST", "/api/session", { user_id: poolOne, session_id: `po-${w}`, date: dayAgo(49 - w * 7),
    sets: [{ exercise: "machine-chest-press", set_type: "work", weight_kg: 60, reps: 8 }] });
  await store.updateUser(poolOne, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(56), block_index: 0 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": poolOne } });
  const po = await store.getUser(poolOne);
  const poIds = po.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise));
  ok("#C3 fixture reaches the branch: boundary crossed and the stalled pool-of-one lift is re-picked",
    (po.plan_meta.block_index ?? 0) >= 1 && poIds.includes("machine-chest-press"));
  ok("#C3 a re-picked lift is never stamped as swapped",
    !(po.plan_meta.swapped_this_block ?? []).includes("machine-chest-press"));

  // C5: /api/plan/regenerate backs the Settings screen, and its plan_meta rebuild
  // kept only four fields — a cosmetic save was amnesia for every mid-block stamp
  // (the lesson-59 record listed the harms when the units door reached this route;
  // the route itself was never fixed) — and it regenerated WITHOUT stalledExercises,
  // so a Settings save un-demoted every plateaued lift.
  const preCos = await store.getUser(atUser);
  await store.updateUser(atUser, (u) => {
    u.plan_meta = { ...u.plan_meta, reactive_deload: { block: u.plan_meta.block_index ?? 0, week: "2026-W30" } };
    return u;
  });
  const cosSave = await json("POST", "/api/plan/regenerate", { user_id: atUser, profile: { units: "imperial" } });
  ok("#C5 cosmetic settings save succeeds", cosSave.status === 200);
  const postCos = await store.getUser(atUser);
  ok("#C5 the reactive-deload stamp survives a cosmetic save (a units flip must not end a deload week)",
    postCos.plan_meta?.reactive_deload?.week === "2026-W30");
  ok("#C5 rotated_at survives a cosmetic save (the new-block note's announce window is not amnesia)",
    !!preCos.plan_meta?.rotated_at && postCos.plan_meta?.rotated_at === preCos.plan_meta.rotated_at);
  // The demotion half needs its own fixture, and the lift is load-bearing (lesson
  // 54 — TWO earlier drafts of this test were vacuous): bench's absence from
  // atUser's post-cosmetic plan is a coincidence of the chest +2 tune reshaping the
  // allocation, so "bench stays out" couldn't fail for the named reason. Probed
  // through the route: a stalled lat-pulldown is demoted out at the boundary AND
  // comes straight back on an un-demoted regenerate under its own lats +2 tune —
  // the only fixture shape here whose red is the demotion itself.
  const msUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  for (let w = 0; w < 7; w++) await json("POST", "/api/session", { user_id: msUser, session_id: `ms-${w}`, date: dayAgo(49 - w * 7),
    sets: [{ exercise: "lat-pulldown", set_type: "work", weight_kg: 70, reps: 8 }] });
  await store.updateUser(msUser, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(56), block_index: 0 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": msUser } });
  const msPre = await store.getUser(msUser);
  ok("#C5 fixture reaches the branch: the boundary demoted the stalled lat-pulldown out of the plan",
    (msPre.plan_meta.block_index ?? 0) >= 1
    && !msPre.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)).includes("lat-pulldown"));
  await json("POST", "/api/plan/regenerate", { user_id: msUser, profile: { units: "imperial" } });
  const msPost = await store.getUser(msUser);
  ok("#C5 a plateaued lift stays demoted through a Settings save",
    !msPost.program.sessions.flatMap((s) => s.exercises.map((e) => e.exercise)).includes("lat-pulldown"));
  // ...and the kept direction: a REAL training change starts a fresh block 0, where
  // clearing the stamps is correct (fresh wave, fresh announcements). Locked here so
  // a later sweep doesn't "fix" the clear (lesson 13).
  const realChange = await json("POST", "/api/plan/regenerate", { user_id: atUser, profile: { days_per_week: 4 } });
  ok("#C5 a real training change still clears the deload stamp with the fresh block",
    realChange.status === 200 && !(await store.getUser(atUser)).plan_meta?.reactive_deload);

  // C15: "once per block" must mean once per block OF TRAINING — a stamped week the
  // user never trained burned the block's one reactive deload forever. Construct the
  // "change" signal for real (chest stalled at its recoverable ceiling: 5 flat weekly
  // sessions of 18 hard bench sets, ≥ chest mav.max), block week 4 (3 trained weeks
  // since block_start), then a pre-seeded stamp for an ancient UNTRAINED week must
  // re-arm — and one for a genuinely trained week must stay spent.
  const rdUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  const bigSession = Array.from({ length: 18 }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }));
  for (let w = 0; w < 5; w++) await json("POST", "/api/session", { user_id: rdUser, session_id: `rd-${w}`, date: dayAgo(35 - w * 7), sets: bigSession });
  await store.updateUser(rdUser, (u) => {
    u.plan_meta = { ...u.plan_meta, block_start: dayAgo(22), block_index: 0, reactive_deload: { block: 0, week: "2020-W01" } };
    return u;
  });
  const rdRes = await (await app.request("/api/today", { headers: { "X-HB-User": rdUser } })).json();
  const rdStamp = (await store.getUser(rdUser)).plan_meta.reactive_deload;
  ok("#C15 an untrained stamped week re-arms: the stamp moves to the current local week",
    rdStamp?.week === isoWeekKeyLocal(Date.now(), null) && rdStamp?.block === 0);
  ok("#C15 ...and today's session is the deload it re-armed", rdRes?.session?.block?.phase === "deload");
  // The spent direction, locked so a later sweep doesn't "fix" it (lesson 13): a
  // stamp whose week WAS trained is a delivered deload and stays consumed.
  const trainedWk = isoWeekKeyLocal(Date.parse(dayAgo(7)), null);
  await store.updateUser(rdUser, (u) => { u.plan_meta = { ...u.plan_meta, reactive_deload: { block: 0, week: trainedWk } }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": rdUser } });
  ok("#C15 a stamp for a TRAINED week stays spent (once per block of training holds)",
    (await store.getUser(rdUser)).plan_meta.reactive_deload.week === trainedWk);

  // ...and the SAME stall must NOT bump volume while a specialization block is running,
  // because a non-priority muscle held at maintenance stalls BY DESIGN. The gate for
  // that read the raw `profile.specialization` field, which Wave 179 stopped writing —
  // so for every account created since (all of them derive it), the freeze never
  // engaged and the block's deliberately-held muscles were spuriously bumped, landing
  // the moment specialization ended. Lesson 1: the field became derived, the consumer
  // didn't follow. `back` is non-priority here, so its stall is the held-by-design kind.
  const specTune = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, priority_muscles: ["chest"],
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  ok("#spec-tune the fixture really is running a DERIVED specialization block (no stored field)",
    (await store.getUser(specTune)).profile.specialization === undefined
    && Object.values((await store.getUser(specTune)).plan_rationale.volume_by_muscle).some((v) => v.maintenance));
  for (let w = 0; w < 7; w++) await json("POST", "/api/session", { user_id: specTune, session_id: `st-${w}`, date: dayAgo(49 - w * 7),
    sets: [{ exercise: "lat-pulldown", set_type: "work", weight_kg: 70, reps: 8 }] });
  await store.updateUser(specTune, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(56), block_index: 0 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": specTune } });
  const stAfter = await store.getUser(specTune);
  ok("#spec-tune a maintenance-held muscle's by-design stall does NOT bump volume during a derived block",
    Object.values(stAfter.plan_meta?.volume_adjust ?? {}).every((v) => (v ?? 0) === 0));
  // ...and the block ENDS (Wave 192). Through the real door: the block-boundary rotation
  // above advanced block_index, so regenerating now must rebalance — every other muscle
  // comes off maintenance while the priority keeps its tilt.
  ok("#spec-end the boundary actually advanced the block index",
    (stAfter.plan_meta?.block_index ?? 0) >= 1);
  const stVol = stAfter.plan_rationale?.volume_by_muscle ?? {};
  ok("#spec-end a finished specialization block takes every other muscle off maintenance (and off the eased dose)",
    Object.values(stVol).every((v) => !v.maintenance && !v.eased));
  // The first version of this assertion was TAUTOLOGICAL — `(chest > lats) === false ?
  // chest > 0 : true` can only fail if chest is both <= lats and <= 0, so it asserted
  // nothing its label claimed (caught by the Waves 190-193 self-audit). The engine's
  // rule for an intermediate non-priority muscle is bottom-of-MAV, which for chest is
  // 12 (data/muscles/chest.json mav.min) — a literal, per lesson 42, so this fails if
  // either the tilt or the landmark silently changes.
  ok("#spec-end ...while the priority muscle keeps more volume than the 12-set non-priority default",
    (stVol.chest?.target_sets ?? 0) > 12);
  const stExplain = await (await app.request("/api/plan/explain", { headers: { "X-HB-User": specTune } })).json();
  const stLine = (stExplain.personalization ?? []).find((l) => l.input === "priority_muscles");
  ok("#spec-end the plan card explains the block ended instead of silently reverting",
    !!stLine && /run its course/.test(stLine.effect));

  // Increment A (recovery-aware tune) through the SAME door the client uses: the
  // identical stall, but logged under persistent under-recovery, must NOT bump volume.
  // Guards the block-boundary wiring (check-ins + hoisted bodyweights threaded into the
  // tune) — a stall you can't recover is a recovery problem, not a volume one.
  const rgUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  // SEVEN trained weeks, not five (Wave 167: the block clock counts TRAINED weeks,
  // so six must sit behind the boundary for it to advance at all). This fixture had
  // stayed at five when the clock changed, so the boundary never fired and the
  // suppression assertion below passed VACUOUSLY (`?? 0` is 0 when the tune never
  // ran) — exposed the moment Wave 258 asserted on tuned_this_block.held.
  for (let w = 0; w < 7; w++) await json("POST", "/api/session", { user_id: rgUser, session_id: `rg-${w}`, date: dayAgo(49 - w * 7),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] });
  // Low daily check-ins inside the 42-day window → under-recovered
  for (let d = 0; d < 5; d++) await json("POST", "/api/checkin", { user_id: rgUser, date: dayAgo(30 - d * 6).slice(0, 10), sleep_quality: 2, energy: 2, stress: 4, mood: 2, motivation: 2 });
  await store.updateUser(rgUser, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(56), block_index: 0 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": rgUser } });
  const rgAfter = await store.getUser(rgUser);
  ok("#A fixture reaches the branch: the boundary actually fired (was vacuous at 5 trained weeks)",
    (rgAfter.plan_meta?.block_index ?? 0) >= 1 && !!rgAfter.plan_meta?.rotated_at);
  ok("#A under-recovery suppresses the volume bump through /api/today (recovery-aware tune wired at the block boundary)", (rgAfter.plan_meta?.volume_adjust?.chest ?? 0) === 0);
  // ...and the suppression is no longer SILENT (Wave 258): the boundary records who
  // was held and why, and the new-block note says it in a sentence.
  ok("#A the gated add is recorded in tuned_this_block.held with its reason",
    (rgAfter.plan_meta?.tuned_this_block?.held ?? []).some((h) => h.muscle === "chest" && h.reason === "recovery"));
  const rgToday = await (await app.request("/api/today", { headers: { "X-HB-User": rgUser } })).json();
  ok("#A the new-block note tells the user their stalled muscle was held for recovery",
    /stalled with room to grow/.test(rgToday?.session?.coach_note ?? ""));

  // Wave 69 (audit A/B): the recovery gate reads only the CURRENT block, not the whole
  // history. The same stall, but the only low check-ins are a long-ago rough patch
  // OUTSIDE the 6-week block window — they must NOT drag a lifetime average down and
  // suppress the bump the recent (check-in-free) block earned. Before the fix, these
  // eight old lows made underRecovered=true and held chest at 0.
  const woUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  // Seven trained weeks (Wave 167: the block clock counts TRAINED weeks, so six
  // must sit behind the boundary for it to advance at all).
  for (let w = 0; w < 7; w++) await json("POST", "/api/session", { user_id: woUser, session_id: `wo-${w}`, date: dayAgo(49 - w * 7),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] });
  for (let d = 0; d < 8; d++) await json("POST", "/api/checkin", { user_id: woUser, date: dayAgo(150 - d * 7).slice(0, 10), sleep_quality: 1, energy: 1, stress: 5, mood: 1, motivation: 1 });
  await store.updateUser(woUser, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(56), block_index: 0 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": woUser } });
  const woAfter = await store.getUser(woUser);
  ok("#69 old out-of-block check-ins don't suppress the bump (recovery gate windows to the current block)", (woAfter.plan_meta?.volume_adjust?.chest ?? 0) > 0);

  // --- Wave 15: onboard throttle + claim-turned-restore merge chain ---

  // #15: /api/onboard is the only unauthenticated route that writes a row per
  // call — per-IP cap of 10/hr (requests without an IP header stay unthrottled,
  // which is why every onboard above still worked).
  const obProfile = { units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: ["bodyweight"] };
  let last = null;
  for (let i = 0; i < 11; i++) {
    last = await app.request("/api/onboard", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ profile: obProfile }) });
    if (i < 10 && last.status !== 200) break;
  }
  ok("#15 the 11th onboard from one IP inside an hour is rate-limited 429", last.status === 429);
  const otherIp = await app.request("/api/onboard", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" }, body: JSON.stringify({ profile: obProfile }) });
  ok("#15 a different IP is not caught by that bucket", otherIp.status === 200);
  // #18: onboard throttle markers must NOT consume the AUTH per-IP magic-link
  // budget — 10 markers were eating half of MAX_LINKS_PER_IP (20) for everyone
  // behind the same gym NAT. #21 made this test DISCRIMINATING: the old version
  // (10 markers vs a 20-link cap, then one auth request) passed even with the
  // bug reinstated — assert the markers carry no IP at all.
  ok("#18 onboard markers store NO ip — they can never count toward the auth per-IP cap",
    (await store.countRecentByIp("203.0.113.9", 0)) === 0);
  await store.saveUser("nat-user", { profile: {} });
  const natLink = await requestMagicLink(store, { email: "natuser@t.com", anonUserId: "nat-user", ip: "203.0.113.9" });
  ok("#18 an auth link from the throttled onboard IP is NOT rate-limited (separate budgets)", !natLink.error && !!natLink.token);

  // #15: a claim that ADOPTS an earlier binding is a restore from the caller's
  // side — the consume route must mint the merge grant so the second device's
  // already-synced workouts can follow instead of being stranded.
  const devP = (await json("POST", "/api/onboard", { profile: obProfile })).data.user_id;
  const devQ = (await json("POST", "/api/onboard", { profile: obProfile })).data.user_id;
  await json("POST", "/api/session", { user_id: devQ, session_id: "q-1", date: dayAgo(1), sets: [{ exercise: "push-up", set_type: "work", reps: 12 }] });
  // devQ (the merged-away device) also has a push subscription + a custom exercise —
  // both must survive the merge onto devP (#26: push subs follow; CAS custom-ex merge).
  await json("POST", "/api/push/subscribe", { user_id: devQ, subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/merge26", keys: { p256dh: "x", auth: "y" } } });
  // Deliberately include an externally-capable share in the source graph too. The
  // survivor keeps it during the merge, but a later safe-copy restore must never
  // resurrect that public capability on the new account.
  const devQShare = (await json("POST", "/api/share", { user_id: devQ })).data.share_id;
  await store.updateUser(devQ, (u) => { u.custom_exercises = [{ id: "custom-x", name: "My Move" }]; return u; });
  const linkP = await requestMagicLink(store, { email: "twodevices@t.com", anonUserId: devP });
  const linkQ = await requestMagicLink(store, { email: "twodevices@t.com", anonUserId: devQ });
  const firstDev = await json("POST", "/api/auth/consume", { token: linkP.token });
  ok("#15 first claim consume: purpose 'claim', no merge grant", firstDev.data.purpose === "claim" && !firstDev.data.merge_grant);
  const secondDev = await json("POST", "/api/auth/consume", { token: linkQ.token });
  ok("#15 adopted claim consume: purpose 'restore' + a merge grant, bound to the first user",
    secondDev.data.purpose === "restore" && !!secondDev.data.merge_grant && secondDev.data.user_id === devP);
  const mergeRes = await app.request("/api/auth/merge", {
    method: "POST", headers: { "content-type": "application/json", "X-HB-User": devQ },
    body: JSON.stringify({ grant: secondDev.data.merge_grant, from_user_id: devQ, to_user_id: devP }),
  });
  const mergeData = await mergeRes.json();
  ok("#15 the grant merges the second device's workouts into the account (nothing stranded)",
    mergeRes.status === 200 && mergeData.merged === true && mergeData.sessions === 1);
  ok("#26 the merged-away device's push subscription now belongs to the surviving user",
    (await store.listPushSubscriptions()).some((s) => s.endpoint === "https://fcm.googleapis.com/fcm/send/merge26" && s.user_id === devP));
  ok("#26 the custom exercise survived the CAS merge onto the surviving user",
    ((await store.getUser(devP)).custom_exercises ?? []).some((x) => x.id === "custom-x"));
  // Wave 211 (BLOCKERS #6b): the merged-away user is a TOMBSTONE — every route
  // answers exactly as if the row were deleted, but nothing was destroyed.
  const tbRes = await app.request("/api/today", { headers: { "X-HB-User": devQ } });
  ok("#6b the merged-away user reads as gone through the real routes (tombstone, not delete)", tbRes.status === 404);

  // --- Wave 215: a merge is recoverable without exposing its source graph ---
  // The archive index is deliberately only visible to the survivor. It is a small
  // safe summary, never the source UUID, snapshot, push endpoint, share token, or
  // account-link material that an owner could accidentally expose in the UI.
  const ownerArchivesRes = await app.request("/api/merge-archives", { headers: { "X-HB-User": devP } });
  const ownerArchives = await ownerArchivesRes.json();
  const devArchive = (ownerArchives.archives ?? []).find((a) => a.counts?.sessions === 1);
  const devArchiveId = devArchive?.archive_id ?? "missing-archive";
  const safeArchiveKeys = new Set(["archive_id", "created_at", "state", "restored_at", "counts"]);
  // `counts` now also records how many push subscriptions and share links the
  // source account HAD — numbers only; the archive deliberately no longer stores
  // the endpoint keys or the share token that would make either usable. So the
  // leak check moved from the whole object to its VALUES: a key literally named
  // "shares" is not a leak, a share token is. Checking the serialized object
  // wholesale conflated the two and would have blocked an honest count forever.
  const countValues = Object.values(devArchive?.counts ?? {});
  ok("#215 the merge survivor sees a safe archive summary, never its source graph",
    ownerArchivesRes.status === 200 && !!devArchive
    && Object.keys(devArchive).every((key) => safeArchiveKeys.has(key))
    && Object.keys(devArchive.counts ?? {}).sort().join(",") === "bodyweights,checkins,nutrition_logs,push_subscriptions,sessions,shares"
    && countValues.length === 6 && countValues.every((v) => typeof v === "number")
    && !/snapshot|source|endpoint|token|magic|user_id/i.test(JSON.stringify({ ...devArchive, counts: countValues })));

  // An unrelated active identity gets an empty index, while the tombstoned source
  // cannot even reach the endpoint. Neither response may disclose an archive id.
  const otherArchivesRes = await app.request("/api/merge-archives", { headers: { "X-HB-User": uid } });
  const otherArchives = await otherArchivesRes.json();
  const tombstoneArchivesRes = await app.request("/api/merge-archives", { headers: { "X-HB-User": devQ } });
  const tombstoneArchives = await tombstoneArchivesRes.json();
  ok("#215 a non-owner and the tombstoned source cannot discover a merge archive",
    otherArchivesRes.status === 200 && Array.isArray(otherArchives.archives) && otherArchives.archives.length === 0
    && tombstoneArchivesRes.status === 404
    && !JSON.stringify(otherArchives).includes(devArchive?.archive_id)
    && !JSON.stringify(tombstoneArchives).includes(devArchive?.archive_id));

  // Ownership is also enforced at the mutation door. The generic 404 is
  // intentional: it does not distinguish an archive belonging to somebody else
  // from an unknown id.
  const otherRestoreRes = await app.request(`/api/merge-archives/${encodeURIComponent(devArchiveId)}/restore`, {
    method: "POST", headers: { "X-HB-User": uid },
  });
  const otherRestore = await otherRestoreRes.json();
  ok("#215 a non-owner cannot restore or learn about the archive",
    otherRestoreRes.status === 404 && !JSON.stringify(otherRestore).includes(devArchiveId));

  // Restore produces a fresh anonymous copy. Retrying it must point at the same
  // copy (not make a second account), and it must leave the survivor byte-for-byte
  // untouched while keeping device/browser and public-share capabilities inactive.
  const survivorBeforeRestore = JSON.stringify(await store.getUser(devP));
  const survivorSessionsBeforeRestore = JSON.stringify(await store.listSessions(devP, { includeVoided: true, includeQuarantined: true }));
  const restoreRes = await app.request(`/api/merge-archives/${encodeURIComponent(devArchiveId)}/restore`, {
    method: "POST", headers: { "X-HB-User": devP },
  });
  const restored = await restoreRes.json();
  const restoredId = restored.user_id;
  const restoreAgainRes = await app.request(`/api/merge-archives/${encodeURIComponent(devArchiveId)}/restore`, {
    method: "POST", headers: { "X-HB-User": devP },
  });
  const restoredAgain = await restoreAgainRes.json();
  ok("#215 restore creates a distinct anonymous copy and retry returns that same identity",
    restoreRes.status === 200 && restored.restored === true && typeof restoredId === "string"
    && restoredId !== devP && restoredId !== devQ
    && restoreAgainRes.status === 200 && restoredAgain.restored === true && restoredAgain.user_id === restoredId);
  ok("#215 restore leaves the survivor exactly unchanged",
    JSON.stringify(await store.getUser(devP)) === survivorBeforeRestore
    && JSON.stringify(await store.listSessions(devP, { includeVoided: true, includeQuarantined: true })) === survivorSessionsBeforeRestore);
  const restoredSessions = await store.listSessions(restoredId, { includeVoided: true, includeQuarantined: true });
  ok("#215 restored history is a separate safe copy with no account, push, or share reactivation",
    restoredSessions.some((s) => s.session_id !== "q-1" && s.lucky_seed === "q-1")
    && !(await store.getAccountByUserId(restoredId))
    && !(await store.listPushSubscriptions()).some((s) => s.user_id === restoredId)
    && (await store.getShareIdForUser(restoredId)) == null
    // This proves the negative share check is meaningful: the source had one and
    // the survivor retained it as part of the normal merge contract.
    && (await store.getShareIdForUser(devP)) === devQShare);

  // --- Wave 209: the health-note acceptance is stamped SERVER-side at onboard —
  // the welcome screen shows "By starting you agree…" before /api/onboard can be
  // reached, and a client-supplied stamp is hostile until overwritten. ---
  const ackUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["bodyweight"],
    disclaimer_ack: { v: 99, at: "1999-01-01T00:00:00.000Z" }, // client lies — must be overwritten
  } })).data.user_id;
  const ackStored = (await store.getUser(ackUser)).profile.disclaimer_ack;
  ok("#209 onboard stamps disclaimer_ack server-side (v1, a real timestamp)",
    ackStored?.v === 1 && typeof ackStored?.at === "string" && ackStored.at !== "1999-01-01T00:00:00.000Z");

  // The generic profile-edit door must preserve evidence that was stamped at
  // onboarding. Settings saves legitimately update preferences, but must never
  // turn a client-supplied object into a replacement acknowledgement.
  const originalAck = JSON.stringify(ackStored);
  const forgedAckRegenerate = await json("POST", "/api/plan/regenerate", { user_id: ackUser, profile: {
    units: "imperial",
    disclaimer_ack: { v: 99, at: "1999-01-01T00:00:00.000Z", forged: true },
  } });
  const ackAfterRegenerate = (await store.getUser(ackUser)).profile;
  ok("#213 a forged acknowledgement through plan regeneration cannot overwrite the server stamp",
    forgedAckRegenerate.status === 200 && JSON.stringify(ackAfterRegenerate.disclaimer_ack) === originalAck
    && ackAfterRegenerate.units === "imperial");

  // Accounts created before the health note genuinely have no acknowledgement.
  // A generic profile patch must not let a client mint one retroactively.
  const legacyAckUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["bodyweight"],
  } })).data.user_id;
  await store.updateUser(legacyAckUser, (u) => { delete u.profile.disclaimer_ack; return u; });
  const mintAckRegenerate = await json("POST", "/api/plan/regenerate", { user_id: legacyAckUser, profile: {
    disclaimer_ack: { v: 1, at: "2099-01-01T00:00:00.000Z" },
  } });
  const legacyAfterRegenerate = (await store.getUser(legacyAckUser)).profile;
  ok("#213 plan regeneration cannot mint an acknowledgement for a legacy account",
    mintAckRegenerate.status === 200 && !Object.hasOwn(legacyAfterRegenerate, "disclaimer_ack"));

  // --- Wave 210: the owner stats endpoint (BLOCKERS #7). Gated on a deploy
  // secret: unconfigured -> 404 even with a key presented; configured -> exact
  // match only, and the refusal is byte-identical to an unknown route. ---
  const noCfg = await app.request("/api/stats", { headers: { "X-HB-Stats-Key": "anything" } });
  ok("#210 /api/stats is a 404 when no STATS_KEY is configured", noCfg.status === 404);
  const statsApp = createApp(store, { statsKey: "test-stats-key" });
  ok("#210 /api/stats without the key is a 404", (await statsApp.request("/api/stats")).status === 404);
  ok("#210 /api/stats with the WRONG key is a 404", (await statsApp.request("/api/stats", { headers: { "X-HB-Stats-Key": "wrong" } })).status === 404);
  const statsRes = await statsApp.request("/api/stats", { headers: { "X-HB-Stats-Key": "test-stats-key" } });
  const statsBody = await statsRes.json();
  ok("#210 the right key returns the aggregate shape",
    statsRes.status === 200 && statsBody.users_total >= 1 && typeof statsBody.sessions_7d === "number"
    && typeof statsBody.push_subscriptions === "number" && typeof statsBody.push_delivered_7d === "number"
    && "retention_wow" in statsBody);
  ok("#210 the aggregates carry no per-user data (no ids, no emails)", !/user_id|email|@|[0-9a-f]{8}-[0-9a-f]{4}/.test(JSON.stringify(statsBody)));
  // The burst-shape aggregate reads `magic_links.rl_key`, and that key EMBEDS the
  // onboarding IP ("onboard:203.0.113.7"). Only counts may leave this endpoint, so
  // the payload is checked for address shapes directly rather than trusting that
  // the implementation kept aggregating. An enumerable check, not a comment.
  {
    const ipUser = await json("POST", "/api/onboard", { profile: obProfile });
    void ipUser;
    await store.createMagicLink({ token_hash: `ip-probe-${Date.now()}`, email: "", rl_key: "onboard:203.0.113.7", ip: null,
      user_id: "onboard-marker", purpose: "onboard-marker", expires_at: Date.now(), used: 1, created_at: Date.now() });
    const withIp = await (await statsApp.request("/api/stats", { headers: { "X-HB-Stats-Key": "test-stats-key" } })).json();
    const text = JSON.stringify(withIp);
    ok("#210 no IPv4 or IPv6 address reaches the stats payload",
      !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text) && !/(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{1,4}/i.test(text) && !/onboard:/.test(text));
    ok("#210 ...while the marker is still COUNTED, so the check isn't passing on an empty read",
      withIp.onboard_markers_total >= 1 && withIp.onboard_ips_distinct >= 1);
  }

  // #21: local_date must round-trip through the /api/session whitelist (the
  // deload-flag lesson: a silently dropped field disables its whole pipeline).
  const ldUser = (await json("POST", "/api/onboard", { profile: obProfile })).data.user_id;
  await json("POST", "/api/session", { user_id: ldUser, session_id: "ld-1", date: dayAgo(0), local_date: "2026-07-23", sets: [{ exercise: "push-up", set_type: "work", reps: 10 }] });
  const ldStored = (await store.listSessions(ldUser)).find((s) => s.session_id === "ld-1");
  ok("#21 local_date round-trips through the session whitelist", ldStored?.local_date === "2026-07-23");
  // #27: a malformed local_date is dropped at the door (never stored as an
  // "NaN-WNaN"-producing value that would hijack the latest-week logic).
  await json("POST", "/api/session", { user_id: ldUser, session_id: "ld-bad", date: dayAgo(0), local_date: "2026-13-45", sets: [{ exercise: "push-up", set_type: "work", reps: 8 }] });
  const ldBad = (await store.listSessions(ldUser)).find((s) => s.session_id === "ld-bad");
  ok("#27 a malformed local_date is rejected at the door (session still saved, field omitted)", ldBad && ldBad.local_date === undefined);

  // Wave 214: an offline device's bad clock must not turn one workout into a
  // permanent future event. The write remains queue-friendly (200) but uses the
  // server instant and discards an invalid/far-future device calendar day.
  const timingUser = (await json("POST", "/api/onboard", { profile: obProfile })).data.user_id;
  const timingWriteStarted = Date.now();
  const malformedTiming = await json("POST", "/api/session", { user_id: timingUser, session_id: "time-malformed",
    date: "not-a-real-instant", local_date: "2026-02-30", sets: [{ exercise: "push-up", set_type: "work", reps: 10 }] });
  const futureTiming = await json("POST", "/api/session", { user_id: timingUser, session_id: "time-future",
    date: "2099-01-01T12:00:00.000Z", local_date: "2099-01-01", sets: [{ exercise: "push-up", set_type: "work", reps: 8 }] });
  const timingWriteFinished = Date.now();
  const storedTiming = await store.listSessions(timingUser);
  const hasServerFallback = (session) => {
    const at = Date.parse(session?.date);
    return Number.isFinite(at) && at >= timingWriteStarted - 1500 && at <= timingWriteFinished + 1500;
  };
  const malformedStored = storedTiming.find((s) => s.session_id === "time-malformed");
  const futureStored = storedTiming.find((s) => s.session_id === "time-future");
  ok("#214 malformed and far-future session instants fall back to server now; unsafe local dates are omitted",
    malformedTiming.status === 200 && futureTiming.status === 200
    && hasServerFallback(malformedStored) && hasServerFallback(futureStored)
    && malformedStored?.local_date === undefined && futureStored?.local_date === undefined);

  // A pre-Wave-214 record can already hold poisoned timing. Seed one directly to
  // model that durable legacy state: ordinary store reads and every derived route
  // must skip it, but History must show it (with a correction marker) rather than
  // silently discard a real workout.
  const timingProgressBefore = await (await app.request("/api/progress", { headers: { "X-HB-User": timingUser } })).json();
  await store.addSession(timingUser, {
    session_id: "time-legacy", user_id: timingUser, program_ref: (await store.getUser(timingUser)).program.id,
    date: "2099-01-01T12:00:00.000Z", local_date: "2099-01-01",
    sets: [{ exercise: "push-up", set_type: "work", reps: 12 }],
  });
  const timingDerived = await store.listSessions(timingUser);
  const timingProgressAfterSeed = await (await app.request("/api/progress", { headers: { "X-HB-User": timingUser } })).json();
  const timingHistoryBeforeFix = await (await app.request("/api/sessions", { headers: { "X-HB-User": timingUser } })).json();
  const legacyInHistory = timingHistoryBeforeFix.sessions?.find((s) => s.session_id === "time-legacy");
  ok("#214 a legacy poisoned-time session is excluded from derived reads but remains in History with a quarantine marker",
    !timingDerived.some((s) => s.session_id === "time-legacy")
    && timingProgressAfterSeed.sessions_logged === timingProgressBefore.sessions_logged
    && legacyInHistory?.time_quarantine === "invalid-date");

  // Unlike an offline write, correction is an intentional form action. Reject an
  // impossible/future chosen day rather than silently moving history to server now.
  const rejectedTimingFix = await json("POST", "/api/session/update", {
    user_id: timingUser, session_id: "time-legacy", corrected_local_date: "2099-01-01",
  });
  const legacyAfterRejectedFix = (await store.listSessions(timingUser, { includeQuarantined: true })).find((s) => s.session_id === "time-legacy");
  ok("#214 an invalid correction is refused without rewriting the quarantined workout",
    rejectedTimingFix.status === 400 && legacyAfterRejectedFix?.date === "2099-01-01T12:00:00.000Z");

  // The correction door intentionally accepts no `sets`: a person correcting a
  // bad device clock should not have to retype their workout. A valid local day
  // restores the exact same durable record to normal derived reads.
  const correctedDay = dAgo(3).slice(0, 10);
  const timingFix = await json("POST", "/api/session/update", {
    user_id: timingUser, session_id: "time-legacy", corrected_local_date: correctedDay,
  });
  const timingDerivedAfterFix = await store.listSessions(timingUser);
  const timingProgressAfterFix = await (await app.request("/api/progress", { headers: { "X-HB-User": timingUser } })).json();
  const timingHistoryAfterFix = await (await app.request("/api/sessions", { headers: { "X-HB-User": timingUser } })).json();
  const repairedHistory = timingHistoryAfterFix.sessions?.find((s) => s.session_id === "time-legacy");
  ok("#214 a corrected_local_date-only update restores the quarantined session without changing its sets",
    timingFix.status === 200 && timingFix.data.session?.local_date === correctedDay
    && timingDerivedAfterFix.some((s) => s.session_id === "time-legacy" && s.sets?.[0]?.reps === 12)
    && timingProgressAfterFix.sessions_logged === timingProgressBefore.sessions_logged + 1
    && repairedHistory && !Object.hasOwn(repairedHistory, "time_quarantine"));

  // #23: push subscribe/unsubscribe round-trip through the real routes
  const pushSub = { endpoint: "https://fcm.googleapis.com/fcm/send/route-test", keys: { p256dh: "pk", auth: "ak" } };
  const subRes = await json("POST", "/api/push/subscribe", { user_id: ldUser, subscription: pushSub });
  ok("#23 push subscribe stores the subscription", subRes.status === 200 && (await store.listPushSubscriptions()).some((s) => s.endpoint === pushSub.endpoint && s.user_id === ldUser));
  const badSub = await json("POST", "/api/push/subscribe", { user_id: ldUser, subscription: { endpoint: "http://insecure" } });
  ok("#23 a non-https endpoint is rejected", badSub.status === 400);
  const missingOwnerUnsub = await json("POST", "/api/push/unsubscribe", { endpoint: pushSub.endpoint });
  ok("#216 an endpoint alone cannot unsubscribe another device", missingOwnerUnsub.status === 404
    && (await store.listPushSubscriptions()).some((s) => s.endpoint === pushSub.endpoint));
  await json("POST", "/api/push/unsubscribe", { endpoint: pushSub.endpoint, user_id: ldUser });
  ok("#23 unsubscribe removes its owner's subscription", !(await store.listPushSubscriptions()).some((s) => s.endpoint === pushSub.endpoint));

  // #21: resuming a pause archives the window (the streak's neutral weeks survive)
  await json("POST", "/api/pause", { user_id: ldUser, on: true });
  await json("POST", "/api/pause", { user_id: ldUser, on: false });
  const ldAfter = await store.getUser(ldUser);
  ok("#21 pause resume archives the window into pause_history", Array.isArray(ldAfter.pause_history) && ldAfter.pause_history.length === 1 && !!ldAfter.pause_history[0].to);
  // Audit fix (Cloud loop wave): a MISSING user_id must 404 at the door, not reach
  // store.updateUser(undefined) — null on the file store (→ 404) but a THROW on D1
  // (→ 500 in prod). /api/commitment and /api/streak/freeze already guard this
  // (Wave 82); /api/pause and /api/reminders were the two sibling routes that didn't.
  const noUserPause = await json("POST", "/api/pause", { on: true });
  ok("#pause with no user_id is a clean 404 (guarded before the store call)", noUserPause.status === 404);
  const noUserReminders = await json("POST", "/api/reminders", { off: true });
  ok("#reminders with no user_id is a clean 404 (guarded before the store call)", noUserReminders.status === 404);
  const remindersRes = await json("POST", "/api/reminders", { user_id: ldUser, off: true });
  ok("#reminders still works normally with a real user_id", remindersRes.status === 200 && remindersRes.data.reminders_off === true);

  // --- Wave 43: nutrition targets + logging ---
  const nUser = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", sex: "male", days_per_week: 4, available_equipment: ["bodyweight"] } })).data.user_id;
  // no stats yet -> no plan
  const nEmpty = await json("GET", "/api/nutrition", null); // GET needs the header
  const nEmptyH = await app.request("/api/nutrition", { headers: { "X-HB-User": nUser } });
  ok("#43 nutrition needs stats before it can compute", (await nEmptyH.json()).needs_stats === true);
  // provide weight + BF% + set profile
  await json("POST", "/api/bodyweight", { user_id: nUser, kg: 85 });
  const setP = await json("POST", "/api/nutrition/profile", { user_id: nUser, bf_pct: 15, height_cm: 178, activity: "moderate" });
  ok("#43 setting stats yields a full target set (TDEE, calories, protein/fat/carbs)",
    setP.data.nutrition && setP.data.nutrition.tdee > 0 && setP.data.nutrition.calorie_target > 0 && setP.data.nutrition.protein_g > 0 && setP.data.nutrition.tdee_basis === "estimated");
  // log ~2 weeks of intake with a slight weight drop -> adaptive basis kicks in.
  // Dated RELATIVE to now (the adaptive-TDEE window only looks back ~4 weeks —
  // see the cloud-loop windowing fix below) rather than a fixed calendar month,
  // for the same reason dAgo is used everywhere else in this file.
  for (let d = 0; d < 12; d++) {
    const day = dAgo(25 - d).slice(0, 10);
    await json("POST", "/api/bodyweight", { user_id: nUser, kg: 85 - d * 0.03, date: day });
    await json("POST", "/api/nutrition/log", { user_id: nUser, date: day, kcal: 2800 });
  }
  const afterLog = await json("POST", "/api/nutrition/log", { user_id: nUser, date: dAgo(13).slice(0, 10), kcal: 2800 });
  ok("#43 the daily intake log accumulates and re-derives maintenance from data",
    afterLog.data.logged === true && afterLog.data.logged_days >= 10 && afterLog.data.nutrition.tdee_basis === "logged");
  const badKcal = await json("POST", "/api/nutrition/log", { user_id: nUser, kcal: -5 });
  ok("#43 a nonsense intake is rejected", badKcal.status === 400);
  // #51: GET /api/nutrition?d= returns today's logged total (intake-vs-target loop)
  const nToday = dAgo(0).slice(0, 10);
  await json("POST", "/api/nutrition/log", { user_id: nUser, date: nToday, kcal: 2650, protein_g: 175 });
  const withToday = await (await app.request(`/api/nutrition?d=${nToday}`, { headers: { "X-HB-User": nUser } })).json();
  ok("#51 GET /api/nutrition returns today's logged intake for the given day", withToday.today && withToday.today.kcal === 2650 && withToday.today.protein_g === 175);
  const noToday = await (await app.request("/api/nutrition?d=2020-01-01", { headers: { "X-HB-User": nUser } })).json();
  ok("#51 a day with nothing logged returns no today total", !noToday.today);

  // --- Wave 68 (audit): nutrition route hardening through the real HTTP door ---
  // E: a hostile/unknown activity string must not poison TDEE to NaN (Wave-49 class).
  const badActUser = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", sex: "male", days_per_week: 4, available_equipment: ["bodyweight"] } })).data.user_id;
  await json("POST", "/api/bodyweight", { user_id: badActUser, kg: 82 });
  const badAct = await json("POST", "/api/nutrition/profile", { user_id: badActUser, bf_pct: 18, height_cm: 180, activity: "toString" });
  ok("#68 an Object.prototype activity key can't produce a NaN plan",
    badAct.data.nutrition && Number.isFinite(badAct.data.nutrition.tdee) && badAct.data.nutrition.calorie_target > 0);
  // G: a weight typed into the stats form becomes the latest weigh-in, so a stale
  // logged weight can't silently override the value the user just entered.
  const wUser = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", sex: "male", days_per_week: 4, available_equipment: ["bodyweight"] } })).data.user_id;
  await json("POST", "/api/bodyweight", { user_id: wUser, kg: 95, date: "2026-01-05" }); // months-old weigh-in
  const freshP = await json("POST", "/api/nutrition/profile", { user_id: wUser, bf_pct: 18, height_cm: 178, weight_kg: 72 });
  ok("#68 a freshly-entered stats weight overrides a stale weigh-in (not ignored)",
    freshP.data.profile.weight_kg === 72 && Math.round(freshP.data.nutrition.protein_g) === Math.round(72 * 1.8));
  // H: negative / absurd macros are clamped at the door, never stored as negative intake.
  await json("POST", "/api/nutrition/log", { user_id: wUser, date: "2026-07-01", kcal: 2200, protein_g: -150 });
  const clamped = await (await app.request("/api/nutrition?d=2026-07-01", { headers: { "X-HB-User": wUser } })).json();
  ok("#68 a negative macro is clamped to 0, never a negative intake", clamped.today && clamped.today.protein_g === 0);

  // --- Wave 70 (audit K): the female Navy tape estimate needs the hip measure ---
  const fUser = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", sex: "female", days_per_week: 4, available_equipment: ["bodyweight"] } })).data.user_id;
  const fProf = await json("POST", "/api/nutrition/profile", { user_id: fUser, weight_kg: 65, height_cm: 165, waist_cm: 74, neck_cm: 32, hip_cm: 98 });
  ok("#70 a female tape-measure estimate (waist+neck+hip) yields a real plan", fProf.data.nutrition && fProf.data.nutrition.calorie_target > 0);
  const fGet = await (await app.request("/api/nutrition", { headers: { "X-HB-User": fUser } })).json();
  ok("#70 GET /api/nutrition surfaces sex so the stats form can ask for hip", fGet.sex === "female");
  const fUser2 = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", sex: "female", days_per_week: 4, available_equipment: ["bodyweight"] } })).data.user_id;
  // Wave 87: a female with weight+height but no hip (so the Navy tape can't run) now STILL
  // gets a plan via the rough BMI-based BF% fallback — the tape wall no longer blocks the
  // nutrition half of the app. (Was: "#70 ... yields no plan"; the hip field is now optional.)
  const fProf2 = await json("POST", "/api/nutrition/profile", { user_id: fUser2, weight_kg: 65, height_cm: 165 });
  ok("#87 a female with just weight+height gets a plan via the BMI fallback (Fuel wall removed)", fProf2.data.nutrition?.calorie_target > 0);

  // --- Cloud loop (audit): adaptiveTDEE must read the RECENT window, not the whole
  // lifetime log — the same "block vs lifetime average" bug class Wave 69 fixed for
  // the recovery gate (recoverySignal/bodyweightTrend), but never applied to the
  // nutrition binder. A stale arc (~3 months ago: a surplus, gaining weight) plus a
  // recent in-window arc (last ~2 weeks: a deficit, losing weight) should yield a
  // TDEE that reflects ONLY the recent arc — not one dragged toward a blend of both.
  const awUser = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", sex: "male", days_per_week: 4, available_equipment: ["bodyweight"] } })).data.user_id;
  await json("POST", "/api/nutrition/profile", { user_id: awUser, bf_pct: 15, height_cm: 178 });
  const staleArc = Array.from({ length: 12 }, (_, d) => ({ date: dAgo(90 - d).slice(0, 10), kcal: 3600, weight_kg: 80 + d * 0.18 }));
  const recentArc = Array.from({ length: 12 }, (_, d) => ({ date: dAgo(25 - d).slice(0, 10), kcal: 2200, weight_kg: 84 - d * 0.14 }));
  for (const e of [...staleArc, ...recentArc]) {
    await json("POST", "/api/bodyweight", { user_id: awUser, kg: e.weight_kg, date: e.date });
    await json("POST", "/api/nutrition/log", { user_id: awUser, date: e.date, kcal: e.kcal });
  }
  const awGet = await (await app.request("/api/nutrition", { headers: { "X-HB-User": awUser } })).json();
  const expectedRecentOnly = adaptiveTDEE(recentArc);
  const expectedIfBlended = adaptiveTDEE([...staleArc, ...recentArc]);
  ok("#cloud-loop the two arcs genuinely diverge (a meaningful test, not a rounding wash)",
    Math.abs(expectedRecentOnly - expectedIfBlended) > 100);
  ok("#cloud-loop GET /api/nutrition's adaptive TDEE matches the RECENT-window estimate",
    awGet.nutrition?.tdee_basis === "logged" && Math.abs(awGet.nutrition.tdee - expectedRecentOnly) <= 2);
  ok("#cloud-loop ...and is NOT dragged toward the lifetime-blended estimate",
    Math.abs(awGet.nutrition.tdee - expectedIfBlended) > 90);

  // --- Wave 46: daily-flow status (#6) + morning check-in captures weight ---
  const dUser = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const DAY = "2026-07-23";
  const todayFor = async () => (await (await app.request(`/api/today?d=${DAY}`, { headers: { "X-HB-User": dUser } })).json()).daily;
  const d0 = await todayFor();
  ok("#46 a fresh day shows nothing done yet", d0.checked_in === false && d0.weight_logged === false && d0.workout_logged === false && d0.calories_logged === false);
  // morning check-in WITH weight in one call
  const ck = await json("POST", "/api/checkin", { user_id: dUser, date: DAY, sleep_quality: 4, energy: 4, stress: 2, motivation: 5, weight_kg: 84 });
  ok("#46 the check-in logs weight in the same step", ck.data.weight_logged === true);
  const d1 = await todayFor();
  ok("#46 daily status reflects the morning check-in (checked-in + weight)", d1.checked_in === true && d1.weight_logged === true);
  // workout logged today
  await json("POST", "/api/session", { user_id: dUser, session_id: "d-1", date: DAY + "T18:00:00Z", local_date: DAY, sets: [{ exercise: "push-up", set_type: "work", reps: 12 }] });
  ok("#46 daily status reflects the workout", (await todayFor()).workout_logged === true);
  // calories logged today
  await json("POST", "/api/nutrition/log", { user_id: dUser, date: DAY, kcal: 2400 });
  const d3 = await todayFor();
  ok("#46 daily status reflects the evening calories — all three done", d3.checked_in && d3.workout_logged && d3.calories_logged);

  // --- Weekly commitment device (#4 adherence, roadmap item #2) ---
  const cUser = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const setCommit = await json("POST", "/api/commitment", { user_id: cUser, days: ["mon", "wed", "fri", "not-a-real-day", "mon"] });
  ok("#commitment stores only valid, deduped day keys", setCommit.status === 200 && JSON.stringify(setCommit.data.commitment.days) === JSON.stringify(["mon", "wed", "fri"]));
  ok("#commitment stamps the CURRENT iso week, not a client-supplied one", /^\d{4}-W\d{2}$/.test(setCommit.data.commitment.week));
  const adh = await (await app.request("/api/adherence", { headers: { "X-HB-User": cUser } })).json();
  ok("#commitment round-trips through /api/adherence", JSON.stringify(adh.commitment) === JSON.stringify(setCommit.data.commitment));
  const unknownCommit = await json("POST", "/api/commitment", { user_id: "no-such-user", days: ["mon"] });
  ok("#commitment for an unknown user is a clean 404, not a crash", unknownCommit.status === 404);
  // Wave 82: a MISSING user_id must 404 at the door, not reach store.updateUser(undefined)
  // (null on the file store → 404, but a THROW on D1 → 500 in prod — a real bug prod-smoke caught).
  const noUserCommit = await json("POST", "/api/commitment", { days: ["mon"] });
  ok("#commitment with no user_id is a clean 404 (guarded before the store call)", noUserCommit.status === 404);
  // A commitment stamped for a PRIOR iso week must read back as unset (never a
  // stale plan silently lingering into a new week).
  await store.updateUser(cUser, (u) => { u.profile.commitment = { week: "2020-W01", days: ["mon"] }; return u; });
  const staleAdh = await (await app.request("/api/adherence", { headers: { "X-HB-User": cUser } })).json();
  ok("#commitment from a prior week reads back as unset via /api/adherence", staleAdh.commitment === null);

  // --- Account truth (Wave 234): /api/adherence carries the server's own answer to
  // "does this user actually have an account". The client used to trust a
  // localStorage flag the OLD send path planted on SEND — so a user who requested a
  // link and never clicked it saw "✓ signed in / your progress is saved" over an
  // account that did not exist, with no way to correct it (lesson 41: stopping the
  // false write does not reach the flags already planted).
  ok("#account_email is null while no verified account exists", staleAdh.account_email === null);
  const acctLink = await requestMagicLink(store, { email: "trueacct@t.com", anonUserId: cUser });
  await json("POST", "/api/auth/consume", { token: acctLink.token });
  const acctAdh = await (await app.request("/api/adherence", { headers: { "X-HB-User": cUser } })).json();
  ok("#account_email reports the verified address once the link is consumed", acctAdh.account_email === "trueacct@t.com");

  // --- Streak freeze (#4 adherence): spend a held token to protect a missed week.
  // Guards first (same parity concern as commitment: an undefined bind THROWS on D1).
  const noUserFreeze = await json("POST", "/api/streak/freeze", { week: "2026-W01" });
  ok("#streak-freeze with no user_id is a clean 404 (guarded before the store call)", noUserFreeze.status === 404);
  const unknownFreeze = await json("POST", "/api/streak/freeze", { user_id: "nope-not-a-user" });
  ok("#streak-freeze for an unknown user is 404", unknownFreeze.status === 404);
  // A brand-new user has trained no weeks -> no earned tokens -> nothing to spend.
  const freshUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const brokeFreeze = await json("POST", "/api/streak/freeze", { user_id: freshUser });
  ok("#streak-freeze with no earned tokens is a 400 (no-tokens)", brokeFreeze.status === 400 && brokeFreeze.data.error === "no-tokens");
  // Happy path: 5 distinct trained weeks (dated relative to NOW — the route reads the
  // real clock) earns a token; weeks -1 AND -4 are missed, so the free forgiveness
  // covers one gap and the freeze must cover the other. Protecting the most-recent
  // missed week frees the forgiveness for the older gap, so the streak jumps.
  const fzUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  for (const n of [14, 21, 35, 42, 49]) // weeks -2,-3,-5,-6,-7 trained; -1 and -4 missed
    await json("POST", "/api/session", { user_id: fzUser, session_id: `fz-${n}`, date: dAgo(n), local_date: dAgo(n).slice(0, 10), sets: [{ set_type: "work", weight_kg: 0, reps: 10 }] });
  const beforeFz = await (await app.request("/api/adherence", { headers: { "X-HB-User": fzUser } })).json();
  const fzRes = await json("POST", "/api/streak/freeze", { user_id: fzUser });
  ok("#streak-freeze spends a token and returns the frozen week", fzRes.status === 200 && !!fzRes.data.frozen_week);
  const fzStored = await store.getUser(fzUser);
  ok("#streak-freeze persists the freeze on the user blob (store parity)", (fzStored.streak_freezes || []).length === 1 && fzStored.streak_freezes[0] === fzRes.data.frozen_week);
  ok("#streak-freeze protecting a second gap lifts the streak above the forgiveness-only value", fzRes.data.streak_weeks > beforeFz.streak_weeks);
  // Re-spending: the same week can't be frozen twice; a fresh call protects another gap or reports none.
  const fzAgain = await json("POST", "/api/streak/freeze", { user_id: fzUser });
  ok("#streak-freeze never double-spends the same week", fzAgain.status === 404 ? false : (fzAgain.status === 400 || (fzAgain.status === 200 && fzAgain.data.frozen_week !== fzRes.data.frozen_week)));

  // Periodization (roadmap #9 + Goal 2 auto-derivation): the app asks NOTHING about
  // periodization; an ADVANCED muscle-building profile auto-undulates end-to-end. "4-6"
  // is a heavy-compound band ONLY the undulation path produces — its presence proves the
  // smart default survived onboard → store → generateUserPlan.
  const advUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "advanced", primary_goal: "hypertrophy",
    days_per_week: 6, session_length_min: 60,
    available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  const advRanges = new Set((await store.getUser(advUser)).program.sessions.flatMap((s) => s.exercises).map((e) => e.rep_range));
  ok("#periodization: an advanced profile auto-undulates end-to-end (no flag asked)", advRanges.has("4-6") && advRanges.size >= 2);
  const intUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 6, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  const intRanges = new Set((await store.getUser(intUser)).program.sessions.flatMap((s) => s.exercises).map((e) => e.rep_range));
  ok("#periodization: an intermediate profile stays linear by default (no heavy 4-6 band)", !intRanges.has("4-6"));
  // The override still works through the whitelist: an explicit "linear" flips advanced off.
  const advLinUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "advanced", primary_goal: "hypertrophy",
    days_per_week: 6, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"], periodization: "linear" } })).data.user_id;
  const advLinRanges = new Set((await store.getUser(advLinUser)).program.sessions.flatMap((s) => s.exercises).map((e) => e.rep_range));
  ok("#periodization: an explicit 'linear' override survives the whitelist and disables undulation", !advLinRanges.has("4-6"));

  // --- Shareable progress card (#10 social): opt-in, revocable, PII-safe. ---
  const noUserShare = await json("POST", "/api/share", {});
  ok("#share POST with no user_id is a clean 404", noUserShare.status === 404);
  const share1 = await json("POST", "/api/share", { user_id: uid });
  ok("#share POST mints a share token", share1.status === 200 && typeof share1.data.share_id === "string" && share1.data.share_id.length > 8);
  const share2 = await json("POST", "/api/share", { user_id: uid });
  ok("#share POST is stable — a second opt-in returns the SAME token (a shared link keeps working)", share2.data.share_id === share1.data.share_id);
  ok("#share token is NOT the user_id (never expose the credential)", share1.data.share_id !== uid);
  // Public read: allowlisted aggregate stats ONLY.
  const pub = await json("GET", `/api/share/${share1.data.share_id}`);
  ok("#share public GET returns the card", pub.status === 200 && typeof pub.data.streak_weeks === "number" && typeof pub.data.level === "number" && typeof pub.data.sessions_logged === "number" && typeof pub.data.sessions_this_week === "number");
  ok("#share public card leaks NO PII (allowlist only: streak_weeks/level/sessions_logged/sessions_this_week/cheers)",
    Object.keys(pub.data).every((k) => ["streak_weeks", "level", "sessions_logged", "sessions_this_week", "cheers"].includes(k)) &&
    !JSON.stringify(pub.data).includes(uid));
  const unknownShare = await json("GET", "/api/share/not-a-real-token-1234");
  ok("#share public GET for an unknown token is 404", unknownShare.status === 404);
  // Revoke invalidates the old token; the public link goes dark.
  const revoked = await json("POST", "/api/share/revoke", { user_id: uid });
  ok("#share revoke succeeds", revoked.status === 200 && revoked.data.revoked === true);
  const afterRevoke = await json("GET", `/api/share/${share1.data.share_id}`);
  ok("#share a revoked token no longer resolves (link goes dark)", afterRevoke.status === 404);
  const share3 = await json("POST", "/api/share", { user_id: uid });
  ok("#share re-opting-in after revoke mints a FRESH token (not the revoked one)", share3.data.share_id !== share1.data.share_id);

  // --- Cheer counter (#10 social): public, bounded, PII-safe social proof. ---
  const cheerTok = share3.data.share_id;
  const card0 = await json("GET", `/api/share/${cheerTok}`);
  ok("#cheer a fresh card starts at 0 cheers", card0.data.cheers === 0);
  const cheer1 = await json("POST", `/api/share/${cheerTok}/cheer`);
  ok("#cheer POST increments and returns the new count", cheer1.status === 200 && cheer1.data.cheers === 1);
  const cheer2 = await json("POST", `/api/share/${cheerTok}/cheer`);
  ok("#cheer POST increments again (server-side; client guards casual double-taps)", cheer2.data.cheers === 2);
  const card2 = await json("GET", `/api/share/${cheerTok}`);
  ok("#cheer the public card reflects the tally", card2.data.cheers === 2);
  ok("#cheer the card still leaks NO PII with cheers added", Object.keys(card2.data).every((k) => ["streak_weeks", "level", "sessions_logged", "sessions_this_week", "cheers"].includes(k)) && !JSON.stringify(card2.data).includes(uid));
  const cheerUnknown = await json("POST", "/api/share/not-a-real-token/cheer");
  ok("#cheer on an unknown/revoked token is 404 (no phantom rows)", cheerUnknown.status === 404);
  const cheerRevoked = await json("POST", `/api/share/${share1.data.share_id}/cheer`);
  ok("#cheer on a revoked token is 404", cheerRevoked.status === 404);
  // Per-IP rate-limit: a fixed IP gets 30 cheers/hr, then 429 (public-write hardening).
  const cheerIP = async () => (await app.request(`/api/share/${cheerTok}/cheer`, { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" } })).status;
  let statuses = [];
  for (let i = 0; i < 31; i++) statuses.push(await cheerIP());
  ok("#cheer per-IP rate-limit: first 30 from an IP succeed", statuses.slice(0, 30).every((s) => s === 200));
  ok("#cheer per-IP rate-limit: the 31st in the window is 429", statuses[30] === 429);
  // A DIFFERENT IP is unaffected (the cap is per-IP, not global).
  const cheerOtherIp = (await app.request(`/api/share/${cheerTok}/cheer`, { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "198.51.100.7" } })).status;
  ok("#cheer rate-limit is per-IP (a different IP still cheers)", cheerOtherIp === 200);

  // --- "New cheers since you last looked" delta (#10 social feedback) ---
  const ncUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const nc1 = await json("POST", "/api/share", { user_id: ncUser });
  ok("#new-cheers a fresh share reports 0 new", nc1.data.new_cheers === 0 && nc1.data.cheers === 0);
  await json("POST", `/api/share/${nc1.data.share_id}/cheer`);
  const nc2 = await json("POST", "/api/share", { user_id: ncUser });
  ok("#new-cheers a cheer since the last look shows as new", nc2.data.new_cheers === 1 && nc2.data.cheers === 1);
  const nc3 = await json("POST", "/api/share", { user_id: ncUser });
  ok("#new-cheers looking again clears the delta (marked seen)", nc3.data.new_cheers === 0 && nc3.data.cheers === 1);
  // The cheer total is surfaced on the main Coach view (/api/adherence), not just the share box.
  const ncAdh = await (await app.request("/api/adherence", { headers: { "X-HB-User": ncUser } })).json();
  ok("#adherence surfaces the share cheer total on the main Coach view", ncAdh.share_cheers === 1);
  const noShareAdh = await (await app.request("/api/adherence", { headers: { "X-HB-User": freshUser } })).json();
  ok("#adherence share_cheers is 0 for a user who hasn't shared", noShareAdh.share_cheers === 0);
  // Revoking a share drops its cheer tally too (no orphaned rows).
  const rvUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const rvShare = (await json("POST", "/api/share", { user_id: rvUser })).data.share_id;
  await json("POST", `/api/share/${rvShare}/cheer`);
  ok("#revoke-cheers precondition: the share has a cheer", (await store.getShareCheers(rvShare)) === 1);
  // Simulate the cheer-push high-water mark having advanced before the revoke.
  await store.updateUser(rvUser, (u) => { u.profile = { ...(u.profile ?? {}), cheers_pushed: 1 }; return u; });
  await json("POST", "/api/share/revoke", { user_id: rvUser });
  ok("#revoke drops the share's cheer tally (no orphaned rows)", (await store.getShareCheers(rvShare)) === 0);
  ok("#revoke resets the cheer-push high-water mark (a re-shared card counts from 0 again)", ((await store.getUser(rvUser)).profile.cheers_pushed ?? 0) === 0);

  // --- Training partners: follow a friend's share card (#10 accountability) ---
  const onboardBw = (st) => json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: st, primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"] } });
  const partnerU = (await onboardBw("beginner")).data.user_id;
  const partnerShare = (await json("POST", "/api/share", { user_id: partnerU })).data.share_id;
  await json("POST", `/api/share/${partnerShare}/cheer`); // give the partner a cheer to surface
  const followerU = (await onboardBw("beginner")).data.user_id;
  ok("#following rejects a token that isn't a live share (404)", (await json("POST", "/api/following", { user_id: followerU, token: "not-a-real-token" })).status === 404);
  ok("#following you can't follow your own card (400)", (await json("POST", "/api/following", { user_id: partnerU, token: partnerShare })).status === 400);
  const follow = await json("POST", "/api/following", { user_id: followerU, token: partnerShare });
  ok("#following adds the partner", follow.status === 200 && follow.data.following === 1);
  ok("#following is idempotent (no duplicate)", (await json("POST", "/api/following", { user_id: followerU, token: partnerShare })).data.following === 1);
  const list = await (await app.request("/api/following", { headers: { "X-HB-User": followerU } })).json();
  ok("#following GET returns the partner's PUBLIC card only (streak/level/cheers, no user_id)",
    list.partners.length === 1 && list.partners[0].active === true && typeof list.partners[0].streak_weeks === "number" && list.partners[0].cheers === 1 && !JSON.stringify(list.partners[0]).includes(partnerU));
  ok("#following GET carries sessions_this_week for the weekly race (#10 social)", typeof list.partners[0].sessions_this_week === "number");
  await json("POST", "/api/share/revoke", { user_id: partnerU });
  const partnerGone = await (await app.request("/api/following", { headers: { "X-HB-User": followerU } })).json();
  ok("#following a revoked partner shows inactive (prunable), not vanished", partnerGone.partners.length === 1 && partnerGone.partners[0].active === false);
  ok("#following/remove drops the partner", (await json("POST", "/api/following/remove", { user_id: followerU, token: partnerShare })).data.following === 0);

  // --- Mutual/reciprocal accountability + partner nudge (#10, this slice) ---
  const alice = (await onboardBw("beginner")).data.user_id;
  const bob = (await onboardBw("beginner")).data.user_id;
  const aliceShare = (await json("POST", "/api/share", { user_id: alice })).data.share_id;
  const bobShare = (await json("POST", "/api/share", { user_id: bob })).data.share_id;
  await json("POST", "/api/following", { user_id: alice, token: bobShare }); // alice follows bob (one-directional so far)
  const aliceListOneWay = await (await app.request("/api/following", { headers: { "X-HB-User": alice } })).json();
  ok("#mutual one-directional following is NOT mutual yet", aliceListOneWay.partners[0].mutual === false);
  const nudgeNotMutual = await json("POST", "/api/following/nudge", { user_id: alice, token: bobShare });
  ok("#nudge is refused between one-directional (non-mutual) partners", nudgeNotMutual.status === 403 && nudgeNotMutual.data.error === "not-mutual");
  await json("POST", "/api/following", { user_id: bob, token: aliceShare }); // bob follows alice back -> now mutual
  const aliceListMutual = await (await app.request("/api/following", { headers: { "X-HB-User": alice } })).json();
  ok("#mutual reciprocal following IS flagged mutual", aliceListMutual.partners[0].mutual === true);
  const bobListMutual = await (await app.request("/api/following", { headers: { "X-HB-User": bob } })).json();
  ok("#mutual is symmetric — bob sees alice as mutual too", bobListMutual.partners[0].mutual === true);
  const nudgeBadToken = await json("POST", "/api/following/nudge", { user_id: alice, token: "not-a-token-alice-doesnt-follow" });
  ok("#nudge with a token you don't follow is refused (400)", nudgeBadToken.status === 400);
  const nudgeOk = await json("POST", "/api/following/nudge", { user_id: alice, token: bobShare });
  ok("#nudge between confirmed mutual partners succeeds", nudgeOk.status === 200 && nudgeOk.data.nudged === true);
  const bobAdherence = await (await app.request("/api/adherence", { headers: { "X-HB-User": bob } })).json();
  ok("#nudge surfaces once on the receiver's /api/adherence", bobAdherence.nudged === true);
  const bobAdherenceAgain = await (await app.request("/api/adherence", { headers: { "X-HB-User": bob } })).json();
  ok("#nudge does not re-surface after being seen once", bobAdherenceAgain.nudged === false);
  const aliceAdherence = await (await app.request("/api/adherence", { headers: { "X-HB-User": alice } })).json();
  ok("#nudge only surfaces for the RECEIVER, never the sender", aliceAdherence.nudged === false);

  // --- 1v1 weekly challenges (#10 social, accept/decline state machine) ---
  const carol = (await onboardBw("beginner")).data.user_id;
  const dave = (await onboardBw("beginner")).data.user_id;
  const carolShare = (await json("POST", "/api/share", { user_id: carol })).data.share_id;
  const daveShare = (await json("POST", "/api/share", { user_id: dave })).data.share_id;
  const getChallenge = (u) => app.request("/api/challenge", { headers: { "X-HB-User": u } }).then((r) => r.json());
  // Multi-challenge (Wave 198): fixtures mutate the slot ARRAY, never the retired
  // legacy scalar — writing `u.profile.challenge` here would leave the real slot
  // untouched and the fixture silently inert.
  const backdateChallenges = (uid, week) => store.updateUser(uid, (u) => {
    u.profile = { ...u.profile, challenges: challengeSlotsT(u.profile).map((ch) => ({ ...ch, week })) };
    return u;
  });
  ok("#challenge not-following is refused (400)", (await json("POST", "/api/challenge", { user_id: carol, token: daveShare })).status === 400);
  await json("POST", "/api/following", { user_id: carol, token: daveShare }); // one-directional so far
  ok("#challenge one-directional following is refused (403 not-mutual)", (await json("POST", "/api/challenge", { user_id: carol, token: daveShare })).status === 403);
  await json("POST", "/api/following", { user_id: dave, token: carolShare }); // now mutual
  ok("#challenge can't target yourself (400)", (await json("POST", "/api/challenge", { user_id: carol, token: carolShare })).status === 400);
  const propose = await json("POST", "/api/challenge", { user_id: carol, token: daveShare });
  ok("#challenge propose between mutual partners succeeds", propose.status === 200 && propose.data.challenged === true);
  const carolView1 = await getChallenge(carol);
  ok("#challenge challenger sees role+status pending", carolView1.challenge.role === "challenger" && carolView1.challenge.status === "pending");
  const daveView1 = await getChallenge(dave);
  ok("#challenge opponent sees role+status pending too", daveView1.challenge.role === "opponent" && daveView1.challenge.status === "pending");
  ok("#challenge a challenger can't open a second one while pending (409)", (await json("POST", "/api/challenge", { user_id: carol, token: daveShare })).status === 409);
  const erin = (await onboardBw("beginner")).data.user_id;
  const erinShare = (await json("POST", "/api/share", { user_id: erin })).data.share_id;
  await json("POST", "/api/following", { user_id: erin, token: daveShare });
  await json("POST", "/api/following", { user_id: dave, token: erinShare }); // erin is ALSO mutual with dave
  // THE FEATURE (Wave 198): a third mutual party CAN now challenge dave while his
  // carol-challenge is open — concurrent challenges with different partners. The old
  // assertion here (409 opponent-busy) was the single-slot limitation itself.
  const erinPropose = await json("POST", "/api/challenge", { user_id: erin, token: daveShare });
  ok("#multi a second partner CAN challenge an already-challenged opponent", erinPropose.status === 200);
  const daveTwo = await getChallenge(dave);
  ok("#multi the opponent sees BOTH pending invites, each with its own id",
    (daveTwo.challenges ?? []).filter((ch) => ch.status === "pending").length === 2
    && new Set(daveTwo.challenges.map((ch) => ch.id)).size === 2);
  ok("#multi respond with NO challenge_id and TWO pending invites is refused, not guessed",
    (await json("POST", "/api/challenge/respond", { user_id: dave, accept: true })).status === 400);
  const erinChId = erinPropose.data.challenge_id;
  const declineErin = await json("POST", "/api/challenge/respond", { user_id: dave, challenge_id: erinChId, accept: false });
  ok("#multi respond BY ID answers exactly that invite", declineErin.status === 200 && declineErin.data.challenge_id === erinChId);
  ok("#multi ...leaving the other invite untouched and still pending",
    challengeSlotsT((await store.getUser(dave)).profile).some((ch) => ch.status === "pending" && ch.id !== erinChId));

  // Decline: both sides see it, and the slot reopens for a fresh propose.
  const decline = await json("POST", "/api/challenge/respond", { user_id: dave, accept: false });
  ok("#challenge decline succeeds", decline.status === 200 && decline.data.status === "declined");
  ok("#challenge decline propagates to the challenger's side too", (await getChallenge(carol)).challenge.status === "declined");
  ok("#challenge a DECLINE never stamps accepted_at (nothing consumes it; no push)", (await getChallenge(carol)).challenge.accepted_at === undefined);
  ok("#challenge a challenger can't respond to their own proposal", (await json("POST", "/api/challenge/respond", { user_id: carol, accept: true })).status === 400);
  // An unanswered/declined invite has no real result — it must NOT add a history entry.
  ok("#challenge-history a declined challenge records no history", ((await getChallenge(carol)).history ?? []).length === 0);

  // Re-propose (the slot was freed by the decline) and accept this time.
  await json("POST", "/api/challenge", { user_id: carol, token: daveShare });
  const accept = await json("POST", "/api/challenge/respond", { user_id: dave, accept: true });
  ok("#challenge accept succeeds", accept.status === 200 && accept.data.status === "active");
  ok("#challenge accept propagates to the challenger's side too", (await getChallenge(carol)).challenge.status === "active");
  ok("#challenge an ACCEPT stamps accepted_at on the challenger's copy (the accept-push high-water mark)", typeof (await getChallenge(carol)).challenge.accepted_at === "number");
  ok("#challenge a second propose while active is refused (409)", (await json("POST", "/api/challenge", { user_id: carol, token: daveShare })).status === 409);

  // Log sessions for each side THIS week and confirm the live tally is correct.
  const dNow = (n) => new Date(Date.now() - n * 3600000).toISOString();
  await json("POST", "/api/session", { user_id: carol, session_id: "ch-c1", date: dNow(0),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await json("POST", "/api/session", { user_id: carol, session_id: "ch-c2", date: dNow(0),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await json("POST", "/api/session", { user_id: dave, session_id: "ch-d1", date: dNow(0), // 0 = NOW: an hours-ago date crosses the ISO week boundary every early Monday
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  const carolView2 = await getChallenge(carol);
  ok("#challenge live tally counts each side's own sessions this week", carolView2.my_count === 2 && carolView2.opponent_count === 1);
  const daveView2 = await getChallenge(dave);
  ok("#challenge live tally is symmetric from the opponent's side", daveView2.my_count === 1 && daveView2.opponent_count === 2);
  ok("#challenge week_over is false mid-week", carolView2.week_over === false);

  // Week-over auto-resolution: force the stored challenge onto a past week key
  // (computed relative to Date.now(), never a fixed calendar date — CLAUDE.md)
  // and confirm it self-completes with the frozen tally on next read.
  const pastWeek = isoWeekKey(new Date(Date.now() - 8 * 7 * 86400000).toISOString());
  await backdateChallenges(carol, pastWeek);
  await backdateChallenges(dave, pastWeek);
  const carolView3 = await getChallenge(carol);
  ok("#challenge self-completes once its week has ended", carolView3.challenge.status === "completed" && carolView3.week_over === true);
  ok("#challenge a completed challenge frees the slot for a new propose", (await json("POST", "/api/challenge", { user_id: carol, token: daveShare })).status === 200);

  // A stale pending challenge (its week already ended) must NOT be acceptable via
  // /api/challenge/respond directly — this route is reachable without ever calling
  // GET /api/challenge first (which is what normally self-resolves a stale pending
  // challenge to "declined"), so it has to enforce the same week-freshness rule
  // itself or a late accept could revive an unanswered invite into "active".
  const stalePastWeek = isoWeekKey(new Date(Date.now() - 8 * 7 * 86400000).toISOString());
  await backdateChallenges(carol, stalePastWeek);
  await backdateChallenges(dave, stalePastWeek);
  const staleAccept = await json("POST", "/api/challenge/respond", { user_id: dave, accept: true });
  ok("#challenge accepting a challenge whose week already ended is refused (400), not revived to active", staleAccept.status === 400 && staleAccept.data.error === "no-pending-challenge");
  // Reading it (which self-transitions the stale pending copy to "declined") proves
  // the refused accept above left no "active" residue on the challenger's side either.
  ok("#challenge a refused stale accept never revived the challenger's copy to active", (await getChallenge(carol)).challenge.status === "declined");
  const staleDecline = await json("POST", "/api/challenge/respond", { user_id: dave, accept: false });
  ok("#challenge declining a challenge whose week already ended is also refused (the slot resolves via GET's self-transition instead)", staleDecline.status === 400 && staleDecline.data.error === "no-pending-challenge");

  // --- Challenge history / win-loss record (#10 social follow-on): a completed
  // challenge now persists a compact win/lose/tie record to profile.challenge_history
  // on BOTH sides — separate from the single-slot `challenge` field, which the next
  // propose overwrites. Dated relative to Date.now() so a session-date filter
  // (sessionsInWeek) actually matches the manufactured past week, unlike the
  // week-over test above (which doesn't need real counts, just the status flip).
  const frank = (await onboardBw("beginner")).data.user_id;
  const grace = (await onboardBw("beginner")).data.user_id;
  const frankShare = (await json("POST", "/api/share", { user_id: frank })).data.share_id;
  const graceShare = (await json("POST", "/api/share", { user_id: grace })).data.share_id;
  await json("POST", "/api/following", { user_id: frank, token: graceShare });
  await json("POST", "/api/following", { user_id: grace, token: frankShare });
  await json("POST", "/api/challenge", { user_id: frank, token: graceShare });
  await json("POST", "/api/challenge/respond", { user_id: grace, accept: true });
  const fgPastDate = new Date(Date.now() - 8 * 7 * 86400000).toISOString();
  const fgPastWeek = isoWeekKey(fgPastDate);
  // Sessions dated WITHIN that same manufactured past week, so sessionsInWeek
  // actually credits them once the challenge's own week is moved there too.
  await json("POST", "/api/session", { user_id: frank, session_id: "fg-f1", date: fgPastDate,
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await json("POST", "/api/session", { user_id: frank, session_id: "fg-f2", date: fgPastDate,
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await json("POST", "/api/session", { user_id: grace, session_id: "fg-g1", date: fgPastDate,
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await backdateChallenges(frank, fgPastWeek);
  await backdateChallenges(grace, fgPastWeek);
  const frankFinal = await getChallenge(frank);
  ok("#challenge-history a completed challenge records a WIN for the side with more sessions", frankFinal.challenge.status === "completed"
    && frankFinal.history.length === 1 && frankFinal.history[0].result === "win"
    && frankFinal.history[0].my_count === 2 && frankFinal.history[0].opponent_count === 1 && frankFinal.history[0].week === fgPastWeek);
  const graceFinal = await getChallenge(grace);
  ok("#challenge-history the mirror LOSE is recorded independently on the opponent's own side", graceFinal.history.length === 1
    && graceFinal.history[0].result === "lose" && graceFinal.history[0].my_count === 1 && graceFinal.history[0].opponent_count === 2);
  // Re-reading doesn't double-record: the challenge is already terminal, so a
  // second GET must not append a duplicate entry.
  const frankReread = await getChallenge(frank);
  ok("#challenge-history re-reading a completed challenge does not duplicate the history entry", frankReread.history.length === 1);
  // A fresh challenge + tie also records correctly, AND the cap holds the most
  // recent CHALLENGE_HISTORY_CAP (20) entries, oldest dropped first.
  await store.updateUser(frank, (u) => { u.profile = { ...u.profile, challenge_history: Array.from({ length: 20 }, (_, i) => ({ week: `filler-${i}`, result: "win", my_count: 1, opponent_count: 0 })) }; return u; });
  await json("POST", "/api/challenge", { user_id: frank, token: graceShare });
  await json("POST", "/api/challenge/respond", { user_id: grace, accept: true });
  await json("POST", "/api/session", { user_id: grace, session_id: "fg-g2", date: fgPastDate,
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await backdateChallenges(frank, fgPastWeek);
  await backdateChallenges(grace, fgPastWeek);
  const frankCapped = await getChallenge(frank);
  ok("#challenge-history caps at 20 entries, dropping the oldest", frankCapped.history.length === 20 && frankCapped.history[0].week === fgPastWeek && frankCapped.history[19].week === "filler-18");

  // Regression (audit fix): isChallengeOpen already treats a week-over challenge
  // as free (Wave 127), so a fresh propose can legitimately land between GET
  // /api/challenge's read and its own completion-write for the SAME user. The
  // CAS guard inside that write correctly no-ops (the challenge id it's holding
  // is now stale), but the response must not still report the win/loss it had
  // optimistically computed — that would show a trophy the store never recorded.
  const henry = (await onboardBw("beginner")).data.user_id;
  const iris = (await onboardBw("beginner")).data.user_id;
  const henryShare = (await json("POST", "/api/share", { user_id: henry })).data.share_id;
  const irisShare = (await json("POST", "/api/share", { user_id: iris })).data.share_id;
  await json("POST", "/api/following", { user_id: henry, token: irisShare });
  await json("POST", "/api/following", { user_id: iris, token: henryShare });
  await json("POST", "/api/challenge", { user_id: henry, token: irisShare });
  await json("POST", "/api/challenge/respond", { user_id: iris, accept: true });
  const hiPastDate = new Date(Date.now() - 8 * 7 * 86400000).toISOString();
  const hiPastWeek = isoWeekKey(hiPastDate);
  await json("POST", "/api/session", { user_id: henry, session_id: "hi-h1", date: hiPastDate,
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await backdateChallenges(henry, hiPastWeek);
  await backdateChallenges(iris, hiPastWeek);
  // Simulate the race: right as the route calls store.updateUser(henry, ...) to
  // persist the completion, a "concurrent" fresh propose has already swapped
  // henry's challenge id out from under it — one time only, mirroring exactly
  // the window the fix guards.
  const realUpdateUser = store.updateUser.bind(store);
  let raced = false;
  store.updateUser = async (uid, mutator) => {
    if (uid === henry && !raced) {
      raced = true;
      await realUpdateUser(henry, (u) => { u.profile = { ...u.profile, challenges: challengeSlotsT(u.profile).map((ch) => ({ ...ch, id: "raced-in-new-id" })) }; return u; });
    }
    return realUpdateUser(uid, mutator);
  };
  const henryRaced = await getChallenge(henry);
  store.updateUser = realUpdateUser;
  ok("#challenge-history a raced slot-replacement does not fabricate a history entry in the response", (henryRaced.history ?? []).length === 0);
  ok("#challenge-history a raced slot-replacement does not persist a phantom entry either", ((await store.getUser(henry)).profile.challenge_history ?? []).length === 0);
  // Hardening (PR #210 follow-up): if the user row vanishes between the handler's
  // initial read and its completion-write, store.updateUser returns null — the
  // route must treat that as "not written" (via `updated?.`) and return the
  // un-fabricated current state, never dereference null and 500. henry's challenge
  // is still active + week-over here, so the GET reaches the completion-write path.
  const realUpdateUser2 = store.updateUser.bind(store);
  store.updateUser = async () => null; // simulate the row gone at write time
  const henryVanished = await app.request("/api/challenge", { headers: { "X-HB-User": henry } });
  store.updateUser = realUpdateUser2;
  ok("#challenge-history a user row vanishing at write time returns 200, not a 500 (updated?. guard)", henryVanished.status === 200);

  // --- Audit fix (Cloud loop wave): the 1v1 challenge feature (propose/respond/
  // isChallengeOpen) and the weekly-commitment device stamped/compared their
  // "current week" via a raw UTC instant — for anyone west of UTC, that instant
  // can already read as the NEXT ISO week while it's still today locally,
  // silently ending a challenge or losing a commitment up to a day early (the
  // same class of bug PR #238 fixed for the commitment PUSH; this closes it for
  // the STORAGE/read side too, and for challenges, via the new isoWeekKeyLocal).
  // A real HTTP wiring check that tz_offset_min actually reaches both features
  // --- Legacy single-slot migration (Wave 198) -----------------------------
  // A pre-198 row stores `profile.challenge` (scalar) + per-USER pushed watermarks.
  // Readers must see it as a one-slot array with the watermarks mapped onto the
  // slot's own booleans; the first WRITE migrates the shape and drops the legacy
  // fields. Seeded directly, exactly as a real un-migrated D1 row would look.
  const leo = (await onboardBw("beginner")).data.user_id;
  const mia = (await onboardBw("beginner")).data.user_id;
  const leoShare = (await json("POST", "/api/share", { user_id: leo })).data.share_id;
  const miaShare = (await json("POST", "/api/share", { user_id: mia })).data.share_id;
  await json("POST", "/api/following", { user_id: leo, token: miaShare });
  await json("POST", "/api/following", { user_id: mia, token: leoShare });
  const legacyCreated = Date.now() - 3600e3;
  const legacyWeek = isoWeekKeyLocal(Date.now(), null);
  await store.updateUser(leo, (u) => {
    delete u.profile.challenges;
    u.profile = { ...u.profile,
      challenge: { id: "legacy-1", role: "opponent", partner_token: miaShare, week: legacyWeek, status: "pending", created_at: legacyCreated },
      challenge_pushed_at: legacyCreated + 60e3, // invite WAS pushed pre-migration
    };
    return u;
  });
  const leoView = await getChallenge(leo);
  ok("#legacy a pre-198 scalar row reads as a one-slot array through GET",
    (leoView.challenges ?? []).length === 1 && leoView.challenges[0].id === "legacy-1"
    && leoView.challenge?.id === "legacy-1"); // the mirror key too
  ok("#legacy the per-user pushed watermark maps onto the slot (never re-pushed after migration)",
    challengeSlotsT((await store.getUser(leo)).profile)[0].invite_pushed === true);
  const legacyAccept = await json("POST", "/api/challenge/respond", { user_id: leo, accept: true });
  ok("#legacy respond with no challenge_id works on a single legacy invite", legacyAccept.status === 200 && legacyAccept.data.status === "active");
  const leoStored = (await store.getUser(leo)).profile;
  ok("#legacy the first write migrates the shape: challenges array present, legacy fields gone",
    Array.isArray(leoStored.challenges) && leoStored.challenge === undefined && leoStored.challenge_pushed_at === undefined);

  // --- The open-slot cap (Wave 198) ----------------------------------------
  const hub = (await onboardBw("beginner")).data.user_id;
  const hubShare = (await json("POST", "/api/share", { user_id: hub })).data.share_id;
  const partners = [];
  for (let i = 0; i < MAX_OPEN_T + 1; i++) {
    const pid = (await onboardBw("beginner")).data.user_id;
    const pShare = (await json("POST", "/api/share", { user_id: pid })).data.share_id;
    await json("POST", "/api/following", { user_id: hub, token: pShare });
    await json("POST", "/api/following", { user_id: pid, token: hubShare });
    partners.push({ pid, pShare });
  }
  for (let i = 0; i < MAX_OPEN_T; i++) {
    ok(`#cap open challenge ${i + 1}/${MAX_OPEN_T} proposes cleanly`,
      (await json("POST", "/api/challenge", { user_id: hub, token: partners[i].pShare })).status === 200);
  }
  const overCap = await json("POST", "/api/challenge", { user_id: hub, token: partners[MAX_OPEN_T].pShare });
  ok("#cap a propose past the open-slot cap is refused", overCap.status === 409 && overCap.data.error === "challenge-slots-full");
  const intoFullHub = await json("POST", "/api/challenge", { user_id: partners[MAX_OPEN_T].pid, token: hubShare });
  ok("#cap ...and a propose INTO a full user is refused as opponent-busy", intoFullHub.status === 409 && intoFullHub.data.error === "opponent-busy");
  ok("#cap the pair rule is literal-pinned: MAX_OPEN_CHALLENGES is 3", MAX_OPEN_T === 3);

  // (the deterministic UTC-boundary proof lives in the pure-function tests,
  // since real Date.now() during a test run isn't controllably AT that boundary).
  const jack = (await onboardBw("beginner")).data.user_id;
  const kate = (await onboardBw("beginner")).data.user_id;
  await store.updateUser(jack, (u) => { u.profile = { ...u.profile, tz_offset_min: -420 }; return u; });
  const jackShare = (await json("POST", "/api/share", { user_id: jack })).data.share_id;
  const kateShare = (await json("POST", "/api/share", { user_id: kate })).data.share_id;
  await json("POST", "/api/following", { user_id: jack, token: kateShare });
  await json("POST", "/api/following", { user_id: kate, token: jackShare });
  const jackPropose = await json("POST", "/api/challenge", { user_id: jack, token: kateShare });
  ok("#challenge tz: a challenger with a stored tz_offset_min gets a localized (not raw-UTC) week stamp",
    jackPropose.data.week === isoWeekKeyLocal(Date.now(), -420));
  const jackCommit = await json("POST", "/api/commitment", { user_id: jack, days: ["mon"] });
  ok("#commitment tz: stamps the CALLER's own localized week, not a raw UTC one",
    jackCommit.data.commitment.week === isoWeekKeyLocal(Date.now(), -420));
  const jackAdh = await (await app.request("/api/adherence", { headers: { "X-HB-User": jack } })).json();
  ok("#commitment tz: /api/adherence's freshness check agrees with the same localized week (storage and read never disagree)",
    JSON.stringify(jackAdh.commitment) === JSON.stringify(jackCommit.data.commitment));

  // --- Goal-event taper (Tier-3 #9 first slice): /api/today reads the REAL
  // clock, so date the goal event RELATIVE to Date.now(), not a fixed calendar
  // date (the deload-anchoring test above hit this same lesson).
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const taperUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
    goal_event_date: inDays(3),
  } })).data.user_id;
  const taperToday = await (await app.request("/api/today", { headers: { "X-HB-User": taperUser } })).json();
  ok("#taper /api/today surfaces the taper card inside the window", taperToday.session?.taper?.days_until <= 3 && taperToday.session?.taper?.days_until >= 2);
  ok("#taper suppresses the mesocycle block card so they never contradict each other", taperToday.session?.block == null);

  // A junk/unparsable date is hostile client input until validated (possession-
  // of-UUID auth means any client can post) — it must collapse to null, not
  // corrupt the taper engine or get stored verbatim.
  const junkDateUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"], goal_event_date: "not-a-real-date",
  } })).data.user_id;
  const junkExplain = await (await app.request("/api/plan/explain", { headers: { "X-HB-User": junkDateUser } })).json();
  ok("#taper a junk goal_event_date is sanitized to null at the trust boundary, not stored verbatim", junkExplain.profile?.goal_event_date === null);

  // A beginner is exempt (programmatic peaking isn't a beginner decision) even
  // with a goal date inside the window.
  const beginnerTaperUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["bodyweight"], goal_event_date: inDays(3),
  } })).data.user_id;
  const beginnerToday = await (await app.request("/api/today", { headers: { "X-HB-User": beginnerTaperUser } })).json();
  ok("#taper beginners are exempt even with a goal date inside the window", beginnerToday.session?.taper == null);

  // --- The concurrent-training read, through /api/progress -------------------
  // Tested at the route because the payload has to survive the same door the client
  // uses: /api/progress had to start reading check-ins for the readiness corroborator,
  // and a route that forgets to pass them makes the card silently unreachable while
  // every unit test stays green (the whole reason this suite exists).
  //
  // Dates are relative to Date.now() per this file's rule, but ANCHORED TO A MONDAY:
  // per-muscle volume buckets by ISO week, so a floating 3-session block could straddle
  // a week boundary, split the volume, drop it under MEV and silently stop the pattern
  // firing on whatever weekday CI happened to run.
  const nowD = new Date();
  const mondayMs = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate()) - ((nowD.getUTCDay() + 6) % 7) * 86400000;
  const wkDay = (weeksBack, offset) => new Date(mondayMs - weeksBack * 7 * 86400000 + offset * 86400000).toISOString();
  const ifProfile = { units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  // 5 complete weeks: squat + RDL dead flat, bench/row/press climbing. Squat twice a
  // week keeps quads at 10 sets and hamstrings at 9 — inside MEV..MAV, so the
  // discriminator reads "not a volume problem".
  const seedInterference = async (user, tag) => {
    const set = (ex, w, r) => ({ exercise: ex, set_type: "work", weight_kg: w, reps: r });
    for (let n = 0; n < 5; n++) {
      const back = 5 - n, base = 100 + n * 2.5;
      await json("POST", "/api/session", { user_id: user, session_id: `${tag}-a${n}`, date: wkDay(back, 0),
        sets: [...Array(5).fill(set("barbell-back-squat", 140, 5)), ...Array(4).fill(set("barbell-bench-press", base, 6))] });
      await json("POST", "/api/session", { user_id: user, session_id: `${tag}-b${n}`, date: wkDay(back, 2),
        sets: [...Array(4).fill(set("romanian-deadlift", 120, 8)), ...Array(4).fill(set("barbell-row", base - 20, 8)), ...Array(3).fill(set("barbell-overhead-press", base - 40, 6))] });
      await json("POST", "/api/session", { user_id: user, session_id: `${tag}-c${n}`, date: wkDay(back, 4),
        sets: [...Array(5).fill(set("barbell-back-squat", 140, 5)), ...Array(4).fill(set("barbell-bench-press", base, 6))] });
    }
  };
  const ifUserId = (await json("POST", "/api/onboard", { profile: ifProfile })).data.user_id;
  await seedInterference(ifUserId, "if");
  for (let n = 0; n < 5; n++) await json("POST", "/api/bodyweight", { user_id: ifUserId, kg: 82 - n * 0.3, date: wkDay(5 - n, 0).slice(0, 10) });
  const ifProg = await (await app.request("/api/progress", { headers: { "X-HB-User": ifUserId } })).json();
  ok("#cardio /api/progress surfaces the interference pattern end-to-end", ifProg.interference?.pattern === "lower-body-stall-asymmetry");
  ok("#cardio it names only stalled lower-body lifts, and the plateau card agrees",
    ifProg.interference?.stalled_lower?.length === 2
    && ifProg.interference.stalled_lower.every((s) => (ifProg.stalls || []).some((x) => x.exercise === s.exercise)));
  ok("#cardio the note quotes the KB guideline's scale-back test", /Halve your structured cardio/.test(ifProg.interference?.note || ""));

  // The negative twin: identical training, no weigh-ins and no check-ins. The plateau
  // card still fires; the interference card must not. Silence is the common case.
  const ifQuietId = (await json("POST", "/api/onboard", { profile: ifProfile })).data.user_id;
  await seedInterference(ifQuietId, "ifq");
  const quietProg = await (await app.request("/api/progress", { headers: { "X-HB-User": ifQuietId } })).json();
  ok("#cardio uncorroborated, the card stays silent while the plateau card still fires",
    quietProg.interference == null && (quietProg.stalls || []).length >= 2);

  // ---- Wave 162: the logged-set trust boundary ----------------------------
  // `rir` had been clamped at this door for waves while `weight_kg`/`reps` sat
  // unbounded right beside it (lesson 16: the guard applied to ONE field). Auth is
  // possession-of-UUID, so any client can post these. Driven through the REAL
  // program (a fixed exercise id might not appear in this user's plan, and a test
  // that can't reach the code it names passes vacuously — lesson 25).
  const boundId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    // 2 days/week: the rotation returns to session 0 after the two logs below, so
    // today's card shows the same exercise we poisoned (otherwise the last three
    // assertions look at a different lift and quietly prove nothing).
    days_per_week: 2, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const boundEx = (await (await app.request("/api/today", { headers: { "X-HB-User": boundId } })).json()).session.exercises[0].exercise;
  // A normal baseline first, so the absurd session below has a prior best to beat —
  // without it there is no PR to detect and the ceiling assertion proves nothing.
  await json("POST", "/api/session", { user_id: boundId, session_id: "bound-base", date: new Date(Date.now() - 3 * 86400000).toISOString(),
    sets: [...Array(3).fill({ exercise: boundEx, weight_kg: 60, reps: 8 })] });
  const boundRes = await json("POST", "/api/session", { user_id: boundId, session_id: "bound-1", date: new Date().toISOString(),
    sets: [
      { exercise: boundEx, weight_kg: 999999, reps: 5 },
      { exercise: boundEx, weight_kg: 100, reps: 99999 },
      { exercise: boundEx, weight_kg: "not-a-number", reps: -4 },
    ] });
  ok("#bounds a session with absurd numbers is still ACCEPTED (a 400 would strand an offline queue)", boundRes.status === 200);
  ok("#bounds the absurd session still produced a PR — so the ceiling below is a real assertion, not a vacuous one",
    (boundRes.data?.pr_xp ?? 0) > 0);
  const boundProg = await (await app.request("/api/progress", { headers: { "X-HB-User": boundId } })).json();
  // Read the persisted sets back the only way a client can: the records the engines
  // derive from them. Unbounded, 999999 kg surfaces here as a ~1.4M kg estimated 1RM
  // and anchors every future suggestion.
  const heaviestPR = Math.max(0, ...(boundProg.personal_records ?? []).map((r) => r.e1rm_kg ?? r.load_kg ?? 0));
  ok("#bounds no derived record can exceed the weight ceiling's own e1RM", heaviestPR > 0 && heaviestPR <= 1000 * (1 + 12 / 30) + 0.01);
  const boundToday = await (await app.request("/api/today", { headers: { "X-HB-User": boundId } })).json();
  const boundCard = (boundToday.session?.exercises ?? []).find((e) => e.exercise === boundEx);
  ok("#bounds the outlier can't anchor the next suggested weight", boundCard != null && boundCard.suggested_kg <= 1000);
  // last_kg rides the /api/today payload so the player can judge a set against the
  // lift's OWN history (session-core's isImplausibleSet). A route whitelist dropping
  // it would silently disable the whole typo guard — exactly the deload-flag bug
  // this file exists for.
  ok("#bounds /api/today carries last_kg, the reference the player's typo guard needs",
    boundCard != null && typeof boundCard.last_kg === "number" && boundCard.last_kg > 0);

  // ---- Wave 171: the effort door + the effort lever end-to-end -----------
  // normalizeSet's effort fields, through the REAL door. Before this wave a
  // non-numeric rir survived the clamp as NaN (stored as JSON null) and rpe was
  // entirely unclamped beside the clamped rir — lesson 27 recurring three lines
  // from where it was learned.
  const effGuardId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 2, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const effGuardRes = await json("POST", "/api/session", { user_id: effGuardId, session_id: "eff-guard", date: new Date().toISOString(),
    sets: [
      { exercise: "barbell-bench-press", weight_kg: 100, reps: 8, rir: "x", rpe: "y" },
      { exercise: "barbell-bench-press", weight_kg: 100, reps: 8, rpe: 14, rir: 22 },
      { exercise: "barbell-bench-press", weight_kg: 100, reps: 8, rir: 2 },
    ] });
  ok("#effort a garbage-effort session is still accepted (clamp/drop, never 400)", effGuardRes.status === 200);
  const effStored = (await store.listSessions(effGuardId)).find((s) => s.session_id === "eff-guard")?.sets ?? [];
  ok("#effort non-numeric rir/rpe are DROPPED — no key, no NaN, no null", !("rir" in effStored[0]) && !("rpe" in effStored[0]));
  ok("#effort rpe is clamped 0-10 beside rir (lesson 27's sibling field)", effStored[1]?.rpe === 10 && effStored[1]?.rir === 10);
  // A valid rir must round-trip the EDIT route too (the history screen re-sends
  // stored sets whole; the whitelist dropping it would silently erase effort data).
  const effEdit = await json("POST", "/api/session/update", { user_id: effGuardId, session_id: "eff-guard",
    sets: [{ exercise: "barbell-bench-press", weight_kg: 102.5, reps: 8, rir: 2 }] });
  ok("#effort a valid rir survives the edit route's re-normalize", effEdit.status === 200 && effEdit.data?.session?.sets?.[0]?.rir === 2);

  // The lever end-to-end: identical flat histories, one with logged rir 4 (a clear
  // surplus over bench's heavy band top 3), one without. The rir user's stalled
  // chest must read "effort" (push closer to failure); the silent user keeps
  // today's "add" — absent data must change nothing (the Increment-C rationale).
  const effWeek = (uid, n, prefix, rir) => json("POST", "/api/session", { user_id: uid, session_id: `${prefix}-${n}`, date: new Date(Date.now() - n * 86400000).toISOString(),
    sets: Array.from({ length: 12 }, () => ({ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8, ...(rir != null ? { rir } : {}) })) });
  const effEasyId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 2, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  for (const n of [35, 28, 21, 14, 7]) await effWeek(effEasyId, n, "easy", 4);
  const effProg = await (await app.request("/api/progress", { headers: { "X-HB-User": effEasyId } })).json();
  const effRow = (effProg.adaptive ?? []).find((a) => a.muscle === "chest");
  ok("#effort a stalled muscle with logged-surplus effort reads 'effort', not 'add'", effRow?.signal === "effort");
  ok("#effort the advice names the fix (closer to failure), not more volume", /closer|reserve|failure/i.test(effRow?.advice ?? ""));
  const effQuietId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 2, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  for (const n of [35, 28, 21, 14, 7]) await effWeek(effQuietId, n, "quiet", null);
  const quietProg2 = await (await app.request("/api/progress", { headers: { "X-HB-User": effQuietId } })).json();
  const quietRow = (quietProg2.adaptive ?? []).find((a) => a.muscle === "chest");
  ok("#effort the SAME history without rir keeps today's 'add' — absent data changes nothing", quietRow?.signal === "add");

  // ---- Wave 163: correcting the log --------------------------------------
  // A bad set used to be permanent (no edit/delete route existed at all). These
  // drive the full loop through the real door: log -> it counts -> void it -> it
  // stops counting everywhere -> un-void -> it counts again.
  const histId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 2, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const histEx = (await (await app.request("/api/today", { headers: { "X-HB-User": histId } })).json()).session.exercises[0].exercise;
  const histHdr = { headers: { "X-HB-User": histId } };
  // Three sessions so that voiding ONE leaves an even count — the rotation then
  // lands back on day 0, where histEx lives, and the anchor assertion below can
  // actually see the lift it's about (voiding rewinds the rotation, see there).
  await json("POST", "/api/session", { user_id: histId, session_id: "hist-good", date: new Date(Date.now() - 4 * 86400000).toISOString(),
    sets: [...Array(3).fill({ exercise: histEx, weight_kg: 60, reps: 8 })] });
  await json("POST", "/api/session", { user_id: histId, session_id: "hist-good2", date: new Date(Date.now() - 3 * 86400000).toISOString(),
    sets: [...Array(3).fill({ exercise: histEx, weight_kg: 60, reps: 8 })] });
  await json("POST", "/api/session", { user_id: histId, session_id: "hist-bad", date: new Date().toISOString(),
    sets: [...Array(3).fill({ exercise: histEx, weight_kg: 600, reps: 8 })] });

  const beforeVoid = await (await app.request("/api/progress", histHdr)).json();
  ok("#history the mistyped session counts before it's corrected (so the void below proves something)",
    beforeVoid.sessions_logged === 3 && Math.max(0, ...(beforeVoid.personal_records ?? []).map((r) => r.e1rm_kg ?? r.load_kg ?? 0)) > 500);

  const histList = await (await app.request("/api/sessions", histHdr)).json();
  ok("#history GET /api/sessions returns the log, newest first", histList.sessions?.[0]?.session_id === "hist-bad");

  const voidRes = await json("POST", "/api/session/void", { user_id: histId, session_id: "hist-bad" });
  ok("#history POST /api/session/void reports what it PERSISTED, not a local guess (lesson 21)", voidRes.status === 200 && voidRes.data.voided === true);
  const afterVoid = await (await app.request("/api/progress", histHdr)).json();
  ok("#history a voided session stops counting everywhere the engines look", afterVoid.sessions_logged === 2);
  ok("#history and its inflated PR is gone with it", Math.max(0, ...(afterVoid.personal_records ?? []).map((r) => r.e1rm_kg ?? r.load_kg ?? 0)) < 500);
  // Voiding also rewinds the session ROTATION (one fewer session logged = you're
  // due the day you were due), so today's card may be a different day entirely —
  // assert the thing that actually matters: the voided number anchors nothing.
  const afterVoidToday = await (await app.request("/api/today", histHdr)).json();
  const afterVoidCard = (afterVoidToday.session?.exercises ?? []).find((e) => e.exercise === histEx);
  ok("#history the next suggested weight re-derives from the surviving sessions, not the voided one",
    afterVoidCard != null && afterVoidCard.last_kg === 60);

  const stillListed = await (await app.request("/api/sessions", histHdr)).json();
  ok("#history the voided session is NOT deleted — it's still on the history screen, flagged, so undo is possible",
    (stillListed.sessions ?? []).some((x) => x.session_id === "hist-bad" && !!x.voided_at));

  // Idempotence + reversibility.
  const reVoid = await json("POST", "/api/session/void", { user_id: histId, session_id: "hist-bad" });
  ok("#history re-voiding keeps the ORIGINAL timestamp (when you took it back stays true)",
    reVoid.data.session.voided_at === voidRes.data.session.voided_at);
  await json("POST", "/api/session/void", { user_id: histId, session_id: "hist-bad", voided: false });
  ok("#history un-voiding brings it back — void is a toggle, never a delete",
    (await (await app.request("/api/progress", histHdr)).json()).sessions_logged === 3);

  // Editing: the fix a user actually wants — keep the workout, correct the number.
  const editRes = await json("POST", "/api/session/update", { user_id: histId, session_id: "hist-bad",
    sets: [...Array(3).fill({ exercise: histEx, weight_kg: 65, reps: 8 })] });
  ok("#history POST /api/session/update rewrites the sets", editRes.status === 200);
  const afterEdit = await (await app.request("/api/progress", histHdr)).json();
  ok("#history the corrected weight replaces the bad one in every derived surface",
    afterEdit.sessions_logged === 3 && Math.max(0, ...(afterEdit.personal_records ?? []).map((r) => r.e1rm_kg ?? r.load_kg ?? 0)) < 500);

  // An edit goes through the SAME normalizer as the log route — it must not be a
  // back door around the bound Wave 162 added at the front door.
  await json("POST", "/api/session/update", { user_id: histId, session_id: "hist-bad",
    sets: [{ exercise: histEx, weight_kg: 999999, reps: 8, deload: true }] });
  const histEdited = ((await (await app.request("/api/sessions", histHdr)).json()).sessions ?? []).find((x) => x.session_id === "hist-bad");
  ok("#history an EDIT is bounded by the same ceiling as the original log (no back door)", histEdited.sets[0].weight_kg === 1000);
  ok("#history and the edit path preserves `deload`, the flag a whitelist once silently dropped", histEdited.sets[0].deload === true);

  // Emptying a session is a void, not an empty husk that still scores as a
  // trained day for the streak.
  await json("POST", "/api/session/update", { user_id: histId, session_id: "hist-bad", sets: [] });
  ok("#history clearing every set voids the session rather than leaving a husk that still counts",
    (await (await app.request("/api/progress", histHdr)).json()).sessions_logged === 2);

  const noSuch = await json("POST", "/api/session/void", { user_id: histId, session_id: "does-not-exist" });
  ok("#history voiding an unknown session 404s rather than silently succeeding", noSuch.status === 404);
  // Possession of a session_id must not be enough to touch someone else's log.
  const otherId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 2, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const crossRes = await json("POST", "/api/session/void", { user_id: otherId, session_id: "hist-good" });
  ok("#history another user cannot void a session they don't own (user_id is in the WHERE)", crossRes.status === 404);
  ok("#history and the owner's session is untouched by that attempt",
    (await (await app.request("/api/progress", histHdr)).json()).sessions_logged === 2);

  // ---- Wave 164: beginners graduate --------------------------------------
  // training_status was captured once at onboarding and changed by NOTHING, so a
  // beginner stayed on mev.min volume with no mesocycle, no deload EVER, no
  // accessory rotation and no volume tune — Goal 2's novice->Olympia arc failing
  // at its first transition. Driven through the real route, and asserted on the
  // GATES the status controls, not just the field itself (the field changing means
  // nothing if blockPhase and the tune don't follow it).
  const gradId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const gradHdr = { headers: { "X-HB-User": gradId } };
  const beforeGrad = await (await app.request("/api/today", gradHdr)).json();
  ok("#grad a beginner starts with no mesocycle at all — no wave, and no deload ever",
    beforeGrad.session.block == null && beforeGrad.session.beginner === true);
  const totalTarget = (plan) => Object.values(plan.rationale?.volume_by_muscle ?? {}).reduce((a, v) => a + (v.target_sets ?? 0), 0);
  const beginnerTarget = totalTarget(await (await app.request("/api/plan/explain", gradHdr)).json());

  // Log a real training age: distinct ISO weeks, twice a week, ending today. Dated
  // RELATIVE to now — /api/today reads the real clock for layoff/mesocycle logic.
  const gradEx = beforeGrad.session.exercises[0].exercise;
  for (let w = GRADUATION.intermediate.weeks; w > 0; w--) {
    for (let n = 0; n < 2; n++) {
      await json("POST", "/api/session", { user_id: gradId, session_id: `grad-${w}-${n}`,
        date: new Date(Date.now() - (w * 7 + n) * 86400000).toISOString(),
        sets: [...Array(3).fill({ exercise: gradEx, weight_kg: 60, reps: 8 })] });
    }
  }
  const afterGrad = await (await app.request("/api/today", gradHdr)).json();
  ok("#grad the promotion fires on /api/today once the training age is there",
    afterGrad.session.beginner === false);
  ok("#grad and it's ANNOUNCED as a win, not left to be discovered",
    /not a beginner any more/i.test(afterGrad.session.coach_note || ""));
  // The gates the status actually controls:
  ok("#grad the mesocycle now exists — so a deload will finally happen", afterGrad.session.block != null);
  ok("#grad the promotion starts a FRESH block, so the higher target ramps in via week 1 rather than landing whole",
    afterGrad.session.block.week === 1);
  const gradPlan = await (await app.request("/api/plan/explain", gradHdr)).json();
  ok("#grad the plan was regenerated at a genuinely HIGHER volume target (mev.min -> mav.min), not just relabelled",
    beginnerTarget > 0 && totalTarget(gradPlan) > beginnerTarget);
  ok("#grad the stored profile itself moved, not only the derived card", gradPlan.profile?.training_status === "intermediate");
  // Idempotence: a second call must not re-announce or re-reset the block.
  const secondCall = await (await app.request("/api/today", gradHdr)).json();
  ok("#grad a second /api/today doesn't re-promote or churn the block",
    secondCall.session.block.week === afterGrad.session.block.week);
  // Never demotes: an explicit Settings save to a HIGHER status must stick, and the
  // graduation check must not pull it back down to what the log alone has earned.
  await json("POST", "/api/plan/regenerate", { user_id: gradId, profile: { ...gradPlan.profile, training_status: "advanced" } });
  await (await app.request("/api/today", gradHdr)).json(); // give graduation a chance to (wrongly) pull it back
  const afterManual = await (await app.request("/api/plan/explain", gradHdr)).json();
  ok("#grad a user who sets a HIGHER status keeps it — graduation promotes, never demotes",
    afterManual.profile?.training_status === "advanced");

  // ---- Wave 166: regression ------------------------------------------------
  // A lifter going BACKWARDS was invisible: stallDetect structurally can't flag a
  // decline (it needs the window inside a 2.5% noise band), and once the pre-drop
  // weeks rolled out, the new lower level read as an ordinary plateau — whose
  // answer is +2 sets, to someone already failing to recover.
  const regId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 2, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const regHdr = { headers: { "X-HB-User": regId } };
  const regEx = (await (await app.request("/api/today", regHdr)).json()).session.exercises[0].exercise;
  // Peak for two weeks, then two weeks well below it — dated relative to now.
  const regPlan = [[5, 100], [4, 100], [2, 86], [1, 84]];
  for (const [wksAgo, kg] of regPlan) {
    await json("POST", "/api/session", { user_id: regId, session_id: `reg-${wksAgo}`,
      date: new Date(Date.now() - wksAgo * 7 * 86400000).toISOString(),
      sets: [...Array(3).fill({ exercise: regEx, weight_kg: kg, reps: 8 })] });
  }
  const regProg = await (await app.request("/api/progress", regHdr)).json();
  ok("#regress a sustained decline is reported end-to-end", (regProg.regressions ?? []).length === 1 && regProg.regressions[0].exercise === regEx);
  ok("#regress it quantifies the drop honestly rather than just labelling it", regProg.regressions[0].drop_pct >= 5);
  ok("#regress and it is NOT also called a plateau — a lift can't be both", (regProg.stalls ?? []).every((x) => x.exercise !== regEx));

  // The negative twin: identical shape, but recovered. Silence is the common case.
  const okId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 2, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const okHdr = { headers: { "X-HB-User": okId } };
  const okEx = (await (await app.request("/api/today", okHdr)).json()).session.exercises[0].exercise;
  for (const [wksAgo, kg] of [[5, 100], [4, 100], [2, 86], [1, 101]]) {
    await json("POST", "/api/session", { user_id: okId, session_id: `okr-${wksAgo}`,
      date: new Date(Date.now() - wksAgo * 7 * 86400000).toISOString(),
      sets: [...Array(3).fill({ exercise: okEx, weight_kg: kg, reps: 8 })] });
  }
  ok("#regress one bad week that bounced back is NOT flagged",
    ((await (await app.request("/api/progress", okHdr)).json()).regressions ?? []).length === 0);

  // ---- Wave 167: the block clock counts TRAINED weeks ----------------------
  // It used to be wall-clock, so a user who trained twice in six weeks still got
  // "Week 6 — deload", and `POST /api/pause` froze the streak and the emails but
  // not this — a deliberately paused user's block advanced through phases they
  // never trained. Driven through the real route, both directions.
  const clkProfile = {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  };
  const sparseId = (await json("POST", "/api/onboard", { profile: clkProfile })).data.user_id;
  await store.updateUser(sparseId, (u) => { u.plan_meta = { ...u.plan_meta, block_start: new Date(Date.now() - 45 * 86400000).toISOString(), block_index: 0 }; return u; });
  // Six-and-a-half calendar weeks in, having trained in only two of them.
  for (const d of [40, 26]) {
    await json("POST", "/api/session", { user_id: sparseId, session_id: `clk-${d}`, date: new Date(Date.now() - d * 86400000).toISOString(),
      sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 80, reps: 8 }] });
  }
  const sparseToday = await (await app.request("/api/today", { headers: { "X-HB-User": sparseId } })).json();
  ok("#clock a sporadic trainee gets no phantom deload — the block waits for the work",
    sparseToday.session.block.week === 3 && sparseToday.session.block.phase !== "deload");
  ok("#clock and the block never rotated, because six trained weeks never happened",
    (await store.getUser(sparseId)).plan_meta.block_index === 0);

  // The consistent lifter is completely unaffected — same calendar, real deload.
  const steadyId = (await json("POST", "/api/onboard", { profile: clkProfile })).data.user_id;
  await store.updateUser(steadyId, (u) => { u.plan_meta = { ...u.plan_meta, block_start: new Date(Date.now() - 40 * 86400000).toISOString(), block_index: 0 }; return u; });
  for (let w = 1; w <= 5; w++) {
    await json("POST", "/api/session", { user_id: steadyId, session_id: `stdy-${w}`, date: new Date(Date.now() - w * 7 * 86400000).toISOString(),
      sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 80, reps: 8 }] });
  }
  const steadyToday = await (await app.request("/api/today", { headers: { "X-HB-User": steadyId } })).json();
  ok("#clock a lifter who trains every week reaches the deload exactly on schedule",
    steadyToday.session.block.week === 6 && steadyToday.session.block.phase === "deload");

  // ---- Wave 168: cardio is prescribed, through the real doors --------------
  // The KB's numbers existed; nothing turned them into a prescription. Both routes
  // whitelist their payload, and a dropped field silently disables a whole surface
  // (the deload-flag bug this file exists for), so assert on BOTH.
  const cardId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 6, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const cardHdr = { headers: { "X-HB-User": cardId } };
  const cardToday = await (await app.request("/api/today", cardHdr)).json();
  ok("#cardio /api/today carries a real cardio prescription", (cardToday.session?.cardio?.steps_per_day?.min ?? 0) > 0);
  ok("#cardio it answers TODAY specifically, not just in general", typeof cardToday.session.cardio.hard_cardio_ok === "boolean");
  ok("#cardio the today answer agrees with the plan's own placement rule",
    cardToday.session.cardio.hard_cardio_ok === cardToday.session.cardio.placement.best_after.includes(cardToday.session.name));
  const cardPlan = await (await app.request("/api/plan/explain", cardHdr)).json();
  ok("#cardio the plan-explain whitelist carries it too (a dropped field kills the surface)",
    (cardPlan.program?.cardio?.sessions_per_week?.min ?? 0) > 0 && cardPlan.program.cardio.evidence_grade === "D");

  // ---- Wave 169: reporting an injury from inside a workout ------------------
  // app-design-spec.md described this reactive path and nothing implemented it: the
  // mid-session swap was generic, session-only, and never wrote anything down, so
  // the app could watch someone avoid the same lift weekly and never learn.
  const injId = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 4, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } })).data.user_id;
  const injHdr = { headers: { "X-HB-User": injId } };
  const beforeInj = await (await app.request("/api/exercises", injHdr)).json();
  ok("#injury a shoulder-contraindicated lift is offered before anything is reported",
    beforeInj.some((e) => e.movement_pattern === "vertical-push"));
  const injRes = await json("POST", "/api/profile/injury", { user_id: injId, region: "shoulder" });
  ok("#injury POST /api/profile/injury records it", injRes.status === 200 && injRes.data.injuries.some((x) => x.region === "shoulder"));
  const afterInj = await (await app.request("/api/exercises", injHdr)).json();
  ok("#injury and it takes effect immediately — vertical pressing is gone from the pickers",
    !afterInj.some((e) => e.movement_pattern === "vertical-push"));
  const injPlan = await (await app.request("/api/plan/explain", injHdr)).json();
  ok("#injury the PLAN was regenerated too, not just the picker",
    !injPlan.program.sessions.flatMap((x) => x.exercises).some((e) => beforeInj.find((b) => b.id === e.exercise)?.movement_pattern === "vertical-push"));
  const injUser = await store.getUser(injId);
  ok("#injury reporting pain does NOT reset the mesocycle — an injury shouldn't cost you your block",
    !!injUser.plan_meta.block_start && (injUser.plan_meta.block_index ?? 0) === 0);
  // Severity is only ever raised by a repeat report, never lowered.
  await json("POST", "/api/profile/injury", { user_id: injId, region: "shoulder", severity: "severe" });
  await json("POST", "/api/profile/injury", { user_id: injId, region: "shoulder", severity: "mild" });
  ok("#injury a repeat report can raise severity but never downgrades it",
    (await store.getUser(injId)).profile.injuries.find((x) => x.region === "shoulder").severity === "severe");
  const bogus = await json("POST", "/api/profile/injury", { user_id: injId, region: "left-earlobe" });
  ok("#injury an unknown region is rejected rather than stored forever, matching nothing", bogus.status === 400);
  // The two regions the engine could always filter and no user could ever pick.
  for (const region of ["neck", "ankle"]) {
    const r = await json("POST", "/api/profile/injury", { user_id: injId, region });
    ok(`#injury ${region} — filterable by the engine all along, now reportable`, r.status === 200);
  }

  // --- weigh-in trust boundary (Wave 174) ---------------------------------
  // A weigh-in is stored one-per-date and read newest-last, so a far-future date
  // becomes the permanently-latest weight: it drives the Fuel plan's current
  // weight, the trend and the energy-balance read forever — and can never be
  // corrected, because "log that date again" is the only correction path and no
  // calendar UI reaches the year 9999. /api/checkin already regex-validated the
  // identical field; /api/bodyweight passed it straight through.
  const bwGuard = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"],
  } })).data.user_id;
  const bwGuardToday = new Date().toISOString().slice(0, 10);
  await json("POST", "/api/bodyweight", { user_id: bwGuard, kg: 80, date: "9999-12-31" });
  const bwRows = await store.listBodyweights(bwGuard);
  ok("#bodyweight a far-future date is refused a permanent slot at the end of the series",
    bwRows.length === 1 && bwRows[0].date === bwGuardToday);
  await json("POST", "/api/bodyweight", { user_id: bwGuard, kg: 81, date: "not-a-date" });
  ok("#bodyweight garbage date falls back to today rather than 400ing away a queued offline weigh-in",
    (await store.listBodyweights(bwGuard)).every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date)));
  await json("POST", "/api/bodyweight", { user_id: bwGuard, kg: 5000 });
  ok("#bodyweight an impossible weight is bounded, not banked as the latest truth",
    (await store.listBodyweights(bwGuard)).every((b) => b.kg <= 500));
  // The SAME guard on the sibling door — /api/checkin writes a weigh-in too.
  await json("POST", "/api/checkin", { user_id: bwGuard, energy: 3, weight_kg: 9000, date: "9999-01-01" });
  const afterCheckin = await store.listBodyweights(bwGuard);
  ok("#bodyweight the check-in's weigh-in door applies the identical guard (lesson 1)",
    afterCheckin.every((b) => b.kg <= 500 && b.date <= bwGuardToday));
  // ...and the CHECK-IN ROW written from that same `b.date`, three lines earlier in the
  // same handler, which carried a format-only regex and no ceiling (Wave 186). It never
  // ages out of the 42-day block window recoverySignal averages, and one-row-per-date
  // means no UI can ever reach the date to correct it.
  const ckRows = await store.listCheckins(bwGuard);
  ok("#checkin a far-future check-in can't park itself permanently inside the block window",
    ckRows.length > 0 && ckRows.every((ck) => ck.date <= bwGuardToday));
  await json("POST", "/api/checkin", { user_id: bwGuard, energy: 4, date: "not-a-date" });
  ok("#checkin a garbage date still falls back to today rather than 400ing away a queued check-in",
    (await store.listCheckins(bwGuard)).every((ck) => /^\d{4}-\d{2}-\d{2}$/.test(ck.date)));
  // The THIRD door (Wave 178). The wave that added the guard grepped the ROUTE names,
  // found /api/bodyweight and /api/checkin, and wrote "both weigh-in doors" — but the
  // Fuel stats form reaches the same sink from a route whose name says nothing about
  // weight. Grep the sink, not the route.
  await json("POST", "/api/nutrition/profile", { user_id: bwGuard, height_cm: 180, weight_kg: 9000, date: "9999-12-31" });
  const afterFuel = await store.listBodyweights(bwGuard);
  ok("#bodyweight the THIRD door — the Fuel stats form — applies the identical guard",
    afterFuel.every((b) => b.kg <= 500 && b.date <= bwGuardToday));
  const fuelPlan = await json("POST", "/api/nutrition/profile", { user_id: bwGuard, height_cm: 180 });
  ok("#bodyweight ...and the Fuel plan that reads it still returns a sane current weight",
    !fuelPlan.data?.profile?.weight_kg || fuelPlan.data.profile.weight_kg <= 500);

  // --- injury sanitization on EVERY write path (Wave 174) ------------------
  // An unknown region isn't inert: it matches no contraindication rule, so it
  // filters nothing while the user believes they're being trained around it.
  const injGuard = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"],
    injuries: [{ region: "left-earlobe", severity: "catastrophic" }, { region: "knee", severity: "nonsense" }],
  } })).data.user_id;
  const injStored = (await store.getUser(injGuard)).profile.injuries;
  ok("#injury /api/onboard drops an unknown region instead of storing a filter that matches nothing",
    injStored.length === 1 && injStored[0].region === "knee");
  ok("#injury /api/onboard normalizes a junk severity, so the escalation ladder can still raise it",
    injStored[0].severity === "moderate");
  await json("POST", "/api/plan/regenerate", { user_id: injGuard, profile: {
    ...(await store.getUser(injGuard)).profile,
    injuries: [{ region: "not-a-body-part", severity: "mild" }, { region: "shoulder", severity: "severe" }],
  } });
  const injAfter = (await store.getUser(injGuard)).profile.injuries;
  ok("#injury /api/plan/regenerate sanitizes the wholesale profile spread too (lesson 1: every write path)",
    injAfter.length === 1 && injAfter[0].region === "shoulder" && injAfter[0].severity === "severe");


  // --- the personalization reaches the CLIENT (Wave 179) -------------------
  // Through the same door the plan screen uses. A pure explainer nobody serves is
  // exactly the producer-with-no-consumer shape (lesson 15).
  const pzUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 4, session_length_min: 60, available_equipment: ["dumbbell", "bodyweight"],
    priority_muscles: ["chest"],
  } })).data.user_id;
  const explain = await app.request("/api/plan/explain", { headers: { "X-HB-User": pzUser } });
  const pzData = await explain.json();
  ok("#personalization GET /api/plan/explain carries what the answers changed",
    Array.isArray(pzData.personalization) && pzData.personalization.length >= 4);
  ok("#personalization it names the priority answer and its actual weekly sets",
    pzData.personalization.some((x) => x.input === "priority_muscles" && /\d+ sets\/wk/.test(x.effect)));
  // The question is GONE from onboarding, so the profile must carry no explicit
  // answer — an explicit `false` would freeze the user out of the derivation.
  const pzProfile = (await store.getUser(pzUser)).profile;
  ok("#personalization onboarding stores NO specialization answer (it is derived now)",
    pzProfile.specialization === undefined);
  ok("#personalization ...and the derived block still ran (other muscles held at maintenance)",
    Object.values((await store.getUser(pzUser)).plan_rationale.volume_by_muscle).some((v) => v.maintenance));


  // --- the user's clock reaches the server for EVERY user (Wave 180) -------
  // tz_offset_min used to be written only by POST /api/push/subscribe, so Wave 173's
  // timezone work was inert for anyone who never enabled notifications — while its
  // tests passed because the fixtures supplied the field.
  const tzUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"],
  } })).data.user_id;
  ok("#tz a fresh account has no stored clock (nothing has told us one yet)",
    (await store.getUser(tzUser)).profile.tz_offset_min === undefined);
  await app.request("/api/today", { headers: { "X-HB-User": tzUser, "X-HB-TZ": "-420" } });
  ok("#tz GET /api/today captures it from the header — no push subscription involved",
    (await store.getUser(tzUser)).profile.tz_offset_min === -420);
  await app.request("/api/today", { headers: { "X-HB-User": tzUser, "X-HB-TZ": "-480" } });
  ok("#tz a changed offset (DST, or the user moved) is re-captured on the next open",
    (await store.getUser(tzUser)).profile.tz_offset_min === -480);
  for (const bad of ["abc", "99999", ""]) {
    await app.request("/api/today", { headers: { "X-HB-User": tzUser, "X-HB-TZ": bad } });
  }
  ok("#tz a junk or out-of-range header never clobbers a good stored value",
    (await store.getUser(tzUser)).profile.tz_offset_min === -480);
  // The header is not the only door. A profile PUT spreads `body.profile` wholesale,
  // so the canonical validator has to be applied there too (Wave 186) — and it matters
  // MORE there: the hourly push sweep and settleChallenge read the stored value with no
  // request to re-derive from, so an absurd-but-finite offset has no self-heal path.
  await json("POST", "/api/plan/regenerate", { user_id: tzUser, profile: { tz_offset_min: 1e12 } });
  ok("#tz an absurd offset posted through the profile door is rejected, not stored",
    (await store.getUser(tzUser)).profile.tz_offset_min === null);
  await json("POST", "/api/plan/regenerate", { user_id: tzUser, profile: { tz_offset_min: -300 } });
  ok("#tz ...while a real offset posted the same way is still accepted",
    (await store.getUser(tzUser)).profile.tz_offset_min === -300);
  const prog = await (await app.request("/api/progress", { headers: { "X-HB-User": tzUser, "X-HB-TZ": "-480" } })).json();
  ok("#tz /api/progress accepts the frame and still answers", !prog.error);

  // The frame MIGRATION hazard, stated honestly: the first time a clock is captured,
  // week keys stamped in the old UTC frame start being compared in the local one. A
  // commitment stamped this week must still read as this week for a west-of-UTC user.
  const cmUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"],
  } })).data.user_id;
  await json("POST", "/api/commitment", { user_id: cmUser, days: ["mon", "wed"] });
  await app.request("/api/today", { headers: { "X-HB-User": cmUser, "X-HB-TZ": "-480" } });
  const tzAdh = await (await app.request("/api/adherence", { headers: { "X-HB-User": cmUser, "X-HB-TZ": "-480" } })).json();
  ok("#tz a commitment stamped before the clock was known survives the frame change",
    Array.isArray(tzAdh.commitment?.days) && tzAdh.commitment.days.length === 2);
  // ...including the FUTURE-skew direction, constructed deterministically: a stamp
  // whose week reads LATER than the viewer's frame (tz captured after a save near
  // the boundary). The natural version of this only occurs in the early-Monday
  // window, which is exactly when the old equality read failed in production runs
  // and every other wall clock left this branch unreached (lesson 54) — so the
  // skew is seeded directly rather than waited for. Ordinal rule: not-yet-past
  // is current (lesson 40; the ambiguous direction must be inert).
  await store.updateUser(cmUser, (u) => { u.profile.commitment = { week: isoWeekKeyLocal(Date.now() + 7 * 86400000, -480), days: ["fri"] }; return u; });
  const tzAdh2 = await (await app.request("/api/adherence", { headers: { "X-HB-User": cmUser, "X-HB-TZ": "-480" } })).json();
  ok("#tz a future-skewed commitment stamp reads as CURRENT, never silently unset",
    Array.isArray(tzAdh2.commitment?.days) && tzAdh2.commitment.days[0] === "fri");

  // ...and the CHALLENGE equivalent, which the last iteration recorded as an unverified
  // hypothesis and this one reproduced: a week key stamped in one frame, read in another,
  // used to settle a live challenge because the comparison was `!==` (different) rather
  // than `>` (passed). Simulated directly by rewriting the stored week key to the UTC
  // frame the pre-clock stamp would have produced, then reading it back.
  const chA = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"],
  } })).data.user_id;
  const chB = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"],
  } })).data.user_id;
  // A REAL opponent share token: with none, settleChallenge's `|| !opponentId` branch
  // (the opponent-vanished path) fires regardless of the week, so the fixture would
  // never exercise the week comparison at all. Caught by the test failing first.
  const chBShare = (await json("POST", "/api/share", { user_id: chB })).data.share_id;
  const skewWeek = (wk) => { const [y, w] = wk.split("-W"); return `${y}-W${String(Number(w) + 1).padStart(2, "0")}`; };
  await store.updateUser(chA, (u) => {
    const cur = isoWeekKeyLocal(Date.now(), -480);
    u.profile = { ...u.profile, tz_offset_min: -480, challenge: {
      id: "skew-1", role: "opponent", status: "pending", week: skewWeek(cur),
      partner_token: chBShare, created_at: Date.now(),
    } };
    return u;
  });
  const chRead = await (await app.request("/api/challenge", { headers: { "X-HB-User": chA, "X-HB-TZ": "-480" } })).json();
  ok("#tz a challenge whose stored week reads as the FUTURE (frame skew) is not settled",
    chRead.challenge?.status === "pending" && chRead.week_over === false);

  // --- Tier-1 #3 (Wave 201): the celebration marker is stamped at the SESSION DOOR
  // and the new-follower count at the FOLLOW door — tested through the same HTTP
  // surface the client uses, never by feeding the helpers directly. ---
  const celU = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"],
  } })).data.user_id;

  // First-ever session: the [1] milestone is the top event.
  await json("POST", "/api/session", { user_id: celU, session_id: "cel-1", date: dAgo(3),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 }] });
  const celP1 = (await store.getUser(celU)).profile.celebration;
  ok("#celebrate the first session stamps the [1] milestone marker at the session door",
    celP1?.kind === "milestone" && celP1.count === 1 && celP1.session_id === "cel-1" && typeof celP1.at === "number");

  // A REPLAYED offline POST (same session_id) must not re-arm a delivered marker.
  await store.updateUser(celU, (u) => { u.profile = { ...u.profile, celebration: { ...u.profile.celebration, pushed: true } }; return u; });
  await json("POST", "/api/session", { user_id: celU, session_id: "cel-1", date: dAgo(3),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 }] });
  ok("#celebrate a replayed session POST never re-arms a pushed marker",
    (await store.getUser(celU)).profile.celebration.pushed === true);

  // Second session, heavier: a PR (2 sessions is no milestone, same-week no streak).
  await json("POST", "/api/session", { user_id: celU, session_id: "cel-2", date: dAgo(2),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 110, reps: 10 }] });
  const celP2 = (await store.getUser(celU)).profile.celebration;
  ok("#celebrate a heavier second session stamps a PR marker", celP2?.kind === "pr" && celP2.session_id === "cel-2" && celP2.pushed !== true);

  // The lesson-27 edit: correcting the fat-fingered weight DOWN un-earns the PR.
  await json("POST", "/api/session/update", { user_id: celU, session_id: "cel-2",
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 }] });
  const celP3 = (await store.getUser(celU)).profile.celebration;
  ok("#celebrate correcting the celebrated weight down re-earns (here: clears) the marker", celP3 == null || celP3.session_id !== "cel-2");

  // Voiding the celebrated session clears its pending celebration outright.
  await json("POST", "/api/session", { user_id: celU, session_id: "cel-3", date: dAgo(1),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 120, reps: 10 }] });
  ok("#celebrate fixture sanity: the third session re-arms a PR marker", (await store.getUser(celU)).profile.celebration?.session_id === "cel-3");
  await json("POST", "/api/session/void", { user_id: celU, session_id: "cel-3" });
  ok("#celebrate voiding the celebrated session clears its pending marker", (await store.getUser(celU)).profile.celebration == null);

  // --- Wave 203: the corrected weight that un-earns a pending celebration can live
  // in a PRIOR session, not the celebrated one — a typo'd 10 kg makes the next real
  // session a fabricated "PR"; correcting the typo must take the praise back too. ---
  const celV = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"],
  } })).data.user_id;
  await json("POST", "/api/session", { user_id: celV, session_id: "celv-1", date: dAgo(3),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 10, reps: 10 }] }); // fat-fingered: meant 100
  await json("POST", "/api/session", { user_id: celV, session_id: "celv-2", date: dAgo(2),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 95, reps: 10 }] });
  ok("#celebrate fixture sanity: beating the typo'd weight arms a PR marker",
    (await store.getUser(celV)).profile.celebration?.kind === "pr" && (await store.getUser(celV)).profile.celebration?.session_id === "celv-2");
  await json("POST", "/api/session/update", { user_id: celV, session_id: "celv-1",
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 }] });
  const celV1 = (await store.getUser(celV)).profile.celebration;
  ok("#celebrate correcting a PRIOR session's typo un-earns the fabricated pending PR", celV1?.kind !== "pr");

  // Same class through the void door: a pending "[3] sessions" milestone must not
  // survive voiding an OLDER session that drops the count below the milestone.
  await json("POST", "/api/session", { user_id: celV, session_id: "celv-3", date: dAgo(1),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 90, reps: 10 }] });
  ok("#celebrate fixture sanity: the third session arms the [3] milestone marker",
    (await store.getUser(celV)).profile.celebration?.kind === "milestone" && (await store.getUser(celV)).profile.celebration?.count === 3);
  await json("POST", "/api/session/void", { user_id: celV, session_id: "celv-1" });
  const celV2 = (await store.getUser(celV)).profile.celebration;
  ok("#celebrate voiding an OLDER session takes back the stale count-milestone praise", celV2?.kind !== "milestone");

  // --- Wave 206: the MERGE door also rewrites history under a pending marker —
  // sessions the merge brings in can refute a "PR" armed against the survivor's
  // shorter pre-merge history (lesson 47's dependency set, third door), and a
  // pending echo on the merged-away device must follow the user instead of dying
  // with the deleted row. Full magic-link merge flow, same as #15. ---
  const celMProfile = { units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell"] };
  const celTo = (await json("POST", "/api/onboard", { profile: celMProfile })).data.user_id;
  const celFrom = (await json("POST", "/api/onboard", { profile: celMProfile })).data.user_id;
  // The anonymous (merged-away) device holds the HEAVIER history…
  await json("POST", "/api/session", { user_id: celFrom, session_id: "celm-b1", date: dAgo(40),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 120, reps: 10 }] });
  await json("POST", "/api/session", { user_id: celFrom, session_id: "celm-b2", date: dAgo(35),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 125, reps: 10 }] });
  // …while the survivor arms a "PR" that is only a PR against its own short history.
  await json("POST", "/api/session", { user_id: celTo, session_id: "celm-a1", date: dAgo(9),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await json("POST", "/api/session", { user_id: celTo, session_id: "celm-a2", date: dAgo(2),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 70, reps: 10 }] });
  ok("#celebrate-merge fixture sanity: the survivor's second session arms a PR marker",
    (await store.getUser(celTo)).profile.celebration?.kind === "pr");
  const celLinkTo = await requestMagicLink(store, { email: "celmerge@t.com", anonUserId: celTo });
  await json("POST", "/api/auth/consume", { token: celLinkTo.token });
  const celLinkFrom = await requestMagicLink(store, { email: "celmerge@t.com", anonUserId: celFrom });
  const celGrant = (await json("POST", "/api/auth/consume", { token: celLinkFrom.token })).data.merge_grant;
  const celMergeRes = await app.request("/api/auth/merge", {
    method: "POST", headers: { "content-type": "application/json", "X-HB-User": celFrom },
    body: JSON.stringify({ grant: celGrant, from_user_id: celFrom, to_user_id: celTo }),
  });
  ok("#celebrate-merge the merge itself succeeds", (await celMergeRes.json()).merged === true);
  ok("#celebrate-merge a 'PR' the merged-in history refutes is not left pending as a PR",
    (await store.getUser(celTo)).profile.celebration?.kind !== "pr");

  // The other direction: the pending echo lives on the merged-away device and the
  // survivor has none — it must follow the user, and it still holds because the
  // combined history doesn't refute it.
  const celTo2 = (await json("POST", "/api/onboard", { profile: celMProfile })).data.user_id;
  const celFrom2 = (await json("POST", "/api/onboard", { profile: celMProfile })).data.user_id;
  await json("POST", "/api/session", { user_id: celFrom2, session_id: "celm-d1", date: dAgo(10),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 60, reps: 10 }] });
  await json("POST", "/api/session", { user_id: celFrom2, session_id: "celm-d2", date: dAgo(2),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 80, reps: 10 }] });
  ok("#celebrate-merge fixture sanity: the merged-away device holds a pending PR marker",
    (await store.getUser(celFrom2)).profile.celebration?.kind === "pr");
  const celLinkTo2 = await requestMagicLink(store, { email: "celmerge2@t.com", anonUserId: celTo2 });
  await json("POST", "/api/auth/consume", { token: celLinkTo2.token });
  const celLinkFrom2 = await requestMagicLink(store, { email: "celmerge2@t.com", anonUserId: celFrom2 });
  const celGrant2 = (await json("POST", "/api/auth/consume", { token: celLinkFrom2.token })).data.merge_grant;
  await app.request("/api/auth/merge", {
    method: "POST", headers: { "content-type": "application/json", "X-HB-User": celFrom2 },
    body: JSON.stringify({ grant: celGrant2, from_user_id: celFrom2, to_user_id: celTo2 }),
  });
  const celAdopted = (await store.getUser(celTo2)).profile.celebration;
  ok("#celebrate-merge a pending echo follows the user through the merge and still holds",
    celAdopted?.kind === "pr" && !celAdopted?.pushed);

  // New-follower event: the follow door bumps the OWNER's monotonic count once —
  // a re-follow is not a new follower.
  const folOwner = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "female", training_status: "beginner", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 45, available_equipment: ["dumbbell"],
  } })).data.user_id;
  const folShare = (await json("POST", "/api/share", { user_id: folOwner })).data.share_id;
  await json("POST", "/api/following", { user_id: celU, token: folShare });
  ok("#follower a new follow bumps the owner's followers_count", (await store.getUser(folOwner)).profile.followers_count === 1);
  await json("POST", "/api/following", { user_id: celU, token: folShare });
  ok("#follower re-following is idempotent — no second event", (await store.getUser(folOwner)).profile.followers_count === 1);
  await json("POST", "/api/following/remove", { user_id: celU, token: folShare });
  await json("POST", "/api/following", { user_id: celU, token: folShare });
  ok("#follower unfollow → refollow is a genuine new-follower event again", (await store.getUser(folOwner)).profile.followers_count === 2);

  // --- server-owned profile fields: ENUMERABLE, at every wholesale door -------
  // Not "we strip the sensitive one" in a comment — this walks the whole exported
  // set through BOTH doors that accept a client-supplied profile object. A field
  // added to the set without a guard fails here; a guard removed fails here; a
  // THIRD wholesale door added later is caught by the door census below.
  // Reachable by any client: auth is possession-of-UUID, so "attacker" means
  // "anyone with their own account", and the damage lands on OTHER users
  // (a forged `following` entry watches a share whose owner is never told).
  const forged = {
    celebration: { kind: "pr", at: 1 }, freeze_pushed_week: "2026-W01", comeback_push: { stage: 3 },
    commitment: { week: "2026-W01", days: ["mon"] },
    following: ["forged-share-token"], followers_count: 999, followers_pushed: 999,
    cheers_pushed: 999, cheers_seen: 999,
    partner_nudge: { at: 1 }, nudge_pushed_at: 1, nudge_seen_at: 1,
    challenges: Array.from({ length: 50 }, (_, i) => ({ id: `forged-${i}`, week: "2026-W01", partner_token: "x", status: "open" })),
    challenge: { id: "forged", week: "2026-W01" },
    challenge_pushed_at: 1, challenge_accept_pushed_at: 1,
    disclaimer_ack: { v: 99, at: "1970-01-01T00:00:00.000Z" },
    smoke: true,
  };
  // The fixture must COVER the set — otherwise this test silently shrinks the day
  // someone adds a field (the "green gate proves only what it measures" trap).
  ok("#owned the forged fixture covers every server-owned field",
    [...SERVER_OWNED_PROFILE_FIELDS].every((k) => Object.hasOwn(forged, k))
    && Object.keys(forged).every((k) => SERVER_OWNED_PROFILE_FIELDS.has(k)));

  // DOOR 1 — onboard. An account must not be BORN holding forged state.
  const ownedOnboard = await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
    ...forged,
  } });
  const ownedU = ownedOnboard.data.user_id;
  const bornProfile = (await store.getUser(ownedU)).profile;
  const leakedAtOnboard = [...SERVER_OWNED_PROFILE_FIELDS].filter((k) => k !== "disclaimer_ack" && bornProfile[k] !== undefined);
  ok("#owned POST /api/onboard strips every server-owned field", leakedAtOnboard.length === 0);
  // disclaimer_ack is the one field the server REPLACES rather than drops: the
  // stamp must be the server's own, never the client's forged v99.
  ok("#owned onboard stamps its OWN disclaimer_ack over the posted one",
    bornProfile.disclaimer_ack?.v === 1 && bornProfile.disclaimer_ack?.at !== "1970-01-01T00:00:00.000Z");

  // DOOR 2 — plan/regenerate (the Settings save). Same set, same result.
  const realAck = bornProfile.disclaimer_ack;
  await json("POST", "/api/plan/regenerate", { user_id: ownedU, profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
    ...forged,
  } });
  const patchedProfile = (await store.getUser(ownedU)).profile;
  const leakedAtPatch = [...SERVER_OWNED_PROFILE_FIELDS].filter((k) => k !== "disclaimer_ack" && patchedProfile[k] !== undefined);
  ok("#owned POST /api/plan/regenerate strips every server-owned field", leakedAtPatch.length === 0);
  ok("#owned a settings save cannot forge or replace the acknowledgement stamp",
    JSON.stringify(patchedProfile.disclaimer_ack) === JSON.stringify(realAck));
  // The concrete harm, asserted rather than described: the forged follow must not
  // be readable back as a partner, and the forged 50 slots must not have become
  // challenge state that every sweep tick then pays for.
  const forgedFollowing = await app.request("/api/following", { headers: { "X-HB-User": ownedU } });
  ok("#owned a forged `following` never becomes a real partner",
    ((await forgedFollowing.json()).partners ?? []).length === 0);
  ok("#owned a forged `challenges` array never becomes challenge state",
    challengeSlotsT(patchedProfile).length === 0);

  // The door census: this test can only be as good as its list of doors, so assert
  // the list. `body.profile` reaching a spread is what makes a door wholesale —
  // if a third one appears, this count changes and someone has to look (lesson 33:
  // the enumerable check, not the confident comment).
  const appSrc = await (await import("node:fs/promises")).readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  ok("#owned there are exactly TWO wholesale client->profile doors, both guarded",
    (appSrc.match(/stripServerOwnedProfile\(/g) ?? []).length === 2
    && !/\.\.\.body\.profile|\{ \.\.\.body\.profile \}/.test(appSrc));

  // --- the timing-quarantine repair path, through the real door ---------------
  const qOn = await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
  } });
  const qU = qOn.data.user_id;
  const qSet = [{ exercise: "barbell-back-squat", weight_kg: 100, reps: 5, set_type: "work" }];
  // Two ordinary sessions on the SAME day, logged in order, plus a legacy row with
  // an unparseable date written straight to the store (no route can create one
  // any more — that is the whole point of the write-door normalization).
  // The SAME instant for both, so this is a genuine tie — the case the ordering
  // regression is about. Two calls to Date.now() are milliseconds apart and would
  // sort themselves, quietly testing nothing.
  const qTie = new Date(Date.now() - 3 * 86400000).toISOString();
  await json("POST", "/api/session", { user_id: qU, session_id: "q-day-a", date: qTie, sets: qSet });
  await json("POST", "/api/session", { user_id: qU, session_id: "q-day-b", date: qTie, sets: qSet });
  await store.addSession(qU, { session_id: "q-broken", date: "", session_name: "Legacy", sets: qSet });

  const qList = await app.request("/api/sessions", { headers: { "X-HB-User": qU } });
  const qRows = (await qList.json()).sessions;
  // The route's own comment promises the cap can never hide a row the user needs
  // in order to make it safe again. Sorting by `date` — the field whose invalidity
  // caused the quarantine — buried exactly the malformed ones.
  ok("#tq a row with an unparseable date is pinned FIRST, not sorted by the broken field",
    qRows[0]?.session_id === "q-broken" && qRows[0]?.time_quarantine === "invalid-date");
  ok("#tq quarantined rows are marked, ordinary rows are not",
    qRows.filter((r) => r.time_quarantine).length === 1);
  const dayA = qRows.findIndex((r) => r.session_id === "q-day-a");
  const dayB = qRows.findIndex((r) => r.session_id === "q-day-b");
  ok("#tq same-day siblings stay newest-first (a stable sort on `date` alone flips them)", dayB < dayA);

  // The quarantined row must be invisible to every derivation, and visible only here.
  const qAdh = await app.request("/api/adherence", { headers: { "X-HB-User": qU } });
  ok("#tq the quarantined row reaches no derived surface",
    (await qAdh.json()).sessions_logged === 2);

  // The repair, in a FAR-EAST frame: the client's picker offers the user's local
  // tomorrow, so the server must judge in that frame or the only exit from
  // quarantine is a dead end. Send the header this client always sends.
  // A far-east client, sending the header it always sends. The date it submits is
  // the ceiling the picker now computes — the SERVER's rule, not the device's local
  // tomorrow. Submitting device-local tomorrow is what the pre-fix client did, and
  // it is asserted separately below as the thing that must be refused honestly.
  const eastTz = String(13 * 60);
  const serverCeiling = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const deviceLocalTomorrow = new Date(Date.now() + 13 * 3600000 + 86400000).toISOString().slice(0, 10);
  const fixRes = await app.request("/api/session/update", {
    method: "POST", headers: { "content-type": "application/json", "X-HB-TZ": eastTz },
    body: JSON.stringify({ user_id: qU, session_id: "q-broken", corrected_local_date: serverCeiling }),
  });
  ok("#tq a correction at the server's own ceiling is accepted", fixRes.status === 200);
  const fixedRow = (await store.listSessions(qU, { includeVoided: true, includeQuarantined: true })).find((x) => x.session_id === "q-broken");
  ok("#tq the corrected day is STORED as the day chosen, not silently re-stamped as now",
    fixedRow?.local_date === serverCeiling && String(fixedRow?.date).slice(0, 10) === serverCeiling);
  // THE assertion the original version of this test was missing, and the reason the
  // half-fix shipped: it checked only `status === 200`. A repair that the read path
  // then re-quarantines is worse than an honest refusal — the user is told "it now
  // counts toward your trends" over a row that still counts for nothing. Re-read
  // through the same door the client uses.
  const afterFix = await app.request("/api/sessions", { headers: { "X-HB-User": qU, "X-HB-TZ": eastTz } });
  const afterRows = (await afterFix.json()).sessions;
  const repaired = afterRows.find((r) => r.session_id === "q-broken");
  ok("#tq the repaired row is NO LONGER quarantined when read back", repaired && !repaired.time_quarantine);
  ok("#tq ...and it now reaches derived coaching",
    (await (await app.request("/api/adherence", { headers: { "X-HB-User": qU } })).json()).sessions_logged === 3);

  // THE INVARIANT, submitted the way the PRE-FIX client did: a far-east device's
  // own local tomorrow. Whatever the door decides, the two outcomes are (a) an
  // honest refusal, or (b) acceptance AND a row the read path genuinely accepts.
  // What must never happen is the third: accepted, announced as fixed, and still
  // quarantined — which is precisely what shipped.
  //
  // Honest limitation, stated rather than papered over: this can only DISTINGUISH
  // the outcomes when the UTC hour is late enough that a +13h device's tomorrow
  // differs from the server's ceiling (roughly the second half of the UTC day).
  // The route computes `Date.now()` internally, so making it hour-independent
  // would need clock injection into the route. The structural guarantee lives in
  // session-time.mjs — one ceiling function, no per-caller frame — and the PIN
  // there fails if anyone re-introduces one.
  await store.addSession(qU, { session_id: "q-broken-3", date: "", session_name: "Legacy 3", sets: qSet });
  const tomorrowRes = await app.request("/api/session/update", {
    method: "POST", headers: { "content-type": "application/json", "X-HB-TZ": eastTz },
    body: JSON.stringify({ user_id: qU, session_id: "q-broken-3", corrected_local_date: deviceLocalTomorrow }),
  });
  if (tomorrowRes.status === 200) {
    const rows = (await (await app.request("/api/sessions", { headers: { "X-HB-User": qU } })).json()).sessions;
    const row = rows.find((r) => r.session_id === "q-broken-3");
    ok("#tq a date the door ACCEPTS is never left quarantined by the read path", row && !row.time_quarantine);
  } else {
    ok("#tq a date past the ceiling is refused honestly rather than accepted-then-quarantined",
      tomorrowRes.status === 400 && (await tomorrowRes.json()).error === "bad-date");
  }

  // ...and a genuinely impossible date is still refused, with a distinguishable
  // error the client can turn into truthful copy instead of "check your connection".
  await store.addSession(qU, { session_id: "q-broken-2", date: "", session_name: "Legacy 2", sets: qSet });
  const farFuture = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  const badRes = await app.request("/api/session/update", {
    method: "POST", headers: { "content-type": "application/json", "X-HB-TZ": eastTz },
    body: JSON.stringify({ user_id: qU, session_id: "q-broken-2", corrected_local_date: farFuture }),
  });
  ok("#tq an impossible date is refused as `bad-date`, not as a network failure",
    badRes.status === 400 && (await badRes.json()).error === "bad-date");

  // --- the activation funnel, and who may mark themselves as noise -------------
  // A user row is created ONLY by POST /api/onboard, which is also what every prod
  // smoke test calls — so the app's headline activation ratio counts an unknown
  // amount of the loop's own traffic. Owner traffic now tags itself; nobody else can.
  const funnelApp = createApp(createFileStore(join(tmpdir(), `hb-stats-test-${process.pid}.json`)), { statsKey: "s3cret" });
  const sJson = async (url, body, headers = {}) => {
    const res = await funnelApp.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const P = { units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const realU = (await sJson("/api/onboard", { profile: P })).data.user_id;
  const liarU = (await sJson("/api/onboard", { profile: { ...P, smoke: true } })).data.user_id;   // self-declared
  const smokeU = (await sJson("/api/onboard", { profile: P }, { "X-HB-Stats-Key": "s3cret" })).data.user_id;
  const funnelRes = await funnelApp.request("/api/stats", { headers: { "X-HB-Stats-Key": "s3cret" } });
  const st = await funnelRes.json();
  ok("#funnel only the owner's key can mark a row as smoke traffic", st.smoke_users === 1, `smoke_users=${st.smoke_users}`);
  ok("#funnel a client that DECLARES itself smoke is not believed", st.users_total === 3 && st.users_unclassified === 2);
  ok("#funnel onboarded-but-never-trained counts REAL users, with the raw figure beside it",
    st.onboarded_never_trained === 2 && st.onboarded_never_trained_raw === 3);
  ok("#funnel activation_rate is 0 before anyone trains", st.activation_rate === 0);
  ok("#funnel time-to-first-session is null while nobody has one (never a fabricated 0)",
    st.days_to_first_session_median === null && st.days_to_first_session_n === 0);

  await sJson("/api/session", { user_id: realU, session_id: "fn-1", date: new Date().toISOString(), sets: [{ exercise: "barbell-back-squat", weight_kg: 100, reps: 5, set_type: "work" }] });
  const st2 = await (await funnelApp.request("/api/stats", { headers: { "X-HB-Stats-Key": "s3cret" } })).json();
  // INVERTED. This used to assert `activation_rate ≈ 1/3` over 3 users of which one
  // was the key-minted smoke row — i.e. it locked the contamination IN, in the very
  // wave whose purpose was to remove it. The real users are 2 (one trained), so the
  // rate is 1/2; the contaminated figure stays visible as `_raw` so the
  // decontamination can be checked rather than trusted.
  ok("#funnel the activation rate EXCLUDES smoke rows from both sides",
    st2.users_with_session === 1 && st2.onboarded_never_trained === 1
    && Math.abs(st2.activation_rate - 1 / 2) < 1e-9);
  ok("#funnel ...and the contaminated figure is still reported, labelled raw",
    Math.abs(st2.activation_rate_raw - 1 / 3) < 1e-9 && st2.onboarded_never_trained_raw === 2);
  ok("#funnel a same-day activation reports a real lag, not null",
    st2.days_to_first_session_n === 1 && st2.days_to_first_session_median != null);
  // The other side of the same contamination: a prod smoke usually DOES log a
  // session, so a smoke row must leave the NUMERATOR as well. Without this the
  // rate would climb every time the owner smoke-tests a deploy.
  await sJson("/api/session", { user_id: smokeU, session_id: "fn-smoke-1", date: new Date().toISOString(), sets: [{ exercise: "barbell-back-squat", weight_kg: 100, reps: 5, set_type: "work" }] });
  const st3 = await (await funnelApp.request("/api/stats", { headers: { "X-HB-Stats-Key": "s3cret" } })).json();
  ok("#funnel a smoke row that TRAINS does not inflate the activation rate",
    st3.users_with_session === 2 && Math.abs(st3.activation_rate - 1 / 2) < 1e-9,
    );
  ok("#funnel ...while the raw figure moves, showing exactly what was excluded",
    Math.abs(st3.activation_rate_raw - 2 / 3) < 1e-9);
  ok("#funnel the stats route stays owner-only", (await funnelApp.request("/api/stats")).status === 404);
  void liarU; void smokeU;

  // --- `sex` moved from onboarding to the Fuel form ---------------------------
  // It has zero references in the training engine and only ever drove the body-fat
  // formula, under onboarding copy claiming it "sets sensible starting points".
  // Onboard WITHOUT sex — which is what the client now sends, since the step is
  // gone. (`obProfile` still carries it, so it can't be reused here.)
  const { sex: _obSex, ...obNoSex } = obProfile;
  const sxU = (await json("POST", "/api/onboard", { profile: obNoSex })).data.user_id;
  ok("#sex onboarding succeeds without it, and stores nothing",
    !!sxU && (await store.getUser(sxU)).profile.sex === undefined);

  // The female Navy formula NEEDS the hip measure — without it the estimate is null
  // and this test would pass for the wrong reason (lesson 54).
  await json("POST", "/api/nutrition/profile", { user_id: sxU, sex: "female", height_cm: 165, weight_kg: 62, neck_cm: 31, waist_cm: 70, hip_cm: 95 });
  const sxProfile = (await store.getUser(sxU)).profile;
  ok("#sex the Fuel form can set it", sxProfile.sex === "female");
  const sxFuel = await (await app.request("/api/nutrition", { headers: { "X-HB-User": sxU } })).json();
  ok("#sex ...and the estimate is computed from the FEMALE formula", sxFuel.sex === "female" && sxFuel.has_bf === true);
  // Cross-check it is really the female branch: the male formula on the same
  // numbers gives a materially different figure, so an unknown sex is not
  // silently equivalent.
  const { navyBodyFat } = await import("../../tools/nutrition-core.mjs");
  const asFemale = navyBodyFat({ sex: "female", height_cm: 165, neck_cm: 31, waist_cm: 70, hip_cm: 95 });
  const asMale = navyBodyFat({ sex: "male", height_cm: 165, neck_cm: 31, waist_cm: 70, hip_cm: 95 });
  ok("#sex the two formulas genuinely differ, so the branch matters", Math.abs(asFemale - asMale) > 5);

  // Boundary: an unknown value is dropped, not stored.
  await json("POST", "/api/nutrition/profile", { user_id: sxU, sex: "not-a-sex" });
  ok("#sex an unknown value is refused and leaves the stored one intact", (await store.getUser(sxU)).profile.sex === "female");

  // The enum must not drift from the schema it claims to follow.
  const sexSchema = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../../data/schemas/onboarding-profile.schema.json", import.meta.url), "utf8"));
  const routeSrc = await (await import("node:fs/promises")).readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  ok("#sex the route's accepted values match the schema's enum exactly",
    sexSchema.properties.sex.enum.every((v) => routeSrc.includes(`"${v}"`))
    && (routeSrc.match(/const SEX_VALUES = new Set\(\[([^\]]*)\]\)/)?.[1].split(",").length === sexSchema.properties.sex.enum.length));

  // A settings save must not WIPE it. `/api/plan/regenerate` merges by spread, so a
  // client sending `sex: undefined` would overwrite the stored value with undefined
  // — the exact trap that bites users who answered before the question moved.
  await json("POST", "/api/plan/regenerate", { user_id: sxU, profile: { ...obNoSex } });
  ok("#sex a settings save that omits it leaves the stored value alone",
    (await store.getUser(sxU)).profile.sex === "female");

  // --- the SECONDARY_SERVED tier reaches the Progress surface (Wave 240) --------
  // The tier shipped in the generator and the critique — and Progress kept saying
  // "add volume / add sets" for the very muscles the plan screen calls "covered by
  // compounds" (the third consumer, missed: lesson 15's producer/renderer sweep at
  // surface scope). One user, three surfaces, two answers.
  const ss3U = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 4, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  // Log a week that credits the erectors only through compounds (an RDL), leaving
  // them far below the direct-work MEV — the exact state the tier calls fine.
  await json("POST", "/api/session", { user_id: ss3U, session_id: "ss3-1", date: dAgo(2),
    sets: Array.from({ length: 3 }, () => ({ exercise: "romanian-deadlift", set_type: "work", weight_kg: 80, reps: 8 })) });
  const ss3P = await (await app.request("/api/progress", { headers: { "X-HB-User": ss3U } })).json();
  const ss3Row = (ss3P.volumeByMuscle ?? []).find((r) => r.id === "spinal-erectors");
  ok("#SS3 Progress shows 'covered by compounds' for erectors, never 'add volume'",
    !!ss3Row && ss3Row.status === "secondary-served");
  ok("#SS3 ...and the adaptive advice never says 'add sets' for a tier muscle",
    !(ss3P.adaptive ?? []).some((a) => (a.muscle === "spinal-erectors" || a.muscle === "forearms") && a.signal === "add"));

  // --- history + trends payloads (Wave 252, owner: "look back at past weights,
  // calories… and edit them; graphs for progress") -------------------------------
  const htU = (await json("POST", "/api/onboard", { profile: { training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  for (const [n, kg] of [[3, 82.5], [2, 82.2], [1, 82.4]]) await json("POST", "/api/bodyweight", { user_id: htU, kg, date: day(n) });
  for (const [n, kcal] of [[2, 2400], [1, 2500]]) await json("POST", "/api/nutrition/log", { user_id: htU, date: day(n), kcal });
  const htP = await (await app.request("/api/progress", { headers: { "X-HB-User": htU } })).json();
  ok("#HT /api/progress ships the raw weigh-in series for the graph + edit list",
    Array.isArray(htP.bodyweight_series) && htP.bodyweight_series.length === 3
    && htP.bodyweight_series.some((b) => b.date === day(2) && b.kg === 82.2));
  const htN = await (await app.request(`/api/nutrition?d=${day(0)}`, { headers: { "X-HB-User": htU } })).json();
  ok("#HT /api/nutrition ships the daily intake log", Array.isArray(htN.log) && htN.log.length === 2 && htN.log.some((e) => e.date === day(1) && e.kcal === 2500));
  // Editing IS the existing replace-by-date door — prove the round trip for both.
  await json("POST", "/api/bodyweight", { user_id: htU, kg: 81.9, date: day(2) });
  await json("POST", "/api/nutrition/log", { user_id: htU, date: day(1), kcal: 2100 });
  const htP2 = await (await app.request("/api/progress", { headers: { "X-HB-User": htU } })).json();
  const htN2 = await (await app.request("/api/nutrition", { headers: { "X-HB-User": htU } })).json();
  ok("#HT a past day EDITS in place — no duplicate rows, the new value shows",
    htP2.bodyweight_series.filter((b) => b.date === day(2)).length === 1
    && htP2.bodyweight_series.find((b) => b.date === day(2)).kg === 81.9
    && htN2.log.filter((e) => e.date === day(1)).length === 1
    && htN2.log.find((e) => e.date === day(1)).kcal === 2100);
  ok("#HT strength trend rows carry their series through the route",
    (htP2.progression ?? []).every((p) => !p.weeks || Array.isArray(p.series)));

  // --- never_trained rides the /api/today payload (Wave 235) --------------------
  // The client's first-timer greeting gated on day_number === 1, which derives
  // from the FILTERED session list — so a user whose only workout is quarantined
  // (History is showing them "Date needs correcting" right now) was still greeted
  // "👋 First workout?". The payload now carries the unfiltered truth end to end.
  const ntU = (await json("POST", "/api/onboard", { profile: { training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  const ntFresh = (await (await app.request(`/api/today`, { headers: { "X-HB-User": ntU } })).json()).session;
  ok("#never_trained true for a genuinely fresh user", ntFresh.never_trained === true);
  await store.addSession(ntU, { session_id: "nt-q1", date: "", sets: [] }); // unparseable date → quarantined
  const ntAfter = (await (await app.request(`/api/today`, { headers: { "X-HB-User": ntU } })).json()).session;
  ok("#never_trained false once ANY session exists, even a quarantined one (while day_number still reads 1)",
    ntAfter.never_trained === false && ntAfter.day_number === 1);

  // --- The emailed plan resolves CUSTOM exercise names (Wave 235) ---------------
  // The magic-link mail renders the user's week; a custom lift resolved through
  // exerciseById alone ships as its raw slug. The History route already states the
  // rule ("include custom exercises, or a user's own lift would show as a raw slug
  // on the one screen where they have to recognise it") — the mail is such a screen.
  const sentMail = [];
  const mailApp = createApp(store, { sendEmail: async (m) => { sentMail.push(m); return { ok: true }; } });
  const mailU = (await json("POST", "/api/onboard", { profile: { training_status: "beginner", primary_goal: "hypertrophy", days_per_week: 3, available_equipment: ["bodyweight"] } })).data.user_id;
  await store.updateUser(mailU, (u) => {
    u.custom_exercises = [{ id: "custom-my-fly", name: "My Cable Fly" }];
    u.program.sessions[0].exercises[0] = { exercise: "custom-my-fly", sets: 3, rep_range: "8-12" };
    return u;
  });
  await mailApp.request("/api/auth/request", { method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "10.99.99.99" },
    body: JSON.stringify({ email: "plan-names@t.com", user_id: mailU }) });
  const mailNames = (sentMail.at(-1)?.plan?.sessions ?? []).flatMap((sn) => sn.exercises.map((e) => e.name));
  ok("#the emailed plan resolves a CUSTOM lift's name, not its raw slug",
    mailNames.includes("My Cable Fly") && !mailNames.includes("custom-my-fly"));

  console.log(`\n${pass} route test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
