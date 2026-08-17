/**
 * Observation harness — drives the same production solve path as the daemon
 * (`index.ts`) against the live CLOB feeds, but is read-only (no DB
 * persistence) and writes every arb it finds in full debugging detail to
 * ARB_DETAIL_LOG (.log human-readable + .jsonl machine).
 */
import 'dotenv/config';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { buildLP } from '../solver/lp-builder.js';
import { solveLP, getSolveCostSplit } from '../solver/solver.js';
import { buildFacetLP, solveFacetLP } from '../solver/facet-lp.js';
import { type ClusterDualCert } from '../solver/skip-filter.js';
import { SolverPool } from '../solver/solver-pool.js';
import { extractPortfolio } from '../solver/portfolio.js';
import { checkFiredPortfolioTripwires } from '../solver/omega-audit.js';
import { legPriceSource } from '../solver/lp-builder.js';
import { PriceCache, isDeadSnapshot } from '../clob/price-cache.js';
import { newContainmentLatch } from '../graph/intra-set-containment-belt.js';
import { ClobManager } from '../clob/manager.js';
import { IoHost } from '../clob/io-thread/io-host.js';
import {
  loadClusterGraph,
  loadClusterGraphIncremental,
  refreshPriceBelt,
  collectMarketsToTrack,
  refreshCert as refreshCertCore,
  prepareClusterForSolve,
  buildForEngine,
  solveProblem,
  lastIncrementalFinalizeStats,
} from '../solve-core.js';
import { EnumCache } from '../graph/enum-cache.js';
import { buildRestValidation, type RestValidation } from './rest-crosscheck-stamp.js';
import { restCrosscheckDebugTally, restCrosscheckDiagLine } from '../clob/rest-crosscheck.js';
import type { Cluster, ConstraintGraph } from '../graph/types.js';
import type { MarketSubscription } from '../clob/price-cache.js';
import type { LPProblem, LPResult } from '../solver/types.js';
import type { ExecutionGrade } from '../solver/execution-grade.js';
import { advanceEpisodeGrades, isCleanTransition } from './episode-grade.js';
import { edgeMagnitudeTripwireCensus } from '../solver/execution-grade.js';
import type { Platform } from '@arb/types';
import { createLogger } from '@arb/logger';

const log = createLogger('monitor:run');

// Annotation only; never changes detection/grade.
const REST_CROSSCHECK_ON = process.env.REST_CROSSCHECK === '1';
// Hard cap (ms); on timeout the stamp is written with timedOut=true.
const REST_CROSSCHECK_BUDGET_MS = (() => {
  const v = parseInt(process.env.REST_CROSSCHECK_BUDGET_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 12000;
})();

// Tracked so shutdown can drain in-flight REST-STAMP writes before exit.
const inFlightRestStamps = new Set<Promise<void>>();

/** Never throws; races buildRestValidation against the budget. */
async function runRestCrosscheck(rec: {
  portfolio: { legs: Array<{ marketId: number; platform: Platform; platformId: string; side: 'YES' | 'NO' }> } | null;
  clusterMarkets: Array<{
    marketId: number;
    platform: Platform;
    platformId: string;
    yesBook: { bestBid: number; bestAsk: number; lastUpdate?: number; staleSince?: number | null } | null;
    noBook: { bestBid: number; bestAsk: number; lastUpdate?: number; staleSince?: number | null } | null;
  }>;
}): Promise<RestValidation | null> {
  if (!REST_CROSSCHECK_ON || !rec.portfolio || rec.portfolio.legs.length === 0) return null;
  const legs = rec.portfolio.legs.map((l) => ({
    marketId: l.marketId,
    platform: l.platform,
    platformId: l.platformId,
    side: l.side,
  }));
  const work = buildRestValidation({
    legs,
    clusterMarkets: rec.clusterMarkets,
    budgetMs: REST_CROSSCHECK_BUDGET_MS,
    restFetcher: ioHost ? (ref) => ioHost.fetchRestBook(ref) : undefined,
  });
  const timeout = new Promise<RestValidation>((resolve) =>
    setTimeout(
      () =>
        resolve({
          checkedAt: new Date().toISOString(),
          budgetMs: REST_CROSSCHECK_BUDGET_MS,
          timedOut: true,
          allValid: false,
          perLeg: [],
        }),
      REST_CROSSCHECK_BUDGET_MS,
    ),
  );
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return {
      checkedAt: new Date().toISOString(),
      budgetMs: REST_CROSSCHECK_BUDGET_MS,
      timedOut: false,
      allValid: false,
      perLeg: [],
    };
  }
}

const BASE = process.env.ARB_DETAIL_LOG ?? 'data/exports/arb-run/arbs';
const LOG_TXT = `${BASE}.log`;
const LOG_JSONL = `${BASE}.jsonl`;
const RUN_MS = parseInt(process.env.ARB_RUN_DURATION_MS ?? `${8 * 60 * 60 * 1000}`);
// 0 = off; > 0 refreshes the graph in-process (background build, atomic swap), independent of RUN_MS.
const RELOAD_MS = parseInt(process.env.ARB_GRAPH_RELOAD_MS ?? '0');
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS ?? '60000');
const NEARMISS_MAX = parseFloat(process.env.ARB_NEARMISS_MAX ?? '1.0');

mkdirSync(dirname(LOG_TXT), { recursive: true });

const priceCache = new PriceCache();
// Process-lifetime latch: a mutex the live book refutes stays refuted across every graph reload.
const containmentLatch = newContainmentLatch();
const enumCache = new EnumCache();
// Guards reloadGraphIncremental against re-entrancy; also read by the belt-refresh timer.
let reloadInFlight = false;
// Dead/stale/sentinel books contribute null: never refutes a mutex on a missing quote.
const yesBidOf = (marketId: number): number | null => {
  const s = priceCache.get(marketId);
  if (isDeadSnapshot(s)) return null;
  return s.bestBid > 0 ? s.bestBid : null;
};
const ioHost = config.clob.ioThread ? new IoHost() : null;
const clobManager = ioHost ?? new ClobManager();
let clusters: Cluster[] = [];
let loadedGraph: ConstraintGraph | null = null;
let marketClusterIndex = new Map<number, Cluster>();
let clusterById = new Map<number, Cluster>();
let solving = false; // overlap guard for the periodic solver
let trackedCount = 0;
const dirtySet = new Set<number>();
// Skip re-solving a cluster whose binding-leg prices are unchanged; worker-pool path only.
const lastSolveFingerprint = new Map<number, string>();
// Consulted before the HiGHS solve to prove no-arb and skip (SOLVE_SKIP_FILTER=1).
const dualCerts = new Map<number, ClusterDualCert>();
const livenessMasks = new Map<number, string>();
// θ = 1 − minProfit: an arb is reported iff optimalCost ≤ θ.
const THETA = 1 - config.solver.minProfit;
const solverPool = config.solver.workerPool ? new SolverPool() : null;

