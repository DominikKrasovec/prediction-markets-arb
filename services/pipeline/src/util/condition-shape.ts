// Shared condition_shape/direction/unit vocabulary — stage3 and stage4 must fold the same way.

/** Snapshot-style shapes ("where is the value AT the defined moment"). */
export const SNAPSHOT_SHAPES: ReadonlySet<string> = new Set([
  'point_in_time',
  'range_snapshot',
  'price_snapshot',
]);

// Emitted from the TS set so SQL gates can never drift from the vocabulary.
export function snapshotShapesSql(): string {
  return `(${[...SNAPSHOT_SHAPES].map((s) => `'${s}'`).join(',')})`;
}

// Numeric-value shapes (non-NULL value_primary is part of the outcome's identity).
export function numericValueShapesSql(): string {
  const shapes = ['monotonic_threshold', ...SNAPSHOT_SHAPES, 'cumulative_deadline'];
  return `(${shapes.map((s) => `'${s}'`).join(',')})`;
}

// NULL-tolerant by construction: a NULL shape matches neither arm, so unknown never refuses.
export function touchVsSnapshotConflictSql(a: string, b: string): string {
  return `NOT (
         (${a} = 'monotonic_threshold' AND ${b} IN ${snapshotShapesSql()})
         OR
         (${b} = 'monotonic_threshold' AND ${a} IN ${snapshotShapesSql()})
       )`;
}

export type ShapeClass = 'touch' | 'snapshot' | 'binary' | 'categorical' | 'cumulative';

// touch = metric EVER crosses the bound; snapshot = value in the region AT one moment.
export function shapeClassOf(shape: string | null | undefined): ShapeClass | null {
  if (shape == null || shape === '') return null;
  switch (String(shape).toLowerCase()) {
    case 'monotonic_threshold': return 'touch';
    case 'point_in_time':
    case 'range_snapshot':
    case 'price_snapshot':      return 'snapshot';
    case 'cumulative_deadline': return 'cumulative';
    case 'binary_event':        return 'binary';
    case 'categorical_outcome': return 'categorical';
    default: return null;
  }
}

export function foldDirectionClass(d: string | null | undefined): string | null {
  if (d == null || d === '') return null;
  switch (d.toLowerCase()) {
    case 'above': case 'greater': case 'greater_or_equal': return 'above';
    case 'below': case 'less': case 'less_or_equal': return 'below';
    case 'at': case 'equal': return 'at';
    default: return d.toLowerCase();
  }
}

export function dirPartitionClass(
  d: string | null | undefined,
): 'above' | 'below' | 'between' | 'at' | null {
  const c = foldDirectionClass(d);
  return c === 'above' || c === 'below' || c === 'between' || c === 'at' ? c : null;
}

/** Lower-cased, trimmed unit; '' → null. */
export function foldUnit(u: string | null | undefined): string | null {
  if (u == null) return null;
  const t = u.trim().toLowerCase();
  return t === '' ? null : t;
}

/** 'goal' ≡ 'goals' (handlers disagree on plurality); everything else must fold-equal. */
export function unitsEquivalent(a: string, b: string): boolean {
  return a === b || `${a}s` === b || a === `${b}s`;
}

// Integer-grain units; continuous quantities (usd, percent, bps, yards) are absent on purpose.
export const INTEGER_GRAIN_UNITS: ReadonlySet<string> = new Set([
  'fahrenheit', 'celsius', 'degree', 'degrees',
  'goal', 'goals', 'point', 'points', 'kill', 'kills', 'run', 'runs',
  'win', 'wins', 'game', 'games', 'map', 'maps', 'set', 'sets',
  'corner', 'corners', 'card', 'cards', 'stroke', 'strokes',
  'rebound', 'rebounds', 'hit', 'hits', 'assist', 'assists',
  'strikeout', 'strikeouts', 'home_run', 'home_runs', 'total_base', 'total_bases',
  'three', 'threes', 'steal', 'steals', 'block', 'blocks',
  'vote', 'votes', 'seat', 'seats', 'rank', 'medal', 'medals',
  'tornado', 'tornadoes', 'passenger', 'passengers', 'hits_runs_rbis',
  'tweet', 'tweets', 'post', 'posts', 'bill', 'bills', 'justice', 'justices',
  'cut', 'cuts', 'pardon', 'pardons', 'state', 'states',
  'executive_order', 'executive_orders', 'primary_loss', 'primary_losses',
  'job', 'jobs',
  'view', 'views', 'time', 'times',
  'unit', 'units',
  'receiving_yards', 'passing_yards', 'rushing_yards',
  'save', 'saves', 'walk', 'walks', 'stolen_base', 'stolen_bases',
  'rbi', 'rbis', 'touchdown', 'touchdowns', 'double', 'doubles',
  'rushing_touchdown', 'rushing_touchdowns',
  'receiving_touchdown', 'receiving_touchdowns',
  'reception', 'receptions',
  'case', 'cases',
]);

