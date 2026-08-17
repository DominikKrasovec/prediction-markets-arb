/**
 * Cross-question mutual-exclusion edges (Stage 4): two outcome-nodes of the same
 * resolving event that cannot both resolve TRUE, skipping pairs already enumerated
 * in one categorical outcome_set. Three disjoint INSERT arms: ins = winner kinds,
 * ins_spread = opposite-team match_spread, ins_half = opposite-side halftime_leader.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  foldedTextEqSql,
  bothKnownDifferSql,
  sameSliceScopeSql,
  inSameOutcomeSetSql,
} from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';
import { sameEventFragment } from './same-event.js';
import { CROSS_VENUE_SETTLEMENT, crossVenueSettlementTagSql } from './basis-risk.js';
import { builderDiscConjunct } from '../discriminators/fold-sql.js';
import { AWARD_MAX_WINNERS } from '../stage1-normalize/kalshi-series.js';
import { beltHit } from '../discriminators/telemetry.js';
import { HALF_ABBREV_SCOPE_RX } from './equivalence-edge.js';
import { FISCAL_PERIOD_RX_POSIX, FISCAL_CONTEXT_RX_POSIX } from '../discriminators/specs/game-ordinal.js';

const log = createLogger('stage4-mutual-exclusion-xq');

/** Kalshi series prefixes whose award admits ≥2 winners, derived from {@link AWARD_MAX_WINNERS}. */
export const MULTI_WINNER_AWARD_PREFIXES: ReadonlyArray<string> =
  Object.entries(AWARD_MAX_WINNERS).filter(([, cap]) => cap > 1).map(([prefix]) => prefix);

const MULTI_WINNER_AWARD_PREFIXES_SQL =
  MULTI_WINNER_AWARD_PREFIXES.map((p) => `'${p}'`).join(',');

/** SQL mirror of finalize.looksMultiWinnerSelection (advance/qualify/relegated/finish top-N). */
const MULTI_WINNER_SELECT_SQL_RX =
  `\\y((advance\\w*|qualif\\w*) (to|for|into) (the )?(grand )?(final\\w*|semi\\w*|knockout\\w*|playoff\\w*|next round|round of)|relegat\\w*|make[s]? (the )?(playoff|postseason|knockout)|finish(es|ing)? (in )?(the )?top[- ]?[0-9]|top[- ]?[0-9]+ finish\\w*)`;

/** Winner orientation gate (match_winner only): canonical_subject must be a participant
 *  of its own fixture; NULL/empty participants[] PASSES (finalize COALESCEs to '{}',
 *  and `x = ANY('{}')` is FALSE, so cardinality must be checked first). */
const WIN_SUFFIX_SQL_RX = `\\s+(wins?|winner)(\\s+(the\\s+)?(match|fight|game|series|map\\s*\\d+|game\\s*\\d+))?\\s*$`;
function foldedSubjectSql(x: string): string {
  return `lower(immutable_unaccent(btrim(regexp_replace(${x}.canonical_subject, '${WIN_SUFFIX_SQL_RX}', '', 'i'))))`;
}
export function winnerOrientationGateSql(x: string): string {
  // draws pass unconditionally (never in participants[], but a sound mutex side)
  return `NOT (${x}.event_kind = 'match_winner'
            AND ${x}.participants IS NOT NULL
            AND cardinality(${x}.participants) > 0
            AND lower(btrim(${x}.canonical_subject)) <> 'draw'
            AND COALESCE(${x}.discriminators->>'draw_axis','') <> 'draw'
            AND NOT (${x}.canonical_subject = ANY(${x}.participants))
            AND NOT EXISTS (
              SELECT 1
              FROM unnest(${x}.participants) AS wp(p),
              LATERAL (SELECT lower(immutable_unaccent(btrim(p))) AS fp,
                              ${foldedSubjectSql(x)} AS fs) f
              WHERE f.fp = f.fs
                 -- substring tolerance for spelling drift, excluded for matchup-title subjects
                 OR (lower(${x}.canonical_subject) NOT LIKE '% vs %'
                     AND lower(${x}.canonical_subject) NOT LIKE '% vs. %'
                     AND lower(${x}.canonical_subject) NOT LIKE '% @ %'
                     AND ((length(f.fs) >= 5 AND f.fp LIKE '%' || f.fs || '%')
                       OR (length(f.fp) >= 5 AND f.fs LIKE '%' || f.fp || '%')))
            ))`;
}

