// Pure UI helpers — no DOM, no fetch, no Date.now. Split out of app.js so the
// Wave-244 path shorteners get real red-first unit tests (app.js itself touches
// the DOM at top level and cannot be imported under Node). Anything here is
// deterministic on its inputs. This file is precached: it appears in sw.js's
// SHELL list, and adding an import here means updating that list too.

// The Monday (YYYY-MM-DD) of the ISO week containing the given local calendar
// day. Pure string/UTC-noon arithmetic — no timezone reads, no clock.
export function mondayOf(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d, 12); // noon dodges any DST edge in the UTC frame
  const mon0 = (new Date(t).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const mDate = new Date(t - mon0 * 86400000);
  const two = (n) => String(n).padStart(2, "0");
  return `${mDate.getUTCFullYear()}-${two(mDate.getUTCMonth() + 1)}-${two(mDate.getUTCDate())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function weekLabelOf(mondayYmd) {
  const [y, m, d] = String(mondayYmd).split("-").map(Number);
  return `Week of ${d} ${MONTHS[m - 1] ?? "?"} ${y}`;
}

// Group a session list by calendar week, PRESERVING the given order (History is
// already newest-first with quarantined rows pinned on top). `calendarOf(sess)`
// returns "YYYY-MM-DD" or null; null-calendar rows (unparseable dates — the ones
// carrying the date-repair card) form their own leading group so the repair
// affordance can never sink below the fold of a week it doesn't belong to.
export function groupSessionsByWeek(list, calendarOf) {
  const groups = [], byKey = new Map();
  for (const s of list ?? []) {
    const cal = calendarOf(s);
    const key = cal ? mondayOf(cal) : null;
    if (!byKey.has(key)) { const g = { week: key, sessions: [] }; byKey.set(key, g); groups.push(g); }
    byKey.get(key).sessions.push(s);
  }
  return groups;
}

// The calendar-export day picker must never open EMPTY (design law: every empty
// state pre-filled): seed from this week's commitment when one exists, else the
// last selection this device downloaded with. Returns Monday-0 indices; hostile
// stored values (out of range, non-numeric) are dropped, never thrown on.
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export function seedCalendarDays(commitmentDays, storedDays) {
  if (Array.isArray(commitmentDays) && commitmentDays.length) {
    return commitmentDays.map((k) => DAY_KEYS.indexOf(k)).filter((i) => i >= 0);
  }
  if (Array.isArray(storedDays)) {
    return storedDays.filter((i) => Number.isInteger(i) && i >= 0 && i <= 6);
  }
  return [];
}

// Case-insensitive substring filter over the fields a lifter actually thinks in:
// the exercise's name, its primary muscles, its equipment.
export function filterExercises(list, q) {
  const needle = String(q ?? "").trim().toLowerCase();
  if (!needle) return list ?? [];
  return (list ?? []).filter((e) =>
    String(e.name ?? "").toLowerCase().includes(needle)
    || (e.primary_muscles ?? []).join(" ").toLowerCase().includes(needle)
    || String(e.equipment ?? "").toLowerCase().includes(needle));
}

// Chart geometry for the app's single-series trend lines (dataviz method:
// change-over-time → a line; ONE series → one hue, no legend — the card title
// names it; the editable list beside the chart is the table view). Pure math:
// values in, padded SVG point pairs out. Higher value = smaller y (SVG frame);
// a flat or single-point series draws at the midline instead of dividing by 0.
export function linePath(values, w, h, pad = 4) {
  const vals = (values ?? []).filter((v) => Number.isFinite(v));
  if (!vals.length) return { pts: [], min: null, max: null };
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min;
  const x = (i) => vals.length === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (vals.length - 1);
  const y = (v) => span === 0 ? h / 2 : (h - pad) - ((v - min) * (h - 2 * pad)) / span;
  return { pts: vals.map((v, i) => [Math.round(x(i) * 10) / 10, Math.round(y(v) * 10) / 10]), min, max };
}

// The "how do I do both sides?" cue for a unilateral lift, written to match how
// the player BANKS it: one ✓ = one set = both sides. The old copy said "do all N
// sets with your left, then repeat with your right" — impossible for a lift that
// alternates by design (the owner's walking lunge; its own execution steps say
// "continue alternating legs"), and wrong for every other unilateral lift too,
// because the player moves on after N ✓ taps, before the right side ever starts.
// Returns HTML for a .cue div; only parsed numbers are interpolated, never raw
// plan text, so nothing here needs escaping.
const LOWER_BODY_PATTERN = /lunge|squat|hinge|knee|hip|plantarflexion/;
export function sideCue(ex, { station = false } = {}) {
  if (!ex?.unilateral) return "";
  if (ex.alternating) {
    const leg = LOWER_BODY_PATTERN.test(ex.movement_pattern ?? "");
    const limb = leg ? "leg" : "side", unit = leg ? "steps" : "reps";
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(String(ex.rep_range ?? "").trim());
    const each = m ? (m[2] ? `${m[1]}-${m[2]}` : m[1]) : null;
    const total = m ? (m[2] ? `${2 * m[1]}-${2 * m[2]}` : `${2 * m[1]}`) : null;
    return `↔️ <b>Alternate ${limb}s every rep</b> — count each ${limb}${each ? `, so ${each} each ${limb} is ${total} ${unit} in total` : ""}. ${station ? "One round is one set like that." : "Tap ✓ when the set's done."}`;
  }
  return station
    ? `↔️ <b>One side, then the other</b> — this round is one set with your <b>left</b> and one with your <b>right</b> (log the weight per side).`
    : `↔️ <b>One side, then the other</b> — each set is your <b>left</b> side, then straight into your <b>right</b>. Tap ✓ once both are done, logging the weight you used per side.`;
}

// Whole calendar days from a local YYYY-MM-DD, by UTC-noon date arithmetic —
// never "now minus n×24h", which skips or repeats a day across a DST change.
// Returns null for anything that isn't a real calendar day.
export function shiftDay(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// How a chosen log day reads on a button: "today", "yesterday", else "Mon 5 Oct".
// Fixed English names so the label is deterministic (matches weekLabelOf's style).
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayLabel(ymd, todayYmd) {
  if (ymd === todayYmd) return "today";
  if (ymd === shiftDay(todayYmd, -1)) return "yesterday";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return String(ymd ?? "");
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${+m[3]} ${MONTH_SHORT[+m[2] - 1]}`;
}

