// Unit tests for the pure session-player logic (public/session-core.mjs) — the
// crash-safety-critical parts of the superset "station". Exists because that logic
// is DOM-coupled in app.js and can't be reached by the route tests, yet a mistake
// there silently DROPS an exercise (a superset partner that sits non-adjacent to
// its pair would be skipped by the post-station advance). These tests replay the
// player's exact control flow over the pure helpers and assert every exercise gets
// trained the right number of times, in a sane order, across a mid-session resume.
import assert from "node:assert";
import { orderSupersetAdjacent, loggedWorkSets, nextUnfinishedIndex, stationProgress, dropDelivered, checkSetPR, checkLuckySet, isLuckySet, rankPartners, weeklyRaceStatus, formatWeekLabel, isImplausibleSet, unconfirmedFlagged, IMPLAUSIBLE_RATIO, IMPLAUSIBLE_MIN_JUMP_KG, sanitizeTypedValue, convertDispWeight, normalizeWeightsToUnits, replaceSlot, PRESCRIPTION_KEYS,
  restLength, restRemaining, activeRest, formatRest, adjustRest, newRest,
  sessionChips, editLoggedSet, editDisplay, parseEdit, recomputePrLatch, editConfirmKey, resolveEdit, nextPrLatch, undoApplies,
  loadForReps, nextSetHint, buildTargets, skipSet, skipRound, undoSkip, skipWouldFinish, hintInUnit, prefillInUnit, localReadout, restAlertStep, REST_ALERT_HANDOFF_MS, todayTopSet, typoReference, tiredSets, easeKg, easeSlot, tiredOffer, anchorSets, EMPTY_BAR_KG, tiredSwapRow, swapInRow } from "../public/session-core.mjs";
// Node-only import (this test runs under Node, not the browser) — used ONLY to prove
// the client's checkSetPR duplicate agrees with the server's real engine, never to
// import it into the shipped client code.
import { priorPersonalBests, checkSetPR as checkSetPRServer, detectPersonalRecords, isLuckySet as isLuckySetServer, luckySetsInSession, loadForReps as loadForRepsServer } from "../../tools/derive-core.mjs";
// Burst 5's new exports are read through the namespaces, so a missing one fails its own check
// instead of failing the whole file at import.
import * as playerCore from "../public/session-core.mjs";
import * as serverCore from "../../tools/derive-core.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + "\n      " + e.message); } };

const ex = (exercise, sets, superset_with) => ({ exercise, sets, rep_range: "10-15", rir: "0-2", ...(superset_with ? { superset_with } : {}) });

// A faithful, DOM-free replay of the player's progression using ONLY the pure
// helpers app.js calls. Returns the ordered log of {exercise} work sets and the
// order exercises were first touched. `resumeAfter` (optional) throws away all
// in-memory position after that many logged sets and recomputes from the log —
// exactly what a crash + loadSess does — proving progress is log-derived.
function playSession(rawEx) {
  const exs = orderSupersetAdjacent(rawEx);
  const logged = [];
  const touchOrder = [];
  const bank = (idx) => {
    logged.push({ exercise: exs[idx].exercise, set_type: "work" });
    if (!touchOrder.includes(exs[idx].exercise)) touchOrder.push(exs[idx].exercise);
  };
  let i = 0, guard = 0;
  while (i >= 0 && i < exs.length) {
    if (++guard > 1000) throw new Error("progression did not terminate (infinite loop)");
    const e = exs[i];
    const pIdx = e.superset_with ? exs.findIndex((x) => x.exercise === e.superset_with) : -1;
    if (pIdx >= 0) {
      const L = Math.min(i, pIdx), P = Math.max(i, pIdx);
      const sp = stationProgress(logged, exs, L, P);
      if (!sp.done) { bank(L); bank(P); continue; }        // a round: both members
      // paired rounds done → finish the longer member's remainder, else advance
      const remL = exs[L].sets - loggedWorkSets(logged, exs[L].exercise);
      const remP = exs[P].sets - loggedWorkSets(logged, exs[P].exercise);
      if (remL > 0) { bank(L); continue; }
      if (remP > 0) { bank(P); continue; }
      const nx = nextUnfinishedIndex(logged, exs, Math.max(L, P));
      i = nx; continue;
    }
    if (loggedWorkSets(logged, e.exercise) < e.sets) { bank(i); continue; }
    i = nextUnfinishedIndex(logged, exs, i);
  }
  return { logged, touchOrder, exs };
}

const setCount = (logged, id) => logged.filter((l) => l.exercise === id).length;
// every exercise trained EXACTLY its target set count — none dropped, none doubled
function assertFullyTrained(rawEx) {
  const { logged, exs } = playSession(rawEx);
  for (const e of exs) assert.equal(setCount(logged, e.exercise), e.sets, `${e.exercise} expected ${e.sets} sets, got ${setCount(logged, e.exercise)}`);
  return { logged, exs };
}

// --- orderSupersetAdjacent (pure) ---
check("no superset → array returned unchanged", () => {
  const a = [ex("squat", 3), ex("bench", 3)];
  assert.deepEqual(orderSupersetAdjacent(a), a);
});
check("already-adjacent pair is left as-is", () => {
  const a = [ex("squat", 3), ex("lat-raise", 2, "crossover"), ex("crossover", 2, "lat-raise")];
  assert.deepEqual(orderSupersetAdjacent(a).map((e) => e.exercise), ["squat", "lat-raise", "crossover"]);
});
check("NON-adjacent pair: partner pulled up next to its leader (the plank-drop guard)", () => {
  // the real Lower session shape: calf[.] <-> leg-ext[.] with plank BETWEEN them
  const a = [ex("split-squat", 2), ex("calf", 2, "leg-ext"), ex("plank", 2), ex("leg-ext", 2, "calf")];
  assert.deepEqual(orderSupersetAdjacent(a).map((e) => e.exercise), ["split-squat", "calf", "leg-ext", "plank"]);
});
check("dangling link (partner absent) → unchanged, no throw", () => {
  const a = [ex("squat", 3), ex("calf", 2, "leg-ext-that-was-trimmed")];
  assert.deepEqual(orderSupersetAdjacent(a), a);
});

// --- full-session replay: nothing dropped, nothing doubled ---
check("equal adjacent pair: both members fully trained", () => {
  assertFullyTrained([ex("dip", 2), ex("lat-raise", 2, "crossover"), ex("crossover", 2, "lat-raise")]);
});
check("NON-adjacent pair: the between-exercise (plank) is NOT dropped", () => {
  const { logged } = assertFullyTrained([ex("split-squat", 2), ex("calf", 2, "leg-ext"), ex("plank", 2), ex("leg-ext", 2, "calf")]);
  assert.equal(setCount(logged, "plank"), 2); // the whole point
});
check("unequal pair (1 vs 2 sets): 1 paired round + 1 remainder, both fully trained", () => {
  // the real Full-Body-A shape: cable-lateral-raise sets=1 <-> cable-crossover sets=2
  const { logged } = assertFullyTrained([ex("goblet", 2), ex("lat-raise", 1, "crossover"), ex("crossover", 2, "lat-raise")]);
  assert.equal(setCount(logged, "lat-raise"), 1);
  assert.equal(setCount(logged, "crossover"), 2);
});
check("station order: a round logs BOTH members before either repeats", () => {
  const { logged } = playSession([ex("lat-raise", 2, "crossover"), ex("crossover", 2, "lat-raise")]);
  // first two entries are the two distinct members (round 1), next two are round 2
  assert.deepEqual(logged.slice(0, 2).map((l) => l.exercise).sort(), ["crossover", "lat-raise"]);
  assert.deepEqual(logged.slice(2, 4).map((l) => l.exercise).sort(), ["crossover", "lat-raise"]);
});

// --- stationProgress / resume ---
check("stationProgress derives round & done from banked sets", () => {
  const exs = [ex("lat-raise", 2, "crossover"), ex("crossover", 2, "lat-raise")];
  assert.deepEqual(stationProgress([], exs, 0, 1), { paired: 2, round: 0, done: false });
  const oneRound = [{ exercise: "lat-raise", set_type: "work" }, { exercise: "crossover", set_type: "work" }];
  assert.deepEqual(stationProgress(oneRound, exs, 0, 1), { paired: 2, round: 1, done: false });
  const bothRounds = [...oneRound, ...oneRound];
  assert.equal(stationProgress(bothRounds, exs, 0, 1).done, true);
});
check("resume mid-station recomputes position from the log (crash-safe)", () => {
  // simulate: one full round banked, then everything in-memory is thrown away.
  const exs = orderSupersetAdjacent([ex("split-squat", 2), ex("calf", 2, "leg-ext"), ex("plank", 2), ex("leg-ext", 2, "calf")]);
  // pretend the user did split-squat x2, then ONE superset round (calf+leg-ext), then the phone died
  const logged = [
    { exercise: "split-squat", set_type: "work" }, { exercise: "split-squat", set_type: "work" },
    { exercise: "calf", set_type: "work" }, { exercise: "leg-ext", set_type: "work" },
  ];
  // on resume the station for (calf@1, leg-ext@2) must still owe round 2
  const sp = stationProgress(logged, exs, 1, 2);
  assert.deepEqual(sp, { paired: 2, round: 1, done: false });
  // and plank must still be pending
  assert.equal(loggedWorkSets(logged, "plank") < 2, true);
});
check("migration edge: an OLD non-adjacent session resumed by new code drops nothing", () => {
  // Model a session started BEFORE the adjacency reorder shipped: the pair is left
  // non-adjacent (calf@1 <-> leg-ext@3, plank@2 between). New station code finishes
  // the pair, then MUST advance to the first unfinished exercise anywhere (scan from
  // -1), not just after the pair — otherwise plank@2 is jumped over and lost.
  const exs = [ex("split-squat", 2), ex("calf", 2, "leg-ext"), ex("plank", 2), ex("leg-ext", 2, "calf")]; // NOT reordered
  const logged = [];
  const bank = (id) => logged.push({ exercise: id, set_type: "work" });
  bank("split-squat"); bank("split-squat");
  // run the station for the non-adjacent pair (indices 1 and 3)
  while (!stationProgress(logged, exs, 1, 3).done) { bank("calf"); bank("leg-ext"); }
  // the fixed advance: first unfinished anywhere
  const nx = nextUnfinishedIndex(logged, exs, -1);
  assert.equal(exs[nx].exercise, "plank"); // NOT undefined / -1 — plank is still owed
});
check("pathological: OLD non-adjacent pair with UNEQUAL sets still drops nothing", () => {
  // The nastiest carry-over: old build (no reorder), pair non-adjacent, and the
  // LATER member is the longer one — so a "route to the remainder member then scan
  // forward" rule would jump past the between-exercise. The earliest-unfinished rule
  // must keep all three trained. calf@1(1 set) <-> legext@3(2 sets), plank@2 between.
  const exs = [ex("split", 1), ex("calf", 1, "legext"), ex("plank", 1), ex("legext", 2, "calf")];
  const logged = [];
  const bank = (id) => logged.push({ exercise: id, set_type: "work" });
  const owed = (id) => { const e = exs.find((x) => x.exercise === id); return e.sets - loggedWorkSets(logged, id); };
  bank("split");
  // one paired round (station logs both), calf now satisfied, legext still owes 1
  bank("calf"); bank("legext");
  // now the unified advance rule: first unfinished anywhere, repeatedly, to the end
  let guard = 0;
  let nx = nextUnfinishedIndex(logged, exs, -1);
  while (nx >= 0) { if (++guard > 100) throw new Error("loop"); bank(exs[nx].exercise); nx = nextUnfinishedIndex(logged, exs, -1); }
  assert.equal(owed("split"), 0);
  assert.equal(owed("calf"), 0);
  assert.equal(owed("plank"), 0); // the between-exercise survived
  assert.equal(owed("legext"), 0); // and the longer member's remainder was finished
});
check("#8-2 a defer that lands on an already-finished exercise never logs a phantom set", () => {
  // OLD-build non-adjacent superset A(3)<->B(2) with M(2) between, then C(2). Run the
  // A+B station to completion (B done@2, A done@3); the player advances to M. The user
  // taps "Do this later" on M → it splices to the end ([A,B,C,M]) and the cursor stays
  // put, now pointing at B, which is ALREADY fully logged. renderPlayer's self-heal
  // guard must skip B (never render "Done — set 3 of 2") and resolve to the first lift
  // still owing sets — exactly nextUnfinishedIndex(logged, ex, -1).
  const exs = [ex("A", 3, "B"), ex("M", 2), ex("B", 2, "A"), ex("C", 2)]; // NOT reordered (old build)
  const logged = [];
  const bank = (id) => logged.push({ exercise: id, set_type: "work" });
  const owed = (id) => { const e = exs.find((x) => x.exercise === id); return e.sets - loggedWorkSets(logged, id); };
  while (!stationProgress(logged, exs, 0, 2).done) { bank("A"); bank("B"); } // 2 paired rounds
  bank("A"); // A's remaining 3rd set
  assert.equal(owed("A"), 0); assert.equal(owed("B"), 0);
  // defer M (cursor idx 1): splice to the end, cursor stays at idx 1 → now points at B
  const [moved] = exs.splice(1, 1); exs.push(moved);
  let cursor = 1;
  // the guard: parked on a fully-logged exercise → jump to the first still owing sets
  if (loggedWorkSets(logged, exs[cursor].exercise) >= exs[cursor].sets) cursor = nextUnfinishedIndex(logged, exs, -1);
  assert.notEqual(exs[cursor].exercise, "B");  // never parked on the finished partner
  assert.ok(owed(exs[cursor].exercise) > 0);   // lands on a lift that still owes sets
  let guard = 0;
  while (cursor >= 0) { if (++guard > 100) throw new Error("loop"); bank(exs[cursor].exercise); cursor = nextUnfinishedIndex(logged, exs, -1); }
  assert.equal(loggedWorkSets(logged, "B"), 2); // B stayed at exactly 2 — no phantom 3rd set
  assert.equal(owed("C"), 0); assert.equal(owed("M"), 0); // and everything else finished cleanly
});
check("#UX-6 mid-station unlink: both ex-members finish exactly, nothing lost or doubled", () => {
  // The busy-machine escape hatch: after 1 of 2 paired rounds, the user unlinks
  // (superset_with cleared on both). The ordinary path must then resume each
  // member from its banked count and finish the session with exact set totals.
  const exs = [ex("A", 2, "B"), ex("B", 2, "A"), ex("C", 2)];
  const logged = [];
  const bank = (id) => logged.push({ exercise: id, set_type: "work" });
  bank("A"); bank("B"); // one paired round
  // unlink (what the station's Unlink button does)
  for (const m of exs) { if (m.superset_with) { delete m.superset_with; } }
  // land on the first member still owing sets — A (1 of 2 banked)
  let cursor = loggedWorkSets(logged, "A") < 2 ? 0 : 1;
  assert.equal(exs[cursor].exercise, "A");
  assert.equal(loggedWorkSets(logged, exs[cursor].exercise), 1); // resumes at set 2, not set 1
  // ordinary progression to the end
  let guard = 0;
  while (cursor >= 0) { if (++guard > 100) throw new Error("loop"); bank(exs[cursor].exercise); cursor = nextUnfinishedIndex(logged, exs, -1); }
  for (const m of exs) assert.equal(loggedWorkSets(logged, m.exercise), m.sets); // exact totals: 2/2/2
});
check("offline queue: two tabs flushing the same item never drop an UNdelivered workout", () => {
  // The data-loss bug: two tabs both flush on reconnect; position-based slice(1)
  // could drop item B that no tab delivered. filter-by-id can only remove the
  // delivered item. Trace: queue [A,B]; tab2 delivers A and removes it; tab1 (which
  // also delivered A) re-reads [B] and removes id 'a' → B survives.
  const A = { id: "a", path: "/api/session", body: "{}" };
  const B = { id: "b", path: "/api/session", body: "{}" };
  let queue = [A, B];
  queue = dropDelivered(queue, "a"); // tab2 after delivering A
  queue = dropDelivered(queue, "a"); // tab1 after delivering A, re-reading the queue
  assert.deepEqual(queue.map((x) => x.id), ["b"]); // B (undelivered) preserved
  // and delivering B removes exactly B, leaving the queue empty
  assert.deepEqual(dropDelivered(queue, "b"), []);
});
check("warm-up sets never count toward a target", () => {
  const logged = [{ exercise: "dip", set_type: "warmup" }, { exercise: "dip", set_type: "work" }];
  assert.equal(loggedWorkSets(logged, "dip"), 1);
});

check("#45 optional ramp-up logging: any number of warm-ups leave work progress + the cursor untouched", () => {
  // 3 ramp-up sets then 1 work set of a 3-set lift: work count = 1, so the player
  // still shows set 2 next and the exercise is not done.
  const ex = [{ exercise: "squat", sets: 3 }, { exercise: "bench", sets: 3 }];
  const logged = [
    { exercise: "squat", set_type: "warmup" }, { exercise: "squat", set_type: "warmup" },
    { exercise: "squat", set_type: "warmup" }, { exercise: "squat", set_type: "work" },
  ];
  assert.equal(loggedWorkSets(logged, "squat"), 1);          // 3 warm-ups ignored; 1 work set counts
  assert.equal(nextUnfinishedIndex(logged, ex, -1), 0);      // squat still the first unfinished lift — not advanced past
});

check("checkSetPR: fires for a genuine PR set, using the same margin as the server", () => {
  const priorBests = { e1rm_kg: 116.67, load_kg: null }; // e1rm from 100kg x5
  const pr = checkSetPR("bench", 100, 6, "work", priorBests); // e1rm ~120
  assert.equal(pr.kind, "e1rm");
  assert.ok(pr.delta_kg > 3 && pr.delta_kg < 4);
  assert.equal(checkSetPR("bench", 100, 5, "work", priorBests), null); // matching, not beating
  assert.equal(checkSetPR("bench", 200, 1, "warmup", priorBests), null); // warm-ups never count
  assert.equal(checkSetPR("squat", 100, 5, "work", { e1rm_kg: null, load_kg: null }), null); // no history yet
});

check("checkSetPR: higher-rep LOAD band", () => {
  const priorBests = { e1rm_kg: null, load_kg: 40 };
  assert.deepEqual(checkSetPR("leg-curl", 45, 15, "work", priorBests), { kind: "load", load_kg: 45, reps: 15 });
  assert.equal(checkSetPR("leg-curl", 40, 16, "work", priorBests), null); // same load again, not a PR
});

check("checkSetPR: a deload set never fires, even when the raw math would out-score the prior best", () => {
  // 90kg x10 scores e1rm 120 via Epley — genuinely > the 116.67 prior best — so
  // without the explicit deload check this WOULD fire (proven by the second assert).
  const priorBests = { e1rm_kg: 116.67, load_kg: null };
  assert.equal(checkSetPR("bench", 90, 10, "work", priorBests, true), null);
  assert.ok(checkSetPR("bench", 90, 10, "work", priorBests, false));
});

check("checkSetPR (client) agrees with checkSetPR (server) across a battery of fixtures", () => {
  // Any drift between the browser copy and tools/derive-core.mjs would let the
  // in-player celebration and the end-of-session recap silently disagree.
  const priorSessions = [
    { session_id: "a", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }] },
    { session_id: "b", sets: [{ exercise: "leg-curl", set_type: "work", weight_kg: 40, reps: 15 }] },
  ];
  const bests = priorPersonalBests(priorSessions);
  const fixtures = [
    { exercise: "bench", weight_kg: 100, reps: 6, set_type: "work" },   // e1rm PR
    { exercise: "bench", weight_kg: 100, reps: 5, set_type: "work" },   // matches, not a PR
    { exercise: "bench", weight_kg: 200, reps: 1, set_type: "warmup" }, // warm-up excluded
    { exercise: "leg-curl", weight_kg: 45, reps: 15, set_type: "work" },// load PR
    { exercise: "leg-curl", weight_kg: 35, reps: 15, set_type: "work" },// under prior best
    { exercise: "squat", weight_kg: 100, reps: 5, set_type: "work" },   // no history at all
    { exercise: "bench", weight_kg: 90, reps: 10, set_type: "work", deload: true }, // deload: would out-score 116.67 by raw e1rm (120) but must never fire
  ];
  for (const f of fixtures) {
    const clientPriorBests = { e1rm_kg: bests.e1rm[f.exercise] ?? null, load_kg: bests.load[f.exercise] ?? null };
    const clientVerdict = checkSetPR(f.exercise, f.weight_kg, f.reps, f.set_type, clientPriorBests, f.deload);
    const serverVerdict = checkSetPRServer({ exercise: f.exercise, weight_kg: f.weight_kg, reps: f.reps, set_type: f.set_type, deload: f.deload }, bests);
    assert.deepEqual(clientVerdict, serverVerdict, `disagreement on ${JSON.stringify(f)}`);
    // and whichever fires must agree with what detectPersonalRecords would report if
    // this set were the session's only set — the actual end-of-session recap check.
    if (clientVerdict) {
      const [sessionPr] = detectPersonalRecords({ session_id: "new", sets: [{ exercise: f.exercise, set_type: f.set_type, weight_kg: f.weight_kg, reps: f.reps }] }, priorSessions);
      assert.ok(sessionPr, `client fired a PR the recap wouldn't celebrate: ${JSON.stringify(f)}`);
      assert.equal(sessionPr.kind, clientVerdict.kind);
    }
  }
});

check("isLuckySet (client) agrees with isLuckySet (server) across many session/exercise/index combos", () => {
  // Any drift between the browser copy and tools/derive-core.mjs would let the
  // in-player lucky-set toast and the recap/XP total silently disagree.
  for (let i = 0; i < 200; i++) {
    for (const exercise of ["bench", "squat", "leg-curl"]) {
      for (const idx of [0, 1, 5]) {
        const sid = `sess-${i}`;
        assert.equal(isLuckySet(sid, exercise, idx), isLuckySetServer(sid, exercise, idx), `disagreement on ${sid}/${exercise}/${idx}`);
      }
    }
  }
});

check("checkLuckySet (client, live-player order) agrees with luckySetsInSession (server, end-of-session replay)", () => {
  // Play a session set-by-set through checkLuckySet exactly as app.js does (each hard
  // set checked the instant it's banked), then replay the same final log through the
  // server's luckySetsInSession — the two hit-counts, and WHICH sets hit, must match.
  const sessionId = "cross-check-session";
  const rawSets = [
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 },
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 },
    { exercise: "squat", set_type: "warmup", weight_kg: 60, reps: 5 }, // never lucky
    { exercise: "squat", set_type: "work", weight_kg: 140, reps: 3 },
    { exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 },
    { exercise: "squat", set_type: "work", weight_kg: 140, reps: 3 },
  ];
  const logged = [];
  const clientHits = [];
  for (const raw of rawSets) {
    logged.push(raw);
    if (checkLuckySet(sessionId, logged, raw)) clientHits.push(raw.exercise);
  }
  const serverHits = luckySetsInSession({ session_id: sessionId, sets: rawSets }).map((h) => h.exercise);
  assert.deepEqual(clientHits, serverHits);
});

