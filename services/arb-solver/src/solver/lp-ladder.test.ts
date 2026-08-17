import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode } from '../graph/types.js';
import { PriceCache, type PriceUpdate } from '../clob/price-cache.js';
import { buildLP, type PricedLPVariable } from './lp-builder.js';
import { solveLP } from './solver.js';
import { extractPortfolio } from './portfolio.js';
import { NO_EXECUTION_GATE } from './types.js';
import type { LPVariable } from './types.js';

/**
 * DEPTH-AWARE book-ladder (tranche) tests. `buildLP`'s 5th param `bookLadder`
 * gates tranching directly, so these don't touch env.
 */

function binaryCluster(marketIds: number[], platform: Platform = 'polymarket'): Cluster {
  const markets = new Map<number, MarketRef>();
  for (const id of marketIds) {
    markets.set(id, { marketId: id, platform, platformId: `pid-${id}` });
  }
  const q: QuestionNode = {
    questionId: 1, canonicalSubject: 's1', conditionShape: null,
    conditionValue: null, conditionDate: null, markets,
  };
  return {
    id: 1,
    questions: new Map([[1, q]]),
    outcomeSets: [], edges: [],
    marketIds: new Set(marketIds),
    validStates: [new Map([[1, true]]), new Map([[1, false]])],
    dirty: false,
  };
}

const yesLadderUpd = (
  marketId: number,
  bestBid: number,
  bestAsk: number,
  askLevels: Array<[number, number]>,
  bidLevels: Array<[number, number]>,
  ts = Date.now(),
): PriceUpdate => ({
  marketId, platform: 'polymarket' as const,
  bestBid, bestAsk, bidSize: bidLevels[0]?.[1] ?? 0, askSize: askLevels[0]?.[1] ?? 0,
  timestamp: ts, askLevels, bidLevels,
});

const noBookLadderUpd = (
  marketId: number,
  bestBid: number,
  bestAsk: number,
  askLevels: Array<[number, number]>,
  ts = Date.now(),
): PriceUpdate => ({
  marketId, platform: 'polymarket' as const, outcome: 'no' as const,
  bestBid, bestAsk, bidSize: 0, askSize: askLevels[0]?.[1] ?? 0,
  timestamp: ts, askLevels, bidLevels: [],
});

const yesVars = (lp: { variables: LPVariable[] }, marketId: number): PricedLPVariable[] =>
  lp.variables.filter((v) => v.marketId === marketId && v.side === 'YES') as PricedLPVariable[];
const noVars = (lp: { variables: LPVariable[] }, marketId: number): PricedLPVariable[] =>
  lp.variables.filter((v) => v.marketId === marketId && v.side === 'NO') as PricedLPVariable[];

