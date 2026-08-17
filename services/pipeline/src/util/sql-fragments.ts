// Shared SQL fragments for the Stage-4 edge builders: the edge contract, the canonical_event
// fold key, and the NULL-tolerance doctrine conjunct, so no builder hand-types its own copy.
import type { EdgePattern } from '@arb/types';
import { SUB_FIXTURE_METRIC_SCOPES } from '@arb/types';
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { recordContradiction } from '../db/queries/edges.js';

const log = createLogger('edge-writer');

export const EDGE_INSERT_COLUMNS_SQL =
  '(antecedent_question_id, consequent_question_id, edge_type, pattern, confidence, deterministic, source, reasoning)';

// `pattern` is the EdgePattern union, so a typo'd label is a compile error, not a runtime CHECK crash.
export function edgeContractSql(
  edgeType: 'strict_implication' | 'equivalence' | 'mutual_exclusion',
  pattern: EdgePattern,
  opts?: { source?: string },
): string {
  return `'${edgeType}', '${pattern}', 1.0, TRUE, '${opts?.source ?? 'algorithmic'}'`;
}

// Whole-row displacement (never OR-merge) when a deterministic write lands on an advisory
// row. `confirmed` is deliberately not in the SET list. Disagreement is never resolved here —
// see insertEdgesWithCensus's contradiction channel.
export const EDGE_CONFLICT_SQL = `ON CONFLICT (antecedent_question_id, consequent_question_id) DO UPDATE SET
      edge_type     = EXCLUDED.edge_type,
      pattern       = EXCLUDED.pattern,
      confidence    = EXCLUDED.confidence,
      deterministic = EXCLUDED.deterministic,
      source        = EXCLUDED.source,
      reasoning     = EXCLUDED.reasoning,
      basis_risk    = NULL,
      risk_detail   = NULL,
      archived_at   = NULL,
      updated_at    = NOW()
    WHERE implication_edges.deterministic = FALSE
      AND EXCLUDED.deterministic = TRUE`;

export interface EdgeInsertCensus {
  candidates: number;
  inserted: number;
  displaced: number;
  blocked: number;
  contradictions: number;
}

// Wraps the builder's candidate SELECT in a CTE, inserts through EDGE_CONFLICT_SQL, and
// computes {candidates, inserted, displaced, blocked}. `xmax = 0` distinguishes fresh INSERTs
// from displacement UPDATEs. candidateSelectSql must emit one row per distinct
// (antecedent, consequent) pair with columns matching EDGE_INSERT_COLUMNS_SQL.
export function censusInsertSql(candidateSelectSql: string): string {
  return `WITH cand AS (
       ${candidateSelectSql}
     ),
     ins AS (
       INSERT INTO implication_edges
         ${EDGE_INSERT_COLUMNS_SQL}
       SELECT antecedent_question_id, consequent_question_id, edge_type, pattern,
              confidence, deterministic, source, reasoning
       FROM cand
       ${EDGE_CONFLICT_SQL}
       RETURNING antecedent_question_id, consequent_question_id, (xmax = 0) AS was_insert
     ),
     blocked AS (
       SELECT c.antecedent_question_id AS a, c.consequent_question_id AS cq,
              c.edge_type AS intent_type, e.id AS incumbent_id, e.edge_type AS incumbent_type
       FROM cand c
       JOIN implication_edges e
         ON e.antecedent_question_id = c.antecedent_question_id
        AND e.consequent_question_id = c.consequent_question_id
       WHERE NOT EXISTS (
         SELECT 1 FROM ins i
         WHERE i.antecedent_question_id = c.antecedent_question_id
           AND i.consequent_question_id = c.consequent_question_id
       )
     )
     SELECT
       (SELECT count(*)::int FROM cand)                        AS candidates,
       (SELECT count(*)::int FROM ins WHERE was_insert)        AS inserted,
       (SELECT count(*)::int FROM ins WHERE NOT was_insert)    AS displaced,
       (SELECT count(*)::int FROM blocked)                     AS blocked,
       (SELECT coalesce(json_agg(json_build_object(
          'a', a, 'c', cq, 'intent', intent_type,
          'incumbent_id', incumbent_id, 'incumbent_type', incumbent_type)), '[]'::json)
        FROM blocked
        WHERE intent_type IS DISTINCT FROM incumbent_type)     AS contradictions`;
}

