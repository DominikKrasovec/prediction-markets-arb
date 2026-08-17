/**
 * Tests for the guard-only discriminator specs award_tier, metric_qualifier,
 * and language_variant.
 *
 *   - All three are guard-only: they appear in coherenceSpecs() but not
 *     foldKeySpecs(), so the Stage-4 fold-SQL / set keys / certifier are
 *     unaffected.
 *   - The Stage-1 stamp writes them into the discriminators JSONB only, never
 *     a typed column.
 *   - The Stage-3 leg-coherence belt drops a cross-tier / core-vs-headline /
 *     cross-language leg (tolerant: only drops when both legs are known and differ).
 */
import { describe, test, expect } from 'bun:test';
import type { LLMMarketNormalization } from '@arb/types';
import {
  getSpec,
  foldKeySpecs,
  coherenceSpecs,
  specsForKind,
  setSplitSpecs,
  type DiscriminatorSpec,
} from './registry.js';
import { stampDiscriminators } from './stamp.js';
import { discFoldFragment, builderDiscFoldFragment, setDiscKey } from './fold-sql.js';
import { hasFoldKeyDiscriminatorViolation } from '../stage4-events/outcome-set-certifier.js';
import { discriminatorCoherenceDrops } from './coherence.js';
import { extractAwardTier } from './specs/award-tier.js';
import { extractMetricQualifier } from './specs/metric-qualifier.js';
import { extractLanguageVariant } from './specs/language-variant.js';

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

const NAMES = ['award_tier', 'metric_qualifier', 'language_variant'];

describe('registration', () => {
  test.each(NAMES)('%s: guard-only, tolerant, no gatedField, kinds all, title-regex', (name) => {
    const s = getSpec(name)!;
    expect(s).toBeDefined();
    expect(s.assertion).toBe('guard-only');
    expect(s.nullPolicy).toBe('tolerant');
    expect(s.gatedField).toBeUndefined();
    expect(s.kinds).toBe('all');
    expect(s.source).toBe('title-regex');
    expect(s.setSplit).toBeUndefined();
  });
});

describe('guard-only invariant — Stage-4 surfaces byte-identical', () => {
  test('none join foldKeySpecs() / setSplitSpecs(); all join coherenceSpecs()', () => {
    const fold = foldKeySpecs().map((s) => s.name);
    const set = setSplitSpecs().map((s) => s.name);
    const coh = coherenceSpecs().map((s) => s.name);
    for (const n of NAMES) {
      expect(fold).not.toContain(n);
      expect(set).not.toContain(n);
      expect(coh).toContain(n);
    }
  });

  test('fold-SQL generators + set key ignore the GW-R4a specs', () => {
    for (const frag of [
      discFoldFragment('a', 'b'),
      builderDiscFoldFragment('a', 'b'),
      setDiscKey('x'),
      setDiscKey('x', 'threshold_series'),
    ]) {
      for (const n of NAMES) expect(frag).not.toContain(n);
    }
  });

  test('certifier demote never fires on the GW-R4a (guard-only) discriminators', () => {
    const slot = (disc: Record<string, string | null>) => ({ disc, is_residual: false });
    expect(hasFoldKeyDiscriminatorViolation([
      slot({ award_tier: 'golden', metric_qualifier: 'core', language_variant: 'latin spanish' }),
      slot({ award_tier: 'silver', metric_qualifier: 'headline', language_variant: 'castilian spanish' }),
    ])).toBeNull();
  });

  test("kinds 'all' → stamped on every kind incl. NULL", () => {
    for (const k of ['award_winner', 'championship_winner', 'econ_indicator_threshold', 'other', null]) {
      const names = specsForKind(k).map((s) => s.name);
      for (const n of NAMES) expect(names).toContain(n);
    }
  });
});

