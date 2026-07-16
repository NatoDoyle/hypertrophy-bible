// The Hypertrophy Bible — brainless client. One decision per screen; everything
// higher-order is derived server-side. No build step, no framework.
import { LEARN_INDEX, LEARN_PAGES } from "./learn-data.js";
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const nav = $("#nav");
let uid = localStorage.getItem("hb_user");
let tab = "today";
let learnSlug = null; // which Learn page is open (null = the Learn index)

// Plain-English muscle names — a beginner expects "shoulders", not "side-delts".
const MUSCLE_LABEL = {
  "front-delts": "front of shoulders", "side-delts": "shoulders (side)", "rear-delts": "rear shoulders",
  "lats": "back (lats)", "upper-back": "upper back", "spinal-erectors": "lower back",
  "quadriceps": "thighs (quads)", "hamstrings": "hamstrings", "glutes": "glutes", "calves": "calves",
  "biceps": "biceps", "triceps": "triceps", "forearms": "forearms", "chest": "chest", "abs": "abs", "neck": "neck",
};
const friendlyMuscle = (m) => MUSCLE_LABEL[m] || String(m).replace(/-/g, " ");
const friendlyMuscles = (list) => (list || []).map(friendlyMuscle).join(", ");

// Units: everything is STORED and computed in kg (server + engine). This is a
// pure display layer — pounds are shown/entered by the user who prefers them and
// converted at the edges, so a US/UK beginner never has to think in kg.
const LB_PER_KG = 2.2046226;
const unitPref = () => localStorage.getItem("hb_units") === "imperial" ? "lb" : "kg";
const unitLabel = () => unitPref();
const wInc = () => unitPref() === "lb" ? 5 : 2.5;                       // stepper increment, display units
const dispWeight = (kg) => unitPref() === "lb" ? Math.round(kg * LB_PER_KG / 5) * 5 : Math.round(kg * 4) / 4; // to plate
const dispBw = (kg) => unitPref() === "lb" ? Math.round(kg * LB_PER_KG * 10) / 10 : Math.round(kg * 10) / 10; // bodyweight
const toKg = (v) => unitPref() === "lb" ? Math.round((v / LB_PER_KG) * 100) / 100 : v;

// Deep-link into the in-app beginner library (content/09-getting-started).
function openLearn(slug) { learnSlug = slug || null; tab = "learn"; render(); }
// Wire any [data-learn="slug"] element on the current screen to open that page.
function wireLearnLinks() { app.querySelectorAll("[data-learn]").forEach((b) => b.onclick = () => openLearn(b.dataset.learn)); }
// A small inline "?" that opens a learn page — decodes jargon in place.
const helpDot = (slug, label = "?") => `<button class="help" data-learn="${slug}" aria-label="Explain">${label}</button>`;

const api = async (path, opts = {}) => {
  const headers = { "content-type": "application/json", ...(uid ? { "X-HB-User": uid } : {}), ...(opts.headers || {}) };
  const r = await fetch(path, { ...opts, headers });
  return r.json();
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Set to your Open Collective / GitHub Sponsors URL when it exists. The support
// button stays hidden until then — never show a dead or fake donation link.
const DONATE_URL = "";

// ---------- Offline write queue ----------
// Logging must never be lost to a dead gym basement signal: failed POSTs wait
// in localStorage and sync when the connection returns.
const QKEY = "hb_queue";
const getQueue = () => { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch { return []; } };
const setQueue = (q) => localStorage.setItem(QKEY, JSON.stringify(q));
let flushing = false; // guard against re-entrancy (load + 'online', or two tabs)
async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    while (true) {
      const q = getQueue();
      if (!q.length) break;
      const item = q[0];
      // The queue is device-local, so the current user always owns it. Rebinding
      // heals items whose account switched (a restore) after they were queued —
      // they land on the account instead of a stale/deleted user_id.
      const body = JSON.stringify({ ...JSON.parse(item.body), user_id: uid });
      let ok = false;
      try { ok = (await fetch(item.path, { method: "POST", headers: { "content-type": "application/json" }, body })).ok; }
      catch { break; } // offline again — keep everything for next time
      if (!ok) break;   // server/HTTP error — retry later rather than drop the workout
      // Re-read before dropping the head: an item queued during the POST is preserved.
      setQueue(getQueue().slice(1));
    }
  } finally { flushing = false; }
}
window.addEventListener("online", flushQueue);
async function postOrQueue(path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body });
    if (!r.ok) throw new Error("http " + r.status); // a live HTTP error must queue, not "succeed"
    return { ok: true, data: await r.json() };
  } catch {
    setQueue([...getQueue(), { path, body }]);
    return { ok: false, queued: true };
  }
}

// ---------- Onboarding ----------
const STEPS = [
  { key: "training_status", q: "Have you lifted weights before?", opts: [["New to this", "beginner"], ["About a year in", "intermediate"], ["Several years", "advanced"]] },
  { key: "primary_goal", q: "What do you want most?", opts: [["Build muscle", "hypertrophy"], ["Get stronger", "strength"], ["Lose fat", "fat-loss"], ["A bit of both", "recomposition"]] },
  { key: "days_per_week", q: "How many days a week can you train?", stepper: { min: 2, max: 6, def: 3, hint: "Most beginners grow well on 3." } },
  { key: "session_length_min", q: "How long can each session be?", stepper: { min: 30, max: 90, step: 15, def: 60, hint: "45–60 minutes suits most people.", unit: " min" } },
  { key: "available_equipment", q: "Where will you train?", opts: [["A full gym", ["barbell", "dumbbell", "machine", "cable", "bodyweight"]], ["Home with dumbbells", ["dumbbell", "bodyweight"]], ["Just my bodyweight", ["bodyweight"]]] },
  { key: "priority_muscles", q: "Any muscles you especially want to grow?", multi: [["Side delts", ["side-delts"]], ["Chest", ["chest"]], ["Back", ["lats", "upper-back"]], ["Arms", ["biceps", "triceps"]], ["Glutes", ["glutes"]], ["Quads", ["quadriceps"]], ["Abs", ["abs"]]], optional: true, hint: "Optional — we'll give these extra volume." },
  { key: "injuries", q: "Anything we should train around?", multi: [["Lower back", "lower-back"], ["Knee", "knee"], ["Shoulder", "shoulder"], ["Elbow", "elbow"], ["Wrist", "wrist"], ["Hip", "hip"]], optional: true, hint: "Optional — we'll avoid aggravating movements." },
  { key: "units", q: "Pounds or kilograms?", opts: [["Kilograms (kg)", "metric"], ["Pounds (lb)", "imperial"]] },
  { key: "sex", q: "Last one — this just sets sensible starting points.", opts: [["Male", "male"], ["Female", "female"], ["Prefer not to say", "prefer-not-to-say"]] },
];
// Onboarding answers persist to localStorage as they're picked, so a reload or a
// failed submit never makes a nervous first-timer re-answer all eight questions.
const ONB_KEY = "hb_onboarding";
let onbStep = 0, onbStarted = false, answers = {};
try { const s = JSON.parse(localStorage.getItem(ONB_KEY) || "null"); if (s) { answers = s.answers || {}; onbStep = s.onbStep || 0; onbStarted = !!s.onbStarted; } } catch {}
const saveOnb = () => { try { localStorage.setItem(ONB_KEY, JSON.stringify({ answers, onbStep, onbStarted })); } catch {} };

