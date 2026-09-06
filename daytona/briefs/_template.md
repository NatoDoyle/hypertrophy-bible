---
fitness: node tools/some-measure.mjs | tail -1
fitness_direction: min
model: sonnet
max_budget_usd: 8
max_wall_min: 45
---
# Shared task

Describe the ONE task every variant implements. Keep the *what* identical across variants — only
the *approach* differs. State the acceptance bar in the repo's own terms (both test chains must
stay green; no new deps at root; follow CLAUDE.md and STYLE.md).

A tournament is only worth running when ≥2 approaches are genuinely defensible and reading the
code can't settle which wins — and when the winner can be judged by a NUMBER that already exists
at HEAD. Good fitness commands for this repo (each must print the metric on its last stdout line):

  - critiquePlan issue count across the generation matrix
  - zero-volume-config count from a plan-generation sweep
  - fragmentation % from the same sweep
  - a passing-test count from tools/test-plan.mjs or app/scripts/test-*.mjs

The metric must move in a direction that means "better training", not just "nicer diff" — the
engine is science-grounded, so never let a variant game the number against the KB (lessons 13/30).

## Variant: a — <short approach name>

Instructions unique to approach A. Be specific about the strategy, not the outcome.

## Variant: b — <short approach name>

Instructions unique to approach B.
