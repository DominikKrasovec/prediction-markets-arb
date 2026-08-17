import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode } from '../graph/types.js';
import { PriceCache } from '../clob/price-cache.js';
import { extractPortfolio } from './portfolio.js';
import type { LPProblem, LPResult, LPVariable } from './types.js';
import {
  applyVenueRounding,
  floorToStep,
  VENUE_EXECUTION_CONSTRAINTS,
} from './venue-constraints.js';

const TS = 1000;

/** Categorical (exhaustive one-hot) cluster: one market per slot. */
function categoricalCluster(markets: { marketId: number; platform: Platform }[]): Cluster {
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  markets.forEach((m, i) => {
    const qid = i + 1;
    const ref: MarketRef = {
      marketId: m.marketId,
      platform: m.platform,
      platformId: `pid-${m.marketId}`,
      endDateMs: null,
      negRiskEventId: null,
    };
    questions.set(qid, {
      questionId: qid, canonicalSubject: `s${qid}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map([[m.marketId, ref]]),
    });
    marketIds.add(m.marketId);
  });
  const qids = [...questions.keys()];
  const validStates = qids.map((t) => new Map(qids.map((q) => [q, q === t])));
  return { id: 1, questions, outcomeSets: [], edges: [], marketIds, validStates, dirty: false };
}

/**
 * Hand-build a DEPTH-AWARE ladder LP solution (extractPortfolio never reads
 * objective/constraints/rhs): buy-all-YES with the given per-leg shares.
 * G = worst-state payout = min(shares); optimalCost = cost − G (= −profit).
 */
function ladderSolution(
  legs: Array<{ marketId: number; platform: Platform; shares: number; askPrice: number; feePerShare?: number }>,
): { problem: LPProblem; result: LPResult } {
  const variables: LPVariable[] = legs.map((l, i) => ({
    index: i,
    marketId: l.marketId,
    platform: l.platform,
    side: 'YES' as const,
    askPrice: l.askPrice,
    feePerShare: l.feePerShare ?? 0,
    maxShares: l.shares,
    level: 0,
  }));
  const gIndex = legs.length;
  const values = legs.map((l) => l.shares);
  const g = Math.min(...legs.map((l) => l.shares));
  values.push(g);
  const cost = legs.reduce((s, l) => s + l.shares * (l.askPrice + (l.feePerShare ?? 0)), 0);
  const problem: LPProblem = {
    numVars: gIndex + 1,
    objective: [],
    constraints: [],
    rhs: [],
    variables: [
      ...variables,
      { index: gIndex, marketId: -1, platform: 'polymarket', side: 'YES', askPrice: 0, feePerShare: 0, maxShares: null },
    ],
    clusterId: 1,
    guaranteedPayoutVarIndex: gIndex,
  };
  const result: LPResult = { status: 'Optimal', optimalCost: cost - g, values, solveTimeMs: 1 };
  return { problem, result };
}

function cacheFor(markets: { marketId: number; platform: Platform; ask: number }[]): PriceCache {
  const pc = new PriceCache();
  for (const m of markets) {
    pc.update({
      marketId: m.marketId, platform: m.platform,
      bestBid: m.ask - 0.01, bestAsk: m.ask, bidSize: 1000, askSize: 1000, timestamp: TS,
    });
  }
  return pc;
}

describe('venue-constraints constants', () => {
  test('verified venues carry doc-backed fields; unverified are full-null passthrough', () => {
    expect(VENUE_EXECUTION_CONSTRAINTS.kalshi.verified).toBe(true);
    expect(VENUE_EXECUTION_CONSTRAINTS.kalshi.shareStep).toBe(1);
    expect(VENUE_EXECUTION_CONSTRAINTS.kalshi.minOrderShares).toBe(1);
    expect(VENUE_EXECUTION_CONSTRAINTS.polymarket.verified).toBe(true);
    expect(VENUE_EXECUTION_CONSTRAINTS.polymarket.shareStep).toBeNull(); // fractionality undocumented
    expect(VENUE_EXECUTION_CONSTRAINTS.polymarket.minOrderShares).toBe(5);
    for (const p of ['limitless', 'predict'] as const) {
      expect(VENUE_EXECUTION_CONSTRAINTS[p].verified).toBe(false);
      expect(VENUE_EXECUTION_CONSTRAINTS[p].shareStep).toBeNull();
      expect(VENUE_EXECUTION_CONSTRAINTS[p].minOrderShares).toBeNull();
    }
    for (const p of Object.keys(VENUE_EXECUTION_CONSTRAINTS) as Platform[]) {
      expect(VENUE_EXECUTION_CONSTRAINTS[p].sources.length).toBeGreaterThan(0);
    }
  });

  test('floorToStep floors, tolerating float noise at step multiples', () => {
    expect(floorToStep(0.9, 1)).toBe(0);
    expect(floorToStep(1.999, 1)).toBe(1);
    expect(floorToStep(3.9999999998, 1)).toBe(4); // FP noise on an exact multiple
    // Within-dust noise (5e-7 below the intended integer — inside the module's
    // 1e-6 MIN_SHARES_THRESHOLD dust convention) must NOT drop a contract.
    expect(floorToStep(3.9999995, 1)).toBe(4);
    expect(floorToStep(0.129, 0.01)).toBeCloseTo(0.12, 12);
  });
});

describe('applyVenueRounding (pure)', () => {
  test('rounding is per-tranche, tightening-only, and re-prices exactly', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'kalshi' },
      { marketId: 11, platform: 'kalshi' },
    ]);
    const { problem, result } = ladderSolution([
      { marketId: 10, platform: 'kalshi', shares: 2.7, askPrice: 0.40, feePerShare: 0.01 },
      { marketId: 11, platform: 'kalshi', shares: 2.7, askPrice: 0.40, feePerShare: 0.01 },
    ]);
    const profit = -result.optimalCost; // 2.7 − 2.7·0.82 = 0.486
    const vr = applyVenueRounding(problem, result, c, profit);
    expect(vr.applied).toBe(true);
    expect(vr.sharesRemoved).toBeCloseTo(1.4, 9);
    // Rounded to 2 shares/leg: worst payout 2, cost 2·2·0.41 = 1.64 → 0.36.
    expect(vr.roundedProfit).toBeCloseTo(0.36, 9);
    expect(vr.roundedProfit).toBeLessThanOrEqual(profit); // never-upgrade
    expect(vr.belowMinLegs.length).toBe(0);
  });

  test('never reports more than the LP profit (cap)', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'kalshi' },
      { marketId: 11, platform: 'kalshi' },
    ]);
    const { problem, result } = ladderSolution([
      { marketId: 10, platform: 'kalshi', shares: 3, askPrice: 0.40 },
      { marketId: 11, platform: 'kalshi', shares: 3, askPrice: 0.40 },
    ]);
    // Understate the LP profit vs the re-derivation → the cap must bind.
    const vr = applyVenueRounding(problem, result, c, 0.05);
    expect(vr.roundedProfit).toBe(0.05);
  });

  test('unverified venues (limitless/predict) pass through untouched', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'limitless' },
      { marketId: 11, platform: 'predict' },
    ]);
    const { problem, result } = ladderSolution([
      { marketId: 10, platform: 'limitless', shares: 0.4, askPrice: 0.45 },
      { marketId: 11, platform: 'predict', shares: 0.4, askPrice: 0.45 },
    ]);
    const profit = -result.optimalCost;
    const vr = applyVenueRounding(problem, result, c, profit);
    expect(vr.applied).toBe(false);
    expect(vr.sharesRemoved).toBe(0);
    expect(vr.belowMinLegs.length).toBe(0);
    expect(vr.roundedProfit).toBeCloseTo(profit, 9);
  });

  test('relaxed/empty-Ω cluster: worst payout from facet certificate G, not a zero-state scan', () => {
    // A facet-routed cluster has NO enumerated states; the state loop would leave
    // worstPayout = 0 and force-demote every relaxed basket under ladder mode.
    const c = categoricalCluster([
      { marketId: 10, platform: 'kalshi' },
      { marketId: 11, platform: 'kalshi' },
    ]);
    c.validStates = [];
    c.relaxed = true;
    // Integer shares → nothing removed → the certificate G=3 carries through whole.
    const whole = ladderSolution([
      { marketId: 10, platform: 'kalshi', shares: 3, askPrice: 0.40 },
      { marketId: 11, platform: 'kalshi', shares: 3, askPrice: 0.40 },
    ]);
    const profit = -whole.result.optimalCost; // 3 − 2.4 = 0.6
    const vr = applyVenueRounding(whole.problem, whole.result, c, profit);
    expect(vr.applied).toBe(true);
    expect(vr.sharesRemoved).toBe(0);
    expect(vr.roundedProfit).toBeCloseTo(0.6, 9);

    // Fractional shares → bound G − sharesRemoved understates (conservative):
    // rounded 2/leg, removed 1.0, bound 2.5−1.0=1.5, cost 1.6 → −0.1 (demotes).
    const frac = ladderSolution([
      { marketId: 10, platform: 'kalshi', shares: 2.5, askPrice: 0.40 },
      { marketId: 11, platform: 'kalshi', shares: 2.5, askPrice: 0.40 },
    ]);
    const fracProfit = -frac.result.optimalCost;
    const vr2 = applyVenueRounding(frac.problem, frac.result, c, fracProfit);
    expect(vr2.roundedProfit).toBeCloseTo(-0.1, 9);
    expect(vr2.roundedProfit).toBeLessThanOrEqual(fracProfit);
  });

  test('polymarket: no share rounding (undocumented) but the 5-share minimum flags', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'polymarket' },
      { marketId: 11, platform: 'polymarket' },
    ]);
    const { problem, result } = ladderSolution([
      { marketId: 10, platform: 'polymarket', shares: 3.3, askPrice: 0.45 },
      { marketId: 11, platform: 'polymarket', shares: 3.3, askPrice: 0.45 },
    ]);
    const profit = -result.optimalCost;
    const vr = applyVenueRounding(problem, result, c, profit);
    expect(vr.applied).toBe(true);
    expect(vr.sharesRemoved).toBe(0); // fractional shares untouched (shareStep null)
    expect(vr.roundedProfit).toBeCloseTo(profit, 9);
    expect(vr.belowMinLegs.length).toBe(2); // 3.3 < 5 on both legs
    expect(vr.belowMinLegs[0].minOrderShares).toBe(5);
  });
});

describe('extractPortfolio venue-rounding demotion (ladder path)', () => {
  test('rounding kills profit → demoted to risky, annotation attached', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'kalshi' },
      { marketId: 11, platform: 'kalshi' },
    ]);
    const pc = cacheFor([
      { marketId: 10, platform: 'kalshi', ask: 0.45 },
      { marketId: 11, platform: 'kalshi', ask: 0.45 },
    ]);
    // 0.9 shares/leg → integer-floor zeroes both legs → rounded profit 0.
    const { problem, result } = ladderSolution([
      { marketId: 10, platform: 'kalshi', shares: 0.9, askPrice: 0.45 },
      { marketId: 11, platform: 'kalshi', shares: 0.9, askPrice: 0.45 },
    ]);
    const arb = extractPortfolio(result, problem, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    expect(arb!.profit).toBeCloseTo(0.09, 9); // LP-certified profit unchanged
    expect(arb!.executionGrade).toBe('risky');
    expect(arb!.executionReasons.some((r) => r.includes('venue rounding kills profit'))).toBe(true);
    expect(arb!.executionReasons.some((r) => r.includes('below venue minimum'))).toBe(true);
    expect(arb!.venueRoundedProfit).toBeCloseTo(0, 9);
    expect(arb!.venueRoundingSharesRemoved).toBeCloseTo(1.8, 9);
  });

  test('above-minimum integer basket → unaffected (clean, profit annotation ≈ profit)', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'kalshi' },
      { marketId: 11, platform: 'kalshi' },
    ]);
    const pc = cacheFor([
      { marketId: 10, platform: 'kalshi', ask: 0.45 },
      { marketId: 11, platform: 'kalshi', ask: 0.45 },
    ]);
    const { problem, result } = ladderSolution([
      { marketId: 10, platform: 'kalshi', shares: 10, askPrice: 0.45 },
      { marketId: 11, platform: 'kalshi', shares: 10, askPrice: 0.45 },
    ]);
    const arb = extractPortfolio(result, problem, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    expect(arb!.profit).toBeCloseTo(1.0, 9);
    expect(arb!.executionGrade).toBe('clean');
    expect(arb!.executionReasons.some((r) => r.includes('venue'))).toBe(false);
    expect(arb!.venueRoundedProfit).toBeCloseTo(1.0, 9);
    expect(arb!.venueRoundingSharesRemoved).toBeCloseTo(0, 9);
  });

  test('unverified venues → passthrough: no demotion, no annotation, dust shares kept', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'limitless' },
      { marketId: 11, platform: 'limitless' },
    ]);
    const pc = cacheFor([
      { marketId: 10, platform: 'limitless', ask: 0.45 },
      { marketId: 11, platform: 'limitless', ask: 0.45 },
    ]);
    const { problem, result } = ladderSolution([
      { marketId: 10, platform: 'limitless', shares: 0.4, askPrice: 0.45 },
      { marketId: 11, platform: 'limitless', shares: 0.4, askPrice: 0.45 },
    ]);
    const arb = extractPortfolio(result, problem, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    expect(arb!.executionReasons.some((r) => r.includes('venue rounding') || r.includes('venue minimum'))).toBe(false);
    expect(arb!.venueRoundedProfit).toBeUndefined();
    expect(arb!.legs.every((l) => l.shares === 0.4)).toBe(true); // basket untouched
  });

  test('non-ladder (min-cost $1-normalized) path is skipped entirely', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'kalshi' },
      { marketId: 11, platform: 'kalshi' },
    ]);
    const pc = cacheFor([
      { marketId: 10, platform: 'kalshi', ask: 0.45 },
      { marketId: 11, platform: 'kalshi', ask: 0.45 },
    ]);
    // Min-cost LP: 1 fractional share per leg, optimalCost = 0.90, no G var.
    const variables: LPVariable[] = [10, 11].map((mid, i) => ({
      index: i, marketId: mid, platform: 'kalshi', side: 'YES' as const,
      askPrice: 0.45, feePerShare: 0, maxShares: null,
    }));
    const problem: LPProblem = {
      numVars: 2, objective: [], constraints: [], rhs: [], variables, clusterId: 1,
    };
    const result: LPResult = { status: 'Optimal', optimalCost: 0.9, values: [0.5, 0.5], solveTimeMs: 1 };
    const arb = extractPortfolio(result, problem, c, pc, 0.01, undefined, TS);
    expect(arb).not.toBeNull();
    // Fractional 0.5-share legs on kalshi, but the scale-free path never demotes.
    expect(arb!.executionGrade).toBe('clean');
    expect(arb!.venueRoundedProfit).toBeUndefined();
  });

  test('ARB_VENUE_ROUNDING off (thresholds.venueRounding.enabled=false) → passthrough', () => {
    const c = categoricalCluster([
      { marketId: 10, platform: 'kalshi' },
      { marketId: 11, platform: 'kalshi' },
    ]);
    const pc = cacheFor([
      { marketId: 10, platform: 'kalshi', ask: 0.45 },
      { marketId: 11, platform: 'kalshi', ask: 0.45 },
    ]);
    const { problem, result } = ladderSolution([
      { marketId: 10, platform: 'kalshi', shares: 0.9, askPrice: 0.45 },
      { marketId: 11, platform: 'kalshi', shares: 0.9, askPrice: 0.45 },
    ]);
    const arb = extractPortfolio(result, problem, c, pc, 0.01, { venueRounding: { enabled: false } } as never, TS);
    // Cast: only the venueRounding field matters; other thresholds absent ⟹
    // their gates read undefined and never demote.
    expect(arb).not.toBeNull();
    expect(arb!.venueRoundedProfit).toBeUndefined();
    expect(arb!.executionReasons.some((r) => r.includes('venue rounding'))).toBe(false);
  });
});
