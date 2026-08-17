import { describe, it, expect } from 'bun:test';
import {
  compareBooks,
  restCrosscheckTolerance,
  type NormalizedRestBook,
  type WssBookRef,
} from './rest-crosscheck.js';

// Deterministic unit test of the INFO-ONLY compare logic. No network: we hand
// compareBooks an already-normalized REST book + a WSS snapshot and assert the
// verdict + deltaBps. The default tolerance is 0.02 ($) unless overridden.

const TOL = restCrosscheckTolerance();

function restBook(bestBid: number, bestAsk: number): NormalizedRestBook {
  return {
    bestBid,
    bestAsk,
    bidLevels: bestBid > 0 ? [[bestBid, 100]] : [],
    askLevels: bestAsk < 2.0 ? [[bestAsk, 100]] : [],
  };
}

describe('compareBooks (REST cross-check verdict)', () => {
  it('valid: REST ask matches the WSS ask the YES leg consumed (within tolerance)', () => {
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.42, staleSince: null };
    const r = compareBooks(wss, restBook(0.40, 0.42), 'ask');
    expect(r.verdict).toBe('valid');
    expect(r.deltaBps).toBe(0);
    expect(r.restBestAsk).toBe(0.42);
  });

  it('valid: a sub-tolerance ask drift is still valid (fast-market timing window)', () => {
    // |0.42 − 0.43| = 0.01 < 0.02 tolerance ⟹ valid, deltaBps > 0.
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.42, staleSince: null };
    const r = compareBooks(wss, restBook(0.41, 0.43), 'ask');
    expect(r.verdict).toBe('valid');
    expect(r.deltaBps).toBeGreaterThan(0);
  });

  it('mismatch: REST ask diverges beyond tolerance (the WSS price was phantom)', () => {
    // |0.42 − 0.55| = 0.13 ≫ 0.02 ⟹ mismatch.
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.42, staleSince: null };
    const r = compareBooks(wss, restBook(0.53, 0.55), 'ask');
    expect(r.verdict).toBe('mismatch');
    expect(r.deltaBps).not.toBeNull();
    expect(r.deltaBps!).toBeGreaterThan(2000); // ~0.13/0.55 ≈ 2360 bps
  });

  it('stale: WSS staleSince set ⟹ stale, no REST comparison needed (takes precedence)', () => {
    // Even with a perfectly-matching REST book, a stale WSS snapshot is flagged.
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.42, staleSince: Date.now() - 5000 };
    const r = compareBooks(wss, restBook(0.40, 0.42), 'ask');
    expect(r.verdict).toBe('stale');
    expect(r.deltaBps).toBeNull();
    // REST values still surfaced for context.
    expect(r.restBestAsk).toBe(0.42);
  });

  it('crossed: REST bestBid >= bestAsk ⟹ corrupt/locked book', () => {
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.42, staleSince: null };
    const r = compareBooks(wss, restBook(0.55, 0.50), 'ask');
    expect(r.verdict).toBe('crossed');
    expect(r.deltaBps).toBeNull();
  });

  it('rest-unavailable: null REST book (fetch failed / unmapped token / Limitless-NO)', () => {
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.42, staleSince: null };
    const r = compareBooks(wss, null, 'ask');
    expect(r.verdict).toBe('rest-unavailable');
    expect(r.deltaBps).toBeNull();
    expect(r.restBestBid).toBeNull();
    expect(r.restBestAsk).toBeNull();
  });

  it('rest-unavailable: REST shows no quote on the consumed side', () => {
    // YES leg consumes the ASK side, but REST has only a bid (ask = sentinel 2.0).
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.42, staleSince: null };
    const r = compareBooks(wss, restBook(0.40, 2.0), 'ask');
    expect(r.verdict).toBe('rest-unavailable');
  });

  it('bid side: a NO leg sells YES into the bid — compares the YES-bid side', () => {
    // valid match on the bid side.
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.42, staleSince: null };
    const valid = compareBooks(wss, restBook(0.40, 0.42), 'bid');
    expect(valid.verdict).toBe('valid');

    // mismatch on the bid side.
    const mismatch = compareBooks(wss, restBook(0.25, 0.42), 'bid');
    expect(mismatch.verdict).toBe('mismatch');
  });

  it('tolerance boundary: just inside TOL is valid, just outside is mismatch', () => {
    const wss: WssBookRef = { bestBid: 0.40, bestAsk: 0.50, staleSince: null };
    // diff a hair under TOL ⟹ valid (<=); a hair over ⟹ mismatch.
    const inside = compareBooks(wss, restBook(0.40, 0.50 + TOL * 0.9), 'ask');
    expect(inside.verdict).toBe('valid');
    const outside = compareBooks(wss, restBook(0.40, 0.50 + TOL * 1.5), 'ask');
    expect(outside.verdict).toBe('mismatch');
  });

  // The live feed derives a synthetic NO from the YES book (lp-builder.ts,
  // price-cache.getNo): NO_ask = 1 - YES_bid, NO_bid = 1 - YES_ask. The REST
  // cross-check must derive NO the same way, without any `1-x` arithmetic: a
  // synthetic-NO leg fetches the YES book and consumes the YES-bid side,
  // algebraically identical to comparing the same NO_ask on both WSS and
  // REST sides. These tests pin that equivalence so a future refactor can't
  // silently introduce a bid/ask inversion.
  describe('synthetic-NO derivation matches live-feed getNo', () => {
    /** The live feed's synthetic-NO TOB from a YES book (lp-builder/price-cache). */
    function feedSyntheticNo(yesBid: number, yesAsk: number): { noAsk: number; noBid: number } {
      return { noAsk: 1 - yesBid, noBid: 1 - yesAsk };
    }

    it('valid: REST YES-bid equals WSS YES-bid ⟹ derived NO_ask matches the feed', () => {
      // Sample YES book the solver priced off.
      const wssYesBid = 0.37, wssYesAsk = 0.39;
      const wss: WssBookRef = { bestBid: wssYesBid, bestAsk: wssYesAsk, staleSince: null };
      // The feed would have priced buy-NO at NO_ask = 1 − 0.37 = 0.63.
      const feed = feedSyntheticNo(wssYesBid, wssYesAsk);
      expect(feed.noAsk).toBeCloseTo(0.63, 10);

      // REST returns the SAME YES book ⟹ derived NO_ask = 1 − 0.37 = 0.63 too.
      // The cross-check consumes the YES-BID side; bid-vs-bid match ⟺ NO_ask match.
      const r = compareBooks(wss, restBook(wssYesBid, wssYesAsk), 'bid');
      expect(r.verdict).toBe('valid');
      expect(r.deltaBps).toBe(0);
      // The derived NO_ask the cross-check implicitly confirmed equals the feed's.
      const restDerivedNoAsk = 1 - r.restBestBid!;
      expect(restDerivedNoAsk).toBeCloseTo(feed.noAsk, 10);
    });

    it('mismatch: a shifted REST YES-bid ⟹ derived NO_ask diverges past tolerance', () => {
      const wss: WssBookRef = { bestBid: 0.37, bestAsk: 0.39, staleSince: null };
      // REST YES-bid 0.20 ⟹ derived NO_ask 0.80 vs feed NO_ask 0.63: 0.17 ≫ TOL.
      const r = compareBooks(wss, restBook(0.20, 0.39), 'bid');
      expect(r.verdict).toBe('mismatch');
      const restDerivedNoAsk = 1 - r.restBestBid!;
      const feedNoAsk = 1 - wss.bestBid;
      expect(Math.abs(restDerivedNoAsk - feedNoAsk)).toBeGreaterThan(TOL);
    });

    it('the bid-vs-bid compare never inverts: a sub-tolerance YES-bid drift stays valid', () => {
      // |0.37 − 0.36| = 0.01 < TOL on the YES-bid ⟹ derived NO_ask drift 0.01 < TOL.
      const wss: WssBookRef = { bestBid: 0.37, bestAsk: 0.39, staleSince: null };
      const r = compareBooks(wss, restBook(0.36, 0.39), 'bid');
      expect(r.verdict).toBe('valid');
      expect(r.deltaBps!).toBeGreaterThan(0);
    });
  });
});
