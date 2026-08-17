/**
 * UNIT_VOCAB table tests + DB-free integration tests for the emission-side
 * value_unit canonicalization.
 *
 * Covers:
 *   · every KEEP_AS_IS mapping row + the currency-code guard
 *   · plural canonicalization for count nouns (incl. irregulars)
 *   · unknown-sport spread passthrough-pluralize (never guesses)
 *   · sport-dependent spread remap rows (goals-vs-points fork) + the league
 *     fallback
 *   · genuinely distinct units stay distinct (tennis sets ≠ games; esports
 *     maps; NBA/NHL series 'games' is NOT a score margin)
 *   · canonicalizeNormUnit keeps value_unit / condition_value /
 *     player-prop canonical_event in lockstep, and is a no-op for the
 *     current Kalshi emission vocabulary (drift guard)
 *   · integration: Kalshi EPL spread + PM Template R soccer spread both land
 *     on 'goals'; Limitless Template M emits plural
 *   · the MLB-spread fixture-symmetric canonical_event convention
 */
import { describe, test, expect } from 'bun:test';
import { canonicalUnit, canonicalizeNormUnit, isSportRemappableSpreadUnit, isSportRemappableTotalUnit, __TEST__ } from './unit-vocab.js';
import { lookupLadderSeries, parseSpreadTitle, extractSpreadFixture } from './kalshi-series.js';
import { matchTemplate, deriveCanonicalEventCore, type CandidateRow } from './text-deterministic.js';

function row(title: string, overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    market_id: 1,
    platform: 'polymarket',
    title,
    end_date: null,
    category_unified: 'sports',
    hierarchy_type: null,
    hierarchy_value: null,
    hierarchy_level: null,
    feat_condition_shape: null,
    feat_condition_direction: null,
    feat_temporal: null,
    numbers: null,
    platform_event_id: null,
    event_match_context: null,
    strike_type: null,
    floor_strike: null,
    cap_strike: null,
    event_ticker: null,
    event_title: null,
    strike_date: null,
    rules_primary: null,
    yes_sub_title: null,
    subtitle: null,
    occurrence_datetime: null,
    slug: null,
    non_kalshi_event_title: null,
    native_question: null,
    is_neg_risk: null,
  ...overrides,
  } as CandidateRow;
}

// ── 1. KEEP_AS_IS table — every row maps to its canonical form ──────────────
describe('canonicalUnit — KEEP_AS_IS table (mass/measure/marker units + currencies)', () => {
  test('every table row maps lowercase fold → canonical form', () => {
    for (const [folded, canonical] of Object.entries(__TEST__.KEEP_AS_IS)) {
      expect(canonicalUnit(folded)).toBe(canonical);
      expect(canonicalUnit(folded.toUpperCase())).toBe(canonical);
    }
  });

  test('live emission spellings stay byte-stable', () => {
    expect(canonicalUnit('USD')).toBe('USD');
    expect(canonicalUnit('JPY')).toBe('JPY');
    expect(canonicalUnit('percent')).toBe('percent');
    expect(canonicalUnit('percentage points')).toBe('percentage points');
    expect(canonicalUnit('bps')).toBe('bps');
    expect(canonicalUnit('rank')).toBe('rank');
    expect(canonicalUnit('score')).toBe('score');     // KXRT ladder
    expect(canonicalUnit('ratio')).toBe('ratio');
    expect(canonicalUnit('fahrenheit')).toBe('fahrenheit');
    expect(canonicalUnit('celsius')).toBe('celsius');
    expect(canonicalUnit('index_value')).toBe('index_value');
    expect(canonicalUnit('count')).toBe('count');     // Template E fallback
    expect(canonicalUnit('pick')).toBe('pick');       // draft slot marker
    expect(canonicalUnit('team')).toBe('team');       // next-team dest type
    expect(canonicalUnit('league')).toBe('league');   // next-team dest type
    expect(canonicalUnit('teams_remaining')).toBe('teams_remaining');
    expect(canonicalUnit('hits_runs_rbis')).toBe('hits_runs_rbis');
    expect(canonicalUnit('homes_millions')).toBe('homes_millions');
  });

  test('unlisted ISO-4217-looking codes are kept verbatim (currency guard)', () => {
    expect(canonicalUnit('CHF')).toBe('CHF');
    expect(canonicalUnit('AUD')).toBe('AUD');
  });
});

