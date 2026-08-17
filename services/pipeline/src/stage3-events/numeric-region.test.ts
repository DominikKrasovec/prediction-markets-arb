/**
 * Shared numeric YES-region comparator tests (numeric-region.ts). The
 * comparator is the single source of truth for guards.ts (Stage 3b) and
 * member-cohesion.ts (Stage 4 mint), so its semantics are pinned here once.
 */
import { describe, test, expect } from 'bun:test';
import { numericRegionConflict, foldDirectionClass, unitsEquivalent, type NumericRegionFacts } from './numeric-region.js';

function f(over: Partial<NumericRegionFacts> = {}): NumericRegionFacts {
  return {
    condition_direction: null, value_primary: null, value_secondary: null,
    value_unit: null, condition_shape: null, strike_type: null, ...over,
  };
}

describe('condition_metric (the measurable is YES-region identity)', () => {
  test('highest vs lowest temperature over IDENTICAL buckets → conflict', () => {
    // Same city/date/values/direction/unit, different measurable — checked
    // nowhere else in the pipeline.
    const c = numericRegionConflict(
      f({ condition_metric: 'highest_temperature', condition_direction: 'between', value_primary: '59', value_secondary: '60', value_unit: 'fahrenheit' }),
      f({ condition_metric: 'lowest_temperature', condition_direction: 'between', value_primary: '59', value_secondary: '60', value_unit: 'fahrenheit' }),
    );
    expect(c).toContain('condition_metric');
  });

  test('NULL-tolerant: one side missing metric → no conflict from metric alone', () => {
    expect(numericRegionConflict(
      f({ condition_metric: 'highest_temperature', condition_direction: 'above', value_primary: '64', value_unit: 'fahrenheit' }),
      f({ condition_direction: 'above', value_primary: '64', value_unit: 'fahrenheit' }),
    )).toBeNull();
  });

  test('case-fold equal metrics pass', () => {
    expect(numericRegionConflict(
      f({ condition_metric: 'Count', condition_direction: 'above', value_primary: '200', value_unit: 'tornadoes' }),
      f({ condition_metric: 'count', condition_direction: 'above', value_primary: '200', value_unit: 'tornadoes' }),
    )).toBeNull();
  });
});

describe('foldDirectionClass', () => {
  test('synonyms fold', () => {
    expect(foldDirectionClass('greater')).toBe('above');
    expect(foldDirectionClass('greater_or_equal')).toBe('above');
    expect(foldDirectionClass('less')).toBe('below');
    expect(foldDirectionClass('less_or_equal')).toBe('below');
    expect(foldDirectionClass('equal')).toBe('at');
    expect(foldDirectionClass('between')).toBe('between');
    expect(foldDirectionClass(null)).toBeNull();
  });
});

describe('unitsEquivalent', () => {
  test('singular/plural tolerated, real differences kept', () => {
    expect(unitsEquivalent('goal', 'goals')).toBe(true);
    expect(unitsEquivalent('goals', 'goal')).toBe(true);
    expect(unitsEquivalent('goals', 'goals')).toBe(true);
    expect(unitsEquivalent('goals', 'corners')).toBe(false);
    expect(unitsEquivalent('fahrenheit', 'celsius')).toBe(false);
  });
});

describe('numericRegionConflict', () => {
  test('q8912: strict ">64" vs inclusive "≥74" fahrenheit → conflict (10° apart)', () => {
    const c = numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '64', value_unit: 'fahrenheit', strike_type: 'greater' }),
      f({ condition_direction: 'above', value_primary: '74', value_unit: 'fahrenheit' }),
    );
    expect(c).toContain('value_primary');
    expect(c).toContain('≥65');
    expect(c).toContain('≥74');
  });

  test('int-grain strict/inclusive equivalence: "<74" ≡ "≤73" fahrenheit → no conflict', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'below', value_primary: '74', value_unit: 'fahrenheit', strike_type: 'less' }),
      f({ condition_direction: 'below', value_primary: '73', value_unit: 'fahrenheit' }),
    )).toBeNull();
  });

  test('int-grain half-point equivalence: "over 0.5 goals" ≡ "1+ goals" → no conflict', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '0.5', value_unit: 'goals' }),
      f({ condition_direction: 'above', value_primary: '1', value_unit: 'goals' }),
    )).toBeNull();
  });

  test('int-grain: strict ">5 wins" vs inclusive "5+ wins" DIFFER on exactly 5 → conflict', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '5', value_unit: 'wins', strike_type: 'greater' }),
      f({ condition_direction: 'above', value_primary: '5', value_unit: 'wins' }),
    )).toContain('value_primary');
  });

  test('continuous unit (USD): strict/inclusive is measure-zero, same bound → no conflict', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '89000', value_unit: 'USD', strike_type: 'greater' }),
      f({ condition_direction: 'above', value_primary: '89000', value_unit: 'usd' }),
    )).toBeNull();
  });

  test('q9414 off-by-one bucket: between 59-60 vs 58-59 fahrenheit → conflict', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'between', value_primary: '59', value_secondary: '60', value_unit: 'fahrenheit' }),
      f({ condition_direction: 'between', value_primary: '58', value_secondary: '59', value_unit: 'fahrenheit' }),
    )).toContain('value_primary');
  });

  test('between never fuses with a monotonic side (q8721 subset class)', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '85', value_unit: 'fahrenheit', strike_type: 'greater' }),
      f({ condition_direction: 'between', value_primary: '86', value_secondary: '87', value_unit: 'fahrenheit' }),
    )).toContain('condition_direction');
  });

  test('touch vs snapshot at the same bound → conflict (q27578 semantics half)', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '89000', value_unit: 'USD', condition_shape: 'monotonic_threshold' }),
      f({ condition_direction: 'above', value_primary: '89000', value_unit: 'USD', condition_shape: 'point_in_time' }),
    )).toContain('touch vs snapshot');
  });

  test('unit mismatch fires even without values', () => {
    expect(numericRegionConflict(
      f({ value_unit: 'goals' }),
      f({ value_unit: 'corners' }),
    )).toContain('value_unit');
  });

  test('NULL-tolerant: one unshaped side → no conflict', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '64', value_unit: 'fahrenheit' }),
      f(),
    )).toBeNull();
  });

  test('numeric string drift tolerated: "2.5" vs "2.50"', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '2.5', value_unit: 'goals' }),
      f({ condition_direction: 'above', value_primary: '2.50', value_unit: 'goals' }),
    )).toBeNull();
  });

  test('direction-less value mismatch still conflicts (raw fallback)', () => {
    expect(numericRegionConflict(
      f({ value_primary: '5' }),
      f({ value_primary: '10' }),
    )).toContain('value_primary');
  });
});

