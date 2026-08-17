/**
 * Stage-4 unified outcome-set soundness certifier. Decides
 * {independent | mutex le1 | ladder | exhaustive eq1} from gated fields only;
 * both finalize feeds route through classifySet, so the verdict is defined
 * once. Every demote goes in the safe direction (Sigma=1 -> Sigma<=1 or no set).
 * Pure / deterministic -- no DB, no LLM.
 */

import {
  isExhaustiveSet,
  isSoundNumericTiling,
  isUnionDoubleMapped,
  ONE_HOT_FIXTURE_KINDS,
  type NumericSlot,
} from './finalize.js';
import { isSetInertEventKind } from '@arb/types';
import { dirPartitionClass, shapeClassOf, foldUnit, unitsEquivalent } from '../util/condition-shape.js';
import { foldKeySpecs } from '../discriminators/registry.js';
import { beltHit } from '../discriminators/telemetry.js';
import { settlementDimensionSetConflict } from '../util/settlement-instrument.js';
import { grainsHeterogeneous, classifyOutcomeAxisByKey } from '../util/outcome-grain.js';
import { kindsMixOrgWithPolitician, type SubjectType } from '../util/subject-aggregate.js';
import {
  foldUnitMultiplier,
  gatedInterval,
  parseBandInterval,
  intervalsOverlap,
  type AxisInterval,
} from '../util/numeric-band.js';

const dirClass = dirPartitionClass;

const toNum = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Slot shape the ladder / mutex certifiers read (one entry per kept slot). */
export interface LadderSlot extends NumericSlot {
  value_unit?: string | null | undefined;
  /** Folded participant key; two per-team ladders under one event must not nest as one chain. NULL-tolerant. */
  folded_participants?: string | null | undefined;
}

export function isNestedLadder(slots: ReadonlyArray<LadderSlot>): boolean {
  if (slots.length < 2) return false;
  if (slots.some((s) => s.value_primary === null || s.value_primary === undefined)) return false;

  const participants = new Set<string>();
  for (const s of slots) {
    const p = s.folded_participants;
    if (p != null && p !== '') participants.add(p);
  }
  if (participants.size > 1) return false;

  const classes = new Set<string>();
  for (const s of slots) {
    const c = dirClass(s.direction);
    if (c !== 'above' && c !== 'below') return false;
    classes.add(c);
  }
  if (classes.size !== 1) return false;

  const shapeClasses = new Set<string>();
  for (const s of slots) {
    const sc = shapeClassOf(s.condition_shape);
    if (sc === 'touch' || sc === 'snapshot') shapeClasses.add(sc);
  }
  if (shapeClasses.size > 1) return false;

  const units = new Set<string>();
  for (const s of slots) units.add(s.value_unit == null ? ' NULL' : String(s.value_unit).toLowerCase());
  if (units.size !== 1) return false;

  const vals = new Set<number>();
  for (const s of slots) {
    const v = toNum(s.value_primary);
    if (v === null) return false;
    vals.add(v);
  }
  return vals.size >= 2 && vals.size === slots.length;
}

/** Certifies mutex only (Sigma<=1), not exhaustivity; values are folded
 *  through {@link foldUnitMultiplier} so magnitude scales compare cleanly. */
export function isPairwiseMutexPartition(slots: ReadonlyArray<LadderSlot>): boolean {
  if (slots.length < 2) return false;
  type Iv = { lo: number; hi: number };
  const NEG = Number.NEGATIVE_INFINITY;
  const POS = Number.POSITIVE_INFINITY;
  const ivs: Iv[] = [];
  const dims = new Set<string>();
  for (const s of slots) {
    const v1 = toNum(s.value_primary);
    if (v1 === null) return false;
    const { mult, dim } = foldUnitMultiplier(s.value_unit);
    dims.add(dim);
    switch (dirClass(s.direction)) {
      case 'above':
        ivs.push({ lo: v1 * mult, hi: POS });
        break;
      case 'below':
        ivs.push({ lo: NEG, hi: v1 * mult });
        break;
      case 'between': {
        const v2 = toNum(s.value_secondary);
        if (v2 === null) return false;
        ivs.push({ lo: Math.min(v1, v2) * mult, hi: Math.max(v1, v2) * mult });
        break;
      }
      case 'at':
        ivs.push({ lo: v1 * mult, hi: v1 * mult });
        break;
      default:
        return false;
    }
  }
  if (dims.size > 1) return false;
  for (let i = 0; i < ivs.length; i++) { // strict `<`: touching at one boundary point is not overlap
    for (let j = i + 1; j < ivs.length; j++) {
      const a = ivs[i], b = ivs[j];
      if (a.lo < b.hi && b.lo < a.hi) return false;
    }
  }
  return true;
}