// Emitted from the TS set (same discipline as snapshotShapesSql) so it can never drift.
export function integerGrainUnitsSql(): string {
  return `(${[...INTEGER_GRAIN_UNITS].map((u) => `'${u}'`).join(',')})`;
}

// Integer-grain units with a natural floor at 0. Temperatures/rank are integer-grain but
// excluded here (temperature goes negative; rank floors at 1 with a bounded domain).
export const NONNEGATIVE_COUNT_UNITS: ReadonlySet<string> = new Set(
  [...INTEGER_GRAIN_UNITS].filter(
    (u) => !['fahrenheit', 'celsius', 'degree', 'degrees', 'rank'].includes(u),
  ),
);

// Distinct from NONNEGATIVE_COUNT_UNITS ("floor at 0"): this answers "never decreases",
// which the touch ≡ terminal exemption requires.
export const MONOTONE_COUNT_UNITS: ReadonlySet<string> = new Set(NONNEGATIVE_COUNT_UNITS);

// Units whose axis is PROVABLY floored at 0 — the counts, plus the two continuous
// magnitude units the live corpus carries (a vote share and a margin of victory are
// magnitudes; neither can be negative). Read by isSoundNumericTiling: a tiling on such
// an axis whose lowest bucket already starts at (or below) 0 needs no `below` leg,
// because there is no world under the floor to leave uncovered.
//   NOT included: 'usd'/'jpy' (a currency axis is a price here but a signed P&L or
//   delta elsewhere, and the proven fake — Kalshi BNB 760..775+ — is exactly a usd
//   tiling), and the temperature/rank units NONNEGATIVE_COUNT_UNITS already drops.
export const NONNEGATIVE_MAGNITUDE_UNITS: ReadonlySet<string> = new Set([
  ...NONNEGATIVE_COUNT_UNITS,
  'percent', 'percentage point', 'percentage points',
]);

export type ComparatorClass =
  | { kind: 'touch'; direction: 'above' | 'below' }
  | { kind: 'snapshot'; direction: 'above' | 'below' | 'at' }
  | { kind: 'ambiguous'; direction: 'above' | 'below' | null }; // caller MUST resolve from context/oracle

export interface ComparatorCtx {
  snapshotAnchor?: boolean;
  // Alone this is INSUFFICIENT to resolve a bounded word.
  deadlineAnchor?: boolean;
  monotoneMetric?: boolean;
}

const DIR_BELOW_WORDS =
  /↓|<|≤|＜|\b(?:below|under|lower|less|fewer|low|falls?|fell|drops?|dropped|dips?|dipped)\b/i;
const DIR_ABOVE_WORDS =
  /↑|>|≥|\b(?:above|over|higher|more|greater|high|exceed(?:s|ed)?|reach(?:es|ed)?|hits?|cross(?:es|ed)?|breaks?|broke|tops?|topped|surpass(?:es|ed)?)\b/i;

export function verbDirection(s: string | null | undefined): 'above' | 'below' | null {
  if (s == null || s === '') return null;
  if (DIR_BELOW_WORDS.test(s)) return 'below';
  if (DIR_ABOVE_WORDS.test(s)) return 'above';
  return null;
}

