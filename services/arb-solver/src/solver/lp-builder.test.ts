import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode } from '../graph/types.js';
import { PriceCache } from '../clob/price-cache.js';
import { buildLP, legPriceSource, type PricedLPVariable } from './lp-builder.js';
import { solveLP } from './solver.js';
import { NO_EXECUTION_GATE, type ExecutionParams, type LPVariable } from './types.js';

const DEPTH_ONLY: ExecutionParams = { enforceFees: false, enforceDepthCap: true };

/** One binary question holding `marketIds` (≥1 market on the same question);
 *  two worlds: question YES / question NO. */
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

const yesUpd = (marketId: number, bestBid: number, bestAsk: number, ts = Date.now()) => ({
  marketId, platform: 'polymarket' as const,
  bestBid, bestAsk, bidSize: 100, askSize: 100, timestamp: ts,
});
const noBookUpd = (
  marketId: number, bestBid: number, bestAsk: number, askSize = 70, ts = Date.now(),
) => ({
  marketId, platform: 'polymarket' as const, outcome: 'no' as const,
  bestBid, bestAsk, bidSize: 80, askSize, timestamp: ts,
});

const noVar = (lp: { variables: LPVariable[] }, marketId: number): PricedLPVariable =>
  lp.variables.find((v) => v.marketId === marketId && v.side === 'NO') as PricedLPVariable;
const yesVar = (lp: { variables: LPVariable[] }, marketId: number): PricedLPVariable =>
  lp.variables.find((v) => v.marketId === marketId && v.side === 'YES') as PricedLPVariable;

describe('buildLP NO-side source selection (real NO book vs synthetic 1−bestBid)', () => {
  test('flag OFF (default param false): synthetic 1−bestBid even when a NO book exists', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.44, 0.45));
    pc.update(noBookUpd(10, 0.52, 0.58)); // real NO book present but flag off
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, false)!;
    expect(noVar(lp, 10).askPrice).toBeCloseTo(0.56, 9); // 1 − 0.44
    expect(noVar(lp, 10).priceSource).toBe('synthetic');
    expect(yesVar(lp, 10).priceSource).toBe('book');
  });

  test('flag ON + fresh NO book: real NO bestAsk + priceSource book', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.44, 0.45));
    pc.update(noBookUpd(10, 0.52, 0.58));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    expect(noVar(lp, 10).askPrice).toBeCloseTo(0.58, 9);
    expect(noVar(lp, 10).priceSource).toBe('book');
    // objective coefficient = chosen ask (fees off)
    expect(lp.objective[noVar(lp, 10).index]).toBeCloseTo(0.58, 9);
    // YES side untouched — sources are never mixed within a leg
    expect(yesVar(lp, 10).askPrice).toBeCloseTo(0.45, 9);
    expect(yesVar(lp, 10).priceSource).toBe('book');
  });

  test('flag ON, no NO book ever received: synthetic fallback', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.44, 0.45));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    expect(noVar(lp, 10).askPrice).toBeCloseTo(0.56, 9);
    expect(noVar(lp, 10).priceSource).toBe('synthetic');
  });

  test('flag ON, NO book aged past TTL (YES still fresh): synthetic fallback', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.setTtl(60_000);
    pc.update(yesUpd(10, 0.44, 0.45));                              // fresh
    pc.update(noBookUpd(10, 0.52, 0.58, 70, Date.now() - 120_000)); // aged out
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    expect(noVar(lp, 10).askPrice).toBeCloseTo(0.56, 9);
    expect(noVar(lp, 10).priceSource).toBe('synthetic');
  });

  test('flag ON, NO book explicitly stale: synthetic fallback (not the $2 sentinel)', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(noBookUpd(10, 0.52, 0.58));
    // Manually stale just the NO side state by re-sending then aging via markStaleByIds
    // would sentinel BOTH sides; instead simulate a NO-only outage: fresh YES re-update
    // after the stale mark restores the YES book only.
    pc.markStaleByIds([10]);
    pc.update(yesUpd(10, 0.44, 0.45));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    expect(noVar(lp, 10).askPrice).toBeCloseTo(0.56, 9); // synthetic from fresh YES
    expect(noVar(lp, 10).priceSource).toBe('synthetic');
  });

  test('flag ON, NO book is empty (sentinel ask $2): synthetic fallback', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.44, 0.45));
    // Adapter emits sentinel best when the NO book has no asks.
    pc.update({ ...noBookUpd(10, 0.52, 2.0), askSize: 0 });
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    expect(noVar(lp, 10).askPrice).toBeCloseTo(0.56, 9);
    expect(noVar(lp, 10).priceSource).toBe('synthetic');
  });

  test('depth follows the priced book: NO askSize when book, YES bidSize when synthetic', () => {
    const c = binaryCluster([10, 11]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.44, 0.45)); // bidSize 100
    pc.update(noBookUpd(10, 0.52, 0.58, 70));
    pc.update(yesUpd(11, 0.40, 0.42)); // no NO book → synthetic
    const lp = buildLP(c, pc, DEPTH_ONLY, true)!;
    expect(noVar(lp, 10).maxShares).toBe(70);   // real NO book depth
    expect(noVar(lp, 11).maxShares).toBe(100);  // synthetic → YES bid depth
    expect(yesVar(lp, 10).maxShares).toBe(100); // YES always its own askSize
  });

  test('flag ON with no exec gate leaves depth uncapped regardless of source', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.44, 0.45));
    pc.update(noBookUpd(10, 0.52, 0.58));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    expect(noVar(lp, 10).maxShares).toBeNull();
  });

  test('the audit scenario: a synthetic-NO fake arb disappears under real NO pricing', async () => {
    // Two markets on the SAME question. Market 11's YES bid is high (0.58), so
    // the synthetic NO looks cheap (0.42): buy YES(10)@0.45 + NO(11)@0.42 =
    // $0.87 for a guaranteed $1 → a fake arb if nobody actually sells NO there.
    const c = binaryCluster([10, 11]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.43, 0.45));
    pc.update(yesUpd(11, 0.58, 0.60));

    const synthetic = buildLP(c, pc, NO_EXECUTION_GATE, false)!;
    const resSyn = await solveLP(synthetic);
    expect(resSyn.status).toBe('Optimal');
    expect(resSyn.optimalCost).toBeCloseTo(0.87, 3); // the fake arb

    // Real NO books quote 0.56 — the LP must pay what is actually offered.
    pc.update(noBookUpd(10, 0.54, 0.56));
    pc.update(noBookUpd(11, 0.54, 0.56));
    const real = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    const resReal = await solveLP(real);
    expect(resReal.optimalCost).toBeGreaterThanOrEqual(1.0); // arb gone
    expect(noVar(real, 11).priceSource).toBe('book');
  });

  test('recall direction: a real NO book CHEAPER than the synthesis surfaces a true arb', async () => {
    const c = binaryCluster([10, 11]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.43, 0.45));
    pc.update(yesUpd(11, 0.50, 0.52)); // synthetic NO = 0.50 → 0.45+0.50 = 0.95
    pc.update(noBookUpd(11, 0.40, 0.42)); // but the real NO ask is 0.42

    const synthetic = buildLP(c, pc, NO_EXECUTION_GATE, false)!;
    expect((await solveLP(synthetic)).optimalCost).toBeCloseTo(0.95, 3);

    const real = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    expect((await solveLP(real)).optimalCost).toBeCloseTo(0.87, 3); // 0.45 + 0.42
  });
});

