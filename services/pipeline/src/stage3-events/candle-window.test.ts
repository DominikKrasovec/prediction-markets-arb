/**
 * Tests for the deterministic crypto candle-window parser. The (asset, open,
 * duration) key is what lets the Stage-3b matcher confirm candle pairs without
 * the LLM — so the parser must be exact about duration and strict about which
 * "Up or Down" titles are crypto candles at all.
 */
import { describe, test, expect } from 'bun:test';
import { parseCandleWindow, parseCandleAsset } from './candle-window.js';

describe('parseCandleAsset', () => {
  test('crypto names + tickers → canonical ticker', () => {
    expect(parseCandleAsset('Bitcoin Up or Down - May 14, 1PM ET')).toBe('BTC');
    expect(parseCandleAsset('BTC Up or Down - 5 Min')).toBe('BTC');
    expect(parseCandleAsset('Ethereum Up or Down on May 10?')).toBe('ETH');
    expect(parseCandleAsset('SOL Up or Down - 1 hour')).toBe('SOL');
    expect(parseCandleAsset('Dogecoin Up or Down - May 13, 7:30PM-7:35PM ET')).toBe('DOGE');
  });

  test('non-crypto / multi-word subjects → null', () => {
    expect(parseCandleAsset('S&P 500 (SPX) Up or Down on May 14?')).toBeNull();
    expect(parseCandleAsset('FTSE 100 (UKX) Up or Down on May 11?')).toBeNull();
    expect(parseCandleAsset('Trump approval Up or Down this week?')).toBeNull();
    expect(parseCandleAsset('Rolex Submariner 41 Date Up or Down: May')).toBeNull();
  });
});

describe('parseCandleWindow', () => {
  test('5-min explicit range (unambiguous)', () => {
    expect(parseCandleWindow('Bitcoin Up or Down - May 14, 10:30AM-10:35AM ET'))
      .toEqual({ asset: 'BTC', durationMin: 5, ambiguous: false });
  });

  test('15-min explicit range', () => {
    expect(parseCandleWindow('Solana Up or Down - May 14, 4:00AM-4:15AM ET'))
      .toEqual({ asset: 'SOL', durationMin: 15, ambiguous: false });
  });

  test('range wrapping midnight', () => {
    expect(parseCandleWindow('Bitcoin Up or Down - May 14, 11:55PM-12:00AM ET'))
      .toEqual({ asset: 'BTC', durationMin: 5, ambiguous: false });
  });

  test('single hour, no range → hourly (60m) but AMBIGUOUS', () => {
    expect(parseCandleWindow('XRP Up or Down - May 14, 5AM ET'))
      .toEqual({ asset: 'XRP', durationMin: 60, ambiguous: true });
    expect(parseCandleWindow('Bitcoin Up or Down - May 13, 7PM ET'))
      .toEqual({ asset: 'BTC', durationMin: 60, ambiguous: true });
  });

  test('limitless duration suffixes (unambiguous)', () => {
    expect(parseCandleWindow('BTC Up or Down - 5 Min')).toEqual({ asset: 'BTC', durationMin: 5, ambiguous: false });
    expect(parseCandleWindow('DOGE Up or Down - 1 hour')).toEqual({ asset: 'DOGE', durationMin: 60, ambiguous: false });
    expect(parseCandleWindow('BTC Up or Down - Daily')).toEqual({ asset: 'BTC', durationMin: 1440, ambiguous: false });
    expect(parseCandleWindow('SUI Up or Down - 1 day')).toEqual({ asset: 'SUI', durationMin: 1440, ambiguous: false });
  });

  test('daily "on May DD?" form', () => {
    expect(parseCandleWindow('Ethereum Up or Down on May 10?'))
      .toEqual({ asset: 'ETH', durationMin: 1440, ambiguous: false });
  });

  test('5-min vs 15-min same asset → distinct durations (the key discriminator)', () => {
    const a = parseCandleWindow('Bitcoin Up or Down - May 14, 2:00PM-2:05PM ET');
    const b = parseCandleWindow('Bitcoin Up or Down - May 14, 2:00PM-2:15PM ET');
    expect(a).toEqual({ asset: 'BTC', durationMin: 5, ambiguous: false });
    expect(b).toEqual({ asset: 'BTC', durationMin: 15, ambiguous: false });
    expect(a!.durationMin).not.toBe(b!.durationMin);
  });

  test('non-crypto candles → null', () => {
    expect(parseCandleWindow('S&P 500 (SPX) Up or Down on May 14?')).toBeNull();
    expect(parseCandleWindow('Trump approval Up or Down this week?')).toBeNull();
  });
});

