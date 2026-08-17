/**
 * extractPortfolio worst-state payout on the facet / empty-Ω path + the
 * zero-legs belt.
 *
 * A facetForm (H-rep) LPProblem carries no enumerated validStates, so a plain
 * state-scan cannot bound worstEnumeratedStatePayout. This path uses the facet
 * certificate (guaranteedPayout) as the sound worst case instead.
 */
import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode, OutcomeSetRef } from '../graph/types.js';
import type { LPProblem, LPResult } from './types.js';
import { PriceCache } from '../clob/price-cache.js';
import { buildFacetLP, solveFacetLP } from './facet-lp.js';
import { extractPortfolio } from './portfolio.js';
import { NO_EXECUTION_GATE } from './types.js';

const PLAT: Platform = 'kalshi';

/** A 4-way exhaustive categorical priced as an arb (Σ ask < 1), left with EMPTY
 *  validStates so the facet path is exercised as it is in production (dropped/rescued). */
function makeFacetArbCluster(): { cluster: Cluster; price: PriceCache } {
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  const slots: number[] = [];
  const price = new PriceCache();
  const ts = Date.now();
  for (let i = 0; i < 4; i++) {
    const qid = i + 1, mid = i + 1;
    const q: QuestionNode = {
      questionId: qid, canonicalSubject: `q${qid}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map(),
    };
    const m: MarketRef = { marketId: mid, platform: PLAT, platformId: `m${mid}` };
    q.markets.set(mid, m);
    questions.set(qid, q);
    marketIds.add(mid);
    slots.push(qid);
    price.update({ marketId: mid, platform: PLAT, bestBid: 0.19, bestAsk: 0.22, bidSize: 200, askSize: 200, timestamp: ts } as any);
  }
  const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: slots, isExhaustive: true };
  return { cluster: { id: 1, questions, outcomeSets: [set], edges: [], marketIds, validStates: [], dirty: true }, price };
}

describe('extractPortfolio — facet-form worst-state payout', () => {
  test('facetForm cluster with empty validStates: worstEnumeratedStatePayout === guaranteedPayout (not Infinity)', async () => {
    const { cluster, price } = makeFacetArbCluster();
    const lp = buildFacetLP(cluster, price, NO_EXECUTION_GATE, Date.now())!;
    expect(lp.facetForm).toBeDefined();
    const res = await solveFacetLP(lp);
    expect(res.status).toBe('Optimal');
    const port = extractPortfolio(res, lp, cluster, price, 0.01, undefined, Date.now());
    expect(port).not.toBeNull();
    if (port) {
      expect(Number.isFinite(port.worstEnumeratedStatePayout)).toBe(true);
      expect(port.worstEnumeratedStatePayout).toBe(port.guaranteedPayout);
      expect(port.guaranteedPayout).toBe(1.0); // min-cost form
    }
  });
});

describe('extractPortfolio — zero-legs belt', () => {
  test('an Optimal solve with no lifted shares returns null (vacuous portfolio)', () => {
    const price = new PriceCache();
    const questions = new Map<number, QuestionNode>();
    const q: QuestionNode = {
      questionId: 1, canonicalSubject: 'q1', conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map(),
    };
    q.markets.set(1, { marketId: 1, platform: PLAT, platformId: 'm1' });
    questions.set(1, q);
    const cluster: Cluster = { id: 1, questions, outcomeSets: [], edges: [], marketIds: new Set([1]), validStates: [], dirty: false };
    const problem: LPProblem = {
      numVars: 1, objective: [0.5], constraints: [], rhs: [],
      variables: [{ index: 0, marketId: 1, platform: PLAT, side: 'YES', askPrice: 0.5, feePerShare: 0, maxShares: null }],
      clusterId: 1,
    };
    // Optimal, cost 0 (< 1 ⟹ passes the profit gate) but every share is 0 ⟹ no legs.
    const result: LPResult = { status: 'Optimal', optimalCost: 0, values: [0], solveTimeMs: 1 };
    expect(extractPortfolio(result, problem, cluster, price, 0.01, undefined, Date.now())).toBeNull();
  });
});
