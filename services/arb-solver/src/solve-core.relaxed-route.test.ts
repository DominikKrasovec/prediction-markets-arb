/**
 * Relaxed-facet route integration acceptance. A synthetic 30-question
 * over-capped cluster (10-q non-exhaustive categorical, 19 bundle-free, 1
 * free, whose enumeration exceeds the cap) carrying a single-market YES+NO
 * box: dropped -> relaxed -> facet solve Optimal -> portfolio with
 * relaxedOmega=true, worstEnumeratedStatePayout === guaranteedPayout, grade
 * demoted for zero backing state count, no tripwires. Plus the rollback
 * (flag off / vrep -> skip) and the dropped-wall-dependent -> blocked chain.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import type { Platform } from '@arb/types';
import type { ConstraintGraph, QuestionNode, MarketRef, OutcomeSetRef, EdgeRef } from './graph/types.js';
import type { FacetConstraint } from './solver/types.js';
import { config } from './config.js';
import { PriceCache } from './clob/price-cache.js';
import { getHiGHS } from './solver/facet-lp.js';
import { buildFacetLP, solveFacetLP } from './solver/facet-lp.js';
import { extractPortfolio } from './solver/portfolio.js';
import { checkFiredPortfolioTripwires } from './solver/omega-audit.js';
import { applyOmegaGrade } from './solver/execution-grade.js';
import { facetsFeasible } from './solver/omega-constraints.js';
import { finalizeClusters, buildForEngine, prepareClusterForSolve } from './solve-core.js';

const PLAT: Platform = 'kalshi';
const cfgWith = (over: Partial<typeof config.solver>) => ({ ...config, solver: { ...config.solver, ...over } }) as typeof config;

/** The 30-question over-cap graph with a two-sided box on q1. */
function buildBigGraph(): { graph: ConstraintGraph; price: PriceCache } {
  const questions = new Map<number, QuestionNode>();
  const price = new PriceCache();
  const ts = Date.now();
  const addQ = (id: number): QuestionNode => {
    const q: QuestionNode = { questionId: id, canonicalSubject: `q${id}`, conditionShape: null, conditionValue: null, conditionDate: null, markets: new Map() };
    const m: MarketRef = { marketId: id, platform: PLAT, platformId: `m${id}` };
    q.markets.set(id, m);
    questions.set(id, q);
    return q;
  };
  for (let i = 1; i <= 30; i++) addQ(i);
  // q1: two-sided $0.96 box (YES ask 0.48 + real NO book ask 0.48), deep (500).
  price.update({ marketId: 1, platform: PLAT, bestBid: 0.44, bestAsk: 0.48, bidSize: 500, askSize: 500, timestamp: ts } as any);
  price.update({ marketId: 1, platform: PLAT, outcome: 'no', bestBid: 0.44, bestAsk: 0.48, bidSize: 500, askSize: 500, timestamp: ts } as any);
  // q2..q30: ordinary non-arb books.
  for (let i = 2; i <= 30; i++) {
    price.update({ marketId: i, platform: PLAT, bestBid: 0.40, bestAsk: 0.44, bidSize: 200, askSize: 200, timestamp: ts } as any);
  }
  const cat: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], isExhaustive: false };
  const bundle: OutcomeSetRef = { setId: 2, setType: 'bundle', setName: 'b', slotQuestionIds: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29] };
  // Bridge the three components into ONE connected cluster so it over-caps as a whole.
  const edges: EdgeRef[] = [
    { edgeId: 1, antecedentQuestionId: 10, consequentQuestionId: 11, edgeType: 'strict_implication', confidence: 1, deterministic: true, basisRisk: null },
    { edgeId: 2, antecedentQuestionId: 29, consequentQuestionId: 30, edgeType: 'strict_implication', confidence: 1, deterministic: true, basisRisk: null },
  ];
  return { graph: { questions, outcomeSets: [cat, bundle], edges }, price };
}

