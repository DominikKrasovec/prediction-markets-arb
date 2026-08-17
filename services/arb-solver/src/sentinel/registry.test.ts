import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import type { ConstraintGraph, EdgeRef, QuestionNode } from '../graph/types.js';
import { buildWatchPairs, questionLabel } from './registry.js';

// ── Fixture graph ──

function q(
  id: number,
  subject: string,
  markets: Array<[marketId: number, platform: Platform]>,
  extra: Partial<QuestionNode> = {},
): QuestionNode {
  return {
    questionId: id,
    canonicalSubject: subject,
    conditionShape: null,
    conditionValue: null,
    conditionDate: null,
    ...extra,
    markets: new Map(
      markets.map(([marketId, platform]) => [
        marketId,
        { marketId, platform, platformId: `${platform}-${marketId}` },
      ]),
    ),
  };
}

function edge(
  edgeId: number,
  a: number,
  c: number,
  edgeType: string,
  confidence = 0.95,
): EdgeRef {
  return {
    edgeId,
    antecedentQuestionId: a,
    consequentQuestionId: c,
    edgeType,
    confidence,
    deterministic: true,
    basisRisk: null,
  };
}

function fixtureGraph(): ConstraintGraph {
  const questions = new Map<number, QuestionNode>();
  for (const node of [
    // Multi-platform question: PM + 2× Kalshi members.
    q(10, 'arsenal win epl', [
      [101, 'polymarket'],
      [102, 'kalshi'],
      [103, 'kalshi'],
    ]),
    // Equivalence-edge endpoints, single member each.
    q(20, 'btc above 100k', [[201, 'polymarket']], {
      conditionShape: 'monotonic_threshold',
      conditionValue: '100000',
      conditionDate: '2026-12-31',
    }),
    q(30, 'bitcoin >= $100,000', [[301, 'kalshi']]),
    // Multi-member equivalence endpoints (cap + cross-platform preference).
    q(40, 'real madrid win ucl', [
      [401, 'kalshi'],
      [402, 'polymarket'],
    ]),
    q(50, 'real madrid champions league', [[501, 'polymarket']]),
  ]) {
    questions.set(node.questionId, node);
  }

  const edges: EdgeRef[] = [
    edge(1, 20, 30, 'equivalence'),
    edge(2, 30, 20, 'equivalence'), // reversed duplicate → must dedupe
    edge(3, 40, 50, 'equivalence'),
    edge(4, 20, 30, 'mutual_exclusion'), // mutex (optional)
    edge(5, 20, 30, 'strict_implication'), // never paired
    edge(6, 20, 999, 'equivalence'), // endpoint missing from graph → skipped
  ];

  return { questions, outcomeSets: [], edges };
}

