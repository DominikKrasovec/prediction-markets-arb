/**
 * Single source of truth for valid (condition_shape × temporal_semantics)
 * pairings across both deterministic templates and LLM extractions.
 *
 * Reflects what the templates actually emit + what is semantically defensible:
 *
 *  - `monotonic_threshold + during_period` — sports O/U totals (text-det L/H/T)
 *    and Kalshi player-stat templates.
 *  - `binary_event + on_date` — crypto candle direction ("BTC Up or Down —
 *    May 10, 2PM ET") and weather-equals-N-on-date.
 *  - `range_snapshot + during_period` — cumulative count in a range over a
 *    window (Polymarket "Elon Musk 360–379 tweets May 1–7").
 *
 * `warnShapePair` is a runtime guard used by deterministic templates to flag
 * regressions: anything outside this set logs a warning at emission time.
 *
 * `correctLLMTemporal` is the LLM-output sanity check. Trusts the LLM when
 * its pair is already in the map; otherwise replaces with the canonical
 * default for that shape. Deterministic emissions never pass through it.
 */
import type { ConditionShape, TemporalSemantics } from '@arb/types';
import { createLogger } from '@arb/logger';

export const SHAPE_TEMPORAL_VALID:
  Record<ConditionShape, ReadonlySet<TemporalSemantics>> = {
    monotonic_threshold:  new Set(['by_date', 'at_resolution', 'during_period']),
    range_snapshot:       new Set(['on_date', 'during_period']),
    // point_in_time deliberately excludes during_period: sub-period snapshots
    // (1H spread, F5 spread) stamp at_resolution + a metric_scope
    // discriminator (half_1/first_5), never during_period.
    point_in_time:        new Set(['on_date', 'at_resolution']),
    cumulative_deadline:  new Set(['by_date']),
    binary_event:         new Set(['by_date', 'during_period', 'at_resolution', 'on_date']),
    // during_period is included for the barrier-race class: "which price
    // barrier breaks first during the window" is a legitimate
    // path-dependent categorical.
    categorical_outcome:  new Set(['at_resolution', 'during_period']),
  };

/**
 * Per-shape canonical temporal used when an LLM emits a pair outside the map.
 * Picked as the most common / semantically safest default for that shape.
 */
const DEFAULT_TEMPORAL: Record<ConditionShape, TemporalSemantics> = {
  monotonic_threshold:  'by_date',
  range_snapshot:       'on_date',
  point_in_time:        'on_date',
  cumulative_deadline:  'by_date',
  binary_event:         'at_resolution',
  categorical_outcome:  'at_resolution',
};

/**
 * Runtime guard: log a warning when a deterministic template emits a
 * shape×temporal pair outside the unified set. No-op when either side is null
 * (several templates legitimately emit `binary_event + null`).
 *
 * `prefix` is the log tag (e.g. `'text-det'`, `'kalshi-det'`); `tag` is the
 * per-call source-template identifier.
 */
export function warnShapePair(
  shape: ConditionShape | null,
  temporal: TemporalSemantics | null,
  prefix: string,
  tag: string,
): void {
  if (!shape || !temporal) return;
  const allowed = SHAPE_TEMPORAL_VALID[shape];
  if (!allowed.has(temporal)) {
    createLogger(prefix).warn(`Invalid shape×temporal: ${shape} + ${temporal} (${tag})`);
  }
}

/**
 * Coerce an LLM-produced (shape, temporal) pair to the unified table.
 *
 *   - Pair already in the map → unchanged.
 *   - Pair outside the map    → replaced with `DEFAULT_TEMPORAL[shape]`.
 *
 * One uniform rule, no per-shape carve-outs. The deterministic engine bypasses
 * this entirely; it reports via `warnShapePair` only.
 */
export function correctLLMTemporal(
  shape: ConditionShape,
  temporal: TemporalSemantics,
): TemporalSemantics {
  return SHAPE_TEMPORAL_VALID[shape].has(temporal)
    ? temporal
    : DEFAULT_TEMPORAL[shape];
}
