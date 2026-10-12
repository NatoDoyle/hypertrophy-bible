// Signing THIS device in to an account it just proved it owns — ONE implementation
// for both doors: verify.html (the emailed link) and the app's code box (the typed
// 6-digit code, for a link that opened in another browser: on iPhone, Safari's
// storage is separate from the Home-Screen app, so the link alone can never sign
// the app itself in). Dependencies are injected (storage, fetchJson, ask) so the
// whole decision tree runs under Node — app/scripts/test-account-adopt.mjs.
// This file is precached: it is in sw.js's SHELL list.

// Take the account's identity on this device. Nothing is deleted: offline-queued
// workouts are re-pointed at the account so they sync to it, and an in-progress
// session (hb_session) simply carries on under the new identity.
export function adoptAccount(d, { storage }) {
  try {
    const q = JSON.parse(storage.getItem("hb_queue") || "[]");
    if (q.length) storage.setItem("hb_queue", JSON.stringify(q.map((it) => {
      try { return { ...it, body: JSON.stringify({ ...JSON.parse(it.body), user_id: d.user_id }) }; } catch { return it; }
    })));
  } catch (_) {}
  storage.setItem("hb_user", d.user_id);
  storage.setItem("hb_email", d.email);
  if (d.program_name) storage.setItem("hb_program", d.program_name);
  if (d.units) storage.setItem("hb_units", d.units); // a restored device shows kg/lb correctly from the first screen
  // Per-exercise overrides: adopting an account takes ITS map — and when it has
  // none, the previous account's map must not linger on this device.
  if (d.exercise_units && typeof d.exercise_units === "object" && Object.keys(d.exercise_units).length) storage.setItem("hb_ex_units", JSON.stringify(d.exercise_units));
  else storage.removeItem("hb_ex_units");
}

// Decide, asking only when this device holds data of its own, then adopt. Returns
// { adopted, merged }. `beforeAdopt` runs after every question is answered and
// right before the switch (the app uses it to retire the old identity's reminder).
export async function resolveAdoption(d, { current, storage, fetchJson, ask, beforeAdopt = null }) {
  let merged = false;
  if (current && current !== d.user_id) {
    // Does this device hold data of its own? Server-side sessions + bodyweights AND
    // anything still queued offline. If we can't check, assume yes and ask rather
    // than silently discard.
    let localItems = 0, probeFailed = false, queued = 0, otherAccount = null;
    try { queued = JSON.parse(storage.getItem("hb_queue") || "[]").filter((it) => it.path === "/api/session").length; } catch (_) {}
    try {
      // ONE read-only probe: /api/progress carries the counts AND this device's
      // account (never /api/adherence, whose GET advances seen-once watermarks).
      const p = await fetchJson("/api/progress", { headers: { "X-HB-User": current } });
      localItems = (p?.sessions_logged || 0) + (p?.bodyweights_logged || 0) + queued;
      otherAccount = p?.account_email ?? null;
    } catch (_) { probeFailed = true; }
    const hasLocal = localItems > 0 || probeFailed;
    // A device signed in to a DIFFERENT account can't be merged away (the merge route
    // refuses an email-bound source) — offer the switch, never a merge that can't happen.
    if (d.purpose === "restore" && hasLocal && !otherAccount) {
      const wantMerge = await ask("This phone has workouts logged on it. Bring them into your account so nothing is lost?");
      if (wantMerge && d.merge_grant) {
        let m = null;
        try {
          // X-HB-User proves this device holds `from` (the merge retires it, so it
          // demands from-side possession, not just the id in the body).
          m = await fetchJson("/api/auth/merge", { method: "POST", headers: { "content-type": "application/json", "X-HB-User": current },
            body: JSON.stringify({ grant: d.merge_grant, from_user_id: current, to_user_id: d.user_id }) });
        } catch (_) {}
        if (m?.merged) merged = true;
        else if (!(await ask("Couldn't bring the already-saved workouts across right now. Switch to your account anyway? (Workouts waiting offline still follow; ones already synced stay behind.)"))) return { adopted: false, merged: false };
      } else if (!wantMerge) {
        if (!(await ask(`Switch this phone to ${d.email} without them? Workouts already synced on this phone stay behind.`))) return { adopted: false, merged: false };
      }
    } else if (hasLocal) {
      const q = otherAccount
        ? `This phone is signed in to ${otherAccount}. Switch it to ${d.email}? That account stays saved to its own email.`
        : `This phone already has data. Signing in to ${d.email} will switch this phone to that account. Continue?`;
      if (!(await ask(q))) return { adopted: false, merged: false };
    }
  }
  if (beforeAdopt) await beforeAdopt({ merged });
  adoptAccount(d, { storage });
  return { adopted: true, merged };
}

