import 'dotenv/config';
import { config } from './config.js';
import { solveLP } from './solver/solver.js';
import { type ClusterDualCert } from './solver/skip-filter.js';
import { SolverPool } from './solver/solver-pool.js';
import { extractPortfolio } from './solver/portfolio.js';
import { checkFiredPortfolioTripwires } from './solver/omega-audit.js';
import { solveGradedResidual } from './solver/graded-residual.js';
import { PriceCache, isDeadSnapshot } from './clob/price-cache.js';
import { newContainmentLatch } from './graph/intra-set-containment-belt.js';
import { interpretCluster, projectedStateCount } from './solver/omega-constraints.js';
import { ClobManager } from './clob/manager.js';
import { IoHost } from './clob/io-thread/io-host.js';
import {
  loadClusterGraph,
  refreshPriceBelt,
  collectMarketsToTrack,
  refreshCert as refreshCertCore,
  prepareClusterForSolve,
  solveProblem,
} from './solve-core.js';
import { persistOpportunity, persistGradedResidual, expireStaleOpportunities, persistPrices } from './persistence.js';
import { publishArbDetected, publishGraphReloaded } from './events.js';
import { endPool, query } from '@arb/db';
import { writeAndPublishResolution, coerceResolvedAt } from '@arb/resolution-write';
import type { ResolutionEvent } from './clob/adapters/base.js';
import type { Cluster, ConstraintGraph } from './graph/types.js';
import type { MarketSubscription } from './clob/price-cache.js';
import type { ArbOpportunity, LPProblem, LPResult } from './solver/types.js';
import { IdentitySentinel, buildWatchPairs, SentinelSink } from './sentinel/index.js';
import { createLogger } from '@arb/logger';

const log = createLogger('solver:runtime');
const solverLog = createLogger('solver:emit');

const priceCache = new PriceCache();
/** Persists a price refutation for the price-contradiction arm across reloads. */
const containmentLatch = newContainmentLatch();
const yesBidOf = (marketId: number): number | null => {
  const s = priceCache.get(marketId);
  if (isDeadSnapshot(s)) return null;
  return s.bestBid > 0 ? s.bestBid : null;
};
const clobManager = config.clob.ioThread ? new IoHost() : new ClobManager();

let sentinel: IdentitySentinel | null = null;
const sentinelSink = new SentinelSink({
  jsonlPath: process.env.SENTINEL_JSONL ?? 'data/exports/sentinel-alerts.jsonl',
});

let clusters: Cluster[] = [];
let loadedGraph: ConstraintGraph | null = null;
let marketClusterIndex = new Map<number, Cluster>();
let clusterById = new Map<number, Cluster>();
let solveTimer: ReturnType<typeof setTimeout> | null = null;
let solving = false;
const dirtySet = new Set<number>();
const lastSolveFingerprint = new Map<number, string>();
const dualCerts = new Map<number, ClusterDualCert>();
const livenessMasks = new Map<number, string>();
const THETA = 1 - config.solver.minProfit; // arb reported iff optimalCost <= theta
let tripwireCount = 0;
const solverPool = config.solver.workerPool ? new SolverPool() : null;

const activeArbs = new Map<number, ArbOpportunity>();

async function loadGraph(): Promise<void> {
  const loaded = await loadClusterGraph(config, { yesBidOf, latch: containmentLatch });
  clusters = loaded.clusters;
  loadedGraph = loaded.graph;
  marketClusterIndex = loaded.marketClusterIndex;
  clusterById = loaded.clusterById;

  sentinel = new IdentitySentinel(buildWatchPairs(loaded.graph), {}, sentinelSink);

  let relaxedClusters = 0;
  for (const cluster of clusters) {
    if (cluster.relaxed === true) {
      relaxedClusters++;
      const projected = projectedStateCount(interpretCluster(cluster));
      solverLog.info(`Cluster ${cluster.id}: relaxed (facet-only, projected ${projected})`);
    } else if (cluster.validStates.length === 0 && cluster.questions.size > 0) {
      solverLog.warn(`Cluster ${cluster.id}: 0 valid states (skipped)`);
    }
  }

  const totalStates = clusters.reduce((s, c) => s + c.validStates.length, 0);
  solverLog.info(
    `Graph loaded: ${clusters.length} clusters, ` +
    `${loaded.graph.questions.size} questions, ${loaded.graph.edges.length} edges, ` +
    `${totalStates} total valid states` +
    (relaxedClusters > 0 ? `, ${relaxedClusters} relaxed (facet-only)` : '')
  );
}

