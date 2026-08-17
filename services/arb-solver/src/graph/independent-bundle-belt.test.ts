/**
 * Independent-bundle belt (solver-side runtime twin of the Stage-4
 * certifier's refusesNativeIndependentBundle gate).
 *
 * Covers an acquisitions bundle whose Kalshi children are natively
 * mutually_exclusive='false' (or PM/Kalshi bundle_nonexclusive): ≥2 can
 * co-resolve YES, so a persisted categorical Σ≤1 set over them is a fake
 * mutex the solver must drop. Regression cases prove the belt is inert on
 * every positive-mutex-authority set (negRisk / fixture-kind / numeric-tiling)
 * and on any set with no independence signal.
 */
import { describe, test, expect } from 'bun:test';
import {
  applyIndependentBundleBelt,
  refusesIndependentBundleSet,
  type IndepBundleFacts,
} from './independent-bundle-belt.js';
import type { ConstraintGraph, OutcomeSetRef, QuestionNode, MarketRef } from './types.js';

function qn(id: number): QuestionNode {
  const markets = new Map<number, MarketRef>();
  markets.set(id, { marketId: id, platform: 'kalshi', platformId: `p${id}` });
  return {
    questionId: id,
    canonicalSubject: `q${id}`,
    canonicalKey: `sem:1:q${id}`,
    conditionShape: null,
    conditionValue: null,
    conditionDate: null,
    markets,
  };
}

function catSet(setId: number, name: string, slotQuestionIds: number[]): OutcomeSetRef {
  return { setId, setType: 'categorical', setName: name, slotQuestionIds, isExhaustive: false };
}

function graphOf(questions: QuestionNode[], outcomeSets: OutcomeSetRef[] = []): ConstraintGraph {
  const m = new Map<number, QuestionNode>();
  for (const q of questions) m.set(q.questionId, q);
  return { questions: m, outcomeSets, edges: [] };
}

const facts = (o: Partial<IndepBundleFacts> = {}): IndepBundleFacts => ({
  nativeIndependent: o.nativeIndependent ?? false,
  hasNegrisk: o.hasNegrisk ?? false,
  hasFixtureKind: o.hasFixtureKind ?? false,
  hasValue: o.hasValue ?? false,
});

/** facts accessor from a plain map. */
const accessor = (m: Map<number, IndepBundleFacts>) => (qid: number) => m.get(qid);

describe('refusesIndependentBundleSet (pure predicate)', () => {
  test('≥2 native-independent slots, no mutex authority → TRUE (acquisitions bundle)', () => {
    const m = new Map<number, IndepBundleFacts>([
      [1, facts({ nativeIndependent: true })],
      [2, facts({ nativeIndependent: true })],
      [3, facts({ nativeIndependent: true })],
    ]);
    expect(refusesIndependentBundleSet([1, 2, 3], accessor(m))).toBe(true);
  });

  test('one native slot suffices (the others merely non-independent) → TRUE', () => {
    const m = new Map<number, IndepBundleFacts>([
      [1, facts({ nativeIndependent: true })],
      [2, facts()],
    ]);
    expect(refusesIndependentBundleSet([1, 2], accessor(m))).toBe(true);
  });

  test('REGRESSION: a negRisk leg (positive authority) → FALSE', () => {
    const m = new Map<number, IndepBundleFacts>([
      [1, facts({ nativeIndependent: true, hasNegrisk: true })],
      [2, facts({ nativeIndependent: true })],
    ]);
    expect(refusesIndependentBundleSet([1, 2], accessor(m))).toBe(false);
  });

  test('REGRESSION: a fixture-kind leg (positive authority) → FALSE', () => {
    const m = new Map<number, IndepBundleFacts>([
      [1, facts({ nativeIndependent: true, hasFixtureKind: true })],
      [2, facts({ nativeIndependent: true })],
    ]);
    expect(refusesIndependentBundleSet([1, 2], accessor(m))).toBe(false);
  });

  test('REGRESSION: a value-bearing leg (conservative tiling proxy) → FALSE', () => {
    const m = new Map<number, IndepBundleFacts>([
      [1, facts({ nativeIndependent: true, hasValue: true })],
      [2, facts({ nativeIndependent: true })],
    ]);
    expect(refusesIndependentBundleSet([1, 2], accessor(m))).toBe(false);
  });

  test('REGRESSION: no independence signal at all → FALSE (subtractive-safe on cap-unknown)', () => {
    const m = new Map<number, IndepBundleFacts>([
      [1, facts()],
      [2, facts()],
    ]);
    expect(refusesIndependentBundleSet([1, 2], accessor(m))).toBe(false);
  });

  test('<2 slots with loaded facts → FALSE (residuals/expired already dropped upstream)', () => {
    const m = new Map<number, IndepBundleFacts>([[1, facts({ nativeIndependent: true })]]);
    // qid 2 has no loaded facts (its markets were liveness-dropped) → only 1 counts.
    expect(refusesIndependentBundleSet([1, 2], accessor(m))).toBe(false);
  });
});

describe('applyIndependentBundleBelt (drops the set in place)', () => {
  test('acquisitions bundle → the categorical set is freed (dropped from graph)', () => {
    const g = graphOf([qn(1), qn(2), qn(3)], [catSet(368, 'Which company will be acquired?', [1, 2, 3])]);
    const m = new Map<number, IndepBundleFacts>([
      [1, facts({ nativeIndependent: true })],
      [2, facts({ nativeIndependent: true })],
      [3, facts({ nativeIndependent: true })],
    ]);
    const r = applyIndependentBundleBelt(g, accessor(m));
    expect(r.setsFreed).toBe(1);
    expect(r.freedSetIds).toEqual([368]);
    expect(g.outcomeSets.length).toBe(0); // dropped → slot questions become free
  });

  test('REGRESSION: a negRisk fixture one-hot is untouched', () => {
    const g = graphOf([qn(1), qn(2), qn(3)], [catSet(500, '1X2', [1, 2, 3])]);
    const m = new Map<number, IndepBundleFacts>([
      [1, facts({ hasNegrisk: true, hasFixtureKind: true })],
      [2, facts({ hasNegrisk: true, hasFixtureKind: true })],
      [3, facts({ hasNegrisk: true, hasFixtureKind: true })],
    ]);
    const r = applyIndependentBundleBelt(g, accessor(m));
    expect(r.setsFreed).toBe(0);
    expect(g.outcomeSets.length).toBe(1);
  });

  test('idempotent: a second run finds the set already gone', () => {
    const g = graphOf([qn(1), qn(2)], [catSet(368, 'acq', [1, 2])]);
    const m = new Map<number, IndepBundleFacts>([
      [1, facts({ nativeIndependent: true })],
      [2, facts({ nativeIndependent: true })],
    ]);
    applyIndependentBundleBelt(g, accessor(m));
    const r2 = applyIndependentBundleBelt(g, accessor(m));
    expect(r2.setsFreed).toBe(0);
  });
});
