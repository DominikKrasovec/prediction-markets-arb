/**
 * Stage 4 — deterministic finalizer. Projects matched + un-matched events into
 * the arb-solver's consumer tables (questions / question_members /
 * outcome_sets / outcome_set_slots / implication_edges); idempotent, no LLM.
 * Node canonical_key namespaces feed A (`sem:<se>:<outcome_id>`) vs feed B
 * (`pe:<platform_event_id>:<market_id>`) so they can't collide.
 */
import { query, withTx } from '@arb/db';
import { createLogger } from '@arb/logger';
import { isSetInertEventKind } from '@arb/types';
import {
  placeholderSlotsInSet,
  isFixturePlaceholderSubjectSql,
  isOmegaPlaceholderSlotSql,
} from '../util/placeholder-outcomes.js';
import { NATIVE_MUTEX_SQL } from '../util/native-exclusivity.js';
import { settlementDimensionSql } from '../util/settlement-instrument.js';
import {
  shapeClassOf,
  foldUnit,
  foldDirectionClass,
  dirPartitionClass,
  INTEGER_GRAIN_UNITS,
  NONNEGATIVE_MAGNITUDE_UNITS,
} from '../util/condition-shape.js';
import { sameAtCoarserGrainSql } from '../util/date-grain-sql.js';
import {
  EDGE_INSERT_COLUMNS_SQL,
  EDGE_CONFLICT_SQL,
  edgeContractSql,
  bothKnownDifferSql,
  foldedParticipantsKeySql,
  foldTextKey,
} from '../util/sql-fragments.js';
import { updateAllQuestionCounts } from '../db/queries/questions.js';
import { runContradictionDetection, type ContradictionResult } from '../stage3-arb-detect/contradiction-detector.js';
import { ONE_HOT_PARTITION_KINDS } from '../stage3-events/guards.js';
import { buildTournamentEdges, loadWcEliminationMutexSets } from './tournament-edges.js';
import { buildTournamentTierB } from './tournament-edges-tierb.js';
import { installSameEventSql } from './same-event.js';
import { rollupCount, beltHit } from '../discriminators/telemetry.js';
import {
  parseMemberHalfLine, parseSlugHalfLine, halfLineFoldDropMarketIds,
  type HalfLineMemberRef,
} from '../util/half-line.js';
import {
  setSplitSlotProjectionsFeedA, setSplitSlotProjectionsFeedB,
  setSplitPassthroughCols, setSplitKeyPart, slotSetSplitDisc,
} from '../discriminators/fold-sql.js';
import { buildNumericLadderXqEdges } from './numeric-ladder-xq.js';
import { buildExactScoreDerivedEdges } from './exact-score-derived.js';
import { buildMutualExclusionXqEdges } from './mutual-exclusion-xq.js';
import { buildDateImplicationXqEdges } from './date-implication-xq.js';
import { buildBeforeDateChainEdges } from './before-date-chain.js';
import { buildReachThresholdChainEdges } from './reach-threshold-chain.js';
import { buildMarginWinnerEdges, buildMarginLadderEdges } from './margin-winner.js';
import { buildSpreadWinnerEdges } from './spread-winner.js';
import { buildFixtureTotalsEdges } from './fixture-totals.js';
import { buildKalshiStrikeLadderEdges } from './kalshi-strike-ladder.js';
import { buildMediaReleaseLadderEdges } from './media-release-ladder.js';
import { buildScorerImplicationEdges } from './scorer-implication.js';
import { buildShapeBridgeEdges } from './shape-bridge.js';
import { buildWindowContainmentEdges } from './window-containment.js';
import { buildEquivalenceEdges } from './equivalence-edge.js';
import { buildElectionPreconditionEdges } from './election-precondition-edge.js';
import { buildCrossRefEquivalenceEdges } from './cross-ref-equivalence-edge.js';
import { buildRateDecisionBridgeEdges } from './rate-decision-bridge.js';
import { classifySet, partitionHeteroCategoricalByKind, labelDriftDuplicateOutcomeIds, computeAxisInterval, DATE_LATCH_KINDS, type CertifierSlot } from './outcome-set-certifier.js';
import { precisionRank, grainKeyAt } from '../util/date-grain.js';
import { awardMaxWinners } from '../stage1-normalize/kalshi-series.js';
import {
  sigma1Contradictions,
  SIGMA1_CONTRADICTION_DIMENSIONS,
  SIGMA1_NATIVE_SET_DIMENSIONS,
  type BeltSlotFacts,
} from './sigma-contradiction-belt.js';
import { partitionCohesiveMembers, type MemberFacts } from './member-cohesion.js';
import { runDuplicatePartitionGateStage4 } from './duplicate-partition-gate.js';
import { partitionByGrain, outcomeGrainFromFacts, distinctRealGrains, isThresholdLikeGrain } from '../util/outcome-grain.js';
import { getSubjectTypings } from '../db/queries/semantic-events.js';
import { subjectTypeForms, classifyAggregateKind, type SubjectType } from '../util/subject-aggregate.js';

const log = createLogger('stage4-finalize');

// Excludes bare "qualif"/"advance" tokens (collide with proper nouns like
// "Esports World Cup EMEA Qualifier"); those are handled via event_kind instead.
const MULTI_YES_PREDICATE_RX =
  /\b(?:finish(?:es|ing)?\s+(?:in\s+the\s+)?top|top[-\s]?\d|relegat|make[s]?\s+(?:the\s+)?(?:playoff|postseason|knockout))/i;

// Per-fixture one-hot event_kinds (1X2/moneyline/exact-score/candle); same set
// as stage3 guards.ts ONE_HOT_PARTITION_KINDS.
export const ONE_HOT_FIXTURE_KINDS = ONE_HOT_PARTITION_KINDS;

export function looksMultiYesPredicate(
  title: string | null | undefined,
  eventKind?: string | null | undefined,
): boolean {
  if (eventKind === 'stage_advance') return true;
  if (eventKind != null && ONE_HOT_FIXTURE_KINDS.has(eventKind)) return false;
  if (!title) return false;
  return MULTI_YES_PREDICATE_RX.test(title);
}

// Stricter than looksMultiYesPredicate: title-only, and advance/qualify requires
// a destination so it can't fire on a proper-noun "…Qualifier Final" one-hot.
// SQL mirror lives in both finalize feeds' is_multiwinner aggregate; keep in sync.
const MULTI_WINNER_SELECT_RX =
  /\b((?:advance\w*|qualif\w*)\s+(?:to|for|into)\s+(?:the\s+)?(?:grand\s+)?(?:final\w*|semi\w*|knockout\w*|playoff\w*|next\s+round|round\s+of)|relegat\w*|make[s]?\s+(?:the\s+)?(?:playoff|postseason|knockout)|finish(?:es|ing)?\s+(?:in\s+)?(?:the\s+)?top[-\s]?[0-9]|top[-\s]?[0-9]+\s+finish\w*)/i;
export function looksMultiWinnerSelection(
  title: string | null | undefined,
  eventKind?: string | null | undefined,
): boolean {
  if (eventKind != null && ONE_HOT_FIXTURE_KINDS.has(eventKind)) return false;
  if (!title) return false;
  return MULTI_WINNER_SELECT_RX.test(title);
}

// Narrow on purpose: bare "first" also appears in exhaustive fixture sets
// ("First Half Winner"). Embedded verbatim (POSIX `\y`) in both finalize feed
// SQLs; the JS mirror swaps `\y`→`\b`. A test pins the two in sync.
export const OPEN_RACE_TITLE_PATTERN =
  '\\y(be the )?first to\\y|\\yrace to\\y|\\yfirst\\y.{0,16}\\y(hit|reach|cross|surpass)\\y';
const OPEN_RACE_RX = new RegExp(OPEN_RACE_TITLE_PATTERN.replace(/\\y/g, '\\b'), 'i');
export function looksOpenRace(title: string | null | undefined): boolean {
  if (!title) return false;
  return OPEN_RACE_RX.test(title);
}

function openRaceLegSql(titleCol: string): string {
  return `(${titleCol} ~* '${OPEN_RACE_TITLE_PATTERN}'` +
    ` AND (n.event_kind IS NULL OR n.event_kind NOT IN ('match_winner','halftime_leader','exact_score','candle_direction')))`;
}

// Whether a `categorical` outcome_set is exhaustive (Σ=1) vs only
// mutually-exclusive (Σ≤1). A bare negRisk proves Σ=1 only for a fixture kind
// with ≥3 real slots or a residual (a drawless 2-team match negRisk is Σ≤1).
export function isExhaustiveSet(opts: {
  isCategorical: boolean;
  isMultiYesFold: boolean;
  isNeg: boolean;
  isFixtureKind: boolean;
  hasResidual: boolean;
  numericTiling: boolean;
  realSlotCount: number;
}): boolean {
  if (!opts.isCategorical) return true;
  if (opts.isMultiYesFold) return false;
  const fixtureNegExhaustive =
    opts.isNeg && opts.isFixtureKind && (opts.realSlotCount >= 3 || opts.hasResidual);
  return fixtureNegExhaustive || opts.hasResidual || opts.numericTiling;
}

/**
 * Weak gate: ≥2 distinct value buckets across kept slots with values on ≥60% of
 * slots. Cannot distinguish a sound partition from a monotonic ladder or an
 * 'at' point race — use {@link isSoundNumericTiling} at Σ=1 sites instead.
 */
export function hasNumericPartition(
  values: ReadonlyArray<number | string | null | undefined>,
): boolean {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return false;
  if (present.length / values.length < 0.6) return false;
  return new Set(present.map((v) => String(v))).size >= 2;
}

/** Per-slot numeric facts a tiling decision reads (one entry per kept slot). */
export interface NumericSlot {
  direction: string | null | undefined; // above|below|at|between|null
  value_primary: number | string | null | undefined;
  value_secondary: number | string | null | undefined;
  // exact_score's (value_primary, value_secondary) is a (home, away) scoreline,
  // not interval bounds — never contributes `between` evidence.
  event_kind?: string | null | undefined;
  condition_shape?: string | null | undefined;
  value_unit?: string | null | undefined;
}

const toNum = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// Direction-aware numeric-tiling certifier: true only when the valued slots
// are `between`-dominated with contiguous interval coverage AND the two tails
// of a known unit axis are closed (an open extreme leg, or a domain floor at 0);
// refuses an all-`at` point race, a monotone ladder, or <2 distinct buckets.
export function isSoundNumericTiling(slots: ReadonlyArray<NumericSlot>): boolean {
  if (slots.length === 0) return false;
  const valued = slots.filter((s) => s.value_primary !== null && s.value_primary !== undefined);
  if (valued.length / slots.length < 0.6) return false;
  if (new Set(valued.map((s) => String(s.value_primary))).size < 2) return false;

  const knownUnits = new Set<string>();
  for (const s of valued) {
    const u = foldUnit(s.value_unit);
    if (u != null) knownUnits.add(u);
  }
  const intGrain = knownUnits.size > 0 && [...knownUnits].every((u) => INTEGER_GRAIN_UNITS.has(u));

  // A touch slot in a continuous domain can co-fire with any interior bucket;
  // integer-grain domains are exempt.
  if (!intGrain && valued.some((s) => shapeClassOf(s.condition_shape) === 'touch')) return false;

  const dirOf = (s: NumericSlot): string | null => foldDirectionClass(s.direction);
  const isFixtureSlot = (s: NumericSlot): boolean =>
    s.event_kind != null && ONE_HOT_FIXTURE_KINDS.has(s.event_kind);

  let nBetween = 0, nAbove = 0, nBelow = 0, nAt = 0, nNull = 0, nFixture = 0;
  // Half-line leg values, kept so the extremes check can ask whether an arm actually
  // REACHES the tiled span (a `below 16.5` under buckets that start at 18 closes nothing).
  const aboveVals: number[] = [], belowVals: number[] = [];
  for (const s of valued) {
    if (isFixtureSlot(s)) { nFixture++; continue; }
    const v = toNum(s.value_primary);
    switch (dirOf(s)) {
      case 'between': nBetween++; break;
      case 'above': nAbove++; if (v !== null) aboveVals.push(v); break;
      case 'below': nBelow++; if (v !== null) belowVals.push(v); break;
      case 'at': nAt++; break;
      default: nNull++; break;
    }
  }

  if (nNull > 0) {
    const promotable = valued.filter((s) => !isFixtureSlot(s));
    const withV2 = promotable.filter((s) => s.value_secondary !== null && s.value_secondary !== undefined).length;
    if (promotable.length > 0 && withV2 / promotable.length >= 0.6) {
      nBetween += nNull;
      nNull = 0;
    }
  }

  if (nBetween === 0) return false;
  if (nBetween < Math.max(nAbove, nBelow, nAt, nNull, nFixture)) return false;

  const buckets = valued
    .filter((s) => !isFixtureSlot(s))
    .filter((s) => dirOf(s) === 'between' || (dirOf(s) === null && s.value_secondary != null))
    .map((s) => ({ lo: toNum(s.value_primary), hi: toNum(s.value_secondary) }))
    .filter((b): b is { lo: number; hi: number } => b.lo !== null && b.hi !== null)
    .sort((a, b) => a.lo - b.lo);
  // `between`-labelled slots that carry no parsable interval are no evidence of a
  // partition, so there is nothing to certify.
  if (buckets.length === 0) return false;
  const step = intGrain ? 1 : 0;
  let coverHi = buckets[0].hi;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i].lo > coverHi + step) return false;
    if (buckets[i].hi > coverHi) coverHi = buckets[i].hi;
  }
  // Open-extreme requirement. The buckets cover [buckets[0].lo, coverHi] and NOTHING
  // else, so Σ=1 additionally claims the two tails are empty. That claim needs a leg:
  // an unbounded `above`/`below` interval, or a domain floor. Without it Σ=1 deletes an
  // attainable world from Ω and mints a buy-all-YES fake (live set 11746 — Kalshi BNB
  // 760-765 / 765-770 / 770-775 / above 775, nothing under 760).
  //   This used to be nested under `intGrain`, which is true only when EVERY known unit
  // is integer-grain — so no continuous domain (usd, percent, …) was ever checked. It
  // now runs for every KNOWN unit domain, integer or continuous.
  //   A wholly unknown unit stays exempt: without the unit we cannot tell an unbounded
  // axis from a closed one (an exact-score grid or a rank 1..N tiles a bounded domain
  // and legitimately has no half-line leg), so demanding open extremes there would cost
  // recall on no evidence. Every live escape of this class carried a known unit.
  //   An arm only closes a tail if it MEETS the span it is supposed to close: live set
  // 1092 (Paris low temperature) tiles 18..26 °C with a `16 or below` leg, leaving 17 °C
  // in no slot at all, and was certified Σ=1 on the bare presence of the leg.
  if (knownUnits.size > 0) {
    if (!aboveVals.some((v) => v <= coverHi + step)) return false;
    // Floor allowance — explicit and unit-aware (it used to be a side effect of sitting
    // inside the integer-grain branch): on an axis provably floored at 0, a lowest
    // bucket that already starts at/below 0 leaves no world below it to cover.
    const flooredDomain = [...knownUnits].every((u) => NONNEGATIVE_MAGNITUDE_UNITS.has(u));
    const bottomClosed = belowVals.some((v) => v >= buckets[0].lo - step);
    if (!bottomClosed && !(flooredDomain && buckets[0].lo <= 0)) return false;
  }
  return true;
}


/**
 * Detects an outcome-partition double-mapping so the caller can demote a
 * falsely-exhaustive Σ=1 set to Σ≤1 (never drop): two non-residual slots share a
 * folded subject, or one member market is bound under ≥2 kept outcome_ids.
 */
