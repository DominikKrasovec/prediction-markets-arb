/**
 * Shared solve-orchestration core: graph-load, market-subscription and per-cluster
 * solve-preparation primitives used by both the production daemon and the observation harness.
 */
import { config } from './config.js';
import { loadConstraintGraph } from './graph/loader.js';
import {
  applyIntraSetContainmentBelt,
  applyContainmentLatch,
  latchBeltResult,
  type ContainmentLatch,
} from './graph/intra-set-containment-belt.js';
import { buildClusters, buildMarketIndex } from './graph/cluster-builder.js';
import { enumerateStates, enumerateStatesMeta, computePinnedQuestions, type EnumerationOutcome } from './solver/state-enumerator.js';
import { structureKey, configEpoch, type EnumCache } from './graph/enum-cache.js';
import { unquotedQuestions } from './solver/omega-audit.js';
import {
  facetsFeasible,
  interpretCluster,
  checkOmegaCompleteness,
  type HighsLike,
} from './solver/omega-constraints.js';
import { buildLP } from './solver/lp-builder.js';
import { buildFacetLP, solveFacetLP, clusterToFacets, getHiGHS, tryGetLoadedHiGHS } from './solver/facet-lp.js';
import { solveLP } from './solver/solver.js';
import { createLogger } from '@arb/logger';
import { clusterFingerprint } from './solver/cluster-fingerprint.js';
import { buildCert, decideSkip, type ClusterDualCert } from './solver/skip-filter.js';
import { DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR } from './solver/execution-grade.js';
import { filterSubsToLive, getLiveMarketIds } from './clob/live-gate.js';
import type { PriceCache, MarketSubscription } from './clob/price-cache.js';
import type { Cluster, ConstraintGraph } from './graph/types.js';
import type { LPProblem, LPResult } from './solver/types.js';
import type { Logger } from '@arb/logger';

type AppConfig = typeof config;

const log = createLogger('solver:core');

// Telemetry only; never affects a decision.
let relaxedSolvePreparedCount = 0;
export function relaxedSolvePreparedCensus(): number {
  return relaxedSolvePreparedCount;
}
export function resetRelaxedSolvePreparedCensus(): void {
  relaxedSolvePreparedCount = 0;
}

let lastIncrementalReused = 0;
let lastIncrementalEnumerated = 0;
let lastIncrementalEvicted = 0;
export function lastIncrementalFinalizeStats(): { reused: number; enumerated: number; evicted: number } {
  return { reused: lastIncrementalReused, enumerated: lastIncrementalEnumerated, evicted: lastIncrementalEvicted };
}

// `latch` keeps a price-refuted set/edge dropped across reloads even after the books go quiet.
export interface PriceBeltWiring {
  yesBidOf: (marketId: number) => number | null | undefined;
  latch: ContainmentLatch;
}

export async function loadClusterGraph(
  cfg: AppConfig,
  priceBelt?: PriceBeltWiring,
): Promise<{
  graph: ConstraintGraph;
  clusters: Cluster[];
  marketClusterIndex: Map<number, Cluster>;
  clusterById: Map<number, Cluster>;
}> {
  const graph = await loadConstraintGraph(cfg.solver.minEdgeConfidence);
  // Strictly wall-removing (only enlarges Ω): can kill a fake mutex but never manufacture an arb.
  if (priceBelt) {
    applyContainmentLatch(graph, priceBelt.latch);
    const res = applyIntraSetContainmentBelt(graph, { yesBidOf: priceBelt.yesBidOf });
    latchBeltResult(priceBelt.latch, res);
  }
  // Warm HiGHS so the finalize-time feasibility check can run synchronously per relaxed cluster.
  const highs = cfg.solver.relaxedRoute ? await getHiGHS() : null;
  const { clusters, marketClusterIndex, clusterById } = finalizeClusters(graph, cfg, highs);
  return { graph, clusters, marketClusterIndex, clusterById };
}

