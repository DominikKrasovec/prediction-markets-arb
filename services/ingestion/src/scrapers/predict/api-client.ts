/**
 * API client for Predict.fun API
 * Base URL: https://api.predict.fun
 */

import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { withRetry, createRateLimiter } from '../http-utils.js';
import { MarketStatus, CategorySortBy, MarketSortBy, MarketVariant } from './types.js';
import { createLogger } from '@arb/logger';

const log = createLogger('predict-api');

const BASE_URL = 'https://api.predict.fun';
const DEFAULT_PAGE_SIZE = 50;
const RETRY_OPTS = { label: '[predict]', baseDelayMs: 500, maxDelayMs: 30_000, maxRetries: 6 };

// Proactive rate limit. Predict documents 240 req/min = 4 rps; we throttle to a
// conservative 3.5 rps so a catch-up burst can't trip a 429/ban loop (withRetry
// only reacts *after* a 429). This is the HARD FLOOR shared by ALL Predict calls
// in this process (module-level) — the fetchMarketStatsBatch 750 ms inter-batch
// delay (ed6ba13) still applies on top; whichever is slower wins. Env-tunable
// (raise-only cap, safe default). Wrap every client.get() below in throttle().
const PREDICT_MAX_RPS = Number(process.env.PREDICT_MAX_RPS) || 3.5;
const throttle = createRateLimiter(PREDICT_MAX_RPS);

function getApiKey(): string {
  const apiKey = process.env.PREDICT_API_KEY;
  if (!apiKey) {
    throw new Error('PREDICT_API_KEY not found in environment variables');
  }
  return apiKey;
}

// Lazily-created singleton — auth header is baked in at first use
let _client: AxiosInstance | null = null;
function getClient(): AxiosInstance {
  if (!_client) {
    _client = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: {
        'x-api-key': getApiKey(),
        'Content-Type': 'application/json',
      },
    });
  }
  return _client;
}

interface FetchCategoriesOptions {
  first?: number;
  status?: string | null;
  sort?: string;
  tagIds?: string | string[] | null;
  marketVariant?: string | null;
  maxCategories?: number | null;
  onBatch?: ((categories: any[], markets: any[]) => Promise<void>) | null;
}

export async function fetchCategories(options: FetchCategoriesOptions = {}): Promise<{ totalCategories: number; totalMarkets: number }> {
  const {
    first = DEFAULT_PAGE_SIZE,
    status = null,
    sort = CategorySortBy.PUBLISHED_AT_DESC,
    tagIds = null,
    marketVariant = null,
    maxCategories = null,
    onBatch = null,
  } = options;

  const client = getClient();

  try {
    let totalCategories = 0;
    let totalMarkets = 0;
    let after: string | null = null;
    let hasMore = true;

    log.info(`Fetching categories (pagination with first=${first})...`);
    log.info(`  Status: ${status || 'all'}, Sort: ${sort}`);

    while (hasMore) {
      const params: Record<string, any> = {
        first: first.toString(),
      };

      if (after) params.after = after;
      if (status) params.status = status;
      if (sort) params.sort = sort;
      if (tagIds) {
        params.tagIds = Array.isArray(tagIds) ? tagIds.join(',') : tagIds;
      }
      if (marketVariant) params.marketVariant = marketVariant;

      const response = await withRetry(() => throttle(() => client.get('/v1/categories', { params })), RETRY_OPTS);

      if (!response.data.success) {
        log.error('API Error: Request was not successful');
        break;
      }

      const categories = response.data.data || [];
      after = response.data.cursor;

      if (categories.length === 0) {
        log.info('  No more categories returned');
        hasMore = false;
        break;
      }

      const markets: any[] = [];
      categories.forEach((category: any) => {
        if (category.markets && Array.isArray(category.markets)) {
          category.markets.forEach((market: any) => {
            markets.push({
              ...market,
              categoryId: category.id,
              categorySlug: category.slug,
              categoryTitle: category.title,
              categoryImageUrl: category.imageUrl,
              categoryTags: category.tags || [],
            });
          });
        }
      });

      totalCategories += categories.length;
      totalMarkets += markets.length;

      if (onBatch && typeof onBatch === 'function') {
        await onBatch(categories, markets);
      }

      log.info(`  Fetched ${totalCategories} categories, ${totalMarkets} markets so far...`);

      if (maxCategories && totalCategories >= maxCategories) {
        hasMore = false;
        log.info(`  Reached max categories limit: ${maxCategories}`);
      } else if (!after) {
        hasMore = false;
        log.info('  No more pages (cursor is null)');
      }
    }

    log.info(`\n✓ Fetched ${totalCategories} categories with ${totalMarkets} markets total`);
    return { totalCategories, totalMarkets };

  } catch (error: any) {
    log.error('Error fetching categories:', error.message);
    if (error.response) {
      log.error('Response status:', error.response.status);
      log.error('Response data:', error.response.data);
    }
    throw error;
  }
}

interface FetchMarketsOptions {
  first?: number;
  isBoosted?: boolean | null;
  status?: string | null;
  tagIds?: string | string[] | null;
  marketVariant?: string | null;
  sort?: string | null;
  maxMarkets?: number | null;
  onBatch?: ((markets: any[]) => Promise<void>) | null;
}

