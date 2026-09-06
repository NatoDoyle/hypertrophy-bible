# Considerations - thoughts, ideas, suggestions and questions for consideration

Goal: to make note of my thoughts, ideas, suggestions and questions so that they can be taken into consideration for implementation. 

Everything below should be taken under consideration for implementation. Once it has been thoroughly considered against the goals of the project, the recommended actions should be implemented and then delete the consideration 

*(No open considerations. All three handled in Waves 262–264 (2026-09-06):*

*• "Type in my weight and reps" + "change the weight to lbs because some machines use lbs" —
DONE as Wave 262, designed together. The value between the − / + stepper buttons is now a real
type-able input in both players (typing is the fast path for a big jump; steppers stay for
nudges; an emptied field restores the last good value on blur). The unit label beside the
weight is a tappable per-exercise kg↔lb toggle for the mixed-unit gym — a machine's lb stack
flips to lb while the bars stay kg, remembered for future sessions (`profile.exercise_units`
via its own narrow route, mirrored per-device, inherited by new devices via /api/today). The
global Me → Units switch already existed and is unchanged. Storage stays kg everywhere — the
override is display/entry-only; each in-progress session stamps the unit per entry and one
pure, unit-tested migration converts on any flip, so est-1RM/PRs/stall detection/suggestions
never see a pound. Adversarially reviewed (3 lenses, 11 findings → 9 fixed, 2 accepted +
documented); 19 + 4 Playwright checks including the typo-confirm × typed-input interplay,
mixed-unit superset rounds, and crash-resume.*

*• "Some exercises, e.g. the kettlebell lateral raise, are missing the page that explains
when to use them" — DONE as Waves 263–264, and the audit overturned the premise: the content
was never missing (all 171 exercises carry cues, steps, good-pick-when/skip-when), it was
UNREACHABLE — the Plan tab resolved sheets against the 64 prose-referenced bundle only, so
107 lifts (all smith-machine, 12/14 kettlebell, 18/21 band) got a false "No guide for this
one" toast. Now every exercise's sheet is bundled (owner chose full offline parity over
~180 KB raw bundle growth), the Plan tab falls back to the API for custom lifts, the coverage
gate is a corpus-derived floor instead of a frozen `=== 64` (which had frozen the gap in
place), and the authored-but-never-displayed `progressions`/`regressions` on ~141 exercises
now render as "Make it easier / Make it harder" on the sheet. Deferred, recorded: `rom_notes`
(28/171, the sheet already shows "Where it's hardest") and richer per-exercise prose pages.)*
