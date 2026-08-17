# ingestion/src/scrapers/limitless/

Limitless Exchange REST scraper. Crawls the **active** markets feed (the API exposes no resolved-markets endpoint). API key is optional (`LIMITLESS_API_KEY` → `X-API-Key` header when set).

## Files

| File | Role |
|------|------|
| `scraper.ts` | Exports `scraper: Scraper` (`{ platform, db, scrapeActive, fullScrape }`). `scrapeActive()` fetches active **CLOB-only** markets; `scrapeAllMarkets()` fetches all market types (clob + amm + group); `fullScrape()` runs the all-types crawl. |
| `api-client.ts` | `fetchActiveMarkets(opts)` (page-based pagination, page size 25, ≥300 ms between requests), `fetchActiveSlugs()`, `fetchMarketBySlug(slug)`, `searchMarkets(query)` against `https://api.limitless.exchange`. |
| `postgres.ts` | `dbService` — extends `BaseScraperPostgresService`; upserts into `limitless_markets` (`ON CONFLICT (market_id) DO UPDATE`). |
| `types.ts` | TypeScript types + `normalizeMarket` (ensures `positionIds` populated). |

## Key behaviours
- Only active markets are fetched — there is **no** resolved/historical endpoint; resolution is detected via the WSS lifecycle watcher + resolution monitor.
- `scrapeActive` filters to `tradeType === 'clob'` client-side; `scrapeAllMarkets` keeps every type.
- Page-based crawl (`page`/`limit=25`), throttled to ≥300 ms between requests (2 concurrent max per Limitless limits).

## Caveats
- The per-cycle crawl re-fetches the full active list (no `since`/delta endpoint); the upsert is safe but generates DB load each cycle.
- The Limitless Socket.IO lifecycle watcher (`lifecycle/limitless-lifecycle.ts`) complements this scraper for near-real-time create/resolve events.