function renderOnboarding() {
  nav.hidden = true;
  if (!onbStarted) {
    app.innerHTML = `<div class="center" style="padding-top:14vh">
      <h1>The Hypertrophy Bible</h1>
      <p>Build muscle, the proven way.<br>I'll be your coach — you just show up.</p>
      <button class="btn" id="go">Start</button>
      <p class="muted">Free · no ads · no account needed</p>
      <button class="btn ghost" id="restore">Already have progress saved? Restore it</button>
      <div id="restorebox" hidden style="margin-top:6px">
        <input id="remail" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com"
          style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:0 0 8px">
        <button class="btn secondary" id="sendrestore">Email me a restore link</button>
        <p class="muted" id="rmsg"></p></div></div>`;
    $("#go").onclick = () => { onbStarted = true; onbStep = 0; saveOnb(); renderOnboarding(); };
    $("#restore").onclick = () => { const b = $("#restorebox"); b.hidden = !b.hidden; if (!b.hidden) $("#remail").focus(); };
    $("#sendrestore").onclick = async () => {
      const val = $("#remail").value.trim();
      if (!val) { $("#rmsg").textContent = "Enter your email first."; return; }
      $("#sendrestore").disabled = true; $("#rmsg").textContent = "Sending…";
      const r = await api("/api/auth/request", { method: "POST", body: JSON.stringify({ email: val }) });
      if (r.error === "invalid-email") { $("#rmsg").textContent = "That doesn't look like an email."; $("#sendrestore").disabled = false; return; }
      if (r.sent === false) { $("#rmsg").textContent = "Couldn't send right now — try again in a moment."; $("#sendrestore").disabled = false; return; }
      $("#rmsg").innerHTML = "If that email has a backup, a restore link is on its way — it works once and expires in 30 minutes."
        + (r.dev_link ? ` <a href="${esc(r.dev_link)}">[dev link]</a>` : "");
    };
    return;
  }
  const step = STEPS[onbStep];
  const dots = STEPS.map((_, i) => `<i class="${i <= onbStep ? "on" : ""}"></i>`).join("");
  let body;
  if (step.stepper) {
    const st = step.stepper;
    const v = answers[step.key] ?? st.def;
    body = `<div class="stepper"><button data-d="-1">–</button><div class="val" id="sv">${v}${st.unit || ""}</div><button data-d="1">+</button></div>
      <p class="muted center">${st.hint}</p><button class="btn" id="next">Continue</button>`;
  } else if (step.multi) {
    const sel = new Set((answers[step.key] || []).map((x) => JSON.stringify(x)));
    body = step.multi.map((o, i) => `<button class="choice${sel.has(JSON.stringify(o[1])) ? " sel" : ""}" data-i="${i}">${esc(o[0])}</button>`).join("")
      + `<p class="muted center">${step.hint || ""}</p><button class="btn" id="next">Continue</button>`;
  } else {
    // Highlight the previously chosen option (when returning via Back) so it's clear
    // what you'd picked; tapping any option still advances immediately.
    const chosen = JSON.stringify(answers[step.key]);
    body = step.opts.map((o, i) => `<button class="choice${JSON.stringify(o[1]) === chosen ? " sel" : ""}" data-i="${i}">${esc(o[0])}<span>›</span></button>`).join("");
  }
  app.innerHTML = `<div class="dots">${dots}</div><h1>${esc(step.q)}</h1>${body}
    <button class="btn ghost" id="onb-back">‹ Back</button>`;
  if (step.stepper) {
    const st = step.stepper;
    let v = answers[step.key] ?? st.def;
    app.querySelectorAll("[data-d]").forEach((b) => b.onclick = () => {
      v = Math.max(st.min, Math.min(st.max, v + (+b.dataset.d) * (st.step || 1))); $("#sv").textContent = v + (st.unit || ""); answers[step.key] = v; saveOnb();
    });
    answers[step.key] = v;
    $("#next").onclick = advance;
  } else if (step.multi) {
    answers[step.key] = answers[step.key] || [];
    app.querySelectorAll(".choice").forEach((b) => b.onclick = () => {
      const val = step.multi[+b.dataset.i][1], k = JSON.stringify(val);
      const cur = answers[step.key].map((x) => JSON.stringify(x));
      const idx = cur.indexOf(k);
      if (idx >= 0) answers[step.key].splice(idx, 1); else answers[step.key].push(val);
      b.classList.toggle("sel"); saveOnb();
    });
    $("#next").onclick = advance;
  } else {
    app.querySelectorAll(".choice").forEach((b) => b.onclick = () => { answers[step.key] = step.opts[+b.dataset.i][1]; saveOnb(); advance(); });
  }
  $("#onb-back").onclick = onbBack;
}
// A misclick is always recoverable: step back one question (or to the welcome
// screen from the first), with prior answers preserved and re-highlighted.
function onbBack() {
  if (onbStep === 0) { onbStarted = false; saveOnb(); return renderOnboarding(); }
  onbStep--; saveOnb();
  renderOnboarding();
}
async function advance() {
  if (onbStep < STEPS.length - 1) { onbStep++; saveOnb(); return renderOnboarding(); }
  await submitOnboarding();
}
async function submitOnboarding() {
  app.innerHTML = `<div class="center" style="padding-top:20vh"><h1>Building your plan…</h1></div>`;
  const priority = [...new Set((answers.priority_muscles || []).flat())];
  const injuries = (answers.injuries || []).map((region) => ({ region, severity: "moderate" }));
  const profile = {
    training_status: answers.training_status, primary_goal: answers.primary_goal,
    days_per_week: answers.days_per_week, session_length_min: answers.session_length_min,
    available_equipment: answers.available_equipment, priority_muscles: priority,
    injuries, sex: answers.sex, units: answers.units || "metric",
  };
  localStorage.setItem("hb_units", profile.units); // remember display preference
  let res;
  try { res = await api("/api/onboard", { method: "POST", body: JSON.stringify({ profile }) }); }
  catch { res = {}; }
  if (res.user_id) {
    uid = res.user_id; localStorage.setItem("hb_user", uid); localStorage.setItem("hb_program", res.program.name);
    localStorage.removeItem(ONB_KEY); // answers safely handed off; stop persisting them
    return renderPlanExplain(true);
  }
  // Retry in place — never discard the eight answers the user just gave.
  app.innerHTML = `<div class="center" style="padding-top:16vh"><h1>Hmm — that didn't go through.</h1>
    <p>Your answers are safe. Let's try again.</p>
    <button class="btn" id="retryonb">Try again</button>
    <button class="btn ghost" id="backonb">‹ Back to the last question</button></div>`;
  $("#retryonb").onclick = submitOnboarding;
  $("#backonb").onclick = () => { onbStep = STEPS.length - 1; renderOnboarding(); };
}

