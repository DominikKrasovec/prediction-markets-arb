/**
 * Stage 1 worker pool — drains `stage1_queue` and processes a batch
 * end-to-end (1a featurize → 1b deterministic normalize → 1c embed).
 *
 * This is the "streaming" path used by the daemon. The batched path lives in
 * [services/pipeline/src/stage1-normalize/index.ts](services/pipeline/src/stage1-normalize/index.ts)
 * (`runStage1`); both are deterministic-only (event-centric rewire — no LLM
 * normalization in Stage 1). Template-miss markets carry no normalization row
 * and are deferred to the event layer (Stage 3b leg mapping), not the LLM.
 *
 * The worker pool is opt-in via `runStage1Workers(...)` and is used by the
 * daemon-mode entry point and by tests that want incremental processing.
 *
 * Each worker:
 *   1. Claims up to `batchSize` queue rows via `FOR UPDATE SKIP LOCKED`.
 *   2. Loads the corresponding market rows.
 *   3. Featurises any markets without features.
 *   4. Deterministic normalize (templates + KB) for the batch.
 *   5. Embeds any markets without an embedding.
 *   6. Marks the queue rows done (features + embedding; a normalization row is
 *      optional — template-misses are expected). Failures bump the attempt
 *      counter and release the row so another worker can retry.
 *
 * The pool exits when the queue is empty AND no worker is currently
 * processing — same drain semantics as the legacy loop.
 */
import { query } from '@arb/db';
import { config } from '../config.js';
import {
  claimStage1Batch,
  markStage1Done,
  markStage1Failed,
  recoverStuckStage1,
  getPendingCount,
} from '../db/queries/stage1-queue.js';
import type { Stage1QueueClaim } from '../db/queries/stage1-queue.js';
import { enqueueStage23 } from '../db/queries/stage23-queue.js';
import { insertMarketFeatures } from '../db/queries/features.js';
import { selectMarketsNeedingEmbedding } from '../db/queries/markets.js';
import { extractPlatformGroups } from './platform-groups.js';
import { embedMarkets, isEmbeddingDone } from './embedder.js';
import { featurizeMarket } from './index.js';
import { normalizeTextDeterministicBatch } from './text-deterministic.js';
import { warmKBCache, loadStructuralSignalsIndex } from '../db/entity-registry.js';
import type { SyncedMarket, MarketFeatures } from '@arb/types';
import { createLogger } from '@arb/logger';

const DEFAULT_WORKERS = parseInt(process.env.STAGE1_WORKERS ?? '4');
const DEFAULT_BATCH_SIZE = parseInt(process.env.STAGE1_BATCH_SIZE ?? '5');
const IDLE_BACKOFF_MS = parseInt(process.env.STAGE1_IDLE_BACKOFF_MS ?? '500');

const log = createLogger('stage1-workers');

interface Stage1WorkerOptions {
  workers?: number;
  batchSize?: number;
  /** When true, exit when the queue is empty. When false, block forever
   *  waiting for new work — used in daemon mode. */
  drainAndExit?: boolean;
}

export interface Stage1WorkerResult {
  marketsProcessed: number;
  marketsFailed: number;
  durationMs: number;
}

/** Public entry point — spin up N workers and drain the queue. */
export async function runStage1Workers(opts: Stage1WorkerOptions = {}): Promise<Stage1WorkerResult> {
  const workers = opts.workers ?? DEFAULT_WORKERS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const drainAndExit = opts.drainAndExit ?? true;
  const start = Date.now();

  const reclaimed = await recoverStuckStage1();
  if (reclaimed > 0) {
    log.info(`Reclaimed ${reclaimed} stuck rows`);
  }

  const initialPending = await getPendingCount();
  log.info(
    `Starting ${workers} workers ` +
    `(batch=${batchSize}, pending=${initialPending}, drainAndExit=${drainAndExit})`
  );

  // Event-centric: Stage 1 is deterministic (no LLM). The templates resolve
  // entities via the KB and infer sport/league scope from structural signals,
  // so warm both once before the workers start (mirrors runStage1's pre-loop).
  await warmKBCache();
  await loadStructuralSignalsIndex();

  // Bulk fetch platform-group hints once at start — workers reuse this map.
  // Daemon-mode callers can refresh by restarting the pool.
  const groupRows = await extractPlatformGroups();
  const groupMap = new Map(groupRows.map((g) => [g.market_id, g]));

  let processed = 0;
  let failed = 0;
  let activeWorkers = 0;

  const workerLoop = async (workerId: string): Promise<void> => {
    while (true) {
      const claims = await claimStage1Batch(workerId, batchSize);
      if (claims.length === 0) {
        if (drainAndExit) {
          // Only exit if no other worker is mid-flight (they might enqueue
          // dependent work — though in our model they don't, this is a
          // defensive guard).
          if (activeWorkers === 0) return;
          await sleep(IDLE_BACKOFF_MS);
          continue;
        }
        await sleep(IDLE_BACKOFF_MS);
        continue;
      }

      activeWorkers++;
      try {
        const { ok, errored } = await processClaims(claims, groupMap);
        processed += ok;
        failed += errored;
      } finally {
        activeWorkers--;
      }
    }
  };

  const promises = Array.from({ length: workers }, (_, i) => workerLoop(`w${i}`));
  await Promise.all(promises);

  const durationMs = Date.now() - start;
  log.info(
    `Drain complete: processed=${processed}, failed=${failed}, ` +
    `${durationMs}ms`
  );
  return { marketsProcessed: processed, marketsFailed: failed, durationMs };
}

