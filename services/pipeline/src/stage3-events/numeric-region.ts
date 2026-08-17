/**
 * Canonical numeric YES-region comparison — shared by guards.ts (leg guard)
 * and stage4-events/member-cohesion.ts (question-mint belt). Null-tolerant: a
 * check fires only when both sides are non-NULL and provably differ. Platforms
 * encode the same integer-grain bound in strict vs inclusive forms ("<74" ≡
 * "73 or below"), so integer-grain units canonicalize to their integer
 * YES-boundary before comparing; continuous units (USD, percent) compare raw.
 */

export interface NumericRegionFacts {
  condition_metric?: string | null; // checked nowhere else: highest-vs-lowest is a different proposition even at identical values
  condition_direction: string | null;
  value_primary: number | string | null;
  value_secondary: number | string | null;
  value_unit: string | null;
  condition_shape?: string | null;
  // Only surviving record of bound strictness; absent/unknown treated as inclusive.
  strike_type?: string | null;
  floor_strike?: number | string | null;
  cap_strike?: number | string | null;
}

import {
  SNAPSHOT_SHAPES,
  INTEGER_GRAIN_UNITS,
  foldDirectionClass,
  foldUnit,
  unitsEquivalent,
} from '../util/condition-shape.js';

// Single source of truth is util/condition-shape.ts; do not re-introduce local copies.
export { foldDirectionClass, unitsEquivalent };

const toNum = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export type BoundStrictness = 'strict' | 'inclusive';
function boundStrictness(f: NumericRegionFacts): BoundStrictness | null {
  const d = f.condition_direction?.toLowerCase();
  if (d === 'greater' || d === 'less') return 'strict';
  if (d === 'greater_or_equal' || d === 'less_or_equal') return 'inclusive';
  const st = f.strike_type?.toLowerCase();
  if (st === 'greater' || st === 'less') return 'strict';
  if (st === 'greater_or_equal' || st === 'less_or_equal' || st === 'between') return 'inclusive';
  return null;
}

function isStrictBound(f: NumericRegionFacts): boolean {
  return boundStrictness(f) === 'strict';
}

// Fires only for units outside INTEGER_GRAIN_UNITS; a NULL/unknown unit is treated as possibly integer, not exempt.
function strictnessConflict(
  a: NumericRegionFacts,
  b: NumericRegionFacts,
  ua: string | null,
  ub: string | null,
): string | null {
  const sa = boundStrictness(a);
  const sb = boundStrictness(b);
  if (sa === null || sb === null || sa === sb) return null;
  const bothContinuous =
    ua != null && ub != null && !INTEGER_GRAIN_UNITS.has(ua) && !INTEGER_GRAIN_UNITS.has(ub);
  if (bothContinuous) return null;
  return `bound strictness '${sa}' vs '${sb}' at value_primary ${a.value_primary} (boundary world differs)`;
}

function intLowerBound(vp: number, strict: boolean): number {
  return strict ? Math.floor(vp) + 1 : Math.ceil(vp);
}
function intUpperBound(vp: number, strict: boolean): number {
  return strict ? Math.ceil(vp) - 1 : Math.floor(vp);
}

function valuesDifferRaw(a: number | string | null, b: number | string | null): boolean {
  if (a == null || b == null) return false;
  const na = toNum(a);
  const nb = toNum(b);
  if (na !== null && nb !== null) return na !== nb;
  return String(a).trim().toLowerCase() !== String(b).trim().toLowerCase();
}

