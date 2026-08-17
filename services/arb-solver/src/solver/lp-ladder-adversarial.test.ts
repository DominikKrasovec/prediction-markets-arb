import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode } from '../graph/types.js';
import { PriceCache, type PriceUpdate } from '../clob/price-cache.js';
import { buildLP } from './lp-builder.js';
import { solveLP } from './solver.js';
import { extractPortfolio } from './portfolio.js';
import { NO_EXECUTION_GATE, type ExecutionParams } from './types.js';

// Adversarial validation of the depth-aware profit-max LP: try to make it
// overstate profit / manufacture a fake arb, or find a missing state row.

const DEPTH: ExecutionParams = { enforceFees: false, enforceDepthCap: true };

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

function hedgeCluster(a: number, b: number, platform: Platform = 'polymarket'): Cluster {
  const q: QuestionNode = {
    questionId: 1, canonicalSubject: 's1', conditionShape: null,
    conditionValue: null, conditionDate: null,
    markets: new Map<number, MarketRef>([
      [a, { marketId: a, platform, platformId: `pid-${a}` }],
      [b, { marketId: b, platform, platformId: `pid-${b}` }],
    ]),
  };
  return {
    id: 1, questions: new Map([[1, q]]), outcomeSets: [], edges: [],
    marketIds: new Set([a, b]),
    validStates: [new Map([[1, true]]), new Map([[1, false]])],
    dirty: false,
  };
}

