import { describe, test, expect } from 'bun:test';
import {
  ASW_PRESET_RATES,
  DEFAULT_ASW_CURVE,
  annualizedEdge,
  aswThreshold,
  basketSettlementContext,
  daysToSettlement,
  discountFactor,
  effectiveLockedCapital,
  expectedParityWedge,
  negRiskRecycledCapital,
  settlementLagDays,
  settlementWedge,
  type AswCurve,
  type SettlementLegFact,
} from './settlement-economics.js';

const DAY = 86_400_000;
const HUMP_MIN: AswCurve = { preset: 'min', shape: 'hump' };

describe('U1 annualizedEdge (paper3 ASW convention)', () => {
  test('paper3 §1 fixture: Jesus Christ NO at $0.96 for ~a year ≈ 4.2%', () => {
    // Buy $0.96, redeem $1 after 365d → edge 0.04 on 0.96 capital.
    const ae = annualizedEdge(0.04, 0.96, 365);
    expect(ae).toBeCloseTo(0.0416667, 5); // "roughly 4.2%" in the paper
    // …which sits AT the frontier: above the minimum-ASW frontier (3.06%) but
    // below the 0.1-percentile frontier (4.36%) — not free money.
    expect(ae).toBeGreaterThan(ASW_PRESET_RATES.min);
    expect(ae).toBeLessThan(ASW_PRESET_RATES.p01);
  });

  test('audit §1 U1 fixture: 1.5% edge locked 300 days is below the minimum frontier', () => {
    const ae = annualizedEdge(0.015, 1.0, 300);
    expect(ae).toBeCloseTo(0.018280, 5);
    expect(ae).toBeLessThan(ASW_PRESET_RATES.min); // negative-carry money
  });

  test('compounding convention matches ASW = (1+edge/capital)^(365/τ) − 1', () => {
    expect(annualizedEdge(0.01, 1.0, 36.5)).toBeCloseTo(Math.pow(1.01, 10) - 1, 10);
  });

  test('days clamp: τ ≤ 0 is treated as the 1-day floor', () => {
    expect(annualizedEdge(0.01, 1.0, 0)).toBeCloseTo(annualizedEdge(0.01, 1.0, 1), 12);
    expect(annualizedEdge(0.01, 1.0, -5)).toBeCloseTo(annualizedEdge(0.01, 1.0, 1), 12);
  });

  test('zero/negative capital: +∞ on positive edge (fully recycled), 0 otherwise', () => {
    expect(annualizedEdge(0.10, 0, 300)).toBe(Infinity);
    expect(annualizedEdge(-0.10, 0, 300)).toBe(0);
  });

  test('total-loss floor and NaN propagation', () => {
    expect(annualizedEdge(-2, 1, 365)).toBe(-1);
    expect(Number.isNaN(annualizedEdge(NaN, 1, 365))).toBe(true);
    expect(Number.isNaN(annualizedEdge(0.01, 1, NaN))).toBe(true);
  });
});

