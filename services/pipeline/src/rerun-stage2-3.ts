/**
 * One-shot driver: rerun the event-centric graph build (2b → 4) only,
 * preserving Stage 1 output (features / normalizations / market embeddings).
 * Run via `bun run src/rerun-stage2-3.ts` from services/pipeline.
 */
import { runEventGraph } from './run-event-graph.js';
import { endPool } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('rerun');

async function main() {
  const t0 = Date.now();
  const r = await runEventGraph({ skipLlm: process.env.STAGE3_SKIP_LLM === '1' });
  log.info(
    `event-graph: ${r.stage4.outcomeNodes} outcome-nodes, ${r.stage4.outcomeSets} sets, ` +
    `${r.match.matched + r.match.expanded} matched events, ${r.stage4.thresholdEdges} threshold edges`,
  );
  log.info(`done: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await endPool();
}

main().catch((e) => { log.error('fatal:', e); process.exit(1); });
