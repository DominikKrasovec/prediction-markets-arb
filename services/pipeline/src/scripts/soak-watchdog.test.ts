/**
 * Pure unit tests for the soak-watchdog check core. No DB, no filesystem — every
 * evaluator takes already-fetched numbers (the shape `main()` builds from mocked
 * query rows) and returns a CheckResult. Covers each of the six checks plus the
 * previous-state log parser and the status assembler.
 */
import { test, expect } from 'bun:test';
import {
  GB,
  evaluateHeartbeat,
  evaluateLoopProgress,
  evaluateLlmCost,
  evaluateDbSize,
  evaluateQueueDepth,
  evaluateWallClockGap,
  parsePrevState,
  buildStatus,
  type CheckResult,
} from './soak-watchdog.js';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');

// ─── 2. daemon_heartbeat ────────────────────────────────────────────────────

test('heartbeat fresh within max age → ok', () => {
  const r = evaluateHeartbeat({ beatAtMs: NOW - 40_000, nowMs: NOW, maxAgeMs: 300_000 });
  expect(r.ok).toBe(true);
  expect(r.detail.beat_age_s).toBe(40);
});

test('heartbeat older than max age → fail (dead/wedged/slept)', () => {
  const r = evaluateHeartbeat({ beatAtMs: NOW - 600_000, nowMs: NOW, maxAgeMs: 300_000 });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('STALE');
});

test('no heartbeat row → fail (daemon not running / pre-heartbeat build)', () => {
  const r = evaluateHeartbeat({ beatAtMs: null, nowMs: NOW, maxAgeMs: 300_000 });
  expect(r.ok).toBe(false);
  expect(r.detail.beat_age_s).toBeNull();
});

// ─── 2b. work_loop_progress (wedged-but-alive) ──────────────────────────────

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test('all loop stamps fresh → ok', () => {
  const r = evaluateLoopProgress({
    loops: {
      sync: { last_tick_at: iso(200_000), ticks: 42 },
      stage23_poll: { last_tick_at: iso(6_000), ticks: 9001 },
    },
    heartbeatFresh: true, nowMs: NOW, maxAgeMs: 3_600_000,
  });
  expect(r.ok).toBe(true);
  expect((r.detail.sync as { age_s: number }).age_s).toBe(200);
});

test('fresh heartbeat + one stalled loop → fail (THE wedge signature)', () => {
  const r = evaluateLoopProgress({
    loops: {
      sync: { last_tick_at: iso(2 * 3_600_000), ticks: 42 },
      stage23_poll: { last_tick_at: iso(6_000), ticks: 9001 },
    },
    heartbeatFresh: true, nowMs: NOW, maxAgeMs: 3_600_000,
  });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('WEDGED');
  expect(r.message).toContain('sync');
});

test('stalled loops but heartbeat ALSO stale → ok (defers to daemon_heartbeat, no double report)', () => {
  const r = evaluateLoopProgress({
    loops: { sync: { last_tick_at: iso(2 * 3_600_000), ticks: 42 } },
    heartbeatFresh: false, nowMs: NOW, maxAgeMs: 3_600_000,
  });
  expect(r.ok).toBe(true);
  expect(r.message).toContain('deferring');
});

test('missing/pre-stamp detail → ok (tolerant abstain)', () => {
  expect(evaluateLoopProgress({ loops: null, heartbeatFresh: true, nowMs: NOW, maxAgeMs: 3_600_000 }).ok).toBe(true);
  expect(evaluateLoopProgress({ loops: {}, heartbeatFresh: true, nowMs: NOW, maxAgeMs: 3_600_000 }).ok).toBe(true);
});

test('unparseable stamp → treated as stale (fail on fresh heartbeat)', () => {
  const r = evaluateLoopProgress({
    loops: { sync: { last_tick_at: 12345, ticks: 1 } },
    heartbeatFresh: true, nowMs: NOW, maxAgeMs: 3_600_000,
  });
  expect(r.ok).toBe(false);
});

test('heartbeat exposes beat-counter advance vs previous run', () => {
  const r = evaluateHeartbeat({
    beatAtMs: NOW - 10_000, nowMs: NOW, maxAgeMs: 300_000, beats: 1000, prevBeats: 970,
  });
  expect(r.detail.beats_advanced_since_prev).toBe(30);
});

