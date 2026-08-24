// The Hypertrophy Bible — brainless client. One decision per screen; everything
// higher-order is derived server-side. No build step, no framework.
import { orderSupersetAdjacent, loggedWorkSets, nextUnfinishedIndex, stationProgress, dropDelivered, checkSetPR, checkLuckySet, LUCKY_SET_XP, rankPartners, weeklyRaceStatus, formatWeekLabel, isImplausibleSet, unconfirmedFlagged } from "/session-core.mjs";
import { renderMovementDemo } from "/movement-demo.mjs";
import { groupSessionsByWeek, weekLabelOf, seedCalendarDays, filterExercises, linePath } from "/ui-helpers.mjs";
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const nav = $("#nav");
let uid = localStorage.getItem("hb_user");
let tab = "today";
let learnSlug = null; // which Learn page is open (null = the Learn index)
let learnStack = []; // traversal history WITHIN Learn — lets ‹ Back pop to the previous page
let learnExercise = null; // a data sheet open OVER a Learn page: {kind,id} or null
// Session-only: the plan-screen email form has been submitted. Deliberately not
// localStorage and deliberately not `hb_email` — an account exists only once the
// emailed link is clicked, and claiming otherwise makes the whole app lie.
let planEmailSent = false;
// Server truth for "you have an account": /api/adherence carries `account_email`
// (the most-recently-verified address, or null). The OLD send path planted
// hb_email on SEND, so a user who never clicked their link carried a false
// "✓ signed in / your progress is saved" forever — and stopping the write could
// not reach flags already stored (lesson 41). Reconcile whenever the payload
// passes by: adopt the server's address (this also follows a post-merge address
// change), clear the flag when no account exists. Never touched on a network
// failure — only a real server answer may change it.
function syncAccountEmail(a) {
  if (!a || !("account_email" in a)) return;
  try {
    if (a.account_email) localStorage.setItem("hb_email", a.account_email);
    else localStorage.removeItem("hb_email");
  } catch {}
}
// Learn nav state is now three fields across five reset sites. One sink, so a
// fourth field added later cannot be forgotten at four of them (lesson 1 at
// state scope — the shape that produced the "fix one call site" lesson).
const resetLearnNav = () => { learnSlug = null; learnStack = []; learnExercise = null; };

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
// Learn→Learn navigation pushes the current page so ‹ Back walks the trail; arriving
// from any other tab (helpDot mid-workout, Coach links) starts a fresh trail.
function openLearn(slug) {
  if (tab === "learn" && learnSlug && slug && slug !== learnSlug) {
    learnStack.push(learnSlug);
    if (learnStack.length > 20) learnStack.shift();
  } else if (tab !== "learn") {
    learnStack = [];
  }
  learnExercise = null;   // navigating to a page closes any sheet open over it
  learnSlug = slug || null;
  tab = "learn";
  render();
}
// Wire any [data-learn="slug"] element on the current screen to open that page.
function wireLearnLinks() {
  app.querySelectorAll("[data-learn]").forEach((b) => b.onclick = () => openLearn(b.dataset.learn));
  // One loop, three kinds — the same set graph-core's `DATA_REF_KINDS` defines, so
  // adding a kind is a renderer and an entry, never a fourth wiring branch.
  for (const kind of ["exercise", "supplement", "muscle"]) {
    app.querySelectorAll(`[data-${kind}]`).forEach((b) => b.onclick = () => openLearnData(kind, b.dataset[kind]));
  }
}
// A small inline "?" that opens a learn page — decodes jargon in place.
// The accessible name must MATCH the visible text (WCAG 2.5.3): a hard-coded
// aria-label="Explain" hid descriptive labels like "what's RIR?" from screen
// readers and broke voice control ("tap what's RIR"). Only the bare "?" default
// needs a spoken name; a descriptive label speaks for itself.
const helpDot = (slug, label = "ⓘ what's this?") => `<button class="help" data-learn="${slug}">${label}</button>`;

