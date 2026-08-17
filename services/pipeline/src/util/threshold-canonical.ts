/**
 * Threshold stamp canonicalization: for integer-quantized units, ≥N ⟺ >(N−0.5)
 * and >N ⟺ >(N+0.5) hold with no gap, so every integer-unit threshold folds to
 * its strict-above/strict-below half-line, letting cross-platform twins
 * ("3+ goals" vs "over 2.5 goals") merge. Fractional/continuous units (usd,
 * percent, score, …) MUST NOT be half-lined — for them ≥34 ≠ >33.5 — and are
 * left exactly as produced. Leaf util — pure, no DB, no clock.
 */
import { INTEGER_GRAIN_UNITS, foldUnit } from './condition-shape.js';

export type Strictness = 'strict' | 'inclusive';

export interface ThresholdInput {
  direction: 'above' | 'below';
  value: number;
  unit: string | null;
  strictness: Strictness;
}

const HALF_TOL = 1e-9;

function isInteger(x: number): boolean {
  return Number.isFinite(x) && Math.abs(x - Math.round(x)) < HALF_TOL;
}

/** …, 2.5, 3.5, … — an existing half-line. */
function isHalfInteger(x: number): boolean {
  return Number.isFinite(x) && Math.abs((x * 2) - Math.round(x * 2)) < HALF_TOL && !isInteger(x);
}

export function isIntegerGrainUnit(unit: string | null): boolean {
  const f = foldUnit(unit);
  return f != null && INTEGER_GRAIN_UNITS.has(f);
}

/** The returned `direction` is ALWAYS the input direction; only `value` may move by ±0.5. */
export function canonicalizeIntegerThreshold(
  input: ThresholdInput,
): { direction: 'above' | 'below'; value: number; changed: boolean } {
  const { direction, value, unit, strictness } = input;
  const unchanged = { direction, value, changed: false };

  if (!Number.isFinite(value)) return unchanged;
  if (!isIntegerGrainUnit(unit)) return unchanged;
  if (isHalfInteger(value)) return unchanged;
  if (!isInteger(value)) return unchanged;

  const n = Math.round(value);
  let canonical: number;
  if (direction === 'above') {
    canonical = strictness === 'inclusive' ? n - 0.5 : n + 0.5;
  } else {
    canonical = strictness === 'inclusive' ? n + 0.5 : n - 0.5;
  }
  return { direction, value: canonical, changed: Math.abs(canonical - value) > HALF_TOL };
}

/** "N+"/"N or more"/"at least N" is INCLUSIVE-above by definition. */
export function canonicalizePlusNotation(
  value: number,
  unit: string | null,
): { value: number; changed: boolean } {
  const r = canonicalizeIntegerThreshold({ direction: 'above', value, unit, strictness: 'inclusive' });
  return { value: r.value, changed: r.changed };
}

/** Returns null when the strike has no usable boundary for the requested direction. */
export function canonicalizeKalshiStrike(
  strikeType: 'greater' | 'greater_or_equal' | 'less' | 'less_or_equal',
  floor: number | null,
  cap: number | null,
  unit: string | null,
): { direction: 'above' | 'below'; value: number; changed: boolean } | null {
  if (strikeType === 'greater' || strikeType === 'greater_or_equal') {
    if (floor == null || !Number.isFinite(floor)) return null;
    return canonicalizeIntegerThreshold({
      direction: 'above',
      value: floor,
      unit,
      strictness: strikeType === 'greater' ? 'strict' : 'inclusive',
    });
  }
  if (cap == null || !Number.isFinite(cap)) return null;
  return canonicalizeIntegerThreshold({
    direction: 'below',
    value: cap,
    unit,
    strictness: strikeType === 'less' ? 'strict' : 'inclusive',
  });
}
