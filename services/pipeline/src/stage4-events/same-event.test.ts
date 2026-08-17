/**
 * Unit tests for the `same_resolving_event` predicate (pure, no DB); covers
 * the soundness counterexamples for the four downstream edge rules.
 */
import { describe, test, expect } from 'bun:test';
import { config } from '../config.js';
import { datePrecisionLadderSql } from '../util/date-grain-sql.js';
import { FIXTURE_START_TOLERANCE_MS } from '../util/fixture-instant.js';
import {
  parseGameOrdinal,
  sameResolvingEvent,
  DECISIVE_KINDS,
  DECISIVE_KINDS_SQL,
  scopesKnownAndConflictSql,
  installSameEventSql,
  sameEventFragment,
  sameFixtureFragment,
  foldLeagueKey,
  isCompetitionGrainChampionship,
  FIXTURE_LEG_DIVERGENCE_MS,
  type NodeFacts,
} from './same-event.js';
import { GAME_ORDINAL_SQL_BODY } from '../discriminators/specs/game-ordinal.js';

const D = (iso: string) => new Date(iso);

function node(over: Partial<NodeFacts>): NodeFacts {
  return {
    platformEventId: null,
    canonicalEvent: null,
    conditionDate: null,
    conditionDatePrecision: null,
    eventKind: null,
    sport: null,
    league: null,
    resolutionScope: null,
    title: null,
    ...over,
  };
}

describe('parseGameOrdinal', () => {
  test('map/game/set/leg/frame + digit 1-9', () => {
    expect(parseGameOrdinal('map 2')).toBe(2);
    expect(parseGameOrdinal('Map 2: Total Kills')).toBe(2);
    expect(parseGameOrdinal('Will X win map 2 of the series?')).toBe(2);
    expect(parseGameOrdinal('Game 5')).toBe(5); // digit allows >4 even though word forms stop at 4
    expect(parseGameOrdinal('Game 7')).toBe(7); // NBA Game 7
    expect(parseGameOrdinal('Set 3 winner')).toBe(3);
    expect(parseGameOrdinal('leg 4')).toBe(4);
    expect(parseGameOrdinal('Frame #9')).toBe(9);
    expect(parseGameOrdinal('Map 1: Odd/Even Total Rounds?')).toBe(1);
  });

  test('word-form period ordinals 1st-4th → 1-4', () => {
    expect(parseGameOrdinal('1st half')).toBe(1);
    expect(parseGameOrdinal('first half winner')).toBe(1);
    expect(parseGameOrdinal('2nd quarter')).toBe(2);
    expect(parseGameOrdinal('second period')).toBe(2);
    expect(parseGameOrdinal('3rd set')).toBe(3);
    expect(parseGameOrdinal('third inning')).toBe(3);
    expect(parseGameOrdinal('4th game')).toBe(4);
    expect(parseGameOrdinal('fourth quarter')).toBe(4);
  });

  test('digit-form period ordinals ("period 2", "half 1", "inning 5")', () => {
    expect(parseGameOrdinal('period 2 spread')).toBe(2);
    expect(parseGameOrdinal('Quarter 3 total')).toBe(3);
    expect(parseGameOrdinal('Half 1 total')).toBe(1);
    expect(parseGameOrdinal('texas wins 5th inning')).toBe(5);
  });

  test('abbreviated betting-line markers (1H/2H, 1Q-4Q, H1/H2, Q1-Q4) → digit', () => {
    expect(parseGameOrdinal('Cavaliers vs. Pistons: 1H O/U 103.5')).toBe(1);
    expect(parseGameOrdinal('2H O/U 110')).toBe(2);
    expect(parseGameOrdinal('1Q points')).toBe(1);
    expect(parseGameOrdinal('Q1 spread')).toBe(1);
    expect(parseGameOrdinal('3Q')).toBe(3);
    expect(parseGameOrdinal('H2 winner')).toBe(2);
    expect(parseGameOrdinal('Cavaliers vs. Pistons: O/U 215.5')).toBeNull();
    expect(parseGameOrdinal('24h volume')).toBeNull();
  });

  test('series-total phrases are NEUTRAL (NULL, not an ordinal)', () => {
    expect(parseGameOrdinal('Over 2.5 maps')).toBeNull();
    expect(parseGameOrdinal('total maps over/under')).toBeNull();
    expect(parseGameOrdinal('Total Games')).toBeNull();
    expect(parseGameOrdinal('Under 3.5 sets')).toBeNull();
    expect(parseGameOrdinal('best of 3')).toBeNull();
    expect(parseGameOrdinal('Best of 5')).toBeNull();
  });

  test('no ordinal token / empty / null → null', () => {
    expect(parseGameOrdinal('Will the Heretics win the match?')).toBeNull();
    expect(parseGameOrdinal('')).toBeNull();
    expect(parseGameOrdinal(null)).toBeNull();
    expect(parseGameOrdinal(undefined)).toBeNull();
  });

  test('bare halftime forms → 1 (PM idiom aligns with Kalshi "1st Half")', () => {
    expect(parseGameOrdinal('Hamburger SV leading at halftime?')).toBe(1);
    expect(parseGameOrdinal('Bayer 04 Leverkusen vs. VfL Wolfsburg: Draw at halftime?')).toBe(1);
    expect(parseGameOrdinal('Arsenal leading at the half')).toBe(1);
    expect(parseGameOrdinal('level at half-time')).toBe(1);
    expect(parseGameOrdinal('2nd half — score level at halftime')).toBe(2);
    expect(parseGameOrdinal('Will Arsenal FC vs. Chelsea FC end in a draw?')).toBeNull();
  });

  test('series-total guard wins even if a map-N token is also present', () => {
    expect(parseGameOrdinal('Total maps over 2.5 in map 1 area')).toBeNull();
  });

  test('fiscal/calendar periods (Qn + year, Hn + year) → NULL', () => {
    expect(parseGameOrdinal('Will Germany GDP growth rate YoY for Q1 2026 be above 1.2%?')).toBeNull();
    expect(parseGameOrdinal('Will South Korea GDP growth in Q2 2026 be between 2.0% and 2.4%?')).toBeNull();
    expect(parseGameOrdinal('Will Vail Resorts Inc. report Above 6.9M skier visits in Q3 2026?')).toBeNull();
    expect(parseGameOrdinal('Will FedEx report Above 17.4M avg daily package volume in Q4 2026?')).toBeNull();
    expect(parseGameOrdinal('2k+ container ship transits of Suez Canal in H1 2026?')).toBeNull();
    expect(parseGameOrdinal('EPS beat in Q2 of 2026?')).toBeNull();
    expect(parseGameOrdinal('Revenue above $5B in Q3 FY2026?')).toBeNull();
    expect(parseGameOrdinal('2026 Q1 GDP above 2%?')).toBeNull();
    expect(parseGameOrdinal('Will Deere Q2 revenue be above $12.5B?')).toBeNull();
    expect(parseGameOrdinal('Nvidia Data Center Revenue above 65B in Q1?')).toBeNull();
    expect(parseGameOrdinal('Will TJX Q1 comp sales growth be between 3% and 4%?')).toBeNull();
    expect(parseGameOrdinal('Will Uber Technologies, Inc. report above 3.6 billion Trips in Q2?')).toBeNull();
    expect(parseGameOrdinal('Cavaliers vs. Pistons: 1H O/U 103.5')).toBe(1);
    expect(parseGameOrdinal('Q1 spread')).toBe(1);
    expect(parseGameOrdinal('H2 winner')).toBe(2);
    expect(parseGameOrdinal('2026 NBA Finals Game 3: 1Q points')).toBe(3); // game-N wins first
    expect(parseGameOrdinal('Lakers 2026 season opener: 1Q points')).toBe(1);
  });

  test('season-deadline prose ("first game of the season") → NULL', () => {
    expect(
      parseGameOrdinal('Will the Kansas City Chiefs not relocate before the first game of the 2028 season?'),
    ).toBeNull();
    expect(parseGameOrdinal('by the first game of the season')).toBeNull();
    expect(parseGameOrdinal('by the 1st game of the 2027-28 season')).toBeNull();
    expect(parseGameOrdinal('4th game')).toBe(4);
    expect(parseGameOrdinal('first half winner')).toBe(1);
    expect(parseGameOrdinal('Half 1 total')).toBe(1);
  });
});