// Incremental sibling of {@link loadClusterGraph}: reuses cached enumeration for a
// structurally-unchanged cluster instead of re-enumerating.
export async function loadClusterGraphIncremental(
  cfg: AppConfig,
  cache: EnumCache,
  priceBelt?: PriceBeltWiring,
): Promise<{
  graph: ConstraintGraph;
  clusters: Cluster[];
  marketClusterIndex: Map<number, Cluster>;
  clusterById: Map<number, Cluster>;
}> {
  const graph = await loadConstraintGraph(cfg.solver.minEdgeConfidence);
  if (priceBelt) {
    applyContainmentLatch(graph, priceBelt.latch);
    const res = applyIntraSetContainmentBelt(graph, { yesBidOf: priceBelt.yesBidOf });
    latchBeltResult(priceBelt.latch, res);
  }
  const highs = cfg.solver.relaxedRoute ? await getHiGHS() : null;
  const { clusters, marketClusterIndex, clusterById } = finalizeClustersIncremental(graph, cfg, highs, cache);
  return { graph, clusters, marketClusterIndex, clusterById };
}

// Separate from loadClusterGraph so {@link refreshPriceBelt} can rebuild clusters after a
// live-price drop without re-fetching the graph. Does not touch the DB.
export function finalizeClusters(
  graph: ConstraintGraph,
  cfg: AppConfig,
  highs: HighsLike | null = tryGetLoadedHiGHS(),
): {
  clusters: Cluster[];
  marketClusterIndex: Map<number, Cluster>;
  clusterById: Map<number, Cluster>;
} {
  const clusters = buildClusters(graph, { clusterSizeCap: cfg.solver.clusterSizeCap });
  const marketClusterIndex = buildMarketIndex(clusters);
  const clusterById = new Map(clusters.map((c) => [c.id, c]));

  const tel: RelaxedTelemetry = { relaxedCount: 0, relaxedMaxQuestions: 0, relaxedMaxProjected: 0 };
  for (const cluster of clusters) enumerateAndRouteCluster(cluster, cfg, highs, tel);
  logRelaxedTelemetry(tel);

  return { clusters, marketClusterIndex, clusterById };
}

interface RelaxedTelemetry {
  relaxedCount: number;
  relaxedMaxQuestions: number;
  relaxedMaxProjected: number;
}

function logRelaxedTelemetry(tel: RelaxedTelemetry): void {
  if (tel.relaxedCount > 0) {
    log.info(
      `RELAXED-FACET route: ${tel.relaxedCount} cluster(s) rescued (facet-only) — ` +
        `max questions=${tel.relaxedMaxQuestions}, max projected=${tel.relaxedMaxProjected}`,
    );
  }
}

