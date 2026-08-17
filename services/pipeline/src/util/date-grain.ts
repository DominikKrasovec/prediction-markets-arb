/**
 * Precision-aware condition_date grain comparison, shared by the Stage-3
 * validateMatch leg guard (guards.ts) and the Stage-4 question-mint
 * member-cohesion belt (member-cohesion.ts), which mirror each other's
 * semantics.
 *
 * condition_date_precision records how much of a padded ISO date is real
 * ('2026-01-01' precision 'year' means "in 2026", not January 1st). Doctrine:
 * compare at the coarser of the two stamped precisions; a coarse date behaves
 * closer to NULL (unknown never refuses) than to a precise day.
 *
 * The full-day + candle grain keys (dayGrainKey / exactTimestampKey) live
 * here too; both guards import them rather than keeping their own copies.
 */
import { foldTextKey } from './sql-fragments.js';

/** Day-grain key for a condition_date TEXT value: the literal YYYY-MM-DD prefix
 * when present (timezone-free — '2026-05-13' and '2026-05-13T20:10:00' agree),
 * else the folded raw string. */
export function dayGrainKey(d: string): string {
  const t = d.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : (foldTextKey(t) as string);
}

/**
 * Exact-timestamp key for candle condition_dates. Naive timestamps (no zone
 * suffix) are anchored as UTC so both sides use ONE convention — Stage-1 emits
 * the candle family uniformly ('...T16:00:00Z'), so this only matters for
 * defensive cross-format pairs. Unparseable values fall back to the folded text.
 */
export function exactTimestampKey(d: string): string {
  const t = d.trim();
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(t);
  const ms = Date.parse(hasZone ? t : t + 'Z');
  return Number.isFinite(ms) ? String(ms) : (foldTextKey(t) as string);
}

/** Coarseness rank of a condition_date_precision (higher = coarser). NULL or
 *  unknown ranks like 'day' — the default for unstamped rows. */
export function precisionRank(p: string | null | undefined): number {
  switch ((p ?? '').toLowerCase()) {
    case 'year': return 3;
    case 'month': return 2;
    default: return 1; // day / minute / NULL → day-grain compare
  }
}

/**
 * Grain key of an ISO-leading date string at an explicit coarseness rank:
 * 3 → 'YYYY', 2 → 'YYYY-MM', else 'YYYY-MM-DD'. Non-ISO strings fold to
 * lower-cased trimmed text.
 */
export function grainKeyAt(d: string, rank: number): string {
  const t = d.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return t.toLowerCase();
  if (rank >= 3) return t.slice(0, 4);
  if (rank === 2) return t.slice(0, 7);
  return t.slice(0, 10);
}
