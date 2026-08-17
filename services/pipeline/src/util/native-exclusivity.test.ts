/**
 * Unit tests for the unified native-exclusivity source of truth.
 *
 * nativeMutex must encode each platform's NATIVE mutex proof exactly:
 *   kalshi      → mutually_exclusive (the only platform that can prove FALSE)
 *   polymarket  → negRisk==='true' ONLY (uppercase-ID is NOT a proof — present on
 *                 negRisk:false markets)
 *   limitless   → lowercase negRiskMarketId presence
 *   predict     → isNegRisk===true
 * Absence of the negRisk flag is NOT a proof of independence on PM/Predict/Limitless
 * (returns null → caller falls back), so only kalshi ever returns false.
 */
import { test, expect, describe } from 'bun:test';
import {
  nativeMutex,
  nativeResidual,
  nativeDraw,
  NATIVE_DRAW_SUBJECT,
  NATIVE_DRAW_LABEL,
  NATIVE_MUTEX_SQL,
  NATIVE_RESIDUAL_RX,
} from './native-exclusivity.js';

describe('nativeMutex — kalshi (the only false-capable platform)', () => {
  test("mutually_exclusive 'true' → true", () => {
    expect(nativeMutex('kalshi', { mutually_exclusive: 'true' })).toBe(true);
    expect(nativeMutex('kalshi', { mutually_exclusive: true })).toBe(true);
  });
  test("mutually_exclusive 'false' → false (positive independent-selection proof)", () => {
    expect(nativeMutex('kalshi', { mutually_exclusive: 'false' })).toBe(false);
    expect(nativeMutex('kalshi', { mutually_exclusive: false })).toBe(false);
  });
  test('absent → null (caller falls back to title/template classifier)', () => {
    expect(nativeMutex('kalshi', {})).toBe(null);
    expect(nativeMutex('kalshi', { mutually_exclusive: null })).toBe(null);
  });
});

describe('nativeMutex — polymarket (negRisk only; uppercase-ID is NOT a proof)', () => {
  test("negRisk 'true'/true → true", () => {
    expect(nativeMutex('polymarket', { negRisk: 'true' })).toBe(true);
    expect(nativeMutex('polymarket', { negRisk: true })).toBe(true);
  });
  test("negRisk 'false' with an uppercase negRiskMarketID present → null (NOT mutex)", () => {
    // The uppercase ID can be present on a negRisk:false market, so it is not
    // a mutex proof on its own.
    expect(nativeMutex('polymarket', { negRisk: 'false', negRiskMarketID: '0xabc' })).toBe(null);
  });
  test('only an uppercase negRiskMarketID (no negRisk flag) → null', () => {
    expect(nativeMutex('polymarket', { negRiskMarketID: '0xabc' })).toBe(null);
  });
  test('absent → null', () => {
    expect(nativeMutex('polymarket', {})).toBe(null);
  });
  test('PM never returns false (absence ≠ independence proof)', () => {
    expect(nativeMutex('polymarket', { negRisk: 'false' })).toBe(null);
  });
});

describe('nativeMutex — limitless (lowercase negRiskMarketId presence)', () => {
  test('lowercase negRiskMarketId present → true', () => {
    expect(nativeMutex('limitless', { negRiskMarketId: '42' })).toBe(true);
  });
  test('absent / empty → null', () => {
    expect(nativeMutex('limitless', {})).toBe(null);
    expect(nativeMutex('limitless', { negRiskMarketId: '' })).toBe(null);
    expect(nativeMutex('limitless', { negRiskMarketId: null })).toBe(null);
  });
  test('limitless never returns false', () => {
    expect(nativeMutex('limitless', { negRiskMarketId: null })).not.toBe(false);
  });
});