// SOLVE_ENGINE_COMPARE=1: solve every dirty cluster with both engines and log divergence.
const COMPARE = process.env.SOLVE_ENGINE_COMPARE === '1';
const COMPARE_JSONL = `${BASE}.compare.jsonl`;
const compareTally = {
  drains: 0, clustersSeen: 0, bothNoArb: 0,
  agreeArb: 0, profitDiff: 0, vOnly: 0, hOnly: 0,
  vDroppedHSolved: 0, // V-rep gave up but H-rep solved
  costMatch: 0, costMismatch: 0, maxAbsCostDelta: 0,
};

const stats = {
  started: 0,
  updates: 0,
  solves: 0,
  skipped: 0, // avoided via the dual-skip filter
  qfSkipped: 0, // declined for quotedFraction < floor
  arbs: 0,
  distinctArbs: 0,
  refused: 0, // blocked-grade refusals
  tripwire: 0,
  nearMisses: 0,
  distinctNear: 0,
  infeasible: 0,
  errors: 0,
  bestEdge: -Infinity, // max (1 − cost) seen, incl. negative
  bestEdgeCluster: 0,
  lastArbAt: 0,
};

// `grade` is the latest fired execution grade (clean|caution|risky — never blocked;
// blocked portfolios live in refusedState, not an episode).
type ArbEpisode = { edge: number; fires: number; firstTs: number; minRoi: number; maxRoi: number; firstRoi: number; grade: ExecutionGrade; gradeAtOpen: ExecutionGrade; bestGradeSeen: ExecutionGrade };
const arbState = new Map<number, ArbEpisode>();
const nearState = new Map<number, { cost: number; fires: number }>();
const refusedState = new Map<number, number>();
const LOG_EPISODES = `${BASE}.episodes.jsonl`;

type Lat = { n: number; sum: number; max: number; buckets: number[] };
const LAT_EDGES = [1, 5, 20, 100, 500, 2000]; // ms bucket upper bounds
const LAT_LABELS = ['<1', '1-5', '5-20', '20-100', '100-500', '.5-2k', '>2k'];
const mkLat = (): Lat => ({ n: 0, sum: 0, max: 0, buckets: [0, 0, 0, 0, 0, 0, 0] });
const lat = { book: mkLat(), build: mkLat(), solve: mkLat(), batch: mkLat() };
let maxQueue = 0;
function sampleLat(l: Lat, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  l.n++;
  l.sum += ms;
  if (ms > l.max) l.max = ms;
  let i = 0;
  while (i < LAT_EDGES.length && ms >= LAT_EDGES[i]) i++;
  l.buckets[i]++;
}
function latStr(l: Lat): string {
  if (!l.n) return 'n=0';
  const h = l.buckets.map((c, i) => (c ? `${LAT_LABELS[i]}:${c}` : '')).filter(Boolean).join(' ');
  return `mean=${(l.sum / l.n).toFixed(1)} max=${l.max.toFixed(0)}ms n=${l.n} [${h}]`;
}

function nowMs(): number {
  return Date.now();
}

function fmt(n: number | null | undefined, d = 4): string {
  return n == null || !Number.isFinite(n) ? '—' : n.toFixed(d);
}

/** One record per arb episode (closed, or still-open at shutdown). */
function writeEpisode(clusterId: number, s: ArbEpisode, endTs: number, status: 'closed' | 'still-open'): void {
  appendFileSync(
    LOG_EPISODES,
    JSON.stringify({
      clusterId,
      status,
      firstTs: new Date(s.firstTs).toISOString(),
      endTs: new Date(endTs).toISOString(),
      durationSec: (endTs - s.firstTs) / 1000,
      fires: s.fires,
      minRoiPct: s.minRoi,
      maxRoiPct: s.maxRoi,
      firstRoiPct: s.firstRoi,
      lastEdgeUsd: s.edge,
      gradeAtOpen: s.gradeAtOpen,
      bestGradeSeen: s.bestGradeSeen,
      gradeAtClose: s.grade,
    }) + '\n',
  );
}

