// Ω-CONSTRAINTS — single source of truth for how a cluster's typed structure
// is interpreted as the coherence constraints of K = conv(Ω); both the V-rep
// enumerator and the facet LP consume this one interpretation.
import type { Cluster, EdgeRef, WorldState } from '../graph/types.js';
import type { FacetConstraint } from './types.js';
import { createLogger } from '@arb/logger';

const log = createLogger('solver:omega-constraints');

// Heuristic / soft relations, always skipped (booleans would over-prune).
const SOFT_EDGE_TYPES = new Set(['near_equivalence', 'probabilistic', 'conditional']);
const loggedUnknownEdgeTypes = new Set<string>();
const loggedSelfEdges = new Set<number>();
const loggedDanglingEdges = new Set<number>();

function warnOnce(seen: Set<number>, edgeId: number, msg: string): void {
  if (seen.has(edgeId)) return;
  seen.add(edgeId);
  log.warn(msg);
}

// basis_risk is a downstream pricing concern, not a logical softener.
export function edgeIsHard(edge: EdgeRef): boolean {
  if (edge.deterministic !== true) return false;
  if (SOFT_EDGE_TYPES.has(edge.edgeType)) return false;
  return true;
}

// marketId → owning questionId. Single reverse-lookup, replaces five copies.
export function marketToQuestion(cluster: Cluster): Map<number, number> {
  const m = new Map<number, number>();
  for (const [qid, q] of cluster.questions) for (const mid of q.markets.keys()) m.set(mid, qid);
  return m;
}

export type OmegaConstraint =
  | { kind: 'one_hot'; setId: number; slots: number[]; exhaustive: boolean }
  | { kind: 'threshold_chain'; setId: number; slots: number[] }
  | { kind: 'hard_edge'; edgeId: number; type: 'strict_implication' | 'mutual_exclusion' | 'equivalence'; a: number; b: number };

export interface InterpretedCluster {
  constraints: OmegaConstraint[];
  freeQids: number[];
  diagnostics: { setBreakdown: string[]; bundleFallThroughSlots: number };
}

// opts.isUnquoted, when supplied, enables the Ω-liveness exhaustivity
// demotion; omit for the V-rep load-time interpretation.
export function interpretCluster(
  cluster: Cluster,
  opts?: { isUnquoted?: (qid: number) => boolean },
): InterpretedCluster {
  const isUnquoted = opts?.isUnquoted;
  const constraints: OmegaConstraint[] = [];
  const setBreakdown: string[] = [];
  let bundleFallThroughSlots = 0;
  const coveredBySet = new Set<number>();

  for (const os of cluster.outcomeSets) {
    const slotQids = os.slotQuestionIds.filter((qid) => cluster.questions.has(qid));
    if (slotQids.length === 0) continue;

    if (os.setType === 'categorical') {
      if (slotQids.length < 2) {
        setBreakdown.push(`cat#${os.setId}=free(${slotQids.length})`);
        continue;
      }
      for (const qid of slotQids) coveredBySet.add(qid);
      const exhaustive =
        (os.isExhaustive ?? false) &&
        slotQids.length === os.slotQuestionIds.length &&
        (isUnquoted ? !os.slotQuestionIds.some((q) => isUnquoted(q)) : true);
      constraints.push({ kind: 'one_hot', setId: os.setId, slots: slotQids, exhaustive });
      setBreakdown.push(`cat#${os.setId}=${slotQids.length}${exhaustive ? '' : '+none'}`);
    } else if (os.setType === 'threshold_series') {
      for (const qid of slotQids) coveredBySet.add(qid);
      constraints.push({ kind: 'threshold_chain', setId: os.setId, slots: slotQids });
      setBreakdown.push(`thr#${os.setId}=${slotQids.length + 1}`);
    } else {
      bundleFallThroughSlots += slotQids.length;
      setBreakdown.push(`${os.setType}#${os.setId}=free(${slotQids.length})`);
      log.warn(
        `Cluster ${cluster.id}: outcome set ${os.setId} type='${os.setType}' has no ` +
          `enumerator; treating its ${slotQids.length} slot(s) as free questions`,
      );
    }
  }

  for (const e of cluster.edges) {
    if (!edgeIsHard(e)) continue;
    if (e.antecedentQuestionId === e.consequentQuestionId) {
      warnOnce(
        loggedSelfEdges, e.edgeId,
        `interpretCluster: self-edge on question ${e.antecedentQuestionId} (edge ${e.edgeId}, type '${e.edgeType}'); skipping`,
      );
      continue;
    }
    if (!cluster.questions.has(e.antecedentQuestionId) || !cluster.questions.has(e.consequentQuestionId)) {
      warnOnce(
        loggedDanglingEdges, e.edgeId,
        `interpretCluster: dangling endpoint on edge ${e.edgeId} (antecedent ${e.antecedentQuestionId}, consequent ${e.consequentQuestionId} not in cluster); skipping`,
      );
      continue;
    }
    if (e.edgeType === 'strict_implication' || e.edgeType === 'mutual_exclusion' || e.edgeType === 'equivalence') {
      constraints.push({ kind: 'hard_edge', edgeId: e.edgeId, type: e.edgeType, a: e.antecedentQuestionId, b: e.consequentQuestionId });
    } else if (!loggedUnknownEdgeTypes.has(e.edgeType)) {
      loggedUnknownEdgeTypes.add(e.edgeType);
      log.warn(`interpretCluster: unknown edge_type '${e.edgeType}' (edge ${e.edgeId}); skipping (fail-open)`);
    }
  }

  const freeQids = [...cluster.questions.keys()].filter((qid) => !coveredBySet.has(qid));
  return { constraints, freeQids, diagnostics: { setBreakdown, bundleFallThroughSlots } };
}

