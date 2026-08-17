/**
 * Entity-enrichment subsystem barrel.
 *
 * The deterministic Stage 1 path leaves `known_entities` metadata empty; the
 * worker exported here drains an async queue and fills in `type`, `aliases`,
 * `primary_team_canonical`, `sport_canonical`, etc. via a cheap NER
 * heuristic plus a batched LLM call.
 */
export { runEntityEnrichmentWorkers } from './worker.js';
export type { EnrichmentWorkerOptions, EnrichmentWorkerResult } from './worker.js';
export { classifyEntity } from './entity-heuristic.js';
export type { EntityContext, EntityClassification, EntityTypeHint } from './entity-heuristic.js';
