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
  { key: "sex", q: "Last one — this just sets sensible starting points.", opts: [["Male", "male"], ["Female", "female"], ["Prefer not to say", "prefer-not-to-say"]] },
];
let onbStep = 0;
let onbStarted = false;
const answers = {};

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
    $("#go").onclick = () => { onbStarted = true; onbStep = 0; renderOnboarding(); };
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
      v = Math.max(st.min, Math.min(st.max, v + (+b.dataset.d) * (st.step || 1))); $("#sv").textContent = v + (st.unit || ""); answers[step.key] = v;
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
      b.classList.toggle("sel");
    });
    $("#next").onclick = advance;
  } else {
    app.querySelectorAll(".choice").forEach((b) => b.onclick = () => { answers[step.key] = step.opts[+b.dataset.i][1]; advance(); });
  }
  $("#onb-back").onclick = onbBack;
}
// A misclick is always recoverable: step back one question (or to the welcome
// screen from the first), with prior answers preserved and re-highlighted.
function onbBack() {
  if (onbStep === 0) { onbStarted = false; return renderOnboarding(); }
  onbStep--;
  renderOnboarding();
}
async function advance() {
  if (onbStep < STEPS.length - 1) { onbStep++; return renderOnboarding(); }
  app.innerHTML = `<div class="center" style="padding-top:20vh"><h1>Building your plan…</h1></div>`;
  const priority = [...new Set((answers.priority_muscles || []).flat())];
  const injuries = (answers.injuries || []).map((region) => ({ region, severity: "moderate" }));
  const profile = {
    training_status: answers.training_status, primary_goal: answers.primary_goal,
    days_per_week: answers.days_per_week, session_length_min: answers.session_length_min,
    available_equipment: answers.available_equipment, priority_muscles: priority,
    injuries, sex: answers.sex, units: "metric",
  };
  const res = await api("/api/onboard", { method: "POST", body: JSON.stringify({ profile }) });
  if (res.user_id) { uid = res.user_id; localStorage.setItem("hb_user", uid); localStorage.setItem("hb_program", res.program.name); return renderPlanExplain(true); }
  else app.innerHTML = `<p>Something went wrong. <button class="btn" onclick="location.reload()">Retry</button></p>`;
}

// The coach explaining the plan before the first workout: split reasoning,
// per-muscle weekly volume vs the KB landmarks, and honest heads-ups.
const titleCase = (id) => String(id).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
async function renderPlanExplain(firstTime) {
  nav.hidden = !!firstTime;
  app.innerHTML = `<p class="muted">Loading your plan…</p>`;
  let d; try { d = await api(`/api/plan/explain?u=${uid}`); } catch { app.innerHTML = `<p class="muted">Couldn't load your plan.</p>`; return; }
  const r = d.rationale || {};
  const gradeChip = (g) => g ? `<span class="chip">Grade ${g}</span>` : "";
  const vols = Object.entries(r.volume_by_muscle || {}).filter(([, v]) => v.frequency > 0 && v.projected_sets > 0).sort((a, b) => b[1].projected_sets - a[1].projected_sets);
  const volRows = vols.map(([m, v]) => `<div class="row"><div style="flex:1"><b>${esc(titleCase(m))}</b> <span class="muted">${v.projected_sets} sets/wk${v.is_priority ? " · priority" : ""}</span>
      <div class="bar"><i style="width:${Math.min(100, (v.projected_sets / 24) * 100)}%;background:var(--accent)"></i></div>
      <span class="muted" style="font-size:.82rem">${esc((v.reasons || []).join(" · "))} ${gradeChip(v.landmark?.evidence_grade)}</span></div>
      <span class="status ${statusClass(v.projected_status)}">${statusLabel(v.projected_status)}</span></div>`).join("");
  const warns = (r.warnings || []).map((w) => `<div class="win">ℹ️ ${esc(w.message)}</div>`).join("");
  app.innerHTML = `<h1>Your plan</h1>
    <div class="card"><div class="big">${esc(d.program?.name || "Your program")}</div>
      <p class="muted">${esc(r.split?.reason || "")} ${gradeChip("B")}</p></div>
    <h2>Weekly volume — tuned to your muscles' landmarks</h2>
    <div class="card">${volRows || '<p class="muted">—</p>'}</div>
    ${warns ? `<h2>Heads up</h2><div class="card">${warns}</div>` : ""}
    <button class="btn" id="explain-go">${firstTime ? "Start training" : "Back"}</button>`;
  $("#explain-go").onclick = () => { tab = firstTime ? "today" : "me"; render(); };
}