// Shared by the full and incremental finalize. Mutates the passed cluster in place and
// returns the raw `enumerateStatesMeta` outcome so the incremental caller can cache it.
function enumerateAndRouteCluster(
  cluster: Cluster,
  cfg: AppConfig,
  highs: HighsLike | null,
  tel: RelaxedTelemetry,
): EnumerationOutcome {
  let meta = enumerateStatesMeta(cluster, {
    maxStates: cfg.solver.maxStates,
    clusterSizeCap: cfg.solver.clusterSizeCap,
  });
  cluster.validStates = meta.kind === 'ok' ? meta.states : [];

  // Must run before the L0 pin gate: a missing polarity is repairable (demoting Σ=1 → Σ≤1
  // re-admits the gap world); only an unrepairable one is a degeneracy.
  if (cluster.validStates.length > 0) {
    const repaired = repairOmegaCompleteness(cluster, cfg);
    if (repaired) meta = repaired;
  }

  // Ω-liveness L0: a non-empty validStates is a complete enumeration, so any pinned
  // question means Ω is built from contradictory constraints; the cluster is never solved.
  if (cluster.validStates.length > 0) {
    const pinned = computePinnedQuestions(cluster);
    if (pinned.length > 0) {
      cluster.pinnedQuestions = pinned;
      cluster.degenerate = true;
      const setIds = cluster.outcomeSets
        .filter((os) => os.slotQuestionIds.some((q) => pinned.includes(q)))
        .map((os) => os.setId);
      const edgeIds = cluster.edges
        .filter((e) => pinned.includes(e.antecedentQuestionId) || pinned.includes(e.consequentQuestionId))
        .map((e) => e.edgeId);
      log.warn(
        `Ω-liveness L0 DEGENERATE cluster ${cluster.id}: pinned question(s) ` +
          `[${pinned.join(',')}] across ${cluster.validStates.length} state(s) — ` +
          `contradictory Ω (sets [${setIds.join(',')}], edges [${edgeIds.join(',')}]); ` +
          `never solved (pipeline-defect bug report).`,
      );
    }
  } else if (meta.kind === 'dropped' && cfg.solver.relaxedRoute) {
    // The V-rep enumeration over-capped: re-route to a facet-only solve within the facet caps.
    const qCount = cluster.questions.size;
    if (qCount > cfg.solver.facetClusterQuestionCap) {
      log.warn(
        `Cluster ${cluster.id} DROPPED (over facet cap): ${qCount} questions ` +
          `> FACET_CLUSTER_QUESTION_CAP ${cfg.solver.facetClusterQuestionCap}`,
      );
    } else {
      const facets = clusterToFacets(cluster, () => false);
      if (facets.length > 20_000) {
        log.warn(
          `Cluster ${cluster.id} DROPPED (over facet cap): ${facets.length} facets > 20000`,
        );
      } else {
        cluster.relaxed = true;
        tel.relaxedCount++;
        if (qCount > tel.relaxedMaxQuestions) tel.relaxedMaxQuestions = qCount;
        if (meta.projected > tel.relaxedMaxProjected) tel.relaxedMaxProjected = meta.projected;
        // Empty facet region = contradictory Ω; skipped if HiGHS isn't loaded yet.
        if (highs && !facetsFeasible(facets, [...cluster.questions.keys()], highs)) {
          cluster.degenerate = true;
          log.warn(
            `Ω-liveness (relaxed) DEGENERATE cluster ${cluster.id}: facet region is ` +
              `INFEASIBLE across ${qCount} questions — contradictory Ω; never solved ` +
              `(pipeline-defect bug report).`,
          );
        }
        log.warn(
          `Cluster ${cluster.id} ROUTED-FACET: ${qCount} questions, ` +
            `projected=${meta.projected}, facets=${facets.length} | ` +
            `sets[${meta.setBreakdown.join(',')}]`,
        );
      }
    }
  }
  return meta;
}

// Demotes every offending exhaustive set to Σ≤1 and re-enumerates a shadow cluster; adopts it
// if complete, else marks the cluster degenerate. Demoted sets replace the cluster's entries
// as COPIES — the graph-level objects are shared across clusters and must never be mutated.
function repairOmegaCompleteness(cluster: Cluster, cfg: AppConfig): EnumerationOutcome | null {
  const interp = interpretCluster(cluster);
  const check = checkOmegaCompleteness(interp, cluster.validStates);
  if (check.complete) return null;

  if (check.offendingSetIds.length === 0) {
    cluster.degenerate = true;
    log.warn(
      `Ω-completeness DEGENERATE cluster ${cluster.id}: question(s) ` +
        `[${check.incompleteQids.join(',')}] never take both polarities across ` +
        `${cluster.validStates.length} state(s) and NO exhaustive set can account for it ` +
        `(mutex-across-rungs class); never solved (pipeline-defect bug report).`,
    );
    return null;
  }

  const demote = new Set(check.offendingSetIds);
  const demotedSets = cluster.outcomeSets.map((os) =>
    demote.has(os.setId) && os.setType === 'categorical' && os.isExhaustive === true
      ? { ...os, isExhaustive: false }
      : os,
  );
  const shadow: Cluster = { ...cluster, outcomeSets: demotedSets };
  const shadowMeta = enumerateStatesMeta(shadow, {
    maxStates: cfg.solver.maxStates,
    clusterSizeCap: cfg.solver.clusterSizeCap,
  });
  const shadowStates = shadowMeta.kind === 'ok' ? shadowMeta.states : [];
  const recheck = checkOmegaCompleteness(interpretCluster(shadow), shadowStates);

  if (shadowStates.length === 0 || !recheck.complete) {
    cluster.degenerate = true;
    log.warn(
      `Ω-completeness DEGENERATE cluster ${cluster.id}: question(s) ` +
        `[${check.incompleteQids.join(',')}] still pinned after demoting set(s) ` +
        `[${check.offendingSetIds.join(',')}] to Σ≤1 (${shadowStates.length} state(s)); ` +
        `never solved (pipeline-defect bug report).`,
    );
    return null;
  }

  const before = cluster.validStates.length;
  cluster.outcomeSets = demotedSets;
  cluster.validStates = shadowStates;
  cluster.omegaCompletenessDemotedSetIds = check.offendingSetIds;
  log.warn(
    `Ω-completeness REPAIRED cluster ${cluster.id}: question(s) ` +
      `[${check.incompleteQids.join(',')}] had no gap world — demoted exhaustive set(s) ` +
      `[${check.offendingSetIds.join(',')}] Σ=1→Σ≤1; states ${before} → ${shadowStates.length} ` +
      `(Ω enlarged — dropping an exhaustivity claim only adds worlds, so it can never manufacture an arb).`,
  );
  return shadowMeta;
}