// Do two numeric conditions provably describe DIFFERENT YES-regions?
export function numericRegionConflict(a: NumericRegionFacts, b: NumericRegionFacts): string | null {
  const ma = foldUnit(a.condition_metric ?? null);
  const mb = foldUnit(b.condition_metric ?? null);
  if (ma != null && mb != null && ma !== mb) {
    return `condition_metric '${a.condition_metric}' vs '${b.condition_metric}'`;
  }

  const ua = foldUnit(a.value_unit);
  const ub = foldUnit(b.value_unit);
  if (ua != null && ub != null && !unitsEquivalent(ua, ub)) {
    return `value_unit '${a.value_unit}' vs '${b.value_unit}'`;
  }

  const vpa = toNum(a.value_primary);
  const vpb = toNum(b.value_primary);
  if (vpa === null || vpb === null) {
    if (valuesDifferRaw(a.value_primary, b.value_primary) && a.value_primary != null && b.value_primary != null) {
      return `value_primary ${a.value_primary} vs ${b.value_primary}`;
    }
    if (valuesDifferRaw(a.value_secondary, b.value_secondary)) {
      return `value_secondary ${a.value_secondary} vs ${b.value_secondary}`;
    }
    return null;
  }

  const da = foldDirectionClass(a.condition_direction);
  const db = foldDirectionClass(b.condition_direction);
  if (da != null && db != null && da !== db) {
    return `condition_direction '${a.condition_direction}' vs '${b.condition_direction}'`;
  }

  // touch vs snapshot: same bound, different question over the path space.
  const sa = a.condition_shape ?? null;
  const sb = b.condition_shape ?? null;
  if (sa != null && sb != null && sa !== sb) {
    const monoVsSnap =
      (sa === 'monotonic_threshold' && SNAPSHOT_SHAPES.has(sb)) ||
      (sb === 'monotonic_threshold' && SNAPSHOT_SHAPES.has(sa));
    if (monoVsSnap) {
      return `condition_shape '${sa}' vs '${sb}' — touch vs snapshot semantics`;
    }
  }

  const intGrain = ua != null && ub != null && INTEGER_GRAIN_UNITS.has(ua) && INTEGER_GRAIN_UNITS.has(ub);
  const cls = da != null && db != null ? da : null;
  if (cls === 'above') {
    const lo1 = intGrain ? intLowerBound(vpa, isStrictBound(a)) : vpa;
    const lo2 = intGrain ? intLowerBound(vpb, isStrictBound(b)) : vpb;
    if (lo1 !== lo2) {
      return `value_primary ${a.value_primary} vs ${b.value_primary} (YES-region ≥${lo1} vs ≥${lo2})`;
    }
    if (!intGrain) {
      const sc = strictnessConflict(a, b, ua, ub);
      if (sc) return sc;
    }
    if (valuesDifferRaw(a.value_secondary, b.value_secondary)) {
      return `value_secondary ${a.value_secondary} vs ${b.value_secondary}`;
    }
    return null;
  }
  if (cls === 'below') {
    const hi1 = intGrain ? intUpperBound(vpa, isStrictBound(a)) : vpa;
    const hi2 = intGrain ? intUpperBound(vpb, isStrictBound(b)) : vpb;
    if (hi1 !== hi2) {
      return `value_primary ${a.value_primary} vs ${b.value_primary} (YES-region ≤${hi1} vs ≤${hi2})`;
    }
    if (!intGrain) {
      const sc = strictnessConflict(a, b, ua, ub);
      if (sc) return sc;
    }
    if (valuesDifferRaw(a.value_secondary, b.value_secondary)) {
      return `value_secondary ${a.value_secondary} vs ${b.value_secondary}`;
    }
    return null;
  }
  if (cls === 'between') {
    const vsa = toNum(a.value_secondary);
    const vsb = toNum(b.value_secondary);
    if (vsa !== null && vsb !== null) {
      const lo1 = intGrain ? Math.ceil(vpa) : vpa;
      const lo2 = intGrain ? Math.ceil(vpb) : vpb;
      const hi1 = intGrain ? Math.floor(vsa) : vsa;
      const hi2 = intGrain ? Math.floor(vsb) : vsb;
      if (lo1 !== lo2) return `value_primary ${a.value_primary} vs ${b.value_primary} (bucket lower bound)`;
      if (hi1 !== hi2) return `value_secondary ${a.value_secondary} vs ${b.value_secondary} (bucket upper bound)`;
      return null;
    }
  }

  if (vpa !== vpb) {
    return `value_primary ${a.value_primary} vs ${b.value_primary}`;
  }
  if (valuesDifferRaw(a.value_secondary, b.value_secondary)) {
    return `value_secondary ${a.value_secondary} vs ${b.value_secondary}`;
  }
  return null;
}
