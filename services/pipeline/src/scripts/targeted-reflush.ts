/**
 * Targeted re-flush: applies KB/subject corrections to the live graph without
 * a full wipe+rerun. The expensive stages (Stage-1 featurization + the
 * Stage-3 LLM matcher) are reused, not re-run.
 *
 * Why this is sound:
 *  · questions are upserted by a stable canonical_key (sem:event:outcome /
 *    pe:...) with ON CONFLICT DO UPDATE — a re-resolved canonical_subject
 *    updates the row in place, no re-keying, no orphans.
 *  · runEventGraph({skipLlm:true}) reuses existing semantic_events (the
 *    matcher drains only pending candidates) and re-runs only the
 *    deterministic projection + edge build; resolveEventIdentity re-pulls
 *    subjects from the corrected KB.
 *  · finalize does not clear implication_edges (builders are
 *    first-writer-wins ON CONFLICT DO NOTHING) — so this script truncates
 *    the stage-2-4 outputs first (questions+outcome_sets CASCADE →
 *    members/edges/contradictions/arbs/slots), keeping semantic_events,
 *    normalizations, KB, market_cross_refs, markets.
 *
 * A Stage-3 match-grouping fix is not flushed by this pass: it lives in which
 * markets were grouped into a question, and skipLlm reuses that match, so
 * such fixes persist until a targeted re-match.
 *
 * Run: bun run services/pipeline/src/scripts/targeted-reflush.ts
 */
import 'dotenv/config';
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { seedEntityKB } from '../db/seed-entity-kb.js';
import { backfillSubjectsViaKB } from '../db/entity/backfill.js';
import { runEventGraph } from '../run-event-graph.js';
import { withOfflineEdgeBuilderBound } from '../stage4-events/run-edge-builder.js';
import { flushBeltCensus, resetBeltCensus } from '../discriminators/telemetry.js';

const log = createLogger('targeted-reflush');

async function counts(label: string): Promise<void> {
  const r = await query<{ q: number; e: number; s: number; se: number }>(
    `SELECT (SELECT count(*) FROM questions)::int q,
            (SELECT count(*) FROM implication_edges)::int e,
            (SELECT count(*) FROM outcome_sets)::int s,
            (SELECT count(*) FROM semantic_events)::int se`,
  );
  log.info(`${label}: ${JSON.stringify(r[0])}`);
}

async function main(): Promise<void> {
  await counts('BEFORE');

  // 1. Correct the KB: same-city seeds (+ poison-alias removal) + the wired
  //    league-dedup fold. Idempotent on a populated DB (structural seed gated off).
  log.info('Step 1: seedEntityKB() — RC2 seeds + league dedup…');
  const seed = await seedEntityKB();
  log.info(
    `  sameCityCodes: ${JSON.stringify(seed.sameCityCodes)}; ` +
    `namesakeCodes: ${JSON.stringify(seed.namesakeCodes)}; ` +
    `leagueDedup: ${JSON.stringify(seed.leagueDedup)}`,
  );

  // 2. Re-resolve canonical_subject across llm_market_normalizations through
  //    the now-corrected KB (no marketIds = full re-resolve).
  log.info('Step 2: backfillSubjectsViaKB() — re-resolve subjects…');
  const bf = await backfillSubjectsViaKB();
  log.info(`  1f: ${bf.checked} tuples checked, ${bf.updated} markets + ${bf.eventsUpdated} platform_events updated`);

  // 3. Clear the stage-2-4 OUTPUTS only (CASCADE pulls members/edges/
  //    contradictions/arbs/slots). Keeps semantic_events (matches),
  //    normalizations, KB, market_cross_refs (cross-ref input), markets.
  log.info('Step 3: TRUNCATE questions, outcome_sets RESTART IDENTITY CASCADE…');
  await query('TRUNCATE TABLE questions, outcome_sets RESTART IDENTITY CASCADE');

  // 4. Re-project questions + rebuild the full edge graph, reusing the
  //    existing Stage-3 LLM matches (skipLlm). Corrected subjects flow into
  //    the projected questions.
  log.info('Step 4: runEventGraph({skipLlm:true}) — re-project + rebuild edges…');
  try {
    // This script rebuilds the edge graph from truncated tables, where a
    // statement_timeout skip means a permanently missing edge class (not the
    // live loop's recall-only skip), so it opts into the offline builder
    // bound explicitly — see stage4-events/run-edge-builder.ts.
    const eg = await withOfflineEdgeBuilderBound(() => runEventGraph({ skipLlm: true }));
    log.info(`  stage4: ${eg.stage4.outcomeNodes} nodes, ${eg.stage4.outcomeSets} sets`);
  } finally {
    // 5. Emit the belt/disc/rollup census line so this targeted pass is
    //    census-readable. runEventGraph accumulates the beltHit/discCount/
    //    rollupCount counters in-memory but does not flush them itself; flush
    //    in finally so a mid-projection failure still surfaces the belts.
    flushBeltCensus((m) => log.info(m));
    resetBeltCensus();
  }

  await counts('AFTER');
  log.info('Targeted re-flush complete.');
}

main().then(() => process.exit(0)).catch((err) => { log.error(String(err)); process.exit(1); });