// Identical to {@link finalizeClusters} except each cluster's enumerate/pin/route step is
// served from a content-addressed {@link EnumCache} on a `structureKey` hit. A
// `relaxed && highs == null` cluster is never cached (its degenerate decision was deferred).
export function finalizeClustersIncremental(
  graph: ConstraintGraph,
  cfg: AppConfig,
  highs: HighsLike | null,
  cache: EnumCache,
): {
  clusters: Cluster[];
  marketClusterIndex: Map<number, Cluster>;
  clusterById: Map<number, Cluster>;
} {
  const clusters = buildClusters(graph, { clusterSizeCap: cfg.solver.clusterSizeCap });
  const marketClusterIndex = buildMarketIndex(clusters);
  const clusterById = new Map(clusters.map((c) => [c.id, c]));

  const epoch = configEpoch(cfg);
  const tel: RelaxedTelemetry = { relaxedCount: 0, relaxedMaxQuestions: 0, relaxedMaxProjected: 0 };
  const seen = new Set<string>();
  let reused = 0;
  let enumerated = 0;

  for (const cluster of clusters) {
    const key = structureKey(cluster, epoch);
    seen.add(key);

    const hit = cache.get(key);
    if (hit) {
      cluster.validStates = hit.outcome.kind === 'ok' ? hit.outcome.states : [];
      if (hit.pinned.length > 0) cluster.pinnedQuestions = hit.pinned;
      if (hit.degenerate) cluster.degenerate = true;
      if (hit.relaxed) cluster.relaxed = true;
      // The cached states already encode the demotion; replay it onto the fresh set refs.
      if (hit.demotedSetIds.length > 0) {
        const demote = new Set(hit.demotedSetIds);
        cluster.outcomeSets = cluster.outcomeSets.map((os) =>
          demote.has(os.setId) && os.setType === 'categorical' && os.isExhaustive === true
            ? { ...os, isExhaustive: false }
            : os,
        );
        cluster.omegaCompletenessDemotedSetIds = hit.demotedSetIds;
      }
      reused++;
      continue;
    }

    const meta = enumerateAndRouteCluster(cluster, cfg, highs, tel);
    enumerated++;

    if (cluster.relaxed === true && highs == null) continue;

    cache.set(key, {
      outcome: meta,
      pinned: cluster.pinnedQuestions ?? [],
      degenerate: cluster.degenerate ?? false,
      relaxed: cluster.relaxed ?? false,
      demotedSetIds: cluster.omegaCompletenessDemotedSetIds ?? [],
    });
  }

  const evicted = cache.sweep(seen);
  lastIncrementalReused = reused;
  lastIncrementalEnumerated = enumerated;
  lastIncrementalEvicted = evicted;

  logRelaxedTelemetry(tel);
  log.info(
    `enum-cache finalize: ${reused} reused / ${enumerated} enumerated / ${evicted} evicted ` +
      `(cache size ${cache.size})`,
  );

  return { clusters, marketClusterIndex, clusterById };
}

