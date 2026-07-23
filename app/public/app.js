// The Hypertrophy Bible — brainless client. One decision per screen; everything
// higher-order is derived server-side. No build step, no framework.
import { orderSupersetAdjacent, loggedWorkSets, nextUnfinishedIndex, stationProgress, dropDelivered } from "/session-core.mjs";
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

// The beginner library is ~150KB of prose. Load it on demand rather than on every
// cold start — the first thing a nervous newcomer sees shouldn't wait on 24 pages
// they haven't asked for. The service worker still precaches it, so opening Learn
// offline is instant.
let LEARN = null;
async function learnData() {
  if (!LEARN) LEARN = await import("./learn-data.js");
  return LEARN;
}

// Deep-link into the in-app beginner library (content/09-getting-started).
function openLearn(slug) { learnSlug = slug || null; tab = "learn"; render(); }
// Wire any [data-learn="slug"] element on the current screen to open that page.
function wireLearnLinks() { app.querySelectorAll("[data-learn]").forEach((b) => b.onclick = () => openLearn(b.dataset.learn)); }
// A small inline "?" that opens a learn page — decodes jargon in place.
// The accessible name must MATCH the visible text (WCAG 2.5.3): a hard-coded
// aria-label="Explain" hid descriptive labels like "what's RIR?" from screen
// readers and broke voice control ("tap what's RIR"). Only the bare "?" default
// needs a spoken name; a descriptive label speaks for itself.
const helpDot = (slug, label = "?") => `<button class="help" data-learn="${slug}"${label === "?" ? ' aria-label="Explain this term"' : ""}>${label}</button>`;

