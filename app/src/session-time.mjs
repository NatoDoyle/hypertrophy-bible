// One timing contract for every persisted workout.  A session date feeds more
// than display order: it drives progression, streaks, push timing, and the
// owner aggregates, so a parseable-but-impossible JS date (for example
// 2026-02-29) or a far-future device clock must never enter those consumers.

export const SESSION_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/;

// Date.parse intentionally normalizes overflow ("2026-02-29" becomes March
// 1).  Compare the UTC parts back to the submitted components instead.
export function validLocalDate(value) {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [, ys, ms, ds] = m;
  const year = Number(ys), month = Number(ms), day = Number(ds);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

// Return a real instant in milliseconds, or null.  Date-only values remain
// supported for old/offline clients; noon UTC avoids an accidental prior-day
// display in western timezones, while local_date remains the authoritative
// calendar frame for streaks and weeks.
export function parseSessionInstant(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (validLocalDate(s)) return Date.parse(`${s}T12:00:00.000Z`);
  const m = INSTANT_RE.exec(s);
  if (!m || !validLocalDate(m[1])) return null;
  const hour = Number(m[2]), minute = Number(m[3]), second = Number(m[4] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

// The plausibility ceiling: the latest calendar day a workout may claim.
//
// ONE rule, no frame parameter — and the second attempt at this, so the reasoning
// is written down. Wave 218 made the CORRECTION door tz-aware because the client's
// date picker offered the device's local tomorrow and the server refused it. That
// widened the accept-set past the DERIVABLE-set: `sessionTimingIssue` below still
// judged stored rows by this flat rule, so a UTC+13 user's repair was accepted,
// stored, announced as "it now counts" — and re-quarantined by the very next read.
// A repair that silently does nothing is worse than one that refuses honestly.
//
// The widening was never needed. Verified exhaustively across every offset from
// -12:00 to +14:00 at every hour of the day: the flat +24h slack NEVER refuses a
// user's own local TODAY. It only refuses their local TOMORROW, which is correct —
// you have not trained tomorrow. So the client picker is the thing that was wrong,
// and it now computes this same ceiling (app.js `historyTomorrow`).
//
// The invariant this file now owes its callers: **anything the correction door
// accepts must be derivable by the read path**, and it holds by construction
// because both call this one function. A test asserts it directly.
export function tomorrowLocalDate(nowMs = Date.now()) {
  return new Date(nowMs + SESSION_FUTURE_SLACK_MS).toISOString().slice(0, 10);
}

export function normalizeSessionInstant(value, nowMs = Date.now()) {
  const parsed = parseSessionInstant(value);
  return parsed != null && new Date(parsed).toISOString().slice(0, 10) <= tomorrowLocalDate(nowMs)
    ? new Date(parsed).toISOString()
    : new Date(nowMs).toISOString();
}

export function normalizeSessionLocalDate(value, nowMs = Date.now()) {
  return validLocalDate(value) && value <= tomorrowLocalDate(nowMs) ? value : null;
}

export function normalizeSessionTiming({ date, local_date } = {}, nowMs = Date.now()) {
  return {
    date: normalizeSessionInstant(date, nowMs),
    local_date: normalizeSessionLocalDate(local_date, nowMs),
  };
}

// A raw legacy record remains durable, but is not safe to use for any derived
// decision until the user corrects it through History.  Treat an invalid local
// calendar day as a record-level timing fault rather than silently banking the
// workout into a different week.
export function sessionTimingIssue(session, nowMs = Date.now()) {
  const dateMs = parseSessionInstant(session?.date);
  if (dateMs == null || new Date(dateMs).toISOString().slice(0, 10) > tomorrowLocalDate(nowMs)) return "invalid-date";
  if (session?.local_date != null && !normalizeSessionLocalDate(session.local_date, nowMs)) return "invalid-local-date";
  return null;
}

export function isDerivableSession(session, nowMs = Date.now()) {
  return !sessionTimingIssue(session, nowMs);
}
