/**
 * Signature tests for the resolution-time alias deny-list — pinned without a
 * DB: the in-process KB cache is primed via `_primeKBCacheForTests`, then
 * `_t1FromCache` (the only consumer of the alias tiers) is exercised against
 * the 'usc' collision class.
 *
 * The invariant these tests pin: without the deny-list, 'usc' resolution
 * among {USC Trojans, South Carolina Gamecocks} is a heap-order lottery
 * (rank ties at zero with no scope). With it, the Gamecocks candidate is
 * structurally excluded — 'usc' resolves to USC Trojans or misses; it can
 * never return the denied target.
 */
import { describe, test, expect } from 'bun:test';
import { isAliasDenied, ALIAS_DENY_LIST } from './alias-deny-list.js';
import { _t1FromCache, _primeKBCacheForTests } from './cache.js';

const GAMECOCKS = {
  id: 17414, canonical: 'South Carolina Gamecocks', domain_category: 'sports',
  type: 'team', aliases: ['usc', 'gamecocks', 'South Carolina'],
  sport_canonical: 'american football', league_canonical: 'NCAAF',
};
const TROJANS = {
  id: 5143, canonical: 'USC Trojans', domain_category: 'sports',
  type: 'team', aliases: ['usc', 'USC', 'Trojans'],
  sport_canonical: 'american football (ncaa)', league_canonical: 'NCAAF',
};

describe('isAliasDenied (pure)', () => {
  test("denies 'usc' → South Carolina Gamecocks (team)", () => {
    expect(isAliasDenied('usc', 'team', 'south carolina gamecocks')).toBe(true);
  });
  test('does not deny other aliases on the same target', () => {
    expect(isAliasDenied('gamecocks', 'team', 'south carolina gamecocks')).toBe(false);
    expect(isAliasDenied('south carolina', 'team', 'south carolina gamecocks')).toBe(false);
  });
  test("does not deny 'usc' on other entities", () => {
    expect(isAliasDenied('usc', 'team', 'usc trojans')).toBe(false);
  });
  test('every deny entry keys on (type, folded canonical), never an id', () => {
    for (const e of ALIAS_DENY_LIST) {
      expect(e.canonicalFold).toBe(e.canonicalFold.toLowerCase());
      expect(e.denyAliasFolds.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThan(10);
    }
  });

  // The bare-word 'avalanche' alias on the AVAX crypto asset is domain-scoped
  // — honored for crypto lookups, refused everywhere else (incl. the 'other'
  // scope-less wildcard and callers with no domain).
  test("domain-scoped entry: 'avalanche' → AVAX denied outside crypto only", () => {
    expect(isAliasDenied('avalanche', 'asset', 'avax', 'crypto')).toBe(false);
    expect(isAliasDenied('avalanche', 'asset', 'avax', 'sports')).toBe(true);
    expect(isAliasDenied('avalanche', 'asset', 'avax', 'other')).toBe(true);
    expect(isAliasDenied('avalanche', 'asset', 'avax')).toBe(true); // no domain = conservative deny
    // ticker/pair aliases are untouched
    expect(isAliasDenied('avax/usd', 'asset', 'avax', 'other')).toBe(false);
  });

  test('unconditional entries ignore the domain arg (usc denied in every domain)', () => {
    expect(isAliasDenied('usc', 'team', 'south carolina gamecocks', 'sports')).toBe(true);
    expect(isAliasDenied('usc', 'team', 'south carolina gamecocks', 'other')).toBe(true);
  });
});

describe('_t1FromCache honors the deny-list at the alias tiers', () => {
  test("adversarial bucket order: 'usc' NEVER resolves to the denied Gamecocks", async () => {
    _primeKBCacheForTests([GAMECOCKS, TROJANS]); // denied target FIRST (the heap-order trap)
    const hit = await _t1FromCache('usc', 'usc', 'sports', ['team'], null);
    expect(hit).not.toBeNull();
    expect(hit!.canonical).toBe('USC Trojans');
  });

  test("denied target is the ONLY candidate → honest MISS (null), never the wrong hit", async () => {
    _primeKBCacheForTests([GAMECOCKS]);
    const hit = await _t1FromCache('usc', 'usc', 'sports', ['team'], null);
    expect(hit).toBeNull();
  });

  test('T1a canonical match is exempt: the denied row still resolves by its own canonical', async () => {
    _primeKBCacheForTests([GAMECOCKS]);
    const hit = await _t1FromCache('south carolina gamecocks', 'South Carolina Gamecocks', 'sports', ['team'], null);
    expect(hit).not.toBeNull();
    expect(hit!.canonical).toBe('South Carolina Gamecocks');
  });

  test('non-denied aliases on the denied row still resolve (enrichment preserved)', async () => {
    _primeKBCacheForTests([GAMECOCKS]);
    const hit = await _t1FromCache('gamecocks', 'gamecocks', 'sports', ['team'], null);
    expect(hit).not.toBeNull();
    expect(hit!.canonical).toBe('South Carolina Gamecocks');
  });

  // The AVAX bare-'Avalanche' scope-gate, end to end.
  const AVAX = {
    id: 8, canonical: 'AVAX', domain_category: 'crypto',
    type: 'asset', aliases: ['Avalanche', 'avalanche', 'AVAX/USD', 'AVAXUSD'],
    sport_canonical: null, league_canonical: null,
  };

  test("crypto lookup still resolves 'Avalanche' → AVAX (home-domain recall kept)", async () => {
    _primeKBCacheForTests([AVAX]);
    const hit = await _t1FromCache('avalanche', 'Avalanche', 'crypto', null, null);
    expect(hit).not.toBeNull();
    expect(hit!.canonical).toBe('AVAX');
  });

  test("scope-less ('other') lookup can NEVER land 'Avalanche' on the crypto asset", async () => {
    _primeKBCacheForTests([AVAX]);
    const hit = await _t1FromCache('avalanche', 'Avalanche', 'other', null, null);
    expect(hit).toBeNull(); // honest MISS → T2 can find 'Colorado Avalanche'
  });

  test("T1a exemption: canonical 'AVAX' still resolves from any domain", async () => {
    _primeKBCacheForTests([AVAX]);
    const hit = await _t1FromCache('avax', 'AVAX', 'other', null, null);
    expect(hit).not.toBeNull();
    expect(hit!.canonical).toBe('AVAX');
  });

  test("ticker-pair aliases on AVAX stay honored outside crypto ('AVAX/USD')", async () => {
    _primeKBCacheForTests([AVAX]);
    const hit = await _t1FromCache('avax/usd', 'AVAX/USD', 'other', null, null);
    expect(hit).not.toBeNull();
    expect(hit!.canonical).toBe('AVAX');
  });
});