// The Today hub's workout row, decided in ONE place (W271): what today means for the
// workout given the weekly plan. Order matters — a logged workout and a deliberate
// rest day win; a never-trained user's FIRST workout and a comeback always stay the
// hero (saving days on the day-one card must never demote the first session, and a
// returner isn't gated behind an old schedule); then a missed planned day asks to
// catch up; then an unplanned day steps the workout back. No plan → "start", exactly
// as before the plan existed.
export function hubWorkoutState({ daily = {}, session = {}, status = {} } = {}) {
  if (daily.workout_logged) return "done";
  if (daily.rest_day) return "rest";
  if (session.never_trained || status.state === "comeback") return "start";
  // Rail #1: a paused (sick/injured) user is promised no pressure — never "missed".
  if (daily.missed_planned_day && status.state !== "paused") return "missed";
  if (daily.planned_today === false) return "unplanned";
  return "start";
}

// The phone calendar's recurring event (the .ics export) is the one reminder the app
// can't edit or silence. When the plan's days no longer match the days last exported
// (Monday-0 indices, as seedCalendarDays stores them), name the calendar's stale days
// so the user can replace that event. Null when nothing was exported or they match.
const SHORT_DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_INDEX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
export const DAY_LONG = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

// The week strip (C16, W277): the rotation's next sessions (`week_plan.upcoming`, from
// the server's one pointer) laid onto the days still ahead this week. Today follows the
// HUB's own decision (`hubState`, hubWorkoutState's answer: "start" or "missed" means
// today trains), so the strip and the hub can never disagree about today. Past days show what was LOGGED; a bound,
// committed day with nothing logged is a plain dash, never "missed" (guardrail: never
// shame). The rotation stays the truth — a miss slides the week along, nothing dropped —
// and `next_week` names the session the week runs out before, only when this week shows
// it nowhere (a miss or a plan longer than the week pushed it on) — and never in a
// training block's last week (`blockEnds`), where a fresh block opens next week at Day A
// and "X starts next week — nothing gets dropped" would be a promise the rollover breaks.
export function weekStrip(weekPlan, { todayKey, hubState = null, blockEnds = false } = {}) {
  if (!weekPlan?.days?.length) return null;
  const todayTrains = hubState === "start" || hubState === "missed";
  const up = Array.isArray(weekPlan.upcoming) ? weekPlan.upcoming : [];
  let k = 0;
  const entries = [];
  for (const d of weekPlan.days) {
    const trained = Array.isArray(d.trained) ? d.trained : [];
    const at = { day: d.day, date: d.date };
    if (trained.length) entries.push({ ...at, kind: "done", name: trained.filter(Boolean).join(" + ") || null });
    else if (d.date < todayKey) { if (d.bound) entries.push({ ...at, kind: d.rest ? "rest" : "open", name: null }); }
    else if (d.date === todayKey) {
      if (todayTrains) entries.push({ ...at, kind: "today", name: up[k++] ?? null });
      else if (d.committed && d.rest) entries.push({ ...at, kind: "rest", name: null });
    } else if (d.committed) entries.push(d.rest ? { ...at, kind: "rest", name: null } : { ...at, kind: "planned", name: up[k++] ?? null });
  }
  const shown = new Set(entries.flatMap((e) => (e.kind === "done" ? (weekPlan.days.find((x) => x.date === e.date)?.trained ?? []) : [e.name])).filter(Boolean));
  const next = up[k] ?? null;
  return { entries, next_week: next && !shown.has(next) && !blockEnds ? next : null };
}
export function weekChipLabel(e) {
  const d = SHORT_DAY[DAY_INDEX[e?.day]] ?? "";
  if (e?.kind === "done") return `${d} ✓${e.name ? ` ${e.name}` : ""}`;
  if (e?.kind === "today") return `Today · ${e.name ?? "your workout"}`;
  if (e?.kind === "planned") return `${d} · ${e.name ?? "workout"}`;
  if (e?.kind === "rest") return `${d} 🌿 rest`;
  return `${d} –`;
}
// Does the next workout fall after a training block rolls over? (W277 review) Once a
// block's last week is trained, next week's first visit reopens the rotation at Day A
// (`rollsOver` = the server's daily.block_rolls_over, from the rollover's own clock) —
// so a line naming NEXT week's session would name one the new block replaces. ONE
// predicate for every such line: the done line, the off-day label, the preview.
export function crossesBlockEnd({ rollsOver = false, nextDate = null, todayKey } = {}) {
  if (!rollsOver) return false;
  return !nextDate || nextDate > shiftDay(mondayOf(todayKey), 6);
}
const dayWord = (nextDay, todayKey) => (nextDay.date === shiftDay(todayKey, 1) ? "tomorrow" : DAY_LONG[nextDay.day] ?? nextDay.day);
// "What's next, and when" once today's workout is in (C16): the next committed day by name
// (or "tomorrow"), else — no weekly plan — just the next session. Across a block rollover,
// the day without a session name (a new block opens it).
export function nextSessionLine({ nextDay = null, todayKey, name, crossesBlock = false } = {}) {
  if (!name) return "";
  if (crossesBlock) return nextDay?.date ? `Next: ${dayWord(nextDay, todayKey)} — a new training block starts.` : "A new training block starts next week.";
  if (!nextDay?.date) return `Next up: ${name}.`;
  return `Next: ${dayWord(nextDay, todayKey)} — ${name}.`;
}
// The hub row on a day off the plan, and the folded preview beneath it (W271 copy, now
// block-aware): "next: Monday (Lower B)" would be a broken promise when a new block opens
// Monday — what the preview shows is what "Train anyway" starts TODAY.
export function offPlanLabel({ nextDay = null, name, crossesBlock = false } = {}) {
  const when = DAY_LONG[nextDay?.day] ?? "your next training day";
  return crossesBlock ? `Not a training day — next: ${when}, when a new training block starts` : `Not a training day — next: ${when} (${name})`;
}
// The plan's size vs the days actually committed (W278, the owner's pick of option 1): the
// server offers it (daily.plan_fit) once a different count has stood a week; this says
// what the mismatch costs, what a rebuild changes, and that it starts a fresh block — the
// cost of tapping it. `key` identifies the pair, so "Keep" hides THIS offer only.
export function planFitCopy(fit) {
  const n = fit?.plan_days, c = fit?.committed_days;
  if (!n || !c || n === c) return null;
  const cost = c < n
    ? "so workouts keep rolling into the next week, and your muscles get less than the plan was built for"
    : "so workouts repeat within the week, and your muscles get more than the plan was built for";
  const gain = c < n ? "every workout fits your week" : "each day gets its own workout";
  return {
    title: `Fit your plan to your ${c} days?`,
    body: `You've been picking ${c} days a week, but your plan has ${n} workouts — ${cost}. Rebuilt for ${c} days, ${gain}. It starts a fresh training block.`,
    rebuild: `Rebuild for ${c} days`, keep: `Keep my ${n}-day plan`, key: `${n}:${c}`, days: c,
  };
}
// The card's two decisions, here so they're tested rather than wired by hand (W278 review):
// the request "Rebuild" sends — a profile patch the Settings door merges, carrying the
// COMMITTED count — and whether the card shows at all ("Keep" hides that one pair).
export const planFitRequest = (fit) => (fit?.days ? { profile: { days_per_week: fit.days } } : null);
export const planFitVisible = (fit, keptKey) => !!fit && keptKey !== fit.key;
export function offPlanPreview({ nextDay = null, name, crossesBlock = false } = {}) {
  const when = DAY_LONG[nextDay?.day] ?? "your next training day";
  return crossesBlock ? `Preview ${name} — what “Train anyway” starts today` : `Preview ${when}'s workout — ${name}`;
}
export function calendarDrift(exportedIdx, commitDays) {
  const exported = (Array.isArray(exportedIdx) ? exportedIdx : []).filter((i) => Number.isInteger(i) && i >= 0 && i < 7);
  if (!exported.length) return null;
  const now = new Set((commitDays ?? []).map((d) => DAY_INDEX[d]).filter((i) => i != null));
  const same = exported.length === now.size && exported.every((i) => now.has(i));
  return same ? null : { stale: [...new Set(exported)].sort((a, b) => a - b).map((i) => SHORT_DAY[i]) };
}

