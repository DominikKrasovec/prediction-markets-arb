/**
 * Signature tests for the deterministic KB tie-break: folded canonical text
 * first, id last. A stable sort over KB load order (heap order) would make
 * the winner a per-rebuild lottery; these tests pin that the winner is a
 * pure function of row content, by priming the cache in adversarial insert
 * orders and asserting the same pick.
 */
import { describe, test, expect } from 'bun:test';
import { _t1FromCache, _primeKBCacheForTests } from './cache.js';

const row = (id: number, canonical: string, opts?: Partial<{
  sport: string | null; league: string | null; domain: string; aliases: string[];
}>) => ({
  id,
  canonical,
  domain_category: opts?.domain ?? 'sports',
  type: 'team',
  aliases: opts?.aliases ?? ['shared-alias'],
  sport_canonical: opts?.sport ?? null,
  league_canonical: opts?.league ?? null,
});

describe('deterministic tie-break: folded canonical TEXT ASC, id ASC last', () => {
  test('all-zero scope scores: lexicographically smaller folded TEXT wins, both insert orders', async () => {
    const alpha = row(900, 'Alpha United');
    const zeta = row(100, 'Zeta City'); // LOWER id but LATER text — text must beat id
    for (const order of [[alpha, zeta], [zeta, alpha]]) {
      _primeKBCacheForTests(order);
      const hit = await _t1FromCache('shared-alias', 'shared-alias', 'sports', ['team'], null);
      expect(hit!.canonical).toBe('Alpha United');
    }
  });

  test('same-text forks (the Florida Gators ×3 class): lowest id is the intra-text discriminator', async () => {
    const f1 = row(300, 'Florida Gators', { sport: 'basketball' });
    const f2 = row(150, 'Florida Gators', { sport: 'baseball' });
    const f3 = row(220, 'Florida Gators', { sport: 'american football' });
    for (const order of [[f1, f2, f3], [f3, f1, f2], [f2, f3, f1]]) {
      _primeKBCacheForTests(order);
      const hit = await _t1FromCache('shared-alias', 'shared-alias', 'sports', ['team'], null);
      expect(hit!.id).toBe(150);
      expect(hit!.canonical).toBe('Florida Gators'); // same TEXT either way — invisible downstream
    }
  });

  test('scope scores still dominate: a sport-matched row beats a text-earlier unscoped row', async () => {
    const textEarly = row(1, 'Aardvark FC', { sport: null });
    const scoped = row(2, 'Zebra FC', { sport: 'soccer' });
    for (const order of [[textEarly, scoped], [scoped, textEarly]]) {
      _primeKBCacheForTests(order);
      const hit = await _t1FromCache('shared-alias', 'shared-alias', 'sports', ['team'], { sport: 'soccer' });
      expect(hit!.canonical).toBe('Zebra FC');
    }
  });

  test('diacritics fold before comparing (Águilas sorts as aguilas, beats Bravo)', async () => {
    const accented = row(50, 'Águilas Doradas', { aliases: ['shared-alias', 'aguilas'] });
    const plain = row(10, 'Bravo Town');
    for (const order of [[plain, accented], [accented, plain]]) {
      _primeKBCacheForTests(order);
      const hit = await _t1FromCache('shared-alias', 'shared-alias', 'sports', ['team'], null);
      expect(hit!.canonical).toBe('Águilas Doradas');
    }
  });
});
