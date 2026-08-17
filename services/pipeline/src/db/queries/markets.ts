/**
 * Centralized queries for `markets` and `market_metadata_raw` tables.
 */
import { query } from '@arb/db';
import type { SyncedMarket, Platform, UnifiedCategory } from '@arb/types';
import { notParlaySql } from './match-source.js';

// ── Upsert ──

/** Sentinel-aware fill-in: an incoming NULL/sentinel value may fill a NULL column
 *  but never overwrites a specific stored value; a specific incoming value still wins.
 *  A plain COALESCE would let a sync-time sentinel reset a post-sync classifier verdict. */
export function sentinelFillInSql(col: string, sentinel: string): string {
  return `CASE WHEN EXCLUDED.${col} IS NULL OR EXCLUDED.${col} = '${sentinel}' ` +
         `THEN COALESCE(markets.${col}, EXCLUDED.${col}) ELSE EXCLUDED.${col} END`;
}

/** Enriched-wins fill-in: stored value wins (sync can only fill NULL, never clobber
 *  a richer post-sync value); richer writers bypass this upsert via direct UPDATEs. */
export function enrichedWinsSql(col: string): string {
  return `COALESCE(markets.${col}, EXCLUDED.${col})`;
}

export async function upsertMarket(market: {
  platform: string;
  platform_id: string;
  title: string;
  description: string;
  status: string;
  end_date: Date | null;
  platform_created_at?: Date | null;
  volume: number;
  slug: string | null;
  url: string | null;
  platform_event_id?: string | null;
  grouping_type?: 'threshold_series' | 'categorical_exclusive' | 'bundle_nonexclusive' | 'unknown' | null;
  category?: string | null;
  category_unified?: UnifiedCategory | null;
  tags?: string[] | null;
}): Promise<{ id: number; changed: boolean }> {
  // volume-only changes are excluded from the guard (don't affect Stage 1, tick constantly)
  const rows = await query<{ id: number; changed: boolean }>(
    `WITH upserted AS (
       INSERT INTO markets
         (platform, platform_id, title, description, status, end_date, platform_created_at,
          volume, slug, url, platform_event_id, grouping_type, category, category_unified, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (platform, platform_id) DO UPDATE SET
         title                = EXCLUDED.title,
         description          = EXCLUDED.description,
         status               = EXCLUDED.status,
         end_date             = EXCLUDED.end_date,
         platform_created_at  = COALESCE(markets.platform_created_at, EXCLUDED.platform_created_at),
         volume               = EXCLUDED.volume,
         slug                 = EXCLUDED.slug,
         url                  = EXCLUDED.url,
         platform_event_id    = COALESCE(EXCLUDED.platform_event_id, markets.platform_event_id),
         grouping_type        = ${sentinelFillInSql('grouping_type', 'unknown')},
         category             = COALESCE(EXCLUDED.category,          markets.category),
         category_unified     = ${enrichedWinsSql('category_unified')},
         tags                 = COALESCE(EXCLUDED.tags,              markets.tags),
         updated_at           = NOW()
       WHERE (markets.title, markets.description, markets.status, markets.end_date,
              markets.slug, markets.url)
         IS DISTINCT FROM
             (EXCLUDED.title, EXCLUDED.description, EXCLUDED.status, EXCLUDED.end_date,
              EXCLUDED.slug, EXCLUDED.url)
       RETURNING id
     )
     SELECT id, true AS changed FROM upserted
     UNION ALL
     SELECT id, false AS changed FROM markets
     WHERE platform = $1 AND platform_id = $2
       AND NOT EXISTS (SELECT 1 FROM upserted)`,
    [
      market.platform, market.platform_id, market.title, market.description,
      market.status, market.end_date, market.platform_created_at ?? null,
      market.volume, market.slug, market.url,
      market.platform_event_id ?? null, market.grouping_type ?? null,
      market.category ?? null, market.category_unified ?? null, market.tags ?? null,
    ]
  );
  return { id: rows[0].id, changed: rows[0].changed };
}

export async function upsertMarketMetadata(marketId: number, raw: unknown): Promise<void> {
  await query(
    `INSERT INTO market_metadata_raw (market_id, raw, synced_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (market_id) DO UPDATE SET
       raw = EXCLUDED.raw,
       synced_at = NOW()
     WHERE market_metadata_raw.raw IS DISTINCT FROM EXCLUDED.raw`,
    [marketId, JSON.stringify(raw)]
  );
}

// ── Bulk upsert (sync hot path) ──