// The coach explaining the plan before the first workout: split reasoning,
// per-muscle weekly volume vs the KB landmarks, and honest heads-ups.
const titleCase = (id) => String(id).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const STATUS_LEGEND = `<p class="muted legend"><b>What the tags mean:</b>
  <span class="status s-below">add volume</span> below the useful range ·
  <span class="status s-in">on target</span> the sweet spot ·
  <span class="status s-near">near max</span> plenty ·
  <span class="status s-over">over max</span> more than you can recover from.<br>
  <b>Grade A–D</b> shows how strong the science behind a number is — A is the strongest evidence, D is a sensible best-guess.</p>`;
async function renderPlanExplain(firstTime) {
  nav.hidden = !!firstTime;
  app.innerHTML = `<p class="muted">Loading your plan…</p>`;
  let d;
  try { d = await api(`/api/plan/explain`); if (!d || d.error) throw new Error("no plan"); }
  catch {
    app.innerHTML = `<div class="center" style="padding-top:14vh"><h1>Couldn't load your plan</h1>
      <p>It's saved safely — this is just a connection hiccup.</p>
      <button class="btn" id="retry-plan">Try again</button></div>`;
    $("#retry-plan").onclick = () => renderPlanExplain(firstTime);
    return;
  }
  const r = d.rationale || {};
  const gradeChip = (g) => g ? `<span class="chip">Grade ${g}</span>` : "";
  const vols = Object.entries(r.volume_by_muscle || {}).filter(([, v]) => v.frequency > 0 && v.projected_sets > 0).sort((a, b) => b[1].projected_sets - a[1].projected_sets);
  const volRows = vols.map(([m, v]) => `<div class="row"><div style="flex:1"><b>${esc(cap(friendlyMuscle(m)))}</b> <span class="muted">${v.projected_sets} sets/wk${v.is_priority ? " · priority" : ""}</span>
      <div class="bar"><i style="width:${Math.min(100, (v.projected_sets / 24) * 100)}%;background:var(--accent)"></i></div>
      <span class="muted" style="font-size:.82rem">${esc((v.reasons || []).join(" · "))} ${gradeChip(v.landmark?.evidence_grade)}</span></div>
      <span class="status ${statusClass(v.projected_status)}">${statusLabel(v.projected_status)}</span></div>`).join("");
  const warns = (r.warnings || []).map((w) => `<div class="win">ℹ️ ${esc(w.message)}</div>`).join("");
  const sessions = d.program?.sessions || [];
  const sessionRows = sessions.map((s) => `<div class="row"><div style="flex:1"><b>${esc(s.name)}</b></div>
    <span class="muted">${s.exercises.length} exercise${s.exercises.length === 1 ? "" : "s"}</span></div>`).join("");
  const whyBlock = `<details class="why"><summary>Why this plan? <span class="muted">(the science)</span></summary>
    <p class="muted" style="margin-top:8px">${esc(r.split?.reason || "")} ${gradeChip("B")}</p>
    <h3>Weekly sets per muscle</h3>
    <div class="card">${volRows || '<p class="muted">—</p>'}</div>
    ${STATUS_LEGEND}
    ${warns ? `<h3>Heads up</h3><div class="card">${warns}</div>` : ""}</details>`;

  if (firstTime) {
    app.innerHTML = `<div class="center"><h1>Your plan is ready 🎉</h1></div>
      <div class="card"><p>Here's your week — <b>${sessions.length} short session${sessions.length === 1 ? "" : "s"}</b>. I chose every exercise, weight, and set for you. You just show up and tap <b>Start</b>.</p></div>
      <div class="card">${sessionRows}</div>
      <div class="card"><b>🚪 Never trained before?</b>
        <p class="muted">These 2-minute reads make your first day easy.</p>
        <button class="btn secondary" data-learn="your-first-session">Your first session — a walkthrough</button>
        <button class="btn secondary" data-learn="how-to-read-a-workout">How to read a workout</button></div>
      ${whyBlock}
      <button class="btn" id="explain-go">Start training</button>`;
  } else {
    app.innerHTML = `<h1>Your plan</h1>
      <div class="card"><div class="big">${esc(d.program?.name || "Your program")}</div></div>
      <div class="card">${sessionRows}</div>
      ${whyBlock}
      <button class="btn secondary" id="edit-plan">Edit &amp; review my plan</button>
      <button class="btn" id="explain-go">Back</button>`;
    $("#edit-plan").onclick = renderPlanEdit;
  }
  wireLearnLinks();
  $("#explain-go").onclick = () => { tab = firstTime ? "today" : "me"; render(); };
}

