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

// "Can't do this one?" (W272): replace the lift at slot i with `row` — the Today row
// the server built for the replacement (or a minimal one when it couldn't). The old
// swap spread {...cur}, so the old lift's last_kg, pr_watch, eased and suggestion note
// rode onto the new one: a wrong "Last time", the typo guard judged against the wrong
// lift, fake PR toasts, a deload tag. Now the slot keeps only its PRESCRIPTION — what
// the plan asked of this slot today, deload scaling included — and every other field
// is the row's own (a field the row lacks is simply absent, never inherited). The
// pairing is ALWAYS dropped: pairing is a live-session decision, and tomorrow's Today
// restores the plan's own.
// Refuses — { ok: false, reason, sess } with `sess` untouched — unless the slot still
// holds the lift that was tapped (`expect`: a slow response must never replace
// whatever the cursor has moved on to), that lift has no banked WORK set (logged work
// is never orphaned), and no OTHER slot holds the new lift (progress is counted per
// exercise id, so a duplicate silently skips one of them). Undo is the same call in
// reverse, with the saved old row. Pure: resets only slot i's typed inputs.
// planned_sets (W280): the slot's ORIGINAL set count, which a skip never shrinks — the
// target the finished workout reports, so it belongs to the slot, never the swapped-in lift.
export const PRESCRIPTION_KEYS = ["sets", "planned_sets", "rep_range", "rir"];
export function replaceSlot(sess, i, row, { expect, sets, plannedSets } = {}) {
  const cur = sess?.ex?.[i];
  const refuse = (reason) => ({ ok: false, reason, sess });
  if (!cur || !row?.exercise) return refuse("no-slot");
  if (expect == null || cur.exercise !== expect) return refuse("moved");
  if (loggedWorkSets(sess.logged, expect) > 0) return refuse("started");
  if (sess.ex.some((x, k) => k !== i && x.exercise === row.exercise)) return refuse("duplicate");
  const { superset_with, superset_with_name, ...slot } = row;
  for (const k of PRESCRIPTION_KEYS) { if (k in cur) slot[k] = cur[k]; else delete slot[k]; }
  // The lift the PLAN put in this slot (N7, Burst 6), kept across chained swaps so a second "Can't do"
  // lands in the plan's slot, not appended. Computed here, never taken from a row; gone once the slot
  // holds that lift again (an Undo back to it). An older blob has none: the live lift stands for it.
  const origin = typeof cur.slot_of === "string" ? cur.slot_of : cur.exercise;
  if (origin !== row.exercise) slot.slot_of = origin; else delete slot.slot_of;
  // A skip (W281) shrank `sets` for the OLD lift; the swapped-in lift starts from the slot's
  // planned count (a swap is only ever offered before any set of the old lift was banked).
  if (Number.isInteger(cur.planned_sets)) slot.sets = cur.planned_sets;
  // A tired swap or ease (Burst 6) does a trimmed dose, written as the slot's plan for TODAY — a coach-set dose, so the
  // workout reads "every set done", never a shortfall that holds the lift (W280). A skip never does this (it keeps
  // planned_sets); Undo passes the saved row's own count back, or the trimmed count would stick to the old lift.
  // `plannedSets`: an Undo restores the saved row's own plan too, so a skip taken before the tired tap stays taken (round 2).
  if (Number.isInteger(sets) && sets > 0) { slot.sets = sets; slot.planned_sets = Number.isInteger(plannedSets) && plannedSets >= sets ? plannedSets : sets; }
  const without = (cache) => { const out = { ...(cache ?? {}) }; delete out[i]; return out; };
  const out = { ...sess, ex: sess.ex.map((x, k) => (k === i ? slot : x)),
    weights: without(sess.weights), reps: without(sess.reps), eff: without(sess.eff), wUnits: without(sess.wUnits) };
  delete out.lastSkip; // a swap rewrites the slot's count: an older skip's undo no longer describes it
  if (sess.i === i) out.set = loggedWorkSets(sess.logged, row.exercise);
  return { ok: true, sess: out };
}

// "Too tired for this one?" (Burst 6 — owner: "I was too tired after doing leg press and RDLs to do Bulgarian split
// squats. There is currently no solution… besides 'skip this one'"). Most of a set's growth comes from the first few
// hard sets (minimalist-and-low-volume-training.md, Grade A), so a tired lift does about half its sets — never under
// 2 for a lift planned at 2+ (the engine's own no-1-set rule), never more than planned.
export const tiredSets = (n) => (n <= 2 ? n : Math.max(2, Math.ceil(n / 2)));
// About 10% off, on the lift's own KG step (never a display step: a pounds user's 5-lb plate against a kg weight cut
// 20 kg to 15), at least one step; never to zero. Null when there is no weight to ease. A model estimate (Grade D).
// `floorKg`: never under it — the empty bar for a barbell lift (review K7: 20 kg went to 17.5).
export function easeKg(kg, stepKg, floorKg = 0) {
  if (!(typeof kg === "number" && kg > 0) || !(stepKg > 0)) return null;
  let w = Math.round((0.9 * kg) / stepKg) * stepKg;
  if (w >= kg) w = kg - stepKg;
  w = Math.max(w, floorKg);
  return w > 0 && w < kg ? Math.round(w * 100) / 100 : kg;
}
// The tired dose for a slot: about half its planned sets — never more than it shows now (a skip already taken stays
// taken: 1 set left never became 2 — review K6).
export const tiredDose = (row) => Math.min(row.sets, tiredSets(row.planned_sets ?? row.sets));
// When nothing easier fits (or offline, or the server couldn't build a row): the SAME lift, ~10% lighter and about half
// the sets. A lift with history is tagged `eased` — its sets bank deload-tagged, so a tired day never becomes its
// anchor, a PR or a grade — and says so; a lift with none isn't (its sets seed a starting weight). `tired` marks the
// slot as the tired version (`eased` alone also means a comeback). Its OWN reason replaces the served one ("add
// 2.5 kg" beside an eased weight was the recap's contradiction on the set screen). Same guards as a swap.
// Its reason says only what changed ON SCREEN (review): `shown(row)` is the weight the stepper will show for a row (the
// player passes its plate-rounded pre-fill), so a pounds user's 1 kg ease that rounds back onto the same plate changes
// nothing and claims nothing; "shorter" only when sets were cut; neither, and it says neither.
// A bump served today is dropped back to last time's weight, exactly (round 2: a pounds user's plate rounding kept a +33%
// bump, or cut 40% from a light one); with no bump, ~10% off. Every tired day is tagged `eased` — with history or without
// (round 2: "keep this one easy" was then graded "too easy" on a never-done lift) — so it never anchors, PRs or grades.
// Was a progression bump served today? (A bodyweight lift's first added load is a bump over bodyweight, last_kg 0 — round 3.)
// ONE rule for the ease and a tired swap alike: a tired day never steps up (round 5).
export const tiredBump = (row) => typeof row?.last_kg === "number" && (row.last_kg > 0 || (row.last_kg === 0 && row.equipment === "bodyweight")) && row.suggested_kg > row.last_kg;
// A tired SWAP's substitute (round 5): planned easy like every tired day; a bump served today held at last time's weight (a
// tired lifter was handed a never-lifted 42.5 kg on the "easier" lift); and its reason says the day won't count — never the
// estimate's "adjust it up or down until…", a weight that tag then throws away.
export function tiredSwapRow(row) {
  const bumped = tiredBump(row);
  const known = Array.isArray(row.last_reps) && row.last_reps.length > 0;
  // (after an easier day of the substitute, its last time WAS that day: name the regular one, as its own screen does — round 6)
  const note = bumped ? `Same weight as ${row.last_easy ? "your last regular session" : "last time"} — no step up on a tired day. It won't count against your progress.`
    : known ? `${row.suggestion_note ? `${row.suggestion_note} ` : ""}It won't count against your progress.`
    : "Keep it light today — it won't set this lift's starting weight.";
  const { alt_kg: _altKg, alt_reps: _altReps, ...kept } = row; // a tired day offers no lighter alternative (Burst 8 review #25)
  return { ...kept, ...(bumped ? { suggested_kg: row.last_kg } : {}), tired: true, eased: true, suggestion_note: note };
}
// A swap OF a tired slot is still the tired day (round 8): "It's busy right now", "Pick one myself" and "No machine" hand
// back a row the server built at the new lift's own progression — kept planned easy, any bump held, "it won't count", the
// tired dose carried by replaceSlot — or the tired day's light sets became the new lift's anchor. A regular slot: as it came.
export const swapInRow = (cur, row) => (cur?.tired ? tiredSwapRow(row) : row);
export function easeSlot(sess, i, { expect, stepKg, floorKg = 0, shown = (row) => row.suggested_kg } = {}) {
  const cur = sess?.ex?.[i];
  if (!cur) return { ok: false, reason: "no-slot", sess };
  const bumped = tiredBump(cur);
  const kg = bumped ? cur.last_kg : easeKg(cur.suggested_kg, stepKg, floorKg);
  const lighter = kg != null && kg < cur.suggested_kg && shown({ ...cur, suggested_kg: kg }) < shown(cur);
  const sets = tiredDose(cur);
  const note = `${lighter ? "Lighter for today because you're tired" : sets < cur.sets ? "Shorter today because you're tired" : "Easy does it today — stop each set while your form is solid"}. It won't count against your progress.`;
  // The held weight's lighter alternative belongs to the SERVED weight: dropped (Burst 8 review #25 — "Use 92.5 kg" sat
  // under a tired 90 kg and undid the ease in one tap).
  const { alt_kg: _altKg, alt_reps: _altReps, ...kept } = cur;
  const row = { ...kept, ...(lighter ? { suggested_kg: kg } : {}), tired: true, eased: true, suggestion_note: note };
  return replaceSlot(sess, i, row, { expect, sets });
}
// Offer it at the first set of a lift not yet started, once some work is banked today; never on a superset member (a
// station keeps "Skip this round"), a slot already made easier, or one showing its swap's Undo. Mid-lift, "Skip this
// set" and "End workout early" already cover it.
export function tiredOffer(sess) {
  const cur = sess?.ex?.[sess.i];
  return !!cur && !cur.superset_with && !cur.tired && sess.set === 0
    && loggedWorkSets(sess.logged ?? [], cur.exercise) === 0
    && (sess.logged ?? []).some((l) => (l?.set_type ?? "work") === "work")
    && !undoApplies(sess.swapUndo, sess, cur);
}

