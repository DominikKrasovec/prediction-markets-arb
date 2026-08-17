/**
 * Syncs scraper Postgres tables into the normalized `markets` table, using a
 * per-platform watermark so only rows updated since the last run are read.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { normalizeMarketDoc, expandMarketDocs } from './market-normalizer.js';
import { extractResolution, type ExtractedResolution } from './resolution-extract.js';
import { bulkUpsertMarkets, bulkUpsertMarketMetadata } from './queries/markets.js';
import { bulkInsertMarketFeatures } from './queries/features.js';
import { getWatermark, setWatermark } from './queries/pipeline-runs.js';
import { enqueueStage1 } from './queries/stage1-queue.js';
import { classifyCategoryLabels } from './category-taxonomy.js';
import { featurizeMarket } from '../stage1-normalize/index.js';
import { computePlatformGroup } from '../stage1-normalize/platform-groups.js';
import { isParlayMarket } from '../util/parlay-legs.js';
import {
  classifyKalshiEvent,
  extractKalshiTemplate,
  templatePromotesToCategorical,
  isMonotonicThresholdPromotion,
  isMonotonicStrikeTypePromotion,
  isIndependentSelectionPromotion,
  type KalshiGrouping,
} from './queries/kalshi-classify.js';
import { nativeMutex } from '../util/native-exclusivity.js';
import type { Platform, SyncedMarket } from '@arb/types';

const log = createLogger('sync');

const PLATFORMS: Platform[] = ['kalshi', 'limitless', 'polymarket', 'predict'];

const TABLE_MAP: Record<Platform, string> = {
  kalshi: 'kalshi_markets',
  limitless: 'limitless_markets',
  polymarket: 'polymarket_markets',
  predict: 'predict_markets',
};

/** Cold-start (watermark=null) scan skips archived/closed markets. */
export const COLD_FILTER_MAP: Record<Platform, string> = {
  polymarket: `active = true AND closed = false`,
  kalshi:     `status = 'active'`,
  limitless:  `expired = false`,
  // Keep in lockstep with PREDICT_CURRENT_MARKET_PREDICATE in services/ingestion/src/scrapers/predict/postgres.ts.
  predict:    `(status IS NULL OR status NOT IN ('RESOLVED', 'REMOVED'))`,
};

/** Per-platform pk column, used as the keyset tiebreaker alongside db_updated_at. */
const PK_COLUMN_MAP: Record<Platform, string> = {
  kalshi:     'ticker',
  polymarket: 'condition_id',
  limitless:  'slug',
  predict:    'id',
};

const BATCH_SIZE = 2000;
const LOG_EVERY = 5000;

// Per-platform sync

/** Returns min(runStartAt, observedMaxDataTs), or null if no rows were read (leave watermark unchanged). */
export function computeNextWatermark(
  runStartAt: Date,
  observedMaxDataTs: Date | null,
  rowsRead: number,
): Date | null {
  if (rowsRead <= 0 || observedMaxDataTs == null) return null;
  return observedMaxDataTs.getTime() < runStartAt.getTime() ? observedMaxDataTs : runStartAt;
}

/** (db_updated_at, pk) of the last row read on the previous page. */
export interface KeysetCursor {
  lastTs: Date;
  lastPk: string;
}

export function buildKeysetReadQuery(opts: {
  table: string;
  pkCol: string;
  coldFilter: string;
  watermark: Date | null;
  batchSize: number;
  cursor: KeysetCursor | null;
}): { sql: string; params: unknown[] } {
  const { table, pkCol, coldFilter, watermark, batchSize, cursor } = opts;
  const pkExpr = `"${pkCol}"::text`;
  const order = `ORDER BY db_updated_at, ${pkExpr}`;
  if (watermark) {
    if (cursor) {
      return {
        sql: `SELECT raw, db_updated_at, ${pkExpr} AS keyset_pk FROM "${table}" `
          + `WHERE db_updated_at > $1 AND (db_updated_at, ${pkExpr}) > ($2, $3) ${order} LIMIT $4`,
        params: [watermark, cursor.lastTs, cursor.lastPk, batchSize],
      };
    }
    return {
      sql: `SELECT raw, db_updated_at, ${pkExpr} AS keyset_pk FROM "${table}" `
        + `WHERE db_updated_at > $1 ${order} LIMIT $2`,
      params: [watermark, batchSize],
    };
  }
  if (cursor) {
    return {
      sql: `SELECT raw, db_updated_at, ${pkExpr} AS keyset_pk FROM "${table}" `
        + `WHERE ${coldFilter} AND (db_updated_at, ${pkExpr}) > ($1, $2) ${order} LIMIT $3`,
      params: [cursor.lastTs, cursor.lastPk, batchSize],
    };
  }
  return {
    sql: `SELECT raw, db_updated_at, ${pkExpr} AS keyset_pk FROM "${table}" `
      + `WHERE ${coldFilter} ${order} LIMIT $1`,
    params: [batchSize],
  };
}