describe('DECISIVE_KINDS', () => {
  test('contains exactly the four winner-type kinds', () => {
    expect(DECISIVE_KINDS.has('match_winner')).toBe(true);
    expect(DECISIVE_KINDS.has('championship_winner')).toBe(true);
    expect(DECISIVE_KINDS.has('halftime_leader')).toBe(true);
    expect(DECISIVE_KINDS.has('both_teams_score')).toBe(true);
    expect(DECISIVE_KINDS.size).toBe(4);
  });

  test('the dominant per-map family match_total_metric is NOT decisive', () => {
    expect(DECISIVE_KINDS.has('match_total_metric')).toBe(false);
  });
});

describe('sameResolvingEvent — 8 soundness counterexamples', () => {
  const EVT = 'Miami Heretics vs Paris Gentle Mates';

  test('#1 esports cross-platform map, equal ordinal (2==2) → same', () => {
    const a = node({
      platformEventId: 'kalshi:KXLOLMHPAR-2',
      canonicalEvent: EVT,
      conditionDate: D('2026-05-10T23:00:00Z'),
      conditionDatePrecision: 'minute',
      eventKind: 'match_winner',
      title: 'Will Miami Heretics win map 2 of the series?',
    });
    const b = node({
      platformEventId: '257425',
      canonicalEvent: EVT,
      conditionDate: D('2026-05-10T23:00:00Z'),
      conditionDatePrecision: 'minute',
      eventKind: 'match_winner',
      title: 'Map 2: Miami Heretics vs Paris Gentle Mates',
    });
    expect(sameResolvingEvent(a, b)).toBe('same');
  });

  test('#2 different maps (2 vs 3), decisive kind → indeterminate (fake-arb blocker)', () => {
    const a = node({
      platformEventId: 'kalshi:KXLOLMHPAR-2',
      canonicalEvent: EVT,
      conditionDate: D('2026-05-10T23:00:00Z'),
      conditionDatePrecision: 'minute',
      eventKind: 'match_winner',
      title: 'Will Miami Heretics win map 2 of the series?',
    });
    const b = node({
      platformEventId: '257425',
      canonicalEvent: EVT,
      conditionDate: D('2026-05-10T23:00:00Z'),
      conditionDatePrecision: 'minute',
      eventKind: 'match_winner',
      title: 'Map 3: Miami Heretics vs Paris Gentle Mates',
    });
    expect(sameResolvingEvent(a, b)).toBe('indeterminate');
  });

  test('#3 kalshi maps share occurrence_datetime, ordinals 1 vs 2 → indeterminate', () => {
    const sameDate = D('2026-05-10T23:00:00Z');
    const a = node({
      platformEventId: 'kalshi:KXLOLMHPAR-1',
      canonicalEvent: EVT,
      conditionDate: sameDate,
      conditionDatePrecision: 'minute',
      eventKind: 'match_winner',
      title: 'Will Miami Heretics win map 1?',
    });
    const b = node({
      platformEventId: 'kalshi:KXLOLMHPAR-2',
      canonicalEvent: EVT,
      conditionDate: sameDate,
      conditionDatePrecision: 'minute',
      eventKind: 'match_winner',
      title: 'Will Miami Heretics win map 2?',
    });
    expect(sameResolvingEvent(a, b)).toBe('indeterminate');
  });

  const wholeMatchA = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'kalshi:KXLOLMHPAR',
    canonicalEvent: EVT,
    conditionDate: D('2026-05-10T23:00:00Z'),
    conditionDatePrecision: 'day',
    eventKind: 'match_winner',
    title: 'Will Miami Heretics beat Paris Gentle Mates?',
    ...over,
  });
  const wholeMatchB = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: '257400',
    canonicalEvent: EVT,
    conditionDate: D('2026-05-10T18:30:00Z'),
    conditionDatePrecision: 'day',
    eventKind: 'match_winner',
    title: 'Miami Heretics vs Paris Gentle Mates: winner',
    ...over,
  });

  test('#4 whole-match winner, no ordinal, scope UNKNOWN → indeterminate (FT/ET refusal)', () => {
    expect(sameResolvingEvent(wholeMatchA(), wholeMatchB())).toBe('indeterminate');
  });

  test('#4b whole-match winner, both scopes regulation (known-equal) → same', () => {
    expect(sameResolvingEvent(
      wholeMatchA({ resolutionScope: 'regulation' }),
      wholeMatchB({ resolutionScope: 'regulation' }),
    )).toBe('same');
  });

  test('#4c whole-match winner, scopes differ (regulation vs incl_overtime) → indeterminate', () => {
    expect(sameResolvingEvent(
      wholeMatchA({ resolutionScope: 'regulation' }),
      wholeMatchB({ resolutionScope: 'incl_overtime' }),
    )).toBe('indeterminate');
  });

  test('#4d whole-match winner, one scope unspecified → indeterminate (unknown)', () => {
    expect(sameResolvingEvent(
      wholeMatchA({ resolutionScope: 'regulation' }),
      wholeMatchB({ resolutionScope: 'unspecified' }),
    )).toBe('indeterminate');
  });

  test('#4e SUB-GAME winner (ordinal present) is NOT scope-gated → same even with unknown scope', () => {
    expect(sameResolvingEvent(
      wholeMatchA({ title: 'Will Miami Heretics win map 2?' }),
      wholeMatchB({ title: 'Map 2: Miami Heretics vs Paris Gentle Mates winner' }),
    )).toBe('same');
  });

  test('#5 series-total titles parse to null ordinal (not a per-game ordinal)', () => {
    expect(parseGameOrdinal('Over 2.5 maps')).toBeNull();
    expect(parseGameOrdinal('total maps over/under')).toBeNull();
    expect(parseGameOrdinal('Best of 3')).toBeNull();
    const a = node({
      platformEventId: 'kalshi:KXLOLMHPAR-TM',
      canonicalEvent: EVT,
      conditionDate: D('2026-05-10T23:00:00Z'),
      conditionDatePrecision: 'minute',
      eventKind: 'match_total_metric',
      title: 'Over 2.5 maps in the series?',
    });
    const b = node({
      platformEventId: '257430',
      canonicalEvent: EVT,
      conditionDate: D('2026-05-10T23:00:00Z'),
      conditionDatePrecision: 'minute',
      eventKind: 'match_total_metric',
      title: 'Total maps over/under 2.5',
    });
    expect(sameResolvingEvent(a, b)).toBe('same');
  });

  test('#6 adjacent crypto candles (5 min apart) → different (never fuse)', () => {
    const a = node({
      platformEventId: 'kalshi:KXBTCD-26MAY10-0915',
      canonicalEvent: 'BTC Up or Down',
      conditionDate: D('2026-05-10T09:15:00Z'),
      conditionDatePrecision: 'minute',
      eventKind: 'candle_direction',
      title: 'BTC Up or Down 09:15-09:20 ET',
    });
    const b = node({
      platformEventId: 'pm-btc-0920',
      canonicalEvent: 'BTC Up or Down',
      conditionDate: D('2026-05-10T09:20:00Z'),
      conditionDatePrecision: 'minute',
      eventKind: 'candle_direction',
      title: 'BTC Up or Down 09:20-09:25 ET',
    });
    expect(sameResolvingEvent(a, b)).toBe('different');
  });

  test('#7 different event_kind, non-decisive → different', () => {
    const a = node({
      platformEventId: 'kalshi:WX',
      canonicalEvent: 'NYC weather 2026-05-10',
      conditionDate: D('2026-05-10T12:00:00Z'),
      conditionDatePrecision: 'day',
      eventKind: 'weather_extreme',
      title: 'Highest temperature in NYC on May 10',
    });
    const b = node({
      platformEventId: 'pm-wx',
      canonicalEvent: 'NYC weather 2026-05-10',
      conditionDate: D('2026-05-10T12:00:00Z'),
      conditionDatePrecision: 'day',
      eventKind: 'player_prop_threshold',
      title: 'Player X over 1.5 something',
    });
    expect(sameResolvingEvent(a, b)).toBe('different');
  });

  test('#8a null kind one side, other is match_winner → indeterminate (decisive)', () => {
    const a = node({
      platformEventId: 'kalshi:KXLOLMHPAR',
      canonicalEvent: EVT,
      conditionDate: D('2026-05-10T23:00:00Z'),
      conditionDatePrecision: 'day',
      eventKind: null,
      title: 'Will Miami Heretics beat Paris Gentle Mates?',
    });
    const b = node({
      platformEventId: '257400',
      canonicalEvent: EVT,
      conditionDate: D('2026-05-10T23:00:00Z'),
      conditionDatePrecision: 'day',
      eventKind: 'match_winner',
      title: 'Miami Heretics vs Paris Gentle Mates: winner',
    });
    expect(sameResolvingEvent(a, b)).toBe('indeterminate');
  });

  test('#8b null kind one side, other is non-decisive → different', () => {
    const a = node({
      platformEventId: 'kalshi:WX',
      canonicalEvent: 'NYC weather 2026-05-10',
      conditionDate: D('2026-05-10T12:00:00Z'),
      conditionDatePrecision: 'day',
      eventKind: null,
      title: 'Highest temperature in NYC on May 10',
    });
    const b = node({
      platformEventId: 'pm-wx',
      canonicalEvent: 'NYC weather 2026-05-10',
      conditionDate: D('2026-05-10T12:00:00Z'),
      conditionDatePrecision: 'day',
      eventKind: 'weather_extreme',
      title: 'Highest temperature in NYC on May 10',
    });
    expect(sameResolvingEvent(a, b)).toBe('different');
  });
});

