/**
 * Daemon mode — continuous incremental pipeline. Three parallel loops run
 * forever: Stage 1 workers drain stage1_queue; sync pulls new markets; a
 * Stage 2+3 trigger loop drains stage23_queue once queued/idle and runs the event graph.
 */
import 'dotenv/config';
import { createLogger } from '@arb/logger';
import { runStage1Workers } from './stage1-normalize/worker.js';
import { runEventGraph } from './run-event-graph.js';
import { runSync } from './db/sync.js';
import { runIngestBackfills } from './run-ingest-backfills.js';
import { seedEntityKB } from './db/seed-entity-kb.js';
import { backfillStage1Queue } from './db/queries/stage1-queue.js';
import { runHealthChecks } from './db/health-checks.js';
import { ensurePipelineHeartbeats, startHeartbeat } from './db/heartbeat.js';
import { flushBeltCensus, resetBeltCensus } from './discriminators/telemetry.js';
import {
  shouldTriggerStage23,
  drainStage23Queue,
  enqueueStage23,
} from './db/queries/stage23-queue.js';
import { publish, subscribe } from '@arb/event-bus';

const log = createLogger('daemon');

const SYNC_INTERVAL_MS  = parseInt(process.env.DAEMON_SYNC_INTERVAL_MS  ?? String(5 * 60_000));
const STAGE23_POLL_MS   = parseInt(process.env.DAEMON_STAGE23_POLL_MS   ?? '5000');
const STAGE1_WORKERS    = parseInt(process.env.STAGE1_WORKERS           ?? '4');
const STAGE1_BATCH_SIZE = parseInt(process.env.STAGE1_BATCH_SIZE        ?? '5');

