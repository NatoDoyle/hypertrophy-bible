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
// Two callers, two different questions, so the frame is a parameter rather than
// an assumption:
//   - the WRITE door (a session arriving from a device) passes no tz and gets the
//     flat +24h UTC slack. That is deliberately lenient — it covers every real
//     offset out to UTC+14, so an honest workout is never quarantined merely for
//     being logged in Kiritimati, and it is the rule every already-stored row was
//     judged by. Changing it would silently re-judge history.
//   - the CORRECTION door passes the user's own offset (`X-HB-TZ`, sent on every
//     request) and gets THEIR local tomorrow. This is what the date picker offers,
//     so the server stops refusing a day its own client had just presented as
//     selectable — and stops accepting a date ~35 hours ahead of a west-of-UTC
//     user's actual now. Compare calendar dates in the user's frame (lesson 22).
export function tomorrowLocalDate(nowMs = Date.now(), tzOffsetMin = null) {
  const shift = tzOffsetMin == null ? SESSION_FUTURE_SLACK_MS : tzOffsetMin * 60000 + SESSION_FUTURE_SLACK_MS;
  return new Date(nowMs + shift).toISOString().slice(0, 10);
}

export function normalizeSessionInstant(value, nowMs = Date.now(), tzOffsetMin = null) {
  const parsed = parseSessionInstant(value);
  return parsed != null && new Date(parsed).toISOString().slice(0, 10) <= tomorrowLocalDate(nowMs, tzOffsetMin)
    ? new Date(parsed).toISOString()
    : new Date(nowMs).toISOString();
}

export function normalizeSessionLocalDate(value, nowMs = Date.now(), tzOffsetMin = null) {
  return validLocalDate(value) && value <= tomorrowLocalDate(nowMs, tzOffsetMin) ? value : null;
}

// The frame must reach BOTH halves. Accepting a correction against the user's
// local ceiling and then normalizing it against the UTC one would drop the
// local_date to null and silently re-stamp `date` as "now" — the correction would
// appear to succeed while storing a different day than the one the user chose.
export function normalizeSessionTiming({ date, local_date } = {}, nowMs = Date.now(), tzOffsetMin = null) {
  return {
    date: normalizeSessionInstant(date, nowMs, tzOffsetMin),
    local_date: normalizeSessionLocalDate(local_date, nowMs, tzOffsetMin),
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