/** `async` solely for the optional post-decision REST cross-check stamp (off by default). */
async function logDetail(
  kind: 'ARB' | 'NEAR-MISS' | 'ARB-REFUSED',
  cluster: Cluster,
  lp: LPProblem,
  optimalCost: number,
  values: number[],
  portfolio: ReturnType<typeof extractPortfolio> | null,
  now: number,
  opts: { cleanTransition?: boolean } = {},
): Promise<void> {
  const lines: string[] = [];
  const ts = new Date(now).toISOString();
  const edge = 1 - optimalCost;
  lines.push('');
  lines.push('═'.repeat(100));
  lines.push(
    `${kind}  ${ts}  cluster=${cluster.id}  cost=$${fmt(optimalCost)}  edge=$${fmt(edge)} ` +
      `(${fmt(edge * 100, 2)}%)  states=${cluster.validStates.length}  markets=${cluster.marketIds.size}`,
  );
  if (portfolio) {
    lines.push(
      `  profit=$${fmt(portfolio.profit)}  profit%=${fmt(portfolio.profitPct, 2)}  ` +
        `worstEnumeratedStatePayout=$${fmt(portfolio.worstEnumeratedStatePayout)}  guaranteedPayout=$${fmt(portfolio.guaranteedPayout)}  ` +
        `liquidityUsd=$${fmt(portfolio.liquidityUsd, 2)}  feesUsd=$${fmt(portfolio.feesUsd)}  ` +
        `grade=${portfolio.executionGrade}  solveMs=${fmt(portfolio.solveTimeMs, 0)}`,
    );
    lines.push(`  grade reasons: ${portfolio.executionReasons.join(' | ')}`);
    if (portfolio.settlementVenueMismatch) {
      lines.push(
        `  ⚠ CROSS-VENUE SETTLEMENT RISK: legs span ${portfolio.venues.join('+')} — venues settle ` +
          `edge outcomes independently (cancel/void ≠ complementary); NOT guaranteed.`,
      );
    }
  }

  const ladderMode = process.env.CLOB_BOOK_LADDER === '1';
  lines.push(`  ── TRADE (legs with shares > 0)${ladderMode ? '  [DEPTH-AWARE ladder]' : ''} ──`);
  const traded = new Set<number>();
  if (portfolio) {
    for (const leg of portfolio.legs) {
      traded.add(leg.marketId);
      // In ladder mode `askPrice` is the BLENDED average across consumed levels.
      const priceLabel = ladderMode && (leg.levelsConsumed ?? 1) > 1 ? 'blended' : 'ask';
      lines.push(
        `    BUY ${leg.side.padEnd(3)} M${leg.marketId} (${leg.platform}/${leg.platformId})  ` +
          `${fmt(leg.shares, 2)} shares @ ${priceLabel} $${fmt(leg.askPrice)} + fee $${fmt(leg.feeUsd / Math.max(leg.shares, 1e-9))}/sh ` +
          `→ leg cost $${fmt(leg.cost)} (fee $${fmt(leg.feeUsd)})  ` +
          `askSize=${fmt(leg.askSize, 1)} bid=$${fmt(leg.bidPrice)}` +
          (leg.levelsConsumed != null ? `  levels=${leg.levelsConsumed}` : ''),
      );
      // Depth profile: how deep the fill walked, cheapest level first.
      if (leg.depthProfile && leg.depthProfile.length > 1) {
        const prof = leg.depthProfile
          .map((d, i) => `L${i} ${fmt(d.shares, 1)}sh@$${fmt(d.price)}`)
          .join('  ');
        lines.push(`        depth: ${prof}`);
      }
    }
    // Depth-aware basket totals: $ invested at real depth and the $ profit it
    // extracts (= profit% × total invested). In ladder mode the LP walks deeper,
    // so this can far exceed the top-of-book-only figure.
    if (ladderMode) {
      const invested = portfolio.totalCost;
      const profitUsd = (portfolio.profitPct / 100) * invested;
      lines.push(
        `  ── DEPTH-AWARE basket: invested $${fmt(invested, 2)}  ` +
          `profit $${fmt(profitUsd, 2)} (${fmt(portfolio.profitPct, 2)}%)  ` +
          `deployableUsd(binding leg) $${fmt(portfolio.liquidityUsd, 2)} ──`,
      );
    }
  } else {
    // near-miss: show the raw LP variable allocation
    for (let i = 0; i < lp.variables.length; i++) {
      const v = lp.variables[i];
      const sh = values[i] ?? 0;
      if (sh > 1e-6) {
        lines.push(
          `    (lp) ${v.side} M${v.marketId} (${v.platform})  ${fmt(sh, 2)} sh @ $${fmt(v.askPrice)} ` +
            `+fee/sh $${fmt(v.feePerShare)}  src=${legPriceSource(v)} cap=${v.maxShares == null ? '∞' : fmt(v.maxShares, 1)}`,
        );
      }
    }
  }

  // ── CLUSTER CONTEXT: every related market, its books + fee model ──
  lines.push('  ── CLUSTER MARKETS (all related, for getting the CLOB) ──');
  for (const [, q] of cluster.questions) {
    lines.push(
      `    Q${q.questionId} "${(q.canonicalSubject ?? '').slice(0, 70)}" ` +
        `shape=${q.conditionShape ?? '—'} val=${q.conditionValue ?? '—'} date=${q.conditionDate ?? '—'}`,
    );
    for (const [, m] of q.markets) {
      const y = priceCache.get(m.marketId, now);
      const n = priceCache.getNo(m.marketId, now);
      const fm = m.feeModel;
      const yAge = y && y.lastUpdate > 0 ? `${Math.round((now - y.lastUpdate) / 1000)}s` : 'never';
      const yStr = y
        ? `YES bid $${fmt(y.bestBid)}×${fmt(y.bidSize, 0)} / ask $${fmt(y.bestAsk)}×${fmt(y.askSize, 0)} (${yAge}${y.staleSince ? ' STALE' : ''})`
        : 'YES —';
      const nStr = n
        ? `NO bid $${fmt(n.bestBid)}×${fmt(n.bidSize, 0)} / ask $${fmt(n.bestAsk)}×${fmt(n.askSize, 0)}`
        : 'NO synthetic(1−YESbid)';
      const feeStr = fm
        ? `fee=${fm.form}(rate=${fmt(fm.rate, 4)},exp=${fmt(fm.exponent, 1)})`
        : 'fee=default';
      lines.push(
        `      ${traded.has(m.marketId) ? '►' : ' '} M${m.marketId} ${m.platform}/${m.platformId}  ` +
          `${yStr}  ${nStr}  ${feeStr}  end=${m.endDateMs ? new Date(m.endDateMs).toISOString().slice(0, 10) : '—'}`,
      );
    }
  }
  lines.push('═'.repeat(100));
  appendFileSync(LOG_TXT, lines.join('\n') + '\n');

  const rec = {
    kind,
    ts,
    clusterId: cluster.id,
    optimalCost,
    edge,
    stateCount: cluster.validStates.length,
    marketCount: cluster.marketIds.size,
    // True iff over-capped and solved facet-only (H-rep, grade capped ≤ caution).
    relaxed: cluster.relaxed === true,
    ...(opts.cleanTransition ? { cleanTransition: true } : {}),
    portfolio: portfolio
      ? {
          profit: portfolio.profit,
          profitPct: portfolio.profitPct,
          totalCost: portfolio.totalCost,
          // FROZEN JSONL key `worstStatePayout`: the dashboard reads this name; keep it stable.
          worstStatePayout: portfolio.worstEnumeratedStatePayout,
          liquidityUsd: portfolio.liquidityUsd,
          feesUsd: portfolio.feesUsd,
          executionGrade: portfolio.executionGrade,
          executionReasons: portfolio.executionReasons,
          omegaAudit: portfolio.omegaAudit,
          venues: portfolio.venues,
          settlementVenueMismatch: portfolio.settlementVenueMismatch,
          legs: portfolio.legs,
        }
      : null,
    clusterMarkets: [...cluster.questions.values()].flatMap((q) =>
      [...q.markets.values()].map((m) => {
        const y = priceCache.get(m.marketId, now);
        const n = priceCache.getNo(m.marketId, now);
        return {
          questionId: q.questionId,
          subject: q.canonicalSubject,
          conditionShape: q.conditionShape,
          conditionValue: q.conditionValue,
          marketId: m.marketId,
          platform: m.platform,
          platformId: m.platformId,
          endDateMs: m.endDateMs,
          feeModel: m.feeModel,
          yesBook: y ? { bestBid: y.bestBid, bestAsk: y.bestAsk, bidSize: y.bidSize, askSize: y.askSize, lastUpdate: y.lastUpdate, staleSince: y.staleSince, askLevels: y.askLevels, bidLevels: y.bidLevels } : null,
          noBook: n ? { bestBid: n.bestBid, bestAsk: n.bestAsk, bidSize: n.bidSize, askSize: n.askSize, lastUpdate: n.lastUpdate, askLevels: n.askLevels, bidLevels: n.bidLevels } : null,
        };
      }),
    ),
  };

  // Not awaited: the cross-check runs detached, appending a REST-STAMP line joined back on (clusterId, ts).
  if (REST_CROSSCHECK_ON && kind === 'ARB' && rec.portfolio) {
    const arbTs = ts;
    const clusterId = cluster.id;
    appendFileSync(LOG_JSONL, JSON.stringify({ ...rec, restValidationPending: true }) + '\n');
    const stampTask = (async () => {
      const restValidation = await runRestCrosscheck(rec);
      if (restValidation) {
        appendFileSync(
          LOG_JSONL,
          JSON.stringify({ kind: 'REST-STAMP', ts: arbTs, clusterId, restValidation }) + '\n',
        );
      }
    })();
    const tracked = stampTask
      .catch((err) => { log.error('rest-crosscheck stamp error', err); })
      .finally(() => { inFlightRestStamps.delete(tracked); });
    inFlightRestStamps.add(tracked);
    return;
  }
  appendFileSync(LOG_JSONL, JSON.stringify(rec) + '\n');
}

