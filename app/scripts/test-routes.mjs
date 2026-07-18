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
  const s1 = await json("POST", "/api/session", { user_id: uid, session_id: "rt-1", date: "2026-06-01T18:00:00Z",
    sets: [{ exercise: "barbell-bench-press", set_type: "work", weight_kg: 100, reps: 10 }] });
  ok("work session accepted", s1.status === 200);
  const s2 = await json("POST", "/api/session", { user_id: uid, session_id: "rt-2", date: "2026-06-08T18:00:00Z",
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

  console.log(`\n${pass} route test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
