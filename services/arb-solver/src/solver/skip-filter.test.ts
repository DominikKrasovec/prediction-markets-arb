import { describe, test, expect } from 'bun:test';
import highsLoader from 'highs';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode } from '../graph/types.js';
import { PriceCache, type PriceUpdate } from '../clob/price-cache.js';
import { buildLP } from './lp-builder.js';
import { buildLPString, parseHighsResult } from './lp-string.js';
import type { ExecutionParams, LPProblem, LPResult } from './types.js';
import {
  buildCert,
  colStatesOf,
  decideSkip,
  dualLowerBound,
  lpIsProfitMax,
  structKey,
  type ClusterDualCert,
} from './skip-filter.js';

// Sound dual-skip filter tests: (1) no-missed-arb equivalence over LP sequences
// vs. always-full-solve ground truth; (2) direct dualLowerBound/decideSkip/
// structKey soundness unit tests.

const DEPTH_CAP: ExecutionParams = { enforceFees: false, enforceDepthCap: true };
const NO_FEE_NO_CAP: ExecutionParams = { enforceFees: false, enforceDepthCap: false };
const THETA = 0.99; // 1 − minProfit (default minProfit = 0.01)
const EPS = 1e-7;

const highs = await (highsLoader as unknown as (o?: unknown) => Promise<{
  solve(lp: string): { Status: string; ObjectiveValue?: number; Columns?: Record<string, { Primal?: number }>; Rows?: Array<{ Index?: number; Name?: string; Dual?: number }> };
}>)();

// Full dual-returning solve via the production parser — the path the worker pool uses when SOLVE_SKIP_FILTER=1.
function solveDual(lp: LPProblem): LPResult {
  const raw = highs.solve(buildLPString(lp));
  return parseHighsResult(raw, lp.numVars, true, lp.constraints.length);
}

function twoQuestionCluster(): Cluster {
  const mk = (id: number, platform: Platform): MarketRef => ({ marketId: id, platform, platformId: `pid-${id}` });
  const q1: QuestionNode = {
    questionId: 1, canonicalSubject: 's1', conditionShape: null, conditionValue: null, conditionDate: null,
    markets: new Map([[10, mk(10, 'polymarket')], [11, mk(11, 'kalshi')]]),
  };
  const q2: QuestionNode = {
    questionId: 2, canonicalSubject: 's2', conditionShape: null, conditionValue: null, conditionDate: null,
    markets: new Map([[20, mk(20, 'polymarket')], [21, mk(21, 'kalshi')]]),
  };
  return {
    id: 1,
    questions: new Map([[1, q1], [2, q2]]),
    outcomeSets: [], edges: [],
    marketIds: new Set([10, 11, 20, 21]),
    validStates: [
      new Map([[1, true], [2, true]]),
      new Map([[1, true], [2, false]]),
      new Map([[1, false], [2, true]]),
      new Map([[1, false], [2, false]]),
    ],
    dirty: false,
  };
}

function oneQuestionCluster(): Cluster {
  const mk = (id: number, platform: Platform): MarketRef => ({ marketId: id, platform, platformId: `pid-${id}` });
  const q: QuestionNode = {
    questionId: 1, canonicalSubject: 's1', conditionShape: null, conditionValue: null, conditionDate: null,
    markets: new Map([[10, mk(10, 'polymarket')], [11, mk(11, 'kalshi')]]),
  };
  return {
    id: 1, questions: new Map([[1, q]]), outcomeSets: [], edges: [],
    marketIds: new Set([10, 11]),
    validStates: [new Map([[1, true]]), new Map([[1, false]])],
    dirty: false,
  };
}

const yesUpd = (
  marketId: number, platform: Platform, bestBid: number, bestAsk: number, ts = Date.now(), size = 100,
): PriceUpdate => ({
  marketId, platform, bestBid, bestAsk, bidSize: size, askSize: size, timestamp: ts,
});

