/**
 * Unit tests for the guard-only registry entries stat_type + prop_predicate.
 * Invariants:
 *   · both are GUARD-ONLY → in coherenceSpecs(), NOT in foldKeySpecs() → the
 *     Stage-4 fold-SQL / set keys / certifier are byte-identical.
 *   · the Stage-1 stamp writes them into the discriminators JSONB, dual-writing
 *     NO typed column.
 *   · the Stage-3 leg-coherence belt drops a cross-stat / cross-predicate leg.
 */
import { describe, test, expect } from 'bun:test';
import type { LLMMarketNormalization } from '@arb/types';
import {
  getSpec,
  foldKeySpecs,
  coherenceSpecs,
  specsForKind,
  type DiscriminatorSpec,
} from './registry.js';
import { stampDiscriminators } from './stamp.js';
import { discFoldFragment, builderDiscFoldFragment, setDiscKey } from './fold-sql.js';
import { hasFoldKeyDiscriminatorViolation } from '../stage4-events/outcome-set-certifier.js';
import { discriminatorCoherenceDrops } from './coherence.js';
import { extractPropPredicate } from './specs/prop-predicate.js';

const baseNorm = (over: Partial<LLMMarketNormalization>): LLMMarketNormalization => ({
  market_id: 1,
  canonical_subject: 's',
  condition_value: null,
  condition_date: null,
  canonical_event: 'e',
  outcome_label: null,
  resolved_entities: [],
  resolution_source: null,
  confidence: 1,
  condition_shape: 'binary_event',
  condition_direction: null,
  condition_metric: null,
  metric_scope: null,
  temporal_semantics: null,
  value_primary: null,
  value_secondary: null,
  value_unit: null,
  participants: [],
  category_unified: null,
  ...over,
});

describe('registration', () => {
  test('stat_type: guard-only, tolerant, no gatedField, 3 carrying kinds', () => {
    const s = getSpec('stat_type')!;
    expect(s.assertion).toBe('guard-only');
    expect(s.nullPolicy).toBe('tolerant');
    expect(s.gatedField).toBeUndefined();
    expect(s.kinds).toEqual(['player_prop_threshold', 'match_total_metric', 'championship_winner']);
  });

  test('prop_predicate: guard-only, strict, no gatedField, match_event_prop only', () => {
    const s = getSpec('prop_predicate')!;
    expect(s.assertion).toBe('guard-only');
    expect(s.nullPolicy).toBe('strict');
    expect(s.gatedField).toBeUndefined();
    expect(s.kinds).toEqual(['match_event_prop']);
  });
});

describe('guard-only invariant — Stage-4 surfaces byte-identical', () => {
  test('neither joins foldKeySpecs(); both join coherenceSpecs()', () => {
    const fold = foldKeySpecs().map((s) => s.name);
    expect(fold).not.toContain('stat_type');
    expect(fold).not.toContain('prop_predicate');
    const coh = coherenceSpecs().map((s) => s.name);
    expect(coh).toContain('stat_type');
    expect(coh).toContain('prop_predicate');
  });

  test('fold-SQL generators + set key ignore guard-only specs', () => {
    // Guard-only names never appear on any fold surface. Other fold-key
    // entries (mention_phrase/party/tour_gender, the game_ordinal identity
    // fold) exist too, so assertions are exclusion-based, not an exact
    // metric_scope-only pin.
    for (const frag of [discFoldFragment('a', 'b'), builderDiscFoldFragment('a', 'b'), setDiscKey('x')]) {
      expect(frag).not.toContain('stat_type');
      expect(frag).not.toContain('prop_predicate');
    }
    // setDiscKey enumerates set-split specs only — an all-fold-keys form
    // would be unsound as a group key (extremum splits legitimate
    // mixed-direction sets; party shatters the categorical D-vs-R mutex axis).
    expect(setDiscKey('x', 'threshold_series')).toContain("(x.discriminators->>'mention_phrase')");
    expect(setDiscKey('x', 'threshold_series')).toContain("(x.discriminators->>'party')");
    expect(setDiscKey('x', 'categorical')).toContain("(x.discriminators->>'mention_phrase')");
    expect(setDiscKey('x', 'categorical')).not.toContain('party');            // party would shatter the mutex axis
    expect(setDiscKey('x', 'threshold_series')).not.toContain('extremum');    // mixed directions are legal
    expect(setDiscKey('x', 'threshold_series')).not.toContain('metric_scope'); // finalize already keys the typed column
  });

  test('certifier demote never fires on a guard-only discriminator', () => {
    const slot = (disc: Record<string, string | null>) => ({ disc, is_residual: false });
    // Slots disagree on stat_type + prop_predicate but NOT on any fold-key →
    // classifySet must NOT demote (guard-only specs are excluded).
    expect(hasFoldKeyDiscriminatorViolation([
      slot({ stat_type: 'points', prop_predicate: 'first blood' }),
      slot({ stat_type: 'goals', prop_predicate: 'both teams beat roshan' }),
    ])).toBeNull();
  });
});

