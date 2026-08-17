/**
 * kbFactsHandle contract tests. The handle is the only bridge from the
 * discriminator stamp door into the KB:
 *   · cold cache ⇒ null for everything (never queries the DB);
 *   · warm cache ⇒ facts by canonical OR alias (foldAscii/lower key);
 *   · ambiguous names (≥2 rows disagreeing on a fact) ⇒ that fact is null.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { kbFactsHandle, _primeKBCacheForTests, invalidateKBCache } from './cache.js';
import type { KBRow } from './types.js';

const row = (over: Partial<KBRow>): KBRow => ({
  id: 1, canonical: 'X', domain_category: 'sports', type: 'team', aliases: [],
  sport_canonical: null, league_canonical: null, tour_gender: null, ...over,
});

afterAll(() => invalidateKBCache()); // leave the module cold for sibling tests

describe('kbFactsHandle', () => {
  test('cold cache ⇒ null (warm-cache-only contract; no DB fallback)', () => {
    invalidateKBCache();
    expect(kbFactsHandle().lookupCanonical('WTA Tour')).toBeNull();
  });

  test('warm cache: facts by canonical and by alias (fold-insensitive)', () => {
    _primeKBCacheForTests([
      row({ id: 10, canonical: 'WTA Tour', aliases: ['WTA'], type: 'league', sport_canonical: 'tennis', league_canonical: 'WTA Tour', tour_gender: 'women' }),
    ]);
    const kb = kbFactsHandle();
    expect(kb.lookupCanonical('wta tour')).toEqual({ type: 'league', sport_canonical: 'tennis', league_canonical: 'WTA Tour', tour_gender: 'women' });
    expect(kb.lookupCanonical('WTA')?.sport_canonical).toBe('tennis');
    expect(kb.lookupCanonical('WTA')?.tour_gender).toBe('women');
    expect(kb.lookupCanonical('nonexistent entity')).toBeNull();
  });

  test('tour_gender: absent metadata ⇒ null; disagreeing rows ⇒ null (never guess)', () => {
    _primeKBCacheForTests([
      row({ id: 30, canonical: 'PGA Tour', type: 'league', sport_canonical: 'golf', tour_gender: 'men' }),
      // a bare team with no gender metadata
      row({ id: 31, canonical: 'Arsenal', type: 'team', sport_canonical: 'soccer', tour_gender: null }),
      // an ambiguous alias bucket disagreeing on gender
      row({ id: 32, canonical: 'Phoenix', type: 'team', tour_gender: 'men' }),
      row({ id: 33, canonical: 'Phoenix', type: 'team', tour_gender: 'women' }),
    ]);
    const kb = kbFactsHandle();
    expect(kb.lookupCanonical('PGA Tour')?.tour_gender).toBe('men');
    expect(kb.lookupCanonical('Arsenal')?.tour_gender).toBeNull();
    expect(kb.lookupCanonical('Phoenix')?.tour_gender).toBeNull(); // disagreement ⇒ null
  });

  test('ambiguous name: disagreeing rows null the disagreeing fact, keep the consensus one', () => {
    _primeKBCacheForTests([
      row({ id: 20, canonical: 'Barcelona', type: 'team', sport_canonical: 'soccer', league_canonical: 'La Liga' }),
      row({ id: 21, canonical: 'Barcelona', type: 'team', sport_canonical: 'basketball', league_canonical: 'Liga ACB' }),
    ]);
    const facts = kbFactsHandle().lookupCanonical('Barcelona');
    expect(facts?.type).toBe('team');            // both agree
    expect(facts?.sport_canonical).toBeNull();   // disagreement ⇒ null (never guess)
    expect(facts?.league_canonical).toBeNull();
  });
});