/** Bulk-upsert a read batch into `markets` in one query via unnest. `changed=true`
 *  means a new insert or a guarded field differed (Stage 1 needed); volume is
 *  deliberately unguarded (ticks constantly, must not force reprocessing).
 *  Resolution columns (resolved_at/winning_outcome/outcomes/resolution_source) are
 *  write-once fill-ins: they fill a missing value but never overwrite or un-resolve. */
export async function bulkUpsertMarkets(
  platform: string,
  markets: ReadonlyArray<{
    platform_id: string;
    title: string;
    description: string;
    status: string;
    end_date: Date | null;
    platform_created_at?: Date | null;
    volume: number;
    slug: string | null;
    url: string | null;
    platform_event_id?: string | null;
    grouping_type?: string | null;
    category?: string | null;
    category_unified?: UnifiedCategory | null;
    tags?: string[] | null;
    resolution_scope?: string | null;
    resolved_at?: Date | null;
    winning_outcome?: string | null;
    outcomes?: string[] | null;
    resolution_source?: string | null;
  }>
): Promise<Array<{ id: number; platform_id: string; changed: boolean }>> {
  if (markets.length === 0) return [];

  const rows = await query<{ id: number; platform_id: string; changed: boolean }>(
    `WITH data(platform_id, title, description, status, end_date_str, platform_created_at_str,
               volume, slug, url, platform_event_id, grouping_type, category,
               category_unified, tags_json, resolution_scope,
               resolved_at_str, winning_outcome, outcomes_json, resolution_source) AS (
       SELECT
         unnest($2::text[]),
         unnest($3::text[]),
         unnest($4::text[]),
         unnest($5::text[]),
         unnest($6::text[]),
         unnest($7::text[]),
         unnest($8::float8[]),
         unnest($9::text[]),
         unnest($10::text[]),
         unnest($11::text[]),
         unnest($12::text[]),
         unnest($13::text[]),
         unnest($14::text[]),
         unnest($15::text[]),
         unnest($16::text[]),
         unnest($17::text[]),
         unnest($18::text[]),
         unnest($19::text[]),
         unnest($20::text[])
     ),
     upserted AS (
       INSERT INTO markets
         (platform, platform_id, title, description, status, end_date, platform_created_at,
          volume, slug, url, platform_event_id, grouping_type, category, category_unified, tags,
          resolution_scope, resolved_at, winning_outcome, outcomes, resolution_source)
       SELECT
         $1,
         d.platform_id,
         d.title,
         d.description,
         d.status,
         NULLIF(d.end_date_str, '')::timestamptz,
         NULLIF(d.platform_created_at_str, '')::timestamptz,
         d.volume,
         NULLIF(d.slug, ''),
         NULLIF(d.url, ''),
         NULLIF(d.platform_event_id, ''),
         NULLIF(d.grouping_type, ''),
         NULLIF(d.category, ''),
         NULLIF(d.category_unified, ''),
         CASE WHEN d.tags_json IS NULL
              THEN NULL
              ELSE ARRAY(SELECT jsonb_array_elements_text(d.tags_json::jsonb))
         END,
         NULLIF(d.resolution_scope, ''),
         NULLIF(d.resolved_at_str, '')::timestamptz,
         NULLIF(d.winning_outcome, ''),
         CASE WHEN d.outcomes_json IS NULL THEN NULL ELSE d.outcomes_json::jsonb END,
         NULLIF(d.resolution_source, '')
       FROM data d
       ON CONFLICT (platform, platform_id) DO UPDATE SET
         title                = EXCLUDED.title,
         description          = EXCLUDED.description,
         status               = EXCLUDED.status,
         end_date             = EXCLUDED.end_date,
         platform_created_at  = COALESCE(markets.platform_created_at, EXCLUDED.platform_created_at),
         volume               = EXCLUDED.volume,
         slug                 = EXCLUDED.slug,
         url                  = EXCLUDED.url,
         platform_event_id    = COALESCE(EXCLUDED.platform_event_id, markets.platform_event_id),
         grouping_type        = ${sentinelFillInSql('grouping_type', 'unknown')},
         category             = COALESCE(EXCLUDED.category,          markets.category),
         category_unified     = ${enrichedWinsSql('category_unified')},
         tags                 = COALESCE(EXCLUDED.tags,              markets.tags),
         resolution_scope     = ${sentinelFillInSql('resolution_scope', 'unspecified')},
         resolved_at          = COALESCE(markets.resolved_at,     EXCLUDED.resolved_at),
         winning_outcome      = COALESCE(markets.winning_outcome, EXCLUDED.winning_outcome),
         outcomes             = COALESCE(markets.outcomes,        EXCLUDED.outcomes),
         resolution_source    = CASE
           WHEN markets.resolved_at IS NULL AND EXCLUDED.resolved_at IS NOT NULL
             THEN EXCLUDED.resolution_source
           ELSE markets.resolution_source
         END,
         updated_at           = NOW()
       WHERE (markets.title, markets.description, markets.status, markets.end_date,
              markets.slug, markets.url)
         IS DISTINCT FROM
             (EXCLUDED.title, EXCLUDED.description, EXCLUDED.status, EXCLUDED.end_date,
              EXCLUDED.slug, EXCLUDED.url)
          -- structural fields compared at post-precedence value, so a discarded sentinel never trips this
          OR markets.platform_event_id IS DISTINCT FROM COALESCE(EXCLUDED.platform_event_id, markets.platform_event_id)
          OR markets.grouping_type     IS DISTINCT FROM ${sentinelFillInSql('grouping_type', 'unknown')}
          OR markets.category          IS DISTINCT FROM COALESCE(EXCLUDED.category,          markets.category)
          OR markets.category_unified  IS DISTINCT FROM ${enrichedWinsSql('category_unified')}
          OR markets.tags              IS DISTINCT FROM COALESCE(EXCLUDED.tags,              markets.tags)
          OR markets.resolution_scope  IS DISTINCT FROM ${sentinelFillInSql('resolution_scope', 'unspecified')}
          OR (markets.resolved_at     IS NULL AND EXCLUDED.resolved_at     IS NOT NULL)
          OR (markets.winning_outcome IS NULL AND EXCLUDED.winning_outcome IS NOT NULL)
          OR (markets.outcomes        IS NULL AND EXCLUDED.outcomes        IS NOT NULL)
       RETURNING id, platform_id
     )
     SELECT id, platform_id, true  AS changed FROM upserted
     UNION ALL
     SELECT m.id, m.platform_id, false AS changed
     FROM   markets m
     JOIN   data    d ON m.platform_id = d.platform_id AND m.platform = $1
     WHERE  NOT EXISTS (SELECT 1 FROM upserted u WHERE u.platform_id = m.platform_id)`,
    [
      platform,
      markets.map((m) => m.platform_id),
      markets.map((m) => m.title),
      markets.map((m) => m.description),
      markets.map((m) => m.status),
      markets.map((m) => m.end_date?.toISOString() ?? null),
      markets.map((m) => m.platform_created_at?.toISOString() ?? null),
      markets.map((m) => (isFinite(m.volume) ? m.volume : 0)),
      markets.map((m) => m.slug ?? ''),
      markets.map((m) => m.url ?? ''),
      markets.map((m) => m.platform_event_id ?? ''),
      markets.map((m) => m.grouping_type ?? ''),
      markets.map((m) => m.category ?? ''),
      markets.map((m) => m.category_unified ?? ''),
      markets.map((m) => (m.tags != null ? JSON.stringify(m.tags) : null)),
      markets.map((m) => m.resolution_scope ?? ''),
      markets.map((m) => m.resolved_at?.toISOString() ?? ''),
      // winning_outcome is VARCHAR(255) — clamp defensively
      markets.map((m) => (m.winning_outcome ?? '').slice(0, 255)),
      markets.map((m) => (m.outcomes != null && m.outcomes.length > 0 ? JSON.stringify(m.outcomes) : null)),
      markets.map((m) => m.resolution_source ?? ''),
    ]
  );

  return rows;
}