// snapshotAnchor -> snapshot; monotoneMetric -> touch ≡ terminal so PREFER snapshot;
// deadlineAnchor alone stays ambiguous (resolve from the resolution source, not phrasing).
function resolveBounded(direction: 'above' | 'below', ctx?: ComparatorCtx): ComparatorClass {
  if (ctx?.snapshotAnchor) return { kind: 'snapshot', direction };
  if (ctx?.monotoneMetric) return { kind: 'snapshot', direction };
  return { kind: 'ambiguous', direction };
}

// Returns null for phrases outside the lexicon (caller falls back to its own handling).
export function classifyComparatorPhrase(
  phrase: string | null | undefined,
  ctx?: ComparatorCtx,
): ComparatorClass | null {
  if (phrase == null) return null;
  const p = phrase.trim().replace(/\s+/g, ' ');
  if (p === '') return null;

  const wm = /\((high|low)\)\s*$/i.exec(p);
  if (wm) return { kind: 'touch', direction: wm[1]!.toLowerCase() === 'high' ? 'above' : 'below' };

  if (p.includes('↑')) return { kind: 'touch', direction: 'above' };
  if (p.includes('↓')) return { kind: 'touch', direction: 'below' };

  const settle =
    /\b(?:close[sd]?|settles?|settled|finish(?:es|ed)?|end(?:s|ed)?)\b.*?\b(above|below)\b/i.exec(p);
  if (settle) {
    return { kind: 'snapshot', direction: settle[1]!.toLowerCase() === 'above' ? 'above' : 'below' };
  }

  if (/\b(?:dips?|dipped|dip to|falls? to|fell to|drops? to|dropped to)\b/i.test(p)) {
    return { kind: 'touch', direction: 'below' };
  }

  if (/\b(?:reach(?:es)?|hits?|exceeds?|cross(?:es)?|breaks?|tops?|surpass(?:es)?|touch(?:es)?)\b/i.test(p)) {
    return { kind: 'touch', direction: 'above' };
  }

  if (
    /\bat least\b/i.test(p) || /\bor (?:more|higher)\b/i.test(p) ||
    /\b(?:more|greater) than\b/i.test(p) || /\bover\b/i.test(p) ||
    /[≥>]/.test(p) || /\babove\b/i.test(p) || /\+\s*$/.test(p)
  ) {
    return resolveBounded('above', ctx);
  }

  if (
    /\bat most\b/i.test(p) || /\bor (?:less|fewer|lower)\b/i.test(p) ||
    /\b(?:less|fewer) than\b/i.test(p) || /\bunder\b/i.test(p) ||
    /[≤<＜]/.test(p) || /\bbelow\b/i.test(p)
  ) {
    return resolveBounded('below', ctx);
  }

  if (/^(?:be at|at)\b/i.test(p) || /^be\b/i.test(p)) {
    return { kind: 'snapshot', direction: 'at' };
  }

  return null;
}

// Each entry pins current live-template behavior; never resolve inside a port — removing
// an entry needs its own change with cross-platform flips synchronized.
export const LEXICON_EXCEPTIONS: ReadonlyArray<{
  tag: string;
  verbs: RegExp;
  pinned: 'touch' | 'snapshot';
  ticket: string;
  reason: string;
}> = [
  {
    tag: 'limitless:econ-above',
    verbs: /\b(?:above|hit)\b/i,
    pinned: 'touch',
    ticket: 'A2',
    reason:
      'bare above-blank ladder (EIA jet fuel / DC revenue / ground beef / USD-ILS): rule 4 ambiguous, ' +
      'single-platform, UNSURE — same research bucket as the deferred STOCK_HIT_POSTHL isPct oracle ' +
      'question (survey O4).',
  },
  {
    tag: 'text-deterministic-A',
    verbs: /\bhits?\b/i,
    pinned: 'snapshot',
    ticket: 'O4-isPct',
    reason:
      "domain=percent-watermark: '%' postfix-(HIGH/LOW) rows deliberately stamp the Kalshi " +
      'how-HIGH/LOW ladder contract (point_in_time/percentage/percent) so cross-platform rungs merge; ' +
      '$/FX rows keep touch.',
  },
];
