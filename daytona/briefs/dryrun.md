---
fitness: cat daytona-dryrun.txt 2>/dev/null || echo 0
fitness_direction: max
model: sonnet
max_budget_usd: 1
max_wall_min: 15
---
# Shared task

This is a PLUMBING TEST for the tournament runner, not a real change — it deliberately touches no
source code. Create a single file at the repository root named `daytona-dryrun.txt` containing
exactly one positive integer and nothing else (no newline-delimited extras, no other files). Do
not modify any other file. Do not run the test suites yourself — the orchestrator does that.

The fitness metric is the integer in that file (higher wins), with a baseline of 0 at HEAD. The
point is to prove fan-out, headless auth, per-variant diff capture, the measure chain (the real
test suites still pass because no source changed), fitness reading, the judge, and teardown.

## Variant: a — small number

Write the integer 10 into `daytona-dryrun.txt`.

## Variant: b — large number

Write the integer 20 into `daytona-dryrun.txt`. (This variant should win.)
