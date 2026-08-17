/** Half-line parsing: ONE deterministic reading of "which numeric YES-region does
 *  this market claim?", shared by the persist-door gate and the re-verification
 *  sweep; collapses to the strict-inclusive INTEGER YES-boundary. Leaf util, pure. */

import { INTEGER_GRAIN_UNITS } from './condition-shape.js';
import { isIntegerGrainUnit } from './threshold-canonical.js';

export type Side = 'above' | 'below' | 'at';
export type Strictness = 'strict' | 'inclusive';

export interface HalfLine {
  side: Side;
  /** Meaningful only when `integral` is true. */
  bound: number;
  /** Comparison key for CONTINUOUS units, where `bound` would cause a fake ±1 conflict. */
  raw: number;
  integral: boolean;
}

const toNum = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const isHalf = (x: number): boolean =>
  Number.isFinite(x) && Math.abs((x * 2) - Math.round(x * 2)) < 1e-9 && !Number.isInteger(x);

const isIntGrainCompatible = (raw: number): boolean => Number.isInteger(raw);

function aboveBound(value: number, strict: boolean): number {
  return strict
    ? (Number.isInteger(value) ? value + 1 : Math.ceil(value))
    : Math.ceil(value);
}
function belowBound(value: number, strict: boolean): number {
  return strict
    ? (Number.isInteger(value) ? value - 1 : Math.floor(value))
    : Math.floor(value);
}

export function makeHalfLine(side: Side, value: number, strictness: Strictness, integral = true): HalfLine | null {
  if (!Number.isFinite(value)) return null;
  if (side === 'at') return { side, bound: value, raw: value, integral };
  const strict = strictness === 'strict';
  const bound = side === 'above' ? aboveBound(value, strict) : belowBound(value, strict);
  return { side, bound, raw: value, integral };
}

export function halfLineKey(h: HalfLine): string {
  return h.integral ? `${h.side}:${h.bound}` : `${h.side}@${h.raw}`;
}

/** Different side always conflicts; same-grain pairs compare `bound`, else `raw`. */
export function halfLinesConflict(a: HalfLine | null, b: HalfLine | null): boolean {
  if (!a || !b) return false;
  if (a.side !== b.side) return true;
  if (a.integral && b.integral) return a.bound !== b.bound;
  if (a.integral !== b.integral) {
    const unknown = a.integral ? b : a; // adopt known grain only if unknown's raw is a clean integer
    return isIntGrainCompatible(unknown.raw) ? a.bound !== b.bound : false;
  }
  return Math.abs(a.raw - b.raw) > 1e-9;
}

/** Feed-A's member link bypasses the persist-door gate -- keep the sites in sync. */
export interface HalfLineMemberRef {
  market_id: number;
  half_line: HalfLine | null;
}

/** Prefers the member closest to the slug line; falls back to the plurality group. */
export function chooseKeepHalfLine(slug: HalfLine | null, members: HalfLineMemberRef[]): HalfLine | null {
  const readable = members.filter((m) => m.half_line != null);
  if (readable.length === 0) return null;
  if (slug) {
    const sameSide = readable.filter((m) => m.half_line!.side === slug.side);
    const pool = sameSide.length > 0 ? sameSide : readable;
    let best = pool[0];
    for (const m of pool) {
      const dm = Math.abs(m.half_line!.bound - slug.bound);
      const db = Math.abs(best.half_line!.bound - slug.bound);
      if (dm < db) { best = m; continue; }
      if (dm === db) {
        const mExact = m.half_line!.raw === slug.raw, bExact = best.half_line!.raw === slug.raw;
        if (mExact && !bExact) { best = m; continue; }
        if (mExact === bExact && m.market_id < best.market_id) best = m;
      }
    }
    return best.half_line;
  }
  const counts = new Map<string, { n: number; minMid: number; hl: HalfLine }>();
  for (const m of readable) {
    const k = halfLineKey(m.half_line!);
    const c = counts.get(k);
    if (c) { c.n++; c.minMid = Math.min(c.minMid, m.market_id); }
    else counts.set(k, { n: 1, minMid: m.market_id, hl: m.half_line! });
  }
  let best: { n: number; minMid: number; hl: HalfLine } | null = null;
  for (const c of counts.values()) {
    if (best == null || c.n > best.n || (c.n === best.n && c.minMid < best.minMid)) best = c;
  }
  return best?.hl ?? null;
}

