// Deterministic unit coverage for the single session-timing contract.  This is
// deliberately independent of routes and stores: a malformed clock value must
// have the same meaning wherever a session is saved or later derived.
import assert from "node:assert";
import {
  isDerivableSession,
  normalizeSessionInstant,
  normalizeSessionLocalDate,
  normalizeSessionTiming,
  parseSessionInstant,
  sessionTimingIssue,
  tomorrowLocalDate,
  validLocalDate,
} from "../src/session-time.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log("  \u2713 " + name);
  } catch (error) {
    fail++;
    console.log("  \u2717 " + name + "\n      " + error.message);
  }
};

// Keep every assertion clock-independent.  This is intentionally near midnight:
// the future allowance is a UTC *calendar* day (through tomorrow), not 24 hours
// from the exact logging instant.
const now = Date.parse("2026-08-15T23:00:00.000Z");
const nowIso = "2026-08-15T23:00:00.000Z";

check("strict local dates accept a real leap day and reject calendar overflow", () => {
  assert.equal(validLocalDate("2024-02-29"), true);
  assert.equal(validLocalDate("2026-02-29"), false);
  assert.equal(validLocalDate("2026-04-31"), false);
  assert.equal(validLocalDate("2026-2-09"), false);
  assert.equal(validLocalDate("2026-08-15T12:00:00Z"), false);
});

check("date-only and offset ISO values parse to their canonical UTC instants", () => {
  assert.equal(parseSessionInstant("2024-02-29"), Date.parse("2024-02-29T12:00:00.000Z"));
  assert.equal(
    normalizeSessionInstant("2026-08-15T23:30:00+01:00", now),
    "2026-08-15T22:30:00.000Z",
  );
  assert.equal(
    normalizeSessionInstant("2026-08-15T23:30:00+0100", now),
    "2026-08-15T22:30:00.000Z",
  );
  assert.equal(parseSessionInstant("2026-08-15T24:00:00Z"), null);
  assert.equal(parseSessionInstant("2026-02-29T12:00:00Z"), null);
});

check("missing, invalid, and far-future instants normalize to the server clock", () => {
  assert.equal(normalizeSessionInstant(undefined, now), nowIso);
  assert.equal(normalizeSessionInstant("not-a-date", now), nowIso);
  assert.equal(normalizeSessionInstant("2035-01-01T00:00:00Z", now), nowIso);
});

check("a valid historical local date is retained without silently changing its calendar day", () => {
  assert.deepEqual(
    normalizeSessionTiming({ date: "2024-02-29", local_date: "2024-02-29" }, now),
    { date: "2024-02-29T12:00:00.000Z", local_date: "2024-02-29" },
  );
});

check("invalid or future local dates are omitted while the session instant stays safe", () => {
  assert.deepEqual(
    normalizeSessionTiming({ date: "2024-02-29", local_date: "2026-02-29" }, now),
    { date: "2024-02-29T12:00:00.000Z", local_date: null },
  );
  assert.equal(normalizeSessionLocalDate("2026-08-17", now), null);
  assert.equal(normalizeSessionLocalDate(undefined, now), null);
});

check("the UTC tomorrow calendar boundary permits a late-tomorrow session, not only the next 24 hours", () => {
  assert.equal(tomorrowLocalDate(now), "2026-08-16");
  assert.deepEqual(
    normalizeSessionTiming({ date: "2026-08-16T23:30:00Z", local_date: "2026-08-16" }, now),
    { date: "2026-08-16T23:30:00.000Z", local_date: "2026-08-16" },
  );
  assert.equal(normalizeSessionInstant("2026-08-17T00:00:00Z", now), nowIso);
});

check("legacy timing faults are quarantined from all derivations until corrected", () => {
  const safe = { date: "2026-08-16T23:30:00Z", local_date: "2026-08-16" };
  const invalidDate = { date: "2026-02-29T12:00:00Z" };
  const futureDate = { date: "2026-08-17T00:00:00Z" };
  const invalidLocalDate = { date: "2026-08-15T12:00:00Z", local_date: "2026-02-29" };

  assert.equal(sessionTimingIssue(safe, now), null);
  assert.equal(isDerivableSession(safe, now), true);
  assert.equal(sessionTimingIssue(invalidDate, now), "invalid-date");
  assert.equal(isDerivableSession(invalidDate, now), false);
  assert.equal(sessionTimingIssue(futureDate, now), "invalid-date");
  assert.equal(sessionTimingIssue(invalidLocalDate, now), "invalid-local-date");
  assert.equal(isDerivableSession(invalidLocalDate, now), false);
});

