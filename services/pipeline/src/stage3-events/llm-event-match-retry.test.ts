/**
 * Retry/self-heal pure unit tests (no DB). The transient-failure re-queue is
 * pure recall recovery: a re-armed candidate re-enters the identical
 * deterministic gate (validateMatch), so it can never create a fake arb. These
 * tests pin the state-machine boundary and the sentinel collision-freedom that
 * makes the self-heal re-arm safe (guard rejects must stay terminal).
 */
import { test, expect } from 'bun:test';
import {
  nextTransientStatus, TRANSIENT_SENTINELS,
  requeueSalvageableFailedSql, SALVAGEABLE_FAILURE_LIKE_PATTERNS,
} from '../db/queries/semantic-events.js';

// State-machine boundary — re-queue while retry_count < N, terminal at N.
test('nextTransientStatus re-queues below the bound, fails at/above it', () => {
  expect(nextTransientStatus(0, 3)).toBe('pending');
  expect(nextTransientStatus(2, 3)).toBe('pending'); // last retry still re-queues
  expect(nextTransientStatus(3, 3)).toBe('failed');   // boundary → terminal
  expect(nextTransientStatus(4, 3)).toBe('failed');
});

test('nextTransientStatus honors a custom maxRetries', () => {
  expect(nextTransientStatus(0, 1)).toBe('pending');
  expect(nextTransientStatus(1, 1)).toBe('failed');
  expect(nextTransientStatus(0, 0)).toBe('failed'); // no retries → immediately terminal
});

// Sentinel exclusivity — a guard reject's reasoning ends with ']' (carries a
// '[reason]' suffix), so the two bare sentinels never equal a guard reject and the
// self-heal re-arm (exact equality) cannot resurrect a sound rejection.
test('transient sentinels never look like a guard reject (no trailing ])', () => {
  for (const s of TRANSIENT_SENTINELS) {
    expect(s.endsWith(']')).toBe(false);
    expect(s.includes('[')).toBe(false);
  }
});

test('transient sentinels are exactly the two known transient reasons', () => {
  expect([...TRANSIENT_SENTINELS].sort()).toEqual(['LLM returned no JSON', 'platform_event row missing']);
});

// Salvageable-failed re-queue (no-DB string invariants).

test('W2-R1 requeue SQL: bounded pending re-arm of failed rows only', () => {
  const sql = requeueSalvageableFailedSql();
  expect(sql).toContain(`status = 'failed'`);
  expect(sql).toContain('retry_count < $1');
  expect(sql).toContain(`SET status = 'pending', retry_count = retry_count + 1`);
  // every salvageable pattern is in the WHERE, plus the bare no-JSON sentinel.
  for (const p of SALVAGEABLE_FAILURE_LIKE_PATTERNS) {
    expect(sql).toContain(`llm_reasoning LIKE '${p}'`);
  }
  expect(sql).toContain(`llm_reasoning = 'LLM returned no JSON'`);
  // NOT salvageable: collapsed-partition stays terminal (guard unchanged).
  expect(sql).not.toContain('collapsed partition');
});

/** Minimal SQL-LIKE evaluator (patterns use only the % wildcard) — verifies the
 *  patterns against live-shaped llm_reasoning strings without a DB. */
function likeMatch(pattern: string, s: string): boolean {
  const rx = new RegExp(
    '^' + pattern.split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*') + '$',
  );
  return rx.test(s);
}
const matchesAnySalvageable = (s: string): boolean =>
  SALVAGEABLE_FAILURE_LIKE_PATTERNS.some((p) => likeMatch(p, s)) || s === 'LLM returned no JSON';

test('W2-R1 salvage patterns match exactly the live failure-class shapes', () => {
  // POSITIVE: the four guard classes the new guards can salvage (live row shapes).
  expect(matchesAnySalvageable(
    'Both events refer to the same halftime show [outcome "kendrick_lamar" has no leg (phantom outcome)]',
  )).toBe(true);
  expect(matchesAnySalvageable(
    'Same fixture [outcome_subject "both teams to score" shared by outcomes "btts" and "both_teams_to_score"]',
  )).toBe(true);
  expect(matchesAnySalvageable(
    'Same event [outcome_subject "belgium" claimed by two outcomes "belgium" and "belgium_win" across the expansion union — duplicate winner / double-mapped Σ=1 slot]',
  )).toBe(true);
  expect(matchesAnySalvageable(
    'Same launch [market_id 123 already bound to outcome "above_50M" but the new pair binds it to "fdv_above_50m" — double-mapped market across the expansion union]',
  )).toBe(true);
  expect(matchesAnySalvageable('LLM returned no JSON')).toBe(true);
});

test('W2-R1 salvage patterns do NOT re-arm terminal / deterministic rejects', () => {
  // collapsed partition: guard unchanged — retrying is pure waste.
  expect(matchesAnySalvageable(
    'Collapsed [single outcome but platform "polymarket" has 3 child markets (collapsed partition?)]',
  )).toBe(false);
  // A phantom reject carrying a ' — … rejected' tail is a deterministic
  // re-reject and must not be re-armed (the tail breaks the ']'-anchored phantom pattern).
  expect(matchesAnySalvageable(
    'x [outcome "draw" has no leg (phantom outcome) — degenerate 2-outcome set, rejected]',
  )).toBe(false);
  expect(matchesAnySalvageable(
    'x [outcome "d" has no leg (phantom outcome) — surviving leg kind "match_winner" is a one-hot fixture partition (negRisk Σ=1 arm), not demotable, rejected]',
  )).toBe(false);
  // sound guard rejects stay terminal.
  expect(matchesAnySalvageable(
    'w [weather station mismatch: station "laguardia" vs city-generic report on kalshi — station unproven-same (NYC Central-Park-vs-LaGuardia class)]',
  )).toBe(false);
  expect(matchesAnySalvageable(
    't [threshold_series spans 2 distinct subjects [o1, probable] — cross-subject over-merge]',
  )).toBe(false);
  // bare transient sentinel variants that are NOT the exact no-JSON string.
  expect(matchesAnySalvageable('platform_event row missing')).toBe(false);
});
