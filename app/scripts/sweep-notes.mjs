// Route-level NOTES sweep (Burst 11 review round 14 — the harness that came back dry joins the repo, like sweep-swaps).
// Drives every chain of up to DEPTH doors (block/refit crossing, learned-dislike seeding, Bring back, cosmetic and
// training Settings saves, a plan edit, the hand-back, an injury, graduation, a logged workout) through createApp + a
// throwaway file store, at both levels, and after each step checks the once-only Today announcement against the live
// plan and the Plan tab (invariants N1..N6 below). Exits 1 on any violation. Run: `npm run sweep:notes` (~30 s).
// Not part of `npm test` (it is a sweep, not a unit) — run it whenever buildToday's notes or a plan_meta stamp changes.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { createFileStore } = await import(R + "/app/src/store.mjs");
const { createApp } = await import(R + "/app/src/app.mjs");
const { generateUserPlan, planOptsFor, injuryRegionFor } = await import(R + "/app/src/planner.mjs");
const { exercises: kbEx } = await import(R + "/app/src/kb-data.mjs");
const kb = await import(R + "/app/src/kb-data.mjs");
const exById = new Map(kbEx.map((e) => [e.id, e]));
const nameToId = new Map(kbEx.map((e) => [e.name, e.id]));
const nm = (id) => exById.get(id)?.name ?? id;

const DIR = process.env.HDIR ?? `${tmpdir()}/hb-sweep-notes-${process.pid}`;
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
const DOORS = (process.env.DOORS ?? "cross,seed,bring,cosmetic,training,edit,handback,injury,grad,log").split(",");
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
      sets: Array.from({ length: 3 }, () => ({ exercise: flat, set_type: "work", weight_kg: 40, reps: 8 })) });
  // the seed lift: one whose learned dislike would actually take it out
  const seed = lifts.filter((id) => id !== flat).find((id) => !holds(generateUserPlan(u0.profile, planOptsFor(u0, { prefScores: { [id]: 1 } })).program, id));
  // the injury region: prefer one that rules out the seed lift
  const regions = Object.keys(kb.contraindications?.regions ?? {});
  const region = process.env.REGION ?? regions.find((r) => injuryRegionFor({ injuries: [{ region: r, severity: "moderate" }] }, seed)) ?? "knee";
  bases[level] = { path, uid, flat, seed, region };
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
  let prev = await store.getUser(uid);
  // initial Today (no doors) — a fresh onboard
  await getToday();
  prev = await store.getUser(uid);
  const bad = [];
  const trace = [];
  for (let i = 0; i < chain.length; i++) {
    const door = chain[i];
    const before = await store.getUser(uid);
    let r = "";
    switch (door) {
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
    const ann = today?.session?.announcement ?? "";
    const p = parse(ann);
    const live = u.program;
    const custom = !!ex?.program?.custom;
    const listed = new Set([...(ex?.learned_out ?? []), ...(ex?.skipped ?? [])].map((x) => x.id));
    const unavail = new Set((ex?.unavailable ?? []).map((x) => x.id));
    const step = { door, r, ann, stamps: { rot: u.plan_meta?.rotated_at?.slice(11, 19), hb: u.plan_meta?.handed_back_at?.slice(11, 19), lo: u.plan_meta?.learned_out, sw: u.plan_meta?.swapped_this_block, rd: u.plan_meta?.refit_diff, grad: u.plan_meta?.graduated_to, st: u.profile.training_status, custom } };
    trace.push(step);
    const flag = (cls, detail) => bad.push({ cls, at: i, detail });
    for (const [why, id] of p.gone) { if (id.startsWith("?")) flag(`PARSE-gone-${why}`, id); else if (holds(live, id)) flag(`N1-${why}`, `${nm(id)} named gone but in live plan`); }
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
else { let layer = [[]]; for (let d = 1; d <= DEPTH; d++) { layer = layer.flatMap((p) => DOORS.map((x) => [...p, x])); chains.push(...layer); } }
const t0 = Date.now();
for (const level of LEVELS) for (const c of chains) await runChain(level, c);
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
if (classes.size) { console.log(`\n${classes.size} violation class(es).`); process.exit(1); }
console.log("0 violations.");
