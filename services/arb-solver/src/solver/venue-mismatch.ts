/**
 * Cross-venue settlement-risk flag. When an arb basket's legs span ≥2
 * distinct venues (e.g. Kalshi + Polymarket), the venues settle edge outcomes
 * independently: Kalshi settles cancelled/void events to last-fair-price
 * while PM/UMA settles 50-50. Two "complementary" legs therefore need not sum
 * to $1 in those tail states — the basket carries tail risk and must not be
 * presented as guaranteed.
 *
 * Annotation only: never rejects/filters an arb and never touches LP
 * construction.
 */

/** The minimal leg shape needed: anything carrying a platform. */
export interface VenueLeg {
  platform: string;
}

export interface VenueFlag {
  /** Distinct venues across the basket's traded legs, in first-seen order. */
  venues: string[];
  /** True ⟺ the legs span ≥2 distinct venues (independent settlement ⟹ tail risk). */
  settlementVenueMismatch: boolean;
}

/** Compute the cross-venue settlement flag from a basket's traded legs. */
export function computeVenueFlag(legs: readonly VenueLeg[]): VenueFlag {
  const venues: string[] = [];
  const seen = new Set<string>();
  for (const leg of legs) {
    if (!seen.has(leg.platform)) {
      seen.add(leg.platform);
      venues.push(leg.platform);
    }
  }
  return { venues, settlementVenueMismatch: venues.length >= 2 };
}
