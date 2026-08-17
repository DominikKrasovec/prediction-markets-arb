// Deterministic metric_scope parser (Stage 1). NULL is load-bearing: a title with no scope
// signal must stay NULL, never 'game', so the NULL-tolerant cross-question edge gate can
// still merge it with a stamped Kalshi 'game' total.
import { type MetricScope } from '@arb/types';

// First-match-wins; team-total is checked first since a team-total title can also carry
// half/inning qualifiers that would otherwise match a later rule.
const TEAM_TOTAL_SCORE_RX = /^\s*will\s+.+\s+score\s+(?:over|under)\b/i;
const TEAM_TOTAL_PHRASE_RX = /\bteam\s+total\b/i;

// KXMLBF3/F5/F7 are three INDEPENDENT cut-points, never a ladder (tied after 3 does not
// imply tied after 7) — each mark keeps its own scope, never borrowed from a neighbor.
const FIRST_N_INNINGS_RX = /\bfirst\s*(?<n>[0-9]+)\s*innings?\b/i;
const FIRST_N_INNINGS_SCOPES: Readonly<Record<string, MetricScope>> = {
  '3': 'first_3', '5': 'first_5', '7': 'first_7',
};
const F5_SHORTHAND_RX = /\bf5\b/i;

const HALF_1_RX = /\b1st\s+half\b|\bfirst\s+half\b|\b1h\b/i;
const HALF_2_RX = /\b2nd\s+half\b|\bsecond\s+half\b|\b2h\b/i;

const QUARTER_RX = /\b(?:1st|2nd|3rd|4th|first|second|third|fourth)\s+quarter\b|\bquarter\b|\bq[1-4]\b/i;

const SET_RX = /\bset\s*#?\s*[1-9]\b/i;

const MAP_RX = /\bmap\s*#?\s*[1-9]\b/i;

const SERIES_RX = /\btotal\s+maps\b|\bgames\s+total\b|\bmaps\s+(?:be\s+)?played\b/i;

export function parseMetricScopeFromTitle(
  title: string | null | undefined,
): MetricScope | null {
  if (!title) return null;

  if (TEAM_TOTAL_SCORE_RX.test(title) || TEAM_TOTAL_PHRASE_RX.test(title)) return 'team';

  const innings = FIRST_N_INNINGS_RX.exec(title);
  if (innings?.groups?.n) {
    const scope = FIRST_N_INNINGS_SCOPES[innings.groups.n];
    if (scope) return scope;
  }
  if (F5_SHORTHAND_RX.test(title)) return 'first_5';

  if (HALF_1_RX.test(title)) return 'half_1';
  if (HALF_2_RX.test(title)) return 'half_2';

  if (QUARTER_RX.test(title)) return 'quarter';

  if (SET_RX.test(title)) return 'set';

  if (MAP_RX.test(title)) return 'map';

  if (SERIES_RX.test(title)) return 'series';

  return null;
}

// The Kalshi ticker names the slice with zero spelling drift, so it's the stronger signal.
// EXACT prefix match (not a regex): the corpus also carries KXMLBFASTPITCH/KXMLBFTGAME
// under the KXMLBF stem, which a loose /^KXMLBF(\d)/ rule would mis-stamp.
const KALSHI_SERIES_METRIC_SCOPE: Readonly<Record<string, MetricScope>> = {
  KXMLBF3: 'first_3',
  KXMLBF5: 'first_5',
  KXMLBF7: 'first_7',
  KXMLBF5SPREAD: 'first_5',
  KXMLBF5TOTAL: 'first_5',
};

// Prefix is everything before the first '-', matching the SQL idiom
// split_part(raw->>'event_ticker','-',1) — keep the two in sync.
export function metricScopeFromKalshiSeries(
  eventTicker: string | null | undefined,
): MetricScope | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split('-', 1)[0]?.toUpperCase();
  if (!prefix) return null;
  return KALSHI_SERIES_METRIC_SCOPE[prefix] ?? null;
}
