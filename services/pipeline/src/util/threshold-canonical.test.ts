import { describe, expect, it } from 'bun:test';
import {
  canonicalizeIntegerThreshold,
  canonicalizePlusNotation,
  canonicalizeKalshiStrike,
  isIntegerGrainUnit,
} from './threshold-canonical.js';

describe('canonicalizeIntegerThreshold — integer-grain half-line fold', () => {
  it('above inclusive ≥N → (above, N−0.5)  ["3+ goals" ⇒ 2.5]', () => {
    const r = canonicalizeIntegerThreshold({ direction: 'above', value: 3, unit: 'goals', strictness: 'inclusive' });
    expect(r).toEqual({ direction: 'above', value: 2.5, changed: true });
  });

  it('above strict >N → (above, N+0.5)', () => {
    const r = canonicalizeIntegerThreshold({ direction: 'above', value: 3, unit: 'goals', strictness: 'strict' });
    expect(r).toEqual({ direction: 'above', value: 3.5, changed: true });
  });

  it('below inclusive ≤N → (below, N+0.5)  (the below mirror)', () => {
    const r = canonicalizeIntegerThreshold({ direction: 'below', value: 3, unit: 'goals', strictness: 'inclusive' });
    expect(r).toEqual({ direction: 'below', value: 3.5, changed: true });
  });

  it('below strict <N → (below, N−0.5)  (the below mirror)', () => {
    const r = canonicalizeIntegerThreshold({ direction: 'below', value: 3, unit: 'goals', strictness: 'strict' });
    expect(r).toEqual({ direction: 'below', value: 2.5, changed: true });
  });

  it('existing half-line "over 2.5" is UNCHANGED', () => {
    const r = canonicalizeIntegerThreshold({ direction: 'above', value: 2.5, unit: 'goals', strictness: 'strict' });
    expect(r).toEqual({ direction: 'above', value: 2.5, changed: false });
  });

  it('"3+ total goals" ≡ "over 2.5 goals": both stamp (above, 2.5)', () => {
    const plus = canonicalizeIntegerThreshold({ direction: 'above', value: 3, unit: 'goals', strictness: 'inclusive' });
    const over = canonicalizeIntegerThreshold({ direction: 'above', value: 2.5, unit: 'goals', strictness: 'strict' });
    expect(plus.value).toBe(over.value);
    expect(plus.value).toBe(2.5);
  });

  it('FRACTIONAL unit ≥N is NOT half-lined (≥34 pts ≠ >33.5 if margins fractional)', () => {
    // These are the continuous/fractional units ABSENT from INTEGER_GRAIN_UNITS.
    for (const unit of ['percentage points', 'usd', 'percent', 'index_value', 'score']) {
      const r = canonicalizeIntegerThreshold({ direction: 'above', value: 34, unit, strictness: 'inclusive' });
      expect(r).toEqual({ direction: 'above', value: 34, changed: false });
    }
  });

  it('non-finite / non-integer non-half values pass through unchanged', () => {
    expect(canonicalizeIntegerThreshold({ direction: 'above', value: NaN, unit: 'goals', strictness: 'strict' }).changed).toBe(false);
    expect(canonicalizeIntegerThreshold({ direction: 'above', value: 2.3, unit: 'goals', strictness: 'strict' })).toEqual({ direction: 'above', value: 2.3, changed: false });
  });

  it('the fold never flips the direction', () => {
    for (const direction of ['above', 'below'] as const) {
      for (const strictness of ['strict', 'inclusive'] as const) {
        expect(canonicalizeIntegerThreshold({ direction, value: 5, unit: 'points', strictness }).direction).toBe(direction);
      }
    }
  });
});

describe('canonicalizePlusNotation — "N+" inclusive-above sugar', () => {
  it('"3+ goals" → 2.5', () => {
    expect(canonicalizePlusNotation(3, 'goals')).toEqual({ value: 2.5, changed: true });
  });
  it('half-line passes through', () => {
    expect(canonicalizePlusNotation(2.5, 'goals')).toEqual({ value: 2.5, changed: false });
  });
  it('fractional unit not folded', () => {
    expect(canonicalizePlusNotation(34, 'percentage points')).toEqual({ value: 34, changed: false });
  });
});

