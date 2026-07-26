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
  // `challenge` slot below, deliberately left out) — safe to merge unconditionally.
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
