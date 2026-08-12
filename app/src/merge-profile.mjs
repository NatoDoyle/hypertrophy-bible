// Additive, non-destructive merge of a departing user's earned progress into the
// survivor during account merge (POST /api/auth/merge). Shared by store.mjs and
// store-d1.mjs so the two stay in parity (CLAUDE.md: a behavior in one store but
// not the other is a bug) — the exact class of gap lesson 16 in
// docs/improvement-loop.md already caught once for push_subscriptions: a field
// added to the user record after reassignUserData was written silently orphans
// on merge instead of following the user. Never overwrites anything `to` already
// has; only fills gaps `to` is missing or adds to counts/lists it already owns.
export const FOLLOWING_CAP = 20;         // parity with POST /api/following's own cap
export const HISTORY_CAP_FIELD_CAP = 24; // parity with streak_freezes/pause_history's existing .slice(-24)
export const CHALLENGE_HISTORY_CAP = 20; // parity with adherence.mjs's CHALLENGE_HISTORY_CAP

// Mutates and returns `toU` in place (matches store.mjs's existing direct-mutation
// style for this same function's custom_exercises merge, right above it).
export function mergeUserProfile(fromU, toU) {
  if (!fromU || !toU) return toU;
  // Streak-freeze tokens spent (an ISO week key each): streakFreezeState treats a
  // frozen week as neutral (never "missed"). Once `from`'s sessions join `to`'s
  // timeline (reassignUserData above already does this), a week `from` legitimately
  // protected would silently read as missed on the merged streak if its freeze
  // marker doesn't come along too.
  if (fromU.streak_freezes?.length) {
    toU.streak_freezes = [...new Set([...(toU.streak_freezes ?? []), ...fromU.streak_freezes])].slice(-HISTORY_CAP_FIELD_CAP);
  }
  // Pause windows: the same neutral-week math as streak_freezes reads pause_history
  // too — a genuine pause on `from` must stay neutral once its timeline joins `to`'s.
  // Historical only: never touches `to`'s CURRENT `paused` state, so merging can
  // never silently pause the account the user is actively choosing to keep.
  if (fromU.pause_history?.length) {
    toU.pause_history = [...(toU.pause_history ?? []), ...fromU.pause_history].slice(-HISTORY_CAP_FIELD_CAP);
  }
  const fromFollowing = fromU.profile?.following ?? [];
  if (fromFollowing.length) {
    const toFollowing = toU.profile?.following ?? [];
    toU.profile = { ...(toU.profile ?? {}), following: [...new Set([...toFollowing, ...fromFollowing])].slice(0, FOLLOWING_CAP) };
  }
  // Challenge history entries carry no cross-user token reference (unlike the live
  // `challenges` slots, deliberately left out: each slot references a partner's share
  // token, and the departing account's tokens don't survive its deletion — a merged
  // live slot would be a challenge against a ghost). Wave 198's multi-slot shape
  // changes nothing here: histories merge, live slots never did and still don't.
  // Newest-first by week, same order the entries are already stored in.
  const fromHistory = fromU.profile?.challenge_history ?? [];
  if (fromHistory.length) {
    const toHistory = toU.profile?.challenge_history ?? [];
    const merged = [...toHistory, ...fromHistory].sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));
    toU.profile = { ...(toU.profile ?? {}), challenge_history: merged.slice(0, CHALLENGE_HISTORY_CAP) };
  }
  // Commitment: adopt `from`'s only when `to` hasn't set one — never overwrite the
  // survivor's own stated intention.
  if (fromU.profile?.commitment && !toU.profile?.commitment) {
    toU.profile = { ...(toU.profile ?? {}), commitment: fromU.profile.commitment };
  }
  // Streak-freeze PUSH watermark (`freeze_pushed_week`, added Wave 145/146 — after
  // this file's own lesson-16 audit at Wave 142, so it was never wired in here).
  // Unlike the OTHER push markers this merge deliberately leaves untouched
  // (`cheers_pushed`/`cheers_seen` are scoped to a share token that never crosses
  // accounts; the `challenge_*_pushed_at` markers are scoped to the live `challenge`
  // slot, deliberately not merged below) — this ONE needs it: `streak_freezes` and
  // sessions above already merge additively, and `streakFreezeState` recomputes
  // `protectable_week` fresh from that combined timeline, so the exact missed week
  // `from` was already pushed about can resurface as "new" on `to` post-merge,
  // producing a duplicate "a streak freeze can still save it" push for a week the
  // user already knows about from the other device. ISO week keys are zero-padded
  // (`YYYY-Www`), so lexical comparison IS chronological comparison — take the
  // later of the two, never a raw overwrite, so this can only suppress a push both
  // sides already got, never one `to` still genuinely needs.
  if (fromU.profile?.freeze_pushed_week && fromU.profile.freeze_pushed_week > (toU.profile?.freeze_pushed_week ?? "")) {
    toU.profile = { ...(toU.profile ?? {}), freeze_pushed_week: fromU.profile.freeze_pushed_week };
  }
  // Training-partner nudge (`partner_nudge`/`nudge_pushed_at`/`nudge_seen_at`,
  // added Wave 115/119 — like `freeze_pushed_week` above, it post-dates this
  // file's Wave-142 audit and was never wired in, so a real Goal-4 engagement
  // notification silently evaporated on merge: `from` is deleted right after,
  // taking any not-yet-seen "your training partner nudged you" nudge with it.
  // Unlike the live `challenge` slot below (deliberately unmerged — it's a
  // two-sided mirror keyed by a share token this merge can't rewire on the
  // OTHER side), `partner_nudge` carries no cross-user reference: it's a plain
  // `{at}` timestamp stamped directly on the recipient's own profile, so it's
  // safe to adopt outright. Take the more recent nudge's `at` together with
  // its OWN push/seen watermarks (never mix one side's `at` with the other's
  // watermarks — a stale `nudge_seen_at` paired with a fresher `at` would wrongly
  // suppress a nudge nobody has actually seen yet) — same "adopt the fresher
  // side wholesale, never stomp a fresher one `to` already has" shape as
  // `freeze_pushed_week` just above.
  if (fromU.profile?.partner_nudge?.at > (toU.profile?.partner_nudge?.at ?? 0)) {
    toU.profile = {
      ...(toU.profile ?? {}),
      partner_nudge: fromU.profile.partner_nudge,
      nudge_pushed_at: fromU.profile?.nudge_pushed_at ?? 0,
      nudge_seen_at: fromU.profile?.nudge_seen_at ?? 0,
    };
  }
  // Pending celebration echo (`profile.celebration`, added Wave 201 — after this
  // file's last lesson-16 sweep, the same post-dating gap as freeze_pushed_week
  // and partner_nudge above). A pending UNPUSHED marker is a real Goal-4
  // notification in flight: without adoption it dies with the deleted `from` row.
  // Adopt it only when the survivor has no pending claim of its own (its own
  // marker wins), treating `to`'s already-PUSHED marker like no marker — the
  // arming door itself overwrites pushed markers freely. Never adopt a pushed
  // marker from `from`: that notification is already out. The adopted claim was
  // computed against `from`'s history alone and the merged timeline can refute
  // it — POST /api/auth/merge re-earns any pending marker from the COMBINED
  // history right after reassignUserData (lesson 47: the recompute keys on what
  // celebrationEvent reads — the whole session history — and the merge just
  // rewrote it), so a claim can never outrun the merged truth.
  const fromCel = fromU.profile?.celebration;
  const toCel = toU.profile?.celebration;
  if (fromCel && !fromCel.pushed && (!toCel || toCel.pushed)) {
    toU.profile = { ...(toU.profile ?? {}), celebration: fromCel };
  }
  // Nutrition profile stats (`user.nutrition` — height/neck/waist/hip/bf_pct/
  // activity/weight_kg fallback, the Fuel tab's Navy-formula + Katch-McArdle
  // inputs) live on the user doc too, a sibling of `profile` like
  // `custom_exercises` above — but were never wired into this merge at all,
  // the same lesson-16 gap already caught for push_subscriptions and (this
  // file, above) freeze_pushed_week/cheers watermarks. Concretely: a user who
  // filled in their Fuel stats on `from` before claiming an email account
  // that never touched Fuel would have every one of those fields silently
  // vanish on merge, forcing a full remeasure (tape measurements included).
  // Per-field, only filling gaps `to` doesn't already have — never overwrites
  // a stat the survivor already entered themselves, same convention as the
  // rest of this file.
  if (fromU.nutrition) {
    const nutrition = { ...(toU.nutrition ?? {}) };
    for (const key of ["height_cm", "neck_cm", "waist_cm", "hip_cm", "bf_pct", "activity", "weight_kg"]) {
      if (nutrition[key] == null && fromU.nutrition[key] != null) nutrition[key] = fromU.nutrition[key];
    }
    if (Object.keys(nutrition).length) toU.nutrition = nutrition;
  }
  // The live `challenge` slot is deliberately NOT merged: it's a two-sided mirror
  // keyed by the OTHER side's share token, not a user_id. Lifting it onto `to`
  // without also rewriting the opponent's copy would either silently stomp a
  // challenge `to` is already in, or leave the opponent referencing a token that
  // only still resolves to `to` if `from`'s own share happened to transfer during
  // this same merge (it doesn't when `to` already has a share of its own). An
  // in-progress challenge already degrades gracefully when its opponent's share
  // vanishes (settleChallenge treats it as inconclusive — no fabricated result), so
  // the worst case here is the merged-away device's live race quietly lapses,
  // rather than corrupting either side's state.
  return toU;
}
