/**
 * The single validated emission door for the Stage-1 condition tuple — the one
 * choke point every handler's output must pass through before it is persisted,
 * so validation lives here rather than in each handler. An
 * archetype determines condition_shape, legal temporal set, direction class
 * and value arity, so a handler that picks an archetype cannot also pick a
 * shape. Production default is warn-and-null (unshaped beats unsound);
 * EMIT_CONDITION_STRICT=1 turns hard-rule warns into throws, except `bespoke`
 * emissions which always warn-and-pass.
 */
import type {
  ConditionDirection,
  ConditionMetric,
  ConditionShape,
  EventKind,
  LLMMarketNormalization,
  MetricScope,
  TemporalSemantics,
} from '@arb/types';
import { createLogger } from '@arb/logger';
import { SHAPE_TEMPORAL_VALID } from './shape-temporal-validation.js';
import { foldUnit, MONOTONE_COUNT_UNITS } from '../util/condition-shape.js';
import { formatConditionValue } from '../util/condition-value.js';

export type Archetype =
  | 'terminal_threshold' | 'terminal_range' | 'path_touch' | 'cumulative_count'
  | 'fixture_outcome' | 'fixture_margin' | 'categorical_selection' | 'event_occurrence'
  | 'bespoke';

export interface ConditionDateSpec {
  iso: string;
  precision: 'minute' | 'hour' | 'day' | 'month' | 'year'; // non-optional — no date without precision
  source: string;
}

export interface EmitSpec {
  archetype: Archetype;
  tag: string;
  eventKind: EventKind;
  metric: ConditionMetric | null;
  direction?: ConditionDirection | null;
  temporal?: TemporalSemantics | null;           // omitted → archetype default
  value?: { primary: number; secondary?: number | null; unit: string | null } | null;
  /** undefined → assembly site derives; {forceNull:true} → suppresses end_date fallback; else explicit override. */
  date?: ConditionDateSpec | { forceNull: true };
  metricScope?: MetricScope | null;
  outcomeLabel?: string | null;
  topology?: 'standalone_binary' | 'mutex_partition_member' | 'rank_latch';  // fixture_outcome
  arm?: 'range' | 'above' | 'below';                                          // cumulative_count
  legacyMonotonicArm?: boolean;                                               // cumulative_count open-top compat
  bespoke?: { shape: ConditionShape; justification: string };                 // required when archetype='bespoke'
}

export interface ConditionTuple {
  event_kind: EventKind;
  condition_shape: ConditionShape;
  condition_direction: ConditionDirection | null;
  condition_metric: ConditionMetric | null;
  condition_date: string | null;                 // null when date undefined OR forceNull
  condition_date_precision: 'minute' | 'hour' | 'day' | 'month' | 'year' | null;
  condition_date_source: string | null;
  condition_date_force_null: boolean;
  date_deferred: boolean;                        // true ⇔ spec.date === undefined
  value_primary: number | null;
  value_secondary: number | null;
  value_unit: string | null;                     // foldUnit()-ed, NOT canonicalUnit()-ed
  condition_value: string | null;
  metric_scope: MetricScope | null;
  temporal_semantics: TemporalSemantics | null;
  outcome_label: string | null;
}

/** One derivation-table variant; the parity test asserts the legal temporal set
 *  is a subset of SHAPE_TEMPORAL_VALID[shape] for every variant. */
export interface ArchetypeVariant {
  shape: ConditionShape;
  temporal: ReadonlySet<TemporalSemantics>;
  temporalNullOk: boolean;
  defaultTemporal: TemporalSemantics | null;
}

