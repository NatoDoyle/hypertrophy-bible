# Program Templates

> **TL;DR** — Five worked templates that apply everything in this Bible, from a **3-day full-body** at **40 weekly hard sets** to a **6-day push/pull/legs** at **118**. All hit each muscle **~2×/week** and prescribe rep ranges, RIR targets and a progression rule. Pick by the days you can *reliably* train, then check the weekly set counts below against your own recovery — the numbers, not the label, are what you are choosing between. The app builds you a personalised version of this same structure; these are the worked examples to read.

**Quick recommendations**
- **Beginner → the 3-day full-body**: 40 hard sets a week, simple, high-frequency, double progression. **[Grade C]**
- **Intermediate → the 4-day upper/lower**: 74 hard sets a week — roughly double the beginner plan's per-muscle volume at the same ~2× frequency. **[Grade C]**
- **Advanced → the 6-day push/pull/legs**: 118 hard sets a week, RIR-autoregulated. Only worth running if you actually recover from it. **[Grade C]**
- Check the number against your own [volume landmarks](../01-training-variables/volume.md) before the label: a plan you recover from beats a plan that sounds advanced. **[Grade B]**
- Whichever you pick, **progress it** and **adjust volume** to your own recovery. **[Grade A]**

## Practical Application

**Choose by the numbers, not the name.** Weekly hard sets per muscle group are counted the way [volume](../01-training-variables/volume.md) prescribes them — direct work plus half-credit for secondary involvement — so they are directly comparable to your own [landmarks](../01-training-variables/volume.md).

| Template | Days | Sets/wk | Chest | Back | Legs | Delts | Arms | Level |
|---|---|---|---|---|---|---|---|---|
| Beginner Full-Body | 3 | 40 | 9 | 19 | 19 | 13 | 13 | Beginner |
| Upper/Lower | 4 | 74 | 11 | 26 | 40 | 19 | 22 | Intermediate |
| 5-Day Hybrid | 5 | 85 | 11 | 26 | 34 | 27 | 27 | Intermediate–Advanced |
| Push/Pull/Legs | 6 | 118 | 20 | 47 | 49 | 35 | 43 | Advanced |
| Shoulders & Arms Specialization | 4 | 55 | 4 | 11 | 19 | 20 | 21 | Intermediate–Advanced |

Two things to read off that table. **Volume scales with days, steeply** — the 6-day plan carries nearly three times the beginner plan's work, which is the whole reason it's gated behind "if you recover from it". And **the specialization block is deliberately the second-lightest plan overall**: chest drops to 4 sets and back to 11 so delts and arms can be pushed, which is exactly the maintenance trade [weak-point prioritization](weak-point-prioritization.md) describes. It is a block you run for 4–8 weeks, not a permanent home.

| Template | Rep ranges | RIR targets | Progression rule |
|---|---|---|---|
| Beginner Full-Body | 6-10 · 8-12 · 10-15 · 12-20 | 2-3 compounds, 0-1 isolations | Double progression |
| Upper/Lower | 5-8 · 6-10 · 8-12 · 10-15 · 12-20 | 1-2 compounds, 0-1 isolations | Double progression |
| 5-Day Hybrid | 6-10 · 8-12 · 10-15 · 12-20 | 1-2 compounds, 0-1 isolations | Double progression |
| Push/Pull/Legs | 6-10 · 8-12 · 10-15 · 12-20 | 1-2 compounds, 0-1 isolations | RIR autoregulation |
| Shoulders & Arms Specialization | 6-10 · 8-12 · 10-15 · 12-20 | 1-2 compounds, 0-1 isolations | Double progression |

Beginners keep a deliberately larger reserve (2-3 RIR on compounds) because [judging proximity to failure](../01-training-variables/proximity-to-failure.md) is a skill that takes months to develop, and an inaccurate 0-1 RIR call is how form breaks down. Everything else lives in the ranges the [rep-range evidence](../01-training-variables/intensity-load-and-rep-ranges.md) supports.

**How to use a template:**
1. **Pick by days you can reliably train**, then by experience level.
2. **Start near the low end** of each muscle's volume and [progress it over the block](volume-progression-and-deloads.md).
3. **Apply the progression rule** every session (add reps → add load, or hit target RIR).
4. **Deload** when performance stalls, then start the next block slightly higher.
5. **Individualize** — swap exercises for equivalents you can train hard and pain-free ([Exercise Selection](../01-training-variables/exercise-selection-and-order.md)).

Every exercise, set, rep range and RIR is written out in machine-readable form in [`data/programs/`](../../data/programs/), and the set counts in the tables above are computed from those files rather than typed by hand — a test fails the build if the two ever disagree.

**The app does not hand you one of these.** It generates a plan for you from the same principles — your days, session length, equipment, injuries and priority muscles — so treat these as the worked examples that show what the output should look like, and as a complete program if you are reading this Bible without using the app.

## The Evidence

These templates are constructions, not studies — but each design choice traces to graded evidence elsewhere in this Bible: **~2× weekly frequency** to distribute volume with quality[^schoenfeld-2019-frequency-meta] **[Grade A]**, **enough volume, scaled up for trained lifters**[^schoenfeld-2019-volume-trained-men] **[Grade B]**, **rep ranges across the effective continuum** taken close to failure[^schoenfeld-2021-loading-recommendations] **[Grade A]**, and progression as the non-negotiable engine of growth. The templates themselves are therefore graded **[Grade C]** — sound applications of strong principles, not directly-tested protocols.

## Key Uncertainties & Nuance
- **Templates are starting points, not prescriptions.** Individual volume tolerance varies widely; treat set counts as a first estimate.
- **Exercise choices are swappable** — the specific lifts matter less than training each muscle's functions through a full, stretched range.
- **More days is not inherently better** — the 6-day plan only wins if you recover from it; otherwise the 4-day plan with good volume is superior.

## Backing Data
- [`data/programs/`](../../data/programs/) — the five templates, with every set, rep range and RIR
- [`data/progressions/`](../../data/progressions/) — progression rules referenced by the templates

## References
[^schoenfeld-2019-frequency-meta]: Schoenfeld BJ, Grgic J, Krieger J (2019). *How many times per week should a muscle be trained to maximize muscle hypertrophy?* Journal of Sports Sciences, 37(11), 1286–1295. DOI: [10.1080/02640414.2018.1555906](https://doi.org/10.1080/02640414.2018.1555906). PMID: 30558493.
[^schoenfeld-2019-volume-trained-men]: Schoenfeld BJ, et al. (2019). *Resistance Training Volume Enhances Muscle Hypertrophy but Not Strength in Trained Men.* Medicine and Science in Sports and Exercise, 51(1), 94–103. DOI: [10.1249/MSS.0000000000001764](https://doi.org/10.1249/MSS.0000000000001764). PMID: 30153194.
[^schoenfeld-2021-loading-recommendations]: Schoenfeld BJ, Grgic J, et al. (2021). *Loading Recommendations for Muscle Strength, Hypertrophy, and Local Endurance: A Re-Examination of the Repetition Continuum.* Sports (Basel), 9(2), 32. DOI: [10.3390/sports9020032](https://doi.org/10.3390/sports9020032). PMID: 33671664.
