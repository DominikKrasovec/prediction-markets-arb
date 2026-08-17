/**
 * Phase 3 LIVE — runs classifyKalshiEvents() with writes enabled.
 * Returns the verdict counts. Idempotent — safe to re-run.
 */
import { classifyKalshiEvents } from '../services/pipeline/src/db/sync.js';

const result = await classifyKalshiEvents({ dryRun: false });
console.log(JSON.stringify(result, null, 2));
process.exit(0);
