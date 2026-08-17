/**
 * spread-winner — match_spread (favorite leg) implies match_winner edges
 * (Stage 4).
 *
 * Rule: "Team T covers -X" (event_kind='match_spread', direction='above',
 * value_primary = X > 0, the favorite/negative-handicap encoding) strictly
 * implies "Team T wins the fixture" (event_kind='match_winner',
 * canonical_subject = T) on the same fixture. Antecedent = the spread,
 * consequent = the winner, edge_type='strict_implication'. The sports
 * analogue of margin_winner.
 *
 * Soundness: X > 0 implies margin (team - opponent) > 0 implies T won the
 * fixture at the scoreline's scope. A regulation win is never overturned by
 * extra time, and an incl-OT margin > 0 is the game winner in OT sports —
 * see the resolution_scope belt for the one theoretical cross-scope
 * mismatch.
 *
 * Guarded classes:
 *   - Underdog/positive-handicap legs ("+3.5") do not imply winning; encoded
 *     direction='below', excluded by the 'above' + value>0 gate. Interior
 *     bands (value_secondary) excluded too.
 *   - Tennis games-margin can be true while losing the match; defended by
 *     the margin-unit allowlist (games omitted). NULL units mean no edge.
 *   - Sub-fixture slices (F5, half, series) stamp a non-'game' metric_scope,
 *     gated to IN (NULL,'game'); the per-game/period ordinal keeps slices
 *     apart on both sides.
 *   - A game spread must not imply a series winner sharing the fixture's
 *     bare canonical_event (those nodes carry NULL date) — a series-title
 *     belt on both sides is load-bearing.
 *   - Home/away two-leg trap: same canonical_event, different legs — the
 *     precision-aware date gate defends against fusing the wrong leg.
 *   - Bare-halftime mislabels ("leads at the half") — belt on consequent
 *     title + subject.
 *   - A spread's canonical_subject can embed the threshold and is never
 *     trusted alone; team identity comes only from arity-1 participants[0]
 *     or arity-2 canonical_subject-in-participants with distinct
 *     participants. Anything else yields no edge.
 *   - Draw / prop-label consequents ('Draw', 'Match goes to Day 3') — killed
 *     by subject-is-participant + subject-equals-team.
 *   - Cross-scope (FT/ET): defended by the NULL-tolerant
 *     both-known-and-differ conjunct.
 *
 * The consequent is not required to sit in a categorical outcome_set — a
 * strict_implication forbids exactly the (spread YES, winner NO) world and
 * is sound without a complement.
 *
 * Edge contract: edge_type='strict_implication', pattern='spread_winner',
 * confidence=1.0, deterministic=TRUE, source='algorithmic',
 * ON CONFLICT (antecedent, consequent) DO NOTHING.
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
import { dayShiftGuardSqlForSportExprs, dayShiftProneSqlForSportExprs } from './same-event.js';

const log = createLogger('stage4-spread-winner');

// Pure-TS reference implementations (mirror the SQL 1:1 for unit tests).

/**
 * Margin-unit allowlist: units whose positive margin arithmetically pins the
 * fixture winner. 'games' is deliberately omitted (tennis games-margin does
 * not pin the match winner), and so is every unknown unit. NULL means no edge.
 */
export const SPREAD_WINNER_UNITS: ReadonlyArray<string> = [
  'point', 'points', 'goal', 'goals', 'run', 'runs', 'map', 'maps', 'set', 'sets',
] as const;

/**
 * Team identity for a spread node — the only two trusted forms: arity-1
 * participants[0], or arity-2 canonical_subject in participants with
 * distinct participants. Anything else yields null. Mirrors the SQL `team`
 * CASE exactly — keep in sync.
 */
export function spreadTeamIdentity(
  participants: readonly string[] | null | undefined,
  canonicalSubject: string | null | undefined,
): string | null {
  if (!participants || participants.length === 0) return null;
  if (participants.length === 1) return participants[0];
  if (participants.length === 2) {
    if (participants[0] === participants[1]) return null;          // dup-junk projections
    if (canonicalSubject && participants.includes(canonicalSubject)) return canonicalSubject;
  }
  return null;
}

/**
 * Favorite-leg eligibility — the structural underdog exclusion.
 * direction='above' + value > 0 + no interior band. Mirrors the SQL
 * spread-CTE gates exactly.
 */
export function isFavoriteSpreadLeg(
  direction: string | null | undefined,
  valuePrimary: number | null | undefined,
  valueSecondary: number | null | undefined,
): boolean {
  return direction === 'above' && valuePrimary != null && valuePrimary > 0 && valueSecondary == null;
}

/**
 * Bare-halftime marker — the mutual-exclusion-xq HALF_RX verbatim (kept in
 * sync by the shape test). Applied to the consequent title + canonical_subject.
 */
export const SPREAD_WINNER_HALF_RX =
  `\\mhalf[- ]?time\\M|\\mat\\s+(the\\s+)?half\\M|\\mlead(ing|er)?\\s+at\\s+(the\\s+)?(half|break)\\M|\\mdraw\\s+at\\s+(the\\s+)?half`;

/** Series token — the game-spread implies series-winner belt. */
export const SPREAD_WINNER_SERIES_RX = `\\mseries\\M`;

