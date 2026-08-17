/**
 * Parlay leg parser — extracts atomic AND-clauses from a market title, e.g.
 *   "yes Cade Cunningham: 25+,yes Franz Wagner: 10+,no Over 219.5 points scored"
 * A leg that doesn't parse confidently is marked `kind='unknown'`, which
 * disables downstream dominance/implication checks for that pair.
 */

type LegPolarity = 'yes' | 'no';
type LegUnit = 'points' | 'runs' | 'goals';

export type Leg =
  | { kind: 'threshold'; polarity: LegPolarity; entity: string; value: number; raw: string }
  | { kind: 'spread'; polarity: LegPolarity; entity: string; value: number; unit: LegUnit; raw: string }
  | { kind: 'total'; polarity: LegPolarity; value: number; unit: LegUnit; raw: string }
  | { kind: 'binary'; polarity: LegPolarity; entity: string; raw: string }
  | { kind: 'unknown'; raw: string };

const LEG_THRESHOLD = /^(yes|no)\s+(.+?):\s*(\d+(?:\.\d+)?)\+$/i;
const LEG_SPREAD   = /^(yes|no)\s+(.+?)\s+wins\s+by\s+over\s+(\d+(?:\.\d+)?)\s+(points?|runs?|goals?)$/i;
const LEG_TOTAL    = /^(yes|no)\s+over\s+(\d+(?:\.\d+)?)\s+(points|runs|goals)\s+scored$/i;
const LEG_BINARY   = /^(yes|no)\s+(.+?)$/i;

function normUnit(s: string): LegUnit {
  const l = s.toLowerCase();
  if (l.startsWith('point')) return 'points';
  if (l.startsWith('run')) return 'runs';
  return 'goals';
}

function normEntity(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function parseLeg(raw: string): Leg {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'unknown', raw };

  let m = LEG_THRESHOLD.exec(trimmed);
  if (m) {
    return {
      kind: 'threshold',
      polarity: m[1].toLowerCase() as LegPolarity,
      entity: normEntity(m[2]),
      value: Number(m[3]),
      raw: trimmed,
    };
  }

  m = LEG_SPREAD.exec(trimmed);
  if (m) {
    return {
      kind: 'spread',
      polarity: m[1].toLowerCase() as LegPolarity,
      entity: normEntity(m[2]),
      value: Number(m[3]),
      unit: normUnit(m[4]),
      raw: trimmed,
    };
  }

  m = LEG_TOTAL.exec(trimmed);
  if (m) {
    return {
      kind: 'total',
      polarity: m[1].toLowerCase() as LegPolarity,
      value: Number(m[2]),
      unit: normUnit(m[3]),
      raw: trimmed,
    };
  }

  m = LEG_BINARY.exec(trimmed);
  if (m) {
    const entity = normEntity(m[2]);
    // Refuse a binary parse if grammar hints (":", "+", spread/total phrasing)
    // survived unmatched — avoids a silent mis-parse of another leg kind.
    if (entity.includes(':') || entity.includes('+')) {
      return { kind: 'unknown', raw };
    }
    if (/\bwins by over\b/.test(entity)) return { kind: 'unknown', raw };
    if (/\bover\b.*\bscored\b/.test(entity)) return { kind: 'unknown', raw };
    return {
      kind: 'binary',
      polarity: m[1].toLowerCase() as LegPolarity,
      entity,
      raw: trimmed,
    };
  }

  return { kind: 'unknown', raw };
}

export function parseParlayLegs(title: string | null): Leg[] | null {
  if (!title) return null;
  if (!title.includes(',')) return null;
  const parts = title.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const legs = parts.map(parseLeg);
  // Any `unknown` leg means the comma-split wasn't actually a parlay (e.g. a
  // date/time range) — reject the whole parse rather than misclassify it.
  if (legs.some((l) => l.kind === 'unknown')) return null;
  return legs;
}

/** True when a market is a multi-leg combination parlay (book-stitched,
 *  unprofitable) that must not be written into the canonical `markets` table. */
export function isParlayMarket(args: {
  platform: string;
  platformId: string;
  title: string | null;
}): boolean {
  if (args.platform === 'kalshi' && /^KXMVE/i.test(args.platformId)) return true;
  return parseParlayLegs(args.title) !== null;
}

// condition_value can also encode legs as " AND "-joined fragments; unlike
// parseParlayLegs, a single-fragment result is accepted here.
export function parseLegsFromConditionValue(conditionValue: string | null | undefined): Leg[] | null {
  if (!conditionValue) return null;
  const parts = conditionValue.split(' AND ').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const legs = parts.map(parseLeg);
  if (legs.some((l) => l.kind === 'unknown')) return null;
  return legs;
}