// ---------- Custom plan builder + KB critique ----------
let editState = null, allExercises = [], pendingRm = null;
const exName = (id) => (allExercises.find((e) => e.id === id) || {}).name || id;
const poolFor = (id) => { const ex = allExercises.find((e) => e.id === id); const ms = ex ? ex.primary_muscles : []; return allExercises.filter((e) => e.primary_muscles.some((m) => ms.includes(m))); };
async function renderPlanEdit() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  const [d, exs] = await Promise.all([api(`/api/plan/explain`), api(`/api/exercises`)]);
  allExercises = exs;
  editState = { name: d.program.name, sessions: JSON.parse(JSON.stringify(d.program.sessions || [])) };
  pendingRm = null;
  // show the current plan's critique straight away
  const crit = await api(`/api/plan/critique`, { method: "POST", body: JSON.stringify({ user_id: uid }) });
  drawEdit(crit);
}
function drawEdit(critique) {
  const sessions = editState.sessions.map((s, si) => `<div class="card"><b>${esc(s.name)}</b>
    ${s.exercises.map((e, ei) => `<div class="row" data-si="${si}" data-ei="${ei}">
      <div style="flex:1"><b>${esc(exName(e.exercise))}</b> <span class="muted">${e.sets} × ${esc(e.rep_range)} reps</span></div>
      <button class="tapchip" data-act="dec" aria-label="fewer sets">−</button><button class="tapchip" data-act="inc" aria-label="more sets">+</button>
      <button class="tapchip" data-act="swap">swap</button>
      <button class="tapchip ${pendingRm === si + "-" + ei ? "danger" : ""}" data-act="rm">${pendingRm === si + "-" + ei ? "Remove?" : "✕"}</button></div>`).join("")}
    <button class="btn ghost" data-add="${si}">+ Add exercise</button></div>`).join("");
  const crit = critique ? `<div class="card"><b>🧭 ${esc(critique.summary)}</b>${(critique.findings || []).map((f) => `<div class="win">${f.severity === "warn" ? "⚠️" : "💡"} ${esc(f.msg)}</div>`).join("")}</div>` : "";
  app.innerHTML = `<h1>Edit &amp; review</h1>${crit}${sessions}
    <button class="btn" id="savePlan">Save &amp; re-check</button>
    <button class="btn ghost" id="backPlan">Done</button>`;
  app.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => {
    const row = b.closest("[data-si]"), si = +row.dataset.si, ei = +row.dataset.ei, ex = editState.sessions[si].exercises[ei];
    const act = b.dataset.act;
    if (act === "rm") {
      // Two-tap confirm so a fat-finger never deletes an exercise outright.
      const key = si + "-" + ei;
      if (pendingRm === key) { editState.sessions[si].exercises.splice(ei, 1); pendingRm = null; }
      else pendingRm = key;
    } else {
      pendingRm = null; // any other action cancels a pending removal
      if (act === "inc") ex.sets = Math.min(10, ex.sets + 1);
      else if (act === "dec") ex.sets = Math.max(1, ex.sets - 1);
      else if (act === "swap") { const pool = poolFor(ex.exercise); if (pool.length > 1) { const cur = pool.findIndex((p) => p.id === ex.exercise); ex.exercise = pool[(cur + 1) % pool.length].id; } }
    }
    drawEdit(critique);
  });
  app.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => renderAddExercise(+b.dataset.add));
  $("#savePlan").onclick = async () => { const r = await api(`/api/plan/save`, { method: "POST", body: JSON.stringify({ user_id: uid, program: editState }) }); if (r.ok) { localStorage.setItem("hb_program", editState.name); drawEdit(r.critique); } };
  $("#backPlan").onclick = () => { tab = "today"; render(); };
}
function renderAddExercise(si) {
  const list = allExercises.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `<button class="choice" data-add-id="${e.id}">${esc(e.name)} <span class="muted">${e.primary_muscles.map(titleCase).join(", ")}${e.custom ? " · yours" : ""}</span></button>`).join("");
  app.innerHTML = `<h1>Add exercise</h1>
    <button class="btn secondary" id="newEx">+ Create a new exercise</button>
    <div class="card" style="max-height:62vh;overflow:auto">${list}</div><button class="btn ghost" id="cancelAdd">Cancel</button>`;
  app.querySelectorAll("[data-add-id]").forEach((b) => b.onclick = () => { editState.sessions[si].exercises.push({ exercise: b.dataset.addId, sets: 3, rep_range: "8-12" }); drawEdit(null); });
  $("#newEx").onclick = () => renderCustomExercise(si);
  $("#cancelAdd").onclick = () => drawEdit(null);
}
// Author a brand-new exercise into the user's personal library.
function renderCustomExercise(si) {
  const muscles = [...new Set(allExercises.flatMap((e) => e.primary_muscles))].sort();
  const st = { name: "", muscle: muscles[0], equipment: "dumbbell", mechanic: "isolation" };
  const chip = (val, cur, attr) => `<button class="chip" data-${attr}="${val}" style="${cur === val ? "background:var(--accent);color:#06210f;border-color:var(--accent)" : ""}">${attr === "m" ? titleCase(val) : val}</button>`;
  const draw = () => {
    app.innerHTML = `<h1>New exercise</h1><div class="card">
      <input id="cx-name" placeholder="Exercise name" value="${esc(st.name)}" style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin-bottom:12px">
      <p class="muted">Primary muscle</p><div style="margin-bottom:12px">${muscles.map((m) => chip(m, st.muscle, "m")).join(" ")}</div>
      <p class="muted">Equipment</p><div style="margin-bottom:12px">${["barbell", "dumbbell", "machine", "cable", "bodyweight", "other"].map((e) => chip(e, st.equipment, "e")).join(" ")}</div>
      <p class="muted">Type</p><div>${["compound", "isolation"].map((mm) => chip(mm, st.mechanic, "mech")).join(" ")}</div></div>
      <button class="btn" id="cx-save">Add to my library</button>
      <button class="btn ghost" id="cx-cancel">Cancel</button><p class="muted" id="cx-msg"></p>`;
    $("#cx-name").oninput = (e) => { st.name = e.target.value; };
    app.querySelectorAll("[data-m]").forEach((b) => b.onclick = () => { st.muscle = b.dataset.m; draw(); });
    app.querySelectorAll("[data-e]").forEach((b) => b.onclick = () => { st.equipment = b.dataset.e; draw(); });
    app.querySelectorAll("[data-mech]").forEach((b) => b.onclick = () => { st.mechanic = b.dataset.mech; draw(); });
    $("#cx-save").onclick = async () => {
      if (!st.name.trim()) { $("#cx-msg").textContent = "Give it a name first."; return; }
      const r = await api(`/api/exercise/custom`, { method: "POST", body: JSON.stringify({ user_id: uid, exercise: { name: st.name.trim(), primary_muscles: [st.muscle], equipment: st.equipment, mechanic: st.mechanic } }) });
      if (r.error) { $("#cx-msg").textContent = r.error; return; }
      allExercises = await api(`/api/exercises`);
      editState.sessions[si].exercises.push({ exercise: r.exercise.id, sets: 3, rep_range: "8-12" });
      drawEdit(null);
    };
    $("#cx-cancel").onclick = () => renderAddExercise(si);
  };
  draw();
}

