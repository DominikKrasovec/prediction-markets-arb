/**
 * Data-integrity health checks the pipeline daemon runs at startup
 * (and optionally on each tick). Reads only — never writes.
 *
 * Each check has a fixed `check_name` and returns the count of rows that
 * violate the invariant. A clean run is 0 violations across the board;
 * a non-zero count is a warning, not a failure (the daemon keeps running).
 *
 * Add new checks by extending the UNION ALL — keep them cheap (indexed
 * lookups or single-table aggregates), reads-only, idempotent.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('health-checks');

interface HealthCheckRow {
  check_name: string;
  violations: number;
}

const HEALTH_CHECK_SQL = `
SELECT 'H1_kalshi_prefix_lock_step' AS check_name, COUNT(*) AS violations
FROM markets m
JOIN market_features mf ON mf.market_id = m.id
JOIN market_metadata_raw mr ON mr.market_id = m.id
WHERE m.platform = 'kalshi'
  AND mf.platform_group_id LIKE 'kalshi:event:%'
  AND (mr.raw->>'event_ticker') ~ '(?i)MENTION|SAY|KXMVE'

UNION ALL

SELECT 'H2_markets_vs_platform_events', COUNT(*)
FROM markets m
JOIN platform_events pe
  ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
WHERE m.platform = 'kalshi'
  AND m.grouping_type IS DISTINCT FROM pe.grouping_type

UNION ALL

SELECT 'H3_grouping_type_vs_prefix', COUNT(*)
FROM markets m
JOIN market_features mf ON mf.market_id = m.id
WHERE m.platform = 'kalshi'
  AND mf.platform_group_id LIKE 'kalshi:%'
  AND (
    (m.grouping_type = 'bundle_nonexclusive'
       AND mf.platform_group_id NOT LIKE 'kalshi:bundle:%')
    OR (m.grouping_type <> 'bundle_nonexclusive'
       AND mf.platform_group_id LIKE 'kalshi:bundle:%')
  )

UNION ALL

SELECT 'H4_domain_category_out_of_set', COUNT(*)
FROM known_entities
WHERE domain_category NOT IN
  ('sports','crypto','finance','politics','entertainment','other')

UNION ALL

SELECT 'H5_degenerate_empty_keys', COUNT(*)
FROM market_features
WHERE platform_group_id IN (
  'kalshi:event:', 'kalshi:bundle:',
  'polymarket:event:', 'polymarket:negRisk:',
  'predict:category:'
)

UNION ALL

SELECT 'H6_dangling_sport_canonical', COUNT(*)
-- H6: every level-2 entity (team / person / asset / …) whose metadata
-- carries a sport_canonical string must point at a level-1 'sport' entity
-- that actually exists. Case-insensitive join — KB canonicals are stored
-- lowercase by convention but legacy data may have mixed case.
FROM known_entities k
WHERE k.sport_canonical IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM known_entities s
    WHERE s.type = 'sport' AND LOWER(s.canonical) = LOWER(k.sport_canonical)
  )

UNION ALL

SELECT 'H7_dangling_league_canonical', COUNT(*)
-- H7: every league_canonical references the "above-team-below-sport" layer.
-- The exact entity type doesn't matter for arbitrage purposes — league /
-- competition / organization all live at the same hierarchical level
-- (FIFA World Cup is a competition, NCAA is an organization, Premier League
-- is a league — references to any of them via league_canonical are valid).
FROM known_entities k
WHERE k.league_canonical IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM known_entities l
    WHERE l.type IN ('league', 'competition', 'organization')
      AND LOWER(l.canonical) = LOWER(k.league_canonical)
  )

UNION ALL

SELECT 'H8_entity_type_out_of_set', COUNT(*)
-- H8: every known_entities.type must be one of the values in @arb/types
-- ENTITY_TYPES. Drift here means a code path bypassed parseEntityType().
FROM known_entities
WHERE type NOT IN (
  'person','organization','team','asset','location','event_name','party',
  'league','sport','competition','data_provider','unknown'
)

UNION ALL

SELECT 'H9_sports_team_missing_sport', COUNT(*)
-- H9: a sports-domain team should have sport_canonical resolved. Enrichment
-- worker is supposed to fill this; misses indicate the LLM context wasn't
-- enough or the worker failed to write back.
FROM known_entities
WHERE domain_category = 'sports'
  AND type IN ('team','person')
  AND sport_canonical IS NULL

UNION ALL

SELECT 'H10_fk_target_type_mismatch', COUNT(*)
-- H10: typed FKs from llm_market_normalizations must point at hierarchically-
-- compatible entity types. league_id and competition_id allow the broader
-- "above-team-below-sport" set (league / competition / organization) because
-- the LLM consistently disagrees with itself on which label applies and the
-- arb logic doesn't care. resolution_provider_id stays strict to
-- 'data_provider' since that role is semantically distinct.
FROM llm_market_normalizations n
JOIN known_entities k ON
  (n.league_id = k.id AND k.type NOT IN ('league','competition','organization')) OR
  (n.competition_id = k.id AND k.type NOT IN ('competition','event_name','league')) OR
  (n.resolution_provider_id = k.id AND k.type <> 'data_provider')

UNION ALL

SELECT 'H11_histogram_drift', COUNT(*)
-- H11: entity_category_counts must match market_entity_links per-entity. A
-- non-zero count means the incremental UPSERT in registerEntities or the
-- merge rewrite in merge.ts diverged from the link table — either a hook is
-- missing, the histogram write failed silently, or an out-of-band write
-- touched market_entity_links without bumping the counts.
FROM (
  SELECT mel.entity_id, COUNT(*) AS link_n
  FROM market_entity_links mel
  JOIN markets m ON m.id = mel.market_id
  WHERE m.category_unified IS NOT NULL
  GROUP BY mel.entity_id
) links
LEFT JOIN (
  SELECT entity_id, SUM(n) AS hist_n FROM entity_category_counts GROUP BY entity_id
) hist ON hist.entity_id = links.entity_id
WHERE COALESCE(hist.hist_n, 0) <> links.link_n

UNION ALL

SELECT 'H12_histogram_over_merged', COUNT(*)
-- H12: surface the "suspicious over-merged entities" panel inline. Entities
-- with ≥3 distinct categories AND no dominant category
-- (dominant_share < 0.6) likely collapsed two real-world entities (e.g.
-- "Trump" political vs DJT stock). Non-zero is informational, not a bug —
-- review the entity_category_summary view and manually split if needed.
FROM entity_category_summary
WHERE distinct_categories >= 3 AND dominant_share < 0.6

ORDER BY check_name
`;

/**
 * Run all health checks. Returns the result rows AND logs a one-line summary
 * per check at warn level when violations > 0, info otherwise. The caller
 * decides whether to act on the results (the default integration is "log
 * and continue").
 */
export async function runHealthChecks(): Promise<HealthCheckRow[]> {
  const rows = await query<{ check_name: string; violations: string }>(HEALTH_CHECK_SQL);
  const out: HealthCheckRow[] = rows.map((r) => ({
    check_name: r.check_name,
    violations: Number(r.violations),
  }));
  let total = 0;
  for (const r of out) {
    total += r.violations;
    if (r.violations > 0) {
      log.warn(`${r.check_name}: ${r.violations} violations`);
    } else {
      log.info(`${r.check_name}: clean`);
    }
  }
  if (total === 0) {
    log.info('All health checks clean');
  } else {
    log.warn(`Health checks reported ${total} total violations across ${out.filter((r) => r.violations > 0).length} checks`);
  }
  return out;
}