/** Returns null on an empty page (loop should stop). */
export function advanceCursor(
  rows: ReadonlyArray<{ db_updated_at: Date; keyset_pk: string }>,
): KeysetCursor | null {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const ts = last.db_updated_at instanceof Date ? last.db_updated_at : new Date(last.db_updated_at);
  return { lastTs: ts, lastPk: String(last.keyset_pk) };
}

async function syncPlatform(platform: Platform): Promise<number> {
  const table = TABLE_MAP[platform];
  const runStartAt = new Date();
  const watermark = await getWatermark(platform);
  const coldFilter = COLD_FILTER_MAP[platform];

  const countRes = await query<{ n: string }>(
    watermark
      ? `SELECT COUNT(*) AS n FROM "${table}" WHERE db_updated_at > $1`
      : `SELECT COUNT(*) AS n FROM "${table}" WHERE ${coldFilter}`,
    watermark ? [watermark] : []
  );
  const total = parseInt(countRes[0].n, 10);

  if (total === 0) {
    log.info(`${platform}: 0 new rows (watermark: ${watermark?.toISOString() ?? 'none'})`);
    return 0;
  }

  log.info(`${platform}: ${total} rows to sync (watermark: ${watermark?.toISOString() ?? 'none'}${watermark ? '' : ', cold-start active-only'})`);

  await setWatermark(platform, runStartAt);

  const pkCol = PK_COLUMN_MAP[platform];
  let cursor: KeysetCursor | null = null;
  let synced = 0;
  let lastLog = 0;
  let observedMaxDataTs: Date | null = null;
  const enqueueBuffer: number[] = [];

  while (true) {
    const { sql, params } = buildKeysetReadQuery({ table, pkCol, coldFilter, watermark, batchSize: BATCH_SIZE, cursor });
    const rows = await query<{ raw: any; db_updated_at: Date; keyset_pk: string }>(sql, params);

    if (rows.length === 0) break;

    for (const r of rows) {
      const ts = r.db_updated_at instanceof Date ? r.db_updated_at : new Date(r.db_updated_at);
      if (observedMaxDataTs == null || ts.getTime() > observedMaxDataTs.getTime()) observedMaxDataTs = ts;
    }

    // Normalize; drop parlay markets; dedup by platform_id to avoid an in-batch
    // ON CONFLICT collision.
    const byPid = new Map<string, {
      normalized: ReturnType<typeof normalizeMarketDoc>;
      resolution: ExtractedResolution | null;
      raw: any;
    }>();
    let droppedParlays = 0;
    for (const row of rows) {
      const observedAt = row.db_updated_at instanceof Date
        ? row.db_updated_at
        : new Date(row.db_updated_at);
      for (const doc of expandMarketDocs(row.raw, platform)) {
        const nd = normalizeMarketDoc(doc, platform);
        if (isParlayMarket({ platform, platformId: nd.platform_id, title: nd.title })) {
          droppedParlays++;
          const structural = platform === 'kalshi' && /^KXMVE/i.test(nd.platform_id);
          if (!structural) {
            log.info(`parlay-guard: title-shape drop ${platform} ${nd.platform_id} — "${nd.title}"`);
          }
          continue;
        }
        if (!nd.platform_id) continue;
        const resolution = extractResolution(platform, doc, isNaN(observedAt.getTime()) ? null : observedAt);
        byPid.set(nd.platform_id, { normalized: nd, resolution, raw: doc });
      }
    }
    if (droppedParlays > 0) {
      log.info(`${platform}: parlay-guard dropped ${droppedParlays} market(s) this batch`);
    }
    const entries = [...byPid.values()];
    const normalized = entries.map((e) => e.resolution
      ? {
          ...e.normalized,
          resolved_at: e.resolution.resolved_at,
          winning_outcome: e.resolution.winning_outcome,
          outcomes: e.resolution.outcomes,
          resolution_source: e.resolution.source,
        }
      : e.normalized);

    const upserted = await bulkUpsertMarkets(platform, normalized);

    const idByPid = new Map(upserted.map((r) => [r.platform_id, r.id]));
    await bulkUpsertMarketMetadata(
      entries
        .map((e) => ({ marketId: idByPid.get(e.normalized.platform_id)!, raw: e.raw }))
        .filter((e) => e.marketId != null)
    );

    const changedSet = new Set(upserted.filter((r) => r.changed).map((r) => r.id));
    const featuresBatch = [];
    for (const e of entries) {
      const id = idByPid.get(e.normalized.platform_id);
      if (id == null || !changedSet.has(id)) continue;
      const synced = {
        ...e.normalized,
        id,
        platform,
      } as unknown as SyncedMarket;
      const group = computePlatformGroup(platform, e.raw);
      featuresBatch.push(featurizeMarket(synced, group));
    }
    if (featuresBatch.length > 0) {
      await bulkInsertMarketFeatures(featuresBatch);
    }

    for (const r of upserted) {
      if (r.changed) enqueueBuffer.push(r.id);
    }

    synced += rows.length;
    if (enqueueBuffer.length >= 1000) {
      await enqueueStage1(enqueueBuffer.splice(0));
    }

    cursor = advanceCursor(rows);
    const shortPage = rows.length < BATCH_SIZE;

    if (synced - lastLog >= LOG_EVERY || shortPage) {
      log.info(`${platform}: ${synced}/${total} done`);
      lastLog = synced;
    }
    if (shortPage) break;
  }

  if (enqueueBuffer.length > 0) {
    await enqueueStage1(enqueueBuffer.splice(0));
  }

  const nextWatermark = computeNextWatermark(runStartAt, observedMaxDataTs, synced);
  if (nextWatermark != null) {
    await setWatermark(platform, nextWatermark, synced);
  } else {
    await setWatermark(platform, runStartAt, synced);
  }
  return synced;
}