export const CONFEDERATION_SUBJECTS = new Set<string>([
  'africa',
  'asia',
  'europe',
  'north america',
  'south america',
  'oceania',
  'uefa',
  'conmebol',
  'concacaf',
  'caf',
  'afc',
  'ofc',
]);

function confederationToken(subject: string | null | undefined): string | null {
  if (subject == null) return null;
  const folded = subject.trim().toLowerCase();
  if (folded === '') return null;
  if (CONFEDERATION_SUBJECTS.has(folded)) return folded;
  const colon = folded.lastIndexOf(':');
  if (colon >= 0) {
    const tail = folded.slice(colon + 1).trim();
    if (CONFEDERATION_SUBJECTS.has(tail)) return tail;
  }
  return null;
}

export function mixesConfederationAndCountry(
  slots: ReadonlyArray<{ display_label: string | null | undefined; is_residual: boolean }>,
): boolean {
  let conf = 0;
  let country = 0;
  for (const s of slots) {
    if (confederationToken(s.display_label) !== null) {
      conf++;
      continue;
    }
    if (s.is_residual) continue;
    const folded = (s.display_label ?? '').trim().toLowerCase();
    if (folded === '') continue;
    country++;
  }
  return conf > 0 && country > 0;
}

/** NULL-tolerant: unknown platform never demotes. */
export function residualCoversForeignPlatformSlot(
  slots: ReadonlyArray<Pick<CertifierSlot, 'is_residual' | 'platforms'>>,
): boolean {
  const residualPlatforms = new Set<string>();
  for (const s of slots) {
    if (!s.is_residual) continue;
    for (const p of s.platforms ?? []) if (p) residualPlatforms.add(p);
  }
  if (residualPlatforms.size === 0) return false;

  for (const s of slots) {
    if (s.is_residual) continue;
    const named = s.platforms;
    if (named == null) continue;
    const namedSet = new Set<string>();
    for (const p of named) if (p) namedSet.add(p);
    if (namedSet.size === 0) continue;
    for (const rp of residualPlatforms) {
      if (!namedSet.has(rp)) return true;
    }
  }
  return false;
}

const HETERO_MUTEX_SLOT_CAP: Record<string, number> = {
  match_winner: 3,
  halftime_leader: 3,
  candle_direction: 2,
};

export interface HeteroKindPartitionResult {
  mutexGroups: CertifierSlot[][];
  freedSlots: CertifierSlot[];
}

function heteroKindGroupIsMutex(kind: string, group: ReadonlyArray<CertifierSlot>): boolean {
  if (!ONE_HOT_FIXTURE_KINDS.has(kind)) return false;
  const real = group.filter((s) => !s.is_residual);
  if (real.length < 2) return false;
  if (
    isUnionDoubleMapped(
      group.map((s) => ({
        outcome_id: s.outcome_id,
        subject: s.display_label,
        is_residual: s.is_residual,
        market_ids: s.market_ids,
      })),
    )
  ) {
    return false;
  }

  if (kind === 'exact_score') {
    const pairs = new Set<string>();
    for (const s of real) {
      const v1 = toNum(s.value_primary);
      const v2 = toNum(s.value_secondary);
      if (v1 === null || v2 === null) return false;
      const key = v1 + '|' + v2;
      if (pairs.has(key)) return false;
      pairs.add(key);
    }
    return true;
  }

  const cap = HETERO_MUTEX_SLOT_CAP[kind];
  if (cap === undefined || real.length > cap) return false;
  const subjects: string[] = [];
  let empty = 0;
  for (const s of real) {
    const t = (s.display_label ?? '').trim().toLowerCase();
    if (t === '') {
      empty++;
      if (empty > 1) return false;
      continue;
    }
    subjects.push(t);
  }
  for (let i = 0; i < subjects.length; i++) {
    for (let j = i + 1; j < subjects.length; j++) {
      if (subjects[i].includes(subjects[j]) || subjects[j].includes(subjects[i])) return false; // label drift of one outcome
    }
  }
  return true;
}

