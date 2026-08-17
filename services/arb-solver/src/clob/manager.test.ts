import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import { ClobManager } from './manager.js';
import type { ClobAdapter, ResolutionEvent } from './adapters/base.js';
import type { MarketSubscription, PriceUpdate } from './price-cache.js';
import type { InstrEvent } from './geo-compare/instrumentation.js';
import type { TokenOutcomePair, PolymarketTokenMapLoader } from './token-map.js';

/** Records every call; never opens a socket. */
class FakeAdapter implements ClobAdapter {
  started: MarketSubscription[][] = [];
  subscribed: MarketSubscription[][] = [];
  unsubscribed: string[][] = [];
  constructor(readonly platform: Platform) {}
  async start(markets: MarketSubscription[]): Promise<void> {
    this.started.push(markets);
  }
  async subscribe(markets: MarketSubscription[]): Promise<void> {
    this.subscribed.push(markets);
  }
  async unsubscribe(marketIds: string[]): Promise<void> {
    this.unsubscribed.push(marketIds);
  }
  async stop(): Promise<void> {}
  onPriceUpdate(_cb: (u: PriceUpdate) => void): void {}
  onMarketResolved(_cb: (e: ResolutionEvent) => void): void {}
  onInstrumentation(_cb: (e: InstrEvent) => void): void {}
  /** Captured staleness sink + a hook to simulate a shard socket dropping. */
  private staleCb: ((platformIds: string[]) => void) | null = null;
  onConnectionStale(cb: (platformIds: string[]) => void): void {
    this.staleCb = cb;
  }
  fireStale(platformIds: string[]): void {
    this.staleCb?.(platformIds);
  }
}

const PAIR_A: TokenOutcomePair = { yesTokenId: 'yesA', noTokenId: 'noA', outcomes: ['Yes', 'No'] };
const PAIR_B: TokenOutcomePair = { yesTokenId: 'yesB', noTokenId: 'noB', outcomes: ['Up', 'Down'] };

function makeManager(opts: {
  map?: Map<string, TokenOutcomePair>;
  loaderCalls?: string[][];
  loaderThrows?: boolean;
} = {}) {
  const pm = new FakeAdapter('polymarket');
  const kalshi = new FakeAdapter('kalshi');
  const loader: PolymarketTokenMapLoader = async (ids) => {
    opts.loaderCalls?.push(ids);
    if (opts.loaderThrows) throw new Error('db down');
    return opts.map ?? new Map();
  };
  const manager = new ClobManager({
    adapters: [pm, kalshi],
    tokenMapLoader: loader,
  });
  return { manager, pm, kalshi };
}

const sub = (
  marketId: number,
  platform: Platform,
  platformId: string,
  outcome?: 'yes' | 'no',
): MarketSubscription => ({ marketId, platform, platformId, outcome });

describe('ClobManager connection-staleness (markStale-on-disconnect)', () => {
  test('a dropped shard\'s platformIds map to the right marketIds (one event per market)', async () => {
    // Two-sided PM market 1 (yesA/noA) + a kalshi market 2 (TICK).
    const { manager, pm, kalshi } = makeManager({
      map: new Map([['0xaaa', PAIR_A]]),
    });
    const staleFired: number[][] = [];
    manager.onConnectionStale((ids) => staleFired.push([...ids].sort((a, b) => a - b)));
    await manager.startTracking([sub(1, 'polymarket', '0xaaa'), sub(2, 'kalshi', 'TICK')]);

    // PM shard drops carrying BOTH tokens of market 1 → ONE stale event for [1].
    pm.fireStale(['yesA', 'noA']);
    expect(staleFired).toEqual([[1]]);

    // Kalshi shard drops carrying TICK → market 2.
    kalshi.fireStale(['TICK']);
    expect(staleFired).toEqual([[1], [2]]);
  });

  test('unknown / untracked platformIds map to nothing (no event)', async () => {
    const { manager, pm } = makeManager();
    const staleFired: number[][] = [];
    manager.onConnectionStale((ids) => staleFired.push(ids));
    await manager.startTracking([sub(1, 'polymarket', '0xaaa')]);
    pm.fireStale(['some-other-token']);
    expect(staleFired).toHaveLength(0);
  });
});

