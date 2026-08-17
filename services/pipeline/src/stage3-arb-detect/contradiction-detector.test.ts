/**
 * The heap-bounded cycle search.
 *
 * The detector packs the strict_implication graph into typed-array CSR and
 * runs an iterative colour-DFS per connected component, to stay heap-bounded
 * on a large edge set.
 *
 * The load-bearing claim is that componentization + iteration change nothing
 * about which cycles are reported: a directed walk cannot leave its
 * undirected component, and components are visited in ascending order of
 * their earliest root with roots keeping their original relative order.
 * These tests pin the implementation against a naive recursive reference.
 */
import { describe, test, expect } from 'bun:test';
import {
  buildStrictGraph,
  findStrictImplicationCycles,
  type CycleFinding,
} from './contradiction-detector.js';

type Triple = { id: number; antecedent_question_id: number; consequent_question_id: number };

const e = (id: number, a: number, c: number): Triple => ({
  id,
  antecedent_question_id: a,
  consequent_question_id: c,
});

/**
 * Naive reference — a verbatim transcription of the original recursive
 * detector (global `visited`, `stack`, `path`, cycle keyed by the sorted node
 * multiset, `edgeIdByPair` for the first hop, roots iterated in `adj`
 * insertion order).
 */
function naiveCycles(edges: Triple[]): CycleFinding[] {
  const adj = new Map<number, number[]>();
  const edgeIdByPair = new Map<string, number>();
  for (const x of edges) {
    if (!adj.has(x.antecedent_question_id)) adj.set(x.antecedent_question_id, []);
    adj.get(x.antecedent_question_id)!.push(x.consequent_question_id);
    edgeIdByPair.set(`${x.antecedent_question_id}:${x.consequent_question_id}`, x.id);
  }
  const out: CycleFinding[] = [];
  const visited = new Set<number>();
  const recorded = new Set<string>();
  const stack = new Set<number>();
  const path: number[] = [];

  function dfs(node: number): void {
    if (stack.has(node)) {
      const i = path.indexOf(node);
      if (i === -1) return;
      const cycle = path.slice(i).concat(node);
      const key = [...cycle].sort((a, b) => a - b).join(',');
      if (!recorded.has(key)) {
        recorded.add(key);
        const firstEdgeId = edgeIdByPair.get(`${cycle[0]}:${cycle[1]}`);
        if (firstEdgeId !== undefined) out.push({ firstEdgeId, nodes: cycle });
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    path.push(node);
    for (const next of adj.get(node) ?? []) dfs(next);
    path.pop();
    stack.delete(node);
  }
  for (const node of adj.keys()) if (!visited.has(node)) dfs(node);
  return out;
}

const norm = (cs: CycleFinding[]) =>
  cs.map((c) => `${c.firstEdgeId}|${c.nodes.join('>')}`).sort();

const run = (edges: Triple[]) => findStrictImplicationCycles(buildStrictGraph(edges));

describe('findStrictImplicationCycles — parity with the naive recursive detector', () => {
  test('acyclic chain: no cycles from either implementation', () => {
    const edges = [e(1, 10, 11), e(2, 11, 12), e(3, 12, 13)];
    expect(run(edges)).toHaveLength(0);
    expect(norm(run(edges))).toEqual(norm(naiveCycles(edges)));
  });

  test('single 3-cycle: same cycle, same first-hop edge id', () => {
    const edges = [e(1, 7, 8), e(2, 8, 9), e(3, 9, 7)];
    const got = run(edges);
    expect(got).toHaveLength(1);
    expect(got[0]!.nodes).toEqual([7, 8, 9, 7]);
    expect(got[0]!.firstEdgeId).toBe(1);
    expect(norm(got)).toEqual(norm(naiveCycles(edges)));
  });

  test('2-cycle (bidirectional pair) is reported once, closing node repeated', () => {
    const edges = [e(1, 4, 5), e(2, 5, 4)];
    const got = run(edges);
    expect(got).toHaveLength(1);
    expect(got[0]!.nodes).toEqual([4, 5, 4]);
    expect(norm(got)).toEqual(norm(naiveCycles(edges)));
  });

  test('self-loop closes on the deepest node and carries its own edge id', () => {
    const edges = [e(9, 3, 3)];
    const got = run(edges);
    expect(got).toHaveLength(1);
    expect(got[0]!.nodes).toEqual([3, 3]);
    expect(got[0]!.firstEdgeId).toBe(9);
    expect(norm(got)).toEqual(norm(naiveCycles(edges)));
  });

  test('THREE DISJOINT COMPONENTS — componentized DFS finds exactly the naive set', () => {
    // Component A: 3-cycle. Component B: acyclic tree. Component C: two overlapping
    // cycles sharing a node (only ONE per sorted node-multiset is recorded, by both).
    const edges = [
      e(1, 100, 101), e(2, 101, 102), e(3, 102, 100),          // A
      e(4, 200, 201), e(5, 200, 202), e(6, 201, 203),          // B
      e(7, 300, 301), e(8, 301, 300), e(9, 301, 302), e(10, 302, 301), // C
    ];
    expect(norm(run(edges))).toEqual(norm(naiveCycles(edges)));
    expect(run(edges).length).toBe(3);
  });

  test('interleaved component order in the edge list does not change the findings', () => {
    // Same graph as above, pages arriving interleaved (as a keyset stream can deliver).
    const interleaved = [
      e(1, 100, 101), e(4, 200, 201), e(7, 300, 301), e(2, 101, 102),
      e(5, 200, 202), e(8, 301, 300), e(3, 102, 100), e(6, 201, 203),
      e(9, 301, 302), e(10, 302, 301),
    ];
    expect(norm(run(interleaved))).toEqual(norm(naiveCycles(interleaved)));
  });

  test('a node reachable only as a consequent is never a DFS root (parity)', () => {
    const edges = [e(1, 50, 51), e(2, 51, 52), e(3, 52, 51)];
    expect(norm(run(edges))).toEqual(norm(naiveCycles(edges)));
  });

  test('deep chain (10k nodes) does not overflow the stack — the recursion bug', () => {
    const edges: Triple[] = [];
    for (let i = 0; i < 10_000; i++) edges.push(e(i + 1, i, i + 1));
    edges.push(e(100_001, 10_000, 0)); // close it into one giant cycle
    const got = run(edges);
    expect(got).toHaveLength(1);
    expect(got[0]!.nodes).toHaveLength(10_002);
  });
});

describe('buildStrictGraph — CSR shape', () => {
  test('offsets/targets/edgeIds are consistent and roots keep first-appearance order', () => {
    const g = buildStrictGraph([e(1, 5, 6), e(2, 7, 5), e(3, 5, 7)]);
    expect(g.nodeCount).toBe(3);
    expect([...g.roots].map((r) => g.qidOf[r])).toEqual([5, 7]);
    // node 5 has two out-edges (→6, →7); node 7 has one (→5); node 6 none.
    const outOf = (qid: number) => {
      const d = [...g.qidOf].indexOf(qid);
      const res: number[] = [];
      for (let i = g.offsets[d]!; i < g.offsets[d + 1]!; i++) res.push(g.qidOf[g.targets[i]!]!);
      return res;
    };
    expect(outOf(5)).toEqual([6, 7]);
    expect(outOf(7)).toEqual([5]);
    expect(outOf(6)).toEqual([]);
    expect(g.offsets[g.nodeCount]).toBe(3);
  });
});
