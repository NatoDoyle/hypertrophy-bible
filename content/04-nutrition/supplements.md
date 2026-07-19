# Supplements

> **TL;DR** — Almost all muscle-building supplements are a waste of money. Only a short list has real evidence: **creatine monohydrate** (the one genuinely worth taking for muscle and strength), **caffeine** (a performance aid that helps you train harder), and **protein powder** (just a convenient protein source, not magic). Everything else is either unproven, trivial, or marketing. Supplements are the last ~1% — get training, protein, calories, and sleep right first.

**Quick recommendations**
- **Creatine monohydrate, 3–5 g/day** — the one supplement with strong evidence for muscle/strength. **[Grade A]**
- **Caffeine, ~3–6 mg/kg pre-workout** — improves training performance (indirect benefit). **[Grade A]**
- **Protein powder** only to help hit your daily protein target — it's food, not a growth agent. **[Grade A]**
- **Skip the rest** (testosterone "boosters", BCAAs, most pre-workout blends) until basics are dialed in. **[Grade C]**

## Practical Application

**The evidence tiers** (full data in [`data/supplements/`](../../data/supplements/)):

| Supplement | Tier | What it actually does |
|-----------|------|-----------------------|
| [Creatine monohydrate](../../data/supplements/creatine-monohydrate.json) | **Strong** | Small, reliable boost to strength, power, and lean mass |
| [Caffeine](../../data/supplements/caffeine.json) | **Modest** | Acutely improves performance → better training quality |
| [Protein powder](../../data/supplements/whey-protein.json) | **Strong (as food)** | Convenient way to hit protein targets; no benefit beyond that |
| [Beta-alanine](../../data/supplements/beta-alanine.json) | **Modest** | Buffers acidity → small endurance gain in high-rep/1–4 min efforts; not a direct builder |
| [Citrulline](../../data/supplements/citrulline.json) | Insufficient | "Pump"/soreness aid; no clear hypertrophy or performance effect |
| [HMB](../../data/supplements/hmb.json) | Insufficient | Early claims didn't hold up in trained lifters eating enough protein |
| [BCAAs](../../data/supplements/bcaas.json) | Insufficient | Redundant if you eat enough total protein; an incomplete amino-acid stimulus |
| ["Testosterone boosters"](../../data/supplements/testosterone-boosters.json) | Avoid | No meaningful effect on testosterone or muscle in healthy men |

**How to think about supplements.** They sit at the very end of the priority list. No supplement compensates for insufficient training, protein, calories, or sleep. Creatine is the rare exception that's cheap, safe, and worth taking by default. Caffeine helps you train harder (a real but indirect route to more muscle). Protein powder is simply groceries in a tub. Be deeply skeptical of anything marketed with dramatic before/after claims.

## The Evidence

**Creatine** is the most-studied sports supplement, with a position stand affirming that creatine monohydrate **safely and effectively supports training adaptations, strength, and lean mass**[^kreider-2017-creatine]. **[Grade A]** **Caffeine** has a position stand documenting **reliable acute improvements in strength, power, and endurance**[^guest-2021-caffeine] — benefits that reach hypertrophy indirectly by improving how hard and well you train. **[Grade A]** **Protein supplementation** aids resistance-training gains, but the meta-analytic evidence shows its value is in **helping meet total protein needs** — matched for daily protein, powder offers no special advantage over food[^morton-2018-protein-meta]. **[Grade A]** Supplements outside this short list generally lack comparable evidence for muscle growth, which is why they're graded low or omitted. **[Grade C]**

**The "maybe" and "no" tiers, specifically.** **Beta-alanine** has a position stand supporting a small improvement in muscular endurance for sustained ~1–4-minute efforts[^trexler-2015-beta-alanine] — real but marginal for typical hypertrophy training. **[Grade B]** **BCAAs** are redundant: Wolfe's review explains that branched-chain amino acids taken alone provide an **incomplete, submaximal stimulus** for muscle protein synthesis compared with whole protein[^wolfe-2017-bcaa] — so if you're meeting protein needs, they add nothing. **[Grade C]** *(the redundancy conclusion is well-accepted but rests on a mechanistic review, not hypertrophy RCTs.)* **HMB's** early large hypertrophy claims have not replicated: an independent systematic review and meta-analysis (11 studies, 302 participants) found HMB produced a small effect on total body mass but **no significant benefit for fat-free mass or strength**, and concluded the evidence doesn't support using it to improve body composition or strength with resistance training[^jakubowski-2020-hmb-meta]. (The favorable 2013 ISSN position stand[^wilson-2013-hmb] reached the opposite conclusion, but its large trained-lifter effects were not independently replicated.) **[Grade C]** **Citrulline** modestly reduces perceived exertion and short-term soreness in a meta-analysis but shows **no clear hypertrophy or performance benefit**[^rhim-2020-citrulline]. **[Grade C]** **"Testosterone boosters"** have no reliable effect on testosterone or muscle in healthy men and are best avoided. **[Grade D]**