const api = async (path, opts = {}) => {
  const headers = { "content-type": "application/json", ...(uid ? { "X-HB-User": uid } : {}), ...(opts.headers || {}) };
  const r = await fetch(path, { ...opts, headers });
  return r.json();
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Screen-reader announcement for deliberate events only (the old whole-app
// aria-live re-announced every repaint, making the player unusable by ear).
const say = (msg) => { const el = $("#say"); if (el) el.textContent = msg; };

// PWA / push capability. On iOS, Web Push exists ONLY for a home-screen-installed
// app — `PushManager` is absent in a normal Safari tab, so the reminders card
// would silently vanish for every iPhone user in the browser. Detect that case
// to show an "Add to Home Screen" hint instead of nothing.
const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 13+ masquerades as Mac
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;
let pendingNotice = null; // a one-shot notice for the NEXT screen (survives re-render)
// Inline failure notice: never a silent dead button.
function alertBar(msg) {
  let el = $("#alertbar");
  if (!el) { el = document.createElement("div"); el.id = "alertbar"; el.className = "card info"; app.prepend(el); }
  el.innerHTML = `<p>${esc(msg)}</p>`;
  el.scrollIntoView({ block: "nearest" });
}

// Set to your Open Collective / GitHub Sponsors URL when it exists. The support
// button stays hidden until then — never show a dead or fake donation link.
const DONATE_URL = "";

// ---------- Offline write queue ----------
// Logging must never be lost to a dead gym basement signal: failed POSTs wait
// in localStorage and sync when the connection returns.
// The user's LOCAL calendar day (YYYY-MM-DD) — for "today"-scoped UX flags like
// the check-in dismissal. toISOString() is UTC: east of UTC it re-nagged the same
// morning, west of UTC it suppressed the NEXT day's check-in. (Server-facing dates
// keep ISO/UTC — this is only for what "today" means to the person holding the phone.)
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const QKEY = "hb_queue";
const getQueue = () => { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch { return []; } };
const setQueue = (q) => localStorage.setItem(QKEY, JSON.stringify(q));
const genQueueId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let flushing = false; // guard against re-entrancy within THIS tab (load + 'online')
async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    while (true) {
      const q = getQueue();
      if (!q.length) break;
      const item = q[0];
      // Legacy items (queued before items carried an id) get one assigned in place,
      // so the identity-based removal below is always safe.
      if (!item.id) { item.id = genQueueId(); q[0] = item; try { setQueue(q); } catch {} }
      // The queue is device-local, so the current user always owns it. Rebinding
      // heals items whose account switched (a restore) after they were queued —
      // they land on the account instead of a stale/deleted user_id.
      const body = JSON.stringify({ ...JSON.parse(item.body), user_id: uid });
      let ok = false;
      try { ok = (await fetch(item.path, { method: "POST", headers: { "content-type": "application/json" }, body })).ok; }
      catch { break; } // offline again — keep everything for next time
      if (!ok) break;   // server/HTTP error — retry later rather than drop the workout
      // Remove ONLY the item we just delivered, BY IDENTITY — never by position.
      // `flushing` guards re-entry within this tab but NOT across tabs (it's a
      // per-realm boolean), so on reconnect a PWA + a browser tab can both flush.
      // slice(1) removed "whatever is at the head now", which could be an item a
      // second tab had already shifted — silently dropping an UNdelivered workout.
      // filter-by-id can only ever remove the one we delivered; server writes are
      // idempotent (session_id / date dedup), so a double delivery is harmless.
      try { setQueue(dropDelivered(getQueue(), item.id)); } catch { break; }
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
    // Queueing itself can fail (storage full / private mode). Report it honestly —
    // callers holding irreplaceable data (finish()) keep their copy and retry.
    try { setQueue([...getQueue(), { id: genQueueId(), path, body }]); return { ok: false, queued: true }; }
    catch { return { ok: false, queued: false }; }
  }
}

// ---------- Onboarding ----------
const STEPS = [
  { key: "training_status", q: "Have you lifted weights before?", opts: [["New to this", "beginner"], ["About a year in", "intermediate"], ["Several years", "advanced"]] },
  { key: "primary_goal", q: "What do you want most?", opts: [["Build muscle", "hypertrophy"], ["Get stronger", "strength"], ["Lose fat", "fat-loss"], ["A bit of both", "recomposition"]] },
  { key: "days_per_week", q: "How many days a week can you train?", stepper: { min: 2, max: 6, def: 3, hint: "Most beginners grow well on 3." } },
  { key: "session_length_min", q: "How long can each session be?", stepper: { min: 30, max: 90, step: 15, def: 60, hint: "45–60 minutes suits most people.", unit: " min" } },
  { key: "available_equipment", q: "Where will you train?", opts: [["A full gym", ["barbell", "dumbbell", "machine", "cable", "bodyweight", "band", "kettlebell"]], ["Home gym (dumbbells, bands, kettlebell)", ["dumbbell", "kettlebell", "band", "bodyweight"]], ["Home with dumbbells", ["dumbbell", "bodyweight"]], ["Bands & bodyweight", ["band", "bodyweight"]], ["Just my bodyweight", ["bodyweight"]]] },
  { key: "priority_muscles", q: "Any muscles you especially want to grow?", multi: [["Shoulders", ["side-delts"]], ["Chest", ["chest"]], ["Back", ["lats", "upper-back"]], ["Arms", ["biceps", "triceps"]], ["Glutes", ["glutes"]], ["Thighs", ["quadriceps"]], ["Abs", ["abs"]]], optional: true, hint: "Optional — we'll give these extra volume." },
  { key: "specialization", q: "How hard should I push those muscles?", opts: [["Extra volume (balanced)", false], ["All-in specialization block", true]], hint: "All-in: your picks get maximum volume and everything else drops to a maintenance dose. Best for one or two 6-week blocks, not forever.", showIf: (a) => (a.priority_muscles || []).length > 0 },
  { key: "injuries", q: "Anything we should train around?", multi: [["Lower back", "lower-back"], ["Knee", "knee"], ["Shoulder", "shoulder"], ["Elbow", "elbow"], ["Wrist", "wrist"], ["Hip", "hip"]], optional: true, hint: "Optional — we'll avoid aggravating movements." },
  { key: "units", q: "Pounds or kilograms?", opts: [["Kilograms (kg)", "metric"], ["Pounds (lb)", "imperial"]] },
  { key: "sex", q: "Last one — this just sets sensible starting points.", opts: [["Male", "male"], ["Female", "female"], ["Prefer not to say", "prefer-not-to-say"]] },
];
// Onboarding answers persist to localStorage as they're picked, so a reload or a
// failed submit never makes a nervous first-timer re-answer all eight questions.
const ONB_KEY = "hb_onboarding";
let onbStep = 0, onbStarted = false, answers = {};
// Settings reuses the SAME wizard the user already learned in onboarding —
// pre-filled from their profile, submitting to /api/plan/regenerate instead of
// creating a new user. Zero new UI concepts; the plan regenerates on save.
let settingsMode = false;
try { const s = JSON.parse(localStorage.getItem(ONB_KEY) || "null"); if (s) { answers = s.answers || {}; onbStep = s.onbStep || 0; onbStarted = !!s.onbStarted; } } catch {}
const saveOnb = () => { if (settingsMode) return; try { localStorage.setItem(ONB_KEY, JSON.stringify({ answers, onbStep, onbStarted })); } catch {} };

// Open the wizard as a pre-filled settings editor for an existing user.
async function renderSettings() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let d; try { d = await api(`/api/plan/explain`); } catch { d = null; }
  const p = d?.profile;
  if (!p) {
    // NEVER open the wizard on factory defaults: saving it would silently replace
    // the real profile (days, equipment, injuries) with 3-day/60-min boilerplate.
    app.innerHTML = `<h1>Settings</h1><div class="card"><p>📴 Couldn't load your current settings.</p>
      <p class="muted">Editing needs them first — otherwise a save could overwrite what you've got.</p>
      <button class="btn" id="retry-set">Try again</button>
      <button class="btn ghost" id="back-me">‹ Back</button></div>`;
    $("#retry-set").onclick = renderSettings;
    $("#back-me").onclick = () => { tab = "me"; render(); };
    return;
  }
  answers = {
    training_status: p.training_status, primary_goal: p.primary_goal, sex: p.sex,
    days_per_week: p.days_per_week ?? 3, session_length_min: p.session_length_min ?? 60,
    available_equipment: p.available_equipment,
    // multi steps store option-value arrays: select each group fully covered by the profile
    priority_muscles: (STEPS.find((s) => s.key === "priority_muscles")?.multi || [])
      .map(([, v]) => v).filter((v) => v.every((id) => (p.priority_muscles || []).includes(id))),
    injuries: (p.injuries || []).map((i) => i.region),
    specialization: p.specialization === true,
    units: p.units || (unitPref() === "lb" ? "imperial" : "metric"), // profile is the truth; local pref is the fallback
  };
  settingsMode = true; onbStarted = true; onbStep = 0;
  renderOnboarding();
}

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
        <input id="remail" type="email" inputmode="email" autocomplete="email" aria-label="Email address for your restore link" placeholder="you@email.com"
          style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:0 0 8px">
        <button class="btn secondary" id="sendrestore">Email me a restore link</button>
        <p class="muted" id="rmsg"></p></div></div>`;
    $("#go").onclick = () => { onbStarted = true; onbStep = 0; saveOnb(); renderOnboarding(); };
    $("#restore").onclick = () => { const b = $("#restorebox"); b.hidden = !b.hidden; if (!b.hidden) $("#remail").focus(); };
    $("#sendrestore").onclick = async () => {
      const val = $("#remail").value.trim();
      if (!val) { $("#rmsg").textContent = "Enter your email first."; return; }
      $("#sendrestore").disabled = true; $("#rmsg").textContent = "Sending…";
      let r; try { r = await api("/api/auth/request", { method: "POST", body: JSON.stringify({ email: val }) }); }
      catch { $("#rmsg").textContent = "📴 You're offline — try again when you have signal."; $("#sendrestore").disabled = false; return; }
      if (r.error === "invalid-email") { $("#rmsg").textContent = "That doesn't look like an email."; $("#sendrestore").disabled = false; return; }
      if (r.sent === false) { $("#rmsg").textContent = "Couldn't send right now — try again in a moment."; $("#sendrestore").disabled = false; return; }
      $("#rmsg").innerHTML = "If that email has a backup, a restore link is on its way — it works once and expires in 30 minutes."
        + (r.dev_link ? ` <a href="${esc(r.dev_link)}">[dev link]</a>` : "");
      // Typos are the common failure here (a wrong-but-valid email still shows the
      // hedged success line) — always leave a way to correct and resend in place,
      // never a permanently dead button.
      $("#sendrestore").disabled = false;
      $("#sendrestore").textContent = "Resend / use a different email";
    };
    return;
  }
  const step = STEPS[onbStep];
  const dots = STEPS.map((_, i) => `<i class="${i <= onbStep ? "on" : ""}"></i>`).join("");
  let body;
  if (step.stepper) {
    const st = step.stepper;
    const v = answers[step.key] ?? st.def;
    const noun = step.key === "days_per_week" ? "days" : "minutes";
    body = `<div class="stepper"><button data-d="-1" aria-label="fewer ${noun}">–</button><div class="val" id="sv" aria-live="polite">${v}${st.unit || ""}</div><button data-d="1" aria-label="more ${noun}">+</button></div>
      <p class="muted center">${st.hint}</p><button class="btn" id="next">Continue</button>`;
  } else if (step.multi) {
    const sel = new Set((answers[step.key] || []).map((x) => JSON.stringify(x)));
    body = step.multi.map((o, i) => { const on = sel.has(JSON.stringify(o[1])); return `<button class="choice${on ? " sel" : ""}" data-i="${i}" aria-pressed="${on}">${esc(o[0])}</button>`; }).join("")
      + `<p class="muted center">${step.hint || ""}</p><button class="btn" id="next">Continue</button>`;
  } else {
    // Highlight the previously chosen option (when returning via Back) so it's clear
    // what you'd picked; tapping any option still advances immediately.
    const chosen = JSON.stringify(answers[step.key]);
    body = step.opts.map((o, i) => `<button class="choice${JSON.stringify(o[1]) === chosen ? " sel" : ""}" data-i="${i}">${esc(o[0])}<span>›</span></button>`).join("")
      + (step.hint ? `<p class="muted center">${esc(step.hint)}</p>` : "");
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
      b.classList.toggle("sel");
      b.setAttribute("aria-pressed", b.classList.contains("sel")); // no re-render here, so sync the attr
      saveOnb();
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
  if (settingsMode && onbStep === 0) { settingsMode = false; tab = "me"; return render(); } // exit settings, change nothing
  if (onbStep === 0) { onbStarted = false; saveOnb(); return renderOnboarding(); }
  let prev = onbStep - 1;
  while (prev > 0 && STEPS[prev].showIf && !STEPS[prev].showIf(answers)) prev--; // skip conditional steps backwards
  onbStep = prev; saveOnb();
  renderOnboarding();
}
async function advance() {
  let next = onbStep + 1;
  while (next < STEPS.length && STEPS[next].showIf && !STEPS[next].showIf(answers)) next++; // skip conditional steps
  if (next < STEPS.length) { onbStep = next; saveOnb(); return renderOnboarding(); }
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
    specialization: priority.length ? answers.specialization === true : false,
    injuries, sex: answers.sex, units: answers.units || "metric",
  };
  // NOTE: the display-unit preference (hb_units) is written only on the SUCCESS
  // paths below — flipping it before the API call meant a failed save showed
  // "Your settings weren't changed" while the whole app had already switched
  // kg↔lb, contradicting both the copy and the server profile.
  // Settings edit: same wizard, but the profile updates the EXISTING user and the
  // plan regenerates — never a new identity.
  if (settingsMode) {
    let r; try { r = await api("/api/plan/regenerate", { method: "POST", body: JSON.stringify({ user_id: uid, profile }) }); } catch { r = {}; }
    if (r.program) {
      settingsMode = false;
      localStorage.setItem("hb_units", profile.units); // saved server-side — now the display can follow
      localStorage.setItem("hb_program", r.program.name);
      return renderPlanExplain(false); // show the regenerated plan immediately
    }
    app.innerHTML = `<div class="center" style="padding-top:16vh"><h1>Hmm — that didn't go through.</h1>
      <p>Your settings weren't changed. Let's try again.</p>
      <button class="btn" id="retryset">Try again</button>
      <button class="btn ghost" id="backset">‹ Keep my old settings</button></div>`;
    $("#retryset").onclick = submitOnboarding;
    $("#backset").onclick = () => { settingsMode = false; tab = "me"; render(); };
    return;
  }
  let res;
  try { res = await api("/api/onboard", { method: "POST", body: JSON.stringify({ profile }) }); }
  catch { res = {}; }
  if (res.user_id) {
    uid = res.user_id; localStorage.setItem("hb_user", uid); localStorage.setItem("hb_program", res.program.name);
    localStorage.setItem("hb_units", profile.units); // remember display preference (only once onboarding actually succeeded)
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
  <b>Grade A–D</b> shows how strong the science behind a number is — A is the strongest evidence, D is a sensible best-guess.<br>
  <span class="status s-maint">holding steady</span> during a specialization block, this muscle is intentionally kept at a maintenance dose while your priority muscles get the extra volume.</p>`;
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
  // A custom-edited plan clears plan_rationale (it described the pre-edit plan), so
  // the generated science breakdown no longer matches the sessions shown. Rather
  // than render a stale/empty "why", point to the live editor critique.
  const hasRationale = !!(r.volume_by_muscle && Object.keys(r.volume_by_muscle).length);
  const whyBlock = hasRationale
    ? `<details class="why"><summary>Why this plan? <span class="muted">(the science)</span></summary>
    <p class="muted" style="margin-top:8px">${esc(r.split?.reason || "")} ${gradeChip("B")}</p>
    <h3>Weekly sets per muscle</h3>
    <div class="card">${volRows || '<p class="muted">—</p>'}</div>
    ${STATUS_LEGEND}
    ${warns ? `<h3>Heads up</h3><div class="card">${warns}</div>` : ""}</details>`
    : `<div class="card"><p class="muted">You've customised this plan, so the auto-generated “why” breakdown no longer describes it. Use <b>Edit &amp; review my plan</b> below for a live check of your plan against the KB.</p></div>`;

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
  let d, exs;
  try { [d, exs] = await Promise.all([api(`/api/plan/explain`), api(`/api/exercises`)]); }
  catch {
    app.innerHTML = `<h1>Edit &amp; review</h1><div class="card"><p>📴 You're offline.</p>
      <p class="muted">Plan editing needs a connection. Nothing you've logged is affected.</p>
      <button class="btn" id="pe-retry">Try again</button></div>`;
    $("#pe-retry").onclick = renderPlanEdit;
    return;
  }
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
      <button class="tapchip ${pendingRm === si + "-" + ei ? "danger" : ""}" data-act="rm" aria-label="${pendingRm === si + "-" + ei ? "confirm remove exercise" : "remove exercise"}">${pendingRm === si + "-" + ei ? "Remove?" : "✕"}</button></div>`).join("")}
    <button class="btn ghost" data-add="${si}">+ Add exercise</button></div>`).join("");
  const crit = critique ? `<div class="card"><b>🧭 ${esc(critique.summary)}</b>${(critique.findings || []).map((f) => `<div class="win">${f.severity === "warn" ? "⚠️" : "💡"} ${esc(f.msg)}</div>`).join("")}</div>` : "";
  app.innerHTML = `<h1>Edit &amp; review</h1>
    <p class="muted">Your edits are never overwritten — which also means a hand-edited plan pauses the automatic accessory rotation between blocks. Rebuild from Settings any time to hand the wheel back.</p>
    ${crit}${sessions}
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
      else if (act === "swap") {
        const pool = poolFor(ex.exercise);
        if (pool.length > 1) { const cur = pool.findIndex((p) => p.id === ex.exercise); ex.exercise = pool[(cur + 1) % pool.length].id; }
        // Never a silent dead button: with your equipment this may be the only lift
        // for the muscle — say so. The notice must be shown AFTER the repaint
        // (drawEdit rebuilds app.innerHTML, which would destroy it), so repaint
        // first, then attach the alert to the fresh DOM and stop.
        else {
          say("No alternative trains this muscle with your equipment.");
          drawEdit(critique);
          alertBar(`${exName(ex.exercise)} is the only lift for this muscle with your equipment — use “+ Add exercise” (or create your own) instead.`);
          return;
        }
      }
    }
    drawEdit(critique);
  });
  app.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => renderAddExercise(+b.dataset.add));
  $("#savePlan").onclick = async () => {
    let r; try { r = await api(`/api/plan/save`, { method: "POST", body: JSON.stringify({ user_id: uid, program: editState }) }); } catch { r = null; }
    if (r && r.ok) { localStorage.setItem("hb_program", editState.name); say("Plan saved."); drawEdit(r.critique); }
    else { say("Couldn't save."); alertBar("📴 Couldn't save — check your connection and tap Save again. Your edits are still here."); }
  };
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
  // aria-pressed carries the selected state to a screen reader (colour alone is
  // invisible to it) — same fix as the Coach day-picker. Selecting updates the
  // group's chips IN PLACE (aria-pressed + style) and announces, instead of a
  // full redraw that would drop focus off the tapped chip.
  const chip = (val, cur, attr) => `<button class="chip" role="switch" aria-pressed="${cur === val}" data-${attr}="${val}" style="${cur === val ? "background:var(--accent);color:#06210f;border-color:var(--accent)" : ""}">${attr === "m" ? titleCase(val) : val}</button>`;
  const draw = () => {
    app.innerHTML = `<h1>New exercise</h1><div class="card">
      <label for="cx-name" class="muted">Exercise name</label>
      <input id="cx-name" placeholder="Exercise name" value="${esc(st.name)}" style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin-bottom:12px">
      <p class="muted" id="cx-mlbl">Primary muscle</p><div role="group" aria-labelledby="cx-mlbl" style="margin-bottom:12px">${muscles.map((m) => chip(m, st.muscle, "m")).join(" ")}</div>
      <p class="muted" id="cx-elbl">Equipment</p><div role="group" aria-labelledby="cx-elbl" style="margin-bottom:12px">${["barbell", "dumbbell", "machine", "cable", "bodyweight", "other"].map((e) => chip(e, st.equipment, "e")).join(" ")}</div>
      <p class="muted" id="cx-tlbl">Type</p><div role="group" aria-labelledby="cx-tlbl">${["compound", "isolation"].map((mm) => chip(mm, st.mechanic, "mech")).join(" ")}</div></div>
      <button class="btn" id="cx-save">Add to my library</button>
      <button class="btn ghost" id="cx-cancel">Cancel</button><p class="muted" id="cx-msg"></p>`;
    $("#cx-name").oninput = (e) => { st.name = e.target.value; };
    // Reflect a group's selection onto its chips in place (aria-pressed + colour).
    const paint = (attr, sel) => app.querySelectorAll(`[data-${attr}]`).forEach((b) => {
      const on = b.dataset[attr] === sel;
      b.setAttribute("aria-pressed", String(on));
      b.style.background = on ? "var(--accent)" : ""; b.style.color = on ? "#06210f" : ""; b.style.borderColor = on ? "var(--accent)" : "";
    });
    const wire = (attr, set, label) => app.querySelectorAll(`[data-${attr}]`).forEach((b) => b.onclick = () => { set(b.dataset[attr]); paint(attr, b.dataset[attr]); say(`${label} ${titleCase(b.dataset[attr])} selected`); });
    wire("m", (v) => st.muscle = v, "Primary muscle");
    wire("e", (v) => st.equipment = v, "Equipment");
    wire("mech", (v) => st.mechanic = v, "Type");
    $("#cx-save").onclick = async () => {
      if (!st.name.trim()) { $("#cx-msg").textContent = "Give it a name first."; return; }
      // One exercise per tap: the server append is non-idempotent (each call mints a
      // fresh id), so a double-tap would create two copies of the same lift. Disable
      // while in flight; re-enable only on a failure the user can retry.
      const btn = $("#cx-save"); btn.disabled = true;
      let r; try { r = await api(`/api/exercise/custom`, { method: "POST", body: JSON.stringify({ user_id: uid, exercise: { name: st.name.trim(), primary_muscles: [st.muscle], equipment: st.equipment, mechanic: st.mechanic } }) }); }
      catch { $("#cx-msg").textContent = "📴 You're offline — try again when connected."; btn.disabled = false; return; }
      if (r.error) { $("#cx-msg").textContent = r.error; btn.disabled = false; return; }
      allExercises = await api(`/api/exercises`);
      editState.sessions[si].exercises.push({ exercise: r.exercise.id, sets: 3, rep_range: "8-12" });
      drawEdit(null);
    };
    $("#cx-cancel").onclick = () => renderAddExercise(si);
  };
  draw();
}

