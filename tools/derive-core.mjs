// Pure derive-metrics core (NO fs) — the single source of truth for the derivation logic,
// shared by tools/derive-metrics.mjs (adds fs loaders + CLI) and app/ (portable to Cloudflare Workers).

// ---------------------------------------------------------------------------
// Core derivations
// ---------------------------------------------------------------------------

// Estimated 1RM (Epley). Reliability drops as reps rise, so we flag it.
export function estimate1RM(weightKg, reps) {
  if (reps <= 0 || weightKg <= 0) return { e1rm: 0, confidence: "none" };
  const e1rm = reps === 1 ? weightKg : weightKg * (1 + reps / 30);
  // Epley's error grows past ~5-6 reps (at 10 reps the estimate is already a 33%
  // extrapolation above the load lifted), so the "high" band is honest only up to
  // ~6. Labels only — e1rm values and countsForE1RM (RELIABLE_1RM_REPS=12) unchanged.
  const confidence = reps <= 6 ? "high" : reps <= 10 ? "moderate" : "low";
  return { e1rm: Math.round(e1rm * 100) / 100, confidence };
}

// Above this rep count the Epley estimate is guesswork: a deliberately light
// 20-rep back-off set "beats" a genuinely heavier triple. Anything that reports
// strength (PRs, progression trends) MUST filter through countsForE1RM so the
// surfaces can never disagree — this constant is the single source of truth.
export const RELIABLE_1RM_REPS = 12;
export const countsForE1RM = (set) =>
  (set.set_type ?? "work") !== "warmup" &&
  typeof set.reps === "number" && set.reps > 0 && set.reps <= RELIABLE_1RM_REPS &&
  typeof set.weight_kg === "number" && set.weight_kg > 0;

// Higher-rep hypertrophy work (reps > RELIABLE_1RM_REPS, where Epley is guesswork) is
// tracked by top LOAD instead of estimated 1RM. Module-scoped (not just local to
// detectPersonalRecords) so priorPersonalBests and detectPersonalRecords can never
// apply different rules for what counts as "load" work.
const isLoadSet = (set) =>
  (set.set_type ?? "work") !== "warmup" &&
  typeof set.reps === "number" && set.reps > RELIABLE_1RM_REPS &&
  typeof set.weight_kg === "number" && set.weight_kg > 0;

// XP awarded for a single personal record — the peak-achievement bonus on top of the
// base session/hard-set XP. Lives here (with detectPersonalRecords) as the single source
// of truth so the gamification engine (xpAndLevel) and the recap's "+N XP" reward can
// never disagree about what a PR is worth.
export const PR_XP = 50;

// All-time best e1RM / top LOAD per exercise across a history of sessions. The single
// ceiling computation both detectPersonalRecords (end-of-session recap) and
// checkSetPR (live, mid-session) read — so "what's your prior best" can never differ
// between the two celebration surfaces.
export function priorPersonalBests(sessions) {
  const e1rm = {}, load = {};
  for (const s of sessions) for (const set of s.sets ?? []) {
    if (set.deload) continue; // planned-easy sets can't anchor a real ceiling (mirrors stallDetect/progressionByExercise)
    if (countsForE1RM(set)) {
      const { e1rm: v } = estimate1RM(set.weight_kg, set.reps);
      if (v > (e1rm[set.exercise] ?? 0)) e1rm[set.exercise] = v;
    } else if (isLoadSet(set)) {
      if (set.weight_kg > (load[set.exercise] ?? 0)) load[set.exercise] = set.weight_kg;
    }
  }
  return { e1rm, load };
}

// Personal records set IN a session — the reward the app celebrates after a workout.
// Mirrors the est-1RM / load split used everywhere else (countsForE1RM + RELIABLE_1RM_REPS
// as the single source of truth) so a celebrated PR can NEVER contradict the progression
// trend (lesson: surfaces must agree). Two bands:
//   • e1rm PR — for heavy work (reps <= RELIABLE_1RM_REPS): a new all-time-best estimated
//     1RM, requiring a >0.5 kg margin so estimator noise isn't dressed up as a record.
//   • load PR — for higher-rep hypertrophy work (reps > RELIABLE_1RM_REPS, where Epley is
//     guesswork): a new all-time-best top LOAD at that rep range. This is the large class
//     of pump-band work the e1rm-only check silently ignored — a 15-rep leg curl or lateral
//     raise could beat its best weight forever and be told nothing.
// A first-EVER performance is not a PR (no prior best to beat) — the caller frames "first
// time" separately if it wants. `priorSessions` = every session before the one checked.
// Warm-ups never count. A deload is intentionally light on WEIGHT only — Epley still
// rewards reps, so an eased-weight set logged at the top of its rep range can out-score
// a true heavy best (e.g. 90kg x10 deload vs a real 100kg x5 top set: e1rm 120 > 116.67).
// Deload sets are excluded explicitly, mirroring stallDetect/progressionByExercise (which
// already skip them via `if (set.deload) continue`) rather than trusting the math alone.
// Pure and deterministic (no Date.now/Math.random).
export function detectPersonalRecords(session, priorSessions = []) {
  const { e1rm: priorE1rm, load: priorLoad } = priorPersonalBests(priorSessions);
  // Best in the just-logged session per exercise.
  const newE1rm = {}, newLoad = {};
  for (const set of session.sets ?? []) {
    if (set.deload) continue;
    if (countsForE1RM(set)) {
      const { e1rm } = estimate1RM(set.weight_kg, set.reps);
      const cur = newE1rm[set.exercise];
      if (!cur || e1rm > cur.e1rm) newE1rm[set.exercise] = { e1rm, weight_kg: set.weight_kg, reps: set.reps };
    } else if (isLoadSet(set)) {
      const cur = newLoad[set.exercise];
      if (!cur || set.weight_kg > cur.load) newLoad[set.exercise] = { load: set.weight_kg, reps: set.reps };
    }
  }
  const prs = [];
  for (const [ex, cur] of Object.entries(newE1rm)) {
    const prev = priorE1rm[ex];
    if (prev != null && cur.e1rm - prev > 0.5) {
      prs.push({ exercise: ex, kind: "e1rm", e1rm_kg: cur.e1rm, prev_kg: prev, delta_kg: Math.round((cur.e1rm - prev) * 10) / 10, weight_kg: cur.weight_kg, reps: cur.reps });
    }
  }
  for (const [ex, cur] of Object.entries(newLoad)) {
    const prev = priorLoad[ex];
    if (prev != null && cur.load > prev) {
      prs.push({ exercise: ex, kind: "load", load_kg: cur.load, prev_kg: prev, reps: cur.reps });
    }
  }
  return prs;
}

// Would logging THIS ONE set, right now, beat the user's prior all-time best for its
// exercise? The live in-player celebration's source of truth (roadmap #1 slice b) — same
// rules and thresholds as detectPersonalRecords (countsForE1RM/isLoadSet, the >0.5kg
// e1rm noise margin), so a mid-session "🎉" can never fire for a set the end-of-session
// recap wouldn't also celebrate. `priorBests` is priorPersonalBests(sessions-before-today).
export function checkSetPR(set, priorBests) {
  if (set.deload) return null; // a planned-easy set never celebrates (see detectPersonalRecords)
  if (countsForE1RM(set)) {
    const { e1rm } = estimate1RM(set.weight_kg, set.reps);
    const prev = priorBests.e1rm[set.exercise];
    if (prev != null && e1rm - prev > 0.5) {
      return { kind: "e1rm", e1rm_kg: e1rm, delta_kg: Math.round((e1rm - prev) * 10) / 10 };
    }
    return null;
  }
  if (isLoadSet(set)) {
    const prev = priorBests.load[set.exercise];
    if (prev != null && set.weight_kg > prev) return { kind: "load", load_kg: set.weight_kg, reps: set.reps };
  }
  return null;
}

