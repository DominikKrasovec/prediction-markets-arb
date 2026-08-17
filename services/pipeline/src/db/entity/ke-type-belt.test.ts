/**
 * Pure unit tests for the KB-type belt predicates in register.ts:
 * `isKeTypeConflict` (rule-bug signal) and `isKeUnknownWildcardMerge`
 * (wildcard-reliance counter). DB-free — they gate the two counters fired
 * inside `pickBridgeCandidate`.
 */
import { describe, test, expect } from 'bun:test';
import { isKeTypeConflict, isKeUnknownWildcardMerge } from './register.js';

describe('isKeTypeConflict', () => {
  test('fires when a rule-typed incoming is domain+scope-compatible but concrete types disagree', () => {
    // e.g. rule types "Chicago" team, an existing scope-compatible "Chicago"
    // location — a would-be bridge refused on type: a rule/KB disagreement.
    expect(isKeTypeConflict('team', 'location', true, true, false)).toBe(true);
  });
  test('does NOT fire when the incoming was not rule-typed', () => {
    expect(isKeTypeConflict('team', 'location', false, true, false)).toBe(false);
  });
  test('does NOT fire when scope is incompatible (legitimately-separate scoped entities)', () => {
    // soccer Rodrigues (team) vs tennis Rodrigues (person) — different sport →
    // scopeIncompatible → NOT a conflict.
    expect(isKeTypeConflict('team', 'person', true, true, true)).toBe(false);
  });
  test('does NOT fire when either side is the unknown wildcard', () => {
    expect(isKeTypeConflict('unknown', 'team', true, true, false)).toBe(false);
    expect(isKeTypeConflict('team', 'unknown', true, true, false)).toBe(false);
  });
  test('does NOT fire when the types agree', () => {
    expect(isKeTypeConflict('team', 'team', true, true, false)).toBe(false);
  });
  test('does NOT fire when domains are incompatible', () => {
    expect(isKeTypeConflict('team', 'person', true, false, false)).toBe(false);
  });
});

describe('isKeUnknownWildcardMerge', () => {
  test('true when exactly one side is unknown and the types differ', () => {
    expect(isKeUnknownWildcardMerge('unknown', 'team')).toBe(true);
    expect(isKeUnknownWildcardMerge('person', 'unknown')).toBe(true);
  });
  test('false when the types match (an exact-type merge, not wildcard-reliant)', () => {
    expect(isKeUnknownWildcardMerge('team', 'team')).toBe(false);
    expect(isKeUnknownWildcardMerge('unknown', 'unknown')).toBe(false);
  });
  test('false when both sides are concrete and differ (that is a type conflict, not a wildcard merge)', () => {
    expect(isKeUnknownWildcardMerge('team', 'person')).toBe(false);
  });
});
