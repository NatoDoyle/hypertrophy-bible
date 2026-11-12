// Route-level NOTES sweep (Burst 11 review rounds 14-16; the harness that came back dry joins the repo, like sweep-swaps).
// It drives every chain of up to DEPTH doors through createApp and a throwaway file store, at both levels. The doors:
// block/refit crossing, learned-dislike seeding, Bring back, cosmetic and training Settings saves, a plan edit, the
// hand-back, an injury, graduation, a logged workout, an account merge (with and without a carried Bring back), a
// days-per-week change, No machine and its undo, Just not for me and its undo, a custom lift, the session-cap offer
// (accept/decline) and a pause-learning edit. After each step it checks the once-only Today announcement against the
// live plan and the Plan tab (invariants N1..N6 below). It exits 1 on any violation. `npm run sweep:notes` runs depth 3
// as four slices (SLOT/NSLOT), about 90 s each; DEPTH=2 node scripts/sweep-notes.mjs is the 12-second check.
// Not part of `npm test` (it is a sweep, not a unit) — run it whenever buildToday's notes or a plan_meta stamp changes.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { createFileStore } = await import(R + "/app/src/store.mjs");
const { sha256hex } = await import(R + "/app/src/auth.mjs");
const { createApp } = await import(R + "/app/src/app.mjs");
const { generateUserPlan, planOptsFor, injuryRegionFor } = await import(R + "/app/src/planner.mjs");
const { exercises: kbEx } = await import(R + "/app/src/kb-data.mjs");
const kb = await import(R + "/app/src/kb-data.mjs");
const exById = new Map(kbEx.map((e) => [e.id, e]));
const nameToId = new Map(kbEx.map((e) => [e.name, e.id]));
const nm = (id) => exById.get(id)?.name ?? id;

const DIR = process.env.HDIR ?? `${tmpdir()}/hb-sweep-notes-${process.pid}`;
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
const DOORS = (process.env.DOORS ?? "cross,seed,bring,cosmetic,training,edit,handback,injury,grad,log,merge,mergek,days,nomachine,nmundo,dislike,dlundo,custom,capyes,capno,pedit,nmflat").split(",");
const SLOT = +(process.env.SLOT ?? 0), NSLOT = +(process.env.NSLOT ?? 1);
const NEWONLY = !!process.env.NEWONLY; // depth-3: only chains holding at least one new door
const NEW = new Set(["merge", "mergek", "days", "nomachine2", "dislike2", "cross2", "nomachine", "nmundo", "dislike", "dlundo", "custom", "capyes", "capno", "pedit"]);
const DEPTH = +(process.env.DEPTH ?? 3);
const LEVELS = (process.env.LEVELS ?? "beginner,intermediate").split(",");
const SHOW = +(process.env.SHOW ?? 3);
const dayAgo = (n, h = 0) => new Date(Date.now() - n * 86400000 - h * 3600000).toISOString();
const holds = (p, id) => (p?.sessions ?? []).some((s) => s.exercises.some((e) => e.exercise === id));
const liftsOf = (p) => [...new Set((p?.sessions ?? []).flatMap((s) => s.exercises.map((e) => e.exercise)))];

