# Chest (Pectoralis Major)

> **TL;DR** — The chest is **one muscle with two functional regions**: the **clavicular (upper) head**, which also flexes the shoulder, and the larger **sternocostal (mid/lower) head**. Both do the same core job — **horizontal adduction**, bringing the upper arm across the body. Cover it with a **press you can reach a deep stretch on**, an **incline press at about 30°**, and one **fly/adduction** movement, and the whole muscle is trained. Roughly **8–20 hard sets a week** across **2 sessions** suits most people. Bench angle genuinely changes *where* the work lands — but don't go past **45°**, where the front delt takes over.

**Quick recommendations**
- Run **2–3 chest movements a week**: one flat/neutral press, one incline press, one fly. **[Grade C]**
- Set the incline at about **30°** — that's where upper-pec activation peaked across five tested angles, while **flat** was highest for the mid and lower portions[^rodriguez-ridao-2020-bench-inclination-emg]. **[Grade C]**
- **Don't incline past 45°.** Beyond that the anterior deltoid's activation rises significantly and the pec's own contribution falls[^rodriguez-ridao-2020-bench-inclination-emg] — you're building front delts on a chest exercise. **[Grade C]**
- **Prioritise the stretch.** Dumbbells, a pec deck and dips reach a deeper stretched position than a barbell, which the chest stops short of; longer-length work matches or beats short-range work for growth[^schoenfeld-2020-rom-review][^kassiano-2023-rom-review]. **[Grade B]**
- Weekly volume: start near **8–10 sets**, work toward **12–18**, and treat **~20–22** as the ceiling ([`data/muscles/chest.json`](../../data/muscles/chest.json)). Model-based estimates, not measured constants. **[Grade C]**
- **Count your pressing.** Heavy [bench pressing](../../data/exercises/barbell-bench-press.json) is chest volume — it goes *inside* the weekly total, not on top of it. **[Grade C]**

## Practical Application

The chest is simpler than the back: two heads, one shared action, and a single variable — **arm path relative to the torso** — that shifts the emphasis between them. Picks below are ordered for **hypertrophy**, biasing the loaded stretch, then machine/cable stability where it lets you train closer to failure, then lower systemic fatigue — the same ranking the app's engine applies.

**Region 1 — Mid & lower chest (the sternocostal head, most of the muscle).** *Job: horizontal adduction and shoulder adduction — pressing and hugging the arm across the body.*
1. [Dumbbell bench press](../../data/exercises/dumbbell-bench-press.json) — the default over a barbell: the hands travel past the point a bar would stop at your ribs, so the chest is loaded in its stretched position.
2. [Chest dip](../../data/exercises/chest-dip.json) — a deep stretch under bodyweight; lean the torso forward to keep it a chest movement rather than a triceps one. Add load or assistance to stay in a hypertrophy rep range.
3. [Machine chest press](../../data/exercises/machine-chest-press.json) — the lowest-fatigue way to press hard. Nothing to stabilise, so effort ends the set.
4. [Barbell bench press](../../data/exercises/barbell-bench-press.json) — the most loadable, and the one the bar's own depth limits. Excellent for strength, and it still builds chest; just don't let it be your *only* chest work.
5. [Push-up](../../data/exercises/push-up.json) — genuinely effective when loaded (feet elevated, band, weight vest) and the only one on this list that needs nothing.

*Cue:* let the elbows travel **down and slightly out**, feel the stretch across the chest at the bottom, then press **in and up** as if hugging something wide — the arms come toward each other, not just up.

**Region 2 — Upper chest (the clavicular head).** *Job: everything above, plus shoulder flexion — which is why raising the arm path recruits it.*
1. [Incline dumbbell press](../../data/exercises/incline-dumbbell-press.json) — the single best upper-chest builder here: the incline biases the clavicular head and the dumbbells still allow a full stretch.
2. [Incline barbell bench press](../../data/exercises/incline-barbell-bench-press.json) — more loadable, less range. A good heavy anchor if you also do a fly.

Set the bench at roughly **30°**. Across 0°, 15°, 30°, 45° and 60°, upper-pec EMG peaked at 30°, and past 45° the front delt's activation rose significantly while the pec's fell[^rodriguez-ridao-2020-bench-inclination-emg]. A steep incline feels harder because a *different muscle* is doing the work.

