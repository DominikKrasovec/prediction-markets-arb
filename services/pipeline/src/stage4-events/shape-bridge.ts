/**
 * shape-bridge — snapshot ⟹ touch cross-shape implication edges (Stage 4). A
 * point-in-time/range snapshot bound at T implies a same-day monotonic-threshold
 * touch of any dominated bound (reverse never emitted — a spike can touch K and
 * close anywhere). Cross-platform pairs need a 0.5% cross-oracle margin and a
 * known-compatible settlement_instrument; same-platform pairs use strict bound
 * dominance and share a feed by construction. Edge: strict_implication/shape_bridge.
 */
import { createLogger } from '@arb/logger';
import { query } from '@arb/db';
import { beltHit } from '../discriminators/telemetry.js';
import { snapshotShapesSql } from '../util/condition-shape.js';
import { FUTURES_UNPINNED } from '../util/settlement-instrument.js';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  bothKnownDifferSql,
} from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-shape-bridge');

/** Relative margin a CROSS-PLATFORM (cross-oracle) bound must clear. */
export const CROSS_ORACLE_MARGIN = 0.005;

/** Instrument pairs (beyond plain string equality) compatible cross-platform.
 *  Everything else: equal strings only; NULL or FUTURES_UNPINNED on either side is never compatible. */
export const COMPATIBLE_INSTRUMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['cf-benchmarks', 'binance'],
];

const COMPATIBLE_PAIRS_SQL = `(${COMPATIBLE_INSTRUMENT_PAIRS.flatMap(([x, y]) => [
  `('${x}','${y}')`,
  `('${y}','${x}')`,
]).join(',')})`;

/** Per-question settlement_instrument: unanimous-known aggregation over member
 *  normalizations (conflicting known members → NULL, unknown). */
function questionSettlementInstrumentCte(): string {
  return `question_settlement_instrument AS (
    SELECT qm.question_id,
           CASE WHEN count(DISTINCT nz.settlement_instrument) = 1
                THEN min(nz.settlement_instrument) END AS settlement_instrument
    FROM question_members qm
    JOIN llm_market_normalizations nz ON nz.market_id = qm.market_id
    WHERE nz.settlement_instrument IS NOT NULL
    GROUP BY qm.question_id
  )`;
}

