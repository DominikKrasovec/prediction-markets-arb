/**
 * first-scorer(P, fixture) ⟹ anytime-scorer(P, fixture).
 *
 * "P scores the first goal of fixture F" strictly implies "P is credited with
 * ≥1 goal in fixture F" — the first goal is a goal, credited to the same
 * player by the same official scoring. Antecedent = the first-scorer cell
 * (Stage-1 Pass 17, kalshi:first-goal-scorer — metric='rank' discriminator);
 * consequent = the anytime-scorer binary (Template S — metric='count').
 *
 * This builder ships armed even when no live pair currently exists; edges
 * materialize whenever a first-scorer family and an anytime family share a
 * player+fixture.
 *
 * Soundness derivation: let G₁ be the fixture's first credited goal.
 * Antecedent YES ⇔ scorer(G₁)=P ⇒ P is credited with ≥1 goal ⇒ consequent
 * YES, provided both sides read the same crediting convention and the same
 * eligible window. Both live families resolve on official box-score
 * crediting: Kalshi KXNHLFIRSTGOAL's NHL official scoring never credits an
 * own goal to the defending player (it goes to the last attacking toucher);
 * PM Template S explicitly excludes own goals ("Own goals do not count").
 *
 * Guarded failure classes:
 *   · Own goals: a soccer first-scorer market that counts own goals would
 *     settle YES on P's own goal while a PM anytime market ("Own goals do not
 *     count") settles NO. The antecedent population is minted only by the
 *     Stage-1 FIRST_SCORER_SERIES registry (KXNHLFIRSTGOAL today, where the
 *     class cannot arise); extending the registry to a soccer series requires
 *     reading its own-goal rule first.
 *   · Extra-time / window drift: PM anytime is regulation-only, so a first
 *     goal scored in extra time would satisfy a full-game first-scorer but
 *     not a regulation-only anytime. Guarded by the NULL-tolerant
 *     both-known-and-differ resolution_scope conjunct; cross-sport pairs are
 *     already impossible (same player + same fixture date rules them out).
 *   · Player identity: canonical_subject equality (folded); player subjects
 *     are clean KB entities. canonical_event anchors it further: antecedent
 *     ev = '<subject> first goalscorer', consequent ev = '<subject> goals'.
 *   · Fixture identity: player props key the player, not the fixture, so the
 *     fixture is pinned by subject + date: both dates non-null at
 *     day-or-finer precision (a year/month-grain prop date cannot pin a
 *     fixture — refused), compared via the precision-aware ladder
 *     (config.pairing tolerances).
 *   · Threshold arms are not anytime: "P 2+ goals" (player_prop_threshold
 *     with value_primary ≥ 2) is not implied by first-scorer — the
 *     consequent requires value_primary IS NULL.
 *   · Reverse direction stays forbidden: anytime does not imply first
 *     (another player can score first).
 *   · Settlement mechanics: cancellation/void asymmetry (PM 50-50 vs Kalshi
 *     last-price) is the standing cross-platform caveat shared by every
 *     implication builder.
 *
 * Edge contract: edge_type='strict_implication', pattern='first_anytime_scorer',
 * confidence=1.0, deterministic=TRUE, source='algorithmic', ON CONFLICT
 * (antecedent, consequent) DO NOTHING.
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

const log = createLogger('stage4-scorer-implication');

// Pure-TS reference implementations (mirror the SQL 1:1 for unit tests)

/** Antecedent anchor: '<subject> first goalscorer' (folded). */
export function isFirstScorerEvent(canonicalEvent: string, canonicalSubject: string): boolean {
  return canonicalEvent.trim().toLowerCase() === `${canonicalSubject.trim().toLowerCase()} first goalscorer`;
}

/** Consequent anchor: '<subject> goals' (folded — the Template-S / player-prop key). */
export function isAnytimeScorerEvent(canonicalEvent: string, canonicalSubject: string): boolean {
  return canonicalEvent.trim().toLowerCase() === `${canonicalSubject.trim().toLowerCase()} goals`;
}

/**
 * Pair admissibility on the discriminator stamps: antecedent metric='rank'
 * (first = rank-1 claim), consequent metric='count', BOTH binary (null
 * value_primary — threshold arms like "2+ goals" are never implied), same
 * player. Mirrors the SQL conjuncts exactly.
 */
