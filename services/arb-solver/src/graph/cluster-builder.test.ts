/**
 * cluster-builder tests — focus on the observability additions:
 *   1. component membership / merge behavior is byte-identical with and without
 *      opts (the bridge log + size-cap warn are log-only, no refuse-to-merge);
 *   2. the Union-Find bridge log fires only for genuine multi-node merges
 *      (an edge fusing two already-multi-node components), not for singleton
 *      joins (which would spam the log);
 *   3. the per-cluster CLUSTER_SIZE_CAP warn fires when a cluster exceeds the cap.
 */
import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { buildClusters } from './cluster-builder.js';
import type { ConstraintGraph, OutcomeSetRef, EdgeRef, QuestionNode, Cluster } from './types.js';

function q(id: number): QuestionNode {
  return {
    questionId: id,
    canonicalSubject: `q${id}`,
    conditionShape: null,
    conditionValue: null,
    conditionDate: null,
    markets: new Map(),
  };
}

function edge(a: number, b: number, edgeId = a * 1000 + b): EdgeRef {
  return {
    edgeId,
    antecedentQuestionId: a,
    consequentQuestionId: b,
    edgeType: 'strict_implication',
    confidence: 1,
    deterministic: true,
    basisRisk: null,
  };
}

function makeGraph(qids: number[], outcomeSets: OutcomeSetRef[] = [], edges: EdgeRef[] = []): ConstraintGraph {
  const questions = new Map<number, QuestionNode>();
  for (const id of qids) questions.set(id, q(id));
  return { questions, outcomeSets, edges };
}

/** Normalize a cluster list into a comparable shape (sorted question id sets). */
function membership(graph: ConstraintGraph, opts?: { clusterSizeCap?: number }): number[][] {
  const clusters = opts ? buildClusters(graph, opts) : buildClusters(graph);
  return clusters
    .map(c => [...c.questions.keys()].sort((a, b) => a - b))
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

describe('buildClusters — component membership (unchanged by opts)', () => {
  test('two questions joined by a single edge → one cluster of 2', () => {
    const graph = makeGraph([1, 2], [], [edge(1, 2)]);
    const clusters = buildClusters(graph);
    expect(clusters.length).toBe(1);
    expect(clusters[0].questions.size).toBe(2);
  });

  test('disconnected questions → separate singleton clusters', () => {
    const graph = makeGraph([1, 2, 3]); // no edges, no sets
    const clusters = buildClusters(graph);
    expect(clusters.length).toBe(3);
    for (const c of clusters) expect(c.questions.size).toBe(1);
  });

  test('two 3-node outcome-set cliques bridged by one edge → one cluster of 6', () => {
    const setA: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [1, 2, 3] };
    const setB: OutcomeSetRef = { setId: 2, setType: 'categorical', setName: 'b', slotQuestionIds: [4, 5, 6] };
    const graph = makeGraph([1, 2, 3, 4, 5, 6], [setA, setB], [edge(3, 4)]);
    const clusters = buildClusters(graph);
    expect(clusters.length).toBe(1);
    expect(clusters[0].questions.size).toBe(6);
  });

  test('membership is byte-identical with and without opts', () => {
    const setA: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [1, 2, 3] };
    const setB: OutcomeSetRef = { setId: 2, setType: 'categorical', setName: 'b', slotQuestionIds: [4, 5, 6] };
    const graph = makeGraph([1, 2, 3, 4, 5, 6, 7], [setA, setB], [edge(3, 4)]);
    const withoutOpts = membership(graph);
    const withCap = membership(graph, { clusterSizeCap: 4 }); // cap below cluster size
    expect(withCap).toEqual(withoutOpts);
  });
});