export const ARCHETYPE_VARIANTS: Readonly<Record<string, ArchetypeVariant>> = {
  terminal_threshold: {
    shape: 'point_in_time',
    temporal: new Set<TemporalSemantics>(['on_date', 'at_resolution']),
    temporalNullOk: false,
    defaultTemporal: 'on_date',
  },
  terminal_range: {
    shape: 'range_snapshot',
    temporal: new Set<TemporalSemantics>(['on_date']),
    temporalNullOk: false,
    defaultTemporal: 'on_date',
  },
  path_touch: {
    shape: 'monotonic_threshold',
    temporal: new Set<TemporalSemantics>(['by_date', 'at_resolution', 'during_period']),
    temporalNullOk: false,
    defaultTemporal: 'by_date',
  },
  'cumulative_count.range': {
    shape: 'range_snapshot',
    temporal: new Set<TemporalSemantics>(['during_period']),
    temporalNullOk: false,
    defaultTemporal: 'during_period',
  },
  'cumulative_count.boundary': {
    shape: 'point_in_time',
    temporal: new Set<TemporalSemantics>(['on_date']),
    temporalNullOk: false,
    defaultTemporal: 'on_date',
  },
  'cumulative_count.boundary_legacy': {
    shape: 'monotonic_threshold',
    temporal: new Set<TemporalSemantics>(['during_period', 'by_date', 'at_resolution']),
    temporalNullOk: false,
    defaultTemporal: 'during_period',
  },
  'fixture_outcome.standalone_binary': {
    shape: 'binary_event',
    temporal: new Set<TemporalSemantics>(['at_resolution']),
    temporalNullOk: true,
    defaultTemporal: 'at_resolution',
  },
  'fixture_outcome.mutex_partition_member': {
    shape: 'categorical_outcome',
    temporal: new Set<TemporalSemantics>(['at_resolution']),
    temporalNullOk: false,
    defaultTemporal: 'at_resolution',
  },
  'fixture_outcome.rank_latch': {
    shape: 'monotonic_threshold',
    temporal: new Set<TemporalSemantics>(['at_resolution', 'by_date']),
    temporalNullOk: false,
    defaultTemporal: 'at_resolution',
  },
  fixture_margin: {
    shape: 'point_in_time',
    temporal: new Set<TemporalSemantics>(['at_resolution']),
    temporalNullOk: false,
    defaultTemporal: 'at_resolution',
  },
  categorical_selection: {
    shape: 'categorical_outcome',
    temporal: new Set<TemporalSemantics>(['at_resolution']),
    temporalNullOk: false,
    defaultTemporal: 'at_resolution',
  },
  event_occurrence: {
    shape: 'binary_event',
    temporal: new Set<TemporalSemantics>(['by_date', 'on_date', 'during_period', 'at_resolution']),
    temporalNullOk: true,
    defaultTemporal: null,
  },
};

/** Kinds whose metric is structural (carried by event_kind + canonical_event, condition_metric NULL live) — exempt from the terminal_threshold numeric-metric invariant. */
const METRICLESS_THRESHOLD_KINDS: ReadonlySet<string> = new Set([
  'weather_extreme', 'election_margin', 'election_turnout', 'election_vote_share',
]);

/** Numeric metrics legal for terminal_threshold ('boolean' excluded). */
const NUMERIC_METRICS: ReadonlySet<ConditionMetric> = new Set([
  'price', 'percentage', 'count', 'rank', 'score',
]);

const strict = (): boolean => process.env['EMIT_CONDITION_STRICT'] === '1';

/** Hard-rule violation: warn-and-null (production) / throw (strict). */
function violate(prefix: string, rule: string, detail: string, tag: string): null {
  const msg = `${rule}: ${detail} (${tag})`;
  if (strict()) throw new Error(`[${prefix}] ${msg}`);
  createLogger(prefix).warn(msg);
  return null;
}

/** Soft warn (bespoke / validate-only semantics): logs, never throws. */
function warnPass(prefix: string, rule: string, detail: string, tag: string): void {
  createLogger(prefix).warn(`${rule}: ${detail} (${tag})`);
}

/** BESPOKE_EMISSION marker, once per (tag, shape) per process — a log marker, not a validation failure. */
const bespokeWarned = new Set<string>();
function warnBespokeOnce(prefix: string, tag: string, shape: ConditionShape, justification: string): void {
  const key = `${tag}\x00${shape}`;
  if (bespokeWarned.has(key)) return;
  bespokeWarned.add(key);
  createLogger(prefix).warn(`BESPOKE_EMISSION(${tag}): ${shape} — ${justification}`);
}

