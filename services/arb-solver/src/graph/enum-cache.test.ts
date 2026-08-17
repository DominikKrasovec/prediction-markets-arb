/**
 * ENUM-CACHE tests — structure-key determinism / canonicalization / sensitivity /
 * prove-irrelevance, and the incremental-finalize reuse + selective re-enumeration
 * + mark-sweep eviction contract.
 */
import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, ConstraintGraph, QuestionNode, MarketRef, OutcomeSetRef, EdgeRef } from './types.js';
import { structureKey, EnumCache } from './enum-cache.js';
import { config } from '../config.js';
import { finalizeClusters, finalizeClustersIncremental, lastIncrementalFinalizeStats } from '../solve-core.js';

const PLAT: Platform = 'kalshi';
const EPOCH = 'test-epoch';

// ── factories ────────────────────────────────────────────────────────────────
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

function mkEdge(id: number, a: number, b: number, type: string, over: Partial<EdgeRef> = {}): EdgeRef {
  return {
    edgeId: id,
    antecedentQuestionId: a,
    consequentQuestionId: b,
    edgeType: type,
    confidence: over.confidence ?? 1,
    deterministic: over.deterministic ?? true,
    basisRisk: over.basisRisk ?? null,
  };
}

/** Build a bare Cluster from member ids / sets / edges (only the key-relevant fields matter). */
function mkCluster(opts: {
  id?: number;
  members: number[];
  sets?: OutcomeSetRef[];
  edges?: EdgeRef[];
}): Cluster {
  const questions = new Map<number, QuestionNode>();
  for (const id of opts.members) questions.set(id, mkQ(id));
  return {
    id: opts.id ?? 1,
    questions,
    outcomeSets: opts.sets ?? [],
    edges: opts.edges ?? [],
    marketIds: new Set(opts.members),
    validStates: [],
    dirty: false,
  };
}

// A representative cluster: 3-slot categorical (exhaustive) + a threshold ladder +
// one hard strict_implication + one hard mutual_exclusion.
function baseSets(): OutcomeSetRef[] {
  return [
    { setId: 10, setType: 'categorical', setName: 'cat', slotQuestionIds: [1, 2, 3], isExhaustive: true },
    { setId: 20, setType: 'threshold_series', setName: 'thr', slotQuestionIds: [4, 5, 6] },
  ];
}
function baseEdges(): EdgeRef[] {
  return [mkEdge(1, 1, 4, 'strict_implication'), mkEdge(2, 2, 5, 'mutual_exclusion')];
}
function baseCluster(overrides: Partial<Parameters<typeof mkCluster>[0]> = {}): Cluster {
  return mkCluster({ members: [1, 2, 3, 4, 5, 6], sets: baseSets(), edges: baseEdges(), ...overrides });
}

// ── (a) determinism + canonicalization ────────────────────────────────────────
describe('structureKey — determinism & canonicalization', () => {
  test('identical structure → identical key (deterministic)', () => {
    expect(structureKey(baseCluster(), EPOCH)).toBe(structureKey(baseCluster(), EPOCH));
  });

  test('permuting outcome-set ORDER → same key', () => {
    const a = baseCluster();
    const b = baseCluster();
    b.outcomeSets = [...b.outcomeSets].reverse();
    expect(structureKey(b, EPOCH)).toBe(structureKey(a, EPOCH));
  });

  test('permuting hard-edge ORDER → same key', () => {
    const a = baseCluster();
    const b = baseCluster();
    b.edges = [...b.edges].reverse();
    expect(structureKey(b, EPOCH)).toBe(structureKey(a, EPOCH));
  });

  test('permuting member INSERTION order → same key', () => {
    const a = mkCluster({ members: [1, 2, 3, 4, 5, 6], sets: baseSets(), edges: baseEdges() });
    const b = mkCluster({ members: [6, 5, 4, 3, 2, 1], sets: baseSets(), edges: baseEdges() });
    expect(structureKey(b, EPOCH)).toBe(structureKey(a, EPOCH));
  });

  test('symmetric edge (mutual_exclusion) endpoint order → same key', () => {
    const a = mkCluster({ members: [1, 2], edges: [mkEdge(1, 1, 2, 'mutual_exclusion')] });
    const b = mkCluster({ members: [1, 2], edges: [mkEdge(1, 2, 1, 'mutual_exclusion')] });
    expect(structureKey(b, EPOCH)).toBe(structureKey(a, EPOCH));
  });
});

