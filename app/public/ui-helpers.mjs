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
