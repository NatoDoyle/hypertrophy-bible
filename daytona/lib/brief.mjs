// Minimal brief parser — no YAML dependency (keeps the tooling's only dep @daytona/sdk).
//
// Format:
//   ---
//   fitness: node tools/test-plan.mjs | tail -1     # last stdout line must contain the metric number
//   fitness_direction: min                          # min | max
//   model: sonnet
//   max_budget_usd: 8                               # per-variant Claude API spend cap
//   max_wall_min: 45
//   ---
//   # Shared task
//   <spec every variant receives>
//
//   ## Variant: a — lengthened-bias-first
//   <instructions unique to variant a>
//
//   ## Variant: b — equipment-quality-first
//   <instructions unique to variant b>

import { readFileSync } from 'node:fs';

const VARIANT_RE = /^##\s+Variant:\s*(\S+)\s*[—-]\s*(.*)$/;

export function parseBrief(path) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');

  if (lines[0].trim() !== '---') throw new Error(`brief must start with a --- front-matter block: ${path}`);
  let i = 1;
  const meta = {};
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') { i++; break; }
    const m = lines[i].match(/^([a-z_]+):\s*(.*)$/i);
    if (m) meta[m[1]] = m[2].trim();
  }

  // Defaults + validation.
  const fitness = meta.fitness;
  if (!fitness) throw new Error('brief front-matter is missing `fitness:` (the measured metric command)');
  const direction = (meta.fitness_direction || 'max').toLowerCase();
  if (direction !== 'min' && direction !== 'max') throw new Error('fitness_direction must be `min` or `max`');
  const model = meta.model || 'sonnet';
  const maxBudgetUsd = Number(meta.max_budget_usd || 8);
  const maxWallMin = Number(meta.max_wall_min || 45);

  // Body → shared task + variant sections.
  const body = lines.slice(i);
  const variants = [];
  let sharedEnd = body.length;
  const starts = [];
  for (let j = 0; j < body.length; j++) {
    const m = body[j].match(VARIANT_RE);
    if (m) { starts.push({ j, id: m[1], title: m[2].trim() }); if (starts.length === 1) sharedEnd = j; }
  }
  if (starts.length < 2) throw new Error('a tournament needs at least 2 `## Variant: <id> — <title>` sections (reading could settle a 1-variant task)');

  const shared = body.slice(0, sharedEnd).join('\n').trim();
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k].j + 1;
    const to = k + 1 < starts.length ? starts[k + 1].j : body.length;
    variants.push({ id: starts[k].id, title: starts[k].title, instructions: body.slice(from, to).join('\n').trim() });
  }
  const ids = variants.map((v) => v.id);
  if (new Set(ids).size !== ids.length) throw new Error(`variant ids must be unique: ${ids.join(', ')}`);

  return { fitness, direction, model, maxBudgetUsd, maxWallMin, shared, variants };
}

// The per-variant prompt handed to headless Claude. The preamble makes the sandbox's structural
// constraints explicit (no push/deploy — there is no remote and no prod credential anyway).
export function variantPrompt(brief, variant) {
  return [
    'You are implementing one variant of a tournament inside a disposable sandbox.',
    'Hard rules: do NOT deploy, do NOT push, do NOT create PRs — there is no git remote and no',
    'production credential here. Make your changes on the working tree and leave them uncommitted;',
    'the orchestrator commits and measures them. Follow the repo\'s own CLAUDE.md and STYLE.md.',
    '',
    '# Shared task',
    brief.shared,
    '',
    `# Your variant: ${variant.id} — ${variant.title}`,
    variant.instructions,
  ].join('\n');
}
