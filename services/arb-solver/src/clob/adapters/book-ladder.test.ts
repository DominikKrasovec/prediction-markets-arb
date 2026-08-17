import { describe, test, expect, afterEach } from 'bun:test';
import { PolymarketAdapter } from './polymarket.js';
import { KalshiAdapter } from './kalshi.js';
import type { MarketSubscription, PriceUpdate } from '../price-cache.js';

/**
 * DEPTH-AWARE book ladder emission (CLOB_BOOK_LADDER=1).
 *
 * The adapters attach `askLevels` (ascending by price, best/cheapest first) and
 * `bidLevels` (descending, best first) to each emitted update, capped to
 * `CLOB_MAX_LADDER_LEVELS`. With the flag OFF they attach nothing (byte-identical
 * to today). Internals are reached via `as any` (TS `private` is compile-time).
 */

afterEach(() => {
  delete process.env.CLOB_BOOK_LADDER;
  delete process.env.CLOB_MAX_LADDER_LEVELS;
});

/** Drive a PM book snapshot through the adapter and capture the emitted update. */
function pmEmit(assetId: string, marketId: number, bids: [string, number][], asks: [string, number][]): PriceUpdate {
  const a = new PolymarketAdapter();
  const sub: MarketSubscription = { marketId, platform: 'polymarket', platformId: assetId };
  (a as any).subscriptions.set(assetId, sub);
  let captured: PriceUpdate | undefined;
  a.onPriceUpdate((u) => { captured = u; });
  (a as any).handleBook({
    asset_id: assetId,
    bids: bids.map(([price, size]) => ({ price, size: String(size) })),
    asks: asks.map(([price, size]) => ({ price, size: String(size) })),
  });
  return captured!;
}

/** Drive a Kalshi orderbook snapshot through the adapter and capture the emit. */
function kalshiEmit(ticker: string, marketId: number, yesBids: [string, number][], noBids: [string, number][]): PriceUpdate {
  const a = new KalshiAdapter();
  const sub: MarketSubscription = { marketId, platform: 'kalshi', platformId: ticker };
  (a as any).subscriptions.set(ticker, sub);
  let captured: PriceUpdate | undefined;
  a.onPriceUpdate((u) => { captured = u; });
  (a as any).handleSnapshot({
    market_ticker: ticker,
    yes_dollars_fp: yesBids.map(([p, s]) => [p, String(s)]),
    no_dollars_fp: noBids.map(([p, s]) => [p, String(s)]),
  });
  return captured!;
}

describe('Polymarket ladder emission', () => {
  test('flag OFF: no levels attached (byte-identical)', () => {
    const u = pmEmit('tok-1', 1, [['0.49', 100], ['0.48', 50]], [['0.50', 80], ['0.51', 40]]);
    expect(u.askLevels).toBeUndefined();
    expect(u.bidLevels).toBeUndefined();
    // top-of-book still emitted exactly as before
    expect(u.bestAsk).toBeCloseTo(0.50, 9);
    expect(u.bestBid).toBeCloseTo(0.49, 9);
  });

  test('flag ON: asks ascending, bids descending, with sizes', () => {
    process.env.CLOB_BOOK_LADDER = '1';
    // Intentionally out-of-order maps to prove the sort.
    const u = pmEmit('tok-1', 1, [['0.48', 50], ['0.49', 100], ['0.47', 30]], [['0.52', 40], ['0.50', 80], ['0.51', 60]]);
    expect(u.askLevels).toEqual([[0.50, 80], [0.51, 60], [0.52, 40]]); // ascending price
    expect(u.bidLevels).toEqual([[0.49, 100], [0.48, 50], [0.47, 30]]); // descending price
    // best still matches level 0 of each ladder
    expect(u.bestAsk).toBeCloseTo(u.askLevels![0][0], 9);
    expect(u.bestBid).toBeCloseTo(u.bidLevels![0][0], 9);
  });

  test('flag ON: levels capped to CLOB_MAX_LADDER_LEVELS', () => {
    process.env.CLOB_BOOK_LADDER = '1';
    process.env.CLOB_MAX_LADDER_LEVELS = '2';
    const asks: [string, number][] = [['0.50', 1], ['0.51', 1], ['0.52', 1], ['0.53', 1]];
    const u = pmEmit('tok-1', 1, [['0.49', 1]], asks);
    expect(u.askLevels).toEqual([[0.50, 1], [0.51, 1]]); // only the 2 cheapest
  });
});

describe('Kalshi ladder emission', () => {
  test('flag OFF: no levels attached', () => {
    const u = kalshiEmit('KXT-1', 1, [['0.49', 100]], [['0.48', 80]]);
    expect(u.askLevels).toBeUndefined();
    expect(u.bidLevels).toBeUndefined();
  });

  test('flag ON: bidLevels from YES bids (desc); askLevels = 1 − noBid (asc)', () => {
    process.env.CLOB_BOOK_LADDER = '1';
    // YES bids: 0.45 (best), 0.44, 0.43. NO bids: 0.40, 0.42 (best) → YES asks:
    // 1−0.40=0.60, 1−0.42=0.58 → ascending [0.58, 0.60].
    const u = kalshiEmit('KXT-1', 1, [['0.44', 200], ['0.45', 100], ['0.43', 300]], [['0.40', 70], ['0.42', 50]]);
    expect(u.bidLevels).toEqual([[0.45, 100], [0.44, 200], [0.43, 300]]); // YES bid desc
    // YES ask ladder, ascending, carrying the NO bid's size at that level.
    expect(u.askLevels![0][0]).toBeCloseTo(0.58, 9);
    expect(u.askLevels![0][1]).toBe(50);   // size from the noBid 0.42 level
    expect(u.askLevels![1][0]).toBeCloseTo(0.60, 9);
    expect(u.askLevels![1][1]).toBe(70);   // size from the noBid 0.40 level
    // The synthetic YES-ask top matches the legacy bestAsk = 1 − best NO bid.
    expect(u.bestAsk).toBeCloseTo(u.askLevels![0][0], 9);
  });

  test('flag ON: levels capped', () => {
    process.env.CLOB_BOOK_LADDER = '1';
    process.env.CLOB_MAX_LADDER_LEVELS = '1';
    const u = kalshiEmit('KXT-1', 1, [['0.45', 1], ['0.44', 1]], [['0.40', 1], ['0.41', 1]]);
    expect(u.bidLevels).toHaveLength(1);
    expect(u.askLevels).toHaveLength(1);
    expect(u.bidLevels![0][0]).toBeCloseTo(0.45, 9);   // best YES bid
    expect(u.askLevels![0][0]).toBeCloseTo(0.59, 9);   // 1 − best NO bid (0.41)
  });
});
