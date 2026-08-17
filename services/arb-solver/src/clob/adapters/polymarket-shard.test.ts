import { describe, test, expect } from 'bun:test';
import type { MarketSubscription } from '../price-cache.js';
import { expandTwoSidedSubscriptions, type TokenOutcomePair } from '../token-map.js';
import { PolymarketAdapter } from './polymarket.js';

/**
 * Two-sided books × connection sharding.
 *
 * The manager expands verified markets into 2 asset_ids BEFORE the adapter sees
 * the list, so the `POLYMARKET_SHARD_SIZE` cap applies per token id and the
 * doubled count partitions into ⌈2N/shardSize⌉ shards. These tests use
 * `subscribe()` WITHOUT `start()` — shard placement happens in
 * `assignAssetToShard`, but `connect()` early-returns while `running` is false,
 * so no socket is ever opened.
 */

function tokenSubs(markets: number, twoSided: boolean): MarketSubscription[] {
  const map = new Map<string, TokenOutcomePair>();
  const subs: MarketSubscription[] = [];
  for (let i = 0; i < markets; i++) {
    const cid = `0xcond${i}`;
    map.set(cid, { yesTokenId: `yes-tok-${i}`, noTokenId: `no-tok-${i}`, outcomes: ['Yes', 'No'] });
    subs.push({ marketId: i + 1, platform: 'polymarket', platformId: cid });
  }
  return expandTwoSidedSubscriptions(subs, twoSided ? map : new Map());
}

describe('PolymarketAdapter sharding × two-sided expansion', () => {
  test('one-sided: 6 markets → 6 asset_ids → ⌈6/4⌉ = 2 shards', async () => {
    process.env.POLYMARKET_SHARD_SIZE = '4';
    try {
      const adapter = new PolymarketAdapter();
      const subs = tokenSubs(6, false);
      expect(subs).toHaveLength(6);
      await adapter.subscribe(subs);
      expect(adapter.shardCount).toBe(2);
    } finally {
      delete process.env.POLYMARKET_SHARD_SIZE;
    }
  });

  test('two-sided: 6 markets → 12 asset_ids → ⌈12/4⌉ = 3 shards (cap applies per token)', async () => {
    process.env.POLYMARKET_SHARD_SIZE = '4';
    try {
      const adapter = new PolymarketAdapter();
      const subs = tokenSubs(6, true);
      expect(subs).toHaveLength(12); // every market doubled
      await adapter.subscribe(subs);
      expect(adapter.shardCount).toBe(3);
    } finally {
      delete process.env.POLYMARKET_SHARD_SIZE;
    }
  });

  test('default shard size (800) shards a doubled mid-size universe into ⌈1000/800⌉ = 2 shards', async () => {
    // PM's code=1006 drop is a probabilistic cliff past a subscription-count
    // threshold; DEFAULT_SHARD_SIZE sits in the proven-zero-death zone. So
    // 500 two-sided markets = 1,000 asset_ids → ⌈1000/800⌉ = 2 shards.
    delete process.env.POLYMARKET_SHARD_SIZE;
    const adapter = new PolymarketAdapter();
    await adapter.subscribe(tokenSubs(500, true)); // 1,000 asset_ids
    expect(adapter.shardCount).toBe(2);
  });

  test('unsubscribing a market frees both of its token slots', async () => {
    process.env.POLYMARKET_SHARD_SIZE = '4';
    try {
      const adapter = new PolymarketAdapter();
      const subs = tokenSubs(2, true); // 4 asset_ids → exactly 1 full shard
      await adapter.subscribe(subs);
      expect(adapter.shardCount).toBe(1);
      // Drop market 1's two tokens, then add a fresh two-sided market: both new
      // tokens fit the freed capacity — still one shard.
      await adapter.unsubscribe(['yes-tok-0', 'no-tok-0']);
      await adapter.subscribe([
        { marketId: 9, platform: 'polymarket', platformId: 'yes-tok-9', outcome: 'yes' },
        { marketId: 9, platform: 'polymarket', platformId: 'no-tok-9', outcome: 'no' },
      ]);
      expect(adapter.shardCount).toBe(1);
    } finally {
      delete process.env.POLYMARKET_SHARD_SIZE;
    }
  });
});
