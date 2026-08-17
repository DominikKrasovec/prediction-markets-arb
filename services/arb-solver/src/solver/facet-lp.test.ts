/**
 * H-representation (facet LP) EQUIVALENCE tests. The facet solver must reproduce
 * the V-rep enumerator's arb DECISION (optimal cost, hence profit) on every
 * integral-polytope cluster shape in the real workload, and must SOLVE the
 * cartesian / implication-chain blow-ups the V-rep drops. Prices/legs are shared
 * (buildLegVariables), so any divergence is in the Ω encoding itself.
 */
import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode, OutcomeSetRef, EdgeRef } from '../graph/types.js';
import { PriceCache } from '../clob/price-cache.js';
import { buildLP } from './lp-builder.js';
import { solveLP } from './solver.js';
import { buildFacetLP, solveFacetLP, clusterToFacets } from './facet-lp.js';
import { enumerateStates } from './state-enumerator.js';
import { extractPortfolio } from './portfolio.js';
import { NO_EXECUTION_GATE } from './types.js';

const PLAT: Platform = 'kalshi';
const NEVER_UNQUOTED = () => false;

interface Built {
  cluster: Cluster;
  price: PriceCache;
}

/** Deterministic cluster generator (mirrors the audit harness shapes). */
function makeCluster(
  kind: 'categorical' | 'threshold' | 'chain' | 'cartesian' | 'mutexpair',
  size: number,
  arb: 'arb' | 'none',
  opts: { sets?: number; ladder?: boolean } = {},
): Built {
  let QID = 1, MID = 1, SID = 1;
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  const outcomeSets: OutcomeSetRef[] = [];
  const edges: EdgeRef[] = [];
  const price = new PriceCache();
  const ts = Date.now();
  const askSum = arb === 'arb' ? 0.9 : 1.15;

  const addQ = (): QuestionNode => {
    const qid = QID++;
    const n: QuestionNode = {
      questionId: qid, canonicalSubject: `q${qid}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map(),
    };
    questions.set(qid, n);
    return n;
  };
  const addM = (q: QuestionNode, ask: number, spread: number) => {
    const mid = MID++;
    const bid = Math.max(0.001, Math.min(ask - spread, ask - 1e-6));
    const m: MarketRef = { marketId: mid, platform: PLAT, platformId: `m${mid}` };
    q.markets.set(mid, m);
    marketIds.add(mid);
    const upd: any = {
      marketId: mid, platform: PLAT, bestBid: bid, bestAsk: Math.min(0.999, ask),
      bidSize: 200, askSize: 200, timestamp: ts,
    };
    if (opts.ladder) {
      upd.askLevels = [[Math.min(0.999, ask), 120], [Math.min(0.999, ask + spread), 300]];
      upd.bidLevels = [[bid, 120], [Math.max(0.001, bid - spread), 300]];
    }
    price.update(upd);
  };
  const oneHot = (k: number, exhaustive: boolean) => {
    const slots: number[] = [];
    const base = askSum / k;
    for (let i = 0; i < k; i++) {
      const q = addQ();
      slots.push(q.questionId);
      addM(q, Math.max(0.003, base), 0.01);
    }
    outcomeSets.push({ setId: SID++, setType: 'categorical', setName: `c${SID}`, slotQuestionIds: slots, isExhaustive: exhaustive });
  };

  if (kind === 'categorical') oneHot(size, true);
  else if (kind === 'cartesian') for (let s = 0; s < (opts.sets ?? 2); s++) oneHot(size, true);
  else if (kind === 'threshold') {
    const slots: number[] = [];
    for (let i = 0; i < size; i++) { const q = addQ(); slots.push(q.questionId); addM(q, 0.2 + 0.6 * (i / size), 0.01); }
    outcomeSets.push({ setId: SID++, setType: 'threshold_series', setName: 'thr', slotQuestionIds: slots, isExhaustive: false });
  } else if (kind === 'chain') {
    const qs: number[] = [];
    for (let i = 0; i < size; i++) { const q = addQ(); qs.push(q.questionId); addM(q, 0.2 + 0.6 * (i / size), 0.01); }
    for (let i = 0; i + 1 < size; i++) edges.push({ edgeId: i + 1, antecedentQuestionId: qs[i], consequentQuestionId: qs[i + 1], edgeType: 'strict_implication', confidence: 1, deterministic: true, basisRisk: null });
  } else if (kind === 'mutexpair') {
    const q1 = addQ(), q2 = addQ();
    addM(q1, askSum / 2, 0.01); addM(q2, askSum / 2, 0.01);
    edges.push({ edgeId: 1, antecedentQuestionId: q1.questionId, consequentQuestionId: q2.questionId, edgeType: 'mutual_exclusion', confidence: 1, deterministic: true, basisRisk: null });
  }

  return { cluster: { id: 1, questions, outcomeSets, edges, marketIds, validStates: [], dirty: true }, price };
}

async function vrepCost(b: Built, cap = 100_000): Promise<{ cost: number; dropped: boolean; states: number }> {
  const states = enumerateStates(b.cluster, { maxStates: cap, clusterSizeCap: 1e9 });
  if (states.length === 0) return { cost: NaN, dropped: true, states: 0 };
  b.cluster.validStates = states;
  const lp = buildLP(b.cluster, b.price, NO_EXECUTION_GATE)!;
  const r = await solveLP(lp);
  return { cost: r.optimalCost, dropped: false, states: states.length };
}

async function facetCost(b: Built): Promise<number> {
  const lp = buildFacetLP(b.cluster, b.price, NO_EXECUTION_GATE, Date.now())!;
  const r = await solveFacetLP(lp);
  return r.optimalCost;
}

describe('facet-LP ≡ V-rep optimal cost (arb decision)', () => {
  const cases: Array<[Parameters<typeof makeCluster>[0], number, 'arb' | 'none']> = [
    ['categorical', 4, 'arb'], ['categorical', 4, 'none'], ['categorical', 8, 'arb'],
    ['categorical', 20, 'arb'], ['categorical', 50, 'none'],
    ['threshold', 6, 'none'], ['threshold', 10, 'none'],
    ['chain', 8, 'none'], ['chain', 12, 'none'],
    ['cartesian', 5, 'arb'], ['cartesian', 8, 'none'],
    ['mutexpair', 2, 'arb'], ['mutexpair', 2, 'none'],
  ];
  for (const [kind, size, arb] of cases) {
    test(`${kind} size=${size} ${arb}`, async () => {
      const v = await vrepCost(makeCluster(kind, size, arb));
      const f = await facetCost(makeCluster(kind, size, arb));
      expect(v.dropped).toBe(false);
      expect(f).toBeCloseTo(v.cost, 4);
    });
  }
});

describe('facet-LP arb decision + profit match extractPortfolio', () => {
  for (const [kind, size, arb] of [['categorical', 6, 'arb'], ['cartesian', 5, 'arb'], ['mutexpair', 2, 'none']] as const) {
    test(`${kind} ${size} ${arb}`, async () => {
      // V-rep portfolio
      const bv = makeCluster(kind, size, arb);
      const vstates = enumerateStates(bv.cluster, { maxStates: 100_000, clusterSizeCap: 1e9 });
      bv.cluster.validStates = vstates;
      const vlp = buildLP(bv.cluster, bv.price, NO_EXECUTION_GATE)!;
      const vres = await solveLP(vlp);
      const vport = extractPortfolio(vres, vlp, bv.cluster, bv.price, 0.01, undefined, Date.now());

      // H-rep portfolio (shares live in result.values, index-aligned with legs)
      const bf = makeCluster(kind, size, arb);
      // enumerate so extractPortfolio's worst-state annotation has states to scan
      bf.cluster.validStates = enumerateStates(bf.cluster, { maxStates: 100_000, clusterSizeCap: 1e9 });
      const flp = buildFacetLP(bf.cluster, bf.price, NO_EXECUTION_GATE, Date.now())!;
      const fres = await solveFacetLP(flp);
      const fport = extractPortfolio(fres, flp, bf.cluster, bf.price, 0.01, undefined, Date.now());

      // Same arb decision (both find an arb, or neither).
      expect(!!fport).toBe(!!vport);
      if (vport && fport) {
        expect(fport.profit).toBeCloseTo(vport.profit, 4);
        expect(fport.totalCost).toBeCloseTo(vport.totalCost, 4);
        // H-rep basket pays ≥ $1 in EVERY enumerated world (soundness).
        expect(fport.worstEnumeratedStatePayout).toBeGreaterThanOrEqual(1 - 1e-6);
      }
    });
  }
});

describe('facet-LP solves clusters the V-rep DROPS', () => {
  for (const [kind, size] of [['chain', 50], ['chain', 188], ['cartesian', 200]] as const) {
    test(`${kind} ${size} rescued`, async () => {
      const v = await vrepCost(makeCluster(kind, size, 'none'), 10_000);
      expect(v.dropped).toBe(true); // V-rep gives up at the 10k cap
      const lp = buildFacetLP(makeCluster(kind, size, 'none').cluster, makeCluster(kind, size, 'none').price, NO_EXECUTION_GATE, Date.now())!;
      const r = await solveFacetLP(lp);
      expect(r.status).toBe('Optimal'); // H-rep solves it
      expect(r.optimalCost).toBeGreaterThan(0);
    });
  }
});

describe('facet-LP ≡ V-rep in DEPTH-AWARE profit-max (ladder) mode', () => {
  for (const [kind, size] of [['categorical', 5], ['mutexpair', 2]] as const) {
    test(`${kind} ${size} profit-max`, async () => {
      const bv = makeCluster(kind, size, 'arb', { ladder: true });
      bv.cluster.validStates = enumerateStates(bv.cluster, { maxStates: 100_000, clusterSizeCap: 1e9 });
      // bookLadder=true forces the tranche/profit-max formulation on both engines.
      const vlp = buildLP(bv.cluster, bv.price, NO_EXECUTION_GATE, true, true)!;
      expect(vlp.guaranteedPayoutVarIndex).toBeDefined(); // profit-max engaged
      const vres = await solveLP(vlp);

      const bf = makeCluster(kind, size, 'arb', { ladder: true });
      const flp = buildFacetLP(bf.cluster, bf.price, NO_EXECUTION_GATE, Date.now(), true, true)!;
      expect(flp.guaranteedPayoutVarIndex).toBe(vlp.guaranteedPayoutVarIndex);
      const fres = await solveFacetLP(flp);

      // Profit-max objective = cost − G (= −profit); must match.
      expect(fres.optimalCost).toBeCloseTo(vres.optimalCost, 4);
    });
  }
});

describe('clusterToFacets soundness demotions', () => {
  test('exhaustive categorical → Σ=1 (eq) when fully quoted', () => {
    const b = makeCluster('categorical', 4, 'none');
    const facets = clusterToFacets(b.cluster, NEVER_UNQUOTED);
    expect(facets.length).toBe(1);
    expect(facets[0].kind).toBe('eq');
    expect(facets[0].rhs).toBe(1);
  });
  test('Ω-liveness L2: a dead slot demotes exhaustive → Σ≤1 (le)', () => {
    const b = makeCluster('categorical', 4, 'none');
    const deadQid = [...b.cluster.questions.keys()][0];
    const facets = clusterToFacets(b.cluster, (q) => q === deadQid);
    expect(facets[0].kind).toBe('le'); // demoted
  });
  test('non-deterministic / soft edges emit no facet', () => {
    const b = makeCluster('mutexpair', 2, 'none');
    b.cluster.edges[0] = { ...b.cluster.edges[0], deterministic: false };
    expect(clusterToFacets(b.cluster, NEVER_UNQUOTED).length).toBe(0);
  });
});
