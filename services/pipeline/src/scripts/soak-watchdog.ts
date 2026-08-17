/**
 * Stateless observability probe for the continuous-run daemon, meant to be
 * scheduled every ~15 min: runs six checks (pg reachable, heartbeat freshness,
 * work-loop wedge detection, LLM cost, DB size/growth, queue depths, wall-clock
 * gap) and exits non-zero with a `WATCHDOG-ALERT:` line per failing check.
 * All WATCHDOG_* tunables are env-overridable caps (see envInt/envFloat calls
 * below for defaults). Run: `npx tsx services/pipeline/src/scripts/soak-watchdog.ts`.
 */
import 'dotenv/config';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { query, endPool } from '@arb/db';

// Pure check core (unit-tested with mocked inputs; no DB, no I/O).

export const GB = 1024 ** 3;

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  detail: Record<string, unknown>;
}

export interface PrevState {
  atMs: number | null;
  dbBytes: number | null;
  stage1Pending: number | null;
  stage3Pending: number | null;
  stage23Depth: number | null;
  beats: number | null;
}

function prettyBytes(b: number): string {
  if (b >= GB) return `${(b / GB).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${b} B`;
}

export function evaluateHeartbeat(p: {
  beatAtMs: number | null;
  nowMs: number;
  maxAgeMs: number;
  beats?: number | null;
  prevBeats?: number | null;
}): CheckResult {
  if (p.beatAtMs === null) {
    return {
      name: 'daemon_heartbeat',
      ok: false,
      message:
        'no heartbeat row — daemon not running, never started, or running a ' +
        'pre-heartbeat build (deploy migration 091 + restart the daemon)',
      detail: { beat_age_s: null, beats: p.beats ?? null },
    };
  }
  const ageMs = p.nowMs - p.beatAtMs;
  const ok = ageMs <= p.maxAgeMs;
  const beatsAdvanced =
    p.beats != null && p.prevBeats != null ? p.beats - p.prevBeats : null;
  return {
    name: 'daemon_heartbeat',
    ok,
    message: ok
      ? `heartbeat fresh (${(ageMs / 1000).toFixed(0)}s old)`
      : `heartbeat STALE — ${(ageMs / 1000).toFixed(0)}s old > ${(p.maxAgeMs / 1000).toFixed(0)}s max; daemon dead/wedged or host slept`,
    detail: {
      beat_age_s: Math.round(ageMs / 1000),
      max_age_s: Math.round(p.maxAgeMs / 1000),
      beats: p.beats ?? null,
      beats_advanced_since_prev: beatsAdvanced,
    },
  };
}

// Wedged-but-alive detection: a missing/pre-stamp `loops` object passes tolerantly (check 2 owns liveness; this only adds the wedge signal atop a fresh beat).
export function evaluateLoopProgress(p: {
  loops: Record<string, { last_tick_at?: unknown; ticks?: unknown }> | null | undefined;
  heartbeatFresh: boolean;
  nowMs: number;
  maxAgeMs: number;
}): CheckResult {
  const entries = p.loops != null ? Object.entries(p.loops) : [];
  if (entries.length === 0) {
    return {
      name: 'work_loop_progress',
      ok: true,
      message: 'no loop stamps in heartbeat detail (pre-stamp daemon build or no heartbeat) — check abstains',
      detail: { loops: null },
    };
  }
  const stale: string[] = [];
  const detail: Record<string, unknown> = {};
  for (const [name, v] of entries) {
    const at = typeof v?.last_tick_at === 'string' ? Date.parse(v.last_tick_at) : NaN;
    const ageS = Number.isNaN(at) ? null : Math.round((p.nowMs - at) / 1000);
    detail[name] = { age_s: ageS, ticks: v?.ticks ?? null };
    if (ageS == null || ageS * 1000 > p.maxAgeMs) stale.push(`${name} (${ageS ?? '?'}s)`);
  }
  // Only alert on a fresh heartbeat, or a dead daemon and a wedged one double-report the same death.
  const ok = stale.length === 0 || !p.heartbeatFresh;
  return {
    name: 'work_loop_progress',
    ok,
    message: ok
      ? stale.length === 0
        ? `all ${entries.length} work loops ticking (cap ${(p.maxAgeMs / 1000).toFixed(0)}s)`
        : 'stale loop stamps but heartbeat also stale — deferring to daemon_heartbeat'
      : `daemon WEDGED — heartbeat fresh but work loop(s) stalled: ${stale.join(', ')} > ${(p.maxAgeMs / 1000).toFixed(0)}s cap`,
    detail,
  };
}

