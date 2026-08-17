/**
 * election-precondition-edge — "win ⟹ on-ballot" implication (Stage 4).
 *
 * RULE: an `election_outcome_winner` node "Will X win <election>?" strictly
 * implies "Will X be on the ballot for <election>?" (and the "qualify" /
 * "nominee" / "make the runoff" precondition phrasings) for the SAME candidate +
 * SAME election. Being on the ballot is NECESSARY for winning, so
 * win=YES ⟹ ballot=YES.
 *
 * This is the SOUND companion to equivalence-edge.ts guard S4: S4 removes the
 * FAKE EQUIVALENCE (ballot ≢ win — the world {ballot=YES, win=NO} is real, e.g.
 * a candidate on the ballot who loses), and this builder emits the genuine
 * one-directional implication those same pairs actually carry, so recall is
 * preserved rather than dropped. Antecedent = the WIN node (title does NOT match
 * ELECTION_PRECONDITION_RX); consequent = the precondition/ballot node (title
 * matches). The XOR guarantees exactly one side is a precondition.
 *
 * Same-candidate+election identity reuses the equivalence builder's field gates
 * (folded canonical_event equality + sameEventFragment + canonical_subject +
 * direction/metric/value equality), so this emits over exactly the pairs S4
 * rejects.
 *
 * Edge contract: edge_type='strict_implication', pattern='election_precondition',
 * confidence=1.0, deterministic=TRUE, source='algorithmic', ON CONFLICT
 * (antecedent, consequent) DO NOTHING.
 *
 * Ω/LP effect: replaces the removed (unsound) equality facet p(win)=p(ballot)
 * with the SOUND facet p(win) ≤ p(ballot) — keeps {ballot=YES, win=NO}
 * admissible while still forbidding the impossible {win=YES, ballot=NO}.
 */
import { createLogger } from '@arb/logger';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  foldedTextEqSql,
} from '../util/sql-fragments.js';
import { ELECTION_PRECONDITION_RX } from './equivalence-edge.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';
import { sameEventFragment } from './same-event.js';

const log = createLogger('stage4-election-precondition');

/** Exported so the EXPLAIN/dry-run probe + tests can validate the SQL without executing it. */
export function buildElectionPreconditionEdgesSql(): string {
  return `
    WITH ${nodeFactsCte()},
    pair AS (
      SELECT a.question_id AS aq, b.question_id AS bq,
             (lower(immutable_unaccent(a.title)) ~ '${ELECTION_PRECONDITION_RX}') AS a_pre,
             (lower(immutable_unaccent(b.title)) ~ '${ELECTION_PRECONDITION_RX}') AS b_pre
      FROM node_facts a
      JOIN node_facts b
        ON ${foldedTextEqSql('a.canonical_event', 'b.canonical_event')}
       AND a.question_id < b.question_id
       AND ${sameEventFragment('a', 'b')}
       -- same outcome family: both election winners, same candidate, same value
       -- (mirrors the equivalence builder's SAME-OUTCOME/SAME-VALUE gates, so this
       --  emits over EXACTLY the precondition-vs-win pairs S4 rejects)
       AND a.event_kind = 'election_outcome_winner'
       AND b.event_kind = 'election_outcome_winner'
       AND a.canonical_subject   IS NOT DISTINCT FROM b.canonical_subject
       AND a.condition_direction IS NOT DISTINCT FROM b.condition_direction
       AND a.condition_metric    IS NOT DISTINCT FROM b.condition_metric
       AND a.value_primary       IS NOT DISTINCT FROM b.value_primary
       AND a.value_secondary     IS NOT DISTINCT FROM b.value_secondary
       AND a.value_unit          IS NOT DISTINCT FROM b.value_unit
    ),
    ins AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT
        -- antecedent = WIN (the NON-precondition side); consequent = BALLOT
        -- (the precondition side). p(win) ≤ p(ballot).
        CASE WHEN a_pre THEN bq ELSE aq END,
        CASE WHEN a_pre THEN aq ELSE bq END,
        ${edgeContractSql('strict_implication', 'election_precondition')},
        'win ⟹ on-ballot: winning an election requires being on its ballot — the sound one-directional companion to equivalence guard S4 (ballot is necessary-not-sufficient for win)'
      FROM pair
      WHERE a_pre <> b_pre   -- XOR: exactly one side is a precondition title
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

export async function buildElectionPreconditionEdges(): Promise<number> {
  const n = await runEdgeBuilderSql(buildElectionPreconditionEdgesSql());
  log.info('election-precondition: ' + n + ' edges');
  return n;
}