describe('sameResolvingEvent — Tier-1 ordinal requirement (PM single-pe trap)', () => {
  test('same platform_event_id but different ordinals → NOT same (non-decisive → different)', () => {
    const a = node({
      platformEventId: '257425',
      canonicalEvent: 'A vs B',
      eventKind: 'match_total_metric',
      title: 'Map 1: Total Kills',
    });
    const b = node({
      platformEventId: '257425',
      canonicalEvent: 'A vs B',
      eventKind: 'match_total_metric',
      title: 'Map 2: Total Kills',
    });
    expect(sameResolvingEvent(a, b)).toBe('different');
  });

  test('same platform_event_id and same ordinal → same (Tier 1)', () => {
    const a = node({
      platformEventId: '257425',
      eventKind: 'match_total_metric',
      title: 'Map 1: Total Kills (over)',
    });
    const b = node({
      platformEventId: '257425',
      eventKind: 'match_total_metric',
      title: 'Map 1: Total Kills (under)',
    });
    expect(sameResolvingEvent(a, b)).toBe('same');
  });

  test('same platform_event_id and both no ordinal → same (Tier 1, whole-event)', () => {
    const a = node({ platformEventId: 'pe-42', eventKind: 'categorical_outcome', title: 'Outcome A' });
    const b = node({ platformEventId: 'pe-42', eventKind: 'categorical_outcome', title: 'Outcome B' });
    expect(sameResolvingEvent(a, b)).toBe('same');
  });
});

