-- Current totals per platform: open / resolved / winner-fill-rate
-- Source: services/pipeline/src/db/queries/market-stats.ts :: captureMarketSnapshot
SELECT
  platform,
  COUNT(*)::INT                                           AS total_count,
  COUNT(*) FILTER (WHERE resolved_at IS NULL)::INT        AS open_count,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::INT    AS resolved_count,
  ROUND(
    COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND winning_outcome IS NOT NULL)::NUMERIC
    / NULLIF(COUNT(*) FILTER (WHERE resolved_at IS NOT NULL), 0),
    4
  )                                                       AS winner_fill_rate
FROM markets
WHERE platform IN ('kalshi','polymarket','limitless','predict')
GROUP BY platform
ORDER BY platform;