describe('extractAwardTier (SE 2075)', () => {
  test.each([
    ['Will Harry Kane win the Bronze Boot?', 'bronze'],
    ['Will Jude Bellingham win the Silver Boot?', 'silver'],
    ['World Cup: Golden Boot Winner: Erling Haaland', 'golden'],
    ['Will Cristiano Ronaldo win the Golden Ball at the 2026 FIFA World Cup?', 'golden'],
    ['Will Thibaut Courtois win the Golden Glove at the 2026 FIFA World Cup?', 'golden'],
    ['Golden Slipper 2026 winner', 'golden'],
  ])('%s → %s', (title, tier) => expect(extractAwardTier(title)).toBe(tier));

  test('bare tier without an award object does NOT fire (Golden State trap)', () => {
    expect(extractAwardTier('Will the Golden State Warriors win the title?')).toBeNull();
    expect(extractAwardTier('golden anniversary celebration')).toBeNull();
  });

  test('two DIFFERENT tiers in one title → null (both-or-neither)', () => {
    // A combined "golden boot and silver ball" market is genuinely ambiguous.
    expect(extractAwardTier('Will X win the Golden Boot and the Silver Ball?')).toBeNull();
  });

  test('same tier twice → the one tier (not ambiguous)', () => {
    expect(extractAwardTier('Golden Boot and the Golden Ball in the 2026 World Cup')).toBe('golden');
  });

  test('null/empty tolerated', () => {
    expect(extractAwardTier(null)).toBeNull();
    expect(extractAwardTier('')).toBeNull();
    expect(extractAwardTier('Will Arsenal beat Chelsea?')).toBeNull();
  });
});

describe('extractMetricQualifier (SE 2801)', () => {
  test.each([
    ['Will the rate of core CPI inflation be above 2.6% for the year ending in July 2026?', 'core'],
    ['CPI core month-over-month in Aug 2026?', 'core'],
    ['Will core PCE be above 0.3% in October 2026?', 'core'],
    // headline = the unqualified default (no 'core')
    ['Will CPI inflation be above 3.0% for the year ending in July 2026?', 'headline'],
    ['Will PCE inflation be above 2.5% in 2026?', 'headline'],
    ['Will annual inflation exceed 3%?', 'headline'],
  ])('%s → %s', (title, q) => expect(extractMetricQualifier(title)).toBe(q));

  test('bare "core" outside an econ metric title → null (scope gate, 34 live)', () => {
    expect(extractMetricQualifier('Will the core team ship the feature?')).toBeNull();
    expect(extractMetricQualifier('Hardcore fans attendance over 10k?')).toBeNull();
    expect(extractMetricQualifier('Will Intel core count rise?')).toBeNull();
  });

  test("word-anchored 'core' — 'supercore' does not fire (still headline)", () => {
    expect(extractMetricQualifier('Will supercore CPI be above 3%?')).toBe('headline');
  });

  test('null/empty tolerated', () => {
    expect(extractMetricQualifier(null)).toBeNull();
    expect(extractMetricQualifier('')).toBeNull();
  });
});

describe('extractLanguageVariant (SE 2193)', () => {
  test.each([
    ['Will X win Best Anime Voice Artist Performance (Latin Spanish) at the 2026 Crunchyroll Anime Awards?', 'latin spanish'],
    ['Will Y win Best Anime Voice Artist Performance (Castilian Spanish) at the 2026 Crunchyroll Anime Awards?', 'castilian spanish'],
    ['Will Z win Best Anime Voice Artist Performance (Brazilian Portuguese) at the 2026 Crunchyroll Anime Awards?', 'brazilian portuguese'],
    ['Will W win Best Anime Voice Artist Performance (English) at the 2026 Crunchyroll Anime Awards?', 'english'],
    ['Will V win Best Anime Voice Artist Performance (French) at the 2026 Crunchyroll Anime Awards?', 'french'],
  ])('%s → %s', (title, q) => expect(extractLanguageVariant(title)).toBe(q));

  test('no award cue → null (scope anchor)', () => {
    // A soccer title where "(English)" would otherwise match must not stamp.
    expect(extractLanguageVariant('English Premier League: will Arsenal win?')).toBeNull();
    expect(extractLanguageVariant('Voice actor of the year (French)?')).toBeNull();
  });

  test('non-lone language parenthetical → null (English Premier League trap)', () => {
    expect(extractLanguageVariant('Best award (English Premier League) winner?')).toBeNull();
  });

  test('two distinct languages in one title → null (both-or-neither)', () => {
    expect(extractLanguageVariant(
      'Best Anime Voice Award (Latin Spanish) or (Castilian Spanish) crossover?',
    )).toBeNull();
  });

  test('null/empty tolerated', () => {
    expect(extractLanguageVariant(null)).toBeNull();
    expect(extractLanguageVariant('')).toBeNull();
    expect(extractLanguageVariant('Best Anime Voice Award winner?')).toBeNull();
  });
});

