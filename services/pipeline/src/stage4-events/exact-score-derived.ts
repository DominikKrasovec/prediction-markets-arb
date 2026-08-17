/** Derives cross-kind deterministic edges from an exact_score fixture fact: CLASS A/A2
 *  (winner/draw, strict_implication), CLASS B (O/U total — over is strict_implication,
 *  under is MUTUAL_EXCLUSION since exact_score doesn't imply the over-node; boundary
 *  excluded), CLASS C (BTTS, YES-only). All classes gate on sameFixtureFragment, not
 *  sameEventFragment (its Tier-2 hard-requires equal event_kind, which cross-kind pairs
 *  never have). Mirrors the canonical Stage-4 node-facts CTE + INSERT…SELECT shape. */
import { createLogger } from '@arb/logger';
import { EDGE_INSERT_COLUMNS_SQL, EDGE_CONFLICT_SQL, edgeContractSql, unitsCompatibleSql } from '../util/sql-fragments.js';
import { nodeFactsCte } from './node-facts.js';
import { runEdgeBuilderSql } from './run-edge-builder.js';
import { sameFixtureFragment } from './same-event.js';

const log = createLogger('stage4-exact-score-derived');

// Pure-TS mirrors of the SQL semantics below (unit-testable directly) — keep in sync.

/** participants[] is ALPHABETIZED, so the winner is argmax(vp,vs) resolved via
 *  canonical_subject, not participant order. */
export function impliedWinnerSubject(
  subject: string,
  vp: number,
  vs: number,
  participants: readonly string[],
): string | null {
  if (vp === vs) return null;                       // draw → CLASS A2
  if (vp > vs) return subject;                        // subject's side won
  return participants.find((p) => p !== subject) ?? null; // the other participant won
}

/** total = vp + vs against an "over" (direction='above') line; 'boundary' (total==line) is excluded. */
export function totalOverUnderSide(vp: number, vs: number, line: number): 'over' | 'under' | 'boundary' {
  const total = vp + vs;
  if (total > line) return 'over';
  if (total < line) return 'under';
  return 'boundary';
}

/** CLASS C BTTS: an exact score implies "both teams score = YES" iff both >= 1. */
export function impliesBtts(vp: number, vs: number): boolean {
  return vp >= 1 && vs >= 1;
}

/** Two single-team match_spread nodes are mutex iff both are single-team and on different
 *  teams; same-team threshold pairs are a ladder, not a mutex. */
export function spreadOppositeTeamMutex(
  aParticipants: readonly string[],
  bParticipants: readonly string[],
): boolean {
  if (aParticipants.length !== 1 || bParticipants.length !== 1) return false; // single-team only
  return aParticipants[0] !== bParticipants[0];                                // distinct team
}

/** Keeps the exact_score node's own TEAM canonical_subject (not fixture-subject), since orientation depends on it. */
const WINNER_SUBJECT_SQL = `(
  CASE
    WHEN a.value_primary > a.value_secondary THEN a.canonical_subject
    ELSE (SELECT p FROM unnest(a.participants) p WHERE p <> a.canonical_subject LIMIT 1)
  END
)`;

/** True iff the consequent is a slot in a CATEGORICAL outcome_set (supplies the NO-side). */
const IN_CATEGORICAL_SET_SQL = `EXISTS (
  SELECT 1 FROM outcome_set_slots s
  JOIN outcome_sets os ON os.id = s.set_id
  WHERE s.question_id = b.question_id AND os.set_type = 'categorical'
)`;

/** The argmax orientation only names the winner correctly when the exact_score node's own
 *  canonical_subject is a participating team; a score-label or 'Draw' subject drops the edge. */
export function subjectIsParticipant(subject: string, participants: readonly string[]): boolean {
  return participants.includes(subject);
}

