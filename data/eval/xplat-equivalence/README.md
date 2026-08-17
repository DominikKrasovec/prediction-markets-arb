# Cross-platform equivalence eval set (v1)

The first **labeled benchmark for the Stage-2/3 cross-platform identity layer** — pairs of
platform events with human equivalence labels, plus ~150 free auto-positives from on-chain
`market_cross_refs`. Design source: `docs/paper-grounded-audit-2026-06-10.md` §2.4/§3 and
`data/exports/audit-2026-06-10/fp-recall-methodology-refactor.json` ("Proposed minimal eval
set"), following the Gebele & Matthes (arXiv 2601.01706) annotation protocol, sized for a
99.4%-sports corpus.

## Files

| File | What | Labels |
|---|---|---|
| `v1.todo.jsonl` | 600 stratified pairs, all labeling context inline | **unlabeled** (`label: null`) |
| `v1.seed.jsonl` | 150 pairs whose markets share an on-chain conditionId (`market_cross_refs`) | pre-labeled `equivalent`, `label_source: market_cross_refs` |
| `v1.jsonl` | (created by you) labeled rows promoted from `v1.todo.jsonl` | human |
| `schema.json` | JSON Schema for one JSONL record | — |

Workflow: label rows from `v1.todo.jsonl` (fill `label`, `failure_modes`, `annotator`,
`label_source: human:<initials>`, `labeled_at`) and append them to `v1.jsonl`. The suite
reads `v1.seed.jsonl` + `v1.jsonl` + `v1.todo.jsonl`, merges by `pair_id` (labeled rows
win), and **skips unlabeled rows**, so it works incrementally from day one.

Records are keyed by **natural keys** (platform + `platform_event_id` + child
`platform_id`s) — never serial DB ids, which `RESTART IDENTITY` rebuilds reassign. The
suite re-resolves natural keys against the live DB at runtime (with a child-market
fallback), so the benchmark survives full pipeline rebuilds.

## Commands

```bash
# regenerate the sample (read-only; refuses to clobber without --force)
bun run services/pipeline/src/scripts/build-eval-sample.ts [--force] [--seed xplat-eval-v1]

# run the suite (read-only; skips unlabeled rows)
bun run services/pipeline/src/scripts/run-eval-suite.ts
bun run services/pipeline/src/scripts/run-eval-suite.ts --file data/eval/xplat-equivalence/v1.seed.jsonl

# CI gate (exit 1 if below threshold; gates the question-grain merge metrics)
bun run services/pipeline/src/scripts/run-eval-suite.ts --assert-min-precision 0.95 --assert-min-recall 0.5
```

Determinism: every selection orders by `md5(seed || natural-key)` with seed
`xplat-eval-v1`; re-running against the same DB state reproduces the files byte-for-byte
(except `generated_at`). The committed JSONL files are the canonical artifact — the DB
moves, the files don't.

## What the suite measures

| Metric | Question it answers |
|---|---|
| (a) Stage-3a candidate recall | for labeled positives (equivalent + subset): does ANY `stage3_event_candidates` row exist? (the paper's R@20 analogue — they measure 99.9%) |
| (b) question-grain merge precision/recall | equivalent pairs MUST share a `questions` node; every other label MUST NOT. Also at anchor-market grain for seed rows |
| (c) Stage-3b verification FP/FN | among pairs that became candidates: `done` on a non-equivalent pair = FP (paper: <2%); `skipped`/`failed` on an equivalent pair = FN |
| (d) Cohen's κ | agreement on the double-annotated subset |
| failure-mode breakdown | which resolution-semantics dimension produces the FPs/FNs |

Note: a **subset** pair counts as a *positive* for (a) — retrieval should surface it — but
as a *negative* for (b)/(c): merging a subset pair into one outcome-node is a soundness
bug (top-5 fused with top-10 manufactures fake arbs); subsets belong in implication
edges, not merges.

## The labels

Judge the **pair of platform events** (each side may roll up many child markets — read the
child samples, not just the event title). Ask, in order:

1. Same underlying real-world event? NO → `unrelated`.
2. Same measurable question with compatible resolution semantics (scope, period,
   oracle/source, timestamps, value grid), such that legs align one-to-one and matched
   legs must resolve identically in every world? YES → `equivalent`.
3. Does one side's outcome structure strictly refine/restrict the other's (every YES-world
   of the finer side implies a YES-world of the coarser side, not conversely)? YES →
   `subset_a_in_b` if side **A** is the narrower/finer side, else `subset_b_in_a`.
   (Sides are fixed in the record; A/B refer to `side_a`/`side_b`.)
4. Otherwise (same event, but periods/scopes/oracles/windows/grids overlap without
   equality or containment) → `related_not_equivalent`.

Do **not** label from `cosine_distance` or `llm_reasoning` — both belong to the system
under test (and some distances are corrupted by a known embedding bug, e.g. an Oscars
event at distance 0.015 from an ETH candle). Resolution-rules ties go to the platform's
actual settlement source: when in doubt, open both markets' rules pages.

### `equivalent` — 3 real pairs from this DB

1. kalshi `kalshi:event:KXEPL1H-26MAY13MCICRY` "Manchester City vs Crystal Palace: First
   Half Winner" ↔ polymarket `465146` "Manchester City FC vs. Crystal Palace FC - Halftime
   Result" — same fixture, same period (first half), 3-way outcome space aligns leg-for-leg.
2. predict `15731` ↔ polymarket `199445` "MagicBlock FDV above $300M one day after
   launch?" — byte-identical question; the underlying markets share an on-chain conditionId.
3. kalshi `kalshi:event:KXSERIEAGAME-26MAY11NAPBFC` "Napoli vs Bologna" ↔ polymarket
   `425498` "SSC Napoli vs. Bologna FC 1909" — same Serie A fixture; naming drift only.

### `subset_a_in_b` / `subset_b_in_a` — 3 real pairs

1. kalshi `kalshi:event:KXPGATOP5-ONMBC26` "Myrtle Beach Classic: Top 5 Finishers" (A) ⊂
   polymarket `448436` "ONEflight Myrtle Beach Classic Top 10" (B): a player in the top 5
   is necessarily in the top 10 → `subset_a_in_b` + `value_grid_mismatch`. (The pipeline
   currently has this pair `done`/merged — exactly the FP class this set exists to catch.)
2. polymarket `472537` "West Ham United FC vs. Leeds United FC - Exact Score" ⊂ kalshi
   `kalshi:event:KXEPLSPREAD-26MAY24WHULEE` "West Ham vs Leeds United: Spread": each exact
   scoreline fixes the margin, so every exact-score leg implies exactly one spread band —
   the exact-score side is the finer partition.
3. limitless `limitless:event:0xb7db544f…669b00` "Ligue 1, Strasbourg vs Monaco: Draw" ⊃
   polymarket `465172` "RC Strasbourg Alsace vs. AS Monaco FC - Exact Score": every drawn
   scoreline (0-0, 1-1, …) implies Draw; the exact-score side refines the binary Draw
   market → `subset_b_in_a` (B is the finer side; A=limitless, B=polymarket after
   canonical side ordering — **always check which side is which in YOUR record**).

Canonical subset patterns: top-5 ⊂ top-10; "wins by 2+" ⊂ "wins"; "before June" ⊂ "before
July"; exact score ⊂ margin/spread/winner; "12+ corners" ⊂ "11+ corners".

### `related_not_equivalent` — 3 real pairs

1. kalshi `kalshi:event:KXHIGHNY-26MAY14` "Highest temperature in NYC on May 14, 2026?" ↔
   polymarket `476099` "Highest temperature in NYC on May 14?" — textually near-identical,
   but Kalshi settles on the NWS Climatological Report (**Central Park** station) and PM
   on Wunderground **LaGuardia** → `oracle_mismatch`. This is the published trap pair the
   reference paper AND its human annotators got wrong; the pipeline currently has it
   `done` (a live FP).
2. predict `82517` "Bitcoin Up or Down - May 14, 2:15AM-2:20AM ET" ↔ polymarket `480059`
   "Bitcoin Up or Down - May 14, 2:15AM-2:30AM ET" — overlapping but different candle
   windows (5m vs 15m; cosine distance 0.007!). Direction over a sub-window does not
   determine direction over the window: no containment → `timestamp_mismatch`.
3. kalshi `kalshi:event:KXPGAR3TOP10-PGC26` "PGA Championship: Round 3 Top 10" ↔
   polymarket `474340` "PGA Tour: PGA Championship Top 20" — same tournament, but a
   round-3 standing is not the final result, and 10 ≠ 20 → `period_mismatch` +
   `value_grid_mismatch`.

### `unrelated` — 3 real pairs

1. kalshi `kalshi:event:KXPGATOP20-ONMBC26` "Myrtle Beach Classic: Top 20" ↔ polymarket
   `474339` "PGA Tour: PGA Championship Top 10" — same template, **different
   tournaments**.
2. polymarket `472538` "Lowest temperature in NYC on May 13?" ↔ kalshi
   `kalshi:event:KXLOWTSFO-26MAY13` "Lowest temperature in San Francisco on May 13" —
   same metric and day, different city → different event.
3. kalshi `kalshi:event:KXOSCARDIR-27` "Oscar for Best Director?" ↔ polymarket `468853`
   "Ethereum Up or Down - May 10, 9:30PM-9:35PM ET" — domain mismatch (its 0.015 cosine
   distance is the corruption artifact mentioned above).

## Failure-mode sublabels

Apply to any **non-equivalent** label where the two sides concern the **same real-world
event/subject** (mostly `related_not_equivalent` and `subset_*`; leave empty for
`equivalent`, and for `unrelated` — a different fixture is a different event, not a
"mode"). Multiple modes allowed; list the dominant one first.

| Mode | Meaning | Canonical example |
|---|---|---|
| `scope_mismatch` | resolution scope differs: full-time vs incl. extra-time/penalties; series vs single game; regulation vs incl. OT | FT 3-way vs "to qualify" |
| `period_mismatch` | different sub-period of the same event: halftime vs full match, round 3 vs tournament, map 2 vs series, F5 innings | PGA round-3 top-10 vs tournament top-20 |
| `oracle_mismatch` | different resolution source/authority: weather station, NWS vs Wunderground, CF-Benchmarks vs Coinbase | the NYC Central-Park/LaGuardia trap |
| `timestamp_mismatch` | different cutoff/window/snapshot: candle open+duration, "by June 1" vs "by July 1", deadline drift | BTC 5m vs 15m candle |
| `value_grid_mismatch` | numeric line/grid differs: int vs half-point lines, top-5 vs top-10, CPI 2.9% vs 3.4%, FDV $300M vs $400M | "11+ corners" vs "O/U 11.5" (note: that one is containment → subset, not related!) |

## κ protocol (the 150-pair double-annotation subset)

1. `kappa_subset: true` marks a deterministic 150-of-600 subset (hash-selected, so it is
   stratification-balanced in expectation).
2. Annotator 1 labels all 600 rows (`label`, `failure_modes`, `annotator`, `labeled_at`).
3. Annotator 2 labels the κ rows **independently and blind** — work from a fresh copy of
   `v1.todo.jsonl`, never from annotator 1's file — and the results are copied into
   `annotator2_label`/`annotator2`.
4. `run-eval-suite.ts` computes Cohen's κ (5-class) over rows with both labels. **Target
   κ ≥ 0.85** (the paper reports 0.94). κ < 0.70 → the protocol is ambiguous: revise this
   README's definitions, then relabel the subset.
5. Disagreements are adjudicated jointly; the final decision goes to `label` (note
   `adjudicated` in `notes`); `annotator2_label` stays as originally given (the κ stays
   honest).
6. If a second human is unavailable, an LLM second-annotator κ MAY be reported but MUST
   be labeled as such (`annotator2: "llm:<model>"`); it does not count toward the κ target.
7. `failure_modes` agreement is reported as raw percent agreement only (multi-label κ is
   not meaningful at n=150).

## Sample composition (built 2026-06-10, run #230 DB, seed `xplat-eval-v1`)

All quotas filled — no shortfalls:

| Stratum | Cell | Target | Filled | Available |
|---|---|---|---|---|
| funnel_done | kalshi×polymarket | 80 | 80 | 2,818 |
| funnel_skipped | kalshi×polymarket | 80 | 80 | 17,909 |
| funnel_failed | kalshi×polymarket | 50 | 50 | 911 |
| funnel_done | polymarket×predict | 30 | 30 | 889 |
| funnel_skipped | polymarket×predict | 30 | 30 | 6,036 |
| funnel_failed | polymarket×predict | 20 | 20 | 147 |
| funnel_done/skipped/failed | kalshi×limitless | 15+15+15 | 45 | 147/1,267/212 |
| funnel_done/skipped/failed | kalshi×predict | 15+15+15 | 45 | 136/1,158/183 |
| funnel_done/skipped/failed | limitless×polymarket | 15+15+15 | 45 | 392/1,391/174 |
| funnel_done/skipped/failed | limitless×predict | 10+10+10 | 30 | 96/682/38 |
| hardneg_band_candidate (cos 0.30–0.45, same-day-league first) | any | 45 | 45 | 8,549 |
| hardneg_band_never_candidate (cos 0.351–0.45, no candidate row) | any | 50 | 50 | 556 |
| same_day_league_never_candidate (league round-robin, nearest-first) | any | 50 | 50 | 44,203 |
| **todo total** | | **600** | **600** | |
| cross_ref_seed | predict×polymarket | 150 | 150 | 681 |

Kind families (todo): match_winner 177, nonsports 110, other 80, totals 79, futures 73,
spreads 45, props 36. Funnel cells are family-round-robined, so thin families (props,
spreads) are oversampled relative to the raw funnel mix — by design.

Within the funnel core, 500 of the 600 rows carry a Stage-3b candidate row, so the same
labels double as the design's "verification instances re-judged" set (metric (c)).

## Caveats (read before trusting numbers)

- **Seed grain**: `market_cross_refs` proves *market*-grain identity (shared on-chain
  conditionId). At the *event* grain a seed pair can be subset-shaped (e.g. a PM event
  bundling 42 esports props vs a predict match-winner-only event) — the `equivalent`
  label asserts the anchored legs, which is what metric (b)'s anchor-grain recall and
  (a)'s candidate recall consume. Pure event-grain conclusions should prefer the human
  set. Cross-refs exist only for predict×polymarket today.
- All 681 cross-ref pairs are **excluded** from `v1.todo.jsonl` so human effort goes
  where there is no free ground truth.
- `context.pipeline.*` is as-of-build; the suite recomputes everything live. After a
  rebuild, `same_semantic_event`/`shared_question_count` in the file may be stale — that
  is expected and harmless.
- `cosine_distance` may be corrupted for ~3% of events (audit F9 embedding aliasing;
  repair runbook pending). The `hardneg_band_*` strata inherit this noise; the
  same-day-same-league stratum is distance-independent by construction.
- Baseline live numbers on the seed file (2026-06-10, run #230): Stage-3a candidate
  recall **79.3%** (119/150), question-grain merge recall **58.7%** (88/150, precision
  100% — trivial on a positives-only file), Stage-3b FN rate **16.8%** (20/119 failed,
  0 FP). These are the numbers to beat; the R1 failed-candidate-salvage lever should move
  the FN rate first.
