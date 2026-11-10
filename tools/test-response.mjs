// Response-core tests (W315, considerations iteration Burst 10 — owner note 7: "I really start to struggle once I get past
// 12 sets in one workout and once I get to 16 sets I'm pretty empty. The app should be able to learn this from my data.
// Other users will be different."). The learners are pure and deterministic: the binder passes the priors in.
import assert from "node:assert/strict";
import { sessionTolerance, paceProfile, restAdapt } from "./response-core.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

const day = (n) => new Date(Date.UTC(2026, 9, 1) + n * 86400000).toISOString();
const W = (extra = {}) => ({ exercise: "bench", set_type: "work", weight_kg: 60, reps: 8, ...extra });
// A workout of `n` work sets on day `d`, with optional fade marks / a feel answer / per-set extras.
const workout = (d, n, { marks = null, feel = null, set = {} } = {}) => ({ session_id: `s${d}`, date: day(d), sets: Array.from({ length: n }, () => W(set)),
  ...(marks ? { fade_marks: marks } : {}), ...(feel ? { feel } : {}) });
// Eight workouts two days apart, `fadeAt` the indexes that fade, built by `make`.
const eight = (make) => Array.from({ length: 8 }, (_, i) => make(i * 2, i));

check("#tolerance nothing logged, or a lifter who never fades: no ceiling to learn — it never moves", () => {
  assert.equal(sessionTolerance([], { prior: 16 }), null);
  assert.equal(sessionTolerance(eight((d) => workout(d, 18, { feel: "strong" })), { prior: 16 }), null);
  assert.equal(sessionTolerance(eight((d) => workout(d, 18)), { prior: 16 }), null);
});
check("#tolerance late skips at set 13 in 4 of the last 8: the ceiling is 13", () => {
  const s = eight((d, i) => workout(d, 18, i % 2 ? { marks: [{ kind: "skip", at: 13, of: 18 }] } : {}));
  assert.deepStrictEqual(sessionTolerance(s, { prior: 16 }), { cap: 13, fades: 4, eligible: 8, points: [13, 13, 13, 13] });
});
check("#tolerance an early skip isn't a fade (the last third of the planned sets only); an early end with work left and a too-tired moment are", () => {
  const early = eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 3, of: 18 }] }));
  assert.equal(sessionTolerance(early, { prior: 16 }), null, "skipped set 4 of 18: not fatigue");
  const ends = eight((d, i) => workout(d, 12, i < 3 ? { marks: [{ kind: "early", at: 12, of: 18 }] } : {}));
  assert.equal(sessionTolerance(ends, { prior: 16 })?.cap, 12);
  const tired = eight((d, i) => workout(d, 18, i < 4 ? { marks: [{ kind: "tired", at: 14, of: 18 }] } : {}));
  assert.equal(sessionTolerance(tired, { prior: 16 })?.cap, 14);
});
check("#tolerance 'fading' or 'empty' in the read-out: the fade began about the last few sets — the workout's sets less 2", () => {
  const s = eight((d, i) => workout(d, 16, i < 3 ? { feel: i === 0 ? "empty" : "fading" } : {}));
  assert.equal(sessionTolerance(s, { prior: 16 })?.cap, 14);
});
check("#tolerance two fades in eight is not a pattern; only the last 8 workouts that can show one count", () => {
  assert.equal(sessionTolerance(eight((d, i) => workout(d, 18, i < 2 ? { marks: [{ kind: "skip", at: 13, of: 18 }] } : {})), { prior: 16 }), null);
  const old = eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 13, of: 18 }] }));
  const recent = Array.from({ length: 8 }, (_, i) => workout(20 + i * 2, 18));
  assert.equal(sessionTolerance([...old, ...recent], { prior: 16 }), null, "the old fades are past the window");
});
check("#tolerance deload weeks, comebacks and estimate-heavy workouts don't count — their fades say nothing about the ceiling", () => {
  const deload = eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 13, of: 18 }], set: { deload: true } }));
  assert.equal(sessionTolerance(deload, { prior: 16 }), null, "every set planned easy: a deload week");
  const est = eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 13, of: 18 }], set: { est: ["reps"] } }));
  assert.equal(sessionTolerance(est, { prior: 16 }), null, "the numbers were guesses");
  const back = [workout(0, 18), workout(30, 18, { marks: [{ kind: "skip", at: 13, of: 18 }] }), workout(32, 18), workout(34, 18)];
  assert.equal(sessionTolerance(back, { prior: 16, minFades: 1 }), null, "the first workout back after a 30-day gap");
  const tiredLift = eight((d, i) => ({ ...workout(d, 18, i < 3 ? { marks: [{ kind: "tired", at: 13, of: 18 }] } : {}), sets: [...Array(13).fill(W()), ...Array(5).fill(W({ deload: true }))] }));
  assert.equal(sessionTolerance(tiredLift, { prior: 16 })?.cap, 13, "one tired-eased lift isn't a deload week");
});
check("#tolerance bounded: never under 10, never at or above the KB's own ceiling for the lifter (nothing to change there)", () => {
  assert.equal(sessionTolerance(eight((d) => workout(d, 18, { marks: [{ kind: "skip", at: 7, of: 9 }] })), { prior: 16 })?.cap, 10);
  assert.equal(sessionTolerance(eight((d) => workout(d, 20, { marks: [{ kind: "skip", at: 17, of: 20 }] })), { prior: 16 }), null, "fades past the KB ceiling: the ceiling already binds");
  assert.equal(sessionTolerance(eight((d) => workout(d, 20, { marks: [{ kind: "skip", at: 15, of: 20 }] })), { prior: 16 })?.cap, 15);
});
check("#tolerance deterministic: the same log, the same answer — in any input order", () => {
  const s = eight((d, i) => workout(d, 18, i % 2 ? { marks: [{ kind: "skip", at: 12 + (i % 3), of: 18 }] } : {}));
  const a = sessionTolerance(s, { prior: 16 }), b = sessionTolerance([...s].reverse(), { prior: 16 });
  assert.deepStrictEqual(a, b);
});

