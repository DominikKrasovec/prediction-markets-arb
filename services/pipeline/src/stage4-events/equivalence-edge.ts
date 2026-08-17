/**
 * Cross-question EQUIVALENCE edges (pattern `cross_question_equiv`): asserted
 * only when every identity field agrees and the same-event gate
 * (`sameEventFragment`) holds. The solver enforces an equivalence as hard as
 * a merge (forbids world A<>B), so this must never fire on a fuzzy match.
 * Platform-structure tier keys on structure alone (event_ticker /
 * platform_event_id), independent of the field/title guards, so identical
 * titles never pass it vacuously. TS mirror: classifyPlatformStructure()
 * below — keep the SQL CASE in `cand` and the TS function in sync.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import {
  numericValueShapesSql,
  touchVsSnapshotConflictSql,
  integerGrainUnitsSql,
} from '../util/condition-shape.js';
import { isFixturePlaceholderSubjectSql } from '../util/placeholder-outcomes.js';
import {
  settlementDimensionSql, settlementDimensionCompatibleSql,
} from '../util/settlement-instrument.js';
import { eveningDayShiftArmsSql, sameAtCoarserGrainSql } from '../util/date-grain-sql.js';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  foldedTextEqSql,
  sameSliceScopeSql,
  foldedParticipantsSql,
  foldTextKey,
} from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';
import { builderDiscConjunct } from '../discriminators/fold-sql.js';
import { dayShiftGuardSqlForSportExprs, sameEventFragment, kalshiSeriesCte } from './same-event.js';
// Fiscal 1H/2H (half-year) must never read as a betting-line first half.
import {
  FISCAL_PERIOD_RX, FISCAL_CONTEXT_RX, FISCAL_PERIOD_RX_POSIX, FISCAL_CONTEXT_RX_POSIX,
} from '../discriminators/specs/game-ordinal.js';
import { questionResolutionSourceCte } from './window-containment.js';
import { oraclesCompatibleSql } from '../util/resolution-oracle-compare.js';
import { CROSS_VENUE_SETTLEMENT, crossVenueSettlementTagSql } from './basis-risk.js';

const log = createLogger('stage4-equivalence-edge');

/** EDGE_INSERT_COLUMNS_SQL + basis_risk, so equivalence edges can carry the cross-venue-settlement tag. */
const EDGE_COLS_WITH_BASIS_SQL = EDGE_INSERT_COLUMNS_SQL.replace(/\)\s*$/, ', basis_risk)');

/** An equivalence must match the participant SET, else opposite sides of one fixture fuse. */
const PARTICIPANT_KINDS_SQL =
  `('match_winner','match_spread','match_total_metric','exact_score','both_teams_score','halftime_leader','championship_winner','match_event_prop')`;

/** Word-anchored (\m...\M) prop/secondary-market title tokens that discriminate a fixture's side markets from its plain match-winner. */
const PROP_DISCRIMINATOR_RX =
  `\\m(most sixes|most fours|most runs|most wickets|top batter|top bowler|top run scorer|top wicket|toss match|toss double|wins the toss|completed match|team top|method of dismissal|fall of (the )?first wicket|highest (opening )?partnership|player of the match|man of the match)\\M`;

/** Ballot access is necessary, not sufficient, for winning; exported so election-precondition-edge.ts emits win=>ballot instead. */
export const ELECTION_PRECONDITION_RX =
  `\\m(on the ballot|ballot access|qualify|qualifies|qualifying|nominee|nominated|nomination|make the runoff|run for)\\M`;

export type StructureReject =
  | 'sibling-ticker'
  | 'variant-series'
  | 'same-pe-sibling'
  | 'xpe-identical-title';

export interface StructureTierNode {
  platform: string;
  platformEventId: string | null;
  title: string | null;
  /** Every Kalshi member's event_ticker, not just the rep — so a mixed-platform node still trips sibling-ticker. */
  kalshiEventTickers?: readonly string[];
}

const foldTitleKey = foldTextKey;

/** Null (fall-through to the field/title gates) when neither structural reject applies. */
export function classifyPlatformStructure(
  a: StructureTierNode,
  b: StructureTierNode,
): StructureReject | null {
  const bTickers = new Set(b.kalshiEventTickers ?? []);
  if ((a.kalshiEventTickers ?? []).some((t) => bTickers.has(t))) return 'sibling-ticker';
  if (a.platform === 'kalshi' && b.platform === 'kalshi') return 'variant-series';
  if (a.platform === b.platform) {
    const aPe = a.platformEventId;
    const bPe = b.platformEventId;
    const samePe = aPe != null && bPe != null && aPe === bPe;
    const peDistinct = !(aPe == null && bPe == null) && aPe !== bPe;
    const titlesIdentical = foldTitleKey(a.title) === foldTitleKey(b.title);
    if (samePe && !titlesIdentical) return 'same-pe-sibling';
    if (peDistinct && titlesIdentical) return 'xpe-identical-title';
  }
  return null;
}

