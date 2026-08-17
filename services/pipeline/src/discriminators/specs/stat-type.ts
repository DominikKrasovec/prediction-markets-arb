/**
 * Registry entry `stat_type`. Guard-only: it feeds the Stage-3 leg-coherence
 * belt + telemetry; it is not a fold key and touches no Stage-4 fold conjunct,
 * set key, or certifier demote.
 *
 * Source: title-regex (stat-vocab.ts) as the load-bearing signal, reusing the
 * shared `normalizePlayerStatUnit` canonicalizer so a captured surface folds
 * to the exact `value_unit` token the emission path already stamps
 * (points/threes/home_runs/goals/kills/...). `condition_metric` is too coarse
 * to carry the stat (it is 'count' for nearly every player prop), so the
 * discriminator lives JSONB-only.
 *
 * A pure title regex misses O/U-magnitude lines ("Team A vs Team B: O/U 2.5")
 * that infer the stat from the sport and never write it in the title.
 * `value_unit` is authoritative for those valued kinds, so stat_type reads a
 * recognized `value_unit` first and falls back to the title regex — see
 * {@link resolveStatType}. `source:'gated-field'` reflects that value_unit
 * read; value_unit stays authoritative, so gatedField is still undefined.
 *
 * Kinds: the three families that carry a title stat — player_prop_threshold,
 * match_total_metric (valued O/U totals), and championship_winner (the
 * stat-leader family; non-stat-leader rows carry no stat noun, so the
 * extractor returns null).
 *
 * Null policy: 'tolerant' — a title-regex necessarily misses long-tail
 * phrasings (ERA/WAR/OPS/"goal contributions"), so a NULL side must never
 * drop a leg. Only both-known-and-differ conflicts fire.
 */
import type { EventKind } from '@arb/types';
import type { DiscriminatorSpec } from '../registry.js';
import { resolveStatType } from '../stat-vocab.js';

/** The event_kinds whose title carries a statistical category. Stamping is a
 *  no-op for any other kind. */
const STAT_TYPE_KINDS: readonly EventKind[] = [
  'player_prop_threshold',
  'match_total_metric',
  'championship_winner', // stat-leader family ("lead the league in <stat>", "most <stat>")
];

export const statTypeSpec: DiscriminatorSpec = {
  name: 'stat_type',
  kinds: STAT_TYPE_KINDS,
  // Reads value_unit (authoritative for valued kinds) with a title-regex
  // fallback; NOT dual-written, so gatedField stays undefined (JSONB-only).
  source: 'gated-field',
  extract: (ctx) => resolveStatType(ctx.title, (ctx.gated as { value_unit?: string | null }).value_unit),
  assertion: 'guard-only',
  nullPolicy: 'tolerant',
};
