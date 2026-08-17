import 'dotenv/config';
import os from 'node:os';
import { readEnv, readBoolEnv } from '@arb/types';
import { DEFAULT_GRADE_THRESHOLDS, resolveQuotedFractionSolveFloor } from './solver/execution-grade.js';
import type { AswPreset, AswShape } from './solver/settlement-economics.js';

const envFlag = (name: string, dflt: boolean): boolean => {
  const v = process.env[name];
  if (v === undefined) return dflt;
  return v !== 'false' && v !== '0';
};

const envEnum = <T extends string>(name: string, allowed: readonly T[], dflt: T): T => {
  const v = process.env[name];
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
};

// returnDuals below implies itself from this.
const SKIP_FILTER = envFlag('SOLVE_SKIP_FILTER', false);

export const config = {
  pg: {
    host: process.env.PG_HOST ?? 'localhost',
    port: parseInt(process.env.PG_PORT ?? '5432'),
    database: process.env.PG_DATABASE ?? 'prediction_arb',
    user: process.env.PG_USER ?? 'arb',
    password: process.env.PG_PASSWORD ?? 'arb_local_dev',
  },

  solver: {
    // 'vrep': enumerate states. 'facet': O(n) dual-row LP, default. 'hybrid': enumerate, facet-rescue drops.
    engine: (process.env.SOLVE_ENGINE ?? 'facet') as 'vrep' | 'facet' | 'hybrid',
    debounceMs: parseInt(process.env.SOLVE_DEBOUNCE_MS ?? '10'),
    minProfit: parseFloat(process.env.ARB_MIN_PROFIT ?? '0.01'),
    minEdgeConfidence: parseFloat(
      readEnv('SOLVE_MIN_EDGE_CONFIDENCE', { alias: 'MIN_EDGE_CONFIDENCE' }) ?? '0.70',
    ),
    maxStates: parseInt(readEnv('SOLVE_MAX_VALID_STATES', { alias: 'MAX_VALID_STATES' }) ?? '10000'),
    facetClusterQuestionCap: parseInt(
      readEnv('SOLVE_FACET_CLUSTER_QUESTION_CAP', { alias: 'FACET_CLUSTER_QUESTION_CAP' }) ?? '2000',
    ),
    // SOLVE_RELAXED_ROUTE=0 restores drop-dead-on-overcap instead of a facet-only rescue.
    relaxedRoute: process.env.SOLVE_RELAXED_ROUTE !== '0',
    clusterSizeCap: parseInt(readEnv('SOLVE_CLUSTER_SIZE_CAP', { alias: 'CLUSTER_SIZE_CAP' }) ?? '200'),
    pricePersistIntervalMs: parseInt(
      readEnv('SOLVE_PRICE_PERSIST_INTERVAL_MS', { alias: 'PRICE_PERSIST_INTERVAL_MS' }) ?? '30000',
    ),
    workerPool: readBoolEnv('SOLVE_WORKER_POOL', false, { alias: 'SOLVER_WORKER_POOL' }),
    // Default reserves 2 cores for the main event loop (WS reader + keepalive).
    workerCount: parseInt(
      readEnv('SOLVE_WORKER_COUNT', { alias: 'SOLVER_WORKER_COUNT' }) ??
        String(Math.max(1, Math.min(os.cpus().length - 2, 6))),
    ),
    serialDedup: envFlag('SOLVE_SERIAL_DEDUP', true),
    yieldEvery: parseInt(process.env.SOLVE_YIELD_EVERY ?? '50'),
    costSplit: envFlag('SOLVE_COST_SPLIT', false),
    // Weak-duality skip: proves profit < minProfit from the last solve's duals without re-solving. See solver/skip-filter.ts.
    skipFilter: SKIP_FILTER,
    returnDuals: SKIP_FILTER,
  },

  // Execution gate knobs only ever shrink/reject a basket, never enlarge it.
  execution: {
    enforceFees: true,
    enforceDepthCap: true,
    // 0/absent = no TTL.
    quoteTtlMs: parseInt(process.env.ARB_QUOTE_TTL_MS ?? '120000'),
    // Ages on TOB movement, not lastUpdate (some feeds re-push an unchanged TOB). 0/absent disables.
    tobTtlMs: parseInt(process.env.ARB_TOB_TTL_MS ?? '300000'),
    staleOnDisconnect: true,
    // Clamped to 0.25 so it can never collide with the 0.5 risky-demotion threshold.
    quotedFractionSolveFloor: resolveQuotedFractionSolveFloor(),
    // Fails open: a DB error at subscribe time subscribes all candidates. CLOB_LIVE_SUBSCRIBE_GATE=0 disables.
    liveSubscribeGate: envFlag('CLOB_LIVE_SUBSCRIBE_GATE', true),
    gradeThresholds: {
      ...DEFAULT_GRADE_THRESHOLDS,
      settlement: {
        enabled: envFlag('ARB_SETTLEMENT_FRONTIER', true),
        curve: {
          preset: envEnum<AswPreset>('ARB_ASW_PRESET', ['min', 'p01', 'conservative'], 'min'),
          shape: envEnum<AswShape>('ARB_ASW_SHAPE', ['flat', 'hump'], 'flat'),
        },
        disputedLag: envFlag('ARB_SETTLEMENT_DISPUTED_LAG', false),
      },
      venueRounding: { enabled: envFlag('ARB_VENUE_ROUNDING', true) },
    },
    gradedResidualChannel: envFlag('ARB_GRADED_RESIDUAL', false),
  },

  // Per-platform connection/sharding/integrity knobs live in token-map.ts + the adapters, not here.
  clob: {
    ioThread: envFlag('CLOB_IO_THREAD', false),
  },

  eventBus: {
    url: process.env.EVENT_BUS_URL ?? 'http://localhost:3100',
  },
} as const;
