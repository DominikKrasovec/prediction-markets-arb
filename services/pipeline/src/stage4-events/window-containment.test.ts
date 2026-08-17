import { test, expect } from 'bun:test';
import { EDGE_CONFLICT_SQL } from '../util/sql-fragments.js';
import {
  buildWindowContainmentEdgesSql,
  MONTH_NAME_TITLE_RX,
  SUB_PERIOD_TITLE_RX,
} from './window-containment.js';

const sql = buildWindowContainmentEdgesSql();

test('writes a strict_implication / window_containment edge with the solver contract', () => {
  expect(sql).toContain("'strict_implication'");
  expect(sql).toContain("'window_containment'"); // exact pattern label (CHECK constraint)
  // confidence=1.0 + deterministic TRUE so the solver hard-prunes the edge
  expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
});

test('MONOTONE latch only: both legs monotonic_threshold, no snapshot/range shapes admitted', () => {
  expect(sql).toContain("a.condition_shape = 'monotonic_threshold'");
  expect(sql).toContain("b.condition_shape = 'monotonic_threshold'");
  // ranges never (interior buckets are not implied by touches; the range
  // ANTECEDENT lo-bound arm is the deliberate v2, research F3)
  expect(sql).not.toContain('range_snapshot');
  expect(sql).not.toContain('point_in_time');
});

test("ABOVE arms only on BOTH legs — below reverses for counts (coarse implies fine), v1 excludes it", () => {
  expect(sql).toContain("a.condition_direction = 'above'");
  expect(sql).toContain("b.condition_direction = 'above'");
  expect(sql).not.toContain("'below'");
});

test('during_period temporal on BOTH legs, read from questions (not node_facts)', () => {
  expect(sql).toContain("qa.temporal_semantics = 'during_period'");
  expect(sql).toContain("qb.temporal_semantics = 'during_period'");
});

test('same-subject (non-NULL equality, shape-bridge precedent) + same event_kind', () => {
  expect(sql).toContain('a.canonical_subject = b.canonical_subject');
  expect(sql).toContain('a.canonical_subject IS NOT NULL');
  expect(sql).toContain('a.event_kind = b.event_kind');
  expect(sql).toContain('a.question_id <> b.question_id');
});

test('metric/unit: both-known-and-differ NULL-tolerant rejection (shared generators)', () => {
  // bothKnownDifferSql on condition_metric
  expect(sql).toContain(
    'NOT (a.condition_metric IS NOT NULL AND b.condition_metric IS NOT NULL AND a.condition_metric IS DISTINCT FROM b.condition_metric)',
  );
  // unitsCompatibleSql (NULL-passing + plural fold) on value_unit
  expect(sql).toContain("lower(btrim(a.value_unit)) = lower(btrim(b.value_unit))");
  expect(sql).toContain("|| 's' = lower(btrim(b.value_unit))");
});

test('CALENDAR-ANCHOR gate: month/year precision on BOTH legs (the Template-V weekly day-stamp counterexample)', () => {
  expect(sql).toContain("qa.condition_date_precision IN ('month','year')");
  expect(sql).toContain("qb.condition_date_precision IN ('month','year')");
  expect(sql).toContain('qa.condition_date IS NOT NULL AND qb.condition_date IS NOT NULL');
});

test('STRICT containment at the projected per-question grain pair (mig 074), via the shared generator', () => {
  // rank(a) < rank(b): strictly finer antecedent grain
  expect(sql).toContain(
    "CASE qa.condition_date_precision WHEN 'year' THEN 3 WHEN 'month' THEN 2 ELSE 1 END < CASE qb.condition_date_precision WHEN 'year' THEN 3 WHEN 'month' THEN 2 ELSE 1 END",
  );
  // ISO-prefix equality at b's OWN grain key
  expect(sql).toMatch(
    /left\(qa\.condition_date, CASE CASE qb\.condition_date_precision WHEN 'year' THEN 3 WHEN 'month' THEN 2 ELSE 1 END WHEN 3 THEN 4 WHEN 2 THEN 7 ELSE 10 END\)\s*=\s*left\(qb\.condition_date,/,
  );
  // dates must come from questions (the per-question TEXT deadline pair), never
  // the node_facts pe-grain date (the date-implication-xq precedent)
  expect(sql).not.toMatch(/[^q]a\.condition_date/);
  expect(sql).not.toMatch(/[^q]b\.condition_date/);
});

test('value dominance: ties OK same-platform, STRICT cross-platform (header ties note)', () => {
  expect(sql).toContain('CASE WHEN a.platform IS DISTINCT FROM b.platform');
  expect(sql).toContain('THEN a.value_primary::numeric >  b.value_primary::numeric');
  expect(sql).toContain('ELSE a.value_primary::numeric >= b.value_primary::numeric');
  expect(sql).toContain('a.value_primary IS NOT NULL');
  expect(sql).toContain('b.value_primary IS NOT NULL');
});

test('wrong-grain consequent belt: year-grain consequent naming a calendar month is refused', () => {
  expect(sql).toContain("qb.condition_date_precision = 'year'");
  expect(sql).toContain(`lower(immutable_unaccent(b.title)) ~ '${MONTH_NAME_TITLE_RX}'`);
  // full month names only — abbreviations collide ("Mar-a-Lago")
  expect(MONTH_NAME_TITLE_RX).toContain('january');
  expect(MONTH_NAME_TITLE_RX).toContain('december');
  expect(MONTH_NAME_TITLE_RX).not.toMatch(/\bjan\|/);
  expect(MONTH_NAME_TITLE_RX).not.toContain('|mar|');
});

test('sub-period title belt on BOTH legs (week-of / this-week / quarter tokens)', () => {
  expect(sql).toContain(`lower(immutable_unaccent(a.title)) !~ '${SUB_PERIOD_TITLE_RX}'`);
  expect(sql).toContain(`lower(immutable_unaccent(b.title)) !~ '${SUB_PERIOD_TITLE_RX}'`);
  expect(SUB_PERIOD_TITLE_RX).toContain('(week|weekend) of');
  expect(SUB_PERIOD_TITLE_RX).toContain('q[1-4]');
});

test('cross-source pairs are NOT refused — the divergence is a reasoning MARKER only (user decision)', () => {
  // the marker exists…
  expect(sql).toContain("' [cross-source: '");
  expect(sql).toContain('ra.resolution_source IS DISTINCT FROM rb.resolution_source');
  // …and resolution_source never appears as a refusal conjunct
  expect(sql).not.toMatch(/AND\s+ra\.resolution_source\s*=/);
  expect(sql).not.toMatch(/AND\s+NOT\s*\(\s*ra\.resolution_source/);
  // unanimous-known per-question aggregation (the shape-bridge CTE pattern)
  expect(sql).toContain('count(DISTINCT nz.resolution_source) = 1');
});

test('first-writer-wins idempotency', () => {
  expect(sql).toContain(EDGE_CONFLICT_SQL);
});
