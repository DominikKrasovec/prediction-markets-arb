/**
 * Stage 2/3 trigger queue.
 *
 * Markets are inserted here by Stage 1 when fully processed (featurized +
 * LLM-normalized + embedded). The pipeline consumer drains this queue when
 * either the count reaches STAGE23_THRESHOLD (1 000 markets) or Stage 1
 * finishes, then runs Stage 2+3 with only the new market IDs so that ANN
 * searches are incremental — new × all_active instead of all × all.
 *
 * Daemon mode: poll `shouldTriggerStage23()` after each Stage 1 batch and
 * call `drainStage23Queue()` + `runStage2(newIds)` + `runStage3(pairs)`.
 */
import { query, withTx } from '@arb/db';

/** Trigger Stage 2+3 when this many new markets are queued. */
export const STAGE23_THRESHOLD = 1_000;

/**
 * Enqueue market IDs for Stage 2+3 processing. Idempotent — markets already
 * in the queue are silently skipped (ON CONFLICT DO NOTHING).
 */
export async function enqueueStage23(marketIds: readonly number[]): Promise<number> {
  if (marketIds.length === 0) return 0;
  const rows = await query<{ id: number }>(
    `INSERT INTO stage23_queue (market_id)
     SELECT mid FROM unnest($1::int[]) AS t(mid)
     ON CONFLICT (market_id) DO NOTHING
     RETURNING id`,
    [marketIds as number[]]
  );
  return rows.length;
}

/** Count of markets currently waiting for Stage 2+3 processing. */
async function getStage23QueueCount(): Promise<number> {
  const rows = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM stage23_queue`);
  return parseInt(rows[0]?.n ?? '0', 10);
}

/**
 * Atomically claim all pending market IDs and clear the queue in one
 * transaction. Returns the market IDs that were claimed. Call `runStage2`
 * and `runStage3` with these IDs for incremental processing.
 */
export async function drainStage23Queue(): Promise<number[]> {
  return withTx(async (client) => {
    const { rows } = await client.query<{ market_id: number }>(
      `DELETE FROM stage23_queue RETURNING market_id`
    );
    return rows.map((r) => r.market_id);
  });
}

/**
 * Returns true when Stage 1 has nothing left to process (no pending or
 * processing rows). Use this to decide whether to trigger Stage 2+3 even
 * if the queue hasn't yet reached STAGE23_THRESHOLD.
 */
async function isStage1Idle(): Promise<boolean> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM stage1_queue
      WHERE status IN ('pending','processing')`
  );
  return parseInt(rows[0]?.n ?? '0', 10) === 0;
}

/**
 * Convenience: true when Stage 2+3 should fire — either enough markets are
 * queued or Stage 1 is idle with at least one market waiting.
 */
export async function shouldTriggerStage23(): Promise<boolean> {
  const count = await getStage23QueueCount();
  if (count === 0) return false;
  if (count >= STAGE23_THRESHOLD) return true;
  return isStage1Idle();
}
