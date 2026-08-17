/**
 * GOLDEN-PARITY: an incremental enum-cache reload must be CONTENT-EQUIVALENT to a
 * from-scratch `finalizeClusters` build -- any divergence is a fake or missed arb.
 * Clusters are matched by content (sorted marketIds), never by id (reassigned each
 * build), and validStates is compared as a canonical-string SET plus cardinality.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import type { Platform } from '@arb/types';
import type {
  Cluster,
  ConstraintGraph,
  QuestionNode,
  MarketRef,
  OutcomeSetRef,
  EdgeRef,
} from './types.js';
import { structureKey, configEpoch, EnumCache } from './enum-cache.js';
import { config } from '../config.js';
import { PriceCache, type PriceUpdate } from '../clob/price-cache.js';
import { getHiGHS } from '../solver/facet-lp.js';
import type { HighsLike } from '../solver/omega-constraints.js';
import { extractPortfolio } from '../solver/portfolio.js';
import type { LPProblem } from '../solver/types.js';
import {
  finalizeClusters,
  finalizeClustersIncremental,
  lastIncrementalFinalizeStats,
  buildForEngine,
  solveProblem,
} from '../solve-core.js';

const PLAT: Platform = 'kalshi';

// stable config across every finalize in this file so the cache keys line up
const cfg = { ...config, solver: { ...config.solver, relaxedRoute: true } } as typeof config;
const EPOCH = configEpoch(cfg);

const exec = config.execution;
const omegaOpts = { maxStates: config.solver.maxStates, clusterSizeCap: config.solver.clusterSizeCap };

let highs: HighsLike;
beforeAll(async () => {
  highs = await getHiGHS();
});

function mkQ(id: number): QuestionNode {
  const q: QuestionNode = {
    questionId: id,
    canonicalSubject: `q${id}`,
    conditionShape: null,
    conditionValue: null,
    conditionDate: null,
    markets: new Map(),
  };
  const m: MarketRef = { marketId: id, platform: PLAT, platformId: `m${id}` };
  q.markets.set(id, m);
  return q;
}
function mkEdge(id: number, a: number, b: number, type: string): EdgeRef {
  return { edgeId: id, antecedentQuestionId: a, consequentQuestionId: b, edgeType: type, confidence: 1, deterministic: true, basisRisk: null };
}
function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

// Seven disjoint components/clusters: C1 exhaustive categorical, C2 threshold_series,
// C3 bundle, C4 strict_implication chain, C5 over-cap->relaxed, C6 contradictory->
// degenerate, C7 duplicate-suspect pair.
function buildFixtureGraph(): ConstraintGraph {
  const questions = new Map<number, QuestionNode>();
  const add = (id: number) => questions.set(id, mkQ(id));
  for (const i of [1, 2, 3]) add(i); // C1
  for (const i of [10, 11, 12]) add(i); // C2
  for (const i of [20, 21, 22]) add(i); // C3
  for (const i of [40, 41, 42]) add(i); // C4
  for (const i of range(100, 129)) add(i); // C5 (30 questions)
  for (const i of [200, 201]) add(i); // C6
  for (const i of [300, 301]) add(i); // C7

  const outcomeSets: OutcomeSetRef[] = [
    { setId: 1, setType: 'categorical', setName: 'c1-cat', slotQuestionIds: [1, 2, 3], isExhaustive: true },
    { setId: 2, setType: 'threshold_series', setName: 'c2-thr', slotQuestionIds: [10, 11, 12] },
    { setId: 3, setType: 'bundle', setName: 'c3-bundle', slotQuestionIds: [20, 21, 22] },
    { setId: 5, setType: 'categorical', setName: 'c5-cat', slotQuestionIds: range(100, 109), isExhaustive: false },
    { setId: 6, setType: 'bundle', setName: 'c5-bundle', slotQuestionIds: range(110, 128) },
  ];
  const edges: EdgeRef[] = [
    mkEdge(41, 40, 41, 'strict_implication'), // C4
    mkEdge(42, 41, 42, 'strict_implication'), // C4
    mkEdge(109, 109, 110, 'strict_implication'), // C5 bridge cat→bundle
    mkEdge(129, 128, 129, 'strict_implication'), // C5 bridge bundle→free
    mkEdge(200, 200, 201, 'equivalence'), // C6 contradictory pair …
    mkEdge(201, 200, 201, 'mutual_exclusion'), // C6 … equivalence ∧ mutex ⇒ pinned
  ];
  return { questions, outcomeSets, edges, duplicateSuspectPairs: [[300, 301]] };
}

function mutateAddMember(g: ConstraintGraph): void {
  g.questions.set(4, mkQ(4)); // add question + member to C1's categorical
  g.outcomeSets.find((s) => s.setId === 1)!.slotQuestionIds = [1, 2, 3, 4];
}
function mutateDeleteMember(g: ConstraintGraph): void {
  g.questions.delete(22); // drop a member from C3's bundle
  g.outcomeSets.find((s) => s.setId === 3)!.slotQuestionIds = [20, 21];
}
function mutateFlipImplication(g: ConstraintGraph): void {
  const e = g.edges.find((x) => x.edgeId === 41)!; // flip C4's strict_implication direction
  [e.antecedentQuestionId, e.consequentQuestionId] = [e.consequentQuestionId, e.antecedentQuestionId];
}
function mutateToggleExhaustive(g: ConstraintGraph): void {
  g.outcomeSets.find((s) => s.setId === 1)!.isExhaustive = false; // C1 Σ=1 → Σ≤1
}

function keyOf(c: Cluster): string {
  return [...c.marketIds].sort((a, b) => a - b).join(',');
}
function canonSets(c: Cluster) {
  return c.outcomeSets
    .map((os) => ({ setId: os.setId, setType: os.setType, isExhaustive: os.isExhaustive, slotQuestionIds: [...os.slotQuestionIds] }))
    .sort((a, b) => a.setId - b.setId);
}
function canonEdges(c: Cluster) {
  return c.edges
    .map((e) => ({ edgeId: e.edgeId, edgeType: e.edgeType, antecedent: e.antecedentQuestionId, consequent: e.consequentQuestionId }))
    .sort((a, b) => a.edgeId - b.edgeId);
}
function canonPairs(pairs: Array<[number, number]> | undefined) {
  return (pairs ?? [])
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number])
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}
function sortedNums(xs: number[] | undefined) {
  return [...(xs ?? [])].sort((a, b) => a - b);
}
function stateStr(m: Map<number, boolean>): string {
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([q, v]) => `${q}=${v ? 1 : 0}`).join(';');
}
function stateStrings(c: Cluster): string[] {
  return c.validStates.map(stateStr);
}

function assertClustersEquivalent(A: Cluster[], B: Cluster[]): void {
  const ka = A.map(keyOf);
  const kb = B.map(keyOf);
  expect(new Set(ka).size).toBe(ka.length);
  expect(new Set(kb).size).toBe(kb.length);
  expect([...ka].sort()).toEqual([...kb].sort());

  const byKeyB = new Map(B.map((c) => [keyOf(c), c]));
  for (const a of A) {
    const b = byKeyB.get(keyOf(a))!;
    expect(sortedNums([...a.questions.keys()])).toEqual(sortedNums([...b.questions.keys()]));
    expect(sortedNums([...a.marketIds])).toEqual(sortedNums([...b.marketIds]));
    expect(canonSets(a)).toEqual(canonSets(b));
    expect(canonEdges(a)).toEqual(canonEdges(b));
    expect(a.degenerate ?? false).toBe(b.degenerate ?? false);
    expect(a.relaxed ?? false).toBe(b.relaxed ?? false);
    expect(sortedNums(a.pinnedQuestions)).toEqual(sortedNums(b.pinnedQuestions));
    expect(canonPairs(a.duplicateSuspectPairs)).toEqual(canonPairs(b.duplicateSuspectPairs));
    const sa = stateStrings(a);
    const sb = stateStrings(b);
    expect(new Set(sa).size).toBe(sa.length); // A has no duplicate states
    expect(new Set(sb).size).toBe(sb.length); // B has no duplicate states
    expect(a.validStates.length).toBe(b.validStates.length); // same cardinality
    expect(new Set(sa)).toEqual(new Set(sb)); // same state SET
  }
}

function matchPairs(A: Cluster[], B: Cluster[]): Array<[Cluster, Cluster]> {
  const byKeyB = new Map(B.map((c) => [keyOf(c), c]));
  return A.map((a) => [a, byKeyB.get(keyOf(a))!] as [Cluster, Cluster]);
}

function legMultiset(p: { legs: Array<{ marketId: number; side: string }> }): string[] {
  return p.legs.map((l) => `${l.marketId}:${l.side}`).sort();
}
async function assertLpParity(pairs: Array<[Cluster, Cluster]>, price: PriceCache, now: number): Promise<void> {
  for (const [a, b] of pairs) {
    const lpA: LPProblem | null = buildForEngine('hybrid', a, price, exec, now);
    const lpB: LPProblem | null = buildForEngine('hybrid', b, price, exec, now);
    if (lpA === null || lpB === null) {
      expect(lpA).toBeNull();
      expect(lpB).toBeNull();
      continue;
    }
    const rA = await solveProblem(lpA);
    const rB = await solveProblem(lpB);
    expect(rA.status).toBe(rB.status);
    if (rA.status !== 'Optimal') continue;
    expect(Math.abs(rA.optimalCost - rB.optimalCost)).toBeLessThan(1e-9);
    if (rA.optimalCost < 1 - 1e-12) {
      const pA = extractPortfolio(rA, lpA, a, price, config.solver.minProfit, config.execution.gradeThresholds, now, omegaOpts);
      const pB = extractPortfolio(rB, lpB, b, price, config.solver.minProfit, config.execution.gradeThresholds, now, omegaOpts);
      expect(pA === null).toBe(pB === null);
      if (pA && pB) {
        expect(pA.executionGrade).toBe(pB.executionGrade);
        expect(legMultiset(pA)).toEqual(legMultiset(pB));
      }
    }
  }
}

const ALL_MIDS = [...new Set([...buildFixtureGraph().questions.keys(), 4])];
function priceAll(mids: number[], ask: number): PriceCache {
  const p = new PriceCache();
  const ts = Date.now();
  for (const m of mids) {
    const u: PriceUpdate = { marketId: m, platform: PLAT, bestBid: 0, bestAsk: ask, bidSize: 0, askSize: 500, timestamp: ts };
    p.update(u);
  }
  return p;
}
function arbPrice(): PriceCache {
  const p = priceAll(ALL_MIDS, 0.55);
  const ts = Date.now();
  for (const m of [1, 2, 3]) p.update({ marketId: m, platform: PLAT, bestBid: 0, bestAsk: 0.3, bidSize: 0, askSize: 500, timestamp: ts });
  return p;
}
function noArbPrice(): PriceCache {
  return priceAll(ALL_MIDS, 0.55);
}
function deadPrice(): PriceCache {
  return new PriceCache();
}

describe('incremental-reload GOLDEN parity', () => {
  test('(1) no-op: incremental over a prewarmed cache ≡ from-scratch, 100% reuse', () => {
    const cache = new EnumCache();
    finalizeClustersIncremental(buildFixtureGraph(), cfg, highs, cache);

    const full0 = finalizeClusters(buildFixtureGraph(), cfg, highs); // golden
    const incr = finalizeClustersIncremental(buildFixtureGraph(), cfg, highs, cache);
    const stats = lastIncrementalFinalizeStats();

    expect(incr.clusters.length).toBe(7);
    expect(stats.enumerated).toBe(0);
    expect(stats.reused).toBe(incr.clusters.length);
    expect(stats.evicted).toBe(0);

    assertClustersEquivalent(incr.clusters, full0.clusters);
  });

  const mutations: Array<{ name: string; mutate: (g: ConstraintGraph) => void }> = [
    { name: 'add a question + member (C1 categorical gains a slot)', mutate: mutateAddMember },
    { name: 'delete a member (C3 bundle loses a slot)', mutate: mutateDeleteMember },
    { name: 'flip a strict_implication direction (C4)', mutate: mutateFlipImplication },
    { name: "toggle a set's isExhaustive (C1 Σ=1 → Σ≤1)", mutate: mutateToggleExhaustive },
  ];

  for (const { name, mutate } of mutations) {
    test(`(2/3) mutation parity — ${name}`, () => {
      const cache = new EnumCache();
      const warm = finalizeClustersIncremental(buildFixtureGraph(), cfg, highs, cache); // full0-equiv (test 1 certifies ≡ from-scratch)

      const g1 = buildFixtureGraph();
      mutate(g1);
      const fresh = finalizeClusters(g1, cfg, highs); // golden
      const incr = finalizeClustersIncremental(g1, cfg, highs, cache);
      const stats = lastIncrementalFinalizeStats();

      assertClustersEquivalent(incr.clusters, fresh.clusters);

      expect(stats.enumerated).toBe(1);
      expect(stats.reused).toBe(6);
      expect(stats.evicted).toBe(1);

      const warmByKey = new Map(warm.clusters.map((c) => [keyOf(c), c]));
      const freshByKey = new Map(fresh.clusters.map((c) => [keyOf(c), c]));
      let reusedRef = 0;
      let changed = 0;
      for (const c of incr.clusters) {
        const w = warmByKey.get(keyOf(c));
        const sameStructure = w !== undefined && structureKey(c, EPOCH) === structureKey(w, EPOCH);
        if (sameStructure) {
          if (w!.validStates.length > 0) expect(c.validStates).toBe(w!.validStates);
          else expect(c.validStates.length).toBe(0);
          reusedRef++;
        } else {
          const f = freshByKey.get(keyOf(c))!;
          expect(c.validStates).toEqual(f.validStates); // re-enumerated, value-equal to golden
          if (w) expect(c.validStates).not.toBe(w.validStates); // …and a NEW array
          changed++;
        }
      }
      expect(reusedRef).toBe(6);
      expect(changed).toBe(1);
    });
  }

  test('(4) LP-level parity across arb / no-arb / dead-book snapshots', async () => {
    const now = Date.now();

    const cacheA = new EnumCache();
    finalizeClustersIncremental(buildFixtureGraph(), cfg, highs, cacheA);
    const full0 = finalizeClusters(buildFixtureGraph(), cfg, highs);
    const incr0 = finalizeClustersIncremental(buildFixtureGraph(), cfg, highs, cacheA);
    const pairs0 = matchPairs(incr0.clusters, full0.clusters);

    const cacheB = new EnumCache();
    finalizeClustersIncremental(buildFixtureGraph(), cfg, highs, cacheB);
    const g1 = buildFixtureGraph();
    mutateAddMember(g1);
    const fresh1 = finalizeClusters(g1, cfg, highs);
    const incr1 = finalizeClustersIncremental(g1, cfg, highs, cacheB);
    const pairs1 = matchPairs(incr1.clusters, fresh1.clusters);

    for (const price of [arbPrice(), noArbPrice(), deadPrice()]) {
      await assertLpParity(pairs0, price, now);
      await assertLpParity(pairs1, price, now);
    }

    const arb = arbPrice();
    const c1a = incr0.clusters.find((c) => keyOf(c) === '1,2,3')!;
    const c1b = full0.clusters.find((c) => keyOf(c) === '1,2,3')!;
    const lpa = buildForEngine('hybrid', c1a, arb, exec, now)!;
    const lpb = buildForEngine('hybrid', c1b, arb, exec, now)!;
    const ra = await solveProblem(lpa);
    const rb = await solveProblem(lpb);
    expect(ra.status).toBe('Optimal');
    expect(ra.optimalCost).toBeLessThan(1);
    const pa = extractPortfolio(ra, lpa, c1a, arb, config.solver.minProfit, config.execution.gradeThresholds, now, omegaOpts)!;
    const pb = extractPortfolio(rb, lpb, c1b, arb, config.solver.minProfit, config.execution.gradeThresholds, now, omegaOpts)!;
    expect(pa).not.toBeNull();
    expect(pb).not.toBeNull();
    expect(pa.executionGrade).toBe(pb.executionGrade);
    expect(legMultiset(pa)).toEqual(legMultiset(pb));
  });

  test('(5) idempotence: 3 successive incrementals stay ≡ golden, 100% reuse, bounded cache', () => {
    const cache = new EnumCache();
    finalizeClustersIncremental(buildFixtureGraph(), cfg, highs, cache); // warm
    const sizeAfterWarm = cache.size;
    expect(sizeAfterWarm).toBe(7);

    const full0 = finalizeClusters(buildFixtureGraph(), cfg, highs);

    for (let i = 0; i < 3; i++) {
      const incr = finalizeClustersIncremental(buildFixtureGraph(), cfg, highs, cache);
      const stats = lastIncrementalFinalizeStats();
      expect(stats.reused).toBe(incr.clusters.length); // 100% reuse
      expect(stats.enumerated).toBe(0);
      expect(stats.evicted).toBe(0);
      expect(cache.size).toBe(sizeAfterWarm); // mark-sweep did not grow the cache
      assertClustersEquivalent(incr.clusters, full0.clusters);
    }
  });
});