/** Resolve the derivation-table variant for a spec. */
function resolveVariant(spec: EmitSpec): { key: string; v: ArchetypeVariant } | { error: string } {
  switch (spec.archetype) {
    case 'cumulative_count': {
      if (spec.arm === 'range') {
        if (spec.legacyMonotonicArm) {
          return { error: 'legacyMonotonicArm applies to boundary arms only, got arm=range' };
        }
        return { key: 'cumulative_count.range', v: ARCHETYPE_VARIANTS['cumulative_count.range']! };
      }
      if (spec.arm === 'above' || spec.arm === 'below') {
        const key = spec.legacyMonotonicArm ? 'cumulative_count.boundary_legacy' : 'cumulative_count.boundary';
        return { key, v: ARCHETYPE_VARIANTS[key]! };
      }
      return { error: `cumulative_count requires arm ∈ {range, above, below}, got ${String(spec.arm)}` };
    }
    case 'fixture_outcome': {
      if (!spec.topology) {
        return { error: 'fixture_outcome requires a topology' };
      }
      const key = `fixture_outcome.${spec.topology}`;
      return { key, v: ARCHETYPE_VARIANTS[key]! };
    }
    default: {
      const v = ARCHETYPE_VARIANTS[spec.archetype];
      if (!v) return { error: `unknown archetype ${String(spec.archetype)}` };
      return { key: spec.archetype, v };
    }
  }
}

