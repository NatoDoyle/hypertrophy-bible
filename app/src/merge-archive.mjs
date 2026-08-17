// Immutable merge archives deliberately keep more than the current active user
// graph.  A merge is convenient account consolidation, never permission to
// destroy the source record or any collision-losing history.

export const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

const LIVE_PROFILE_FIELDS = new Set([
  // Device/push delivery state.
  "celebration", "freeze_pushed_week", "comeback_push", "commitment",
  // Share-token and social state. A restored copy must deliberately opt in again.
  "following", "followers_count", "followers_pushed", "cheers_pushed", "cheers_seen",
  "partner_nudge", "nudge_pushed_at", "nudge_seen_at",
  "challenges", "challenge", "challenge_pushed_at", "challenge_accept_pushed_at",
]);

export function archiveSummary(archive) {
  const snap = archive?.snapshot ?? {};
  return {
    archive_id: archive?.archive_id,
    created_at: archive?.created_at,
    state: archive?.state ?? "available",
    restored_at: archive?.restored_at ?? null,
    counts: {
      sessions: snap.sessions?.length ?? 0,
      bodyweights: snap.bodyweights?.length ?? 0,
      checkins: snap.checkins?.length ?? 0,
      nutrition_logs: snap.nutrition_logs?.length ?? 0,
    },
  };
}

// The source UUID is a possession capability in this application. Restoring it
// would revive an old device's authority, so every archive creates a fresh
// anonymous account. Session ids are global in D1, hence the archive namespace.
export function restoredSession(session, archiveId, restoredUserId, ordinal) {
  const original = session?.session_id ?? `legacy-${ordinal}`;
  return {
    ...clone(session),
    session_id: `${archiveId}:session:${ordinal}:${original}`,
    user_id: restoredUserId,
    // XP's variable-ratio result is deterministic from the original id. Keeping
    // this private seed means a safe copy cannot rewrite historical lucky sets.
    lucky_seed: session?.lucky_seed ?? original,
  };
}

export function restoredUser(snapshotUser, restoredUserId) {
  const user = clone(snapshotUser) ?? {};
  delete user._merged_into;
  delete user._merged_at;
  delete user._merge_archive_id;
  const profile = { ...(user.profile ?? {}) };
  for (const key of LIVE_PROFILE_FIELDS) delete profile[key];
  // The acknowledgement is a stored server stamp copied from an immutable
  // archive, not a value accepted from a restore client. Keep it with the person.
  profile.user_id = restoredUserId;
  user.profile = profile;
  return user;
}

export function archiveSnapshot({ user, sessions = [], bodyweights = [], checkins = [], nutrition_logs = [], push_subscriptions = [], push_deliveries = [], shares = [], magic_links = [] }) {
  return clone({ user, sessions, bodyweights, checkins, nutrition_logs, push_subscriptions, push_deliveries, shares, magic_links });
}
