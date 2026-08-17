/**
 * Centralized SQL query layer for the pipeline service.
 *
 * ALL SQL queries live here, organized by table/domain.
 * Stage files import query functions instead of writing inline SQL.
 * When a schema changes, you edit ONE file — not 15.
 */
export * from './pipeline-runs.js';
export * from './markets.js';
export * from './features.js';
export * from './normalizations.js';
export * from './questions.js';
export * from './edges.js';
export * from './platform-events.js';
export * from './stage1-queue.js';
export * from './market-stats.js';
