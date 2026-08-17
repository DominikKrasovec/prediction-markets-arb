import { describe, test, expect } from 'bun:test';
import { stripWeatherDateSuffix } from './weather-stations.js';

describe('stripWeatherDateSuffix', () => {
  test('Kalshi long form with year and trailing ? — strips suffix', () => {
    expect(stripWeatherDateSuffix('Highest temperature in Atlanta on May 10, 2026?'))
      .toBe('Highest temperature in Atlanta');
  });

  test('Polymarket short form without year, no trailing ?', () => {
    expect(stripWeatherDateSuffix('Highest temperature in Atlanta on May 11'))
      .toBe('Highest temperature in Atlanta');
  });

  test('Polymarket short form with trailing ?', () => {
    expect(stripWeatherDateSuffix('Highest temperature in Amsterdam on May 11?'))
      .toBe('Highest temperature in Amsterdam');
  });

  test('Kalshi lowest temperature variant', () => {
    expect(stripWeatherDateSuffix('Lowest temperature in Boston on May 13, 2026?'))
      .toBe('Lowest temperature in Boston');
  });

  test('3-letter month abbreviation', () => {
    expect(stripWeatherDateSuffix('Highest temperature in Chicago on Mar 26, 2026'))
      .toBe('Highest temperature in Chicago');
  });

  test('"in" variant (rare phrasing)', () => {
    expect(stripWeatherDateSuffix('Highest temperature in Dallas in May 14'))
      .toBe('Highest temperature in Dallas');
  });

  test('city with two-word name survives strip', () => {
    expect(stripWeatherDateSuffix('Highest temperature in New York City on May 11, 2026?'))
      .toBe('Highest temperature in New York City');
  });

  test('no date suffix → returns unchanged (minus trailing ?)', () => {
    expect(stripWeatherDateSuffix('Highest temperature in Atlanta?'))
      .toBe('Highest temperature in Atlanta');
  });

  test('already-clean string is idempotent', () => {
    expect(stripWeatherDateSuffix('Highest temperature in Atlanta'))
      .toBe('Highest temperature in Atlanta');
  });

  test('empty string returns empty string', () => {
    expect(stripWeatherDateSuffix('')).toBe('');
  });

  test('does NOT strip a city named like a month (false positive guard)', () => {
    // The suffix regex requires the month token to follow " on " or " in " —
    // a city literally named "May" in the middle of the phrase is safe.
    expect(stripWeatherDateSuffix('Highest temperature in Mayfield on Jun 1, 2026?'))
      .toBe('Highest temperature in Mayfield');
  });
});