// --- Trend charts (Wave 252; the dataviz method) -----------------------------
// Change-over-time → a LINE. One series per chart → one hue (the accent), no
// legend (the card heading names the series), axis extremes as muted text
// tokens, and the editable day list beside each chart is its table view. Tap
// the plot to inspect the nearest day (the mobile tooltip).
function trendChart(values, { unit = "", w = 320, h = 84, target = null, capId = "" } = {}) {
  // pad 14: the extremes' text labels live in the corners, and the eyeball pass
  // (dataviz step 7) caught the line colliding with both at pad 6.
  const { pts, min, max } = linePath(values, w, h, 14);
  if (!pts.length) return "";
  const line = pts.map(([x, y]) => `${x},${y}`).join(" ");
  const last = pts[pts.length - 1];
  // The target reference draws only when it falls inside the data's own range —
  // rescaling the domain around an off-screen target would flatten the real line.
  const ty = target != null && max > min && target >= min && target <= max
    ? (h - 14) - ((target - min) * (h - 28)) / (max - min) : null;
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block" ${capId ? `data-chart="${capId}"` : ""} role="img" aria-label="Trend from ${min}${unit} to ${max}${unit}">
    ${ty != null ? `<line x1="14" x2="${w - 14}" y1="${ty}" y2="${ty}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 4"/>` : ""}
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="var(--accent)"/>
    <text x="4" y="${h - 2}" fill="var(--muted)" font-size="10">${min}${unit}</text>
    <text x="${w - 4}" y="10" fill="var(--muted)" font-size="10" text-anchor="end">${max}${unit}</text>
  </svg>${capId ? `<p class="muted" id="${capId}" style="font-size:.85rem;margin:2px 0 0">Tap the line to inspect a day.</p>` : ""}`;
}
function wireChartTap(capId, series, labelOf) {
  const svg = app.querySelector(`[data-chart="${capId}"]`);
  if (!svg || !series.length) return;
  svg.style.cursor = "pointer";
  svg.onclick = (ev) => {
    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(series.length - 1, Math.round(((ev.clientX - r.left) / r.width) * (series.length - 1))));
    const cap = $(`#${capId}`); if (cap) cap.textContent = labelOf(series[i]);
  };
}
const miniSpark = (values) => {
  const { pts } = linePath(values, 64, 18, 2);
  return pts.length > 1 ? `<svg viewBox="0 0 64 18" width="64" height="18" aria-hidden="true" style="flex:none;margin-right:8px"><polyline points="${pts.map(([x, y]) => `${x},${y}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/></svg>` : "";
};
let bwEditDate = null;   // a past weigh-in day selected for editing on Progress
let fuelLogDate = null;  // a past intake day selected for editing on Fuel

const api = async (path, opts = {}) => {
  // The device's clock rides EVERY authed call, from the one helper they all go
  // through. It used to be captured only when a user enabled notifications, so all
  // the timezone-correct week/day arithmetic on the server was quietly running in UTC
  // for anyone who never allowed push. Recomputed per request, so DST and travel fix
  // themselves on the next open. Minutes EAST of UTC, matching the server's convention.
  // Deliberately NOT added to postOrQueue: a queued body replayed days later must not
  // write the frame it had when it was queued.
  const headers = { "content-type": "application/json", ...(uid ? { "X-HB-User": uid } : {}), "X-HB-TZ": String(-new Date().getTimezoneOffset()), ...(opts.headers || {}) };
  const r = await fetch(path, { ...opts, headers });
  return r.json();
};
// api() only throws on a genuine network failure — a 4xx business-logic rejection
// (e.g. "you already have a challenge open") still lands here as a normal JSON
// body, so every caller MUST check r.error itself or it silently treats a
// rejection as success (or, worse, reads an undefined field from the missing
// success payload — the streak-freeze handler below used to render "still
// undefined weeks strong"). This maps every such route's error strings to copy
// so no handler has to invent — or forget — its own.
const SOCIAL_ERROR_COPY = {
  "bad-token": "That link isn't an active share — ask your friend for a fresh one.",
  "not-found": "That link isn't an active share — ask your friend for a fresh one.",
  "cannot-follow-self": "That's your own share link — share it with a friend instead.",
  "cannot-challenge-self": "That's your own share link — share it with a friend instead.",
  "not-following": "Refresh the page and try again.",
  "not-mutual": "You can only do that with a training partner who follows you back too.",
  "already-challenging": "You already have a challenge going with this partner.",
  "opponent-busy": "They've got a full slate of challenges this week — try again later.",
  "challenge-slots-full": "You're already running the maximum number of challenges this week.",
  "challenge-id-required": "You have more than one invite waiting — answer them from the Progress tab.",
  "no-pending-challenge": "That challenge isn't waiting on you anymore.",
  "unknown user": "Refresh the page and try again.",
  "no-tokens": "You don't have a streak freeze to spend yet.",
  "nothing-to-protect": "There's no missed week to protect right now.",
  "week-not-freezable": "That week can't be protected anymore.",
  "already-frozen": "That week is already protected.",
};
const socialErrorMessage = (err) => SOCIAL_ERROR_COPY[err] || "Something went wrong — try again.";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Screen-reader announcement for deliberate events only (the old whole-app
// aria-live re-announced every repaint, making the player unusable by ear).
const say = (msg) => { const el = $("#say"); if (el) el.textContent = msg; };

// Referral loop (Goal 4): a friend's public share card (share.html) links back
// here with ?follow=TOKEN instead of a bare "/". Stash it until we HAVE a uid
// (existing user landing directly, or a brand-new signup finishing onboarding),
// then auto-follow — closing the "saw a friend's streak → became accountability
// partners" loop without the copy-paste-a-link friction the manual box still
// exists for. Best-effort: a stale/self/dead token silently no-ops, same as any
// other social action that isn't the thing the user came here to do.
const REFERRAL_KEY = "hb_pending_follow";
(() => {
  let ref; try { ref = new URLSearchParams(location.search).get("follow"); } catch { ref = null; }
  if (!ref || ref.length > 100) return;
  try { localStorage.setItem(REFERRAL_KEY, ref); } catch {}
  try {
    const url = new URL(location.href);
    url.searchParams.delete("follow");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {}
})();
async function tryPendingFollow() {
  let token; try { token = localStorage.getItem(REFERRAL_KEY); } catch { token = null; }
  if (!token || !uid) return;
  try { localStorage.removeItem(REFERRAL_KEY); } catch {} // one attempt — never retries into a follow loop
  try {
    const r = await api("/api/following", { method: "POST", body: JSON.stringify({ user_id: uid, token }) });
    if (r && !r.error) say("Connected with the friend who invited you — see them on the Progress tab.");
  } catch {}
}

// Rest-readiness self-check (considerations #7): between sets, teach people to
// gauge their OWN recovery — the KB's rest-periods thesis is "rest by readiness,
// not a stopwatch". Optional prompts, not mandatory ticking; the "I'm ready"
// button is always live. Ticking all three just nudges the button. The countdown
// stays as a soft guide alongside.
const REST_CUES = [["breath", "🫁 Breath back to normal"], ["hr", "❤️ Heart rate settled"], ["mind", "🎯 Head in it — ready to push"]];
const restReadiness = () => `<div class="card" style="text-align:left;margin-top:14px">
    <p class="muted" style="margin:0 0 6px">Start your next set when you can tick these — rest by readiness, not the clock ${helpDot("rest-periods", "ⓘ why")}:</p>
    ${REST_CUES.map(([k, label]) => `<button class="restcue" data-cue="${k}" role="checkbox" aria-checked="false" style="display:flex;align-items:center;width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:11px;margin:5px 0;font-size:1rem;text-align:left"><span class="cuebox" aria-hidden="true" style="margin-right:10px">⬜</span>${label}</button>`).join("")}</div>`;
const wireRestCues = () => {
  const cues = [...app.querySelectorAll("[data-cue]")];
  cues.forEach((b) => b.onclick = () => {
    const on = b.getAttribute("aria-checked") !== "true";
    b.setAttribute("aria-checked", String(on));
    b.querySelector(".cuebox").textContent = on ? "✅" : "⬜";
    if (cues.every((c) => c.getAttribute("aria-checked") === "true")) { const s = $("#skip"); if (s) { s.textContent = "I'm ready — go 💪"; say("Recovered — ready for your next set."); } }
  });
};

// PWA / push capability. On iOS, Web Push exists ONLY for a home-screen-installed
// app — `PushManager` is absent in a normal Safari tab, so the reminders card
// would silently vanish for every iPhone user in the browser. Detect that case
// to show an "Add to Home Screen" hint instead of nothing.
const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 13+ masquerades as Mac
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;

// Android/desktop Chrome fires beforeinstallprompt (only when installable and not
// yet installed); we stash the event to trigger the native install on a user tap.
// iOS has no such event — Wave 24's manual "Add to Home Screen" hint covers it.
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstallPrompt = e; });
window.addEventListener("appinstalled", () => { deferredInstallPrompt = null; });
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
// One list, used by onboarding AND the in-session "did this hurt?" report — two
// copies would drift, and the engine's region keys must match on both paths.
const INJURY_REGIONS = [["Lower back", "lower-back"], ["Knee", "knee"], ["Shoulder", "shoulder"], ["Elbow", "elbow"], ["Wrist", "wrist"], ["Hip", "hip"], ["Neck", "neck"], ["Ankle", "ankle"]];

const STEPS = [
  { key: "training_status", q: "Have you lifted weights before?", opts: [["New to this", "beginner"], ["About a year in", "intermediate"], ["Several years", "advanced"]] },
  { key: "primary_goal", q: "What do you want most?", opts: [["Build muscle", "hypertrophy"], ["Get stronger", "strength"], ["Lose fat", "fat-loss"], ["A bit of both", "recomposition"]] },
  { key: "days_per_week", q: "How many days a week can you train?", stepper: { min: 2, max: 6, def: 3, hint: "Most beginners grow well on 3." } },
  { key: "session_length_min", q: "How long can each session be?", stepper: { min: 30, max: 90, step: 15, def: 60, hint: "45–60 minutes suits most people.", unit: " min" } },
  { key: "available_equipment", q: "Where will you train?", opts: [["A full gym", ["barbell", "dumbbell", "machine", "cable", "bodyweight", "band", "kettlebell"]], ["Home gym (dumbbells, bands, kettlebell)", ["dumbbell", "kettlebell", "band", "bodyweight"]], ["Home with dumbbells", ["dumbbell", "bodyweight"]], ["Bands & bodyweight", ["band", "bodyweight"]], ["Just my bodyweight", ["bodyweight"]]] },
  { key: "priority_muscles", q: "Any muscles you especially want to grow?", multi: [["Shoulders", ["side-delts"]], ["Chest", ["chest"]], ["Back", ["lats", "upper-back"]], ["Arms", ["biceps", "triceps"]], ["Glutes", ["glutes"]], ["Thighs", ["quadriceps"]], ["Abs", ["abs"]]], optional: true, hint: "Optional. Pick one or two and we'll run a real specialization block — they get pushed hard, and everything else drops to a maintenance dose to pay for it. Pick three or more and we'll just tilt volume their way." },
  // "How hard should I push those muscles?" USED TO BE ASKED HERE. It isn't any more:
  // it asked the user to make a programming decision (balanced vs an all-in block)
  // that the app exists to make for them, and a lifter who could answer it wouldn't
  // need us. WHICH muscles they care about is a preference only they have — that's the
  // question above, and it stays. HOW HARD to push is now derived from the KB's own
  // rule in plan-core's `deriveSpecialization` (past the beginner phase, one or two
  // AREAS → a real specialization block; three or more → the priority tilt
  // without it, because you can't specialize everything at once).
  //
  // The hint above carries the CONSEQUENCE, which the deleted question used to state
  // and the replacement dropped: "Optional — we'll give these extra volume" described
  // only what happens to the picks, while a single tap now silently holds every other
  // muscle at a maintenance dose. Deriving the decision is right (Goal 2); leaving the
  // user unable to see what one tap costs is not — that's a decision made FOR them,
  // undisclosed, which is a different thing from a decision made WITHOUT them. Stating
  // the trade adds no cognitive load: there's still nothing to answer.
  // Settings-ONLY (gated on settingsMode): a goal event date is a niche competitive-lifter
  // need, so it never appears in first-run onboarding (Goals 2 & 3: minimal customization,
  // zero cognitive load) — the taper engine is off by default. A non-beginner who wants it
  // sets it later from Settings, where this same wizard runs with settingsMode = true.
  { key: "goal_event_date", q: "Training toward a specific date?", date: true, optional: true, hint: "Optional — a meet, show, or strength test. The final ~2 weeks taper volume down so you're fresh, not fatigued, on the day. Leave blank if there isn't one.", showIf: (a) => settingsMode && a.training_status !== "beginner" },
  // Neck and ankle were filterable by the engine (data/injury-contraindications.json
  // covers 8 regions) and selectable by nobody — the UI offered 6.
  { key: "injuries", q: "Anything we should train around?", multi: INJURY_REGIONS, optional: true, hint: "Optional — we'll avoid aggravating movements." },
  // Severity was hardcoded "moderate" for everyone, which made contraExcluded's
  // `severity === "mild"` branch unreachable from the shipped client — a whole
  // leniency path that existed in the engine and could never run. Asking one
  // question turns it on, and lets a niggle keep exercises a real injury removes.
  //
  // TWO options, not three, because the engine has exactly two behaviours:
  // `contraExcluded` branches on `severity !== "mild"`, and the KB's own data file
  // says so ("exclude_patterns are avoided at any severity; caution_patterns are
  // additionally avoided at moderate/severe"). A third "Serious — keep me well
  // clear" choice filtered precisely what "moderate" filtered while the hint
  // promised it "clears everything that loads it" — asking someone to make a
  // distinction that changes nothing, and describing a tier that doesn't exist.
  // "severe" stays a valid stored value (schema, sanitizeInjuries, and the
  // /api/profile/injury escalation ladder all still accept it, and it behaves
  // exactly as it always did) so nobody who already answered it needs migrating.
  { key: "injury_severity", q: "How much do they bother you?", opts: [["A niggle — I work around it", "mild"], ["Enough that I avoid some moves", "moderate"]], showIf: (a) => (a.injuries || []).flat().length > 0, hint: "A niggle only drops the movements most likely to aggravate it. Anything more also clears the ones that merely load the area." },
  // `sex` and `units` used to be asked here and are not any more.
  //
  // `sex` had ZERO references in the training engine (plan-core, derive-core,
  // coach, planner) — it is read only by the Fuel tab's body-fat estimate. Its
  // question said "this just sets sensible starting points", which was simply not
  // true of anything the plan does. It now lives in the Fuel stats form beside the
  // height/neck/waist it is actually used with, so it is asked at the point of use
  // by the people who need it, and never asked of someone who only wants to train.
  //
  // `units` is a display preference, derived from the device locale with a one-tap
  // correction where the numbers first appear. See `deriveUnits`.
];
// Onboarding answers persist to localStorage as they're picked, so a reload or a
// failed submit never makes a nervous first-timer re-answer the whole wizard.
// Display units from the device's own locale. Only three countries in common use
// pound-based bodyweight for this purpose, so the table is stated explicitly
// rather than guessed at — and because a guess CAN be wrong (a UK user is metric
// for plates and often imperial for bodyweight), the plan screen carries a one-tap
// correction where the numbers first appear (`#plan-units`), instead of the guess
// being silently wrong on the first set screen. That justification was written
// before the control existed, which made it a claim rather than a description;
// building it was the honest way to keep the argument.
const IMPERIAL_REGIONS = new Set(["US", "LR", "MM"]);
function deriveUnits() {
  try {
    const loc = new Intl.Locale(navigator.language || "en");
    const region = loc.region || (navigator.language || "").split("-")[1] || "";
    return IMPERIAL_REGIONS.has(String(region).toUpperCase()) ? "imperial" : "metric";
  } catch { return "metric"; }
}
const ONB_KEY = "hb_onboarding";
let onbStep = 0, onbStarted = false, answers = {};
// Settings reuses the SAME wizard the user already learned in onboarding —
// pre-filled from their profile, submitting to /api/plan/regenerate instead of
// creating a new user. Zero new UI concepts; the plan regenerates on save.
let settingsMode = false;
// Solo settings edit (Wave 245): jump into ONE wizard question from the Training
// Settings screen, answer it (plus any dependent follow-up), and the plan
// rebuilds immediately — changing one thing stops costing the whole 7-9-question
// wizard. Back from a solo question cancels the edit wholesale; nothing saves.
let settingsSolo = null;
const SOLO_FOLLOWUPS = { injuries: ["injury_severity"] }; // dependent questions a solo edit must still ask
try { const s = JSON.parse(localStorage.getItem(ONB_KEY) || "null"); if (s) { answers = s.answers || {}; onbStep = s.onbStep || 0; onbStarted = !!s.onbStarted; } } catch {}
const saveOnb = () => { if (settingsMode) return; try { localStorage.setItem(ONB_KEY, JSON.stringify({ answers, onbStep, onbStarted })); } catch {} };

// Training Settings (Wave 245): one row per answer with its CURRENT value and a
// "Change" that jumps into just that wizard question — changing one setting is
// three taps, not a re-run of the whole questionnaire. The full wizard stays one
// row away for a genuine re-answer-everything.
async function renderTrainingSettings() {
  nav.hidden = false; // the wizard hides the nav; every solo-edit path returns HERE, not through render()
  app.innerHTML = `<h1>Training settings</h1><p class="muted">Loading…</p>`;
  let d; try { d = await api(`/api/plan/explain`); } catch { d = null; }
  const p = d?.profile;
  if (!p) {
    app.innerHTML = `<h1>Training settings</h1><div class="card"><p>📴 Couldn't load your current settings.</p>
      <p class="muted">Editing needs them first — otherwise a save could overwrite what you've got.</p>
      <button class="btn" id="retry-ts">Try again</button>
      <button class="btn ghost" id="back-me2">‹ Back</button></div>`;
    $("#retry-ts").onclick = renderTrainingSettings;
    $("#back-me2").onclick = () => { tab = "me"; render(); };
    return;
  }
  const stepBy = (k) => STEPS.find((s) => s.key === k);
  const optLabel = (k, v) => stepBy(k)?.opts?.find(([, val]) => val === v)?.[0] ?? v ?? "—";
  const equipLabel = () => {
    const have = [...(p.available_equipment ?? [])].sort().join(",");
    return stepBy("available_equipment")?.opts?.find(([, v]) => [...v].sort().join(",") === have)?.[0] ?? "Custom mix";
  };
  const priLabel = () => (stepBy("priority_muscles")?.multi ?? [])
    .filter(([, ids]) => ids.every((id) => (p.priority_muscles ?? []).includes(id))).map(([l]) => l).join(", ") || "None";
  const injLabel = () => (p.injuries ?? []).map((i) => titleCase(String(i.region).replace(/-/g, " "))).join(", ") || "None";
  const rows = [
    ["training_status", "Experience", optLabel("training_status", p.training_status)],
    ["primary_goal", "Goal", optLabel("primary_goal", p.primary_goal)],
    ["days_per_week", "Days per week", String(p.days_per_week ?? "—")],
    ["session_length_min", "Session length", `${p.session_length_min ?? "—"} min`],
    ["available_equipment", "Equipment", equipLabel()],
    ["priority_muscles", "Priority muscles", priLabel()],
    ["injuries", "Training around", injLabel()],
    // The goal-event row mirrors the wizard step's own gate (non-beginners only).
    ...(p.training_status !== "beginner" ? [["goal_event_date", "Goal event date", p.goal_event_date || "None"]] : []),
  ];
  app.innerHTML = `<h1>Training settings</h1>
    <p class="muted">Change any answer on its own — your plan rebuilds around it. Your logged workouts are never touched.</p>
    <div class="card">${rows.map(([k, l, v]) => `<div class="row"><div style="flex:1"><span class="muted" style="font-size:.85rem">${l}</span><br><b>${esc(String(v))}</b></div><button class="btn ghost inline" data-solo="${k}" style="margin:0">Change</button></div>`).join("")}</div>
    <button class="btn secondary inline" id="ts-full">Re-answer everything &amp; rebuild</button>
    <button class="btn ghost inline" id="ts-back">‹ Back</button>`;
  app.querySelectorAll("[data-solo]").forEach((b) => b.onclick = () => renderSettings(b.dataset.solo));
  $("#ts-full").onclick = () => renderSettings();
  $("#ts-back").onclick = () => { tab = "me"; render(); };
}

// Open the wizard as a pre-filled settings editor for an existing user. With
// `soloKey`, open at THAT question only (the Training Settings screen's per-row
// "Change" door) instead of walking every question from the top.
async function renderSettings(soloKey = null) {
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
    $("#retry-set").onclick = () => renderSettings(soloKey);
    $("#back-me").onclick = () => { tab = "me"; render(); };
    return;
  }
  answers = {
    training_status: p.training_status, primary_goal: p.primary_goal,
    days_per_week: p.days_per_week ?? 3, session_length_min: p.session_length_min ?? 60,
    available_equipment: p.available_equipment,
    // multi steps store option-value arrays: select each group fully covered by the profile
    priority_muscles: (STEPS.find((s) => s.key === "priority_muscles")?.multi || [])
      .map(([, v]) => v).filter((v) => v.every((id) => (p.priority_muscles || []).includes(id))),
    injuries: (p.injuries || []).map((i) => i.region),
    // Severity MUST prefill: a solo edit of any non-injury answer submits without
    // walking the severity question, and `answers.injury_severity || "moderate"`
    // was silently ESCALATING every stored mild injury to moderate — deleting
    // squat/lunge patterns from the plan because the user asked to train one
    // more day. (The injuries solo edit still re-asks and overwrites this.)
    injury_severity: (p.injuries || [])[0]?.severity ?? undefined,
    goal_event_date: p.goal_event_date || "",
    // `sex` and `units` are no longer wizard steps, so prefilling them here would
    // populate answers nothing reads — and `units` in particular must NOT be sent
    // back by a settings save (see submitOnboarding): the Me-tab toggle owns it,
    // and re-sending a stale prefill would fight it.
  };
  settingsMode = true; onbStarted = true;
  settingsSolo = typeof soloKey === "string" ? soloKey : null; // an event object is not a key
  onbStep = settingsSolo ? Math.max(0, STEPS.findIndex((s) => s.key === settingsSolo)) : 0;
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
      <p class="muted" style="font-size:.8rem">By starting you agree this is training guidance, not medical advice — <a href="#" id="healthnote" style="color:var(--muted);text-decoration:underline">the honest details</a></p>
      <button class="btn ghost" id="restore">Already have progress saved? Sign in on this device</button>
      <div id="restorebox" hidden style="margin-top:6px">
        <input id="remail" type="email" inputmode="email" autocomplete="email" aria-label="Email address for your restore link" placeholder="you@email.com"
          style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:0 0 8px">
        <button class="btn secondary" id="sendrestore">Email me a restore link</button>
        <p class="muted" id="rmsg"></p></div></div>`;
    $("#go").onclick = () => { onbStarted = true; onbStep = 0; saveOnb(); renderOnboarding(); };
    $("#healthnote").onclick = (e) => { e.preventDefault(); renderHealthNote(renderOnboarding); };
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
  // One dot per question this user will ACTUALLY be asked — the same `showIf` the
  // forward/back navigation uses, so the progress bar can't promise more steps than
  // the wizard will ever show. Rendering a dot per STEPS entry meant a first-timer
  // saw the settings-only goal-event question and both conditional follow-ups
  // counted against them: twelve dots for a nine-question run, a finish line that
  // visibly receded (the walked steps skip, so the trailing dots never light).
  const visible = STEPS.filter((s, i) => i === onbStep || !s.showIf || s.showIf(answers));
  const dotsDone = visible.findIndex((s) => s === STEPS[onbStep]);
  const dots = visible.map((_, i) => `<i class="${i <= dotsDone ? "on" : ""}"></i>`).join("");
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
  } else if (step.date) {
    const v = answers[step.key] || "";
    // A goal event can't be in the past — in the USER'S local calendar, not UTC's:
    // toISOString() is the UTC date, which west of UTC in the evening blocked
    // selecting the user's real "tomorrow" (and east of UTC allowed local-yesterday).
    const dNow = new Date();
    const todayStr = `${dNow.getFullYear()}-${String(dNow.getMonth() + 1).padStart(2, "0")}-${String(dNow.getDate()).padStart(2, "0")}`;
    body = `<input type="date" id="dateval" min="${todayStr}" value="${esc(v)}" aria-label="${esc(step.q)}"
        style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:0 0 8px">
      <p class="muted center">${esc(step.hint || "")}</p><button class="btn" id="next">Continue</button>`;
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
  } else if (step.date) {
    answers[step.key] = answers[step.key] || "";
    $("#dateval").oninput = (e) => { answers[step.key] = e.target.value; saveOnb(); };
    $("#next").onclick = advance;
  } else {
    app.querySelectorAll(".choice").forEach((b) => b.onclick = () => { answers[step.key] = step.opts[+b.dataset.i][1]; saveOnb(); advance(); });
  }
  $("#onb-back").onclick = onbBack;
}
// A misclick is always recoverable: step back one question (or to the welcome
// screen from the first), with prior answers preserved and re-highlighted.
function onbBack() {
  // Back from ANY question of a solo edit cancels the edit wholesale — nothing
  // saves, and the user lands back on the settings list they came from.
  if (settingsSolo) { settingsSolo = null; settingsMode = false; return renderTrainingSettings(); }
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
  // A solo edit submits as soon as its question (and any dependent follow-up,
  // e.g. injuries → severity) is answered — never marches on through the rest.
  if (settingsSolo && (next >= STEPS.length || !(SOLO_FOLLOWUPS[settingsSolo] ?? []).includes(STEPS[next].key))) return submitOnboarding();
  if (next < STEPS.length) { onbStep = next; saveOnb(); return renderOnboarding(); }
  await submitOnboarding();
}
async function submitOnboarding() {
  app.innerHTML = `<div class="center" style="padding-top:20vh"><h1>Building your plan…</h1></div>`;
  const priority = [...new Set((answers.priority_muscles || []).flat())];
  // Severity is now ASKED (it was hardcoded "moderate", so the engine's mild path
  // was dead code). Defaults to moderate when the question wasn't reached.
  const injuries = (answers.injuries || []).flat().map((region) => ({ region, severity: answers.injury_severity || "moderate" }));
  const profile = {
    training_status: answers.training_status, primary_goal: answers.primary_goal,
    days_per_week: answers.days_per_week, session_length_min: answers.session_length_min,
    available_equipment: answers.available_equipment, priority_muscles: priority,
    // Deliberately NOT sent: an absent value is what lets plan-core derive it.
    // Sending `false` here would store an explicit override and freeze every new
    // user out of the derivation — the bug this change exists to remove.
    // Always sent (never omitted) so a settings edit can CLEAR a previously-set
    // date, not just add one — the regenerate route merges profile fields by
    // spreading the new object over the old, so an omitted key would never clear.
    goal_event_date: answers.training_status !== "beginner" && answers.goal_event_date ? answers.goal_event_date : null,
    injuries,
    // `sex` and `units` are deliberately ABSENT from this literal, and absence is
    // load-bearing: /api/plan/regenerate merges with `{ ...u.profile, ...patch }`,
    // so sending `sex: undefined` would OVERWRITE a stored value with undefined and
    // wipe it for every existing user on their next Settings save. Omitting the key
    // leaves the stored one alone (lesson 37 — the half that bites people who
    // already answered). `sex` is collected in the Fuel form now; `units` is set
    // once at creation below and owned thereafter by the Me-tab toggle.
    ...(settingsMode ? {} : { units: deriveUnits() }),
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
      // `profile.units` is absent on a settings save now (the toggle owns it), so
      // writing it unconditionally would store the string "undefined" and flip
      // every user to kg. Only write a real value.
      if (profile.units) localStorage.setItem("hb_units", profile.units);
      localStorage.setItem("hb_program", r.program.name);
      if (settingsSolo) { settingsSolo = null; say("Saved — your plan was rebuilt around it."); return renderTrainingSettings(); }
      tab = "plan"; return render(); // show the regenerated plan immediately, on its own tab
    }
    app.innerHTML = `<div class="center" style="padding-top:16vh"><h1>Hmm — that didn't go through.</h1>
      <p>Your settings weren't changed. Let's try again.</p>
      <button class="btn" id="retryset">Try again</button>
      <button class="btn ghost" id="backset">‹ Keep my old settings</button></div>`;
    $("#retryset").onclick = submitOnboarding;
    $("#backset").onclick = () => { settingsSolo = null; settingsMode = false; tab = "me"; render(); };
    return;
  }
  let res;
  try { res = await api("/api/onboard", { method: "POST", body: JSON.stringify({ profile }) }); }
  catch { res = {}; }
  if (res.user_id) {
    uid = res.user_id; localStorage.setItem("hb_user", uid); localStorage.setItem("hb_program", res.program.name);
    localStorage.setItem("hb_units", profile.units); // remember display preference (only once onboarding actually succeeded)
    localStorage.removeItem(ONB_KEY); // answers safely handed off; stop persisting them
    tryPendingFollow(); // no-op unless they arrived via a friend's share link
    return renderPlanExplain(true);
  }
  // Retry in place — never discard the answers the user just gave.
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
  <span class="status s-maint">holding steady</span> during a specialization block, this muscle is intentionally kept at a maintenance dose while your priority muscles get the extra volume.<br>
  <span class="status s-maint">covered by compounds</span> this muscle gets its work from your big lifts — direct exercises for it are optional unless you make it a priority.</p>`;
// Shared block builder for every plan surface (the first-run reveal and the Plan
// tab): cardio, the UN-collapsed personalization panel, the collapsed why-block,
// and the session list — one source, so the two screens can never drift.
function buildPlanBlocks(d) {
  const r = d.rationale || {};
  const gradeChip = (g) => g ? `<span class="chip">Grade ${g}</span>` : "";
  const vols = Object.entries(r.volume_by_muscle || {}).filter(([, v]) => (v.frequency > 0 || v.secondary_served) && v.projected_sets > 0).sort((a, b) => b[1].projected_sets - a[1].projected_sets);
  const volRows = vols.map(([m, v]) => `<div class="row"><div style="flex:1"><b>${esc(cap(friendlyMuscle(m)))}</b> <span class="muted">${v.projected_sets} sets/wk${v.is_priority ? " · priority" : ""}</span>
      <div class="bar"><i style="width:${Math.min(100, (v.projected_sets / 24) * 100)}%;background:var(--accent)"></i></div>
      <span class="muted" style="font-size:.82rem">${esc((v.reasons || []).join(" · "))} ${gradeChip(v.landmark?.evidence_grade)}</span></div>
      <span class="status ${statusClass(v.projected_status)}">${statusLabel(v.projected_status)}</span></div>`).join("");
  const warns = (r.warnings || []).map((w) => `<div class="win">ℹ️ ${esc(w.message)}</div>`).join("");
  // The rest of the week: what the plan asks for OUTSIDE the gym. Grade-labelled
  // like every other landmark surface — the guideline calls its own dose ranges
  // "practical models, not measured constants", so the app must not imply harder.
  const pc = d.program?.cardio;
  const pcRange = (x, unit = "") => x ? (x.min === x.max ? `${x.min}${unit}` : `${x.min}–${x.max}${unit}`) : "";
  const cardioBlock = pc
    ? `<h2>Cardio &amp; steps ${helpDot("cardio-and-concurrent-training", "ⓘ how much cardio?")}</h2>
       <div class="card"><div class="row"><div style="flex:1"><b>${pcRange(pc.steps_per_day)} steps/day</b>
         <div class="muted" style="font-size:.85rem">${esc(pc.note ?? "")}</div></div>
         <span class="chip">Grade ${esc(pc.evidence_grade)}</span></div>
         <div class="row"><div style="flex:1"><b>${pcRange(pc.sessions_per_week)} sessions/week</b> <span class="muted">${pcRange(pc.minutes_per_session)} min each${pc.structured_modality ? ` — ${esc(pc.structured_modality.name.toLowerCase())} interferes least` : ""}</span>
         <div class="muted" style="font-size:.85rem">${(pc.placement?.best_after ?? []).length
           ? `Best after: ${esc(pc.placement.best_after.join(", "))}. ${esc(pc.placement.rule ?? "")}`
           : `Every training day on this split sits next to leg work — put harder sessions on a rest day, or keep it to walking.`}</div></div></div>
       </div>`
    : "";
  const sessions = d.program?.sessions || [];
  const sessionRows = sessions.map((s) => `<div class="row"><div style="flex:1"><b>${esc(s.name)}</b></div>
    <span class="muted">${s.exercises.length} exercise${s.exercises.length === 1 ? "" : "s"}</span></div>`).join("");
  // A custom-edited plan clears plan_rationale (it described the pre-edit plan), so
  // the generated science breakdown no longer matches the sessions shown. Rather
  // than render a stale/empty "why", point to the live editor critique.
  const hasRationale = !!(r.volume_by_muscle && Object.keys(r.volume_by_muscle).length);
  // What YOUR answers changed. Deliberately NOT inside the collapsed "why" block
  // below: the science was already explained there and nobody opened it, so the
  // personalization read as absent ("10 questions and the plans don't change much").
  // This states the answer and its consequence side by side, in the user's own terms.
  const pz = d.personalization || [];
  const personalizationBlock = pz.length
    ? `<h2>What your answers changed</h2>
       <div class="card">${pz.map((x) => `<div class="row" style="display:block;padding:8px 0">
         <b>${esc(x.answer)}</b>
         <div class="muted" style="font-size:.9rem;margin-top:2px">→ ${esc(x.effect)}</div></div>`).join("")}
       <p class="muted" style="font-size:.85rem;margin-top:6px">Change any of these in Settings and the plan rebuilds around them.</p></div>`
    : "";
  const whyBlock = hasRationale
    ? `<details class="why"><summary>Why this plan? <span class="muted">(the science)</span></summary>
    <p class="muted" style="margin-top:8px">${esc(r.split?.reason || "")} ${gradeChip("B")}</p>
    <h3>Planned sets per muscle</h3>
    <div class="card">${volRows || '<p class="muted">—</p>'}</div>
    ${STATUS_LEGEND}
    ${warns ? `<h3>Heads up</h3><div class="card">${warns}</div>` : ""}</details>`
    : `<div class="card"><p class="muted">You've customised this plan, so the auto-generated “why” breakdown no longer describes it. Use <b>Edit &amp; review my plan</b> below for a live check of your plan against the KB.</p></div>`;
  return { cardioBlock, personalizationBlock, whyBlock, sessions, sessionRows, hasRationale };
}

// The Plan tab (Wave 248): the read-only week — every session's exercises with
// sets × reps, one tap from anywhere. This surface did not exist: the only place
// to SEE a non-today session was the EDITOR, three taps deep via Me. Exercise
// rows open the bundled how-to sheet; the editor is one honest tap away.
async function renderPlan() {
  app.innerHTML = `<h1>Your plan</h1><p class="muted">Loading…</p>`;
  let d, exs;
  try {
    [d, exs] = await Promise.all([api(`/api/plan/explain`), api(`/api/exercises`)]);
    if (!d || d.error) throw new Error("no plan");
  } catch {
    app.innerHTML = `<h1>Your plan</h1><div class="card"><p>📴 You're offline.</p>
      <p class="muted">Your plan is saved safely — it'll show the moment you reconnect.</p>
      <button class="btn" id="retry-planview">Try again</button></div>`;
    $("#retry-planview").onclick = renderPlan;
    return;
  }
  allExercises = exs; // exName() resolves through this, custom exercises included
  const meta = new Map(exs.map((e) => [e.id, e]));
  const { cardioBlock, personalizationBlock, whyBlock } = buildPlanBlocks(d);
  const sessionCards = (d.program?.sessions ?? []).map((s) => `<div class="card"><b>${esc(s.name)}</b>
    ${d.rationale?.session_notes?.[s.name] ? `<p class="muted" style="margin:2px 0 4px">🌙 ${esc(d.rationale.session_notes[s.name])}</p>` : ""}
    ${orderSupersetAdjacent(s.exercises).map((e) => {
      const x = meta.get(e.exercise) || {};
      return `<button class="row" data-ex-open="${esc(e.exercise)}" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);color:var(--text);padding:10px 0;cursor:pointer">
        <div style="flex:1"><b>${esc(exName(e.exercise))}</b>${x.lengthened_bias ? ` <span class="chip stretch">🎯 stretch-focused</span>` : ""}<br>
          <span class="muted">${e.sets} sets × ${esc(e.rep_range)} reps${x.unilateral ? " <b>each side</b>" : ""}${e.superset_with ? ` · <b>🔗 superset with ${esc(exName(e.superset_with))}</b>` : ""}${x.primary_muscles ? ` · works ${esc(friendlyMuscles(x.primary_muscles))}` : ""}</span>
        </div><span class="muted">›</span></button>`;
    }).join("")}</div>`).join("");
  app.innerHTML = `<h1>Your plan</h1>
    <p class="muted">${esc(d.program?.name ?? "")} — tap any exercise for the how-to.</p>
    ${sessionCards}
    <button class="btn secondary inline" id="edit-plan">Edit plan</button>
    ${personalizationBlock}
    ${whyBlock}
    ${cardioBlock}`;
  wireLearnLinks();
  $("#edit-plan").onclick = renderPlanEdit;
  app.querySelectorAll("[data-ex-open]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.exOpen;
    let LX; try { ({ LEARN_EXERCISES: LX } = await learnData()); } catch { LX = null; }
    const dta = LX?.[id];
    if (!dta) { say("No guide for this one — it may be one of your own exercises."); return; }
    renderExerciseSheet({ exercise: id, name: dta.name, movement_pattern: dta.movement_pattern }, dta,
      { label: "‹ Back to your plan", onClick: () => { tab = "plan"; render(); } });
    window.scrollTo(0, 0);
  });
}

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
  const { cardioBlock, personalizationBlock, whyBlock, sessions, sessionRows, hasRationale } = buildPlanBlocks(d);

  if (firstTime) {
    app.innerHTML = `<div class="center"><h1>Your plan is ready 🎉</h1></div>
      <div class="card"><p>Here's your week — <b>${sessions.length} short session${sessions.length === 1 ? "" : "s"}</b>. I chose every exercise, weight, and set for you. You just show up and tap <b>Start</b>.</p></div>
      <div class="card">${sessionRows}</div>
      ${cardioBlock}
      <div class="card"><b>🚪 Never trained before?</b>
        <p class="muted">These 2-minute reads make your first day easy.</p>
        <button class="btn secondary" data-learn="your-first-session">Your first session — a walkthrough</button>
        <button class="btn secondary" data-learn="how-to-read-a-workout">How to read a workout</button></div>
      ${personalizationBlock}
      ${whyBlock}
      <p class="muted" style="margin:8px 0">Weights shown in <b>${unitLabel()}</b>. <button class="learnlink" id="plan-units">Use ${unitPref() === "lb" ? "kilograms" : "pounds"} instead</button></p>
      ${localStorage.getItem("hb_email") || planEmailSent ? "" : `<div class="card"><b>📩 Want this plan in your inbox?</b>
        <p class="muted" style="margin:4px 0 8px">One email, no password. I'll send your week — the sessions, the exercises, the sets — so it's there when you're standing in the gym. It also keeps your progress if you change phone.</p>
        <input id="plan-email" type="email" inputmode="email" autocomplete="email" aria-label="Email address"
          placeholder="you@email.com" style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:0 0 8px">
        <button class="btn secondary" id="plan-email-go">Send me my plan</button>
        <p class="muted" id="plan-email-msg" style="font-size:.85rem">No spam, and you can turn emails off any time.</p></div>`}
      <button class="btn" id="explain-go">Start training</button>`;
  } else {
    app.innerHTML = `<h1>Your plan</h1>
      <div class="card"><div class="big">${esc(d.program?.name || "Your program")}</div></div>
      <div class="card">${sessionRows}</div>
      ${cardioBlock}
      ${personalizationBlock}
      ${whyBlock}
      <button class="btn secondary" id="edit-plan">Edit &amp; review my plan</button>
      <button class="btn" id="explain-go">Back</button>`;
    $("#edit-plan").onclick = renderPlanEdit;
  }
  wireLearnLinks();
  // The ONLY prompt to create an account used to sit in renderRecap — on the far
  // side of a completed workout. The account row is what every re-engagement sweep
  // queries, so the door to being reachable was gated behind the very thing ~90% of
  // users never do. Asking here, at peak perceived value, costs one skippable field.
  // Correcting the locale guess where the numbers first appear, so a wrong guess
  // never reaches the first set screen. Same narrow door the Me-tab toggle uses.
  if ($("#plan-units")) $("#plan-units").onclick = async () => {
    const next = unitPref() === "lb" ? "metric" : "imperial";
    localStorage.setItem("hb_units", next);
    try { await api("/api/profile/units", { method: "POST", body: JSON.stringify({ user_id: uid, units: next }) }); } catch {}
    renderPlanExplain(firstTime);
  };
  if ($("#plan-email-go")) $("#plan-email-go").onclick = async () => {
    const email = ($("#plan-email")?.value || "").trim();
    const msg = $("#plan-email-msg");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (msg) msg.textContent = "That doesn't look like an email address — check it and try again."; return; }
    $("#plan-email-go").disabled = true;
    if (msg) msg.textContent = "Sending…";
    let r; try { r = await api("/api/auth/request", { method: "POST", body: JSON.stringify({ email, user_id: uid }) }); } catch { r = null; }
    if (!r || r.error) {
      $("#plan-email-go").disabled = false;
      // `rate-limited` is intentionally NOT a case here: the route collapses it into
      // a generic `{sent:true}` so an attacker cannot probe which addresses have
      // accounts. A branch matching on it would be unreachable (lesson 15).
      if (msg) msg.textContent = r?.error === "invalid-email"
        ? "That doesn't look like an email address — check it and try again."
        : r?.error ? "Couldn't send that — try again." : "Couldn't reach the server — check your connection.";
      return;
    }
    // Deliberately NOT `localStorage.setItem("hb_email", ...)`. `hb_email` is the
    // app-wide "you have an account" flag, and the account row is only created when
    // the magic link is CLICKED (verify.html writes it there). Setting it on SEND
    // made five other surfaces claim the user was signed in — including Me showing
    // "✓ signed in" with no way to re-request — for someone whose mail was still in
    // a spam folder. Worse, /api/auth/request answers `{sent:true}` for rate-limited
    // and unknown-user too (deliberately generic, to stop account enumeration), so
    // the flag could be set when no email was sent at all.
    planEmailSent = true;   // session-only: enough to stop re-offering the form here
    if (msg) msg.textContent = "Sent — open the link in your inbox to finish. You can start training now either way.";
  };
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
    <button class="btn ghost" id="backPlan">Back</button>`;
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
  $("#backPlan").onclick = () => { tab = "plan"; render(); };
}
function renderAddExercise(si) {
  const sorted = allExercises.slice().sort((a, b) => a.name.localeCompare(b.name));
  const rowsFor = (items) => items
    .map((e) => `<button class="choice" data-add-id="${e.id}">${esc(e.name)} <span class="muted">${e.primary_muscles.map(titleCase).join(", ")}${e.custom ? " · yours" : ""}</span></button>`).join("")
    || `<p class="muted" style="padding:8px 0">Nothing matches — try a muscle ("chest") or equipment ("cable").</p>`;
  app.innerHTML = `<h1>Add exercise</h1>
    <input id="ex-filter" type="search" placeholder="Search by name, muscle or equipment…" aria-label="Search exercises"
      style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:1.05rem;margin:0 0 8px">
    <div class="card" style="max-height:56vh;overflow:auto" id="ex-list">${rowsFor(sorted)}</div>
    <button class="btn secondary inline" id="newEx">+ Create a new exercise</button>
    <button class="btn ghost inline" id="cancelAdd">Cancel</button>`;
  const wireRows = () => app.querySelectorAll("[data-add-id]").forEach((b) => b.onclick = () => { editState.sessions[si].exercises.push({ exercise: b.dataset.addId, sets: 3, rep_range: "8-12" }); drawEdit(null); });
  wireRows();
  // Re-render only the LIST on input — never the input itself, or it loses focus
  // mid-word and the search fights the typist.
  $("#ex-filter").oninput = () => { $("#ex-list").innerHTML = rowsFor(filterExercises(sorted, $("#ex-filter").value)); wireRows(); };
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
// Weekly training-commitment device (Goal 4 — an implementation-intention /
// commitment-consistency lever, not just a fixed weekly cadence): the user
// states which days THIS week they intend to train, and the push sweep
// (server-side) proactively reminds on a committed day they haven't trained
// yet — not just reactively after they've already gone quiet.
const DAY_LABELS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
function commitmentCard(commitment, prefill = []) {
  if (commitment && commitment.days?.length) {
    const list = commitment.days.map((d) => DAY_LABELS.find(([k]) => k === d)?.[1] ?? d).join(", ");
    // The calendar export lives HERE now (it sat on the Coach tab behind ~10
    // cards, with a picker that opened BLANK every visit) — seeded from the very
    // days just committed, time remembered per device. Same .ics, zero re-picking.
    return `<div class="card"><div class="row" style="border:0"><div style="flex:1"><b>🗓️ This week's training days: ${esc(list)}</b>
        <p class="muted" style="margin:2px 0 0">You said you'd train these days — a promise to yourself.</p></div>
      <button class="btn ghost inline" id="edit-commitment" data-days="${esc(commitment.days.join(","))}" style="margin:0">Edit</button></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <input id="sched-time" type="time" value="${esc(localStorage.getItem("hb_cal_time") || "18:00")}" aria-label="Training time"
          style="background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:10px;font-size:1rem">
        <button class="btn ghost inline" id="addcal" style="margin:0">📆 Add these days to my calendar</button>
      </div><p class="muted" id="calmsg" style="margin:4px 0 0"></p></div>`;
  }
  // The copy used to promise "a quick reminder lands on the days you say". That is
  // delivered by shouldPushForCommitment, which runs inside a loop over the user's
  // PUSH SUBSCRIPTIONS — and it is explicitly excluded from the email fallback. For
  // anyone without push (in production: everyone) the sentence was simply false, so
  // it is now conditional on a channel they actually have. Stating the commitment
  // has real value unreminded — it is an implementation intention — and the .ics
  // below needs no permission and no server (lesson 24: the assertion's trigger
  // must cover every path that can flip it).
  // PUSH ONLY. An email address does not make this deliverable: push.mjs states
  // outright that "the daily/commitment reminder stays push-only here" — the email
  // fallback covers the discrete social events and the comeback sweep, never this.
  // Including `hb_email` here would have re-created the exact false promise this
  // change exists to remove, for every user who gave an address. Caught by the
  // browser walkthrough, which is the only place the two halves meet.
  const canRemind = localStorage.getItem("hb_push") === "1";
  return `<div class="card" id="commitment-card"><b>🗓️ Which days will you train this week?</b>
    <p class="muted" style="margin:4px 0 8px">${canRemind
      ? "A quick reminder lands on the days you say — not just once you've gone quiet."
      : "Naming the days is most of the work — deciding once beats deciding daily. Save them and the calendar button appears right here — the reminder comes from the phone itself."}</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${DAY_LABELS.map(([k, label]) => `<button class="tapchip" data-day="${k}" aria-pressed="${prefill.includes(k)}">${label}</button>`).join("")}</div>
    <button class="btn secondary inline" id="save-commitment" style="margin-top:10px">Save my days</button></div>`;
}
function wireCommitmentCard() {
  const chips = [...app.querySelectorAll("[data-day]")];
  chips.forEach((b) => b.onclick = () => b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")));
  if ($("#save-commitment")) $("#save-commitment").onclick = async () => {
    const days = chips.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.day);
    if (!days.length) return;
    try { await api("/api/commitment", { method: "POST", body: JSON.stringify({ user_id: uid, days }) }); say("Training days saved."); renderToday(); }
    catch { alertBar("📴 Couldn't save — try again when connected."); }
  };
  if ($("#addcal")) $("#addcal").onclick = () => {
    const days = seedCalendarDays(($("#edit-commitment").dataset.days || "").split(",").filter(Boolean), null);
    if (!days.length) { $("#calmsg").textContent = "Pick your days first."; return; }
    const t = $("#sched-time").value || "18:00";
    try { localStorage.setItem("hb_cal_time", t); localStorage.setItem("hb_cal_days", JSON.stringify(days)); } catch {}
    downloadTrainingCalendar(days, t);
    $("#calmsg").textContent = "Calendar file downloaded — open it to add recurring reminders.";
  };
  if ($("#edit-commitment")) $("#edit-commitment").onclick = () => {
    // Pre-select the days already committed (design law: never a blank picker
    // when the answer is known) — carried on the button, since this handler has
    // no other line to the current commitment.
    const days = ($("#edit-commitment").dataset.days || "").split(",").filter(Boolean);
    $("#edit-commitment").closest(".card").outerHTML = commitmentCard(null, days);
    wireCommitmentCard();
  };
}
async function renderToday() {
  if (sess) return renderResume();
  discardPending = false;
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let data, adh;
  try { [data, adh] = await Promise.all([api(`/api/today?d=${localDay()}`), api(`/api/adherence`)]); }
  catch {
    app.innerHTML = `<h1>Today</h1><div class="card"><p>📴 You're offline.</p>
      <p class="muted">Connect once to load today's plan — anything you've already logged will sync automatically.</p>
      <button class="btn" id="retry-today">Try again</button></div>`;
    $("#retry-today").onclick = () => renderToday();
    return;
  }
  syncAccountEmail(adh);
  const s = data.session;
  // Streak + level header, and the motivational state (loss-aversion when at risk,
  // warm welcome on a comeback, calm reassurance when paused).
  const st = adh.status || {};
  const icon = { "at-risk": "⚠️", comeback: "👋", paused: "⏸️", new: "🌱" }[st.state] || "";
  const header = `<div class="card row"><div style="flex:1"><b>🔥 ${adh.streak_weeks} week${adh.streak_weeks === 1 ? "" : "s"} strong</b>
      <div class="bar" style="margin-top:6px"><i style="width:${adh.level_progress_pct}%;background:var(--accent)"></i></div>
      <span class="muted" style="font-size:.82rem">Level ${adh.level} · ${adh.xp} XP · ${adh.xp_to_next} to next</span></div>
      <span class="chip" style="font-size:1rem">Lv ${adh.level}</span></div>
    ${st.state && st.state !== "on-track" && st.message ? `<div class="card"><p>${icon} ${esc(st.message)}</p></div>` : ""}
    ${adh.nudged ? `<div class="card"><p>👋 A training partner nudged you — they noticed you've got a session waiting.</p></div>` : ""}`;
  const list = s.exercises.map((e) => `<div class="row"><div><b>${esc(e.name)}</b>${e.lengthened_bias ? ` <span class="chip stretch">🎯 stretch-focused</span>` : ""}<br><span class="muted">${e.sets} sets × ${esc(e.rep_range)} reps${e.unilateral ? " <b>each side</b>" : ""}${e.superset_with_name ? ` · <b>🔗 superset with ${esc(e.superset_with_name)}</b>` : ""} · works ${esc(friendlyMuscles(e.primary_muscles))}</span></div></div>`).join("");
  // No check-in yet today → gently offer one; otherwise surface the readiness note.
  // "Skip today" and a finished workout both dismiss the offer FOR THE DAY —
  // re-asking after either makes "optional" feel like a nag (and post-workout the
  // check-in can't tune anything anyway).
  // The check-in offer now lives in the daily-flow hub above; here we only surface
  // the coach's readiness note once a check-in exists (so it's not shown twice).
  const readinessCard = s.readiness != null && s.coach_note ? `<div class="card"><p>🧭 ${esc(s.coach_note)}</p></div>` : "";
  // A brand-new lifter's very first session gets a reassuring walkthrough up top.
  // `first_session` is set by buildToday when a true beginner's day one has been
  // shortened. Saying so is not optional: the plan screen shows the full week, so
  // an unexplained 4-vs-7 gap reads as a bug rather than as coaching.
  // Gated on `never_trained`, NOT `day_number === 1`: day_number counts DERIVABLE
  // sessions, so a user whose only workout is voided or quarantined reads as day 1
  // — and greeting them "First workout?" states the opposite of what they did,
  // beside the History tab showing that very workout (the premise Wave 230 fixed,
  // at the one field it missed).
  const firstTimer = s.never_trained
    ? `<div class="card"><b>👋 First workout? You've got this.</b>
        ${s.first_session ? `<p class="muted"><b>Today is ${s.first_session.shown} exercises instead of your usual ${s.first_session.full}</b> — on purpose. A first session of 20–40 minutes is plenty: day one is for finding the machines and learning how they feel, not for setting records. Your full session is back next time.</p>` : ""}
        <p class="muted">Here's exactly how a session goes — arrive, warm up, find a comfy weight, do your sets. A 2-minute read makes the whole thing easy.</p>
        <button class="btn secondary" data-learn="your-first-session">Read: Your first session</button></div>`
    : "";
  // The mesocycle position (intermediate/advanced only): where this week sits in
  // the build → peak → deload wave, in one glance.
  // Friendly phase labels (never the raw token) + a tap-to-learn on the jargon,
  // matching the helpDot-on-jargon pattern everywhere else in the app.
  const PHASE_LABEL = { build: "building up", peak: "peak week", deload: "easy week (deload)" };
  // A taper (goal-event countdown) supersedes the mesocycle card — the server
  // never sends both (see coach.mjs buildToday), so this is never ambiguous.
  const blockCard = s.block
    ? `<div class="card"><b>${s.block.phase === "deload" ? "🌊" : s.block.phase === "peak" ? "⛰️" : "📈"} Week ${s.block.week} of ${s.block.of} — ${PHASE_LABEL[s.block.phase] ?? s.block.phase}</b> ${helpDot("deloads-and-rest-days", "ⓘ why weeks differ")}
        <p class="muted">${esc(s.block.note)}</p></div>`
    : s.taper
      ? `<div class="card"><b>⏳ ${s.taper.days_until} day${s.taper.days_until === 1 ? "" : "s"} to go — tapering</b>
          <p class="muted">${esc(s.taper.note)}</p></div>`
      : "";
  // CARDIO, prescribed (Wave 168). The KB has carried real numbers since Wave 161 —
  // dose by goal, an interference ranking, a leg-day timing rule — and the app never
  // once told anyone what to do with them: a user asking "how much cardio?" had to
  // go and read a page. Zero cognitive load means the app answers it, the way it
  // already answers sets and weights. `hard_cardio_ok` is resolved server-side
  // against TODAY's session, so this can be specific instead of hedging.
  const cd = s.cardio;
  const range = (r, unit = "") => r ? (r.min === r.max ? `${r.min}${unit}` : `${r.min}–${r.max}${unit}`) : "";
  const cardioCard = cd
    ? `<div class="card"><b>🚶 Cardio &amp; steps</b> <span class="chip">Grade ${esc(cd.evidence_grade)}</span>
        <p class="muted"><b>${range(cd.steps_per_day)} steps</b> a day, plus <b>${range(cd.sessions_per_week)} sessions</b> of ${range(cd.minutes_per_session)} min a week. ${cd.modality ? `Walking costs your muscle nothing — it's the reason steps come first.` : ""}${cd.structured_modality ? ` For those sessions, <b>${esc(cd.structured_modality.name.toLowerCase())}</b> interferes least with your lifting.` : ""}</p>
        <p class="muted">${cd.hard_cardio_ok
          ? `Today's a good day for a harder session — no leg work today or tomorrow.`
          : (cd.placement?.best_after ?? []).length
            ? `Keep hard leg-heavy cardio off today. Best after: <b>${esc(cd.placement.best_after.join(", "))}</b>.`
            : `On this split every training day sits next to leg work, so put harder sessions on a rest day — or keep it to walking, which costs nothing.`}</p>
        <button class="btn ghost" data-learn="cardio-and-concurrent-training">Read: cardio &amp; concurrent training</button></div>`
    : "";

  // --- The daily flow (considerations #6): one obvious sequence — morning
  // check-in (weight + how you feel) → the workout → tonight's calories. Each
  // step shows done ✓ or is the highlighted next action; the first unfinished
  // step is the call to action so it's always clear what to do right now.
  const dy = data.daily || {};
  const workoutDone = dy.workout_logged;
  // "Skip today" (and finishing a workout) dismiss the optional check-in for the day so
  // the hub stops re-asking — an optional step must never nag. The flag is written on
  // both actions; honour it here (its only reader was lost in the Wave-47 hub rewrite,
  // so skipping did nothing and the check-in stayed the highlighted next step).
  const ckDismissed = !dy.checked_in && (() => { try { return localStorage.getItem("hb_ck_dismissed") === localDay(); } catch { return false; } })();
  const steps = [
    { key: "checkin", icon: "☀️", label: "Daily check-in", sub: "Weight + how you're feeling", done: dy.checked_in, dismissed: ckDismissed, cta: "Check in" },
    { key: "workout", icon: "🏋️", label: "Today's workout", sub: workoutDone ? "Logged — nice." : esc(s.name), done: workoutDone, cta: "Start" },
    { key: "calories", icon: "🌙", label: "Today's calories", sub: dy.calories_logged ? "Logged." : "Enter your day's total", done: dy.calories_logged, cta: "Log" },
  ];
  // Day 1: the WORKOUT is the hero, not the optional morning check-in. A first-timer
  // came to train — an optional survey must never read as the gate before it (Goal 3).
  const firstUndone = (s.day_number === 1 && !workoutDone)
    ? steps.find((x) => x.key === "workout")
    : steps.find((x) => !x.done && !x.dismissed);
  const stepRow = (x) => {
    const isNext = x.key === firstUndone?.key;
    const settled = x.done || x.dismissed;
    const right = x.done
      ? `<span class="chip" aria-label="${x.label} done">done</span>`
      : `<button class="btn inline ${isNext ? "" : "secondary"}" data-step="${x.key}" style="margin:0">${x.cta}</button>`;
    return `<div class="row" ${isNext ? 'style="background:var(--card2);border-radius:12px;padding:8px;margin:2px -4px"' : ""}>
      <span style="font-size:1.4rem;margin-right:10px" aria-hidden="true">${x.done ? "✅" : x.icon}</span>
      <div style="flex:1"><b${settled ? ' style="opacity:.6"' : ""}>${x.label}</b><br><span class="muted" style="font-size:.85rem">${x.dismissed ? "Skipped for today" : x.sub}</span></div>
      ${right}</div>`;
  };
  // When calories is the next step, drop an inline quick-log right here so the
  // evening entry is one tap — no trip to another tab (considerations #6: "very
  // quick and straightforward"). The Fuel tab stays for the target + macros.
  const calorieQuickLog = firstUndone?.key === "calories"
    ? `<div style="display:flex;gap:8px;margin-top:10px"><input id="hub-kcal" type="number" inputmode="numeric" placeholder="today's total calories" style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:11px;font-size:1.05rem"><button class="btn inline" id="hub-log" style="margin:0">Log</button></div>
       <p class="muted" style="margin-top:6px;text-align:center">Great work today — log your total to finish. <button class="btn ghost inline" data-step="calories" style="padding:2px 8px;font-size:.85rem;margin:0">see your target</button></p>`
    : `<p class="muted" style="margin-top:8px;text-align:center">${firstUndone ? (firstUndone.key === "checkin" ? "Start your morning here." : dy.checked_in ? "You're checked in — time to train." : "Time to train.") : "🎉 All done today. See you tomorrow."}</p>`;
  const dailyHub = `<h2>Your day</h2><div class="card">${steps.map(stepRow).join("")}${calorieQuickLog}</div>`;
  // This used to skip the ask on day 1 for cognitive load — a defensible call that
  // did not anticipate day 1 never ENDING. `day_number = sessions.length + 1`, so
  // for the ~90% of users who never log a session it is permanently 1, and the
  // app's one proactive lever was invisible to exactly the people it exists for.
  // It shows on day 1 now; the copy above no longer promises a channel they may
  // not have, which is what made hiding it feel necessary.
  const commitment = commitmentCard(adh.commitment);

  app.innerHTML = `<h1>Today</h1>${header}${dailyHub}${commitment}${firstTimer}${blockCard}${readinessCard}
    ${workoutDone ? "" : `<h2>What you'll do ${helpDot("how-to-read-a-workout", "ⓘ how to read this")}</h2>${s.maintenance_note ? `<p class="muted" style="margin:0 0 6px">🌙 ${esc(s.maintenance_note)}</p>` : ""}<div class="card">${list}</div>`}
    ${cardioCard}`;
  wireCommitmentCard();
  // daily-flow actions
  app.querySelectorAll("[data-step]").forEach((b) => b.onclick = () => {
    const k = b.dataset.step;
    if (k === "checkin") renderCheckin();
    else if (k === "workout") startSession(s);
    else { tab = "fuel"; render(); } // calories: the Fuel tab logs it with target context
  });
  if ($("#checkin")) $("#checkin").onclick = renderCheckin;
  if ($("#hub-log")) $("#hub-log").onclick = async () => {
    const kcal = parseFloat($("#hub-kcal").value);
    if (!Number.isFinite(kcal) || kcal <= 0) { $("#hub-kcal").focus(); return; }
    try { await api("/api/nutrition/log", { method: "POST", body: JSON.stringify({ user_id: uid, kcal, date: localDay() }) }); say("Calories logged. Day complete."); renderToday(); }
    catch { alertBar("📴 Couldn't log — try again when connected."); }
  };
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
    ["motivation", "Motivation", "1 = flat · 5 = fired up"],
    ["stress", "Stress", "1 = calm · 5 = maxed out"],
    ["mood", "Mood", "1 = low · 5 = great"],
  ];
  const vals = { sleep_quality: 3, energy: 3, motivation: 3, stress: 3, mood: 3 };
  const draw = () => {
    const row = ([key, label, anchors]) => `<div class="ckrow"><span class="cklabel">${label} <span class="muted" style="font-weight:400">${anchors}</span></span><div class="ckscale">${[1, 2, 3, 4, 5].map((n) =>
      `<button class="tapchip${vals[key] === n ? " sel" : ""}" data-k="${key}" data-v="${n}" aria-pressed="${vals[key] === n}" aria-label="${label} ${n} of 5">${n}</button>`).join("")}</div></div>`;
    app.innerHTML = `<h1>Daily check-in</h1><p class="muted">Your weight and how you're feeling. 15 seconds — it tunes today's session and tracks your trend, never a score or judgment.</p>
      <div class="card"><label for="ck-weight" class="muted">Bodyweight (${unitLabel()}, optional)</label>
        <input id="ck-weight" type="number" inputmode="decimal" placeholder="weigh in first thing" style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:1.05rem;margin:2px 0 4px"></div>
      <div class="card">${fields.map(row).join("")}</div>
      <button class="btn" id="submitck">Save</button>
      <button class="btn ghost" id="skipck">Skip today</button>`;
    app.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => { vals[b.dataset.k] = +b.dataset.v; draw(); });
    $("#submitck").onclick = async () => {
      const wv = parseFloat($("#ck-weight").value); const weight_kg = Number.isFinite(wv) && wv > 0 ? toKg(wv) : undefined;
      try { await api("/api/checkin", { method: "POST", body: JSON.stringify({ user_id: uid, ...vals, date: localDay(), ...(weight_kg ? { weight_kg } : {}) }) }); say(weight_kg ? "Check-in and weight saved." : "Check-in saved."); }
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
    s.weights ??= {}; s.reps ??= {}; s.eff ??= {}; // (old blobs' auto-seeded `rir` map is deliberately ignored)
    return s;
  } catch { return null; }
}
function clearSess() { sess = null; try { localStorage.removeItem(SESS_KEY); } catch {} }

let sess = loadSess();      // survives a reload / tab eviction
let discardPending = false; // two-tap guard on discarding a logged workout
let historyEdit = null;     // session_id currently open for correction on the history screen
let historyDateFix = null;  // session_id whose quarantined calendar date is being repaired
let historyWeeksShown = 4;  // history is week-grouped and capped; "Show earlier weeks" raises this
let quitPending = false;    // two-tap guard on ending a workout early
// Two-tap guard on banking a set whose numbers look like a typo (isImplausibleSet).
// Keyed by the EXERCISE ID being confirmed, not its array index: the superset
// station shows two lifts at once (so one member's confirmation must not wave the
// other through), and Swap / "do this later" / Unlink all renumber the array — an
// index-keyed flag would then suppress the warning for whatever lift inherited that
// slot. Cleared by any stepper touch (they've re-read the number) and once banked.
// A SET of confirmed exercise ids, not one id: a superset round banks two lifts at
// once, and a single slot meant confirming one un-confirmed the other, so a round
// with two suspect entries could never be banked at all (see unconfirmedFlagged).
let confirmSet = new Set();
// Effort chips (Wave 171): tri-state hb_rir — "1" force-on, "0" force-off, unset =
// on for everyone past the beginner stage (beginners are never asked: the KB says
// novice RIR calls are noise, and the design spec forbids demanding effort of them;
// Wave-164 graduation flips them in automatically). The chips never pre-select —
// an unanswered set sends NO rir at all, because a fabricated default would read
// as "at target" forever and permanently blind the adaptive effort lever.
const rirOn = () => { const v = localStorage.getItem("hb_rir"); return v === "1" ? true : v === "0" ? false : !(sess?.beginner); };
// One-tap effort capture, shared by the player and the superset station. Tapping
// the selected chip clears it (a mis-tap escape) — only a deliberate answer is
// ever logged. "4+" stores 4: still counted by isHardSet (rir > 4 wouldn't be),
// and far enough past every prescribed band top to read as clearly-too-easy.
const effChips = (idx) => !rirOn() ? "" : `<div class="effrow" role="group" aria-label="reps left in the tank">
    <label>Reps left in the tank?</label>
    <div class="effchips">${[0, 1, 2, 3, 4].map((v) => `<button data-eff="${v}" data-i="${idx}" class="effchip${sess.eff[idx] === v ? " sel" : ""}" aria-pressed="${sess.eff[idx] === v}">${v === 4 ? "4+" : v}</button>`).join("")}</div>
  </div>`;
// The shared chip-tap behavior; the caller passes its own repaint (player vs station).
const effTap = (b, repaintFn) => {
  quitPending = false;
  const repaint = clearSetConfirm();
  const i = +b.dataset.i, v = +b.dataset.eff;
  if (sess.eff[i] === v) delete sess.eff[i]; else sess.eff[i] = v;
  saveSess();
  if (repaint) return repaintFn();
  b.closest(".effrow").querySelectorAll("[data-eff]").forEach((c) => { const on = +c.dataset.eff === sess.eff[i]; c.classList.toggle("sel", on); c.setAttribute("aria-pressed", String(on)); });
};
function startSession(templateSession) {
  sess = {
    name: templateSession.name, ex: orderSupersetAdjacent(templateSession.exercises), i: 0, set: 0,
    beginner: templateSession.beginner === true, // plain-effort language on the set screen — no "RIR" jargon for a true novice
    deload: templateSession.block?.phase === "deload" || templateSession.comeback === true, // planned-easy: block deload OR the layoff-comeback ease (0.88×) — both must stay out of e1RM/stall trends
    // eff (NOT the old `rir` map): a deliberately fresh key, so crash-mirror blobs
    // from builds that auto-seeded rir 2 can never leak fabricated effort data.
    logged: [], weights: {}, reps: {}, eff: {},
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

// Clearing a pending confirm has to REPAINT, not just reset the flag. The stepper
// handlers update their value in place (no re-render, deliberately), so a bare
// `confirmSet = null` left the ⚠️ line and the "Tap again" button label on screen
// describing a number the user had already corrected — a status contradicting the
// state it reports on, and a button whose label lied about what the next tap does.
// Returns true when the caller must re-render.
const clearSetConfirm = () => { const was = confirmSet.size > 0; confirmSet.clear(); return was; };

// Would banking index `idx` right now log something that looks like a typo? Binds
// the live `sess` to session-core's pure isImplausibleSet, reading the same kg the
// logger will actually send (sess.weights holds DISPLAY units — a lb user's "225"
// must be judged as 102 kg, not 225, or every lb session would be questioned).
// Returns false once the user has confirmed THIS index, so the second tap banks it.
const setExKey = (idx) => sess.ex[idx]?.exercise;
const setLooksLikeTypo = (idx) => isImplausibleSet(toKg(sess.weights[idx]), sess.reps[idx], { lastKg: sess.ex[idx]?.last_kg ?? null, priorBests: sess.ex[idx]?.pr_watch ?? null });
// Which of these station members still owe a confirming tap. Both players go through
// session-core's `unconfirmedFlagged` so "flagged and unconfirmed" has ONE definition.
const stationNeedsConfirm = (indices) => unconfirmedFlagged(indices, setExKey, setLooksLikeTypo, confirmSet);
const needsSetConfirm = (idx) => stationNeedsConfirm([idx]).length > 0;

// The one-line warning shown in place of the usual button label. Names the number
// it's questioning and what it's comparing against, so the answer is obvious at a
// glance — and never accuses: a real jump is a tap away, not a blocked action.
const setConfirmCue = (idx) => {
  const ex = sess.ex[idx];
  const ref = [ex?.last_kg, ex?.pr_watch?.load_kg].find((v) => typeof v === "number" && v > 0);
  const reps = sess.reps[idx];
  if (typeof reps === "number" && reps > 50) return `⚠️ <b>${reps} reps</b> — that's well past any target here. Tap again if it's right.`;
  return `⚠️ <b>${dispWeight(toKg(sess.weights[idx]))} ${unitLabel()}</b> is a big jump${ref != null ? ` from the ${dispWeight(ref)} ${unitLabel()} you last did` : ""}. Tap again if it's right — otherwise fix it above.`;
};