// ---------- Today ----------
async function renderToday() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let data, adh;
  try { [data, adh] = await Promise.all([api(`/api/today?u=${uid}`), api(`/api/adherence?u=${uid}`)]); }
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
  const list = s.exercises.map((e) => `<div class="row"><div><b>${esc(e.name)}</b><br><span class="muted">${e.sets} × ${e.rep_range} · ${(e.primary_muscles || []).join(", ")}</span></div></div>`).join("");
  // No check-in yet today → gently offer one; otherwise surface the readiness note.
  const readinessCard = s.readiness == null
    ? `<div class="card"><b>How are you feeling today?</b>
        <p class="muted">A 15-second check-in lets me tune today's session. Optional.</p>
        <button class="btn secondary" id="checkin">Quick check-in</button></div>`
    : (s.coach_note ? `<div class="card"><p>🧭 ${esc(s.coach_note)}</p></div>` : "");
  app.innerHTML = `<h1>Today</h1>${header}${readinessCard}
    <div class="card"><div class="big">${esc(s.name)}</div>
      <p class="muted">${esc(s.program_name)} · day ${s.day_number} · ${s.exercises.length} exercises</p>
      <button class="btn" id="start">Start workout</button></div>
    <h2>What you'll do</h2><div class="card">${list}</div>`;
  $("#start").onclick = () => startSession(s);
  if (s.readiness == null) $("#checkin").onclick = renderCheckin;
}