// Returns null on hard invariant violation (unshaped beats unsound).
export function emitCondition(spec: EmitSpec, prefix: string = 'emit-condition'): ConditionTuple | null {
  const tag = spec.tag;

  let shape: ConditionShape;
  let variant: ArchetypeVariant | null = null;
  let variantKey = '';
  const bespokeMode = spec.archetype === 'bespoke';

  if (bespokeMode) {
    if (!spec.bespoke || spec.bespoke.justification.trim().length < 20) {
      return violate(prefix, 'BESPOKE_JUSTIFICATION',
        'bespoke emission requires { shape, justification ≥ 20 chars }', tag);
    }
    shape = spec.bespoke.shape;
    warnBespokeOnce(prefix, tag, shape, spec.bespoke.justification);
  } else {
    const resolved = resolveVariant(spec);
    if ('error' in resolved) return violate(prefix, 'ARCHETYPE_VARIANT', resolved.error, tag);
    variant = resolved.v;
    variantKey = resolved.key;
    shape = variant.shape;
  }

  // Temporal must sit in the archetype's legal set AND in SHAPE_TEMPORAL_VALID.
  const temporal: TemporalSemantics | null =
    spec.temporal === undefined ? (variant ? variant.defaultTemporal : null) : spec.temporal;

  if (!bespokeMode && variant) {
    if (temporal === null) {
      if (!variant.temporalNullOk) {
        return violate(prefix, 'ARCHETYPE_TEMPORAL',
          `null temporal not legal for ${variantKey}`, tag);
      }
    } else if (!variant.temporal.has(temporal)) {
      return violate(prefix, 'ARCHETYPE_TEMPORAL',
        `${temporal} not in the legal set for ${variantKey}`, tag);
    } else if (!SHAPE_TEMPORAL_VALID[shape].has(temporal)) {
      // unreachable while the parity invariant holds (tested); belt-and-braces.
      return violate(prefix, 'Invalid shape×temporal', `${shape} + ${temporal}`, tag);
    }
  } else if (temporal !== null && !SHAPE_TEMPORAL_VALID[shape].has(temporal)) {
    warnPass(prefix, 'Invalid shape×temporal', `${shape} + ${temporal}`, tag);
  }

  let direction: ConditionDirection | null = spec.direction ?? null;
  let metric: ConditionMetric | null = spec.metric;
  let valuePrimary: number | null = spec.value?.primary ?? null;
  let valueSecondary: number | null = spec.value?.secondary ?? null;
  let valueUnit: string | null = foldUnit(spec.value?.unit ?? null);

  if (!bespokeMode) {
    switch (spec.archetype) {
      case 'terminal_threshold':
        if (direction !== 'above' && direction !== 'below' && direction !== 'at') {
          return violate(prefix, 'ARCHETYPE_DIRECTION',
            `terminal_threshold requires above|below|at, got ${String(direction)}`, tag);
        }
        break;
      case 'terminal_range':
        direction = 'between'; // forced; decision lives in the derivation table
        break;
      case 'path_touch':
        if (direction !== 'above' && direction !== 'below') {
          return violate(prefix, 'ARCHETYPE_DIRECTION',
            `path_touch requires above|below, got ${String(direction)}`, tag);
        }
        break;
      case 'cumulative_count':
        if (spec.arm === 'range') {
          direction = 'between';
        } else {
          if (direction !== null && direction !== spec.arm) {
            return violate(prefix, 'ARCHETYPE_DIRECTION',
              `cumulative_count ${String(spec.arm)} arm contradicts direction ${String(direction)}`, tag);
          }
          direction = spec.arm as ConditionDirection;
        }
        break;
      case 'fixture_outcome':
        if (spec.topology === 'rank_latch') {
          if (direction !== 'below' && direction !== 'at') {
            return violate(prefix, 'ARCHETYPE_DIRECTION',
              `rank_latch requires below|at, got ${String(direction)}`, tag);
          }
        } else if (direction !== null) {
          return violate(prefix, 'ARCHETYPE_DIRECTION',
            `fixture_outcome ${String(spec.topology)} requires null direction, got ${direction}`, tag);
        }
        break;
      case 'fixture_margin':
        if (direction !== 'above' && direction !== 'below') {
          return violate(prefix, 'ARCHETYPE_DIRECTION',
            `fixture_margin requires above|below, got ${String(direction)}`, tag);
        }
        break;
      case 'categorical_selection':
        if (direction !== null && direction !== 'at' && direction !== 'above' && direction !== 'below') {
          return violate(prefix, 'ARCHETYPE_DIRECTION',
            `categorical_selection requires null|at|above|below, got ${direction}`, tag);
        }
        break;
      case 'event_occurrence':
        if (direction !== null) {
          return violate(prefix, 'ARCHETYPE_DIRECTION',
            `event_occurrence requires null direction, got ${direction} — route bespoke if load-bearing`, tag);
        }
        break;
    }

    // Value arity is checked, never silently repaired (parseNumericOutcome owns the hi-lo swap).
    const isRangeArity =
      spec.archetype === 'terminal_range' ||
      (spec.archetype === 'cumulative_count' && spec.arm === 'range');
    const isUnitArity =
      spec.archetype === 'terminal_threshold' ||
      spec.archetype === 'path_touch' ||
      spec.archetype === 'fixture_margin' ||
      (spec.archetype === 'cumulative_count' && spec.arm !== 'range');
    const isZeroArity =
      spec.archetype === 'event_occurrence' ||
      (spec.archetype === 'fixture_outcome' && spec.topology !== 'rank_latch');

    if (isRangeArity) {
      if (valuePrimary == null || valueSecondary == null ||
          !Number.isFinite(valuePrimary) || !Number.isFinite(valueSecondary)) {
        return violate(prefix, 'VALUE_ARITY',
          `range arm requires two finite bounds, got ${String(valuePrimary)}/${String(valueSecondary)}`, tag);
      }
      if (!(valuePrimary < valueSecondary)) {
        return violate(prefix, 'VALUE_ARITY',
          `range bounds must satisfy lo < hi, got ${valuePrimary} >= ${valueSecondary} (caller swaps via parseNumericOutcome)`, tag);
      }
    } else if (isUnitArity) {
      if (valuePrimary == null || !Number.isFinite(valuePrimary)) {
        return violate(prefix, 'VALUE_ARITY',
          `${spec.archetype} requires a finite value_primary, got ${String(valuePrimary)}`, tag);
      }
      if (valueSecondary != null) {
        return violate(prefix, 'VALUE_ARITY',
          `${spec.archetype} is arity-1, got secondary ${valueSecondary}`, tag);
      }
    } else if (isZeroArity) {
      if (valuePrimary != null || valueSecondary != null) {
        return violate(prefix, 'VALUE_ARITY',
          `${spec.archetype}${spec.topology ? `.${spec.topology}` : ''} requires null values, got ${String(valuePrimary)}/${String(valueSecondary)}`, tag);
      }
    } else if (spec.archetype === 'categorical_selection') {
      // 0-2 values; 2 = score pairs with direction null, no lo<hi ordering (exact-score (2,1) is legal).
      if (valuePrimary != null && !Number.isFinite(valuePrimary)) {
        return violate(prefix, 'VALUE_ARITY', `non-finite value_primary ${String(valuePrimary)}`, tag);
      }
      if (valueSecondary != null) {
        if (!Number.isFinite(valueSecondary)) {
          return violate(prefix, 'VALUE_ARITY', `non-finite value_secondary ${String(valueSecondary)}`, tag);
        }
        if (valuePrimary == null) {
          return violate(prefix, 'VALUE_ARITY', 'value_secondary without value_primary', tag);
        }
        if (direction !== null) {
          return violate(prefix, 'VALUE_ARITY',
            `2-value categorical_selection requires null direction, got ${direction}`, tag);
        }
      }
    } else if (spec.archetype === 'fixture_outcome' && spec.topology === 'rank_latch') {
      // rank_latch derives metric 'rank' + value 1; a contradicting input is a bug.
      if (valuePrimary != null && valuePrimary !== 1) {
        return violate(prefix, 'VALUE_ARITY', `rank_latch pins value_primary=1, got ${valuePrimary}`, tag);
      }
      if (valueSecondary != null) {
        return violate(prefix, 'VALUE_ARITY', `rank_latch is arity-1, got secondary ${valueSecondary}`, tag);
      }
      if (metric !== null && metric !== 'rank') {
        return violate(prefix, 'ARCHETYPE_METRIC', `rank_latch pins metric 'rank', got ${metric}`, tag);
      }
      valuePrimary = 1;
      metric = 'rank';
    }

    // A cumulative count needs a MONOTONE_COUNT_UNITS unit (non-decreasing metrics), distinct from NONNEGATIVE_COUNT_UNITS.
    if (spec.archetype === 'cumulative_count') {
      if (valueUnit == null || !MONOTONE_COUNT_UNITS.has(valueUnit)) {
        return violate(prefix, 'CUMULATIVE_UNIT',
          `foldUnit(${String(spec.value?.unit)}) = ${String(valueUnit)} ∉ MONOTONE_COUNT_UNITS`, tag);
      }
    }

    if (spec.archetype === 'terminal_threshold'
        && !METRICLESS_THRESHOLD_KINDS.has(spec.eventKind)
        && (metric == null || !NUMERIC_METRICS.has(metric))) {
      return violate(prefix, 'ARCHETYPE_METRIC',
        `terminal_threshold requires a numeric metric, got ${String(metric)}`, tag);
    }
    if (spec.archetype === 'fixture_margin' && metric !== 'score') {
      return violate(prefix, 'ARCHETYPE_METRIC',
        `fixture_margin requires metric 'score', got ${String(metric)}`, tag);
    }

    // A 'percentage' metric requires the folded unit to be 'percent'.
    if (metric === 'percentage' && valueUnit !== 'percent') {
      return violate(prefix, 'UNIT_PERCENT',
        `metric 'percentage' requires folded unit 'percent', got ${String(valueUnit)}`, tag);
    }

    // A categorical slot needs its discriminator (the ConditionCard contract in types/pipeline.ts).
    if (spec.archetype === 'categorical_selection' &&
        (spec.outcomeLabel == null || spec.outcomeLabel.trim() === '')) {
      return violate(prefix, 'OUTCOME_LABEL',
        'categorical_selection requires a non-null outcome_label', tag);
    }
  }

  let conditionDate: string | null = null;
  let conditionDatePrecision: ConditionTuple['condition_date_precision'] = null;
  let conditionDateSource: string | null = null;
  let forceNull = false;
  let dateDeferred = false;
  if (spec.date === undefined) {
    dateDeferred = true;
  } else if ('forceNull' in spec.date) {
    forceNull = true;
  } else {
    conditionDate = spec.date.iso;
    conditionDatePrecision = spec.date.precision;
    conditionDateSource = spec.date.source;
  }

  const conditionValue = formatConditionValue(direction, valuePrimary, valueSecondary, valueUnit);

  return {
    event_kind: spec.eventKind,
    condition_shape: shape,
    condition_direction: direction,
    condition_metric: metric,
    condition_date: conditionDate,
    condition_date_precision: conditionDatePrecision,
    condition_date_source: conditionDateSource,
    condition_date_force_null: forceNull,
    date_deferred: dateDeferred,
    value_primary: valuePrimary,
    value_secondary: valueSecondary,
    value_unit: valueUnit,
    condition_value: conditionValue,
    metric_scope: spec.metricScope ?? null,
    temporal_semantics: temporal,
    outcome_label: spec.outcomeLabel ?? null,
  };
}