// ---------- Today ----------
async function renderToday() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let data, adh;
  try { [data, adh] = await Promise.all([api(`/api/today`), api(`/api/adherence`)]); }
  catch {
    app.innerHTML = `<h1>Today</h1><div class="card"><p>📴 You're offline.</p>
      <p class="muted">Connect once to load today's plan — anything you've already logged will sync automatically.</p></div>`;
    return;
  }
  const s = data.session;
  // Streak + level header, and the motivational state (loss-aversion when at risk,
  // warm welcome on a comeback, calm reassurance when paused).
  const st = adh.status || {};
  const icon = { "at-risk": "⚠️", comeback: "👋", paused: "⏸️", new: "🌱" }[st.state] || "";
  const header = `<div class="card row"><div style="flex:1"><b>🔥 ${adh.streak_weeks} week${adh.streak_weeks === 1 ? "" : "s"} strong</b>
      <div class="bar" style="margin-top:6px"><i style="width:${adh.level_progress_pct}%;background:var(--accent)"></i></div>
      <span class="muted" style="font-size:.82rem">Level ${adh.level} · ${adh.xp} XP · ${adh.xp_to_next} to next</span></div>
      <span class="chip" style="font-size:1rem">Lv ${adh.level}</span></div>
    ${st.state && st.state !== "on-track" && st.message ? `<div class="card"><p>${icon} ${esc(st.message)}</p></div>` : ""}`;
  const list = s.exercises.map((e) => `<div class="row"><div><b>${esc(e.name)}</b><br><span class="muted">${e.sets} sets × ${esc(e.rep_range)} reps · works ${esc(friendlyMuscles(e.primary_muscles))}</span></div></div>`).join("");
  // No check-in yet today → gently offer one; otherwise surface the readiness note.
  const readinessCard = s.readiness == null
    ? `<div class="card"><b>How are you feeling today?</b>
        <p class="muted">A 15-second check-in lets me tune today's session. Optional.</p>
        <button class="btn secondary" id="checkin">Quick check-in</button></div>`
    : (s.coach_note ? `<div class="card"><p>🧭 ${esc(s.coach_note)}</p></div>` : "");
  // A brand-new lifter's very first session gets a reassuring walkthrough up top.
  const firstTimer = s.day_number === 1
    ? `<div class="card"><b>👋 First workout? You've got this.</b>
        <p class="muted">Here's exactly how a session goes — arrive, warm up, find a comfy weight, do your sets. A 2-minute read makes the whole thing easy.</p>
        <button class="btn secondary" data-learn="your-first-session">Read: Your first session</button></div>`
    : "";
  app.innerHTML = `<h1>Today</h1>${header}${firstTimer}${readinessCard}
    <div class="card"><div class="big">${esc(s.name)}</div>
      <p class="muted">${esc(s.program_name)} · day ${s.day_number} · ${s.exercises.length} exercises</p>
      <button class="btn" id="start">Start workout</button></div>
    <h2>What you'll do ${helpDot("how-to-read-a-workout", "ⓘ how to read this")}</h2><div class="card">${list}</div>`;
  $("#start").onclick = () => startSession(s);
  if (s.readiness == null) $("#checkin").onclick = renderCheckin;
  wireLearnLinks();
}

// Optional daily check-in survey — four 1-5 taps; low readiness eases today.
function renderCheckin() {
  const fields = [["sleep_quality", "Sleep quality"], ["energy", "Energy"], ["stress", "Stress"], ["mood", "Mood"]];
  const vals = { sleep_quality: 3, energy: 3, stress: 3, mood: 3 };
  const draw = () => {
    const row = ([key, label]) => `<div class="ckrow"><span class="cklabel">${label}</span><div class="ckscale">${[1, 2, 3, 4, 5].map((n) =>
      `<button class="tapchip${vals[key] === n ? " sel" : ""}" data-k="${key}" data-v="${n}">${n}</button>`).join("")}</div></div>`;
    app.innerHTML = `<h1>Quick check-in</h1><p class="muted">Tap 1 to 5 for each — <b>1 = low, 5 = great</b>. This just tunes today; it's never a score or a judgment.</p>
      <div class="card">${fields.map(row).join("")}</div>
      <button class="btn" id="submitck">Save</button>
      <button class="btn ghost" id="skipck">Skip today</button>`;
    app.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => { vals[b.dataset.k] = +b.dataset.v; draw(); });
    $("#submitck").onclick = async () => { await api("/api/checkin", { method: "POST", body: JSON.stringify({ user_id: uid, ...vals }) }); tab = "today"; render(); };
    $("#skipck").onclick = () => { tab = "today"; render(); };
  };
  draw();
}

// ---------- Session Player ----------
let sess = null;
const rirOn = () => localStorage.getItem("hb_rir") === "1"; // optional effort logging
function startSession(templateSession) {
  sess = { name: templateSession.name, ex: templateSession.exercises, i: 0, set: 0, logged: [], weights: {}, reps: {}, rir: {} };
  renderPlayer();
}
function startWeightDefault(e) {
  if (e.suggested_kg != null) return e.suggested_kg;
  // Brand-new lift → start at the empty bar / lightest option and ramp UP from
  // there. Never hand a first-timer a heavy guess (that's how form breaks).
  return { barbell: 20, dumbbell: 5, machine: 10, cable: 5, bodyweight: 0 }[e.equipment] ?? 10;
}
function topReps(range) { const m = String(range).match(/-(\d+)/); return m ? +m[1] : 10; }

