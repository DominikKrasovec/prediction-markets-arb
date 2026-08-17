/**
 * KB-presence refusal-gate bypass.
 *
 * Pure unit tests over the in-process KB cache (`_primeKBCacheForTests`), no
 * DB. Pins the bypass contract:
 *   - a string that fold-matches a real KB canonical/alias is legitimized;
 *   - pollution canonicals (Draw/Tie, placeholder shapes) NEVER legitimize
 *     their own label (self-legitimization guard);
 *   - short bare-numeric canonicals ("33", "2007") DO legitimize — the
 *     register.ts real-team exemption;
 *   - unwarmed-cache sync behavior is conservative (false).
 *
 * IMPORTANT (process-shared cache): every test primes the cache explicitly
 * and the afterAll resets it to an EMPTY-but-loaded state so sibling test
 * files see kbHasRealEntitySync === false everywhere, exactly like an
 * unwarmed cache.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { kbHasRealEntity, kbHasRealEntitySync } from './resolvers.js';
import { _primeKBCacheForTests } from './cache.js';
import type { KBRow } from './types.js';
import { gatedEventAlias } from '../../util/event-alias.js';
import { entitySpecificTokens, T2_CONTEXT_TOKENS } from './tokens.js';

const kbRow = (id: number, canonical: string, aliases: string[] = [], type = 'team'): KBRow => ({
  id,
  canonical,
  domain_category: 'sports',
  type,
  aliases,
  sport_canonical: null,
  league_canonical: null,
});

beforeAll(() => {
  _primeKBCacheForTests([
    kbRow(1, 'Team WE', ['WE']),                       // real LPL org — the headline FP
    kbRow(2, 'B8'),                                    // real esports org (k/m/b class)
    kbRow(3, 'M80'),
    kbRow(4, '33'),                                    // real CS2 team (bare numeric)
    kbRow(5, '2007'),                                  // real CS2 team (bare numeric)
    kbRow(6, 'FiveThirtyEight', ['538'], 'organization'),
    kbRow(7, 'Club 360'),
    kbRow(8, 'Draw', [], 'team'),                      // KB POLLUTION (16 live rows)
    kbRow(9, 'Tie', [], 'team'),                       // KB POLLUTION
    kbRow(10, 'Team A', [], 'team'),                   // hypothetical placeholder pollution
    kbRow(11, 'Atlético Madrid', []),                  // diacritic fold check
    kbRow(12, 'Beauty And A Beat', [], 'event_name'),  // looksLikePredicate FP (music title)
    kbRow(13, 'March 31, 2026', [], 'unknown'),        // hypothetical date-value pollution
    kbRow(14, 'AP', [], 'data_provider'),              // Associated Press — fold-collides with Iran git 'ap'
    kbRow(15, 'AZ', [], 'team'),                       // AZ Alkmaar — fold-collides with Iran git 'az'
  ]);
});

afterAll(() => {
  // Empty-but-loaded: sync checks return false (pre-fix behavior) for
  // subsequent test files in the same process.
  _primeKBCacheForTests([]);
});

describe('kbHasRealEntitySync — KB presence legitimizes', () => {
  test('real entities that false-positive the anon/value gates are legitimized', () => {
    expect(kbHasRealEntitySync('Team WE')).toBe(true);
    expect(kbHasRealEntitySync('team we')).toBe(true);   // case-fold
    expect(kbHasRealEntitySync('B8')).toBe(true);
    expect(kbHasRealEntitySync('M80')).toBe(true);
    expect(kbHasRealEntitySync('Club 360')).toBe(true);
  });

  test('alias match legitimizes ("538" → FiveThirtyEight, "WE" → Team WE)', () => {
    expect(kbHasRealEntitySync('538')).toBe(true);
    expect(kbHasRealEntitySync('WE')).toBe(true);
  });

  test('bare-numeric REAL teams legitimize (register.ts:91 exemption)', () => {
    expect(kbHasRealEntitySync('33')).toBe(true);
    expect(kbHasRealEntitySync('2007')).toBe(true);
  });

  test('≤2-char strings require a CASE-EXACT hit (Iran-redaction guard)', () => {
    // Lowercase Iran-head-of-state redaction gits fold-collide with unrelated
    // real entities — a case-folded match on a ≤2-char string is too weak.
    expect(kbHasRealEntitySync('ap')).toBe(false);  // ≠ Associated Press
    expect(kbHasRealEntitySync('az')).toBe(false);  // ≠ AZ Alkmaar
    expect(kbHasRealEntitySync('AP')).toBe(true);   // verbatim short name is fine
    expect(kbHasRealEntitySync('B8')).toBe(true);   // real 2-char org, case-exact
    expect(kbHasRealEntitySync('b8')).toBe(false);  // lowercased ≠ verbatim
    expect(kbHasRealEntitySync('WE')).toBe(true);   // Team WE alias, case-exact
    expect(kbHasRealEntitySync('we')).toBe(false);
  });

  test('diacritic fold: ASCII query matches accented canonical', () => {
    expect(kbHasRealEntitySync('Atletico Madrid')).toBe(true);
  });

  test('unregistered strings never legitimize (redactions keep bailing)', () => {
    expect(kbHasRealEntitySync('Player AH')).toBe(false);
    expect(kbHasRealEntitySync('Person AA')).toBe(false);
    expect(kbHasRealEntitySync('Oh My God')).toBe(false); // real org but NOT in this KB
    expect(kbHasRealEntitySync('')).toBe(false);
    expect(kbHasRealEntitySync(null)).toBe(false);
    expect(kbHasRealEntitySync(undefined)).toBe(false);
  });
});

describe('kbHasRealEntitySync — pollution self-legitimization guard', () => {
  test('Draw/Tie pollution rows never legitimize their own label', () => {
    expect(kbHasRealEntitySync('Draw')).toBe(false);
    expect(kbHasRealEntitySync('Tie')).toBe(false);
    expect(kbHasRealEntitySync('draw')).toBe(false);
  });

  test('placeholder-shaped pollution canonicals never legitimize', () => {
    expect(kbHasRealEntitySync('Team A')).toBe(false);
  });

  test('date/value-shaped pollution canonicals never legitimize', () => {
    expect(kbHasRealEntitySync('March 31, 2026')).toBe(false);
  });
});

describe('kbHasRealEntity (async) — same verdicts on a loaded cache', () => {
  test('mirrors the sync variant', async () => {
    expect(await kbHasRealEntity('Team WE')).toBe(true);
    expect(await kbHasRealEntity('Draw')).toBe(false);
    expect(await kbHasRealEntity('Player AH')).toBe(false);
    expect(await kbHasRealEntity('')).toBe(false);
  });
});

describe('fix ⑥ — gatedEventAlias T1-before-gate', () => {
  test('registered event names survive the predicate/value gates', () => {
    // ">5 significant words" / \bbeat\b would gate this music title; the KB
    // presence wins.
    expect(gatedEventAlias('Beauty And A Beat')).toEqual(['Beauty And A Beat']);
  });

  test('unregistered predicate/question titles are still refused', () => {
    expect(gatedEventAlias('Will X place first in the 2026 CA-19 primary?')).toEqual([]);
    expect(gatedEventAlias('Highest temperature in Sao Paulo on May 13')).toEqual([]);
  });

  test('pollution canonicals do not rescue their own label', () => {
    expect(gatedEventAlias('March 31, 2026')).toEqual([]);
  });
});

describe('fix ⑧ — merge-blindness telemetry primitive', () => {
  test('entitySpecificTokens: merge-blind names yield []', () => {
    expect(entitySpecificTokens('Team WE')).toEqual([]);   // ['team'] all-context
    expect(entitySpecificTokens('WE')).toEqual([]);        // <3-char token dropped
    expect(entitySpecificTokens('FOR')).toEqual([]);       // context token
    expect(entitySpecificTokens('杀破狼')).toEqual([]);     // CJK folds to zero ASCII tokens
  });

  test('normal names carry entity-specific tokens', () => {
    expect(entitySpecificTokens('Team USA')).toEqual(['usa']);
    expect(entitySpecificTokens('Boston Celtics')).toEqual(['boston', 'celtics']);
    expect(entitySpecificTokens('FiveThirtyEight').length).toBeGreaterThan(0);
  });

  test('T2_CONTEXT_TOKENS is the shared belt definition (spot pins)', () => {
    for (const t of ['team', 'party', 'coach', 'saudi', 'club', 'draw', 'win']) {
      expect(T2_CONTEXT_TOKENS.has(t)).toBe(true);
    }
    expect(T2_CONTEXT_TOKENS.has('usa')).toBe(false);
  });
});
