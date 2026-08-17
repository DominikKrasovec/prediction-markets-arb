/**
 * Stage 3b-pre — deterministic pair confirmation (no LLM). Confirms candidate
 * pairs whose identity is arithmetic/structural (categorical option-set
 * equality, or a numeric ladder with an identical boundary set) and leaves
 * the rest for the LLM. Runs after the candle matcher, before runEventMatch.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { resolveSubjectViaKB } from '../db/entity/resolvers.js';
import { spaceInvariantVariant } from '../db/entity/tokens.js';
import { isNeverSameKindPair, neverSameKindTag } from './never-same-kind-pairs.js';
import { eventMarketType, u7RejectTag } from './kalshi-series-type-pairs.js';
import {
  FIXTURE_PARTICIPANT_COMPARE_KINDS, resolveTeamCanonical, isDisjointDifferentFixture,
} from './idioms/team-identity.js';
import { areSportsCompatible } from '../db/entity/sport-hierarchy.js';
import { areLeaguesCompatible } from '../db/entity/league-hierarchy.js';
import { unifiedToDomain } from '../db/category-taxonomy.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { settlementDimensionSql } from '../util/settlement-instrument.js';
import { looksCorrectScoreLabel } from '../stage1-normalize/kalshi-series.js';
import { beltHit } from '../discriminators/telemetry.js';
import { config } from '../config.js';
import {
  persistMatch, markCandidate, findSemanticEventIdForPlatformEvent, getSubjectPartyTypings,
  getSemanticEventLegSubjects,
  type LegInsert,
} from '../db/queries/semantic-events.js';
import {
  validateMatch, countDistinctSubjects, FIXTURE_KINDS, PRICE_LEVEL_KINDS,
  type EventMatchResult, type OutcomeSetItem, type LegMappingItem, type MatchContext,
} from './guards.js';
import type { NumericRegionFacts } from './numeric-region.js';
import type { UnifiedCategory } from '@arb/types';

const log = createLogger('confirm-deterministic');
const PAGE = parseInt(process.env.CONFIRM_PAGE_SIZE ?? '500', 10);
const CONCURRENCY = parseInt(process.env.CONFIRM_CONCURRENCY ?? '6', 10);
// DETERMINISTIC_DISJOINT_REJECT=0 reverts to deferring disjoint pairs to the LLM.
const DISJOINT_REJECT = process.env.DETERMINISTIC_DISJOINT_REJECT !== '0';

// Kinds with sound disjoint merges (fixtures, price-level etc); a reject only
// fires when both sides of a pair are outside this set.
const SUBJECT_DISJOINT_EXEMPT_KINDS = new Set<string>([
  ...FIXTURE_KINDS,
  ...PRICE_LEVEL_KINDS,
  'player_prop_threshold', 'weather_extreme', 'crypto_launch_fdv', 'token_launch',
  'candle_direction', 'policy_action',
]);

// Kinds where ticker/name drift can look disjoint; these re-decide via KB-resolved subjects.
const E1_DISJOINT_KINDS = new Set<string>([
  'crypto_launch_fdv', 'weather_extreme', 'policy_action',
]);

export interface ConfirmStats {
  categorical: number;
  numeric: number;
  expanded: number;
  rejected: number;
  deferred: number;
  f1_rejected?: number; // never-same-kind pair rule
  e1_rejected?: number; // same-kind KB-disjoint rule
  u1?: number; // Predict/Polymarket condition-id bridge
  u7_rejected?: number; // same-fixture different-type rule
  r4_rejected?: number; // fixture-participant different-fixture rule
}


const DRAW_LABELS = new Set([
  'draw', 'tie', 'tie/co-winners', 'tie / co-winners', 'decision / draw / no contest', 'no contest',
]);
const RESIDUAL_LABELS = new Set(['other', 'field', 'the field', 'none of the above', 'none of these']);

// Exact match (lowercased), never substring, so a real name containing "other"/"tie" survives as an entity.
export function classifyOption(label: string): 'DRAW' | 'RESIDUAL' | null {
  const t = label.trim().toLowerCase();
  if (!t) return 'RESIDUAL';
  if (/^draw\s*\(/.test(t)) return 'DRAW';
  if (DRAW_LABELS.has(t)) return 'DRAW';
  if (/^(any other|another)\b/.test(t)) return 'RESIDUAL';
  if (RESIDUAL_LABELS.has(t)) return 'RESIDUAL';
  return null;
}

// A prop/score label (e.g. "0-0", "over 2.5") means the event is a bundle, not
// a clean partition; any match defers the whole event to the LLM.
const PROP_LABEL_RX =
  /(\bexact score\b|\bcorrect score\b|\bover\b|\bunder\b|\babove\b|\bbelow\b|\bhandicap\b|\bboth teams\b|\bclean sheet\b|\bhalftime\b|\bfirst half\b|\banytime\b|\bto score\b|\bor (?:above|below|more|fewer|less)\b|\$\s*\d|\(\s*[-–]\s*\d|\d\s*[-–]\s*\d|[:+]\s*\$?\d|\d\s*\+)/i;
export function isPropLabel(label: string): boolean {
  return PROP_LABEL_RX.test(label);
}

export function slugifyOutcome(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return slug || 'x';
}

export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ordinal 1 = strictest (Stage-4 buildThresholdLadderEdges: lower ordinal ⟹
// higher/easier). 'above': strictest = highest X. 'below': strictest = lowest X.
export function thresholdOrdinals(values: number[], direction: 'above' | 'below'): Map<number, number> {
  const distinct = [...new Set(values)];
  distinct.sort((x, y) => (direction === 'above' ? y - x : x - y));
  const out = new Map<number, number>();
  distinct.forEach((v, i) => out.set(v, i + 1));
  return out;
}


export interface EventMeta {
  id: number;
  platform: string;
  title: string;
  grouping_type: string;
  canonical_subject: string | null;
  category: string | null;
  sport: string | null;
  league: string | null;
  event_kind: string | null;
  participants?: string[] | null;
  // True only on a positive platform signal that sibling markets are NOT
  // mutually exclusive; NULL means false, never refused on absence of evidence.
  native_independent: boolean;
}
export interface ChildRow {
  pe_id: number;
  market_id: number;
  platform: string;
  label: string | null;
  resolution_scope: string | null;
  sport: string | null;
  value_primary: number | null;
  value_secondary: number | null;
  value_unit: string | null;
  direction: string | null;
  shape: string | null;
  condition_metric: string | null;
  canonical_subject: string | null;
  event_kind: string | null;
  metric_scope: string | null;
  canonical_event: string | null;
  condition_date: string | null;
  condition_date_precision: string | null;
  strike_type: string | null;
  title: string | null;
  weather_text: string | null;
  settlement_dimension: string | null;
  discriminators: Record<string, string> | null;
  // Polymarket's on-chain condition id; Predict mirrors it via pm_condition_ids
  // below, which is how the cross-platform leg-join keys legs without labels.
  platform_id: string | null;
  pm_condition_ids: string[] | null;
  kalshi_series: string | null;
  native_outcomes: string[] | null;
}

function scopeCompatible(a: EventMeta, b: EventMeta): boolean {
  return areSportsCompatible(a.sport, b.sport) && areLeaguesCompatible(a.league, b.league);
}


export function childSubjectSet(children: ChildRow[]): Set<string> {
  const out = new Set<string>();
  for (const c of children) {
    const s = c.canonical_subject;
    if (s && s.trim()) out.add(s.trim().toLowerCase());
  }
  return out;
}

// Rejects (skips the LLM) when both event_kinds are non-exempt and the two
// child-subject sets share no element. Only ever shrinks the graph.
export function tryRejectDisjointSubjects(
  a: EventMeta, childrenA: ChildRow[], b: EventMeta, childrenB: ChildRow[],
): boolean {
  const ka = a.event_kind;
  const kb = b.event_kind;
  if (ka == null || kb == null) return false;
  if (SUBJECT_DISJOINT_EXEMPT_KINDS.has(ka) || SUBJECT_DISJOINT_EXEMPT_KINDS.has(kb)) return false;
  const sa = childSubjectSet(childrenA);
  const sb = childSubjectSet(childrenB);
  if (sa.size === 0 || sb.size === 0) return false;
  for (const x of sa) if (sb.has(x)) return false;
  return true;
}


async function resolvedSubjectKeys(ev: EventMeta, children: ChildRow[]): Promise<Set<string>> {
  const domain = unifiedToDomain((ev.category ?? null) as UnifiedCategory | null);
  const scope = { sport: ev.sport, league: ev.league };
  const out = new Set<string>();
  for (const c of children) {
    const s = c.canonical_subject;
    if (!s || !s.trim()) continue;
    const canon = await resolveSubjectViaKB(s.trim(), domain, scope);
    out.add(spaceInvariantVariant(canon) ?? canon.trim().toLowerCase());
  }
  return out;
}

// Two keys "share" identity if equal or one is a >=4-char prefix of the other,
// absorbing Stage-1 subject-stamp truncation. Only ever rejects, so a more
// generous share test can only drop rejects, never add a merge.
export function e1KeysShare(keysA: Set<string>, keysB: Set<string>): boolean {
  for (const x of keysA) {
    for (const y of keysB) {
      if (x === y) return true;
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      if (short.length >= 4 && long.startsWith(short)) return true;
    }
  }
  return false;
}

export function e1RejectTag(
  ka: string | null, kb: string | null, keysA: Set<string>, keysB: Set<string>,
): string | null {
  if (ka == null || ka !== kb || !E1_DISJOINT_KINDS.has(ka)) return null;
  if (keysA.size === 0 || keysB.size === 0) return null;
  if (e1KeysShare(keysA, keysB)) return null;
  return `deterministic: E1 same-kind disjoint subjects (${ka})`;
}

async function tryRejectE1Disjoint(
  a: EventMeta, childrenA: ChildRow[], b: EventMeta, childrenB: ChildRow[],
): Promise<string | null> {
  const ka = a.event_kind;
  if (ka == null || ka !== b.event_kind || !E1_DISJOINT_KINDS.has(ka)) return null;
  const sa = await resolvedSubjectKeys(a, childrenA);
  const sb = await resolvedSubjectKeys(b, childrenB);
  return e1RejectTag(ka, b.event_kind, sa, sb);
}


async function fixtureTeamSet(ev: EventMeta, memo: Map<number, Set<string> | null>): Promise<Set<string> | null> {
  const hit = memo.get(ev.id);
  if (hit !== undefined) return hit;
  let out: Set<string> | null = null;
  const parts = ev.participants ?? [];
  if (parts.length >= 2) {
    const domain = unifiedToDomain((ev.category ?? null) as UnifiedCategory | null);
    const teams = new Set<string>();
    for (const p of parts) {
      const c = await resolveTeamCanonical(p, domain, ev.sport, ev.league);
      if (c) teams.add(c);
    }
    if (teams.size === 2) out = teams;
  }
  memo.set(ev.id, out);
  return out;
}

// Rejects when both events resolve to exactly two KB teams each, and the two
// team-sets are disjoint and fuzzy-disjoint. Subtractive; never merges.
async function tryRejectFixtureParticipants(
  a: EventMeta, b: EventMeta, memo: Map<number, Set<string> | null>,
): Promise<string | null> {
  const ka = a.event_kind, kb = b.event_kind;
  if (ka == null || kb == null) return null;
  if (!FIXTURE_PARTICIPANT_COMPARE_KINDS.has(ka) || !FIXTURE_PARTICIPANT_COMPARE_KINDS.has(kb)) return null;
  const sa = await fixtureTeamSet(a, memo);
  const sb = await fixtureTeamSet(b, memo);
  if (!sa || !sb) return null;
  if (!isDisjointDifferentFixture(sa, sb)) return null;
  return 'deterministic: R4 fixture-participant different fixture (disjoint teams)';
}


interface OptionBuild { real: Map<string, number[]>; residual: number[]; }

// Positive-signal only: true iff either event's platform metadata proves its
// sibling markets are NOT mutually exclusive.
export function nativeIndependentRefusal(a: EventMeta, b: EventMeta): boolean {
  return a.native_independent === true || b.native_independent === true;
}

async function buildOptions(ev: EventMeta, children: ChildRow[]): Promise<OptionBuild | null> {
  const domain = unifiedToDomain((ev.category ?? null) as UnifiedCategory | null);
  const scope = { sport: ev.sport, league: ev.league };
  const real = new Map<string, number[]>();
  const residual: number[] = [];
  for (const c of children) {
    if (!c.label) return null;
    // A custom-strike exact-score label is a full scoreline; KB-resolving it to
    // the bare team/DRAW would collapse N scorelines into a false 1X2 one-hot.
    if (c.strike_type === 'custom' && looksCorrectScoreLabel(c.label)) {
      beltHit('exact_score_winner_project_refuse', { path: 'deterministic', series: c.kalshi_series ?? '' });
      return null;
    }
    const cls = classifyOption(c.label);
    if (cls === 'RESIDUAL') { residual.push(c.market_id); continue; }
    if (cls === null && isPropLabel(c.label)) return null;
    const canon = cls === 'DRAW' ? 'DRAW' : await resolveSubjectViaKB(c.label, domain, scope);
    (real.get(canon) ?? real.set(canon, []).get(canon)!).push(c.market_id);
  }
  return { real, residual };
}

async function tryCategorical(
  a: EventMeta, childrenA: ChildRow[], b: EventMeta, childrenB: ChildRow[],
): Promise<EventMatchResult | null> {
  if (!scopeCompatible(a, b)) return null;
  if (nativeIndependentRefusal(a, b)) return null;
  const oa = await buildOptions(a, childrenA);
  const ob = await buildOptions(b, childrenB);
  if (!oa || !ob) return null;

  const setA = new Set(oa.real.keys());
  const setB = new Set(ob.real.keys());
  // >=2 shared options and exact non-residual set equality; asymmetric sets defer to the LLM.
  if (setA.size < 2 || !setsEqual(setA, setB)) return null;

  const outcome_set: OutcomeSetItem[] = [];
  const leg_mapping: LegMappingItem[] = [];
  for (const canon of setA) {
    const oid = slugifyOutcome(canon);
    outcome_set.push({
      outcome_id: oid,
      label: canon,
      outcome_subject: canon === 'DRAW' ? null : canon,
      is_residual: false,
    });
    for (const mid of oa.real.get(canon)!) leg_mapping.push({ outcome_id: oid, platform: a.platform, market_id: mid });
    for (const mid of ob.real.get(canon)!) leg_mapping.push({ outcome_id: oid, platform: b.platform, market_id: mid });
  }
  if (oa.residual.length || ob.residual.length) {
    outcome_set.push({ outcome_id: 'other', label: 'Other', is_residual: true, outcome_subject: null });
    for (const mid of oa.residual) leg_mapping.push({ outcome_id: 'other', platform: a.platform, market_id: mid });
    for (const mid of ob.residual) leg_mapping.push({ outcome_id: 'other', platform: b.platform, market_id: mid });
  }

  return {
    same_event: true,
    confidence: 1.0,
    reasoning: `deterministic option-set match: ${setA.size} shared canonical options`,
    canonical_event: a.title,
    canonical_subject: a.canonical_subject ?? b.canonical_subject ?? null,
    grouping_kind: 'categorical_exclusive',
    participants: [...setA].filter((x) => x !== 'DRAW').sort(),
    outcome_set,
    leg_mapping,
  };
}


export async function tryNumeric(
  a: EventMeta, childrenA: ChildRow[], b: EventMeta, childrenB: ChildRow[],
): Promise<EventMatchResult | null> {
  if (!scopeCompatible(a, b)) return null;

  // Every child must be a single-direction monotonic threshold with a value +
  // consistent unit; mixed direction/range/missing value defers.
  const collect = (children: ChildRow[]) => {
    let dir: string | null = null;
    let unit: string | null = null;
    const byValue = new Map<number, number[]>();
    const subjects = new Set<string>();
    for (const c of children) {
      if (c.value_primary == null || (c.direction !== 'above' && c.direction !== 'below')) return null;
      if (dir === null) dir = c.direction; else if (dir !== c.direction) return null;
      if (unit === null) unit = c.value_unit; else if (unit !== c.value_unit) return null;
      if (c.canonical_subject && c.canonical_subject.trim()) subjects.add(c.canonical_subject.trim().toLowerCase());
      (byValue.get(Number(c.value_primary)) ?? byValue.set(Number(c.value_primary), []).get(Number(c.value_primary))!).push(c.market_id);
    }
    return byValue.size >= 1 ? { dir: dir as 'above' | 'below', unit, byValue, subjects } : null;
  };
  const ca = collect(childrenA);
  const cb = collect(childrenB);
  if (!ca || !cb) return null;
  if (ca.dir !== cb.dir || ca.unit !== cb.unit) return null;

  // Each side (and their union) must collapse to exactly one subject; a side
  // with no known subject defers — a NULL ladder must not auto-merge cross-platform.
  if (countDistinctSubjects(ca.subjects) !== 1 || countDistinctSubjects(cb.subjects) !== 1) return null;
  if (countDistinctSubjects([...ca.subjects, ...cb.subjects]) !== 1) return null;
  const subject = [...ca.subjects][0];

  const valsA = new Set([...ca.byValue.keys()].map(String));
  const valsB = new Set([...cb.byValue.keys()].map(String));
  if (valsA.size < 2 || !setsEqual(valsA, valsB)) return null;

  const ordinals = thresholdOrdinals([...ca.byValue.keys()], ca.dir);
  const outcome_set: OutcomeSetItem[] = [];
  const leg_mapping: LegMappingItem[] = [];
  for (const [val, ord] of ordinals) {
    const oid = `${ca.dir === 'above' ? 'ge' : 'le'}_${val}`;
    outcome_set.push({ outcome_id: oid, label: `${ca.dir === 'above' ? '≥' : '≤'} ${val}${ca.unit ? ' ' + ca.unit : ''}`, ordinal: ord, is_residual: false });
    for (const mid of ca.byValue.get(val)!) leg_mapping.push({ outcome_id: oid, platform: a.platform, market_id: mid });
    for (const mid of cb.byValue.get(val)!) leg_mapping.push({ outcome_id: oid, platform: b.platform, market_id: mid });
  }

  return {
    same_event: true,
    confidence: 1.0,
    reasoning: `deterministic numeric match: identical ${ordinals.size}-boundary ${ca.dir} ladder on ${subject}`,
    canonical_event: a.canonical_subject ?? a.title,
    canonical_subject: a.canonical_subject ?? subject,
    grouping_kind: 'threshold_series',
    participants: [subject],
    outcome_set,
    leg_mapping,
  };
}


export function u1Admit(
  a: EventMeta, childrenA: ChildRow[], b: EventMeta, childrenB: ChildRow[],
): { pmEv: EventMeta; pmCh: ChildRow[]; predEv: EventMeta; predCh: ChildRow[] } | null {
  let pmEv: EventMeta, pmCh: ChildRow[], predEv: EventMeta, predCh: ChildRow[];
  if (a.platform === 'polymarket' && b.platform === 'predict') { pmEv = a; pmCh = childrenA; predEv = b; predCh = childrenB; }
  else if (a.platform === 'predict' && b.platform === 'polymarket') { pmEv = b; pmCh = childrenB; predEv = a; predCh = childrenA; }
  else return null;
  const pmCids = new Set<string>();
  for (const c of pmCh) if (c.platform_id && c.platform_id.trim()) pmCids.add(c.platform_id.trim());
  if (pmCids.size === 0) return null;
  for (const p of predCh) for (const cid of p.pm_condition_ids ?? []) {
    if (pmCids.has(cid)) return { pmEv, pmCh, predEv, predCh };
  }
  return null;
}

// Builds the outcome partition from the PM side's native labels, then attaches
// each label-less Predict market to its outcome by condition id — replacing
// the KB-canonical set-equality tryCategorical requires.
export async function tryU1(
  a: EventMeta, childrenA: ChildRow[], b: EventMeta, childrenB: ChildRow[],
): Promise<EventMatchResult | null> {
  const sides = u1Admit(a, childrenA, b, childrenB);
  if (!sides) return null;
  const { pmEv, pmCh, predEv, predCh } = sides;

  if (nativeIndependentRefusal(pmEv, predEv)) return null;

  const oPm = await buildOptions(pmEv, pmCh);
  if (!oPm) return null;
  if (oPm.real.size < 2) return null;

  const RESIDUAL = '\u0000residual';
  const pmMarketPlatformId = new Map<number, string | null>();
  for (const c of pmCh) pmMarketPlatformId.set(c.market_id, c.platform_id);
  const cidToCanon = new Map<string, string>();
  for (const [canon, mids] of oPm.real) for (const mid of mids) {
    const cid = pmMarketPlatformId.get(mid);
    if (cid && cid.trim()) cidToCanon.set(cid.trim(), canon);
  }
  for (const mid of oPm.residual) {
    const cid = pmMarketPlatformId.get(mid);
    if (cid && cid.trim()) cidToCanon.set(cid.trim(), RESIDUAL);
  }

  const predByCanon = new Map<string, number[]>();
  const predResidual: number[] = [];
  let joined = 0;
  for (const p of predCh) {
    for (const cid of p.pm_condition_ids ?? []) {
      const canon = cidToCanon.get(cid);
      if (canon === undefined) continue;
      joined++;
      if (canon === RESIDUAL) predResidual.push(p.market_id);
      else (predByCanon.get(canon) ?? predByCanon.set(canon, []).get(canon)!).push(p.market_id);
      break;
    }
  }
  if (joined === 0) return null;

  const setReal = [...oPm.real.keys()];
  const outcome_set: OutcomeSetItem[] = [];
  const leg_mapping: LegMappingItem[] = [];
  for (const canon of setReal) {
    const oid = slugifyOutcome(canon);
    outcome_set.push({
      outcome_id: oid,
      label: canon,
      outcome_subject: canon === 'DRAW' ? null : canon,
      is_residual: false,
    });
    for (const mid of oPm.real.get(canon)!) leg_mapping.push({ outcome_id: oid, platform: pmEv.platform, market_id: mid });
    for (const mid of predByCanon.get(canon) ?? []) leg_mapping.push({ outcome_id: oid, platform: predEv.platform, market_id: mid });
  }
  if (oPm.residual.length || predResidual.length) {
    outcome_set.push({ outcome_id: 'other', label: 'Other', is_residual: true, outcome_subject: null });
    for (const mid of oPm.residual) leg_mapping.push({ outcome_id: 'other', platform: pmEv.platform, market_id: mid });
    for (const mid of predResidual) leg_mapping.push({ outcome_id: 'other', platform: predEv.platform, market_id: mid });
  }

  return {
    same_event: true,
    confidence: 1.0,
    reasoning: `deterministic U1 condition-id bridge: ${setReal.length} PM options, ${joined} predict legs joined on-chain`,
    canonical_event: pmEv.title,
    canonical_subject: pmEv.canonical_subject ?? predEv.canonical_subject ?? null,
    grouping_kind: 'categorical_exclusive',
    participants: setReal.filter((x) => x !== 'DRAW').sort(),
    outcome_set,
    leg_mapping,
  };
}


type PriorLegRow = Awaited<ReturnType<typeof getSemanticEventLegSubjects>>[number];

// Two deliberate asymmetries vs llm-event-match, both safe: marketNativeLabel
// is absent (options are keyed by child label, so no positional mis-map is
// possible); marketDates omits end_date (deterministic proposals set no deadline).
export function buildDeterministicMatchContext(
  proposal: EventMatchResult,
  childrenA: ChildRow[],
  childrenB: ChildRow[],
  subjectType: Map<string, string | null> | undefined,
  priorLegs: PriorLegRow[] | undefined,
  subjectParty?: Map<string, string | null>,
): MatchContext {
  const marketPlatform = new Map<number, string>();
  const marketScope = new Map<number, string | null>();
  const marketSport = new Map<number, string | null>();
  const marketSubject = new Map<number, string | null>();
  const marketEventKind = new Map<number, string | null>();
  const reconcileMetricScope = new Map<number, string | null>();
  const marketNumeric = new Map<number, NumericRegionFacts>();
  const marketWeather = new Map<number, { text: string | null; subject: string | null }>();
  const marketSettlementDimension = new Map<number, string | null>();
  const marketCanonicalEvent = new Map<number, string | null>();
  const marketDates = new Map<number, { condition_date: string | null; condition_date_precision?: string | null }>();
  const marketTitle = new Map<number, string | null>();
  const marketKalshiSeries = new Map<number, string | null>();
  const marketDiscriminators = new Map<number, Record<string, string>>();
  const marketPlatformEvent = new Map<number, number | null>();
  const marketNativeOutcomes = new Map<number, string[] | null>();
  for (const c of [...childrenA, ...childrenB]) {
    marketNativeOutcomes.set(c.market_id, c.native_outcomes ?? null);
    marketPlatform.set(c.market_id, c.platform);
    marketPlatformEvent.set(c.market_id, c.pe_id);
    marketScope.set(c.market_id, c.resolution_scope);
    marketSport.set(c.market_id, c.sport);
    marketSubject.set(c.market_id, c.canonical_subject);
    marketEventKind.set(c.market_id, c.event_kind);
    reconcileMetricScope.set(c.market_id, c.metric_scope);
    marketCanonicalEvent.set(c.market_id, c.canonical_event);
    marketTitle.set(c.market_id, c.title);
    marketKalshiSeries.set(c.market_id, c.kalshi_series);
    marketDates.set(c.market_id, {
      condition_date: c.condition_date,
      condition_date_precision: c.condition_date_precision,
    });
    marketNumeric.set(c.market_id, {
      condition_metric: c.condition_metric,
      condition_direction: c.direction,
      condition_shape: c.shape,
      value_primary: c.value_primary,
      value_secondary: c.value_secondary,
      value_unit: c.value_unit,
      strike_type: c.strike_type,
    });
    marketWeather.set(c.market_id, { text: c.weather_text, subject: c.canonical_subject });
    marketSettlementDimension.set(c.market_id, c.settlement_dimension ?? null);
    marketDiscriminators.set(c.market_id, c.discriminators ?? {});
  }

  return {
    minConfidence: config.events.minMatchConfidence,
    marketPlatform, marketScope, marketSport, subjectType, subjectParty, marketSubject, marketEventKind,
    marketNumeric, marketWeather, marketSettlementDimension, marketCanonicalEvent, marketDates, marketTitle,
    marketKalshiSeries, marketDiscriminators, marketPlatformEvent, marketNativeOutcomes,
    priorLegSubjects: priorLegs?.map((l) => l.canonical_subject),
    priorLegEventKinds: priorLegs?.map((l) => l.event_kind),
    priorLegs: priorLegs?.map((l) => ({
      outcome_id: l.outcome_id,
      outcome_subject: l.outcome_subject,
      market_id: l.market_id,
      metric_scope: l.metric_scope ?? null,
      canonical_event: (l as { canonical_event?: string | null }).canonical_event ?? null,
      event_kind: l.event_kind ?? null,
      market_canonical_event: l.market_canonical_event ?? null,
      condition_date: l.condition_date ?? null,
      condition_date_precision: l.condition_date_precision ?? null,
      title: l.title ?? null,
      kalshi_series: l.kalshi_series ?? null,
      platform: l.platform ?? null,
      platform_event_id: l.platform_event_id ?? null,
    })),
    reconcileMetricScope,
    newCanonicalEvent: proposal.canonical_event ?? null,
    reconcileEnabled: true,
  };
}

async function persistProposal(
  candId: number, aId: number, bId: number, proposal: EventMatchResult,
  childrenA: ChildRow[], childrenB: ChildRow[], stats: ConfirmStats, kind: 'categorical' | 'numeric' | 'u1',
): Promise<void> {
  const subjectTypings = proposal.grouping_kind === 'categorical_exclusive'
    ? await getSubjectPartyTypings((proposal.outcome_set ?? []).map((o) => (o.outcome_subject && o.outcome_subject.trim()) || o.label).filter(Boolean))
    : undefined;
  const subjectType = subjectTypings
    ? new Map([...subjectTypings].map(([k, v]) => [k, v.type] as const))
    : undefined;
  const subjectParty = subjectTypings
    ? new Map([...subjectTypings].map(([k, v]) => [k, v.party] as const))
    : undefined;

  // N-platform expansion: attach to an existing semantic_event if either side
  // is already bound, looked up before the guard so it can fold in.
  const existing =
    (await findSemanticEventIdForPlatformEvent(aId)) ??
    (await findSemanticEventIdForPlatformEvent(bId)) ??
    undefined;
  const priorLegs = (existing && (proposal.grouping_kind === 'threshold_series' || proposal.grouping_kind === 'categorical_exclusive'))
    ? await getSemanticEventLegSubjects(existing)
    : undefined;

  const ctx = buildDeterministicMatchContext(proposal, childrenA, childrenB, subjectType, priorLegs, subjectParty);
  const verdict = validateMatch(proposal, ctx);
  if (verdict.kind !== 'match') {
    // A deterministic proposal that fails a guard is an unsound merge; skip it.
    await markCandidate(candId, 'skipped', `deterministic ${kind}: ${verdict.kind === 'reject' ? verdict.reason : 'no_match'}`);
    stats.rejected++;
    return;
  }

  const outcomeById = new Map((proposal.outcome_set ?? []).map((o) => [o.outcome_id, o]));
  const legs: LegInsert[] = (proposal.leg_mapping ?? []).map((l) => {
    const o = outcomeById.get(l.outcome_id);
    return {
      outcome_id: l.outcome_id,
      outcome_label: o?.label ?? l.outcome_id,
      outcome_subject: o?.outcome_subject ?? null,
      outcome_ordinal: o?.ordinal ?? null,
      is_residual: o?.is_residual ?? false,
      platform: l.platform,
      market_id: l.market_id,
    };
  });

  const persistResult = await persistMatch({
    candidateId: candId,
    platformEventIds: [aId, bId],
    matchConfidence: proposal.confidence,
    legs,
    existingSemanticEventId: existing,
    semanticEvent: existing ? undefined : {
      canonical_event: proposal.canonical_event ?? '',
      canonical_subject: proposal.canonical_subject ?? null,
      grouping_kind: proposal.grouping_kind!,
      participants: proposal.participants ?? [],
      deadline_window: null,
      confidence: proposal.confidence,
      llm_model: kind === 'numeric' ? 'deterministic-numeric'
        : kind === 'u1' ? 'deterministic-conditionid' : 'deterministic-options',
      match_reasoning: proposal.reasoning,
    },
  });
  if (persistResult.refused) {
    stats.rejected++;
    return;
  }
  if (existing) stats.expanded++;
  else if (kind === 'numeric') stats.numeric++;
  else if (kind === 'u1') stats.u1 = (stats.u1 ?? 0) + 1;
  else stats.categorical++;
}


export async function confirmPairsDeterministically(): Promise<ConfirmStats> {
  const stats: ConfirmStats = { categorical: 0, numeric: 0, expanded: 0, rejected: 0, deferred: 0, f1_rejected: 0, e1_rejected: 0, u1: 0, u7_rejected: 0, r4_rejected: 0 };
  const teamSetMemo = new Map<number, Set<string> | null>();

  // Keyset pagination by id: a deferred candidate stays 'pending' on purpose
  // (the LLM settles it later), so advancing past the max id already seen is
  // what keeps each candidate visited exactly once.
  let lastId = 0;
  for (;;) {
    const cands = await query<{ id: number; a_id: number; b_id: number }>(
      `SELECT id, platform_event_a AS a_id, platform_event_b AS b_id
         FROM stage3_event_candidates
        WHERE status = 'pending' AND id > $1
        ORDER BY id
        LIMIT $2`,
      [lastId, PAGE],
    );
    if (cands.length === 0) break;
    lastId = cands[cands.length - 1].id;

    const evIds = [...new Set(cands.flatMap((c) => [c.a_id, c.b_id]))];
    const metaRows = await query<EventMeta>(
      // native_independent: Kalshi mutually_exclusive='false' lives on
      // kalshi_events; a NULL join COALESCEs to false.
      `SELECT pe.id, pe.platform, pe.title, pe.grouping_type, pe.canonical_subject, pe.category,
              pe.sport_canonical AS sport, pe.league_canonical AS league, pe.event_kind, pe.participants,
              COALESCE(
                pe.grouping_type = 'bundle_nonexclusive'
                OR ke.raw->>'mutually_exclusive' = 'false',
                false
              ) AS native_independent
         FROM platform_events pe
         LEFT JOIN kalshi_events ke
           ON pe.platform = 'kalshi'
          AND pe.platform_event_id = 'kalshi:event:' || ke.event_ticker
        WHERE pe.id = ANY($1::int[])`,
      [evIds],
    );
    const meta = new Map(metaRows.map((m) => [m.id, m]));
    const childRows = await query<ChildRow>(
      `SELECT pe.id AS pe_id, m.id AS market_id, m.platform,
              COALESCE(mmr.raw->>'groupItemTitle', mmr.raw->>'yes_sub_title', mmr.raw#>>'{custom_strike,Team}') AS label,
              m.resolution_scope, pe.sport_canonical AS sport,
              n.value_primary, n.value_secondary, n.value_unit, n.condition_direction AS direction, n.condition_shape AS shape,
              n.condition_metric,
              n.canonical_subject, n.event_kind, n.metric_scope,
              n.canonical_event,
              n.condition_date::text AS condition_date, n.condition_date_precision,
              mmr.raw->>'strike_type' AS strike_type,
              m.title AS title,
              CASE WHEN n.event_kind LIKE 'weather%'
                   THEN left(COALESCE(mmr.raw->>'rules_primary', mmr.raw->>'description'), 2000)
              END AS weather_text,
              ${settlementDimensionSql('mmr.raw')} AS settlement_dimension,
              n.discriminators AS discriminators,
              m.platform_id AS platform_id,
              CASE WHEN jsonb_typeof(mmr.raw->'polymarketConditionIds') = 'array'
                   THEN (SELECT array_agg(x) FROM jsonb_array_elements_text(mmr.raw->'polymarketConditionIds') x)
              END AS pm_condition_ids,
              CASE WHEN m.platform = 'kalshi'
                   THEN split_part(mmr.raw->>'event_ticker', '-', 1)
              END AS kalshi_series,
              CASE
                WHEN jsonb_typeof(mmr.raw->'outcomes') = 'array'
                     AND NOT EXISTS (
                       SELECT 1 FROM jsonb_array_elements_text(mmr.raw->'outcomes') o(v)
                        WHERE lower(btrim(o.v)) IN ('yes','no','true','false'))
                THEN ARRAY(SELECT jsonb_array_elements_text(mmr.raw->'outcomes'))
              END AS native_outcomes
         FROM platform_events pe
         JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
         LEFT JOIN market_metadata_raw mmr ON mmr.market_id = m.id
         LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
        WHERE pe.id = ANY($1::int[])`,
      [evIds],
    );
    const childrenByEvent = new Map<number, ChildRow[]>();
    for (const r of childRows) (childrenByEvent.get(r.pe_id) ?? childrenByEvent.set(r.pe_id, []).get(r.pe_id)!).push(r);

    await mapWithConcurrency(cands, CONCURRENCY, async (cand) => {
      const a = meta.get(cand.a_id);
      const b = meta.get(cand.b_id);
      if (!a || !b) { stats.deferred++; return; }
      const ca = childrenByEvent.get(a.id) ?? [];
      const cb = childrenByEvent.get(b.id) ?? [];

      try {
        const categorical = await tryCategorical(a, ca, b, cb);
        if (categorical) { await persistProposal(cand.id, a.id, b.id, categorical, ca, cb, stats, 'categorical'); return; }
        const numeric = await tryNumeric(a, ca, b, cb);
        if (numeric) { await persistProposal(cand.id, a.id, b.id, numeric, ca, cb, stats, 'numeric'); return; }
        const u1 = await tryU1(a, ca, b, cb);
        if (u1) {
          const bound = (await findSemanticEventIdForPlatformEvent(a.id)) ?? (await findSemanticEventIdForPlatformEvent(b.id));
          if (bound == null) { await persistProposal(cand.id, a.id, b.id, u1, ca, cb, stats, 'u1'); return; }
        }
        // Rejecters below are subtractive: they only mark the candidate
        // 'skipped', never persist a merge.
        if (isNeverSameKindPair(a.event_kind, b.event_kind)) {
          await markCandidate(cand.id, 'skipped', neverSameKindTag(a.event_kind!, b.event_kind!));
          stats.rejected++; stats.f1_rejected = (stats.f1_rejected ?? 0) + 1;
          return;
        }
        const e1Tag = await tryRejectE1Disjoint(a, ca, b, cb);
        if (e1Tag) {
          await markCandidate(cand.id, 'skipped', e1Tag);
          stats.rejected++; stats.e1_rejected = (stats.e1_rejected ?? 0) + 1;
          return;
        }
        const u7Tag = u7RejectTag(
          a.title, eventMarketType(a.platform, a.title, ca.map((c) => c.kalshi_series)),
          b.title, eventMarketType(b.platform, b.title, cb.map((c) => c.kalshi_series)),
        );
        if (u7Tag) {
          await markCandidate(cand.id, 'skipped', u7Tag);
          stats.rejected++; stats.u7_rejected = (stats.u7_rejected ?? 0) + 1;
          return;
        }
        const r4Tag = await tryRejectFixtureParticipants(a, b, teamSetMemo);
        if (r4Tag) {
          await markCandidate(cand.id, 'skipped', r4Tag);
          stats.rejected++; stats.r4_rejected = (stats.r4_rejected ?? 0) + 1;
          return;
        }
        if (DISJOINT_REJECT && tryRejectDisjointSubjects(a, ca, b, cb)) {
          await markCandidate(cand.id, 'skipped', 'deterministic: disjoint child subjects in non-fragmentation kinds');
          stats.rejected++;
          return;
        }
      } catch (err) {
        log.warn(`candidate ${cand.id} confirm errored, deferring to LLM: ${err}`);
      }
      stats.deferred++;
    });

    log.info(`confirm: categorical=${stats.categorical} numeric=${stats.numeric} u1=${stats.u1 ?? 0} expanded=${stats.expanded} ` +
      `rejected=${stats.rejected} deferred→LLM=${stats.deferred}`);
    if (cands.length < PAGE) break;
  }

  log.info(`Stage 3b-pre (deterministic confirm): categorical=${stats.categorical} numeric=${stats.numeric} ` +
    `u1=${stats.u1 ?? 0} expanded=${stats.expanded} rejected=${stats.rejected} ` +
    `(f1=${stats.f1_rejected ?? 0} e1=${stats.e1_rejected ?? 0} u7=${stats.u7_rejected ?? 0} r4=${stats.r4_rejected ?? 0}) ` +
    `deferred→LLM=${stats.deferred}`);
  return stats;
}
