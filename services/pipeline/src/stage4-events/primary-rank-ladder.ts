/**
 * primary-rank-ladder — "place-first ⟹ advance" implication (Stage 4).
 *
 * PARKED — NOT WIRED. The remaining activation step is wiring
 * buildPrimaryRankLadderEdges() into finalize.ts next to
 * electionPrecondition; that is a deliberate, not-yet-taken step.
 *
 * RULE: rank-1 ⟹ rank-≤N. A `kalshi:place-first-primary` node "Will X place
 * first in the <race> primary?" (election_outcome_winner,
 * monotonic_threshold/below/1/'rank') strictly implies the same candidate's
 * "Will X advance …?" node (primary_winner, below/N/'rank', N≥2) for the same
 * race: placing first is sufficient for finishing in the top N. The reverse
 * is false (a candidate advances without placing first) — exactly the fake
 * equivalence the Stage-3 ADVANCE×PLACE-FIRST guard (guards.ts) refuses;
 * this builder is its sound one-directional companion.
 *
 * SAME-RACE GATE: the advance side's canonical_event is the party-free race
 * (`2026 ca-45 primary`); the place-first side still stamps the per-party form
 * (`2026 ca-45 democratic primary`). The join accepts exact folded equality OR
 * the party-inserted form: a.ce = '<race-prefix> <one party segment> primary'
 * where b.ce = '<race-prefix> primary'. Both stamps are deterministic, so the
 * LIKE is over a closed vocabulary. Candidate identity = KB-resolved
 * canonical_subject equality (both non-null); year identity rides inside the
 * ce prefix and is double-pinned by the year-grain condition_date comparison.
 *
 * EDGE CONTRACT: edge_type='strict_implication', pattern='primary_rank_ladder',
 * confidence=1.0, deterministic=TRUE, source='algorithmic'. Ω/LP effect:
 * p(place-first) ≤ p(advance) — forbids the impossible {first=YES,
 * advance=NO} while keeping {advance=YES, first=NO} admissible.
 */
import { createLogger } from '@arb/logger';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  foldedTextEqSql,
} from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-primary-rank-ladder');

const PRIMARY_RANK_LADDER_PATTERN = 'primary_rank_ladder' as const;

/** Exported so the EXPLAIN/dry-run probe + tests can validate the SQL without executing it. */
export function buildPrimaryRankLadderEdgesSql(): string {
  return `
    WITH ${nodeFactsCte()},
    pair AS (
      SELECT a.question_id AS aq, b.question_id AS bq
      FROM node_facts a
      JOIN node_facts b
        ON a.question_id <> b.question_id
       -- antecedent = the rank-1 place-first node
       AND a.event_kind = 'election_outcome_winner'
       AND a.condition_direction = 'below'
       AND a.value_primary = 1
       AND lower(a.value_unit) = 'rank'
       -- consequent = the rank-≤N advance node (N≥2)
       AND b.event_kind = 'primary_winner'
       AND b.condition_direction = 'below'
       AND b.value_primary >= 2
       AND lower(b.value_unit) = 'rank'
       -- same candidate (KB-resolved person), both known
       AND a.canonical_subject IS NOT NULL
       AND a.canonical_subject = b.canonical_subject
       -- same race: exact folded ce equality, or the place-first side's
       -- per-party ce = the advance side's race ce with ONE inserted segment
       AND right(btrim(a.canonical_event), 8) = ' primary'
       AND right(btrim(b.canonical_event), 8) = ' primary'
       AND (
         ${foldedTextEqSql('a.canonical_event', 'b.canonical_event')}
         OR lower(immutable_unaccent(btrim(a.canonical_event))) LIKE
            left(lower(immutable_unaccent(btrim(b.canonical_event))),
                 length(btrim(b.canonical_event)) - 7) || '% primary'
       )
       -- year double-pin (both sides stamp event-year '<year>-01-01')
       AND left(a.condition_date::text, 4) IS NOT DISTINCT FROM left(b.condition_date::text, 4)
    ),
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT
        aq, bq,
        ${edgeContractSql('strict_implication', PRIMARY_RANK_LADDER_PATTERN)},
        'rank-1 ⟹ rank-≤N: placing first in a top-N primary is sufficient for advancing from it — the sound one-directional companion to the Stage-3 ADVANCE×PLACE-FIRST refusal guard (DW-58)'
      FROM pair
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

/** PARKED — do not call before the activation checklist completes. */
export async function buildPrimaryRankLadderEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildPrimaryRankLadderEdgesSql());
  log.info('primary-rank-ladder: ' + n + ' edges');
  return n;
}
