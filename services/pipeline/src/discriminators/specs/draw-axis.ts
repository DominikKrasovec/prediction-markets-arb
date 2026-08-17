/**
 * Registry entry — `draw_axis`. Guard-only (excluded from foldKeySpecs()):
 * tags each row in a draw-capable fixture as 'draw' or 'decisive' so the
 * Stage-3 leg-coherence belt refuses a draw↔decisive fusion. Must never
 * become a set group-key — the {TeamA, TeamB, Draw} outcome_set is a
 * legitimate 3-way mutex, and adding this axis to the GROUP-BY would shatter
 * it into singletons and destroy the tradeable mutex.
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

/** award_winner "tie/co-winners" is a different semantic (shared award, not a fixture
 *  draw) and is deliberately excluded. */
export const DRAW_AXIS_KINDS: readonly EventKind[] = ['match_winner', 'halftime_leader', 'both_teams_score'];

/** Exact tokens, not a loose regex — 'tiebreaker' must NOT match. */
export const DRAW_TOKENS: ReadonlySet<string> = new Set(['draw', 'tie', 'tied', 'deadlock']);

function isDrawToken(s: string | null | undefined): boolean {
  return s != null && DRAW_TOKENS.has(s.trim().toLowerCase());
}

export function extractDrawAxis(ctx: ExtractCtx): string | null {
  if (isDrawToken(ctx.outcomeLabel) || isDrawToken(ctx.gated.canonical_subject as string | null)) {
    return 'draw';
  }
  const subj = (ctx.gated.canonical_subject as string | null) ?? null;
  return subj != null && subj.trim() !== '' ? 'decisive' : null;
}

export const drawAxisSpec: DiscriminatorSpec = {
  name: 'draw_axis',
  kinds: DRAW_AXIS_KINDS,
  source: 'gated-field',
  extract: extractDrawAxis,
  assertion: 'guard-only',
  nullPolicy: 'block-when-sibling-known',
};