/** Every count must be 0; kept out of the hot builder to avoid re-running the self-join per class. */
export function buildStructureTierViolationsSql(): string {
  return `
    WITH ${nodeFactsCte()}
    SELECT
      count(*) FILTER (WHERE a.platform = 'kalshi' AND b.platform = 'kalshi')::int AS variant_series,
      count(*) FILTER (
        WHERE a.platform = b.platform
          AND a.platform_event_id IS NOT NULL AND b.platform_event_id IS NOT NULL
          AND a.platform_event_id = b.platform_event_id
          AND lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
      )::int AS same_pe_sibling,
      count(*) FILTER (
        WHERE a.platform = b.platform
          AND a.platform_event_id IS DISTINCT FROM b.platform_event_id
          AND lower(immutable_unaccent(btrim(a.title))) IS NOT DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
      )::int AS xpe_identical_title,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1
          FROM question_members qma
          JOIN markets ma             ON ma.id = qma.market_id AND ma.platform = 'kalshi'
          JOIN market_metadata_raw ra ON ra.market_id = ma.id
          JOIN question_members qmb   ON qmb.question_id = b.question_id
          JOIN markets mb             ON mb.id = qmb.market_id AND mb.platform = 'kalshi'
          JOIN market_metadata_raw rb ON rb.market_id = mb.id
          WHERE qma.question_id = a.question_id
            AND ra.raw->>'event_ticker' IS NOT NULL
            AND ra.raw->>'event_ticker' = rb.raw->>'event_ticker'
        )
      )::int AS sibling_ticker,
      count(*) FILTER (
        WHERE a.event_kind = 'other' AND b.event_kind = 'other'
          AND lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
          AND (
               lower(immutable_unaccent(a.title)) ~ '${PROP_DISCRIMINATOR_RX}'
            OR lower(immutable_unaccent(b.title)) ~ '${PROP_DISCRIMINATOR_RX}'
            OR ( (lower(immutable_unaccent(a.title)) ~ '\\mdraw\\M')
                 <> (lower(immutable_unaccent(b.title)) ~ '\\mdraw\\M') )
          )
      )::int AS s3b_other_prop
    FROM implication_edges e
    JOIN node_facts a ON a.question_id = e.antecedent_question_id
    JOIN node_facts b ON b.question_id = e.consequent_question_id
    WHERE e.pattern = 'cross_question_equiv' AND e.archived_at IS NULL
  `;
}

/**
 * Kalshi carries multiple tie windows per fixture; a draw×draw pair is refused
 * when both sides' Kalshi series family is known and differs. NULL series passes.
 */
export function drawScopeCrossSeriesRefusalSql(a: string, b: string, ksa: string, ksb: string): string {
  return `NOT (
         (COALESCE(${a}.discriminators->>'draw_axis','') = 'draw' OR lower(btrim(${a}.canonical_subject)) = 'draw')
         AND (COALESCE(${b}.discriminators->>'draw_axis','') = 'draw' OR lower(btrim(${b}.canonical_subject)) = 'draw')
         AND ${ksa}.series IS NOT NULL AND ${ksb}.series IS NOT NULL
         AND ${ksa}.series IS DISTINCT FROM ${ksb}.series
       )`;
}

/** Mirrors {@link drawScopeCrossSeriesRefusalSql}; keep in sync. */
export function drawScopeCrossSeriesRefused(
  aIsDraw: boolean,
  bIsDraw: boolean,
  aSeries: string | null | undefined,
  bSeries: string | null | undefined,
): boolean {
  return aIsDraw && bIsDraw && aSeries != null && bSeries != null && aSeries !== bSeries;
}

/**
 * HT is not FT (a team can lead at HT and lose FT); a node is half-scope when
 * metric_scope is half_1/half_2 or the title carries a half/period phrase.
 * Full-time is encoded as metric_scope NULL, so both-NULL passes untouched.
 */
export const HALF_SCOPE_TITLE_RX =
  `\\m(half[ -]?time|1st half|first half|2nd half|second half|at the half)\\M`;

/** Kept separate from HALF_SCOPE_TITLE_RX so the fiscal guard gates only the bare abbreviation. */
export const HALF_ABBREV_SCOPE_RX = `\\m1h\\M|\\m2h\\M`;
const HALF_ABBREV_SCOPE_RX_JS = /\b1h\b|\b2h\b/;

/** Shared by isHalfScopeSql and the mutex belt (mutual-exclusion-xq). COALESCE-guarded, never NULL. */
export function halfAbbrevScopeSql(title: string): string {
  const t = `lower(immutable_unaccent(${title}))`;
  return `COALESCE(${t} ~ '${HALF_ABBREV_SCOPE_RX}' AND NOT ${t} ~ '${FISCAL_PERIOD_RX_POSIX}' AND NOT ${t} ~ '${FISCAL_CONTEXT_RX_POSIX}', FALSE)`;
}

