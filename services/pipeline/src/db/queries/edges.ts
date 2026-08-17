/**
 * Centralized queries for `implication_edges` and `edge_contradictions`.
 *
 * The only sanctioned edge write path is the Stage-4 builders' INSERT with
 * the `EDGE_CONFLICT_SQL` chokepoint tail (util/sql-fragments.ts). A DB
 * check constraint drops the `'transitive'` pattern label so any ad-hoc
 * writer dies at the CHECK; the standing tripwires are the `edges:
 * deterministic ...` mixed-provenance asserts in
 * scripts/soundness-regression-asserts.ts and the edge-writer-allowlist test.
 */
import { query } from '@arb/db';
import type { EdgeType, EdgeSource } from '@arb/types';

export interface EdgeRow {
  id: number;
  antecedent_question_id: number;
  consequent_question_id: number;
  edge_type: EdgeType;
  confidence: number;
  source: EdgeSource;
}

// A bare `SELECT * ... WHERE archived_at IS NULL` over all live edges would
// materialize every row as a JS object. The three queries below instead
// fetch only what each contradiction check needs:
//   C1/C2 as indexed SQL self-joins (the unique key on
//         (antecedent_question_id, consequent_question_id) means at most one
//         edge per ordered pair, so a pair join returns the same rows an
//         in-memory map would, deterministically, without building the map);
//   C3    as a keyset-paged stream of the strict_implication triples only,
//         which the caller packs into typed arrays instead of objects.

/**
 * C1 — pairs where BOTH directions carry a `strict_implication` (should be one
 * `equivalence` edge). One row per UNORDERED pair: the `<` filter picks the
 * ascending-endpoint edge as `edge_a` (also excluding a degenerate self-edge, which
 * is not a bidirectional pair), and the unique (antecedent, consequent) key means the
 * reverse arm matches at most one row.
 */
export async function getBidirectionalStrictPairs(): Promise<
  Array<{ edge_a: number; edge_b: number; lo: number; hi: number }>
> {
  return query(
    `SELECT e1.id AS edge_a, e2.id AS edge_b,
            e1.antecedent_question_id AS lo, e1.consequent_question_id AS hi
       FROM implication_edges e1
       JOIN implication_edges e2
         ON e2.antecedent_question_id = e1.consequent_question_id
        AND e2.consequent_question_id = e1.antecedent_question_id
      WHERE e1.archived_at IS NULL
        AND e2.archived_at IS NULL
        AND e1.edge_type = 'strict_implication'
        AND e2.edge_type = 'strict_implication'
        AND e1.antecedent_question_id < e1.consequent_question_id`
  );
}

/**
 * C2 — a `mutual_exclusion` edge coexisting with a `strict_implication` /
 * `equivalence` edge on the SAME unordered pair. Both orientations of the partner
 * edge are checked via a UNION ALL of two equality joins (each served by the unique
 * (antecedent, consequent) index — a `least()/greatest()` join would be a seq scan).
 */
export async function getImplicationVsExclusionPairs(): Promise<
  Array<{ mutex_id: number; other_id: number; other_type: EdgeType; lo: number; hi: number }>
> {
  return query(
    `WITH mx AS (
       SELECT id, antecedent_question_id AS a, consequent_question_id AS c
         FROM implication_edges
        WHERE archived_at IS NULL AND edge_type = 'mutual_exclusion'
     )
     SELECT mx.id AS mutex_id, o.id AS other_id, o.edge_type AS other_type,
            least(mx.a, mx.c) AS lo, greatest(mx.a, mx.c) AS hi
       FROM mx
       JOIN implication_edges o
         ON o.antecedent_question_id = mx.a AND o.consequent_question_id = mx.c
      WHERE o.archived_at IS NULL
        AND o.id <> mx.id
        AND o.edge_type IN ('strict_implication', 'equivalence')
     UNION ALL
     SELECT mx.id, o.id, o.edge_type,
            least(mx.a, mx.c), greatest(mx.a, mx.c)
       FROM mx
       JOIN implication_edges o
         ON o.antecedent_question_id = mx.c AND o.consequent_question_id = mx.a
      WHERE o.archived_at IS NULL
        AND o.id <> mx.id
        AND o.edge_type IN ('strict_implication', 'equivalence')`
  );
}

/** One page of `strict_implication` triples, ascending by id (keyset cursor). */
export interface StrictImplicationTriple {
  id: number;
  antecedent_question_id: number;
  consequent_question_id: number;
}

/**
 * C3 input — ONE keyset page of live `strict_implication` edges with `id > afterId`,
 * ascending. Keyset (not OFFSET) so page N costs the same as page 1, and the caller
 * can drop each page's row objects immediately after packing them into typed arrays.
 */
export async function getStrictImplicationEdgePage(
  afterId: number,
  limit: number,
): Promise<StrictImplicationTriple[]> {
  return query<StrictImplicationTriple>(
    `SELECT id, antecedent_question_id, consequent_question_id
       FROM implication_edges
      WHERE archived_at IS NULL
        AND edge_type = 'strict_implication'
        AND id > $1
      ORDER BY id
      LIMIT $2`,
    [afterId, limit]
  );
}

// ── Contradictions ──

export async function recordContradiction(
  edgeAId: number,
  edgeBId: number | null,
  kind: 'bidirectional_strict' | 'implication_vs_exclusion' | 'cycle',
  detail: string,
): Promise<void> {
  await query(
    `INSERT INTO edge_contradictions (edge_a_id, edge_b_id, kind, detail)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (edge_a_id, edge_b_id, kind) DO UPDATE SET
       detail = EXCLUDED.detail,
       created_at = NOW()`,
    [edgeAId, edgeBId, kind, detail]
  );
}
