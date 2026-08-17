/**
 * Deterministic `never_same_kind` PAIR rejecter (Stage-3b).
 *
 * A candidate whose two platform_events carry event_kinds forming one of these
 * unordered pairs is REJECTED without an LLM call: the pair is a structurally-
 * different question even on the SAME fixture (a "both teams to score" market and
 * a "match winner" market never resolve as the same real-world event — one is a
 * scoreline prop, the other the moneyline). Monotone-safe: a reject only SHRINKS
 * the match graph, so it can never manufacture a fake arb; the only residual risk
 * is recall loss.
 *
 * Deliberately EXCLUDED (kept with the LLM — do NOT add):
 *   - championship_winner × player_prop_threshold — a series/points-leader pair
 *     can legitimately be the same real-world event.
 *   - award_winner × championship_winner and
 *     championship_winner × election_outcome_winner — evidence too thin for a
 *     permanent gate; deferred until more decisions accumulate.
 *   - any `other × *` pairing — `other` is a catch-all kind, never a stable key.
 *
 * PURE / TOTAL / order-independent (unit-tested in
 * `never-same-kind-pairs.test.ts`). Candidate for later promotion into the
 * generation-side gate (`guards.ts` NEVER_SAME_EVENT + stage4 `same-event.ts`
 * NEVER_SAME_EVENT) for full parity — those files are owned elsewhere, so this
 * confirm-pass rejecter is the shipping locus that captures the LLM-call saving.
 */

/** Canonical unordered key for a kind pair. */
function pairKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * The 3 validated `never_same_kind` pairs (ship set). Unordered — membership is
 * tested via `pairKey`, not raw equality.
 */
export const NEVER_SAME_KIND_PAIRS: ReadonlySet<string> = new Set([
  pairKey('both_teams_score', 'match_winner'),
  pairKey('exact_score', 'match_total_metric'),
  pairKey('championship_winner', 'match_winner'),
]);

// `exact_score × match_winner` is DELIBERATELY NOT ADDED to this set. This
// rejecter keys EVENT-level candidate pairs, and "Ajax vs Utrecht" /
// "AFC Ajax vs. FC Utrecht - Exact Score" ARE one fixture — merging the EVENTS
// is correct. The fake is not the event merge but the co-homing of a
// scoreline OUTCOME onto a moneyline OUTCOME inside the fused event, which is
// handled where it actually happens: the outcome-GRAIN partition
// (util/outcome-grain.ts `outcomeGrainFromFacts` + finalize's feed-A
// `partitionByGrain`) and the certifier's grain-homogeneity backstop. Gating
// here would cost real fixture merges and fix nothing the grain partition
// does not already fix.

/**
 * TRUE iff the two event_kinds form a validated never-same-kind pair (⇒ reject
 * the candidate). Both kinds must be non-null (a NULL kind = unshaped side ⇒
 * defer, never reject on a coarse key). Order-independent.
 */
export function isNeverSameKindPair(ka: string | null, kb: string | null): boolean {
  if (ka == null || kb == null) return false;
  return NEVER_SAME_KIND_PAIRS.has(pairKey(ka, kb));
}

/** Per-cell reject reason tag (distinct per pair so a census can attribute
 *  every skipped candidate). */
export function neverSameKindTag(ka: string, kb: string): string {
  const [x, y] = ka <= kb ? [ka, kb] : [kb, ka];
  return `deterministic: never-same-kind pair (${x}×${y})`;
}
