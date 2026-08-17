import type { Cluster, WorldState } from '../graph/types.js';
import { createLogger } from '@arb/logger';
import { interpretCluster, projectedStateCount, edgeIsHard, type OmegaConstraint } from './omega-constraints.js';

export { edgeIsHard };

const log = createLogger('solver:state-enum');

const MAX_VALID_STATES = 10_000;

export interface EnumerateOptions {
  /** Hard cap on candidate/free states before a cluster is dropped. */
  maxStates?: number;
  /** Soft cap (question count) above which a DROP-PREVIEW warn is considered. */
  clusterSizeCap?: number;
}

// `ok` un-truncated; `dropped` projection exceeded cap before allocation; `empty` no questions.
export type EnumerationOutcome =
  | { kind: 'ok'; states: WorldState[] }
  | { kind: 'dropped'; projected: number; cause: 'free-2^n' | 'cartesian'; freeCount: number; setBreakdown: string[] }
  | { kind: 'empty' };

// Pre-flight projection rejects a too-large cluster before ever calling cartesianProduct/freeStates.
export function enumerateStatesMeta(cluster: Cluster, opts: EnumerateOptions = {}): EnumerationOutcome {
  const cap = opts.maxStates ?? MAX_VALID_STATES;
  if (cluster.questions.size === 0) return { kind: 'empty' };

  // NO isUnquoted here: the V-rep load-time enumeration must not self-apply the Ω-liveness L2 demotion.
  const interp = interpretCluster(cluster);
  const { setBreakdown, bundleFallThroughSlots } = interp.diagnostics;

  const groups: WorldState[][] = [];
  const hardEdges: Array<Extract<OmegaConstraint, { kind: 'hard_edge' }>> = [];
  for (const c of interp.constraints) {
    if (c.kind === 'one_hot') groups.push(categoricalStates(c.slots, c.exhaustive));
    else if (c.kind === 'threshold_chain') groups.push(thresholdStates(c.slots));
    else hardEdges.push(c);
  }

  const freeQids = interp.freeQids;
  const freeCount = freeQids.length;
  // guard the `1 << freeCount` overflow with `freeCount > 30` FIRST (n >= 31 wraps to 0/negative).
  const freeTooLarge = (freeCount > 30 ? Infinity : 1 << freeCount) > cap;

  if (freeTooLarge) {
    log.warn(
      `Cluster ${cluster.id} DROP-PREVIEW: ${cluster.questions.size} questions, ` +
        `${freeCount} free → 2^${freeCount} exceeds cap ${cap}` +
        (bundleFallThroughSlots > 0
          ? ` (incl ${bundleFallThroughSlots} bundle/tournament slot(s) treated as free)`
          : '') +
        ` | sets[${setBreakdown.join(',')}]`,
    );
  }

  const projected = projectedStateCount(interp);

  if (freeTooLarge || projected > cap) {
    const cause: 'free-2^n' | 'cartesian' = freeTooLarge ? 'free-2^n' : 'cartesian';
    log.warn(
      `Cluster ${cluster.id} DROPPED: ${cluster.questions.size} questions; ` +
        `cause=${cause} projected=${projected} > cap ${cap} | ` +
        `free=${freeCount} sets[${setBreakdown.join(',')}]`,
    );
    return { kind: 'dropped', projected, cause, freeCount, setBreakdown };
  }

  if (freeCount > 0) groups.push(freeStates(freeQids, cap));

  if (groups.length === 0) {
    return { kind: 'ok', states: freeStates([...cluster.questions.keys()], cap) };
  }

  const candidates = cartesianProduct(groups, cap).filter(state => satisfiesEdges(state, hardEdges));
  return { kind: 'ok', states: candidates };
}

// Thin wrapper over enumerateStatesMeta; `dropped`/`empty` return [] (a recall hole, never a fake arb).
export function enumerateStates(cluster: Cluster, opts: EnumerateOptions = {}): WorldState[] {
  const r = enumerateStatesMeta(cluster, opts);
  return r.kind === 'ok' ? r.states : [];
}