describe('RELAXED-FACET ROUTE integration', () => {
  beforeAll(async () => { await getHiGHS(); });

  test('dropped → relaxed → facet Optimal → caution portfolio, no tripwires', async () => {
    const { graph, price } = buildBigGraph();
    const { clusters } = finalizeClusters(graph, cfgWith({ relaxedRoute: true }), await getHiGHS());
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster.relaxed).toBe(true);              // over-cap rescued
    expect(cluster.validStates).toHaveLength(0);
    expect(cluster.degenerate).toBeFalsy();

    const now = Date.now();
    const lp = buildFacetLP(cluster, price, config.execution, now)!;
    expect(lp.facetForm).toBeDefined();
    const res = await solveFacetLP(lp);
    expect(res.status).toBe('Optimal');
    // A facet-certified arb (guaranteed $1 over K ⊇ Ω at cost < 1). The LP is free to
    // pick any cheapest guaranteeing basket (≤ the $0.96 box); soundness is one-sided.
    expect(res.optimalCost).toBeGreaterThan(0);
    expect(res.optimalCost).toBeLessThan(1);

    const port = extractPortfolio(res, lp, cluster, price, config.solver.minProfit, config.execution.gradeThresholds, now, { maxStates: config.solver.maxStates, clusterSizeCap: config.solver.clusterSizeCap });
    expect(port).not.toBeNull();
    expect(port!.omegaAudit!.relaxedOmega).toBe(true);
    expect(port!.worstEnumeratedStatePayout).toBe(port!.guaranteedPayout); // facet certificate, not Infinity
    expect(port!.guaranteedPayout).toBe(1.0);
    // An over-capped cluster enumerates zero states, so nothing exact backs the
    // facet objective — the grade is `risky` (persisted, never alerted, never
    // auto-executed), not `caution`.
    expect(port!.omegaAudit!.stateCount).toBe(0);
    expect(port!.executionGrade).toBe('risky');
    expect(port!.executionReasons.some((r) => r.includes('unverified: relaxed-LP objective'))).toBe(true);
    expect(port!.eligibleForAutoExecution).toBe(false);

    // Tripwire (e) does NOT fire at `risky` — that grade is exactly what a
    // zero-state portfolio demotes to.
    const trips = checkFiredPortfolioTripwires(
      cluster, lp.variables, port!.omegaAudit, price, now, port!.executionGrade,
    );
    expect(trips).toHaveLength(0);
    // …but it DOES fire if a 0-state portfolio ever reaches clean/caution.
    expect(
      checkFiredPortfolioTripwires(cluster, lp.variables, port!.omegaAudit, price, now, 'caution')
        .some((t) => t.includes('(e)')),
    ).toBe(true);
  });

  test('rollback: flag OFF → not relaxed, and a vrep prepare skips it', async () => {
    const { graph, price } = buildBigGraph();
    const { clusters } = finalizeClusters(graph, cfgWith({ relaxedRoute: false }), await getHiGHS());
    const cluster = clusters[0];
    expect(cluster.relaxed).toBeFalsy();
    expect(cluster.validStates).toHaveLength(0);
    // vrep cannot solve an over-cap cluster → null LP.
    expect(buildForEngine('vrep', cluster, price, config.execution, Date.now())).toBeNull();
  });

  test('rollback: SOLVE_ENGINE=vrep on a relaxed cluster → prepare skip', async () => {
    const { graph, price } = buildBigGraph();
    const { clusters } = finalizeClusters(graph, cfgWith({ relaxedRoute: true }), await getHiGHS());
    const cluster = clusters[0];
    const prep = prepareClusterForSolve(
      { priceCache: price, lastSolveFingerprint: new Map(), dualCerts: new Map(), livenessMasks: new Map() },
      cluster.id, cluster, Date.now(),
      { dedup: false, skipFilter: false, theta: 0.99, execution: config.execution, engine: 'vrep' },
    );
    expect(prep.kind).toBe('skip');
  });

  test('infeasible facets → facetsFeasible false', async () => {
    const infeasible: FacetConstraint[] = [
      { coeff: [[1, 1]], rhs: 1, kind: 'eq' },   // z1 = 1
      { coeff: [[1, 1]], rhs: 0, kind: 'le' },   // z1 ≤ 0
    ];
    expect(facetsFeasible(infeasible, [1], await getHiGHS())).toBe(false);
  });

  test('dropped-wall-dependent arb → L4 fail dominates the caution cap → blocked', () => {
    // A relaxed basket whose L4 recheck FAILED (relied on a dropped wall) must be
    // blocked even though relaxedOmega only caps at caution — fail wins.
    const audit = {
      closureQuestionCount: 2, closureBookCount: 2, deadBookCount: 1, unquotedClosureQuestionCount: 1,
      quotedFraction: 0.5, relaxedRecheck: 'fail' as const, duplicateSuspectHeld: false,
      pinnedQuestions: [] as number[], distance1UnquotedSibling: false, mutexPriceContradictionSigma: null,
      staleComplementSideHeld: false, implicationPriceContradictionGap: null, relaxedOmega: true,
    };
    expect(applyOmegaGrade('clean', [], audit).grade).toBe('blocked');
  });
});
