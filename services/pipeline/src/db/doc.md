# pipeline/src/db/

Postgres access layer for the pipeline service. Contains the connection-pool
import boundary, sync helpers, the entity-KB modules, and all query modules
under `queries/`.

## Files at this level

| File | Role |
|------|------|
| `sync.ts` | `runSync()` — syncs raw platform tables (`kalshi_markets`, `polymarket_markets`, etc.) into the unified pipeline `markets` table. Also enqueues newly-synced markets into `stage1_queue`. |
| `maintenance.ts` | `vacuumAnalyze(tables)` — VACUUM (ANALYZE) at phase boundaries so dead-tuple bloat from UPDATEs doesn't accumulate during long pipeline runs. Called from `run.ts` after Stage 1 and after the KB-side UPDATEs; the post-projection vacuum lives inside `runEventGraph()` (run-event-graph.ts) so batch AND daemon Loop 3 inherit it by construction. Failures are warn-and-continue (next run picks up the bloat). |
| `health-checks.ts` | Startup DB connectivity + key-table/index assertions. |
| `entity-registry.ts` | **Barrel** — re-exports the entity-KB surface (`registerEntities`, KB cache, taxonomy, resolvers, histogram, backfill, load). Implementation lives under `entity/`; consumers should import from this barrel, not from `entity/*.ts` directly. |
| `category-taxonomy.ts` | `getDomainForCategory(category)` → domain string. `getUnifiedCategory(platform, platformCategory)` → normalised category name. Static mapping tables. |
| `enrich-entity-metadata.ts` | `enrichEntityMetadata(entityId)` — fills KB metadata fields from category/tag signals found in associated markets. Called during Stage 1d. |
| `seed-entity-kb.ts` | `seedEntityKB()` — seeds structural KB entries: major sports leagues, crypto assets (BTC, ETH, …), known provider names. Idempotent. |
| `market-normalizer.ts` | Title / resolution-source normalisation helpers used by `sync.ts` and the Stage 1 deterministic templates. |
| `resolution-extract.ts` | Pure per-platform mappers: raw scraper payload → `{resolved_at, winning_outcome, outcomes, source}` (audit U6). Called by `sync.ts` per upserted doc; write-once COALESCE semantics live in `queries/markets.ts` `bulkUpsertMarkets`. Void sentinels are platform-faithful: PM `VOID_5050` (50/50 split settlement), Kalshi `VOID`. Never guesses — unresolved/ambiguous payloads return null. Checked downstream by `scripts/check-resolved-consistency.ts`. |
| `structural-resolver.test.ts` | Tests for structural resolver paths. |
| `fold-ascii.test.ts` | Unicode-fold token tests. |
| `entity-category-histogram.test.ts` | Tests for migration-029 histogram gate. |
| `entity-registry.test.ts` | Tests for the KB barrel surface. |

## entity/ subfolder

The entity KB lives in `entity/`, split into focused modules. Public consumers
should import from the `entity-registry.ts` barrel — these modules use
underscore-prefixed exports to share private state with each other without
leaking it.