## Key Uncertainties & Nuance
- **Creatine "non-responders"** exist (those with already-high muscle creatine see less effect), and initial weight gain includes water — not all of it is muscle.
- **Caffeine tolerance** blunts the effect with habitual use; cycling can help before key sessions.
- **The "modest/insufficient" supplements have niche or no roles** — beta-alanine helps sustained high-rep endurance; citrulline may ease soreness; HMB and BCAAs are largely redundant with adequate protein. None meaningfully build muscle beyond the basics.
- **Supplement quality/labeling varies** — third-party-tested products reduce contamination risk, which matters for tested athletes.

## Backing Data
- [`data/supplements/`](../../data/supplements/) — evidence tiers, dosing, timing, safety for each supplement

## References
[^kreider-2017-creatine]: Kreider RB, et al. (2017). *International Society of Sports Nutrition position stand: safety and efficacy of creatine supplementation in exercise, sport, and medicine.* Journal of the International Society of Sports Nutrition, 14, 18. DOI: [10.1186/s12970-017-0173-z](https://doi.org/10.1186/s12970-017-0173-z). PMID: 28615996.
[^guest-2021-caffeine]: Guest NS, et al. (2021). *International society of sports nutrition position stand: caffeine and exercise performance.* Journal of the International Society of Sports Nutrition, 18(1), 1. DOI: [10.1186/s12970-020-00383-4](https://doi.org/10.1186/s12970-020-00383-4). PMID: 33388079.
[^morton-2018-protein-meta]: Morton RW, et al. (2018). *A systematic review, meta-analysis and meta-regression of the effect of protein supplementation on resistance training-induced gains in muscle mass and strength in healthy adults.* British Journal of Sports Medicine, 52(6), 376–384. DOI: [10.1136/bjsports-2017-097608](https://doi.org/10.1136/bjsports-2017-097608). PMID: 28698222.
[^trexler-2015-beta-alanine]: Trexler ET, et al. (2015). *International society of sports nutrition position stand: Beta-Alanine.* Journal of the International Society of Sports Nutrition, 12, 30. DOI: [10.1186/s12970-015-0090-y](https://doi.org/10.1186/s12970-015-0090-y). PMID: 26175657.
[^wolfe-2017-bcaa]: Wolfe RR (2017). *Branched-chain amino acids and muscle protein synthesis in humans: myth or reality?* Journal of the International Society of Sports Nutrition, 14, 30. DOI: [10.1186/s12970-017-0184-9](https://doi.org/10.1186/s12970-017-0184-9). PMID: 28852372.
[^wilson-2013-hmb]: Wilson JM, et al. (2013). *International Society of Sports Nutrition Position Stand: beta-hydroxy-beta-methylbutyrate (HMB).* Journal of the International Society of Sports Nutrition, 10(1), 6. DOI: [10.1186/1550-2783-10-6](https://doi.org/10.1186/1550-2783-10-6). PMID: 23374455.
[^jakubowski-2020-hmb-meta]: Jakubowski JS, Nunes EA, Teixeira FJ, et al. (2020). *Supplementation with the Leucine Metabolite β-hydroxy-β-methylbutyrate (HMB) does not Improve Resistance Exercise-Induced Changes in Body Composition or Strength in Young Subjects: A Systematic Review and Meta-Analysis.* Nutrients, 12(5), 1523. DOI: [10.3390/nu12051523](https://doi.org/10.3390/nu12051523). PMID: 32456217.
[^rhim-2020-citrulline]: Rhim HC, et al. (2020). *Effect of citrulline on post-exercise rating of perceived exertion, muscle soreness, and blood lactate levels: A systematic review and meta-analysis.* Journal of Sport and Health Science, 9(6), 553–561. DOI: [10.1016/j.jshs.2020.02.003](https://doi.org/10.1016/j.jshs.2020.02.003). PMID: 33308806.
