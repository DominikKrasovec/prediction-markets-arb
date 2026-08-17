import 'dotenv/config';
import { createLogger } from '@arb/logger';
import { runPipeline } from './run.js';
import { runDaemon } from './daemon.js';
import { runHealthChecks } from './db/health-checks.js';
import { config } from './config.js';

const log = createLogger('pipeline');

async function main() {
  if (process.env.PIPELINE_MODE === 'daemon') {
    log.info('Running in daemon mode (PIPELINE_MODE=daemon)');
    await runDaemon(); // never returns
    return;
  }

  await runPipeline();

  // Once per process, not per tick: the checks full-scan markets x
  // market_features + aggregate market_entity_links, fine as a startup
  // diagnostic but too heavy for every interval tick. Read-only + log-only;
  // failures never block the schedule loop.
  try {
    await runHealthChecks();
  } catch (err) {
    log.error('Health checks failed (continuing):', err);
  }

  // Tail-scheduler: the next tick is scheduled after the current run
  // finishes, so a slow run can never overlap with the next interval firing.
  log.info(`Pipeline interval: ${config.intervals.fullRunMs}ms`);
  const scheduleNext = () => {
    setTimeout(async () => {
      try {
        await runPipeline();
      } catch (err) {
        log.error('Run error:', err);
      }
      scheduleNext();
    }, config.intervals.fullRunMs);
  };
  scheduleNext();
}

main().catch((err) => {
  log.error('Fatal error:', err);
  process.exit(1);
});