// A brief, self-dismissing toast for the in-player PR moment (roadmap #1 slice b —
// celebrate mid-session, not only in the end-of-session recap). Appended to <body>,
// OUTSIDE #app, so it survives the very next full re-render (the rest screen or the
// next exercise card that follows immediately after the set that earned it).
function showPrToast(text) {
  const el = document.createElement("div");
  el.className = "pr-toast";
  el.setAttribute("role", "status");
  el.innerHTML = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Fires the in-player celebration at most ONCE per exercise per session — the first
// set that crosses the prior best. A later, even-better set in the same session
// doesn't re-fire (the recap still shows the session's true best at the end; this
// is just the in-the-moment spark). Reads `pr_watch` (the exact ceiling buildToday
// attached to this exercise, computed from the SAME history the server will use at
// recap time — checkSetPR duplicates the server's rules, cross-tested in
// scripts/test-session.mjs, so the two surfaces can never disagree).
function checkAndCelebratePR(exObj, weightKg, reps, deload) {
  if (!exObj.pr_watch || sess.prCelebrated?.[exObj.exercise]) return false;
  const pr = checkSetPR(exObj.exercise, weightKg, reps, "work", exObj.pr_watch, deload);
  if (!pr) return false;
  sess.prCelebrated = sess.prCelebrated || {};
  sess.prCelebrated[exObj.exercise] = true;
  const detail = pr.kind === "load"
    ? `new best working weight — ${dispWeight(pr.load_kg)} ${unitLabel()} × ${pr.reps} reps`
    : `new estimated best single lift — ${dispWeight(pr.e1rm_kg)} ${unitLabel()}`;
  showPrToast(`🎉 <b>New personal record!</b><br><span class="muted">${esc(exObj.name)}: ${detail}</span>`);
  say(`New personal record on ${exObj.name}!`);
  return true;
}

// The in-player half of the lucky-set variable reward (roadmap #2's remaining
// slice): fires the instant a hard set that happens to be "lucky" is banked, not
// only in the end-of-session recap. `checkLuckySet` reads the SAME session_id-hashed
// rule the server replays at recap time (cross-tested in scripts/test-session.mjs),
// so the live toast and the recap's "+N bonus XP" line can never disagree. Skips
// the toast when this exact set ALSO just fired a PR celebration — the XP still
// banks either way, but stacking two toasts on one set dilutes the bigger moment.
function checkAndCelebrateLucky(exObj, loggedSet, wasPR) {
  if (!checkLuckySet(sess.session_id, sess.logged, loggedSet)) return;
  sess.luckyXp = (sess.luckyXp || 0) + LUCKY_SET_XP;
  if (wasPR) return;
  showPrToast(`🍀 <b>Lucky set!</b> <span style="color:var(--accent);font-weight:700">+${LUCKY_SET_XP} XP</span><br><span class="muted">${esc(exObj.name)}</span>`);
  say("Lucky set — bonus XP!");
}

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
  // sess.eff is NEVER seeded — no answer means no rir on the logged set.
  const w = sess.weights[sess.i], reps = sess.reps[sess.i];
  const setDots = Array.from({ length: e.sets }, (_, k) => `<i class="${k < sess.set ? "done" : ""}"></i>`).join("");

  if (resting > 0) {
    app.innerHTML = `<div class="center"><p class="muted">Rest</p><div class="timer" id="t">${resting}</div>
      <p class="muted">Next: set ${sess.set + 1} of ${e.sets} — ${esc(e.name)}</p>
      ${restReadiness()}
      <button class="btn" id="skip" style="margin-top:12px">I'm ready</button></div>`;
    wireRestCues(); wireLearnLinks();
    // Announce rest ONCE at the start (the per-second #t is not aria-live, or it
    // would spam a screen reader every tick) and move focus to the only action,
    // so a keyboard/SR user knows a timer is running and where they are.
    say(`Resting about ${resting} seconds — start your next set when your breath is back, your heart rate settles, and you're ready. Set ${sess.set + 1} of ${e.sets}, ${e.name}.`);
    $("#skip").focus();
    let left = resting;
    restTimer = setInterval(() => { left--; if ($("#t")) $("#t").textContent = left; if (left <= 0) { stopRestTimer(); say("Rest over — next set."); renderPlayer(0); } }, 1000);
    $("#skip").onclick = () => { stopRestTimer(); renderPlayer(0); };
    return;
  }

  const firstEver = e.suggested_kg == null && sess.set === 0;
  app.innerHTML = `<div class="exhead"><h1 tabindex="-1" id="ex-head">${esc(e.name)}</h1><span class="num">${sess.i + 1}/${total}</span></div>
    <p class="muted">Target: ${e.sets} sets × ${e.rep_range} reps · leave about ${e.rir} in the tank ${sess.beginner ? "" : helpDot("glossary", "ⓘ what's RIR?")}</p>
    ${e.unilateral ? `<div class="cue">↔️ One side at a time — do all ${e.sets} sets with your <b>left</b>, then repeat with your <b>right</b> (or alternate). Log the weight you used per side.</div>` : ""}
    ${e.lengthened_bias ? `<div class="cue">🎯 <b>Stretch-focused:</b> this move loads the muscle in its stretched position — where the growth signal is strongest. Feel a deep stretch at the bottom and control it; don't cut that part short.</div>` : ""}
    ${e.superset_with_name ? `<div class="cue">🔗 <b>Finishing ${esc(e.name)}:</b> you've done the paired rounds with ${esc(e.superset_with_name)} — these last set(s) are on their own, so take a normal rest.</div>` : ""}
    ${sess.set === 0 ? renderMovementDemo(e.movement_pattern) : ""}
    <div class="setdots">${setDots}</div>
    ${sess.i === 0 && sess.set === 0 ? `<div class="cue">🔥 Warm up first: 3–5 min of easy movement, then a couple of light ramp-up sets before your working sets.</div>` : ""}
    ${e.cue ? `<div class="cue">💡 ${esc(e.cue)}</div>` : ""}
    ${firstEver ? `<div class="card info"><b>New lift — let's find your weight 🎯</b>
      <p class="muted">Start light and add a little each set until the last rep is hard but clean (about ${e.rir} left in the tank). A couple of easy ramp-up sets first isn't wasted — it's how you find your number, and it's saved for next time.</p>
      <button class="btn ghost" data-learn="choosing-your-starting-weight">How to pick your starting weight</button></div>` : ""}
    <div class="card">
      ${weightStepper(w, e.equipment === "bodyweight", null)}
      <div class="stepper"><label>Reps</label><button data-r="-1" aria-label="fewer reps">–</button><div class="val" aria-live="polite">${reps}</div><button data-r="1" aria-label="more reps">+</button></div>
      ${effChips(sess.i)}
      ${confirmSet.has(e.exercise) ? `<div class="cue" role="status">${setConfirmCue(sess.i)}</div>` : ""}
      <button class="btn" id="done">${confirmSet.has(e.exercise) ? "Tap again — log it as entered" : `Done — set ${sess.set + 1} of ${e.sets}`}</button>
      ${sess.set === 0 ? `<button class="btn ghost" id="warmup" style="margin-top:6px">＋ Log a warm-up set (optional)</button>` : ""}
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
  // Optional ramp-up logging: bank a warm-up set at the current weight/reps with
  // set_type "warmup". It's crash-mirrored like any set but EXCLUDED from every
  // derivation (loggedWorkSets/isHardSet/countsForE1RM all gate on "work"), so it
  // never advances the work-set cursor, counts toward volume, or moves e1RM — it's
  // purely a record. Adjust the steppers to your warm-up load first, then tap.
  if ($("#warmup")) $("#warmup").onclick = () => {
    quitPending = false;
    sess.logged.push({ exercise: e.exercise, set_type: "warmup", weight_kg: toKg(sess.weights[sess.i]), reps: sess.reps[sess.i], completed_at: new Date().toISOString() });
    saveSess();
    const n = sess.logged.filter((l) => l.exercise === e.exercise && l.set_type === "warmup").length;
    say(`Warm-up set logged.`);
    $("#warmup").textContent = `＋ Warm-up logged ✓ (${n}) — add another?`;
  };

  // In-place stepper updates: a full repaint on every tap destroys the tapped
  // button (dumping keyboard/screen-reader focus) and never announces the new
  // value. Update the adjacent aria-live .val instead; only re-render when the
  // stepper changes SHAPE (bodyweight "+ add weight" ↔ loaded −/+ stepper).
  app.querySelectorAll("[data-w]").forEach((b) => b.onclick = () => {
    quitPending = false;
    const repaint = clearSetConfirm();
    const was = sess.weights[sess.i];
    sess.weights[sess.i] = Math.max(0, Math.round((was + +b.dataset.w) * 4) / 4);
    saveSess();
    const bw = e.equipment === "bodyweight";
    if (repaint || (bw && (was === 0 || sess.weights[sess.i] === 0))) return renderPlayer();
    setStepperVal(b, `${bw ? "+" : ""}${sess.weights[sess.i]} ${unitLabel()}${bw ? " added" : ""}`);
  });
  app.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { quitPending = false; const repaint = clearSetConfirm(); sess.reps[sess.i] = Math.max(0, sess.reps[sess.i] + +b.dataset.r); saveSess(); if (repaint) return renderPlayer(); setStepperVal(b, sess.reps[sess.i]); });
  app.querySelectorAll("[data-eff]").forEach((b) => b.onclick = () => effTap(b, () => renderPlayer()));
  $("#how").onclick = async () => {
    let d = null;
    try { d = await api(`/api/exercise/${e.exercise}`); } catch {}
    renderExerciseSheet(e, d, { label: "Back to workout", onClick: () => renderPlayer(0) });
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
    // One stray stepper tap must not poison the log: a set that dwarfs this lift's
    // own history asks once first. Confirmed sets fall straight through.
    if (needsSetConfirm(sess.i)) { confirmSet.add(e.exercise); return renderPlayer(0); }
    confirmSet.clear();
    // Read the CURRENT sess values, not the render-time consts — the steppers now
    // update in place without re-rendering, so the consts can be stale.
    const loggedSet = { exercise: e.exercise, set_type: "work", weight_kg: toKg(sess.weights[sess.i]), reps: sess.reps[sess.i], ...(sess.eff[sess.i] != null ? { rir: sess.eff[sess.i] } : {}), ...((sess.deload || e.eased) ? { deload: true } : {}), completed_at: new Date().toISOString() };
    sess.logged.push(loggedSet);
    delete sess.eff[sess.i]; // each set is its own call — an answer never carries over
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
      // Recompute the set cursor from what's already BANKED on the next exercise
      // (every other advance site does this — 808/1008/1025/1152). Without it, an
      // advance onto a partially-completed lift — reachable after Unlink or a
      // deferred "do this later" — showed "set 1 of 2" with an empty dot even
      // though a set was already banked, inviting a confused extra set. Banked
      // integrity was never at risk (the self-heal above caps totals); this only
      // corrects the displayed counter.
      if (nx < 0) sess.complete = true; else { sess.i = nx; sess.set = loggedSetCount(sess.ex[nx].exercise); }
    }
    saveSess(); // the set is banked before anything else can go wrong
    say(`Set logged — ${sess.logged.length} so far.`);
    const wasPR = checkAndCelebratePR(e, loggedSet.weight_kg, loggedSet.reps, loggedSet.deload); // overrides the say() above if it's a PR — the bigger news
    checkAndCelebrateLucky(e, loggedSet, wasPR);
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
      ${restReadiness()}
      <button class="btn" id="skip" style="margin-top:12px">I'm ready</button></div>`;
    wireRestCues(); wireLearnLinks();
    say(`Resting about ${resting} seconds — go again when your breath is back and you're ready. Round ${round + 1} of ${paired}, ${A.name} with ${B.name}.`);
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
    // sess.eff is NEVER seeded — no answer means no rir on the logged set.
    const w = sess.weights[idx], reps = sess.reps[idx];
    return `<div class="card">
      <h2 style="margin-top:0">${esc(m.name)}</h2>
      <p class="muted">Target: ${m.sets} sets × ${m.rep_range} reps · leave about ${m.rir} in the tank</p>
      ${m.unilateral ? `<div class="cue">↔️ <b>One side at a time</b> — this round is one set with your <b>left</b> and one with your <b>right</b> (log the weight per side).</div>` : ""}
      ${m.lengthened_bias ? `<div class="cue">🎯 <b>Stretch-focused:</b> feel a deep stretch at the bottom and control it; don't cut it short.</div>` : ""}
      ${m.cue ? `<div class="cue">💡 ${esc(m.cue)}</div>` : ""}
      ${round === 0 ? renderMovementDemo(m.movement_pattern) : ""}
      ${weightStepper(w, m.equipment === "bodyweight", idx)}
      <div class="stepper"><label>Reps</label><button data-r="-1" data-i="${idx}" aria-label="fewer reps">–</button><div class="val" aria-live="polite">${reps}</div><button data-r="1" data-i="${idx}" aria-label="more reps">+</button></div>
      ${effChips(idx)}
      ${confirmSet.has(m.exercise) ? `<div class="cue" role="status">${setConfirmCue(idx)}</div>` : ""}
      <button class="btn ghost" data-how="${idx}">How do I do this?</button>
    </div>`;
  };

  app.innerHTML = `<div class="exhead"><h1>🔗 Superset</h1><span class="num">round ${round + 1}/${paired}</span></div>
    <p class="muted">Do one set of each, back to back with little rest between them. Rest only after you've done <b>both</b> — that's one round. It fits more work into your time without the two moves competing.</p>
    ${L === 0 && round === 0 ? `<div class="cue">🔥 Warm up first: 3–5 min of easy movement, then a couple of light ramp-up sets before your working sets.</div>` : ""}
    ${memberBlock(L)}${memberBlock(P)}
    <button class="btn" id="doner">${[L, P].some((i) => confirmSet.has(sess.ex[i]?.exercise)) ? "Tap again — log the round as entered" : `Done — round ${round + 1} of ${paired}`}</button>
    <button class="btn ghost" id="unlink">🔓 Station busy? Do these one at a time</button>
    <button class="btn ghost" id="quitr">${quitPending ? (sess.logged.length ? "Tap again — save what you've done and end" : "Tap again to close (nothing logged yet)") : "End workout early"}</button>`;

  // In-place stepper updates (same rationale as the single-exercise player): keep
  // the tapped button alive for focus, let aria-live announce; re-render only when
  // a bodyweight stepper changes shape. #doner reads sess.* at click time already.
  app.querySelectorAll("[data-w]").forEach((b) => b.onclick = () => {
    quitPending = false;
    const repaint = clearSetConfirm();
    const i = +b.dataset.i, was = sess.weights[i];
    sess.weights[i] = Math.max(0, Math.round((was + +b.dataset.w) * 4) / 4);
    saveSess();
    const bw = sess.ex[i].equipment === "bodyweight";
    if (repaint || (bw && (was === 0 || sess.weights[i] === 0))) return renderSupersetStation(L, P, 0);
    setStepperVal(b, `${bw ? "+" : ""}${sess.weights[i]} ${unitLabel()}${bw ? " added" : ""}`);
  });
  app.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => { quitPending = false; const repaint = clearSetConfirm(); const i = +b.dataset.i; sess.reps[i] = Math.max(0, sess.reps[i] + +b.dataset.r); saveSess(); if (repaint) return renderSupersetStation(L, P, 0); setStepperVal(b, sess.reps[i]); });
  app.querySelectorAll("[data-eff]").forEach((b) => b.onclick = () => effTap(b, () => renderSupersetStation(L, P, 0)));
  app.querySelectorAll("[data-how]").forEach((b) => b.onclick = async () => {
    const m = sess.ex[+b.dataset.how];
    let d = null; try { d = await api(`/api/exercise/${m.exercise}`); } catch {}
    // renderPlayer(0) re-routes back into this station, as it always has.
    renderExerciseSheet(m, d, { label: "Back to workout", onClick: () => renderPlayer(0) });
  });
  $("#doner").onclick = () => {
    quitPending = false; // a logged round is an unambiguous "I'm continuing"
    // Same typo guard as the single-lift player, per MEMBER: a round banks two sets
    // at once, so confirming one must not wave the other through. Every flagged
    // member is confirmed TOGETHER — confirming them one at a time made a round with
    // two suspect entries unbankable, since each confirmation cleared the last.
    const suspects = stationNeedsConfirm([L, P]);
    if (suspects.length) { for (const i of suspects) confirmSet.add(sess.ex[i].exercise); return renderSupersetStation(L, P, 0); }
    confirmSet.clear();
    const roundSets = []; // both members of the round, banked together
    for (const idx of [L, P]) {
      const m = sess.ex[idx];
      const loggedSet = { exercise: m.exercise, set_type: "work", weight_kg: toKg(sess.weights[idx]), reps: sess.reps[idx], ...(sess.eff[idx] != null ? { rir: sess.eff[idx] } : {}), ...((sess.deload || m.eased) ? { deload: true } : {}), completed_at: new Date().toISOString() };
      sess.logged.push(loggedSet);
      delete sess.eff[idx]; // each set is its own call — an answer never carries over
      roundSets.push([m, loggedSet]);
    }
    say(`Round logged — ${sess.logged.length} sets so far.`);
    for (const [m, loggedSet] of roundSets) checkAndCelebrateLucky(m, loggedSet, checkAndCelebratePR(m, loggedSet.weight_kg, loggedSet.reps, loggedSet.deload));
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
// The "how do I do this?" sheet: full cues + mistakes from the KB, plus the
// inline line-art movement demo (real per-exercise footage is BLOCKERS.md #1 —
// blocked on licensed/filmed media; this is the honest, self-buildable v0).
const BIAS_LABEL = { lengthened: "loads the stretch 🎯", shortened: "loads the squeeze", "mid-range": "hardest mid-range", uniform: "even resistance" };
// ONE exercise sheet, two entrances: mid-workout from the player, and from a
// muscle guide in Learn. `back` is REQUIRED and has no default on purpose — the
// old hard-wired renderPlayer(0) does not throw when there is no live session, it
// silently drops the reader on the Today tab, so a forgotten argument would fail
// quietly. A required parameter makes the contract enumerable instead.
function renderExerciseSheet(ex, d, back) {
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
  app.innerHTML = `<h1>${esc(name)}</h1>
    ${muscles ? `<p class="muted">Works: ${esc(muscles)}</p>` : ""}
    ${chips ? `<p>${chips}</p>` : ""}
    ${renderMovementDemo(d?.movement_pattern ?? ex.movement_pattern)}
    ${d?.resistance_profile ? `<p class="muted">📈 <b>Where it's hardest:</b> ${esc(d.resistance_profile)}</p>` : ""}
    ${steps ? `<h2>Step by step</h2>${steps}` : ""}
    ${cues ? `<h2>Coaching cues</h2>${cues}` : (!steps ? `<p class="muted">No cues on file for this one.</p>` : "")}
    ${errs ? `<h2>Avoid</h2>${errs}` : ""}
    ${good ? `<h2>Good pick when</h2>${good}` : ""}
    ${bad ? `<h2>Maybe skip when</h2>${bad}` : ""}
    <button class="btn" id="back">${esc(back.label)}</button>`;
  $("#back").onclick = back.onClick;
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
    <div class="card"><b>😖 Did this hurt?</b>
      <p class="muted">Swapping only fixes today. If a joint is complaining, tell me which one and I'll keep aggravating movements out of your plan from now on.</p>
      ${INJURY_REGIONS.map(([label, id]) => `<button class="choice" data-hurt="${esc(id)}">${esc(label)}</button>`).join("")}</div>
    <button class="btn ghost" id="back">Keep ${esc(cur.name)}</button>`;
  $("#back").onclick = () => renderPlayer(0);
  // The reactive injury path app-design-spec.md:174 described and nothing implemented:
  // the swap button was generic, session-only, and never wrote anything down, so the
  // app could watch you avoid the same lift every week and never learn from it.
  app.querySelectorAll("[data-hurt]").forEach((b) => b.onclick = async () => {
    const region = b.dataset.hurt;
    const res = await api("/api/profile/injury", { method: "POST", body: JSON.stringify({ user_id: uid, region }) });
    if (res.error) { say("Couldn't save that — swapping for today instead."); return; }
    say(`Noted — I'll keep ${region.replace("-", " ")}-aggravating movements out of your plan.`);
    renderSwap(); // the alternatives list is injury-filtered server-side, so re-fetch it
  });
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
      // stretch-focused" guidance instead of inheriting a blank. movement_pattern
      // travels too, or the swapped-in lift would show the OLD lift's inline demo.
      suggested_kg: null, cue: null,
      unilateral: !!chosen?.unilateral, lengthened_bias: !!chosen?.lengthened_bias,
      movement_pattern: chosen?.movement_pattern ?? null,
      superset_with: undefined, superset_with_name: undefined,
    };
    delete sess.weights[sess.i]; delete sess.reps[sess.i]; delete sess.eff[sess.i];
    saveSess();
    say(`Swapped to ${name}.`);
    renderPlayer(0);
  });
}