function renderPlayer(resting = 0) {
  const e = sess.ex[sess.i];
  const total = sess.ex.length;
  // sess.weights holds DISPLAY-unit values; converted to kg only when logged.
  if (sess.weights[sess.i] == null) sess.weights[sess.i] = dispWeight(startWeightDefault(e));
  if (sess.reps[sess.i] == null) sess.reps[sess.i] = topReps(e.rep_range);
  if (sess.rir[sess.i] == null) sess.rir[sess.i] = 2;
  const w = sess.weights[sess.i], reps = sess.reps[sess.i], rir = sess.rir[sess.i];
  const setDots = Array.from({ length: e.sets }, (_, k) => `<i class="${k < sess.set ? "done" : ""}"></i>`).join("");

  if (resting > 0) {
    app.innerHTML = `<div class="center"><p class="muted">Rest</p><div class="timer" id="t">${resting}</div>
      <p class="muted">Next: set ${sess.set + 1} of ${e.sets} — ${esc(e.name)}</p>
      <button class="btn" id="skip">I'm ready</button></div>`;
    let left = resting;
    const iv = setInterval(() => { left--; if ($("#t")) $("#t").textContent = left; if (left <= 0) { clearInterval(iv); renderPlayer(0); } }, 1000);
    $("#skip").onclick = () => { clearInterval(iv); renderPlayer(0); };
    return;
  }

  const firstEver = e.suggested_kg == null && sess.set === 0;
  app.innerHTML = `<div class="exhead"><h1>${esc(e.name)}</h1><span class="num">${sess.i + 1}/${total}</span></div>
    <p class="muted">Target: ${e.sets} sets × ${e.rep_range} reps · leave about ${e.rir} in the tank ${helpDot("glossary", "what's RIR?")}</p>
    <div class="setdots">${setDots}</div>
    ${sess.i === 0 && sess.set === 0 ? `<div class="cue">🔥 Warm up first: 3–5 min of easy movement, then a couple of light ramp-up sets before your working sets.</div>` : ""}
    ${e.cue ? `<div class="cue">💡 ${esc(e.cue)}</div>` : ""}
    ${firstEver ? `<div class="card info"><b>New lift — let's find your weight 🎯</b>
      <p class="muted">Start light and add a little each set until the last rep is hard but clean (about ${e.rir} left in the tank). A couple of easy ramp-up sets first isn't wasted — it's how you find your number, and it's saved for next time.</p>
      <button class="btn ghost" data-learn="choosing-your-starting-weight">How to pick your starting weight</button></div>` : ""}
    <div class="card">
      <div class="stepper"><label>Weight</label><button data-w="-${wInc()}" aria-label="less weight">–</button><div class="val">${w} ${unitLabel()}</div><button data-w="${wInc()}" aria-label="more weight">+</button></div>
      <div class="stepper"><label>Reps</label><button data-r="-1" aria-label="fewer reps">–</button><div class="val">${reps}</div><button data-r="1" aria-label="more reps">+</button></div>
      ${rirOn() ? `<div class="stepper"><label>RIR</label><button data-rir="-1">–</button><div class="val">${rir}</div><button data-rir="1">+</button></div>
        <p class="muted">RIR = reps left in the tank. 2 = you could've done ~2 more.</p>` : ""}
      <button class="btn" id="done">Done — set ${sess.set + 1} of ${e.sets}</button>
    </div>
    <button class="btn ghost" id="how">How do I do this?</button>
    <button class="btn ghost" id="quit">End workout early</button>`;
  wireLearnLinks();

  app.querySelectorAll("[data-w]").forEach((b) => b.onclick = () => { sess.weights[sess.i] = Math.max(0, Math.round((sess.weights[sess.i] + +b.dataset.w) * 4) / 4); renderPlayer(); });
  app.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { sess.reps[sess.i] = Math.max(0, sess.reps[sess.i] + +b.dataset.r); renderPlayer(); });
  app.querySelectorAll("[data-rir]").forEach((b) => b.onclick = () => { sess.rir[sess.i] = Math.max(0, Math.min(5, sess.rir[sess.i] + +b.dataset.rir)); renderPlayer(); });
  $("#how").onclick = async () => {
    let d = null;
    try { d = await api(`/api/exercise/${e.exercise}`); } catch {}
    renderExerciseSheet(e, d);
  };
  $("#quit").onclick = finish;
  $("#done").onclick = () => {
    sess.logged.push({ exercise: e.exercise, set_type: "work", weight_kg: toKg(w), reps, ...(rirOn() ? { rir } : {}), completed_at: new Date().toISOString() });
    sess.set++;
    if (sess.set >= e.sets) {
      sess.set = 0; sess.i++;
      if (sess.i >= total) return finish();
      renderPlayer(0);
    } else {
      renderPlayer(120); // rest timer
    }
  };
}
// The "how do I do this?" sheet: full cues + mistakes from the KB, and a form-
// video search — an honest stand-in until we have vetted demo media of our own.
function renderExerciseSheet(ex, d) {
  const name = d?.name ?? ex.name;
  const cues = (d?.cues ?? []).map((c) => `<div class="win">✅ ${esc(c)}</div>`).join("") || `<p class="muted">No cues on file for this one.</p>`;
  const errs = (d?.common_errors ?? []).map((c) => `<div class="win">⚠️ ${esc(c)}</div>`).join("");
  const muscles = friendlyMuscles([...(d?.primary_muscles ?? []), ...(d?.secondary_muscles ?? [])]);
  const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(name + " proper form")}`;
  app.innerHTML = `<h1>${esc(name)}</h1>
    ${muscles ? `<p class="muted">Works: ${esc(muscles)}</p>` : ""}
    <h2>How to do it</h2>${cues}
    ${errs ? `<h2>Avoid</h2>${errs}` : ""}
    <p class="muted">Want to see it? This opens a YouTube search in a new tab — pick a clear, calm demo (avoid ego-lifting clips).</p>
    <a class="btn secondary" style="text-align:center;text-decoration:none;display:block" href="${yt}" target="_blank" rel="noopener">▶ Find a form video</a>
    <button class="btn" id="back">Back to workout</button>`;
  $("#back").onclick = () => renderPlayer(0);
}

async function finish() {
  if (!sess.logged.length) { sess = null; return render(); }
  app.innerHTML = `<div class="center" style="padding-top:20vh"><h1>Saving…</h1></div>`;
  // Client-generated id + real time so a queued replay is idempotent (server
  // ignores a duplicate session_id) and buckets by when the workout happened.
  const session_id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await postOrQueue("/api/session", { session_id, date: new Date().toISOString(), user_id: uid, session_name: sess.name, sets: sess.logged });
  renderRecap(res.ok ? res.data : { wins: ["📴 You're offline — workout saved on this phone. It'll sync automatically when you're back online."] });
  sess = null;
}
function renderRecap(recap) {
  const wins = (recap.wins || []).map((w) => `<div class="win">${esc(w)}</div>`).join("");
  const nudge = !localStorage.getItem("hb_email")
    ? `<div class="card"><b>Back up your progress</b>
        <p class="muted">Save it to an email so you never lose it — no password, no account wall.</p>
        <button class="btn secondary" id="backup">Back up now</button></div>`
    : "";
  // Post-value support nudge (per docs/donation-page.md): only after a real
  // milestone (~a month at 3x/week), always skippable, dormant until a real
  // donation destination exists.
  const donate = DONATE_URL && recap.day_number && recap.day_number % 12 === 0
    ? `<div class="card"><p>🎉 That's about a month of training logged. This app is free and always will be — if it's been useful, you can chip in any amount. Totally optional.</p>
        <a class="btn secondary" style="text-align:center;text-decoration:none;display:block" href="${DONATE_URL}" target="_blank" rel="noopener">Support the project</a></div>`
    : "";
  const title = recap.day_number ? `Session ${recap.day_number} done 💪` : "Workout done 💪";
  app.innerHTML = `<div class="center"><h1>${title}</h1></div>${wins}${nudge}${donate}
    <button class="btn" id="ok">Done</button>`;
  if (nudge) $("#backup").onclick = () => { tab = "me"; render(); };
  $("#ok").onclick = () => { tab = "today"; render(); };
}

