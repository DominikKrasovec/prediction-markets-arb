import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import { buildElectionPreconditionEdgesSql } from './election-precondition-edge.js';

const sql = buildElectionPreconditionEdgesSql();

test('writes a strict_implication edge with the election_precondition pattern label', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'election_precondition'");
});

test('writes a hard, algorithmic, full-confidence edge that is first-writer-wins on conflict', () => {
  expect(sql).toContain('1.0, TRUE');
  expect(sql).toContain("'algorithmic'");
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

test('is scoped to election_outcome_winner on BOTH sides', () => {
  expect(sql).toContain("a.event_kind = 'election_outcome_winner'");
  expect(sql).toContain("b.event_kind = 'election_outcome_winner'");
});

test('pairs the same candidate + election (subject equality + folded canonical_event + same-event gate)', () => {
  expect(sql).toContain('a.canonical_subject   IS NOT DISTINCT FROM b.canonical_subject');
  // folded canonical_event equality in the JOIN ON (the equivalence builder's cheap key)
  expect(sql).toContain(
    'lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))',
  );
  // the same-event fragment folds on the stamped discriminators->>'game_ordinal'
  expect(sql).toContain("discriminators->>'game_ordinal'");
});

test('carries the precondition tokens and fires on the XOR (exactly one side is a precondition)', () => {
  expect(sql).toContain('on the ballot');
  expect(sql).toContain('make the runoff');
  expect(sql).toContain('a_pre <> b_pre');
});

test('orients antecedent=WIN, consequent=BALLOT (p(win) ≤ p(ballot))', () => {
  // antecedent column = the NON-precondition (win) side; consequent = the
  // precondition (ballot) side. The two CASE expressions encode win→ballot.
  expect(sql).toContain('CASE WHEN a_pre THEN bq ELSE aq END'); // antecedent = win
  expect(sql).toContain('CASE WHEN a_pre THEN aq ELSE bq END'); // consequent = ballot
});
