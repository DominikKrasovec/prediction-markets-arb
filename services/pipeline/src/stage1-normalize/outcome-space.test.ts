/**
 * Tests for the deterministic event-group → outcome_space mapping used by
 * Stage 1a featurization. The mapping is intentionally narrow: only the two
 * unambiguous grouping types translate to non-binary, everything else is
 * binary. See outcome-space.ts header for the LLM-write-back follow-up.
 */
import { describe, test, expect } from 'bun:test';
import { deriveOutcomeSpace } from './outcome-space.js';

describe('deriveOutcomeSpace', () => {
  test('categorical_exclusive → categorical (mutex over named outcomes)', () => {
    expect(deriveOutcomeSpace('categorical_exclusive')).toBe('categorical');
  });

  test('threshold_series → numeric (ladder of YES/NO thresholds)', () => {
    expect(deriveOutcomeSpace('threshold_series')).toBe('numeric');
  });

  test('bundle_nonexclusive → binary (sibling markets but each YES/NO)', () => {
    expect(deriveOutcomeSpace('bundle_nonexclusive')).toBe('binary');
  });

  test('unknown grouping → binary (cannot prove non-binary)', () => {
    expect(deriveOutcomeSpace('unknown')).toBe('binary');
  });

  test('null grouping (orphan market, no event) → binary', () => {
    expect(deriveOutcomeSpace(null)).toBe('binary');
  });

  test('undefined grouping → binary (defensive — older rows lacked the field)', () => {
    // SyncedMarket.grouping_type is typed `... | null`, but featurizeMarket is
    // called from contexts that may construct partial market shapes; the
    // helper must treat undefined the same as null rather than throwing.
    expect(deriveOutcomeSpace(undefined as any)).toBe('binary');
  });
});