/** Always TRUE/FALSE (COALESCE-guarded), never NULL. */
export function isHalfScopeSql(scope: string, title: string): string {
  return `(COALESCE(${scope}, '') IN ('half_1','half_2') OR COALESCE(lower(immutable_unaccent(${title})) ~ '${HALF_SCOPE_TITLE_RX}', FALSE) OR ${halfAbbrevScopeSql(title)})`;
}

/** Single source of truth for both the builder gate (negated) and the archival script. */
export function htFtScopeMismatchSql(scopeA: string, titleA: string, scopeB: string, titleB: string): string {
  return `( ${isHalfScopeSql(scopeA, titleA)} <> ${isHalfScopeSql(scopeB, titleB)} )`;
}

/** Mirrors {@link isHalfScopeSql}; keep in sync. */
export function isHalfScope(metricScope: string | null | undefined, title: string | null | undefined): boolean {
  if (metricScope === 'half_1' || metricScope === 'half_2') return true;
  const t = (title ?? '').toLowerCase();
  if (HALF_SCOPE_TITLE_RX_JS.test(t)) return true;
  // A year-adjacent or financial-metric-noun 1H/2H is a fiscal half-year, never a betting-line first half.
  return HALF_ABBREV_SCOPE_RX_JS.test(t) && !FISCAL_PERIOD_RX.test(t) && !FISCAL_CONTEXT_RX.test(t);
}

/** Mirrors {@link htFtScopeMismatchSql}; keep in sync. */
export function htFtScopeMismatch(
  aScope: string | null | undefined,
  aTitle: string | null | undefined,
  bScope: string | null | undefined,
  bTitle: string | null | undefined,
): boolean {
  return isHalfScope(aScope, aTitle) !== isHalfScope(bScope, bTitle);
}

const HALF_SCOPE_TITLE_RX_JS = /\b(half[ -]?time|1st half|first half|2nd half|second half|at the half)\b/;

/** Hoisted to a single-pass CTE — a per-pair EXISTS would wedge this, the slowest builder. */
function kalshiStrikeStrictnessCte(name: string): string {
  return `${name} AS (
      SELECT DISTINCT ON (qm.question_id) qm.question_id,
             CASE lower(r.raw->>'strike_type')
               WHEN 'greater' THEN 'strict'
               WHEN 'less' THEN 'strict'
               WHEN 'greater_or_equal' THEN 'inclusive'
               WHEN 'less_or_equal' THEN 'inclusive'
               WHEN 'between' THEN 'inclusive'
             END AS strictness
      FROM question_members qm
      JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
      JOIN market_metadata_raw r ON r.market_id = m.id
      WHERE r.raw->>'strike_type' IS NOT NULL
      ORDER BY qm.question_id, m.id
    )`;
}

/** A question whose own members disagree yields NULL and is never refused by the conjunct below. */
function settlementDimensionCte(name: string): string {
  return `${name} AS (
      SELECT qm.question_id,
             CASE WHEN count(DISTINCT d.dim) = 1 THEN min(d.dim) END AS dim
      FROM question_members qm
      JOIN market_metadata_raw r ON r.market_id = qm.market_id
      CROSS JOIN LATERAL (SELECT ${settlementDimensionSql('r.raw')} AS dim) d
      WHERE d.dim IS NOT NULL
      GROUP BY qm.question_id
    )`;
}

/** TRUE (kept) unless both sides record a differing strictness on a numeric, non-continuous-unit bound. NULL strictness passes. */
export function boundStrictnessCompatibleSql(sa: string, sb: string, a: string): string {
  return `NOT (
         ${sa}.strictness IS NOT NULL AND ${sb}.strictness IS NOT NULL
         AND ${sa}.strictness IS DISTINCT FROM ${sb}.strictness
         AND ${a}.value_primary IS NOT NULL
         AND NOT (${a}.value_unit IS NOT NULL AND lower(${a}.value_unit) NOT IN ${integerGrainUnitsSql()})
       )`;
}

