/**
 * Mantissa-Exponent numeric representation.
 *
 * A value is stored as  `m × 10^e`  where both m and e are plain integers.
 * This avoids IEEE-754 floating-point rounding for decimal thresholds such as
 * sports O/U lines (22.5), asset prices (0.025), or very large values such as
 * market caps (1 000 000 000 000).
 *
 * Examples:
 *   22.5          → { m:  225,          e: -1 }
 *   86 125        → { m:  86125,        e:  0 }
 *   1 500 000 000 → { m:  1500000000,   e:  0 }
 *   0.025         → { m:  25,           e: -3 }
 */
export interface ME {
  /** Integer mantissa (significand). */
  m: number;
  /** Power-of-10 exponent.  Negative values represent decimals. */
  e: number;
}

/**
 * Convert a number or its string representation to (m, e) form.
 *
 * Parsing from a string is preferred when the caller already has the value as
 * a string (e.g. reading a PostgreSQL NUMERIC column via node-postgres) because
 * it bypasses IEEE-754 entirely.
 */
export function toME(value: number | string): ME {
  let str = typeof value === 'string' ? value.trim() : value.toString();

  // JS sometimes serialises numbers in scientific notation ("1e+9", "2.5e-3").
  // Expand to plain decimal before parsing.
  if (/[eE]/.test(str)) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    // toFixed(15) gives enough decimal digits for any 64-bit float mantissa;
    // trim trailing zeros so SCALE stays minimal.
    str = n.toFixed(15).replace(/\.?0+$/, '');
  }

  const dotIdx = str.indexOf('.');
  if (dotIdx === -1) {
    return { m: parseInt(str, 10), e: 0 };
  }

  const decimals = str.length - dotIdx - 1;
  const mantissaStr = str.slice(0, dotIdx) + str.slice(dotIdx + 1); // remove '.'
  return { m: parseInt(mantissaStr, 10), e: -decimals };
}

/**
 * Reconstruct a JavaScript float from (m, e).
 *
 * For display and arithmetic only — very large mantissas may lose precision in
 * IEEE-754, though values encountered in prediction markets are well within the
 * safe-integer range (< 2^53).
 */
export function fromME(me: ME): number {
  return me.m * Math.pow(10, me.e);
}

/**
 * Return true when the fractional part of `value` is approximately 0.99 or
 * 0.9999.
 *
 * Kalshi publishes index-strike prices as `<true_threshold − ε>` to indicate
 * "strictly above this level".  For example 26349.99 really means 26 350, and
 * 6169.9999 really means 6 170.  This sentinel lets callers round those values
 * to the nearest integer before decomposing to (m, e).
 */
export function isKalshiTrailingNine(value: number): boolean {
  const frac = value - Math.floor(value);
  // Allow a tiny floating-point slack around 0.99 and 0.9999.
  return Math.abs(frac - 0.99) < 0.005 || Math.abs(frac - 0.9999) < 0.0005;
}

/**
 * Convert a Kalshi index strike price to (m, e), rounding to the nearest
 * integer first when the trailing-nine convention is detected.
 *
 * Use this instead of a bare `Math.round` to avoid clobbering legitimate
 * decimal values (e.g. a hypothetical index at 26349.5 should stay as-is).
 */
export function kalshiIndexToME(value: number): ME {
  return isKalshiTrailingNine(value)
    ? { m: Math.round(value), e: 0 }
    : toME(value);
}
