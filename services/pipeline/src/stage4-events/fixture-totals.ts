/**
 * fixture-totals — same-fixture totals-arithmetic edges (Stage 4), five arms sharing
 * one consequent population (match-level O/U "above" totals) and one fixture-identity
 * discipline:
 *   S2 (btts_total_over)       both_teams_score ⟹ goals-total over L, L < 2 (home,away≥1 ⇒ total≥2)
 *   S3 (team_game_total_over)  team total over L_t ⟹ game total over L_g, L_t ≥ L_g (sum dominance)
 *   S4 (spread_total_over)     favorite spread −X ⟹ game total over L_g, X ≥ L_g (spread-winner gates reused)
 *   G1 (fixture_total_ladder)  game total over L_hi ⟹ over L_lo, L_hi > L_lo — cross-set residue only
 *                              (match_total_metric is outside numeric-ladder-xq's allowlist; within-set
 *                              pairs excluded by an explicit not-in-same-outcome-set conjunct)
 *   G5 (slice_game_total_over) first_5/half total over L₁ ⟹ game total over L₂, L₁ ≥ L₂
 * Guards: per-team totals never fuse with match totals (subject ∉ participants); unit
 * gate keyed per-arm (goal-only on S2, plural-fold-equal elsewhere) so corner/card/kill
 * totals never co-key with BTTS; metric_scope + stamped game_ordinal keep sub-game
 * slices apart (G5 instead requires BOTH sides carry no ordinal, to relate a slice to
 * an ambiguous whole); fixtureJoinSql's start-instant veto defeats the Kalshi-UTC vs
 * PM-local-day evening-game seam. Edge: strict_implication, per-arm pattern labels.
 */
import { createLogger } from '@arb/logger';
import { config } from '../config.js';
import { datePrecisionLadderSql, EVENING_DAY_SHIFT_MAX_UTC_HOUR } from '../util/date-grain-sql.js';
import {
  ambiguousEveningRefusalSql,
  fixtureStartInstantSql,
  fixtureStartVetoSql,
} from '../util/fixture-instant.js';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  foldedTextSql,
  bothKnownDifferSql,
} from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';
import { SPREAD_WINNER_UNITS, SPREAD_WINNER_SERIES_RX } from './spread-winner.js';

const log = createLogger('stage4-fixture-totals');

/** S2: the only goal lines BTTS (total ≥ 2) strictly clears are L < 2. */
export function bttsImpliesOverLine(line: number): boolean {
  return line < 2;
}

export const FIXTURE_TOTALS_GOAL_UNITS: ReadonlyArray<string> = ['goal', 'goals'] as const;

export function dominatesLine(antecedentLine: number, consequentLine: number): boolean {
  return antecedentLine >= consequentLine;
}

export function laddersOver(hiLine: number, loLine: number): boolean {
  return hiLine > loLine;
}

/** Match-level total: subject known and NOT a participant (NULL subjects drop). */
export function isMatchLevelTotal(
  subject: string | null | undefined,
  participants: readonly string[] | null | undefined,
): boolean {
  if (subject == null || participants == null) return false;
  return !participants.includes(subject);
}

/** S3 antecedent: metric_scope='team' OR subject ∈ participants at whole-game scope. */
export function isTeamTotal(
  metricScope: string | null | undefined,
  subject: string | null | undefined,
  participants: readonly string[] | null | undefined,
): boolean {
  if (metricScope === 'team') return true;
  return (
    (metricScope == null || metricScope === 'game') &&
    subject != null && participants != null && participants.includes(subject)
  );
}

export const FIXTURE_TOTALS_SLICE_SCOPES: ReadonlyArray<string> = ['first_5', 'half_1', 'half_2'] as const;

export function unitKeysCompatible(a: string, b: string): boolean {
  return a === b || a + 's' === b || a === b + 's';
}

const GOAL_UNITS_SQL = FIXTURE_TOTALS_GOAL_UNITS.map((u) => `'${u}'`).join(',');
const SLICE_SCOPES_SQL = FIXTURE_TOTALS_SLICE_SCOPES.map((s) => `'${s}'`).join(',');
const SPREAD_UNITS_SQL = SPREAD_WINNER_UNITS.map((u) => `'${u}'`).join(',');

function unitKeysCompatibleSql(a: string, b: string): string {
  return `(${a} = ${b} OR ${a} || 's' = ${b} OR ${a} = ${b} || 's')`;
}

