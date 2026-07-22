// Comeback-nudge tests: the pure stage decision AND the sweep against the real
// file store (so listAccountLastSessions + the nudge-state writeback are
// covered too). Dates are relative to a fixed `now` passed in — no Date.now.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../src/store.mjs";
import { comebackStage, runComebackSweep, NUDGE_STAGE_1_DAYS, NUDGE_STAGE_2_DAYS } from "../src/nudge.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name)); };

const NOW = +new Date("2026-07-01T16:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

// --- pure decision ---
ok("fresh trainer (2 days) is left alone", comebackStage({ lastSessionAt: daysAgo(2), now: NOW }) === null);
ok("4-day lapse → stage 1", comebackStage({ lastSessionAt: daysAgo(4), now: NOW })?.stage === 1);
ok("stage 1 fires ONCE per lapse", comebackStage({ lastSessionAt: daysAgo(6), nudge: { for_session_at: daysAgo(6), stage: 1 }, now: NOW }) === null);
ok("14-day lapse → stage 2 even after stage 1", comebackStage({ lastSessionAt: daysAgo(15), nudge: { for_session_at: daysAgo(15), stage: 1 }, now: NOW })?.stage === 2);
ok("after stage 2 the lapse goes silent forever", comebackStage({ lastSessionAt: daysAgo(40), nudge: { for_session_at: daysAgo(40), stage: 2 }, now: NOW }) === null);
ok("training again resets the lapse (new anchor, old nudge state ignored)", comebackStage({ lastSessionAt: daysAgo(5), nudge: { for_session_at: daysAgo(30), stage: 2 }, now: NOW })?.stage === 1);
ok("paused users are NEVER emailed (the pause card's promise)", comebackStage({ lastSessionAt: daysAgo(20), paused: true, now: NOW }) === null);
ok("reminders_off is a hard opt-out", comebackStage({ lastSessionAt: daysAgo(20), remindersOff: true, now: NOW }) === null);
ok("never-trained users are not email targets", comebackStage({ lastSessionAt: null, now: NOW }) === null);
ok("stage thresholds are what the copy promises", NUDGE_STAGE_1_DAYS === 4 && NUDGE_STAGE_2_DAYS === 14);

// --- sweep against the real file store ---
const path = join(tmpdir(), `hb-nudge-test-${process.pid}.json`);
const store = createFileStore(path);
try {
  await store.saveUser("lapsed", { profile: {} });
  await store.saveUser("active", { profile: {} });
  await store.saveUser("optout", { profile: { reminders_off: true } });
  await store.saveUser("pausedu", { profile: {}, paused: { from: daysAgo(3) } });
  await store.addSession("lapsed", { session_id: "l1", date: daysAgo(5), sets: [] });
  await store.addSession("active", { session_id: "a1", date: daysAgo(1), sets: [] });
  await store.addSession("optout", { session_id: "o1", date: daysAgo(9), sets: [] });
  await store.addSession("pausedu", { session_id: "p1", date: daysAgo(9), sets: [] });
  for (const [em, id] of [["lapsed@t.com", "lapsed"], ["active@t.com", "active"], ["optout@t.com", "optout"], ["paused@t.com", "pausedu"]])
    await store.saveAccount(em, id, new Date(NOW).toISOString());

  const sent = [];
  const fakeSend = async (msg) => { sent.push(msg); return { dev: true, ok: true }; };

  const forU = (em) => sent.filter((m) => m.email === em);
  const r1 = await runComebackSweep(store, fakeSend, NOW);
  ok("sweep emails exactly the lapsed+opted-in user", r1.sent === 1 && sent.length === 1 && sent[0].email === "lapsed@t.com" && sent[0].stage === 1);
  const r2 = await runComebackSweep(store, fakeSend, NOW);
  ok("re-running the sweep (cron retry) sends NOTHING new", r2.sent === 0 && sent.length === 1);
  await runComebackSweep(store, fakeSend, NOW + 11 * 86400000); // lapsed's lapse now 16 days (active lapses too by now — filtered per-email below)
  ok("day 16 escalates the same lapse to stage 2, once", forU("lapsed@t.com").length === 2 && forU("lapsed@t.com")[1].stage === 2);
  await runComebackSweep(store, fakeSend, NOW + 40 * 86400000);
  ok("after stage 2 the sweep stays silent for that lapse", forU("lapsed@t.com").length === 2);
  ok("opted-out and paused users never got a single email across every sweep", forU("optout@t.com").length === 0 && forU("paused@t.com").length === 0);

  await store.addSession("lapsed", { session_id: "l2", date: daysAgo(-41), sets: [] }); // they came back (day 41)!
  await runComebackSweep(store, fakeSend, NOW + 46 * 86400000); // 5 days after the comeback session
  ok("a comeback session starts a fresh lapse cycle (stage 1 again)", forU("lapsed@t.com").length === 3 && forU("lapsed@t.com")[2].stage === 1);

  const failSend = async () => ({ dev: false, ok: false });
  await store.saveUser("failcase", { profile: {} });
  await store.addSession("failcase", { session_id: "f1", date: daysAgo(5), sets: [] });
  await store.saveAccount("fail@t.com", "failcase", new Date(NOW).toISOString());
  await runComebackSweep(store, failSend, NOW);
  ok("a FAILED send is not marked sent (next sweep retries)", (await store.getUser("failcase")).nudge == null);

  console.log(`\n${pass} nudge test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
} finally {
  try { rmSync(path); } catch {}
}
process.exit(fail ? 1 : 0);
