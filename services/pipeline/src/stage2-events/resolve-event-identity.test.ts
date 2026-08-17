/**
 * Pure-helper tests for the Stage 2a matchup-title parser. The DB-driven resolve
 * path needs a live KB; here we lock the title→[A,B] split that fills H2H
 * singleton participants AND prevents "@"/bare-"v" matchups from collapsing into
 * one junk entity.
 */
import { describe, test, expect } from 'bun:test';
import { parseMatchupTitle, isNonEntityLabel, isResidualLabel } from './resolve-event-identity.js';
import { looksLikePredicate } from '../db/entity/resolvers.js';

describe('parseMatchupTitle', () => {
  test('plain "A vs B" variants', () => {
    expect(parseMatchupTitle('Auxerre vs Nice')).toEqual(['Auxerre', 'Nice']);
    expect(parseMatchupTitle('Manchester City vs. Arsenal')).toEqual(['Manchester City', 'Arsenal']);
    expect(parseMatchupTitle('Fluminense FC vs. São Paulo FC')).toEqual(['Fluminense FC', 'São Paulo FC']);
    expect(parseMatchupTitle('Real Madrid versus Barcelona')).toEqual(['Real Madrid', 'Barcelona']);
  });

  test('separators previously left as ONE entity → now split', () => {
    expect(parseMatchupTitle('Los Angeles Lakers @ Boston Celtics')).toEqual(['Los Angeles Lakers', 'Boston Celtics']);
    expect(parseMatchupTitle('Real Madrid v Barcelona')).toEqual(['Real Madrid', 'Barcelona']);
    expect(parseMatchupTitle('Inter v. Milan')).toEqual(['Inter', 'Milan']);
  });

  test('Limitless structured "<comp>, <A> vs <B>, <date>" → strips prefix + date', () => {
    expect(parseMatchupTitle('World Cup, South Korea vs Czech Republic, Jun 12, 2026'))
      .toEqual(['South Korea', 'Czech Republic']);
    expect(parseMatchupTitle('Ligue 1, Auxerre vs Nice, May 10 2026'))
      .toEqual(['Auxerre', 'Nice']);
  });

  test('leading boilerplate stripped on the left', () => {
    expect(parseMatchupTitle('Will Arsenal vs Chelsea')).toEqual(['Arsenal', 'Chelsea']);
  });

  test('non-matchups → null', () => {
    expect(parseMatchupTitle('Will Bitcoin reach $200k?')).toBeNull();       // no separator
    expect(parseMatchupTitle('Grand Theft Auto V')).toBeNull();             // trailing V, no right side
    expect(parseMatchupTitle('MA-05 House Election Winner')).toBeNull();    // multi-subject axis
  });

  test('run-on predicate matchup → null (does not mint a junk participant)', () => {
    // right side "Chelsea go to extra time" is >4 words → rejected as not name-like
    expect(parseMatchupTitle('Will Arsenal vs Chelsea go to extra time?')).toBeNull();
  });

  test('metric suffix stripped → recovers the two real teams (was a junk full-title entity)', () => {
    // ": Spread"/": Total Bases"/": Moneyline" defeated the parse, leaving the whole
    // predicate title to resolve as ONE junk entity (231 such events).
    expect(parseMatchupTitle('Philadelphia vs Boston: Spread')).toEqual(['Philadelphia', 'Boston']);
    expect(parseMatchupTitle('Bayern Munich vs FC Köln: Spread')).toEqual(['Bayern Munich', 'FC Köln']);
    expect(parseMatchupTitle('Chicago C vs Atlanta: Total Bases')).toEqual(['Chicago C', 'Atlanta']);
    expect(parseMatchupTitle('San Diego FC vs Austin: Moneyline')).toEqual(['San Diego FC', 'Austin']);
  });

  // B-34c: colon-prefix competition + generic colon/dash descriptor-suffix + Predict
  // draw titles are now recovered (they left ~350 "A vs B" events with EMPTY
  // participants). A short colon-suffixed prop resolves to the real teams — those
  // ARE the fixture participants (not junk); the identity is the A-vs-B fixture.
  test('B-34c: colon/dash descriptor suffix stripped → real teams recovered', () => {
    expect(parseMatchupTitle('Toronto Argonauts vs Winnipeg Blue Bombers: Total Points'))
      .toEqual(['Toronto Argonauts', 'Winnipeg Blue Bombers']);
    expect(parseMatchupTitle('Marc-Andrea Huesler vs Edas Butvilas: Total Games'))
      .toEqual(['Marc-Andrea Huesler', 'Edas Butvilas']);
    expect(parseMatchupTitle('Arsenal vs Chelsea: over 2.5 goals?')).toEqual(['Arsenal', 'Chelsea']);
  });

  test('B-34c: leading competition prefix with COLON stripped (Polymarket)', () => {
    expect(parseMatchupTitle('NBA Summer League: Milwaukee Bucks vs. San Antonio Spurs'))
      .toEqual(['Milwaukee Bucks', 'San Antonio Spurs']);
  });

  test('B-34c: Predict "Will A vs B end in a draw?" → the two teams', () => {
    expect(parseMatchupTitle('Will FC Drita vs. FK Kauno Žalgiris end in a draw?'))
      .toEqual(['FC Drita', 'FK Kauno Žalgiris']);
    expect(parseMatchupTitle('Arsenal vs Chelsea ends in a draw')).toEqual(['Arsenal', 'Chelsea']);
  });

  test('B-34c: 3-way "A vs B vs C" is rejected (no 2-participant stamp)', () => {
    expect(parseMatchupTitle('Verstappen vs Hamilton vs Norris')).toBeNull();
  });
});