async function loadGraph(): Promise<void> {
  const loaded = await loadClusterGraph(config, { yesBidOf, latch: containmentLatch });
  clusters = loaded.clusters;
  loadedGraph = loaded.graph;
  marketClusterIndex = loaded.marketClusterIndex;
  clusterById = loaded.clusterById;
  const totalStates = clusters.reduce((s, c) => s + c.validStates.length, 0);
  log.info(
    `Graph: ${clusters.length} clusters, ${loaded.graph.questions.size} questions, ` +
      `${loaded.graph.edges.length} edges, ${totalStates} valid states`,
  );
}

async function getMarketsToTrack(): Promise<MarketSubscription[]> {
  // Fails open on a DB error (keeps all subs); only ever removes a sub, never adds one.
  return collectMarketsToTrack(clusters, config, log);
}

/** Must run before cluster IDs are reassigned (a fresh build renumbers from 0). */
function flushAndClearEpisodes(now: number): void {
  for (const [cid, s] of arbState) writeEpisode(cid, s, now, 'closed');
  arbState.clear();
  refusedState.clear();
  nearState.clear();
}

/** Re-entrancy guarded by `reloadInFlight`; the belt-refresh timer also gates on it. */
async function reloadGraphIncremental(): Promise<void> {
  if (reloadInFlight || RELOAD_MS <= 0) return;
  reloadInFlight = true;
  try {
    const built = await loadClusterGraphIncremental(config, enumCache, { yesBidOf, latch: containmentLatch });
    const newMarkets = await collectMarketsToTrack(built.clusters, config, log);

    const now = nowMs();
    clusters = built.clusters;
    loadedGraph = built.graph;
    marketClusterIndex = built.marketClusterIndex;
    clusterById = built.clusterById;
    lastSolveFingerprint.clear();
    dualCerts.clear();
    livenessMasks.clear();
    flushAndClearEpisodes(now);
    dirtySet.clear();
    for (const c of clusters) dirtySet.add(c.id);
    trackedCount = newMarkets.length;

    for (const m of newMarkets) priceCache.track(m.marketId);
    priceCache.evict(new Set(newMarkets.map((m) => m.marketId)));
    await clobManager.updateSubscriptions(newMarkets);

    const st = lastIncrementalFinalizeStats();
    log.info(
      `⟳ graph reload (incremental): ${clusters.length} clusters, ${newMarkets.length} tracked ` +
        `— enum-cache ${st.reused} reused / ${st.enumerated} enumerated / ${st.evicted} evicted`,
    );
  } catch (err) {
    stats.errors++;
    log.error('incremental graph reload error', err);
  } finally {
    reloadInFlight = false;
  }
}

/** Shared by the serial and worker-pool paths so both feed identical per-result logic. */
async function processResult(clusterId: number, cluster: Cluster, lp: LPProblem, result: LPResult, now: number): Promise<void> {
  stats.solves++;
  sampleLat(lat.solve, result.solveTimeMs);
  if (result.status !== 'Optimal') {
    if (result.status === 'Infeasible') stats.infeasible++;
    return;
  }
  const edge = 1 - result.optimalCost;
  if (edge > stats.bestEdge) {
    stats.bestEdge = edge;
    stats.bestEdgeCluster = clusterId;
  }
  let isArb = false;
  if (result.optimalCost < 1.0) {
    const portfolio = extractPortfolio(
      result, lp, cluster, priceCache, config.solver.minProfit, config.execution.gradeThresholds, now,
      { maxStates: config.solver.maxStates, clusterSizeCap: config.solver.clusterSizeCap },
    );
    // A `blocked` portfolio is a refusal, not an arb.
    if (portfolio && portfolio.executionGrade === 'blocked') {
      stats.refused++;
      const prevR = refusedState.get(clusterId);
      refusedState.set(clusterId, (prevR ?? 0) + 1);
      if (!prevR) {
        log.info(
          `⛔ ARB-REFUSED cluster=${clusterId} profit=$${fmt(portfolio.profit)} ` +
            `legs=${portfolio.legs.length} reasons=[${portfolio.executionReasons.join(' | ')}]`,
        );
        await logDetail('ARB-REFUSED', cluster, lp, result.optimalCost, result.values, portfolio, now);
      }
      if (arbState.has(clusterId)) {
        const s = arbState.get(clusterId)!;
        writeEpisode(clusterId, s, now, 'closed');
        arbState.delete(clusterId);
      }
      return;
    }
    if (portfolio) {
      const trips = checkFiredPortfolioTripwires(cluster, lp.variables, portfolio.omegaAudit, priceCache, now, portfolio.executionGrade);
      if (trips.length > 0) {
        stats.tripwire += trips.length;
        stats.refused++;
        const prevR = refusedState.get(clusterId);
        refusedState.set(clusterId, (prevR ?? 0) + 1);
        if (!prevR) {
          log.error(
            `⛔ ARB-REFUSED (TRIPWIRE) cluster=${clusterId} ${trips.length} violation(s) ` +
              `total=${stats.tripwire} — ${trips.join(' ; ')}`,
          );
          await logDetail('ARB-REFUSED', cluster, lp, result.optimalCost, result.values, portfolio, now);
        }
        if (arbState.has(clusterId)) {
          const s = arbState.get(clusterId)!;
          writeEpisode(clusterId, s, now, 'closed');
          arbState.delete(clusterId);
        }
        return;
      }
    }
    if (portfolio) {
      isArb = true;
      stats.arbs++;
      stats.lastArbAt = now;
      const prev = arbState.get(clusterId);
      const roi = portfolio.profitPct;
      const g = portfolio.executionGrade;
      // Detect before overwriting arbState: prev must still hold the pre-transition grade.
      const transitionedToClean = isCleanTransition(prev?.grade, g);
      const grades = advanceEpisodeGrades(prev, g);
      arbState.set(clusterId, {
        edge: portfolio.profit,
        fires: (prev?.fires ?? 0) + 1,
        firstTs: prev?.firstTs ?? now,
        minRoi: prev ? Math.min(prev.minRoi, roi) : roi,
        maxRoi: prev ? Math.max(prev.maxRoi, roi) : roi,
        firstRoi: prev?.firstRoi ?? roi,
        ...grades,
      });
      if (!prev) {
        stats.distinctArbs++;
        log.info(
          `★ ARB cluster=${clusterId} profit=$${fmt(portfolio.profit)} (${fmt(portfolio.profitPct, 1)}%) ` +
            `legs=${portfolio.legs.length} grade=${g}`,
        );
        await logDetail('ARB', cluster, lp, result.optimalCost, result.values, portfolio, now, { cleanTransition: transitionedToClean });
      } else if (transitionedToClean) {
        // stats.distinctArbs intentionally not bumped — same cluster.
        log.info(
          `✔ CLEAN-TRANSITION cluster=${clusterId} profit=$${fmt(portfolio.profit)} ` +
            `(${fmt(portfolio.profitPct, 1)}%) legs=${portfolio.legs.length} fire#${(prev.fires ?? 0) + 1}`,
        );
        await logDetail('ARB', cluster, lp, result.optimalCost, result.values, portfolio, now, { cleanTransition: true });
      } else if (Math.abs(portfolio.profit - prev.edge) > 0.01) {
        appendFileSync(
          LOG_TXT,
          `# RE-PRICED cluster=${clusterId} edge $${fmt(prev.edge)} → $${fmt(portfolio.profit)} fire#${(prev.fires ?? 0) + 1}\n`,
        );
      }
    }
  }
  if (!isArb && arbState.has(clusterId)) {
    const s = arbState.get(clusterId)!;
    const durSec = (now - s.firstTs) / 1000;
    appendFileSync(
      LOG_TXT,
      `# ARB CLOSED cluster=${clusterId} | lasted ${fmt(durSec, 1)}s | fires=${s.fires} | ` +
        `ROI min=${fmt(s.minRoi, 2)}% max=${fmt(s.maxRoi, 2)}% first=${fmt(s.firstRoi, 2)}% (last edge $${fmt(s.edge)})\n`,
    );
    writeEpisode(clusterId, s, now, 'closed');
    arbState.delete(clusterId);
  }
  if (!isArb && result.optimalCost >= 1.0 && result.optimalCost < NEARMISS_MAX) {
    stats.nearMisses++;
    const prev = nearState.get(clusterId);
    const material = !prev || Math.abs(result.optimalCost - prev.cost) > 0.005;
    nearState.set(clusterId, { cost: result.optimalCost, fires: (prev?.fires ?? 0) + 1 });
    if (material) {
      if (!prev) stats.distinctNear++;
      await logDetail('NEAR-MISS', cluster, lp, result.optimalCost, result.values, null, now);
    }
  }
}

