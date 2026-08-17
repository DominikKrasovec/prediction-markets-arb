/**
 * Pure unit tests for the league-authoritative sport override.
 *
 * `normalizeSportCanonical` is cache-backed, so its DB-touching behaviour is
 * exercised by the DB-backed entity-registry tests. The decision — given a
 * resolved LLM sport and the league's own single KB sport, override? — is
 * extracted into the pure `decideLeagueSportOverride`, which these tests pin.
 *
 * The override must (a) override an incompatible LLM sport off the gated
 * league signal, (b) never force-flip a compatible pair (esports
 * umbrella<->game, '<sport>'<->'<sport> (ncaa)' variants), and (c) never
 * override when the league sport is unknown/ambiguous (the single-sport
 * guard returns null, treated as "keep verbatim").
 *
 * Sport is a structural/identity attribute, not an outcome probability, so
 * correcting it removes no possible world from any market's Omega.
 */
import { describe, test, expect } from 'bun:test';
import { decideLeagueSportOverride, stripSeasonPrefix, stripStageSuffix, resolveTaxonomyCanonical } from './taxonomy.js';
import { query } from '@arb/db';

describe('decideLeagueSportOverride (pure league-authoritative override)', () => {
  test('(a) REGRESSION: incompatible LLM sport is overridden by the league sport', () => {
    expect(decideLeagueSportOverride('soccer', 'american football (ncaa)'))
      .toBe('american football (ncaa)');
  });

  test('(b) FAIL-SAFE: unknown/ambiguous league sport (null) keeps the verbatim LLM sport', () => {
    // leagueSingleSportFromCache returns null when the league is unknown OR
    // maps to >1 sport — the override must not fire.
    expect(decideLeagueSportOverride('soccer', null)).toBe('soccer');
    expect(decideLeagueSportOverride('basketball', null)).toBe('basketball');
  });

  test('(c) COMPATIBLE NCAA variant pair is NOT force-flipped', () => {
    // 'american football' vs 'american football (ncaa)' are the same family
    // via baseSportFamily -> compatible -> keep the LLM value.
    expect(decideLeagueSportOverride('american football', 'american football (ncaa)'))
      .toBe('american football');
    expect(decideLeagueSportOverride('american football (ncaa)', 'american football (ncaa)'))
      .toBe('american football (ncaa)');
  });

  test('(d) ESPORTS umbrella/child are compatible -> no override', () => {
    // A team tagged 'cs2' under a league whose KB sport is the umbrella
    // 'esports' (or vice versa) must not be flipped — same identity family.
    expect(decideLeagueSportOverride('cs2', 'esports')).toBe('cs2');
    expect(decideLeagueSportOverride('esports', 'cs2')).toBe('esports');
  });

  test('(d2) DISTINCT esports games are INCOMPATIBLE -> override (per-game rosters differ)', () => {
    expect(decideLeagueSportOverride('valorant', 'cs2')).toBe('cs2');
  });

  test('(e) same sport -> no-op (identity)', () => {
    expect(decideLeagueSportOverride('soccer', 'soccer')).toBe('soccer');
  });

  test('(f) genuine cross-sport disagreement overrides (basketball league vs soccer LLM)', () => {
    expect(decideLeagueSportOverride('soccer', 'basketball')).toBe('basketball');
  });
});

// stripSeasonPrefix: removes a leading season/year token so a
// season-prefixed competition title resolves to its stable base league. It
// must never touch a trailing ordinal-tier token ("la liga 2") — that is a
// real distinct division.
describe('AUD-42 stripSeasonPrefix (pure season/year-prefix strip)', () => {
  test('strips a leading year (+ optional 2-digit season suffix)', () => {
    expect(stripSeasonPrefix('2025 26 england premier league')).toBe('england premier league');
    expect(stripSeasonPrefix('2025-26 la liga')).toBe('la liga');
    expect(stripSeasonPrefix('2025–26 la liga')).toBe('la liga');  // en-dash
    expect(stripSeasonPrefix('2026 fifa world cup')).toBe('fifa world cup');
    expect(stripSeasonPrefix('2026 england premier league')).toBe('england premier league');
  });

  test('SOUNDNESS BOUNDARY: a TRAILING ordinal tier is left UNCHANGED (la liga 2 stays distinct)', () => {
    expect(stripSeasonPrefix('la liga 2')).toBe('la liga 2');
    expect(stripSeasonPrefix('la liga')).toBe('la liga');
    expect(stripSeasonPrefix('bundesliga 2')).toBe('bundesliga 2');
    expect(stripSeasonPrefix('j2 league')).toBe('j2 league');
    expect(stripSeasonPrefix('ligue 1')).toBe('ligue 1');
    expect(stripSeasonPrefix('premier league')).toBe('premier league');
  });

  test('a bare year (no following name) is returned unchanged', () => {
    expect(stripSeasonPrefix('2026')).toBe('2026');
  });
});