// "Skip this set" / "Skip this round" (W281, owner: "need ability to skip a set mid
// workout"). A skip SHRINKS today's target for the lift(s): `sets`, the field every "where
// am I" helper already reads, so progress stays derived from banked work sets and nothing
// in the crash-safe derivation changes shape. `planned_sets` keeps the original, so the
// finished workout's targets show the shortfall and the next weight increase waits (W280).
// It advances exactly as banking does, deciding "complete" by scanning from the START (a
// lift behind the cursor may still owe sets). One level of undo lives IN the saved session
// (`lastSkip`), valid only while nothing was banked and the order is unchanged since — so a
// reload can still undo, and a banked set, a defer or a swap retires it without any handler
// having to remember to. Station rounds shrink BOTH members (rounds stay balanced) and undo
// restores both, never one alone. Pure: returns a new session.
const orderKey = (sess) => sess.ex.map((x) => x.exercise).join("|");
function shrinkAndAdvance(sess, idxs, stillOn, from) {
  const ex = sess.ex.map((x, k) => (idxs.includes(k) ? { ...x, sets: x.sets - 1 } : x));
  const out = { ...sess, ex, lastSkip: { ids: idxs.map((k) => sess.ex[k].exercise), loggedLen: sess.logged.length, order: orderKey(sess), prevI: sess.i, prevSet: sess.set } };
  delete out.rest; // straight into the next set: a skip earns no rest
  if (stillOn(ex)) return { ok: true, sess: { ...out, set: loggedWorkSets(sess.logged, ex[sess.i].exercise) }, completes: false };
  // A single lift moves on like the bank handler (forward, then from the start); a finished
  // station like the station's bank handler — from the start, so the longer member's
  // remainder is picked next and finished alone.
  let nx = nextUnfinishedIndex(sess.logged, ex, from);
  if (nx < 0 && from >= 0) nx = nextUnfinishedIndex(sess.logged, ex, -1);
  if (nx < 0) return { ok: true, sess: { ...out, complete: true }, completes: true };
  return { ok: true, sess: { ...out, i: nx, set: loggedWorkSets(sess.logged, ex[nx].exercise) }, completes: false };
}
export function skipSet(sess) {
  const cur = sess?.ex?.[sess.i];
  if (!cur || loggedWorkSets(sess.logged, cur.exercise) >= cur.sets) return { ok: false, sess, completes: false };
  return shrinkAndAdvance(sess, [sess.i], (ex) => loggedWorkSets(sess.logged, cur.exercise) < ex[sess.i].sets, sess.i);
}
export function skipRound(sess, L, P) {
  const a = sess?.ex?.[L], b = sess?.ex?.[P];
  if (!a || !b || stationProgress(sess.logged, sess.ex, L, P).done) return { ok: false, sess, completes: false };
  return shrinkAndAdvance(sess, [L, P], (ex) => !stationProgress(sess.logged, ex, L, P).done, -1);
}
// Would this skip end the workout? The player asks for a second tap first ("Skip and finish?").
export const skipWouldFinish = (sess, station = null) => (station ? skipRound(sess, station[0], station[1]) : skipSet(sess)).completes === true;
export function undoSkip(sess) {
  const u = sess?.lastSkip;
  if (!u || sess.complete || u.loggedLen !== sess.logged.length || u.order !== orderKey(sess)) return { ok: false, sess };
  // Never past the plan (a swap and its undo in between can have restored the count already),
  // and the cursor is DERIVED from banked sets, never the stored one (Burst 1 review).
  if (sess.ex.some((x) => u.ids.includes(x.exercise) && Number.isInteger(x.planned_sets) && x.sets >= x.planned_sets)) return { ok: false, sess };
  const ex = sess.ex.map((x) => (u.ids.includes(x.exercise) ? { ...x, sets: x.sets + 1 } : x));
  // …and what the skip cleared comes back (W311 — the fix check player#1: Skip then Undo changes nothing).
  const k = u.kept;
  const out = { ...sess, ex, i: u.prevI, set: loggedWorkSets(sess.logged, ex[u.prevI].exercise),
    ...(k ? { reps: { ...(sess.reps ?? {}), ...k.reps }, eff: { ...(sess.eff ?? {}), ...k.eff }, estPending: { ...(sess.estPending ?? {}), ...k.estPending } } : {}) };
  delete out.lastSkip;
  delete out.offerPick; // the skip's "Pick a different one" goes with it (Burst 9 review copy#1)
  return { ok: true, sess: out };
}
// A skipped set takes its guessed numbers with it (Burst 9 review crash#1): every lift whose sets the skip shrank loses its
// steppers' reps and effort (its next set starts on its own aim, as after a bank) and any pending "Forgot the numbers?"
// estimate — they'd otherwise bank as real on the next set, or after an Undo. The same session back when nothing shrank.
export function dropSkipped(before, after) {
  const shrunk = (after?.ex ?? []).map((x, k) => (x.sets < (before?.ex?.[k]?.sets ?? x.sets) ? k : -1)).filter((k) => k >= 0);
  if (!shrunk.length) return after;
  const ids = new Set(shrunk.map((k) => after.ex[k].exercise));
  const pick = (m, keep) => Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => keep(k)));
  const at = (k) => shrunk.includes(+k);
  const kept = { reps: pick(after.reps, at), eff: pick(after.eff, at), estPending: pick(after.estPending, (id) => ids.has(id)) };
  return { ...after, reps: pick(after.reps, (k) => !at(k)), eff: pick(after.eff, (k) => !at(k)),
    ...(after.estPending ? { estPending: pick(after.estPending, (id) => !ids.has(id)) } : {}),
    // …kept on the skip itself, so its Undo gives them back (W311).
    ...(after.lastSkip ? { lastSkip: { ...after.lastSkip, kept } } : {}) };
}

// THE WORKOUT LIST'S ONE REORDER (W306, considerations iteration — owner: "when I start a workout, I can look at all the
// exercises… if I pick 'Do this later' or 'Skip this,' can you give me an option to pick what I want to do next?").
// permuteSess: ex[j] = old ex[order[j]], and the four INDEX-keyed caches (weights, reps, eff, wUnits — wUnits always
// travels with weights, or a weight banks in the wrong unit) follow their lifts by the same permutation. Everything else
// in the session is keyed by exercise id or by a position in `logged`, which a reorder never touches. Null on anything
// but a permutation. Pure.
export function permuteSess(sess, order) {
  const n = sess?.ex?.length ?? 0;
  if (!Array.isArray(order) || order.length !== n || new Set(order).size !== n || order.some((k) => !Number.isInteger(k) || k < 0 || k >= n)) return null;
  const to = new Map(order.map((old, j) => [old, j]));
  const remap = (cache) => { const out = {}; for (const [k, v] of Object.entries(cache ?? {})) { const j = to.get(+k); if (j != null) out[j] = v; } return out; };
  return { ...sess, ex: order.map((k) => sess.ex[k]), weights: remap(sess.weights), reps: remap(sess.reps), eff: remap(sess.eff), wUnits: remap(sess.wUnits) };
}
// The live block at slot k: the lift, plus its superset partner while their paired rounds aren't done (a station).
function liveBlock(sess, k) {
  const e = sess.ex[k];
  const p = e?.superset_with ? sess.ex.findIndex((x) => x.exercise === e.superset_with) : -1;
  return p < 0 || stationProgress(sess.logged, sess.ex, Math.min(k, p), Math.max(k, p)).done ? [k] : [Math.min(k, p), Math.max(k, p)];
}
// A reorder retires what was keyed to the old order: a running rest (its "Next: set N" named another lift — a skip
// earns no rest either) and a pending skip-undo, including the copy a tired swap stashed (lesson 47). The binder
// disarms the server rest alarm (syncRestAlert). `moved` marks a lift the user moved, for its set-0 cue.
function afterReorder(out, movedFrom, movedTo) {
  out.ex = out.ex.map((x, j) => (j >= movedFrom && j < movedTo ? { ...x, moved: true } : x));
  out.set = loggedWorkSets(out.logged, out.ex[out.i].exercise);
  delete out.rest; delete out.lastSkip;
  if (out.swapUndo?.lastSkip) out.swapUndo = { ...out.swapUndo, lastSkip: null };
  return out;
}
// "Do this next" (W306): the chosen lift — its superset partner with it, leader first — lands AT the cursor (the start of
// the current block, so a station is never split), and everything from there shifts back one block. Every unfinished
// lift therefore stays at or after the new cursor: the straight bank handler only looks FORWARD for the next lift, so a
// swap of two positions could strand one and end the workout early. Nothing the plan prescribes moves (sets, aims,
// suggested_kg, slot_of): today's weights keep their planned-position basis (W290); the next-set hint corrects after set 1.
export function moveToCurrent(sess, k) {
  const refuse = (reason) => ({ ok: false, reason, sess });
  if (!sess?.ex?.length) return refuse("no-slot");
  if (sess.complete) return refuse("complete");
  if (!Number.isInteger(k) || !sess.ex[k]) return refuse("no-slot");
  if (loggedWorkSets(sess.logged, sess.ex[k].exercise) >= sess.ex[k].sets) return refuse("done");
  const cur = liveBlock(sess, sess.i);
  if (cur.includes(k)) return refuse("current");
  const K = liveBlock(sess, k), p = cur[0], idx = [...sess.ex.keys()];
  const order = [...idx.filter((j) => j < p && !K.includes(j)), ...K, ...idx.filter((j) => j >= p && !K.includes(j))];
  const out = permuteSess(sess, order);
  out.i = order.indexOf(K[0]);
  return { ok: true, sess: afterReorder(out, out.i, out.i + K.length) };
}
// The workout list (W306): every lift, in the order it will be done — "now" (the cursor's lift, with its station partner),
// "done", "skipped" (a skip shrank today's count; `skipped` says by how many), or "later" (still owed — the only ones
// "Do this next" can pick). Derived from the banked log every time, never stored.
export function workoutList(sess) {
  if (!sess?.ex?.length) return [];
  const now = liveBlock(sess, sess.i);
  return sess.ex.map((x, idx) => {
    const done = loggedWorkSets(sess.logged, x.exercise), planned = Number.isInteger(x.planned_sets) ? x.planned_sets : x.sets;
    const skipped = Math.max(0, planned - x.sets);
    const status = now.includes(idx) ? "now" : done >= x.sets ? (skipped > 0 ? "skipped" : "done") : "later";
    return { idx, exercise: x.exercise, name: x.name ?? x.exercise, status, done, sets: planned, skipped, movable: status === "later",
      ...(x.superset_with && sess.ex.some((y) => y.exercise === x.superset_with) ? { pair: x.superset_with } : {}) };
  });
}
// "Do this later": the lift at the cursor goes to the end, and the cursor stays put — now on what was next. Only an
// unstarted single lift with something after it (the button's own gate).
export function deferToEnd(sess) {
  const refuse = (reason) => ({ ok: false, reason, sess });
  const cur = sess?.ex?.[sess?.i];
  if (!cur || sess.complete) return refuse("no-slot");
  if (sess.i >= sess.ex.length - 1) return refuse("last");
  if (cur.superset_with && sess.ex.some((x) => x.exercise === cur.superset_with)) return refuse("pair");
  if (loggedWorkSets(sess.logged, cur.exercise) > 0) return refuse("started");
  const order = [...[...sess.ex.keys()].filter((j) => j !== sess.i), sess.i];
  return { ok: true, sess: afterReorder(permuteSess(sess, order), sess.ex.length - 1, sess.ex.length) };
}