// ── 2. plural canonicalization for count nouns ──────────────────────────────
describe('canonicalUnit — plural canonicalization (count nouns)', () => {
  test('Template-M singularized totals re-pluralize (the 1,957-pair trailing-s class)', () => {
    expect(canonicalUnit('goal')).toBe('goals');
    expect(canonicalUnit('corner')).toBe('corners');
    expect(canonicalUnit('card')).toBe('cards');
    expect(canonicalUnit('run')).toBe('runs');
    expect(canonicalUnit('set')).toBe('sets');
    expect(canonicalUnit('kill')).toBe('kills');     // Template U
    expect(canonicalUnit('round')).toBe('rounds');   // Template U
    expect(canonicalUnit('map')).toBe('maps');       // Template U
    expect(canonicalUnit('tweet')).toBe('tweets');   // Template V / social
    expect(canonicalUnit('post')).toBe('posts');     // heals vs Kalshi 'posts'
    expect(canonicalUnit('view')).toBe('views');
    expect(canonicalUnit('subscriber')).toBe('subscribers');
  });

  test('already-plural units pass through unchanged', () => {
    for (const u of ['goals', 'points', 'runs', 'corners', 'cards', 'kills', 'maps',
                     'sets', 'games', 'wins', 'votes', 'streams', 'strokes', 'units',
                     'jobs', 'cuts', 'inches', 'threes', 'home_runs', 'total_bases',
                     'strikeouts', 'rebounds', 'assists', 'blocks', 'steals',
                     'passing_yards', 'rushing_yards', 'receiving_yards']) {
      expect(canonicalUnit(u)).toBe(u);
    }
  });

  test('irregular plurals', () => {
    expect(canonicalUnit('tornado')).toBe('tornadoes');
    expect(canonicalUnit('inch')).toBe('inches');
    expect(canonicalUnit('match')).toBe('matches'); // sibilant ending → +es
  });
});