export function isUnionDoubleMapped(
  slots: ReadonlyArray<{
    outcome_id: string;
    subject: string | null;
    is_residual: boolean;
    market_ids: ReadonlyArray<number> | null | undefined;
  }>,
): boolean {
  const foldSubj = (s: string | null) => {
    const t = (s ?? '').trim().toLowerCase();
    return t === '' ? null : t;
  };
  const seenSubj = new Set<string>();
  for (const r of slots) {
    if (r.is_residual) continue;
    const s = foldSubj(r.subject);
    if (s == null) continue;
    if (seenSubj.has(s)) return true;
    seenSubj.add(s);
  }
  const marketToOutcomes = new Map<number, Set<string>>();
  for (const r of slots) {
    for (const mid of r.market_ids ?? []) {
      let s = marketToOutcomes.get(mid);
      if (!s) { s = new Set(); marketToOutcomes.set(mid, s); }
      s.add(r.outcome_id);
      if (s.size > 1) return true;
    }
  }
  return false;
}


type SetGrouping = 'categorical' | 'threshold_series';

/** Per-slot fields the metric-partition + kind-homogeneity helpers read. */
export interface MetricKeyed {
  event_kind: string | null;
  metric_scope?: string | null;
  value_unit: string | null;
  condition_direction: string | null;
  value_primary: number | string | null;
  value_secondary: number | string | null;
  outcome_label?: string | null;
  folded_participants?: string | null;
  cover_subject?: string | null;
}

// A game-total, per-team spread, and player-prop can land in one auto-built
// threshold set; laddering across them is false, so these fold-key by event_kind.
const FIXTURE_METRIC_KINDS = new Set<string>([
  'match_total_metric',
  'match_spread',
  'player_prop_threshold',
]);

// True iff the slots carry exactly one distinct non-null event_kind (or none) —
// gates the negRisk Σ=1 arm. Inert kinds count like NULL.
function isKindHomogeneous(slots: ReadonlyArray<{ event_kind: string | null }>): boolean {
  const kinds = new Set<string>();
  for (const s of slots) if (s.event_kind != null && !isSetInertEventKind(s.event_kind)) kinds.add(s.event_kind);
  return kinds.size <= 1;
}

/**
 * Splits a threshold_series source set into homogeneous metric groups keyed by
 * (fixture-metric event_kind, metric_scope, value_unit, folded participants,
 * cover subject). Purely re-partitioning: never merges slots from distinct
 * metrics. Returns one slot[] per group, in first-seen order.
 */
export function partitionThresholdGroups<T extends MetricKeyed>(
  slots: ReadonlyArray<T>,
  _isResidual: (s: T) => boolean,
): T[][] {
  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  for (const s of slots) {
    const kindPart = s.event_kind != null && FIXTURE_METRIC_KINDS.has(s.event_kind) ? s.event_kind : '';
    const mentionPart = s.event_kind === 'speech_mention' ? (s.outcome_label ?? '').toLowerCase() : '';
    const discPart = setSplitKeyPart(s as unknown as Record<string, unknown>, 'threshold_series');
    const participantPart = s.folded_participants ?? '';
    const coverPart = s.cover_subject ?? '';
    const key = kindPart + '|' + (s.metric_scope ?? '') + '|' + (s.value_unit ?? '') + '|' + mentionPart + '|' + discPart + '|' + participantPart + '|' + coverPart;
    let g = byKey.get(key);
    if (!g) { g = []; byKey.set(key, g); order.push(key); }
    g.push(s);
  }
  return order.map((k) => byKey.get(k)!);
}

// Cross-date partition (feed-A categorical): slots whose condition_dates differ
// at the coarse grain describe different resolving events, so a cross-date
// mutex is false. Skipped for DATE_LATCH_KINDS.
export function partitionByConditionDateGrain<T>(
  slots: ReadonlyArray<T>,
  datesOf: (s: T) => ReadonlyArray<{ date: string; precision: string | null }>,
  kindOf: (s: T) => string | null | undefined,
  isResidual: (s: T) => boolean,
): T[][] {
  const noSplit = (): T[][] => [slots.slice()];
  for (const s of slots) {
    if (isResidual(s)) continue;
    const k = kindOf(s);
    if (k != null && DATE_LATCH_KINDS.has(k)) return noSplit();
  }
  let coarseRank = 1;
  let anyDated = false;
  for (const s of slots) {
    if (isResidual(s)) continue;
    for (const d of datesOf(s)) {
      if (d && d.date) { coarseRank = Math.max(coarseRank, precisionRank(d.precision)); anyDated = true; }
    }
  }
  if (!anyDated) return noSplit();
  const keyOf = (s: T): string | null => {
    const keys = new Set<string>();
    for (const d of datesOf(s)) if (d && d.date) keys.add(grainKeyAt(d.date, coarseRank));
    return keys.size === 1 ? [...keys][0] : null;
  };
  const knownKeys = new Set<string>();
  const years: number[] = [];
  let allDatedAreElection = true;
  let sawDated = false;
  for (const s of slots) {
    if (isResidual(s)) continue;
    const k = keyOf(s);
    if (k === null) continue;
    knownKeys.add(k);
    sawDated = true;
    const y = parseInt(k.slice(0, 4), 10);
    if (Number.isFinite(y)) years.push(y);
    if ((kindOf(s) ?? null) !== 'election_outcome_winner') allDatedAreElection = false;
  }
  if (knownKeys.size < 2) return noSplit();
  const gap = years.length ? Math.max(...years) - Math.min(...years) : 0;
  if (!(gap >= 2 || (sawDated && allDatedAreElection))) return noSplit();

  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  const riders: T[] = [];
  for (const s of slots) {
    const k = isResidual(s) ? null : keyOf(s);
    if (k === null) { riders.push(s); continue; }
    let g = byKey.get(k);
    if (!g) { g = []; byKey.set(k, g); order.push(k); }
    g.push(s);
  }
  let largest = order[0];
  for (const k of order) if (byKey.get(k)!.length > byKey.get(largest)!.length) largest = k;
  for (const r of riders) byKey.get(largest)!.push(r);
  return order.map((k) => byKey.get(k)!);
}

// Game-ordinal sibling of partitionByConditionDateGrain: real slots with ≥2
// distinct known ordinals span different resolution slices, so a Σ=1 mutex is
// false. Feed-B excluded (a bare period token in free text would false-split).
export function partitionByGameOrdinalGrain<T>(
  slots: ReadonlyArray<T>,
  ordinalsOf: (s: T) => ReadonlyArray<number>,
  isResidual: (s: T) => boolean,
): T[][] {
  const noSplit = (): T[][] => [slots.slice()];
  const keyOf = (s: T): number | null => {
    const keys = new Set<number>();
    for (const o of ordinalsOf(s)) if (Number.isFinite(o)) keys.add(o);
    return keys.size === 1 ? [...keys][0] : null;
  };
  const knownKeys = new Set<number>();
  for (const s of slots) {
    if (isResidual(s)) continue;
    const k = keyOf(s);
    if (k !== null) knownKeys.add(k);
  }
  if (knownKeys.size < 2) return noSplit();
  const order: number[] = [];
  const byKey = new Map<number, T[]>();
  const riders: T[] = [];
  for (const s of slots) {
    const k = isResidual(s) ? null : keyOf(s);
    if (k === null) { riders.push(s); continue; }
    let g = byKey.get(k);
    if (!g) { g = []; byKey.set(k, g); order.push(k); }
    g.push(s);
  }
  let largest = order[0];
  for (const k of order) if (byKey.get(k)!.length > byKey.get(largest)!.length) largest = k;
  for (const r of riders) byKey.get(largest)!.push(r);
  return order.map((k) => byKey.get(k)!);
}

const toNumOrNull = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// Orders a kept threshold_series group so slot_ordinal is value-monotone
// (ordinal 1 = strictest rung); below-ladders ascending, above descending, NULL last.
function sortLadderByValue<T extends MetricKeyed>(slots: ReadonlyArray<T>): T[] {
  const isBelow = slots.every((s) => dirPartitionClass(s.condition_direction) === 'below');
  const arr = slots.slice();
  arr.sort((a, b) => {
    const va = toNumOrNull(a.value_primary);
    const vb = toNumOrNull(b.value_primary);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return isBelow ? va - vb : vb - va;
  });
  return arr;
}

// Two rungs sharing one stamped value_primary have no strict ordering, so their
// chain link would be unjustified. Dropping them doesn't shrink Ω (freed rungs
// become independent questions; the surviving chain stays true by transitivity).
// NULL values never collide.
export function dropCollidedLadderRungs<T extends MetricKeyed>(
  slots: ReadonlyArray<T>,
): { kept: T[]; dropped: T[] } {
  const counts = new Map<number, number>();
  for (const s of slots) {
    const v = toNumOrNull(s.value_primary);
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const s of slots) {
    const v = toNumOrNull(s.value_primary);
    if (v !== null && (counts.get(v) ?? 0) > 1) dropped.push(s);
    else kept.push(s);
  }
  return { kept, dropped };
}

export interface Stage4Result {
  outcomeNodes: number;
  outcomeSets: number;
  thresholdEdges: number;
  tournamentEdges: number;
  crossQuestionEdges: {
    numericLadder: number;
    exactScore: number;
    mutualExclusion: number;
    dateImplication: number;
    beforeDateChain: number;
    reachThresholdChain: number;
    marginWinner: number;
    marginLadder: number;
    spreadWinner: number;
    fixtureTotals: number;
    kalshiStrikeLadder: number;
    shapeBridge: number;
    windowContainment: number;
    equivalence: number;
    crossRef: number;
  };
  contradictions: ContradictionResult;
}

export async function runStage4(): Promise<Stage4Result> {
  log.info('Stage 4: projecting semantic + platform events into outcome-nodes…');

  // Idempotent; installs the SQL function same-event.ts relies on.
  await query(installSameEventSql());

  // Dual-map resolution runs first: a market leg-mapped to ≥2 nodes resolves by
  // subject match, or is refused. Loser legs + refused ids thread through every
  // feed-A consumer below as the one accepted-set source of truth.
  const dualMap = await computeDualMapResolutions();
  const cohesionRefusedIds = await computeLegCohesionRefusals(dualMap);
  const refusedLegMarketIds = [...new Set([...dualMap.refusedMarketIds, ...cohesionRefusedIds])];
  await projectNodesFromLegs(refusedLegMarketIds, dualMap.loserLegKeys);
  await linkMembersFromLegs(refusedLegMarketIds, dualMap.loserLegKeys);
  await projectNodesFromUnmatched();
  await linkMembersFromUnmatched();
  await projectSingletonNodesForOrphans(refusedLegMarketIds);
  await linkMembersForOrphans(refusedLegMarketIds);

  await reportRollupConflicts();

  await buildSemanticOutcomeSets(refusedLegMarketIds, dualMap.loserLegKeys);
  await buildPlatformOutcomeSets();
  await buildWcEliminationMutexSets();

  const thresholdEdges = await buildThresholdLadderEdges();
  const tournamentTierA = await buildTournamentEdges();
  const tournamentTierB = await buildTournamentTierB();
  const tournamentEdges = tournamentTierA + tournamentTierB.edges;

  // Runs after all outcome_sets + static edges exist and before count
  // reconciliation / the contradiction detector.
  const crossQuestionEdges = {
    numericLadder: await buildNumericLadderXqEdges(),
    exactScore: await buildExactScoreDerivedEdges(),
    mutualExclusion: await buildMutualExclusionXqEdges(),
    dateImplication: await buildDateImplicationXqEdges(),
    beforeDateChain: await buildBeforeDateChainEdges(),
    reachThresholdChain: await buildReachThresholdChainEdges(),
    marginWinner: await buildMarginWinnerEdges(),
    marginLadder: await buildMarginLadderEdges(),
    spreadWinner: await buildSpreadWinnerEdges(),
    fixtureTotals: await buildFixtureTotalsEdges(),
    kalshiStrikeLadder: await buildKalshiStrikeLadderEdges(),
    mediaReleaseLadder: await buildMediaReleaseLadderEdges(),
    scorerImplication: await buildScorerImplicationEdges(),
    shapeBridge: await buildShapeBridgeEdges(),
    windowContainment: await buildWindowContainmentEdges(),
    equivalence: await buildEquivalenceEdges(),
    electionPrecondition: await buildElectionPreconditionEdges(),
    crossRef: await buildCrossRefEquivalenceEdges(),
    // Runs last so a cross_ref_equiv incumbent on a shared slot wins.
    rateDecisionBridge: await buildRateDecisionBridgeEdges(),
  };

  await updateAllQuestionCounts();

  // Demotes any Σ=1 categorical whose certified slots are no longer all live.
  await reconcileOutcomeSetExhaustivity();

  const dupGate = await runDuplicatePartitionGateStage4();
  if (dupGate.hitCount > 0) {
    log.info(
      `Stage 4 §4 duplicate-partition gate: ${dupGate.hitCount} HIT(s) — ` +
        `${dupGate.collapseCount} Arm-C collapse, ${dupGate.demoteCount} Arm-D demote, ` +
        `${dupGate.suspectPairs} suspect pair(s) recorded`,
    );
  }

  const contradictions = await runContradictionDetection();

  const [{ nodes }] = await query<{ nodes: number }>(`SELECT COUNT(*)::int AS nodes FROM questions WHERE archived_at IS NULL`);
  const [{ sets }] = await query<{ sets: number }>(`SELECT COUNT(*)::int AS sets FROM outcome_sets`);

  const xqTotal = Object.values(crossQuestionEdges).reduce((a, b) => a + b, 0);
  log.info(
    `Stage 4 complete: ${nodes} outcome-nodes, ${sets} outcome_sets, ${thresholdEdges} threshold edges, ` +
    `${tournamentEdges} tournament edges (tierA=${tournamentTierA}, tierB=${tournamentTierB.edges}, ` +
    `championSets=${tournamentTierB.championSets}), ${xqTotal} cross-question edges ` +
    `(ladder=${crossQuestionEdges.numericLadder}, exactScore=${crossQuestionEdges.exactScore}, ` +
    `mutex=${crossQuestionEdges.mutualExclusion}, dateImpl=${crossQuestionEdges.dateImplication}, ` +
    `equiv=${crossQuestionEdges.equivalence}, crossRef=${crossQuestionEdges.crossRef})`,
  );

  // Per-feed node subtotals: feed-A = cross-platform merged ('sem:%'), feed-B =
  // within-platform singletons on unmatched PEs ('pe:%'), orphan = singletons on
  // matched PEs whose market carried no accepted leg.
  const feedSubtotals = await query<{ feed: string; nodes: number; members: number; merged: number }>(`
    WITH bound_pe AS (
      SELECT DISTINCT sep.platform_event_id AS pe_id
      FROM semantic_event_platforms sep
      JOIN semantic_events se ON se.id = sep.semantic_event_id
      WHERE se.archived_at IS NULL
    ),
    q AS (
      SELECT q.member_count,
        CASE
          WHEN q.canonical_key LIKE 'sem:%' THEN 'feedA'
          WHEN q.canonical_key LIKE 'pe:%' THEN
            CASE WHEN EXISTS (
              SELECT 1 FROM question_members qm
              JOIN markets m ON m.id = qm.market_id
              JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
              WHERE qm.question_id = q.id AND pe.id IN (SELECT pe_id FROM bound_pe)
            ) THEN 'orphan' ELSE 'feedB' END
          ELSE 'other'
        END AS feed
      FROM questions q
      WHERE q.archived_at IS NULL
    )
    SELECT feed,
           COUNT(*)::int AS nodes,
           COALESCE(SUM(member_count), 0)::int AS members,
           COALESCE(SUM(GREATEST(member_count - 1, 0)), 0)::int AS merged
    FROM q GROUP BY feed
  `);
  const fs = (name: string) => feedSubtotals.find((r) => r.feed === name) ?? { nodes: 0, members: 0, merged: 0 };
  const fa = fs('feedA'), fb = fs('feedB'), fo = fs('orphan'), fx = fs('other');
  log.info(
    `Stage 4 feed-node subtotals: feed-A ${fa.nodes} slot-node(s)/${fa.members} member(s) (merged ${fa.merged} slot(s) saved), ` +
    `feed-B ${fb.nodes} unmatched-PE singleton(s), orphan ${fo.nodes} matched-PE singleton(s) (AUD-56)` +
    (fx.nodes > 0 ? `, other ${fx.nodes}` : '') +
    ` — sum ${fa.nodes + fb.nodes + fo.nodes + fx.nodes} == ${nodes} outcome-nodes`,
  );
  return { outcomeNodes: nodes, outcomeSets: sets, thresholdEdges, tournamentEdges, crossQuestionEdges, contradictions };
}

