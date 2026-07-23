# Volume

> **TL;DR** — Volume — counted as **hard sets per muscle per week** — is the training variable most tightly linked to how much muscle you build. There is a **dose-response relationship**: more sets generally mean more growth, until you hit the volume you can recover from. For most people most of the time, **~10–20 hard sets per muscle per week** is the productive range. Below ~4–6 sets you leave growth on the table; pushing far past ~20 brings diminishing returns and rising fatigue. Start toward the lower end, add sets over a training block, and individualize.

**Quick recommendations**
- Count **hard sets** (working sets taken to ~0–4 reps in reserve). Warm-ups don't count. **[Grade B]**
- Target **~10+ hard sets per muscle per week** as a sensible default for growth. **[Grade A]** — this beats low-volume training reliably.
- Ranging up to **~20 sets/week** benefits many trained lifters, especially for lagging muscles — but returns diminish and fatigue rises. **[Grade B]**
- **Progress volume over a block**: begin a mesocycle nearer your minimum, add ~1–3 sets/muscle/week as needed, then deload. See per-muscle landmarks in [`data/muscles/`](../../data/muscles/). **[Grade C]**
- Count **fractional/indirect volume** partially: a hard row trains the lats fully but the biceps partially. Count secondary involvement as ~0.5 of a set — of the counting methods tested, this "fractional" method had the strongest relative evidence in the largest dose-response synthesis to date[^pelland-2026-dose-response]. **[Grade C]**
- **Stop at two tiers — don't invent a "tertiary" count.** The fractional method the evidence actually supports is two-level: **full** for the muscle a lift targets, **~half** for a muscle that meaningfully assists[^pelland-2026-dose-response]. A muscle that only *stabilizes* or barely contributes sees too little mechanical tension — the primary driver of growth — to add meaningful hypertrophy, so counting it (a "third tier") would be false precision the data doesn't support, and would inflate weekly totals against landmarks that were built on the direct-plus-indirect convention. Track those muscles anatomically if useful, but don't add them to the volume count. **[Grade C]**

## Practical Application

**How much per muscle, per week.** Use weekly hard sets as your unit. A practical starting model:

| Volume zone | Weekly hard sets (most muscles) | Use it when |
|-------------|-------------------------------|-------------|
| Maintenance | ~6 | Deloads, busy periods, muscles you only want to hold |
| Minimum effective (MEV) | ~8–10 | Starting point of a growth block |
| Adaptive (MAV) | ~12–18 | The productive middle where most growth happens |
| Near-maximum (MRV) | ~20–22 | Short overreach before a deload; advanced lifters |

These landmarks are **practical estimates, not measured constants** — they vary by muscle, individual, and life stress. The table above is a *general* anchor; some **high-tolerance muscles run higher** — side delts, upper back, and lats can productively reach **~24–26 weekly sets** near their ceiling — while smaller or heavily-fatiguing muscles sit lower. Per-muscle values live in the [muscle data files](../../data/muscles/) and are graded there.

**Distributing it.** Weekly volume is usually best split across **2+ sessions** rather than crammed into one (see [Frequency](frequency.md)) — quality per set falls as a session drags on, so more frequent, fresher sets let you accumulate more *effective* volume.

**Progressing it.** Volume is a resource you spend and must recover from. Begin a block near your MEV, add a small amount of volume as adaptation and recovery allow, and pull back (deload) when performance stalls or fatigue accumulates. More is not better indefinitely — more is better *until you stop recovering from it*.

## The Evidence

**A muscle grows roughly in proportion to how much hard work it does — up to a point.** The clearest single line of evidence is Schoenfeld, Ogborn, and Krieger's 2017 dose-response meta-analysis, which found a **continuous** dose-response — each additional weekly set was associated with more growth (roughly +0.37%/set of muscle size, P=0.002) — though its three-level categorical split (<5 vs 5–9 vs 10+ sets) reached only a non-significant trend (P=0.074), so read the relationship as graded rather than a hard 10-set threshold[^schoenfeld-2017-volume-dose-response]. **[Grade A]** This built on Krieger's earlier meta-analysis showing multiple sets produce substantially more growth than single sets per exercise[^krieger-2010-single-multiple-sets]. **[Grade A]**

**In trained lifters, the productive range extends higher.** Schoenfeld and colleagues (2019) compared 1, 3, and 5 sets per exercise in resistance-trained men and found greater hypertrophy with higher weekly volumes, indicating that experienced trainees often need more than the minimum to keep progressing[^schoenfeld-2019-volume-trained-men]. **[Grade B]** A systematic review by Baz-Valle and colleagues (2022) reached a similar conclusion — higher volumes tend to produce more growth — while emphasizing large individual variation and the practical ceiling imposed by recovery[^baz-valle-2022-volume-review]. **[Grade B]** The trained-lifter dose-response is real but *noisy*, though: Currier and colleagues' 2023 Bayesian network meta-analysis ranked **multiset** training highest for hypertrophy[^currier-2023-network-meta], yet a recent 12-week RCT in trained men by Enes and colleagues (2024) found **no statistically significant dose-response** across weekly set progressions, with confidence intervals hinting at a benefit that **plateaus** at higher volumes[^enes-2024-volume-progression]. **[Grade B]** The weight of evidence still points to "more, up to a point," but individual trials vary — reinforcing that volume is individualized, not a fixed prescription. The largest synthesis to date — Pelland and colleagues' 2026 meta-regression across 67 studies and 2,058 participants — lands on exactly that read: the posterior probability of a **positive volume slope** was 100% for both hypertrophy and strength, with clear **diminishing returns** (considerably more pronounced for strength)[^pelland-2026-dose-response]. **[Grade A]**