function heteroKindBucket(s: CertifierSlot, foldHasExactScore: boolean): string {
  if (s.event_kind != null && !isSetInertEventKind(s.event_kind)) return s.event_kind;
  if (foldHasExactScore && isScorelineSlot(s)) return 'exact_score';
  return '';
}

function isScorelineSlot(s: Pick<CertifierSlot, 'value_primary' | 'value_secondary'>): boolean {
  const a = toNum(s.value_primary);
  const b = toNum(s.value_secondary);
  return (
    a !== null && b !== null &&
    Number.isInteger(a) && Number.isInteger(b) &&
    a >= 0 && b >= 0 && a <= 20 && b <= 20
  );
}

export function partitionHeteroCategoricalByKind(
  slots: ReadonlyArray<CertifierSlot>,
): HeteroKindPartitionResult | null {
  const kinds = new Set<string>();
  for (const s of slots) if (s.event_kind != null && !isSetInertEventKind(s.event_kind)) kinds.add(s.event_kind);
  if (kinds.size <= 1) return null;

  const order: string[] = [];
  const byKind = new Map<string, CertifierSlot[]>();
  const foldHasExactScore = kinds.has('exact_score');
  for (const s of slots) {
    const k = heteroKindBucket(s, foldHasExactScore);
    let g = byKind.get(k);
    if (!g) {
      g = [];
      byKind.set(k, g);
      order.push(k);
    }
    g.push(s);
  }

  const mutexGroups: CertifierSlot[][] = [];
  const freedSlots: CertifierSlot[] = [];
  for (const k of order) {
    const group = byKind.get(k)!;
    if (k !== '' && heteroKindGroupIsMutex(k, group)) mutexGroups.push(group);
    else freedSlots.push(...group);
  }
  return { mutexGroups, freedSlots };
}

/** Mirrors register.ts SOCCER_CLUB_SUFFIXES -- keep both in sync. */
const DRIFT_CLUB_SUFFIXES: readonly string[] = [
  'football club',
  'f.c.',
  'a.f.c.',
  's.c.',
  'c.f.',
  'afc',
  'fc',
  'sc',
  'cf',
  'club',
];

export function foldDriftLabel(s: string | null | undefined): string | null {
  if (s == null) return null;
  let t = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (t === '') return null;
  for (const suf of DRIFT_CLUB_SUFFIXES) {
    if (t.endsWith(' ' + suf)) {
      const stripped = t.slice(0, t.length - suf.length - 1).trim();
      if (stripped !== '') { t = stripped; break; }
    }
    if (t.startsWith(suf + ' ')) {
      const stripped = t.slice(suf.length + 1).trim();
      if (stripped !== '') { t = stripped; break; }
    }
  }
  const folded = t.replace(/\s+/g, '');
  return folded === '' ? null : folded;
}

export function labelDriftDuplicateOutcomeIds(
  slots: ReadonlyArray<CertifierSlot>,
): Set<string> {
  type Member = { slot: CertifierSlot; vp: string | null; vs: string | null; dir: string | null };
  const valKey = (v: number | string | null | undefined): string | null => {
    const n = toNum(v);
    if (n !== null) return String(n);
    return v == null ? null : String(v);
  };
  const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
  const groups: { fold: string; members: Member[] }[] = [];
  for (const s of slots) {
    if (s.is_residual) continue;
    const fold = foldDriftLabel(s.display_label);
    if (fold === null) continue;
    const m: Member = { slot: s, vp: valKey(s.value_primary), vs: valKey(s.value_secondary), dir: dirClass(s.direction) };
    let placed = false;
    for (const g of groups) {
      if (g.fold !== fold) continue;
      const compatible = g.members.every(
        (e) => !differs(e.vp, m.vp) && !differs(e.vs, m.vs) && !differs(e.dir, m.dir),
      );
      if (compatible) { g.members.push(m); placed = true; break; }
    }
    if (!placed) groups.push({ fold, members: [m] });
  }
  const out = new Set<string>();
  for (const g of groups) {
    if (g.members.length >= 2) for (const m of g.members) out.add(m.slot.outcome_id);
  }
  return out;
}