/** Exported so the EXPLAIN probe + tests can validate the SQL without executing it. */
export function buildEquivalenceEdgesSql(): string {
  // INSERT joins `questions` (not node_facts) so the deadline guard reads the raw per-question condition_date.
  return `
    WITH ${nodeFactsCte()},
    ${kalshiSeriesCte('equiv_kalshi_series')},
    ${kalshiStrikeStrictnessCte('equiv_strike_strictness')},
    ${settlementDimensionCte('equiv_settlement_dimension')},
    cand AS (
      -- a_sport/b_sport: evening day-shift arm's prone-sport guard.
      -- a_platform/b_platform/a_kind: cross-venue settlement tag in the
      -- INSERT below (a.event_kind = b.event_kind is gated here already).
      SELECT a.question_id AS aq, b.question_id AS bq,
             a.sport AS a_sport, b.sport AS b_sport,
             a.platform AS a_platform, b.platform AS b_platform,
             a.event_kind AS a_kind
      FROM node_facts a
      JOIN node_facts b
        -- cheap hashable equality first (same key sameEventFragment Tier-2 uses)
        ON ${foldedTextEqSql('a.canonical_event', 'b.canonical_event')}
       AND a.question_id < b.question_id
       AND ${sameEventFragment('a', 'b')}
       AND a.event_kind = b.event_kind
       AND a.canonical_subject   IS NOT DISTINCT FROM b.canonical_subject
       -- IS NOT DISTINCT FROM above treats NULL=NULL as equal, so a known
       -- subject is required on both legs to avoid equating two
       -- subject-less nodes on canonical_event alone.
       AND a.canonical_subject IS NOT NULL
       -- A fixture-shaped subject (a GAME name, e.g. "Brewers vs. Cubs")
       -- carries no outcome identity, so it would fuse "Brewers win" with
       -- "Cubs win". Refused only when no structured discriminator survives:
       -- a pair that agrees on a known condition_metric and value_primary is
       -- identified by the metric and the line, so it is kept.
       AND NOT (
         ${isFixturePlaceholderSubjectSql('a.canonical_subject')}
         AND (a.condition_metric IS NULL OR a.value_primary IS NULL)
       )
       AND a.condition_direction IS NOT DISTINCT FROM b.condition_direction
       AND a.condition_metric    IS NOT DISTINCT FROM b.condition_metric
       AND a.value_primary IS NOT DISTINCT FROM b.value_primary
       AND a.value_unit    IS NOT DISTINCT FROM b.value_unit
       -- Metric-scope gate distinguishes team-total from game-total,
       -- first-half-winner from full-match-winner. NULL means no scope
       -- signal, whose only safe reading is the whole game, so NULL<->'game'
       -- passes but NULL<->slice does not.
       AND ${sameSliceScopeSql('a.metric_scope', 'b.metric_scope')}
       -- Not subsumed by sameSliceScopeSql above: full-time is itself encoded
       -- as metric_scope NULL, so a pair NULL on both sides still passes that
       -- gate. Refuse when exactly one side is half-scope (structured
       -- half_1/half_2 or a half/period title); half_1<->half_2 is already
       -- caught above.
       AND NOT ${htFtScopeMismatchSql('a.metric_scope', 'a.title', 'b.metric_scope', 'b.title')}
       -- The secondary value is part of the outcome for exact scorelines
       -- ("2 - 2" vs "2 - 3" share value_primary but are different results).
       AND a.value_secondary IS NOT DISTINCT FROM b.value_secondary
       -- A missing value on a numeric outcome must skip (else two different
       -- unset thresholds would fuse). Checked on both sides so a binary
       -- side can't equate with a numeric side of NULL value.
       AND NOT (
         a.condition_shape IN ${numericValueShapesSql()}
         AND a.value_primary IS NULL
       )
       AND NOT (
         b.condition_shape IN ${numericValueShapesSql()}
         AND b.value_primary IS NULL
       )
       -- "reach $X by D" (monotonic_threshold) and "above $X at close on D"
       -- (point_in_time/range_snapshot) share value, direction and unit yet
       -- are different YES-regions over the path space — never equivalent.
       AND ${touchVsSnapshotConflictSql('a.condition_shape', 'b.condition_shape')}
       -- crypto candle directions stay as merges, not equivalence edges
       AND a.event_kind <> 'candle_direction'
       -- Platform-structure tier (see header + classifyPlatformStructure): SQL
       -- mirror of classifyPlatformStructure(); keep in sync.
       -- variant-series: no kalshi<->kalshi algorithmic equivalences (siblings
       -- of one event share a ticker; conditionId ground truth lives in the
       -- cross_ref builder).
       AND NOT (a.platform = 'kalshi' AND b.platform = 'kalshi')
       -- same-pe-sibling: same platform + same platform_event + differing
       -- folded titles = sibling sub-markets/props of one event. Identical
       -- titles (true duplicate listing) fall through.
       AND NOT (
         a.platform = b.platform
         AND a.platform_event_id IS NOT NULL AND b.platform_event_id IS NOT NULL
         AND a.platform_event_id = b.platform_event_id
         AND lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
       )
       -- xpe-identical-title: same platform + different (or one-side-NULL)
       -- platform_event + identical folded titles = the generic-sub-market trap.
       AND NOT (
         a.platform = b.platform
         AND a.platform_event_id IS DISTINCT FROM b.platform_event_id
         AND lower(immutable_unaccent(btrim(a.title))) IS NOT DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
       )
       -- sibling-ticker: any Kalshi member of a shares an event_ticker with any
       -- Kalshi member of b — catches mixed-platform (feed-A) nodes whose rep
       -- platform is not kalshi, which the variant-series check cannot see.
       -- Placed last: anti-join only on pairs surviving the cheap equality gates.
       AND NOT EXISTS (
         SELECT 1
         FROM question_members qma
         JOIN markets ma             ON ma.id = qma.market_id AND ma.platform = 'kalshi'
         JOIN market_metadata_raw ra ON ra.market_id = ma.id
         JOIN question_members qmb   ON qmb.question_id = b.question_id
         JOIN markets mb             ON mb.id = qmb.market_id AND mb.platform = 'kalshi'
         JOIN market_metadata_raw rb ON rb.market_id = mb.id
         WHERE qma.question_id = a.question_id
           AND ra.raw->>'event_ticker' IS NOT NULL
           AND ra.raw->>'event_ticker' = rb.raw->>'event_ticker'
       )
       -- Reject sibling props of one event (subject = the event, not the
       -- outcome). Binary outcomes whose metric/value/direction are all NULL,
       -- filed under the same platform_event_id but with different titles, are
       -- distinct propositions. Legitimate binary cross-platform equivs have
       -- different platform_event_id and are untouched.
       AND NOT (
         a.condition_shape = 'binary_event' AND b.condition_shape = 'binary_event'
         AND a.condition_metric IS NULL AND a.value_primary IS NULL AND a.condition_direction IS NULL
         AND a.platform_event_id IS NOT NULL AND b.platform_event_id IS NOT NULL
         AND a.platform_event_id = b.platform_event_id
         AND lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
       )
       -- Participant-bearing kinds require order/case/accent-insensitive
       -- participants equality (else opposite teams of one match fuse: spread
       -- AC Milan vs Atalanta share the line but are different outcomes).
       AND NOT (
         a.event_kind IN ${PARTICIPANT_KINDS_SQL}
         AND ${foldedParticipantsSql('a.participants')}
             IS DISTINCT FROM
             ${foldedParticipantsSql('b.participants')}
       )
       -- Same-event categorical/stage siblings with a title-only discriminator
       -- (e.g. a "Stage of Elimination" family: each entrant has a "win the
       -- Final" question plus several "eliminated in round X" questions
       -- sharing platform_event_id, canonical_event, canonical_subject, a
       -- boolean metric, and NULL value — the round lives only in the title).
       -- Two same-event different-title nodes with no value discriminator are
       -- siblings, never equivalent. Scoped to the NULL-value categorical/stage
       -- class so numeric ladders and genuine cross-platform equivs (different
       -- platform_event_id) are untouched.
       AND NOT (
         (a.condition_shape = 'categorical_outcome' OR a.event_kind = 'stage_advance')
         AND (b.condition_shape = 'categorical_outcome' OR b.event_kind = 'stage_advance')
         AND a.value_primary IS NULL AND b.value_primary IS NULL
         AND a.platform_event_id IS NOT NULL AND b.platform_event_id IS NOT NULL
         AND a.platform_event_id = b.platform_event_id
         AND lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
       )
       -- "R margin >= X" and "D margin >= X" for the same race are mutually
       -- exclusive outcomes (only one party can win by X), with the party
       -- living only in the title. Reject when the two rep titles carry
       -- opposite party tokens; same-party and no-party pairs are untouched.
       AND NOT (
         a.event_kind = 'election_margin'
         AND (
           (    (lower(immutable_unaccent(a.title)) ~ '\\m(republican|republicans|gop)\\M')
            AND (lower(immutable_unaccent(b.title)) ~ '\\m(democrat|democrats|democratic)\\M') )
           OR ( (lower(immutable_unaccent(a.title)) ~ '\\m(democrat|democrats|democratic)\\M')
            AND (lower(immutable_unaccent(b.title)) ~ '\\m(republican|republicans|gop)\\M') )
         )
       )
       -- Party discriminator (R-margin is not D-margin of one race). Tolerant
       -- both-known-differ, so it also covers title-guard blind spots (party
       -- in canonical_subject/outcome_label, intl party tokens); a NULL side
       -- always passes.
       AND ${builderDiscConjunct('a', 'b', 'party')}
       -- Mention questions' word lives only in discriminators->>'mention_phrase'.
       -- Strict null policy: different-or-one-NULL phrase is never a hard
       -- equivalence.
       AND ${builderDiscConjunct('a', 'b', 'mention_phrase')}
       -- Two clubs' "qualify for competition X" vs "place Nth in competition Y"
       -- can share canonical_subject, event_kind='stage_advance', and even
       -- value_primary coincidentally, but are different competitions/seasons
       -- living only in the title. Different-title stage_advance nodes are
       -- siblings, never equal.
       AND NOT (
         a.event_kind = 'stage_advance' AND b.event_kind = 'stage_advance'
         AND lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
       )
       -- Twin of the categorical/stage guard above, ungated on
       -- platform_event_id: a "Stage of Elimination" family is
       -- categorical_outcome with NULL value and a round discriminator only
       -- in the title, and cross-platform copies sit under different
       -- platform_event_ids. Bounded to NULL value so it cannot reach the
       -- value-bearing election-winner categoricals above.
       AND NOT (
         (a.condition_shape = 'categorical_outcome' OR a.event_kind = 'stage_advance')
         AND (b.condition_shape = 'categorical_outcome' OR b.event_kind = 'stage_advance')
         AND a.value_primary IS NULL AND b.value_primary IS NULL
         AND lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
       )
       -- A "X vs Y" fixture also lists "Most Sixes", "Top Batter", "Toss
       -- Match", a standalone "Draw", etc — all share subject + participants
       -- + NULL value with the plain winner. The discriminator is
       -- title-only. Reject when folded titles differ and either (i) one
       -- title carries a prop token, or (ii) exactly one title says "draw".
       -- Also fires for event_kind='other' pairs, since some platforms shape
       -- prop questions as all-NULL 'other' with a team subject.
       AND NOT (
         (a.event_kind IN ${PARTICIPANT_KINDS_SQL}
          OR (a.event_kind = 'other' AND b.event_kind = 'other'))
         AND lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
         AND (
              lower(immutable_unaccent(a.title)) ~ '${PROP_DISCRIMINATOR_RX}'
           OR lower(immutable_unaccent(b.title)) ~ '${PROP_DISCRIMINATOR_RX}'
           -- one-sided 'draw' title token = a standalone-Draw prop vs a
           -- team-win, unless both gated subjects are the draw label itself
           -- (then the title XOR is spelling drift, not a discriminator).
           OR ( ( (lower(immutable_unaccent(a.title)) ~ '\\mdraw\\M')
                  <> (lower(immutable_unaccent(b.title)) ~ '\\mdraw\\M') )
                AND NOT (lower(btrim(a.canonical_subject)) ~ '(^|\\s)(draw|tie)$'
                     AND lower(btrim(b.canonical_subject)) ~ '(^|\\s)(draw|tie)$') )
         )
       )
       -- Being on the ballot is necessary, not sufficient, for winning, so a
       -- precondition title ("on the ballot"/"qualify"/"nominee"/"make the
       -- runoff") vs a win title is an implication, never an equivalence,
       -- even when every other field matches. Reject when exactly one side
       -- is a precondition title (XOR).
       AND NOT (
         a.event_kind = 'election_outcome_winner' AND b.event_kind = 'election_outcome_winner'
         AND ( (lower(immutable_unaccent(a.title)) ~ '${ELECTION_PRECONDITION_RX}')
               <> (lower(immutable_unaccent(b.title)) ~ '${ELECTION_PRECONDITION_RX}') )
       )
       -- The rep-pe same-pe-sibling gate above reads only the representative
       -- member's pe, so a multi-member node whose rep sits on a different pe
       -- than the shared one slips through. Refuse when any member of a
       -- shares a (platform, platform_event_id) with any member of b and the
       -- folded rep titles differ.
       AND NOT (
         lower(immutable_unaccent(btrim(a.title))) IS DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
         AND EXISTS (
           SELECT 1
           FROM question_members qma
           JOIN markets ma ON ma.id = qma.market_id
           JOIN question_members qmb ON qmb.question_id = b.question_id
           JOIN markets mb ON mb.id = qmb.market_id
           WHERE qma.question_id = a.question_id
             AND ma.platform = mb.platform
             AND ma.platform_event_id IS NOT NULL
             AND ma.platform_event_id = mb.platform_event_id
         )
       )
       -- "<group>: <outcome>" — two legs of one group share the group prefix
       -- but name different outcomes after the colon. Refuse when both
       -- titles carry a colon, the pre-colon prefix is identical, and the
       -- post-colon tokens differ.
       AND NOT (
         position(':' in a.title) > 0 AND position(':' in b.title) > 0
         AND lower(immutable_unaccent(btrim(split_part(a.title, ':', 1))))
             = lower(immutable_unaccent(btrim(split_part(b.title, ':', 1))))
         AND lower(immutable_unaccent(btrim(regexp_replace(a.title, '^[^:]*:\\s*', ''))))
             IS DISTINCT FROM
             lower(immutable_unaccent(btrim(regexp_replace(b.title, '^[^:]*:\\s*', ''))))
       )
       -- Two slots of one outcome_set are mutex, unless they are the same
       -- outcome split across platforms. Exempt a same-set pair from the
       -- mutex reject only when it is provably the same outcome on two
       -- platforms: cross-platform and either (a) the folded rep titles are
       -- identical, or (b) a participant-bearing kind, where subject
       -- equality plus participant equality already pin the same fixture and
       -- the same winning team.
       AND NOT (
         EXISTS (
           SELECT 1
           FROM outcome_set_slots s1
           JOIN outcome_set_slots s2 ON s1.set_id = s2.set_id
           WHERE s1.question_id = a.question_id
             AND s2.question_id = b.question_id
         )
         AND NOT (
           a.platform <> b.platform
           AND (
             lower(immutable_unaccent(btrim(a.title))) IS NOT DISTINCT FROM lower(immutable_unaccent(btrim(b.title)))
             OR a.event_kind IN ${PARTICIPANT_KINDS_SQL}
           )
         )
       )
      LEFT JOIN equiv_kalshi_series ksa ON ksa.question_id = a.question_id
      LEFT JOIN equiv_kalshi_series ksb ON ksb.question_id = b.question_id
      LEFT JOIN equiv_strike_strictness sta ON sta.question_id = a.question_id
      LEFT JOIN equiv_strike_strictness stb ON stb.question_id = b.question_id
      LEFT JOIN equiv_settlement_dimension sda ON sda.question_id = a.question_id
      LEFT JOIN equiv_settlement_dimension sdb ON sdb.question_id = b.question_id
      WHERE ${drawScopeCrossSeriesRefusalSql('a', 'b', 'ksa', 'ksb')}
      -- "above X" (strict) is not "X or higher" (inclusive) at the same bound,
      -- since the strictness is dropped by the Stage-1 direction fold and every
      -- gated field agrees. Continuous units are exempt (measure-zero boundary).
        AND ${boundStrictnessCompatibleSql('sta', 'stb', 'a')}
      -- Two questions that settle on different measured quantities are not
      -- equivalent however completely their stamped fields agree. Both-known-
      -- and-differ only.
        AND ${settlementDimensionCompatibleSql('sda.dim', 'sdb.dim')}
    ),
    ${questionResolutionSourceCte()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_COLS_WITH_BASIS_SQL}
      SELECT c.aq, c.bq, ${edgeContractSql('equivalence', 'cross_question_equiv')},
             'cross-platform equivalence (same event+outcome, scope-guarded)'
             -- Marks both-known differing resolution_source. Narrower than
             -- the oracle gate below (fires on raw string difference), so a
             -- marked edge that survives is the class the oracle relation
             -- deliberately tolerates.
             || CASE WHEN ra.resolution_source IS NOT NULL AND rb.resolution_source IS NOT NULL
                      AND ra.resolution_source IS DISTINCT FROM rb.resolution_source
                     THEN ' [cross-source: ' || ra.resolution_source || ' != ' || rb.resolution_source || ']'
                     ELSE '' END,
             -- Cross-venue settlement tail on cross-platform equivalences of
             -- settlement-divergence-capable kinds. A one-side-NULL /
             -- same-platform / non-divergence kind stays NULL; pure telemetry.
             ${crossVenueSettlementTagSql('c.aq', 'c.bq', 'c.a_kind')}
      FROM cand c
      JOIN questions qa ON qa.id = c.aq
      JOIN questions qb ON qb.id = c.bq
      LEFT JOIN question_resolution_source ra ON ra.question_id = c.aq
      LEFT JOIN question_resolution_source rb ON rb.question_id = c.bq
      -- Equality on the question-level resolution deadline (questions.condition_date,
      -- TEXT), compared at the coarser of the two projected grains so format
      -- drift (date-only vs full timestamp) and precision-padding drift don't
      -- cause a false refuse. NULL=NULL passes; one-side-NULL refuses.
      -- Evening day-shift arm: a shifted fixture (one platform's
      -- minute-precision timestamp vs another's day-precision date) passes
      -- the cand's date ladder but would be refused here by strict day-slice
      -- equality without this arm.
      -- Cross-oracle refusal placed here (not in cand) because the
      -- question-grain unanimous-known aggregation (ra/rb) is only in scope
      -- after the questionResolutionSourceCte join. Both-known-and-differ
      -- over data authorities: the 'UMA' settlement layer folds to unknown,
      -- since it is a ratification mechanism, not a reading.
      WHERE ${oraclesCompatibleSql('ra.resolution_source', 'rb.resolution_source')}
        AND (
          (qa.condition_date IS NULL AND qb.condition_date IS NULL)
          OR (qa.condition_date IS NOT NULL AND qb.condition_date IS NOT NULL
              AND (${sameAtCoarserGrainSql('qa.condition_date', 'qa.condition_date_precision', 'qb.condition_date', 'qb.condition_date_precision')}
                   ${eveningDayShiftArmsSql('qa', 'qb', dayShiftGuardSqlForSportExprs('c.a_sport', 'c.b_sport'), '::timestamptz')}))
        )
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildEquivalenceEdges(): Promise<number> {
  // statement_timeout is lifted for this heavy self-join; temp_file_limit is the real guard.
  const n = await runEdgeBuilderSql(buildEquivalenceEdgesSql());
  log.info('equivalence-edge: ' + n + ' edges');
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM implication_edges
      WHERE basis_risk = $1 AND archived_at IS NULL AND pattern = 'cross_question_equiv'`,
    [CROSS_VENUE_SETTLEMENT],
  );
  log.info(`BELT_CENSUS {edges.basis_risk_tagged.equiv_xq: ${Number(rows[0]?.n ?? 0)}}`);
  const s1Refused = await countEquivS1PartyRefusals(); // expected 0
  log.info(`BELT_CENSUS {belt.equiv_s1_party: ${s1Refused}}`);
  const drawScope = await countDrawScopeCrossSeriesRefusals(); // expected 0
  log.info(`BELT_CENSUS {belt.equiv_draw_scope_cross_series: ${drawScope}}`);
  const htFt = await countHtFtScopeMismatchRefusals(); // expected 0
  log.info(`BELT_CENSUS {belt.equiv_htft_scope_mismatch: ${htFt}}`);
  return n;
}

