/**
 * Asserts the golden-market fixture corpus shape stays valid: stable ids,
 * complete assertions, no degenerate cases.
 */
import { describe, test, expect } from 'bun:test';
import { GOLDEN_MARKETS, validateGoldenCorpus } from './__fixtures__/golden-markets.js';

describe('Layer 4 golden-markets corpus — shape sanity', () => {
  test('corpus passes its own validator (no dup ids, every case has entities)', () => {
    expect(() => validateGoldenCorpus()).not.toThrow();
  });

  test('corpus has at least 10 cases spanning the four selection categories', () => {
    expect(GOLDEN_MARKETS.length).toBeGreaterThanOrEqual(10);
    const ids = GOLDEN_MARKETS.map((m) => m.id);
    expect(ids.some((id) => id.includes('iem-atlanta'))).toBe(true);
    expect(ids.some((id) => id.includes('cs2'))).toBe(true);
    expect(ids.some((id) => id.includes('lakers') || id.includes('lal'))).toBe(true);
    expect(ids.some((id) => id.includes('bitcoin') || id.includes('trump'))).toBe(true);
    expect(ids.some((id) => id.includes('football'))).toBe(true);
    expect(ids.some((id) => id.includes('world-cup') || id.includes('champions'))).toBe(true);
  });

  test('every case declares a platform from the known set', () => {
    const KNOWN_PLATFORMS = new Set(['kalshi', 'polymarket', 'limitless', 'predict', 'opinion', 'probable']);
    for (const m of GOLDEN_MARKETS) {
      expect(KNOWN_PLATFORMS.has(m.platform)).toBe(true);
    }
  });

  test('every entity assertion has a recognised type', () => {
    const TYPES = new Set([
      'person', 'team', 'league', 'competition', 'sport',
      'asset', 'data_provider', 'organization', 'location', 'event_name',
    ]);
    for (const m of GOLDEN_MARKETS) {
      for (const e of m.expected.entities) {
        expect(TYPES.has(e.type)).toBe(true);
      }
    }
  });

  test('canonical_subject is one of the declared entities (Stage 1 must match canonical OR alias)', () => {
    for (const m of GOLDEN_MARKETS) {
      const canonicals = m.expected.entities.map((e) => e.canonical);
      const aliases = m.expected.entities
        .map((e) => e.mustResolveAlias)
        .filter((a): a is string => !!a);
      const allForms = [...canonicals, ...aliases];
      expect(allForms).toContain(m.expected.canonical_subject);
    }
  });
});
