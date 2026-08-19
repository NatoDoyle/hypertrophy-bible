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

// --- the ceiling: ONE rule, and the invariant that matters --------------------
// The defect this replaces: the correction door was made tz-aware while the
// quarantine predicate stayed flat, so the door accepted repairs the read path
// then rejected. The tests that were supposed to cover it BOTH avoided the branch
// — one advanced the clock two days before asserting derivability, the other
// asserted only an HTTP 200. That is why the assertions below are written as an
// invariant over a swept input space rather than as one hand-picked example.

// HONEST LABEL: this one is a PIN, not a guard. Now that the door and the read
// path share a single parameterless `tomorrowLocalDate`, they agree by
// construction and no tamper inside this module can separate them — I tried, and
// the tamper moved both sides at once. Its job is to fail if someone re-introduces
// a per-caller frame. The test that can actually catch the ORIGINAL defect is at
// the route level (`test-routes.mjs` #tq), where the correction is made through
// the real door and `/api/sessions` is then re-read; that one goes red on the
// pre-fix code. Saying which is which is the point of lesson 54.
check("PIN: anything the correction door accepts is derivable by the read path", () => {
  // Sweep every offset the world has and every hour of the day. If the accept-set
  // ever exceeds the derivable-set, this fails with the exact case.
  const bad = [];
  for (let tz = -12 * 60; tz <= 14 * 60; tz += 30) {
    for (let h = 0; h < 24; h++) {
      const now = Date.parse("2026-08-18T00:00:00.000Z") + h * 3600000;
      // what a client at this offset could plausibly submit: its own local today
      // and its local tomorrow (which is what a device-local picker would offer)
      for (const shift of [0, 86400000]) {
        const candidate = new Date(now + tz * 60000 + shift).toISOString().slice(0, 10);
        if (!normalizeSessionLocalDate(candidate, now)) continue;   // refused: fine
        const timing = normalizeSessionTiming({ date: candidate, local_date: candidate }, now);
        if (!isDerivableSession(timing, now)) bad.push({ tz, h, candidate, timing });
      }
    }
  }
  assert.deepEqual(bad.slice(0, 3), [], `accepted but not derivable: ${JSON.stringify(bad.slice(0, 3))}`);
});

check("...and the sweep is not vacuous — the door really does accept things", () => {
  // Without this, the invariant above would pass trivially if the door refused
  // everything (lesson 54: a fixture that never reaches the branch proves nothing).
  let accepted = 0;
  for (let tz = -12 * 60; tz <= 14 * 60; tz += 30) {
    const now = Date.parse("2026-08-18T12:00:00.000Z");
    const localToday = new Date(now + tz * 60000).toISOString().slice(0, 10);
    if (normalizeSessionLocalDate(localToday, now)) accepted++;
  }
  assert.equal(accepted, 53, "every offset's local TODAY must be acceptable");
});

check("the ceiling never refuses a user's own local TODAY, at any offset or hour", () => {
  const refused = [];
  for (let tz = -12 * 60; tz <= 14 * 60; tz += 30) {
    for (let h = 0; h < 24; h++) {
      const now = Date.parse("2026-08-18T00:00:00.000Z") + h * 3600000;
      const localToday = new Date(now + tz * 60000).toISOString().slice(0, 10);
      if (!normalizeSessionLocalDate(localToday, now)) refused.push({ tz, h, localToday });
    }
  }
  assert.deepEqual(refused, [], "this is the property that makes narrowing the picker the right fix");
});

check("a far-east user's local TOMORROW is refused — and that is correct, not a bug", () => {
  const now = Date.parse("2026-08-18T22:00:00.000Z");
  assert.equal(normalizeSessionLocalDate("2026-08-20", now), null, "nobody has trained tomorrow");
  assert.equal(normalizeSessionLocalDate("2026-08-19", now), "2026-08-19");
});

check("a corrected row is DERIVABLE at the SAME instant it was corrected", () => {
  // The old version of this test advanced `now` by two days before asserting, so
  // it could not have caught the defect it was named for. Judge at the correction's
  // own instant — the only moment that matters to the user staring at the screen.
  const now = Date.parse("2026-08-18T22:00:00.000Z");
  const chosen = normalizeSessionLocalDate("2026-08-19", now);
  assert.ok(chosen, "precondition: the door accepts this");
  const timing = normalizeSessionTiming({ date: chosen, local_date: chosen }, now);
  assert.equal(sessionTimingIssue(timing, now), null);
  assert.equal(isDerivableSession(timing, now), true);
});


console.log(`\n${pass} session-time test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
