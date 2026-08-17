/**
 * Value-axis interval parsing for the Stage-4 certifier's Belt V (value-axis
 * pairwise disjointness) + the `numeric_band` outcome grain. Pure — no DB, no LLM.
 *
 * An {@link AxisInterval} is a real interval [lo, hi] tagged with a comparison
 * DIMENSION: 'mag' for magnitudes folded through a unit multiplier (money / counts
 * in k/m/b/t), 'pct' for percentages, '?' for a bare (unitless) quantity, or a raw
 * unit token otherwise. Two intervals are comparable ONLY within the same dimension
 * — the billion-vs-trillion trap: a "≥400
 * billion" slot and a "<1 trillion" slot compare 400 > 1 on the RAW number and
 * falsely certify disjointness, so every value MUST be normalized through the unit
 * fold before comparison.
 *
 * Two axes feed intervals:
 *   · {@link gatedInterval} — from the SHAPED gated fields (condition_direction +
 *     value_primary/secondary + value_unit); the sound primary source.
 *   · {@link parseBandInterval} — a conservative, anchored grammar over an
 *     UNSHAPED outcome_id tail / display label (the starvation case where every
 *     member market has zero llm_market_normalizations rows). It REFUSES the bare
 *     exact-score pair ('2_1', '0_0') so score grids stay out.
 */
import { dirPartitionClass } from './condition-shape.js';

export interface AxisInterval {
  lo: number;
  hi: number;
  /** comparison dimension: 'mag' | 'pct' | '?' | folded unit token. */
  dim: string;
}

const NEG = Number.NEGATIVE_INFINITY;
const POS = Number.POSITIVE_INFINITY;

const toNum = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Fold a unit string into a magnitude MULTIPLIER + comparison DIMENSION.
 *   null/'' → {1, '?'} ; k/thousand → 1e3, m/mm/million → 1e6, b/bn/billion → 1e9,
 *   t/tn/trillion → 1e12 (all dim 'mag') ; %/percent/percentage_point/pp → {1,'pct'} ;
 *   anything else → {1, lower(trim(u))}. Pure.
 */
export function foldUnitMultiplier(u: string | null | undefined): { mult: number; dim: string } {
  if (u == null) return { mult: 1, dim: '?' };
  const t = u.trim().toLowerCase();
  if (t === '') return { mult: 1, dim: '?' };
  switch (t) {
    case 'k': case 'thousand': case 'thousands': return { mult: 1e3, dim: 'mag' };
    case 'm': case 'mm': case 'million': case 'millions': return { mult: 1e6, dim: 'mag' };
    case 'b': case 'bn': case 'billion': case 'billions': return { mult: 1e9, dim: 'mag' };
    case 't': case 'tn': case 'trillion': case 'trillions': return { mult: 1e12, dim: 'mag' };
    case '%': case 'percent': case 'percentage': case 'percentage_point': case 'percentage_points': case 'pp':
      return { mult: 1, dim: 'pct' };
    default: return { mult: 1, dim: t };
  }
}

/**
 * Interval from the SHAPED gated fields.
 *   above → (v·m, +Inf) ; below → (−Inf, v·m) ; between → [min,max]·m (needs vs) ;
 *   at → [v·m, v·m]. NULL value / NULL-or-unmappable direction → null (unknown never
 *   asserts an interval). Pure.
 */
export function gatedInterval(
  dir: string | null | undefined,
  vp: number | string | null | undefined,
  vs: number | string | null | undefined,
  unit: string | null | undefined,
): AxisInterval | null {
  const v1 = toNum(vp);
  if (v1 === null) return null;
  const { mult, dim } = foldUnitMultiplier(unit);
  switch (dirPartitionClass(dir)) {
    case 'above': return { lo: v1 * mult, hi: POS, dim };
    case 'below': return { lo: NEG, hi: v1 * mult, dim };
    case 'between': {
      const v2 = toNum(vs);
      if (v2 === null) return null;
      return { lo: Math.min(v1, v2) * mult, hi: Math.max(v1, v2) * mult, dim };
    }
    case 'at': return { lo: v1 * mult, hi: v1 * mult, dim };
    default: return null;
  }
}

// Word/letter unit alternation shared by every band form (single-letter key
// suffixes AND spelled-out label words). foldUnitMultiplier resolves each.
const UNIT_ALT = 'thousand|million|billion|trillion|bn|tn|[kmbt]';
const N = '(\\d+(?:\\.\\d+)?)';
const U = `(${UNIT_ALT})?`;
// Optional non-numeric prefix ('seats_', 'between '); lazy so it never eats a keyword.
const PFX = '(?:[a-z][a-z_ ]*?[_ ])?';
const LT_KW = 'lte|lt|le|under|below|less than|at most|up to|fewer than|no more than|lower than';
const GE_KW = 'gte|gt|ge|above|over|at least|more than|greater than|minimum';

