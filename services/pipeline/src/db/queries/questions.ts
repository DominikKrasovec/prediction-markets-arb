/**
 * Queries for `questions` / `question_members` / `implication_edges` reconciliation.
 *
 * Post event-centric rewire, `questions` rows (outcome-nodes) are PROJECTED in
 * Stage 4 ([stage4-events/finalize.ts]) from semantic_event_legs
 * (`sem:<semantic_event_id>:<outcome_id>`) and un-matched platform_events
 * (`pe:<platform_event_id>:<market_id>`) — they are NOT hash-key-grouped here.
 * The old `hashKeyGroupQuestions` / `linkMarketsToQuestions` content-key grouping
 * (and its candidate-discovery siblings) were removed in the cutover. This module
 * now only reconciles cached counts and archives orphan nodes / dangling edges.
 */
import { query } from '@arb/db';

// ── Count reconciliation + orphan/edge archival ──

export async function updateAllQuestionCounts(): Promise<void> {
  // Recompute counts for every question. An inner join to question_members
  // would leave questions with zero members untouched, keeping a stale
  // member_count. The LEFT JOIN here produces a row per question, with NULL
  // counts collapsing to 0 — orphans get reset. The `IS DISTINCT FROM` no-op
  // filter keeps the UPDATE narrow when most rows already have correct
  // counts.
  await query(`
    WITH target_counts AS (
      SELECT q.id AS question_id,
             COALESCE(sub.cnt, 0)      AS cnt,
             COALESCE(sub.pcnt, 0)     AS pcnt,
             COALESCE(sub.open_cnt, 0) AS open_cnt
        FROM questions q
        LEFT JOIN (
          SELECT qm.question_id,
                 COUNT(*) AS cnt,
                 COUNT(DISTINCT qm.platform) AS pcnt,
                 COUNT(*) FILTER (WHERE m.resolved_at IS NULL) AS open_cnt
            FROM question_members qm
            JOIN markets m ON m.id = qm.market_id
           GROUP BY qm.question_id
        ) sub ON sub.question_id = q.id
    )
    UPDATE questions q SET
      member_count      = tc.cnt,
      platform_count    = tc.pcnt,
      open_member_count = tc.open_cnt
    FROM target_counts tc
    WHERE q.id = tc.question_id
      AND (q.member_count       IS DISTINCT FROM tc.cnt
        OR q.platform_count     IS DISTINCT FROM tc.pcnt
        OR q.open_member_count  IS DISTINCT FROM tc.open_cnt)
  `);

  // Archive any question with no open members. Covers two cases:
  //   (1) every member has resolved (member_count > 0, open_member_count = 0)
  //   (2) member_count = 0 — orphan questions left behind when a re-projection
  //       changed the canonical_key; the old row keeps (now-stale)
  //       implication_edges pointing nowhere reachable.
  await query(`
    UPDATE questions
    SET archived_at = NOW()
    WHERE archived_at IS NULL
      AND open_member_count = 0
  `);

  // Archive edges where ANY endpoint question is archived. An edge with one
  // live and one archived endpoint is a dangling reference: the solver loader
  // filters archived questions but would still load the edge, leaving it
  // pointing at a node that is not in the loaded set. Requiring both
  // endpoints archived would leave those half-dangling edges live. Archiving
  // on any archived endpoint is sound: an edge cannot constrain anything once
  // either endpoint is unloadable, and builders re-create edges from live
  // nodes on every finalize pass, so a revived question regains its edges.
  await query(`
    UPDATE implication_edges e
    SET archived_at = NOW()
    WHERE archived_at IS NULL
      AND (EXISTS (SELECT 1 FROM questions q1 WHERE q1.id = e.antecedent_question_id AND q1.archived_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM questions q2 WHERE q2.id = e.consequent_question_id AND q2.archived_at IS NOT NULL))
  `);
}