describe('nativeMutex — predict (isNegRisk)', () => {
  test('isNegRisk true/"true" → true', () => {
    expect(nativeMutex('predict', { isNegRisk: true })).toBe(true);
    expect(nativeMutex('predict', { isNegRisk: 'true' })).toBe(true);
  });
  test('isNegRisk false / absent → null', () => {
    expect(nativeMutex('predict', { isNegRisk: false })).toBe(null);
    expect(nativeMutex('predict', {})).toBe(null);
  });
  test('predict never returns false', () => {
    expect(nativeMutex('predict', { isNegRisk: false })).not.toBe(false);
  });
});

describe('nativeMutex — null/undefined raw', () => {
  test('null/undefined raw → null for every platform', () => {
    for (const p of ['kalshi', 'polymarket', 'limitless', 'predict'] as const) {
      expect(nativeMutex(p, null)).toBe(null);
      expect(nativeMutex(p, undefined)).toBe(null);
    }
  });
});

describe('nativeResidual — draw/tie/Other detection (fix ⑤ + Predict recall)', () => {
  test('bare residual labels', () => {
    expect(nativeResidual('polymarket', null, 'Other', null)).toBe(true);
    expect(nativeResidual('predict', null, 'Draw', null)).toBe(true);
    expect(nativeResidual('predict', null, 'Tie', null)).toBe(true);
    expect(nativeResidual('polymarket', null, 'the field', null)).toBe(true);
  });
  test('Predict full-title draw/tie phrasing (label NULL, title carries it)', () => {
    expect(nativeResidual('predict', null, null, 'Will Arsenal vs Chelsea end in a draw?')).toBe(true);
    expect(nativeResidual('predict', null, null, 'Will the match end in a tie?')).toBe(true);
    // The "…: Other" residual is detected via the bare LABEL ('Other'), not a
    // colon-suffixed full title (the anchored ^other$ rule keeps real names safe).
    expect(nativeResidual('predict', null, 'Other', 'Will Man City win? : Other')).toBe(true);
  });
  test('real named outcomes are NOT residual', () => {
    expect(nativeResidual('polymarket', null, 'Arsenal', 'Will Arsenal win the league?')).toBe(false);
    expect(nativeResidual('predict', null, 'Drew Barrymore', null)).toBe(false); // not a bare 'draw'
  });
  test('NATIVE_RESIDUAL_RX exported draw/tie token', () => {
    expect(NATIVE_RESIDUAL_RX.test('draw')).toBe(true);
    expect(NATIVE_RESIDUAL_RX.test('tie')).toBe(true);
    expect(NATIVE_RESIDUAL_RX.test('Drew')).toBe(false);
  });
});

describe('nativeDraw — canonical fixture-draw fields', () => {
  test('subject is the placeholder Draw, outcome_label is the byte-stable authority', () => {
    const d = nativeDraw();
    expect(d.subject_raw).toBe('Draw');
    expect(d.outcome_label).toBe('draw');
  });
  test('constants match the emitter (single source)', () => {
    expect(NATIVE_DRAW_SUBJECT).toBe('Draw');
    expect(NATIVE_DRAW_LABEL).toBe('draw');
    expect(nativeDraw()).toEqual({ subject_raw: NATIVE_DRAW_SUBJECT, outcome_label: NATIVE_DRAW_LABEL });
  });
  test('returns a fresh object each call (no shared mutable state)', () => {
    expect(nativeDraw()).not.toBe(nativeDraw());
  });
});

describe('NATIVE_MUTEX_SQL — shape', () => {
  test('emits PM negRisk + Predict isNegRisk + Limitless lowercase; NO uppercase-ID', () => {
    const sql = NATIVE_MUTEX_SQL('mmr');
    expect(sql).toContain("mmr.raw->>'negRisk' = 'true'");
    expect(sql).toContain("mmr.raw->>'isNegRisk' = 'true'");
    expect(sql).toContain("mmr.raw->>'negRiskMarketId' IS NOT NULL");
    // PM's uppercase-ID clause must not be present.
    expect(sql).not.toContain('negRiskMarketID');
  });
  test('respects the passed alias', () => {
    expect(NATIVE_MUTEX_SQL('x')).toContain("x.raw->>'negRisk' = 'true'");
  });
});
