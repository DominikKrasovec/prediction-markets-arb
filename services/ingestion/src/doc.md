# ingestion/src/

Root source of the ingestion service. Two main subsystems — scrapers (REST batch) and lifecycle watchers (WSS near-real-time) — plus a resolution monitor as slow-path fallback.

## Files

| File | Role |
|------|------|
| `index.ts` | **Entry.** Runs the initial scrape, schedules periodic scrapes via `setInterval`, starts the tail-scheduled resolution monitor, and connects the three WSS lifecycle watchers (Kalshi / Polymarket / Limitless). Publishes `markets:synced` after each scrape cycle. |
| `config.ts` | `scrapeIntervalMs` (default 1 h from `SCRAPE_INTERVAL_MS` env). |
| `resolution-monitor.ts` | `runResolutionMonitor()` — polls each platform's REST API for recently-settled markets and calls `writeAndPublishResolution` for any new settlements. Runs as a single tail-scheduled loop (`RESOLUTION_POLL_INTERVAL_MS`, default 5 min). |

## Subsystems

| Folder | Purpose |
|--------|---------|
| [`scrapers/`](scrapers/doc.md) | REST batch scrapers — one subfolder per platform |
| [`lifecycle/`](lifecycle/doc.md) | WSS lifecycle watchers — near-real-time new-market + resolution events |

## Caveats
- `index.ts` **does** start the WSS lifecycle watchers (Kalshi/Polymarket/Limitless). Only the CLOB **orderbook price** streams live in `arb-solver` — the lifecycle watchers (new-market + market-resolved push events) are owned by this service, as the `index.ts` comment states.
- Resolution monitor, scrapers, and lifecycle watchers all call `writeAndPublishResolution` from `@arb/resolution-write` — the shared package is the single source of truth for resolution writes (idempotent, row-locked, 4-way outcome enum).
- `src/scripts/smoke-pmxt-compare.ts` is a standalone smoke script (Polymarket REST vs WS size comparison), not part of the service runtime.
