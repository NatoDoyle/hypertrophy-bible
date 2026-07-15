// The Hypertrophy Bible — brainless client. One decision per screen; everything
// higher-order is derived server-side. No build step, no framework.
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const nav = $("#nav");
let uid = localStorage.getItem("hb_user");
let tab = "today";

const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  return r.json();
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- Onboarding ----------
const STEPS = [
  { key: "training_status", q: "Have you lifted weights before?", opts: [["New to this", "beginner"], ["About a year in", "intermediate"], ["Several years", "advanced"]] },
  { key: "primary_goal", q: "What do you want most?", opts: [["Build muscle", "hypertrophy"], ["Get stronger", "strength"], ["Lose fat", "fat-loss"], ["A bit of both", "recomposition"]] },
  { key: "days_per_week", q: "How many days a week can you train?", stepper: { min: 2, max: 6, def: 3, hint: "Most beginners grow well on 3." } },
  { key: "available_equipment", q: "Where will you train?", opts: [["A full gym", ["barbell", "dumbbell", "machine", "cable"]], ["Home with dumbbells", ["dumbbell"]], ["Just my bodyweight", ["bodyweight"]]] },
  { key: "sex", q: "One quick thing — this just sets sensible starting points.", opts: [["Male", "male"], ["Female", "female"], ["Prefer not to say", "prefer-not-to-say"]] },
];
let onbStep = 0;
const answers = {};

function renderOnboarding() {
  nav.hidden = true;
  if (onbStep === 0 && !Object.keys(answers).length) {
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
    $("#go").onclick = () => { onbStep = 0; answers._started = true; renderOnboarding(); };
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
    const v = answers[step.key] ?? step.stepper.def;
    body = `<div class="stepper"><button data-d="-1">–</button><div class="val" id="sv">${v}</div><button data-d="1">+</button></div>
      <p class="muted center">${step.stepper.hint}</p><button class="btn" id="next">Continue</button>`;
  } else {
    body = step.opts.map((o, i) => `<button class="choice" data-i="${i}">${esc(o[0])}<span>›</span></button>`).join("");
  }
  app.innerHTML = `<div class="dots">${dots}</div><h1>${esc(step.q)}</h1>${body}`;
  if (step.stepper) {
    let v = answers[step.key] ?? step.stepper.def;
    app.querySelectorAll("[data-d]").forEach((b) => b.onclick = () => {
      v = Math.max(step.stepper.min, Math.min(step.stepper.max, v + +b.dataset.d)); $("#sv").textContent = v; answers[step.key] = v;
    });
    answers[step.key] = v;
    $("#next").onclick = advance;
  } else {
    app.querySelectorAll(".choice").forEach((b) => b.onclick = () => { answers[step.key] = step.opts[+b.dataset.i][1]; advance(); });
  }
}
async function advance() {
  if (onbStep < STEPS.length - 1) { onbStep++; return renderOnboarding(); }
  app.innerHTML = `<div class="center" style="padding-top:20vh"><h1>Building your plan…</h1></div>`;
  const profile = { training_status: answers.training_status, primary_goal: answers.primary_goal, days_per_week: answers.days_per_week, available_equipment: answers.available_equipment, sex: answers.sex, units: "metric" };
  const res = await api("/api/onboard", { method: "POST", body: JSON.stringify({ profile }) });
  if (res.user_id) { uid = res.user_id; localStorage.setItem("hb_user", uid); localStorage.setItem("hb_program", res.program.name); tab = "today"; render(); }
  else app.innerHTML = `<p>Something went wrong. <button class="btn" onclick="location.reload()">Retry</button></p>`;
}

// ---------- Today ----------
async function renderToday() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  const data = await api(`/api/today?u=${uid}`);
  const s = data.session;
  const list = s.exercises.map((e) => `<div class="row"><div><b>${esc(e.name)}</b><br><span class="muted">${e.sets} × ${e.rep_range} · ${(e.primary_muscles || []).join(", ")}</span></div></div>`).join("");
  app.innerHTML = `<h1>Today</h1>
    <div class="card"><div class="big">${esc(s.name)}</div>
      <p class="muted">${esc(s.program_name)} · day ${s.day_number} · ${s.exercises.length} exercises</p>
      <button class="btn" id="start">Start workout</button></div>
    <h2>What you'll do</h2><div class="card">${list}</div>`;
  $("#start").onclick = () => startSession(s);
}

