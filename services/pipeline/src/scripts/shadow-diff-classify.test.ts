/**
 * Unit tests for the pure shadow-diff classification logic.
 * Run: bun test services/pipeline/src/scripts/shadow-diff-classify.test.ts
 * No DB access — classifyRow / diffTuples / pairDrifts are pure.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyRow,
  diffTuples,
  pairDrifts,
  O3_FAMILIES,
  DATE1_FAMILIES,
  DATE4_FAMILIES,
  DATE5_FAMILIES,
  A1_TOUCH_FAMILIES,
  CUM_CONV_FAMILIES,
  type TupleFields,
} from './shadow-diff-classify.js';

const NOW = new Date('2026-06-11T12:00:00Z');

function tuple(overrides: Partial<TupleFields> = {}): TupleFields {
  return {
    event_kind: 'price_threshold',
    condition_shape: 'point_in_time',
    condition_direction: 'above',
    condition_metric: 'price',
    temporal_semantics: 'on_date',
    value_primary: 100000,
    value_secondary: null,
    value_unit: 'USD',
    metric_scope: null,
    condition_date: '2026-06-30',
    condition_date_precision: 'day',
    condition_date_source: 'title-mdy',
    condition_value: '>=100000USD',
    canonical_event: 'bitcoin price june 30',
    ...overrides,
  };
}

function classify(family: string, stored: TupleFields, recomputed: TupleFields | null, extra?: {
  endDate?: string | null;
  title?: string;
  noRecomputeReason?: string;
}) {
  return classifyRow({
    family,
    stored,
    recomputed,
    now: NOW,
    endDate: extra?.endDate ?? '2026-12-31T00:00:00Z',
    title: extra?.title ?? 'Will Bitcoin be above $100,000 on June 30?',
    noRecomputeReason: extra?.noRecomputeReason,
  });
}

describe('diffTuples', () => {
  test('byte-equal tuples produce no diffs', () => {
    expect(diffTuples(tuple(), tuple())).toEqual([]);
  });

  test('numeric fields compare numerically (pg NUMERIC-as-string coercion upstream)', () => {
    // 72000 vs 72000.0 must NOT diff once both sides are numbers.
    expect(diffTuples(tuple({ value_primary: 72000 }), tuple({ value_primary: 72000.0 }))).toEqual([]);
    expect(diffTuples(tuple({ value_primary: 72000 }), tuple({ value_primary: 72001 }))).toEqual(['value_primary']);
  });

  test('null vs non-null diffs', () => {
    expect(diffTuples(tuple({ metric_scope: null }), tuple({ metric_scope: 'team' }))).toEqual(['metric_scope']);
  });
});

describe('EQUAL / NO_RECOMPUTE', () => {
  test('identical tuples are EQUAL', () => {
    const c = classify('text-deterministic-P', tuple(), tuple());
    expect(c.bucket).toBe('EQUAL');
  });

  test('missing recompute is PORT_BLOCKER(NO_RECOMPUTE) — R7 coverage-loss gate', () => {
    const c = classify('text-deterministic-P', tuple(), null, { noRecomputeReason: 'template-miss' });
    expect(c.bucket).toBe('PORT_BLOCKER');
    expect(c.kind).toBe('NO_RECOMPUTE(template-miss)');
  });
});

describe('canonical_event hard gate (design §6 gate 4, risk R1)', () => {
  test('canonical_event diff is PORT_BLOCKER even when everything else matches a declared flip', () => {
    const stored = tuple({
      condition_direction: null,
      condition_value: '3.1_3.2percent',
      canonical_event: 'cpi yoy june',
    });
    const recomputed = tuple({
      condition_direction: 'between',
      condition_value: '3.1-3.2percent',
      canonical_event: 'cpi yoy july', // drifted
    });
    const c = classify('limitless:econ-cpi', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
    expect(c.kind).toBe('CANONICAL_EVENT');
  });
});

describe('EXPECTED_FLIP(O3) — §4.2 range-arm direction flips', () => {
  const stored = tuple({
    condition_shape: 'range_snapshot',
    condition_direction: null,
    value_primary: 3.1,
    value_secondary: 3.2,
    value_unit: 'percent',
    condition_value: '3.1_3.2percent',
  });
  const recomputed = tuple({
    condition_shape: 'range_snapshot',
    condition_direction: 'between',
    value_primary: 3.1,
    value_secondary: 3.2,
    value_unit: 'percent',
    condition_value: '3.1-3.2percent',
  });

  test('declared family classifies EXPECTED_FLIP(O3)', () => {
    const c = classify('limitless:econ-cpi', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('O3');
  });

  test('all nine §4.2 families are registered', () => {
    expect([...O3_FAMILIES].sort()).toEqual([
      'limitless:crypto-bucket',
      'limitless:econ-commodity',
      'limitless:econ-cpi',
      'limitless:econ-jobs',
      'limitless:econ-valuation',
      'text-deterministic-A',
      'text-deterministic-AH',
      'text-deterministic-V',
      'text-deterministic-X',
    ].sort());
  });

  test('same diff on an UNDECLARED family is PORT_BLOCKER (gate 2: kind AND family)', () => {
    const c = classify('kalshi:weather', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('direction flip with a NON-matching condition_value rewrite is PORT_BLOCKER', () => {
    const bad = { ...recomputed, condition_value: '3.1-3.3percent' }; // hi changed
    const c = classify('limitless:econ-cpi', stored, bad);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(DATE1) — §5.1 year-ISO padded-start', () => {
  const stored = tuple({
    condition_date: '2026-12-31',
    condition_date_precision: 'year',
    condition_date_source: 'predict-date',
  });
  const recomputed = tuple({
    condition_date: '2026-01-01',
    condition_date_precision: 'year',
    condition_date_source: 'predict-date',
  });

  test('declared family (AG) classifies EXPECTED_FLIP(DATE1)', () => {
    const c = classify('text-deterministic-AG', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE1');
  });

  test('site list §5.1 maps to the four predict-family tags', () => {
    expect([...DATE1_FAMILIES].sort()).toEqual([
      'text-deterministic-AG',
      'text-deterministic-AH',
      'text-deterministic-AJ',
      'text-deterministic-AK',
    ].sort());
  });

  test('undeclared family with the same flip is PORT_BLOCKER (Template AD fed-rate stays)', () => {
    const c = classify('text-deterministic-AD', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('day-precision -12-31 is NOT a DATE1 flip (real deadline, not padding)', () => {
    const s = { ...stored, condition_date_precision: 'day' };
    const r = { ...recomputed, condition_date_precision: 'day' };
    const c = classify('text-deterministic-AG', s, r);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(DATE2) — §5.2.1 inferYear adoption', () => {
  test('year +1 matching inferYear (no plausible end_date year) is DATE2', () => {
    // now = 2026-06-11; "Jan 5" with a 2099 end_date (implausible) →
    // inferYear: candidate 2026-01-05 is >30d past → 2027.
    const stored = tuple({ condition_date: '2026-01-05', condition_date_source: 'title-md' });
    const recomputed = tuple({ condition_date: '2027-01-05', condition_date_source: 'title-md' });
    const c = classify('limitless:crypto-bucket', stored, recomputed, { endDate: '2099-01-06T00:00:00Z' });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE2');
  });

  test('year shift NOT matching inferYear is PORT_BLOCKER', () => {
    // end_date year 2026 is plausible → inferYear returns 2026, not 2027.
    const stored = tuple({ condition_date: '2026-01-05' });
    const recomputed = tuple({ condition_date: '2027-01-05' });
    const c = classify('limitless:crypto-bucket', stored, recomputed, { endDate: '2026-01-06T00:00:00Z' });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('±2-year shift is never DATE2', () => {
    const stored = tuple({ condition_date: '2025-01-05' });
    const recomputed = tuple({ condition_date: '2027-01-05' });
    const c = classify('limitless:crypto-bucket', stored, recomputed, { endDate: '2099-01-06T00:00:00Z' });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(DATE3) — §5.2.2 leap-Feb', () => {
  test('02-28 → 02-29 in a leap year is DATE3', () => {
    const stored = tuple({ condition_date: '2028-02-28', condition_date_precision: 'month' });
    const recomputed = tuple({ condition_date: '2028-02-29', condition_date_precision: 'month' });
    const c = classify('text-deterministic-predict-advance', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE3');
  });

  test('02-28 → 02-29 in a NON-leap year is PORT_BLOCKER', () => {
    const stored = tuple({ condition_date: '2027-02-28' });
    const recomputed = tuple({ condition_date: '2027-02-29' });
    const c = classify('text-deterministic-predict-advance', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(DATE4) — addendum-1 "end of <year>" honest last-day', () => {
  const TITLE = 'Erik ten Hag out as Manchester United Manager by the end of 2026?';
  const stored = tuple({
    condition_date: '2026-01-01T00:00:00Z',
    condition_date_precision: 'day',
    condition_date_source: 'title-date',
  });
  const recomputed = tuple({
    condition_date: '2026-12-31T00:00:00Z',
    condition_date_precision: 'day',
    condition_date_source: 'title-date',
  });

  test('declared family + explicit "end of" title classifies EXPECTED_FLIP(DATE4)', () => {
    const c = classify('pm:manager-out', stored, recomputed, { title: TITLE });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE4');
  });

  test('the five parseLooseDate consumer families are registered', () => {
    expect([...DATE4_FAMILIES].sort()).toEqual([
      'limitless:manager',
      'limitless:participation',
      'limitless:retirement',
      'limitless:transfer',
      'pm:manager-out',
    ].sort());
  });

  test('undeclared family with the same flip is PORT_BLOCKER (kind AND family gate)', () => {
    const c = classify('text-deterministic-AG', stored, recomputed, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('title WITHOUT an explicit "end of" phrase is PORT_BLOCKER', () => {
    const c = classify('limitless:manager', stored, recomputed, { title: 'Ruben Amorim out as Manchester United manager by 2026?' });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('year drift is never DATE4 (same-year guard)', () => {
    const r = { ...recomputed, condition_date: '2027-12-31T00:00:00Z' };
    const c = classify('limitless:manager', stored, r, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('coarse precision is never DATE4 (the flip is day-precision-only by construction)', () => {
    const s = { ...stored, condition_date_precision: 'year' };
    const r = { ...recomputed, condition_date_precision: 'year' };
    const c = classify('limitless:manager', s, r, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(DATE5) — "in <month> <year>" month-grain fix', () => {
  const TITLE = 'Will Elon Musk post 200-219 tweets in May 2026?';
  const stored = tuple({
    condition_date: '2026-01-01',
    condition_date_precision: 'year',
    condition_date_source: 'title-year',
  });
  const recomputed = tuple({
    condition_date: '2026-05-01',
    condition_date_precision: 'month',
    condition_date_source: 'title-month-year',
  });

  test('declared family + matching title month classifies EXPECTED_FLIP(DATE5)', () => {
    const c = classify('text-deterministic-V', stored, recomputed, { title: TITLE });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE5');
    expect(c.diffs.sort()).toEqual(['condition_date', 'condition_date_precision', 'condition_date_source']);
  });

  test('all four census families are registered (and nothing else)', () => {
    expect([...DATE5_FAMILIES].sort()).toEqual([
      'limitless:econ-stock',
      'pm:inflation',
      'pm:rate-decision',
      'text-deterministic-V',
    ].sort());
    for (const fam of DATE5_FAMILIES) {
      const c = classify(fam, stored, recomputed, { title: TITLE });
      expect(c.bucket).toBe('EXPECTED_FLIP');
      expect(c.kind).toBe('DATE5');
    }
  });

  test('rate-decision phrasing ("after the June 2026 meeting") classifies DATE5', () => {
    const c = classify('pm:rate-decision',
      { ...stored, temporal_semantics: 'at_resolution' },
      { ...recomputed, temporal_semantics: 'at_resolution', condition_date: '2026-06-01' },
      { title: 'Will there be no change in Fed interest rates after the June 2026 meeting?' });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE5');
  });

  test('undeclared family with the same flip is PORT_BLOCKER (family gate)', () => {
    const c = classify('text-deterministic-X', stored, recomputed, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('recomputed month must equal the month the title names (May title, June recompute → blocker)', () => {
    const r = { ...recomputed, condition_date: '2026-06-01' };
    const c = classify('text-deterministic-V', stored, r, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('year drift is never DATE5 (same-year guard)', () => {
    const r = { ...recomputed, condition_date: '2027-05-01' };
    const c = classify('text-deterministic-V', stored, r, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('title without a month-year phrase is PORT_BLOCKER (text-surface guard)', () => {
    const c = classify('text-deterministic-V', stored, recomputed, { title: 'Will Elon Musk post 200-219 tweets in 2026?' });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('stored stamp must be the bare-year Jan-1 shape (both-sides guard)', () => {
    const s = { ...stored, condition_date: '2026-03-01' };
    const c = classify('text-deterministic-V', s, recomputed, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('source pair must be exactly title-year → title-month-year', () => {
    const s = { ...stored, condition_date_source: 'end_date' };
    const c = classify('text-deterministic-V', s, recomputed, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('any extra field diff escapes the signature (subset gate)', () => {
    const r = { ...recomputed, temporal_semantics: 'during_period' };
    const c = classify('text-deterministic-V', stored, r, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('composes with the committed O3 range-arm flip (V stored rows predate both ports)', () => {
    const s = tuple({
      condition_shape: 'range_snapshot', condition_direction: null,
      value_primary: 200, value_secondary: 219, value_unit: 'tweets',
      condition_value: '200_219tweets',
      condition_date: '2026-01-01', condition_date_precision: 'year', condition_date_source: 'title-year',
    });
    const r = tuple({
      condition_shape: 'range_snapshot', condition_direction: 'between',
      value_primary: 200, value_secondary: 219, value_unit: 'tweets',
      condition_value: '200-219tweets',
      condition_date: '2026-05-01', condition_date_precision: 'month', condition_date_source: 'title-month-year',
    });
    const c = classify('text-deterministic-V', s, r, { title: TITLE });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('O3+DATE5');
  });

  test('composite with a residual that is NOT a clean O3 flip stays PORT_BLOCKER', () => {
    const s = tuple({
      condition_direction: null,
      condition_date: '2026-01-01', condition_date_precision: 'year', condition_date_source: 'title-year',
    });
    const r = tuple({
      condition_direction: 'above', // not the O3 null→between shape
      condition_date: '2026-05-01', condition_date_precision: 'month', condition_date_source: 'title-month-year',
    });
    const c = classify('text-deterministic-V', s, r, { title: TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(DATE_EOM) — WP-3.3 "one deadline ⇒ one representation"', () => {
  // Shape A: title-month-year MM-01/month → MM-END/month (day-shift only, same source).
  test('Shape A: title-month-year day-shift 05-01 → 05-31 (family-agnostic)', () => {
    const stored = tuple({ condition_date: '2026-05-01', condition_date_precision: 'month', condition_date_source: 'title-month-year' });
    const recomputed = tuple({ condition_date: '2026-05-31', condition_date_precision: 'month', condition_date_source: 'title-month-year' });
    const c = classify('pm:rate-decision', stored, recomputed, { title: 'after the May 2026 meeting?' });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE_EOM');
    expect(c.diffs).toEqual(['condition_date']);
  });

  test('Shape A: leap/30-day month ends (06-30, 02-28)', () => {
    for (const [iso, mm] of [['2026-06-30', 'June'], ['2026-02-28', 'February']] as const) {
      const stored = tuple({ condition_date: iso.slice(0, 8) + '01', condition_date_precision: 'month', condition_date_source: 'title-month-year' });
      const recomputed = tuple({ condition_date: iso, condition_date_precision: 'month', condition_date_source: 'title-month-year' });
      const c = classify('text-deterministic-V', stored, recomputed, { title: `in ${mm} 2026?` });
      expect(c.kind).toBe('DATE_EOM');
    }
  });

  test('Shape A NEGATIVE: non-month-end recompute day is not DATE_EOM', () => {
    const stored = tuple({ condition_date: '2026-05-01', condition_date_precision: 'month', condition_date_source: 'title-month-year' });
    const recomputed = tuple({ condition_date: '2026-05-15', condition_date_precision: 'month', condition_date_source: 'title-month-year' });
    const c = classify('text-deterministic-V', stored, recomputed, { title: 'in May 2026?' });
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });

  // Shape B: end_date fallback → title-month-deadline (the PM "hit … in May?" family).
  test('Shape B: end_date 06-01/day → title-month-deadline 05-31/month ("hit … in May?")', () => {
    const stored = tuple({ condition_date: '2026-06-01', condition_date_precision: 'day', condition_date_source: 'end_date' });
    const recomputed = tuple({ condition_date: '2026-05-31', condition_date_precision: 'month', condition_date_source: 'title-month-deadline' });
    const c = classify('text-deterministic-A', stored, recomputed, { title: 'Will Palantir (PLTR) hit (HIGH) $174 in May?' });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE_EOM');
  });

  test('Shape B: "by end of June?" → 06-30/month', () => {
    const stored = tuple({ condition_date: '2026-06-30', condition_date_precision: 'day', condition_date_source: 'end_date' });
    const recomputed = tuple({ condition_date: '2026-06-30', condition_date_precision: 'month', condition_date_source: 'title-month-deadline' });
    const c = classify('text-deterministic-A', stored, recomputed, { title: 'Will Crude Oil (CL) hit (HIGH) $100 by end of June?' });
    expect(c.kind).toBe('DATE_EOM');
  });

  test('Shape B NEGATIVE: recompute month must match the title deadline month', () => {
    const stored = tuple({ condition_date: '2026-06-01', condition_date_precision: 'day', condition_date_source: 'end_date' });
    // title says May, recompute says June-end → not DATE_EOM
    const recomputed = tuple({ condition_date: '2026-06-30', condition_date_precision: 'month', condition_date_source: 'title-month-deadline' });
    const c = classify('text-deterministic-A', stored, recomputed, { title: 'Will X hit (HIGH) $5 in May?' });
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });

  test('Shape B NEGATIVE: no deadline phrase in the title (data-month "in May?") is not DATE_EOM', () => {
    const stored = tuple({ condition_date: '2026-06-10', condition_date_precision: 'day', condition_date_source: 'end_date' });
    const recomputed = tuple({ condition_date: '2026-05-31', condition_date_precision: 'month', condition_date_source: 'title-month-deadline' });
    const c = classify('pm:inflation', stored, recomputed, { title: 'Will monthly inflation increase by 0.3% in May?' });
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });
});

describe('EXPECTED_FLIP(KALSHI_DEGENERATE_AT) — P2 lo==hi class', () => {
  const stored = tuple({
    condition_shape: 'range_snapshot',
    condition_direction: 'between',
    value_primary: 5,
    value_secondary: 5,
    value_unit: 'percent',
    condition_value: '5-5percent',
  });
  const recomputed = tuple({
    condition_shape: 'point_in_time',
    condition_direction: 'at',
    value_primary: 5,
    value_secondary: null,
    value_unit: 'percent',
    condition_value: '5percent',
  });

  test('kalshi family degenerate between→at classifies as the declared flip', () => {
    const c = classify('kalshi:econ-exact-value', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('KALSHI_DEGENERATE_AT');
  });

  test('non-kalshi family is PORT_BLOCKER', () => {
    const c = classify('text-deterministic-A', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('lo != hi between→at is PORT_BLOCKER (only the degenerate class flips)', () => {
    const s = { ...stored, value_secondary: 6, condition_value: '5-6percent' };
    const c = classify('kalshi:econ-exact-value', s, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(THRESH_CANON) — 2026-06-13 threshold half-line canonicalization', () => {
  // "3+ total goals" was stamped value 3; the canonical half-line is 2.5.
  const stored = tuple({
    event_kind: 'match_total_metric',
    condition_shape: 'monotonic_threshold',
    condition_direction: 'above',
    condition_metric: 'count',
    temporal_semantics: 'during_period',
    value_primary: 3,
    value_unit: 'goals',
    condition_value: '>=3goals',
    canonical_event: 'liverpool vs chelsea goals',
  });
  const recomputed = tuple({
    event_kind: 'match_total_metric',
    condition_shape: 'monotonic_threshold',
    condition_direction: 'above',
    condition_metric: 'count',
    temporal_semantics: 'during_period',
    value_primary: 2.5,
    value_unit: 'goals',
    condition_value: '>=2.5goals',
    canonical_event: 'liverpool vs chelsea goals',
  });

  test('integer→half-line on an integer-grain unit is the declared flip', () => {
    const c = classify('text-deterministic-M', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('THRESH_CANON');
  });

  test('the below mirror folds too (≤N → N+0.5)', () => {
    const s = tuple({
      condition_direction: 'below', value_primary: 3, value_unit: 'goals', condition_value: '<=3goals',
      condition_shape: 'monotonic_threshold', condition_metric: 'count', event_kind: 'match_total_metric',
      canonical_event: 'x goals',
    });
    const r = tuple({
      condition_direction: 'below', value_primary: 3.5, value_unit: 'goals', condition_value: '<=3.5goals',
      condition_shape: 'monotonic_threshold', condition_metric: 'count', event_kind: 'match_total_metric',
      canonical_event: 'x goals',
    });
    const c = classify('text-deterministic-M', s, r);
    expect(c.kind).toBe('THRESH_CANON');
  });

  test('FRACTIONAL unit is NOT a declared flip (soundness exclusion → PORT_BLOCKER)', () => {
    const s = tuple({ value_primary: 34, value_unit: 'percentage points', condition_value: '>=34percentage points' });
    const r = tuple({ value_primary: 33.5, value_unit: 'percentage points', condition_value: '>=33.5percentage points' });
    const c = classify('kalshi:midterm-mov', s, r);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('Δ ≠ 0.5 (a real value change) is NOT this flip — stays PORT_BLOCKER', () => {
    const r = { ...recomputed, value_primary: 4, condition_value: '>=4goals' };
    const c = classify('text-deterministic-M', stored, r);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('direction change disqualifies (the fold never flips a side)', () => {
    const r = { ...recomputed, condition_direction: 'below' as const, condition_value: '<=2.5goals' };
    const c = classify('text-deterministic-M', stored, r);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('an extra diff field outside {value_primary,condition_value} disqualifies', () => {
    const r = { ...recomputed, temporal_semantics: 'at_resolution' as const };
    const c = classify('text-deterministic-M', stored, r);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('kalshi player-game-prop "5+ HRR" floor=4.5 reads as the declared flip', () => {
    const s = tuple({
      event_kind: 'player_prop_threshold', condition_shape: 'monotonic_threshold', condition_direction: 'above',
      condition_metric: 'count', temporal_semantics: 'during_period', value_primary: 5,
      value_unit: 'hits_runs_rbis', condition_value: '>=5hits_runs_rbis', canonical_event: 'ketel marte hits_runs_rbis',
    });
    const r = tuple({
      event_kind: 'player_prop_threshold', condition_shape: 'monotonic_threshold', condition_direction: 'above',
      condition_metric: 'count', temporal_semantics: 'during_period', value_primary: 4.5,
      value_unit: 'hits_runs_rbis', condition_value: '>=4.5hits_runs_rbis', canonical_event: 'ketel marte hits_runs_rbis',
    });
    const c = classify('kalshi:player-game-prop', s, r);
    expect(c.kind).toBe('THRESH_CANON');
  });
});

describe('EXPECTED_FLIP(A1_TOUCH) — addendum-2 approval year-window touch', () => {
  const PM_TITLE = "Will Trump's approval rating hit 50% in 2026?";
  const KALSHI_TITLE =
    "Will Donald Trump's approval rating on approval rating be above 45% during Dec 2025 to Dec 2026?";
  const approval = (overrides: Partial<TupleFields>) =>
    tuple({
      event_kind: 'approval_rating',
      condition_metric: 'percentage',
      value_primary: 50,
      value_unit: 'percent',
      condition_value: '>=50percent',
      condition_date: '2026-01-01',
      condition_date_precision: 'year',
      condition_date_source: 'title-year',
      canonical_event: 'trump approval rating 2026',
      ...overrides,
    });
  const stored = approval({ condition_shape: 'point_in_time', temporal_semantics: 'on_date' });
  const recomputed = approval({ condition_shape: 'monotonic_threshold', temporal_semantics: 'during_period' });

  test('PM year-window "hit X% in <year>" classifies EXPECTED_FLIP(A1_TOUCH)', () => {
    const c = classify('text-deterministic-X', stored, recomputed, { title: PM_TITLE });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('A1_TOUCH');
  });

  test('Kalshi VoteHub "during <window>" row classifies EXPECTED_FLIP(A1_TOUCH)', () => {
    const c = classify('kalshi:price-ladder', stored, recomputed, { title: KALSHI_TITLE });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('A1_TOUCH');
  });

  test('NON-approval kalshi:price-ladder rows never match (event_kind guard)', () => {
    const s = { ...stored, event_kind: 'price_threshold' };
    const r = { ...recomputed, event_kind: 'price_threshold' };
    const c = classify('kalshi:price-ladder', s, r, { title: KALSHI_TITLE });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('dated PM title is NOT the declared flip — surfaces as LATENT_BUG(A1)', () => {
    const c = classify('text-deterministic-X', stored, recomputed, {
      title: "Will Donald Trump's approval rating be above 40.2% for May 14, 2026?",
    });
    expect(c.bucket).toBe('LATENT_BUG');
    expect(c.kind).toBe('A1');
  });

  test('range-arm value shape never matches (threshold arms only)', () => {
    const s = { ...stored, value_secondary: 55, condition_direction: 'between', condition_value: '50-55percent' };
    const r = { ...recomputed, value_secondary: 55, condition_direction: 'between', condition_value: '50-55percent' };
    const c = classify('text-deterministic-X', s, r, { title: PM_TITLE });
    expect(c.kind).not.toBe('A1_TOUCH');
  });

  test('a direction change rides along with NOTHING — not the declared flip', () => {
    const r = { ...recomputed, condition_direction: 'below', condition_value: '<=50percent' };
    const c = classify('text-deterministic-X', stored, r, { title: PM_TITLE });
    expect(c.kind).not.toBe('A1_TOUCH');
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('exactly the two declared families are registered', () => {
    expect([...A1_TOUCH_FAMILIES].sort()).toEqual(['kalshi:price-ladder', 'text-deterministic-X']);
  });
});

describe('EXPECTED_FLIP(CUM_CONV) — addendum-2 cumulative convergence', () => {
  const pmCount = (overrides: Partial<TupleFields>) =>
    tuple({
      event_kind: 'weather_extreme',
      condition_metric: 'count',
      value_unit: 'tornadoes',
      condition_date: '2026-05-01',
      condition_date_precision: 'month',
      condition_date_source: 'title-month',
      canonical_event: 'us tornado count may 2026',
      ...overrides,
    });

  test('pm:count-bucket RANGE arm — temporal-only flip on_date → during_period', () => {
    const s = pmCount({
      condition_shape: 'range_snapshot', condition_direction: 'between', temporal_semantics: 'on_date',
      value_primary: 200, value_secondary: 229, condition_value: '200-229tornadoes',
    });
    const r = pmCount({
      condition_shape: 'range_snapshot', condition_direction: 'between', temporal_semantics: 'during_period',
      value_primary: 200, value_secondary: 229, condition_value: '200-229tornadoes',
    });
    const c = classify('pm:count-bucket', s, r);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('CUM_CONV');
  });

  test('pm:count-bucket ABOVE arm — terminal snapshot → legacy monotonic window', () => {
    const s = pmCount({
      condition_shape: 'point_in_time', condition_direction: 'above', temporal_semantics: 'on_date',
      value_primary: 1250, value_secondary: null, condition_value: '>=1250tornadoes',
    });
    const r = pmCount({
      condition_shape: 'monotonic_threshold', condition_direction: 'above', temporal_semantics: 'during_period',
      value_primary: 1250, value_secondary: null, condition_value: '>=1250tornadoes',
    });
    const c = classify('pm:count-bucket', s, r);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('CUM_CONV');
  });

  test('pm:count-bucket BELOW arm is zero-diff by construction (PIT boundary kept) — EQUAL', () => {
    const s = pmCount({
      condition_shape: 'point_in_time', condition_direction: 'below', temporal_semantics: 'on_date',
      value_primary: 200, value_secondary: null, condition_value: '<=200tornadoes',
    });
    const c = classify('pm:count-bucket', s, { ...s });
    expect(c.bucket).toBe('EQUAL');
  });

  test('AH open-top oddity — shape + direction + condition_value ">=" prefix', () => {
    const s = pmCount({
      event_kind: 'social_media_metric', condition_shape: 'range_snapshot', condition_direction: null,
      temporal_semantics: 'during_period', value_primary: 41, value_secondary: null,
      value_unit: 'tweets', condition_value: '41tweets', canonical_event: 'cz tweet_count may 4th - may 11th 2026',
    });
    const r = {
      ...s,
      condition_shape: 'monotonic_threshold',
      condition_direction: 'above',
      condition_value: '>=41tweets',
    };
    const c = classify('text-deterministic-AH', s, r);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('CUM_CONV');
  });

  test('AH open-top COMPOSES with the unit-vocab pre-pass (stored rows predate tweet→tweets)', () => {
    const s = pmCount({
      event_kind: 'social_media_metric', condition_shape: 'range_snapshot', condition_direction: null,
      temporal_semantics: 'during_period', value_primary: 41, value_secondary: null,
      value_unit: 'tweet', condition_value: '41tweet', canonical_event: 'cz tweet_count may 4th - may 11th 2026',
    });
    const r = {
      ...s,
      condition_shape: 'monotonic_threshold',
      condition_direction: 'above',
      value_unit: 'tweets',
      condition_value: '>=41tweets',
    };
    const c = classify('text-deterministic-AH', s, r);
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('CUM_CONV+unit-vocab-evolved');
  });

  test('the same diff outside the declared families is PORT_BLOCKER', () => {
    const s = pmCount({
      condition_shape: 'point_in_time', condition_direction: 'above', temporal_semantics: 'on_date',
      value_primary: 1250, value_secondary: null, condition_value: '>=1250tornadoes',
    });
    const r = {
      ...s,
      condition_shape: 'monotonic_threshold',
      temporal_semantics: 'during_period',
    };
    const c = classify('text-deterministic-V', s, r);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('exactly the three declared families are registered (kalshi:weather joined at the rebuild boundary)', () => {
    expect([...CUM_CONV_FAMILIES].sort()).toEqual([
      'kalshi:weather', 'pm:count-bucket', 'text-deterministic-AH',
    ]);
  });
});

describe('EXPECTED_FLIP(CUM_CONV) — kalshi:weather windowCount arm (KXTORNADO, rebuild-boundary batch)', () => {
  const storedTor = (over: Partial<TupleFields> = {}) => tuple({
    event_kind: 'weather_extreme',
    condition_shape: 'point_in_time',
    condition_direction: 'above',
    condition_metric: 'count',
    temporal_semantics: 'on_date',
    value_primary: 200,
    value_secondary: null,
    value_unit: 'tornadoes',
    condition_value: '>=200tornadoes',
    condition_date: '2026-05-01',
    condition_date_precision: 'month',
    condition_date_source: 'kalshi-ticker',
    canonical_event: 'us tornado count',
    ...over,
  });
  const flippedTor = (over: Partial<TupleFields> = {}) => storedTor({
    condition_shape: 'monotonic_threshold',
    temporal_semantics: 'during_period',
    ...over,
  });

  test('the declared flip: PIT+above+on_date → monotonic+above+during_period on tornado counts', () => {
    const c = classify('kalshi:weather', storedTor(), flippedTor());
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('CUM_CONV');
    expect(c.diffs.sort()).toEqual(['condition_shape', 'temporal_semantics']);
  });

  test('series-guarded: a temperature ladder (fahrenheit) with the same diff is NOT declared', () => {
    const c = classify('kalshi:weather',
      storedTor({ value_unit: 'fahrenheit', condition_value: '>=200fahrenheit' }),
      flippedTor({ value_unit: 'fahrenheit', condition_value: '>=200fahrenheit' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('below boundary arm is zero-diff by construction (PIT+on_date kept → EQUAL)', () => {
    const below = storedTor({ condition_direction: 'below', condition_value: '<=200tornadoes' });
    const c = classify('kalshi:weather', below, below);
    expect(c.bucket).toBe('EQUAL');
  });

  test('family-scoped: the same flip on kalshi:price-ladder is NOT declared', () => {
    const c = classify('kalshi:price-ladder', storedTor(), flippedTor());
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('a range pair riding along is NOT the open-top arm', () => {
    const c = classify('kalshi:weather',
      storedTor({ value_secondary: 229 }), flippedTor({ value_secondary: 229 }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(O8_BINARY) — rebuild-boundary O8 topology flip (owner decision 2026-06-12)', () => {
  const O8_FAMILY = 'text-deterministic-predict-esports-h2h';
  const storedH2H = (over: Partial<TupleFields> = {}) => tuple({
    event_kind: 'match_winner',
    condition_shape: 'categorical_outcome',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    condition_value: null,
    condition_date: '2026-05-10',
    condition_date_precision: 'day',
    condition_date_source: 'end_date',
    canonical_event: 'ninjas in pyjamas vs team we',
    ...over,
  });
  const flippedH2H = (over: Partial<TupleFields> = {}) => storedH2H({
    condition_shape: 'binary_event',
    temporal_semantics: 'at_resolution',
    ...over,
  });

  test('the declared flip: categorical+NULL → binary+at_resolution, all else equal', () => {
    const c = classify(O8_FAMILY, storedH2H(), flippedH2H(),
      { title: 'LoL: Team WE vs Ninjas in Pyjamas (BO3) - LPL Group Ascend' });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('O8_BINARY');
    expect(c.diffs.sort()).toEqual(['condition_shape', 'temporal_semantics']);
  });

  test('family-scoped: the same flip on another family is NOT declared', () => {
    const c = classify('text-deterministic-B', storedH2H(), flippedH2H());
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });

  test('binary on BOTH platforms\' H2H: an already-binary stored row (the PM twin stamp) is EQUAL', () => {
    const c = classify(O8_FAMILY, flippedH2H(), flippedH2H());
    expect(c.bucket).toBe('EQUAL');
  });

  test('partition sets intact: shape flip is set-NEUTRAL by construction (no value/direction may ride along)', () => {
    // a direction smuggled onto either side breaks the zero-arity binary contract
    const c = classify(O8_FAMILY, storedH2H({ condition_direction: 'at' }),
      flippedH2H({ condition_direction: null }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('reverse flip (binary → categorical) is NOT declared', () => {
    const c = classify(O8_FAMILY, flippedH2H(), storedH2H());
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('canonical_event drift on an O8 row still hits the R1 hard gate', () => {
    const c = classify(O8_FAMILY, storedH2H(), flippedH2H({ canonical_event: 'different fixture' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
    expect(c.kind).toBe('CANONICAL_EVENT');
  });

  test('wrong event_kind is NOT swallowed by the signature', () => {
    const c = classify(O8_FAMILY,
      storedH2H({ event_kind: 'stage_advance' }), flippedH2H({ event_kind: 'stage_advance' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('temporal-only diff (no shape flip) is NOT the declared class', () => {
    const c = classify(O8_FAMILY, storedH2H(), storedH2H({ temporal_semantics: 'at_resolution' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_FLIP(AJ_ENDDATE) — rebuild-boundary declared re-key (end_date threading)', () => {
  // end_date 2027-01-15 → inferYear borrows 2027 (plausible window vs NOW=2026).
  const AJ_END = '2027-01-15T00:00:00Z';
  const storedAj = (over: Partial<TupleFields> = {}) => tuple({
    event_kind: 'other',
    condition_shape: 'categorical_outcome',
    condition_direction: 'at',
    condition_metric: 'rank',
    temporal_semantics: 'at_resolution',
    value_primary: 1,
    value_secondary: null,
    value_unit: 'rank',
    condition_date: '2026-05-31',
    condition_date_precision: 'day',
    condition_date_source: 'predict-question',
    condition_value: '=1rank',
    canonical_event: 'largest company by market cap 2026-05-31',
    ...over,
  });
  const rekeyedAj = (over: Partial<TupleFields> = {}) => storedAj({
    condition_date: '2027-05-31',
    canonical_event: 'largest company by market cap 2027-05-31',
    ...over,
  });

  test('the declared re-key: year follows inferYear(end_date), MM-DD intact, canonical_event = ISO substitution', () => {
    const c = classify('text-deterministic-AJ', storedAj(), rekeyedAj(), { endDate: AJ_END });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('AJ_ENDDATE');
    expect(c.diffs.sort()).toEqual(['canonical_event', 'condition_date']);
  });

  test('family-scoped: the same transform on another family still hits the R1 hard gate', () => {
    const c = classify('text-deterministic-AG', storedAj(), rekeyedAj(), { endDate: AJ_END });
    expect(c.bucket).toBe('PORT_BLOCKER');
    expect(c.kind).toBe('CANONICAL_EVENT');
  });

  test('recomputed year NOT matching the inferYear borrow is an UNDECLARED re-key', () => {
    // end_date 2026 → borrow = 2026, but recompute claims 2027: block.
    const c = classify('text-deterministic-AJ', storedAj(), rekeyedAj(), { endDate: '2026-12-31T00:00:00Z' });
    expect(c.bucket).toBe('PORT_BLOCKER');
    expect(c.kind).toBe('CANONICAL_EVENT');
  });

  test('MM-DD drift is NOT the declared transform', () => {
    const c = classify('text-deterministic-AJ', storedAj(),
      rekeyedAj({ condition_date: '2027-06-01', canonical_event: 'largest company by market cap 2027-06-01' }),
      { endDate: AJ_END });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('canonical_event changing beyond the ISO substitution is an UNDECLARED re-key', () => {
    const c = classify('text-deterministic-AJ', storedAj(),
      rekeyedAj({ canonical_event: 'second largest company by market cap 2027-05-31' }),
      { endDate: AJ_END });
    expect(c.bucket).toBe('PORT_BLOCKER');
    expect(c.kind).toBe('CANONICAL_EVENT');
  });

  test('extra field diffs riding along are NOT swallowed', () => {
    const c = classify('text-deterministic-AJ', storedAj(),
      rekeyedAj({ value_primary: 2, condition_value: '=2rank' }), { endDate: AJ_END });
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('condition_date-only year borrow WITHOUT a canonical_event diff stays DATE2 (no new class)', () => {
    // KOL rows whose canonical_event embeds the raw phrase, not the ISO — a
    // pure date diff classifies under the existing DATE2 signature when ±1.
    const c = classify('text-deterministic-AJ',
      storedAj({ canonical_event: 'xhunt kol leaderboard english week of may 31' }),
      rekeyedAj({ canonical_event: 'xhunt kol leaderboard english week of may 31' }),
      { endDate: AJ_END });
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DATE2');
  });
});

describe('EXPECTED_FLIP(MIDTERM_CYCLE) — rebuild-boundary declared re-key (6,018-row cycle-year class)', () => {
  const storedMt = (over: Partial<TupleFields> = {}) => tuple({
    event_kind: 'election_margin',
    condition_shape: 'point_in_time',
    condition_direction: 'above',
    condition_metric: null,
    temporal_semantics: 'at_resolution',
    value_primary: 5,
    value_secondary: null,
    value_unit: 'percentage points',
    condition_value: '>=5percentage points',
    condition_date: '2027-01-01',
    condition_date_precision: 'year',
    condition_date_source: 'event-year',
    canonical_event: '2027 texas 23 house race margin',
    ...over,
  });
  const rekeyedMt = (over: Partial<TupleFields> = {}) => storedMt({
    condition_date: '2026-01-01',
    canonical_event: '2026 texas 23 house race margin',
    ...over,
  });

  test('the declared re-key: leading year → 2026 cycle constant, race tail + date in lockstep', () => {
    const c = classify('kalshi:midterm-mov', storedMt(), rekeyedMt());
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('MIDTERM_CYCLE');
    expect(c.diffs.sort()).toEqual(['canonical_event', 'condition_date']);
  });

  test('voteturn sibling: same transform on the turnout suffix', () => {
    const c = classify('kalshi:midterm-voteturn',
      storedMt({ event_kind: 'election_turnout', value_unit: 'votes', condition_value: '>=5votes', canonical_event: '2020 washington 08 house race turnout', condition_date: '2020-01-01' }),
      rekeyedMt({ event_kind: 'election_turnout', value_unit: 'votes', condition_value: '>=5votes', canonical_event: '2026 washington 08 house race turnout', condition_date: '2026-01-01' }));
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('MIDTERM_CYCLE');
  });

  test('family-scoped: the same transform elsewhere still hits the R1 hard gate', () => {
    const c = classify('kalshi:price-ladder', storedMt(), rekeyedMt());
    expect(c.bucket).toBe('PORT_BLOCKER');
    expect(c.kind).toBe('CANONICAL_EVENT');
  });

  test('race tail drifting beyond the year substitution is an UNDECLARED re-key', () => {
    const c = classify('kalshi:midterm-mov', storedMt(),
      rekeyedMt({ canonical_event: '2026 texas 24 house race margin' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
    expect(c.kind).toBe('CANONICAL_EVENT');
  });

  test('an un-suffixed recomputed event (metric discriminator lost) is NOT declared', () => {
    const c = classify('kalshi:midterm-mov',
      storedMt({ canonical_event: '2027 texas 23 house race' }),
      rekeyedMt({ canonical_event: '2026 texas 23 house race' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('condition_date inconsistent with the stored leading year is NOT declared', () => {
    const c = classify('kalshi:midterm-mov', storedMt({ condition_date: '2028-01-01' }), rekeyedMt());
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('stamp diffs riding along (shape/temporal/metric) are NOT swallowed', () => {
    const c = classify('kalshi:midterm-mov', storedMt(), rekeyedMt({ condition_metric: 'percentage' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('already-2026 rows are EQUAL (the 47-row stable class)', () => {
    const c = classify('kalshi:midterm-mov', rekeyedMt(), rekeyedMt());
    expect(c.bucket).toBe('EQUAL');
  });
});

describe('EXPECTED_FLIP(KWIN_NULLDIR) — kalshi winner-family NULL direction/metric (finding #2, 2026-07-02)', () => {
  const storedWin = (over: Partial<TupleFields> = {}) => tuple({
    event_kind: 'match_winner',
    condition_shape: 'binary_event',
    condition_direction: 'at',
    condition_metric: 'boolean',
    temporal_semantics: 'on_date',
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    condition_value: 'winner=mouz',
    condition_date: '2026-05-15T09:00:00Z',
    condition_date_precision: 'minute',
    condition_date_source: 'kalshi-occurrence-datetime',
    canonical_event: 'aurora gaming vs mouz',
    ...over,
  });
  const flippedWin = (over: Partial<TupleFields> = {}) => storedWin({
    condition_direction: null,
    condition_metric: null,
    ...over,
  });

  test('the declared flip: at/boolean → NULL/NULL, all else equal (esports-winner)', () => {
    const c = classify('kalshi:esports-winner', storedWin(), flippedWin());
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('KWIN_NULLDIR');
    expect(c.diffs.sort()).toEqual(['condition_direction', 'condition_metric']);
  });

  test('winner-KX* categorical families are covered (prefix match, halftime_leader kind)', () => {
    const c = classify('kalshi:winner-KXEPL1H',
      storedWin({ condition_shape: 'categorical_outcome', event_kind: 'halftime_leader', temporal_semantics: 'at_resolution' }),
      flippedWin({ condition_shape: 'categorical_outcome', event_kind: 'halftime_leader', temporal_semantics: 'at_resolution' }));
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('KWIN_NULLDIR');
  });

  test('family-scoped: the same flip on kalshi:draft-pick (NOT flipped) is not declared', () => {
    const c = classify('kalshi:draft-pick', storedWin(), flippedWin());
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });

  test('map-ordinal discriminator must NOT ride along: a value_primary diff is a PORT_BLOCKER', () => {
    const c = classify('kalshi:esports-winner',
      storedWin({ value_primary: 2 }), flippedWin({ value_primary: null }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('metric_scope drift does NOT classify as the declared flip', () => {
    const c = classify('kalshi:esports-winner',
      storedWin({ metric_scope: 'map' }), flippedWin({ metric_scope: null }));
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });

  test('reverse flip (NULL → at/boolean) is NOT declared', () => {
    const c = classify('kalshi:esports-winner', flippedWin(), storedWin());
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('non-winner kind is NOT swallowed by the signature', () => {
    const c = classify('kalshi:esports-winner',
      storedWin({ event_kind: 'match_total_metric' }), flippedWin({ event_kind: 'match_total_metric' }));
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });

  test('already-flipped rows (post-rebuild stamp) are EQUAL', () => {
    const c = classify('kalshi:esports-winner', flippedWin(), flippedWin());
    expect(c.bucket).toBe('EQUAL');
  });
});

describe('EXPECTED_FLIP(DW58_RANK) — kalshi:primary-advance rank grain (DW-58, 2026-07-02)', () => {
  const storedAdv = (over: Partial<TupleFields> = {}) => tuple({
    event_kind: 'primary_winner',
    condition_shape: 'binary_event',
    condition_direction: 'at',
    condition_metric: 'boolean',
    temporal_semantics: 'at_resolution',
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    condition_value: 'advances',
    condition_date: '2026-01-01',
    condition_date_precision: 'year',
    condition_date_source: 'event-year',
    canonical_event: '2026 ca-50 republican primary',
    ...over,
  });
  const rankAdv = (over: Partial<TupleFields> = {}) => storedAdv({
    condition_shape: 'monotonic_threshold',
    condition_direction: 'below',
    condition_metric: null,
    value_primary: 2,
    value_unit: 'rank',
    condition_value: '<=2rank',
    canonical_event: '2026 ca-50 primary',
    ...over,
  });

  test('the declared flip: binary advance → rank≤2 latch + party-stripped race ce', () => {
    const c = classify('kalshi:primary-advance', storedAdv(), rankAdv());
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DW58_RANK');
  });

  test('no-party rows (ce unchanged) also classify', () => {
    const c = classify('kalshi:primary-advance',
      storedAdv({ canonical_event: '2026 ca-37 primary' }),
      rankAdv({ canonical_event: '2026 ca-37 primary' }));
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DW58_RANK');
  });

  test('family-scoped: the same flip on another family is NOT declared', () => {
    const c = classify('kalshi:place-first-primary', storedAdv(), rankAdv());
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });

  test('a ce rewrite that is NOT a party-strip of the same race is a PORT_BLOCKER', () => {
    const c = classify('kalshi:primary-advance',
      storedAdv({ canonical_event: '2026 ca-50 republican primary' }),
      rankAdv({ canonical_event: '2026 ca-49 primary' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('a wrong rank value (≠2) riding the flip is a PORT_BLOCKER', () => {
    const c = classify('kalshi:primary-advance', storedAdv(), rankAdv({ value_primary: 1, condition_value: '<=1rank' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('reverse flip is NOT declared', () => {
    const c = classify('kalshi:primary-advance', rankAdv(), storedAdv());
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('already-restamped rows (post-rebuild) are EQUAL', () => {
    const c = classify('kalshi:primary-advance', rankAdv(), rankAdv());
    expect(c.bucket).toBe('EQUAL');
  });
});

describe('EXPECTED_FLIP(DW58D_PLACEFIRST) - kalshi:place-first-primary party-free ce (DW-58(d), 2026-07-02)', () => {
  const storedPf = (over: Partial<TupleFields> = {}) => tuple({
    event_kind: 'election_outcome_winner',
    condition_shape: 'monotonic_threshold',
    condition_direction: 'below',
    condition_metric: null,
    temporal_semantics: 'at_resolution',
    value_primary: 1,
    value_secondary: null,
    value_unit: 'rank',
    condition_value: '<=1rank',
    condition_date: '2026-01-01',
    condition_date_precision: 'year',
    condition_date_source: 'event-year',
    canonical_event: '2026 ca-48 democratic primary',
    ...over,
  });
  const freePf = (over: Partial<TupleFields> = {}) => storedPf({ canonical_event: '2026 ca-48 primary', ...over });

  test('the declared flip: party-token race ce -> party-free race ce (ce-only diff)', () => {
    const c = classify('kalshi:place-first-primary', storedPf(), freePf());
    expect(c.bucket).toBe('EXPECTED_FLIP');
    expect(c.kind).toBe('DW58D_PLACEFIRST');
    expect(c.diffs).toEqual(['canonical_event']);
  });

  test('race unified: republican + democratic slots strip to the SAME race ce', () => {
    const dem = classify('kalshi:place-first-primary',
      storedPf({ canonical_event: '2026 ca-50 democratic primary' }),
      freePf({ canonical_event: '2026 ca-50 primary' }));
    const rep = classify('kalshi:place-first-primary',
      storedPf({ canonical_event: '2026 ca-50 republican primary' }),
      freePf({ canonical_event: '2026 ca-50 primary' }));
    expect(dem.kind).toBe('DW58D_PLACEFIRST');
    expect(rep.kind).toBe('DW58D_PLACEFIRST');
  });

  test('multi-word party segment (libertarian) strips', () => {
    const c = classify('kalshi:place-first-primary',
      storedPf({ canonical_event: '2026 ca-17 libertarian primary' }),
      freePf({ canonical_event: '2026 ca-17 primary' }));
    expect(c.kind).toBe('DW58D_PLACEFIRST');
  });

  test('already party-free rows (no subtitle) are EQUAL', () => {
    const c = classify('kalshi:place-first-primary', freePf(), freePf());
    expect(c.bucket).toBe('EQUAL');
  });

  test('family-scoped: a bare ce party-strip on another family is NOT DW58D', () => {
    const c = classify('kalshi:primary-advance', storedPf(), freePf());
    expect(c.bucket).not.toBe('EXPECTED_FLIP');
  });

  test('rank grain intact: any extra moving field (value_primary) blocks', () => {
    const c = classify('kalshi:place-first-primary', storedPf(),
      freePf({ value_primary: 2, condition_value: '<=2rank' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('a ce rewrite to a DIFFERENT race is a PORT_BLOCKER', () => {
    const c = classify('kalshi:place-first-primary',
      storedPf({ canonical_event: '2026 ca-48 democratic primary' }),
      freePf({ canonical_event: '2026 ca-49 primary' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('reverse flip (adding a party segment) is NOT declared', () => {
    const c = classify('kalshi:place-first-primary', freePf(), storedPf());
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('wrong event_kind riding the party-strip is a PORT_BLOCKER', () => {
    const c = classify('kalshi:place-first-primary',
      storedPf({ event_kind: 'primary_winner' }),
      freePf({ event_kind: 'primary_winner' }));
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('DOCUMENTED_EXCEPTION — lexicon pins + bespoke registry', () => {
  test('Template X touch↔snapshot diff OUTSIDE the declared flip is LATENT_BUG(A1) — the E1 pin is gone (addendum 2)', () => {
    // by_date (not the declared during_period) on the default dated title:
    // not A1_TOUCH, no pin to shadow it → the A1 latent signature is reachable
    // and flags it as an UNDECLARED flip.
    const stored = tuple({ condition_shape: 'point_in_time', temporal_semantics: 'on_date' });
    const recomputed = tuple({ condition_shape: 'monotonic_threshold', temporal_semantics: 'by_date' });
    const c = classify('text-deterministic-X', stored, recomputed);
    expect(c.bucket).toBe('LATENT_BUG');
    expect(c.kind).toBe('A1');
  });

  test('limitless:econ-above touch↔snapshot hits the E2/A2 pin', () => {
    const stored = tuple({ condition_shape: 'monotonic_threshold', temporal_semantics: 'by_date' });
    const recomputed = tuple({ condition_shape: 'point_in_time', temporal_semantics: 'on_date' });
    const c = classify('limitless:econ-above', stored, recomputed);
    expect(c.bucket).toBe('DOCUMENTED_EXCEPTION');
    expect(c.kind).toBe('A2');
  });

  test('AK barrier categorical_outcome+during_period re-shape hits the A3 bespoke pin', () => {
    const stored = tuple({ condition_shape: 'categorical_outcome', temporal_semantics: 'during_period' });
    const recomputed = tuple({ condition_shape: 'categorical_outcome', temporal_semantics: 'at_resolution' });
    const c = classify('text-deterministic-AK', stored, recomputed);
    expect(c.bucket).toBe('DOCUMENTED_EXCEPTION');
    expect(c.kind).toBe('A3');
  });

  test('limitless ATH direction-strip hits the ATH bespoke pin', () => {
    const stored = tuple({ condition_direction: 'above', condition_metric: 'price', value_primary: null, condition_value: null });
    const recomputed = tuple({ condition_direction: null, condition_metric: 'price', value_primary: null, condition_value: null });
    const c = classify('limitless:crypto-ath', stored, recomputed);
    expect(c.bucket).toBe('DOCUMENTED_EXCEPTION');
    expect(c.kind).toBe('ATH');
  });

  test('a NON-shape-class diff on a pinned family does NOT hide behind the pin', () => {
    // value_primary drift on Template X — the pin only covers the
    // touch↔snapshot axes; anything else must stay a PORT_BLOCKER.
    const stored = tuple({ value_primary: 50 });
    const recomputed = tuple({ value_primary: 55 });
    const c = classify('text-deterministic-X', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('AK shape diff WITHOUT the barrier signature is not swallowed by the A3 pin', () => {
    const stored = tuple({ condition_shape: 'binary_event', temporal_semantics: 'by_date' });
    const recomputed = tuple({ condition_shape: 'point_in_time', temporal_semantics: 'on_date' });
    const c = classify('text-deterministic-AK', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('EXPECTED_BASELINE_DRIFT — stored-side-stale rows', () => {
  test('metric_scope null→populated alone is baseline drift (5c5369b)', () => {
    const stored = tuple({ metric_scope: null });
    const recomputed = tuple({ metric_scope: 'game' });
    const c = classify('kalshi:game-total', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_BASELINE_DRIFT');
    expect(c.kind).toBe('metric_scope-5c5369b');
  });

  test('metric_scope populated→DIFFERENT is NOT baseline drift', () => {
    const stored = tuple({ metric_scope: 'team' });
    const recomputed = tuple({ metric_scope: 'game' });
    const c = classify('kalshi:game-total', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('match_spread monotonic→point_in_time + at_resolution is migration-073 drift', () => {
    const stored = tuple({
      event_kind: 'match_spread',
      condition_shape: 'monotonic_threshold',
      temporal_semantics: 'during_period',
    });
    const recomputed = tuple({
      event_kind: 'match_spread',
      condition_shape: 'point_in_time',
      temporal_semantics: 'at_resolution',
    });
    const c = classify('kalshi:mlb-spread', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_BASELINE_DRIFT');
    expect(c.kind).toBe('spread-073');
  });

  test('crypto_launch_fdv stored date → recomputed NULL is migration-073 S5 drift', () => {
    const stored = tuple({
      event_kind: 'crypto_launch_fdv',
      condition_date: '2026-12-31T00:00:00Z',
      condition_date_precision: 'day',
      condition_date_source: 'end_date',
    });
    const recomputed = tuple({
      event_kind: 'crypto_launch_fdv',
      condition_date: null,
      condition_date_precision: null,
      condition_date_source: null,
    });
    const c = classify('text-deterministic-AA', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_BASELINE_DRIFT');
    expect(c.kind).toBe('fdv-073');
  });

  test('end_date-derived date moved (both sides end_date-sourced) is baseline drift', () => {
    const stored = tuple({
      condition_date: '2026-06-30T00:00:00Z',
      condition_date_precision: null,
      condition_date_source: null,
    });
    const recomputed = tuple({
      condition_date: '2026-07-31T00:00:00Z',
      condition_date_precision: null,
      condition_date_source: null,
    });
    const c = classify('text-deterministic-B', stored, recomputed);
    expect(c.bucket).toBe('EXPECTED_BASELINE_DRIFT');
    expect(c.kind).toBe('end-date-moved');
  });

  test('date moved with a TITLE-derived source is NOT end_date drift', () => {
    const stored = tuple({ condition_date: '2026-06-30', condition_date_source: 'title-mdy' });
    const recomputed = tuple({ condition_date: '2026-07-31', condition_date_source: 'title-mdy' });
    const c = classify('text-deterministic-B', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });

  test('baseline-drift field mixed with an unexplained field is PORT_BLOCKER', () => {
    const stored = tuple({ metric_scope: null, value_primary: 5 });
    const recomputed = tuple({ metric_scope: 'game', value_primary: 6 });
    const c = classify('kalshi:game-total', stored, recomputed);
    expect(c.bucket).toBe('PORT_BLOCKER');
  });
});

describe('pairDrifts — cross-ref scoreboard comparators (S2/S5 model)', () => {
  test('both-null never drifts; one-null never drifts (NULL-tolerant by doctrine)', () => {
    expect(pairDrifts('condition_direction', tuple({ condition_direction: null }), tuple({ condition_direction: null }))).toBe(false);
    expect(pairDrifts('condition_direction', tuple({ condition_direction: null }), tuple({ condition_direction: 'above' }))).toBe(false);
  });

  test('value_unit compares case-folded (lower() in the model query)', () => {
    expect(pairDrifts('value_unit', tuple({ value_unit: 'USD' }), tuple({ value_unit: 'usd' }))).toBe(false);
    expect(pairDrifts('value_unit', tuple({ value_unit: 'USD' }), tuple({ value_unit: 'EUR' }))).toBe(true);
  });

  test('condition_date compares at the COARSER precision (§6 S5 semantics)', () => {
    const yearSide = tuple({ condition_date: '2026-01-01', condition_date_precision: 'year' });
    const daySide = tuple({ condition_date: '2026-11-15', condition_date_precision: 'day' });
    expect(pairDrifts('condition_date', yearSide, daySide)).toBe(false); // same year
    const otherYear = tuple({ condition_date: '2027-11-15', condition_date_precision: 'day' });
    expect(pairDrifts('condition_date', yearSide, otherYear)).toBe(true);
    const monthSide = tuple({ condition_date: '2026-11-01', condition_date_precision: 'month' });
    expect(pairDrifts('condition_date', monthSide, daySide)).toBe(false); // same month
  });

  test('numeric fields drift numerically', () => {
    expect(pairDrifts('value_primary', tuple({ value_primary: 72000 }), tuple({ value_primary: 72000.0 }))).toBe(false);
    expect(pairDrifts('value_primary', tuple({ value_primary: 72000 }), tuple({ value_primary: 71999.99 }))).toBe(true);
  });
});

// Unit-vocab evolution pre-pass: stored rows predating a canonicalUnit
// pluralization must not mask or be masked by declared flips.
import { test as t3, expect as e3 } from 'bun:test';
const ahBase = {
  event_kind: 'social_media_metric', condition_shape: 'range_snapshot',
  condition_metric: 'count', temporal_semantics: 'during_period',
  condition_date: '2026-06-01', condition_date_precision: 'day', condition_date_source: 'predict-title',
  value_primary: 6, value_secondary: 10, metric_scope: null, outcome_label: '6-10',
  canonical_event: 'cz tweet_count jun 1-7 2026',
} as const;
t3('pure unit pluralization -> EXPECTED_BASELINE_DRIFT(unit-vocab-evolved)', () => {
  const c = classifyRow({
    family: 'text-deterministic-AH',
    stored:     { ...ahBase, condition_direction: null, value_unit: 'tweet',  condition_value: '6_10tweet' },
    recomputed: { ...ahBase, condition_direction: null, value_unit: 'tweets', condition_value: '6_10tweets' },
    now: new Date('2026-06-11T00:00:00Z'), endDate: null, title: 'Number of CZ tweets Jun 1-7 2026: 6-10',
  } as never);
  e3(c.bucket).toBe('EXPECTED_BASELINE_DRIFT');
  e3(c.kind).toBe('unit-vocab-evolved');
});
t3('unit pluralization COMPOSES with the O3 flip -> EXPECTED_FLIP(O3+unit-vocab-evolved)', () => {
  const c = classifyRow({
    family: 'text-deterministic-AH',
    stored:     { ...ahBase, condition_direction: null,      value_unit: 'tweet',  condition_value: '6_10tweet' },
    recomputed: { ...ahBase, condition_direction: 'between', value_unit: 'tweets', condition_value: '6-10tweets' },
    now: new Date('2026-06-11T00:00:00Z'), endDate: null, title: 'Number of CZ tweets Jun 1-7 2026: 6-10',
  } as never);
  e3(c.bucket).toBe('EXPECTED_FLIP');
  e3(c.kind).toBe('O3+unit-vocab-evolved');
});
