// The prose-recommends-a-liftable-movement gate (Tier-1 #1, Wave 204) — pure core.
//
// The incident class is real: chest.md prescribed a "low-to-high cable fly" for waves
// and no such exercise exists in data/exercises, so the app could never program its
// own KB's advice. It was caught only by a human read (Wave 188). LINKED picks
// ([Name](../../data/exercises/id.json)) are already existence-checked by
// check-links; the hole is a movement recommended as PLAIN TEXT. A rule that lives
// in prose is not enforced (lessons 25/33) — this module enforces it.
//
// Shape of the check: find movement-noun phrases in RENDERED prose (same
// stripNonRendered the graph and depth gates use — the metric and the product must
// agree about what the reader sees, lesson 30), extend each head noun leftward over
// a curated modifier vocabulary, and require the WHOLE phrase to resolve against
// data/exercises names/ids or the deliberate alias map below. There is NO
// suffix fallback by design: "low-to-high cable fly" must never pass because a
// shorter suffix happens to exist — the whole point is that the SPECIFIC movement
// the prose names must be programmable.
//
// What the extractor deliberately does NOT flag:
//   - bare head nouns ("one horizontal pull (row)", "a fly removes them") —
//     category prose, not a specific recommendation;
//   - anatomy actions (joint word + extension/flexion/rotation: "shoulder
//     extension" is a job description, not a movement);
//   - linked text (the link gates own those).
// Every narrowing is REPORTED as a count by the CLI, never silently applied
// (lesson 35): exercises whose names end in a noun the extractor doesn't know are
// its blind spot, and that number is printed.

import { stripNonRendered } from "./graph-core.mjs";

// Movement head nouns, post-normalization. Deliberately tight: high-signal
// exercise-final nouns only — every widening buys recall at a noise cost the
// measured run must justify.
export const HEAD_NOUNS = new Set([
  "press", "row", "fly", "raise", "curl", "pulldown", "pullover", "pullthrough",
  "squat", "deadlift", "lunge", "shrug", "dip", "crossover", "kickback",
  "pushdown", "extension", "hyperextension", "crunch", "plank", "carry",
  "bridge", "thrust", "swing", "twist", "woodchop", "rdl",
  "pull-up", "chin-up", "push-up", "step-up", "sit-up", "face-pull",
]);

// Tokens that may EXTEND a phrase leftward from a head noun: equipment, implement,
// position, grip, angle and body-region words that genuinely change which movement
// is meant. Degree adjectives ("heavy", "strict") are deliberately absent — they
// don't change the movement, so they simply stop the extension and never need a
// stop-list. Any hyphenated token also extends (a hyphenated compound directly
// before a movement noun — "chest-supported", "low-to-high" — is nearly always a
// movement modifier).
export const MODIFIER_VOCAB = new Set([
  "barbell", "dumbbell", "cable", "machine", "band", "kettlebell", "smith",
  "bodyweight", "weighted", "suspension", "trap-bar", "ez-bar", "landmine",
  "incline", "decline", "flat", "seated", "standing", "lying", "prone", "supine",
  "overhead", "front", "back", "reverse", "lateral", "upright", "vertical",
  "horizontal", "romanian", "bulgarian", "nordic", "sumo", "conventional",
  "hack", "goblet", "zercher", "preacher", "hammer", "concentration", "pendlay",
  "leg", "calf", "hip", "glute", "chest", "shoulder", "military", "bench",
  "triceps", "tricep", "biceps", "bicep", "hamstring", "spanish", "sissy",
  "pallof", "russian", "farmers", "walking", "split", "pistol", "jump",
  "pause", "paused", "deficit", "rack", "floor", "board", "pin",
  "close", "wide", "narrow", "neutral", "underhand", "overhand", "mixed",
  "single", "double", "alternating", "unilateral", "iso", "machine-assisted",
  "assisted", "banded", "straight", "bent", "stiff", "good-morning", "cross-body",
  "skull", "rear", "side", "wall", "copenhagen", "reverse-grip", "high", "low",
  // "block" is deliberately ABSENT: the measured first run's only hit was the verb
  // in "clothing that blocks squat depth" (a false flag), and no real phrase in
  // the corpus needs it — an entry that only ever fires wrongly is worse than none.
]);

