/**
 * Contradiction detection, runs after transitive closure. C1: A→B and B→A both
 * strict_implication (should be equivalence). C2: A→B strict_implication coexists
 * with A↔B mutual_exclusion. C3: a cycle in strict_implication. Records findings to
 * edge_contradictions; does not delete edges. C3 streams into typed-array CSR
 * adjacency and runs an iterative colour-DFS per union-find component (the graph is
 * too large for JS objects and too deep for a recursive DFS).
 */
import {
  getBidirectionalStrictPairs,
  getImplicationVsExclusionPairs,
  getStrictImplicationEdgePage,
  recordContradiction,
} from '../db/queries/edges.js';
import { createLogger } from '@arb/logger';
import { mapWithConcurrency } from '../util/concurrency.js';

const log = createLogger('contradiction-detector');

const CONTRADICTION_WRITE_CONCURRENCY = parseInt(process.env.CONTRADICTION_WRITE_CONCURRENCY ?? '16');

const EDGE_PAGE_SIZE = 500_000;
const PENDING_FLUSH_BATCH = 2_000;

interface PendingContradiction {
  edgeA: number;
  edgeB: number | null;
  kind: 'bidirectional_strict' | 'implication_vs_exclusion' | 'cycle';
  detail: string;
}

export interface ContradictionResult {
  bidirectionalStrict: number;
  implicationVsExclusion: number;
  cycles: number;
}

/** The strict_implication graph in compressed-sparse-row form over dense node indices;
 *  every array is a typed array, never a JS object graph. */
export interface StrictGraph {
  nodeCount: number;
  qidOf: Int32Array;
  offsets: Int32Array;
  targets: Int32Array;
  /** implication_edges.id parallel to {@link targets}. */
  edgeIds: Int32Array;
  /** dense indices with ≥1 outgoing edge, in first-appearance order (DFS roots). */
  roots: Int32Array;
}

/** Grow-doubling Int32 buffer. */
class Int32Buf {
  private buf: Int32Array;
  length = 0;
  constructor(initial = 1 << 16) {
    this.buf = new Int32Array(initial);
  }
  push(v: number): void {
    if (this.length === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }
  get(i: number): number {
    return this.buf[i]!;
  }
  view(): Int32Array {
    return this.buf.subarray(0, this.length);
  }
}

type EdgeTriple = { id: number; antecedent_question_id: number; consequent_question_id: number };

/** Incremental CSR builder: feeds one keyset page at a time. Dense indices are assigned
 *  in first-appearance order, fixing which cycle of an overlapping pair is reported. */
export class StrictGraphBuilder {
  private readonly dense = new Map<number, number>();
  private readonly qids = new Int32Buf();
  private readonly srcs = new Int32Buf();
  private readonly dsts = new Int32Buf();
  private readonly ids = new Int32Buf();
  private readonly rootSeen = new Set<number>();
  private readonly roots: number[] = [];

  private idx(qid: number): number {
    let d = this.dense.get(qid);
    if (d === undefined) {
      d = this.qids.length;
      this.dense.set(qid, d);
      this.qids.push(qid);
    }
    return d;
  }

  addPage(page: Iterable<EdgeTriple>): void {
    for (const t of page) {
      const a = this.idx(t.antecedent_question_id);
      const c = this.idx(t.consequent_question_id);
      this.srcs.push(a);
      this.dsts.push(c);
      this.ids.push(t.id);
      if (!this.rootSeen.has(a)) {
        this.rootSeen.add(a);
        this.roots.push(a);
      }
    }
  }

  build(): StrictGraph {
    const nodeCount = this.qids.length;
    const edgeCount = this.srcs.length;
    const offsets = new Int32Array(nodeCount + 1);
    for (let i = 0; i < edgeCount; i++) offsets[this.srcs.get(i) + 1]!++;
    for (let i = 0; i < nodeCount; i++) offsets[i + 1]! += offsets[i]!;
    const cursor = Int32Array.from(offsets.subarray(0, nodeCount));
    const targets = new Int32Array(edgeCount);
    const edgeIds = new Int32Array(edgeCount);
    for (let i = 0; i < edgeCount; i++) {
      const p = cursor[this.srcs.get(i)]!++;
      targets[p] = this.dsts.get(i);
      edgeIds[p] = this.ids.get(i);
    }
    return {
      nodeCount,
      qidOf: Int32Array.from(this.qids.view()),
      offsets,
      targets,
      edgeIds,
      roots: Int32Array.from(this.roots),
    };
  }
}

export function buildStrictGraph(triples: Iterable<EdgeTriple>): StrictGraph {
  const b = new StrictGraphBuilder();
  b.addPage(triples);
  return b.build();
}

/** A cycle finding in question ids (the closing node repeated, e.g. [7, 9, 12, 7]). */
export interface CycleFinding {
  /** implication_edges.id of the cycle's first hop (nodes[0] → nodes[1]). */
  firstEdgeId: number;
  nodes: number[];
}

/** Undirected connected components (union-find), used only to partition the DFS work —
 *  a directed walk cannot leave its undirected component, so this changes no finding. */
function componentsOf(g: StrictGraph): Int32Array {
  const parent = new Int32Array(g.nodeCount);
  const size = new Int32Array(g.nodeCount).fill(1);
  for (let i = 0; i < g.nodeCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]!]!;
      r = parent[r]!;
    }
    return r;
  };
  for (let n = 0; n < g.nodeCount; n++) {
    for (let e = g.offsets[n]!; e < g.offsets[n + 1]!; e++) {
      let a = find(n);
      let b = find(g.targets[e]!);
      if (a === b) continue;
      if (size[a]! < size[b]!) [a, b] = [b, a];
      parent[b] = a;
      size[a]! += size[b]!;
    }
  }
  const comp = new Int32Array(g.nodeCount);
  for (let i = 0; i < g.nodeCount; i++) comp[i] = find(i);
  return comp;
}

