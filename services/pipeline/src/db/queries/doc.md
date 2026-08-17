# pipeline/src/db/queries/

One query module per domain entity. Each module exports typed functions that
call `query()` from the `@arb/db` package (single connection pool, shared
across the whole pipeline). All SQL is inline; no ORM.

## Files

| File | Domain | Key exports |
|------|--------|-------------|
| `index.ts` | Barrel | Re-exports a subset of the modules below (see "Barrel coverage" caveat). |
| `pipeline-runs.ts` | Pipeline run log + sync watermarks | `createPipelineRun`, `updatePhaseStats`, `completePipelineRun`, `failPipelineRun`, `getWatermark`, `setWatermark` |
| `markets.ts` | Markets table | `upsertMarket`, `upsertMarketMetadata`, `bulkUpsertMarkets`, `bulkUpsertMarketMetadata`, `getUnfeaturizedMarketsWithGroups`, `selectMarketsNeedingEmbedding`, `countMarketsNeedingEmbedding`, `bulkUpdateMarketEmbeddings`, `getAllMarketPlatforms`, `getMarketMetadataRaw`, `loadCategoryUnifiedMap`, `loadConditionDateInfoMap`, `updateMarketCategoryUnified`, `bulkUpdateMarketCategoryUnified` |
| `features.ts` | Market features | `insertMarketFeatures`, `bulkInsertMarketFeatures`, `loadFeaturizedMarketIds` |
| `normalizations.ts` | LLM normalisations | `upsertNormalization`, `bulkUpsertNormalizations`, `getAllResolutionSources` |
| `match-source.ts` | `match_source` predicates | `isParlaySql(alias)`, `notParlaySql(alias)`, `isParlayMatchSource(value)`, `KALSHI_PARLAY_PREFIX`. Single source of truth for "is this row a parlay" across SQL and TS. |
| `normalization-predicates.ts` | `llm_market_normalizations` row-validity predicate | `validNormalizationSql(alias)` — sentinel-row + positive-confidence guard. Single source of truth for "is this normalization row real" (was historically open-coded in 6 sites). |
| `questions.ts` | Question count reconciliation | `updateAllQuestionCounts` (recompute member/platform counts, archive orphan nodes + dangling edges). Outcome-node `questions` rows are PROJECTED in Stage 4 (`stage4-events/finalize.ts`, `sem:`/`pe:` keys) — the old hash-key grouping (`hashKeyGroupQuestions`/`linkMarketsToQuestions`) + candidate-discovery exports were removed in the event-centric cleanup (2026-05-31). |
| `edges.ts` | Implication edges | `upsertLLMEdge`, `upsertRuleEdgesBulk`, `getAllEdges`, `getChainEdges`, `upsertTransitiveEdgesBulk`, `recordContradiction` |
| `semantic-events.ts` | Cross-platform semantic events (Stage 3 matcher state) | `claimEventCandidates`, `getPlatformEventForMatch`, `findSemanticEventIdForPlatformEvent`, `persistMatch`, `markCandidate`, `nextTransientStatus`, `markTransientFailure`, `resetStaleInProgress`, `countPendingCandidates`, `getChildMarketMeta`, `getSemanticEventLegSubjects`, `getSubjectTypes`, `requeueSalvageableFailedCandidates` |
| `platform-events.ts` | Platform events | `refreshPlatformEventGroup`, `getUnnormalizedEvents`, `markEventNormalized`, `getEventChildMarkets`, `getMatchedEventPairs`, `getEventChildQuestions` |
| `stage1-queue.ts` | Stage 1 queue | `enqueueStage1`, `claimStage1Batch`, `markStage1Done`, `markStage1Failed`, `recoverStuckStage1`, `backfillStage1Queue`, `getStage1QueueStats`, `getPendingCount` |
| `stage23-queue.ts` | Stage 2+3 queue | `STAGE23_THRESHOLD`, `enqueueStage23`, `drainStage23Queue`, `shouldTriggerStage23` |
| `rule-queue.ts` | Rule pair queue | `enqueuePairsBulk`, `getUnprocessedPairs`, `markPairProcessed` |
| `rule-decisions.ts` | Rule decisions | `Decision`, `DecisionRow`, `recordDecisions` |
| `entity-enrichment-queue.ts` | Enrichment queue | `EnrichmentClaim`, `enqueueEntityEnrichment`, `claimEnrichmentBatch`, `setEnrichmentTypeHint`, `markEnrichmentDone`, `markEnrichmentSkipped`, `markEnrichmentFailed`, `recoverStuckEnrichment` |
| `kalshi-classify.ts` | Kalshi title classification | `KalshiGrouping`, `classifyKalshiTitle`, `classifyKalshiEvent` |
| `market-stats.ts` | Market stats | `captureMarketSnapshot` |

## Connection pool

`query()` is imported from the `@arb/db` workspace package — there is no
`postgres.ts` in this folder. The package owns the `pg.Pool`, the
`DATABASE_URL` env read, and `endPool()`. Every query module here imports
`{ query } from '@arb/db'`.

## Barrel coverage

`index.ts` re-exports a subset of the functional modules above
(`pipeline-runs`, `markets`, `features`, `normalizations`, `questions`,
`edges`, `rule-decisions`, `platform-events`, `stage1-queue`,
`market-stats`). The following modules are intentionally NOT in the barrel;
consumers must import them by path:

- `stage23-queue.js` — imported directly by `run.ts`, `daemon.ts`
- `semantic-events.js` — imported directly by `run-event-graph.ts` + Stage 3
- `match-source.js` / `normalization-predicates.js` — predicate helpers imported where needed
- `rule-queue.js` — legacy rule pair queue (rule engine retired; kept for the table API)
- `entity-enrichment-queue.js` — imported by `entity-enrichment/`
- `kalshi-classify.js` — imported by `db/sync.ts` and Stage 1

If you add a new query module, decide explicitly whether to expose it via the
barrel or import-by-path; mixed conventions exist on purpose to keep large
"side-effecting" modules out of `import * as queries`.

## Caveats

- **No market_prices / arb-scanner queries.** The pipeline used to maintain
  a `market_prices` table + run its own arb scanner (`trackPrices`,
  `scanForArbitrage`, `refreshQuestionPrices`, `getOutcomeSetsForScan`, etc.).
  That whole subsystem was retired — the `arb-solver` service uses live
  CLOB-API prices and re-prices every opportunity against current quotes
  anyway, so stale DB prices were either redundant or actively misleading.
  Pipeline now builds STRUCTURE only (questions, edges, outcome sets);
  pricing & arb scoring live in arb-solver. The `market_prices` table and
  `questions.best_*_price` columns are preserved in the schema (dashboard
  still reads them) but are no longer written.
- **No `outcome-sets.ts` query module.** Outcome-set construction (the old
  `buildPlatformNativeOutcomeSet` / `buildThresholdSeriesOutcomeSet` /
  `buildCrossPlatformOutcomeSet` etc.) moved into the Stage-4 finalizer under
  `stage4-events/` — see `outcome-set-certifier.ts` and `finalize.ts`. There is
  no longer an `outcome-sets.ts` in this folder.
- All queue drain functions use `SELECT … FOR UPDATE SKIP LOCKED` for safe
  concurrent draining.
- `.d.ts.map` files are build artefacts; ignore them.
