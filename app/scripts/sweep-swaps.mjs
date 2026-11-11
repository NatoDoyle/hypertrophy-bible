// THE SWAP SWEEP (Burst 11 review, rounds 8-9): a route-level harness that drives the player's swap doors — busy, Pick one
// myself, Your pick, tired swap, ease-in-place, No machine, Just not for me, It hurts, Undo — through createApp + a file
// store exactly as app/public/app.js does, every chain up to DEPTH doors on one slot, finishes the workout through POST
// /api/session, and checks four invariants against a ground-truth model:
//   I1 a dislike vote is cast only by a non-tired, non-hurt pick against the plan's lift for that slot, and never lost;
//   I2 a liking is credited only to a lift picked on a non-tired slot;
//   I3 a stand-in names the plan's lift for that slot (the comeback clock), unless an injury rebuild removed it;
//   I4 Undo restores the slot exactly.
// Not in `npm test` (thousands of chains): run it whenever the swap doors, swapWhyFor, replaceSlot, the cant-do route or
// swapPreferences change —  `npm run sweep:swaps`  (SLOT=0..4, DEPTH=3|4, DOORS=…, ONLY=a>b>c, SHOW=n). Exit 1 on any violation.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { createFileStore } = await import(R + "/app/src/store.mjs");
const { createApp } = await import(R + "/app/src/app.mjs");
const SC = await import(R + "/app/public/session-core.mjs");
const { swapPreferences } = await import(R + "/tools/response-core.mjs");
const { replaceSlot, swapWhyFor, swapInRow, rebasesOnPermanent, planLiftAfterPermanent, buildTargets, tiredSwapRow, tiredDose, easeSlot, undoApplies, loggedWorkSets } = SC;

const DIR = process.env.HDIR ?? `${tmpdir()}/hb-sweep-swaps-${process.pid}`;
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
const DOORS = (process.env.DOORS ?? "busy,pick,yourpick,tired,ease,nomachine,dislike,hurt,undo").split(",");
const DEPTH = +(process.env.DEPTH ?? 3);
const REGION = process.env.REGION ?? "knee";
const SLOT = +(process.env.SLOT ?? 0);
const day = new Date().toISOString().slice(0, 10);