// rankPartners (mini-leaderboard): ranks you + active partners by streak then level.
check("rankPartners ranks you + active partners by streak, level tiebreak; tags you; drops inactive", () => {
  const ranked = rankPartners(
    { streak_weeks: 5, level: 8 },
    [
      { active: true, streak_weeks: 9, level: 3 },   // top by streak
      { active: true, streak_weeks: 5, level: 10 },  // tie streak w/ you → higher level wins
      { active: false, streak_weeks: 99, level: 99 }, // inactive → excluded
    ],
  );
  assert.equal(ranked.length, 3, "you + 2 active partners (inactive dropped)");
  assert.equal(ranked[0].streak_weeks, 9, "highest streak first");
  assert.equal(ranked[0].rank, 1);
  // 5-week tie: the level-10 partner outranks you (level 8)
  assert.equal(ranked[1].level, 10, "level tiebreak within equal streak");
  assert.ok(ranked[2].isYou && ranked[2].rank === 3, "you are last here, tagged isYou");
  assert.equal(rankPartners({ streak_weeks: 0, level: 1 }, []).length, 1, "solo: just you");
});

// weeklyRaceStatus (#10 accountability, weekly race): pure ahead/behind/tied compare,
// missing counts default to 0 rather than throwing.
check("weeklyRaceStatus: ahead/behind/tied and missing-count defaults", () => {
  assert.equal(weeklyRaceStatus(3, 1), "ahead");
  assert.equal(weeklyRaceStatus(1, 3), "behind");
  assert.equal(weeklyRaceStatus(2, 2), "tied");
  assert.equal(weeklyRaceStatus(0, 0), "tied", "neither has trained yet this week — tied, not a false 'ahead'");
  assert.equal(weeklyRaceStatus(undefined, undefined), "tied", "missing counts default to 0, not NaN/throw");
  assert.equal(weeklyRaceStatus(1, undefined), "ahead", "a partner with no sessions_this_week (stale card) defaults to 0");
});

// formatWeekLabel (#10 social, challenge-history LIST view): a real ISO week key
// reads as "Week N, YYYY"; anything malformed (incl. the test suite's own
// "filler-N" cap fixtures) degrades to the raw string instead of throwing.
check("formatWeekLabel: real ISO week keys and malformed/filler fallback", () => {
  assert.equal(formatWeekLabel("2026-W30"), "Week 30, 2026");
  assert.equal(formatWeekLabel("2026-W05"), "Week 5, 2026", "leading zero in the key doesn't leak into the label");
  assert.equal(formatWeekLabel("filler-18"), "filler-18", "non-ISO test fixture keys pass through unchanged, not thrown on");
  assert.equal(formatWeekLabel(undefined), "", "missing key never throws");
  assert.equal(formatWeekLabel(null), "");
});

// isImplausibleSet (Wave 162): the in-player typo guard. The two errors that
// actually happen are a stray zero (~10x) and lb typed into a kg field (~2.2x);
// the two things it must NEVER question are a lift with no history and a big
// PROPORTIONAL jump on a small weight (2.5 -> 7.5 kg on a lateral raise is normal).
check("isImplausibleSet: catches a stray zero and an lb/kg mix-up", () => {
  assert.equal(isImplausibleSet(1000, 8, { lastKg: 100 }), true, "stray zero: 100 -> 1000");
  // lb/kg mix-up: a kg-unit user who last lifted 102 kg thinks in lb and types 225.
  assert.equal(isImplausibleSet(225, 5, { lastKg: 102 }), true, "the same load in lb typed into a kg field is ~2.2x");
});

check("isImplausibleSet: silent on real training, however strong the lifter", () => {
  assert.equal(isImplausibleSet(102.5, 5, { lastKg: 100 }), false, "an ordinary 2.5 kg progression");
  assert.equal(isImplausibleSet(250, 3, { lastKg: 240 }), false, "an elite lifter is never second-guessed — it judges against THEIR history");
  assert.equal(isImplausibleSet(7.5, 15, { lastKg: 2.5 }), false, "3x on a lateral raise is normal: the absolute-jump floor keeps it quiet");
  assert.equal(isImplausibleSet(20, 12, { lastKg: 10 }), false, `2x but only a 10 kg jump — under the ${IMPLAUSIBLE_MIN_JUMP_KG} kg floor`);
});

// The confirm SLOT, not the flag itself (Wave 174). A superset round banks two sets
// at once, and the confirmation used to be a single exercise id: when both members
// looked implausible, confirming one un-confirmed the other, so "Tap again — log the
// round as entered" just moved the warning across and the round could NEVER be
// banked. Replaying the player's real loop is the only way to catch that — the flag
// itself was correct at every step.
check("unconfirmedFlagged: a round with TWO suspect entries banks after ONE confirming tap", () => {
  const ex = ["bench", "row"];
  const confirmed = new Set();
  const keyOf = (i) => ex[i];
  const bothLookWrong = () => true; // an lb/kg mix-up hits both lifts of a round at once
  // Tap 1: both flagged, so both are confirmed together and the round re-renders.
  const first = unconfirmedFlagged([0, 1], keyOf, bothLookWrong, confirmed);
  assert.deepEqual(first, [0, 1], "both members are questioned, not just the first");
  for (const i of first) confirmed.add(keyOf(i));
  // Tap 2: nothing is still owed, so the caller falls through and banks the round.
  assert.deepEqual(unconfirmedFlagged([0, 1], keyOf, bothLookWrong, confirmed), [],
    "the round must be bankable on the next tap — the old single-slot confirm looped forever");
});

check("unconfirmedFlagged: confirming one lift does not wave an unconfirmed partner through", () => {
  const ex = ["bench", "row"];
  const keyOf = (i) => ex[i];
  // Only the partner is suspect; the already-confirmed first lift stays quiet.
  assert.deepEqual(unconfirmedFlagged([0, 1], keyOf, (i) => i === 1, new Set(["bench"])), [1]);
  // Confirmation is keyed by exercise id, so a renumbering swap can't inherit it.
  assert.deepEqual(unconfirmedFlagged([0, 1], keyOf, () => true, new Set(["squat"])), [0, 1]);
});

check("isImplausibleSet: BOTH the ratio and the absolute jump must be exceeded", () => {
  // Exactly on both thresholds -> flagged (>=, so the boundary is inclusive).
  assert.equal(isImplausibleSet(40, 8, { lastKg: 20 }), true, `${IMPLAUSIBLE_RATIO}x AND a ${IMPLAUSIBLE_MIN_JUMP_KG} kg jump`);
  assert.equal(isImplausibleSet(39, 8, { lastKg: 20 }), false, "just under the ratio");
  assert.equal(isImplausibleSet(119, 8, { lastKg: 60 }), false, "a 59 kg jump but just under 2x — a hard set, not a typo");
});

check("isImplausibleSet: no history to judge against is never questioned", () => {
  assert.equal(isImplausibleSet(500, 5, {}), false, "a first-ever set on a lift has no reference");
  assert.equal(isImplausibleSet(500, 5, { lastKg: null, priorBests: { load_kg: null, e1rm_kg: 200 } }), false, "e1rm is not a working weight — never used as the reference");
  assert.equal(isImplausibleSet(500, 5, { lastKg: null, priorBests: { load_kg: 60 } }), true, "falls back to the best logged LOAD when last_kg is missing");
  assert.equal(isImplausibleSet(0, 10, { lastKg: 60 }), false, "a bodyweight set (0 kg) is not a typo");
});

check("isImplausibleSet: a rep count past any prescribed band is flagged on its own", () => {
  assert.equal(isImplausibleSet(20, 88, { lastKg: 20 }), true, "88 reps — no band in the engine goes near it, and the weight is unchanged");
  assert.equal(isImplausibleSet(20, 30, { lastKg: 20 }), false, "30 reps IS a prescribed band (fat-loss pumpIso tops out at 20-30)");
});

// --- #typo-today (Burst 6 — owner: "It asked me if that's the right number because it's such a big jump,
// and I clicked yes… On my second set, it asked me again… It shouldn't ask me the second time"). The
// reference was history only (last time's load, else the best); today's banked sets never counted and the
// confirmation clears once a set banks, so every later set at the new weight was questioned again. Today's
// heaviest banked WORK set now raises the reference — derived from the log, so a reload, a resume or a
// correction in the editor can never leave it stale.
check("#typo-today the owner's leg press: 40 -> 150 asks on set 1, NOT on set 2 once set 1 is banked — a reload changes nothing", () => {
  const hist = { lastKg: 40, priorBests: { load_kg: null, e1rm_kg: 53.33 } };
  const w = (kg, reps, k) => ({ exercise: "leg-press", set_type: "work", weight_kg: kg, reps, completed_at: `t${k}` });
  const opts = (logged) => { const t = todayTopSet(logged, "leg-press"); return { ...hist, todayKg: t.kg, todayReps: t.reps }; };
  assert.equal(isImplausibleSet(150, 10, opts([])), true, "set 1: a big jump from last time's 40 — asked once");
  const logged = JSON.parse(JSON.stringify([w(150, 10, 1)])); // banked (confirmed), read back after a crash
  assert.deepStrictEqual(todayTopSet(logged, "leg-press"), { kg: 150, reps: 10 });
  assert.equal(isImplausibleSet(150, 10, opts(logged)), false, "set 2 at the confirmed weight is not asked again");
  assert.equal(isImplausibleSet(155, 9, opts(logged)), false, "nor a small step up from it");
  assert.equal(isImplausibleSet(1500, 10, opts(logged)), true, "a stray zero against today's 150 is still caught");
  assert.equal(isImplausibleSet(330, 10, opts(logged)), true, "and lb typed into a kg field (2.2x)");
});
check("#typo-today only banked WORK sets of this lift vouch — never a warm-up (never checked), another lift, or a 0 kg set", () => {
  const logged = [{ exercise: "leg-press", set_type: "warmup", weight_kg: 150, reps: 5 }, { exercise: "leg-press", set_type: "work", weight_kg: 0, reps: 12 },
    { exercise: "hack-squat", set_type: "work", weight_kg: 150, reps: 10 }];
  assert.deepStrictEqual(todayTopSet(logged, "leg-press"), { kg: null, reps: 12 });
  assert.equal(isImplausibleSet(150, 10, { lastKg: 40, todayKg: todayTopSet(logged, "leg-press").kg }), true);
  assert.deepStrictEqual(todayTopSet([{ exercise: "leg-press", set_type: "work", weight_kg: 150, reps: 10 }, { exercise: "leg-press", set_type: "work", weight_kg: 120, reps: 12, deload: true }], "leg-press"),
    { kg: 150, reps: 12 }, "the heaviest set and the most reps; a deload-tagged set passed the guard too");
  assert.deepStrictEqual(todayTopSet([{ exercise: "leg-press", set_type: "work", weight_kg: 150, reps: 10 }], "leg-press", 0), { kg: null, reps: null }, "the entry being edited can't vouch for itself");
});
check("#typo-today today's sets only ever RAISE the reference: a lift with no history is still never questioned (the find-your-weight ramp)", () => {
  assert.equal(isImplausibleSet(1000, 8, { todayKg: 100 }), false, "no history: as before, no question");
  assert.equal(isImplausibleSet(90, 8, { todayKg: 40 }), false, "a first-ever lift ramped across work sets, as its card says to");
  assert.equal(isImplausibleSet(150, 8, { lastKg: 100, todayKg: 40 }), false, "a light set today never LOWERS the reference below history");
  assert.equal(isImplausibleSet(220, 8, { lastKg: 100, todayKg: 40 }), true, "…which still catches a jump from history");
});
check("#typo-today reps: a count no higher than one already banked today isn't asked again", () => {
  assert.equal(isImplausibleSet(20, 60, { lastKg: 20 }), true);
  assert.equal(isImplausibleSet(20, 55, { lastKg: 20, todayReps: 60 }), false);
  assert.equal(isImplausibleSet(20, 88, { lastKg: 20, todayReps: 60 }), true);
});
check("#typo-today the cue names the reference the guard judged against", () => {
  assert.deepStrictEqual(typoReference({ lastKg: 40, priorBests: { load_kg: null }, todayKg: 150 }), { kg: 150, from: "today" });
  assert.deepStrictEqual(typoReference({ lastKg: 40, priorBests: { load_kg: null } }), { kg: 40, from: "last" });
  assert.deepStrictEqual(typoReference({ lastKg: null, priorBests: { load_kg: 60 } }), { kg: 60, from: "best" });
  assert.deepStrictEqual(typoReference({ lastKg: 200, todayKg: 150 }), { kg: 200, from: "last" });
  assert.equal(typoReference({ todayKg: 150 }), null);
  assert.equal(typoReference({}), null);
});
check("#typo-today a superset round already confirmed at its weights banks round 2 on ONE tap", () => {
  const logged = [{ exercise: "leg-press", set_type: "work", weight_kg: 150, reps: 10 }, { exercise: "leg-curl", set_type: "work", weight_kg: 90, reps: 10 }];
  const ex = [{ exercise: "leg-press", last_kg: 40 }, { exercise: "leg-curl", last_kg: 30 }], weights = [150, 90];
  const flagged = (i) => { const t = todayTopSet(logged, ex[i].exercise); return isImplausibleSet(weights[i], 10, { lastKg: ex[i].last_kg, todayKg: t.kg, todayReps: t.reps }); };
  assert.deepStrictEqual(unconfirmedFlagged([0, 1], (i) => ex[i].exercise, flagged, new Set()), []);
});

// ---------- Typed entry + per-exercise kg/lb units ----------
// These guard the player's typed inputs and the per-key session unit migration —
// the two places a stored "60" could silently change meaning (which then anchors
// the NEXT session's suggested weight at 2.2x, a safety issue, not a display bug).

check("sanitizeTypedValue: parses decimals, floors negatives at 0", () => {
  assert.equal(sanitizeTypedValue("62.5"), 62.5);
  assert.equal(sanitizeTypedValue("-4"), 0, "a pasted negative floors at 0, same as the steppers");
});

check("sanitizeTypedValue: junk/empty returns the fallback, NEVER 0", () => {
  // A number input's .value is "" while empty or mid-edit; zeroing the weight
  // there would bank a 0 kg set on the very next Done tap.
  assert.equal(sanitizeTypedValue("", { fallback: 60 }), 60);
  assert.equal(sanitizeTypedValue("abc", { fallback: null }), null);
  assert.equal(sanitizeTypedValue(undefined, { fallback: 12 }), 12);
});

check("sanitizeTypedValue: integer mode rounds (reps are whole)", () => {
  assert.equal(sanitizeTypedValue("12", { integer: true }), 12);
  assert.equal(sanitizeTypedValue("12.7", { integer: true }), 12, "parseInt semantics — '12.7' reads as 12, matching the history editor");
  assert.equal(sanitizeTypedValue("-3", { integer: true }), 0);
});

check("convertDispWeight: kg ↔ lb at plate quanta (5 lb pins, 0.25 kg plates)", () => {
  assert.equal(convertDispWeight(60, "kg", "lb"), 130, "60 kg is a 130 lb stack pin, not 132.3");
  assert.equal(convertDispWeight(130, "lb", "kg"), 59, "and back lands on a loadable kg value");
  assert.equal(convertDispWeight(225, "lb", "kg"), 102, "the classic 225 lb = 102 kg");
});

check("convertDispWeight: same-unit is the identity — a typed value is never re-rounded", () => {
  assert.equal(convertDispWeight(62.7, "kg", "kg"), 62.7);
  assert.equal(convertDispWeight(137, "lb", "lb"), 137, "an off-plate typed 137 lb stays 137");
});

check("convertDispWeight: a nonzero value never converts to ZERO (0 means 'no added weight')", () => {
  // 1 kg added on weighted pull-ups: the 5 lb plate snap would say 0 lb, which
  // renders the bodyweight no-added-weight shape and destroys the entry.
  assert.equal(convertDispWeight(1, "kg", "lb"), 2, "falls back to the finer 0.5 lb quantum");
  assert.equal(convertDispWeight(1, "lb", "kg"), 0.5);
  assert.equal(convertDispWeight(0.1, "kg", "lb"), 0.5, "clamped to at least one quantum");
  assert.equal(convertDispWeight(0, "kg", "lb"), 0, "a genuine zero stays zero");
});

check("normalizeWeightsToUnits: an old scalar-stamped blob is stamped per key, converting only what moved", () => {
  // Crash blob saved by a pre-override build (weights all kg, no stamps); the
  // user has since flipped exercise at index 1 to lb.
  const res = normalizeWeightsToUnits({ weights: { 0: 60, 1: 60 }, stamps: {}, fallbackUnit: "kg", unitOf: (k) => (k === "1" ? "lb" : "kg") });
  assert.equal(res.changed, true);
  assert.equal(res.weights[0], 60, "the kg entry is untouched");
  assert.equal(res.weights[1], 130, "the overridden entry converts once");
  assert.deepEqual(res.stamps, { 0: "kg", 1: "lb" }, "every entry leaves stamped");
});

check("normalizeWeightsToUnits: stable — matching stamps are a no-op (no drift on every render)", () => {
  const res = normalizeWeightsToUnits({ weights: { 0: 62.7 }, stamps: { 0: "kg" }, fallbackUnit: "kg", unitOf: () => "kg" });
  assert.equal(res.changed, false);
  assert.equal(res.weights[0], 62.7, "a typed off-plate value survives repeated normalization byte-identical");
});

check("normalizeWeightsToUnits: a global flip converts non-overridden entries; already-lb entries stay put", () => {
  // Session in progress with index 1 overridden to lb; user flips GLOBAL kg→lb.
  const res = normalizeWeightsToUnits({ weights: { 0: 60, 1: 130 }, stamps: { 0: "kg", 1: "lb" }, fallbackUnit: "kg", unitOf: () => "lb" });
  assert.equal(res.weights[0], 130, "the kg entry converts");
  assert.equal(res.weights[1], 130, "the lb entry is NOT double-converted");
  assert.deepEqual(res.stamps, { 0: "lb", 1: "lb" });
});

check("units round-trip: a deliberate lb entry never trips the lb/kg typo guard", () => {
  // 130 lb typed on an lb-overridden machine converts to ~59 kg at bank time —
  // against a 60 kg history the guard must stay silent (it exists to catch lb
  // typed into a KG field, which no longer happens once the field IS lb).
  const bankedKg = Math.round((130 / 2.2046226) * 100) / 100;
  assert.equal(isImplausibleSet(bankedKg, 8, { lastKg: 60 }), false);
});

// --- #swap-undo (W275 review): the player's Undo belongs to ONE session — the card from
// Monday's swap must never offer to "undo" Thursday's planned lift.
check("#swap-undo applies only in the session it was made in, on its own lift, before any work is banked", () => {
  const sess = { session_id: "s1", set: 0, logged: [], ex: [{ exercise: "hack-squat" }] };
  const undo = { to: "hack-squat", session_id: "s1" };
  assert.equal(undoApplies(undo, sess, sess.ex[0]), true);
  assert.equal(undoApplies({ ...undo, session_id: "s0" }, sess, sess.ex[0]), false, "an older workout's undo");
  assert.equal(undoApplies({ to: "hack-squat" }, sess, sess.ex[0]), false, "an unstamped undo is never trusted");
  assert.equal(undoApplies(undo, { ...sess, logged: [{ exercise: "hack-squat", set_type: "work" }] }, sess.ex[0]), false, "work banked");
  assert.equal(undoApplies(undo, { ...sess, set: 1 }, sess.ex[0]), false);
  assert.equal(undoApplies(null, sess, sess.ex[0]), false);
});