// A dominates B iff assuming A true, B is necessarily true (A is at least as
// strict). 'contradicts' = A and B cannot both be true; 'neither' = no claim.
export function legRelation(a: Leg, b: Leg): 'dominates' | 'contradicts' | 'neither' {
  if (a.kind === 'unknown' || b.kind === 'unknown') return 'neither';

  if (a.kind === 'threshold' && b.kind === 'threshold' && a.entity === b.entity) {
    if (a.polarity === b.polarity) {
      if (a.polarity === 'yes') return a.value >= b.value ? 'dominates' : 'neither';
      return a.value <= b.value ? 'dominates' : 'neither';
    }
    if (a.polarity === 'yes' && b.polarity === 'no') {
      return a.value >= b.value ? 'contradicts' : 'neither';
    }
    return b.value >= a.value ? 'contradicts' : 'neither';
  }

  if (a.kind === 'spread' && b.kind === 'spread' && a.entity === b.entity && a.unit === b.unit && a.polarity === b.polarity) {
    if (a.polarity === 'yes') return a.value >= b.value ? 'dominates' : 'neither';
    return a.value <= b.value ? 'dominates' : 'neither';
  }

  if (a.kind === 'total' && b.kind === 'total' && a.unit === b.unit) {
    if (a.polarity === b.polarity) {
      if (a.polarity === 'yes') return a.value >= b.value ? 'dominates' : 'neither';
      return a.value <= b.value ? 'dominates' : 'neither';
    }
    if (a.polarity === 'yes' && b.polarity === 'no') {
      return a.value >= b.value ? 'contradicts' : 'neither';
    }
    return b.value >= a.value ? 'contradicts' : 'neither';
  }

  if (a.kind === 'binary' && b.kind === 'binary' && a.entity === b.entity) {
    if (a.polarity === b.polarity) return 'dominates';
    return 'contradicts';
  }

  return 'neither';
}

function isSelfContradictory(legs: Leg[]): boolean {
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (legRelation(legs[i], legs[j]) === 'contradicts') return true;
    }
  }
  return false;
}

// True when a parlay carries >=2 `total` legs for the same unit — those totals
// belong to different games, so matching them across parlays would be unsound.
function isMultiGameTotals(legs: Leg[]): boolean {
  const countPerUnit = new Map<LegUnit, number>();
  for (const l of legs) {
    if (l.kind === 'total') {
      countPerUnit.set(l.unit, (countPerUnit.get(l.unit) ?? 0) + 1);
    }
  }
  return [...countPerUnit.values()].some(c => c >= 2);
}

// 'implies': every leg in B is dominated by some leg in A. 'excludes': some
// leg pair contradicts (checked first — exclusion wins over implication).
export function parlayDominance(a: Leg[], b: Leg[]): 'implies' | 'excludes' | null {
  if (a.some((l) => l.kind === 'unknown')) return null;
  if (b.some((l) => l.kind === 'unknown')) return null;
  if (isMultiGameTotals(a) || isMultiGameTotals(b)) return null;
  if (isSelfContradictory(a) || isSelfContradictory(b)) return null;

  for (const la of a) {
    for (const lb of b) {
      if (legRelation(la, lb) === 'contradicts') return 'excludes';
    }
  }

  for (const lb of b) {
    let dominated = false;
    for (const la of a) {
      if (legRelation(la, lb) === 'dominates') { dominated = true; break; }
    }
    if (!dominated) return null;
  }
  return 'implies';
}

// MVE (Multi-Venue Event = Kalshi structured parlay) leg set is written to
// condition_value as " AND "-joined "<side>|<ticker>" fragments; these
// helpers compute the relation via set operations, not the title-regex path.

export interface MveLeg {
  side: 'yes' | 'no';
  ticker: string; // Kalshi market_ticker (FK into kalshi_markets.ticker)
}

export function parseMveLegSet(conditionValue: string | null | undefined): Set<string> | null {
  if (!conditionValue) return null;
  const parts = conditionValue.split(' AND ').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const result = new Set<string>();
  for (const part of parts) {
    const m = part.match(/^(yes|no)\|(K[A-Z0-9-]+)$/);
    if (!m) return null;
    result.add(`${m[1]}|${m[2]}`);
  }
  return result;
}

// a_implies_b: A's leg set is a strict superset of B's (more required
// conditions ⟹ A YES ⟹ B YES); b_implies_a is the mirror.
export function mveSetRelation(
  a: Set<string>,
  b: Set<string>,
): 'mutual_exclusion' | 'equivalence' | 'a_implies_b' | 'b_implies_a' | null {
  const aSideByTicker = new Map<string, 'yes' | 'no'>();
  for (const k of a) {
    const idx = k.indexOf('|');
    aSideByTicker.set(k.slice(idx + 1), k.slice(0, idx) as 'yes' | 'no');
  }
  for (const k of b) {
    const idx = k.indexOf('|');
    const ticker = k.slice(idx + 1);
    const bSide = k.slice(0, idx) as 'yes' | 'no';
    const aSide = aSideByTicker.get(ticker);
    if (aSide !== undefined && aSide !== bSide) return 'mutual_exclusion';
  }

  if (a.size === b.size) {
    for (const k of a) if (!b.has(k)) return null;
    return 'equivalence';
  }
  if (a.size > b.size) {
    for (const k of b) if (!a.has(k)) return null;
    return 'a_implies_b';
  }
  for (const k of a) if (!b.has(k)) return null;
  return 'b_implies_a';
}
