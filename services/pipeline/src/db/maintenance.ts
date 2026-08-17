/**
 * Postgres maintenance helpers — runs VACUUM (ANALYZE) on heavy-write tables
 * at phase boundaries so dead-tuple bloat from UPDATEs doesn't accumulate
 * during long pipeline runs.
 *
 * VACUUM (ANALYZE) vs VACUUM FULL:
 *   VACUUM marks dead pages reusable in-place — no exclusive lock, no 2x
 *   disk requirement, safe to run while queries hit the table. That's all
 *   we need to keep bloat bounded during a run. VACUUM FULL rewrites the
 *   table and is only needed when the data file itself must be shrunk back
 *   (a manual operation, not part of the pipeline).
 *
 * Table names are passed as identifiers — callers must supply trusted
 * literals (no user input).
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('maintenance');

export async function vacuumAnalyze(tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    try {
      const t0 = Date.now();
      await query(`VACUUM (ANALYZE) ${table}`);
      log.info(`vacuum: ${table} (${Date.now() - t0}ms)`);
    } catch (err) {
      // VACUUM can fail under transient contention (another VACUUM running,
      // or a lock conflict on a freshly DDL'd table). Log and continue —
      // the next run will pick up the bloat.
      log.warn(`vacuum failed for ${table}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