describe('SQL builders are stable strings', () => {
  test('installSameEventSql installs league_stage_fold IMMUTABLE and NO game_ordinal fn (WP-4.2)', () => {
    const sql = installSameEventSql();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION league_stage_fold(t text)');
    expect(sql).toContain('IMMUTABLE');
    expect(sql).not.toContain('FUNCTION game_ordinal');
  });

  test('sameEventFragment uses immutable_unaccent, TIMESTAMPTZ casts, and the stamped ordinal fold (WP-4.2)', () => {
    const frag = sameEventFragment('a', 'b');
    expect(frag).toContain('a.platform_event_id = b.platform_event_id');
    expect(frag).toContain("a.discriminators->>'game_ordinal' IS NOT DISTINCT FROM b.discriminators->>'game_ordinal'");
    expect(frag).toContain('immutable_unaccent');
    expect(frag).toContain('::timestamptz');
    expect(frag).not.toContain('game_ordinal(a.title)');
    expect(frag).not.toContain('game_ordinal(b.title)');
  });

  test('sameEventFragment carries the conservative FT/ET scope guard (decisive + whole-match + scope)', () => {
    const frag = sameEventFragment('a', 'b');
    expect(frag).toContain("a.event_kind IN ('match_winner','championship_winner','halftime_leader','both_teams_score')");
    expect(frag).toContain('a.resolution_scope = b.resolution_scope');
    expect(frag).toContain("(a.discriminators->>'game_ordinal') IS NULL");
    expect(frag).toContain("(b.discriminators->>'game_ordinal') IS NULL");
  });

  test('game_ordinal SQL twin recognizes abbreviated + digit-form period markers', () => {
    const sql = GAME_ORDINAL_SQL_BODY;
    expect(sql).toContain("([1-4])(?:h|q)");       // 1H/2H/1Q digit-first
    expect(sql).toContain("(?:h|q)([1-4])");       // H1/Q1 letter-first
    expect(sql).toContain('half|quarter|period|inning'); // digit-form period
    expect(sql).toContain("half[- ]?time");
    expect(sql).toContain("at\\s+(the\\s+)?half");
  });

  test('game_ordinal SQL twin carries the fiscal-period + season-prose guards (census 2026-07-02 §1)', () => {
    const sql = GAME_ORDINAL_SQL_BODY;
    const fiscal =
      "\\m(q[1-4]|[1-4]h|h[1-4])\\s+(of\\s+)?(fy\\s?)?(19|20)\\d{2}\\M|\\m(19|20)\\d{2}\\s+(q[1-4]|[1-4]h|h[1-4])\\M";
    expect(sql.split(fiscal).length - 1).toBe(2);
    const fiscalCtx =
      "\\m(revenue|earnings|eps|gdp|cpi|margins?|sales|orders|report(s|ed)?|deliver(ies|ed)|shipments|subscribers|trips|profit|income|guidance|meeting)\\M";
    expect(sql.split(fiscalCtx).length - 1).toBe(2);
    const seasonProse =
      "\\m([1-9](st|nd|rd|th)|first|second|third|fourth)\\s+(game|match)\\s+of\\s+the\\s+((19|20)\\d{2}([–-]\\d{2,4})?\\s+)?season\\M";
    expect(sql.split(seasonProse).length - 1).toBe(5);
  });

  test('sameEventFragment folds the league gate on the stage-stripped despaced key (R3 + W2-R6a)', () => {
    const frag = sameEventFragment('a', 'b');
    expect(frag).toContain('league_stage_fold(a.league) = league_stage_fold(b.league)');
    expect(frag).toContain('a.league IS NULL OR b.league IS NULL');
  });

  test('installSameEventSql installs league_stage_fold with the stage-token strip + bare-stage guards', () => {
    const sql = installSameEventSql();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION league_stage_fold(t text)');
    expect(sql).toContain('(playoffs?|play-?offs?|post-?season|finals|championship|tour)');
    expect(sql).toContain("~* '^(playoffs?|play-?offs?|post-?season|finals|championship|tour)$'");
    expect(sql).toContain("s.base ~* '^[a-z0-9]{2,4}\\s+championship\\s*$'");
    expect(sql).toContain("' ', ''");
  });

  test('sameEventFragment + sameFixtureFragment carry the prone-sport-gated evening day-shift arm', () => {
    for (const frag of [sameEventFragment('a', 'b'), sameFixtureFragment('a', 'b')]) {
      expect(frag).toContain("AT TIME ZONE 'UTC'");
      expect(frag).toContain('::date - 1');
      expect(frag).toContain("('baseball','basketball','ice hockey','hockey')");
      expect(frag).toContain("a.condition_date_precision = 'minute' AND b.condition_date_precision = 'day'");
      expect(frag).toContain("b.condition_date_precision = 'minute' AND a.condition_date_precision = 'day'");
    }
  });

  test('the plain ladder (no opts — ann-candidates & bypass builders) has NO day-shift arm', () => {
    const plain = datePrecisionLadderSql('a', 'b', 1000, 1000, '::timestamptz');
    expect(plain).not.toContain('::date - 1');
    expect(plain).not.toContain("AT TIME ZONE 'UTC'");
  });

  test('sameEventFragment + sameFixtureFragment carry the START-INSTANT veto + ambiguous-evening refusal', () => {
    for (const frag of [sameEventFragment('a', 'b'), sameFixtureFragment('a', 'b')]) {
      expect(frag).toContain(`>= ${FIXTURE_START_TOLERANCE_MS}`);
      expect(frag).toContain("AT TIME ZONE 'America/New_York'");
      expect(frag).toContain("platform = 'polymarket'");
      expect(frag).not.toContain("platform = 'kalshi'");
    }
    expect(sameEventFragment('a', 'b')).toContain("a.event_kind IN ('match_total_metric'");
  });

  test('sameEventFragment carries the championship grain exemption inside the scope refusal', () => {
    const frag = sameEventFragment('a', 'b');
    expect(frag).toContain("a.event_kind = 'championship_winner'");
    expect(frag).toContain("COALESCE(a.canonical_event, '') !~*");
    expect(frag).toContain("COALESCE(b.canonical_event, '') !~*");
    expect(frag).toContain("COALESCE(a.title, '')           !~*");
    expect(frag).toContain("COALESCE(b.title, '')           !~*");
    expect(frag).toContain('a.resolution_scope <> b.resolution_scope');
  });
});

