/**
 * Manual trigger for one batch of entity-enrichment work. Drains the
 * `entity_enrichment_queue` once and exits. Useful for verifying the
 * worker picks up new code (prompt template + resolver wiring) without
 * waiting for the daemon's Stage-1 flush boundary to fire.
 */
import { runEntityEnrichmentWorkers } from '../services/pipeline/src/entity-enrichment/index.js';

const stats = await runEntityEnrichmentWorkers({ drainAndExit: true });
console.log(JSON.stringify(stats, null, 2));
process.exit(0);