/** market_ids whose half-line provably conflicts with the kept representative. */
export function halfLineFoldDropMarketIds(slug: HalfLine | null, members: HalfLineMemberRef[]): number[] {
  const readable = members.filter((m) => m.half_line != null);
  let conflict = false;
  for (let i = 0; i < readable.length && !conflict; i++) {
    for (let j = i + 1; j < readable.length; j++) {
      if (halfLinesConflict(readable[i].half_line, readable[j].half_line)) { conflict = true; break; }
    }
  }
  if (!conflict) return [];
  const keep = chooseKeepHalfLine(slug, members);
  if (keep == null) return [];
  return readable.filter((m) => halfLinesConflict(m.half_line, keep)).map((m) => m.market_id);
}

const CONTINUOUS_TITLE_RX = /(%|\bpercent|\bpercentage|\$|\bprice\b|\bdollar|\bbps\b|\bbasis\s+points?\b|\bindex\b)/i;

/** Multi-word count nouns the single-word title split can't see; checked after CONTINUOUS_TITLE_RX. */
const COMPOUND_INTEGER_GRAIN_RX =
  /\b(?:(?:total|stolen)\s+bases?|executive\s+orders?|primary\s+loss(?:es)?|shots?\s+on\s+target|outs?\s+recorded|(?:rushing|passing|receiving)\s+(?:yards?|touchdowns?)|teams?\s+remaining|free\s+throws?)\b/i;

/** Unknown unit defaults to continuous, so it compares on raw and never fakes a ±1 conflict. */
export function classifyIntegral(unit: string | null, title: string | null, raw: number): boolean {
  if (unit != null && unit.trim() !== '') return isIntegerGrainUnit(unit);
  if (title) {
    if (CONTINUOUS_TITLE_RX.test(title)) return false;
    if (COMPOUND_INTEGER_GRAIN_RX.test(title)) return true; // multi-word count units
    for (const w of title.toLowerCase().split(/[^a-z]+/)) {
      if (w && INTEGER_GRAIN_UNITS.has(w)) return true;
    }
  }
  if (isHalf(raw)) return true;
  return false;
}

export interface KalshiStrikeFacts {
  strike_type: string | null;
  floor_strike: number | string | null;
  cap_strike: number | string | null;
  custom_strike?: string | null;
}

/** Null for a non-degenerate `between` (a range, not a single line). */
export function parseKalshiHalfLine(f: KalshiStrikeFacts): HalfLine | null {
  let st = f.strike_type?.toLowerCase() ?? null;
  let floor = toNum(f.floor_strike);
  let cap = toNum(f.cap_strike); // may unwrap a nested custom_strike below
  if ((st == null || st === 'custom' || st === 'structured') && f.custom_strike) {
    try {
      const nested = JSON.parse(f.custom_strike) as {
        strike_type?: unknown; floor_strike?: unknown; cap_strike?: unknown;
      };
      if (typeof nested.strike_type === 'string') st = nested.strike_type.toLowerCase();
      if (floor == null && typeof nested.floor_strike === 'string') floor = toNum(nested.floor_strike);
      if (cap == null && typeof nested.cap_strike === 'string') cap = toNum(nested.cap_strike);
    } catch { /* not JSON */ }
  }
  const ig = (v: number) => classifyIntegral(null, null, v);
  if (st === 'greater') return floor != null ? makeHalfLine('above', floor, 'strict', ig(floor)) : null;
  if (st === 'greater_or_equal') return floor != null ? makeHalfLine('above', floor, 'inclusive', ig(floor)) : null;
  if (st === 'less') return cap != null ? makeHalfLine('below', cap, 'strict', ig(cap)) : null;
  if (st === 'less_or_equal') return cap != null ? makeHalfLine('below', cap, 'inclusive', ig(cap)) : null;
  if (st === 'between') {
    if (floor != null && cap != null && floor === cap) return makeHalfLine('at', floor, 'inclusive', ig(floor));
    return null;
  }
  return null;
}

export interface NormHalfLineFacts {
  condition_direction: string | null;
  value_primary: number | string | null;
  value_unit?: string | null;
}

/** value_primary is already the canonical boundary, treated as inclusive: ceil(2.5)=3. */
export function parseNormHalfLine(f: NormHalfLineFacts): HalfLine | null {
  const v = toNum(f.value_primary);
  if (v == null) return null;
  const d = f.condition_direction?.toLowerCase();
  const integral = classifyIntegral(f.value_unit ?? null, null, v);
  if (d === 'above' || d === 'greater' || d === 'greater_or_equal') return makeHalfLine('above', v, 'inclusive', integral);
  if (d === 'below' || d === 'less' || d === 'less_or_equal') return makeHalfLine('below', v, 'inclusive', integral);
  if (d === 'at') return makeHalfLine('at', v, 'inclusive', integral);
  return null;
}