// Feed A: matched semantic_event legs → outcome-nodes.

// Deterministic dual-map resolution: a market leg-mapped to ≥2 distinct sem:
// nodes resolves to the leg whose outcome_subject/outcome_id fold-matches the
// market's own canonical_subject. Exactly one match wins; zero or ≥2 matches (or
// NULL canonical_subject) refuses the market to the orphan path. Refusal only
// forgoes fungibility, never adds a constraint, so it is always sound.

const LEG_KEY_SQL = `'sem:' || sel.semantic_event_id || ':' || sel.outcome_id || '#' || sel.market_id`;

export interface DualMapLegRow {
  market_id: number;
  node_key: string;
  outcome_id: string;
  outcome_subject: string | null;
  canonical_subject: string | null;
}

export interface DualMapResolution {
  loserLegKeys: string[];
  refusedMarketIds: number[];
  rerouted: number;
  kept: number;
}

/**
 * Space/case/punctuation-insensitive subject key. Symbol-stripping is safe: a
 * spurious fold can at worst create a second match, which refuses (safe
 * direction), never a wrong win.
 */
export function foldSubjectKey(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return t === '' ? null : t;
}

// Pure dual-map decision (rule above). Only markets with ≥2 distinct node_keys
// are judged; legs considered in sorted node_key order.
export function resolveDualMappedLegs(rows: ReadonlyArray<DualMapLegRow>): DualMapResolution {
  const byMarket = new Map<number, DualMapLegRow[]>();
  for (const r of rows) {
    const g = byMarket.get(r.market_id);
    if (g) g.push(r);
    else byMarket.set(r.market_id, [r]);
  }
  const out: DualMapResolution = { loserLegKeys: [], refusedMarketIds: [], rerouted: 0, kept: 0 };
  for (const [marketId, legs] of byMarket) {
    const nodeKeys = [...new Set(legs.map((l) => l.node_key))].sort();
    if (nodeKeys.length < 2) continue;
    const cs = foldSubjectKey(legs[0].canonical_subject);
    const matching = new Set<string>();
    if (cs !== null) {
      for (const l of legs) {
        if (foldSubjectKey(l.outcome_subject) === cs || foldSubjectKey(l.outcome_id) === cs) {
          matching.add(l.node_key);
        }
      }
    }
    if (matching.size === 1) {
      const winner = [...matching][0];
      if (winner === nodeKeys[0]) out.kept++;
      else out.rerouted++;
      for (const k of nodeKeys) {
        if (k !== winner) out.loserLegKeys.push(`${k}#${marketId}`);
      }
    } else {
      out.refusedMarketIds.push(marketId);
    }
  }
  return out;
}

// Runs first in the feed-A pipeline: its loserLegKeys + refusedMarketIds thread
// into cohesion facts, node projection, member attach, slot facts and the orphan probe.
async function computeDualMapResolutions(): Promise<DualMapResolution> {
  const rows = await query<DualMapLegRow>(`
    WITH legs AS (
      SELECT sel.market_id,
             'sem:' || sel.semantic_event_id || ':' || sel.outcome_id AS node_key,
             sel.outcome_id, sel.outcome_subject
      FROM semantic_event_legs sel
      JOIN semantic_events se ON se.id = sel.semantic_event_id AND se.archived_at IS NULL
      WHERE sel.market_id IS NOT NULL
    ),
    dual AS (
      SELECT market_id FROM legs GROUP BY market_id HAVING COUNT(DISTINCT node_key) >= 2
    )
    SELECT l.market_id, l.node_key, l.outcome_id, l.outcome_subject, n.canonical_subject
    FROM legs l
    JOIN dual d USING (market_id)
    LEFT JOIN llm_market_normalizations n ON n.market_id = l.market_id
    ORDER BY l.market_id, l.node_key
  `);
  const res = resolveDualMappedLegs(rows);
  if (res.kept + res.rerouted + res.refusedMarketIds.length > 0) {
    log.info(
      `dual-map resolve: ${res.kept} kept, ${res.rerouted} re-routed (subject proves a different node), ` +
      `${res.refusedMarketIds.length} refused (no/ambiguous subject evidence) → orphan pe: singletons`,
    );
  }
  return res;
}

/**
 * Feed-A node-projection SQL, exported for the no-DB SQL-invariant tests.
 * $1::int[] = refused market ids; $2::text[] = proven-loser leg keys
 * '<node_key>#<market_id>'. Every per-member CTE reads `accepted_leg`, never
 * raw semantic_event_legs, so a node's fields only come from markets the
 * member attach will actually write.
 */
export function projectNodesFromLegsSql(): string {
  return `
    WITH accepted_leg AS (
      -- Exactly the member set the attach writes: loser legs excluded via $2,
      -- win_rank=1 picks one node per multi-mapped market, refused via $1.
      SELECT t.* FROM (
        SELECT sel.*,
               ROW_NUMBER() OVER (
                 PARTITION BY sel.market_id
                 ORDER BY 'sem:' || sel.semantic_event_id || ':' || sel.outcome_id
               ) AS win_rank
        FROM semantic_event_legs sel
        JOIN semantic_events se ON se.id = sel.semantic_event_id AND se.archived_at IS NULL
        WHERE sel.market_id IS NULL
           OR ${LEG_KEY_SQL} NOT IN (SELECT unnest($2::text[]))
      ) t
      WHERE t.market_id IS NULL
         OR (t.win_rank = 1 AND t.market_id NOT IN (SELECT unnest($1::int[])))
    ),
    cat AS (
      -- event_category = mode of members' category_unified per outcome.
      SELECT sel.semantic_event_id, sel.outcome_id,
             mode() WITHIN GROUP (ORDER BY COALESCE(m.category_unified, 'other')) AS event_category
      FROM accepted_leg sel
      JOIN markets m ON m.id = sel.market_id
      GROUP BY sel.semantic_event_id, sel.outcome_id
    ),
    rep_val AS (
      -- One representative member for the value tuple (value+unit+m/e together).
      SELECT DISTINCT ON (sel.semantic_event_id, sel.outcome_id)
        sel.semantic_event_id, sel.outcome_id,
        n.value_primary, n.value_secondary, n.value_unit,
        n.value_primary_m, n.value_primary_e, n.value_secondary_m, n.value_secondary_e
      FROM accepted_leg sel
      LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      WHERE sel.market_id IS NOT NULL
      ORDER BY sel.semantic_event_id, sel.outcome_id,
               (n.value_primary IS NULL), sel.market_id
    ),
    rep_inv AS (
      -- Scalar prefer-non-null fields (lowest-market_id non-null wins).
      SELECT
        sel.semantic_event_id, sel.outcome_id,
        (array_remove(array_agg(n.canonical_event    ORDER BY sel.market_id), NULL))[1] AS canonical_event,
        (array_remove(array_agg(n.condition_date      ORDER BY sel.market_id), NULL))[1] AS condition_date,
        -- FILTER keeps only dated members so [1] matches the date pick above.
        (array_agg(n.condition_date_precision ORDER BY sel.market_id)
           FILTER (WHERE n.condition_date IS NOT NULL))[1] AS condition_date_precision,
        (array_remove(array_agg(n.temporal_semantics  ORDER BY sel.market_id), NULL))[1] AS temporal_semantics
      FROM accepted_leg sel
      LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      WHERE sel.market_id IS NOT NULL
      GROUP BY sel.semantic_event_id, sel.outcome_id
    ),
    rep_part AS (
      -- participants from one representative member, never a union across members.
      SELECT DISTINCT ON (sel.semantic_event_id, sel.outcome_id)
        sel.semantic_event_id, sel.outcome_id,
        COALESCE(n.participants, '{}'::text[]) AS participants
      FROM accepted_leg sel
      LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      WHERE sel.market_id IS NOT NULL
      ORDER BY sel.semantic_event_id, sel.outcome_id,
               (n.participants IS NULL OR cardinality(n.participants) = 0), sel.market_id
    ),
    rep_mode AS (
      -- mode() for fields members may legitimately disagree on (NULL-skipping).
      SELECT sel.semantic_event_id, sel.outcome_id,
        mode() WITHIN GROUP (ORDER BY n.event_kind)          AS event_kind,
        mode() WITHIN GROUP (ORDER BY n.condition_direction) AS condition_direction,
        mode() WITHIN GROUP (ORDER BY n.condition_metric)    AS condition_metric,
        mode() WITHIN GROUP (ORDER BY n.condition_shape)     AS condition_shape,
        mode() WITHIN GROUP (ORDER BY n.league_id)           AS league_id
      FROM accepted_leg sel
      LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      WHERE sel.market_id IS NOT NULL
      GROUP BY sel.semantic_event_id, sel.outcome_id
    ),
    rep_scope AS (
      -- resolution_scope lives on markets. Exactly one concrete scope among
      -- members wins; disagreement or none concrete → NULL.
      SELECT sel.semantic_event_id, sel.outcome_id,
        CASE WHEN count(DISTINCT m.resolution_scope)
                  FILTER (WHERE m.resolution_scope IS NOT NULL
                            AND m.resolution_scope <> 'unspecified') = 1
             THEN max(m.resolution_scope)
                  FILTER (WHERE m.resolution_scope IS NOT NULL
                            AND m.resolution_scope <> 'unspecified')
             ELSE NULL END AS resolution_scope
      FROM accepted_leg sel
      JOIN markets m ON m.id = sel.market_id
      WHERE sel.market_id IS NOT NULL
      GROUP BY sel.semantic_event_id, sel.outcome_id
    ),
    rep_metric_scope AS (
      -- metric_scope lives on llm_market_normalizations (mirror of rep_scope).
      SELECT sel.semantic_event_id, sel.outcome_id,
        CASE WHEN count(DISTINCT n.metric_scope)
                  FILTER (WHERE n.metric_scope IS NOT NULL) = 1
             THEN max(n.metric_scope) FILTER (WHERE n.metric_scope IS NOT NULL)
             ELSE NULL END AS metric_scope
      FROM accepted_leg sel
      LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      WHERE sel.market_id IS NOT NULL
      GROUP BY sel.semantic_event_id, sel.outcome_id
    ),
    rep_reskind AS (
      -- resolution_kind rolled up to the node: one concrete value wins, else NULL.
      SELECT sel.semantic_event_id, sel.outcome_id,
        CASE WHEN count(DISTINCT n.resolution_kind)
                  FILTER (WHERE n.resolution_kind IS NOT NULL) = 1
             THEN max(n.resolution_kind) FILTER (WHERE n.resolution_kind IS NOT NULL)
             ELSE NULL END AS resolution_kind
      FROM accepted_leg sel
      LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      WHERE sel.market_id IS NOT NULL
      GROUP BY sel.semantic_event_id, sel.outcome_id
    ),
    rep_disc AS (
      -- A key survives only if every member carrying it agrees on the value.
      SELECT semantic_event_id, outcome_id,
             COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) AS discriminators
      FROM (
        SELECT sel.semantic_event_id, sel.outcome_id, e.key AS k, max(e.value) AS v
        FROM accepted_leg sel
        JOIN llm_market_normalizations n ON n.market_id = sel.market_id
        CROSS JOIN LATERAL jsonb_each_text(n.discriminators) e
        WHERE sel.market_id IS NOT NULL
        GROUP BY sel.semantic_event_id, sel.outcome_id, e.key
        HAVING count(DISTINCT e.value) = 1
      ) t
      GROUP BY semantic_event_id, outcome_id
    ),
    draw_slot AS (
      -- Marks the draw outcome so the roll-up substitutes 'Draw' instead of
      -- the fixture string; both conditions exclude cricket/award/UFC labels.
      SELECT sel.semantic_event_id, sel.outcome_id
      FROM accepted_leg sel
      JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      WHERE sel.market_id IS NOT NULL
        AND n.canonical_subject = 'Draw'
        AND lower(n.outcome_label) = 'draw'
      GROUP BY sel.semantic_event_id, sel.outcome_id
    ),
    nodes AS (
      SELECT
        sel.semantic_event_id,
        sel.outcome_id,
        -- se.canonical_event arm refused when fixture-shaped (shared by both
        -- sides, so a subject-less slot becomes indistinguishable from its opponent).
        MAX(COALESCE(
          sel.outcome_subject,
          CASE WHEN ds.semantic_event_id IS NOT NULL THEN 'Draw' END,
          NULLIF(initcap(replace(sel.outcome_id, '_', ' ')), ''),
          CASE WHEN NOT ${isFixturePlaceholderSubjectSql('se.canonical_event')}
               THEN se.canonical_event END
        ))                                                          AS canonical_subject,
        CASE se.grouping_kind
          WHEN 'threshold_series' THEN 'monotonic_threshold'
          ELSE 'binary_event'
        END                                                          AS fallback_shape,
        COUNT(DISTINCT sel.market_id)                                AS member_count,
        COUNT(DISTINCT sel.platform)                                 AS platform_count
      FROM accepted_leg sel
      JOIN semantic_events se ON se.id = sel.semantic_event_id AND se.archived_at IS NULL
      LEFT JOIN draw_slot ds ON ds.semantic_event_id = sel.semantic_event_id AND ds.outcome_id = sel.outcome_id
      GROUP BY sel.semantic_event_id, sel.outcome_id, se.grouping_kind, ds.semantic_event_id
    )
    INSERT INTO questions
      (canonical_key, canonical_subject, condition_shape, condition_date, condition_date_precision, event_category,
       member_count, platform_count, participants,
       canonical_event, event_kind, condition_direction, condition_metric,
       value_primary, value_secondary, value_primary_m, value_primary_e,
       value_secondary_m, value_secondary_e, value_unit, temporal_semantics, league_id,
       resolution_scope, metric_scope, resolution_kind, discriminators)
    SELECT
      'sem:' || n.semantic_event_id || ':' || n.outcome_id,
      n.canonical_subject,
      COALESCE(rm.condition_shape, n.fallback_shape),
      ri.condition_date,
      ri.condition_date_precision,
      NULLIF(c.event_category, 'other'),
      n.member_count,
      n.platform_count,
      COALESCE(rp.participants, '{}'::text[]),
      ri.canonical_event, rm.event_kind, rm.condition_direction, rm.condition_metric,
      rv.value_primary, rv.value_secondary, rv.value_primary_m, rv.value_primary_e,
      rv.value_secondary_m, rv.value_secondary_e, rv.value_unit, ri.temporal_semantics, rm.league_id,
      rs.resolution_scope, rms.metric_scope, rk.resolution_kind, COALESCE(rd.discriminators, '{}'::jsonb)
    FROM nodes n
    LEFT JOIN cat c      ON c.semantic_event_id  = n.semantic_event_id AND c.outcome_id  = n.outcome_id
    LEFT JOIN rep_val rv ON rv.semantic_event_id = n.semantic_event_id AND rv.outcome_id = n.outcome_id
    LEFT JOIN rep_inv ri ON ri.semantic_event_id = n.semantic_event_id AND ri.outcome_id = n.outcome_id
    LEFT JOIN rep_part rp ON rp.semantic_event_id = n.semantic_event_id AND rp.outcome_id = n.outcome_id
    LEFT JOIN rep_mode rm ON rm.semantic_event_id = n.semantic_event_id AND rm.outcome_id = n.outcome_id
    LEFT JOIN rep_scope rs ON rs.semantic_event_id = n.semantic_event_id AND rs.outcome_id = n.outcome_id
    LEFT JOIN rep_metric_scope rms ON rms.semantic_event_id = n.semantic_event_id AND rms.outcome_id = n.outcome_id
    LEFT JOIN rep_reskind rk ON rk.semantic_event_id = n.semantic_event_id AND rk.outcome_id = n.outcome_id
    LEFT JOIN rep_disc rd ON rd.semantic_event_id = n.semantic_event_id AND rd.outcome_id = n.outcome_id
    ON CONFLICT (canonical_key) DO UPDATE SET
      canonical_subject = EXCLUDED.canonical_subject,
      condition_shape   = EXCLUDED.condition_shape,
      condition_date    = EXCLUDED.condition_date,
      event_category    = COALESCE(EXCLUDED.event_category, questions.event_category),
      member_count      = EXCLUDED.member_count,
      platform_count    = EXCLUDED.platform_count,
      participants      = EXCLUDED.participants,
      canonical_event     = EXCLUDED.canonical_event,
      event_kind          = EXCLUDED.event_kind,
      condition_direction = EXCLUDED.condition_direction,
      condition_metric    = EXCLUDED.condition_metric,
      value_primary       = EXCLUDED.value_primary,
      value_secondary     = EXCLUDED.value_secondary,
      value_primary_m     = EXCLUDED.value_primary_m,
      value_primary_e     = EXCLUDED.value_primary_e,
      value_secondary_m   = EXCLUDED.value_secondary_m,
      value_secondary_e   = EXCLUDED.value_secondary_e,
      value_unit          = EXCLUDED.value_unit,
      temporal_semantics  = EXCLUDED.temporal_semantics,
      league_id           = EXCLUDED.league_id,
      resolution_scope    = EXCLUDED.resolution_scope,
      metric_scope        = EXCLUDED.metric_scope,
      resolution_kind     = EXCLUDED.resolution_kind,
      discriminators      = EXCLUDED.discriminators,
      updated_at          = NOW()
  `;
}

