/**
 * Unified cross-platform category classifier — produces the SAME labels as
 * `markets.category_unified`.
 *
 * De-forked by naming audit T2-4 (2026-07-21): the KEYWORDS regex + classifier
 * are now the single source of truth in @arb/types
 * (packages/types/src/category-classifier.ts) and imported by BOTH the pipeline
 * (services/pipeline/src/db/category-taxonomy.ts) and this DB-less bench. The
 * previous vendored copy (which carried a "KEEP IN SYNC" warning) is gone.
 *
 * This module stays as a thin re-export so the bench's existing importers
 * (classify.ts, metrics.ts) keep their import path.
 */
export { classifyCategoryLabels, KEYWORDS } from '@arb/types';
export { UNIFIED_CATEGORIES, type UnifiedCategory } from '@arb/types';