// Remove exactly the offline-queue item that was just delivered, BY IDENTITY.
// Position-based removal (queue.slice(1)) drops the WRONG item when two tabs flush
// concurrently on reconnect — a second tab can shift the head between this tab's
// read and write, silently dropping an UNdelivered workout. filter-by-id can only
// ever remove the item we actually delivered, so no logged workout is ever lost;
// server writes are idempotent (session_id / date dedup) so a double delivery is
// harmless. (Pure helper; the offline queue lives in app.js.)
export const dropDelivered = (queue, id) => queue.filter((x) => x.id !== id);

// Would logging THIS set, right now, beat the user's prior all-time best for its
// exercise? Powers the in-player PR celebration (roadmap #1 slice b) — fired the
// instant a set is banked, not only in the end-of-session recap.
//
// This DUPLICATES the rule set in tools/derive-core.mjs's checkSetPR/estimate1RM
// (RELIABLE_1RM_REPS=12, the >0.5kg e1rm noise margin, strict-greater for load
// PRs) rather than importing it: this file is served to the browser as a static
// asset and can't reach outside public/, while derive-core.mjs is a Node/Workers
// module. A cross-consistency test (test-session.mjs) replays fixtures through
// BOTH implementations and asserts identical verdicts, so a change to one set of
// thresholds without the other fails CI instead of silently letting the live
// celebration and the recap disagree.
// `priorBests` is the `pr_watch` object buildToday attaches to each exercise:
// `{ e1rm_kg, load_kg }`, either possibly null (no qualifying history yet). `deload`
// mirrors the server's `set.deload` check (derive-core.mjs's checkSetPR/detectPersonalRecords):
// a planned-easy set is light on WEIGHT only, so Epley's rep-reward can still out-score a
// true heavy best — never a real record.
const RELIABLE_1RM_REPS = 12;
// An ESTIMATED rep count (W307 "Forgot the numbers?") never celebrates — byte-identical to derive-core's predicate.
export const repsEstimated = (set) => Array.isArray(set?.est) && set.est.includes("reps");
export function checkSetPR(exercise, weightKg, reps, setType, priorBests, deload, estReps = false) {
  if (deload || estReps) return null;
  if ((setType ?? "work") === "warmup") return null;
  if (!(typeof reps === "number" && reps > 0 && typeof weightKg === "number" && weightKg > 0)) return null;
  if (reps <= RELIABLE_1RM_REPS) {
    const prev = priorBests?.e1rm_kg;
    if (prev == null) return null;
    const e1rm = reps === 1 ? weightKg : weightKg * (1 + reps / 30);
    if (e1rm - prev > 0.5) return { kind: "e1rm", e1rm_kg: Math.round(e1rm * 100) / 100, delta_kg: Math.round((e1rm - prev) * 10) / 10 };
    return null;
  }
  const prev = priorBests?.load_kg;
  if (prev != null && weightKg > prev) return { kind: "load", load_kg: weightKg, reps };
  return null;
}

// Does this set look like a typo rather than a lift? A stray zero, or lb typed
// into a kg field, is expensive here and nearly impossible to take back: the set
// is celebrated as a PR, it anchors the NEXT session's suggested weight, and it
// becomes that week's best in the plateau/cadence trends for good. So the player
// asks once before banking it. The server's own ceiling (MAX_SET_WEIGHT_KG) is the
// real guard against garbage; this is the ergonomic guard against a realistic slip.
//
// Judged against the lift's OWN history — `last_kg` (what they actually lifted on
// this exercise last time) first, falling back to its best logged load — so a
// genuinely strong lifter is never second-guessed, and a lift with no history at
// all is never questioned (there's nothing to be implausible against; and a new
// lift's find-your-weight card tells them to add weight set by set).
//
// …raised by TODAY's heaviest banked work set of the lift (Burst 6 — owner: "it asked
// me again… It shouldn't ask me the second time"). Every banked work set passed this
// guard or was confirmed, so a weight already logged today is never questioned again;
// a stray zero against it still is. Today's sets only ever RAISE the reference — a
// light set never lowers it, and they never create one for a lift with no history.
// Derived from the log, never a remembered "confirmed" flag, so a reload or an edit
// that corrects the set can't leave it stale. Warm-ups never vouch (never checked).
//
// BOTH a ratio and an absolute gap must be exceeded. Ratio alone would nag on
// small weights where a real jump is proportionally huge (2.5 kg → 7.5 kg on a
// lateral raise is 3x and entirely normal); the absolute floor keeps those quiet
// while still catching the two errors that actually happen: a stray zero (10x) and
// an lb/kg mix-up (2.2x). Reps get a flat ceiling instead — no prescribed band in
// the engine goes near 50, so there's no plausible entry to false-positive on — and
// a count no higher than one already banked today isn't asked again either.
export const IMPLAUSIBLE_RATIO = 2;
export const IMPLAUSIBLE_MIN_JUMP_KG = 20;
export const IMPLAUSIBLE_REPS = 50;
// Today's heaviest banked WORK set of a lift, and its most reps. `exceptIdx` leaves out the
// entry being edited (it can't vouch for itself, and the editor writes keystrokes into it).
export function todayTopSet(logged, exercise, exceptIdx = -1) {
  let kg = null, reps = null;
  (logged ?? []).forEach((l, k) => {
    if (k === exceptIdx || l?.exercise !== exercise || (l.set_type ?? "work") !== "work") return;
    if (typeof l.weight_kg === "number" && Number.isFinite(l.weight_kg) && l.weight_kg > 0 && (kg == null || l.weight_kg > kg)) kg = l.weight_kg;
    if (Number.isInteger(l.reps) && !repsEstimated(l) && (reps == null || l.reps > reps)) reps = l.reps; // an estimate vouches for nothing (W307)
  });
  return { kg, reps };
}
// The load an entry is judged against, and where it came from (the cue names it): last time's,
// else the best — raised to today's heaviest banked set when that is at least as heavy.
export function typoReference({ lastKg = null, priorBests = null, todayKg = null } = {}) {
  const ok = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const hist = ok(lastKg) ? { kg: lastKg, from: "last" } : ok(priorBests?.load_kg) ? { kg: priorBests.load_kg, from: "best" } : null;
  if (!hist) return null;
  return ok(todayKg) && todayKg >= hist.kg ? { kg: todayKg, from: "today" } : hist;
}
export function isImplausibleSet(weightKg, reps, { lastKg = null, priorBests = null, todayKg = null, todayReps = null } = {}) {
  if (typeof reps === "number" && reps > IMPLAUSIBLE_REPS && !(Number.isInteger(todayReps) && reps <= todayReps)) return true;
  if (!(typeof weightKg === "number" && Number.isFinite(weightKg) && weightKg > 0)) return false;
  const ref = typoReference({ lastKg, priorBests, todayKg });
  if (ref == null) return false;
  return weightKg >= ref.kg * IMPLAUSIBLE_RATIO && weightKg - ref.kg >= IMPLAUSIBLE_MIN_JUMP_KG;
}

// Which of a station's exercises still owe a confirming tap: flagged as a possible
// typo AND not yet confirmed. The single-lift player only ever asks about one lift,
// but a SUPERSET banks two at once — and the confirm state used to be a single
// exercise id, so when BOTH members looked implausible (one lb/kg mix-up hits both
// lifts of a round at once) confirming one silently un-confirmed the other: every
// tap of "Tap again — log the round as entered" just moved the warning across, and
// the round could never be banked at all. A button whose label promises an action
// it can never perform is worse than a blocked one — the user's only escape was
// the unlink button, which nothing told them to use.
//
// Returning the whole list (not the first) is the fix: the caller confirms every
// flagged member together, so one deliberate second tap always banks the round,
// with a warning shown against each number it is questioning.
//
// Keyed by EXERCISE ID rather than position (`keyOf`) because Swap, "do this later"
// and Unlink all renumber the array — an index-keyed confirmation would suppress the
// warning for whatever lift inherited that slot.
export const unconfirmedFlagged = (indices, keyOf, isFlagged, confirmed) =>
  indices.filter((i) => !confirmed.has(keyOf(i)) && isFlagged(i));