describe('buildLP ladder tranching', () => {
  test('flag OFF ⟹ exactly one variable per leg (byte-identical), even with ladders present', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.44, 0.45, [[0.45, 100], [0.46, 200]], [[0.44, 100], [0.43, 80]]));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, false, /* bookLadder */ false)!;
    expect(yesVars(lp, 10)).toHaveLength(1);
    expect(noVars(lp, 10)).toHaveLength(1);
    expect(yesVars(lp, 10)[0].askPrice).toBeCloseTo(0.45, 9);
    expect(yesVars(lp, 10)[0].level).toBeUndefined();
  });

  test('flag ON, multi-level YES ask ⟹ N tranches with correct prices & caps', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.44, 0.45, [[0.45, 100], [0.46, 200], [0.47, 50]], [[0.44, 70], [0.43, 30]]));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, false, true)!;
    const ys = yesVars(lp, 10);
    expect(ys).toHaveLength(3);
    expect(ys.map((v) => v.askPrice)).toEqual([0.45, 0.46, 0.47]);
    expect(ys.map((v) => v.maxShares)).toEqual([100, 200, 50]); // ACTUAL level sizes
    expect(ys.map((v) => v.level)).toEqual([0, 1, 2]);
    // Objective coefficient = level price (fees off).
    for (const v of ys) expect(lp.objective[v.index]).toBeCloseTo(v.askPrice, 9);
  });

  test('flag ON: synthetic-NO tranches come from the YES BID ladder (price = 1 − bid, cap = bid size)', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    // No NO book → synthetic. YES bids: 0.44×70, 0.43×30 → NO tranches 0.56×70, 0.57×30.
    pc.update(yesLadderUpd(10, 0.44, 0.45, [[0.45, 100]], [[0.44, 70], [0.43, 30]]));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, true, true)!;
    const ns = noVars(lp, 10);
    expect(ns).toHaveLength(2);
    expect(ns[0].askPrice).toBeCloseTo(0.56, 9);
    expect(ns[0].maxShares).toBe(70);
    expect(ns[0].priceSource).toBe('synthetic');
    expect(ns[1].askPrice).toBeCloseTo(0.57, 9);
    expect(ns[1].maxShares).toBe(30);
  });

  test('flag ON: real-NO tranches come from the NO ASK ladder', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.44, 0.45, [[0.45, 100]], [[0.44, 70]]));
    pc.update(noBookLadderUpd(10, 0.52, 0.56, [[0.56, 40], [0.57, 60]]));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, /* twoSided */ true, /* ladder */ true)!;
    const ns = noVars(lp, 10);
    expect(ns).toHaveLength(2);
    expect(ns.map((v) => v.askPrice)).toEqual([0.56, 0.57]);
    expect(ns.map((v) => v.maxShares)).toEqual([40, 60]);
    expect(ns.every((v) => v.priceSource === 'book')).toBe(true);
  });

  test('flag ON but no ladder on the snapshot ⟹ single variable (graceful fallback)', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.44, bestAsk: 0.45, bidSize: 100, askSize: 100, timestamp: Date.now() });
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, false, true)!;
    expect(yesVars(lp, 10)).toHaveLength(1);
    expect(noVars(lp, 10)).toHaveLength(1);
  });
});

