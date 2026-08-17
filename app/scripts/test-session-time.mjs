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

console.log(`\n${pass} session-time test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