/** Pure-TS mirror of {@link winnerOrientationGateSql}. */
const WIN_SUFFIX_TS_RX = /\s+(wins?|winner)(\s+(the\s+)?(match|fight|game|series|map\s*\d+|game\s*\d+))?\s*$/i;
function foldSubjectTs(s: string): string {
  return s.replace(WIN_SUFFIX_TS_RX, '').trim().toLowerCase();
}
function isMatchupSubject(s: string): boolean {
  const l = ` ${s.toLowerCase()} `;
  return l.includes(' vs ') || l.includes(' vs. ') || l.includes(' @ ');
}
export function passesWinnerOrientation(
  eventKind: string | null,
  canonicalSubject: string | null,
  participants: readonly string[] | null | undefined,
  drawAxis?: string | null,
): boolean {
  if (eventKind !== 'match_winner') return true;
  if (participants == null || participants.length === 0) return true;
  if (canonicalSubject == null) return false;
  if (canonicalSubject.trim().toLowerCase() === 'draw' || drawAxis === 'draw') return true;
  if (participants.includes(canonicalSubject)) return true;
  const folded = foldSubjectTs(canonicalSubject);
  if (participants.some((p) => p.trim().toLowerCase() === folded)) return true;
  if (isMatchupSubject(canonicalSubject)) return false;
  return participants.some((p) => {
    const fp = p.trim().toLowerCase();
    return (folded.length >= 5 && fp.includes(folded)) || (fp.length >= 5 && folded.includes(fp));
  });
}

/** Refuses a winner pair whose Kalshi series families differ, unless whitelisted below. */
export const SAME_COMPETITION_SERIES_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['KXPGAWIN', 'KXPGATOUR'],
];
const SAME_COMPETITION_SQL = SAME_COMPETITION_SERIES_PAIRS
  .map(([x, y]) => `('${x}','${y}'),('${y}','${x}')`)
  .join(',');
export function crossSeriesRefusalSql(ksa: string, ksb: string): string {
  return `NOT (${ksa}.series IS NOT NULL AND ${ksb}.series IS NOT NULL
            AND ${ksa}.series IS DISTINCT FROM ${ksb}.series
            AND (${ksa}.series, ${ksb}.series) NOT IN (${SAME_COMPETITION_SQL}))`;
}

/** Refuses the winner mutex when either endpoint is a multi-winner award. */
export function awardMultiWinnerRefusalSql(ksa: string, ksb: string, a: string, b: string): string {
  const prefixIn = MULTI_WINNER_AWARD_PREFIXES_SQL === ''
    ? 'FALSE'
    : `(${ksa}.series IN (${MULTI_WINNER_AWARD_PREFIXES_SQL}) OR ${ksb}.series IN (${MULTI_WINNER_AWARD_PREFIXES_SQL}))`;
  return `NOT (
         ${prefixIn}
         OR ${a}.title ~* '${MULTI_WINNER_SELECT_SQL_RX}'
         OR ${b}.title ~* '${MULTI_WINNER_SELECT_SQL_RX}'
         OR ${a}.canonical_event ILIKE '%nobel peace%' OR ${a}.title ILIKE '%nobel peace%'
         OR ${b}.canonical_event ILIKE '%nobel peace%' OR ${b}.title ILIKE '%nobel peace%'
       )`;
}

/** Shared edge contract plus `basis_risk` as a 9th column (this file's arms only). */
const EDGE_COLS_WITH_BASIS_SQL = EDGE_INSERT_COLUMNS_SQL.replace(/\)\s*$/, ', basis_risk)');

/** Patterns emitted by this builder — scope for the basis-risk-tagged telemetry count. */
const MUTEX_XQ_PATTERNS = [
  'cross_question_mutex',
  'cross_question_mutex_spread',
  'cross_question_mutex_halftime',
];

/** Gate 1: championship_winner pairs with known-differing ATP/WTA leagues never mutex
 *  (NULL league PASSES). Gate 2: a '<year> grand slam'/'major' family is win-ANY-of-K, never a mutex. */
export function winnerMutexTourGatesSql(a: string, b: string): string {
  return `-- NULL-explicit: IS NOT NULL anchors keep this two-valued (NULL league passes)
       AND NOT (${a}.event_kind = 'championship_winner'
            AND ${a}.league IS NOT NULL AND ${b}.league IS NOT NULL
            AND lower(btrim(${a}.league)) IN ('atp tour','wta tour')
            AND lower(btrim(${b}.league)) IN ('atp tour','wta tour')
            AND lower(btrim(${a}.league)) <> lower(btrim(${b}.league)))
       -- any-of-family gate: win-ANY-of-K, never single-winner
       AND NOT (${a}.event_kind = 'championship_winner'
            AND (btrim(lower(${a}.canonical_event)) ~ '(grand slam|major)$'
              OR btrim(lower(${b}.canonical_event)) ~ '(grand slam|major)$'))`;
}

