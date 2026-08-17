/**
 * Stage 1 work queue. Each row is a single market that needs full Stage 1
 * processing (featurize → LLM normalize → embed). Workers claim rows with
 * `FOR UPDATE SKIP LOCKED` so multiple in-process workers can run in
 * parallel without contention.
 *
 * The queue is populated from `db/sync.ts` whenever a market is upserted.
 * It is drained by the worker pool defined in
 * `services/pipeline/src/stage1-normalize/worker.ts`.
 */
import { query, withTx } from '@arb/db';

type Stage1QueueStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface Stage1QueueClaim {
  id: number;
  market_id: number;
  attempts: number;
}

/** Enqueue a list of market IDs for Stage 1 processing. Idempotent — markets
 *  already in the queue are reset to `pending` so a re-sync doesn't lose
 *  work. */
export async function enqueueStage1(marketIds: readonly number[]): Promise<number> {
  if (marketIds.length === 0) return 0;
  // Use unnest for bulk insert; ON CONFLICT (market_id) DO UPDATE so we
  // re-arm any existing rows that had been marked done/failed (a fresh
  // sync may have changed the underlying market metadata).
  const rows = await query<{ id: number }>(
    `INSERT INTO stage1_queue (market_id, status, attempts, error, claimed_by, claimed_at, updated_at)
     SELECT mid, 'pending', 0, NULL, NULL, NULL, NOW()
     FROM unnest($1::int[]) AS t(mid)
     ON CONFLICT (market_id) DO UPDATE SET
        status     = CASE
                       WHEN stage1_queue.status IN ('done','failed') THEN 'pending'
                       ELSE stage1_queue.status
                     END,
        error      = NULL,
        updated_at = NOW()
     RETURNING id`,
    [marketIds as number[]]
  );
  return rows.length;
}

/** Atomically claim up to `n` pending rows for `workerId`. Uses
 *  `SKIP LOCKED` so concurrent workers never contend for the same row. */
export async function claimStage1Batch(workerId: string, n: number): Promise<Stage1QueueClaim[]> {
  return withTx(async (client) => {
    const { rows } = await client.query<Stage1QueueClaim>(
      `WITH claimed AS (
         SELECT id
         FROM stage1_queue
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE stage1_queue q
       SET status     = 'processing',
           claimed_by = $2,
           claimed_at = NOW(),
           attempts   = q.attempts + 1,
           updated_at = NOW()
       FROM claimed
       WHERE q.id = claimed.id
       RETURNING q.id, q.market_id, q.attempts`,
      [n, workerId]
    );
    return rows;
  });
}

export async function markStage1Done(rowId: number): Promise<void> {
  await query(
    `UPDATE stage1_queue
     SET status = 'done',
         error = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [rowId]
  );
}

export async function markStage1Failed(rowId: number, errorMsg: string, maxAttempts = 3): Promise<void> {
  await query(
    `UPDATE stage1_queue
     SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
         error  = $2,
         claimed_by = NULL,
         claimed_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [rowId, errorMsg.slice(0, 4000), maxAttempts]
  );
}

/** Reclaim rows whose worker died (claimed_at older than threshold). */
export async function recoverStuckStage1(thresholdMs = 5 * 60_000): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE stage1_queue
     SET status     = 'pending',
         claimed_by = NULL,
         claimed_at = NULL,
         updated_at = NOW()
     WHERE status = 'processing'
       AND claimed_at < NOW() - ($1 || ' milliseconds')::INTERVAL
     RETURNING id`,
    [String(thresholdMs)]
  );
  return rows.length;
}

/** Add the entire backfill set: every market that has no Stage 1 output yet.
 *
 *  For markets that already have a queue row in `done` or `failed` status but
 *  are still missing output (e.g. embedding failed non-fatally in the worker
 *  and was not re-attempted), re-arms those rows back to `pending` so the
 *  next worker pass can complete them. Markets in `pending` or `processing`
 *  status are left untouched.
 *
 *  "Complete" output is features + embedding only. An
 *  `llm_market_normalizations` row is optional — template-miss markets are
 *  deferred to the event layer and legitimately carry none. This predicate
 *  must mirror `markCompletedQueueRows`: adding `NOT EXISTS
 *  llm_market_normalizations` here would re-arm every template-miss market to
 *  `pending` on every run, and `markCompletedQueueRows` would then re-close
 *  them to `done` with zero work and return their IDs into `enqueueStage23`,
 *  forcing a full Stage 2+3 incremental pass on every no-op tick.
 */
export async function backfillStage1Queue(): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO stage1_queue (market_id, status)
     SELECT m.id, 'pending'
     FROM markets m
     WHERE m.resolved_at IS NULL
       AND (
         NOT EXISTS (SELECT 1 FROM market_features mf WHERE mf.market_id = m.id)
         OR m.embedding IS NULL
       )
     ON CONFLICT (market_id) DO UPDATE SET
       status     = 'pending',
       error      = NULL,
       claimed_by = NULL,
       claimed_at = NULL,
       updated_at = NOW()
     WHERE stage1_queue.status IN ('done', 'failed')
     RETURNING id`
  );
  return rows.length;
}

interface Stage1QueueStats {
  pending: number;
  processing: number;
  done: number;
  failed: number;
}

export async function getStage1QueueStats(): Promise<Stage1QueueStats> {
  const rows = await query<{ status: Stage1QueueStatus; n: string }>(
    `SELECT status, COUNT(*)::text AS n FROM stage1_queue GROUP BY status`
  );
  const out: Stage1QueueStats = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const r of rows) out[r.status] = parseInt(r.n, 10);
  return out;
}

export async function getPendingCount(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM stage1_queue WHERE status = 'pending'`
  );
  return parseInt(rows[0]?.n ?? '0', 10);
}