describe('foldLeagueKey + Tier-2 league compatibility', () => {
  test('stage suffixes fold onto the base league; spacing/case despaced', () => {
    expect(foldLeagueKey('NBA Playoffs')).toBe('nba');
    expect(foldLeagueKey('NBA Finals')).toBe('nba');
    expect(foldLeagueKey('NBA')).toBe('nba');
    expect(foldLeagueKey('La Liga')).toBe('laliga');
    expect(foldLeagueKey('LaLiga')).toBe('laliga');
  });

  test('bare-stage guards survive the fold (EFL Championship / Tour Championship)', () => {
    expect(foldLeagueKey('Championship')).toBe('championship');
    expect(foldLeagueKey('Tour Championship')).toBe('tourchampionship');
  });

  test('unified fold (audit 2026-07-01 #9): season prefix strips at edge grain too, matching the Stage-3 ANN fold', () => {
    expect(foldLeagueKey('2025-26 La Liga')).toBe('laliga');
    expect(foldLeagueKey('2026 NBA Finals')).toBe('nba'); // season + stage compose
    expect(foldLeagueKey('La Liga 2')).toBe('laliga2');   // ordinal tier — never collapsed
  });

  const base = (over: Partial<NodeFacts> = {}) => node({
    canonicalEvent: 'Boston Celtics vs New York Knicks',
    conditionDate: D('2026-05-10T23:00:00Z'),
    conditionDatePrecision: 'day',
    eventKind: 'match_total_metric', // non-decisive → Tier-2 'same' is observable
    title: 'Celtics vs Knicks total points',
    ...over,
  });

  test("Tier-2: 'NBA Playoffs' vs 'NBA' no longer false-blocks at edge grain", () => {
    const a = base({ platformEventId: 'k1', league: 'NBA Playoffs' });
    const b = base({ platformEventId: 'p1', league: 'NBA' });
    expect(sameResolvingEvent(a, b)).toBe('same');
  });

  test("Tier-2: 'La Liga' vs 'LaLiga' spacing drift no longer false-blocks", () => {
    const a = base({ platformEventId: 'k1', league: 'La Liga' });
    const b = base({ platformEventId: 'p1', league: 'LaLiga' });
    expect(sameResolvingEvent(a, b)).toBe('same');
  });

  test('Tier-2: genuinely DISTINCT leagues still block', () => {
    const a = base({ platformEventId: 'k1', league: 'NBA' });
    const b = base({ platformEventId: 'p1', league: 'NHL' });
    expect(sameResolvingEvent(a, b)).toBe('different');
  });
});

describe('isCompetitionGrainChampionship — the grain discriminator', () => {
  const champ = (over: Partial<NodeFacts> = {}) => node({
    eventKind: 'championship_winner',
    canonicalEvent: '2026 world cup',
    title: 'Will Argentina win the 2026 World Cup?',
    ...over,
  });

  test('competition-grain champion future → true', () => {
    expect(isCompetitionGrainChampionship(champ())).toBe(true);
  });

  test("fixture 'a vs b' shape in the TITLE → false (per-game stat-leader misparse class)", () => {
    expect(isCompetitionGrainChampionship(champ({
      title: 'Will Jalen Brunson record the most points in the New York vs Philadelphia game?',
    }))).toBe(false);
  });

  test("fixture 'a vs b' shape in canonical_event → false", () => {
    expect(isCompetitionGrainChampionship(champ({
      canonicalEvent: '2026 will new york y vs los angeles d be the matchup in the championship series',
    }))).toBe(false);
  });

  test("'be the matchup' misparse → false even with 'and'-joined teams (no vs token)", () => {
    expect(isCompetitionGrainChampionship(champ({
      title: 'Will Carolina and Colorado be the matchup in the 2026 Pro Hockey Championship Series?',
    }))).toBe(false);
  });

  test('per-game ordinal in the title → false (Game 7 series rows)', () => {
    expect(isCompetitionGrainChampionship(champ({
      title: 'Will the first road win of the series be in Game 7?',
    }))).toBe(false);
  });

  test("club names containing a bare 'V' do NOT false-gate (space-delimited vs token)", () => {
    expect(isCompetitionGrainChampionship(champ({
      title: 'Will V-Varen Nagasaki win Japan J. League?',
    }))).toBe(true);
  });

  test('non-championship kinds are never exempt', () => {
    expect(isCompetitionGrainChampionship(champ({ eventKind: 'match_winner' }))).toBe(false);
  });
});