export function evaluateLlmCost(p: {
  costUsd: number;
  calls: number;
  limitUsd: number;
}): CheckResult {
  const ok = p.costUsd <= p.limitUsd;
  return {
    name: 'llm_cost_today',
    ok,
    message: ok
      ? `$${p.costUsd.toFixed(2)} today across ${p.calls} calls (limit $${p.limitUsd.toFixed(2)})`
      : `LLM spend $${p.costUsd.toFixed(2)} today EXCEEDS limit $${p.limitUsd.toFixed(2)} (${p.calls} calls) — possible candidate re-arm / runaway drain (F-1)`,
    detail: { cost_usd: Number(p.costUsd.toFixed(4)), calls: p.calls, limit_usd: p.limitUsd },
  };
}

export function evaluateDbSize(p: {
  currentBytes: number;
  maxBytes: number;
  prevBytes: number | null;
  prevAtMs: number | null;
  nowMs: number;
  maxGrowthBytesPerHr: number;
}): CheckResult {
  let growthBytesPerHr: number | null = null;
  if (p.prevBytes != null && p.prevAtMs != null) {
    const hours = (p.nowMs - p.prevAtMs) / 3_600_000;
    if (hours > 0) growthBytesPerHr = (p.currentBytes - p.prevBytes) / hours;
  }
  const overAbsolute = p.currentBytes > p.maxBytes;
  const overGrowth =
    growthBytesPerHr != null && growthBytesPerHr > p.maxGrowthBytesPerHr;
  const ok = !overAbsolute && !overGrowth;
  const parts: string[] = [`db size ${prettyBytes(p.currentBytes)}`];
  if (overAbsolute) parts.push(`OVER cap ${prettyBytes(p.maxBytes)}`);
  if (growthBytesPerHr != null)
    parts.push(
      `growth ${(growthBytesPerHr / GB).toFixed(2)} GB/hr` +
        (overGrowth ? ` OVER ${(p.maxGrowthBytesPerHr / GB).toFixed(2)} GB/hr cap` : ''),
    );
  return {
    name: 'db_size',
    ok,
    message: parts.join('; '),
    detail: {
      db_bytes: p.currentBytes,
      db_pretty: prettyBytes(p.currentBytes),
      max_bytes: p.maxBytes,
      growth_gb_per_hr:
        growthBytesPerHr != null ? Number((growthBytesPerHr / GB).toFixed(3)) : null,
    },
  };
}

export function evaluateQueueDepth(p: {
  name: string;
  depth: number;
  prevDepth: number | null;
  maxDepth: number;
}): CheckResult {
  const ok = p.depth <= p.maxDepth;
  const delta = p.prevDepth != null ? p.depth - p.prevDepth : null;
  return {
    name: p.name,
    ok,
    message: ok
      ? `${p.name} depth ${p.depth}${delta != null ? ` (Δ ${delta >= 0 ? '+' : ''}${delta})` : ''} (cap ${p.maxDepth})`
      : `${p.name} depth ${p.depth} EXCEEDS runaway cap ${p.maxDepth}${delta != null ? ` (Δ ${delta >= 0 ? '+' : ''}${delta} since last run)` : ''}`,
    detail: { depth: p.depth, prev_depth: p.prevDepth, delta, max_depth: p.maxDepth },
  };
}

export function evaluateWallClockGap(p: {
  prevAtMs: number | null;
  nowMs: number;
  intervalMs: number;
  gapFactor: number;
}): CheckResult {
  if (p.prevAtMs == null) {
    return {
      name: 'wall_clock_gap',
      ok: true,
      message: 'first run — no previous timestamp to compare',
      detail: { gap_s: null, expected_interval_s: Math.round(p.intervalMs / 1000) },
    };
  }
  const gapMs = p.nowMs - p.prevAtMs;
  const maxGapMs = p.intervalMs * p.gapFactor;
  const ok = gapMs <= maxGapMs;
  return {
    name: 'wall_clock_gap',
    ok,
    message: ok
      ? `gap ${(gapMs / 1000).toFixed(0)}s since last run (interval ${(p.intervalMs / 1000).toFixed(0)}s)`
      : `gap ${(gapMs / 1000).toFixed(0)}s ≫ ${(p.intervalMs / 1000).toFixed(0)}s×${p.gapFactor} — host slept or scheduler stalled (missed runs)`,
    detail: {
      gap_s: Math.round(gapMs / 1000),
      expected_interval_s: Math.round(p.intervalMs / 1000),
      max_gap_s: Math.round(maxGapMs / 1000),
    },
  };
}

