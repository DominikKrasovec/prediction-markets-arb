// DiscriminatorSpec registry: a discriminator is a fact buried in the title
// (metric slice, party, game ordinal, stat) that Stage-4 folds would otherwise
// have to re-parse. A spec not listed in REGISTRY has no effect anywhere.
import type { EventKind } from '@arb/types';
import { metricScopeSpec, propMetricScopeSpec } from './specs/metric-scope.js';
import { extremumSpec } from './specs/extremum.js';
import { mentionPhraseSpec } from './specs/mention-phrase.js';
import { gameOrdinalSpec } from './specs/game-ordinal.js';
import { partySpec } from './specs/party.js';
import { tourGenderSpec } from './specs/tour-gender.js';
import { rankGrainSpec } from './specs/rank-grain.js';
import { statTypeSpec } from './specs/stat-type.js';
import { propPredicateSpec } from './specs/prop-predicate.js';
import { candleWindowSpec } from './specs/candle-window.js';
import { orgTourSpec } from './specs/org-tour.js';
import { orgSplitSpec } from './specs/org-split.js';
import { drawAxisSpec } from './specs/draw-axis.js';
import { predicateGrainSpec } from './specs/predicate-grain.js';
import { awardTierSpec } from './specs/award-tier.js';
import { metricQualifierSpec } from './specs/metric-qualifier.js';
import { languageVariantSpec } from './specs/language-variant.js';
import { boundStrictnessSpec } from './specs/bound-strictness.js';

export type GatedColumn =
  | 'metric_scope'
  | 'condition_direction'
  | 'outcome_label'
  | 'value_primary'
  | 'resolution_scope'
  | 'league_id';

// tolerant: NULL never conflicts. strict: NULL blocks (IS NOT DISTINCT FROM).
// block-when-sibling-known: tolerant at Stage-4, but Stage-3 drops a NULL leg
// fusing where a sibling leg is known.
export type NullPolicy = 'tolerant' | 'strict' | 'block-when-sibling-known';

export type FoldSurface = 'identity' | 'builder';

export interface WarmKbCache {
  lookupCanonical(name: string): {
    type: string | null;
    sport_canonical: string | null;
    league_canonical: string | null;
    tour_gender: string | null;
  } | null;
}

export interface ExtractCtx {
  title: string;
  outcomeLabel: string | null;
  eventKind: string | null;
  matchSource: string | null;
  platform: string;
  raw: Record<string, unknown> | null;
  gated: Record<string, unknown>;
  kb: WarmKbCache | null;
}

export interface DiscriminatorSpec {
  name: string;
  kinds: readonly EventKind[] | 'all';
  source: 'title-regex' | 'native-metadata' | 'kb' | 'gated-field';
  extract: (ctx: ExtractCtx) => string | null;
  sqlExtract?: string;
  gatedField?: GatedColumn;
  assertion: 'fold-key' | 'guard-only' | 'none';
  nullPolicy: NullPolicy;
  foldSurface?: FoldSurface;
  // Only specs that declare setSplit are enumerated by the set-key generators —
  // a blanket all-fold-keys set key is unsound (e.g. `extremum` must never
  // split a set; `party` on a categorical set would shatter the mutex).
  setSplit?: 'all' | 'threshold-only';
}

// Fold conjuncts and set keys are auto-emitted from this list by fold-sql.ts's
// generators, so appending a spec is the whole of registering a discriminator.
// Per-spec rationale lives in the spec files.
export const REGISTRY: readonly DiscriminatorSpec[] = [
  metricScopeSpec,
  extremumSpec,
  mentionPhraseSpec,
  gameOrdinalSpec,
  partySpec,
  tourGenderSpec,
  rankGrainSpec,
  statTypeSpec,
  propPredicateSpec,
  candleWindowSpec,
  orgTourSpec,
  drawAxisSpec,
  orgSplitSpec,
  predicateGrainSpec,
  awardTierSpec,
  metricQualifierSpec,
  languageVariantSpec,
  boundStrictnessSpec,
  propMetricScopeSpec,
];

export function getSpec(name: string): DiscriminatorSpec | undefined {
  return REGISTRY.find((s) => s.name === name);
}

export function specsForKind(eventKind: string | null): DiscriminatorSpec[] {
  return REGISTRY.filter(
    (s) => s.kinds === 'all' || (eventKind != null && (s.kinds as readonly string[]).includes(eventKind)),
  );
}

export function foldKeySpecs(): DiscriminatorSpec[] {
  return REGISTRY.filter((s) => s.assertion === 'fold-key');
}

export function foldKeySpecsForSurface(surface: FoldSurface): DiscriminatorSpec[] {
  return foldKeySpecs().filter((s) => (s.foldSurface ?? 'builder') === surface);
}

export function coherenceSpecs(): DiscriminatorSpec[] {
  return REGISTRY.filter((s) => s.assertion !== 'none');
}

export function setSplitSpecs(): DiscriminatorSpec[] {
  return REGISTRY.filter((s) => s.setSplit !== undefined);
}