/** Bulk-upsert market_metadata_raw rows in one round-trip; skips the write when raw is identical. */
export async function bulkUpsertMarketMetadata(
  entries: ReadonlyArray<{ marketId: number; raw: unknown }>
): Promise<void> {
  if (entries.length === 0) return;
  await query(
    `INSERT INTO market_metadata_raw (market_id, raw, synced_at)
     SELECT unnest($1::int[]), unnest($2::jsonb[]), NOW()
     ON CONFLICT (market_id) DO UPDATE SET
       raw       = EXCLUDED.raw,
       synced_at = NOW()
     WHERE market_metadata_raw.raw IS DISTINCT FROM EXCLUDED.raw`,
    [
      entries.map((e) => e.marketId),
      entries.map((e) => JSON.stringify(e.raw)),
    ]
  );
}

// tradeable statuses per platform; keep in lockstep with the mirror list in stage1-normalize/text-deterministic.ts
const ACTIVE_STATUSES = ['active', 'FUNDED', 'REGISTERED', 'PRICE_PROPOSED', 'PRICE_DISPUTED', 'UNPAUSED'] as const;

/** Columns Stage 1 consumers actually read; `SELECT m.*` used to ship the pgvector
 *  `embedding` column (~12 KB/market) that no consumer reads. */
