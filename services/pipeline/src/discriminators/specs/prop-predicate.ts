/**
 * Registry entry `prop_predicate`. Guard-only: it feeds the Stage-3
 * leg-coherence belt + telemetry only; no builder consumes it (the
 * `match_event_prop` kind is edge-inert by design, so recall is deferred). It
 * is not a fold key and is excluded from the certifier / fold-SQL (those
 * iterate `foldKeySpecs()` only).
 *
 * What it discriminates: `match_event_prop` markets are binary sub-game props
 * (esports "Game N: Both Teams Beat Roshan?", "First Blood in Game N?").
 * Stage-1 packs both the predicate and the game scope into `outcome_label` as
 * `"<predicate> | <scope>"`. Multiple independent predicates share one
 * fixture; a label-blind (ce, subject, metric) fold would collide them. This
 * discriminator lifts the predicate token so the leg-coherence belt refuses a
 * cross-predicate fusion generically.
 *
 * Extract: the predicate token is the part of outcome_label before the ' | '
 * scope separator (the scope — "game 2"/"map 1" — is game_ordinal's job;
 * keeping it here would falsely couple predicate with scope and could
 * false-drop a bare-scope leg). Null for a bare-scope-only label (no
 * predicate) or an absent label.
 *
 * The derived token is JSONB-only and does not dual-write the typed
 * outcome_label column: mirroring the whole column into the JSONB would store
 * "first blood | game 1" as the predicate, re-injecting the scope and
 * defeating cross-predicate detection. outcome_label stays fully
 * authoritative (it is always populated for this kind, so no NULL backfill
 * is ever needed).
 *
 * Stays guard-only rather than promoted to a fold key: match_event_prop
 * appears in no exhaustive outcome_sets today (the kind is edge-inert), so a
 * fold-key flip has no live effect. Promoting it would also carry a latent
 * recall risk once the kind is wired to a builder: `strict` demotes on a
 * known+NULL mix, and the derived predicate token is NULL for a
 * bare-scope-only label, so a fold-key would false-split a scope-only leg
 * from a predicate leg inside a future set.
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec } from '../registry.js';

const PROP_PREDICATE_KINDS: readonly EventKind[] = ['match_event_prop'];

/** Bare scope label (no predicate) — "game 1", "map 2", "set 3", "round 4". */
const BARE_SCOPE_RX = /^(?:game|map|set|round|series|leg|frame|period|half|quarter)\s+\d+$/i;

/** The predicate token carried in `outcome_label` before the ' | ' scope tag. */
export function extractPropPredicate(outcomeLabel: string | null | undefined): string | null {
  if (!outcomeLabel) return null;
  const label = outcomeLabel.trim();
  if (!label) return null;
  const pipe = label.indexOf('|');
  const pred = (pipe >= 0 ? label.slice(0, pipe) : label).trim().toLowerCase();
  if (!pred) return null;
  // A scope-only label carries no predicate → null (never a conflict source).
  if (pipe < 0 && BARE_SCOPE_RX.test(pred)) return null;
  return pred;
}

export const propPredicateSpec: DiscriminatorSpec = {
  name: 'prop_predicate',
  kinds: PROP_PREDICATE_KINDS,
  // Reads the gated outcome_label but does not dual-write it.
  source: 'gated-field',
  extract: (ctx) => extractPropPredicate(ctx.outcomeLabel),
  assertion: 'guard-only',
  nullPolicy: 'strict',
};