// What to tell the person once it's done — the same promise the email made.
export function adoptionMessage(d, { merged = false } = {}) {
  if (d.purpose !== "restore") return { title: "You're all set 💪", sub: `Your progress is saved to ${d.email}.` };
  const plan = d.program_name ? ` Your saved plan, “${d.program_name}”, is back.` : "";
  return { title: "You're signed in 💪", sub: (merged ? "This phone's workouts are in your account now." : `This phone now uses your account for ${d.email}.`) + plan };
}

// An iPhone/iPad Safari TAB (not the Home-Screen app). iPadOS reports a desktop
// "MacIntel" platform, so touch points tell it apart from a real Mac.
export function isIOSBrowserTab({ userAgent = "", platform = "", maxTouchPoints = 0, standalone = false } = {}) {
  const iOS = /iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  return iOS && !standalone;
}

// The identity this phone LEAVES must stop sending it reminders. Skipped when there's
// nothing to retire: no previous identity, the same one, a merge (its push
// subscription moved to the account with the rest of its data), or no reminder on.
// A failed unsubscribe never blocks the sign-in (the code is single-use — refusing
// here would strand the user); either way hb_push is cleared, so Me never claims
// reminders are on for an account that has no subscription. Returns a note to show.
export async function retireOldReminder({ before, newUser, merged, storage, remove }) {
  if (!before || before === newUser || merged || storage.getItem("hb_push") !== "1") return "";
  let failed = false;
  try { await remove(before); } catch (_) { failed = true; }
  storage.removeItem("hb_push");
  return failed
    ? " This phone may still get a reminder meant for its old setup — turn reminders on in Me to move them to your account."
    : " Reminders on this phone belonged to its old setup, so they're off now — turn them back on in Me.";
}

// verify.html's first decision. An iPhone/iPad Safari TAB asks before spending the
// credential: on iOS this page can never reach the Home-Screen app, and the link and
// the code are ONE single-use credential, so consuming here would kill the code.
export function verifyBootAction({ token, iosTab }) {
  if (!token) return "missing";
  return iosTab ? "ask" : "consume";
}

// "I've sent you a code" outlives a re-render, a tab switch and an evicted PWA: the
// address is remembered for the code's 30 minutes so a code box can be offered again
// (resending would only mint a NEW code and retire the one in the user's inbox).
export const CODE_PENDING_MS = 30 * 60 * 1000;
export function rememberPendingCode(storage, email, nowMs) {
  try { storage.setItem("hb_code_pending", JSON.stringify({ email, at: nowMs })); } catch (_) {}
}
export function pendingCode(storage, nowMs) {
  let v = null;
  try { v = JSON.parse(storage.getItem("hb_code_pending") || "null"); } catch (_) { v = null; }
  if (!v || typeof v.email !== "string" || !Number.isFinite(v.at)) return null;
  if (nowMs - v.at > CODE_PENDING_MS) { try { storage.removeItem("hb_code_pending"); } catch (_) {} return null; }
  return { email: v.email };
}
export function clearPendingCode(storage) { try { storage.removeItem("hb_code_pending"); } catch (_) {} }