async function projectNodesFromLegs(refusedMarketIds: number[], loserLegKeys: string[]): Promise<void> {
  await query(projectNodesFromLegsSql(), [refusedMarketIds, loserLegKeys]);
}

async function reportRollupConflicts(): Promise<void> {
  const [row] = await query<{ scope_conflicts: number; kind_conflicts: number }>(`
    WITH scope_c AS (
      SELECT qm.question_id
      FROM question_members qm
      JOIN markets m ON m.id = qm.market_id
      WHERE m.resolution_scope IS NOT NULL AND m.resolution_scope <> 'unspecified'
      GROUP BY qm.question_id
      HAVING count(DISTINCT m.resolution_scope) >= 2
    ),
    kind_c AS (
      SELECT qm.question_id
      FROM question_members qm
      JOIN llm_market_normalizations n ON n.market_id = qm.market_id
      WHERE n.resolution_kind IS NOT NULL
      GROUP BY qm.question_id
      HAVING count(DISTINCT n.resolution_kind) >= 2
    )
    SELECT (SELECT count(*)::int FROM scope_c) AS scope_conflicts,
           (SELECT count(*)::int FROM kind_c)  AS kind_conflicts
  `);
  const scope = row?.scope_conflicts ?? 0;
  const kind = row?.kind_conflicts ?? 0;
  rollupCount('resolution_scope_conflict', scope);
  rollupCount('resolution_kind_conflict', kind);
  if (scope > 0 || kind > 0) {
    log.warn(
      `rollup conflict census: rollup.resolution_scope_conflict=${scope}, ` +
      `rollup.resolution_kind_conflict=${kind} node(s) — members disagree on a ` +
      `concrete value; rolled up to NULL (a scope/kind-disagreeing member set is a ` +
      `soundness signal, never a picked winner)`,
    );
  } else {
    log.info('rollup conflict census: 0 resolution_scope/kind conflicts');
  }
}

// Member-cohesion belt: each candidate must agree with every accepted member
// on event_kind/value/direction/unit/day-grain date. NULL-tolerant.
async function computeLegCohesionRefusals(dualMap: DualMapResolution): Promise<number[]> {
  const rows = await query<MemberFacts & { node_key: string }>(`
    SELECT DISTINCT ON (sel.market_id)
      'sem:' || sel.semantic_event_id || ':' || sel.outcome_id AS node_key,
      sel.market_id,
      sel.platform,
      m.title,
      m.platform_event_id,
      m.end_date::text          AS end_date,
      mmr.raw->>'event_ticker'  AS event_ticker,
      mmr.raw->>'yes_sub_title' AS yes_sub_title,
      mmr.raw->>'strike_type'   AS strike_type,
      n.event_kind,
      n.condition_metric,
      n.condition_direction,
      n.condition_shape,
      n.value_primary::text     AS value_primary,
      n.value_secondary::text   AS value_secondary,
      n.value_unit,
      n.condition_date,
      n.condition_date_precision,
      n.metric_scope
    FROM semantic_event_legs sel
    JOIN semantic_events se ON se.id = sel.semantic_event_id AND se.archived_at IS NULL
    JOIN markets m ON m.id = sel.market_id
    LEFT JOIN market_metadata_raw mmr ON mmr.market_id = sel.market_id
    LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
    WHERE sel.market_id IS NOT NULL
      AND sel.market_id NOT IN (SELECT unnest($1::int[]))
      AND ${LEG_KEY_SQL} NOT IN (SELECT unnest($2::text[]))
    ORDER BY sel.market_id, ('sem:' || sel.semantic_event_id || ':' || sel.outcome_id)
  `, [dualMap.refusedMarketIds, dualMap.loserLegKeys]);

  const { refused } = partitionCohesiveMembers(rows);
  for (const r of refused) {
    log.info(`member-cohesion refuse: market ${r.market_id} not attached to ${r.node_key} — ${r.reason}`);
  }
  const refusedIds = refused.map((r) => r.market_id);
  if (refusedIds.length > 0) {
    const nodeCount = new Set(refused.map((r) => r.node_key)).size;
    log.info(`member-cohesion: refused ${refusedIds.length} member attach(es) across ${nodeCount} node(s); they re-enter as orphan singletons`);
  }
  return refusedIds;
}

async function computeFeedAHalfLineFoldDrops(): Promise<number[]> {
  interface FoldRow {
    semantic_event_id: number;
    outcome_id: string;
    market_id: number;
    title: string | null;
    condition_direction: string | null;
    value_primary: string | null;
    value_unit: string | null;
    strike_type: string | null;
    floor_strike: string | null;
    cap_strike: string | null;
    custom_strike: string | null;
  }
  const rows = await query<FoldRow>(`
    SELECT sel.semantic_event_id, sel.outcome_id, sel.market_id,
           m.title,
           n.condition_direction, n.value_primary::text AS value_primary, n.value_unit,
           mmr.raw->>'strike_type'   AS strike_type,
           mmr.raw->>'floor_strike'  AS floor_strike,
           mmr.raw->>'cap_strike'    AS cap_strike,
           mmr.raw->>'custom_strike' AS custom_strike
      FROM semantic_event_legs sel
      JOIN semantic_events se ON se.id = sel.semantic_event_id AND se.archived_at IS NULL
      JOIN markets m ON m.id = sel.market_id
      LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      LEFT JOIN market_metadata_raw mmr ON mmr.market_id = sel.market_id
     WHERE sel.market_id IS NOT NULL AND NOT sel.is_residual
     ORDER BY sel.semantic_event_id, sel.outcome_id, sel.market_id
  `);
  const byNode = new Map<string, { se: number; outcome_id: string; members: HalfLineMemberRef[] }>();
  for (const r of rows) {
    const key = `${r.semantic_event_id}\x00${r.outcome_id}`;
    let g = byNode.get(key);
    if (!g) { g = { se: r.semantic_event_id, outcome_id: r.outcome_id, members: [] }; byNode.set(key, g); }
    g.members.push({ market_id: r.market_id, half_line: parseMemberHalfLine(r) });
  }
  const drops = new Set<number>();
  for (const g of byNode.values()) {
    if (g.members.length < 2) continue;
    const slug = parseSlugHalfLine(g.outcome_id);
    for (const mid of halfLineFoldDropMarketIds(slug, g.members)) {
      drops.add(mid);
      beltHit('stage4_half_line_fold_gate', { se: g.se, outcome: g.outcome_id, market: mid });
    }
  }
  return [...drops];
}

async function linkMembersFromLegs(refusedIds: number[], loserLegKeys: string[]): Promise<void> {
  const foldDrops = await computeFeedAHalfLineFoldDrops();
  if (foldDrops.length > 0) {
    log.info(`Feed-A half-line fold gate: dropped ${foldDrops.length} conflicting member link(s) → orphan singletons`);
  }
  const dropIds = foldDrops.length > 0 ? [...new Set([...refusedIds, ...foldDrops])] : refusedIds;

  if (dropIds.length > 0) {
    await query(
      `DELETE FROM question_members qm
       USING questions q
       WHERE q.id = qm.question_id
         AND q.canonical_key LIKE 'sem:%'
         AND qm.market_id = ANY($1::int[])`,
      [dropIds],
    );
  }

  await query(
    `
    INSERT INTO question_members (question_id, market_id, platform)
    SELECT DISTINCT ON (sel.market_id) q.id, sel.market_id, sel.platform
    FROM semantic_event_legs sel
    JOIN semantic_events se ON se.id = sel.semantic_event_id AND se.archived_at IS NULL
    JOIN questions q ON q.canonical_key = 'sem:' || sel.semantic_event_id || ':' || sel.outcome_id
    WHERE sel.market_id IS NOT NULL
      AND sel.market_id NOT IN (SELECT unnest($1::int[]))
      AND ${LEG_KEY_SQL} NOT IN (SELECT unnest($2::text[]))
    ORDER BY sel.market_id, q.canonical_key
    ON CONFLICT (market_id) DO UPDATE
      SET question_id = EXCLUDED.question_id, platform = EXCLUDED.platform
  `,
    [dropIds, loserLegKeys],
  );
}

// ── Feed B: un-matched platform_events → within-platform outcome-nodes ────────

// "Un-matched" = not bound to any non-archived semantic_event.
const UNMATCHED_PE = `
  pe.id NOT IN (
    SELECT sep.platform_event_id
    FROM semantic_event_platforms sep
    JOIN semantic_events se ON se.id = sep.semantic_event_id
    WHERE se.archived_at IS NULL
  )
`;

async function projectNodesFromUnmatched(): Promise<void> {
  await query(`
    INSERT INTO questions
      (canonical_key, canonical_subject, condition_shape, condition_value, condition_date,
       condition_date_precision,
       event_category, member_count, platform_count, participants,
       canonical_event, event_kind, condition_direction, condition_metric,
       value_primary, value_secondary, value_primary_m, value_primary_e,
       value_secondary_m, value_secondary_e, value_unit, temporal_semantics, league_id,
       resolution_scope, metric_scope, resolution_kind, discriminators)
    SELECT
      'pe:' || pe.id || ':' || m.id,
      COALESCE(NULLIF(n.canonical_subject, ''), pe.canonical_subject, LEFT(m.title, 200), 'unknown'),
      n.condition_shape,
      n.condition_value,
      n.condition_date,
      n.condition_date_precision,
      NULLIF(COALESCE(m.category_unified, 'other'), 'other'),
      1,
      1,
      COALESCE(n.participants, '{}'::text[]),
      n.canonical_event, n.event_kind, n.condition_direction, n.condition_metric,
      n.value_primary, n.value_secondary, n.value_primary_m, n.value_primary_e,
      n.value_secondary_m, n.value_secondary_e, n.value_unit, n.temporal_semantics, n.league_id,
      m.resolution_scope, n.metric_scope, n.resolution_kind, COALESCE(n.discriminators, '{}'::jsonb)
    FROM platform_events pe
    JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
      AND m.resolved_at IS NULL  -- a settled child is a known-value world, not a live slot
    LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
    WHERE ${UNMATCHED_PE}
    ON CONFLICT (canonical_key) DO UPDATE SET
      canonical_subject = EXCLUDED.canonical_subject,
      condition_shape   = EXCLUDED.condition_shape,
      condition_value   = EXCLUDED.condition_value,
      condition_date    = EXCLUDED.condition_date,
      condition_date_precision = EXCLUDED.condition_date_precision,
      event_category    = COALESCE(EXCLUDED.event_category, questions.event_category),
      participants      = EXCLUDED.participants,
      canonical_event     = EXCLUDED.canonical_event,
      event_kind          = EXCLUDED.event_kind,
      condition_direction = EXCLUDED.condition_direction,
      condition_metric    = EXCLUDED.condition_metric,
      value_primary       = EXCLUDED.value_primary,
      value_secondary     = EXCLUDED.value_secondary,
      value_primary_m     = EXCLUDED.value_primary_m,
      value_primary_e     = EXCLUDED.value_primary_e,
      value_secondary_m   = EXCLUDED.value_secondary_m,
      value_secondary_e   = EXCLUDED.value_secondary_e,
      value_unit          = EXCLUDED.value_unit,
      temporal_semantics  = EXCLUDED.temporal_semantics,
      league_id           = EXCLUDED.league_id,
      resolution_scope    = EXCLUDED.resolution_scope,
      metric_scope        = EXCLUDED.metric_scope,
      resolution_kind     = EXCLUDED.resolution_kind,
      discriminators      = EXCLUDED.discriminators,
      updated_at          = NOW()
  `);
}

async function linkMembersFromUnmatched(): Promise<void> {
  await query(`
    INSERT INTO question_members (question_id, market_id, platform)
    SELECT q.id, m.id, m.platform
    FROM platform_events pe
    JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
      AND m.resolved_at IS NULL  -- a settled child is a known-value world, not a live slot
    JOIN questions q ON q.canonical_key = 'pe:' || pe.id || ':' || m.id
    WHERE ${UNMATCHED_PE}
    ON CONFLICT (market_id) DO UPDATE
      SET question_id = EXCLUDED.question_id, platform = EXCLUDED.platform
  `);
}


// Guarantees a singleton outcome-node (`pe:<pe>:<market>`, member_count=1) for
// every market still lacking a node after feeds A+B. cohesionRefusedMarketIds
// bypasses the shape gate so a cohesion-refused member re-enters unshaped.
async function projectSingletonNodesForOrphans(cohesionRefusedMarketIds: number[] = []): Promise<void> {
  await query(`
    INSERT INTO questions
      (canonical_key, canonical_subject, condition_shape, condition_value, condition_date,
       condition_date_precision,
       event_category, member_count, platform_count, participants,
       canonical_event, event_kind, condition_direction, condition_metric,
       value_primary, value_secondary, value_primary_m, value_primary_e,
       value_secondary_m, value_secondary_e, value_unit, temporal_semantics, league_id,
       resolution_scope, metric_scope, resolution_kind, discriminators)
    SELECT
      'pe:' || m.platform_event_id_fk || ':' || m.id,
      COALESCE(NULLIF(n.canonical_subject, ''), LEFT(m.title, 200), 'unknown'),
      n.condition_shape,
      n.condition_value,
      n.condition_date,
      n.condition_date_precision,
      NULLIF(COALESCE(m.category_unified, 'other'), 'other'),
      1,
      1,
      COALESCE(n.participants, '{}'::text[]),
      n.canonical_event, n.event_kind, n.condition_direction, n.condition_metric,
      n.value_primary, n.value_secondary, n.value_primary_m, n.value_primary_e,
      n.value_secondary_m, n.value_secondary_e, n.value_unit, n.temporal_semantics, n.league_id,
      m.resolution_scope, n.metric_scope, n.resolution_kind, COALESCE(n.discriminators, '{}'::jsonb)
    FROM (
      SELECT m.*, pe.id AS platform_event_id_fk
      FROM markets m
      JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
    ) m
    LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
    WHERE m.resolved_at IS NULL
      AND (n.condition_shape IS NOT NULL OR m.id IN (SELECT unnest($1::int[])))
      AND NOT EXISTS (SELECT 1 FROM question_members qm WHERE qm.market_id = m.id)
    ON CONFLICT (canonical_key) DO UPDATE SET
      canonical_subject = EXCLUDED.canonical_subject,
      condition_shape   = EXCLUDED.condition_shape,
      condition_value   = EXCLUDED.condition_value,
      condition_date    = EXCLUDED.condition_date,
      condition_date_precision = EXCLUDED.condition_date_precision,
      event_category    = COALESCE(EXCLUDED.event_category, questions.event_category),
      participants      = EXCLUDED.participants,
      canonical_event     = EXCLUDED.canonical_event,
      event_kind          = EXCLUDED.event_kind,
      condition_direction = EXCLUDED.condition_direction,
      condition_metric    = EXCLUDED.condition_metric,
      value_primary       = EXCLUDED.value_primary,
      value_secondary     = EXCLUDED.value_secondary,
      value_primary_m     = EXCLUDED.value_primary_m,
      value_primary_e     = EXCLUDED.value_primary_e,
      value_secondary_m   = EXCLUDED.value_secondary_m,
      value_secondary_e   = EXCLUDED.value_secondary_e,
      value_unit          = EXCLUDED.value_unit,
      temporal_semantics  = EXCLUDED.temporal_semantics,
      league_id           = EXCLUDED.league_id,
      resolution_scope    = EXCLUDED.resolution_scope,
      metric_scope        = EXCLUDED.metric_scope,
      resolution_kind     = EXCLUDED.resolution_kind,
      discriminators      = EXCLUDED.discriminators,
      updated_at          = NOW()
  `, [cohesionRefusedMarketIds]);
}

