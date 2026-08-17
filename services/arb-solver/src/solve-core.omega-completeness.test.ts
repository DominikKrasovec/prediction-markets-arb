/**
 * Ω gap-state completeness inside `finalizeClusters`.
 *
 * `checkOmegaCompleteness` (unit-tested in solver/state-enumerator.test.ts) is only
 * useful if the finalize path ACTS on it. The contract asserted here:
 *   - a repairable cluster (over-claimed exhaustive set leaving a question pinned) is
 *     DEMOTED to Σ≤1 in place — states re-enumerated, `outcomeSets` rewritten so the
 *     facet LP and the tick-time L2 path see the same loosened Ω — and is NOT degenerate;
 *   - the demotion writes COPIES: the shared graph-level OutcomeSetRef is untouched;
 *   - an unrepairable one (mutex across threshold rungs — no exhaustive set to blame)
 *     is marked DEGENERATE and never solved;
 *   - a genuine one-hot is untouched;
 *   - the enum-cache replays the demotion onto a fresh cluster on a HIT.
 */
import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { ConstraintGraph, QuestionNode, MarketRef, OutcomeSetRef, EdgeRef } from './graph/types.js';
import { config } from './config.js';
import { finalizeClusters, finalizeClustersIncremental } from './solve-core.js';
import { EnumCache } from './graph/enum-cache.js';

const PLAT: Platform = 'kalshi';

function q(id: number): QuestionNode {
  const node: QuestionNode = {
    questionId: id, canonicalSubject: `q${id}`, conditionShape: null,
    conditionValue: null, conditionDate: null, markets: new Map(),
  };
  const m: MarketRef = { marketId: id, platform: PLAT, platformId: `m${id}` };
  node.markets.set(id, m);
  return node;
}

function edge(edgeId: number, a: number, b: number, edgeType: string): EdgeRef {
  return { edgeId, antecedentQuestionId: a, consequentQuestionId: b, edgeType, confidence: 1, deterministic: true, basisRisk: null };
}

function graphOf(qids: number[], outcomeSets: OutcomeSetRef[], edges: EdgeRef[] = []): ConstraintGraph {
  return { questions: new Map(qids.map((i) => [i, q(i)])), outcomeSets, edges };
}

/** Spread rungs {1,2} declared exhaustive + a moneyline question 3 both rungs imply. */
function spreadGraph(): { graph: ConstraintGraph; set: OutcomeSetRef } {
  const set: OutcomeSetRef = {
    setId: 1, setType: 'categorical', setName: 'spread rungs',
    slotQuestionIds: [1, 2], isExhaustive: true,
  };
  return {
    graph: graphOf([1, 2, 3], [set], [
      edge(11, 1, 3, 'strict_implication'),
      edge(12, 2, 3, 'strict_implication'),
    ]),
    set,
  };
}

describe('finalizeClusters — P7 Ω-completeness repair', () => {
  test('over-claimed exhaustive set is DEMOTED in place; cluster stays solvable', () => {
    const { graph, set } = spreadGraph();
    const { clusters } = finalizeClusters(graph, config, null);
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;

    expect(c.degenerate).toBeFalsy();
    expect(c.omegaCompletenessDemotedSetIds).toEqual([1]);
    // The cluster's own set ref reads Σ≤1 now …
    expect(c.outcomeSets.find((os) => os.setId === 1)!.isExhaustive).toBe(false);
    // … while the SHARED graph object is untouched (other clusters must not be mutated).
    expect(set.isExhaustive).toBe(true);

    // The gap world (both rungs FALSE, moneyline FALSE) is enumerated.
    expect(c.validStates).toHaveLength(4);
    expect(c.validStates.some((s) => s.get(1) === false && s.get(2) === false && s.get(3) === false)).toBe(true);
    // …and with it, no question is pinned any more.
    expect(c.pinnedQuestions ?? []).toHaveLength(0);
  });

  test('unrepairable pin (mutex across threshold rungs) → DEGENERATE, never solved', () => {
    const chain: OutcomeSetRef = {
      setId: 5, setType: 'threshold_series', setName: 'ladder', slotQuestionIds: [1, 2],
    };
    const graph = graphOf([1, 2], [chain], [edge(21, 1, 2, 'mutual_exclusion')]);
    const { clusters } = finalizeClusters(graph, config, null);
    const c = clusters[0]!;
    expect(c.degenerate).toBe(true);
    expect(c.omegaCompletenessDemotedSetIds).toBeUndefined();
  });

  test('genuine one-hot: no repair, no degeneracy, states unchanged', () => {
    const set: OutcomeSetRef = {
      setId: 1, setType: 'categorical', setName: 'negRisk field',
      slotQuestionIds: [1, 2, 3], isExhaustive: true,
    };
    const { clusters } = finalizeClusters(graphOf([1, 2, 3], [set]), config, null);
    const c = clusters[0]!;
    expect(c.degenerate).toBeFalsy();
    expect(c.omegaCompletenessDemotedSetIds).toBeUndefined();
    expect(c.outcomeSets[0]!.isExhaustive).toBe(true);
    expect(c.validStates).toHaveLength(3);
  });

  test('enum-cache HIT replays the demotion onto the fresh cluster object', () => {
    const cache = new EnumCache();
    // First build: MISS → repairs and caches.
    const a = finalizeClustersIncremental(spreadGraph().graph, config, null, cache);
    expect(a.clusters[0]!.omegaCompletenessDemotedSetIds).toEqual([1]);
    // Second build from a STRUCTURALLY IDENTICAL graph: HIT → the fresh cluster's
    // outcomeSets must be re-demoted, or the facet LP would read Σ=1 while the cached
    // states encode Σ≤1.
    const b = finalizeClustersIncremental(spreadGraph().graph, config, null, cache);
    const c = b.clusters[0]!;
    expect(c.outcomeSets.find((os) => os.setId === 1)!.isExhaustive).toBe(false);
    expect(c.omegaCompletenessDemotedSetIds).toEqual([1]);
    expect(c.validStates).toHaveLength(4);
  });
});