/** Drops a stale cert on a non-Optimal/dual-less/ladder result. */
function refreshCert(clusterId: number, lp: LPProblem, result: LPResult): void {
  refreshCertCore(dualCerts, clusterId, lp, result);
}

/** No stats.solves bump — a skip is the absence of a solve. */
function skipFilterDrop(clusterId: number, now: number): void {
  stats.skipped++;
  const s = arbState.get(clusterId);
  if (!s) return;
  const durSec = (now - s.firstTs) / 1000;
  appendFileSync(
    LOG_TXT,
    `# ARB CLOSED cluster=${clusterId} | lasted ${fmt(durSec, 1)}s | fires=${s.fires} | ` +
      `ROI min=${fmt(s.minRoi, 2)}% max=${fmt(s.maxRoi, 2)}% first=${fmt(s.firstRoi, 2)}% (last edge $${fmt(s.edge)}) [dual-skip]\n`,
  );
  writeEpisode(clusterId, s, now, 'closed');
  arbState.delete(clusterId);
}

/** Solves each dirty cluster with both engines off the same live price cache and logs any divergence. */
async function compareDrain(toSolve: number[], now: number, batchStart: number): Promise<void> {
  compareTally.drains++;
  const omegaOpts = { maxStates: config.solver.maxStates, clusterSizeCap: config.solver.clusterSizeCap };
  const yieldEvery = Math.max(1, config.solver.yieldEvery); // yield so GC can reclaim the 2× extract-portfolio garbage
  let seen = 0;
  for (const clusterId of toSolve) {
    const cluster = clusterById.get(clusterId);
    if (!cluster) continue;
    if (cluster.degenerate) continue; // never solved for either engine
    compareTally.clustersSeen++;
    if (++seen % yieldEvery === 0) await new Promise<void>((r) => setImmediate(r));

    // Build both LPs synchronously so a WS tick landing between them can't skew inputs.
    const prep = prepareClusterForSolve(
      { priceCache, lastSolveFingerprint, dualCerts, livenessMasks },
      clusterId, cluster, now,
      { dedup: false, skipFilter: false, theta: THETA, execution: config.execution },
    );
    const vLp = prep.kind === 'solve' ? prep.lp : null;
    const flp = buildFacetLP(cluster, priceCache, config.execution, now);

    let vCost: number | null = null;
    let vPort: ReturnType<typeof extractPortfolio> = null;
    const vDropped = vLp === null;
    if (vLp) {
      const vres = await solveLP(vLp);
      vCost = vres.optimalCost;
      if (vres.status === 'Optimal') {
        vPort = extractPortfolio(vres, vLp, cluster, priceCache, config.solver.minProfit, config.execution.gradeThresholds, now, omegaOpts);
      }
    }

    let fCost: number | null = null;
    let fPort: ReturnType<typeof extractPortfolio> = null;
    if (flp) {
      const fres = await solveFacetLP(flp);
      fCost = fres.optimalCost;
      if (fres.status === 'Optimal') {
        fPort = extractPortfolio(fres, flp, cluster, priceCache, config.solver.minProfit, config.execution.gradeThresholds, now, omegaOpts);
      }
    }

    if (vDropped && fCost !== null) compareTally.vDroppedHSolved++;
    if (vCost !== null && fCost !== null && Number.isFinite(vCost) && Number.isFinite(fCost)) {
      const d = Math.abs(vCost - fCost);
      if (d > compareTally.maxAbsCostDelta) compareTally.maxAbsCostDelta = d;
      if (d < 1e-4) compareTally.costMatch++; else compareTally.costMismatch++;
    }

    const vArb = !!vPort, fArb = !!fPort;
    if (!vArb && !fArb) { compareTally.bothNoArb++; continue; }

    let verdict: string;
    if (vArb && fArb) {
      verdict = Math.abs((vPort!.profit) - (fPort!.profit)) > 1e-4 ? 'PROFIT_DIFF' : 'AGREE_ARB';
      if (verdict === 'AGREE_ARB') compareTally.agreeArb++; else compareTally.profitDiff++;
    } else if (vArb) { verdict = 'V_ONLY'; compareTally.vOnly++; }
    else if (cluster.relaxed === true || cluster.validStates.length === 0) {
      // Keyed on `relaxed`, not vLp === null: buildLP also nulls on quoted-fraction/no-leg skips, an alarm case.
      verdict = 'H_RESCUE';
    } else { verdict = 'H_ONLY'; compareTally.hOnly++; }

    appendFileSync(COMPARE_JSONL, JSON.stringify({
      t: new Date(now).toISOString(), clusterId, verdict,
      q: cluster.questions.size, states: cluster.validStates.length, vDropped,
      relaxed: cluster.relaxed === true,
      vArb, fArb, vCost, fCost,
      vProfit: vPort?.profit ?? null, fProfit: fPort?.profit ?? null,
      vLegs: vPort?.legs.length ?? 0, fLegs: fPort?.legs.length ?? 0,
      vGrade: vPort?.executionGrade ?? null, fGrade: fPort?.executionGrade ?? null,
    }) + '\n');
  }
  sampleLat(lat.batch, performance.now() - batchStart);
}

