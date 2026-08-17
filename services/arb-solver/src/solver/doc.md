# arb-solver/src/solver/

LP formulation and solving layer. Takes a cluster plus current prices, builds a linear program over the cluster's outcome space Ω, solves it with HiGHS WASM, and extracts a concrete arbitrage portfolio.

Two engines describe the same polytope in two different ways. `config.solver.engine` (`SOLVE_ENGINE`) selects between them and **defaults to `facet`**; `vrep` and `hybrid` are the alternatives.

## Facet engine (default) — `facet-lp.ts`

The H-representation solver. It emits one dual row per cluster question plus a coverage row, so the LP is O(n) in the number of questions regardless of how large |Ω| is. `clusterToFacets` turns the cluster's outcome sets and implication edges into `FacetConstraint`s (via `omega-constraints.ts`), `buildFacetLP` attaches the leg variables, and `solveFacetLP` runs HiGHS in-process — the worker pool renders V-rep state rows only, so a facet LP cannot be offloaded to it.

Because it never enumerates worlds, it solves clusters the enumerator has to drop, and it is the rescue path when V-rep enumeration exceeds its caps (`SOLVE_RELAXED_ROUTE`, `SOLVE_FACET_CLUSTER_QUESTION_CAP`). It matches the V-rep answer exactly on every integral polytope and is conservatively sound off it — it can miss a real arb, never invent one.

## V-rep engine (fallback) — `state-enumerator.ts` + `lp-builder.ts` + `solver.ts`

The vertex-representation path. `enumerateStates(cluster, opts?)` materializes every valid `WorldState` by combining outcome-set constraints (categorical = exactly one TRUE, plus an all-FALSE world when `isExhaustive` is false or absent, giving Σ≤1; threshold series = ordered prefix, k+1 states) and filtering by implication edges. It is exponential in the free-question count and is capped at `opts.maxStates` (`config.solver.maxStates`); on a drop it emits a structured DROP diagnostic. `buildLP` then writes one LP constraint per enumerated world, and `solveLP` renders the `LPProblem` to LP-format text (`lp-string.ts`) and calls HiGHS.

Enumeration runs once per graph load (`index.ts`'s `loadGraph`), not per solve, so the state set is stale between reloads. `hybrid` enumerates but falls back to the facet engine for relaxed or empty clusters.

## LP structure

Both engines share the leg variables (`buildLegVariables` in `lp-builder.ts`): two per market (buy YES / buy NO), objective coefficient = fee-adjusted ask, plus a `maxShares` top-of-book depth cap when the execution gate is on. Only the constraint rows differ.

There are two objective forms, and **they compute profit differently**:

- **Min-cost-$1** (default). Minimize the fee-inclusive basket cost subject to a guaranteed payout of at least $1 in every world. Guaranteed payout is normalized to 1, so `profit = 1 − optimalCost`; a solution with `optimalCost ≥ 1` is rejected.
- **Depth-aware profit-max** (the book-ladder path, `CLOB_BOOK_LADDER=1`). A free guaranteed-payout variable `G` is added and the objective becomes `cost − G`, i.e. the negated profit. So `profit = −optimalCost` and the guaranteed payout is the solved value of `G`, not 1. `portfolio.ts` distinguishes the two by `problem.guaranteedPayoutVarIndex`.

```
Min-cost-$1:
  Minimize    Σ (ask_i + fee_i) · x_i
  Subject To  (per Ω constraint)  Σ payout_i · x_i ≥ 1
  Bounds      0 ≤ x_i [ ≤ maxShares_i ]
  profit = 1 − optimalCost

Depth-aware profit-max (book ladder):
  Minimize    Σ (ask_i + fee_i) · x_i − G
  Subject To  (per Ω constraint)  Σ payout_i · x_i ≥ G
  Bounds      0 ≤ x_i ≤ maxShares_i,  G ≥ 0
  profit = −optimalCost,  guaranteed payout = G
```

## Supporting modules

| File | Role |
|------|------|
| `types.ts` | `LPVariable` (carries `feePerShare` + a `maxShares` depth cap), `LPProblem`, `LPResult`, `FacetConstraint`/`FacetForm`, `ArbOpportunity` (carries `feesUsd`, `executionGrade`, `executionReasons`), `PortfolioLeg`, plus `ExecutionParams` and the `NO_EXECUTION_GATE` no-op default. |
| `omega-constraints.ts` | The single description of Ω: interprets a cluster into constraints and converts them to facets. Both engines read it, so they cannot drift apart. |
| `omega-audit.ts` | `unquotedQuestions` — the Ω-liveness predicate that demotes an exhaustive categorical with a dead slot to Σ≤1. |
| `fees.ts` | Per-market, form-aware taker-fee model. `FeeModel` is either `bernoulli` (`rate·(p·(1−p))^exponent`) or `limitless-curve` (asymmetric buy/sell, conservative flat bound). Every default rounds toward a HIGHER fee — under-charging manufactures fake arbs. Folding a fee can only raise cost, so it can shrink or reject a basket, never create one. |
| `portfolio.ts` | `extractPortfolio(...)` maps HiGHS variable values back to concrete legs; cost and profit are net of fees (the objective already folded them in). Returns `null` if not optimal or if `profit < minProfit`. |
| `execution-grade.ts` | `gradeExecution` → `clean` / `caution` / `risky`: a pure ANNOTATION over the worst single leg signal (thin book / stale quote / wide spread / multi-platform risk). Never hard-rejects; true infeasibility is excluded upstream in the LP. |
| `venue-constraints.ts` | Post-solve venue-granularity pass on the ladder path (`ARB_VENUE_ROUNDING`, default ON): rounds each leg DOWN to the venue share step, checks minimum order size, and demotes the grade to `risky` when the rounded profit dies. Tightening-only. |
| `graded-residual.ts` | `solveGradedResidual(...)` — a NON-certified channel, only reached when the certified solve found nothing and only when `config.execution.gradedResidualChannel` is on (default OFF). Re-solves with the all-FALSE worlds of non-exhaustive categorical sets dropped, surfacing near-arbs the strict worst-case LP rejects. The result pays $0 in the residual world, so it is NOT risk-free. |
| `solver-pool.ts`, `solve-worker.ts`, `solve-worker-protocol.ts` | Worker-pool offload for V-rep solves, so a large LP does not block the event loop. |
| `skip-filter.ts`, `venue-mismatch.ts`, `settlement-economics.ts`, `cluster-fingerprint.ts` | Pre- and post-solve filters and the dedup fingerprint. |

## Caveats
- HiGHS WASM solve is synchronous. V-rep solves can be offloaded to the worker pool; a facet LP is always solved in-process, so keep facet clusters within `SOLVE_FACET_CLUSTER_QUESTION_CAP`.
- The `LPProblem` is generated fresh on every solve; there is no warm-start.
- Legs with `shares < MIN_SHARES_THRESHOLD` (1e-6) are dropped; the LP itself does no rounding to whole cents.
- Venues without doc-verified share-step / minimum-size constraints (Limitless, Predict) pass through the venue-rounding pass unchanged.