const UNITS_SQL = SPREAD_WINNER_UNITS.map((u) => `'${u}'`).join(',');

/** Exported so the EXPLAIN/dry-run probe + tests can validate the SQL without executing it. */
export function buildSpreadWinnerEdgesSql(): string {
  const c = config.pairing;
  return `
    WITH ${nodeFactsCte()},
    -- Precomputed plain-column join keys so the planner hash-joins.
    spread AS MATERIALIZED (
      SELECT question_id, title, resolution_scope, sport,
             condition_date, condition_date_precision,
             sport, ${fixtureStartInstantSql('node_facts')} AS start_at,
             (discriminators->>'game_ordinal')::int AS ord,
             ${foldedTextSql('canonical_event')} AS ce_key,
             -- Team identity: the only two trusted forms; else NULL, dropped.
             ${foldedTextSql(`CASE
               WHEN array_length(participants, 1) = 1 THEN participants[1]
               WHEN array_length(participants, 1) = 2
                AND participants[1] IS DISTINCT FROM participants[2]
                AND canonical_subject = ANY(participants) THEN canonical_subject
             END`)} AS team_key
      FROM node_facts
      WHERE event_kind = 'match_spread'
        -- Favorite legs only: 'above' + X > 0. Interior bands excluded.
        AND condition_direction = 'above'
        AND value_primary IS NOT NULL
        AND value_primary::numeric > 0
        AND value_secondary IS NULL
        -- Whole-fixture margins only (series/F5/half slices stamp their scope).
        AND (metric_scope IS NULL OR metric_scope = 'game')
        -- Margin-unit allowlist: units whose positive margin pins the winner.
        AND lower(btrim(value_unit)) IN (${UNITS_SQL})
        -- Series belt: a mis-stamped NULL-scope series spread must not imply
        -- a game winner, and a series-keyed canonical_event must not pair.
        AND lower(immutable_unaccent(title)) !~ '${SPREAD_WINNER_SERIES_RX}'
        AND ${foldedTextSql('canonical_event')} !~ '${SPREAD_WINNER_SERIES_RX}'
    ),
    winner AS MATERIALIZED (
      SELECT question_id, title, resolution_scope, sport,
             condition_date, condition_date_precision,
             sport, ${fixtureStartInstantSql('node_facts')} AS start_at,
             (discriminators->>'game_ordinal')::int AS ord,
             ${foldedTextSql('canonical_event')} AS ce_key,
             ${foldedTextSql('canonical_subject')} AS subj_key
      FROM node_facts
      WHERE event_kind = 'match_winner'
        -- Orientation: subject must be a participating team of its fixture.
        AND canonical_subject IS NOT NULL
        AND canonical_subject = ANY(participants)
        -- Whole-game or unknown only (per-map/per-set winners differ).
        AND (metric_scope IS NULL OR metric_scope = 'game')
        -- A game spread must not imply a series winner sharing the fixture's
        -- bare canonical_event (those nodes carry NULL date).
        AND lower(immutable_unaccent(title)) !~ '${SPREAD_WINNER_SERIES_RX}'
        AND lower(immutable_unaccent(title)) !~ '${SPREAD_WINNER_HALF_RX}'
        AND lower(immutable_unaccent(canonical_subject)) !~ '${SPREAD_WINNER_HALF_RX}'
    ),
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'spread_winner')},
             'spread ⟹ winner: team covers -X (final margin > X > 0) implies team wins the fixture (favorite legs only; same fixture via canonical_event + date + ordinal + scope gates)'
      FROM spread a
      JOIN winner b
        ON b.ce_key = a.ce_key
       -- The winner node's subject is the spread's team.
       AND b.subj_key = a.team_key
       -- FT/ET belt: refuse only when both resolution scopes known and differ.
       AND ${bothKnownDifferSql('a.resolution_scope', 'b.resolution_scope')}
       -- Per-game / per-period ordinal must match (1H/Map-N slices stay apart).
       AND b.ord IS NOT DISTINCT FROM a.ord
       -- Precision-aware date gate: defeats the home/away two-leg trap.
       AND ${datePrecisionLadderSql('a', 'b', c.sameEventCryptoToleranceMs, c.sameEventHourToleranceMs, '::timestamptz', { minuteVsDayEveningShiftGuardSql: dayShiftGuardSqlForSportExprs('a.sport', 'b.sport'), proneMinuteVsDayLocalDaySql: dayShiftProneSqlForSportExprs('a.sport', 'b.sport') })}
       -- Fixture start-instant veto + ambiguous-evening refusal: prefer
       -- refusing to pairing a US-evening spread with the wrong day's game.
       AND ${fixtureStartVetoSql('a.start_at', 'b.start_at')}
       AND ${ambiguousEveningRefusalSql('a', 'b', 'a.start_at', 'b.start_at', EVENING_DAY_SHIFT_MAX_UTC_HOUR, '::timestamptz')}
      WHERE a.ce_key IS NOT NULL AND a.team_key IS NOT NULL
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildSpreadWinnerEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildSpreadWinnerEdgesSql());
  log.info('spread-winner: ' + n + ' edges');
  return n;
}