describe('stamp (consumer 1) — JSONB only, no typed column', () => {
  test('award_winner: award_tier into JSONB', () => {
    const norm = baseNorm({ event_kind: 'award_winner', canonical_subject: 'Jude Bellingham' });
    stampDiscriminators({ title: 'Will Jude Bellingham win the Silver Boot?', platform: 'kalshi' }, norm);
    expect(norm.discriminators?.award_tier).toBe('silver');
  });

  test('econ_indicator_threshold: metric_qualifier into JSONB (core)', () => {
    const norm = baseNorm({ event_kind: 'econ_indicator_threshold' });
    stampDiscriminators({ title: 'Will core CPI inflation be above 2.6%?', platform: 'kalshi' }, norm);
    expect(norm.discriminators?.metric_qualifier).toBe('core');
    expect(norm.condition_metric).toBeNull(); // authoritative typed column untouched
  });

  test("other: the headline CPI sibling stamps 'headline' (SE 2801 partners)", () => {
    const norm = baseNorm({ event_kind: 'other' });
    stampDiscriminators({ title: 'Will CPI inflation be above 3.0% YoY?', platform: 'polymarket' }, norm);
    expect(norm.discriminators?.metric_qualifier).toBe('headline');
  });

  test('other: language_variant into JSONB (folded)', () => {
    const norm = baseNorm({ event_kind: 'other' });
    stampDiscriminators({
      title: 'Will X win Best Anime Voice Artist Performance (Latin Spanish) at the 2026 Crunchyroll Anime Awards?',
      platform: 'polymarket',
    }, norm);
    expect(norm.discriminators?.language_variant).toBe('latin spanish');
  });

  test('non-matching market: none stamped', () => {
    const norm = baseNorm({ event_kind: 'match_winner', canonical_subject: 'Arsenal FC' });
    stampDiscriminators({ title: 'Arsenal vs Chelsea: winner', platform: 'polymarket' }, norm);
    for (const n of NAMES) expect(norm.discriminators?.[n]).toBeUndefined();
  });
});

describe('coherence (consumer 2) — cross-axis drop, tolerant', () => {
  const legs = [
    { market_id: 1, outcome_id: 'o' },
    { market_id: 2, outcome_id: 'o' },
    { market_id: 3, outcome_id: 'o' },
  ];
  const only = (name: string, vals: Record<number, string | null>) =>
    (s: DiscriminatorSpec, mid: number) => (s.name === name ? vals[mid] ?? null : null);

  test('THE SE 2075 FAKE: silver vs golden boot leg → the golden leg drops; NULL kept', () => {
    const r = discriminatorCoherenceDrops(legs, only('award_tier', { 1: 'silver', 2: 'golden', 3: null }));
    expect([...r.drop]).toEqual([2]);
    expect(r.perSpec['award_tier']).toBe(1);
  });

  test('same tier → ZERO drops (two golden-boot mirror legs)', () => {
    const r = discriminatorCoherenceDrops(legs, only('award_tier', { 1: 'golden', 2: 'golden', 3: null }));
    expect(r.drop.size).toBe(0);
  });

  test('THE SE 2801 FAKE: core vs headline CPI leg → the headline leg drops', () => {
    const r = discriminatorCoherenceDrops(legs, only('metric_qualifier', { 1: 'core', 2: 'headline', 3: null }));
    expect([...r.drop]).toEqual([2]);
  });

  test('THE SE 2193 FAKE: latin spanish vs castilian spanish leg → the later leg drops', () => {
    const r = discriminatorCoherenceDrops(legs, only('language_variant', {
      1: 'latin spanish', 2: 'castilian spanish', 3: null,
    }));
    expect([...r.drop]).toEqual([2]);
  });

  test('NULL/unstamped leg never blocks (tolerant)', () => {
    const r = discriminatorCoherenceDrops(legs, only('award_tier', { 1: 'golden', 2: null, 3: null }));
    expect(r.drop.size).toBe(0);
  });
});
