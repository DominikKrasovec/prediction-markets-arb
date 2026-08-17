/**
 * Unit suite for the one date layer: parseMonthToken (one table, full +
 * 3-letter + 'sept'), monthEndIso (leap-correct), yearAnchorIso (padded
 * start), inferYear (verbatim event-date-extractor rule, `now` injectable),
 * and the four stampConditionDate spec kinds incl. pad start vs end.
 *
 * The leap pin: "end of February 2028" stamps 02-29.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseMonthToken,
  monthEndIso,
  yearAnchorIso,
  inferYear,
  stampConditionDate,
} from './condition-date.js';

// Frozen clock for everything year-inference-shaped (no run-date dependence).
const NOW = new Date(Date.UTC(2026, 5, 11)); // 2026-06-11T00:00:00Z

describe('parseMonthToken — ONE table: full + 3-letter + sept', () => {
  test('full names', () => {
    expect(parseMonthToken('January')).toBe(1);
    expect(parseMonthToken('february')).toBe(2);
    expect(parseMonthToken('September')).toBe(9);
    expect(parseMonthToken('DECEMBER')).toBe(12);
  });

  test('3-letter abbreviations', () => {
    expect(parseMonthToken('jan')).toBe(1);
    expect(parseMonthToken('Sep')).toBe(9);
    expect(parseMonthToken('DEC')).toBe(12);
    expect(parseMonthToken(' may ')).toBe(5); // trimmed
  });

  test("the 4-letter 'sept' outlier is in the table", () => {
    expect(parseMonthToken('sept')).toBe(9);
    expect(parseMonthToken('Sept')).toBe(9);
  });

  test('non-months → null', () => {
    expect(parseMonthToken('foo')).toBeNull();
    expect(parseMonthToken('')).toBeNull();
    expect(parseMonthToken('janua')).toBeNull(); // not a table member — no prefix guessing
  });
});

describe('monthEndIso — Date.UTC(y, m, 0) is leap-correct', () => {
  test('leap February: 2028 → 02-29', () => {
    expect(monthEndIso(2028, 2)).toBe('2028-02-29');
  });
  test('non-leap February: 2026 → 02-28', () => {
    expect(monthEndIso(2026, 2)).toBe('2026-02-28');
  });
  test('30/31-day months and December', () => {
    expect(monthEndIso(2026, 4)).toBe('2026-04-30');
    expect(monthEndIso(2026, 5)).toBe('2026-05-31');
    expect(monthEndIso(2026, 12)).toBe('2026-12-31');
  });
});

describe('yearAnchorIso — padded START (THE doctrine convention, §5.1)', () => {
  test('-01-01, never -12-31', () => {
    expect(yearAnchorIso(2027)).toBe('2027-01-01');
  });
});

describe('inferYear — verbatim event-date-extractor rule, now injectable (R9)', () => {
  test('end_date year inside [now-1, now+5] wins', () => {
    expect(inferYear(12, 31, '2025-03-01', NOW)).toBe(2025);            // now-1 edge
    expect(inferYear(1, 1, '2031-12-31T00:00:00Z', NOW)).toBe(2031);    // now+5 edge
  });

  test('end_date year outside the window falls back to the heuristic', () => {
    expect(inferYear(6, 11, '2032-01-01', NOW)).toBe(2026);  // 2032 > now+5 → heuristic, today → nowYear
    expect(inferYear(6, 11, '2024-06-01', NOW)).toBe(2026);  // 2024 < now-1 → heuristic
    expect(inferYear(1, 1, '2032-01-01', NOW)).toBe(2027);   // heuristic rolls a stale Jan 1 forward
  });

  test('30-day past-rollover edges', () => {
    expect(inferYear(6, 11, null, NOW)).toBe(2026);  // today
    expect(inferYear(5, 12, null, NOW)).toBe(2026);  // exactly 30 days past → still current year
    expect(inferYear(5, 11, null, NOW)).toBe(2027);  // 31 days past → next year
    expect(inferYear(1, 1, null, NOW)).toBe(2027);   // deep past → next year
    expect(inferYear(12, 25, null, NOW)).toBe(2026); // future date stays current year
  });
});

describe('stampConditionDate — monthDay ("May 17[, 2026]")', () => {
  test('explicit year', () => {
    expect(stampConditionDate({ kind: 'monthDay', text: 'May 17, 2026', endDate: null }))
      .toEqual({ iso: '2026-05-17', precision: 'day' });
  });

  test('ordinal suffix + trailing punctuation tolerated', () => {
    expect(stampConditionDate({ kind: 'monthDay', text: 'March 3rd, 2027', endDate: null }))
      .toEqual({ iso: '2027-03-03', precision: 'day' });
    expect(stampConditionDate({ kind: 'monthDay', text: 'May 17, 2026?', endDate: null }))
      .toEqual({ iso: '2026-05-17', precision: 'day' });
  });

  test('year omitted → inferYear (end_date year borrowed only inside the window)', () => {
    expect(stampConditionDate({ kind: 'monthDay', text: 'May 17', endDate: '2026-08-01T00:00:00Z', now: NOW }))
      .toEqual({ iso: '2026-05-17', precision: 'day' });
    // no end_date: 30-day rollover heals the stale current-year default
    expect(stampConditionDate({ kind: 'monthDay', text: 'March 3', endDate: null, now: NOW }))
      .toEqual({ iso: '2027-03-03', precision: 'day' });
  });

  test('3-letter / sept month tokens accepted', () => {
    expect(stampConditionDate({ kind: 'monthDay', text: 'Sept 5, 2027', endDate: null }))
      .toEqual({ iso: '2027-09-05', precision: 'day' });
  });

  test('invalid calendar days and non-months → null', () => {
    expect(stampConditionDate({ kind: 'monthDay', text: 'February 30, 2026', endDate: null })).toBeNull();
    expect(stampConditionDate({ kind: 'monthDay', text: 'Foo 12, 2026', endDate: null })).toBeNull();
    expect(stampConditionDate({ kind: 'monthDay', text: 'just words', endDate: null })).toBeNull();
  });
});

describe('stampConditionDate — monthToken (pad start vs end)', () => {
  test("pad 'start': first-of-month anchor + precision 'month' (limitlessMonthDate semantics)", () => {
    expect(stampConditionDate({ kind: 'monthToken', mon: 'June', year: 2026, pad: 'start' }))
      .toEqual({ iso: '2026-06-01', precision: 'month' });
  });

  test("pad 'end': leap-correct month-end DEADLINE day + precision 'day' (Template AD semantics)", () => {
    expect(stampConditionDate({ kind: 'monthToken', mon: 'feb', year: 2028, pad: 'end' }))
      .toEqual({ iso: '2028-02-29', precision: 'day' }); // leap pin
    expect(stampConditionDate({ kind: 'monthToken', mon: 'February', year: 2026, pad: 'end' }))
      .toEqual({ iso: '2026-02-28', precision: 'day' });
  });

  test("pad 'end-month' (WP-3.3 DATE_EOM): month-END day at MONTH precision", () => {
    // THE canonical month-grain deadline: ISO = "by end of May" day-stamp, grain = month.
    expect(stampConditionDate({ kind: 'monthToken', mon: 'May', year: 2026, pad: 'end-month' }))
      .toEqual({ iso: '2026-05-31', precision: 'month' });
    expect(stampConditionDate({ kind: 'monthToken', mon: 'June', year: 2026, pad: 'end-month' }))
      .toEqual({ iso: '2026-06-30', precision: 'month' });
    // leap-correct (mirrors the `phrase` month-no-day and pad 'end' pins)
    expect(stampConditionDate({ kind: 'monthToken', mon: 'feb', year: 2028, pad: 'end-month' }))
      .toEqual({ iso: '2028-02-29', precision: 'month' });
    // identical to the `phrase` "Month Year" output (one canonical representation)
    expect(stampConditionDate({ kind: 'monthToken', mon: 'June', year: 2026, pad: 'end-month' }))
      .toEqual(stampConditionDate({ kind: 'phrase', text: 'June 2026', endDate: null }));
  });

  test('year falls back to the end_date year', () => {
    expect(stampConditionDate({ kind: 'monthToken', mon: 'sept', endDate: '2026-03-15T00:00:00Z', pad: 'start' }))
      .toEqual({ iso: '2026-09-01', precision: 'month' });
  });

  test('no year, bad endDate, or bad month → null', () => {
    expect(stampConditionDate({ kind: 'monthToken', mon: 'June', pad: 'start' })).toBeNull();
    expect(stampConditionDate({ kind: 'monthToken', mon: 'June', endDate: 'garbage', pad: 'start' })).toBeNull();
    expect(stampConditionDate({ kind: 'monthToken', mon: 'notamonth', year: 2026, pad: 'start' })).toBeNull();
  });
});

describe('stampConditionDate — year (padded START)', () => {
  test('{ yearAnchorIso, year }', () => {
    expect(stampConditionDate({ kind: 'year', year: 2027 }))
      .toEqual({ iso: '2027-01-01', precision: 'year' });
  });
});

describe('stampConditionDate — phrase (parsePredictDate superset)', () => {
  test('LEAP PIN: "end of February 2028" → 02-29 (was 02-28 via PREDICT_MONTH_LAST)', () => {
    expect(stampConditionDate({ kind: 'phrase', text: 'end of February 2028', endDate: null, now: NOW }))
      .toEqual({ iso: '2028-02-29', precision: 'month' });
    expect(stampConditionDate({ kind: 'phrase', text: 'end of February 2026', endDate: null, now: NOW }))
      .toEqual({ iso: '2026-02-28', precision: 'month' });
  });

  test('month + day + year → day precision', () => {
    expect(stampConditionDate({ kind: 'phrase', text: 'December 31, 2026', endDate: null, now: NOW }))
      .toEqual({ iso: '2026-12-31', precision: 'day' });
  });

  test('bare year → padded START + year precision (§5.1 flip from -12-31)', () => {
    expect(stampConditionDate({ kind: 'phrase', text: '2027', endDate: null, now: NOW }))
      .toEqual({ iso: '2027-01-01', precision: 'year' });
    expect(stampConditionDate({ kind: 'phrase', text: 'before 2027', endDate: null, now: NOW }))
      .toEqual({ iso: '2027-01-01', precision: 'year' });
  });

  test('month + year (no day) → month-end + month precision', () => {
    expect(stampConditionDate({ kind: 'phrase', text: 'June 2026', endDate: null, now: NOW }))
      .toEqual({ iso: '2026-06-30', precision: 'month' });
  });

  test("superset: 3-letter and 'sept' tokens parse (parsePredictDate was full-name-only)", () => {
    expect(stampConditionDate({ kind: 'phrase', text: 'in sept 2026', endDate: null, now: NOW }))
      .toEqual({ iso: '2026-09-30', precision: 'month' });
  });

  test('year omitted → inferYear, not the raw run-date year (§5.2.1 healing)', () => {
    expect(stampConditionDate({ kind: 'phrase', text: 'September', endDate: '2026-11-30T00:00:00Z', now: NOW }))
      .toEqual({ iso: '2026-09-30', precision: 'month' });
    // past month with no end_date rolls forward
    expect(stampConditionDate({ kind: 'phrase', text: 'March 3', endDate: null, now: NOW }))
      .toEqual({ iso: '2027-03-03', precision: 'day' });
  });

  test('no month and no year → null', () => {
    expect(stampConditionDate({ kind: 'phrase', text: 'whenever the bill passes', endDate: null, now: NOW }))
      .toBeNull();
  });
});