// "Do this later" (mid-workout reorder): the machine's busy, so push the current
// UNSTARTED exercise to the end of the queue and move on. Only reachable at set 0
// of a non-superset lift with a later exercise to land on (guarded in the player).
// sess.weights/reps/eff are keyed by ARRAY INDEX, so moving an item must REMAP those
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
  sess.weights = remap(sess.weights); sess.reps = remap(sess.reps); sess.eff = remap(sess.eff);
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
  const winHtml = (w) => {
    if (typeof w === "string") return esc(w);
    if (w.kind === "pr-load") return `🏆 ${esc(w.name)}: new best working weight — <b>${dispWeight(w.load_kg)} ${unitLabel()}</b> × ${w.reps} reps.`;
    return `🏆 ${esc(w.name)}: new estimated best single lift — <b>${dispWeight(w.e1rm_kg)} ${unitLabel()}</b> (up ${fmtDelta(w.delta_kg)} ${unitLabel()}).`;
  };
  // A personal record is the reward moment — give it a celebratory banner at the top of the
  // recap; other wins stay as quiet rows below.
  const prWins = (recap.wins || []).filter((w) => typeof w === "object");
  const otherWins = (recap.wins || []).filter((w) => typeof w === "string");
  const prBanner = prWins.length
    ? `<div class="card" style="text-align:center;border:1px solid var(--accent)"><div style="font-size:1.6rem" aria-hidden="true">🎉</div>
        <b>New personal record${prWins.length > 1 ? "s" : ""}!</b>${recap.pr_xp ? ` <span style="color:var(--accent);font-weight:700">+${recap.pr_xp} XP</span>` : ""}
        ${prWins.map((w) => `<p class="muted" style="margin:6px 0">${winHtml(w)}</p>`).join("")}</div>`
    : "";
  const wins = otherWins.map((w) => `<div class="win">${winHtml(w)}</div>`).join("");
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
  app.innerHTML = `<div class="center"><h1>${title}</h1></div>${prBanner}${wins}${nudge}${donate}
    <button class="btn" id="ok">Done</button>`;
  if (nudge) $("#backup").onclick = () => { tab = "me"; render(); };
  $("#ok").onclick = () => { tab = "today"; render(); };
}

