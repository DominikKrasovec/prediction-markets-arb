/**
 * Tests for parseMetricScopeFromTitle — the deterministic title → metric_scope
 * parser. First-match-wins; the NULL default for whole-match / combined-game
 * totals is the load-bearing case (it keeps the NULL-tolerant cross-question
 * edge gate able to merge a scope-less Polymarket total with a Kalshi 'game'
 * total).
 */
import { describe, test, expect } from 'bun:test';
import { metricScopeFromKalshiSeries, parseMetricScopeFromTitle } from './metric-scope.js';

describe('parseMetricScopeFromTitle — team total', () => {
  test('"Will the Yankees score over 4.5 runs?" → team', () => {
    expect(parseMetricScopeFromTitle('Will the Yankees score over 4.5 runs?')).toBe('team');
  });
  test('"Will Real Madrid score under 1.5 goals?" → team', () => {
    expect(parseMetricScopeFromTitle('Will Real Madrid score under 1.5 goals?')).toBe('team');
  });
  test('"Lakers vs Celtics: Team Total Points O/U 112.5" → team (explicit phrase)', () => {
    expect(parseMetricScopeFromTitle('Lakers vs Celtics: Team Total Points O/U 112.5')).toBe('team');
  });
  test('team total beats inning qualifier (checked first)', () => {
    expect(parseMetricScopeFromTitle('Will the Mets score over 2.5 in the first 5 innings?')).toBe('team');
  });
});

describe('parseMetricScopeFromTitle — first 5 innings', () => {
  test('"first 5 innings" → first_5', () => {
    expect(parseMetricScopeFromTitle('Over 4.5 total runs in the first 5 innings?')).toBe('first_5');
  });
  test('"first 5 inning" (singular) → first_5', () => {
    expect(parseMetricScopeFromTitle('Total runs first 5 inning O/U 4.5')).toBe('first_5');
  });
  test('"F5" shorthand → first_5', () => {
    expect(parseMetricScopeFromTitle('Yankees vs Mets: F5 O/U 4.5')).toBe('first_5');
  });
});

// KXMLBF3 / KXMLBF5 / KXMLBF7 are three independent three-way partitions of one
// game: tied after 3 innings does not imply tied after 7.
describe('parseMetricScopeFromTitle — first 3 / first 7 innings (independent marks)', () => {
  test('"first 3 innings" → first_3', () => {
    expect(parseMetricScopeFromTitle('Houston vs Texas first 3 innings tie?')).toBe('first_3');
  });
  test('"first 7 innings" → first_7', () => {
    expect(parseMetricScopeFromTitle('Chicago WS vs Texas first 7 innings tie?')).toBe('first_7');
  });
  test('the three marks are pairwise DISTINCT (the whole point of the axis)', () => {
    const f3 = parseMetricScopeFromTitle('A vs B first 3 innings tie?');
    const f5 = parseMetricScopeFromTitle('A vs B first 5 innings tie?');
    const f7 = parseMetricScopeFromTitle('A vs B first 7 innings tie?');
    expect(new Set([f3, f5, f7]).size).toBe(3);
  });
  test('an UNNAMED mark stays NULL — never borrows a neighbour', () => {
    expect(parseMetricScopeFromTitle('A vs B first 4 innings tie?')).toBeNull();
    expect(parseMetricScopeFromTitle('A vs B first 6 innings tie?')).toBeNull();
  });
  test('bare "F3" is NOT a scope token (Formula 3 collision)', () => {
    expect(parseMetricScopeFromTitle('Will Verstappen win the F3 title?')).toBeNull();
  });
});

describe('metricScopeFromKalshiSeries — series-prefix table', () => {
  test('KXMLBF3 / KXMLBF5 / KXMLBF7 map to their own marks', () => {
    expect(metricScopeFromKalshiSeries('KXMLBF3-26JUL17ARIOAK-TIE')).toBe('first_3');
    expect(metricScopeFromKalshiSeries('KXMLBF5-26JUL17ARIOAK-TIE')).toBe('first_5');
    expect(metricScopeFromKalshiSeries('KXMLBF7-26JUL17ARIOAK-TIE')).toBe('first_7');
  });
  test('the period-scoped spread/total siblings agree with their handlers', () => {
    expect(metricScopeFromKalshiSeries('KXMLBF5SPREAD-26MAY101335TBBOS')).toBe('first_5');
    expect(metricScopeFromKalshiSeries('KXMLBF5TOTAL-26JUL201940NYMMIL-3')).toBe('first_5');
  });
  test('a KXMLBF-STEM series that is not an innings mark stays NULL (exact match, not a prefix regex)', () => {
    expect(metricScopeFromKalshiSeries('KXMLBFASTPITCH-26JUL17')).toBeNull();
    expect(metricScopeFromKalshiSeries('KXMLBFTGAME-26JUL17')).toBeNull();
  });
  test('whole-game MLB series and non-Kalshi input stay NULL', () => {
    expect(metricScopeFromKalshiSeries('KXMLBGAME-26JUL17ARIOAK')).toBeNull();
    expect(metricScopeFromKalshiSeries(null)).toBeNull();
    expect(metricScopeFromKalshiSeries('')).toBeNull();
  });
});

