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
// Stage 0 is the ACTIVATION nudge: never trained, anchored on account creation.
// Two days, because the measured median time-to-first-session is 0 — whoever
// trains, trains the same day they onboard — so someone still at zero after two
// days did not merely fail to get round to it.
export const NUDGE_STAGE_0_DAYS = 2;

export function comebackStage({ lastSessionAt, nudge, paused, remindersOff, now, createdAt = null, hasAnySession = false }) {
  // The pause promise and the opt-out are absolute, and stay the first line.
  if (paused || remindersOff) return null;
  if (!lastSessionAt) {
    // This used to `return null` here, under "never-trained users are onboarding's
    // job, not email's". That handed the job to a department that does not exist:
    // onboarding has no follow-up of any kind, the account row is only created
    // when a magic link is CLICKED, the push loop iterates zero subscriptions, and
    // the commitment card is gated behind day_number > 1 — which never arrives for
    // someone who never trains. Every re-engagement lever in the app was gated
    // behind having already trained, so 122 of 135 users were unreachable on every
    // channel simultaneously.
    //
    // ONE email, ever, and only to someone who gave us an address. Not a sequence:
    // they have no streak to lose and did nothing wrong, so there is nothing to
    // remind them of a second time.
    //
    // ...and only to someone who has genuinely never trained. `lastSessionAt` is
    // null for TWO different populations: people with no sessions, and people whose
    // every session is voided or timing-quarantined. The second group HAS trained —
    // the app is showing one of them a "Date needs correcting" card in History at
    // the same moment — and mailing them "Your first session, whenever you want it"
    // states the opposite of what they did (lesson 10). `has_any_session` is the
    // signal for "ever", which is a different question from "when did you last do
    // something that counts".
    if (hasAnySession) return null;
    if (!createdAt) return null;
    const age = Math.floor((+new Date(now) - +new Date(createdAt)) / 86400000);
    if (!Number.isFinite(age) || age < NUDGE_STAGE_0_DAYS) return null;
    // Stamped against the account itself rather than a session that doesn't exist.
    return nudge?.for_session_at === "account:created" ? null : { stage: 0, days: age };
  }
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
  for (const { email, user_id, last_date, has_any_session } of rows) {
    checked++;
    const user = await store.getUser(user_id);
    if (!user) continue;
    const hit = comebackStage({
      lastSessionAt: last_date ?? null,
      nudge: user.nudge ?? null,
      paused: !!user.paused,
      remindersOff: user.profile?.reminders_off === true,
      now,
      // Already loaded above — the activation branch costs no extra store call.
      createdAt: user.created_at ?? null,
      hasAnySession: !!has_any_session,
    });
    if (!hit) continue;
    // CLAIM first (CAS — the precondition lives INSIDE the mutator, per the
    // store contract): if a concurrent sweep already recorded this stage, the
    // mutator sees it on re-read and we lose the race without sending.
    let claimed = false, prev = null;
    // Hoisted: the RELEASE path below must key on the same anchor the claim used,
    // or a failed stage-0 send leaves the claim stamped forever and the one
    // activation email is silently never retried.
    const anchor = hit.stage === 0 ? "account:created" : last_date;
    try {
      await store.updateUser(user_id, (u) => {
        claimed = false; prev = u.nudge ?? null; // reset per CAS attempt — the mutator may re-run on fresh data
        const already = u.nudge?.for_session_at === anchor && (u.nudge.stage ?? 0) >= hit.stage;
        if (already) return u;
        claimed = true;
        u.nudge = { for_session_at: anchor, stage: hit.stage, at: new Date(now).toISOString() };
        return u;
      });
      if (!claimed) continue;
      let res;
      // The stage-0 copy promises a deliberately short first session — and
      // buildToday only trims for a beginner (`training_status === "beginner"`,
      // defaulting to beginner when unset, exactly as coach.mjs does). Sending that
      // sentence to an intermediate would have the one email the app ever sends
      // them falsified by the first screen it sends them to (lesson 24).
      try { res = await sendComeback({ email, stage: hit.stage, days: hit.days,
        beginner: (user.profile?.training_status ?? "beginner") === "beginner" }); }
      catch { res = { ok: false }; }
      if (res && res.ok === false) {
        // release the claim (best effort) so tomorrow's sweep retries — only if
        // it is still OUR claim; a crash here costs one nudge, never a duplicate
        await store.updateUser(user_id, (u) => {
          if (u.nudge?.for_session_at === anchor && u.nudge.stage === hit.stage) u.nudge = prev;
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