**How to count volume.** Not all "volume" metrics are equal. Baz-Valle and colleagues (2021) reviewed volume-quantification methods and concluded that **counting the number of hard sets** (sets taken to or near failure) is a valid, practical way to prescribe and track hypertrophy volume — simpler and at least as useful as tonnage (sets × reps × load)[^baz-valle-2021-counting-sets]. **[Grade B]** This is why this Bible standardizes on *weekly hard sets*.

**The ceiling.** The dose-response is not unbounded. Growth rises with volume but with diminishing returns, and beyond an individual's recoverable volume, added sets stop helping and can impair recovery and performance. The exact top of the curve is genuinely uncertain and individual — which is why the landmark model (MEV→MRV) is a *management tool*, not a law.

## Key Uncertainties & Nuance

- **The upper limit is fuzzy and personal.** Some studies report continued benefit at very high volumes (20+ sets); others show plateaus or declines. Recovery capacity — driven by sleep, nutrition, stress, training age, and the specific muscle — sets each person's ceiling.
- **The MEV/MRV landmarks are a model.** They popularized a useful way to think about volume progression, but the specific numbers are estimates with limited direct validation. Treat them as starting anchors you adjust from your own response. **[Grade C]**
- **"Junk volume" is real at the margins.** Sets performed far from failure or with heavy fatigue contribute little; padding set counts with low-quality sets inflates the number without the stimulus.
- **Volume interacts with everything.** The same set count is more or less effective depending on proximity to failure, load, and exercise selection. Volume is the headline variable, not the only one.

## Backing Data
- Per-muscle weekly set landmarks (MV/MEV/MAV/MRV): [`data/muscles/`](../../data/muscles/)

## References
[^schoenfeld-2017-volume-dose-response]: Schoenfeld BJ, Ogborn DI, Krieger JW (2017). *Dose-response relationship between weekly resistance training volume and increases in muscle mass: A systematic review and meta-analysis.* Journal of Sports Sciences, 35(11), 1073–1082. DOI: [10.1080/02640414.2016.1210197](https://doi.org/10.1080/02640414.2016.1210197). PMID: 27433992.
[^krieger-2010-single-multiple-sets]: Krieger JW (2010). *Single vs. multiple sets of resistance exercise for muscle hypertrophy: a meta-analysis.* Journal of Strength and Conditioning Research, 24(4), 1150–1159. DOI: [10.1519/JSC.0b013e3181d4d436](https://doi.org/10.1519/JSC.0b013e3181d4d436). PMID: 20300012.
[^schoenfeld-2019-volume-trained-men]: Schoenfeld BJ, et al. (2019). *Resistance Training Volume Enhances Muscle Hypertrophy but Not Strength in Trained Men.* Medicine and Science in Sports and Exercise, 51(1), 94–103. DOI: [10.1249/MSS.0000000000001764](https://doi.org/10.1249/MSS.0000000000001764). PMID: 30153194.
[^baz-valle-2022-volume-review]: Baz-Valle E, et al. (2022). *A Systematic Review of The Effects of Different Resistance Training Volumes on Muscle Hypertrophy.* Journal of Human Kinetics, 81, 199–210. DOI: [10.2478/hukin-2022-0017](https://doi.org/10.2478/hukin-2022-0017). PMID: 35291645.
[^currier-2023-network-meta]: Currier BS, et al. (2023). *Resistance training prescription for muscle strength and hypertrophy in healthy adults: a systematic review and Bayesian network meta-analysis.* British Journal of Sports Medicine, 57(18), 1211–1220. DOI: [10.1136/bjsports-2023-106807](https://doi.org/10.1136/bjsports-2023-106807). PMID: 37414459.
[^enes-2024-volume-progression]: Enes A, et al. (2024). *Effects of Different Weekly Set Progressions on Muscular Adaptations in Trained Males: Is There a Dose-Response Effect?* Medicine and Science in Sports and Exercise, 56(3), 553–563. DOI: [10.1249/MSS.0000000000003317](https://doi.org/10.1249/MSS.0000000000003317). PMID: 37796222.
[^pelland-2026-dose-response]: Pelland JC, Remmert JF, Robinson ZP, Hinson SR, Zourdos MC (2026). *The Resistance Training Dose Response: Meta-Regressions Exploring the Effects of Weekly Volume and Frequency on Muscle Hypertrophy and Strength Gains.* Sports Medicine, 56(2), 481–505. DOI: [10.1007/s40279-025-02344-w](https://doi.org/10.1007/s40279-025-02344-w). PMID: 41343037.
[^baz-valle-2021-counting-sets]: Baz-Valle E, et al. (2021). *Total Number of Sets as a Training Volume Quantification Method for Muscle Hypertrophy: A Systematic Review.* Journal of Strength and Conditioning Research, 35(3), 870–878. DOI: [10.1519/JSC.0000000000002776](https://doi.org/10.1519/JSC.0000000000002776). PMID: 30063555.