describe('buildLP fee folding (per-market feeModel)', () => {
  const FEES_ONLY: ExecutionParams = { enforceFees: true, enforceDepthCap: false };

  test('a bernoulli feeModel on the MarketRef folds into the objective coefficient', () => {
    const c = binaryCluster([10], 'polymarket');
    // Override the (test-built) MarketRef with an explicit crypto-rate model.
    c.questions.get(1)!.markets.get(10)!.feeModel = { form: 'bernoulli', rate: 0.07, exponent: 1 };
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.44, 0.45)); // synthetic NO = 1 − 0.44 = 0.56
    const lp = buildLP(c, pc, FEES_ONLY, false)!;

    // YES leg: buy at 0.45 → fee 0.07·0.45·0.55 = 0.017325.
    const feeYes = 0.07 * 0.45 * 0.55;
    expect(yesVar(lp, 10).feePerShare).toBeCloseTo(feeYes, 9);
    expect(lp.objective[yesVar(lp, 10).index]).toBeCloseTo(0.45 + feeYes, 9);

    // NO leg (synthetic): sell YES into the bid at 1 − askNo = 1 − 0.56 = 0.44.
    // Bernoulli is symmetric, so fee(0.44) == fee(0.56).
    const feeNo = 0.07 * 0.44 * 0.56;
    expect(noVar(lp, 10).feePerShare).toBeCloseTo(feeNo, 9);
    expect(lp.objective[noVar(lp, 10).index]).toBeCloseTo(0.56 + feeNo, 9);
  });

  test('a missing feeModel falls back to defaultFeeModel(platform)', () => {
    // binaryCluster builds MarketRefs WITHOUT a feeModel → kalshi default rate 0.07.
    const c = binaryCluster([10], 'kalshi');
    expect(c.questions.get(1)!.markets.get(10)!.feeModel).toBeUndefined();
    const pc = new PriceCache();
    pc.update({
      marketId: 10, platform: 'kalshi',
      bestBid: 0.44, bestAsk: 0.45, bidSize: 100, askSize: 100, timestamp: Date.now(),
    });
    const lp = buildLP(c, pc, FEES_ONLY, false)!;
    // Kalshi default: 0.07·0.45·0.55 on the YES leg.
    expect(yesVar(lp, 10).feePerShare).toBeCloseTo(0.07 * 0.45 * 0.55, 9);
  });

  test('fees off → zero fee folded regardless of feeModel', () => {
    const c = binaryCluster([10], 'kalshi');
    c.questions.get(1)!.markets.get(10)!.feeModel = { form: 'bernoulli', rate: 0.07, exponent: 1 };
    const pc = new PriceCache();
    pc.update({
      marketId: 10, platform: 'kalshi',
      bestBid: 0.44, bestAsk: 0.45, bidSize: 100, askSize: 100, timestamp: Date.now(),
    });
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, false)!;
    expect(yesVar(lp, 10).feePerShare).toBe(0);
    expect(lp.objective[yesVar(lp, 10).index]).toBeCloseTo(0.45, 9);
  });
});