/** Opposite-team match_spread mutex: single-team spreads of one fixture on different
 *  teams can never both be TRUE. Keyed on participants[1], not canonical_subject,
 *  since the subject embeds the threshold text. */
export function spreadMutexPairPredicateSql(a: string, b: string): string {
  return `${foldedTextEqSql(`${a}.canonical_event`, `${b}.canonical_event`)}
       AND ${a}.question_id < ${b}.question_id
       AND ${a}.event_kind = 'match_spread' AND ${b}.event_kind = 'match_spread'
       -- single-team only (excludes 2-participant handicap folds, which are equivalences)
       AND array_length(${a}.participants, 1) = 1 AND array_length(${b}.participants, 1) = 1
       -- direction='above' required: a future below-direction normalization must not silently break the mutex
       AND ${a}.condition_direction = 'above' AND ${b}.condition_direction = 'above'
       AND lower(immutable_unaccent(btrim(${a}.participants[1]))) IS DISTINCT FROM lower(immutable_unaccent(btrim(${b}.participants[1])))
       AND lower(immutable_unaccent(btrim(${a}.participants[1]))) NOT ILIKE '%' || lower(immutable_unaccent(btrim(${b}.participants[1]))) || '%'
       AND lower(immutable_unaccent(btrim(${b}.participants[1]))) NOT ILIKE '%' || lower(immutable_unaccent(btrim(${a}.participants[1]))) || '%'
       AND (${a}.platform_event_id = ${b}.platform_event_id
            OR (${a}.condition_date IS NOT NULL AND ${b}.condition_date IS NOT NULL))
       AND ${sameEventFragment(a, b)}
       AND NOT ${inSameOutcomeSetSql(`${a}.question_id`, `${b}.question_id`)}`;
}

function buildSpreadMutexInsertSql(): string {
  return `ins_spread AS (
      INSERT INTO implication_edges
        ${EDGE_COLS_WITH_BASIS_SQL}
      SELECT
        a.question_id, b.question_id,
        ${edgeContractSql('mutual_exclusion', 'cross_question_mutex_spread')},
        'opposite-team margin-of-victory spreads of one fixture (mutually exclusive for all thresholds)',
        ${crossVenueSettlementTagSql('a.question_id', 'b.question_id', 'a.event_kind')}
      FROM mux_nf a
      JOIN mux_nf b
        ON a.ce_fold = b.ce_fold
       AND ${spreadMutexPairPredicateSql('a', 'b')}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )`;
}

/** Opposite-side halftime_leader mutex: at the half exactly one of {A leads, B
 *  leads, level} holds, so any distinct-subject pair of one fixture is mutex
 *  (a level half resolves both team legs NO, which a mutex tolerates). */
export function halftimeMutexPairPredicateSql(a: string, b: string): string {
  return `${foldedTextEqSql(`${a}.canonical_event`, `${b}.canonical_event`)}
       AND ${a}.question_id < ${b}.question_id
       AND ${a}.event_kind = 'halftime_leader' AND ${b}.event_kind = 'halftime_leader'
       AND ${a}.canonical_subject IS DISTINCT FROM ${b}.canonical_subject
       AND ${a}.canonical_subject NOT ILIKE '%' || ${b}.canonical_subject || '%'
       AND ${b}.canonical_subject NOT ILIKE '%' || ${a}.canonical_subject || '%'
       -- Draw≠Tie belt: 'Draw'/'Tie' are the same level-at-half outcome under two labels, never a mutex
       AND NOT (${a}.canonical_subject ~* '(^|\\s)(draw|tie)$' AND ${b}.canonical_subject ~* '(^|\\s)(draw|tie)$')
       AND NOT (COALESCE(${a}.discriminators->>'draw_axis', '') = 'draw'
            AND COALESCE(${b}.discriminators->>'draw_axis', '') = 'draw')
       -- condition_metric here is 'boolean'/NULL platform noise, not a grain — tolerant compare
       AND ${bothKnownDifferSql(`${a}.condition_metric`, `${b}.condition_metric`)}
       AND ${sameSliceScopeSql(`${a}.metric_scope`, `${b}.metric_scope`)}
       AND (${a}.platform_event_id = ${b}.platform_event_id
            OR (${a}.condition_date IS NOT NULL AND ${b}.condition_date IS NOT NULL))
       AND ${sameEventFragment(a, b)}
       AND NOT ${inSameOutcomeSetSql(`${a}.question_id`, `${b}.question_id`)}`;
}