// The user's full personal-record HISTORY — every PR across all sessions, most-recent
// first, each stamped with the session's date. Replays detectPersonalRecords
// chronologically (each session judged only against what came before it), so this lookback
// feed can never disagree with the per-session recap or the XP bonus. Powers the Progress
// tab's "wins" surface (roadmap #1c — progress-dopamine). Pure/deterministic.
export function allPersonalRecords(sessions) {
  const chron = [...(sessions ?? [])].sort((a, b) => ((a.local_date ?? a.date ?? "") < (b.local_date ?? b.date ?? "") ? -1 : 1));
  const out = [];
  for (let i = 0; i < chron.length; i++) {
    const date = chron[i].local_date ?? chron[i].date ?? null;
    for (const pr of detectPersonalRecords(chron[i], chron.slice(0, i))) out.push({ ...pr, date });
  }
  return out.reverse();
}

// XP awarded for a "lucky set" — a small bonus that lands on an UNPREDICTABLE
// subset of hard sets, on top of the fixed 5 XP/hard-set + PR bonuses. A fully
// predictable reward schedule (100/session + 5/hard-set) is the weakest habit
// driver there is; a variable-ratio schedule (slot-machine mechanics — you never
// know which set pays extra) is the strongest, precisely because it can't be
// anticipated. Lives here as the single source of truth for both the gamification
// engine (xpAndLevel) and the recap so the reward and its XP total never disagree.
export const LUCKY_SET_XP = 15;
// ~1-in-8 (12.5%) of hard sets are lucky — frequent enough to feel real, rare
// enough to stay a surprise rather than an expectation.
const LUCKY_SET_ONE_IN = 8;

// Deterministic (no Math.random — this file must stay pure/replayable) yet
// unpredictable-to-the-user: hashes the session's own random session_id (assigned
// client-side at session start, never shown to the user) together with the
// exercise and this set's position among that exercise's hard sets THIS session.
// Reproducible everywhere (live in-player toast, end-of-session recap, the XP
// total) without ever storing a "was this lucky" flag, so replays can never drift.
export function isLuckySet(sessionId, exercise, hardSetIndex) {
  if (!sessionId) return false; // no session id (e.g. a synthetic/legacy fixture) -> never lucky
  const key = `${sessionId}|${exercise}|${hardSetIndex}`;
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % LUCKY_SET_ONE_IN === 0;
}

// Every lucky set logged IN a session — replays isHardSet + isLuckySet over
// session.sets in array order (the same order they were logged), so the count can
// never disagree between the live player and the recap/XP engine.
export function luckySetsInSession(session) {
  const seen = {};
  const hits = [];
  for (const set of session.sets ?? []) {
    if (!isHardSet(set)) continue;
    const idx = seen[set.exercise] ?? 0;
    seen[set.exercise] = idx + 1;
    if (isLuckySet(session.session_id, set.exercise, idx)) hits.push({ exercise: set.exercise, index: idx });
  }
  return hits;
}

// ISO week key "YYYY-Www" for grouping weekly volume.
export function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// isoWeekKey of a raw instant, localized by tzOffsetMin (minutes EAST of UTC,
// the same convention as push.mjs's isUserPushHour/isSocialPushQuietHours and
// coach.mjs's taperPhase) before reading its calendar week — shifting the
// instant by the offset and then reading its UTC fields is the same "treat the
// shifted instant's UTC fields as local fields" trick those functions already
// use. Without this, a raw `isoWeekKey(now)` reads the ISO week of the SERVER's
// UTC instant, which can already be the next calendar week while it's still the
// previous day for anyone west of UTC (any offset <= -1 crossing a week
// boundary) — the 1v1 weekly challenge feature (#10 social) stamps and checks
// its `week` this way and needs the user's own local week, not the server's.
// Missing/unknown tzOffsetMin falls back to raw UTC (same "don't starve a
// result over missing data" choice those sibling functions make).
export function isoWeekKeyLocal(now, tzOffsetMin) {
  return isoWeekKey(+new Date(now) + (Number.isFinite(tzOffsetMin) ? tzOffsetMin * 60000 : 0));
}

// A session's week key, preferring the device's local calendar day but falling
// back to the UTC `date` if local_date is malformed (an "NaN-WNaN" key sorts
// after every real ISO week and would hijack the "latest week" logic — and a
// bad string can arrive from any client, since auth is possession-of-UUID).
export const sessionWeekKey = (s) => {
  const k = isoWeekKey(s.local_date ?? s.date);
  return k.includes("NaN") ? isoWeekKey(s.date) : k;
};

// TRAINED WEEKS INSIDE THE CURRENT BLOCK — the mesocycle's clock.
//
// It used to be wall-clock: `floor((now - block_start) / 42 days)`. So a user who
// trained twice in six weeks still got "Week 6 — deload", and someone back from a
// five-week layoff could land on "peak volume — push hard" the same day
// suggestWeight eased their loads 12% for a comeback. `POST /api/pause` froze the
// streak and the nudge emails but not this, so a deliberately paused user's block
// kept advancing through phases they never trained.
//
// Counting TRAINED weeks makes the block mean what it says: six weeks of work, not
// six weeks of calendar. A consistent lifter is completely unaffected (train any
// week and it advances one week, exactly as before) — only a sporadic one differs,
// which is the entire point. Derived from sessions the store already has, so there
// is no new persisted state and no migration.
//
// Weeks STRICTLY BEFORE the current one, so the week in progress isn't counted as
// finished the moment its first session lands: train on Monday of block-week 1 and
// you are still in week 1 on Wednesday, with the rest of that week's work ahead.
export function trainedWeeksInBlock(sessions, blockStartISO, nowISO) {
  if (!blockStartISO || !nowISO) return 0;
  const startMs = +new Date(blockStartISO);
  if (!Number.isFinite(startMs)) return 0;
  const nowWeek = isoWeekKey(nowISO);
  const weeks = new Set();
  for (const s of sessions ?? []) {
    if (!(s.sets ?? []).length) continue;              // an emptied/voided session isn't a trained week
    const when = +new Date(s.local_date ?? s.date);
    if (!Number.isFinite(when) || when < startMs) continue;
    const wk = sessionWeekKey(s);
    if (wk !== nowWeek) weeks.add(wk);
  }
  return weeks.size;
}

// TRAINING-AGE GRADUATION. `training_status` was captured once at onboarding and
// then never changed by anything — so a user who joined as a beginner and has
// trained hard for eighteen months was STILL being fed beginner volume (mev.min),
// a 12-set session cap, 3-set compounds, and a plan that had literally never
// changed: beginners are exempt from the mesocycle wave (so, no deload EVER), the
// block-boundary accessory rotation, the volume auto-tune, DUP, and the taper.
// Goal 2's "never heard of a gym -> Mr. Olympia" arc was failing at its very first
// transition, silently, for exactly the users who'd earned the next step.
//
// Training status is TRAINING AGE, so this reads time-under-the-bar and nothing
// else. Deliberately NOT gated on progress: training age isn't a reward for
// results, and gating it that way would withhold the mesocycle wave and the volume
// tune from a stalled lifter — precisely the person those tools exist for.
//
// Weeks are DISTINCT TRAINED weeks, not calendar weeks since signup: six months of
// showing up twice a week is a training history; six months of one session in
// January is not. Sessions are counted too, so a single set on 26 scattered
// Mondays can't graduate anyone.
//
// The thresholds are practice-based (KB training-status.md grades its own bands
// B/D — "beginner 0-1yr, intermediate 1-3yr, advanced 3+yr" — and we only know the
// training the user has logged WITH US, on top of whatever they declared). They
// are set conservatively: promoting late costs a user some tools, promoting early
// hands a novice a program they can't recover from.
export const GRADUATION = {
  // ~6 months of twice-a-week training, on top of a declared "0-1 years".
  intermediate: { weeks: 26, sessions: 40 },
  // ~2.5 years more, on top of a declared "1-3 years" -> comfortably past 3.
  advanced: { weeks: 130, sessions: 250 },
};
const STATUS_RANK = { beginner: 0, intermediate: 1, advanced: 2 };

