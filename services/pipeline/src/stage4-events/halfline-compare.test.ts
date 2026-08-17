/**
 * Boundary table for the 25 bp-lattice comparator: Δ=N boundary,
 * unchanged=[0,0], cut/hike sign symmetry, 50 bp jumps, non-lattice refuse.
 * Pure — no DB. The unknown-emitter refuse + different-meeting no-edge cases
 * live in rate-decision-bridge.test.ts (they are builder concerns).
 */
import { describe, test, expect } from 'bun:test';
import {
  rungToInterval,
  compareIntervals,
  describeInterval,
  RATE_LATTICE_TICK,
  type Interval,
} from './halfline-compare.js';

const TICK = RATE_LATTICE_TICK.fed_funds; // 25

describe('rungToInterval — closed-interval normal form', () => {
  test('unchanged (at/0) → [0,0]', () => {
    expect(rungToInterval('at', 0, TICK, false)).toEqual({ lo: 0, hi: 0 });
    // strictness is irrelevant for exact rungs
    expect(rungToInterval('at', 0, TICK, true)).toEqual({ lo: 0, hi: 0 });
  });

  test('exact hike / cut → point interval, signed', () => {
    expect(rungToInterval('at', 25, TICK, false)).toEqual({ lo: 25, hi: 25 });
    expect(rungToInterval('at', -25, TICK, false)).toEqual({ lo: -25, hi: -25 });
    expect(rungToInterval('at', 50, TICK, false)).toEqual({ lo: 50, hi: 50 });
  });

  test('NON-STRICT cumulative (trio "N+ bps") → closed half-line at N', () => {
    expect(rungToInterval('above', 25, TICK, false)).toEqual({ lo: 25, hi: Infinity });
    expect(rungToInterval('above', 50, TICK, false)).toEqual({ lo: 50, hi: Infinity });
    expect(rungToInterval('below', -25, TICK, false)).toEqual({ lo: -Infinity, hi: -25 });
    expect(rungToInterval('below', -50, TICK, false)).toEqual({ lo: -Infinity, hi: -50 });
  });

  test('STRICT cumulative (kalshi ">N bps") → half-line shifted one tick', () => {
    // '>25 hike' ⇔ Δ ≥ 50
    expect(rungToInterval('above', 25, TICK, true)).toEqual({ lo: 50, hi: Infinity });
    // '>25 cut' ⇔ Δ ≤ −50 (signed value −25, shift subtracts a tick)
    expect(rungToInterval('below', -25, TICK, true)).toEqual({ lo: -Infinity, hi: -50 });
  });

  test('non-lattice magnitude → null (soundness refusal)', () => {
    expect(rungToInterval('at', 30, TICK, false)).toBeNull();
    expect(rungToInterval('above', 10, TICK, false)).toBeNull();
    expect(rungToInterval('at', 12.5, TICK, false)).toBeNull();
  });

  test('bad tick → null', () => {
    expect(rungToInterval('at', 25, 0, false)).toBeNull();
    expect(rungToInterval('at', 25, -25, false)).toBeNull();
  });
});

describe('compareIntervals — relation semantics', () => {
  const pt = (v: number): Interval => ({ lo: v, hi: v });

  test('identical intervals → equivalence', () => {
    expect(compareIntervals(pt(25), pt(25))).toBe('equivalence');
    expect(compareIntervals({ lo: 50, hi: Infinity }, { lo: 50, hi: Infinity })).toBe('equivalence');
  });

  test('THE Δ=N boundary: kalshi ">25" [50,∞) ⊂ trio "25+" [25,∞) → implication, NEVER equiv', () => {
    const kalshiStrict = rungToInterval('above', 25, TICK, true)!; // [50,∞)
    const trioOpen = rungToInterval('above', 25, TICK, false)!; // [25,∞)
    expect(kalshiStrict).toEqual({ lo: 50, hi: Infinity });
    expect(trioOpen).toEqual({ lo: 25, hi: Infinity });
    expect(compareIntervals(kalshiStrict, trioOpen)).toBe('a_implies_b');
    expect(compareIntervals(trioOpen, kalshiStrict)).toBe('b_implies_a');
  });

  test('kalshi ">25 hike" ≡ trio "50+ hike" (both ⇔ Δ≥50) → equivalence', () => {
    const kalshiStrict = rungToInterval('above', 25, TICK, true)!; // [50,∞)
    const trio50 = rungToInterval('above', 50, TICK, false)!; // [50,∞)
    expect(compareIntervals(kalshiStrict, trio50)).toBe('equivalence');
  });

  test('exact rung ⊂ cumulative half-line above it → implication', () => {
    // exact +50 hike implies "25+ bps hike"
    expect(compareIntervals(pt(50), { lo: 25, hi: Infinity })).toBe('a_implies_b');
  });

  test('distinct exact rungs → mutual_exclusion', () => {
    expect(compareIntervals(pt(25), pt(50))).toBe('mutual_exclusion');
    expect(compareIntervals(pt(0), pt(25))).toBe('mutual_exclusion'); // hold vs hike
    expect(compareIntervals(pt(25), pt(-25))).toBe('mutual_exclusion'); // hike vs cut
  });

  test('exact rung below a cumulative half-line → mutual_exclusion', () => {
    // exact +25 vs "50+ bps" → disjoint (25 < 50)
    expect(compareIntervals(pt(25), { lo: 50, hi: Infinity })).toBe('mutual_exclusion');
  });

  test('opposite half-lines (hike vs cut cumulative) → mutual_exclusion', () => {
    const hike = rungToInterval('above', 50, TICK, false)!; // [50,∞)
    const cut = rungToInterval('below', -50, TICK, false)!; // (−∞,−50]
    expect(compareIntervals(hike, cut)).toBe('mutual_exclusion');
  });

  test('cut/hike SIGN SYMMETRY: the cut side mirrors the hike side', () => {
    // hike: exact +25 ⊂ "25+" [25,∞)  ≡  cut: exact −25 ⊂ "25+ cut" (−∞,−25]
    expect(compareIntervals(pt(25), rungToInterval('above', 25, TICK, false)!)).toBe('a_implies_b');
    expect(compareIntervals(pt(-25), rungToInterval('below', -25, TICK, false)!)).toBe('a_implies_b');
    // strict boundary mirrors too
    expect(
      compareIntervals(rungToInterval('below', -25, TICK, true)!, rungToInterval('below', -25, TICK, false)!),
    ).toBe('a_implies_b'); // (−∞,−50] ⊂ (−∞,−25]
  });

  test('50 bp jumps nest correctly', () => {
    // "50+ bps" [50,∞) ⊂ "25+ bps" [25,∞)
    expect(compareIntervals({ lo: 50, hi: Infinity }, { lo: 25, hi: Infinity })).toBe('a_implies_b');
  });
});

describe('describeInterval', () => {
  test('formats points and rays', () => {
    expect(describeInterval({ lo: 25, hi: 25 })).toBe('[25, 25]');
    expect(describeInterval({ lo: 50, hi: Infinity })).toBe('[50, ∞)');
    expect(describeInterval({ lo: -Infinity, hi: -50 })).toBe('(−∞, -50]');
  });
});