async function linkMembersForOrphans(cohesionRefusedMarketIds: number[] = []): Promise<void> {
  const rows = await query<{ n: number }>(`
    WITH ins AS (
      INSERT INTO question_members (question_id, market_id, platform)
      SELECT q.id, m.id, m.platform
      FROM markets m
      JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
      JOIN questions q ON q.canonical_key = 'pe:' || pe.id || ':' || m.id
      LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
      WHERE m.resolved_at IS NULL
        AND (n.condition_shape IS NOT NULL OR m.id IN (SELECT unnest($1::int[])))
        AND NOT EXISTS (SELECT 1 FROM question_members qm WHERE qm.market_id = m.id)
      ON CONFLICT (market_id) DO NOTHING
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM ins
  `, [cohesionRefusedMarketIds]);
  const n = rows[0]?.n ?? 0;
  if (n > 0) log.info('feed-orphan: ' + n + ' singleton node(s) for orphaned shaped market(s) (AUD-56)');

  if (cohesionRefusedMarketIds.length > 0) {
    const missed = await query<{ market_id: number }>(
      `SELECT t.market_id
       FROM unnest($1::int[]) AS t(market_id)
       WHERE NOT EXISTS (SELECT 1 FROM question_members qm WHERE qm.market_id = t.market_id)`,
      [cohesionRefusedMarketIds],
    );
    if (missed.length > 0) {
      log.warn(
        `member-cohesion: ${missed.length} refused market(s) NOT re-homed as singletons ` +
        `(no platform_event row?) — market ids: ${missed.slice(0, 20).map((r) => r.market_id).join(', ')}`,
      );
    }
  }
}

// ── outcome_sets + slots ─────────────────────────────────────────────────────

const SEMANTIC_OUTCOME_LEG_FACTS_SQL = `
    SELECT se.id AS se_id,
           CASE se.grouping_kind WHEN 'categorical_exclusive' THEN 'categorical' ELSE 'threshold_series' END AS set_type,
           se.canonical_event AS set_name,
           se.confidence,
           oc.outcome_id,
           COALESCE(oc.subject, oc.label) AS label,
           oc.subject AS subject,
           oc.label AS outcome_label,
           oc.market_ids,
           oc.platforms,
           oc.is_residual,
           oc.has_negrisk,
           oc.has_value,
           oc.value_primary,
           oc.value_secondary,
           oc.condition_direction,
           oc.value_unit,
           oc.condition_shape,
           oc.metric_scope,
           oc.event_kind,
           oc.is_multiyes,
           oc.is_multiwinner,
           oc.is_open_race,
           oc.canonical_events,
           oc.condition_dates,
           oc.event_kinds,
           oc.resolution_sources,
           oc.event_ticker,
           oc.is_kalshi_custom_score,
           oc.folded_participants,
           oc.cover_subject,
           oc.native_independent${setSplitPassthroughCols('oc')}
    FROM semantic_events se
    JOIN (
      SELECT sel.semantic_event_id,
             sel.outcome_id,
             MIN(sel.outcome_ordinal) AS ord,
             (array_remove(array_agg(sel.outcome_subject ORDER BY sel.market_id), NULL))[1] AS subject,
             (array_remove(array_agg(sel.outcome_label   ORDER BY sel.market_id), NULL))[1] AS label,
             array_agg(DISTINCT sel.market_id) AS market_ids,
             array_remove(array_agg(DISTINCT m.platform), NULL) AS platforms,
             bool_or(sel.is_residual) AS is_residual,
             bool_or(${NATIVE_MUTEX_SQL('mmr')}) AS has_negrisk,
             bool_or(n.value_primary IS NOT NULL) AS has_value,
             (array_remove(array_agg(n.value_primary ORDER BY sel.market_id), NULL))[1] AS value_primary,
             (array_remove(array_agg(n.value_secondary ORDER BY sel.market_id), NULL))[1] AS value_secondary,
             (array_remove(array_agg(n.condition_direction ORDER BY sel.market_id), NULL))[1] AS condition_direction,
             (array_remove(array_agg(n.value_unit ORDER BY sel.market_id), NULL))[1] AS value_unit,
             (array_remove(array_agg(n.condition_metric ORDER BY sel.market_id), NULL))[1] AS condition_metric,
             (array_remove(array_agg(n.condition_shape ORDER BY sel.market_id), NULL))[1] AS condition_shape,
             (array_remove(array_agg(n.metric_scope ORDER BY sel.market_id), NULL))[1] AS metric_scope,
             (array_remove(array_agg(n.event_kind ORDER BY sel.market_id), NULL))[1] AS event_kind,
             -- looksMultiYesPredicate mirror.
             bool_or(
               n.event_kind = 'stage_advance'
               OR (
                 m.title ~* '\\y(finish(es|ing)? (in the )?top|top[- ]?[0-9]|relegat|make[s]? (the )?(playoff|postseason|knockout))'
                 AND (n.event_kind IS NULL OR n.event_kind NOT IN ('match_winner','halftime_leader','exact_score','candle_direction'))
               )
             ) AS is_multiyes,
             bool_or(
               m.title ~* '\\y((advance\\w*|qualif\\w*) (to|for|into) (the )?(grand )?(final\\w*|semi\\w*|knockout\\w*|playoff\\w*|next round|round of)|relegat\\w*|make[s]? (the )?(playoff|postseason|knockout)|finish(es|ing)? (in )?(the )?top[- ]?[0-9]|top[- ]?[0-9]+ finish\\w*)'
               AND (n.event_kind IS NULL OR n.event_kind NOT IN ('match_winner','halftime_leader','exact_score','candle_direction'))
             ) AS is_multiwinner,
             bool_or(${openRaceLegSql('m.title')}) AS is_open_race,
             array_remove(array_agg(DISTINCT n.canonical_event), NULL) AS canonical_events,
             COALESCE(
               jsonb_agg(DISTINCT jsonb_build_object('date', n.condition_date::text, 'precision', n.condition_date_precision))
                 FILTER (WHERE n.condition_date IS NOT NULL),
               '[]'::jsonb
             ) AS condition_dates,
             array_remove(array_agg(DISTINCT n.event_kind), NULL) AS event_kinds,
             array_remove(array_agg(DISTINCT n.resolution_source), NULL) AS resolution_sources,
             (array_remove(array_agg(mmr.raw->>'event_ticker' ORDER BY sel.market_id), NULL))[1] AS event_ticker,
             bool_or(mmr.raw->>'strike_type' = 'custom' AND mmr.raw->>'event_ticker' LIKE 'KX%SCORE-%') AS is_kalshi_custom_score,
             array_remove(array_agg(DISTINCT ${settlementDimensionSql('mmr.raw')}), NULL) AS settlement_dimensions,
             (array_remove(array_agg(${foldedParticipantsKeySql('n.participants')} ORDER BY sel.market_id), NULL))[1] AS folded_participants,
             (array_remove(array_agg(n.discriminators->>'cover_subject' ORDER BY sel.market_id), NULL))[1] AS cover_subject,
             array_remove(array_agg(DISTINCT n.discriminators->>'game_ordinal'), NULL) AS game_ordinals,
             bool_or(
               m.grouping_type = 'bundle_nonexclusive'
               OR ke.raw->>'mutually_exclusive' = 'false'
             ) AS native_independent
             ${setSplitSlotProjectionsFeedA('n', 'sel.market_id')}
      FROM semantic_event_legs sel
      LEFT JOIN markets m ON m.id = sel.market_id
      LEFT JOIN market_metadata_raw mmr ON mmr.market_id = sel.market_id
      LEFT JOIN kalshi_events ke ON m.platform = 'kalshi' AND ke.event_ticker = mmr.raw->>'event_ticker'
      LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
      WHERE sel.market_id IS NULL
         OR (sel.market_id NOT IN (SELECT unnest($1::int[]))
             AND ${LEG_KEY_SQL} NOT IN (SELECT unnest($2::text[])))
      GROUP BY sel.semantic_event_id, sel.outcome_id
    ) oc ON oc.semantic_event_id = se.id
    WHERE se.archived_at IS NULL
      AND se.grouping_kind IN ('categorical_exclusive', 'threshold_series')
    ORDER BY se.id, oc.ord NULLS LAST, oc.outcome_id
  `;

// Feed-A slot-facts SQL, exported for the no-DB SQL-invariant tests. No
// win-rank filter (unlike projectNodesFromLegsSql): a residual double-map must
// stay visible under both outcome_ids for isUnionDoubleMapped.
export function semanticOutcomeLegFactsSql(): string {
  return SEMANTIC_OUTCOME_LEG_FACTS_SQL;
}

export function semanticSetOrphanProbeSql(): string {
  return `
    SELECT se.id AS se_id,
           bool_or(legged.market_id IS NULL) AS orphan
    FROM semantic_events se
    JOIN semantic_event_platforms sep ON sep.semantic_event_id = se.id
    JOIN platform_events pe ON pe.id = sep.platform_event_id
    JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
      AND m.resolved_at IS NULL
    JOIN llm_market_normalizations cn ON cn.market_id = m.id AND cn.condition_shape IS NOT NULL
    LEFT JOIN (
      SELECT DISTINCT sel.semantic_event_id, sel.market_id
      FROM semantic_event_legs sel
      WHERE sel.market_id IS NOT NULL
        AND sel.market_id NOT IN (SELECT unnest($1::int[]))
        AND ${LEG_KEY_SQL} NOT IN (SELECT unnest($2::text[]))
    ) legged ON legged.semantic_event_id = se.id AND legged.market_id = m.id
    WHERE se.archived_at IS NULL
    GROUP BY se.id
  `;
}

