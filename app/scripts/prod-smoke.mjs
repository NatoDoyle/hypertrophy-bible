#!/usr/bin/env node
// The prod smoke, as a script rather than a habit.
//
// Why this file exists: `/api/onboard` is the ONLY thing that creates a user row,
// and it is also what every prod smoke has always called — by hand, in a curl. So
// the app's own activation denominator has been quietly accumulating the loop's
// own traffic for ~40 waves, and the `smoke` tag added to fix that had **no
// caller**: a mechanism with no producer, which would have reported 0 forever
// while the contamination continued (lesson 15, and lesson 48's "measure the
// mouth of the funnel" pointed at ourselves).
//
// Running the smoke through here means every row it creates is tagged and leaves
// the activation rate alone. Read-only by default; `--onboard` opts into the one
// check that writes.
//
//   STATS_KEY=… node app/scripts/prod-smoke.mjs [--onboard] [--base https://…]
const args = process.argv.slice(2);
const BASE = (args.includes("--base") ? args[args.indexOf("--base") + 1] : null) ?? "https://hypertrophybible.com";
const KEY = process.env.STATS_KEY ?? "";
const bust = () => `nocache=${Math.floor(Date.now() / 1000)}`;
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name + (extra ? `   [${extra}]` : ""))); };

const shellVersion = async (origin) => {
  const r = await fetch(`${origin}/sw.js?${bust()}`);
  return (await r.text()).match(/const VERSION = "([^"]+)"/)?.[1] ?? null;
};

console.log(`prod smoke → ${BASE}`);
const root = await fetch(`${BASE}/?${bust()}`);
ok("the app serves", root.status === 200, `status ${root.status}`);

const v = await shellVersion(BASE);
ok("sw.js reports a shell version", !!v, String(v));
console.log(`    shell: ${v}`);

// NEITHER hostname is an uncached origin. This check used to compare the custom
// domain against workers.dev and call agreement proof of a good deploy — but
// workers.dev answers `cf-cache-status: HIT` too, so both can be stale together,
// and a cache-busting query does not bypass it. Measured: a deploy whose assets had
// uploaded still served the previous shell version on BOTH hostnames for over a
// minute, which read as a failed deploy and is not one.
//
// So the honest check is over TIME, not across hostnames: if an expected version is
// given, poll for it and only fail when it never arrives. Without one, just report
// what is being served and say the two hostnames agree — which is worth knowing,
// but is not evidence about the origin.
const EXPECT = args.includes("--expect") ? args[args.indexOf("--expect") + 1] : null;
if (EXPECT) {
  let seen = v, waited = 0;
  while (seen !== EXPECT && waited < 180) {
    await new Promise((r) => setTimeout(r, 15000));
    waited += 15;
    seen = await shellVersion(BASE);
  }
  ok(`the deployed shell reaches ${EXPECT} at the edge`, seen === EXPECT, `saw ${seen} after ${waited}s`);
} else if (BASE.includes("hypertrophybible.com")) {
  const originV = await shellVersion("https://hypertrophy-bible.nathan-doyle1.workers.dev");
  ok("both hostnames serve the same shell (NOT proof of the origin — both are cached)", originV === v, `workers.dev ${originV} vs custom ${v}`);
}

const today = await fetch(`${BASE}/api/today`);
ok("/api/today rejects an unidentified caller cleanly (400, not 500)", today.status === 400, `status ${today.status}`);

const ex = await fetch(`${BASE}/api/exercise/lat-pulldown`);
ok("/api/exercise serves the library unfiltered", ex.status === 200, `status ${ex.status}`);

if (KEY) {
  const s = await fetch(`${BASE}/api/stats`, { headers: { "X-HB-Stats-Key": KEY } });
  ok("/api/stats answers the owner key", s.status === 200, `status ${s.status}`);
  if (s.status === 200) {
    const st = await s.json();
    console.log("\n  stats:");
    for (const [k, val] of Object.entries(st)) console.log(`    ${k.padEnd(34)} ${JSON.stringify(val)}`);
  }
} else {
  console.log("  – /api/stats skipped (no STATS_KEY in env) — the numbers, not the smoke, are what it would show");
}

if (args.includes("--onboard")) {
  if (!KEY) { console.log("  ✗ --onboard needs STATS_KEY, or the row would pollute the activation rate"); fail++; }
  else {
    const r = await fetch(`${BASE}/api/onboard`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-HB-Stats-Key": KEY },
      body: JSON.stringify({ profile: {
        units: "metric", training_status: "intermediate", primary_goal: "hypertrophy",
        days_per_week: 3, session_length_min: 60, available_equipment: ["barbell", "dumbbell", "machine", "cable", "bodyweight"],
      } }),
    });
    const body = await r.json().catch(() => ({}));
    ok("a TAGGED smoke onboard succeeds", r.status === 200 && !!body.user_id);
    // Prove the tag took, or the row is indistinguishable from a real user and we
    // have just made the very problem this script exists to stop.
    const after = await (await fetch(`${BASE}/api/stats`, { headers: { "X-HB-Stats-Key": KEY } })).json();
    ok("...and it is counted as SMOKE, not as a real user", after.smoke_users >= 1, `smoke_users=${after.smoke_users}`);
  }
}

console.log(`\n${pass} smoke check(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
process.exit(fail ? 1 : 0);