const MARKETS_SLIM_COLUMNS = `m.id, m.platform, m.platform_id, m.title,
       m.description, m.end_date, m.grouping_type, m.category_unified`;

/** Selects unfeaturized markets, computing `platform_group_id`/`platform_cross_ref`
 *  inline via a LEFT JOIN instead of loading the group mapping into Node memory. */
export async function getUnfeaturizedMarketsWithGroups(
  limit: number,
  afterId = 0
): Promise<(SyncedMarket & { platform_group_id: string | null; platform_cross_ref: string | null })[]> {
  return query(
    `SELECT ${MARKETS_SLIM_COLUMNS},
       CASE m.platform
         WHEN 'polymarket' THEN
           CASE
             WHEN (mm.raw->>'negRisk') = 'true'
               AND mm.raw->>'negRiskMarketID' IS NOT NULL
               AND mm.raw->>'negRiskMarketID' <> ''
               THEN 'polymarket:negRisk:' || (mm.raw->>'negRiskMarketID')
             WHEN mm.raw->>'eventId' IS NOT NULL
               AND mm.raw->>'eventId' <> ''
               THEN 'polymarket:event:' || (mm.raw->>'eventId')
             ELSE NULL
           END
         WHEN 'kalshi' THEN
           CASE
             -- must stay in lock-step with computePlatformGroup() in stage1-normalize/platform-groups.ts
             WHEN mm.raw->>'event_ticker' IS NOT NULL
               AND mm.raw->>'event_ticker' <> ''
               AND (mm.raw->>'event_ticker') ~ '(?i)MENTION|SAY|KXMVE'
               THEN 'kalshi:bundle:' || (mm.raw->>'event_ticker')
             WHEN mm.raw->>'event_ticker' IS NOT NULL
               AND mm.raw->>'event_ticker' <> ''
               THEN 'kalshi:event:' || (mm.raw->>'event_ticker')
             ELSE NULL
           END
         WHEN 'predict' THEN
           CASE WHEN mm.raw->>'categorySlug' IS NOT NULL
             AND mm.raw->>'categorySlug' <> ''
             THEN 'predict:category:' || (mm.raw->>'categorySlug')
             ELSE NULL
           END
         ELSE NULL
       END AS platform_group_id,
       NULL::text AS platform_cross_ref
     FROM markets m
     LEFT JOIN market_metadata_raw mm ON mm.market_id = m.id
     WHERE m.resolved_at IS NULL
       AND m.status = ANY($3::text[])
       AND m.id > $2
       AND NOT EXISTS (SELECT 1 FROM market_features mf WHERE mf.market_id = m.id)
     ORDER BY m.id
     LIMIT $1`,
    [limit, afterId, ACTIVE_STATUSES]
  );
}

/** Shared "market still needs an embedding" predicate so the row-fetcher, counter,
 *  and queue-completion gate stay in lock-step. NULL match_source counts as "not a parlay". */
function unembeddedQueryParts(skipParlays: boolean): { from: string; where: string } {
  if (skipParlays) {
    return {
      from: `markets m LEFT JOIN llm_market_normalizations n ON n.market_id = m.id`,
      where: `m.embedding IS NULL AND m.resolved_at IS NULL AND ${notParlaySql('n')}`,
    };
  }
  return {
    from: `markets m`,
    where: `m.embedding IS NULL AND m.resolved_at IS NULL`,
  };
}

/** Fetch markets needing a Stage 1c embedding. `marketIds` restricts to a known set
 *  (worker path); without it the whole table is scanned, paginated by `limit`. */
export async function selectMarketsNeedingEmbedding(
  opts: { skipParlays: boolean; marketIds?: readonly number[]; limit?: number },
): Promise<{ id: number; title: string; description: string }[]> {
  const { from, where } = unembeddedQueryParts(opts.skipParlays);
  const params: any[] = [];
  let idClause = '';
  if (opts.marketIds !== undefined) {
    if (opts.marketIds.length === 0) return [];
    params.push(opts.marketIds);
    idClause = ` AND m.id = ANY($${params.length}::int[])`;
  }
  const limitClause = opts.limit ? ` LIMIT ${opts.limit | 0}` : '';
  return query<{ id: number; title: string; description: string }>(
    `SELECT m.id, m.title, m.description
       FROM ${from}
      WHERE ${where}${idClause}
      ORDER BY m.id${limitClause}`,
    params,
  );
}

