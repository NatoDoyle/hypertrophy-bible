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

  // #21: local_date must round-trip through the /api/session whitelist (the
  // deload-flag lesson: a silently dropped field disables its whole pipeline).
  const ldUser = (await json("POST", "/api/onboard", { profile: obProfile })).data.user_id;
  await json("POST", "/api/session", { user_id: ldUser, session_id: "ld-1", date: dayAgo(0), local_date: "2026-07-23", sets: [{ exercise: "push-up", set_type: "work", reps: 10 }] });
  const ldStored = (await store.listSessions(ldUser)).find((s) => s.session_id === "ld-1");
  ok("#21 local_date round-trips through the session whitelist", ldStored?.local_date === "2026-07-23");

  // #21: resuming a pause archives the window (the streak's neutral weeks survive)
  await json("POST", "/api/pause", { user_id: ldUser, on: true });
  await json("POST", "/api/pause", { user_id: ldUser, on: false });
  const ldAfter = await store.getUser(ldUser);
  ok("#21 pause resume archives the window into pause_history", Array.isArray(ldAfter.pause_history) && ldAfter.pause_history.length === 1 && !!ldAfter.pause_history[0].to);

  console.log(`\n${pass} route test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
