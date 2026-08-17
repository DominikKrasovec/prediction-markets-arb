# arb-solver

Real-time arbitrage detection service. Loads a constraint graph from Postgres, builds market clusters via BFS, subscribes to live CLOB price feeds from all 4 platforms, and continuously solves linear programs to find profitable arbitrage portfolios.

## Responsibilities
- Load the constraint graph (questions + implication edges + outcome sets) from DB
- Build connected-component clusters (BFS) — each cluster is solved independently
- Track live bid/ask prices per market via 4 CLOB adapters
- On any price update: mark the cluster dirty → debounce → solve LP (HiGHS WASM)
- Persist `ArbOpportunity` rows; publish `arb:detected` / `arb:expired` events
- Expire stale opportunities when prices move out of range

## Directory layout

```
arb-solver/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          Main entry — wires graph loader, price cache, solver loop
    ├── config.ts         Runtime config (min profit, edge confidence, debounce ms)
    ├── events.ts         Event-bus publish helpers (arb:detected, arb:expired, solver:graph_reloaded)
    ├── persistence.ts    DB writes: persist opportunities, prices; expire stale arbs
    ├── clob/             CLOB price subscription layer → see clob/doc.md
    ├── graph/            Constraint graph loading + cluster building → see graph/doc.md
    └── solver/           LP formulation + HiGHS WASM solve → see solver/doc.md
```

## Key loop (index.ts)
1. `loadGraph()` → builds `clusters[]` + `marketClusterIndex`, and precomputes each cluster's `validStates` via `enumerateStates` (once, at load — not per solve)
2. `getMarketsToTrack()` → derives subscriptions from clusters
3. `ClobManager.startTracking(subs)` → connects adapters; fires `onPriceUpdate`
4. `onPriceUpdate(update)`:
   - `PriceCache.update(update)`
   - Look up cluster → add to `dirtySet`
   - Debounce solve (`config.solver.debounceMs`) → `solveDirty()`
5. `solveDirty()` (per dirty cluster):
   - `buildLP(cluster, priceCache, config.execution)` → `LPProblem` (execution gate: fees folded into the objective + per-leg depth caps when enabled)
   - `solveLP(problem)` → HiGHS `LPResult`
   - `extractPortfolio(result, lp, cluster, priceCache, minProfit, gradeThresholds)` → `ArbOpportunity | null` (attaches an `executionGrade` annotation)
   - If a CERTIFIED arb: `persistOpportunity` + `publishArbDetected`
   - If no certified arb: drop any prior `activeArbs` entry, then — only when `config.execution.gradedResidualChannel` is on (default OFF) — try `solveGradedResidual()`, persisting any near-arb as a NON-certified `lp_solver_graded` / `residual_tail` row (never `guaranteed_payout=1`)
   - Expiry of stale certified/graded rows is persisted on the next graph reload via `expireStaleOpportunities`
6. Periodic graph reload — a hardcoded 60 s poll of the event bus' `pipeline / graph_updated` signal triggers `reloadGraph()`

## Caveats
- HiGHS WASM runs synchronously in the Node.js thread — large clusters can block the event loop. Clusters are intentionally kept small by the BFS connector.
- `minEdgeConfidence` (config) filters low-confidence edges to avoid LP infeasibility due to noisy implication edges.
- **Execution gate** (`config.execution`, default ON): per-platform taker fees are folded into the LP objective (net-of-fee edge) and each leg is bounded by top-of-book depth; a quote-age TTL (`ARB_QUOTE_TTL_MS`, default 120 s) marks aged snapshots stale so they are excluded from the LP. All three only ever shrink or reject a basket — never manufacture a fake arb. Each detected basket also carries a `clean`/`caution`/`risky` execution grade (annotation only; does not gate soundness). See `solver/fees.ts`, `solver/execution-grade.ts`.
- **Categorical exhaustivity (GATE-0)**: the loader reads `outcome_sets.is_exhaustive` (migration 061) to decide Σ=1 (provably exhaustive one-hot) vs Σ≤1 (mutual exclusion only, the extra all-FALSE world enumerated). A missing column / NULL fails SAFE to Σ≤1 — the only direction that cannot manufacture a fake buy-all-YES arb.
- Resolution events from CLOB WSS adapters are handled in `handleResolutionEvent` (index.ts): the write is delegated to `@arb/resolution-write` (`writeAndPublishResolution`) — the same shared writer used by ingestion — which provides SELECT FOR UPDATE row locking, COALESCE idempotency, 4-way outcome enum, and automatic `markets/resolved` bus publish. arb-solver-local concerns (price cache eviction, CLOB unsubscribe) are keyed off the `marketId` returned by the writer, with no extra SELECT.
- A periodic poll (`RESOLUTION_POLL_INTERVAL_MS`, default 60 s) also checks `markets.resolved_at` for markets resolved by ingestion's resolution-monitor (cross-service signal via DB rather than event-bus, which may not be running).
- Arb opportunities are per-cluster, not global; cross-cluster arbs are not detected.
