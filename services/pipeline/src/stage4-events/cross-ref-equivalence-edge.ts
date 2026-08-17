/**
 * Cross-reference EQUIVALENCE edges (pattern `cross_ref_equiv`, source `platform_structure`).
 *
 * Consumes the platform-NATIVE cross-platform links in `market_cross_refs` — Predict.fun's
 * `raw.polymarketConditionIds[]`, a ground-truth equivalence declaration maintained by their
 * team and resolved to a target_market_id at sync time (sync.ts extractMarketCrossRefs).
 * When the two linked markets land in DIFFERENT outcome-nodes (the matcher didn't already
 * collapse them), we add an `equivalence` edge so the solver forbids the world A<>B.
 *
 * WHY A SEPARATE, LEANER BUILDER (not buildEquivalenceEdges):
 *   buildEquivalenceEdges relies on noisy heuristics (same canonical_event/event_kind/
 *   subject/value, title discriminators, scope refusal) to PROVE two questions are the same
 *   outcome. Here the shared on-chain UMA conditionId is a STRONGER guarantee than any
 *   title/field match — both legs settle off the SAME conditionId by construction, so they
 *   cannot diverge on not-played / ET / refund (the FT/ET Σ≤1 objection does NOT apply).
 *   Applying buildEquivalenceEdges' field guards would FALSELY REJECT many of the pairs this
 *   builder exists to recover. So we deliberately BYPASS the heuristics and trust the
 *   per-row conditionId as the authority — keeping ONLY a cross-platform sanity assert and
 *   the distinct-node + orientation filters.
 *
 * SOUNDNESS:
 *   · An equivalence removes the world A<>B. For cross_ref both legs resolve off the same
 *     conditionId, so divergence is impossible — never a fake arb.
 *   · MUTEX (same outcome_set) overlap: a distinct-node pair that shares an outcome_set is a
 *     GENUINE cross-platform DUPLICATE of one outcome the categorical-set builder over-split
 *     into different slots — a recall WIN, not a mutex. The conditionId is a stronger
 *     over-split exemption proof than title-identity, so we do NOT blanket-reject same-set
 *     pairs.
 *   · Verified 1:1 mapping (no fan-in over-merge / bare-label collapse) on the live data.
 *   · Residual real risk = Predict publishing a wrong conditionId (their declared ground
 *     truth) — acknowledged, small, not guarded.
 *   NET: bypassing the title heuristics removes false-NEGATIVES (recall) and adds no
 *   false-positives.
 *
 * Idempotent: ON CONFLICT (antecedent, consequent) DO NOTHING; the (antecedent<consequent)
 * orientation matches the UNIQUE constraint. Most cross-refs already collapse to one node via
 * feed-A matching, so only a minority need an explicit edge.
 */
import { createLogger } from '@arb/logger';
import { EDGE_CONFLICT_SQL, edgeContractSql } from '../util/sql-fragments.js';
// A fixture-shaped "subject" ("Brewers vs. Cubs") names the GAME, not the
// outcome — it can never be the fold-match proof the side-flip guard needs.
import { isFixturePlaceholderSubjectSql } from '../util/placeholder-outcomes.js';
// The settlement-DIMENSION fact + its keep-conjunct (both SQL twins).
import {
  settlementDimensionSql, settlementDimensionCompatibleSql,
} from '../util/settlement-instrument.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';

const log = createLogger('stage4-cross-ref-equivalence-edge');