describe('U1 aswThreshold (paper3 Table 3 presets + Fig. 1 hump shape)', () => {
  test('flat presets are the published frontier means', () => {
    expect(aswThreshold(300, { preset: 'min', shape: 'flat' })).toBe(0.0306);
    expect(aswThreshold(300, { preset: 'p01', shape: 'flat' })).toBe(0.0436);
    expect(aswThreshold(300, { preset: 'conservative', shape: 'flat' })).toBe(0.0689);
    expect(DEFAULT_ASW_CURVE).toEqual({ preset: 'min', shape: 'flat' });
  });

  test('flat is horizon-independent', () => {
    expect(aswThreshold(1, DEFAULT_ASW_CURVE)).toBe(aswThreshold(365, DEFAULT_ASW_CURVE));
  });

  test('hump shape: elevated short end, ~20d trough, 230–260d hump', () => {
    expect(aswThreshold(0, HUMP_MIN)).toBeGreaterThan(aswThreshold(20, HUMP_MIN)); // short end ↑
    expect(aswThreshold(20, HUMP_MIN)).toBeLessThan(ASW_PRESET_RATES.min);        // trough < mean
    expect(aswThreshold(245, HUMP_MIN)).toBeGreaterThan(ASW_PRESET_RATES.min);    // hump > mean
    expect(aswThreshold(245, HUMP_MIN)).toBeGreaterThan(aswThreshold(90, HUMP_MIN));
    expect(aswThreshold(245, HUMP_MIN)).toBeGreaterThan(aswThreshold(350, HUMP_MIN)); // eases after hump
  });

  test('hump is clamped beyond the last knot and normalized to the preset mean', () => {
    expect(aswThreshold(1000, HUMP_MIN)).toBe(aswThreshold(350, HUMP_MIN));
    // Trapezoid mean of the hump curve over [0, 350] ≈ the flat preset rate.
    let area = 0;
    for (let d = 0; d < 350; d++) {
      area += (aswThreshold(d, HUMP_MIN) + aswThreshold(d + 1, HUMP_MIN)) / 2;
    }
    expect(area / 350).toBeCloseTo(ASW_PRESET_RATES.min, 4);
  });
});

describe('discountFactor', () => {
  test('D(365d) at the minimum frontier = 1/1.0306', () => {
    expect(discountFactor(365, 0.0306)).toBeCloseTo(1 / 1.0306, 10);
  });
  test('D(0) = 1; negative rate clamped', () => {
    expect(discountFactor(0, 0.05)).toBe(1);
    expect(discountFactor(365, -0.02)).toBe(1);
  });
});

describe('U2 settlementWedge / expectedParityWedge (paper3 §5.3)', () => {
  test('PM binary wedge at the paper Fig. 5 constant-4% benchmark, 365d', () => {
    const w = settlementWedge('polymarket', { kind: 'binary' }, 365, { aswRateOverride: 0.04 });
    expect(w).toBeCloseTo(1 - 1 / 1.04, 10); // ≈ 0.038462
  });

  test('negRisk divides the binary wedge by (n−1): n=8 → wedge/7 (§5.3.1)', () => {
    const binary = settlementWedge('polymarket', { kind: 'binary' }, 365, { aswRateOverride: 0.04 });
    const neg8 = settlementWedge('polymarket', { kind: 'negRisk', nOutcomes: 8 }, 365, { aswRateOverride: 0.04 });
    expect(neg8).toBeCloseTo(binary / 7, 12);
    // Paper benchmark P̄_N(τ; n−1) ≈ 1 − (1−D)/(n−1): the near-certain negRisk
    // NO frontier sits ≈ 0.9945 when the binary D is 4%-discounted at 365d.
    expect(1 - neg8).toBeCloseTo(0.99451, 4);
    // Larger events net more: n=8 strictly closer to par than n=5 (Fig. 5 ordering).
    const neg5 = settlementWedge('polymarket', { kind: 'negRisk', nOutcomes: 5 }, 365, { aswRateOverride: 0.04 });
    expect(neg8).toBeLessThan(neg5);
  });

  test('negRisk n=2 degenerates to the binary wedge', () => {
    const a = settlementWedge('polymarket', { kind: 'binary' }, 100);
    const b = settlementWedge('polymarket', { kind: 'negRisk', nOutcomes: 2 }, 100);
    expect(b).toBe(a);
  });

  test('Kalshi yield-bearing collateral: reduced, flatter wedge (§5.3.2)', () => {
    const pm = settlementWedge('polymarket', { kind: 'binary' }, 365);
    const k = settlementWedge('kalshi', { kind: 'binary' }, 365);
    // min preset 3.06%: Kalshi rate = max(3.06% − 4%, 3.06%·0.25) = 0.765%
    expect(k).toBeCloseTo(1 - Math.pow(1.00765, -1), 10);
    expect(k).toBeLessThan(pm);
    expect(k).toBeGreaterThan(0); // residual floor: yield never zeroes the wedge
  });

  test('predict/limitless default to the PM-like full wedge', () => {
    const pm = settlementWedge('polymarket', { kind: 'binary' }, 200);
    expect(settlementWedge('predict', { kind: 'binary' }, 200)).toBe(pm);
    expect(settlementWedge('limitless', { kind: 'binary' }, 200)).toBe(pm);
  });

  test('parity band center is 1 − wedgeA − wedgeB, not 1', () => {
    const p = expectedParityWedge(
      { platform: 'polymarket', structure: { kind: 'binary' } },
      { platform: 'kalshi', structure: { kind: 'binary' } },
      365,
    );
    const wPm = 1 - 1 / 1.0306;
    const wK = 1 - Math.pow(1.00765, -1);
    expect(p.wedgeA).toBeCloseTo(wPm, 10);
    expect(p.wedgeB).toBeCloseTo(wK, 10);
    expect(p.parityBandCenter).toBeCloseTo(1 - wPm - wK, 10); // ≈ 0.96272
    expect(p.parityBandCenter).toBeLessThan(1);
  });

  test('zero/negative horizon ⟹ zero wedge, band center 1', () => {
    const p = expectedParityWedge(
      { platform: 'polymarket', structure: { kind: 'binary' } },
      { platform: 'kalshi', structure: { kind: 'binary' } },
      0,
    );
    expect(p.combinedWedge).toBe(0);
    expect(p.parityBandCenter).toBe(1);
  });
});

