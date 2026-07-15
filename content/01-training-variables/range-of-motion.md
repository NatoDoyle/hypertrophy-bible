# Range of Motion (incl. Lengthened-Position Training)

> **TL;DR** — Use a **full range of motion** as your default — it generally builds at least as much muscle as partial-range work, and often more. The sharper insight from recent research is that the **lengthened (stretched) portion of the movement is especially productive**: training where the muscle is under load at long lengths drives a lot of the growth. So **emphasize the stretch**, choose exercises that load the muscle in its lengthened position, and if you ever use partial reps, do them at **long muscle lengths — not short, "top-half" partials**.

**Quick recommendations**
- Train through a **full ROM** by default, controlling the **deep, stretched position**. **[Grade B]**
- Prefer exercises that **load the muscle when it's lengthened** (e.g. overhead triceps, deep-stretch hamstring and chest movements). **[Grade B]**
- If you use **partials, do "lengthened partials"** (reps biased to the bottom/stretched range), not short-range top partials. **[Grade B]**
- Don't cut ROM short to move more weight — **ego-range** reps trade growth for load. **[Grade C]**

## Practical Application

**Full ROM, with intent on the stretch.** For most exercises, the biggest bang comes from owning the deep, lengthened position — the bottom of a Romanian deadlift, the stretch of a chest fly or deep press, the bottom of an overhead triceps extension, a deep squat for the quads. Lower under control into that position and reverse without bouncing.

**Choose exercises by where they load the muscle.** Two exercises for the same muscle can load it in very different positions. Where hypertrophy is the goal, favor the option that challenges the muscle when it's *long*:

| Muscle | Lengthened-biased pick | Shortened-biased pick |
|--------|------------------------|-----------------------|
| Triceps (long head) | Overhead extensions | Pushdowns |
| Hamstrings | Romanian deadlifts, seated leg curls | Standing/lying curls (less stretch) |
| Chest | Deep dumbbell press/flyes | Cable crossover at peak contraction |
| Quads | Squats/leg press to depth | Partial-range extensions |

Both positions can grow muscle; the lengthened-biased option tends to be the higher-yield default, and you can add shortened-position work as a complement. See per-exercise `resistance_profile` and `lengthened_bias` flags in [`data/exercises/`](../../data/exercises/).

**Lengthened partials as a tool.** When a full ROM is limited by strength curve or fatigue (e.g. the top of a lateral raise adds little), reps concentrated in the stretched range are a legitimate, sometimes superior option — the opposite of the old "burn out with top-range pulses" habit.

## The Evidence

**Full ROM ≥ partial ROM, in general.** Schoenfeld and Grgic's 2020 systematic review concluded that **full ROM tends to produce greater muscle development than partial ROM**, though results varied by muscle and study[^schoenfeld-2020-rom-review]. **[Grade B]** An independent 2021 meta-analysis by Pallarés and colleagues likewise favored **fuller ranges of motion** for muscular and functional adaptations[^pallares-2021-rom-meta]. **[Grade B]** Kassiano and colleagues' 2023 review ("Which ROMs Lead to Rome?") refined the picture: the advantage isn't simply "more range," it's **where** in the range you load the muscle[^kassiano-2023-rom-review]. **[Grade B]**

**Long muscle lengths do the heavy lifting.** Pedrosa and colleagues (2022) found that **partial-ROM training performed at long muscle lengths produced favorable adaptations — comparable to (and in some measures exceeding) full ROM**, and clearly better than partials at short muscle lengths[^pedrosa-2022-lengthened-partials]. **[Grade B]** Maeo and colleagues (2023) showed the exercise-selection corollary: **triceps hypertrophy was substantially greater when elbow extensions were done overhead** (long head stretched) versus in a neutral arm position[^maeo-2023-triceps-overhead]. **[Grade B]** Together these reframe ROM: it's less "full vs partial" and more "**make sure the muscle is loaded when it's long.**"

