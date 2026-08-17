/**
 * PostgreSQL persistence for Predict scraper data.
 *
 * Aligned with the kalshi/polymarket/limitless siblings: every method calls
 * `requirePool()` from `BaseScraperPostgresService` and lets errors propagate.
 * The previous "return 0/[]/default-stats on null pool" soft-fail behavior
 * was removed — it silently turned DB-misconfig faults into "scraped nothing"
 * which read as a normal idle cycle in logs. Failures now bubble to
 * `runAllScrapers`'s `Promise.allSettled` and produce a visible `Failed: …`
 * log line on the cycle they occur.
 *
 * Per-method try/catch+log+rethrow wrappers were also removed: callers in
 * `predict/scraper.ts` (`enrichMarketStats`, `displayStats`) already wrap
 * the relevant calls with their own try/catch + graceful-degradation log
 * lines, so the inner wrappers were double-logging.
 */

import { bulkUpsert } from '@arb/db';
import { BaseScraperPostgresService } from '../base-postgres.js';
import type { PredictCategory, PredictMarket, PredictMarketStats, PredictTag } from './types.js';

/**
 * Predicate selecting markets that are still current (tradeable or awaiting
 * resolution). Predict market OBJECTS never carry status='OPEN' — that value
 * exists only in the API's QUERY-PARAM enum; the market-object vocabulary is
 * REGISTERED / PRICE_PROPOSED / PRICE_DISPUTED / RESOLVED / REMOVED (+ documented
 * but unseen PAUSED / UNPAUSED). The old `status = 'OPEN'` predicate matched 0
 * rows, so `enrichMarketStats` had NEVER enriched a single market. NOT IN over
 * the terminal states equals `raw->>'tradingStatus' = 'OPEN'` on live data
 * (2,553/2,768 rows, census 2026-07-02) but uses the plain documented column and
 * fails OPEN on unknown future states. The IS NULL arm keeps rows whose payload
 * lacked a status entirely (NOT IN alone would drop them via SQL 3VL — the wrong
 * direction for a recall filter). Keep in lockstep with COLD_FILTER_MAP.predict
 * in services/pipeline/src/db/sync.ts.
 */
export const PREDICT_CURRENT_MARKET_PREDICATE = `(status IS NULL OR status NOT IN ('RESOLVED', 'REMOVED'))`;

/**
 * Enrichment keys that live ONLY in some payload shapes/passes and must survive
 * a re-save from a shape that lacks them:
 *  - category* keys are attached by fetchCategories' per-market spread
 *    (api-client.ts); the /v1/markets payload carries categorySlug but NO
 *    categoryId/categoryTitle/categoryImageUrl/categoryTags (live probe
 *    2026-07-02: 0/25,000 markets had categoryId). Without preservation, a
 *    fullScrape's later scrapeMarkets() pass clobbers every enriched raw blob.
 *  - volume/liquidity keys are merged into raw by enrichMarketStats and appear
 *    in NO scrape payload, so any later save would wipe them.
 */
const PRESERVED_RAW_KEYS = [
  'categoryId',
  'categoryTitle',
  'categoryImageUrl',
  'categoryTags',
  'volumeTotalUsd',
  'volume24hUsd',
  'totalLiquidityUsd',
  'statsUpdatedAt',
] as const;

/**
 * Non-destructive raw merge: the incoming payload wins for every key it carries;
 * PRESERVED_RAW_KEYS the incoming payload LACKS are carried over from the
 * existing stored raw. Other stale keys are NOT resurrected (if the API removes
 * a field from the payload, we drop it too). Pure — exported for unit tests.
 */
export function mergePreservedRawKeys(
  incoming: Record<string, unknown>,
  existingRaw: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!existingRaw) return incoming;
  const preserved: Record<string, unknown> = {};
  for (const k of PRESERVED_RAW_KEYS) {
    if (!(k in incoming) && k in existingRaw) preserved[k] = existingRaw[k];
  }
  if (Object.keys(preserved).length === 0) return incoming;
  return { ...preserved, ...incoming };
}

class PostgresService extends BaseScraperPostgresService {
  protected readonly label = 'predict';

  async saveCategories(categories: PredictCategory[]): Promise<number> {
    const pool = this.requirePool();
    if (!Array.isArray(categories) || categories.length === 0) return 0;

    const now = new Date();
    const columns = ['id', 'slug', 'status', 'raw', 'db_updated_at'];
    const rows = categories.map(c => [
      c.id,
      c.slug || null,
      c.status || null,
      JSON.stringify(c),
      now,
    ]);
    return bulkUpsert(pool, 'predict_categories', ['id'], columns, rows);
  }

