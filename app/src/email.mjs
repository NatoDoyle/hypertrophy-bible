// Magic-link email sender. With a Resend API key it sends real mail; without one
// (local dev, or prod before a domain is verified) it logs the link and returns
// it, so the whole flow is testable without sending anything. Injected into the
// Hono app, so the app itself stays runtime-agnostic.
export function createEmailSender({ apiKey, from } = {}) {
  const sender = from || "The Hypertrophy Bible <onboarding@resend.dev>";

  return async function sendMagicLink({ email, link, purpose }) {
    if (!apiKey) {
      console.log(`[dev magic-link] (${purpose}) ${email} -> ${link}`);
      return { dev: true, link };
    }
    const restore = purpose === "restore";
    const subject = restore ? "Restore your Hypertrophy Bible progress" : "Back up your Hypertrophy Bible progress";
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:24px auto;color:#111">
      <h2 style="margin:0 0 12px">The Hypertrophy Bible</h2>
      <p>Tap below to ${restore ? "restore your progress on this device" : "back up your progress"}. This link works once and expires in 30 minutes.</p>
      <p style="margin:20px 0"><a href="${link}" style="display:inline-block;background:#3fd07a;color:#06210f;font-weight:700;padding:14px 24px;border-radius:12px;text-decoration:none">${restore ? "Restore progress" : "Back up progress"}</a></p>
      <p style="color:#888;font-size:14px">If you didn't request this, you can safely ignore it.</p></div>`;

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