const RE_TWO_SIDED = new RegExp(`^${PFX}${N}\\s*${U}\\s*(?:-|_|\\s+(?:to|and)\\s+)\\s*${N}\\s*${U}$`);
const RE_LT = new RegExp(`^${PFX}(?:${LT_KW})[_ ]+${N}\\s*${U}$`);
const RE_GE = new RegExp(`^${PFX}(?:${GE_KW})[_ ]+${N}\\s*${U}$`);
const RE_GE_SUFFIX = new RegExp(
  `^${PFX}${N}\\s*${U}\\s*(?:\\+|[_ ]?plus|(?:[a-z]+ )*or (?:greater|more|higher|above|over)|[_ ]?or more)$`,
);

const qty = (numStr: string, unitStr: string | undefined): { v: number; dim: string } => {
  const { mult, dim } = foldUnitMultiplier(unitStr && unitStr !== '' ? unitStr : null);
  return { v: parseFloat(numStr) * mult, dim };
};

/**
 * Conservative anchored band grammar over an outcome_id tail or a display label.
 * Accepts (currency ¥$€£ and ° stripped first):
 *   lt/below/less-than N<u>          → (−Inf, N·m)
 *   ge/above/at-least N<u>           → [N·m, +Inf)
 *   N<u> (+|plus|or greater/more/…)  → [N·m, +Inf)
 *   (prefix_)?N<u>[-_ to/and]N<u>    → [N1·m1, N2·m2] (requires lo < hi)
 * REFUSES (returns null): a bare 1-2-digit pair with no prefix-symbol / unit / decimal
 * (exact-score shape — '2_1', '0_0', 'rep_by_0_49'); a single value with no band
 * marker ('cut_25bps', 'top_10', '4193971'). Unit inheritance: in a two-sided band a
 * unitless side inherits the other side's unit ('250_280b' → both ·1e9). Pure.
 */
export function parseBandInterval(input: string | null | undefined): AxisInterval | null {
  if (input == null) return null;
  let x = input.toLowerCase().trim();
  if (x === '') return null;
  const hadSymbol = /[¥$€£°]/.test(x);
  x = x.replace(/[¥$€£°]/g, ' ').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

  // (1) two-sided range (strip a leading 'between ' so the prefix rule stays simple).
  {
    const m = x.replace(/^between[_ ]+/, '').match(RE_TWO_SIDED);
    if (m) {
      const [, n1, u1, n2, u2] = m;
      const hasUnit = (!!u1 && u1 !== '') || (!!u2 && u2 !== '');
      const hasDecimal = n1.includes('.') || n2.includes('.');
      const bothSmall = parseFloat(n1) < 100 && parseFloat(n2) < 100;
      // bare 1-2-digit pair, no unit / decimal / symbol → exact-score shape, refuse.
      if (!hadSymbol && !hasUnit && !hasDecimal && bothSmall) return null;
      let uu1 = u1 || undefined;
      let uu2 = u2 || undefined;
      if (!uu1 && uu2) uu1 = uu2; // unit inheritance
      if (!uu2 && uu1) uu2 = uu1;
      const q1 = qty(n1, uu1);
      const q2 = qty(n2, uu2);
      const lo = Math.min(q1.v, q2.v);
      const hi = Math.max(q1.v, q2.v);
      if (!(lo < hi)) return null; // degenerate / reversed pair
      const dim = q1.dim === q2.dim ? q1.dim : (q1.dim !== '?' ? q1.dim : q2.dim);
      return { lo, hi, dim };
    }
  }
  // (2) lower-bounded one-sided.
  {
    const m = x.match(RE_LT);
    if (m) { const q = qty(m[1], m[2] || undefined); return { lo: NEG, hi: q.v, dim: q.dim }; }
  }
  // (3) upper-bounded one-sided (keyword prefix).
  {
    const m = x.match(RE_GE);
    if (m) { const q = qty(m[1], m[2] || undefined); return { lo: q.v, hi: POS, dim: q.dim }; }
  }
  // (4) upper-bounded one-sided (suffix: '+', 'plus', 'or greater/more').
  {
    const m = x.match(RE_GE_SUFFIX);
    if (m) { const q = qty(m[1], m[2] || undefined); return { lo: q.v, hi: POS, dim: q.dim }; }
  }
  return null;
}

/**
 * TRUE iff two intervals INTERIOR-overlap within the SAME dimension. Adjacency at a
 * single boundary point (a.hi == b.lo) is NOT overlap — matching the documented
 * isPairwiseMutexPartition measure-zero tolerance. Cross-dimension → never. Pure.
 */
export function intervalsOverlap(a: AxisInterval, b: AxisInterval): boolean {
  if (a.dim !== b.dim) return false;
  return a.lo < b.hi && b.lo < a.hi;
}
