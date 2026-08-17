/**
 * numeric-ladder-xq — cross-question monotone numeric threshold ladder: two
 * separate questions, same resolving event/metric/unit/direction, where the
 * stricter threshold implies the looser. Complements finalize's within-set
 * buildThresholdLadderEdges; overlap dedupes via ON CONFLICT. Antecedent is
 * always the stricter threshold, so each pair yields exactly one directed edge.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  foldedTextEqSql,
  sameSliceScopeSql,
} from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';
import { sameEventFragment } from './same-event.js';
import { beltHit } from '../discriminators/telemetry.js';

const log = createLogger('stage4-numeric-ladder-xq');

/**
 * A player-prop canonical_event embeds only player+metric, not the game instant, so
 * two different games can fold equal. Refuse only when both sides carry a
 * fine-grained instant ≥ this far apart; NULL/coarse dates pass untouched.
 */
export const CROSS_EVENT_GAP_MS = parseInt(
  process.env.STAGE4_CROSS_EVENT_GAP_MS ?? `${20 * 60 * 60 * 1000}`,
  10,
);

/** Wrapped in `NOT (...)` by the builder; exported so the archival script shares one definition with it. */
export function crossEventInstantRefusalSql(a: string, b: string): string {
  const gapSec = Math.round(CROSS_EVENT_GAP_MS / 1000);
  return `(
         ${a}.condition_date IS NOT NULL AND ${b}.condition_date IS NOT NULL
         AND ${a}.condition_date_precision IN ('minute','hour')
         AND ${b}.condition_date_precision IN ('minute','hour')
         AND ABS(EXTRACT(EPOCH FROM (${a}.condition_date - ${b}.condition_date))) >= ${gapSec}
       )`;
}

/** Stage-2a stamps condition_date after markets appear; a game-scoped kind with a NULL/coarse instant must not ladder this cycle. */
export const GAME_SCOPED_LADDER_KINDS_SQL = `('player_prop_threshold')`;

/** Wrapped in `NOT (...)` by the builder. */
export function undatedGameScopedLadderRefusalSql(a: string, b: string): string {
  return `(
         ${a}.event_kind IN ${GAME_SCOPED_LADDER_KINDS_SQL}
         AND (
           ${a}.condition_date IS NULL OR ${b}.condition_date IS NULL
           OR ${a}.condition_date_precision IN ('year','month')
           OR ${b}.condition_date_precision IN ('year','month')
         )
       )`;
}

/** Mirrors {@link undatedGameScopedLadderRefusalSql}; keep in sync. */
export function isUndatedGameScopedLadder(
  eventKind: string | null,
  aDate: Date | null,
  aPrecision: string | null,
  bDate: Date | null,
  bPrecision: string | null,
): boolean {
  if (eventKind !== 'player_prop_threshold') return false;
  return (
    aDate == null || bDate == null ||
    aPrecision === 'year' || aPrecision === 'month' ||
    bPrecision === 'year' || bPrecision === 'month'
  );
}

/** Mirrors {@link crossEventInstantRefusalSql}; keep in sync. */
export function isCrossEventInstant(
  aDate: Date | null,
  aPrecision: string | null,
  bDate: Date | null,
  bPrecision: string | null,
): boolean {
  if (aDate == null || bDate == null) return false;
  if (aPrecision !== 'minute' && aPrecision !== 'hour') return false;
  if (bPrecision !== 'minute' && bPrecision !== 'hour') return false;
  return Math.abs(aDate.getTime() - bDate.getTime()) >= CROSS_EVENT_GAP_MS;
}

/** Single-terminal-scalar kinds only; player_prop_threshold needs the extra canonical_subject gate below. */
const LADDER_KINDS_SQL =
  `('price_threshold','crypto_launch_fdv','weather_extreme','election_turnout','approval_rating','player_prop_threshold')`;

/** Excludes range_snapshot/between (interior buckets, not nested half-lines). */
const LADDER_SHAPES_SQL = `('monotonic_threshold','point_in_time')`;