  async saveMarkets(markets: PredictMarket[]): Promise<number> {
    const pool = this.requirePool();
    if (!Array.isArray(markets) || markets.length === 0) return 0;

    // Non-destructive save: the /v1/markets payload shape carries NO
    // categoryId/categoryTitle (categories-path enrichment) and no scrape
    // payload carries the stats-enrichment keys, so a blind
    // `raw = JSON.stringify(m)` overwrite would clobber them. Pull the
    // preserved-key subset of the existing raw for this batch and merge it
    // UNDER the incoming payload (incoming wins per key it carries).
    const ids = markets.map(m => m.id);
    const { rows: existing } = await pool.query(
      `SELECT id,
              (SELECT COALESCE(jsonb_object_agg(k, raw -> k), '{}'::jsonb)
                 FROM unnest($2::text[]) AS k
                WHERE raw ? k) AS preserved
         FROM predict_markets
        WHERE id = ANY($1::int[])`,
      [ids, [...PRESERVED_RAW_KEYS]],
    );
    const preservedById = new Map<string, Record<string, unknown>>(
      existing.map((r: { id: number | string; preserved: Record<string, unknown> }) => [String(r.id), r.preserved]),
    );

    const now = new Date();
    const columns = ['id', 'condition_id', 'category_id', 'category_slug', 'status', 'raw', 'db_updated_at'];
    const rows = markets.map(m => {
      const merged = mergePreservedRawKeys(
        m as unknown as Record<string, unknown>,
        preservedById.get(String(m.id)) ?? null,
      );
      return [
        m.id,
        m.conditionId || null,
        // categoryId may come from the incoming payload (categories path) or be
        // preserved from a prior categories pass (markets path) — never NULL-clobber.
        m.categoryId ?? (merged.categoryId as number | undefined) ?? null,
        m.categorySlug || null,
        m.status || null,
        JSON.stringify(merged),
        now,
      ];
    });
    return bulkUpsert(pool, 'predict_markets', ['id'], columns, rows);
  }

  async saveTags(tags: PredictTag[]): Promise<number> {
    const pool = this.requirePool();
    if (!Array.isArray(tags) || tags.length === 0) return 0;

    const now = new Date();
    const columns = ['id', 'name', 'raw', 'db_updated_at'];
    const rows = tags.map(t => [
      t.id,
      t.name || null,
      JSON.stringify(t),
      now,
    ]);
    return bulkUpsert(pool, 'predict_tags', ['id'], columns, rows);
  }

  async getAllMarketIds(): Promise<(number | string)[]> {
    const pool = this.requirePool();
    // See PREDICT_CURRENT_MARKET_PREDICATE: market objects are never status='OPEN',
    // so the old `status = 'OPEN'` predicate returned 0 ids and stats enrichment
    // never ran (100% of Predict rows had volume 0).
    const { rows } = await pool.query(`SELECT id FROM predict_markets WHERE ${PREDICT_CURRENT_MARKET_PREDICATE}`);
    return rows.map(r => r.id);
  }

  async enrichMarketStats(statsArray: PredictMarketStats[]): Promise<number> {
    const pool = this.requirePool();
    if (!Array.isArray(statsArray) || statsArray.length === 0) return 0;

    const now = new Date();
    let modified = 0;
    for (const stat of statsArray) {
      const enrichment = {
        volumeTotalUsd: stat.volumeTotalUsd,
        volume24hUsd: stat.volume24hUsd,
        totalLiquidityUsd: stat.totalLiquidityUsd,
        statsUpdatedAt: now.toISOString(),
      };
      const result = await pool.query(
        `UPDATE predict_markets SET raw = raw || $1::jsonb, db_updated_at = $2 WHERE id = $3`,
        [JSON.stringify(enrichment), now, stat.id],
      );
      modified += result.rowCount ?? 0;
    }
    return modified;
  }

  async getStats() {
    const pool = this.requirePool();
    const [categories, markets, tags] = await Promise.all([
      pool.query('SELECT COUNT(*) as c FROM predict_categories'),
      pool.query('SELECT COUNT(*) as c FROM predict_markets'),
      pool.query('SELECT COUNT(*) as c FROM predict_tags'),
    ]);
    return {
      categories: parseInt(categories.rows[0].c),
      markets: parseInt(markets.rows[0].c),
      tags: parseInt(tags.rows[0].c),
    };
  }
}

const dbService = new PostgresService();
export { dbService };