// The status this person's logged history has earned, or null if it's unchanged.
// PROMOTES ONLY — never demotes. A layoff, an injury, or a quiet month must never
// take tools away from someone who has already earned them, and a user who
// declared a status above their logged history keeps it (they told us their real
// training age; our log only knows the part that happened here).
export function graduatedStatus(sessions, currentStatus) {
  const cur = STATUS_RANK[currentStatus] ?? 0;
  if (cur >= STATUS_RANK.advanced) return null;
  const real = (sessions ?? []).filter((s) => (s.sets ?? []).length > 0);
  const weeks = new Set(real.map(sessionWeekKey)).size;
  const earned = weeks >= GRADUATION.advanced.weeks && real.length >= GRADUATION.advanced.sessions ? "advanced"
    : weeks >= GRADUATION.intermediate.weeks && real.length >= GRADUATION.intermediate.sessions ? "intermediate"
    : null;
  if (!earned || STATUS_RANK[earned] <= cur) return null;
  return earned;
}

// Weekday keys for the weekly training-commitment device (Mon-first, matching
// isoWeekKey's ISO convention) — the single source of truth so the API's
// day-name validation and the push sweep's "is today a committed day" check
// can never disagree on what a valid day key is.
export const WEEK_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const weekDayKey = (dateStr) => WEEK_DAY_KEYS[(new Date(dateStr).getUTCDay() + 6) % 7];

// Is a set a "hard working set" that counts toward hypertrophy volume?
// Warm-ups never count. If effort is logged, it must be near failure (RPE>=gate / RIR<=4).
// If effort is NOT logged, a work set counts (we don't penalize missing data).
export function isHardSet(set, { hardSetRpe = 7 } = {}) {
  const type = set.set_type ?? "work";
  if (type === "warmup") return false;
  if (typeof set.rpe === "number" && set.rpe < hardSetRpe) return false;
  if (typeof set.rir === "number" && set.rir > 4) return false;
  return true;
}

// Per-muscle effective weekly volume (hard sets). Primary muscle = 1.0 set,
// secondary = fractional (default 0.5). This is THE model's currency.
export function perMuscleWeeklyVolume(sessions, exIndex, opts = {}) {
  const secondaryWeight = opts.secondaryWeight ?? 0.5;
  const weeks = {};
  for (const s of sessions) {
    const wk = sessionWeekKey(s);
    weeks[wk] ??= {};
    for (const set of s.sets ?? []) {
      if (!isHardSet(set, opts)) continue;
      const ex = exIndex.get(set.exercise);
      if (!ex) continue; // unknown/custom exercise: skip rather than guess
      for (const m of ex.primary) weeks[wk][m] = (weeks[wk][m] ?? 0) + 1;
      for (const m of ex.secondary) weeks[wk][m] = (weeks[wk][m] ?? 0) + secondaryWeight;
    }
  }
  // round fractional sums to 1dp
  for (const wk of Object.keys(weeks))
    for (const m of Object.keys(weeks[wk]))
      weeks[wk][m] = Math.round(weeks[wk][m] * 10) / 10;
  return weeks;
}

// Compare a week's per-muscle volume against the KB's MEV/MAV/MRV landmarks.
// This is the loop that ties raw logs back to the graded knowledge base.
export function volumeVsLandmarks(weekVolume, muscleIndex) {
  const out = {};
  for (const [muscle, sets] of Object.entries(weekVolume)) {
    const lm = muscleIndex.get(muscle);
    if (!lm) { out[muscle] = { sets, status: "no-landmark" }; continue; }
    const mevMin = lm.mev?.min, mavMax = lm.mav?.max, mrvMax = lm.mrv?.max;
    let status;
    if (mevMin != null && sets < mevMin) status = "below-MEV";
    else if (mrvMax != null && sets > mrvMax) status = "over-MRV";
    else if (mavMax != null && sets > mavMax) status = "approaching-MRV";
    else status = "in-productive-range";
    out[muscle] = { sets, status, mev: lm.mev, mav: lm.mav, mrv: lm.mrv };
  }
  return out;
}

// THE KB EFFORT TABLE'S THREE ROWS (proximity-to-failure page), keyed off exercise
// metadata. Moved here from plan-core (which imports it back) so the prescription
// and the effort lever below can never disagree about an exercise's target band.
// `stability: "high"` resolves to exactly the leg presses, hack squats, machine
// presses and chest-supported rows the KB page names; the `cns_cost` half keeps a
// stable-but-systemically-heavy machine on the conservative heavy reserve.
export const supportedCompound = (ex) =>
  ex?.mechanic === "compound" && ex?.stability === "high" && ex?.cns_cost !== "high";
// Band TOP (the target the effort lever measures surplus against): heavy compound 3
// ("1-3"), supported/stable compound 2 ("0-2"), isolation 1 ("0-1"). Unknown
// metadata (custom exercises never carry `stability`) → 3, the most conservative
// tier: the hardest for the lever to call "too easy".
export const effortBandTop = (ex) =>
  ex?.mechanic === "isolation" ? 1 : supportedCompound(ex) ? 2 : 3;

// EFFORT READ (Increment C). Per primary muscle, over the last `recentWeeks`
// DISTINCT trained weeks present in the data (the same window computeVolumeAdjust
// samples peak volume over; no Date.now — deterministic), the average LOGGED rir
// surplus above each set's exercise-tier band top. POSITIVE EVIDENCE ONLY: a muscle
// appears in the result only when effort was actually logged, and absent data
// returns {} so every caller behaves byte-identically to before — the recorded
// Increment-C deferral rationale (docs/adaptive-algorithm.md): gating volume on
// ambiguous/absent effort would wrongly withhold sets from a disciplined lifter.
// Deload/eased sets are excluded (an easy band is PRESCRIBED there — compliance,
// not sandbagging), warm-ups excluded, non-numeric rir ignored. Known conservatism:
// the tier top is static metadata while waveRir tightens the prescribed band in
// peak weeks, so the lever under-fires slightly during peaks — the safe direction
// for a hold-volume lever. `minSurplus` is deliberately the same +1 distance
// suggestWeight uses for its own load bump, so the two effort surfaces share one
// definition of "more in the tank than asked". `byId` is the full exercise map
// (mechanic/stability/cns_cost + primary_muscles), the same shape plan-core uses.
export function effortSignal(sessions, byId, { recentWeeks = 6, minSets = 10, minSurplus = 1 } = {}) {
  const weeks = new Set();
  for (const s of sessions ?? []) if ((s.sets ?? []).length) weeks.add(sessionWeekKey(s));
  const recent = new Set([...weeks].sort().slice(-recentWeeks));
  const acc = {};
  for (const s of sessions ?? []) {
    if (!(s.sets ?? []).length || !recent.has(sessionWeekKey(s))) continue;
    for (const set of s.sets) {
      if ((set.set_type ?? "work") === "warmup" || set.deload) continue;
      if (typeof set.rir !== "number" || !Number.isFinite(set.rir)) continue;
      const ex = byId.get(set.exercise);
      if (!ex) continue; // unknown exercise: skip rather than guess
      const surplus = set.rir - effortBandTop(ex);
      for (const m of ex.primary_muscles ?? []) {
        acc[m] ??= { n: 0, rirSum: 0, surplusSum: 0 };
        acc[m].n += 1;
        acc[m].rirSum += set.rir;
        acc[m].surplusSum += surplus;
      }
    }
  }
  const out = {};
  for (const [m, a] of Object.entries(acc)) {
    const avg_rir = Math.round((a.rirSum / a.n) * 10) / 10;
    const avg_surplus = Math.round((a.surplusSum / a.n) * 10) / 10;
    out[m] = { n: a.n, avg_rir, avg_surplus, too_easy: a.n >= minSets && avg_surplus >= minSurplus };
  }
  return out;
}

