// Type-only circular import: TS resolves at compile time only, no runtime cycle.
// UnifiedCategory lives in pipeline.ts (the source-of-truth const array
// `UNIFIED_CATEGORIES` is also there) so consumers of `category_unified`
// get a tight union rather than `string | null`.
import type { UnifiedCategory } from './pipeline.js';

/** Platform identifiers — the 4 supported markets */
export type Platform = 'kalshi' | 'limitless' | 'polymarket' | 'predict';

/** Normalized market row stored in PostgreSQL `markets` table */
export interface SyncedMarket {
  id: number;
  platform: Platform;
  platform_id: string;
  title: string;
  description: string;
  status: string;
  end_date: Date | null;
  volume: number;
  embedding: number[] | null;
  /** Platform-native grouping ID (null for orphan markets). */
  platform_event_id: string | null;
  /** Structural classification of the event group; null for orphans. */
  grouping_type: 'threshold_series' | 'categorical_exclusive' | 'bundle_nonexclusive' | 'unknown' | null;
  /**
   * Deterministic keyword-based broad category assigned by the market normalizer.
   * See UnifiedCategory in pipeline.ts for the canonical list of values.
   * Used as a prior hint for Stage 1b LLM category_unified output, and as a Stage 2
   * ANN candidate guard rail (pairs with conflicting non-null categories are rejected).
   * Stage 1b LLM confirms or overrides this value and writes it back to markets.
   */
  category_unified: UnifiedCategory | null;
  created_at: Date;
  updated_at: Date;
}