describe('buildClusters — dangling outcome-set slots', () => {
  test('slot referencing a non-live question does NOT crash and does not enter any cluster', () => {
    // A slot can reference an archived/expired question absent from
    // graph.questions; the adjacency build must tolerate that.
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [1, 2, 999], isExhaustive: true };
    const graph = makeGraph([1, 2], [set]); // 999 is dangling
    const clusters = buildClusters(graph); // must not throw
    expect(clusters).toHaveLength(1);
    expect([...clusters[0].questions.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test('set whose slots are ALL dangling attaches to no cluster and does not crash', () => {
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [998, 999] };
    const graph = makeGraph([1], [set]);
    const clusters = buildClusters(graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].outcomeSets).toHaveLength(0);
  });

  test('dangling slot does not bridge two otherwise-separate live components', () => {
    // {1,2} and {3,4} are separate cliques; a set {2, 999, 3} whose only shared
    // members are live (2,3) WOULD legitimately bridge — but a set {2,999} plus
    // {999,3} must NOT bridge through the dead qid 999.
    const setA: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [1, 2, 999] };
    const setB: OutcomeSetRef = { setId: 2, setType: 'categorical', setName: 'b', slotQuestionIds: [999, 3, 4] };
    const graph = makeGraph([1, 2, 3, 4], [setA, setB]);
    const clusters = buildClusters(graph);
    const parts = clusters
      .map((c) => [...c.questions.keys()].sort((a, b) => a - b))
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    expect(parts).toEqual([[1, 2], [3, 4]]);
  });
});

describe('buildClusters — bridge log (genuine multi-node merges only)', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  const lines = (spy: ReturnType<typeof spyOn>): string[] =>
    (spy.mock.calls as unknown[][]).map(args => args.map(a => String(a)).join(' '));

  afterEach(() => {
    infoSpy?.mockRestore();
  });

  test('edge fusing two multi-node cliques logs a bridge (size 3 + 3 → 6)', () => {
    infoSpy = spyOn(console, 'log').mockImplementation(() => {}); // info → console.log
    const setA: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [1, 2, 3] };
    const setB: OutcomeSetRef = { setId: 2, setType: 'categorical', setName: 'b', slotQuestionIds: [4, 5, 6] };
    const graph = makeGraph([1, 2, 3, 4, 5, 6], [setA, setB], [edge(3, 4, 99)]);
    buildClusters(graph);
    const joined = lines(infoSpy).join('\n');
    expect(joined).toContain('edge #99 bridges components');
    expect(joined).toContain('size 3 + 3');
  });

  test('single edge between two singletons does NOT log a bridge (no spam)', () => {
    infoSpy = spyOn(console, 'log').mockImplementation(() => {});
    const graph = makeGraph([1, 2], [], [edge(1, 2)]);
    buildClusters(graph);
    const joined = lines(infoSpy).join('\n');
    expect(joined).not.toContain('bridges components');
  });

  test('edge joining a multi-node clique to a singleton does NOT log a bridge', () => {
    infoSpy = spyOn(console, 'log').mockImplementation(() => {});
    const setA: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [1, 2, 3] };
    const graph = makeGraph([1, 2, 3, 4], [setA], [edge(3, 4)]); // 4 is a singleton
    buildClusters(graph);
    const joined = lines(infoSpy).join('\n');
    expect(joined).not.toContain('bridges components');
  });
});

