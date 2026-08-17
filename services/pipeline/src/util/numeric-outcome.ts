/**
 * The bucket/threshold outcome parser. One grammar that is the union of every
 * per-family parser (Template A/X/V buckets, PM_PCT / PM_COUNT, the Limitless
 * econ bucket regex sets, Kalshi ladder rows); each existing regex's accepted
 * language is a subset of this union, and the per-family port pins its
 * current numeric outputs byte-for-byte before any family moves over.
 *
 * `snapshotStamp` makes one decision: a range outcome always folds to
 * direction 'between' (Kalshi Pass 1 hardwires 'between' for range strikes,
 * and a null-direction range stamp breaks cross-platform canonical_keys).
 *
 * Hi-lo swap rule: range inputs given hi-first (e.g. "$95B–$90B") are swapped
 * here so `lo < hi` always holds in the output. The swap is a *parse*
 * concern; the emission door (`emitCondition`) rejects lo>=hi, it never
 * silently swaps.
 *
 * Layering: leaf — imports nothing.
 */

export type NumericOutcome =
  | { kind: 'range'; lo: number; hi: number } // lo < hi guaranteed (parser swaps hi-lo inputs)
  | { kind: 'above' | 'below' | 'at'; v: number };

export interface NumericOutcomeOpts {
  /** 'kmb': K/M/B suffixes; 'words': billion/million/thousand words;
   *  number: fixed multiplier (jobs ×1000, valuation ×1e9). Suffixes are
   *  OPT-IN — without the matching scale a suffixed token fails the parse
   *  (no silent "100K" → 100). */
  scale?: 'kmb' | 'words' | number;
  /** true ⇒ the label must carry a '%' (which is then stripped). Default:
   *  '%' is tolerated and stripped when present. */
  pct?: boolean;
  /** Permit a leading minus (PM_PCT GDP prints). Default: negative ⇒ null. */
  allowNegative?: boolean;
}

const WORD_MULT: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
const KMB_MULT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * Parse ONE numeric token: optional '$', comma-stripped digits, optional
 * scale suffix, optional '%'. Anchored — any leftover text fails the parse
 * (unit words like "goals" are the caller's regex concern, never silently
 * dropped here). Returns null on any gate failure.
 */
function parseScaledNumber(raw: string, opts?: NumericOutcomeOpts): number | null {
  let s = raw.trim();
  if (s === '') return null;
  s = s.replace(/^\$\s*/, '');     // '$' tolerance
  s = s.replace(/,/g, '');         // comma stripping
  s = s.replace(/\s*%\s*$/, '');   // '%' tolerance; the *requirement* (opts.pct) is checked at top level
  const m = /^(-?)(\d+(?:\.\d+)?)\s*(k|m|b|billion|million|thousand)?$/i.exec(s);
  if (!m) return null;
  const sign = m[1]!;
  const digits = m[2]!;
  const suffix = m[3]?.toLowerCase();
  if (sign === '-' && !opts?.allowNegative) return null;
  let mult = 1;
  if (suffix) {
    if (suffix.length === 1) {
      if (opts?.scale !== 'kmb') return null;
      mult = KMB_MULT[suffix]!;
    } else {
      if (opts?.scale !== 'words') return null;
      mult = WORD_MULT[suffix]!;
    }
  } else if (typeof opts?.scale === 'number') {
    mult = opts.scale; // fixed multiplier applies to bare numbers (jobs ×1000)
  }
  const n = parseFloat(`${sign}${digits}`);
  return Number.isFinite(n) ? n * mult : null;
}

/** Build a range outcome from two parsed bounds; swaps hi-lo inputs so lo<hi.
 *  Degenerate lo===hi collapses to an exact point ('at') — never a zero-width range. */
function rangeOutcome(loRaw: string, hiRaw: string, opts?: NumericOutcomeOpts): NumericOutcome | null {
  const a = parseScaledNumber(loRaw, opts);
  const b = parseScaledNumber(hiRaw, opts);
  if (a == null || b == null) return null;
  if (a === b) return { kind: 'at', v: a };
  return a < b ? { kind: 'range', lo: a, hi: b } : { kind: 'range', lo: b, hi: a };
}

function pointOutcome(kind: 'above' | 'below', raw: string, opts?: NumericOutcomeOpts): NumericOutcome | null {
  const v = parseScaledNumber(raw, opts);
  return v == null ? null : { kind, v };
}

