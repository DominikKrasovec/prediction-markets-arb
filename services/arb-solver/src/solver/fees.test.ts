import { describe, test, expect } from 'bun:test';
import { feePerShare, defaultFeeModel, resolveFeeModel, type FeeModel } from './fees.js';

const bern = (rate: number, exponent = 1): FeeModel => ({ form: 'bernoulli', rate, exponent });
const limitless: FeeModel = { form: 'limitless-curve', rate: 0, exponent: 1 };

describe('feePerShare — bernoulli', () => {
  test('PM crypto worked example: 0.0175 per share at p=0.5 (rate 0.07, exp 1)', () => {
    expect(feePerShare(bern(0.07), 0.5, 'buy')).toBeCloseTo(0.0175, 9);
    // 100 shares → $1.75 total (authoritative PM v2 SDK example).
    expect(100 * feePerShare(bern(0.07), 0.5, 'buy')).toBeCloseTo(1.75, 6);
  });

  test('symmetric: buy == sell, and p == 1−p', () => {
    expect(feePerShare(bern(0.07), 0.3, 'buy')).toBeCloseTo(feePerShare(bern(0.07), 0.3, 'sell'), 12);
    expect(feePerShare(bern(0.07), 0.3, 'buy')).toBeCloseTo(feePerShare(bern(0.07), 0.7, 'buy'), 12);
  });

  test('exponent=2 is steeper (smaller, since p(1−p) ≤ 0.25 < 1)', () => {
    const p = 0.4;
    const base = p * (1 - p);
    expect(feePerShare(bern(0.07, 2), p, 'buy')).toBeCloseTo(0.07 * base * base, 12);
    // exp 2 < exp 1 away from the boundaries
    expect(feePerShare(bern(0.07, 2), p, 'buy')).toBeLessThan(feePerShare(bern(0.07, 1), p, 'buy'));
  });

  test('fee is always ≥ 0; clamps price to [0,1]; 0 at the boundaries', () => {
    expect(feePerShare(bern(0.07), -1, 'buy')).toBe(0);
    expect(feePerShare(bern(0.07), 2, 'buy')).toBe(0);
    expect(feePerShare(bern(0.07), 0, 'buy')).toBe(0);
    expect(feePerShare(bern(0.07), 1, 'buy')).toBe(0);
    for (let p = 0; p <= 1.0001; p += 0.05) {
      expect(feePerShare(bern(0.07), p, 'buy')).toBeGreaterThanOrEqual(0);
    }
  });

  test('NaN / non-finite inputs never produce NaN or a negative fee', () => {
    expect(feePerShare(bern(0.07), NaN, 'buy')).toBe(0);
    expect(feePerShare(bern(NaN), 0.5, 'buy')).toBe(0);
    expect(feePerShare(bern(0.07, NaN), 0.5, 'buy')).toBeCloseTo(0.0175, 9); // exp falls back to 1
    expect(feePerShare(bern(-0.07), 0.5, 'buy')).toBe(0); // negative rate guarded → 0
  });
});

describe('feePerShare — limitless-curve (asymmetric)', () => {
  test('buy = 0.03·p, sell = 0.015·p — buy ≠ sell', () => {
    expect(feePerShare(limitless, 0.5, 'buy')).toBeCloseTo(0.03 * 0.5, 12);
    expect(feePerShare(limitless, 0.5, 'sell')).toBeCloseTo(0.015 * 0.5, 12);
    expect(feePerShare(limitless, 0.5, 'buy')).not.toBeCloseTo(feePerShare(limitless, 0.5, 'sell'), 6);
    // buy is exactly 2× sell at the same price
    expect(feePerShare(limitless, 0.8, 'buy')).toBeCloseTo(2 * feePerShare(limitless, 0.8, 'sell'), 12);
  });

  test('clamps price; ≥ 0', () => {
    expect(feePerShare(limitless, -1, 'buy')).toBe(0);
    expect(feePerShare(limitless, 2, 'sell')).toBeCloseTo(0.015, 12); // clamped to p=1
    expect(feePerShare(limitless, 0, 'buy')).toBe(0);
  });
});

describe('defaultFeeModel', () => {
  test('conservative per-platform fallbacks', () => {
    expect(defaultFeeModel('kalshi')).toEqual(bern(0.07));
    expect(defaultFeeModel('polymarket')).toEqual(bern(0.05)); // "Other" rate
    expect(defaultFeeModel('predict')).toEqual(bern(0.02));
    expect(defaultFeeModel('limitless')).toEqual(limitless);
  });
});