// What the commitment card should say about the phone-calendar event, judged against
// the days REALLY in force: this week's plan, else the usual days a "No fixed days
// this week" clear will bring back, else none. Never advises deleting an event that
// holds the days the same card says are coming back (W271 review).
//   replace         — a plan is in force and the event holds other days
//   delete-if-done  — cleared this week; the days coming back differ from the event
//   save-or-delete  — no plan at all; the event still reminds on old days
export function calendarAdvice(exportedIdx, { days = [], resumeDays = null } = {}) {
  const against = days?.length ? days : resumeDays?.length ? resumeDays : [];
  const d = calendarDrift(exportedIdx, against);
  if (!d) return null;
  return { ...d, advice: days?.length ? "replace" : resumeDays?.length ? "delete-if-done" : "save-or-delete" };
}

// "Can't do this one?" (W272): say what the server REALLY did — an exact restore, a
// rebuild that put the lift back, a rebuild that didn't need it this block, or a
// hand-built plan where only the exclusion was lifted (lesson 60: copy is a promise).
export function bringBackCopy({ mode, restored = 0, name = "That lift" } = {}) {
  if (mode === "exact") return `${name} is back in your plan.`;
  if (mode === "rebuilt") return restored ? `${name} is back — your plan was rebuilt with it available.` : `${name} is available again — your plan will use it when it fits.`;
  return `${name} is available again — add it back in the plan editor whenever you like.`;
}
// The player's Undo: the live slot goes back only if the substitute has no banked work
// (replaceSlot's guard); the plan side of a permanent swap is undone either way.
export function swapUndoCopy({ revertedLive, permanent, from, to }) {
  if (!permanent) return `${from} is back.`;
  return revertedLive ? `${from} is back — in today's workout and your plan.` : `${to} stays for today (you've started it) — ${from} is back from your next session.`;
}