*Cue:* keep the same hug at the top; a common error is drifting into an overhead press as the bench gets steeper.

**Region 3 — Flies and adduction (both heads, no triceps).** Pressing is limited by the triceps and front delts; a fly removes them, so the chest is the thing that fails.
1. [Pec deck](../../data/exercises/pec-deck.json) — a machine fly that holds tension through the stretched position with nothing to balance. The highest-value isolation on this list.
2. [Dumbbell fly](../../data/exercises/dumbbell-fly.json) — the deepest stretch available, but tension falls off badly at the top, where the weight is hanging straight down.
3. [Cable crossover](../../data/exercises/cable-crossover.json) — the reverse trade: constant tension and a hard squeeze, least stretch. A good finisher, a poor only-fly.
4. [Band chest fly](../../data/exercises/band-chest-fly.json) — the travel/home option; tension is highest where the chest is shortest, so pair it with a deep press.

*Cue:* keep a **fixed, slightly bent elbow** and move only at the shoulder. If the elbow angle changes, it's become a press.

**Putting a week together.** Two sessions, three or four movements total: an incline press and a fly in one, a flat/neutral press and a dip or second fly in the other — landing somewhere in the 8–20 set range. If you only ever do one thing, make it a press you can stretch on. If you add only one more, make it an incline.

**What about decline, and "inner" or "outer" chest?** Decline pressing gives most people little that flat work doesn't. And there is no inner or outer pec — the fibres all run to the same insertion, so no exercise can shorten one edge of the muscle. What you *can* influence is upper vs lower, which is the split above.

**The universal levers still rule.** These picks simply apply the fundamentals every muscle obeys — enough [volume](../01-training-variables/volume.md), real [effort](../01-training-variables/proximity-to-failure.md) close to failure, and sound [exercise selection](../01-training-variables/exercise-selection-and-order.md), progressed over time — to this region. Front delts and triceps take a share of every press you do; see the [Shoulders](shoulders.md) and [Arms](arms.md) guides before adding much direct work for them.

## The Evidence

Chest growth follows the general training-variable evidence rather than anything chest-specific. **Volume within a recoverable range drives hypertrophy**[^schoenfeld-2017-volume-dose-response] **[Grade A]**, and **training through a full range, loading the lengthened position, matches or beats short-range work**[^schoenfeld-2020-rom-review][^kassiano-2023-rom-review] **[Grade B]** — which is the whole case for choosing dumbbells, a pec deck or dips over a barbell that stops at the ribs. Mechanical tension on the fibres is the underlying driver[^schoenfeld-2010-mechanisms]. **[Grade C]**

The **angle** evidence is real but narrower than it's usually sold as, and it is worth being precise about what was measured. In 30 trained adults pressing at five bench angles, upper-pec EMG was highest at **30°**, the mid and lower portions were highest at **flat**, and the anterior deltoid was highest at **60°**, with inclines past 45° significantly raising delt activation while reducing the pec's performance[^rodriguez-ridao-2020-bench-inclination-emg]. **[Grade C]** A second study went a step further, pairing EMG with panoramic ultrasound: flat versus 45° pressing produced not only the expected regional excitation difference but *acute* region-specific increases in cross-sectional area — clavicular after the incline, sternocostal after the flat[^albarello-2022-bench-inclination-csa]. **[Grade C]**

Both are **acute** studies: activation and immediate post-exercise swelling, not months of measured growth. They establish that angle changes where the work lands. They do not establish that this produces meaningfully different long-term regional development — see the uncertainty below, which points the other way.

## Key Uncertainties & Nuance
- **Acute regional signals may not become regional growth.** A 2025 meta-analysis found that training at longer versus shorter muscle lengths produced **similar hypertrophy across proximal, mid and distal sites**, with only trivial differences[^varovic-2025-muscle-length-regional]. **[Grade B]** That's a warning against over-reading region-targeting generally. The honest position: an incline costs nothing, is plausibly useful, and is worth including — but exercise selection is a smaller lever than doing enough hard sets. (More: [Regional & architectural hypertrophy](../00-foundations/regional-and-architectural-hypertrophy.md).)
- **How much upper-chest work you need is individual.** Some people's clavicular head is well served by incline pressing alone; others benefit from making incline the primary press. There's no trial that sets a ratio.
- **The value of a fly is the stretch, not the squeeze.** "Peak contraction" claims are weak; what a fly reliably adds is loaded adduction without the triceps ending the set.
- **The bench press is a chest exercise with a ceiling.** The bar reaching the chest stops the humerus short of the full stretch. That doesn't make it a bad exercise — it makes it a poor *only* exercise.
- **Shoulder discomfort is common in deep pressing.** If a deep barbell bench aggravates your shoulder, dumbbells, a neutral grip or a machine usually let you keep training hard while the range stays comfortable; see [Injury & pain management](../05-recovery/recovery-modalities-and-injury.md).