// Orchestrator

export async function runSync(): Promise<number> {
  log.info('Starting scraper tables → pipeline markets sync');

  const results = await Promise.allSettled(PLATFORMS.map((p) => syncPlatform(p)));

  let total = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      total += r.value;
    } else {
      log.error(`${PLATFORMS[i]}: ERROR`, r.reason);
    }
  }

  await enrichMarketCategoriesFromEvents();
  await populatePlatformEvents();
  await classifyKalshiEvents();
  await inferResolutionScopeFromStructure();
  await extractMarketCrossRefs();

  log.info(`Done. Total synced: ${total} markets`);
  return total;
}

/**
 * Infers resolution_scope from event structure (a Draw/Tie outcome implies
 * regulation-scoped legs) for rows text-parsing left unspecified. Never
 * overwrites explicit text; the inverse (no draw ⇒ incl_overtime) is not
 * inferred, since a false positive would wrongly reject a valid merge.
 */
export async function inferResolutionScopeFromStructure(): Promise<{ regulation: number }> {
  try {
    const reg = await query<{ id: number }>(
      `WITH draw_events AS (
         SELECT DISTINCT m.platform, m.platform_event_id
         FROM markets m
         JOIN platform_events pe
           ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
         WHERE m.category_unified = 'sports'
           AND pe.grouping_type = 'categorical_exclusive'
           AND m.title ~* '\\m(draw|tie)\\M'
       )
       UPDATE markets m
          SET resolution_scope = 'regulation'
         FROM draw_events d
        WHERE m.platform = d.platform
          AND m.platform_event_id = d.platform_event_id
          AND (m.resolution_scope IS NULL OR m.resolution_scope = 'unspecified')
        RETURNING m.id`
    );

    // Kalshi H2H fixtures sit at grouping_type='unknown', not categorical, so they need a separate 3-way shape gate.
    const kalshiReg = await query<{ id: number }>(
      `WITH kalshi_3way AS (
         SELECT m.platform_event_id
         FROM markets m
         JOIN platform_events pe
           ON pe.platform = 'kalshi' AND pe.platform_event_id = m.platform_event_id
         LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
         WHERE m.platform = 'kalshi'
           AND m.category_unified = 'sports'
           AND pe.grouping_type = 'unknown'
         GROUP BY m.platform_event_id
         HAVING count(*) = 3
            AND count(*) FILTER (
                  WHERE m.title ~* '\\m(draw|tie)\\M'
                     OR mr.raw->>'yes_sub_title' ~* '\\m(draw|tie)\\M'
                ) = 1
       )
       UPDATE markets m
          SET resolution_scope = 'regulation'
         FROM kalshi_3way k
        WHERE m.platform = 'kalshi'
          AND m.platform_event_id = k.platform_event_id
          AND (m.resolution_scope IS NULL OR m.resolution_scope = 'unspecified')
        RETURNING m.id`
    );

    const regulation = reg.length + kalshiReg.length;
    log.info(
      `resolution_scope (structural): ${regulation} → regulation ` +
      `(draw-outcome present; categorical=${reg.length}, kalshi 3-way=${kalshiReg.length})`
    );
    return { regulation };
  } catch (err) {
    log.error('inferResolutionScopeFromStructure failed:', err);
    return { regulation: 0 };
  }
}