// ─── 3. llm_cost_today ──────────────────────────────────────────────────────

test('LLM cost under limit → ok', () => {
  expect(evaluateLlmCost({ costUsd: 1.14, calls: 5647, limitUsd: 20 }).ok).toBe(true);
});

test('LLM cost over limit → fail (runaway drain)', () => {
  const r = evaluateLlmCost({ costUsd: 42.5, calls: 90000, limitUsd: 20 });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('EXCEEDS');
});

test('LLM cost exactly at the limit is still ok (≤, not <)', () => {
  expect(evaluateLlmCost({ costUsd: 20, calls: 1, limitUsd: 20 }).ok).toBe(true);
});

// ─── 4. db_size ─────────────────────────────────────────────────────────────

test('db under absolute cap and no prior sample → ok, growth null', () => {
  const r = evaluateDbSize({
    currentBytes: 21 * GB, maxBytes: 35 * GB,
    prevBytes: null, prevAtMs: null, nowMs: NOW, maxGrowthBytesPerHr: 2 * GB,
  });
  expect(r.ok).toBe(true);
  expect(r.detail.growth_gb_per_hr).toBeNull();
});

test('db over absolute cap → fail', () => {
  const r = evaluateDbSize({
    currentBytes: 40 * GB, maxBytes: 35 * GB,
    prevBytes: null, prevAtMs: null, nowMs: NOW, maxGrowthBytesPerHr: 2 * GB,
  });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('OVER cap');
});

test('db growth rate over cap → fail even under absolute cap', () => {
  // +5 GB in 1 h = 5 GB/hr > 2 GB/hr cap, still under the 35 GB absolute cap
  const r = evaluateDbSize({
    currentBytes: 26 * GB, maxBytes: 35 * GB,
    prevBytes: 21 * GB, prevAtMs: NOW - 3_600_000, nowMs: NOW, maxGrowthBytesPerHr: 2 * GB,
  });
  expect(r.ok).toBe(false);
  expect(r.detail.growth_gb_per_hr).toBeCloseTo(5, 2);
});

test('db modest growth under cap → ok with computed rate', () => {
  // +0.5 GB in 1 h = 0.5 GB/hr < 2 GB/hr
  const r = evaluateDbSize({
    currentBytes: 21.5 * GB, maxBytes: 35 * GB,
    prevBytes: 21 * GB, prevAtMs: NOW - 3_600_000, nowMs: NOW, maxGrowthBytesPerHr: 2 * GB,
  });
  expect(r.ok).toBe(true);
  expect(r.detail.growth_gb_per_hr).toBeCloseTo(0.5, 2);
});

// ─── 5. queue_depths ────────────────────────────────────────────────────────

test('queue under cap → ok, reports delta vs previous', () => {
  const r = evaluateQueueDepth({ name: 'stage1_queue', depth: 16_308, prevDepth: 16_000, maxDepth: 200_000 });
  expect(r.ok).toBe(true);
  expect(r.detail.delta).toBe(308);
});

test('queue over runaway cap → fail', () => {
  const r = evaluateQueueDepth({ name: 'stage3_queue', depth: 80_000, prevDepth: 100, maxDepth: 50_000 });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('EXCEEDS runaway cap');
});

test('queue with no previous sample → ok, null delta', () => {
  const r = evaluateQueueDepth({ name: 'stage1_queue', depth: 0, prevDepth: null, maxDepth: 200_000 });
  expect(r.ok).toBe(true);
  expect(r.detail.delta).toBeNull();
});

// ─── 6. wall_clock_gap ──────────────────────────────────────────────────────

test('first run (no prev timestamp) → ok', () => {
  const r = evaluateWallClockGap({ prevAtMs: null, nowMs: NOW, intervalMs: 900_000, gapFactor: 3 });
  expect(r.ok).toBe(true);
  expect(r.detail.gap_s).toBeNull();
});

test('normal cadence gap → ok', () => {
  // 15 min later, interval 15 min, factor 3 → 15 min ≤ 45 min
  const r = evaluateWallClockGap({ prevAtMs: NOW - 900_000, nowMs: NOW, intervalMs: 900_000, gapFactor: 3 });
  expect(r.ok).toBe(true);
});