// --- #replace-slot (W272): "Can't do this one?" swaps the lift at slot i for a row the
// server built for the replacement. The old swap spread {...cur}: the old lift's
// last_kg, pr_watch, eased and suggestion note rode onto the new one — a wrong "Last
// time", the typo guard judged against the wrong lift, a fake PR toast, a deload tag.
{
  const mk = (exs, logged = []) => ({ ex: exs, logged, i: 1, set: 0, weights: { 0: 60, 1: 40, 2: 20 }, reps: { 1: 12 }, eff: { 1: "ok" }, wUnits: { 1: "kg" } });
  const cur = { exercise: "pushdown", name: "Pushdown", sets: 3, rep_range: "10-15", rir: "1-2", last_kg: 40, last_reps: [12, 11],
    pr_watch: { e1rm_kg: 55, load_kg: 45 }, eased: true, suggestion_note: "eased after a layoff", suggested_kg: 36, rest_s: 120 };
  const row = { exercise: "cable-pushdown", name: "Cable pushdown", sets: 4, rep_range: "12-20", rir: "0-1", last_kg: null, last_reps: null,
    pr_watch: { e1rm_kg: null, load_kg: null }, suggested_kg: null, rest_s: 90, superset_with: "curl", superset_with_name: "Curl",
    unilateral: false, movement_pattern: "isolation-elbow-extension", primary_muscles: ["triceps"] };
  const exs = () => [ex("bench", 3), { ...cur }, ex("curl", 3)];

  check("#targets a swapped-in lift keeps the SLOT's original planned count (W280) — the target the workout reports", () => {
    const r = replaceSlot(mk([ex("bench", 3), { ...cur, planned_sets: 3 }, ex("curl", 3)]), 1, row, { expect: "pushdown" });
    assert.equal(r.ok, true);
    assert.equal(r.sess.ex[1].planned_sets, 3, "planned_sets is part of the slot's prescription");
    assert.ok(PRESCRIPTION_KEYS.includes("planned_sets"));
  });
  check("#replace-slot the prescription stays the slot's; every other field is the new lift's own; the pairing is always dropped", () => {
    const r = replaceSlot(mk(exs()), 1, row, { expect: "pushdown" });
    assert.equal(r.ok, true);
    const out = r.sess.ex[1];
    for (const k of PRESCRIPTION_KEYS) assert.deepStrictEqual(out[k], cur[k], `prescription ${k}`);
    for (const k of Object.keys(row)) if (!PRESCRIPTION_KEYS.includes(k) && !/^superset_with/.test(k)) assert.deepStrictEqual(out[k], row[k], `row field ${k}`);
    for (const k of Object.keys(cur)) if (!PRESCRIPTION_KEYS.includes(k) && !(k in row)) assert.ok(!(k in out), `the old lift's ${k} leaked onto the new one`);
    assert.ok(!("superset_with" in out) && !("superset_with_name" in out), "a pairing never comes back into an unlinked live session");
  });
  check("#replace-slot resets ONLY that slot's typed inputs; the log, the other slots and the input are untouched", () => {
    const s = mk(exs());
    const before = JSON.stringify(s);
    const r = replaceSlot(s, 1, row, { expect: "pushdown" });
    assert.equal(JSON.stringify(s), before, "input not mutated");
    assert.ok(!(1 in r.sess.weights) && !(1 in r.sess.reps) && !(1 in r.sess.eff) && !(1 in r.sess.wUnits));
    assert.equal(r.sess.weights[0], 60); assert.equal(r.sess.weights[2], 20);
    assert.deepStrictEqual(r.sess.logged, s.logged);
    assert.equal(r.sess.set, 0);
    assert.deepStrictEqual(r.sess.ex[0], s.ex[0]); assert.deepStrictEqual(r.sess.ex[2], s.ex[2]);
  });
  check("#replace-slot refuses a slot that no longer holds the lift that was tapped (a slow response must never hit the next exercise)", () => {
    const s = mk(exs());
    const r = replaceSlot(s, 2, row, { expect: "pushdown" });
    assert.equal(r.ok, false); assert.equal(r.reason, "moved"); assert.strictEqual(r.sess, s);
    assert.equal(replaceSlot(s, 1, row, {}).ok, false, "no expectation, no replace");
  });
  check("#replace-slot refuses once the lift has a banked work set — logged work is never orphaned", () => {
    const s = mk(exs(), [{ exercise: "pushdown", set_type: "work", weight_kg: 40, reps: 12 }]);
    const r = replaceSlot(s, 1, row, { expect: "pushdown" });
    assert.equal(r.ok, false); assert.equal(r.reason, "started");
    assert.equal(replaceSlot(mk(exs(), [{ exercise: "pushdown", set_type: "warmup", weight_kg: 20, reps: 10 }]), 1, row, { expect: "pushdown" }).ok, true, "a warm-up isn't work");
  });
  check("#replace-slot refuses a lift another slot already holds — progress is per exercise id, so a duplicate silently skips one", () => {
    const r = replaceSlot(mk(exs()), 1, { ...row, exercise: "curl" }, { expect: "pushdown" });
    assert.equal(r.ok, false); assert.equal(r.reason, "duplicate");
    // …and the harm it prevents, replayed: two slots of one id → the second is never trained.
    const { logged } = playSession([ex("db-bench", 3), ex("db-bench", 3)]);
    assert.equal(loggedWorkSets(logged, "db-bench"), 3, "with a duplicate, only ONE slot's sets are ever trained");
  });
  check("#replace-slot Undo is the same call in reverse — the saved row comes back exactly; refused once the substitute has work banked", () => {
    const s0 = mk(exs());
    const s1 = replaceSlot(s0, 1, row, { expect: "pushdown" }).sess;
    const s2 = replaceSlot(s1, 1, s0.ex[1], { expect: "cable-pushdown" });
    assert.equal(s2.ok, true);
    assert.deepStrictEqual(s2.sess.ex, s0.ex);
    assert.equal(s2.sess.set, 0);
    const s1b = { ...s1, logged: [{ exercise: "cable-pushdown", set_type: "work", weight_kg: 30, reps: 15 }] };
    assert.equal(replaceSlot(s1b, 1, s0.ex[1], { expect: "cable-pushdown" }).ok, false);
  });
  check("#replace-slot an older row without a field (e.g. no rest_s from before a deploy) inherits nothing from the old lift", () => {
    const { rest_s, ...oldShape } = row;
    const out = replaceSlot(mk(exs()), 1, oldShape, { expect: "pushdown" }).sess.ex[1];
    assert.ok(!("rest_s" in out), "the old lift's rest length must not ride along");
  });
  // N7 (Burst 6): a second swap must land in the PLAN's slot, so the slot remembers the lift the plan put
  // there (slot_of) across chained swaps — computed here, never trusted from a row, gone once the slot holds
  // that lift again, and never sent with the finished workout.
  check("#n7 chained swaps carry the slot's ORIGINAL planned lift (slot_of); an Undo back to it leaves none — through a crash", () => {
    const s0 = mk(exs());
    const s1 = replaceSlot(s0, 1, row, { expect: "pushdown" });
    assert.equal(s1.sess.ex[1].slot_of, "pushdown");
    const crashed = JSON.parse(JSON.stringify(s1.sess)); // the localStorage mirror, read back
    const s2 = replaceSlot(crashed, 1, { exercise: "dip", name: "Dip", suggested_kg: 0 }, { expect: "cable-pushdown" });
    assert.equal(s2.sess.ex[1].slot_of, "pushdown", "a second swap still names the plan's lift, not the first substitute");
    const u1 = replaceSlot(s2.sess, 1, s1.sess.ex[1], { expect: "dip" });
    assert.equal(u1.sess.ex[1].slot_of, "pushdown", "undoing the second swap restores the first substitute, still standing in");
    const u0 = replaceSlot(u1.sess, 1, s0.ex[1], { expect: "cable-pushdown" });
    assert.ok(!("slot_of" in u0.sess.ex[1]), "back on its own planned lift, the slot carries no stand-in marker");
    assert.deepStrictEqual(u0.sess.ex, s0.ex);
  });
  check("#n7 slot_of is computed, never inherited from a row; an older blob falls back to the live lift; the workout's targets never carry it", () => {
    const s1 = replaceSlot(mk(exs()), 1, row, { expect: "pushdown" }).sess;
    assert.equal(replaceSlot(s1, 1, { exercise: "dip", slot_of: "evil" }, { expect: "cable-pushdown" }).sess.ex[1].slot_of, "pushdown");
    const old = mk([ex("bench", 3), { ...cur, exercise: "cable-pushdown" }, ex("curl", 3)]); // swapped by a build before the field
    assert.equal(replaceSlot(old, 1, { exercise: "dip" }, { expect: "cable-pushdown" }).sess.ex[1].slot_of, "cable-pushdown",
      "no marker to read: the live lift stands for the slot (the server then appends, as before)");
    assert.ok(!("slot_of" in buildTargets(s1)[1]), "targets carry the plan, never the marker");
    assert.equal(buildTargets(s1)[1].stood_in_for, "pushdown", "…naming the planned lift it stood in for (review G1: the comeback clock counts the slot as trained)");
    assert.ok(!("stood_in_for" in buildTargets(mk(exs()))[1]), "a lift in its own slot names nothing");
  });
}

