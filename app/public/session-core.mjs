// Pure session-player logic — no DOM, no localStorage, no timers — so the
// crash-safety-critical parts of the player can be unit-tested in Node exactly as
// they run in the browser. app.js imports these; tools/… never touch the DOM here.
//
// Two invariants this module protects:
//  1. A superset pair the generative engine emits is NOT guaranteed adjacent in the
//     session (it appends the bonus isolation, then a stable compound-before-
//     isolation sort can leave another isolation between the two). The player walks
//     the pair as one "station"; if an unrelated exercise sits between the pair, the
//     post-station "advance to next unfinished" step would jump PAST it and silently
//     drop it. orderSupersetAdjacent pulls the partner up next to its leader first,
//     so the between exercise moves after the pair and is still trained.
//  2. Progress is derived from banked (logged) sets, never a trusted cursor — a
//     crash/resume then always recomputes an honest position.

// Move a superset partner to sit immediately after its leader. Both members are
// isolations, so this only reorders within the isolation block — compounds keep
// their leading order. Returns a new array; input is not mutated. At most one pair
// exists per session (engine invariant), so one pass suffices.
export function orderSupersetAdjacent(ex) {
  const li = ex.findIndex((x) => x.superset_with && ex.some((y) => y.exercise === x.superset_with));
  if (li < 0) return ex;
  const pi = ex.findIndex((y) => y.exercise === ex[li].superset_with);
  if (pi < 0 || Math.abs(pi - li) === 1) return ex; // partner absent or already adjacent
  const leader = Math.min(li, pi), partner = Math.max(li, pi);
  const out = ex.slice();
  const [moved] = out.splice(partner, 1); // partner > leader, so removing it
  out.splice(leader + 1, 0, moved);        // doesn't shift the leader's index
  return out;
}

// How many WORK sets have been banked for an exercise (warm-ups don't count toward
// the target). The crash-safe source of truth for "where am I".
export const loggedWorkSets = (logged, exId) =>
  logged.filter((l) => l.exercise === exId && l.set_type === "work").length;

// Index of the next exercise after `from` that still owes work sets — skips any
// already fully logged (e.g. a superset partner completed during its station).
// Returns -1 when nothing after `from` is unfinished.
export function nextUnfinishedIndex(logged, ex, from) {
  for (let k = from + 1; k < ex.length; k++) {
    if (loggedWorkSets(logged, ex[k].exercise) < ex[k].sets) return k;
  }
  return -1;
}

// Remove exactly the offline-queue item that was just delivered, BY IDENTITY.
// Position-based removal (queue.slice(1)) drops the WRONG item when two tabs flush
// concurrently on reconnect — a second tab can shift the head between this tab's
// read and write, silently dropping an UNdelivered workout. filter-by-id can only
// ever remove the item we actually delivered, so no logged workout is ever lost;
// server writes are idempotent (session_id / date dedup) so a double delivery is
// harmless. (Pure helper; the offline queue lives in app.js.)
export const dropDelivered = (queue, id) => queue.filter((x) => x.id !== id);

// Given a superset pair (indices L<P) and the log, the current 0-indexed round and
// how many rounds are paired (the shorter member's set count). round >= paired
// means the paired work is done and any remainder is finished the normal way.
export function stationProgress(logged, ex, L, P) {
  const paired = Math.min(ex[L].sets, ex[P].sets);
  const round = Math.min(loggedWorkSets(logged, ex[L].exercise), loggedWorkSets(logged, ex[P].exercise));
  return { paired, round, done: round >= paired };
}