describe('buildClusters — single-pass bucketing parity (perf rewrite)', () => {
  /**
   * Reference oracle: the ORIGINAL per-component `.filter` logic, inlined here.
   * It re-derives connected components with the same BFS and then, for each
   * component, re-scans the full edges / outcomeSets / duplicateSuspectPairs
   * arrays — exactly what `buildClusters` did before the O(V+E) rewrite. The
   * new implementation must produce byte-identical clusters.
   */
  function referenceClusters(graph: ConstraintGraph): Cluster[] {
    const questionIds = [...graph.questions.keys()];
    if (questionIds.length === 0) return [];

    const adj = new Map<number, Set<number>>();
    const ensureAdj = (qid: number) => {
      if (!adj.has(qid)) adj.set(qid, new Set());
    };
    for (const qid of questionIds) ensureAdj(qid);
    for (const e of graph.edges) {
      ensureAdj(e.antecedentQuestionId);
      ensureAdj(e.consequentQuestionId);
      adj.get(e.antecedentQuestionId)!.add(e.consequentQuestionId);
      adj.get(e.consequentQuestionId)!.add(e.antecedentQuestionId);
    }
    for (const [a, b] of graph.duplicateSuspectPairs ?? []) {
      if (!adj.has(a) || !adj.has(b)) continue;
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }
    for (const os of graph.outcomeSets) {
      const live = os.slotQuestionIds.filter((qid) => adj.has(qid));
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          adj.get(live[i])!.add(live[j]);
          adj.get(live[j])!.add(live[i]);
        }
      }
    }

    const visited = new Set<number>();
    const clusters: Cluster[] = [];
    let clusterId = 0;
    for (const start of questionIds) {
      if (visited.has(start)) continue;
      const component = new Set<number>();
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const qid = queue.shift()!;
        component.add(qid);
        const neighbors = adj.get(qid);
        if (neighbors) for (const n of neighbors) if (!visited.has(n)) { visited.add(n); queue.push(n); }
      }
      const questions = new Map<number, QuestionNode>();
      const marketIds = new Set<number>();
      for (const qid of component) {
        const node = graph.questions.get(qid);
        if (node) { questions.set(qid, node); for (const mid of node.markets.keys()) marketIds.add(mid); }
      }
      const clusterEdges = graph.edges.filter(
        (e) => component.has(e.antecedentQuestionId) && component.has(e.consequentQuestionId),
      );
      const clusterSets = graph.outcomeSets.filter((os) =>
        os.slotQuestionIds.some((qid) => component.has(qid)),
      );
      const clusterSuspects = (graph.duplicateSuspectPairs ?? []).filter(
        ([a, b]) => component.has(a) && component.has(b),
      );
      const id = clusterId++;
      clusters.push({
        id,
        questions,
        outcomeSets: clusterSets,
        edges: clusterEdges,
        marketIds,
        validStates: [],
        dirty: true,
        ...(clusterSuspects.length > 0 ? { duplicateSuspectPairs: clusterSuspects } : {}),
      });
    }
    return clusters;
  }

  /** Compare two cluster lists field-by-field (the observable contract). */
  function assertParity(actual: Cluster[], expected: Cluster[]) {
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const a = actual[i];
      const e = expected[i];
      expect(a.id).toBe(e.id);
      // question ids (sorted set) + insertion order
      expect([...a.questions.keys()].sort((x, y) => x - y)).toEqual(
        [...e.questions.keys()].sort((x, y) => x - y),
      );
      expect([...a.questions.keys()]).toEqual([...e.questions.keys()]); // order
      // marketIds (sorted)
      expect([...a.marketIds].sort((x, y) => x - y)).toEqual(
        [...e.marketIds].sort((x, y) => x - y),
      );
      // edges — order + content (edgeIds in order)
      expect(a.edges.map((x) => x.edgeId)).toEqual(e.edges.map((x) => x.edgeId));
      expect(a.edges).toEqual(e.edges);
      // outcome sets — order + content (setIds in order)
      expect(a.outcomeSets.map((x) => x.setId)).toEqual(e.outcomeSets.map((x) => x.setId));
      expect(a.outcomeSets).toEqual(e.outcomeSets);
      // duplicate-suspect pairs
      expect(a.duplicateSuspectPairs ?? null).toEqual(e.duplicateSuspectPairs ?? null);
    }
  }

  test('non-trivial graph: multiple components, cross-cutting edges, multi-slot sets, boundary-spanning set, suspect pair', () => {
    // Component A: {1,2,3} via setA clique, plus edge 1↔2 (intra).
    // Component B: {4,5,6} via setB clique, plus edges 5↔6 (intra), 4↔5 (intra).
    // Component C: {7,8} via a lone edge.
    // Singletons: 9, 10.
    // A boundary set setC {2,3} lives entirely inside A (multi-slot).
    // A set setD {6} single-slot inside B. A dangling-slot set setE {8,999}.
    // Duplicate-suspect pairs: [2,3] (both in A → kept), [3,4] (A vs B → dropped),
    //   [7,8] (both in C → kept), [9, 999] (999 not live → dropped).
    const setA: OutcomeSetRef = { setId: 10, setType: 'categorical', setName: 'A', slotQuestionIds: [1, 2, 3] };
    const setB: OutcomeSetRef = { setId: 20, setType: 'categorical', setName: 'B', slotQuestionIds: [4, 5, 6] };
    const setC: OutcomeSetRef = { setId: 30, setType: 'categorical', setName: 'C', slotQuestionIds: [2, 3] };
    const setD: OutcomeSetRef = { setId: 40, setType: 'categorical', setName: 'D', slotQuestionIds: [6] };
    const setE: OutcomeSetRef = { setId: 50, setType: 'categorical', setName: 'E', slotQuestionIds: [8, 999] };
    const edges: EdgeRef[] = [
      edge(1, 2, 1002),
      edge(5, 6, 5006),
      edge(7, 8, 7008),
      edge(4, 5, 4005),
    ];
    const graph = makeGraph(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [setA, setB, setC, setD, setE],
      edges,
    );
    graph.duplicateSuspectPairs = [
      [2, 3],
      [3, 4],
      [7, 8],
      [9, 999],
    ];

    const actual = buildClusters(graph);
    const expected = referenceClusters(graph);
    assertParity(actual, expected);
  });

  test('parity holds when a set spans two components (.some multi-match case)', () => {
    // Two disjoint live cliques with NO connecting edge: {1,2} (setP) and {3,4}
    // (setQ). setR references {2,3} — but since there is an edge/clique path
    // ONLY within each set, 2 and 3 are in different components. Under the old
    // `.some` filter, setR would attach to BOTH clusters. Assert the rewrite
    // reproduces exactly that (whatever the oracle does).
    const setP: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'P', slotQuestionIds: [1, 2] };
    const setQ: OutcomeSetRef = { setId: 2, setType: 'categorical', setName: 'Q', slotQuestionIds: [3, 4] };
    const setR: OutcomeSetRef = { setId: 3, setType: 'categorical', setName: 'R', slotQuestionIds: [2, 3] };
    // NOTE: setR itself forms a clique connecting 2↔3, which WOULD merge the
    // components. To actually get a boundary-spanning set we must keep 2 and 3
    // apart — so we do NOT rely on setR's clique bridging (it does). This graph
    // therefore yields ONE component; parity must still hold either way.
    const graph = makeGraph([1, 2, 3, 4], [setP, setQ, setR]);
    const actual = buildClusters(graph);
    const expected = referenceClusters(graph);
    assertParity(actual, expected);
  });
});

