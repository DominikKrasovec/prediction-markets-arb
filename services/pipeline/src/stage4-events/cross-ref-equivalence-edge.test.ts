/**
 * Unit tests for the cross-ref equivalence-edge builder SQL.
 *
 * Pure / no DB: pins the load-bearing SQL invariants — the lean conditionId join, the
 * orientation/distinct-node/cross-platform filters, the edge attributes, ON CONFLICT, AND
 * the deliberate absence of the heuristic field guards.
 */
import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import { buildCrossRefEquivalenceEdgesSql, reapMemberlessCrossRefEdgesSql } from './cross-ref-equivalence-edge.js';
import {
  settlementDimensionSql, settlementDimensionCompatibleSql,
} from '../util/settlement-instrument.js';

const SQL = buildCrossRefEquivalenceEdgesSql();

test('AUD-06: a DELETE of pre-existing algorithmic edges precedes the INSERT (cross_ref is authority)', () => {
  expect(SQL).toContain('DELETE FROM implication_edges');
  expect(SQL).toContain('USING cand c');
  expect(SQL).toContain("e.source = 'algorithmic'");
  // the DELETE keys on the same (aq,bq) candidate pair
  expect(SQL).toContain('e.antecedent_question_id = c.aq');
  expect(SQL).toContain('e.consequent_question_id = c.bq');
  // ordering: DELETE must run before the INSERT so the equivalence wins over the stale mutex
  expect(SQL.indexOf('DELETE FROM implication_edges')).toBeLessThan(SQL.indexOf('INSERT INTO implication_edges'));
  // the INSERT keeps the chokepoint conflict tail for residual genuinely-new pairs
  expect(SQL).toContain(EDGE_CONFLICT_SQL);
});

test('edge attributes: equivalence / cross_ref_equiv / platform_structure / confidence 1.0 / det+confirmed TRUE', () => {
  expect(SQL).toContain("'equivalence'");
  expect(SQL).toContain("'cross_ref_equiv'");
  expect(SQL).toContain("'platform_structure'");
  expect(SQL).toContain('1.0, TRUE'); // confidence 1.0, deterministic TRUE
  // the INSERT column list carries both deterministic and confirmed
  expect(SQL).toContain('deterministic, source, confirmed');
});

test('joins market_cross_refs to question_members TWICE (source + target)', () => {
  expect(SQL).toContain('FROM market_cross_refs r');
  expect(SQL).toContain('JOIN question_members sm ON sm.market_id = r.source_market_id');
  expect(SQL).toContain('JOIN question_members tm ON tm.market_id = r.target_market_id');
});

test('filters: resolved target, distinct nodes, cross-platform', () => {
  expect(SQL).toContain('r.target_market_id IS NOT NULL');
  expect(SQL).toContain('sm.question_id <> tm.question_id');
  expect(SQL).toContain('sm.platform <> tm.platform');
});

test('orients antecedent<consequent (LEAST/GREATEST) and the chokepoint conflict tail', () => {
  expect(SQL).toContain('LEAST(sm.question_id, tm.question_id)');
  expect(SQL).toContain('GREATEST(sm.question_id, tm.question_id)');
  expect(SQL).toContain(EDGE_CONFLICT_SQL);
});

test('W1-C: the member-less reap targets ONLY cross_ref_equiv and both endpoints', () => {
  const reap = reapMemberlessCrossRefEdgesSql();
  // scoped to this builder's own pattern — never touches other edge families
  expect(reap).toContain("e.pattern = 'cross_ref_equiv'");
  expect(reap).toContain('DELETE FROM implication_edges');
  // either endpoint member-less ⇒ stale
  expect(reap).toContain('qm.question_id = e.antecedent_question_id');
  expect(reap).toContain('qm.question_id = e.consequent_question_id');
  expect(reap).toContain('NOT EXISTS');
  expect(reap).toContain('OR NOT EXISTS');
  // returns the count the caller logs
  expect(reap).toContain('SELECT COUNT(*)::int AS n FROM del');
});

test('REGRESSION: bypasses the heuristic field guards EXCEPT the G8 H2H side-flip guard', () => {
  // it must NOT re-introduce buildEquivalenceEdges' title/canonical_event/prop
  // discriminators — those would false-reject the kind-diff/subject-diff/date-diff
  // sound pairs this builder exists to recover. The conditionId is the authority.
  expect(SQL).not.toContain('canonical_event');
  expect(SQL).not.toContain('PROP_DISCRIMINATOR');
  expect(SQL).not.toContain('sameEventFragment');
  // and it does NOT blanket-reject same-outcome_set pairs.
  expect(SQL).not.toContain('outcome_set_slots');
  // The one heuristic kept: for match_winner (H2H) legs the YES side is the
  // team, so a conditionId that links opposite teams is a mis-leg, refuse.
  // Scoped to match_winner only; non-H2H cross-refs keep full conditionId trust.
  expect(SQL).toContain("qs.event_kind = 'match_winner' OR qt.event_kind = 'match_winner'");
  expect(SQL).toContain('immutable_unaccent(btrim(qs.canonical_subject))');
});

test('G8 (§B): side-flip guard requires H2H legs to share the same (folded/substring) team', () => {
  // NULL subject (PM H2H title names no side) or a fold-mismatch (opposite team) => refuse;
  // spelling drift ('KT' vs 'KT Rolster') survives via the substring belt.
  expect(SQL).toContain('qs.canonical_subject IS NOT NULL AND qt.canonical_subject IS NOT NULL');
  expect(SQL).toContain(
    "lower(immutable_unaccent(btrim(qs.canonical_subject))) = lower(immutable_unaccent(btrim(qt.canonical_subject)))",
  );
  expect(SQL).toMatch(/ILIKE '%' \|\| lower\(immutable_unaccent\(btrim\(q[st]\.canonical_subject\)\)\) \|\| '%'/);
});

// The G8 fold-match proof must not be satisfied by a fixture-shaped subject.
test('P3: a fixture-shaped subject fails the G8 same-side proof (Brewers cd5ad701518b)', () => {
  // "Brewers vs. Cubs" is carried by BOTH legs of the game, so the fold-equality arm
  // below would otherwise pass trivially and let a mis-legged moneyline keep its
  // conditionId trust. Treated exactly like a NULL subject: no proof.
  expect(SQL).toContain('btrim(qs.canonical_subject) ~*');
  expect(SQL).toContain('btrim(qt.canonical_subject) ~*');
  // it TIGHTENS the existing proof (still inside the same NOT(...) guard) rather
  // than replacing the fold-match arms
  expect(SQL).toContain("qs.event_kind = 'match_winner' OR qt.event_kind = 'match_winner'");
  expect(SQL).toContain('qs.canonical_subject IS NOT NULL AND qt.canonical_subject IS NOT NULL');
  expect(SQL).toContain('ILIKE');
});

// The conditionId trust yields to contradicting settlement prose.
test('P6b: a cross-dimension pair is refused despite the conditionId ground truth', () => {
  // Both linked markets are read from raw (pk lookups, LEFT so a missing raw row
  // never drops a pair), and the conjunct is EMITTED from the shared twins.
  expect(SQL).toContain('LEFT JOIN market_metadata_raw rs ON rs.market_id = r.source_market_id');
  expect(SQL).toContain('LEFT JOIN market_metadata_raw rt ON rt.market_id = r.target_market_id');
  expect(SQL).toContain(settlementDimensionCompatibleSql(
    settlementDimensionSql('rs.raw'), settlementDimensionSql('rt.raw'),
  ));
});