function foldBeltSubject(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return t === '' ? null : t;
}

export function hasNestedCumulativeRungs(
  slots: ReadonlyArray<
    Pick<CertifierSlot, 'canonical_subject' | 'direction' | 'value_primary' | 'value_unit' | 'is_residual'>
  >,
): boolean {
  const seen = new Map<string, Set<string>>();
  for (const s of slots) {
    if (s.is_residual) continue;
    const subj = foldBeltSubject(s.canonical_subject);
    if (subj === null) continue;
    const c = dirClass(s.direction);
    if (c !== 'above' && c !== 'below') continue;
    const v = toNum(s.value_primary);
    if (v === null) continue;
    const unit = s.value_unit == null ? '\u0000NULL' : String(s.value_unit).toLowerCase().trim();
    const key = subj + '\u0000' + c + '\u0000' + unit;
    let vals = seen.get(key);
    if (!vals) {
      vals = new Set();
      seen.set(key, vals);
    }
    vals.add(String(v));
    if (vals.size >= 2) return true;
  }
  return false;
}

/** "by <date>" framings: terminal once-true cumulative latches. */
export const DATE_LATCH_KINDS = new Set(['token_launch']);

export function hasNestedDeadlineRungs(
  slots: ReadonlyArray<
    Pick<CertifierSlot, 'event_kind' | 'condition_date' | 'value_primary' | 'is_residual'>
  >,
): boolean {
  const dates = new Set<string>();
  let real = 0;
  for (const s of slots) {
    if (s.is_residual) continue;
    real++;
    if (s.event_kind == null || !DATE_LATCH_KINDS.has(s.event_kind)) return false;
    if (s.value_primary !== null && s.value_primary !== undefined) return false;
    if (s.condition_date != null && s.condition_date !== '') dates.add(String(s.condition_date).slice(0, 10));
  }
  return real >= 2 && dates.size >= 2;
}

const BELT_V_RANK_KINDS = new Set(['championship_winner', 'election_outcome_winner', 'stage_advance']);
const BELT_V_AXES = new Set<string>(['winner', 'numeric_band']);
function isRankEncodingKind(k: string | null | undefined): boolean {
  if (k == null) return false;
  if (ONE_HOT_FIXTURE_KINDS.has(k)) return true;
  if (BELT_V_RANK_KINDS.has(k)) return true;
  return k.includes('winner');
}

export function computeAxisInterval(s: {
  is_residual: boolean;
  event_kind?: string | null | undefined;
  value_unit?: string | null | undefined;
  direction?: string | null | undefined;
  value_primary?: number | string | null | undefined;
  value_secondary?: number | string | null | undefined;
  axis_key?: string | null | undefined;
  label_fallback?: string | null | undefined;
}): AxisInterval | null {
  if (s.is_residual) return null;
  if (isRankEncodingKind(s.event_kind)) return null;
  if ((s.value_unit ?? '').trim().toLowerCase() === 'rank') return null;
  const grain = classifyOutcomeAxisByKey(s.axis_key ?? '', null, null);
  if (!BELT_V_AXES.has(grain)) return null;
  const gated = gatedInterval(s.direction, s.value_primary, s.value_secondary, s.value_unit);
  if (gated) return gated;
  return parseBandInterval(s.axis_key) ?? parseBandInterval(s.label_fallback);
}

export function hasValueAxisOverlap(
  slots: ReadonlyArray<Pick<CertifierSlot, 'is_residual' | 'canonical_subject' | 'axis_interval'>>,
): boolean {
  const cands = slots.filter((s) => !s.is_residual && s.axis_interval != null);
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i].axis_interval!;
      const b = cands[j].axis_interval!;
      if (a.dim !== b.dim) continue;
      const sa = foldBeltSubject(cands[i].canonical_subject);
      const sb = foldBeltSubject(cands[j].canonical_subject);
      if (sa !== sb) continue;
      if (a.lo === b.lo && a.hi === b.hi) continue; // identical interval -> not this belt's jurisdiction
      if (intervalsOverlap(a, b)) return true;
    }
  }
  return false;
}

