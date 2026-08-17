import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode } from '../graph/types.js';
import { PriceCache, type PriceUpdate } from '../clob/price-cache.js';
import { buildLP } from './lp-builder.js';
import { solveLP } from './solver.js';
import { buildLPString, parseHighsResult, type RawHighsResult } from './lp-string.js';
import type { LPProblem } from './types.js';

/**
 * Pins the extracted `buildLPString` to its PRE-REFACTOR byte output (the LP
 * string HiGHS parses) for both an execution-gated / non-ladder min-cost-$1 problem and a
 * DEPTH-AWARE ladder profit-max problem (gIndex set, per-leg maxShares, negative
 * G coefficient). If a refactor ever changes a byte here, the bytes HiGHS sees
 * change too — that is the whole risk the worker-pool split must not introduce.
 *
 * `parseHighsResult` is pinned against the MINIMAL slimmed shape the worker
 * replies with (`{Status,ObjectiveValue,Columns:{name:{Primal}}}`), proving the
 * coordinator parses a worker reply exactly as it parses an in-process result.
 */

// Hand-built LPProblems whose exact rendering is asserted below

/** Non-ladder min-cost-$1: 2 markets on 1 question (YES10,NO10,YES11,NO11),
 *  two depth-capped legs + two uncapped. */
const NON_LADDER_LP: LPProblem = {
  numVars: 4,
  objective: [0.45, 0.56, 0.42, 0.6],
  constraints: [
    [1, 0, 1, 0],
    [0, 1, 0, 1],
  ],
  rhs: [1, 1],
  variables: [
    { index: 0, marketId: 10, platform: 'polymarket', side: 'YES', askPrice: 0.45, feePerShare: 0, maxShares: 100 },
    { index: 1, marketId: 10, platform: 'polymarket', side: 'NO', askPrice: 0.56, feePerShare: 0, maxShares: null },
    { index: 2, marketId: 11, platform: 'polymarket', side: 'YES', askPrice: 0.42, feePerShare: 0, maxShares: 70 },
    { index: 3, marketId: 11, platform: 'polymarket', side: 'NO', askPrice: 0.6, feePerShare: 0, maxShares: null },
  ],
  clusterId: 1,
};

const NON_LADDER_EXPECTED =
  'Minimize\n' +
  '  obj: 0.45 x0 + 0.56 x1 + 0.42 x2 + 0.6 x3\n' +
  'Subject To\n' +
  '  s0: 1 x0 + 1 x2 >= 1\n' +
  '  s1: 1 x1 + 1 x3 >= 1\n' +
  'Bounds\n' +
  '  0 <= x0 <= 100\n' +
  '  x1 >= 0\n' +
  '  0 <= x2 <= 70\n' +
  '  x3 >= 0\n' +
  'End';

/** DEPTH-AWARE ladder profit-max: 2 YES tranches + 1 NO tranche + guaranteed-payout
 *  var G (index 3, uncapped). Each state row is `payout − G >= 0` (rhs 0); the
 *  objective minimizes `Σ(price+fee)·x − G`. Note the negative G coefficient
 *  renders as `+ -1 x3` and the `-1 x3` term in each constraint. */
const LADDER_LP: LPProblem = {
  numVars: 4,
  objective: [0.45, 0.46, 0.42, -1],
  constraints: [
    [1, 1, 0, -1],
    [0, 0, 1, -1],
  ],
  rhs: [0, 0],
  variables: [
    { index: 0, marketId: 10, platform: 'polymarket', side: 'YES', askPrice: 0.45, feePerShare: 0, maxShares: 100, level: 0 },
    { index: 1, marketId: 10, platform: 'polymarket', side: 'YES', askPrice: 0.46, feePerShare: 0, maxShares: 200, level: 1 },
    { index: 2, marketId: 11, platform: 'polymarket', side: 'NO', askPrice: 0.42, feePerShare: 0, maxShares: 70, level: 0 },
    { index: 3, marketId: -1, platform: 'polymarket', side: 'YES', askPrice: 0, feePerShare: 0, maxShares: null },
  ],
  clusterId: 1,
  guaranteedPayoutVarIndex: 3,
};

const LADDER_EXPECTED =
  'Minimize\n' +
  '  obj: 0.45 x0 + 0.46 x1 + 0.42 x2 + -1 x3\n' +
  'Subject To\n' +
  '  s0: 1 x0 + 1 x1 + -1 x3 >= 0\n' +
  '  s1: 1 x2 + -1 x3 >= 0\n' +
  'Bounds\n' +
  '  0 <= x0 <= 100\n' +
  '  0 <= x1 <= 200\n' +
  '  0 <= x2 <= 70\n' +
  '  x3 >= 0\n' +
  'End';

describe('buildLPString byte-identical (pre-refactor pin)', () => {
  test('non-ladder min-cost-$1 LPProblem renders EXACTLY the legacy string', () => {
    expect(buildLPString(NON_LADDER_LP)).toBe(NON_LADDER_EXPECTED);
  });

  test('ladder profit-max LPProblem (gIndex, per-leg maxShares, −1 G) renders EXACTLY', () => {
    expect(buildLPString(LADDER_LP)).toBe(LADDER_EXPECTED);
  });

  test('zero-objective edge case renders "obj: 0"', () => {
    const lp: LPProblem = {
      numVars: 1,
      objective: [0],
      constraints: [[1]],
      rhs: [1],
      variables: [{ index: 0, marketId: 1, platform: 'polymarket', side: 'YES', askPrice: 0, feePerShare: 0, maxShares: null }],
      clusterId: 1,
    };
    expect(buildLPString(lp)).toBe('Minimize\n  obj: 0\nSubject To\n  s0: 1 x0 >= 1\nBounds\n  x0 >= 0\nEnd');
  });
});

