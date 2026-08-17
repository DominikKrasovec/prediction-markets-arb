-- Historical platform market snapshot time-series.
-- Rows written by live-monitor (captureMarketSnapshot) roughly every hour.
-- Source: services/pipeline/src/db/queries/market-stats.ts :: getSnapshots
SELECT
  captured_at,
  platform,
  total_count,
  open_count,
  resolved_count,
  winner_fill_rate
FROM platform_market_snapshots
ORDER BY captured_at DESC, platform;