// --- #tired (Burst 6 — owner: "I was too tired after doing leg press and RDLs to do Bulgarian split squats. There is
// currently no solution… besides 'skip this one', is this correct?"). One tap at the first set of a lift: the easiest
// lift that fits the slot (the server picks it) at about half the sets, or — nothing easier fits, offline, or no row —
// the SAME lift, about 10% lighter and shorter. Either way the tired day never sets the lift back, and Undo puts the
// slot back exactly. The pieces are pure, so a crash between the tap and the next set resumes on the same state.
check("#tired tiredSets: about half, never under 2 for a lift planned at 2+, never more than planned", () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(tiredSets), [1, 2, 2, 2, 3, 3]);
});
check("#tired easeKg: about 10% off on the lift's own KG step, at least one step, never to zero", () => {
  assert.deepStrictEqual([easeKg(20, 2.5), easeKg(22.5, 2.5), easeKg(100, 2.5), easeKg(10, 1), easeKg(5, 1)], [17.5, 20, 90, 9, 4]);
  assert.equal(easeKg(2.5, 2.5), 2.5, "one step down would be zero: the weight stays");
  assert.equal(easeKg(null, 2.5), null); assert.equal(easeKg(0, 2.5), null);
});
{
  const bss = { exercise: "bss", name: "BSS", sets: 3, planned_sets: 3, rep_range: "8-12", rir: "1-3", suggested_kg: 22.5, last_kg: 20, last_reps: [12, 12, 12], inc_kg: 2.5,
    suggestion_note: "Last time you hit the top of the range — add 2.5 kg.", rep_targets: [12, 12, 12] };
  const mkT = (row = bss, o = {}) => ({ session_id: "s1", ex: [ex("leg-press", 3), { ...row }, ex("curl", 3)], logged: [{ exercise: "leg-press", set_type: "work", weight_kg: 150, reps: 10 }],
    i: 1, set: 0, weights: { 1: 22.5 }, reps: { 1: 12 }, eff: {}, wUnits: { 1: "kg" }, ...o });
  check("#tired easeSlot: the same lift, ~10% lighter and about half the sets, tagged so it never anchors — with its OWN reason, never the old 'add 2.5 kg'", () => {
    const r = easeSlot(mkT(bss, { lastSkip: { ids: ["bss"] } }), 1, { expect: "bss", stepKg: 2.5 });
    assert.equal(r.ok, true);
    const out = r.sess.ex[1];
    assert.deepStrictEqual([out.sets, out.planned_sets, out.suggested_kg, out.eased, out.tired], [2, 2, 20, true, true]);
    assert.doesNotMatch(out.suggestion_note, /add \d/, "the why line describes the eased weight");
    assert.deepStrictEqual(out.rep_targets, [12, 12, 12], "the aims set for the heavier weight are still in reach");
    assert.ok(!(1 in r.sess.weights) && !(1 in r.sess.reps), "the stepper re-prefills at the eased weight");
    assert.ok(!("lastSkip" in r.sess));
    // (W298: the served aims now travel too — they were what the player asked; a planned-easy target is excluded from learning anyway.)
    // (W298 review: the aims are the ones SERVED — the player shows aim.slice(0, sets) — so a tired row's trimmed dose sends
    // only its own two; a longer list would be dropped whole by the server.)
    assert.deepStrictEqual(buildTargets(r.sess)[1], { exercise: "bss", sets: 2, rep_range: "8-12", rir: "1-3", suggested_kg: 20, deload: true, rep_targets: [12, 12] }, "an eased lift's workout is planned-easy: never graded, never an anchor");
  });
  check("#tired easeSlot: a tired day never counts — even on a lift with no history it is tagged eased (round 2: 'keep this one easy' was then graded 'too easy'); a bodyweight lift is tagged too", () => {
    const fresh = easeSlot(mkT({ exercise: "bss", name: "BSS", sets: 3, rep_range: "8-12", rir: "1-3", suggested_kg: null, last_kg: null, last_reps: null }), 1, { expect: "bss", stepKg: 2.5 }).sess.ex[1];
    assert.deepStrictEqual([fresh.sets, fresh.suggested_kg, fresh.eased, fresh.tired], [2, null, true, true]);
    const est = easeSlot(mkT({ ...bss, last_kg: null, last_reps: null, suggested_kg: 20 }), 1, { expect: "bss", stepKg: 2.5 }).sess.ex[1];
    assert.deepStrictEqual([est.suggested_kg, est.eased], [17.5, true], "a first-time estimate is eased, and the tired sets never become its anchor");
    assert.match(est.suggestion_note, /It won't count against your progress\.$/);
    const bw = easeSlot(mkT({ exercise: "dip", name: "Dip", sets: 4, rep_range: "6-10", rir: "1-3", suggested_kg: 0, last_kg: 0, last_reps: [10, 9], equipment: "bodyweight" }), 1, { expect: "dip", stepKg: 2.5 }).sess.ex[1];
    assert.deepStrictEqual([bw.sets, bw.suggested_kg, bw.eased], [2, 0, true]);
  });
  // Burst 8 review #25 (R7): the held weight's lighter alternative belongs to the SERVED weight — a tired ease drops it, or
  // 'Use 92.5 kg' sat under a tired 90 kg and undid the ease in one tap.
  check("#tired (Burst 8 review #25) a tired ease drops the held weight's alternative; nothing offers one on a tired row", () => {
    const held = { ...bss, suggested_kg: 100, last_kg: 100, alt_kg: 92.5, alt_reps: 9, suggestion_note: "Just under the range last time (7; it starts at 8) — keep the weight and aim for 8, or use 92.5 kg if it felt like too much. If it happens again, I'll lighten it." };
    const out = easeSlot(mkT(held), 1, { expect: "bss", stepKg: 2.5 }).sess.ex[1];
    assert.equal(out.suggested_kg, 90, "precondition: eased");
    assert.ok(!("alt_kg" in out) && !("alt_reps" in out), JSON.stringify([out.alt_kg, out.alt_reps]));
    assert.ok(!("alt_kg" in tiredSwapRow(held)), "a tired swap's row too");
    const k = (x) => Math.round(x * 4) / 4;
    assert.strictEqual(playerCore.altOffer({ ...held, tired: true, eased: true }, { toDisp: k, toKg: (v) => v, step: 2.5, served: 90, unit: "kg" }), null, "a tired row never offers one, whatever it carries");
  });
  check("#tired (review) a skip already taken is never undone: the tired dose is the smaller of the two", () => {
    const r = easeSlot(mkT({ ...bss, sets: 1 }), 1, { expect: "bss", stepKg: 2.5 }).sess.ex[1];
    assert.deepStrictEqual([r.sets, r.planned_sets], [1, 1], "skipped to 1 set, then tired: still 1, never 2");
  });
  check("#tired (round 2) a bump served today is dropped back to last time's weight; with no bump, ~10% off", () => {
    const bump = easeSlot(mkT({ ...bss, suggested_kg: 22.5, last_kg: 20 }), 1, { expect: "bss", stepKg: 2.5 }).sess.ex[1];
    assert.equal(bump.suggested_kg, 20, "22.5 served after 20 last time: tired → 20, exactly last time's (the stepper shows it as is)");
    const lbBump = easeSlot(mkT({ ...bss, suggested_kg: 7.8, last_kg: 6.8, inc_kg: 1 }), 1, { expect: "bss", stepKg: 1 }).sess.ex[1];
    assert.equal(lbBump.suggested_kg, 6.8, "a pounds user's 15 → 20 lb bump: back to 15 lb, never a kept +33%");
    const hold = easeSlot(mkT({ ...bss, suggested_kg: 20, last_kg: 20 }), 1, { expect: "bss", stepKg: 2.5 }).sess.ex[1];
    assert.equal(hold.suggested_kg, 17.5);
  });
  check("#tired (round 5) a tired SWAP holds its substitute's load too: a bump served today drops back to last time's weight; it never counts, and says so", () => {
    const known = tiredSwapRow({ exercise: "leg-extension", suggested_kg: 42.5, last_kg: 40, last_reps: [12, 12, 12], suggestion_note: "Last time you hit the top of the range — add 2.5 kg." });
    assert.deepStrictEqual([known.suggested_kg, known.tired, known.eased], [40, true, true]);
    assert.equal(known.suggestion_note, "Same weight as last time — no step up on a tired day. It won't count against your progress.");
    const placed = tiredSwapRow({ exercise: "leg-extension", suggested_kg: 37.5, last_kg: 40, last_reps: [12, 12], suggestion_note: "This time it comes after 6 sets that also work your thighs (quads) (last time it came first), so I've made it 37.5 kg." });
    assert.deepStrictEqual([placed.suggested_kg, placed.suggestion_note], [37.5, "This time it comes after 6 sets that also work your thighs (quads) (last time it came first), so I've made it 37.5 kg. It won't count against your progress."], "already under last time (its position): kept");
    const fresh = tiredSwapRow({ exercise: "leg-extension", suggested_kg: 5, last_kg: null, last_reps: null, suggestion_note: "No history yet — a starting estimate scaled to your bodyweight. Adjust it up or down until the last rep is right around the target effort." });
    assert.deepStrictEqual([fresh.suggested_kg, fresh.suggestion_note], [5, "Keep it light today — it won't set this lift's starting weight."], "never asked to calibrate a weight that won't be kept");
    assert.equal(tiredSwapRow({ exercise: "dip", equipment: "bodyweight", suggested_kg: 2.5, last_kg: 0, last_reps: [10, 10] }).suggested_kg, 0, "a bodyweight lift's first added load: dropped too");
    assert.equal(tiredSwapRow({ exercise: "leg-extension", suggested_kg: 42.5, last_kg: 40, last_reps: [12, 12, 12], last_easy: true, suggestion_note: "In your last regular session you hit the top of the range — add 2.5 kg." }).suggestion_note,
      "Same weight as your last regular session — no step up on a tired day. It won't count against your progress.", "round 6: never 'last time' under 'Last regular session'");
  });
  check("#tired (round 8) a swap OF a tired slot is still the tired day: the busy / pick / no-machine doors' row is held, eased and says it won't count", () => {
    const stepUp = { exercise: "dumbbell-step-up", name: "Dumbbell Step-Up", suggested_kg: 7.5, last_kg: 5, last_reps: [12, 12], suggestion_note: "Last time you hit the top of the range — add 2.5 kg." };
    const held = swapInRow({ exercise: "hack-squat", sets: 2, planned_sets: 2, tired: true, eased: true, slot_of: "bss" }, stepUp);
    assert.deepStrictEqual([held.suggested_kg, held.tired, held.eased, held.suggestion_note], [5, true, true, "Same weight as last time — no step up on a tired day. It won't count against your progress."]);
    assert.equal(swapInRow({ exercise: "hack-squat", sets: 3 }, stepUp), stepUp, "a regular slot: the server's row exactly as it came");
    // End to end through session-core, as the player does it: a tired swap, then "It's busy right now" on the substitute.
    const tiredSess = replaceSlot(mkT(), 1, tiredSwapRow({ exercise: "hack-squat", name: "Hack Squat", suggested_kg: null, last_kg: null, last_reps: null }), { expect: "bss", sets: 2 }).sess;
    const busy = replaceSlot(tiredSess, 1, swapInRow(tiredSess.ex[1], { exercise: "dumbbell-step-up", name: "Dumbbell Step-Up", suggested_kg: null, last_kg: null, last_reps: null }), { expect: "hack-squat" });
    assert.ok(busy.ok, busy.reason);
    const slot = busy.sess.ex[1];
    assert.deepStrictEqual([slot.exercise, slot.sets, slot.tired, slot.eased, slot.slot_of], ["dumbbell-step-up", 2, true, true, "bss"], "the tired dose AND the tired day carry over");
    assert.equal(slot.suggestion_note, "Keep it light today — it won't set this lift's starting weight.");
    assert.equal(tiredOffer({ ...busy.sess, set: 0 }), false, "never offered again — a second halving");
    assert.deepStrictEqual(buildTargets(busy.sess)[1], { ...buildTargets(busy.sess)[1], deload: true, stood_in_for: "bss" }, "it banks planned easy: never the new lift's anchor, a PR or a grade");
  });
  check("#tired (round 3) a bodyweight lift's first added load is a bump too: tired → back to bodyweight", () => {
    const dip = easeSlot(mkT({ ...bss, exercise: "dip", equipment: "bodyweight", suggested_kg: 2.5, last_kg: 0, last_reps: [10, 10, 10] }), 1, { expect: "dip", stepKg: 2.5 }).sess.ex[1];
    assert.deepStrictEqual([dip.suggested_kg, /^Lighter/.test(dip.suggestion_note)], [0, true]);
  });
  check("#tired (round 3) restoring a skip's own Undo after the tired Undo makes it valid again (the player stashes it on the tired tap)", () => {
    const s0 = { ...mkT({ ...bss, sets: 4, planned_sets: 4 }), rest: null };
    const sk = skipSet(s0); // 1 of 4 skipped
    assert.equal(sk.ok, true);
    const stash = sk.sess.lastSkip;
    const eased = easeSlot(sk.sess, 1, { expect: "bss", stepKg: 2.5 }).sess;
    assert.ok(!("lastSkip" in eased), "the tired ease retires it, as any swap does");
    const back = { ...replaceSlot(eased, 1, sk.sess.ex[1], { expect: "bss", sets: sk.sess.ex[1].sets, plannedSets: sk.sess.ex[1].planned_sets }).sess, lastSkip: stash };
    const un = undoSkip(back);
    assert.equal(un.ok, true, "the skip can still be undone");
    assert.deepStrictEqual([un.sess.ex[1].sets, un.sess.ex[1].planned_sets], [4, 4]);
  });
  check("#tired (round 2) a pounds user's 45-lb bar is the floor (20.41 kg), never '40 lb'", () => {
    const barLb = 45 / 2.20462;
    const hold = easeSlot(mkT({ ...bss, exercise: "squat", suggested_kg: 20.41, last_kg: 20.41, equipment: "barbell" }), 1, { expect: "squat", stepKg: 2.5, floorKg: barLb }).sess.ex[1];
    assert.equal(hold.suggested_kg, 20.41, "the bar stays the bar");
  });
  check("#tired (review) a barbell never eases under the empty bar", () => {
    assert.equal(EMPTY_BAR_KG, serverCore.EMPTY_BAR_KG, "the player's bar is the engine's");
    assert.deepStrictEqual([easeKg(22.5, 2.5, 20), easeKg(20, 2.5, 20), easeKg(25, 2.5, 20)], [20, 20, 22.5]);
    const bar = easeSlot(mkT({ ...bss, exercise: "squat", suggested_kg: 20, equipment: "barbell" }), 1, { expect: "squat", stepKg: 2.5, floorKg: EMPTY_BAR_KG }).sess.ex[1];
    assert.equal(bar.suggested_kg, 20, "20 kg is the bar: it stays");
    assert.match(bar.suggestion_note, /^Shorter today because you're tired\./, "so it says shorter, never lighter");
  });
  check("#tired (review) its reason says only what changed ON SCREEN: lighter, shorter, or neither", () => {
    const lb = (row) => Math.round((row.suggested_kg * 2.20462) / 5) * 5; // a pounds user's plate-rounded stepper
    const same = easeSlot(mkT({ ...bss, suggested_kg: 12, last_kg: 12, inc_kg: 1 }), 1, { expect: "bss", stepKg: 1, shown: lb }).sess.ex[1];
    assert.deepStrictEqual([same.suggested_kg, /^Lighter/.test(same.suggestion_note)], [12, false], "12 → 11 kg shows as the same 25 lb plate: no hidden change, no 'lighter'");
    const moved = easeSlot(mkT({ ...bss, suggested_kg: 11, last_kg: 11, inc_kg: 1 }), 1, { expect: "bss", stepKg: 1, shown: lb }).sess.ex[1];
    assert.deepStrictEqual([moved.suggested_kg, /^Lighter/.test(moved.suggestion_note)], [10, true], "11 → 10 kg moves a plate (25 → 20 lb): lighter, and says so");
    const twoSets = easeSlot(mkT({ ...bss, sets: 2, planned_sets: 2, suggested_kg: 2.5, last_kg: 2.5 }), 1, { expect: "bss", stepKg: 2.5 }).sess.ex[1];
    assert.deepStrictEqual([twoSets.sets, twoSets.suggested_kg], [2, 2.5]);
    assert.equal(twoSets.suggestion_note, "Easy does it today — stop each set while your form is solid. It won't count against your progress.", "neither shorter nor lighter: it never claims either");
  });
  check("#tired easeSlot refuses as a swap does: a lift with work banked, or a slot the cursor has left", () => {
    assert.equal(easeSlot(mkT(bss, { logged: [{ exercise: "bss", set_type: "work", weight_kg: 20, reps: 10 }] }), 1, { expect: "bss", stepKg: 2.5 }).reason, "started");
    assert.equal(easeSlot(mkT(), 2, { expect: "bss", stepKg: 2.5 }).reason, "moved");
  });
  check("#tired replaceSlot's `sets`: the swapped-in lift does the trimmed dose, recorded as its plan; Undo restores the slot's own count", () => {
    const s0 = mkT();
    const s1 = replaceSlot(s0, 1, { exercise: "leg-extension", name: "Leg Extension", suggested_kg: 45, tired: true }, { expect: "bss", sets: 2 });
    assert.deepStrictEqual([s1.sess.ex[1].sets, s1.sess.ex[1].planned_sets, s1.sess.ex[1].slot_of], [2, 2, "bss"]);
    const u = replaceSlot(JSON.parse(JSON.stringify(s1.sess)), 1, s0.ex[1], { expect: "leg-extension", sets: s0.ex[1].planned_sets ?? s0.ex[1].sets });
    assert.deepStrictEqual(u.sess.ex, s0.ex, "Undo (through a crash) puts the full 3/3 back — the live slot's 2 would have stuck");
    const plain = replaceSlot(s0, 1, { exercise: "leg-extension" }, { expect: "bss" });
    assert.deepStrictEqual([plain.sess.ex[1].sets, plain.sess.ex[1].planned_sets], [3, 3], "without `sets`: as before");
  });
  check("#tired (round 2) Undo puts the slot back EXACTLY — a skip taken before the tired tap stays taken", () => {
    const skipped = mkT({ ...bss, sets: 3, planned_sets: 4 }); // 1 of 4 skipped
    const eased = easeSlot(skipped, 1, { expect: "bss", stepKg: 2.5 }).sess;
    assert.deepStrictEqual([eased.ex[1].sets, eased.ex[1].planned_sets], [2, 2]);
    const saved = skipped.ex[1];
    const back = replaceSlot(JSON.parse(JSON.stringify(eased)), 1, saved, { expect: "bss", sets: saved.sets, plannedSets: saved.planned_sets }).sess.ex[1];
    assert.deepStrictEqual([back.sets, back.planned_sets], [3, 4], "3 of 4 (1 skipped), as it was");
  });
  check("#tired with N7's slot_of: a tired swap of a slot that's itself a swap keeps the plan's lift; easing a substitute in place keeps it too", () => {
    const busy = replaceSlot(mkT(), 1, { exercise: "hack-squat", suggested_kg: 80 }, { expect: "bss" }).sess;
    const tired = replaceSlot(JSON.parse(JSON.stringify(busy)), 1, { exercise: "leg-extension", suggested_kg: 45, tired: true }, { expect: "hack-squat", sets: 2 }).sess;
    assert.deepStrictEqual([tired.ex[1].slot_of, tired.ex[1].sets], ["bss", 2]);
    const eased = easeSlot(busy, 1, { expect: "hack-squat", stepKg: 2.5 }).sess.ex[1];
    assert.deepStrictEqual([eased.slot_of, eased.suggested_kg, eased.sets], ["bss", 72.5, 2]);
  });
  check("#tired the offer: the first set of a lift not yet started, after some work today — never on a superset member, a slot already made easier, or one showing its swap's Undo", () => {
    const offer = (o = {}, row = bss) => tiredOffer(mkT(row, o));
    assert.equal(offer(), true);
    assert.equal(offer({ logged: [] }), false, "nothing done yet today");
    assert.equal(offer({ logged: [{ exercise: "leg-press", set_type: "warmup", weight_kg: 60, reps: 10 }] }), false, "warm-ups aren't work");
    assert.equal(offer({ set: 1 }), false);
    assert.equal(offer({ logged: [{ exercise: "bss", set_type: "work", weight_kg: 20, reps: 10 }] }), false, "started: Skip this set and End early cover it");
    assert.equal(offer({}, { ...bss, superset_with: "curl" }), false);
    assert.equal(offer({}, { ...bss, tired: true }), false, "already the tired version");
    assert.equal(offer({}, { ...bss, eased: true }), true, "a comeback-eased lift (12+ days off) is not a tired one — it can still be made easier");
    assert.equal(offer({ swapUndo: { to: "bss", session_id: "s1" } }), false, "its swap's Undo is showing");
  });
}

// --- #rest-state (W273): the rest is an absolute END TIME in the crash-safe session, so a
// reload, a locked phone or an app switch resumes it; both renderers derive it here.
check("#rest-state restLength: the lift's own rest plus the remembered offset, clamped to 30 s–10 min — never NaN", () => {
  assert.equal(restLength({ rest_s: 180 }, 30), 210);
  assert.equal(restLength({ rest_s: 90 }, -90), 30, "floor");
  assert.equal(restLength({ rest_s: 180 }, 900), 600, "ceiling");
  assert.equal(restLength({ exercise: "x" }), 120, "a row from before W273 (no rest_s, a resumed workout) rests the old 120 s");
  assert.equal(restLength({ rest_s: undefined }, 30), 150);
  assert.equal(restLength({ rest_s: 180 }, NaN), 180, "a junk offset is ignored");
  assert.ok(Number.isFinite(restLength({ rest_s: "abc" }, "x")));
});
check("#rest-state restRemaining: whole seconds to the end, rounded up, never negative", () => {
  const now = 1_000_000;
  assert.equal(restRemaining(now + 5000, now), 5);
  assert.equal(restRemaining(now + 4001, now), 5);
  assert.equal(restRemaining(now - 1, now), 0);
  assert.equal(restRemaining(NaN, now), 0);
});
check("#rest-state activeRest: a stored rest counts only while plausible AND still following the set it was started after", () => {
  const now = 1_000_000;
  const sess = { logged: [{}, {}], rest: newRest({ kind: "set", length: 120, ex: "squat", logged: 2 }, now - 60_000) };
  assert.ok(activeRest(sess, now));
  assert.equal(activeRest({ ...sess, rest: { ...sess.rest, until: now - 1 } }, now), null, "over");
  assert.equal(activeRest({ ...sess, rest: { ...sess.rest, until: now + 3_600_000 } }, now), null, "an hour ahead is not a rest (a clock jump, a corrupt blob)");
  assert.equal(activeRest({ ...sess, rest: { ...sess.rest, until: NaN } }, now), null);
  assert.equal(activeRest({ ...sess, logged: [{}, {}, {}] }, now), null, "a set banked since: the rest belongs to an older set");
  assert.equal(activeRest({ logged: [] }, now), null);
});
check("#rest-state formatRest: m:ss", () => {
  assert.equal(formatRest(125), "2:05"); assert.equal(formatRest(60), "1:00"); assert.equal(formatRest(9), "0:09"); assert.equal(formatRest(0), "0:00");
});
check("#rest-state a nudge on a row from before W273 (no rest_s) teaches nothing — an offset from the 120 s fallback would land on the lift's real rest later", () => {
  assert.equal(adjustRest(newRest({ kind: "set", length: 120, ex: "squat", logged: 1 }, 0), 60, { exercise: "squat" }).remember, null);
});
check("#rest-state adjustRest: ±30 s moves the END (from when the rest began), clamped; only a SET rest teaches the lift its offset", () => {
  const start = 1_000_000;
  const r = newRest({ kind: "set", length: 120, ex: "squat", logged: 2 }, start);
  const up = adjustRest(r, 30, { rest_s: 120 });
  assert.equal(up.rest.length, 150); assert.equal(up.rest.until, start + 150_000); assert.equal(up.remember, 30, "remembered as an OFFSET from the lift's own rest");
  assert.equal(adjustRest(newRest({ kind: "set", length: 30, ex: "squat", logged: 2 }, start), -30, { rest_s: 120 }).rest.length, 30, "never below 30 s");
  assert.equal(adjustRest(newRest({ kind: "round", length: 60, ex: null, logged: 4 }, start), 30, { rest_s: 180 }).remember, null, "a superset round's fixed rest never re-tunes a lift");
  assert.equal(adjustRest(newRest({ kind: "remainder", length: 60, ex: "squat", logged: 4 }, start), 30, { rest_s: 180 }).remember, null,
    "+30 on a 60 s remainder must not teach a 180 s lift to rest LESS (premortem crash-safety-3d)");
});

// --- #edit (W274 — owner: "I can't fix a wrong weight/reps mid-workout"): a banked set is
// corrected IN PLACE — numbers only, never count, order, lift or type — so everything the
// player derives from the log (progress, the cursor, station rounds) cannot move.
{
  const t = (n) => `2026-10-12T10:0${n}:00.000Z`;
  const L1 = { exercise: "L", set_type: "work", weight_kg: 20, reps: 12, completed_at: t(1) };
  const P1 = { exercise: "P", set_type: "work", weight_kg: 15, reps: 10, completed_at: t(2) };
  const L2 = { exercise: "L", set_type: "work", weight_kg: 20, reps: 11, completed_at: t(3) };
  const P2 = { exercise: "P", set_type: "work", weight_kg: 15, reps: 9, completed_at: t(4) };
  const LW = { exercise: "L", set_type: "warmup", weight_kg: 10, reps: 10, completed_at: t(5) };
  const station = [L1, P1, L2, P2, LW];
  check("#edit-logged only the patched fields change — 10.21 kg stays 10.21 kg on a reps-only fix; nothing is mutated", () => {
    const logged = [{ exercise: "db-curl", set_type: "work", weight_kg: 10.21, reps: 8, completed_at: t(1) }];
    const before = JSON.stringify(logged);
    const out = editLoggedSet(logged, 0, { reps: 10 }, { exercise: "db-curl", completed_at: t(1) });
    assert.equal(out[0].weight_kg, 10.21); assert.equal(out[0].reps, 10);
    assert.equal(out.length, 1); assert.equal(out[0].set_type, "work"); assert.equal(out[0].exercise, "db-curl");
    assert.equal(JSON.stringify(logged), before, "input untouched");
  });
  check("#edit-logged refuses (same array back) unless the entry is still the one the editor opened — same lift AND same completed_at", () => {
    assert.strictEqual(editLoggedSet(station, 3, { weight_kg: 30 }, { exercise: "L", completed_at: P2.completed_at }), station);
    assert.strictEqual(editLoggedSet(station, 3, { weight_kg: 30 }, { exercise: "P", completed_at: t(9) }), station);
    assert.strictEqual(editLoggedSet(station, 9, { weight_kg: 30 }, { exercise: "P", completed_at: P2.completed_at }), station);
  });
  check("#edit-logged an empty or junk field (a cleared input, NaN, a negative) is ignored, never written", () => {
    for (const patch of [{ weight_kg: null }, { weight_kg: NaN }, { reps: -1 }, { reps: 2.5 }, {}]) assert.strictEqual(editLoggedSet(station, 1, patch, { exercise: "P", completed_at: P1.completed_at }), station, JSON.stringify(patch));
  });
  check("#edit-station chips carry ABSOLUTE log positions — a round interleaves two lifts, so P's second set is logged[3], not 'P #1'", () => {
    assert.deepStrictEqual(sessionChips(station, "P").map((c) => c.idx), [1, 3]);
    assert.deepStrictEqual(sessionChips(station, "L").map((c) => c.idx), [0, 2, 4]);
    const out = editLoggedSet(station, 3, { weight_kg: 30 }, { exercise: "P", completed_at: P2.completed_at });
    assert.equal(out[3].weight_kg, 30);
    out.forEach((l, k) => { if (k !== 3) assert.strictEqual(l, station[k], `logged[${k}] untouched`); });
  });
  check("#edit-station an edit moves no progress: station rounds, work-set counts and the next unfinished lift are identical", () => {
    const exs = [ex("L", 3, "P"), ex("P", 3, "L"), ex("Z", 2)];
    const out = editLoggedSet(station, 2, { weight_kg: 22.5, reps: 12 }, { exercise: "L", completed_at: L2.completed_at });
    assert.deepStrictEqual(stationProgress(out, exs, 0, 1), stationProgress(station, exs, 0, 1));
    assert.equal(loggedWorkSets(out, "L"), loggedWorkSets(station, "L"));
    assert.equal(nextUnfinishedIndex(out, exs, 0), nextUnfinishedIndex(station, exs, 0));
  });
  check("#edit-display the editor shows a banked weight EXACTLY and reads it back in the same unit — plate rounding re-saved 22.5 lb as 25 lb", () => {
    for (const kg of [62.14, 10.21, 46.49]) assert.ok(Math.abs(parseEdit(editDisplay(kg, "lb"), "lb") - kg) <= 0.005, `${kg} kg via lb`);
    assert.equal(editDisplay(10.21, "lb"), "22.5");
    assert.equal(editDisplay(62.7, "kg"), "62.7"); assert.equal(parseEdit("62.7", "kg"), 62.7);
    assert.equal(parseEdit("62,5", "kg"), 62.5, "a comma decimal (EU keyboards) reads as a point");
    assert.equal(parseEdit("", "kg"), null); assert.equal(parseEdit("abc", "lb"), null); assert.equal(parseEdit("-5", "kg"), null);
  });
  check("#edit-confirm an edit's typo confirmation lives in its OWN key space — it can never wave the Done button's guard through", () => {
    assert.ok(editConfirmKey(L1, 0).startsWith("edit:"));
    assert.deepStrictEqual(unconfirmedFlagged([0], () => "L", () => true, new Set([editConfirmKey(L1, 0)])), [0]);
  });
  check("#edit-confirm one 'Keep it' approves ONE set: a station round's two members (same millisecond) and legacy entries (no completed_at) get distinct keys", () => {
    const sameMs = { exercise: "L", completed_at: t(7) }, other = { exercise: "P", completed_at: t(7) };
    assert.notEqual(editConfirmKey(sameMs, 0), editConfirmKey(other, 1), "W275 review: both members of a round shared edit:<T>");
    assert.notEqual(editConfirmKey({ exercise: "L" }, 2), editConfirmKey({ exercise: "L" }, 5), "every legacy entry shared 'edit:'");
  });
  check("#edit-resolve a value the typo guard flags is NOT written until confirmed — the log keeps the ORIGINAL, never a half-typed intermediate", () => {
    const entry0 = { exercise: "L", set_type: "work", weight_kg: 20.41, reps: 8, completed_at: t(1) };
    const ctx = { entry0, shownW: "45", shownR: "8", unit: "lb", lastKg: 20, priorBests: null, confirmed: false };
    // clear-and-retype "100": "1" and "10" are plausible and written through…
    assert.deepStrictEqual(resolveEdit({ ...ctx, wText: "10", rText: "8" }), { patch: { weight_kg: 4.54, reps: 8 }, flagged: false });
    // …but "100" lb (45.36 kg) trips the guard: the ORIGINAL goes back, not "10" lb
    assert.deepStrictEqual(resolveEdit({ ...ctx, wText: "100", rText: "8" }), { patch: { weight_kg: 20.41, reps: 8 }, flagged: true });
    assert.deepStrictEqual(resolveEdit({ ...ctx, wText: "100", rText: "8", confirmed: true }), { patch: { weight_kg: 45.36, reps: 8 }, flagged: false }, "confirmed: written");
    assert.deepStrictEqual(resolveEdit({ ...ctx, wText: "45", rText: "8" }), { patch: { weight_kg: 20.41, reps: 8 }, flagged: false }, "text as shown → the stored value, exactly");
    assert.equal(resolveEdit({ ...ctx, entry0: { ...entry0, set_type: "warmup" }, wText: "100", rText: "8" }).flagged, false, "warm-ups aren't typo-guarded at banking either");
  });
  check("#edit-resolve (Burst 6) only what changed is judged — a reps fix on a confirmed big-jump set is written, not held for 'Keep it'", () => {
    const entry0 = { exercise: "leg-press", set_type: "work", weight_kg: 150, reps: 10, completed_at: t(1) };
    const ctx = { entry0, shownW: "150", shownR: "10", unit: "kg", lastKg: 40, priorBests: { load_kg: null }, confirmed: false };
    assert.deepStrictEqual(resolveEdit({ ...ctx, wText: "150", rText: "9" }), { patch: { weight_kg: 150, reps: 9 }, flagged: false });
    assert.deepStrictEqual(resolveEdit({ ...ctx, wText: "1500", rText: "10" }), { patch: { weight_kg: 150, reps: 10 }, flagged: true }, "a changed weight is still judged");
    assert.deepStrictEqual(resolveEdit({ ...ctx, todayKg: 150, wText: "155", rText: "10" }), { patch: { weight_kg: 155, reps: 10 }, flagged: false }, "against today's other sets too");
    assert.deepStrictEqual(resolveEdit({ ...ctx, wText: "152.5", rText: "10" }), { patch: { weight_kg: 152.5, reps: 10 }, flagged: false },
      "review K8: nudging the confirmed set's own weight is not asked again — its banked value passed the guard");
  });
  check("#pr-latch an edit can only CLEAR the latch — a PR made by an edit is never 'celebrated' silently, so the session's real later PR still toasts", () => {
    const watch = { e1rm_kg: 125, load_kg: 100 };
    const fixedToPr = [{ exercise: "bench", set_type: "work", weight_kg: 105, reps: 8, completed_at: t(1) }];
    assert.equal(nextPrLatch(false, fixedToPr, "bench", watch), false, "unlatched stays unlatched");
    assert.equal(nextPrLatch(true, fixedToPr, "bench", watch), true, "a celebrated PR that still stands stays latched");
    assert.equal(nextPrLatch(true, [{ ...fixedToPr[0], weight_kg: 10 }], "bench", watch), false, "a typo PR corrected away clears it");
  });
  check("#pr-latch recomputed from the log after an edit: a typo PR corrected away clears it; a deload set never sets it; a real one does", () => {
    const watch = { e1rm_kg: 30, load_kg: 25 };
    const typo = [{ exercise: "L", set_type: "work", weight_kg: 200, reps: 8, completed_at: t(1) }];
    assert.equal(recomputePrLatch(typo, "L", watch), true);
    assert.equal(recomputePrLatch(editLoggedSet(typo, 0, { weight_kg: 20 }, { exercise: "L", completed_at: t(1) }), "L", watch), false);
    assert.equal(recomputePrLatch([{ ...typo[0], deload: true }], "L", watch), false);
    assert.equal(recomputePrLatch([{ ...typo[0], set_type: "warmup" }], "L", watch), false);
    assert.equal(recomputePrLatch(typo, "L", null), false, "no history to beat");
  });
}

// --- #next-set (W279b, owner consideration #3: "if a recommended weight, reps and RPE isn't
// achieved for a set, suggest a more appropriate weight that will hit the prescription").
// The server's W279 formula — set 1's Epley e1RM carried to the target — duplicated here for
// the player and pinned to the server's copy, the checkSetPR precedent.
const w = (weight_kg, reps, extra = {}) => ({ exercise: "x", set_type: "work", weight_kg, reps, ...extra });
const row812 = { rep_range: "8-12", rir: "1-3", inc_kg: 2.5 };
check("#next-set loadForReps is the server's formula, exactly (parity over a grid)", () => {
  for (const kg of [20, 57.5, 100, 142.5]) for (const reps of [1, 5, 8, 12, 15, 20]) for (const rir of [0, 1, 3]) for (const t of [6, 8, 12]) for (const tr of [0, 1, 2])
    assert.strictEqual(loadForReps(kg, reps, rir, t, tr), loadForRepsServer(kg, reps, rir, t, tr));
});
// --- #fatigue (W288, Burst 5 — owner: "70 kg × 5 at failure… it suggested 65 kg. That's like a 30% volume
// increase"). The next set is NOT fresh: reps fall set to set even with 3–5 min rest (Richmond & Godard
// 2004; Willardson & Burkett 2005/2006), so the hint carries the set's capacity (reps + RIR) forward
// LESS what the next set loses — ~20% after a set ending at ≤ 1 RIR, ~10% at 2–3, none from 4 (engine
// estimates). The player's copy is pinned to the server's, like loadForReps.
check("#fatigue nextSetCapacity is the server's formula, exactly (parity over a grid)", () => {
  for (const reps of [1, 5, 6, 8, 12, 15, 20]) for (const rir of [null, undefined, 0, 1, 2, 3, 4, 5])
    assert.strictEqual(playerCore.nextSetCapacity(reps, rir), serverCore.nextSetCapacity(reps, rir), `${reps} reps @ ${rir}`);
});
check("#fatigue the next set keeps ~80% of the capacity after a near-failure set, ~90% after 2-3 in reserve, all of it from 4", () => {
  assert.strictEqual(serverCore.nextSetCapacity(5, 0), 4, "5 at failure → 4 reps' worth on the next set");
  assert.strictEqual(serverCore.nextSetCapacity(5, null), 4, "unlogged effort reads as near failure (W279's reading)");
  assert.strictEqual(serverCore.nextSetCapacity(8, 1), 7.2);
  assert.strictEqual(serverCore.nextSetCapacity(10, 2), 10.8, "(10 + 2) · 0.9");
  assert.strictEqual(serverCore.nextSetCapacity(10, 3), 11.7);
  assert.strictEqual(serverCore.nextSetCapacity(8, 4), 12, "4+ in reserve: nothing lost");
});
check("#fatigue the owner's case: 70 kg × 5 at failure on 6-10 / 1-2 → 62.5 kg for the next set, not 65", () => {
  const row610 = { rep_range: "6-10", rir: "1-2", inc_kg: 2.5 };
  // 70·(1 + 4/30)/(1 + 7/30) = 64.32 → 62.5. The fresh-set formula gave 66.2 → 65, which after a failure
  // set leaves ~6.7 reps in the tank — 6 reps would land under the 1-2 band.
  assert.deepStrictEqual(nextSetHint(w(70, 5, { rir: 0 }), row610), { kind: "lighter", kg: 62.5, from_kg: 70, reps: 5, min: 6, max: 10, rir: 0, band: "1-2", target_reps: 7 },
    "target_reps is what the same model predicts at 62.5: 30·(70·(1 + 4/30)/62.5 − 1) − 1 = 7.1 → 7");
  assert.strictEqual(nextSetHint(w(70, 5), row610).kg, 62.5, "effort unlogged: the same");
  assert.strictEqual(nextSetHint(w(70, 5, { rir: 0 }), { ...row610, inc_kg: 1 }).kg, 64, "in a lift's 1 kg steps");
});
check("#next-set a set UNDER the range near failure → a lighter next set that lands in it (100×6 on 8-12 → 87.5)", () => {
  // 100·(1 + 4.8/30)/(1 + 9/30) = 89.2 → 87.5 (was 90 before the fatigue allowance, W288).
  assert.deepStrictEqual(nextSetHint(w(100, 6), row812), { kind: "lighter", kg: 87.5, from_kg: 100, reps: 6, min: 8, max: 12, rir: null, band: "1-3", target_reps: 9 });
  assert.strictEqual(nextSetHint(w(100, 6, { rir: 1 }), row812).kg, 90, "1 in reserve means more capacity (7 · 0.8 = 5.6 → 91.3) → a smaller ease");
});
check("#next-set a set well OVER the range, or far easier than the band → a heavier next set", () => {
  assert.deepStrictEqual(nextSetHint(w(40, 15), row812), { kind: "heavier", kg: 42.5, from_kg: 40, reps: 15, min: 8, max: 12, rir: null, band: "1-3", target_reps: 9 },
    "the model predicts 9 at 42.5 after a 15-rep set, not the range top (Burst 5 review C11)");
  assert.strictEqual(nextSetHint(w(40, 10, { rir: 5 }), row812).kind, "heavier", "RIR 5 against a 1-3 band");
  assert.strictEqual(nextSetHint(w(40, 13), row812), null, "one rep over the top: on target enough (the next session adds load)");
});
check("#next-set no hint when on target, stopped early, a warm-up, planned-easy, or at bodyweight", () => {
  assert.strictEqual(nextSetHint(w(100, 9), row812), null);
  // (W305, deliberate: "stopped with 3 in the tank" was silent. The capacity model now judges it — (6 + 3)·0.9 = 8.1 → 7.1
  // at the band's near edge, under 8 — so it says lighter; see the #next-set (W305) checks below.)
  assert.strictEqual(nextSetHint(w(100, 6, { rir: 3 }), row812).kind, "lighter");
  assert.strictEqual(nextSetHint({ ...w(40, 4), set_type: "warmup" }, row812), null);
  assert.strictEqual(nextSetHint(w(100, 6, { deload: true }), row812), null, "deload sets are planned easy");
  assert.strictEqual(nextSetHint(w(0, 4), row812), null);
  assert.strictEqual(nextSetHint(null, row812), null);
});
check("#next-set a dumbbell isolation moves in its own 1 kg steps, capped at ±20%", () => {
  assert.strictEqual(nextSetHint(w(10, 8), { rep_range: "12-20", rir: "1-3", inc_kg: 1 }).kg, 8);
  assert.strictEqual(nextSetHint(w(100, 1), row812).kg, 80, "a far miss is capped at −20%");
});

// --- W305 (considerations iteration, Burst 8 — owner: "I didn't achieve the recommended reps and intensity and it didn't
// suggest a more appropriate weight"). Every miss the model can judge now gets an answer: under the range with reps
// left is decided by the capacity model (same weight, aim for N — or lighter when that can't reach the range), and a set
// in the range but past the band hints lighter only when the next set would miss ITS aim (never turning straight sets
// into back-offs when the aims already expect the drop).
const pickHint = (h) => h && { kind: h.kind, kg: h.kg, target_reps: h.target_reps };
check("#next-set (W305 a) under the range WITH reps left: the same weight, aim for N, when the capacity is there", () => {
  assert.deepStrictEqual(pickHint(nextSetHint(w(100, 7, { rir: 3 }), row812)), { kind: "same", kg: 100, target_reps: 8 }, "(7 + 3)·0.9 = 9 → 8 at RIR 1");
  assert.deepStrictEqual(pickHint(nextSetHint(w(60, 5, { rir: 5 }), row812)), { kind: "same", kg: 60, target_reps: 9 }, "(5 + 5) → 9 at RIR 1");
});
check("#next-set (W305 a) …and lighter when it isn't: 6 @ RIR 3 reaches only 7 after the set's cost", () => {
  assert.equal(nextSetHint(w(100, 6, { rir: 3 }), row812).kind, "lighter");
});
// (Burst 8 review #4/#28/#45, deliberate: W305's in-range "lighter" is gone. Following it made back-off sets the engine
// misreads — next session's aims became [12,12,12] (#4), one set earned the load bump (#45) — and it fired OVER the range
// too (#28). A set in or over the range taken past the band gets no hint, exactly as before W305.)
check("#next-set (Burst 8 review #4/#28/#45) a set IN or just over the range, past the band, gets no hint — never a back-off", () => {
  const b812 = { rep_range: "8-12", rir: "1-2", inc_kg: 2.5 };
  assert.strictEqual(nextSetHint(w(100, 11, { rir: 0 }), b812), null, "#4: 100×11 @0 — following 97.5 kg taught next session [12,12,12]");
  assert.strictEqual(nextSetHint(w(50, 11, { rir: 0 }), { rep_range: "6-10", rir: "1-2", inc_kg: 2.5 }, { aim: 10, nextAim: 9 }), null, "#28: 11 on 6-10 is OVER the range, never 'in the range — go lighter'");
  assert.strictEqual(nextSetHint(w(60, 13, { rir: 0 }), b812, { aim: 12, nextAim: 11 }), null, "#45: one set at 60 must not earn next session's bump");
  assert.strictEqual(nextSetHint(w(100, 9, { rir: 0 }), row812), null, "in the range at failure: no hint (as before W305)");
});
// --- Burst 8 review #22: under the range with reps left is judged against the NEXT set's served aim (W289 aims can sit
// under the range), else the range's bottom — 150×5 @2 against aims [6,5,6] can still do 5 at 150: the same weight.
check("#next-set (Burst 8 review #22) under the range with reps left: judged against the next set's own aim", () => {
  const row = { rep_range: "6-10", rir: "1-2", inc_kg: 2.5, suggested_kg: 150, rep_targets: [6, 5, 6] };
  assert.deepStrictEqual(pickHint(nextSetHint(w(150, 5, { rir: 2 }), row, { aim: 6, nextAim: 5 })), { kind: "same", kg: 150, target_reps: 5 }, "(5 + 2)·0.9 − 1 = 5.3 ≥ the next aim of 5 — never 'Try 145 kg'");
  assert.equal(nextSetHint(w(150, 5, { rir: 2 }), row, { aim: 6 }).kind, "lighter", "no next aim (off the served weight): the range's bottom, 6");
  assert.equal(nextSetHint(w(150, 4, { rir: 2 }), row, { aim: 6, nextAim: 5 }).kind, "lighter", "(4 + 2)·0.9 − 1 = 4.4: under even that aim");
  // …and the aim only ever LOWERS the bar (integration of the #22 fix): an aim above the range's bottom never turns a set
  // stopped early into a back-off — 100×7 @3 on 8-12 against aims [12,11,10] can still land 8 at 100: the same weight.
  const hi = { rep_range: "8-12", rir: "1-2", inc_kg: 2.5, suggested_kg: 100, rep_targets: [12, 11, 10] };
  assert.deepStrictEqual(pickHint(nextSetHint(w(100, 7, { rir: 3 }), hi, { aim: 12, nextAim: 11 })), { kind: "same", kg: 100, target_reps: 8 },
    "(7 + 3)·0.9 − 1 = 8 reaches the range — a next aim of 11 is no reason to go lighter");
});
// --- Burst 8 review #8: a 'same' hint names EXACTLY the weight banked, at the precision typed — a typed 22.5 lb dumbbell
// is never "25 lb again" (heavier, after a set that fell short).
check("#next-set (Burst 8 review #8) a 'same' hint keeps the weight as typed: 22.5 lb stays 22.5 lb", () => {
  const lbPlate = (kg) => Math.round((kg * 2.2046226) / 5) * 5;
  const kg = Math.round((22.5 / 2.2046226) * 100) / 100; // what bankKg stores: 10.21
  const h = nextSetHint(w(kg, 7, { rir: 3 }), row812);
  assert.equal(h.kind, "same", "precondition: (7 + 3)·0.9 − 1 = 8 reaches the range");
  assert.strictEqual(hintInUnit(h, lbPlate, 5, "lb"), 22.5);
  assert.strictEqual(hintInUnit(h, (k) => Math.round(k * 4) / 4, 2.5, "kg"), 10.21, "in kg too: the banked figure, not the plate");
});
// --- Burst 8 review #40 (R5): a barbell 'lighter' never goes under the empty bar; at the bar, nothing lighter exists.
check("#next-set (Burst 8 review #40) a barbell 'lighter' is floored at the empty bar — and at the bar there is none", () => {
  const bar = { rep_range: "8-12", rir: "1-2", inc_kg: 2.5, equipment: "barbell" };
  assert.strictEqual(nextSetHint(w(20, 6, { rir: 0 }), bar), null, "20 kg is the bar: never 'Try 17.5 kg'");
  assert.strictEqual(nextSetHint(w(22.5, 5, { rir: 0 }), bar).kg, 20, "17.5 → the bar");
  assert.strictEqual(nextSetHint(w(20, 6, { rir: 0 }), { ...bar, equipment: "dumbbell" }).kg, 17.5, "control: a dumbbell isn't floored");
  const lbPlate = (kg) => Math.round((kg * 2.2046226) / 5) * 5;
  const h = nextSetHint(w(20.41, 6, { rir: 0 }), bar); // a 45-lb bar banked in pounds; 20 kg rounds back onto 45 lb
  assert.strictEqual(hintInUnit(h, lbPlate, 5, "lb"), null, "never nudged to a 40-lb 'bar'");
});
// --- Burst 8 review #7/#34/#37 (R5/R6/R8): the held weight's lighter alternative as the player OFFERS it — a real step under
// the served weight in the lift's own unit, never under the empty bar, never more than ~20% down; filled with the reps
// the model predicts there (never the range's bottom). Null when none: then the note names none either.
{
  const lbPlate = (kg) => Math.round((kg * 2.2046226) / 5) * 5, lbToKg = (v) => Math.round((v / 2.2046226) * 100) / 100;
  const kgPlate = (kg) => Math.round(kg * 4) / 4;
  const inLb = (served) => ({ toDisp: lbPlate, toKg: lbToKg, step: 5, served, unit: "lb" });
  const inKg = (served) => ({ toDisp: kgPlate, toKg: (v) => v, step: 2.5, served, unit: "kg" });
  check("#alt-offer (Burst 8 review #7) in pounds, a real step below the served plate — none when that is over ~20% down", () => {
    const lat = { exercise: "dumbbell-lateral-raise", equipment: "dumbbell", rep_range: "8-12", rir: "1-2", suggested_kg: 9.07, last_kg: 9.07, alt_kg: 8, alt_reps: 9 };
    assert.strictEqual(playerCore.altOffer(lat, inLb(20)), null, "8 kg rounds onto the served 20 lb; the real step, 15 lb, is 25% down");
    assert.deepStrictEqual(playerCore.altOffer(lat, inKg(9)), { w: 8, reps: 9 }, "in kg: 8 kg, at the server's own reps");
    const lat30 = { ...lat, suggested_kg: 13.61, last_kg: 13.61, alt_kg: 12, alt_reps: 9 };
    assert.equal(playerCore.altOffer(lat30, inLb(30)).w, 25, "12 kg → 26.5 → 25 lb: a real plate down, within 20%");
    assert.equal(playerCore.altOffer({ ...lat, suggested_kg: 22.68, last_kg: 22.68, alt_kg: 21.68 }, inLb(50)).w, 45, "21.68 kg rounds back onto 50 lb: the next plate down, 45 lb, is offered");
    const bench = { exercise: "barbell-bench-press", equipment: "barbell", rep_range: "8-12", rir: "1-2", suggested_kg: 100, last_kg: 100, alt_kg: 92.5, alt_reps: 9 };
    assert.equal(playerCore.altOffer(bench, inLb(220)).w, 205);
  });
  check("#alt-offer (Burst 8 review #37) never under the empty bar: 45 lb / 20 kg is as light as a barbell goes", () => {
    const bar = { exercise: "barbell-overhead-press", equipment: "barbell", rep_range: "8-12", rir: "1-2", suggested_kg: 20.41, last_kg: 20.41, alt_kg: 20, alt_reps: 8 };
    assert.strictEqual(playerCore.altOffer(bar, inLb(45)), null, "20 kg is 45 lb — the next plate down, 40 lb, is under the bar");
    assert.strictEqual(playerCore.altOffer({ ...bar, suggested_kg: 20, last_kg: 20, alt_kg: 17.5 }, inKg(20)), null, "an old row's 17.5 kg on a 20 kg bar");
    assert.equal(playerCore.altOffer({ ...bar, suggested_kg: 22.68, last_kg: 22.68, alt_kg: 20 }, inLb(50)).w, 45, "50 lb → the 45-lb bar");
  });
  check("#alt-offer (Burst 8 review #34) 'Use X' fills the reps the model predicts at the offered weight, not the range's bottom", () => {
    const legExt = { exercise: "leg-extension", equipment: "machine", rep_range: "10-15", rir: "1-2", suggested_kg: 20, last_kg: 20, alt_kg: 17.5, alt_reps: 14 };
    assert.deepStrictEqual(playerCore.altOffer(legExt, inKg(20)), { w: 17.5, reps: 14 }, "20×9 @0 → about 13.6 at 17.5 kg, never 10");
    assert.equal(playerCore.altOffer(legExt, inLb(45)).reps, 12, "in pounds the offered 40 lb (18.14 kg) is a little heavier: the same model, carried there (30·(26/18.14 − 1) − 1 ≈ 12)");
    assert.equal(playerCore.altOffer({ ...legExt, alt_reps: undefined }, inKg(20)).reps, 10, "an older row without the model's reps: the range's bottom, as before");
  });
  // W305h (fix C6): the server's alt_reps is clamped to the range, so re-deriving from it under-fills a plate that rounds
  // UP from alt_kg; the row's alt_e1rm (set 1's own Epley e1RM) predicts the reps exactly at any offered weight.
  check("#alt-offer (fix C6) the reps at a pounds plate that rounds UP come from set 1's e1RM, never the clamped alt_reps", () => {
    const e1 = Math.round(20.41 * (1 + 8 / 30) * 100) / 100; // 45 lb × 7 @1 on 8-12
    const le = { exercise: "leg-extension", equipment: "machine", rep_range: "8-12", rir: "1-2", suggested_kg: 20.41, last_kg: 20.41, alt_kg: 17.5, alt_reps: 12, alt_e1rm: e1 };
    const o = playerCore.altOffer(le, inLb(45));
    assert.equal(o.w, 40);
    assert.equal(o.reps, Math.max(8, Math.min(12, Math.round(30 * (e1 / lbToKg(40) - 1) - 1))), "the model from set 1 at 40 lb");
    assert.equal(o.reps, 12, "(the clamped 12 at 17.5 kg re-derived at 40 lb said 10)");
  });
  // W305h (fix C4): the Olympic bar floors only a lift done ON it — an EZ-bar lift lighter than 20 kg / 45 lb still has
  // a lighter weight, in the hint and in the offer.
  check("#alt-offer (fix C4) a barbell-tagged lift lighter than the full bar (an EZ bar) still gets its lighter alternative", () => {
    const ez = { exercise: "skullcrusher", equipment: "barbell", rep_range: "8-12", rir: "1-2", suggested_kg: 15.88, last_kg: 15.88, alt_kg: 13.61, alt_reps: 10 };
    assert.equal(playerCore.altOffer(ez, inLb(35))?.w, 30, "35 lb → 30 lb, never floored to a 45-lb bar it isn't on");
  });
}
check("#next-set (fix C4) an EZ-bar set under the full bar's weight still gets 'lighter' — the Olympic bar is no floor under it", () => {
  const h = nextSetHint(w(15, 6, { rir: 0 }), { rep_range: "8-12", rir: "1-2", inc_kg: 2.5, equipment: "barbell" });
  assert.equal(h?.kind, "lighter");
  assert.equal(h.kg, 12.5);
  assert.equal(nextSetHint(w(20, 6, { rir: 0 }), { rep_range: "8-12", rir: "1-2", inc_kg: 2.5, equipment: "barbell" }), null, "control: ON the 20 kg bar, nothing lighter");
});
check("#parity (fix C3) the server's pounds bar is the player's: 45 lb at the same lb-per-kg", () => {
  assert.equal(serverCore.EMPTY_BAR_LB, playerCore.EMPTY_BAR_LB);
  assert.equal(serverCore.LB_PER_KG, playerCore.LB_PER_KG);
  assert.equal(serverCore.EMPTY_BAR_LB_KG, Math.round((playerCore.EMPTY_BAR_LB / playerCore.LB_PER_KG) * 100) / 100);
});
check("#next-set (W305) a 'same' hint stays on the plate it was on (no forced move)", () => {
  assert.strictEqual(hintInUnit({ kind: "same", kg: 100, from_kg: 100 }, (k) => k, 2.5), 100);
  assert.strictEqual(hintInUnit({ kind: "same", kg: 20, from_kg: 20 }, (k) => Math.round(k * 2.2046226 / 5) * 5, 5), 45, "in pounds: the plate shown");
});
check("#next-set (W305) the owner's case — under the range at RIR 0 — says lighter", () => {
  assert.equal(nextSetHint(w(100, 6, { rir: 0 }), row812).kind, "lighter");
});

// --- Burst 5 review (C1): an aim below the range is still an aim. 150×5,4,5 held at 150 aims 6 · 5 · 6 on a
// 6-10 range; a set-2 that meets its aim of 5 must not be called "under the range — go lighter". The player
// passes the banked set's own aim when the weight is still the served one; a real miss still hints.
check("#rep-aim-hint a set that meets its own aim is never called a miss; a set under its aim still is", () => {
  const row = { rep_range: "6-10", rir: "1-2", inc_kg: 2.5, suggested_kg: 150, rep_targets: [6, 5, 6] };
  assert.strictEqual(nextSetHint(w(150, 5), row, { aim: 5 }), null, "the aim was 5 and the set did 5");
  assert.strictEqual(nextSetHint(w(150, 5, { rir: 1 }), row, { aim: 5 }), null);
  assert.strictEqual(nextSetHint(w(150, 4), row, { aim: 5 })?.kind, "lighter", "4 against an aim of 5 is a real miss");
  assert.strictEqual(nextSetHint(w(150, 5), row)?.kind, "lighter", "no aim (the weight was moved): judged on the range, as before");
  assert.strictEqual(nextSetHint(w(150, 12), row, { aim: 6 })?.kind, "heavier", "the aim never hides a set far over the range");
});
// --- Burst 5 fix verification (R12): the aim exempts a set only at the effort the aim assumed — an aim of 7 under
// a 2-3 band met at RIR 0 is 2-3 reps of capacity short: still a miss.
check("#rep-aim-hint an aim met at the effort it assumed is on plan; met at failure under a wider band it is still a miss", () => {
  const row = { rep_range: "8-12", rir: "2-3", inc_kg: 2.5, suggested_kg: 100, rep_targets: [7, 7] };
  assert.strictEqual(nextSetHint(w(100, 7), row, { aim: 7 }), null, "effort unlogged: trust the aim");
  assert.strictEqual(nextSetHint(w(100, 7, { rir: 2 }), row, { aim: 7 }), null, "at the band's near edge: on plan");
  assert.strictEqual(nextSetHint(w(100, 7, { rir: 0 }), row, { aim: 7 })?.kind, "lighter", "at failure: the weight is too heavy for this week's band");
});
// --- (C11, the guard) the heavier hint stays quiet when even one step up would land under the range: 10 kg × 6
// at RIR 4 → 12.5 kg is +25%, where the model predicts about 1 rep.
check("#next-set the heavier hint never offers a step the model says would land under the range", () => {
  const row610 = { rep_range: "6-10", rir: "1-2", inc_kg: 2.5 };
  assert.strictEqual(nextSetHint(w(10, 6, { rir: 4 }), row610), null, "12.5 kg would predict ~1 rep");
  assert.strictEqual(nextSetHint(w(60, 12), row610)?.kg, 62.5, "a step that still lands in the range is offered");
});
// --- Round 2 (N8/N9): the hint is judged at the weight actually OFFERED. A pounds user is offered the next 5-lb
// plate, which can be heavier than the kg it rounds from; added load on a bodyweight lift is not the whole load,
// so the guard and the predicted reps don't apply there (its aim is the range edge, as before).
check("#next-set finalizeHint: the guard and the aim at the offered weight; never Epley on bodyweight added load", () => {
  const r812 = { rep_range: "8-12", rir: "1-2", inc_kg: 1 };
  const set = w(13.61, 14); // 30 lb × 14
  const kgHint = nextSetHint(set, r812);
  assert.strictEqual(kgHint?.kind, "heavier", "precondition: 14.5 kg passes at its own weight");
  assert.strictEqual(playerCore.finalizeHint(kgHint, set, r812, 15.88), null, "35 lb predicts under 8: no heavier step");
  assert.strictEqual(playerCore.finalizeHint(kgHint, set, r812, kgHint.kg)?.target_reps, kgHint.target_reps, "at its own weight it is idempotent");
  const bw = { rep_range: "6-10", rir: "1-2", inc_kg: 2.5, equipment: "bodyweight" };
  const pull = nextSetHint(w(20, 13), bw);
  assert.deepStrictEqual([pull?.kind, pull?.kg, pull?.target_reps], ["heavier", 22.5, 10], "+20 kg → +22.5 kg is a ~2-3% step: offered, aiming at the range top");
  assert.strictEqual(nextSetHint(w(5, 10, { rir: 4 }), bw)?.kind, "heavier", "+5 kg × 10 @ 4 in reserve still gets its step");
});
// --- Round 2 (N10): a unit toggle re-stamps an untouched served pre-fill exactly, so "the served weight" survives
// it on a 1 kg lift (25 lb → 10.5 kg, not 11.25); a moved value converts as before.
check("#units a unit toggle keeps an untouched served pre-fill exact", () => {
  const servedIn = (k, u) => (u === "lb" ? 25 : 10.5);
  const kept = normalizeWeightsToUnits({ weights: { 0: 25 }, stamps: { 0: "lb" }, fallbackUnit: "lb", unitOf: () => "kg", servedIn });
  assert.strictEqual(kept.weights[0], 10.5);
  const moved = normalizeWeightsToUnits({ weights: { 0: 30 }, stamps: { 0: "lb" }, fallbackUnit: "lb", unitOf: () => "kg", servedIn });
  assert.strictEqual(moved.weights[0], convertDispWeight(30, "lb", "kg"), "a moved weight converts as before");
  assert.strictEqual(normalizeWeightsToUnits({ weights: { 0: 25 }, stamps: { 0: "lb" }, fallbackUnit: "lb", unitOf: () => "kg" }).weights[0], convertDispWeight(25, "lb", "kg"), "no servedIn: unchanged behaviour");
  // Round 3 (K4): never re-stamp to zero — 1 kg served rounds to 0 lb on the plate grid; 0 means "bodyweight only".
  const tiny = normalizeWeightsToUnits({ weights: { 0: 1 }, stamps: { 0: "kg" }, fallbackUnit: "kg", unitOf: () => "lb", servedIn: (k, u) => (u === "kg" ? 1 : 0) });
  assert.strictEqual(tiny.weights[0], convertDispWeight(1, "kg", "lb"), "a nonzero weight never converts to zero");
  assert.ok(tiny.weights[0] > 0);
});
// --- (R4) the served-weight tolerance is half the lift's OWN step: 1 kg on a dumbbell isolation in kg, a 5 lb plate in lb.
check("#rep-seed servedStep: half the lift's own step decides 'the same load'", () => {
  assert.strictEqual(playerCore.servedStep("kg", 1), 1, "a dumbbell isolation moves in 1 kg");
  assert.strictEqual(playerCore.servedStep("kg", 2.5), 2.5);
  assert.strictEqual(playerCore.servedStep("kg", undefined), 2.5);
  assert.strictEqual(playerCore.servedStep("lb", 1), 5, "pounds move in 5 lb plates");
  assert.strictEqual(playerCore.sameLoad(9, 8, playerCore.servedStep("kg", 1)), false, "8 → 9 kg on a 1 kg lift is a move");
  assert.strictEqual(playerCore.sameLoad(149.75, 150, playerCore.servedStep("kg", 2.5)), true, "a unit toggle is not");
});

// --- Burst 5 review (C2): "still at the served weight" survives a kg/lb toggle (330 lb → 149.75 kg) and the
// one-plate nudge; one stepper step off is a moved weight.
check("#rep-seed sameLoad: within half a display step is the same load", () => {
  assert.strictEqual(playerCore.sameLoad(149.75, 150, 2.5), true, "330 lb toggled to kg");
  assert.strictEqual(playerCore.sameLoad(147.5, 150, 2.5), false, "one step down");
  assert.strictEqual(playerCore.sameLoad(330, 330, 5), true);
  assert.strictEqual(playerCore.sameLoad(325, 330, 5), false);
  assert.strictEqual(playerCore.sameLoad("150", 150, 2.5), true, "a typed value is a string");
  assert.strictEqual(playerCore.sameLoad(null, 150, 2.5), false);
});

// --- #rep-seed (W289, Burst 5 — owner: "150kg × 5,4,5 last workout and now it is suggesting 150kg × 10,10,10").
// The reps stepper starts on today's AIM for this set — derived from the row and the BANKED count, never
// stored (crash-safe by derivation) — else the last banked reps (today's carry-over, from set 2 on), else
// the top of the range. An aim that doesn't fit the row's own range is ignored: a swapped-in lift keeps
// the SLOT's range (PRESCRIPTION_KEYS), so its own aim may not fit.
check("#rep-seed the aim for set k, from the row (a 4th set reuses the last aim)", () => {
  const row = { rep_range: "6-10", rep_targets: [6, 5, 6] };
  assert.deepStrictEqual([0, 1, 2, 3].map((k) => playerCore.repSeed(row, k, { lastReps: 9 })), [6, 5, 6, 6]);
});
check("#rep-seed no aim: the top of the range on set 1, the last banked reps after (today's behaviour)", () => {
  const row = { rep_range: "6-10" };
  assert.strictEqual(playerCore.repSeed(row, 0, { lastReps: null }), 10);
  assert.strictEqual(playerCore.repSeed(row, 1, { lastReps: 7 }), 7);
  assert.strictEqual(playerCore.repSeed(row, 1, {}), 10, "nothing banked yet: the top");
});
check("#rep-seed a malformed aim, or one outside THIS row's range, is ignored", () => {
  for (const t of [[], [6, "5"], [6, 0], [6, 12], [6.5], "6,5,6", null, undefined])
    assert.strictEqual(playerCore.repSeed({ rep_range: "6-10", rep_targets: t }, 0, { lastReps: null }), 10, JSON.stringify(t));
  assert.strictEqual(playerCore.validAim({ rep_range: "12-20", rep_targets: [14, 13] })?.join(), "14,13");
  assert.strictEqual(playerCore.validAim({ rep_range: "6-10", rep_targets: [14, 13] }), null, "a swapped slot's range");
});
check("#rep-seed once the weight is moved off the served pre-fill, the aim no longer applies — the last banked reps carry", () => {
  const row = { rep_range: "6-10", rep_targets: [6, 5, 6] };
  assert.strictEqual(playerCore.repSeed(row, 1, { lastReps: 7, atServed: false }), 7);
  assert.strictEqual(playerCore.repSeed(row, 0, { lastReps: null, atServed: false }), 10);
});
check("#rep-seed lastWorkReps reads the last banked WORK set of that lift (warm-ups and other lifts don't count)", () => {
  const logged = [{ exercise: "a", set_type: "work", reps: 8 }, { exercise: "b", set_type: "work", reps: 12 }, { exercise: "a", set_type: "warmup", reps: 5 }];
  assert.strictEqual(playerCore.lastWorkReps(logged, "a"), 8);
  assert.strictEqual(playerCore.lastWorkReps(logged, "c"), null);
  assert.strictEqual(playerCore.lastWorkReps(undefined, "a"), null);
});
check("#rep-seed topReps reads a range's top (moved from app.js unchanged)", () => {
  assert.deepStrictEqual(["6-10", "12-20", "", undefined].map(playerCore.topReps), [10, 20, 10, 10]);
});

// --- #targets (W280): what the plan asked of each lift TODAY rides with the workout, so the
// engine (and the read-out) can tell a skipped or unfinished set from a full session — the
// ORIGINAL set count (planned_sets survives a skip's shrink), and planned-easy lifts flagged.
check("#targets buildTargets: the original set count, range, band and suggestion per lift; planned-easy flagged", () => {
  const sess = { deload: false, ex: [
    { exercise: "a", sets: 2, planned_sets: 3, rep_range: "8-12", rir: "1-3", suggested_kg: 60, name: "A", cue: "x" },
    { exercise: "b", sets: 3, rep_range: "10-15", rir: "0-2", suggested_kg: null, eased: true },
    { exercise: "c", sets: 3, rep_range: "6-10" },
  ] };
  assert.deepStrictEqual(buildTargets(sess), [
    { exercise: "a", sets: 3, rep_range: "8-12", rir: "1-3", suggested_kg: 60 },
    { exercise: "b", sets: 3, rep_range: "10-15", rir: "0-2", suggested_kg: null, deload: true },
    { exercise: "c", sets: 3, rep_range: "6-10", rir: null, suggested_kg: null },
  ]);
  assert.strictEqual(buildTargets({ ...sess, deload: true }).every((t) => t.deload === true), true, "a deload week: every lift planned easy");
  assert.deepStrictEqual(buildTargets(null), []);
});
// W298 (considerations iteration, Burst 7 — measure first): the per-set aims the player served travel with the
// workout, so later learning (the fade check, item 9's estimates) can judge a set against what it was ASKED, not
// only the range. Only aims the player itself would use (validAim) are sent; anything else is omitted, never null.
check("#targets buildTargets carries the served rep aims when the player would use them; junk aims are omitted", () => {
  const sess = { deload: false, ex: [
    { exercise: "a", sets: 3, rep_range: "6-10", rir: "1-2", rep_targets: [7, 6, 6] },
    { exercise: "b", sets: 3, rep_range: "6-10", rep_targets: [11, 9, 9] }, // over the range top: the player ignores it
    { exercise: "c", sets: 2, rep_range: "8-12", rep_targets: "8,8" },
  ] };
  const t = buildTargets(sess);
  assert.deepStrictEqual(t[0].rep_targets, [7, 6, 6], "the aims served today");
  assert.ok(!("rep_targets" in t[1]) && !("rep_targets" in t[2]), "aims the player wouldn't use are not sent");
});

// --- #skip (W281, owner: "need ability to skip a set mid-workout"). A skip SHRINKS today's
// target (`sets`, the field every "where am I" helper reads), so progress stays derived from
// banked sets; `planned_sets` keeps the original for the workout's targets (W280).
const row = (exercise, sets, extra = {}) => ({ exercise, sets, planned_sets: sets, rep_range: "8-12", rir: "1-3", ...extra });
const banked = (exercise, n) => Array.from({ length: n }, () => ({ exercise, set_type: "work", weight_kg: 50, reps: 10 }));
const S = (ex, logged, i, extra = {}) => ({ ex, logged, i, set: loggedWorkSets(logged, ex[i].exercise), weights: {}, reps: {}, eff: {}, wUnits: {}, ...extra });
const json = (x) => JSON.parse(JSON.stringify(x)); // a save + reload (crash-mirror round trip)
check("#skip mid-lift: one fewer set today, the cursor stays, the original count is kept, and the rest timer clears", () => {
  const r = skipSet(S([row("a", 3), row("b", 3)], banked("a", 1), 0, { rest: { until: 9e15 } }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.sess.ex[0].sets, r.sess.ex[0].planned_sets, r.sess.i, r.sess.set, "rest" in r.sess, r.completes], [2, 3, 0, 1, false, false]);
});
check("#skip the last set a lift still owes: it's done for today — on to the next lift that still owes sets", () => {
  const r = skipSet(S([row("a", 3), row("b", 3)], banked("a", 2), 0));
  assert.deepStrictEqual([r.sess.ex[0].sets, r.sess.i, r.sess.set, !!r.sess.complete], [2, 1, 0, false]);
});
check("#skip the final set of the whole workout completes it — and the player is told first (skipWouldFinish)", () => {
  const s = S([row("a", 2), row("b", 2)], [...banked("a", 2), ...banked("b", 1)], 1);
  assert.strictEqual(skipWouldFinish(s), true);
  const r = skipSet(s);
  assert.deepStrictEqual([r.completes, r.sess.complete, r.sess.i], [true, true, 1], "the cursor never goes past the end");
  assert.strictEqual(skipWouldFinish(S([row("a", 3), row("b", 2)], banked("a", 1), 0)), false);
});
check("#skip advancing scans from the START — a lift deferred earlier in the order is never jumped", () => {
  // "a" was deferred to... no: a lift BEFORE the cursor still owes sets (an old-build order).
  const r = skipSet(S([row("a", 2), row("b", 1)], banked("a", 1), 1));
  assert.deepStrictEqual([r.sess.i, r.sess.set, !!r.sess.complete], [0, 1, false]);
});
check("#skip undo: right after, and after a crash/reload, restores the count and the cursor; refused once anything else happened", () => {
  const s0 = S([row("a", 3), row("b", 3)], banked("a", 2), 0);
  const skipped = skipSet(s0).sess;                        // a done → cursor on b
  for (const s of [skipped, json(skipped)]) {
    const u = undoSkip(s);
    assert.strictEqual(u.ok, true);
    assert.deepStrictEqual([u.sess.ex[0].sets, u.sess.i, u.sess.set, "lastSkip" in u.sess], [3, 0, 2, false]);
  }
  assert.strictEqual(undoSkip({ ...skipped, logged: [...skipped.logged, ...banked("b", 1)] }).ok, false, "a set banked since: the moment has passed");
  assert.strictEqual(undoSkip({ ...skipped, ex: [skipped.ex[1], skipped.ex[0]] }).ok, false, "the order changed (a defer or a swap): refused");
  assert.strictEqual(undoSkip(S([row("a", 3)], [], 0)).ok, false, "nothing to undo");
});
check("#skip a station round: both members lose this round (rounds stay balanced); a 3/2 pair's remainder finishes alone", () => {
  const two = [row("a", 3, { superset_with: "b" }), row("b", 2, { superset_with: "a" }), row("c", 3)];
  const r = skipRound(S(two, [...banked("a", 1), ...banked("b", 1)], 0), 0, 1);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.sess.ex[0].sets, r.sess.ex[1].sets], [2, 1]);
  assert.strictEqual(stationProgress(r.sess.logged, r.sess.ex, 0, 1).done, true, "paired rounds now min(2,1)=1, one done");
  assert.deepStrictEqual([r.sess.i, r.sess.set], [0, 1], "on to the earliest unfinished: a's remaining set, alone");
  const u = undoSkip(r.sess);
  assert.deepStrictEqual([u.ok, u.sess.ex[0].sets, u.sess.ex[1].sets], [true, 3, 2], "undo restores BOTH members, never one alone");
});
check("#skip a swap after a skip gives the new lift the slot's PLANNED count (the skip was for the old lift)", () => {
  const s = skipSet(S([row("a", 3), row("b", 3)], [], 0)).sess; // skipped at set 0: a has 2 today, 3 planned
  const r = replaceSlot(s, 0, { exercise: "z", name: "Z", sets: 4, rep_range: "10-15" }, { expect: "a" });
  assert.deepStrictEqual([r.ok, r.sess.ex[0].sets, r.sess.ex[0].planned_sets], [true, 3, 3]);
});
check("#skip property: random skips between banks — never a set banked past today's target, every lift ends exactly at it, and it always terminates", () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 300; run++) {
    let s = S([row("a", 3), row("b", 2), row("c", 4)], [], 0);
    for (let steps = 0; steps < 40 && !s.complete; steps++) {
      if (rnd() < 0.35) { const r = skipSet(s); s = r.sess; continue; }
      const e = s.ex[s.i];
      s = { ...s, logged: [...s.logged, ...banked(e.exercise, 1)] };
      if (loggedWorkSets(s.logged, e.exercise) >= e.sets) { const nx = nextUnfinishedIndex(s.logged, s.ex, -1); s = nx < 0 ? { ...s, complete: true } : { ...s, i: nx, set: loggedWorkSets(s.logged, s.ex[nx].exercise) }; }
      else s = { ...s, set: loggedWorkSets(s.logged, e.exercise) };
      s = json(s); // every step survives a crash
    }
    assert.strictEqual(!!s.complete, true, `run ${run} terminated`);
    for (const x of s.ex) assert.strictEqual(loggedWorkSets(s.logged, x.exercise), x.sets, `run ${run}: ${x.exercise} ends exactly at today's target`);
  }
});

