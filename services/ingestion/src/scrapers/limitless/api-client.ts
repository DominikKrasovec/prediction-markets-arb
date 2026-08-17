/**
 * API client for Limitless Exchange
 * Base URL: https://api.limitless.exchange
 * Rate limit: 2 concurrent, 300 ms between requests
 */

import axios from 'axios';
import type { LimitlessMarket, ActiveMarketsResponse, LimitlessSlugEntry } from './types.js';
import { normalizeMarket } from './types.js';
import { withRetry, createConcurrencyLimiter } from '../http-utils.js';
import { createLogger } from '@arb/logger';

const log = createLogger('limitless-api');

const BASE_URL = 'https://api.limitless.exchange';
// Limitless rate limit: 2 concurrent connections, ≥ 300 ms between requests.
const REQUEST_GAP_MS = 300;
const RETRY_OPTS = { label: '[limitless]', baseDelayMs: 400, maxDelayMs: 30_000, maxRetries: 6 };
// Limitless allows 2 concurrent connections. The pagination loop is already
// sequential (REQUEST_GAP_MS between pages), but single-market fetches
// (fetchMarketBySlug, called per WSS marketCreated in bursts) had no pacing —
// this module-level limiter caps in-flight requests across ALL callers.
const limit = createConcurrencyLimiter(2);

function getApiKey(): string | undefined {
  return process.env.LIMITLESS_API_KEY;
}

function createHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = getApiKey();
  if (key) headers['X-API-Key'] = key;
  return headers;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getWithRetry<T>(path: string, params?: Record<string, any>): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await withRetry(
    () => limit(() => axios.get<T>(url, { params, headers: createHeaders(), timeout: 30_000 })),
    RETRY_OPTS,
  );
  return response.data;
}

export interface FetchActiveMarketsOptions {
  onBatch: (markets: LimitlessMarket[]) => Promise<void>;
  clobOnly?: boolean;
}

/**
 * Fetch all active markets with page-based pagination.
 * Optionally filters to tradeType=clob only.
 */
export async function fetchActiveMarkets(opts: FetchActiveMarketsOptions): Promise<{ total: number }> {
  const { onBatch, clobOnly = true } = opts;
  let page = 1;
  let totalFetched = 0;

  log.info(`Fetching active markets (clobOnly=${clobOnly})...`);

  while (true) {
    // Note: actual API enforces limit ≤ 25 (docs say 100 but that is wrong)
    const PAGE_SIZE = 25;
    const params: Record<string, any> = { page, limit: PAGE_SIZE };

    const res = await getWithRetry<ActiveMarketsResponse>('/markets/active', params);
    let batch = res.data ?? [];

    if (batch.length === 0) break;

    // Normalize each market (ensure positionIds populated from tokens)
    batch = batch.map(normalizeMarket);

    // Client-side filter for CLOB only if requested
    const filtered = clobOnly ? batch.filter(m => m.tradeType === 'clob') : batch;

    if (filtered.length > 0) {
      await onBatch(filtered);
    }
    totalFetched += batch.length;
    log.info(`  Fetched ${totalFetched} / ${res.totalMarketsCount} markets (${filtered.length} clob in this batch)...`);

    const hasMore = batch.length === PAGE_SIZE && page * PAGE_SIZE < res.totalMarketsCount;
    if (!hasMore) break;

    page++;
    // Rate limit: 300 ms between requests
    await sleep(REQUEST_GAP_MS);
  }

  return { total: totalFetched };
}

/**
 * Fetch lightweight slug list — fast for change-detection polling.
 */
export async function fetchActiveSlugs(): Promise<LimitlessSlugEntry[]> {
  return getWithRetry<LimitlessSlugEntry[]>('/markets/active/slugs');
}

/**
 * Fetch full detail for a single market by slug.
 * Contains venue addresses + positionIds needed for CLOB.
 */
export async function fetchMarketBySlug(slug: string): Promise<LimitlessMarket> {
  // normalizeMarket populates positionIds from tokens — match the bulk
  // fetchActiveMarkets path so single-fetch callers (WSS lifecycle) get a
  // scrape-shape-identical row.
  return normalizeMarket(await getWithRetry<LimitlessMarket>(`/markets/${encodeURIComponent(slug)}`));
}

/**
 * Search markets by query string.
 */
export async function searchMarkets(query: string): Promise<LimitlessMarket[]> {
  return getWithRetry<LimitlessMarket[]>('/markets/search', { query });
}