// Off-by-threshold strictness at an EQUAL bound.
// Stage 1 folds 'greater'→'above', so "above 74" (strict) and "74 or higher"
// (inclusive) agree on every gated field; the surviving evidence is the Kalshi
// strike_type. For INTEGER-GRAIN units the canonicalization already resolves this
// (that behaviour is pinned by the tests above and must not change); for every
// other unit the bounds were compared raw and the boundary world was silently fused.

describe('P12a — bound strictness at an equal value_primary', () => {
  test('strict vs inclusive at the same bound, COUNT-ish/unknown unit → conflict', () => {
    const c = numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '74', value_unit: null, strike_type: 'greater' }),
      f({ condition_direction: 'above', value_primary: '74', value_unit: null, strike_type: 'greater_or_equal' }),
    );
    expect(c).toContain('strictness');
  });

  test('the same conflict on the BELOW arm', () => {
    const c = numericRegionConflict(
      f({ condition_direction: 'below', value_primary: '74', value_unit: null, strike_type: 'less' }),
      f({ condition_direction: 'below', value_primary: '74', value_unit: null, strike_type: 'less_or_equal' }),
    );
    expect(c).toContain('strictness');
  });

  test('CONTINUOUS units are exempt (measure-zero boundary): usd / percent', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '89000', value_unit: 'usd', strike_type: 'greater' }),
      f({ condition_direction: 'above', value_primary: '89000', value_unit: 'usd', strike_type: 'greater_or_equal' }),
    )).toBeNull();
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '5', value_unit: 'percent', strike_type: 'greater' }),
      f({ condition_direction: 'above', value_primary: '5', value_unit: 'percent', strike_type: 'greater_or_equal' }),
    )).toBeNull();
  });

  test('NULL-tolerant: one side records no strictness → no conflict', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '74', value_unit: null, strike_type: 'greater' }),
      f({ condition_direction: 'above', value_primary: '74', value_unit: null, strike_type: null }),
    )).toBeNull();
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '74', value_unit: null, strike_type: 'structured' }),
      f({ condition_direction: 'above', value_primary: '74', value_unit: null, strike_type: 'greater_or_equal' }),
    )).toBeNull();
  });

  test('same strictness on both sides → no conflict', () => {
    expect(numericRegionConflict(
      f({ condition_direction: 'above', value_primary: '74', value_unit: null, strike_type: 'greater' }),
      f({ condition_direction: 'above', value_primary: '74', value_unit: null, strike_type: 'greater' }),
    )).toBeNull();
  });

  test('REGRESSION: the integer-grain strict/inclusive TOLERANCE is untouched', () => {
    // Kalshi "<74°" ≡ PM "73°F or below" — different value_primary, same integer
    // YES-region. The new check must not fire here (bounds are not equal, and the
    // unit is integer-grain anyway).
    expect(numericRegionConflict(
      f({ condition_direction: 'below', value_primary: '74', value_unit: 'fahrenheit', strike_type: 'less' }),
      f({ condition_direction: 'below', value_primary: '73', value_unit: 'fahrenheit', strike_type: 'less_or_equal' }),
    )).toBeNull();
    // …and an integer-grain pair at an EQUAL bound with differing strictness still
    // conflicts through the CANONICAL bound compare (73 vs 74), not the new arm.
    const c = numericRegionConflict(
      f({ condition_direction: 'below', value_primary: '74', value_unit: 'fahrenheit', strike_type: 'less' }),
      f({ condition_direction: 'below', value_primary: '74', value_unit: 'fahrenheit', strike_type: 'less_or_equal' }),
    );
    expect(c).toContain('YES-region');
  });

  test('the RAW un-folded direction synonym is strictness evidence too', () => {
    const c = numericRegionConflict(
      f({ condition_direction: 'greater', value_primary: '74', value_unit: null }),
      f({ condition_direction: 'greater_or_equal', value_primary: '74', value_unit: null }),
    );
    expect(c).toContain('strictness');
  });
});