/** Exported so the EXPLAIN probe + tests can validate the SQL without executing it. */
export function buildCrossRefEquivalenceEdgesSql(): string {
  return `
    WITH cand AS (
      SELECT DISTINCT
             LEAST(sm.question_id, tm.question_id)    AS aq,
             GREATEST(sm.question_id, tm.question_id) AS bq
      FROM market_cross_refs r
      JOIN question_members sm ON sm.market_id = r.source_market_id
      JOIN question_members tm ON tm.market_id = r.target_market_id
      -- Every other builder excludes archived questions (nodeFactsCte does it
      -- centrally); this lean builder joined only question_members, so an
      -- edge could be minted against an ARCHIVED question that still holds a
      -- member row — a phantom constraint on a slot the solver should not see.
      JOIN questions qs ON qs.id = sm.question_id AND qs.archived_at IS NULL
      JOIN questions qt ON qt.id = tm.question_id AND qt.archived_at IS NULL
      -- raw settlement prose of the two LINKED markets (pk lookups) → the
      -- cross-dimension refusal below. LEFT so a missing raw row never drops a pair.
      LEFT JOIN market_metadata_raw rs ON rs.market_id = r.source_market_id
      LEFT JOIN market_metadata_raw rt ON rt.market_id = r.target_market_id
      WHERE r.target_market_id IS NOT NULL
        AND sm.question_id <> tm.question_id   -- already-merged refs collapse to one node (no edge)
        AND sm.platform <> tm.platform         -- cross-platform sanity (live data is 100% predict->poly)
        -- SIDE-FLIP guard. A conditionId link asserts the two legs are the
        -- SAME outcome, and this builder deliberately TRUSTS it over
        -- heuristics — but a mis-legged PM moneyline (upstream LLM
        -- leg-mapping, out of scope here) can point the link at the OPPOSITE
        -- team, minting a fake CLEAN arb. For an H2H/moneyline leg the YES
        -- side IS the team (canonical_subject), so refuse when EITHER leg is
        -- match_winner UNLESS the two subjects are both KNOWN and fold-match
        -- (equal or substring — spelling drift 'KT' vs 'KT Rolster' stays).
        -- NULL subject (title names no side) or a fold-mismatch → refuse.
        -- Scoped to match_winner so the bulk of non-H2H cross-refs keep their
        -- conditionId trust.
        -- The fold-match proof above is VACUOUS when the "subject" is a
        -- FIXTURE NAME ("Brewers vs. Cubs"): both sides of a game carry the
        -- same fixture string, so a mis-legged moneyline would pass the
        -- equality arm trivially and the conditionId trust would re-mint the
        -- side-flip this guard exists to stop. A fixture-shaped subject is
        -- therefore NOT a known subject here: it fails the proof and the pair
        -- is refused (identical treatment to a NULL subject).
        AND NOT (
          (qs.event_kind = 'match_winner' OR qt.event_kind = 'match_winner')
          AND NOT (
            qs.canonical_subject IS NOT NULL AND qt.canonical_subject IS NOT NULL
            AND NOT ${isFixturePlaceholderSubjectSql('qs.canonical_subject')}
            AND NOT ${isFixturePlaceholderSubjectSql('qt.canonical_subject')}
            AND (
              lower(immutable_unaccent(btrim(qs.canonical_subject))) = lower(immutable_unaccent(btrim(qt.canonical_subject)))
              OR lower(immutable_unaccent(btrim(qs.canonical_subject))) ILIKE '%' || lower(immutable_unaccent(btrim(qt.canonical_subject))) || '%'
              OR lower(immutable_unaccent(btrim(qt.canonical_subject))) ILIKE '%' || lower(immutable_unaccent(btrim(qs.canonical_subject))) || '%'
            )
          )
        )
        -- A conditionId link asserts the two legs settle on the SAME thing,
        -- so if their own settlement prose names two DIFFERENT measured
        -- quantities the link is contradicted by the markets themselves —
        -- refuse rather than let the conditionId trust override the
        -- evidence. Both-known-and-differ only; NULL (the overwhelming
        -- majority) passes untouched.
        AND ${settlementDimensionCompatibleSql(settlementDimensionSql('rs.raw'), settlementDimensionSql('rt.raw'))}
    ),
    -- cross_ref is the AUTHORITY over heuristic algorithmic edges on the SAME
    -- pair. The conditionId ground-truth says these two nodes are the SAME
    -- outcome, so any pre-existing algorithmic cross_question_mutex or
    -- cross_question_equiv on (aq,bq) is unsound/redundant and must yield.
    -- DELETE it before inserting the equivalence (the plain ON CONFLICT below
    -- would otherwise silently keep the wrong mutex). Monotone-safe: replaces
    -- an unsound world-removal (mutex) with the sound one (equivalence),
    -- never mints a new world.
    del AS (
      DELETE FROM implication_edges e
      USING cand c
      WHERE e.antecedent_question_id = c.aq
        AND e.consequent_question_id = c.bq
        AND e.source = 'algorithmic'
      RETURNING 1
    ),
    -- basis_risk is DELIBERATELY left NULL for cross_ref_equiv. These pairs
    -- are cross-VENUE (predict <> polymarket) but NOT cross-SETTLEMENT: both
    -- legs resolve off the SAME UMA conditionId (Predict's declared ground
    -- truth), so they CANNOT diverge on not-played / ET / refund — the
    -- header's soundness argument. The cross_venue_settlement tag denotes
    -- SETTLEMENT divergence, which is impossible here, so tagging would be a
    -- false risk flag. (The heuristic buildEquivalenceEdges + the mutex-xq
    -- builder DO tag their cross-platform fixture/championship edges, where
    -- the two venues settle independently.) The column keeps its NULL
    -- default — no column-list change.
    ins AS (
      INSERT INTO implication_edges
        (antecedent_question_id, consequent_question_id, edge_type, pattern, confidence, deterministic, source, confirmed, reasoning)
      SELECT c.aq, c.bq, ${edgeContractSql('equivalence', 'cross_ref_equiv', { source: 'platform_structure' })}, TRUE,
             'predict->polymarket conditionId ground-truth equivalence'
      FROM cand c
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `;
}

