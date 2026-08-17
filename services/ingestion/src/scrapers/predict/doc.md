# ingestion/src/scrapers/predict/

Predict.fun REST scraper. Crawls markets via categories with cursor pagination. **Requires an API key** (`PREDICT_API_KEY`, sent as the `x-api-key` header) — the client throws on first use if it is unset.

## Files

| File | Role |
|------|------|
| `index.ts` | Barrel — re-exports the api-client, types, `dbService`, and the scraper functions plus the `scraper` object. |
| `types.ts` | TypeScript types + enums for Predict API responses (`PredictMarket`, `PredictCategory`, `MarketStatus`, `CategorySortBy`, etc.). |
| `api-client.ts` | `fetchCategories()`, `fetchMarkets()`, `fetchMarketStats(id)`, `fetchMarketStatsBatch(ids)`, `fetchTags()` against `https://api.predict.fun`. Cursor pagination via the `after` cursor with page size `first` (default 50). |
| `scraper.ts` | Exports `scraper: Scraper` (`{ platform, db, scrapeActive, fullScrape }`) plus helpers. `scrapeActive()` crawls open categories (markets embedded) sorted by 24 h volume; `scrapeResolved()` crawls resolved; `fullScrape()` does categories + markets + tags + stats enrichment. |
| `postgres.ts` | `dbService` — extends `BaseScraperPostgresService`; `saveCategories()` / `saveMarkets()` / `saveTags()` upsert into the `predict_*` tables (`ON CONFLICT (market_id) DO UPDATE`). `saveMarkets` is **non-destructive**: category-enrichment keys (`categoryId`/`categoryTitle`/…, attached only by the categories path) and stats-enrichment keys (`volumeTotalUsd`/…, attached only by `enrichMarketStats`) are merged from the stored raw under any incoming payload that lacks them (`mergePreservedRawKeys`), so a `/v1/markets` pass can no longer clobber them. |

## Key behaviours
- Category-based traversal: categories are fetched with their markets embedded, then both are persisted in the same `onBatch`.
- `scrapeActive` sorts by 24 h volume; `scrapeResolved` and `scrapeCategories` sort by published-at.
- No event/group concept — markets are standalone entries (categories are the grouping).

## Caveats
- The API key is mandatory; `getApiKey()` throws `PREDICT_API_KEY not found` on first client use.
- **Status vocabulary**: market OBJECTS are never `status='OPEN'` — 'OPEN' exists only in the query-param enum. The object vocabulary is `REGISTERED`/`PRICE_PROPOSED`/`PRICE_DISPUTED`/`RESOLVED`/`REMOVED` (+ documented `PAUSED`/`UNPAUSED`); tradability lives in the undocumented `tradingStatus` (`OPEN`/`CLOSED`). SQL filters must use `PREDICT_CURRENT_MARKET_PREDICATE` (postgres.ts), kept in lockstep with `COLD_FILTER_MAP.predict` in `services/pipeline/src/db/sync.ts`.
- The categories path does NOT return all markets (live probe 2026-07-02: 468 OPEN markets appear only in `/v1/markets`), so `fullScrape` keeps its `scrapeMarkets()` pass; the raw-clobber it used to cause is fixed at the save layer instead.
- Predict has no WSS lifecycle feed — there is no Predict watcher in `lifecycle/`; resolution is detected only via the resolution monitor's slow-path polling.