// Lucky-set XP + hash — DUPLICATES tools/derive-core.mjs's LUCKY_SET_XP/isLuckySet
// (same reason as checkSetPR above: this file is a static browser asset and can't
// reach outside public/). A cross-consistency test (test-session.mjs) replays many
// session_id/exercise/index combinations through BOTH implementations and asserts
// identical verdicts, so a change to one without the other fails CI instead of
// silently letting the live toast and the recap/XP total disagree.
export const LUCKY_SET_XP = 15;
const LUCKY_SET_ONE_IN = 8;
export function isLuckySet(sessionId, exercise, hardSetIndex) {
  if (!sessionId) return false;
  const key = `${sessionId}|${exercise}|${hardSetIndex}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % LUCKY_SET_ONE_IN === 0;
}
// DUPLICATES tools/derive-core.mjs's isHardSet (same cross-file constraint as above).
// The load that should land `targetReps` at `targetRir` reps in reserve, from a set of
// `reps` at `weightKg` with `rir` in reserve — a BYTE-IDENTICAL copy of derive-core's
// loadForReps (the server's W279 ease uses that one; test-session pins the two together).
export function loadForReps(weightKg, reps, rir, targetReps, targetRir) {
  return weightKg * (1 + (reps + rir) / 30) / (1 + (targetReps + targetRir) / 30);
}
// THE ANCHOR of a lift's session — a BYTE-IDENTICAL copy of derive-core's anchorSets (Burst 6 review; test-session pins
// the two): the read-out grades effort and the top over the SAME sets the engine judges, never a lighter back-off.
export function anchorSets(sets, min) {
  const proved = sets.filter((s) => s.reps >= min).map((s) => s.weight_kg ?? 0);
  const weight = proved.length ? Math.max(...proved) : (sets[0].weight_kg ?? 0);
  const judged = sets.filter((s) => (s.weight_kg ?? 0) === weight);
  return { weight, judged, first: judged[0] };
}
// An empty Olympic bar — derive-core's EMPTY_BAR_KG (pinned equal): a tired ease never goes under it. A pounds user's
// bar is the 45-lb one (20.41 kg), never "40 lb" (Burst 6 review round 2).
export const EMPTY_BAR_KG = 20;
export const EMPTY_BAR_LB = 45;
// A set's reps AT THE PLAN'S EFFORT — a BYTE-IDENTICAL copy of derive-core's repsAtBand (Burst 6;
// test-session pins the two together): the read-out judges "the top of the range" exactly as the engine does.
export function repsAtBand(reps, rir, near) {
  return typeof rir === "number" && near > rir ? reps - (near - rir) : reps;
}
// The rep capacity (reps + RIR) a lift's NEXT set still has after this one — a BYTE-IDENTICAL
// copy of derive-core's nextSetCapacity (W288; test-session pins the two together).
export const SET_FATIGUE_PCT = { near: 20, mid: 10 };
export function nextSetCapacity(reps, rir) {
  const r = rir ?? 0;
  const pct = r <= 1 ? SET_FATIGUE_PCT.near : r <= 3 ? SET_FATIGUE_PCT.mid : 0;
  return (reps + r) * (100 - pct) / 100;
}
// "A more appropriate weight" for the NEXT set (W279b, owner consideration #3): after a work
// set that clearly misses the prescription — under the range near failure (RIR unlogged or
// ≤ 1; a set stopped early wasn't too heavy), or two+ reps over the top / far easier than the
// band — the load that should land the next one in range, from the set just banked. Lighter
// targets the range's bottom, heavier its top (the smallest move back into the range), both
// at the band's near edge; floored to the lift's increment, at least one increment, at most
// ±20%. The next set is NOT fresh (W288, Burst 5): the set's capacity is carried forward less
// what the next set loses (nextSetCapacity) — 70×5 at failure on 6-10 gives 62.5, not 65.
// Advice only: the player offers it, the user decides. Planned-easy (deload/eased), warm-up
// and bodyweight sets never hint. `target_reps` is the rep count the weight aims at.
// W305 (considerations iteration — owner: "I didn't achieve the recommended reps and intensity and it didn't suggest a
// more appropriate weight"): every miss the capacity model can judge gets an answer. Under the range WITH reps left
// (RIR ≥ 2) is no longer silent: if the set's capacity, less what the next set costs, still reaches the range at the
// band's near edge — the next set's served aim (`nextAim`: W289 aims can sit under the range — Burst 8 review #22), else
// the range's bottom — "same": the same weight, aim for that many; if not, lighter. A set IN (or just over) the range
// taken past the band gets no hint (Burst 8 review #4/#28/#45: following that back-off taught the engine wrong aims and
// earned a bump on one set). A barbell's lighter weight never goes under the empty bar; at the bar there is none (#40).
export function nextSetHint(set, row, { aim = null, nextAim = null } = {}) {
  if (!set || (set.set_type ?? "work") !== "work" || set.deload || repsEstimated(set) || !(set.weight_kg > 0) || !Number.isFinite(set.reps)) return null; // no advice from a guess (W307)
  const range = /(\d+)\s*-\s*(\d+)/.exec(row?.rep_range ?? "");
  if (!range) return null;
  const min = +range[1], max = +range[2];
  const band = /(\d+)\s*-\s*(\d+)/.exec(row?.rir ?? "");
  const near = band ? +band[1] : 1, top = band ? +band[2] : 2;
  const inc = row?.inc_kg > 0 ? row.inc_kg : 2.5;
  const w = set.weight_kg, rir = typeof set.rir === "number" ? set.rir : null;
  // A set that met its own aim (W289) is on plan, even under the range: 150×5,4,5 aims 5 on set 2 of a
  // 6-10 range, and doing 5 there is no miss (Burst 5 review). The player passes the aim only while the
  // weight is the served one.
  // …at the effort the aim assumed: met at failure under a wider band (an aim of 7 at 2-3 in reserve), it is
  // still a miss (fix verification).
  const metAim = Number.isInteger(aim) && set.reps >= aim && (rir == null || rir >= near);
  const cap = nextSetCapacity(set.reps, rir), reach = cap - near; // the next set's reps at the near edge, same weight
  // The next set's own aim LOWERS the bar (W289 aims can sit under the range, #22) — never raises it: an aim above the
  // range's bottom is no reason to send a set stopped early lighter.
  const ref = Number.isInteger(nextAim) ? Math.min(nextAim, min) : min;
  const short = set.reps < min && !metAim;
  const kind = short && (rir == null || rir <= 1) ? "lighter"
    : short && rir >= 2 ? (reach >= ref ? "same" : "lighter")
    : set.reps >= max + 2 || (rir != null && rir >= top + 2 && set.reps >= min) ? "heavier"
    : null;
  if (!kind) return null;
  if (kind === "same") return { kind, kg: w, from_kg: w, reps: set.reps, min, max, rir, band: band ? `${band[1]}-${band[2]}` : null, target_reps: Math.max(Math.min(ref, min), Math.min(max, Math.floor(reach + 1e-9))) };
  const under = kind === "lighter";
  // …only for a set ON the full bar: a barbell-tagged lift done lighter (an EZ bar at 15 kg) still eases (fix C4).
  const bar = under && row?.equipment === "barbell" && w >= EMPTY_BAR_KG - 1e-9 ? EMPTY_BAR_KG : 0;
  const floored = Math.floor(loadForReps(w, cap, 0, under ? min : max, near) / inc + 1e-9) * inc;
  const kg = under
    ? Math.max(bar, Math.min(w - inc, Math.max(Math.ceil((w * 0.8) / inc - 1e-9) * inc, floored)))
    : Math.max(w + inc, Math.min(Math.floor((w * 1.2) / inc + 1e-9) * inc, floored));
  const rounded = Math.round(kg * 4) / 4;
  if (under && !(rounded < w)) return null; // at the bar: nothing lighter exists (#40)
  return rounded > 0 ? finalizeHint({ kind: under ? "lighter" : "heavier", kg: rounded, from_kg: w, reps: set.reps, min, max, rir, band: band ? `${band[1]}-${band[2]}` : null, ...(bar ? { floor_kg: bar } : {}) }, set, row, rounded) : null;
}
// The hint at the weight actually OFFERED (round 2 of the fix verification): a pounds user is offered the next
// 5-lb plate, which can be heavier than the kg it rounds from. The reps it aims at — what "Use X kg" fills — are
// predicted there by the same model, and a "heavier" step that would land under the range is dropped (10 kg →
// 12.5 is +25%). Added load on a bodyweight lift is not the whole load, so no Epley on it: it aims at the range
// edge it was moved toward, as before.
export function finalizeHint(hint, set, row, offeredKg) {
  if (!hint) return null;
  if (hint.kind === "same") return hint; // the weight stays; its aim is already the model's (W305)
  if (row?.equipment === "bodyweight") return { ...hint, target_reps: hint.kind === "lighter" ? hint.min : hint.max };
  const band = /(\d+)\s*-\s*(\d+)/.exec(row?.rir ?? "");
  const near = band ? +band[1] : 1;
  const cap = nextSetCapacity(set.reps, typeof set.rir === "number" ? set.rir : null);
  const kg = offeredKg > 0 ? offeredKg : hint.kg;
  const predicted = Math.round(30 * (set.weight_kg * (1 + cap / 30) / kg - 1) - near);
  if (hint.kind === "heavier" && predicted < hint.min) return null;
  return { ...hint, target_reps: Math.max(hint.min, Math.min(hint.max, predicted)) };
}

// The top of a rep range ("6-10" → 10): the reps stepper's start when there is nothing better.
export function topReps(range) { const m = String(range).match(/-(\d+)/); return m ? +m[1] : 10; }
// The row's per-set rep aims (W289) when they're well-formed for THIS row's own range — whole numbers
// from 1 to the top. A swapped-in lift keeps the SLOT's range (PRESCRIPTION_KEYS), so the aims the
// server computed for its own range may not fit it: then there are none.
export function validAim(row) {
  const t = row?.rep_targets, top = topReps(row?.rep_range);
  return Array.isArray(t) && t.length && t.every((r) => Number.isInteger(r) && r >= 1 && r <= top) ? t : null;
}
// The reps the stepper starts on for set k of a lift (W289, Burst 5 — owner: "150kg × 5,4,5 last
// workout and now it is suggesting 150kg × 10,10,10"). Derived from the row and the BANKED count every
// render, never stored, so a resume or a reload lands on the same number: today's aim for this set
// while the weight is still the served one (`atServed`), else the last banked reps (from set 2 on —
// the carry-over the stepper always had), else the top of the range.
export function repSeed(row, k, { lastReps = null, atServed = true } = {}) {
  const aim = atServed ? validAim(row) : null;
  if (aim) return aim[Math.min(k, aim.length - 1)];
  return k > 0 && Number.isInteger(lastReps) && lastReps >= 0 ? lastReps : topReps(row?.rep_range);
}
// The step "the same load" is judged by (fix verification): half the lift's OWN step — 1 kg on a dumbbell
// isolation, 2.5 kg otherwise — in kg; a 5 lb plate in pounds.
export function servedStep(unit, incKg) { return unit === "lb" ? 5 : Math.min(2.5, incKg > 0 ? incKg : 2.5); }
// The same load on the stepper (Burst 5 review): within half a display step, so a kg/lb toggle (330 lb →
// 149.75 kg) or the one-plate nudge still reads as the served weight; one step off is a moved weight.
export function sameLoad(a, b, step) {
  const x = Number(a), y = Number(b);
  return a != null && b != null && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < step / 2;
}
// The reps of the last banked WORK set of a lift (warm-ups and other lifts don't count), or null.
export function lastWorkReps(logged, exercise) {
  for (let i = (logged ?? []).length - 1; i >= 0; i--) {
    const l = logged[i];
    if (l?.exercise === exercise && (l.set_type ?? "work") === "work" && !repsEstimated(l)) return typeof l.reps === "number" ? l.reps : null; // the last REAL count (W307)
  }
  return null;
}

// What the plan asked of each lift TODAY (W280), sent with the finished workout so the
// engine and the read-out can tell a skipped or unfinished set from a full session: the
// ORIGINAL set count (planned_sets survives a skip's shrink of `sets`), the range, the RIR
// band and the suggested load; a planned-easy lift (a deload week or a comeback-eased row)
// is flagged so it is never graded like a normal one. Pure.
export function buildTargets(sess) {
  return (sess?.ex ?? []).filter((x) => x?.exercise).map((x) => ({
    exercise: x.exercise,
    sets: x.planned_sets ?? x.sets,
    rep_range: x.rep_range ?? null,
    rir: x.rir ?? null,
    suggested_kg: x.suggested_kg ?? null,
    ...(sess.deload || x.eased ? { deload: true } : {}),
    // The planned lift a substitute stood in for (its slot_of — Burst 6 review G1): the comeback clock counts the slot as
    // trained, so a once-a-week lift swapped out today isn't "14 days off" next week.
    ...(typeof x.slot_of === "string" && x.slot_of !== x.exercise ? { stood_in_for: x.slot_of } : {}),
    // The per-set aims served today (W298), only when the player itself would use them (validAim) — so later
    // learning can judge a set against what it was asked, not just the range. Only the ones it SERVED: the player shows
    // aim.slice(0, sets), and a tired row's trimmed dose keeps its longer list (W301b review — the server drops a list
    // longer than the planned sets whole).
    ...(validAim(x) ? { rep_targets: validAim(x).slice(0, x.planned_sets ?? x.sets) } : {}),
    // A lift the user moved ("Do this next" / "Do this later", W306): recorded for later learning (a lift put off again
    // and again), nothing reads it yet. The order the lifts were done in is already in the log.
    ...(x.moved ? { moved: true } : {}),
    // The timer this lift's rests ran (W308): stamped at each rest's start (sess.restUsed), only where one ran.
    ...(Number.isInteger(sess.restUsed?.[x.exercise]) ? { rest_s: sess.restUsed[x.exercise] } : {}),
  }));
}

// The hint's weight in the lift's DISPLAY unit, always a real move (Burst 1 review): a 1 kg
// step that the 5-lb plate rounding collapses back onto the weight just used becomes the next
// plate (`step`) in the hint's direction — never "Try 20 lb" from 20 lb. Null when the move
// would reach zero.
// A "same" hint names the weight BANKED, at the precision typed when `unit` is given (Burst 8 review #8: a typed 22.5 lb
// read "25 lb again" — heavier, after a set that fell short). A barbell's lighter move stops at the empty bar in this unit
// (`floor_kg`: 45 lb, never a 40-lb "bar"); none left → null (Burst 8 review #40).
export function hintInUnit(hint, toDisp, step, unit = null) {
  if (!hint) return null;
  if (hint.kind === "same") { const at = unit ? +editDisplay(hint.kg, unit) : toDisp(hint.kg); return at > 0 ? at : null; } // W305: the weight stays where it is
  const from = toDisp(hint.from_kg), to = toDisp(hint.kg);
  let out = to !== from ? to : from + (hint.kind === "lighter" ? -step : step);
  if (hint.kind === "lighter" && hint.floor_kg > 0) { out = Math.max(out, toDisp(hint.floor_kg)); if (!(out < from)) return null; }
  return out > 0 ? out : null;
}

// WHAT HAPPENED in a workout (W282 read-out) — from the workout itself: the plan it carried
// (`targets`, W280) and the sets banked. So it works OFFLINE (the recap of a queued workout)
// and for any workout in History; the server adds what it MEANS. Per lift: sets done vs
// planned, reps vs the range, effort vs the band (only when logged on at least half the
// sets; "far easier" is the next-set hint's own test, band top + 2). A planned-easy lift
// (deload week, comeback ease) is never graded. A workout from before targets existed still
// reads — no plan, no grades. Pure.
// The time between a lift's work sets (W308 — the read-out half of owner note 1, "rest tracking"): the median gap
// between its consecutive stamped work sets, from the completed_at every set already carries (a superset round's legs
// share one stamp, so each leg's gap is round to round). A gap past 15 minutes is a pause, not a rest; warm-ups and
// unstamped sets are out. It runs set END to set END — the rest plus the next set — so it's said as "between sets",
// never as rest. Pure.
export const GAP_MAX_S = 15 * 60, ROUND_SKEW_MS = 2000;
export function liftGaps(logged) {
  const work = (logged ?? []).filter((s) => s?.exercise && (s.set_type ?? "work") === "work");
  const stamp = (s) => Date.parse(s?.completed_at ?? "");
  const last = {}, by = {};
  work.forEach((s, k) => {
    const t = stamp(s);
    if (!Number.isFinite(t)) return;
    const p = last[s.exercise];
    // Between ITS sets only (Burst 9 review engine#3): a gap with another lift's set inside it — a lift moved in between
    // (W306) — isn't time between sets; a superset partner banked in the same round shares a stamp, and isn't "inside".
    if (p) {
      // (…within ROUND_SKEW_MS: a round's two members can be stamped a millisecond apart — W311, the fix check player#2.)
      const inside = work.slice(p.k + 1, k).some((o) => o.exercise !== s.exercise && Math.abs(stamp(o) - p.t) > ROUND_SKEW_MS && Math.abs(stamp(o) - t) > ROUND_SKEW_MS);
      const g = (t - p.t) / 1000;
      if (!inside && g > 0 && g <= GAP_MAX_S) (by[s.exercise] ??= []).push(g);
    }
    last[s.exercise] = { t, k };
  });
  const out = {};
  for (const [id, gaps] of Object.entries(by)) {
    gaps.sort((a, b) => a - b);
    const h = gaps.length >> 1, m = gaps.length % 2 ? gaps[h] : (gaps[h - 1] + gaps[h]) / 2;
    out[id] = { median_s: Math.round(m), n: gaps.length };
  }
  return out;
}
export function localReadout(targets, logged) {
  const work = (logged ?? []).filter((s) => s && (s.set_type ?? "work") === "work");
  const gaps = liftGaps(logged);
  const tgs = (targets ?? []).filter((t) => t?.exercise);
  const ids = [...new Set([...tgs.map((t) => t.exercise), ...work.map((s) => s.exercise)])];
  const lifts = ids.map((id) => {
    const t = tgs.find((x) => x.exercise === id) ?? null;
    const sets = work.filter((s) => s.exercise === id);
    const range = /(\d+)\s*-\s*(\d+)/.exec(t?.rep_range ?? "");
    const min = range ? +range[1] : null, max = range ? +range[2] : null;
    const band = /(\d+)\s*-\s*(\d+)/.exec(t?.rir ?? "");
    const easyDay = !!t?.deload || sets.some((s) => s.deload);
    // Effort and the top are graded over the ANCHOR sets — the ones the engine judges (Burst 6 review): a lighter
    // back-off set is a different load, never evidence, so it can't flip a line against the next weight.
    // …and an ESTIMATED rep count (W307) is a set done, never evidence — as the engine judges it (Burst 9 review D1/D2):
    // its weight is real, so it anchors; any estimate at that weight means no "top"; effort and misses read real sets.
    const real = sets.filter((s) => !repsEstimated(s));
    const judged = sets.length && min != null ? anchorSets(sets, min).judged : sets;
    const realJ = judged.filter((s) => !repsEstimated(s)), estAt = judged.length - realJ.length;
    const rirs = realJ.map((s) => s.rir).filter((r) => typeof r === "number");
    const rated = !easyDay && !!band && realJ.length > 0 && rirs.length >= Math.ceil(realJ.length / 2);
    const avg = rirs.length ? rirs.reduce((a, b) => a + b, 0) / rirs.length : null;
    // The top of the range AT THE PLAN'S EFFORT (Burst 6), as the engine judges it — against the band this workout
    // was served. Reached only by going past the band, it is its own flag: worth a look, never "time to go up".
    const near = band ? +band[1] : 0;
    const graded = !easyDay && max != null && realJ.length > 0;
    const top = graded && !estAt && judged.every((s) => repsAtBand(s.reps, s.rir, near) >= max);
    return {
      exercise: id, planned: Number.isInteger(t?.sets) ? t.sets : null, done: sets.length, min, max,
      reps: sets.map((s) => s.reps), kg: sets.map((s) => s.weight_kg ?? 0),
      reps_shown: sets.map(repsShown), // an estimated count with its ~ (W307)
      // The time between its sets, and the timer it ran (W308) — null where there's nothing to say.
      gap_s: gaps[id]?.median_s ?? null, rest_s: Number.isInteger(t?.rest_s) ? t.rest_s : null,
      top, past_band: graded && !top && !estAt && judged.every((s) => s.reps >= max),
      // Whether every set was graded — "top of the range on every set" says so only then (round 2: a ramp set under the
      // range sat beside it otherwise).
      graded_all: judged.length === sets.length,
      anchor_kg: judged.length ? judged[0].weight_kg ?? 0 : null, // the weight the grade is for (Nerd Mode names it — round 3)
      under: easyDay || min == null ? 0 : real.filter((s) => s.reps < min).length,
      est: sets.length - real.length, // how many of its counts were estimates ("Forgot the numbers?")
      easy: rated && avg >= +band[2] + 2,
      failure: rated && +band[1] >= 1 && avg < 0.5,
      // The logged effort averaged inside the band ("Effort right" says so only then); null when too little was logged.
      in_band: rated ? avg >= +band[1] && avg <= +band[2] : null,
      easyDay, rir: avg == null ? null : Math.round(avg * 10) / 10, band: t?.rir ?? null,
      // Nerd Mode prints every set's reps beside an average: over every set it prints (round 2), not just the graded ones.
      rir_all: (() => { const all = sets.map((s) => s.rir).filter((r) => typeof r === "number"); return all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null; })(),
    };
  }).filter((l) => l.done > 0 || (l.planned ?? 0) > 0);
  return { lifts, planned: lifts.reduce((a, l) => a + (l.planned ?? l.done), 0), done: lifts.reduce((a, l) => a + l.done, 0), hasPlan: tgs.length > 0 };
}

// The PRE-FILLED weight for a lift, in its display unit (Burst 1 review). Plate rounding
// (5 lb) swallowed any engine move under ~2.5 lb, so a 1 kg step — isolation dumbbells and
// cables — pre-filled the very weight just lifted: those lifts could never progress for a
// pounds user, and an ease never eased. A weight the engine MOVES (a bump, an ease, a
// comeback, a deload) now moves at least one plate in that direction; a hold holds. In
// kilograms (0.25 kg display) no engine step is ever swallowed, so this is the plain
// rounding there. Null when there is no suggestion (the caller's first-time default).
export function prefillInUnit(row, toDisp, step) {
  const kg = row?.suggested_kg, last = row?.last_kg;
  if (kg == null) return null;
  if (!(last > 0) || kg === last) return toDisp(kg);
  return hintInUnit({ kind: kg > last ? "heavier" : "lighter", kg, from_kg: last }, toDisp, step) ?? toDisp(kg);
}
// A held weight's lighter alternative (W305's alt_kg) as the player OFFERS it, in the lift's display unit — `served` is the
// stepper's pre-fill. Burst 8 review: a REAL step under the served weight (#7: a pounds user's 1 kg ease rounds back onto
// the same plate — then the next plate down), never under the empty bar (#37/#40), never more than ~20% down; never on a
// tired or eased row (#25). Its reps are the model's at the offered weight (#34: the server's alt_reps at alt_kg, carried
// there by Epley — never the range's bottom, which left ~5 in reserve). Null: no offer — the note then names none either.
export const ALT_MAX_DROP = 0.2;
export function altOffer(row, { toDisp, toKg, step, served, unit }) {
  if (!(row?.alt_kg > 0) || row.tired || row.eased || !(served > 0)) return null;
  let w = toDisp(row.alt_kg);
  if (!(w < served)) w = served - step;
  const barDisp = unit === "lb" ? EMPTY_BAR_LB : EMPTY_BAR_KG;
  if (row.equipment === "barbell" && served >= barDisp - 1e-9) w = Math.max(w, barDisp); // a lift ON the full bar only (fix C4)
  if (!(w > 0 && w < served) || w < served * (1 - ALT_MAX_DROP) - 1e-9) return null;
  const range = /(\d+)\s*-\s*(\d+)/.exec(row.rep_range ?? "");
  const min = range ? +range[1] : null, max = range ? +range[2] : null;
  if (!Number.isInteger(row.alt_reps) || row.equipment === "bodyweight") return { w, reps: Number.isInteger(row.alt_reps) ? row.alt_reps : min };
  const band = /(\d+)\s*-\s*(\d+)/.exec(row.rir ?? "");
  const near = band ? +band[1] : 1;
  // From set 1's own e1RM when the row carries it (fix C6: alt_reps is clamped to the range, so re-deriving from it
  // under-fills a plate that rounds UP from alt_kg); an older row falls back to alt_reps at alt_kg.
  const e1 = row.alt_e1rm > 0 ? row.alt_e1rm : row.alt_kg * (1 + (row.alt_reps + near) / 30);
  const reps = Math.round(30 * (e1 / toKg(w) - 1) - near);
  return { w, reps: min == null ? reps : Math.max(min, Math.min(max, reps)) };
}

export function isHardSet(set, { hardSetRpe = 7 } = {}) {
  const type = set.set_type ?? "work";
  if (type === "warmup") return false;
  if (typeof set.rpe === "number" && set.rpe < hardSetRpe) return false;
  if (typeof set.rir === "number" && set.rir > 4) return false;
  return true;
}
// Was the set JUST pushed onto `logged` a lucky set? `logged` already includes it,
// so its 0-indexed position among that exercise's hard sets this session is
// (count of hard sets for this exercise so far) - 1 — the same ordering
// luckySetsInSession replays server-side from the stored session.sets array.
export function checkLuckySet(sessionId, logged, justLogged) {
  if (!isHardSet(justLogged)) return false;
  const idx = logged.filter((l) => l.exercise === justLogged.exercise && isHardSet(l)).length - 1;
  return isLuckySet(sessionId, justLogged.exercise, idx);
}

// Given a superset pair (indices L<P) and the log, the current 0-indexed round and
// how many rounds are paired (the shorter member's set count). round >= paired
// means the paired work is done and any remainder is finished the normal way.
export function stationProgress(logged, ex, L, P) {
  const paired = Math.min(ex[L].sets, ex[P].sets);
  const round = Math.min(loggedWorkSets(logged, ex[L].exercise), loggedWorkSets(logged, ex[P].exercise));
  return { paired, round, done: round >= paired };
}

// You-vs-partners mini-leaderboard (#10 accountability). Pure so the ranking is
// unit-tested rather than living untested in app.js. Combines the user (`you`) with
// their ACTIVE followed partners, ranks by streak then level (a friendly nudge), and
// tags the user's own row. Inactive partners (revoked shares) are excluded from the
// ranking — the UI lists them separately for pruning.
export function rankPartners(you, partners) {
  const entries = [{ ...you, isYou: true }, ...(partners || []).filter((p) => p && p.active)];
  entries.sort((a, b) => (b.streak_weeks - a.streak_weeks) || (b.level - a.level));
  return entries.map((e, i) => ({ ...e, rank: i + 1 }));
}

// Weekly race vs one partner (#10 accountability, next slice after the all-time
// leaderboard): "ahead"/"behind"/"tied" on THIS week's session count only, so it
// resets every week instead of accumulating forever — a short-horizon nudge with
// real urgency ("still behind, get one in before Sunday") that the all-time
// streak/level comparison can't provide on its own. Pure so it's unit-tested
// the same way as rankPartners; missing counts default to 0 rather than throwing.
export function weeklyRaceStatus(youThisWeek, partnerThisWeek) {
  const you = youThisWeek ?? 0, partner = partnerThisWeek ?? 0;
  if (you > partner) return "ahead";
  if (you < partner) return "behind";
  return "tied";
}

// ---------- Units (kg ↔ lb display layer) ----------
// Everything is STORED and computed in kg; pounds exist only at the display/entry
// edge. These pure pieces live here (not app.js) so the conversion + the per-key
// session migration below are unit-tested in Node — getting either wrong silently
// changes what a resumed weight MEANS, which then anchors the next session's
// suggestion at 2.2x. app.js binds them to localStorage prefs and the live sess.
export const LB_PER_KG = 2.2046226;

// Snap a display-unit value to what the gym can actually load: 5 lb stack pins,
// 0.25 kg microplates — the same quanta app.js's dispWeight has always used.
export const roundToPlate = (v, unit) => unit === "lb" ? Math.round(v / 5) * 5 : Math.round(v * 4) / 4;

// Convert a DISPLAY-unit value between kg and lb, plate-rounded in the target
// unit. Same-unit conversion is the identity (no re-rounding a value the user
// typed — 62.7 kg stays 62.7 kg until they change units). A nonzero value NEVER
// converts to zero: plate rounding would turn 1 kg into 0 lb, and 0 has meaning
// here (a bodyweight lift renders its no-added-weight shape and the entry is
// gone) — so when the plate snap collapses a real value, fall back to a finer
// 0.5 lb / 0.25 kg quantum, clamped to at least one quantum.
export function convertDispWeight(value, from, to) {
  if (from === to || !(typeof value === "number" && Number.isFinite(value))) return value;
  const raw = (from === "lb" ? value / LB_PER_KG : value) * (to === "lb" ? LB_PER_KG : 1);
  let out = roundToPlate(raw, to);
  if (out === 0 && value > 0) {
    const quantum = to === "lb" ? 0.5 : 0.25;
    out = Math.max(quantum, Math.round(raw / quantum) * quantum);
  }
  return out;
}

// Typed-entry gate for the player's weight/reps inputs. A number input's .value
// is "" while empty OR mid-edit junk (browsers blank invalid states), so parse
// failures return `fallback` (the last good value stays in sess) rather than 0 —
// zeroing a weight because someone selected-all mid-correction would then bank a
// 0 kg set on the next Done tap. Negative paste/spinner values floor at 0.
export function sanitizeTypedValue(raw, { integer = false, fallback = null } = {}) {
  const n = integer ? parseInt(raw, 10) : parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, integer ? Math.round(n) : n);
}

// Per-key unit migration for the crash-mirrored session. sess.weights holds
// DISPLAY-unit values; `stamps` records which unit each entry is in (per index —
// a per-exercise lb override means one session legitimately mixes units).
// `unitOf(key)` is what the entry SHOULD be in now; any entry whose stamp (or,
// for pre-stamp blobs, `fallbackUnit` — the old scalar sess.units) disagrees is
// converted once and restamped. One function serves both a global kg/lb flip and
// a single exercise's toggle mid-workout, so there is exactly one place a stored
// "60" can change meaning. Returns fresh objects + whether anything moved.
// `servedIn(k, unit)` (round 2 of the fix verification): the served pre-fill of slot k in a unit. An entry still
// sitting exactly on it is re-stamped to the new unit's pre-fill, so a toggle never reads as a moved weight
// (25 lb → 10.5 kg on a 1 kg lift, not the converted 11.25).
export function normalizeWeightsToUnits({ weights = {}, stamps = {}, fallbackUnit, unitOf, servedIn = null }) {
  const w = { ...weights }, st = { ...stamps };
  let changed = false;
  for (const k of Object.keys(w)) {
    const to = unitOf(k);
    const from = st[k] ?? fallbackUnit ?? to;
    if (from !== to) {
      const servedFrom = servedIn?.(k, from), servedTo = servedIn?.(k, to);
      // …never to zero (1 kg rounds to 0 lb on the plate grid; 0 means "bodyweight only") — round 3.
      w[k] = servedFrom != null && servedTo > 0 && Number(w[k]) === servedFrom ? servedTo : convertDispWeight(w[k], from, to);
    }
    if (st[k] !== to) { st[k] = to; changed = true; }
  }
  return { weights: w, stamps: st, changed };
}

// Turns an ISO week key ("2026-W30", the internal identity `isoWeekKey` stamps
// on every challenge/session) into a label a user can read ("Week 30, 2026").
// Pure + unit-tested so the challenge-history list (#10 social follow-on: the
// roadmap's "full history LIST view" — the backend already returns every past
// challenge in `history`, this is what was missing to actually show them) never
// leaks the raw internal key, and a malformed/filler key (e.g. the test suite's
// "filler-18" cap fixtures) degrades to the raw string instead of throwing.
export function formatWeekLabel(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey || "");
  return m ? `Week ${Number(m[2])}, ${m[1]}` : String(weekKey ?? "");
}

// REST (W273 — owner: "rest is 120s, but what if someone wants 60s or 300s?"). Each
// lift arrives with its own KB rest length (rest_s); the user can nudge it ±30 s in
// the player, and the nudge is remembered per lift as an OFFSET from that length. The
// rest itself is an absolute END TIME in the crash-safe session (sess.rest), so a
// reload, a locked phone or an app switch resumes it instead of losing it; both
// renderers derive what to show from these helpers.
export const REST_DEFAULT_S = 120, REST_MIN_S = 30, REST_MAX_S = 600, REST_STEP_S = 30;
const clampRest = (s) => Math.min(REST_MAX_S, Math.max(REST_MIN_S, Math.round(s)));
// A row from before W273 (no rest_s — a workout resumed across the deploy) rests the
// old 120 s, and a junk offset is ignored: the timer can never read NaN.
export function restLength(row, offset = 0) {
  const base = Number.isFinite(row?.rest_s) ? row.rest_s : REST_DEFAULT_S;
  return clampRest(base + (Number.isFinite(offset) ? offset : 0));
}
export function newRest({ kind, length, ex = null, logged }, now) {
  return { kind, ex, length, logged, start: now, until: now + length * 1000 };
}
export const restRemaining = (until, now) => (Number.isFinite(until) ? Math.max(0, Math.ceil((until - now) / 1000)) : 0);
// A stored rest counts only while plausible (a finite end, not past, not further ahead
// than the longest rest — a clock jump or a corrupt blob is dropped, never trusted)
// and while it still follows the set it was started after (a set banked since means
// it belongs to an older set).
export function activeRest(sess, now) {
  const r = sess?.rest;
  if (!r || !Number.isFinite(r.until) || !Number.isFinite(r.start)) return null;
  if (r.until <= now || r.until - now > REST_MAX_S * 1000 + 1000) return null;
  if (r.logged !== (sess.logged?.length ?? -1)) return null;
  return r;
}
export const formatRest = (sec) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
// ±30 s moves the END from when the rest began, clamped to 30 s–10 min. Only a rest
// between sets of ONE lift teaches that lift a new length (as an offset from its own
// rest): a superset round's or a remainder's fixed 60 s says nothing about it — +30 on
// a 60 s remainder would otherwise teach a 3-minute lift to rest less.
// A row from before W273 (no rest_s) teaches nothing either: its offset would be measured
// from the 120 s fallback and then land on the lift's real rest (3:00 + 60 = 4:00) later.
export function adjustRest(rest, delta, row) {
  const length = clampRest(rest.length + delta);
  const teaches = rest.kind === "set" && Number.isFinite(row?.rest_s);
  return { rest: { ...rest, length, until: rest.start + length * 1000 }, remember: teaches ? length - restLength(row, 0) : null };
}

// FIXING A BANKED SET (W274 — owner: "I can't fix a wrong weight/reps mid-workout"). A
// set is corrected IN PLACE — numbers only, never the count, order, lift or set type —
// so everything the player derives from the log (progress, the cursor, station rounds)
// provably cannot move. Live delete/undo is refused on purpose: removing a set breaks
// the forward-only cursor and unbalances a superset's rounds.
//
// The chips for one lift carry each banked set's ABSOLUTE position in sess.logged: a
// superset round interleaves two lifts (and warm-ups interleave too), so a position
// counted within one lift's sets would edit the OTHER lift's set.
export function sessionChips(logged, exId) {
  return (logged ?? []).flatMap((l, idx) => (l.exercise === exId
    ? [{ idx, weight_kg: l.weight_kg, reps: l.reps, set_type: l.set_type ?? "work", completed_at: l.completed_at ?? null,
      est: repsEstimated(l), rir: typeof l.rir === "number" ? l.rir : null, rir_est: typeof l.rir_est === "number" ? l.rir_est : null }] : []));
}
// Only the fields present in `patch` (weight_kg, reps) change, and only to sane values —
// a cleared input or junk is ignored, never written. Refuses (the SAME array back)
// unless the entry at idx is still the one the editor opened: same lift AND same
// completed_at. Pure.
// W307: RIR is editable on a banked set (0-10, the server's clamp), and "Forgot the numbers?" writes an `estimate`
// ({reps, rir}) — reps marked est: ["reps"], an RIR only as rir_est and only where none was logged (an estimate never
// replaces a real one). A REAL new number clears only its own flag: a reps entry that differs drops `est`, an RIR entry
// drops `rir_est` (an untouched field comes back as the same value — resolveEdit — and clears nothing).
// …and edits are made FROM the entry the editor OPENED with (`base` — Burst 9 review crash#0): every keystroke re-applies
// to it, so a value typed and typed back is the original, flags and all — never the intermediate an earlier keystroke left.
export function editLoggedSet(logged, idx, patch, { exercise, completed_at, base = null } = {}) {
  const cur = logged?.[idx];
  if (!cur || cur.exercise !== exercise || (cur.completed_at ?? null) !== (completed_at ?? null)) return logged;
  const from = base ?? cur;
  const changes = {}, drop = [];
  const w = patch?.weight_kg, r = patch?.reps, q = patch?.rir, est = patch?.estimate;
  if (typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1000) changes.weight_kg = w;
  if (Number.isInteger(r) && r >= 0 && r <= 100) { changes.reps = r; if (r !== from.reps) drop.push("est"); }
  if (Number.isInteger(q) && q >= 0 && q <= 10) { changes.rir = q; drop.push("rir_est"); }
  if (est && Number.isInteger(est.reps) && est.reps >= 1 && est.reps <= 100) {
    changes.reps = est.reps; changes.est = ["reps"];
    if (typeof from.rir !== "number" && Number.isInteger(est.rir) && est.rir >= 0 && est.rir <= 10) changes.rir_est = est.rir;
  }
  if (!Object.keys(changes).length) return logged;
  return logged.map((l, k) => {
    if (k !== idx) return l;
    const next = { ...l };
    if (base) for (const f of ["weight_kg", "reps", "rir", "rir_est", "est"]) { if (f in base) next[f] = base[f]; else delete next[f]; }
    Object.assign(next, changes);
    for (const f of drop) if (!(f in changes)) delete next[f];
    return next;
  });
}
// The moved lift's cue (W306): today's weight was set for its usual place — and the next-set hint corrects after set 1,
// said only where that hint can fire (Burst 9 review copy#3): never a load-less bodyweight lift, a tired-eased one or a deload.
export function movedCue(row, { deload = false } = {}) {
  const hint = !deload && !row?.eased && !(row?.equipment === "bodyweight" && !(row?.suggested_kg > 0));
  return `📍 You moved this one — today's weight was set for its usual place in the workout${hint ? "; after set 1 the hint adjusts if it needs to" : ""}.`;
}
// A set as the History editor sends it back (W274 + W307): an untouched field keeps its stored value byte for byte (the
// display is exact, but a re-parse could still round); a CHANGED, valid reps count is a real number and drops `est`; junk
// keeps what was stored, flag and all. The display-only `name` never goes back.
export function historyEditSet(set, { wText, rText, unit }) {
  const { name, ...rest } = set;
  const w = String(wText ?? "").trim(), r = String(rText ?? "").trim();
  const kg = w === editDisplay(rest.weight_kg, unit) ? rest.weight_kg : parseEdit(w, unit);
  const reps = r === String(rest.reps) ? rest.reps : (/^\d{1,3}$/.test(r) ? Number(r) : rest.reps);
  const out = { ...rest, weight_kg: kg ?? rest.weight_kg, reps };
  if (reps !== rest.reps) delete out.est;
  return out;
}
// "FORGOT THE NUMBERS?" (W307 — owner: "if a user forgets what reps and rir they did… autofill it based off what they got
// for the other sets that workout… guesses should get more accurate based off… general trends"). In order of what it
// trusts: the lift's REAL sets this session at this weight — the nearest earlier one carried forward by the drop
// between sets (each set in between costs it again), else the nearest later one, which the earlier did at least
// (plus the drop); the drop is the lifter's OWN when two real sets in a row at this weight show it, else the model's
// (nextSetCapacity). Then last session's same set at this weight (row.last_sets); then the e1RM the real sets give
// (today's, else last time's), at the band's near edge. RIR: the nearest real neighbour's, else the band's near edge —
// none for a beginner (never asked). An estimate never feeds another. Null when nothing real exists to go on.
// What banks as an estimate, PER FIELD (W307): the reps while they still show the estimate the lifter accepted for THIS
// set (`pending` = {setNo, reps, rirChip, rir}, stamped when "Forgot the numbers?" filled them); the RIR while its chip is
// still the estimate's — then stored as rir_est (the estimate's own number: a "4+" chip keeps a 6), never as a real rir.
// A field the lifter changed is real; a pending estimate for another set is stale and estimates nothing.
export function estimatedFields(pending, { setNo, reps, eff }) {
  const live = !!pending && pending.setNo === setNo;
  const estReps = live && pending.reps === reps;
  const rirEst = live && pending.rirChip != null && eff === pending.rirChip;
  return { estReps, rir: rirEst || eff == null ? null : eff, rir_est: rirEst ? pending.rir : null };
}
// A rep count as shown: "~9" when it's an estimate (a log entry's est, or a chip's est flag).
export const repsShown = (entry) => `${entry?.est === true || repsEstimated(entry) ? "~" : ""}${entry?.reps}`;
export function estimateSet({ logged, at, weightKg, row, beginner = false, setNo = null }) {
  const ex = row?.exercise, range = /(\d+)\s*-\s*(\d+)/.exec(row?.rep_range ?? ""), band = /(\d+)\s*-\s*(\d+)/.exec(row?.rir ?? "");
  if (!ex || !range || !(weightKg >= 0)) return null; // a bodyweight lift (0 kg) estimates from its reps too
  const max = +range[2], near = band ? +band[1] : 1;
  const mine = (logged ?? []).map((l, k) => ({ l, k })).filter(({ l }) => l?.exercise === ex && (l.set_type ?? "work") === "work");
  const pos = mine.filter(({ k }) => k < at).length; // the target's place among the lift's sets
  // The set being estimated is never its own evidence (in the editor its banked numbers ARE the forgotten ones).
  const real = mine.filter(({ l, k }) => k !== at && !repsEstimated(l) && typeof l.reps === "number" && l.weight_kg === weightKg);
  // Unlogged effort reads as the band's near edge — the engine's own convention — in the capacity AND the guess (Burst 9
  // review engine#2: it was 0 in one and `near` in the other, a double count that guessed every beginner ~`near` low).
  const rirOf = (l) => (typeof l?.rir === "number" ? l.rir : near);
  const cap = (l) => l.reps + rirOf(l);
  const lossAt = (r) => (100 - (r <= 1 ? SET_FATIGUE_PCT.near : r <= 3 ? SET_FATIGUE_PCT.mid : 0)) / 100; // nextSetCapacity's drop
  // The lifter's own set-to-set drop: the latest pair of CONSECUTIVE real sets at this weight (never one with the target).
  let ratio = null;
  for (let j = mine.length - 1; j > 0 && ratio == null; j--) {
    const a = mine[j - 1], b = mine[j];
    if (a.k !== at && b.k !== at && ![a.l, b.l].some(repsEstimated) && a.l.weight_kg === weightKg && b.l.weight_kg === weightKg && cap(a.l) > 0) ratio = Math.max(0.5, Math.min(1, cap(b.l) / cap(a.l)));
  }
  const done = (reps, rir, source) => ({ reps: Math.max(1, Math.min(max + 5, Math.round(reps))), rir: beginner ? null : rir, source });
  const before = real.filter(({ k }) => k < at).at(-1), after = real.find(({ k }) => k > at);
  if (before && after) {
    // Both real neighbours (W311 — the fix check engine#2): the set between them is interpolated between them, capacity
    // and effort alike — never above both (the earlier set's effort once read the later set's capacity as reps).
    const pos = (k) => mine.findIndex((x) => x.k === k), pb = pos(before.k), pa = pos(after.k), pt = mine.filter(({ k }) => k < at).length;
    const f = pa > pb ? (pt - pb) / (pa - pb) : 0.5;
    const r = Math.round(rirOf(before.l) + (rirOf(after.l) - rirOf(before.l)) * f);
    return done(cap(before.l) + (cap(after.l) - cap(before.l)) * f - r, r, "session");
  }
  if (before) {
    const r = rirOf(before.l), steps = mine.filter(({ k }) => k > before.k && k < at).length;
    let c = cap(before.l) * (ratio ?? lossAt(r));
    for (let n = 0; n < steps; n++) c *= ratio ?? lossAt(r);
    return done(c - r, r, "session");
  }
  if (after) {
    const r = rirOf(after.l);
    return done(cap(after.l) / (ratio ?? lossAt(r)) - r, r, "session");
  }
  const n = Number.isInteger(setNo) ? setNo : pos;
  const last = Array.isArray(row?.last_sets) ? row.last_sets : [];
  if (last[n] && !last[n][2] && last[n][0] === weightKg && Number.isFinite(last[n][1])) return done(last[n][1], near, "last"); // [kg, reps, true]: an estimate
  if (!(weightKg > 0)) return null; // no e1RM for bodyweight reps
  const e1 = Math.max(0, ...mine.filter(({ l, k }) => k !== at && !repsEstimated(l) && l.weight_kg > 0 && typeof l.reps === "number").map(({ l }) => l.weight_kg * (1 + cap(l) / 30)),
    ...last.filter((x) => !x[2] && x[0] > 0 && Number.isFinite(x[1])).map((x) => x[0] * (1 + (x[1] + near) / 30))); // last time's effort: unlogged, so the near edge
  if (!(e1 > 0)) return null;
  return done(30 * (e1 / weightKg - 1) - near, near, "e1rm");
}
// The editor shows a banked weight EXACTLY (kg to 0.01, lb to 0.1) and reads it back in
// the SAME unit it was shown in. The plate-rounded display (lb to 5) re-saved 22.5 lb as
// 25 lb on a reps-only fix — an 11% heavier anchor for every later suggestion.
export function editDisplay(kg, unit) {
  if (typeof kg !== "number" || !Number.isFinite(kg)) return "";
  return String(unit === "lb" ? Math.round(kg * LB_PER_KG * 10) / 10 : Math.round(kg * 100) / 100);
}
export function parseEdit(text, unit) {
  const v = Number.parseFloat(String(text ?? "").trim().replace(",", "."));
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round((unit === "lb" ? v / LB_PER_KG : v) * 100) / 100;
}
// An edit's typo confirmation lives in its OWN key space (the Done button's guard keys
// on exercise ids), so confirming a corrected number can never wave the NEXT set's
// typo check through — and it names ONE set: a station round banks both members in the
// same millisecond, and old entries have no completed_at, so the lift and (failing a
// timestamp) the absolute log position are part of the key.
export const editConfirmKey = (entry, idx) => `edit:${entry?.exercise ?? ""}:${entry?.completed_at ?? `#${idx}`}`;
// What the editor writes for the text in its fields. A field whose text still reads as
// shown keeps the stored value EXACTLY; a changed one is parsed in the unit it was
// shown in. A work set the typo guard flags (the banking guard, on the corrected
// numbers) writes the ORIGINAL values until confirmed — a clear-and-retype passes
// through plausible intermediates ("1", "10"…), and the log must never keep one of
// those when the final number is the suspect one.
// Only what CHANGED is judged (Burst 6): an untouched number already passed the guard (or was
// confirmed) when it banked — re-judging it refused a reps-only fix on a confirmed big jump —
// and against today's other banked sets (`todayKg`/`todayReps`, the edited entry left out).
// W307: the RIR is editable too (`qText`/`shownQ`) — a changed, valid 0-10 entry is a real RIR (editLoggedSet then drops an
// estimated one); untouched or junk text changes nothing. It never takes part in the typo guard.
export function resolveEdit({ entry0, wText, rText, qText = null, shownW, shownR, shownQ = null, unit, lastKg = null, priorBests = null, todayKg = null, todayReps = null, confirmed = false }) {
  const w = String(wText ?? "").trim(), r = String(rText ?? "").trim(), q = String(qText ?? "").trim();
  const kg = w === shownW ? entry0.weight_kg : parseEdit(w, unit);
  const reps = r === shownR ? entry0.reps : (/^\d{1,3}$/.test(r) ? Number(r) : null);
  const patch = {};
  if (kg != null) patch.weight_kg = kg;
  if (reps != null) patch.reps = reps;
  if (qText != null && q !== String(shownQ ?? "").trim() && /^\d{1,2}$/.test(q) && Number(q) <= 10) patch.rir = Number(q);
  const cand = { ...entry0, ...patch };
  const flagged = (cand.set_type ?? "work") === "work" && !confirmed
    // …and the set's OWN banked value vouches for it (it passed the guard, or was confirmed, when it banked — review K8:
    // nudging a confirmed 150 to 152.5 was asked again).
    && isImplausibleSet(cand.weight_kg !== entry0.weight_kg ? cand.weight_kg : null, cand.reps !== entry0.reps ? cand.reps : null,
      { lastKg, priorBests, todayKg: Math.max(todayKg ?? 0, entry0.weight_kg ?? 0) || null, todayReps: Math.max(todayReps ?? 0, entry0.reps ?? 0) || null });
  return flagged ? { patch: { weight_kg: entry0.weight_kg, reps: entry0.reps }, flagged: true } : { patch, flagged: false };
}
// After an edit the lift's "PR already celebrated" latch must match what the log now
// says: true if ANY banked work set beats its prior bests (deload sets never count — the
// server's rule), false once a typo PR is corrected away. Recomputed silently: an edit
// never re-toasts.
// The latch means "a PR was CELEBRATED this session" — what checkAndCelebratePR relies
// on to toast once. An edit may only CLEAR it (a typo PR corrected away); it never sets
// it, or the session's real later PR would never toast (edits don't toast).
export const nextPrLatch = (was, logged, exId, prWatch) => !!was && recomputePrLatch(logged, exId, prWatch);
export function recomputePrLatch(logged, exId, prWatch) {
  if (!prWatch) return false;
  return (logged ?? []).some((l) => l.exercise === exId && (l.set_type ?? "work") === "work"
    && !!checkSetPR(exId, l.weight_kg, l.reps, "work", prWatch, l.deload === true, repsEstimated(l)));
}

