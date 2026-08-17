/**
 * Snapshot test for the edge-writer chokepoint fragments. EDGE_CONFLICT_SQL
 * is interpolated by every builder; its TEXT is pinned HERE exactly once
 * (builder tests assert containment of the imported constant, never a
 * re-derived literal). Any change to the tail is a DECLARED change: update
 * this snapshot together with a fresh A/B dry-run (counts + content hash
 * identical pre/post).
 */
import { describe, test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL, EDGE_INSERT_COLUMNS_SQL, edgeContractSql, censusInsertSql, bothKnownDifferSql, sameSliceScopeSql } from './sql-fragments.js';
import { METRIC_SCOPES, SUB_FIXTURE_METRIC_SCOPES } from '@arb/types';

describe('EDGE_CONFLICT_SQL displacement tail', () => {
  test('snapshot: the exact tail text', () => {
    expect(EDGE_CONFLICT_SQL).toBe(`ON CONFLICT (antecedent_question_id, consequent_question_id) DO UPDATE SET
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
      AND EXCLUDED.deterministic = TRUE`);
  });

  test('the WHERE guard fires ONLY on advisory→deterministic displacement', () => {
    expect(EDGE_CONFLICT_SQL).toContain('WHERE implication_edges.deterministic = FALSE');
    expect(EDGE_CONFLICT_SQL).toContain('AND EXCLUDED.deterministic = TRUE');
  });

  test('whole-row displacement: every contract field from EXCLUDED, no OR-merge', () => {
    for (const field of ['edge_type', 'pattern', 'confidence', 'deterministic', 'source', 'reasoning']) {
      expect(EDGE_CONFLICT_SQL).toContain(`${field}`);
      expect(EDGE_CONFLICT_SQL).toContain(`EXCLUDED.${field}`);
    }
    // laundering operators must never reappear in the conflict tail
    expect(EDGE_CONFLICT_SQL).not.toContain(' OR ');
    expect(EDGE_CONFLICT_SQL).not.toContain('GREATEST');
    expect(EDGE_CONFLICT_SQL).not.toContain('COALESCE');
  });

  test('risk fields reset + resurrection on displacement; confirmed NOT in the SET list', () => {
    expect(EDGE_CONFLICT_SQL).toContain('basis_risk    = NULL');
    expect(EDGE_CONFLICT_SQL).toContain('risk_detail   = NULL');
    expect(EDGE_CONFLICT_SQL).toContain('archived_at   = NULL');
    expect(EDGE_CONFLICT_SQL).not.toContain('confirmed');
  });

  test('insert column list unchanged (generic writers)', () => {
    expect(EDGE_INSERT_COLUMNS_SQL).toBe(
      '(antecedent_question_id, consequent_question_id, edge_type, pattern, confidence, deterministic, source, reasoning)',
    );
  });

  test('censusInsertSql: candidate CTE + chokepoint tail + xmax insert/displace split + blocked disagreement channel', () => {
    const sql = censusInsertSql('SELECT 1 AS antecedent_question_id');
    // the candidate SELECT is embedded verbatim as the cand CTE
    expect(sql).toContain('WITH cand AS (\n       SELECT 1 AS antecedent_question_id');
    // inserts ONLY through the chokepoint tail
    expect(sql).toContain(EDGE_CONFLICT_SQL);
    expect(sql).toContain(EDGE_INSERT_COLUMNS_SQL);
    // fresh-insert vs displacement split
    expect(sql).toContain('(xmax = 0) AS was_insert');
    expect(sql).toContain('FROM ins WHERE was_insert');
    expect(sql).toContain('FROM ins WHERE NOT was_insert');
    // blocked = candidates with a PRE-EXISTING incumbent the tail refused;
    // disagreement channel filters to differing edge_type
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).toContain('intent_type IS DISTINCT FROM incumbent_type');
  });

  test('edgeContractSql emits the full deterministic contract', () => {
    expect(edgeContractSql('strict_implication', 'numeric_threshold'))
      .toBe(`'strict_implication', 'numeric_threshold', 1.0, TRUE, 'algorithmic'`);
    expect(edgeContractSql('equivalence', 'cross_ref_equiv', { source: 'platform_structure' }))
      .toBe(`'equivalence', 'cross_ref_equiv', 1.0, TRUE, 'platform_structure'`);
  });
});

// sameSliceScopeSql — the metric_scope slice gate. The asymmetric NULL policy
// is the load-bearing part: NULL↔'game' must PASS (the documented
// cross-platform equiv — Kalshi has a ticker, Polymarket does not), NULL↔a
// sub-fixture slice must REFUSE (an F3 tie and an F7 tie of one game are a
// real (NO,YES) world).
describe('sameSliceScopeSql — metric_scope slice gate', () => {
  test('it STRENGTHENS bothKnownDifferSql (the both-known clause is retained verbatim)', () => {
    expect(sameSliceScopeSql('a.metric_scope', 'b.metric_scope'))
      .toContain(bothKnownDifferSql('a.metric_scope', 'b.metric_scope'));
  });

  test('the NULL arm is symmetric over both operands', () => {
    const sql = sameSliceScopeSql('a.metric_scope', 'b.metric_scope');
    expect(sql).toContain('NOT (a.metric_scope IS NULL AND b.metric_scope IN (');
    expect(sql).toContain('NOT (b.metric_scope IS NULL AND a.metric_scope IN (');
  });

  test("'game' is NOT a sub-fixture scope — NULL is a safe stand-in for the whole game only", () => {
    expect(SUB_FIXTURE_METRIC_SCOPES).not.toContain('game');
    expect(sameSliceScopeSql('a.ms', 'b.ms')).not.toContain("'game'");
  });

  test('every SUB-FIXTURE scope (incl. the three innings marks) is in the refusal tuple', () => {
    const sql = sameSliceScopeSql('a.ms', 'b.ms');
    for (const s of SUB_FIXTURE_METRIC_SCOPES) expect(sql).toContain(`'${s}'`);
    for (const s of ['first_3', 'first_5', 'first_7'] as const) expect(sql).toContain(`'${s}'`);
  });

  test('the vocabulary is emitted from @arb/types — SUB_FIXTURE = METRIC_SCOPES minus game', () => {
    expect([...SUB_FIXTURE_METRIC_SCOPES].sort())
      .toEqual(METRIC_SCOPES.filter((s) => s !== 'game').slice().sort());
  });
});
