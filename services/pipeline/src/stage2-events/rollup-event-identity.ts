/**
 * Stage 2a — deterministic identity roll-up onto platform_events (no LLM).
 * Rolls children's category/resolution-date up onto the event so Stage 3a
 * candidacy gates at the event grain. Idempotent UPDATEs; safe to re-run.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { extractEventDate, type EventDatePrecision } from '../stage1-normalize/event-date-extractor.js';

const log = createLogger('stage2a-rollup');

export interface RollupResult {
  categorized: number;
  eventKinded: number;
  scopedFromChildren: number;
  datedFromNorm: number;
  datedFromNative: number;
}

const PRECISION_RANK: Record<EventDatePrecision, number> = {
  minute: 0, hour: 1, day: 2, month: 3, year: 4,
};

/** Event kinds whose condition_date is routinely just end_date padding, not a real event date (fixture kinds are excluded — their end_date IS the game date). */
export const OPEN_ENDED_RACE_KINDS: readonly string[] = [
  'personnel_move',
  'participation',
  'award_winner',
  'championship_winner',
];

/** Pure mirror of the Phase-2 SQL demotion CASE: demotes a day-precision open-ended-race date to 'year' when it's majority end_date padding, so the date gate doesn't force a false day-precise match. */
export function demotePaddedDatePrecision(
  eventKind: string | null,
  modalPrecision: string | null,
  paddingMajority: boolean,
): string | null {
  if (
    modalPrecision === 'day' &&
    paddingMajority &&
    eventKind !== null &&
    OPEN_ENDED_RACE_KINDS.includes(eventKind)
  ) {
    return 'year';
  }
  return modalPrecision;
}

/** Pure mirror of the Phase-2 SQL CASE arm: demotes a day-precision modal date to 'year' when gateable children span >=2 distinct days (a deadline-ladder, not one true date). */
export function demoteMultiDayModalPrecision(
  modalPrecision: string | null,
  distinctGateableDays: number,
): string | null {
  if (modalPrecision === 'day' && distinctGateableDays >= 2) return 'year';
  return modalPrecision;
}