// Validate-only entry point: checks an already-built tuple, logs, never mutates. Warns become throws under EMIT_CONDITION_STRICT=1.
export function validateConditionTuple(
  norm: Pick<LLMMarketNormalization, 'condition_shape' | 'condition_direction' | 'condition_metric'
    | 'temporal_semantics' | 'value_primary' | 'value_secondary' | 'value_unit'
    | 'condition_date' | 'condition_date_precision'>,
  prefix: 'text-det' | 'kalshi-det' | 'llm-ingest',
  tag: string,
): void {
  const warn = (rule: string, detail: string): void => {
    const msg = `${rule}: ${detail} (${tag})`;
    if (strict()) throw new Error(`[${prefix}] ${msg}`);
    createLogger(prefix).warn(msg);
  };

  const shape = norm.condition_shape;
  const temporal = norm.temporal_semantics;
  if (shape && temporal && !SHAPE_TEMPORAL_VALID[shape].has(temporal)) {
    warn('Invalid shape×temporal', `${shape} + ${temporal}`);
  }

  // 'between' requires two finite bounds with lo < hi (null-direction pairs like exact-score are exempt).
  if (norm.condition_direction === 'between') {
    if (norm.value_primary == null || norm.value_secondary == null) {
      warn('VALUE_ARITY',
        `between requires two bounds, got ${String(norm.value_primary)}/${String(norm.value_secondary)}`);
    } else if (!(norm.value_primary < norm.value_secondary)) {
      warn('VALUE_ARITY', `between bounds must satisfy lo < hi, got ${norm.value_primary} >= ${norm.value_secondary}`);
    }
  }

  // percentage ⇒ folded unit 'percent'.
  if (norm.condition_metric === 'percentage' && foldUnit(norm.value_unit) !== 'percent') {
    warn('UNIT_PERCENT', `metric 'percentage' requires folded unit 'percent', got ${String(norm.value_unit)}`);
  }

  // "No date without precision" (ConditionDateSpec invariant, post-hoc form).
  if (norm.condition_date != null && norm.condition_date_precision == null) {
    warn('DATE_PRECISION', `condition_date ${norm.condition_date} carries no precision`);
  }
}