/** Count of markets still needing a Stage 1c embedding; shares the predicate with `selectMarketsNeedingEmbedding`. */
export async function countMarketsNeedingEmbedding(
  opts: { skipParlays: boolean },
): Promise<number> {
  const { from, where } = unembeddedQueryParts(opts.skipParlays);
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ${from} WHERE ${where}`,
  );
  return Number(rows[0]?.n ?? '0');
}

/** Bulk-update embeddings for a whole batch in one round-trip. */
export async function bulkUpdateMarketEmbeddings(
  items: ReadonlyArray<{ id: number; vec: string }>,
  model: string,
): Promise<void> {
  if (items.length === 0) return;
  await query(
    `UPDATE markets
       SET embedding       = data.vec::vector,
           embedding_model = $3,
           embedded_at     = NOW()
      FROM (SELECT unnest($1::int[]) AS id,
                   unnest($2::text[]) AS vec) AS data
     WHERE markets.id = data.id`,
    [items.map(i => i.id), items.map(i => i.vec), model],
  );
}

// ── Bulk lookups ──

export async function getAllMarketPlatforms(): Promise<Map<number, Platform>> {
  const rows = await query<{ id: number; platform: string }>(
    `SELECT id, platform FROM markets WHERE resolved_at IS NULL`
  );
  return new Map(rows.map((r) => [r.id, r.platform as Platform]));
}

export async function getMarketMetadataRaw(marketId: number): Promise<any | null> {
  const rows = await query<{ raw: any }>(
    `SELECT mm.raw FROM market_metadata_raw mm WHERE mm.market_id = $1`,
    [marketId]
  );
  return rows.length > 0 ? rows[0].raw : null;
}

/** Per-round-trip ID cap: a near-table-sized `WHERE id = ANY($1)` sends pg's planner off the happy path. */
const ID_CHUNK = 25_000;

/** Load category_unified per market ID; NULL is treated as unclassified and never rejects a pair. */
export async function loadCategoryUnifiedMap(marketIds: number[]): Promise<Map<number, UnifiedCategory | null>> {
  const map = new Map<number, UnifiedCategory | null>();
  if (marketIds.length === 0) return map;
  for (let i = 0; i < marketIds.length; i += ID_CHUNK) {
    const chunk = marketIds.slice(i, i + ID_CHUNK);
    const rows = await query<{ id: number; category_unified: UnifiedCategory | null }>(
      `SELECT id, category_unified FROM markets WHERE id = ANY($1::int[])`,
      [chunk],
    );
    for (const r of rows) map.set(r.id, r.category_unified);
  }
  return map;
}

/** Load condition_date + condition_date_precision per market in one pass; `precisions`
 *  lets Stage 2 skip date-proximity checks on event-anchored (year/month) markets. */
export async function loadConditionDateInfoMap(
  marketIds: number[],
): Promise<{
  dates: Map<number, string | null>;
  precisions: Map<number, string | null>;
}> {
  const dates = new Map<number, string | null>();
  const precisions = new Map<number, string | null>();
  if (marketIds.length === 0) return { dates, precisions };
  for (let i = 0; i < marketIds.length; i += ID_CHUNK) {
    const chunk = marketIds.slice(i, i + ID_CHUNK);
    const rows = await query<{
      market_id: number;
      condition_date: string | null;
      condition_date_precision: string | null;
    }>(
      `SELECT market_id, condition_date, condition_date_precision
         FROM llm_market_normalizations
        WHERE market_id = ANY($1::int[])`,
      [chunk],
    );
    for (const r of rows) {
      dates.set(r.market_id, r.condition_date);
      precisions.set(r.market_id, r.condition_date_precision);
    }
  }
  return { dates, precisions };
}

/** Writes the LLM-confirmed category back, overriding the keyword-based Stage-0 value. */
export async function updateMarketCategoryUnified(marketId: number, categoryUnified: string): Promise<void> {
  await query(
    `UPDATE markets SET category_unified = $1 WHERE id = $2`,
    [categoryUnified, marketId]
  );
}

/** Bulk equivalent of updateMarketCategoryUnified for deterministic batches. */
export async function bulkUpdateMarketCategoryUnified(
  items: ReadonlyArray<{ marketId: number; categoryUnified: string }>,
): Promise<void> {
  if (items.length === 0) return;
  await query(
    `UPDATE markets
        SET category_unified = data.category_unified
       FROM (SELECT unnest($1::int[]) AS market_id,
                    unnest($2::text[]) AS category_unified) AS data
      WHERE markets.id = data.market_id`,
    [items.map((i) => i.marketId), items.map((i) => i.categoryUnified)],
  );
}

