/**
 * Daemon liveness heartbeat.
 *
 * The continuous-run daemon (`daemon.ts`) has three infinite loops but
 * nothing an external observer can poll to tell "the process is alive and
 * ticking" apart from "the host slept / the process died / a loop wedged on
 * a long await". An unattended long-running soak needs that pulse.
 *
 * A dedicated timer (NOT one of the work loops — those can block for minutes
 * inside a single `await runEventGraph(...)`, during which a loop-driven beat
 * would starve and read as a false death) upserts ONE row into
 * `pipeline_heartbeats` keyed on a component name (default 'daemon') every
 * DAEMON_HEARTBEAT_INTERVAL_MS. `soak-watchdog.ts` reads `beat_at` back and
 * alerts when it is stale.
 *
 * The timer is `unref()`-ed so it never keeps the process alive on its own, and
 * every write is best-effort (a transient DB blip must not crash the daemon —
 * the watchdog will catch a sustained gap).
 *
 * DDL also lives in `docker/migrations/091_pipeline_heartbeats.sql` +
 * `docker/init.sql`; `ensurePipelineHeartbeats()` runs it here (IF NOT EXISTS,
 * idempotent) as a safety net because there is NO automatic migration runner
 * (mirrors `ensureEventEmbeddingCache`, migration 090).
 */
import os from 'node:os';
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('heartbeat');

/** Canonical DDL — byte-identical to migration 091 + docker/init.sql. */
export const PIPELINE_HEARTBEATS_DDL = `
CREATE TABLE IF NOT EXISTS pipeline_heartbeats (
  component  TEXT PRIMARY KEY,
  beat_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pid        INTEGER,
  hostname   TEXT,
  beats      BIGINT NOT NULL DEFAULT 0,
  detail     JSONB
)`;

let ensured = false;
/** Create the heartbeats table if missing (idempotent; runs once per process). */
export async function ensurePipelineHeartbeats(): Promise<void> {
  if (ensured) return;
  await query(PIPELINE_HEARTBEATS_DDL);
  ensured = true;
}

/** Test hook — reset the once-per-process guard. */
export function _resetPipelineHeartbeatsEnsuredForTests(): void {
  ensured = false;
}

/**
 * Upsert a single heartbeat row: bump `beat_at` to NOW(), increment the beat
 * counter, refresh pid/hostname, attach optional detail. Best-effort — never
 * throws to the caller.
 */
export async function writeHeartbeat(
  component = 'daemon',
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO pipeline_heartbeats (component, beat_at, pid, hostname, beats, detail)
       VALUES ($1, NOW(), $2, $3, 1, $4)
       ON CONFLICT (component) DO UPDATE
         SET beat_at  = NOW(),
             pid      = EXCLUDED.pid,
             hostname = EXCLUDED.hostname,
             beats    = pipeline_heartbeats.beats + 1,
             detail   = EXCLUDED.detail`,
      [component, process.pid, os.hostname(), detail ? JSON.stringify(detail) : null],
    );
  } catch (err) {
    log.warn(`heartbeat write failed (continuing): ${String(err)}`);
  }
}

/** Handle returned by {@link startHeartbeat} so callers can stop the timer. */
export interface HeartbeatHandle {
  stop(): void;
}

/**
 * Start the periodic heartbeat. Writes one beat immediately (so a fresh process
 * is visible without waiting a full interval), then every `intervalMs`. The
 * interval timer is `unref()`-ed so it does not, by itself, keep the event loop
 * alive. Returns a handle whose `stop()` clears the timer.
 */
export function startHeartbeat(
  component = 'daemon',
  intervalMs = parseInt(process.env.DAEMON_HEARTBEAT_INTERVAL_MS ?? '30000'),
  detail?: () => Record<string, unknown>,
): HeartbeatHandle {
  void writeHeartbeat(component, detail?.());
  const timer = setInterval(() => {
    void writeHeartbeat(component, detail?.());
  }, intervalMs);
  timer.unref?.();
  log.info(`heartbeat started: component=${component} interval=${intervalMs}ms`);
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
