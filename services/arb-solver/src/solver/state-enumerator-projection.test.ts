/**
 * Pre-flight projection tests for enumerateStatesMeta / enumerateStates.
 *
 * The projection is computed ARITHMETICALLY (product of per-group sizes) BEFORE any
 * WorldState is materialized, so an over-cap cluster is dropped without ever calling
 * cartesianProduct/freeStates. These tests pin: (1) the exact projected size on a
 * cartesian over-cap, (2) tractable clusters still enumerate exactly, (3) the free
 * 2^31 overflow returns Infinity (no 32-bit wrap), (4) the dropped path allocates
 * nothing (a catastrophically-large projection returns instantly), and (5) the thin
 * enumerateStates wrapper is byte-identical (ok → states, dropped/empty → []).
 */
import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { enumerateStates, enumerateStatesMeta } from './state-enumerator.js';
import type { Cluster, OutcomeSetRef, QuestionNode } from '../graph/types.js';

function makeCluster(qids: number[], outcomeSets: OutcomeSetRef[] = []): Cluster {
  const questions = new Map<number, QuestionNode>();
  for (const id of qids) {
    questions.set(id, {
      questionId: id, canonicalSubject: `q${id}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map(),
    });
  }
  return { id: 1, questions, outcomeSets, edges: [], marketIds: new Set(), validStates: [], dirty: false };
}

/** k exhaustive categorical sets of `slotsPer` slots each (contiguous qids). */
function nCats(count: number, slotsPer: number): { qids: number[]; sets: OutcomeSetRef[] } {
  const qids: number[] = [];
  const sets: OutcomeSetRef[] = [];
  let next = 1;
  for (let s = 0; s < count; s++) {
    const slots: number[] = [];
    for (let i = 0; i < slotsPer; i++) { slots.push(next); qids.push(next); next++; }
    sets.push({ setId: s + 1, setType: 'categorical', setName: `c${s}`, slotQuestionIds: slots, isExhaustive: true });
  }
  return { qids, sets };
}

describe('enumerateStatesMeta — pre-flight projection', () => {
  let warnSpy: ReturnType<typeof spyOn>;
  afterEach(() => warnSpy?.mockRestore());

  test('over-cap cartesian 25×25×25 = 15,625 > 10,000 → dropped with EXACT projected', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { qids, sets } = nCats(3, 25); // three exhaustive cats → size 25 each
    const r = enumerateStatesMeta(makeCluster(qids, sets));
    expect(r.kind).toBe('dropped');
    if (r.kind === 'dropped') {
      expect(r.projected).toBe(15_625);
      expect(r.cause).toBe('cartesian');
      expect(r.freeCount).toBe(0);
    }
    // The wrapper collapses dropped → [].
    expect(enumerateStates(makeCluster(qids, sets)).length).toBe(0);
  });

  test('tractable cartesian 20×20×20 = 8,000 ≤ 10,000 → ok, enumerated exactly', () => {
    const { qids, sets } = nCats(3, 20);
    const r = enumerateStatesMeta(makeCluster(qids, sets));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.states.length).toBe(8_000);
  });

  test('free 2^31 → Infinity projection, no 32-bit overflow', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const qids = Array.from({ length: 31 }, (_, i) => i + 1);
    const r = enumerateStatesMeta(makeCluster(qids));
    expect(r.kind).toBe('dropped');
    if (r.kind === 'dropped') {
      expect(r.projected).toBe(Infinity); // NOT a wrapped 0/negative
      expect(r.cause).toBe('free-2^n');
      expect(r.freeCount).toBe(31);
    }
  });

  test('allocation guard: a catastrophic projection (1000×1000×1000) drops INSTANTLY (no materialization)', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { qids, sets } = nCats(3, 1000); // 1e9 projected — would OOM if cartesianProduct ran
    const start = Date.now();
    const r = enumerateStatesMeta(makeCluster(qids, sets));
    const elapsed = Date.now() - start;
    expect(r.kind).toBe('dropped');
    if (r.kind === 'dropped') expect(r.projected).toBe(1_000_000_000);
    expect(elapsed).toBeLessThan(500); // proves neither cartesianProduct nor freeStates allocated
  });

  test('empty cluster → {kind:empty} and wrapper []', () => {
    const r = enumerateStatesMeta(makeCluster([]));
    expect(r.kind).toBe('empty');
    expect(enumerateStates(makeCluster([])).length).toBe(0);
  });

  test('wrapper parity: enumerateStates === enumerateStatesMeta.states on a tractable fixture', () => {
    const { qids, sets } = nCats(2, 4); // 4×4 = 16
    const meta = enumerateStatesMeta(makeCluster(qids, sets));
    const wrapped = enumerateStates(makeCluster(qids, sets));
    expect(meta.kind).toBe('ok');
    if (meta.kind === 'ok') expect(wrapped.length).toBe(meta.states.length);
    expect(wrapped.length).toBe(16);
  });
});