/** Fills markets.category (and .tags for polymarket) from the platform-native event tables; limitless/predict already populate these at normalization. */
export async function enrichMarketCategoriesFromEvents(): Promise<{ kalshi: number; polymarket: number }> {
  try {
    const [kalshiRes, polyRes] = await Promise.all([
      query<{ id: number }>(
        `UPDATE markets m
           SET category = e.category
           FROM kalshi_events e
           WHERE m.platform = 'kalshi'
             AND m.resolved_at IS NULL
             AND m.platform_event_id = 'kalshi:event:' || e.event_ticker
             AND e.category IS NOT NULL
             AND m.category IS NULL
           RETURNING m.id`
      ),
      query<{ id: number }>(
        `UPDATE markets m
           SET category  = COALESCE(NULLIF(e.raw->>'category', ''), (e.raw->'tags'->0->>'label')),
               tags      = CASE
                             WHEN jsonb_typeof(e.raw->'tags') = 'array'
                             THEN ARRAY(SELECT DISTINCT (t->>'label') FROM jsonb_array_elements(e.raw->'tags') t WHERE t->>'label' IS NOT NULL)
                             ELSE NULL
                           END,
               tag_slugs = CASE
                             WHEN jsonb_typeof(e.raw->'tags') = 'array'
                             THEN ARRAY(SELECT DISTINCT (t->>'slug') FROM jsonb_array_elements(e.raw->'tags') t WHERE t->>'slug' IS NOT NULL)
                             ELSE NULL
                           END
           FROM polymarket_events e
           WHERE m.platform = 'polymarket'
             AND m.resolved_at IS NULL
             AND m.platform_event_id = e.id
             AND (m.category IS NULL OR m.tags IS NULL OR m.tag_slugs IS NULL)
           RETURNING m.id`
      ),
    ]);
    const kalshi = kalshiRes.length;
    const polymarket = polyRes.length;
    log.info(`kalshi: enriched category on ${kalshi} markets`);
    log.info(`polymarket: enriched category+tags on ${polymarket} markets`);

    const changedIds = [...kalshiRes.map((r) => r.id), ...polyRes.map((r) => r.id)];
    const unified = await classifyMarketsUnified(changedIds);
    log.info(`unified category classified for ${unified} markets`);

    return { kalshi, polymarket };
  } catch (err) {
    log.error('post-sync enrichment failed:', err);
    return { kalshi: 0, polymarket: 0 };
  }
}