// ── 3. sport-dependent spread remap (the goals-vs-points fork) ──────────────
describe('canonicalUnit — match_spread sport remap', () => {
  const SPREAD = { eventKind: 'match_spread' } as const;

  test('every SPORT_NATURAL_SPREAD_UNIT row maps each generic score unit to the natural one', () => {
    for (const [sport, natural] of Object.entries(__TEST__.SPORT_NATURAL_SPREAD_UNIT)) {
      for (const generic of ['points', 'point', 'goals', 'goal', 'runs', 'run']) {
        expect(canonicalUnit(generic, { ...SPREAD, sport })).toBe(natural);
      }
    }
  });

  test('table rows are the sports natural units', () => {
    expect(__TEST__.SPORT_NATURAL_SPREAD_UNIT).toEqual({
      soccer: 'goals',
      basketball: 'points',
      'american football': 'points',
      baseball: 'runs',
      'ice hockey': 'goals',
      cricket: 'runs',
    });
  });

  test('unknown sport → keep handler unit, normalized to plural (never guesses)', () => {
    expect(canonicalUnit('points', { ...SPREAD, sport: null })).toBe('points');
    expect(canonicalUnit('point', { ...SPREAD, sport: null })).toBe('points');
    expect(canonicalUnit('goals', { ...SPREAD })).toBe('goals');
    expect(canonicalUnit('points', { ...SPREAD, sport: 'darts' })).toBe('points'); // unlisted sport
  });

  test('league fallback resolves sport when ctx.sport is null', () => {
    expect(canonicalUnit('points', { ...SPREAD, league: 'Premier League' })).toBe('goals');
    expect(canonicalUnit('points', { ...SPREAD, league: 'NBA' })).toBe('points');
    expect(canonicalUnit('points', { ...SPREAD, league: 'MLB' })).toBe('runs');
    expect(canonicalUnit('points', { ...SPREAD, league: 'NHL' })).toBe('goals');
    // ctx.sport outranks league
    expect(canonicalUnit('points', { ...SPREAD, sport: 'basketball', league: 'Premier League' })).toBe('points');
  });

  test('non-generic spread units are NEVER remapped (different ladder dimensions)', () => {
    // esports map handicap (Template T)
    expect(canonicalUnit('maps', { ...SPREAD, sport: 'soccer' })).toBe('maps');
    // NBA/NHL playoff-SERIES spread is measured in games WON, not score margin
    expect(canonicalUnit('games', { ...SPREAD, sport: 'basketball' })).toBe('games');
    expect(canonicalUnit('sets', { ...SPREAD, sport: 'tennis' })).toBe('sets');
    expect(canonicalUnit('strokes', { ...SPREAD, sport: 'golf' })).toBe('strokes');
  });

  test('the remap is scoped to match_spread — totals/props keep their explicit unit', () => {
    expect(canonicalUnit('points', { eventKind: 'match_total_metric', sport: 'soccer' })).toBe('points');
    expect(canonicalUnit('goals', { eventKind: 'match_total_metric', sport: 'basketball' })).toBe('goals');
    expect(canonicalUnit('points', { eventKind: 'player_prop_threshold', sport: 'soccer' })).toBe('points');
  });

  test('tennis sets / games / points remain three distinct units end-to-end', () => {
    const t = { eventKind: 'match_total_metric', sport: 'tennis' } as const;
    const out = new Set([canonicalUnit('sets', t), canonicalUnit('games', t), canonicalUnit('points', t)]);
    expect(out.size).toBe(3);
  });

  test('isSportRemappableSpreadUnit gate', () => {
    expect(isSportRemappableSpreadUnit('points')).toBe(true);
    expect(isSportRemappableSpreadUnit('Goal')).toBe(true);
    expect(isSportRemappableSpreadUnit('maps')).toBe(false);
    expect(isSportRemappableSpreadUnit('games')).toBe(false);
    expect(isSportRemappableSpreadUnit('rank')).toBe(false);
  });
});

