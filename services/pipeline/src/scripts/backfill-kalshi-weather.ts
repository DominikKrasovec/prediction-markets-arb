/**
 * One-off backfill: normalize Kalshi markets via the deterministic handler
 * (kalshi-deterministic.ts KNOWN_SERIES_MAP entries) for a single category.
 *
 * Why a script and not just a Stage 1 re-run:
 *   - The pipeline strategy intentionally defers LLM normalization, so we
 *     don't drain the full stage1_queue. But markets that now have a
 *     deterministic handler match (new KNOWN_SERIES_MAP additions) SHOULD be
 *     processed — that IS the regex-first principle.
 *   - This script scopes processing to one `category_unified` value so it
 *     doesn't touch LLM-pending markets in other categories.
 *
 * Usage:
 *   npx tsx services/pipeline/src/scripts/backfill-kalshi-weather.ts
 *   BACKFILL_CATEGORY=economic npx tsx services/pipeline/src/scripts/backfill-kalshi-weather.ts
 *   BACKFILL_CATEGORY=election npx tsx services/pipeline/src/scripts/backfill-kalshi-weather.ts
 *
 * Despite the file name, the script handles any single `category_unified`
 * value via the BACKFILL_CATEGORY env var (legacy bare CATEGORY still honored).
 * Default is 'weather' for backward compat.
 *
 * Side effects:
 *   - INSERT into llm_market_normalizations for matched markets
 *   - INSERT into known_entities for each unique entity via registerEntities()
 *   - INSERT into entity_enrichment_queue for new entities
 */
import { query, endPool } from '@arb/db';
import { tryNormalizeKalshiRow } from '../stage1-normalize/kalshi-deterministic.js';
import { bulkUpsertNormalizations } from '../db/queries/normalizations.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import type { KalshiCandidateRow } from '../stage1-normalize/kalshi-deterministic.js';
import { createLogger } from '@arb/logger';
import { readEnv } from '@arb/types';

const log = createLogger('backfill-kalshi-weather');

// Scoped env names: the bare BATCH_SIZE/CONCURRENCY/CATEGORY are collision-prone
// across reusable scripts. Legacy bare names still honored via alias fallback.
const BATCH_SIZE = parseInt(readEnv('BACKFILL_BATCH_SIZE', { alias: 'BATCH_SIZE' }) ?? '200');
const CONCURRENCY = parseInt(readEnv('BACKFILL_CONCURRENCY', { alias: 'CONCURRENCY' }) ?? '8');
const CATEGORY = readEnv('BACKFILL_CATEGORY', { alias: 'CATEGORY' }) ?? 'weather';

interface RawRow extends KalshiCandidateRow {
  // KalshiCandidateRow already covers everything tryNormalizeKalshiRow reads.
  // Optional fields not used by the weather path (mve_*, subtitle, etc.) get
  // NULL via the SELECT projection.
}

async function fetchBatch(afterId: number, limit: number): Promise<RawRow[]> {
  return await query<RawRow>(`
    SELECT m.id AS market_id,
           m.platform_id,
           m.title,
           to_char(m.end_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_date,
           m.category_unified,
           mr.raw->>'strike_type'                AS strike_type,
           mr.raw->>'floor_strike'               AS floor_strike,
           mr.raw->>'cap_strike'                 AS cap_strike,
           mr.raw->>'event_ticker'               AS event_ticker,
           ke.raw->>'title'                      AS event_title,
           mr.raw->>'strike_date'                AS strike_date,
           mr.raw->>'rules_primary'              AS rules_primary,
           mr.raw->>'yes_sub_title'              AS yes_sub_title,
           mr.raw->>'subtitle'                   AS subtitle,
           mr.raw->>'occurrence_datetime'        AS occurrence_datetime,
           mr.raw->'mve_selected_legs'           AS mve_selected_legs,
           mr.raw->>'mve_collection_ticker'      AS mve_collection_ticker,
           ke.raw->'product_metadata'->>'competition' AS kalshi_competition
    FROM markets m
    JOIN market_metadata_raw mr ON mr.market_id = m.id
    LEFT JOIN kalshi_events ke ON ke.event_ticker = mr.raw->>'event_ticker'
    WHERE m.platform = 'kalshi'
      AND m.category_unified = $3
      AND m.id > $1
      AND NOT EXISTS (
        SELECT 1 FROM llm_market_normalizations n
        WHERE n.market_id = m.id AND n.condition_shape IS NOT NULL
      )
    ORDER BY m.id
    LIMIT $2`, [afterId, limit, CATEGORY]);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let written = 0;
  let attempted = 0;
  let skipped = 0;
  let afterId = 0;
  const perSeries = new Map<string, number>();

  // Get total count first for progress reporting
  const totalRows = await query<{ n: number }>(`
    SELECT COUNT(*)::int AS n FROM markets m
    WHERE m.platform='kalshi' AND m.category_unified=$1
      AND NOT EXISTS (SELECT 1 FROM llm_market_normalizations n
                      WHERE n.market_id=m.id AND n.condition_shape IS NOT NULL)`,
    [CATEGORY]);
  const total = totalRows[0]?.n ?? 0;
  log.info(`Found ${total} unnormalized Kalshi ${CATEGORY} markets`);

  while (true) {
    const rows = await fetchBatch(afterId, BATCH_SIZE);
    if (rows.length === 0) break;
    afterId = Math.max(...rows.map(r => r.market_id));
    attempted += rows.length;

    const hits = await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      try {
        const hit = await tryNormalizeKalshiRow(row);
        return hit;
      } catch (err) {
        log.warn(`Market ${row.market_id} (${row.platform_id}) failed: ${(err as Error).message}`);
        return null;
      }
    });

    const matched = hits.filter((h): h is NonNullable<typeof h> => h !== null);
    skipped += rows.length - matched.length;

    if (matched.length > 0) {
      await bulkUpsertNormalizations(matched.map(h => h.norm));
      for (const h of matched) {
        written++;
        perSeries.set(h.tag, (perSeries.get(h.tag) ?? 0) + 1);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(
      `\r[backfill] attempted=${attempted}/${total} written=${written} skipped=${skipped} elapsed=${elapsed}s  `,
    );
  }
  process.stdout.write('\n');

  log.info(`Done. Written=${written}, skipped=${skipped}, total attempted=${attempted}`);
  for (const [tag, n] of [...perSeries.entries()].sort((a, b) => b[1] - a[1])) {
    log.info(`  ${tag}: ${n}`);
  }
  await endPool();
}

main().catch((err) => {
  log.error(`Backfill failed: ${(err as Error).message}`);
  process.exit(1);
});