describe('ADVERSARIAL: G is clamped to the WORST state (never average/best)', () => {
  function twoIndependentQuestions(): Cluster {
    const q1: QuestionNode = {
      questionId: 1, canonicalSubject: 's1', conditionShape: null,
      conditionValue: null, conditionDate: null,
      markets: new Map<number, MarketRef>([[10, { marketId: 10, platform: 'polymarket', platformId: 'pid-10' }]]),
    };
    const q2: QuestionNode = {
      questionId: 2, canonicalSubject: 's2', conditionShape: null,
      conditionValue: null, conditionDate: null,
      markets: new Map<number, MarketRef>([[20, { marketId: 20, platform: 'polymarket', platformId: 'pid-20' }]]),
    };
    return {
      id: 1, questions: new Map([[1, q1], [2, q2]]), outcomeSets: [], edges: [],
      marketIds: new Set([10, 20]),
      validStates: [
        new Map([[1, true], [2, true]]),
        new Map([[1, true], [2, false]]),
        new Map([[1, false], [2, true]]),
        new Map([[1, false], [2, false]]),
      ],
      dirty: false,
    };
  }

  test('buying only YES on two independent questions cannot manufacture an arb (G clamps to the $0 state)', async () => {
    const c = twoIndependentQuestions();
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.40, 0.45, [[0.45, 100], [0.46, 100]], [[0.40, 100]]));
    pc.update(yesLadderUpd(20, 0.40, 0.45, [[0.45, 100], [0.46, 100]], [[0.40, 100]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    expect(lp.guaranteedPayoutVarIndex).toBeDefined();
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const g = res.values[lp.guaranteedPayoutVarIndex!] ?? 0;
    expect(g).toBeLessThan(1e-6);
    expect(res.optimalCost).toBeGreaterThanOrEqual(-1e-6);
    const port = extractPortfolio(res, lp, c, pc, 0);
    expect(port).toBeNull();
  });

  test('3-state categorical: G clamps to the lowest-payout state, profit = worst − cost', async () => {
    const c = hedgeCluster(10, 11);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.29, 0.30, [[0.30, 100], [0.31, 100]], [[0.29, 100]]));
    pc.update(yesLadderUpd(11, 0.62, 0.65, [[0.65, 100]], [[0.62, 100], [0.61, 50]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    expect(lp.guaranteedPayoutVarIndex).toBeDefined();
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const g = res.values[lp.guaranteedPayoutVarIndex!] ?? 0;

    let worst = Infinity, best = -Infinity;
    for (const st of c.validStates) {
      let payout = 0;
      for (const v of lp.variables) {
        if (v.index === lp.guaranteedPayoutVarIndex) continue;
        const sh = res.values[v.index] ?? 0;
        if (sh < 1e-9) continue;
        const yes = st.get(1) ?? false;
        if ((v.side === 'YES' && yes) || (v.side === 'NO' && !yes)) payout += sh;
      }
      worst = Math.min(worst, payout);
      best = Math.max(best, payout);
    }
    expect(g).toBeCloseTo(worst, 4);
    const port = extractPortfolio(res, lp, c, pc, 0)!;
    expect(port.guaranteedPayout).toBeCloseTo(worst, 4);
    expect(port.worstEnumeratedStatePayout).toBeCloseTo(worst, 4);
    expect(port.profit).toBeCloseTo(worst - port.totalCost, 4);
  });
});

// A single-market question (only YES(10) + its synthetic NO) has exactly one
// hedge path, unlike hedgeCluster's four legs — isolates the profit-max LP on
// a single tranched leg pair.
function singleMarketCluster(m: number): Cluster {
  const q: QuestionNode = {
    questionId: 1, canonicalSubject: 's1', conditionShape: null,
    conditionValue: null, conditionDate: null,
    markets: new Map<number, MarketRef>([[m, { marketId: m, platform: 'polymarket', platformId: `pid-${m}` }]]),
  };
  return {
    id: 1, questions: new Map([[1, q]]), outcomeSets: [], edges: [],
    marketIds: new Set([m]),
    validStates: [new Map([[1, true]]), new Map([[1, false]])],
    dirty: false,
  };
}

describe('ADVERSARIAL: an unprofitable book yields profit <= 0 (no arb)', () => {
  test('single market, YES ask + synthetic NO both expensive ⟹ profit <= 0, portfolio null', async () => {
    const c = singleMarketCluster(10);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.45, 0.60, [[0.60, 100], [0.62, 100]], [[0.45, 100], [0.44, 100]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    expect(lp.guaranteedPayoutVarIndex).toBeDefined();
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const profit = -res.optimalCost;
    expect(profit).toBeLessThanOrEqual(1e-6);
    const port = extractPortfolio(res, lp, c, pc, 0);
    expect(port).toBeNull();
  });

  test('single market, basket = $1.00 exactly ⟹ no positive profit', async () => {
    const c = singleMarketCluster(10);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.50, 0.50, [[0.50, 100], [0.51, 100]], [[0.50, 100], [0.49, 100]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const profit = -res.optimalCost;
    expect(profit).toBeLessThanOrEqual(1e-6);
  });

  test('two-market cluster where ALL cross pairings cost ≥ $1 ⟹ no arb', async () => {
    const c = hedgeCluster(10, 11);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.45, 0.60, [[0.60, 100], [0.62, 100]], [[0.45, 100], [0.44, 100]]));
    pc.update(yesLadderUpd(11, 0.45, 0.60, [[0.60, 100], [0.62, 100]], [[0.45, 100], [0.44, 100]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    expect(-res.optimalCost).toBeLessThanOrEqual(1e-6);
    expect(extractPortfolio(res, lp, c, pc, 0)).toBeNull();
  });
});

describe('ADVERSARIAL: cost crosses $1 BETWEEN levels — LP fills exactly the profitable levels', () => {
  test('3-level cross: fills L0+L1, stops at L2, correct totals & profit', async () => {
    const c = hedgeCluster(10, 11);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.39, 0.40, [[0.40, 100], [0.42, 150], [0.55, 100]], [[0.39, 100]]));
    pc.update(yesLadderUpd(11, 0.55, 0.60, [[0.60, 100]], [[0.55, 100], [0.53, 150], [0.40, 100]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');

    const filled = (mid: number, side: 'YES' | 'NO') =>
      lp.variables.filter((v) => v.marketId === mid && v.side === side)
        .reduce((s, v) => s + (res.values[v.index] ?? 0), 0);

    expect(filled(10, 'YES')).toBeCloseTo(250, 3);
    expect(filled(11, 'NO')).toBeCloseTo(250, 3);

    const yesL2 = lp.variables.find((v) => v.marketId === 10 && v.side === 'YES' && Math.abs(v.askPrice - 0.55) < 1e-9)!;
    expect(res.values[yesL2.index] ?? 0).toBeLessThan(1e-6);
    const noL2 = lp.variables.find((v) => v.marketId === 11 && v.side === 'NO' && Math.abs(v.askPrice - 0.60) < 1e-9)!;
    expect(res.values[noL2.index] ?? 0).toBeLessThan(1e-6);

    const g = res.values[lp.guaranteedPayoutVarIndex!] ?? 0;
    expect(g).toBeCloseTo(250, 3);
    expect(-res.optimalCost).toBeCloseTo(31.5, 2);
  });

  test('LP does NOT over-buy a cheap leg beyond what the hedge can match (no naked exposure profit)', async () => {
    const c = hedgeCluster(10, 11);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.09, 0.10, [[0.10, 100000], [0.11, 100000]], [[0.09, 100]]));
    pc.update(yesLadderUpd(11, 0.70, 0.75, [[0.75, 100]], [[0.70, 50], [0.45, 100000]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const filledYes = lp.variables.filter((v) => v.marketId === 10 && v.side === 'YES')
      .reduce((s, v) => s + (res.values[v.index] ?? 0), 0);
    const filledNo = lp.variables.filter((v) => v.marketId === 11 && v.side === 'NO')
      .reduce((s, v) => s + (res.values[v.index] ?? 0), 0);
    const g = res.values[lp.guaranteedPayoutVarIndex!] ?? 0;
    expect(g).toBeCloseTo(Math.min(filledYes, filledNo), 3);
    const port = extractPortfolio(res, lp, c, pc, 0);
    if (port) {
      expect(port.profit).toBeLessThanOrEqual(port.guaranteedPayout + 1e-6);
      expect(port.worstEnumeratedStatePayout).toBeCloseTo(g, 3);
    }
  });
});

describe('ADVERSARIAL: profit-max never reports more than the brute-force worst-state profit', () => {
  test('cross-check solved profit vs an independent worst-state evaluation', async () => {
    const c = hedgeCluster(10, 11);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.34, 0.35, [[0.35, 80], [0.38, 120], [0.60, 90]], [[0.34, 100]]));
    pc.update(yesLadderUpd(11, 0.60, 0.64, [[0.64, 100]], [[0.60, 110], [0.57, 90], [0.30, 90]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const reportedProfit = -res.optimalCost;

    let worst = Infinity;
    let cost = 0;
    for (const v of lp.variables) {
      if (v.index === lp.guaranteedPayoutVarIndex) continue;
      const sh = res.values[v.index] ?? 0;
      cost += sh * (v.askPrice + (v.feePerShare ?? 0));
    }
    for (const st of c.validStates) {
      let payout = 0;
      for (const v of lp.variables) {
        if (v.index === lp.guaranteedPayoutVarIndex) continue;
        const sh = res.values[v.index] ?? 0;
        const yes = st.get(1) ?? false;
        if ((v.side === 'YES' && yes) || (v.side === 'NO' && !yes)) payout += sh;
      }
      worst = Math.min(worst, payout);
    }
    const trueWorstProfit = worst - cost;
    expect(reportedProfit).toBeLessThanOrEqual(trueWorstProfit + 1e-4);
    expect(reportedProfit).toBeCloseTo(trueWorstProfit, 3);
  });
});

describe('ADVERSARIAL: categorical (mutex) profit-max stays sound', () => {
  function categoricalCluster(): Cluster {
    const mk = (qid: number, mid: number): [number, QuestionNode] => [
      qid,
      {
        questionId: qid, canonicalSubject: `s${qid}`, conditionShape: null,
        conditionValue: null, conditionDate: null,
        markets: new Map<number, MarketRef>([[mid, { marketId: mid, platform: 'polymarket', platformId: `pid-${mid}` }]]),
      },
    ];
    return {
      id: 1,
      questions: new Map([mk(1, 10), mk(2, 20), mk(3, 30)]),
      outcomeSets: [], edges: [],
      marketIds: new Set([10, 20, 30]),
      validStates: [
        new Map([[1, true], [2, false], [3, false]]),
        new Map([[1, false], [2, true], [3, false]]),
        new Map([[1, false], [2, false], [3, true]]),
      ],
      dirty: false,
    };
  }

  test('buying all three YES legs: G = worst one-hot payout, profit measured against it', async () => {
    const c = categoricalCluster();
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.29, 0.30, [[0.30, 100], [0.31, 100]], [[0.29, 100]]));
    pc.update(yesLadderUpd(20, 0.29, 0.30, [[0.30, 100], [0.31, 100]], [[0.29, 100]]));
    pc.update(yesLadderUpd(30, 0.34, 0.35, [[0.35, 100], [0.36, 100]], [[0.34, 100]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    expect(lp.guaranteedPayoutVarIndex).toBeDefined();
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const g = res.values[lp.guaranteedPayoutVarIndex!] ?? 0;

    let worst = Infinity;
    for (const st of c.validStates) {
      let payout = 0;
      for (const v of lp.variables) {
        if (v.index === lp.guaranteedPayoutVarIndex) continue;
        const sh = res.values[v.index] ?? 0;
        let qid = 0;
        for (const [, q] of c.questions) if (q.markets.has(v.marketId)) { qid = q.questionId; break; }
        const yes = st.get(qid) ?? false;
        if ((v.side === 'YES' && yes) || (v.side === 'NO' && !yes)) payout += sh;
      }
      worst = Math.min(worst, payout);
    }
    expect(g).toBeCloseTo(worst, 4);
    const port = extractPortfolio(res, lp, c, pc, 0);
    if (port) {
      expect(port.worstEnumeratedStatePayout).toBeCloseTo(g, 4);
      expect(port.profit).toBeLessThanOrEqual(port.guaranteedPayout - port.totalCost + 1e-4);
    }
  });
});

describe('ADVERSARIAL: degenerate single-state cluster (1 world) cannot fabricate profit', () => {
  test('single state where only YES pays: profit-max still constrains G to that state', async () => {
    const q: QuestionNode = {
      questionId: 1, canonicalSubject: 's1', conditionShape: null,
      conditionValue: null, conditionDate: null,
      markets: new Map<number, MarketRef>([[10, { marketId: 10, platform: 'polymarket', platformId: 'pid-10' }]]),
    };
    const c: Cluster = {
      id: 1, questions: new Map([[1, q]]), outcomeSets: [], edges: [],
      marketIds: new Set([10]),
      validStates: [new Map([[1, true]])],
      dirty: false,
    };
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.20, 0.25, [[0.25, 100], [0.26, 100]], [[0.20, 100]]));
    const lp = buildLP(c, pc, DEPTH, true, true)!;
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    const g = res.values[lp.guaranteedPayoutVarIndex!] ?? 0;
    const yesShares = lp.variables.filter((v) => v.marketId === 10 && v.side === 'YES')
      .reduce((s, v) => s + (res.values[v.index] ?? 0), 0);
    expect(g).toBeLessThanOrEqual(yesShares + 1e-6); // G can't exceed shares that pay
  });
});

describe('ADVERSARIAL: flag-OFF construction is identical to the prior min-cost LP', () => {
  test('no G var, RHS=1 per state, one var per leg, objective = ask(+0 fee)', () => {
    const c = hedgeCluster(10, 11);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.44, 0.45, [[0.45, 100], [0.46, 200]], [[0.44, 100], [0.43, 80]]));
    pc.update(yesLadderUpd(11, 0.55, 0.60, [[0.60, 100]], [[0.55, 100], [0.50, 80]]));
    const lp = buildLP(c, pc, NO_EXECUTION_GATE, false, /* ladder OFF */ false)!;
    expect(lp.guaranteedPayoutVarIndex).toBeUndefined();
    expect(lp.rhs.every((r) => r === 1)).toBe(true);
    expect(lp.variables).toHaveLength(4);
    expect(lp.variables.every((v) => v.level === undefined)).toBe(true);
    expect(lp.numVars).toBe(4);
  });

  test('ladder ON but every leg single-level ⟹ STILL min-cost form (anyTranched false)', () => {
    const c = hedgeCluster(10, 11);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.44, 0.45, [[0.45, 100]], [[0.44, 100]]));
    pc.update(yesLadderUpd(11, 0.55, 0.60, [[0.60, 100]], [[0.55, 100]]));
    const lp = buildLP(c, pc, DEPTH, true, /* ladder */ true)!;
    expect(lp.guaranteedPayoutVarIndex).toBeUndefined();
    expect(lp.rhs.every((r) => r === 1)).toBe(true);
  });
});
