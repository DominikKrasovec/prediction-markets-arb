/**
 * A space-invariant (and, composing with the KB's existing case-/diacritic-
 * invariant convention) variant is stored as an additional KB alias for
 * every canonical name and every existing alias, so platform spelling drift
 * like "La Liga" / "LaLiga" / "laliga" resolves to one entity.
 *
 * Matching is already case- and diacritic-insensitive (cache key =
 * `foldAscii(s).toLowerCase()`, SQL = `lower(immutable_unaccent(...))`); the
 * variant key additionally removes all whitespace:
 *
 *       variantKey(s) = foldAscii(s).toLowerCase() with every \s (and NBSP) removed
 *
 * Contract under test:
 *
 *   1. `spaceInvariantVariant(name: string): string | null` — pure, returns
 *      the variant key, or `null` when the result would be empty.
 *
 *   2. `aliasVariantsToAdd(canonical, existingAliases): string[]` — pure,
 *      the de-duped, idempotent set of new variant strings to add: variants
 *      for the canonical and every existing alias, same-entity dedup,
 *      dedup among generated variants, idempotent once present. Never
 *      consults other entities.
 *
 *   3. Cross-entity collision: variant generation must never silently
 *      merge two different entities. The store path that persists these
 *      variants must route through the existing `mergeAliases` collision
 *      guard (entity/register.ts).
 */
import { describe, test, expect } from 'bun:test';

import {
  spaceInvariantVariant,
  aliasVariantsToAdd,
  foldAscii,
} from '../entity-registry.js';

// The exact variant key the contract pins. Tests assert the implementation
// agrees with this composition (existing fold+lower convention + despace).
const variantKey = (s: string): string =>
  foldAscii(s).toLowerCase().replace(/[\s ]+/g, '');

