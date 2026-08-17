/**
 * Ω-constraints SoT unit tests: interpretCluster demotions, projectedStateCount,
 * and the facetsFeasible feasibility LP.
 */
import { describe, test, expect } from 'bun:test';
import type { Cluster, OutcomeSetRef, EdgeRef, QuestionNode } from '../graph/types.js';
import type { FacetConstraint } from './types.js';
import {
  interpretCluster,
  constraintsToFacets,
  projectedStateCount,
  facetsFeasible,
} from './omega-constraints.js';
import { getHiGHS } from './facet-lp.js';

function makeCluster(qids: number[], outcomeSets: OutcomeSetRef[] = [], edges: EdgeRef[] = []): Cluster {
  const questions = new Map<number, QuestionNode>();
  for (const id of qids) {
    questions.set(id, {
      questionId: id, canonicalSubject: `q${id}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map(),
    });
  }
  return { id: 1, questions, outcomeSets, edges, marketIds: new Set(), validStates: [], dirty: false };
}

describe('interpretCluster demotions', () => {
  test('exhaustive categorical, fully quoted, no isUnquoted → one_hot exhaustive', () => {
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3], isExhaustive: true };
    const interp = interpretCluster(makeCluster([1, 2, 3], [set]));
    expect(interp.constraints).toEqual([{ kind: 'one_hot', setId: 1, slots: [1, 2, 3], exhaustive: true }]);
    expect(constraintsToFacets(interp)[0].kind).toBe('eq');
  });

  test('Ω-liveness L2 demotion ONLY fires when isUnquoted is supplied', () => {
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3], isExhaustive: true };
    // No predicate → NOT demoted (V-rep load-time behavior).
    expect(interpretCluster(makeCluster([1, 2, 3], [set])).constraints[0]).toMatchObject({ exhaustive: true });
    // Predicate marking a slot dead → demoted to Σ≤1.
    const demoted = interpretCluster(makeCluster([1, 2, 3], [set]), { isUnquoted: (q) => q === 1 });
    expect(demoted.constraints[0]).toMatchObject({ exhaustive: false });
  });

  test('a lost declared slot demotes exhaustive even with isUnquoted absent', () => {
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 999], isExhaustive: true };
    expect(interpretCluster(makeCluster([1, 2], [set])).constraints[0]).toMatchObject({ exhaustive: false, slots: [1, 2] });
  });

  test('<2-slot categorical → free, no constraint', () => {
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1], isExhaustive: true };
    const interp = interpretCluster(makeCluster([1], [set]));
    expect(interp.constraints).toHaveLength(0);
    expect(interp.freeQids).toEqual([1]);
  });

  test('self / dangling / soft / non-det edges emit no hard_edge', () => {
    const mk = (a: number, b: number, t: string, det = true): EdgeRef => ({ edgeId: 1, antecedentQuestionId: a, consequentQuestionId: b, edgeType: t, confidence: 1, deterministic: det, basisRisk: null });
    expect(interpretCluster(makeCluster([1, 2], [], [mk(1, 1, 'mutual_exclusion')])).constraints).toHaveLength(0); // self
    expect(interpretCluster(makeCluster([1, 2], [], [mk(1, 9, 'equivalence')])).constraints).toHaveLength(0); // dangling
    expect(interpretCluster(makeCluster([1, 2], [], [mk(1, 2, 'near_equivalence')])).constraints).toHaveLength(0); // soft
    expect(interpretCluster(makeCluster([1, 2], [], [mk(1, 2, 'strict_implication', false)])).constraints).toHaveLength(0); // non-det
    expect(interpretCluster(makeCluster([1, 2], [], [mk(1, 2, 'strict_implication')])).constraints).toHaveLength(1); // real
  });
});

describe('projectedStateCount', () => {
  test('exhaustive cat(k) → k; non-exhaustive → k+1; threshold → k+1; free → 2^f', () => {
    const exCat: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3], isExhaustive: true };
    expect(projectedStateCount(interpretCluster(makeCluster([1, 2, 3], [exCat])))).toBe(3);
    const neCat: OutcomeSetRef = { ...exCat, isExhaustive: false };
    expect(projectedStateCount(interpretCluster(makeCluster([1, 2, 3], [neCat])))).toBe(4);
    const thr: OutcomeSetRef = { setId: 2, setType: 'threshold_series', setName: 't', slotQuestionIds: [1, 2, 3] };
    expect(projectedStateCount(interpretCluster(makeCluster([1, 2, 3], [thr])))).toBe(4);
    expect(projectedStateCount(interpretCluster(makeCluster([1, 2, 3, 4])))).toBe(16); // 2^4 free
  });

  test('free > 30 → Infinity (no 32-bit wrap)', () => {
    const qids = Array.from({ length: 31 }, (_, i) => i + 1);
    expect(projectedStateCount(interpretCluster(makeCluster(qids)))).toBe(Infinity);
  });
});

describe('facetsFeasible', () => {
  test('feasible region (single mutex) → true; contradictory (z=1 ∧ z≤0) → false', async () => {
    const highs = await getHiGHS();
    const feasible: FacetConstraint[] = [{ coeff: [[1, 1], [2, 1]], rhs: 1, kind: 'le' }];
    expect(facetsFeasible(feasible, [1, 2], highs)).toBe(true);
    const infeasible: FacetConstraint[] = [
      { coeff: [[1, 1]], rhs: 1, kind: 'eq' },
      { coeff: [[1, 1]], rhs: 0, kind: 'le' },
    ];
    expect(facetsFeasible(infeasible, [1], highs)).toBe(false);
  });
});