async function buildSemanticOutcomeSets(refusedMarketIds: number[], loserLegKeys: string[]): Promise<void> {
  const outcomeRows = await query<{
    se_id: number;
    set_type: 'categorical' | 'threshold_series';
    set_name: string;
    confidence: number;
    outcome_id: string;
    label: string | null;
    subject: string | null;
    outcome_label: string | null;
    market_ids: number[];
    platforms: string[] | null;
    is_residual: boolean;
    has_negrisk: boolean;
    has_value: boolean;
    value_primary: number | null;
    value_secondary: number | null;
    condition_direction: string | null;
    value_unit: string | null;
    condition_metric: string | null;
    condition_shape: string | null;
    metric_scope: string | null;
    event_kind: string | null;
    is_multiyes: boolean;
    is_multiwinner: boolean;
    is_open_race: boolean;
    canonical_events: string[] | null;
    condition_dates: { date: string; precision: string | null }[] | null;
    event_kinds: string[] | null;
    resolution_sources: string[] | null;
    event_ticker: string | null;
    is_kalshi_custom_score: boolean | null;
    settlement_dimensions: string[] | null;
    folded_participants: string | null;
    cover_subject: string | null;
    native_independent: boolean | null;
    game_ordinals: string[] | null;
  }>(semanticOutcomeLegFactsSql(), [refusedMarketIds, loserLegKeys]);

  const bySe = new Map<number, typeof outcomeRows>();
  for (const r of outcomeRows) {
    const g = bySe.get(r.se_id);
    if (g) g.push(r);
    else bySe.set(r.se_id, [r]);
  }

  // Batch-types subject surface forms once, then classifies aggregate kind so
  // the certifier can refuse a winner-grain set mixing an org/party aggregate
  // with a politician member.
  // One DB round-trip for the whole feed. Keyed '<se>\u0000<oid>'.
  const kindKey = (seId: number, oid: string) => `${seId}\u0000${oid}`;
  const subjectTypeByOutcome = new Map<string, SubjectType>();
  {
    const allForms = new Set<string>();
    const formsByOutcome = new Map<string, string[]>();
    for (const r of outcomeRows) {
      if (r.is_residual) continue; // a residual is the complement, never an aggregate/member
      const forms = subjectTypeForms(r.subject, r.outcome_label ?? r.label, r.outcome_id);
      formsByOutcome.set(kindKey(r.se_id, r.outcome_id), forms);
      for (const f of forms) allForms.add(f);
    }
    const typings = await getSubjectTypings([...allForms]);
    for (const [key, forms] of formsByOutcome) {
      subjectTypeByOutcome.set(key, classifyAggregateKind(forms, (f) => typings.get(f)));
    }
  }

  // A championship_winner set may assert Sigma=1 only if every live shaped
  // child of every bound platform_event is mapped to a slot; a cohesion-refused
  // child counts as an orphan too (demotes Sigma=1 -> Sigma<=1, subtractive).
  const orphanRows = await query<{ se_id: number; orphan: boolean }>(
    semanticSetOrphanProbeSql(),
    [refusedMarketIds, loserLegKeys],
  );
  const seHasOrphan = new Map<number, boolean>();
  for (const r of orphanRows) seHasOrphan.set(r.se_id, r.orphan);

  const survivors: { seId: number; subKey: string; setType: string; setName: string; confidence: number; orderedOutcomeIds: string[]; isExhaustive: boolean }[] = [];
  let droppedSlots = 0;
  let demotedSets = 0;
  let nonExhaustive = 0;
  let heteroSplitSets = 0;
  let heteroFreedSlots = 0;
  let driftDupSets = 0;
  let driftDupSlots = 0;
  let beltDemotedSets = 0;
  let grainSplitSets = 0; // categorical folds split into per-grain sets
  let thresholdGrainFreedSets = 0; // threshold-like grain groups freed (ladder ≠ mutex)
  let thresholdGrainFreedSlots = 0;
  let ladderCollisionSets = 0; // ladders with ≥2 rungs on one stamped value
  let ladderCollisionSlots = 0;
  for (const [seId, rows] of bySe) {
    const { drop, residual: detectedResidual } = placeholderSlotsInSet(
      rows.map((r) => ({ id: r.outcome_id, label: r.label })),
    );
    const isResidual = (r: typeof rows[number]) => r.is_residual || detectedResidual.has(r.outcome_id);
    const kept = rows.filter((r) => !drop.has(r.outcome_id));
    droppedSlots += rows.length - kept.length;
    const realCount = kept.filter((r) => !isResidual(r)).length;
    if (realCount < 2) {
      if (rows.length >= 2) demotedSets++;
      continue;
    }
    const groupedAs: SetGrouping = rows[0].set_type === 'categorical' ? 'categorical' : 'threshold_series';
    const allBoundChildrenMapped = !(seHasOrphan.get(seId) ?? false);
    const openRaceFold = kept.some((r) => r.is_open_race) || looksOpenRace(rows[0].set_name);
    const toSlot = (r: typeof rows[number]): CertifierSlot => ({
      outcome_id: r.outcome_id,
      display_label: r.subject,
      canonical_subject: r.subject,
      is_residual: isResidual(r),
      market_ids: r.market_ids,
      platforms: r.platforms,
      direction: r.condition_direction,
      value_primary: r.value_primary,
      value_secondary: r.value_secondary,
      value_unit: r.value_unit,
      condition_metric: r.condition_metric,
      condition_shape: r.condition_shape,
      axis_interval: computeAxisInterval({
        is_residual: isResidual(r),
        event_kind: r.event_kind,
        value_unit: r.value_unit,
        direction: r.condition_direction,
        value_primary: r.value_primary,
        value_secondary: r.value_secondary,
        axis_key: r.outcome_id,
        label_fallback: r.outcome_label ?? r.label,
      }),
      condition_date: r.condition_dates?.[0]?.date ?? null,
      event_kind: r.event_kind,
      is_multiyes: r.is_multiyes,
      has_negrisk: r.has_negrisk,
      native_independent: r.native_independent ?? false,
      folded_participants: r.folded_participants,
      subject_type: r.is_residual ? null : subjectTypeByOutcome.get(kindKey(r.se_id, r.outcome_id)),
      mutex_cardinality: awardMaxWinners(r.event_ticker) ?? (r.is_multiwinner ? 2 : null),
      is_kalshi_custom_score: r.is_kalshi_custom_score ?? false,
      settlement_dimensions: r.settlement_dimensions ?? null,
      disc: {
        metric_scope: r.metric_scope,
        mention_phrase: r.event_kind === 'speech_mention' ? (r.outcome_label ?? null) : null,
        ...slotSetSplitDisc(r as unknown as Record<string, unknown>, groupedAs),
      },
    });
    const toBeltFacts = (r: typeof rows[number]): BeltSlotFacts => ({
      outcome_id: r.outcome_id,
      canonical_events: r.canonical_events ?? [],
      condition_dates: (r.condition_dates ?? []).map((d) => ({ date: d.date, precision: d.precision ?? null })),
      event_kinds: r.event_kinds ?? [],
      resolution_sources: r.resolution_sources ?? [],
    });
    let gi = 0;
    if (groupedAs === 'categorical') {
      const hetero = partitionHeteroCategoricalByKind(kept.map(toSlot));
      if (hetero) {
        heteroSplitSets++;
        heteroFreedSlots += hetero.freedSlots.length;
        const rowByOutcome = new Map(kept.map((r) => [r.outcome_id, r]));
        for (const g of hetero.mutexGroups) {
          const groupRows = g.map((s) => rowByOutcome.get(s.outcome_id)!);
          const subKey = gi === 0 ? '' : '#m' + gi;
          gi++;
          nonExhaustive++;
          survivors.push({
            seId,
            subKey,
            setType: 'categorical',
            setName: rows[0].set_name,
            confidence: rows[0].confidence,
            orderedOutcomeIds: groupRows.map((r) => r.outcome_id),
            isExhaustive: false,
          });
        }
        continue;
      }
    }
    let driftDropped = false;
    let workingKept = kept;
    if (groupedAs === 'categorical') {
      const dupIds = labelDriftDuplicateOutcomeIds(kept.map(toSlot));
      if (dupIds.size > 0) {
        driftDropped = true;
        driftDupSets++;
        driftDupSlots += dupIds.size;
        workingKept = kept.filter((r) => !dupIds.has(r.outcome_id));
        log.info(
          `label-drift dup: set semantic:${seId} holds the same outcome ≥2× via label drift — ` +
          `excluding slot(s) [${[...dupIds].join(', ')}]; Σ=1 refused`,
        );
        if (workingKept.filter((r) => !isResidual(r)).length < 2) { demotedSets++; continue; }
      }
    }
    // A categorical source SE is partitioned by outcome grain (catches a fused
    // fold whose legs carry NULL Stage-1 event_kind). Feed B is deliberately
    // not grain-partitioned (title-only signal would false-split sound sets).
    const grainOfRow = (r: typeof rows[number]) => outcomeGrainFromFacts({
      outcome_id: r.outcome_id,
      subject: r.subject,
      label: r.outcome_label ?? r.label,
      event_kinds: r.event_kinds ?? [r.event_kind],
      value_primary: r.value_primary,
      value_secondary: r.value_secondary,
    });
    const grainGroups = groupedAs === 'threshold_series'
      ? partitionThresholdGroups(kept, isResidual)
      : partitionByGrain(workingKept, grainOfRow, isResidual);
    let groups = grainGroups;
    if (groupedAs === 'categorical') {
      groups = grainGroups.flatMap((g) => {
        const parts = partitionByConditionDateGrain(
          g,
          (r) => (r.condition_dates ?? []).map((d) => ({ date: d.date, precision: d.precision ?? null })),
          (r) => r.event_kind,
          isResidual,
        );
        if (parts.length > 1) {
          beltHit('condition_date_grain_split');
          const dvals = parts.map((p) => {
            const d0 = p.find((r) => (r.condition_dates ?? []).some((d) => d.date))
              ?.condition_dates?.find((d) => d.date)?.date;
            return d0 ?? '∅';
          });
          log.warn(
            `condition-date grain split: set semantic:${seId} ("${rows[0].set_name}") → ` +
            `${parts.length} date groups [${dvals.join(' | ')}] — Σ=1 refused`,
          );
        }
        return parts;
      });
      groups = groups.flatMap((g) => {
        const parts = partitionByGameOrdinalGrain(
          g,
          (r) => (r.game_ordinals ?? []).map((o) => parseInt(o, 10)).filter((n) => Number.isFinite(n)),
          isResidual,
        );
        if (parts.length > 1) {
          beltHit('game_ordinal_grain_split');
          const ovals = parts.map((p) => {
            const o0 = p.find((r) => (r.game_ordinals ?? []).length === 1)?.game_ordinals?.[0];
            return o0 ?? '∅';
          });
          log.warn(
            `game-ordinal grain split: set semantic:${seId} ("${rows[0].set_name}") → ` +
            `${parts.length} ordinal groups [${ovals.join(' | ')}] — Σ=1 refused`,
          );
        }
        return parts;
      });
    }
    const grainSplit = groupedAs === 'categorical' && groups.length > 1;
    if (grainSplit) grainSplitSets++;
    for (const rawGroup of groups) {
      let group = rawGroup;
      if (groupedAs === 'threshold_series') {
        const collision = dropCollidedLadderRungs(rawGroup);
        if (collision.dropped.length > 0) {
          ladderCollisionSets++;
          ladderCollisionSlots += collision.dropped.length;
          log.warn(
            `ladder rung collision: set semantic:${seId} — ${collision.dropped.length} rung(s) share a ` +
            `stamped value_primary with another rung [${[...new Set(collision.dropped.map((r) => String(r.value_primary)))].join(', ')}]; ` +
            `dropped from the ladder (their chain link would assert an unproven nesting)`,
          );
          group = collision.kept;
        }
      }
      const groupReal = group.filter((r) => !isResidual(r)).length;
      if (groupReal < 2) { if (groups.length > 1 && group.length >= 2) demotedSets++; continue; }
      if (groupedAs !== 'threshold_series') {
        const groupRealGrains = distinctRealGrains(group, grainOfRow, isResidual);
        if (groupRealGrains.size > 0 && [...groupRealGrains].every(isThresholdLikeGrain)) {
          thresholdGrainFreedSets++;
          thresholdGrainFreedSlots += groupReal;
          log.info(
            `threshold-like grain group freed: set semantic:${seId} grain=[${[...groupRealGrains].join(', ')}] — ` +
            `${groupReal} rung(s) freed to independent questions (a ladder, not a mutex partition)`,
          );
          continue;
        }
      }
      const verdict = classifySet(group.map(toSlot), { groupedAs, kindHomogeneous: isKindHomogeneous(group), allBoundChildrenMapped, openRaceFold });
      if (verdict === null) { if (group.length >= 2) demotedSets++; continue; }
      let isExhaustive = verdict.isExhaustive && !driftDropped && !grainSplit;
      if (verdict.setType === 'categorical' && isExhaustive) {
        const findings = sigma1Contradictions(group.map(toBeltFacts), SIGMA1_CONTRADICTION_DIMENSIONS);
        if (findings.length > 0) {
          isExhaustive = false;
          beltDemotedSets++;
          for (const f of findings) {
            log.warn(
              `Σ=1 contradiction demote: set semantic:${seId} ("${rows[0].set_name}") ` +
              `dimension=${f.dimension} values=[${f.values.join(' | ')}] — demoted Σ=1 → Σ≤1`,
            );
          }
        }
      }
      const ordered = verdict.setType === 'threshold_series' ? sortLadderByValue(group) : group;
      if (verdict.setType === 'categorical' && !isExhaustive) nonExhaustive++;
      const subKey = gi === 0 ? '' : '#m' + gi;
      gi++;
      survivors.push({
        seId,
        subKey,
        setType: verdict.setType,
        setName: rows[0].set_name,
        confidence: rows[0].confidence,
        orderedOutcomeIds: ordered.map((r) => r.outcome_id),
        isExhaustive,
      });
    }
  }

  await query(`
    DELETE FROM outcome_set_slots
    WHERE set_id IN (SELECT id FROM outcome_sets WHERE source = 'semantic_event')
  `);
  await query(
    `DELETE FROM outcome_sets
     WHERE source = 'semantic_event'
       AND event_identity <> ALL($1::text[])`,
    [survivors.map((s) => 'semantic:' + s.seId + s.subKey)],
  );

  if (survivors.length === 0) {
    if (droppedSlots > 0 || demotedSets > 0) {
      log.info('feed-A outcome_sets: dropped ' + droppedSlots + ' placeholder slot(s), demoted ' + demotedSets + ' set(s); 0 sets remain');
    }
    return;
  }

  await query(
    `INSERT INTO outcome_sets (event_identity, set_type, set_name, slot_count, confidence, source, is_exhaustive)
     SELECT t.event_identity, t.set_type, t.set_name, t.slot_count, t.confidence, 'semantic_event', t.is_exhaustive
     FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::float8[], $6::boolean[]) AS t(event_identity, set_type, set_name, slot_count, confidence, is_exhaustive)
     ON CONFLICT (event_identity) DO UPDATE SET
       set_type      = EXCLUDED.set_type,
       set_name      = EXCLUDED.set_name,
       slot_count    = EXCLUDED.slot_count,
       confidence    = EXCLUDED.confidence,
       is_exhaustive = EXCLUDED.is_exhaustive,
       updated_at = NOW()`,
    [
      survivors.map((s) => 'semantic:' + s.seId + s.subKey),
      survivors.map((s) => s.setType),
      survivors.map((s) => s.setName),
      survivors.map((s) => s.orderedOutcomeIds.length),
      survivors.map((s) => s.confidence),
      survivors.map((s) => s.isExhaustive),
    ],
  );

  const slotEventIdentity: string[] = [];
  const slotSe: number[] = [];
  const slotOrdinal: number[] = [];
  const slotOutcome: string[] = [];
  for (const s of survivors) {
    s.orderedOutcomeIds.forEach((oid, i) => {
      slotEventIdentity.push('semantic:' + s.seId + s.subKey);
      slotSe.push(s.seId);
      slotOrdinal.push(i + 1);
      slotOutcome.push(oid);
    });
  }
  await query(
    `INSERT INTO outcome_set_slots (set_id, slot_ordinal, question_id)
     SELECT os.id, t.ord, q.id
     FROM unnest($1::text[], $2::int[], $3::int[], $4::text[]) AS t(event_identity, se_id, ord, outcome_id)
     JOIN outcome_sets os ON os.event_identity = t.event_identity
     JOIN questions q ON q.canonical_key = 'sem:' || t.se_id || ':' || t.outcome_id
     ON CONFLICT (set_id, slot_ordinal) DO NOTHING`,
    [slotEventIdentity, slotSe, slotOrdinal, slotOutcome],
  );
  if (droppedSlots > 0 || demotedSets > 0 || nonExhaustive > 0 || heteroSplitSets > 0 || driftDupSets > 0 || beltDemotedSets > 0 || grainSplitSets > 0 || thresholdGrainFreedSets > 0 || ladderCollisionSets > 0) {
    log.info(`feed-A outcome_sets: dropped ${droppedSlots} placeholder slot(s), demoted ${demotedSets} set(s), split ${heteroSplitSets} hetero-kind fold(s) (freed ${heteroFreedSlots} slot(s)), split ${grainSplitSets} multi-grain categorical fold(s), freed ${thresholdGrainFreedSets} threshold-like grain group(s) (${thresholdGrainFreedSlots} rung(s) → free questions), ${ladderCollisionSets} ladder(s) with colliding rungs (${ladderCollisionSlots} rung(s) dropped), ${driftDupSets} label-drift set(s) (excluded ${driftDupSlots} dup slot(s)), ${beltDemotedSets} Σ=1-contradiction belt demotion(s), ${nonExhaustive} non-exhaustive (Σ≤1) categorical, ${survivors.length} set(s) remain`);
  }
}

