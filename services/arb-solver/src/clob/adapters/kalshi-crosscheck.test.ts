import { describe, it, expect } from 'bun:test';
import { KalshiAdapter } from './kalshi.js';
import type { MarketSubscription } from '../price-cache.js';

// Deterministic test of the REST cross-check fallback: mock fetchRestOrderbook so
// there's no network/feed timing, seed a known reconstructed book, and assert the
// detect → re-anchor behavior. Internals are reached via `as any` (TS `private`
// is compile-time only).

const TICKER = 'KXTEST-1';
function adapterWith(restYes: [string, number][], restNo: [string, number][]) {
  const a = new KalshiAdapter();
  const sub: MarketSubscription = { marketId: 1, platform: 'kalshi', platformId: TICKER } as MarketSubscription;
  (a as any).subscriptions.set(TICKER, sub);
  // mock the authoritative REST snapshot
  (a as any).fetchRestOrderbook = async () => ({ yes: new Map(restYes), no: new Map(restNo) });
  return a;
}

describe('Kalshi REST cross-check', () => {
  it('re-anchors an EMPTY reconstructed book (the field-name-bug signature)', async () => {
    const a = adapterWith([['0.50', 100], ['0.49', 200]], [['0.48', 80]]);
    (a as any).yesBids.set(TICKER, new Map()); // simulate the empty-book bug
    (a as any).noBids.set(TICKER, new Map());

    await (a as any).crossCheckTicker(TICKER);

    const s = a.getCrossCheckStats();
    expect(s.divergent).toBe(1);
    expect(s.reanchored).toBe(1);
    // book repopulated from REST
    expect((a as any).yesBids.get(TICKER).get('0.50')).toBe(100);
    expect((a as any).noBids.get(TICKER).get('0.48')).toBe(80);
  });

  it('does NOT flag a book that matches REST', async () => {
    const a = adapterWith([['0.50', 100]], [['0.48', 80]]);
    (a as any).yesBids.set(TICKER, new Map([['0.50', 100]]));
    (a as any).noBids.set(TICKER, new Map([['0.48', 80]]));

    await (a as any).crossCheckTicker(TICKER);

    const s = a.getCrossCheckStats();
    expect(s.ok).toBe(1);
    expect(s.divergent).toBe(0);
  });

  it('tolerates a small (sub-threshold) best difference — fast-market timing', async () => {
    // REST best YES bid 0.50, ours 0.49 → 0.01 gap < 0.15 tolerance ⟹ OK
    const a = adapterWith([['0.50', 100]], [['0.48', 80]]);
    (a as any).yesBids.set(TICKER, new Map([['0.49', 100]]));
    (a as any).noBids.set(TICKER, new Map([['0.48', 80]]));

    await (a as any).crossCheckTicker(TICKER);

    expect(a.getCrossCheckStats().divergent).toBe(0);
  });

  it('flags a GROSS divergence and re-anchors', async () => {
    // ours best YES bid 0.10 vs REST 0.50 → 0.40 gap > tolerance
    const a = adapterWith([['0.50', 100]], [['0.48', 80]]);
    (a as any).yesBids.set(TICKER, new Map([['0.10', 100]]));
    (a as any).noBids.set(TICKER, new Map([['0.48', 80]]));

    await (a as any).crossCheckTicker(TICKER);

    const s = a.getCrossCheckStats();
    expect(s.divergent).toBe(1);
    expect(s.reanchored).toBe(1);
    expect((a as any).yesBids.get(TICKER).get('0.50')).toBe(100);
  });

  it('skips (no false positive) when REST shows no liquidity on a side', async () => {
    // REST yes empty (no quote) ⟹ that side is not compared even if ours differs
    const a = adapterWith([], [['0.48', 80]]);
    (a as any).yesBids.set(TICKER, new Map([['0.90', 100]]));
    (a as any).noBids.set(TICKER, new Map([['0.48', 80]]));

    await (a as any).crossCheckTicker(TICKER);

    expect(a.getCrossCheckStats().divergent).toBe(0);
  });
});
