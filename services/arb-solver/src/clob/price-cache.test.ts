import { describe, test, expect } from 'bun:test';
import { PriceCache, PLACEHOLDER_ASK_FLOOR } from './price-cache.js';

const upd = (marketId: number, timestamp: number) => ({
  marketId, platform: 'kalshi' as const,
  bestBid: 0.4, bestAsk: 0.5, bidSize: 100, askSize: 100, timestamp,
});

/** A both-sides-empty placeholder frame (adapters emit bid=0 / ask=2.0 for an empty
 *  book). Overridable so we can probe the exact-floor / jitter cases. */
const placeholder = (marketId: number, timestamp: number, over: Partial<{ bestBid: number; bestAsk: number; bidSize: number; askSize: number }> = {}) => ({
  marketId, platform: 'kalshi' as const,
  bestBid: 0, bestAsk: 2.0, bidSize: 0, askSize: 0, timestamp, ...over,
});

describe('PriceCache quote-age TTL', () => {
  test('no TTL by default: an arbitrarily old quote stays live', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    expect(c.get(1, 10_000_000)?.bestAsk).toBe(0.5);
  });

  test('within TTL → live; past TTL → sentinel (excluded from LP)', () => {
    const c = new PriceCache();
    c.setTtl(60_000);
    c.update(upd(1, 1000));
    expect(c.get(1, 1000 + 30_000)?.bestAsk).toBe(0.5);   // fresh
    const stale = c.get(1, 1000 + 120_000);               // aged out
    expect(stale?.bestAsk).toBe(2.0);
    expect(stale?.bestBid).toBe(0);
  });

  test('setTtl(0) / non-finite disables the TTL', () => {
    const c = new PriceCache();
    c.setTtl(0);
    c.update(upd(1, 1000));
    expect(c.get(1, 10_000_000)?.bestAsk).toBe(0.5);
    c.setTtl(Infinity);
    expect(c.get(1, 10_000_000)?.bestAsk).toBe(0.5);
  });

  test('an explicit disconnect still wins regardless of TTL', () => {
    const c = new PriceCache();
    c.setTtl(60_000);
    c.update(upd(1, 1000));
    c.markStaleByIds([1]);
    expect(c.get(1, 1000)?.bestAsk).toBe(2.0); // sentinel even though "fresh"
  });
});