**But recent meta-analytic work urges caution.** The enthusiasm for long-length training has been tempered by newer syntheses. Varović and colleagues' 2025 meta-analysis found that training at **longer versus shorter muscle lengths produced *similar* hypertrophy** — including trivial differences in *regional* growth along the muscle — with the important caveat that the length differences between conditions in the pooled studies were modest (~22%)[^varovic-2025-muscle-length-regional]. **[Grade B]** So the honest current position is a **live debate**: several individual studies show a lengthened-position advantage, but pooled meta-analytic evidence is more equivocal, especially for moderate length differences. The practical takeaway is unchanged and low-risk — **use a full ROM and don't neglect the stretched position** — but "lengthened training is dramatically superior" is a stronger claim than the newest evidence supports.

## Key Uncertainties & Nuance

- **The size of the lengthened-position advantage is genuinely unsettled.** Individual RCTs (Pedrosa, Maeo) favor long-length training, but a 2025 meta-analysis found similar hypertrophy across muscle lengths — so "emphasize the stretch" is a sound, low-risk default, not a guarantee of large extra gains. Effect sizes vary by muscle, study, and how different the compared lengths actually are.
- **"Full ROM" must be an *achievable, safe* ROM.** For a given person and joint, the usable full range may be less than textbook; force ROM against pain and you trade a small growth edge for injury risk.
- **Loaded stretch, not passive stretch.** The benefit is about training *under load* at long lengths, which is different from stretching for flexibility.
- **Shortened-position work still has a place.** Peak-contraction exercises aren't useless — they're a complement, not the foundation.

## Backing Data
- Exercise `resistance_profile`, `rom_notes`, and `lengthened_bias`: [`data/exercises/`](../../data/exercises/)

## References
[^schoenfeld-2020-rom-review]: Schoenfeld BJ, Grgic J (2020). *Effects of range of motion on muscle development during resistance training interventions: A systematic review.* SAGE Open Medicine, 8, 2050312120901559. DOI: [10.1177/2050312120901559](https://doi.org/10.1177/2050312120901559). PMID: 32030125.
[^pallares-2021-rom-meta]: Pallarés JG, et al. (2021). *Effects of range of motion on resistance training adaptations: A systematic review and meta-analysis.* Scandinavian Journal of Medicine & Science in Sports, 31(10), 1866–1881. DOI: [10.1111/sms.14006](https://doi.org/10.1111/sms.14006). PMID: 34170576.
[^kassiano-2023-rom-review]: Kassiano W, et al. (2023). *Which ROMs Lead to Rome? A Systematic Review of the Effects of Range of Motion on Muscle Hypertrophy.* Journal of Strength and Conditioning Research, 37(5), 1135–1144. DOI: [10.1519/JSC.0000000000004415](https://doi.org/10.1519/JSC.0000000000004415). PMID: 36662126.
[^pedrosa-2022-lengthened-partials]: Pedrosa GF, et al. (2022). *Partial range of motion training elicits favorable improvements in muscular adaptations when carried out at long muscle lengths.* European Journal of Sport Science, 22(8), 1250–1260. DOI: [10.1080/17461391.2021.1927199](https://doi.org/10.1080/17461391.2021.1927199). PMID: 33977835.
[^maeo-2023-triceps-overhead]: Maeo S, et al. (2023). *Triceps brachii hypertrophy is substantially greater after elbow extension training performed in the overhead versus neutral arm position.* European Journal of Sport Science, 23(7), 1240–1250. DOI: [10.1080/17461391.2022.2100279](https://doi.org/10.1080/17461391.2022.2100279). PMID: 35819335.
[^varovic-2025-muscle-length-regional]: Varović D, et al. (2025). *Does Muscle Length Influence Regional Hypertrophy? A Systematic Review and Meta-Analysis.* International Journal of Sports Medicine, 46(14), 1027–1036. DOI: [10.1055/a-2615-4935](https://doi.org/10.1055/a-2615-4935). PMID: 40570881.
