// Deterministic validation guards for the Stage 3b LLM event-match output. Pure,
// no DB/I/O. Verdicts: 'match' (persist), 'no_match' (mark 'skipped'), 'reject' (mark 'failed').
import { numericRegionConflict, foldDirectionClass, type NumericRegionFacts } from './numeric-region.js';
import { precisionRank, grainKeyAt, dayGrainKey, exactTimestampKey } from '../util/date-grain.js';
import { EVENING_DAY_SHIFT_MAX_UTC_HOUR } from '../util/date-grain-sql.js';
import {
  FIXTURE_START_KINDS,
  ambiguousEveningConflict,
  fixtureStartInstantMs,
  fixtureStartInstantsDiverge,
  type FixtureInstantFacts,
} from '../util/fixture-instant.js';
import { extractStationPhrase, extractWeatherOracle } from '../stage1-normalize/weather-stations.js';
import { looksCorrectScoreLabel } from '../stage1-normalize/kalshi-series.js';
import { placeholderSlotsInSet, isOmegaPlaceholderSlot, isFixturePlaceholderSubject } from '../util/placeholder-outcomes.js';
import { discriminatorCoherenceDrops } from '../discriminators/coherence.js';
import { coherenceSpecs, type DiscriminatorSpec } from '../discriminators/registry.js';
import { beltHit } from '../discriminators/telemetry.js';
import { foldAscii } from '../db/entity/tokens.js';
import { type OutcomeGrain, classifyOutcomeAxisByKey, outcomeGrain, effectiveRealGrains } from '../util/outcome-grain.js';
import { canonicalizeKalshiStrike } from '../util/threshold-canonical.js';
import { idiomsAgree, type IdiomCtx } from './idioms/label-expansion.js';

export interface OutcomeSetItem {
  outcome_id: string;
  label: string;
  outcome_subject?: string | null;
  is_residual?: boolean;
  ordinal?: number | null;
}

export interface LegMappingItem {
  outcome_id: string;
  platform: string;
  market_id: number;
}

export interface EventMatchResult {
  same_event: boolean;
  confidence: number;
  reasoning: string;
  canonical_event?: string;
  canonical_subject?: string | null;
  participants?: string[];
  grouping_kind?: 'categorical_exclusive' | 'threshold_series' | 'bundle_nonexclusive';
  outcome_set?: OutcomeSetItem[];
  leg_mapping?: LegMappingItem[];
  completeness?: { a_complete?: boolean; b_complete?: boolean; notes?: string };
  deadline_window_iso?: [string, string];
}

export interface MatchContext {
  minConfidence: number;

  marketPlatform: Map<number, string>;

  marketScope: Map<number, string | null>;
  marketSport?: Map<number, string | null>;
  subjectType?: Map<string, string | null>;
  subjectParty?: Map<string, string | null>;
  marketSubject?: Map<number, string | null>;
  marketEventKind?: Map<number, string | null>;
  priorLegSubjects?: (string | null)[];
  priorLegEventKinds?: (string | null)[];
  /** Legs already bound to the SE being expanded, for cross-pair accretion checks; absent on a fresh create. */
  priorLegs?: {
    outcome_id: string;
    outcome_subject: string | null;
    market_id: number;
    metric_scope?: string | null;
    canonical_event?: string | null;
    event_kind?: string | null;
    market_canonical_event?: string | null;
    condition_date?: string | null;
    condition_date_precision?: string | null;
    title?: string | null;
    kalshi_series?: string | null;
    platform?: string | null;
    platform_event_id?: number | null;
  }[];
  marketPlatformEvent?: Map<number, number | null>;
  reconcileMetricScope?: Map<number, string | null>;
  newCanonicalEvent?: string | null;

  reconcileEnabled?: boolean;
  marketNumeric?: Map<number, NumericRegionFacts>;
  marketWeather?: Map<number, { text: string | null; subject: string | null }>;
  marketSettlementDimension?: Map<number, string | null>;
  marketDates?: Map<number, {
    condition_date: string | null;
    condition_date_precision?: string | null;

    end_date?: string | null;
  }>;
  marketNativeLabel?: Map<number, string | null>;
  marketNativeOutcomes?: Map<number, string[] | null>;
  marketCanonicalEvent?: Map<number, string | null>;
  marketTitle?: Map<number, string | null>;
  marketKalshiSeries?: Map<number, string | null>;
  marketDiscriminators?: Map<number, Record<string, string>>;
}

// Anonymized placeholder labels; "team" excluded — "Team USA"/"Team GB" are real entities.
const PLACEHOLDER_RX =
  /^(?:[a-z]|(?:candidate|option|choice|contestant|player)\s*#?\s*[a-z0-9]{1,3})$/i;
function isPlaceholderSubject(s: string | null | undefined): boolean {
  return !!s && PLACEHOLDER_RX.test(s.trim());
}

// Temporal/deadline vocabulary — a subject of only these tokens names no real subject.
const TEMPORAL_TOKENS = new Set<string>([
  'before', 'by', 'after', 'until', 'till', 'through', 'thru', 'end', 'of', 'in',
  'on', 'the', 'to', 'at', 'and', 'early', 'late', 'mid', 'eoy', 'ytd',
  'q1', 'q2', 'q3', 'q4', 'h1', 'h2',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december',
  'st', 'nd', 'rd', 'th', 'day', 'week', 'month', 'year', 'eod',
]);
/** True iff `s` names no real subject (null/empty, or every alphabetic token is temporal/deadline). */
export function isDeadlineOnlySubject(s: string | null | undefined): boolean {
  if (!s || s.trim() === '') return true;
  const alpha = foldAscii(s).toLowerCase().match(/[a-z]+/g);
  if (!alpha || alpha.length === 0) return true;
  return alpha.every((t) => TEMPORAL_TOKENS.has(t));
}

/** Distinct-subject count tolerant of KB alias drift (prefix/suffix-run duplicates collapse). */
function normSubject(s: string): string {
  // foldAscii first, else e.g. "Mönchengladbach" → "m nchengladbach" (ö → space).
  return foldAscii(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function isPrefixOrSuffixRun(big: string[], small: string[]): boolean {
  if (small.length === 0 || small.length > big.length) return false;
  let pre = true;
  for (let j = 0; j < small.length; j++) if (big[j] !== small[j]) { pre = false; break; }
  if (pre) return true;
  const off = big.length - small.length;
  for (let j = 0; j < small.length; j++) if (big[off + j] !== small[j]) return false;
  return true;
}
export function countDistinctSubjects(subjects: Iterable<string>): number {
  const arr = [...new Set([...subjects].map(normSubject))].filter(Boolean);
  const parent = arr.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const words = arr.map((s) => s.split(' '));
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (isPrefixOrSuffixRun(words[i], words[j]) || isPrefixOrSuffixRun(words[j], words[i])) {
        parent[find(i)] = find(j);
      }
    }
  }
  return new Set(arr.map((_, i) => find(i))).size;
}

/** Digit-form count-distribution bucket token (0, 1, 2, …, "4_or_more", "5+", "at least 5"). */
const COUNT_BUCKET_RX =
  /^(?:\d+|\d+\s*\+|\d+[_\s]*or[_\s]*more|(?:exactly|at[_\s]*least|at[_\s]*most|fewer[_\s]*than|less[_\s]*than|more[_\s]*than|over|under|up[_\s]*to)[_\s]*\d+)$/i;
export function isCountBucketToken(s: string | null | undefined): boolean {
  return !!s && COUNT_BUCKET_RX.test(s.trim());
}

/** Spelled-out sibling of COUNT_BUCKET_RX ("zero"…"twenty", optionally "or more"); "no"/"none" excluded (collide with bare yes/NO). */
const SPELLED_COUNT_BUCKET_RX =
  /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?:[_\s]+or[_\s]+more)?(?:[_\s].+)?$/i;
export function isSpelledCountBucketToken(s: string | null | undefined): boolean {
  return !!s && SPELLED_COUNT_BUCKET_RX.test(s.trim());
}

export function isCountDistributionToken(s: string | null | undefined): boolean {
  return isCountBucketToken(s) || isSpelledCountBucketToken(s);
}

// Trailing period qualifier (e.g. "... first half") stripped before parsing participants.
const FIXTURE_PERIOD_QUALIFIER_RX =
  /\s+(?:(?:first|1st|second|2nd)\s+half|half[\s-]?time|(?:1st|2nd|3rd|4th)\s+quarter|overtime|extra\s+time)\s*$/i;

/** Parses "A vs B" / "A v B" into its two participants; anything else (no separator, >2 sides) is null. */
export function parseFixtureParticipants(ce: string | null | undefined): [string, string] | null {
  if (!ce) return null;
  const parts = ce.replace(FIXTURE_PERIOD_QUALIFIER_RX, '').split(/\s+vs?\.?\s+/i);
  if (parts.length !== 2) return null;
  const a = normSubject(parts[0]);
  const b = normSubject(parts[1]);
  if (!a || !b) return null;
  return [a, b];
}

/** Counts provably-distinct fixtures among parsed participant pairs, alias-drift tolerant (order-insensitive). */
export function countDistinctFixtures(
  fixtures: { participants: [string, string]; raw: string }[],
): { count: number; samples: string[] } {
  if (fixtures.length === 0) return { count: 0, samples: [] };
  const names = [...new Set(fixtures.flatMap((f) => f.participants))];
  const parent = names.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const words = names.map((s) => s.split(' '));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (isPrefixOrSuffixRun(words[i], words[j]) || isPrefixOrSuffixRun(words[j], words[i])) {
        parent[find(i)] = find(j);
      }
    }
  }
  const classOf = new Map(names.map((n, i) => [n, find(i)]));
  const byKey = new Map<string, string>();
  for (const f of fixtures) {
    const key = f.participants.map((p) => classOf.get(p)!).sort((x, y) => x - y).join('|');
    if (!byKey.has(key)) byKey.set(key, f.raw);
  }
  return { count: byKey.size, samples: [...byKey.values()] };
}