describe('PriceCache TOB-age TTL (frozen-but-fresh top-of-book)', () => {
  test('a book re-pushing an UNCHANGED tob past tobTtl → sentinel (excluded)', () => {
    const c = new PriceCache();
    c.setTobTtl(300_000);
    c.update(upd(1, 1000));                  // first quote: tob stamped @1000
    // Feed keeps re-pushing the identical tob — lastUpdate advances every frame
    // but lastTobChangeMs stays at 1000 (frozen tob).
    c.update(upd(1, 100_000));
    c.update(upd(1, 250_000));
    expect(c.get(1, 250_000)?.bestAsk).toBe(0.5);             // still within tobTtl
    const frozen = c.get(1, 1000 + 300_001);                 // tob unmoved past tobTtl
    expect(frozen?.bestAsk).toBe(2.0);
    expect(frozen?.bestBid).toBe(0);
  });

  test('a book whose tob keeps MOVING stays live past tobTtl', () => {
    const c = new PriceCache();
    c.setTobTtl(300_000);
    c.update(upd(1, 1000));
    // tob actually moves each frame → lastTobChangeMs keeps refreshing.
    c.update({ ...upd(1, 200_000), bestAsk: 0.51 });
    c.update({ ...upd(1, 500_000), bestAsk: 0.52 });
    // 500_000 is >300k past the FIRST quote, but the tob moved at 500_000, so the
    // tob-age clock is fresh.
    expect(c.get(1, 500_000 + 100_000)?.bestAsk).toBe(0.52);
  });

  test('tobTtl Infinity (default) ⟹ never aged by tob-age (back-compat)', () => {
    const c = new PriceCache();
    // No setTobTtl call (default Infinity); only a frozen, ancient tob.
    c.update(upd(1, 1000));
    c.update(upd(1, 50_000)); // re-push, tob frozen @1000
    expect(c.get(1, 10_000_000)?.bestAsk).toBe(0.5);
    // Explicit 0 / non-finite also disables it.
    c.setTobTtl(0);
    expect(c.get(1, 10_000_000)?.bestAsk).toBe(0.5);
    c.setTobTtl(Infinity);
    expect(c.get(1, 10_000_000)?.bestAsk).toBe(0.5);
  });

  test('a level-1 LADDER move does NOT refresh the tob-age clock', () => {
    const c = new PriceCache();
    c.setTobTtl(300_000);
    // tob frozen @1000; only the SECOND ask level churns on later frames.
    c.update({ ...upd(1, 1000), askLevels: [[0.50, 100], [0.51, 200]] });
    c.update({ ...upd(1, 200_000), askLevels: [[0.50, 100], [0.51, 999]] });
    // The depth delta advanced lastUpdate but NOT lastTobChangeMs (still 1000).
    const frozen = c.get(1, 1000 + 300_001);
    expect(frozen?.bestAsk).toBe(2.0);
  });

  test('quote-age TTL and TOB-age TTL coexist (either ages a book out)', () => {
    const c = new PriceCache();
    c.setTtl(60_000);       // quote-age: ages on lastUpdate
    c.setTobTtl(300_000);   // tob-age: ages on lastTobChangeMs
    c.update(upd(1, 1000));
    // Re-push within quote TTL but keep tob frozen → only tob-age can fire.
    c.update(upd(1, 50_000));
    expect(c.get(1, 80_000)?.bestAsk).toBe(0.5);  // fresh on both (last frame @50k)
    // No frame after 50k: by 50k+60k the quote-age TTL alone ages it out.
    expect(c.get(1, 50_000 + 60_001)?.bestAsk).toBe(2.0);
  });
});

describe('PriceCache.update topOfBookChanged (CDC trigger)', () => {
  test('returns true on first update of an unseen market', () => {
    const c = new PriceCache();
    expect(c.update(upd(1, 1000))).toBe(true);
  });

  test('returns true on first real quote of a tracked (sentinel) market', () => {
    const c = new PriceCache();
    c.track(1); // sentinel: bid 0 / ask 2 / lastUpdate 0
    expect(c.update(upd(1, 1000))).toBe(true);
  });

  test('returns false when the same top-of-book is re-sent', () => {
    const c = new PriceCache();
    expect(c.update(upd(1, 1000))).toBe(true);   // first
    // identical bid/ask/sizes, only the timestamp advances
    expect(c.update(upd(1, 2000))).toBe(false);
  });

  test('returns true on a bestBid change', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    expect(c.update({ ...upd(1, 2000), bestBid: 0.41 })).toBe(true);
  });

  test('returns true on a bestAsk change', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    expect(c.update({ ...upd(1, 2000), bestAsk: 0.51 })).toBe(true);
  });

  test('returns true on a bidSize change (depth-only, same prices)', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    expect(c.update({ ...upd(1, 2000), bidSize: 250 })).toBe(true);
  });

  test('returns true on an askSize change', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    expect(c.update({ ...upd(1, 2000), askSize: 250 })).toBe(true);
  });

  test('still overwrites snapshot + refreshes lastUpdate even when unchanged', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    expect(c.update(upd(1, 5000))).toBe(false); // no TOB change
    // lastUpdate advanced despite the no-op return
    expect(c.get(1)?.lastUpdate).toBe(5000);
  });

  test('a re-sent quote after a change is detected as unchanged again', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    expect(c.update({ ...upd(1, 2000), bestAsk: 0.6 })).toBe(true);  // moved
    expect(c.update({ ...upd(1, 3000), bestAsk: 0.6 })).toBe(false); // settled
  });
});

