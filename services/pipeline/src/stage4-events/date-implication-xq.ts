// Cross-question DATE-IMPLICATION edge rule: "happens BY D1 ⟹ happens BY D2" when D1 < D2, for
// TERMINAL once-true cumulative events. Sound only for terminal-once-true/cumulative-by-date
// events — false for reassignable-slot and snapshot/during-window framings. Relates DIFFERENT
// deadlines on the SAME latch, so it requires a.date < b.date instead of date-equality.
import { createLogger } from '@arb/logger';
import { snapshotShapesSql } from '../util/condition-shape.js';
import { strictlyEarlierAtCoarserGrainSql } from '../util/date-grain-sql.js';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  foldedTextSql,
  foldedTextEqSql,
} from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-date-implication-xq');

// Kept tiny on purpose — under-match. 'participation' must never join this tuple bare: it is
// admitted only through the ': debut date' canonical_event anchor (dateImplicationKindGateSql).
export const DATE_IMPLICATION_KINDS_SQL = `('token_launch')`;

export const DATE_IMPLICATION_DEBUT_EVENT_SUFFIX = ': debut date';

// Kinds whose rows are daily observations, not cumulative latches — a "by D1 implies by D2"
// chain across dates is flatly false for these. Belt-and-braces with the allowlist above.
export const DATE_IMPLICATION_REFUSED_KINDS_SQL =
  `('weather_observation','weather_threshold','daily_observation','candle_direction','price_snapshot','price_range_snapshot')`;

// Applied to side `a` only — event_kind + canonical_event equality (already in the join) propagate it to `b`.
export function dateImplicationKindGateSql(alias: string): string {
  return `((${alias}.event_kind IN ${DATE_IMPLICATION_KINDS_SQL}
            OR (${alias}.event_kind = 'participation'
                AND ${foldedTextSql(`${alias}.canonical_event`)} LIKE '%${DATE_IMPLICATION_DEBUT_EVENT_SUFFIX}'))
           AND (${alias}.event_kind IS NULL
                OR ${alias}.event_kind NOT IN ${DATE_IMPLICATION_REFUSED_KINDS_SQL}))`;
}

// Applied to both sides (condition_shape is not propagated by the join's kind equality).
export function dateImplicationSnapshotRefusalSql(alias: string): string {
  return `(${alias}.condition_shape IS NULL
           OR ${alias}.condition_shape NOT IN ${snapshotShapesSql()})`;
}

export function buildDateImplicationXqEdgesSql(): string {
  return `
    WITH ${nodeFactsCte()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id, ${edgeContractSql('strict_implication', 'date_implication')},
             'date implication: by D1 ⟹ by D2 (terminal monotonic event)'
      FROM node_facts a
      JOIN node_facts b
        ON ${foldedTextEqSql('a.canonical_event', 'b.canonical_event')}
       AND ${foldedTextSql('a.canonical_event')} IS NOT NULL
       AND a.event_kind = b.event_kind
       AND ${dateImplicationKindGateSql('a')}
       AND ${dateImplicationSnapshotRefusalSql('a')}
       AND ${dateImplicationSnapshotRefusalSql('b')}
       AND a.canonical_subject IS NOT DISTINCT FROM b.canonical_subject
       AND a.condition_metric  IS NOT DISTINCT FROM b.condition_metric
       AND a.value_primary     IS NOT DISTINCT FROM b.value_primary
       AND a.value_unit        IS NOT DISTINCT FROM b.value_unit
      -- questions.condition_date, not node_facts.condition_date: the latter is shared across
      -- deadlines for token-launch ladders grouped under one platform_event.
      JOIN questions qa ON qa.id = a.question_id AND qa.temporal_semantics = 'by_date'
      JOIN questions qb ON qb.id = b.question_id AND qb.temporal_semantics = 'by_date'
      WHERE qa.condition_date IS NOT NULL AND qb.condition_date IS NOT NULL
        AND ${strictlyEarlierAtCoarserGrainSql('qa.condition_date', 'qa.condition_date_precision', 'qb.condition_date', 'qb.condition_date_precision')}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildDateImplicationXqEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildDateImplicationXqEdgesSql());
  log.info('date-implication-xq: ' + n + ' edges');
  return n;
}