// ---------- Today ----------
// An unfinished workout takes over Today until it's resumed or explicitly discarded.
// Deliberately needs NO network — a gym basement is exactly where you reopen the app
// mid-session — and it removes the old trap where "Start workout" silently
// overwrote sets you'd already done.
function renderResume() {
  const n = sess.logged.length;
  // A COMPLETE workout whose final save was interrupted resumes into saving, not
  // into the player — every set is already logged; it just needs to reach the server.
  const done = !!sess.complete;
  // An old session says WHEN it's from — the user decides its fate, never a timer.
  const when = sess.stale && sess.startedAt
    ? ` from ${new Date(sess.startedAt).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`
    : "";
  app.innerHTML = `<h1>Today</h1>
    <div class="card info"><b>${done ? `✅ Workout finished${esc(when)} — just needs saving` : `▶ Workout in progress${esc(when)}`}</b>
      <p class="muted">${esc(sess.name)} — <b>${n} set${n === 1 ? "" : "s"}</b> logged. Nothing is lost.</p>
      <button class="btn" id="resume">${done ? "Save my workout" : "Resume workout"}</button>
      <button class="btn ghost" id="discard">${discardPending ? "Tap again to discard these sets" : "Discard this workout"}</button></div>`;
  $("#resume").onclick = () => { discardPending = false; done ? finish() : renderPlayer(0); };
  $("#discard").onclick = () => {
    if (discardPending) { discardPending = false; clearSess(); renderToday(); }
    else { discardPending = true; renderResume(); }
  };
}
async function renderToday() {
  if (sess) return renderResume();
  discardPending = false;
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let data, adh;
  try { [data, adh] = await Promise.all([api(`/api/today`), api(`/api/adherence`)]); }
  catch {
    app.innerHTML = `<h1>Today</h1><div class="card"><p>📴 You're offline.</p>
      <p class="muted">Connect once to load today's plan — anything you've already logged will sync automatically.</p>
      <button class="btn" id="retry-today">Try again</button></div>`;
    $("#retry-today").onclick = () => renderToday();
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
  const list = s.exercises.map((e) => `<div class="row"><div><b>${esc(e.name)}</b>${e.lengthened_bias ? ` <span class="chip stretch">🎯 stretch-focused</span>` : ""}<br><span class="muted">${e.sets} sets × ${esc(e.rep_range)} reps${e.unilateral ? " <b>each side</b>" : ""}${e.superset_with_name ? ` · <b>🔗 superset with ${esc(e.superset_with_name)}</b>` : ""} · works ${esc(friendlyMuscles(e.primary_muscles))}</span></div></div>`).join("");
  // No check-in yet today → gently offer one; otherwise surface the readiness note.
  // "Skip today" and a finished workout both dismiss the offer FOR THE DAY —
  // re-asking after either makes "optional" feel like a nag (and post-workout the
  // check-in can't tune anything anyway).
  const ckDismissed = localStorage.getItem("hb_ck_dismissed") === localDay();
  const readinessCard = s.readiness == null
    ? (ckDismissed ? "" : `<div class="card"><b>How are you feeling today?</b>
        <p class="muted">A 15-second check-in lets me tune today's session. Optional.</p>
        <button class="btn secondary" id="checkin">Quick check-in</button></div>`)
    : (s.coach_note ? `<div class="card"><p>🧭 ${esc(s.coach_note)}</p></div>` : "");
  // A brand-new lifter's very first session gets a reassuring walkthrough up top.
  const firstTimer = s.day_number === 1
    ? `<div class="card"><b>👋 First workout? You've got this.</b>
        <p class="muted">Here's exactly how a session goes — arrive, warm up, find a comfy weight, do your sets. A 2-minute read makes the whole thing easy.</p>
        <button class="btn secondary" data-learn="your-first-session">Read: Your first session</button></div>`
    : "";
  // The mesocycle position (intermediate/advanced only): where this week sits in
  // the build → peak → deload wave, in one glance.
  // Friendly phase labels (never the raw token) + a tap-to-learn on the jargon,
  // matching the helpDot-on-jargon pattern everywhere else in the app.
  const PHASE_LABEL = { build: "building up", peak: "peak week", deload: "easy week (deload)" };
  const blockCard = s.block
    ? `<div class="card"><b>${s.block.phase === "deload" ? "🌊" : s.block.phase === "peak" ? "⛰️" : "📈"} Week ${s.block.week} of ${s.block.of} — ${PHASE_LABEL[s.block.phase] ?? s.block.phase}</b> ${helpDot("deloads-and-rest-days", "ⓘ why weeks differ")}
        <p class="muted">${esc(s.block.note)}</p></div>`
    : "";
  app.innerHTML = `<h1>Today</h1>${header}${firstTimer}${blockCard}${readinessCard}
    <div class="card"><div class="big">${esc(s.name)}</div>
      <p class="muted">${esc(s.program_name)} · day ${s.day_number} · ${s.exercises.length} exercises</p>
      <button class="btn" id="start">Start workout</button></div>
    <h2>What you'll do ${helpDot("how-to-read-a-workout", "ⓘ how to read this")}</h2><div class="card">${list}</div>`;
  $("#start").onclick = () => startSession(s);
  if ($("#checkin")) $("#checkin").onclick = renderCheckin;
  wireLearnLinks();
  if (pendingNotice) { alertBar(pendingNotice); pendingNotice = null; }
}

// Optional daily check-in survey — four 1-5 taps; low readiness eases today.
function renderCheckin() {
  // Each row carries its OWN anchors. A single global "1 = low, 5 = great" read
  // backwards for stress: a calm person tapped 5 ("great!") and was scored as
  // maximally stressed — flipping the readiness rail to fire on good days.
  const fields = [
    ["sleep_quality", "Sleep quality", "1 = awful · 5 = great"],
    ["energy", "Energy", "1 = drained · 5 = full of beans"],
    ["stress", "Stress", "1 = calm · 5 = maxed out"],
    ["mood", "Mood", "1 = low · 5 = great"],
  ];
  const vals = { sleep_quality: 3, energy: 3, stress: 3, mood: 3 };
  const draw = () => {
    const row = ([key, label, anchors]) => `<div class="ckrow"><span class="cklabel">${label} <span class="muted" style="font-weight:400">${anchors}</span></span><div class="ckscale">${[1, 2, 3, 4, 5].map((n) =>
      `<button class="tapchip${vals[key] === n ? " sel" : ""}" data-k="${key}" data-v="${n}" aria-pressed="${vals[key] === n}" aria-label="${label} ${n} of 5">${n}</button>`).join("")}</div></div>`;
    app.innerHTML = `<h1>Quick check-in</h1><p class="muted">Tap 1 to 5 for each. This just tunes today; it's never a score or a judgment.</p>
      <div class="card">${fields.map(row).join("")}</div>
      <button class="btn" id="submitck">Save</button>
      <button class="btn ghost" id="skipck">Skip today</button>`;
    app.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => { vals[b.dataset.k] = +b.dataset.v; draw(); });
    $("#submitck").onclick = async () => {
      try { await api("/api/checkin", { method: "POST", body: JSON.stringify({ user_id: uid, ...vals }) }); say("Check-in saved."); }
      catch { say("Offline — check-in skipped."); pendingNotice = "📴 Offline — today\u2019s check-in was skipped (it only tunes today\u2019s session)."; } // never queued: a stale one would lie tomorrow
      tab = "today"; render();
    };
    $("#skipck").onclick = () => {
      // Honour the word "Skip TODAY": remember for the day so returning to the
      // Today tab doesn't immediately re-ask — optional must never nag.
      try { localStorage.setItem("hb_ck_dismissed", localDay()); } catch {}
      tab = "today"; render();
    };
  };
  draw();
}

// ---------- Session Player ----------
// A gym phone locks, iOS evicts the tab, or a thumb catches the nav bar — none of
// that may cost you sets you actually did. The live session is mirrored to
// localStorage on every change and offered back as "Resume" until it's finished or
// explicitly discarded. (Before this, an in-progress workout lived only in memory.)
const SESS_KEY = "hb_session";
const SESS_MAX_AGE_MS = 12 * 60 * 60 * 1000; // a day-old "in progress" workout isn't resumable
function saveSess() {
  try { sess ? localStorage.setItem(SESS_KEY, JSON.stringify(sess)) : localStorage.removeItem(SESS_KEY); } catch {}
}
function loadSess() {
  try {
    const s = JSON.parse(localStorage.getItem(SESS_KEY) || "null");
    if (!s || !Array.isArray(s.ex) || !s.ex.length || !Array.isArray(s.logged)) return null;
    // Age-out ONLY empty sessions. Logged sets are user data — "Nothing is lost"
    // is a literal promise, so an old half-workout keeps offering a dated
    // Save/Resume card and the USER decides; it is never silently destroyed.
    const stale = !s.startedAt || Date.now() - new Date(s.startedAt).getTime() > SESS_MAX_AGE_MS;
    if (stale && !s.logged.length) { localStorage.removeItem(SESS_KEY); return null; }
    if (stale) s.stale = true; // renderResume shows when it's from
    // REPAIR, never crash: a save interrupted at the wrong moment (or a future bug)
    // must not brick Resume — the logged sets are the valuable part. Clamp the
    // cursor into range; a past-the-end cursor means the workout was complete and
    // only the final save was cut short.
    if (!Number.isInteger(s.i) || s.i < 0) s.i = 0;
    if (s.i >= s.ex.length) { s.i = s.ex.length - 1; s.complete = true; }
    if (!Number.isInteger(s.set) || s.set < 0) s.set = 0;
    s.weights ??= {}; s.reps ??= {}; s.rir ??= {};
    return s;
  } catch { return null; }
}
function clearSess() { sess = null; try { localStorage.removeItem(SESS_KEY); } catch {} }

