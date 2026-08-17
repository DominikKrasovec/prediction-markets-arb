/**
 * Stat vocabulary + title-regex extractor for the `stat_type` discriminator.
 *
 * `condition_metric` is too coarse to carry the statistical category of a
 * prop/total ('count' for nearly every player prop), and `value_unit` is
 * NULL for binary esports props and a non-stat marker ('rank','wins') for
 * finish-position / stat-leader rows. The only source that works across all
 * three carrying families is the title. This module lifts that title fact
 * to a single canonical token so the Stage-3 leg-coherence belt can refuse
 * a cross-stat fusion generically.
 *
 * The canonicalizer is reused verbatim from the shared emission-side
 * vocabulary ({@link normalizePlayerStatUnit}), so a captured surface folds
 * to the exact same canonical token the emission path stamps into
 * `value_unit`.
 *
 * Pure: no DB, no KB. Returns null on any doubt — an unrecognized stat
 * folds tolerantly, never manufacturing a conflict.
 */
import { normalizePlayerStatUnit } from '../stage1-normalize/event-name-normalizer.js';

/**
 * Surface stat spellings to scan the title for. Multi-word phrases MUST precede
 * a contained single word conceptually, but ordering is handled at regex-build
 * time (longest-surface-first) so 'home runs' wins over bare 'runs' and 'passing
 * yards' wins over bare 'yards' at the SAME start position. Every entry is a
 * genuine per-event statistical category — deliberately NOT 'rank' (finish
 * position) or 'wins' (win count), which are not stat categories and are handled
 * by other discriminators / gated fields.
 */
const STAT_SURFACES: readonly string[] = [
  // ── basketball / general box score ──
  'points',
  'rebounds',
  'assists',
  'blocks',
  'steals',
  'turnovers',
  'three pointers',
  'three-pointers',
  'threes',
  'double doubles',
  'triple doubles',
  // ── baseball ──
  'home runs',
  'total bases',
  'stolen bases',
  'strikeouts',
  'rbis', // 'runs batted in' folds to the same stat — 'rbis' is the canonical surface
  'triples',
  'doubles',
  'singles',
  'walks',
  'hits',
  'runs',
  'saves',
  // ── (american) football ──
  'passing yards',
  'rushing yards',
  'receiving yards',
  'passing touchdowns',
  'rushing touchdowns',
  'receiving touchdowns',
  'touchdowns',
  'receptions',
  'completions',
  'sacks',
  'interceptions',
  'tackles',
  'yards',
  // ── soccer ──
  'goals',
  'clean sheets',
  'yellow cards',
  'red cards',
  'corners',
  'cards',
  // ── esports ──
  'kills',
  'deaths',
  'maps',
  'rounds',
  'frames',
  // ── net / racquet sports ──
  'aces',
  'sets',
  'games',
  // ── cricket ──
  'wickets',
];

/** Escape a surface for a regex and allow flexible whitespace / hyphen between
 *  the words of a multi-word phrase ('three-pointers' ≡ 'three pointers'). */
function surfacePattern(s: string): string {
  return s
    .split(/[\s-]+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]+');
}

/** Longest-first so a multi-word phrase matches before a contained single word
 *  at the same start position. */
const STAT_RX = new RegExp(
  `\\b(${[...new Set(STAT_SURFACES)]
    .sort((a, b) => b.length - a.length)
    .map(surfacePattern)
    .join('|')})\\b`,
  'iu',
);

/**
 * Extract the canonical `stat_type` token from a market title, or null when no
 * stat noun is present. The FIRST stat surface found (left-to-right) wins, then
 * it is canonicalized through the shared {@link normalizePlayerStatUnit} so the
 * token matches the emission-path `value_unit` vocabulary byte-for-byte
 * ('three-pointers' → 'threes', 'home runs' → 'home_runs', 'goals' → 'goals').
 */
export function extractStatType(title: string | null | undefined): string | null {
  if (!title) return null;
  const m = STAT_RX.exec(title);
  if (!m) return null;
  // Empty fallback → an unrecognized/degenerate surface stays null (never '').
  const canon = normalizePlayerStatUnit(m[1]!.toLowerCase(), '');
  return canon ? canon : null;
}

/**
 * The closed set of canonical tokens {@link extractStatType} can emit — the
 * value space of the discriminator. Derived by folding every surface through the
 * shared canonicalizer (so it stays in lockstep with {@link STAT_SURFACES} and
 * the emission vocabulary). Exported for tests + diagnostics.
 */
export const STAT_CANON: ReadonlySet<string> = new Set(
  STAT_SURFACES.map((s) => normalizePlayerStatUnit(s, '')).filter((s): s is string => !!s),
);

/**
 * Emission `value_unit` tokens that are a statistical category and can serve
 * as the stat_type when the title itself carries no stat noun. STAT_CANON
 * plus stat units the title regex does not surface: 'strokes',
 * 'total_bases', 'hits_runs_rbis'. Deliberately excludes the non-stat
 * value_units — 'rank', 'wins', 'count', currencies/measures — so a
 * stat-leader's 'rank'/'wins' unit falls through to the title regex.
 */
export const STAT_VALUE_UNITS: ReadonlySet<string> = new Set<string>([
  ...STAT_CANON,
  'strokes',
  'total_bases',
  'hits_runs_rbis',
]);

/** The stat_type for an emission `value_unit`, or null when the unit is not a
 *  statistical category (rank/wins/count/currency → defer to the title). */
export function statTypeFromValueUnit(valueUnit: string | null | undefined): string | null {
  if (!valueUnit) return null;
  const u = valueUnit.trim().toLowerCase();
  return STAT_VALUE_UNITS.has(u) ? u : null;
}

/**
 * The resolved stat_type for a market: the emission `value_unit` when it is
 * a recognized stat, otherwise the TITLE stat (the load-bearing signal for
 * the stat-leader / binary-prop families whose value_unit is non-stat or
 * NULL). Null when neither yields a stat.
 */
export function resolveStatType(
  title: string | null | undefined,
  valueUnit: string | null | undefined,
): string | null {
  return statTypeFromValueUnit(valueUnit) ?? extractStatType(title);
}

/** Exported for table-driven tests + census probes. */
export const __TEST__ = { STAT_SURFACES, STAT_RX };