describe('U3 negRisk capital recycling (paper3 App. 9.8 identity)', () => {
  test('m equal NO legs recycle (m−1)·units: 7 legs × 1 share → $6 recycled', () => {
    expect(negRiskRecycledCapital([1, 1, 1, 1, 1, 1, 1])).toEqual({ nettableUnits: 1, recycledUsd: 6 });
  });

  test('unequal shares: only complete subsets convert (min shares)', () => {
    expect(negRiskRecycledCapital([2, 1, 3])).toEqual({ nettableUnits: 1, recycledUsd: 2 });
  });

  test('fewer than 2 legs, or invalid shares, recycle nothing', () => {
    expect(negRiskRecycledCapital([5]).recycledUsd).toBe(0);
    expect(negRiskRecycledCapital([]).recycledUsd).toBe(0);
    expect(negRiskRecycledCapital([1, -1]).recycledUsd).toBe(0);
    expect(negRiskRecycledCapital([1, NaN]).recycledUsd).toBe(0);
  });

  test('effectiveLockedCapital nets out the recycle, floored at 0', () => {
    // 7 near-certain NO legs at $0.995: gross $6.965 but only the residual
    // ≈ $0.965 stays locked.
    expect(effectiveLockedCapital(6.965, 6)).toBeCloseTo(0.965, 10);
    expect(effectiveLockedCapital(0.9, 2)).toBe(0);
    expect(effectiveLockedCapital(1, -3)).toBe(1); // negative recycle ignored
  });

  test('worked example: recycling rescues the annualized edge of a long negRisk basket', () => {
    // 7-leg NO basket, $6.965 in, $7 back after 365d.
    const gross = annualizedEdge(0.035, 6.965, 365);   // ≈ 0.50%/yr — below frontier
    const recycled = annualizedEdge(0.035, 0.965, 365); // ≈ 3.69%/yr — above min frontier
    expect(gross).toBeLessThan(ASW_PRESET_RATES.min);
    expect(recycled).toBeGreaterThan(ASW_PRESET_RATES.min);
  });
});