## Backing Data
- Muscle: [`chest.json`](../../data/muscles/chest.json) — functions, regions, volume landmarks
- Exercises: [`incline-dumbbell-press`](../../data/exercises/incline-dumbbell-press.json), [`dumbbell-bench-press`](../../data/exercises/dumbbell-bench-press.json), [`barbell-bench-press`](../../data/exercises/barbell-bench-press.json), [`pec-deck`](../../data/exercises/pec-deck.json), [`chest-dip`](../../data/exercises/chest-dip.json), [`cable-crossover`](../../data/exercises/cable-crossover.json)

## References
[^schoenfeld-2017-volume-dose-response]: Schoenfeld BJ, Ogborn DI, Krieger JW (2017). *Dose-response relationship between weekly resistance training volume and increases in muscle mass.* Journal of Sports Sciences, 35(11), 1073–1082. DOI: [10.1080/02640414.2016.1210197](https://doi.org/10.1080/02640414.2016.1210197). PMID: 27433992.
[^schoenfeld-2020-rom-review]: Schoenfeld BJ, Grgic J (2020). *Effects of range of motion on muscle development during resistance training interventions: A systematic review.* SAGE Open Medicine, 8, 2050312120901559. DOI: [10.1177/2050312120901559](https://doi.org/10.1177/2050312120901559). PMID: 32030125.
[^kassiano-2023-rom-review]: Kassiano W, et al. (2023). *Which ROMs Lead to Rome? A Systematic Review of the Effects of Range of Motion on Muscle Hypertrophy.* Journal of Strength and Conditioning Research, 37(5), 1135–1144. DOI: [10.1519/JSC.0000000000004415](https://doi.org/10.1519/JSC.0000000000004415). PMID: 36662126.
[^schoenfeld-2010-mechanisms]: Schoenfeld BJ (2010). *The mechanisms of muscle hypertrophy and their application to resistance training.* Journal of Strength and Conditioning Research, 24(10), 2857–2872. DOI: [10.1519/JSC.0b013e3181e840f3](https://doi.org/10.1519/JSC.0b013e3181e840f3). PMID: 20847704.
[^rodriguez-ridao-2020-bench-inclination-emg]: Rodríguez-Ridao D, Antequera-Vique JA, Martín-Fuentes I, Muyor JM (2020). *Effect of Five Bench Inclinations on the Electromyographic Activity of the Pectoralis Major, Anterior Deltoid, and Triceps Brachii during the Bench Press Exercise.* International Journal of Environmental Research and Public Health, 17(19), 7339. DOI: [10.3390/ijerph17197339](https://doi.org/10.3390/ijerph17197339). PMID: 33049982.
[^albarello-2022-bench-inclination-csa]: Albarello JCdS, Cabral HV, Leitão BFM, Halmenschlager GH, Lulic-Kuryllo T, Matta TTd (2022). *Non-uniform excitation of pectoralis major induced by changes in bench press inclination leads to uneven variations in the cross-sectional area measured by panoramic ultrasonography.* Journal of Electromyography and Kinesiology, 67, 102722. DOI: [10.1016/j.jelekin.2022.102722](https://doi.org/10.1016/j.jelekin.2022.102722). PMID: 36334406.
[^varovic-2025-muscle-length-regional]: Varovic D, Wolf M, Schoenfeld BJ, Steele J, Grgic J, Mikulic P (2025). *Does Muscle Length Influence Regional Hypertrophy? A Systematic Review and Meta-Analysis.* International Journal of Sports Medicine, 46(14), 1027–1036. DOI: [10.1055/a-2615-4935](https://doi.org/10.1055/a-2615-4935). PMID: 40570881.
