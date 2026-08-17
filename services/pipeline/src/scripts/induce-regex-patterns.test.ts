/**
 * Tests for the induce-regex validation gates:
 *   - looksCatastrophic — ReDoS screen for nested/adjacent unbounded quantifiers
 *   - computeCapturedValue — reproduces value_primary from a match via field_mapping
 *   - isAccepted — adoption gate on recall + precision + capture-correctness
 */
import { describe, test, expect } from 'bun:test';
import { looksCatastrophic, computeCapturedValue, isAccepted } from './induce-regex-patterns.js';

describe('looksCatastrophic', () => {
  test('flags nested unbounded quantifiers', () => {
    expect(looksCatastrophic('(a+)+')).toBe(true);
    expect(looksCatastrophic('(.*)*')).toBe(true);
    expect(looksCatastrophic('(?:\\d+)*')).toBe(true);
    expect(looksCatastrophic('^(\\w+\\s?)+$')).toBe(true);
  });
  test('passes well-formed anchored templates', () => {
    expect(looksCatastrophic('^(?<asset>[A-Z]{2,6})\\s+above\\s+\\$?(?<value>[\\d,]+)$')).toBe(false);
    expect(looksCatastrophic('^(?<name>.+?),\\s*[≥>]=?\\s*(?<value>\\d+)%$')).toBe(false);
  });
});

describe('computeCapturedValue', () => {
  test('strips thousands separators', () => {
    expect(computeCapturedValue({ value: '340,000' }, { value_primary_raw: 'value' }, undefined)).toBe(340000);
  });
  test('applies a K/M/B multiplier from value_unit_post via the unit group', () => {
    expect(computeCapturedValue(
      { value: '340', unit: 'K' },
      { value_primary_raw: 'value', value_unit_group: 'unit' },
      { K: 1000, M: 1_000_000 },
    )).toBe(340000);
  });
  test('keeps decimals (spread/threshold lines)', () => {
    expect(computeCapturedValue({ value: '2.5' }, { value_primary_raw: 'value' }, undefined)).toBe(2.5);
  });
  test('returns null when the mapping extracts no value (e.g. binary_event)', () => {
    expect(computeCapturedValue({ verb: 'above' }, { subject_raw: 'asset' }, undefined)).toBeNull();
    expect(computeCapturedValue({ value: undefined }, { value_primary_raw: 'value' }, undefined)).toBeNull();
  });
});

describe('isAccepted', () => {
  const base = {
    recall: 0.8, precision: 1, matchedExamples: 80, totalExamples: 100,
    matchedNegatives: 0, totalNegatives: 5, capturedFields: {},
    valueChecked: 50, valueCorrect: 50, valueAccuracy: 1, errors: [] as string[],
  };
  test('accepts a clean, value-correct regex', () => {
    expect(isAccepted(base)).toBe(true);
  });
  test('rejects when capture-correctness is low even if match is perfect', () => {
    expect(isAccepted({ ...base, recall: 1, precision: 1, valueAccuracy: 0.5 })).toBe(false);
  });
  test('rejects on low precision (matches negatives)', () => {
    expect(isAccepted({ ...base, precision: 0.8 })).toBe(false);
  });
  test('rejects on validation timeout', () => {
    expect(isAccepted({ ...base, errors: ['validation_timeout'] })).toBe(false);
  });
  test('rejects null', () => {
    expect(isAccepted(null)).toBe(false);
  });
});