let sess = loadSess();      // survives a reload / tab eviction
let discardPending = false; // two-tap guard on discarding a logged workout
let quitPending = false;    // two-tap guard on ending a workout early
const rirOn = () => localStorage.getItem("hb_rir") === "1"; // optional effort logging
function startSession(templateSession) {
  sess = {
    name: templateSession.name, ex: orderSupersetAdjacent(templateSession.exercises), i: 0, set: 0,
    deload: templateSession.block?.phase === "deload" || templateSession.comeback === true, // planned-easy: block deload OR the layoff-comeback ease (0.88×) — both must stay out of e1RM/stall trends
    logged: [], weights: {}, reps: {}, rir: {},
    // The id is minted ONCE, here — so if the final save is interrupted and retried
    // after a reload, the server's ON CONFLICT dedupe sees the SAME id and the
    // workout can never be double-saved.
    session_id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    units: unitPref(), // weights below are stored in DISPLAY units — stamp which
    startedAt: new Date().toISOString(),
    // The device's LOCAL calendar day: streak/volume weeks bank to the day the
    // user experienced — a Monday-morning session in UTC+12 is Monday, not the
    // previous ISO week's Sunday (en-CA formats as YYYY-MM-DD).
    localDate: new Date().toLocaleDateString("en-CA"),
  };
  saveSess();
  renderPlayer();
}

// sess.weights are display-unit values. If the user toggles kg/lb mid-workout (the
// Me tab is reachable from the player via the nav), convert them once — otherwise
// "60" quietly changes meaning from kg to lb and every resumed weight is wrong.
function normalizeSessUnits() {
  const from = sess.units ?? unitPref(); // old blobs: assume current pref (no-op)
  if (from === unitPref()) { sess.units = from; return; }
  for (const k of Object.keys(sess.weights || {})) {
    const kg = from === "lb" ? sess.weights[k] / LB_PER_KG : sess.weights[k];
    sess.weights[k] = dispWeight(kg);
  }
  sess.units = unitPref();
  saveSess();
}
function startWeightDefault(e) {
  if (e.suggested_kg != null) return e.suggested_kg;
  // Brand-new lift → start at the empty bar / lightest option and ramp UP from
  // there. Never hand a first-timer a heavy guess (that's how form breaks).
  return { barbell: 20, dumbbell: 5, machine: 10, cable: 5, bodyweight: 0 }[e.equipment] ?? 10;
}
function topReps(range) { const m = String(range).match(/-(\d+)/); return m ? +m[1] : 10; }

// The weight control. For a bodyweight move carrying no added load, a "0 kg"
// stepper reads as broken to a novice ("do I type my bodyweight? is 0 wrong?"), so
// show that it's just them — with an opt-in to add load for weighted pull-ups/dips.
// `idx` tags the member index inside a superset station; omit it in the single
// player. The value stored is always the ADDED weight (0 = pure bodyweight), which
// is exactly what e1RM/volume expect, so nothing downstream changes.
function weightStepper(w, isBodyweight, idx) {
  const di = idx == null ? "" : ` data-i="${idx}"`;
  if (isBodyweight && w === 0) {
    return `<div class="stepper"><label>Weight</label><div class="val" style="font-size:1.05rem;font-weight:700">Bodyweight <span class="muted" style="font-weight:400">(just you)</span></div><button class="wt-add" data-w="${wInc()}"${di} aria-label="add weight">+ add weight</button></div>`;
  }
  const tag = isBodyweight ? "+" : "", suffix = isBodyweight ? " added" : "";
  return `<div class="stepper"><label>Weight</label><button data-w="-${wInc()}"${di} aria-label="less weight">–</button><div class="val" aria-live="polite">${tag}${w} ${unitLabel()}${suffix}</div><button data-w="${wInc()}"${di} aria-label="more weight">+</button></div>`;
}
// Update the value display beside a tapped stepper button IN PLACE — the aria-live
// region announces it, and the button stays in the DOM so focus survives the tap.
function setStepperVal(btn, text) { const v = btn.parentElement.querySelector(".val"); if (v) v.textContent = text; }

// ---------- Superset helpers ----------
// Pure session logic (superset ordering + banked-set progress) lives in
// session-core.mjs so it can be unit-tested in Node. These thin wrappers bind the
// live `sess` to the pure functions.
const loggedSetCount = (exId) => loggedWorkSets(sess.logged, exId);
const nextExerciseIndex = (from) => nextUnfinishedIndex(sess.logged, sess.ex, from);

// The rest countdown's interval id lives at module level so ANY navigation can
// cancel it — otherwise it fires up to two minutes later and repaints the player
// over whatever screen the user moved to.
let restTimer = null;
const stopRestTimer = () => { if (restTimer) { clearInterval(restTimer); restTimer = null; } };

