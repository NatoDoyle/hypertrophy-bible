#!/usr/bin/env node
// Markdown-emphasis gate (app/scripts/gen-learn-data.mjs's `inline()` is the Learn tab's
// entire renderer, and it only understands a specific asterisk subset — see CLAUDE.md's
// "Markdown emphasis" rule). Two source-authoring mistakes silently break Learn-tab
// rendering without failing any existing gate:
//
//   1. Underscore italics (`_word_`) — the renderer has no underscore handling at all, so
//      the literal underscores render to the user instead of italics. (Caught one real
//      instance in periodization-and-progression.md, introduced by the Wave-133 taper
//      addition — GitHub/site markdown renders `_word_` as italic, so it read fine
//      everywhere except the one renderer that actually ships to users.)
//   2. `**bold *italic***` overlap — gen-learn-data.mjs's bold regex is non-greedy and its
//      italic pass runs after, so a `*italic*` ending flush against the bold's closing `**`
//      (i.e. a literal `***`) produces mismatched/overlapping <strong>/<em> tags.
//
// FAILS (exit 1) on either pattern in content/**/*.md.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, pred) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, pred));
    else if (pred(p)) out.push(p);
  }
  return out;
}

// Matches a `_..._` span that isn't part of a longer identifier/snake_case word on either
// side (so `some_variable_name` in inline code-ish prose doesn't false-positive).
const UNDERSCORE_ITALIC = /(?<![\w\\])_[^_\n]+_(?!\w)/;
const TRIPLE_ASTERISK = /\*\*\*/;

const files = walk(join(root, "content"), (p) => p.endsWith(".md"));
const offenders = [];
for (const f of files) {
  const rel = relative(root, f).split("\\").join("/");
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, idx) => {
    if (UNDERSCORE_ITALIC.test(line)) offenders.push({ rel, line: idx + 1, kind: "underscore-italic", text: line.trim() });
    if (TRIPLE_ASTERISK.test(line)) offenders.push({ rel, line: idx + 1, kind: "bold-italic-overlap (***)", text: line.trim() });
  });
}

if (offenders.length) {
  console.error(`markdown-emphasis: ${offenders.length} line(s) use emphasis the Learn-tab renderer can't handle:`);
  for (const o of offenders) console.error(`  - ${o.rel}:${o.line} [${o.kind}] ${o.text}`);
  console.error(`Fix: use *asterisk* italics only, and never let *italic* end flush against **bold**'s closing`);
  console.error(`delimiter (rewrite so no literal *** appears) — see CLAUDE.md's "Markdown emphasis" rule.`);
  process.exit(1);
}
console.log(`markdown-emphasis: ${files.length} content pages checked; 0 renderer-breaking emphasis patterns.`);
