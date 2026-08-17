/**
 * Predicates over `llm_market_normalizations.match_source`.
 *
 * `match_source` is the free-text tag identifying which Stage 1 code path
 * produced a normalization row. Kalshi parlay subtypes share the family
 * prefix `kalshi:parlay:<subtype>` — currently only `kalshi:parlay:mve`, but
 * the design admits future subtypes without code changes on the consumer
 * side.
 *
 * This module is the single source of truth for "is this row a parlay". SQL
 * queries and TS-side checks must route through these helpers rather than
 * open-coding the pattern, since a tweak to the convention would otherwise
 * silently miss callers.
 */

/**
 * Canonical prefix for all Kalshi parlay match_source values.
 * Constants over inline strings so any future audit can grep for one symbol.
 */
export const KALSHI_PARLAY_PREFIX = 'kalshi:parlay:';

/** Implementation detail — the `LIKE` pattern that admits the prefix family. */
const PARLAY_LIKE_PATTERN = "'kalshi:parlay%'";

/**
 * SQL fragment: `<alias>.match_source` is a Kalshi parlay subtype.
 *
 * NULL match_source → false (i.e. "non-parlay" — consistent with the
 * complementary helper below).  Use when you want to single OUT parlays
 * (e.g. wipe scripts, completion gates that accept parlays as "done").
 */
export const isParlaySql = (alias: string): string =>
  `${alias}.match_source LIKE ${PARLAY_LIKE_PATTERN}`;

/**
 * SQL fragment: `<alias>.match_source` is NOT a Kalshi parlay subtype.
 *
 * NULL match_source → true.  Markets without a normalization row are treated
 * as non-parlay so they remain eligible for embedding / ANN; the LLM-pending
 * tail of Stage 1 still needs to flow through downstream stages.
 *
 * Wraps in parens so callers can paste it after `AND` / `OR` without
 * ambiguity.
 */
export const notParlaySql = (alias: string): string =>
  `(${alias}.match_source IS NULL OR ${alias}.match_source NOT LIKE ${PARLAY_LIKE_PATTERN})`;

/**
 * TS-side counterpart for code that already holds a match_source string in
 * memory (no SQL round-trip needed).  Mirrors the SQL semantics:
 * NULL / undefined → false.
 */
export function isParlayMatchSource(matchSource: string | null | undefined): boolean {
  return matchSource != null && matchSource.startsWith(KALSHI_PARLAY_PREFIX);
}

/**
 * Load the set of `question.id` values whose members include at least one
 * parlay market.  Used by Stage 2 to pre-filter parlay questions out of IN
 * lists passed to ANN / shared-participants queries:
 *
 *   - Parlay markets still have legacy embeddings in `markets.embedding` and
 *     are not deleted — they remain available for any future cross-platform
 *     parlay-leg rule.
 *   - The existing ANN / shared-participants queries already drop them at the
 *     SQL level via `notParlaySql()`, but only after bringing them in through
 *     `m.id = ANY($1::int[])` + JOIN + filter, which dominates cost at scale.
 *   - Filtering parlay question_ids out of the IN list in JS first skips the
 *     index scan + JOIN entirely for reps that would produce zero rows
 *     downstream.
 *
 * Single round-trip; result is a Set so callers can do O(1) `.has()` checks.
 *
 * Imported lazily by callers to avoid a circular dep through the queries
 * barrel — must keep this file dep-free aside from `@arb/db`.
 */
import { query } from '@arb/db';

export async function loadParlayQuestionIds(): Promise<Set<number>> {
  const rows = await query<{ qid: number }>(
    `SELECT DISTINCT qm.question_id AS qid
       FROM question_members qm
       JOIN llm_market_normalizations n ON n.market_id = qm.market_id
      WHERE ${isParlaySql('n')}`,
  );
  return new Set(rows.map((r) => r.qid));
}

/**
 * Load all active non-parlay question IDs. Uses the partial index
 * `idx_questions_non_parlay_active` for a direct index scan.
 *
 * Used by Stage 2 in full-scan mode (when nothing's in `stage23_queue`) to
 * unify the chunked discovery path with the incremental one, so full-scan
 * completes under statement_timeout instead of running one giant query.
 */
export async function loadNonParlayActiveQuestionIds(): Promise<number[]> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM questions WHERE is_parlay = FALSE AND archived_at IS NULL`,
  );
  return rows.map((r) => r.id);
}