// ── (b) sensitivity ───────────────────────────────────────────────────────────
describe('structureKey — sensitivity (must CHANGE)', () => {
  const base = structureKey(baseCluster(), EPOCH);

  test('flip isExhaustive', () => {
    const c = baseCluster();
    c.outcomeSets = c.outcomeSets.map((os) => (os.setId === 10 ? { ...os, isExhaustive: false } : os));
    expect(structureKey(c, EPOCH)).not.toBe(base);
  });

  test('flip a strict_implication direction', () => {
    const c = baseCluster();
    c.edges = [mkEdge(1, 4, 1, 'strict_implication'), mkEdge(2, 2, 5, 'mutual_exclusion')];
    expect(structureKey(c, EPOCH)).not.toBe(base);
  });

  test('add a member', () => {
    const c = baseCluster({ members: [1, 2, 3, 4, 5, 6, 7] });
    expect(structureKey(c, EPOCH)).not.toBe(base);
  });

  test('remove a member', () => {
    const c = baseCluster({ members: [1, 2, 3, 4, 5] });
    expect(structureKey(c, EPOCH)).not.toBe(base);
  });

  test('add a hard edge', () => {
    const c = baseCluster();
    c.edges = [...c.edges, mkEdge(3, 3, 6, 'equivalence')];
    expect(structureKey(c, EPOCH)).not.toBe(base);
  });

  test('remove a hard edge', () => {
    const c = baseCluster();
    c.edges = [c.edges[0]];
    expect(structureKey(c, EPOCH)).not.toBe(base);
  });

  test('reorder a threshold_series slot (order-sensitive)', () => {
    const c = baseCluster();
    c.outcomeSets = c.outcomeSets.map((os) => (os.setId === 20 ? { ...os, slotQuestionIds: [4, 6, 5] } : os));
    expect(structureKey(c, EPOCH)).not.toBe(base);
  });

  test('a different config epoch → different key', () => {
    expect(structureKey(baseCluster(), 'other-epoch')).not.toBe(base);
  });
});

// ── (c) prove-irrelevant (must NOT change) ────────────────────────────────────
describe('structureKey — prove-irrelevant fields (must NOT change)', () => {
  const base = structureKey(baseCluster(), EPOCH);

  test('cluster.id change', () => {
    expect(structureKey(baseCluster({ id: 9999 }), EPOCH)).toBe(base);
  });

  test('setId / setName change', () => {
    const c = baseCluster();
    c.outcomeSets = c.outcomeSets.map((os) => ({ ...os, setId: os.setId + 500, setName: `${os.setName}-renamed` }));
    expect(structureKey(c, EPOCH)).toBe(base);
  });

  test('hard-edge confidence / basisRisk / edgeId change', () => {
    const c = baseCluster();
    c.edges = [
      mkEdge(777, 1, 4, 'strict_implication', { confidence: 0.123, basisRisk: 'high' as any }),
      mkEdge(888, 2, 5, 'mutual_exclusion', { confidence: 0.5 }),
    ];
    expect(structureKey(c, EPOCH)).toBe(base);
  });

  test('adding a SOFT edge (near_equivalence) → no change', () => {
    const c = baseCluster();
    c.edges = [...c.edges, mkEdge(3, 3, 6, 'near_equivalence')];
    expect(structureKey(c, EPOCH)).toBe(base);
  });

  test('adding a NON-deterministic edge → no change', () => {
    const c = baseCluster();
    c.edges = [...c.edges, mkEdge(4, 3, 6, 'strict_implication', { deterministic: false })];
    expect(structureKey(c, EPOCH)).toBe(base);
  });

  test('QuestionNode content (subject/markets) change → no change', () => {
    const c = baseCluster();
    for (const q of c.questions.values()) {
      q.canonicalSubject = 'MUTATED';
      q.markets.set(9000 + q.questionId, { marketId: 9000 + q.questionId, platform: PLAT, platformId: 'x' });
    }
    expect(structureKey(c, EPOCH)).toBe(base);
  });
});