describe('isResidualLabel — B-34a: generic yes/no outcome labels drop', () => {
  test("plain binary outcome labels 'Yes'/'No' (any case) are residual", () => {
    for (const s of ['Yes', 'No', 'yes', 'no', 'YeS', 'NO', ' Yes ']) {
      expect(isResidualLabel(s)).toBe(true);
    }
  });
  test('existing residuals still drop (draw/tie/field/…)', () => {
    for (const s of ['Draw', 'tie', 'The Field', 'None of the above', 'Draw (A vs B)']) {
      expect(isResidualLabel(s)).toBe(true);
    }
  });
  test('real entities are NOT residual (exact-match only, no substring)', () => {
    // The real Dota 2 team 'YeS' resolves from its "YeS vs Nemiga Gaming" MATCHUP
    // title (not this label bag); real teams whose names merely CONTAIN yes/no/tie
    // survive the exact-lowercased match.
    for (const s of ['Motherwell', 'Baker Mayfield', 'Nemiga Gaming', 'Yellowstone', 'Yes Bank']) {
      expect(isResidualLabel(s)).toBe(false);
    }
  });
});

describe('isNonEntityLabel (do NOT send condition values to the KB embedder)', () => {
  test('condition values / dates / stat lines / placeholders → true', () => {
    for (const l of [
      'above $4813.99', '27,200 or above', 'Above 6.2%', '77° or below', '45°C or higher',
      '↓ $144', '$6,500-$7,000', '171K', 'At least 35 GWdc', 'Rafael Devers: 5+', '3+',
      'Before July 1, 2026', 'March 31, 2027', '2027',
      'Artist D', 'Player BY', 'Candidate A',
      // handicap/spread lines + prop totals + comparisons (the embedder was
      // collapsing (-2.5)↔(-1.5), i.e. distinct betting lines)
      'Grimsby Town FC (-2.5)', 'Manchester City FC (-1.5)', 'Map Handicap: AST (-1.5) vs Sinners (+1.5)',
      'Getafe vs Osasuna: 4+ total cards', 'Total Kills Over/Under 72.5 in Game 2?', '<20m',
      // Leak families (subject-prefixed margins, count ladders, placeholders,
      // year-less dates, value tails) that must not enter entity resolution:
      'Democrats, 41+ pts', 'Republicans, 34+ pts', 'Xavier Becerra, 3+ pts',
      '6+ wins', '22+ games', 'AI 20+ times', '4+ home runs',
      'Party A', 'Party L', 'Team H', 'Team O', 'Player 10', 'Chef K', 'artist 18', 'pitcher v',
      '7 or more', 'exactly 12 cuts', 'more than 100', 'o/u 11.5', 'De\'Aaron Fox: rebounds o/u 3.5',
      'cincinnati: strikeouts', 'hike 25bps', 'between 400 and 449', '0-9 games',
      'on May 13', 'Highest temperature in Sao Paulo on May 13',
    ]) {
      expect(isNonEntityLabel(l)).toBe(true);
    }
  });
  test('real entities (incl. names with numbers) → false', () => {
    for (const l of [
      'Brooklyn Nets', 'Flau\'jae Johnson', 'Democratic Party', 'Schalke 04',
      'S&P 500 (SPX)', '2026 FIFA World Cup', 'Group I', 'Team USA', 'São Paulo FC',
      // must-survive entities adversarially identified (the >5-word guard + single-letter
      // team/party rule + "coach" exclusion protect these):
      'Team GB', 'Team SA', 'Team WE', 'Reform UK', 'Coach K', '76ers', 'Pac-12', 'Big Ten',
      'UEFA Champions League Top Scorer', 'Energy Select Sector SPDR Fund',
    ]) {
      expect(isNonEntityLabel(l)).toBe(false);
    }
  });
});

describe('looksLikePredicate (metric/question TITLES are not entities; keep >5-word threshold)', () => {
  test('predicate / metric / question titles → true', () => {
    for (const l of [
      'Highest temperature in Sao Paulo on May 13', 'Lowest temperature in Tokyo on May 17',
      'Solana price on May 15', 'Bitcoin ETF Flows on May 14', 'Amazon (AMZN) closes week of May 11 at ___',
      'Texas 09 House General Election: voter turnout', 'Trump approval rating on May 15',
      'May Unemployment Rate', 'US GDP',
      // Bare district/governor "margin of victory" carries no number, so
      // isNonEntityLabel misses it; looksLikePredicate must catch the full phrase.
      "Florida's 15th District margin of victory", 'New Hampshire Governor margin of victory',
      'Will Aaron Judge lead Pro Baseball in batting average for the 2026 regular season?',
    ]) {
      expect(looksLikePredicate(l)).toBe(true);
    }
  });
  test('real 5-word-or-shorter entities → false (do NOT lower the >5 threshold to >=5)', () => {
    for (const l of [
      'UEFA Champions League Top Scorer', 'Energy Select Sector SPDR Fund',
      '2026 FIFA World Cup Group E', 'Manchester United', 'Bitcoin', 'S&P 500 (SPX)',
    ]) {
      expect(looksLikePredicate(l)).toBe(false);
    }
  });
});