async function solveDirty(): Promise<void> {
  const toSolve = [...dirtySet];
  dirtySet.clear();
  if (toSolve.length > maxQueue) maxQueue = toSolve.length;
  const batchStart = performance.now();
  const now = nowMs();

  if (COMPARE) { await compareDrain(toSolve, now, batchStart); return; }

  // The worker pool renders V-rep state-row LPs only; a facet (H-rep) LP solves in-process.
  const poolEngine = config.solver.engine;
  if (solverPool) {
    // Yields every config.solver.yieldEvery built LPs so WS sockets get serviced mid-build.
    const poolYieldEvery = config.solver.yieldEvery;
    let built_n = 0;
    const built: Array<{ clusterId: number; cluster: Cluster; lp: LPProblem }> = [];
    for (const clusterId of toSolve) {
      const cluster = clusterById.get(clusterId);
      // A relaxed/over-cap cluster is unsolvable under 'vrep' but the facet engine rescues it.
      if (!cluster) continue;
      if ((cluster.relaxed === true || cluster.validStates.length === 0) && poolEngine === 'vrep') continue;
      const prep = prepareClusterForSolve(
        { priceCache, lastSolveFingerprint, dualCerts, livenessMasks },
        clusterId, cluster, now,
        { dedup: true, skipFilter: config.solver.skipFilter, theta: THETA, execution: config.execution, engine: poolEngine },
      );
      if (prep.kind === 'skip') continue;
      if (prep.kind === 'skip-filter') { skipFilterDrop(clusterId, now); continue; }
      // Mostly-unquoted: decline this tick, leave tracking/arb state untouched (not a no-arb proof).
      if (prep.kind === 'skip-quoted-fraction') { stats.qfSkipped++; continue; }
      built.push({ clusterId, cluster, lp: prep.lp });
      // Yield so the event loop can read pending WS frames before building more.
      if (poolYieldEvery > 0 && ++built_n % poolYieldEvery === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    if (built.length > 0) {
      // Facet LPs solve in-process; V-rep LPs batch to the pool. Results merge back into `built` order.
      const results: LPResult[] = new Array(built.length);
      const poolIdx: number[] = [];
      const poolLps: LPProblem[] = [];
      for (let i = 0; i < built.length; i++) {
        if (built[i].lp.facetForm) results[i] = await solveFacetLP(built[i].lp);
        else { poolIdx.push(i); poolLps.push(built[i].lp); }
      }
      if (poolLps.length > 0) {
        let poolResults: LPResult[];
        try {
          poolResults = await solverPool.solveBatch(poolLps);
        } catch (err) {
          stats.errors++;
          sampleLat(lat.batch, performance.now() - batchStart);
          return;
        }
        for (let k = 0; k < poolIdx.length; k++) results[poolIdx[k]] = poolResults[k];
      }
      for (let i = 0; i < built.length; i++) {
        if (config.solver.skipFilter) refreshCert(built[i].clusterId, built[i].lp, results[i]);
        await processResult(built[i].clusterId, built[i].cluster, built[i].lp, results[i], now);
      }
    }
    sampleLat(lat.batch, performance.now() - batchStart);
    return;
  }

  // Serial path (default): fingerprint-dedup, then yield to the event loop every
  // config.solver.yieldEvery clusters so WS sockets get serviced mid-drain.
  const yieldEvery = config.solver.yieldEvery;
  let processed = 0;
  const engine = config.solver.engine;
  for (const clusterId of toSolve) {
    const cluster = clusterById.get(clusterId);
    if (!cluster) continue;
    if ((cluster.relaxed === true || cluster.validStates.length === 0) && engine === 'vrep') continue;
    const prep = prepareClusterForSolve(
      { priceCache, lastSolveFingerprint, dualCerts, livenessMasks },
      clusterId, cluster, now,
      {
        dedup: config.solver.serialDedup,
        skipFilter: config.solver.skipFilter,
        theta: THETA,
        execution: config.execution,
        engine,
        buildLp: (c) => {
          const buildStart = config.solver.costSplit ? performance.now() : 0;
          const lp = buildForEngine(engine, c, priceCache, config.execution, now);
          if (config.solver.costSplit) sampleLat(lat.build, performance.now() - buildStart);
          return lp;
        },
      },
    );
    if (prep.kind === 'skip') continue;
    if (prep.kind === 'skip-filter') { skipFilterDrop(clusterId, now); continue; }
    if (prep.kind === 'skip-quoted-fraction') { stats.qfSkipped++; continue; }
    let result;
    try {
      result = await solveProblem(prep.lp);
    } catch (err) {
      stats.errors++;
      continue;
    }
    if (config.solver.skipFilter) refreshCert(clusterId, prep.lp, result);
    await processResult(clusterId, cluster, prep.lp, result, now);
    // Yield so the event loop can read pending WS frames before the next cluster.
    if (yieldEvery > 0 && ++processed % yieldEvery === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  sampleLat(lat.batch, performance.now() - batchStart);
}

// `final=true` tags the shutdown line and does not reset it.
const REST_DIAG_INTERVAL_MS = (() => {
  const v = parseInt(process.env.REST_DIAG_INTERVAL_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 30000;
})();

async function restDiag(final = false): Promise<void> {
  if (!REST_CROSSCHECK_ON) return;
  const d = ioHost ? await ioHost.crosscheckDiag(!final) : restCrosscheckDiagLine(!final);
  if (!d) return;
  const now = nowMs();
  const mins = ((now - stats.started) / 60000).toFixed(1);
  const tag = final ? `+${mins}m FINAL` : `+${mins}m`;
  log.info(`[rest-diag ${tag}] ${d.summary} inflightStamps=${inFlightRestStamps.size}`);
  appendFileSync(LOG_TXT, `# [rest-diag ${tag}] ${d.summary} inflightStamps=${inFlightRestStamps.size}\n`);
  for (const s of d.samples) {
    log.info(`[rest-diag ${tag}] sample: ${s}`);
    appendFileSync(LOG_TXT, `# [rest-diag ${tag}] sample: ${s}\n`);
  }
}

/** blocked = distinct ARB-REFUSED clusters (refusedState), not part of arbState. */
function gradePartition(): {
  clean: number; caution: number; risky: number; blocked: number;
  bestCleanEdge: number; bestCleanCluster: number;
} {
  let clean = 0, caution = 0, risky = 0;
  let bestCleanEdge = -Infinity, bestCleanCluster = 0;
  for (const [cid, ep] of arbState) {
    if (ep.grade === 'clean') clean++;
    else if (ep.grade === 'caution') caution++;
    else risky++; // 'risky' (a 'blocked' episode is never stored — it is ARB-REFUSED)
    if ((ep.grade === 'clean' || ep.grade === 'caution') && ep.edge > bestCleanEdge) {
      bestCleanEdge = ep.edge;
      bestCleanCluster = cid;
    }
  }
  return { clean, caution, risky, blocked: refusedState.size, bestCleanEdge, bestCleanCluster };
}

function compareSummaryLine(): string {
  const c = compareTally;
  const rate = c.costMatch + c.costMismatch > 0 ? (100 * c.costMatch) / (c.costMatch + c.costMismatch) : 100;
  return `V-vs-H seen=${c.clustersSeen} bothNoArb=${c.bothNoArb} agreeArb=${c.agreeArb} ` +
    `profitDiff=${c.profitDiff} V_ONLY=${c.vOnly} H_ONLY=${c.hOnly} vDropped→Hsolved=${c.vDroppedHSolved} | ` +
    `costMatch=${rate.toFixed(3)}% (${c.costMatch}/${c.costMatch + c.costMismatch}) maxΔ=${c.maxAbsCostDelta.toFixed(5)}`;
}

function heartbeat(): void {
  const now = nowMs();
  const mins = ((now - stats.started) / 60000).toFixed(1);
  if (COMPARE) {
    const line = compareSummaryLine();
    log.info(`[hb ${mins}m] ${line}`);
    appendFileSync(LOG_TXT, `# [heartbeat ${new Date(now).toISOString()} +${mins}m] ${line}\n`);
    return;
  }
  const g = gradePartition();
  const bestCleanStr = Number.isFinite(g.bestCleanEdge)
    ? `bestEdge=$${fmt(g.bestCleanEdge)}@c${g.bestCleanCluster} `
    : `bestEdge=none `;
  log.info(
    `[hb ${mins}m] tracked=${trackedCount} updates=${stats.updates} solves=${stats.solves} ` +
      `qfSkip=${stats.qfSkipped} ` +
      `${config.solver.skipFilter ? `dualSkip=${stats.skipped} ` : ''}` +
      `ARBS=${stats.distinctArbs} distinct (${stats.arbs} fires, ${arbState.size} active: ` +
      `clean=${g.clean} caution=${g.caution} risky=${g.risky} blocked=${g.blocked}) ` +
      // blocked= is a snapshot; refused= is the cumulative fire counter.
      `refused=${stats.refused} tripwire=${stats.tripwire} magTripwire=${edgeMagnitudeTripwireCensus()} ` +
      `near=${stats.distinctNear} infeasible=${stats.infeasible} err=${stats.errors} ` +
      `${bestCleanStr}bestRaw=$${fmt(stats.bestEdge)}@c${stats.bestEdgeCluster} ` +
      `lastArb=${stats.lastArbAt ? Math.round((now - stats.lastArbAt) / 1000) + 's ago' : 'none'}`,
  );
  appendFileSync(
    LOG_TXT,
    `# [heartbeat ${new Date(now).toISOString()} +${mins}m] updates=${stats.updates} solves=${stats.solves} ` +
      `qfSkip=${stats.qfSkipped} ` +
      `ARBS=${stats.distinctArbs}distinct/${stats.arbs}fires/${arbState.size}active ` +
      `(clean=${g.clean} caution=${g.caution} risky=${g.risky} blocked=${g.blocked}) refused=${stats.refused} near=${stats.distinctNear} ` +
      `infeasible=${stats.infeasible} err=${stats.errors} ${bestCleanStr}bestRaw=$${fmt(stats.bestEdge)}@c${stats.bestEdgeCluster}\n`,
  );
  log.info(
    `[hb ${mins}m lat] bookParse ${latStr(lat.book)} | buildLP ${latStr(lat.build)} | ` +
      `solveLP ${latStr(lat.solve)} | batch ${latStr(lat.batch)} maxQ=${maxQueue}`,
  );
  appendFileSync(
    LOG_TXT,
    `# [heartbeat-lat +${mins}m] bookParse ${latStr(lat.book)} | buildLP ${latStr(lat.build)} | ` +
      `solveLP ${latStr(lat.solve)} | batch ${latStr(lat.batch)} maxQ=${maxQueue}\n`,
  );
  if (ioHost) {
    log.info(`[hb ${mins}m io-thread] occupancy ${ioHost.occupancyStr()}`);
    appendFileSync(LOG_TXT, `# [heartbeat-io-thread +${mins}m] occupancy ${ioHost.occupancyStr()}\n`);
  }
  if (config.solver.costSplit) {
    const cs = getSolveCostSplit(true);
    const mean = (p: { n: number; ms: number }): string =>
      p.n ? `${(p.ms / p.n).toFixed(3)}ms n=${p.n}` : 'n=0';
    log.info(
      `[hb ${mins}m cost-split] render ${mean(cs.render)} | wasm ${mean(cs.wasm)} | parse ${mean(cs.parse)}`,
    );
    appendFileSync(
      LOG_TXT,
      `# [heartbeat-cost-split +${mins}m] render ${mean(cs.render)} | wasm ${mean(cs.wasm)} | parse ${mean(cs.parse)}\n`,
    );
  }
  if (REST_CROSSCHECK_ON) {
    const t = restCrosscheckDebugTally(true);
    const keys = Object.keys(t);
    if (keys.length > 0) {
      const s = keys.sort().map((k) => `${k}=${t[k]}`).join(' ');
      log.info(`[hb ${mins}m rest-xcheck] ${s} inflight=${inFlightRestStamps.size}`);
      appendFileSync(LOG_TXT, `# [heartbeat-rest-xcheck +${mins}m] ${s} inflight=${inFlightRestStamps.size}\n`);
    }
  }
}

async function main(): Promise<void> {
  stats.started = nowMs();
  appendFileSync(
    LOG_TXT,
    `\n#### RUN START ${new Date(stats.started).toISOString()}  duration=${(RUN_MS / 3600000).toFixed(1)}h  ` +
      // twoSided must always log true; false here means a bug in the manager.
      `twoSided=true  nearMissMax=${NEARMISS_MAX}  ` +
      `fees=${config.execution.enforceFees} depthCap=${config.execution.enforceDepthCap}\n`,
  );
  log.info(`Detail log → ${LOG_TXT} + ${LOG_JSONL}`);

  priceCache.setTtl(config.execution.quoteTtlMs);
  priceCache.setTobTtl(config.execution.tobTtlMs);
  await loadGraph();

  const markets = await getMarketsToTrack();
  for (const m of markets) priceCache.track(m.marketId);
  trackedCount = markets.length;

  // Must be ready before the first price tick marks a cluster dirty.
  if (solverPool) {
    log.info(`Solver worker pool: ${config.solver.workerCount} workers — initializing…`);
    await solverPool.ready();
    log.info('Solver worker pool ready.');
  }

  log.info(`Tracking ${markets.length} markets — connecting CLOB feeds…`);
  await clobManager.startTracking(markets);

  clobManager.onPriceUpdate((update) => {
    stats.updates++;
    // Prefer sub-ms monotonic emitHr−wireHr; fall back to whole-ms wireTs→timestamp.
    if (update.emitHr != null && update.wireHr != null) sampleLat(lat.book, update.emitHr - update.wireHr);
    else if (update.wireTs != null) sampleLat(lat.book, update.timestamp - update.wireTs);
    if (update.outcome !== 'no') {}
    const changed = priceCache.update(update);
    if (!changed) return;
    const cluster = marketClusterIndex.get(update.marketId);
    if (cluster) {
      dirtySet.add(cluster.id);
    }
  });

  if (config.execution.staleOnDisconnect) {
    clobManager.onConnectionStale((marketIds) => {
      priceCache.markStaleByIds(marketIds);
      for (const mid of marketIds) {
        const cluster = marketClusterIndex.get(mid);
        if (cluster) dirtySet.add(cluster.id);
      }
    });
  }

  // `solving` prevents overlapping passes; a batch that exceeds the interval just runs back-to-back.
  const solveInterval = setInterval(() => {
    if (solving || dirtySet.size === 0) return;
    solving = true;
    solveDirty()
      .catch((err) => { stats.errors++; log.error('solve error', err); })
      .finally(() => { solving = false; });
  }, Math.max(50, config.solver.debounceMs));

  // Hardcoded interval — soundness plumbing, not tunable.
  const beltRefreshTimer = setInterval(() => {
    // Also gate on reloadInFlight: an incremental reload's swap mutates the same graph refs.
    if (solving || reloadInFlight || !loadedGraph) return;
    solving = true;
    try {
      const rebuilt = refreshPriceBelt(loadedGraph, config, { yesBidOf, latch: containmentLatch });
      if (rebuilt) {
        clusters = rebuilt.clusters;
        marketClusterIndex = rebuilt.marketClusterIndex;
        clusterById = rebuilt.clusterById;
        lastSolveFingerprint.clear();
        dualCerts.clear();
        livenessMasks.clear();
        for (const c of clusters) dirtySet.add(c.id);
      }
    } catch (err) {
      stats.errors++;
      log.error('price-belt refresh error', err);
    } finally {
      solving = false;
    }
  }, 120_000);

  const hb = setInterval(heartbeat, HEARTBEAT_MS);
  const restDiagTimer = REST_CROSSCHECK_ON ? setInterval(() => void restDiag(false), REST_DIAG_INTERVAL_MS) : null;

  const reloadTimer: NodeJS.Timeout | null =
    RELOAD_MS > 0 ? setInterval(() => void reloadGraphIncremental(), RELOAD_MS) : null;

  const shutdown = async (reason: string) => {
    clearInterval(hb);
    clearInterval(solveInterval);
    clearInterval(beltRefreshTimer);
    if (reloadTimer) clearInterval(reloadTimer);
    if (restDiagTimer) clearInterval(restDiagTimer);
    heartbeat();
    await restDiag(true);
    const endTs = nowMs();
    for (const [cid, s] of arbState) {
      appendFileSync(
        LOG_TXT,
        `# ARB STILL-OPEN cluster=${cid} | open ${fmt((endTs - s.firstTs) / 1000, 1)}s | fires=${s.fires} | ` +
          `ROI min=${fmt(s.minRoi, 2)}% max=${fmt(s.maxRoi, 2)}% first=${fmt(s.firstRoi, 2)}%\n`,
      );
      writeEpisode(cid, s, endTs, 'still-open');
    }
    if (COMPARE) {
      const summary = { generatedAt: new Date(nowMs()).toISOString(), runMinutes: Number(((nowMs() - stats.started) / 60000).toFixed(1)), ...compareTally };
      writeFileSync(`${BASE}.compare.summary.json`, JSON.stringify(summary, null, 2));
      appendFileSync(LOG_TXT, `#### COMPARE SUMMARY ${compareSummaryLine()}\n`);
      log.info(`COMPARE SUMMARY → ${compareSummaryLine()}`);
    }
    appendFileSync(LOG_TXT, `#### RUN END ${new Date(nowMs()).toISOString()} (${reason})\n`);
    log.info(`Shutting down (${reason}). Totals: solves=${stats.solves} ARBS=${stats.arbs} near=${stats.nearMisses}`);
    if (inFlightRestStamps.size > 0) {
      const pending = inFlightRestStamps.size;
      log.info(`Draining ${pending} in-flight REST cross-check stamp(s)…`);
      const grace = new Promise<void>((r) => setTimeout(r, REST_CROSSCHECK_BUDGET_MS + 1000));
      try { await Promise.race([Promise.allSettled([...inFlightRestStamps]), grace]); } catch {}
    }
    try { await clobManager.stopAll(); } catch {}
    try { await solverPool?.terminate(); } catch {}
    process.exit(0);
  };

  // 0 means run forever — no auto-exit timer (SIGINT/SIGTERM still shut down cleanly).
  if (RUN_MS > 0) setTimeout(() => shutdown('duration elapsed'), RUN_MS);
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const runForStr = RUN_MS > 0 ? `${(RUN_MS / 3600000).toFixed(1)}h` : 'forever (until signal)';
  const reloadStr = RELOAD_MS > 0 ? `, incremental reload every ${(RELOAD_MS / 1000).toFixed(0)}s` : '';
  log.info(`Running for ${runForStr}${reloadStr}. Heartbeat every ${HEARTBEAT_MS / 1000}s.`);
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
