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

  // A new mesocycle auto-rotates accessories through the real route.
  await store.updateUser(uid, (u) => {
    u.plan_meta = { ...u.plan_meta, block_start: new Date(Date.now() - 43 * 86400000).toISOString(), block_index: 0 };
    return u;
  });
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
  ok("cosmetic edit does not re-rotate accessories", postIds === preIds && !postMeta.rotated_at);

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
  // 5 weekly FLAT bench sessions (identical e1RM → stalled), recent so no layoff.
  for (let w = 0; w < 5; w++) await json("POST", "/api/session", { user_id: atUser, session_id: `at-${w}`, date: dayAgo(35 - w * 7),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] });
  const chestBefore = (await store.getUser(atUser)).plan_rationale?.volume_by_muscle?.chest?.target_sets;
  // backdate block_start so a mesocycle boundary has passed → /api/today rotates + auto-tunes
  await store.updateUser(atUser, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(43), block_index: 0 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": atUser } });
  const atAfter = await store.getUser(atUser);
  ok("#2 auto-tune records a positive volume_adjust for a stalled muscle", (atAfter.plan_meta?.volume_adjust?.chest ?? 0) > 0);
  ok("#2 the new block's chest target increased from the adaptive bump", atAfter.plan_rationale?.volume_by_muscle?.chest?.target_sets > chestBefore);

  // Increment A (recovery-aware tune) through the SAME door the client uses: the
  // identical stall, but logged under persistent under-recovery, must NOT bump volume.
  // Guards the block-boundary wiring (check-ins + hoisted bodyweights threaded into the
  // tune) — a stall you can't recover is a recovery problem, not a volume one.
  const rgUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  for (let w = 0; w < 5; w++) await json("POST", "/api/session", { user_id: rgUser, session_id: `rg-${w}`, date: dayAgo(35 - w * 7),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] });
  // 5 low daily check-ins across the block → block-average readiness ~2/5 → under-recovered
  for (let d = 0; d < 5; d++) await json("POST", "/api/checkin", { user_id: rgUser, date: dayAgo(30 - d * 6).slice(0, 10), sleep_quality: 2, energy: 2, stress: 4, mood: 2, motivation: 2 });
  await store.updateUser(rgUser, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(43), block_index: 0 }; return u; });
  await app.request("/api/today", { headers: { "X-HB-User": rgUser } });
  const rgAfter = await store.getUser(rgUser);
  ok("#A under-recovery suppresses the volume bump through /api/today (recovery-aware tune wired at the block boundary)", (rgAfter.plan_meta?.volume_adjust?.chest ?? 0) === 0);

  // Wave 69 (audit A/B): the recovery gate reads only the CURRENT block, not the whole
  // history. The same stall, but the only low check-ins are a long-ago rough patch
  // OUTSIDE the 6-week block window — they must NOT drag a lifetime average down and
  // suppress the bump the recent (check-in-free) block earned. Before the fix, these
  // eight old lows made underRecovered=true and held chest at 0.
  const woUser = (await json("POST", "/api/onboard", { profile: {
    units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy",
    days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } })).data.user_id;
  for (let w = 0; w < 5; w++) await json("POST", "/api/session", { user_id: woUser, session_id: `wo-${w}`, date: dayAgo(35 - w * 7),
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 8 }] });
  for (let d = 0; d < 8; d++) await json("POST", "/api/checkin", { user_id: woUser, date: dayAgo(120 - d * 7).slice(0, 10), sleep_quality: 1, energy: 1, stress: 5, mood: 1, motivation: 1 });
  await store.updateUser(woUser, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(43), block_index: 0 }; return u; });
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

  // #23: push subscribe/unsubscribe round-trip through the real routes
  const pushSub = { endpoint: "https://fcm.googleapis.com/fcm/send/route-test", keys: { p256dh: "pk", auth: "ak" } };
  const subRes = await json("POST", "/api/push/subscribe", { user_id: ldUser, subscription: pushSub });
  ok("#23 push subscribe stores the subscription", subRes.status === 200 && (await store.listPushSubscriptions()).some((s) => s.endpoint === pushSub.endpoint && s.user_id === ldUser));
  const badSub = await json("POST", "/api/push/subscribe", { user_id: ldUser, subscription: { endpoint: "http://insecure" } });
  ok("#23 a non-https endpoint is rejected", badSub.status === 400);
  await json("POST", "/api/push/unsubscribe", { endpoint: pushSub.endpoint });
  ok("#23 unsubscribe removes it", !(await store.listPushSubscriptions()).some((s) => s.endpoint === pushSub.endpoint));

  // #21: resuming a pause archives the window (the streak's neutral weeks survive)
  await json("POST", "/api/pause", { user_id: ldUser, on: true });
  await json("POST", "/api/pause", { user_id: ldUser, on: false });
  const ldAfter = await store.getUser(ldUser);
  ok("#21 pause resume archives the window into pause_history", Array.isArray(ldAfter.pause_history) && ldAfter.pause_history.length === 1 && !!ldAfter.pause_history[0].to);

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
  // log ~2 weeks of intake with a slight weight drop -> adaptive basis kicks in
  for (let d = 0; d < 12; d++) {
    const day = new Date(Date.UTC(2026, 5, 1 + d)).toISOString().slice(0, 10);
    await json("POST", "/api/bodyweight", { user_id: nUser, kg: 85 - d * 0.03, date: day });
    await json("POST", "/api/nutrition/log", { user_id: nUser, date: day, kcal: 2800 });
  }
  const afterLog = await json("POST", "/api/nutrition/log", { user_id: nUser, date: "2026-06-13", kcal: 2800 });
  ok("#43 the daily intake log accumulates and re-derives maintenance from data",
    afterLog.data.logged === true && afterLog.data.logged_days >= 10 && afterLog.data.nutrition.tdee_basis === "logged");
  const badKcal = await json("POST", "/api/nutrition/log", { user_id: nUser, kcal: -5 });
  ok("#43 a nonsense intake is rejected", badKcal.status === 400);
  // #51: GET /api/nutrition?d= returns today's logged total (intake-vs-target loop)
  await json("POST", "/api/nutrition/log", { user_id: nUser, date: "2026-06-30", kcal: 2650, protein_g: 175 });
  const withToday = await (await app.request("/api/nutrition?d=2026-06-30", { headers: { "X-HB-User": nUser } })).json();
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
  ok("#share public GET returns the card", pub.status === 200 && typeof pub.data.streak_weeks === "number" && typeof pub.data.level === "number" && typeof pub.data.sessions_logged === "number");
  ok("#share public card leaks NO PII (allowlist only: streak_weeks/level/sessions_logged/cheers)",
    Object.keys(pub.data).every((k) => ["streak_weeks", "level", "sessions_logged", "cheers"].includes(k)) &&
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
  ok("#cheer the card still leaks NO PII with cheers added", Object.keys(card2.data).every((k) => ["streak_weeks", "level", "sessions_logged", "cheers"].includes(k)) && !JSON.stringify(card2.data).includes(uid));
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

  console.log(`\n${pass} route test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