// --- Burst 1 review fixes ---------------------------------------------------------------
check("#skip-review undo never takes a lift past its PLANNED count (skip → swap → undo swap → undo skip was 4 of 3)", () => {
  const skipped = skipSet(S([row("a", 3), row("b", 3)], [], 0)).sess;               // a: 2 today, 3 planned
  const swapped = replaceSlot(skipped, 0, { exercise: "x", name: "X", sets: 3 }, { expect: "a" });
  assert.strictEqual("lastSkip" in swapped.sess, false, "a swap rewrites the slot's count, so it retires the undo");
  const back = replaceSlot(swapped.sess, 0, { ...skipped.ex[0], planned_sets: 3 }, { expect: "x" }); // the swap's Undo
  assert.strictEqual(back.sess.ex[0].sets, 3);
  assert.strictEqual(undoSkip({ ...back.sess, lastSkip: skipped.lastSkip }).ok, false, "even a stale undo can't grow a lift past its plan");
});
check("#skip-review undo DERIVES the cursor from banked sets (an Unlink in between can't leave set 0 on a lift with 2 banked)", () => {
  const two = [row("a", 4, { superset_with: "b" }), row("b", 4, { superset_with: "a" })];
  const sk = skipRound({ ...S(two, [...banked("a", 2), ...banked("b", 2)], 0), set: 0 }, 0, 1).sess; // the station never moves sess.set
  const u = undoSkip({ ...sk, set: 2 });
  assert.deepStrictEqual([u.ok, u.sess.i, u.sess.set], [true, 0, 2], "set = a's banked count, not the stored 0");
});
check("#skip-review a completed session never offers undo", () => {
  const s = skipSet(S([row("a", 3), row("b", 3)], banked("a", 1), 0)).sess;
  assert.strictEqual(undoSkip({ ...s, complete: true }).ok, false);
});
check("#next-set-review the band is READ: a '2-3' band eases further, and RIR 4 against a 2-3 band is not 'far easier'", () => {
  const r23 = { rep_range: "8-12", rir: "2-3", inc_kg: 2.5 };
  assert.strictEqual(nextSetHint(w(60, 6), r23).kg, 50, "60·(1 + 4.8/30)/(1 + 10/30) = 52.2 → 50");
  assert.strictEqual(nextSetHint(w(60, 6), row812).kg, 52.5, "60·(1 + 4.8/30)/(1 + 9/30) = 53.5 → 52.5");
  assert.strictEqual(nextSetHint(w(40, 10, { rir: 4 }), r23), null, "top 3: RIR 4 is only 1 above");
  assert.strictEqual(nextSetHint(w(40, 10, { rir: 5 }), r23).kind, "heavier", "RIR 5 is 2 above");
});
check("#next-set-review the clamps: at least one step down; at most +20% up; a set stopped early UNDER the range never hints heavier", () => {
  assert.strictEqual(nextSetHint(w(60, 5, { rir: 1 }), { rep_range: "6-10", rir: "0-1", inc_kg: 2.5 }).kg, 57.5, "raw 58 (60·(1 + 4.8/30)/(1 + 6/30)) → one step down");
  assert.strictEqual(nextSetHint(w(40, 30), row812).kg, 47.5, "uncapped it would be 50");
  // (W305, deliberate: was "no hint either way". 5 in reserve is capacity enough — (5 + 5) → 9 at the near edge — so: the
  // same weight, aim for 9.)
  assert.strictEqual(nextSetHint(w(60, 5, { rir: 5 }), row812).kind, "same");
});
check("#next-set-review in pounds the hint always MOVES: a 1 kg step that rounds to the same plate becomes the next 5 lb plate", () => {
  const lb = (kg) => Math.round((kg * 2.2046226) / 5) * 5; // the player's plate-rounded display
  assert.strictEqual(hintInUnit({ kind: "lighter", kg: 8, from_kg: 9.07 }, lb, 5), 15, "20 lb → 8 kg rounds back to 20 lb: show 15");
  assert.strictEqual(hintInUnit({ kind: "heavier", kg: 10, from_kg: 9.07 }, lb, 5), 25);
  assert.strictEqual(hintInUnit({ kind: "lighter", kg: 52.5, from_kg: 60 }, (k) => k, 2.5), 52.5, "kg: as computed");
  assert.strictEqual(hintInUnit({ kind: "lighter", kg: 1, from_kg: 2 }, lb, 5), null, "never a 0 or negative suggestion");
  assert.strictEqual(hintInUnit(null, lb, 5), null);
});