// ── 3b. match_total_metric INFERRED-unit sport remap ──────────────
describe('canonicalUnit — match_total_metric inferred-unit remap (P4 gap 2)', () => {
  const TOTAL = { eventKind: 'match_total_metric' } as const;

  test('baseball + inferred unit → runs (the 528-blocked-pairs fix)', () => {
    // MLB "Tigers vs. Mets: O/U 8.5" → ouUnit guessed 'games' (mid range)
    expect(canonicalUnit('games', { ...TOTAL, sport: 'baseball', unitInferred: true })).toBe('runs');
    // MLB "Tigers vs. Mets: O/U 4.5" → ouUnit guessed 'goals' (≤6.5)
    expect(canonicalUnit('goals', { ...TOTAL, sport: 'baseball', unitInferred: true })).toBe('runs');
    expect(canonicalUnit('points', { ...TOTAL, sport: 'baseball', unitInferred: true })).toBe('runs');
    expect(canonicalUnit('runs', { ...TOTAL, sport: 'baseball', unitInferred: true })).toBe('runs');
  });

  test('title-EXPLICIT units are NEVER remapped (unitInferred unset/false)', () => {
    // NBA/NHL playoff series-length total ('total games in the series') and
    // tennis 'Total Sets' are explicit — the genuine 'games'/'sets' must stay.
    expect(canonicalUnit('games', { ...TOTAL, sport: 'baseball' })).toBe('games');
    expect(canonicalUnit('games', { ...TOTAL, sport: 'baseball', unitInferred: false })).toBe('games');
    expect(canonicalUnit('games', { ...TOTAL, sport: 'basketball' })).toBe('games');
    expect(canonicalUnit('sets', { ...TOTAL, sport: 'baseball', unitInferred: true })).toBe('sets'); // not eligible
  });

  test('non-baseball sports keep the inferred unit (series-length ambiguity)', () => {
    // tennis bare "A vs B: O/U 22.5" → 'games' is CORRECT
    expect(canonicalUnit('games', { ...TOTAL, sport: 'tennis', unitInferred: true })).toBe('games');
    // basketball/hockey low lines are ambiguous with playoff series length → no remap
    expect(canonicalUnit('games', { ...TOTAL, sport: 'basketball', unitInferred: true })).toBe('games');
    expect(canonicalUnit('goals', { ...TOTAL, sport: 'ice hockey', unitInferred: true })).toBe('goals');
    expect(canonicalUnit('goals', { ...TOTAL, sport: 'soccer', unitInferred: true })).toBe('goals');
    // unknown sport → never guessed
    expect(canonicalUnit('games', { ...TOTAL, sport: null, unitInferred: true })).toBe('games');
  });

  test('league fallback (MLB) resolves baseball when ctx.sport is null', () => {
    expect(canonicalUnit('games', { ...TOTAL, league: 'MLB', unitInferred: true })).toBe('runs');
    expect(canonicalUnit('games', { ...TOTAL, league: 'NBA', unitInferred: true })).toBe('games');
  });

  test('remap is scoped to match_total_metric (spread/prop kinds unaffected)', () => {
    expect(canonicalUnit('games', { eventKind: 'match_spread', sport: 'baseball', unitInferred: true })).toBe('games');
    expect(canonicalUnit('games', { eventKind: 'player_prop_threshold', sport: 'baseball', unitInferred: true })).toBe('games');
  });

  test('isSportRemappableTotalUnit gate (chokepoint lookup guard)', () => {
    expect(isSportRemappableTotalUnit('games')).toBe(true);
    expect(isSportRemappableTotalUnit('Game')).toBe(true);
    expect(isSportRemappableTotalUnit('goals')).toBe(true);
    expect(isSportRemappableTotalUnit('points')).toBe(true);
    expect(isSportRemappableTotalUnit('runs')).toBe(true);
    expect(isSportRemappableTotalUnit('sets')).toBe(false);
    expect(isSportRemappableTotalUnit('maps')).toBe(false);
    expect(isSportRemappableTotalUnit('corners')).toBe(false);
  });

  test('SPORT_NATURAL_TOTAL_UNIT stays baseball-only (extend only with live proof)', () => {
    expect(__TEST__.SPORT_NATURAL_TOTAL_UNIT).toEqual({ baseball: 'runs' });
  });

  test('Template H stamps value_unit_inferred ONLY on magnitude-guessed units', () => {
    // Bare MLB total — no qualifier → inferred
    const mlb = matchTemplate(row('Detroit Tigers vs. New York Mets: O/U 10.5'));
    expect(mlb!.source_tag).toBe('text-deterministic-H');
    expect(mlb!.value_unit).toBe('games'); // pre-chokepoint guess
    expect(mlb!.value_unit_inferred).toBe(true);
    // Explicit 'Total Sets' qualifier → NOT inferred
    const sets = matchTemplate(row('Alejandro Tabilo vs. Aleksandar Kovacevic: Total Sets O/U 2.5'));
    expect(sets!.value_unit).toBe('sets');
    expect(sets!.value_unit_inferred).toBe(false);
    // 'Match' qualifier (tennis match games) → explicit
    const match = matchTemplate(row('Aboian vs. Pino: Match O/U 21.5'));
    expect(match!.value_unit).toBe('games');
    expect(match!.value_unit_inferred).toBe(false);
    // '1H' scopes the PERIOD, not the unit → still magnitude-inferred
    const half = matchTemplate(row('Cavaliers vs. Pistons: 1H O/U 103.5'));
    expect(half!.value_unit).toBe('points');
    expect(half!.value_unit_inferred).toBe(true);
  });

  test('end-to-end: PM MLB total + Kalshi game-total land on ONE unit', () => {
    // PM side: Template H guess + chokepoint remap (sport from KB = baseball)
    const tpl = matchTemplate(row('Detroit Tigers vs. New York Mets: O/U 8.5'))!;
    const pmUnit = canonicalUnit(tpl.value_unit!, {
      sport: 'baseball', eventKind: tpl.event_kind, unitInferred: tpl.value_unit_inferred === true,
    });
    // Kalshi side: kalshi:game-total emits 'runs' (title-explicit, no remap)
    const kalshiUnit = canonicalUnit('runs', { eventKind: 'match_total_metric' });
    expect(pmUnit).toBe('runs');
    expect(kalshiUnit).toBe('runs');
  });
});

