/**
 * Registry unit tests — registry + stamp + fold-sql + coherence + certifier demote.
 * Invariant: exactly one entry (metric_scope, tolerant, builder-surface) in the
 * base set, and every consumer surface is behavior-neutral against it.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import type { LLMMarketNormalization } from '@arb/types';
import {
  REGISTRY,
  getSpec,
  specsForKind,
  foldKeySpecs,
  foldKeySpecsForSurface,
  coherenceSpecs,
} from './registry.js';
import { stampDiscriminators } from './stamp.js';
import { discFoldFragment, builderDiscFoldFragment, setDiscKey } from './fold-sql.js';
import { discriminatorCoherenceDrops } from './coherence.js';
import { hasFoldKeyDiscriminatorViolation } from '../stage4-events/outcome-set-certifier.js';
import { beltCensus, resetBeltCensus } from './telemetry.js';

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

beforeEach(() => resetBeltCensus());

describe('registry shape (metric_scope wave-1 entry + wave-2 additions)', () => {
  test('metric_scope: tolerant fold-key, builder surface (wave-1 invariant preserved)', () => {
    // Assertions are spec-scoped / contains-based, not `REGISTRY.length===1`,
    // so appending future specs does not falsely fail this test.
    const s = getSpec('metric_scope')!;
    expect(s).toBeDefined();
    expect(s.assertion).toBe('fold-key');
    expect(s.nullPolicy).toBe('tolerant');
    expect(s.gatedField).toBe('metric_scope');
    expect(s.foldSurface).toBe('builder');
  });

  test('WP-2.2 entries: party / tour_gender fold-keys, rank_grain guard-only', () => {
    const party = getSpec('party')!;
    expect(party).toBeDefined();
    expect(party.assertion).toBe('fold-key');
    expect(party.nullPolicy).toBe('tolerant');
    expect(party.foldSurface).toBe('builder');
    expect(party.gatedField).toBeUndefined(); // JSONB-only

    const tour = getSpec('tour_gender')!;
    expect(tour).toBeDefined();
    expect(tour.assertion).toBe('fold-key');
    expect(tour.nullPolicy).toBe('block-when-sibling-known');
    expect(tour.foldSurface).toBe('builder');
    expect(tour.gatedField).toBeUndefined(); // league_id stays authoritative

    const rank = getSpec('rank_grain')!;
    expect(rank).toBeDefined();
    expect(rank.assertion).toBe('guard-only');
    expect(rank.nullPolicy).toBe('block-when-sibling-known');
    expect(rank.gatedField).toBeUndefined(); // JSONB-only (stamp mirror would over-stamp)
  });

  test('WP-2.1 trio: extremum / mention_phrase / game_ordinal spec shapes', () => {
    const ext = getSpec('extremum')!;
    expect(ext.gatedField).toBe('condition_direction');
    expect(ext.assertion).toBe('fold-key');
    expect(ext.nullPolicy).toBe('strict');
    expect(ext.foldSurface ?? 'builder').toBe('builder');

    const mp = getSpec('mention_phrase')!;
    expect(mp.gatedField).toBe('outcome_label');
    expect(mp.assertion).toBe('fold-key');
    expect(mp.nullPolicy).toBe('strict');
    expect(mp.kinds as readonly string[]).toContain('speech_mention');

    const go = getSpec('game_ordinal')!;
    expect(go.assertion).toBe('fold-key');
    expect(go.nullPolicy).toBe('strict');
    expect(go.foldSurface).toBe('identity'); // the FIRST identity fold
    // discriminators is not a TupleField, so a shadow-diff surface can never
    // observe a flip; expectedFlipTag is intentionally absent from the spec.
    expect('expectedFlipTag' in go).toBe(false);
    expect(go.gatedField).toBeUndefined(); // JSONB-only (no typed ordinal column)
    expect(go.kinds).toBe('all');
  });

  test('kind-scoping: metric_scope on the 5 carrying kinds; mention_phrase only on speech_mention', () => {
    for (const k of ['match_total_metric', 'match_winner', 'halftime_leader', 'match_spread', 'exact_score']) {
      expect(specsForKind(k).map((s) => s.name)).toContain('metric_scope');
    }
    // Economics kinds must NOT trigger the metric_scope stamp (the "Q1 2026" class).
    for (const k of ['price_threshold', 'other', null]) {
      expect(specsForKind(k).map((s) => s.name)).not.toContain('metric_scope');
    }
    // mention_phrase is scoped to speech_mention; game_ordinal ('all') is everywhere.
    expect(specsForKind('speech_mention').map((s) => s.name)).toContain('mention_phrase');
    expect(specsForKind('match_winner').map((s) => s.name)).not.toContain('mention_phrase');
    expect(specsForKind('match_winner').map((s) => s.name)).toContain('game_ordinal');
  });

  test('kind-scoping: meaningful on the 5 carrying kinds, no-op elsewhere', () => {
    for (const k of ['match_total_metric', 'match_winner', 'halftime_leader', 'match_spread', 'exact_score']) {
      expect(specsForKind(k).map((s) => s.name)).toContain('metric_scope');
    }
    // Economics kinds must NOT trigger the stamp (the "Q1 2026" false-quarter class).
    for (const k of ['price_threshold', 'other', null]) {
      expect(specsForKind(k).map((s) => s.name)).not.toContain('metric_scope');
    }
    // party is kind-scoped to the election kinds only.
    expect(specsForKind('election_margin').map((s) => s.name)).toContain('party');
    expect(specsForKind('match_winner').map((s) => s.name)).not.toContain('party');
    // tour_gender is kind-scoped to the two tennis winner kinds.
    expect(specsForKind('championship_winner').map((s) => s.name)).toContain('tour_gender');
    expect(specsForKind('price_threshold').map((s) => s.name)).not.toContain('tour_gender');
  });

  test('helper partitions (contains — robust to sibling wave-2 additions)', () => {
    // metric_scope stays a builder-surface fold-key; identity surface stays
    // empty except for game_ordinal, the first identity spec.
    for (const name of ['metric_scope', 'party', 'tour_gender']) {
      expect(foldKeySpecs().map((s) => s.name)).toContain(name);
      expect(foldKeySpecsForSurface('builder').map((s) => s.name)).toContain(name);
    }
    // rank_grain is guard-only → NOT a fold-key, but IS a coherence spec.
    expect(foldKeySpecs().map((s) => s.name)).not.toContain('rank_grain');
    for (const name of ['metric_scope', 'party', 'tour_gender', 'rank_grain']) {
      expect(coherenceSpecs().map((s) => s.name)).toContain(name);
    }
  });
});

describe('stamp (consumer 1) — dual-write + mirror', () => {
  test('stamps a carrying kind whose handler already set metric_scope (mirror, no dual-write)', () => {
    const norm = baseNorm({ event_kind: 'match_total_metric', metric_scope: 'team' });
    stampDiscriminators({ title: 'Will the Yankees score over 4.5?', platform: 'kalshi' }, norm);
    expect(norm.metric_scope).toBe('team'); // handler-stamped wins (unchanged)
    expect(norm.discriminators).toEqual({ metric_scope: 'team' }); // JSONB mirrors the typed value
    expect(beltCensus()['disc.metric_scope.stamped']).toBe(1);
  });

  test('dual-write fills a NULL typed column on a carrying kind', () => {
    // A carrying-kind row where the handler left metric_scope NULL but the
    // title parses (synthetic — the live data has 0 such rows, which is what
    // makes the dual-write a no-op; here we prove the mechanism itself).
    const norm = baseNorm({ event_kind: 'match_total_metric', metric_scope: null });
    stampDiscriminators({ title: 'Team total: will the Yankees go over 4.5?', platform: 'kalshi' }, norm);
    expect(norm.metric_scope).toBe('team');
    expect(norm.discriminators).toEqual({ metric_scope: 'team' });
  });

  test('NO stamp on an economics kind whose title trips the quarter regex (zero-diff)', () => {
    const norm = baseNorm({ event_kind: 'price_threshold', metric_scope: null });
    stampDiscriminators({ title: 'Will Euro area GDP growth for Q1 2026 be above 2.2%?', platform: 'kalshi' }, norm);
    expect(norm.metric_scope).toBeNull(); // NOT changed to 'quarter'
    expect(norm.discriminators).toEqual({}); // no key stamped
  });

  test('carrying kind with no scope signal → metric_scope not stamped, mirror stays absent', () => {
    const norm = baseNorm({ event_kind: 'match_winner', metric_scope: null });
    stampDiscriminators({ title: 'Arsenal vs Chelsea: winner', platform: 'polymarket' }, norm);
    expect(norm.metric_scope).toBeNull();
    // metric_scope itself never stamps here (no scope signal). draw_axis DOES
    // stamp 'decisive' on a match_winner with a named subject, so the stamp
    // is no longer literally {}, but the metric_scope KEY stays absent (the
    // invariant this test guards).
    expect(norm.discriminators?.metric_scope).toBeUndefined();
    expect(beltCensus()['disc.metric_scope.null']).toBe(1);
  });
});

describe('fold-sql (consumer 3 generators)', () => {
  test('discFoldFragment (identity surface) carries the game_ordinal strict fold (WP-2.1)', () => {
    const frag = discFoldFragment('a', 'b');
    expect(frag).toContain("a.discriminators->>'game_ordinal'");
    expect(frag).toContain("b.discriminators->>'game_ordinal'");
    expect(frag).toContain('IS NOT DISTINCT FROM'); // strict nullPolicy (NULL ≢ value blocks)
  });



  test('builderDiscFoldFragment wraps the bothKnownDifferSql idiom on the JSONB mirror', () => {
    const frag = builderDiscFoldFragment('a', 'b');
    // tolerant nullPolicy → NOT (both known and differ), reading the JSONB.
    expect(frag).toContain("a.discriminators->>'metric_scope'");
    expect(frag).toContain("b.discriminators->>'metric_scope'");
    expect(frag).toContain('IS DISTINCT FROM');
    expect(frag.startsWith('NOT (')).toBe(true);
  });

  test('setDiscKey emits a comma-prefixed group-key extension for the SET-SPLIT specs', () => {
    // The previous every-fold-key form was unsound as a group key (extremum
    // splits legitimate mixed-direction sets; tour_gender was never a set
    // axis; party on categorical shatters the D-vs-R mutex). setDiscKey now
    // enumerates setSplitSpecs() with per-spec scope.
    const key = setDiscKey('x', 'threshold_series');
    expect(key.startsWith(', ')).toBe(true);
    for (const name of ['mention_phrase', 'party']) {
      expect(key).toContain(`(x.discriminators->>'${name}')`);
    }
    // party is threshold-only (categorical trap).
    expect(setDiscKey('x', 'categorical')).not.toContain('party');
    // guard-only / non-set fold-keys never enter the group key.
    for (const name of ['rank_grain', 'extremum', 'tour_gender', 'game_ordinal', 'metric_scope']) {
      expect(key).not.toContain(name);
    }
  });
});

describe('coherence (consumer 2) — both-known-differ + block-when-sibling-known', () => {
  const legs = [
    { market_id: 1, outcome_id: 'o' },
    { market_id: 2, outcome_id: 'o' },
    { market_id: 3, outcome_id: 'o' },
  ];
  // Scope the mock to ONE spec at a time — production stamps each spec its own
  // per-leg value; a mock that returned the SAME value for every spec would
  // conflate the tolerant (metric_scope) and block-when-sibling-known (party/
  // tour_gender/rank_grain) policies. `only(name)` returns null for other specs
  // (all-NULL → those specs make no drop), isolating the policy under test.
  const only = (name: string, vals: Record<number, string | null>) =>
    (s: { name: string }, mid: number) => (s.name === name ? vals[mid] : null);

  test('tolerant (metric_scope): drops the later both-known-differ leg; NULL leg kept', () => {
    const r = discriminatorCoherenceDrops(legs, only('metric_scope', { 1: 'game', 2: 'team', 3: null }));
    expect([...r.drop]).toEqual([2]); // 2 (team) conflicts with anchor 1 (game); 3 (NULL) kept — tolerant
    expect(r.perSpec['metric_scope']).toBe(1);
  });

  test('tolerant (metric_scope): no drop when all agree or NULL', () => {
    const r = discriminatorCoherenceDrops(legs, only('metric_scope', { 1: 'game', 2: 'game', 3: null }));
    expect(r.drop.size).toBe(0);
  });

  test('tolerant (party): drops the both-known-differ leg but KEEPS the NULL leg', () => {
    // party is TOLERANT — a party-blind (NULL) market never blocks a merge.
    // Anchor 1 'democratic', leg 2 'republican' → both-known-differ drop; leg
    // 3 NULL → kept (tolerant, unlike the block-when-sibling-known specs below).
    const r = discriminatorCoherenceDrops(legs, only('party', { 1: 'democratic', 2: 'republican', 3: null }));
    expect([...r.drop]).toEqual([2]);
    expect(r.perSpec['party']).toBe(1);
  });

  test('block-when-sibling-known (tour_gender): drops the NULL leg entering a known-sibling fold', () => {
    // tour_gender is block-when-sibling-known. Anchor 1 'men', leg 2 'women'
    // → both-known-differ drop; leg 3 NULL entering a fold where a sibling is
    // known → NULL-bridge drop. The anchor is always kept.
    const r = discriminatorCoherenceDrops(legs, only('tour_gender', { 1: 'men', 2: 'women', 3: null }));
    expect([...r.drop].sort()).toEqual([2, 3]);
    expect(r.perSpec['tour_gender']).toBe(2);
  });

  test('block-when-sibling-known (tour_gender): all-NULL never drops (no known sibling)', () => {
    const r = discriminatorCoherenceDrops(legs, only('tour_gender', { 1: null, 2: null, 3: null }));
    expect(r.drop.size).toBe(0);
  });

  test('singleton outcome never drops', () => {
    const r = discriminatorCoherenceDrops([{ market_id: 1, outcome_id: 'o' }], () => 'team');
    expect(r.drop.size).toBe(0);
  });
});

describe('certifier demote (consumer 3) — hasFoldKeyDiscriminatorViolation', () => {
  const slot = (disc: Record<string, string | null>, is_residual = false) => ({ disc, is_residual });

  test('tolerant metric_scope: both-known-differ → demote', () => {
    expect(hasFoldKeyDiscriminatorViolation([slot({ metric_scope: 'team' }), slot({ metric_scope: 'game' })]))
      .toBe('metric_scope');
  });

  test('tolerant metric_scope: known+NULL mix does NOT demote', () => {
    expect(hasFoldKeyDiscriminatorViolation([slot({ metric_scope: 'team' }), slot({ metric_scope: null })]))
      .toBeNull();
  });

  test('all-agree → no demote; residual slots ignored', () => {
    expect(hasFoldKeyDiscriminatorViolation([
      slot({ metric_scope: 'game' }),
      slot({ metric_scope: 'game' }),
      slot({ metric_scope: 'team' }, true), // residual excluded
    ])).toBeNull();
  });
});