/** A kept slot as the unified classifier sees it (all gated fields, no title). */
export interface CertifierSlot {
  outcome_id: string;
  /** Bucket label, not a canonical subject -- see `canonical_subject`. */
  display_label: string | null;
  is_residual: boolean;
  market_ids: ReadonlyArray<number> | null | undefined;
  platforms?: ReadonlyArray<string> | null | undefined;
  canonical_subject?: string | null | undefined;
  direction: string | null | undefined;
  value_primary: number | string | null | undefined;
  value_secondary: number | string | null | undefined;
  value_unit: string | null | undefined;
  condition_metric?: string | null | undefined;
  settlement_dimensions?: ReadonlyArray<string> | null | undefined;
  event_kind: string | null | undefined;
  condition_shape?: string | null | undefined;
  condition_date?: string | null | undefined;
  folded_participants?: string | null | undefined;
  axis_interval?: AxisInterval | null | undefined;
  is_multiyes: boolean;
  subject_type?: SubjectType | null | undefined;
  /** Max simultaneous winners, where determinable; NULL = unknown/single-winner. */
  mutex_cardinality?: number | null | undefined;
  has_negrisk: boolean;
  native_independent?: boolean | null | undefined;
  is_kalshi_custom_score?: boolean | null | undefined;
  disc?: Record<string, string | null> | null | undefined;
}

/** Signals the classifier needs that are NOT per-slot. */
export interface CertifierSignals {
  groupedAs: 'categorical' | 'threshold_series';
  kindHomogeneous: boolean;
  allBoundChildrenMapped: boolean;
  /** Suppresses the residual Sigma=1 arm for an occurrence-open race ("first to hit X"). */
  openRaceFold: boolean;
}

export type SetVerdict =
  | { setType: 'threshold_series'; isExhaustive: true }
  | { setType: 'categorical'; isExhaustive: boolean }
  | null;

export function hasFoldKeyDiscriminatorViolation(
  slots: ReadonlyArray<Pick<CertifierSlot, 'disc' | 'is_residual'>>,
): string | null {
  for (const spec of foldKeySpecs()) {
    const vals = new Set<string>();
    let hasNull = false;
    for (const s of slots) {
      if (s.is_residual) continue;
      const v = s.disc?.[spec.name] ?? null;
      if (v == null) hasNull = true;
      else vals.add(v.toLowerCase());
    }
    const differ = vals.size >= 2;
    const knownNullMix = vals.size >= 1 && hasNull;
    if (spec.nullPolicy === 'tolerant') {
      if (differ) return spec.name;
    } else if (differ || knownNullMix) {
      return spec.name;
    }
  }
  return null;
}

export function hasMultiWinnerCardinality(
  slots: ReadonlyArray<Pick<CertifierSlot, 'mutex_cardinality' | 'is_residual'>>,
): boolean {
  for (const s of slots) {
    if (s.is_residual) continue;
    const k = s.mutex_cardinality;
    if (k != null && k > 1) return true;
  }
  return false;
}

export function mixesAggregateOrgWithPolitician(
  slots: ReadonlyArray<Pick<CertifierSlot, 'subject_type'>>,
): boolean {
  const kinds: SubjectType[] = [];
  for (const s of slots) if (s.subject_type != null) kinds.push(s.subject_type);
  return kindsMixOrgWithPolitician(kinds);
}

export function hasKalshiCustomExactScore(
  slots: ReadonlyArray<Pick<CertifierSlot, 'is_kalshi_custom_score' | 'is_residual'>>,
): boolean {
  for (const s of slots) {
    if (s.is_residual) continue;
    if (s.is_kalshi_custom_score === true) return true;
  }
  return false;
}

