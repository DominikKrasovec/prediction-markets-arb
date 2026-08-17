-- Daily market-resolution counts per platform.
-- Source: services/pipeline/src/db/queries/market-stats.ts :: getResolutionDaily
--
-- Parameterise by replacing :limit_days or removing the extra AND clause.
SELECT
  DATE_TRUNC('day', resolved_at AT TIME ZONE 'UTC') AS day,
  platform,
  COUNT(*)::INT                                                             AS resolved,
  COUNT(*) FILTER (WHERE winning_outcome IS NOT NULL)::INT                  AS with_winner,
  COUNT(*) FILTER (WHERE winning_outcome IS NULL)::INT                      AS without_winner,
  COUNT(*) FILTER (WHERE resolution_source LIKE '%/poll')::INT              AS via_poll,
  COUNT(*) FILTER (WHERE resolution_source LIKE '%/gap%')::INT              AS via_gap_refill,
  COUNT(*) FILTER (WHERE resolution_source LIKE '%wss%'
                     OR  resolution_source LIKE '%/lifecycle%')::INT        AS via_wss
FROM markets
WHERE resolved_at IS NOT NULL
  -- AND resolved_at >= NOW() - INTERVAL ':limit_days days'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