describe('ClobManager two-sided expansion (unconditional — flag removed)', () => {
  // Expansion has no opt-in: there is no `twoSidedBooks` option and no
  // `CLOB_TWO_SIDED_BOOKS` env var. A manager built the production way
  // (adapters + loader, nothing else) always expands a verified PM market.
  test('expansion is unconditional: a default-shaped manager expands a verified PM market', async () => {
    const pm = new FakeAdapter('polymarket');
    const loader: PolymarketTokenMapLoader = async () => new Map([['0xaaa', PAIR_A]]);
    const manager = new ClobManager({ adapters: [pm], tokenMapLoader: loader });
    await manager.startTracking([sub(1, 'polymarket', '0xaaa')]);
    expect(pm.started[0]).toEqual([
      sub(1, 'polymarket', 'yesA', 'yes'),
      sub(1, 'polymarket', 'noA', 'no'),
    ]);
  });

  // The token-map loader is always consulted for untagged PM subs, even when the map is empty.
  test('loader is always consulted for untagged PM subs (even when the map is empty)', async () => {
    const loaderCalls: string[][] = [];
    const { manager } = makeManager({ map: new Map(), loaderCalls });
    await manager.startTracking([sub(1, 'polymarket', '0xaaa')]);
    expect(loaderCalls).toEqual([['0xaaa']]);
  });

  test('verified PM market → YES+NO token subs handed to the adapter', async () => {
    const loaderCalls: string[][] = [];
    const { manager, pm } = makeManager({
      map: new Map([['0xaaa', PAIR_A]]),
      loaderCalls,
    });
    await manager.startTracking([sub(1, 'polymarket', '0xaaa')]);
    expect(loaderCalls).toEqual([['0xaaa']]);
    expect(pm.started[0]).toEqual([
      sub(1, 'polymarket', 'yesA', 'yes'),
      sub(1, 'polymarket', 'noA', 'no'),
    ]);
  });

  test('unverified PM market keeps its one-sided condition_id sub', async () => {
    const { manager, pm } = makeManager({ map: new Map() });
    await manager.startTracking([sub(1, 'polymarket', '0xunknown')]);
    expect(pm.started[0]).toEqual([sub(1, 'polymarket', '0xunknown')]);
  });

  test('non-PM platforms are not expanded and not sent to the loader', async () => {
    const loaderCalls: string[][] = [];
    const { manager, kalshi } = makeManager({
      map: new Map([['0xaaa', PAIR_A]]),
      loaderCalls,
    });
    await manager.startTracking([sub(1, 'polymarket', '0xaaa'), sub(2, 'kalshi', 'TICK')]);
    expect(loaderCalls).toEqual([['0xaaa']]); // kalshi id NOT consulted
    expect(kalshi.started[0]).toEqual([sub(2, 'kalshi', 'TICK')]);
  });

  test('already-token-level subs (outcome tagged) are not re-expanded; loader not called', async () => {
    const loaderCalls: string[][] = [];
    const { manager, pm } = makeManager({ loaderCalls });
    const tagged = [sub(1, 'polymarket', 'yesA', 'yes'), sub(1, 'polymarket', 'noA', 'no')];
    await manager.startTracking(tagged);
    expect(loaderCalls).toHaveLength(0);
    expect(pm.started[0]).toEqual(tagged);
  });

  test('loader failure falls back to one-sided subs (conservative)', async () => {
    const { manager, pm } = makeManager({ loaderThrows: true });
    await manager.startTracking([sub(1, 'polymarket', '0xaaa')]);
    expect(pm.started[0]).toEqual([sub(1, 'polymarket', '0xaaa')]);
  });

  test('unsubscribeMarket drops BOTH token subscriptions', async () => {
    const { manager, pm } = makeManager({
      map: new Map([['0xaaa', PAIR_A]]),
    });
    await manager.startTracking([sub(1, 'polymarket', '0xaaa')]);
    await manager.unsubscribeMarket(1);
    expect(pm.unsubscribed[0]?.sort()).toEqual(['noA', 'yesA']);
  });

  test('updateSubscriptions: removed market unsubscribes both tokens; added market expands', async () => {
    const { manager, pm } = makeManager({
      map: new Map([
        ['0xaaa', PAIR_A],
        ['0xbbb', PAIR_B],
      ]),
    });
    await manager.startTracking([sub(1, 'polymarket', '0xaaa')]);
    await manager.updateSubscriptions([sub(2, 'polymarket', '0xbbb')]);
    // market 1 removed → both its tokens unsubscribed
    expect(pm.unsubscribed[0]?.sort()).toEqual(['noA', 'yesA']);
    // market 2 added → expanded pair subscribed
    expect(pm.subscribed[0]).toEqual([
      sub(2, 'polymarket', 'yesB', 'yes'),
      sub(2, 'polymarket', 'noB', 'no'),
    ]);
  });

  test('updateSubscriptions with an unchanged set is a no-op', async () => {
    const { manager, pm } = makeManager({
      map: new Map([['0xaaa', PAIR_A]]),
    });
    await manager.startTracking([sub(1, 'polymarket', '0xaaa')]);
    await manager.updateSubscriptions([sub(1, 'polymarket', '0xaaa')]);
    expect(pm.subscribed).toHaveLength(0);
    expect(pm.unsubscribed).toHaveLength(0);
  });
});