function buildHalftimeMutexInsertSql(): string {
  return `ins_half AS (
      INSERT INTO implication_edges
        ${EDGE_COLS_WITH_BASIS_SQL}
      SELECT
        a.question_id, b.question_id,
        ${edgeContractSql('mutual_exclusion', 'cross_question_mutex_halftime')},
        'opposite halftime-leader outcomes of one fixture (at most one side can lead at the half)',
        ${crossVenueSettlementTagSql('a.question_id', 'b.question_id', 'a.event_kind')}
      FROM mux_nf a
      JOIN mux_nf b
        ON a.ce_fold = b.ce_fold
       AND ${halftimeMutexPairPredicateSql('a', 'b')}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )`;
}

/** Materializes node-facts into a stats-bearing `TEMP TABLE mux_nf` (Postgres can't
 *  carry column statistics through a CTE) so the mutex arms' fold self-join stays a
 *  plain hashable equijoin on `ce_fold` instead of misestimated. */
export function buildMuxNfTempSql(): string {
  return `
    CREATE TEMP TABLE mux_nf ON COMMIT DROP AS
    WITH ${nodeFactsCte()},
    mux_series AS (
      SELECT DISTINCT ON (qm.question_id) qm.question_id,
             split_part(r.raw->>'event_ticker', '-', 1) AS series
      FROM question_members qm
      JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
      JOIN market_metadata_raw r ON r.market_id = m.id
      WHERE r.raw->>'event_ticker' IS NOT NULL
      ORDER BY qm.question_id, m.id
    )
    SELECT
      nf.*,
      lower(immutable_unaccent(btrim(nf.canonical_event))) AS ce_fold,
      ms.series AS series,
      ${winnerOrientationGateSql('nf')} AS orientation_ok,
      (nf.title ~* '${MULTI_WINNER_SELECT_SQL_RX}'
       OR nf.canonical_event ILIKE '%nobel peace%'
       OR nf.title ILIKE '%nobel peace%') AS award_multiwinner
    FROM node_facts nf
    LEFT JOIN mux_series ms ON ms.question_id = nf.question_id;
    CREATE INDEX ON mux_nf (ce_fold);
    ANALYZE mux_nf;
  `;
}

