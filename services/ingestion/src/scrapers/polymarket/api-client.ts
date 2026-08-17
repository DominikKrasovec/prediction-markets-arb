/**
 * Gamma API service for fetching market and event data
 * Gamma API URL: https://gamma-api.polymarket.com
 */

import axios from 'axios';
import type { AxiosInstance } from 'axios';
import { withRetry, createRateLimiter } from '../http-utils.js';
import type { PolymarketMarket, PolymarketEvent } from './types.js';
import { createLogger } from '@arb/logger';

const log = createLogger('polymarket-api');

const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Module-level singleton — public API, no auth required
let _client: AxiosInstance | null = null;
function getClient(): AxiosInstance {
  if (!_client) {
    _client = axios.create({
      baseURL: GAMMA_API_URL,
      timeout: 30_000,
    });
  }
  return _client;
}

const RETRY_OPTS = { label: '[polymarket]', baseDelayMs: 400, maxDelayMs: 30_000, maxRetries: 8 };

// Proactive rate limit. Gamma docs: /events 500 req/10 s, 4000 req/10 s general
// (= 50/400 rps). We use a conservative 20 rps so a Gamma-side limit change can't
// turn the hourly scrape into a 429/ban loop (withRetry only reacts *after* a 429).
// Module-level so ALL Gamma calls in this process share one budget; env-tunable
// (raise-only cap, safe default). Wrap every getClient().get() below in throttle().
const POLYMARKET_MAX_RPS = Number(process.env.POLYMARKET_MAX_RPS) || 20;
const throttle = createRateLimiter(POLYMARKET_MAX_RPS);

interface FetchEventsOptions {
  limit?: number;
  maxEvents?: number | null;
  /** 'active' filter — now documented/supported on /events/keyset (2026-07-10 drift audit; the old "not in spec" note was stale). Passed through when set. */
  active?: boolean | null;
  closed?: boolean | null;
  order?: string;  // /events/keyset only supports non-null unique fields as sort keys (e.g. 'id'). Metric fields like 'liquidity'/'volume24hr' cause cursor encode failures → 500.
  ascending?: boolean;
  onBatch?: ((events: PolymarketEvent[], markets: PolymarketMarket[]) => Promise<void>) | null;
}

export async function fetchEvents(options: FetchEventsOptions = {}): Promise<{ totalEvents: number; totalMarkets: number }> {
  const {
    limit = 1000,
    maxEvents = null,
    active = null,
    closed = null,
    order = 'id',
    ascending = false,
    onBatch = null,
  } = options;

  try {
    let totalEvents = 0;
    let totalMarkets = 0;
    let nextCursor: string | null = null;
    let hasMore = true;

    // Use keyset endpoint (cursor-based) — offset-based /events is deprecated (Apr 2026).
    // closed=null means "include all (open + closed)"; since the API defaults closed=false
    // as of Apr 9 2026, we must explicitly pass closed=true to avoid silently dropping
    // historical markets when the caller wants everything.
    const closedParam: boolean = closed === null ? true : closed;

    // Empirical clamp: gamma-api.polymarket.com/events/keyset silently caps
    // responses at 100 items per page regardless of the requested limit.
    // Verified 2026-05-26 via smoke-pmxt-compare.ts (limit=50→50, 100→100,
    // 200→100, 500→100, 1000→100). Asking for more is wasted bytes on the
    // wire — the server still only returns 100 and we still need next_cursor.
    const PAGE_CAP = 100;
    log.info(`Fetching events via keyset pagination (limit=${Math.min(limit, PAGE_CAP)})...`);

    while (hasMore) {
      const params: Record<string, any> = {
        limit: Math.min(limit, PAGE_CAP),
        order,
        ascending,
        closed: closedParam,
      };

      // /events/keyset DOES support 'active' now (documented; 2026-07-10 drift
      // audit — the old "not in spec" assumption is stale). Pass it through
      // when the caller sets it; closed=false alone remains the default idiom.
      if (active !== null) params.active = active;
      if (nextCursor) params.after_cursor = nextCursor;

      const response = await withRetry(
        () => throttle(() => getClient().get('/events/keyset', { params })),
        RETRY_OPTS,
      );

      // Keyset response: { events: [...], next_cursor: "..." | null }
      const responseData = response.data;
      const eventsPage: any[] = responseData.events ?? [];

      if (eventsPage.length === 0) {
        hasMore = false;
        break;
      }

      const batchEvents: PolymarketEvent[] = [];
      const batchMarkets: PolymarketMarket[] = [];

      for (const eventData of eventsPage) {
        const event: PolymarketEvent = {
          id: eventData.id,
          title: eventData.title || '',
          slug: eventData.slug || '',
          description: eventData.description || '',
          startDateIso: eventData.startDateIso || '',
          endDateIso: eventData.endDateIso || '',
          icon: eventData.icon || '',
          image: eventData.image || '',
          creationDate: eventData.creationDate || '',
          category: eventData.category || '',
          tags: eventData.tags || [],
          markets: eventData.markets || [],
          rawData: eventData,
        };

        batchEvents.push(event);

        if (eventData.markets && Array.isArray(eventData.markets)) {
          for (const marketData of eventData.markets) {
            const market = parseMarket(marketData, eventData.id);
            batchMarkets.push(market);
          }
        }
      }

      totalEvents += batchEvents.length;
      totalMarkets += batchMarkets.length;

      if (onBatch && typeof onBatch === 'function') {
        await onBatch(batchEvents, batchMarkets);
      }

      log.info(`Fetched ${totalEvents} events, ${totalMarkets} markets so far...`);

      nextCursor = responseData.next_cursor ?? null;
      if (!nextCursor) {
        hasMore = false;
      }

      if (maxEvents && totalEvents >= maxEvents) {
        hasMore = false;
      }
    }

    log.info(`✓ Fetched ${totalEvents} total events with ${totalMarkets} total markets`);
    return { totalEvents, totalMarkets };
  } catch (error: any) {
    log.error('Error fetching events from Gamma API:', error.message);
    throw error;
  }
}