test('huge gap (host slept 8 h) → fail', () => {
  const r = evaluateWallClockGap({ prevAtMs: NOW - 8 * 3_600_000, nowMs: NOW, intervalMs: 900_000, gapFactor: 3 });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('host slept');
});

// ─── parsePrevState ─────────────────────────────────────────────────────────

test('parsePrevState recovers trend fields from the last JSON line', () => {
  const log = [
    '{"ts":"2026-07-10T11:30:00.000Z","ok":true,"db_bytes":1000,"stage1_pending":5,"stage3_pending":2,"stage23_depth":0,"checks":{"daemon_heartbeat":{"beats":900}}}',
    'WATCHDOG-ALERT: something — noise line that must be skipped',
    '{"ts":"2026-07-10T11:45:00.000Z","ok":true,"db_bytes":2000,"stage1_pending":7,"stage3_pending":3,"stage23_depth":1,"checks":{"daemon_heartbeat":{"beats":930}}}',
  ].join('\n');
  const p = parsePrevState(log);
  expect(p.dbBytes).toBe(2000);
  expect(p.stage1Pending).toBe(7);
  expect(p.stage3Pending).toBe(3);
  expect(p.stage23Depth).toBe(1);
  expect(p.beats).toBe(930);
  expect(p.atMs).toBe(Date.parse('2026-07-10T11:45:00.000Z'));
});

test('parsePrevState on empty/garbage log → all null', () => {
  const p = parsePrevState('not json\nWATCHDOG-ALERT: x\n{broken');
  expect(p.atMs).toBeNull();
  expect(p.dbBytes).toBeNull();
  expect(p.beats).toBeNull();
});

test('parsePrevState skips a trailing partial write and uses the last complete line', () => {
  const log =
    '{"ts":"2026-07-10T11:45:00.000Z","ok":true,"db_bytes":2000}\n' +
    '{"ts":"2026-07-10T12:00:00.000Z","ok":true,"db_by';  // truncated line
  const p = parsePrevState(log);
  expect(p.dbBytes).toBe(2000);
});

// ─── buildStatus ────────────────────────────────────────────────────────────

const metrics = {
  nowMs: NOW, dbBytes: 21 * GB, stage1Pending: 0, stage3Pending: 0, stage23Depth: 0, llmCostToday: 1.14,
};

test('buildStatus: all-ok → ok true, no alert lines, exit-clean', () => {
  const checks: CheckResult[] = [
    { name: 'pg_reachable', ok: true, message: 'ok', detail: {} },
    { name: 'daemon_heartbeat', ok: true, message: 'fresh', detail: {} },
  ];
  const { status, alertLines, ok } = buildStatus(checks, metrics);
  expect(ok).toBe(true);
  expect(status.ok).toBe(true);
  expect(status.failed).toEqual([]);
  expect(alertLines).toEqual([]);
});

test('buildStatus: any failing check → ok false + WATCHDOG-ALERT line per failure', () => {
  const checks: CheckResult[] = [
    { name: 'pg_reachable', ok: true, message: 'ok', detail: {} },
    { name: 'daemon_heartbeat', ok: false, message: 'heartbeat STALE — 600s old', detail: { beat_age_s: 600 } },
    { name: 'db_size', ok: false, message: 'db size 40 GB; OVER cap 35 GB', detail: {} },
  ];
  const { status, alertLines, ok } = buildStatus(checks, metrics);
  expect(ok).toBe(false);
  expect(status.failed).toEqual(['daemon_heartbeat', 'db_size']);
  expect(alertLines).toHaveLength(2);
  expect(alertLines[0]).toBe('WATCHDOG-ALERT: daemon_heartbeat — heartbeat STALE — 600s old');
  expect(alertLines.every((l) => l.startsWith('WATCHDOG-ALERT: '))).toBe(true);
});

test('buildStatus surfaces trend fields the next run reads back', () => {
  const { status } = buildStatus([{ name: 'x', ok: true, message: '', detail: {} }], metrics);
  expect(status.db_bytes).toBe(21 * GB);
  expect(status.llm_cost_today).toBe(1.14);
  // round-trip: parsePrevState must recover ts from what buildStatus emitted
  expect(parsePrevState(JSON.stringify(status)).atMs).toBe(NOW);
});
