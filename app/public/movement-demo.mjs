// Pure movement_pattern → inline demo mapping — no DOM — so it can be unit-tested
// in Node exactly as it renders in the browser (same pattern as session-core.mjs).
//
// This is the v0, self-buildable stand-in for real per-exercise footage, which is
// blocked on the human (licensed/filmed media — see BLOCKERS.md #1: "I can't
// fabricate demo footage and I won't hotlink someone's video without a licence").
// Every exercise already carries a movement_pattern, so keying the demo off that
// (instead of a new per-exercise field) gives all 171 exercises an inline demo
// today with zero new data to author, verify, or keep in sync. A future per-
// exercise `media` override (real clips, once BLOCKERS #1 unblocks) would read
// this as its fallback, not replace it.
//
// Each entry is [kind, caption]. `kind` selects the CSS animation (defined in
// styles.css): "bounce" translates the glyph vertically, "side" reuses the same
// bounce rotated 90° (so left/right and up/down share one keyframe set), "bend"
// rotates it, "pulse" is a neutral breathing fallback for anything ambiguous.
// The caption carries the specifics — the glyph is a supplementary, animated cue,
// never the only channel (never rely on it alone to disambiguate direction).
export const MOVEMENT_DEMO = {
  "horizontal-push": ["side", "Press away from your body, then return."],
  "vertical-push": ["bounce", "Press up overhead, then return."],
  "horizontal-pull": ["side", "Pull toward your body, then return."],
  "vertical-pull": ["bounce", "Pull down toward your body, then return."],
  "squat": ["bend", "Bend your knees and hips down, then drive back up."],
  "hinge": ["bend", "Push your hips back, then drive them forward to stand."],
  "lunge": ["bend", "Step down and bend the front knee, then push back up."],
  "carry": ["side", "Walk with control, staying tall and braced."],
  "isolation-elbow-flexion": ["bend", "Curl your forearm up, then lower with control."],
  "isolation-elbow-extension": ["bend", "Extend your forearm straight, then bend back."],
  "isolation-knee-extension": ["bend", "Extend your lower leg straight, then lower."],
  "isolation-knee-flexion": ["bend", "Curl your heel toward your hip, then lower."],
  "isolation-hip-extension": ["bend", "Drive your leg back, then return."],
  "isolation-hip-abduction": ["bend", "Push your leg out to the side, then return."],
  "isolation-shoulder-abduction": ["bounce", "Raise your arm out to the side, then lower."],
  "isolation-shoulder-flexion": ["bounce", "Raise your arm forward, then lower."],
  "isolation-shoulder-extension": ["bend", "Drive your arm back behind you, then return."],
  "isolation-plantarflexion": ["bounce", "Rise onto your toes, then lower."],
  "isolation-wrist": ["bend", "Curl your wrist up, then lower with control."],
  "isolation-spinal-flexion": ["bend", "Curl your torso in, then extend back out."],
  "isolation-neck": ["bend", "Move your head through the range, then return."],
  "isolation-other": ["pulse", "Move through a controlled range, then return."],
  "other": ["pulse", "Move through a controlled range, then return."],
};

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// A tiny static line-art figure (the same one every time — it's not what moves)
// plus one animated glyph conveying the plane of motion, and a plain-language
// caption. `pattern` is any movement_pattern value or nullish; unknown/missing
// falls back to "other" so every exercise renders something.
export function renderMovementDemo(pattern) {
  const [kind, caption] = MOVEMENT_DEMO[pattern] || MOVEMENT_DEMO.other;
  const rotated = kind === "side"; // "side" = the vertical bounce, rotated 90°
  const cssKind = rotated ? "bounce" : kind;
  const arrow = cssKind === "pulse"
    ? `<circle class="hb-pulse" cx="16" cy="16" r="6"/>`
    : `<polyline class="${cssKind === "bend" ? "hb-bend" : "hb-bounce"}" points="8,20 16,8 24,20"/>`;
  return `<div class="demo">
    <div class="demo-fig" aria-hidden="true">
      <svg class="hb-figure" viewBox="0 0 60 60" width="40" height="40" focusable="false">
        <circle cx="30" cy="10" r="6"/><line x1="30" y1="16" x2="30" y2="36"/>
        <line x1="30" y1="20" x2="16" y2="30"/><line x1="30" y1="20" x2="44" y2="30"/>
        <line x1="30" y1="36" x2="18" y2="56"/><line x1="30" y1="36" x2="42" y2="56"/>
      </svg>
      <svg class="hb-arrow${rotated ? " rot90" : ""}" viewBox="0 0 32 32" width="22" height="22" focusable="false">${arrow}</svg>
    </div>
    <p class="muted demo-caption">${escHtml(caption)}</p>
  </div>`;
}
