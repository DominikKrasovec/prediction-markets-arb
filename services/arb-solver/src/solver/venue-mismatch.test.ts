import { describe, it, expect } from 'bun:test';
import { computeVenueFlag } from './venue-mismatch.js';

describe('computeVenueFlag (cross-venue settlement risk, bughunt 2026-06-17 ③)', () => {
  it('single-venue basket → no mismatch', () => {
    const f = computeVenueFlag([
      { platform: 'kalshi' },
      { platform: 'kalshi' },
      { platform: 'kalshi' },
    ]);
    expect(f.settlementVenueMismatch).toBe(false);
    expect(f.venues).toEqual(['kalshi']);
  });

  it('two venues → mismatch, venues in first-seen order', () => {
    const f = computeVenueFlag([
      { platform: 'kalshi' },
      { platform: 'polymarket' },
      { platform: 'kalshi' },
    ]);
    expect(f.settlementVenueMismatch).toBe(true);
    expect(f.venues).toEqual(['kalshi', 'polymarket']);
  });

  it('three venues → mismatch with all venues listed once', () => {
    const f = computeVenueFlag([
      { platform: 'polymarket' },
      { platform: 'limitless' },
      { platform: 'predict' },
      { platform: 'limitless' },
    ]);
    expect(f.settlementVenueMismatch).toBe(true);
    expect(f.venues).toEqual(['polymarket', 'limitless', 'predict']);
  });

  it('empty legs → no mismatch, empty venue list', () => {
    const f = computeVenueFlag([]);
    expect(f.settlementVenueMismatch).toBe(false);
    expect(f.venues).toEqual([]);
  });

  it('single leg → no mismatch', () => {
    const f = computeVenueFlag([{ platform: 'polymarket' }]);
    expect(f.settlementVenueMismatch).toBe(false);
    expect(f.venues).toEqual(['polymarket']);
  });
});