// (?<!no\s)(?<!not\s): "NO more than 3" is an inclusive BELOW, not a strict above.
const TEXT_STRICT_ABOVE = /(?<!no\s)(?<!not\s)\b(?:more\s+than|greater\s+than|over)\s+(\d+(?:\.\d+)?)\b/i;
const TEXT_STRICT_BELOW = /\b(?:fewer\s+than|less\s+than|under)\s+(\d+(?:\.\d+)?)\b/i;
const TEXT_INCL_ABOVE_PRE = /\b(?:at\s+least)\s+(\d+(?:\.\d+)?)\b/i;
// no trailing \b: "3+" has no word boundary after the '+'
const TEXT_INCL_ABOVE_POST = /\b(\d+(?:\.\d+)?)\s*(?:\+|\bplus\b|or\s+(?:more|greater|higher|better))/i;
const TEXT_INCL_BELOW_POST = /\b(\d+(?:\.\d+)?)\s*(?:or\s+(?:fewer|less|lower))/i;
const TEXT_INCL_BELOW_PRE = /\b(?:at\s+most|no\s+more\s+than)\s+(\d+(?:\.\d+)?)\b/i;
const TEXT_EXACTLY = /\bexactly\s+(\d+(?:\.\d+)?)\b/i;

/** Order matters: "exactly" first, then strict "more than" before the inclusive scan. */
export function parseTextHalfLine(title: string | null): HalfLine | null {
  if (!title) return null;
  const ig = (v: number) => classifyIntegral(null, title, v);
  let m: RegExpMatchArray | null;
  if ((m = title.match(TEXT_EXACTLY))) return makeHalfLine('at', Number(m[1]), 'inclusive', ig(Number(m[1])));
  if ((m = title.match(TEXT_STRICT_ABOVE))) return makeHalfLine('above', Number(m[1]), 'strict', ig(Number(m[1])));
  if ((m = title.match(TEXT_STRICT_BELOW))) return makeHalfLine('below', Number(m[1]), 'strict', ig(Number(m[1])));
  if ((m = title.match(TEXT_INCL_ABOVE_PRE))) return makeHalfLine('above', Number(m[1]), 'inclusive', ig(Number(m[1])));
  if ((m = title.match(TEXT_INCL_BELOW_PRE))) return makeHalfLine('below', Number(m[1]), 'inclusive', ig(Number(m[1])));
  if ((m = title.match(TEXT_INCL_BELOW_POST))) return makeHalfLine('below', Number(m[1]), 'inclusive', ig(Number(m[1])));
  if ((m = title.match(TEXT_INCL_ABOVE_POST))) return makeHalfLine('above', Number(m[1]), 'inclusive', ig(Number(m[1])));
  return null;
}

const SLUG_RX =
  /(?:^|[^a-z0-9])(ge|gte|above|over|gt|atleast|le|lte|below|under|lt|nomore|eq|at)[_-]?(\d+(?:[._]\d+)?)/i;
const SLUG_PLUS_RX = /(?:^|[^a-z0-9])(\d+(?:[._]\d+)?)[_-]?(plus|ormore|orfewer|orless)/i;

export function parseSlugHalfLine(slug: string | null): HalfLine | null {
  if (!slug) return null;
  const s = slug.toLowerCase();
  let m = s.match(SLUG_RX);
  if (m) {
    const value = Number(m[2].replace('_', '.'));
    if (!Number.isFinite(value)) return null;
    const tok = m[1];
    if (tok === 'eq' || tok === 'at') return makeHalfLine('at', value, 'inclusive');
    const above = tok === 'ge' || tok === 'gte' || tok === 'above' || tok === 'over' || tok === 'gt' || tok === 'atleast';
    const strict = tok === 'over' || tok === 'gt' || tok === 'under' || tok === 'lt';
    return makeHalfLine(above ? 'above' : 'below', value, strict ? 'strict' : 'inclusive');
  }
  m = s.match(SLUG_PLUS_RX);
  if (m) {
    const value = Number(m[1].replace('_', '.'));
    if (!Number.isFinite(value)) return null;
    const below = m[2] === 'orfewer' || m[2] === 'orless';
    return makeHalfLine(below ? 'below' : 'above', value, 'inclusive');
  }
  return null;
}

export interface MemberFacts extends KalshiStrikeFacts, NormHalfLineFacts {
  title: string | null;
}

/** Precedence order: shaped normalization, then Kalshi strike metadata, then title regex. */
export function parseMemberHalfLine(f: MemberFacts): HalfLine | null {
  const hl = parseNormHalfLine(f) ?? parseKalshiHalfLine(f) ?? parseTextHalfLine(f.title);
  if (hl == null) return hl;
  const integral = classifyIntegral(f.value_unit ?? null, f.title, hl.raw); // re-stamp from the full signal set
  return integral === hl.integral ? hl : { ...hl, integral };
}
