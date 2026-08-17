/**
 * lifecycle-bench — CLI entry point.
 *
 * Connects to the selected new-market DISCOVERY feeds, runs for a fixed window,
 * and writes diagnostics (latency / reliability / throughput / detection) to a
 * run dir + prints a markdown report. Writes NOTHING to the DB.
 *
 * Local debug:
 *   bun run services/ingestion/src/bench/run-bench.ts --duration 120
 *   bun run services/ingestion/src/bench/run-bench.ts --platforms polymarket,predict --duration 60 --verbose
 *
 * Server (longer):
 *   bun run services/ingestion/src/bench/run-bench.ts --duration 3600 --label vps --out data/lifecycle-bench
 *
 * Flags:
 *   --duration <sec>        run window (default 120)
 *   --platforms <csv>       subset of kalshi,polymarket,limitless,predict (default all)
 *   --out <dir>             output root (default data/lifecycle-bench)
 *   --label <str>           run label (default hostname)
 *   --predict-poll <sec>    Predict poll interval (default 30)
 *   --status-every <sec>    live status cadence (default 15; 0 = off)
 *   --raw-samples <n>       dump up to n raw payloads per (platform,kind) for
 *                           field discovery → raw-samples.jsonl (default 3; 0 = off)
 *   --kalshi-enrich         resolve Kalshi unified category authoritatively via a
 *                           READ-ONLY fetchEventByTicker lookup (event.category);
 *                           default off → frame-text classification only
 *   --no-ntp                skip SNTP offset (detection latency stays uncorrected)
 *   --verbose               verbose per-feed logging
 */

import 'dotenv/config';
import { hostname } from 'node:os';
import { execSync } from 'node:child_process';
import { BenchSink, type BenchPlatform } from './metrics.js';
import { measureSntpOffset } from './clock.js';
import {
  KalshiLifecycleBench,
  PolymarketLifecycleBench,
  LimitlessLifecycleBench,
} from './lifecycle-bench.js';
import { PredictPollBench } from './predict-poll-bench.js';
import { buildSummary, renderMarkdown } from './report.js';
import { createLogger } from '@arb/logger';

const log = createLogger('lifecycle-bench');

const ALL_PLATFORMS: BenchPlatform[] = ['kalshi', 'polymarket', 'limitless', 'predict'];

interface Args {
  durationSec: number;
  platforms: BenchPlatform[];
  out: string;
  label: string;
  predictPollSec: number;
  statusEverySec: number;
  rawSamples: number;
  kalshiEnrich: boolean;
  ntp: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const platformsRaw = get('--platforms');
  const platforms = platformsRaw
    ? (platformsRaw.split(',').map((p) => p.trim()).filter((p) => ALL_PLATFORMS.includes(p as BenchPlatform)) as BenchPlatform[])
    : ALL_PLATFORMS;
  return {
    durationSec: Number(get('--duration') ?? 120),
    platforms,
    out: get('--out') ?? 'data/lifecycle-bench',
    label: get('--label') ?? hostname(),
    predictPollSec: Number(get('--predict-poll') ?? 30),
    statusEverySec: Number(get('--status-every') ?? 15),
    rawSamples: Number(get('--raw-samples') ?? 3),
    kalshiEnrich: argv.includes('--kalshi-enrich'),
    ntp: !argv.includes('--no-ntp'),
    verbose: argv.includes('--verbose'),
  };
}

function sourceCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log.info(`platforms=${args.platforms.join(',')} duration=${args.durationSec}s out=${args.out} label=${args.label}`);

  const clockOffsetMs = args.ntp ? await measureSntpOffset() : null;
  log.info(`SNTP offset: ${clockOffsetMs === null ? 'unavailable' : clockOffsetMs.toFixed(2) + 'ms'}`);

  const runId = `${args.label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const sink = new BenchSink(args.out, runId, args.rawSamples);
  const startedAtMs = Date.now();
  sink.writeManifest({
    runId, label: args.label, startedAt: new Date(startedAtMs).toISOString(),
    durationSec: args.durationSec, platforms: args.platforms,
    clockOffsetMs, sourceCommit: sourceCommit(), dbWrites: false,
  });

  // ─── Start WSS feeds ─────────────────────────────────────────────────────
  const watchers: { platform: BenchPlatform; watcher: { connect(): Promise<void>; disconnect(): void } }[] = [];
  if (args.platforms.includes('kalshi'))     watchers.push({ platform: 'kalshi', watcher: new KalshiLifecycleBench(sink, clockOffsetMs ?? 0, args.verbose, args.kalshiEnrich) });
  if (args.platforms.includes('polymarket')) watchers.push({ platform: 'polymarket', watcher: new PolymarketLifecycleBench(sink, clockOffsetMs ?? 0, args.verbose) });
  if (args.platforms.includes('limitless'))  watchers.push({ platform: 'limitless', watcher: new LimitlessLifecycleBench(sink, clockOffsetMs ?? 0, args.verbose) });

  const connectResults = await Promise.allSettled(watchers.map((w) => w.watcher.connect()));
  for (const [i, r] of connectResults.entries()) {
    if (r.status === 'rejected') log.error(`${watchers[i].platform} connect failed: ${r.reason?.message ?? r.reason}`);
    else log.info(`${watchers[i].platform} connected ✓`);
  }
  if (args.platforms.includes('kalshi') && args.kalshiEnrich) {
    log.info('kalshi unified-category enrichment: ON (read-only fetchEventByTicker, cached per event)');
  }

  // ─── Start Predict REST poll ─────────────────────────────────────────────
  let predict: PredictPollBench | null = null;
  if (args.platforms.includes('predict')) {
    if (!process.env.PREDICT_API_KEY) {
      log.warn('PREDICT_API_KEY not set — skipping Predict REST poll');
    } else {
      predict = new PredictPollBench(sink, args.predictPollSec * 1000, clockOffsetMs ?? 0);
      predict.start();
      log.info(`predict REST poll (OPEN + RESOLVED heads) every ${args.predictPollSec}s ✓`);
    }
  }

  // ─── Live status ─────────────────────────────────────────────────────────
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  if (args.statusEverySec > 0) {
    statusTimer = setInterval(() => {
      const countDisc = (pl: BenchPlatform, k: 'created' | 'resolved') =>
        sink.discoveries.filter((dd) => dd.platform === pl && dd.kind === k).length;
      const parts = watchers.map(({ platform }) => {
        const m = sink.msgStats.get(platform);
        return `${platform}:msg=${m?.messages ?? 0},new=${countDisc(platform, 'created')},res=${countDisc(platform, 'resolved')}`;
      });
      if (predict) parts.push(`predict:polls=${sink.polls.length},new=${countDisc('predict', 'created')},res=${countDisc('predict', 'resolved')}`);
      const elapsed = ((Date.now() - startedAtMs) / 1000).toFixed(0);
      log.info(`[${elapsed}s/${args.durationSec}s] ${parts.join('  ')}`);
    }, args.statusEverySec * 1000);
  }

  // ─── Run window ──────────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    const timer = setTimeout(finish, args.durationSec * 1000);
    const onSig = () => { clearTimeout(timer); log.info('signal received — stopping early'); finish(); };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });

  // ─── Teardown + report ───────────────────────────────────────────────────
  if (statusTimer) clearInterval(statusTimer);
  for (const { watcher } of watchers) watcher.disconnect();
  predict?.stop();

  const endedAtMs = Date.now();
  const summary = buildSummary(sink, {
    label: args.label, startedAtMs, endedAtMs, clockOffsetMs,
    sourceCommit: sourceCommit(), platforms: args.platforms,
  });

  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(sink.runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const md = renderMarkdown(summary);
  writeFileSync(join(sink.runDir, 'report.md'), md);
  await sink.close();

  console.log('\n' + md + '\n');
  log.info(`run dir: ${sink.runDir}`);
  process.exit(0);
}

main().catch((err) => { log.error('fatal:', err); process.exit(1); });
