// Strike chain edges for the kalshi:price-ladder family: within one Kalshi
// strike-ladder (one published reading), "above X" implies "above Y" for
// X > Y, and the below mirror. Separate builder because this family's
// identity lives in match_source, which node_facts (numeric-ladder-xq) does
// not expose.
import { createLogger } from '@arb/logger';
import { EDGE_INSERT_COLUMNS_SQL, EDGE_CONFLICT_SQL, edgeContractSql } from '../util/sql-fragments.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-kalshi-strike-ladder');

// Pure-TS reference implementations (mirror the SQL 1:1 for unit tests).

// direction 'above': bigger strike is stricter; 'below': smaller is stricter.
export function strikeImplies(
  direction: 'above' | 'below' | string | null | undefined,
  antecedentStrike: number | null | undefined,
  consequentStrike: number | null | undefined,
): boolean {
  if (antecedentStrike == null || consequentStrike == null) return false;
  if (direction === 'above') return antecedentStrike > consequentStrike;
  if (direction === 'below') return antecedentStrike < consequentStrike;
  return false;
}

export const STRIKE_LADDER_SHAPES_SQL = `('monotonic_threshold','point_in_time')`;

export function kalshiStrikeRungsCtesSql(): string {
  return `strike_rows AS (
      SELECT
        qm.question_id,
        lower(immutable_unaccent(btrim(coalesce(n.canonical_event, ''))))   AS ev_key,
        lower(immutable_unaccent(btrim(coalesce(n.canonical_subject, '')))) AS subj_key,
        coalesce(n.condition_date, '')                                      AS d,
        n.condition_direction                                               AS dir,
        coalesce(lower(btrim(n.value_unit)), '')                            AS unit_key,
        coalesce(lower(btrim(n.condition_metric)), '')                      AS metric_key,
        n.value_primary::numeric                                            AS strike
      FROM llm_market_normalizations n
      JOIN question_members qm ON qm.market_id = n.market_id
      JOIN questions q ON q.id = qm.question_id AND q.archived_at IS NULL
      WHERE n.match_source = 'kalshi:price-ladder'
        AND (n.event_kind IS NULL OR n.event_kind IN ('econ_indicator_threshold','count_threshold'))
        AND (q.event_kind IS NULL OR q.event_kind IN ('econ_indicator_threshold','count_threshold'))
        AND n.condition_shape IN ${STRIKE_LADDER_SHAPES_SQL}
        AND n.value_secondary IS NULL
        AND n.condition_direction IN ('above','below')
        AND n.value_primary IS NOT NULL
    ),
    -- a question whose price-ladder members disagree on any reading field is
    -- rungs fused upstream -> no edges at all
    bad_questions AS (
      SELECT question_id FROM strike_rows
      GROUP BY question_id
      HAVING count(DISTINCT (ev_key, subj_key, d, dir, unit_key, metric_key, strike)) > 1
    ),
    node_rungs AS (
      SELECT ev_key, subj_key, d, dir, unit_key, metric_key, question_id,
             min(strike) AS strike
      FROM strike_rows
      WHERE question_id NOT IN (SELECT question_id FROM bad_questions)
      GROUP BY 1, 2, 3, 4, 5, 6, 7
    ),
    -- rank 1 = strictest rung (above: highest strike, so sign-flipped in ORDER BY; below: lowest)
    ranked AS (
      SELECT *,
        dense_rank() OVER (
          PARTITION BY ev_key, subj_key, d, dir, unit_key, metric_key
          ORDER BY CASE WHEN dir = 'above' THEN -strike ELSE strike END
        ) AS rk
      FROM node_rungs
    ),
    chain_pairs AS (
      SELECT a.question_id AS antecedent_question_id,
             b.question_id AS consequent_question_id,
             a.dir, a.strike AS s_strict, b.strike AS s_loose
      FROM ranked a
      JOIN ranked b
        ON b.ev_key     = a.ev_key
       AND b.subj_key   = a.subj_key
       AND b.d          = a.d
       AND b.dir        = a.dir
       AND b.unit_key   = a.unit_key
       AND b.metric_key = a.metric_key
       AND b.rk = a.rk + 1
       AND b.question_id <> a.question_id
       AND b.strike <> a.strike
    )`;
}

export function buildKalshiStrikeLadderEdgesSql(): string {
  return `
    WITH ${kalshiStrikeRungsCtesSql()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT antecedent_question_id, consequent_question_id,
             ${edgeContractSql('strict_implication', 'kalshi_strike_ladder')},
             'kalshi strike ladder: one published reading per family, so the stricter adjacent strike implies the looser (above-X ⟹ above-Y for X>Y; below mirrored)'
      FROM chain_pairs
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildKalshiStrikeLadderEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildKalshiStrikeLadderEdgesSql());
  log.info('kalshi-strike-ladder: ' + n + ' edges');
  return n;
}
