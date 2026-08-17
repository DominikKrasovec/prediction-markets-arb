/**
 * Occasion/scope identity tests for two facts in Kalshi's structured metadata
 * that distinguish otherwise-identical markets:
 *
 *   (1) the doubleheader ordinal — the `-G1`/`-G2` event-ticker suffix. Both
 *       games can carry byte-identical titles, so the title-only parser alone
 *       cannot distinguish the two fixtures.
 *   (2) the player-prop metric scope — a per-game prop (KXMLBHR "Aaron Judge:
 *       1+ home runs?") and a season prop (KXMLBSEASONHR "…30+ home runs
 *       during 2026 … regular season?") otherwise match on subject, metric,
 *       direction, unit and value.
 */
import { describe, test, expect } from 'bun:test';
import {
  parseGameOrdinal, GAME_ORDINAL_SQL_BODY, TICKER_GAME_ORDINAL_RX, gameOrdinalSpec,
} from './specs/game-ordinal.js';
import { playerPropMetricScope, metricScopeSpec, propMetricScopeSpec } from './specs/metric-scope.js';
import { getSpec, foldKeySpecs, coherenceSpecs } from './registry.js';
import type { ExtractCtx } from './registry.js';

function ctx(over: Partial<ExtractCtx>): ExtractCtx {
  return {
    title: '', outcomeLabel: null, eventKind: null, matchSource: null,
    platform: 'kalshi', raw: null, gated: {}, kb: null, ...over,
  };
}

describe('P5 (1) — Kalshi doubleheader ordinal from the event ticker', () => {
  test('the `-G<n>` suffix parses', () => {
    expect(parseGameOrdinal('KXMLBGAME-26JUL04NYYBOS-G1')).toBe(1);
    expect(parseGameOrdinal('KXMLBGAME-26JUL04NYYBOS-G2')).toBe(2);
    expect(TICKER_GAME_ORDINAL_RX.test('KXMLBGAME-26JUL04NYYBOS-G2')).toBe(true);
  });

  test('a non-doubleheader ticker still stamps NULL (whole-match granularity)', () => {
    expect(parseGameOrdinal('KXMLBGAME-26JUL04NYYBOS')).toBe(null);
    expect(parseGameOrdinal('KXMLBHR-26JUL101840MILPIT')).toBe(null);
  });

  test('the arm is UPPERCASE + hyphen-anchored — ordinary prose never fires it', () => {
    expect(parseGameOrdinal('Will the Yankees beat the Red Sox?')).toBe(null);
    expect(parseGameOrdinal('something-g2')).toBe(null);   // lowercase
    expect(parseGameOrdinal('AG2 rating')).toBe(null);     // no hyphen anchor
  });

  test('a TITLE ordinal always wins over the ticker suffix', () => {
    // The arm runs LAST, so an explicit period marker is never overridden.
    expect(parseGameOrdinal('Game 5 winner -G2')).toBe(5);
    expect(parseGameOrdinal('1st half total -G2')).toBe(1);
  });

  test('the spec reads ctx.raw.event_ticker only when the TITLE is silent', () => {
    const raw = { event_ticker: 'KXMLBGAME-26JUL04NYYBOS-G2' };
    expect(gameOrdinalSpec.extract(ctx({ title: 'Will the Yankees win?', raw }))).toBe('2');
    // title wins
    expect(gameOrdinalSpec.extract(ctx({ title: 'Game 4: Will the Yankees win?', raw }))).toBe('4');
    // no ticker threaded → unchanged NULL behaviour
    expect(gameOrdinalSpec.extract(ctx({ title: 'Will the Yankees win?', raw: null }))).toBe(null);
    // ticker present but not a doubleheader
    expect(gameOrdinalSpec.extract(ctx({
      title: 'Will the Yankees win?', raw: { event_ticker: 'KXMLBGAME-26JUL04NYYBOS' },
    }))).toBe(null);
  });

  test('the SQL twin carries the same arm, LAST, case-sensitively', () => {
    expect(GAME_ORDINAL_SQL_BODY).toContain("substring(t from '-G([1-9])(-|$)')");
    // it must sit AFTER the halftime arm (arm order mirrors parseGameOrdinal)
    expect(GAME_ORDINAL_SQL_BODY.indexOf("-G([1-9])"))
      .toBeGreaterThan(GAME_ORDINAL_SQL_BODY.indexOf('half[- ]?time'));
    // case-SENSITIVE: the ticker suffix arm must not use the ~* operator
    expect(GAME_ORDINAL_SQL_BODY).not.toContain("t ~* '-G([1-9])");
  });
});