// Dead-book admission gate (placeholder refusal)

describe('PriceCache dead-book admission gate (placeholder refusal)', () => {
  test('PLACEHOLDER_ASK_FLOOR sits between a real quote (≤1) and the 2.0 sentinel', () => {
    expect(PLACEHOLDER_ASK_FLOOR).toBe(1.5);
    expect(PLACEHOLDER_ASK_FLOOR).toBeGreaterThan(1.0);
    expect(PLACEHOLDER_ASK_FLOOR).toBeLessThan(2.0);
  });

  test('a placeholder frame on an unseen market is NOT admitted as live (no CDC, stays dead)', () => {
    const c = new PriceCache();
    // A placeholder frame must never be treated as live — it would wake the cluster for nothing.
    expect(c.update(placeholder(1, 1000))).toBe(false);
    // Read back: still the bid=0/ask=2.0 sentinel, never-quoted (lastUpdate 0).
    const s = c.get(1, 5000)!;
    expect(s.bestAsk).toBe(2.0);
    expect(s.bestBid).toBe(0);
    expect(s.lastUpdate).toBe(0);
    // Never enters the persisted live set.
    expect(c.getLiveSnapshots()).toHaveLength(0);
  });

  test('a placeholder on a tracked (sentinel) market stays dead + returns false', () => {
    const c = new PriceCache();
    c.track(1);
    expect(c.update(placeholder(1, 1000))).toBe(false);
    expect(c.get(1, 5000)?.lastUpdate).toBe(0);
  });

  test('a jittery placeholder (ask ≥ floor, e.g. 1.8) is still refused', () => {
    const c = new PriceCache();
    expect(c.update(placeholder(1, 1000, { bestAsk: 1.8 }))).toBe(false);
    expect(c.getLiveSnapshots()).toHaveLength(0);
  });

  test('repeated placeholders never churn the CDC (all return false)', () => {
    const c = new PriceCache();
    expect(c.update(placeholder(1, 1000))).toBe(false);
    expect(c.update(placeholder(1, 2000, { bestAsk: 1.9 }))).toBe(false); // jitter
    expect(c.update(placeholder(1, 3000, { askSize: 0 }))).toBe(false);
  });

  test('a one-sided LIVE-BID book (bid>0, ask=2.0) is NOT a placeholder — admitted normally', () => {
    const c = new PriceCache();
    // Kalshi no-NO-bids / Predict no-asks: real bid, adapter-synthesized ask 2.0.
    expect(c.update({ ...upd(1, 1000), bestBid: 0.4, bestAsk: 2.0, askSize: 0 })).toBe(true);
    const s = c.get(1, 1000)!;
    expect(s.bestBid).toBe(0.4);
    expect(s.lastUpdate).toBe(1000); // admitted as a live quote (synthetic NO usable)
    expect(c.getLiveSnapshots()).toHaveLength(1);
  });

  test('a one-sided ASK-only book (bid=0, ask≤1) is NOT a placeholder — admitted normally', () => {
    const c = new PriceCache();
    expect(c.update({ ...upd(1, 1000), bestBid: 0, bestAsk: 0.5 })).toBe(true);
    expect(c.get(1, 1000)?.bestAsk).toBe(0.5); // real YES-buyable ask survives
  });

  test('a REAL live book that goes placeholder is marked stale + re-solves (conservative)', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000)); // real bid .4 / ask .5
    // Liquidity pulled — must NOT keep pricing the old quote: stale it + wake the cluster.
    expect(c.update(placeholder(1, 2000))).toBe(true);
    const s = c.get(1, 2000)!;
    expect(s.bestAsk).toBe(2.0);
    expect(s.bestBid).toBe(0);
    expect(s.staleSince).not.toBeNull(); // dead via staleSince ⟹ excluded from Ω
    expect(c.getLiveSnapshots()).toHaveLength(0); // no longer persisted as live
  });

  test('the NO-side placeholder routes to the NO book and never clobbers YES', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000)); // YES live
    expect(c.update({ ...placeholder(1, 2000), outcome: 'no' as const })).toBe(false);
    expect(c.get(1, 2000)?.bestAsk).toBe(0.5); // YES untouched
    // NO side is a never-admitted placeholder ⟹ getNo returns the dead sentinel.
    expect(c.getNo(1, 2000)?.bestAsk).toBe(2.0);
    expect(c.getNo(1, 2000)?.lastUpdate).toBe(0);
  });
});