describe('sameResolvingEvent — championship grain exemption', () => {
  const champA = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'kalshi:KXWC',
    canonicalEvent: '2026 world cup',
    conditionDate: D('2026-07-19T00:00:00Z'),
    conditionDatePrecision: 'year',
    eventKind: 'championship_winner',
    title: 'Will Argentina win the 2026 World Cup?',
    ...over,
  });
  const champB = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'pm-wc-champ',
    canonicalEvent: '2026 World Cup',
    conditionDate: D('2026-07-19T00:00:00Z'),
    conditionDatePrecision: 'year',
    eventKind: 'championship_winner',
    title: '2026 World Cup Winner',
    ...over,
  });

  test('competition-grain champion pair, scope UNKNOWN (97% NULL live) → same (was indeterminate)', () => {
    expect(sameResolvingEvent(champA(), champB())).toBe('same');
  });

  test('fixture-grain side (vs in title) keeps the refusal → indeterminate', () => {
    expect(sameResolvingEvent(
      champA({ title: 'Will Boston win the New York vs Boston championship game?' }),
      champB(),
    )).toBe('indeterminate');
  });

  test('KNOWN-CONFLICTING scopes still refuse even at competition grain', () => {
    expect(sameResolvingEvent(
      champA({ resolutionScope: 'regulation' }),
      champB({ resolutionScope: 'incl_overtime' }),
    )).toBe('indeterminate');
  });

  test('match_winner whole-match unknown-scope refusal is UNCHANGED (no exemption bleed)', () => {
    expect(sameResolvingEvent(
      champA({ eventKind: 'match_winner', title: 'Will the Heretics win the match?', canonicalEvent: 'A vs B' }),
      champB({ eventKind: 'match_winner', title: 'Match winner', canonicalEvent: 'a vs b' }),
    )).toBe('indeterminate');
  });
});

describe('sameFixtureFragment — cross-kind within-fixture gate', () => {
  const frag = sameFixtureFragment('a', 'b');

  test('keys on canonical_event equality (lower+immutable_unaccent+btrim)', () => {
    expect(frag).toContain('lower(immutable_unaccent(btrim(a.canonical_event))) = lower(immutable_unaccent(btrim(b.canonical_event)))');
    expect(frag).toContain('IS NOT NULL'); // canonical_event must be non-null
  });

  test('requires identical alphabetized participant SET (proves same two teams)', () => {
    expect(frag).toContain('a.participants = b.participants');
    expect(frag).toContain('a.participants IS NOT NULL AND b.participants IS NOT NULL');
  });

  test('does NOT require event_kind equality (it is a CROSS-kind gate)', () => {
    expect(frag).not.toContain('a.event_kind = b.event_kind');
  });

  test('matches per-game ordinal (keeps Map 1 / 1st-half slices apart)', () => {
    expect(frag).toContain("a.discriminators->>'game_ordinal' IS NOT DISTINCT FROM b.discriminators->>'game_ordinal'");
    expect(frag).not.toContain('game_ordinal(a.title)');
  });

  test('consequent metric_scope gate (NULL or game only — rejects sub-game slices)', () => {
    expect(frag).toContain("(b.metric_scope IS NULL OR b.metric_scope = 'game')");
    expect(frag).not.toContain("a.metric_scope = 'game'");
  });

  test('carries the load-bearing precision-aware DATE gate (home/away two-leg trap)', () => {
    expect(frag).toContain('::timestamptz');
    expect(frag).toContain('condition_date_precision');
    expect(frag).toContain('::date'); // same-calendar-day for day precision
  });

  test('SKIPS the FT/ET DECISIVE_KINDS refusal (an exact score is regulation-grade)', () => {
    expect(frag).not.toContain('resolution_scope');
    expect(frag).not.toContain('DECISIVE');
  });

  test('RC1 veto: refuses when both rep-member end_dates differ by >= the 3-day divergence threshold', () => {
    expect(frag).toContain('fixture_end_date');
    expect(frag).toContain('a.fixture_end_date IS NOT NULL AND b.fixture_end_date IS NOT NULL');
    // veto threshold is FIXTURE_LEG_DIVERGENCE_MS (3 days), not the 24h day tolerance
    expect(frag).toContain(`>= ${FIXTURE_LEG_DIVERGENCE_MS}`);
    expect(FIXTURE_LEG_DIVERGENCE_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(FIXTURE_LEG_DIVERGENCE_MS).toBeGreaterThan(config.pairing.sameEventDefaultToleranceMs);
  });

  test('RC1 veto is SUBTRACTIVE: NULL end_date either side cannot trigger a refusal', () => {
    expect(frag).toContain('NOT (\n         a.fixture_end_date IS NOT NULL AND b.fixture_end_date IS NOT NULL');
  });
});

describe('sameResolvingEvent — evening day-shift arm (minute UTC vs day local)', () => {
  const FIX = '100 thieves vs g2 esports';
  const kalshiNight = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'kalshi:KXVALORANT100TG2',
    canonicalEvent: FIX,
    conditionDate: D('2026-05-15T04:00:00Z'), // 04:00 UTC = US evening May 14
    conditionDatePrecision: 'minute',
    eventKind: 'match_total_metric',
    sport: 'esports',
    title: 'Will over 12.5 rounds be played in the 100 Thieves vs. G2 Esports match?',
    ...over,
  });
  const pmLocalDay = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'pm:257425',
    canonicalEvent: FIX,
    conditionDate: D('2026-05-14T00:00:00Z'), // slug-iso local game day
    conditionDatePrecision: 'day',
    eventKind: 'match_total_metric',
    sport: 'esports',
    title: 'Valorant: G2 Esports vs 100 Thieves (BO3)',
    ...over,
  });

  test('P5: an UNKNOWN sport on either side disables the arm (NULL is not evidence)', () => {
    expect(sameResolvingEvent(kalshiNight({ sport: null }), pmLocalDay())).toBe('different');
    expect(sameResolvingEvent(kalshiNight(), pmLocalDay({ sport: null }))).toBe('different');
    expect(sameResolvingEvent(kalshiNight({ sport: null }), pmLocalDay({ sport: null }))).toBe('different');
  });

  test('US-evening kalshi minute (hour<10) matches PM previous-day slug day → same', () => {
    expect(sameResolvingEvent(kalshiNight(), pmLocalDay())).toBe('same');
  });

  test('orientation-symmetric (day side as `a`)', () => {
    expect(sameResolvingEvent(pmLocalDay(), kalshiNight())).toBe('same');
  });

  test('same-UTC-day pairs still match (the arm only ADDS the −1-day case)', () => {
    expect(sameResolvingEvent(
      kalshiNight({ conditionDate: D('2026-05-14T19:00:00Z') }), pmLocalDay(),
    )).toBe('same');
  });

  test('late-UTC-hour minute stamp (>=10) does NOT bridge to the previous day', () => {
    expect(sameResolvingEvent(
      kalshiNight({ conditionDate: D('2026-05-15T14:30:00Z') }), pmLocalDay(),
    )).toBe('different');
  });

  test('prone sport (baseball) on either side disables the arm — MLB back-to-back series must not bridge', () => {
    expect(sameResolvingEvent(
      kalshiNight({ sport: 'baseball' }), pmLocalDay({ sport: 'baseball' }),
    )).toBe('different');
    expect(sameResolvingEvent(
      kalshiNight(), pmLocalDay({ sport: 'baseball' }),
    )).toBe('different');
    expect(sameResolvingEvent(
      kalshiNight({ sport: 'basketball' }), pmLocalDay(),
    )).toBe('different');
  });

  test('non-prone sport (soccer) keeps the arm', () => {
    expect(sameResolvingEvent(
      kalshiNight({ sport: 'soccer' }), pmLocalDay({ sport: 'soccer' }),
    )).toBe('same');
  });

  test('day-vs-day consecutive days do NOT match (arm is strictly minute×day)', () => {
    expect(sameResolvingEvent(
      kalshiNight({ conditionDate: D('2026-05-15T00:00:00Z'), conditionDatePrecision: 'day' }),
      pmLocalDay(),
    )).toBe('different');
  });

  test('minute two days ahead does NOT match (only −1 day, never −2)', () => {
    expect(sameResolvingEvent(
      kalshiNight({ conditionDate: D('2026-05-16T04:00:00Z') }), pmLocalDay(),
    )).toBe('different');
  });

  test('decisive kind with known-equal scopes recovers via the arm too', () => {
    expect(sameResolvingEvent(
      kalshiNight({ eventKind: 'match_winner', resolutionScope: 'regulation' }),
      pmLocalDay({ eventKind: 'match_winner', resolutionScope: 'regulation' }),
    )).toBe('same');
  });
});