// ── 4. canonicalizeNormUnit — the Kalshi exit wrapper ───────────────────────
describe('canonicalizeNormUnit — norm-level lockstep rewrite', () => {
  test('no-op when the unit is already canonical (object untouched)', () => {
    const norm = {
      value_unit: 'goals', condition_value: '>=1.5goals',
      canonical_event: 'FSV Mainz 05 vs Heidenheim',
      event_kind: 'match_spread', condition_metric: 'score',
    };
    canonicalizeNormUnit(norm);
    expect(norm.value_unit).toBe('goals');
    expect(norm.condition_value).toBe('>=1.5goals');
    expect(norm.canonical_event).toBe('FSV Mainz 05 vs Heidenheim');
  });

  test('singular unit drift rewrites value_unit AND the condition_value suffix', () => {
    const norm = {
      value_unit: 'goal', condition_value: '>=2.5goal',
      canonical_event: 'Arsenal vs Chelsea',
      event_kind: 'match_total_metric', condition_metric: 'count',
    };
    canonicalizeNormUnit(norm);
    expect(norm.value_unit).toBe('goals');
    expect(norm.condition_value).toBe('>=2.5goals');
    // fixture canonical_event is NOT a player-prop form → untouched
    expect(norm.canonical_event).toBe('Arsenal vs Chelsea');
  });

  test('player-prop `<subject> <unit>` canonical_event stays in lockstep', () => {
    const norm = {
      value_unit: 'home_run', condition_value: '>=2home_run',
      canonical_event: 'Aaron Judge home_run',
      event_kind: 'player_prop_threshold', condition_metric: 'count',
    };
    canonicalizeNormUnit(norm);
    expect(norm.value_unit).toBe('home_runs');
    expect(norm.condition_value).toBe('>=2home_runs');
    expect(norm.canonical_event).toBe('Aaron Judge home_runs');
  });

  test('null unit is a no-op', () => {
    const norm = {
      value_unit: null, condition_value: null, canonical_event: 'x',
      event_kind: 'match_winner', condition_metric: null,
    };
    canonicalizeNormUnit(norm);
    expect(norm.value_unit).toBeNull();
  });

  test('drift guard: the live Kalshi emission vocabulary is a no-op end-to-end', () => {
    // (unit, event_kind) pairs lifted from the kalshi-deterministic /
    // kalshi-series emission literals. The wrapper must not
    // churn ANY of them — Kalshi units are sport-natural by construction.
    const live: Array<[string, string | null, string | null]> = [
      ['goals', 'match_spread', 'score'], ['points', 'match_spread', 'score'],
      ['runs', 'match_spread', 'score'], ['games', 'match_spread', 'score'],
      ['runs', 'match_total_metric', 'score'], ['points', 'match_total_metric', 'score'],
      ['goals', 'match_total_metric', 'score'], ['maps', 'match_total_metric', 'count'],
      ['games', 'match_total_metric', 'count'],
      ['points', 'player_prop_threshold', 'count'], ['home_runs', 'player_prop_threshold', 'count'],
      ['strikeouts', 'player_prop_threshold', 'count'], ['hits_runs_rbis', 'player_prop_threshold', 'count'],
      ['wins', 'player_prop_threshold', 'count'], ['strokes', 'player_prop_threshold', 'score'],
      ['rank', 'championship_winner', null], ['pick', 'championship_winner', null],
      ['USD', 'price_threshold', 'price'], ['JPY', 'price_threshold', 'price'],
      ['percent', 'approval_rating', 'percentage'], ['celsius', 'weather_extreme', 'temperature'],
      ['fahrenheit', 'weather_extreme', 'temperature'], ['inches', 'weather_extreme', null],
      ['units', 'media_release', 'count'], ['score', 'media_release', 'score'],
      ['teams_remaining', 'stage_advance', null], ['team', 'stage_advance', null],
      ['league', 'stage_advance', null], ['index_value', null, null],
      ['bps', 'policy_action', null], ['jobs', null, 'count'], ['votes', 'election_turnout', 'count'],
    ];
    for (const [unit, kind, metric] of live) {
      const norm = {
        value_unit: unit, condition_value: `>=5${unit}`, canonical_event: 'whatever',
        event_kind: kind, condition_metric: metric,
      };
      canonicalizeNormUnit(norm);
      expect(norm.value_unit).toBe(unit);
      expect(norm.condition_value).toBe(`>=5${unit}`);
    }
  });
});