export async function rollupEventIdentity(): Promise<RollupResult> {
  log.info('Stage 2a: rolling category + resolution-date onto platform_events…');

  const cat = await query<{ n: number }>(
    `WITH agg AS (
       SELECT pe.id AS pe_id,
              mode() WITHIN GROUP (ORDER BY m.category_unified)
                FILTER (WHERE m.category_unified IS NOT NULL) AS category,
              MAX(m.end_date)::date AS deadline
       FROM platform_events pe
       JOIN markets m ON m.platform = pe.platform
                     AND m.platform_event_id = pe.platform_event_id
       GROUP BY pe.id
     )
     UPDATE platform_events pe
        SET category = agg.category,
            deadline = COALESCE(agg.deadline, pe.deadline),
            updated_at = NOW()
       FROM agg
      WHERE pe.id = agg.pe_id
        AND (pe.category IS DISTINCT FROM agg.category
             OR pe.deadline IS DISTINCT FROM COALESCE(agg.deadline, pe.deadline))
     RETURNING 1`,
  );

  const ek = await query<{ n: number }>(
    `WITH agg AS (
       SELECT pe.id AS pe_id,
              mode() WITHIN GROUP (ORDER BY n.event_kind)
                FILTER (WHERE n.event_kind IS NOT NULL) AS event_kind
       FROM platform_events pe
       JOIN markets m ON m.platform = pe.platform
                     AND m.platform_event_id = pe.platform_event_id
       JOIN llm_market_normalizations n ON n.market_id = m.id
       GROUP BY pe.id
     )
     UPDATE platform_events pe
        SET event_kind = agg.event_kind, updated_at = NOW()
       FROM agg
      WHERE pe.id = agg.pe_id
        AND agg.event_kind IS NOT NULL
        AND pe.event_kind IS DISTINCT FROM agg.event_kind
     RETURNING 1`,
  );

  // resolution_scope: exactly one concrete child scope wins; disagreement -> 'unspecified'; none -> NULL.
  const scoped = await query<{ n: number }>(
    `WITH agg AS (
       SELECT pe.id AS pe_id,
              count(DISTINCT m.resolution_scope)
                FILTER (WHERE m.resolution_scope IS NOT NULL
                          AND m.resolution_scope <> 'unspecified') AS n_concrete,
              max(m.resolution_scope)
                FILTER (WHERE m.resolution_scope IS NOT NULL
                          AND m.resolution_scope <> 'unspecified') AS any_concrete
       FROM platform_events pe
       JOIN markets m ON m.platform = pe.platform
                     AND m.platform_event_id = pe.platform_event_id
       GROUP BY pe.id
     ),
     rolled AS (
       SELECT pe_id,
              CASE WHEN n_concrete = 1 THEN any_concrete
                   WHEN n_concrete > 1 THEN 'unspecified'
                   ELSE NULL END AS scope
       FROM agg
     )
     UPDATE platform_events pe
        SET resolution_scope = rolled.scope, updated_at = NOW()
       FROM rolled
      WHERE pe.id = rolled.pe_id
        AND rolled.scope IS NOT NULL
        AND pe.resolution_scope IS DISTINCT FROM rolled.scope
     RETURNING 1`,
  );

  // Padding demotion: a day-precision open-ended-race date that's majority end_date padding demotes to 'year' (mirrors demotePaddedDatePrecision).
  const fromNorm = await query<{ n: number }>(
    `WITH cd AS (
       SELECT pe.id AS pe_id, n.condition_date AS cond, n.condition_date_precision AS prec,
              CASE WHEN n.condition_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                    AND m.end_date IS NOT NULL
                   THEN ABS(n.condition_date::date - m.end_date::date) <= 1
                   ELSE FALSE
              END AS is_pad
       FROM platform_events pe
       JOIN markets m ON m.platform = pe.platform
                     AND m.platform_event_id = pe.platform_event_id
       JOIN llm_market_normalizations n ON n.market_id = m.id
       WHERE n.condition_date_precision IS NOT NULL
     ),
     agg AS (
       SELECT pe_id,
              mode() WITHIN GROUP (ORDER BY prec) AS prec,
              (mode() WITHIN GROUP (ORDER BY cond)
                 FILTER (WHERE prec IN ('minute','hour','day')
                         AND cond ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'))::timestamptz AS cond,
              (COUNT(*) FILTER (WHERE is_pad)) * 2 > COUNT(*) AS pad_major,
              COUNT(DISTINCT substring(cond FROM 1 FOR 10))
                FILTER (WHERE prec IN ('minute','hour','day')
                        AND cond ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS n_days
       FROM cd GROUP BY pe_id
     )
     UPDATE platform_events pe
        SET condition_date_precision = CASE
              WHEN pe.event_kind = ANY($1::text[])
                   AND agg.prec = 'day'
                   AND agg.pad_major
              THEN 'year'
              -- multi-day modal demotion (mirrors demoteMultiDayModalPrecision)
              WHEN agg.prec = 'day' AND agg.n_days >= 2
              THEN 'year'
              ELSE agg.prec
            END,
            condition_date = agg.cond,
            updated_at = NOW()
       FROM agg
      WHERE pe.id = agg.pe_id
     RETURNING 1`,
    [OPEN_ENDED_RACE_KINDS],
  );

  // Phase 3: native-field extraction for events still without a timestamp (template-miss events).
  const children = await query<{
    pe_id: number; platform: string; platform_id: string;
    title: string; slug: string | null; end_date: string | null;
  }>(
    `SELECT pe.id AS pe_id, m.platform, m.platform_id, m.title, m.slug,
            m.end_date::text AS end_date
       FROM platform_events pe
       JOIN markets m ON m.platform = pe.platform
                     AND m.platform_event_id = pe.platform_event_id
      WHERE pe.condition_date IS NULL
        AND pe.condition_date_precision IS NULL
      ORDER BY pe.id`,
  );

  type Tally = { iso: string; precision: EventDatePrecision; count: number };
  const byEvent = new Map<number, Map<string, Tally>>();
  for (const c of children) {
    const ed = extractEventDate({
      platform: c.platform, platform_id: c.platform_id,
      title: c.title, slug: c.slug, end_date: c.end_date,
    });
    if (!ed || ed.source === 'end_date') continue; // end_date is unreliable padding
    let tallies = byEvent.get(c.pe_id);
    if (!tallies) { tallies = new Map(); byEvent.set(c.pe_id, tallies); }
    const t = tallies.get(ed.iso);
    if (t) t.count++;
    else tallies.set(ed.iso, { iso: ed.iso, precision: ed.precision, count: 1 });
  }

  const updates: { pe_id: number; iso: string; precision: EventDatePrecision }[] = [];
  for (const [peId, tallies] of byEvent) {
    let best: Tally | null = null;
    const gateableDays = new Set<string>();
    for (const t of tallies.values()) {
      if (!best || t.count > best.count ||
          (t.count === best.count && PRECISION_RANK[t.precision] < PRECISION_RANK[best.precision])) {
        best = t;
      }
      if ((t.precision === 'minute' || t.precision === 'hour' || t.precision === 'day') &&
          /^\d{4}-\d{2}-\d{2}/.test(t.iso)) {
        gateableDays.add(t.iso.slice(0, 10));
      }
    }
    if (best) {
      const precision = demoteMultiDayModalPrecision(best.precision, gateableDays.size) as EventDatePrecision;
      updates.push({ pe_id: peId, iso: best.iso, precision });
    }
  }

  const BATCH = 500;
  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((u, j) => {
      const base = j * 3;
      values.push(`($${base + 1}::int, $${base + 2}::timestamptz, $${base + 3}::text)`);
      // Only minute/hour/day ISO is a parseable timestamptz; coarser precisions store precision only.
      const gateable =
        (u.precision === 'minute' || u.precision === 'hour' || u.precision === 'day') &&
        /^\d{4}-\d{2}-\d{2}/.test(u.iso);
      params.push(u.pe_id, gateable ? u.iso : null, u.precision);
    });
    await query(
      `UPDATE platform_events pe
          SET condition_date = v.cond, condition_date_precision = v.prec, updated_at = NOW()
         FROM (VALUES ${values.join(',')}) AS v(pe_id, cond, prec)
        WHERE pe.id = v.pe_id`,
      params,
    );
  }

  const result: RollupResult = {
    categorized: cat.length,
    eventKinded: ek.length,
    scopedFromChildren: scoped.length,
    datedFromNorm: fromNorm.length,
    datedFromNative: updates.length,
  };
  log.info(
    `Stage 2a roll-up: category/deadline on ${result.categorized} events, ` +
    `event_kind on ${result.eventKinded}, ` +
    `resolution_scope on ${result.scopedFromChildren}, ` +
    `condition_date from normalizations on ${result.datedFromNorm}, ` +
    `from native fields on ${result.datedFromNative}.`,
  );
  return result;
}
