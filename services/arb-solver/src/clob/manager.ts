import type { Platform } from '@arb/types';
import type { ClobAdapter, ResolutionEvent } from './adapters/base.js';
import type { PriceUpdate, MarketSubscription } from './price-cache.js';
import type { InstrEvent } from './geo-compare/instrumentation.js';
import type { PolymarketTokenMapLoader } from './token-map.js';
import {
  loadVerifiedPolymarketTokenMap,
  expandTwoSidedSubscriptions,
} from './token-map.js';
import { PolymarketAdapter } from './adapters/polymarket.js';
import { PredictAdapter } from './adapters/predict.js';
import { KalshiAdapter } from './adapters/kalshi.js';
import { LimitlessAdapter } from './adapters/limitless.js';
import { createLogger } from '@arb/logger';

const log = createLogger('clob:manager');

/** Construction seams — all optional; the no-arg constructor uses the real
 *  adapters and the DB-backed loader, with two-sided expansion unconditional. */
export interface ClobManagerOptions {
  /** Test seam: replaces the four real platform adapters. */
  adapters?: ClobAdapter[];
  /** Test seam: condition_id → verified token pair loader (default DB-backed). */
  tokenMapLoader?: PolymarketTokenMapLoader;
}

/**
 * Manages all 4 CLOB adapters. Groups markets by platform,
 * routes price updates to a single callback.
 *
 * Two-sided books (unconditional): subscription lists arriving from the
 * solver are keyed one-per-market with
 * `platformId = markets.platform_id`. The manager always expands
 * each VERIFIED Polymarket market into two token-level subscriptions
 * (clobTokenIds[0] → outcome:'yes', clobTokenIds[1] → outcome:'no') before
 * handing them to the adapter — see token-map.ts for the mapping assert.
 * `trackedMarkets` therefore stores ALL subscriptions per marketId so that
 * unsubscribe paths drop both tokens. Callers that already pass token-level
 * subs (geo-compare manifests carry an `outcome` tag) are never re-expanded.
 *
 * Shard interaction: expansion happens BEFORE the adapter sees the list, so
 * the Polymarket adapter's connection sharding (`POLYMARKET_SHARD_SIZE`,
 * default 10k asset_ids/conn) naturally partitions the doubled id count into
 * ⌈2N/shardSize⌉ connections — no shard-size change needed, the cap applies
 * per token id exactly as it does for the geo/perf harnesses. The YES and NO
 * tokens of one market may land on different shards; their books are
 * independent, so that is harmless.
 */
export class ClobManager {
  private adapters = new Map<Platform, ClobAdapter>();
  private callbacks: Array<(update: PriceUpdate) => void> = [];
  private resolutionCallbacks: Array<(event: ResolutionEvent) => void> = [];
  private instrCallbacks: Array<(e: InstrEvent) => void> = [];
  /** Connection-staleness sinks: fired with the marketIds whose adapter shard
   *  just dropped, so the solver can sentinel those books until they
   *  re-snapshot (markStale-on-disconnect). */
  private staleCallbacks: Array<(marketIds: number[]) => void> = [];
  /** marketId → ALL live subscriptions for that market (1 normally; 2 for a
   *  two-sided-expanded Polymarket market: YES token + NO token). */
  private trackedMarkets = new Map<number, MarketSubscription[]>();
  private readonly tokenMapLoader: PolymarketTokenMapLoader;

  constructor(opts: ClobManagerOptions = {}) {
    this.tokenMapLoader = opts.tokenMapLoader ?? loadVerifiedPolymarketTokenMap;
    const adapters: ClobAdapter[] = opts.adapters ?? [
      new PolymarketAdapter(),
      new PredictAdapter(),
      new LimitlessAdapter(),
      new KalshiAdapter(),
    ];
    for (const a of adapters) {
      a.onPriceUpdate((update) => this.handleUpdate(update));
      a.onMarketResolved((event) => this.handleResolution(event));
      a.onInstrumentation((e) => this.handleInstr(e));
      a.onConnectionStale((platformIds) => this.handleStale(platformIds));
      this.adapters.set(a.platform, a);
    }
  }

  onPriceUpdate(cb: (update: PriceUpdate) => void): void {
    this.callbacks.push(cb);
  }

  onMarketResolved(cb: (event: ResolutionEvent) => void): void {
    this.resolutionCallbacks.push(cb);
  }

  /** Register a geo-compare instrumentation sink. Fanned out across all
   *  adapters; adapters emit nothing unless at least one sink is registered. */
  onInstrumentation(cb: (e: InstrEvent) => void): void {
    this.instrCallbacks.push(cb);
  }

  /** Register a connection-staleness sink. Fired (with marketIds) when an
   *  adapter shard's socket drops, so the caller can sentinel those books in the
   *  price cache until they re-snapshot. */
  onConnectionStale(cb: (marketIds: number[]) => void): void {
    this.staleCallbacks.push(cb);
  }

  private handleUpdate(update: PriceUpdate): void {
    for (const cb of this.callbacks) {
      cb(update);
    }
  }

  private handleResolution(event: ResolutionEvent): void {
    for (const cb of this.resolutionCallbacks) {
      cb(event);
    }
  }

  private handleInstr(e: InstrEvent): void {
    for (const cb of this.instrCallbacks) {
      cb(e);
    }
  }