// The engine's reason for a suggested weight, in the LIFT's display unit (Burst 1 review).
// The server writes it in kg, and every figure in it is the suggested weight, the last weight
// or the step between them — so in pounds each one becomes exactly what the screen shows:
// a weight as the stepper shows it (`preDisp` is the pre-filled value), a step ("add N kg")
// as the plates actually moved. A reason that would still contradict the screen — an "add"
// while the stepper shows last time's weight — is dropped (null), never shown.
export function noteInUnit(note, { suggested_kg, last_kg } = {}, unit, toDisp, preDisp) {
  if (!note || unit !== "lb") return note ?? null;
  const lastDisp = last_kg > 0 ? toDisp(last_kg) : null;
  let contradicts = false;
  const out = note.replace(/(add )?(\d+(?:\.\d+)?) kg\b/g, (_, add, n) => {
    if (add) {
      const step = lastDisp == null ? null : preDisp - lastDisp;
      if (!(step > 0)) contradicts = true;
      return `add ${step} lb`;
    }
    const kg = +n;
    return `${kg === suggested_kg ? preDisp : kg === last_kg ? lastDisp : toDisp(kg)} lb`;
  });
  return contradicts ? null : out;
}

// The next-set hint's words (W279b; Burst 1 review): what the set just banked actually did —
// reps under the range, reps over it, or reps IN it with far more left in the tank than the
// plan's band (that hint fires on effort, so "over the range" would be false there). The
// player bolds `lead` and `tryW`; weights arrive already formatted in the lift's unit.
export function hintCopy(hint, { setNo, fromW, toW }) {
  const range = `${hint.min}–${hint.max}`;
  const lead = `Set ${setNo}: ${hint.reps} reps at ${fromW}`;
  if (hint.kind === "lighter") return { lead, why: `under the ${range} range`, tryW: toW, tail: "for this one to land in it." };
  if (hint.reps > hint.max) return { lead, why: `over the ${range} range`, tryW: toW, tail: "for this one to land in it." };
  const band = hint.band ? ` (the plan says ${hint.band.replace("-", "–")})` : "";
  return { lead, why: `in the range, but with about ${hint.rir} left in the tank${band}`, tryW: toW, tail: "for this one." };
}

