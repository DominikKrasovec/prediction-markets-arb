/**
 * REAL-CLUSTER equivalence + speed benchmark: H-representation (facet LP) vs
 * V-representation (state enumeration) over the ACTUAL production Ω topologies.
 *
 * Loads the real constraint graph from the DB, builds clusters, assigns
 * deterministic per-market prices (seeded by marketId — identical for both
 * engines, so the ONLY variable is the Ω encoding), then for every cluster:
 *   - V-rep:   enumerateStates (at load) → buildLP → solveLP
 *   - H-rep:   buildFacetLP → solveFacetLP
 * and compares optimal cost (the arb decision) + wall-clock. Reports the
 * cost-match rate, the median/max speed-up where both solve, and the clusters
 * the V-rep DROPS (10k-state cap) that the H-rep rescues.
 *
 * Run:  node_modules/.bin/tsx services/arb-solver/src/bench/facet-vs-vrep.ts
 */
import 'dotenv/config';
import { config } from '../config.js';
import { loadClusterGraph } from '../solve-core.js';
import { buildLP } from '../solver/lp-builder.js';
import { solveLP } from '../solver/solver.js';
import { buildFacetLP, solveFacetLP } from '../solver/facet-lp.js';
import { NO_EXECUTION_GATE } from '../solver/types.js';
import { PriceCache } from '../clob/price-cache.js';
import type { Cluster } from '../graph/types.js';
import { endPool } from '@arb/db';
import { writeFileSync } from 'node:fs';

/** Deterministic pseudo-random ask in [0.05, 0.95] seeded by marketId. */
function askFor(marketId: number): number {
  let a = (marketId * 2654435761) >>> 0;
  a ^= a >>> 15; a = Math.imul(a, 0x2c1b3c6d); a ^= a >>> 12;
  return 0.05 + ((a >>> 0) / 4294967296) * 0.9;
}

function priceCluster(cluster: Cluster, cache: PriceCache, ts: number): void {
  for (const [, q] of cluster.questions) {
    for (const [mid] of q.markets) {
      const ask = askFor(mid);
      const bid = Math.max(0.001, ask - 0.02);
      cache.update({
        marketId: mid, platform: 'kalshi', bestBid: bid, bestAsk: ask,
        bidSize: 200, askSize: 200, timestamp: ts,
      });
    }
  }
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function main(): Promise<void> {
  const t0 = performance.now();
  console.log('loading constraint graph + clusters from DB…');
  const { clusters } = await loadClusterGraph(config);
  console.log(`loaded ${clusters.length} clusters in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  const cache = new PriceCache();
  const now = Date.now();
  for (const c of clusters) priceCluster(c, cache, now);

  let both = 0, match = 0, mism = 0;
  let vDropOnly = 0, rescued = 0, bothDrop = 0;
  const deltas: number[] = [];
  const speedups: number[] = [];
  const vTimes: number[] = [];
  const fTimes: number[] = [];
  // Size-bucketed speedups (per-cluster wall-clock noise dominates the tiny
  // median, so bucket by |Ω| to show where the H-rep actually wins).
  const buckets: Record<string, number[]> = { 'small(<50)': [], 'mid(50-500)': [], 'large(>=500)': [] };
  const bucketOf = (n: number) => (n < 50 ? 'small(<50)' : n < 500 ? 'mid(50-500)' : 'large(>=500)');
  let maxRescuedQ = 0, maxRescuedFacetMs = 0, largestCluster = 0;
  const mismatches: Array<{ id: number; states: number; q: number; v: number; f: number; sets: string; edges: string }> = [];
  const structOf = (c: Cluster) => ({
    sets: c.outcomeSets.map((s) => `${s.setType}${s.isExhaustive ? '=' : '≤'}${s.slotQuestionIds.length}`).join(','),
    edges: (() => { const m: Record<string, number> = {}; for (const e of c.edges) m[e.edgeType] = (m[e.edgeType] ?? 0) + 1; return Object.entries(m).map(([k, v]) => `${k}:${v}`).join(','); })(),
  });

  for (const c of clusters) {
    largestCluster = Math.max(largestCluster, c.questions.size);
    const vSolvable = c.validStates.length > 0;

    // H-rep (always attemptable — no enumeration needed)
    const tf = performance.now();
    const flp = buildFacetLP(c, cache, NO_EXECUTION_GATE, now);
    const fres = flp ? await solveFacetLP(flp) : null;
    const fMs = performance.now() - tf;
    const fOk = fres?.status === 'Optimal';

    if (!vSolvable) {
      // V-rep gave up at the enumeration cap.
      if (fOk) {
        rescued++;
        if (c.questions.size > maxRescuedQ) { maxRescuedQ = c.questions.size; maxRescuedFacetMs = fMs; }
      } else bothDrop++;
      vDropOnly += fOk ? 1 : 0;
      continue;
    }

    // V-rep solve
    const tv = performance.now();
    const vlp = buildLP(c, cache, NO_EXECUTION_GATE);
    const vres = vlp ? await solveLP(vlp) : null;
    const vMs = performance.now() - tv;
    if (!vlp || vres?.status !== 'Optimal' || !fOk) continue;

    both++;
    const d = Math.abs(vres.optimalCost - fres!.optimalCost);
    deltas.push(d);
    if (d < 1e-4) match++;
    else {
      mism++;
      const s = structOf(c);
      if (mismatches.length < 30) mismatches.push({ id: c.id, states: c.validStates.length, q: c.questions.size, v: vres.optimalCost, f: fres!.optimalCost, sets: s.sets, edges: s.edges });
    }
    vTimes.push(vMs); fTimes.push(fMs);
    if (fMs > 0) { speedups.push(vMs / fMs); buckets[bucketOf(c.validStates.length)].push(vMs / fMs); }
  }

  const stateSizes = clusters.map((c) => c.validStates.length).filter((n) => n > 0).sort((a, b) => a - b);
  const report = {
    generatedAt: new Date(now).toISOString(),
    clusters: clusters.length,
    largestClusterQuestions: largestCluster,
    vrep: {
      solvable: stateSizes.length,
      medianStates: median(stateSizes),
      maxStates: stateSizes[stateSizes.length - 1] ?? 0,
    },
    equivalence: {
      bothSolved: both,
      exactCostMatch: match,
      matchRatePct: both > 0 ? (100 * match) / both : 100,
      mismatches: mism,
      maxAbsCostDelta: deltas.length ? Math.max(...deltas) : 0,
      sampleMismatches: mismatches,
    },
    rescue: {
      vRepDropped: rescued + bothDrop,
      facetRescued: rescued,
      neitherSolved: bothDrop,
      largestRescuedQuestions: maxRescuedQ,
      largestRescuedFacetMs: Number(maxRescuedFacetMs.toFixed(2)),
    },
    speed: {
      medianVrepMs: Number(median(vTimes).toFixed(3)),
      medianFacetMs: Number(median(fTimes).toFixed(3)),
      medianSpeedup: Number(median(speedups).toFixed(2)),
      maxSpeedup: speedups.length ? Number(Math.max(...speedups).toFixed(2)) : 0,
      bySize: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { n: v.length, medianSpeedup: Number(median(v).toFixed(2)), maxSpeedup: v.length ? Number(Math.max(...v).toFixed(2)) : 0 }])),
    },
  };

  console.log('\n===== FACET (H-rep) vs ENUMERATION (V-rep) on REAL clusters =====');
  console.log(JSON.stringify(report, null, 2));
  const out = 'data/exports/facet-vs-vrep-real.json';
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${out}`);
  await endPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