// ADAPTIVE VOLUME RESPONSE — the foundation of the self-learning plan. For each
// trained muscle it combines the user's CURRENT weekly volume (vs the KB MEV/MAV/MRV
// landmarks) with whether a lift for that muscle has STALLED, into an honest,
// data-driven "do you need more/less volume here?" signal. Two hard safety rails:
// (1) it is COACHING ONLY — the caller surfaces it as advice and never auto-applies
// it silently; (2) every suggestion is bounded by the recoverable range — it never
// pushes a target above MAV.max, and once a muscle is stalled AT its ceiling it says
// "change/deload", not "add more", so volume can never run away.
// `weekVolume` is { muscleId: sets } (effective sets); `stalledMuscleIds` is the set
// of muscle ids whose primary lift stallDetect flagged. `tooEasyMuscleIds` (Increment
// C) marks muscles whose LOGGED effort sits clearly above the KB target — a stall
// there gets "push closer to failure" BEFORE "add sets" (the KB's own lever order:
// volume → effort → deload → variation, judged per lever). Returns one entry per muscle.
export function volumeResponse(weekVolume, muscleIndex, stalledMuscleIds = new Set(), tooEasyMuscleIds = new Set()) {
  const out = [];
  for (const [m, sets] of Object.entries(weekVolume)) {
    const lm = muscleIndex.get(m);
    if (!lm || lm.mev?.min == null || lm.mav?.max == null || lm.mrv?.max == null) continue;
    const mevMin = lm.mev.min, mavMax = lm.mav.max, mrvMax = lm.mrv.max;
    const stalled = stalledMuscleIds.has(m);
    let signal, advice;
    if (sets < mevMin) {
      signal = "add";
      advice = `only ~${sets} sets/wk — below the ~${mevMin} it needs to grow. Add sets.`;
    } else if (sets > mrvMax) {
      signal = "reduce";
      advice = `~${sets} sets/wk is above your recoverable ceiling (~${mrvMax}) — trim a set or two.`;
    } else if (stalled && sets < mavMax && tooEasyMuscleIds.has(m)) {
      signal = "effort";
      advice = `progress has stalled, but your logged effort says you're stopping well short of failure — take your last sets closer (~1-2 reps in reserve) before adding volume.`;
    } else if (stalled && sets < mavMax) {
      signal = "add";
      advice = `progress has stalled and you're at ~${sets} of a possible ${mavMax} productive sets — try adding ~2 sets here.`;
    } else if (stalled) {
      signal = "change";
      advice = `stalled near your recoverable ceiling (~${mrvMax}) — a deload or a different exercise will help more than piling on volume.`;
    } else {
      signal = "hold";
      advice = `~${sets} sets/wk, progressing in a productive range — hold here.`;
    }
    out.push({ muscle: m, sets, signal, advice });
  }
  // Surface the actionable ones first (reduce/change/effort/add before hold).
  const rank = { reduce: 0, change: 1, effort: 2, add: 3, hold: 4 };
  return out.sort((a, b) => (rank[a.signal] - rank[b.signal]) || (b.sets - a.sets));
}

// AUTO-TUNE: turn the per-muscle response into a persistent volume ADJUSTMENT the
// plan applies next block. This is the actual "learn from the data it's fed" step
// (#2): a muscle that keeps stalling with headroom gets more sets over time; one
// stalled at its recoverable ceiling (or over it) gets eased. Gentle and bounded:
// ±2 sets per block, ACCUMULATED across blocks (so a persistent responder keeps
// climbing until it responds or hits the ceiling), and each muscle's total delta is
// clamped to its own MEV↔MRV range so volume can never run away. Below-MEV is NOT a
// response signal (it's a plan-fit/time constraint, surfaced as a warning), so it
// never drives an adjustment. `prevAdjust` is the accumulated map so far (or {}).
// `context` (Increment A) carries a recovery/energy read: `{ underRecovered,
// inDeficit }`, plus two per-muscle Sets: `regressingMuscleIds` (Wave 166) and
// `tooEasyMuscleIds` (Increment C — effortSignal's too-easy muscles, which hold
// instead of adding because the fix is effort, not sets).
// A stall while persistently under-recovered or in an energy deficit
// is a recovery/fuel problem, not a volume one — adding sets you can't recover makes
// it worse — so the "add volume" response is SUPPRESSED then (the muscle holds).
// Easing (over-ceiling, stalled-at-ceiling) always still fires: pulling back is safe
// regardless of recovery. Absent context → permissive (add allowed), so existing
// callers/behaviour are unchanged. See docs/adaptive-algorithm.md.
export function deriveVolumeAdjust(prevAdjust, weekVolume, muscleIndex, stalledMuscleIds = new Set(), context = {}) {
  const out = { ...(prevAdjust || {}) };
  const canAdd = !(context.underRecovered || context.inDeficit);
  // A muscle whose lifts are going BACKWARDS never gets more volume, whatever the
  // recovery read says. This gate is PER-MUSCLE rather than global (unlike the
  // recovery/energy one, which is a whole-athlete state): a regressing chest must
  // not be given more sets while a fine back legitimately still can be.
  const regressing = context.regressingMuscleIds ?? new Set();
  // Increment C: a muscle whose LOGGED effort sits clearly above the KB target is
  // stalling because the sets are too easy, not too few — adding volume to a
  // sandbagged stall wastes recovery on more easy sets. Hold instead; the plateau
  // card says "push closer to failure". Per-muscle, positive-evidence-only (an
  // empty set here leaves every path byte-identical).
  const tooEasy = context.tooEasyMuscleIds ?? new Set();
  for (const [m, sets] of Object.entries(weekVolume || {})) {
    const lm = muscleIndex.get(m);
    if (!lm || lm.mev?.min == null || lm.mav?.max == null || lm.mrv?.max == null) continue;
    const mayAdd = canAdd && !regressing.has(m) && !tooEasy.has(m);
    let step = 0;
    if (sets > lm.mrv.max) step = -2;                                              // over the ceiling → ease
    else if (stalledMuscleIds.has(m)) step = sets < lm.mav.max ? (mayAdd ? 2 : 0) : -2; // stalled: add if room AND recovered AND not declining AND not too-easy, else hold/ease
    // not stalled and within range → progressing fine → hold (no change)
    const prev = prevAdjust?.[m] ?? 0;
    const range = lm.mrv.max - lm.mev.min;
    const next = Math.max(-range, Math.min(range, prev + step));
    if (next === 0) delete out[m]; else out[m] = next;
  }
  return out;
}

// Block-level recovery read for the auto-tune. Manual check-ins score 1-5 on
// sleep_quality/energy/mood/motivation and stress (inverted, so a calm 1 → 5). The
// block AVERAGE sitting below the neutral midpoint — with enough check-ins that it's
// a real trend, not one bad night — means recovery, not volume, is the limiter.
// Energy deficit is read from the bodyweight trend (a precomputed classifyEnergyBalance
// object). Both gate "add volume" in deriveVolumeAdjust. Pure: everything is passed in
// as data (no fs, no Date.now). Absent/insufficient data → not-under-recovered (the
// tune stays as capable as before; recovery only ever RESTRAINS adding, never forces).
export function recoverySignal(checkins = [], energyBalance = null, { minCheckins = 4, lowThreshold = 2.6 } = {}) {
  const scores = [];
  for (const c of checkins || []) {
    const parts = [];
    if (typeof c.sleep_quality === "number") parts.push(c.sleep_quality);
    if (typeof c.energy === "number") parts.push(c.energy);
    if (typeof c.mood === "number") parts.push(c.mood);
    if (typeof c.motivation === "number") parts.push(c.motivation);
    if (typeof c.stress === "number") parts.push(6 - c.stress); // low stress = high recovery
    if (parts.length) scores.push(parts.reduce((a, b) => a + b, 0) / parts.length);
  }
  const n = scores.length;
  const avgReadiness = n ? Math.round((scores.reduce((a, b) => a + b, 0) / n) * 100) / 100 : null;
  const underRecovered = n >= minCheckins && avgReadiness != null && avgReadiness <= lowThreshold;
  const inDeficit = energyBalance?.direction === "deficit";
  return { underRecovered, inDeficit, avgReadiness, n };
}