// Periodic price-arm refresh of the containment belt against the live cache. Returns rebuilt
// clusters when the belt removed a set/edge, else null; monotone across quiet-book rechecks.
export function refreshPriceBelt(
  graph: ConstraintGraph,
  cfg: AppConfig,
  priceBelt: PriceBeltWiring,
): { clusters: Cluster[]; marketClusterIndex: Map<number, Cluster>; clusterById: Map<number, Cluster> } | null {
  const latched = applyContainmentLatch(graph, priceBelt.latch);
  const res = applyIntraSetContainmentBelt(graph, { yesBidOf: priceBelt.yesBidOf });
  latchBeltResult(priceBelt.latch, res);
  const changed = latched.setsFreed + latched.edgesDropped + res.setsFreed + res.edgesDropped;
  if (changed === 0) return null;
  log.info(
    `mechanism-2 price-belt refresh: ${res.priceContradictionHits} price / ${res.zeroOverlapHits} zero-overlap / ` +
      `${res.containmentHits} containment hit(s) — freed ${res.setsFreed + latched.setsFreed} set(s), ` +
      `dropped ${res.edgesDropped + latched.edgesDropped} edge(s); rebuilding clusters.`,
  );
  return finalizeClusters(graph, cfg);
}

// Ω-liveness L2: an exhaustive categorical set with ≥1 unquoted slot is treated as Σ≤1 for this
// tick (pure loosening). Re-enumerates only on a mask transition.
export function applyLivenessDemotion(
  cluster: Cluster,
  isUnquoted: (qid: number) => boolean,
  masks: Map<number, string>,
  cfg: AppConfig,
): boolean {
  // A relaxed cluster's L2 demotion lives in `buildFacetLP`'s `isUnquoted` predicate instead.
  if (cluster.relaxed) return false;
  const demoteSetIds: number[] = [];
  for (const os of cluster.outcomeSets) {
    if (os.setType !== 'categorical' || os.isExhaustive !== true) continue;
    if (os.slotQuestionIds.some((q) => isUnquoted(q))) demoteSetIds.push(os.setId);
  }
  const maskKey = demoteSetIds.sort((a, b) => a - b).join(',');
  const prev = masks.get(cluster.id) ?? '';
  if (maskKey === prev) return false;
  masks.set(cluster.id, maskKey);
  if (maskKey === '') {
    cluster.validStates = enumerateStates(cluster, {
      maxStates: cfg.solver.maxStates,
      clusterSizeCap: cfg.solver.clusterSizeCap,
    });
    return true;
  }
  const demoteSet = new Set(demoteSetIds);
  const demotedSets = cluster.outcomeSets.map((os) =>
    demoteSet.has(os.setId) ? { ...os, isExhaustive: false } : os,
  );
  const shadow: Cluster = { ...cluster, outcomeSets: demotedSets };
  cluster.validStates = enumerateStates(shadow, {
    maxStates: cfg.solver.maxStates,
    clusterSizeCap: cfg.solver.clusterSizeCap,
  });
  return true;
}

export { unquotedQuestions };

export type SolveEngine = 'vrep' | 'facet' | 'hybrid';

// The worker pool renders V-rep state rows only, so a facet LP must be solved in-process here.
export async function solveProblem(lp: LPProblem): Promise<LPResult> {
  return lp.facetForm ? solveFacetLP(lp) : solveLP(lp);
}

export function buildForEngine(
  engine: SolveEngine,
  cluster: Cluster,
  priceCache: PriceCache,
  execution: AppConfig['execution'],
  now: number,
): LPProblem | null {
  const empty = cluster.validStates.length === 0;
  const useFacet = engine === 'facet' || (engine === 'hybrid' && (cluster.relaxed === true || empty));
  // Under 'vrep' a relaxed/empty cluster has no LP; refuse rather than hand buildLP a stateless cluster.
  if (!useFacet && (cluster.relaxed === true || empty)) return null;
  return useFacet
    ? buildFacetLP(cluster, priceCache, execution, now)
    : buildLP(cluster, priceCache, execution);
}

// Fails open on a DB error, since a blip must not blind the solver; `filterSubsToLive` only ever removes.
export async function collectMarketsToTrack(
  clusters: Cluster[],
  cfg: AppConfig,
  log: Logger,
): Promise<MarketSubscription[]> {
  const subs: MarketSubscription[] = [];
  const seen = new Set<number>();

  for (const cluster of clusters) {
    for (const [, question] of cluster.questions) {
      for (const [, market] of question.markets) {
        if (!seen.has(market.marketId)) {
          seen.add(market.marketId);
          subs.push({
            marketId: market.marketId,
            platformId: market.platformId,
            platform: market.platform,
          });
        }
      }
    }
  }

  if (!cfg.execution.liveSubscribeGate) return subs;
  const liveIds = await getLiveMarketIds([...seen]);
  if (liveIds === null) {
    log.error('live-subscribe gate: DB query failed — subscribing all candidates (fail-open)');
    return subs;
  }
  const kept = filterSubsToLive(subs, liveIds);
  const dropped = subs.length - kept.length;
  if (dropped > 0) {
    log.info(`live-subscribe gate: dropped ${dropped} resolved/expired market(s) (${kept.length} live kept)`);
  }
  return kept;
}