describe('legPriceSource accessor', () => {
  test('reads the annotation when present', () => {
    const c = binaryCluster([10]);
    const pc = new PriceCache();
    pc.update(yesUpd(10, 0.44, 0.45));
    pc.update(noBookUpd(10, 0.52, 0.58));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
    expect(legPriceSource(noVar(lp, 10))).toBe('book');
    expect(legPriceSource(yesVar(lp, 10))).toBe('book');
  });

  test('infers the legacy source semantics for un-annotated variables', () => {
    const bare = (side: 'YES' | 'NO'): LPVariable => ({
      index: 0, marketId: 1, platform: 'polymarket', side,
      askPrice: 0.5, feePerShare: 0, maxShares: null,
    });
    expect(legPriceSource(bare('YES'))).toBe('book');
    expect(legPriceSource(bare('NO'))).toBe('synthetic');
  });
});

// A synthetic NO leg (1 − bestBid(YES)) off a crossed YES book (bid >= ask)
// must be dropped. A real NO book leg is unaffected.
describe('FIX ① crossed-book synthetic-NO suppression', () => {
  const withFlag = (val: string | undefined, fn: () => void) => {
    const prev = process.env.CLOB_REJECT_CROSSED_BOOK;
    if (val === undefined) delete process.env.CLOB_REJECT_CROSSED_BOOK;
    else process.env.CLOB_REJECT_CROSSED_BOOK = val;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.CLOB_REJECT_CROSSED_BOOK;
      else process.env.CLOB_REJECT_CROSSED_BOOK = prev;
    }
  };

  test('default ON: crossed YES (bid 0.56 >= ask 0.47) → synthetic NO leg SUPPRESSED', () => {
    withFlag(undefined, () => {
      const c = binaryCluster([10]);
      const pc = new PriceCache();
      pc.update(yesUpd(10, 0.56, 0.47)); // crossed
      const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
      expect(yesVar(lp, 10)).toBeDefined();   // YES leg still present
      expect(noVar(lp, 10)).toBeUndefined();  // synthetic NO leg dropped
    });
  });

  test('default ON: crossed YES but a REAL NO book exists → NO leg KEPT (book, not synthetic)', () => {
    withFlag(undefined, () => {
      const c = binaryCluster([10]);
      const pc = new PriceCache();
      pc.update(yesUpd(10, 0.56, 0.47)); // crossed YES
      pc.update(noBookUpd(10, 0.52, 0.58)); // independent NO book
      const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
      expect(noVar(lp, 10)).toBeDefined();
      expect(noVar(lp, 10).priceSource).toBe('book'); // real NO book, never suppressed
      expect(noVar(lp, 10).askPrice).toBeCloseTo(0.58, 9);
    });
  });

  test('default ON: a NORMAL (non-crossed) YES book keeps its synthetic NO leg', () => {
    withFlag(undefined, () => {
      const c = binaryCluster([10]);
      const pc = new PriceCache();
      pc.update(yesUpd(10, 0.44, 0.45)); // normal bid<ask
      const lp = buildLP(c, pc, NO_EXECUTION_GATE, true)!;
      expect(noVar(lp, 10)).toBeDefined();
      expect(noVar(lp, 10).priceSource).toBe('synthetic');
      expect(noVar(lp, 10).askPrice).toBeCloseTo(0.56, 9);
    });
  });

  // The crossed-book gate is unconditionally on, so a crossed YES always
  // drops the synthetic NO leg.
});
