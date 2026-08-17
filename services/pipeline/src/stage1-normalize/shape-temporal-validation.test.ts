/**
 * Tests for the unified shape×temporal validation map.
 *
 * Single source of truth: the deterministic templates and the LLM extraction
 * schema both pair against `SHAPE_TEMPORAL_VALID`. The map admits combos that
 * the templates actually emit (e.g. `monotonic_threshold + during_period` for
 * sports O/U, `binary_event + on_date` for crypto candle direction).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  SHAPE_TEMPORAL_VALID,
  correctLLMTemporal,
  warnShapePair,
} from './shape-temporal-validation.js';
import type { ConditionShape, TemporalSemantics } from '@arb/types';

describe('SHAPE_TEMPORAL_VALID — unified pairing table', () => {
  test('monotonic_threshold: by_date | at_resolution | during_period', () => {
    const allowed = SHAPE_TEMPORAL_VALID.monotonic_threshold;
    expect(allowed.has('by_date')).toBe(true);
    expect(allowed.has('at_resolution')).toBe(true);
    expect(allowed.has('during_period')).toBe(true);
    expect(allowed.has('on_date')).toBe(false);
  });

  test('range_snapshot: on_date | during_period', () => {
    const allowed = SHAPE_TEMPORAL_VALID.range_snapshot;
    expect(allowed.has('on_date')).toBe(true);
    // text-det Template V emits range_snapshot + during_period for cumulative
    // count-in-range markets (Polymarket "Elon Musk 360–379 tweets May 1–7").
    expect(allowed.has('during_period')).toBe(true);
    expect(allowed.has('by_date')).toBe(false);
    expect(allowed.has('at_resolution')).toBe(false);
  });

  test('point_in_time: on_date | at_resolution', () => {
    const allowed = SHAPE_TEMPORAL_VALID.point_in_time;
    expect(allowed.has('on_date')).toBe(true);
    expect(allowed.has('at_resolution')).toBe(true);
    expect(allowed.has('by_date')).toBe(false);
    expect(allowed.has('during_period')).toBe(false);
  });

  test('cumulative_deadline: by_date only', () => {
    expect(SHAPE_TEMPORAL_VALID.cumulative_deadline.size).toBe(1);
    expect(SHAPE_TEMPORAL_VALID.cumulative_deadline.has('by_date')).toBe(true);
  });

  test('binary_event: by_date | during_period | at_resolution | on_date', () => {
    const allowed = SHAPE_TEMPORAL_VALID.binary_event;
    expect(allowed.has('by_date')).toBe(true);
    expect(allowed.has('during_period')).toBe(true);
    expect(allowed.has('at_resolution')).toBe(true);
    // text-det Template N emits binary_event + on_date for crypto candle
    // direction ("BTC Up or Down — May 10, 2:00PM ET") and weather-equals-N.
    expect(allowed.has('on_date')).toBe(true);
  });

  test('categorical_outcome: at_resolution + during_period (P9 A3 barrier-race)', () => {
    // during_period added deliberately: "which barrier breaks FIRST during
    // the window" is a legitimate path-dependent categorical. The
    // PIT x during_period exclusion is a separate pin.
    expect(SHAPE_TEMPORAL_VALID.categorical_outcome.size).toBe(2);
    expect(SHAPE_TEMPORAL_VALID.categorical_outcome.has('at_resolution')).toBe(true);
    expect(SHAPE_TEMPORAL_VALID.categorical_outcome.has('during_period')).toBe(true);
  });
});

describe('warnShapePair', () => {
  let warnSpy: ReturnType<typeof spyOn<typeof console, 'warn'>>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('does not warn on valid pairs', () => {
    warnShapePair('monotonic_threshold', 'by_date', 'text-det', 'template-A');
    warnShapePair('monotonic_threshold', 'during_period', 'text-det', 'template-L');
    warnShapePair('range_snapshot', 'on_date', 'text-det', 'template-P');
    warnShapePair('range_snapshot', 'during_period', 'text-det', 'template-V');
    warnShapePair('point_in_time', 'at_resolution', 'text-det', 'template-Q');
    warnShapePair('cumulative_deadline', 'by_date', 'text-det', 'template-D');
    warnShapePair('binary_event', 'on_date', 'text-det', 'template-N');
    warnShapePair('binary_event', 'at_resolution', 'kalshi-det', 'kalshi:parlay:mve');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('warns on invalid pairs with the correct prefix', () => {
    warnShapePair('range_snapshot', 'by_date', 'text-det', 'bad-A');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const joined = warnSpy.mock.calls[0].map((a) => String(a)).join(' ');
    expect(joined).toContain('text-det');
    expect(joined).toContain('range_snapshot');
    expect(joined).toContain('by_date');
    expect(joined).toContain('bad-A');
  });

  test('warns on point_in_time + during_period (the Template M bug pattern)', () => {
    warnShapePair('point_in_time', 'during_period', 'text-det', 'template-M');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('null shape or null temporal is a no-op', () => {
    warnShapePair(null, 'by_date', 'text-det', 'x');
    warnShapePair('monotonic_threshold', null, 'text-det', 'x');
    warnShapePair(null, null, 'text-det', 'x');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('correctLLMTemporal', () => {
  test('valid pairs pass through unchanged', () => {
    expect(correctLLMTemporal('monotonic_threshold', 'by_date')).toBe('by_date');
    expect(correctLLMTemporal('monotonic_threshold', 'during_period')).toBe('during_period');
    expect(correctLLMTemporal('monotonic_threshold', 'at_resolution')).toBe('at_resolution');
    expect(correctLLMTemporal('range_snapshot', 'on_date')).toBe('on_date');
    expect(correctLLMTemporal('range_snapshot', 'during_period')).toBe('during_period');
    expect(correctLLMTemporal('point_in_time', 'on_date')).toBe('on_date');
    expect(correctLLMTemporal('point_in_time', 'at_resolution')).toBe('at_resolution');
    expect(correctLLMTemporal('cumulative_deadline', 'by_date')).toBe('by_date');
    expect(correctLLMTemporal('binary_event', 'by_date')).toBe('by_date');
    expect(correctLLMTemporal('binary_event', 'during_period')).toBe('during_period');
    expect(correctLLMTemporal('binary_event', 'at_resolution')).toBe('at_resolution');
    expect(correctLLMTemporal('binary_event', 'on_date')).toBe('on_date');
    expect(correctLLMTemporal('categorical_outcome', 'at_resolution')).toBe('at_resolution');
  });

  test('invalid pairs fall back to the shape default', () => {
    // monotonic_threshold has on_date as schema-invalid → default by_date.
    expect(correctLLMTemporal('monotonic_threshold', 'on_date')).toBe('by_date');
    // point_in_time + during_period (the Template M bug) → default on_date.
    expect(correctLLMTemporal('point_in_time', 'during_period')).toBe('on_date');
    // point_in_time + by_date → default on_date.
    expect(correctLLMTemporal('point_in_time', 'by_date')).toBe('on_date');
    // range_snapshot + by_date → default on_date.
    expect(correctLLMTemporal('range_snapshot', 'by_date')).toBe('on_date');
    // cumulative_deadline always force-resolves to by_date.
    expect(correctLLMTemporal('cumulative_deadline', 'on_date')).toBe('by_date');
    expect(correctLLMTemporal('cumulative_deadline', 'during_period')).toBe('by_date');
    // categorical_outcome always force-resolves to at_resolution.
    expect(correctLLMTemporal('categorical_outcome', 'by_date')).toBe('at_resolution');
    expect(correctLLMTemporal('categorical_outcome', 'on_date')).toBe('at_resolution');
    // during_period is now IN-table for categorical (A3) — passes through.
    expect(correctLLMTemporal('categorical_outcome', 'during_period')).toBe('during_period');
  });
});