describe('U4 settlement lag (τ to redemption, paper3 §2.1)', () => {
  test('per-platform defaults: PM +1d/+7d, Kalshi +1d/+1d, Predict +2d/+7d', () => {
    expect(settlementLagDays('polymarket')).toBe(1);
    expect(settlementLagDays('polymarket', { disputed: true })).toBe(7);
    expect(settlementLagDays('kalshi')).toBe(1);
    expect(settlementLagDays('kalshi', { disputed: true })).toBe(1);
    expect(settlementLagDays('predict')).toBe(2);
    expect(settlementLagDays('limitless', { disputed: true })).toBe(7);
  });

  test('lag table override', () => {
    expect(settlementLagDays('polymarket', { lags: { polymarket: { undisputedDays: 0.5, disputedP95Days: 3 } } })).toBe(0.5);
  });

  test('daysToSettlement = horizon + lag; unknown end date → null', () => {
    const now = Date.UTC(2026, 5, 10);
    expect(daysToSettlement(now + 10 * DAY, now, 'polymarket')).toBeCloseTo(11, 10);
    expect(daysToSettlement(now + 10 * DAY, now, 'polymarket', { disputed: true })).toBeCloseTo(17, 10);
    expect(daysToSettlement(now + 10 * DAY, now, 'kalshi')).toBeCloseTo(11, 10);
    expect(daysToSettlement(null, now, 'polymarket')).toBeNull();
    // Past-end market still waits out the settlement lag.
    expect(daysToSettlement(now - 5 * DAY, now, 'polymarket')).toBeCloseTo(1, 10);
  });
});

describe('basketSettlementContext', () => {
  const now = Date.UTC(2026, 5, 10);
  const leg = (o: Partial<SettlementLegFact> = {}): SettlementLegFact => ({
    platform: 'polymarket',
    side: 'YES',
    shares: 1,
    endDateMs: null,
    negRiskEventId: null,
    ...o,
  });

  test('τ = max over known horizons (capital locked until the LAST leg settles)', () => {
    const ctx = basketSettlementContext(
      [leg({ endDateMs: now + 100 * DAY }), leg({ platform: 'kalshi', endDateMs: now + 30 * DAY })],
      now,
    );
    expect(ctx.daysToSettlement).toBeCloseTo(101, 10); // PM 100d + 1d lag
    expect(ctx.horizonCoverage).toBe(1);
  });

  test('partial coverage: τ from the known legs only, coverage < 1', () => {
    const ctx = basketSettlementContext([leg({ endDateMs: now + 50 * DAY }), leg()], now);
    expect(ctx.daysToSettlement).toBeCloseTo(51, 10);
    expect(ctx.horizonCoverage).toBe(0.5);
  });

  test('no horizons → null τ, coverage 0', () => {
    const ctx = basketSettlementContext([leg(), leg()], now);
    expect(ctx.daysToSettlement).toBeNull();
    expect(ctx.horizonCoverage).toBe(0);
  });

  test('negRisk NO-baskets recycle per event; YES legs never do', () => {
    const ctx = basketSettlementContext(
      [
        leg({ side: 'NO', shares: 0.5, negRiskEventId: 'ev1' }),
        leg({ side: 'NO', shares: 0.5, negRiskEventId: 'ev1' }),
        leg({ side: 'NO', shares: 0.5, negRiskEventId: 'ev1' }),
        leg({ side: 'NO', shares: 1, negRiskEventId: 'ev2' }),
        leg({ side: 'NO', shares: 2, negRiskEventId: 'ev2' }),
        leg({ side: 'YES', shares: 9, negRiskEventId: 'ev1' }),
        leg({ side: 'NO', shares: 9 }), // not negRisk
      ],
      now,
    );
    // ev1: (3−1)·0.5 = 1; ev2: (2−1)·1 = 1 → total 2.
    expect(ctx.recycledCapitalUsd).toBeCloseTo(2, 10);
  });

  test('a single NO leg in an event is not nettable', () => {
    const ctx = basketSettlementContext([leg({ side: 'NO', shares: 3, negRiskEventId: 'ev1' })], now);
    expect(ctx.recycledCapitalUsd).toBe(0);
  });
});
