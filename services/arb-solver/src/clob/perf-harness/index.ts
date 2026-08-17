import 'dotenv/config';
import { join } from 'node:path';
import type { Platform } from '@arb/types';
import { runHarness, type HarnessOptions } from './run.js';

/**
 * CLOB perf harness — isolated CLOB reconstruction + latency monitor.
 *
 * NOT wired into the arb-solver. Subscribes to live CLOB feeds, reconstructs
 * full orderbooks via the production adapters, captures wire-arrival /
 * server / emit timestamps for every tick, and writes per-platform JSONL
 * traces + a final summary.json.
 *
 * Usage:
 *   bun run src/clob/perf-harness/index.ts                       # defaults
 *   bun run src/clob/perf-harness/index.ts --duration-min 10
 *   bun run src/clob/perf-harness/index.ts --platform kalshi --max-subs 500
 *   bun run src/clob/perf-harness/index.ts --no-jsonl            # console-only
 *   bun run src/clob/perf-harness/index.ts --out data/clob-perf  # output root
 *
 * Flags:
 *   --duration-min N       (default 5)   stop after N minutes
 *   --platform P                          restrict to one platform
 *   --max-subs N                          cap subscriptions
 *   --min-edge-conf F      (default 0.7)  edge-confidence threshold
 *   --summary-sec N        (default 10)   console summary cadence
 *   --stale-after-sec N    (default 60)   tick-gap to call a market stale
 *   --no-jsonl                            skip per-tick JSONL writes
 *   --all-open                            subscribe to ALL open markets (any
 *                                          platform), not just the edge-graph
 *                                          cluster set; useful when the graph
 *                                          is single-platform or empty
 *   --dump-raw [N]                        print first N (default 10) raw wire
 *                                          payloads per adapter to stderr so
 *                                          you can verify what each platform
 *                                          actually sends. Sets CLOB_DUMP_RAW=1
 *                                          for the adapters before construct.
 *   --no-both-poly-sides                  do NOT subscribe to NO clobTokenId
 *                                          for Polymarket (YES-only mode, for
 *                                          comparing against legacy behavior)
 *   --no-expand-limitless-groups          do NOT expand limitless group
 *                                          wrappers to child slugs
 *   --out PATH             (default data/clob-perf)
 */

function parseArgs(argv: string[]): HarnessOptions {
  const args = argv.slice(2);
  const get = (flag: string, dflt?: string): string | undefined => {
    const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i < 0) return dflt;
    const a = args[i];
    if (a.includes('=')) return a.split('=', 2)[1];
    return args[i + 1];
  };
  const has = (flag: string): boolean => args.includes(flag);

  const durationMin = parseFloat(get('--duration-min', '5')!);
  const platform = get('--platform') as Platform | undefined;
  const maxSubsRaw = get('--max-subs');
  const minEdgeConfidence = parseFloat(get('--min-edge-conf', '0.7')!);
  const summarySec = parseInt(get('--summary-sec', '10')!, 10);
  const staleAfterSec = parseInt(get('--stale-after-sec', '60')!, 10);
  const writeJsonl = !has('--no-jsonl');
  const allOpen = has('--all-open');
  const bothPolymarketSides = !has('--no-both-poly-sides');
  const expandLimitlessGroups = !has('--no-expand-limitless-groups');
  const outRoot = get('--out', join(process.cwd(), 'data', 'clob-perf'))!;

  // --dump-raw [N] or --dump-raw=N — set env vars BEFORE the harness imports
  // any adapter so BaseClobAdapter's static rawDumpsLeft picks them up.
  if (has('--dump-raw') || args.some((a) => a.startsWith('--dump-raw'))) {
    const raw = get('--dump-raw');
    process.env.CLOB_DUMP_RAW = '1';
    if (raw && /^\d+$/.test(raw)) {
      process.env.CLOB_DUMP_RAW_LIMIT = raw;
    }
  }

  if (platform && !['kalshi', 'polymarket', 'limitless', 'predict'].includes(platform)) {
    throw new Error(`bad --platform ${platform}`);
  }

  return {
    durationMs: durationMin * 60_000,
    minEdgeConfidence,
    outRoot,
    platform,
    maxSubs: maxSubsRaw ? parseInt(maxSubsRaw, 10) : undefined,
    summaryIntervalSec: summarySec,
    staleAfterMs: staleAfterSec * 1000,
    writeJsonl,
    allOpen,
    bothPolymarketSides,
    expandLimitlessGroups,
  };
}

const opts = parseArgs(process.argv);
runHarness(opts).catch((err) => {
  console.error('[clob-perf] fatal:', err);
  process.exit(1);
});