// stripStageSuffix: removes one trailing stage/umbrella token so a
// stage-suffixed competition string ('NBA Playoffs') resolves to its stable
// base league ('NBA'). Guards: empty remainder and bare-stage remainder keep
// the original — distinct leagues must never collapse.
describe('W2-R6a stripStageSuffix (pure trailing stage-token strip)', () => {
  test('strips the measured stage forks onto the base league token', () => {
    expect(stripStageSuffix('nba playoffs')).toBe('nba');
    expect(stripStageSuffix('mlb playoffs')).toBe('mlb');
    expect(stripStageSuffix('nfl postseason')).toBe('nfl');
    expect(stripStageSuffix('nba finals')).toBe('nba');
    expect(stripStageSuffix('nba play-offs')).toBe('nba');
  });

  test('hierarchy token: tour reduces to the governing body', () => {
    expect(stripStageSuffix('pga tour')).toBe('pga');
  });

  test("SOUNDNESS BOUNDARY: '<acronym> championship' is a proper competition name (census 2026-07-02 §4b)", () => {
    // 'PGA Championship' is a distinct major, not the tour's stage — folding
    // it to 'pga' would make it league-compatible with 'PGA Tour'. The guard
    // fires only for token='championship' with a bare 2-4-char acronym remainder.
    expect(stripStageSuffix('pga championship')).toBe('pga championship');
    expect(stripStageSuffix('PGA Championship')).toBe('PGA Championship');
    expect(stripStageSuffix('lpga championship')).toBe('lpga championship');
    // pure stage words still strip off an acronym...
    expect(stripStageSuffix('nba playoffs')).toBe('nba');
    expect(stripStageSuffix('nba finals')).toBe('nba');
    // ...and 'championship' still strips off a multi-word remainder
    expect(stripStageSuffix('united rugby championship')).toBe('united rugby');
  });

  test('SOUNDNESS BOUNDARY: bare stage names survive whole', () => {
    // 'championship' is itself a league (EFL Championship) — a trailing-only
    // strip with the \S-prefix requirement never touches it.
    expect(stripStageSuffix('championship')).toBe('championship');
    expect(stripStageSuffix('tour')).toBe('tour');
    expect(stripStageSuffix('finals')).toBe('finals');
  });

  test('SOUNDNESS BOUNDARY: a bare-stage REMAINDER blocks the strip', () => {
    // 'tour championship' (the PGA event) must not reduce to bare 'tour';
    // 'championship tour' (WSL surfing) must not reduce to bare 'championship'
    // (which would falsely resolve to the EFL Championship league row).
    expect(stripStageSuffix('tour championship')).toBe('tour championship');
    expect(stripStageSuffix('championship tour')).toBe('championship tour');
  });

  test('non-stage suffixes are untouched (ordinal tiers, plain names)', () => {
    expect(stripStageSuffix('la liga 2')).toBe('la liga 2');
    expect(stripStageSuffix('la liga')).toBe('la liga');
    expect(stripStageSuffix('premier league')).toBe('premier league');
    expect(stripStageSuffix('champions league')).toBe('champions league');
    expect(stripStageSuffix('united rugby championship')).toBe('united rugby');
  });
});

// resolveTaxonomyCanonical stage-stripped fallback (DB read-only).
// 'NBA Playoffs' is seeded as a type='competition' row, so a kind='league'
// lookup misses it; the stage-stripped key 'nba' must bridge it to the 'NBA'
// league row. Skips when PG is unreachable.
describe('W2-R6a resolveTaxonomyCanonical stage fallback (DB read-only)', () => {
  test("'NBA Playoffs' resolves to the NBA base league; 'la liga 2' stays distinct", async () => {
    let pgUp = false;
    try { await query('SELECT 1'); pgUp = true; } catch { /* no DB — skip */ }
    if (!pgUp) return;

    const nbaPlayoffs = await resolveTaxonomyCanonical('NBA Playoffs', 'league');
    const nba = await resolveTaxonomyCanonical('NBA', 'league');
    if (nba !== null) {
      // Whatever the seeded base-league canonical is, the stage-suffixed
      // form must land on the same canonical.
      expect(nbaPlayoffs).toBe(nba);
    }

    // The ordinal tier must never bridge onto the base division.
    const ll2 = await resolveTaxonomyCanonical('la liga 2', 'league');
    if (ll2 !== null) {
      expect(ll2.toLowerCase()).not.toBe('la liga');
    }
  });
});

// resolveTaxonomyCanonical season-stripped fallback (DB read-only).
// A season-prefixed league string must resolve to the base league via the
// stripped-key fallback, while an ordinal-tier division ('la liga 2') must
// not collapse onto its base. Skips when PG is unreachable.
describe('AUD-42 resolveTaxonomyCanonical season fallback (DB read-only)', () => {
  test("'2025 26 england premier league' resolves to a base league (NOT the season string); 'la liga 2' stays distinct", async () => {
    let pgUp = false;
    try { await query('SELECT 1'); pgUp = true; } catch { /* no DB — skip */ }
    if (!pgUp) return;

    // The season-prefixed EPL title must resolve to a real base league via the
    // stripped 'england premier league' alias — NOT to the season string itself.
    const epl = await resolveTaxonomyCanonical('2025 26 england premier league', 'league');
    if (epl !== null) {
      // Whatever base league it lands on, it must not be a season-prefixed string.
      expect(/^(?:19|20)\d{2}/.test(epl)).toBe(false);
    }

    // 'la liga 2' must never strip to 'la liga' — the year regex doesn't
    // match it, so the fallback key is never added.
    const ll2 = await resolveTaxonomyCanonical('la liga 2', 'league');
    if (ll2 !== null) {
      expect(ll2.toLowerCase()).not.toBe('la liga');
    }
  });
});
