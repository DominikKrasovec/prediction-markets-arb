/**
 * Shared ingest-backfill ladder: Stage 0a additive re-apply -> Stage 1d gated (KB watermark)
 * -> [Stage 1e hook, batch only] -> Stage 1f gated incremental/full -> Stage 1g
 * settlement-instrument -> Stage 1h resolution-scope backfill. Shared verbatim by run.ts
 * (batch) and daemon.ts Loop 2. The KB watermark lives here, in-process, so both entrypoints
 * share one skip-stable gate.
 */
import { createLogger } from '@arb/logger';
import { query } from '@arb/db';
import { seedEntityKB } from './db/seed-entity-kb.js';
import { enrichEntityMetadata, inheritTourGenderFromLeague, countPersonsNeedingTourGender } from './db/enrich-entity-metadata.js';
import { backfillSubjectsViaKB } from './db/entity-registry.js';
import { backfillSettlementInstrument } from './scripts/backfill-settlement-instrument.js';
import {
  backfillResolutionScope,
  countNullScopeMarkets,
  shouldRunScopeBackfill,
  backfillLimitlessSportScope,
  countLimitlessSportScopeCandidates,
} from './scripts/backfill-resolution-scope.js';
import { enqueueStage23 } from './db/queries/stage23-queue.js';

const log = createLogger('pipeline');

// Stage 1d/1f are gated behind a cheap (count, max(updated_at)) watermark over known_entities:
// with the KB byte-identical and no upstream market change this tick, both stages are pure
// functions of already-persisted inputs — a guaranteed row-level no-op.
export interface KbWatermark {
  count: number;
  maxUpdatedAt: string | null;
}

let _lastKbWatermark: KbWatermark | null = null;

export function kbWatermarkEquals(a: KbWatermark | null, b: KbWatermark | null): boolean {
  if (a === null || b === null) return a === b;
  return a.count === b.count && a.maxUpdatedAt === b.maxUpdatedAt;
}

export function shouldRunKbBackfill(args: {
  current: KbWatermark;
  lastCompleted: KbWatermark | null;
  upstreamMarketsChanged: boolean;
}): { run: boolean; reason: 'first-run' | 'kb-changed' | 'markets-changed' | 'skip-stable' } {
  if (args.lastCompleted === null) return { run: true, reason: 'first-run' };
  if (!kbWatermarkEquals(args.current, args.lastCompleted)) return { run: true, reason: 'kb-changed' };
  if (args.upstreamMarketsChanged) return { run: true, reason: 'markets-changed' };
  return { run: false, reason: 'skip-stable' };
}

// A KB rename/merge ('kb-changed'/'first-run') can touch any market's stored phrase, so those
// always force a full re-resolve; only a markets-only change with a concrete id list goes incremental.
export function stage1fBackfillScope(args: {
  gate: { run: boolean; reason: 'first-run' | 'kb-changed' | 'markets-changed' | 'skip-stable' };
  stage1eEnriched: number;
  newMarketIds?: number[] | null;
}): { run: boolean; marketIds?: number[] } {
  const run = args.gate.run || args.stage1eEnriched > 0;
  if (!run) return { run: false };
  const incremental =
    args.gate.reason === 'markets-changed' &&
    args.stage1eEnriched === 0 &&
    (args.newMarketIds?.length ?? 0) > 0;
  return incremental ? { run: true, marketIds: args.newMarketIds! } : { run: true };
}

export async function sampleKbWatermark(): Promise<KbWatermark> {
  const rows = await query<{ count: number; max_updated_at: string | null }>(
    `SELECT count(*)::int AS count, max(updated_at)::text AS max_updated_at FROM known_entities`,
  );
  return { count: rows[0]?.count ?? 0, maxUpdatedAt: rows[0]?.max_updated_at ?? null };
}