// Joint/anatomy words that combine with an action noun to describe a JOB, not a
// movement ("shoulder extension and adduction"). Only these pairs are excluded —
// "back extension" and "leg extension" are real exercises and stay in play.
const ANATOMY_JOINTS = new Set(["shoulder", "hip", "elbow", "knee", "wrist", "ankle", "spinal", "lumbar", "trunk", "torso"]);
const ANATOMY_ACTIONS = new Set(["extension", "flexion", "rotation", "raise"]);

// The deliberate mapping layer: prose spellings that are NOT an exercise's name or
// id but unambiguously mean one. Every value must be a real data/exercises id — the
// CLI fails on a dangling target, and a stale alias (one no longer used anywhere in
// the corpus) fails too, so the escape hatch can't quietly widen (lesson 43).
// Calibrated from the measured first run (2026-08-09, lesson 30): 93 pages,
// 125 candidate phrases, 45 resolved raw, 61 flags — every flag then read in
// context and classified. Every entry below is a spelling the corpus ACTUALLY
// uses whose meaning is one unambiguous exercise; category phrases go in
// MOVEMENT_GENERIC_OK instead, and one flag ("block squat") was tokenizer noise
// fixed in MODIFIER_VOCAB. Zero flags were real missing movements — Wave 188
// removed the known incident, and this gate exists so the next one can't ship.
export const MOVEMENT_ALIASES = new Map([
  ["bench press", "barbell-bench-press"],             // the unqualified default everywhere
  ["flat barbell bench press", "barbell-bench-press"],// "flat" disambiguates from incline; the id IS the flat lift
  ["back squat", "barbell-back-squat"],
  ["overhead press", "barbell-overhead-press"],
  ["standing overhead press", "barbell-overhead-press"], // it is performed standing
  ["seated row", "seated-cable-row"],
  ["dumbbell row", "single-arm-dumbbell-row"],
  ["nordic curl", "nordic-hamstring-curl"],
  ["banded pulldown", "band-lat-pulldown"],
  ["cable fly", "cable-crossover"],                   // same movement, the DB's name for it
  ["machine fly", "pec-deck"],
  ["machine reverse fly", "reverse-pec-deck"],
  ["chest press", "machine-chest-press"],             // every corpus use is a machine context
  ["incline curl", "incline-dumbbell-curl"],
  ["close-grip press", "close-grip-bench-press"],
  ["pronated-grip curl", "reverse-curl"],             // a pronated grip IS the reverse curl
  ["lateral raise", "dumbbell-lateral-raise"],        // the unqualified default implement
  ["front raise", "dumbbell-front-raise"],
  ["dumbbell raise", "dumbbell-lateral-raise"],       // shoulders.md ellipsis in a side-delt passage
  ["lying curl", "lying-leg-curl"],                   // both corpus uses are leg-curl passages
  ["standing raise", "standing-calf-raise"],          // legs.md calf table ellipses
  ["seated raise", "seated-calf-raise"],
]);

// Phrases with modifiers that are legitimately GENERIC — a category several real
// exercises implement, recommended as a category on purpose. Each entry carries a
// justification (same contract as DEPTH_EXEMPT) and, like aliases, goes stale-red
// when the corpus stops using it.
export const MOVEMENT_GENERIC_OK = new Map([
  ["leg curl", "a category two machines implement (seated-leg-curl, lying-leg-curl); pages deliberately recommend the class and let equipment decide"],
  ["bicep curl", "the generic elbow-flexion category — barbell/cable/hammer/incline curls all implement it; everyday shorthand in beginner prose"],
  ["calf raise", "a category with standing/seated/donkey/leg-press implementations; prose recommends the class"],
  ["machine press", "any stack-loaded press (machine-chest-press, machine-shoulder-press); the prose's point is the machine, not which press"],
  ["chest fly", "the fly category (dumbbell-fly, pec-deck, band-chest-fly, cable-crossover); ROM prose discusses the movement class"],
  ["incline press", "both incline presses implement it (incline-dumbbell-press, incline-barbell-bench-press); the page's own pick list links both"],
  ["neutral press", "chest.md's 'flat/neutral press' session slot — a category its pick list fills with specific linked exercises"],
  ["dumbbell press", "any dumbbell press (bench/incline/shoulder); the prose discusses the implement class, not one lift"],
  ["overhead tricep extension", "four implement variants exist (cable/dumbbell/kettlebell/band); no implement-free id, and the prose means the class"],
  ["overhead extension", "elliptical for the overhead triceps-extension class, same four implementations as above"],
  ["partial-range extension", "range-of-motion technique prose about partial-ROM work, not a movement recommendation"],
  ["standing press", "core.md's bracing list means any standing overhead press (barbell/kettlebell/band); the brace is the point, not the implement"],
  ["behind-the-body curl", "the behind-torso curl position family (bayesian-cable-curl implements it); the page's finding is that the position does NOT matter"],
  ["knee-flexion curl", "legs.md's functional label for the leg-curl class; the adjacent prose names the seated/lying machines"],
  ["straight-leg raise", "the straight-knee calf-raise class (standing/donkey/leg-press variants) — knee angle is the boundary the prose is teaching"],
  ["bodyweight crunch", "progression prose: the unloaded version of weighted-crunch before load is added; deliberately not a separate DB entry"],
]);

