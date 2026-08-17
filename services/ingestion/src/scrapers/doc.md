# ingestion/src/scrapers/

REST-based batch scrapers. One subfolder per platform; each exposes a `scraper` object implementing the shared `Scraper` interface and writes raw markets/events to platform-specific Postgres tables.

## Files at this level

| File | Role |
|------|------|
| `base.ts` | `Scraper` interface: `{ platform, db, scrapeActive(), fullScrape() }`. `ScraperDb` interface: `{ connect(), disconnect() }`. (Platform-specific entry points like `scrapeResolved`/`enrichMarketStats` stay as named module exports — the interface is intentionally minimal so the dispatcher only needs `db.connect()` + `scrapeActive()`.) |
| `base-postgres.ts` | `BaseScraperPostgresService` — shared `connect()` / `disconnect()` / `isAvailable()` / `requirePool()` boilerplate; every platform's `postgres.ts` extends it. |
| `http-utils.ts` | Shared HTTP helpers: `withRetry()` (exponential backoff, 429 handling) and `createRateLimiter()`. |
| `run-all.ts` | `runAllScrapers()` — connects + dispatches every registered `scraper`; logs per-platform stats on completion. |
| `_contract.test.ts` | Contract tests asserting each platform's `scraper` satisfies the `Scraper` shape. |

## Platform subfolders

| Folder | Platform | Auth | API base |
|--------|----------|------|----------|
| [`kalshi/`](kalshi/doc.md) | Kalshi | RSA-PSS headers (`@arb/kalshi-auth`) for authed endpoints; public reads need none | `api.elections.kalshi.com/trade-api/v2` |
| [`polymarket/`](polymarket/doc.md) | Polymarket | None (public Gamma API) | `gamma-api.polymarket.com` |
| [`predict/`](predict/doc.md) | Predict | **Required** — `PREDICT_API_KEY` (`x-api-key`) | `api.predict.fun` |
| [`limitless/`](limitless/doc.md) | Limitless | Optional — `LIMITLESS_API_KEY` (`X-API-Key`) | `api.limitless.exchange` |

## Common patterns across all scrapers
- Each module exports a `scraper: Scraper` object (`scrapeActive` + `fullScrape`) plus extra named helpers (`scrapeResolved`, `scrapeAll`, etc.).
- Pagination is per-platform: Kalshi/Polymarket are cursor-based; Predict uses an `after` cursor; Limitless is page-based (size 25).
- DB modules (`postgres.ts`) extend `BaseScraperPostgresService` and use upsert-on-conflict — reruns are safe.

## Caveats
- `BaseScraperPostgresService` (`base-postgres.ts`) already consolidates the connect/disconnect boilerplate that used to be duplicated across the four `postgres.ts` files; only the platform-specific `saveX()` methods remain per-scraper.
- `run-all.ts` dispatches scrapers and isolates failures per-scraper so one platform erroring does not abort the others.