function renderPlayer(resting = 0) {
  stopRestTimer();
  if (resting > 0) quitPending = false; // resting = a set was just done; reset the guard
  // A guarded belt-and-braces: loadSess repairs bad cursors, but nothing that
  // slips through may crash the recovery path for a user's unposted sets.
  if (!sess || !Array.isArray(sess.ex) || !sess.ex[sess.i]) { clearSess(); return render(); }
  normalizeSessUnits(); // kg/lb may have been toggled since the weights were stored
  const e = sess.ex[sess.i];
  const total = sess.ex.length;
  // Superset station: while BOTH paired moves still owe rounds, run them together
  // as one interleaved card. Once the paired rounds are spent (they can have
  // different set counts), fall through to the normal single-exercise path so any
  // remainder of the longer move is finished the ordinary way.
  const pIdx = e.superset_with ? sess.ex.findIndex((x) => x.exercise === e.superset_with) : -1;
  if (pIdx >= 0) {
    const L = Math.min(sess.i, pIdx), P = Math.max(sess.i, pIdx);
    if (!stationProgress(sess.logged, sess.ex, L, P).done)
      return renderSupersetStation(L, P, resting);
  }
  // Belt-and-braces: the cursor must never rest on an already-finished exercise.
  // Healthy flow advances via nextExerciseIndex, but a resumed old-build session (or
  // a defer that lands on a slot already banked during a superset station) could park
  // sess.i on a done lift — which would render a loggable "Done — set N+1 of N" and
  // bank a phantom set past the target. Progress is the truth derived from banked
  // sets, so self-heal: jump to the first lift still owing sets, or finish if none.
  if (loggedWorkSets(sess.logged, e.exercise) >= e.sets) {
    const nx = nextExerciseIndex(-1);
    if (nx < 0) { sess.complete = true; saveSess(); return finish(); }
    sess.i = nx; sess.set = loggedSetCount(sess.ex[sess.i].exercise); saveSess();
    return renderPlayer(0);
  }
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
    // Announce rest ONCE at the start (the per-second #t is not aria-live, or it
    // would spam a screen reader every tick) and move focus to the only action,
    // so a keyboard/SR user knows a timer is running and where they are.
    say(`Resting ${resting} seconds — next up, set ${sess.set + 1} of ${e.sets}, ${e.name}.`);
    $("#skip").focus();
    let left = resting;
    restTimer = setInterval(() => { left--; if ($("#t")) $("#t").textContent = left; if (left <= 0) { stopRestTimer(); say("Rest over — next set."); renderPlayer(0); } }, 1000);
    $("#skip").onclick = () => { stopRestTimer(); renderPlayer(0); };
    return;
  }

  const firstEver = e.suggested_kg == null && sess.set === 0;
  app.innerHTML = `<div class="exhead"><h1 tabindex="-1" id="ex-head">${esc(e.name)}</h1><span class="num">${sess.i + 1}/${total}</span></div>
    <p class="muted">Target: ${e.sets} sets × ${e.rep_range} reps · leave about ${e.rir} in the tank ${helpDot("glossary", "what's RIR?")}</p>
    ${e.unilateral ? `<div class="cue">↔️ One side at a time — do all ${e.sets} sets with your <b>left</b>, then repeat with your <b>right</b> (or alternate). Log the weight you used per side.</div>` : ""}
    ${e.lengthened_bias ? `<div class="cue">🎯 <b>Stretch-focused:</b> this move loads the muscle in its stretched position — where the growth signal is strongest. Feel a deep stretch at the bottom and control it; don't cut that part short.</div>` : ""}
    ${e.superset_with_name ? `<div class="cue">🔗 <b>Finishing ${esc(e.name)}:</b> you've done the paired rounds with ${esc(e.superset_with_name)} — these last set(s) are on their own, so take a normal rest.</div>` : ""}
    <div class="setdots">${setDots}</div>
    ${sess.i === 0 && sess.set === 0 ? `<div class="cue">🔥 Warm up first: 3–5 min of easy movement, then a couple of light ramp-up sets before your working sets.</div>` : ""}
    ${e.cue ? `<div class="cue">💡 ${esc(e.cue)}</div>` : ""}
    ${firstEver ? `<div class="card info"><b>New lift — let's find your weight 🎯</b>
      <p class="muted">Start light and add a little each set until the last rep is hard but clean (about ${e.rir} left in the tank). A couple of easy ramp-up sets first isn't wasted — it's how you find your number, and it's saved for next time.</p>
      <button class="btn ghost" data-learn="choosing-your-starting-weight">How to pick your starting weight</button></div>` : ""}
    <div class="card">
      ${weightStepper(w, e.equipment === "bodyweight", null)}
      <div class="stepper"><label>Reps</label><button data-r="-1" aria-label="fewer reps">–</button><div class="val" aria-live="polite">${reps}</div><button data-r="1" aria-label="more reps">+</button></div>
      ${rirOn() ? `<div class="stepper"><label>RIR</label><button data-rir="-1" aria-label="less RIR">–</button><div class="val" aria-live="polite">${rir}</div><button data-rir="1" aria-label="more RIR">+</button></div>
        <p class="muted">RIR = reps left in the tank. 2 = you could've done ~2 more.</p>` : ""}
      <button class="btn" id="done">Done — set ${sess.set + 1} of ${e.sets}</button>
    </div>
    <button class="btn ghost" id="how">How do I do this?</button>
    ${sess.set === 0 && !e.superset_with ? `<button class="btn ghost" id="swap">🔄 Swap this exercise</button>` : ""}
    ${sess.set === 0 && !e.superset_with && sess.i < total - 1 ? `<button class="btn ghost" id="later">⤵️ Do this later</button>` : ""}
    <button class="btn ghost" id="quit">${quitPending ? (sess.logged.length ? "Tap again — save what you've done and end" : "Tap again to close (nothing logged yet)") : "End workout early"}</button>`;
  wireLearnLinks();
  // Each set replaces the whole screen; without this, focus falls to <body> and
  // a keyboard user must re-Tab past every cue and stepper to reach Done. Land
  // focus on the exercise heading (tabindex=-1) so they resume at the top of the
  // new screen, and the heading name is announced to a screen reader.
  $("#ex-head")?.focus();
  if ($("#swap")) $("#swap").onclick = () => renderSwap();
  if ($("#later")) $("#later").onclick = () => deferCurrentExercise();

  // In-place stepper updates: a full repaint on every tap destroys the tapped
  // button (dumping keyboard/screen-reader focus) and never announces the new
  // value. Update the adjacent aria-live .val instead; only re-render when the
  // stepper changes SHAPE (bodyweight "+ add weight" ↔ loaded −/+ stepper).
  app.querySelectorAll("[data-w]").forEach((b) => b.onclick = () => {
    quitPending = false;
    const was = sess.weights[sess.i];
    sess.weights[sess.i] = Math.max(0, Math.round((was + +b.dataset.w) * 4) / 4);
    saveSess();
    const bw = e.equipment === "bodyweight";
    if (bw && (was === 0 || sess.weights[sess.i] === 0)) return renderPlayer();
    setStepperVal(b, `${bw ? "+" : ""}${sess.weights[sess.i]} ${unitLabel()}${bw ? " added" : ""}`);
  });
  app.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { quitPending = false; sess.reps[sess.i] = Math.max(0, sess.reps[sess.i] + +b.dataset.r); saveSess(); setStepperVal(b, sess.reps[sess.i]); });
  app.querySelectorAll("[data-rir]").forEach((b) => b.onclick = () => { quitPending = false; sess.rir[sess.i] = Math.max(0, Math.min(5, sess.rir[sess.i] + +b.dataset.rir)); saveSess(); setStepperVal(b, sess.rir[sess.i]); });
  $("#how").onclick = async () => {
    let d = null;
    try { d = await api(`/api/exercise/${e.exercise}`); } catch {}
    renderExerciseSheet(e, d);
  };
  $("#quit").onclick = () => {
    // One stray tap must not end a workout: confirm on the second tap.
    if (!quitPending) { quitPending = true; return renderPlayer(0); }
    quitPending = false;
    if (!sess.logged.length) { clearSess(); say("Workout closed — nothing was logged."); return render(); }
    finish();
  };
  $("#done").onclick = () => {
    quitPending = false; // a logged set is an unambiguous "I'm continuing"
    // Read the CURRENT sess values, not the render-time consts — the steppers now
    // update in place without re-rendering, so the consts can be stale.
    sess.logged.push({ exercise: e.exercise, set_type: "work", weight_kg: toKg(sess.weights[sess.i]), reps: sess.reps[sess.i], ...(rirOn() ? { rir: sess.rir[sess.i] } : {}), ...((sess.deload || e.eased) ? { deload: true } : {}), completed_at: new Date().toISOString() });
    sess.set++;
    if (sess.set >= e.sets) {
      sess.set = 0;
      // Never persist a past-the-end cursor: if that was the final set, the cursor
      // STAYS on the last exercise and `complete` marks the workout done. (The old
      // code saved i === ex.length; a phone dying during the final save then made
      // Resume crash forever on sess.ex[sess.i].)
      // Advance to the next exercise still owing sets — this skips anything already
      // fully logged (e.g. a superset partner completed during its station), so the
      // player can never land back on a done move and log a phantom extra set.
      const nx = nextExerciseIndex(sess.i);
      if (nx < 0) sess.complete = true; else sess.i = nx;
    }
    saveSess(); // the set is banked before anything else can go wrong
    say(`Set logged — ${sess.logged.length} so far.`);
    if (sess.complete) return finish();
    renderPlayer(sess.set === 0 ? 0 : 120); // rest timer between sets, not between exercises
  };
}

// A superset "station": the two paired moves are done together, one set of each
// per round with a short rest, exactly as the plan's cue promises. A ROUND logs
// BOTH members atomically, so progress is derived from banked sets and a crash /
// resume always lands on a clean round boundary — there is no half-round state to
// corrupt. L/P are the pair's indices in sess.ex (L < P). Only entered while both
// members still owe paired rounds; any set-count remainder of the longer move is
// finished afterwards by the normal single-exercise path.
function renderSupersetStation(L, P, resting = 0) {
  stopRestTimer();
  if (!sess || !sess.ex[L] || !sess.ex[P]) { clearSess(); return render(); }
  normalizeSessUnits();
  const A = sess.ex[L], B = sess.ex[P];
  const { paired, round, done } = stationProgress(sess.logged, sess.ex, L, P); // round is 0-indexed
  if (done) return renderPlayer(0); // defensive: paired work done → hand back

  if (resting > 0) {
    quitPending = false;
    app.innerHTML = `<div class="center"><p class="muted">Rest</p><div class="timer" id="t">${resting}</div>
      <p class="muted">Next: round ${round + 1} of ${paired} — ${esc(A.name)} + ${esc(B.name)}</p>
      <button class="btn" id="skip">I'm ready</button></div>`;
    say(`Resting ${resting} seconds — next up, round ${round + 1} of ${paired}, ${A.name} with ${B.name}.`);
    $("#skip").focus();
    let left = resting;
    restTimer = setInterval(() => { left--; if ($("#t")) $("#t").textContent = left; if (left <= 0) { stopRestTimer(); say("Rest over — next round."); renderSupersetStation(L, P, 0); } }, 1000);
    $("#skip").onclick = () => { stopRestTimer(); renderSupersetStation(L, P, 0); };
    return;
  }

  const memberBlock = (idx) => {
    const m = sess.ex[idx];
    if (sess.weights[idx] == null) sess.weights[idx] = dispWeight(startWeightDefault(m));
    if (sess.reps[idx] == null) sess.reps[idx] = topReps(m.rep_range);
    if (sess.rir[idx] == null) sess.rir[idx] = 2;
    const w = sess.weights[idx], reps = sess.reps[idx], rir = sess.rir[idx];
    return `<div class="card">
      <h2 style="margin-top:0">${esc(m.name)}</h2>
      <p class="muted">Target: ${m.sets} sets × ${m.rep_range} reps · leave about ${m.rir} in the tank</p>
      ${m.unilateral ? `<div class="cue">↔️ <b>One side at a time</b> — this round is one set with your <b>left</b> and one with your <b>right</b> (log the weight per side).</div>` : ""}
      ${m.lengthened_bias ? `<div class="cue">🎯 <b>Stretch-focused:</b> feel a deep stretch at the bottom and control it; don't cut it short.</div>` : ""}
      ${m.cue ? `<div class="cue">💡 ${esc(m.cue)}</div>` : ""}
      ${weightStepper(w, m.equipment === "bodyweight", idx)}
      <div class="stepper"><label>Reps</label><button data-r="-1" data-i="${idx}" aria-label="fewer reps">–</button><div class="val" aria-live="polite">${reps}</div><button data-r="1" data-i="${idx}" aria-label="more reps">+</button></div>
      ${rirOn() ? `<div class="stepper"><label>RIR</label><button data-rir="-1" data-i="${idx}" aria-label="less RIR">–</button><div class="val" aria-live="polite">${rir}</div><button data-rir="1" data-i="${idx}" aria-label="more RIR">+</button></div>` : ""}
      <button class="btn ghost" data-how="${idx}">How do I do this?</button>
    </div>`;
  };

  app.innerHTML = `<div class="exhead"><h1>🔗 Superset</h1><span class="num">round ${round + 1}/${paired}</span></div>
    <p class="muted">Do one set of each, back to back with little rest between them. Rest only after you've done <b>both</b> — that's one round. It fits more work into your time without the two moves competing.</p>
    ${L === 0 && round === 0 ? `<div class="cue">🔥 Warm up first: 3–5 min of easy movement, then a couple of light ramp-up sets before your working sets.</div>` : ""}
    ${memberBlock(L)}${memberBlock(P)}
    <button class="btn" id="doner">Done — round ${round + 1} of ${paired}</button>
    <button class="btn ghost" id="unlink">🔓 Station busy? Do these one at a time</button>
    <button class="btn ghost" id="quitr">${quitPending ? (sess.logged.length ? "Tap again — save what you've done and end" : "Tap again to close (nothing logged yet)") : "End workout early"}</button>`;

  // In-place stepper updates (same rationale as the single-exercise player): keep
  // the tapped button alive for focus, let aria-live announce; re-render only when
  // a bodyweight stepper changes shape. #doner reads sess.* at click time already.
  app.querySelectorAll("[data-w]").forEach((b) => b.onclick = () => {
    quitPending = false;
    const i = +b.dataset.i, was = sess.weights[i];
    sess.weights[i] = Math.max(0, Math.round((was + +b.dataset.w) * 4) / 4);
    saveSess();
    const bw = sess.ex[i].equipment === "bodyweight";
    if (bw && (was === 0 || sess.weights[i] === 0)) return renderSupersetStation(L, P, 0);
    setStepperVal(b, `${bw ? "+" : ""}${sess.weights[i]} ${unitLabel()}${bw ? " added" : ""}`);
  });
  app.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { quitPending = false; const i = +b.dataset.i; sess.reps[i] = Math.max(0, sess.reps[i] + +b.dataset.r); saveSess(); setStepperVal(b, sess.reps[i]); });
  app.querySelectorAll("[data-rir]").forEach((b) => b.onclick = () => { quitPending = false; const i = +b.dataset.i; sess.rir[i] = Math.max(0, Math.min(5, sess.rir[i] + +b.dataset.rir)); saveSess(); setStepperVal(b, sess.rir[i]); });
  app.querySelectorAll("[data-how]").forEach((b) => b.onclick = async () => {
    const m = sess.ex[+b.dataset.how];
    let d = null; try { d = await api(`/api/exercise/${m.exercise}`); } catch {}
    renderExerciseSheet(m, d); // its "Back" calls renderPlayer(0), which re-routes here
  });
  $("#doner").onclick = () => {
    quitPending = false; // a logged round is an unambiguous "I'm continuing"
    for (const idx of [L, P]) { // both members of the round, banked together
      const m = sess.ex[idx];
      sess.logged.push({ exercise: m.exercise, set_type: "work", weight_kg: toKg(sess.weights[idx]), reps: sess.reps[idx], ...(rirOn() ? { rir: sess.rir[idx] } : {}), ...((sess.deload || m.eased) ? { deload: true } : {}), completed_at: new Date().toISOString() });
    }
    say(`Round logged — ${sess.logged.length} sets so far.`);
    if (!stationProgress(sess.logged, sess.ex, L, P).done) { saveSess(); return renderSupersetStation(L, P, 60); }
    // Paired rounds done. Advance to the FIRST still-unfinished exercise ANYWHERE
    // (scan from -1). This one rule covers every follow-on: a set-count remainder of
    // the longer paired move (it's the earliest unfinished, so it's picked and the
    // normal path finishes it), and — for a session started by an OLD build, before
    // the adjacency reorder shipped — an exercise sitting BETWEEN a non-adjacent
    // pair (also earliest-unfinished, so never jumped past). "Nothing is lost" holds
    // across the deploy. -1 = the whole session is done.
    const nx = nextExerciseIndex(-1);
    if (nx < 0) { sess.complete = true; sess.i = Math.max(L, P); sess.set = 0; saveSess(); return finish(); }
    sess.i = nx; sess.set = loggedSetCount(sess.ex[nx].exercise);
    saveSess();
    // A rest only when the next move is this pair's own remainder (it follows the
    // last round); moving on to a fresh exercise starts clean, like any handoff.
    renderPlayer(nx === L || nx === P ? 60 : 0);
  };
  $("#unlink").onclick = () => {
    // The busy-machine escape hatch: a superset needs TWO stations free at once —
    // the most likely place to get stuck. Unlinking clears the pairing on both
    // members so they fall through to the ordinary single-exercise path, which has
    // the full toolkit (swap, defer, own rest timers). Safe at any round: progress
    // is derived from banked sets per exercise, so each member resumes exactly
    // where it left off. Session-only — the saved plan is untouched.
    quitPending = false;
    for (const idx of [L, P]) { const m = sess.ex[idx]; m.superset_with = undefined; m.superset_with_name = undefined; }
    // Land on the first member still owing sets (both may be mid-way through).
    const target = loggedWorkSets(sess.logged, sess.ex[L].exercise) < sess.ex[L].sets ? L : P;
    sess.i = target; sess.set = loggedSetCount(sess.ex[target].exercise);
    saveSess();
    say("Unlinked — do them one at a time. Take a normal rest between sets.");
    renderPlayer(0);
  };
  $("#quitr").onclick = () => {
    if (!quitPending) { quitPending = true; return renderSupersetStation(L, P, 0); }
    quitPending = false;
    if (!sess.logged.length) { clearSess(); say("Workout closed — nothing was logged."); return render(); }
    finish();
  };
}
// The "how do I do this?" sheet: full cues + mistakes from the KB, and a form-
// video search — an honest stand-in until we have vetted demo media of our own.
const BIAS_LABEL = { lengthened: "loads the stretch 🎯", shortened: "loads the squeeze", "mid-range": "hardest mid-range", uniform: "even resistance" };
function renderExerciseSheet(ex, d) {
  const name = d?.name ?? ex.name;
  const steps = (d?.execution_steps ?? []).map((s, i) => `<div class="win"><b>${i + 1}.</b> ${esc(s)}</div>`).join("");
  const cues = (d?.cues ?? []).map((c) => `<div class="win">✅ ${esc(c)}</div>`).join("");
  const errs = (d?.common_errors ?? []).map((c) => `<div class="win">⚠️ ${esc(c)}</div>`).join("");
  const good = (d?.good_when ?? []).map((c) => `<div class="win">👍 ${esc(c)}</div>`).join("");
  const bad = (d?.bad_when ?? []).map((c) => `<div class="win">👎 ${esc(c)}</div>`).join("");
  const muscles = friendlyMuscles([...(d?.primary_muscles ?? []), ...(d?.secondary_muscles ?? [])]);
  // quick fact chips: loading bias, systemic fatigue, difficulty
  const chips = [
    d?.loading_bias ? BIAS_LABEL[d.loading_bias] : null,
    d?.cns_cost ? `${d.cns_cost} systemic fatigue` : null,
    d?.difficulty ? d.difficulty : null,
  ].filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join(" ");
  const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(name + " proper form")}`;
  app.innerHTML = `<h1>${esc(name)}</h1>
    ${muscles ? `<p class="muted">Works: ${esc(muscles)}</p>` : ""}
    ${chips ? `<p>${chips}</p>` : ""}
    ${d?.resistance_profile ? `<p class="muted">📈 <b>Where it's hardest:</b> ${esc(d.resistance_profile)}</p>` : ""}
    ${steps ? `<h2>Step by step</h2>${steps}` : ""}
    ${cues ? `<h2>Coaching cues</h2>${cues}` : (!steps ? `<p class="muted">No cues on file for this one.</p>` : "")}
    ${errs ? `<h2>Avoid</h2>${errs}` : ""}
    ${good ? `<h2>Good pick when</h2>${good}` : ""}
    ${bad ? `<h2>Maybe skip when</h2>${bad}` : ""}
    <p class="muted">Want to see it? This opens a YouTube search in a new tab — pick a clear, calm demo (avoid ego-lifting clips).</p>
    <a class="btn secondary" style="text-align:center;text-decoration:none;display:block" href="${yt}" target="_blank" rel="noopener">▶ Find a form video</a>
    <button class="btn" id="back">Back to workout</button>`;
  $("#back").onclick = () => renderPlayer(0);
}

// Mid-workout swap: the machine's taken, or you just want a different lift today.
// Only reachable before any set of the current exercise is logged (guarded in the
// player), so the swap is clean — we replace this slot's exercise, keep its sets/
// reps/RIR target, and reset the weight (a fresh lift you pick a weight for). It's
// a TEMPORARY, session-only change — the saved plan is untouched.
async function renderSwap() {
  const cur = sess.ex[sess.i];
  app.innerHTML = `<h1>Swap exercise</h1><p class="muted">Loading alternatives…</p>`;
  let all = [];
  try { all = await api(`/api/exercises`); } catch {}
  const inSession = new Set(sess.ex.map((x) => x.exercise));
  // Same primary muscle(s), the user's own equipment (the endpoint is already
  // equipment + injury filtered), not the current lift, not already in the session.
  const curMuscles = new Set(cur.primary_muscles ?? []);
  const alts = all.filter((x) => x.id !== cur.exercise && !inSession.has(x.id)
    && (x.primary_muscles ?? []).some((m) => curMuscles.has(m)));
  if (!alts.length) {
    app.innerHTML = `<h1>Swap exercise</h1>
      <div class="card"><p>No alternative for the same muscle with your equipment right now.</p>
      <p class="muted">Keep going with ${esc(cur.name)}${sess.i < sess.ex.length - 1 ? " — or push it to the end of the workout with “⤵️ Do this later” and move on" : ""}.</p></div>
      <button class="btn" id="back">Back to ${esc(cur.name)}</button>`;
    $("#back").onclick = () => renderPlayer(0);
    return;
  }
  const rows = alts.slice(0, 20).map((x) => `<button class="choice" data-swap="${esc(x.id)}" data-name="${esc(x.name)}">${esc(x.name)} <span class="muted">${esc(friendlyMuscles(x.primary_muscles))}</span></button>`).join("");
  app.innerHTML = `<h1>Swap ${esc(cur.name)}</h1>
    <p class="muted">Pick a replacement that trains the same muscle. Just for today — your saved plan doesn't change.</p>
    ${rows}
    <button class="btn ghost" id="back">Keep ${esc(cur.name)}</button>`;
  $("#back").onclick = () => renderPlayer(0);
  app.querySelectorAll("[data-swap]").forEach((b) => b.onclick = () => {
    const id = b.dataset.swap, name = b.dataset.name;
    const chosen = alts.find((x) => x.id === id);
    // Replace the slot in place: keep the prescription (sets/rep_range/rir), swap the
    // exercise + its display fields, and treat it as a fresh lift (no suggested_kg,
    // so the player prompts for a starting weight). Reset this slot's cached inputs.
    sess.ex[sess.i] = {
      ...cur, exercise: id, name,
      primary_muscles: chosen?.primary_muscles ?? [],
      equipment: chosen?.equipment ?? null,
      // Carry the new lift's own coaching cues (the endpoint now returns them) — a
      // unilateral or stretch-focused replacement keeps its "each side" / "🎯
      // stretch-focused" guidance instead of inheriting a blank.
      suggested_kg: null, cue: null,
      unilateral: !!chosen?.unilateral, lengthened_bias: !!chosen?.lengthened_bias,
      superset_with: undefined, superset_with_name: undefined,
    };
    delete sess.weights[sess.i]; delete sess.reps[sess.i]; delete sess.rir[sess.i];
    saveSess();
    say(`Swapped to ${name}.`);
    renderPlayer(0);
  });
}

// "Do this later" (mid-workout reorder): the machine's busy, so push the current
// UNSTARTED exercise to the end of the queue and move on. Only reachable at set 0
// of a non-superset lift with a later exercise to land on (guarded in the player).
// sess.weights/reps/rir are keyed by ARRAY INDEX, so moving an item must REMAP those
// caches or the steppers would show the wrong defaults. Logged sets are keyed by
// exercise id, so they stay valid — no data is ever at risk here.
function deferCurrentExercise() {
  const i = sess.i, last = sess.ex.length - 1;
  if (i >= last) return; // nothing to move it ahead of
  const [moved] = sess.ex.splice(i, 1);
  sess.ex.push(moved);
  // Shift index-keyed caches to follow their exercises: keys < i unchanged, key i
  // moves to the new last slot, keys > i shift down by one.
  const remap = (cache) => {
    const out = {};
    for (const [k, v] of Object.entries(cache || {})) {
      const idx = +k;
      if (idx < i) out[idx] = v;
      else if (idx === i) out[last] = v;
      else out[idx - 1] = v;
    }
    return out;
  };
  sess.weights = remap(sess.weights); sess.reps = remap(sess.reps); sess.rir = remap(sess.rir);
  // sess.i stays put — it now points at the exercise that was next; the deferred lift
  // waits at the end. Resume its cursor from however many of its sets are already
  // banked (0 in the normal unstarted case), matching how advancing resolves the set
  // pointer everywhere else — never blindly reset a partially-logged lift to set 0.
  sess.set = loggedSetCount(sess.ex[sess.i].exercise);
  saveSess();
  say(`Moved ${moved.name} to the end — you'll come back to it.`);
  renderPlayer(0);
}

