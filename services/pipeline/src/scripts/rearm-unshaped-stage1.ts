/**
 * Re-arm UNSHAPED live-active markets into stage1_queue after a handler wave.
 *
 * WHY. backfillStage1Queue() deliberately gates on "never processed"
 * (market_features missing OR embedding NULL). So markets
 * that Stage 1 already attempted but could not shape NEVER re-enter the queue
 * on a daemon restart, and newly shipped deterministic handlers only apply to
 * new arrivals. This script is the explicit, additive materialization step for
 * a handler wave: it re-queues exactly the rows the wave targets (no shaped
 * lmn row), using the SAME upsert idiom as backfillStage1Queue (pending only
 * from done/failed — never clobbers an in-flight claim). Stage-1 workers then
 * re-run the regex-first handlers; still-unhandled rows no-op as before.
 *
 * Usage (repo root):  npx tsx services/pipeline/src/scripts/rearm-unshaped-stage1.ts [platform]
 *   platform default 'kalshi'; pass 'all' for every platform.
 */
import 'dotenv/config';
import { query, endPool } from '@arb/db';

const platform = process.argv[2] ?? 'kalshi';
const platformPred = platform === 'all' ? '' : `AND m.platform = '${platform.replace(/'/g, "''")}'`;

const rows = await query<{ id: number }>(
  `INSERT INTO stage1_queue (market_id, status)
   SELECT m.id, 'pending'
   FROM markets m
   WHERE m.resolved_at IS NULL
     AND (m.end_date IS NULL OR m.end_date > NOW())
     ${platformPred}
     AND NOT EXISTS (
       SELECT 1 FROM llm_market_normalizations n
       WHERE n.market_id = m.id AND n.condition_shape IS NOT NULL
     )
   ON CONFLICT (market_id) DO UPDATE SET
     status     = 'pending',
     error      = NULL,
     claimed_by = NULL,
     claimed_at = NULL,
     updated_at = NOW()
   WHERE stage1_queue.status IN ('done', 'failed')
   RETURNING id`,
);
console.log(`re-armed ${rows.length} unshaped live-active ${platform} market(s) into stage1_queue`);
await endPool();