/** Re-classifies markets into the unified taxonomy from (category, tags[], title); pass [] for a full pass over all active markets. */
export async function classifyMarketsUnified(changedIds: number[]): Promise<number> {
  const rows = await query<{
    id: number;
    platform: Platform;
    platform_id: string;
    category: string | null;
    tags: string[] | null;
    title: string;
    predict_tag_names: string[] | null;
  }>(
    changedIds.length > 0
      ? `SELECT m.id, m.platform, m.platform_id, m.category, m.tags, m.title,
           CASE WHEN m.platform = 'predict' THEN (
             SELECT ARRAY(
               SELECT (t->>'name')
               FROM predict_categories pc
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pc.raw->'tags', '[]'::jsonb)) t
               WHERE pc.slug = m.category
                 AND t->>'name' IS NOT NULL
             )
           ) ELSE NULL END AS predict_tag_names
         FROM markets m
         WHERE m.resolved_at IS NULL
           AND (
             m.id = ANY($1::int[])
             OR m.category_unified IS NULL
           )`
      : `SELECT m.id, m.platform, m.platform_id, m.category, m.tags, m.title,
           CASE WHEN m.platform = 'predict' THEN (
             SELECT ARRAY(
               SELECT (t->>'name')
               FROM predict_categories pc
               CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pc.raw->'tags', '[]'::jsonb)) t
               WHERE pc.slug = m.category
                 AND t->>'name' IS NOT NULL
             )
           ) ELSE NULL END AS predict_tag_names
         FROM markets m
         WHERE m.resolved_at IS NULL`,
    changedIds.length > 0 ? [changedIds] : []
  );

  const updates: Array<{ id: number; value: string | null }> = [];
  for (const r of rows) {
    if (r.platform === 'kalshi') {
      if (/^KXTEMP/i.test(r.platform_id)) {
        updates.push({ id: r.id, value: 'weather' });
        continue;
      }
      if (/^KXHOUSERACE/i.test(r.platform_id)) {
        updates.push({ id: r.id, value: 'election' });
        continue;
      }
    }
    const labels = [r.category, ...(r.tags ?? []), ...(r.predict_tag_names ?? []), r.title];
    const unified = classifyCategoryLabels(labels);
    updates.push({ id: r.id, value: unified === 'other' ? null : unified });
  }

  if (updates.length === 0) return 0;

  // Chunk to stay under Postgres's 65535 param limit (2 params/row).
  const CHUNK = 2000;
  let updated = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const valuePlaceholders: string[] = [];
    let idx = 1;
    for (const u of slice) {
      valuePlaceholders.push(`($${idx++}::int, $${idx++}::text)`);
      params.push(u.id, u.value);
    }
    const result = await query<{ n: string }>(
      `WITH vals(id, value) AS (VALUES ${valuePlaceholders.join(', ')})
       UPDATE markets m
          SET category_unified = v.value
         FROM vals v
        WHERE m.id = v.id
          AND m.category_unified IS DISTINCT FROM v.value
       RETURNING 1`,
      params
    );
    updated += result.length;
  }
  return updated;
}

/** Rebuilds the `platform_events` aggregate from `markets`; never touches llm_normalized on conflict. */
export async function populatePlatformEvents(): Promise<number> {
  try {
    const rows = await query<{ n: string }>(
      `WITH upserted AS (
         INSERT INTO platform_events
           (platform, platform_event_id, grouping_type, title, child_count)
         SELECT
           m.platform,
           m.platform_event_id,
           COALESCE(MIN(m.grouping_type), 'unknown') AS grouping_type,
           COALESCE(
             MAX(ke.raw->>'title'),
             MAX(pe_raw.raw->>'title'),
             MIN(m.title)
           ) AS title,
           COUNT(*) AS child_count
         FROM markets m
         LEFT JOIN kalshi_events ke
           ON m.platform = 'kalshi'
          AND m.platform_event_id = 'kalshi:event:' || ke.event_ticker
         LEFT JOIN polymarket_events pe_raw
           ON m.platform = 'polymarket'
          AND m.platform_event_id = pe_raw.id
         WHERE m.platform_event_id IS NOT NULL
           AND m.resolved_at IS NULL
         GROUP BY m.platform, m.platform_event_id
         ON CONFLICT (platform, platform_event_id) DO UPDATE SET
           child_count   = EXCLUDED.child_count,
           -- never downgrade a specific grouping_type to 'unknown'
           grouping_type = CASE
             WHEN EXCLUDED.grouping_type = 'unknown' THEN platform_events.grouping_type
             ELSE EXCLUDED.grouping_type
           END,
           title         = COALESCE(EXCLUDED.title, platform_events.title),
           updated_at    = NOW()
         RETURNING 1
       )
       SELECT COUNT(*)::text AS n FROM upserted`
    );
    const n = Number(rows[0].n);

    // Drop platform_events rows whose every child has now resolved (re-derivable from markets on next sync).
    const reaped = await query<{ n: string }>(
      `WITH del AS (
         DELETE FROM platform_events pe
         WHERE NOT EXISTS (
           SELECT 1 FROM markets m
           WHERE m.platform = pe.platform
             AND m.platform_event_id = pe.platform_event_id
             AND m.resolved_at IS NULL
         )
         RETURNING 1
       )
       SELECT COUNT(*)::text AS n FROM del`
    );
    const reapedN = Number(reaped[0].n);
    log.info(`platform_events: ${n} rows upserted, ${reapedN} fully-resolved rows reaped`);
    return n;
  } catch (err) {
    log.error('populatePlatformEvents failed:', err);
    return 0;
  }
}

