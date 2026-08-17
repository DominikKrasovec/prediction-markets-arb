/**
 * Stage 2b — reconstruct events for platforms with no native grouping.
 *
 * Two responsibilities:
 *   1. ensureSingletonEvents() — DETERMINISTIC. Every market lacking a
 *      platform_event (Limitless, and any orphan binary on other platforms)
 *      gets wrapped in a synthetic singleton platform_event so it flows through
 *      the uniform Stage 2c → 3a → 3b → 4 path. Standalone "Will X by Y?"
 *      binaries become matchable cross-platform this way.
 *   2. (FOLLOW-UP) LLM cluster reconstruction — grouping multiple Limitless
 *      markets that belong to ONE real event (e.g. a categorical race split
 *      across several standalone YES/NO listings) into a single multi-child
 *      platform_event. Tracked separately; the singleton path is correct (just
 *      coarser) until it lands.
 *
 * Synthetic platform_event_id convention: `synthetic:<platform>:<market_id>`,
 * written back onto markets.platform_event_id so the (platform, platform_event_id)
 * join used everywhere downstream resolves. grouping_type is inherited from the
 * market (defaults to 'unknown').
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('reconstruct-events');

export async function ensureSingletonEvents(): Promise<number> {
  // 1. Assign a synthetic platform_event_id to every market that has none.
  await query(`
    UPDATE markets
       SET platform_event_id = 'synthetic:' || platform || ':' || id
     WHERE platform_event_id IS NULL
  `);

  // 2. Materialise the platform_events rows for those synthetic ids (idempotent).
  const rows = await query<{ n: number }>(`
    WITH ins AS (
      INSERT INTO platform_events (platform, platform_event_id, grouping_type, title, child_count)
      SELECT m.platform, m.platform_event_id,
             COALESCE(m.grouping_type, 'unknown'),
             MIN(m.title),
             COUNT(*)
      FROM markets m
      WHERE m.platform_event_id LIKE 'synthetic:%'
      GROUP BY m.platform, m.platform_event_id, m.grouping_type
      ON CONFLICT (platform, platform_event_id) DO UPDATE SET
        child_count = EXCLUDED.child_count,
        updated_at  = NOW()
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `);

  const n = rows[0]?.n ?? 0;
  log.info(`Stage 2b: ensured ${n} singleton platform_events for orphan markets`);
  return n;
}
