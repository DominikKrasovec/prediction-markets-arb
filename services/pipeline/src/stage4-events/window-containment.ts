// window-containment — calendar-window containment implication edges (Stage 4).
// "touch >=X_a during W_a" implies "touch >=X_b during W_b" when W_a is
// strictly calendar-contained in W_b, X_a >= X_b, same subject+kind, both legs
// monotonic_threshold/above/during_period. Below arms and range consequents
// are excluded (v1: the orientation reverses for below, and a range is an
// interior bucket). Ties accepted same-platform only; cross-platform needs strict dominance.
import { createLogger } from '@arb/logger';
import { strictlyContainedInCoarserWindowSql } from '../util/date-grain-sql.js';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  bothKnownDifferSql,
  unitsCompatibleSql,
} from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-window-containment');

// Wrong-grain consequent belt: a year-grain consequent whose title names a
// calendar month claims a window it doesn't cover. Full month names only.
export const MONTH_NAME_TITLE_RX =
  `\\m(january|february|march|april|may|june|july|august|september|october|november|december)\\M`;

// Sub-period title belt: a week/quarter window stamped at coarser grain can cross the containment boundary.
export const SUB_PERIOD_TITLE_RX =
  `\\m(week|weekend) of\\M|\\mthis week(end)?\\M|\\mq[1-4]\\M`;

// Per-question resolution_source: unanimous-known aggregation over member
// normalizations (conflicting/absent -> NULL). Reasoning marker only, never a gate.
export function questionResolutionSourceCte(): string {
  return `question_resolution_source AS (
    SELECT qm.question_id,
           CASE WHEN count(DISTINCT nz.resolution_source) = 1
                THEN min(nz.resolution_source) END AS resolution_source
    FROM question_members qm
    JOIN llm_market_normalizations nz ON nz.market_id = qm.market_id
    WHERE nz.resolution_source IS NOT NULL
    GROUP BY qm.question_id
  )`;
}

export function buildWindowContainmentEdgesSql(): string {
  return `
    WITH ${nodeFactsCte()},
    ${questionResolutionSourceCte()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'window_containment')},
             'window containment: touch >=X during W1 implies touch >=X'' during W2 (calendar W1 strictly inside W2; monotone latch, above arms)'
             || CASE WHEN ra.resolution_source IS NOT NULL AND rb.resolution_source IS NOT NULL
                      AND ra.resolution_source IS DISTINCT FROM rb.resolution_source
                     THEN ' [cross-source: ' || ra.resolution_source || ' != ' || rb.resolution_source || ']'
                     ELSE '' END
      FROM node_facts a
      JOIN node_facts b
        ON a.canonical_subject = b.canonical_subject
       AND a.canonical_subject IS NOT NULL
       AND a.question_id <> b.question_id
       AND a.event_kind = b.event_kind
       AND ${bothKnownDifferSql('a.condition_metric', 'b.condition_metric')}
       AND ${unitsCompatibleSql('a.value_unit', 'b.value_unit')}
       AND a.condition_shape = 'monotonic_threshold'
       AND b.condition_shape = 'monotonic_threshold'
       AND a.condition_direction = 'above'
       AND b.condition_direction = 'above'
       AND a.value_primary IS NOT NULL
       AND b.value_primary IS NOT NULL
       -- value dominance: ties OK same-platform, strict cross-platform
       AND (
         CASE WHEN a.platform IS DISTINCT FROM b.platform
              THEN a.value_primary::numeric >  b.value_primary::numeric
              ELSE a.value_primary::numeric >= b.value_primary::numeric END
       )
      JOIN questions qa ON qa.id = a.question_id AND qa.temporal_semantics = 'during_period'
      JOIN questions qb ON qb.id = b.question_id AND qb.temporal_semantics = 'during_period'
      LEFT JOIN question_resolution_source ra ON ra.question_id = a.question_id
      LEFT JOIN question_resolution_source rb ON rb.question_id = b.question_id
      WHERE qa.condition_date IS NOT NULL AND qb.condition_date IS NOT NULL
        AND qa.condition_date_precision IN ('month','year')
        AND qb.condition_date_precision IN ('month','year')
        AND ${strictlyContainedInCoarserWindowSql('qa.condition_date', 'qa.condition_date_precision', 'qb.condition_date', 'qb.condition_date_precision')}
        AND NOT (
          qb.condition_date_precision = 'year'
          AND lower(immutable_unaccent(b.title)) ~ '${MONTH_NAME_TITLE_RX}'
        )
        AND lower(immutable_unaccent(a.title)) !~ '${SUB_PERIOD_TITLE_RX}'
        AND lower(immutable_unaccent(b.title)) !~ '${SUB_PERIOD_TITLE_RX}'
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildWindowContainmentEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildWindowContainmentEdgesSql());
  log.info('window-containment: ' + n + ' edges');
  return n;
}