// ---- base user
const mk = (path) => { const store = createFileStore(path); const app = createApp(store, {}); return { store, app }; };
const base = mk(DIR + "/base.json");
const jsonOf = (app) => async (method, url, body, uid) => {
  const res = await app.request(url, { method, headers: { "content-type": "application/json", ...(uid ? { "X-HB-User": uid } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const on = await jsonOf(base.app)("POST", "/api/onboard", { profile: { units: "metric", sex: "male", training_status: "intermediate", primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] } });
const uid = on.data.user_id;

let n = 0;
async function runChain(chain) {
  const path = `${DIR}/c${++n}.json`;
  copyFileSync(DIR + "/base.json", path);
  const { store, app } = mk(path);
  const J = jsonOf(app);
  const api = async (url, opts = {}) => (await J(opts.method ?? "GET", url, opts.body ? JSON.parse(opts.body) : undefined, uid)).data;
  const today = (await api(`/api/today?d=${day}`)).session;
  let sess = { name: today.name, ex: today.exercises.map((x) => ({ ...x, planned_sets: x.sets })), i: SLOT, set: 0, logged: [], weights: {}, reps: {}, eff: {}, wUnits: {}, session_id: `s-${n}`, startedAt: new Date().toISOString(), localDate: day };
  const P = sess.ex[SLOT].exercise;
  // ground truth
  let truth = { planLift: P, vote: false, voteAgainst: null, liked: null, tired: false };
  let truthStack = null; // truth before the swap whose Undo is live
  const log = [];
  const bad = [];
  const slotState = () => { const x = sess.ex[sess.i]; return { exercise: x.exercise, slot_of: x.slot_of ?? null, swap_why: x.swap_why ?? null }; };

  const applyReplacement = (expect, row, undo, { sets = null } = {}) => {
    const i = sess.ex.findIndex((x) => x.exercise === expect);
    const why = swapWhyFor(sess.ex[i], undo);
    const r = replaceSlot(sess, i, swapInRow(sess.ex[i], why ? { ...row, swap_why: why } : row), { expect, ...(sets ? { sets } : {}), ...(undo.rebased ? { rebase: true } : {}), ...(undo.planLift ? { planLift: undo.planLift } : {}) });
    if (!r.ok) return r.reason;
    sess = { ...r.sess, swapUndo: { ...undo, session_id: r.sess.session_id, _prior: undo._prior }, ruledOut: [...new Set([...(r.sess.ruledOut ?? []), expect])] };
    return null;
  };
  const post = (cur, body) => api(`/api/exercise/cant-do?d=${day}`, { method: "POST", body: JSON.stringify({ user_id: uid, exercise: cur.exercise, session: sess.name ?? null,
    exclude: sess.ruledOut ?? [], prescription: { sets: cur.planned_sets ?? cur.sets, rep_range: cur.rep_range, rir: cur.rir }, slot_of: cur.slot_of ?? null, ...body }) });
  const live = () => sess.ex.map((x) => x.exercise);

  // truth helpers
  const snap = () => ({ truth: { ...truth }, slot: slotState() });
  const onSwap = (prior, kind, newLift, extra = {}) => {
    truthStack = prior;
    const t = { ...truth };
    if (kind === "picked") {
      if (!t.tired && prior.slot.exercise === t.planLift) { t.vote = true; t.voteAgainst = t.planLift; }
      t.liked = t.tired ? null : newLift;
    } else if (kind === "tired") { t.tired = true; t.liked = null; }
    else if (kind === "ease") { t.tired = true; }
    else { t.liked = null; }
    Object.assign(t, extra);
    truth = t;
  };

  async function pickList(cur, prior, planOverride, reason = null) {
    const d = await api(`/api/exercise/${encodeURIComponent(cur.exercise)}/alternatives?session=${encodeURIComponent(sess.name ?? "")}&live=${encodeURIComponent(live().join(","))}&exclude=${encodeURIComponent((sess.ruledOut ?? []).join(","))}`);
    const a = d?.alternatives?.[0];
    if (!a) return "no-alts";
    const r = await post(cur, { scope: "today", live: live(), pick: a.id });
    if (r.error) return "pick-err:" + r.error;
    const why = applyReplacement(cur.exercise, r.row ?? { exercise: a.id, name: a.name }, { to: a.id, toName: a.name, from: cur.exercise, fromName: cur.name, saved: cur, permanent: false, picked: true, ...(reason ? { reason } : {}) });
    if (why) return "refused:" + why;
    if (planOverride) truth = { ...truth, ...planOverride };
    onSwap(prior, reason === "hurt" ? "hurt" : "picked", a.id);
    return "picked " + a.id;
  }
  const easeInPlace = (cur) => {
    const prior = snap();
    const r = easeSlot(sess, sess.i, { expect: cur.exercise, stepKg: cur.inc_kg > 0 ? cur.inc_kg : 2.5, floorKg: cur.equipment === "barbell" ? 20 : 0 });
    if (!r.ok) return "ease-refused";
    sess = { ...r.sess, swapUndo: { to: cur.exercise, toName: cur.name, from: cur.exercise, fromName: cur.name, saved: cur, permanent: false, reason: "tired", lastSkip: sess.lastSkip ?? null, session_id: r.sess.session_id } };
    onSwap(prior, "ease", cur.exercise);
    return "eased";
  };

  const doors = {
    async busy(cur) {
      const prior = snap();
      const r = await post(cur, { scope: "today", live: live() });
      if (r.error) return "busy-err";
      const why = applyReplacement(cur.exercise, r.row ?? { exercise: r.replaced_by, name: r.replaced_by_name }, { to: r.replaced_by, toName: r.replaced_by_name, from: cur.exercise, fromName: cur.name, saved: cur, permanent: false });
      if (why) return "refused";
      onSwap(prior, "busy", r.replaced_by); return "busy " + r.replaced_by;
    },
    async pick(cur) { return pickList(cur, snap()); },
    async yourpick(cur) {
      const pickOffer = !!cur?.your_pick?.id && sess.set === 0 && !cur.superset_with && !cur.tired && typeof cur.slot_of !== "string"
        && loggedWorkSets(sess.logged ?? [], cur.exercise) === 0 && !sess.ex.some((x) => x.exercise === cur.your_pick.id);
      if (!pickOffer) return null;
      const prior = snap();
      const pick = cur.your_pick;
      const r = await post(cur, { scope: "today", live: live(), pick: pick.id });
      if (!r?.ok) return "yp-err";
      const why = applyReplacement(cur.exercise, r.row ?? { exercise: pick.id, name: pick.name }, { to: pick.id, toName: pick.name, from: cur.exercise, fromName: cur.name, saved: cur, permanent: false, picked: true });
      if (why) return "yp-refused";
      onSwap(prior, "picked", pick.id); return "yourpick " + pick.id;
    },
    async tired(cur) {
      if (cur.tired) return null;
      const prior = snap();
      const r = await post(cur, { scope: "today", live: live(), reason: "tired" });
      const nn = tiredDose(cur);
      if (r?.ok && r.row?.exercise) {
        const why = applyReplacement(cur.exercise, tiredSwapRow(r.row), { to: r.row.exercise, toName: r.row.name, from: cur.exercise, fromName: cur.name, saved: cur, permanent: false, reason: "tired", lastSkip: sess.lastSkip ?? null }, { sets: nn });
        if (!why) { onSwap(prior, "tired", r.row.exercise); return "tired " + r.row.exercise; }
      }
      return easeInPlace(cur);
    },
    async ease(cur) { if (cur.tired) return null; return easeInPlace(cur); }, // tiredSwap offline
    async nomachine(cur) { return permanent(cur, {}); },
    async dislike(cur) { return permanent(cur, { reason: "dislike" }); },
    async hurt(cur) {
      const prior = snap();
      const res = await api("/api/profile/injury", { method: "POST", body: JSON.stringify({ user_id: uid, region: REGION }) });
      // does the stored plan's day still hold the plan's lift?
      const u = await store.getUser(uid);
      const dayHolds = u.program.sessions.find((s) => s.name === sess.name)?.exercises.some((e) => e.exercise === truth.planLift);
      const over = dayHolds ? null : { planLift: "?removed:" + truth.planLift };
      return "hurt(" + (dayHolds ? "kept" : "removed") + ")>" + await pickList(cur, prior, over, "hurt");
    },
    async undo(cur) {
      const u = sess?.swapUndo;
      if (!undoApplies(u, sess, cur)) return null;
      const before = truthStack;
      if (u.permanent) {
        const r = await api("/api/exercise/cant-do", { method: "POST", body: JSON.stringify({ user_id: uid, exercise: u.from, scope: "undo" }) });
        if (r.error && r.error !== "not-excluded") return "undo-err";
      }
      const back = replaceSlot(sess, sess.ex.findIndex((x) => x.exercise === u.to), u.saved, { expect: u.to, sets: u.saved.sets, plannedSets: u.saved.planned_sets, ...((u.rebased || u.planLift) && typeof u.saved.slot_of !== "string" ? { rebase: true } : {}) });
      sess = { ...(back.ok ? back.sess : sess), swapUndo: null, ruledOut: (sess.ruledOut ?? []).filter((id) => id !== u.from) };
      const now = slotState();
      if (before && JSON.stringify(now) !== JSON.stringify(before.slot)) bad.push(`I4 undo: ${JSON.stringify(before.slot)} -> ${JSON.stringify(now)}`);
      if (before) truth = before.truth;
      truthStack = null;
      return "undo" + (back.ok ? "" : "(live refused)");
    },
  };
  async function permanent(cur, extra) {
    const prior = snap();
    const r = await post(cur, { scope: "always", ...extra });
    if (r.error) return "perm-err:" + r.error;
    if (r.kept) return "kept";
    // the plan's lift for this slot after the server's write
    let planAfter = truth.planLift;
    if (cur.exercise === truth.planLift) planAfter = r.replaced_by ?? ("?removed:" + cur.exercise);
    if (!r.today?.id) return "perm-noToday>" + await pickList(cur, prior, planAfter !== truth.planLift ? { planLift: planAfter, vote: false, voteAgainst: null } : {});
    const rebased = rebasesOnPermanent(cur, r);
    const why = applyReplacement(cur.exercise, r.row ?? { exercise: r.today.id, name: r.today.name }, { to: r.today.id, toName: r.today.name, from: cur.exercise, fromName: cur.name, saved: cur, permanent: true, rebased, planLift: planLiftAfterPermanent(cur, r) });
    if (why) return `perm-refused(${why})>` + await pickList(cur, prior, planAfter !== truth.planLift ? { planLift: planAfter, vote: false, voteAgainst: null } : {});
    onSwap(prior, "perm", r.today.id, planAfter !== truth.planLift ? { planLift: planAfter, vote: false, voteAgainst: null } : {});
    return `${extra.reason ?? "nomachine"} ${r.today.id}${rebased ? "(rebased)" : ""} replaced_by=${r.replaced_by}`;
  }

  const check = (where) => {
    const tg = buildTargets(sess)[sess.i];
    checkT(tg, where);
  };
  const checkT = (tg, where) => {
    const isVote = tg.swap_why === "pick" || tg.swap_why === "picked_over";
    if (truth.vote && !isVote) bad.push(`I1-lost@${where}: ${JSON.stringify(tg)}`);
    if (!truth.vote && isVote) bad.push(`I1-spurious@${where}: ${JSON.stringify({ ex: tg.exercise, sif: tg.stood_in_for, why: tg.swap_why })} truth=${JSON.stringify(truth)}`);
    if (truth.vote && isVote && tg.stood_in_for !== truth.voteAgainst) bad.push(`I1-target@${where}: votes vs ${tg.stood_in_for} expected ${truth.voteAgainst}`);
    if (tg.swap_why === "pick" && truth.liked !== tg.exercise) bad.push(`I2@${where}: liking ${tg.exercise} truth.liked=${truth.liked}`);
    if (!String(truth.planLift).startsWith("?removed") && tg.exercise !== truth.planLift && (tg.stood_in_for ?? null) !== truth.planLift) bad.push(`I3@${where}: holds ${tg.exercise} stood_in_for=${tg.stood_in_for ?? null} plan=${truth.planLift}`);
  };
  for (const d of chain) {
    const cur = sess.ex[sess.i];
    const out = await doors[d](cur);
    if (out == null) return { skip: true };
    log.push(`${d}:${out}`);
    check(log.length);
  }
  // finish through the real door
  const cur = sess.ex[sess.i];
  sess.logged = [{ exercise: cur.exercise, set_type: "work", weight_kg: 20, reps: 10, completed_at: new Date().toISOString() }];
  const payload = { session_id: sess.session_id, date: new Date().toISOString(), local_date: day, user_id: uid, session_name: sess.name, sets: sess.logged, targets: buildTargets(sess) };
  const fin = await J("POST", "/api/session", payload);
  const stored = (await store.listSessions(uid)).find((s) => s.session_id === sess.session_id);
  const st = stored?.targets?.find((t) => t.exercise === cur.exercise);
  if (!st) bad.push("finish: no stored target " + fin.status);
  else checkT(st, "stored");
  const prefs = swapPreferences(await store.listSessions(uid), new Date().toISOString());
  return { log, bad, P, prefs: { away: prefs.away, picked: prefs.picked }, truth };
}

const chains = [];
const gen = (pre) => { if (pre.length) chains.push(pre); if (pre.length < DEPTH) for (const d of DOORS) gen([...pre, d]); };
gen([]);
const ONLY = process.env.ONLY ? [process.env.ONLY.split(">")] : null;
const classes = {};
let ran = 0;
for (const ch of ONLY ?? chains) {
  const r = await runChain(ch);
  rmSync(`${DIR}/c${n}.json`, { force: true });
  if (r.skip) continue;
  ran++;
  if (process.env.ONLY) console.log(JSON.stringify(r, null, 1));
  if (process.env.DUMP) console.log("LOG " + ch.join(">") + " :: " + r.log.join(" | "));
  for (const b of r.bad) {
    const k = b.split("@")[0] + " " + b.split(":").slice(1).join(":").replace(/lift-\d+/g, "").slice(0, 0);
    (classes[b.split("@")[0]] ??= []).push(`${ch.join(">")} || ${r.log.join(" | ")} || ${b}`);
  }
}
console.log(`ran ${ran} chains (P = slot ${SLOT})`);
for (const [k, v] of Object.entries(classes)) { console.log(`\n== ${k}: ${v.length}`); for (const s of v.slice(0, Number(process.env.SHOW ?? 6))) console.log("  " + s); }
rmSync(DIR, { recursive: true, force: true });
process.exit(Object.keys(classes).length ? 1 : 0);
