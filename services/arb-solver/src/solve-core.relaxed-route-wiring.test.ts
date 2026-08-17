/**
 * Relaxed-facet route wiring: finalizeClusters relaxed-setting matrix,
 * prepareClusterForSolve (relaxed × engine), applyLivenessDemotion no-op, buildForEngine,
 * buildLP/skip-filter facet-form guards, and the relaxed-solve census.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, ConstraintGraph, QuestionNode, MarketRef, OutcomeSetRef, EdgeRef } from './graph/types.js';
import type { LPProblem, LPResult } from './solver/types.js';
import { config } from './config.js';
import { PriceCache } from './clob/price-cache.js';
import { getHiGHS } from './solver/facet-lp.js';
import { buildLP } from './solver/lp-builder.js';
import { buildCert, decideSkip } from './solver/skip-filter.js';
import {
  finalizeClusters,
  buildForEngine,
  applyLivenessDemotion,
  prepareClusterForSolve,
  relaxedSolvePreparedCensus,
  resetRelaxedSolvePreparedCensus,
} from './solve-core.js';

const PLAT: Platform = 'kalshi';

/** A ConstraintGraph with `n` questions (one live market each) joined into ONE cluster
 *  by `set` (categorical/bundle over all of them). */
function graphWith(n: number, setType: 'categorical' | 'bundle', price: PriceCache): ConstraintGraph {
  const questions = new Map<number, QuestionNode>();
  const slots: number[] = [];
  const ts = Date.now();
  for (let i = 1; i <= n; i++) {
    const q: QuestionNode = {
      questionId: i, canonicalSubject: `q${i}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map(),
    };
    const m: MarketRef = { marketId: i, platform: PLAT, platformId: `m${i}` };
    q.markets.set(i, m);
    questions.set(i, q);
    slots.push(i);
    price.update({ marketId: i, platform: PLAT, bestBid: 0.40, bestAsk: 0.44, bidSize: 200, askSize: 200, timestamp: ts } as any);
  }
  const set: OutcomeSetRef = { setId: 1, setType, setName: 's', slotQuestionIds: slots, isExhaustive: false };
  return { questions, outcomeSets: [set], edges: [] };
}

const cfgWith = (over: Partial<typeof config.solver>) =>
  ({ ...config, solver: { ...config.solver, ...over } }) as typeof config;

describe('finalizeClusters — relaxed-setting matrix', () => {
  test('over-cap dropped cluster (flag ON) → relaxed=true, not degenerate', async () => {
    const highs = await getHiGHS();
    const g = graphWith(40, 'bundle', new PriceCache()); // 2^40 free → dropped
    const { clusters } = finalizeClusters(g, cfgWith({ relaxedRoute: true, facetClusterQuestionCap: 2000 }), highs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].relaxed).toBe(true);
    expect(clusters[0].degenerate).toBeFalsy();
    expect(clusters[0].validStates).toHaveLength(0);
  });

  test('enumerable cluster → relaxed unset', async () => {
    const highs = await getHiGHS();
    const g = graphWith(4, 'categorical', new PriceCache()); // 4-slot Σ≤1 → 5 states
    const { clusters } = finalizeClusters(g, cfgWith({ relaxedRoute: true }), highs);
    expect(clusters[0].relaxed).toBeFalsy();
    expect(clusters[0].validStates.length).toBeGreaterThan(0);
  });

  test('flag OFF → over-cap cluster stays dropped dead (relaxed unset)', async () => {
    const g = graphWith(40, 'bundle', new PriceCache());
    const { clusters } = finalizeClusters(g, cfgWith({ relaxedRoute: false }), await getHiGHS());
    expect(clusters[0].relaxed).toBeFalsy();
    expect(clusters[0].validStates).toHaveLength(0);
  });

  test('over facet cap (question cap) → dropped dead (relaxed unset)', async () => {
    const g = graphWith(40, 'bundle', new PriceCache());
    const { clusters } = finalizeClusters(g, cfgWith({ relaxedRoute: true, facetClusterQuestionCap: 5 }), await getHiGHS());
    expect(clusters[0].relaxed).toBeFalsy();
  });
});

describe('applyLivenessDemotion — no-op on relaxed', () => {
  test('returns false immediately for a relaxed cluster', () => {
    const cluster = { relaxed: true, outcomeSets: [], validStates: [], id: 1 } as unknown as Cluster;
    expect(applyLivenessDemotion(cluster, () => true, new Map(), config)).toBe(false);
  });
});

describe('buildForEngine — relaxed routing', () => {
  const relaxedCluster = (): { cluster: Cluster; price: PriceCache } => {
    const price = new PriceCache();
    const g = graphWith(3, 'bundle', price);
    const cluster: Cluster = { id: 1, questions: g.questions, outcomeSets: g.outcomeSets, edges: [], marketIds: new Set([1, 2, 3]), validStates: [], dirty: true, relaxed: true };
    return { cluster, price };
  };
  test('vrep + relaxed → null (no V-rep LP)', () => {
    const { cluster, price } = relaxedCluster();
    expect(buildForEngine('vrep', cluster, price, config.execution, Date.now())).toBeNull();
  });
  test('facet + relaxed → facet LP', () => {
    const { cluster, price } = relaxedCluster();
    const lp = buildForEngine('facet', cluster, price, config.execution, Date.now());
    expect(lp?.facetForm).toBeDefined();
  });
  test('hybrid + relaxed → facet LP', () => {
    const { cluster, price } = relaxedCluster();
    const lp = buildForEngine('hybrid', cluster, price, config.execution, Date.now());
    expect(lp?.facetForm).toBeDefined();
  });
});

describe('buildLP — relaxed guard', () => {
  test('returns null for a relaxed cluster even with non-empty validStates', () => {
    const price = new PriceCache();
    const g = graphWith(3, 'categorical', price);
    const c: Cluster = { id: 1, questions: g.questions, outcomeSets: g.outcomeSets, edges: [], marketIds: new Set([1, 2, 3]), validStates: [new Map([[1, true], [2, false], [3, false]])], dirty: true, relaxed: true };
    expect(buildLP(c, price)).toBeNull();
  });
});

describe('prepareClusterForSolve — relaxed × engine + census', () => {
  beforeEach(() => resetRelaxedSolvePreparedCensus());
  const mkRelaxed = (): { cluster: Cluster; price: PriceCache } => {
    const price = new PriceCache();
    const g = graphWith(3, 'bundle', price);
    const cluster: Cluster = { id: 1, questions: g.questions, outcomeSets: g.outcomeSets, edges: [], marketIds: new Set([1, 2, 3]), validStates: [], dirty: true, relaxed: true };
    return { cluster, price };
  };
  const deps = (price: PriceCache) => ({ priceCache: price, lastSolveFingerprint: new Map<number, string>(), dualCerts: new Map(), livenessMasks: new Map<number, string>() });

  test('vrep + relaxed → skip (no census bump)', () => {
    const { cluster, price } = mkRelaxed();
    const prep = prepareClusterForSolve(deps(price), 1, cluster, Date.now(), { dedup: false, skipFilter: false, theta: 0.99, execution: config.execution, engine: 'vrep' });
    expect(prep.kind).toBe('skip');
    expect(relaxedSolvePreparedCensus()).toBe(0);
  });

  test('facet + relaxed → solve (census bump)', () => {
    const { cluster, price } = mkRelaxed();
    const prep = prepareClusterForSolve(deps(price), 1, cluster, Date.now(), { dedup: false, skipFilter: false, theta: 0.99, execution: config.execution, engine: 'facet' });
    expect(prep.kind).toBe('solve');
    if (prep.kind === 'solve') expect(prep.lp.facetForm).toBeDefined();
    expect(relaxedSolvePreparedCensus()).toBe(1);
  });

  test('hybrid + relaxed → solve (census bump)', () => {
    const { cluster, price } = mkRelaxed();
    const prep = prepareClusterForSolve(deps(price), 1, cluster, Date.now(), { dedup: false, skipFilter: false, theta: 0.99, execution: config.execution, engine: 'hybrid' });
    expect(prep.kind).toBe('solve');
    expect(relaxedSolvePreparedCensus()).toBe(1);
  });
});

describe('skip-filter — facet-form guards', () => {
  const facetLp: LPProblem = {
    numVars: 1, objective: [0.5], constraints: [], rhs: [],
    variables: [{ index: 0, marketId: 1, platform: PLAT, side: 'YES', askPrice: 0.5, feePerShare: 0, maxShares: null }],
    clusterId: 1,
    facetForm: { facets: [], questionOrder: [1], legToQuestion: [1] },
  };
  const result: LPResult = { status: 'Optimal', optimalCost: 0.5, values: [1], solveTimeMs: 1, rowDual: [] };

  test('buildCert returns null for a facet-form LP', () => {
    expect(buildCert(facetLp, result)).toBeNull();
  });
  test('decideSkip returns {skip:false, reason:facet-form}', () => {
    expect(decideSkip(undefined, facetLp, 0.99)).toEqual({ skip: false, reason: 'facet-form' });
  });
});
