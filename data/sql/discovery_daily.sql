-- Daily new-market discovery counts per platform.
-- Uses platform_created_at (real API timestamp) with synced_at fallback.
-- Source: services/pipeline/src/db/queries/market-stats.ts :: getDiscoveryDaily
--
-- Parameterise by replacing :limit_days with e.g. 90 or remove the WHERE clause for all history.
SELECT
  DATE_TRUNC('day', COALESCE(platform_created_at, synced_at) AT TIME ZONE 'UTC') AS day,
  platform,
  COUNT(*)::INT                                           AS discovered,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::INT    AS already_resolved,
  COUNT(*) FILTER (WHERE resolved_at IS NULL)::INT        AS still_open
FROM markets
WHERE COALESCE(platform_created_at, synced_at) IS NOT NULL
  -- AND COALESCE(platform_created_at, synced_at) >= NOW() - INTERVAL ':limit_days days'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