async function finish() {
  if (!sess || !sess.logged.length) { clearSess(); return render(); }
  app.innerHTML = `<div class="center" style="padding-top:20vh"><h1>Saving…</h1></div>`;
  // REUSE the id minted at startSession: if this save was interrupted and is being
  // retried after a reload, the server's ON CONFLICT dedupe makes it a no-op rather
  // than a duplicate workout. (Minting a fresh id here would double-save.)
  const session_id = sess.session_id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // Date the workout by when it was DONE, not when the save finally lands — a
  // Tuesday session rescued on Thursday belongs to Tuesday's week.
  const payload = { session_id, date: sess.startedAt || new Date().toISOString(), local_date: sess.localDate ?? null, user_id: uid, session_name: sess.name, sets: sess.logged };
  const res = await postOrQueue("/api/session", payload);
  if (!res.ok && !res.queued) {
    // Network AND the offline queue both failed (storage full/blocked). The one
    // thing we must not do is drop the workout — keep the in-progress copy and
    // let the user retry.
    app.innerHTML = `<div class="center" style="padding-top:16vh"><h1>Couldn't save yet</h1>
      <p>Your workout is still safe on this phone.</p>
      <button class="btn" id="retrysave">Try saving again</button></div>`;
    $("#retrysave").onclick = finish;
    return;
  }
  // Accepted or safely queued — now it's safe to drop the in-progress copy.
  clearSess();
  // Today's training is done, so the check-in can no longer tune anything —
  // don't re-offer it when Recap routes back to Today.
  try { localStorage.setItem("hb_ck_dismissed", localDay()); } catch {}
  say(res.ok ? "Workout saved." : "Offline — workout saved on this phone and will sync.");
  renderRecap(res.ok ? res.data : { wins: ["📴 You're offline — workout saved on this phone. It'll sync automatically when you're back online."] });
}
function renderRecap(recap) {
  // Weight deltas need finer rounding than plate-rounding (a +1 kg PR is 2.2 lb, not 0).
  const fmtDelta = (kg) => unitPref() === "lb" ? Math.round(kg * LB_PER_KG * 10) / 10 : kg;
  const winHtml = (w) => typeof w === "string"
    ? esc(w)
    : `🏆 ${esc(w.name)}: new estimated best single lift — <b>${dispWeight(w.e1rm_kg)} ${unitLabel()}</b> (up ${fmtDelta(w.delta_kg)} ${unitLabel()}).`;
  const wins = (recap.wins || []).map((w) => `<div class="win">${winHtml(w)}</div>`).join("");
  const nudge = !localStorage.getItem("hb_email")
    ? `<div class="card"><b>Keep this progress safe</b>
        <p class="muted">Create your free account with just an email — no password, ever. It protects today's workout if you lose this phone, and syncs to any device.</p>
        <button class="btn secondary" id="backup">Create my account</button></div>`
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
const statusClass = (s) => ({ "below-MEV": "s-below", "in-productive-range": "s-in", "approaching-MRV": "s-near", "over-MRV": "s-over", "maintenance": "s-maint" }[s] || "s-none");
const statusLabel = (s) => ({ "below-MEV": "add volume", "in-productive-range": "on target", "approaching-MRV": "near max", "over-MRV": "over max", "maintenance": "holding steady", "no-landmark": "—" }[s] || s);
async function renderProgress() {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let p;
  try { p = await api(`/api/progress`); }
  catch {
    app.innerHTML = `<h1>Progress</h1><div class="card"><p>📴 You're offline.</p>
      <p class="muted">Your progress will load when you're back online. Anything logged offline is saved and will sync.</p>
      <button class="btn" id="retry-prog">Try again</button></div>`;
    $("#retry-prog").onclick = () => renderProgress();
    return;
  }
  const vol = (p.volumeByMuscle || []).map((m) => {
    const pct = Math.min(100, (m.sets / 24) * 100);
    return `<div class="row"><div style="flex:1"><b>${esc(m.id ? cap(friendlyMuscle(m.id)) : m.muscle)}</b> <span class="muted">${m.sets} set${m.sets === 1 ? "" : "s"}/wk</span>
      <div class="bar"><i style="width:${pct}%;background:var(--accent)"></i></div></div>
      <span class="status ${statusClass(m.status)}">${statusLabel(m.status)}</span></div>`;
  }).join("") || `<p class="muted">Log a workout to see your weekly volume.</p>`;
  // Load-basis rows (pump-band lifts, 12-20 reps) chart the top-set weight —
  // an e1RM there would be guesswork, but the dumbbell you hold is not.
  const prog = (p.progression || []).map((x) => `<div class="row"><b>${esc(x.name)}${x.stalled ? ' <span class="chip" style="color:var(--warn)">⏸ stalled</span>' : ""}</b><span class="${x.change_pct >= 0 ? "" : "muted"}">${x.basis === "load" ? `${dispWeight(x.first_load_kg)}→${dispWeight(x.last_load_kg)} ${unitLabel()} top set` : `${dispWeight(x.first_e1rm)}→${dispWeight(x.last_e1rm)} ${unitLabel()}`} (${x.change_pct >= 0 ? "+" : ""}${x.change_pct}%)</span></div>`).join("") || `<p class="muted">Two weeks of data unlocks strength trends.</p>`;
  // A plateau gets an honest, KB-grounded playbook — not "add a rep" forever.
  const stallCard = (p.stalls || []).length
    ? `<div class="card"><b>⏸ ${p.stalls.length === 1 ? "One lift has" : p.stalls.length + " lifts have"} plateaued</b>
        <p class="muted">${esc(p.stalls.map((s) => s.name).join(", "))} — flat for ~${p.stalls[0].weeks_flat} weeks. That's normal, and fixable. In order: 1) check sleep and food first, 2) swap the exercise for a cousin (same muscle, new angle) in the plan editor, 3) push those sets a rep closer to failure. ${""}</p>
        <button class="btn ghost" data-learn="breaking-advanced-plateaus">Read: Breaking plateaus</button></div>`
    : "";
  // Adaptive volume-response coaching (#2 foundation): the plan reading your own
  // logged data and suggesting where to add, ease, or change volume — bounded to
  // your recoverable range. Advice only; you decide, and you can act via the plan
  // editor. Quiet until there's enough data to say something actionable.
  const SIGNAL_ICON = { add: "➕", reduce: "➖", change: "🔄" };
  const adaptiveCard = (p.adaptive || []).length
    ? `<h2>What to adjust ${helpDot("glossary", "?")}</h2>
       <p class="muted">Based on how your logged sets are actually progressing — tune these in the plan editor. Suggestions, not orders.</p>
       <div class="card">${p.adaptive.map((a) => `<div class="row"><div style="flex:1"><b>${SIGNAL_ICON[a.signal] || "•"} ${esc(cap(friendlyMuscle(a.muscle)))}</b><br><span class="muted" style="font-size:.9rem">${esc(a.advice)}</span></div></div>`).join("")}</div>`
    : "";
  const t = p.bodyweight_trend;
  const slopeDisp = t ? (unitPref() === "lb" ? Math.round(t.slope_kg_per_week * LB_PER_KG * 100) / 100 : t.slope_kg_per_week) : 0;
  const eb = p.energy_balance || {};
  app.innerHTML = `<h1>Progress</h1>
    <div class="card"><b>${p.sessions_logged}</b> <span class="muted">session${p.sessions_logged === 1 ? "" : "s"} logged</span></div>
    <h2>Weekly sets per muscle ${helpDot("glossary", "?")}</h2>
    <p class="muted">${p.volume_note ? esc(p.volume_note) : "How many hard sets each muscle got this week, and whether that's in the range that builds muscle."}</p>
    <div class="card">${vol}</div>
    ${p.volumeByMuscle && p.volumeByMuscle.length ? STATUS_LEGEND : ""}
    ${adaptiveCard}
    ${stallCard}
    <h2>Your best lifts (estimated) ${helpDot("glossary", "?")}</h2>
    <p class="muted">The most you could likely lift for one rep, estimated from your sets. Watch the trend, not the exact number.</p>
    <div class="card">${prog}</div>
    <h2>Bodyweight & energy balance</h2>
    <div class="card">
      ${t ? `<p><b>${slopeDisp >= 0 ? "+" : ""}${slopeDisp} ${unitLabel()}/week</b> <span class="muted">(${t.pct_per_week}%/wk)</span></p>
        <p class="muted">${esc(eb.suggestion || "")}</p>` : `<p class="muted">Add a few bodyweights to infer your energy balance — no calorie counting needed.</p>`}
      <div class="stepper"><label for="bw">Log weight</label><input id="bw" type="number" step="0.1" inputmode="decimal" placeholder="${unitLabel()}" style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.1rem"></div>
      <button class="btn secondary" id="logbw">Add today's weight</button>
    </div>`;
  wireLearnLinks();
  $("#logbw").onclick = async () => {
    const val = parseFloat($("#bw").value);
    // Never a silent dead button: an empty/non-numeric field must say why nothing
    // happened, or the tap reads as broken.
    if (!val || val <= 0) { say("Type your weight first."); $("#bw").placeholder = `type a number first (${unitLabel()})`; $("#bw").focus(); return; }
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
  // This IS the account system — passwordless by design (an email-bound identity
  // with magic-link sign-in and cross-device restore). Present it as one.
  const backup = email
    ? `<div class="card"><p class="muted">Your account</p><b>${esc(email)}</b> <span class="chip">✓ signed in</span>
        <p class="muted" style="margin-top:8px">Your progress is saved to this account. On any other device, open the app, tap "Restore", and enter this email to pick up where you left off. No password — sign-in links come to your inbox.</p></div>`
    : `<div class="card"><p class="muted">Create your account</p>
        <p>One email — <b>no password, ever</b>. It keeps your progress safe if you lose this phone, and syncs it to any other device.</p>
        <input id="bemail" type="email" inputmode="email" autocomplete="email" aria-label="Email address for your account" placeholder="you@email.com"
          style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:8px 0 4px">
        <button class="btn" id="sendlink">Create my account</button>
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
    <div class="card"><p class="muted">Training settings</p>
      <p>Got stronger? New gym? More (or fewer) days free? Update your answers and I'll rebuild your plan around them.</p>
      <button class="btn secondary" id="settings">Update my settings &amp; rebuild plan</button></div>
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
  $("#settings").onclick = renderSettings;
  $("#rirtoggle").onclick = () => { localStorage.setItem("hb_rir", rirOn() ? "0" : "1"); renderMe(); };
  $("#unittoggle").onclick = () => { localStorage.setItem("hb_units", unitPref() === "lb" ? "metric" : "imperial"); renderMe(); };

  if (!email) {
    $("#sendlink").onclick = async () => {
      const val = $("#bemail").value.trim();
      if (!val) { $("#bmsg").textContent = "Enter your email first."; return; }
      $("#sendlink").disabled = true;
      $("#bmsg").textContent = "Sending…";
      let r; try { r = await api("/api/auth/request", { method: "POST", body: JSON.stringify({ email: val, user_id: uid }) }); }
      catch { $("#bmsg").textContent = "📴 You're offline — try again when you have signal."; $("#sendlink").disabled = false; return; }
      if (r.error === "invalid-email") { $("#bmsg").textContent = "That doesn't look like an email."; $("#sendlink").disabled = false; return; }
      if (r.sent === false) { $("#bmsg").textContent = "Couldn't send right now — try again in a moment."; $("#sendlink").disabled = false; return; }
      $("#bmsg").innerHTML = "Check your inbox for a link to finish — it works once and expires in 30 minutes."
        + (r.dev_link ? ` <a href="${esc(r.dev_link)}">[dev link]</a>` : "");
    };
  }
  $("#reset").onclick = () => {
    // Never destroy unsaved training silently: a workout still in the offline
    // queue (never reached the server) or an in-progress session's banked sets
    // would be gone forever — the generic "backed-up data stays safe" reassurance
    // is a lie for those. Name the risk explicitly before erasing.
    const queued = getQueue().length;
    const inProgress = sess?.logged?.length ?? 0;
    // Name every risk that actually applies, in honest terms — the queue can hold
    // workouts AND bodyweight weigh-ins, so "a logged workout" would sometimes lie.
    const risks = [];
    if (inProgress) risks.push("an in-progress workout");
    if (queued) risks.push("unsynced training data that hasn't reached the server yet");
    const warn = risks.length
      ? `⚠️ You have ${risks.join(" and ")} on this device. Resetting DELETES ${risks.length > 1 ? "them" : "it"} permanently — ${risks.length > 1 ? "they are" : "it is"} NOT in any backup. Erase anyway?`
      : "Erase this device's link to your data and start over? If you've backed up to an email, that stays safe and you can restore it.";
    if (confirm(warn)) {
      // clearSess() first: localStorage.clear() alone leaves the in-memory `sess`
      // alive, and the next identity's Today would offer to "resume" (and post!)
      // the previous user's half-done workout.
      clearSess();
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
  let a; try { a = await api(`/api/adherence`); } catch {
    app.innerHTML = `<h1>Coach</h1><div class="card"><p>📴 You're offline.</p><p class="muted">Your streak and XP are safe — they'll show as soon as you reconnect.</p>
      <button class="btn" id="retry-coach">Try again</button></div>`;
    $("#retry-coach").onclick = () => renderCoach();
    return;
  }
  const m = a.milestones || {};
  const badges = (m.reached || []).map((x) => `<span class="chip">✓ ${x.at}</span>`).join(" ");
  const paused = a.paused;
  app.innerHTML = `<h1>Coach</h1>
    <div class="card center">
      <div class="big">${a.sessions_logged === 0 ? "🌱 Your streak starts with your first session" : `🔥 ${a.streak_weeks} week${a.streak_weeks === 1 ? "" : "s"} strong`}</div>
      <div class="bar" style="margin:12px 0"><i style="width:${a.level_progress_pct}%;background:var(--accent)"></i></div>
      ${a.sessions_logged === 0 ? "" : `<p class="muted">Level ${a.level} · ${a.xp} XP · ${a.xp_to_next} to level ${a.level + 1}</p>
      <p class="muted">${a.sessions_logged} sessions logged · ${a.week.sessions} this week</p>`}</div>
    ${m.latest ? `<div class="card"><b>🏅 ${esc(m.latest.msg)}</b>${m.next ? `<p class="muted" style="margin-top:8px">Next up: ${esc(m.next.msg)}</p>` : ""}</div>` : ""}
    ${badges ? `<div class="card"><p class="muted">Milestones reached</p>${badges}</div>` : ""}
    <h2>Schedule your sessions</h2>
    <div class="card"><p class="muted">The single biggest lever for consistency: put your sessions in your calendar.</p>
      <div id="days" style="margin:8px 0"></div>
      <div class="stepper"><label for="sched-time">Time</label><input id="sched-time" type="time" value="18:00" style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:1.05rem"></div>
      <button class="btn secondary" id="addcal">Add to my calendar</button>
      <p class="muted" id="calmsg"></p></div>
    <h2>Injury or illness?</h2>
    <div class="card"><p>${paused ? "You're paused — heal up. Your streak is safe and I won't nudge you." : "Pause any time. Nothing's ever at stake — never train through pain or sickness."}</p>
      <button class="btn ${paused ? "" : "secondary"}" id="pause">${paused ? "I'm ready — resume" : "Pause (I'm sick or injured)"}</button></div>
    <h2>Reminders</h2>
    ${localStorage.getItem("hb_email")
      ? `<div class="card"><p class="muted">${a.reminders_off ? "Email reminders are off. Your progress stays safely backed up either way." : "If you drift away, I'll email your account at most two gentle notes per break — never while you're paused."}</p>
      <button class="btn secondary" id="nudges">${a.reminders_off ? "Turn reminders on" : "Turn reminders off"}</button></div>`
      : `<div class="card"><p class="muted">Reminders arrive by email. Create your free account (just an email — no password, ever) and if you drift away I'll send at most two gentle notes per break.</p>
      <button class="btn secondary" id="nudges-acct">Create my account</button></div>`}
    ${pushSupported()
      ? `<div class="card"><p class="muted">${localStorage.getItem("hb_push") === "1" ? "Device reminders are on — a quiet nudge when a session's waiting, never while paused." : "Or get a reminder right on this device — no email needed. One gentle nudge when a session's waiting; stops while you're paused and after ~3 weeks."}</p>
      <button class="btn secondary" id="pushbtn">${localStorage.getItem("hb_push") === "1" ? "Turn device reminders off" : "Enable device reminders"}</button>
      <p class="muted" id="pushmsg"></p></div>`
      : isIOS() && !isStandalone()
        ? `<div class="card"><p class="muted">Want a reminder right on this iPhone? Add the app to your Home Screen first — tap the <b>Share</b> button (the square with an arrow pointing up) at the bottom of Safari, then <b>Add to Home Screen</b>. Open it from there and device reminders unlock.</p></div>`
        : ""}`;
  const sel = new Set();
  const DAYNAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  $("#days").innerHTML = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<button class="tapchip" data-day="${i}" aria-pressed="false" aria-label="${DAYNAMES[i]}">${d}</button>`).join(" ");
  $("#days").querySelectorAll("[data-day]").forEach((b) => b.onclick = () => {
    const i = +b.dataset.day;
    // This picker never re-renders, so a screen reader gets no feedback from the
    // colour change alone — mirror the state into aria-pressed AND announce it.
    if (sel.has(i)) { sel.delete(i); b.style.background = ""; b.style.color = ""; b.setAttribute("aria-pressed", "false"); say(`${DAYNAMES[i]} removed`); }
    else { sel.add(i); b.style.background = "var(--accent)"; b.style.color = "#06210f"; b.setAttribute("aria-pressed", "true"); say(`${DAYNAMES[i]} added`); }
  });
  $("#addcal").onclick = () => { if (!sel.size) { $("#calmsg").textContent = "Pick at least one day first."; return; } downloadTrainingCalendar([...sel], $("#sched-time").value); $("#calmsg").textContent = "Calendar file downloaded — open it to add recurring reminders."; };
  // Toggles announce + restore focus: renderCoach() replaces the whole screen,
  // which destroys the tapped button (focus drops to body) — the same reason the
  // day-picker chips above announce via say() instead of relying on colour.
  $("#pause").onclick = async () => {
    try {
      await api("/api/pause", { method: "POST", body: JSON.stringify({ user_id: uid, on: !paused }) });
      say(paused ? "Resumed. Welcome back." : "Paused — heal up. Your streak is safe.");
      await renderCoach(); $("#pause")?.focus();
    } catch { alertBar("📴 Couldn't update the pause — you're offline. Try again when connected."); }
  };
  const nudgeBtn = $("#nudges");
  if (nudgeBtn) nudgeBtn.onclick = async () => {
    try {
      await api("/api/reminders", { method: "POST", body: JSON.stringify({ user_id: uid, off: !a.reminders_off }) });
      say(a.reminders_off ? "Reminders turned on." : "Reminders turned off.");
      await renderCoach(); $("#nudges")?.focus();
    } catch { alertBar("📴 Couldn't update reminders — you're offline. Try again when connected."); }
  };
  const acctBtn = $("#nudges-acct");
  if (acctBtn) acctBtn.onclick = () => { tab = "me"; render(); };
  const pushBtn = $("#pushbtn");
  if (pushBtn) pushBtn.onclick = async () => {
    const msg = (t) => { $("#pushmsg").textContent = t; };
    try {
      const reg = await navigator.serviceWorker.ready;
      if (localStorage.getItem("hb_push") === "1") {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint, user_id: uid }) }).catch(() => {}); await sub.unsubscribe(); }
        localStorage.removeItem("hb_push");
        say("Device reminders turned off."); await renderCoach(); $("#pushbtn")?.focus(); return;
      }
      const { key } = await api("/api/push/key");
      if (!key) { msg("Device reminders aren't available right now."); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { msg("No problem — you can enable notifications any time in your browser settings."); return; }
      // base64url -> Uint8Array for applicationServerKey
      const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
      const appKey = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ user_id: uid, subscription: sub.toJSON() }) });
      localStorage.setItem("hb_push", "1");
      say("Device reminders on."); await renderCoach(); $("#pushbtn")?.focus();
    } catch { msg("📴 Couldn't set up device reminders — try again when you're online."); }
  };
}

