/**
 * Wipe Stage 1–3 + KB tables so the pipeline can be re-run from scratch.
 *
 * Preserves:
 *   - `markets` (including the `embedding` column — embeddings are expensive
 *     to recompute and the feature regex doesn't touch them)
 *   - Raw scrape tables (kalshi_markets, polymarket_markets, predict_markets,
 *     limitless_markets, market_metadata_raw)
 *   - Parent event/category tables (kalshi_events, polymarket_events,
 *     predict_categories, predict_tags) — sync populated, not Stage 1
 *   - Price/snapshot tables
 *   - LLM logs (`llm_logs`) — historical record
 *   - Benchmark tables (untouched by pipeline run)
 *
 * Wipes (TRUNCATE … CASCADE):
 *   - Stage 1 outputs: market_features, llm_market_normalizations
 *   - Stage 1 queue: stage1_queue
 *   - Stage 2 outputs: questions, question_members, stage23_queue
 *   - Stage 3 outputs: outcome_sets, outcome_set_slots, implication_edges,
 *                       edge_contradictions, arbitrage_opportunities,
 *                       dashboard_pairs, rule_engine_queue,
 *                       rule_engine_decisions, review_verdicts,
 *                       review_verdict_history
 *   - KB: known_entities, entity_category_counts, entity_enrichment_queue,
 *         entity_relations, entity_subjects, market_entity_links,
 *         market_cross_refs
 *
 * Resets (UPDATE, not TRUNCATE):
 *   - platform_events: clears the LLM-populated semantic columns
 *     (canonical_subject, canonical_event, participants, llm_normalized)
 *     while keeping the structural columns from sync.
 *   - markets.category_unified: clears LLM overrides so the next run
 *     re-applies the platform-derived classification + LLM confirmation.
 *     (The `embedding` column is left alone.)
 *
 * Run:
 *   bun services/pipeline/src/scripts/wipe-stage1-to-3.ts             # apply
 *   bun services/pipeline/src/scripts/wipe-stage1-to-3.ts --dry-run   # report
 */

import { query, endPool } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('wipe-stage1-to-3');

// Order is irrelevant since we use CASCADE, but listed in roughly the
// reverse pipeline-stage order for readability.
const TABLES_TO_TRUNCATE = [
  // Event-centric layer — CASCADE clears _platforms / _legs
  'semantic_events',
  'stage3_event_candidates',

  // Stage 3
  'arbitrage_opportunities',
  'dashboard_pairs',
  'edge_contradictions',
  'implication_edges',
  'outcome_set_slots',
  'outcome_sets',
  'review_verdict_history',
  'review_verdicts',
  'rule_engine_decisions',
  'rule_engine_queue',

  // Stage 2
  'question_members',
  'questions',
  'stage23_queue',

  // Stage 1
  'llm_market_normalizations',
  'market_features',
  'stage1_queue',

  // KB / entity layer
  'entity_category_counts',
  'entity_enrichment_queue',
  'entity_relations',
  'entity_subjects',
  'market_cross_refs',
  'market_entity_links',
  'known_entities',
];

async function rowCounts(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const t of TABLES_TO_TRUNCATE) {
    const r = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${t}`);
    out.set(t, parseInt(r[0].n, 10));
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  log.info(`Wiping Stage 1–3 + KB tables${dryRun ? ' (DRY-RUN)' : ''}`);

  const before = await rowCounts();
  let totalRows = 0;
  for (const [t, n] of before.entries()) {
    if (n > 0) log.info(`  ${t.padEnd(32)} ${n.toLocaleString()} rows`);
    totalRows += n;
  }

  // platform_events semantic-reset preview
  const peReset = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM platform_events WHERE llm_normalized = TRUE OR canonical_subject IS NOT NULL`
  );
  log.info(`  platform_events (semantic reset)  ${parseInt(peReset[0].n, 10).toLocaleString()} rows`);

  // markets.category_unified clear preview
  const mClear = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM markets WHERE category_unified IS NOT NULL`
  );
  log.info(`  markets.category_unified (clear)  ${parseInt(mClear[0].n, 10).toLocaleString()} rows`);

  log.info(`Total to wipe: ${totalRows.toLocaleString()} rows across ${TABLES_TO_TRUNCATE.length} tables`);

  if (dryRun) {
    log.info('Dry-run mode — no changes applied');
    await endPool();
    return;
  }

  // One TRUNCATE statement with all tables — Postgres handles ordering
  // internally via CASCADE. RESTART IDENTITY resets SERIAL sequences so
  // entity IDs etc. start fresh.
  log.info('Issuing TRUNCATE …');
  await query(
    `TRUNCATE ${TABLES_TO_TRUNCATE.join(', ')} RESTART IDENTITY CASCADE`,
  );
  log.info('TRUNCATE done');

  // Reset platform_events semantic columns. Structural columns
  // (platform_event_id, grouping_type, title, deadline, child_count) are
  // populated by sync and stay. No RETURNING — at scale, materialising
  // every updated row back to the client is what makes the wipe slow.
  log.info('Resetting platform_events semantic columns …');
  await query(
    `UPDATE platform_events
        SET canonical_subject = NULL,
            canonical_event   = NULL,
            participants      = '{}',
            llm_normalized    = FALSE,
            last_normalized_child_count = NULL,
            embedding         = NULL,
            embedding_model   = NULL,
            embedded_at       = NULL,
            updated_at        = NOW()
      WHERE llm_normalized = TRUE
         OR canonical_subject IS NOT NULL
         OR embedding IS NOT NULL`,
  );
  log.info(`platform_events reset done`);

  // Clear markets.category_unified — Stage 0 (classifyMarketsUnified)
  // recomputes from platform tags/category/title on the next pipeline run.
  // The btree idx_markets_category_unified makes a 1M-row UPDATE slow because
  // every row touches the index; drop it before the UPDATE, recreate after.
  log.info('Dropping idx_markets_category_unified for fast clear …');
  await query(`DROP INDEX IF EXISTS idx_markets_category_unified`);
  log.info('Clearing markets.category_unified …');
  await query(`UPDATE markets SET category_unified = NULL WHERE category_unified IS NOT NULL`);
  log.info('Recreating idx_markets_category_unified …');
  await query(`CREATE INDEX idx_markets_category_unified ON markets (category_unified)`);
  log.info('markets.category_unified cleared');

  // Confirm embeddings preserved
  const embedCheck = await query<{ rows: string; with_emb: string }>(
    `SELECT COUNT(*)::text AS rows,
            COUNT(*) FILTER (WHERE embedding IS NOT NULL)::text AS with_emb
       FROM markets`,
  );
  log.info(
    `markets: ${parseInt(embedCheck[0].rows, 10).toLocaleString()} rows, ` +
    `${parseInt(embedCheck[0].with_emb, 10).toLocaleString()} with embeddings (preserved)`,
  );

  await endPool();
  log.info('Wipe complete. Next pipeline run will reseed KB and rebuild Stage 1–3.');
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
