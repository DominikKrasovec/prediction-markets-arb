-- Pipeline data-integrity health-checks.
-- All queries return a single (check_name, violations) row each. A clean
-- run is N rows with violations=0. Non-zero values name the invariant
-- that's drifted — see comments inline for what each guards.
--
-- Used by services/pipeline/src/db/health-checks.ts at daemon start.
-- Safe to run any time; reads only.

SELECT 'H1_kalshi_prefix_lock_step' AS check_name, COUNT(*) AS violations
-- H1: every Kalshi market whose event_ticker matches the bundle regex
-- (MENTION/SAY/KXMVE*) must have 'kalshi:bundle:' prefix, not 'kalshi:event:'.
-- Catches drift between computePlatformGroup() (Node) and the SQL CASE in
-- getUnfeaturizedMarketsWithGroups (the bug we hit yesterday).
FROM markets m
JOIN market_features mf ON mf.market_id = m.id
JOIN market_metadata_raw mr ON mr.market_id = m.id
WHERE m.platform = 'kalshi'
  AND mf.platform_group_id LIKE 'kalshi:event:%'
  AND (mr.raw->>'event_ticker') ~ '(?i)MENTION|SAY|KXMVE'

UNION ALL

SELECT 'H2_markets_vs_platform_events', COUNT(*)
-- H2: every Kalshi market's grouping_type must equal the platform_events
-- row for its event. classifyKalshiEvents back-propagates after each sync;
-- drift means a sync ran without the post-sync classifier, or platform_events
-- was edited out-of-band.
FROM markets m
JOIN platform_events pe
  ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
WHERE m.platform = 'kalshi'
  AND m.grouping_type IS DISTINCT FROM pe.grouping_type

UNION ALL

SELECT 'H3_grouping_type_vs_prefix', COUNT(*)
-- H3: grouping_type='bundle_nonexclusive' must align with the 'kalshi:bundle:'
-- prefix and vice versa (excluding rows with non-kalshi prefixes).
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
-- H4: known_entities.domain_category must be one of the six values the
-- CHECK constraint expects (sports/crypto/finance/politics/entertainment/other).
-- Catches seeds and TS code emitting drifted values like 'legal','technology','economics'.
FROM known_entities
WHERE domain_category NOT IN
  ('sports','crypto','finance','politics','entertainment','other')

UNION ALL

SELECT 'H5_degenerate_empty_keys', COUNT(*)
-- H5: a market_features row whose platform_group_id is the prefix-only string
-- means the source field was an empty string and the empty-string guard was
-- missing somewhere. Catches future regressions of Findings 3/4/5.
FROM market_features
WHERE platform_group_id IN (
  'kalshi:event:', 'kalshi:bundle:',
  'polymarket:event:', 'polymarket:negRisk:',
  'predict:category:'
)

UNION ALL

SELECT 'H6_dangling_sport_canonical', COUNT(*)
-- H6: every level-2 entity referencing a sport_canonical string must point
-- at an existing level-1 'sport' entity. Case-insensitive join (KB convention).
FROM known_entities k
WHERE k.sport_canonical IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM known_entities s
    WHERE s.type = 'sport' AND LOWER(s.canonical) = LOWER(k.sport_canonical)
  )

UNION ALL

SELECT 'H7_dangling_league_canonical', COUNT(*)
-- H7: every league_canonical references the "above-team-below-sport" layer.
-- league / competition / organization are equivalent at that level — pick
-- whichever the LLM happened to assign.
FROM known_entities k
WHERE k.league_canonical IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM known_entities l
    WHERE l.type IN ('league','competition','organization')
      AND LOWER(l.canonical) = LOWER(k.league_canonical)
  )

UNION ALL

SELECT 'H8_entity_type_out_of_set', COUNT(*)
-- H8: every known_entities.type must be one of ENTITY_TYPES (@arb/types).
FROM known_entities
WHERE type NOT IN (
  'person','organization','team','asset','location','event_name',
  'league','sport','competition','data_provider','unknown'
)

UNION ALL

SELECT 'H9_sports_team_missing_sport', COUNT(*)
-- H9: a sports-domain team / person should have sport_canonical resolved
-- by the enrichment worker. Misses indicate a worker stall or a market the
-- LLM couldn't classify confidently.
FROM known_entities
WHERE domain_category = 'sports'
  AND type IN ('team','person')
  AND sport_canonical IS NULL

UNION ALL

SELECT 'H10_fk_target_type_mismatch', COUNT(*)
-- H10: typed FKs must target hierarchically-compatible types. league_id /
-- competition_id accept league|competition|organization (same level for arb
-- purposes). resolution_provider_id stays strict to data_provider.
FROM llm_market_normalizations n
JOIN known_entities k ON
  (n.league_id = k.id AND k.type NOT IN ('league','competition','organization')) OR
  (n.competition_id = k.id AND k.type NOT IN ('competition','event_name','league')) OR
  (n.resolution_provider_id = k.id AND k.type <> 'data_provider')

ORDER BY check_name;
