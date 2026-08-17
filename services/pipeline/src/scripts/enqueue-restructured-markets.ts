/**
 * Enqueue every market whose llm_market_normalizations row was created or
 * updated by one of SESSION_MATCH_SOURCES into stage23_queue, so the next
 * full pipeline run processes them incrementally instead of a full-scan.
 *
 * Idempotent: enqueueStage23 uses ON CONFLICT DO NOTHING.
 *
 * Usage: bun services/pipeline/src/scripts/enqueue-restructured-markets.ts
 */
import { query, endPool } from '@arb/db';
import { enqueueStage23 } from '../db/queries/stage23-queue.js';
import { createLogger } from '@arb/logger';

const log = createLogger('enqueue-restructured');

const SESSION_MATCH_SOURCES = [
  'kalshi:player-finish-position',
  'kalshi:place-first-primary',
  'kalshi:midterm-mov',
  'kalshi:midterm-voteturn',
  'kalshi:categorical',
  'text-deterministic-C',
  'text-deterministic-AC',
  'text-deterministic-AD',
];

async function main(): Promise<void> {
  const t0 = Date.now();
  const rows = await query<{ market_id: number }>(
    `SELECT market_id FROM llm_market_normalizations
       WHERE match_source = ANY($1::text[])`,
    [SESSION_MATCH_SOURCES],
  );
  log.info(`Found ${rows.length} markets matching session match_sources`);

  const ids = rows.map((r) => r.market_id);
  const n = await enqueueStage23(ids);
  log.info(`Enqueued ${n} new market IDs to stage23_queue (rest were already queued)`);

  const total = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM stage23_queue`,
  );
  log.info(`stage23_queue total now: ${total[0]?.n ?? 0}`);
  log.info(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await endPool();
}

main().catch((err) => {
  log.error(`enqueue failed: ${(err as Error).message}`);
  process.exit(1);
});