export async function insertEdgesWithCensus(opts: {
  builder: string;
  candidateSelectSql: string;
  params?: unknown[];
}): Promise<EdgeInsertCensus> {
  interface CensusRow {
    candidates: number;
    inserted: number;
    displaced: number;
    blocked: number;
    contradictions: string | Array<{
      a: number; c: number; intent: string; incumbent_id: number; incumbent_type: string;
    }>;
  }
  const rows = await query<CensusRow>(censusInsertSql(opts.candidateSelectSql), opts.params);
  const r = rows[0];
  const disagreements = (typeof r.contradictions === 'string'
    ? JSON.parse(r.contradictions)
    : r.contradictions) as Array<{ a: number; c: number; intent: string; incumbent_id: number; incumbent_type: string }>;
  for (const d of disagreements) {
    const detail =
      `[${opts.builder}] blocked-intent disagreement on slot (${d.a} -> ${d.c}): ` +
      `intent edge_type='${d.intent}' vs incumbent #${d.incumbent_id} edge_type='${d.incumbent_type}'`;
    log.error(detail);
    await recordContradiction(d.incumbent_id, null, 'implication_vs_exclusion', detail);
  }
  return {
    candidates: Number(r.candidates),
    inserted: Number(r.inserted),
    displaced: Number(r.displaced),
    blocked: Number(r.blocked),
    contradictions: disagreements.length,
  };
}

export function foldedTextSql(expr: string): string {
  return `lower(immutable_unaccent(btrim(${expr})))`;
}

export function foldedTextEqSql(a: string, b: string): string {
  return `${foldedTextSql(a)} = ${foldedTextSql(b)}`;
}

// NULL-tolerance doctrine: refuse ONLY when BOTH sides are known AND differ — a NULL side always passes.
export function bothKnownDifferSql(a: string, b: string): string {
  return `NOT (${a} IS NOT NULL AND ${b} IS NOT NULL AND ${a} IS DISTINCT FROM ${b})`;
}

const SUB_FIXTURE_SCOPES_SQL = `(${SUB_FIXTURE_METRIC_SCOPES.map((s) => `'${s}'`).join(',')})`;

// Asymmetric-NULL strengthening of {@link bothKnownDifferSql}: a NULL side can only be
// identified with the whole game, never a sub-fixture slice. Not for fixture-totals.ts, whose
// deliberately cross-scope patterns pin both sides with explicit literal scope predicates.
export function sameSliceScopeSql(a: string, b: string): string {
  return `(${bothKnownDifferSql(a, b)}
       AND NOT (${a} IS NULL AND ${b} IN ${SUB_FIXTURE_SCOPES_SQL})
       AND NOT (${b} IS NULL AND ${a} IN ${SUB_FIXTURE_SCOPES_SQL}))`;
}

export function inSameOutcomeSetSql(aQid: string, bQid: string): string {
  return `EXISTS (
         SELECT 1
         FROM outcome_set_slots s1
         JOIN outcome_set_slots s2 ON s1.set_id = s2.set_id
         WHERE s1.question_id = ${aQid}
           AND s2.question_id = ${bQid}
       )`;
}

export function foldedParticipantsSql(col: string): string {
  return `(SELECT array_agg(lower(immutable_unaccent(x)) ORDER BY lower(immutable_unaccent(x))) FROM unnest(${col}) x)`;
}

// Joined with a unit-separator (chr(31), never NUL) into one comparable string; NULL/empty array → SQL NULL.
export function foldedParticipantsKeySql(col: string): string {
  return `array_to_string(${foldedParticipantsSql(col)}, chr(31))`;
}

// TS mirror of foldedTextSql — must produce identical output on any ASCII-safe string. Keep in sync.
export function foldTextKey(t: string | null | undefined): string | null {
  if (t == null) return null;
  return t
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Fixed aliases: qm (question_members), m (markets), mr (market_metadata_raw). Anchored at a `questions` alias.
export function kalshiRawMembersJoinSql(qAlias: string): string {
  return `JOIN question_members qm ON qm.question_id = ${qAlias}.id
      JOIN markets m ON m.id = qm.market_id AND m.platform = 'kalshi'
      JOIN market_metadata_raw mr ON mr.market_id = m.id`;
}

// SQL mirror of the TS pair foldUnit + unitsEquivalent (util/condition-shape.ts). Keep in sync.
export function unitsCompatibleSql(a: string, b: string): string {
  return `(${a} IS NULL OR ${b} IS NULL
           OR lower(btrim(${a})) = lower(btrim(${b}))
           OR lower(btrim(${a})) || 's' = lower(btrim(${b}))
           OR lower(btrim(${a})) = lower(btrim(${b})) || 's')`;
}