/**
 * Reap stale cross_ref_equiv edges with a MEMBER-LESS endpoint.
 *
 * The INSERT path cannot mint such an edge (cand joins question_members on both
 * legs), but an edge minted in an EARLIER run goes stale when a member later
 * re-homes (ON CONFLICT (market_id) DO UPDATE) or is reaped: the old question
 * keeps the edge but loses its members (updateAllQuestionCounts archives an
 * edge only when BOTH endpoints are archived, so one-live-endpoint edges
 * survive). An equivalence on a member-less node constrains a slot no market
 * backs — deleting it only re-admits worlds (sound, mirrors the del CTE idiom
 * above). Run BEFORE the insert so a re-pointed pair gets its fresh edge the
 * same run.
 */
export function reapMemberlessCrossRefEdgesSql(): string {
  return `
    WITH del AS (
      DELETE FROM implication_edges e
      WHERE e.pattern = 'cross_ref_equiv'
        AND (
          NOT EXISTS (SELECT 1 FROM question_members qm WHERE qm.question_id = e.antecedent_question_id)
          OR NOT EXISTS (SELECT 1 FROM question_members qm WHERE qm.question_id = e.consequent_question_id)
          -- An ARCHIVED endpoint is as stale as a member-less one; the insert
          -- path refuses both, so this reaps any edge that predates that gate
          OR EXISTS (SELECT 1 FROM questions q WHERE q.id = e.antecedent_question_id AND q.archived_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM questions q WHERE q.id = e.consequent_question_id AND q.archived_at IS NOT NULL)
        )
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM del
  `;
}

export async function buildCrossRefEquivalenceEdges(): Promise<number> {
  const reaped = await runEdgeBuilderSql(reapMemberlessCrossRefEdgesSql());
  if (reaped > 0) {
    log.info('cross-ref-equivalence-edge: reaped ' + reaped + ' stale edge(s) with a member-less endpoint (W1-C)');
  }
  const n = await runEdgeBuilderSql(buildCrossRefEquivalenceEdgesSql());
  log.info('cross-ref-equivalence-edge: ' + n + ' edges');
  return n;
}
