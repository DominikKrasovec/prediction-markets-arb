/**
 * candleIdentityMatch — the pure candle identity decision. The DB loop in
 * match-candles.ts only fetches facts and applies the verdict, so every
 * rule is testable here with no database.
 *
 * The class this exists to kill: three venues can list a "BTC 5-minute Up
 * or Down" candle with a byte-identical window (same asset, same open, same
 * duration) but settle on three different Chainlink streams, one of which
 * splits an exact tie 50-50 while the others resolve it Up. Merging them
 * produces an "arb" that is really oracle divergence, not a real one.
 */
import { describe, test, expect } from 'bun:test';
import {
  candleIdentityMatch, CANDLE_SETTLEMENT_REQUIRED_MAX_MIN,
  type CandleIdentityLeg,
} from './match-candles.js';

const OPEN = '2026-07-11T02:15:00Z';
const PM = 'chainlink:btc-usd|tie:up';
const PREDICT = 'chainlink:btc-usdt-topofbook|tie:5050';
const BINANCE = 'binance|tie:up';

function leg(over: Partial<CandleIdentityLeg> = {}): CandleIdentityLeg {
  return { asset: 'BTC', durationMin: 5, ambiguous: false, open: OPEN, settlement: PM, ...over };
}

describe('candleIdentityMatch — window half (behaviour preserved)', () => {
  test('same asset + duration + open + settlement → match', () => {
    expect(candleIdentityMatch(leg(), leg()).verdict).toBe('match');
  });

  test('different asset is a confident skip even when a side is duration-ambiguous', () => {
    const v = candleIdentityMatch(leg({ asset: 'ETH' }), leg({ ambiguous: true }));
    expect(v.verdict).toBe('skip');
    expect(v.verdict === 'skip' && v.reason).toContain('window mismatch');
  });

  test('two KNOWN opens that differ is a confident skip + candle_open_mismatch belt', () => {
    const v = candleIdentityMatch(leg(), leg({ open: '2026-07-11T02:20:00Z' }));
    expect(v.verdict).toBe('skip');
    expect(v.verdict === 'skip' && v.belt).toBe('candle_open_mismatch');
  });

  test('opens within 60s are the same open (rounding tolerance)', () => {
    expect(candleIdentityMatch(leg(), leg({ open: '2026-07-11T02:15:45Z' })).verdict).toBe('match');
  });

  test('ambiguous duration with a COMPATIBLE open defers to the LLM', () => {
    const v = candleIdentityMatch(leg({ durationMin: 60, ambiguous: true }), leg({ durationMin: 5 }));
    expect(v.verdict).toBe('defer');
  });

  test('P2: an ambiguous defer with an UNKNOWN open flags candle_open_mismatch', () => {
    const v = candleIdentityMatch(
      leg({ durationMin: 60, ambiguous: true, open: null }),
      leg({ durationMin: 5 }),
    );
    expect(v.verdict).toBe('defer');
    expect(v.verdict === 'defer' && v.belt).toBe('candle_open_mismatch');
  });
});

describe('candleIdentityMatch — P1 settlement half', () => {
  test('IDENTICAL window but DIFFERENT oracle stream → deterministic SKIP', () => {
    const v = candleIdentityMatch(leg({ settlement: PM }), leg({ settlement: PREDICT }));
    expect(v.verdict).toBe('skip');
    expect(v.verdict === 'skip' && v.belt).toBe('candle_oracle_mismatch');
    expect(v.verdict === 'skip' && v.reason).toContain('settlement mismatch');
  });

  test('same oracle, DIFFERENT tie rule → skip (a tie world both legs can pay)', () => {
    const v = candleIdentityMatch(
      leg({ settlement: 'binance|tie:up' }), leg({ settlement: 'binance|tie:5050' }),
    );
    expect(v.verdict).toBe('skip');
    expect(v.verdict === 'skip' && v.belt).toBe('candle_oracle_mismatch');
  });

  test('a known incompatibility is never DEFERRED — the fact is structured and proven', () => {
    // even with an ambiguous duration on one side, the settlement decides.
    const v = candleIdentityMatch(leg({ ambiguous: true }), leg({ settlement: PREDICT }));
    expect(v.verdict).toBe('skip');
  });

  test('intraday (<=60m) with an UNKNOWN settlement on one side → SKIP, not defer', () => {
    for (const dur of [5, 15, 30, CANDLE_SETTLEMENT_REQUIRED_MAX_MIN]) {
      const v = candleIdentityMatch(
        leg({ durationMin: dur, settlement: null }), leg({ durationMin: dur }),
      );
      expect(v.verdict).toBe('skip');
      expect(v.verdict === 'skip' && v.belt).toBe('candle_oracle_mismatch');
    }
  });

  test('daily/weekly with an UNKNOWN settlement stays DEFERRED for the LLM', () => {
    for (const dur of [1440, 10080]) {
      const v = candleIdentityMatch(
        leg({ durationMin: dur, settlement: null }), leg({ durationMin: dur }),
      );
      expect(v.verdict).toBe('defer');
    }
  });

  test('REGRESSION WATCH — the 7 sound daily candles share one Binance token and still merge', () => {
    const v = candleIdentityMatch(
      leg({ durationMin: 1440, settlement: BINANCE }),
      leg({ durationMin: 1440, settlement: BINANCE }),
    );
    expect(v.verdict).toBe('match');
  });

  test('a window mismatch keeps its OWN reason (settlement is checked second)', () => {
    const v = candleIdentityMatch(leg({ settlement: PM }), leg({ asset: 'ETH', settlement: PREDICT }));
    expect(v.verdict === 'skip' && v.reason).toContain('window mismatch');
  });
});