describe('sameResolvingEvent — no-overtime-concept sport exemption (esports/tennis)', () => {
  const FIX = 'miami heretics vs paris gentle mates';
  const kalshiSeries = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'kalshi:KXLOLMHPAR',
    canonicalEvent: FIX,
    conditionDate: D('2026-05-10T23:00:00Z'),
    conditionDatePrecision: 'minute',
    eventKind: 'match_winner',
    sport: null, // kalshi esports platform_events are consistently sport-NULL
    title: 'Will Miami Heretics win the series?',
    ...over,
  });
  const pmSeries = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'pm:257425',
    canonicalEvent: FIX,
    conditionDate: D('2026-05-10T23:00:00Z'),
    conditionDatePrecision: 'minute',
    eventKind: 'match_winner',
    sport: 'esports',
    title: 'LoL: Miami Heretics vs Paris Gentle Mates (BO3)',
    ...over,
  });

  test('the flagship surface: esports match_winner, both scopes NULL, one-sided sport stamp → same', () => {
    expect(sameResolvingEvent(kalshiSeries(), pmSeries())).toBe('same');
  });

  test("post-backfill 'unspecified' × 'unspecified' → same", () => {
    expect(sameResolvingEvent(
      kalshiSeries({ resolutionScope: 'unspecified' }),
      pmSeries({ resolutionScope: 'unspecified' }),
    )).toBe('same');
  });

  test("'unspecified' × concrete → same (only ONE settlement basis exists, so the concrete stamp cannot diverge from it)", () => {
    expect(sameResolvingEvent(
      kalshiSeries({ resolutionScope: 'unspecified' }),
      pmSeries({ resolutionScope: 'regulation' }),
    )).toBe('same');
  });

  test('specific game titles are exempt too (dota 2 / league of legends / valorant / cs2)', () => {
    for (const s of ['dota 2', 'league of legends', 'valorant', 'cs2']) {
      expect(sameResolvingEvent(kalshiSeries(), pmSeries({ sport: s }))).toBe('same');
    }
  });

  test('tennis is exempt (set-based, no draw/OT concept)', () => {
    expect(sameResolvingEvent(
      kalshiSeries({ sport: 'tennis', canonicalEvent: 'alcaraz vs sinner', title: 'Will Alcaraz win?' }),
      pmSeries({ sport: 'tennis', canonicalEvent: 'Alcaraz vs Sinner', title: 'Alcaraz vs Sinner Winner' }),
    )).toBe('same');
  });

  test('KNOWN-CONFLICTING concrete scopes still refuse (belt mirrors the championship arm)', () => {
    expect(sameResolvingEvent(
      kalshiSeries({ resolutionScope: 'regulation' }),
      pmSeries({ resolutionScope: 'incl_overtime' }),
    )).toBe('indeterminate');
  });

  test('soccer is NOT exempt: unknown-scope whole-match winner still refuses', () => {
    expect(sameResolvingEvent(
      kalshiSeries({ sport: 'soccer', canonicalEvent: 'arsenal vs chelsea', title: 'Will Arsenal win?' }),
      pmSeries({ sport: 'soccer', canonicalEvent: 'Arsenal vs Chelsea', title: 'Arsenal vs Chelsea Winner' }),
    )).toBe('indeterminate');
  });

  test('both sides sport-NULL → no exemption (needs at least one no-OT stamp)', () => {
    expect(sameResolvingEvent(kalshiSeries(), pmSeries({ sport: null }))).toBe('indeterminate');
  });

  test('SQL fragment carries the same exemption arm with the known-conflict belt', () => {
    const frag = sameEventFragment('a', 'b');
    expect(frag).toContain("lower(COALESCE(a.sport, '')) IN ('esports'");
    expect(frag).toContain("lower(COALESCE(b.sport, '')) IN ('esports'");
    expect(frag).toContain("'tennis'");
    expect(frag).not.toContain("'soccer'"); // soccer must never enter the exempt set
    const conflictBelt = 'a.resolution_scope <> b.resolution_scope';
    expect(frag.split(conflictBelt).length - 1).toBe(4);
  });

  test('the kind-agnostic known-conflict refusal is OUTSIDE the DECISIVE_KINDS gate', () => {
    const frag = sameEventFragment('a', 'b');
    const outer = frag.indexOf(`AND NOT ${scopesKnownAndConflictSql('a', 'b')}`);
    expect(outer).toBeGreaterThan(-1);
    expect(outer).toBeLessThan(frag.indexOf(`${DECISIVE_KINDS_SQL}`));
  });
});

