# arb-solver/src/

Root source of the arb-solver service. Contains the main entry point, cross-cutting helpers, and three major subsystems.

## Files

| File | Role |
|------|------|
| `index.ts` | **Main entry.** Wires all subsystems: loads graph, starts price subscriptions, drives the solve loop, handles CLOB resolution events via `@arb/resolution-write`, and polls DB for resolutions written by ingestion. |
| `config.ts` | Runtime configuration loaded from env. Key values: `solver.minEdgeConfidence`, `solver.debounceMs`, `solver.minProfit` ($), `solver.maxStates`, `solver.clusterSizeCap`, `solver.pricePersistIntervalMs`; plus the `execution.*` block (execution gate: `enforceFees`, `enforceDepthCap`, `quoteTtlMs`, `gradeThresholds`, and the default-OFF `gradedResidualChannel`; fees are per-market via each `MarketRef.feeModel`, no per-platform coefficient knob). (The 60 s graph-reload poll interval is hardcoded in `index.ts`.) |
| `events.ts` | Thin wrappers around `@arb/event-bus` publish. Exports `publishArbDetected`, `publishArbExpired`, `publishGraphReloaded`. |
| `persistence.ts` | DB writes: `persistOpportunity` (INSERT … RETURNING id into `arbitrage_opportunities`, `arb_type='lp_solver'`), `persistGradedResidual` (NON-certified `lp_solver_graded` / `residual_tail` row with an honest worst-case payout, upserted), `persistPrices` (bulk upsert into `clob_prices`), `expireStaleOpportunities` (UPDATE `current = FALSE` for `lp_solver`+`lp_solver_graded` rows whose clusters are no longer active). |

## Subsystems

| Folder | Purpose |
|--------|---------|
| [`clob/`](clob/doc.md) | CLOB price subscription layer — manages 4 platform adapters + in-memory price cache |
| [`graph/`](graph/doc.md) | Loads constraint graph from DB; builds BFS clusters + market index |
| [`solver/`](solver/doc.md) | LP formulation (lp-builder), HiGHS WASM solve, state enumeration, portfolio extraction, the execution gate (fees, depth caps, quote staleness, execution-grade) and the graded residual-tail channel for clusters with no certified arb |

## Call flow

```
index.ts
  ├── graph/loader.ts      loadConstraintGraph()
  ├── graph/cluster-builder.ts  buildClusters() + buildMarketIndex()
  ├── solver/state-enumerator.ts  enumerateStates() [per cluster, on load]
  ├── clob/manager.ts      ClobManager.startTracking(subscriptions)
  │     └── clob/adapters/{platform}.ts  → onPriceUpdate(update)
  │           └── clob/price-cache.ts    PriceCache.update(update)
  ├── solver/lp-builder.ts  buildLP(cluster, priceCache, config.execution)  → LPProblem  (folds fees + depth caps)
  ├── solver/solver.ts      solveLP()
  ├── solver/portfolio.ts   extractPortfolio()  → ArbOpportunity (+ executionGrade)
  ├── solver/graded-residual.ts  solveGradedResidual()  [only when no certified arb + flag on]
  ├── persistence.ts        persistOpportunity() / persistGradedResidual() / expireStaleOpportunities()
  ├── @arb/resolution-write  writeAndPublishResolution() + coerceResolvedAt()  [shared package]
  └── events.ts             publishArbDetected() / publishArbExpired()
```