// --- W316 (considerations iteration, Burst 10 — note 5's "60 minutes means 60 minutes", at the lifter's OWN pace): the
// time between their sets per rest tier, their lift changes and their start, from the stamps every set carries — a tier
// only once it has enough samples (the defaults stand in until then); null with nothing to say.
{
  const tierOf = (id) => ({ bench: "heavy", row: "moderate", curl: "isolation" })[id] ?? null;
  const at = (d, sec) => new Date(Date.UTC(2026, 9, 1) + d * 86400000 + sec * 1000).toISOString();
  const sess = (d, gapH, { lead = 300 } = {}) => ({ session_id: `p${d}`, date: at(d, 0), sets: [
    { exercise: "bench", set_type: "work", weight_kg: 80, reps: 6, completed_at: at(d, lead) },
    { exercise: "bench", set_type: "work", weight_kg: 80, reps: 6, completed_at: at(d, lead + gapH) },
    { exercise: "curl", set_type: "work", weight_kg: 15, reps: 12, completed_at: at(d, lead + gapH + 120) }] });
  check("#pace (W316) twelve workouts' heavy gaps (150 s) and starts: the lifter's own heavy tier, lift change and lead", () => {
    assert.deepStrictEqual(paceProfile(Array.from({ length: 12 }, (_, d) => sess(d * 2, 150)), tierOf), { heavy: 150, transition: 120, lead: 300 });
  });
  check("#pace (W316) too few samples: nothing replaces the defaults", () => {
    assert.equal(paceProfile(Array.from({ length: 5 }, (_, d) => sess(d * 2, 150)), tierOf), null);
    assert.equal(paceProfile([], tierOf), null);
  });
  check("#pace (W316) an absurd median (a phone left on the bench) is no pace", () => {
    assert.equal(paceProfile(Array.from({ length: 12 }, (_, d) => sess(d * 2, 20, { lead: 2000 })), tierOf)?.heavy, undefined, "20 s between heavy sets: not a real gap");
  });
}

