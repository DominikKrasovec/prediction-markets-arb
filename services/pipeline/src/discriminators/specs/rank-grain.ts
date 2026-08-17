/**
 * Registry entry — `rank_grain`. Surfaces the rank convention: a value ladder
 * over a RANK ("finish rank ≤ N", "win / place first") is stamped
 * `value_unit = 'rank'` with the rank number in `value_primary`.
 *
 * WHY guard-only (not fold-key): the rank number is NOT an event-identity or a set
 * partition key — a "rank ≤ 1" and a "rank ≤ 2" market of the SAME race ARE a
 * nested ladder (the primary_rank_ladder builder owns that). The registry
 * value drives the generic Stage-3 leg-coherence belt (block-when-sibling-known):
 * within one fused outcome, a NULL-rank leg entering a fold where a sibling's rank
 * is known — or two legs with DIFFERENT known ranks — is dropped. This generalizes
 * the hand-keyed title guards (guards.ts ADVANCE_TITLE_RX + confirm-deterministic.ts)
 * that this spec de-loads to `belt.rank_title_guard` (those title guards + the
 * primary_rank_ladder activation are a separate item — not touched here; this
 * spec only makes the value AVAILABLE).
 *
 * DEVIATION from a literal `gatedField: value_primary` (stamp semantics): the
 * stamp's gatedField MIRROR copies the FINAL typed column into the JSONB
 * whenever it is non-null, IGNORING the extract's unit gate — so
 * `gatedField: 'value_primary'` would mirror value_primary for EVERY valued
 * market (a price threshold 200000 → rank_grain='200000'), a gross over-stamp.
 * Modeled as a JSONB-only spec whose extract returns the rank ONLY when
 * value_unit='rank', which honors the rank convention exactly. value_primary
 * stays authoritative untouched (it is already handler-set; there is no
 * NULL-fill case to dual-write anyway).
 *
 * nullPolicy block-when-sibling-known — the safe direction for ranks (a NULL rank
 * must never silently fold into a known-rank sibling); the Stage-4 fold conjunct is
 * unused (assertion is guard-only, not fold-key).
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

/** Kinds that carry the rank convention. `award_winner` covers the dedicated
 *  kalshi WINNER handlers that stamp value_unit='rank'/value_primary=1, so
 *  the generic Stage-3 block-when-sibling-known belt can coalesce their
 *  legs against any sibling that also stamps rank. Guard-only: this enables
 *  the Stage-3 coherence check only, no fold-key/partition change. */
const RANK_GRAIN_KINDS: readonly EventKind[] = [
  'championship_winner',
  'award_winner',
  'player_prop_threshold',
  'election_outcome_winner',
  'other',
];

/** The rank value, or null. Fires ONLY on the 'rank' unit convention. */
export function extractRankGrain(ctx: ExtractCtx): string | null {
  if ((ctx.gated.value_unit as string | null) !== 'rank') return null;
  const v = ctx.gated.value_primary as number | null;
  return v == null ? null : String(v);
}

export const rankGrainSpec: DiscriminatorSpec = {
  name: 'rank_grain',
  kinds: RANK_GRAIN_KINDS,
  source: 'gated-field',
  extract: extractRankGrain,
  // JSONB-only (see DEVIATION above) — value_primary is not dual-written.
  assertion: 'guard-only',
  nullPolicy: 'block-when-sibling-known',
};
