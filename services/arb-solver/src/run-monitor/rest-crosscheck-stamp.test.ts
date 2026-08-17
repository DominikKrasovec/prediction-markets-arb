import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  buildRestValidation,
  worstVerdict,
  type StampClusterMarket,
  type StampLeg,
  type RestLegCheck,
} from './rest-crosscheck-stamp.js';
import { _resetRestCrosscheckCache } from '../clob/rest-crosscheck.js';

// INFO-ONLY stamp builder test. We mock global `fetch` (the only side-effect the
// underlying fetchRestBook performs) and the PM token-map loader (injected seam),
// then assert the per-leg verdicts the stamp produces. The compare logic itself
// is unit-tested separately in clob/rest-crosscheck.test.ts; here we verify the
// run-monitor GLUE: leg→market mapping, consumed-side selection, PM token
// round-trip, Limitless-NO degradation, and the never-throw contract.

const realFetch = globalThis.fetch;

/** Queue a per-URL JSON responder. */
function mockFetch(handler: (url: string) => unknown | null): void {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = handler(url);
    if (body == null) return { ok: false, status: 404, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => body } as any;
  }) as any;
}

beforeEach(() => {
  _resetRestCrosscheckCache();
  // Make Kalshi creds present-free path predictable: force a fresh env each test.
  process.env.REST_CROSSCHECK_TTL_MS = '1'; // effectively no cross-test reuse
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('buildRestValidation (INFO-only stamp glue)', () => {
  it('YES leg, Limitless: REST ask matches WSS ask ⟹ valid', async () => {
    mockFetch((url) =>
      url.includes('/markets/slug-x/orderbook')
        ? { bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] }
        : null,
    );
    const market: StampClusterMarket = {
      marketId: 1,
      platform: 'limitless',
      platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'YES' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    expect(v.perLeg).toHaveLength(1);
    expect(v.perLeg[0].verdict).toBe('valid');
    expect(v.perLeg[0].restBestAsk).toBe(0.42);
    expect(v.allValid).toBe(true);
    expect(v.timedOut).toBe(false);
  });

  it('YES leg, Limitless: REST ask diverges ⟹ mismatch (allValid false)', async () => {
    mockFetch((url) =>
      url.includes('/markets/slug-x/orderbook')
        ? { bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.60, size: 100 }] }
        : null,
    );
    const market: StampClusterMarket = {
      marketId: 1,
      platform: 'limitless',
      platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'YES' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    expect(v.perLeg[0].verdict).toBe('mismatch');
    expect(v.perLeg[0].deltaBps).not.toBeNull();
    expect(v.allValid).toBe(false);
  });

  it('NO leg, Limitless: DERIVES NO from the YES book (fetch YES, consume bid)', async () => {
    // The live feed synthesizes Limitless NO as NO_ask = 1 − YES_bid. The
    // cross-check mirrors this: it FETCHES the YES slug book and compares the
    // YES-BID side (= 1 − NO_ask) — so a Limitless NO leg is now `derived`, not
    // structurally unavailable. WSS YES-bid 0.40 vs REST YES-bid 0.40 ⟹ valid.
    let fetchedSlug = '';
    mockFetch((url) => {
      fetchedSlug = url;
      return { bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] };
    });
    const market: StampClusterMarket = {
      marketId: 1,
      platform: 'limitless',
      platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'NO' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    // It fetches the YES slug book.
    expect(fetchedSlug).toContain('/markets/slug-x/orderbook');
    expect(v.perLeg[0].verdict).toBe('valid');
    expect(v.perLeg[0].derived).toBe(true);
    // The compare consumed the YES-bid side (the NO authority), surfaced as restBestBid.
    expect(v.perLeg[0].restBestBid).toBe(0.40);
  });

  it('NO leg, Limitless: derived NO mismatches when the REST YES-bid diverges', async () => {
    // WSS YES-bid 0.40 (⟹ NO_ask 0.60) but REST YES-bid 0.10 (⟹ NO_ask 0.90):
    // |0.40 − 0.10| = 0.30 ≫ tolerance ⟹ mismatch on the derived NO leg.
    mockFetch(() => ({ bids: [{ price: 0.10, size: 100 }], asks: [{ price: 0.42, size: 100 }] }));
    const market: StampClusterMarket = {
      marketId: 1,
      platform: 'limitless',
      platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'NO' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    expect(v.perLeg[0].verdict).toBe('mismatch');
    expect(v.perLeg[0].derived).toBe(true);
    expect(v.allValid).toBe(false);
  });

  it('NO leg, Limitless: derived NO is rest-unavailable when the REST YES book has no bid', async () => {
    // A real but bid-less YES book (asks only) ⟹ no YES-bid to derive NO from ⟹
    // genuine rest-unavailable (distinguished from a fetch failure by a SET ask).
    mockFetch(() => ({ bids: [], asks: [{ price: 0.42, size: 100 }] }));
    const market: StampClusterMarket = {
      marketId: 1,
      platform: 'limitless',
      platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'NO' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    expect(v.perLeg[0].verdict).toBe('rest-unavailable');
  });

  it('NO leg, Kalshi: synthetic NO derived from the YES book (consume bid, derived)', async () => {
    // Kalshi REST returns YES bids + NO bids (no asks). normalizeKalshi maps it to
    // a YES-side book: YES bid = best yes_dollars. The synthetic-NO leg compares
    // the YES-bid side. yes_dollars bestBid 0.55 = WSS YES-bid 0.55 ⟹ valid.
    mockFetch((url) =>
      url.includes('/markets/KXTEST/orderbook')
        ? { orderbook_fp: { yes_dollars: [['0.5500', 200], ['0.5400', 300]], no_dollars: [['0.4300', 100]] } }
        : null,
    );
    const market: StampClusterMarket = {
      marketId: 2,
      platform: 'kalshi',
      platformId: 'KXTEST',
      yesBook: { bestBid: 0.55, bestAsk: 0.57, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 2, platform: 'kalshi', platformId: 'KXTEST', side: 'NO' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    expect(v.perLeg[0].verdict).toBe('valid');
    expect(v.perLeg[0].derived).toBe(true);
    expect(v.perLeg[0].restBestBid).toBe(0.55);
  });

  it('stale WSS book ⟹ stale verdict, REST still fetched for context', async () => {
    mockFetch(() => ({ bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] }));
    const market: StampClusterMarket = {
      marketId: 1,
      platform: 'limitless',
      platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: Date.now() - 5000 },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'YES' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    expect(v.perLeg[0].verdict).toBe('stale');
  });

  it('Predict YES leg uses leg.platformId directly as the numeric market id', async () => {
    let seenUrl = '';
    mockFetch((url) => {
      seenUrl = url;
      return { success: true, data: { bids: [[0.40, 100]], asks: [[0.42, 100]] } };
    });
    const market: StampClusterMarket = {
      marketId: 7,
      platform: 'predict',
      platformId: '12345',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 7, platform: 'predict', platformId: '12345', side: 'YES' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    expect(seenUrl).toContain('/v1/markets/12345/orderbook');
    expect(v.perLeg[0].verdict).toBe('valid');
  });

  it('Polymarket YES leg round-trips condition_id → clobTokenId via the injected loader', async () => {
    let seenUrl = '';
    mockFetch((url) => {
      seenUrl = url;
      return { bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] };
    });
    const market: StampClusterMarket = {
      marketId: 9,
      platform: 'polymarket',
      platformId: '0xCONDITION',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 9, platform: 'polymarket', platformId: '0xCONDITION', side: 'YES' },
    ];
    const tokenMapLoader = async () =>
      new Map([['0xCONDITION', { yesTokenId: 'YESTOK', noTokenId: 'NOTOK', outcomes: ['Yes', 'No'] as [string, string] }]]);
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500, tokenMapLoader });
    expect(seenUrl).toContain('token_id=YESTOK');
    expect(v.perLeg[0].verdict).toBe('valid');
    // The stamp keeps the RECORD's platformId (condition_id), not the token id.
    expect(v.perLeg[0].platformId).toBe('0xCONDITION');
  });

  it('Polymarket UNVERIFIED token (loader returns empty) ⟹ rest-unavailable, NEVER guesses', async () => {
    let fetched = false;
    mockFetch(() => {
      fetched = true;
      return { bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] };
    });
    const market: StampClusterMarket = {
      marketId: 9,
      platform: 'polymarket',
      platformId: '0xCONDITION',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 9, platform: 'polymarket', platformId: '0xCONDITION', side: 'YES' },
    ];
    const tokenMapLoader = async () => new Map();
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500, tokenMapLoader });
    expect(v.perLeg[0].verdict).toBe('rest-unavailable');
    expect(fetched).toBe(false); // no fetch with an unresolved token
  });

  it('throwing token-map loader ⟹ well-formed stamp, PM legs unavailable (never throws)', async () => {
    mockFetch(() => ({ bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }] }));
    const market: StampClusterMarket = {
      marketId: 9,
      platform: 'polymarket',
      platformId: '0xCONDITION',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 9, platform: 'polymarket', platformId: '0xCONDITION', side: 'YES' },
    ];
    const tokenMapLoader = async () => {
      throw new Error('DB down');
    };
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500, tokenMapLoader });
    expect(v.perLeg[0].verdict).toBe('rest-unavailable');
    expect(v.allValid).toBe(false);
  });

  it('fetch failure (non-2xx) ⟹ rest-unavailable', async () => {
    mockFetch(() => null); // 404 for everything
    const market: StampClusterMarket = {
      marketId: 1,
      platform: 'limitless',
      platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null },
      noBook: null,
    };
    const legs: StampLeg[] = [
      { marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'YES' },
    ];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500 });
    expect(v.perLeg[0].verdict).toBe('rest-unavailable');
  });

  // restFetcher seam (run the REST GET on the I/O worker).
  // When CLOB_IO_THREAD is on, run.ts injects the IoHost's worker-side fetcher so
  // the HTTP GET happens off the solver thread. These verify the GLUE: the injected
  // fetcher is used INSTEAD of the in-process fetchRestBook, it receives the
  // already-resolved platform-native ref (incl. the PM token round-trip), and a
  // null/thrown result degrades cleanly — the info-only never-throw contract holds.

  it('injected restFetcher is used instead of in-process fetch; drives the verdict', async () => {
    // Global fetch would 404 everything; if the seam works it is never consulted.
    let globalFetchHit = false;
    mockFetch(() => { globalFetchHit = true; return null; });
    const seen: Array<{ platform: string; id: string }> = [];
    const restFetcher = async (ref: { platform: string; id: string }) => {
      seen.push({ platform: ref.platform, id: ref.id });
      return { bestBid: 0.40, bestAsk: 0.42, bidLevels: [[0.40, 100]] as Array<[number, number]>, askLevels: [[0.42, 100]] as Array<[number, number]> };
    };
    const market: StampClusterMarket = {
      marketId: 1, platform: 'limitless', platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null }, noBook: null,
    };
    const legs: StampLeg[] = [{ marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'YES' }];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500, restFetcher });
    expect(v.perLeg[0].verdict).toBe('valid');
    expect(seen).toEqual([{ platform: 'limitless', id: 'slug-x' }]);
    expect(globalFetchHit).toBe(false); // routed away from the in-process path
  });

  it('injected restFetcher receives the RESOLVED PM token id (round-trip still happens host-side)', async () => {
    const seen: Array<{ platform: string; id: string }> = [];
    const restFetcher = async (ref: { platform: string; id: string }) => {
      seen.push({ platform: ref.platform, id: ref.id });
      return { bestBid: 0.40, bestAsk: 0.42, bidLevels: [[0.40, 100]] as Array<[number, number]>, askLevels: [[0.42, 100]] as Array<[number, number]> };
    };
    const market: StampClusterMarket = {
      marketId: 9, platform: 'polymarket', platformId: '0xCONDITION',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null }, noBook: null,
    };
    const legs: StampLeg[] = [{ marketId: 9, platform: 'polymarket', platformId: '0xCONDITION', side: 'YES' }];
    const tokenMapLoader = async () =>
      new Map([['0xCONDITION', { yesTokenId: 'YESTOK', noTokenId: 'NOTOK', outcomes: ['Yes', 'No'] as [string, string] }]]);
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500, tokenMapLoader, restFetcher });
    // The worker fetcher gets the TOKEN id, not the condition_id (host resolves it).
    expect(seen).toEqual([{ platform: 'polymarket', id: 'YESTOK' }]);
    expect(v.perLeg[0].verdict).toBe('valid');
    expect(v.perLeg[0].platformId).toBe('0xCONDITION'); // record keeps condition_id
  });

  it('injected restFetcher returning null ⟹ rest-unavailable (worker-death degrade path)', async () => {
    const restFetcher = async () => null; // mirrors IoHost.fetchRestBook on a dead worker
    const market: StampClusterMarket = {
      marketId: 1, platform: 'limitless', platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null }, noBook: null,
    };
    const legs: StampLeg[] = [{ marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'YES' }];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500, restFetcher });
    expect(v.perLeg[0].verdict).toBe('rest-unavailable');
    expect(v.allValid).toBe(false);
  });

  it('injected restFetcher that throws ⟹ that leg unavailable, stamp still well-formed', async () => {
    const restFetcher = async () => { throw new Error('worker RPC boom'); };
    const market: StampClusterMarket = {
      marketId: 1, platform: 'limitless', platformId: 'slug-x',
      yesBook: { bestBid: 0.40, bestAsk: 0.42, staleSince: null }, noBook: null,
    };
    const legs: StampLeg[] = [{ marketId: 1, platform: 'limitless', platformId: 'slug-x', side: 'YES' }];
    const v = await buildRestValidation({ legs, clusterMarkets: [market], budgetMs: 1500, restFetcher });
    expect(v.perLeg[0].verdict).toBe('rest-unavailable');
  });

  it('worstVerdict picks the most severe across legs', () => {
    const legs: RestLegCheck[] = [
      { marketId: 1, platform: 'kalshi', platformId: 'a', side: 'YES', wssBestBid: 0, wssBestAsk: 0, restBestBid: null, restBestAsk: null, deltaBps: null, verdict: 'valid' },
      { marketId: 2, platform: 'kalshi', platformId: 'b', side: 'YES', wssBestBid: 0, wssBestAsk: 0, restBestBid: null, restBestAsk: null, deltaBps: null, verdict: 'mismatch' },
      { marketId: 3, platform: 'kalshi', platformId: 'c', side: 'YES', wssBestBid: 0, wssBestAsk: 0, restBestBid: null, restBestAsk: null, deltaBps: null, verdict: 'stale' },
    ];
    expect(worstVerdict(legs)).toBe('mismatch');
    expect(worstVerdict([])).toBe('valid');
  });
});
