/**
 * Manual one-shot runner for the daemon health-checks. Exits 0 always —
 * health checks are advisory. Use for ad-hoc inspection or CI smoke tests.
 */
import { runHealthChecks } from '../services/pipeline/src/db/health-checks.js';

const rows = await runHealthChecks();
console.log('');
console.log(JSON.stringify(rows, null, 2));
process.exit(0);