async function processClaims(
  claims: Stage1QueueClaim[],
  groupMap: Map<number, { platform_group_id: string | null; platform_cross_ref: string | null }>,
): Promise<{ ok: number; errored: number }> {
  const ids = claims.map((c) => c.market_id);
  let markets: SyncedMarket[];
  try {
    markets = await fetchMarketsByIds(ids);
  } catch (err) {
    for (const c of claims) await markStage1Failed(c.id, `fetch: ${String(err)}`);
    return { ok: 0, errored: claims.length };
  }

  // Resolved markets that snuck into the queue before resolution detection
  // arrived: drop them silently (mark done, don't reprocess).
  const dropped = claims.filter(
    (c) => !markets.some((m) => m.id === c.market_id),
  );
  for (const c of dropped) await markStage1Done(c.id);

  if (markets.length === 0) return { ok: dropped.length, errored: 0 };

  let ok = 0;
  let errored = 0;

  // 1a — featurize anything without features yet.
  try {
    await ensureFeatures(markets, groupMap);
  } catch (err) {
    for (const c of claims) await markStage1Failed(c.id, `featurize: ${String(err)}`);
    return { ok: dropped.length, errored: claims.length };
  }

  // 1b — deterministic normalise (templates + KB). No LLM (event-centric).
  // Template-miss markets produce no row and are deferred to the event layer —
  // expected, not a failure (see the done criterion below).
  try {
    await normalizeTextDeterministicBatch(markets.map((m) => m.id));
  } catch (err) {
    for (const c of claims) await markStage1Failed(c.id, `normalize: ${String(err)}`);
    return { ok: dropped.length, errored: claims.length };
  }

  // 1c — embed any markets that don't have an embedding yet.  Routed through
  // `selectMarketsNeedingEmbedding` + `embedMarkets` so the worker shares
  // the batch path's filter logic and bulk-write behaviour.
  try {
    const targets = await selectMarketsNeedingEmbedding({
      skipParlays: config.embedding.skipParlayMarkets,
      marketIds: markets.map((m) => m.id),
    });
    await embedMarkets(targets);
  } catch (err) {
    // Embedding failures are not fatal — embedding is used by Stage 2 ANN
    // search but the rest of the pipeline still works without it.
    log.warn(`embed failed: ${String(err)}`);
  }

  // Mark queue rows done. Criterion mirrors batch-mode `markCompletedQueueRows`:
  // features (ensured in 1a) + embedding. A normalization row is NOT required —
  // template-miss markets are deferred to the event layer and legitimately carry
  // none, so requiring one would strand them in the queue forever.
  const doneMarketIds: number[] = [];
  for (const c of claims) {
    if (dropped.includes(c)) continue;
    // If embedding failed non-fatally above, keep the row in the queue so the
    // next worker claim retries the (cheap) embed step.
    const hasEmbed = await isEmbeddingDone(c.market_id);
    if (!hasEmbed) {
      await markStage1Failed(c.id, 'embedding missing');
      errored++;
      continue;
    }
    await markStage1Done(c.id);
    doneMarketIds.push(c.market_id);
    ok++;
  }

  // Populate stage23_queue so the daemon's Stage 2+3 trigger loop can pick
  // these markets up for incremental processing. Idempotent — safe to call
  // even in batch-mode runs (enqueueStage23 is ON CONFLICT DO NOTHING).
  if (doneMarketIds.length > 0) {
    await enqueueStage23(doneMarketIds).catch((err) => {
      log.warn(`stage23 enqueue failed: ${err}`);
    });
  }

  return { ok: ok + dropped.length, errored };
}

async function fetchMarketsByIds(ids: number[]): Promise<SyncedMarket[]> {
  if (ids.length === 0) return [];
  // Slim projection: featurize / LLM normalize / embed only read these fields.
  // Avoid `SELECT *`, which would also ship the per-row `embedding` pgvector
  // for no reason (see MARKETS_SLIM_COLUMNS in db/queries/markets.ts).
  return query<SyncedMarket>(
    `SELECT id, platform, platform_id, title, description,
            end_date, grouping_type, category_unified
       FROM markets
      WHERE id = ANY($1::int[])
        AND resolved_at IS NULL
      ORDER BY id`,
    [ids],
  );
}

async function ensureFeatures(
  markets: SyncedMarket[],
  groupMap: Map<number, { platform_group_id: string | null; platform_cross_ref: string | null }>,
): Promise<void> {
  const ids = markets.map((m) => m.id);
  const existing = await query<{ market_id: number }>(
    `SELECT market_id FROM market_features WHERE market_id = ANY($1::int[])`,
    [ids]
  );
  const have = new Set(existing.map((r) => r.market_id));
  const need = markets.filter((m) => !have.has(m.id));
  if (need.length === 0) return;
  const features: MarketFeatures[] = need.map((m) => featurizeMarket(m, groupMap.get(m.id)));
  for (const f of features) await insertMarketFeatures(f);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