// ---------- Progress ----------
const statusClass = (s) => ({ "below-MEV": "s-below", "in-productive-range": "s-in", "approaching-MRV": "s-near", "over-MRV": "s-over", "maintenance": "s-maint", "secondary-served": "s-maint" }[s] || "s-none");
const statusLabel = (s) => ({ "below-MEV": "add volume", "in-productive-range": "on target", "approaching-MRV": "near max", "over-MRV": "over max", "maintenance": "holding steady", "secondary-served": "covered by compounds", "no-landmark": "—" }[s] || s);
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
  const prog = (p.progression || []).map((x) => `<div class="row">${(x.series ?? []).length > 1 ? miniSpark(x.series.map((pt) => pt.value)) : ""}<b>${esc(x.name)}${x.stalled ? ' <span class="chip" style="color:var(--warn)">⏸ stalled</span>' : ""}</b><span class="${x.change_pct >= 0 ? "" : "muted"}">${x.basis === "load" ? `${dispWeight(x.first_load_kg)}→${dispWeight(x.last_load_kg)} ${unitLabel()} top set` : `${dispWeight(x.first_e1rm)}→${dispWeight(x.last_e1rm)} ${unitLabel()}`} (${x.change_pct >= 0 ? "+" : ""}${x.change_pct}%)</span></div>`).join("") || `<p class="muted">Two weeks of data unlocks strength trends.</p>`;
  // A plateau gets an honest, KB-grounded playbook — not "add a rep" forever.
  // The plateau card now says which lever the engine is ACTUALLY pulling, instead
  // of the same three-line playbook regardless of cause. `p.adaptive` carries
  // volumeResponse's per-muscle signal, which for several waves was computed on every
  // progress read and never rendered — lesson 15's producer with no consumer, closed
  // when this card started branching on it (and `reactiveDeloadDue` started acting
  // on the same "change" signal server-side).
  // Going BACKWARDS is not a plateau and must not be dressed as one. Never shames
  // (a standing guardrail) — a decline is nearly always fuel, sleep or life, and
  // the app's job is to say that plainly and take the pressure off, not to imply
  // the user failed. Shown ABOVE the plateau card: it's the more urgent read, and
  // a lift can't sensibly be described as both at once.
  const regrCard = (p.regressions || []).length
    ? `<div class="card"><b>📉 ${p.regressions.length === 1 ? "A lift has" : p.regressions.length + " lifts have"} gone backwards</b>
        <p class="muted">${esc(p.regressions.map((r) => r.name).join(", "))} — down about ${p.regressions[0].drop_pct}% from your recent best, for two weeks running. This is almost always recovery, not training: under-eating, short sleep, illness, or a stressful stretch. It is not lost muscle, and it comes back quickly.</p>
        <p class="muted">I've stopped adding volume to those muscles until it turns around — more sets is the wrong answer to a body that isn't recovering. Eat enough, sleep, and keep showing up.</p>
        <button class="btn ghost" data-learn="stimulus-fatigue-adaptation">Read: recovery &amp; adaptation</button></div>`
    : "";
  const atCeiling = (p.adaptive || []).filter((a) => a.signal === "change");
  // Effort lever (Increment C): stalled + your own logged effort clearly above
  // target → the fix is effort, not sets. Sits between the ceiling read (deload
  // still wins) and the add-volume read (never add sets to a sandbagged stall).
  const pushHarder = (p.adaptive || []).filter((a) => a.signal === "effort");
  const canAddMore = (p.adaptive || []).filter((a) => a.signal === "add");
  const stallCard = (p.stalls || []).length
    ? `<div class="card"><b>⏸ ${p.stalls.length === 1 ? "One lift has" : p.stalls.length + " lifts have"} plateaued</b>
        <p class="muted">${esc(p.stalls.map((s) => s.name).join(", "))} — flat for ~${p.stalls[0].weeks_flat} weeks. That's normal, and fixable — and you don't have to do anything about it.</p>
        ${atCeiling.length
          ? `<p class="muted">Your ${esc(atCeiling.map((a) => a.muscle_name).join(", "))} ${atCeiling.length === 1 ? "is" : "are"} already at the top of what you can recover from, so more sets is the one thing that won't help. I'm easing the volume back and bringing a deload forward, then changing the stalled lift for a different angle next block.</p>`
          : pushHarder.length
            ? `<p class="muted">Your own effort logs show plenty left in the tank on your ${esc(pushHarder.map((a) => a.muscle_name).join(", "))} sets. Before adding volume, take the last set of each lift closer to failure — about 1–2 reps in reserve. Effort is the cheapest fix there is, so I'm holding your sets steady until it's in.</p>`
            : canAddMore.length
              ? `<p class="muted">Your ${esc(canAddMore.map((a) => a.muscle_name).join(", "))} still ${canAddMore.length === 1 ? "has" : "have"} room below your recoverable ceiling, so I'm adding sets there next block. If sleep or food has been short, fix that first — it beats any programming change.</p>`
              : `<p class="muted">Worth checking sleep and food first — under-recovery and under-eating cause more plateaus than programming does.</p>`}
        <button class="btn ghost" data-learn="breaking-advanced-plateaus">Read: Breaking plateaus</button></div>`
    : "";
  // No "what to adjust" to-do list: the plan RETUNES ITSELF each block from your
  // logged data (volume ± per muscle, bounded to your recoverable range) — you
  // don't act on suggestions, the algorithm just does it and tells you at the
  // start of the new block. A quiet one-liner here so you know it's happening.
  const autoAdaptNote = p.sessions_logged >= 4
    ? `<p class="muted" style="font-size:.85rem;text-align:center">📈 Your plan retunes itself each block from all of this — you don't have to adjust anything.</p>`
    : "";
  // Every number on this screen is derived from the log, so the log has to be
  // correctable from here — otherwise a mistyped weight is visibly wrong on the
  // very page that reports it, with nothing the user can do about it.
  const historyCard = p.sessions_logged > 0
    ? `<div class="card"><b>📓 Workout history</b>
        <p class="muted">Everything above is worked out from what you logged. Mistyped a weight? Fix it and these recalculate.</p>
        <button class="btn ghost" id="open-history">Workout history — view &amp; fix</button></div>`
    : "";
  const t = p.bodyweight_trend;
  const slopeDisp = t ? (unitPref() === "lb" ? Math.round(t.slope_kg_per_week * LB_PER_KG * 100) / 100 : t.slope_kg_per_week) : 0;
  const eb = p.energy_balance || {};
  // The wins feed (roadmap #1c): a lookback of the user's personal records — the recap
  // celebrates a PR in the moment; this is the trophy shelf you can come back to.
  // The concurrent-training read: legs flat while the upper body climbs, with leg
  // volume still inside its productive range. It sits directly under the plateau card
  // because it names the SAME stalled lifts (both read one `stalls` array) and is the
  // "why" that card can't see. Deliberately hedged copy — the app has never observed
  // the user's cardio, so it reports a pattern and names a candidate cause, never a
  // verdict. The engine returns null for almost everyone; silence is the normal case.
  const interfCard = p.interference
    ? `<div class="card"><b>🚴 Worth a look: legs flat, upper body climbing</b>
        <p class="muted">${esc(p.interference.note)}</p>
        <button class="btn ghost" data-learn="cardio-and-concurrent-training">Read: Cardio &amp; concurrent training</button></div>`
    : "";
  const prCard = (p.pr_count > 0)
    ? `<div class="card"><div class="row"><b>🏆 Personal records</b> <span class="chip">${p.pr_count}</span></div>
        ${(p.personal_records || []).map((r) => {
          const detail = r.kind === "load" ? `${dispWeight(r.load_kg)} ${unitLabel()} × ${r.reps}` : `${dispWeight(r.e1rm_kg)} ${unitLabel()} est. 1RM`;
          return `<div class="row"><span style="flex:1">${esc(r.name)}</span><span class="muted" style="font-size:.85rem">${detail}${r.date ? ` · ${esc(String(r.date).slice(0, 10))}` : ""}</span></div>`;
        }).join("")}</div>`
    : "";
  app.innerHTML = `<h1>Progress</h1>
    <div id="progress-nudge"></div>
    <div class="card"><b>${p.sessions_logged}</b> <span class="muted">session${p.sessions_logged === 1 ? "" : "s"} logged</span></div>
    ${historyCard}
    ${prCard}
    <h2>This week's sets per muscle ${helpDot("glossary", "ⓘ what these tags mean")}</h2>
    <p class="muted">${p.volume_note ? esc(p.volume_note) : "How many hard sets each muscle got this week, and whether that's in the range that builds muscle."}</p>
    <div class="card">${vol}</div>
    ${p.volumeByMuscle && p.volumeByMuscle.length ? STATUS_LEGEND : ""}
    ${autoAdaptNote}
    ${regrCard}
    ${stallCard}
    ${interfCard}
    <h2>Strength trends ${helpDot("glossary", "ⓘ how these are estimated")}</h2>
    <p class="muted">Your estimated 1-rep max where the reps allow it, your top-set weight where they don't. Watch the trend, not the exact number.</p>
    <div class="card">${prog}</div>
    <h2>Bodyweight & energy balance</h2>
    <div class="card">
      ${t ? `<p><b>${slopeDisp >= 0 ? "+" : ""}${slopeDisp} ${unitLabel()}/week</b> <span class="muted">(${t.pct_per_week}%/wk)</span></p>
        <p class="muted">${esc(eb.suggestion || "")}</p>` : `<p class="muted">Add a few bodyweights to infer your energy balance — no calorie counting needed.</p>`}
      ${(p.bodyweight_series ?? []).length >= 2 ? trendChart((p.bodyweight_series ?? []).slice(-60).map((b) => dispBw(b.kg)), { unit: ` ${unitLabel()}`, capId: "bw-cap" }) : ""}
      <div class="stepper"><label for="bw">Log weight</label><input id="bw" type="number" step="0.1" inputmode="decimal" placeholder="${unitLabel()}" style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.1rem"></div>
      <button class="btn secondary" id="logbw">Add today's weight</button>
      ${(p.bodyweight_series ?? []).length ? `<button class="btn ghost inline" id="bw-hist-toggle">✏️ View &amp; edit past days</button>
      <div id="bw-hist" class="hidden">${(p.bodyweight_series ?? []).slice(-14).reverse().map((b) => `<button class="row" data-bw-edit="${esc(b.date)}" data-bw-kg="${b.kg}" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);color:var(--text);padding:8px 0;cursor:pointer"><span style="flex:1">${esc(b.date)}</span><span>${dispBw(b.kg)} ${unitLabel()}</span></button>`).join("")}</div>` : ""}
    </div>
    <div id="story"></div>`;
  wireLearnLinks();
  // "Your story" — streak, milestones, partners, challenges (the dissolved Coach
  // tab, Wave 247) — fills its own box and refreshes independently.
  renderStory();
  if ($("#open-history")) $("#open-history").onclick = () => { historyWeeksShown = 4; tab = "history"; render(); };
  if ($("#bw-hist-toggle")) $("#bw-hist-toggle").onclick = () => $("#bw-hist").classList.toggle("hidden");
  app.querySelectorAll("[data-bw-edit]").forEach((b) => b.onclick = () => {
    // Tap a past day: the existing form edits THAT day (the server replaces
    // by date, so this is the same single door the daily log already uses).
    bwEditDate = b.dataset.bwEdit;
    $("#bw").value = dispBw(parseFloat(b.dataset.bwKg));
    $("#logbw").textContent = `Save for ${bwEditDate}`;
    $("#bw").focus();
  });
  wireChartTap("bw-cap", (p.bodyweight_series ?? []).slice(-60), (b) => `${b.date}: ${dispBw(b.kg)} ${unitLabel()}`);
  $("#logbw").onclick = async () => {
    const val = parseFloat($("#bw").value);
    // Never a silent dead button: an empty/non-numeric field must say why nothing
    // happened, or the tap reads as broken.
    if (!val || val <= 0) { say("Type your weight first."); $("#bw").placeholder = `type a number first (${unitLabel()})`; $("#bw").focus(); return; }
    const kg = toKg(val);
    // Send today's LOCAL date at log time (not the UTC date — `addBodyweight`
    // replaces same-date rows, so a UTC-mislabeled date for anyone west of UTC
    // can silently collide with and overwrite a genuinely different day's
    // weigh-in) so an offline weigh-in keeps its real date and a replayed POST
    // replaces the same-day row instead of duplicating it.
    const res = await postOrQueue("/api/bodyweight", { user_id: uid, kg, date: bwEditDate ?? localDay() });
    bwEditDate = null;
    if (res.ok) return renderProgress();
    $("#bw").value = "";
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "📴 Saved offline — it'll sync when you're back online.";
    $("#logbw").after(note);
  };
}

// ---------- Workout history (correcting the log) ----------
// A logged set used to be permanent — one mistyped weight was celebrated as a PR,
// anchored the next session's suggestion, and sat in the plateau trends forever,
// fixable only by wiping the account. This is the repair surface.
//
// "Take it back" VOIDS rather than deletes ("never lose logged data" is a standing
// guardrail): the workout stays on this screen, greyed and reversible, and is
// simply excluded from every engine that reads history. So the screen has to show
// voided sessions — you can't offer undo for something you refuse to display.
const sessionVolume = (sess) => (sess.sets ?? []).filter((x) => (x.set_type ?? "work") !== "warmup").length;

// Legacy logs can contain an impossible, malformed, or far-future timestamp. The
// API deliberately returns those records with `time_quarantine` rather than
// letting one bad device clock contaminate coaching. Date rendering must therefore
// never trust `new Date(value)` blindly: "Invalid Date" is not an explanation or
// a route back to a usable log.
const HISTORY_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validHistoryCalendarDate(value) {
  if (typeof value !== "string") return null;
  const m = HISTORY_DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? value : null;
}
// The picker's ceiling must be the SERVER's ceiling, not the device's local
// tomorrow. This used to be device-local, which offered far-east users a day the
// server refused; the wave that "fixed" that by widening the server instead made
// the server accept dates its own read path then re-quarantined. Narrowing the
// picker is the correct half: the server's rule (now + 24h, UTC calendar day) is
// provably never stricter than the user's own local TODAY at any offset from
// -12:00 to +14:00 — it only excludes tomorrow, which nobody has trained yet.
function historyTomorrow() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function historyDateInputValue(sess) {
  const local = validHistoryCalendarDate(sess?.local_date);
  if (local && local <= historyTomorrow()) return local;
  // A plain old `date` (or an ISO timestamp whose calendar part was valid) makes
  // a useful default, but never pre-fills the very future date that caused the
  // quarantine in the first place.
  const fromDate = validHistoryCalendarDate(String(sess?.date ?? "").slice(0, 10));
  return fromDate && fromDate <= historyTomorrow() ? fromDate : "";
}
function formatHistoryDate(sess) {
  const calendar = validHistoryCalendarDate(sess?.local_date) || validHistoryCalendarDate(String(sess?.date ?? "").slice(0, 10));
  const ms = calendar ? Date.parse(`${calendar}T12:00:00`) : Date.parse(sess?.date ?? "");
  if (!Number.isFinite(ms)) return "Date needs correcting";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));
}

