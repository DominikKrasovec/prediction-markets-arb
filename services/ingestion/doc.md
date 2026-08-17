# ingestion

Multi-platform market scraper + lifecycle watcher. Keeps the raw Postgres tables (`kalshi_markets`, `polymarket_markets`, etc.) synchronised with platform APIs and detects market resolutions as quickly as possible.

## Responsibilities
- Periodically scrape all active and resolved markets via REST (all 4 platforms)
- Watch for new markets and resolution events in near-real-time via WebSocket lifecycle feeds
- Backfill `platform_events` rows for newly discovered markets
- Fill gaps caused by WebSocket disconnects via REST re-crawl
- Slow-path resolution polling via `resolution-monitor` (fallback for missed WSS events)
- Publish `markets:synced` on event-bus after each scrape cycle

## Directory layout

```
ingestion/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts               Entry: initial scrape → setInterval → resolution monitor
    ├── config.ts              scrapeIntervalMs (default: 1 h from env)
    ├── resolution-monitor.ts  Slow-path: per-platform REST polling for recently settled markets
    ├── lifecycle/             WSS-based near-real-time lifecycle watchers → see lifecycle/doc.md
    └── scrapers/              REST-based batch scrapers for each platform → see scrapers/doc.md
```

## Startup sequence (index.ts)
1. `runAllScrapers()` — immediate full scrape on startup
2. `setInterval(runAllScrapers, scrapeIntervalMs)` — periodic refresh
3. `scheduleResolutionMonitor()` — tail-scheduled polling loop (default 5 min)
4. Publishes `{ channel: 'markets', type: 'synced' }` after each scrape cycle

## Caveats
- WebSocket lifecycle watchers (`lifecycle/`) were not moved to `arb-solver`; they remain here as they concern market discovery/resolution rather than price feeds.
- The resolution monitor is intentionally a _slow path_; fast-path resolution arrives via the WSS watchers.
- Limitless scraping can be slow (>5 min); that is why the resolution monitor uses a tail-scheduler instead of `setInterval`.
- Ingestion writes to both raw platform tables **and** the normalised `markets` table: resolution writes (`resolved_at`, `winning_outcome`, `resolution_source`, `status`) go via `@arb/resolution-write` from the lifecycle watchers, gap-refill, and resolution monitor.