async function countHtFtScopeMismatchRefusals(): Promise<number> {
  const sql = `
    SELECT count(*)::int AS n
    FROM implication_edges e
    JOIN questions qa ON qa.id = e.antecedent_question_id
    JOIN questions qc ON qc.id = e.consequent_question_id
    LEFT JOIN LATERAL (
      SELECT m.title FROM question_members qm JOIN markets m ON m.id = qm.market_id
      WHERE qm.question_id = qa.id ORDER BY m.id LIMIT 1
    ) ta ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.title FROM question_members qm JOIN markets m ON m.id = qm.market_id
      WHERE qm.question_id = qc.id ORDER BY m.id LIMIT 1
    ) tc ON TRUE
    WHERE e.archived_at IS NULL
      AND e.pattern = 'cross_question_equiv'
      AND ${htFtScopeMismatchSql('qa.metric_scope', 'ta.title', 'qc.metric_scope', 'tc.title')}`;
  const r = await query<{ n: number }>(sql);
  return Number(r[0]?.n ?? 0);
}

async function countDrawScopeCrossSeriesRefusals(): Promise<number> {
  const sql = `
    WITH ${kalshiSeriesCte('ks')}
    SELECT count(*)::int AS n
    FROM implication_edges e
    JOIN questions qa ON qa.id = e.antecedent_question_id
    JOIN questions qc ON qc.id = e.consequent_question_id
    LEFT JOIN ks ksa ON ksa.question_id = qa.id
    LEFT JOIN ks ksc ON ksc.question_id = qc.id
    WHERE e.archived_at IS NULL
      AND e.pattern = 'cross_question_equiv'
      AND (COALESCE(qa.discriminators->>'draw_axis','') = 'draw' OR lower(btrim(qa.canonical_subject)) = 'draw')
      AND (COALESCE(qc.discriminators->>'draw_axis','') = 'draw' OR lower(btrim(qc.canonical_subject)) = 'draw')
      AND ksa.series IS NOT NULL AND ksc.series IS NOT NULL
      AND ksa.series IS DISTINCT FROM ksc.series`;
  const r = await query<{ n: number }>(sql);
  return Number(r[0]?.n ?? 0);
}