/** Exported so the EXPLAIN probe + tests can validate the SQL without executing it. */
export function buildMutualExclusionXqEdgesSql(): string {
  // belt-and-suspenders with the stamped game_ordinal; also scans canonical_subject,
  // which the (title-only) ordinal can't see. Posix \\m \\M = word boundaries.
  const HALF_RX =
    `\\mhalf[- ]?time\\M|\\mat\\s+(the\\s+)?half\\M|\\mlead(ing|er)?\\s+at\\s+(the\\s+)?(half|break)\\M|\\mdraw\\s+at\\s+(the\\s+)?half`;
  // bare 1H/2H is also a half; fiscal-guarded (year-adjacent 1H is a fiscal half, not a first half)
  const halfMarker = (col: string) =>
    `(${col} ~* '${HALF_RX}' OR (${col} ~* '${HALF_ABBREV_SCOPE_RX}'`
    + ` AND NOT ${col} ~* '${FISCAL_PERIOD_RX_POSIX}' AND NOT ${col} ~* '${FISCAL_CONTEXT_RX_POSIX}'))`;
  // multi-statement: mux_nf pre-pass then the 3-arm INSERT must run in one transaction
  // (runEdgeBuilderSql/withTx) so the ON COMMIT DROP temp table stays visible
  return `${buildMuxNfTempSql()}
    WITH
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_COLS_WITH_BASIS_SQL}
      SELECT
        a.question_id, b.question_id,
        ${edgeContractSql('mutual_exclusion', 'cross_question_mutex')},
        'cross-question mutual exclusion (same event, distinct winner subjects)',
        ${crossVenueSettlementTagSql('a.question_id', 'b.question_id', 'a.event_kind')}
      FROM mux_nf a
      JOIN mux_nf b
        ON a.ce_fold = b.ce_fold
       AND ${foldedTextEqSql('a.canonical_event', 'b.canonical_event')}
       AND a.question_id < b.question_id
       AND a.event_kind = b.event_kind
       AND a.event_kind IN ('match_winner','championship_winner')
       AND a.canonical_subject IS DISTINCT FROM b.canonical_subject
       AND a.condition_metric IS NOT DISTINCT FROM b.condition_metric
       AND a.canonical_subject NOT ILIKE '%' || b.canonical_subject || '%'
       AND b.canonical_subject NOT ILIKE '%' || a.canonical_subject || '%'
       AND a.event_kind IS DISTINCT FROM 'candle_direction'
       AND b.event_kind IS DISTINCT FROM 'candle_direction'
       AND ${sameEventFragment('a', 'b')}
       AND ${sameSliceScopeSql('a.metric_scope', 'b.metric_scope')}
       ${winnerMutexTourGatesSql('a', 'b')}
       AND ${builderDiscConjunct('a', 'b', 'tour_gender')}
       AND ${builderDiscConjunct('a', 'b', 'mention_phrase')}
       AND NOT (COALESCE(a.discriminators->>'draw_axis', '') = 'draw'
            AND COALESCE(b.discriminators->>'draw_axis', '') = 'draw')
       AND NOT ${inSameOutcomeSetSql('a.question_id', 'b.question_id')}
       -- FT/HT grain gate: HT lead/draw is compatible with any full-time result, so both
       -- sides must agree on the half marker (scans subject too, since Kalshi embeds it there)
       AND ( (${halfMarker('a.title')} OR ${halfMarker('a.canonical_subject')})
           = (${halfMarker('b.title')} OR ${halfMarker('b.canonical_subject')}) )
      WHERE ${crossSeriesRefusalSql('a', 'b')}
        AND COALESCE(a.orientation_ok, TRUE)
        AND COALESCE(b.orientation_ok, TRUE)
        AND NOT (
          ${MULTI_WINNER_AWARD_PREFIXES_SQL === '' ? 'FALSE' : `a.series IN (${MULTI_WINNER_AWARD_PREFIXES_SQL}) OR b.series IN (${MULTI_WINNER_AWARD_PREFIXES_SQL})`}
          OR COALESCE(a.award_multiwinner, FALSE)
          OR COALESCE(b.award_multiwinner, FALSE)
        )
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    ${buildSpreadMutexInsertSql()},
    ${buildHalftimeMutexInsertSql()}
    SELECT (SELECT COUNT(*) FROM ins) + (SELECT COUNT(*) FROM ins_spread)
         + (SELECT COUNT(*) FROM ins_half) AS n
  `;
}

export async function buildMutualExclusionXqEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildMutualExclusionXqEdgesSql());
  log.info('mutual-exclusion-xq: ' + n + ' edges');
  const tagged = await countBasisRiskTagged(MUTEX_XQ_PATTERNS);
  log.info(`BELT_CENSUS {edges.basis_risk_tagged.mutex_xq: ${tagged}}`);
  const tourRefused = await countTourGateRefusals();
  log.info(`BELT_CENSUS {belt.mutex_tour_gate: ${tourRefused}, belt.mutex_tennis_exemption: ${tourRefused}}`);
  const orient = await countWinnerOrientationViolations();
  for (let i = 0; i < orient; i++) beltHit('stage4_refuse_winner_orientation');
  const spreadSameTeam = await countSpreadSameTeamViolations();
  for (let i = 0; i < spreadSameTeam; i++) beltHit('stage4_refuse_spread_same_team');
  log.info(
    `BELT_CENSUS {belt.stage4_refuse_winner_orientation: ${orient}, belt.stage4_refuse_spread_same_team: ${spreadSameTeam}}`,
  );
  return n;
}

