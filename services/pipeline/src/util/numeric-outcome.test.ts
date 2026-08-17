/**
 * Unit suite for parseNumericOutcome / snapshotStamp.
 *
 * Pins every grammar branch of the union parser, the hi-lo input swap (the
 * parser owns it; the door only rejects), the opt-in scale engines, the
 * $/%/comma tolerances, allowNegative, and null-on-garbage. The range fold
 * (range ⇒ direction 'between', always) is pinned via snapshotStamp.
 */
import { describe, test, expect } from 'bun:test';
import { parseNumericOutcome, snapshotStamp } from './numeric-outcome.js';

describe('parseNumericOutcome — comparator prefixes', () => {
  test.each([
    ['<2.5', 2.5], ['≤3', 3], ['＜5', 5], ['<= 7', 7], ['< 1,500', 1500],
  ] as const)('%s → below %p', (label, v) => {
    expect(parseNumericOutcome(label)).toEqual({ kind: 'below', v });
  });

  test.each([
    ['>100', 100], ['≥7', 7], ['>= 7', 7], ['> $2,000', 2000],
  ] as const)('%s → above %p', (label, v) => {
    expect(parseNumericOutcome(label)).toEqual({ kind: 'above', v });
  });
});

describe('parseNumericOutcome — bounded phrases and the + suffix', () => {
  test.each([
    ['250+', 250], ['3 or more', 3], ['5 or higher', 5], ['at least 4', 4], ['$1,000,000+', 1000000],
  ] as const)('%s → above %p', (label, v) => {
    expect(parseNumericOutcome(label)).toEqual({ kind: 'above', v });
  });

  test.each([
    ['2 or less', 2], ['3 or fewer', 3], ['6 or lower', 6], ['fewer than 10', 10],
  ] as const)('%s → below %p', (label, v) => {
    expect(parseNumericOutcome(label)).toEqual({ kind: 'below', v });
  });
});

describe('parseNumericOutcome — ranges (lo<hi GUARANTEED, hi-lo inputs swapped)', () => {
  test.each([
    ['3.1-3.2%', 3.1, 3.2],
    ['90–100', 90, 100],          // en-dash
    ['1 to 2', 1, 2],
    ['between 80000 and 100000', 80000, 100000],
    ['360-379', 360, 379],
  ] as const)('%s → range [%p, %p]', (label, lo, hi) => {
    expect(parseNumericOutcome(label)).toEqual({ kind: 'range', lo, hi });
  });

  test('hi-lo inputs are SWAPPED so lo<hi always holds (Stripe "$95B–$90B")', () => {
    expect(parseNumericOutcome('$95B–$90B', { scale: 'kmb' }))
      .toEqual({ kind: 'range', lo: 90e9, hi: 95e9 });
    expect(parseNumericOutcome('5-3')).toEqual({ kind: 'range', lo: 3, hi: 5 });
    expect(parseNumericOutcome('between 100 and 90')).toEqual({ kind: 'range', lo: 90, hi: 100 });
  });

  test('degenerate lo===hi collapses to an exact point, never a zero-width range', () => {
    expect(parseNumericOutcome('5-5')).toEqual({ kind: 'at', v: 5 });
  });
});

describe('parseNumericOutcome — bare values and tolerances', () => {
  test('bare number → exact-value bucket (at)', () => {
    expect(parseNumericOutcome('97')).toEqual({ kind: 'at', v: 97 });
    expect(parseNumericOutcome('3.2%')).toEqual({ kind: 'at', v: 3.2 }); // % tolerated by default
    expect(parseNumericOutcome('$80,000')).toEqual({ kind: 'at', v: 80000 }); // $ + comma tolerance
  });

  test('opts.pct REQUIRES the % suffix', () => {
    expect(parseNumericOutcome('3.2%', { pct: true })).toEqual({ kind: 'at', v: 3.2 });
    expect(parseNumericOutcome('3.1-3.2%', { pct: true })).toEqual({ kind: 'range', lo: 3.1, hi: 3.2 });
    expect(parseNumericOutcome('3.2', { pct: true })).toBeNull();
  });
});