describe('sameResolvingEvent — kind-agnostic known-conflict resolution_scope refusal', () => {
  const prop = (over: Partial<NodeFacts> = {}) => node({
    canonicalEvent: 'Declan Rice assists',
    conditionDate: new Date('2026-07-10T00:00:00Z'),
    conditionDatePrecision: 'day',
    eventKind: 'player_prop_threshold',
    sport: 'soccer',
    title: 'Declan Rice: 1+ assists',
    ...over,
  });

  test('player-prop pair with regulation vs incl_overtime → indeterminate (was "same")', () => {
    expect(sameResolvingEvent(
      prop({ resolutionScope: 'incl_overtime' }),
      prop({ resolutionScope: 'regulation' }),
    )).toBe('indeterminate');
  });

  test('the refusal is symmetric', () => {
    expect(sameResolvingEvent(
      prop({ resolutionScope: 'regulation' }),
      prop({ resolutionScope: 'incl_overtime' }),
    )).toBe('indeterminate');
  });

  test('NULL POLICY: one side unknown is NOT a refusal (both-known-and-differ)', () => {
    expect(sameResolvingEvent(prop({ resolutionScope: 'incl_overtime' }), prop())).toBe('same');
    expect(sameResolvingEvent(prop({ resolutionScope: 'regulation' }), prop({ resolutionScope: 'unspecified' }))).toBe('same');
    expect(sameResolvingEvent(prop(), prop())).toBe('same');
  });

  test('equal KNOWN scopes still pair', () => {
    expect(sameResolvingEvent(
      prop({ resolutionScope: 'regulation' }),
      prop({ resolutionScope: 'regulation' }),
    )).toBe('same');
  });

  test('it reaches non-decisive NON-prop kinds too (aggregate vs regulation)', () => {
    expect(sameResolvingEvent(
      prop({ eventKind: 'match_total_metric', resolutionScope: 'aggregate' }),
      prop({ eventKind: 'match_total_metric', resolutionScope: 'regulation' }),
    )).toBe('indeterminate');
  });
});

describe('sameResolvingEvent — draw×draw DECISIVE exemption', () => {
  const FIX = 'arsenal vs chelsea';
  const drawA = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'pm:draw-a',
    canonicalEvent: FIX,
    conditionDate: D('2026-05-10T18:00:00Z'),
    conditionDatePrecision: 'day',
    eventKind: 'match_winner',
    sport: 'soccer', // deliberately NOT a no-overtime sport — isolates the draw arm
    title: 'Will Arsenal vs Chelsea end in a draw?',
    drawAxis: 'draw',
    ...over,
  });
  const drawB = (over: Partial<NodeFacts> = {}) => node({
    platformEventId: 'predict:draw-b',
    canonicalEvent: 'Arsenal vs Chelsea',
    conditionDate: D('2026-05-10T18:00:00Z'),
    conditionDatePrecision: 'day',
    eventKind: 'match_winner',
    sport: 'soccer',
    title: 'Draw',
    drawAxis: 'draw',
    ...over,
  });

  test('draw×draw, unknown scope (soccer) → same (was indeterminate before WP-R4)', () => {
    expect(sameResolvingEvent(drawA(), drawB())).toBe('same');
  });

  test('draw×draw with KNOWN-conflicting scopes still refuses (FT draw vs ET draw stay distinct)', () => {
    expect(sameResolvingEvent(
      drawA({ resolutionScope: 'regulation' }),
      drawB({ resolutionScope: 'incl_overtime' }),
    )).toBe('indeterminate');
  });

  test('draw×decisive (only one side draw) keeps the unknown-scope refusal', () => {
    expect(sameResolvingEvent(drawA(), drawB({ drawAxis: 'decisive', title: 'Chelsea' }))).toBe('indeterminate');
  });

  test('decisive×decisive soccer whole-match unknown-scope refusal is UNCHANGED (no bleed)', () => {
    expect(sameResolvingEvent(
      drawA({ drawAxis: 'decisive', title: 'Arsenal' }),
      drawB({ drawAxis: 'decisive', title: 'Chelsea' }),
    )).toBe('indeterminate');
  });

  test('SQL fragment carries the draw×draw exemption arm with its own known-conflict belt', () => {
    const frag = sameEventFragment('a', 'b');
    expect(frag).toContain("COALESCE(a.discriminators->>'draw_axis', '') = 'draw'");
    expect(frag).toContain("COALESCE(b.discriminators->>'draw_axis', '') = 'draw'");
  });
});