// Optional daily check-in survey — four 1-5 taps; low readiness eases today.
function renderCheckin() {
  const fields = [["sleep_quality", "Sleep quality"], ["energy", "Energy"], ["stress", "Stress"], ["mood", "Mood"]];
  const vals = { sleep_quality: 3, energy: 3, stress: 3, mood: 3 };
  const draw = () => {
    const row = ([key, label]) => `<div class="row"><span style="flex:1">${label}</span>${[1, 2, 3, 4, 5].map((n) =>
      `<button class="chip" data-k="${key}" data-v="${n}" style="min-width:40px;text-align:center${vals[key] === n ? ";background:var(--accent);color:#06210f;border-color:var(--accent)" : ""}">${n}</button>`).join("")}</div>`;
    app.innerHTML = `<h1>Quick check-in</h1><p class="muted">Rate each 1–5 — this just tunes today, it's never a score or a judgment.</p>
      <div class="card">${fields.map(row).join("")}</div>
      <button class="btn" id="submitck">Save</button>
      <button class="btn ghost" id="skipck">Skip today</button>`;
    app.querySelectorAll(".chip[data-k]").forEach((b) => b.onclick = () => { vals[b.dataset.k] = +b.dataset.v; draw(); });
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
  return { barbell: 40, dumbbell: 10, machine: 20, cable: 15, bodyweight: 0 }[e.equipment] ?? 20;
}
function topReps(range) { const m = String(range).match(/-(\d+)/); return m ? +m[1] : 10; }

function renderPlayer(resting = 0) {
  const e = sess.ex[sess.i];
  const total = sess.ex.length;
  if (sess.weights[sess.i] == null) sess.weights[sess.i] = startWeightDefault(e);
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

  app.innerHTML = `<div class="exhead"><h1>${esc(e.name)}</h1><span class="num">${sess.i + 1}/${total}</span></div>
    <p class="muted">Target: ${e.sets} sets × ${e.rep_range} reps · ${e.rir} reps in reserve</p>
    <div class="setdots">${setDots}</div>
    ${e.cue ? `<div class="cue">💡 ${esc(e.cue)}</div>` : ""}
    ${e.suggested_kg == null && sess.set === 0 ? `<p class="muted">${esc(e.suggestion_note || "Pick a weight where the last rep is ~2–3 from failure.")}</p>` : ""}
    <div class="card">
      <div class="stepper"><label>Weight</label><button data-w="-2.5">–</button><div class="val">${w} kg</div><button data-w="2.5">+</button></div>
      <div class="stepper"><label>Reps</label><button data-r="-1">–</button><div class="val">${reps}</div><button data-r="1">+</button></div>
      ${rirOn() ? `<div class="stepper"><label>RIR</label><button data-rir="-1">–</button><div class="val">${rir}</div><button data-rir="1">+</button></div>` : ""}
      <button class="btn" id="done">Done — set ${sess.set + 1} of ${e.sets}</button>
    </div>
    <button class="btn ghost" id="how">How do I do this?</button>
    <button class="btn ghost" id="quit">End workout early</button>`;

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
    sess.logged.push({ exercise: e.exercise, set_type: "work", weight_kg: w, reps, ...(rirOn() ? { rir } : {}), completed_at: new Date().toISOString() });
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
  const muscles = [...(d?.primary_muscles ?? []), ...(d?.secondary_muscles ?? [])].join(", ");
  const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(name + " proper form")}`;
  app.innerHTML = `<h1>${esc(name)}</h1>
    ${muscles ? `<p class="muted">Works: ${esc(muscles)}</p>` : ""}
    <h2>How to do it</h2>${cues}
    ${errs ? `<h2>Avoid</h2>${errs}` : ""}
    <a class="btn secondary" style="text-align:center;text-decoration:none;display:block" href="${yt}" target="_blank" rel="noopener">▶ Watch form videos</a>
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
  try { p = await api(`/api/progress?u=${uid}`); }
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
    const res = await postOrQueue("/api/bodyweight", { user_id: uid, kg });
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
      <p>Log reps-in-reserve each set so the coach autoregulates your load. Off by default — simple progression works great, especially for beginners.</p>
      <button class="btn secondary" id="rirtoggle">${rirOn() ? "On — tap to turn off" : "Off — tap to turn on"}</button></div>
    ${backup}
    ${funded}
    <button class="btn ghost" id="reset">Reset (start over)</button>`;
  $("#viewplan").onclick = () => renderPlanExplain(false);
  $("#rirtoggle").onclick = () => { localStorage.setItem("hb_rir", rirOn() ? "0" : "1"); renderMe(); };

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
  let a; try { a = await api(`/api/adherence?u=${uid}`); } catch { app.innerHTML = `<h1>Coach</h1><div class="card"><p>📴 Offline.</p></div>`; return; }
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
  $("#days").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<button class="chip" data-day="${i}" style="min-width:46px">${d}</button>`).join(" ");
  $("#days").querySelectorAll("[data-day]").forEach((b) => b.onclick = () => {
    const i = +b.dataset.day;
    if (sel.has(i)) { sel.delete(i); b.style.background = ""; b.style.color = ""; } else { sel.add(i); b.style.background = "var(--accent)"; b.style.color = "#06210f"; }
  });
  $("#addcal").onclick = () => { if (!sel.size) { $("#calmsg").textContent = "Pick at least one day first."; return; } downloadTrainingCalendar([...sel], $("#sched-time").value); $("#calmsg").textContent = "Calendar file downloaded — open it to add recurring reminders."; };
  $("#pause").onclick = async () => { await api("/api/pause", { method: "POST", body: JSON.stringify({ user_id: uid, on: !paused }) }); renderCoach(); };
}

// ---------- Router ----------
function render() {
  if (!uid) return renderOnboarding();
  nav.hidden = false;
  nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "today") renderToday();
  else if (tab === "progress") renderProgress();
  else if (tab === "coach") renderCoach();
  else renderMe();
}
nav.querySelectorAll("button").forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
flushQueue(); // push any workouts logged offline last time
render();