/** Mirrored in services/arb-solver/src/graph/independent-bundle-belt.ts -- keep in sync. */
export function refusesNativeIndependentBundle(
  slots: ReadonlyArray<CertifierSlot>,
  ladderSlots: ReadonlyArray<NumericSlot>,
): boolean {
  const realSlots = slots.filter((s) => !s.is_residual);
  if (realSlots.length < 2) return false;
  if (!slots.some((s) => s.native_independent === true)) return false;
  if (slots.some((s) => s.has_negrisk)) return false;
  if (slots.some((s) => s.event_kind != null && ONE_HOT_FIXTURE_KINDS.has(s.event_kind))) return false;
  if (isSoundNumericTiling(ladderSlots)) return false;
  return true;
}

/** Both-known-and-differ on condition_metric / value_unit; a hit demotes Sigma=1 -> Sigma<=1. */
export function heteroDimensionViolation(
  slots: ReadonlyArray<Pick<CertifierSlot, 'is_residual' | 'condition_metric' | 'value_unit'>>,
): string | null {
  const metrics: string[] = [];
  const units: string[] = [];
  for (const s of slots) {
    if (s.is_residual) continue;
    const m = foldUnit(s.condition_metric ?? null);
    if (m != null) metrics.push(m);
    const u = foldUnit(s.value_unit ?? null);
    if (u != null && u !== 'rank') units.push(u);
  }
  if (new Set(metrics).size >= 2) return 'condition_metric';
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      if (!unitsEquivalent(units[i], units[j])) return 'value_unit';
    }
  }
  return null;
}

/** Unlike heteroDimensionViolation, a hit here REFUSES the whole set (never demotes). */
export function settlementDimensionConflictReason(
  slots: ReadonlyArray<Pick<CertifierSlot, 'settlement_dimensions'>>,
): string | null {
  const pair = settlementDimensionSetConflict(
    slots.flatMap((s) => [...(s.settlement_dimensions ?? [])]),
  );
  return pair ? `${pair[0]} vs ${pair[1]}` : null;
}

/** Known-vs-known only; a NULL slot never triggers this. */
export function mixesKnownMetricScopes(
  slots: ReadonlyArray<Pick<CertifierSlot, 'disc' | 'is_residual'>>,
): boolean {
  const scopes = new Set<string>();
  for (const s of slots) {
    if (s.is_residual) continue;
    const v = s.disc?.metric_scope;
    if (v != null && v !== '') scopes.add(v.toLowerCase());
  }
  return scopes.size >= 2;
}

export function classifySet(
  slots: ReadonlyArray<CertifierSlot>,
  signals: CertifierSignals,
): SetVerdict {
  const dimConflict = settlementDimensionConflictReason(slots);
  if (dimConflict) {
    beltHit('settlement_dimension_set_refuse', { dims: dimConflict });
    return null;
  }
  if (hasMultiWinnerCardinality(slots)) {
    beltHit('award_multiwinner_no_mutex');
    return null;
  }
  if (mixesKnownMetricScopes(slots)) {
    beltHit('slice_scope_mix_no_set');
    return null;
  }
  const verdict = classifySetCore(slots, signals);
  if (verdict && verdict.isExhaustive) {
    if (hasKalshiCustomExactScore(slots)) {
      beltHit('kalshi_custom_score_demote');
      return { setType: 'categorical', isExhaustive: false };
    }
    if (residualCoversForeignPlatformSlot(slots)) {
      beltHit('xplat_residual_demote');
      return { setType: 'categorical', isExhaustive: false };
    }
    const bad = hasFoldKeyDiscriminatorViolation(slots);
    if (bad) {
      beltHit(`certifier_disc_demote.${bad}`);
      return { setType: 'categorical', isExhaustive: false };
    }
    const dim = heteroDimensionViolation(slots);
    if (dim) {
      beltHit('hetero_dimension_demote');
      return { setType: 'categorical', isExhaustive: false };
    }
  }
  return verdict;
}