/**
 * Spreads a ConditionTuple into the TemplateMatch condition fields: a ported
 * template calls emitCondition inside its try* function and spreads this
 * result into its TemplateMatch literal — TemplateMatch itself is unchanged,
 * so unported templates and the central assembly site are untouched.
 *
 * Date three-state → existing template fields:
 *   deferred  → no date fields (the assembly chain derives via extractEventDate
 *               exactly as before);
 *   forceNull → condition_date_force_null: true;
 *   explicit  → condition_date_override (the assembly chain re-derives
 *               precision/source for overrides today, so ported templates
 *               should pass deferred/forceNull dates, matching their current
 *               behavior).
 */
export function tupleToTemplateFields(t: ConditionTuple): {
  condition_shape: ConditionShape;
  condition_direction: ConditionDirection | null;
  condition_metric: ConditionMetric | null;
  temporal_semantics: TemporalSemantics | null;
  value_primary: number | null;
  value_secondary: number | null;
  value_unit: string | null;
  event_kind: EventKind;
  outcome_label: string | null;
  metric_scope?: MetricScope | null;
  condition_date_override?: string | null;
  condition_date_force_null?: boolean;
} {
  const out: ReturnType<typeof tupleToTemplateFields> = {
    condition_shape: t.condition_shape,
    condition_direction: t.condition_direction,
    condition_metric: t.condition_metric,
    temporal_semantics: t.temporal_semantics,
    value_primary: t.value_primary,
    value_secondary: t.value_secondary,
    value_unit: t.value_unit,
    event_kind: t.event_kind,
    outcome_label: t.outcome_label,
  };
  if (t.metric_scope != null) out.metric_scope = t.metric_scope;
  if (t.condition_date_force_null) out.condition_date_force_null = true;
  else if (!t.date_deferred && t.condition_date != null) out.condition_date_override = t.condition_date;
  return out;
}