// ---------- Learn (the beginner on-ramp library, bundled + offline) ----------
async function renderLearn() {
  learnSlug = null;
  app.innerHTML = `<h1>Learn</h1><p class="muted">Loading…</p>`;
  let LEARN_INDEX;
  try { ({ LEARN_INDEX } = await learnData()); }
  catch { app.innerHTML = `<h1>Learn</h1><div class="card"><p>📴 Couldn't load the guides.</p><p class="muted">Connect once and they'll be saved on this device for good.</p></div>`; return; }
  let deeperShown = false;
  const cats = LEARN_INDEX.map((c) => {
    // One divider where the beginner on-ramp ends and the full evidence base begins.
    const divider = c.tier === "deeper" && !deeperShown
      ? (deeperShown = true, `<div class="card tldr" style="margin-top:26px"><b>🔬 Go deeper — the science library</b>
          <p class="muted" style="margin:6px 0 0">The full evidence base behind your plan: every claim graded A–D by strength of evidence. Read what interests you — none of it is required to train well.</p></div>`)
      : "";
    return `${divider}<h2>${esc(c.category)}</h2><div class="card">${
      c.items.map((it) => `<button class="choice" data-learn="${esc(it.slug)}"><span style="flex:1"><b>${esc(it.title)}</b>${it.desc ? `<br><span class="muted">${esc(it.desc)}</span>` : ""}</span><span>›</span></button>`).join("")
    }</div>`;
  }).join("");
  app.innerHTML = `<h1>Learn</h1>
    <p class="muted">Never been to a gym? Start at the top and read a couple. Every term, every worry, answered plainly — and it all works offline.</p>${cats}`;
  wireLearnLinks();
  window.scrollTo(0, 0);
}
async function renderLearnPage(slug) {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let LEARN_PAGES;
  try { ({ LEARN_PAGES } = await learnData()); }
  catch { app.innerHTML = `<div class="card"><p>📴 Couldn't load that guide.</p><p class="muted">Connect once and it'll be saved on this device.</p></div>`; return; }
  const pg = LEARN_PAGES[slug];
  if (!pg) { learnSlug = null; return renderLearn(); }
  // Mid-workout help ("what's RIR?", starting-weight guide) lands here with a live
  // session running. The way back must be one obvious tap — not "find the Today
  // tab, then find Resume" while standing at a bench between sets.
  const workoutBack = sess ? `<button class="btn" id="backToWorkout">◀ Back to workout</button>` : "";
  app.innerHTML = `${workoutBack}<button class="btn ghost" id="learnback">‹ All topics</button>
    <h1>${esc(pg.title)}</h1>
    ${pg.tldr ? `<div class="card tldr"><b>In short</b> ${pg.tldr}</div>` : ""}
    <div class="learn">${pg.html}</div>
    ${workoutBack ? `<button class="btn" id="backToWorkout2">◀ Back to workout</button>` : ""}
    <button class="btn ghost" id="learnback2">‹ Back to all topics</button>`;
  const backToPlayer = () => { tab = "today"; learnSlug = null; nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab)); renderPlayer(0); };
  if ($("#backToWorkout")) $("#backToWorkout").onclick = backToPlayer;
  if ($("#backToWorkout2")) $("#backToWorkout2").onclick = backToPlayer;
  $("#learnback").onclick = renderLearn;
  $("#learnback2").onclick = renderLearn;
  wireLearnLinks(); // in-page cross-links between pages
  window.scrollTo(0, 0);
}

// ---------- Router ----------
function render() {
  stopRestTimer(); // leaving the player must always cancel the pending repaint
  settingsMode = false; // navigating away abandons an in-progress settings edit cleanly
  quitPending = false;
  discardPending = false; // an armed Discard must not survive a trip to another tab
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
