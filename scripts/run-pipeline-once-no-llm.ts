/**
 * One-shot pipeline run with LLM normalization and entity-enrichment disabled.
 *
 * Intended for the histogram-audit re-run: after wiping Stage 1-3 + KB
 * (`scripts/wipe-stage1-3-and-kb.sql`), this script repopulates everything
 * the deterministic templates can without spending LLM tokens.
 *
 * What runs (event-centric pipeline):
 *   - Stage 0a: seedEntityKB (idempotent — re-seeds sports / leagues / providers)
 *   - Stage 0: sync raw markets → unified `markets` table (+ populatePlatformEvents)
 *   - Stage 1a/1b/1c: featurize (regex) + deterministic templates + KB resolve + embed
 *     (Stage 1 has NO LLM normalization post-rewire — deterministic only)
 *   - Stage 1d/1f: enrichEntityMetadata + subject backfill via KB
 *   - Event graph (2a rollup → 2b → 2c embed → 3a ANN → 3b match [SKIPPED] → 4 finalize)
 *
 * What is skipped (so the run is genuinely LLM-free):
 *   - ENTITY_ENRICHMENT_SKIP=1 → no entity-enrichment workers (the only Stage-1-adjacent LLM)
 *   - STAGE3_SKIP_LLM=1        → no Stage 3b cross-platform event matcher (the only other LLM)
 *   (STAGE1_SKIP_LLM is gone — Stage 1 has no LLM to skip.)
 *
 * Still hits the OpenAI EMBEDDINGS API (markets + platform_events embeddings, KB T2) — not a chat LLM.
 * Exits 0 on success, 1 on failure. Does NOT schedule the periodic timer.
 */
import 'dotenv/config';
import { createLogger } from '@arb/logger';

process.env.ENTITY_ENRICHMENT_SKIP = '1';
process.env.STAGE3_SKIP_LLM = '1';

const log = createLogger('pipeline-once');

async function main() {
  log.info('==> One-shot deterministic pipeline run (no LLM normalization, no entity enrichment)');
  const { runPipeline } = await import('../services/pipeline/src/run.js');
  await runPipeline();
  log.info('==> One-shot run complete');
  process.exit(0);
}

main().catch((err) => {
  log.error('Pipeline failed:', err);
  process.exit(1);
});
