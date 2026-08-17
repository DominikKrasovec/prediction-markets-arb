import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildKalshiStrikeLadderEdgesSql,
  kalshiStrikeRungsCtesSql,
  strikeImplies,
  STRIKE_LADDER_SHAPES_SQL,
} from './kalshi-strike-ladder.js';

const sql = buildKalshiStrikeLadderEdgesSql();

// ── pure-TS reference: chain orientation ──────────────────────────────────────

test('above: the HIGHER strike is the antecedent (above-X ⟹ above-Y for X>Y)', () => {
  expect(strikeImplies('above', 4.5, 4.25)).toBe(true);
  // NEGATIVE: reversed orientation is a fabricated arbitrage
  expect(strikeImplies('above', 4.25, 4.5)).toBe(false);
});

test('below: the LOWER strike is the antecedent (below-X ⟹ below-Y for X<Y)', () => {
  expect(strikeImplies('below', 4.0, 4.25)).toBe(true);
  // NEGATIVE: reversed orientation
  expect(strikeImplies('below', 4.25, 4.0)).toBe(false);
});

test('NEGATIVE: equal strikes never ladder (equivalence is a different rule)', () => {
  expect(strikeImplies('above', 4.5, 4.5)).toBe(false);
  expect(strikeImplies('below', 4.5, 4.5)).toBe(false);
});

test('NEGATIVE: unknown direction / missing strikes never relate', () => {
  expect(strikeImplies('between', 4.5, 4.25)).toBe(false);
  expect(strikeImplies(null, 4.5, 4.25)).toBe(false);
  expect(strikeImplies('above', null, 4.25)).toBe(false);
  expect(strikeImplies('above', 4.5, null)).toBe(false);
});

// ── SQL shape ─────────────────────────────────────────────────────────────────

test('writes a strict_implication / kalshi_strike_ladder edge with the solver contract', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'kalshi_strike_ladder'"); // exact label (DB CHECK constraint)
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('population gate: kalshi:price-ladder + NULL kind on BOTH grains (the disjointness belt)', () => {
  expect(sql).toContain("n.match_source = 'kalshi:price-ladder'");
  expect(sql).toContain('n.event_kind IS NULL');
  expect(sql).toContain('q.event_kind IS NULL');
  expect(sql).toContain('q.archived_at IS NULL');
});

test('strike shape: genuine half-lines only, no range buckets, valued rungs only', () => {
  expect(STRIKE_LADDER_SHAPES_SQL).toBe(`('monotonic_threshold','point_in_time')`);
  expect(sql).toContain(`n.condition_shape IN ('monotonic_threshold','point_in_time')`);
  expect(sql).toContain('n.value_secondary IS NULL');
  expect(sql).toContain('n.value_primary IS NOT NULL');
  expect(sql).toContain("n.condition_direction IN ('above','below')");
});

test('family key carries the full same-reading tuple (event+subject+date+dir+unit+metric)', () => {
  expect(sql).toContain('PARTITION BY ev_key, subj_key, d, dir, unit_key, metric_key');
  // the join repeats every key column (no cross-family leakage)
  for (const k of ['ev_key', 'subj_key', 'd', 'dir', 'unit_key', 'metric_key']) {
    expect(sql).toContain(`b.${k}`);
  }
});

test('CHAIN not closure: adjacent dense_rank step only, strictest rung first', () => {
  expect(sql).toContain('dense_rank()');
  expect(sql).toContain('b.rk = a.rk + 1');
  // orientation: rank 1 = strictest (above: -strike; below: strike)
  expect(sql).toContain("CASE WHEN dir = 'above' THEN -strike ELSE strike END");
  // NEGATIVE: no closure join anywhere
  expect(sql).not.toContain('b.rk > a.rk');
  expect(sql).not.toContain('b.strike < a.strike');
});

test('over-merge disqualifier: any member disagreement on the reading tuple drops the question', () => {
  expect(sql).toContain('bad_questions');
  expect(sql).toContain('count(DISTINCT (ev_key, subj_key, d, dir, unit_key, metric_key, strike)) > 1');
  expect(sql).toContain('question_id NOT IN (SELECT question_id FROM bad_questions)');
});

test('NEGATIVE: equal strikes never chain (belt on top of the rank step)', () => {
  expect(sql).toContain('b.strike <> a.strike');
  expect(sql).toContain('b.question_id <> a.question_id');
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});

test('rungs CTE pipeline is exported for the read-only dry-run probe', () => {
  const ctes = kalshiStrikeRungsCtesSql();
  expect(ctes).toContain('chain_pairs AS');
  expect(sql).toContain(ctes);
});
