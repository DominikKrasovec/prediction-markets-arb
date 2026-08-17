import { describe, it, expect } from 'bun:test';
import {
  parseFixtureMatchupTitle, isFixtureNameLike, sameTeamFuzzy, anyTeamFuzzy,
  isDisjointDifferentFixture, FIXTURE_LABEL_POLLUTED_KINDS, FIXTURE_PARTICIPANT_COMPARE_KINDS,
} from './team-identity.js';

describe('parseFixtureMatchupTitle', () => {
  it('strips trailing market-type descriptors the plain matchup parse rejects', () => {
    expect(parseFixtureMatchupTitle('Hellas Verona FC vs. Como 1907 - Exact Score'))
      .toEqual(['Hellas Verona FC', 'Como 1907']);
    expect(parseFixtureMatchupTitle('Atletico Madrid vs Girona: 4+ total cards?'))
      .toEqual(['Atletico Madrid', 'Girona']);
    expect(parseFixtureMatchupTitle('Doosan Bears vs Kia Tigers: Total Runs'))
      .toEqual(['Doosan Bears', 'Kia Tigers']);
    expect(parseFixtureMatchupTitle('Real Oviedo vs. Getafe CF - More Markets'))
      .toEqual(['Real Oviedo', 'Getafe CF']);
  });

  it('strips leading competition/city prefixes on side A', () => {
    expect(parseFixtureMatchupTitle('BUNDL, Bayer Leverkusen vs Hamburger SV, May 16, 2026'))
      .toEqual(['Bayer Leverkusen', 'Hamburger SV']);
    expect(parseFixtureMatchupTitle('Paris: Madison Keys vs Sarah Rakotomanga'))
      .toEqual(['Madison Keys', 'Sarah Rakotomanga']);
  });

  it('handles @, bare v, and vs. separators', () => {
    expect(parseFixtureMatchupTitle('Chicago Cubs @ Atlanta Braves')).toEqual(['Chicago Cubs', 'Atlanta Braves']);
    expect(parseFixtureMatchupTitle('Melgar v Huancayo')).toEqual(['Melgar', 'Huancayo']);
  });

  it('refuses ≥3-way matchups and non-matchup titles (TOTAL, null on doubt)', () => {
    expect(parseFixtureMatchupTitle('Team A vs Team B vs Team C')).toBeNull();
    expect(parseFixtureMatchupTitle('Will the Lakers make the playoffs?')).toBeNull();
    expect(parseFixtureMatchupTitle('Highest temperature in Denver')).toBeNull();
    expect(parseFixtureMatchupTitle('Barcelona vs Barcelona')).toBeNull(); // same side
  });
});

describe('isFixtureNameLike', () => {
  it('accepts short team names, rejects predicate clauses and long strings', () => {
    expect(isFixtureNameLike('FC Köln')).toBe(true);
    expect(isFixtureNameLike('New York Red Bulls')).toBe(true);
    expect(isFixtureNameLike('to score 20 points')).toBe(false); // predicate word
    expect(isFixtureNameLike('a b c d e')).toBe(false);          // >4 words
  });
});

describe('sameTeamFuzzy (KB near-duplicate suppressor — generous by design)', () => {
  it('folds legal/corporate suffix drift to the same team', () => {
    expect(sameTeamFuzzy('Al Taawoun Saudi Club', 'Al-Taawoun')).toBe(true);
    expect(sameTeamFuzzy('Le Havre AC', 'Le Havre')).toBe(true);
    expect(sameTeamFuzzy('Bradford City AFC', 'Bradford City')).toBe(true);
    expect(sameTeamFuzzy('RC Celta de Vigo', 'Celta Vigo')).toBe(true);
    expect(sameTeamFuzzy('1. FC Heidenheim 1846', '1. FC Heidenheim')).toBe(true);
  });

  it('folds transliteration drift (bigram dice)', () => {
    expect(sameTeamFuzzy('Al Okhdood SC', 'Al-Akhdoud Club')).toBe(true);
  });

  it('does NOT fuzz-match genuinely different teams that share no distinctive token', () => {
    expect(sameTeamFuzzy('Ajax', 'Feyenoord')).toBe(false);
    expect(sameTeamFuzzy('Al Hilal', 'Al Nassr')).toBe(false);
    expect(sameTeamFuzzy('Utrecht', 'AZ Alkmaar')).toBe(false);
  });
});

describe('isDisjointDifferentFixture (the reject predicate)', () => {
  const S = (...xs: string[]) => new Set(xs);

  it('fires on 4 distinct teams (the embedding near-miss)', () => {
    expect(isDisjointDifferentFixture(S('Ajax', 'Utrecht'), S('Feyenoord', 'AZ Alkmaar'))).toBe(true);
  });

  it('does NOT fire when one team matches exactly (same fixture)', () => {
    expect(isDisjointDifferentFixture(S('Ajax', 'Utrecht'), S('Ajax', 'PSV'))).toBe(false);
  });

  it('does NOT fire when both teams drift (alias / KB near-duplicate)', () => {
    // rebuild #237 false-reject class: same fixture, both platforms stamp different canonicals
    expect(isDisjointDifferentFixture(S('Al Taawoun Saudi Club', 'Al Riyadh Saudi Club'), S('Al-Taawoun', 'Al-Riyadh'))).toBe(false);
    expect(isDisjointDifferentFixture(S('Celta Vigo', 'Athletic Bilbao'), S('RC Celta de Vigo', 'Athletic Club'))).toBe(false);
  });

  it('does NOT fire when one side mis-resolves but the other team fuzzy-matches', () => {
    // GA Eagles ~ Go Ahead Eagles (fuzzy) while Eindhoven→FC Eindhoven vs PSV mis-resolves
    expect(isDisjointDifferentFixture(S('GA Eagles', 'FC Eindhoven'), S('Go Ahead Eagles', 'PSV'))).toBe(false);
  });

  it('requires exactly two teams per side', () => {
    expect(isDisjointDifferentFixture(S('Ajax'), S('Feyenoord', 'AZ Alkmaar'))).toBe(false);
    expect(isDisjointDifferentFixture(S('Ajax', 'Utrecht', 'PSV'), S('Feyenoord', 'AZ Alkmaar'))).toBe(false);
  });
});

describe('kind sets', () => {
  it('polluted kinds are a subset of compare kinds; compare adds the clean team kinds', () => {
    for (const k of FIXTURE_LABEL_POLLUTED_KINDS) expect(FIXTURE_PARTICIPANT_COMPARE_KINDS.has(k)).toBe(true);
    expect(FIXTURE_PARTICIPANT_COMPARE_KINDS.has('match_winner')).toBe(true);
    expect(FIXTURE_PARTICIPANT_COMPARE_KINDS.has('halftime_leader')).toBe(true);
    expect(FIXTURE_LABEL_POLLUTED_KINDS.has('match_winner')).toBe(false);
    expect(anyTeamFuzzy(new Set(['Ajax']), new Set(['Feyenoord']))).toBe(false);
  });
});