// The player's live Undo for a "Can't do this one?" swap belongs to ONE session: stamped
// with its session_id, shown only on the swapped-in lift at set 0 before any work of it
// is banked. (Module-level state outlived the workout: Monday's card offered to "undo"
// Thursday's planned lift with Monday's row.)
export function undoApplies(undo, sess, e) {
  return !!undo && !!undo.session_id && undo.session_id === sess?.session_id && e?.exercise === undo.to
    && sess.set === 0 && loggedWorkSets(sess.logged ?? [], undo.to) === 0;
}

// Rest's up (W286): what the player does about the server's rest alarm as things change — a
// pure decision, so a reload, a crash or a locked phone can't strand it. Armed while a rest
// runs (the phone may lock any moment); handed to the app's own chime in the last seconds while
// the rest screen is on screen — only when that chime can be TRUSTED to sound (W286 review: on
// an iPhone the silent switch mutes it unseen, so there the alarm always stays); armed again if
// the screen goes away after a hand-over; disarmed when the rest ends early or alerts are off.
// An end that has passed needs nothing: the alarm has fired, or the chime has.
export const REST_ALERT_HANDOFF_MS = 3000;
export function restAlertStep({ rest, armedUntil, now, onScreen, chimeReliable = false, enabled }) {
  const live = Number.isFinite(armedUntil) && armedUntil > now;
  const until = Number.isFinite(rest?.until) ? rest.until : null;
  if (!enabled || until == null) return live ? "disarm" : null;
  if (until <= now) return null;
  if (onScreen && chimeReliable && until - now <= REST_ALERT_HANDOFF_MS) return live ? "disarm" : null;
  return armedUntil === until ? null : "arm";
}
