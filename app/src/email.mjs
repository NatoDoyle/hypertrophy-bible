// Magic-link email sender. With a Resend API key it sends real mail; without one
// (local dev, or prod before a domain is verified) it logs the link and returns
// it, so the whole flow is testable without sending anything. Injected into the
// Hono app, so the app itself stays runtime-agnostic.
// Emails are HTML; a programme name or exercise label is data, so escape it.
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// What the magic-link email SAYS, by situation (`kind`, from requestMagicLink) — a
// pure function so the copy is testable. The mail is a promise the code has to keep
// (lesson 60): it used to say "Restore your progress" to a device that had asked to
// SAVE its progress, because every already-bound email was one undifferentiated
// "restore". Each kind now describes what tapping actually does.
const LINK_COPY = {
  new: { subject: "Confirm your email to save your progress", lead: "Tap below to confirm your email — your progress is then saved to it and follows you to any device.", button: "Save my progress" },
  reconfirm: { subject: "Confirm your email", lead: "Your progress is already saved to this email — tap below to confirm it on this device.", button: "Confirm my email" },
  merge: { subject: "You already have a Hypertrophy Bible account", lead: "This email is already linked to a Hypertrophy Bible account. Tap below to sign this phone in to it — the workouts you've logged on this phone come with you, so nothing is lost, and your saved plan comes back.", button: "Sign in to my account" },
  switch: { subject: "You already have a Hypertrophy Bible account", lead: "This email is linked to a different Hypertrophy Bible account from the one on this phone. Tapping below switches this phone to that account; the one it's on now stays saved to its own email.", button: "Switch to this account" },
  signin: { subject: "Sign in to your Hypertrophy Bible account", lead: "Tap below to sign in on this device — your progress and your plan come with you.", button: "Sign in" },
};
export function magicLinkEmail({ link, code = null, kind = "new", plan = null }) {
  const copy = LINK_COPY[kind] ?? LINK_COPY.new;
  // The plan, when the caller has one to send. The plan-screen ask says "I'll send
  // your week — the sessions, the exercises, the sets", and for a while that was
  // simply untrue: this template was a bare magic link under a subject about
  // backup. Either the copy or the mail had to change, and the mail is the better
  // half — it is the reason to open the message, and opening it is the click that
  // actually creates the account row the re-engagement sweeps query.
  const planHtml = plan?.sessions?.length
    ? `<h3 style="margin:20px 0 6px;font-size:16px">${esc(plan.name ?? "Your week")}</h3>
       ${plan.sessions.map((sn) => `<div style="margin:0 0 14px">
         <div style="font-weight:700;margin:0 0 4px">${esc(sn.name)}</div>
         ${(sn.exercises ?? []).map((e) => `<div style="color:#444;font-size:14px">${esc(e.name)} — ${e.sets} × ${esc(e.rep_range)}</div>`).join("")}
       </div>`).join("")}`
    : "";
  // The code goes FIRST, above the button: on iPhone the button opens Safari, whose
  // storage is separate from the Home-Screen app, so for an app user the code is the
  // only way in. Never in the subject line (lock-screen previews show subjects).
  const shown = code && /^\d{6}$/.test(String(code)) ? `${String(code).slice(0, 3)} ${String(code).slice(3)}` : null;
  const codeHtml = shown
    ? `<p style="margin:16px 0 4px">Using the app from your Home Screen? Type this code in the app:</p>
      <p style="font-size:28px;font-weight:800;letter-spacing:4px;margin:0 0 4px">${shown}</p>
      <p style="color:#666;font-size:13px;margin:0">On iPhone the button below opens your browser, not the app.</p>`
    : "";
  const subject = planHtml ? "Your training week" : copy.subject;
  const lead = planHtml && kind === "new" ? "Tap below to save this to your account so it follows you to any device." : copy.lead;
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:24px auto;color:#111">
      <h2 style="margin:0 0 12px">The Hypertrophy Bible</h2>
      ${planHtml}
      <p>${lead} ${code ? "The code and the button each work once" : "This link works once"} and expire${code ? "" : "s"} in 30 minutes.</p>
      ${codeHtml}
      <p style="margin:20px 0"><a href="${link}" style="display:inline-block;background:#3fd07a;color:#06210f;font-weight:700;padding:14px 24px;border-radius:12px;text-decoration:none">${copy.button}</a></p>
      <p style="color:#888;font-size:14px">If you didn't request this, you can safely ignore it. Replies to this address aren't read — this mailbox only sends.</p></div>`;
  return { subject, html };
}

export function createEmailSender({ apiKey, from } = {}) {
  const sender = from || "The Hypertrophy Bible <onboarding@resend.dev>";

  return async function sendMagicLink({ email, link, purpose, kind, code = null, plan = null }) {
    if (!apiKey) {
      console.log(`[dev magic-link] (${kind ?? purpose}) ${email} -> ${link}`);
      return { dev: true, link };
    }
    const { subject, html } = magicLinkEmail({ link, code, kind: kind ?? (purpose === "restore" ? "signin" : "new"), plan });

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: sender, to: email, subject, html }),
      });
      if (!res.ok) {
        console.log("email send failed", res.status, await res.text().catch(() => ""));
        return { dev: false, ok: false };
      }
      return { dev: false, ok: true };
    } catch (e) {
      console.log("email send error", String(e));
      return { dev: false, ok: false };
    }
  };
}

// Comeback-nudge sender (#4 adherence). Copy rules are the app's guardrails:
// never shame, nothing is "lost" or "at stake", sickness/injury routes to Pause,
// and the opt-out is stated plainly. Stage 2 is the LAST email of a lapse.
export function createComebackSender({ apiKey, from } = {}) {
  const sender = from || "The Hypertrophy Bible <onboarding@resend.dev>";

  return async function sendComeback({ email, stage, days, beginner = false }) {
    // Stage 0 is the ACTIVATION note: this person has an account and a plan and has
    // never trained. No streak language, no "you haven't...", nothing to make up —
    // they have lost nothing and done nothing wrong, and the guardrail against
    // shaming applies most sharply to someone who never started. One email, ever.
    const subject = stage === 0
      ? "Your first session, whenever you want it"
      : stage === 2
        ? "The door's open — coming back is built in"
        : "Your next session is ready when you are";
    const body = stage === 0
      ? `<p>Your plan is sitting ready whenever you are. Nothing expires, nothing is waiting on you, and there's no catch-up to do — open it on a day that suits.</p>
         ${beginner ? `<p>Your first session is deliberately short: a handful of exercises, twenty minutes or so. It's for finding the machines and seeing how they feel, not for setting records.</p>` : ""}
         <p>If you'd rather not hear from me, one tap turns these off in the app (Coach tab → Reminders).</p>`
      : stage === 2
      ? `<p>It's been a couple of weeks — which is nothing in a training life. When you open the app, your weights are <b>eased automatically</b> for a smooth re-entry; that's built in, not a favor. One session is all a comeback is.</p>
         <p>If now isn't the time, that's genuinely fine — you can turn these reminders off in the app (Coach tab → Reminders) and your progress stays safely backed up either way. This is the last note we'll send about this break.</p>`
      : `<p>It's been ${days} days — no streak lost, nothing to make up. Your next session is sitting ready, and it adjusts to wherever you're at today.</p>
         <p>Sick or injured? Tap <b>Pause</b> in the app and we'll stay quiet until you're back — pausing never costs you anything.</p>`;
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:24px auto;color:#111">
      <h2 style="margin:0 0 12px">The Hypertrophy Bible</h2>
      ${body}
      <p style="margin:20px 0"><a href="https://hypertrophybible.com" style="display:inline-block;background:#3fd07a;color:#06210f;font-weight:700;padding:14px 24px;border-radius:12px;text-decoration:none">Open today's session</a></p>
      <p style="color:#888;font-size:14px">You're getting this because your progress is backed up to this address. Turn reminders off any time: Coach tab → Reminders. Replies to this address aren't read — this mailbox only sends.</p></div>`;
    if (!apiKey) {
      console.log(`[dev comeback-nudge] stage ${stage} (${days}d) -> ${email}`);
      return { dev: true, ok: true };
    }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: sender, to: email, subject, html }),
      });
      if (!res.ok) { console.log("nudge send failed", res.status, await res.text().catch(() => "")); return { dev: false, ok: false }; }
      return { dev: false, ok: true };
    } catch (e) {
      console.log("nudge send error", String(e));
      return { dev: false, ok: false };
    }
  };
}

// Social-event email fallback (#4 adherence). Web push (nudge/challenge/cheer/
// streak-freeze) only ever reaches a device that granted permission — a real gap
// (push requires "Add to Home Screen" on iOS first, per BLOCKERS.md #4), so a
// user with no live push subscription would otherwise never hear about a
// discrete social event until they happened to reopen the app. Every email-bound
// account gets one, gated the SAME way the push path already is (paused,
// reminders_off, seen-once per-event markers) — this is a second CHANNEL for the
// identical decision, not a new decision, so `subject`/`body` are the exact copy
// already written for the push notification (one source of truth per event,
// never a hand-duplicated string that could drift, per lesson 1).
export function createSocialEmailSender({ apiKey, from } = {}) {
  const sender = from || "The Hypertrophy Bible <onboarding@resend.dev>";

  return async function sendSocialEmail(email, { subject, body }) {
    if (!apiKey) {
      console.log(`[dev social-email] ${email} -> ${subject}: ${body}`);
      return { dev: true, ok: true };
    }
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:24px auto;color:#111">
      <h2 style="margin:0 0 12px">The Hypertrophy Bible</h2>
      <p>${body}</p>
      <p style="margin:20px 0"><a href="https://hypertrophybible.com" style="display:inline-block;background:#3fd07a;color:#06210f;font-weight:700;padding:14px 24px;border-radius:12px;text-decoration:none">Open the app</a></p>
      <p style="color:#888;font-size:14px">Turn these off any time: Coach tab → Reminders. Replies to this address aren't read — this mailbox only sends.</p></div>`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: sender, to: email, subject, html }),
      });
      if (!res.ok) { console.log("social email send failed", res.status, await res.text().catch(() => "")); return { dev: false, ok: false }; }
      return { dev: false, ok: true };
    } catch (e) {
      console.log("social email send error", String(e));
      return { dev: false, ok: false };
    }
  };
}