describe('Kalshi KX{ASSET}15M native candle titles (2026-07-12)', () => {
  test('"<ASSET> price up in next 15 mins?" → {asset, 15, unambiguous}', () => {
    expect(parseCandleWindow('ETH price up in next 15 mins?')).toEqual({ asset: 'ETH', durationMin: 15, ambiguous: false });
    expect(parseCandleWindow('BTC price up in next 15 mins?')).toEqual({ asset: 'BTC', durationMin: 15, ambiguous: false });
    expect(parseCandleWindow('NEAR price up in next 15 mins?')).toEqual({ asset: 'NEAR', durationMin: 15, ambiguous: false });
    expect(parseCandleWindow('ZEC price up in next 15 mins?')).toEqual({ asset: 'ZEC', durationMin: 15, ambiguous: false });
    expect(parseCandleWindow('HYPE price up in next 15 mins?')).toEqual({ asset: 'HYPE', durationMin: 15, ambiguous: false });
  });

  test('all nine live 15M assets resolve', () => {
    for (const a of ['SOL', 'HYPE', 'DOGE', 'BTC', 'ZEC', 'BNB', 'XRP', 'NEAR', 'ETH']) {
      expect(parseCandleWindow(`${a} price up in next 15 mins?`)).toEqual({ asset: a, durationMin: 15, ambiguous: false });
    }
  });

  test('window comes from the title, not a supplied windowMin (never ambiguous)', () => {
    // Even a garbage windowMin cannot change a title-explicit 15-min window.
    expect(parseCandleWindow('ETH price up in next 15 mins?', 1500)).toEqual({ asset: 'ETH', durationMin: 15, ambiguous: false });
  });

  test('forward-compatible durations (5 / 60) parse from the title', () => {
    expect(parseCandleWindow('BTC price up in next 5 mins?')).toEqual({ asset: 'BTC', durationMin: 5, ambiguous: false });
    expect(parseCandleWindow('BTC price up in next 60 mins?')).toEqual({ asset: 'BTC', durationMin: 60, ambiguous: false });
  });

  test('unknown asset in the Kalshi shape → null (no false candle identity)', () => {
    expect(parseCandleWindow('TSLA price up in next 15 mins?')).toBeNull();
  });

  test('a Kalshi 15M asset must NOT match cross-window (5m ≠ 15m discriminator holds)', () => {
    const k = parseCandleWindow('ETH price up in next 15 mins?');
    const poly5 = parseCandleWindow('Ethereum Up or Down - May 14, 4:00AM-4:05AM ET');
    expect(k!.durationMin).toBe(15);
    expect(poly5!.durationMin).toBe(5);
    expect(k!.durationMin).not.toBe(poly5!.durationMin);
  });
});

describe('parseCandleWindow with gated windowMin (M-MATCH-4)', () => {
  const SINGLE_HOUR = 'XRP Up or Down - May 14, 5AM ET';

  test('U1 single-hour + windowMin=60 -> {60, ambiguous:false}', () => {
    expect(parseCandleWindow(SINGLE_HOUR, 60)).toEqual({ asset: 'XRP', durationMin: 60, ambiguous: false });
  });

  test('U2 single-hour + windowMin=5 -> {5, ambiguous:false} (window overrides hourly default)', () => {
    expect(parseCandleWindow(SINGLE_HOUR, 5)).toEqual({ asset: 'XRP', durationMin: 5, ambiguous: false });
  });

  test('U3 single-hour + windowMin=1500 (garbage, non-snap) -> {60, ambiguous:true} fallback', () => {
    expect(parseCandleWindow(SINGLE_HOUR, 1500)).toEqual({ asset: 'XRP', durationMin: 60, ambiguous: true });
  });

  test('U4 single-hour + windowMin=-1020 (predict negative) -> {60, ambiguous:true} fallback', () => {
    expect(parseCandleWindow(SINGLE_HOUR, -1020)).toEqual({ asset: 'XRP', durationMin: 60, ambiguous: true });
  });

  test('U5 single-hour + window undefined -> {60, ambiguous:true} (back-compat, old signature)', () => {
    expect(parseCandleWindow(SINGLE_HOUR)).toEqual({ asset: 'XRP', durationMin: 60, ambiguous: true });
    expect(parseCandleWindow(SINGLE_HOUR, undefined)).toEqual({ asset: 'XRP', durationMin: 60, ambiguous: true });
  });

  test('U6 explicit-range title IGNORES windowMin (branch order unchanged)', () => {
    // a 5-min range stays 5 even if a 60-min window is supplied
    expect(parseCandleWindow('Bitcoin Up or Down - May 14, 2:00PM-2:05PM ET', 60))
      .toEqual({ asset: 'BTC', durationMin: 5, ambiguous: false });
    // a limitless suffix stays its parsed value
    expect(parseCandleWindow('BTC Up or Down - 15 Min', 60))
      .toEqual({ asset: 'BTC', durationMin: 15, ambiguous: false });
  });

  test('30/240/1440/10080 snap; 7 (non-whitelisted) does not', () => {
    expect(parseCandleWindow(SINGLE_HOUR, 30)).toEqual({ asset: 'XRP', durationMin: 30, ambiguous: false });
    expect(parseCandleWindow(SINGLE_HOUR, 240)).toEqual({ asset: 'XRP', durationMin: 240, ambiguous: false });
    expect(parseCandleWindow(SINGLE_HOUR, 1440)).toEqual({ asset: 'XRP', durationMin: 1440, ambiguous: false });
    expect(parseCandleWindow(SINGLE_HOUR, 7)).toEqual({ asset: 'XRP', durationMin: 60, ambiguous: true });
  });
});