describe('SYNTHETIC DEPTH: the LP walks deeper and stops at marginal cost $1', () => {
  // Two markets on the SAME question (market 10 = buy YES, market 11 = buy NO via
  // its YES bid ladder). Basket cost per matched share = yesAsk(10) + noPrice(11).
  //  - Level 0: yesAsk 0.45 (×100) + noPrice (1−0.58)=0.42 (×100) = $0.87  → arb
  //  - Level 1: yesAsk 0.47 (×100) + noPrice (1−0.55)=0.45 (×100) = $0.92  → still arb
  //  - Level 2: yesAsk 0.50 (×100) + noPrice (1−0.49)=0.51 (×100) = $1.01  → NOT an arb
  // Depth-aware LP should fill levels 0+1 (200 shares each leg) and STOP before
  // level 2. The top-of-book-only LP (flag off) buys only level 0 (100 shares).
  function twoMarketCluster(): Cluster {
    const markets10 = new Map<number, MarketRef>([[10, { marketId: 10, platform: 'polymarket', platformId: 'pid-10' }]]);
    const markets11 = new Map<number, MarketRef>([[11, { marketId: 11, platform: 'polymarket', platformId: 'pid-11' }]]);
    // Both markets resolve the SAME question (binary): buy YES(10) + NO(11) hedges it.
    const q: QuestionNode = {
      questionId: 1, canonicalSubject: 's1', conditionShape: null,
      conditionValue: null, conditionDate: null,
      markets: new Map([...markets10, ...markets11]),
    };
    return {
      id: 1, questions: new Map([[1, q]]), outcomeSets: [], edges: [],
      marketIds: new Set([10, 11]),
      validStates: [new Map([[1, true]]), new Map([[1, false]])],
      dirty: false,
    };
  }

  function seed(pc: PriceCache): void {
    // Market 10 YES ask ladder (we BUY YES here).
    pc.update(yesLadderUpd(10, 0.40, 0.45, [[0.45, 100], [0.47, 100], [0.50, 100]], [[0.40, 100]]));
    // Market 11 YES bid ladder (we BUY NO here = sell YES into the bid). Bids
    // 0.58→0.55→0.49 give NO prices 0.42→0.45→0.51 at sizes 100 each.
    pc.update(yesLadderUpd(11, 0.58, 0.62, [[0.62, 100]], [[0.58, 100], [0.55, 100], [0.49, 100]]));
  }

  test('flag OFF: only the cheapest (top-of-book) tier is priced — never walks deeper', async () => {
    const c = twoMarketCluster();
    const pc = new PriceCache();
    seed(pc);
    // Depth cap ON so the conservative LP is bounded at top-of-book size.
    const lp = buildLP(c, pc, { enforceFees: false, enforceDepthCap: true }, true, /* ladder */ false)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    // The min-cost-for-$1-guaranteed LP buys the cheapest basket and STOPS at $1
    // of guaranteed payout: cost = 0.45 (YES top) + 0.42 (synthetic NO top) = $0.87.
    // It is NOT depth-aware: a single variable per leg, priced ONLY at the top of
    // book, so it never walks into the 0.47 / 0.50 tiers.
    expect(res.optimalCost).toBeCloseTo(0.87, 6);
    expect(lp.guaranteedPayoutVarIndex).toBeUndefined(); // no profit-max G var
    // Exactly one YES(10) and one NO(11) variable — no tranching.
    expect(lp.variables.filter((v) => v.marketId === 10 && v.side === 'YES')).toHaveLength(1);
    expect(lp.variables.filter((v) => v.marketId === 11 && v.side === 'NO')).toHaveLength(1);
    // It buys ~1 matched share (enough for $1 guaranteed) — the prior behavior.
    const yesShares = lp.variables
      .filter((v) => v.marketId === 10 && v.side === 'YES')
      .reduce((s, v) => s + (res.values[v.index] ?? 0), 0);
    expect(yesShares).toBeCloseTo(1, 4);
  });

  test('flag ON: walks levels 0+1 (200 shares/leg), STOPS before the $1 level', async () => {
    const c = twoMarketCluster();
    const pc = new PriceCache();
    seed(pc);
    const lp = buildLP(c, pc, { enforceFees: false, enforceDepthCap: true }, true, /* ladder */ true)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');

    // Per-leg filled shares, aggregated across tranches.
    const filled = (marketId: number, side: 'YES' | 'NO') =>
      lp.variables
        .filter((v) => v.marketId === marketId && v.side === side)
        .reduce((s, v) => s + (res.values[v.index] ?? 0), 0);
    const yesShares = filled(10, 'YES');
    const noShares = filled(11, 'NO');

    // It fills levels 0 and 1 of BOTH legs = 200 shares each, and NOT level 2.
    expect(yesShares).toBeCloseTo(200, 4);
    expect(noShares).toBeCloseTo(200, 4);

    // Specifically: the $1.01 level (yesAsk 0.50 / NO 0.51) must NOT be bought —
    // the LP stops exactly where the marginal basket cost would reach $1.
    const yesL2 = lp.variables.find((v) => v.marketId === 10 && v.side === 'YES' && v.askPrice === 0.50)!;
    expect(res.values[yesL2.index] ?? 0).toBeLessThan(1e-6);
    const noL2 = noVars(lp, 11).find((v) => Math.abs(v.askPrice - 0.51) < 1e-9)!;
    expect(res.values[noL2.index] ?? 0).toBeLessThan(1e-6);

    // Profit-max LP objective = cost − G = −profit. G (guaranteed payout) = 200;
    // cost = (0.45+0.47)·100 + (0.42+0.45)·100 = 92 + 87 = $179 → profit = $21.
    expect(lp.guaranteedPayoutVarIndex).toBeDefined();
    const gVal = res.values[lp.guaranteedPayoutVarIndex!] ?? 0;
    expect(gVal).toBeCloseTo(200, 4);
    expect(res.optimalCost).toBeCloseTo(-21, 4); // = −profit
  });

  test('flag ON extracts STRICTLY MORE total $ than flag OFF at the same arb', async () => {
    const c = twoMarketCluster();
    const pc = new PriceCache();
    seed(pc);
    const offLp = buildLP(c, pc, { enforceFees: false, enforceDepthCap: true }, true, false)!;
    const onLp = buildLP(c, pc, { enforceFees: false, enforceDepthCap: true }, true, true)!;
    const off = await solveLP(offLp);
    const on = await solveLP(onLp);

    // Flag OFF (min-cost-$1): buys ~1 share of the cheapest level for $0.87.
    expect(off.optimalCost).toBeCloseTo(0.87, 6);

    // Flag ON (profit-max): deploys real depth (200 matched shares) for $21 profit.
    expect(onLp.guaranteedPayoutVarIndex).toBeDefined();
    const gOn = on.values[onLp.guaranteedPayoutVarIndex!] ?? 0;
    expect(gOn).toBeCloseTo(200, 4);
    const profitOn = -on.optimalCost;
    expect(profitOn).toBeCloseTo(21, 4);
    // The flag-on basket deploys vastly more capital ($179) at a positive edge,
    // far beyond the flag-off single-share normalization.
    expect(profitOn).toBeGreaterThan(1.0 - off.optimalCost);
  });
});

