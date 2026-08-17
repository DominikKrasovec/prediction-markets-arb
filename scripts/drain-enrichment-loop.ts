/**
 * Continuous enrichment-queue drain. Calls runEntityEnrichmentWorkers in a
 * loop until the queue is empty (or near-empty), printing progress lines so
 * the supervisor can watch H6/H7 decline. Exits cleanly when stable.
 */
import { query } from '@arb/db';
import { runEntityEnrichmentWorkers } from '../services/pipeline/src/entity-enrichment/index.js';

async function pending(): Promise<number> {
  const r = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM entity_enrichment_queue WHERE status='pending'`);
  return Number(r[0].n);
}

async function dangling(): Promise<{ h6: number; h7: number }> {
  // Mirror the loosened, case-insensitive logic from db/health-checks.ts so
  // the drain loop's progress counters align with the daemon's authoritative
  // health checks. Type-equivalence for the league layer:
  // league / competition / organization all live at the same hierarchical
  // level (FIFA WC is competition, NCAA is organization, Premier League is
  // league — all valid league_canonical targets).
  const r = await query<{ h6: string; h7: string }>(`
    SELECT
      (SELECT COUNT(*)::text FROM known_entities k
         WHERE k.sport_canonical IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM known_entities s
                            WHERE s.type='sport'
                              AND LOWER(s.canonical) = LOWER(k.sport_canonical))) AS h6,
      (SELECT COUNT(*)::text FROM known_entities k
         WHERE k.league_canonical IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM known_entities l
                            WHERE l.type IN ('league','competition','organization')
                              AND LOWER(l.canonical) = LOWER(k.league_canonical))) AS h7
  `);
  return { h6: Number(r[0].h6), h7: Number(r[0].h7) };
}

let iteration = 0;
let lastPending = Infinity;
const start = Date.now();

while (true) {
  iteration++;
  const p0 = await pending();
  if (p0 === 0) { console.log(`[loop] queue empty — exiting`); break; }
  if (p0 === lastPending && iteration > 1) {
    // No progress between cycles — worker filter rejecting all rows.
    console.log(`[loop] no progress (pending stuck at ${p0}) — exiting`);
    break;
  }
  lastPending = p0;
  const before = await dangling();
  const t0 = Date.now();
  const stats = await runEntityEnrichmentWorkers({ drainAndExit: true });
  const after = await dangling();
  const p1 = await pending();
  const elapsedTotal = Math.round((Date.now() - start) / 1000);
  console.log(
    `[loop ${iteration}] pending ${p0} → ${p1}  ` +
    `enriched=${stats.enriched} skipped=${stats.skipped} failed=${stats.failed}  ` +
    `H6 ${before.h6} → ${after.h6} (Δ${after.h6 - before.h6})  ` +
    `H7 ${before.h7} → ${after.h7} (Δ${after.h7 - before.h7})  ` +
    `cycle=${Math.round((Date.now() - t0) / 1000)}s total=${elapsedTotal}s`
  );
}
process.exit(0);
