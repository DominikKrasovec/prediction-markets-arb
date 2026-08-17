/**
 * relaxedRecheckFacet: the facet-LP L4 recheck for over-capped clusters.
 * Mirrors relaxedRecheck's relaxation rules but minimizes the basket's affine payoff
 * over the relaxed FACET region (R' ⊇ conv(Ω_relaxed)) — conservative one-sided error.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode, OutcomeSetRef, EdgeRef } from '../graph/types.js';
import type { AuditPosition } from './omega-audit.js';
import { relaxedRecheck, relaxedRecheckFacet } from './omega-audit.js';
import { getHiGHS, tryGetLoadedHiGHS } from './facet-lp.js';

const PLAT: Platform = 'kalshi';
const OPTS = { maxStates: 10_000, clusterSizeCap: 200 };

function mkCluster(qids: number[], sets: OutcomeSetRef[] = [], edges: EdgeRef[] = []): Cluster {
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  for (const id of qids) {
    const q: QuestionNode = {
      questionId: id, canonicalSubject: `q${id}`, conditionShape: null,
      conditionValue: null, conditionDate: null, markets: new Map(),
    };
    const m: MarketRef = { marketId: id, platform: PLAT, platformId: `m${id}` };
    q.markets.set(id, m);
    questions.set(id, q);
    marketIds.add(id);
  }
  return { id: 1, questions, outcomeSets: sets, edges, marketIds, validStates: [], dirty: true };
}
const cat = (setId: number, slots: number[], ex: boolean): OutcomeSetRef => ({ setId, setType: 'categorical', setName: `c${setId}`, slotQuestionIds: slots, isExhaustive: ex });
const mutex = (a: number, b: number): EdgeRef => ({ edgeId: 1, antecedentQuestionId: a, consequentQuestionId: b, edgeType: 'mutual_exclusion', confidence: 1, deterministic: true, basisRisk: null });

describe('relaxedRecheckFacet', () => {
  beforeAll(async () => { await getHiGHS(); }); // warm the shared HiGHS instance

  test('(a) trivial-skip parity: no dropped constraint touches a traded question → skipped', () => {
    const c = mkCluster([1, 2, 3, 4], [cat(1, [1, 2], false), cat(2, [3, 4], false)]);
    const positions: AuditPosition[] = [{ marketId: 1, side: 'YES', shares: 1 }]; // trades q1 only
    const unquoted = new Set([3]); // dead slot in set B (does NOT touch q1)
    const enumR = relaxedRecheck(c, positions, 0.5, 0.01, unquoted, OPTS);
    const facetR = relaxedRecheckFacet(c, positions, 0.5, 0.01, unquoted);
    expect(enumR.verdict).toBe('skipped-no-dropped-constraints');
    expect(facetR.verdict).toBe('skipped-no-dropped-constraints');
  });

  test('(b) basket relying on a DROPPED mutex wall → fail', () => {
    const c = mkCluster([1, 2], [], [mutex(1, 2)]);
    // Buy-all-NO relies on the mutex to exclude the {q1=YES,q2=YES} world; drop it and
    // the worst world pays 0.
    const positions: AuditPosition[] = [{ marketId: 1, side: 'NO', shares: 1 }, { marketId: 2, side: 'NO', shares: 1 }];
    const r = relaxedRecheckFacet(c, positions, 0.5, 0.01, new Set([2])); // q2 dead ⟹ mutex dropped
    expect(r.verdict).toBe('fail');
    expect(r.relaxedWorstUsd).toBeCloseTo(0, 6);
  });

  test('(c) per-question YES+NO box is wall-invariant → pass', () => {
    const c = mkCluster([1, 2, 3], [cat(1, [1, 2, 3], true)]);
    // A box on q1 (YES + NO on the same market) pays $1 regardless of z — survives the
    // exhaustivity drop. Set B's dead slot q3 touches the traded set so the recheck runs.
    const positions: AuditPosition[] = [{ marketId: 1, side: 'YES', shares: 1 }, { marketId: 1, side: 'NO', shares: 1 }];
    const r = relaxedRecheckFacet(c, positions, 0.98, 0.01, new Set([3]));
    expect(r.verdict).toBe('pass');
    expect(r.relaxedWorstUsd).toBeCloseTo(1, 6);
  });

  test('(e) conservativeness: facet worst ≤ enumerated relaxed worst on an enumerable fixture', () => {
    const c = mkCluster([1, 2], [], [mutex(1, 2)]);
    const positions: AuditPosition[] = [{ marketId: 1, side: 'NO', shares: 1 }, { marketId: 2, side: 'NO', shares: 1 }];
    const unquoted = new Set([2]);
    const enumR = relaxedRecheck(c, positions, 0.5, 0.01, unquoted, OPTS);
    const facetR = relaxedRecheckFacet(c, positions, 0.5, 0.01, unquoted);
    expect(enumR.relaxedWorstUsd).not.toBeNull();
    expect(facetR.relaxedWorstUsd).not.toBeNull();
    // R' ⊇ conv(Ω_relaxed) ⟹ min over facets ≤ min over worlds.
    expect(facetR.relaxedWorstUsd!).toBeLessThanOrEqual(enumR.relaxedWorstUsd! + 1e-9);
  });
});

describe('relaxedRecheckFacet — HiGHS unloaded', () => {
  // (d) When the shared HiGHS instance has never loaded, the facet LP cannot solve ⟹
  // 'overflow' (resolves toward refusal). Singleton cannot be unloaded, so this only
  // asserts when run in a fresh process (standalone); it no-ops if already warmed.
  test('(d) unloaded HiGHS → overflow', () => {
    if (tryGetLoadedHiGHS() !== null) return; // already warmed by another test/file
    const c = mkCluster([1, 2], [], [mutex(1, 2)]);
    const positions: AuditPosition[] = [{ marketId: 1, side: 'NO', shares: 1 }, { marketId: 2, side: 'NO', shares: 1 }];
    const r = relaxedRecheckFacet(c, positions, 0.5, 0.01, new Set([2]));
    expect(r.verdict).toBe('overflow');
  });
});
