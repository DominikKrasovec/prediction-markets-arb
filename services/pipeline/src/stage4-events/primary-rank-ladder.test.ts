// SQL-gate pins for the parked rank-1 ⟹ rank-≤N builder. The builder is not
// wired into finalize.ts and its pattern label is not yet in
// chk_edges_pattern / EDGE_PATTERNS; these tests pin the SQL so the gates
// cannot silently rot while parked.
import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import { buildPrimaryRankLadderEdgesSql } from './primary-rank-ladder.js';

const sql = buildPrimaryRankLadderEdgesSql();

test('writes a strict_implication edge with the (parked) primary_rank_ladder pattern label', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'primary_rank_ladder'");
});

test('hard, algorithmic, full-confidence, first-writer-wins on conflict', () => {
  expect(sql).toContain('1.0, TRUE');
  expect(sql).toContain("'algorithmic'");
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

test('antecedent = rank-1 place-first (election_outcome_winner, below/1/rank)', () => {
  expect(sql).toContain("a.event_kind = 'election_outcome_winner'");
  expect(sql).toContain("a.condition_direction = 'below'");
  expect(sql).toContain('a.value_primary = 1');
  expect(sql).toContain("lower(a.value_unit) = 'rank'");
});

test('consequent = rank-≤N advance (primary_winner, below/N≥2/rank) — never the reverse', () => {
  expect(sql).toContain("b.event_kind = 'primary_winner'");
  expect(sql).toContain("b.condition_direction = 'below'");
  expect(sql).toContain('b.value_primary >= 2');
  expect(sql).toContain("lower(b.value_unit) = 'rank'");
  // orientation is structural (a → b columns), not a CASE swap:
  expect(sql).not.toContain('CASE WHEN');
});

test('same-candidate gate: KB-resolved canonical_subject equality, both known', () => {
  expect(sql).toContain('a.canonical_subject IS NOT NULL');
  expect(sql).toContain('a.canonical_subject = b.canonical_subject');
});

test('same-race gate: folded ce equality OR the single-party-segment insertion form, both ce ending in " primary"', () => {
  expect(sql).toContain(
    'lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))',
  );
  expect(sql).toContain("right(btrim(a.canonical_event), 8) = ' primary'");
  expect(sql).toContain("right(btrim(b.canonical_event), 8) = ' primary'");
  expect(sql).toContain("|| '% primary'");
});

test('year double-pin on condition_date', () => {
  expect(sql).toContain('left(a.condition_date::text, 4) IS NOT DISTINCT FROM left(b.condition_date::text, 4)');
});
