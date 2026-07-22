// Unit tests for the pure session-player logic (public/session-core.mjs) — the
// crash-safety-critical parts of the superset "station". Exists because that logic
// is DOM-coupled in app.js and can't be reached by the route tests, yet a mistake
// there silently DROPS an exercise (a superset partner that sits non-adjacent to
// its pair would be skipped by the post-station advance). These tests replay the
// player's exact control flow over the pure helpers and assert every exercise gets
// trained the right number of times, in a sane order, across a mid-session resume.
import assert from "node:assert";
import { orderSupersetAdjacent, loggedWorkSets, nextUnfinishedIndex, stationProgress, dropDelivered } from "../public/session-core.mjs";

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

console.log(`\n${pass} session-core test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
