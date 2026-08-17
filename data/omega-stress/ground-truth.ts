/**
 * GROUND TRUTH probe — measure the REAL Ω-space distribution the production
 * arb-solver builds from the live DB. Runs the exact production path:
 *   loadConstraintGraph → buildClusters → enumerateStates
 * and dumps, per cluster: #questions, #markets, #vars(=2·markets), #edges,
 * #outcomeSets (by type + slot counts), #freeQuestions, and the resulting
 * #validStates (the LP constraint-row count). Also reports how many clusters
 * the 10k state cap actually drops.
 *
 * Read-only. Output: data/omega-stress/results/ground-truth.json + a console
 * histogram. This anchors the synthetic stress test in real numbers.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { loadConstraintGraph } from '../../services/arb-solver/src/graph/loader.ts';
import { buildClusters } from '../../services/arb-solver/src/graph/cluster-builder.ts';
import { enumerateStates } from '../../services/arb-solver/src/solver/state-enumerator.ts';
import { endPool } from '@arb/db';

const CAP = parseInt(process.env.MAX_VALID_STATES ?? '10000');

interface ClusterStat {
  id: number;
  questions: number;
  markets: number;
  vars: number; // 2 · markets
  edges: number;
  outcomeSets: number;
  catSets: number;
  thrSets: number;
  otherSets: number;
  maxSetSlots: number;
  freeQuestions: number;
  validStates: number; // realized (post-cap, post-edge-filter)
  dropped: boolean; // enumerator returned [] but cluster non-empty
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const t0 = performance.now();
  const graph = await loadConstraintGraph(
    parseFloat(process.env.MIN_EDGE_CONFIDENCE ?? '0.70'),
  );
  // SANITIZE: the loader liveness-filters EDGES (filterEdgesToLiveEndpoints) but
  // NOT outcome-set slots, so an outcome set can carry a slot question that the
  // end_date/archived gate dropped from `graph.questions`. cluster-builder's
  // outcome-set adjacency loop (line ~117) assumes every slot qid is in the adj
  // map (only true for live questions) → it CRASHES on a dangling slot. We drop
  // dead slots here (the enumerator already ignores them via
  // `slotQuestionIds.filter(q => cluster.questions.has(q))`), which is the same
  // intent and lets the probe run. This asymmetry is itself a latent finding.
  let danglingSlots = 0, droppedSets = 0;
  graph.outcomeSets = graph.outcomeSets
    .map((os) => {
      const live = os.slotQuestionIds.filter((q) => graph.questions.has(q));
      danglingSlots += os.slotQuestionIds.length - live.length;
      return { ...os, slotQuestionIds: live };
    })
    .filter((os) => {
      if (os.slotQuestionIds.length === 0) { droppedSets++; return false; }
      return true;
    });
  console.log(`[sanitize] dropped ${danglingSlots} dangling slot(s), ${droppedSets} now-empty set(s)`);
  const clusters = buildClusters(graph, {
    clusterSizeCap: parseInt(process.env.CLUSTER_SIZE_CAP ?? '200'),
  });

  const stats: ClusterStat[] = [];
  let enumMsTotal = 0;
  for (const c of clusters) {
    const covered = new Set<number>();
    let catSets = 0, thrSets = 0, otherSets = 0, maxSetSlots = 0;
    for (const os of c.outcomeSets) {
      const slots = os.slotQuestionIds.filter((q) => c.questions.has(q));
      maxSetSlots = Math.max(maxSetSlots, slots.length);
      if (os.setType === 'categorical' && slots.length >= 2) {
        catSets++;
        slots.forEach((q) => covered.add(q));
      } else if (os.setType === 'threshold_series') {
        thrSets++;
        slots.forEach((q) => covered.add(q));
      } else {
        otherSets++;
      }
    }
    const freeQuestions = [...c.questions.keys()].filter((q) => !covered.has(q)).length;

    const te = performance.now();
    const states = enumerateStates(c, { maxStates: CAP, clusterSizeCap: 200 });
    enumMsTotal += performance.now() - te;

    stats.push({
      id: c.id,
      questions: c.questions.size,
      markets: c.marketIds.size,
      vars: 2 * c.marketIds.size,
      edges: c.edges.length,
      outcomeSets: c.outcomeSets.length,
      catSets,
      thrSets,
      otherSets,
      maxSetSlots,
      freeQuestions,
      validStates: states.length,
      dropped: states.length === 0 && c.questions.size > 0,
    });
  }

  const totalMs = performance.now() - t0;

  const nonEmpty = stats.filter((s) => s.validStates > 0);
  const dropped = stats.filter((s) => s.dropped);
  const statesSorted = nonEmpty.map((s) => s.validStates).sort((a, b) => a - b);
  const qSorted = stats.map((s) => s.questions).sort((a, b) => a - b);
  const mSorted = stats.map((s) => s.markets).sort((a, b) => a - b);

  const buckets = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 10000];
  const hist: Record<string, number> = {};
  for (const s of nonEmpty) {
    let label = '>10000';
    for (const b of buckets) {
      if (s.validStates <= b) { label = `<=${b}`; break; }
    }
    hist[label] = (hist[label] ?? 0) + 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    cap: CAP,
    totals: {
      questions: graph.questions.size,
      edges: graph.edges.length,
      outcomeSets: graph.outcomeSets.length,
      clusters: clusters.length,
      clustersNonEmpty: nonEmpty.length,
      clustersDropped: dropped.length,
      totalValidStates: nonEmpty.reduce((a, s) => a + s.validStates, 0),
      totalMarkets: stats.reduce((a, s) => a + s.markets, 0),
      enumMsTotal: Math.round(enumMsTotal),
      probeMsTotal: Math.round(totalMs),
    },
    questionsPerCluster: {
      max: qSorted[qSorted.length - 1] ?? 0,
      p50: percentile(qSorted, 50), p90: percentile(qSorted, 90),
      p99: percentile(qSorted, 99),
      mean: qSorted.reduce((a, b) => a + b, 0) / (qSorted.length || 1),
    },
    marketsPerCluster: {
      max: mSorted[mSorted.length - 1] ?? 0,
      p50: percentile(mSorted, 50), p90: percentile(mSorted, 90),
      p99: percentile(mSorted, 99),
    },
    validStatesPerCluster: {
      max: statesSorted[statesSorted.length - 1] ?? 0,
      p50: percentile(statesSorted, 50), p90: percentile(statesSorted, 90),
      p99: percentile(statesSorted, 99), p999: percentile(statesSorted, 99.9),
      mean: statesSorted.reduce((a, b) => a + b, 0) / (statesSorted.length || 1),
    },
    stateHistogram: hist,
    biggest: [...nonEmpty]
      .sort((a, b) => b.validStates - a.validStates)
      .slice(0, 30),
  };

  writeFileSync(
    'data/omega-stress/results/ground-truth.json',
    JSON.stringify({ summary, stats }, null, 2),
  );

  console.log('=== GROUND TRUTH Ω DISTRIBUTION ===');
  console.log(JSON.stringify(summary.totals, null, 2));
  console.log('questions/cluster:', JSON.stringify(summary.questionsPerCluster));
  console.log('markets/cluster:  ', JSON.stringify(summary.marketsPerCluster));
  console.log('validStates/cluster:', JSON.stringify(summary.validStatesPerCluster));
  console.log('state histogram:', JSON.stringify(summary.stateHistogram, null, 2));
  console.log('biggest 10 Ω:', JSON.stringify(summary.biggest.slice(0, 10), null, 2));

  await endPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