describe('canonicalizeKalshiStrike — read floor + operator, not the title', () => {
  it('kalshi "5+ hits+runs+RBIs" reads greater floor=4.5 → (above, 4.5), NOT title-5', () => {
    const r = canonicalizeKalshiStrike('greater', 4.5, null, 'hits_runs_rbis');
    expect(r).toEqual({ direction: 'above', value: 4.5, changed: false });
    expect(r!.value).not.toBe(5);
  });

  it('kalshi "over 2.5 goals" → greater floor=2.5 → (above, 2.5) [stamped 2.5 ✓]', () => {
    expect(canonicalizeKalshiStrike('greater', 2.5, null, 'goals')).toEqual({ direction: 'above', value: 2.5, changed: false });
  });

  it('kalshi greater_or_equal floor=N (integer unit) → (above, N−0.5)  ["at least 9 wins" ⇒ 8.5]', () => {
    expect(canonicalizeKalshiStrike('greater_or_equal', 9, null, 'wins')).toEqual({ direction: 'above', value: 8.5, changed: true });
  });

  it('kalshi "34+ pts margin" greater_or_equal floor=34 on a FRACTIONAL margin unit is NOT folded', () => {
    // percentage points / score margins can be fractional — leave native.
    expect(canonicalizeKalshiStrike('greater_or_equal', 34, null, 'percentage points')).toEqual({ direction: 'above', value: 34, changed: false });
  });

  it('kalshi less/less_or_equal read the CAP and use the below mirror', () => {
    expect(canonicalizeKalshiStrike('less', null, 3, 'goals')).toEqual({ direction: 'below', value: 2.5, changed: true });
    expect(canonicalizeKalshiStrike('less_or_equal', null, 3, 'goals')).toEqual({ direction: 'below', value: 3.5, changed: true });
  });

  it('null boundary for the requested direction → null', () => {
    expect(canonicalizeKalshiStrike('greater', null, 10, 'goals')).toBeNull();
    expect(canonicalizeKalshiStrike('less', 10, null, 'goals')).toBeNull();
  });
});

describe('isIntegerGrainUnit', () => {
  it('count units are integer-grain', () => {
    for (const u of ['goals', 'goal', 'points', 'hits', 'runs', 'wins', 'corners', 'cards', 'hits_runs_rbis', 'total_bases']) {
      expect(isIntegerGrainUnit(u)).toBe(true);
    }
  });
  it('continuous units are NOT integer-grain', () => {
    for (const u of ['usd', 'percent', 'percentage points', 'index_value', 'score', 'streams', null]) {
      expect(isIntegerGrainUnit(u)).toBe(false);
    }
  });
});

// A strict >N and an inclusive >=N for the same integer N and same direction
// must map to different half-lines (else a fake cross-platform merge).
describe('FAKE-ARB INVARIANT: strict and inclusive never collapse onto the same stamp', () => {
  it('for every integer N and direction, strict ≠ inclusive (differ by exactly 1.0)', () => {
    for (const direction of ['above', 'below'] as const) {
      for (let n = -50; n <= 50; n++) {
        const strict = canonicalizeIntegerThreshold({ direction, value: n, unit: 'goals', strictness: 'strict' });
        const inclusive = canonicalizeIntegerThreshold({ direction, value: n, unit: 'goals', strictness: 'inclusive' });
        expect(strict.value).not.toBe(inclusive.value);
        expect(Math.abs(strict.value - inclusive.value)).toBeCloseTo(1.0, 9);
      }
    }
  });

  it('collapse happens ONLY for genuinely-equal integer regions (≥N ≡ >(N−1))', () => {
    // ≥N (inclusive above N) and >(N−1) (strict above N−1) ARE the same region.
    for (let n = 1; n <= 50; n++) {
      const ge = canonicalizeIntegerThreshold({ direction: 'above', value: n, unit: 'goals', strictness: 'inclusive' });
      const gtPrev = canonicalizeIntegerThreshold({ direction: 'above', value: n - 1, unit: 'goals', strictness: 'strict' });
      expect(ge.value).toBe(gtPrev.value); // both N−0.5 — correct, not a fake merge
    }
  });

  it('a strict >X and inclusive ≥X at the SAME X never share a stamp (any unit, any X)', () => {
    for (const unit of ['goals', 'points', 'wins', 'hits']) {
      for (let x = 0; x <= 20; x++) {
        const gt = canonicalizeIntegerThreshold({ direction: 'above', value: x, unit, strictness: 'strict' });
        const ge = canonicalizeIntegerThreshold({ direction: 'above', value: x, unit, strictness: 'inclusive' });
        expect(gt.value === ge.value).toBe(false);
      }
    }
  });
});
