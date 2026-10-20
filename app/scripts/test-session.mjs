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
  loadForReps, nextSetHint, buildTargets, skipSet, skipRound, undoSkip, skipWouldFinish, hintInUnit, prefillInUnit, localReadout } from "../public/session-core.mjs";
// Node-only import (this test runs under Node, not the browser) — used ONLY to prove
// the client's checkSetPR duplicate agrees with the server's real engine, never to
// import it into the shipped client code.
import { priorPersonalBests, checkSetPR as checkSetPRServer, detectPersonalRecords, isLuckySet as isLuckySetServer, luckySetsInSession, loadForReps as loadForRepsServer } from "../../tools/derive-core.mjs";

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
check("#next-set a set UNDER the range near failure → a lighter next set that lands in it (100×6 on 8-12 → 90)", () => {
  assert.deepStrictEqual(nextSetHint(w(100, 6), row812), { kind: "lighter", kg: 90, from_kg: 100, reps: 6, min: 8, max: 12, rir: null, band: "1-3" });
  assert.strictEqual(nextSetHint(w(100, 6, { rir: 1 }), row812).kg, 92.5, "1 in reserve means a stronger e1RM (100·(1+7/30)=123.3 → 94.9) → a smaller ease");
});
check("#next-set a set well OVER the range, or far easier than the band → a heavier next set", () => {
  assert.deepStrictEqual(nextSetHint(w(40, 15), row812), { kind: "heavier", kg: 42.5, from_kg: 40, reps: 15, min: 8, max: 12, rir: null, band: "1-3" });
  assert.strictEqual(nextSetHint(w(40, 10, { rir: 5 }), row812).kind, "heavier", "RIR 5 against a 1-3 band");
  assert.strictEqual(nextSetHint(w(40, 13), row812), null, "one rep over the top: on target enough (the next session adds load)");
});
check("#next-set no hint when on target, stopped early, a warm-up, planned-easy, or at bodyweight", () => {
  assert.strictEqual(nextSetHint(w(100, 9), row812), null);
  assert.strictEqual(nextSetHint(w(100, 6, { rir: 3 }), row812), null, "stopped with 3 in the tank: not too heavy");
  assert.strictEqual(nextSetHint({ ...w(40, 4), set_type: "warmup" }, row812), null);
  assert.strictEqual(nextSetHint(w(100, 6, { deload: true }), row812), null, "deload sets are planned easy");
  assert.strictEqual(nextSetHint(w(0, 4), row812), null);
  assert.strictEqual(nextSetHint(null, row812), null);
});
check("#next-set a dumbbell isolation moves in its own 1 kg steps, capped at ±20%", () => {
  assert.strictEqual(nextSetHint(w(10, 8), { rep_range: "12-20", rir: "1-3", inc_kg: 1 }).kg, 8);
  assert.strictEqual(nextSetHint(w(100, 1), row812).kg, 80, "a far miss is capped at −20%");
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
  assert.strictEqual(nextSetHint(w(60, 6), r23).kg, 52.5);
  assert.strictEqual(nextSetHint(w(60, 6), row812).kg, 55);
  assert.strictEqual(nextSetHint(w(40, 10, { rir: 4 }), r23), null, "top 3: RIR 4 is only 1 above");
  assert.strictEqual(nextSetHint(w(40, 10, { rir: 5 }), r23).kind, "heavier", "RIR 5 is 2 above");
});
check("#next-set-review the clamps: at least one step down; at most +20% up; a set stopped early UNDER the range never hints heavier", () => {
  assert.strictEqual(nextSetHint(w(60, 5, { rir: 1 }), { rep_range: "6-10", rir: "0-1", inc_kg: 2.5 }).kg, 57.5, "raw = 60 exactly → still one step down");
  assert.strictEqual(nextSetHint(w(40, 30), row812).kg, 47.5, "uncapped it would be 55");
  assert.strictEqual(nextSetHint(w(60, 5, { rir: 5 }), row812), null, "under the range AND stopped early: no hint either way");
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
check("#local-readout an OLD workout without targets still reads (no plan, no grades) — and says it had none", () => {
  const r = localReadout(undefined, [ws("a", 50, 10), ws("a", 50, 9)]);
  assert.deepStrictEqual(r.lifts.map((l) => [l.exercise, l.done, l.planned, l.top, l.under]), [["a", 2, null, false, 0]]);
  assert.strictEqual(r.hasPlan, false);
  assert.strictEqual(localReadout([tg("a", 2)], [ws("a", 50, 10)]).hasPlan, true);
});

console.log(`\n${pass} session-core test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
