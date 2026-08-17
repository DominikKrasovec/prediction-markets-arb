/**
 * Unit tests for the Stage-1d KB-change gate (the pure decision helpers
 * `shouldRunKbBackfill` + `kbWatermarkEquals`).
 *
 * These gate Stage 1d (enrichEntityMetadata) and Stage 1f (backfillSubjectsViaKB)
 * so a no-op pipeline tick (KB byte-identical AND no new markets) skips a full
 * link scan, an entity rewrite, and a batch of cache-hit SELECTs.
 *
 * Soundness boundary under test: the gate may ONLY return run=false when the KB
 * is provably unchanged AND nothing upstream changed — never when a rename/merge
 * could still need to propagate (that would silently strand stale canonical
 * names in the text columns and miss a real cross-platform merge).
 */
import { describe, test, expect } from 'bun:test';
import { shouldRunKbBackfill, kbWatermarkEquals, type KbWatermark } from './run.js';

const W = (count: number, maxUpdatedAt: string | null): KbWatermark => ({ count, maxUpdatedAt });

describe('kbWatermarkEquals', () => {
  test('equal count + equal max_updated_at → true', () => {
    expect(kbWatermarkEquals(W(100, '2026-06-08T00:00:00Z'), W(100, '2026-06-08T00:00:00Z'))).toBe(true);
  });

  test('different count → false (an insert/merge landed)', () => {
    expect(kbWatermarkEquals(W(100, '2026-06-08T00:00:00Z'), W(101, '2026-06-08T00:00:00Z'))).toBe(false);
  });

  test('different max_updated_at → false (an in-place UPDATE bumped updated_at)', () => {
    expect(kbWatermarkEquals(W(100, '2026-06-08T00:00:00Z'), W(100, '2026-06-08T00:00:01Z'))).toBe(false);
  });

  test('both null watermarks → equal (boot vs boot)', () => {
    expect(kbWatermarkEquals(null, null)).toBe(true);
  });

  test('one null, one present → not equal', () => {
    expect(kbWatermarkEquals(null, W(0, null))).toBe(false);
    expect(kbWatermarkEquals(W(0, null), null)).toBe(false);
  });

  test('null max_updated_at on both sides (empty KB) with same count → equal', () => {
    expect(kbWatermarkEquals(W(0, null), W(0, null))).toBe(true);
  });

  test('same count but one null / one present max_updated_at → not equal', () => {
    expect(kbWatermarkEquals(W(0, null), W(0, '2026-06-08T00:00:00Z'))).toBe(false);
  });
});

describe('shouldRunKbBackfill', () => {
  const stable = W(15320, '2026-06-08T19:19:21.949Z');

  test('first run (no prior watermark) → run, reason=first-run', () => {
    const r = shouldRunKbBackfill({ current: stable, lastCompleted: null, upstreamMarketsChanged: false });
    expect(r).toEqual({ run: true, reason: 'first-run' });
  });

  test('KB count advanced (merge/insert) → run, reason=kb-changed', () => {
    const r = shouldRunKbBackfill({
      current: W(15321, '2026-06-08T19:19:21.949Z'),
      lastCompleted: stable,
      upstreamMarketsChanged: false,
    });
    expect(r).toEqual({ run: true, reason: 'kb-changed' });
  });

  test('KB max_updated_at advanced (in-place rename) → run, reason=kb-changed', () => {
    const r = shouldRunKbBackfill({
      current: W(15320, '2026-06-08T20:00:00.000Z'),
      lastCompleted: stable,
      upstreamMarketsChanged: false,
    });
    expect(r).toEqual({ run: true, reason: 'kb-changed' });
  });

  test('KB identical but new markets arrived → run, reason=markets-changed', () => {
    const r = shouldRunKbBackfill({ current: stable, lastCompleted: stable, upstreamMarketsChanged: true });
    expect(r).toEqual({ run: true, reason: 'markets-changed' });
  });

  test('SOUNDNESS BOUNDARY: KB identical AND no upstream markets → SKIP (the only skip case)', () => {
    const r = shouldRunKbBackfill({ current: stable, lastCompleted: stable, upstreamMarketsChanged: false });
    expect(r).toEqual({ run: false, reason: 'skip-stable' });
  });

  test('kb-changed takes priority over markets-changed (full re-resolve, not incremental)', () => {
    // When BOTH the KB changed and markets arrived, the reason must be
    // kb-changed so the caller does a FULL re-resolve (a rename can touch ANY
    // market's stored phrase, not just the new ones).
    const r = shouldRunKbBackfill({
      current: W(15321, '2026-06-08T20:00:00.000Z'),
      lastCompleted: stable,
      upstreamMarketsChanged: true,
    });
    expect(r.run).toBe(true);
    expect(r.reason).toBe('kb-changed');
  });

  test('a count DECREASE (merge dropped the droppee) still trips kb-changed', () => {
    // mergeKnownEntities DELETEs the droppee row → count strictly decreases.
    const r = shouldRunKbBackfill({
      current: W(15319, '2026-06-08T19:19:21.949Z'),
      lastCompleted: stable,
      upstreamMarketsChanged: false,
    });
    expect(r).toEqual({ run: true, reason: 'kb-changed' });
  });

  test('empty-KB boot (count=0, max=null) compared to a populated last watermark → kb-changed', () => {
    const r = shouldRunKbBackfill({ current: W(0, null), lastCompleted: stable, upstreamMarketsChanged: false });
    expect(r).toEqual({ run: true, reason: 'kb-changed' });
  });
});
