import { describe, it, expect } from 'bun:test';
import { orderBookSummaryHash, verifySelfHash } from './polymarket-hash.js';

// Golden vector — canonical OrderBookSummary hash, computed independently via
// node crypto over the documented field order. Locks the algorithm (field
// order + last_trade_price inclusion) against regressions.
const VEC = {
  market: '0xabc',
  asset_id: '123',
  timestamp: '1700000000000',
  bids: [
    { price: '0.40', size: '100' },
    { price: '0.39', size: '250' },
  ],
  asks: [{ price: '0.42', size: '80' }],
  min_order_size: '5',
  tick_size: '0.01',
  neg_risk: false,
  last_trade_price: '0.41',
};
const GOLDEN = '9e36a80d6f9f45b1caf4c1b045e622c6a1ec4839';

describe('orderBookSummaryHash', () => {
  it('reproduces the golden vector', () => {
    expect(orderBookSummaryHash(VEC)).toBe(GOLDEN);
  });

  it('is sensitive to last_trade_price (the classic mismatch field)', () => {
    expect(orderBookSummaryHash({ ...VEC, last_trade_price: '0.99' })).not.toBe(GOLDEN);
  });

  it('is sensitive to neg_risk', () => {
    expect(orderBookSummaryHash({ ...VEC, neg_risk: true })).not.toBe(GOLDEN);
  });

  it('is sensitive to min_order_size (WS-omitted static field)', () => {
    expect(orderBookSummaryHash({ ...VEC, min_order_size: '1' })).not.toBe(GOLDEN);
  });

  it('is sensitive to bid/ask level order', () => {
    expect(
      orderBookSummaryHash({ ...VEC, bids: [VEC.bids[1], VEC.bids[0]] }),
    ).not.toBe(GOLDEN);
  });

  it('ignores key order of the input object (only field VALUES matter)', () => {
    // Same data, keys supplied in a different order — canonical order is imposed
    // internally, so the hash is unchanged.
    const shuffled = {
      last_trade_price: VEC.last_trade_price,
      asks: VEC.asks,
      asset_id: VEC.asset_id,
      neg_risk: VEC.neg_risk,
      market: VEC.market,
      tick_size: VEC.tick_size,
      bids: VEC.bids,
      timestamp: VEC.timestamp,
      min_order_size: VEC.min_order_size,
    };
    expect(orderBookSummaryHash(shuffled)).toBe(GOLDEN);
  });
});

describe('verifySelfHash', () => {
  it('returns true for a frame whose hash matches', () => {
    expect(verifySelfHash({ ...VEC, hash: GOLDEN })).toBe(true);
  });

  it('returns false for a frame whose hash does not match', () => {
    expect(verifySelfHash({ ...VEC, hash: 'deadbeef' })).toBe(false);
  });

  it('returns null when no string hash is present', () => {
    expect(verifySelfHash({ ...VEC })).toBeNull();
    expect(verifySelfHash({ ...VEC, hash: undefined })).toBeNull();
  });
});
