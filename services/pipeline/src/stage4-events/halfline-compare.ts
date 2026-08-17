/**
 * Bp-lattice closed-interval comparator for the cross-venue rate-decision
 * bridge.
 *
 * Four emitters stamp central-bank rate decisions onto one signed-Δbps line:
 *   no change        → at / 0
 *   exact hike N bps → at / +N        exact cut N bps → at / −N
 *   cumulative hike  → above / +N     cumulative cut  → below / −N
 * but the cumulative rungs mean different things per emitter:
 *   · Kalshi cumulative is strict  ('>N bps'  ⇔ Δ > +N ⇔ Δ ≥ N+tick on the lattice)
 *   · PM / Predict-AG / Limitless are non-strict ('N+ bps' ⇔ Δ ≥ +N)
 * A naive gated-field equality (above/+N ≟ above/+N) would wrongly equate a
 * strict '>N' rung with a non-strict 'N+' rung. Renormalizing every rung to a
 * closed interval over signed Δbps makes the comparison exact (kalshi '>25' →
 * [50,∞) ⊂ trio '25+' → [25,∞) ⇒ kalshi implies trio, an edge, never an
 * equivalence).
 *
 * This module is pure (no imports, total, never throws): every function
 * returns a sound refusal (null / 'none') on any doubt. The edge builder
 * (rate-decision-bridge.ts) owns the DB, the per-emitter strictness registry,
 * and the meeting join key; this file owns only the lattice arithmetic.
 */

/**
 * Per-instrument lattice tick (bps). The comparator is only sound on a fixed
 * lattice, so the table is an explicit allow-list — an instrument absent here is
 * refused by the builder (soundness-over-recall). Starts with the Fed funds rate;
 * other central banks are added deliberately, each with its verified tick.
 */
export const RATE_LATTICE_TICK: Readonly<Record<string, number>> = {
  fed_funds: 25,
};
export type RateInstrument = keyof typeof RATE_LATTICE_TICK;

/** The gated `condition_direction` values this comparator understands. */
export type RungDirection = 'at' | 'above' | 'below';

/**
 * A CLOSED interval [lo, hi] over signed Δbps. Open ends are ±Infinity; by
 * construction a rung interval has AT MOST one infinite end (`at` → both finite,
 * `above` → hi=+∞, `below` → lo=−∞), never [−∞,+∞].
 */
export interface Interval {
  lo: number;
  hi: number;
}

export type IntervalRelation =
  | 'equivalence' // identical intervals
  | 'a_implies_b' // A ⊊ B  (A is the stronger claim: p(A) ≤ p(B))
  | 'b_implies_a' // B ⊊ A
  | 'mutual_exclusion' // disjoint (no overlap)
  | 'none'; // partial overlap — no sound edge (soundness refusal)

/**
 * Normalize one rung to its closed interval on the lattice.
 *
 * @param dir       gated condition_direction (at | above | below)
 * @param signedBps gated value_primary — SIGNED Δbps (hike +, cut −, 0 = hold)
 * @param tick      the instrument lattice tick (bps), e.g. 25 for fed_funds
 * @param strict    per-emitter constant: cumulative rung is a STRICT bound
 *                  ('>N', Kalshi) vs a CLOSED bound ('N+', the trio)
 * @returns the closed interval, or null on any non-lattice / bad input (refuse).
 */
export function rungToInterval(
  dir: RungDirection,
  signedBps: number,
  tick: number,
  strict: boolean,
): Interval | null {
  if (!Number.isInteger(signedBps) || !Number.isInteger(tick) || tick <= 0) return null;
  // Non-lattice magnitude → refuse (the spec's first refusal guard). `-0 % t`
  // is `-0`, which `!== 0` treats as equal, so signed zero is fine.
  if (signedBps % tick !== 0) return null;
  switch (dir) {
    case 'at':
      return { lo: signedBps, hi: signedBps };
    case 'above':
      // hike half-line: Δ ≥ +N (closed) or Δ > +N ⇔ Δ ≥ N+tick (strict).
      return { lo: strict ? signedBps + tick : signedBps, hi: Infinity };
    case 'below':
      // cut half-line: Δ ≤ −N (closed) or Δ < −N ⇔ Δ ≤ −N−tick (strict).
      // signedBps is already negative for a cut, so the strict shift subtracts.
      return { lo: -Infinity, hi: strict ? signedBps - tick : signedBps };
    default:
      return null;
  }
}

/**
 * Relate two closed intervals. Equivalence is tested FIRST so identical
 * intervals never fall through to the (also-true) subset arms. Half-lines in the
 * same direction nest (⊂ ⇒ implication); points and opposite half-lines are
 * disjoint (⇒ mutex). Any genuine partial overlap → 'none' (refuse rather than
 * assert a relation that does not hold — cannot arise for the Fed rung set, which
 * is points ∪ rays, but kept for future bounded-range instruments).
 */
export function compareIntervals(a: Interval, b: Interval): IntervalRelation {
  if (a.lo === b.lo && a.hi === b.hi) return 'equivalence';
  const aSubsetB = b.lo <= a.lo && a.hi <= b.hi; // A ⊆ B (proper, equality handled above)
  const bSubsetA = a.lo <= b.lo && b.hi <= a.hi;
  if (aSubsetB) return 'a_implies_b';
  if (bSubsetA) return 'b_implies_a';
  if (a.hi < b.lo || b.hi < a.lo) return 'mutual_exclusion';
  return 'none';
}

/** Human-readable interval for edge-reasoning strings, e.g. "[50, ∞)". */
export function describeInterval(iv: Interval): string {
  const lo = iv.lo === -Infinity ? '(−∞' : `[${iv.lo}`;
  const hi = iv.hi === Infinity ? '∞)' : `${iv.hi}]`;
  return `${lo}, ${hi}`;
}
