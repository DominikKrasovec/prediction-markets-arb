# ingestion/src/scrapers/polymarket/

Polymarket REST scraper. Uses the public Gamma API (no auth) to fetch events with their embedded markets.

## Files

| File | Role |
|------|------|
| `index.ts` | Barrel — re-exports `apiClient`, `dbService`, and the scraper functions plus the `scraper` object. |
| `types.ts` | TypeScript types for Gamma responses (`PolymarketEvent`, `PolymarketMarket`). |
| `api-client.ts` | `fetchEvents()` (keyset/cursor pagination via `after_cursor`, 100/page cap), `fetchActiveMarkets()`, `fetchAllMarkets()`, `fetchMarketByConditionId()`, `fetchEventById()`, `searchMarkets()`, `getMarketStats()` against `https://gamma-api.polymarket.com`. Markets arrive **embedded** in each event (`event.markets`) — there is no per-event market fetch. |
| `scraper.ts` | Exports `scraper: Scraper` (`{ platform, db, scrapeActive, fullScrape }`) plus helpers. `scrapeActive()` fetches `closed=false` events; `scrapeResolved()` fetches `closed=true`; `scrapeAll()` fetches all; each persists the events and their embedded markets. |
| `postgres.ts` | `dbService` — extends `BaseScraperPostgresService`; upserts into `polymarket_markets` / `polymarket_events` (`ON CONFLICT (condition_id) DO UPDATE`). |

## Key behaviours
- Polymarket uses `condition_id` (hex string) as the primary market identifier.
- One `PolymarketEvent` embeds multiple `PolymarketMarket` objects — the scraper persists both from the single `fetchEvents` pass.
- Raw Gamma fields preserved in `rawData`; `outcomes` / `outcomePrices` / `clobTokenIds` are JSON-parsed.
- `scrapeActive` is the entry point used by `run-all.ts`.

## Caveats
- No auth; Gamma may enforce per-IP rate limits at high volumes (`withRetry` handles 429s).
- The offset-based `/events` endpoint is deprecated (Apr 2026) — the client uses `/events/keyset`, which silently caps pages at 100 items regardless of the requested `limit`, and does **not** support an `active` filter (use `closed=false` and filter client-side).
