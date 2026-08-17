/**
 * Pure unit tests for computeNextWatermark — no DB, no scraper. The next
 * watermark is the max db_updated_at over rows actually read, guarded by
 * min(runStartAt, observedMax): it must never advance past wall-clock
 * `runStartAt`, and must never advance when no rows were read.
 */
import { test, expect } from 'bun:test';
import { computeNextWatermark } from './sync.js';

const D = (iso: string) => new Date(iso);

test('rows read & observedMax < runStartAt → returns observedMax (the drift case)', () => {
  const r = computeNextWatermark(D('2026-06-02T19:10:00Z'), D('2026-05-13T20:00:00Z'), 5000);
  expect(r?.toISOString()).toBe('2026-05-13T20:00:00.000Z');
});

test('rows read & observedMax > runStartAt (scraper clock ahead) → returns runStartAt (min guard)', () => {
  const r = computeNextWatermark(D('2026-06-02T17:00:00Z'), D('2026-06-02T18:30:00Z'), 100);
  expect(r?.toISOString()).toBe('2026-06-02T17:00:00.000Z');
});

test('no rows read (synced===0) → returns null (no advance; caller keeps prior watermark)', () => {
  expect(computeNextWatermark(D('2026-06-02T17:00:00Z'), null, 0)).toBeNull();
  expect(computeNextWatermark(D('2026-06-02T17:00:00Z'), D('2026-05-13T20:00:00Z'), 0)).toBeNull();
});

test('rows read but observedMax null (defensive) → returns null', () => {
  expect(computeNextWatermark(D('2026-06-02T17:00:00Z'), null, 10)).toBeNull();
});

test('coarse boundary group: observedMax equals the shared timestamp (whole-group read)', () => {
  const shared = D('2026-05-13T20:00:00Z');
  const r = computeNextWatermark(D('2026-06-02T19:10:00Z'), shared, 5608);
  expect(r?.toISOString()).toBe(shared.toISOString());
});

test('observedMax exactly equals runStartAt → returns runStartAt (not strictly less)', () => {
  const same = D('2026-06-02T17:00:00Z');
  const r = computeNextWatermark(same, new Date(same.getTime()), 50);
  expect(r?.toISOString()).toBe(same.toISOString());
});