| File | Role |
|------|------|
| `types.ts` | Shared interfaces (`KBLookupResult`, `KBRow`, `EntityKB`, `KBScope`, …). |
| `cache.ts` | In-process KB cache + `warmKBCache`, `invalidateKBCache`, `rehydrateKBCacheRow`, `purgeSubjectCacheByCanonicals`, `consumeNewEntityCount`, `_kbCacheInsert`. |
| `tokens.ts` | `foldAscii`, `extractSignificantTokens`, `looksLikeAcronymOf`, `computeAcronym`, stop-word filtering. |
| `sport-hierarchy.ts` | `areSportsCompatible`, `compatibleSportCanonicals`, `moreSpecificSport`, `ESPORTS_GAMES`, `ESPORTS_UMBRELLA`. Esports umbrella ↔ specific-game relation; consumed by every gate that checks `sport_canonical`. |
| `league-hierarchy.ts` | `areLeaguesCompatible`, `compatibleLeagueCanonicals`. KB-driven analog of sport-hierarchy (AHL ↔ American Hockey League via the alias graph in `known_entities`). |
| `taxonomy.ts` | `resolveTaxonomyCanonical`, `getTaxonomyContext`. |
| `resolvers.ts` | `leagueResolver`, `providerResolver`, `sportResolver`, `resolveSubjectViaKB`, `resolveSubjectAndParticipants`. Tier-1 alias/canonical lookup; subject resolver also does T2 embedding + T3 create. |
| `register.ts` | `registerEntities` (public) wrapping the internal `findOrCreateEntity` (three-pass: canonical → alias → fuzzy, plus a 3b alias-collision check, and a fold-variant bridge) + merge helpers (`mergeAliases`, `mergeAliasVariants`, `mergeEntityMetadata`, `maybePromoteCanonical`) + scope/fold helpers (`getIncomingScope`, `bridgeGateOk`, `findFoldVariantBridge`). Single source of truth for KB writes. |
| `upsert.ts` | Low-level `known_entities` INSERT/UPDATE primitives used by `register.ts` and the resolvers — the actual SQL writes (with `enqueueEntityEnrichment` / `_kbCacheInsert` firing only on a true insert). |
| `structural-signals.ts` | Helpers for deriving/reading structural scope signals (sport/league) on entities — supports `infer-entity-scope.ts` and the scope-aware resolvers. |
| `histogram.ts` | Per-entity category histograms (migration 029): `incrementEntityCategoryCount`, `getEntityCategoryMass`, `mergeEntityCategoryCountsTx`, `evaluateHistogramGate`, `invalidateEntityCategoryCache`. Reads `config.stage1.kbHistogramGate*` — never `process.env` directly. |
| `backfill.ts` | `backfillSubjectsViaKB` — Stage-1f re-resolution of every distinct entity phrase through the now-enriched KB. Rewrites four columns on `llm_market_normalizations` (`canonical_subject`, `participants[]` in any position, `canonical_event` via `deriveCanonicalEventCore`, `resolved_entities` JSONB canonicals) AND the same three text columns on `platform_events` (so the canonical-name fields the event embeddings + Stage 3 matcher read stay consistent after a KB merge). |
| `load.ts` | `loadEntityKB`, `overlapKey` — bulk-load + pair-overlap precompute helpers (per-market entity weights + canonical pair key). |

## Queries subfolder

See [`queries/doc.md`](queries/doc.md) for the full inventory of query modules.

## Caveats

- `query()` and `endPool()` are imported from the `@arb/db` workspace
  package (`import { query } from '@arb/db'`). The pool, `DATABASE_URL`, and
  lifecycle live there. There is no `postgres.ts` in this folder.
- `sync.ts` is the only place where raw platform tables are read and written
  into the unified `markets` table; do not duplicate this logic elsewhere.
- `category-taxonomy.ts` contains static mappings that must be updated
  manually when platforms add new categories.
- The `entity/` modules use `_*`-prefixed exports for cross-module private
  state (e.g. `_kbCacheInsert`). Don't re-export these from the barrel.

## KB category histograms (migration 029)

`entity_category_counts(entity_id, category, n)` materializes the per-entity
distribution of `markets.category_unified`. Read by the **histogram gate**
before any LLM merge call so the same surface form ("Trump") cannot collapse
across unrelated categories (politics vs DJT stock).

Maintenance points (must stay in sync — H11 surfaces drift):

- **Increment**: every `market_entity_links` INSERT must follow with
  `incrementEntityCategoryCount(marketId, entityId, categoryUnified?)`. The
  single-statement UPSERT skips rows where `markets.category_unified IS NULL`
  (Stage 1 may run before classification; the backfill catches them later).
- **Merge rewrite**: `mergeEntityCategoryCountsTx(client, keepId, dropId)`
  runs inside the merge transaction in `entity-enrichment/merge.ts`,
  mirroring the link-table rewrite.
- **Cache invalidation**: `invalidateEntityCategoryCache(entityId?)` is paired
  with `rehydrateKBCacheRow` / `invalidateKBCache` in the merge cleanup so
  gate reads don't serve pre-merge mass distributions.

Gate behaviour controlled by `config.stage1.kbHistogramGateMode`
(env `KB_HISTOGRAM_GATE_MODE` ∈ `off | warn | enforce`, default `off`) and
`config.stage1.kbHistogramGateMinMass` (env `KB_HISTOGRAM_GATE_MIN_MASS`,
default `0.10`). Both gated paths — `evaluateHistogramGate` in
`entity/histogram.ts` and the overlap check in
`entity-enrichment/merge-probe.ts` — read these via `config`, never via
`process.env` directly. There is one knob; flipping it affects both paths.
