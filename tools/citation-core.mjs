// The one rule for "is this footnote marker a REFERENCE or a DEFINITION?".
//
// It lives in its own module for the same reason movement-core and graph-core do:
// a gate whose predicate cannot be unit-tested is a gate nobody can falsify.
//
// The bug this exists to prevent, recorded because it disarmed the project's
// number-one guardrail for ten waves:
//
//   const refRe = /\[\^([^\]]+)\](?!:)/g;   // "reference, not a definition"
//
// The intent was "skip definition lines". What it delivered was "skip any marker
// followed by a colon" — and a colon is ordinary prose punctuation. A page reading
//
//   The consensus distinguishes three states[^meeusen-2013-overtraining-consensus]:
//
// therefore had NO reference at all, as far as the gate could see. Two consequences,
// and the harmless one is the one that got noticed:
//   - the cited entry was reported as a never-referenced orphan on every run since
//     the page was authored — a warning that was ALWAYS wrong, which is how a report
//     line trains everyone to skip it;
//   - far worse, the same expression feeds the dangling-reference and
//     missing-definition ERRORS. A FABRICATED key followed by a colon tripped
//     neither. "Never fabricate a citation" is the first guardrail in
//     improvement-loop.md, and it had a hole shaped like a punctuation mark.
//
// The fix is not a cleverer lookahead. A definition is identified by its POSITION —
// it is a marker at the start of a line, which `DEFINITION_RE`'s `^` already says
// exactly. So the reference scan must not try to re-derive that from the character
// that happens to follow; it strips the definition lines and reads what is left.
// An exclusion rule must never key on something that also appears in valid input.

export const DEFINITION_RE = /^[ \t]*\[\^([^\]\s]+)\]:/gm;
const MARKER_RE = /\[\^([^\]]+)\]/g;

// A definition line, whole: from the marker at line start to the end of that line.
// Removing it (rather than skipping matches inside it) means the reference scan
// never has to reason about what follows a marker at all.
const DEFINITION_LINE_RE = /^[ \t]*\[\^[^\]\s]+\]:.*$/gm;

/** Keys DEFINED on this page (`[^key]: Author (Year)...` at the start of a line). */
export function definitionKeys(markdown) {
  return new Set([...String(markdown ?? "").matchAll(DEFINITION_RE)].map((m) => m[1]));
}

/** Keys REFERENCED from this page's prose — every marker that is not a definition. */
export function referenceKeys(markdown) {
  const prose = String(markdown ?? "").replace(DEFINITION_LINE_RE, "");
  return new Set([...prose.matchAll(MARKER_RE)].map((m) => m[1]));
}