// ── (d)/(e) incremental finalize ──────────────────────────────────────────────
// Three DISCONNECTED clusters, each a 3-slot exhaustive categorical (3 states each).
function threeClusterGraph(bExhaustive = true): ConstraintGraph {
  const questions = new Map<number, QuestionNode>();
  for (let i = 1; i <= 9; i++) questions.set(i, mkQ(i));
  const outcomeSets: OutcomeSetRef[] = [
    { setId: 1, setType: 'categorical', setName: 'A', slotQuestionIds: [1, 2, 3], isExhaustive: true },
    { setId: 2, setType: 'categorical', setName: 'B', slotQuestionIds: [4, 5, 6], isExhaustive: bExhaustive },
    { setId: 3, setType: 'categorical', setName: 'C', slotQuestionIds: [7, 8, 9], isExhaustive: true },
  ];
  return { questions, outcomeSets, edges: [] };
}

describe('finalizeClustersIncremental', () => {
  const cfg = config;

  test('(d) no-op reuse: 100% reused, states reference-identical', () => {
    const graph = threeClusterGraph();
    const cache = new EnumCache();

    const r1 = finalizeClustersIncremental(graph, cfg, null, cache);
    const s1 = lastIncrementalFinalizeStats();
    expect(s1.reused).toBe(0);
    expect(s1.enumerated).toBe(r1.clusters.length);
    expect(r1.clusters.length).toBe(3);

    // Second pass over the SAME graph → every structure key hits.
    const r2 = finalizeClustersIncremental(graph, cfg, null, cache);
    const s2 = lastIncrementalFinalizeStats();
    expect(s2.reused).toBe(r2.clusters.length);
    expect(s2.enumerated).toBe(0);
    expect(s2.evicted).toBe(0);

    // Reference-identical validStates (cache restores the SAME array object).
    for (let i = 0; i < r1.clusters.length; i++) {
      expect(r2.clusters[i].validStates).toBe(r1.clusters[i].validStates);
      expect(r2.clusters[i].validStates.length).toBe(3);
    }

    // …and VALUE-identical to a fresh full finalize.
    const full = finalizeClusters(graph, cfg, null);
    for (let i = 0; i < full.clusters.length; i++) {
      expect(r1.clusters[i].validStates).toEqual(full.clusters[i].validStates);
    }
  });

  test('(e) mutate one cluster → only it re-enumerates, rest reuse, evict stale', () => {
    const cache = new EnumCache();
    finalizeClustersIncremental(threeClusterGraph(true), cfg, null, cache);
    expect(lastIncrementalFinalizeStats().enumerated).toBe(3);
    const sizeAfterFirst = cache.size;
    expect(sizeAfterFirst).toBe(3);

    // Flip cluster B's set to Σ≤1 (adds the all-FALSE world: 3 → 4 states). Only B's
    // key changes; A and C are byte-identical structures → reuse.
    const graph2 = threeClusterGraph(false);
    const r2 = finalizeClustersIncremental(graph2, cfg, null, cache);
    const s2 = lastIncrementalFinalizeStats();
    expect(s2.reused).toBe(2);
    expect(s2.enumerated).toBe(1);
    expect(s2.evicted).toBe(1); // B's OLD key no longer seen → swept
    expect(cache.size).toBe(3); // A, C (unchanged) + B (new key)

    // The mutated cluster (B = questions 4,5,6) now matches a fresh full finalize.
    const full = finalizeClusters(graph2, cfg, null);
    const bIdx = r2.clusters.findIndex((c) => c.questions.has(4));
    expect(r2.clusters[bIdx].validStates.length).toBe(4);
    const fullB = full.clusters.find((c) => c.questions.has(4))!;
    expect(r2.clusters[bIdx].validStates).toEqual(fullB.validStates);
  });
});
