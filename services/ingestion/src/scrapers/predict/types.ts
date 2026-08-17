/** Predict API constants */

export const MarketStatus = {
  OPEN: 'OPEN',
  RESOLVED: 'RESOLVED',
} as const;

export const CategorySortBy = {
  VOLUME_24H_DESC: 'VOLUME_24H_DESC',
  VOLUME_ALL_DESC: 'VOLUME_ALL_DESC',
  PUBLISHED_AT_ASC: 'PUBLISHED_AT_ASC',
  PUBLISHED_AT_DESC: 'PUBLISHED_AT_DESC',
} as const;

export const MarketSortBy = {
  CHANCE_24H_CHANGE_ASC: 'CHANCE_24H_CHANGE_ASC',
  CHANCE_24H_CHANGE_DESC: 'CHANCE_24H_CHANGE_DESC',
  VOLUME_24H_ASC: 'VOLUME_24H_ASC',
  VOLUME_24H_DESC: 'VOLUME_24H_DESC',
  VOLUME_24H_CHANGE_ASC: 'VOLUME_24H_CHANGE_ASC',
  VOLUME_24H_CHANGE_DESC: 'VOLUME_24H_CHANGE_DESC',
  VOLUME_TOTAL_ASC: 'VOLUME_TOTAL_ASC',
  VOLUME_TOTAL_DESC: 'VOLUME_TOTAL_DESC',
} as const;

export const MarketVariant = {
  DEFAULT: 'DEFAULT',
  SPORTS_MATCH: 'SPORTS_MATCH',
  CRYPTO_UP_DOWN: 'CRYPTO_UP_DOWN',
  TWEET_COUNT: 'TWEET_COUNT',
  SPORTS_TEAM_MATCH: 'SPORTS_TEAM_MATCH',
  // Added to the documented enum by 2026-07 (venue-API drift audit 2026-07-10).
  // The crawl passes marketVariant=null so ingestion is unaffected; these exist
  // for variant-keyed normalization downstream.
  SPORTS_NBA: 'SPORTS_NBA',
  SPORTS_FIFA_WORLD_CUP: 'SPORTS_FIFA_WORLD_CUP',
  SPORTS_EXACT_SCORE: 'SPORTS_EXACT_SCORE',
  SPORTS_HALFTIME_RESULT: 'SPORTS_HALFTIME_RESULT',
  SPORTS_PROPS: 'SPORTS_PROPS',
  SPORTS_FIFA_FRIENDLIES: 'SPORTS_FIFA_FRIENDLIES',
} as const;

export const OutcomeStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  RESOLVED: 'RESOLVED',
} as const;

/**
 * A Predict market as assembled by api-client.ts: raw API market fields
 * spread-merged with category context (`categoryId`, `categorySlug`, etc.).
 *
 * NOTE on `raw` column contract: postgres.ts stores `JSON.stringify(m)` — the
 * combined post-transform object.  Downstream SQL consumers (platform-groups,
 * sync.ts) read fields like `conditionId` and `categorySlug` from the stored
 * JSON, so this is intentionally post-transform.
 *
 * Unknown API fields from the raw `/v1/categories` response are preserved via
 * the index signature below.
 */
export interface PredictMarket {
  /** Platform-internal market ID. */
  id: number | string;
  conditionId?: string | null;
  categoryId?: string | null;
  categorySlug?: string | null;
  categoryTitle?: string | null;
  categoryImageUrl?: string | null;
  categoryTags?: unknown[];
  status?: string | null;
  /** Allow additional raw API fields that we don't explicitly model. */
  [key: string]: unknown;
}

/**
 * A Predict category row as returned by `GET /v1/categories`. Only the columns
 * the scraper persists to `predict_categories` are explicitly typed; the index
 * signature keeps unknown raw-API fields accessible without losing them.
 *
 * Same `raw`-column contract as PredictMarket: postgres.ts stores
 * `JSON.stringify(c)` (the whole post-transform object).
 */
export interface PredictCategory {
  id: number | string;
  slug?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

/**
 * A Predict tag row as returned by `GET /v1/tags`. Same contract as
 * PredictCategory: only persisted columns are typed, raw fields are allowed.
 */
export interface PredictTag {
  id: number | string;
  name?: string | null;
  [key: string]: unknown;
}

/**
 * Per-market volume stats returned by `fetchMarketStatsBatch` and consumed by
 * `dbService.enrichMarketStats`. `id` must match a row in `predict_markets`;
 * the three volume fields are merged into `raw` via jsonb concatenation.
 */
export interface PredictMarketStats {
  id: number | string;
  volumeTotalUsd?: number | null;
  volume24hUsd?: number | null;
  totalLiquidityUsd?: number | null;
}