/** Diagnostic count for belt.stage4_refuse_winner_orientation. */
async function countWinnerOrientationViolations(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM implication_edges e
       JOIN questions a ON a.id = e.antecedent_question_id
       JOIN questions b ON b.id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_mutex' AND e.archived_at IS NULL
        AND (
          (a.event_kind = 'match_winner' AND a.participants IS NOT NULL AND cardinality(a.participants) > 0 AND NOT (a.canonical_subject = ANY(a.participants)) AND NOT EXISTS (SELECT 1 FROM unnest(a.participants) AS wp_a(p), LATERAL (SELECT lower(immutable_unaccent(btrim(p))) AS fp, lower(immutable_unaccent(btrim(regexp_replace(a.canonical_subject, ' +(wins?|winner)( +(the +)?(match|fight|game|series|map *[0-9]+|game *[0-9]+))? *$', '', 'i')))) AS fs) f WHERE f.fp = f.fs OR (lower(a.canonical_subject) NOT LIKE '% vs %' AND lower(a.canonical_subject) NOT LIKE '% vs. %' AND lower(a.canonical_subject) NOT LIKE '% @ %' AND ((length(f.fs) >= 5 AND f.fp LIKE '%' || f.fs || '%') OR (length(f.fp) >= 5 AND f.fs LIKE '%' || f.fp || '%')))) AND lower(btrim(a.canonical_subject)) <> 'draw' AND COALESCE(a.discriminators->>'draw_axis','') <> 'draw')
          OR (b.event_kind = 'match_winner' AND b.participants IS NOT NULL AND cardinality(b.participants) > 0 AND NOT (b.canonical_subject = ANY(b.participants)) AND NOT EXISTS (SELECT 1 FROM unnest(b.participants) AS wp_b(p), LATERAL (SELECT lower(immutable_unaccent(btrim(p))) AS fp, lower(immutable_unaccent(btrim(regexp_replace(b.canonical_subject, ' +(wins?|winner)( +(the +)?(match|fight|game|series|map *[0-9]+|game *[0-9]+))? *$', '', 'i')))) AS fs) f WHERE f.fp = f.fs OR (lower(b.canonical_subject) NOT LIKE '% vs %' AND lower(b.canonical_subject) NOT LIKE '% vs. %' AND lower(b.canonical_subject) NOT LIKE '% @ %' AND ((length(f.fs) >= 5 AND f.fp LIKE '%' || f.fs || '%') OR (length(f.fp) >= 5 AND f.fs LIKE '%' || f.fp || '%')))) AND lower(btrim(b.canonical_subject)) <> 'draw' AND COALESCE(b.discriminators->>'draw_axis','') <> 'draw')
        )`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Diagnostic count for belt.stage4_refuse_spread_same_team. */
async function countSpreadSameTeamViolations(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM implication_edges e
       JOIN questions a ON a.id = e.antecedent_question_id
       JOIN questions b ON b.id = e.consequent_question_id
      WHERE e.pattern = 'cross_question_mutex_spread' AND e.archived_at IS NULL
        AND array_length(a.participants, 1) = 1 AND array_length(b.participants, 1) = 1
        AND (
          lower(immutable_unaccent(btrim(a.participants[1]))) = lower(immutable_unaccent(btrim(b.participants[1])))
          OR lower(immutable_unaccent(btrim(a.participants[1]))) ILIKE '%' || lower(immutable_unaccent(btrim(b.participants[1]))) || '%'
          OR lower(immutable_unaccent(btrim(b.participants[1]))) ILIKE '%' || lower(immutable_unaccent(btrim(a.participants[1]))) || '%'
        )`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Diagnostic count for belt.mutex_tour_gate: pairs Gate-1 of {@link winnerMutexTourGatesSql} refuses. */
async function countTourGateRefusals(): Promise<number> {
  const sql = `
    WITH tennis AS (
      SELECT q.id, q.canonical_event, lower(btrim(pe.league_canonical)) AS lg
      FROM questions q
      JOIN LATERAL (
        SELECT m.platform, m.platform_event_id
        FROM question_members qm JOIN markets m ON m.id = qm.market_id
        WHERE qm.question_id = q.id ORDER BY m.id LIMIT 1
      ) rm ON TRUE
      LEFT JOIN platform_events pe
             ON pe.platform = rm.platform AND pe.platform_event_id = rm.platform_event_id
      WHERE q.archived_at IS NULL
        AND q.event_kind = 'championship_winner'
        AND lower(btrim(pe.league_canonical)) IN ('atp tour','wta tour')
    )
    SELECT count(*)::int AS n
    FROM tennis a JOIN tennis b
      ON ${foldedTextEqSql('a.canonical_event', 'b.canonical_event')}
     AND a.id < b.id
     AND a.lg <> b.lg`;
  const rows = await query<{ n: number }>(sql);
  return Number(rows[0]?.n ?? 0);
}

/** Count edges under `patterns` currently carrying the cross-venue settlement tag. */
async function countBasisRiskTagged(patterns: string[]): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM implication_edges
      WHERE basis_risk = $1 AND archived_at IS NULL AND pattern = ANY($2)`,
    [CROSS_VENUE_SETTLEMENT, patterns],
  );
  return Number(rows[0]?.n ?? 0);
}