// The PRE-FILLED weight in pounds (Burst 1 review): plate rounding (5 lb) swallowed any engine
// move under ~2.5 lb, so a 1 kg step (isolation dumbbells/cables) pre-filled the very weight
// just lifted — those lifts could never progress for a pounds user, and an ease never eased.
const lbDisp = (kg) => Math.round((kg * 2.2046226) / 5) * 5;
const kgDisp = (kg) => Math.round(kg * 4) / 4;
check("#prefill in pounds a weight the engine MOVES always moves at least one plate; a hold holds", () => {
  const lb20 = 9.07; // what 20 lb is stored as
  assert.strictEqual(prefillInUnit({ suggested_kg: lb20 + 1, last_kg: lb20 }, lbDisp, 5), 25, "+1 kg from 20 lb: 22.2 lb rounds back to 20 — the next plate");
  assert.strictEqual(prefillInUnit({ suggested_kg: 8, last_kg: lb20 }, lbDisp, 5), 15, "an ease to 8 kg: 17.6 lb rounds back to 20");
  assert.strictEqual(prefillInUnit({ suggested_kg: lb20, last_kg: lb20 }, lbDisp, 5), 20, "a hold stays put");
  assert.strictEqual(prefillInUnit({ suggested_kg: 102.5, last_kg: 100 }, lbDisp, 5), 225, "a barbell +2.5 kg already shows: as computed");
  assert.strictEqual(prefillInUnit({ suggested_kg: 30, last_kg: null }, lbDisp, 5), 65, "no history to compare: as computed");
  assert.strictEqual(prefillInUnit({ suggested_kg: null, last_kg: 10 }, lbDisp, 5), null, "no suggestion: the caller's own default");
  assert.strictEqual(prefillInUnit({ suggested_kg: 1, last_kg: 2 }, lbDisp, 5), 0, "never below zero: falls back to the rounded value");
});
check("#prefill in kilograms it is EXACTLY the plain rounding, for every move the engine makes (property)", () => {
  for (let last = 1; last <= 200; last += 0.25) for (const d of [-0.2 * last, -2.5, -1, 0, 1, 2.5, 5]) {
    const sug = Math.round((last + d) * 4) / 4;
    if (sug <= 0) continue;
    assert.strictEqual(prefillInUnit({ suggested_kg: sug, last_kg: last }, kgDisp, 2.5), kgDisp(sug), `${last} → ${sug}`);
  }
});
check("#next-set-review the hint carries the set's effort and the band, so the copy can say WHY", () => {
  const h = nextSetHint(w(40, 10, { rir: 5 }), row812);
  assert.deepStrictEqual([h.kind, h.reps, h.rir, h.band], ["heavier", 10, 5, "1-3"]);
});

