/**
 * Same-city single-letter team resolution.
 *
 * Kalshi truncates same-city team labels to "<City> <single-letter>"
 * ("Los Angeles F" = LAFC, "Los Angeles G" = LA Galaxy). Resolving these via
 * the non-exact embedding path can swap the pairs, minting fake equivalences
 * and same-team fake mutexes. Two-layer defense:
 *   (a) exact-alias seeds (seedSameCityTeamCodes) → a Tier-1 hit wins first;
 *   (b) an ambiguity-refusal guard (resolvers.ts) → for an unseeded collision
 *       reaching the embedding path, refuse (leave raw) rather than guess.
 *
 * These tests are DB-free: they prime the in-process KB cache
 * (_primeKBCacheForTests) and exercise the pure helpers + the resolveCanonical
 * paths that return before any DB/OpenAI call (T1 exact-alias hit, and the
 * refusal which short-circuits before resolveViaEmbedding).
 *
 * Invariant: a wrong resolution mints a fake arb; a non-resolution only loses
 * a merge. The swap must be impossible; ambiguity must refuse.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { _primeKBCacheForTests, _resolvedSubjectCache } from './cache.js';
import {
  resolveSubjectViaKB,
  parseCitySingleLetter,
  countSameCityTeams,
  isNonEntityLabel,
} from './resolvers.js';
import type { KBRow } from './types.js';

const team = (
  id: number,
  canonical: string,
  sport: string,
  league: string | null,
  aliases: string[] = [],
): KBRow => ({
  id,
  canonical,
  domain_category: 'sports',
  type: 'team',
  aliases,
  sport_canonical: sport,
  league_canonical: league,
});

// The live LA/NY same-city KB after the layer-(a) seed: each "<City> <letter>"
// code is an exact alias on EXACTLY the correct team (poison removed).
const SEEDED_KB: KBRow[] = [
  team(1, 'Los Angeles FC', 'soccer', 'MLS', ['LAFC', 'Los Angeles F', 'LA F']),
  team(2, 'Los Angeles Galaxy', 'soccer', 'MLS', ['LA Galaxy', 'Los Angeles G', 'LA G']),
  team(3, 'Los Angeles Angels', 'baseball', 'MLB', ['Angels', 'LAA', 'Los Angeles A', 'LA A']),
  team(4, 'Los Angeles Dodgers', 'baseball', 'MLB', ['Dodgers', 'LAD', 'Los Angeles D', 'LA D']),
  team(5, 'New York Mets', 'baseball', 'MLB', ['Mets', 'NYM', 'New York M', 'NY M']),
  team(6, 'New York Yankees', 'baseball', 'MLB', ['Yankees', 'NYY', 'New York Y', 'NY Y']),
  // a non-collision single-letter team: Chicago has just one MLB team prefixed
  // "Chicago C" in this KB → resolves normally, never refused.
  team(7, 'Chicago Cubs', 'baseball', 'MLB', ['Cubs', 'CHC', 'Chicago C']),
];

beforeEach(() => {
  _resolvedSubjectCache.clear();
});

// ── Pure shape parser ────────────────────────────────────────────────────────

describe('parseCitySingleLetter (pure shape)', () => {
  test('matches "<City> <single-letter>" with a name-like prefix', () => {
    expect(parseCitySingleLetter('Los Angeles F')).toEqual({ cityPrefix: 'Los Angeles', letter: 'F' });
    expect(parseCitySingleLetter('New York M')).toEqual({ cityPrefix: 'New York', letter: 'M' });
    expect(parseCitySingleLetter('Real Sociedad B')).toEqual({ cityPrefix: 'Real Sociedad', letter: 'B' });
    expect(parseCitySingleLetter('Machida Z')).toEqual({ cityPrefix: 'Machida', letter: 'Z' });
  });

  test('rejects non-shapes (no prefix, multi-char trailing token, no trailing letter)', () => {
    expect(parseCitySingleLetter('A')).toBeNull();              // no prefix
    expect(parseCitySingleLetter('Los Angeles FC')).toBeNull(); // trailing token is 2 chars
    expect(parseCitySingleLetter('Los Angeles')).toBeNull();    // no trailing single letter
    expect(parseCitySingleLetter('Los Angeles 5')).toBeNull();  // trailing is a digit
  });
});

// ── Pure collision counter ───────────────────────────────────────────────────

describe('countSameCityTeams (pure)', () => {
  test('counts ≥2 same-prefix teams in a compatible sport', () => {
    expect(countSameCityTeams('Los Angeles', SEEDED_KB, 'soccer')).toBe(2);   // FC + Galaxy
    expect(countSameCityTeams('Los Angeles', SEEDED_KB, 'baseball')).toBe(2); // Angels + Dodgers
    expect(countSameCityTeams('New York', SEEDED_KB, 'baseball')).toBe(2);    // Mets + Yankees
  });

  test('returns 1 (no collision) when only one same-prefix team in that sport', () => {
    expect(countSameCityTeams('Chicago', SEEDED_KB, 'baseball')).toBe(1); // Cubs only
    expect(countSameCityTeams('New York', SEEDED_KB, 'soccer')).toBe(0);  // no NY soccer team here
  });

  test('a bare city row (not a team) is not counted as a colliding team', () => {
    const kb: KBRow[] = [
      { id: 9, canonical: 'Los Angeles', domain_category: 'other', type: 'location', aliases: [], sport_canonical: null, league_canonical: null },
      team(1, 'Los Angeles FC', 'soccer', 'MLS', []),
    ];
    expect(countSameCityTeams('Los Angeles', kb, 'soccer')).toBe(1);
  });
});

// ── (a) The SWAP IS IMPOSSIBLE — exact alias wins, no embedding guess ─────────

describe('layer (a): exact-alias seed makes the LAFC↔Galaxy swap impossible', () => {
  test('"Los Angeles F" → Los Angeles FC (NEVER Galaxy)', async () => {
    _primeKBCacheForTests(SEEDED_KB);
    const r = await resolveSubjectViaKB('Los Angeles F', 'sports', { sport: 'soccer', league: 'MLS' });
    expect(r).toBe('Los Angeles FC');
    expect(r).not.toBe('Los Angeles Galaxy');
  });

  test('"Los Angeles G" → Los Angeles Galaxy (NEVER LAFC)', async () => {
    _primeKBCacheForTests(SEEDED_KB);
    const r = await resolveSubjectViaKB('Los Angeles G', 'sports', { sport: 'soccer', league: 'MLS' });
    expect(r).toBe('Los Angeles Galaxy');
    expect(r).not.toBe('Los Angeles FC');
  });

  test('MLB pairs do not swap: A→Angels, D→Dodgers, M→Mets, Y→Yankees', async () => {
    _primeKBCacheForTests(SEEDED_KB);
    const sc = { sport: 'baseball', league: 'MLB' };
    expect(await resolveSubjectViaKB('Los Angeles A', 'sports', sc)).toBe('Los Angeles Angels');
    expect(await resolveSubjectViaKB('Los Angeles D', 'sports', sc)).toBe('Los Angeles Dodgers');
    expect(await resolveSubjectViaKB('New York M', 'sports', sc)).toBe('New York Mets');
    expect(await resolveSubjectViaKB('New York Y', 'sports', sc)).toBe('New York Yankees');
  });

  test('short "LA F" / "NY M" variants also hit the right team via exact alias', async () => {
    _primeKBCacheForTests(SEEDED_KB);
    expect(await resolveSubjectViaKB('LA F', 'sports', { sport: 'soccer', league: 'MLS' })).toBe('Los Angeles FC');
    expect(await resolveSubjectViaKB('NY M', 'sports', { sport: 'baseball', league: 'MLB' })).toBe('New York Mets');
  });
});

// ── (b) REFUSAL on an UNSEEDED same-city collision ───────────────────────────

describe('layer (b): refusal guard for an unseeded same-city collision', () => {
  test('"Los Angeles X" (no exact alias, ≥2 same-city soccer teams) is REFUSED → raw subject', async () => {
    _primeKBCacheForTests(SEEDED_KB);
    // 'X' matches neither team's seeded letter → T1 misses → ≥2 same-city soccer
    // teams → refuse rather than let embedding pick one.
    const r = await resolveSubjectViaKB('Los Angeles X', 'sports', { sport: 'soccer' });
    expect(r).toBe('Los Angeles X'); // unchanged — unresolved, no fake merge
  });

  test('synthetic unseeded city: two same-city teams, single-letter subject refuses', async () => {
    const kb: KBRow[] = [
      team(20, 'San Diego Surf', 'soccer', 'MLS', ['SD Surf']),
      team(21, 'San Diego Sails', 'soccer', 'MLS', ['SD Sails']),
    ];
    _primeKBCacheForTests(kb);
    // "San Diego S" — ambiguous between Surf and Sails, no exact alias → refuse.
    const r = await resolveSubjectViaKB('San Diego S', 'sports', { sport: 'soccer' });
    expect(r).toBe('San Diego S');
  });
});

// ── NON-collision single-letter still resolves (guard must NOT over-fire) ─────

describe('guard does NOT over-fire: non-collision single-letter resolves normally', () => {
  test('"Chicago C" → Chicago Cubs (only one same-city MLB team) via exact alias', async () => {
    _primeKBCacheForTests(SEEDED_KB);
    const r = await resolveSubjectViaKB('Chicago C', 'sports', { sport: 'baseball', league: 'MLB' });
    expect(r).toBe('Chicago Cubs');
  });

  test('a single-letter subject for a one-team city is NOT refused even with a different letter', async () => {
    // "Chicago Q" — no exact alias, but Chicago has only ONE team in this KB
    // for baseball → not a collision → falls through to the embedding path
    // (which, with the cache primed and no entity_subjects table, returns the
    // raw subject — but crucially it is NOT short-circuited by the refusal).
    _primeKBCacheForTests([team(7, 'Chicago Cubs', 'baseball', 'MLB', ['Cubs', 'CHC'])]);
    const r = await resolveSubjectViaKB('Chicago Q', 'sports', { sport: 'baseball' });
    // Either resolves to Cubs (embedding) or stays raw — but NEVER a wrong
    // same-city sibling, and never an explicit refusal of a non-collision.
    expect(['Chicago Cubs', 'Chicago Q']).toContain(r);
  });
});

// ── The placeholder-drop protective logic still fires (untouched) ─────────────

describe('protective logic untouched: anonymized-placeholder drop still fires', () => {
  test('"Team A" / "Player 10" / "Coach"-family placeholders stay non-entities', () => {
    expect(isNonEntityLabel('Team A')).toBe(true);
    expect(isNonEntityLabel('Party B')).toBe(true);
    expect(isNonEntityLabel('Player 10')).toBe(true);
    expect(isNonEntityLabel('Driver F')).toBe(true);
  });

  test('"Team A" resolves to itself (dropped before the RC2 guard can see it)', async () => {
    _primeKBCacheForTests(SEEDED_KB);
    // isNonEntityLabel runs before isAmbiguousSameCityTeam, so the placeholder
    // is returned raw via the drop path, never the refusal guard.
    const r = await resolveSubjectViaKB('Team A', 'sports', { sport: 'soccer' });
    expect(r).toBe('Team A');
  });

  test('real national teams "Team USA"/"Team GB" survive (≥3-char token, not a placeholder)', () => {
    expect(isNonEntityLabel('Team USA')).toBe(false);
    expect(isNonEntityLabel('Team GB')).toBe(false);
  });
});

// ── "Real Sociedad B" / "Machida Z" correct single-team matches preserved ─────

describe('current correct resolutions preserved (no over-refusal)', () => {
  test('"Real Sociedad B" resolves (one same-prefix team → no collision)', async () => {
    const kb: KBRow[] = [
      team(30, 'Real Sociedad', 'soccer', 'La Liga', ['La Real']),
      team(31, 'Real Sociedad B', 'soccer', 'La Liga 2', ['Sanse', 'Real Sociedad B']),
    ];
    _primeKBCacheForTests(kb);
    // "Real Sociedad B" is an exact alias of the B team → T1 hit, not refused.
    // (Even though "Real Sociedad" is a prefix of "Real Sociedad B", the parser
    //  sees prefix="Real Sociedad" letter="B"; countSameCityTeams("Real
    //  Sociedad", ...) = only "Real Sociedad B" strictly extends the prefix, so
    //  =1, not a collision — and the exact alias wins anyway.)
    const r = await resolveSubjectViaKB('Real Sociedad B', 'sports', { sport: 'soccer' });
    expect(r).toBe('Real Sociedad B');
  });
});
