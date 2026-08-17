/** `game_ordinal` discriminator: `parseGameOrdinal` (TS) and `game_ordinal(text)` (SQL)
 *  must keep identical arm order. NULL means "whole-match granularity" and never fuses with a value. */
import type { DiscriminatorSpec } from '../registry.js';

export const GAME_ORDINAL_RX = /\b(?:map|game|set|leg|frame)\s*#?\s*([1-9])\b/i;

const WORD_PERIOD_RX =
  /\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+(?:half|quarter|period|set|map|game|inning)\b/i;

const PERIOD_DIGIT_RX =
  /\b(?:half|quarter|period|inning)\s*#?\s*([1-9])\b|\b([1-9])(?:st|nd|rd|th)\s+(?:half|quarter|period|set|map|game|inning)\b/i;

const ABBREV_PERIOD_RX = /\b([1-4])(?:h|q)\b|\b(?:h|q)([1-4])\b/i;

/** Series-total guard: phrases that look ordinal-ish but are NOT a per-game ordinal. */
const SERIES_TOTAL_RX =
  /\btotal\s+(?:maps|games|sets)\b|\bbest\s+of\s+\d\b|\b(?:over|under)\s+[\d.]+\s+(?:maps|games|sets)\b/i;

/** A year-adjacent Q1-Q4/1H-2H/H1-H2 token marks a fiscal quarter, not a period marker. */
export const FISCAL_PERIOD_RX =
  /\b(?:q[1-4]|[1-4]h|h[1-4])\s+(?:of\s+)?(?:fy\s?)?(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\s+(?:q[1-4]|[1-4]h|h[1-4])\b/i;

/** POSIX twin of {@link FISCAL_PERIOD_RX}, shared with the equivalence-edge half-scope belt. */
export const FISCAL_PERIOD_RX_POSIX =
  `\\m(q[1-4]|[1-4]h|h[1-4])\\s+(of\\s+)?(fy\\s?)?(19|20)\\d{2}\\M|\\m(19|20)\\d{2}\\s+(q[1-4]|[1-4]h|h[1-4])\\M`;

/** Second fiscal arm: a bare fiscal token with no year, gated on a financial-metric noun. */
export const FISCAL_CONTEXT_RX =
  /\b(?:revenue|earnings|eps|gdp|cpi|margins?|sales|orders|report(?:s|ed)?|deliver(?:ies|ed)|shipments|subscribers|trips|profit|income|guidance|meeting)\b/i;

export const FISCAL_CONTEXT_RX_POSIX =
  `\\m(revenue|earnings|eps|gdp|cpi|margins?|sales|orders|report(s|ed)?|deliver(ies|ed)|shipments|subscribers|trips|profit|income|guidance|meeting)\\M`;

/** "first game of the 2028 season" is a deadline anchor, not a period ordinal. */
const SEASON_GAME_PROSE_RX =
  /\b(?:[1-9](?:st|nd|rd|th)|first|second|third|fourth)\s+(?:game|match)\s+of\s+the\s+(?:(?:19|20)\d{2}(?:[–-]\d{2,4})?\s+)?season\b/i;

const HALFTIME_MARKER_RX = /\bhalf[-\s]?time\b|\bat\s+(?:the\s+)?half\b/i;

/** Kalshi doubleheader ticker suffix: the two games share a byte-identical title,
 *  so only the ticker (case-sensitive, hyphen-anchored) distinguishes them. */
export const TICKER_GAME_ORDINAL_RX = /-G([1-9])(?=-|$)/;

const WORD_TO_N: Record<string, number> = {
  '1st': 1, first: 1,
  '2nd': 2, second: 2,
  '3rd': 3, third: 3,
  '4th': 4, fourth: 4,
};

export function parseGameOrdinal(text: string | null | undefined): number | null {
  if (!text) return null;
  if (SERIES_TOTAL_RX.test(text)) return null;
  const m = GAME_ORDINAL_RX.exec(text);
  if (m) return parseInt(m[1], 10);
  const seasonProse = SEASON_GAME_PROSE_RX.test(text);
  const w = WORD_PERIOD_RX.exec(text);
  if (w && !seasonProse) return WORD_TO_N[w[1].toLowerCase()] ?? null;
  const p = PERIOD_DIGIT_RX.exec(text);
  // p[2] = digit-ordinal-first form, the only branch that can be the season-deadline prose
  if (p && !(p[2] != null && seasonProse)) return parseInt(p[1] ?? p[2], 10);
  const ab = ABBREV_PERIOD_RX.exec(text);
  if (ab && !FISCAL_PERIOD_RX.test(text) && !FISCAL_CONTEXT_RX.test(text)) {
    return parseInt(ab[1] ?? ab[2], 10);
  }
  if (HALFTIME_MARKER_RX.test(text)) return 1;
  const g = TICKER_GAME_ORDINAL_RX.exec(text);
  if (g) return parseInt(g[1]!, 10);
  return null;
}

/** SQL twin of {@link parseGameOrdinal}; keep arm order identical. */
export const GAME_ORDINAL_SQL_BODY = `CASE
        WHEN t IS NULL THEN NULL
        WHEN t ~* '\\mtotal\\s+(maps|games|sets)\\M|\\mbest\\s+of\\s+[0-9]\\M|\\m(over|under)\\s+[0-9.]+\\s+(maps|games|sets)\\M'
          THEN NULL
        WHEN substring(t from '(?i)\\m(?:map|game|set|leg|frame)\\s*#?\\s*([1-9])\\M') IS NOT NULL
          THEN substring(t from '(?i)\\m(?:map|game|set|leg|frame)\\s*#?\\s*([1-9])\\M')::int
        WHEN t ~* '\\m(1st|first)\\s+(half|quarter|period|set|map|game|inning)\\M'
             AND NOT t ~* '\\m([1-9](st|nd|rd|th)|first|second|third|fourth)\\s+(game|match)\\s+of\\s+the\\s+((19|20)\\d{2}([–-]\\d{2,4})?\\s+)?season\\M'
          THEN 1
        WHEN t ~* '\\m(2nd|second)\\s+(half|quarter|period|set|map|game|inning)\\M'
             AND NOT t ~* '\\m([1-9](st|nd|rd|th)|first|second|third|fourth)\\s+(game|match)\\s+of\\s+the\\s+((19|20)\\d{2}([–-]\\d{2,4})?\\s+)?season\\M'
          THEN 2
        WHEN t ~* '\\m(3rd|third)\\s+(half|quarter|period|set|map|game|inning)\\M'
             AND NOT t ~* '\\m([1-9](st|nd|rd|th)|first|second|third|fourth)\\s+(game|match)\\s+of\\s+the\\s+((19|20)\\d{2}([–-]\\d{2,4})?\\s+)?season\\M'
          THEN 3
        WHEN t ~* '\\m(4th|fourth)\\s+(half|quarter|period|set|map|game|inning)\\M'
             AND NOT t ~* '\\m([1-9](st|nd|rd|th)|first|second|third|fourth)\\s+(game|match)\\s+of\\s+the\\s+((19|20)\\d{2}([–-]\\d{2,4})?\\s+)?season\\M'
          THEN 4
        WHEN substring(t from '(?i)\\m(?:half|quarter|period|inning)\\s*#?\\s*([1-9])\\M') IS NOT NULL
          THEN substring(t from '(?i)\\m(?:half|quarter|period|inning)\\s*#?\\s*([1-9])\\M')::int
        WHEN substring(t from '(?i)\\m([1-9])(?:st|nd|rd|th)\\s+(?:half|quarter|period|set|map|game|inning)\\M') IS NOT NULL
             AND NOT t ~* '\\m([1-9](st|nd|rd|th)|first|second|third|fourth)\\s+(game|match)\\s+of\\s+the\\s+((19|20)\\d{2}([–-]\\d{2,4})?\\s+)?season\\M'
          THEN substring(t from '(?i)\\m([1-9])(?:st|nd|rd|th)\\s+(?:half|quarter|period|set|map|game|inning)\\M')::int
        WHEN substring(t from '(?i)\\m([1-4])(?:h|q)\\M') IS NOT NULL
             AND NOT t ~* '\\m(q[1-4]|[1-4]h|h[1-4])\\s+(of\\s+)?(fy\\s?)?(19|20)\\d{2}\\M|\\m(19|20)\\d{2}\\s+(q[1-4]|[1-4]h|h[1-4])\\M'
             AND NOT t ~* '\\m(revenue|earnings|eps|gdp|cpi|margins?|sales|orders|report(s|ed)?|deliver(ies|ed)|shipments|subscribers|trips|profit|income|guidance|meeting)\\M'
          THEN substring(t from '(?i)\\m([1-4])(?:h|q)\\M')::int
        WHEN substring(t from '(?i)\\m(?:h|q)([1-4])\\M') IS NOT NULL
             AND NOT t ~* '\\m(q[1-4]|[1-4]h|h[1-4])\\s+(of\\s+)?(fy\\s?)?(19|20)\\d{2}\\M|\\m(19|20)\\d{2}\\s+(q[1-4]|[1-4]h|h[1-4])\\M'
             AND NOT t ~* '\\m(revenue|earnings|eps|gdp|cpi|margins?|sales|orders|report(s|ed)?|deliver(ies|ed)|shipments|subscribers|trips|profit|income|guidance|meeting)\\M'
          THEN substring(t from '(?i)\\m(?:h|q)([1-4])\\M')::int
        WHEN t ~* '\\mhalf[- ]?time\\M|\\mat\\s+(the\\s+)?half\\M' THEN 1
        WHEN substring(t from '-G([1-9])(-|$)') IS NOT NULL
          THEN substring(t from '-G([1-9])(-|$)')::int
        ELSE NULL
      END`;

export const gameOrdinalSpec: DiscriminatorSpec = {
  name: 'game_ordinal',
  kinds: 'all',
  source: 'title-regex',
  extract: (ctx) => {
    const o = parseGameOrdinal(ctx.title);
    if (o != null) return String(o);
    const ticker = ctx.raw != null ? ctx.raw['event_ticker'] : null;
    if (typeof ticker !== 'string' || ticker === '') return null;
    const t = TICKER_GAME_ORDINAL_RX.exec(ticker);
    return t == null ? null : t[1]!;
  },
  sqlExtract: 'game_ordinal(<title>)',
  assertion: 'fold-key',
  nullPolicy: 'strict',
  foldSurface: 'identity',
};