/** Party regex mirrors specs/party.ts's vocabulary. */
async function countEquivS1PartyRefusals(): Promise<number> {
  const REP = `\\m(republican|republicans|gop)\\M`;
  const DEM = `\\m(democrat|democrats|democratic)\\M`;
  const sql = `
    WITH em AS (
      SELECT q.id, q.canonical_subject, q.value_primary,
             lower(immutable_unaccent(rm.title)) AS t
      FROM questions q
      JOIN LATERAL (
        SELECT m.title FROM question_members qm JOIN markets m ON m.id = qm.market_id
        WHERE qm.question_id = q.id ORDER BY m.id LIMIT 1
      ) rm ON TRUE
      WHERE q.archived_at IS NULL AND q.event_kind = 'election_margin'
    )
    SELECT count(*)::int AS n
    FROM implication_edges e
    JOIN em a ON a.id = e.antecedent_question_id
    JOIN em b ON b.id = e.consequent_question_id
    WHERE e.archived_at IS NULL
      AND e.pattern = 'cross_question_equiv'
      AND a.canonical_subject IS NOT DISTINCT FROM b.canonical_subject
      AND a.value_primary     IS NOT DISTINCT FROM b.value_primary
      AND ( (a.t ~ '${REP}' AND b.t ~ '${DEM}') OR (a.t ~ '${DEM}' AND b.t ~ '${REP}') )`;
  const r = await query<{ n: number }>(sql);
  return Number(r[0]?.n ?? 0);
}