/** All distinct strict_implication cycles reachable from the graph's roots, found with
 *  an iterative colour DFS (no recursion) one connected component at a time. `visited`
 *  is global (each node expanded once); a cycle is reported once per sorted node
 *  multiset (so the same loop found from a different entry point isn't double-recorded). */
export function findStrictImplicationCycles(g: StrictGraph): CycleFinding[] {
  const out: CycleFinding[] = [];
  if (g.nodeCount === 0) return out;

  const comp = componentsOf(g);
  const byComponent = new Map<number, number[]>();
  for (const r of g.roots) {
    const c = comp[r]!;
    const bucket = byComponent.get(c);
    if (bucket) bucket.push(r);
    else byComponent.set(c, [r]);
  }

  const visited = new Uint8Array(g.nodeCount);
  const onStack = new Uint8Array(g.nodeCount);
  const posInPath = new Int32Array(g.nodeCount).fill(-1);
  const recorded = new Set<string>();

  const frameNode: number[] = [];
  const frameCursor: number[] = [];
  const path: number[] = [];
  /** edge id used to ENTER path[k] (path[0] has none). */
  const pathEdge: number[] = [];

  const enter = (node: number, viaEdgeId: number): void => {
    visited[node] = 1;
    onStack[node] = 1;
    posInPath[node] = path.length;
    path.push(node);
    pathEdge.push(viaEdgeId);
    frameNode.push(node);
    frameCursor.push(g.offsets[node]!);
  };

  const emitCycle = (backTo: number, viaEdgeId: number): void => {
    const i = posInPath[backTo]!;
    if (i < 0) return;
    const denseCycle = path.slice(i);
    denseCycle.push(backTo);
    const nodes = denseCycle.map((d) => g.qidOf[d]!);
    const key = [...nodes].sort((a, b) => a - b).join(',');
    if (recorded.has(key)) return;
    recorded.add(key);
    const firstEdgeId = i + 1 < path.length ? pathEdge[i + 1]! : viaEdgeId;
    out.push({ firstEdgeId, nodes });
  };

  for (const roots of byComponent.values()) {
    for (const root of roots) {
      if (visited[root]) continue;
      enter(root, -1);
      while (frameNode.length > 0) {
        const top = frameNode.length - 1;
        const node = frameNode[top]!;
        const cursor = frameCursor[top]!;
        if (cursor < g.offsets[node + 1]!) {
          frameCursor[top] = cursor + 1;
          const next = g.targets[cursor]!;
          const edgeId = g.edgeIds[cursor]!;
          if (onStack[next]) {
            emitCycle(next, edgeId);
          } else if (!visited[next]) {
            enter(next, edgeId);
          }
        } else {
          onStack[node] = 0;
          posInPath[node] = -1;
          path.pop();
          pathEdge.pop();
          frameNode.pop();
          frameCursor.pop();
        }
      }
    }
  }
  return out;
}

export async function runContradictionDetection(): Promise<ContradictionResult> {
  const result: ContradictionResult = {
    bidirectionalStrict: 0,
    implicationVsExclusion: 0,
    cycles: 0,
  };

  let pending: PendingContradiction[] = [];
  const flush = async (force = false): Promise<void> => {
    if (pending.length === 0 || (!force && pending.length < PENDING_FLUSH_BATCH)) return;
    const batch = pending;
    pending = [];
    await mapWithConcurrency(batch, CONTRADICTION_WRITE_CONCURRENCY, (p) =>
      recordContradiction(p.edgeA, p.edgeB, p.kind, p.detail),
    );
  };

  for (const r of await getBidirectionalStrictPairs()) {
    pending.push({
      edgeA: r.edge_a,
      edgeB: r.edge_b,
      kind: 'bidirectional_strict',
      detail: `Both directions strict_implication between ${r.lo} and ${r.hi} — should be equivalence`,
    });
    result.bidirectionalStrict++;
    await flush();
  }

  for (const r of await getImplicationVsExclusionPairs()) {
    pending.push({
      edgeA: r.mutex_id,
      edgeB: r.other_id,
      kind: 'implication_vs_exclusion',
      detail: `mutual_exclusion edge conflicts with ${r.other_type} on pair (${r.lo},${r.hi})`,
    });
    result.implicationVsExclusion++;
    await flush();
  }

  const builder = new StrictGraphBuilder();
  let afterId = 0;
  let streamed = 0;
  for (;;) {
    const page = await getStrictImplicationEdgePage(afterId, EDGE_PAGE_SIZE);
    if (page.length === 0) break;
    builder.addPage(page);
    streamed += page.length;
    afterId = page[page.length - 1]!.id;
    if (page.length < EDGE_PAGE_SIZE) break;
  }
  const graph = builder.build();
  log.info(
    `C3 graph: ${streamed} strict_implication edges over ${graph.nodeCount} questions ` +
    `(${graph.roots.length} roots)`,
  );

  for (const c of findStrictImplicationCycles(graph)) {
    pending.push({
      edgeA: c.firstEdgeId,
      edgeB: null,
      kind: 'cycle',
      detail: `strict_implication cycle through questions ${c.nodes.join(' → ')}`,
    });
    result.cycles++;
    await flush();
  }

  await flush(true);

  log.info(
    `bidirectional=${result.bidirectionalStrict} ` +
    `impl_vs_excl=${result.implicationVsExclusion} cycles=${result.cycles}`
  );
  return result;
}