// Scans backwards for the last parseable object carrying a `ts`; tolerant of interleaved WATCHDOG-ALERT lines and partial writes.
export function parsePrevState(logContent: string): PrevState {
  const empty: PrevState = {
    atMs: null,
    dbBytes: null,
    stage1Pending: null,
    stage3Pending: null,
    stage23Depth: null,
    beats: null,
  };
  const lines = logContent.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.ts !== 'string') continue;
      const atMs = Date.parse(o.ts);
      return {
        atMs: Number.isNaN(atMs) ? null : atMs,
        dbBytes: typeof o.db_bytes === 'number' ? o.db_bytes : null,
        stage1Pending: typeof o.stage1_pending === 'number' ? o.stage1_pending : null,
        stage3Pending: typeof o.stage3_pending === 'number' ? o.stage3_pending : null,
        stage23Depth: typeof o.stage23_depth === 'number' ? o.stage23_depth : null,
        beats:
          o.checks?.daemon_heartbeat?.beats != null
            ? Number(o.checks.daemon_heartbeat.beats)
            : null,
      };
    } catch {
      // partial/corrupt line — keep scanning older lines
    }
  }
  return empty;
}

export function buildStatus(
  checks: CheckResult[],
  metrics: {
    nowMs: number;
    dbBytes: number | null;
    stage1Pending: number | null;
    stage3Pending: number | null;
    stage23Depth: number | null;
    llmCostToday: number | null;
  },
): { status: Record<string, unknown>; alertLines: string[]; ok: boolean } {
  const ok = checks.every((c) => c.ok);
  const status: Record<string, unknown> = {
    ts: new Date(metrics.nowMs).toISOString(),
    ok,
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    checks: Object.fromEntries(
      checks.map((c) => [c.name, { ok: c.ok, message: c.message, ...c.detail }]),
    ),
    db_bytes: metrics.dbBytes,
    stage1_pending: metrics.stage1Pending,
    stage3_pending: metrics.stage3Pending,
    stage23_depth: metrics.stage23Depth,
    llm_cost_today: metrics.llmCostToday,
    host: os.hostname(),
    pid: process.pid,
  };
  const alertLines = checks
    .filter((c) => !c.ok)
    .map((c) => `WATCHDOG-ALERT: ${c.name} — ${c.message}`);
  return { status, alertLines, ok };
}

// DB glue + main (not unit-tested; exercised by running the script).

function envInt(name: string, def: number): number {
  const v = process.env[name];
  const n = v != null ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}