// ── 5. integration: cross-platform spread unit convergence ──────────────────
describe('integration — spread/total unit convergence (DB-free)', () => {
  test('Kalshi EPL spread (KXEPLSPREAD) and PM Template R soccer spread both emit goals', () => {
    // Kalshi side: series registry stamps the unit; the exit wrapper keeps it.
    const k = lookupLadderSeries('KXEPLSPREAD-26MAY10ARSCHE');
    expect(k).not.toBeNull();
    expect(k!.spec.unit).toBe('goals');
    expect(k!.spec.sport).toBe('soccer');
    const kalshiUnit = canonicalUnit(k!.spec.unit, {
      sport: k!.spec.sport, league: k!.spec.league, eventKind: k!.spec.eventKind, metric: k!.spec.metric,
    });
    expect(kalshiUnit).toBe('goals');

    // PM side: Template R hardcodes 'points'; the build-site canonicalization
    // (scope.sport='soccer' from PM tags / KB subject sport) remaps to goals.
    const tpl = matchTemplate(row('Spread: Arsenal (-1.5)'));
    expect(tpl).not.toBeNull();
    expect(tpl!.source_tag).toBe('text-deterministic-R');
    expect(tpl!.value_unit).toBe('points'); // raw template output (pre-chokepoint)
    const pmUnit = canonicalUnit(tpl!.value_unit!, {
      sport: 'soccer', league: null, eventKind: tpl!.event_kind, metric: tpl!.condition_metric,
    });
    expect(pmUnit).toBe('goals');
    expect(pmUnit).toBe(kalshiUnit);
  });

  test('PM Template R stays points for basketball (sport-natural, no churn)', () => {
    const tpl = matchTemplate(row('Spread: 76ers (-10.5)'));
    expect(tpl!.source_tag).toBe('text-deterministic-R');
    expect(canonicalUnit(tpl!.value_unit!, { sport: 'basketball', eventKind: tpl!.event_kind })).toBe('points');
  });

  test('q14703/q14731 (sem 1986): Kalshi Bundesliga spread + PM spread byte-equal on value_unit', () => {
    // Kalshi KXBUNDESLIGASPREAD "Mainz wins by over 1.5 goals?"
    const series = lookupLadderSeries('KXBUNDESLIGASPREAD-26MAY10MAIHEI');
    expect(series).not.toBeNull();
    const parsed = parseSpreadTitle('Mainz wins by over 1.5 goals?');
    expect(parsed).toEqual({ team: 'Mainz', value: 1.5 });
    const kalshiUnit = canonicalUnit(series!.spec.unit, {
      sport: series!.spec.sport, eventKind: series!.spec.eventKind,
    });

    // PM "Spread: Mainz (-1.5)" (Template R), identical value.
    const tpl = matchTemplate(row('Spread: Mainz (-1.5)'));
    expect(tpl!.source_tag).toBe('text-deterministic-R');
    expect(tpl!.value_primary).toBe(1.5);
    expect(tpl!.condition_direction).toBe('above');
    const pmUnit = canonicalUnit(tpl!.value_unit!, {
      sport: 'soccer', // scope.sport (PM tags) or KB subject sport at the build site
      eventKind: tpl!.event_kind, metric: tpl!.condition_metric,
    });

    expect(pmUnit).toBe('goals');
    expect(kalshiUnit).toBe('goals');
    expect(pmUnit).toBe(kalshiUnit); // byte-equal — Stage-4 strict gate passes
  });

  test('Limitless Template M now lands on plural units (goal/corner/card class)', () => {
    const cases: Array<[string, string]> = [
      ['Liverpool vs Chelsea: 3+ total goals?', 'goals'],
      ['Rayo Vallecano vs Girona: 11+ total corners?', 'corners'],
      ['Cremonese vs Lazio: 4+ total cards?', 'cards'],
    ];
    for (const [title, want] of cases) {
      const tpl = matchTemplate(row(title, { platform: 'limitless' }));
      expect(tpl).not.toBeNull();
      expect(tpl!.source_tag).toBe('text-deterministic-M');
      // raw template output is singular; the chokepoint pluralizes
      expect(canonicalUnit(tpl!.value_unit!, { eventKind: tpl!.event_kind, metric: tpl!.condition_metric })).toBe(want);
    }
  });

  test('Template M tennis sets total stays distinct from games', () => {
    const tpl = matchTemplate(row('Alcaraz vs Sinner: 4+ total sets?', { platform: 'limitless' }));
    expect(tpl!.source_tag).toBe('text-deterministic-M');
    expect(canonicalUnit(tpl!.value_unit!, { eventKind: tpl!.event_kind, sport: 'tennis' })).toBe('sets');
  });
});

