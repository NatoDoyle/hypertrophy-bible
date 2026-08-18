// Immutable merge archives deliberately keep more than the current active user
// graph.  A merge is convenient account consolidation, never permission to
// destroy the source record or any collision-losing history.

export const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

// Server-owned live profile state: written ONLY by the routes that enforce the
// rules attached to each field, never by a client and never revived by a restore.
// ONE set, two consumers, because they are the same question asked twice:
//   - restoredUser() strips these so a safe copy starts capability-free;
//   - stripServerOwnedProfile() strips these at every wholesale client door, so a
//     patch cannot forge state the owning route guards (a hand-written `following`
//     entry skips the live-share check, the no-self-follow check, the 20-token cap
//     AND the followers_count bump that is the only notification the share owner
//     ever gets; a hand-written `challenges` array skips MAX_OPEN_CHALLENGES and
//     bills a listSessions() per forged slot to every /api/challenge and every
//     hourly push tick).
// A previous wave guarded exactly ONE field here (`disclaimer_ack`) with a comment
// citing "guard the siblings" — the sixteen beside it stayed open. The rule is only
// real if it is enumerable, so `test-routes.mjs` walks this very set through both
// doors rather than trusting a comment (lesson 33).
export const LIVE_PROFILE_FIELDS = new Set([
  // Device/push delivery state.
  "celebration", "freeze_pushed_week", "comeback_push", "commitment",
  // Share-token and social state. A restored copy must deliberately opt in again.
  "following", "followers_count", "followers_pushed", "cheers_pushed", "cheers_seen",
  "partner_nudge", "nudge_pushed_at", "nudge_seen_at",
  "challenges", "challenge", "challenge_pushed_at", "challenge_accept_pushed_at",
]);

// The client-write set is the live set PLUS the acknowledgement stamp. The one
// deliberate difference: a RESTORE keeps `disclaimer_ack` (it is the person's own
// server-stamped acknowledgement, copied from an immutable archive — it travels
// with them), while a CLIENT may never write it, because that would let a device
// forge, replace, or mint the record the stamp exists to be.
export const SERVER_OWNED_PROFILE_FIELDS = new Set([...LIVE_PROFILE_FIELDS, "disclaimer_ack"]);

// Every wholesale client->profile door passes through here. Returns a private
// copy: callers then validate the remaining fields, so mutating the caller's
// object (or the stored one) would be the bug this guard exists to stop.
export function stripServerOwnedProfile(profile) {
  if (profile == null) return profile;
  const out = { ...profile };
  for (const key of SERVER_OWNED_PROFILE_FIELDS) delete out[key];
  return out;
}

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