// ---------- Progress ----------
const statusClass = (s) => ({ "below-MEV": "s-below", "in-productive-range": "s-in", "approaching-MRV": "s-near", "over-MRV": "s-over" }[s] || "s-none");
const statusLabel = (s) => ({ "below-MEV": "add volume", "in-productive-range": "on target", "approaching-MRV": "near max", "over-MRV": "over max", "no-landmark": "—" }[s] || s);
async function renderProgress() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let p;
  try { p = await api(`/api/progress`); }
  catch {
    app.innerHTML = `<h1>Progress</h1><div class="card"><p>📴 You're offline.</p>
      <p class="muted">Your progress will load when you're back online. Anything logged offline is saved and will sync.</p></div>`;
    return;
  }
  const vol = (p.volumeByMuscle || []).map((m) => {
    const pct = Math.min(100, (m.sets / 24) * 100);
    return `<div class="row"><div style="flex:1"><b>${esc(m.muscle)}</b> <span class="muted">${m.sets} set${m.sets === 1 ? "" : "s"}/wk</span>
      <div class="bar"><i style="width:${pct}%;background:var(--accent)"></i></div></div>
      <span class="status ${statusClass(m.status)}">${statusLabel(m.status)}</span></div>`;
  }).join("") || `<p class="muted">Log a workout to see your weekly volume.</p>`;
  const prog = (p.progression || []).map((x) => `<div class="row"><b>${esc(x.name)}</b><span class="${x.change_pct >= 0 ? "" : "muted"}">${dispWeight(x.first_e1rm)}→${dispWeight(x.last_e1rm)} ${unitLabel()} (${x.change_pct >= 0 ? "+" : ""}${x.change_pct}%)</span></div>`).join("") || `<p class="muted">Two weeks of data unlocks strength trends.</p>`;
  const t = p.bodyweight_trend;
  const slopeDisp = t ? (unitPref() === "lb" ? Math.round(t.slope_kg_per_week * LB_PER_KG * 100) / 100 : t.slope_kg_per_week) : 0;
  const eb = p.energy_balance || {};
  app.innerHTML = `<h1>Progress</h1>
    <div class="card"><b>${p.sessions_logged}</b> <span class="muted">session${p.sessions_logged === 1 ? "" : "s"} logged</span></div>
    <h2>Weekly sets per muscle ${helpDot("glossary", "?")}</h2>
    <p class="muted">How many hard sets each muscle got this week, and whether that's in the range that builds muscle.</p>
    <div class="card">${vol}</div>
    ${p.volumeByMuscle && p.volumeByMuscle.length ? STATUS_LEGEND : ""}
    <h2>Your best lifts (estimated) ${helpDot("glossary", "?")}</h2>
    <p class="muted">The most you could likely lift for one rep, estimated from your sets. Watch the trend, not the exact number.</p>
    <div class="card">${prog}</div>
    <h2>Bodyweight & energy balance</h2>
    <div class="card">
      ${t ? `<p><b>${slopeDisp >= 0 ? "+" : ""}${slopeDisp} ${unitLabel()}/week</b> <span class="muted">(${t.pct_per_week}%/wk)</span></p>
        <p class="muted">${esc(eb.suggestion || "")}</p>` : `<p class="muted">Add a few bodyweights to infer your energy balance — no calorie counting needed.</p>`}
      <div class="stepper"><label>Log weight</label><input id="bw" type="number" step="0.1" inputmode="decimal" placeholder="${unitLabel()}" style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.1rem"></div>
      <button class="btn secondary" id="logbw">Add today's weight</button>
    </div>`;
  wireLearnLinks();
  $("#logbw").onclick = async () => {
    const val = parseFloat($("#bw").value); if (!val) return;
    const kg = toKg(val);
    // Send today's date at log time so an offline weigh-in keeps its real date and
    // a replayed POST replaces the same-day row instead of duplicating it.
    const res = await postOrQueue("/api/bodyweight", { user_id: uid, kg, date: new Date().toISOString().slice(0, 10) });
    if (res.ok) return renderProgress();
    $("#bw").value = "";
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "📴 Saved offline — it'll sync when you're back online.";
    $("#logbw").after(note);
  };
}