async function buildPlatformOutcomeSets(): Promise<void> {
  // One set per un-matched platform_event with categorical/threshold grouping
  // and ≥2 child nodes; placeholder slots excluded so they never become one-hot
  // Ω slots. Slot order (value_primary NULLS LAST, market_id) keeps
  // threshold_series ordinals value-ordered for the ladder edges.
  const childRows = await query<{
    pe_id: number;
    market_id: number;
    platform: string;
    set_type: 'categorical' | 'threshold_series';
    set_name: string;
    label: string | null;
    canonical_subject: string | null;
    is_neg_risk: boolean;
    has_value: boolean;
    value_primary: number | null;
    value_secondary: number | null;
    condition_direction: string | null;
    value_unit: string | null;
    condition_metric: string | null;
    condition_shape: string | null;
    metric_scope: string | null;
    event_kind: string | null;
    outcome_label: string | null;
    is_multiyes: boolean;
    is_multiwinner: boolean;
    is_open_race: boolean;
    condition_date: string | null;
    condition_date_precision: string | null;
    resolution_source: string | null;
    event_ticker: string | null;
    is_kalshi_custom_score: boolean | null;
    settlement_dimension: string | null;
    folded_participants: string | null;
    cover_subject: string | null;
    native_independent: boolean | null;
  }>(`
    SELECT pe.id AS pe_id,
           m.id  AS market_id,
           m.platform AS platform,
           CASE pe.grouping_type WHEN 'categorical_exclusive' THEN 'categorical' ELSE 'threshold_series' END AS set_type,
           COALESCE(pe.canonical_event, pe.title) AS set_name,
           COALESCE(mmr.raw->>'groupItemTitle', mmr.raw->>'yes_sub_title', mmr.raw#>>'{custom_strike,Team}', m.title) AS label,
           n.canonical_subject AS canonical_subject,
           ${NATIVE_MUTEX_SQL('mmr')} AS is_neg_risk,
           (n.value_primary IS NOT NULL) AS has_value,
           n.value_primary AS value_primary,
           n.value_secondary AS value_secondary,
           n.condition_direction AS condition_direction,
           n.value_unit AS value_unit,
           n.condition_metric AS condition_metric,
           n.condition_shape AS condition_shape,
           n.metric_scope AS metric_scope,
           n.event_kind AS event_kind,
           n.outcome_label AS outcome_label,
           -- looksMultiYesPredicate mirror.
           (n.event_kind = 'stage_advance'
            OR (m.title ~* '\\y(finish(es|ing)? (in the )?top|top[- ]?[0-9]|relegat|make[s]? (the )?(playoff|postseason|knockout))'
                AND (n.event_kind IS NULL OR n.event_kind NOT IN ('match_winner','halftime_leader','exact_score','candle_direction')))) AS is_multiyes,
           -- looksMultiWinnerSelection mirror, stricter than is_multiyes.
           (m.title ~* '\\y((advance\\w*|qualif\\w*) (to|for|into) (the )?(grand )?(final\\w*|semi\\w*|knockout\\w*|playoff\\w*|next round|round of)|relegat\\w*|make[s]? (the )?(playoff|postseason|knockout)|finish(es|ing)? (in )?(the )?top[- ]?[0-9]|top[- ]?[0-9]+ finish\\w*)'
            AND (n.event_kind IS NULL OR n.event_kind NOT IN ('match_winner','halftime_leader','exact_score','candle_direction'))) AS is_multiwinner,
           ${openRaceLegSql('m.title')} AS is_open_race,
           n.condition_date::text AS condition_date,
           n.condition_date_precision AS condition_date_precision,
           n.resolution_source AS resolution_source,
           mmr.raw->>'event_ticker' AS event_ticker,
           -- One market per feed-B slot, so no bool_or.
           (mmr.raw->>'strike_type' = 'custom' AND mmr.raw->>'event_ticker' LIKE 'KX%SCORE-%') AS is_kalshi_custom_score,
           ${settlementDimensionSql('mmr.raw')} AS settlement_dimension,
           ${foldedParticipantsKeySql('n.participants')} AS folded_participants,
           n.discriminators->>'cover_subject' AS cover_subject,
           (pe.grouping_type = 'bundle_nonexclusive'
            OR ke.raw->>'mutually_exclusive' = 'false') AS native_independent
           ${setSplitSlotProjectionsFeedB('n')}
    FROM platform_events pe
    JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
      AND m.resolved_at IS NULL
    LEFT JOIN market_metadata_raw mmr ON mmr.market_id = m.id
    LEFT JOIN kalshi_events ke ON pe.platform = 'kalshi' AND ke.event_ticker = mmr.raw->>'event_ticker'
    LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
    WHERE ${UNMATCHED_PE}
      AND pe.grouping_type IN ('categorical_exclusive', 'threshold_series')
    ORDER BY pe.id, n.value_primary NULLS LAST, m.id
  `);

  const byPe = new Map<number, typeof childRows>();
  for (const r of childRows) {
    const g = byPe.get(r.pe_id);
    if (g) g.push(r);
    else byPe.set(r.pe_id, [r]);
  }

  const survivors: { peId: number; subKey: string; setType: string; setName: string; orderedMarketIds: number[]; isExhaustive: boolean }[] = [];
  let droppedSlots = 0;
  let demotedSets = 0;
  let nonExhaustive = 0;
  let heteroSplitSets = 0;
  let heteroFreedSlots = 0;
  let driftDupSets = 0;
  let driftDupSlots = 0;
  let beltDemotedSets = 0;
  let ladderCollisionSets = 0;
  let ladderCollisionSlots = 0;
  for (const [peId, rows] of byPe) {
    const { drop, residual } = placeholderSlotsInSet(
      rows.map((r) => ({ id: r.market_id, label: r.label })),
    );
    const kept = rows.filter((r) => !drop.has(r.market_id));
    droppedSlots += rows.length - kept.length;
    const realCount = kept.filter((r) => !residual.has(r.market_id)).length;
    if (realCount < 2) {
      if (rows.length >= 2) demotedSets++;
      continue;
    }
    const groupedAs: SetGrouping = rows[0].set_type === 'categorical' ? 'categorical' : 'threshold_series';
    const openRaceFold = kept.some((r) => r.is_open_race) || looksOpenRace(rows[0].set_name);
    const toSlot = (r: typeof rows[number]): CertifierSlot => ({
      outcome_id: String(r.market_id),
      display_label: r.label,
      canonical_subject: r.canonical_subject,
      is_residual: residual.has(r.market_id),
      market_ids: [r.market_id],
      platforms: [r.platform],
      direction: r.condition_direction,
      value_primary: r.value_primary,
      value_secondary: r.value_secondary,
      value_unit: r.value_unit,
      condition_metric: r.condition_metric,
      condition_shape: r.condition_shape,
      axis_interval: computeAxisInterval({
        is_residual: residual.has(r.market_id),
        event_kind: r.event_kind,
        value_unit: r.value_unit,
        direction: r.condition_direction,
        value_primary: r.value_primary,
        value_secondary: r.value_secondary,
        axis_key: r.label,
        label_fallback: r.label,
      }),
      condition_date: r.condition_date,
      event_kind: r.event_kind,
      is_multiyes: r.is_multiyes,
      has_negrisk: r.is_neg_risk,
      native_independent: r.native_independent ?? false,
      folded_participants: r.folded_participants,
      mutex_cardinality: awardMaxWinners(r.event_ticker) ?? (r.is_multiwinner ? 2 : null),
      is_kalshi_custom_score: r.is_kalshi_custom_score ?? false,
      settlement_dimensions: r.settlement_dimension ? [r.settlement_dimension] : null,
      disc: {
        metric_scope: r.metric_scope,
        mention_phrase: r.event_kind === 'speech_mention' ? (r.outcome_label ?? null) : null,
        ...slotSetSplitDisc(r as unknown as Record<string, unknown>, groupedAs),
      },
    });
    // canonical_events stays empty: native single-event grouping already proves
    // one real-world event.
    const toBeltFacts = (r: typeof rows[number]): BeltSlotFacts => ({
      outcome_id: String(r.market_id),
      canonical_events: [],
      condition_dates: r.condition_date != null
        ? [{ date: r.condition_date, precision: r.condition_date_precision ?? null }]
        : [],
      event_kinds: r.event_kind != null ? [r.event_kind] : [],
      resolution_sources: r.resolution_source != null ? [r.resolution_source] : [],
    });
    let gi = 0;
    // Mirror of the feed-A hetero-kind partition.
    if (groupedAs === 'categorical') {
      const hetero = partitionHeteroCategoricalByKind(kept.map(toSlot));
      if (hetero) {
        heteroSplitSets++;
        heteroFreedSlots += hetero.freedSlots.length;
        const rowByMarket = new Map(kept.map((r) => [String(r.market_id), r]));
        for (const g of hetero.mutexGroups) {
          const groupRows = g.map((s) => rowByMarket.get(s.outcome_id)!);
          const subKey = gi === 0 ? '' : '#m' + gi;
          gi++;
          nonExhaustive++;
          survivors.push({
            peId,
            subKey,
            setType: 'categorical',
            setName: rows[0].set_name,
            orderedMarketIds: groupRows.map((r) => r.market_id),
            isExhaustive: false,
          });
        }
        continue;
      }
    }
    // Mirror of feed A's label-drift guard.
    let driftDropped = false;
    let workingKept = kept;
    if (groupedAs === 'categorical') {
      const dupIds = labelDriftDuplicateOutcomeIds(kept.map(toSlot));
      if (dupIds.size > 0) {
        driftDropped = true;
        driftDupSets++;
        driftDupSlots += dupIds.size;
        workingKept = kept.filter((r) => !dupIds.has(String(r.market_id)));
        log.info(
          `label-drift dup: set pe:${peId} holds the same outcome ≥2× via label drift — ` +
          `excluding market slot(s) [${[...dupIds].join(', ')}]; Σ=1 refused`,
        );
        if (workingKept.filter((r) => !residual.has(r.market_id)).length < 2) { demotedSets++; continue; }
      }
    }
    // Feed B is deliberately not grain-partitioned, unlike feed A: a native
    // platform grouping is the platform's own mutex declaration.
    const groups = groupedAs === 'threshold_series'
      ? partitionThresholdGroups(kept, (r) => residual.has(r.market_id))
      : [workingKept];
    for (const rawGroup of groups) {
      let group = rawGroup;
      if (groupedAs === 'threshold_series') {
        const collision = dropCollidedLadderRungs(rawGroup);
        if (collision.dropped.length > 0) {
          ladderCollisionSets++;
          ladderCollisionSlots += collision.dropped.length;
          log.warn(
            `ladder rung collision: set pe:${peId} — ${collision.dropped.length} rung(s) share a ` +
            `stamped value_primary with another rung [${[...new Set(collision.dropped.map((r) => String(r.value_primary)))].join(', ')}]; ` +
            `dropped from the ladder (their chain link would assert an unproven nesting)`,
          );
          group = collision.kept;
        }
      }
      const groupReal = group.filter((r) => !residual.has(r.market_id)).length;
      if (groupReal < 2) { if (groups.length > 1 && group.length >= 2) demotedSets++; continue; }
      const verdict = classifySet(group.map(toSlot), { groupedAs, kindHomogeneous: isKindHomogeneous(group), allBoundChildrenMapped: true, openRaceFold });
      if (verdict === null) { if (group.length >= 2) demotedSets++; continue; }
      let isExhaustive = verdict.isExhaustive && !driftDropped;
      if (verdict.setType === 'categorical' && isExhaustive) {
        const findings = sigma1Contradictions(group.map(toBeltFacts), SIGMA1_NATIVE_SET_DIMENSIONS);
        if (findings.length > 0) {
          isExhaustive = false;
          beltDemotedSets++;
          for (const f of findings) {
            log.warn(
              `Σ=1 contradiction demote: set pe:${peId} ("${rows[0].set_name}") ` +
              `dimension=${f.dimension} values=[${f.values.join(' | ')}] — demoted Σ=1 → Σ≤1`,
            );
          }
        }
      }
      const ordered = verdict.setType === 'threshold_series' ? sortLadderByValue(group) : group;
      if (verdict.setType === 'categorical' && !isExhaustive) nonExhaustive++;
      const subKey = gi === 0 ? '' : '#m' + gi;
      gi++;
      survivors.push({
        peId,
        subKey,
        setType: verdict.setType,
        setName: rows[0].set_name,
        orderedMarketIds: ordered.map((r) => r.market_id),
        isExhaustive,
      });
    }
  }

  await query(`
    DELETE FROM outcome_set_slots
    WHERE set_id IN (
      SELECT id FROM outcome_sets WHERE source = 'platform_native' AND event_identity LIKE 'pe:%'
    )
  `);
  await query(
    `DELETE FROM outcome_sets
     WHERE source = 'platform_native' AND event_identity LIKE 'pe:%'
       AND event_identity <> ALL($1::text[])`,
    [survivors.map((s) => 'pe:' + s.peId + s.subKey)],
  );

  if (survivors.length === 0) {
    if (droppedSlots > 0 || demotedSets > 0) {
      log.info('feed-B outcome_sets: dropped ' + droppedSlots + ' placeholder slot(s), demoted ' + demotedSets + ' set(s); 0 sets remain');
    }
    return;
  }

  await query(
    `INSERT INTO outcome_sets (event_identity, set_type, set_name, slot_count, confidence, source, is_exhaustive)
     SELECT t.event_identity, t.set_type, t.set_name, t.slot_count,
            CASE t.set_type WHEN 'categorical' THEN 0.95 ELSE 0.85 END, 'platform_native', t.is_exhaustive
     FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::boolean[]) AS t(event_identity, set_type, set_name, slot_count, is_exhaustive)
     ON CONFLICT (event_identity) DO UPDATE SET
       set_type      = EXCLUDED.set_type,
       set_name      = EXCLUDED.set_name,
       slot_count    = EXCLUDED.slot_count,
       is_exhaustive = EXCLUDED.is_exhaustive,
       updated_at = NOW()`,
    [
      survivors.map((s) => 'pe:' + s.peId + s.subKey),
      survivors.map((s) => s.setType),
      survivors.map((s) => s.setName),
      survivors.map((s) => s.orderedMarketIds.length),
      survivors.map((s) => s.isExhaustive),
    ],
  );

  // canonical_key is pe:<peId>:<mid> (base, no sub-set suffix) — join on base-pe.
  const slotEvent: string[] = [];
  const slotBasePe: number[] = [];
  const slotOrdinal: number[] = [];
  const slotMarketId: number[] = [];
  for (const s of survivors) {
    s.orderedMarketIds.forEach((mid, i) => {
      slotEvent.push('pe:' + s.peId + s.subKey);
      slotBasePe.push(s.peId);
      slotOrdinal.push(i + 1);
      slotMarketId.push(mid);
    });
  }
  await query(
    `INSERT INTO outcome_set_slots (set_id, slot_ordinal, question_id)
     SELECT os.id, t.ord, q.id
     FROM unnest($1::text[], $2::int[], $3::int[], $4::int[]) AS t(event_identity, base_pe, ord, market_id)
     JOIN outcome_sets os ON os.event_identity = t.event_identity
     JOIN questions q ON q.canonical_key = 'pe:' || t.base_pe || ':' || t.market_id
     ON CONFLICT (set_id, slot_ordinal) DO NOTHING`,
    [slotEvent, slotBasePe, slotOrdinal, slotMarketId],
  );

  if (droppedSlots > 0 || demotedSets > 0 || nonExhaustive > 0 || heteroSplitSets > 0 || driftDupSets > 0 || beltDemotedSets > 0 || ladderCollisionSets > 0) {
    log.info('feed-B outcome_sets: dropped ' + droppedSlots + ' placeholder slot(s), demoted ' + demotedSets + ' set(s), split ' + heteroSplitSets + ' hetero-kind fold(s) (freed ' + heteroFreedSlots + ' slot(s)), ' + ladderCollisionSets + ' ladder(s) with colliding rungs (' + ladderCollisionSlots + ' rung(s) dropped), ' + driftDupSets + ' label-drift set(s) (excluded ' + driftDupSlots + ' dup slot(s)), ' + beltDemotedSets + ' Sigma=1-contradiction belt demotion(s), ' + nonExhaustive + ' non-exhaustive (Sigma<=1) categorical, ' + survivors.length + ' set(s) remain');
  }
}
// ── Feed-B tournament mutex: per-team WC elimination outcome_sets ─────────────

/**
 * Materializes the per-team FIFA World Cup "stage of elimination" mutex sets: a
 * team is knocked out at exactly one stage, or wins, so the 7 stage markets are
 * mutually exclusive (Σ≤1) but not exhaustive (a not-played team resolves all
 * to NO). Distinct namespace (`wc-elim:<peId>`, source `wc_elimination`) so it
 * never collides with the feed-B `pe:%` cleanup.
 */
async function buildWcEliminationMutexSets(): Promise<void> {
  const sets = await loadWcEliminationMutexSets();

  await query(`
    DELETE FROM outcome_set_slots
    WHERE set_id IN (SELECT id FROM outcome_sets WHERE source = 'wc_elimination')
  `);
  await query(
    `DELETE FROM outcome_sets
     WHERE source = 'wc_elimination'
       AND event_identity <> ALL($1::text[])`,
    [sets.map((s) => `wc-elim:${s.peId}`)],
  );

  const survivors = sets.filter((s) => s.questionIds.length >= 2);
  if (survivors.length === 0) return;

  await query(
    `INSERT INTO outcome_sets (event_identity, set_type, set_name, slot_count, confidence, source, is_exhaustive)
     SELECT 'wc-elim:' || t.pe_id, 'categorical', t.set_name, t.slot_count, 0.95, 'wc_elimination', FALSE
     FROM unnest($1::int[], $2::text[], $3::int[]) AS t(pe_id, set_name, slot_count)
     ON CONFLICT (event_identity) DO UPDATE SET
       set_type      = EXCLUDED.set_type,
       set_name      = EXCLUDED.set_name,
       slot_count    = EXCLUDED.slot_count,
       is_exhaustive = EXCLUDED.is_exhaustive,
       updated_at    = NOW()`,
    [
      survivors.map((s) => s.peId),
      survivors.map((s) => s.setName),
      survivors.map((s) => s.questionIds.length),
    ],
  );

  const slotEvent: string[] = [];
  const slotOrdinal: number[] = [];
  const slotQuestionId: number[] = [];
  for (const s of survivors) {
    s.questionIds.forEach((qid, i) => {
      slotEvent.push(`wc-elim:${s.peId}`);
      slotOrdinal.push(i + 1);
      slotQuestionId.push(qid);
    });
  }
  await query(
    `INSERT INTO outcome_set_slots (set_id, slot_ordinal, question_id)
     SELECT os.id, t.ord, t.qid
     FROM unnest($1::text[], $2::int[], $3::int[]) AS t(event_identity, ord, qid)
     JOIN outcome_sets os ON os.event_identity = t.event_identity
     ON CONFLICT (set_id, slot_ordinal) DO NOTHING`,
    [slotEvent, slotOrdinal, slotQuestionId],
  );

  log.info(`feed-B WC elimination mutex: ${survivors.length} Σ≤1 set(s) (is_exhaustive=FALSE)`);
}