// --- W282: WHAT HAPPENED, from the workout itself (the plan it carried + the sets banked) —
// so the read-out works offline and for any workout in History.
const tg = (exercise, sets, rep_range = "8-12", rir = "1-3", extra = {}) => ({ exercise, sets, rep_range, rir, suggested_kg: 50, ...extra });
const ws = (exercise, weight_kg, reps, extra = {}) => ({ exercise, set_type: "work", weight_kg, reps, ...extra });
check("#local-readout per lift: sets done vs planned, reps vs the range, effort vs the band", () => {
  const r = localReadout(
    [tg("a", 3), tg("b", 3), tg("c", 2)],
    [ws("a", 50, 12), ws("a", 50, 12), ws("a", 50, 12), { exercise: "a", set_type: "warmup", weight_kg: 20, reps: 10 },
     ws("b", 60, 9), ws("b", 60, 6),
     ws("c", 20, 12, { rir: 5 }), ws("c", 20, 12, { rir: 5 })]);
  const by = Object.fromEntries(r.lifts.map((l) => [l.exercise, l]));
  assert.deepStrictEqual([r.planned, r.done], [8, 7], "warm-ups never count");
  assert.deepStrictEqual([by.a.done, by.a.planned, by.a.top, by.a.under], [3, 3, true, 0]);
  assert.deepStrictEqual([by.b.done, by.b.planned, by.b.top, by.b.under], [2, 3, false, 1]);
  assert.deepStrictEqual([by.c.easy, by.c.rir, by.c.band], [true, 5, "1-3"], "RIR 5 against a 1-3 band: far easier than planned");
  assert.strictEqual(by.a.easy, false, "no logged effort → no effort verdict");
});
check("#local-readout a planned-easy lift (deload / eased) is never graded; a lift the plan didn't have still shows", () => {
  const r = localReadout([tg("a", 2, "8-12", "3-4", { deload: true })], [ws("a", 40, 5, { deload: true }), ws("a", 40, 5, { deload: true }), ws("x", 30, 10)]);
  const a = r.lifts.find((l) => l.exercise === "a"), x = r.lifts.find((l) => l.exercise === "x");
  assert.deepStrictEqual([a.easyDay, a.under, a.top], [true, 0, false]);
  assert.deepStrictEqual([x.planned, x.done, x.min], [null, 1, null]);
});
check("#local-readout a planned lift with no sets at all is listed (0 of N) — ending early is visible, never silent", () => {
  const r = localReadout([tg("a", 3), tg("b", 3)], [ws("a", 50, 10)]);
  assert.deepStrictEqual(r.lifts.map((l) => [l.exercise, l.done, l.planned]), [["a", 1, 3], ["b", 0, 3]]);
  assert.deepStrictEqual([r.planned, r.done], [6, 1]);
});
// Burst 6 (owner: "the end of session recap is contradictory… I hit failure on one of the lifts but then [it] told
// me to increase the weight"). The top of the range is judged at the plan's effort — the band the workout was served
// — exactly as the engine judges it (repsAtBand, pinned to the server's copy), so "time to go up" / "top of the range"
// never sit beside "taken to failure" and a held weight.
check("#effort-top repsAtBand is the server's formula, exactly (parity over a grid)", () => {
  for (const reps of [1, 5, 6, 10, 12, 15]) for (const rir of [null, undefined, 0, 1, 2, 3, 5]) for (const near of [0, 1, 2, 3])
    assert.strictEqual(playerCore.repsAtBand(reps, rir, near), serverCore.repsAtBand(reps, rir, near), `${reps} @ ${rir}, near ${near}`);
});
check("#effort-top localReadout: the top at the plan's effort; a top reached only past the band is its own flag; effort inside the band", () => {
  const three = (reps, rirs, rir = "1-2", extra = {}) => localReadout([tg("a", 3, "6-10", rir, extra)], rirs.map((x) => ws("a", 150, reps, x == null ? {} : { rir: x }))).lifts[0];
  const pick = (l) => [l.top, l.past_band, l.failure, l.in_band];
  assert.deepStrictEqual(pick(three(10, [0, 0, 0])), [false, true, true, false], "the owner's leg press: at the top only by going to failure");
  assert.deepStrictEqual(pick(three(12, [0, 0, 0])), [true, false, true, false], "past the top even counting the rep the plan wants in reserve");
  assert.deepStrictEqual(pick(three(10, [null, null, null])), [true, false, false, null], "unlogged effort reads as at the band (beginners unchanged)");
  assert.deepStrictEqual(pick(three(10, [1, 1, 1], "2-3")), [false, true, false, false], "a 2-3 band met at 1 in reserve");
  assert.deepStrictEqual(pick(three(10, [0, null, null])), [false, true, false, null], "one set logged past the band is enough; too few logged to grade the effort");
  assert.deepStrictEqual(pick(three(10, [1, 2, 1])), [true, false, false, true], "inside the band");
  assert.deepStrictEqual(pick(three(10, [0, 0, 0], "3-4", { deload: true })), [false, false, false, null], "a planned-easy lift is never graded");
  const off = localReadout([], [ws("x", 30, 12, { rir: 0 })]).lifts[0];
  assert.deepStrictEqual([off.top, off.past_band], [false, false], "a lift the plan didn't have: no range, no verdict");
});
// Review round 1 (K2): the effort lines grade the SAME sets the engine judges — the anchor (the heaviest weight with a
// set that reached the range; a lighter back-off is a different load, never evidence, C14) — or a back-off flipped
// them against the next weight. "Under the range" and the counts stay over every set.
check("#effort-top anchorSets is the server's anchor, exactly (parity over a grid)", () => {
  const grid = [[[60, 12], [50, 12]], [[60, 10], [60, 10], [60, 12], [55, 6]], [[40, 5], [35, 8]], [[100, 3], [80, 10], [80, 9]], [[20, 4], [20, 3]]];
  for (const sets of grid) for (const min of [6, 8, 10]) {
    const ss = sets.map(([weight_kg, reps]) => ({ weight_kg, reps }));
    assert.deepStrictEqual(playerCore.anchorSets(ss, min), serverCore.anchorSets(ss, min), JSON.stringify({ sets, min }));
  }
});
check("#effort-top localReadout judges effort and the top over the anchor sets, as the engine does — a back-off never flips them", () => {
  const a = localReadout([tg("a", 2, "8-12", "2-3")], [ws("a", 60, 12, { rir: 5 }), ws("a", 50, 12, { rir: 1 })]).lifts[0];
  assert.deepStrictEqual([a.top, a.past_band, a.easy, a.in_band], [true, false, true, false], "60x12@5 then a 50 kg back-off at 1: the engine bumps for the 60s (~5 left), so does the read-out");
  const b = localReadout([tg("b", 4, "6-10", "3-4")], [ws("b", 60, 10, { rir: 3 }), ws("b", 60, 10, { rir: 0 }), ws("b", 60, 12, { rir: 4 }), ws("b", 55, 6, { rir: 5 })]).lifts[0];
  assert.deepStrictEqual([b.top, b.past_band, b.in_band, b.under], [false, true, false, 0], "a 55 kg back-off can't average the 60s back into the band");
});
check("#effort-top (round 2) the read-out says WHICH sets it graded, and Nerd Mode's average is over the sets it lists", () => {
  const h = localReadout([tg("h", 2, "6-10", "1-2")], [ws("h", 50, 4), ws("h", 60, 10), ws("h", 60, 10)]).lifts[0];
  assert.deepStrictEqual([h.top, h.graded_all, h.under], [true, false, 1], "a ramp set under the range: the top is the 60s', not every set's");
  const all = localReadout([tg("a", 3)], [ws("a", 50, 12), ws("a", 50, 12), ws("a", 50, 12)]).lifts[0];
  assert.equal(all.graded_all, true);
  const b = localReadout([tg("b", 3, "8-12", "2-3")], [ws("b", 60, 10, { rir: 3 }), ws("b", 60, 9, { rir: 3 }), ws("b", 50, 12, { rir: 0 })]).lifts[0];
  assert.deepStrictEqual([b.rir, b.rir_all], [3, 2], "graded over the 60s; the Nerd line's average covers every set it prints");
  assert.deepStrictEqual([b.anchor_kg, b.graded_all], [60, false], "round 3: the graded average says which weight it is for");
  const d = localReadout([tg("d", 2, "8-12", "3-4", { deload: true })], [ws("d", 54, 10, { rir: 4, deload: true }), ws("d", 45, 12, { rir: 1, deload: true })]).lifts[0];
  assert.equal(d.rir_all, 2.5, "a planned-easy lift is never graded; its average is still every set's");
});
check("#local-readout an OLD workout without targets still reads (no plan, no grades) — and says it had none", () => {
  const r = localReadout(undefined, [ws("a", 50, 10), ws("a", 50, 9)]);
  assert.deepStrictEqual(r.lifts.map((l) => [l.exercise, l.done, l.planned, l.top, l.under]), [["a", 2, null, false, 0]]);
  assert.strictEqual(r.hasPlan, false);
  assert.strictEqual(localReadout([tg("a", 2)], [ws("a", 50, 10)]).hasPlan, true);
});

check("restAlertStep (W286): armed while resting; handed to the in-app chime in the last seconds on screen; re-armed if the screen goes", () => {
  const rest = { until: 100_000 };
  const step = (o) => restAlertStep({ rest, armedUntil: null, now: 10_000, onScreen: true, chimeReliable: true, enabled: true, ...o });
  assert.strictEqual(REST_ALERT_HANDOFF_MS, 3000);
  assert.strictEqual(step({}), "arm", "a rest starts: arm (the phone may lock any moment)");
  assert.strictEqual(step({ armedUntil: 100_000 }), null, "already armed for this end");
  assert.strictEqual(step({ rest: { until: 130_000 }, armedUntil: 100_000 }), "arm", "+30 s moved the end: arm again");
  assert.strictEqual(step({ armedUntil: 100_000, now: 97_500 }), "disarm", "on screen in the last 3 s: the app's chime takes over");
  assert.strictEqual(step({ now: 97_500 }), null, "…once");
  assert.strictEqual(step({ now: 97_500, onScreen: false }), "arm", "the screen went away after the hand-over: arm again");
  assert.strictEqual(step({ armedUntil: 100_000, now: 97_500, onScreen: false }), null, "off screen near the end: the alarm stays");
  assert.strictEqual(step({ armedUntil: 100_000, now: 100_500 }), null, "over: the alarm or the chime has fired; nothing to undo");
  assert.strictEqual(step({ rest: null, armedUntil: 100_000, now: 50_000 }), "disarm", "ended early: I'm ready, a set banked, the workout over");
  assert.strictEqual(step({ rest: null, armedUntil: 100_000, now: 100_500 }), null, "an end that already passed needs no disarm");
  assert.strictEqual(step({ rest: null }), null);
  assert.strictEqual(step({ enabled: false }), null, "alerts off (or no notifications): never arm");
  assert.strictEqual(step({ enabled: false, armedUntil: 100_000 }), "disarm", "switched off mid-rest: disarm");
  assert.strictEqual(step({ rest: { until: NaN } }), null, "a corrupt rest is never armed");
});
check("restAlertStep (W286 review): never hands over to a chime that can't be trusted (iPhone: the silent switch mutes it, unseen)", () => {
  const rest = { until: 100_000 };
  const step = (o) => restAlertStep({ rest, armedUntil: 100_000, now: 98_000, onScreen: true, chimeReliable: false, enabled: true, ...o });
  assert.strictEqual(step({}), null, "on screen, last seconds, chime unreliable: the alarm STAYS armed");
  assert.strictEqual(step({ armedUntil: null }), "arm", "…and is armed if it wasn't");
  assert.strictEqual(step({ chimeReliable: true }), "disarm", "control: a reliable chime takes over");
});

// --- W306 (considerations iteration, Burst 9 — owner: "when I start a workout, I can look at all the exercises… if I pick
// 'Do this later' or 'Skip this,' can you give me an option to pick what I want to do next?"). ONE pure permutation
// (permuteSess) under both "Do this next" (moveToCurrent) and "Do this later" (deferToEnd): the index-keyed caches
// travel with their lifts, a superset pair moves as a block, the chosen lift lands AT the cursor so every unfinished
// lift stays at or after it (the straight bank only scans forward), a running rest and a pending skip-undo (and the
// one a swap stashed) retire, and nothing the plan prescribes moves — weights keep their planned-position basis (W290).
{
  const { permuteSess, moveToCurrent, deferToEnd, workoutList } = playerCore;
  const row = (exercise, sets = 3, extra = {}) => ({ exercise, name: exercise, sets, planned_sets: sets, rep_range: "8-12", rir: "1-2", suggested_kg: 50, ...extra });
  const mk = (rows, over = {}) => ({ ex: rows, i: 0, set: 0, logged: [], weights: {}, reps: {}, eff: {}, wUnits: {}, ...over });
  const work = (exercise, n) => Array.from({ length: n }, () => ({ exercise, set_type: "work", weight_kg: 50, reps: 10, completed_at: "2026-11-01T10:00:00.000Z" }));
  const tag = (s) => { const t = {}; s.ex.forEach((x, k) => { t[k] = x.exercise; }); return { weights: { ...t }, reps: { ...t }, eff: { ...t }, wUnits: { ...t } }; };
  const cachesFollow = (s) => ["weights", "reps", "eff", "wUnits"].every((c) => Object.entries(s[c]).every(([k, v]) => s.ex[+k].exercise === v));
  // The player's own advance, exactly: a straight lift's last set scans FORWARD only (none → complete); a finished
  // station scans from the start (app.js bank handlers). Returns the banked counts.
  const play = (s0) => {
    let s = JSON.parse(JSON.stringify(s0)), guard = 0;
    while (!s.complete) {
      if (++guard > 500) throw new Error("no termination");
      const e = s.ex[s.i];
      const pIdx = e.superset_with ? s.ex.findIndex((x) => x.exercise === e.superset_with) : -1;
      if (pIdx >= 0 && !stationProgress(s.logged, s.ex, Math.min(s.i, pIdx), Math.max(s.i, pIdx)).done) {
        const L = Math.min(s.i, pIdx), P = Math.max(s.i, pIdx);
        s.logged.push(...work(s.ex[L].exercise, 1), ...work(s.ex[P].exercise, 1));
        if (stationProgress(s.logged, s.ex, L, P).done) { const nx = nextUnfinishedIndex(s.logged, s.ex, -1); if (nx < 0) s.complete = true; else s.i = nx; }
        continue;
      }
      if (loggedWorkSets(s.logged, e.exercise) >= e.sets) { const nx = nextUnfinishedIndex(s.logged, s.ex, -1); if (nx < 0) s.complete = true; else s.i = nx; continue; } // renderPlayer's self-heal
      s.logged.push(...work(e.exercise, 1));
      if (loggedWorkSets(s.logged, e.exercise) >= e.sets) { const nx = nextUnfinishedIndex(s.logged, s.ex, s.i); if (nx < 0) s.complete = true; else s.i = nx; }
    }
    return Object.fromEntries(s.ex.map((x) => [x.exercise, loggedWorkSets(s.logged, x.exercise)]));
  };
  check("#move permuteSess reorders the lifts and moves every index-keyed cache WITH its lift; the input is untouched", () => {
    const s = mk([row("a"), row("b"), row("c"), row("d")]); Object.assign(s, tag(s));
    const before = JSON.stringify(s);
    const out = permuteSess(s, [2, 0, 3, 1]);
    assert.deepStrictEqual(out.ex.map((x) => x.exercise), ["c", "a", "d", "b"]);
    assert.ok(cachesFollow(out), JSON.stringify(out.weights));
    assert.equal(JSON.stringify(s), before, "pure");
    assert.equal(permuteSess(s, [0, 0, 1, 2]), null, "not a permutation: refused");
  });
  check("#move every (cursor, target) on a 5-lift day: the chosen lift is next, every lift still trains in full, caches follow", () => {
    const names = ["a", "b", "c", "d", "e"];
    let cases = 0;
    for (let cur = 0; cur < 5; cur++) for (let k = 0; k < 5; k++) {
      const s = mk(names.map((n) => row(n)), { i: cur, logged: names.slice(0, cur).flatMap((n) => work(n, 3)) });
      Object.assign(s, tag(s));
      const r = moveToCurrent(s, k);
      if (k < cur) { assert.equal(r.ok, false, `${cur}->${k}: a finished lift`); assert.equal(r.reason, "done"); continue; }
      if (k === cur) { assert.equal(r.ok, false); assert.equal(r.reason, "current"); continue; }
      cases++;
      assert.ok(r.ok, `${cur}->${k}`);
      assert.equal(r.sess.ex[r.sess.i].exercise, names[k], "the chosen lift is now");
      assert.equal(r.sess.set, 0);
      assert.ok(r.sess.ex.slice(0, r.sess.i).every((x) => loggedWorkSets(r.sess.logged, x.exercise) >= x.sets), "nothing unfinished before the cursor");
      assert.ok(cachesFollow(r.sess), `${cur}->${k} caches`);
      assert.equal(r.sess.ex[r.sess.i].moved, true);
      const done = play(r.sess);
      for (const n of names) assert.equal(done[n], 3, `${cur}->${k}: ${n} trained in full`);
    }
    assert.ok(cases >= 10);
  });
  check("#move a superset pair moves as a block, leader first, and a cursor on a station inserts before its leader", () => {
    const pairDay = () => mk([row("a"), row("b", 3, { superset_with: "c" }), row("c", 3, { superset_with: "b" }), row("d"), row("e")]);
    const r1 = moveToCurrent(pairDay(), 2); // pick the partner c: b+c go first, together
    assert.deepStrictEqual(r1.sess.ex.map((x) => x.exercise), ["b", "c", "a", "d", "e"]);
    assert.equal(r1.sess.i, 0);
    assert.ok(r1.sess.ex[0].moved && r1.sess.ex[1].moved);
    const onPair = pairDay(); onPair.i = 2; onPair.logged = work("a", 3); // cursor on the station's partner
    const r2 = moveToCurrent(onPair, 4);
    assert.deepStrictEqual(r2.sess.ex.map((x) => x.exercise), ["a", "e", "b", "c", "d"], "e lands before the station's leader, the pair stays adjacent");
    assert.equal(r2.sess.i, 1);
    for (const r of [r1, r2]) { const done = play(r.sess); for (const n of ["a", "b", "c", "d", "e"]) assert.equal(done[n], 3, n); }
    const mid = pairDay(); mid.logged = [...work("b", 1), ...work("c", 1)]; mid.i = 1; // a station mid-way: its block is current
    assert.equal(moveToCurrent(mid, 2).reason, "current", "the station's other member is part of now");
  });
  check("#move a running rest, a pending skip-undo and the one a swap stashed all retire; the plan's prescription never moves", () => {
    const s = mk([row("a", 3, { rep_targets: [10, 9, 8], slot_of: "z" }), row("b"), row("c")], { logged: work("a", 1), set: 1,
      rest: { kind: "set", ex: "a", length: 120, logged: 1, start: 1, until: 2 }, lastSkip: { ids: ["a"], loggedLen: 1, order: "a|b|c", prevI: 0, prevSet: 0 },
      swapUndo: { to: "a", from: "z", lastSkip: { ids: ["a"], loggedLen: 1, order: "a|b|c", prevI: 0, prevSet: 0 } } });
    const r = moveToCurrent(s, 2);
    assert.ok(r.ok);
    assert.equal(r.sess.rest, undefined); assert.equal(r.sess.lastSkip, undefined); assert.equal(r.sess.swapUndo.lastSkip, null);
    const a = r.sess.ex.find((x) => x.exercise === "a");
    assert.deepStrictEqual([a.sets, a.planned_sets, a.suggested_kg, a.rep_targets, a.slot_of], [3, 3, 50, [10, 9, 8], "z"]);
    assert.equal(r.sess.ex.findIndex((x) => x.exercise === "a") > r.sess.i, true, "a half-done lift waits after the cursor");
    assert.equal(play(r.sess).a, 3, "…and resumes from its banked count");
  });
  check("#move refusals: a finished or skipped-out lift, a completed workout, a slot that isn't there", () => {
    const s = mk([row("a"), row("b", 2, { planned_sets: 3 }), row("c")], { logged: work("b", 2) });
    assert.equal(moveToCurrent(s, 1).reason, "done", "skipped down to what it banked: nothing left");
    assert.equal(moveToCurrent({ ...s, complete: true }, 2).reason, "complete");
    assert.equal(moveToCurrent(s, 9).reason, "no-slot");
    assert.equal(moveToCurrent(null, 0).ok, false);
  });
  check("#move survives the localStorage mirror: a JSON round trip mid-move resumes on the same lift", () => {
    const r = moveToCurrent(mk([row("a"), row("b"), row("c")], { logged: work("a", 1), set: 1 }), 2);
    const back = JSON.parse(JSON.stringify(r.sess));
    assert.deepStrictEqual(back, r.sess);
    assert.equal(back.ex[back.i].exercise, "c");
    const done = play(back); for (const n of ["a", "b", "c"]) assert.equal(done[n], 3, n);
  });
  check("#defer 'Do this later' is the same permutation: the lift goes to the end, the cursor stays (now on the next), caches follow", () => {
    const s = mk([row("a"), row("b"), row("c")]); Object.assign(s, tag(s));
    const r = deferToEnd(s);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.sess.ex.map((x) => x.exercise), ["b", "c", "a"]);
    assert.equal(r.sess.i, 0); assert.ok(cachesFollow(r.sess)); assert.equal(r.sess.ex[2].moved, true);
    assert.equal(deferToEnd({ ...s, i: 2 }).reason, "last", "nothing to move it ahead of");
    assert.equal(deferToEnd(mk([row("a", 3, { superset_with: "b" }), row("b", 3, { superset_with: "a" }), row("c")])).reason, "pair");
    assert.equal(deferToEnd({ ...s, logged: work("a", 1), set: 1 }).reason, "started");
    const done = play(r.sess); for (const n of ["a", "b", "c"]) assert.equal(done[n], 3, n);
  });
  check("#list workoutList: every lift as done / now / later / skipped, a station's pair as one 'now', only later lifts movable", () => {
    const s = mk([row("a"), row("b", 2, { planned_sets: 3 }), row("c", 3, { superset_with: "d" }), row("d", 3, { superset_with: "c" }), row("e"), row("f", 1, { planned_sets: 3 })],
      { i: 2, logged: [...work("a", 3), ...work("b", 2), ...work("c", 1), ...work("d", 1), ...work("f", 1)] });
    const L = workoutList(s);
    assert.deepStrictEqual(L.map((r) => [r.exercise, r.status, r.done, r.sets, r.skipped, r.movable]), [
      ["a", "done", 3, 3, 0, false], ["b", "skipped", 2, 3, 1, false], ["c", "now", 1, 3, 0, false], ["d", "now", 1, 3, 0, false], ["e", "later", 0, 3, 0, true], ["f", "skipped", 1, 3, 2, false]]);
    assert.equal(L.filter((r) => r.status === "done" || r.status === "skipped").length, 3, "the header's 'done' count");
    assert.deepStrictEqual(workoutList(mk([row("a"), row("b")])).map((r) => r.status), ["now", "later"]);
  });
  check("#move the workout reports which lifts the user moved (targets.moved) — the seed for later learning, nothing else changes", () => {
    const r = moveToCurrent(mk([row("a"), row("b"), row("c")]), 2);
    const t = buildTargets(r.sess);
    assert.deepStrictEqual(t.map((x) => [x.exercise, x.moved ?? false]), [["c", true], ["a", false], ["b", false]]);
    assert.deepStrictEqual(buildTargets(mk([row("a")])), [{ exercise: "a", sets: 3, rep_range: "8-12", rir: "1-2", suggested_kg: 50 }], "an unmoved lift's target is as before");
  });
}

// --- W307 (Burst 9): the player's copies judge an ESTIMATED rep count exactly as the engine does — a set done, never
// evidence: no PR toast or latch, no next-set hint read from it, no seed or typo reference raised by it, no read-out
// grade from it (it still counts as done). One predicate, byte-identical to derive-core's.
{
  const e = { est: ["reps"] };
  check("#est parity: the player's repsEstimated is derive-core's, byte for byte", () => {
    assert.equal(playerCore.repsEstimated.toString(), serverCore.repsEstimated.toString());
    for (const x of [{ est: ["reps"] }, { est: [] }, {}, null, { est: "reps" }]) assert.equal(playerCore.repsEstimated(x), serverCore.repsEstimated(x));
  });
  check("#est the live PR check skips an estimated set — the same verdict as the engine's, on a grid", () => {
    const prior = serverCore.priorPersonalBests([{ date: "2026-10-01", sets: [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 5 }, { exercise: "lat", set_type: "work", weight_kg: 10, reps: 15 }] }]);
    for (const [ex, kg, reps] of [["bench", 100, 12], ["bench", 110, 6], ["lat", 12.5, 15]]) {
      const pb = { e1rm_kg: prior.e1rm[ex] ?? null, load_kg: prior.load[ex] ?? null };
      assert.equal(checkSetPR(ex, kg, reps, "work", pb, false, true), null, `${ex} ${kg}x${reps} estimated: no toast`);
      assert.equal(!!checkSetPR(ex, kg, reps, "work", pb, false, false), !!serverCore.checkSetPR({ exercise: ex, set_type: "work", weight_kg: kg, reps }, prior), "control: real sets agree with the engine");
      assert.equal(serverCore.checkSetPR({ exercise: ex, set_type: "work", weight_kg: kg, reps, ...e }, prior), null, "…and the engine skips the estimate too");
    }
    assert.equal(recomputePrLatch([{ exercise: "bench", set_type: "work", weight_kg: 110, reps: 6, ...e }], "bench", { e1rm_kg: prior.e1rm.bench }), false, "the latch never holds on an estimate");
  });
  check("#est no next-set hint from an estimated set; the rep seed and the typo reference skip it", () => {
    assert.equal(nextSetHint({ exercise: "bench", set_type: "work", weight_kg: 100, reps: 4, rir: 0, ...e }, { rep_range: "8-12", rir: "1-2", inc_kg: 2.5 }), null);
    const log = [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 9 }, { exercise: "bench", set_type: "work", weight_kg: 100, reps: 15, ...e }];
    assert.equal(playerCore.lastWorkReps(log, "bench"), 9, "the seed reads the last REAL count");
    assert.deepStrictEqual(todayTopSet(log, "bench"), { kg: 100, reps: 9 }, "an estimated 15 never raises the typo guard's reps");
  });
  check("#est the read-out counts an estimated set as done, grades only the real ones, and says how many were estimated", () => {
    const t = [{ exercise: "bench", sets: 3, rep_range: "8-12", rir: "1-2" }];
    const r = localReadout(t, [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 12, rir: 1 }, { exercise: "bench", set_type: "work", weight_kg: 100, reps: 12, ...e }, { exercise: "bench", set_type: "work", weight_kg: 100, reps: 12, rir: 1 }]).lifts[0];
    // Burst 9 review (D2, deliberate): an estimate at the weight means no "top" (the engine won't bump on it either), and
    // the estimated set is among the sets at the anchor weight (D1: its weight is real).
    assert.deepStrictEqual([r.done, r.planned, r.top, r.graded_all, r.est], [3, 3, false, true, 1]);
    const all = localReadout(t, [{ exercise: "bench", set_type: "work", weight_kg: 100, reps: 6, ...e }]).lifts[0];
    assert.deepStrictEqual([all.done, all.top, all.under, all.anchor_kg], [1, false, 0, 100], "nothing real: nothing graded, nothing 'under' — the weight it was at is still the weight it was at");
  });
}

