# ingestion/src/scrapers/kalshi/

Kalshi REST scraper. Crawls the global market/event feed; public endpoints need no auth, and authenticated endpoints sign requests with RSA-PSS headers via `@arb/kalshi-auth`.

## Files

| File | Role |
|------|------|
| `index.ts` | Barrel — re-exports the types, the api-client, `dbService`, and the scraper functions (`scrapeActive`, `scrapeResolved`, `fullScrape`, `scrapeOpenDiscovery`) plus the `scraper` object. |
| `types.ts` | TypeScript types for raw Kalshi REST responses (`KalshiMarket`, `KalshiEvent`) and the `fetch*Options` shapes. |
| `api-client.ts` | `fetchEvents()`, `fetchMarkets()` (both cursor-paginated), `fetchOrderbook(ticker)`, `fetchEventByTicker(ticker)` against `https://api.elections.kalshi.com/trade-api/v2`. Auth headers are injected by an axios interceptor (via `@arb/kalshi-auth`) only when credentials are present. Module-level rate limiter shared by all Kalshi requests in the process. |
| `scraper.ts` | Exports `scraper: Scraper` (`{ platform, db, scrapeActive, fullScrape }`) plus standalone helpers. `scrapeActive()` runs a single global `status=open` crawl of events + markets in parallel and saves only markets with trading activity; `scrapeResolved()` crawls `status=settled`; `scrapeAll()` crawls all statuses; `scrapeOpenDiscovery()` is an open-only refresh. |
| `postgres.ts` | `dbService` — extends `BaseScraperPostgresService` (the shared connect/disconnect base). `saveMarkets()` / `saveEvents()` upsert into `kalshi_markets` / `kalshi_events`. |
| `_contract.test.ts` | Contract tests for API response parsing + the `Scraper` shape. |

## Key behaviours
- Auth is handled by `@arb/kalshi-auth`, read from `KALSHI_KEY_ID` + `KALSHI_KEY_PEM` (or `KALSHI_KEY_PATH`). There is **no local `auth.ts`**.
- Pagination via the `cursor` query param returned by each page.
- "Markets with activity" is computed inline — a market is saved if any of `yes_bid_dollars`, `yes_ask_dollars`, `volume_fp`, or `open_interest_fp` is non-zero — to avoid ingesting Kalshi's thousands of phantom price-level markets. There is no `has_activity` API flag.
- `scrapeActive` fetches events **and** markets in parallel so `kalshi_events` (title/category/series) stays in sync for downstream normalization.

## Caveats
- Auth keys are read **lazily at signing time**, not at module init — a process that never signs (public endpoints only) loads fine without keys. Missing keys only throw when an authenticated request is actually attempted.
- Rate limits: the shared `createRateLimiter` + `withRetry` (from `http-utils.ts`) handle 429s with backoff; the limiter is module-level so the scraper and resolution monitor share one budget.