/** Trusted fixture start instant (util/fixture-instant.ts): PM kickoff end_date or a
 *  minute-precision condition stamp; NULL otherwise. Plain column for hash-join friendliness. */
const START_AT_SQL = `${fixtureStartInstantSql('node_facts')} AS start_at`;

/** Shared fixture-identity conjuncts between two pre-keyed CTE aliases. */
function fixtureJoinSql(a: string, b: string): string {
  const c = config.pairing;
  return `ON ${b}.ce_key = ${a}.ce_key
       AND ${b}.parts = ${a}.parts
       AND ${b}.ord IS NOT DISTINCT FROM ${a}.ord
       AND ${bothKnownDifferSql(`${a}.resolution_scope`, `${b}.resolution_scope`)}
       AND ${datePrecisionLadderSql(a, b, c.sameEventCryptoToleranceMs, c.sameEventHourToleranceMs, '::timestamptz')}
       AND ${fixtureStartVetoSql(`${a}.start_at`, `${b}.start_at`)}
       AND ${ambiguousEveningRefusalSql(a, b, `${a}.start_at`, `${b}.start_at`, EVENING_DAY_SHIFT_MAX_UTC_HOUR, '::timestamptz')}`;
}

export function buildFixtureTotalsEdgesSql(): string {
  return `
    WITH ${nodeFactsCte()},
    game_total AS MATERIALIZED (
      SELECT question_id, resolution_scope, condition_date, condition_date_precision,
             sport, ${START_AT_SQL},
             condition_metric,
             value_primary::numeric        AS line,
             ${foldedTextSql('canonical_event')} AS ce_key,
             participants                  AS parts,
             (discriminators->>'game_ordinal')::int AS ord,
             lower(btrim(value_unit))      AS unit_key
      FROM node_facts
      WHERE event_kind = 'match_total_metric'
        AND condition_direction = 'above'
        AND value_primary IS NOT NULL
        AND value_secondary IS NULL
        AND value_unit IS NOT NULL
        AND participants IS NOT NULL
        AND NOT (canonical_subject = ANY(participants))
        AND (metric_scope IS NULL OR metric_scope = 'game')
    ),
    btts AS MATERIALIZED (
      SELECT question_id, resolution_scope, condition_date, condition_date_precision,
             sport, ${START_AT_SQL},
             ${foldedTextSql('canonical_event')} AS ce_key,
             participants                  AS parts,
             (discriminators->>'game_ordinal')::int AS ord
      FROM node_facts
      WHERE event_kind = 'both_teams_score'
        AND (metric_scope IS NULL OR metric_scope = 'game')
        AND participants IS NOT NULL
    ),
    team_total AS MATERIALIZED (
      SELECT question_id, resolution_scope, condition_date, condition_date_precision,
             sport, ${START_AT_SQL},
             condition_metric,
             value_primary::numeric        AS line,
             ${foldedTextSql('canonical_event')} AS ce_key,
             participants                  AS parts,
             (discriminators->>'game_ordinal')::int AS ord,
             lower(btrim(value_unit))      AS unit_key
      FROM node_facts
      WHERE event_kind = 'match_total_metric'
        AND condition_direction = 'above'
        AND value_primary IS NOT NULL
        AND value_secondary IS NULL
        AND value_unit IS NOT NULL
        AND participants IS NOT NULL
        AND (metric_scope = 'team'
             OR (canonical_subject = ANY(participants)
                 AND (metric_scope IS NULL OR metric_scope = 'game')))
    ),
    spread AS MATERIALIZED (
      SELECT question_id, resolution_scope, condition_date, condition_date_precision,
             sport, ${START_AT_SQL},
             value_primary::numeric        AS margin,
             ${foldedTextSql('canonical_event')} AS ce_key,
             participants                  AS parts,
             (discriminators->>'game_ordinal')::int AS ord,
             lower(btrim(value_unit))      AS unit_key
      FROM node_facts
      WHERE event_kind = 'match_spread'
        AND condition_direction = 'above'
        AND value_primary IS NOT NULL
        AND value_primary::numeric > 0
        AND value_secondary IS NULL
        AND (metric_scope IS NULL OR metric_scope = 'game')
        AND lower(btrim(value_unit)) IN (${SPREAD_UNITS_SQL})
        AND participants IS NOT NULL
        AND lower(immutable_unaccent(title)) !~ '${SPREAD_WINNER_SERIES_RX}'
        AND ${foldedTextSql('canonical_event')} !~ '${SPREAD_WINNER_SERIES_RX}'
    ),
    slice_total AS MATERIALIZED (
      SELECT question_id, resolution_scope, condition_date, condition_date_precision,
             sport, ${START_AT_SQL},
             condition_metric,
             value_primary::numeric        AS line,
             ${foldedTextSql('canonical_event')} AS ce_key,
             participants                  AS parts,
             (discriminators->>'game_ordinal')::int AS ord,
             lower(btrim(value_unit))      AS unit_key
      FROM node_facts
      WHERE event_kind = 'match_total_metric'
        AND condition_direction = 'above'
        AND value_primary IS NOT NULL
        AND value_secondary IS NULL
        AND value_unit IS NOT NULL
        AND participants IS NOT NULL
        AND NOT (canonical_subject = ANY(participants))
        AND metric_scope IN (${SLICE_SCOPES_SQL})
    ),
    ins_btts AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'btts_total_over')},
             'BTTS ⟹ total over: both teams scoring forces total ≥ 2 > line (goal-unit match-level total, line < 2, same fixture)'
      FROM btts a
      JOIN game_total b
        ${fixtureJoinSql('a', 'b')}
       AND b.unit_key IN (${GOAL_UNITS_SQL})
       AND b.line < 2
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    ins_team AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'team_game_total_over')},
             'team total ⟹ game total: team over L_t implies game over L_g for L_t ≥ L_g (game = team + opponent ≥ team; same unit + fixture)'
      FROM team_total a
      JOIN game_total b
        ${fixtureJoinSql('a', 'b')}
       AND b.question_id <> a.question_id
       AND ${unitKeysCompatibleSql('a.unit_key', 'b.unit_key')}
       AND ${bothKnownDifferSql('a.condition_metric', 'b.condition_metric')}
       AND a.line >= b.line
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    ins_spread AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'spread_total_over')},
             'spread ⟹ total over: margin > X means the winner alone scored > X ≥ L_g, so the game total clears L_g (favorite legs only; same unit + fixture)'
      FROM spread a
      JOIN game_total b
        ${fixtureJoinSql('a', 'b')}
       AND ${unitKeysCompatibleSql('a.unit_key', 'b.unit_key')}
       AND a.margin >= b.line
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    ins_ladder AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'fixture_total_ladder')},
             'totals ladder (xq): one fixture has one final total, so over L_hi implies over L_lo for L_hi > L_lo (same unit + fixture; cross-set residue)'
      FROM game_total a
      JOIN game_total b
        ${fixtureJoinSql('a', 'b')}
       AND b.question_id <> a.question_id
       AND ${unitKeysCompatibleSql('a.unit_key', 'b.unit_key')}
       AND ${bothKnownDifferSql('a.condition_metric', 'b.condition_metric')}
       AND a.line > b.line
       -- both dates known at fine grain, else two different matches of the same pairing could ladder falsely
       AND a.condition_date IS NOT NULL AND b.condition_date IS NOT NULL
       AND a.condition_date_precision NOT IN ('year','month')
       AND b.condition_date_precision NOT IN ('year','month')
       AND NOT EXISTS (
         SELECT 1
         FROM outcome_set_slots s1
         JOIN outcome_set_slots s2 ON s1.set_id = s2.set_id
         WHERE s1.question_id = a.question_id
           AND s2.question_id = b.question_id
       )
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    ins_slice AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'slice_game_total_over')},
             'slice ⟹ game total: a sub-period total over L1 forces the game total over L2 for L1 ≥ L2 (temporal sum dominance; same unit + fixture)'
      FROM slice_total a
      JOIN game_total b
        ${fixtureJoinSql('a', 'b')}
       AND b.question_id <> a.question_id
       AND a.ord IS NULL AND b.ord IS NULL
       AND ${unitKeysCompatibleSql('a.unit_key', 'b.unit_key')}
       AND ${bothKnownDifferSql('a.condition_metric', 'b.condition_metric')}
       AND a.line >= b.line
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*) FROM ins_btts)
      + (SELECT COUNT(*) FROM ins_team)
      + (SELECT COUNT(*) FROM ins_spread)
      + (SELECT COUNT(*) FROM ins_ladder)
      + (SELECT COUNT(*) FROM ins_slice) AS n
  `;
}

export async function buildFixtureTotalsEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildFixtureTotalsEdgesSql());
  log.info('fixture-totals: ' + n + ' edges (btts/team/spread/ladder/slice arms)');
  return n;
}
