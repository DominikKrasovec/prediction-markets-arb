/**
 * LLM ingestion door — date post-coercion to the padded-start + precision
 * storage convention, and the warn-and-pass validateConditionTuple wiring
 * exercised through guardLLMNormalization.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { LLMMarketNormalization } from '@arb/types';
import { coerceLLMConditionDate, guardLLMNormalization } from './llm-ingestion-guard.js';

const savedStrict = process.env['EMIT_CONDITION_STRICT'];
beforeEach(() => { delete process.env['EMIT_CONDITION_STRICT']; });
afterEach(() => {
  if (savedStrict === undefined) delete process.env['EMIT_CONDITION_STRICT'];
  else process.env['EMIT_CONDITION_STRICT'] = savedStrict;
});

describe('coerceLLMConditionDate — missing precision derived from ISO shape', () => {
  test('YYYY → year + padded start', () => {
    const r = coerceLLMConditionDate('2026', null);
    expect(r.date).toBe('2026-01-01');
    expect(r.precision).toBe('year');
    expect(r.violation).toBe(false);
    expect(r.note).toContain('derived');
  });

  test('YYYY-MM → month + padded start', () => {
    const r = coerceLLMConditionDate('2026-03', null);
    expect(r.date).toBe('2026-03-01');
    expect(r.precision).toBe('month');
    expect(r.violation).toBe(false);
  });

  test('full date → day, date unchanged', () => {
    const r = coerceLLMConditionDate('2026-04-15', null);
    expect(r.date).toBe('2026-04-15');
    expect(r.precision).toBe('day');
    expect(r.violation).toBe(false);
  });

  test('time-bearing ISO → day, date byte-identical', () => {
    const r = coerceLLMConditionDate('2026-04-15T19:00:00Z', null);
    expect(r.date).toBe('2026-04-15T19:00:00Z');
    expect(r.precision).toBe('day');
  });

  test('unparseable text passes through untouched (validator warns downstream)', () => {
    const r = coerceLLMConditionDate('soon', null);
    expect(r.date).toBe('soon');
    expect(r.precision).toBeNull();
    expect(r.note).toBeNull();
  });
});

describe('coerceLLMConditionDate — period-END / interior date with coarse precision', () => {
  test("'2026-12-31' + year → padded start, logged violation", () => {
    const r = coerceLLMConditionDate('2026-12-31', 'year');
    expect(r.date).toBe('2026-01-01');
    expect(r.precision).toBe('year');
    expect(r.violation).toBe(true);
    expect(r.note).toContain('convention, not data loss');
  });

  test("'2026-06-15' + year (interior day) → padded start", () => {
    const r = coerceLLMConditionDate('2026-06-15', 'year');
    expect(r.date).toBe('2026-01-01');
    expect(r.precision).toBe('year');
    expect(r.violation).toBe(true);
  });

  test("'2026-03-31' + month → padded month start", () => {
    const r = coerceLLMConditionDate('2026-03-31', 'month');
    expect(r.date).toBe('2026-03-01');
    expect(r.precision).toBe('month');
    expect(r.violation).toBe(true);
  });

  test("'2026-03-15T19:00:00Z' + month → padded month start (time stripped)", () => {
    const r = coerceLLMConditionDate('2026-03-15T19:00:00Z', 'month');
    expect(r.date).toBe('2026-03-01');
    expect(r.precision).toBe('month');
    expect(r.violation).toBe(true);
  });
});

describe('coerceLLMConditionDate — convention-conformant stamps pass byte-identical', () => {
  test('padded year start + year', () => {
    const r = coerceLLMConditionDate('2026-01-01', 'year');
    expect(r.date).toBe('2026-01-01');
    expect(r.precision).toBe('year');
    expect(r.note).toBeNull();
  });

  test('padded start with zero-time suffix + year (deterministic stamp style)', () => {
    const r = coerceLLMConditionDate('2026-01-01T00:00:00Z', 'year');
    expect(r.date).toBe('2026-01-01T00:00:00Z');
    expect(r.precision).toBe('year');
    expect(r.note).toBeNull();
  });

  test('padded month start + month', () => {
    const r = coerceLLMConditionDate('2026-03-01', 'month');
    expect(r.date).toBe('2026-03-01');
    expect(r.note).toBeNull();
  });

  test('day stamp + day', () => {
    const r = coerceLLMConditionDate('2026-04-15', 'day');
    expect(r.date).toBe('2026-04-15');
    expect(r.note).toBeNull();
  });

  test('time-bearing stamp + minute', () => {
    const r = coerceLLMConditionDate('2026-04-15T19:30:00Z', 'minute');
    expect(r.date).toBe('2026-04-15T19:30:00Z');
    expect(r.precision).toBe('minute');
    expect(r.note).toBeNull();
  });
});

describe('coerceLLMConditionDate — ISO shape coarser than the claimed precision: shape wins', () => {
  test("'2026' + day → year + padded start", () => {
    const r = coerceLLMConditionDate('2026', 'day');
    expect(r.date).toBe('2026-01-01');
    expect(r.precision).toBe('year');
    expect(r.violation).toBe(true);
  });

  test("'2026-06' + day → month + padded start", () => {
    const r = coerceLLMConditionDate('2026-06', 'day');
    expect(r.date).toBe('2026-06-01');
    expect(r.precision).toBe('month');
    expect(r.violation).toBe(true);
  });

  test("'2026' + month → year wins", () => {
    const r = coerceLLMConditionDate('2026', 'month');
    expect(r.date).toBe('2026-01-01');
    expect(r.precision).toBe('year');
  });

  test('bare day ISO + minute → day (no time to back the claim)', () => {
    const r = coerceLLMConditionDate('2026-04-15', 'minute');
    expect(r.date).toBe('2026-04-15');
    expect(r.precision).toBe('day');
    expect(r.violation).toBe(true);
  });
});

describe('coerceLLMConditionDate — null handling', () => {
  test('null date, null precision — pass', () => {
    const r = coerceLLMConditionDate(null, null);
    expect(r.date).toBeNull();
    expect(r.precision).toBeNull();
    expect(r.note).toBeNull();
  });

  test('null date with a stray precision — precision dropped', () => {
    const r = coerceLLMConditionDate(null, 'day');
    expect(r.date).toBeNull();
    expect(r.precision).toBeNull();
    expect(r.violation).toBe(true);
  });
});

// guardLLMNormalization — the chokepoint wrapper.

function norm(over: Partial<LLMMarketNormalization>): LLMMarketNormalization {
  return {
    market_id: 1,
    canonical_subject: 'BTC',
    condition_value: null,
    condition_date: null,
    canonical_event: 'btc price snapshot',
    outcome_label: null,
    resolved_entities: [],
    resolution_source: null,
    confidence: 0.9,
    condition_shape: 'point_in_time',
    condition_direction: 'above',
    condition_metric: 'price',
    metric_scope: null,
    temporal_semantics: 'on_date',
    value_primary: 100000,
    value_secondary: null,
    value_unit: 'USD',
    participants: ['BTC'],
    category_unified: 'crypto',
    ...over,
  } as LLMMarketNormalization;
}

describe('guardLLMNormalization', () => {
  test('coerces a fabricated period-END stamp to padded start (new object, input untouched)', () => {
    const input = norm({ condition_date: '2026-12-31', condition_date_precision: 'year' });
    const out = guardLLMNormalization(input);
    expect(out).not.toBe(input);
    expect(out.condition_date).toBe('2026-01-01');
    expect(out.condition_date_precision).toBe('year');
    expect(input.condition_date).toBe('2026-12-31'); // pure
  });

  test('derives missing precision from a truncated-ISO stamp', () => {
    const out = guardLLMNormalization(norm({ condition_date: '2026-03' }));
    expect(out.condition_date).toBe('2026-03-01');
    expect(out.condition_date_precision).toBe('month');
  });

  test('convention-conformant row passes through as the same object', () => {
    const input = norm({ condition_date: '2026-04-15', condition_date_precision: 'day' });
    expect(guardLLMNormalization(input)).toBe(input);
  });

  test('warn-and-pass: an invalid shape×temporal pair does NOT throw outside strict', () => {
    const input = norm({ condition_shape: 'point_in_time', temporal_semantics: 'during_period' });
    expect(() => guardLLMNormalization(input)).not.toThrow();
  });

  test('strict mode: the door throws on an invalid shape×temporal pair', () => {
    process.env['EMIT_CONDITION_STRICT'] = '1';
    const input = norm({ condition_shape: 'point_in_time', temporal_semantics: 'during_period' });
    expect(() => guardLLMNormalization(input)).toThrow(/Invalid shape×temporal/);
  });

  test('strict mode: date coercion runs BEFORE the validator, so a coerced date carries its precision', () => {
    process.env['EMIT_CONDITION_STRICT'] = '1';
    // Truncated ISO + no precision would DATE_PRECISION-throw if the validator
    // saw the raw input; the coercion deriving (month + padded start) first
    // means the row passes.
    const input = norm({ condition_date: '2026-03' });
    expect(() => guardLLMNormalization(input)).not.toThrow();
  });
});
