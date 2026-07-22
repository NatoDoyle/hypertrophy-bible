// Comeback nudges (#4 adherence): a lapsed lifter with a backed-up email gets at
// most TWO warm, penalty-free emails per lapse — then silence. The guardrails
// are structural, not copy-deep:
//   - paused users are never emailed (the app literally promises "I won't nudge
//     you" on the pause card — this module is that promise);
//   - reminders_off is a hard opt-out (Coach tab toggle);
//   - one email per stage per lapse, tracked against the exact session the lapse
//     started from, so a sweep re-run (cron retry, overlapping invocations) can
//     never double-send;
//   - training again resets the state naturally (the lapse anchor changes).
// Pure decision + injectable store/sender, so the whole thing unit-tests on the
// file store and the Workers cron handler stays a two-liner.

export const NUDGE_STAGE_1_DAYS = 4;  // "your next session is ready when you are"
export const NUDGE_STAGE_2_DAYS = 14; // "the door's open — re-entry is eased" (final)

export function comebackStage({ lastSessionAt, nudge, paused, remindersOff, now }) {
  if (paused || remindersOff || !lastSessionAt) return null; // never-trained users are onboarding's job, not email's
  const days = Math.floor((+new Date(now) - +new Date(lastSessionAt)) / 86400000);
  if (!Number.isFinite(days) || days < NUDGE_STAGE_1_DAYS) return null;
  const sent = nudge?.for_session_at === lastSessionAt ? nudge.stage ?? 0 : 0;
  if (days >= NUDGE_STAGE_2_DAYS) return sent >= 2 ? null : { stage: 2, days };
  return sent >= 1 ? null : { stage: 1, days };
}

// One daily sweep over email-bound users. Returns counts for the cron log.
export async function runComebackSweep(store, sendComeback, now = Date.now()) {
  const rows = await store.listAccountLastSessions();
  let checked = 0, sent = 0;
  for (const { email, user_id, last_date } of rows) {
    checked++;
    const user = await store.getUser(user_id);
    if (!user) continue;
    const hit = comebackStage({
      lastSessionAt: last_date ?? null,
      nudge: user.nudge ?? null,
      paused: !!user.paused,
      remindersOff: user.profile?.reminders_off === true,
      now,
    });
    if (!hit) continue;
    const res = await sendComeback({ email, stage: hit.stage, days: hit.days });
    if (res && res.ok === false) continue; // a failed send is retried by the next sweep, not marked sent
    await store.updateUser(user_id, (u) => {
      u.nudge = { for_session_at: last_date, stage: hit.stage, at: new Date(now).toISOString() };
      return u;
    });
    sent++;
  }
  return { checked, sent };
}