describe('skip-filter: no-missed-arb equivalence (filtered vs always-solve)', () => {
  // Replays a price-tick sequence two ways (always full-solve vs filtered) and
  // returns the miss count (filtered skipped but ground truth was an arb) and mismatch count.
  function replay(
    cluster: Cluster,
    ticks: Array<() => PriceUpdate[] | void>,
    exec: ExecutionParams,
  ): { misses: number; mismatches: number; ticks: number; skips: number; arbsGroundTruth: number } {
    const pcAlways = new PriceCache();
    const pcFiltered = new PriceCache();
    let cert: ClusterDualCert | undefined;
    let misses = 0, mismatches = 0, skips = 0, arbsGroundTruth = 0, evaluated = 0;

    for (const tick of ticks) {
      const updates = tick() ?? [];
      for (const u of updates) { pcAlways.update(u); pcFiltered.update({ ...u }); }

      const lpA = buildLP(cluster, pcAlways, exec);
      if (!lpA) continue;
      const truth = solveDual(lpA);
      const truthArb = truth.status === 'Optimal' && truth.optimalCost <= THETA;
      if (truthArb) arbsGroundTruth++;

      const lpF = buildLP(cluster, pcFiltered, exec)!;
      evaluated++;
      const decision = decideSkip(cert, lpF, THETA);
      let filteredArb: boolean;
      if (decision.skip) {
        skips++;
        filteredArb = false;
        if (truthArb) misses++; // soundness violation
      } else {
        const res = solveDual(lpF);
        filteredArb = res.status === 'Optimal' && res.optimalCost <= THETA;
        if (res.status === 'Optimal' && truth.status === 'Optimal') {
          expect(res.optimalCost).toBeCloseTo(truth.optimalCost, 9);
        }
        const c = buildCert(lpF, res);
        if (c) cert = c; else cert = undefined;
      }
      if (filteredArb !== truthArb) mismatches++;
    }
    return { misses, mismatches, ticks: evaluated, skips, arbsGroundTruth };
  }

  test('1-question cross-platform: arb appears, persists, then disappears (incl. price DROP)', () => {
    const c = oneQuestionCluster();
    const ticks: Array<() => PriceUpdate[]> = [
      () => [yesUpd(10, 'polymarket', 0.40, 0.58), yesUpd(11, 'kalshi', 0.42, 0.60)],
      () => [yesUpd(10, 'polymarket', 0.40, 0.60), yesUpd(11, 'kalshi', 0.41, 0.62)],
      () => [yesUpd(10, 'polymarket', 0.28, 0.30), yesUpd(11, 'kalshi', 0.80, 0.95)],
      () => [yesUpd(10, 'polymarket', 0.22, 0.25), yesUpd(11, 'kalshi', 0.82, 0.97)],
      () => [yesUpd(10, 'polymarket', 0.38, 0.66), yesUpd(11, 'kalshi', 0.40, 0.70)],
    ];
    const r = replay(c, ticks, DEPTH_CAP);
    expect(r.misses).toBe(0);
    expect(r.mismatches).toBe(0);
    expect(r.arbsGroundTruth).toBeGreaterThan(0);
  });

  const WALK_IDS: Array<[number, Platform]> = [[10, 'polymarket'], [11, 'kalshi'], [20, 'polymarket'], [21, 'kalshi']];

  // Spread kept under the 0.50 width gate (else a leg would be structurally
  // suppressed, not just repriced); a short all-rising ramp first guarantees the
  // filter is actually exercised regardless of the random tail.
  function randomWalkTicks(seed0: number, n: number): Array<() => PriceUpdate[]> {
    let seed = seed0;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const px = () => 0.10 + rnd() * 0.80;
    const ticks: Array<() => PriceUpdate[]> = [];
    for (let t = 0; t < 6; t++) {
      const ask = 0.30 + t * 0.05;
      const bid = 0.25 - t * 0.03;
      const ups = WALK_IDS.map(([id, plat]) => yesUpd(id, plat, Math.max(0.01, bid), ask, Date.now(), 2));
      ticks.push(() => ups.map((u) => ({ ...u })));
    }
    for (let t = 0; t < n; t++) {
      const ups: PriceUpdate[] = WALK_IDS.map(([id, plat]) => {
        const ask = px();
        const bid = Math.max(0.01, ask - (0.04 + rnd() * 0.16));
        return yesUpd(id, plat, bid, ask, Date.now(), 2);
      });
      ticks.push(() => ups.map((u) => ({ ...u })));
    }
    return ticks;
  }

  test('2-question cluster: random walk incl. drops, no missed arb (depth caps ON)', () => {
    const c = twoQuestionCluster();
    const r = replay(c, randomWalkTicks(99887766, 80), DEPTH_CAP);
    expect(r.misses).toBe(0);
    expect(r.mismatches).toBe(0);
    expect(r.skips).toBeGreaterThan(0);
    expect(r.arbsGroundTruth).toBeGreaterThan(0);
  });

  test('2-question cluster: random walk, depth caps OFF (uncapped legs)', () => {
    const c = twoQuestionCluster();
    const r = replay(c, randomWalkTicks(13572468, 80), NO_FEE_NO_CAP);
    expect(r.misses).toBe(0);
    expect(r.mismatches).toBe(0);
  });

  test('topology change mid-sequence forces full-solve (no stale-cert miss)', () => {
    const c = twoQuestionCluster();
    const ticks: Array<() => PriceUpdate[]> = [
      () => [
        yesUpd(10, 'polymarket', 0.42, 0.58), yesUpd(11, 'kalshi', 0.42, 0.58),
        yesUpd(20, 'polymarket', 0.42, 0.58), yesUpd(21, 'kalshi', 0.42, 0.58),
      ],
      () => {
        c.questions.get(2)!.markets.delete(21);
        c.marketIds.delete(21);
        return [
          yesUpd(10, 'polymarket', 0.30, 0.32), yesUpd(11, 'kalshi', 0.66, 0.70),
          yesUpd(20, 'polymarket', 0.30, 0.32),
        ];
      },
    ];
    const r = replay(c, ticks, DEPTH_CAP);
    expect(r.misses).toBe(0);
    expect(r.mismatches).toBe(0);
  });
});

