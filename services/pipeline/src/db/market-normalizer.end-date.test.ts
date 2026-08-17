/**
 * Predict end_date slug-inference: the four categorySlug patterns must
 * produce HOST-TZ-INDEPENDENT instants. P2 ('YYYY-MM-DD') always parses as
 * T00:00:00Z, and P3 ('april-20-2026') / P4 ('-on-april-5') must resolve to
 * that same UTC midnight rather than a host-local midnight. end_date feeds
 * the solver liveness gate, the upsert changed-guard tuple, and the
 * last-resort roll-up date, so it must not depend on where the pipeline runs.
 *
 * These tests pin all three date-shaped patterns for the SAME calendar day to
 * the SAME UTC instant, using exact epoch equality so the assertions hold
 * regardless of host timezone.
 */
import { describe, test, expect } from 'bun:test';
import { normalizeMarketDoc } from './market-normalizer.js';

function predictEndDate(slug: string, createdAt?: string): Date | null {
  return normalizeMarketDoc(
    { id: '1', question: 'Test?', categorySlug: slug, ...(createdAt ? { createdAt } : {}) } as any,
    'predict',
  ).end_date;
}

const UTC_APR_20_2026 = Date.UTC(2026, 3, 20); // 2026-04-20T00:00:00Z

describe('Predict slug end_date — P2/P3/P4 pinned to the same UTC instant (audit-r2 #14)', () => {
  test('P2 ISO slug → UTC midnight (unchanged reference behavior)', () => {
    expect(predictEndDate('lol-fur-red-2026-04-20')!.getTime()).toBe(UTC_APR_20_2026);
  });

  test('P3 month-day-year slug → SAME UTC instant as P2', () => {
    expect(predictEndDate('bitcoin-up-or-down-april-20-2026-11am-et')!.getTime()).toBe(UTC_APR_20_2026);
  });

  test('P4 legacy month-day slug (year from createdAt, UTC) → SAME UTC instant as P2', () => {
    expect(predictEndDate('bitcoin-price-on-april-20', '2026-03-01T12:00:00Z')!.getTime()).toBe(UTC_APR_20_2026);
  });

  test('P3 year-end slug stays on ITS OWN UTC calendar day (the CEST previous-day shift)', () => {
    // Must be Dec 31 UTC midnight, not shifted to the previous day by host timezone.
    expect(predictEndDate('will-trump-be-impeached-by-december-31-2026')!.getTime())
      .toBe(Date.UTC(2026, 11, 31));
  });

  test('P3 abbreviated month + ordinal day parse UTC too', () => {
    expect(predictEndDate('something-dec-3rd-2026')!.getTime()).toBe(Date.UTC(2026, 11, 3));
  });

  test('P4 year-boundary advance (slug day >6 months before createdAt) stays UTC', () => {
    // createdAt Nov 2026, slug "january-5" → advanced to Jan 5, 2027 UTC midnight.
    expect(predictEndDate('ethereum-above-on-january-5', '2026-11-20T00:00:00Z')!.getTime())
      .toBe(Date.UTC(2027, 0, 5));
  });

  test('calendar overflow is rejected like the old Invalid-Date parse (no Date.UTC rollover)', () => {
    expect(predictEndDate('oops-february-31-2026')).toBeNull();
    expect(predictEndDate('word-salad-on-notamonth-5')).toBeNull();
  });

  test('P1 unix-timestamp slug takes precedence and is untouched', () => {
    expect(predictEndDate('btc-updown-15m-1777383900')!.getTime()).toBe(1777383900 * 1000);
  });
});