function classifySetCore(
  slots: ReadonlyArray<CertifierSlot>,
  signals: CertifierSignals,
): SetVerdict {
  if (slots.length < 2) return null;

  const ladderSlots: LadderSlot[] = slots.map((s) => ({
    direction: s.direction,
    value_primary: s.value_primary,
    value_secondary: s.value_secondary,
    value_unit: s.value_unit,
    event_kind: s.event_kind,
    condition_shape: s.condition_shape,
    folded_participants: s.folded_participants,
  }));

  if (signals.groupedAs === 'threshold_series') {
    if (isNestedLadder(ladderSlots)) return { setType: 'threshold_series', isExhaustive: true };
    if (signals.kindHomogeneous && isSoundNumericTiling(ladderSlots)) {
      return { setType: 'categorical', isExhaustive: true };
    }
    if (isPairwiseMutexPartition(ladderSlots)) return { setType: 'categorical', isExhaustive: false };
    return null;
  }

  // Grain-homogeneity backstop: a categorical fold whose real slots span >1
  // outcome grain mixes co-occurrable bet types, so even Sigma<=1 is false.
  if (grainsHeterogeneous(slots, (s) => classifyOutcomeAxisByKey(s.outcome_id, null, null), (s) => s.is_residual)) {
    beltHit('categorical_grain_heterogeneous');
    return null;
  }

  // Org-vs-politician: a party aggregate co-resolves YES with its own candidate.
  if (mixesAggregateOrgWithPolitician(slots)) {
    beltHit('categorical_org_vs_politician');
    return null;
  }

  if (refusesNativeIndependentBundle(slots, ladderSlots)) {
    beltHit('categorical_native_independent_bundle');
    return null;
  }

  const hasResidual = slots.some((s) => s.is_residual);

  // Nested-cumulative belt (see hasNestedCumulativeRungs). A sound
  // between-dominated numeric tiling is exempt.
  if (hasNestedCumulativeRungs(slots) && !isSoundNumericTiling(ladderSlots)) {
    const subjectFolds = new Set(slots.map((s) => foldBeltSubject(s.canonical_subject)));
    if (
      !hasResidual &&
      subjectFolds.size === 1 &&
      !subjectFolds.has(null) &&
      isNestedLadder(ladderSlots)
    ) {
      return { setType: 'threshold_series', isExhaustive: true };
    }
    return null;
  }

  if (hasNestedDeadlineRungs(slots)) {
    beltHit('nested_deadline_no_mutex');
    return null;
  }

  if (!isSoundNumericTiling(ladderSlots) && hasValueAxisOverlap(slots)) {
    beltHit('value_axis_overlap_no_mutex');
    return null;
  }

  const isMultiYesFold = slots.some((s) => s.is_multiyes);
  const isNeg = slots.some((s) => s.has_negrisk);
  const isFixtureKind = slots.some(
    (s) => s.event_kind != null && ONE_HOT_FIXTURE_KINDS.has(s.event_kind),
  );
  const numericTiling = isSoundNumericTiling(ladderSlots);
  const realSlotCount = slots.filter((s) => !s.is_residual).length;

  if (hasResidual && signals.kindHomogeneous && signals.openRaceFold) {
    beltHit('open_race_residual_demote');
  }

  // All three Sigma=1 arms require kind-homogeneity, not just negRisk.
  const baseExhaustive = isExhaustiveSet({
    isCategorical: true,
    isMultiYesFold,
    isNeg: isNeg && signals.kindHomogeneous,
    isFixtureKind,
    hasResidual: hasResidual && signals.kindHomogeneous && !signals.openRaceFold,
    numericTiling: numericTiling && signals.kindHomogeneous,
    realSlotCount,
  });

  const unionDoubleMapped = isUnionDoubleMapped(
    slots.map((s) => ({
      outcome_id: s.outcome_id,
      subject: s.display_label,
      is_residual: s.is_residual,
      market_ids: s.market_ids,
    })),
  );

  const confederationMix = mixesConfederationAndCountry(slots);

  // An exact-score grid never self-partitions -- Sigma=1 needs an in-set residual.
  const exactScoreSansResidual =
    !hasResidual && slots.some((s) => s.event_kind === 'exact_score');

  const isExhaustive =
    baseExhaustive &&
    !unionDoubleMapped &&
    !confederationMix &&
    signals.allBoundChildrenMapped &&
    !exactScoreSansResidual;

  return { setType: 'categorical', isExhaustive };
}