// Exact upper bound on world-set size; the enumerator's pre-flight drop test.
export function projectedStateCount(interp: InterpretedCluster): number {
  let p = 1;
  for (const c of interp.constraints) {
    if (c.kind === 'one_hot') p *= c.exhaustive ? c.slots.length : c.slots.length + 1;
    else if (c.kind === 'threshold_chain') p *= c.slots.length + 1;
  }
  const f = interp.freeQids.length;
  p *= f > 30 ? Infinity : 1 << f; // 1<<f wraps at 32 bits
  return p;
}

export interface OmegaCompleteness {
  complete: boolean;
  incompleteQids: number[];
  offendingSetIds: number[];
}

// Every question must have both a TRUE and a FALSE state across the
// enumeration; a missing polarity is always evidence Ω is mis-built.
// Attributes it to Σ=1 sets containing (or one hard edge from) the incomplete
// question, so they can be demoted to Σ≤1. Precondition: states is complete
// (un-truncated).
export function checkOmegaCompleteness(
  interp: InterpretedCluster,
  states: WorldState[],
): OmegaCompleteness {
  if (states.length === 0) return { complete: true, incompleteQids: [], offendingSetIds: [] };

  const sawTrue = new Set<number>();
  const sawFalse = new Set<number>();
  const allQids = new Set<number>();
  for (const s of states) {
    for (const [qid, v] of s) {
      allQids.add(qid);
      if (v) sawTrue.add(qid);
      else sawFalse.add(qid);
    }
  }
  const incompleteQids: number[] = [];
  for (const qid of allQids) {
    if (!sawTrue.has(qid) || !sawFalse.has(qid)) incompleteQids.push(qid);
  }
  if (incompleteQids.length === 0) {
    return { complete: true, incompleteQids: [], offendingSetIds: [] };
  }

  const incomplete = new Set<number>(incompleteQids);
  const suspect = new Set<number>(incompleteQids);
  for (const c of interp.constraints) {
    if (c.kind !== 'hard_edge') continue;
    if (incomplete.has(c.a)) suspect.add(c.b);
    if (incomplete.has(c.b)) suspect.add(c.a);
  }
  const offendingSetIds: number[] = [];
  for (const c of interp.constraints) {
    if (c.kind !== 'one_hot' || !c.exhaustive) continue;
    if (c.slots.some((q) => suspect.has(q))) offendingSetIds.push(c.setId);
  }

  return { complete: false, incompleteQids, offendingSetIds };
}

// Translates constraints into K = conv(Ω) facet rows. Mechanical; all
// soundness demotions already happened in interpretCluster.
export function constraintsToFacets(interp: InterpretedCluster): FacetConstraint[] {
  const facets: FacetConstraint[] = [];
  for (const c of interp.constraints) {
    if (c.kind === 'one_hot') {
      facets.push({
        coeff: c.slots.map((q) => [q, 1] as [number, number]),
        rhs: 1,
        kind: c.exhaustive ? 'eq' : 'le',
      });
    } else if (c.kind === 'threshold_chain') {
      for (let i = 0; i + 1 < c.slots.length; i++) {
        facets.push({ coeff: [[c.slots[i], 1], [c.slots[i + 1], -1]], rhs: 0, kind: 'le' });
      }
    } else {
      switch (c.type) {
        case 'strict_implication':
          facets.push({ coeff: [[c.a, 1], [c.b, -1]], rhs: 0, kind: 'le' });
          break;
        case 'mutual_exclusion':
          facets.push({ coeff: [[c.a, 1], [c.b, 1]], rhs: 1, kind: 'le' });
          break;
        case 'equivalence':
          facets.push({ coeff: [[c.a, 1], [c.b, -1]], rhs: 0, kind: 'eq' });
          break;
      }
    }
  }
  return facets;
}

export interface HighsLike {
  solve(problem: string, options?: Record<string, unknown>): any;
}

// Any non-Optimal HiGHS status (incl. error) reads as infeasible.
export function facetsFeasible(facets: FacetConstraint[], qids: number[], highs: HighsLike): boolean {
  const qPos = new Map<number, number>();
  qids.forEach((q, i) => qPos.set(q, i));
  const lines: string[] = ['Minimize', '  obj: 0', 'Subject To'];
  facets.forEach((f, fi) => {
    const terms = f.coeff
      .filter(([q]) => qPos.has(q))
      .map(([q, c]) => `${c >= 0 ? '+' : ''}${c} z${qPos.get(q)}`)
      .join(' ');
    if (terms.length === 0) return;
    lines.push(`  f${fi}: ${terms} ${f.kind === 'le' ? '<=' : '='} ${f.rhs}`);
  });
  lines.push('Bounds');
  qids.forEach((_, i) => lines.push(`  0 <= z${i} <= 1`));
  lines.push('End');
  const raw = highs.solve(lines.join('\n'));
  return raw?.Status === 'Optimal';
}