function envFloat(name: string, def: number): number {
  const v = process.env[name];
  const n = v != null ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

async function safeRows<T>(sql: string, params?: unknown[]): Promise<T[] | null> {
  try {
    return await query<T>(sql, params as any[]);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const logPath = path.resolve(
    process.env.WATCHDOG_LOG_PATH ?? 'data/exports/soak-watchdog.log',
  );

  let prev: PrevState = parsePrevState('');
  try {
    if (fs.existsSync(logPath)) prev = parsePrevState(fs.readFileSync(logPath, 'utf8'));
  } catch {
    // unreadable log — proceed with empty prev state
  }

  const checks: CheckResult[] = [];
  const metrics = {
    nowMs,
    dbBytes: null as number | null,
    stage1Pending: null as number | null,
    stage3Pending: null as number | null,
    stage23Depth: null as number | null,
    llmCostToday: null as number | null,
  };

  const ping = await safeRows<{ one: number }>('SELECT 1 AS one');
  const pgReachable = ping != null;
  checks.push({
    name: 'pg_reachable',
    ok: pgReachable,
    message: pgReachable
      ? 'postgres reachable'
      : `postgres UNREACHABLE at ${process.env.PG_HOST ?? 'localhost'}:${process.env.PG_PORT ?? '5433'}`,
    detail: { host: process.env.PG_HOST ?? 'localhost', port: process.env.PG_PORT ?? '5433' },
  });

  if (pgReachable) {
    const hbRows = await safeRows<{ beat_ms: number; beats: number; detail: Record<string, unknown> | null }>(
      `SELECT EXTRACT(EPOCH FROM beat_at) * 1000 AS beat_ms, beats, detail
         FROM pipeline_heartbeats WHERE component = $1`,
      [process.env.WATCHDOG_HEARTBEAT_COMPONENT ?? 'daemon'],
    );
    const hb = hbRows && hbRows.length > 0 ? hbRows[0] : null;
    const hbCheck = evaluateHeartbeat({
      beatAtMs: hb ? Number(hb.beat_ms) : null,
      nowMs,
      maxAgeMs: envInt('WATCHDOG_HEARTBEAT_MAX_AGE_S', 300) * 1000,
      beats: hb ? Number(hb.beats) : null,
      prevBeats: prev.beats,
    });
    checks.push(hbCheck);

    checks.push(
      evaluateLoopProgress({
        loops: (hb?.detail as { loops?: Record<string, { last_tick_at?: unknown; ticks?: unknown }> } | null)?.loops,
        heartbeatFresh: hbCheck.ok,
        nowMs,
        maxAgeMs: envInt('WATCHDOG_LOOP_STALL_MAX_AGE_S', 3600) * 1000,
      }),
    );

    const costRows = await safeRows<{ usd: number; n: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::float AS usd, count(*)::int AS n
         FROM llm_logs WHERE created_at::date = CURRENT_DATE`,
    );
    if (costRows && costRows.length > 0) {
      metrics.llmCostToday = Number(costRows[0].usd);
      checks.push(
        evaluateLlmCost({
          costUsd: Number(costRows[0].usd),
          calls: Number(costRows[0].n),
          limitUsd: envFloat('WATCHDOG_LLM_COST_LIMIT_USD', 20),
        }),
      );
    } else {
      checks.push({
        name: 'llm_cost_today',
        ok: false,
        message: 'could not read llm_logs (missing table or query error)',
        detail: {},
      });
    }

    const sizeRows = await safeRows<{ b: number }>(
      'SELECT pg_database_size(current_database())::float AS b',
    );
    if (sizeRows && sizeRows.length > 0) {
      metrics.dbBytes = Number(sizeRows[0].b);
      checks.push(
        evaluateDbSize({
          currentBytes: Number(sizeRows[0].b),
          maxBytes: envFloat('WATCHDOG_DB_SIZE_MAX_GB', 35) * GB,
          prevBytes: prev.dbBytes,
          prevAtMs: prev.atMs,
          nowMs,
          maxGrowthBytesPerHr: envFloat('WATCHDOG_DB_GROWTH_MAX_GB_PER_HR', 2) * GB,
        }),
      );
    }

    const qRows = await safeRows<{ s1: number; s3: number; s23: number }>(
      `SELECT (SELECT count(*) FROM stage1_queue WHERE status = 'pending')::int AS s1,
              (SELECT count(*) FROM stage3_event_candidates WHERE status = 'pending')::int AS s3,
              (SELECT count(*) FROM stage23_queue)::int AS s23`,
    );
    if (qRows && qRows.length > 0) {
      metrics.stage1Pending = Number(qRows[0].s1);
      metrics.stage3Pending = Number(qRows[0].s3);
      metrics.stage23Depth = Number(qRows[0].s23);
      checks.push(
        evaluateQueueDepth({
          name: 'stage1_queue',
          depth: Number(qRows[0].s1),
          prevDepth: prev.stage1Pending,
          maxDepth: envInt('WATCHDOG_STAGE1_QUEUE_MAX', 200_000),
        }),
      );
      checks.push(
        evaluateQueueDepth({
          name: 'stage3_queue',
          depth: Number(qRows[0].s3),
          prevDepth: prev.stage3Pending,
          maxDepth: envInt('WATCHDOG_STAGE3_QUEUE_MAX', 50_000),
        }),
      );
    }
  }

  checks.push(
    evaluateWallClockGap({
      prevAtMs: prev.atMs,
      nowMs,
      intervalMs: envInt('WATCHDOG_INTERVAL_S', 900) * 1000,
      gapFactor: envInt('WATCHDOG_GAP_FACTOR', 3),
    }),
  );

  const { status, alertLines, ok } = buildStatus(checks, metrics);
  const jsonLine = JSON.stringify(status);

  process.stdout.write(jsonLine + '\n');
  for (const line of alertLines) process.stdout.write(line + '\n');

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, [jsonLine, ...alertLines].join('\n') + '\n');
  } catch (err) {
    process.stderr.write(`WATCHDOG-ALERT: log_write — could not append to ${logPath}: ${String(err)}\n`);
  }

  await endPool().catch(() => {});
  process.exit(ok ? 0 : 1);
}

// Only run when invoked directly (the .test.ts imports the pure fns above).
if (process.argv[1]?.includes('soak-watchdog')) {
  main().catch((err) => {
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), ok: false, failed: ['watchdog_crash'], error: String(err) }) + '\n',
    );
    process.stdout.write(`WATCHDOG-ALERT: watchdog_crash — ${String(err)}\n`);
    endPool().finally(() => process.exit(1));
  });
}