describe('P5 (2) — player-prop metric_scope', () => {
  test('SEASON via the Kalshi series token', () => {
    expect(playerPropMetricScope('Will Aaron Judge record 30+ home runs?', 'KXMLBSEASONHR-26C20')).toBe('season');
    expect(playerPropMetricScope('x', 'KXNFLSEASONRECTD-27C10')).toBe('season');
  });

  test('SEASON via the win-total series suffix', () => {
    expect(playerPropMetricScope('x', 'KXNFLWINS-27ARI')).toBe('season');
    expect(playerPropMetricScope('x', 'KXMLBWINS-ATH-26')).toBe('season');
  });

  test('SEASON via title prose — the PM/Predict arm (no ticker published)', () => {
    expect(playerPropMetricScope('Will the Arizona pro football team win at least 10 games this season?', null))
      .toBe('season');
    expect(playerPropMetricScope('Will A.J. Brown record 10+ receiving touchdowns during the 2026-27 Pro Football regular season?', null))
      .toBe('season');
  });

  test('GAME via the day-precision ticker date segment', () => {
    expect(playerPropMetricScope('Aaron Judge: 1+ home runs?', 'KXMLBHR-26JUL101840MILPIT')).toBe('game');
    expect(playerPropMetricScope('Anthony Edwards: 20+ points', 'KXNBAPTS-26MAY10NYKPHI')).toBe('game');
    expect(playerPropMetricScope('Adrien Rabiot: 1+ goals', 'KXWCGOAL-26JUL10ESPBEL')).toBe('game');
  });

  test('THE KILL: the per-game and season home-run props no longer agree', () => {
    const game = playerPropMetricScope('Aaron Judge: 1+ home runs?', 'KXMLBHR-26JUL101840MILPIT');
    const season = playerPropMetricScope(
      'Will Aaron Judge record 30+ home runs during 2026 Pro Baseball regular season?',
      'KXMLBSEASONHR-26C20',
    );
    expect(game).toBe('game');
    expect(season).toBe('season');
    expect(game).not.toBe(season);
  });

  test('TOURNAMENT-scoped families stay NULL — an honest refusal beats a guess', () => {
    expect(playerPropMetricScope('3M Open: Will Aaron Wise finish top 10?', 'KXPGATOP10-3MO26')).toBe(null);
    expect(playerPropMetricScope('Will AJ Allmendinger finish in the top 5 at NASCAR Brickyard 400?', 'KXNASCARTOP5-BRI4PB26')).toBe(null);
    expect(playerPropMetricScope('Pro basketball top 10 draft picks in 2026?', 'KXNBADRAFTTOP-26-10')).toBe(null);
  });

  test('TOTAL — null/empty inputs never throw', () => {
    expect(playerPropMetricScope(null, null)).toBe(null);
    expect(playerPropMetricScope(undefined, undefined)).toBe(null);
    expect(playerPropMetricScope('', '')).toBe(null);
  });

  test('the spec routes player_prop_threshold to the P5 arm and everything else to the title parser', () => {
    expect(metricScopeSpec.extract(ctx({
      eventKind: 'player_prop_threshold',
      title: 'Aaron Judge: 1+ home runs?',
      raw: { event_ticker: 'KXMLBHR-26JUL101840MILPIT' },
    }))).toBe('game');
    // a non-prop kind is untouched by the P5 arm (title parser owns it)
    expect(metricScopeSpec.extract(ctx({
      eventKind: 'match_total_metric',
      title: 'Total goals in the match',
      raw: { event_ticker: 'KXMLBHR-26JUL101840MILPIT' },
    }))).toBe(null);
  });

  test('metric_scope gained the kind but keeps EVERY other property (no assertion flip)', () => {
    expect(metricScopeSpec.kinds).toContain('player_prop_threshold');
    // DEVIATION guard: flipping metric_scope's own NULL policy would move the
    // certifier's known+NULL demote for five unrelated kinds. It stays tolerant.
    expect(metricScopeSpec.nullPolicy).toBe('tolerant');
    expect(metricScopeSpec.assertion).toBe('fold-key');
    expect(metricScopeSpec.foldSurface).toBe('builder');
    expect(metricScopeSpec.gatedField).toBe('metric_scope');
  });

  test('the NULL-bridge block rides a SEPARATE guard-only, prop-scoped spec', () => {
    expect(getSpec('prop_metric_scope')).toBe(propMetricScopeSpec);
    expect(propMetricScopeSpec.nullPolicy).toBe('block-when-sibling-known');
    expect(propMetricScopeSpec.assertion).toBe('guard-only');
    expect(propMetricScopeSpec.gatedField).toBeUndefined();
    expect(propMetricScopeSpec.setSplit).toBeUndefined();
    // guard-only ⇒ Stage-4 fold surfaces are byte-identical
    expect(foldKeySpecs().map((s) => s.name)).not.toContain('prop_metric_scope');
    expect(coherenceSpecs().map((s) => s.name)).toContain('prop_metric_scope');
  });

  test('it mirrors metric_scope verbatim (one extractor, no second parser)', () => {
    const c = ctx({
      eventKind: 'player_prop_threshold',
      title: 'Aaron Judge: 1+ home runs?',
      raw: { event_ticker: 'KXMLBHR-26JUL101840MILPIT' },
    });
    expect(propMetricScopeSpec.extract(c)).toBe(metricScopeSpec.extract(c));
  });
});
