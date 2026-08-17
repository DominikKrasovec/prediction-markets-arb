/**
 * never-same-kind pair rejecter. Locks the validated ship pairs (order-
 * independent), the deliberately-excluded cells (championship_winner×
 * player_prop_threshold has a real merge), and the NULL-kind defer behavior.
 * Contains-based assertions only (concurrent packages may append pairs).
 */
import { describe, test, expect } from 'bun:test';
import {
  isNeverSameKindPair, neverSameKindTag, NEVER_SAME_KIND_PAIRS,
} from './never-same-kind-pairs.js';

describe('isNeverSameKindPair (F1 ship set)', () => {
  test('the 3 validated pairs fire, in BOTH orders', () => {
    const pairs: [string, string][] = [
      ['both_teams_score', 'match_winner'],
      ['exact_score', 'match_total_metric'],
      ['championship_winner', 'match_winner'],
    ];
    for (const [a, b] of pairs) {
      expect(isNeverSameKindPair(a, b)).toBe(true);
      expect(isNeverSameKindPair(b, a)).toBe(true); // order-independent
    }
  });

  test('deliberately EXCLUDED cells never fire (real-merge / thin-evidence)', () => {
    // championship_winner × player_prop_threshold has a real merge, so it stays a dead cell.
    expect(isNeverSameKindPair('championship_winner', 'player_prop_threshold')).toBe(false);
    // thin (<20 decided) deferred cells
    expect(isNeverSameKindPair('award_winner', 'championship_winner')).toBe(false);
    expect(isNeverSameKindPair('championship_winner', 'election_outcome_winner')).toBe(false);
    // near-miss pairs the round-2 matrix showed as REAL merges (not gated)
    expect(isNeverSameKindPair('exact_score', 'match_winner')).toBe(false);
    expect(isNeverSameKindPair('match_total_metric', 'match_winner')).toBe(false);
  });

  test('same-kind and unrelated pairs never fire', () => {
    expect(isNeverSameKindPair('match_winner', 'match_winner')).toBe(false);
    expect(isNeverSameKindPair('match_winner', 'weather_extreme')).toBe(false);
  });

  test('a NULL kind (unshaped side) defers — never rejects on a coarse key', () => {
    expect(isNeverSameKindPair(null, 'match_winner')).toBe(false);
    expect(isNeverSameKindPair('both_teams_score', null)).toBe(false);
    expect(isNeverSameKindPair(null, null)).toBe(false);
  });

  test('the ship set contains exactly the 3 validated pairs', () => {
    expect(NEVER_SAME_KIND_PAIRS.size).toBe(3);
  });
});

describe('neverSameKindTag', () => {
  test('distinct, order-normalized per-cell reason tag', () => {
    expect(neverSameKindTag('match_winner', 'both_teams_score'))
      .toBe(neverSameKindTag('both_teams_score', 'match_winner'));
    expect(neverSameKindTag('both_teams_score', 'match_winner'))
      .toContain('both_teams_score×match_winner');
    expect(neverSameKindTag('exact_score', 'match_total_metric')).toContain('exact_score×match_total_metric');
  });
});
