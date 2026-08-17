/**
 * One-off backfill: normalize Polymarket weather markets via Template P
 * (now station-aware via extractPolymarketWeatherStation).
 *
 * Scoped to `platform='polymarket' AND category_unified='weather'` so we
 * don't touch any other pending markets.
 *
 * Usage:
 *   npx tsx services/pipeline/src/scripts/backfill-polymarket-weather.ts
 */
import { query, endPool } from '@arb/db';
import { bulkUpsertNormalizations } from '../db/queries/normalizations.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { createLogger } from '@arb/logger';
import { readEnv } from '@arb/types';
import { tryNormalizeText } from '../stage1-normalize/text-deterministic.js';

const log = createLogger('backfill-polymarket-weather');

// Scoped env names; legacy bare names honored via alias.
const BATCH_SIZE = parseInt(readEnv('BACKFILL_BATCH_SIZE', { alias: 'BATCH_SIZE' }) ?? '200');
const CONCURRENCY = parseInt(readEnv('BACKFILL_CONCURRENCY', { alias: 'CONCURRENCY' }) ?? '8');

interface RawRow {
  market_id: number;
  platform: string;
  platform_id: string;
  title: string;
  description: string | null;
  end_date: string | null;
  category_unified: string | null;
  hierarchy_type: string | null;
  hierarchy_value: string | null;
  hierarchy_level: number | null;
  feat_condition_shape: string | null;
  feat_condition_direction: string | null;
  feat_temporal: string | null;
  numbers: string | null;
  platform_event_id: string | null;
  event_match_context: string | null;
  strike_type: string | null;
  floor_strike: string | null;
  cap_strike: string | null;
  event_ticker: string | null;
  event_title: string | null;
  strike_date: string | null;
  rules_primary: string | null;
  yes_sub_title: string | null;
  subtitle: string | null;
  occurrence_datetime: string | null;
  mve_selected_legs: unknown;
  mve_collection_ticker: string | null;
  kalshi_competition: string | null;
  slug: string | null;
  non_kalshi_event_title: string | null;
  outcomes_raw: string[] | null;
  sport_canonical: string | null;
  tags: string[] | null;
  market_category: string | null;
  parent_event_tags: string[] | null;
}

async function fetchBatch(afterId: number, limit: number): Promise<RawRow[]> {
  return await query<RawRow>(`
    SELECT m.id AS market_id,
           m.platform_id,
           m.platform,
           m.title,
           m.description,
           to_char(m.end_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_date,
           m.category_unified,
           mf.hierarchy_type, mf.hierarchy_value, mf.hierarchy_level,
           mf.condition_shape AS feat_condition_shape,
           mf.condition_direction AS feat_condition_direction,
           mf.temporal_semantics AS feat_temporal,
           mf.numbers::text AS numbers,
           m.platform_event_id,
           NULL::text AS event_match_context,
           NULL::text AS strike_type, NULL::text AS floor_strike, NULL::text AS cap_strike,
           NULL::text AS event_ticker, NULL::text AS event_title, NULL::text AS strike_date,
           NULL::text AS rules_primary, NULL::text AS yes_sub_title,
           NULL::text AS subtitle, NULL::text AS occurrence_datetime,
           NULL::jsonb AS mve_selected_legs, NULL::text AS mve_collection_ticker,
           NULL::text AS kalshi_competition,
           m.slug,
           pe.title AS non_kalshi_event_title,
           CASE
             WHEN jsonb_typeof(m.outcomes) = 'array'
               THEN ARRAY(SELECT jsonb_array_elements_text(m.outcomes))
             ELSE NULL
           END AS outcomes_raw,
           NULL::text AS sport_canonical,
           m.tags, m.category AS market_category,
           NULL::text[] AS parent_event_tags
    FROM markets m
    JOIN market_features mf ON mf.market_id = m.id
    LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
    WHERE m.platform = 'polymarket'
      AND m.category_unified = 'weather'
      AND m.id > $1
      AND NOT EXISTS (
        SELECT 1 FROM llm_market_normalizations n
        WHERE n.market_id = m.id AND n.condition_shape IS NOT NULL
      )
    ORDER BY m.id
    LIMIT $2`, [afterId, limit]);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let written = 0;
  let attempted = 0;
  let skipped = 0;
  let afterId = 0;

  const totalRows = await query<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM markets m
    WHERE m.platform='polymarket' AND m.category_unified='weather'
      AND NOT EXISTS (SELECT 1 FROM llm_market_normalizations n
                      WHERE n.market_id=m.id AND n.condition_shape IS NOT NULL)`);
  const total = totalRows[0]?.n ?? 0;
  log.info(`Found ${total} unnormalized Polymarket weather markets`);

  while (true) {
    const rows = await fetchBatch(afterId, BATCH_SIZE);
    if (rows.length === 0) break;
    afterId = Math.max(...rows.map(r => r.market_id));
    attempted += rows.length;

    const hits = await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      try {
        return await tryNormalizeText(row as never);
      } catch (err) {
        log.warn(`Market ${row.market_id} failed: ${(err as Error).message}`);
        return null;
      }
    });

    const matched = hits.filter((h): h is NonNullable<typeof h> => h !== null);
    skipped += rows.length - matched.length;

    if (matched.length > 0) {
      await bulkUpsertNormalizations(matched.map(h => h.norm));
      written += matched.length;
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r[backfill] attempted=${attempted}/${total} written=${written} skipped=${skipped} elapsed=${elapsed}s  `);
  }
  process.stdout.write('\n');
  log.info(`Done. Written=${written}, skipped=${skipped}, attempted=${attempted}`);
  await endPool();
}

main().catch((err) => {
  log.error(`Backfill failed: ${(err as Error).message}`);
  process.exit(1);
});