// ENFORCED from the wave that added it (Wave 204): the measured first run's 61
// flags were all read in context and classified (22 aliases, 16 justified
// generics, 1 tokenizer fix), landing the bar green honestly — lesson 25's flip
// rule permits same-wave enforcement exactly when the authoring makes it pass
// (the Wave-159 link-gate precedent). Stale/dangling alias and generic entries
// fail red regardless of this flag, so the escape hatches can't quietly widen.
export const MOVEMENT_GATE = { warnOnly: false };

// --- normalization -----------------------------------------------------------

const TOKEN_CANON = new Map([
  ["flye", "fly"], ["flyes", "fly"], ["flies", "fly"],
  ["pullup", "pull-up"], ["pullups", "pull-up"], ["pull-ups", "pull-up"],
  ["chinup", "chin-up"], ["chinups", "chin-up"], ["chin-ups", "chin-up"],
  ["pushup", "push-up"], ["pushups", "push-up"], ["push-ups", "push-up"],
  ["stepup", "step-up"], ["stepups", "step-up"], ["step-ups", "step-up"],
  ["situp", "sit-up"], ["situps", "sit-up"], ["sit-ups", "sit-up"],
  ["face-pulls", "face-pull"], ["facepull", "face-pull"], ["facepulls", "face-pull"],
  ["rdls", "rdl"], ["farmer", "farmers"], ["farmer's", "farmers"],
]);

// Singular-ize one token: -ches/-shes/-sses/-xes drop "es"; a plain trailing "s"
// drops unless the word ends in "ss" (press) or is too short to be a plural.
function singular(tok) {
  if (/(ch|sh|ss|x)es$/.test(tok)) return tok.slice(0, -2);
  if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1);
  return tok;
}

