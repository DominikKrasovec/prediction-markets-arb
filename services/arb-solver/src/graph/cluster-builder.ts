import type { ConstraintGraph, Cluster, QuestionNode, OutcomeSetRef, EdgeRef } from './types.js';
import { createLogger } from '@arb/logger';

const log = createLogger('graph:cluster-builder');

/** Options for {@link buildClusters}. `clusterSizeCap` drives a warn-only
 * diagnostic only — it never changes component membership or merge behavior. */
export interface BuildClustersOptions {
  /** Soft cap (question count); clusters above it get an explosion-prone warn. */
  clusterSizeCap?: number;
}

/**
 * Decompose the constraint graph into connected components (clusters).
 * Two questions are connected if they share an implication edge or
 * are in the same outcome set.
 *
 * OBSERVABILITY: an extra Union-Find pass over edges logs only genuine
 * multi-node bridges (an edge joining two components that are each already
 * multi-node) so a single edge silently fusing two large sub-graphs is visible;
 * and each materialized cluster larger than `clusterSizeCap` gets a warn. Both
 * are log-only — the BFS / component membership below is unchanged (no
 * refuse-to-merge), so which clusters/arbs are produced is identical.
 */
export function buildClusters(graph: ConstraintGraph, opts: BuildClustersOptions = {}): Cluster[] {
  const cap = opts.clusterSizeCap ?? Infinity;
  const questionIds = [...graph.questions.keys()];
  if (questionIds.length === 0) return [];

  // Bridge diagnostic (Union-Find over edges only)
  // Outcome-set cliques merge their slots trivially (they were never separate),
  // so the interesting "two large things fused by one edge" signal lives in the
  // edge set. This pass mutates nothing the BFS depends on; it only logs.
  {
    const parent = new Map<number, number>();
    const compSize = new Map<number, number>();
    for (const qid of questionIds) {
      parent.set(qid, qid);
      compSize.set(qid, 1);
    }
    const ensureUf = (qid: number) => {
      if (!parent.has(qid)) {
        parent.set(qid, qid);
        compSize.set(qid, 1);
      }
    };
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r)! !== r) r = parent.get(r)!;
      // path compression
      let c = x;
      while (parent.get(c)! !== c) {
        const next = parent.get(c)!;
        parent.set(c, r);
        c = next;
      }
      return r;
    };
    // First fold outcome-set cliques (so a bridge is judged against the true
    // pre-edge component sizes, not artificially small singletons).
    for (const os of graph.outcomeSets) {
      const slots = os.slotQuestionIds;
      if (slots.length < 2) continue;
      for (const qid of slots) ensureUf(qid);
      const root0 = find(slots[0]);
      for (let i = 1; i < slots.length; i++) {
        const ri = find(slots[i]);
        if (ri === root0) continue;
        const s0 = compSize.get(root0)!;
        const si = compSize.get(ri)!;
        parent.set(ri, root0);
        compSize.set(root0, s0 + si);
      }
    }
    for (const edge of graph.edges) {
      ensureUf(edge.antecedentQuestionId);
      ensureUf(edge.consequentQuestionId);
      const ra = find(edge.antecedentQuestionId);
      const rb = find(edge.consequentQuestionId);
      if (ra === rb) continue;
      const sa = compSize.get(ra)!;
      const sb = compSize.get(rb)!;
      // Only a GENUINE multi-node bridge is worth surfacing: a lone edge fusing
      // two already-multi-node components. Singleton joins (sa==1 || sb==1) are
      // the common case and would spam the log.
      if (sa > 1 && sb > 1) {
        log.info(
          `edge #${edge.edgeId} bridges components (size ${sa} + ${sb}) → ${sa + sb}`,
        );
      }
      parent.set(ra, rb);
      compSize.set(rb, sa + sb);
    }
  }

  // Build adjacency list (undirected)
  const adj = new Map<number, Set<number>>();
  const ensureAdj = (qid: number) => {
    if (!adj.has(qid)) adj.set(qid, new Set());
  };

  for (const qid of questionIds) ensureAdj(qid);

  for (const edge of graph.edges) {
    ensureAdj(edge.antecedentQuestionId);
    ensureAdj(edge.consequentQuestionId);
    adj.get(edge.antecedentQuestionId)!.add(edge.consequentQuestionId);
    adj.get(edge.consequentQuestionId)!.add(edge.antecedentQuestionId);
  }

  // A demoted duplicate slot was dropped from its set, but its question must
  // stay in the same cluster as its twin: it becomes a free question so all
  // four (a,b) worlds enumerate, and the trigger belt needs both in one
  // cluster. The false mutex wall is gone (slot dropped), but the two are
  // still connected for clustering. Both endpoints were already co-slots of
  // one set, so this only preserves the pre-drop component — never a new
  // merge.
  for (const [a, b] of graph.duplicateSuspectPairs ?? []) {
    if (!adj.has(a) || !adj.has(b)) continue;
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }

  for (const os of graph.outcomeSets) {
    // Only connect slots whose question is a LIVE node. Outcome sets are loaded
    // without a liveness filter (unlike edges), so a slot can reference an
    // archived/expired/resolved question absent from the questions map (hence
    // from `adj`) — filter to `adj.has(qid)` before dereferencing. This matches
    // the enumerator's own `cluster.questions.has(qid)` slot filter: non-live
    // slots cannot constrain anything, so they connect nothing.
    const live = os.slotQuestionIds.filter((qid) => adj.has(qid));
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        adj.get(live[i])!.add(live[j]);
        adj.get(live[j])!.add(live[i]);
      }
    }
  }

  // BFS to find connected components.
  //
  // PERF: record a `qid → clusterIndex` map during BFS and bucket edges / sets
  // / suspect-pairs into their component in a single pass each — O(V + E) —
  // rather than re-scanning the full graph.edges / graph.outcomeSets /
  // duplicateSuspectPairs arrays once per component. Within-cluster edge/set/
  // pair order is preserved by appending in each array's iteration order.
  const visited = new Set<number>();
  const compOf = new Map<number, number>(); // qid → cluster index (BFS discovery order)
  let clusterId = 0;

  // Per-cluster accumulators, indexed by cluster id (BFS discovery order).
  const compQuestions: Array<Map<number, QuestionNode>> = [];
  const compMarketIds: Array<Set<number>> = [];
  const edgeBuckets: EdgeRef[][] = [];
  const setBuckets: OutcomeSetRef[][] = [];
  const suspectBuckets: Array<Array<[number, number]>> = [];

  for (const startQuestionId of questionIds) {
    if (visited.has(startQuestionId)) continue;

    const idx = clusterId++;
    // Build cluster membership inline during BFS, in dequeue order, so the
    // `questions` Map insertion order and `marketIds` Set order are stable.
    const questions = new Map<number, QuestionNode>();
    const marketIds = new Set<number>();

    const queue = [startQuestionId];
    visited.add(startQuestionId);

    while (queue.length > 0) {
      const qid = queue.shift()!;
      compOf.set(qid, idx);
      const node = graph.questions.get(qid);
      if (node) {
        questions.set(qid, node);
        for (const mid of node.markets.keys()) {
          marketIds.add(mid);
        }
      }
      const neighbors = adj.get(qid);
      if (neighbors) {
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }
    }

    compQuestions.push(questions);
    compMarketIds.push(marketIds);
    edgeBuckets.push([]);
    setBuckets.push([]);
    suspectBuckets.push([]);
  }

  // Single-pass bucketing
  // Edge: keep iff both endpoints are in the same component; `undefined`
  // endpoints (not in any component) are excluded.
  for (const e of graph.edges) {
    const ca = compOf.get(e.antecedentQuestionId);
    if (ca !== undefined && ca === compOf.get(e.consequentQuestionId)) {
      edgeBuckets[ca].push(e);
    }
  }

  // Outcome set: attach iff any slot is in the component. A set's live slots
  // are all mutually connected by the clique above, so they share one
  // component; attaching once per distinct component its slots touch covers
  // the (practically unreachable) multi-component case too, at no extra cost.
  for (const os of graph.outcomeSets) {
    let first = -1;
    let extra: Set<number> | null = null;
    for (const qid of os.slotQuestionIds) {
      const c = compOf.get(qid);
      if (c === undefined) continue;
      if (first === -1) {
        first = c;
        setBuckets[c].push(os);
      } else if (c !== first) {
        if (extra === null) extra = new Set<number>([first]);
        if (!extra.has(c)) {
          extra.add(c);
          setBuckets[c].push(os);
        }
      }
    }
  }

  // Carry a duplicate-suspect pair into the cluster whose component contains
  // both endpoints. Push the original tuple reference (not a copy) so the
  // result is reference-identical.
  for (const pair of graph.duplicateSuspectPairs ?? []) {
    const ca = compOf.get(pair[0]);
    if (ca !== undefined && ca === compOf.get(pair[1])) {
      suspectBuckets[ca].push(pair);
    }
  }

  // Assemble clusters in BFS discovery order.
  const clusters: Cluster[] = [];
  for (let idx = 0; idx < clusterId; idx++) {
    const questions = compQuestions[idx];
    const clusterSuspects = suspectBuckets[idx];
    clusters.push({
      id: idx,
      questions,
      outcomeSets: setBuckets[idx],
      edges: edgeBuckets[idx],
      marketIds: compMarketIds[idx],
      validStates: [], // computed later by state-enumerator
      dirty: true,
      ...(clusterSuspects.length > 0 ? { duplicateSuspectPairs: clusterSuspects } : {}),
    });

    // Warn-only explosion-prone flag (no refuse-to-merge in Phase 0).
    if (questions.size > cap) {
      log.warn(
        `cluster ${idx} exceeds CLUSTER_SIZE_CAP: ${questions.size} > ${cap} ` +
          `(explosion-prone; likely to warn/drop in enumeration)`,
      );
    }
  }

  // Use reduce, NOT `Math.max(0, ...clusters.map(...))`. The spread pushes one
  // argument per cluster onto the call stack, and past V8's argument limit
  // that throws `RangeError: Maximum call stack size exceeded`. reduce has no
  // argument-count limit and is O(clusters) either way.
  const largestQuestions = clusters.reduce((m, c) => Math.max(m, c.questions.size), 0);
  log.info(
    `Built ${clusters.length} clusters from ${questionIds.length} questions ` +
    `(largest: ${largestQuestions} questions)`
  );

  return clusters;
}

/**
 * Build lookup: marketId → Cluster for routing price updates.
 */
export function buildMarketIndex(clusters: Cluster[]): Map<number, Cluster> {
  const index = new Map<number, Cluster>();
  for (const cluster of clusters) {
    for (const mid of cluster.marketIds) {
      index.set(mid, cluster);
    }
  }
  return index;
}
