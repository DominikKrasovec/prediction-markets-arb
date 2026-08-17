/**
 * Pure unit tests for the esports sport-hierarchy helpers.
 *
 * Multi-game esports orgs (G2, NaVi, Team Liquid, Fnatic, …) field rosters
 * across different titles, so their same-named rows fork one per game (cs2 /
 * valorant / league of legends). `areEsportsOrgGamesCompatible` lets the
 * type='team' carve-out in isScopeIncompatible fold those into one org
 * identity, without widening the shared `areSportsCompatible` (which gates
 * event matching — cs2↔valorant must stay incompatible there or a CS2
 * fixture would cross-match a Valorant fixture).
 *
 * SOUNDNESS the tests guard:
 *  - areEsportsOrgGamesCompatible is TRUE only when BOTH sides are esports
 *    (game or umbrella), FALSE the moment either side is a non-esports sport.
 *  - areSportsCompatible('cs2','valorant') STAYS FALSE (the event-gate
 *    non-regression — this is the guard that prevents a fake cross-game edge).
 */
import { describe, test, expect } from 'bun:test';
import { areEsportsOrgGamesCompatible, areSportsCompatible, compatibleSportCanonicals } from './sport-hierarchy.js';

describe('NCAA granularity bridge (AUD-37 complement — already shipped, pinned here)', () => {
  test("'<sport> (ncaa)' is compatible with bare '<sport>'", () => {
    expect(areSportsCompatible('basketball (ncaa)', 'basketball')).toBe(true);
    expect(areSportsCompatible('basketball', 'football (ncaa)')).toBe(false); // different family
    expect(areSportsCompatible('football (ncaa)', 'football')).toBe(true);
    expect(areSportsCompatible('basketball (ncaaw)', 'basketball')).toBe(true); // ncaa[a-z]* qualifier
  });

  test("men's/women's marker OUTSIDE the parenthetical stays distinct (conservative carve-out)", () => {
    expect(areSportsCompatible("basketball (ncaa) women's", 'basketball')).toBe(false);
  });

  test('unrelated sports stay incompatible (no over-bridge)', () => {
    expect(areSportsCompatible('basketball', 'football')).toBe(false);
    expect(areSportsCompatible('soccer', 'baseball')).toBe(false);
  });

  test('compatibleSportCanonicals widens a qualified query toward the bare family', () => {
    const out = compatibleSportCanonicals('basketball (ncaa)');
    expect(out).not.toBeNull();
    expect(out).toContain('basketball (ncaa)');
    expect(out).toContain('basketball');
  });

  test('compatibleSportCanonicals leaves a bare non-esports sport as a singleton', () => {
    expect(compatibleSportCanonicals('soccer')).toEqual(['soccer']);
  });
});

describe('areEsportsOrgGamesCompatible (esports org cross-game carve-out)', () => {
  test('two DIFFERENT esports games are org-compatible', () => {
    expect(areEsportsOrgGamesCompatible('cs2', 'valorant')).toBe(true);
    expect(areEsportsOrgGamesCompatible('league of legends', 'dota 2')).toBe(true);
    expect(areEsportsOrgGamesCompatible('valorant', 'rocket league')).toBe(true);
  });

  test('game ↔ umbrella is org-compatible (both directions)', () => {
    expect(areEsportsOrgGamesCompatible('cs2', 'esports')).toBe(true);
    expect(areEsportsOrgGamesCompatible('esports', 'cs2')).toBe(true);
  });

  test('a non-esports sport is NEVER org-compatible with an esports game', () => {
    expect(areEsportsOrgGamesCompatible('cs2', 'soccer')).toBe(false);
    expect(areEsportsOrgGamesCompatible('soccer', 'cs2')).toBe(false);
    expect(areEsportsOrgGamesCompatible('basketball', 'valorant')).toBe(false);
    // two non-esports sports are also NOT esports-org compatible (this helper is
    // ONLY for the esports carve-out; ordinary same-sport compatibility is
    // areSportsCompatible's job).
    expect(areEsportsOrgGamesCompatible('soccer', 'soccer')).toBe(false);
  });

  test('null side is scope-agnostic (consistent with areSportsCompatible)', () => {
    expect(areEsportsOrgGamesCompatible('cs2', null)).toBe(true);
    expect(areEsportsOrgGamesCompatible(null, 'valorant')).toBe(true);
    expect(areEsportsOrgGamesCompatible(null, null)).toBe(true);
  });

  test('case-insensitive', () => {
    expect(areEsportsOrgGamesCompatible('CS2', 'Valorant')).toBe(true);
    expect(areEsportsOrgGamesCompatible('Dota 2', 'ESPORTS')).toBe(true);
  });
});

describe('areSportsCompatible NON-REGRESSION (event-gate must stay strict)', () => {
  test('cross-game esports STAY incompatible (cs2 vs valorant) — guards the fake-edge', () => {
    // This is the soundness guard: the shared helper gates Stage-3 event matching
    // and the T2 resolver. If this ever flips to true, a CS2 fixture could
    // cross-match a Valorant fixture → fake cross-game equivalence/mutex edge.
    expect(areSportsCompatible('cs2', 'valorant')).toBe(false);
    expect(areSportsCompatible('league of legends', 'dota 2')).toBe(false);
  });

  test('umbrella↔game stays compatible (unchanged pre-existing behaviour)', () => {
    expect(areSportsCompatible('cs2', 'esports')).toBe(true);
    expect(areSportsCompatible('esports', 'valorant')).toBe(true);
  });

  test('cs2 vs soccer stays incompatible', () => {
    expect(areSportsCompatible('cs2', 'soccer')).toBe(false);
  });
});

// The isScopeIncompatible sport branch composes the type guard with the helper:
//   entityType==='team' && areEsportsOrgGamesCompatible(existing.sport, incoming.sport)
// → scope-compatible (returns false). Pin that composition's intent here (the
// real isScopeIncompatible is module-private; register.test.ts simulates it).
describe('isScopeIncompatible composition (type-scoped esports-org carve-out)', () => {
  const wouldCarveOut = (entityType: string, a: string | null, b: string | null): boolean =>
    entityType === 'team' && areEsportsOrgGamesCompatible(a, b);

  test('team: cs2 vs valorant → carve-out fires (org merges)', () => {
    expect(wouldCarveOut('team', 'cs2', 'valorant')).toBe(true);
  });

  test('person: cs2 vs valorant → carve-out does NOT fire (players move games/orgs)', () => {
    expect(wouldCarveOut('person', 'cs2', 'valorant')).toBe(false);
  });

  test('team: cs2 vs soccer → carve-out does NOT fire (non-esports stays blocked)', () => {
    expect(wouldCarveOut('team', 'cs2', 'soccer')).toBe(false);
  });
});