const mk = (path) => { const store = createFileStore(path); const app = createApp(store, {}); return { store, app }; };
const J = (app) => async (method, url, body, uid) => {
  const res = await app.request(url, { method, headers: { "content-type": "application/json", ...(uid ? { "X-HB-User": uid } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};

// ---- base fixtures: one per level
const bases = {};
for (const level of LEVELS) {
  const path = `${DIR}/base-${level}.json`;
  const { store, app } = mk(path);
  const api = J(app);
  const profile = { units: "metric", sex: "male", training_status: level, primary_goal: "hypertrophy", days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"] };
  const uid = (await api("POST", "/api/onboard", { profile })).data.user_id;
  const u0 = await store.getUser(uid);
  const lifts = liftsOf(u0.program);
  const flat = process.env.FLAT ?? (lifts.includes("lat-pulldown") ? "lat-pulldown" : lifts.find((id) => exById.get(id)?.mechanic === "isolation") ?? lifts[0]);
  // 25 weeks x 2 flat sessions at 14..182 days ago (graduation needs 26 weeks + 40 sessions: one more week does it)
  for (let w = 0; w < 24; w++) for (let k = 0; k < 2; k++)
    await store.addSession(uid, { session_id: `b-${w}-${k}`, user_id: uid, date: dayAgo(14 + 7 * w, k * 2), program_ref: u0.program.id,
      // 6 sets a session, ~the plan's own volume, so the completion gate does not spare the muscle and the stall SWAPS
      // (round 16: at 3 sets the lift was always spared, and no chain exercised a stall note).
      sets: Array.from({ length: +(process.env.FLATSETS ?? 6) }, () => ({ exercise: flat, set_type: "work", weight_kg: 40, reps: 8 })) });
  // the seed lift: one whose learned dislike would actually take it out
  const seed = lifts.filter((id) => id !== flat).find((id) => !holds(generateUserPlan(u0.profile, planOptsFor(u0, { prefScores: { [id]: 1 } })).program, id));
  // the injury region: prefer one that rules out the seed lift
  const regions = Object.keys(kb.contraindications?.regions ?? {});
  const region = process.env.REGION ?? regions.find((r) => injuryRegionFor({ injuries: [{ region: r, severity: "moderate" }] }, seed)) ?? "knee";
  // merge sources: anonymous users in the SAME store, each carrying its own plan_meta stamps (a block it rotated, a hand-back,
  // a refit diff, a learned dislike of the seed lift and another lift `to` holds) and a short recent history of its own.
  const froms = [];
  const other = lifts.find((id) => id !== flat && id !== seed && exById.get(id)?.mechanic === "isolation") ?? lifts[1];
  for (let k = 0; k < 6; k++) {
    const fid = (await api("POST", "/api/onboard", { profile: { ...profile, days_per_week: 4 } })).data.user_id;
    const fu = await store.getUser(fid);
    const fl = liftsOf(fu.program);
    await store.updateUser(fid, (u) => {
      u.plan_meta = { ...u.plan_meta, rotated_at: dayAgo(0, 2), handed_back_at: dayAgo(0, 2), graduated_to: level === "beginner" ? "intermediate" : null,
        learned_out: [seed].filter(Boolean), swapped_this_block: [fl[0]], refit_diff: { out: [fl[1]], in: [fl[2]] }, main_before: fl,
        pref_scores: k % 2 === 0 ? { [seed]: 1, [other]: 1 } : {}, ...(k % 2 === 1 ? { pref_kept: [seed] } : {}) };
      return u;
    });
    for (const d of [3, 10]) await store.addSession(fid, { session_id: `f${k}-${d}`, user_id: fid, date: dayAgo(d), program_ref: fu.program.id,
      sets: Array.from({ length: 3 }, () => ({ exercise: fl[0], set_type: "work", weight_kg: 30, reps: 10 })) });
    froms.push(fid);
  }
  bases[level] = { path, uid, flat, seed, region, froms, other };
  console.log(`base ${level}: uid=${uid.slice(0, 8)} flat=${flat} seed=${seed} region=${region} lifts=${lifts.length}`);
}

// ---- parse an announcement into named-gone / named-arriving / bring-back lists
const splitNames = (s) => {
  // names joined by ", " — resolve greedily against KB names (names may contain commas, rarely)
  const parts = s.split(", "); const out = [];
  for (let i = 0; i < parts.length; i++) {
    let found = null;
    for (let j = parts.length; j > i; j--) { const cand = parts.slice(i, j).join(", "); if (nameToId.has(cand)) { found = [cand, j]; break; } }
    if (found) { out.push(nameToId.get(found[0])); i = found[1] - 1; } else out.push("?" + parts[i]);
  }
  return out;
};
function parse(ann) {
  const gone = [], arriving = [], bring = [], tags = [];
  let m;
  for (m of ann.matchAll(/(?:^|[.!—] )Your ([^.]+?) had gone flat for weeks, so I've swapped/g)) gone.push(...splitNames(m[1]).map((x) => ["stall", x]));
  for (m of ann.matchAll(/You've swapped (.+?) out for something else again and again lately/g)) { const l = splitNames(m[1]); gone.push(...l.map((x) => ["learned", x])); bring.push(...l); }
  for (m of ann.matchAll(/You'd picked something else over (.+?) again and again/g)) { const l = splitNames(m[1]); gone.push(...l.map((x) => ["handback", x])); bring.push(...l); }
  for (m of ann.matchAll(/(?:^|[.!—] )([^.]+?) made way for ([^.]+?)\./g)) { gone.push(...splitNames(m[1]).map((x) => ["madeway", x])); arriving.push(...splitNames(m[2]).map((x) => ["madeway", x])); }
  for (m of ann.matchAll(/(?:^|[.!—] )([^.]+?) left your plan\./g)) gone.push(...splitNames(m[1]).map((x) => ["left", x]));
  for (m of ann.matchAll(/(?:^|[.!—] )([^.]+?) joined your plan\./g)) arriving.push(...splitNames(m[1]).map((x) => ["joined", x]));
  if (/Six more weeks/.test(ann)) tags.push("refit");
  if (/New block/.test(ann)) tags.push("block");
  if (/Back on the coach's plan/.test(ann)) tags.push("handback");
  if (/🎓/.test(ann)) tags.push("grad");
  if (/re-sized your sessions to the pace/.test(ann)) tags.push("resized");
  if (/re-fitted your plan to how/.test(ann)) tags.push("refitted");
  return { gone, arriving, bring, tags };
}

const sameLiftsPerDay = (a, b) => JSON.stringify((a?.sessions ?? []).map((s) => [s.name, s.exercises.map((e) => e.exercise).sort()])) === JSON.stringify((b?.sessions ?? []).map((s) => [s.name, s.exercises.map((e) => e.exercise).sort()]));
const sameSets = (a, b) => JSON.stringify((a?.sessions ?? []).map((s) => s.exercises.map((e) => [e.exercise, e.sets]))) === JSON.stringify((b?.sessions ?? []).map((s) => s.exercises.map((e) => [e.exercise, e.sets])));

// ---- one chain
let n = 0;
const classes = new Map();
async function runChain(level, chain) {
  const B = bases[level];
  const path = `${DIR}/c${++n}.json`;
  copyFileSync(B.path, path);
  const { store, app } = mk(path);
  const api = J(app);
  const uid = B.uid;
  const getToday = async () => (await api("GET", `/api/today?d=${new Date().toISOString().slice(0, 10)}`, null, uid)).data;
  const getExplain = async () => (await api("GET", "/api/plan/explain", null, uid)).data;
  // what the plan looked like before the change a stamp records (set when rotated_at / handed_back_at changes)
  let preChange = null;
  // Lifts a COACH-driven rebuild door took out since the last announcement (round 16 #0): a stall swapped mid-block is
  // named at the next boundary/refit, so the stall note may name it though the plan just before the crossing lacked it.
  // Lifter-driven removals (No machine, Just not for me, an edit) never count, so round 15 #2 keeps its force.
  const COACH_DOORS = new Set(["cosmetic", "training", "injury", "bring", "handback", "merge", "mergek", "days", "capyes", "capno", "nmundo", "dlundo"]);
  let coachRemoved = new Set(), stampCoach = new Set(); // stampCoach: frozen when the open note's stamp was written
  let prev = await store.getUser(uid);
  // initial Today (no doors) — a fresh onboard
  let prevTags = parse((await getToday())?.session?.announcement ?? "").tags;
  prev = await store.getUser(uid);
  const bad = [];
  const trace = [];
  const usedFrom = {};
  for (let i = 0; i < chain.length; i++) {
    const door = chain[i];
    const before = await store.getUser(uid);
    const heldBefore = new Set(liftsOf(before.program)); // by value (lesson 114)
    let r = "";
    switch (door) {
      case "cross2": await store.updateUser(uid, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(100) }; return u; }); r = "backdated100"; break;
      case "cross": await store.updateUser(uid, (u) => { u.plan_meta = { ...u.plan_meta, block_start: dayAgo(56) }; return u; }); r = "backdated"; break;
      case "seed": await store.updateUser(uid, (u) => { u.plan_meta = { ...u.plan_meta, pref_scores: { ...(u.plan_meta?.pref_scores ?? {}), [B.seed]: 1 } }; return u; }); r = "seeded " + B.seed; break;
      case "bring": {
        const ex = await getExplain();
        const X = ex.learned_out?.[0]?.id ?? ex.skipped?.[0]?.id ?? ex.unavailable?.[0]?.id ?? (before.plan_meta?.pref_scores?.[B.seed] > 0 ? B.seed : null);
        if (!X) { r = "nothing"; break; }
        const res = await api("POST", "/api/exercise/cant-do", { user_id: uid, exercise: X, scope: "undo" });
        r = `bring ${X} -> ${res.status} ${res.data?.mode ?? res.data?.error}`; break;
      }
      case "cosmetic": { const res = await api("POST", "/api/plan/regenerate", { user_id: uid, profile: { units: "metric" } }); r = "cosmetic " + res.status; break; }
      case "training": { const cur = before.profile.session_length_min; const res = await api("POST", "/api/plan/regenerate", { user_id: uid, profile: { session_length_min: cur === 60 ? 75 : 60 } }); r = "training " + res.status; break; }
      case "edit": { const ex = await getExplain(); ex.program.sessions[0].exercises[0].sets = Math.min(10, ex.program.sessions[0].exercises[0].sets + 1); const res = await api("POST", "/api/plan/save", { user_id: uid, program: ex.program }); r = "edit " + res.status; break; }
      case "handback": { const res = await api("POST", "/api/plan/regenerate", { user_id: uid }); r = "bare-regen " + res.status + (before.program.custom ? " (handback)" : ""); break; }
      case "injury": { const res = await api("POST", "/api/profile/injury", { user_id: uid, region: B.region, severity: "moderate" }); r = "injury " + res.status; break; }
      case "grad": { for (const d of [7, 14 + 7 * 24]) await store.addSession(uid, { session_id: `g-${i}-${d}`, user_id: uid, date: dayAgo(d), program_ref: before.program.id, sets: [{ exercise: B.flat, set_type: "work", weight_kg: 40, reps: 8 }] }); r = "grad-sessions"; break; }
      case "merge": case "mergek": {
        const pool = B.froms.filter((_, k) => (k % 2 === 0) === (door === "merge"));
        const fid = pool[usedFrom[door] = (usedFrom[door] ?? -1) + 1];
        const grant = `grant-${n}-${i}`;
        await store.createMagicLink({ token_hash: await sha256hex(grant), email: "x@example.com", rl_key: "grant:x", ip: null, user_id: uid, purpose: "merge-grant", expires_at: Date.now() + 600000, used: 0, created_at: Date.now() });
        const res = await (async () => { const rr = await app.request("/api/auth/merge", { method: "POST", headers: { "content-type": "application/json", "X-HB-User": fid }, body: JSON.stringify({ from_user_id: fid, to_user_id: uid, grant }) }); return { status: rr.status, data: await rr.json().catch(() => null) }; })();
        r = `${door} ${res.status} ${res.data?.sessions ?? res.data?.error}`; break;
      }
      case "days": { const cur = before.profile.days_per_week; const res = await api("POST", "/api/plan/regenerate", { user_id: uid, profile: { days_per_week: cur === 3 ? 4 : 3 } }); r = `days ${cur}->${cur === 3 ? 4 : 3} ${res.status}`; break; }
      case "nmflat": { // No machine on the STALLED lift: its later stall note must never claim the boundary swapped it (round 15 #2)
        const sess = before.program.sessions.find((s) => s.exercises.some((e) => e.exercise === B.flat))?.name;
        const res = await api("POST", "/api/exercise/cant-do", { user_id: uid, exercise: B.flat, scope: "always", ...(sess ? { session: sess } : {}) });
        r = `nmflat ${B.flat} -> ${res.status} ${res.data?.replaced_by ?? res.data?.error ?? ""}`; break;
      }
      case "nomachine": case "dislike": case "nomachine2": case "dislike2": {
        const lifts = liftsOf(before.program);
        // variant 2 targets the lift the open note is most about: one named arriving, else a lift not in main_before, else the last lift
        const pm = before.plan_meta ?? {};
        const X2 = (pm.refit_diff?.in ?? []).find((id) => lifts.includes(id)) ?? lifts.filter((id) => exById.has(id) && !(pm.main_before ?? []).includes(id) && id !== B.flat).pop() ?? lifts[lifts.length - 1];
        const X = door.endsWith("2") ? X2 : lifts.includes(B.seed) ? B.seed : lifts.find((id) => id !== B.flat && exById.has(id)) ?? lifts[0];
        const sess = before.program.sessions.find((s) => s.exercises.some((e) => e.exercise === X))?.name;
        const res = await api("POST", "/api/exercise/cant-do", { user_id: uid, exercise: X, scope: "always", session: sess, ...(door.startsWith("dislike") ? { reason: "dislike" } : {}) });
        r = `${door} ${X} -> ${res.status} ${res.data?.replaced_by ?? (res.data?.kept ? "kept" : res.data?.error ?? "")}`; break;
      }
      case "nmundo": case "dlundo": {
        const ex = await getExplain();
        const X = door === "nmundo" ? ex.unavailable?.[0]?.id : ex.skipped?.[0]?.id;
        if (!X) { r = "nothing"; break; }
        const res = await api("POST", "/api/exercise/cant-do", { user_id: uid, exercise: X, scope: "undo" });
        r = `${door} ${X} -> ${res.status} ${res.data?.mode ?? res.data?.error}`; break;
      }
      case "custom": {
        const e0 = before.program.sessions[0].exercises[0];
        const prim = exById.get(e0.exercise)?.primary_muscles ?? ["chest"];
        const add = await api("POST", "/api/exercise/custom", { user_id: uid, exercise: { name: `My Lift ${i}`, primary_muscles: prim, equipment: "machine", mechanic: exById.get(e0.exercise)?.mechanic ?? "isolation" } });
        const ex = await getExplain();
        ex.program.sessions[0].exercises[0] = { ...ex.program.sessions[0].exercises[0], exercise: add.data.exercise.id };
        const res = await api("POST", "/api/plan/save", { user_id: uid, program: ex.program });
        r = `custom ${add.data.exercise.id} save ${res.status}`; break;
      }
      case "capyes": { const t = await getToday(); const cur = before.profile.session_cap; const cap = t?.daily?.session_cap_offer?.cap ?? (cur === 12 ? 14 : 12);
        const res = await api("POST", "/api/plan/regenerate", { user_id: uid, profile: { session_cap: cap } }); r = `capyes ${cap} ${res.status}${t?.daily?.session_cap_offer ? " (offered)" : ""}`; break; }
      case "capno": { const t = await getToday(); const cap = t?.daily?.session_cap_offer?.cap ?? 12;
        const res = await api("POST", "/api/plan/session-cap", { user_id: uid, choice: "not_now", cap }); r = `capno ${cap} ${res.status}`; break; }
      case "pedit": {
        // a pause-learning edit that changes a LIFT (not just sets): the last lift of day 1 for its first fitting alternative
        const ex = await getExplain(); const s0 = ex.program.sessions[0]; const last = s0.exercises[s0.exercises.length - 1];
        const alts = (await api("GET", `/api/exercise/${last.exercise}/alternatives?session=${encodeURIComponent(s0.name)}`, null, uid)).data?.alternatives ?? [];
        const alt = alts.find((a) => !liftsOf(ex.program).includes(a.id));
        if (!alt) { r = "pedit none"; break; }
        s0.exercises[s0.exercises.length - 1] = { ...last, exercise: alt.id }; delete s0.exercises[s0.exercises.length - 1].superset_with;
        const res = await api("POST", "/api/plan/save", { user_id: uid, program: ex.program });
        r = `pedit ${last.exercise}->${alt.id} ${res.status}`; break;
      }
      case "log": { const t = await getToday(); const ex = t?.session?.exercises?.[0]; const res = await api("POST", "/api/session", { user_id: uid, session_id: `l-${i}-${n}`, date: new Date().toISOString(), session_name: t?.session?.name ?? null,
        sets: [{ exercise: ex?.exercise ?? B.flat, set_type: "work", weight_kg: 40, reps: 8 }] }); r = "log " + res.status; break; }
    }
    const preToday = await store.getUser(uid);
    const today = await getToday();
    const ex = await getExplain();
    const u = await store.getUser(uid);
    // a new stamp: the change it records was from the plan as it stood before this step
    const stampChanged = (u.plan_meta?.rotated_at !== before.plan_meta?.rotated_at) || (u.plan_meta?.handed_back_at !== before.plan_meta?.handed_back_at);
    if (stampChanged) preChange = before.program;
    if (COACH_DOORS.has(door)) for (const id of heldBefore) if (!holds(u.program, id)) coachRemoved.add(id);
    const ann = today?.session?.announcement ?? "";
    const p = parse(ann);
    const live = u.program;
    const custom = !!ex?.program?.custom;
    const listed = new Set([...(ex?.learned_out ?? []), ...(ex?.skipped ?? [])].map((x) => x.id));
    const unavail = new Set((ex?.unavailable ?? []).map((x) => x.id));
    const step = { door, r, ann, stamps: { rot: u.plan_meta?.rotated_at?.slice(11, 19), hb: u.plan_meta?.handed_back_at?.slice(11, 19), lo: u.plan_meta?.learned_out, sw: u.plan_meta?.swapped_this_block, rd: u.plan_meta?.refit_diff, grad: u.plan_meta?.graduated_to, st: u.profile.training_status, custom } };
    trace.push(step);
    const flag = (cls, detail) => bad.push({ cls, at: i, detail });
    for (const [why, id] of p.gone) { if (id.startsWith("?")) flag(`PARSE-gone-${why}`, id); else if (holds(live, id)) flag(`N1-${why}`, `${nm(id)} named gone but in live plan`);
      else if (why !== "handback" && preChange && !holds(preChange, id) && !(why === "stall" && (coachRemoved.has(id) || stampCoach.has(id)))) flag(`N1b-notbefore-${why}`, `${nm(id)} named as having left, but the pre-change plan never held it`); }
    for (const [why, id] of p.arriving) {
      if (id.startsWith("?")) { flag(`PARSE-arr-${why}`, id); continue; }
      if (!holds(live, id)) flag(`N2-notlive-${why}`, `${nm(id)} named arriving but not in live plan`);
      else if (preChange && holds(preChange, id)) flag(`N2-already-${why}`, `${nm(id)} named arriving but was in the pre-change plan`);
    }
    if (custom && /Six more weeks|New block|Back on the coach's plan/.test(ann)) flag("N3-custom", ann.slice(0, 80));
    if (custom && /🎓/.test(ann)) flag("N3-custom-grad", "graduation note over a hand-edited plan");
    for (const id of p.bring) if (!id.startsWith("?") && !listed.has(id)) flag(unavail.has(id) ? "N4-unavail" : "N4", `${nm(id)} offered Bring back but explain doesn't list it (lo=${JSON.stringify([...listed])})`);
    if (p.tags.includes("refit") && u.profile.training_status !== "beginner") flag("N5-refit-nonbeginner", ann.slice(0, 80));
    if (p.tags.includes("resized") || p.tags.includes("refitted")) {
      if (preChange && sameLiftsPerDay(preChange, live) && sameSets(preChange, live)) flag("N5-resize-nochange", "claims a re-size/re-fit but the live plan equals the pre-refit plan");
      else if (preChange && !sameLiftsPerDay(preChange, live)) flag("N5-resize-unnamed", "claims a pace re-size while a lift change vs pre-refit plan is unnamed");
    }
    if (p.tags.includes("block") && /Your main lifts stay/.test(ann) && preChange) {
      const mainBefore = liftsOf(preChange).filter((id) => exById.get(id)?.mechanic === "compound");
      const lost = mainBefore.filter((id) => !holds(live, id));
      if (lost.length) flag(u.plan_meta?.graduated_to ? "N5-grad-mainlifts" : "N5-block-mainlifts", `'Your main lifts stay' but ${lost.map(nm).join(", ")} left`);
    }
    if (door === "log" && r === "log 200" && (p.tags.some((t) => ["refit", "block", "handback", "grad"].includes(t)))) flag("N6", ann.slice(0, 100));
    // N7: a once-only note that was NOT showing comes back without a new stamp recording a new change
    const gradChanged = u.plan_meta?.graduated_to !== before.plan_meta?.graduated_to;
    for (const t of ["refit", "block", "handback", "grad"]) if (p.tags.includes(t) && !prevTags.includes(t) && !stampChanged && !gradChanged) flag(`N7-reappear-${t}`, ann.slice(0, 120));
    prevTags = p.tags;
    if (stampChanged) { stampCoach = coachRemoved; coachRemoved = new Set(); }
  }
  if (process.env.DUMP) { console.log(`\n### ${level} ${chain.join(">")}`); for (const t of trace) console.log(`  [${t.door}] ${t.r} | ${JSON.stringify(t.stamps)}\n    ANN: ${t.ann}`); for (const b of bad) console.log("  !! " + b.cls + " " + b.detail); }
  if (bad.length) {
    for (const b of bad) {
      const key = `${level}:${b.cls}`;
      const c = classes.get(key) ?? { count: 0, examples: [] };
      c.count++;
      if (c.examples.length < SHOW) c.examples.push({ chain: chain.join(">"), at: b.at, detail: b.detail, trace: trace.slice(0, b.at + 1).map((t) => ({ ...t, ann: t.ann.slice(0, 600) })) });
      classes.set(key, c);
    }
  }
  rmSync(path, { force: true });
}

const chains = [];
if (process.env.ONLY) for (const c of process.env.ONLY.split(";")) chains.push(c.split(">"));
else { let layer = [[]]; for (let d = 1; d <= DEPTH; d++) { layer = layer.flatMap((p) => DOORS.map((x) => [...p, x])); chains.push(...layer.filter((c) => !NEWONLY || c.some((x) => NEW.has(x)))); } }
const t0 = Date.now();
let k = 0;
for (const level of LEVELS) for (const c of chains) { if (k++ % NSLOT === SLOT) await runChain(level, c); }
console.log(`ran ${chains.length * LEVELS.length} chains in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [k, c] of [...classes.entries()].sort()) {
  console.log(`\n=== ${k}: ${c.count}`);
  // minimal chain first
  c.examples.sort((a, b) => a.chain.split(">").length - b.chain.split(">").length);
  for (const e of c.examples) {
    console.log(`  chain ${e.chain} @step ${e.at}: ${e.detail}`);
    if (process.env.TRACE) for (const t of e.trace) console.log(`    [${t.door}] ${t.r} | ${JSON.stringify(t.stamps)}\n      ANN: ${t.ann}`);
  }
}
rmSync(DIR, { recursive: true, force: true });
if (process.env.OUT) (await import("node:fs")).writeFileSync(process.env.OUT, JSON.stringify([...classes.entries()]));
if (classes.size) { console.log(`\n${classes.size} violation class(es).`); process.exit(1); }
console.log("0 violations.");
