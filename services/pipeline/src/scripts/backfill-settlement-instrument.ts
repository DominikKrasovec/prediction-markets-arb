/**
 * backfill-settlement-instrument — stamps llm_market_normalizations.settlement_instrument for
 * price_threshold and candle_direction rows (see STAMPED_KINDS) from market_metadata_raw.
 * IDEMPOTENT: recomputes from raw every pass and writes only rows whose value differs.
 * Usage: bun run services/pipeline/src/scripts/backfill-settlement-instrument.ts
 */
import { query, endPool } from '@arb/db';
import {
  extractSettlementInstrument,
  extractCandleSettlement,
  extractSettlementDimension,
} from '../util/settlement-instrument.js';
import { createLogger } from '@arb/logger';

const log = createLogger('backfill-settlement-instrument');
const BATCH = 1000;

// Both vocabularies share this column but never collide: candle tokens always contain a
// '|tie:' segment, level instruments never do.
const STAMPED_KINDS = ['price_threshold', 'candle_direction'] as const;

// Third vocabulary in this column ('motorsport:*'), stamped kind-independently: the class it
// was written for is mostly unshaped, so the gate is the extraction itself, not event_kind.
const DIMENSION_PREFILTER_SQL = `(
     mr.raw->>'description'   ILIKE '%constructor%'
  OR mr.raw->>'rules_primary' ILIKE '%constructor%'
  OR mr.raw->>'description'   ILIKE '%main race%'
  OR mr.raw->>'rules_primary' ILIKE '%main race%'
)`;

function extractForKind(eventKind: string | null, platform: string, raw: unknown): string | null {
  if (eventKind === 'candle_direction') return extractCandleSettlement(platform, raw);
  if (eventKind === 'price_threshold') return extractSettlementInstrument(platform, raw);
  return extractSettlementDimension(platform, raw);
}

// Gates on created_at (keyset-paginated), not `settlement_instrument IS NULL` (some rows
// extract to a genuine NULL); a periodic full reconciliation re-checks changed raw.
const SETTLEMENT_INCREMENTAL = process.env.SETTLEMENT_BACKFILL_INCREMENTAL !== '0';
const SETTLEMENT_RECONCILE_MS = parseInt(process.env.SETTLEMENT_BACKFILL_RECONCILE_MS ?? String(6 * 60 * 60 * 1000), 10);
const SETTLEMENT_EPOCH_ISO = '1970-01-01T00:00:00.000Z';
const settlementWm = { sinceIso: SETTLEMENT_EPOCH_ISO, lastFullMs: 0 };

interface Row {
  market_id: number;
  platform: string;
  raw: unknown;
  current: string | null;
  event_kind: string | null;
  // TEXT, not Date: node-pg truncates timestamptz to millisecond precision, which would make
  // the keyset cursor re-match every row sharing the truncated ms.
  created_at: string;
}