export async function fetchMarkets(options: FetchMarketsOptions = {}): Promise<{ totalMarkets: number }> {
  const {
    first = DEFAULT_PAGE_SIZE,
    isBoosted = null,
    status = null,
    tagIds = null,
    marketVariant = null,
    sort = null,
    maxMarkets = null,
    onBatch = null,
  } = options;

  const client = getClient();

  try {
    let totalMarkets = 0;
    let after: string | null = null;
    let hasMore = true;

    log.info(`Fetching markets (pagination with first=${first})...`);
    log.info(`  Status: ${status || 'all'}, Boosted: ${isBoosted !== null ? isBoosted : 'all'}`);

    while (hasMore) {
      const params: Record<string, any> = {
        first: first.toString(),
      };

      if (after) params.after = after;
      if (isBoosted !== null) params.isBoosted = isBoosted.toString();
      if (status) params.status = status;
      if (tagIds) {
        params.tagIds = Array.isArray(tagIds) ? tagIds.join(',') : tagIds;
      }
      if (marketVariant) params.marketVariant = marketVariant;
      if (sort) params.sort = sort;

      const response = await withRetry(() => throttle(() => client.get('/v1/markets', { params })), RETRY_OPTS);

      if (!response.data.success) {
        log.error('API Error: Request was not successful');
        break;
      }

      const markets = response.data.data || [];
      after = response.data.cursor;

      if (markets.length === 0) {
        log.info('  No more markets returned');
        hasMore = false;
        break;
      }

      totalMarkets += markets.length;

      if (onBatch && typeof onBatch === 'function') {
        await onBatch(markets);
      }

      log.info(`  Fetched ${totalMarkets} markets so far...`);

      if (maxMarkets && totalMarkets >= maxMarkets) {
        hasMore = false;
        log.info(`  Reached max markets limit: ${maxMarkets}`);
      } else if (!after) {
        hasMore = false;
        log.info('  No more pages (cursor is null)');
      }
    }

    log.info(`\n✓ Fetched ${totalMarkets} markets total`);
    return { totalMarkets };

  } catch (error: any) {
    log.error('Error fetching markets:', error.message);
    if (error.response) {
      log.error('Response status:', error.response.status);
      log.error('Response data:', error.response.data);
    }
    throw error;
  }
}

export async function fetchMarketStats(marketId: number | string, _maxRetries = 3) {
  const client = getClient();
  try {
    const response = await withRetry(
      () => throttle(() => client.get(`/v1/markets/${marketId}/stats`)),
      { ...RETRY_OPTS, maxRetries: _maxRetries, retryableStatuses: [429, 500, 502, 503, 504] },
    );
    if (!response.data.success || !response.data.data) return null;
    return {
      volumeTotalUsd: response.data.data.volumeTotalUsd || 0,
      volume24hUsd: response.data.data.volume24hUsd || 0,
      totalLiquidityUsd: response.data.data.totalLiquidityUsd || 0,
    };
  } catch (error: any) {
    const status = error.response?.status;
    if (status !== 404) {
      log.warn(`  ⚠ Stats failed for market ${marketId}: ${error.message}`);
    }
    return null;
  }
}

interface FetchStatsBatchOptions {
  concurrency?: number;
  delayMs?: number;
  onBatch?: ((results: any[]) => Promise<void>) | null;
}

export async function fetchMarketStatsBatch(marketIds: (number | string)[], options: FetchStatsBatchOptions = {}): Promise<Map<string, any>> {
  const {
    concurrency = 3,
    // 750 ms floor: 3 requests per ≥750 ms window = 4 rps = 240 req/min, the
    // documented Predict cap (2026-07-10 drift audit). The old 500 ms default
    // burst to 360 req/min and leaned on the adaptive backoff to absorb 429s.
    delayMs = 750,
    onBatch = null,
  } = options;

  const results = new Map<string, any>();
  const failed: (number | string)[] = [];
  let processed = 0;
  let currentDelay = delayMs;

  log.info(`Fetching stats for ${marketIds.length} markets (concurrency=${concurrency}, delay=${delayMs}ms)...`);

  for (let i = 0; i < marketIds.length; i += concurrency) {
    const batch = marketIds.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (id) => {
        const stats = await fetchMarketStats(id);
        return { id, stats };
      })
    );

    let batchFailed = 0;
    const batchMap: any[] = [];
    for (const { id, stats } of batchResults) {
      if (stats) {
        results.set(String(id), stats);
        batchMap.push({ id, ...stats });
      } else {
        batchFailed++;
        failed.push(id);
      }
    }

    processed += batch.length;

    if (onBatch && batchMap.length > 0) {
      await onBatch(batchMap);
    }

    if (batchFailed > 0) {
      currentDelay = Math.min(currentDelay * 2, 5000);
    } else if (currentDelay > delayMs) {
      currentDelay = Math.max(currentDelay * 0.8, delayMs);
    }

    if (processed % 50 === 0 || processed === marketIds.length) {
      log.info(`  Stats: ${processed}/${marketIds.length} processed, ${results.size} with data${failed.length ? `, ${failed.length} failed` : ''} (delay: ${Math.round(currentDelay)}ms)`);
    }

    if (i + concurrency < marketIds.length) {
      await new Promise(resolve => setTimeout(resolve, currentDelay));
    }
  }

  if (failed.length > 0) {
    log.info(`  Retrying ${failed.length} failed markets (1 at a time, 1.5s delay)...`);
    for (const id of failed) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const stats = await fetchMarketStats(id, 5);
      if (stats) {
        results.set(String(id), stats);
        if (onBatch) {
          await onBatch([{ id, ...stats }]);
        }
      }
    }
    log.info(`  Retry complete: ${results.size}/${marketIds.length} total with data`);
  }

  log.info(`✓ Fetched stats for ${results.size}/${marketIds.length} markets`);
  return results;
}

export async function fetchTags(): Promise<any[]> {
  const client = getClient();

  try {
    const response = await throttle(() => client.get('/v1/tags'));

    if (!response.data.success) {
      throw new Error('API Error: Request was not successful');
    }

    return response.data.data || [];

  } catch (error: any) {
    log.error('Error fetching tags:', error.message);
    throw error;
  }
}