// Which muscles make an exercise "lower-body" for the concurrent-training read.
// spinal-erectors and abs are deliberately absent: both are loaded by upper- AND
// lower-body work, so they can't discriminate between the two halves.
export const LOWER_BODY_MUSCLES = new Set(["quadriceps", "hamstrings", "glutes", "calves"]);
const LOWER_BODY_INJURY_REGIONS = new Set(["knee", "hip", "ankle", "lower-back"]);

// CONCURRENT-INTERFERENCE PATTERN. The classic fingerprint of a cardio load
// competing for leg recovery is ASYMMETRY: lower-body lifts flat while the upper
// body keeps climbing. A systemic cause (sleep, stress, under-eating) stalls
// everything; too much lifting volume stalls the muscle it's aimed at. So the read
// is only honest when the legs are stalled INSIDE their productive volume range —
// otherwise volumeResponse already owns the story and the two surfaces would
// contradict each other. See content/03-programming/cardio-and-concurrent-training.md.
//
// HONESTY BOUND, non-negotiable: the app has never observed the user's cardio. This
// detects a PATTERN and names cardio as one candidate cause; it must never assert
// causation. The copy therefore states only what was measured, and offers the
// non-cardio explanation in the same breath.
//
// Pure: consumes already-derived inputs (the SAME `stalls` array the plateau card
// renders, so the two can never name different lifts). Returns null — the common
// case — unless every gate holds. `guideline` is the data/guidelines node, so the
// prescribed test is single-sourced with the KB rather than restated here.
export function interferenceSignal(
  { stalls = [], progression = [], weekVolume = null, energyBalance = null, recovery = null, goal = null, injuries = [] },
  exIndex, muscleIndex, guideline = null,
  { minLowerStalled = 2, minUpperProgressing = 2, minProgressWeeks = 3, noisePct = 2.5 } = {},
) {
  // On fat-loss the deficit is deliberate and cardio is prescribed — flagging
  // "interference" there would contradict the app's own advice.
  if (goal !== "hypertrophy" && goal !== "strength") return null;
  // A stalled squat while managing a knee is likelier the knee, and cardio-framed
  // copy would read tone-deaf.
  for (const inj of injuries || []) {
    const region = typeof inj === "string" ? inj : inj?.region;
    if (region && LOWER_BODY_INJURY_REGIONS.has(region)) return null;
  }

  const half = (exId) => {
    const primary = exIndex.get(exId)?.primary ?? [];
    if (!primary.length) return null; // unknown/custom exercise: can't place it, don't guess
    return primary.some((m) => LOWER_BODY_MUSCLES.has(m)) ? "lower" : "upper";
  };

  const stalledLower = (stalls || []).filter((s) => half(s.exercise) === "lower");
  if (stalledLower.length < minLowerStalled) return null;

  // "Progressing" uses the same noise band stallDetect does, so a lift can never be
  // counted as both. One genuinely climbing leg lift falsifies the whole story.
  const stalledIds = new Set((stalls || []).map((s) => s.exercise));
  const progressing = (progression || []).filter(
    (p) => !stalledIds.has(p.exercise) && (p.weeks ?? 0) >= minProgressWeeks && (p.change_pct ?? 0) >= noisePct,
  );
  if (progressing.some((p) => half(p.exercise) === "lower")) return null;
  const upperProgressing = progressing.filter((p) => half(p.exercise) === "upper").length;
  // If the upper body is flat too, the cause is systemic — the plateau card and the
  // recovery gate already own that, and this card stays quiet.
  if (upperProgressing < minUpperProgressing) return null;

  // THE DISCRIMINATOR. Below MEV is under-stimulus ("add"); above MAV is a lifting-
  // volume problem ("reduce"/"change"). Only a stall INSIDE the productive range
  // points outside the gym. No landmark or no volume data → can't rule volume out →
  // stay silent rather than guess.
  let judged = 0;
  for (const s of stalledLower) {
    for (const m of exIndex.get(s.exercise)?.primary ?? []) {
      if (!LOWER_BODY_MUSCLES.has(m)) continue;
      const lm = muscleIndex.get(m);
      const sets = weekVolume?.[m];
      if (!lm || lm.mev?.min == null || lm.mav?.max == null || typeof sets !== "number") continue;
      if (sets < lm.mev.min || sets > lm.mav.max) return null;
      judged++;
    }
  }
  if (!judged) return null;

  // At least one independent read that recovery or fuel is actually short. Without
  // one, "legs flat, upper body fine" is just normal lower-body lumpiness.
  const corroborators = [];
  if (energyBalance?.direction === "deficit") corroborators.push("unintended-deficit");
  if (recovery?.underRecovered) corroborators.push("under-recovered");
  if (!corroborators.length) return null;

  const names = stalledLower.map((s) => s.name);
  const lifts = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const weeksFlat = Math.max(...stalledLower.map((s) => s.weeks_flat ?? 0));
  const alsoSaw = corroborators.includes("unintended-deficit")
    ? "you've been losing weight while training to gain"
    : "your check-ins have been reading low";
  const test = guideline?.scale_back_protocol
    ?? "Halve your structured cardio for two to three weeks and hold everything else constant. If the stalled lifts start moving, cardio load was the limiter.";
  const note = `${lifts} ${names.length === 1 ? "has" : "have"} been flat for about ${weeksFlat} weeks while your upper-body lifts keep climbing, and ${alsoSaw}. `
    + `Your leg volume is inside its productive range, so the plan itself probably isn't the limiter — something outside the gym looks like it's competing for leg recovery or fuel. `
    + `A heavy running or cycling load is one common cause, and it's fixable without giving cardio up. If cardio isn't part of your week, food and sleep are the usual suspects. ${test}`;

  return {
    pattern: "lower-body-stall-asymmetry",
    stalled_lower: stalledLower.map((s) => ({ exercise: s.exercise, name: s.name })),
    upper_progressing: upperProgressing,
    corroborators,
    note,
  };
}

// Bodyweight trend via least-squares regression (kg/week). Daily weight is noise;
// the slope of the trend is the signal — and doubles as the energy-balance sensor.
export function bodyweightTrend(series) {
  const pts = series
    // Require a POSITIVE weight (consistent with adaptiveTDEE): a 0/negative entry
    // isn't a real weigh-in, and a zero average would make pct_per_week divide by 0.
    .filter((p) => p.date && typeof p.bodyweight_kg === "number" && p.bodyweight_kg > 0)
    .map((p) => ({ t: new Date(p.date).getTime() / 86400000, w: p.bodyweight_kg }))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 3) return null;
  const n = pts.length;
  const t0 = pts[0].t;
  const xs = pts.map((p) => p.t - t0);
  const ys = pts.map((p) => p.w);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slopePerDay = den === 0 ? 0 : num / den;
  const slopePerWeek = slopePerDay * 7;
  const avgW = my;
  return {
    n,
    days: xs[n - 1] - xs[0],
    avg_kg: Math.round(avgW * 100) / 100,
    slope_kg_per_week: Math.round(slopePerWeek * 1000) / 1000,
    pct_per_week: avgW > 0 ? Math.round((slopePerWeek / avgW) * 10000) / 100 : 0, // never NaN, even on degenerate input
  };
}