/**
 * Parse a bucket / threshold outcome label into a NumericOutcome.
 *
 * Grammar (the union of the live parsers):
 *   '<' / '≤' / '＜' / '<=' prefix → below       '>' / '≥' / '>=' prefix → above
 *   'at least N' → above                         'fewer than N' → below
 *   'N or more|higher' → above                   'N or less|fewer|lower' → below
 *   'N+' → above
 *   'lo-hi' / 'lo–hi' / 'lo to hi' / 'between lo and hi' → range (hi-lo inputs swapped)
 *   bare N → at (exact-value bucket)
 * plus comma stripping, '$' tolerance, '%' tolerance/requirement (opts.pct),
 * K/M/B + word multipliers / fixed multiplier (opts.scale), opts.allowNegative.
 *
 * Returns null on anything outside the grammar (garbage in, null out — the
 * caller treats it as a template miss; unshaped beats unsound).
 */
export function parseNumericOutcome(label: string, opts?: NumericOutcomeOpts): NumericOutcome | null {
  if (typeof label !== 'string') return null;
  const s = label.trim();
  if (s === '') return null;
  if (opts?.pct && !s.includes('%')) return null; // pct: '%' suffix REQUIRED

  // 'between lo and hi'
  let m = /^between\s+(.+?)\s+and\s+(.+)$/i.exec(s);
  if (m) return rangeOutcome(m[1]!, m[2]!, opts);

  // comparator prefixes ('<=' / '>=' accepted as the ASCII spellings of ≤ / ≥)
  m = /^(?:<=|≤|＜|<)\s*(.+)$/.exec(s);
  if (m) return pointOutcome('below', m[1]!, opts);
  m = /^(?:>=|≥|>)\s*(.+)$/.exec(s);
  if (m) return pointOutcome('above', m[1]!, opts);

  // bounded phrases
  m = /^at\s+least\s+(.+)$/i.exec(s);
  if (m) return pointOutcome('above', m[1]!, opts);
  m = /^fewer\s+than\s+(.+)$/i.exec(s);
  if (m) return pointOutcome('below', m[1]!, opts);
  m = /^(.+?)\s+or\s+(?:more|higher)$/i.exec(s);
  if (m) return pointOutcome('above', m[1]!, opts);
  m = /^(.+?)\s+or\s+(?:less|fewer|lower)$/i.exec(s);
  if (m) return pointOutcome('below', m[1]!, opts);

  // 'N+' open top ('5%+' keeps the % inside the token; parseScaledNumber strips it)
  m = /^(.+?)\s*\+$/.exec(s);
  if (m) return pointOutcome('above', m[1]!, opts);

  // 'lo to hi'
  m = /^(.+?)\s+to\s+(.+)$/i.exec(s);
  if (m) {
    const r = rangeOutcome(m[1]!, m[2]!, opts);
    if (r) return r;
  }

  // en-dash range — '–' is never a minus sign in these labels.
  m = /^(.+?)\s*–\s*(.+)$/.exec(s);
  if (m) {
    const r = rangeOutcome(m[1]!, m[2]!, opts);
    if (r) return r;
  }

  // hyphen range — with allowNegative a '-' may be a sign, so try every split
  // position and take the first where BOTH sides parse ('-1--0.5' → [-1, -0.5]).
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] !== '-') continue;
    const r = rangeOutcome(s.slice(0, i), s.slice(i + 1), opts);
    if (r) return r;
  }

  // bare value → exact-value bucket
  const v = parseScaledNumber(s, opts);
  return v == null ? null : { kind: 'at', v };
}

/**
 * Fold a NumericOutcome into the snapshot-stamp fields. Range always folds
 * to direction 'between', decided here once; the `lo_hi<unit>`
 * null-direction condition_value encoding can no longer be produced by a
 * range arm.
 */
export function snapshotStamp(o: NumericOutcome): {
  shape: 'range_snapshot' | 'point_in_time';
  direction: 'between' | 'above' | 'below' | 'at';
  vp: number;
  vs: number | null;
} {
  if (o.kind === 'range') {
    return { shape: 'range_snapshot', direction: 'between', vp: o.lo, vs: o.hi };
  }
  return { shape: 'point_in_time', direction: o.kind, vp: o.v, vs: null };
}
