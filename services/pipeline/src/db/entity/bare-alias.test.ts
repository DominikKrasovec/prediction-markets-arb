/**
 * The bare-alias classifier + the write-side scope predicate.
 *
 * Fixtures: KE1837 `CA San Lorenzo de Almagro` (unscoped, carrying the bare
 * `San Lorenzo` / `sanlorenzo`) and KE1838 `Recoleta FC` (unscoped, carrying
 * the bare `Recoleta`). The bar the classifier must clear: kill the
 * SHORTENED forms while keeping the full name and the despaced fold-variants
 * `mergeAliasVariants` mints from it — a classifier that eats
 * `sanlorenzodealmagro` would gut the T1 lookup path it was written for.
 */
import { describe, test, expect } from 'bun:test';
import { classifyBareAliases, isBareAliasFor, isCodeLikeAlias, BARE_ALIAS_SCOPED_TYPES } from './bare-alias.js';
import { bareAliasWritable } from './register.js';

const KE1837 = {
  canonical: 'CA San Lorenzo de Almagro',
  aliases: ['casanlorenzodealmagro', 'San Lorenzo', 'San Lorenzo de Almagro', 'sanlorenzo', 'sanlorenzodealmagro'],
};
const KE1838 = { canonical: 'Recoleta FC', aliases: ['recoletafc', 'Recoleta'] };

describe('classifyBareAliases', () => {
  test('KE1837: the shortened forms are bare; the full name + its fold variants are kept', () => {
    const { bare, kept } = classifyBareAliases(KE1837.canonical, KE1837.aliases);
    expect(bare.sort()).toEqual(['San Lorenzo', 'sanlorenzo']);
    expect(kept.sort()).toEqual(['San Lorenzo de Almagro', 'casanlorenzodealmagro', 'sanlorenzodealmagro']);
  });

  test('KE1838: the bare single token is bare; the canonical fold variant is kept', () => {
    const { bare, kept } = classifyBareAliases(KE1838.canonical, KE1838.aliases);
    expect(bare).toEqual(['Recoleta']);
    expect(kept).toEqual(['recoletafc']);
  });

  test('tickers / codes / ≤2-char forms are never bare', () => {
    const { bare } = classifyBareAliases('Arsenal FC', ['ARS', 'AFC', 'X1']);
    expect(bare).toEqual([]);
    expect(isCodeLikeAlias('ARS')).toBe(true);
    expect(isCodeLikeAlias('Recoleta')).toBe(false);
  });

  test('a longer, MORE specific alias (superset of the canonical tokens) is not bare', () => {
    const { bare } = classifyBareAliases('Boca Juniors', ['Club Atletico Boca Juniors']);
    expect(bare).toEqual([]);
  });

  test('an unrelated alias (disjoint tokens, ≥2 of them) is not bare — this gate is about SHORTENING', () => {
    const { bare } = classifyBareAliases('Internazionale Milano', ['Inter Milan']);
    expect(bare).toEqual([]);
  });

  test('idempotent: re-classifying the KEPT set produces no further bare aliases', () => {
    const first = classifyBareAliases(KE1837.canonical, KE1837.aliases);
    const second = classifyBareAliases(KE1837.canonical, first.kept);
    expect(second.bare).toEqual([]);
    expect(second.kept.sort()).toEqual(first.kept.sort());
  });

  test('isBareAliasFor agrees with classifyBareAliases for a not-yet-present candidate', () => {
    expect(isBareAliasFor('Recoleta FC', ['recoletafc'], 'Recoleta')).toBe(true);
    expect(isBareAliasFor('Recoleta FC', ['recoletafc'], 'Recoleta Futbol Club')).toBe(false);
  });
});

describe('bareAliasWritable (the mergeAliases gate predicate)', () => {
  const team = (league: string | null) => ({ type: 'team', canonical: 'Recoleta FC', league_canonical: league });

  test('REFUSED on an unscoped team row (the KE1838 magnet)', () => {
    expect(bareAliasWritable(team(null), ['recoletafc'], 'Recoleta')).toBe(false);
  });

  test('ACCEPTED once the row carries a league (the scope makes the bare form identifying)', () => {
    expect(bareAliasWritable(team('Primera Division'), ['recoletafc'], 'Recoleta')).toBe(true);
  });

  test('a NON-bare alias is accepted on an unscoped row (fold variant / full name / ticker)', () => {
    expect(bareAliasWritable(team(null), [], 'recoletafc')).toBe(true);
    expect(bareAliasWritable(team(null), [], 'Recoleta Futbol Club')).toBe(true);
    expect(bareAliasWritable(team(null), [], 'RFC')).toBe(true);
  });

  test('non-team types are out of scope by construction (leagues have NULL league by nature)', () => {
    expect(BARE_ALIAS_SCOPED_TYPES.has('team')).toBe(true);
    expect(BARE_ALIAS_SCOPED_TYPES.has('league')).toBe(false);
    expect(
      bareAliasWritable({ type: 'league', canonical: 'Premier League', league_canonical: null }, [], 'Premier'),
    ).toBe(true);
    expect(
      bareAliasWritable({ type: 'person', canonical: 'Lionel Messi', league_canonical: null }, [], 'Messi'),
    ).toBe(true);
  });
});

/**
 * FALSE-POSITIVE GUARDS — the forms that LOOK short but carry information the
 * canonical does not: same-city letter codes (seedSameCityTeamCodes pins),
 * abbreviation aliases, and differently-spelled sibling names must all
 * survive the gate.
 */
describe('classifyBareAliases — must NOT eat informative short forms', () => {
  test('RC2 same-city letter code "<City> <letter>" is NOT bare ("w" is not "white")', () => {
    expect(classifyBareAliases('Chicago White Sox', ['Chicago W', 'chicagow']).bare).toEqual([]);
  });

  test('name + abbreviation ("Denver DEN") is NOT bare', () => {
    expect(classifyBareAliases('Denver Nuggets', ['Denver DEN', 'DEN Nuggets']).bare).toEqual([]);
  });

  test('a differently-spelled sibling form is NOT bare (new tokens ⟹ new information)', () => {
    expect(classifyBareAliases('Internazionale Milano', ['Inter Milan', 'Inter']).bare).toEqual([]);
  });

  test('the despaced variant of a FULL alias survives; the despaced BARE one does not', () => {
    const { bare, kept } = classifyBareAliases('CA San Lorenzo de Almagro', ['sanlorenzodealmagro', 'sanlorenzo']);
    expect(kept).toContain('sanlorenzodealmagro');
    expect(bare).toEqual(['sanlorenzo']);
  });
});