function tryPublish(data: { channel: 'pipeline'; type: string; data: unknown }): void {
  publish(data).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Heartbeat runs on a dedicated timer, so a wedged loop still beats healthy; each loop stamps its last tick here.
const loopProgress: Record<'sync' | 'stage23_poll', { last_tick_at: string; ticks: number }> = {
  sync: { last_tick_at: new Date().toISOString(), ticks: 0 },
  stage23_poll: { last_tick_at: new Date().toISOString(), ticks: 0 },
};

function markLoopTick(loop: keyof typeof loopProgress): void {
  loopProgress[loop].last_tick_at = new Date().toISOString();
  loopProgress[loop].ticks++;
}

// Loop 1: `drainAndExit: false` keeps workers alive forever; worker.ts calls enqueueStage23 per completed batch.
function stage1WorkerLoop(): Promise<Stage1WorkerResult> {
  return runStage1Workers({
    workers: STAGE1_WORKERS,
    batchSize: STAGE1_BATCH_SIZE,
    drainAndExit: false,
  });
}

// Loop 2: upserts scraped markets, then runs the same shared ingest-backfill ladder as run.ts.
let resolveSyncSleep: (() => void) | null = null;

function triggerSyncNow(): void {
  resolveSyncSleep?.();
}

async function syncLoop(): Promise<never> {
  while (true) {
    // Wait for the periodic interval OR an early wake from triggerSyncNow().
    await new Promise<void>((resolve) => {
      resolveSyncSleep = resolve;
      setTimeout(resolve, SYNC_INTERVAL_MS);
    });
    resolveSyncSleep = null;

    try {
      const synced = await runSync();
      // Full-scan mode: this loop has no Stage-1 delta in hand.
      const backfills = await runIngestBackfills({
        upstreamMarketsChanged: synced > 0,
        enqueueUpdatedMarketIds: true,
      });
      log.info(
        `sync: ${synced} markets upserted, ` +
        `${backfills.kbMeta.entitiesUpdated} entities enriched ` +
        `(1d/1f gate: ${backfills.kbGate.reason}; ` +
        `1f: ${backfills.backfillResult.updated} markets + ${backfills.backfillResult.eventsUpdated} events corrected)`
      );
      tryPublish({
        channel: 'pipeline', type: 'sync',
        data: {
          synced,
          entitiesUpdated: backfills.kbMeta.entitiesUpdated,
          kbGateReason: backfills.kbGate.reason,
          subjectsBackfilled: backfills.backfillResult.updated,
        },
      });
    } catch (err) {
      log.error('sync error:', err);
    }
    markLoopTick('sync');
  }
}

// Loop 3: serialised by `inFlight`; on failure the drained IDs are re-enqueued for retry.
async function stage23Loop(): Promise<never> {
  let inFlight = false;
  while (true) {
    await sleep(STAGE23_POLL_MS);
    // Stamped at iteration top: the idle-path `continue`s below would otherwise skip it.
    markLoopTick('stage23_poll');
    if (inFlight) continue;

    try {
      if (!(await shouldTriggerStage23())) continue;

      inFlight = true;
      let ids: number[] = [];
      try {
        ids = await drainStage23Queue();
        if (ids.length === 0) continue;

        log.info(`Event graph triggered: ${ids.length} new markets`);
        tryPublish({
          channel: 'pipeline', type: 'stage23_start',
          data: { count: ids.length },
        });

        const eg = await runEventGraph({ skipLlm: process.env.STAGE3_SKIP_LLM === '1' });

        log.info(
          `Event graph done: ` +
          `${eg.stage4.outcomeNodes} outcome-nodes, ${eg.stage4.outcomeSets} sets, ` +
          `${eg.match.matched + eg.match.expanded} matched events, ` +
          `${eg.stage4.thresholdEdges} threshold edges`
        );
        tryPublish({
          channel: 'pipeline', type: 'stage23_done',
          data: {
            outcomeNodes: eg.stage4.outcomeNodes,
            outcomeSets: eg.stage4.outcomeSets,
            matchedEvents: eg.match.matched + eg.match.expanded,
            thresholdEdges: eg.stage4.thresholdEdges,
          },
        });
      } catch (err) {
        log.error('Stage 2+3 error:', err);
        if (ids.length > 0) {
          await enqueueStage23(ids).catch(() => {});
          log.info(`Re-enqueued ${ids.length} market IDs for retry`);
        }
      } finally {
        // Belt/disc/rollup counters from loops 1+2 ride out on this line too.
        flushBeltCensus((m) => log.info(m));
        resetBeltCensus();
        inFlight = false;
      }
    } catch (err) {
      log.error('Stage 2+3 poll error:', err);
    }
    markLoopTick('stage23_poll');
  }
}

export interface Stage1WorkerResult {
  marketsProcessed: number;
  marketsFailed: number;
  durationMs: number;
}

export async function runDaemon(): Promise<never> {
  log.info('Starting...');

  // Must start before the one-time startup steps below or every cold-boot reads as dead.
  await ensurePipelineHeartbeats();
  startHeartbeat(
    'daemon',
    parseInt(process.env.DAEMON_HEARTBEAT_INTERVAL_MS ?? '30000'),
    () => ({ loops: loopProgress }),
  );

  const kbSeed = await seedEntityKB();
  if (kbSeed.seeded) {
    log.info(
      `Entity KB seeded: ` +
      `${kbSeed.structural.entitiesUpserted} entities, ` +
      `${kbSeed.teams.resolved} team→league links`
    );
  }

  const synced = await runSync();
  log.info(`Initial sync: ${synced} markets`);

  try {
    await runHealthChecks();
  } catch (err) {
    log.error('Health checks failed (continuing):', err);
  }

  const backfilled = await backfillStage1Queue();
  if (backfilled > 0) {
    log.info(`Backfilled ${backfilled} markets into stage1_queue`);
  }

  log.info(
    `Loops starting — ` +
    `stage1_workers=${STAGE1_WORKERS} batch=${STAGE1_BATCH_SIZE}, ` +
    `sync_interval=${SYNC_INTERVAL_MS}ms, ` +
    `stage23_poll=${STAGE23_POLL_MS}ms`
  );

  subscribe('markets', (event) => {
    if (event.type === 'synced') {
      log.info('markets/synced received — waking sync loop early');
      triggerSyncNow();
    }
  });

  await Promise.all([
    stage1WorkerLoop(),
    syncLoop(),
    stage23Loop(),
  ]);

  throw new Error('[daemon] Unexpected exit from all loops');
}

if (process.argv[1]?.includes('daemon')) {
  runDaemon().catch((err) => {
    log.error('Fatal error:', err);
    process.exit(1);
  });
}