async function renderHistory() {
  app.innerHTML = `<h1>Workout history</h1><p class="muted">Loading…</p>`;
  let d;
  try { d = await api("/api/sessions"); }
  catch {
    app.innerHTML = `<h1>Workout history</h1><div class="card"><p>📴 You're offline.</p>
      <p class="muted">Your history loads when you reconnect. Nothing you've logged is lost.</p>
      <button class="btn" id="rh">Try again</button></div>`;
    $("#rh").onclick = () => renderHistory();
    return;
  }
  const list = d.sessions || [];
  if (historyEdit) {
    const sess = list.find((x) => x.session_id === historyEdit);
    if (!sess) { historyEdit = null; return renderHistory(); }
    const rows = (sess.sets ?? []).map((set, i) => `<div class="row">
      <div style="flex:1"><b>${esc(set.name || set.exercise)}</b>${(set.set_type ?? "work") === "warmup" ? ' <span class="chip">warm-up</span>' : ""}</div>
      <input data-w="${i}" type="number" step="0.25" inputmode="decimal" value="${dispWeight(set.weight_kg)}" aria-label="weight for set ${i + 1}"
        style="width:5.5rem;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px;font-size:1rem">
      <span class="muted">${unitLabel()} ×</span>
      <input data-reps="${i}" type="number" step="1" inputmode="numeric" value="${set.reps}" aria-label="reps for set ${i + 1}"
        style="width:4rem;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px;font-size:1rem">
    </div>`).join("");
    const quarantined = !!sess.time_quarantine;
    app.innerHTML = `<h1>Fix this workout</h1>
      <p class="muted">${esc(sess.session_name || "Workout")} · ${esc(formatHistoryDate(sess))}</p>
      ${quarantined ? `<div class="card info"><b>🕒 Its date still needs correcting</b><p class="muted" style="margin-top:8px">This workout is safely kept out of your trends until you fix its calendar date from the workout list.</p></div>` : ""}
      <div class="card">${rows || `<p class="muted">No sets on this workout.</p>`}</div>
      <button class="btn" id="hsave">Save corrections</button>
      <button class="btn ghost" id="hcancel">Cancel</button>`;
    $("#hcancel").onclick = () => { historyEdit = null; renderHistory(); };
    $("#hsave").onclick = async () => {
      // Send the sets back WHOLE, preserving every field the server gave us
      // (set_type, rir, deload, completed_at) — the route re-normalises, so an edit
      // is bounded exactly like the original log, but anything we drop here is lost.
      const sets = (sess.sets ?? []).map((set, i) => {
        const { name, ...rest } = set; // `name` is a display-only field this screen added
        const wv = parseFloat(app.querySelector(`[data-w="${i}"]`)?.value);
        const rv = parseInt(app.querySelector(`[data-reps="${i}"]`)?.value, 10);
        return { ...rest, weight_kg: Number.isFinite(wv) ? toKg(wv) : rest.weight_kg, reps: Number.isFinite(rv) ? rv : rest.reps };
      });
      const res = await api("/api/session/update", { method: "POST", body: JSON.stringify({ user_id: uid, session_id: sess.session_id, sets }) });
      if (res.error) { say("Couldn't save that — try again."); return; }
      historyEdit = null;
      say("Workout corrected. Your trends have been recalculated.");
      renderHistory();
    };
    return;
  }
  const sessCard = (sess) => {
    const voided = !!sess.voided_at;
    const quarantined = !!sess.time_quarantine;
    const when = formatHistoryDate(sess);
    const fixingDate = historyDateFix === sess.session_id;
    // This is deliberately an in-place native date control, rather than a
    // free-text prompt: it gives a keyboard/screen-reader label and prevents the
    // user from having to learn the timestamp format that went wrong.
    // A voided workout is excluded from every trend by `voided_at`, whatever its
    // date. Offering "set the day you actually trained and it will count again"
    // there — and then announcing "it now counts toward your trends" on save —
    // states the opposite of what the user themselves told the app when they took
    // it back (lesson 10). The date still needs correcting, so the card stays; only
    // the promise changes, and it names the real next step.
    const timingRepair = quarantined
      ? `<div class="card info" role="status" style="margin:10px 0 0"${fixingDate ? " data-date-fix-card" : ""}>
          <b>🕒 Date needs correcting</b><span class="chip" style="margin-left:6px">${voided ? "taken back" : "not counted yet"}</span>
          <p class="muted" style="margin:8px 0">${voided
            ? "This workout is safely saved, but you've taken it back, so it isn't counting. Its recorded time also needs fixing — set the day you actually trained, then put it back if you want it to count."
            : "This workout is safely saved, but its recorded time is not safe to use for your streak, progress, or coaching. Set the day you actually trained and it will count again."}</p>
          ${fixingDate
            ? `<label class="muted" style="display:block" for="history-corrected-date">Actual workout date</label>
               <input id="history-corrected-date" type="date" value="${esc(historyDateInputValue(sess))}" max="${historyTomorrow()}" aria-describedby="history-date-help"
                 style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:1.05rem;margin:4px 0 8px">
               <p class="muted" id="history-date-help" style="font-size:.85rem;margin:0 0 8px">Choose the local calendar day you did this workout.</p>
               <p class="muted" data-date-fix-message></p>
               <button class="btn secondary" data-save-date="${esc(sess.session_id)}">Save actual date</button>
               <button class="btn ghost" data-cancel-date="${esc(sess.session_id)}">Cancel</button>`
            : `<button class="btn secondary" data-fix-date="${esc(sess.session_id)}">🗓 Fix date</button>`}
        </div>`
      : "";
    return `<div class="card"${voided ? ' style="opacity:.55"' : ""}>
      <div class="row"><div style="flex:1">
        <b>${esc(sess.session_name || "Workout")}</b>${voided ? ' <span class="chip">taken back</span>' : ""}${sess.edited_at && !voided ? ' <span class="chip">edited</span>' : ""}
        <div class="muted" style="font-size:.85rem">${esc(when)} · ${sessionVolume(sess)} set${sessionVolume(sess) === 1 ? "" : "s"}</div>
      </div></div>
      ${timingRepair}
      ${voided
        ? `<button class="btn ghost inline" data-unvoid="${esc(sess.session_id)}">↩︎ Put it back</button>`
        : `<button class="btn ghost inline" data-edit="${esc(sess.session_id)}">✏️ Fix the numbers</button>
           <button class="btn ghost inline" data-void="${esc(sess.session_id)}">🚫 This didn't happen</button>`}
    </div>`;
  };
  // Grouped by calendar week (the list is already newest-first with quarantined
  // rows pinned), and capped: unbounded one-card-per-session was the tab's whole
  // scroll cost. Unparseable-date rows lead in their own group so the repair
  // card can never sink beneath weeks it doesn't belong to; voided rows stay
  // visible inside their week (never lose logged data — hiding is not grouping).
  const groups = groupSessionsByWeek(list, (s) => validHistoryCalendarDate(s.local_date) || validHistoryCalendarDate(String(s.date ?? "").slice(0, 10)));
  const dateless = groups.filter((g) => g.week === null);
  const dated = groups.filter((g) => g.week !== null);
  const shown = dated.slice(0, historyWeeksShown);
  const more = dated.length - shown.length;
  const rows = ([
    ...dateless.map((g) => `<h2>🕒 Date needs correcting</h2>${g.sessions.map(sessCard).join("")}`),
    ...shown.map((g) => `<h2>${esc(weekLabelOf(g.week))}</h2>${g.sessions.map(sessCard).join("")}`),
  ].join("") + (more > 0 ? `<button class="btn secondary inline" id="more-weeks">Show earlier weeks (${more} more)</button>` : ""))
    || `<div class="card"><p class="muted">No workouts logged yet. Once you've trained, they'll show up here — and you can correct anything that went in wrong.</p></div>`;
  app.innerHTML = `<h1>Workout history</h1>
    <p class="muted">Mistyped a weight? Fix it here and every trend recalculates. Nothing is ever deleted — a workout you take back stays on this list and can be put straight back.</p>
    ${rows}
    <button class="btn ghost" id="hback">‹ Back to progress</button>`;
  if ($("#more-weeks")) $("#more-weeks").onclick = () => { historyWeeksShown += 4; renderHistory(); };
  $("#hback").onclick = () => { historyWeeksShown = 4; tab = "progress"; render(); };
  app.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => { historyDateFix = null; historyEdit = b.dataset.edit; renderHistory(); });
  app.querySelectorAll("[data-fix-date]").forEach((b) => b.onclick = () => { historyEdit = null; historyDateFix = b.dataset.fixDate; renderHistory(); });
  app.querySelectorAll("[data-cancel-date]").forEach((b) => b.onclick = () => { historyDateFix = null; renderHistory(); });
  app.querySelectorAll("[data-save-date]").forEach((b) => b.onclick = async () => {
    const box = b.closest("[data-date-fix-card]");
    const input = box?.querySelector("#history-corrected-date");
    const message = box?.querySelector("[data-date-fix-message]");
    const corrected_local_date = input?.value || "";
    if (!validHistoryCalendarDate(corrected_local_date) || corrected_local_date > historyTomorrow()) {
      if (message) message.textContent = "Choose a real date up to tomorrow before saving.";
      input?.focus();
      return;
    }
    b.disabled = true;
    if (message) message.textContent = "Saving…";
    let res;
    try { res = await api("/api/session/update", { method: "POST", body: JSON.stringify({ user_id: uid, session_id: b.dataset.saveDate, corrected_local_date }) }); }
    catch { res = null; }
    if (!res || res.error) {
      b.disabled = false;
      // api() resolves a 4xx as a normal body, so "no response" and "the server
      // said no" arrive the same way here and used to be reported identically —
      // as a connection problem. A rejected date is not a network fault, and
      // telling someone to check their connection sends them to retry the exact
      // value that will be refused again, on the one screen that is the only exit
      // from a timing quarantine.
      if (message) message.textContent = res?.error === "bad-date"
        ? "That date can't be right — pick a day that isn't in the future."
        : res?.error
          ? "Couldn't correct the date — try again."
          : "Couldn't reach the server — check your connection and try again.";
      return;
    }
    historyDateFix = null;
    const wasVoided = !!list.find((x) => x.session_id === b.dataset.saveDate)?.voided_at;
    say(wasVoided
      ? "Workout date corrected. It's still taken back — put it back if you want it to count."
      : "Workout date corrected. It now counts toward your trends.");
    renderHistory();
  });
  const setVoid = async (sessionId, voided) => {
    const res = await api("/api/session/void", { method: "POST", body: JSON.stringify({ user_id: uid, session_id: sessionId, voided }) });
    if (res.error) { say("Couldn't do that — try again."); return; }
    say(voided ? "Taken back — it no longer counts toward your trends. You can put it back any time." : "Put back — it counts again.");
    renderHistory();
  };
  app.querySelectorAll("[data-void]").forEach((b) => b.onclick = () => setVoid(b.dataset.void, true));
  app.querySelectorAll("[data-unvoid]").forEach((b) => b.onclick = () => setVoid(b.dataset.unvoid, false));
}

// ---------- Fuel (nutrition: calorie/macro targets + daily intake log) ----------
const fld = (id, label, val, ph, extra = "") => `<label for="${id}" class="muted">${label}</label>
  <input id="${id}" type="number" inputmode="decimal" value="${val ?? ""}" placeholder="${ph}" ${extra}
    style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:1.05rem;margin:2px 0 10px">`;
let fuelEdit = false;
async function renderFuel() {
  app.innerHTML = `<h1>Fuel</h1><p class="muted">Loading…</p>`;
  let n; try { n = await api("/api/nutrition?d=" + localDay()); } catch {
    app.innerHTML = `<h1>Fuel</h1><div class="card"><p>📴 You're offline.</p><p class="muted">Your targets load when you reconnect.</p><button class="btn" id="rf">Try again</button></div>`;
    $("#rf").onclick = () => renderFuel(); return;
  }
  const t = n.nutrition;
  // --- stats form (first run, or "edit stats") ---
  if (!t || fuelEdit) {
    // The Navy tape estimate needs the hip measure for women — without a hip field a
    // female user who leaves BF% blank estimates to null and loops on the blank form.
    const isFemale = n.sex === "female";
    // Sex is asked HERE, not at onboarding, because this is the only place it does
    // anything: the Navy/BMI body-fat formulas differ by sex, and an unknown sex
    // falls through to the male formula. Asking it in the wizard cost every user a
    // question under copy claiming it "sets sensible starting points" for training,
    // which was false — it has no effect on the plan at all.
    const sexRow = `<label class="muted" style="display:block;margin-top:4px">Sex <span class="muted" style="font-size:.85rem">— the body-fat estimate below uses a different formula for each; it changes nothing about your training.</span></label>
      <div class="row" style="gap:6px;margin:4px 0 12px">
        ${[["Male", "male"], ["Female", "female"], ["Prefer not to say", "prefer-not-to-say"]]
          .map(([label, v]) => `<button class="choice${n.sex === v ? " sel" : ""}" data-sex="${v}" style="flex:1">${label}</button>`).join("")}
      </div>`;
    app.innerHTML = `<h1>Fuel</h1>
      <div class="card"><p class="muted">A few numbers and I'll set your daily calorie + protein targets, then dial them in from your logged food and weight. ${helpDot("energy-balance", "ⓘ how this works")}</p>
        ${sexRow}
        ${fld("f-weight", `Bodyweight (${unitLabel()})`, "", unitPref() === "lb" ? "e.g. 180" : "e.g. 82")}
        ${fld("f-height", "Height (cm)", "", "e.g. 178")}
        ${fld("f-bf", "Body fat % (optional)", "", "e.g. 18")}
        <p class="muted" style="margin:2px 0 8px">Weight and height are enough to start. Want a sharper estimate? Add your body fat %, or a tape measure:</p>
        ${fld("f-waist", "Waist (cm, at the navel)", "", "optional")}
        ${fld("f-neck", "Neck (cm)", "", "optional")}
        <div id="f-hip-row" style="display:${isFemale ? "block" : "none"}">${fld("f-hip", "Hip (cm, at the widest)", "", "optional")}</div>
        <label for="f-act" class="muted">Daily activity (outside training)</label>
        <select id="f-act" style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:1.05rem;margin:2px 0 12px">
          <option value="sedentary">Mostly sitting (desk job)</option>
          <option value="light">Lightly active (some walking)</option>
          <option value="moderate" selected>Moderately active (on your feet a fair bit)</option>
          <option value="active">Very active (physical job)</option>
        </select>
        <p class="muted" style="margin:-6px 0 12px;font-size:.85rem">Steps and cardio swing this more than most people expect — though your targets re-derive from your logged weight either way. ${helpDot("cardio-and-concurrent-training", "ⓘ cardio &amp; lifting")}</p>
        <button class="btn" id="f-save">Set my targets</button>
        ${t ? `<button class="btn ghost" id="f-cancel">Cancel</button>` : ""}
        <p class="muted" id="f-msg"></p></div>`;
    wireLearnLinks();
    if ($("#f-cancel")) $("#f-cancel").onclick = () => { fuelEdit = false; renderFuel(); };
    // NO re-render, and no POST. The previous version did both, under a comment
    // claiming it preserved what the user had typed — it did the opposite: every
    // `fld()` call in this form passes "" as its value, so re-rendering returned a
    // completely blank form and silently dropped body fat, waist, neck and activity
    // (which the tap-POST never harvested at all). The only thing the tap needs to
    // do is reveal the hip field, which the Navy formula needs for a female user.
    // Selection is held in the DOM and read at save, like every other field here.
    app.querySelectorAll("[data-sex]").forEach((b) => b.onclick = () => {
      app.querySelectorAll("[data-sex]").forEach((o) => o.classList.toggle("sel", o === b));
      const hip = $("#f-hip-row");
      if (hip) hip.style.display = b.dataset.sex === "female" ? "block" : "none";
    });
    $("#f-save").onclick = async () => {
      // Null-safe: #f-hip only exists in the DOM for a female user (the Navy
      // formula's hip measure), so reading it unconditionally for anyone else
      // threw on `.value` of null and killed the save before the request fired.
      const g = (id) => { const el = $(id); if (!el) return undefined; const v = parseFloat(el.value); return Number.isFinite(v) && v > 0 ? v : undefined; };
      const weightDisp = g("#f-weight"), height = g("#f-height"), bf = g("#f-bf"), waist = g("#f-waist"), neck = g("#f-neck"), hip = g("#f-hip");
      // The weight field shows in the user's display unit like every other weight in the
      // app — convert to kg before it's stored, or an lb entry corrupts the trend + TDEE.
      const weight = weightDisp != null ? toKg(weightDisp) : undefined;
      if (!weight) { $("#f-msg").textContent = "Enter your bodyweight to start."; return; }
      if (!height) { $("#f-msg").textContent = "Add your height too — with that I can start your targets."; return; }
      if (bf && (bf < 2 || bf >= 60)) { $("#f-msg").textContent = "That body fat % looks off — enter a value between about 3 and 55."; return; }
      // BF% and the tape measures are OPTIONAL refinements — weight + height alone seed a rough
      // BMI-based estimate the adaptive TDEE later corrects, so no "add BF% or a tape measure"
      // gate (that wall bounced novices off the whole nutrition half of the app).
      try {
        // Same local-date requirement as the Progress-tab logger above — both
        // writes below can record a bodyweight row, and the server only falls
        // back to the UTC date when none is sent.
        await api("/api/bodyweight", { method: "POST", body: JSON.stringify({ user_id: uid, kg: weight, date: localDay() }) });
        await api("/api/nutrition/profile", { method: "POST", body: JSON.stringify({ user_id: uid, sex: app.querySelector("[data-sex].sel")?.dataset.sex ?? n.sex ?? undefined, weight_kg: weight, height_cm: height, bf_pct: bf, waist_cm: waist, neck_cm: neck, hip_cm: hip, activity: $("#f-act").value, date: localDay() }) });
        fuelEdit = false; say("Targets set."); renderFuel();
      } catch { $("#f-msg").textContent = "📴 Couldn't save — try again when you're online."; }
    };
    return;
  }
  // --- targets + daily log ---
  const goalTxt = t.weekly_change_kg > 0 ? `gaining ~${t.weekly_change_kg} kg/week` : t.weekly_change_kg < 0 ? `losing ~${Math.abs(t.weekly_change_kg)} kg/week` : "holding your weight";
  // Today's logged intake vs target (closes the tracker loop): a progress bar +
  // remaining, so a glance shows how the day is tracking.
  const eaten = n.today?.kcal || 0;
  const pct = Math.min(100, Math.round((eaten / t.calorie_target) * 100));
  const remain = t.calorie_target - eaten;
  const todayCard = eaten > 0
    ? `<div class="card"><div class="row"><b>Today so far</b><span class="muted">${eaten} / ${t.calorie_target} kcal</span></div>
        <div class="bar" style="margin:8px 0 4px"><i style="width:${pct}%;background:${remain < -100 ? "var(--warn)" : "var(--accent)"}"></i></div>
        <p class="muted" style="font-size:.85rem">${remain >= 0 ? `${remain} kcal left today` : `${Math.abs(remain)} kcal over — no drama, it evens out`}${n.today?.protein_g ? ` · ${n.today.protein_g} / ${t.protein_g} g protein` : ""}</p></div>`
    : "";
  app.innerHTML = `<h1>Fuel</h1>
    <div class="card center"><div class="big">${t.calorie_target} <span class="muted" style="font-size:1rem">kcal/day</span></div>
      <p class="muted">Target for ${goalTxt}. ${t.tdee_basis === "logged" ? "Dialled in from your logs." : "Starting estimate."}</p></div>
    ${todayCard}
    <h2>Daily macros ${helpDot("protein", "ⓘ why these numbers")}</h2>
    <div class="card"><div class="row"><div style="flex:1"><b>🥩 Protein</b><br><span class="muted">${t.protein_g} g (${t.protein_per_kg} g/kg — the priority)</span></div></div>
      <div class="row"><div style="flex:1"><b>🍚 Carbs</b><br><span class="muted">${t.carbs_g} g — fuel your training</span></div></div>
      <div class="row"><div style="flex:1"><b>🥑 Fat</b><br><span class="muted">${t.fat_g} g</span></div></div></div>
    <h2>Log today's intake</h2>
    <div class="card"><p class="muted">Log what you ate (a rough daily total is fine). After ~2 weeks I re-estimate your real maintenance from your food + weight — no formula beats your own data.</p>
      ${fld("f-kcal", "Calories eaten today", "", "e.g. 2600")}
      ${fld("f-protein", "Protein (g, optional)", "", "e.g. 180")}
      <button class="btn" id="f-log">Log today</button><p class="muted" id="f-logmsg">${n.logged_days ? `${n.logged_days} day${n.logged_days === 1 ? "" : "s"} logged.` : ""}</p></div>
    ${(n.log ?? []).length >= 2 ? `<h2>Intake history</h2><div class="card">
      <p class="muted" style="margin:0 0 4px">Daily calories — the dashed line is your ${t.calorie_target} kcal target.</p>
      ${trendChart((n.log ?? []).slice(-30).map((e) => e.kcal), { unit: "", target: t.calorie_target, capId: "kcal-cap" })}
      <button class="btn ghost inline" id="fl-hist-toggle">✏️ View &amp; edit past days</button>
      <div id="fl-hist" class="hidden">${(n.log ?? []).slice(-14).reverse().map((e) => `<button class="row" data-fl-edit="${esc(e.date)}" data-fl-kcal="${e.kcal}" data-fl-protein="${e.protein_g ?? ""}" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);color:var(--text);padding:8px 0;cursor:pointer"><span style="flex:1">${esc(e.date)}</span><span>${e.kcal} kcal${e.protein_g ? ` · ${e.protein_g}g protein` : ""}</span></button>`).join("")}</div></div>` : ""}
    <div class="card"><p class="muted">Maintenance estimate: <b>${t.tdee}</b> kcal (${t.tdee_basis}). ${esc(t.note)}</p></div>
    <button class="btn ghost" id="f-editstats">Edit my stats</button>`;
  wireLearnLinks();
  $("#f-editstats").onclick = () => { fuelEdit = true; renderFuel(); };
  if ($("#fl-hist-toggle")) $("#fl-hist-toggle").onclick = () => $("#fl-hist").classList.toggle("hidden");
  app.querySelectorAll("[data-fl-edit]").forEach((b) => b.onclick = () => {
    fuelLogDate = b.dataset.flEdit;
    $("#f-kcal").value = b.dataset.flKcal;
    $("#f-protein").value = b.dataset.flProtein || "";
    $("#f-log").textContent = `Save for ${fuelLogDate}`;
    $("#f-kcal").focus();
  });
  wireChartTap("kcal-cap", (n.log ?? []).slice(-30), (e) => `${e.date}: ${e.kcal} kcal${e.protein_g ? ` · ${e.protein_g}g protein` : ""}`);
  $("#f-log").onclick = async () => {
    const kcal = parseFloat($("#f-kcal").value); const protein = parseFloat($("#f-protein").value);
    if (!Number.isFinite(kcal) || kcal <= 0) { $("#f-logmsg").textContent = "Enter today's calories."; return; }
    try {
      const r = await api("/api/nutrition/log", { method: "POST", body: JSON.stringify({ user_id: uid, kcal, date: fuelLogDate ?? localDay(), ...(Number.isFinite(protein) && protein > 0 ? { protein_g: protein } : {}) }) });
      fuelLogDate = null;
      say("Logged."); $("#f-logmsg").textContent = `Logged — ${r.logged_days} day${r.logged_days === 1 ? "" : "s"} in. ${r.nutrition.tdee_basis === "logged" ? "Targets updated from your data." : ""}`;
      $("#f-kcal").value = ""; $("#f-protein").value = "";
      if (r.nutrition.tdee_basis === "logged") renderFuel();
    } catch { $("#f-logmsg").textContent = "📴 Couldn't log — try again when connected."; }
  };
}

// ---------- Me ----------
// The health & safety note (BLOCKERS #5): plain-English, honest, supportive —
// shown from the welcome screen ("By starting you agree…") and always reachable
// from the Me tab. The server stamps acceptance (profile.disclaimer_ack) at
// onboard, because the welcome screen carries this note before /api/onboard can
// ever be reached.
function renderHealthNote(back) {
  // nav visibility is the caller's state — the welcome screen already hides it,
  // the Me tab keeps it; this screen changes nothing either way.
  app.innerHTML = `<h1>Health &amp; safety</h1>
    <div class="card"><p><b>This app is a coach, not a doctor.</b> Everything in it — plans, weights, effort targets, nutrition numbers — is general training guidance built from published research. It isn't medical advice, diagnosis, or treatment.</p></div>
    <div class="card"><p><b>Check with a professional first if any of this is you:</b> a heart condition or other diagnosed illness, an injury currently being treated, you're pregnant or recently postpartum, you're returning to exercise after a long time away, or you're simply not sure. One conversation with a doctor or physio beats guessing.</p></div>
    <div class="card"><p><b>Pain is a stop sign.</b> Muscles burning during a hard set is normal. Sharp pain, joint pain, chest pain, dizziness, or feeling faint is not — end the session. If it's chest pain or you feel seriously unwell, get medical help right away.</p></div>
    <div class="card"><p><b>You lift at your own risk.</b> Training with weights carries a small but real risk of injury. Staying within your ability, following the form cues, and leaving reps in reserve keeps that risk low — but it's never zero, and you're the one in the room.</p></div>
    <div class="card"><p><b>The injury guidance is a comfort feature, not treatment.</b> When you report an injury, the app steers exercises away from that region so you can keep training around it. A real injury deserves a real professional.</p></div>
    <div class="card"><p><b>Fuel targets are estimates for healthy adults.</b> The calorie and macro numbers come from population formulas and adapt to your logged data — useful guidance, not a prescription. If you have a history of disordered eating or a medical condition affecting diet, please work with a professional instead of the tracker.</p></div>
    <p class="muted">Train hard, be sensible, and when in doubt — ask a human who can see you. 💪</p>
    <button class="btn ghost" id="healthback">‹ Back</button>`;
  $("#healthback").onclick = back;
}

// A merge never has to be destructive. The API exposes only a deliberately
// capability-free archive summary to the survivor; a restoration makes a fresh,
// separate identity. Keep the response local to this page until the person makes
// the separate, explicit choice to switch devices into that restored copy.
const mergeArchiveCache = new Map();
const mergeArchiveLoads = new Map();
const mergeArchiveRestores = new Map();
const mergeArchiveNotices = new Map();
const mergeArchiveBusy = new Set();
const mergeArchiveKey = (ownerId, archiveId) => `${ownerId}\u0000${archiveId}`;

function safeMergeArchive(raw) {
  if (!raw || typeof raw.archive_id !== "string" || !raw.archive_id) return null;
  const count = (name) => {
    const n = Number(raw.counts?.[name]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  return {
    archive_id: raw.archive_id,
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    // Unknown states intentionally collapse to the retryable, safe action rather
    // than exposing implementation details or assuming a copy was restored.
    state: raw.state === "restored" ? "restored" : raw.state === "restoring" ? "restoring" : "available",
    restored_at: typeof raw.restored_at === "string" ? raw.restored_at : null,
    // Split deliberately: `counts` is what a restore BRINGS BACK, `not_restored`
    // is what the source account had that a restore will not revive. The archive
    // records those as counts only — it never keeps the endpoint keys, share token
    // or magic-link hash that would make them usable — so this is the most the
    // client could ever say about them, and saying it is better than a user
    // discovering their old reminders never came back.
    counts: { sessions: count("sessions"), bodyweights: count("bodyweights"), checkins: count("checkins"), nutrition: count("nutrition_logs") },
    not_restored: { devices: count("push_subscriptions"), shares: count("shares") },
  };
}
function archiveWhen(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(ms)) : "an earlier merge";
}
function archiveCountSummary(counts) {
  const parts = [
    counts.sessions ? `${counts.sessions} workout${counts.sessions === 1 ? "" : "s"}` : "",
    counts.bodyweights ? `${counts.bodyweights} weigh-in${counts.bodyweights === 1 ? "" : "s"}` : "",
    counts.checkins ? `${counts.checkins} check-in${counts.checkins === 1 ? "" : "s"}` : "",
    counts.nutrition ? `${counts.nutrition} food log${counts.nutrition === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "saved account data";
}
// Names what the copy will be missing, so "capabilities stay off" is concrete
// rather than abstract. Silent when the source had none, so nobody reads a
// sentence about devices they never had.
function archiveNotRestoredNote(notRestored) {
  const parts = [
    notRestored?.devices ? `${notRestored.devices} notification device${notRestored.devices === 1 ? "" : "s"}` : "",
    notRestored?.shares ? "a public share link" : "",
  ].filter(Boolean);
  return parts.length ? ` That account had ${parts.join(" and ")} — you'd set ${parts.length > 1 ? "those" : "that"} up again on the copy.` : "";
}
function restoreUnitsLabel(units) {
  return units === "imperial" ? "pounds" : units === "metric" ? "kilograms" : null;
}
function loadMergeArchives(ownerId, force = false) {
  if (!ownerId) return Promise.resolve([]);
  if (!force && mergeArchiveCache.has(ownerId)) return Promise.resolve(mergeArchiveCache.get(ownerId));
  if (mergeArchiveLoads.has(ownerId)) return mergeArchiveLoads.get(ownerId);
  const request = api("/api/merge-archives")
    .then((body) => {
      if (body?.error) throw new Error("archive-list-failed");
      const archives = Array.isArray(body?.archives) ? body.archives.map(safeMergeArchive).filter(Boolean) : [];
      mergeArchiveCache.set(ownerId, archives);
      return archives;
    })
    .catch(() => null)
    .finally(() => { mergeArchiveLoads.delete(ownerId); });
  mergeArchiveLoads.set(ownerId, request);
  request.then((archives) => {
    // Do not repaint a screen the person has already left, and do not let a late
    // answer from the old account paint over a manually switched identity.
    if (archives && uid === ownerId && tab === "me") renderMe();
  });
  return request;
}
function mergeArchiveCard(ownerId) {
  const archives = mergeArchiveCache.get(ownerId);
  if (!Array.isArray(archives) || !archives.length) return "";
  const cards = archives.map((archive) => {
    const key = mergeArchiveKey(ownerId, archive.archive_id);
    const restored = mergeArchiveRestores.get(key);
    const notice = mergeArchiveNotices.get(key);
    const outcome = restored
      ? `<div class="card info" style="margin:10px 0 0"><b>✓ Separate copy ready</b>
          <p class="muted" style="margin:8px 0">${restored.program_name ? `Program: ${esc(restored.program_name)}.` : "Your saved program is ready."}${restoreUnitsLabel(restored.units) ? ` It uses ${restoreUnitsLabel(restored.units)}.` : ""} This account has not been changed.</p>
          <p class="muted" style="margin:8px 0">The copy does not reactivate reminders, sharing, partners, cheers, or challenges. Switch only when you are ready to use that separate copy on this device.</p>
          <button class="btn" data-switch-restored="${esc(archive.archive_id)}">Switch to the recovered copy</button>
        </div>`
      : "";
    const restoredLabel = archive.state === "restored"
      ? `A separate copy was prepared${archive.restored_at ? ` on ${esc(archiveWhen(archive.restored_at))}` : ""}. You can safely reopen its switch option.`
      : archive.state === "restoring"
        ? "A restore was already started. Check its separate copy without creating another one."
        : "Recover it as a separate copy; this account stays exactly as it is.";
    const actionLabel = archive.state === "available" ? "Recover a separate copy" : "Show recovered copy";
    return `<div class="card" style="margin-top:10px"><b>↩︎ Merged account recovery</b>
      <p class="muted" style="margin:8px 0">Archived ${esc(archiveWhen(archive.created_at))} · ${esc(archiveCountSummary(archive.counts))}</p>
      <p class="muted" style="margin:8px 0">${restoredLabel}</p>
      <p class="muted" style="font-size:.85rem;margin:8px 0">Training records and settings are copied. For safety, external capabilities stay off: no push reminders, public shares, follows, cheers, or challenges are reactivated.${archiveNotRestoredNote(archive.not_restored)}</p>
      ${outcome || `<button class="btn secondary" data-restore-archive="${esc(archive.archive_id)}">${actionLabel}</button>`}
      ${notice ? `<p class="muted" style="margin:8px 0" role="status">${esc(notice)}</p>` : ""}
    </div>`;
  }).join("");
  return `<section aria-label="Merged account recovery"><h2>Recover a merged account</h2>
    <p class="muted">A full recovery copy is available. It never replaces this account.</p>${cards}</section>`;
}
function updateMergeArchiveSummary(ownerId, summary) {
  const safe = safeMergeArchive(summary);
  if (!safe) return;
  const current = mergeArchiveCache.get(ownerId) || [];
  const next = current.map((archive) => archive.archive_id === safe.archive_id ? safe : archive);
  mergeArchiveCache.set(ownerId, next);
}
async function restoreMergedArchive(ownerId, archiveId, button) {
  const key = mergeArchiveKey(ownerId, archiveId);
  if (mergeArchiveBusy.has(key) || ownerId !== uid) return;
  const archive = (mergeArchiveCache.get(ownerId) || []).find((x) => x.archive_id === archiveId);
  if (!archive) return;
  if (archive.state === "available" && !confirm("Restore this archived account as a separate copy? Your current account will not be changed. The copy brings back training records and settings, but reminders, sharing, partners, cheers, and challenges stay off.")) return;
  mergeArchiveBusy.add(key);
  if (button) { button.disabled = true; button.textContent = "Preparing separate copy…"; }
  mergeArchiveNotices.delete(key);
  let result;
  try { result = await api(`/api/merge-archives/${encodeURIComponent(archiveId)}/restore`, { method: "POST", body: JSON.stringify({}) }); }
  catch { result = null; }
  mergeArchiveBusy.delete(key);
  if (!result?.restored || typeof result.user_id !== "string" || !result.user_id) {
    mergeArchiveNotices.set(key, "Couldn't prepare the separate copy. Check your connection and try again — the current account is unchanged.");
    if (uid === ownerId && tab === "me") renderMe();
    return;
  }
  mergeArchiveRestores.set(key, { user_id: result.user_id, program_name: typeof result.program_name === "string" ? result.program_name : null, units: result.units });
  updateMergeArchiveSummary(ownerId, result.archive);
  // A dropped response is normal mobile behaviour. The restore route is
  // idempotent, so the button can safely ask again and returns the same copy.
  loadMergeArchives(ownerId, true);
  say("A separate recovered copy is ready. Your current account has not changed.");
  if (uid === ownerId && tab === "me") renderMe();
}
async function removePushBeforeAccountSwitch(ownerId) {
  // A device subscription is both an external capability and tied to the current
  // account. Delete the server record *first* (scoped by its owner + endpoint),
  // then remove the browser subscription. Any failure leaves the current identity
  // in place, so a retry cannot silently strand an active reminder on the old one.
  if (!ownerId || !pushSupported()) return;
  let registration, subscription;
  try {
    registration = await navigator.serviceWorker.ready;
    subscription = await registration.pushManager.getSubscription();
  } catch {
    throw new Error("push-inspection-failed");
  }
  if (!subscription) return;
  let server;
  try { server = await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ user_id: ownerId, endpoint: subscription.endpoint }) }); }
  catch { throw new Error("server-unsubscribe-failed"); }
  if (!server || server.error) throw new Error("server-unsubscribe-failed");
  try {
    await subscription.unsubscribe();
    // `unsubscribe()` may resolve false when another tab already did the work;
    // prove the capability is gone instead of treating its boolean as an error.
    if (await registration.pushManager.getSubscription()) throw new Error("browser-unsubscribe-failed");
  } catch {
    throw new Error("browser-unsubscribe-failed");
  }
}
function clearAccountLocalState() {
  // Keep the one deliberate device preference (RIR chips). Every other hb_* key
  // has account-specific meaning: identity, plan, queue, in-progress session,
  // reminder state, onboarding draft, units, and check-in state must not cross
  // into the recovered identity.
  clearSess();
  const keys = [];
  try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch {}
  for (const key of keys) {
    if (key?.startsWith("hb_") && key !== "hb_rir") {
      try { localStorage.removeItem(key); } catch {}
    }
  }
  onbStep = 0; onbStarted = false; answers = {}; settingsMode = false; settingsSolo = null;
  historyEdit = null; historyDateFix = null; resetLearnNav();
}
async function switchToRestoredArchive(ownerId, archiveId, button) {
  const key = mergeArchiveKey(ownerId, archiveId);
  const restored = mergeArchiveRestores.get(key);
  if (mergeArchiveBusy.has(key) || ownerId !== uid || !restored?.user_id) return;
  const queued = getQueue().length;
  const inProgress = sess?.logged?.length ?? 0;
  const unsynced = [];
  if (inProgress) unsynced.push("an in-progress workout");
  if (queued) unsynced.push("unsynced data waiting on this device");
  const warning = unsynced.length
    ? `Switch to the separate restored copy? This clears ${unsynced.join(" and ")} from this device; it is not part of the restored copy. Your current training data stays untouched, and this device's old reminder will be turned off first.`
    : "Switch to the separate restored copy on this device? Your current training data stays untouched. This device's reminder for the current account will be turned off first.";
  if (!confirm(warning)) return;
  mergeArchiveBusy.add(key);
  if (button) { button.disabled = true; button.textContent = "Turning off old reminders…"; }
  try { await removePushBeforeAccountSwitch(ownerId); }
  catch {
    mergeArchiveBusy.delete(key);
    mergeArchiveNotices.set(key, "Couldn't safely turn off the current account's device reminder, so you are still on the current account. Check your connection and try again.");
    if (uid === ownerId && tab === "me") renderMe();
    return;
  }
  mergeArchiveBusy.delete(key);
  clearAccountLocalState();
  uid = restored.user_id;
  try {
    localStorage.setItem("hb_user", uid);
    if (restored.program_name) localStorage.setItem("hb_program", restored.program_name);
    if (restored.units === "metric" || restored.units === "imperial") localStorage.setItem("hb_units", restored.units);
  } catch {}
  pendingNotice = "You're now viewing a separate restored copy. Your previous training data was left untouched; this device's old reminder was turned off, and reminders and social sharing are off in this copy.";
  tab = "today";
  render();
}