describe('stamp (consumer 1)', () => {
  test('match_total_metric: stat_type into JSONB, no typed column written', () => {
    const norm = baseNorm({ event_kind: 'match_total_metric', value_unit: 'goals' });
    stampDiscriminators({ title: 'Real Madrid vs Barcelona: Over 2.5 goals', platform: 'polymarket' }, norm);
    expect(norm.discriminators?.stat_type).toBe('goals');
    // No gatedField → value_unit untouched, no stray typed writes.
    expect(norm.value_unit).toBe('goals');
  });

  test('non-carrying kind (match_winner): stat_type NOT stamped', () => {
    const norm = baseNorm({ event_kind: 'match_winner' });
    expect(specsForKind('match_winner').map((s) => s.name)).not.toContain('stat_type');
    stampDiscriminators({ title: 'Team scores the most goals', platform: 'polymarket' }, norm);
    expect(norm.discriminators?.stat_type).toBeUndefined();
  });

  test('match_event_prop: prop_predicate = pre-pipe token; outcome_label untouched', () => {
    const norm = baseNorm({ event_kind: 'match_event_prop', outcome_label: 'first blood | game 1' });
    stampDiscriminators({ title: 'First Blood in Game 1?', platform: 'polymarket' }, norm);
    expect(norm.discriminators?.prop_predicate).toBe('first blood');
    expect(norm.outcome_label).toBe('first blood | game 1'); // authoritative, unchanged
  });

  test('match_event_prop bare-scope label → no prop_predicate stamped', () => {
    const norm = baseNorm({ event_kind: 'match_event_prop', outcome_label: 'game 1' });
    stampDiscriminators({ title: 'Map 1 Winner?', platform: 'polymarket' }, norm);
    expect(norm.discriminators?.prop_predicate).toBeUndefined();
  });
});

describe('extractPropPredicate', () => {
  test.each([
    ['first blood | game 1', 'first blood'],
    ['both teams beat roshan | game 2', 'both teams beat roshan'],
    ['odd/even total kills | map 2', 'odd/even total kills'],
    ['Any Player Penta Kill | game 1', 'any player penta kill'],
  ])('%s → %s', (label, pred) => expect(extractPropPredicate(label)).toBe(pred));

  test.each(['game 1', 'map 2', 'set 3', 'round 4'])('bare scope %s → null', (label) => {
    expect(extractPropPredicate(label)).toBeNull();
  });

  test('null/empty tolerated', () => {
    expect(extractPropPredicate(null)).toBeNull();
    expect(extractPropPredicate('   ')).toBeNull();
  });
});

describe('coherence (consumer 2) — cross-stat / cross-predicate drop', () => {
  const legs = [
    { market_id: 1, outcome_id: 'o' },
    { market_id: 2, outcome_id: 'o' },
  ];

  test('prop_predicate: two different predicates in one outcome → drop the later', () => {
    const vals: Record<string, Record<number, string | null>> = {
      prop_predicate: { 1: 'first blood', 2: 'both teams beat roshan' },
    };
    const r = discriminatorCoherenceDrops(legs, (s: DiscriminatorSpec, mid) => vals[s.name]?.[mid] ?? null);
    expect([...r.drop]).toEqual([2]);
    expect(r.perSpec['prop_predicate']).toBe(1);
  });

  test('stat_type: both-known-differ → drop; NULL side tolerant (no drop)', () => {
    const differ = discriminatorCoherenceDrops(legs, (s: DiscriminatorSpec, mid) =>
      s.name === 'stat_type' ? ({ 1: 'points', 2: 'goals' } as Record<number, string>)[mid] ?? null : null,
    );
    expect(differ.perSpec['stat_type']).toBe(1);

    const nullSide = discriminatorCoherenceDrops(legs, (s: DiscriminatorSpec, mid) =>
      s.name === 'stat_type' ? ({ 1: 'points', 2: null } as Record<number, string | null>)[mid] ?? null : null,
    );
    expect(nullSide.drop.size).toBe(0);
  });
});
