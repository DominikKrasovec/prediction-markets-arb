import { describe, test, expect } from 'bun:test';
import { prepareClusterForSolve, type SolvePrepDeps } from './solve-core.js';
import { config } from './config.js';
import { PriceCache } from './clob/price-cache.js';
import { DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR } from './solver/execution-grade.js';
import type { Cluster, QuestionNode } from './graph/types.js';

// Quoted-fraction pre-solve skip.
//
// prepareClusterForSolve must decline (kind:'skip-quoted-fraction') a cluster
// whose quotedFraction (quoted questions / total) is below the floor, and
// must not decline when it is at/above the floor. A question is quoted iff
// >=1 of its markets has a usable side — here we make a market quoted by
// feeding a real book into the cache, and unquoted by leaving it untracked.

function question(qid: number, marketId: number): QuestionNode {
  return {
    questionId: qid,
    canonicalSubject: `subj${qid}`,
    conditionShape: null,
    conditionValue: null,
    conditionDate: null,
    markets: new Map([[marketId, { marketId, platform: 'kalshi' as const, platformId: `p${marketId}` }]]),
  };
}

/** A cluster of `n` questions where the first `quoted` carry a live book. */
function buildCluster(id: number, n: number, quoted: number): { cluster: Cluster; priceCache: PriceCache } {
  const priceCache = new PriceCache();
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  for (let i = 1; i <= n; i++) {
    const marketId = id * 1000 + i;
    questions.set(i, question(i, marketId));
    marketIds.add(marketId);
    if (i <= quoted) {
      // Real two-sided book ⟹ YES-buyable ⟹ the question is QUOTED.
      priceCache.update({ marketId, platform: 'kalshi', bestBid: 0.4, bestAsk: 0.5, bidSize: 100, askSize: 100, timestamp: 1000 });
    }
    // else: untracked ⟹ priceCache.get returns undefined ⟹ DEAD ⟹ UNQUOTED.
  }
  const cluster: Cluster = {
    id,
    questions,
    outcomeSets: [],
    edges: [],
    marketIds,
    validStates: [],
    dirty: false,
  };
  return { cluster, priceCache };
}

function deps(priceCache: PriceCache): SolvePrepDeps {
  return { priceCache, lastSolveFingerprint: new Map(), dualCerts: new Map(), livenessMasks: new Map() };
}

const opts = (over: Partial<{ quotedFractionSolveFloor: number }> = {}) => ({
  dedup: false,
  skipFilter: false,
  theta: 0.99,
  execution: { ...config.execution, quotedFractionSolveFloor: DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR, ...over },
  engine: 'vrep' as const,
});

describe('prepareClusterForSolve — quotedFraction pre-solve skip', () => {
  test('below the floor (1/20 = 0.05) ⟹ skip-quoted-fraction, carrying the fraction', () => {
    const { cluster, priceCache } = buildCluster(1, 20, 1);
    const prep = prepareClusterForSolve(deps(priceCache), 1, cluster, 2000, opts());
    expect(prep.kind).toBe('skip-quoted-fraction');
    if (prep.kind === 'skip-quoted-fraction') expect(prep.quotedFraction).toBeCloseTo(0.05, 6);
  });

  test('EXACTLY at the floor (1/10 = 0.10) ⟹ NOT skipped (strict <)', () => {
    const { cluster, priceCache } = buildCluster(2, 10, 1);
    const prep = prepareClusterForSolve(deps(priceCache), 2, cluster, 2000, opts());
    expect(prep.kind).not.toBe('skip-quoted-fraction');
  });

  test('above the floor (2/10 = 0.20) ⟹ NOT skipped', () => {
    const { cluster, priceCache } = buildCluster(3, 10, 2);
    const prep = prepareClusterForSolve(deps(priceCache), 3, cluster, 2000, opts());
    expect(prep.kind).not.toBe('skip-quoted-fraction');
  });

  test('a fully-dead giant cluster (0/50) ⟹ skip-quoted-fraction (the c220 class)', () => {
    const { cluster, priceCache } = buildCluster(4, 50, 0);
    const prep = prepareClusterForSolve(deps(priceCache), 4, cluster, 2000, opts());
    expect(prep.kind).toBe('skip-quoted-fraction');
    if (prep.kind === 'skip-quoted-fraction') expect(prep.quotedFraction).toBe(0);
  });

  test('raising the floor skips a cluster the default would solve (0.20 quoted, floor 0.25)', () => {
    // default floor 0.10 ⟹ solves
    const a = buildCluster(5, 10, 2); // qf = 0.20
    expect(prepareClusterForSolve(deps(a.priceCache), 5, a.cluster, 2000, opts()).kind).not.toBe('skip-quoted-fraction');
    // raised floor 0.25 ⟹ skips
    const b = buildCluster(5, 10, 2);
    expect(prepareClusterForSolve(deps(b.priceCache), 5, b.cluster, 2000, opts({ quotedFractionSolveFloor: 0.25 })).kind).toBe('skip-quoted-fraction');
  });

  test('a skip does NOT record a last-solve fingerprint (so a revived cluster re-solves)', () => {
    const { cluster, priceCache } = buildCluster(6, 20, 1);
    const d = deps(priceCache);
    const prep = prepareClusterForSolve(d, 6, cluster, 2000, { ...opts(), dedup: true });
    expect(prep.kind).toBe('skip-quoted-fraction');
    // The fingerprint map is untouched ⟹ once books revive, dedup won't wrongly skip.
    expect(d.lastSolveFingerprint.has(6)).toBe(false);
  });
});