// Infer energy-balance direction from the weight trend + goal. No calorie counting.
export function classifyEnergyBalance(trend, goal) {
  if (!trend) return { direction: "unknown", note: "need >=3 bodyweight points" };
  const pct = trend.pct_per_week;
  // Boundaries are INCLUSIVE and match the goal-branch thresholds below (which
  // treat pct===0.1 as on-target lean-gain): a hair over 0.1%/wk is a small
  // surplus, so `direction` must not say "maintenance" while the advice says
  // "lean-gain on target" — the two fields were computed with `>` vs `>=`.
  let direction;
  if (pct >= 0.1) direction = "surplus";
  else if (pct <= -0.1) direction = "deficit";
  else direction = "maintenance";

  const wantsGain = goal === "hypertrophy" || goal === "strength";
  const wantsLoss = goal === "fat-loss";
  const wantsHold = goal === "recomposition" || goal === "general-fitness";

  let matchesGoal, suggestion;
  if (wantsGain) {
    if (direction === "deficit") { matchesGoal = false; suggestion = "Goal is muscle gain but you're losing weight — add ~200-300 kcal/day."; }
    else if (pct > 0.5) { matchesGoal = "partly"; suggestion = "Gaining fast (>0.5%/wk); trim the surplus to keep gains leaner."; }
    else if (pct >= 0.1) { matchesGoal = true; suggestion = "Lean-gain rate looks on target (~0.1-0.5%/wk)."; }
    else { matchesGoal = "partly"; suggestion = "Roughly maintaining; a small surplus (~+150-300 kcal) would speed gaining."; }
  } else if (wantsLoss) {
    if (direction === "surplus") { matchesGoal = false; suggestion = "Goal is fat loss but you're gaining — increase the deficit."; }
    else if (pct < -1.0) { matchesGoal = "partly"; suggestion = "Losing fast (>1%/wk); ease the deficit to protect muscle."; }
    else if (direction === "deficit") { matchesGoal = true; suggestion = "Fat-loss rate looks appropriate."; }
    else { matchesGoal = "partly"; suggestion = "Maintaining; a moderate deficit is needed to lose fat."; }
  } else {
    // recomposition / general
    matchesGoal = direction === "maintenance" ? true : "partly";
    suggestion = direction === "maintenance" ? "Weight stable — good for recomposition." : `Trending toward ${direction}; hold closer to maintenance for recomp.`;
  }
  return { direction, rate_pct_per_week: pct, matchesGoal, suggestion };
}

// Progression per exercise: best est-1RM per week and the change across the log.
export function progressionByExercise(sessions, exIndex) {
  const byEx = {};
  const byExLoad = {}; // pump-band lifts (reps > RELIABLE_1RM_REPS): track weekly best LOAD, same as stallDetect
  for (const s of sessions) {
    const wk = sessionWeekKey(s);
    for (const set of s.sets ?? []) {
      // Reliable rep ranges only — otherwise a light high-rep back-off set shows
      // up as a strength GAIN, and this screen contradicts the session recap.
      // Deload weeks are eased ~10% ON PURPOSE, so their e1RM must NOT anchor the
      // trend — otherwise the block-ending recovery week reads as a fabricated ~10%
      // strength LOSS, shown precisely when the coach copy says growth shows up.
      // (Mirrors stallDetect and suggestWeight, which both already exclude deloads —
      // this was the one "deload-aware progression" sibling the guard missed.)
      if (set.deload) continue;
      if (countsForE1RM(set)) {
        const { e1rm } = estimate1RM(set.weight_kg, set.reps);
        byEx[set.exercise] ??= {};
        byEx[set.exercise][wk] = Math.max(byEx[set.exercise][wk] ?? 0, e1rm);
      } else if ((set.set_type ?? "work") !== "warmup" && typeof set.reps === "number" && set.reps > RELIABLE_1RM_REPS && typeof set.weight_kg === "number" && set.weight_kg > 0) {
        // Without this path, a lifter's laterals/calves (the plan's own 12-20
        // band) never chart at all — "Your lifts" showed only the heavy work.
        byExLoad[set.exercise] ??= {};
        byExLoad[set.exercise][wk] = Math.max(byExLoad[set.exercise][wk] ?? 0, set.weight_kg);
      }
    }
  }
  const out = [];
  // Basis by MAJORITY of weeks, not all-time existence: one grinding 12-rep set
  // (the BOTTOM of the plan's own 12-20 band) used to route an exercise into the
  // e1RM path forever, hiding its entire load history — the exact "never charted
  // at all" bug this path exists to fix. Ties go to e1RM (the stronger signal).
  for (const [ex, weekMap] of Object.entries(byExLoad)) {
    if (Object.keys(byEx[ex] ?? {}).length >= Object.keys(weekMap).length) continue; // e1RM covers it
    const weeks = Object.keys(weekMap).sort();
    const first = weekMap[weeks[0]], last = weekMap[weeks[weeks.length - 1]];
    out.push({
      exercise: ex, name: exIndex.get(ex)?.name ?? ex, weeks: weeks.length,
      first_load_kg: first, last_load_kg: last, basis: "load",
      change_pct: first ? Math.round(((last - first) / first) * 10000) / 100 : 0,
    });
  }
  for (const [ex, weekMap] of Object.entries(byEx)) {
    if (Object.keys(byExLoad[ex] ?? {}).length > Object.keys(weekMap).length) continue; // the load row above covers it
    const weeks = Object.keys(weekMap).sort();
    const first = weekMap[weeks[0]], last = weekMap[weeks[weeks.length - 1]];
    out.push({
      exercise: ex,
      name: exIndex.get(ex)?.name ?? ex,
      weeks: weeks.length,
      first_e1rm: first,
      last_e1rm: last,
      change_pct: first ? Math.round(((last - first) / first) * 10000) / 100 : 0,
    });
  }
  return out.sort((a, b) => b.change_pct - a.change_pct);
}

// Plateau detection: an exercise is STALLED when its best weekly e1RM has been
// flat (within a noise band) for >= minWeeks consecutive training weeks. The
// data always existed (progressionByExercise); nothing consumed it — a stalled
// bench got "add a rep" forever. Deload-tagged sets are excluded (an easy week
// is planned recovery, not a plateau).
// Per-exercise WEEKLY BESTS, the shared substrate for every "is this lift going
// anywhere?" question (stallDetect and regressionDetect both read it, so the two
// can never disagree about what a week's best was). Two tracks: estimated 1RM for
// reliable low-rep work, and best LOAD for pump-band work above RELIABLE_1RM_REPS
// where Epley is guesswork. Deload-tagged sets are excluded everywhere — a planned
// easy week is recovery, not a plateau and not a decline.
function weeklyBestsByExercise(sessions) {
  const byEx = {};
  const byExLoad = {};
  for (const s of sessions) {
    const wk = sessionWeekKey(s);
    for (const set of s.sets ?? []) {
      if (set.deload) continue;
      if (countsForE1RM(set)) {
        const { e1rm } = estimate1RM(set.weight_kg, set.reps);
        byEx[set.exercise] ??= {};
        byEx[set.exercise][wk] = Math.max(byEx[set.exercise][wk] ?? 0, e1rm);
      } else if ((set.set_type ?? "work") !== "warmup" && typeof set.reps === "number" && set.reps > RELIABLE_1RM_REPS && typeof set.weight_kg === "number" && set.weight_kg > 0) {
        // The plan itself prescribes 12-20 (pump band) — without this path a
        // lateral-raise plateau was invisible to every progression surface.
        byExLoad[set.exercise] ??= {};
        byExLoad[set.exercise][wk] = Math.max(byExLoad[set.exercise][wk] ?? 0, set.weight_kg);
      }
    }
  }
  return { byEx, byExLoad };
}

