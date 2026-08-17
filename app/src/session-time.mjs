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