export interface EnrichmentStats {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

export interface IngestBackfillsResult {
  kbSeed: Awaited<ReturnType<typeof seedEntityKB>>;
  kbWatermarkBefore: KbWatermark;
  kbGate: ReturnType<typeof shouldRunKbBackfill>;
  kbMeta: { entitiesUpdated: number };
  enrichmentStats: EnrichmentStats;
  backfillResult: { checked: number; updated: number; eventsUpdated: number; updatedMarketIds: number[] };
}

export async function runIngestBackfills(opts: {
  newMarketIds?: number[] | null;
  upstreamMarketsChanged: boolean;
  // Batch-mode Stage 1e hook; daemon Loop 2 omits it (LLM-free by design).
  runStage1e?: () => Promise<EnrichmentStats>;
  // Daemon: enqueue Stage 1f's corrected market ids so corrections re-pair immediately.
  enqueueUpdatedMarketIds?: boolean;
}): Promise<IngestBackfillsResult> {
  const step = (s: string): void => log.info(`ingest-backfills → ${s}`);

  step('0a seedEntityKB');
  const kbSeed = await seedEntityKB();
  if (kbSeed.seeded || kbSeed.confederations.teamsStamped > 0) {
    log.info(
      `Stage 0a (re-apply): ${kbSeed.assetsUpserted} crypto assets, ` +
      `${kbSeed.politicsUpserted} politics overrides, ` +
      `${kbSeed.confederations.teamsStamped} confederation stamps`,
    );
  }

  step('kb-watermark sample');
  const kbWatermarkBefore = await sampleKbWatermark();
  const kbGate = shouldRunKbBackfill({
    current: kbWatermarkBefore,
    lastCompleted: _lastKbWatermark,
    upstreamMarketsChanged: opts.upstreamMarketsChanged,
  });
  const incrementalMarketIds =
    kbGate.reason === 'markets-changed' ? (opts.newMarketIds ?? null) : null;

  let kbMeta = { entitiesUpdated: 0 };
  if (kbGate.run) {
    step('1d enrichEntityMetadata');
    kbMeta = await enrichEntityMetadata(incrementalMarketIds);
    log.info(
      `Stage 1d (KB metadata): ${kbMeta.entitiesUpdated} entities enriched ` +
      `(${kbGate.reason}${incrementalMarketIds ? `, incremental n=${incrementalMarketIds.length}` : ', full'})`
    );
  } else {
    log.info(
      `Stage 1d skipped — known_entities unchanged since last backfill ` +
      `(count=${kbWatermarkBefore.count}, max_updated_at=${kbWatermarkBefore.maxUpdatedAt})`
    );
  }

  let enrichmentStats: EnrichmentStats = { enriched: 0, skipped: 0, failed: 0, durationMs: 0 };
  if (opts.runStage1e) {
    enrichmentStats = await opts.runStage1e();
  }

  {
    step("1e' tour_gender");
    const pending = await countPersonsNeedingTourGender();
    if (pending > 0) {
      const tg = await inheritTourGenderFromLeague();
      log.info(`Stage 1e′ (tour_gender inheritance): ${tg.stamped} athletes stamped from league membership (${pending} eligible)`);
    } else {
      log.info('Stage 1e′ skipped — no athletes awaiting tour_gender inheritance (converged)');
    }
  }

  let backfillResult: { checked: number; updated: number; eventsUpdated: number; updatedMarketIds: number[] } =
    { checked: 0, updated: 0, eventsUpdated: 0, updatedMarketIds: [] };
  const backfillScope = stage1fBackfillScope({
    gate: kbGate,
    stage1eEnriched: enrichmentStats.enriched,
    newMarketIds: opts.newMarketIds,
  });
  if (backfillScope.run) {
    step('1f backfillSubjectsViaKB');
    backfillResult = await backfillSubjectsViaKB(
      backfillScope.marketIds ? { marketIds: backfillScope.marketIds } : undefined
    );
    if (backfillResult.updated > 0 || backfillResult.eventsUpdated > 0) {
      log.info(
        `Stage 1f (subject backfill): ` +
        `${backfillResult.checked} phrase-scope tuples checked, ` +
        `${backfillResult.updated} markets + ${backfillResult.eventsUpdated} platform_events updated`
      );
    }
    if (opts.enqueueUpdatedMarketIds && backfillResult.updatedMarketIds.length > 0) {
      await enqueueStage23(backfillResult.updatedMarketIds);
      log.info(
        `Stage 1f → stage23_queue: ${backfillResult.updatedMarketIds.length} corrected market(s) re-enqueued for re-pairing`
      );
    }
  } else {
    log.info(
      `Stage 1f skipped — known_entities unchanged since last backfill ` +
      `(count=${kbWatermarkBefore.count}, max_updated_at=${kbWatermarkBefore.maxUpdatedAt})`
    );
  }

  {
    step('1g settlementInstrument');
    const si = await backfillSettlementInstrument();
    if (si.updated > 0) {
      log.info(`Stage 1g (settlement_instrument): ${si.scanned} scanned, ${si.updated} stamped`);
    }
  }

  {
    step('1h resolutionScope');
    const nullScopeCount = await countNullScopeMarkets();
    const scopeGate = shouldRunScopeBackfill(nullScopeCount);
    if (scopeGate.run) {
      const rs = await backfillResolutionScope();
      log.info(
        `Stage 1h (resolution_scope): ${rs.scanned} NULL rows scanned, ${rs.stamped} stamped ` +
        `(${Object.entries(rs.byScope).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`,
      );
    } else {
      log.info('Stage 1h skipped — no NULL resolution_scope rows (converged)');
    }
  }

  {
    step("1h' limitlessSportScope");
    const sportCandidates = await countLimitlessSportScopeCandidates();
    if (sportCandidates > 0) {
      const rs = await backfillLimitlessSportScope();
      log.info(
        `Stage 1h′ (limitless sport-scope): ${rs.scanned} slice rows scanned, ${rs.stamped} promoted ` +
        `(${Object.entries(rs.byScope).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`,
      );
    } else {
      log.info('Stage 1h′ skipped — no promotable limitless sport-scope rows (converged)');
    }
  }

  _lastKbWatermark = (kbGate.run || enrichmentStats.enriched > 0)
    ? await sampleKbWatermark()
    : kbWatermarkBefore;

  step('done');
  return { kbSeed, kbWatermarkBefore, kbGate, kbMeta, enrichmentStats, backfillResult };
}
