import { createLogger } from '@arb/logger';
import { config } from './config.js';
import { runSync } from './db/sync.js';
import { runStage1 } from './stage1-normalize/index.js';
import { runResolutionOraclePass } from './stage1-normalize/resolution-oracle.js';
import { runEventGraph } from './run-event-graph.js';
import { withOfflineEdgeBuilderBound } from './stage4-events/run-edge-builder.js';
import { seedEntityKB } from './db/seed-entity-kb.js';
import { runEntityEnrichmentWorkers } from './entity-enrichment/index.js';
import { runIngestBackfills } from './run-ingest-backfills.js';
import { drainStage23Queue, enqueueStage23 } from './db/queries/stage23-queue.js';
import { createPipelineRun, updatePhaseStats, completePipelineRun, failPipelineRun } from './db/queries/index.js';
import { vacuumAnalyze } from './db/maintenance.js';
import { flushBeltCensus, resetBeltCensus } from './discriminators/telemetry.js';
import { publish } from '@arb/event-bus';

// The watermark machinery + the Stage 0a→1d→1e-hook→1f→1g ladder live in
// run-ingest-backfills.ts, shared verbatim with daemon Loop 2. Re-exported
// here for existing importers/tests.
export {
  kbWatermarkEquals,
  shouldRunKbBackfill,
  sampleKbWatermark,
  type KbWatermark,
} from './run-ingest-backfills.js';

const log = createLogger('pipeline');

function tryPublish(data: { channel: 'pipeline'; type: string; data: unknown }): void {
  publish(data).catch(() => {
    // Event bus may not have clients connected yet
  });
}

