/**
 * Shape test for shape-bridge.ts — asserts the load-bearing guards are present
 * in the generated SQL (no DB; pure string assertions): UTC pinning, day-grain
 * consequent, period-anchor refusal, strict same-platform ties, and the
 * settlement_instrument gate.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildShapeBridgeEdgesSql,
  CROSS_ORACLE_MARGIN,
  COMPATIBLE_INSTRUMENT_PAIRS,
} from './shape-bridge.js';

const sql = buildShapeBridgeEdgesSql();

describe('buildShapeBridgeEdgesSql', () => {
  test('writes the correct edge_type + pattern label (migration 072)', () => {
    expect(sql).toContain("'strict_implication'");
    expect(sql).toContain("'shape_bridge'");
  });

  test('is a deterministic algorithmic edge at confidence 1.0', () => {
    expect(sql).toMatch(/1\.0,\s*TRUE,\s*'algorithmic'/);
  });

  test('SOUND ORIENTATION ONLY: snapshot antecedent, touch consequent — never the reverse', () => {
    // antecedent (a) = snapshot shapes (emitted from SNAPSHOT_SHAPES);
    // consequent (b) = monotonic touch.
    expect(sql).toContain("a.condition_shape IN ('point_in_time','range_snapshot','price_snapshot')");
    expect(sql).toContain("b.condition_shape = 'monotonic_threshold'");
    // the reverse (touch antecedent) must not appear anywhere
    expect(sql).not.toContain("a.condition_shape = 'monotonic_threshold'");
  });

  test('scoped to single-asset price paths with the SAME KB asset', () => {
    expect(sql).toContain("a.event_kind = 'price_threshold'");
    expect(sql).toContain("b.event_kind = 'price_threshold'");
    expect(sql).toContain('a.canonical_subject = b.canonical_subject');
    expect(sql).toContain('a.canonical_subject IS NOT NULL');
  });

  test('v1.2 §3: cross-platform pairs require BOTH settlement instruments KNOWN and COMPATIBLE', () => {
    // the fact arrives via the dedicated CTE (node_facts untouched), joined on both sides
    expect(sql).toContain('question_settlement_instrument AS (');
    expect(sql).toContain('LEFT JOIN question_settlement_instrument ia ON ia.question_id = a.question_id');
    expect(sql).toContain('LEFT JOIN question_settlement_instrument ib ON ib.question_id = b.question_id');
    // both-known: NULL on either side → no cross-platform edge
    expect(sql).toContain('ia.settlement_instrument IS NOT NULL');
    expect(sql).toContain('ib.settlement_instrument IS NOT NULL');
    // futures:unpinned is NEVER compatible — not even with itself
    expect(sql).toContain("ia.settlement_instrument <> 'futures:unpinned'");
    expect(sql).toContain("ib.settlement_instrument <> 'futures:unpinned'");
    // equal strings compatible (covers futures:<X> × futures:<X> equal-contract)
    expect(sql).toContain('ia.settlement_instrument = ib.settlement_instrument');
    // the margin-justified cf-benchmarks × binance pair, both orientations
    expect(sql).toContain("(('cf-benchmarks','binance'),('binance','cf-benchmarks'))");
    // the gate applies ONLY to cross-platform pairs (same-platform exempt)
    expect(sql).toContain('a.platform IS NOT DISTINCT FROM b.platform');
    // the v1.1 subject-allowlist stopgap is GONE
    expect(sql).not.toContain('canonical_subject IN (');
  });

  test('v1.2 §3: per-question instrument is UNANIMOUS-KNOWN (conflicting member facts → NULL → no edge)', () => {
    expect(sql).toMatch(/CASE WHEN count\(DISTINCT nz\.settlement_instrument\) = 1\s*\n\s*THEN min\(nz\.settlement_instrument\) END/);
    expect(sql).toContain('nz.settlement_instrument IS NOT NULL');
    expect(sql).toContain('JOIN llm_market_normalizations nz ON nz.market_id = qm.market_id');
  });

  test('v1.2 §3: COMPATIBLE_INSTRUMENT_PAIRS is exactly the margin-justified cf-benchmarks × binance pair', () => {
    expect(COMPATIBLE_INSTRUMENT_PAIRS).toEqual([['cf-benchmarks', 'binance']]);
  });

  test('same-UTC-day gate is TZ-pinned (GUC-independent) with precise snapshot stamps', () => {
    expect(sql).toContain("a.condition_date_precision IN ('minute','hour','day')");
    expect(sql).toContain("(a.condition_date AT TIME ZONE 'UTC')::date = (b.condition_date AT TIME ZONE 'UTC')::date");
    // the GUC-dependent bare cast must be gone
    expect(sql).not.toContain('a.condition_date::date = b.condition_date::date');
  });

  test('v1.1 §4: consequent must be a DAY-GRAIN touch with a path temporal — sub-day arm dropped', () => {
    expect(sql).toContain("b.condition_date_precision = 'day'");
    expect(sql).not.toContain("b.condition_date_precision IN ('minute','hour','day')");
    // the old sub-day deadline-ordering arm is gone
    expect(sql).not.toContain('b.condition_date >= a.condition_date');
    // path temporal joined from questions (not exposed by node_facts)
    expect(sql).toContain("qb.temporal_semantics IN ('by_date','on_date','during_period')");
    // snapshot-marker titles ("at 5pm", "16:00 UTC") never qualify as touch legs
    expect(sql).toMatch(/b\.title !~\* '\\mat \\d/);
  });

  test('v1.1 §2a (P12c): sub-day snapshots must sit at/after 00:00 ET — DST-correct, no fixed offset', () => {
    // The hard-coded EDT offset is GONE: under EST (UTC−5) it admitted 04:00-04:59
    // UTC moments that belong to the PREVIOUS ET day.
    expect(sql).not.toContain("interval '4 hours'");
    // ET local date vs the stamped UTC date — Postgres picks EST/EDT per instant.
    expect(sql).toContain("AT TIME ZONE 'America/New_York')::date");
    expect(sql).toMatch(
      /\(a\.condition_date AT TIME ZONE 'America\/New_York'\)::date\s*\n?\s*>= \(a\.condition_date AT TIME ZONE 'UTC'\)::date/,
    );
    expect(sql).toContain("a.condition_date_precision = 'day'");
  });

  test('v1.1 §2a EST boundary case: the predicate is an ET-day comparison, not a 4h shift', () => {
    // 2026-01-15T04:30:00Z is 23:30 ET on Jan-14 (EST, UTC−5) — the PREVIOUS ET day,
    // so it must NOT bridge onto a Jan-15 ET touch window. Under the old
    // `+ interval '4 hours'` form it passed (04:30 >= 04:00); under the ET-date form
    // it fails (2026-01-14 >= 2026-01-15 is FALSE). The same instant in JULY is
    // 00:30 ET on the SAME day (EDT, UTC−4) and still passes.
    // Literal-lock: the SQL must not reintroduce any fixed-hour offset arithmetic.
    expect(sql).not.toMatch(/interval '\d+ hours'/);
  });

  test('v1.1 §2b: day-grain period-anchored snapshot families are refused', () => {
    expect(sql).toMatch(/a\.title ~\* '\\m\(week\|month\) of\\M/);
  });

  test('cross-oracle margin applies to cross-platform pairs (both directions)', () => {
    expect(CROSS_ORACLE_MARGIN).toBeGreaterThan(0);
    expect(sql).toContain(`1 + ${CROSS_ORACLE_MARGIN}`);
    expect(sql).toContain(`1 - ${CROSS_ORACLE_MARGIN}`);
    expect(sql).toContain('a.platform IS DISTINCT FROM b.platform');
  });

  test('v1.1 §1: same-platform dominance is STRICT (exact ties never pass)', () => {
    // every ELSE (same-platform) arm uses > or <, never >= / <=
    expect(sql).toMatch(/ELSE a\.value_primary::numeric >\s+b\.value_primary::numeric END/);
    expect(sql).toMatch(/ELSE a\.value_primary::numeric <\s+b\.value_primary::numeric END/);
    expect(sql).not.toContain('ELSE a.value_primary::numeric >= ');
    expect(sql).not.toContain('ELSE a.value_primary::numeric <= ');
    expect(sql).not.toContain('::numeric) >= b.value_primary::numeric END');
    expect(sql).not.toContain('::numeric) <= b.value_primary::numeric END');
  });

  test('between-bucket antecedents require BOTH bounds and dominate with the right bound', () => {
    // touch-above: bucket LOWER bound dominates; touch-below: bucket UPPER bound.
    expect(sql).toContain('a.value_secondary IS NOT NULL');
    expect(sql).toContain('LEAST(a.value_primary::numeric, a.value_secondary::numeric)');
    expect(sql).toContain('GREATEST(a.value_primary::numeric, a.value_secondary::numeric)');
  });

  test('touch directions restricted to above/below; unknown snapshot directions contribute nothing', () => {
    expect(sql).toContain("b.condition_direction IN ('above','below')");
    // the dominance CASE falls through to FALSE for unmatched antecedent directions
    expect(sql).toContain('ELSE FALSE');
  });
});