describe('buildLPString matches real buildLP output through the solver', () => {
  // A real cluster rendered by buildLP must round-trip the same whether we render
  // it here or inside solveLP — i.e. the string the coordinator ships to a worker
  // is the same string solveLP would have built in-process.
  function binaryCluster(marketIds: number[], platform: Platform = 'polymarket'): Cluster {
    const markets = new Map<number, MarketRef>();
    for (const id of marketIds) markets.set(id, { marketId: id, platform, platformId: `pid-${id}` });
    const q: QuestionNode = {
      questionId: 1, canonicalSubject: 's1', conditionShape: null,
      conditionValue: null, conditionDate: null, markets,
    };
    return {
      id: 1, questions: new Map([[1, q]]), outcomeSets: [], edges: [],
      marketIds: new Set(marketIds),
      validStates: [new Map([[1, true]]), new Map([[1, false]])],
      dirty: false,
    };
  }
  const yesLadderUpd = (
    marketId: number, bestBid: number, bestAsk: number,
    askLevels: Array<[number, number]>, bidLevels: Array<[number, number]>,
  ): PriceUpdate => ({
    marketId, platform: 'polymarket', bestBid, bestAsk,
    bidSize: bidLevels[0]?.[1] ?? 0, askSize: askLevels[0]?.[1] ?? 0,
    timestamp: Date.now(), askLevels, bidLevels,
  });

  test('a real ladder LP renders deterministically and the parsed solve matches solveLP', async () => {
    const c = binaryCluster([10, 11]);
    c.questions.get(1)!.markets.set(11, { marketId: 11, platform: 'polymarket', platformId: 'pid-11' });
    c.marketIds = new Set([10, 11]);
    const pc = new PriceCache();
    pc.update(yesLadderUpd(10, 0.40, 0.45, [[0.45, 100], [0.47, 100], [0.50, 100]], [[0.40, 100]]));
    pc.update(yesLadderUpd(11, 0.58, 0.62, [[0.62, 100]], [[0.58, 100], [0.55, 100], [0.49, 100]]));
    const lp = buildLP(c, pc, { enforceFees: false, enforceDepthCap: true }, true, true)!;

    // Rendering is a pure function of the LPProblem: two calls are byte-equal.
    const s1 = buildLPString(lp);
    const s2 = buildLPString(lp);
    expect(s1).toBe(s2);
    expect(lp.guaranteedPayoutVarIndex).toBeDefined();

    // And solveLP (which renders internally with the SAME helper) agrees.
    const res = await solveLP(lp);
    expect(res.status).toBe('Optimal');
    expect(res.optimalCost).toBeCloseTo(-21, 4);
  });
});

describe('parseHighsResult on the worker-slimmed shape', () => {
  test('Optimal: maps x-named Columns→values[] by digit index, ObjectiveValue→optimalCost', () => {
    const raw: RawHighsResult = {
      Status: 'Optimal',
      ObjectiveValue: 0.87,
      Columns: { x0: { Primal: 2 }, x2: { Primal: 3 }, x1: { Primal: 0 } },
    };
    const r = parseHighsResult(raw, 4);
    expect(r.status).toBe('Optimal');
    expect(r.optimalCost).toBeCloseTo(0.87, 9);
    expect(r.values).toEqual([2, 0, 3, 0]); // x3 absent ⟹ 0; x1 explicit 0
    expect(r.solveTimeMs).toBe(0); // caller stamps the real wall-clock
  });

  test('out-of-range / non-numeric column names are ignored', () => {
    const raw: RawHighsResult = {
      Status: 'Optimal',
      ObjectiveValue: 1,
      Columns: { x9: { Primal: 5 }, foo: { Primal: 7 } },
    };
    const r = parseHighsResult(raw, 2);
    expect(r.values).toEqual([0, 0]); // x9 >= numVars; "foo" → NaN
  });

  test('missing Primal defaults to 0', () => {
    const r = parseHighsResult({ Status: 'Optimal', ObjectiveValue: 0, Columns: { x0: {} } }, 1);
    expect(r.values).toEqual([0]);
  });

  test('Infeasible → Infeasible, Infinity cost, empty values', () => {
    const r = parseHighsResult({ Status: 'Infeasible' }, 3);
    expect(r.status).toBe('Infeasible');
    expect(r.optimalCost).toBe(Infinity);
    expect(r.values).toEqual([]);
  });

  test('any other status → Error', () => {
    expect(parseHighsResult({ Status: 'Unbounded' }, 1).status).toBe('Error');
    expect(parseHighsResult({ Status: 'Primal infeasible or unbounded' }, 1).status).toBe('Error');
  });

  test('Optimal but missing ObjectiveValue → Infinity cost', () => {
    const r = parseHighsResult({ Status: 'Optimal', Columns: { x0: { Primal: 1 } } }, 1);
    expect(r.optimalCost).toBe(Infinity);
    expect(r.values).toEqual([1]);
  });
});