describe('spaceInvariantVariant — core collapse (the motivating case)', () => {
  test('"La Liga", "LaLiga", "laliga" all produce the IDENTICAL variant', () => {
    const a = spaceInvariantVariant('La Liga');
    const b = spaceInvariantVariant('LaLiga');
    const c = spaceInvariantVariant('laliga');
    expect(a).toBe('laliga');
    expect(b).toBe('laliga');
    expect(c).toBe('laliga');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('"Real Madrid" → "realmadrid"', () => {
    expect(spaceInvariantVariant('Real Madrid')).toBe('realmadrid');
  });

  test('variant equals the pinned composition (fold+lower+despace) for many names', () => {
    for (const s of [
      'La Liga', 'LaLiga', 'Real Madrid', 'Manchester United', 'AC Milan',
      'Premier League', 'Serie A', 'Liga MX', 'Primeira Liga',
    ]) {
      expect(spaceInvariantVariant(s)).toBe(variantKey(s));
    }
  });
});

describe('spaceInvariantVariant — distinctness (no over-merge)', () => {
  test('"La Liga 2" → "laliga2" ≠ "laliga"', () => {
    expect(spaceInvariantVariant('La Liga 2')).toBe('laliga2');
    expect(spaceInvariantVariant('La Liga 2')).not.toBe(spaceInvariantVariant('La Liga'));
  });

  test('"liga mx" → "ligamx" (distinct from laliga)', () => {
    expect(spaceInvariantVariant('liga mx')).toBe('ligamx');
    expect(spaceInvariantVariant('liga mx')).not.toBe(spaceInvariantVariant('La Liga'));
  });

  test('"primeira liga" → "primeiraliga" (distinct)', () => {
    expect(spaceInvariantVariant('primeira liga')).toBe('primeiraliga');
    expect(spaceInvariantVariant('primeira liga')).not.toBe(spaceInvariantVariant('La Liga'));
  });

  test('"nike liga" → "nikeliga" (distinct)', () => {
    expect(spaceInvariantVariant('nike liga')).toBe('nikeliga');
    expect(spaceInvariantVariant('nike liga')).not.toBe(spaceInvariantVariant('La Liga'));
  });

  test('all four distinct league names map to four DISTINCT variants', () => {
    const vs = ['La Liga 2', 'liga mx', 'primeira liga', 'nike liga'].map(spaceInvariantVariant);
    expect(new Set(vs).size).toBe(4);
    expect(vs).not.toContain('laliga');
  });

  test('digit suffix is preserved — "Bundesliga" ≠ "Bundesliga 2" / "2. Bundesliga"', () => {
    expect(spaceInvariantVariant('Bundesliga')).toBe('bundesliga');
    expect(spaceInvariantVariant('Bundesliga 2')).toBe('bundesliga2');
    expect(spaceInvariantVariant('2. Bundesliga')).toBe('2.bundesliga');
    expect(spaceInvariantVariant('Bundesliga 2')).not.toBe(spaceInvariantVariant('Bundesliga'));
    expect(spaceInvariantVariant('2. Bundesliga')).not.toBe(spaceInvariantVariant('Bundesliga'));
  });
});

describe('spaceInvariantVariant — whitespace handling (define behavior)', () => {
  test('leading + trailing whitespace removed', () => {
    expect(spaceInvariantVariant('  La Liga  ')).toBe('laliga');
  });

  test('multiple internal spaces collapse (all removed)', () => {
    expect(spaceInvariantVariant('La    Liga')).toBe('laliga');
    expect(spaceInvariantVariant('Real   Madrid')).toBe('realmadrid');
  });

  test('tabs removed', () => {
    expect(spaceInvariantVariant('La\tLiga')).toBe('laliga');
  });

  test('newlines / carriage returns removed', () => {
    expect(spaceInvariantVariant('La\nLiga')).toBe('laliga');
    expect(spaceInvariantVariant('La\r\nLiga')).toBe('laliga');
  });

  test('non-breaking space (U+00A0) removed — pinned behavior', () => {
    expect(spaceInvariantVariant('La Liga')).toBe('laliga');
  });

  test('mixed whitespace kinds all removed together', () => {
    expect(spaceInvariantVariant(' \tLa \n Liga  ')).toBe('laliga');
  });
});

describe('spaceInvariantVariant — case combinations', () => {
  test('UPPER / lower / Mixed / tOGGLE all collapse', () => {
    for (const s of ['LA LIGA', 'la liga', 'La Liga', 'lA lIgA', 'LaLiGa']) {
      expect(spaceInvariantVariant(s)).toBe('laliga');
    }
  });

  test('case + space combined ("LA  LIGA" vs "laliga")', () => {
    expect(spaceInvariantVariant('LA  LIGA')).toBe('laliga');
    expect(spaceInvariantVariant('LA  LIGA')).toBe(spaceInvariantVariant('laliga'));
  });
});

describe('spaceInvariantVariant — already-spaceless / no-op inputs', () => {
  test('"laliga" → "laliga" (variant equals input)', () => {
    expect(spaceInvariantVariant('laliga')).toBe('laliga');
  });

  test('already-spaceless lowercase canonical yields NO new variant to add', () => {
    expect(aliasVariantsToAdd('laliga', [])).toEqual([]);
  });

  test('spaceless-but-uppercase canonical: variant differs only by case, which', () => {
    expect(aliasVariantsToAdd('NBA', [])).toEqual([]);
  });
});

describe('aliasVariantsToAdd — canonical itself contributes a variant', () => {
  test('canonical "La Liga" with no aliases → adds "laliga"', () => {
    expect(aliasVariantsToAdd('La Liga', [])).toEqual(['laliga']);
  });

  test('canonical "Real Madrid" with no aliases → adds "realmadrid"', () => {
    expect(aliasVariantsToAdd('Real Madrid', [])).toEqual(['realmadrid']);
  });

  test('multi-word canonical + spaced aliases → variants for each new spaceless form', () => {
    const got = aliasVariantsToAdd('Premier League', ['English Premier League', 'EPL']);
    expect(got.sort()).toEqual(['englishpremierleague', 'premierleague'].sort());
  });
});

describe('aliasVariantsToAdd — same-entity dedup', () => {
  test('variant equal to an EXISTING alias is not re-added', () => {
    expect(aliasVariantsToAdd('La Liga', ['laliga'])).toEqual([]);
  });

  test('variant equal to existing alias modulo case/space is not re-added', () => {
    expect(aliasVariantsToAdd('La Liga', ['LaLiga'])).toEqual([]);
  });

  test('two aliases that despace to the SAME variant only add it once', () => {
    const got = aliasVariantsToAdd('Spanish La Liga', ['La Liga', 'La  Liga']);
    expect(got.sort()).toEqual(['laliga', 'spanishlaliga'].sort());
    expect(got.filter((v: string) => v === 'laliga')).toHaveLength(1);
  });

  test('canonical variant duplicated by an alias variant is emitted once', () => {
    const got = aliasVariantsToAdd('La Liga', ['LA LIGA']);
    expect(got).toEqual(['laliga']);
  });
});

describe('aliasVariantsToAdd — idempotency', () => {
  test('second pass after applying variants returns []', () => {
    const canonical = 'La Liga';
    const aliases = ['Spanish La Liga', 'La Liga Santander'];
    const first = aliasVariantsToAdd(canonical, aliases);
    expect(first.length).toBeGreaterThan(0);
    const after = [...aliases, ...first];
    const second = aliasVariantsToAdd(canonical, after);
    expect(second).toEqual([]);
  });

  test('running on an entity whose aliases ALREADY contain all variants → []', () => {
    expect(
      aliasVariantsToAdd('Real Madrid', ['realmadrid', 'Real Madrid CF', 'realmadridcf']),
    ).toEqual([]);
  });
});

// The pure variant layer must not itself merge two different entities;
// persisting variants must reuse the existing mergeAliases collision guard.
describe('cross-entity collision — soundness law', () => {
  test('aliasVariantsToAdd is entity-LOCAL: it never inspects other entities', () => {
    const xVariants = aliasVariantsToAdd('La Liga', []);
    expect(xVariants).toEqual(['laliga']);
  });

  test('"A B" (entity X) and "AB" (entity Y) collide on variant but stay separate candidates', () => {
    expect(aliasVariantsToAdd('A B', [])).toEqual(['ab']);
    expect(aliasVariantsToAdd('AB', [])).toEqual([]); // spaceless already
  });

  test('"a b" vs "ab" lowercase collision — same structural case', () => {
    expect(aliasVariantsToAdd('a b', [])).toEqual(['ab']);
    expect(aliasVariantsToAdd('ab', [])).toEqual([]);
  });

  test('CONTRACT MARKER: store-layer guard must be mergeAliases (entity/register.ts)', () => {
    expect(typeof aliasVariantsToAdd).toBe('function');
  });
});

describe('spaceInvariantVariant — degenerate inputs', () => {
  test('empty string → null (no variant)', () => {
    expect(spaceInvariantVariant('')).toBeNull();
  });

  test('whitespace-only → null (variant would be empty)', () => {
    expect(spaceInvariantVariant('   ')).toBeNull();
    expect(spaceInvariantVariant('\t\n')).toBeNull();
    expect(spaceInvariantVariant(' ')).toBeNull();
  });

  test('single character → itself lowercased', () => {
    expect(spaceInvariantVariant('A')).toBe('a');
    expect(spaceInvariantVariant('x')).toBe('x');
  });

  test('numeric-only preserved', () => {
    expect(spaceInvariantVariant('2026')).toBe('2026');
    expect(spaceInvariantVariant('1 2 3')).toBe('123');
  });

  test('aliasVariantsToAdd skips empty / whitespace-only forms (no null in output)', () => {
    const got = aliasVariantsToAdd('La Liga', ['', '   ', '\t']);
    expect(got).toEqual(['laliga']);
    expect(got).not.toContain(null);
    expect(got).not.toContain('');
  });

  test('aliasVariantsToAdd on an entity with empty canonical AND empty aliases → []', () => {
    expect(aliasVariantsToAdd('', [])).toEqual([]);
    expect(aliasVariantsToAdd('   ', ['  '])).toEqual([]);
  });
});

describe('spaceInvariantVariant — unicode/accent interaction (composes with foldAscii)', () => {
  test('accents folded then despaced — "Liga Española" → "ligaespanola"', () => {
    expect(spaceInvariantVariant('Liga Española')).toBe('ligaespanola');
  });

  test('"Atlético Madrid" → "atleticomadrid" (matches ASCII "Atletico Madrid")', () => {
    expect(spaceInvariantVariant('Atlético Madrid')).toBe('atleticomadrid');
    expect(spaceInvariantVariant('Atletico Madrid')).toBe('atleticomadrid');
    expect(spaceInvariantVariant('Atlético Madrid')).toBe(spaceInvariantVariant('Atletico Madrid'));
  });

  test('extended-Latin transliteration composes — "Borußia" → "borussia"', () => {
    expect(spaceInvariantVariant('Borußia')).toBe('borussia');
    expect(spaceInvariantVariant('Borussia')).toBe('borussia');
  });

  test('"São Paulo" → "saopaulo"', () => {
    expect(spaceInvariantVariant('São Paulo')).toBe('saopaulo');
  });

  test('accented multiword canonical contributes a folded+despaced variant', () => {
    expect(aliasVariantsToAdd('Grêmio FBPA', [])).toEqual(['gremiofbpa']);
  });
});

describe('spaceInvariantVariant — multiword', () => {
  test('"Penn State Nittany Lions" → "pennstatenittanylions"', () => {
    expect(spaceInvariantVariant('Penn State Nittany Lions')).toBe('pennstatenittanylions');
  });

  test('"Notre Dame Fighting Irish" → "notredamefightingirish"', () => {
    expect(spaceInvariantVariant('Notre Dame Fighting Irish')).toBe('notredamefightingirish');
  });

  test('punctuation between words is kept (only WHITESPACE is removed)', () => {
    expect(spaceInvariantVariant('St. Louis')).toBe('st.louis');
    expect(spaceInvariantVariant("O'Higgins FC")).toBe("o'higginsfc");
  });
});
