# Program Templates

> **TL;DR** — Three worked templates that apply everything in this Bible: a **3-day full-body** for beginners, a **4-day upper/lower** for intermediates, and a **6-day push/pull/legs** for advanced lifters who recover well. All hit each muscle **~2×/week**, prescribe **rep ranges and RIR targets**, and reference a **progression rule**. They are starting points — adjust volume to your recovery.

**Quick recommendations**
- **Beginner** → [3-day full-body](../../data/programs/beginner-full-body-3day.json): simple, high-frequency, double progression. **[Grade C]**
- **Intermediate** → [4-day upper/lower](../../data/programs/upper-lower-4day.json): more per-muscle volume, ~2× frequency. **[Grade C]**
- **Advanced** → [6-day push/pull/legs](../../data/programs/push-pull-legs-6day.json): high volume, RIR-autoregulated. **[Grade C]**
- Whichever you pick, **progress it** and **adjust volume** to your own recovery. **[Grade A]**

## Practical Application

| Template | Days | Split | Level | Progression |
|----------|------|-------|-------|-------------|
| [Beginner Full-Body](../../data/programs/beginner-full-body-3day.json) | 3 | Full-body | Beginner | [Double progression](../../data/progressions/double-progression.json) |
| [Upper/Lower](../../data/programs/upper-lower-4day.json) | 4 | Upper/lower | Intermediate | [Double progression](../../data/progressions/double-progression.json) |
| [Push/Pull/Legs](../../data/programs/push-pull-legs-6day.json) | 6 | Push/pull/legs | Advanced | [RIR autoregulation](../../data/progressions/rir-autoregulation.json) |

**How to use a template:**
1. **Pick by days you can reliably train**, then by experience level.
2. **Start near the low end** of each muscle's volume and [progress it over the block](volume-progression-and-deloads.md).
3. **Apply the progression rule** every session (add reps → add load, or hit target RIR).
4. **Deload** when performance stalls, then start the next block slightly higher.
5. **Individualize** — swap exercises for equivalents you can train hard and pain-free ([Exercise Selection](../01-training-variables/exercise-selection-and-order.md)).

The full machine-readable prescriptions (every exercise, set, rep range, and RIR) live in [`data/programs/`](../../data/programs/) — this is the structure the future app will generate and personalize.

## The Evidence

These templates are constructions, not studies — but each design choice traces to graded evidence elsewhere in this Bible: **~2× weekly frequency** to distribute volume with quality[^schoenfeld-2019-frequency-meta] **[Grade A]**, **enough volume, scaled up for trained lifters**[^schoenfeld-2019-volume-trained-men] **[Grade B]**, **rep ranges across the effective continuum** taken close to failure[^schoenfeld-2021-loading-recommendations] **[Grade A]**, and progression as the non-negotiable engine of growth. The templates themselves are therefore graded **[Grade C]** — sound applications of strong principles, not directly-tested protocols.

## Key Uncertainties & Nuance
- **Templates are starting points, not prescriptions.** Individual volume tolerance varies widely; treat set counts as a first estimate.
- **Exercise choices are swappable** — the specific lifts matter less than training each muscle's functions through a full, stretched range.
- **More days is not inherently better** — the 6-day plan only wins if you recover from it; otherwise the 4-day plan with good volume is superior.

## Backing Data
- [`data/programs/`](../../data/programs/) — the three templates
- [`data/progressions/`](../../data/progressions/) — progression rules referenced by the templates

## References
[^schoenfeld-2019-frequency-meta]: Schoenfeld BJ, Grgic J, Krieger J (2019). *How many times per week should a muscle be trained to maximize muscle hypertrophy?* Journal of Sports Sciences, 37(11), 1286–1295. DOI: [10.1080/02640414.2018.1555906](https://doi.org/10.1080/02640414.2018.1555906). PMID: 30558493.
[^schoenfeld-2019-volume-trained-men]: Schoenfeld BJ, et al. (2019). *Resistance Training Volume Enhances Muscle Hypertrophy but Not Strength in Trained Men.* Medicine and Science in Sports and Exercise, 51(1), 94–103. DOI: [10.1249/MSS.0000000000001764](https://doi.org/10.1249/MSS.0000000000001764). PMID: 30153194.
[^schoenfeld-2021-loading-recommendations]: Schoenfeld BJ, Grgic J, et al. (2021). *Loading Recommendations for Muscle Strength, Hypertrophy, and Local Endurance: A Re-Examination of the Repetition Continuum.* Sports (Basel), 9(2), 32. DOI: [10.3390/sports9020032](https://doi.org/10.3390/sports9020032). PMID: 33671664.