// Care & device settings (pause, email reminders, push reminders, install) —
// moved to Me in Wave 246: they are settings, and the Coach tab was carrying
// them as cards ~10 deep. One builder + one wiring, parameterized on the
// re-render so the announce-and-restore-focus pattern works wherever they live.
function careCards(a) {
  const paused = a.paused;
  return `<h2>Injury or illness?</h2>
    <div class="card"><p>${paused ? "You're paused — heal up. Your streak is safe and I won't nudge you." : "Pause any time. Nothing's ever at stake — never train through pain or sickness."}</p>
      <button class="btn ${paused ? "" : "secondary"}" id="pause">${paused ? "I'm ready — resume" : "Pause (I'm sick or injured)"}</button></div>
    <h2>Reminders</h2>
    ${localStorage.getItem("hb_email")
      ? `<div class="card"><p class="muted">${a.reminders_off ? "Email reminders are off. Your progress stays safely backed up either way." : "If you drift away, I'll email your account at most two gentle notes per break — never while you're paused."}</p>
      <button class="btn secondary" id="nudges">${a.reminders_off ? "Turn reminders on" : "Turn reminders off"}</button></div>`
      : `<div class="card"><p class="muted">Reminders arrive by email. Create your free account above (just an email — no password, ever) and if you drift away I'll send at most two gentle notes per break.</p>
      <button class="btn secondary inline" id="nudges-acct">Take me to the account box</button></div>`}
    ${pushSupported()
      ? `<div class="card"><p class="muted">${localStorage.getItem("hb_push") === "1" ? "Device reminders are on — a quiet nudge when a session's waiting, never while paused." : "Or get a reminder right on this device — no email needed. One gentle nudge when a session's waiting; stops while you're paused and after ~3 weeks."}</p>
      <button class="btn secondary" id="pushbtn">${localStorage.getItem("hb_push") === "1" ? "Turn device reminders off" : "Enable device reminders"}</button>
      <p class="muted" id="pushmsg"></p></div>`
      : isIOS() && !isStandalone()
        ? `<div class="card"><p class="muted">Want a reminder right on this iPhone? Add the app to your Home Screen first — tap the <b>Share</b> button (the square with an arrow pointing up) at the bottom of Safari, then <b>Add to Home Screen</b>. Open it from there and device reminders unlock.</p></div>`
        : ""}
    ${deferredInstallPrompt && !isStandalone()
      ? `<div class="card"><p class="muted">Put the app on your home screen — it opens full-screen in one tap, works offline, and makes it far easier to keep the habit.</p>
      <button class="btn secondary" id="installbtn">Install the app</button><p class="muted" id="installmsg"></p></div>`
      : ""}`;
}
function wireCareCards(a, rerender) {
  const paused = a.paused;
  // Toggles announce + restore focus: the re-render replaces the whole screen,
  // which destroys the tapped button (focus drops to body).
  if ($("#pause")) $("#pause").onclick = async () => {
    try {
      await api("/api/pause", { method: "POST", body: JSON.stringify({ user_id: uid, on: !paused }) });
      say(paused ? "Resumed. Welcome back." : "Paused — heal up. Your streak is safe.");
      await rerender(); $("#pause")?.focus();
    } catch { alertBar("📴 Couldn't update the pause — you're offline. Try again when connected."); }
  };
  const nudgeBtn = $("#nudges");
  if (nudgeBtn) nudgeBtn.onclick = async () => {
    try {
      await api("/api/reminders", { method: "POST", body: JSON.stringify({ user_id: uid, off: !a.reminders_off }) });
      say(a.reminders_off ? "Reminders turned on." : "Reminders turned off.");
      await rerender(); $("#nudges")?.focus();
    } catch { alertBar("📴 Couldn't update reminders — you're offline. Try again when connected."); }
  };
  const acctBtn = $("#nudges-acct");
  if (acctBtn) acctBtn.onclick = () => { $("#bemail")?.scrollIntoView({ behavior: "smooth", block: "center" }); $("#bemail")?.focus({ preventScroll: true }); };
  const installBtn = $("#installbtn");
  if (installBtn) installBtn.onclick = async () => {
    if (!deferredInstallPrompt) { $("#installmsg").textContent = "Your browser's menu has an “Install app” option."; return; }
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice.catch(() => ({ outcome: "dismissed" }));
    deferredInstallPrompt = null; // the event is single-use
    if (outcome === "accepted") { say("Installing the app."); rerender(); }
    else $("#installmsg").textContent = "No problem — you can install any time from here.";
  };
  const pushBtn = $("#pushbtn");
  if (pushBtn) pushBtn.onclick = async () => {
    const msg = (t) => { $("#pushmsg").textContent = t; };
    try {
      const reg = await navigator.serviceWorker.ready;
      if (localStorage.getItem("hb_push") === "1") {
        const sub = await reg.pushManager.getSubscription();
        if (sub) { await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint, user_id: uid }) }).catch(() => {}); await sub.unsubscribe(); }
        localStorage.removeItem("hb_push");
        say("Device reminders turned off."); await rerender(); $("#pushbtn")?.focus(); return;
      }
      const { key } = await api("/api/push/key");
      if (!key) { msg("Device reminders aren't available right now."); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { msg("No problem — you can enable notifications any time in your browser settings."); return; }
      // base64url -> Uint8Array for applicationServerKey
      const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
      const appKey = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
      // Minutes EAST of UTC (getTimezoneOffset is minutes BEHIND, so negate) — lets the
      // server nudge at ~5pm THIS device's local time instead of 16:00 UTC for everyone.
      const tz_offset_min = -new Date().getTimezoneOffset();
      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ user_id: uid, subscription: sub.toJSON(), tz_offset_min }) });
      localStorage.setItem("hb_push", "1");
      say("Device reminders on."); await rerender(); $("#pushbtn")?.focus();
    } catch { msg("📴 Couldn't set up device reminders — try again when you're online."); }
  };
}

// Fill Me's care slot (pause/reminders/install) from /api/adherence — the SLOT
// pattern, not a screen-level await: renderMe stays synchronous so the purely
// local toggles (units, RIR) repaint instantly and never look dead offline
// (the audit's finding: a gym-basement unit flip stalled several seconds, then
// the pause button the user was reaching for vanished). On failure the slot —
// and only the slot — degrades to the honest note. Me is an /api/adherence
// consumer, so the seen-once nudge banner renders here too — at the TOP.
async function fillMeCare() {
  const slot = $("#care-slot");
  if (!slot) return;
  let a = null; try { a = await api(`/api/adherence`); } catch {}
  if (!slot.isConnected) return; // the user navigated away mid-fetch
  if (!a) {
    slot.innerHTML = `<h2>Reminders &amp; pause</h2><div class="card"><p class="muted">📴 Pause and reminder settings need a connection — they'll appear here when you're back online.</p></div>`;
    return;
  }
  syncAccountEmail(a);
  if (a.nudged && $("#me-nudge")) $("#me-nudge").innerHTML = `<div class="card"><p>👋 A training partner nudged you — they noticed you've got a session waiting.</p></div>`;
  slot.innerHTML = careCards(a);
  // Re-renders from care actions refresh ONLY the slot: scroll survives and the
  // announce-and-restore-focus pattern finds its button (a whole-screen redraw
  // would resolve before the async slot refill and drop focus to body).
  wireCareCards(a, fillMeCare);
}