// Two-sided books: (marketId, outcome) re-key via the NO-side slot

const noUpd = (marketId: number, timestamp: number) => ({
  marketId, platform: 'polymarket' as const, outcome: 'no' as const,
  bestBid: 0.42, bestAsk: 0.57, bidSize: 50, askSize: 60, timestamp,
});

describe('PriceCache NO-side book (two-sided re-key)', () => {
  test("an outcome:'no' update never clobbers the YES snapshot", () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));      // YES book: bid .4 / ask .5
    c.update(noUpd(1, 2000));    // NO book:  bid .42 / ask .57
    expect(c.get(1)?.bestAsk).toBe(0.5);    // YES untouched
    expect(c.getNo(1)?.bestAsk).toBe(0.57); // NO routed separately
  });

  test("an outcome:'yes' / untagged update goes to the primary book only", () => {
    const c = new PriceCache();
    c.update({ ...upd(1, 1000), outcome: 'yes' as const });
    c.update(upd(2, 1000)); // untagged
    expect(c.get(1)?.bestAsk).toBe(0.5);
    expect(c.getNo(1)).toBeUndefined();
    expect(c.get(2)?.bestAsk).toBe(0.5);
    expect(c.getNo(2)).toBeUndefined();
  });

  test('getNo is undefined when no NO book was ever received', () => {
    const c = new PriceCache();
    c.track(1);
    c.update(upd(1, 1000));
    expect(c.getNo(1)).toBeUndefined();
  });

  test('CDC trigger is independent per side', () => {
    const c = new PriceCache();
    expect(c.update(upd(1, 1000))).toBe(true);      // first YES quote
    expect(c.update(noUpd(1, 1100))).toBe(true);    // first NO quote — counts
    expect(c.update(noUpd(1, 1200))).toBe(false);   // identical NO re-send
    expect(c.update({ ...noUpd(1, 1300), bestAsk: 0.58 })).toBe(true); // NO moved
    expect(c.update(upd(1, 1400))).toBe(false);     // YES unchanged all along
  });

  test('quote-age TTL applies to the NO side', () => {
    const c = new PriceCache();
    c.setTtl(60_000);
    c.update(noUpd(1, 1000));
    expect(c.getNo(1, 1000 + 30_000)?.bestAsk).toBe(0.57); // fresh
    const stale = c.getNo(1, 1000 + 120_000);               // aged out
    expect(stale?.bestAsk).toBe(2.0);
    expect(stale?.bestBid).toBe(0);
  });

  test('TOB-age TTL applies to the NO side (frozen NO book)', () => {
    const c = new PriceCache();
    c.setTobTtl(300_000);
    c.update(noUpd(1, 1000));
    c.update(noUpd(1, 250_000)); // re-push identical NO tob (frozen @1000)
    expect(c.getNo(1, 250_000)?.bestAsk).toBe(0.57);        // within tobTtl
    const frozen = c.getNo(1, 1000 + 300_001);              // tob unmoved past tobTtl
    expect(frozen?.bestAsk).toBe(2.0);
    expect(frozen?.bestBid).toBe(0);
  });

  test('markStaleByIds sentinels BOTH sides', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    c.update(noUpd(1, 1000));
    c.markStaleByIds([1]);
    expect(c.get(1)?.bestAsk).toBe(2.0);
    expect(c.getNo(1)?.bestAsk).toBe(2.0);
  });

  test('evict drops BOTH sides for markets outside the keep-set', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    c.update(noUpd(1, 1000));
    c.update(upd(2, 1000));
    c.evict(new Set([2]));
    expect(c.get(1)).toBeUndefined();
    expect(c.getNo(1)).toBeUndefined();
    expect(c.get(2)?.bestAsk).toBe(0.5);
  });

  test('getLiveSnapshots returns primary (YES) snapshots only', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    c.update(noUpd(1, 1000));
    const live = c.getLiveSnapshots();
    expect(live).toHaveLength(1);
    expect(live[0].bestAsk).toBe(0.5);
  });

  test('size counts tracked markets, not NO-side entries', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000));
    c.update(noUpd(1, 1000));
    expect(c.size).toBe(1);
  });
});