// Demotes Σ=1 → Σ≤1 (never deletes) when the live slot count differs from the
// certified slot_count or a slot's question is archived/memberless.
// threshold_series is exempt (its own-partition encoding). Idempotent.
async function reconcileOutcomeSetExhaustivity(): Promise<number> {
  const rows = await query<{ id: number; event_identity: string }>(
    reconcileOutcomeSetExhaustivitySql(),
  );
  if (rows.length > 0) {
    const sample = rows.slice(0, 10).map((r) => r.event_identity).join(', ');
    log.info(
      `outcome-set reconcile: demoted ${rows.length} Σ=1 categorical set(s) with missing/archived/memberless slots → Σ≤1 (${sample}${rows.length > 10 ? ', …' : ''})`,
    );
  }
  return rows.length;
}

// Exported for the no-DB SQL-invariant regression tests. Both demote arms must
// stay present: (a) live slot count <> certified, (b) any slot question
// archived/memberless.
export function reconcileOutcomeSetExhaustivitySql(): string {
  return `
    WITH ${NEGRISK_GROUP_CTES_SQL}
    UPDATE outcome_sets os
    SET is_exhaustive = FALSE, updated_at = NOW()
    WHERE os.set_type = 'categorical'
      AND os.is_exhaustive
      AND (
        os.slot_count <> (SELECT COUNT(*)::int FROM outcome_set_slots s WHERE s.set_id = os.id)
        OR EXISTS (
          SELECT 1
          FROM outcome_set_slots s
          JOIN questions q ON q.id = s.question_id
          WHERE s.set_id = os.id
            AND (q.archived_at IS NOT NULL OR q.member_count = 0)
        )
        -- NegRisk completeness: a native negRisk group is an on-chain
        -- one-of-n field, so Σ=1 over a strict subset is false.
        OR EXISTS (
          SELECT 1 FROM set_negrisk_group sg
          JOIN negrisk_group_live g ON g.gk = sg.gk
          WHERE sg.set_id = os.id AND g.n > os.slot_count
        )
      )
    RETURNING os.id, os.event_identity
  `;
}

// Native negRisk group identity of one market's raw payload, or NULL when
// untraceable. Only the TRUNCATION direction (group > slot_count) demotes —
// more slots than group markets is the normal shape of a cross-platform merge.
function NEGRISK_GROUP_KEY_SQL(alias: string): string {
  return `(CASE
        WHEN ${alias}.raw->>'negRisk' = 'true' AND NULLIF(${alias}.raw->>'negRiskMarketID', '') IS NOT NULL
          THEN 'polymarket:negRisk:' || (${alias}.raw->>'negRiskMarketID')
        WHEN NULLIF(${alias}.raw->>'negRiskMarketId', '') IS NOT NULL
          THEN 'limitless:negRisk:' || (${alias}.raw->>'negRiskMarketId')
      END)`;
}

export const NEGRISK_GROUP_CTES_SQL = `
    negrisk_group_live AS (
      SELECT ${NEGRISK_GROUP_KEY_SQL('mr')} AS gk, count(*)::int AS n
      FROM markets m
      JOIN market_metadata_raw mr ON mr.market_id = m.id
      WHERE m.resolved_at IS NULL
        AND ${NEGRISK_GROUP_KEY_SQL('mr')} IS NOT NULL
        AND NOT ${isOmegaPlaceholderSlotSql(
          `COALESCE(mr.raw->>'groupItemTitle', mr.raw->>'yes_sub_title', mr.raw#>>'{custom_strike,Team}', m.title)`,
        )}
      GROUP BY 1
    ),
    set_negrisk_group AS (
      SELECT s.set_id,
             CASE WHEN count(DISTINCT ${NEGRISK_GROUP_KEY_SQL('mr')}) = 1
                  THEN min(${NEGRISK_GROUP_KEY_SQL('mr')}) END AS gk
      FROM outcome_sets os2
      JOIN outcome_set_slots s ON s.set_id = os2.id
      JOIN question_members qm ON qm.question_id = s.question_id
      JOIN market_metadata_raw mr ON mr.market_id = qm.market_id
      WHERE os2.set_type = 'categorical' AND os2.is_exhaustive
      GROUP BY s.set_id
    )`;

// ── Threshold-ladder edges (stricter ⟹ easier) ──────────────────────────────

async function buildThresholdLadderEdges(): Promise<number> {
  // Derives the implication arithmetically from (condition_direction,
  // value_primary), not slot_ordinal (direction-blind, orders differently per
  // feed). Emits only adjacent rungs (transitive reduction); the LP realises
  // the full closure by transitivity. Uses an indexed temp table (thr_rungs)
  // so the "gate-compatible rung strictly between" check is a bounded range
  // scan; withTx keeps the reap + build atomic.
  return withTx(async (client) => {
    await client.query(buildThresholdLadderRungsSql());
    await client.query(`CREATE INDEX ON thr_rungs (set_id, value_primary)`);
    await client.query(`ANALYZE thr_rungs`);
    const res = await client.query(buildThresholdLadderEdgesSql());
    const row = (res.rows as Array<{ reaped: number; n: number }>)[0];
    const reaped = row?.reaped ?? 0;
    if (reaped > 0) {
      log.info(`threshold-ladder: reaped ${reaped} stale edge(s) whose pair no longer shares a threshold_series set`);
    }
    return row?.n ?? 0;
  });
}

// Precomputes threshold_series slot rungs into a session temp table so the
// ladder self-join compares a materialized `pfold` scalar instead of
// re-running the participant fold per pair. Exported for SQL-invariant tests.
export function buildThresholdLadderRungsSql(): string {
  return `
    CREATE TEMP TABLE thr_rungs ON COMMIT DROP AS
    SELECT os.id AS set_id, q.id AS qid,
           q.condition_direction, q.value_primary, q.value_unit,
           q.condition_date, q.condition_date_precision, q.metric_scope,
           q.condition_shape, q.event_kind, q.canonical_subject,
           q.discriminators->>'cover_subject' AS cover_subject,
           ${foldedParticipantsKeySql('q.participants')} AS pfold
    FROM outcome_sets os
    JOIN outcome_set_slots s ON s.set_id = os.id
    JOIN questions q ON q.id = s.question_id
    WHERE os.set_type = 'threshold_series'
  `;
}

// Directed ladder gate between rungs x (stricter) and y (easier). Shared by
// the cand self-join and the transitive-reduction intermediate check.
function thresholdLadderGateSql(x: string, y: string): string {
  return `
        ${x}.condition_direction = ${y}.condition_direction
    AND ${x}.condition_direction IN ('above', 'below')
    AND ${x}.value_primary IS NOT NULL
    AND ${y}.value_primary IS NOT NULL
    AND ${x}.value_unit IS NOT DISTINCT FROM ${y}.value_unit
    AND (
      (${x}.condition_date IS NULL AND ${y}.condition_date IS NULL)
      OR (${x}.condition_date IS NOT NULL AND ${y}.condition_date IS NOT NULL
          AND ${sameAtCoarserGrainSql(`${x}.condition_date`, `${x}.condition_date_precision`, `${y}.condition_date`, `${y}.condition_date_precision`)})
    )
    AND ${bothKnownDifferSql(`${x}.metric_scope`, `${y}.metric_scope`)}
    AND ${bothKnownDifferSql(`${x}.condition_shape`, `${y}.condition_shape`)}
    AND NOT (
      ${x}.event_kind IN ('match_total_metric', 'match_spread', 'player_prop_threshold')
      AND ${y}.event_kind IN ('match_total_metric', 'match_spread', 'player_prop_threshold')
      AND ${x}.event_kind IS DISTINCT FROM ${y}.event_kind
    )
    AND ${x}.value_primary <> ${y}.value_primary
    AND ${bothKnownDifferSql(`${x}.pfold`, `${y}.pfold`)}
    AND NOT (
      ${x}.event_kind = 'match_spread' AND ${y}.event_kind = 'match_spread'
      AND ${x}.pfold IS DISTINCT FROM ${y}.pfold
    )
    -- Same-team margin-ladder gate: a spread outcome_set co-groups both teams'
    -- ladders, so pfold alone misses it (match_spread carries {A,B} on both
    -- sides); ladder only when the "<Team> wins ... by" prefixes match.
    AND NOT (
      ${x}.canonical_subject ~* ' wins( .+)? by' AND ${y}.canonical_subject ~* ' wins( .+)? by'
      AND regexp_replace(lower(immutable_unaccent(${x}.canonical_subject)), ' wins .*$', '')
       IS DISTINCT FROM
          regexp_replace(lower(immutable_unaccent(${y}.canonical_subject)), ' wins .*$', '')
    )
    -- Catches spread fakes with a threshold-free subject the idiom regex misses.
    AND ${bothKnownDifferSql(`${x}.cover_subject`, `${y}.cover_subject`)}
    AND (
      (${x}.condition_direction = 'above' AND ${x}.value_primary > ${y}.value_primary)
      OR (${x}.condition_direction = 'below' AND ${x}.value_primary < ${y}.value_primary)
    )`;
}

// Exported (token-identical extraction) so the conflict-tail dry-run harness +
// tests can exercise the exact SQL without importing the imperative wrapper.
export function buildThresholdLadderEdgesSql(): string {
  return `
    WITH reap AS (
      -- An in-set ladder edge is only valid while its pair co-habits one
      -- threshold_series set.
      DELETE FROM implication_edges e
      WHERE e.edge_type = 'strict_implication'
        AND e.pattern = 'numeric_threshold'
        AND NOT EXISTS (
          SELECT 1
          FROM outcome_set_slots sa
          JOIN outcome_set_slots sb ON sb.set_id = sa.set_id
          JOIN outcome_sets os2 ON os2.id = sa.set_id
          WHERE os2.set_type = 'threshold_series'
            AND sa.question_id = e.antecedent_question_id
            AND sb.question_id = e.consequent_question_id
        )
      RETURNING 1
    ), ins AS (
      -- Transitive reduction: emit (a ⟹ b, a stricter) only when no
      -- gate-compatible rung c sits strictly between a and b in value — the LP
      -- re-derives the skipped pairs through a ⟹ c ⟹ b. c must be fully
      -- gate-compatible with BOTH ends (thresholdLadderGateSql), not merely
      -- value-adjacent, or the reduction would not be behaviour-identical.
      INSERT INTO implication_edges
        ${EDGE_INSERT_COLUMNS_SQL}
      SELECT a.qid, b.qid, ${edgeContractSql('strict_implication', 'numeric_threshold')},
             'threshold ladder (transitive reduction): stricter ⟹ easier adjacent rung, arithmetic on (direction,value); same unit+date (Stage 4)'
      FROM thr_rungs a
      JOIN thr_rungs b ON b.set_id = a.set_id AND b.qid <> a.qid
      WHERE ${thresholdLadderGateSql('a', 'b')}
        AND NOT EXISTS (
          SELECT 1
          FROM thr_rungs c
          WHERE c.set_id = a.set_id
            AND c.qid <> a.qid AND c.qid <> b.qid
            AND c.value_primary > LEAST(a.value_primary, b.value_primary)
            AND c.value_primary < GREATEST(a.value_primary, b.value_primary)
            AND ${thresholdLadderGateSql('a', 'c')}
            AND ${thresholdLadderGateSql('c', 'b')}
        )
      ${EDGE_CONFLICT_SQL}
      RETURNING 1
    )
    SELECT (SELECT COUNT(*) FROM reap)::int AS reaped, COUNT(*)::int AS n FROM ins
  `;
}

// Pure-TS reference mirror of buildThresholdLadderEdgesSql. Keep in sync.
export interface ThresholdLadderSlot {
  questionId: number;
  direction: 'above' | 'below' | string | null;
  value: number | null;
  unit?: string | null;
  participants?: string[] | null;
  eventKind?: string | null;
  conditionShape?: string | null;
  metricScope?: string | null;
  conditionDate?: string | null;
  canonicalSubject?: string | null;
  coverSubject?: string | null;
}

function winsBySubjectTeam(subject: string | null | undefined): string | null {
  if (subject == null) return null;
  if (!/ wins( .+)? by/i.test(subject)) return null;
  return (foldTextKey(subject.replace(/ wins .*$/i, '')) ?? '').trim();
}

function foldParticipantsKey(parts: string[] | null | undefined): string | null {
  if (parts == null || parts.length === 0) return null;
  return parts
    .map((p) => (foldTextKey(p) ?? ''))
    .sort()
    .join('');
}

function participantsBothKnownDiffer(a: string | null, b: string | null): boolean {
  return a != null && b != null && a !== b;
}

export function thresholdLadderEdgesRef(slots: ThresholdLadderSlot[]): Array<[number, number]> {
  const bothKnownDiffer = (a: unknown, b: unknown) => a != null && b != null && a !== b;
  const dateAgrees = (a: string | null | undefined, b: string | null | undefined) =>
    (a == null && b == null) || (a != null && b != null && a === b);
  // Mirrors the SQL `cand` CTE's WHERE 1:1.
  const passesGate = (qa: ThresholdLadderSlot, qb: ThresholdLadderSlot): boolean => {
    if (qa.questionId === qb.questionId) return false;
    if (qa.direction !== qb.direction) return false;
    if (qa.direction !== 'above' && qa.direction !== 'below') return false;
    if (qa.value == null || qb.value == null) return false;
    if ((qa.unit ?? null) !== (qb.unit ?? null)) return false; // IS NOT DISTINCT FROM
    if (!dateAgrees(qa.conditionDate, qb.conditionDate)) return false;
    if (bothKnownDiffer(qa.metricScope ?? null, qb.metricScope ?? null)) return false;
    if (bothKnownDiffer(qa.conditionShape ?? null, qb.conditionShape ?? null)) return false;
    if (
      FIXTURE_METRIC_KINDS.has(qa.eventKind ?? '') &&
      FIXTURE_METRIC_KINDS.has(qb.eventKind ?? '') &&
      (qa.eventKind ?? null) !== (qb.eventKind ?? null)
    )
      return false;
    if (qa.value === qb.value) return false;
    if (participantsBothKnownDiffer(foldParticipantsKey(qa.participants), foldParticipantsKey(qb.participants)))
      return false;
    if (
      qa.eventKind === 'match_spread' &&
      qb.eventKind === 'match_spread' &&
      foldParticipantsKey(qa.participants) !== foldParticipantsKey(qb.participants)
    )
      return false;
    {
      const ta = winsBySubjectTeam(qa.canonicalSubject);
      const tb = winsBySubjectTeam(qb.canonicalSubject);
      if (ta != null && tb != null && ta !== tb) return false;
    }
    if (bothKnownDiffer(qa.coverSubject ?? null, qb.coverSubject ?? null)) return false;
    return (
      (qa.direction === 'above' && qa.value > qb.value) ||
      (qa.direction === 'below' && qa.value < qb.value)
    );
  };

  const cand: Array<[ThresholdLadderSlot, ThresholdLadderSlot]> = [];
  for (const qa of slots) for (const qb of slots) if (passesGate(qa, qb)) cand.push([qa, qb]);

  // Transitive reduction: keeps (a,b) only when no intermediate rung c makes
  // both (a,c) and (c,b) pass the gate. Mirrors the SQL self-join.
  const out: Array<[number, number]> = [];
  for (const [a, b] of cand) {
    const hasIntermediate = slots.some(
      (c) => c.questionId !== a.questionId && c.questionId !== b.questionId &&
             passesGate(a, c) && passesGate(c, b),
    );
    if (!hasIntermediate) out.push([a.questionId, b.questionId]);
  }
  return out;
}