function renderMe() {
  const email = localStorage.getItem("hb_email");
  // This IS the account system — passwordless by design (an email-bound identity
  // with magic-link sign-in and cross-device restore). Present it as one.
  const backup = email
    ? `<div class="card"><p class="muted">Your account</p><b>${esc(email)}</b> <span class="chip">✓ signed in</span>
        <p class="muted" style="margin-top:8px">Your progress is saved to this account. On any other device, open the app, tap "Sign in on this device", and enter this email to pick up where you left off. No password — sign-in links come to your inbox.</p></div>`
    : `<div class="card"><p class="muted">Create your account</p>
        <p>One email — <b>no password, ever</b>. It keeps your progress safe if you lose this phone, and syncs it to any other device.</p>
        <input id="bemail" type="email" inputmode="email" autocomplete="email" aria-label="Email address for your account" placeholder="you@email.com"
          style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:8px 0 4px">
        <button class="btn" id="sendlink">Create my account</button>
        <p class="muted" id="bmsg"></p>
        <button class="btn ghost inline" id="me-restore-toggle">Used the app on another phone?</button>
        <div id="me-restore" class="hidden" style="margin-top:6px">
          <p class="muted">Enter the email you saved progress under and I'll send a sign-in link — this door was previously only reachable by resetting the app.</p>
          <input id="me-restore-email" type="email" inputmode="email" autocomplete="email" aria-label="Email you saved progress under" placeholder="you@email.com"
            style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:14px;font-size:1.05rem;margin:6px 0 4px">
          <button class="btn secondary inline" id="me-restore-send">Email me a sign-in link</button>
          <p class="muted" id="me-restore-msg"></p>
        </div></div>`;
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
  const recovery = mergeArchiveCard(uid);
  const care = `<div id="care-slot"><h2>Reminders &amp; pause</h2><div class="card"><p class="muted">Loading…</p></div></div>`;
  app.innerHTML = `<h1>Me</h1>
    <div id="me-nudge"></div>
    <div class="card"><p class="muted">Training settings</p>
      <p>Got stronger? New gym? More (or fewer) days free? Update your answers and I'll rebuild your plan around them.</p>
      <button class="btn secondary" id="settings">View &amp; change my answers</button></div>
    <div class="card"><p class="muted">After-set effort question (reps left in the tank)</p>
      <p>After each set, one optional tap: how many more reps you had in you. It's how the coach knows a weight has gotten too easy — skipping a set never counts against you.</p>
      <p class="muted">${localStorage.getItem("hb_rir") === "1" ? "Always on." : localStorage.getItem("hb_rir") === "0" ? "Off." : "Auto — the chips appear once you're past the beginner stage."}</p>
      <button class="btn secondary" id="rirtoggle">${localStorage.getItem("hb_rir") === "1" ? "Always on — tap to switch off" : localStorage.getItem("hb_rir") === "0" ? "Off — tap to switch to auto" : "Auto — tap to force always on"}</button></div>
    <div class="card"><p class="muted">Units</p>
      <p>Weights show in <b>${unitPref() === "lb" ? "pounds (lb)" : "kilograms (kg)"}</b>.</p>
      <button class="btn secondary" id="unittoggle">Switch to ${unitPref() === "lb" ? "kg" : "lb"}</button></div>
    ${backup}
    ${care}
    ${recovery}
    ${funded}
    <button class="btn ghost inline" id="healthnote-me">Health &amp; safety note</button>
    <button class="btn ghost inline" id="reset">Reset (start over)</button>`;
  fillMeCare();
  $("#healthnote-me").onclick = () => renderHealthNote(() => { tab = "me"; render(); });
  $("#settings").onclick = renderTrainingSettings;
  // Tri-state cycle: Auto (unset) → Always on ("1") → Off ("0") → Auto. The Auto
  // default keys off training status, so a graduating beginner inherits the chips
  // with nothing to configure (minimal-customization: no mandatory setting).
  $("#rirtoggle").onclick = () => { const v = localStorage.getItem("hb_rir"); if (v === "1") localStorage.setItem("hb_rir", "0"); else if (v === "0") localStorage.removeItem("hb_rir"); else localStorage.setItem("hb_rir", "1"); renderMe(); };
  $("#unittoggle").onclick = async () => {
    // Writes BOTH sides. This used to set localStorage only, so `profile.units`
    // drifted from what the user actually saw — harmless while the wizard also
    // asked, load-bearing the moment it stopped: a new device reads the server
    // value, and a stale one would show kg to someone who chose lb. Local first so
    // the UI is instant; the server patch is best-effort and self-heals next flip.
    const next = unitPref() === "lb" ? "metric" : "imperial";
    localStorage.setItem("hb_units", next);
    renderMe();
    // A narrow door, NOT /api/plan/regenerate. That route rebuilds the programme,
    // and its `u.program = program` is the one regeneration site with no
    // custom-plan guard — so routing a cosmetic unit flip through it silently
    // replaced a hand-edited plan with a generated one.
    try { await api("/api/profile/units", { method: "POST", body: JSON.stringify({ user_id: uid, units: next }) }); } catch {}
  };
  app.querySelectorAll("[data-restore-archive]").forEach((b) => b.onclick = () => restoreMergedArchive(uid, b.dataset.restoreArchive, b));
  app.querySelectorAll("[data-switch-restored]").forEach((b) => b.onclick = () => switchToRestoredArchive(uid, b.dataset.switchRestored, b));
  // Start this non-critical lookup after the normal Me controls are usable. Until
  // the API confirms an archive exists there is no recovery card at all.
  if (!mergeArchiveCache.has(uid) && !mergeArchiveLoads.has(uid)) loadMergeArchives(uid);

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
    // Sign in from another phone's saved progress — WITHOUT user_id, which is the
    // welcome-screen restore semantics: sending this device's id would CLAIM the
    // address onto this anonymous user instead of fetching the saved account.
    if ($("#me-restore-toggle")) $("#me-restore-toggle").onclick = () => $("#me-restore").classList.toggle("hidden");
    if ($("#me-restore-send")) $("#me-restore-send").onclick = async () => {
      const val = $("#me-restore-email").value.trim();
      if (!val) { $("#me-restore-msg").textContent = "Enter the email first."; return; }
      $("#me-restore-msg").textContent = "Sending…";
      let r; try { r = await api("/api/auth/request", { method: "POST", body: JSON.stringify({ email: val }) }); }
      catch { $("#me-restore-msg").textContent = "📴 You're offline — try again when you have signal."; return; }
      if (r.error === "invalid-email") { $("#me-restore-msg").textContent = "That doesn't look like an email."; return; }
      // A real send that FAILED must never read as "check your inbox" — this is
      // the account-recovery door, and the hedged success copy would steer the
      // user to conclude their account doesn't exist (the sibling send buttons
      // both carry this guard; omitting it here was the audit's finding).
      if (r.sent === false) { $("#me-restore-msg").textContent = "Couldn't send right now — try again in a moment."; return; }
      $("#me-restore-msg").innerHTML = "If that address has progress saved, a sign-in link is on its way — it works once and expires in 30 minutes."
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
  // DTSTART was hardcoded to 2026-01-05. Most clients still recur it forward, but
  // the first event lands in the past, which is not what anyone means by "add my
  // training to my calendar" — and in a client that shows the series start, the
  // user's brand-new plan appears to have begun months ago. Anchor on the NEXT
  // occurrence instead: today if it is one of the chosen days and the time has not
  // passed, otherwise the soonest chosen day after that.
  const now = new Date();
  const start = new Date(now);
  start.setHours(Number(hh), Number(mm), 0, 0);
  const wanted = new Set(days);
  const dowMon0 = (d) => (d.getDay() + 6) % 7;   // JS Sunday=0 → Monday=0, matching ICS_DAYS
  for (let i = 0; i < 8; i++) {
    if (wanted.has(dowMon0(start)) && start > now) break;
    start.setDate(start.getDate() + 1);
  }
  const two = (n) => String(n).padStart(2, "0");
  const dtstart = `${start.getFullYear()}${two(start.getMonth() + 1)}${two(start.getDate())}T${two(start.getHours())}${two(start.getMinutes())}00`;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hypertrophy Bible//EN", "BEGIN:VEVENT",
    "SUMMARY:🏋️ Training", `DTSTART:${dtstart}`, "DURATION:PT1H",
    `RRULE:FREQ=WEEKLY;BYDAY=${byday}`, "DESCRIPTION:Your scheduled training session — showing up is the win.", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const a = document.createElement("a"); a.href = url; a.download = "hypertrophy-training.ics"; a.click(); URL.revokeObjectURL(url);
}
// ---------- Your story (streak, milestones, partners, challenges) ----------
// Formerly the Coach tab, dissolved in Wave 247: it carried no coaching. Renders
// into Progress's #story box; its own re-renders refresh ONLY the box, which is
// cheaper than redrawing all of Progress and preserves scroll/focus.
async function renderStory() {
  const box = $("#story");
  if (!box) return; // Progress re-rendered underneath us
  box.innerHTML = `<p class="muted">Loading…</p>`;
  let a; try { a = await api(`/api/adherence`); } catch {
    box.innerHTML = `<h2>Your story</h2><div class="card"><p>📴 You're offline.</p><p class="muted">Your streak and XP are safe — they'll show as soon as you reconnect.</p>
      <button class="btn" id="retry-coach">Try again</button></div>`;
    $("#retry-coach").onclick = () => renderStory();
    return;
  }
  if (!box.isConnected) return; // Progress re-rendered underneath us mid-fetch
  syncAccountEmail(a);
  // The nudge banner paints at the TOP of Progress, not inside the story box —
  // the box is the last element of the app's longest screen, and a seen-once
  // flag consumed by this fetch but painted six screens below the fold is a
  // flag EATEN, not shown (the audit's finding; the whole reason every
  // /api/adherence consumer must render it is that the fetch spends it).
  if (a.nudged && $("#progress-nudge")) $("#progress-nudge").innerHTML = `<div class="card"><p>👋 A training partner nudged you — they noticed you've got a session waiting.</p></div>`;
  let fw = { partners: [] }; try { fw = await api(`/api/following`); } catch {}
  let cw = { challenges: [] }; try { cw = await api(`/api/challenge`); } catch {}
  // Multi-challenge (Wave 199): `challenges` is a LIST — each slot carries its own
  // per-slot counts/week_over. The ⚔️ button gates per PARTNER PAIR (you can run
  // several races at once, one per partner) plus the server's open-slot cap.
  const chList = cw.challenges ?? (cw.challenge ? [cw.challenge] : []);
  const openCh = chList.filter((x) => x.status === "pending" || x.status === "active");
  const busyTokens = new Set(openCh.map((x) => x.partner_token));
  const canChallengeToken = (token) => !busyTokens.has(token) && openCh.length < 3;
  const m = a.milestones || {};
  const badges = (m.reached || []).map((x) => `<span class="chip">✓ ${x.at}</span>`).join(" ");
  box.innerHTML = `<h2>Your story</h2>
    <div class="card center">
      <div class="big">${a.sessions_logged === 0 ? "🌱 Your streak starts with your first session" : `🔥 ${a.streak_weeks} week${a.streak_weeks === 1 ? "" : "s"} strong`}</div>
      <div class="bar" style="margin:12px 0"><i style="width:${a.level_progress_pct}%;background:var(--accent)"></i></div>
      ${a.sessions_logged === 0 ? "" : `<p class="muted">Level ${a.level} · ${a.xp} XP · ${a.xp_to_next} to level ${a.level + 1}</p>
      <p class="muted">${a.sessions_logged} sessions logged · ${a.week.sessions} this week</p>`}
      ${a.share_cheers > 0 ? `<p style="color:var(--accent);font-weight:600;margin-top:6px">💪 ${a.share_cheers} ${a.share_cheers === 1 ? "person has" : "people have"} cheered you on</p>` : ""}</div>
    ${m.latest ? `<div class="card"><b>🏅 ${esc(m.latest.msg)}</b>${m.next ? `<p class="muted" style="margin-top:8px">Next up: ${esc(m.next.msg)}</p>` : ""}</div>` : ""}
    ${badges ? `<div class="card"><p class="muted">Milestones reached</p>${badges}</div>` : ""}
    ${a.streak_freeze && a.streak_freeze.balance > 0 ? `<div class="card"><b>🛡️ ${a.streak_freeze.balance} streak freeze${a.streak_freeze.balance === 1 ? "" : "s"}</b>
      ${a.streak_freeze.protectable_week
        ? `<p class="muted" style="margin-top:8px">You've got a missed week you can still protect. Spend one freeze to keep your streak alive — no shame either way.</p><button class="btn secondary" id="freeze">Protect my streak 🛡️</button>`
        : `<p class="muted" style="margin-top:8px">Banked and ready — miss a week and one of these quietly keeps your streak going. You earn more just by training consistently.</p>`}</div>` : ""}
    ${a.sessions_logged > 0 ? `<div class="card"><b>📣 Share your progress</b>
      <p class="muted" style="margin-top:8px">Post a read-only card of your streak, level and session count — a simple accountability nudge. No personal details are shared, and you can turn it off anytime.</p>
      <button class="btn secondary" id="sharebtn">Get my share link</button>
      <div id="sharebox" class="hidden" style="margin-top:10px"></div></div>` : ""}
    <div class="card"><b>🤝 Training partners</b>
      <p class="muted" style="margin-top:8px">Follow a friend's share link and their streak shows up here — a little mutual accountability. Paste the link they sent you:</p>
      <div class="row" style="gap:8px;margin-top:4px"><input id="followurl" placeholder="Paste a share link…" style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:10px;font-size:.9rem"><button class="btn secondary inline" id="followbtn" style="margin:0">Follow</button></div>
      <p class="muted" id="followmsg" style="margin-top:6px"></p>
      ${(fw.partners || []).some((p) => p.active) ? `<div style="margin-top:10px">${rankPartners({ streak_weeks: a.streak_weeks, level: a.level }, fw.partners).map((r) => {
        const race = r.isYou ? null : weeklyRaceStatus(a.week.sessions, r.sessions_this_week);
        const raceLabel = race === "ahead" ? "🏁 you're ahead this week" : race === "behind" ? "🏁 they're ahead this week" : race === "tied" ? "🏁 tied this week" : "";
        return `<div class="row" style="align-items:center;padding:5px 0${r.isYou ? ";color:var(--accent);font-weight:600" : ""}"><span style="width:26px">#${r.rank}</span><span style="flex:1">${r.isYou ? "You" : "A partner"}${!r.isYou && r.mutual ? " ✓" : ""} · 🔥 ${r.streak_weeks} wk${r.streak_weeks === 1 ? "" : "s"} · lvl ${r.level}${!r.isYou && r.cheers > 0 ? ` · 💪 ${r.cheers}` : ""}${raceLabel ? ` · ${raceLabel}` : ""}</span>${r.isYou ? "" : `${r.mutual && canChallengeToken(r.token) ? `<button class="linkbtn challenge-send" data-token="${esc(r.token)}" style="background:none;border:none;color:var(--accent);cursor:pointer;margin-right:6px">⚔️ challenge</button>` : ""}${r.mutual ? `<button class="linkbtn nudge" data-token="${esc(r.token)}" style="background:none;border:none;color:var(--accent);cursor:pointer;margin-right:6px">👋 nudge</button>` : ""}<button class="linkbtn unfollow" data-token="${esc(r.token)}" style="background:none;border:none;color:var(--muted);cursor:pointer">remove</button>`}</div>`;
      }).join("")}</div>` : ""}
      ${(fw.partners || []).filter((p) => !p.active).map((p) =>
        `<div class="row" style="margin-top:8px;align-items:center"><span class="muted" style="flex:1">A partner stopped sharing.</span><button class="linkbtn unfollow" data-token="${esc(p.token)}" style="background:none;border:none;color:var(--muted);cursor:pointer">remove</button></div>`).join("")}</div>
    ${chList.map((x) => {
      // One card per slot, every state renderable at once — the four mutually
      // exclusive cards were the single-slot world's UI; the API now produces a
      // list, so the renderer carries a list (lesson 15, asked forward).
      if (x.status === "pending" && x.role === "opponent") return `<div class="card"><b>⚔️ A training partner challenged you</b>
      <p class="muted" style="margin-top:8px">Most sessions logged by the end of this week wins. Are you in?</p>
      <div class="row" style="gap:8px;margin-top:8px"><button class="btn inline challenge-accept" data-chid="${esc(x.id)}" style="margin:0">Accept</button><button class="btn secondary inline challenge-decline" data-chid="${esc(x.id)}" style="margin:0">Decline</button></div></div>`;
      if (x.status === "pending" && x.role === "challenger") return `<div class="card"><b>⚔️ Challenge sent</b><p class="muted" style="margin-top:8px">Waiting for them to accept — most sessions logged this week wins.</p></div>`;
      if (x.status === "active") {
        const race = weeklyRaceStatus(x.my_count, x.opponent_count);
        const label = race === "ahead" ? "🏆 you're ahead" : race === "behind" ? "😤 you're behind" : "🤝 tied";
        return `<div class="card"><b>⚔️ Challenge in progress</b><p class="muted" style="margin-top:8px">You ${x.my_count} – ${x.opponent_count} them · ${label} · decides at week's end</p></div>`;
      }
      if (x.status === "completed" && x.opponent_active !== false) {
        const result = x.my_count > x.opponent_count ? "🏆 You won" : x.my_count < x.opponent_count ? "😤 You lost" : "🤝 It was a tie";
        return `<div class="card"><b>⚔️ Challenge result</b><p class="muted" style="margin-top:8px">${result} ${x.my_count}–${x.opponent_count}. Send a new challenge any time.</p></div>`;
      }
      return "";
    }).join("")}
    ${(cw.history || []).length > 0 ? (() => {
        // A persisted win/lose/tie record across every challenge that's ever run its
        // course — separate from the single-slot `challenge` card above, which only
        // ever shows the CURRENT one and is overwritten the moment a new one starts.
        const wins = cw.history.filter((h) => h.result === "win").length;
        const losses = cw.history.filter((h) => h.result === "lose").length;
        const ties = cw.history.length - wins - losses;
        // The full per-challenge list beneath the tally (the roadmap's "history LIST
        // view" follow-on) — `/api/challenge` already returned every past result
        // (newest first, capped at 20), just never rendered individually before now.
        const rows = cw.history.map((h) => {
          const icon = h.result === "win" ? "🏆" : h.result === "lose" ? "😤" : "🤝";
          const label = h.result === "win" ? "Won" : h.result === "lose" ? "Lost" : "Tied";
          return `<div class="row" style="padding:4px 0;justify-content:space-between"><span class="muted">${icon} ${label} · ${esc(formatWeekLabel(h.week))}</span><span class="muted">${h.my_count}–${h.opponent_count}</span></div>`;
        }).join("");
        return `<div class="card"><b>📊 Head-to-head record</b><p class="muted" style="margin-top:8px">${wins}W – ${losses}L${ties ? ` – ${ties}T` : ""} across ${cw.history.length} challenge${cw.history.length === 1 ? "" : "s"}</p><div style="margin-top:8px">${rows}</div></div>`;
      })()
      : ""}`;
  const freezeBtn = $("#freeze");
  if (freezeBtn) freezeBtn.onclick = async () => {
    try {
      const r = await api("/api/streak/freeze", { method: "POST", body: JSON.stringify({ user_id: uid }) });
      if (r.error) { alertBar(socialErrorMessage(r.error)); await renderStory(); return; }
      say(`Streak protected — still ${r.streak_weeks} week${r.streak_weeks === 1 ? "" : "s"} strong.`);
      await renderStory(); $("#freeze")?.focus();
    } catch { alertBar("📴 Couldn't apply the freeze right now. Try again in a moment."); }
  };
  const shareBtn = $("#sharebtn");
  if (shareBtn) shareBtn.onclick = async () => {
    try {
      const r = await api("/api/share", { method: "POST", body: JSON.stringify({ user_id: uid }) });
      const url = `${location.origin}/share?s=${r.share_id}`; // clean URL (assets binding serves share.html here, no redirect)
      const box = $("#sharebox");
      box.classList.remove("hidden");
      // Build the row structurally and set the URL via .value (a property, never
      // interpolated into HTML) so there is no injection surface.
      box.innerHTML = `<div class="row" style="gap:8px"><input id="shareurl" readonly style="flex:1;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:10px;font-size:.9rem"><button class="btn secondary inline" id="sharecopy" style="margin:0">Copy</button></div>${r.new_cheers > 0 ? `<p style="margin-top:8px;color:var(--accent);font-weight:600">🎉 ${r.new_cheers} new cheer${r.new_cheers === 1 ? "" : "s"} since you last looked!</p>` : ""}${r.cheers > 0 ? `<p class="muted" style="margin-top:8px">💪 ${r.cheers} ${r.cheers === 1 ? "person has" : "people have"} cheered you on.</p>` : ""}<button class="btn" id="sharerevoke" style="margin-top:8px">Turn sharing off</button>`;
      $("#shareurl").value = url;
      $("#sharecopy").onclick = () => { try { navigator.clipboard?.writeText(url); } catch {} $("#shareurl").select(); say("Link copied."); };
      $("#sharerevoke").onclick = async () => {
        try { await api("/api/share/revoke", { method: "POST", body: JSON.stringify({ user_id: uid }) }); box.classList.add("hidden"); box.innerHTML = ""; say("Sharing turned off. The old link no longer works."); }
        catch { alertBar("📴 Couldn't turn sharing off right now."); }
      };
      say("Your share link is ready.");
    } catch { alertBar("📴 Couldn't create a share link right now. Try again in a moment."); }
  };
  const followBtn = $("#followbtn");
  if (followBtn) followBtn.onclick = async () => {
    const raw = ($("#followurl")?.value || "").trim();
    if (!raw) { $("#followmsg").textContent = "Paste your friend's share link first."; return; }
    let token = raw;
    try { token = new URL(raw).searchParams.get("s") || raw; } catch {} // accept a full share URL or a bare token
    try {
      const r = await api("/api/following", { method: "POST", body: JSON.stringify({ user_id: uid, token }) });
      if (r.error) { $("#followmsg").textContent = socialErrorMessage(r.error); return; }
      say("Training partner added.");
      await renderStory();
    } catch { $("#followmsg").textContent = "That link isn't an active share — ask your friend for a fresh one."; }
  };
  app.querySelectorAll(".unfollow").forEach((b) => b.onclick = async () => {
    try {
      const r = await api("/api/following/remove", { method: "POST", body: JSON.stringify({ user_id: uid, token: b.dataset.token }) });
      if (r.error) { alertBar(socialErrorMessage(r.error)); return; }
      await renderStory();
    } catch { alertBar("📴 Couldn't update — try again when connected."); }
  });
  app.querySelectorAll(".nudge").forEach((b) => b.onclick = async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      const r = await api("/api/following/nudge", { method: "POST", body: JSON.stringify({ user_id: uid, token: b.dataset.token }) });
      if (r.error) { b.disabled = false; alertBar(socialErrorMessage(r.error)); return; }
      b.textContent = "👋 nudged"; say("Nudge sent.");
    }
    catch { b.disabled = false; alertBar("📴 Couldn't send that nudge — try again when connected."); }
  });
  app.querySelectorAll(".challenge-send").forEach((b) => b.onclick = async () => {
    if (b.disabled) return;
    b.disabled = true;
    try {
      const r = await api("/api/challenge", { method: "POST", body: JSON.stringify({ user_id: uid, token: b.dataset.token }) });
      if (r.error) { b.disabled = false; alertBar(socialErrorMessage(r.error)); return; }
      say("Challenge sent."); await renderStory();
    }
    catch { b.disabled = false; alertBar("📴 Couldn't send that challenge — try again when connected."); }
  });
  // Respond handlers carry the slot id from their own card — several invite cards
  // can render at once, and each answer must name exactly the invite it came from.
  app.querySelectorAll(".challenge-accept").forEach((btn) => btn.onclick = async () => {
    try {
      const r = await api("/api/challenge/respond", { method: "POST", body: JSON.stringify({ user_id: uid, challenge_id: btn.dataset.chid, accept: true }) });
      if (r.error) { alertBar(socialErrorMessage(r.error)); await renderStory(); return; }
      say("Challenge accepted — good luck."); await renderStory();
    }
    catch { alertBar("📴 Couldn't accept — try again when connected."); }
  });
  app.querySelectorAll(".challenge-decline").forEach((btn) => btn.onclick = async () => {
    try {
      const r = await api("/api/challenge/respond", { method: "POST", body: JSON.stringify({ user_id: uid, challenge_id: btn.dataset.chid, accept: false }) });
      if (r.error) { alertBar(socialErrorMessage(r.error)); await renderStory(); return; }
      say("Challenge declined."); await renderStory();
    }
    catch { alertBar("📴 Couldn't update — try again when connected."); }
  });
}

// ---------- Learn (the beginner on-ramp library, bundled + offline) ----------
async function renderLearn() {
  resetLearnNav();
  app.innerHTML = `<h1>Learn</h1><p class="muted">Loading…</p>`;
  let LEARN_INDEX;
  try { ({ LEARN_INDEX } = await learnData()); }
  catch { app.innerHTML = `<h1>Learn</h1><div class="card"><p>📴 Couldn't load the guides.</p><p class="muted">Connect once and they'll be saved on this device for good.</p></div>`; return; }
  // One divider where the beginner on-ramp ends and the full evidence base begins
  // (inside catsFor, since filtering can remove the category that used to carry it).
  // The 93-row index gets a filter. Only the category container re-renders on
  // input (the input itself is never replaced, so focus survives every keystroke).
  const catsFor = (q) => {
    const needle = String(q ?? "").trim().toLowerCase();
    let deeper = false;
    return LEARN_INDEX.map((c) => {
      const items = needle
        ? c.items.filter((it) => `${it.title} ${it.desc ?? ""} ${c.category}`.toLowerCase().includes(needle))
        : c.items;
      if (!items.length) return "";
      const divider = c.tier === "deeper" && !deeper
        ? (deeper = true, `<div class="card tldr" style="margin-top:26px"><b>🔬 Go deeper — the science library</b>
            <p class="muted" style="margin:6px 0 0">The full evidence base behind your plan: every claim graded A–D by strength of evidence. Read what interests you — none of it is required to train well.</p></div>`)
        : "";
      return `${divider}<h2>${esc(c.category)}</h2><div class="card">${
        items.map((it) => `<button class="choice" data-learn="${esc(it.slug)}"><span style="flex:1"><b>${esc(it.title)}</b>${it.desc ? `<br><span class="muted">${esc(it.desc)}</span>` : ""}</span><span>›</span></button>`).join("")
      }</div>`;
    }).join("") || `<p class="muted" style="margin-top:14px">Nothing matches — try a plainer word ("protein", "sore", "sets").</p>`;
  };
  app.innerHTML = `<h1>Learn</h1>
    <p class="muted">Never been to a gym? Start at the top and read a couple. Every term, every worry, answered plainly — and it all works offline.</p>
    <input id="learn-filter" type="search" placeholder="Search the guides…" aria-label="Search the guides"
      style="width:100%;background:var(--card2);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px;font-size:1.05rem;margin:0 0 4px">
    <div id="learn-cats">${catsFor("")}</div>`;
  $("#learn-filter").oninput = () => { $("#learn-cats").innerHTML = catsFor($("#learn-filter").value); wireLearnLinks(); };
  wireLearnLinks();
  window.scrollTo(0, 0);
}
// A muscle guide's ranked pick list is the KB's densest, most actionable prose —
// and in the app it used to be plain text, because the renderer only made `.md`
// links tappable. Tapping a lift now opens the SAME sheet the player shows
// mid-workout: demo, cues, common errors, what it works.
//
// The data rides the already-precached learn-data bundle rather than the API, so
// the sheet works exactly as well offline as the page that linked to it — which is
// the promise the Learn tab already makes on screen, and the reader most likely to
// tap a lift is standing in a gym.
// One entry point for every data sheet a Learn page can open. The data rides the
// already-precached learn-data bundle rather than the API, so a sheet works exactly
// as well offline as the page that linked to it — which is what the Learn tab
// already promises on screen, to the reader most likely to be standing in a gym.
async function renderLearnData({ kind, id }) {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let LEARN_EXERCISES, LEARN_SUPPLEMENTS, LEARN_MUSCLES, LEARN_PAGES;
  try { ({ LEARN_EXERCISES, LEARN_SUPPLEMENTS, LEARN_MUSCLES, LEARN_PAGES } = await learnData()); }
  catch { app.innerHTML = `<div class="card"><p>📴 Couldn't load that.</p><p class="muted">Connect once and it'll be saved on this device.</p></div>`; return; }
  const sheets = { exercise: LEARN_EXERCISES, supplement: LEARN_SUPPLEMENTS, muscle: LEARN_MUSCLES };
  const d = sheets[kind]?.[id];
  // A page can only emit a button whose sheet was bundled (the generator throws
  // otherwise), so this is belt-and-braces: fall back to the page rather than
  // leaving a blank screen if an old cached bundle meets a new page.
  if (!d) { learnExercise = null; return renderLearnPage(learnSlug); }
  const from = LEARN_PAGES?.[learnSlug];
  const back = { label: `‹ Back to ${from?.title ?? "the guide"}`, onClick: () => { learnExercise = null; renderLearnPage(learnSlug); } };
  if (kind === "exercise") renderExerciseSheet({ exercise: id, name: d.name, movement_pattern: d.movement_pattern }, d, back);
  else if (kind === "supplement") renderSupplementSheet(d, back);
  else renderMuscleSheet(d, back);
  wireLearnLinks();
  window.scrollTo(0, 0);
}
const openLearnData = (kind, id) => { learnExercise = { kind, id }; renderLearnData({ kind, id }); };

// Evidence tier first, because it is the only thing most readers need: the KB's
// whole position on supplements is that a handful work and the rest are noise.
const SUPP_TIER = {
  strong: ["✅", "Worth taking", "Real, repeatable effects in good trials."],
  modest: ["🤏", "Small effect", "Works, but the effect is small — food and training matter far more."],
  situational: ["🎯", "Situational", "Useful for a specific job, not as a daily default."],
  insufficient: ["🤔", "Not yet proven", "Promising or popular, but the evidence isn't there yet."],
  ineffective: ["❌", "Skip it", "Tested and it doesn't do what it's sold for."],
};
function renderSupplementSheet(d, back) {
  const [icon, label, gloss] = SUPP_TIER[d.tier] ?? ["•", d.tier ?? "", ""];
  const row = (title, val) => (val ? `<h2>${title}</h2><p class="muted">${esc(val)}</p>` : "");
  app.innerHTML = `<h1>${esc(d.name)}</h1>
    <div class="card"><b>${icon} ${esc(label)}</b>${d.evidence_grade ? ` <span class="gradetag">Grade ${esc(d.evidence_grade)}</span>` : ""}
      ${gloss ? `<p class="muted" style="margin:6px 0 0">${esc(gloss)}</p>` : ""}
      ${d.summary ? `<p style="margin:8px 0 0">${esc(d.summary)}</p>` : ""}</div>
    ${row("What it does", d.effect)}
    ${row("Dose", d.dosing)}
    ${row("When", d.timing)}
    ${d.safety ? `<h2>Safety</h2><div class="card info"><p class="muted">⚠️ ${esc(d.safety)}</p></div>` : ""}
    <button class="btn" id="back">${esc(back.label)}</button>`;
  $("#back").onclick = back.onClick;
}

// The landmarks are the numbers the plan engine actually runs on, so showing them
// is the most direct answer the app can give to "why this much work for this muscle".
function renderMuscleSheet(d, back) {
  const lm = d.landmarks;
  const band = (k, title, why) => {
    const v = lm?.[k];
    if (!v) return "";
    const range = v.min === v.max ? `${v.min}` : `${v.min}–${v.max}`;
    return `<div class="win"><b>${title}: ${range} sets/week</b><br><span class="muted">${why}</span></div>`;
  };
  const list = (title, arr) => (arr?.length ? `<h2>${title}</h2><p class="muted">${esc(arr.join(" · "))}</p>` : "");
  app.innerHTML = `<h1>${esc(d.name)}</h1>
    ${d.group ? `<p class="muted">Part of your ${esc(d.group)} work</p>` : ""}
    ${lm ? `<h2>Weekly volume ${helpDot("volume", "ⓘ what these mean")}</h2><div class="card">
      ${band("mv", "Maintenance", "enough to hold what you have")}
      ${band("mev", "Minimum to grow", "below this, little happens")}
      ${band("mav", "Most growth", "where the plan aims")}
      ${band("mrv", "Recoverable ceiling", "past this you stop recovering")}
      <p class="muted" style="margin:8px 0 0;font-size:.85rem">Model-based estimates, not measured constants — your own response moves them.</p></div>` : ""}
    ${list("Regions", d.regions)}
    ${list("What it does", d.functions)}
    ${list("Opposing muscles", d.antagonists)}
    ${d.frequency_notes ? `<h2>How often</h2><p class="muted">${esc(d.frequency_notes)}</p>` : ""}
    ${d.training_notes ? `<h2>Training it</h2><p class="muted">${esc(d.training_notes)}</p>` : ""}
    <button class="btn" id="back">${esc(back.label)}</button>`;
  $("#back").onclick = back.onClick;
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
  // The page's place in the knowledge network: its ranked direct connections, plus
  // "also connected" pages that share evidence/neighbours without a direct link yet.
  // Every row states WHY it's related — real links and shared studies, never a score.
  const connRow = ([s, why]) => {
    const t = LEARN_PAGES[s];
    return t ? `<button class="choice" data-learn="${esc(s)}"><span style="flex:1"><b>${esc(t.title)}</b><br><span class="muted">${esc(why)}</span></span><span>›</span></button>` : "";
  };
  const connected = (pg.connected || []).map(connRow).join("");
  const suggested = (pg.suggested || []).map(connRow).join("");
  const connCard = connected || suggested
    ? `<h2>Connected</h2><div class="card">${connected}${suggested ? `<p class="muted" style="margin:10px 2px 6px">Also connected — no direct link yet:</p>${suggested}` : ""}</div>`
    : "";
  const backLabel = learnStack.length ? "‹ Back" : "‹ All topics";
  const backLabel2 = learnStack.length ? "‹ Back" : "‹ Back to all topics";
  app.innerHTML = `${workoutBack}<button class="btn ghost" id="learnback">${backLabel}</button>
    <h1>${esc(pg.title)}</h1>
    ${pg.tldr ? `<div class="card tldr"><b>In short</b> ${pg.tldr}</div>` : ""}
    <div class="learn">${pg.html}</div>
    ${connCard}
    ${workoutBack ? `<button class="btn" id="backToWorkout2">◀ Back to workout</button>` : ""}
    <button class="btn ghost" id="learnback2">${backLabel2}</button>`;
  const backToPlayer = () => { tab = "today"; resetLearnNav(); nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab)); renderPlayer(0); };
  if ($("#backToWorkout")) $("#backToWorkout").onclick = backToPlayer;
  if ($("#backToWorkout2")) $("#backToWorkout2").onclick = backToPlayer;
  // ‹ Back walks the traversal trail one page at a time (without re-pushing);
  // with no trail left it returns to the topic list.
  const goBack = () => {
    if (learnStack.length) { learnSlug = learnStack.pop(); renderLearnPage(learnSlug); }
    else renderLearn();
  };
  $("#learnback").onclick = goBack;
  $("#learnback2").onclick = goBack;
  wireLearnLinks(); // in-page cross-links between pages + the Connected card
  window.scrollTo(0, 0);
}

// ---------- Router ----------
function render() {
  stopRestTimer(); // leaving the player must always cancel the pending repaint
  settingsMode = false; settingsSolo = null; // navigating away abandons an in-progress settings edit cleanly
  if (tab !== "history") { historyEdit = null; historyDateFix = null; } // ...and an in-progress workout correction/date repair
  quitPending = false;
  discardPending = false; // an armed Discard must not survive a trip to another tab
  if (!uid) return renderOnboarding();
  nav.hidden = false;
  nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "today") renderToday();
  else if (tab === "history") { nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "progress")); renderHistory(); }
  else if (tab === "progress") renderProgress();
  else if (tab === "fuel") renderFuel();
  else if (tab === "plan") renderPlan();
  else if (tab === "learn") { learnExercise ? renderLearnData(learnExercise) : learnSlug ? renderLearnPage(learnSlug) : renderLearn(); }
  else renderMe();
}
nav.querySelectorAll("button").forEach((b) => b.onclick = () => { tab = b.dataset.tab; if (tab === "learn") resetLearnNav(); render(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
flushQueue(); // push any workouts logged offline last time
if (uid) tryPendingFollow(); // an already-signed-up user who opened a friend's share link
render();