// Depth-aware book ladder (CLOB_BOOK_LADDER): level storage / routing / blank

describe('PriceCache depth ladder (askLevels / bidLevels)', () => {
  test('levels are stored on the primary (YES) snapshot when attached', () => {
    const c = new PriceCache();
    c.update({
      ...upd(1, 1000),
      askLevels: [[0.50, 100], [0.51, 200]],
      bidLevels: [[0.49, 150], [0.48, 80]],
    });
    const s = c.get(1, 1000)!;
    expect(s.askLevels).toEqual([[0.50, 100], [0.51, 200]]);
    expect(s.bidLevels).toEqual([[0.49, 150], [0.48, 80]]);
  });

  test('absent levels ⟹ undefined (today\'s behavior)', () => {
    const c = new PriceCache();
    c.update(upd(1, 1000)); // no levels attached
    const s = c.get(1, 1000)!;
    expect(s.askLevels).toBeUndefined();
    expect(s.bidLevels).toBeUndefined();
  });

  test('NO-token levels route to the NO book, never the YES book', () => {
    const c = new PriceCache();
    c.update({ ...upd(1, 1000), askLevels: [[0.50, 10]], bidLevels: [[0.49, 10]] });
    c.update({
      ...noUpd(1, 1000),
      askLevels: [[0.57, 60], [0.58, 40]],
      bidLevels: [[0.42, 50]],
    });
    // YES book keeps its own ladder.
    expect(c.get(1, 1000)!.askLevels).toEqual([[0.50, 10]]);
    // NO book has the routed ladder.
    expect(c.getNo(1, 1000)!.askLevels).toEqual([[0.57, 60], [0.58, 40]]);
    expect(c.getNo(1, 1000)!.bidLevels).toEqual([[0.42, 50]]);
  });

  test('stale read blanks the ladders alongside the sentinel prices', () => {
    const c = new PriceCache();
    c.update({ ...upd(1, 1000), askLevels: [[0.50, 100]], bidLevels: [[0.49, 100]] });
    c.markStaleByIds([1]);
    const s = c.get(1, 1000)!;
    expect(s.bestAsk).toBe(2.0);
    expect(s.askLevels).toBeUndefined();
    expect(s.bidLevels).toBeUndefined();
  });

  test('TTL aged-out read blanks the ladders too', () => {
    const c = new PriceCache();
    c.setTtl(60_000);
    c.update({ ...upd(1, 1000), askLevels: [[0.50, 100]], bidLevels: [[0.49, 100]] });
    const stale = c.get(1, 1000 + 120_000)!;
    expect(stale.bestAsk).toBe(2.0);
    expect(stale.askLevels).toBeUndefined();
    expect(stale.bidLevels).toBeUndefined();
  });

  test('a fresh read within TTL keeps the ladders', () => {
    const c = new PriceCache();
    c.setTtl(60_000);
    c.update({ ...upd(1, 1000), askLevels: [[0.50, 100]] });
    expect(c.get(1, 1000 + 30_000)!.askLevels).toEqual([[0.50, 100]]);
  });
});