describe('buildClusters — CLUSTER_SIZE_CAP warn', () => {
  let warnSpy: ReturnType<typeof spyOn>;
  const lines = (): string[] =>
    (warnSpy.mock.calls as unknown[][]).map(args => args.map(a => String(a)).join(' '));

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  test('cluster larger than clusterSizeCap fires an explosion-prone warn', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const setA: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [1, 2, 3] };
    const setB: OutcomeSetRef = { setId: 2, setType: 'categorical', setName: 'b', slotQuestionIds: [4, 5, 6] };
    const graph = makeGraph([1, 2, 3, 4, 5, 6], [setA, setB], [edge(3, 4)]); // one 6-node cluster
    buildClusters(graph, { clusterSizeCap: 4 });
    const joined = lines().join('\n');
    expect(joined).toContain('exceeds CLUSTER_SIZE_CAP');
    expect(joined).toContain('6 > 4');
  });

  test('no size-cap warn when cap is omitted (default Infinity)', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const setA: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'a', slotQuestionIds: [1, 2, 3] };
    const setB: OutcomeSetRef = { setId: 2, setType: 'categorical', setName: 'b', slotQuestionIds: [4, 5, 6] };
    const graph = makeGraph([1, 2, 3, 4, 5, 6], [setA, setB], [edge(3, 4)]);
    buildClusters(graph); // no opts
    const joined = lines().join('\n');
    expect(joined).not.toContain('exceeds CLUSTER_SIZE_CAP');
  });
});