export function normToken(raw) {
  let t = raw.toLowerCase().replace(/'/g, "");
  t = TOKEN_CANON.get(t) ?? t;
  t = singular(t);
  return TOKEN_CANON.get(t) ?? t;
}

// A whole name/phrase → its canonical space-joined token form. Hyphens survive
// inside tokens only when the canon map says the compound is one word (pull-up);
// otherwise "chest-supported" stays a single hyphenated token so it can extend a
// phrase, and lexicon names hyphenate identically because both sides pass through
// here.
export function normPhrase(s) {
  return tokenize(s).filter((t) => t !== "¶").join(" ");
}

// Tokenize prose into normalized tokens with "¶" boundaries at anything that ends
// a phrase: punctuation, brackets, digits, slashes (alternation lists). Bare
// whitespace — including a soft-wrapped newline mid-sentence — deliberately does
// NOT break a phrase: markdown re-flows it, and every structural break (heading,
// bullet, table pipe) carries its own punctuation boundary anyway.
export function tokenize(text) {
  const out = [];
  for (const piece of text.split(/([a-zA-Z][a-zA-Z'-]*)/)) {
    if (/^[a-zA-Z]/.test(piece)) out.push(normToken(piece));
    else if (/\S/.test(piece)) out.push("¶");
  }
  return out;
}

// --- lexicon -----------------------------------------------------------------

// Map of normalized phrase → exercise id, from names and ids only. The alias
// layer is resolved SECOND and tracked separately, so an alias that merely
// shadows a real name (or that the corpus stopped using) reads as stale instead
// of silently passing as "used".
export function buildLexicon(exercises) {
  const lex = new Map();
  for (const ex of exercises) {
    lex.set(normPhrase(ex.name ?? ex.id), ex.id);
    lex.set(normPhrase(ex.id.replace(/-/g, " ")), ex.id);
  }
  return lex;
}

// Exercises the extractor could never SEE AND RESOLVE from prose — the gate's
// blind spot, reported as a count by the CLI (lesson 35: a narrowing must be a
// number, never silent). Measured the honest way: run the extractor over the
// exercise's own name (and its id written as words) and ask whether any
// extracted phrase resolves. A name with no head noun anywhere ("Good Morning",
// "Bird Dog", "Farmer's Walk") is blind — and so is one whose head noun is
// UNREACHABLE ("Neck Curl": "curl" is a head noun, but "neck" extends no
// phrase, so prose naming it always reads as a bare head noun and is skipped).
// The first shipped version counted any-token head-noun presence and printed
// 17/171 — a 3× under-report. This semantics measures 52/171 on the same corpus
// (lesson 30: record the distribution at the moment the measure is set), in
// three classes: no head noun anywhere (good-morning, pec-deck, skullcrusher);
// names that ARE a bare head noun, which prose can only ever mention in the
// deliberately-skipped bare form (pull-up, plank, face-pull); and a reachable
// head noun behind a modifier the extractor doesn't know (arnold-press,
// lat-pulldown, zottman-curl, neck-curl). All three are real narrowings — a
// movement in these 52 could leave the DB while prose still recommends it and
// this gate would stay green.
export function extractorBlindSpot(exercises) {
  const lex = buildLexicon(exercises);
  return exercises
    .filter((ex) => {
      const forms = [ex.name ?? ex.id, ex.id.replace(/-/g, " ")];
      return !forms.some((form) => extractCandidates(form).some((p) => lex.has(p)));
    })
    .map((ex) => ex.id);
}

// --- extraction + resolution -------------------------------------------------

const MAX_MODIFIERS = 5;

// All candidate movement phrases in one page's markdown. Links are removed whole
// (text AND target — the link gates own those); inline code likewise.
export function extractCandidates(md) {
  const prose = stripNonRendered(md)
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, " ¶ ")
    .replace(/`[^`]*`/g, " ¶ ");
  const toks = tokenize(prose);
  const found = [];
  for (let i = 0; i < toks.length; i++) {
    if (!HEAD_NOUNS.has(toks[i])) continue;
    let j = i;
    while (
      j > 0 && i - j < MAX_MODIFIERS &&
      toks[j - 1] !== "¶" && !HEAD_NOUNS.has(toks[j - 1]) &&
      (MODIFIER_VOCAB.has(toks[j - 1]) || toks[j - 1].includes("-"))
    ) j--;
    if (j === i) continue; // bare head noun — category prose, never a specific pick
    if (i - j === 1 && ANATOMY_JOINTS.has(toks[j]) && ANATOMY_ACTIONS.has(toks[i])) continue;
    found.push(toks.slice(j, i + 1).join(" "));
  }
  return found;
}

// Classify every candidate on every page. Returns per-page flags plus corpus-wide
// usage sets so the CLI can detect stale aliases/generic entries.
export function checkMovements(pages, exercises, {
  aliases = MOVEMENT_ALIASES, genericOk = MOVEMENT_GENERIC_OK,
} = {}) {
  const lex = buildLexicon(exercises);
  const ids = new Set(exercises.map((e) => e.id));
  const aliasByPhrase = new Map();
  const dangling = [];
  for (const [name, id] of aliases) {
    if (!ids.has(id)) { dangling.push([name, id]); continue; }
    aliasByPhrase.set(normPhrase(name), name);
  }
  const usedAliases = new Set(), usedGeneric = new Set();
  const flagged = [];   // { slug, phrase, count }
  let candidates = 0, resolved = 0;
  for (const { slug, md } of pages) {
    const counts = new Map();
    for (const phrase of extractCandidates(md)) {
      candidates++;
      if (lex.has(phrase)) { resolved++; continue; }
      if (aliasByPhrase.has(phrase)) { usedAliases.add(aliasByPhrase.get(phrase)); resolved++; continue; }
      if (genericOk.has(phrase)) { usedGeneric.add(phrase); resolved++; continue; }
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
    for (const [phrase, count] of counts) flagged.push({ slug, phrase, count });
  }
  // A dangling alias is already failed by the dangling report — listing it as
  // stale too would double-count one defect as two.
  const danglingNames = new Set(dangling.map(([name]) => name));
  const staleAliases = [...aliases.keys()].filter((n) => !danglingNames.has(n) && !usedAliases.has(n));
  const staleGeneric = [...genericOk.keys()].filter((p) => !usedGeneric.has(p));
  return { flagged, candidates, resolved, dangling, staleAliases, staleGeneric };
}