/** Exported so the EXPLAIN probe + shape test can validate the SQL without executing it. */
export function buildNumericLadderXqEdgesSql(): string {
  return `
    WITH ${nodeFactsCte()},
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id,
             ${edgeContractSql('strict_implication', 'numeric_ladder_xq')},
             'numeric ladder (xq): stricter threshold implies looser, same event+metric+unit'
      FROM node_facts a
      JOIN node_facts b
        -- cheap hashable equality first (Tier-2 key) so the planner hashes
        ON ${foldedTextEqSql('a.canonical_event', 'b.canonical_event')}
       AND a.question_id <> b.question_id
       -- same comparable quantity + direction
       AND a.condition_metric IS NOT DISTINCT FROM b.condition_metric
       AND a.value_unit       IS NOT DISTINCT FROM b.value_unit
       AND a.condition_direction = b.condition_direction
       -- same subject gate (load-bearing for player_prop_threshold). canonical_event
       -- for a player prop embeds player+metric ("Victor Wembanyama points"), so the
       -- canonical_event equality above already separates players in practice; this
       -- explicit equality is the belt to its suspenders, guaranteeing we never
       -- ladder two distinct players who share metric/unit/event-name. NULL-tolerant
       -- (IS NOT DISTINCT FROM) so the non-player kinds — whose canonical_event maps
       -- 1:1 to a subject anyway and may legitimately carry a NULL subject — are
       -- unaffected. Player subjects are a clean entity (never embeds a
       -- value/threshold token), so this never mis-splits a real ladder.
       AND a.canonical_subject IS NOT DISTINCT FROM b.canonical_subject
       -- metric_scope gate — future-proofing: a no-op today (LADDER_KINDS
       -- excludes match_total_metric / per-fixture sports totals, the only kinds
       -- that carry a scope), but kept so that when sports totals are later
       -- allowlisted a team-total never ladders against a game-total. Asymmetric
       -- NULL: both-known-and-differ rejects, and a NULL side may no longer be
       -- laddered against a SUB-FIXTURE slice — the order ideal z_i ≤ z_{i+1}
       -- is exactly the shape that would turn independent per-innings marks
       -- into a fake nesting.
       AND ${sameSliceScopeSql('a.metric_scope', 'b.metric_scope')}
       -- nested half-line thresholds only (reject range_snapshot/between)
       AND a.condition_shape IN ${LADDER_SHAPES_SQL}
       AND b.condition_shape IN ${LADDER_SHAPES_SQL}
       -- same shape: touch and snapshot are different YES-regions over the
       -- path space — a mixed pair would emit touch(K_hi) ⟹ snapshot(K_lo),
       -- UNSOUND (spike to K_hi intraday, close below K_lo). The sound mixed
       -- direction (snapshot ⟹ touch) is a DIFFERENT rule with its own
       -- orientation, not this ladder.
       AND a.condition_shape = b.condition_shape
       -- NULL-rejecting: an unvalued threshold cannot be ordered
       AND a.value_primary IS NOT NULL
       AND b.value_primary IS NOT NULL
       -- single-quantity kind allowlist (both equal, both in the set)
       AND a.event_kind = b.event_kind
       AND a.event_kind IN ${LADDER_KINDS_SQL}
       -- orientation: antecedent is the STRICTER threshold (one directed edge / pair)
       AND (
             (a.condition_direction = 'above' AND a.value_primary > b.value_primary)
          OR (a.condition_direction = 'below' AND a.value_primary < b.value_primary)
       )
       -- same resolving event (Tier-1 pe+ordinal / Tier-2 xplat / Tier-3 refusal)
       AND ${sameEventFragment('a', 'b')}
       -- cross-event instant gate: sameEventFragment's canonical_event fold is
       -- instant-blind (a player-prop ce embeds player+metric, not the game
       -- time), so two DIFFERENT games of one player fold equal and the
       -- day-tolerant date ladder passes → fake cross-game / season⟹game
       -- ladders. Refuse when both sides carry a PROVEN fine instant ≥20h
       -- apart (the UTC-rollover artifact tail is <20h).
       AND NOT ${crossEventInstantRefusalSql('a', 'b')}
       -- game-scoped undated gate: the ≥20h gate needs known instants, but a
       -- cross-game fake can be born pre-Stage-2a-stamp (NULL date → the date
       -- ladder's NULL/coarse disjuncts pass). A per-game kind with an
       -- undated/coarse resolving instant must not ladder this cycle — it
       -- rebuilds once the date lands.
       AND NOT ${undatedGameScopedLadderRefusalSql('a', 'b')}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildNumericLadderXqEdges(): Promise<number> {
  // statement_timeout is lifted for this heavy self-join; temp_file_limit is the real guard.
  const n = await runEdgeBuilderSql(buildNumericLadderXqEdgesSql());
  log.info('numeric-ladder-xq: ' + n + ' edges');
  const refused = await countCrossEventLadderViolations(); // expected 0 on a fresh rebuild
  for (let i = 0; i < refused; i++) beltHit('stage4_refuse_cross_event_ladder');
  if (refused > 0) {
    log.warn(
      `numeric-ladder-xq: ${refused} LIVE cross-event ladder edge(s) ≥20h apart survive the pre-gate mint ` +
        `(belt.stage4_refuse_cross_event_ladder) — archive via scripts/archive-unsound-edges-2026-07-21.ts (G1/§A1)`,
    );
  }
  const undated = await countUndatedGameScopedLadderViolations(); // expected 0 on a fresh rebuild
  for (let i = 0; i < undated; i++) beltHit('s4_refuse_ladder_undated');
  if (undated > 0) {
    log.warn(
      `numeric-ladder-xq: ${undated} LIVE undated/coarse game-scoped ladder edge(s) survive the pre-gate mint ` +
        `(belt.s4_refuse_ladder_undated) — pre-Stage-2a-stamp escape hatch (G1 addendum)`,
    );
  }
  return n;
}

async function countUndatedGameScopedLadderViolations(): Promise<number> {
  const rows = await query<{ n: number }>(
    `WITH ladder AS (
       SELECT e.antecedent_question_id AS aq, e.consequent_question_id AS bq
       FROM implication_edges e
       JOIN questions qa ON qa.id = e.antecedent_question_id
       WHERE e.pattern = 'numeric_ladder_xq' AND e.archived_at IS NULL
         AND qa.event_kind = 'player_prop_threshold'
     ),
     inst AS (
       SELECT l.aq, l.bq, ea.condition_date AS ad, ea.condition_date_precision AS ap,
              eb.condition_date AS bd, eb.condition_date_precision AS bp
       FROM ladder l
       JOIN LATERAL (
         SELECT pe.condition_date, pe.condition_date_precision
         FROM question_members qm JOIN markets m ON m.id = qm.market_id
         LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
         WHERE qm.question_id = l.aq ORDER BY m.id LIMIT 1
       ) ea ON TRUE
       JOIN LATERAL (
         SELECT pe.condition_date, pe.condition_date_precision
         FROM question_members qm JOIN markets m ON m.id = qm.market_id
         LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
         WHERE qm.question_id = l.bq ORDER BY m.id LIMIT 1
       ) eb ON TRUE
     )
     SELECT count(*)::int AS n FROM inst
      WHERE ad IS NULL OR bd IS NULL OR ap IN ('year','month') OR bp IN ('year','month')`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Bounded by the live edge count, not the O(n^2) node product — cheap even at rebuild scale. */
async function countCrossEventLadderViolations(): Promise<number> {
  const gapSec = Math.round(CROSS_EVENT_GAP_MS / 1000);
  const rows = await query<{ n: number }>(
    `WITH ladder AS (
       SELECT e.antecedent_question_id AS aq, e.consequent_question_id AS bq
       FROM implication_edges e
       WHERE e.pattern = 'numeric_ladder_xq' AND e.archived_at IS NULL
     ),
     inst AS (
       SELECT l.aq, l.bq, ea.condition_date AS ad, ea.condition_date_precision AS ap,
              eb.condition_date AS bd, eb.condition_date_precision AS bp
       FROM ladder l
       JOIN LATERAL (
         SELECT pe.condition_date, pe.condition_date_precision
         FROM question_members qm JOIN markets m ON m.id = qm.market_id
         LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
         WHERE qm.question_id = l.aq ORDER BY m.id LIMIT 1
       ) ea ON TRUE
       JOIN LATERAL (
         SELECT pe.condition_date, pe.condition_date_precision
         FROM question_members qm JOIN markets m ON m.id = qm.market_id
         LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
         WHERE qm.question_id = l.bq ORDER BY m.id LIMIT 1
       ) eb ON TRUE
     )
     SELECT count(*)::int AS n FROM inst
      WHERE ad IS NOT NULL AND bd IS NOT NULL
        AND ap IN ('minute','hour') AND bp IN ('minute','hour')
        AND ABS(EXTRACT(EPOCH FROM (ad - bd))) >= ${gapSec}`,
  );
  return Number(rows[0]?.n ?? 0);
}
