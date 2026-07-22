// Comeback nudges (#4 adherence): a lapsed lifter with a backed-up email gets at
// most TWO warm, penalty-free emails per lapse — then silence. The guardrails
// are structural, not copy-deep:
//   - paused users are never emailed (the app literally promises "I won't nudge
//     you" on the pause card — this module is that promise);
//   - reminders_off is a hard opt-out (Coach tab toggle);
//   - one email per stage per lapse, tracked against the exact session the lapse
//     started from and CLAIMED (compare-and-swap, precondition inside the
//     mutator) BEFORE sending — overlapping sweeps race on the write, not the
//     send, and a crash between claim and send costs one nudge, never a
//     duplicate; a failed send releases the claim so the next sweep retries;
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
    // CLAIM first (CAS — the precondition lives INSIDE the mutator, per the
    // store contract): if a concurrent sweep already recorded this stage, the
    // mutator sees it on re-read and we lose the race without sending.
    let claimed = false, prev = null;
    try {
      await store.updateUser(user_id, (u) => {
        claimed = false; prev = u.nudge ?? null; // reset per CAS attempt — the mutator may re-run on fresh data
        const already = u.nudge?.for_session_at === last_date && (u.nudge.stage ?? 0) >= hit.stage;
        if (already) return u;
        claimed = true;
        u.nudge = { for_session_at: last_date, stage: hit.stage, at: new Date(now).toISOString() };
        return u;
      });
      if (!claimed) continue;
      let res;
      try { res = await sendComeback({ email, stage: hit.stage, days: hit.days }); }
      catch { res = { ok: false }; }
      if (res && res.ok === false) {
        // release the claim (best effort) so tomorrow's sweep retries — only if
        // it is still OUR claim; a crash here costs one nudge, never a duplicate
        await store.updateUser(user_id, (u) => {
          if (u.nudge?.for_session_at === last_date && u.nudge.stage === hit.stage) u.nudge = prev;
          return u;
        });
        continue;
      }
      sent++;
    } catch {
      // one user's store failure (e.g. a D1 write-conflict throw) must never
      // abort the rest of the sweep
    }
  }
  return { checked, sent };
}