// --- W317 (considerations iteration, Burst 10 — owner note 1: "track the time between logged sets… use that data to maybe
// suggest longer or shorter rest times"): a lift's timer moves ONE step (30 s) from the KB's default for its tier, never out
// of the KB's band (rest-periods.md: heavy 2–3 min, moderate 1.5–2.5, isolation 1–2), with its reason. Longer [B] when the
// next set kept falling under the range after a rest no longer than the timer, in 2 of the lift's last 3 workouts; shorter
// [C — accessories only, to save time] when the workout runs past its minutes and the sets held.
{
  const ex = { heavy: { id: "bench", mechanic: "compound", equipment: "barbell" }, iso: { id: "curl", mechanic: "isolation", equipment: "dumbbell", cns_cost: "low" } };
  const at = (d, sec) => new Date(Date.UTC(2026, 9, 1) + d * 86400000 + sec * 1000).toISOString();
  // A workout of `reps` sets, `gap` seconds apart, the target's range and timer recorded (W280/W308).
  const w = (d, id, reps, gap, { rest = null, range = "8-12", extra = {} } = {}) => ({ session_id: `${id}${d}`, date: at(d, 0),
    sets: reps.map((r, k) => ({ exercise: id, set_type: "work", weight_kg: 60, reps: r, completed_at: at(d, 300 + k * gap), ...extra })),
    targets: [{ exercise: id, sets: reps.length, rep_range: range, ...(rest ? { rest_s: rest } : {}) }] });
  check("#rest (W317) the next set fell under the range after a full-timer rest, in 2 of the last 3: 30 s longer, said why", () => {
    const log = [w(0, "bench", [10, 7, 7], 180), w(2, "bench", [10, 10, 9], 180), w(4, "bench", [9, 6, 6], 185)];
    assert.deepStrictEqual(restAdapt(ex.heavy, log, {}), { rest_s: 210, reason: "Rest 3:30 — your next set kept falling under the range after a 3:00 rest (2 of your last 3 workouts)." });
  });
  check("#rest (W317) not when the rest ran longer than the timer, nor on one workout, nor on estimates", () => {
    assert.equal(restAdapt(ex.heavy, [w(0, "bench", [10, 7], 300), w(2, "bench", [10, 7], 300), w(4, "bench", [10, 7], 300)], {}), null, "5 minutes and still short: more rest isn't the lever");
    assert.equal(restAdapt(ex.heavy, [w(0, "bench", [10, 10], 180), w(2, "bench", [10, 10], 180), w(4, "bench", [10, 7], 180)], {}), null, "once in three");
    assert.equal(restAdapt(ex.heavy, [w(0, "bench", [10, 7], 180, { extra: { est: ["reps"] } }), w(2, "bench", [10, 7], 180, { extra: { est: ["reps"] } }), w(4, "bench", [10, 10], 180)], {}), null, "guessed counts");
  });
  check("#rest (W317) an accessory whose sets held, in workouts that run long: 30 s shorter — never under the band's 60 s", () => {
    const held = [w(0, "curl", [12, 12, 11], 90), w(2, "curl", [12, 11, 11], 90), w(4, "curl", [12, 12, 12], 90)];
    assert.deepStrictEqual(restAdapt(ex.iso, held, { timeBinds: true }), { rest_s: 60, reason: "Rest 1:00 — your sets held at 1:30, and your workouts run past your minutes." });
    assert.equal(restAdapt(ex.iso, held, { timeBinds: false }), null, "time to spare: the KB's default stands");
    assert.equal(restAdapt(ex.heavy, [w(0, "bench", [10, 10], 180), w(2, "bench", [10, 10], 180), w(4, "bench", [10, 10], 180)], { timeBinds: true }), null, "never a big lift: shorter rests cost it reps");
    assert.equal(restAdapt(ex.iso, [w(0, "curl", [12, 7], 90), ...held.slice(1)], { timeBinds: true }), null, "a set under the range: not holding");
  });
  check("#rest (W317) the timer judged is the one the workout RAN (targets.rest_s), so a lengthened timer that now works holds", () => {
    const log = [w(0, "bench", [10, 7], 235, { rest: 210 }), w(2, "bench", [10, 7], 235, { rest: 210 }), w(4, "bench", [10, 10], 235, { rest: 210 })];
    assert.deepStrictEqual(restAdapt(ex.heavy, log, {})?.rest_s, 210, "3:55 is within the 3:30 timer it ran (+30 s), not within the 3:00 default: judged by what ran — and one step, never more");
  });
}

console.log(`\n${pass} response test(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
