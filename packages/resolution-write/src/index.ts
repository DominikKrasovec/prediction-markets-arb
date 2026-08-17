/**
 * Canonical resolution-write helpers for the arb monorepo.
 *
 * Owns:
 *   - the `markets` UPDATE (idempotency rules + COALESCE semantics)
 *   - the event-bus `markets/resolved` publish payload
 *   - the Polymarket / Limitless winner-from-outcomes parser
 *   - missing-timestamp warnings (so a `new Date()` fallback never silently
 *     contaminates the resolved_at watermark)
 *
 * Consumers (every writer of `markets.resolved_at`):
 *   - services/ingestion: lifecycle watchers, gap-refill, resolution-monitor
 *   - services/arb-solver: CLOB-WSS resolution-event handler
 *
 * Idempotency model — every later writer can fix a missing winning_outcome
 * that an earlier writer left null (e.g. Kalshi `settled` arriving before
 * `result` is populated, or a Polymarket parse that failed), but never
 * overwrite a real winner with null. Achieved with:
 *
 *   WHERE platform = $4 AND platform_id = $5
 *     AND (resolved_at IS NULL OR winning_outcome IS NULL)
 *
 *   SET winning_outcome = COALESCE(winning_outcome, $1),
 *       resolved_at     = COALESCE(resolved_at,     $2),
 *       ...
 *
 * The COALESCE on resolved_at preserves the *first* (most-accurate) timestamp
 * even when a later writer fills in the missing winning_outcome.
 *
 * Return shape: `{outcome, marketId}` — the marketId is needed by arb-solver
 * to evict its in-process price cache + unsubscribe the CLOB adapter the
 * moment the write commits, without a second SELECT. `marketId` is null only
 * when outcome === 'not_found'.
 */

import { withTx } from '@arb/db';
import { publish } from '@arb/event-bus';
import type { Platform } from '@arb/types';
import { createLogger } from '@arb/logger';

const log = createLogger('resolution-write');

/**
 *  - 'created'          : row was newly resolved (resolved_at went non-null)
 *  - 'amended'          : row was already resolved but had no winner; we filled it in
 *  - 'already_resolved' : row exists and was already fully resolved (no-op)
 *  - 'not_found'        : no row exists for this (platform, platform_id)
 *
 * The split between 'already_resolved' and 'not_found' is what lets the
 * resolution-monitor pollers count consecutive-known markets correctly:
 * 'already_resolved' is evidence we've caught up; 'not_found' is just an
 * untracked market and must NOT advance the catch-up counter.
 */
export type ResolutionWriteOutcome =
  | 'created'
  | 'amended'
  | 'already_resolved'
  | 'not_found';

export interface ResolutionWriteResult {
  outcome: ResolutionWriteOutcome;
  /** markets.id of the affected row, or null when outcome === 'not_found'. */
  marketId: number | null;
}

export interface ResolutionWriteInput {
  platform: Platform;
  platformId: string;
  winning: string | null;
  resolvedAt: Date;
  source: string;
}

/**
 * Atomically writes (or amends) a market resolution.
 *
 * Concurrency model: runs inside an explicit transaction with `SELECT ...
 * FOR UPDATE` on the target row. CTE-level `FOR UPDATE` does NOT propagate
 * the lock to the outer UPDATE in Postgres — `prev` would observe a stale
 * snapshot and the returned outcome could mis-classify a created/amended
 * write as a duplicate of a concurrent writer's. Holding the row lock for
 * the duration of the SELECT + UPDATE guarantees the pre-update state we
 * read is the same one the UPDATE acts on.
 */
export async function writeResolution(
  input: ResolutionWriteInput,
): Promise<ResolutionWriteResult> {
  const { platform, platformId, winning, resolvedAt, source } = input;

  return withTx(async (client) => {
    const prevRes = await client.query<{
      id: number;
      was_resolved: boolean;
      had_winner: boolean;
    }>(
      `SELECT id,
              (resolved_at     IS NOT NULL) AS was_resolved,
              (winning_outcome IS NOT NULL) AS had_winner
         FROM markets
        WHERE platform = $1 AND platform_id = $2
        FOR UPDATE`,
      [platform, platformId],
    );
    if (prevRes.rows.length === 0) return { outcome: 'not_found', marketId: null };
    const prev = prevRes.rows[0];

    // Already fully resolved — nothing to do, but the row exists. The
    // outcome must be distinguishable from 'not_found' so callers (poll
    // catch-up logic) can use it as evidence of catching up.
    if (prev.was_resolved && prev.had_winner) {
      return { outcome: 'already_resolved', marketId: prev.id };
    }

    const upd = await client.query(
      `UPDATE markets m
          SET winning_outcome   = COALESCE(m.winning_outcome, $1),
              resolved_at       = COALESCE(m.resolved_at,     $2),
              resolution_source = CASE
                WHEN m.resolved_at IS NULL THEN $3
                ELSE m.resolution_source
              END,
              status            = 'closed',
              updated_at        = NOW()
        WHERE m.id = $4
          AND (m.resolved_at IS NULL OR m.winning_outcome IS NULL)`,
      [winning, resolvedAt, source, prev.id],
    );

    // The lock guarantees no concurrent writer can have flipped state
    // between our SELECT FOR UPDATE and the UPDATE. If the UPDATE didn't
    // touch a row, the row no longer satisfies its WHERE — but per the
    // already-resolved early-return above that's a logic error rather
    // than a race condition. Treat it as already_resolved defensively.
    if (upd.rowCount === 0) return { outcome: 'already_resolved', marketId: prev.id };

    return {
      outcome: prev.was_resolved ? 'amended' : 'created',
      marketId: prev.id,
    };
  });
}

