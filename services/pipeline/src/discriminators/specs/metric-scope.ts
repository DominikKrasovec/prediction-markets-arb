/**
 * Registry entry — `metric_scope`. A tolerant wrap of the existing
 * stage1-normalize/metric-scope.ts parser.
 *
 * `extract` delegates to `parseMetricScopeFromTitle` rather than
 * reimplementing it, so the dual-write to the typed `metric_scope` column
 * stays a no-op on rows the existing handler already stamps.
 *
 * `nullPolicy: 'tolerant'` matches the shipped `bothKnownDifferSql` idiom the
 * Stage-4 builders already use (refuse only both-known-and-differ; a NULL
 * side always passes). `foldSurface: 'builder'` because metric_scope is a
 * within-fixture slice gate the specific builders apply — not an
 * event-identity gate.
 */
import type { EventKind } from '@arb/types';
import { parseMetricScopeFromTitle } from '../../stage1-normalize/metric-scope.js';
import type { DiscriminatorSpec, ExtractCtx } from '../registry.js';

/** The event_kinds that carry metric_scope; `player_prop_threshold` is
 *  handled by the player-prop arm below. Stamping is a no-op elsewhere, so
 *  the dual-write cannot change the typed column for any other kind. */
const METRIC_SCOPE_KINDS: readonly EventKind[] = [
  'match_total_metric',
  'match_winner',
  'halftime_leader',
  'match_spread',
  'exact_score',
  'player_prop_threshold',
];

/**
 * Player-prop scope.
 *
 * `player_prop_threshold` carries no metric_scope by default. Without one, a
 * per-game prop and a season prop agree on every other typed field and fold
 * into one question, even though a single-game line and a full-season line
 * are not rungs of one variable.
 *
 * The discriminator is structural on Kalshi and textual elsewhere:
 *   · season — the series carries a `SEASON` token, a `WINS` suffix, or the
 *     title says so in prose.
 *   · game — the event ticker carries a day-precision date segment.
 *   · null — everything else, deliberately: a tournament-scoped prop is
 *     neither 'game' nor 'season'. The block-when-sibling-known policy below
 *     makes null safe.
 *
 * Order: season signals win. They are disjoint from the day-date signal on
 * live data, so the order is defensive rather than load-bearing.
 */
const SEASON_TICKER_RX = /SEASON|WINS(?=-|$)/;
const SEASON_TITLE_RX =
  /\b(?:this|the)\s+(?:\d{4}(?:[–-]\d{2,4})?\s+)?(?:[\p{L}\s]{0,24}?\s)?(?:regular\s+)?season\b|\bduring\s+(?:the\s+)?\d{4}(?:[–-]\d{2,4})?\b|\bregular\s+season\b/iu;
/** Kalshi day-precision ticker segment: `-YYMonDD…` (mirrors the event-date extractor). */
const TICKER_DAY_DATE_RX = /-\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}/;

/** The player-prop scope arm. Pure + total; null on any doubt. */
export function playerPropMetricScope(
  title: string | null | undefined,
  eventTicker: string | null | undefined,
): 'game' | 'season' | null {
  const ticker = typeof eventTicker === 'string' ? eventTicker.toUpperCase() : '';
  const t = title ?? '';
  if (ticker !== '' && SEASON_TICKER_RX.test(ticker)) return 'season';
  if (SEASON_TITLE_RX.test(t)) return 'season';
  if (ticker !== '' && TICKER_DAY_DATE_RX.test(ticker)) return 'game';
  return null;
}

function extractMetricScope(ctx: ExtractCtx): string | null {
  if (ctx.eventKind === 'player_prop_threshold') {
    const ticker = ctx.raw != null ? ctx.raw['event_ticker'] : null;
    return playerPropMetricScope(ctx.title, typeof ticker === 'string' ? ticker : null);
  }
  // Wraps the existing parser verbatim for the original five kinds — no
  // reimplementation, so their stamp stays byte-identical.
  return parseMetricScopeFromTitle(ctx.title);
}

export const metricScopeSpec: DiscriminatorSpec = {
  name: 'metric_scope',
  kinds: METRIC_SCOPE_KINDS,
  // The player-prop arm reads the Kalshi event_ticker from ctx.raw; the
  // original five kinds still take the title-regex path inside `extract`.
  source: 'native-metadata',
  extract: extractMetricScope,
  gatedField: 'metric_scope',
  assertion: 'fold-key',
  // Kept 'tolerant' rather than block-when-sibling-known: flipping it here
  // would change the certifier's known+NULL sum=1 demote for all six kinds.
  // The NULL-bridge block for player props is carried by a separate
  // guard-only entry below instead.
  nullPolicy: 'tolerant',
  foldSurface: 'builder',
};

/**
 * Companion entry — the null-bridge belt for player props only.
 *
 * Guard-only, so it is excluded from `foldKeySpecs()` / `setSplitSpecs()` and
 * the Stage-4 fold-SQL stays byte-identical. It joins `coherenceSpecs()`:
 * `block-when-sibling-known` makes the Stage-3 leg-coherence belt drop a
 * scope-NULL prop leg entering a fusion whose sibling leg carries a known
 * scope — a tournament-scoped prop honestly stamps NULL, and under a
 * tolerant fold a NULL side always passes, so it would otherwise bridge into
 * a game-scoped question purely because its own scope is unreadable.
 *
 * Mirrors `metric_scope`'s value verbatim (one extractor, no second parser).
 */
export const propMetricScopeSpec: DiscriminatorSpec = {
  name: 'prop_metric_scope',
  kinds: ['player_prop_threshold'],
  source: 'native-metadata',
  extract: extractMetricScope,
  // JSONB-only: metric_scope's own dual-write already owns the typed column.
  assertion: 'guard-only',
  nullPolicy: 'block-when-sibling-known',
};
