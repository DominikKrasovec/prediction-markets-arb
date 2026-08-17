/**
 * Scoped backfill: re-run text-deterministic templates over markets whose
 * titles match a SQL `ILIKE` pattern. Applies a newly-added template to
 * existing markets without draining the full LLM queue or processing
 * untouched categories.
 *
 * Usage:
 *   BACKFILL_PATTERN='%FDV above%one day after launch%' \
 *   PG_HOST=... npx tsx services/pipeline/src/scripts/backfill-text-det-scoped.ts
 *
 * The script pulls candidates whose title matches PATTERN and have no
 * existing lmn.condition_shape, then calls tryNormalizeText() — exactly
 * what the live Stage 1 worker does, just scoped.
 */
import { query, endPool } from '@arb/db';
import { tryNormalizeText } from '../stage1-normalize/text-deterministic.js';
import { bulkUpsertNormalizations } from '../db/queries/normalizations.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { createLogger } from '@arb/logger';
import { readEnv } from '@arb/types';

const log = createLogger('backfill-text-det-scoped');
// Scoped env names; legacy bare names honored via alias.
const BATCH_SIZE = parseInt(readEnv('BACKFILL_BATCH_SIZE', { alias: 'BATCH_SIZE' }) ?? '200');
const CONCURRENCY = parseInt(readEnv('BACKFILL_CONCURRENCY', { alias: 'CONCURRENCY' }) ?? '8');
const PATTERN = readEnv('BACKFILL_PATTERN', { alias: 'PATTERN' });

if (!PATTERN) {
  log.error('BACKFILL_PATTERN env var required — e.g. BACKFILL_PATTERN="%FDV above%"');
  process.exit(1);
}

async function fetchBatch(afterId: number, limit: number) {
  return await query<any>(`
    SELECT m.id AS market_id, m.platform_id, m.platform, m.title, m.description,
           to_char(m.end_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_date,
           m.category_unified,
           mf.hierarchy_type, mf.hierarchy_value, mf.hierarchy_level,
           mf.condition_shape AS feat_condition_shape,
           mf.condition_direction AS feat_condition_direction,
           mf.temporal_semantics AS feat_temporal,
           mf.numbers::text AS numbers,
           m.platform_event_id,
           (SELECT sib.title FROM markets sib WHERE sib.platform_event_id = m.platform_event_id
              AND sib.platform = m.platform AND sib.id != m.id
              AND sib.title ~* ' vs\.? ' ORDER BY length(sib.title) DESC LIMIT 1) AS event_match_context,
           mr.raw->>'strike_type' AS strike_type,
           mr.raw->>'floor_strike' AS floor_strike,
           mr.raw->>'cap_strike' AS cap_strike,
           mr.raw->>'event_ticker' AS event_ticker,
           ke.raw->>'title' AS event_title,
           mr.raw->>'strike_date' AS strike_date,
           mr.raw->>'rules_primary' AS rules_primary,
           CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'yes_sub_title' END AS yes_sub_title,
           CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'subtitle' END AS subtitle,
           CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'occurrence_datetime' END AS occurrence_datetime,
           CASE WHEN m.platform = 'kalshi' THEN mr.raw->'mve_selected_legs' END AS mve_selected_legs,
           CASE WHEN m.platform = 'kalshi' THEN mr.raw->>'mve_collection_ticker' END AS mve_collection_ticker,
           CASE WHEN m.platform = 'kalshi' THEN ke.raw->'product_metadata'->>'competition' END AS kalshi_competition,
           m.slug AS slug,
           CASE WHEN m.platform <> 'kalshi' THEN pe.title END AS non_kalshi_event_title,
           CASE
             WHEN jsonb_typeof(mr.raw->'outcomes') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(mr.raw->'outcomes'))
             WHEN jsonb_typeof(m.outcomes) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(m.outcomes))
             ELSE NULL END AS outcomes_raw,
           CAST(NULL AS TEXT) AS sport_canonical,
           m.tags AS tags,
           m.category AS market_category,
           CASE WHEN m.platform = 'polymarket' THEN (
             SELECT ARRAY(SELECT (t->>'label') FROM polymarket_events pe2
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pe2.raw->'tags', '[]'::jsonb)) t
               WHERE pe2.id = m.platform_event_id AND t->>'label' IS NOT NULL)
           ) WHEN m.platform = 'predict' THEN (
             SELECT ARRAY(SELECT (t->>'name') FROM predict_categories pc
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pc.raw->'tags', '[]'::jsonb)) t
               WHERE pc.raw->>'slug' = m.category AND t->>'name' IS NOT NULL)
           ) ELSE NULL END AS parent_event_tags
    FROM markets m
    JOIN market_features mf ON mf.market_id = m.id
    LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
    LEFT JOIN kalshi_events ke ON ke.event_ticker = mr.raw->>'event_ticker' AND m.platform = 'kalshi'
    LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
    WHERE m.id > $1
      AND m.title ILIKE $3
      AND NOT EXISTS (SELECT 1 FROM llm_market_normalizations n WHERE n.market_id = m.id AND n.condition_shape IS NOT NULL)
    ORDER BY m.id LIMIT $2`, [afterId, limit, PATTERN]);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let written = 0, attempted = 0, afterId = 0;
  const total = (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM markets m WHERE m.title ILIKE $1
    AND NOT EXISTS (SELECT 1 FROM llm_market_normalizations n WHERE n.market_id=m.id AND n.condition_shape IS NOT NULL)`,
    [PATTERN]))[0]?.n ?? 0;
  log.info(`Found ${total} unnormalized markets matching pattern: ${PATTERN}`);

  while (true) {
    const rows = await fetchBatch(afterId, BATCH_SIZE);
    if (rows.length === 0) break;
    afterId = Math.max(...rows.map(r => r.market_id));
    attempted += rows.length;
    const hits = await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      try { return await tryNormalizeText(row); } catch (e) {
        log.warn(`Market ${row.market_id} failed: ${(e as Error).message}`);
        return null;
      }
    });
    const ok = hits.filter((h): h is NonNullable<typeof h> => h !== null);
    if (ok.length > 0) {
      await bulkUpsertNormalizations(ok.map(h => h.norm));
      written += ok.length;
    }
    process.stdout.write(`\r[scoped-backfill] attempted=${attempted}/${total} written=${written} elapsed=${((Date.now()-t0)/1000).toFixed(1)}s  `);
  }
  process.stdout.write('\n');
  log.info(`Done. Written=${written} / attempted=${attempted}`);
  await endPool();
}

main().catch(err => { log.error(`Failed: ${(err as Error).message}`); process.exit(1); });
