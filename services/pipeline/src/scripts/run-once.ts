/**
 * One-shot full pipeline run — the operator rebuild entry point.
 *
 * index.ts runs runPipeline() and then tail-schedules forever (daemon-ish);
 * this script runs exactly ONE full pass and exits, which is what the
 * wipe→rebuild operator flow needs (scripts/wipe-stage1-3-and-kb.sql → this).
 * Exit code 0 on success, 1 on a failed run (run.ts already records the
 * failure in pipeline_runs and republishes the error).
 */
import 'dotenv/config';
import { createLogger } from '@arb/logger';
import { runPipeline } from '../run.js';

const log = createLogger('run-once');

try {
  await runPipeline();
  log.info('run-once: full pipeline pass complete');
  process.exit(0);
} catch (err) {
  log.error('run-once: pipeline pass FAILED:', err);
  process.exit(1);
}