/** Exported so the EXPLAIN probe + tests can validate the SQL without executing it. */
export function buildExactScoreDerivedEdgesSql(): string {
  return `
    WITH ${nodeFactsCte()},
    -- ANTECEDENT-PURITY GATE (2026-07-22, cluster-5820 clean-fake trace): every arm
    -- reads the exact_score antecedent 'a's scoreline (value_primary/secondary) to
    -- derive winner/total/btts constraints. That is sound ONLY when 'a' is a PURE
    -- correct-score node. A Stage-2 grain over-merge fused a Kalshi correct-score
    -- market ("RB wins 1-0", event_kind=exact_score) with the PM MONEYLINE ("Will RB
    -- win?") into one question, so it inherits the MINIMAL scoreline 1-0 while the
    -- moneyline member wins on ANY scoreline → the derived "total=1" mutex prunes the
    -- real ≥2-goal worlds → a clean buy-all-NO fake (RB-win + both overs co-YES).
    -- Refuse any antecedent with a non-exact_score member (materialized once — never
    -- a per-pair correlated subquery, the mutex-builder wedge lesson).
    mixed_exact_score_q AS MATERIALIZED (
      SELECT DISTINCT qm.question_id
      FROM question_members qm
      JOIN questions q ON q.id = qm.question_id AND q.event_kind = 'exact_score'
      LEFT JOIN llm_market_normalizations n ON n.market_id = qm.market_id
      WHERE n.event_kind IS DISTINCT FROM 'exact_score'
    ),
    -- CLASS A — exact_score(vp <> vs) ⟹ match_winner(argmax side). strict_implication.
    ins_winner AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id, ${edgeContractSql('strict_implication', 'exact_score_winner')},
             'exact_score ⟹ winner (argmax score, same fixture, categorical complement)'
      FROM node_facts a
      JOIN node_facts b
        -- cheap equality FIRST so the planner hashes on the canonical_event key
        ON lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))
       AND a.event_kind = 'exact_score'
       AND NOT EXISTS (SELECT 1 FROM mixed_exact_score_q mg WHERE mg.question_id = a.question_id)  -- antecedent-purity gate (cluster-5820 fake)
       AND b.event_kind = 'match_winner'
       AND a.value_primary IS NOT NULL AND a.value_secondary IS NOT NULL
       AND a.value_primary <> a.value_secondary           -- draws routed to CLASS A2
       AND a.participants = b.participants
       AND b.canonical_subject = ${WINNER_SUBJECT_SQL}
       -- AUD-04: orientation prerequisite. WINNER_SUBJECT_SQL's argmax picks the
       -- higher-scoring side BY NAME, which only orients correctly when the
       -- exact_score node's OWN canonical_subject is a participating team. When
       -- the subject is a score-label string ('Exact Score: 0-1') or 'Draw'
       -- (the PM Template-J class), the argmax mis-names the winner → a backwards
       -- "decisive score ⟹ wrong team wins" edge. Gate to team-subject nodes;
       -- the score-label/draw nodes simply produce no winner edge (doubt → no
       -- edge). Scoped to ins_winner ONLY — over/under/btts are orientation-free.
       AND a.canonical_subject = ANY(a.participants)
       AND ${sameFixtureFragment('a', 'b')}
       AND ${IN_CATEGORICAL_SET_SQL}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    -- CLASS A2 — exact_score(vp = vs) ⟹ match_winner('Draw'). strict_implication.
    ins_draw AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id, ${edgeContractSql('strict_implication', 'exact_score_draw')},
             'exact_score (vp=vs) ⟹ Draw node (same fixture, categorical complement)'
      FROM node_facts a
      JOIN node_facts b
        ON lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))
       AND a.event_kind = 'exact_score'
       AND NOT EXISTS (SELECT 1 FROM mixed_exact_score_q mg WHERE mg.question_id = a.question_id)  -- antecedent-purity gate (cluster-5820 fake)
       AND b.event_kind = 'match_winner'
       AND a.value_primary IS NOT NULL AND a.value_secondary IS NOT NULL
       AND a.value_primary = a.value_secondary            -- the draw case
       -- WP-R4: identify the Draw consequent by the authoritative draw_axis stamp
       -- (outcome_label-derived, 100% correct incl. the Limitless team-labeled-draw
       -- class + 'tie'/'tied'/'deadlock' spellings) instead of the fragile
       -- canonical_subject='draw' string match, which missed every mislabeled-subject
       -- and non-'draw'-spelled draw node. b.event_kind='match_winner' is gated above
       -- and is a draw_axis kind, so the stamp is meaningful; NULL (ambiguous members /
       -- pre-rebuild) → no edge — the SAME doubt→no-edge soundness direction the string
       -- form had (and drops 0 current edges: every subject='draw' node stamps 'draw').
       AND b.discriminators->>'draw_axis' = 'draw'
       AND a.participants = b.participants
       AND ${sameFixtureFragment('a', 'b')}
       AND ${IN_CATEGORICAL_SET_SQL}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    -- CLASS B (over) — total > line ⟹ over TRUE. strict_implication.
    -- The consequent must be a MATCH-LEVEL O/U total (NOT a per-team total) and
    -- units must agree (NULL-tolerant), else the match total (vp+vs) would be
    -- compared against a per-team / different-unit threshold → fake arb.
    ins_over AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id, ${edgeContractSql('strict_implication', 'exact_score_total_over')},
             'exact_score total > line ⟹ over TRUE (same fixture, match-level O/U total)'
      FROM node_facts a
      JOIN node_facts b
        ON lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))
       AND a.event_kind = 'exact_score'
       AND NOT EXISTS (SELECT 1 FROM mixed_exact_score_q mg WHERE mg.question_id = a.question_id)  -- antecedent-purity gate (cluster-5820 fake)
       AND b.event_kind = 'match_total_metric'
       AND b.condition_direction = 'above'
       AND a.value_primary IS NOT NULL AND a.value_secondary IS NOT NULL
       AND b.value_primary IS NOT NULL
       AND a.participants = b.participants
       -- MATCH-LEVEL total only: reject per-team totals (subject is a participant)
       AND NOT (b.canonical_subject = ANY(b.participants))
       -- unit agreement (NULL-tolerant): never sum goals against a kills/maps line
       AND ${unitsCompatibleSql('a.value_unit', 'b.value_unit')}
       -- over TRUE: match total strictly exceeds the line (boundary == excluded)
       AND (a.value_primary + a.value_secondary) > b.value_primary
       AND ${sameFixtureFragment('a', 'b')}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    -- CLASS B (under) — total < line ⟹ over FALSE. MUTUAL_EXCLUSION (NOT an
    -- implication: the exact_score and the over-node cannot both be TRUE, but the
    -- exact_score does not IMPLY the over-node — emitting strict_implication here
    -- would be UNSOUND). Boundary (total == line) EXCLUDED.
    ins_under AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id, ${edgeContractSql('mutual_exclusion', 'exact_score_total_under')},
             'exact_score total < line ⟹ over FALSE (mutex with over-node, same fixture)'
      FROM node_facts a
      JOIN node_facts b
        ON lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))
       AND a.event_kind = 'exact_score'
       AND NOT EXISTS (SELECT 1 FROM mixed_exact_score_q mg WHERE mg.question_id = a.question_id)  -- antecedent-purity gate (cluster-5820 fake)
       AND b.event_kind = 'match_total_metric'
       AND b.condition_direction = 'above'
       AND a.value_primary IS NOT NULL AND a.value_secondary IS NOT NULL
       AND b.value_primary IS NOT NULL
       AND a.participants = b.participants
       AND NOT (b.canonical_subject = ANY(b.participants))
       AND ${unitsCompatibleSql('a.value_unit', 'b.value_unit')}
       -- over FALSE: match total strictly below the line (boundary == excluded)
       AND (a.value_primary + a.value_secondary) < b.value_primary
       AND ${sameFixtureFragment('a', 'b')}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    ),
    -- CLASS C (BTTS) — exact_score(vp>=1 ∧ vs>=1) ⟹ both_teams_score YES. The BTTS
    -- node is a binary_event whose TRUE outcome IS "both teams score", so the edge
    -- is YES-only; the NO-side is deferred (no categorical complement to supply it).
    ins_btts AS (
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.question_id, b.question_id, ${edgeContractSql('strict_implication', 'exact_score_btts')},
             'exact_score (both >= 1) ⟹ both_teams_score YES (same fixture)'
      FROM node_facts a
      JOIN node_facts b
        ON lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))
       AND a.event_kind = 'exact_score'
       AND NOT EXISTS (SELECT 1 FROM mixed_exact_score_q mg WHERE mg.question_id = a.question_id)  -- antecedent-purity gate (cluster-5820 fake)
       AND b.event_kind = 'both_teams_score'
       AND a.value_primary IS NOT NULL AND a.value_secondary IS NOT NULL
       AND a.value_primary >= 1 AND a.value_secondary >= 1
       AND a.participants = b.participants
       AND ${sameFixtureFragment('a', 'b')}
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*) FROM ins_winner)
      + (SELECT COUNT(*) FROM ins_draw)
      + (SELECT COUNT(*) FROM ins_over)
      + (SELECT COUNT(*) FROM ins_under)
      + (SELECT COUNT(*) FROM ins_btts) AS n
  `;
}

export async function buildExactScoreDerivedEdges(): Promise<number> {
  // statement_timeout lifted for this heavy self-join; temp_file_limit is the real guard.
  const n = await runEdgeBuilderSql(buildExactScoreDerivedEdgesSql());
  log.info('exact-score-derived: ' + n + ' edges (winner/draw/total-over/total-under/btts)');
  return n;
}
