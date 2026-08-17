/**
 * Pure-function tests for resolution-write helpers.
 *
 * `writeResolution` DB integration tests live in index.integration.test.ts.
 * Here we test the two pure helpers that have subtle correctness rules
 * and are wired into multiple platforms:
 *
 *   - parseWinnerFromOutcomes: float imprecision + ambiguity handling
 *   - coerceResolvedAt: timestamp fallback warning behavior
 *
 * Both are called by every Polymarket/Limitless gap-refill and lifecycle
 * watcher (and arb-solver's CLOB-WSS handler) — a regression here corrupts
 * the resolved_at watermark.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  parseWinnerFromOutcomes,
  coerceResolvedAt,
} from './index.js';

describe('parseWinnerFromOutcomes', () => {
  test('clean Yes winner', () => {
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['1', '0'])).toBe('Yes');
  });

  test('clean No winner', () => {
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['0', '1'])).toBe('No');
  });

  test('tolerates float imprecision around 1.0', () => {
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['0.99999', '0.00001'])).toBe('Yes');
  });

  test('accepts JSON-string inputs (Polymarket gamma format)', () => {
    expect(parseWinnerFromOutcomes('["Yes","No"]', '["1","0"]')).toBe('Yes');
  });

  test('returns null when both outcomes near 1 (ambiguous)', () => {
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['0.995', '0.995'])).toBeNull();
  });

  test('returns null when no outcome reaches threshold', () => {
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['0.5', '0.5'])).toBeNull();
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['0.98', '0.02'])).toBeNull();
  });

  test('returns null for empty / malformed', () => {
    expect(parseWinnerFromOutcomes(null, null)).toBeNull();
    expect(parseWinnerFromOutcomes(undefined, undefined)).toBeNull();
    expect(parseWinnerFromOutcomes([], [])).toBeNull();
  });

  test('returns null for length mismatch', () => {
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['1'])).toBeNull();
  });

  test('returns null for non-finite prices (NaN, Infinity)', () => {
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['NaN', '0'])).toBeNull();
    expect(parseWinnerFromOutcomes(['Yes', 'No'], ['Infinity', '0'])).toBeNull();
  });

  test('returns null on JSON parse failure', () => {
    expect(parseWinnerFromOutcomes('not json', '["1","0"]')).toBeNull();
  });

  test('handles 3-way (categorical) winner', () => {
    expect(parseWinnerFromOutcomes(['A', 'B', 'C'], ['0', '1', '0'])).toBe('B');
  });
});

describe('coerceResolvedAt', () => {
  let warnSpy: ReturnType<typeof spyOn<typeof console, 'warn'>>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('passes through valid Date object', () => {
    const d = new Date('2025-01-15T12:00:00Z');
    const { resolvedAt, fallback } = coerceResolvedAt(d, 'ctx');
    expect(resolvedAt).toBe(d);
    expect(fallback).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('parses ISO string', () => {
    const { resolvedAt, fallback } = coerceResolvedAt('2025-01-15T12:00:00Z', 'ctx');
    expect(resolvedAt.toISOString()).toBe('2025-01-15T12:00:00.000Z');
    expect(fallback).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('parses unix-ms number', () => {
    const ts = Date.UTC(2025, 0, 15, 12, 0, 0);
    const { resolvedAt, fallback } = coerceResolvedAt(ts, 'ctx');
    expect(resolvedAt.getTime()).toBe(ts);
    expect(fallback).toBe(false);
  });

  test('rejects invalid Date object as fallback', () => {
    const { fallback } = coerceResolvedAt(new Date('not a date'), 'ctx-invalid');
    expect(fallback).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toContain('ctx-invalid');
  });

  test('null / undefined trigger fallback with warning', () => {
    coerceResolvedAt(null, 'ctx-null');
    coerceResolvedAt(undefined, 'ctx-undef');
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('unparseable string triggers fallback', () => {
    const { fallback } = coerceResolvedAt('not a date', 'ctx-bad-str');
    expect(fallback).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('warning includes watermark-corruption hint', () => {
    coerceResolvedAt(null, 'ctx-warn');
    expect(warnSpy.mock.calls[0][1]).toContain('watermark');
  });

  test('fallback Date is close to now (sanity)', () => {
    const before = Date.now();
    const { resolvedAt } = coerceResolvedAt(null, 'ctx');
    const after = Date.now();
    expect(resolvedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(resolvedAt.getTime()).toBeLessThanOrEqual(after);
  });
});