export async function fetchActiveMarkets(
  limit = 1000,
  maxEvents: number | null = null,
  onBatch: ((events: PolymarketEvent[], markets: PolymarketMarket[]) => Promise<void>) | null = null,
): Promise<any> {
  if (onBatch) {
    const { totalMarkets } = await fetchEvents({
      limit,
      maxEvents,
      active: true,
      closed: false,
      onBatch: async (events, markets) => {
        await onBatch(events, markets);
      }
    });
    return { totalMarkets };
  } else {
    const allMarkets: PolymarketMarket[] = [];
    await fetchEvents({
      limit,
      maxEvents,
      active: true,
      closed: false,
      onBatch: async (_events, markets) => {
        allMarkets.push(...markets);
      }
    });
    return allMarkets;
  }
}

export async function fetchAllMarkets(
  limit = 1000,
  maxEvents: number | null = null,
  onBatch: ((events: PolymarketEvent[], markets: PolymarketMarket[]) => Promise<void>) | null = null,
): Promise<any> {
  if (onBatch) {
    const { totalMarkets } = await fetchEvents({
      limit,
      maxEvents,
      active: null,
      closed: null,
      onBatch: async (events, markets) => {
        await onBatch(events, markets);
      }
    });
    return { totalMarkets };
  } else {
    const allMarkets: PolymarketMarket[] = [];
    await fetchEvents({
      limit,
      maxEvents,
      active: null,
      closed: null,
      onBatch: async (_events, markets) => {
        allMarkets.push(...markets);
      }
    });
    return allMarkets;
  }
}

export async function fetchMarketByConditionId(conditionId: string) {
  try {
    log.info(`Fetching market ${conditionId}...`);
    const response = await throttle(() => getClient().get(`/markets/${conditionId}`));

    if (!response.data) {
      return null;
    }

    return parseMarket(response.data, response.data.eventId || '');
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      log.info(`Market ${conditionId} not found`);
      return null;
    }
    log.error(`Error fetching market ${conditionId}:`, error.message);
    throw error;
  }
}

export async function fetchEventById(eventId: string) {
  try {
    log.info(`Fetching event ${eventId}...`);
    const response = await throttle(() => getClient().get(`/events/${eventId}`));

    if (!response.data) {
      return null;
    }

    const eventData = response.data;
    return {
      id: eventData.id,
      title: eventData.title || '',
      slug: eventData.slug || '',
      description: eventData.description || '',
      startDateIso: eventData.startDateIso || '',
      endDateIso: eventData.endDateIso || '',
      icon: eventData.icon || '',
      image: eventData.image || '',
      creationDate: eventData.creationDate || '',
      category: eventData.category || '',
      tags: eventData.tags || [],
      markets: eventData.markets || [],
      rawData: eventData,
    };
  } catch (error: any) {
    if (error.response && error.response.status === 404) {
      log.info(`Event ${eventId} not found`);
      return null;
    }
    log.error(`Error fetching event ${eventId}:`, error.message);
    throw error;
  }
}

