/**
 * `bound_strictness` spec unit tests. The extractor is the single source of
 * the per-market strictness the rate-decision bridge consumes: '>N' → strict,
 * 'N+' → closed, exact rung → null. Cases mirror the live Fed rung titles:
 * Kalshi cumulative rungs carry '>25bps' under strike_type='custom' (title
 * arm), the trio 'N+ bps'.
 */
import { describe, test, expect } from 'bun:test';
import {
  boundStrictnessFromSignals,
  extractBoundStrictness,
  boundStrictnessSpec,
} from './specs/bound-strictness.js';
import { getSpec, foldKeySpecs, coherenceSpecs, specsForKind } from './registry.js';

describe('boundStrictnessFromSignals — native strike_type arm (forward defense)', () => {
  test('greater / less → strict', () => {
    expect(boundStrictnessFromSignals(null, 'greater')).toBe('strict');
    expect(boundStrictnessFromSignals(null, 'less')).toBe('strict');
    expect(boundStrictnessFromSignals(null, 'GREATER')).toBe('strict');
  });
  test('greater_or_equal / less_or_equal → closed', () => {
    expect(boundStrictnessFromSignals(null, 'greater_or_equal')).toBe('closed');
    expect(boundStrictnessFromSignals(null, 'less_or_equal')).toBe('closed');
  });
  test("custom strike type falls through to the title arm (the live Fed case)", () => {
    // strike_type='custom' carries no strictness — the '>25bps' title decides.
    expect(
      boundStrictnessFromSignals('Will the Federal Reserve Hike rates by >25bps at their June 2027 meeting?', 'custom'),
    ).toBe('strict');
  });
});

describe('boundStrictnessFromSignals — title arm (live Fed rung forms)', () => {
  test.each([
    // Kalshi cumulative '>N' → strict
    ['Will the Federal Reserve Hike rates by >25bps at their June 2027 meeting?', 'strict'],
    ['Will the Federal Reserve Cut rates by >25bps at their January 2028 meeting?', 'strict'],
    // trio 'N+ bps' → closed
    ['Fed Decision in June?: 50+ bps increase', 'closed'],
    ['Fed Decision in July?: 50+ bps decrease', 'closed'],
    ['Will the Fed increase interest rates by 50+ bps after the June 2026 meeting?', 'closed'],
  ] as const)('%s → %s', (title, want) => expect(boundStrictnessFromSignals(title, null)).toBe(want));

  test.each([
    // exact `at` rungs — no directional bound → null (strictness N/A)
    ['Will the Federal Reserve Cut rates by 25bps at their June 2026 meeting?'],
    ['Will the Federal Reserve Hike rates by 0bps at their July 2026 meeting?'],
    ['Fed Decision in June?: 25 bps decrease'],
    ['Fed Decision in June?: No change'],
    ['Will the Fed decrease interest rates by 25 bps after the June 2026 meeting?'],
  ])('exact rung %s → null', (title) => expect(boundStrictnessFromSignals(title, null)).toBeNull());

  test('conflicting forms (both > and N+) → null (refuse)', () => {
    expect(boundStrictnessFromSignals('Hike by >25bps or 50+ bps', null)).toBeNull();
  });

  test('null / empty tolerated', () => {
    expect(boundStrictnessFromSignals(null, null)).toBeNull();
    expect(boundStrictnessFromSignals('', undefined)).toBeNull();
  });

  test("'or more' / 'at least N' closed synonyms", () => {
    expect(boundStrictnessFromSignals('Hike by 50 bps or more', null)).toBe('closed');
    expect(boundStrictnessFromSignals('Cut by at least 50 bps', null)).toBe('closed');
  });
});

describe('extractBoundStrictness (ExtractCtx) reads title + raw.strike_type', () => {
  const ctx = (title: string, raw: Record<string, unknown> | null) => ({
    title, outcomeLabel: null, eventKind: 'policy_action', matchSource: null,
    platform: 'kalshi', raw, gated: {} as Record<string, unknown>, kb: null,
  });
  test('title decides when strike_type is custom', () => {
    expect(extractBoundStrictness(ctx('Hike rates by >25bps', { strike_type: 'custom' }))).toBe('strict');
  });
  test('raw==null (raw not threaded) still works from title', () => {
    expect(extractBoundStrictness(ctx('increase by 50+ bps', null))).toBe('closed');
  });
  test('native strike_type wins for a proper inequality type', () => {
    expect(extractBoundStrictness(ctx('some rate market', { strike_type: 'greater' }))).toBe('strict');
  });
});

describe('registry shape — guard-only, JSONB-only, policy_action', () => {
  test('registration invariants (independent of whether it is wired into REGISTRY yet)', () => {
    expect(boundStrictnessSpec.assertion).toBe('guard-only');
    expect(boundStrictnessSpec.nullPolicy).toBe('tolerant');
    expect(boundStrictnessSpec.gatedField).toBeUndefined();
    expect(boundStrictnessSpec.kinds).toEqual(['policy_action']);
    expect(boundStrictnessSpec.source).toBe('native-metadata');
  });

  test('IF wired into REGISTRY: guard-only invariant holds (fold surfaces untouched)', () => {
    // Registration is the registry-owner's WP; this test is contains-based so it
    // passes whether or not the entry is live, and asserts the guard-only contract
    // the moment it lands (never a fold key).
    if (getSpec('bound_strictness')) {
      expect(foldKeySpecs().map((s) => s.name)).not.toContain('bound_strictness');
      expect(coherenceSpecs().map((s) => s.name)).toContain('bound_strictness');
      expect(specsForKind('policy_action').map((s) => s.name)).toContain('bound_strictness');
    }
  });
});

// The spec must be appended to REGISTRY for `extract` to ever be called: no
// Stage-1 stamp, no coherence belt, and the rate-decision bridge's per-market
// strictness read is otherwise dead by construction. These assertions are
// unconditional — the wiring is part of the contract, not a maybe.
describe('P12a — bound_strictness is REGISTERED', () => {
  test('the spec is live in REGISTRY', () => {
    expect(getSpec('bound_strictness')).toBe(boundStrictnessSpec);
  });

  test('and stays GUARD-ONLY: fold surfaces + set keys are untouched', () => {
    expect(foldKeySpecs().map((s) => s.name)).not.toContain('bound_strictness');
    expect(boundStrictnessSpec.setSplit).toBeUndefined();
    expect(coherenceSpecs().map((s) => s.name)).toContain('bound_strictness');
  });

  test('scoped to policy_action — no other kind sees the stamp', () => {
    expect(specsForKind('policy_action').map((s) => s.name)).toContain('bound_strictness');
    for (const k of ['match_winner', 'price_threshold', 'candle_direction', null]) {
      expect(specsForKind(k).map((s) => s.name)).not.toContain('bound_strictness');
    }
  });
});