export function buildShapeBridgeEdgesSql(): string {
  return `
    WITH ${nodeFactsCte()},
    ${questionSettlementInstrumentCte()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'shape_bridge')},
             'shape bridge: snapshot bound at T implies same-day touch of the dominated bound (snapshot ⟹ touch only)'
      FROM node_facts a
      JOIN node_facts b
        ON a.canonical_subject = b.canonical_subject
       AND a.canonical_subject IS NOT NULL
       AND a.question_id <> b.question_id
       AND a.event_kind = 'price_threshold'
       AND b.event_kind = 'price_threshold'
       AND ${bothKnownDifferSql('a.condition_metric', 'b.condition_metric')}
       AND NOT (a.value_unit IS NOT NULL AND b.value_unit IS NOT NULL
                AND lower(a.value_unit) IS DISTINCT FROM lower(b.value_unit))
       AND a.condition_shape IN ${snapshotShapesSql()}
       AND b.condition_shape = 'monotonic_threshold'
       AND a.value_primary IS NOT NULL
       AND b.value_primary IS NOT NULL
       AND b.condition_direction IN ('above','below')
       AND a.condition_date IS NOT NULL AND b.condition_date IS NOT NULL
       AND a.condition_date_precision IN ('minute','hour','day')
       AND (a.condition_date AT TIME ZONE 'UTC')::date = (b.condition_date AT TIME ZONE 'UTC')::date
       AND b.condition_date_precision = 'day'
       AND b.title !~* '\\mat \\d{1,2}(:\\d{2})?\\s*(a\\.?m\\.?|p\\.?m\\.?|noon)\\M|\\d{1,2}(:\\d{2})?\\s*(a\\.?m\\.?|p\\.?m\\.?)?\\s*(et|edt|est|utc)\\M'
       -- et_date >= utc_date holds iff the moment is at/after ET midnight of that UTC day
       AND (
         a.condition_date_precision = 'day'
         OR (a.condition_date AT TIME ZONE 'America/New_York')::date
            >= (a.condition_date AT TIME ZONE 'UTC')::date
       )
       -- refuses week/period-anchored day stamps ("finish week of May 11" stamps the
       -- Monday, resolves Friday) unless Stage 1 re-anchored to the real resolution moment
       AND NOT (
         a.condition_date_precision = 'day'
         AND a.title ~* '\\m(week|month) of\\M|\\mfinish (the )?(week|month)\\M|\\mthis week\\M'
         AND a.title !~* '\\mweek of\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}'
       )
       -- cross-platform dominance requires the CROSS_ORACLE_MARGIN; same-platform is strict (folded strike ties are unsafe)
       AND (
         CASE
           WHEN b.condition_direction = 'above' THEN
             CASE
               WHEN a.condition_direction = 'above' THEN
                 CASE WHEN a.platform IS DISTINCT FROM b.platform
                      THEN a.value_primary::numeric >= b.value_primary::numeric * (1 + ${CROSS_ORACLE_MARGIN})
                      ELSE a.value_primary::numeric >  b.value_primary::numeric END
               WHEN a.condition_direction = 'between' AND a.value_secondary IS NOT NULL THEN
                 CASE WHEN a.platform IS DISTINCT FROM b.platform
                      THEN LEAST(a.value_primary::numeric, a.value_secondary::numeric) >= b.value_primary::numeric * (1 + ${CROSS_ORACLE_MARGIN})
                      ELSE LEAST(a.value_primary::numeric, a.value_secondary::numeric) >  b.value_primary::numeric END
               ELSE FALSE
             END
           WHEN b.condition_direction = 'below' THEN
             CASE
               WHEN a.condition_direction = 'below' THEN
                 CASE WHEN a.platform IS DISTINCT FROM b.platform
                      THEN a.value_primary::numeric <= b.value_primary::numeric * (1 - ${CROSS_ORACLE_MARGIN})
                      ELSE a.value_primary::numeric <  b.value_primary::numeric END
               WHEN a.condition_direction = 'between' AND a.value_secondary IS NOT NULL THEN
                 CASE WHEN a.platform IS DISTINCT FROM b.platform
                      THEN GREATEST(a.value_primary::numeric, a.value_secondary::numeric) <= b.value_primary::numeric * (1 - ${CROSS_ORACLE_MARGIN})
                      ELSE GREATEST(a.value_primary::numeric, a.value_secondary::numeric) <  b.value_primary::numeric END
               ELSE FALSE
             END
           ELSE FALSE
         END
       )
      JOIN questions qb
        ON qb.id = b.question_id
       AND qb.temporal_semantics IN ('by_date','on_date','during_period')
      LEFT JOIN question_settlement_instrument ia ON ia.question_id = a.question_id
      LEFT JOIN question_settlement_instrument ib ON ib.question_id = b.question_id
      WHERE (
        a.platform IS NOT DISTINCT FROM b.platform
        OR (
          ia.settlement_instrument IS NOT NULL
          AND ib.settlement_instrument IS NOT NULL
          AND ia.settlement_instrument <> '${FUTURES_UNPINNED}'
          AND ib.settlement_instrument <> '${FUTURES_UNPINNED}'
          AND (
            ia.settlement_instrument = ib.settlement_instrument
            OR (ia.settlement_instrument, ib.settlement_instrument) IN ${COMPATIBLE_PAIRS_SQL}
          )
        )
      )
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

/** Diagnostic count for belt.shape_bridge_anchor_refuse; mirrors the period-anchor rule. */
export function shapeBridgeAnchorRefuseSql(): string {
  return `
    WITH ${nodeFactsCte()}
    SELECT count(*)::int AS n FROM node_facts a
    WHERE a.event_kind = 'price_threshold'
      AND a.condition_shape IN ${snapshotShapesSql()}
      AND a.condition_date_precision = 'day'
      AND a.title ~* '\\m(week|month) of\\M|\\mfinish (the )?(week|month)\\M|\\mthis week\\M'
      AND a.title !~* '\\mweek of\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}'`;
}

export async function buildShapeBridgeEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildShapeBridgeEdgesSql());
  log.info('shape-bridge: ' + n + ' edges');
  try {
    const rows = await query<{ n: number }>(shapeBridgeAnchorRefuseSql());
    const refused = rows[0]?.n ?? 0;
    for (let i = 0; i < refused; i++) beltHit('shape_bridge_anchor_refuse');
    log.info('shape-bridge anchor-refuse residue: ' + refused);
  } catch (e) {
    log.warn('shape-bridge anchor-refuse census skipped: ' + (e as Error).message);
  }
  return n;
}