  /**
   * Map a dropped shard's platform-native ids → marketIds and fan them to the
   * staleness sinks. The reverse index is built on demand from `trackedMarkets`
   * (a market may carry >1 sub — YES + NO tokens of a two-sided Polymarket
   * market — all sharing one marketId); disconnects are rare relative to price
   * updates, so an on-demand scan is cheap and avoids a parallel index that
   * could drift from `trackedMarkets`. A market is sentinelled once even if
   * several of its tokens were on the dropped shard.
   */
  private handleStale(platformIds: string[]): void {
    if (this.staleCallbacks.length === 0 || platformIds.length === 0) return;
    const rev = new Map<string, number>();
    for (const subs of this.trackedMarkets.values()) {
      for (const s of subs) rev.set(s.platformId, s.marketId);
    }
    const marketIds = new Set<number>();
    for (const pid of platformIds) {
      const mid = rev.get(pid);
      if (mid !== undefined) marketIds.add(mid);
    }
    if (marketIds.size === 0) return;
    const ids = [...marketIds];
    for (const cb of this.staleCallbacks) cb(ids);
  }

  /**
   * Two-sided expansion step (unconditional; no-op identity when no
   * condition_id-keyed Polymarket subs are present, or when the token-map load
   * fails — the conservative direction is always "keep the one-sided sub").
   */
  private async expand(markets: MarketSubscription[]): Promise<MarketSubscription[]> {
    const candidates = markets.filter(
      (m) => m.platform === 'polymarket' && m.outcome === undefined,
    );
    if (candidates.length === 0) return markets;

    let tokenMap: Awaited<ReturnType<PolymarketTokenMapLoader>>;
    try {
      tokenMap = await this.tokenMapLoader(candidates.map((c) => c.platformId));
    } catch (err) {
      log.error('two-sided token-map load failed — keeping one-sided subscriptions:', err);
      return markets;
    }
    const expanded = expandTwoSidedSubscriptions(markets, tokenMap);
    const hits = candidates.filter((c) => tokenMap.has(c.platformId)).length;
    log.info(
      `two-sided books: ${hits}/${candidates.length} Polymarket markets expanded ` +
      `to YES+NO token subscriptions (${candidates.length - hits} unverified → synthetic NO)`,
    );
    return expanded;
  }

  /** Record expanded subscriptions in the per-market tracking map. */
  private trackSubs(subs: MarketSubscription[]): void {
    for (const m of subs) {
      const arr = this.trackedMarkets.get(m.marketId);
      if (arr) arr.push(m);
      else this.trackedMarkets.set(m.marketId, [m]);
    }
  }

  async startTracking(markets: MarketSubscription[]): Promise<void> {
    const expanded = await this.expand(markets);
    this.trackedMarkets.clear();
    this.trackSubs(expanded);

    const byPlatform = groupByPlatform(expanded);

    const results = await Promise.allSettled(
      [...byPlatform.entries()].map(([platform, subs]) => {
        const adapter = this.adapters.get(platform);
        if (!adapter) return Promise.resolve();
        return adapter.start(subs);
      })
    );

    for (const r of results) {
      if (r.status === 'rejected') {
        log.error('Adapter start failed:', r.reason);
      }
    }

    log.info(
      `Tracking ${this.trackedMarkets.size} markets ` +
      `(${expanded.length} subscriptions) across ${byPlatform.size} platforms`
    );
  }

  async updateSubscriptions(newMarkets: MarketSubscription[]): Promise<void> {
    const newSet = new Set(newMarkets.map(m => m.marketId));
    const oldSet = new Set(this.trackedMarkets.keys());

    // Markets to add (diffed at market level — expansion happens after).
    const toAdd = newMarkets.filter(m => !oldSet.has(m.marketId));
    // Markets to remove: every stored subscription of each dropped marketId
    // (both tokens of a two-sided Polymarket market).
    const removeIds = [...oldSet].filter(id => !newSet.has(id));

    if (removeIds.length > 0) {
      const toRemove = removeIds.flatMap(id => this.trackedMarkets.get(id) ?? []);
      const removeByPlatform = groupByPlatform(toRemove);
      for (const [platform, subs] of removeByPlatform) {
        const adapter = this.adapters.get(platform);
        if (adapter) {
          await adapter.unsubscribe(subs.map(s => s.platformId));
        }
      }
      for (const id of removeIds) this.trackedMarkets.delete(id);
    }

    if (toAdd.length > 0) {
      const expanded = await this.expand(toAdd);
      const addByPlatform = groupByPlatform(expanded);
      for (const [platform, subs] of addByPlatform) {
        const adapter = this.adapters.get(platform);
        if (adapter) {
          await adapter.subscribe(subs);
        }
      }
      this.trackSubs(expanded);
    }

    if (toAdd.length + removeIds.length > 0) {
      log.info(
        `Subscription update: +${new Set(toAdd.map(m => m.marketId)).size} ` +
        `-${removeIds.length} (total: ${this.trackedMarkets.size})`
      );
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
    this.trackedMarkets.clear();
    log.info('All adapters stopped');
  }

  /** Unsubscribe a single resolved market from its platform adapter and remove
   *  it from the tracked set so no further price updates are processed. Drops
   *  EVERY subscription for the market (both tokens when two-sided). */
  async unsubscribeMarket(marketId: number): Promise<void> {
    const subs = this.trackedMarkets.get(marketId);
    if (!subs || subs.length === 0) return;
    const adapter = this.adapters.get(subs[0].platform);
    if (adapter) {
      await adapter.unsubscribe(subs.map(s => s.platformId));
    }
    this.trackedMarkets.delete(marketId);
  }
}

function groupByPlatform(markets: MarketSubscription[]): Map<Platform, MarketSubscription[]> {
  const map = new Map<Platform, MarketSubscription[]>();
  for (const m of markets) {
    let arr = map.get(m.platform);
    if (!arr) {
      arr = [];
      map.set(m.platform, arr);
    }
    arr.push(m);
  }
  return map;
}
