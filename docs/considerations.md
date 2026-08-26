# Considerations - thoughts, ideas, suggestions and questions for consideration

Goal: to make note of my thoughts, ideas, suggestions and questions so that they can be taken into consideration for implementation. 

Everything below should be taken under consideration for implementation. Once it has been thoroughly considered against the goals of the project, the recommended actions should be implemented and then delete the consideration 


*(No open considerations. All three handled in Waves 257–261 (2026-08-27):*

*• "Audit the program engine — how do progression/periodization/deloads work, what gates
weight/volume changes, does experience change them, when do exercises rotate?" — DONE, both
halves. The answers: `docs/program-engine.md` (every magnitude from code). The audit: 16
candidate contradictions verified inline; **9 fixed** — a Settings save no longer erases
mid-block deload/swap/announcement state or un-demotes plateaued lifts; the "I've swapped it"
note names only lifts actually dropped; the reactive deload lives in your local week and
re-arms if its week passed untrained; the plateau card and the volume tune now read the same
6-week peak sample (the card had promised "+2 sets" while the tune eased −2 from the same
data); a recovery/deficit-gated add now says so instead of silently doing nothing; the
over-ceiling "reduce" signal finally renders as an instruction; back-off sets no longer
corrupt the top set's progression; and the reactive note's "half the sets" claim is scoped
honestly. **7 recorded as working-as-designed so they aren't re-raised**: the deficit gate
blocking volume adds while cutting (the KB prescribes it — the silence was the defect, now
fixed); the comeback ease's one-session ramp (honest-trends design); "peak volume" meaning
the peak of YOUR block (deliberate, documented); the week-4/5 set plateau and the compounds
never reaching 0–1 RIR (KB-vs-KB tension, reconciled in the KB's own prose, engine
untouched); readinessIndex/confidenceTier (the un-shipped Nerd Mode payload, deferred on the
roadmap); session rotation ignoring commitment weekdays (roadmap candidate, not a bug).*

*• "Chinese-Weightlifting-Technical-Mastery-and-Training.pdf — learn and implement anything
relevant" — DONE. All 306 pages read and characterized. ~10–15% is usable, all of it as
Grade-D documented elite institutional practice (its ~250-entry bibliography is untraceable
Chinese-language sports science, so nothing can be web-verified above that ceiling). Shipped:
`content/03-programming/elite-strength-sport-practice.md` — the pp.216-217 accessory
prescription mapped onto the KB's evidenced pages (where it converges strikingly),
fault-driven accessory selection, "train hypertrophy directly", sets→reps→load progression
ordering, the session-depth ladder, waves/deloads — plus a registry entry for the book
(first `study_type: book`, ISBN web-verified as existence-only). **Three claims deliberately
NOT imported, recorded in the page's Key Uncertainties so no future pass imports them**: the
p.198 "80–95% maximizes hypertrophy" relay (contradicts the modern load-insensitivity
literature and the book's own p.217 prescription), the sex-difference type-II-fiber
mechanism, and the biomarker/EMS thresholds. NO engine changes from the book (lesson 13 —
Grade-D practice lore doesn't rewire tuned code); the technique-teaching decompositions were
excluded as gym-operation pedagogy, not hypertrophy.*

*• "I want to be able to see past logs and graphs to see my progress" — DONE, as the "Full
progress views" scope you chose. Measured first: what Waves 250-253 shipped was thinner than
its record suggested — history cards showed only a set count (sets visible ONLY via the edit
form; a taken-back workout's sets unviewable), strength "graphs" were decorative 64×18
sparklines capped at 8 lifts, and the server was computing then discarding the full per-lift
dated series, complete PR history, and whole weigh-in log on every request. Now: tap any
strength-trend row for the lift's full dated chart + its PRs + a week-by-week table (ALL
lifts via the expander); tap any workout for a read-only set-by-set detail (voided ones
included); full-history bodyweight and intake charts with every day listed and tap-to-edit
(days beyond the old 14-row lists became editable for the first time); a complete PR list;
and "Last time: 60 kg × 8, 8, 7" on the set screen in both players. 17/17 browser
walkthrough on your profile shape.)*
