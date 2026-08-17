/** Deterministic outcome-grain classifier; a mutex partition must not mix winner + exact-score + over/under grains (they co-occur). Pure, no DB/LLM. */
import { foldAscii } from '../db/entity/tokens.js';
import { parseBandInterval } from './numeric-band.js';

export type OutcomeGrain =
  | 'exact_score' | 'spread' | 'over_under' | 'conditional_matchup'
  | 'both_teams_score' | 'first_scorer' | 'numeric_band' | 'winner' | 'neutral';

// Complement outcome (Draw, No Goal, …), excluded from the grain count; matched on the whole token.
const NEUTRAL_OUTCOME_RX =
  /^(?:draw|tie|no[_ ]?goals?|no[_ ]?score|scoreless|neither|none|no[_ ]?winner|no[_ ]?result|any[_ ]?other(?:[_ ]?score)?|other)$/;

export function isNeutralGrain(g: OutcomeGrain): boolean {
  return g === 'neutral';
}

/** True for a ladder rung (over_under/spread): rungs co-resolve, so a set of them is never a mutex partition. */
export function isThresholdLikeGrain(g: OutcomeGrain): boolean {
  return g === 'over_under' || g === 'spread';
}

/** Deterministic grain from an outcome's KEY; first matching family wins (spread before exact_score, foldAscii first). */
export function classifyOutcomeAxisByKey(
  outcome_id: string,
  subject: string | null | undefined,
  label: string | null | undefined,
): OutcomeGrain {
  const parts = [outcome_id, subject, label]
    .filter((s): s is string => !!s && s.trim() !== '')
    .map((s) => foldAscii(s).toLowerCase());
  if (parts.length === 0) return 'winner';
  const blob = parts.join(' | ');
  if (parts.some((p) => NEUTRAL_OUTCOME_RX.test(p.trim()))) return 'neutral';
  if (/\bdefeats?\b|_defeats?_|\bbeats\b|_beats_/.test(blob)) return 'conditional_matchup';
  // BTTS must precede first_scorer, else "both_teams_score_first_half" misreads as an opening goal.
  if (/both[_ ]teams[_ ](?:to[_ ])?score|(?:^|[_ |])btts(?:[_ |]|$)/.test(blob)) return 'both_teams_score';
  if (/first[_ ](?:team|goal|scorer)|first[_ ]to[_ ]score|to[_ ]score[_ ]first|scores?[_ ]first(?![_ ](?:half|period|quarter|inning|set|leg))|opening[_ ]goal|first[_ ]blood/.test(blob)) return 'first_scorer';
  // Spread before exact_score; `wins?[ _]by` avoids `\bwins\b` false-firing on 'sd_wins_by'.
  if (/spread|wins?[ _]by|by[ _]\d+(?:\.\d+)?[ _](?:or[ _]more[ _])?goals?|by[ _]\d+\+|\(-\d|(?:^|[ _])-\d|minus[ _]\d/.test(blob)) return 'spread';
  if (/(?:^|[_ ])(?:over|under)[_ ]?\d|(?:^|[_ ])ou[_ ]?\d|o\/u|total[_ ]goals?|team[_ ]total/.test(blob)) return 'over_under';
  // Tested after spread/over_under, before exact_score (parseBandInterval refuses bare 1-2-digit pairs).
  if (parts.some((p) => parseBandInterval(p) !== null)) return 'numeric_band';
  if (/(?:^|[_ (|])\d{1,2}[_ \-]\d{1,2}(?:$|[_ )|])|\d{1,2}\s*-\s*\d{1,2}/.test(blob)) return 'exact_score';
  return 'winner';
}

/** Per-leg event_kind → grain (secondary, upgrade-only); unmapped kinds leave 'winner' in place. */
const EVENT_KIND_GRAIN: ReadonlyMap<string, OutcomeGrain> = new Map<string, OutcomeGrain>([
  ['exact_score', 'exact_score'],
  ['match_spread', 'spread'],
  ['election_margin', 'spread'],
  ['match_total_metric', 'over_under'],
  ['match_event_prop', 'over_under'],
  ['both_teams_score', 'both_teams_score'],
]);

/** Key-derived grain (primary), upgraded via leg event_kinds only when the key was ambiguous ('winner'). */
export function outcomeGrain(
  outcome_id: string,
  subject: string | null | undefined,
  label: string | null | undefined,
  legEventKinds: (string | null | undefined)[],
): OutcomeGrain {
  const g = classifyOutcomeAxisByKey(outcome_id, subject, label);
  if (g !== 'winner') return g;
  for (const k of legEventKinds) {
    const gk = k ? EVENT_KIND_GRAIN.get(k) : undefined;
    if (gk) return gk;
  }
  return 'winner';
}

// A scoreline in the value pair, or a phrase in the bare label, escapes classifyOutcomeAxisByKey's key-only read; both upgrades are upgrade-only.
const EXACT_SCORE_MAX = 20;

/** A (value_primary, value_secondary) scoreline: two small non-negative integers, capped so a seat/econ band never misreads as a score. */
function isScorelinePair(
  vp: number | string | null | undefined,
  vs: number | string | null | undefined,
): boolean {
  const a = typeof vp === 'number' ? vp : vp == null ? NaN : Number(vp);
  const b = typeof vs === 'number' ? vs : vs == null ? NaN : Number(vs);
  return (
    Number.isInteger(a) && Number.isInteger(b) &&
    a >= 0 && b >= 0 && a <= EXACT_SCORE_MAX && b <= EXACT_SCORE_MAX
  );
}

// Grain of a MARKET (not an outcome slot) from its raw title; abstains (null) rather than
// defaulting, since the key classifier's numeric families misread dates/weather buckets.
export const MEMBER_TITLE_GRAIN: ReadonlyArray<readonly [RegExp, OutcomeGrain]> = [
  [/\bboth\s+teams\s+to\s+score\b|\bbtts\b/, 'both_teams_score'],
  [/\bfirst\s+goal\b|\bopening\s+goal\b|\bfirst\s+blood\b|\bscores?\s+first\b|\bto\s+score\s+first\b|\bfirst\s+(?:team|player|side|club)\s+to\s+score\b|\bfirst\s+to\s+score\b|\brecords?\s+the\s+first\b/, 'first_scorer'],
  [/\bexact\s+score\b|\bcorrect\s+score\b|\bfinal\s+score\b|\bwins?\s+\d{1,2}\s*-\s*\d{1,2}\b|\bscore\s+be\b.*\d{1,2}\s*-\s*\d{1,2}/, 'exact_score'],
  [/\bspread\b|\bhandicap\b|\bmargin\s+of\s+victory\b|\brun\s+line\b|\bwins?\b[^?]*\bby\s+(?:over\s+|under\s+|more\s+than\s+|at\s+least\s+)?\d|\bby\s+\d+\+/, 'spread'],
  [/\b(?:over|under)\s+\d|\bo\/u\b|\btotal\s+(?:goals?|points?|runs?|corners?)\b/, 'over_under'],
  [/\bdefeats?\b|\bbeats\b/, 'conditional_matchup'],
  [/\bwinner\b|\bmoneyline\b|\bto\s+win\b|\bwins\b|\bwin\s+the\b/, 'winner'],
];

// Complement/null market; abstains (null) rather than claiming a grain.
export const MEMBER_TITLE_NEUTRAL_RX =
  /\bneither\b|\bno\s+goals?\b|\bno\s+one\b|\bnobody\b|\bscoreless\b|\bany\s+other\s+score\b|\bno\s+winner\b/;

/** Per-leg event_kind → member grain; a superset of EVENT_KIND_GRAIN including winner-family kinds. */
export const MEMBER_KIND_GRAIN: ReadonlyMap<string, OutcomeGrain> = new Map<string, OutcomeGrain>([
  ...EVENT_KIND_GRAIN,
  ['match_winner', 'winner'],
  ['halftime_leader', 'winner'],
  ['championship_winner', 'winner'],
  ['election_outcome_winner', 'winner'],
]);

/** Grain from a raw title; returns null (never a default) when no unambiguous idiom matches. */
export function classifyMemberGrainByTitle(title: string | null | undefined): OutcomeGrain | null {
  if (!title || title.trim() === '') return null;
  const t = foldAscii(title).toLowerCase();
  if (MEMBER_TITLE_NEUTRAL_RX.test(t)) return null;
  for (const [rx, grain] of MEMBER_TITLE_GRAIN) if (rx.test(t)) return grain;
  return null;
}

/** Title marker first, event_kind fallback only when the title abstains; null means unknown/compatible-with-everything. */
export function memberOutcomeGrain(
  title: string | null | undefined,
  event_kind: string | null | undefined,
): OutcomeGrain | null {
  const byTitle = classifyMemberGrainByTitle(title);
  if (byTitle !== null) return byTitle;
  return (event_kind ? MEMBER_KIND_GRAIN.get(event_kind) : undefined) ?? null;
}

/** Phrase-keyed grains a bare label may upgrade an ambiguous key to; numeric families (exact_score/spread/…) are excluded to avoid false-splitting on dates/buckets. */
const PHRASE_UPGRADE_GRAINS: ReadonlySet<OutcomeGrain> = new Set<OutcomeGrain>([
  'first_scorer', 'both_teams_score', 'conditional_matchup',
]);

/** The structured facts one outcome offers the grain classifier. */
export interface OutcomeGrainFacts {
  outcome_id: string;
  subject?: string | null | undefined;
  label?: string | null | undefined;
  event_kinds?: ReadonlyArray<string | null | undefined>;
  value_primary?: number | string | null | undefined;
  value_secondary?: number | string | null | undefined;
}

/** Grain from all deterministic facts, strongest evidence first (upgrade-only): key, leg event_kind, value-pair scoreline, then label phrase. */
export function outcomeGrainFromFacts(f: OutcomeGrainFacts): OutcomeGrain {
  const g = classifyOutcomeAxisByKey(f.outcome_id, null, null);
  if (g !== 'winner') return g;
  const kinds = f.event_kinds ?? [];
  for (const k of kinds) {
    const gk = k ? EVENT_KIND_GRAIN.get(k) : undefined;
    if (gk) return gk;
  }
  if (!kinds.some((k) => k != null && k !== '') && isScorelinePair(f.value_primary, f.value_secondary)) {
    return 'exact_score';
  }
  const gl = classifyOutcomeAxisByKey('', f.subject ?? null, f.label ?? null);
  if (PHRASE_UPGRADE_GRAINS.has(gl)) return gl;
  return 'winner';
}

/** Collapses a lone numeric_band bucket back into 'winner' when it's a count-tiling artifact, not a genuine second grain. */
export function effectiveRealGrains(counts: ReadonlyMap<OutcomeGrain, number>): Set<OutcomeGrain> {
  if (counts.size === 2) {
    const w = counts.get('winner');
    const nb = counts.get('numeric_band');
    if (w !== undefined && nb !== undefined && Math.min(w, nb) < 2) {
      return new Set<OutcomeGrain>([w >= nb ? 'winner' : 'numeric_band']);
    }
  }
  return new Set(counts.keys());
}

/** Distinct grains of a set's real (non-residual, non-neutral) slots, after the lone-bucket collapse; size > 1 means an unsound cross-grain fold. */
export function distinctRealGrains<T>(
  slots: ReadonlyArray<T>,
  grainOf: (s: T) => OutcomeGrain,
  isResidual: (s: T) => boolean,
): Set<OutcomeGrain> {
  const counts = new Map<OutcomeGrain, number>();
  for (const s of slots) {
    if (isResidual(s)) continue;
    const g = grainOf(s);
    if (isNeutralGrain(g)) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return effectiveRealGrains(counts);
}

/** TRUE iff the set's real slots span >1 outcome grain (an unsound cross-grain fold). */
export function grainsHeterogeneous<T>(
  slots: ReadonlyArray<T>,
  grainOf: (s: T) => OutcomeGrain,
  isResidual: (s: T) => boolean,
): boolean {
  return distinctRealGrains(slots, grainOf, isResidual).size > 1;
}

/** Splits a categorical fold into homogeneous per-grain groups; a ≤1-grain set is returned unpartitioned. */
export function partitionByGrain<T>(
  slots: ReadonlyArray<T>,
  grainOf: (s: T) => OutcomeGrain,
  isResidual: (s: T) => boolean,
): T[][] {
  if (distinctRealGrains(slots, grainOf, isResidual).size <= 1) return [slots.slice()];
  const order: OutcomeGrain[] = [];
  const byGrain = new Map<OutcomeGrain, T[]>();
  for (const s of slots) {
    const g = grainOf(s);
    let group = byGrain.get(g);
    if (!group) { group = []; byGrain.set(g, group); order.push(g); }
    group.push(s);
  }
  return order.map((g) => byGrain.get(g)!);
}