describe('resolveFeeModel — kalshi', () => {
  test('general series → 0.07', () => {
    expect(resolveFeeModel('kalshi', { eventTicker: 'KXBTC-24DEC31' })).toEqual(bern(0.07));
    expect(resolveFeeModel('kalshi', { eventTicker: null })).toEqual(bern(0.07));
    expect(resolveFeeModel('kalshi', {})).toEqual(bern(0.07));
  });

  test('S&P/Nasdaq index series (KXINX* / KXNASDAQ100*) → 0.035', () => {
    // Real live series roots (KX-prefixed — these are the actual Kalshi tickers).
    for (const t of [
      'KXINX-25DEC31-B5000', 'KXINXU-25DEC31', 'KXINXY-foo', 'KXINXMAXY-x',
      'KXNASDAQ100-25DEC31', 'KXNASDAQ100U-y', 'KXNASDAQ100Y-z',
    ]) {
      expect(resolveFeeModel('kalshi', { eventTicker: t })).toEqual(bern(0.035));
    }
    // Non-index KX series stay 0.07.
    expect(resolveFeeModel('kalshi', { eventTicker: 'KXBTC-25DEC31' })).toEqual(bern(0.07));
    // Bare INX/NASDAQ100 (no KX prefix) don't exist on Kalshi → must NOT match.
    expect(resolveFeeModel('kalshi', { eventTicker: 'INX-24DEC31' })).toEqual(bern(0.07));
    expect(resolveFeeModel('kalshi', { eventTicker: 'NASDAQ100-24DEC31' })).toEqual(bern(0.07));
  });
});

describe('resolveFeeModel — polymarket category → rate', () => {
  // Keys are our category_unified taxonomy slugs (the live domain), NOT PM's
  // prose names — see the PM_CATEGORY_RATE comment in fees.ts.
  const cases: [string, number][] = [
    ['crypto', 0.07],
    ['economic', 0.05],
    ['entertainment', 0.05],
    ['weather', 0.05],
    ['other', 0.05],
    ['politics', 0.04],
    ['election', 0.04],
    ['technology', 0.04],
    ['sports', 0.03],
    ['geopolitical', 0.0],
  ];
  for (const [cat, rate] of cases) {
    test(`${cat} → ${rate} (case-insensitive)`, () => {
      expect(resolveFeeModel('polymarket', { categoryUnified: cat })).toEqual(bern(rate));
      expect(resolveFeeModel('polymarket', { categoryUnified: cat.toUpperCase() })).toEqual(bern(rate));
    });
  }

  test('unknown / null category → 0.05 (Other, conservative)', () => {
    expect(resolveFeeModel('polymarket', { categoryUnified: 'NotARealCategory' })).toEqual(bern(0.05));
    expect(resolveFeeModel('polymarket', { categoryUnified: null })).toEqual(bern(0.05));
    expect(resolveFeeModel('polymarket', {})).toEqual(bern(0.05));
  });
});

describe('resolveFeeModel — predict feeRateBps', () => {
  test('feeRateBps=200 → 0.02', () => {
    expect(resolveFeeModel('predict', { feeRateBps: 200 })).toEqual(bern(0.02));
    expect(resolveFeeModel('predict', { feeRateBps: '200' })).toEqual(bern(0.02));
  });

  test('missing / invalid / non-positive → default 0.02', () => {
    expect(resolveFeeModel('predict', {})).toEqual(bern(0.02));
    expect(resolveFeeModel('predict', { feeRateBps: null })).toEqual(bern(0.02));
    expect(resolveFeeModel('predict', { feeRateBps: 'abc' })).toEqual(bern(0.02));
    expect(resolveFeeModel('predict', { feeRateBps: 0 })).toEqual(bern(0.02));
    expect(resolveFeeModel('predict', { feeRateBps: -50 })).toEqual(bern(0.02));
  });

  test('a different bps resolves proportionally', () => {
    expect(resolveFeeModel('predict', { feeRateBps: 350 })).toEqual(bern(0.035));
  });
});

describe('resolveFeeModel — limitless', () => {
  test('always the limitless-curve model', () => {
    expect(resolveFeeModel('limitless', {})).toEqual(limitless);
    expect(resolveFeeModel('limitless', { feeRateBps: 999, categoryUnified: 'x' })).toEqual(limitless);
  });
});
