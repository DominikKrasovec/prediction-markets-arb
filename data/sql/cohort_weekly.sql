-- Weekly cohort stats: for markets created in week W, what fraction resolved
-- and how long did it take?
-- Source: services/pipeline/src/db/queries/market-stats.ts :: getCohortWeekly
SELECT
  DATE_TRUNC('week', COALESCE(platform_created_at, synced_at) AT TIME ZONE 'UTC') AS discovery_week,
  platform,
  COUNT(*)::INT                                           AS cohort_size,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::INT    AS resolved_count,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)
    / NULLIF(COUNT(*), 0), 1
  )::FLOAT8                                               AS pct_resolved,
  AVG(
    EXTRACT(EPOCH FROM (resolved_at - COALESCE(platform_created_at, synced_at))) / 86400.0
  ) FILTER (WHERE resolved_at IS NOT NULL)::FLOAT8        AS avg_days_to_resolve,
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (resolved_at - COALESCE(platform_created_at, synced_at))) / 86400.0
  ) FILTER (WHERE resolved_at IS NOT NULL)::FLOAT8        AS median_days_to_resolve
FROM markets
WHERE COALESCE(platform_created_at, synced_at) IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