// The read-out's words for WHAT HAPPENED (W282), from session-core localReadout. A headline
// that counts what WAS done and never shames (Goal 4); what went well; what's worth a look —
// each at most three, said plainly. A beginner gets the headline only (Goal 3): the weights
// for next time come with their reasons from the server lines.
export function readoutLists(local, { nameOf = (id) => id, beginner = false } = {}) {
  const graded = local.lifts.filter((l) => !l.easyDay && l.done > 0);
  const skipped = Math.max(0, local.planned - local.done);
  const underN = graded.filter((l) => l.under > 0).length;
  const tops = graded.filter((l) => l.top);
  const band = (b) => String(b ?? "").replace("-", "–");
  const headline = !local.done ? "Workout saved."
    : !graded.length ? "Easy day done — recovery is part of the plan."
    : skipped > 0 ? `${local.done} of ${local.planned} planned sets done — every one of them counts.`
    : underN ? `Every set done — ${underN === 1 ? "1 lift" : `${underN} lifts`} came in under ${underN === 1 ? "its" : "their"} range, and next time is set up for that.`
    : tops.length === graded.length ? "Every set done, and every lift at the top of its range — time to go up."
    : tops.length ? `Every set done, every lift in its range — ${tops.length} at the top, ready to go up.`
    : "Every set done, every lift in its range — a session that moves you forward.";
  if (beginner) return { headline, went_well: [], watch: [] };
  const went_well = [
    ...tops.slice(0, 2).map((l) => `${nameOf(l.exercise)}: top of the range on every set.`),
    ...(skipped === 0 && local.planned > 0 && graded.length >= 2 ? [`All ${local.planned} planned sets done.`] : []),
    ...(graded.some((l) => l.rir != null) && !graded.some((l) => l.easy || l.failure) ? ["Effort right where the plan wanted it."] : []),
  ].slice(0, 3);
  const watch = local.lifts.filter((l) => !l.easyDay).flatMap((l) => {
    const n = nameOf(l.exercise);
    return [
      ...(l.planned != null && l.done < l.planned ? [`${n}: ${l.done} of ${l.planned} sets.`] : []),
      ...(l.under ? [`${n}: ${l.under} of ${l.done} sets under the ${l.min}–${l.max} range.`] : []),
      ...(l.easy ? [`${n}: about ${l.rir} reps left in the tank — the plan asked for ${band(l.band)}.`] : []),
      ...(l.failure ? [`${n}: taken to failure — the plan wanted ${band(l.band)} in reserve.`] : []),
    ];
  }).slice(0, 3);
  return { headline, went_well, watch };
}

// Plain-English muscle names — a beginner expects "shoulders", not "side-delts". The server's
// sentences use a copy (coach.mjs MUSCLE_PLAIN), pinned equal by test-ui-helpers (W282).
export const MUSCLE_LABEL = {
  "front-delts": "front of shoulders", "side-delts": "shoulders (side)", "rear-delts": "rear shoulders",
  "lats": "back (lats)", "upper-back": "upper back", "spinal-erectors": "lower back",
  "quadriceps": "thighs (quads)", "hamstrings": "hamstrings", "glutes": "glutes", "calves": "calves",
  "biceps": "biceps", "triceps": "triceps", "forearms": "forearms", "chest": "chest", "abs": "abs", "neck": "neck",
};
export const friendlyMuscle = (m) => MUSCLE_LABEL[m] || String(m).replace(/-/g, " ");
// "a", "a and b", "a, b and c", "a, b, c and 2 more" — a sentence never carries a roll call.
export function friendlyList(xs, max = 3) {
  const shown = xs.slice(0, max), more = xs.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length <= 2 ? shown.join(" and ") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