export function stallDetect(sessions, exIndex, { minWeeks = 4, noisePct = 2.5 } = {}) {
  const { byEx, byExLoad } = weeklyBestsByExercise(sessions);
  // Stalled = the recent window sits inside the noise band AND shows NO net
  // progress across it (the latest week is not meaningfully above the earliest).
  // This flags the textbook plateau (identical numbers every week: latest ==
  // earliest) and shallow declines, while still exempting genuine slow progress
  // (latest clearly above earliest). Two earlier versions each missed one end:
  // `< hi + 0.01` was a tautology (flagged everyone); `< hi - 0.01` missed the
  // dead-flat plateau (latest ties the max). Compare ends, not to the max.
  const flatWindow = (weekMap) => {
    const weeks = Object.keys(weekMap).sort();
    if (weeks.length < minWeeks) return null;
    const recent = weeks.slice(-minWeeks).map((w) => weekMap[w]);
    const hi = Math.max(...recent), lo = Math.min(...recent);
    const flat = hi > 0 && ((hi - lo) / hi) * 100 <= noisePct && recent[recent.length - 1] <= recent[0] + 0.01;
    return flat ? hi : null;
  };
  const out = [];
  for (const [ex, weekMap] of Object.entries(byEx)) {
    // Majority-of-weeks rule (mirrors progressionByExercise + this function's own
    // byExLoad loop below): without this reciprocal guard, an exercise logged with
    // BOTH a flat low-rep top set and a flat high-rep backoff/isolation set (a
    // common top-set-plus-backoff pattern) pushed a stall entry from EACH path,
    // rendering the exercise's own name twice in the Progress tab's plateau card
    // ("2 lifts have plateaued: Bench Press, Bench Press") — a visibly duplicated,
    // wrong count on a coaching surface that's supposed to build trust.
    if (Object.keys(byExLoad[ex] ?? {}).length > Object.keys(weekMap).length) continue;
    const hi = flatWindow(weekMap);
    if (hi != null) out.push({ exercise: ex, name: exIndex.get(ex)?.name ?? ex, weeks_flat: minWeeks, best_e1rm: hi });
  }
  for (const [ex, weekMap] of Object.entries(byExLoad)) {
    // Majority-of-weeks rule (mirrors progressionByExercise): a single reliable
    // low-rep week must not blind the load path to a 4-week pump plateau.
    if (Object.keys(byEx[ex] ?? {}).length >= Object.keys(weekMap).length) continue;
    const hi = flatWindow(weekMap);
    if (hi != null) out.push({ exercise: ex, name: exIndex.get(ex)?.name ?? ex, weeks_flat: minWeeks, best_load_kg: hi, basis: "load" });
  }
  return out;
}

// REGRESSION — going BACKWARDS, which the engine could not see at all
// (considerations #2, finding 2C). Three things were true together:
//   1. suggestWeight's only reaction to a bad session is "hold the weight and build
//      reps" — textbook double progression, and correct for one bad day.
//   2. stallDetect structurally CANNOT see a real decline: it requires the recent
//      window to sit inside a 2.5% noise band, and a genuine drop blows straight
//      past that. So a lifter losing strength was invisible while it happened.
//   3. Once the pre-drop weeks rolled out of the window, the NEW, LOWER level went
//      flat — and read as an ordinary plateau. deriveVolumeAdjust's answer to a
//      plateau with headroom is +2 sets: MORE volume, to someone already failing to
//      recover from what they were doing. Exactly backwards.
//
// Sustained by construction: the last TWO weeks must both sit at least `dropPct`
// below the window's peak. One bad week — illness, a bad night, a missed meal —
// bounces back and must never be treated as a decline. `dropPct` sits well clear of
// stallDetect's 2.5% noise band so the two can't both claim the same lift.
export function regressionDetect(sessions, exIndex, { minWeeks = 4, lookbackWeeks = 8, dropPct = 5 } = {}) {
  const { byEx, byExLoad } = weeklyBestsByExercise(sessions);
  const declined = (weekMap) => {
    const weeks = Object.keys(weekMap).sort();
    if (weeks.length < minWeeks) return null;
    // The peak is taken over a LONGER window than the "is it sustained?" check.
    // Measuring the drop against only the last few weeks caps how much decline can
    // ever accumulate inside the window, so a slow grind downward — say -1.5%/week,
    // which is -6% in a month and unambiguously a problem — could never cross the
    // threshold, because each week is barely below the one before it. Judging the
    // last two weeks against the best of the recent PAST is also simply how a person
    // reads their own log: "I'm well down on what I was doing."
    const peakWindow = weeks.slice(-lookbackWeeks).map((w) => weekMap[w]);
    const peak = Math.max(...peakWindow);
    if (!(peak > 0)) return null;
    const floor = peak * (1 - dropPct / 100);
    const lastTwo = peakWindow.slice(-2);
    if (lastTwo.length < 2 || !lastTwo.every((v) => v <= floor)) return null;
    return { peak, latest: peakWindow[peakWindow.length - 1] };
  };
  const out = [];
  for (const [ex, weekMap] of Object.entries(byEx)) {
    // Same majority-of-weeks reciprocity stallDetect uses, so a lift logged on both
    // tracks is reported once, from whichever track has more of its history.
    if (Object.keys(byExLoad[ex] ?? {}).length > Object.keys(weekMap).length) continue;
    const d = declined(weekMap);
    if (d) out.push({ exercise: ex, name: exIndex.get(ex)?.name ?? ex, basis: "e1rm", peak: Math.round(d.peak * 10) / 10, latest: Math.round(d.latest * 10) / 10, drop_pct: Math.round(((d.peak - d.latest) / d.peak) * 1000) / 10 });
  }
  for (const [ex, weekMap] of Object.entries(byExLoad)) {
    if (Object.keys(byEx[ex] ?? {}).length >= Object.keys(weekMap).length) continue;
    const d = declined(weekMap);
    if (d) out.push({ exercise: ex, name: exIndex.get(ex)?.name ?? ex, basis: "load", peak: Math.round(d.peak * 10) / 10, latest: Math.round(d.latest * 10) / 10, drop_pct: Math.round(((d.peak - d.latest) / d.peak) * 1000) / 10 });
  }
  return out;
}