// Categorical set: exhaustive (Σ=1) → k one-hot states; non-exhaustive (Σ≤1) also appends all-FALSE. `isExhaustive` defaults false.
function categoricalStates(slotQids: number[], isExhaustive = false): WorldState[] {
  const states: WorldState[] = [];
  for (let i = 0; i < slotQids.length; i++) {
    const state: WorldState = new Map();
    for (let j = 0; j < slotQids.length; j++) {
      state.set(slotQids[j], i === j);
    }
    states.push(state);
  }
  if (!isExhaustive) {
    const none: WorldState = new Map();
    for (const qid of slotQids) none.set(qid, false);
    states.push(none);
  }
  return states;
}

// Threshold series [Q1 hardest ... Qk easiest]: k+1 states, slotQids ordered by slot_ordinal (0 = hardest).
function thresholdStates(slotQids: number[]): WorldState[] {
  const states: WorldState[] = [];
  const k = slotQids.length;

  for (let cutoff = 0; cutoff <= k; cutoff++) {
    const state: WorldState = new Map();
    for (let i = 0; i < k; i++) {
      state.set(slotQids[i], i >= k - cutoff);
    }
    states.push(state);
  }
  return states;
}

// Free questions: 2^n combinations; `n > 30` must short-circuit first (`1 << n` wraps at n>=31).
function freeStates(qids: number[], cap = MAX_VALID_STATES): WorldState[] {
  const n = qids.length;
  if (n > 30 || (1 << n) > cap) {
    return [];
  }
  const count = 1 << n;
  const states: WorldState[] = [];

  for (let mask = 0; mask < count; mask++) {
    const state: WorldState = new Map();
    for (let i = 0; i < n; i++) {
      state.set(qids[i], (mask & (1 << i)) !== 0);
    }
    states.push(state);
  }
  return states;
}

// Checks a world state against pre-filtered hard edges; the `undefined` endpoint check is a belt (dangling edges dropped upstream).
function satisfiesEdges(state: WorldState, edges: Array<Extract<OmegaConstraint, { kind: 'hard_edge' }>>): boolean {
  for (const e of edges) {
    const aVal = state.get(e.a);
    const bVal = state.get(e.b);
    if (aVal === undefined || bVal === undefined) continue;
    switch (e.type) {
      case 'strict_implication':
        if (aVal === true && bVal === false) return false;
        break;
      case 'equivalence':
        if (aVal !== bVal) return false;
        break;
      case 'mutual_exclusion':
        if (aVal === true && bVal === true) return false;
        break;
    }
  }
  return true;
}

// Ω-liveness L0: questions taking the same truth value in every valid state; a pin implies the cluster's Ω is mis-built.
export function computePinnedQuestions(cluster: Cluster): number[] {
  const states = cluster.validStates;
  if (states.length === 0) return [];
  const pinned: number[] = [];
  for (const qid of cluster.questions.keys()) {
    let first: boolean | undefined;
    let constant = true;
    for (const s of states) {
      const v = s.get(qid) ?? false;
      if (first === undefined) first = v;
      else if (v !== first) {
        constant = false;
        break;
      }
    }
    if (constant) pinned.push(qid);
  }
  return pinned;
}

function cartesianProduct(groups: WorldState[][], cap = MAX_VALID_STATES): WorldState[] {
  if (groups.length === 0) return [new Map()];

  let result: WorldState[] = [new Map()];

  for (const group of groups) {
    const newResult: WorldState[] = [];
    for (const existing of result) {
      for (const partial of group) {
        const combined: WorldState = new Map(existing);
        for (const [qid, val] of partial) {
          combined.set(qid, val);
        }
        newResult.push(combined);
        if (newResult.length > cap) return newResult; // bail; trips the `> cap` guard upstream
      }
    }
    result = newResult;
  }

  return result;
}