describe('portfolio tranche aggregation', () => {
  test('tranches of a (market, side) collapse to one leg: blended price, levelsConsumed, depth-aware liquidity', async () => {
    const c = (() => {
      const q: QuestionNode = {
        questionId: 1, canonicalSubject: 's1', conditionShape: null,
        conditionValue: null, conditionDate: null,
        markets: new Map<number, MarketRef>([
          [10, { marketId: 10, platform: 'polymarket', platformId: 'pid-10' }],
          [11, { marketId: 11, platform: 'polymarket', platformId: 'pid-11' }],
        ]),
      };
      return {
        id: 1, questions: new Map([[1, q]]), outcomeSets: [], edges: [],
        marketIds: new Set([10, 11]),
        validStates: [new Map([[1, true]]), new Map([[1, false]])],
        dirty: false,
      } as Cluster;
    })();
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.40, 0.45, [[0.45, 100], [0.47, 100], [0.50, 100]], [[0.40, 100]]));
    pc.update(yesLadderUpd(11, 0.58, 0.62, [[0.62, 100]], [[0.58, 100], [0.55, 100], [0.49, 100]]));

    const lp = buildLP(c, pc, { enforceFees: false, enforceDepthCap: true }, true, true)!;
    const res = await solveLP(lp);
    const port = extractPortfolio(res, lp, c, pc, 0)!;
    expect(port).not.toBeNull();

    const yesLeg = port.legs.find((l) => l.marketId === 10 && l.side === 'YES')!;
    expect(yesLeg.shares).toBeCloseTo(200, 4);            // two tranches summed
    expect(yesLeg.levelsConsumed).toBe(2);
    // Blended price = (0.45·100 + 0.47·100)/200 = 0.46.
    expect(yesLeg.askPrice).toBeCloseTo(0.46, 6);
    // cost = blended·shares (fees off) = 0.46·200 = 92.
    expect(yesLeg.cost).toBeCloseTo(92, 4);
    expect(yesLeg.depthProfile).toHaveLength(2);
    expect(yesLeg.depthProfile![0]).toEqual({ price: 0.45, shares: yesLeg.depthProfile![0].shares });

    // Depth-aware liquidity = Σ price·shares of the binding leg (consumed $), not
    // top-of-book only. minLiquidity across legs is the smaller consumed total.
    expect(port.liquidityUsd).toBeGreaterThan(0);
    expect(port.liquidityUsd).toBeCloseTo(Math.min(92, port.legs.find((l) => l.marketId === 11)!.cost), 4);
  });

  test('non-ladder portfolio: levelsConsumed=1, no depthProfile, liquidity = top-of-book', async () => {
    const c = binaryCluster([10, 11]);
    // make them one question so YES(10)+NO(11) hedges
    const q = c.questions.get(1)!;
    q.markets.set(11, { marketId: 11, platform: 'polymarket', platformId: 'pid-11' });
    c.marketIds = new Set([10, 11]);
    const pc = new PriceCache();
    pc.update({ marketId: 10, platform: 'polymarket', bestBid: 0.43, bestAsk: 0.45, bidSize: 100, askSize: 100, timestamp: Date.now() });
    pc.update({ marketId: 11, platform: 'polymarket', bestBid: 0.58, bestAsk: 0.60, bidSize: 100, askSize: 100, timestamp: Date.now() });
    const lp = buildLP(c, pc, { enforceFees: false, enforceDepthCap: true }, false, false)!;
    const res = await solveLP(lp);
    const port = extractPortfolio(res, lp, c, pc, 0)!;
    for (const leg of port.legs) {
      expect(leg.levelsConsumed).toBe(1);
      expect(leg.depthProfile).toBeUndefined();
    }
  });
});
