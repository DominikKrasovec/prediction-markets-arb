/**
 * Tests for entity-enrichment worker helpers. The full worker requires a
 * running PG + LLM so it's exercised by integration tests; this file pins
 * the pure helpers that gate auto-creation of level-1 KB entities.
 */
import { describe, test, expect } from 'bun:test';
import {
  looksLikePlausibleTaxonomyName,
  decideDropSportAsLeague,
  blocksPredicateCanonicalSwap,
  blocksStationCanonicalSwap,
  isAcceptableAlias,
} from './worker.js';

describe('looksLikePlausibleTaxonomyName — taxonomy auto-create input gate', () => {
  test('accepts real-world league names', () => {
    expect(looksLikePlausibleTaxonomyName('FIFA World Cup')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('Premier League')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('Süper Lig')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('NBA')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('J1 League')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('Campeonato Brasileiro Série A')).toBe(true);
  });

  test('accepts real-world sport names', () => {
    expect(looksLikePlausibleTaxonomyName('soccer')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('sumo')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('lacrosse')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('league of legends')).toBe(true);
  });

  test('rejects empty / whitespace-only', () => {
    expect(looksLikePlausibleTaxonomyName('')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('   ')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('\n')).toBe(false);
  });

  test('rejects too short (< 2 chars after trim)', () => {
    expect(looksLikePlausibleTaxonomyName('a')).toBe(false);
    expect(looksLikePlausibleTaxonomyName(' x ')).toBe(false);
  });

  test('rejects pure-numeric / pure-symbol junk', () => {
    expect(looksLikePlausibleTaxonomyName('123')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('---')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('99.99')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('!?')).toBe(false);
  });

  test('rejects compound strings — LLM munged multiple values into one', () => {
    // Real samples that snuck into known_entities during enrichment and
    // created garbage level-1 'sport' rows. The validator must reject
    // anything with slash / comma / ampersand / semicolon / pipe separators.
    expect(looksLikePlausibleTaxonomyName('baseball/basketball')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('ice hockey/baseball')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('MLB, NFL')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('cs2 & valorant')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('basketball;tennis')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('mma|boxing')).toBe(false);
  });

  test('rejects prose connectors — "and" / "or" / "vs"', () => {
    // LLMs sometimes emit "basketball and football" or "cricket or rugby"
    // when an athlete has competed in multiple. These can't be valid level-1
    // names; the worker should defer to per-sport entity duplication
    // (which the UNIQUE constraint already supports via NULLS NOT DISTINCT).
    expect(looksLikePlausibleTaxonomyName('basketball and football')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('cricket or rugby')).toBe(false);
    expect(looksLikePlausibleTaxonomyName('lakers vs celtics')).toBe(false);
    // But standalone words containing those substrings are fine.
    expect(looksLikePlausibleTaxonomyName('Andorra')).toBe(true); // "and" inside word
    expect(looksLikePlausibleTaxonomyName('Florida')).toBe(true); // "or" inside word
  });

  test('rejects implausibly long strings', () => {
    expect(looksLikePlausibleTaxonomyName('x'.repeat(81))).toBe(false);
    // Just under the limit is fine.
    expect(looksLikePlausibleTaxonomyName('x'.repeat(80))).toBe(true);
  });

  test('accepts names with non-ASCII letters', () => {
    // Generic guard: at least one A-Z letter required. Türkçe names with
    // ASCII chars in them ('Süper Lig' has 'S','u','p','e','r','L','i','g')
    // pass. Pure non-ASCII names (e.g. 大相撲) currently fall through;
    // documented limitation acceptable until a real case surfaces.
    expect(looksLikePlausibleTaxonomyName('Süper Lig')).toBe(true);
    expect(looksLikePlausibleTaxonomyName('Eliteserien')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decideDropSportAsLeague: a sport name is never a league. Drops
// league_canonical when the candidate resolves to a sport canonical that
// differs from any real league resolution.
// ---------------------------------------------------------------------------
describe('decideDropSportAsLeague (sport-name-as-league guard)', () => {
  test('DROP: candidate resolves to a SPORT with NO real league reading (cs2 / lol / valorant)', () => {
    expect(decideDropSportAsLeague(null, 'cs2')).toBe(true);
    expect(decideDropSportAsLeague(null, 'league of legends')).toBe(true);
    expect(decideDropSportAsLeague(null, 'valorant')).toBe(true);
    expect(decideDropSportAsLeague(null, 'esports')).toBe(true);
  });

  test('SOUNDNESS BOUNDARY: candidate resolves to BOTH a sport AND a real (different) league → KEEP', () => {
    // A real league whose name doubles as a sport token must NOT be dropped:
    // NRL = 'National Rugby League' (league) yet 'nrl' is also a 'rugby league'
    // sport alias; NCAAB/NCAAF similarly. The non-null league reading wins.
    expect(decideDropSportAsLeague('National Rugby League', 'rugby league')).toBe(false);
    expect(decideDropSportAsLeague('NCAA Football', 'american football (ncaa)')).toBe(false);
  });

  test('KEEP: candidate did NOT resolve to a sport (a real league name)', () => {
    expect(decideDropSportAsLeague('Premier League', null)).toBe(false);
    expect(decideDropSportAsLeague(null, null)).toBe(false);
  });

  test('KEEP: candidate resolves to a sport whose canonical EQUALS a real league (same-named league kept)', () => {
    // e.g. a league legitimately named identically to a sport canonical — keep it.
    expect(decideDropSportAsLeague('cricket', 'cricket')).toBe(false);
    expect(decideDropSportAsLeague('Boxing', 'boxing')).toBe(false); // case-insensitive
  });
});

// ---------------------------------------------------------------------------
// blocksPredicateCanonicalSwap: rejects a canonical swap to a predicate/
// question title on a level-2 row (keeps the existing canonical). A real
// entity-name swap is not blocked.
// ---------------------------------------------------------------------------
describe('blocksPredicateCanonicalSwap (predicate-title swap guard)', () => {
  // 4th arg = kbKnown (T1-before-gate bypass). These predicate titles are not
  // KB entities, so kbKnown=false and the gate applies as before.
  test('BLOCKS a swap to a predicate/question/measurement TITLE on a level-2 row', () => {
    expect(blocksPredicateCanonicalSwap('Will the Lakers win the title?', false, true, false)).toBe(true);
    expect(blocksPredicateCanonicalSwap('Texas 09 House General Election: voter turnout', false, true, false)).toBe(true);
    expect(blocksPredicateCanonicalSwap("Florida's 15th District margin of victory", false, true, false)).toBe(true);
    expect(blocksPredicateCanonicalSwap('Solana price on May 15', false, true, false)).toBe(true);
    expect(blocksPredicateCanonicalSwap('Amazon (AMZN) closes week of May 11 at ___', false, true, false)).toBe(true);
  });

  test('SOUNDNESS BOUNDARY: a real entity-name swap is NOT blocked', () => {
    expect(blocksPredicateCanonicalSwap('Manchester United', false, true, false)).toBe(false);
    expect(blocksPredicateCanonicalSwap('Anthony Edwards', false, true, false)).toBe(false);
    expect(blocksPredicateCanonicalSwap('S&P 500', false, true, false)).toBe(false);
  });

  test('T1-before-gate: a KB-known name that TRIPS looksLikePredicate is NOT blocked', () => {
    // "For The Win FC" / "Win Gatchalian" trip looksLikePredicate's "win" verb, and
    // "US U-3 Unemployment Rate" its metric rule — but all three are real KB
    // entities (kbKnown=true), so the bypass allows the rename.
    expect(blocksPredicateCanonicalSwap('For The Win FC', false, true, true)).toBe(false);
    expect(blocksPredicateCanonicalSwap('Win Gatchalian', false, true, true)).toBe(false);
    expect(blocksPredicateCanonicalSwap('US U-3 Unemployment Rate', false, true, true)).toBe(false);
    // Same strings WITHOUT the KB rescue stay blocked (pollution direction).
    expect(blocksPredicateCanonicalSwap('For The Win FC', false, true, false)).toBe(true);
    expect(blocksPredicateCanonicalSwap('Win Gatchalian', false, true, false)).toBe(true);
  });

  test('does nothing when no swap is proposed', () => {
    expect(blocksPredicateCanonicalSwap('Will X win?', false, false, false)).toBe(false);
  });

  test('does nothing on a level-1 taxonomy row (handled by the taxonomy guard, not this one)', () => {
    expect(blocksPredicateCanonicalSwap('Will X win?', true, true, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// blocksStationCanonicalSwap: the canonical-swap path must never erase (or
// mint) the Stage-1 weather-station discriminator.
// ---------------------------------------------------------------------------
describe('blocksStationCanonicalSwap (station-discriminator swap guard)', () => {
  test('BLOCKS the observed erasure direction: station-scoped → bare city', () => {
    expect(blocksStationCanonicalSwap('LaGuardia Airport, New York City', 'New York City', true)).toBe(true);
    expect(blocksStationCanonicalSwap('Malpensa International Airport, Milan', 'Milan', true)).toBe(true);
    expect(blocksStationCanonicalSwap('Central Park, New York City', 'New York City', true)).toBe(true);
    expect(blocksStationCanonicalSwap('Masroor Airbase, Karachi', 'Karachi', true)).toBe(true);
  });

  test('BLOCKS the reverse hijack: bare city → station-scoped', () => {
    expect(blocksStationCanonicalSwap('New York City', 'LaGuardia Airport, New York City', true)).toBe(true);
    expect(blocksStationCanonicalSwap('Milan', 'Malpensa International Airport, Milan', true)).toBe(true);
  });

  test('SOUNDNESS BOUNDARY: same-scopedness swaps are NOT blocked', () => {
    // station → station (verbosity correction; discriminator preserved)
    expect(blocksStationCanonicalSwap('LaGuardia Airport, New York City', 'LaGuardia International Airport, New York City', true)).toBe(false);
    // city → city (ordinary canonical correction)
    expect(blocksStationCanonicalSwap('NYC', 'New York City', true)).toBe(false);
    // sports entities never trip the predicate at all
    expect(blocksStationCanonicalSwap('New York City', 'New York City FC', true)).toBe(false);
    expect(blocksStationCanonicalSwap('Everton', 'Everton FC', true)).toBe(false);
  });

  test('does nothing when no swap is proposed', () => {
    expect(blocksStationCanonicalSwap('LaGuardia Airport, New York City', 'New York City', false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAcceptableAlias station rules: the alias-level versions of the same
// policy. (1) a station/venue-scoped alias must never land on a non-station
// canonical; (2) the station canonical's own city tail must never become its
// alias. Everything else about the existing alias gate stays intact.
// ---------------------------------------------------------------------------
describe('isAcceptableAlias (station-discriminator alias rules)', () => {
  test('REJECTS station-scoped aliases on a bare city/location canonical', () => {
    expect(isAcceptableAlias('LaGuardia Airport', 'New York City', 'location')).toBe(false);
    expect(isAcceptableAlias('LaGuardia Airport, New York City', 'New York City', 'location')).toBe(false);
    expect(isAcceptableAlias('Central Park, New York City', 'New York City', 'location')).toBe(false);
    expect(isAcceptableAlias('Malpensa International Airport', 'Milan', 'location')).toBe(false);
  });

  test('REJECTS the bare city tail as an alias of the station entity', () => {
    expect(isAcceptableAlias('New York City', 'LaGuardia Airport, New York City', 'location')).toBe(false);
    expect(isAcceptableAlias('Milan', 'Malpensa International Airport, Milan', 'location')).toBe(false);
  });

  test('ACCEPTS legitimate station variants on a station-scoped canonical', () => {
    expect(isAcceptableAlias('LaGuardia Airport', 'LaGuardia Airport, New York City', 'location')).toBe(true);
    expect(isAcceptableAlias('LaGuardia', 'LaGuardia Airport, New York City', 'location')).toBe(true);
    expect(isAcceptableAlias('KLGA', 'LaGuardia Airport, New York City', 'location')).toBe(true);
    expect(isAcceptableAlias('Malpensa', 'Malpensa International Airport, Milan', 'location')).toBe(true);
  });

  test('ACCEPTS ordinary city + sports aliases unchanged (no regression)', () => {
    expect(isAcceptableAlias('NYC', 'New York City', 'location')).toBe(true);
    expect(isAcceptableAlias('The Big Apple', 'New York City', 'location')).toBe(true);
    // bare sports venues are NOT station-scoped → unaffected
    expect(isAcceptableAlias('Goodison Park', 'Everton', 'team')).toBe(true);
    expect(isAcceptableAlias('Madison Square Garden', 'New York Knicks', 'team')).toBe(true);
  });
});