export async function runPipeline(): Promise<void> {
  log.info('Starting full pipeline run...');
  // Echo the gating flags so it's never a mystery which stages are active.
  // Important on PowerShell where `& { $env:X="1"; ... }` modifies the parent
  // process env permanently — a flag set in one invocation silently leaks
  // into the next unless explicitly removed with `Remove-Item Env:\X`.
  log.info(
    `Run flags: ` +
    `STAGE3_SKIP_LLM=${process.env.STAGE3_SKIP_LLM ?? '0'}, ` +
    `ENTITY_ENRICHMENT_SKIP=${process.env.ENTITY_ENRICHMENT_SKIP ?? '0'}, ` +
    `SKIP_STAGE23=${process.env.SKIP_STAGE23 ?? '0'}, ` +
    `EMBED_PARLAYS=${process.env.EMBED_PARLAYS ?? '0 (default skip)'}, ` +
    `KB_HISTOGRAM_GATE_MODE=${process.env.KB_HISTOGRAM_GATE_MODE ?? 'off'}, ` +
    `ENTITY_ENRICHMENT_MAX_ROWS=${process.env.ENTITY_ENRICHMENT_MAX_ROWS ?? 'unlimited'}`
  );
  const start = Date.now();

  // Record pipeline run
  const runId = await createPipelineRun('full', 'scheduler');

  tryPublish({ channel: 'pipeline', type: 'started', data: { runId, timestamp: new Date().toISOString() } });

  try {
    // Stage 0a: Seed entity KB if empty (structural sports/leagues/providers + team links)
    const kbSeed = await seedEntityKB();
    log.info(
      `Stage 0a (entity KB): ${kbSeed.assetsUpserted} crypto assets, ` +
      `${kbSeed.politicsUpserted} politics overrides seeded/refreshed` +
      (kbSeed.confederations.teamsStamped > 0
        ? `, ${kbSeed.confederations.teamsStamped} confederation stamps`
        : ''),
    );
    if (kbSeed.seeded) {
      log.info(
        `Stage 0a (entity KB seed): ` +
        `${kbSeed.structural.entitiesUpserted} entities, ` +
        `${kbSeed.structural.relationsWritten} relations, ` +
        `${kbSeed.teams.resolved} team→league links`
      );
    }

    // Stage 0: Sync scraper tables → pipeline `markets` table
    const synced = await runSync();
    log.info(`Stage 0 (sync): ${synced} markets`);

    // Stage 1: deterministic enrich (1a regex features, 1b template + KB normalize, 1c embed)
    // No LLM normalization (event-centric rewire); entity-enrichment LLM is gated separately by
    // ENTITY_ENRICHMENT_SKIP. The only LLM in the pipeline is the Stage 3b matcher (STAGE3_SKIP_LLM).
    const enrichResult = await runStage1();
    log.info(
      `Stage 1 (enrich): ${enrichResult.featurized} featurized, ` +
      `${enrichResult.textDetNormalized} normalized (deterministic), ` +
      `${enrichResult.embedded} embedded`
    );

    // Reclaim dead pages from the Stage-1 INSERT/UPSERT churn before Stage 2
    // starts hammering these same tables, or dead-tuple bloat accumulates
    // across the full run.
    // NB: embeddings live in the `markets.embedding` column — there is no
    // `market_embeddings` table (listing it just emitted a harmless "relation
    // does not exist" WARN every run). `markets` is vacuumed elsewhere.
    await vacuumAnalyze([
      'market_features',
      'llm_market_normalizations',
      'market_entity_links',
    ]);

    // Stages 0a(re-apply)/1d/1e/1f/1g: the shared ingest-backfill ladder
    // (run-ingest-backfills.ts, verbatim-shared with daemon Loop 2). Stage
    // 1e runs through the hook so the LLM workers + their batch-mode gating
    // stay here.
    const upstreamMarketsChanged =
      synced > 0 ||
      enrichResult.featurized > 0 ||
      enrichResult.textDetNormalized > 0;
    const backfills = await runIngestBackfills({
      newMarketIds: enrichResult.newMarketIds,
      upstreamMarketsChanged,
      // Stage 1e: LLM-driven entity enrichment (async queue drain).
      //    Targets entities created by the deterministic Stage 1 path (which
      //    leaves metadata empty) and any historical rows flagged
      //    enrichment_status='pending'. Cap to ENTITY_ENRICHMENT_MAX_ROWS (or
      //    skip entirely with ENTITY_ENRICHMENT_SKIP=1) to bound LLM cost per
      //    pipeline run. Stage 2/3 degrade gracefully when the queue still
      //    has pending rows, so this is non-blocking by design.
      runStage1e: async () => {
        let enrichmentStats = { enriched: 0, skipped: 0, failed: 0, durationMs: 0 };
        if (!config.stage1.entityEnrichmentSkip) {
          const maxRowsEnv = process.env.ENTITY_ENRICHMENT_MAX_ROWS;
          enrichmentStats = await runEntityEnrichmentWorkers({
            drainAndExit: true,
            maxRows: maxRowsEnv ? parseInt(maxRowsEnv) : undefined,
          });
          log.info(
            `Stage 1e (entity enrichment): ` +
            `${enrichmentStats.enriched} enriched, ${enrichmentStats.skipped} skipped, ` +
            `${enrichmentStats.failed} failed (${enrichmentStats.durationMs}ms)`
          );
        }
        return enrichmentStats;
      },
    });
    const { kbMeta, enrichmentStats, backfillResult } = backfills;

    const phase1Stats = {
      synced,
      ...enrichResult,
      kbEntitiesEnriched: kbMeta.entitiesUpdated,
      llmEntitiesEnriched: enrichmentStats.enriched,
    };
    await updatePhaseStats(runId, 1, phase1Stats);
    tryPublish({
      channel: 'pipeline', type: 'phase_complete',
      data: { runId, phase: 1, phaseName: 'enrich', stats: phase1Stats, durationMs: Date.now() - start },
    });

    // VACUUM the KB-side tables after Stage 1d/1e/1f UPDATEs (metadata
    // backfill, enrichment, subject backfill). All three rewrite rows in
    // known_entities / entity_subjects / llm_market_normalizations.
    await vacuumAnalyze([
      'known_entities',
      'entity_subjects',
      'llm_market_normalizations',
    ]);

    // Stage 1h: resolution-oracle parse
    // Fills llm_market_normalizations.resolution_source (the settlement
    // authority) from the platform-native raw payload. Write-only field (not
    // wired into any fold key), so this changes zero edges. Runs after Stage
    // 1 + the 1d/1e/1f backfill ladder (the lmn upsert re-asserts
    // resolution_source=EXCLUDED, so this must be the last writer), and only
    // fills NULL rows (additive + idempotent). Gated on upstream changes to
    // stay a no-op on quiescent daemon ticks; RESOLUTION_ORACLE_SKIP=1 disables it.
    if (upstreamMarketsChanged && process.env.RESOLUTION_ORACLE_SKIP !== '1') {
      const oracleStats = await runResolutionOraclePass();
      log.info(
        `Stage 1h (resolution oracle): ${oracleStats.stamped} stamped / ` +
        `${oracleStats.scanned} scanned (${oracleStats.durationMs}ms) — ` +
        `by platform ${JSON.stringify(oracleStats.byPlatform)}`
      );
    }

    // Stage 2+3: skip when SKIP_STAGE23=1 (e.g. reindex-only runs)
    if (process.env.SKIP_STAGE23 === '1') {
      log.info('SKIP_STAGE23=1: skipping Stage 2 + 3');
      await completePipelineRun(runId, {});
      return;
    }

    // Stage 2: Match & Group (hash-key exact match + ANN candidate pair discovery)
    // Drain the stage23_queue for new market IDs populated by Stage 1.
    // If any markets were newly completed, Stage 2+3 runs incrementally
    // (new × all_active ANN + structural). An empty drain falls back to
    // full-scan mode (e.g. first run or after a DB reset).
    // On failure, re-enqueue the drained IDs so the next run retries
    // incrementally rather than silently falling back to a full scan.
    const newMarketIds = await drainStage23Queue();
    if (newMarketIds.length > 0) {
      log.info(`Stage 2+3 incremental: ${newMarketIds.length} new markets from stage23_queue`);
    } else {
      // No queued markets — only run Stage 2+3 if SOMETHING upstream
      // actually changed. Without this gate, every 5-minute pipeline tick
      // would run a full ~52min Stage 2+3 over the same 870k questions
      // producing identical edges. The "true" signals (Stage 0 sync,
      // Stage 1 enrichment, Stage 1e/1f backfills) are the only things
      // that could change candidate-pair output; `kbMeta.entitiesUpdated`
      // reports a re-enriched total per run so we deliberately exclude it.
      const haveUpstreamChanges =
        synced > 0 ||
        enrichResult.featurized > 0 ||
        enrichResult.textDetNormalized > 0 ||
        enrichResult.embedded > 0 ||
        enrichmentStats.enriched > 0 ||
        backfillResult.updated > 0 ||
        backfillResult.eventsUpdated > 0;
      if (!haveUpstreamChanges) {
        const elapsed = Date.now() - start;
        log.info(
          `Stage 2+3: skipped (no upstream changes since last run, queue empty). ` +
          `Use \`SKIP_STAGE23=0\` + DB writes or re-enqueue to force a re-scan.`
        );
        await completePipelineRun(runId, { elapsed_ms: elapsed, no_op: true });
        log.info(`Full run completed in ${elapsed}ms (run #${runId})`);
        return;
      }
      log.info(
        `Stage 2+3 full-scan: triggered by upstream changes ` +
        `(synced=${synced}, ` +
        `featurized=${enrichResult.featurized}, ` +
        `normalized=${enrichResult.textDetNormalized}, ` +
        `embedded=${enrichResult.embedded}, ` +
        `enriched=${enrichmentStats.enriched}, ` +
        `backfilled=${backfillResult.updated})`
      );
    }

    try {
    // Stage 2+3+4: event-centric graph build
    // (2b singleton-wrap → 2c embed → 3a ANN → 3b LLM match → 4 finalize).
    // Replaces the retired hash-key grouping + rule-engine zoo. The pipeline
    // builds STRUCTURE only; pricing & arb scoring live in the arb-solver.
    // The post-projection VACUUM of the consumer tables lives INSIDE
    // runEventGraph (parity-by-construction with daemon Loop 3 — see
    // run-event-graph.ts); no private copy here or we'd double-vacuum.
    // `runPipeline` is the one-shot/rebuild entry point (the live loop is
    // daemon.ts), so the Stage-4 edge builders get a longer statement_timeout
    // than the live path — an offline timeout skip there is a permanently
    // missing edge class, not a recall-only miss. The daemon never enters
    // this extent.
    const eg = await withOfflineEdgeBuilderBound(() =>
      runEventGraph({ skipLlm: process.env.STAGE3_SKIP_LLM === '1' }),
    );

    const elapsed = Date.now() - start;
    const phaseStats = {
      singleton_events: eg.singletonEvents,
      embedded_events:  eg.embeddedEvents,
      ann_candidates:   eg.annCandidates,
      matched_events:   eg.match.matched + eg.match.expanded,
      match_skipped:    eg.match.skipped,
      match_failed:     eg.match.failed,
      outcome_nodes:    eg.stage4.outcomeNodes,
      outcome_sets:     eg.stage4.outcomeSets,
      threshold_edges:  eg.stage4.thresholdEdges,
      contradictions:   eg.stage4.contradictions,
    };
    await updatePhaseStats(runId, 3, phaseStats);
    await completePipelineRun(runId, { ...phaseStats, elapsed_ms: elapsed });
    tryPublish({
      channel: 'pipeline', type: 'completed',
      data: { runId, durationMs: elapsed, stats: phaseStats },
    });

    log.info(`Full run completed in ${elapsed}ms (run #${runId})`);
    } catch (stage23Err) {
      // Re-enqueue the drained IDs so the next run retries incrementally.
      if (newMarketIds.length > 0) {
        await enqueueStage23(newMarketIds).catch(() => {
          // Best-effort; if this also fails the next run falls back to full scan.
        });
      }
      throw stage23Err;
    }
  } catch (err) {
    await failPipelineRun(runId, String(err));
    tryPublish({
      channel: 'pipeline', type: 'error',
      data: { runId, error: String(err) },
    });
    throw err;
  } finally {
    // Emits the single grep-able BELT_CENSUS line at batch-tick end, then
    // resets so each tick's line is a fresh per-tick window (no cross-tick
    // bleed).
    flushBeltCensus((m) => log.info(m));
    resetBeltCensus();
  }
}