export async function searchMarkets(query: string, limit = 100) {
  try {
    const params = { query, limit };

    log.info(`Searching markets: "${query}"`);
    const response = await throttle(() => getClient().get('/markets/search', { params }));

    const markets: any[] = [];
    for (const marketData of response.data) {
      const market = parseMarket(marketData, marketData.eventId || '');
      markets.push(market);
    }

    log.info(`✓ Found ${markets.length} markets matching "${query}"`);
    return markets;
  } catch (error: any) {
    log.error(`Error searching markets: ${error.message}`);
    throw error;
  }
}

function parseMarket(marketData: any, eventId: string): PolymarketMarket {
  return {
    id: marketData.id || '',
    eventId: eventId,
    question: marketData.question || '',
    description: marketData.description || '',
    conditionId: marketData.conditionId || '',
    slug: marketData.slug || '',
    resolutionSource: marketData.resolutionSource || '',
    endDateIso: marketData.endDateIso || '',
    startDateIso: marketData.startDateIso || '',
    endDate: marketData.endDate || '',
    startDate: marketData.startDate || '',
    createdAt: marketData.createdAt || '',
    updatedAt: marketData.updatedAt || '',
    category: marketData.category || '',
    tags: marketData.tags || [],
    outcomePrices: parseJsonField(marketData.outcomePrices, []),
    volumeNum: marketData.volumeNum || 0,
    liquidityNum: marketData.liquidityNum || 0,
    volume24hr: marketData.volume24hr || 0,
    volume1wk: marketData.volume1wk || 0,
    volume1mo: marketData.volume1mo || 0,
    volume1yr: marketData.volume1yr || 0,
    icon: marketData.icon || '',
    image: marketData.image || '',
    outcomes: parseJsonField(marketData.outcomes, []),
    clobTokenIds: parseJsonField(marketData.clobTokenIds, []),
    marketMakerAddress: marketData.marketMakerAddress || '',
    enableOrderBook: marketData.enableOrderBook || false,
    closed: marketData.closed || false,
    active: marketData.active || false,
    archived: marketData.archived || false,
    acceptingOrders: marketData.acceptingOrders || false,
    acceptingOrdersTimestamp: marketData.acceptingOrdersTimestamp || '',
    new: marketData.new || false,
    featured: marketData.featured || false,
    restricted: marketData.restricted || false,
    volume: marketData.volume || '0',
    liquidity: marketData.liquidity || '0',
    bestBid: marketData.bestBid != null ? Number(marketData.bestBid) : null,
    bestAsk: marketData.bestAsk != null ? Number(marketData.bestAsk) : null,
    lastTradePrice: marketData.lastTradePrice || null,
    spread: marketData.spread || null,
    oneWeekPriceChange: marketData.oneWeekPriceChange || null,
    oneMonthPriceChange: marketData.oneMonthPriceChange || null,
    resolvedBy: marketData.resolvedBy || '',
    winningOutcome: marketData.winningOutcome || null,
    questionID: marketData.questionID || '',
    submitted_by: marketData.submitted_by || '',
    negRisk: marketData.negRisk || false,
    negRiskMarketID: marketData.negRiskMarketID || '',
    negRiskRequestID: marketData.negRiskRequestID || '',
    umaBond: marketData.umaBond || '',
    umaReward: marketData.umaReward || '',
    competitive: marketData.competitive || 0,
    groupItemTitle: marketData.groupItemTitle || '',
    groupItemThreshold: marketData.groupItemThreshold || '',
    rawData: marketData,
  };
}

function parseJsonField(field: any, defaultValue: any) {
  if (typeof field === 'string') {
    try {
      return JSON.parse(field);
    } catch {
      return defaultValue;
    }
  }
  return field || defaultValue;
}

export async function getMarketStats() {
  try {
    const { totalEvents: _te, totalMarkets: _tm } = await fetchEvents({ limit: 10000 });

    // Note: this function collects in-memory -- not suitable for large datasets
    const allMarkets: any[] = [];
    const allEvents: any[] = [];
    await fetchEvents({
      limit: 10000,
      onBatch: async (events, markets) => {
        allEvents.push(...events);
        allMarkets.push(...markets);
      },
    });

    const activeMarkets = allMarkets.filter(m => m.active && !m.closed);
    const closedMarkets = allMarkets.filter(m => m.closed);

    const totalVolume = allMarkets.reduce((sum, m) => sum + m.volumeNum, 0);
    const totalLiquidity = allMarkets.reduce((sum, m) => sum + m.liquidityNum, 0);

    return {
      totalEvents: allEvents.length,
      totalMarkets: allMarkets.length,
      activeMarkets: activeMarkets.length,
      closedMarkets: closedMarkets.length,
      totalVolume,
      totalLiquidity,
      avgMarketsPerEvent: allMarkets.length / allEvents.length,
    };
  } catch (error: any) {
    log.error('Error getting market stats:', error.message);
    throw error;
  }
}
