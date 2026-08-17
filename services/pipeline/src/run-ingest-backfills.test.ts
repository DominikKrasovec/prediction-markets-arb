/**
 * Daemon-parity tests: both entrypoints (batch run.ts and the daemon) must
 * consume the one shared ladder in run-ingest-backfills.ts, so a future
 * addition to the ladder is inherited by both modes structurally rather than
 * needing to be patched into each separately.
 *
 * A live daemon smoke run is deliberately not part of the suite: it would run
 * a first-run full backfill pass against the pre-rebuild snapshot, which
 * should never be forced from a test.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldRunKbBackfill, kbWatermarkEquals, stage1fBackfillScope } from './run-ingest-backfills.js';

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');

describe('A3 import graph: one shared ladder, two entrypoints', () => {
  const runTs = src('run.ts');
  const daemonTs = src('daemon.ts');

  test('run.ts calls the shared ladder', () => {
    expect(runTs).toContain(`from './run-ingest-backfills.js'`);
    expect(runTs).toContain('runIngestBackfills(');
  });

  test('daemon.ts Loop 2 calls the shared ladder with the re-pair feed', () => {
    expect(daemonTs).toContain(`from './run-ingest-backfills.js'`);
    expect(daemonTs).toContain('runIngestBackfills(');
    expect(daemonTs).toContain('enqueueUpdatedMarketIds: true');
  });

  test('the ungated daemon enrichEntityMetadata path stays dead (no import, no call)', () => {
    expect(daemonTs).not.toContain('enrichEntityMetadata(');
    expect(daemonTs).not.toContain(`from './db/enrich-entity-metadata.js'`);
  });

  test('run.ts owns no private 1d/1f/1g ladder anymore (single chokepoint)', () => {
    expect(runTs).not.toContain('enrichEntityMetadata(');
    expect(runTs).not.toContain('backfillSubjectsViaKB(');
    expect(runTs).not.toContain('backfillSettlementInstrument(');
    expect(runTs).not.toContain('_lastKbWatermark');
  });

  test('the watermark state lives ONLY in the shared module', () => {
    const shared = src('run-ingest-backfills.ts');
    expect(shared).toContain('let _lastKbWatermark');
    expect(daemonTs).not.toContain('_lastKbWatermark');
  });

  // The resolution_scope backfill joins the shared ladder once — both
  // entrypoints inherit it; neither owns a private copy.
  test('Stage 1h (resolution_scope backfill) lives in the shared ladder, gated', () => {
    const shared = src('run-ingest-backfills.ts');
    expect(shared).toContain('backfillResolutionScope(');
    expect(shared).toContain('shouldRunScopeBackfill(');
    expect(shared).toContain('countNullScopeMarkets(');
    expect(runTs).not.toContain('backfillResolutionScope(');
    expect(daemonTs).not.toContain('backfillResolutionScope(');
  });

  // The VACUUM of the Stage-4 churn tables lives in runEventGraph — the
  // shared projection path — so batch run.ts and the daemon inherit it by
  // construction. Neither entrypoint owns a private copy, so there is no
  // double-vacuum.
  test('post-projection vacuumAnalyze lives ONLY in runEventGraph (both modes inherit, no double-vacuum)', () => {
    const eventGraph = src('run-event-graph.ts');
    expect(eventGraph).toContain(`from './db/maintenance.js'`);
    expect(eventGraph).toContain('vacuumAnalyze(');
    // The exact churn-table set Stage 4 DELETE+INSERTs over:
    for (const t of ['questions', 'question_members', 'outcome_sets', 'outcome_set_slots', 'implication_edges']) {
      expect(eventGraph).toContain(`'${t}'`);
    }
    // run.ts keeps its two PRE-projection belts (post-Stage-1, post-KB) but
    // must not vacuum implication_edges/outcome_set* itself anymore.
    expect(runTs).not.toContain('implication_edges');
    expect(runTs).not.toContain('outcome_set_slots');
    // daemon never grew a private vacuum path.
    expect(daemonTs).not.toContain('vacuumAnalyze');
  });

  // Both entrypoints run the read-only integrity checks once per process —
  // daemon at startup, batch (index.ts) after the first runPipeline.
  // Per-tick would be too heavy (full scans over markets×market_features).
  test('runHealthChecks runs once per process in BOTH modes (daemon startup + batch index.ts)', () => {
    const indexTs = src('index.ts');
    expect(daemonTs).toContain('runHealthChecks(');
    expect(indexTs).toContain('runHealthChecks(');
    expect(indexTs).toContain(`from './db/health-checks.js'`);
    // and not inside the per-tick runPipeline body:
    expect(runTs).not.toContain('runHealthChecks(');
  });
});

describe('gate helpers stay pure and re-exported (run.test.ts contract)', () => {
  test('skip-stable on identical watermark and quiet upstream', () => {
    const w = { count: 10, maxUpdatedAt: '2026-06-12T00:00:00Z' };
    expect(shouldRunKbBackfill({ current: w, lastCompleted: w, upstreamMarketsChanged: false }))
      .toEqual({ run: false, reason: 'skip-stable' });
  });
  test('kbWatermarkEquals null semantics unchanged', () => {
    expect(kbWatermarkEquals(null, null)).toBe(true);
    expect(kbWatermarkEquals(null, { count: 0, maxUpdatedAt: null })).toBe(false);
  });
});

// Stage-1f scope decision (skip / full / incremental): any KB-change signal
// ('first-run'/'kb-changed'/1e-enrichment) must force a full pass; only a
// pure markets-changed tick with a concrete id list may go incremental.
describe('stage1fBackfillScope (DW-51)', () => {
  const gate = (run: boolean, reason: 'first-run' | 'kb-changed' | 'markets-changed' | 'skip-stable') =>
    ({ run, reason });

  test('signature unchanged + no 1e enrichment → SKIP entirely', () => {
    expect(stage1fBackfillScope({ gate: gate(false, 'skip-stable'), stage1eEnriched: 0, newMarketIds: [1, 2] }))
      .toEqual({ run: false });
  });

  test('signature changed (kb-changed) → FULL pass, even when new market ids exist', () => {
    expect(stage1fBackfillScope({ gate: gate(true, 'kb-changed'), stage1eEnriched: 0, newMarketIds: [1, 2] }))
      .toEqual({ run: true });
  });

  test('first-run → FULL pass', () => {
    expect(stage1fBackfillScope({ gate: gate(true, 'first-run'), stage1eEnriched: 0, newMarketIds: null }))
      .toEqual({ run: true });
  });

  test('new marketIds only (markets-changed, no enrichment) → INCREMENTAL, exactly those ids', () => {
    expect(stage1fBackfillScope({ gate: gate(true, 'markets-changed'), stage1eEnriched: 0, newMarketIds: [7, 8, 9] }))
      .toEqual({ run: true, marketIds: [7, 8, 9] });
  });

  test('markets-changed but 1e enriched THIS tick → FULL (merges land after the watermark sample)', () => {
    expect(stage1fBackfillScope({ gate: gate(true, 'markets-changed'), stage1eEnriched: 3, newMarketIds: [7] }))
      .toEqual({ run: true });
  });

  test('gate skipped but 1e enriched → still runs, FULL', () => {
    expect(stage1fBackfillScope({ gate: gate(false, 'skip-stable'), stage1eEnriched: 1, newMarketIds: [7] }))
      .toEqual({ run: true });
  });

  test('markets-changed with unknown (null) or empty id list → FULL (conservative)', () => {
    expect(stage1fBackfillScope({ gate: gate(true, 'markets-changed'), stage1eEnriched: 0, newMarketIds: null }))
      .toEqual({ run: true });
    expect(stage1fBackfillScope({ gate: gate(true, 'markets-changed'), stage1eEnriched: 0, newMarketIds: [] }))
      .toEqual({ run: true });
  });
});

// The seed tier's write paths must bump updated_at when (and only when) they
// actually change a row, or a seed heal never trips the gate.
describe('seed-tier updated_at watermark bumps (DW-51)', () => {
  const seedSrc = readFileSync(join(import.meta.dir, 'db', 'seed-entity-kb.ts'), 'utf8');

  test('upsertEntity + AUTHORITATIVE upsert bump updated_at conditionally (CASE WHEN … changed)', () => {
    const conditionalBumps = seedSrc.match(/updated_at\s+= CASE WHEN/g) ?? [];
    expect(conditionalBumps.length).toBeGreaterThanOrEqual(2);
    // never an UNCONDITIONAL bump inside an ON CONFLICT upsert (that would
    // trip the gate every tick and kill the skip-stable path entirely)
    expect(seedSrc).not.toMatch(/DO UPDATE SET[\s\S]{0,600}updated_at\s*=\s*NOW\(\)\s*[,\n]/);
  });

  test('seedTeamLeagues metadata write bumps updated_at', () => {
    expect(seedSrc).toContain(
      'UPDATE known_entities SET metadata = $1::jsonb, updated_at = NOW() WHERE id = $2'
    );
  });
});