/**
 * Publish a `markets/resolved` event. Errors are swallowed because the event
 * bus may legitimately not be running (e.g. in test or during prefill).
 *
 * `amended` flag distinguishes "first-time resolution" from "winner filled
 * in afterwards" so subscribers can deduplicate or annotate accordingly —
 * an amended write is still authoritative news for an arb-solver that may
 * have observed an earlier null-winner resolution and skipped it.
 */
export async function publishResolved(
  platform: Platform,
  platformId: string,
  winning: string | null,
  resolvedAt: Date,
  amended: boolean = false,
): Promise<void> {
  try {
    await publish({
      channel: 'markets',
      type: 'resolved',
      data: {
        platform,
        platformId,
        winningOutcome: winning,
        resolvedAt: resolvedAt.toISOString(),
        amended,
      },
    });
  } catch {
    // event bus may not be running
  }
}

/**
 * Convenience: write + publish-on-create-or-amend (the most common pattern).
 *
 * Publishes on BOTH 'created' and 'amended' — the latter is critical because
 * a market resolved earlier with a null winner (e.g. Kalshi WSS firing before
 * `result` was populated) gets its winner backfilled by the resolution
 * monitor. The DB is updated, but downstream subscribers (arb-solver) need a
 * fresh event-bus push to re-evaluate the market with the now-known winner.
 * The payload's `amended:true` flag lets subscribers tell the difference.
 */
export async function writeAndPublishResolution(
  input: ResolutionWriteInput,
): Promise<ResolutionWriteResult> {
  const result = await writeResolution(input);
  if (result.outcome === 'created' || result.outcome === 'amended') {
    await publishResolved(
      input.platform,
      input.platformId,
      input.winning,
      input.resolvedAt,
      result.outcome === 'amended',
    );
  }
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Robust winner extraction from Polymarket / Gamma / Limitless-style outcome
 * arrays. Tolerates float imprecision ("0.99999") and rejects ambiguous
 * resolutions where multiple outcomes are at ~1 simultaneously.
 *
 * Returns null if no outcome can be unambiguously identified as the winner.
 */
export function parseWinnerFromOutcomes(
  outcomesRaw: string | string[] | undefined | null,
  pricesRaw: string | string[] | undefined | null,
): string | null {
  let outcomes: string[];
  let prices: number[];
  try {
    outcomes = typeof outcomesRaw === 'string' ? JSON.parse(outcomesRaw) : (outcomesRaw ?? []);
    const pricesArr = typeof pricesRaw === 'string' ? JSON.parse(pricesRaw) : (pricesRaw ?? []);
    prices = pricesArr.map((p: any) => Number(p));
  } catch {
    return null;
  }
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length === 0) return null;
  if (outcomes.length !== prices.length) return null;
  if (prices.some((p) => !Number.isFinite(p))) return null;

  // Identify outcome(s) at >= 0.99 (covers float imprecision around 1.0)
  const WINNER_THRESHOLD = 0.99;
  const winners: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] >= WINNER_THRESHOLD) winners.push(i);
  }
  if (winners.length === 1) return outcomes[winners[0]] ?? null;

  // No outcome at threshold but a clear maximum at >= 0.99 already handled above.
  // Multiple outcomes at threshold = ambiguous → return null (let caller decide).
  return null;
}

/**
 * Coerce a resolution timestamp from a candidate field, logging a warning when
 * we have to fall back to `new Date()`. The caller passes a label so the
 * warning identifies which platform / code-path triggered the fallback.
 *
 * Why this matters: the resolution-monitor checkpoint is computed from
 * MAX(resolved_at). If we silently insert `new Date()` for events that
 * actually resolved hours ago, the watermark moves forward and future polls
 * skip earlier real resolutions.
 */
export function coerceResolvedAt(
  candidate: unknown,
  context: string,
): { resolvedAt: Date; fallback: boolean } {
  if (candidate instanceof Date && !isNaN(candidate.getTime())) {
    return { resolvedAt: candidate, fallback: false };
  }
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    const d = new Date(candidate);
    if (!isNaN(d.getTime())) return { resolvedAt: d, fallback: false };
  }
  log.warn(
    `${context}: no usable timestamp on event — falling back to new Date(). ` +
    `This may inflate the resolution-monitor checkpoint watermark.`,
  );
  return { resolvedAt: new Date(), fallback: true };
}