// --- the ceiling's FRAME -----------------------------------------------------
// The write door and the correction door ask different questions, so the frame is
// an argument. These pin BOTH, because getting either wrong is silent: a too-tight
// ceiling quarantines honest workouts, a too-loose one accepts a date the user
// cannot possibly have trained on, and a MISMATCH between the two doors made the
// only exit from quarantine a dead end.
check("tomorrowLocalDate: no tz keeps the flat +24h UTC slack (the write door's rule, unchanged)", () => {
  // 2026-08-18T22:00Z + 24h -> 2026-08-19
  assert.equal(tomorrowLocalDate(Date.parse("2026-08-18T22:00:00.000Z")), "2026-08-19");
  assert.equal(tomorrowLocalDate(Date.parse("2026-08-18T00:00:00.000Z")), "2026-08-19");
});
check("tomorrowLocalDate: a far-EAST user's ceiling is their own local tomorrow", () => {
  // UTC 2026-08-18T22:00 is 2026-08-19T11:00 in UTC+13 -> their tomorrow is the 20th.
  assert.equal(tomorrowLocalDate(Date.parse("2026-08-18T22:00:00.000Z"), 13 * 60), "2026-08-20");
  // ...and the UTC-framed answer is a day earlier, which is exactly the mismatch:
  // the picker offered the 20th and the server refused it.
  assert.equal(tomorrowLocalDate(Date.parse("2026-08-18T22:00:00.000Z")), "2026-08-19");
});
check("tomorrowLocalDate: a far-WEST user cannot claim a day ~35h ahead of their now", () => {
  // UTC 2026-08-19T05:00 is 2026-08-18T18:00 in UTC-11 -> their tomorrow is the 19th.
  assert.equal(tomorrowLocalDate(Date.parse("2026-08-19T05:00:00.000Z"), -11 * 60), "2026-08-19");
  assert.equal(tomorrowLocalDate(Date.parse("2026-08-19T05:00:00.000Z")), "2026-08-20"); // the old, looser answer
});
check("normalizeSessionLocalDate: the east user's local tomorrow is accepted WITH tz and refused without", () => {
  const now = Date.parse("2026-08-18T22:00:00.000Z");
  assert.equal(normalizeSessionLocalDate("2026-08-20", now, 13 * 60), "2026-08-20");
  assert.equal(normalizeSessionLocalDate("2026-08-20", now), null);
});
check("normalizeSessionTiming: the frame reaches BOTH halves, so an accepted day is STORED as that day", () => {
  const now = Date.parse("2026-08-18T22:00:00.000Z");
  const t = normalizeSessionTiming({ date: "2026-08-20", local_date: "2026-08-20" }, now, 13 * 60);
  assert.equal(t.local_date, "2026-08-20", "local_date must survive");
  assert.equal(t.date.slice(0, 10), "2026-08-20", "the instant must be that day, not re-stamped as now");
  // Without the frame, the same correction silently became "now" with a null
  // local_date — a save that reports success and stores a different day.
  const drifted = normalizeSessionTiming({ date: "2026-08-20", local_date: "2026-08-20" }, now);
  assert.equal(drifted.local_date, null);
  assert.equal(drifted.date.slice(0, 10), "2026-08-18");
});
check("a corrected row is DERIVABLE again — the whole point of the repair path", () => {
  const now = Date.parse("2026-08-18T22:00:00.000Z");
  const t = normalizeSessionTiming({ date: "2026-08-20", local_date: "2026-08-20" }, now, 13 * 60);
  // judged by the write door's own (flat) rule, as every stored row is
  assert.equal(isDerivableSession({ date: t.date, local_date: t.local_date }, Date.parse("2026-08-20T00:00:00.000Z")), true);
});

console.log(`\n${pass} session-time test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