/** lowercase + every non-alphanumeric run → single space ('Both_Teams-To Score!' → 'both teams to score'). */
function foldLabelKey(s: string): string {
  // foldAscii first, else an accented spelling and its ASCII sibling fold differently.
  return foldAscii(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
/** Small closed synonym family — keep tight, each entry asserts an unconditional identity. */
const LABEL_SYNONYMS = new Map<string, string>([
  ['btts', 'both teams to score'],
  ['btts yes', 'both teams to score'],
  ['both teams score', 'both teams to score'],
  ['both teams to score yes', 'both teams to score'],
]);
/** trailing ' win'/' wins' (NOT 'winner' — that can be a different question). */
function stripWinSuffix(k: string): string {
  return k.replace(/\s+wins?$/, '');
}
/** Broader win-suffix strip (win/wins/winner/to win/victory) for subject-free id-vs-id folding; strips at most one suffix. */
function stripWinSuffixBroad(k: string): string {
  return k.replace(/\s+(?:to\s+win|towin|winner|wins?|victory)$/, '');
}

/** A parsed numeric line: direction + value (the half-line / bound). */
interface RungLine { dir: 'above' | 'below'; value: number; }

const RUNG_LINE_RX = /(?:^|[^a-z])(over|under|above|below)[_\s]?(\d+(?:\.\d+)?)/i;

/** Parses a rung line from an outcome_id/slug ("over_3.5" → {above,3.5}); null when no direction+number token is present. */
function parseRungLine(id: string | null | undefined): RungLine | null {
  if (!id) return null;
  const m = id.match(RUNG_LINE_RX);
  if (!m) return null;
  const v = Number(m[2]);
  if (!Number.isFinite(v)) return null;
  const d = m[1].toLowerCase();
  return { dir: d === 'over' || d === 'above' ? 'above' : 'below', value: v };
}

function sameRungLine(a: RungLine, b: RungLine): boolean {
  return a.dir === b.dir && a.value === b.value;
}

/** A leg's own numeric line: Stage-1 facts first, else the native Kalshi strike; null when neither resolves. */
function legRungLine(f: NumericRegionFacts | undefined): RungLine | null {
  if (!f) return null;
  const dir = foldDirectionClass(f.condition_direction);
  const vp = f.value_primary == null ? null : Number(f.value_primary);
  if ((dir === 'above' || dir === 'below') && vp != null && Number.isFinite(vp)) {
    return { dir, value: vp };
  }
  const st = f.strike_type?.toLowerCase();
  if (st === 'greater' || st === 'greater_or_equal' || st === 'less' || st === 'less_or_equal') {
    const floor = f.floor_strike == null ? null : Number(f.floor_strike);
    const cap = f.cap_strike == null ? null : Number(f.cap_strike);
    const k = canonicalizeKalshiStrike(
      st,
      floor != null && Number.isFinite(floor) ? floor : null,
      cap != null && Number.isFinite(cap) ? cap : null,
      f.value_unit ?? null,
    );
    if (k) return { dir: k.direction, value: k.value };
  }
  return null;
}

function isContiguousTokenRun(small: string[], big: string[]): boolean {
  if (small.length === 0 || small.length > big.length) return false;
  for (let off = 0; off + small.length <= big.length; off++) {
    let ok = true;
    for (let j = 0; j < small.length; j++) {
      if (big[off + j] !== small[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
/** Canonical comparison key for an outcome id/label, anchored on the outcome_subject when the id is just a re-spelling of it. */
export function canonicalOutcomeKey(
  raw: string | null | undefined,
  subjectFolded: string | null,
): string | null {
  if (raw == null) return null;
  const folded = foldLabelKey(raw);
  if (folded === '') return null;
  const k = LABEL_SYNONYMS.get(folded) ?? folded;
  if (subjectFolded) {
    if (k === subjectFolded) return subjectFolded;
    const kw = stripWinSuffix(k);
    if (kw !== '' && kw !== k && kw === subjectFolded) return subjectFolded;
    if (kw !== '') {
      const kt = kw.split(' ');
      const st = subjectFolded.split(' ');
      // a token not in the subject (e.g. 'map2') breaks the run, so a real discriminator is never folded away.
      if (isContiguousTokenRun(kt, st)) return subjectFolded;
    }
  }
  return k;
}

// Mirrors stage4 finalize's ONE_HOT_FIXTURE_KINDS; equality pinned by a unit test in guards.test.ts.
export const ONE_HOT_PARTITION_KINDS = new Set<string>([
  'match_winner', 'halftime_leader', 'exact_score', 'candle_direction',
]);

// Per-fixture sports kinds exempt from the cross-subject backstop (span 2 team subjects).
export const FIXTURE_KINDS = new Set([
  'match_total_metric', 'match_spread', 'match_winner', 'both_teams_score', 'exact_score', 'halftime_leader',
  'match_event_prop',
]);
/** Whole-match kinds the period-scope hardstop forbids merging with a `halftime_leader` leg. */
const WHOLE_MATCH_KINDS = new Set([
  'match_winner', 'match_total_metric', 'match_spread', 'both_teams_score', 'exact_score',
  'match_event_prop',
]);

// Election/primary rank-1 kinds; excludes stage_advance and sports.
export const ELECTION_RANK_KINDS = new Set(['election_outcome_winner', 'primary_winner']);

// Election/nomination winner-race kinds for the party-contains-candidate guard.
export const ELECTION_WINNER_KINDS = new Set([
  'election_outcome_winner', 'primary_winner', 'election_seat_winner',
]);

/** Detects a political-party/aggregate/procedural outcome label (not a candidate person). */
export function looksLikePartyOrAggregateLabel(raw: string): boolean {
  const c = raw.replace(/_/g, ' ').trim();
  if (!c) return false;
  if (/\b(Part(?:y|i|ei|ido|ito)|Liberals?|Conservatives?|Greens?|Tories|Socialists?|Communists?|Democrats?|Republicans?|Coalition|Caucus|Independents?|Alliance|Bloc|Front|Movement|Nominee|Candidates?|Field|Winner|Majority|Seats?|Generic|Other)\b/i.test(c)) {
    return true;
  }
  if (/^GOP$/i.test(c)) return true;
  if (/^Democratics?$/i.test(c)) return true;  // LLM-emitted "Democratic" variant
  return false;
}

/** True iff `raw` is shaped like a 2-4 word person name with no digits (caller excludes placeholders/party labels). */
export function isCandidateShapedName(raw: string): boolean {
  const c = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!c) return false;
  if (/[0-9]/.test(c)) return false;
  const words = c.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[\p{L}][\p{L}'’.\-]*$/u.test(w));
}

/**
 * Party-aggregate-contains-candidate check: fires when the non-residual subjects
 * of an election-winner categorical have >=1 org/party outcome and >=2
 * candidate-shaped members. Caller must confirm election-winner scope first.
 */
export interface ContainmentSubject { subject: string; type: string | null }
export function electionContainmentReject(
  subjects: ContainmentSubject[],
): { aggregates: number; members: number; fire: boolean } {
  let aggregates = 0;
  let members = 0;
  for (const { subject, type } of subjects) {
    // anonymized placeholder slots are never a real aggregate or member.
    if (isOmegaPlaceholderSlot(subject)) continue;
    if (type === 'organization' || type === 'party') { aggregates++; continue; }
    if (type === 'person') { members++; continue; }
    if (type == null || type === 'unknown') {
      if (!isPlaceholderSubject(subject)
          && !looksLikePartyOrAggregateLabel(subject)
          && isCandidateShapedName(subject)) {
        members++;
      }
    }
  }
  return { aggregates, members, fire: aggregates >= 1 && members >= 2 };
}
// Title-keyed so it fires regardless of the normalized rank-grain event_kind stamp.
const ADVANCE_TITLE_RX = /\badvance\b/i;

// Absolute price-level kinds; a candle_direction leg (close vs open) can co-occur with these.
export const PRICE_LEVEL_KINDS = new Set([
  'price_threshold', 'price_snapshot', 'price_range_snapshot',
]);

// Event-kind pairs that can never be the same real event (unordered membership test).
export const NEVER_SAME_EVENT: ReadonlyArray<readonly [string, string]> = [
  ['championship_winner', 'stage_advance'],
  ['candle_direction', 'price_threshold'],
  ['election_margin', 'election_outcome_winner'],
];

export { type OutcomeGrain, classifyOutcomeAxisByKey, outcomeGrain }; // shared with Stage-4 finalize

/** City of a weather subject: its last comma segment. */
function cityOfSubject(subject: string | null): string | null {
  if (!subject) return null;
  const parts = subject.split(',');
  const city = parts[parts.length - 1].trim();
  return city || null;
}

const foldStationText = (s: string): string => foldAscii(s).toLowerCase().replace(/\s+/g, ' ').trim();

// Strips "(International )?Airport" unless the remainder collapses to the bare city.
function stationKey(phraseFolded: string, cityFolded: string | null): string {
  const stripped = phraseFolded.replace(/\s+(?:international\s+)?airport$/i, '').trim();
  if (stripped && stripped !== cityFolded) return stripped;
  return phraseFolded;
}

/** Epoch ms of an ISO-ish date string (naive → anchored UTC); NaN when unparseable. */
function parseIsoMs(d: string): number {
  const t = d.trim();
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(t);
  return Date.parse(hasZone ? t : t + 'Z');
}

export type MatchVerdict =
  | {
      kind: 'match';
      warnings: string[];
      /** True when a phantom outcome was dropped and the set was demoted to non-exhaustive (Σ≤1). */
      demotedNonExhaustive?: boolean;
    }
  | { kind: 'no_match'; reason: string }
  | { kind: 'reject'; reason: string };

// Order matters: cheap gates first, structural checks after same-event shape is confirmed.
export function validateMatch(result: EventMatchResult, ctx: MatchContext): MatchVerdict {
  const warnings: string[] = [];

  const idiomCtxFor = (mid: number): IdiomCtx => ({
    eventKind: ctx.marketEventKind?.get(mid) ?? null,
    sport: ctx.marketSport?.get(mid) ?? null,
    resolutionScope: ctx.marketScope.get(mid) ?? null,
  });

  if (!result.same_event) {
    return { kind: 'no_match', reason: 'same_event=false' };
  }
  if (!(result.confidence >= ctx.minConfidence)) {
    return { kind: 'no_match', reason: `confidence ${result.confidence} < ${ctx.minConfidence}` };
  }

  const grouping = result.grouping_kind;
  // reassigned in place by the guards below, so every later guard sees the post-drop state.
  let outcomeSet = result.outcome_set;
  let legs = result.leg_mapping;
  if (!grouping) return { kind: 'reject', reason: 'missing grouping_kind' };
  if (!outcomeSet || outcomeSet.length < 1) return { kind: 'reject', reason: 'outcome_set missing or empty' };
  if (!legs || legs.length === 0) return { kind: 'reject', reason: 'leg_mapping missing or empty' };
  let demotedNonExhaustive = false;

  // Two non-residual outcomes sharing a subject whose ids/labels fold to one
  // canonical key are one outcome spelled two ways — merge rather than reject.
  {
    const curLegs = legs;
    const legFacts = (oid: string, map: Map<number, string | null> | undefined): string | null | undefined => {
      if (!map) return undefined;
      let val: string | null | undefined;
      let seen = false;
      for (const l of curLegs) {
        if (l.outcome_id !== oid) continue;
        const v = map.get(l.market_id);
        if (!seen) { val = v; seen = true; }
        else if (val !== v) return undefined;
      }
      return seen ? val : undefined;
    };
    const provablyDifferent = (a: string | null | undefined, b: string | null | undefined): boolean =>
      a != null && b != null && a !== b;

    const bySubject = new Map<string, OutcomeSetItem[]>();
    for (const o of outcomeSet) {
      if (o.is_residual) continue;
      const sf = o.outcome_subject ? foldLabelKey(o.outcome_subject) : '';
      if (!sf) continue;
      const g = bySubject.get(sf);
      if (g) g.push(o);
      else bySubject.set(sf, [o]);
    }
    const dropIds = new Set<string>();
    const rekey = new Map<string, string>();
    for (const [sf, group] of bySubject) {
      if (group.length < 2) continue;
      const byKey = new Map<string, OutcomeSetItem[]>();
      for (const o of group) {
        // fold the outcome ID only — a label can equal the subject for genuinely distinct outcomes.
        const key = canonicalOutcomeKey(o.outcome_id, sf) ?? o.outcome_id;
        const b = byKey.get(key);
        if (b) b.push(o);
        else byKey.set(key, [o]);
      }
      for (const bucket of byKey.values()) {
        if (bucket.length < 2) continue;
        const ordinals = new Set(bucket.map((o) => o.ordinal).filter((v): v is number => v != null));
        if (ordinals.size > 1) continue;
        let conflict = false;
        for (let i = 1; i < bucket.length && !conflict; i++) {
          conflict =
            provablyDifferent(legFacts(bucket[0].outcome_id, ctx.reconcileMetricScope), legFacts(bucket[i].outcome_id, ctx.reconcileMetricScope)) ||
            provablyDifferent(legFacts(bucket[0].outcome_id, ctx.marketEventKind), legFacts(bucket[i].outcome_id, ctx.marketEventKind));
        }
        if (conflict) continue;
        const keep = bucket[0];
        for (const dup of bucket.slice(1)) {
          rekey.set(dup.outcome_id, keep.outcome_id);
          dropIds.add(dup.outcome_id);
          if (keep.outcome_subject == null || keep.outcome_subject === '') keep.outcome_subject = dup.outcome_subject;
          if (keep.ordinal == null) keep.ordinal = dup.ordinal;
          warnings.push(
            `label-fold merge: outcomes "${dup.outcome_id}" ≡ "${keep.outcome_id}" `
            + `(both fold to one canonical outcome for subject "${keep.outcome_subject ?? sf}") — legs merged`,
          );
        }
      }
    }

    // Second pass, subject-independent: key on the win-suffix-stripped id stem instead.
    {
      const byStem = new Map<string, OutcomeSetItem[]>();
      for (const o of outcomeSet) {
        if (o.is_residual || dropIds.has(o.outcome_id)) continue;
        const stem = stripWinSuffixBroad(foldLabelKey(o.outcome_id));
        if (!stem) continue;
        const g = byStem.get(stem);
        if (g) g.push(o);
        else byStem.set(stem, [o]);
      }
      for (const bucket of byStem.values()) {
        if (bucket.length < 2) continue;
        const ordinals = new Set(bucket.map((o) => o.ordinal).filter((v): v is number => v != null));
        if (ordinals.size > 1) continue;
        let conflict = false;
        for (let i = 1; i < bucket.length && !conflict; i++) {
          conflict =
            provablyDifferent(legFacts(bucket[0].outcome_id, ctx.reconcileMetricScope), legFacts(bucket[i].outcome_id, ctx.reconcileMetricScope)) ||
            provablyDifferent(legFacts(bucket[0].outcome_id, ctx.marketEventKind), legFacts(bucket[i].outcome_id, ctx.marketEventKind));
        }
        if (conflict) continue;
        const keep = bucket[0];
        for (const dup of bucket.slice(1)) {
          if (dup.outcome_id === keep.outcome_id) continue;
          rekey.set(dup.outcome_id, keep.outcome_id);
          dropIds.add(dup.outcome_id);
          if (keep.outcome_subject == null || keep.outcome_subject === '') keep.outcome_subject = dup.outcome_subject;
          if (keep.ordinal == null) keep.ordinal = dup.ordinal;
          warnings.push(
            `subject-free label-fold merge: outcomes "${dup.outcome_id}" ≡ "${keep.outcome_id}" `
            + `(ids fold to one win-suffix stem) — legs merged`,
          );
        }
      }
    }

    if (dropIds.size > 0) {
      for (const l of legs) {
        const target = rekey.get(l.outcome_id);
        if (target !== undefined) l.outcome_id = target;
      }
      const seen = new Set<string>();
      const dedupedLegs = legs.filter((l) => {
        const k = `${l.outcome_id}|${l.platform}|${l.market_id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      result.leg_mapping = dedupedLegs;
      legs = dedupedLegs;
      result.outcome_set = outcomeSet.filter((o) => !dropIds.has(o.outcome_id));
      outcomeSet = result.outcome_set;
    }
  }

  // A cross-platform outcome with no known subject and a deadline-only label
  // ("Before 2027") is keyed on the deadline, not a subject — refuse it.
  if (ctx.marketSubject && ctx.marketSubject.size > 0) {
    const legsByOutcome = new Map<string, LegMappingItem[]>();
    for (const l of legs) (legsByOutcome.get(l.outcome_id) ?? legsByOutcome.set(l.outcome_id, []).get(l.outcome_id)!).push(l);
    for (const o of outcomeSet) {
      if (o.is_residual) continue;
      const subj = o.outcome_subject;
      if (subj == null || subj.trim() === '' || !isDeadlineOnlySubject(subj)) continue;
      const oLegs = legsByOutcome.get(o.outcome_id);
      if (!oLegs || oLegs.length === 0) continue;
      const platforms = new Set(oLegs.map((l) => l.platform));
      if (platforms.size < 2) continue;
      const anyKnownSubject = oLegs.some((l) => {
        const s = ctx.marketSubject!.get(l.market_id);
        return s != null && s.trim() !== '';
      });
      if (anyKnownSubject) continue;
      return {
        kind: 'reject',
        reason:
          `NULL-subject pairing ban: cross-platform outcome "${o.outcome_id}" fuses ${platforms.size} platforms `
          + `with no known canonical_subject on any leg and a deadline-only label ("${subj}") — `
          + `arbitrage-bearing equivalence keyed on the deadline, not a subject`,
      };
    }
  }

  // A single outcome across platforms is allowed only when every platform contributes exactly one child market.
  if (outcomeSet.length === 1) {
    const perPlatform = new Map<string, number>();
    for (const p of ctx.marketPlatform.values()) perPlatform.set(p, (perPlatform.get(p) ?? 0) + 1);
    for (const [p, n] of perPlatform) {
      if (n > 1) {
        return { kind: 'reject', reason: `single outcome but platform "${p}" has ${n} child markets (collapsed partition?)` };
      }
    }
  }

  // A declared outcome with no leg is dropped rather than rejecting the whole match; survivors persist as non-exhaustive.
  const mappedOutcomeIds = new Set(legs.map((l) => l.outcome_id));
  const phantoms = outcomeSet.filter((o) => !mappedOutcomeIds.has(o.outcome_id));
  if (phantoms.length > 0) {
    const ph0 = phantoms[0];
    const phantomList = phantoms.map((o) => `"${o.outcome_id}"`).join(', ');
    if (outcomeSet.length <= 2) {
      return {
        kind: 'reject',
        reason: `outcome "${ph0.outcome_id}" has no leg (phantom outcome) — degenerate ${outcomeSet.length}-outcome set, rejected`,
      };
    }
    if (grouping === 'threshold_series') {
      return {
        kind: 'reject',
        reason: `outcome "${ph0.outcome_id}" has no leg (phantom outcome) — threshold_series not demotable (dropped rung breaks the ordinal grid), rejected`,
      };
    }
    const survivors = outcomeSet.filter((o) => mappedOutcomeIds.has(o.outcome_id));
    if (grouping === 'categorical_exclusive') {
      if (!ctx.marketEventKind || !ctx.marketNumeric) {
        return {
          kind: 'reject',
          reason: `outcome "${ph0.outcome_id}" has no leg (phantom outcome) — demotion needs event-kind + numeric guard meta (guard flags off), rejected`,
        };
      }
      const labelOf = (o: OutcomeSetItem): string =>
        (o.outcome_subject && o.outcome_subject.trim()) || o.label || o.outcome_id;
      const { residual: detectedResidual } = placeholderSlotsInSet(
        survivors.map((o) => ({ id: o.outcome_id, label: labelOf(o) })),
      );
      const isResidualOutcome = (o: OutcomeSetItem) => !!o.is_residual || detectedResidual.has(o.outcome_id);
      const residualDrop = survivors.filter(isResidualOutcome);
      const real = survivors.filter((o) => !isResidualOutcome(o));
      if (real.length < 2) {
        return {
          kind: 'reject',
          reason: `outcome "${ph0.outcome_id}" has no leg (phantom outcome) — fewer than 2 real outcomes would survive demotion, rejected`,
        };
      }
      const realIds = new Set(real.map((o) => o.outcome_id));
      const keptLegs = legs.filter((l) => realIds.has(l.outcome_id));
      for (const l of keptLegs) {
        const k = ctx.marketEventKind.get(l.market_id);
        if (k != null && ONE_HOT_PARTITION_KINDS.has(k)) {
          return {
            kind: 'reject',
            reason: `outcome "${ph0.outcome_id}" has no leg (phantom outcome) — surviving leg kind "${k}" is a one-hot fixture partition (negRisk Σ=1 arm), not demotable, rejected`,
          };
        }
        const f = ctx.marketNumeric.get(l.market_id);
        if (f && f.value_primary != null) {
          return {
            kind: 'reject',
            reason: `outcome "${ph0.outcome_id}" has no leg (phantom outcome) — surviving legs carry numeric values (tiling Σ=1 arm), not demotable, rejected`,
          };
        }
      }
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(keptLegs.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          return {
            kind: 'reject',
            reason: `outcome "${ph0.outcome_id}" has no leg (phantom outcome) — residual drop would gut every "${p}" leg, rejected`,
          };
        }
      }
      for (const o of phantoms) {
        warnings.push(`phantom-outcome drop: "${o.outcome_id}" declared with no leg — dropped, set demoted to non-exhaustive (Σ≤1)`);
      }
      for (const o of residualDrop) {
        const n = legs.filter((l) => l.outcome_id === o.outcome_id).length;
        warnings.push(
          `phantom-demotion residual drop: residual outcome "${o.outcome_id}" (+${n} leg(s)) dropped — an incomplete partition must not keep its completeness signal`,
        );
      }
      result.outcome_set = real;
      outcomeSet = real;
      result.leg_mapping = keptLegs;
      legs = keptLegs;
      demotedNonExhaustive = true;
      result.reasoning = `${result.reasoning ?? ''} [phantom-demoted: dropped ${phantoms.length} phantom outcome(s) ${phantomList}`
        + `${residualDrop.length > 0 ? ` + ${residualDrop.length} residual outcome(s)` : ''}; persisted NON-exhaustive (Σ≤1)]`;
    } else {
      if (survivors.length < 2) {
        return {
          kind: 'reject',
          reason: `outcome "${ph0.outcome_id}" has no leg (phantom outcome) — fewer than 2 outcomes would survive the drop, rejected`,
        };
      }
      for (const o of phantoms) {
        warnings.push(`phantom-outcome drop: "${o.outcome_id}" declared with no leg — dropped (bundle, no Σ asserted)`);
      }
      result.outcome_set = survivors;
      outcomeSet = survivors;
      result.reasoning = `${result.reasoning ?? ''} [phantom-dropped: ${phantomList} (bundle, no Σ asserted)]`;
    }
  }

  const declaredOutcomeIds = new Set(outcomeSet.map((o) => o.outcome_id));
  for (const l of legs) {
    if (!declaredOutcomeIds.has(l.outcome_id)) {
      return { kind: 'reject', reason: `leg references undeclared outcome "${l.outcome_id}"` };
    }
  }

  // A leg mis-bound to the wrong numeric rung is dropped (anchor kept); a blind bind with a known-line sibling is dropped too.
  if (grouping === 'threshold_series' && legs.length > 1) {
    const rungDrop = new Set<LegMappingItem>();
    for (const o of outcomeSet) {
      if (o.is_residual) continue;
      const slotLine = parseRungLine(o.outcome_id);
      if (!slotLine) continue;
      const outcomeLegs = legs.filter((l) => l.outcome_id === o.outcome_id);
      if (outcomeLegs.length === 0) continue;
      const lineOf = new Map<LegMappingItem, RungLine | null>();
      for (const l of outcomeLegs) lineOf.set(l, legRungLine(ctx.marketNumeric?.get(l.market_id)));
      const anyKnownSibling = [...lineOf.values()].some((v) => v != null);
      const crossPlatform = new Set(outcomeLegs.map((l) => l.platform)).size > 1;
      for (const l of outcomeLegs) {
        const line = lineOf.get(l) ?? null;
        if (line != null && !sameRungLine(line, slotLine)) {
          rungDrop.add(l); // (i) known-but-wrong-rung
        } else if (line == null && crossPlatform && anyKnownSibling) {
          rungDrop.add(l); // (ii) blind bind with a known-line sibling
        }
      }
    }
    if (rungDrop.size > 0) {
      const survivors = legs.filter((l) => !rungDrop.has(l));
      if (survivors.length === 0) {
        return { kind: 'reject', reason: 'rung-line gate dropped every leg — no fungible rung binding remains' };
      }
      beltHit('stage3_rung_line_gate', { n: rungDrop.size });
      for (const d of rungDrop) {
        warnings.push(`rung-line gate drop: outcome "${d.outcome_id}" market ${d.market_id} — leg line ≠ slug rung / blind bind with known-line sibling`);
      }
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [rung-line gate dropped ${rungDrop.size} leg(s): ${
        [...rungDrop].map((l) => `${l.platform}:${l.market_id}`).join(', ')}]`;
    }
  }

  const seenSubjects = new Map<string, string>(); // subject → outcome_id
  for (const o of outcomeSet) {
    if (o.is_residual) {
      if (o.outcome_subject != null && o.outcome_subject !== '') {
        return { kind: 'reject', reason: `residual outcome "${o.outcome_id}" must not carry an outcome_subject` };
      }
      continue;
    }
    const subj = o.outcome_subject;
    if (subj == null || subj === '') continue;
    const prior = seenSubjects.get(subj);
    if (prior && prior !== o.outcome_id) {
      return { kind: 'reject', reason: `outcome_subject "${subj}" shared by outcomes "${prior}" and "${o.outcome_id}"` };
    }
    seenSubjects.set(subj, o.outcome_id);
  }

  for (const l of legs) {
    const plat = ctx.marketPlatform.get(l.market_id);
    if (plat === undefined) {
      return { kind: 'reject', reason: `leg market_id ${l.market_id} is not a child of either event` };
    }
    if (plat !== l.platform) {
      return { kind: 'reject', reason: `leg market_id ${l.market_id} is on "${plat}", not stated "${l.platform}"` };
    }
  }

  // Weather station/oracle veto: two named stations -> reject; named vs city-generic -> reject; same station, different oracle -> warn.
  if (ctx.marketWeather && ctx.marketWeather.size > 0) {
    const namedStations = new Map<string, Set<string>>();
    const genericPlatforms = new Set<string>();
    const oracles = new Set<string>();
    for (const l of legs) {
      const kind = ctx.marketEventKind?.get(l.market_id);
      if (kind != null && !kind.startsWith('weather')) continue;
      const w = ctx.marketWeather.get(l.market_id);
      if (!w || !w.text) continue;
      const oracle = extractWeatherOracle(w.text);
      if (oracle) oracles.add(oracle);
      const phrase = extractStationPhrase(w.text);
      if (!phrase) continue;
      const phraseFolded = foldStationText(phrase);
      const city = cityOfSubject(w.subject);
      const cityFolded = city ? foldStationText(city) : null;
      if (cityFolded != null && phraseFolded === cityFolded) {
        genericPlatforms.add(l.platform);
      } else {
        const key = stationKey(phraseFolded, cityFolded);
        let plats = namedStations.get(key);
        if (!plats) { plats = new Set(); namedStations.set(key, plats); }
        plats.add(l.platform);
      }
    }
    if (namedStations.size >= 2) {
      return {
        kind: 'reject',
        reason: `weather station mismatch: legs resolve at different stations [${[...namedStations.keys()].slice(0, 3).join(' | ')}] — not the same physical measurement`,
      };
    }
    if (namedStations.size === 1) {
      const [stKey, stPlats] = [...namedStations.entries()][0];
      for (const p of genericPlatforms) {
        if (!stPlats.has(p)) {
          return {
            kind: 'reject',
            reason: `weather station mismatch: station "${stKey}" vs city-generic report on ${p} — station unproven-same (NYC Central-Park-vs-LaGuardia class)`,
          };
        }
      }
      if (oracles.size > 1) {
        warnings.push(
          `weather oracle divergence (${[...oracles].sort().join(' vs ')}) on station "${stKey}" — merge allowed, inter-oracle basis risk not persisted (no semantic_event channel)`,
        );
      }
    }
  }

  // Two markets fused onto one outcome must agree on their implied numeric YES-region (numeric-region.ts); conflicting leg dropped.
  if (ctx.marketNumeric && ctx.marketNumeric.size > 0) {
    const byOutcome = new Map<string, LegMappingItem[]>();
    for (const l of legs) {
      let g = byOutcome.get(l.outcome_id);
      if (!g) { g = []; byOutcome.set(l.outcome_id, g); }
      g.push(l);
    }
    const droppedLegs = new Set<LegMappingItem>();
    for (const [oid, group] of byOutcome) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((x, y) => x.market_id - y.market_id);
      const accepted: LegMappingItem[] = [ordered[0]];
      for (let i = 1; i < ordered.length; i++) {
        const cand = ordered[i];
        const candFacts = ctx.marketNumeric.get(cand.market_id);
        let conflict: string | null = null;
        if (candFacts) {
          for (const acc of accepted) {
            const accFacts = ctx.marketNumeric.get(acc.market_id);
            if (!accFacts) continue;
            const c = numericRegionConflict(accFacts, candFacts);
            if (c) {
              conflict = `outcome "${oid}": market ${cand.market_id} vs ${acc.market_id} — ${c}`;
              break;
            }
          }
        }
        if (conflict) {
          droppedLegs.add(cand);
          warnings.push(`numeric YES-region leg drop: ${conflict}`);
        } else {
          accepted.push(cand);
        }
      }
    }
    if (droppedLegs.size > 0) {
      const survivors = legs.filter((l) => !droppedLegs.has(l));
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(survivors.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          return {
            kind: 'reject',
            reason: `numeric YES-region conflict drops every "${p}" leg (${droppedLegs.size} dropped) — offset strike grids fused by ordinal position, no fungible leg pairing remains`,
          };
        }
      }
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [numeric YES-region guard dropped ${droppedLegs.size} leg(s): ${
        [...droppedLegs].map((l) => `${l.platform}:${l.market_id}`).join(', ')}]`;
    }
  }

  // Generic-title siblings paired by position can land off by one; anchor each outcome on its declared subject and drop divergent legs.
  if (ctx.marketSubject && ctx.marketSubject.size > 0) {
    const subjFold = (mid: number): string | null => {
      const s = ctx.marketSubject!.get(mid);
      if (s == null || s.trim() === '') return null;
      return canonicalOutcomeKey(s, null);
    };
    // "agree" if equal OR one is a contiguous-token-run of the other (alias containment).
    const subjectsAgree = (ka: string, kb: string): boolean => {
      if (ka === kb) return true;
      return canonicalOutcomeKey(ka, kb) === kb || canonicalOutcomeKey(kb, ka) === ka;
    };
    const outcomeSubjKey = new Map<string, string | null>();
    for (const o of outcomeSet) {
      if (o.is_residual) { outcomeSubjKey.set(o.outcome_id, null); continue; }
      const s = o.outcome_subject;
      outcomeSubjKey.set(o.outcome_id, s && s.trim() ? canonicalOutcomeKey(s, null) : null);
    }
    const byOutcome = new Map<string, LegMappingItem[]>();
    for (const l of legs) {
      let g = byOutcome.get(l.outcome_id);
      if (!g) { g = []; byOutcome.set(l.outcome_id, g); }
      g.push(l);
    }
    const droppedSubj = new Set<LegMappingItem>();
    for (const [oid, group] of byOutcome) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((x, y) => x.market_id - y.market_id);
      let anchorKey: string | null = outcomeSubjKey.get(oid) ?? null;
      if (!anchorKey) {
        for (const l of ordered) { const k = subjFold(l.market_id); if (k) { anchorKey = k; break; } }
      }
      if (!anchorKey) continue;
      for (const l of ordered) {
        const k = subjFold(l.market_id);
        if (k == null) continue;
        if (subjectsAgree(anchorKey, k)) continue;
        // idiom bridge: same settlement outcome spelled two ways (tie<->draw etc.).
        if (idiomsAgree(anchorKey, k, idiomCtxFor(l.market_id))) continue;
        droppedSubj.add(l);
        warnings.push(`subject-coherence leg drop: outcome "${oid}" market ${l.market_id} subject "${k}" ≠ anchor subject "${anchorKey}" (RC3 rotation mis-pair)`);
      }
    }
    if (droppedSubj.size > 0) {
      const survivors = legs.filter((l) => !droppedSubj.has(l));
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(survivors.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          return {
            kind: 'reject',
            reason: `subject-coherence conflict drops every "${p}" leg (${droppedSubj.size} dropped) — generic-title sibling paired by position to the wrong candidate (RC3 rotation), no same-subject leg pairing remains`,
          };
        }
      }
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [subject-coherence guard dropped ${droppedSubj.size} mis-paired leg(s): ${
        [...droppedSubj].map((l) => `${l.platform}:${l.market_id}`).join(', ')}]`;
    }
  }

  // Covers cases with NULL Stage-1 marketSubject: fold each leg's native label and drop it when it differs from the assigned subject.
  if (ctx.marketNativeLabel && ctx.marketNativeLabel.size > 0) {
    const nativeFold = (mid: number): string | null => {
      const s = ctx.marketNativeLabel!.get(mid);
      if (s == null || s.trim() === '') return null;
      return canonicalOutcomeKey(s, null);
    };
    const agree = (ka: string, kb: string): boolean => {
      if (ka === kb) return true;
      return canonicalOutcomeKey(ka, kb) === kb || canonicalOutcomeKey(kb, ka) === ka;
    };
    const outcomeSubjKey = new Map<string, string | null>();
    for (const o of outcomeSet) {
      if (o.is_residual) { outcomeSubjKey.set(o.outcome_id, null); continue; }
      const s = o.outcome_subject;
      outcomeSubjKey.set(o.outcome_id, s && s.trim() ? canonicalOutcomeKey(s, null) : null);
    }
    const droppedNative = new Set<LegMappingItem>();
    for (const l of legs) {
      const anchorKey = outcomeSubjKey.get(l.outcome_id) ?? null;
      if (!anchorKey) continue;           // outcome has no declared subject → cannot judge
      const k = nativeFold(l.market_id);
      if (k == null) continue;            // unknown native label → never a conflict
      if (agree(anchorKey, k)) continue;
      if (idiomsAgree(anchorKey, k, idiomCtxFor(l.market_id))) continue;
      droppedNative.add(l);
      warnings.push(`native-label leg drop: outcome "${l.outcome_id}" market ${l.market_id} native "${k}" ≠ outcome subject "${anchorKey}" (positional mis-map)`);
    }
    if (droppedNative.size > 0) {
      const survivors = legs.filter((l) => !droppedNative.has(l));
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(survivors.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          return {
            kind: 'reject',
            reason: `native-label conflict drops every "${p}" leg (${droppedNative.size} dropped) — identical-title siblings mapped by position to the wrong outcome (fix ④), no native-consistent leg pairing remains`,
          };
        }
      }
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [native-label guard dropped ${droppedNative.size} mis-mapped leg(s): ${
        [...droppedNative].map((l) => `${l.platform}:${l.market_id}`).join(', ')}]`;
    }
  }

  // Covers the two-sided moneyline shape (no scalar label): the leg's assigned subject must fold-match one of the 2 native outcome-vector entries.
  if (ctx.marketNativeOutcomes && ctx.marketNativeOutcomes.size > 0) {
    const BINARY_FOLDS = new Set(['yes', 'no', 'true', 'false']);
    const agree = (ka: string, kb: string): boolean => {
      if (ka === kb) return true;
      return canonicalOutcomeKey(ka, kb) === kb || canonicalOutcomeKey(kb, ka) === ka;
    };
    const outcomeSubjKey = new Map<string, string | null>();
    for (const o of outcomeSet) {
      if (o.is_residual) { outcomeSubjKey.set(o.outcome_id, null); continue; }
      const s = o.outcome_subject;
      outcomeSubjKey.set(o.outcome_id, s && s.trim() ? canonicalOutcomeKey(s, null) : null);
    }
    const droppedVec = new Set<LegMappingItem>();
    for (const l of legs) {
      const anchorKey = outcomeSubjKey.get(l.outcome_id) ?? null;
      if (!anchorKey) continue;                       // no declared subject → cannot judge
      const vec = ctx.marketNativeOutcomes.get(l.market_id);
      if (!vec || vec.length !== 2) continue;         // not the two-sided shape
      const folds = vec
        .map((v) => (v && v.trim() ? canonicalOutcomeKey(v, null) : null))
        .filter((v): v is string => v != null && v !== '');
      if (folds.length !== 2) continue;               // unfoldable → never a conflict
      if (folds.some((f) => BINARY_FOLDS.has(f))) continue; // {Yes,No} carries no identity
      if (folds.some((f) => agree(anchorKey, f))) continue; // mapped to a side it prices
      if (folds.some((f) => idiomsAgree(anchorKey, f, idiomCtxFor(l.market_id)))) continue;
      droppedVec.add(l);
      warnings.push(`native-outcome leg drop: outcome "${l.outcome_id}" market ${l.market_id} prices [${folds.join(' | ')}] — neither side is the assigned outcome subject "${anchorKey}" (mis-legged moneyline)`);
    }
    if (droppedVec.size > 0) {
      const survivors = legs.filter((l) => !droppedVec.has(l));
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(survivors.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          return {
            kind: 'reject',
            reason: `native-outcome conflict drops every "${p}" leg (${droppedVec.size} dropped) — the market's own outcome vector prices neither side of its assigned outcome (P10 mis-legged moneyline), no coherent leg pairing remains`,
          };
        }
      }
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [native-outcome guard dropped ${droppedVec.size} mis-legged leg(s): ${
        [...droppedVec].map((l) => `${l.platform}:${l.market_id}`).join(', ')}]`;
    }
  }

  // A subject shaped like "Arsenal vs Everton" is an event name, not a claim identity, so refuse >=2 legs sharing it unless one supplies a real subject.
  {
    const legsByOutcome = new Map<string, LegMappingItem[]>();
    for (const l of legs) {
      let g = legsByOutcome.get(l.outcome_id);
      if (!g) { g = []; legsByOutcome.set(l.outcome_id, g); }
      g.push(l);
    }
    for (const o of outcomeSet) {
      if (o.is_residual) continue;
      const subj = o.outcome_subject;
      if (!subj || !isFixturePlaceholderSubject(subj)) continue;
      const group = legsByOutcome.get(o.outcome_id) ?? [];
      if (new Set(group.map((l) => l.market_id)).size < 2) continue;
      const hasRealSubject = group.some((l) => {
        const s = ctx.marketSubject?.get(l.market_id);
        return !!s && s.trim() !== '' && !isFixturePlaceholderSubject(s);
      });
      if (hasRealSubject) continue;
      return {
        kind: 'reject',
        reason: `outcome "${o.outcome_id}" co-homes ${group.length} legs whose ONLY shared identity is the `
          + `fixture-placeholder subject "${subj}" — a fixture name says the legs belong to the same MATCH, `
          + `never that they are the same CLAIM (P3)`,
      };
    }
  }

  // Drop any leg whose market is a custom exact-score child (looksCorrectScoreLabel) unless mapped to a genuine exact-score outcome.
  {
    const hasScore = (s: string | null | undefined): boolean => s != null && /\d{1,2}\s*[-–]\s*\d{1,2}/.test(s);
    const outcomeIsScoreline = new Map<string, boolean>();
    for (const o of outcomeSet) {
      outcomeIsScoreline.set(o.outcome_id, hasScore(o.outcome_subject) || hasScore(o.label));
    }
    const droppedScore = new Set<LegMappingItem>();
    for (const l of legs) {
      const o = outcomeSet.find((x) => x.outcome_id === l.outcome_id);
      if (!o || o.is_residual) continue;
      if (outcomeIsScoreline.get(l.outcome_id)) continue;
      const nativeLabel = ctx.marketNativeLabel?.get(l.market_id) ?? null;
      if (!looksCorrectScoreLabel(nativeLabel)) continue;
      const series = ctx.marketKalshiSeries?.get(l.market_id) ?? null;
      const kind = ctx.marketEventKind?.get(l.market_id) ?? null;
      const isExactScoreChild = kind === 'exact_score' || (series != null && /SCORE$/.test(series));
      if (!isExactScoreChild) continue;
      droppedScore.add(l);
      warnings.push(`exact-score winner-project drop: outcome "${l.outcome_id}" market ${l.market_id} native "${nativeLabel}" is a scoreline mapped onto a non-scoreline (winner-projected) outcome`);
    }
    if (droppedScore.size > 0) {
      const survivors = legs.filter((l) => !droppedScore.has(l));
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(survivors.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          beltHit('exact_score_winner_project_refuse', { path: 'llm', dropped: droppedScore.size });
          return {
            kind: 'reject',
            reason: `exact-score winner-projection drops every "${p}" leg (${droppedScore.size} dropped) — custom correct-score scorelines fused onto a 1X2/series winner node, no scoreline-consistent leg pairing remains`,
          };
        }
      }
      beltHit('exact_score_winner_project_refuse', { path: 'llm', dropped: droppedScore.size });
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [exact-score winner-project guard dropped ${droppedScore.size} scoreline leg(s): ${
        [...droppedScore].map((l) => `${l.platform}:${l.market_id}`).join(', ')}]`;
    }
  }

  // "advance" (top-two) and "place first"/"win" (rank 1) are different rank grains; drop the new leg on either side of a mix.
  if (ctx.marketTitle && ctx.marketTitle.size > 0) {
    type RankLeg = {
      newLeg: LegMappingItem | null; // null = persisted prior leg
      title: string | null;
      kind: string | null;
    };
    const byOutcome = new Map<string, RankLeg[]>();
    const push = (oid: string, rl: RankLeg) => {
      let g = byOutcome.get(oid);
      if (!g) { g = []; byOutcome.set(oid, g); }
      g.push(rl);
    };
    for (const l of legs) {
      push(l.outcome_id, {
        newLeg: l,
        title: ctx.marketTitle.get(l.market_id) ?? null,
        kind: ctx.marketEventKind?.get(l.market_id) ?? null,
      });
    }
    for (const pl of ctx.priorLegs ?? []) {
      push(pl.outcome_id, { newLeg: null, title: pl.title ?? null, kind: pl.event_kind ?? null });
    }
    const isAdvance = (g: RankLeg) => g.title != null && ADVANCE_TITLE_RX.test(g.title);
    const isPlaceFirst = (g: RankLeg) =>
      g.kind != null && ELECTION_RANK_KINDS.has(g.kind) && g.title != null && !ADVANCE_TITLE_RX.test(g.title);
    const droppedRank = new Set<LegMappingItem>();
    for (const [oid, group] of byOutcome) {
      if (group.length < 2) continue;
      if (!group.some(isPlaceFirst) || !group.some(isAdvance)) continue;
      for (const g of group) {
        if (g.newLeg == null) continue;
        if (isAdvance(g) || (isPlaceFirst(g) && group.some((o) => o.newLeg == null && isAdvance(o)))) {
          droppedRank.add(g.newLeg);
          warnings.push(
            `advance/place-first leg drop: outcome "${oid}" market ${g.newLeg.market_id} fuses a ` +
            `top-two "advance" leg with a rank-1 place-first/winner leg (election rank-grain mismatch)`,
          );
        }
      }
    }
    if (droppedRank.size > 0) {
      const survivors = legs.filter((l) => !droppedRank.has(l));
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(survivors.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          return {
            kind: 'reject',
            reason: `advance/place-first conflict drops every "${p}" leg (${droppedRank.size} dropped) — ` +
              `top-two primary "advance" markets are not equivalent to place-first markets, no fungible leg pairing remains`,
          };
        }
      }
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [advance/place-first guard dropped ${droppedRank.size} leg(s): ${
        [...droppedRank].map((l) => `${l.platform}:${l.market_id}`).join(', ')}]`;
    }
  }

  // Group legs by outcome_id; drop any later leg whose condition_date or metric_scope provably conflicts with an accepted leg.
  if ((ctx.marketDates && ctx.marketDates.size > 0) ||
      (ctx.reconcileMetricScope && ctx.reconcileMetricScope.size > 0)) {
    const dateOf = (mid: number): string | null => ctx.marketDates?.get(mid)?.condition_date ?? null;
    const datePrecOf = (mid: number): string | null => ctx.marketDates?.get(mid)?.condition_date_precision ?? null;
    const scopeOf = (mid: number): string | null => ctx.reconcileMetricScope?.get(mid) ?? null;
    const kindOf = (mid: number): string | null => ctx.marketEventKind?.get(mid) ?? null;
    const pairConflict = (acc: LegMappingItem, cand: LegMappingItem): string | null => {
      const sa = scopeOf(acc.market_id);
      const sb = scopeOf(cand.market_id);
      if (sa != null && sb != null && sa !== sb) {
        return `metric_scope '${sb}' vs '${sa}' — different resolution scope (map/segment vs overall)`;
      }
      const da = dateOf(acc.market_id);
      const db = dateOf(cand.market_id);
      if (da != null && db != null) {
        const isCandle = kindOf(acc.market_id) === 'candle_direction' || kindOf(cand.market_id) === 'candle_direction';
        if (isCandle) {
          if (exactTimestampKey(da) !== exactTimestampKey(db)) {
            return `candle open mismatch: condition_date '${db}' vs '${da}'`;
          }
        } else {
          // coarser of the two stamped precisions (a padded year date is "in 2026", not Jan 1).
          const rank = Math.max(precisionRank(datePrecOf(acc.market_id)), precisionRank(datePrecOf(cand.market_id)));
          if (grainKeyAt(da, rank) !== grainKeyAt(db, rank)) {
            return `condition_date day '${db}' vs '${da}'`;
          }
          // equal day-keys aren't agreement across the UTC-instant vs local-day seam; also check trusted start instants.
          const ka = kindOf(acc.market_id);
          const kb = kindOf(cand.market_id);
          if ((ka != null && FIXTURE_START_KINDS.has(ka)) || (kb != null && FIXTURE_START_KINDS.has(kb))) {
            const factsOf = (l: LegMappingItem): FixtureInstantFacts => ({
              platform: l.platform,
              end_date: ctx.marketDates?.get(l.market_id)?.end_date ?? null,
              condition_date: dateOf(l.market_id),
              condition_date_precision: datePrecOf(l.market_id),
            });
            const fa = factsOf(acc);
            const fb = factsOf(cand);
            if (fixtureStartInstantsDiverge(fixtureStartInstantMs(fa), fixtureStartInstantMs(fb))) {
              return `fixture start instants diverge: '${da}' vs '${db}' are different games (>= tolerance apart)`;
            }
            if (ambiguousEveningConflict(fa, fb, EVENING_DAY_SHIFT_MAX_UTC_HOUR,
                ctx.marketSport?.get(acc.market_id), ctx.marketSport?.get(cand.market_id))) {
              return `ambiguous evening fixture instant: '${da}' vs '${db}' cannot be pinned to one local game day (back-to-back-prone sport)`;
            }
          }
        }
      }
      return null;
    };
    const byOutcome = new Map<string, LegMappingItem[]>();
    for (const l of legs) {
      let g = byOutcome.get(l.outcome_id);
      if (!g) { g = []; byOutcome.set(l.outcome_id, g); }
      g.push(l);
    }
    const droppedLegs = new Set<LegMappingItem>();
    for (const [oid, group] of byOutcome) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((x, y) => x.market_id - y.market_id);
      const accepted: LegMappingItem[] = [ordered[0]];
      for (let i = 1; i < ordered.length; i++) {
        const cand = ordered[i];
        let conflict: string | null = null;
        for (const acc of accepted) {
          const c = pairConflict(acc, cand);
          if (c) {
            conflict = `outcome "${oid}": market ${cand.market_id} vs ${acc.market_id} — ${c}`;
            break;
          }
        }
        if (conflict) {
          droppedLegs.add(cand);
          warnings.push(`leg-coherence drop: ${conflict}`);
        } else {
          accepted.push(cand);
        }
      }
    }
    if (droppedLegs.size > 0) {
      const survivors = legs.filter((l) => !droppedLegs.has(l));
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(survivors.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          return {
            kind: 'reject',
            reason: `per-leg date/metric_scope conflict drops every "${p}" leg (${droppedLegs.size} dropped) — fused legs disagree on condition_date/metric_scope, no fungible leg pairing remains`,
          };
        }
      }
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [leg-coherence guard dropped ${droppedLegs.size} leg(s): ${
        [...droppedLegs].map((l) => `${l.platform}:${l.market_id}`).join(', ')}]`;
    }
  }

  // Iterates the DiscriminatorSpec registry so a new discriminator activates
  // this belt with zero edits here.
  if (legs.length > 1 && coherenceSpecs().length > 0) {
    const legVal = (spec: DiscriminatorSpec, mid: number): string | null => {
      const j = ctx.marketDiscriminators?.get(mid)?.[spec.name];
      if (j != null) return j;
      if (spec.gatedField === 'metric_scope') return ctx.reconcileMetricScope?.get(mid) ?? null;
      // an unshaped market (no discriminators JSONB) can still carry the fact
      // only in its title, so re-extract live for title-regex specs.
      if (spec.source === 'title-regex') {
        const title = ctx.marketTitle?.get(mid) ?? '';
        if (title) {
          return spec.extract({
            title,
            outcomeLabel: null,
            eventKind: ctx.marketEventKind?.get(mid) ?? null,
            matchSource: null,
            platform: ctx.marketPlatform.get(mid) ?? '',
            raw: null,
            gated: {},
            kb: null,
          });
        }
      }
      return null;
    };
    const { drop, drops, perSpec } = discriminatorCoherenceDrops(legs, legVal);
    if (drop.size > 0) {
      const survivors = legs.filter((l) => !drop.has(l.market_id));
      const platformsBefore = new Set(legs.map((l) => l.platform));
      const platformsAfter = new Set(survivors.map((l) => l.platform));
      for (const p of platformsBefore) {
        if (!platformsAfter.has(p)) {
          return {
            kind: 'reject',
            reason: `discriminator leg-coherence drops every "${p}" leg (${drop.size} dropped) — fused legs disagree on a registry discriminator, no fungible leg pairing remains`,
          };
        }
      }
      for (const [spec, n] of Object.entries(perSpec)) beltHit(`stage3_disc_coherence.${spec}`, { n });
      for (const d of drops) {
        warnings.push(`disc leg-coherence drop: outcome "${d.outcome_id}" market ${d.market_id} — ${d.detail}`);
      }
      result.leg_mapping = survivors;
      legs = survivors;
      result.reasoning = `${result.reasoning ?? ''} [discriminator-coherence guard dropped ${drop.size} leg(s): ${
        [...drop].join(', ')}]`;
    }
  }

  // An N-platform expansion accretes prior legs the pair-local check never sees; reject a 2nd outcome_id claiming the same subject, or a re-bound market.
  if (ctx.priorLegs && ctx.priorLegs.length > 0) {
    // residual outcome_ids are subject-less, exempt from the subject collision.
    const residualOutcomeIds = new Set(
      outcomeSet.filter((o) => o.is_residual).map((o) => o.outcome_id),
    );
    const subjectOwner = new Map<string, string>(); // folded subject → outcome_id
    const marketOwner = new Map<number, string>(); // market_id → outcome_id

    const foldSubject = (s: string | null | undefined): string | null => {
      const t = (s ?? '').trim().toLowerCase();
      return t === '' ? null : t;
    };
    const claimSubject = (subj: string | null, oid: string): MatchVerdict | null => {
      if (subj == null) return null;
      const prior = subjectOwner.get(subj);
      if (prior !== undefined && prior !== oid) {
        return {
          kind: 'reject',
          reason: `outcome_subject "${subj}" claimed by two outcomes "${prior}" and "${oid}" `
            + `across the expansion union — duplicate winner / double-mapped Σ=1 slot`,
        };
      }
      subjectOwner.set(subj, oid);
      return null;
    };

    // Reconciliation (default on): re-key a pure id-drift duplicate (e.g. `argentina` vs `argentina_win`) to the prior outcome_id when subject/scope/event provably agree.
    const reconcileOn = ctx.reconcileEnabled !== false;
    if (reconcileOn) {
      const priorBySubject = new Map<string, { oid: string; metricScope: string | null | undefined; canonicalEvent: string | null | undefined; eventKind: string | null | undefined }>();
      for (const pl of ctx.priorLegs) {
        if (residualOutcomeIds.has(pl.outcome_id)) continue;
        const subj = foldSubject(pl.outcome_subject);
        if (subj == null) continue;
        if (!priorBySubject.has(subj)) {
          priorBySubject.set(subj, { oid: pl.outcome_id, metricScope: pl.metric_scope, canonicalEvent: pl.canonical_event, eventKind: pl.event_kind });
        }
      }
      const newOutcomeIds = new Set(outcomeSet.map((o) => o.outcome_id));
      // consistent known per-leg fact of a new outcome; mixed/unknown → undefined.
      const newOutcomeLegFact = (oid: string, map: Map<number, string | null> | undefined): string | null | undefined => {
        if (!map) return undefined;
        let val: string | null | undefined;
        let seen = false;
        for (const l of legs) {
          if (l.outcome_id !== oid) continue;
          const ms = map.get(l.market_id);
          if (!seen) { val = ms; seen = true; }
          else if (val !== ms) return undefined; // mixed within the outcome ⇒ unknown
        }
        return seen ? val : undefined;
      };
      const newOutcomeMetricScope = (oid: string) => newOutcomeLegFact(oid, ctx.reconcileMetricScope);
      const scopeEqual = (a: string | null | undefined, b: string | null | undefined): boolean =>
        a != null && b != null && a === b; // both KNOWN and equal (NULL is not 'known')
      const provablyDifferent = (a: string | null | undefined, b: string | null | undefined): boolean =>
        a != null && b != null && a !== b; // both KNOWN and unequal
      for (const o of outcomeSet) {
        if (o.is_residual) continue;
        const subj = foldSubject(o.outcome_subject);
        if (subj == null) continue;
        const prior = priorBySubject.get(subj);
        if (!prior || prior.oid === o.outcome_id) continue;
        if (newOutcomeIds.has(prior.oid)) continue; // already a distinct new outcome → real partition, let the union check decide
        const strictOk =
          scopeEqual(newOutcomeMetricScope(o.outcome_id), prior.metricScope) &&
          scopeEqual(ctx.newCanonicalEvent, prior.canonicalEvent);
        // fold gate: the new id is provably a re-spelling of the prior id for
        // this shared subject (canonicalOutcomeKey); id-only, never the label.
        let foldOk = false;
        if (!strictOk) {
          const sf = foldLabelKey(o.outcome_subject!);
          const kPrior = canonicalOutcomeKey(prior.oid, sf);
          const kNewId = canonicalOutcomeKey(o.outcome_id, sf);
          foldOk =
            kPrior != null &&
            kNewId === kPrior &&
            !provablyDifferent(newOutcomeMetricScope(o.outcome_id), prior.metricScope) &&
            !provablyDifferent(newOutcomeLegFact(o.outcome_id, ctx.marketEventKind), prior.eventKind) &&
            !provablyDifferent(ctx.newCanonicalEvent, prior.canonicalEvent);
        }
        if (!strictOk && !foldOk) continue;
        const fromId = o.outcome_id;
        o.outcome_id = prior.oid;
        for (const l of legs) if (l.outcome_id === fromId) l.outcome_id = prior.oid;
        if (foldOk) {
          warnings.push(
            `label-fold reconcile: expansion outcome "${fromId}" re-keyed to prior "${prior.oid}" `
            + `(both fold to one canonical outcome for subject "${o.outcome_subject}")`,
          );
        }
      }
    }

    // Seed from prior legs (the union the per-pair guard never saw).
    for (const pl of ctx.priorLegs) {
      if (!residualOutcomeIds.has(pl.outcome_id)) {
        const subj = foldSubject(pl.outcome_subject);
        const v = claimSubject(subj, pl.outcome_id);
        if (v) return v;
      }
      marketOwner.set(pl.market_id, pl.outcome_id);
    }

    // Fold the new outcomes' subjects in (a 2nd distinct outcome claiming a
    // prior-owned subject is the duplicate-winner signature).
    for (const o of outcomeSet) {
      if (o.is_residual) continue;
      const subj = foldSubject(o.outcome_subject);
      const v = claimSubject(subj, o.outcome_id);
      if (v) return v;
    }

    // a new leg re-binding a market to a different outcome_id than a prior leg
    // double-maps it (catches subject-null cases the subject check would miss).
    for (const l of legs) {
      const owner = marketOwner.get(l.market_id);
      if (owner !== undefined && owner !== l.outcome_id) {
        return {
          kind: 'reject',
          reason: `market_id ${l.market_id} already bound to outcome "${owner}" but the new pair `
            + `binds it to "${l.outcome_id}" — double-mapped market across the expansion union`,
        };
      }
      marketOwner.set(l.market_id, l.outcome_id);
    }
  }

  // Covers a brand-new pair with no prior legs: a market prices exactly one question, so it can own exactly one outcome node.
  {
    const withinOwner = new Map<number, string>();
    for (const l of legs) {
      const owner = withinOwner.get(l.market_id);
      if (owner !== undefined && owner !== l.outcome_id) {
        return {
          kind: 'reject',
          reason: `market_id ${l.market_id} is bound to BOTH outcome "${owner}" and outcome "${l.outcome_id}" `
            + `within this candidate — one market prices one question, so a double-map is a mis-legged proposal (P10)`,
        };
      }
      withinOwner.set(l.market_id, l.outcome_id);
    }
  }

  // A platform never lists the same question twice: one outcome_id fed by >=2 distinct platform_events is a sibling-event identity collision.
  if (ctx.priorLegs && ctx.priorLegs.length > 0) {
    const residualOutcomeIds = new Set(
      outcomeSet.filter((o) => o.is_residual).map((o) => o.outcome_id),
    );
    const feed = new Map<string, Map<string, Set<number>>>(); // outcome_id → platform → pe ids
    const note = (oid: string, platform: string | null | undefined, peId: number | null | undefined) => {
      if (residualOutcomeIds.has(oid)) return;
      if (!platform || peId == null) return;
      let byP = feed.get(oid);
      if (!byP) { byP = new Map(); feed.set(oid, byP); }
      let s = byP.get(platform);
      if (!s) { s = new Set(); byP.set(platform, s); }
      s.add(peId);
    };
    for (const pl of ctx.priorLegs) note(pl.outcome_id, pl.platform, pl.platform_event_id);
    for (const l of legs) note(l.outcome_id, l.platform, ctx.marketPlatformEvent?.get(l.market_id));
    for (const [oid, byP] of feed) {
      for (const [platform, peSet] of byP) {
        if (peSet.size >= 2) {
          beltHit('same_platform_sibling_refuse', { outcome: oid, platform });
          return {
            kind: 'reject',
            reason: `outcome "${oid}" fused across ${peSet.size} distinct "${platform}" platform_events `
              + `(${[...peSet].sort((a, b) => a - b).join(', ')}) — a platform never lists the same `
              + `question twice, so same-platform sibling events must not merge into one question node`,
          };
        }
      }
    }
  }

  // Settling at regulation (tie possible) vs incl. overtime (decides a winner) are different outcome spaces.
  const scopesByOutcome = new Map<string, Set<string>>();
  for (const l of legs) {
    const sc = ctx.marketScope.get(l.market_id);
    if (!sc || sc === 'unspecified') continue;
    let s = scopesByOutcome.get(l.outcome_id);
    if (!s) { s = new Set(); scopesByOutcome.set(l.outcome_id, s); }
    s.add(sc);
  }
  for (const [oid, scopes] of scopesByOutcome) {
    if (scopes.size > 1) {
      return { kind: 'reject', reason: `outcome "${oid}" merges differing resolution scopes: ${[...scopes].sort().join(', ')}` };
    }
  }

  // The scope check above asks when a market settles; this asks what quantity it settles on.
  if (ctx.marketSettlementDimension && ctx.marketSettlementDimension.size > 0) {
    const dimsByOutcome = new Map<string, Set<string>>();
    for (const l of legs) {
      const d = ctx.marketSettlementDimension.get(l.market_id);
      if (d == null || d === '') continue;
      let s = dimsByOutcome.get(l.outcome_id);
      if (!s) { s = new Set(); dimsByOutcome.set(l.outcome_id, s); }
      s.add(d);
    }
    for (const [oid, dims] of dimsByOutcome) {
      if (dims.size > 1) {
        const shown = [...dims].sort();
        beltHit('settlement_dimension_refuse', { outcome: oid, dims: shown.join(' vs ') });
        return {
          kind: 'reject',
          reason: `outcome "${oid}" merges legs that settle on DIFFERENT measured quantities: `
            + `${shown.join(' vs ')} — a different settlement dimension is a DIFFERENT question `
            + `even on the same competitors, event and date`,
        };
      }
    }
  }

  // An outcome must not merge a halftime-leader leg with a whole-match leg —
  // they resolve at different periods, so they can co-occur.
  if (ctx.marketEventKind && ctx.marketEventKind.size > 0) {
    const kindsByOutcome = new Map<string, Set<string>>();
    for (const l of legs) {
      const k = ctx.marketEventKind.get(l.market_id);
      if (k == null) continue;
      let s = kindsByOutcome.get(l.outcome_id);
      if (!s) { s = new Set(); kindsByOutcome.set(l.outcome_id, s); }
      s.add(k);
    }
    for (const [oid, kinds] of kindsByOutcome) {
      if (kinds.has('halftime_leader') && [...kinds].some((k) => WHOLE_MATCH_KINDS.has(k))) {
        return { kind: 'reject', reason: `outcome "${oid}" merges a halftime-leader leg with whole-match market(s) — different resolution period` };
      }
    }
  }

  // A categorical_exclusive set must be one partition at one grain.
  if (grouping === 'categorical_exclusive') {
    const nonResidual = outcomeSet.filter((o) => !o.is_residual);
    // `|| ''` guard: label can also be null at runtime despite its TS type,
    // and subjectOf(o).toLowerCase() below would throw without it.
    const subjectOf = (o: OutcomeSetItem) => (o.outcome_subject && o.outcome_subject.trim()) || o.label || '';

    // 1. anonymized placeholder mixed with a named outcome — different grain.
    const placeholders = nonResidual.filter((o) => isPlaceholderSubject(subjectOf(o)));
    const named = nonResidual.filter((o) => !isPlaceholderSubject(subjectOf(o)));
    if (placeholders.length > 0 && named.length > 0) {
      return {
        kind: 'reject',
        reason: `categorical_exclusive mixes anonymized placeholder outcome(s) `
          + `[${placeholders.slice(0, 3).map(subjectOf).join(', ')}] with named outcomes — different partition grain`,
      };
    }

    // 2. aggregate vs members: a party/organization can't be a mutex sibling of
    //    >=2 person outcomes (a candidate runs FOR a party).
    if (ctx.subjectType && ctx.subjectType.size > 0) {
      let orgs = 0;
      let persons = 0;
      for (const o of nonResidual) {
        const t = ctx.subjectType.get(subjectOf(o).toLowerCase()) ?? null;
        if (t === 'organization' || t === 'party') orgs++;
        else if (t === 'person') persons++;
      }
      if (orgs >= 1 && persons >= 2) {
        return {
          kind: 'reject',
          reason: `categorical_exclusive mixes ${orgs} organization/party outcome(s) with ${persons} person outcomes — aggregate vs members`,
        };
      }
    }

    // 2c. Party-aggregate contains candidate (election-winner scope only): check 2
    //     starves when candidates are unresolved in the KB (no `person` type), so
    //     this arm also counts an unresolved, candidate-name-shaped sibling.
    if (ctx.subjectType && ctx.subjectType.size > 0) {
      let electionScope = false;
      if (ctx.marketEventKind) {
        for (const l of legs) {
          const k = ctx.marketEventKind.get(l.market_id);
          if (k != null && ELECTION_WINNER_KINDS.has(k)) { electionScope = true; break; }
        }
      }
      if (!electionScope) {
        for (const k of ctx.priorLegEventKinds ?? []) {
          if (k != null && ELECTION_WINNER_KINDS.has(k)) { electionScope = true; break; }
        }
      }
      if (electionScope) {
        const subs = nonResidual.map((o) => {
          const s = subjectOf(o);
          return { subject: s, type: ctx.subjectType!.get(s.toLowerCase()) ?? null };
        });
        const r = electionContainmentReject(subs);
        if (r.fire) {
          return {
            kind: 'reject',
            reason: `categorical_exclusive (election winner scope) mixes ${r.aggregates} party/organization aggregate outcome(s) with ${r.members} candidate outcomes — a candidate runs FOR a party, so the party CONTAINS the candidate (aggregate-vs-members containment)`,
          };
        }
      }
    }

    // 2b. Independent-aggregate containment: a generic 'independent' outcome is
    //     an aggregate over that race's independent candidates, so a sibling
    //     person KB-stamped party='Independent' co-resolves with it. Slips both
    //     arms above since 'independent' is not a KB org and check 2 allows persons==1.
    if (ctx.subjectParty && ctx.subjectParty.size > 0) {
      const INDEPENDENT_LABEL_RX = /^(?:an?\s+)?independents?(?:\s+(?:candidate|party))?$/i;
      const generic = nonResidual.find((o) => INDEPENDENT_LABEL_RX.test(subjectOf(o).trim()));
      if (generic) {
        const contained = nonResidual.find((o) => {
          if (o === generic) return false;
          const subj = subjectOf(o).toLowerCase();
          const t = ctx.subjectType?.get(subj) ?? null;
          const party = ctx.subjectParty!.get(subj) ?? null;
          return t === 'person' && party != null && /^independent$/i.test(party);
        });
        if (contained) {
          return {
            kind: 'reject',
            reason: `categorical_exclusive contains a generic independent aggregate `
              + `("${subjectOf(generic)}") alongside independent candidate "${subjectOf(contained)}" `
              + `— candidate ⊂ aggregate, they co-resolve (independent-aggregate containment)`,
          };
        }
      }
    }

    // 3. period-grain (set-level): the per-outcome hardstop above is pair-local, so
    //    check the union of current + prior-leg kinds too (an HT platform_event can
    //    accrete into an SE that already holds a whole-match leg via a prior pair).
    if (ctx.marketEventKind || ctx.priorLegEventKinds) {
      const setKinds = new Set<string>();
      if (ctx.marketEventKind) {
        for (const l of legs) {
          const k = ctx.marketEventKind.get(l.market_id);
          if (k != null) setKinds.add(k);
        }
      }
      for (const k of ctx.priorLegEventKinds ?? []) {
        if (k != null) setKinds.add(k);
      }
      if (setKinds.has('halftime_leader') && [...setKinds].some((k) => WHOLE_MATCH_KINDS.has(k))) {
        return {
          kind: 'reject',
          reason: `categorical_exclusive partition mixes a halftime-leader leg with whole-match market(s) — co-occurrable across periods, not mutually exclusive`,
        };
      }
    }

    // 4. Cross-fixture bridge (set-level, expansion-aware): a NULL-date single-team
    //    bridge platform-event ("Will Arsenal win?") can accrete two different
    //    dated fixtures into one SE, asserting their draws mutually exclusive
    //    though they genuinely co-occur. Check the union of new + prior legs on
    //    (a) condition_date at the coarser stamped precision and (b) per-market
    //    canonical_event participant pairs. NULL-tolerant: only positive
    //    two-sided evidence rejects.
    {
      type FixtureLeg = {
        ce: string | null; date: string | null; prec: string | null;
        instant: FixtureInstantFacts;
      };
      const fixtureLegs: FixtureLeg[] = [];
      if (ctx.marketEventKind) {
        for (const l of legs) {
          const k = ctx.marketEventKind.get(l.market_id);
          if (k == null || !FIXTURE_KINDS.has(k)) continue;
          const d = ctx.marketDates?.get(l.market_id);
          fixtureLegs.push({
            ce: ctx.marketCanonicalEvent?.get(l.market_id) ?? null,
            date: d?.condition_date ?? null,
            prec: d?.condition_date_precision ?? null,
            instant: {
              platform: l.platform,
              end_date: d?.end_date ?? null,
              condition_date: d?.condition_date ?? null,
              condition_date_precision: d?.condition_date_precision ?? null,
            },
          });
        }
      }
      for (const pl of ctx.priorLegs ?? []) {
        const k = pl.event_kind;
        if (k == null || !FIXTURE_KINDS.has(k)) continue;
        fixtureLegs.push({
          ce: pl.market_canonical_event ?? null,
          date: pl.condition_date ?? null,
          prec: pl.condition_date_precision ?? null,
          instant: {
            platform: null,
            end_date: null,
            condition_date: pl.condition_date ?? null,
            condition_date_precision: pl.condition_date_precision ?? null,
          },
        });
      }
      if (fixtureLegs.length >= 2) {
        // (a) two known condition_dates differing at the coarser precision, or
        //     two trusted start instants diverging even when day keys collide
        //     (same representation-seam issue as the per-leg guard above).
        const dated = fixtureLegs.filter((f) => f.date != null);
        for (let i = 0; i < dated.length; i++) {
          for (let j = i + 1; j < dated.length; j++) {
            const rank = Math.max(precisionRank(dated[i].prec), precisionRank(dated[j].prec));
            if (grainKeyAt(dated[i].date!, rank) !== grainKeyAt(dated[j].date!, rank)
                || fixtureStartInstantsDiverge(
                     fixtureStartInstantMs(dated[i].instant),
                     fixtureStartInstantMs(dated[j].instant))) {
              return {
                kind: 'reject',
                reason: `categorical_exclusive fixture partition spans two matches: condition_date `
                  + `'${dated[i].date}' vs '${dated[j].date}' — different fixtures' outcomes are not `
                  + `mutually exclusive (cross-fixture bridge)`,
              };
            }
          }
        }
        // (b) ≥2 provably-distinct fixture participant pairs.
        const fixtures: { participants: [string, string]; raw: string }[] = [];
        for (const f of fixtureLegs) {
          const p = parseFixtureParticipants(f.ce);
          if (p) fixtures.push({ participants: p, raw: f.ce! });
        }
        const { count, samples } = countDistinctFixtures(fixtures);
        if (count > 1) {
          return {
            kind: 'reject',
            reason: `categorical_exclusive fixture partition spans ${count} distinct fixtures `
              + `[${samples.slice(0, 3).join(' | ')}] — different fixtures' outcomes are not `
              + `mutually exclusive (cross-fixture bridge)`,
          };
        }
      }
    }

    // 5. Count-distribution predicate coherence (set-level, expansion-aware): a
    //    count-bucket categorical (all outcomes are count tokens) whose legs span
    //    >=2 distinct Kalshi series provably fuses 2 distinct counted predicates
    //    (Kalshi models one count question as exactly one series). Checks the
    //    union of new + prior-leg series (a pair-local view sees only one).
    {
      const nonResidual = outcomeSet.filter((o) => !o.is_residual);
      const isCountSet =
        nonResidual.length >= 2 &&
        nonResidual.every((o) =>
          isCountDistributionToken(o.label) ||
          isCountDistributionToken(o.outcome_id) ||
          isCountDistributionToken(o.outcome_subject));
      if (isCountSet && (ctx.marketKalshiSeries || (ctx.priorLegs && ctx.priorLegs.length))) {
        const series = new Set<string>();
        if (ctx.marketKalshiSeries) {
          for (const l of legs) {
            const s = ctx.marketKalshiSeries.get(l.market_id);
            if (s) series.add(s);
          }
        }
        for (const pl of ctx.priorLegs ?? []) {
          if (pl.kalshi_series) series.add(pl.kalshi_series);
        }
        if (series.size >= 2) {
          return {
            kind: 'reject',
            reason: `categorical_exclusive count-distribution fuses ${series.size} distinct Kalshi count `
              + `series [${[...series].sort().slice(0, 3).join(', ')}] — different counted predicates are `
              + `not one partition (count-predicate coherence)`,
          };
        }
      }
    }

    // 6. Grain homogeneity: legs spanning >1 outcome grain (winner, exact_score,
    //    spread, over_under, …) genuinely co-occur, so the asserted mutex is fake.
    //    The neutral complement outcome ("draw") is excluded. Expansion-aware:
    //    folds the prior SE's legs into the union too.
    {
      const kindsByOutcome = new Map<string, Set<string>>();
      if (ctx.marketEventKind) {
        for (const l of legs) {
          const k = ctx.marketEventKind.get(l.market_id);
          if (k == null) continue;
          let s = kindsByOutcome.get(l.outcome_id);
          if (!s) { s = new Set(); kindsByOutcome.set(l.outcome_id, s); }
          s.add(k);
        }
      }
      const grainCounts = new Map<OutcomeGrain, number>();
      const sampleByGrain = new Map<OutcomeGrain, string>();
      const seenOutcome = new Set<string>();
      const consider = (oid: string, subject: string | null | undefined, label: string | null | undefined) => {
        if (seenOutcome.has(oid)) return;
        seenOutcome.add(oid);
        const g = outcomeGrain(oid, subject, label, [...(kindsByOutcome.get(oid) ?? [])]);
        if (g === 'neutral') return;
        grainCounts.set(g, (grainCounts.get(g) ?? 0) + 1);
        if (!sampleByGrain.has(g)) sampleByGrain.set(g, oid);
      };
      for (const o of nonResidual) consider(o.outcome_id, o.outcome_subject, o.label);
      for (const pl of ctx.priorLegs ?? []) {
        consider(pl.outcome_id, pl.outcome_subject, null);
      }
      // numeric_band lone-bucket collapse: a count/cap tiling's sole overflow
      // bucket is one axis with 'winner', not a fusion (mirrors Stage-4 feed-A).
      const grains = effectiveRealGrains(grainCounts);
      if (grains.size > 1) {
        const list = [...grains].map((g) => `${g}:${sampleByGrain.get(g)}`).sort();
        return {
          kind: 'reject',
          reason: `categorical_exclusive partition spans ${grains.size} outcome grains `
            + `[${list.join(', ')}] — legs of different grains co-occur, not a valid mutex (grain homogeneity)`,
        };
      }
    }

    // 7. Cross-platform zero-overlap veto — log-first, not hard-refuse (a legit
    //    disjoint-candidate merge fits the same shape, so demoting would cost
    //    recall). Zero cross-platform overlap + >=2 platforms each contributing
    //    >=3 exclusive outcomes is the aggregate-vs-member merge signature
    //    (e.g. team winners fused with region winners); single-grain, so check 6
    //    doesn't catch it.
    if (nonResidual.length > 0) {
      const residualIds = new Set(outcomeSet.filter((o) => o.is_residual).map((o) => o.outcome_id));
      const platformsByOutcome = new Map<string, Set<string>>();
      for (const l of legs) {
        if (residualIds.has(l.outcome_id)) continue;
        let s = platformsByOutcome.get(l.outcome_id);
        if (!s) { s = new Set(); platformsByOutcome.set(l.outcome_id, s); }
        s.add(l.platform);
      }
      let anyOverlap = false;
      const perPlatform = new Map<string, number>();
      for (const plats of platformsByOutcome.values()) {
        if (plats.size >= 2) { anyOverlap = true; break; }
        for (const p of plats) perPlatform.set(p, (perPlatform.get(p) ?? 0) + 1);
      }
      if (!anyOverlap) {
        const bigSides = [...perPlatform.entries()].filter(([, c]) => c >= 3);
        if (bigSides.length >= 2) {
          beltHit('stage3_categorical_xplat_zero_overlap');
          warnings.push(
            `categorical_exclusive has ZERO cross-platform outcome overlap with `
            + `${bigSides.map(([p, c]) => `${p}:${c}`).join(', ')} exclusive outcomes per side — `
            + `aggregate-vs-member merge signature (e.g. teams vs regions); FLAGGED for triage, `
            + `NOT demoted (mechanism 4 log-first)`,
          );
        }
      }
    }
  }

  // Unconditional on grouping_kind — a candle×price merge is a different event
  // in every grouping. Union of current-leg + prior-leg kinds.
  if (ctx.marketEventKind || ctx.priorLegEventKinds) {
    const crossKinds = new Set<string>();
    if (ctx.marketEventKind) {
      for (const l of legs) {
        const k = ctx.marketEventKind.get(l.market_id);
        if (k != null) crossKinds.add(k);
      }
    }
    for (const k of ctx.priorLegEventKinds ?? []) {
      if (k != null) crossKinds.add(k);
    }

    // a close at 2350 is both "up" (candle_direction) and "above 2300"
    // (price-level), so co-occurrable slots must never merge as a mutex.
    if (crossKinds.has('candle_direction')) {
      const lvl = [...crossKinds].find((k) => PRICE_LEVEL_KINDS.has(k));
      if (lvl) {
        return {
          kind: 'reject',
          reason: `merges candle_direction (close vs open) with absolute price-level market(s) `
            + `(${lvl}) — different outcome spaces, not a valid mutex/ladder`,
        };
      }
    }

    for (const [k1, k2] of NEVER_SAME_EVENT) {
      if (crossKinds.has(k1) && crossKinds.has(k2)) {
        return {
          kind: 'reject',
          reason: `partition mixes incompatible event_kinds ${k1}+${k2} — never the same event`,
        };
      }
    }
  }

  // A threshold ladder is one subject's thresholds; legs spanning >=2 distinct
  // known canonical_subjects fused different real-world subjects into one ladder.
  // Exempts per-fixture sports kinds (FIXTURE_KINDS carry per-team subjects, so
  // one fixture legitimately spans 2 subjects). Checks the union of pair legs +
  // prior legs (ctx.priorLeg*), covering multi-hop expansion accretion.
  if (grouping === 'threshold_series' && (ctx.marketSubject || ctx.priorLegSubjects)) {
    const anyFixture =
      (!!ctx.marketEventKind &&
        legs.some((l) => {
          const k = ctx.marketEventKind!.get(l.market_id);
          return k != null && FIXTURE_KINDS.has(k);
        })) ||
      (ctx.priorLegEventKinds ?? []).some((k) => k != null && FIXTURE_KINDS.has(k));
    if (!anyFixture) {
      // A fixture-placeholder subject ("Arsenal vs Everton") is an event name,
      // not a subject, and would silently satisfy every same-subject test here —
      // collected separately, used only to refuse the mixed shape below.
      const subjects = new Set<string>();
      const fixtureShaped = new Set<string>();
      const addSubject = (s: string | null | undefined): void => {
        if (!s || !s.trim()) return;
        const t = s.trim();
        if (isFixturePlaceholderSubject(t)) fixtureShaped.add(t.toLowerCase());
        else subjects.add(t.toLowerCase());
      };
      if (ctx.marketSubject) {
        for (const l of legs) addSubject(ctx.marketSubject.get(l.market_id));
      }
      for (const s of ctx.priorLegSubjects ?? []) addSubject(s);
      // a fixture-shaped subject beside a real one spans a whole-fixture claim
      // and a per-entity claim — not rungs of one variable.
      if (fixtureShaped.size > 0 && subjects.size > 0) {
        return {
          kind: 'reject',
          reason: `threshold_series mixes fixture-placeholder subject(s) [${[...fixtureShaped].slice(0, 2).join(', ')}] `
            + `with real subject(s) [${[...subjects].slice(0, 2).join(', ')}] — the "A vs B" string is an EVENT name, `
            + `not a subject, so the same-subject evidence for this merge does not exist (P3)`,
        };
      }
      if (subjects.size === 0 && countDistinctSubjects(fixtureShaped) > 1) {
        return {
          kind: 'reject',
          reason: `threshold_series spans ${fixtureShaped.size} distinct fixture-placeholder subjects `
            + `[${[...fixtureShaped].slice(0, 4).join(', ')}] — different fixtures are different events (P3)`,
        };
      }
      // Drift-tolerant count: alias spellings (one a prefix/suffix run of the
      // other) collapse, so the KB's residual aliasing doesn't FALSE-REJECT a
      // legit single-subject ladder. A genuine multi-subject fusion stays ≥2.
      const distinct = countDistinctSubjects(subjects);
      if (distinct > 1) {
        return {
          kind: 'reject',
          reason: `threshold_series spans ${distinct} distinct subjects [${[...subjects].slice(0, 4).join(', ')}] — cross-subject over-merge`,
        };
      }
    }
  }

  if (grouping === 'threshold_series') {
    const ordinals = outcomeSet.map((o) => o.ordinal);
    if (ordinals.some((o) => o == null || !Number.isInteger(o))) {
      return { kind: 'reject', reason: 'threshold_series outcome missing integer ordinal' };
    }
    const sorted = [...(ordinals as number[])].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) {
        return { kind: 'reject', reason: `threshold_series has duplicate ordinal ${sorted[i]}` };
      }
    }
  }

  // The window is advisory metadata, so a violation NULLs it rather than
  // rejecting the match: the claimed [lo, hi] must contain, with tolerance, the
  // min/max member date (condition_date, else end_date as last resort).
  if (result.deadline_window_iso !== undefined && ctx.marketDates && ctx.marketDates.size > 0) {
    const TOL_MS = 2 * 86_400_000; // ±2 days
    const win = result.deadline_window_iso;
    let violation: string | null = null;
    if (!Array.isArray(win) || win.length !== 2 || typeof win[0] !== 'string' || typeof win[1] !== 'string') {
      violation = 'malformed window payload';
    } else {
      const lo = parseIsoMs(win[0]);
      const hi = parseIsoMs(win[1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        violation = `unparseable window bounds [${String(win[0])}, ${String(win[1])}]`;
      } else if (lo > hi) {
        violation = `inverted window [${win[0]} > ${win[1]}]`;
      } else {
        let minMs = Infinity;
        let maxMs = -Infinity;
        let minRaw = '';
        let maxRaw = '';
        for (const l of legs) {
          const d = ctx.marketDates.get(l.market_id);
          const raw = d?.condition_date ?? d?.end_date ?? null;
          if (raw == null) continue;
          const ms = parseIsoMs(raw);
          if (!Number.isFinite(ms)) continue;
          if (ms < minMs) { minMs = ms; minRaw = raw; }
          if (ms > maxMs) { maxMs = ms; maxRaw = raw; }
        }
        if (minMs <= maxMs) {
          if (minMs < lo - TOL_MS) {
            violation = `member date ${minRaw} precedes window start ${win[0]} by >2 days`;
          } else if (maxMs > hi + TOL_MS) {
            violation = `member date ${maxRaw} exceeds window end ${win[1]} by >2 days`;
          }
        }
      }
    }
    if (violation) {
      result.deadline_window_iso = undefined;
      warnings.push(
        `deadline-window verification failed (${violation}) — window NULLed, match kept (advisory metadata; a wrong window is worse than none)`,
      );
    }
  }

  return { kind: 'match', warnings, demotedNonExhaustive };
}