// Kalshi event-level grouping classifier (post-sync stage)

interface ClassifyKalshiResult {
  events_seen: number;
  events_changed: number;
  categorical: number;
  bundle: number;
  unknown: number;
  markets_to_update: number;
  features_to_rewrite: number;
  template_promoted: number;
  native_mutex_demoted: number;
}

/**
 * Event-level Kalshi grouping classifier; runs after `populatePlatformEvents`
 * so every event has its full sibling set. Propagates the verdict (in LIVE
 * mode) to platform_events.grouping_type, markets.grouping_type, and
 * market_features.platform_group_id. An 'unknown' verdict is no-opinion and
 * never overwrites a Stage-2a verdict, except for demoting a stored
 * categorical_exclusive that lacks native mutex proof. Idempotent.
 */
export async function classifyKalshiEvents(
  opts: { dryRun?: boolean } = {}
): Promise<ClassifyKalshiResult> {
  const dryRun = opts.dryRun ?? false;

  // 1. Gather distinct titles per event, plus the current platform_events
  //    grouping_type so events_changed can be computed. Excludes markets
  //    whose market_features.platform_group_id already starts with
  //    'kalshi:bundle:' (MENTION/SAY tickers classified at sync-time by
  //    computePlatformGroup()).
  //
  // The event-level title (kalshi_events.raw->>'title', falling back to
  // platform_events.title) is mixed into the sibling-title set: the
  // classifier's patterns are event-level phrasings ("Who will win…"), while
  // market-level titles for a categorical event are typically per-candidate
  // rows that match none of them.
  const events = await query<{
    peid: string;
    titles: string[];
    event_title: string | null;
    current_gt: string | null;
    // Pairs of (rules_primary, candidate) over the event's markets, used by
    // the template extractor. node-postgres delivers array_agg(jsonb_build_*)
    // as a JS array of {rule, candidate} objects with nullable string fields.
    template_inputs: { rule: string | null; candidate: string | null }[] | null;
    // Native strike_type of each child + distinct canonical_subject count:
    // isMonotonicStrikeTypePromotion refuses categorical promotion for
    // half-line threshold events, keying on strike_type not free-text titles.
    strike_types: (string | null)[] | null;
    subject_count: number;
    // 'true'=mutex, 'false'=independent (demote categorical), null=no signal.
    native_me: string | null;
  }>(
    `SELECT
       m.platform_event_id AS peid,
       array_agg(DISTINCT m.title) AS titles,
       COALESCE(MIN(ke.raw->>'title'), MIN(pe.title)) AS event_title,
       MIN(pe.grouping_type) AS current_gt,
       array_agg(km.raw->>'strike_type') AS strike_types,
       count(DISTINCT ln.canonical_subject)::int AS subject_count,
       MIN(ke.raw->>'mutually_exclusive') AS native_me,
       jsonb_agg(jsonb_build_object(
         'rule',      km.raw->>'rules_primary',
         'candidate', COALESCE(km.raw->>'yes_sub_title', km.raw->>'subtitle')
       )) AS template_inputs
     FROM markets m
     LEFT JOIN platform_events pe
       ON pe.platform = m.platform
      AND pe.platform_event_id = m.platform_event_id
     LEFT JOIN kalshi_events ke
       ON m.platform_event_id = 'kalshi:event:' || ke.event_ticker
     LEFT JOIN kalshi_markets km
       ON km.ticker = m.platform_id
     LEFT JOIN llm_market_normalizations ln
       ON ln.market_id = m.id
     WHERE m.platform = 'kalshi'
       AND m.platform_event_id IS NOT NULL
       AND m.platform_event_id !~ '(?i)MENTION|SAY|KXMVE'
       AND NOT EXISTS (
         SELECT 1 FROM market_features mf
         WHERE mf.market_id = m.id
           AND mf.platform_group_id LIKE 'kalshi:bundle:%'
       )
     GROUP BY m.platform_event_id`
  );

  const result: ClassifyKalshiResult = {
    events_seen: events.length,
    events_changed: 0,
    categorical: 0,
    bundle: 0,
    unknown: 0,
    markets_to_update: 0,
    features_to_rewrite: 0,
    template_promoted: 0,
    native_mutex_demoted: 0,
  };

  // Two-stage verdict: title classifier, then (if 'unknown') template extraction.
  // 'unknown' is no-opinion, never overwriting a Stage-2a verdict, except the
  // categorical_exclusive demote below — split into assertive vs demote batches.
  const assertPeids: string[] = [];
  const assertGts: KalshiGrouping[] = [];
  const demotePeids: string[] = [];
  for (const ev of events) {
    const titles = ev.event_title ? [ev.event_title, ...ev.titles] : ev.titles;
    let gt = classifyKalshiEvent(titles);
    if (gt === 'unknown' && ev.template_inputs) {
      const candidates = ev.template_inputs.map((t) => t.candidate ?? null);
      const tmpl = extractKalshiTemplate(
        ev.template_inputs.map((t) => ({
          rules_primary: t.rule ?? null,
          candidate: t.candidate ?? null,
        }))
      );
      // Ladder/threshold/independent-selection sets are excluded from promotion;
      // the denylist only applies where there's no native mutex field to gate on later.
      const nativePresent = nativeMutex('kalshi', { mutually_exclusive: ev.native_me }) !== null;
      const applyDenylist = !nativePresent;
      if (
        templatePromotesToCategorical(tmpl)
        && !isMonotonicThresholdPromotion(tmpl, candidates)
        && !isMonotonicStrikeTypePromotion(ev.strike_types ?? [], ev.subject_count)
        && (!applyDenylist || !isIndependentSelectionPromotion(tmpl))
      ) {
        gt = 'categorical_exclusive';
        result.template_promoted++;
      }
    }
    // Demote-only: native mutually_exclusive='false' downgrades categorical to 'unknown'; null/true never demote.
    if (
      gt === 'categorical_exclusive'
      && nativeMutex('kalshi', { mutually_exclusive: ev.native_me }) === false
    ) {
      gt = 'unknown';
      result.native_mutex_demoted++;
    }
    if (gt === 'categorical_exclusive') result.categorical++;
    else if (gt === 'bundle_nonexclusive') result.bundle++;
    else result.unknown++;
    if (gt !== 'unknown') {
      assertPeids.push(ev.peid);
      assertGts.push(gt);
      if (ev.current_gt !== gt) result.events_changed++;
    } else if (nativeMutex('kalshi', { mutually_exclusive: ev.native_me }) !== true) {
      demotePeids.push(ev.peid);
      if (ev.current_gt === 'categorical_exclusive') result.events_changed++;
    }
  }

  if (assertPeids.length === 0 && demotePeids.length === 0) {
    log.info('classifyKalshiEvents: no Kalshi events to classify');
    return result;
  }

  const mUpd = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM markets m
       JOIN (SELECT unnest($1::text[]) AS peid, unnest($2::text[]) AS gt) v
         ON m.platform_event_id = v.peid
      WHERE m.platform = 'kalshi'
        AND m.grouping_type IS DISTINCT FROM v.gt`,
    [assertPeids, assertGts]
  );
  const mDem = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM markets m
      WHERE m.platform = 'kalshi'
        AND m.platform_event_id = ANY($1::text[])
        AND m.grouping_type = 'categorical_exclusive'`,
    [demotePeids]
  );
  result.markets_to_update = Number(mUpd[0]?.n ?? 0) + Number(mDem[0]?.n ?? 0);

  const fRewrite = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM market_features mf
       JOIN markets m ON m.id = mf.market_id
       JOIN (SELECT unnest($1::text[]) AS peid, unnest($2::text[]) AS gt) v
         ON m.platform_event_id = v.peid
      WHERE m.platform = 'kalshi'
        AND (
          (v.gt = 'bundle_nonexclusive' AND mf.platform_group_id LIKE 'kalshi:event:%')
          OR (v.gt <> 'bundle_nonexclusive' AND mf.platform_group_id LIKE 'kalshi:bundle:%')
        )`,
    [assertPeids, assertGts]
  );
  result.features_to_rewrite = Number(fRewrite[0]?.n ?? 0);

  log.info(
    `classifyKalshiEvents (${dryRun ? 'DRY-RUN' : 'LIVE'}): ` +
    `${result.events_seen} events seen, ${result.events_changed} changed ` +
    `(categorical=${result.categorical}, bundle=${result.bundle}, ` +
    `unknown=${result.unknown}; +${result.template_promoted} promoted by template` +
    `; −${result.native_mutex_demoted} demoted by native-mutex gate); ` +
    `markets to update: ${result.markets_to_update}; ` +
    `features to rewrite: ${result.features_to_rewrite}`
  );

  if (dryRun) return result;

  if (assertPeids.length > 0) {
    await query(
      `UPDATE platform_events pe
         SET grouping_type = v.gt, updated_at = NOW()
         FROM (SELECT unnest($1::text[]) AS peid, unnest($2::text[]) AS gt) v
        WHERE pe.platform = 'kalshi'
          AND pe.platform_event_id = v.peid
          AND pe.grouping_type IS DISTINCT FROM v.gt`,
      [assertPeids, assertGts]
    );

    await query(
      `UPDATE markets m
         SET grouping_type = v.gt
         FROM (SELECT unnest($1::text[]) AS peid, unnest($2::text[]) AS gt) v
        WHERE m.platform = 'kalshi'
          AND m.platform_event_id = v.peid
          AND m.grouping_type IS DISTINCT FROM v.gt`,
      [assertPeids, assertGts]
    );

    await query(
      `UPDATE market_features mf
         SET platform_group_id = CASE
           WHEN v.gt = 'bundle_nonexclusive'
             THEN 'kalshi:bundle:' || substring(m.platform_event_id from 14)
           ELSE 'kalshi:event:' || substring(m.platform_event_id from 14)
         END
         FROM markets m,
              (SELECT unnest($1::text[]) AS peid, unnest($2::text[]) AS gt) v
        WHERE mf.market_id = m.id
          AND m.platform = 'kalshi'
          AND m.platform_event_id = v.peid
          AND (
            (v.gt = 'bundle_nonexclusive' AND mf.platform_group_id LIKE 'kalshi:event:%')
            OR (v.gt <> 'bundle_nonexclusive' AND mf.platform_group_id LIKE 'kalshi:bundle:%')
          )`,
      [assertPeids, assertGts]
    );
  }

  if (demotePeids.length > 0) {
    await query(
      `UPDATE platform_events pe
         SET grouping_type = 'unknown', updated_at = NOW()
        WHERE pe.platform = 'kalshi'
          AND pe.platform_event_id = ANY($1::text[])
          AND pe.grouping_type = 'categorical_exclusive'`,
      [demotePeids]
    );

    await query(
      `UPDATE markets m
         SET grouping_type = 'unknown'
        WHERE m.platform = 'kalshi'
          AND m.platform_event_id = ANY($1::text[])
          AND m.grouping_type = 'categorical_exclusive'`,
      [demotePeids]
    );
  }

  return result;
}

/** Extracts Predict.fun's native cross-platform pointers (raw.polymarketConditionIds[]) into market_cross_refs; Kalshi linkage is excluded as unreliable. */
async function extractMarketCrossRefs(): Promise<{ extracted: number; resolved: number }> {
  try {
    const predictToPoly = await query<{ n: string }>(
      `WITH ins AS (
         INSERT INTO market_cross_refs (source_market_id, target_platform, target_platform_id, source_field)
         SELECT m.id,
                'polymarket',
                cid,
                'polymarketConditionIds'
         FROM markets m
         JOIN market_metadata_raw mr ON mr.market_id = m.id
         CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(mr.raw->'polymarketConditionIds', '[]'::jsonb)) cid
         WHERE m.platform = 'predict'
           AND cid IS NOT NULL AND cid <> ''
         ON CONFLICT DO NOTHING
         RETURNING 1
       )
       SELECT COUNT(*)::text n FROM ins`
    );

    const resolved = await query<{ n: string }>(
      `WITH upd AS (
         UPDATE market_cross_refs r
         SET target_market_id = tm.id
         FROM markets tm
         WHERE r.target_market_id IS NULL
           AND tm.platform = r.target_platform
           AND tm.platform_id = r.target_platform_id
         RETURNING 1
       )
       SELECT COUNT(*)::text n FROM upd`
    );

    const extracted = Number(predictToPoly[0].n);
    const resolvedN = Number(resolved[0].n);
    log.info(
      `cross-refs: ${extracted} new links extracted ` +
      `(predict→poly ${predictToPoly[0].n}); ` +
      `${resolvedN} resolved to target_market_id`
    );
    return { extracted, resolved: resolvedN };
  } catch (err) {
    log.error('cross-refs extraction failed:', err);
    return { extracted: 0, resolved: 0 };
  }
}

// Allow running standalone
if (process.argv[1]?.endsWith('sync.ts') || process.argv[1]?.endsWith('sync.js')) {
  runSync()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('sync error:', err);
      process.exit(1);
    });
}
