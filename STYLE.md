# STYLE — Authoring Conventions for The Hypertrophy Bible

This document is the contract every content and data file follows. It exists so that a page written
in Milestone 7 is indistinguishable in structure and rigor from the Milestone 1 exemplar.

---

## 1. The page template (every `content/**/*.md` page)

Pages follow this exact section order. Omit a section only if it is genuinely not applicable, and
never reorder.

```markdown
# <Title>

> **TL;DR** — 2–4 sentences. The bottom line plus the key numbers a reader could act on immediately.

**Quick recommendations**
- Bulleted, imperative, concrete. Give ranges and numbers, not adjectives.
- Each recommendation should be defensible from the Evidence section below.

## Practical Application
How to actually implement it. Prefer tables, ranges, and explicit decision rules over prose.

## The Evidence
Mechanisms, study findings, and points of live debate. **Every substantive claim carries an evidence
grade, and every empirical claim graded A–C carries a citation.** Grade-D claims are practice-based or
mechanistic by definition (see §4) and may stand uncited *as long as they are explicitly graded D* — the
grade itself signals "reasoned/consensus, not directly evidenced." Never present an uncited claim as if
it were established fact. State where consensus is soft.

## Key Uncertainties & Nuance
What we don't know, individual variation, and the ways this topic is commonly misread.

## Backing Data
Relative links to the `data/**` files this page is derived from. Prose numbers MUST match those files.

## References
Footnote definitions (`[^key]: ...`) or a note that they are compiled in `citations/registry.md`.
```

A page that has no structured data behind it may write `Backing Data — none` explicitly, so the
absence is a decision, not an oversight.

---

## 2. Voice & audience

- **Layered.** The TL;DR and Quick recommendations serve a beginner or a hurried lifter. Practical
  Application serves someone programming their week. The Evidence serves a coach or skeptic. Write so
  each layer is complete on its own.
- **Plain, precise, non-hyped.** No "revolutionary", "secret", "hack". Numbers and ranges beat
  intensifiers. If an effect is small, say it is small.
- **Honest about uncertainty.** "We don't know" is a valid and frequent answer. Distinguish what is
  well-established from what is plausible-but-unproven. This honesty is the product.
- **Define terms on first use** within a page (e.g. RIR, MEV), even if defined elsewhere.

---

## 3. Citation rules

1. **A citation must be real and verified.** No entry enters `citations/registry.json` until a live
   web search/fetch has confirmed the paper exists and its true metadata (title, authors, year,
   journal, DOI/PMID) has been captured. If you cannot verify a source, you may not cite it — reword
   the claim, downgrade its grade, or remove it.
2. **Cite the strongest available source.** Prefer meta-analyses and systematic reviews over single
   studies; prefer trained-population studies over untrained where the distinction matters.
3. **In prose**, attach citations as footnote markers immediately after the claim: `...roughly 10+
   sets per muscle per week[^schoenfeld-2017-volume-dose-response].`
4. **Citation keys** are stable, lowercase, kebab-case: `firstauthor-year-topic`
   (e.g. `refalo-2023-failure-meta`). Keys never change once referenced.
5. **In data files**, cite by the same key via the `citations` array.
6. `tools/check-citations.mjs` enforces that every used key exists and every registry entry has a
   resolvable DOI/PMID/URL. The build is not "green" until it passes.

---

## 4. Evidence grading (A–D)

Apply a grade to each recommendation or load-bearing claim, written inline as `**[Grade B]**` or in a
table column. Grade the *strength of evidence for the claim*, not the size of the effect.

| Grade | Meaning | Typical basis |
|-------|---------|---------------|
| **A** | Strong. Act on it confidently. | Consistent findings across multiple RCTs and/or meta-analyses, ideally including trained populations. |
| **B** | Moderate. Reasonable default, may shift. | Several studies with some inconsistency, limited populations, or effect-size uncertainty. |
| **C** | Limited. Provisional. | Few studies, mixed results, or mostly untrained/short-duration evidence. |
| **D** | Mechanistic / practice-based. | Reasoned from physiology or coaching consensus; little or no direct hypertrophy RCT support. |

**Model-based numbers are estimates.** Volume landmarks (MV/MEV/MAV/MRV), for example, are practical
models, not measured constants. Grade them honestly (usually B/C) and say so.

---

## 5. Units & shared definitions

- **"Set" = one working set taken close to failure** (roughly 0–4 reps in reserve). Warm-up sets do
  not count. Always state this where volume is discussed.
- **Volume** is expressed as **weekly hard sets per muscle** unless explicitly stated otherwise.
- **Load** is expressed as **%1RM** (percent of one-rep max) and/or a rep range.
- **RIR** = Reps In Reserve; **RPE** = Rating of Perceived Exertion (RIR-based, so RPE 8 ≈ 2 RIR).
- **1RM** = one-repetition maximum.
- Volume landmarks: **MV** (maintenance), **MEV** (minimum effective), **MAV** (maximum adaptive),
  **MRV** (maximum recoverable).

---

## 6. Links & files

- Use **relative Markdown links** between pages (`../02-muscle-guides/index.md`). These also resolve
  as Obsidian wikilinks, so the KB is portable.
- One concept per file. When a page outgrows a single screenful of scope, split it.
- Data files: one instance per file, named by `id` (e.g. `data/muscles/quadriceps.json`).