// ---------- Session Player ----------
let sess = null;
function startSession(templateSession) {
  sess = { name: templateSession.name, ex: templateSession.exercises, i: 0, set: 0, logged: [], weights: {}, reps: {} };
  renderPlayer();
}
function startWeightDefault(e) {
  if (e.suggested_kg != null) return e.suggested_kg;
  return { barbell: 40, dumbbell: 10, machine: 20, cable: 15, bodyweight: 0 }[e.equipment] ?? 20;
}
function topReps(range) { const m = String(range).match(/-(\d+)/); return m ? +m[1] : 10; }

function renderPlayer(resting = 0) {
  const e = sess.ex[sess.i];
  const total = sess.ex.length;
  if (sess.weights[sess.i] == null) sess.weights[sess.i] = startWeightDefault(e);
  if (sess.reps[sess.i] == null) sess.reps[sess.i] = topReps(e.rep_range);
  const w = sess.weights[sess.i], reps = sess.reps[sess.i];
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

  app.innerHTML = `<div class="exhead"><h1>${esc(e.name)}</h1><span class="num">${sess.i + 1}/${total}</span></div>
    <p class="muted">Target: ${e.sets} sets × ${e.rep_range} reps · ${e.rir} reps in reserve</p>
    <div class="setdots">${setDots}</div>
    ${e.cue ? `<div class="cue">💡 ${esc(e.cue)}</div>` : ""}
    ${e.suggested_kg == null && sess.set === 0 ? `<p class="muted">${esc(e.suggestion_note || "Pick a weight where the last rep is ~2–3 from failure.")}</p>` : ""}
    <div class="card">
      <div class="stepper"><label>Weight</label><button data-w="-2.5">–</button><div class="val">${w} kg</div><button data-w="2.5">+</button></div>
      <div class="stepper"><label>Reps</label><button data-r="-1">–</button><div class="val">${reps}</div><button data-r="1">+</button></div>
      <button class="btn" id="done">Done — set ${sess.set + 1} of ${e.sets}</button>
    </div>
    <button class="btn ghost" id="how">How do I do this?</button>
    <button class="btn ghost" id="quit">End workout early</button>`;

  app.querySelectorAll("[data-w]").forEach((b) => b.onclick = () => { sess.weights[sess.i] = Math.max(0, Math.round((sess.weights[sess.i] + +b.dataset.w) * 4) / 4); renderPlayer(); });
  app.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { sess.reps[sess.i] = Math.max(0, sess.reps[sess.i] + +b.dataset.r); renderPlayer(); });
  $("#how").onclick = async () => {
    const d = await api(`/api/exercise/${e.exercise}`);
    alert(`${d.name}\n\nHow to:\n• ${(d.cues || []).join("\n• ")}\n\nAvoid:\n• ${(d.common_errors || []).slice(0, 2).join("\n• ")}`);
  };
  $("#quit").onclick = finish;
  $("#done").onclick = () => {
    sess.logged.push({ exercise: e.exercise, set_type: "work", weight_kg: w, reps, completed_at: new Date().toISOString() });
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
async function finish() {
  if (!sess.logged.length) { sess = null; return render(); }
  app.innerHTML = `<div class="center" style="padding-top:20vh"><h1>Saving…</h1></div>`;
  const recap = await api("/api/session", { method: "POST", body: JSON.stringify({ user_id: uid, session_name: sess.name, sets: sess.logged }) });
  renderRecap(recap);
  sess = null;
}
function renderRecap(recap) {
  const wins = (recap.wins || []).map((w) => `<div class="win">${esc(w)}</div>`).join("");
  const nudge = !localStorage.getItem("hb_email")
    ? `<div class="card"><b>Back up your progress</b>
        <p class="muted">Save it to an email so you never lose it — no password, no account wall.</p>
        <button class="btn secondary" id="backup">Back up now</button></div>`
    : "";
  app.innerHTML = `<div class="center"><h1>Session ${recap.day_number || ""} done 💪</h1></div>${wins}${nudge}
    <button class="btn" id="ok">Done</button>`;
  if (nudge) $("#backup").onclick = () => { tab = "me"; render(); };
  $("#ok").onclick = () => { tab = "today"; render(); };
}

// ---------- Progress ----------
const statusClass = (s) => ({ "below-MEV": "s-below", "in-productive-range": "s-in", "approaching-MRV": "s-near", "over-MRV": "s-over" }[s] || "s-none");
const statusLabel = (s) => ({ "below-MEV": "add volume", "in-productive-range": "on target", "approaching-MRV": "near max", "over-MRV": "over max", "no-landmark": "—" }[s] || s);
async function renderProgress() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  const p = await api(`/api/progress?u=${uid}`);
  const vol = (p.volumeByMuscle || []).map((m) => {
    const pct = Math.min(100, (m.sets / 24) * 100);
    return `<div class="row"><div style="flex:1"><b>${esc(m.muscle)}</b> <span class="muted">${m.sets} set${m.sets === 1 ? "" : "s"}/wk</span>
      <div class="bar"><i style="width:${pct}%;background:var(--accent)"></i></div></div>
      <span class="status ${statusClass(m.status)}">${statusLabel(m.status)}</span></div>`;
  }).join("") || `<p class="muted">Log a workout to see your weekly volume.</p>`;
  const prog = (p.progression || []).map((x) => `<div class="row"><b>${esc(x.name)}</b><span class="${x.change_pct >= 0 ? "" : "muted"}">${x.first_e1rm}→${x.last_e1rm} kg (${x.change_pct >= 0 ? "+" : ""}${x.change_pct}%)</span></div>`).join("") || `<p class="muted">Two weeks of data unlocks strength trends.</p>`;
  const t = p.bodyweight_trend;
  const eb = p.energy_balance || {};
  app.innerHTML = `<h1>Progress</h1>
    <div class="card"><b>${p.sessions_logged}</b> <span class="muted">session${p.sessions_logged === 1 ? "" : "s"} logged</span></div>
    <h2>Weekly volume by muscle</h2><div class="card">${vol}</div>
    <h2>Strength trend (est. 1RM)</h2><div class="card">${prog}</div>
    <h2>Bodyweight & energy balance</h2>
    <div class="card">
      ${t ? `<p><b>${t.slope_kg_per_week >= 0 ? "+" : ""}${t.slope_kg_per_week} kg/week</b> <span class="muted">(${t.pct_per_week}%/wk)</span></p>
        <p class="muted">${esc(eb.suggestion || "")}</p>` : `<p class="muted">Add a few bodyweights to infer your energy balance — no calorie counting needed.</p>`}
      <div class="stepper"><label>Log weight</label><input id="bw" type="number" step="0.1" inputmode="decimal" placeholder="kg" style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.1rem"></div>
      <button class="btn secondary" id="logbw">Add today's weight</button>
    </div>`;
  $("#logbw").onclick = async () => {
    const kg = parseFloat($("#bw").value); if (!kg) return;
    await api("/api/bodyweight", { method: "POST", body: JSON.stringify({ user_id: uid, kg }) });
    renderProgress();
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
  app.innerHTML = `<h1>Me</h1>
    <div class="card"><p class="muted">Program</p><b>${esc(localStorage.getItem("hb_program") || "—")}</b></div>
    ${backup}
    <div class="card"><p>This app is free and open-source. If it helps you, you'll one day be able to chip in to cover costs — never required.</p></div>
    <button class="btn ghost" id="reset">Reset (start over)</button>`;

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
      localStorage.clear(); uid = null; onbStep = 0; for (const k in answers) delete answers[k]; render();
    }
  };
}

// ---------- Router ----------
function render() {
  if (!uid) return renderOnboarding();
  nav.hidden = false;
  nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "today") renderToday();
  else if (tab === "progress") renderProgress();
  else renderMe();
}
nav.querySelectorAll("button").forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); });
render();