// ---------- Me ----------
function renderMe() {
  const email = localStorage.getItem("hb_email");
  const backup = email
    ? `<div class="card"><p class="muted">Backed up</p><b>${esc(email)}</b>
        <p class="muted" style="margin-top:8px">On another device, open the app and enter this same email to load your progress there.</p></div>`
    : `<div class="card"><p class="muted">Back up &amp; sync</p>
        <p>Save your progress to an email so you never lose it — and to pick up on another phone or computer. No password.</p>
        <input id="bemail" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com"
          style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:8px 0 4px">
        <button class="btn" id="sendlink">Send me a link</button>
        <p class="muted" id="bmsg"></p></div>`;
  // "How this is funded" — informational, always reachable, never a gate
  // (copy per docs/donation-page.md; support button appears only when a real
  // donation destination is configured).
  const funded = `<div class="card"><p class="muted">How this is funded</p>
    <p>This is a not-for-profit passion project: <b>open-source, no ads, no premium tier, no selling your data.</b> Every claim in it is backed by a real study.</p>
    <p class="muted">What it costs: right now, roughly the price of a domain name — most of it runs on free infrastructure. I cover it myself and put anything received straight back into the project. You get the exact same app either way.</p>
    ${DONATE_URL
      ? `<a class="btn secondary" style="text-align:center;text-decoration:none;display:block" href="${DONATE_URL}" target="_blank" rel="noopener">Support the project</a>`
      : `<p class="muted">Donations aren't set up yet — just enjoy the app.</p>`}
  </div>`;
  app.innerHTML = `<h1>Me</h1>
    <div class="card"><p class="muted">Program</p><b>${esc(localStorage.getItem("hb_program") || "—")}</b>
      <button class="btn secondary" id="viewplan" style="margin-top:10px">View my plan &amp; why</button></div>
    <div class="card"><p class="muted">Effort logging (RIR)</p>
      <p><b>RIR = reps in reserve</b> — how many more reps you could have done before failing. Stop a couple short of failure; that's a hard set, not a max effort.</p>
      <p class="muted">Turn this on to log RIR each set so the coach fine-tunes your weights. Off by default — simple progression works great, especially for beginners.</p>
      <button class="btn secondary" id="rirtoggle">${rirOn() ? "On — tap to turn off" : "Off — tap to turn on"}</button></div>
    <div class="card"><p class="muted">Units</p>
      <p>Weights show in <b>${unitPref() === "lb" ? "pounds (lb)" : "kilograms (kg)"}</b>.</p>
      <button class="btn secondary" id="unittoggle">Switch to ${unitPref() === "lb" ? "kg" : "lb"}</button></div>
    ${backup}
    ${funded}
    <button class="btn ghost" id="reset">Reset (start over)</button>`;
  $("#viewplan").onclick = () => renderPlanExplain(false);
  $("#rirtoggle").onclick = () => { localStorage.setItem("hb_rir", rirOn() ? "0" : "1"); renderMe(); };
  $("#unittoggle").onclick = () => { localStorage.setItem("hb_units", unitPref() === "lb" ? "metric" : "imperial"); renderMe(); };

  if (!email) {
    $("#sendlink").onclick = async () => {
      const val = $("#bemail").value.trim();
      if (!val) { $("#bmsg").textContent = "Enter your email first."; return; }
      $("#sendlink").disabled = true;
      $("#bmsg").textContent = "Sending…";
      const r = await api("/api/auth/request", { method: "POST", body: JSON.stringify({ email: val, user_id: uid }) });
      if (r.error === "invalid-email") { $("#bmsg").textContent = "That doesn't look like an email."; $("#sendlink").disabled = false; return; }
      if (r.sent === false) { $("#bmsg").textContent = "Couldn't send right now — try again in a moment."; $("#sendlink").disabled = false; return; }
      $("#bmsg").innerHTML = "Check your inbox for a link to finish — it works once and expires in 30 minutes."
        + (r.dev_link ? ` <a href="${esc(r.dev_link)}">[dev link]</a>` : "");
    };
  }
  $("#reset").onclick = () => {
    if (confirm("Erase this device's link to your data and start over? If you've backed up to an email, that stays safe and you can restore it.")) {
      localStorage.clear(); uid = null; onbStep = 0; onbStarted = false; for (const k in answers) delete answers[k]; render();
    }
  };
}

// ---------- Coach (adherence & gamification) ----------
function downloadTrainingCalendar(days, time) {
  const ICS_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const [hh, mm] = (time || "18:00").split(":");
  const byday = days.map((d) => ICS_DAYS[d]).join(",");
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hypertrophy Bible//EN", "BEGIN:VEVENT",
    "SUMMARY:🏋️ Training", `DTSTART:20260105T${hh}${mm}00`, "DURATION:PT1H",
    `RRULE:FREQ=WEEKLY;BYDAY=${byday}`, "DESCRIPTION:Your scheduled training session — showing up is the win.", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const a = document.createElement("a"); a.href = url; a.download = "hypertrophy-training.ics"; a.click(); URL.revokeObjectURL(url);
}
async function renderCoach() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let a; try { a = await api(`/api/adherence`); } catch { app.innerHTML = `<h1>Coach</h1><div class="card"><p>📴 Offline.</p></div>`; return; }
  const m = a.milestones || {};
  const badges = (m.reached || []).map((x) => `<span class="chip">✓ ${x.at}</span>`).join(" ");
  const paused = a.paused;
  app.innerHTML = `<h1>Coach</h1>
    <div class="card center">
      <div class="big">🔥 ${a.streak_weeks} week${a.streak_weeks === 1 ? "" : "s"} strong</div>
      <div class="bar" style="margin:12px 0"><i style="width:${a.level_progress_pct}%;background:var(--accent)"></i></div>
      <p class="muted">Level ${a.level} · ${a.xp} XP · ${a.xp_to_next} to level ${a.level + 1}</p>
      <p class="muted">${a.sessions_logged} sessions logged · ${a.week.sessions} this week</p></div>
    ${m.latest ? `<div class="card"><b>🏅 ${esc(m.latest.msg)}</b>${m.next ? `<p class="muted" style="margin-top:8px">Next up: ${esc(m.next.msg)}</p>` : ""}</div>` : ""}
    ${badges ? `<div class="card"><p class="muted">Milestones reached</p>${badges}</div>` : ""}
    <h2>Schedule your sessions</h2>
    <div class="card"><p class="muted">The single biggest lever for consistency: put your sessions in your calendar.</p>
      <div id="days" style="margin:8px 0"></div>
      <div class="stepper"><label>Time</label><input id="sched-time" type="time" value="18:00" style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:1.05rem"></div>
      <button class="btn secondary" id="addcal">Add to my calendar</button>
      <p class="muted" id="calmsg"></p></div>
    <h2>Injury or illness?</h2>
    <div class="card"><p>${paused ? "You're paused — heal up. Your streak is safe and I won't nudge you." : "Pause any time. Nothing's ever at stake — never train through pain or sickness."}</p>
      <button class="btn ${paused ? "" : "secondary"}" id="pause">${paused ? "I'm ready — resume" : "Pause (I'm sick or injured)"}</button></div>`;
  const sel = new Set();
  $("#days").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<button class="tapchip" data-day="${i}">${d}</button>`).join(" ");
  $("#days").querySelectorAll("[data-day]").forEach((b) => b.onclick = () => {
    const i = +b.dataset.day;
    if (sel.has(i)) { sel.delete(i); b.style.background = ""; b.style.color = ""; } else { sel.add(i); b.style.background = "var(--accent)"; b.style.color = "#06210f"; }
  });
  $("#addcal").onclick = () => { if (!sel.size) { $("#calmsg").textContent = "Pick at least one day first."; return; } downloadTrainingCalendar([...sel], $("#sched-time").value); $("#calmsg").textContent = "Calendar file downloaded — open it to add recurring reminders."; };
  $("#pause").onclick = async () => { await api("/api/pause", { method: "POST", body: JSON.stringify({ user_id: uid, on: !paused }) }); renderCoach(); };
}

// ---------- Learn (the beginner on-ramp library, bundled + offline) ----------
function renderLearn() {
  learnSlug = null;
  const cats = LEARN_INDEX.map((c) => `<h2>${esc(c.category)}</h2><div class="card">${
    c.items.map((it) => `<button class="choice" data-learn="${esc(it.slug)}"><span style="flex:1"><b>${esc(it.title)}</b>${it.desc ? `<br><span class="muted">${esc(it.desc)}</span>` : ""}</span><span>›</span></button>`).join("")
  }</div>`).join("");
  app.innerHTML = `<h1>Learn</h1>
    <p class="muted">Never been to a gym? Start at the top and read a couple. Every term, every worry, answered plainly — and it all works offline.</p>${cats}`;
  wireLearnLinks();
  window.scrollTo(0, 0);
}
function renderLearnPage(slug) {
  const pg = LEARN_PAGES[slug];
  if (!pg) { learnSlug = null; return renderLearn(); }
  app.innerHTML = `<button class="btn ghost" id="learnback">‹ All topics</button>
    <h1>${esc(pg.title)}</h1>
    ${pg.tldr ? `<div class="card tldr"><b>In short</b> ${pg.tldr}</div>` : ""}
    <div class="learn">${pg.html}</div>
    <button class="btn ghost" id="learnback2">‹ Back to all topics</button>`;
  $("#learnback").onclick = renderLearn;
  $("#learnback2").onclick = renderLearn;
  wireLearnLinks(); // in-page cross-links between pages
  window.scrollTo(0, 0);
}

// ---------- Router ----------
function render() {
  if (!uid) return renderOnboarding();
  nav.hidden = false;
  nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "today") renderToday();
  else if (tab === "progress") renderProgress();
  else if (tab === "coach") renderCoach();
  else if (tab === "learn") { learnSlug ? renderLearnPage(learnSlug) : renderLearn(); }
  else renderMe();
}
nav.querySelectorAll("button").forEach((b) => b.onclick = () => { tab = b.dataset.tab; if (tab === "learn") learnSlug = null; render(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
flushQueue(); // push any workouts logged offline last time
render();
