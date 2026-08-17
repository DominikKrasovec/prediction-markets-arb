/**
 * The condition_value disambiguator — shared by every Stage-1 emission path.
 *
 * `condition_value` is a free-form TEXT column on llm_market_normalizations
 * that distinguishes otherwise-identical markets differing only in their
 * numeric threshold (BTC ≥ $80,000 vs ≥ $100,000 share every other field) so
 * they produce distinct canonical_keys instead of collapsing into one question.
 *
 * Format: `<op><value_primary>[-<value_secondary>][<unit>]`
 *   above   → ">=100000USD"
 *   below   → "<=80000USD"
 *   between → "80000-100000USD"
 *   null direction with BOTH values (Template Z exact_score (scoreA, scoreB),
 *   legacy range pairs) → "2_1<unit>" — encodes both so canonical_key doesn't
 *   silently collapse distinct outcomes that share scoreA / lo. Without it,
 *   S(2,1) and S(2,5) would collide, collapsing every scoreline outcome of a
 *   fixture into a handful of buckets keyed only on scoreA.
 *
 * Layering: leaf — imports only @arb/types.
 */
import type { ConditionDirection } from '@arb/types';

export function formatConditionValue(
  direction: ConditionDirection | null,
  value_primary: number | null,
  value_secondary: number | null,
  unit: string | null,
): string | null {
  if (value_primary == null) return null;
  const u = unit ?? '';
  switch (direction) {
    case 'above':
      return `>=${value_primary}${u}`;
    case 'below':
      return `<=${value_primary}${u}`;
    case 'between':
      return value_secondary != null
        ? `${value_primary}-${value_secondary}${u}`
        : `=${value_primary}${u}`;
    default:
      return value_secondary != null
        ? `${value_primary}_${value_secondary}${u}`
        : `${value_primary}${u}`;
  }
}
