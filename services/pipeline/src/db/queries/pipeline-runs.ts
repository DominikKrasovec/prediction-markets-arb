/**
 * Centralized queries for `pipeline_runs` and `pipeline_state` tables.
 */
import { query } from '@arb/db';
import type { Platform } from '@arb/types';

// ── pipeline_runs ──

export async function createPipelineRun(runType: string, triggeredBy: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO pipeline_runs (run_type, triggered_by, status) VALUES ($1, $2, 'running') RETURNING id`,
    [runType, triggeredBy]
  );
  return rows[0].id;
}

export async function updatePhaseStats(runId: number, phase: 1 | 2 | 3, stats: unknown): Promise<void> {
  const col = `phase${phase}_stats`;
  await query(
    `UPDATE pipeline_runs SET ${col} = $1 WHERE id = $2`,
    [JSON.stringify(stats), runId]
  );
}

export async function completePipelineRun(runId: number, phase3Stats: unknown): Promise<void> {
  await query(
    `UPDATE pipeline_runs SET phase3_stats = $1, status = 'completed', completed_at = NOW() WHERE id = $2`,
    [JSON.stringify(phase3Stats), runId]
  );
}

export async function failPipelineRun(runId: number, error: string): Promise<void> {
  await query(
    `UPDATE pipeline_runs SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`,
    [error, runId]
  );
}

// ── pipeline_state (watermarks) ──

export async function getWatermark(platform: Platform): Promise<Date | null> {
  const rows = await query<{ last_synced_at: Date | null }>(
    `SELECT last_synced_at FROM pipeline_state WHERE platform = $1`,
    [platform]
  );
  return rows[0]?.last_synced_at ?? null;
}

export async function setWatermark(platform: Platform, syncedAt: Date, count = 0): Promise<void> {
  await query(
    `INSERT INTO pipeline_state (platform, last_synced_at, markets_count, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (platform) DO UPDATE SET
       last_synced_at = $2,
       markets_count  = COALESCE(pipeline_state.markets_count, 0) + $3,
       updated_at     = NOW()`,
    [platform, syncedAt, count]
  );
}