export async function backfillSettlementInstrument(opts?: { forceFull?: boolean }): Promise<{ scanned: number; updated: number }> {
  const nowMs = Date.now();
  const full = opts?.forceFull === true || !SETTLEMENT_INCREMENTAL || nowMs - settlementWm.lastFullMs >= SETTLEMENT_RECONCILE_MS;
  const floorIso = full ? SETTLEMENT_EPOCH_ISO : settlementWm.sinceIso;
  const advanceIso = new Date().toISOString();

  let afterCreated: string = floorIso;
  let afterId = 0;
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const rows: Row[] = await query<Row>(
      `SELECT n.market_id, m.platform, mr.raw, n.settlement_instrument AS current,
              n.event_kind, n.created_at::text AS created_at
       FROM llm_market_normalizations n
       JOIN markets m              ON m.id = n.market_id
       JOIN market_metadata_raw mr ON mr.market_id = n.market_id
       WHERE (n.event_kind = ANY($4::text[]) OR ${DIMENSION_PREFILTER_SQL})
         AND (n.created_at, n.market_id) > ($1::timestamptz, $2::int)
       ORDER BY n.created_at, n.market_id
       LIMIT $3`,
      [afterCreated, afterId, BATCH, STAMPED_KINDS as unknown as string[]],
    );
    if (rows.length === 0) break;
    afterCreated = rows[rows.length - 1].created_at;
    afterId = rows[rows.length - 1].market_id;
    scanned += rows.length;

    const changed: Array<{ id: number; si: string | null }> = [];
    for (const r of rows) {
      const si = extractForKind(r.event_kind, r.platform, r.raw);
      if (si !== r.current) changed.push({ id: r.market_id, si });
    }
    if (changed.length > 0) {
      const params: Array<number | string | null> = [];
      const values = changed
        .map((c, i) => {
          params.push(c.id, c.si);
          return `($${i * 2 + 1}::int, $${i * 2 + 2}::text)`;
        })
        .join(',');
      await query(
        `UPDATE llm_market_normalizations n
         SET settlement_instrument = v.si
         FROM (VALUES ${values}) AS v(market_id, si)
         WHERE n.market_id = v.market_id`,
        params,
      );
      updated += changed.length;
    }
  }

  settlementWm.sinceIso = advanceIso;
  if (full) settlementWm.lastFullMs = nowMs;

  log.info(`scanned ${scanned} settlement-fact rows; updated ${updated} (${full ? 'FULL' : `incr since ${floorIso}`})`);
  return { scanned, updated };
}

async function reportCounts(): Promise<void> {

  const counts = await query<{ event_kind: string; platform: string; instrument: string; markets: number }>(
    `SELECT COALESCE(n.event_kind, '(null)') AS event_kind, m.platform,
            COALESCE(n.settlement_instrument, '(null)') AS instrument,
            count(*)::int AS markets
     FROM llm_market_normalizations n
     JOIN markets m ON m.id = n.market_id
     WHERE n.event_kind = ANY($1::text[]) OR n.settlement_instrument LIKE 'motorsport:%'
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 4 DESC`,
    [STAMPED_KINDS as unknown as string[]],
  );
  console.log('\nper-(event_kind, platform, instrument) counts:');
  console.table(counts);

  const stray = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM llm_market_normalizations
     WHERE settlement_instrument IS NOT NULL
       AND settlement_instrument NOT LIKE 'motorsport:%'
       AND (event_kind IS NULL OR NOT (event_kind = ANY($1::text[])))`,
    [STAMPED_KINDS as unknown as string[]],
  );
  console.log(`non-dimension settlement_instrument outside ${STAMPED_KINDS.join('/')} (must be 0): ${stray[0].n}`);

  const mixed = await query<{
    candle_without_tie: number;
    level_with_tie: number;
    dimension_in_stamped_kind: number;
    dimension_with_tie: number;
  }>(
    `SELECT count(*) FILTER (WHERE event_kind = 'candle_direction'
                               AND settlement_instrument NOT LIKE '%|tie:%')::int AS candle_without_tie,
            count(*) FILTER (WHERE event_kind = 'price_threshold'
                               AND settlement_instrument LIKE '%|tie:%')::int AS level_with_tie,
            count(*) FILTER (WHERE settlement_instrument LIKE 'motorsport:%'
                               AND event_kind = ANY($1::text[]))::int AS dimension_in_stamped_kind,
            count(*) FILTER (WHERE settlement_instrument LIKE 'motorsport:%'
                               AND settlement_instrument LIKE '%|tie:%')::int AS dimension_with_tie
     FROM llm_market_normalizations WHERE settlement_instrument IS NOT NULL`,
    [STAMPED_KINDS as unknown as string[]],
  );
  console.log(`vocabulary separation (all must be 0): ${JSON.stringify(mixed[0])}`);
}

if (import.meta.main) {
  try {
    await backfillSettlementInstrument({ forceFull: true });
    await reportCounts();
  } finally {
    await endPool();
  }
}