async function getMarketsToTrack(): Promise<MarketSubscription[]> {
  return collectMarketsToTrack(clusters, config, log);
}

/** Shared by the serial and worker-pool paths so persist/publish handling stays identical. */
async function processResult(clusterId: number, cluster: Cluster, lp: LPProblem, result: LPResult): Promise<void> {
  const now = Date.now();
  const portfolio = (result.status === 'Optimal' && result.optimalCost < 1.0)
    ? extractPortfolio(
        result, lp, cluster, priceCache, config.solver.minProfit, config.execution.gradeThresholds,
        now, { maxStates: config.solver.maxStates, clusterSizeCap: config.solver.clusterSizeCap },
      )
    : null;

  // 'blocked': the Ω this arb was certified against is not trustworthy for this
  // basket -- diagnostic only, never persisted/published/alerted.
  if (portfolio && portfolio.executionGrade === 'blocked') {
    if (activeArbs.has(clusterId)) activeArbs.delete(clusterId);
    solverLog.warn(
      `ARB-REFUSED cluster=${clusterId}: grade=blocked ` +
      `cost=$${portfolio.totalCost.toFixed(4)} profit=$${portfolio.profit.toFixed(4)} ` +
      `legs=${portfolio.legs.length} omega=${JSON.stringify(portfolio.omegaAudit)} ` +
      `reasons=[${portfolio.executionReasons.join(' | ')}]`
    );
    return;
  }

  if (portfolio) {
    const trips = checkFiredPortfolioTripwires(cluster, lp.variables, portfolio.omegaAudit, priceCache, now, portfolio.executionGrade);
    if (trips.length > 0) {
      tripwireCount += trips.length;
      if (activeArbs.has(clusterId)) activeArbs.delete(clusterId);
      solverLog.error(
        `ARB-REFUSED cluster=${clusterId}: TRIPWIRE (force-blocked, ${trips.length} violation(s), ` +
        `total trips=${tripwireCount}) — ${trips.join(' ; ')}`
      );
      return;
    }
  }

  if (portfolio) {
    activeArbs.set(clusterId, portfolio);
    const id = await persistOpportunity(portfolio);
    if (portfolio.eligibleForAutoExecution) {
      await publishArbDetected(portfolio);
    }
    solverLog.info(
      `ARB ${portfolio.eligibleForAutoExecution ? 'DETECTED' : 'DETECTED (risky — persisted, no alert)'} cluster=${clusterId}: ` +
      `cost=$${portfolio.totalCost.toFixed(4)} profit=$${portfolio.profit.toFixed(4)} ` +
      `(${portfolio.profitPct.toFixed(1)}%) legs=${portfolio.legs.length} ` +
      `fees=$${portfolio.feesUsd.toFixed(4)} liq=$${portfolio.liquidityUsd.toFixed(0)} ` +
      `grade=${portfolio.executionGrade} solve=${portfolio.solveTimeMs}ms id=${id}`
    );
  } else {
    if (activeArbs.has(clusterId)) activeArbs.delete(clusterId);
    if (config.execution.gradedResidualChannel) {
      const graded = await solveGradedResidual(
        cluster, priceCache, config.execution, config.solver.minProfit, config.execution.gradeThresholds,
        Date.now(), solverPool ? (lp2) => solverPool.solve(lp2) : undefined,
      );
      if (graded) {
        const id = await persistGradedResidual(graded);
        solverLog.info(
          `GRADED near-arb cluster=${clusterId}: edge=$${graded.edge.toFixed(4)} ` +
          `worst=$${graded.worstStrictStatePayout.toFixed(2)} grade=${graded.executionGrade} ` +
          `(residual_tail — NOT certified) id=${id}`
        );
      }
    }
  }
}