// --- W307: "Forgot the numbers?" — the estimate, in order of what it trusts: the same lift's REAL sets this session at
// the same weight (an earlier one carries forward by the drop between sets; a later one says the earlier did at least
// that plus the drop), the lifter's OWN drop when two real sets in a row show it, else the model's; then last session's
// same set at that weight; then the e1RM those sets give, at the band's near edge. RIR from the nearest real neighbour
// (else the band's near edge) — never for a beginner (never asked). Null when nothing real exists to estimate from.
{
  const { estimateSet } = playerCore;
  const W = (reps, rir, kg = 100, extra = {}) => ({ exercise: "bench", set_type: "work", weight_kg: kg, reps, ...(rir != null ? { rir } : {}), completed_at: "t", ...extra });
  const row = { exercise: "bench", rep_range: "8-12", rir: "1-2" };
  check("#estimate after a real set: carried forward by the drop (10 @2 → (12)·0.9 − 2 ≈ 9 @2)", () => {
    assert.deepStrictEqual(estimateSet({ logged: [W(10, 2)], at: 1, weightKg: 100, row }), { reps: 9, rir: 2, source: "session" });
  });
  check("#estimate before a real one: the later set bounds it — at least that, plus the drop (a later 8 @2 → 9 @2 before it)", () => {
    const e = estimateSet({ logged: [W(9, 2, 100, { est: ["reps"] }), W(8, 2)], at: 0, weightKg: 100, row });
    assert.deepStrictEqual(e, { reps: 9, rir: 2, source: "session" }, "(8 + 2)/0.9 − 2 = 9.1");
  });
  check("#estimate the lifter's own drop, when two real sets in a row show it (12 @1 then 8 @1: a third ≈ 5–6)", () => {
    const own = estimateSet({ logged: [W(12, 1), W(8, 1)], at: 2, weightKg: 100, row });
    assert.equal(own.reps, 5, "their drop (13 → 9, about 31%) carries to the third: 9·0.69 − 1 ≈ 5.2");
    assert.notEqual(own.reps, estimateSet({ logged: [W(8, 1)], at: 1, weightKg: 100, row }).reps, "the model alone (20% at RIR 1) says 6");
  });
  check("#estimate no real set today: last session's same set at that weight, then the e1RM those sets give", () => {
    const last = { ...row, last_sets: [[100, 10], [100, 9], [100, 8]] };
    assert.deepStrictEqual(estimateSet({ logged: [], at: 0, weightKg: 100, row: last, setNo: 1 }), { reps: 9, rir: 1, source: "last" }, "set 2 last time: 9");
    // (Burst 9 review engine#2, deliberate: last time's unlogged effort reads as the near edge, as everywhere else.)
    assert.deepStrictEqual(estimateSet({ logged: [], at: 0, weightKg: 90, row: last, setNo: 0 }), { reps: 15, rir: 1, source: "e1rm" }, "a new weight: 100·(1+11/30)=136.7 → at 90: 30·(136.7/90 − 1) − 1 ≈ 14.6");
    assert.equal(estimateSet({ logged: [], at: 0, weightKg: 100, row }), null, "nothing real: no estimate");
  });
  check("#estimate an estimate never feeds another, and a beginner gets reps only (never asked RIR)", () => {
    assert.equal(estimateSet({ logged: [W(10, 2, 100, { est: ["reps"] })], at: 1, weightKg: 100, row }), null, "only an estimated neighbour: nothing");
    // Burst 9 review (engine#2, deliberate): an unlogged RIR reads as the band's near edge in BOTH the capacity and the
    // prediction (the engine's own convention) — it was 0 for one and `near` for the other, a double count: (10+1)·0.8 − 1.
    assert.deepStrictEqual(estimateSet({ logged: [W(10, null)], at: 1, weightKg: 100, row, beginner: true }), { reps: 8, rir: null, source: "session" }, "(10 + 1)·0.8 − 1 = 7.8");
  });
  check("#estimate editLoggedSet: an estimate marks its fields; a REAL new number clears only its own flag", () => {
    const log = [W(10, 2)];
    const est = editLoggedSet(log, 0, { estimate: { reps: 9, rir: 2 } }, { exercise: "bench", completed_at: "t" });
    assert.deepStrictEqual([est[0].reps, est[0].est, est[0].rir, est[0].rir_est], [9, ["reps"], 2, undefined], "a real RIR stays real — the estimate never replaces it");
    const blank = editLoggedSet([W(10, null)], 0, { estimate: { reps: 9, rir: 2 } }, { exercise: "bench", completed_at: "t" });
    assert.deepStrictEqual([blank[0].est, blank[0].rir, blank[0].rir_est], [["reps"], undefined, 2]);
    const same = editLoggedSet(blank, 0, { reps: 9 }, { exercise: "bench", completed_at: "t" });
    assert.deepStrictEqual(same[0].est, ["reps"], "the same number again isn't a real entry (an untouched field)");
    const fixed = editLoggedSet(blank, 0, { reps: 8, rir: 1 }, { exercise: "bench", completed_at: "t" });
    assert.deepStrictEqual([fixed[0].reps, fixed[0].est, fixed[0].rir, fixed[0].rir_est], [8, undefined, 1, undefined], "real numbers: both flags gone");
    assert.equal(editLoggedSet(blank, 0, { rir: 11 }, { exercise: "bench", completed_at: "t" }), blank, "an RIR out of 0-10 is ignored");
    assert.deepStrictEqual(sessionChips(blank, "bench")[0].est, true, "the chip knows it's an estimate");
  });
}

// --- W307 UI half: what banks as an estimate, per field; RIR in the banked-set editor; the ~ on screen.
{
  const { estimatedFields, repsShown, estimateSet } = playerCore;
  check("#est-bank estimatedFields: a field banks as an estimate only while it still shows the estimate — per field", () => {
    const p = { setNo: 1, reps: 9, rirChip: 2, rir: 2 };
    assert.deepStrictEqual(estimatedFields(p, { setNo: 1, reps: 9, eff: 2 }), { estReps: true, rir: null, rir_est: 2 });
    assert.deepStrictEqual(estimatedFields(p, { setNo: 1, reps: 10, eff: 2 }), { estReps: false, rir: null, rir_est: 2 }, "reps typed: real; the untouched RIR stays an estimate");
    assert.deepStrictEqual(estimatedFields(p, { setNo: 1, reps: 9, eff: 3 }), { estReps: true, rir: 3, rir_est: null }, "an RIR tapped: real");
    assert.deepStrictEqual(estimatedFields(p, { setNo: 1, reps: 9, eff: undefined }), { estReps: true, rir: null, rir_est: null }, "the RIR chip cleared: no RIR at all");
    assert.deepStrictEqual(estimatedFields(p, { setNo: 2, reps: 9, eff: 2 }), { estReps: false, rir: 2, rir_est: null }, "a pending estimate for ANOTHER set is stale");
    assert.deepStrictEqual(estimatedFields(null, { setNo: 0, reps: 9, eff: null }), { estReps: false, rir: null, rir_est: null });
    assert.deepStrictEqual(estimatedFields({ setNo: 0, reps: 7, rirChip: null, rir: null }, { setNo: 0, reps: 7, eff: null }), { estReps: true, rir: null, rir_est: null }, "a beginner: reps only");
    assert.deepStrictEqual(estimatedFields({ setNo: 0, reps: 7, rirChip: 4, rir: 6 }, { setNo: 0, reps: 7, eff: 4 }), { estReps: true, rir: null, rir_est: 6 }, "'4+' shown, the estimate's 6 kept — never a real 4");
  });
  check("#est-bank the estimator skips last time's ESTIMATED sets (marked [kg, reps, true]) — for the same set and for the e1RM", () => {
    const row = { exercise: "bench", rep_range: "8-12", rir: "1-2", last_sets: [[100, 10], [100, 14, true], [100, 8]] };
    assert.deepStrictEqual(estimateSet({ logged: [], at: 0, weightKg: 100, row, setNo: 1 }), { reps: 10, rir: 1, source: "e1rm" }, "not the guessed 14 (it would say 14): the real 10's (10+1)·… → 10");
  });
  check("#estimate in the editor the set being estimated never informs its own estimate (its banked numbers are the forgotten ones)", () => {
    const W2 = (reps, rir, kg = 100) => ({ exercise: "bench", set_type: "work", weight_kg: kg, reps, rir, completed_at: "t" });
    const row = { exercise: "bench", rep_range: "8-12", rir: "1-2" };
    assert.deepStrictEqual(estimateSet({ logged: [W2(10, 2), W2(15, 0), W2(9, 2)], at: 1, weightKg: 100, row }), { reps: 9, rir: 2, source: "session" },
      "the model's drop from set 1 — never a 'drop' read off the bogus 15 (it would say 7)");
    assert.deepStrictEqual(estimateSet({ logged: [W2(15, 0)], at: 0, weightKg: 100, row: { ...row, last_sets: [[100, 10]] } }), { reps: 10, rir: 1, source: "last" }, "its own 15 is no e1RM");
  });
  check("#estimate a bodyweight lift (0 kg) estimates from the same session's reps too", () => {
    const B = (reps, rir) => ({ exercise: "pull-up", set_type: "work", weight_kg: 0, reps, rir, completed_at: "t" });
    assert.deepStrictEqual(estimateSet({ logged: [B(10, 2)], at: 1, weightKg: 0, row: { exercise: "pull-up", rep_range: "6-12", rir: "1-2" } }), { reps: 9, rir: 2, source: "session" });
    assert.equal(estimateSet({ logged: [], at: 0, weightKg: 0, row: { exercise: "pull-up", rep_range: "6-12", rir: "1-2", last_sets: [[0, 10]] }, setNo: 0 }).source, "last");
  });
  check("#est-edit resolveEdit: an RIR the user changed is real (0-10); untouched or junk text changes nothing", () => {
    const entry0 = { exercise: "bench", set_type: "work", weight_kg: 100, reps: 9, est: ["reps"], rir_est: 2, completed_at: "t" };
    const base = { entry0, wText: "100", rText: "9", qText: "2", shownW: "100", shownR: "9", shownQ: "2", unit: "kg" };
    assert.equal("rir" in resolveEdit(base).patch, false, "untouched");
    assert.equal(resolveEdit({ ...base, qText: "1" }).patch.rir, 1);
    for (const q of ["11", "x", "", "-1"]) assert.equal("rir" in resolveEdit({ ...base, qText: q }).patch, false, `'${q}' ignored`);
    const after = editLoggedSet([entry0], 0, resolveEdit({ ...base, qText: "1" }).patch, { exercise: "bench", completed_at: "t" });
    assert.deepStrictEqual([after[0].reps, after[0].est, after[0].rir, after[0].rir_est], [9, ["reps"], 1, undefined], "the RIR became real; the reps stay an estimate");
  });
  check("#est-history the History editor drops an estimate only when its reps text changed (and never sends the display name)", () => {
    const { historyEditSet } = playerCore;
    const set = { exercise: "bench", name: "Bench", set_type: "work", weight_kg: 100, reps: 9, est: ["reps"], rir_est: 2, completed_at: "t" };
    const keep = { exercise: "bench", set_type: "work", weight_kg: 100, reps: 9, est: ["reps"], rir_est: 2, completed_at: "t" };
    assert.deepStrictEqual(historyEditSet(set, { wText: "100", rText: "9", unit: "kg" }), keep, "untouched: the estimate stays");
    const { est, ...real } = keep;
    assert.deepStrictEqual(historyEditSet(set, { wText: "100", rText: "8", unit: "kg" }), { ...real, reps: 8 }, "a real count: est gone, the RIR estimate stays");
    assert.deepStrictEqual(historyEditSet(set, { wText: "102.5", rText: "9", unit: "kg" }), { ...keep, weight_kg: 102.5 }, "a weight fix leaves the reps an estimate");
    assert.deepStrictEqual(historyEditSet(set, { wText: "100", rText: "junk", unit: "kg" }), keep, "junk keeps the stored count — and its flag");
    assert.equal(historyEditSet({ ...set, weight_kg: 10.21 }, { wText: "22.5", rText: "9", unit: "lb" }).weight_kg, 10.21, "an untouched lb display keeps the stored kg exactly (W274)");
  });
  check("#est-show repsShown: '~9' for an estimated count (a log entry or a chip), '9' otherwise", () => {
    assert.equal(repsShown({ reps: 9, est: ["reps"] }), "~9");
    assert.equal(repsShown({ reps: 9, est: true }), "~9");
    assert.equal(repsShown({ reps: 9 }), "9");
  });
}

// --- W308 (Burst 9 — the read-out half of owner note 1, "rest tracking"): each lift's median time between its work sets,
// from the completed_at stamps every set already carries (a superset round's legs share one), beside the timer it ran.
{
  const { liftGaps } = playerCore;
  const at = (sec) => new Date(Date.UTC(2026, 10, 9, 10, 0, 0) + sec * 1000).toISOString();
  const W = (ex, sec, extra = {}) => ({ exercise: ex, set_type: "work", weight_kg: 100, reps: 8, completed_at: at(sec), ...extra });
  check("#gaps liftGaps: the median gap between a lift's work sets — warm-ups, a pause past 15 min and unstamped sets left out", () => {
    const log = [W("bench", 0, { set_type: "warmup" }), W("bench", 60), W("bench", 280), W("bench", 500), W("bench", 760), W("row", 900), W("row", 900 + 16 * 60),
      W("curl", 2000), { exercise: "curl", set_type: "work", reps: 8 }];
    const g = liftGaps(log);
    assert.deepStrictEqual(g.bench, { median_s: 220, n: 3 }, "220, 220, 260 → 220");
    assert.equal(g.row, undefined, "its only gap was a 16-minute pause");
    assert.equal(g.curl, undefined, "one stamped set: no gap");
  });
  check("#gaps a superset's legs share each round's stamp: each leg's gap is the round-to-round time", () => {
    const log = [W("curl", 100), W("tri", 100), W("curl", 250), W("tri", 250), W("curl", 410), W("tri", 410)];
    assert.deepStrictEqual(liftGaps(log), { curl: { median_s: 155, n: 2 }, tri: { median_s: 155, n: 2 } }, "150, 160 → 155");
  });
  check("#gaps the read-out carries each lift's gap and the timer it ran (targets.rest_s) — and an estimate's ~ for Nerd Mode", () => {
    const t = [{ exercise: "bench", sets: 3, rep_range: "8-12", rir: "1-2", rest_s: 180 }];
    const l = localReadout(t, [W("bench", 0), W("bench", 220, { est: ["reps"] }), W("bench", 450)]).lifts[0];
    assert.deepStrictEqual([l.gap_s, l.rest_s, l.reps_shown], [225, 180, ["8", "~8", "8"]]);
    const none = localReadout([{ exercise: "bench", sets: 1, rep_range: "8-12" }], [W("bench", 0)]).lifts[0];
    assert.deepStrictEqual([none.gap_s, none.rest_s], [null, null]);
  });
  check("#gaps buildTargets stamps the timer each lift actually ran (sess.restUsed), only where one ran", () => {
    const t = buildTargets({ ex: [{ exercise: "bench", sets: 3 }, { exercise: "row", sets: 3 }], restUsed: { bench: 210 } });
    assert.deepStrictEqual([t[0].rest_s, "rest_s" in t[1]], [210, false]);
  });
}

// --- Burst 9 review (D1/D2, lesson 98): the read-out grades as the engine judges — an estimated set's weight anchors, a
// lift with any estimate at that weight is never "at the top", and the anchor weight is the one the session worked at.
check("#est (review D2) the read-out never calls a lift 'at the top' with an estimate at the weight — as the engine never bumps", () => {
  const t = [{ exercise: "hack-squat", sets: 3, rep_range: "6-10", rir: "1-2" }];
  const R = (reps, extra = {}) => ({ exercise: "hack-squat", set_type: "work", weight_kg: 60, reps, rir: 1, ...extra });
  const E = (reps) => ({ exercise: "hack-squat", set_type: "work", weight_kg: 60, reps, est: ["reps"] });
  assert.equal(localReadout(t, [R(10), E(8), E(6)]).lifts[0].top, false, "forgotten weaker sets: not the top");
  assert.equal(localReadout(t, [R(10), E(10), R(10)]).lifts[0].top, false, "an estimate at the top: still not the top");
  assert.equal(localReadout(t, [R(10), R(10), R(10)]).lifts[0].top, true, "control");
  const b = localReadout(t, [E(7), { exercise: "hack-squat", set_type: "work", weight_kg: 45, reps: 10, rir: 1 }, { exercise: "hack-squat", set_type: "work", weight_kg: 45, reps: 10, rir: 1 }]).lifts[0];
  assert.deepStrictEqual([b.anchor_kg, b.top, b.under], [60, false, 0], "(D1) the top set's weight anchors, even estimated");
});

// --- Burst 9 review (W310): the fixes' own tests.
{
  const { estimateSet, liftGaps, dropSkipped } = playerCore;
  check("#estimate (review engine#2) both real neighbours bound the guess: 12, ?, 12 is ~12 (it was ~8), and a later set is never out-lifted", () => {
    const B = (reps, rir = null) => ({ exercise: "bench", set_type: "work", weight_kg: 100, reps, ...(rir != null ? { rir } : {}), completed_at: "t" });
    const row = { exercise: "bench", rep_range: "8-12", rir: "1-2" };
    assert.deepStrictEqual(estimateSet({ logged: [B(12), B(12, null), B(12)], at: 1, weightKg: 100, row, beginner: true }), { reps: 12, rir: null, source: "session" });
    assert.deepStrictEqual(estimateSet({ logged: [B(10, 2), B(0), B(9, 2)], at: 1, weightKg: 100, row }), { reps: 9, rir: 2, source: "session" }, "10@2 then 9@2: set 2 between them");
  });
  check("#gaps (review engine#3) a gap with ANOTHER lift's sets inside it isn't time between sets — a superset partner's shared stamp is", () => {
    const at = (sec) => new Date(Date.UTC(2026, 10, 9, 10, 0, 0) + sec * 1000).toISOString();
    const W = (ex, sec) => ({ exercise: ex, set_type: "work", weight_kg: 50, reps: 8, completed_at: at(sec) });
    const g = liftGaps([W("bench", 0), W("row", 150), W("row", 300), W("bench", 400), W("bench", 600)]);
    assert.deepStrictEqual(g.bench, { median_s: 200, n: 1 }, "only bench→bench with nothing between");
    assert.deepStrictEqual(g.row, { median_s: 150, n: 1 });
    assert.deepStrictEqual(liftGaps([W("curl", 0), W("tri", 0), W("curl", 150), W("tri", 150)]).curl, { median_s: 150, n: 1 }, "a round's partner shares the stamp");
  });
  check("#skip (review crash#1) a skipped set takes its guessed numbers with it: the shrunk lift's reps, effort and pending estimate go", () => {
    const before = { ex: [{ exercise: "bench", sets: 3 }, { exercise: "row", sets: 3 }], reps: { 0: 9, 1: 10 }, eff: { 0: 2, 1: 1 }, estPending: { bench: { setNo: 1, reps: 9, rirChip: 2, rir: 2 } } };
    const after = { ...before, ex: [{ exercise: "bench", sets: 2 }, { exercise: "row", sets: 3 }] };
    const r = dropSkipped(before, after);
    assert.deepStrictEqual([r.reps, r.eff, r.estPending], [{ 1: 10 }, { 1: 1 }, {}]);
    assert.equal(dropSkipped(before, before), before, "nothing shrank: the same session back");
  });
  check("#skip (review copy#1) an undone skip takes its 'Pick a different one' offer with it", () => {
    const sess = { session_id: "s", ex: [{ exercise: "bench", sets: 2, rep_range: "8-12" }, { exercise: "row", sets: 2, rep_range: "8-12" }], logged: [{ exercise: "bench", set_type: "work", weight_kg: 50, reps: 8 }], i: 0, set: 1, weights: {}, reps: {}, eff: {}, wUnits: {} };
    const r = skipSet(sess);
    const offered = { ...r.sess, offerPick: { kind: "skip", name: "Bench" } };
    const u = undoSkip(offered);
    assert.equal(u.ok, true);
    assert.equal("offerPick" in u.sess, false);
  });
  check("#est-edit (review crash#0) the editor edits from the entry it OPENED with: a value typed and typed back is the original — flags and all", () => {
    const base = { exercise: "bench", set_type: "work", weight_kg: 30, reps: 9, est: ["reps"], rir_est: 2, completed_at: "t" };
    let log = [base];
    const step = (r, q) => { const { patch } = resolveEdit({ entry0: base, wText: "30", rText: r, qText: q, shownW: "30", shownR: "9", shownQ: "2", unit: "kg" }); log = editLoggedSet(log, 0, patch, { exercise: "bench", completed_at: "t", base }); };
    step("10", "3");
    assert.deepStrictEqual([log[0].reps, log[0].rir, "est" in log[0], "rir_est" in log[0]], [10, 3, false, false], "typed: real");
    step("9", "2");
    assert.deepStrictEqual(log[0], base, "typed back: the estimate it was, untouched");
    const real = { exercise: "bench", set_type: "work", weight_kg: 30, reps: 10, rir: 2, completed_at: "u" };
    let log2 = [real];
    const step2 = (q) => { const { patch } = resolveEdit({ entry0: real, wText: "30", rText: "10", qText: q, shownW: "30", shownR: "10", shownQ: "2", unit: "kg" }); log2 = editLoggedSet(log2, 0, patch, { exercise: "bench", completed_at: "u", base: real }); };
    step2("3"); step2("2");
    assert.equal(log2[0].rir, 2, "RIR 3 then back to 2: 2");
  });
}

console.log(`\n${pass} session-core test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