describe('buildWatchPairs', () => {
  test('extracts equivalence-edge pairs and dedupes reversed duplicates', () => {
    const pairs = buildWatchPairs(fixtureGraph(), { includeMemberFungibility: false });
    const eq = pairs.filter(p => p.kind === 'equiv-edge');
    // Edge 1 (20↔30): one 1×1 pair; edge 2 is its reverse → deduped.
    // Edge 3 (40↔50): 2×1 combos.   Edge 6: missing endpoint → skipped.
    const e1 = eq.filter(p => p.edgeId === 1);
    expect(e1).toHaveLength(1);
    expect(e1[0]!.mode).toBe('equal');
    expect([e1[0]!.legA.marketId, e1[0]!.legB.marketId].sort()).toEqual([201, 301]);
    expect([e1[0]!.legA.questionId, e1[0]!.legB.questionId].sort()).toEqual([20, 30]);
    expect(eq.some(p => p.edgeId === 2)).toBe(false);
    expect(eq.some(p => p.edgeId === 6)).toBe(false);
    expect(eq.filter(p => p.edgeId === 3)).toHaveLength(2);
  });

  test('equiv-edge cross product is capped, cross-platform combos first', () => {
    const pairs = buildWatchPairs(fixtureGraph(), {
      includeMemberFungibility: false,
      maxPairsPerEdge: 1,
    });
    const e3 = pairs.filter(p => p.edgeId === 3);
    expect(e3).toHaveLength(1);
    // 401 (kalshi) × 501 (polymarket) is cross-platform → preferred over
    // 402 (polymarket) × 501 (polymarket).
    expect(e3[0]!.legA.marketId).toBe(401);
    expect(e3[0]!.legB.marketId).toBe(501);
  });

  test('same-question multi-platform members become fungibility pairs (cross-platform only)', () => {
    const pairs = buildWatchPairs(fixtureGraph(), { includeEquivEdges: false });
    const fung = pairs.filter(p => p.kind === 'member-fungibility');
    const q10 = fung.filter(p => p.legA.questionId === 10);
    // (101 pm, 102 k) + (101 pm, 103 k); NOT (102 k, 103 k) same-platform.
    expect(q10).toHaveLength(2);
    const keys = q10.map(p => `${p.legA.marketId}-${p.legB.marketId}`).sort();
    expect(keys).toEqual(['101-102', '101-103']);
    // q40 also spans 2 platforms → 1 pair; single-member questions → none.
    const q40 = fung.filter(p => p.legA.questionId === 40);
    expect(q40).toHaveLength(1);
    expect(fung.every(p => p.legA.platform !== p.legB.platform)).toBe(true);
  });

  test('mutex pairs are off by default, opt-in with mode=mutex', () => {
    const dflt = buildWatchPairs(fixtureGraph());
    expect(dflt.some(p => p.kind === 'mutex-edge')).toBe(false);

    const withMux = buildWatchPairs(fixtureGraph(), { includeMutexEdges: true });
    const mux = withMux.filter(p => p.kind === 'mutex-edge');
    expect(mux).toHaveLength(1);
    expect(mux[0]!.mode).toBe('mutex');
    expect(mux[0]!.edgeId).toBe(4);
    expect([mux[0]!.legA.marketId, mux[0]!.legB.marketId].sort()).toEqual([201, 301]);
  });

  test('strict_implication edges are never paired', () => {
    const pairs = buildWatchPairs(fixtureGraph(), { includeMutexEdges: true });
    expect(pairs.some(p => p.edgeId === 5)).toBe(false);
  });

  test('labels come from question fields; marketTitles override when provided', () => {
    const graph = fixtureGraph();
    const noTitles = buildWatchPairs(graph, { includeMemberFungibility: false });
    const e1 = noTitles.find(p => p.edgeId === 1)!;
    expect(e1.legA.label).toBe('btc above 100k [monotonic_threshold 100000] @2026-12-31');
    expect(e1.legB.label).toBe('bitcoin >= $100,000');

    const titled = buildWatchPairs(graph, {
      includeMemberFungibility: false,
      marketTitles: new Map([[201, 'Will BTC trade above $100k by Dec 31?']]),
    });
    const e1t = titled.find(p => p.edgeId === 1)!;
    expect(e1t.legA.label).toBe('Will BTC trade above $100k by Dec 31?');
    expect(e1t.legB.label).toBe('bitcoin >= $100,000'); // fallback
  });

  test('pure: same graph + options → identical output', () => {
    const g = fixtureGraph();
    const a = buildWatchPairs(g, { includeMutexEdges: true });
    const b = buildWatchPairs(g, { includeMutexEdges: true });
    expect(a).toEqual(b);
    expect(a.map(p => p.pairId)).toEqual(b.map(p => p.pairId));
  });
});

describe('questionLabel', () => {
  test('subject only', () => {
    expect(questionLabel(q(1, 'arsenal win epl', []))).toBe('arsenal win epl');
  });
  test('subject + shape/value/date', () => {
    const node = q(2, 'btc', [], {
      conditionShape: 'monotonic_threshold',
      conditionValue: '100000',
      conditionDate: '2026-12-31',
    });
    expect(questionLabel(node)).toBe('btc [monotonic_threshold 100000] @2026-12-31');
  });
});