function scheduleSolve(): void {
  if (solving) return;
  if (solveTimer) clearTimeout(solveTimer);
  solveTimer = setTimeout(() => {
    solveTimer = null;
    if (dirtySet.size === 0) return;
    solving = true;
    solveDirty()
      .catch((err) => solverLog.error('Solve error:', err))
      .finally(() => {
        solving = false;
        if (dirtySet.size > 0) scheduleSolve();
      });
  }, config.solver.debounceMs);
}

function refreshCert(clusterId: number, lp: LPProblem, result: LPResult): void {
  refreshCertCore(dualCerts, clusterId, lp, result);
}

function skipFilterDrop(clusterId: number): void {
  if (activeArbs.has(clusterId)) activeArbs.delete(clusterId);
}

async function solveDirty(): Promise<void> {
  const toSolve = [...dirtySet];
  dirtySet.clear();
  const now = Date.now();

  const poolEngine = config.solver.engine;
  if (solverPool) {
    const yieldEvery = config.solver.yieldEvery;
    let built_n = 0;
    const built: Array<{ clusterId: number; cluster: Cluster; lp: LPProblem }> = [];
    for (const clusterId of toSolve) {
      const cluster = clusterById.get(clusterId);
      if (!cluster) continue;
      if ((cluster.relaxed === true || cluster.validStates.length === 0) && poolEngine === 'vrep') continue;
      const prep = prepareClusterForSolve(
        { priceCache, lastSolveFingerprint, dualCerts, livenessMasks },
        clusterId, cluster, now,
        { dedup: config.solver.serialDedup, skipFilter: config.solver.skipFilter, theta: THETA, execution: config.execution, engine: poolEngine },
      );
      if (prep.kind === 'skip') continue;
      if (prep.kind === 'skip-filter') { skipFilterDrop(clusterId); continue; }
      if (prep.kind === 'skip-quoted-fraction') continue;
      built.push({ clusterId, cluster, lp: prep.lp });
      if (yieldEvery > 0 && ++built_n % yieldEvery === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    if (built.length === 0) return;
    const results: LPResult[] = new Array(built.length);
    const poolIdx: number[] = [];
    const poolLps: LPProblem[] = [];
    for (let i = 0; i < built.length; i++) {
      if (built[i].lp.facetForm) results[i] = await solveProblem(built[i].lp);
      else { poolIdx.push(i); poolLps.push(built[i].lp); }
    }
    if (poolLps.length > 0) {
      const poolResults = await solverPool.solveBatch(poolLps);
      for (let k = 0; k < poolIdx.length; k++) results[poolIdx[k]] = poolResults[k];
    }
    for (let i = 0; i < built.length; i++) {
      if (config.solver.skipFilter) refreshCert(built[i].clusterId, built[i].lp, results[i]);
      await processResult(built[i].clusterId, built[i].cluster, built[i].lp, results[i]);
    }
    return;
  }

  const yieldEvery = config.solver.yieldEvery;
  const engine = config.solver.engine;
  let processed = 0;
  for (const clusterId of toSolve) {
    const cluster = clusterById.get(clusterId);
    if (!cluster) continue;
    if ((cluster.relaxed === true || cluster.validStates.length === 0) && engine === 'vrep') continue;

    const prep = prepareClusterForSolve(
      { priceCache, lastSolveFingerprint, dualCerts, livenessMasks },
      clusterId, cluster, now,
      { dedup: config.solver.serialDedup, skipFilter: config.solver.skipFilter, theta: THETA, execution: config.execution, engine },
    );
    if (prep.kind === 'skip') continue;
    if (prep.kind === 'skip-filter') { skipFilterDrop(clusterId); continue; }
    if (prep.kind === 'skip-quoted-fraction') continue;

    const result = await solveProblem(prep.lp);
    if (config.solver.skipFilter) refreshCert(clusterId, prep.lp, result);
    await processResult(clusterId, cluster, prep.lp, result);

    if (yieldEvery > 0 && ++processed % yieldEvery === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

async function main(): Promise<void> {
  log.info('Starting...');

  priceCache.setTtl(config.execution.quoteTtlMs);
  priceCache.setTobTtl(config.execution.tobTtlMs);

  await loadGraph();

  const marketsToTrack = await getMarketsToTrack();
  for (const m of marketsToTrack) {
    priceCache.track(m.marketId);
  }

  if (solverPool) {
    log.info(`Solver worker pool: ${config.solver.workerCount} workers — initializing...`);
    await solverPool.ready();
    log.info('Solver worker pool ready.');
  }

  await clobManager.startTracking(marketsToTrack);

  clobManager.onPriceUpdate((update) => {
    if (update.outcome !== 'no') sentinel?.pump(update); // YES-book only: spread math assumes pYES
    const changed = priceCache.update(update);
    if (!changed) return;

    const cluster = marketClusterIndex.get(update.marketId);
    if (cluster) {
      dirtySet.add(cluster.id);
      scheduleSolve();
    }
  });

  clobManager.onMarketResolved(handleResolutionEvent);

  if (config.execution.staleOnDisconnect) {
    clobManager.onConnectionStale((marketIds) => {
      priceCache.markStaleByIds(marketIds);
      sentinel?.markStale(marketIds, Date.now());
    });
  }

  let lastResolutionPoll = new Date();
  const resolutionPollInterval = setInterval(async () => {
    try {
      const since = lastResolutionPoll;
      lastResolutionPoll = new Date();
      const rows = await query<{ id: number }>(
        `SELECT id FROM markets WHERE resolved_at IS NOT NULL AND resolved_at > $1`,
        [since]
      );
      if (rows.length > 0) {
        priceCache.markStaleByIds(rows.map((r) => r.id));
        sentinel?.markStale(rows.map((r) => r.id), Date.now());
        await Promise.all(rows.map((r) => clobManager.unsubscribeMarket(r.id)));
        log.info(`evicted ${rows.length} resolved market(s) from price cache`);
      }
    } catch (err) {
      log.error('resolution poll error:', err);
    }
  }, parseInt(process.env.RESOLUTION_POLL_INTERVAL_MS ?? '60000'));

  setInterval(async () => {
    try {
      const snapshots = priceCache.getLiveSnapshots();
      if (snapshots.length > 0) {
        await persistPrices(snapshots);
      }
    } catch (err) {
      solverLog.error('Price persist error:', err);
    }
  }, config.solver.pricePersistIntervalMs);

  setInterval(() => {
    if (solving || !loadedGraph) return;
    solving = true;
    try {
      const rebuilt = refreshPriceBelt(loadedGraph, config, { yesBidOf, latch: containmentLatch });
      if (rebuilt) {
        clusters = rebuilt.clusters;
        marketClusterIndex = rebuilt.marketClusterIndex;
        clusterById = rebuilt.clusterById;
        // ids are reassigned by buildClusters -- clear id-keyed skip caches before re-solving
        lastSolveFingerprint.clear();
        dualCerts.clear();
        livenessMasks.clear();
        for (const c of clusters) dirtySet.add(c.id);
      }
    } catch (err) {
      solverLog.error('price-belt refresh error:', err);
    } finally {
      solving = false;
    }
    if (dirtySet.size > 0) scheduleSolve();
  }, 120_000);

  setInterval(() => {
    try {
      sentinel?.sweep(Date.now());
      const summary = sentinel?.summary(5);
      if (summary && summary.topSuspects.length > 0) {
        log.warn(
          `sentinel: ${summary.topSuspects.length} active suspect-identity pair(s) ` +
          `(watched=${summary.pairsWatched} pending=${summary.pairsPending} alerted=${summary.pairsAlerted}) — ` +
          `top: ${summary.topSuspects.map((t) => t.pairId).join(' | ')}`,
        );
      }
    } catch (err) {
      log.error('sentinel sweep error:', err);
    }
  }, 60_000);

  let lastGraphReloadTimestamp: string | null = null;
  const graphReloadInterval = setInterval(async () => {
    let reloadTimestamp: string | null = null;
    try {
      const response = await fetch(`${config.eventBus.url}/last-event?channel=pipeline&type=graph_updated`);
      if (response.ok) {
        const event = await response.json() as { timestamp?: string } | null;
        if (event?.timestamp && event.timestamp !== lastGraphReloadTimestamp) {
          lastGraphReloadTimestamp = event.timestamp;
          reloadTimestamp = event.timestamp;
        }
      }
    } catch { /* event bus may not be running */ }
    if (reloadTimestamp !== null) {
      solverLog.info('Pipeline graph_updated signal received, reloading...');
      try {
        await reloadGraph();
      } catch (err) {
        solverLog.error(
          `graph reload FAILED (timestamp ${reloadTimestamp}) — solver is now serving a ` +
          `STALE graph until the next graph_updated event:`, err,
        );
      }
    }
  }, 60_000);

  const shutdown = async () => {
    log.info('Shutting down...');
    clearInterval(graphReloadInterval);
    clearInterval(resolutionPollInterval);
    if (solveTimer) clearTimeout(solveTimer);
    await clobManager.stopAll();
    try { await solverPool?.terminate(); } catch {}
    await endPool();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info(`Running. Tracking ${marketsToTrack.length} markets in ${clusters.length} clusters.`);
}

/** DB write + event-bus publish delegate to `@arb/resolution-write`; local
 *  concerns are cache eviction + CLOB unsubscribe. */
async function handleResolutionEvent(event: ResolutionEvent): Promise<void> {
  try {
    const { resolvedAt } = coerceResolvedAt(
      event.timestamp,
      `${event.platform}/wss-clob ${event.platformId}`,
    );
    const { outcome, marketId } = await writeAndPublishResolution({
      platform: event.platform,
      platformId: event.platformId,
      winning: event.winningOutcome,
      resolvedAt,
      source: `${event.platform}/wss-clob`,
    });

    if ((outcome !== 'created' && outcome !== 'amended') || marketId == null) return;

    priceCache.markStaleByIds([marketId]);
    sentinel?.markStale([marketId], Date.now());
    await clobManager.unsubscribeMarket(marketId);

    log.info(
      `resolved market=${marketId} ` +
      `(${event.platform}/${event.platformId}) → ${event.winningOutcome ?? '?'}` +
      (outcome === 'amended' ? ' [amended]' : ''),
    );
  } catch (err) {
    log.error('handleResolutionEvent error:', err);
  }
}

async function reloadGraph(): Promise<void> {
  await loadGraph();

  const newMarkets = await getMarketsToTrack();
  const allMarketIds = new Set(newMarkets.map(m => m.marketId));

  for (const m of newMarkets) priceCache.track(m.marketId);
  priceCache.evict(allMarketIds);

  await clobManager.updateSubscriptions(newMarkets);

  const activeClusterIds = clusters.map(c => c.id);
  const expired = await expireStaleOpportunities(activeClusterIds);
  if (expired > 0) {
    solverLog.info(`Expired ${expired} stale LP opportunities`);
  }

  await publishGraphReloaded({
    clusters: clusters.length,
    questions: clusters.reduce((s, c) => s + c.questions.size, 0),
    edges: clusters.reduce((s, c) => s + c.edges.length, 0),
    trackedMarkets: newMarkets.length,
  });

  // ids are reassigned from 0 on each buildClusters -- drop stale id-keyed state
  lastSolveFingerprint.clear();
  dualCerts.clear();
  livenessMasks.clear();

  for (const cluster of clusters) {
    dirtySet.add(cluster.id);
  }
  if (dirtySet.size > 0) scheduleSolve();
}

main().catch((err) => {
  log.error('Fatal error:', err);
  process.exit(1);
});