export function scorerPairAdmissible(args: {
  aMetric: string | null; bMetric: string | null;
  aValuePrimary: number | null; bValuePrimary: number | null;
  aSubject: string | null; bSubject: string | null;
}): boolean {
  if (args.aMetric !== 'rank' || args.bMetric !== 'count') return false;
  if (args.aValuePrimary != null || args.bValuePrimary != null) return false;
  if (args.aSubject == null || args.bSubject == null) return false;
  return args.aSubject.trim().toLowerCase() === args.bSubject.trim().toLowerCase();
}

/** Exported so the EXPLAIN/dry-run probe + tests can validate the SQL without executing it. */
export function buildScorerImplicationEdgesSql(): string {
  const c = config.pairing;
  return `
    WITH ${nodeFactsCte()},
    -- antecedent: first-scorer cells (metric 'rank', binary, anchored
    -- canonical_event). Fixture date required at day-or-finer grain.
    first_scorer AS MATERIALIZED (
      SELECT question_id, resolution_scope, condition_date, condition_date_precision,
             sport, ${fixtureStartInstantSql('node_facts')} AS start_at,
             ${foldedTextSql('canonical_subject')} AS subj_key
      FROM node_facts
      WHERE event_kind = 'player_prop_threshold'
        AND condition_metric = 'rank'
        AND condition_shape = 'binary_event'
        AND condition_direction IS NULL
        AND value_primary IS NULL
        AND value_secondary IS NULL
        AND canonical_subject IS NOT NULL
        AND ${foldedTextSql('canonical_event')} = ${foldedTextSql('canonical_subject')} || ' first goalscorer'
        AND condition_date IS NOT NULL
        AND (condition_date_precision IS NULL OR condition_date_precision NOT IN ('year','month'))
    ),
    -- consequent: anytime-scorer binaries (metric 'count', binary,
    -- '<player> goals' event key, goal unit when stamped).
    anytime_scorer AS MATERIALIZED (
      SELECT question_id, resolution_scope, condition_date, condition_date_precision,
             sport, ${fixtureStartInstantSql('node_facts')} AS start_at,
             ${foldedTextSql('canonical_subject')} AS subj_key
      FROM node_facts
      WHERE event_kind = 'player_prop_threshold'
        AND condition_metric = 'count'
        AND condition_shape = 'binary_event'
        AND condition_direction IS NULL
        AND value_primary IS NULL
        AND value_secondary IS NULL
        AND canonical_subject IS NOT NULL
        AND ${foldedTextSql('canonical_event')} = ${foldedTextSql('canonical_subject')} || ' goals'
        AND (value_unit IS NULL OR lower(btrim(value_unit)) IN ('goal','goals'))
        AND condition_date IS NOT NULL
        AND (condition_date_precision IS NULL OR condition_date_precision NOT IN ('year','month'))
    ),
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'first_anytime_scorer')},
             'first scorer ⟹ anytime scorer: the first credited goal is a credited goal by the same player in the same fixture (official-scoring credit both sides; same player + day-grain fixture date)'
      FROM first_scorer a
      JOIN anytime_scorer b
        -- same player (clean KB entity)
        ON b.subj_key = a.subj_key
       AND b.question_id <> a.question_id
       -- refuse only when both resolution scopes are known and differ
       AND ${bothKnownDifferSql('a.resolution_scope', 'b.resolution_scope')}
       -- fixture date gate (load-bearing — props key the player, not the
       -- fixture): precision-aware proximity at day-or-finer grain
       AND ${datePrecisionLadderSql('a', 'b', c.sameEventCryptoToleranceMs, c.sameEventHourToleranceMs, '::timestamptz')}
       -- the date gate's minute×day arm compares a UTC instant's calendar
       -- date to a US-local day, which can match a player's US-evening
       -- fixture to his next game; this veto refuses two known start
       -- instants >= 10h apart, and a pre-dawn-UTC instant vs a bare
       -- no-instant local day, rather than risk pairing the wrong game.
       AND ${fixtureStartVetoSql('a.start_at', 'b.start_at')}
       AND ${ambiguousEveningRefusalSql('a', 'b', 'a.start_at', 'b.start_at', EVENING_DAY_SHIFT_MAX_UTC_HOUR, '::timestamptz')}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildScorerImplicationEdges(): Promise<number> {
  // statement_timeout lifted for parity with the sibling builders (see run-edge-builder.ts).
  const n = await runEdgeBuilderSql(buildScorerImplicationEdgesSql());
  log.info('scorer-implication: ' + n + ' edges');
  return n;
}