describe('skip-filter: dualLowerBound + decideSkip soundness', () => {
  function seedCert(pc: PriceCache, c: Cluster, exec: ExecutionParams): { cert: ClusterDualCert; lp: LPProblem; cost: number } {
    const lp = buildLP(c, pc, exec)!;
    const res = solveDual(lp);
    expect(res.status).toBe('Optimal');
    const cert = buildCert(lp, res)!;
    expect(cert).not.toBeNull();
    return { cert, lp, cost: res.optimalCost };
  }

  test('LOAD-BEARING: a price drop that flips optimalCost below θ is NEVER skipped', () => {
    const c = oneQuestionCluster();
    const pc = new PriceCache();
    pc.update(yesUpd(10, 'polymarket', 0.42, 0.58));
    pc.update(yesUpd(11, 'kalshi', 0.41, 0.60));
    const { cert, cost } = seedCert(pc, c, DEPTH_CAP);
    expect(cost).toBeGreaterThan(THETA);

    pc.update(yesUpd(10, 'polymarket', 0.28, 0.30));
    pc.update(yesUpd(11, 'kalshi', 0.80, 0.95));
    const lpDrop = buildLP(c, pc, DEPTH_CAP)!;
    const truth = solveDual(lpDrop);
    expect(truth.optimalCost).toBeLessThanOrEqual(THETA);

    const decision = decideSkip(cert, lpDrop, THETA);
    expect(decision.skip).toBe(false);
    const { L, valid } = dualLowerBound(cert, lpDrop);
    if (valid) expect(L).toBeLessThanOrEqual(truth.optimalCost + 1e-9);
  });

  test('prices unchanged from a no-arb solve ⟹ SKIP (L = optimalCost ≥ θ)', () => {
    const c = oneQuestionCluster();
    const pc = new PriceCache();
    pc.update(yesUpd(10, 'polymarket', 0.42, 0.58));
    pc.update(yesUpd(11, 'kalshi', 0.41, 0.60));
    const { cert, lp, cost } = seedCert(pc, c, DEPTH_CAP);
    const { L, valid } = dualLowerBound(cert, lp);
    expect(valid).toBe(true);
    expect(L).toBeCloseTo(cost, 9);
    expect(decideSkip(cert, lp, THETA).skip).toBe(true);
  });

  test('prices rising (all asks up) ⟹ still no arb ⟹ SKIP', () => {
    const c = oneQuestionCluster();
    const pc = new PriceCache();
    pc.update(yesUpd(10, 'polymarket', 0.42, 0.58));
    pc.update(yesUpd(11, 'kalshi', 0.41, 0.60));
    const { cert } = seedCert(pc, c, DEPTH_CAP);
    pc.update(yesUpd(10, 'polymarket', 0.34, 0.66));
    pc.update(yesUpd(11, 'kalshi', 0.32, 0.68));
    const lpUp = buildLP(c, pc, DEPTH_CAP)!;
    const truth = solveDual(lpUp);
    expect(truth.optimalCost).toBeGreaterThan(THETA);
    const { L, valid } = dualLowerBound(cert, lpUp);
    expect(valid).toBe(true);
    expect(L).toBeLessThanOrEqual(truth.optimalCost + 1e-9);
    expect(decideSkip(cert, lpUp, THETA).skip).toBe(true);
  });

  test('decideSkip fails safe: no cert ⟹ full-solve', () => {
    const c = oneQuestionCluster();
    const pc = new PriceCache();
    pc.update(yesUpd(10, 'polymarket', 0.30, 0.32));
    pc.update(yesUpd(11, 'kalshi', 0.66, 0.70));
    const lp = buildLP(c, pc, DEPTH_CAP)!;
    const d = decideSkip(undefined, lp, THETA);
    expect(d.skip).toBe(false);
    expect(d.reason).toBe('no-cert');
  });

  test('decideSkip fails safe: structural change ⟹ full-solve', () => {
    const c = oneQuestionCluster();
    const pc = new PriceCache();
    pc.update(yesUpd(10, 'polymarket', 0.55, 0.58));
    pc.update(yesUpd(11, 'kalshi', 0.45, 0.50));
    const { cert } = seedCert(pc, c, DEPTH_CAP);
    c.questions.get(1)!.markets.delete(11);
    c.marketIds.delete(11);
    pc.update(yesUpd(10, 'polymarket', 0.30, 0.32));
    const lp2 = buildLP(c, pc, DEPTH_CAP)!;
    const d = decideSkip(cert, lp2, THETA);
    expect(d.skip).toBe(false);
    expect(d.reason).toBe('struct-changed');
  });

  test('decideSkip fails safe: never skip the profit-max ladder form', () => {
    const c = oneQuestionCluster();
    const pc = new PriceCache();
    pc.update({
      marketId: 10, platform: 'polymarket', bestBid: 0.40, bestAsk: 0.45,
      bidSize: 100, askSize: 100, timestamp: Date.now(),
      askLevels: [[0.45, 100], [0.47, 100], [0.50, 100]], bidLevels: [[0.40, 100]],
    });
    pc.update({
      marketId: 11, platform: 'kalshi', bestBid: 0.52, bestAsk: 0.58,
      bidSize: 100, askSize: 100, timestamp: Date.now(),
      askLevels: [[0.58, 100]], bidLevels: [[0.52, 100], [0.49, 100], [0.45, 100]],
    });
    const lp = buildLP(c, pc, DEPTH_CAP, true, true)!;
    expect(lpIsProfitMax(lp)).toBe(true);
    const res = solveDual(lp);
    expect(buildCert(lp, res)).toBeNull();
    const fakeCert: ClusterDualCert = {
      structKey: structKey(lp), optimalCost: 0.5, sumRowDual: 5, rowDual: [5, 5],
      colStates: colStatesOf(lp), profitMax: false,
    };
    expect(decideSkip(fakeCert, lp, THETA).reason).toBe('profit-max');
  });

  test('dualLowerBound is invalid when a column needing a bound-dual is UNCAPPED', () => {
    const lpNew: LPProblem = {
      numVars: 2,
      objective: [0.10, 0.10],
      constraints: [[1, 0], [0, 1]],
      rhs: [1, 1],
      variables: [
        { index: 0, marketId: 1, platform: 'polymarket', side: 'YES', askPrice: 0.10, feePerShare: 0, maxShares: null },
        { index: 1, marketId: 2, platform: 'polymarket', side: 'YES', askPrice: 0.10, feePerShare: 0, maxShares: null },
      ],
      clusterId: 1,
    };
    const cert: ClusterDualCert = {
      structKey: structKey(lpNew), optimalCost: 1.0, sumRowDual: 1.0, rowDual: [0.5, 0.5],
      colStates: colStatesOf(lpNew), profitMax: false,
    };
    const { valid } = dualLowerBound(cert, lpNew);
    expect(valid).toBe(false);
    expect(decideSkip(cert, lpNew, THETA).reason).toBe('cert-invalid');
  });

  test('dualLowerBound binds the cap: finite cap ⟹ valid bound that matches the capped optimum', () => {
    const lpCapped: LPProblem = {
      numVars: 4,
      objective: [0.45, 0.56, 0.42, 0.6],
      constraints: [[1, 0, 1, 0], [0, 1, 0, 1]],
      rhs: [1, 1],
      variables: [
        { index: 0, marketId: 1, platform: 'polymarket', side: 'YES', askPrice: 0.45, feePerShare: 0, maxShares: null },
        { index: 1, marketId: 1, platform: 'polymarket', side: 'NO', askPrice: 0.56, feePerShare: 0, maxShares: null },
        { index: 2, marketId: 2, platform: 'polymarket', side: 'YES', askPrice: 0.42, feePerShare: 0, maxShares: 0.5 },
        { index: 3, marketId: 2, platform: 'polymarket', side: 'NO', askPrice: 0.6, feePerShare: 0, maxShares: null },
      ],
      clusterId: 1,
    };
    const cert: ClusterDualCert = {
      structKey: structKey(lpCapped), optimalCost: 1.01, sumRowDual: 1.01, rowDual: [0.45, 0.56],
      colStates: colStatesOf(lpCapped), profitMax: false,
    };
    const { L, valid } = dualLowerBound(cert, lpCapped);
    expect(valid).toBe(true);
    expect(L).toBeCloseTo(1.01 - 0.015, 9);
    const truth = solveDual(lpCapped);
    expect(truth.optimalCost).toBeGreaterThanOrEqual(L - 1e-9);
    expect(truth.optimalCost).toBeCloseTo(0.995, 6);
  });

  test('structKey: stable across pure price moves, changes on variable-set change', () => {
    const c = oneQuestionCluster();
    const pc = new PriceCache();
    pc.update(yesUpd(10, 'polymarket', 0.55, 0.58));
    pc.update(yesUpd(11, 'kalshi', 0.45, 0.50));
    const k1 = structKey(buildLP(c, pc, DEPTH_CAP)!);
    pc.update(yesUpd(10, 'polymarket', 0.20, 0.25));
    pc.update(yesUpd(11, 'kalshi', 0.70, 0.80));
    const k2 = structKey(buildLP(c, pc, DEPTH_CAP)!);
    expect(k2).toBe(k1);
    c.questions.get(1)!.markets.delete(11);
    c.marketIds.delete(11);
    const k3 = structKey(buildLP(c, pc, DEPTH_CAP)!);
    expect(k3).not.toBe(k1);
  });

  test('buildCert returns null on non-Optimal results and when duals are absent', () => {
    const c = oneQuestionCluster();
    const pc = new PriceCache();
    pc.update(yesUpd(10, 'polymarket', 0.55, 0.58));
    pc.update(yesUpd(11, 'kalshi', 0.45, 0.50));
    const lp = buildLP(c, pc, DEPTH_CAP)!;
    expect(buildCert(lp, { status: 'Infeasible', optimalCost: Infinity, values: [], solveTimeMs: 0 })).toBeNull();
    expect(buildCert(lp, { status: 'Optimal', optimalCost: 1.05, values: [0, 0, 0, 0], solveTimeMs: 0 })).toBeNull();
  });
});
