/**
 * Entity-enrichment work queue.
 *
 * Each row represents one `known_entities.id` that needs metadata enrichment
 * (type promotion, alias expansion, primary_team_canonical / sport_canonical
 * fill-in, canonical-vs-alias swap detection).
 *
 * Populated by:
 *   • Kalshi deterministic Stage 1 path (kalshi-deterministic.ts) every time
 *     it creates/touches a known_entities row — those rows have only a
 *     surface-form alias and no metadata.
 *   • findOrCreateEntity in entity-registry.ts when it CREATES a new row
 *     (LLM path also enqueues so the worker can correct any LLM mistakes).
 *   • A backfill migration for pre-existing rows with type='unknown',
 *     missing sport_canonical, or empty metadata.
 *
 * Drained by `services/pipeline/src/entity-enrichment/worker.ts`. Workers
 * claim rows via `FOR UPDATE SKIP LOCKED` so multiple workers can run in
 * parallel without contention. Pattern mirrors stage1_queue.
 */
import { query, withTx } from '@arb/db';

export interface EnrichmentClaim {
  id: number;
  entity_id: number;
  type_hint: string | null;
  reason: string | null;
  attempts: number;
}

/** Enqueue entity IDs. Idempotent — a row that already exists in done/failed
 *  state is reset to pending so a re-run can correct earlier mistakes. */
export async function enqueueEntityEnrichment(
  entityIds: readonly number[],
  reason: string,
): Promise<number> {
  if (entityIds.length === 0) return 0;
  return withTx(async (client) => {
    await client.query(
      `UPDATE known_entities
       SET enrichment_status = 'pending', updated_at = NOW()
       WHERE id = ANY($1::int[])
         AND enrichment_status <> 'manual'`,
      [entityIds as number[]],
    );

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO entity_enrichment_queue (entity_id, status, reason, attempts, error, claimed_by, claimed_at, updated_at)
       SELECT eid, 'pending', $2, 0, NULL, NULL, NULL, NOW()
       FROM unnest($1::int[]) AS t(eid)
       ON CONFLICT (entity_id) DO UPDATE SET
          status     = CASE
                         WHEN entity_enrichment_queue.status IN ('done','failed','skipped') THEN 'pending'
                         ELSE entity_enrichment_queue.status
                       END,
          attempts   = CASE
                         WHEN entity_enrichment_queue.status IN ('done','failed','skipped') THEN 0
                         ELSE entity_enrichment_queue.attempts
                       END,
          reason     = COALESCE(entity_enrichment_queue.reason, EXCLUDED.reason),
          error      = CASE
                         WHEN entity_enrichment_queue.status IN ('done','failed','skipped') THEN NULL
                         ELSE entity_enrichment_queue.error
                       END,
          claimed_by = CASE
                         WHEN entity_enrichment_queue.status IN ('done','failed','skipped') THEN NULL
                         ELSE entity_enrichment_queue.claimed_by
                       END,
          claimed_at = CASE
                         WHEN entity_enrichment_queue.status IN ('done','failed','skipped') THEN NULL
                         ELSE entity_enrichment_queue.claimed_at
                       END,
          updated_at = NOW()
       RETURNING id`,
      [entityIds as number[], reason],
    );
    return rows.length;
  });
}

/** Atomically claim up to `n` pending rows. Joins known_entities so the
 *  worker has everything it needs in one round-trip. Skips rows whose
 *  enrichment_status is no longer 'pending' (manual fixes, prior worker
 *  success that beat the queue update — defence in depth).             */
export async function claimEnrichmentBatch(
  workerId: string,
  n: number,
): Promise<EnrichmentClaim[]> {
  if (n <= 0) return [];
  return withTx(async (client) => {
    const { rows } = await client.query<EnrichmentClaim>(
      `WITH claimed AS (
         SELECT q.id
         FROM entity_enrichment_queue q
         JOIN known_entities ke ON ke.id = q.entity_id
         WHERE q.status = 'pending'
           AND ke.enrichment_status = 'pending'
         ORDER BY q.created_at, q.id
         LIMIT $1
         FOR UPDATE OF q SKIP LOCKED
       )
       UPDATE entity_enrichment_queue q
       SET status     = 'processing',
           claimed_by = $2,
           claimed_at = NOW(),
           attempts   = q.attempts + 1,
           updated_at = NOW()
       FROM claimed
       WHERE q.id = claimed.id
       RETURNING q.id, q.entity_id, q.type_hint, q.reason, q.attempts`,
      [n, workerId],
    );
    return rows;
  });
}

export async function setEnrichmentTypeHint(rowId: number, hint: string | null): Promise<void> {
  if (hint === null) return;
  await query(
    `UPDATE entity_enrichment_queue SET type_hint = $2, updated_at = NOW() WHERE id = $1`,
    [rowId, hint],
  );
}

export async function markEnrichmentDone(rowId: number): Promise<void> {
  await query(
    `UPDATE entity_enrichment_queue
     SET status = 'done', error = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [rowId],
  );
}

export async function markEnrichmentSkipped(rowId: number, reason: string): Promise<void> {
  await query(
    `UPDATE entity_enrichment_queue
     SET status = 'skipped', error = $2, claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [rowId, reason.slice(0, 4000)],
  );
}

export async function markEnrichmentFailed(rowId: number, errorMsg: string, maxAttempts = 3): Promise<void> {
  await query(
    `UPDATE entity_enrichment_queue
     SET status     = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
         error      = $2,
         claimed_by = NULL,
         claimed_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [rowId, errorMsg.slice(0, 4000), maxAttempts],
  );
}

/** Reclaim rows whose worker died (claimed_at older than threshold). */
export async function recoverStuckEnrichment(thresholdMs = 5 * 60_000): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE entity_enrichment_queue
     SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
     WHERE status = 'processing'
       AND claimed_at < NOW() - ($1::int * INTERVAL '1 millisecond')
     RETURNING id`,
    [thresholdMs],
  );
  return rows.length;
}