// The individual's demonstrated progression CADENCE: the typical number of training
// weeks between meaningful improvements on their own lifts. People progress at wildly
// different rates — some PR every fortnight, others over months of consistency — so a
// fixed "4 flat weeks = stalled" churns a slow-but-real responder's program before it
// pays off, and destroys the very consistency that was about to work. This LEARNS the
// personal rhythm from logged data so the stall window can scale to it (see
// adaptiveStallWindow). Returns null until there's a real track record (then the caller
// falls back to the KB default). Pure; deload sets excluded (planned easy weeks aren't
// plateaus). Gaps are in PRESENT training weeks, matching how stallDetect slices its
// window — a missed week isn't a training week. See docs/adaptive-algorithm.md.
// `minGaps` = how many demonstrated improvement INTERVALS are needed before we trust a
// personal cadence. One real PR interval is already strong evidence a lifter is slow, and
// because the window only ever STRETCHES patience (never shrinks below the floor), acting
// on a single interval is low-risk and recognises a slow responder a full PR-cycle sooner
// — the sim (scripts/sim-adaptive.mjs) showed a 6-week responder was otherwise bumped
// twice before the rhythm locked. Zero intervals (a brand-new/flat history) still → null.
export function progressionCadence(sessions, exIndex, { noisePct = 2.5, minGaps = 1 } = {}) {
  const byEx = {};      // reliable-rep e1RM, weekly best
  const byExLoad = {};  // pump-band (high-rep) load, weekly best — Epley is guesswork there
  for (const s of sessions) {
    const wk = sessionWeekKey(s);
    for (const set of s.sets ?? []) {
      if (set.deload) continue;
      if (countsForE1RM(set)) {
        const { e1rm } = estimate1RM(set.weight_kg, set.reps);
        (byEx[set.exercise] ??= {})[wk] = Math.max(byEx[set.exercise][wk] ?? 0, e1rm);
      } else if ((set.set_type ?? "work") !== "warmup" && typeof set.reps === "number" && set.reps > RELIABLE_1RM_REPS && typeof set.weight_kg === "number" && set.weight_kg > 0) {
        (byExLoad[set.exercise] ??= {})[wk] = Math.max(byExLoad[set.exercise][wk] ?? 0, set.weight_kg);
      }
    }
  }
  const gaps = [];
  const collect = (weekMap) => {
    const weeks = Object.keys(weekMap).sort();
    if (weeks.length < 2) return;
    let lastBest = weekMap[weeks[0]], lastImproveIdx = 0;
    for (let i = 1; i < weeks.length; i++) {
      if (weekMap[weeks[i]] > lastBest * (1 + noisePct / 100)) { // a real improvement beyond the noise band
        gaps.push(i - lastImproveIdx);                           // training weeks since the last improvement
        lastBest = weekMap[weeks[i]]; lastImproveIdx = i;
      }
    }
  };
  // Majority-of-weeks rule (mirrors stallDetect + progressionByExercise): without this
  // reciprocal guard, an exercise logged with BOTH a reliable top set and a pump-band
  // backoff set every session (the common top-set-plus-backoff pattern) contributed its
  // improvement gaps into the shared median-gap pool from BOTH paths, doubling that one
  // lift's influence over the personal cadence estimate relative to every other exercise.
  // Ties go to e1RM (the stronger signal), same as the other two functions.
  for (const ex of new Set([...Object.keys(byEx), ...Object.keys(byExLoad)])) {
    const loadWeeks = Object.keys(byExLoad[ex] ?? {}).length;
    const e1rmWeeks = Object.keys(byEx[ex] ?? {}).length;
    collect(loadWeeks > e1rmWeeks ? byExLoad[ex] : byEx[ex]);
  }
  if (gaps.length < minGaps) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2; // median gap (robust to outliers)
}

// Turn a personal progression cadence into the stall window — how many FLAT training
// weeks count as a plateau for THIS person. Bounded so it can never get LESS patient
// than the KB default (floor): a false "stalled" churns a program that's actually
// working, which is the costlier error, so we only ever STRETCH patience for a
// demonstrated slow responder, never shrink it below the reliable-signal minimum. And
// never past a ceiling (even a slow responder's truly dead lift warrants a look). Null
// cadence (too little data) → the default. Pure.
export function adaptiveStallWindow(cadence, { floor = 4, ceiling = 10, factor = 1.5 } = {}) {
  if (cadence == null || !(cadence > 0)) return floor;
  return Math.max(floor, Math.min(ceiling, Math.round(cadence * factor)));
}

// Rest times derived from set timestamps (never asked). Returns avg seconds per exercise.
export function restTimes(session) {
  const byEx = {};
  const sets = (session.sets ?? []).filter((s) => s.completed_at);
  for (let i = 1; i < sets.length; i++) {
    if (sets[i].exercise !== sets[i - 1].exercise) continue;
    const dt = (new Date(sets[i].completed_at) - new Date(sets[i - 1].completed_at)) / 1000;
    if (dt <= 0 || dt > 1800) continue;
    (byEx[sets[i].exercise] ??= []).push(dt);
  }
  const out = {};
  for (const [ex, arr] of Object.entries(byEx))
    out[ex] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  return out;
}

// Infer proximity-to-failure objectively from rep drop-off at a fixed load
// (bypasses unreliable self-reported RIR). Returns a heuristic per exercise.
export function proximityFromRepDropoff(session) {
  const byExLoad = {};
  for (const set of session.sets ?? []) {
    if ((set.set_type ?? "work") !== "work") continue;
    const key = `${set.exercise}@${set.weight_kg}`;
    (byExLoad[key] ??= []).push(set.reps);
  }
  const out = {};
  for (const [key, reps] of Object.entries(byExLoad)) {
    if (reps.length < 2) continue;
    const drop = reps[0] - reps[reps.length - 1];
    out[key] = {
      reps,
      rep_dropoff: drop,
      inferred: drop >= 2 ? "trained-close-to-failure" : drop === 1 ? "moderate-proximity" : "left-reps-in-reserve",
    };
  }
  return out;
}

// Readiness relative to the user's OWN baseline (z-scores), not absolute values —
// the correct way to use HRV/sleep. 0-100, higher = more recovered. Null if no data.
export function readinessIndex(checkins) {
  const rows = checkins.filter((c) => c.hrv_ms != null || c.sleep_hours != null);
  if (rows.length < 3) return null;
  const stat = (key, invert = false) => {
    const vals = rows.map((r) => r[key]).filter((v) => typeof v === "number");
    if (vals.length < 3) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    return { mean, sd, invert };
  };
  const specs = { hrv_ms: stat("hrv_ms"), sleep_hours: stat("sleep_hours"), resting_hr: stat("resting_hr", true), stress: stat("stress", true) };
  const score = (c) => {
    let z = 0, w = 0;
    const weights = { hrv_ms: 0.4, sleep_hours: 0.3, resting_hr: 0.2, stress: 0.1 };
    for (const [k, s] of Object.entries(specs)) {
      if (!s || typeof c[k] !== "number") continue;
      let zk = (c[k] - s.mean) / s.sd;
      if (s.invert) zk = -zk;
      z += weights[k] * zk; w += weights[k];
    }
    if (w === 0) return null;
    const norm = z / w; // ~z-score
    return Math.max(0, Math.min(100, Math.round(50 + norm * 20)));
  };
  const latest = rows[rows.length - 1];
  return { latest: score(latest), latest_date: latest.date, method: "personal-baseline z-score" };
}

// Confidence tier for a metric, from its provenance.
export function confidenceTier(source) {
  if (source === "wearable" || source === "smart-scale") return "high";
  if (source === "manual") return "moderate";
  return "low";
}

// ---------------------------------------------------------------------------
// The full feature report an autoregulator / ML model consumes for one user.
// ---------------------------------------------------------------------------
export function buildFeatureReport({ profile, sessions = [], checkins = [], bodyMetrics = [] }, exIndex, muscleIndex) {
  const weekly = perMuscleWeeklyVolume(sessions, exIndex);
  const weeks = Object.keys(weekly).sort();
  const latestWeek = weeks[weeks.length - 1];
  const bwSeries = [...checkins, ...bodyMetrics].filter((r) => r.bodyweight_kg != null).map((r) => ({ date: r.date, bodyweight_kg: r.bodyweight_kg }));
  const trend = bodyweightTrend(bwSeries);
  return {
    user_id: profile?.user_id ?? null,
    goal: profile?.primary_goal ?? null,
    training_status: profile?.training_status ?? null,
    weekly_volume_by_muscle: weekly,
    latest_week: latestWeek ?? null,
    latest_week_vs_landmarks: latestWeek ? volumeVsLandmarks(weekly[latestWeek], muscleIndex) : {},
    bodyweight_trend: trend,
    energy_balance: classifyEnergyBalance(trend, profile?.primary_goal),
    progression: progressionByExercise(sessions, exIndex),
    readiness: readinessIndex(checkins),
    rest_times_latest_session: sessions.length ? restTimes(sessions[sessions.length - 1]) : {},
    proximity_latest_session: sessions.length ? proximityFromRepDropoff(sessions[sessions.length - 1]) : {},
  };
}
