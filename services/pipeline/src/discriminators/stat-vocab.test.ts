/**
 * Unit tests for stat-vocab.ts (title-regex stat extractor + value_unit
 * fallback). Pure module, no DB.
 */
import { describe, test, expect } from 'bun:test';
import {
  extractStatType,
  statTypeFromValueUnit,
  resolveStatType,
  STAT_CANON,
  STAT_VALUE_UNITS,
} from './stat-vocab.js';

describe('extractStatType — title regex', () => {
  test.each([
    ['Will LeBron James score 30+ points?', 'points'],
    ['Steph Curry: 5+ threes', 'threes'],
    ['Steph Curry: 5+ three-pointers', 'threes'],
    ['Aaron Judge: 2+ home runs', 'home_runs'],
    ['Map 2: Odd/Even Total Kills?', 'kills'],
    ['Real Madrid vs Barcelona: Over 2.5 goals', 'goals'],
    ['Will Manny Machado lead Pro Baseball in RBIs for the 2026 season?', 'rbis'],
    ['Will Bijan Robinson lead Pro Football in rushing touchdowns?', 'rushing_touchdowns'],
    ['Will X record the most yellow cards?', 'yellow_cards'],
    ['Will X record the most clean sheets?', 'clean_sheets'],
    ['Josh Allen over 249.5 passing yards', 'passing_yards'],
    ['Total Bases: Mookie Betts Over 1.5', 'total_bases'],
    ['Djokovic vs Alcaraz: Over 22.5 games', 'games'],
    ['Cricket: Kohli 50+ runs', 'runs'],
  ])('%s → %s', (title, expected) => {
    expect(extractStatType(title)).toBe(expected);
  });

  test.each([
    'First Blood in Game 1?',
    'Both Teams Beat Roshan?',
    'Will Japan finish first in World Cup Group F?',
    'Team A vs Team B: O/U 2.5', // stat inferred, not written
    'Will Rory McIlroy shoot under 68.5 in Round 1?', // strokes never written
    '',
  ])('no stat noun → null: %s', (title) => {
    expect(extractStatType(title)).toBeNull();
  });

  test('multi-word phrase beats a contained single word (home runs, not runs)', () => {
    expect(extractStatType('Aaron Judge: 2+ home runs')).toBe('home_runs');
    expect(extractStatType('Josh Allen over 300 passing yards')).toBe('passing_yards');
  });

  test('null/undefined tolerated', () => {
    expect(extractStatType(null)).toBeNull();
    expect(extractStatType(undefined)).toBeNull();
  });
});

describe('statTypeFromValueUnit — recognized stat units only', () => {
  test.each(['goals', 'kills', 'points', 'strokes', 'total_bases', 'hits_runs_rbis', 'wickets', 'threes'])(
    'stat unit %s → itself',
    (u) => expect(statTypeFromValueUnit(u)).toBe(u),
  );

  test.each(['rank', 'wins', 'count', 'usd', 'percent', 'rank ', null, undefined, ''])(
    'non-stat / empty %s → null',
    (u) => expect(statTypeFromValueUnit(u as string | null)).toBeNull(),
  );

  test('case/whitespace folded', () => {
    expect(statTypeFromValueUnit(' Goals ')).toBe('goals');
  });
});

describe('resolveStatType — value_unit-first, title fallback', () => {
  test('valued kind: authoritative value_unit wins even when title also names a stat', () => {
    // composite: title regex would grab "hits"; value_unit is authoritative.
    expect(resolveStatType('Bobby Witt Jr.: 1+ hits + runs + RBIs?', 'hits_runs_rbis')).toBe('hits_runs_rbis');
  });

  test('O/U-magnitude title (stat inferred): value_unit fills it', () => {
    expect(resolveStatType('Team A vs Team B: O/U 2.5', 'goals')).toBe('goals');
  });

  test('stat-leader: value_unit non-stat (rank) → title regex supplies the stat', () => {
    expect(resolveStatType('Will X lead the league in assists?', 'rank')).toBe('assists');
    expect(resolveStatType('Will X win the most goals at the World Cup?', 'wins')).toBe('goals');
  });

  test('binary prop: value_unit NULL + no title stat → null', () => {
    expect(resolveStatType('Game 1: Both Teams Beat Roshan?', null)).toBeNull();
  });
});

describe('vocab sets', () => {
  test('STAT_CANON holds canonical plural tokens; excludes non-stats', () => {
    for (const t of ['points', 'goals', 'kills', 'home_runs', 'threes', 'total_bases']) {
      expect(STAT_CANON.has(t)).toBe(true);
    }
    for (const t of ['rank', 'wins', 'count']) expect(STAT_CANON.has(t)).toBe(false);
  });

  test('STAT_VALUE_UNITS ⊇ STAT_CANON + the value_unit-only stats', () => {
    for (const t of STAT_CANON) expect(STAT_VALUE_UNITS.has(t)).toBe(true);
    for (const t of ['strokes', 'total_bases', 'hits_runs_rbis']) expect(STAT_VALUE_UNITS.has(t)).toBe(true);
    expect(STAT_VALUE_UNITS.has('rank')).toBe(false);
  });
});