describe('parseMetricScopeFromTitle — halves', () => {
  test('"1st half" → half_1', () => {
    expect(parseMetricScopeFromTitle('Bulls vs Thunder: 1st half O/U 114.5')).toBe('half_1');
  });
  test('"first half" → half_1', () => {
    expect(parseMetricScopeFromTitle('Total points in the first half O/U 110.5')).toBe('half_1');
  });
  test('"1H" → half_1', () => {
    expect(parseMetricScopeFromTitle('Bulls vs Thunder: 1H O/U 114.5')).toBe('half_1');
  });
  test('"2nd half" → half_2', () => {
    expect(parseMetricScopeFromTitle('Bulls vs Thunder: 2nd half O/U 113.5')).toBe('half_2');
  });
  test('"second half" → half_2', () => {
    expect(parseMetricScopeFromTitle('Total points in the second half O/U 109.5')).toBe('half_2');
  });
  test('"2H" → half_2', () => {
    expect(parseMetricScopeFromTitle('Bulls vs Thunder: 2H O/U 113.5')).toBe('half_2');
  });
});

describe('parseMetricScopeFromTitle — quarters', () => {
  test('"1st quarter" → quarter', () => {
    expect(parseMetricScopeFromTitle('Total points in the 1st quarter O/U 55.5')).toBe('quarter');
  });
  test('"Q3" → quarter', () => {
    expect(parseMetricScopeFromTitle('Bulls vs Thunder: Q3 O/U 56.5')).toBe('quarter');
  });
});

describe('parseMetricScopeFromTitle — sets', () => {
  test('"Set 1" → set', () => {
    expect(parseMetricScopeFromTitle('Pavlovic vs Walton: Set 1 Games O/U 10.5')).toBe('set');
  });
  test('"Set #2" → set', () => {
    expect(parseMetricScopeFromTitle('Pavlovic vs Walton: Set #2 Games O/U 9.5')).toBe('set');
  });
});

describe('parseMetricScopeFromTitle — per-map', () => {
  test('"Map 1" → map', () => {
    expect(parseMetricScopeFromTitle('Total Kills Over/Under 46.5 in Map 1?')).toBe('map');
  });
  test('"Map #3" → map', () => {
    expect(parseMetricScopeFromTitle('Cloud9 vs FaZe: Map #3 rounds O/U 21.5')).toBe('map');
  });
});

describe('parseMetricScopeFromTitle — series total maps', () => {
  test('"total maps" → series', () => {
    expect(parseMetricScopeFromTitle('Cloud9 vs FaZe: total maps O/U 2.5')).toBe('series');
  });
  test('"games total" → series', () => {
    expect(parseMetricScopeFromTitle('Cloud9 vs FaZe: games total O/U 2.5')).toBe('series');
  });
  test('"maps played" → series', () => {
    expect(parseMetricScopeFromTitle('Over 2.5 maps played in the series?')).toBe('series');
  });
  test('"maps be played" → series', () => {
    expect(parseMetricScopeFromTitle('Will more than 2.5 maps be played?')).toBe('series');
  });
});

describe('parseMetricScopeFromTitle — NULL default (load-bearing)', () => {
  test('bare "X vs Y O/U 3.5" → null (NOT game)', () => {
    expect(parseMetricScopeFromTitle('Arsenal FC vs. Chelsea FC: O/U 3.5')).toBeNull();
  });
  test('plain match-total title → null', () => {
    expect(parseMetricScopeFromTitle('Liverpool vs Chelsea: 3+ total goals?')).toBeNull();
  });
  test('null title → null', () => {
    expect(parseMetricScopeFromTitle(null)).toBeNull();
  });
  test('undefined title → null', () => {
    expect(parseMetricScopeFromTitle(undefined)).toBeNull();
  });
  test('empty string → null', () => {
    expect(parseMetricScopeFromTitle('')).toBeNull();
  });
  test('unrelated title → null', () => {
    expect(parseMetricScopeFromTitle('Will the Fed cut rates in June?')).toBeNull();
  });
});

describe('parseMetricScopeFromTitle — first-match-wins ordering', () => {
  test('half qualifier wins over a bare match total', () => {
    // "1H" present → half_1, not null.
    expect(parseMetricScopeFromTitle('Arsenal vs Chelsea: 1H O/U 1.5')).toBe('half_1');
  });
});