// ── 6. MLB spread fixture-symmetric canonical_event convention ──────────────
describe('MLB spread canonical_event (fixture-symmetric, cross-platform mergeable)', () => {
  const RULES = 'If Minnesota wins by more than 1.5 runs in the Minnesota vs Cleveland professional baseball game originally scheduled for May 10, 2026 at 1:40 PM EDT, then the market resolves to Yes.';

  test('extractSpreadFixture pulls team + opponent from the MLB rules prose', () => {
    const fx = extractSpreadFixture({ title: 'Minnesota wins by over 1.5 runs?', rules_primary: RULES });
    expect(fx).toEqual({ team: 'Minnesota', value: 1.5, opponent: 'Cleveland' });
  });

  test('deriveCanonicalEventCore emits the alphabetized KB-name fixture (same as soccer SPREAD ladders)', () => {
    const ce = deriveCanonicalEventCore({
      eventKind: 'match_spread',
      conditionShape: 'monotonic_threshold',
      conditionMetric: 'score',
      valueUnit: 'runs',
      rawCanonicalEvent: 'Minnesota wins by over 1.5 runs?',
      canonicalSubject: 'Minnesota Twins',
      canonicalParticipants: ['Minnesota Twins', 'Cleveland Guardians'],
      categoryUnified: 'sports',
      eventDateIso: '2026-05-10',
    });
    expect(ce).toBe('Cleveland Guardians vs Minnesota Twins');
    // BOTH teams' rungs produce the identical key (mutex join survives)
    const ceOther = deriveCanonicalEventCore({
      eventKind: 'match_spread',
      conditionShape: 'monotonic_threshold',
      conditionMetric: 'score',
      valueUnit: 'runs',
      rawCanonicalEvent: 'Cleveland wins by over 1.5 runs?',
      canonicalSubject: 'Cleveland Guardians',
      canonicalParticipants: ['Cleveland Guardians', 'Minnesota Twins'],
      categoryUnified: 'sports',
      eventDateIso: '2026-05-10',
    });
    expect(ceOther).toBe(ce);
  });

  test('the legacy ticker fallback stays disjoint from the F5 period-scoped key', () => {
    const wholeGameFallback = `mlb spread ${'KXMLBSPREAD-26MAY101335TBBOS'.toLowerCase()}`;
    const f5 = `mlb spread first 5 ${'KXMLBF5SPREAD-26MAY101335TBBOS'.toLowerCase()}`;
    expect(wholeGameFallback).not.toBe(f5);
  });
});
