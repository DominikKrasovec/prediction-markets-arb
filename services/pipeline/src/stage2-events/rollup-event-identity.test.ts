/**
 * Padded-date precision demotion.
 *
 * The Phase-2 roll-up demotes day-precision condition_dates to 'year' on
 * open-ended race events whose dates are just platform end_date padding
 * (PM pads "next manager" races to Dec 31, Kalshi to its review date — two
 * different day-precise dates for the same race hard-block true pairs at
 * the ann date gate).
 *
 * The demotion decision lives in SQL (a CASE in the Phase-2 UPDATE); these
 * tests pin the pure mirror `demotePaddedDatePrecision` that is kept in sync
 * with it.
 */
import { describe, test, expect } from 'bun:test';
import {
  demotePaddedDatePrecision,
  demoteMultiDayModalPrecision,
  OPEN_ENDED_RACE_KINDS,
} from './rollup-event-identity.js';

describe('W2-R6b demotePaddedDatePrecision (pure mirror of the Phase-2 SQL CASE)', () => {
  test('REGRESSION (Maresca class): open-ended race + day precision + padding majority → year', () => {
    // PM "EPL: Next Chelsea Manager?" — all children stamped cond == end_date
    // (Dec 31 padding) with precision 'day'. Must demote so the date gate
    // (which skips year/month) stops blocking the Kalshi/Limitless twins.
    expect(demotePaddedDatePrecision('personnel_move', 'day', true)).toBe('year');
    expect(demotePaddedDatePrecision('participation', 'day', true)).toBe('year');
    expect(demotePaddedDatePrecision('award_winner', 'day', true)).toBe('year');
    expect(demotePaddedDatePrecision('championship_winner', 'day', true)).toBe('year');
  });

  test('SOUNDNESS: fixture kinds are NEVER demoted (their end_date IS the game date)', () => {
    // For a fixture, cond == end_date is consistent with a REAL day-precision
    // game date — demoting would loosen the date gate on different-day games.
    expect(demotePaddedDatePrecision('match_winner', 'day', true)).toBe('day');
    expect(demotePaddedDatePrecision('exact_score', 'day', true)).toBe('day');
    expect(demotePaddedDatePrecision('weather_extreme', 'day', true)).toBe('day');
    expect(demotePaddedDatePrecision('candle_direction', 'day', true)).toBe('day');
  });

  test('title-derived dates (no padding majority) keep day precision', () => {
    // "Will X be out by August 1?" — a real title deadline that happens to be
    // day-precise must keep its authority even on an open-ended race kind.
    expect(demotePaddedDatePrecision('personnel_move', 'day', false)).toBe('day');
    expect(demotePaddedDatePrecision('championship_winner', 'day', false)).toBe('day');
  });

  test('non-day precisions pass through unchanged (gate already skips year/month)', () => {
    expect(demotePaddedDatePrecision('personnel_move', 'month', true)).toBe('month');
    expect(demotePaddedDatePrecision('personnel_move', 'year', true)).toBe('year');
    expect(demotePaddedDatePrecision('personnel_move', 'minute', true)).toBe('minute');
    expect(demotePaddedDatePrecision('personnel_move', 'hour', true)).toBe('hour');
    expect(demotePaddedDatePrecision('personnel_move', null, true)).toBeNull();
  });

  test('NULL/unknown event_kind is fail-safe (no demotion)', () => {
    expect(demotePaddedDatePrecision(null, 'day', true)).toBe('day');
    expect(demotePaddedDatePrecision('other', 'day', true)).toBe('day');
  });

  test('OPEN_ENDED_RACE_KINDS is exactly the probed open-ended race family', () => {
    // Pin the list: derived from the date-gate design (award_winner belongs
    // to the same family per embed-events FUTURES_DATELESS_KINDS). Adding a
    // fixture kind here would unsoundly loosen the date gate — see the
    // SOUNDNESS test above.
    expect([...OPEN_ENDED_RACE_KINDS].sort()).toEqual([
      'award_winner', 'championship_winner', 'participation', 'personnel_move',
    ]);
  });
});

describe('finding-#6 demoteMultiDayModalPrecision (pure mirror of the Phase-2/3 multi-day arm)', () => {
  test('REGRESSION (QFEX class): day-precise mode over a multi-day deadline ladder → year', () => {
    // A multi-day deadline ladder (e.g. "Will QFEX launch a token by ___?")
    // where different platforms' modal day differs for the same family. The
    // day×day ANN date arm would otherwise block true cross-platform pairs.
    // Demoting to 'year' makes the date gate skip the day-level check.
    expect(demoteMultiDayModalPrecision('day', 2)).toBe('year');
    expect(demoteMultiDayModalPrecision('day', 8)).toBe('year');
  });

  test('single-day events keep day precision (a real per-fixture date)', () => {
    expect(demoteMultiDayModalPrecision('day', 1)).toBe('day');
    expect(demoteMultiDayModalPrecision('day', 0)).toBe('day');
  });

  test('fine precisions are NOT demoted (fine-grained date arms decide, not day×day)', () => {
    expect(demoteMultiDayModalPrecision('minute', 5)).toBe('minute');
    expect(demoteMultiDayModalPrecision('hour', 3)).toBe('hour');
  });

  test('coarse/NULL precisions pass through unchanged (gate already skips them)', () => {
    expect(demoteMultiDayModalPrecision('month', 4)).toBe('month');
    expect(demoteMultiDayModalPrecision('year', 4)).toBe('year');
    expect(demoteMultiDayModalPrecision(null, 4)).toBeNull();
  });
});