// A stale cert is dropped so a later tick cannot skip on a non-Optimal or structurally-different solve.
export function refreshCert(
  dualCerts: Map<number, ClusterDualCert>,
  clusterId: number,
  lp: LPProblem,
  result: LPResult,
): void {
  const cert = buildCert(lp, result);
  if (cert) dualCerts.set(clusterId, cert);
  else dualCerts.delete(clusterId);
}

export interface SolvePrepDeps {
  priceCache: PriceCache;
  lastSolveFingerprint: Map<number, string>;
  dualCerts: Map<number, ClusterDualCert>;
  livenessMasks: Map<number, string>;
}

export type SolvePrep =
  | { kind: 'skip' }
  | { kind: 'skip-filter' }
  // NOT a no-arb proof: the caller must not untrack the cluster or touch its arb state.
  | { kind: 'skip-quoted-fraction'; quotedFraction: number }
  | { kind: 'solve'; lp: LPProblem };

// `dedup` is a parameter, not read from config: the harness's worker-pool path dedups unconditionally.
export function prepareClusterForSolve(
  deps: SolvePrepDeps,
  clusterId: number,
  cluster: Cluster,
  now: number,
  opts: {
    dedup: boolean;
    skipFilter: boolean;
    theta: number;
    execution: AppConfig['execution'];
    buildLp?: (cluster: Cluster) => LPProblem | null;
    engine?: SolveEngine;
  },
): SolvePrep {
  const engine = opts.engine ?? 'vrep';
  const facetPath = engine === 'facet' || (engine === 'hybrid' && (cluster.relaxed === true || cluster.validStates.length === 0));

  if (cluster.degenerate) return { kind: 'skip' };
  if (!facetPath && cluster.relaxed === true) return { kind: 'skip' };

  // Must run before the fingerprint/skip-filter decision and buildLP: on a mask transition
  // the stored dual cert and fingerprint are dropped too, so no stale cert can skip across it.
  const unq = unquotedQuestions(cluster, deps.priceCache, now);

  // Perf/noise hygiene, not soundness (omega-audit L3/L4 already grade dead-sibling baskets
  // post-solve). Must run before the fingerprint dedup so a skip never records a stale fingerprint.
  const totalQuestions = cluster.questions.size;
  if (totalQuestions > 0) {
    const floor = opts.execution.quotedFractionSolveFloor ?? DEFAULT_QUOTED_FRACTION_SOLVE_FLOOR;
    const quotedFraction = (totalQuestions - unq.size) / totalQuestions;
    if (quotedFraction < floor) {
      return { kind: 'skip-quoted-fraction', quotedFraction };
    }
  }

  const maskChanged = applyLivenessDemotion(cluster, (qid) => unq.has(qid), deps.livenessMasks, config);
  if (maskChanged) {
    deps.dualCerts.delete(clusterId);
    deps.lastSolveFingerprint.delete(clusterId);
    if (!facetPath && cluster.validStates.length === 0) return { kind: 'skip' };
  }

  if (opts.dedup) {
    const fp = clusterFingerprint(cluster, deps.priceCache, now);
    if (deps.lastSolveFingerprint.get(clusterId) === fp) return { kind: 'skip' };
    deps.lastSolveFingerprint.set(clusterId, fp);
  }

  const lp = opts.buildLp
    ? opts.buildLp(cluster)
    : buildForEngine(engine, cluster, deps.priceCache, opts.execution, now);
  if (!lp) return { kind: 'skip' };

  if (opts.skipFilter && decideSkip(deps.dualCerts.get(clusterId), lp, opts.theta).skip) {
    return { kind: 'skip-filter' };
  }
  // Telemetry only, never a decision.
  if (cluster.relaxed === true && facetPath) relaxedSolvePreparedCount++;
  return { kind: 'solve', lp };
}