describe('parseNumericOutcome — scale engine (opt-in, subsumes the 5 multiplier tables, O7)', () => {
  test("scale 'kmb': K/M/B suffixes, case-folded", () => {
    expect(parseNumericOutcome('90K-100K', { scale: 'kmb' })).toEqual({ kind: 'range', lo: 90000, hi: 100000 });
    expect(parseNumericOutcome('1.5m', { scale: 'kmb' })).toEqual({ kind: 'at', v: 1.5e6 });
    expect(parseNumericOutcome('$2B+', { scale: 'kmb' })).toEqual({ kind: 'above', v: 2e9 });
  });

  test("scale 'words': billion/million/thousand", () => {
    expect(parseNumericOutcome('1.5 billion', { scale: 'words' })).toEqual({ kind: 'at', v: 1.5e9 });
    expect(parseNumericOutcome('250 million', { scale: 'words' })).toEqual({ kind: 'at', v: 250e6 });
    expect(parseNumericOutcome('at least 100 thousand', { scale: 'words' })).toEqual({ kind: 'above', v: 100e3 });
  });

  test('numeric scale: fixed multiplier (jobs ×1000, valuation ×1e9)', () => {
    expect(parseNumericOutcome('150', { scale: 1000 })).toEqual({ kind: 'at', v: 150000 });
    expect(parseNumericOutcome('150-200', { scale: 1000 })).toEqual({ kind: 'range', lo: 150000, hi: 200000 });
  });

  test('suffixes are OPT-IN: without the matching scale the token is garbage, not 100', () => {
    expect(parseNumericOutcome('100K')).toBeNull();
    expect(parseNumericOutcome('1.5 billion')).toBeNull();
    expect(parseNumericOutcome('1.5 billion', { scale: 'kmb' })).toBeNull();
    expect(parseNumericOutcome('1.5B', { scale: 'words' })).toBeNull();
  });
});

describe('parseNumericOutcome — allowNegative (PM_PCT GDP prints)', () => {
  test('negatives rejected by default', () => {
    expect(parseNumericOutcome('-0.5')).toBeNull();
    expect(parseNumericOutcome('-0.5%')).toBeNull();
  });

  test('allowNegative admits signed values and signed ranges', () => {
    expect(parseNumericOutcome('-0.5%', { allowNegative: true })).toEqual({ kind: 'at', v: -0.5 });
    expect(parseNumericOutcome('-1 to 0', { allowNegative: true })).toEqual({ kind: 'range', lo: -1, hi: 0 });
    expect(parseNumericOutcome('-1--0.5', { allowNegative: true })).toEqual({ kind: 'range', lo: -1, hi: -0.5 });
    expect(parseNumericOutcome('fewer than -2', { allowNegative: true })).toEqual({ kind: 'below', v: -2 });
  });
});

describe('parseNumericOutcome — null on garbage (unshaped beats unsound)', () => {
  test.each([
    '', '   ', 'abc', '5 goals', 'between x and y', 'reach', '$', '%', '1.2.3', '5 to', 'more than',
  ])('%p → null', (label) => {
    expect(parseNumericOutcome(label)).toBeNull();
  });
});

describe('snapshotStamp — the O3 fold, made once', () => {
  test("range ⇒ range_snapshot + direction 'between', ALWAYS", () => {
    expect(snapshotStamp({ kind: 'range', lo: 3.1, hi: 3.2 }))
      .toEqual({ shape: 'range_snapshot', direction: 'between', vp: 3.1, vs: 3.2 });
  });

  test('points ⇒ point_in_time with the comparator direction', () => {
    expect(snapshotStamp({ kind: 'above', v: 100000 }))
      .toEqual({ shape: 'point_in_time', direction: 'above', vp: 100000, vs: null });
    expect(snapshotStamp({ kind: 'below', v: 2.5 }))
      .toEqual({ shape: 'point_in_time', direction: 'below', vp: 2.5, vs: null });
    expect(snapshotStamp({ kind: 'at', v: 97 }))
      .toEqual({ shape: 'point_in_time', direction: 'at', vp: 97, vs: null });
  });
});
