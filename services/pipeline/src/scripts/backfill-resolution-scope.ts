/**
 * Stage 1h of the shared ingest-backfill ladder (run-ingest-backfills.ts):
 * stamps markets.resolution_scope for rows a re-sync has not touched since
 * detectResolutionScope (called only from normalizeMarketDoc at sync time)
 * last ran. NULL scope makes Stage-4's DECISIVE_KINDS same-event guard
 * refuse every kalshi-only × PM/predict-only match-winner edge. This pass
 * replays the detector over the stored title + platform-appropriate raw
 * text — the same inputs sync-time detection sees.
 *
 * Idempotent + self-gating: only `resolution_scope IS NULL` rows are scanned,
 * and the detector always returns a concrete value ('unspecified' at
 * minimum), so one converged pass leaves zero NULL rows (new syncs stamp
 * inline via normalizeMarketDoc; the sentinel belt lets 'unspecified' fill
 * NULL but never resets a specific stamp — see sentinelFillInSql in
 * db/queries/markets.ts). See shouldRunScopeBackfill for the cheap per-tick
 * gate. Never overwrites an existing stamp: the structural arm and explicit
 * text stamps are left untouched (the UPDATE re-checks IS NULL, race-safe vs
 * a concurrent sync).
 *
 * A later detector change does not retroactively re-stamp already-stamped
 * rows; a row only heals on re-sync when the new detector emits a different
 * specific value. This pass only closes the NULL hole.
 *
 * Usage (standalone): bun run services/pipeline/src/scripts/backfill-resolution-scope.ts
 */
import { query, endPool } from '@arb/db';
import { createLogger } from '@arb/logger';
import type { Platform } from '@arb/types';
import {
  detectResolutionScope,
  buildScopeDetectionText,
  type ResolutionScope,
} from '../db/market-normalizer.js';

const log = createLogger('backfill-resolution-scope');
const BATCH = 2000;

export interface ScopeBackfillRow {
  id: number;
  platform: Platform;
  title: string;
  raw: unknown; // market_metadata_raw.raw (may be null when no raw row exists)
}

/**
 * PURE per-row computation: replay the sync-time detector over the stored
 * title + platform-appropriate raw text. Always returns a concrete scope
 * (never null) — this is what makes the pass idempotent: after one run no
 * `resolution_scope IS NULL` row can remain.
 */
export function computeScopeForRow(row: ScopeBackfillRow): ResolutionScope {
  return detectResolutionScope(
    String(row.title ?? ''),
    buildScopeDetectionText(row.platform, row.raw),
  );
}

/**
 * Self-watermarking gate: the work predicate (`resolution_scope IS NULL`) is
 * itself the watermark — it monotonically shrinks to 0 (sync stamps new rows
 * inline, nothing writes NULL back), so a converged tick costs one cheap
 * aggregate and skips the scan entirely.
 */
export function shouldRunScopeBackfill(nullScopeCount: number): {
  run: boolean;
  reason: 'null-scope-rows' | 'converged';
} {
  return nullScopeCount > 0
    ? { run: true, reason: 'null-scope-rows' }
    : { run: false, reason: 'converged' };
}

/** Cheap gate probe: how many rows still need a scope stamp? */
export async function countNullScopeMarkets(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM markets WHERE resolution_scope IS NULL`,
  );
  return rows[0]?.n ?? 0;
}

export interface ScopeBackfillResult {
  scanned: number;
  stamped: number;
  byScope: Record<string, number>;
}

/**
 * The Stage-1h pass. Keyset-paginated over `resolution_scope IS NULL` rows,
 * batch VALUES-join UPDATE (re-guarded on IS NULL). Read path mirrors
 * normalizeMarketDoc: markets.title (already platform-normalized at sync,
 * incl. the Predict title build) + market_metadata_raw.raw for the
 * description text.
 */
export async function backfillResolutionScope(): Promise<ScopeBackfillResult> {
  let afterId = 0;
  let scanned = 0;
  let stamped = 0;
  const byScope: Record<string, number> = {};

  for (;;) {
    const rows = await query<ScopeBackfillRow>(
      `SELECT m.id, m.platform, m.title, mr.raw
       FROM markets m
       LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
       WHERE m.resolution_scope IS NULL AND m.id > $1
       ORDER BY m.id
       LIMIT $2`,
      [afterId, BATCH],
    );
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    scanned += rows.length;

    const params: Array<number | string> = [];
    const values = rows
      .map((r, i) => {
        const scope = computeScopeForRow(r);
        byScope[scope] = (byScope[scope] ?? 0) + 1;
        params.push(r.id, scope);
        return `($${i * 2 + 1}::int, $${i * 2 + 2}::text)`;
      })
      .join(',');
    const updated = await query<{ id: number }>(
      `UPDATE markets m
       SET resolution_scope = v.scope
       FROM (VALUES ${values}) AS v(market_id, scope)
       WHERE m.id = v.market_id
         AND m.resolution_scope IS NULL  -- never overwrite (race-safe vs sync/structural arm)
       RETURNING m.id`,
      params,
    );
    stamped += updated.length;
  }

  if (scanned > 0) {
    log.info(
      `resolution_scope backfill: ${scanned} NULL rows scanned, ${stamped} stamped ` +
      `(${Object.entries(byScope).map(([k, v]) => `${k}=${v}`).join(', ')})`,
    );
  }
  return { scanned, stamped, byScope };
}

// Limitless sport-default arm. The NULL-fill backfill above only ever fills
// NULL → concrete and never promotes an existing 'unspecified'. For
// match_winner/championship_winner with silent rules text, soccer defaults
// to regulation and basketball to incl_overtime; this arm re-runs the
// detector with the Stage-1-derived event_kind + enriched sport (inputs the
// sync-time call never has) and promotes the silent limitless winner slice
// from 'unspecified'/NULL to the concrete convention, letting the
// DECISIVE-kind same-event scope guard (Stage-4) admit limitless
// soccer/basketball winner pairs.
//
// Runs as Stage-1h, after Stage-1 stamps event_kind + entity enrichment
// stamps pe.sport_canonical, so a rebuild reproduces the concrete stamps
// from scratch.
//
// Soundness: single-source (the decision lives in detectResolutionScope, no
// SQL twin); promote-only (WHERE resolution_scope IS NULL OR 'unspecified' —
// a concrete text stamp is never overwritten); the detector still returns
// 'unspecified' on a mixed-phrasing row (the default fires only on the
// terminal silent verdict), so those are skipped, not force-stamped.

/** Winner kinds carrying a regulation-vs-overtime settlement basis. */
export const SPORT_DEFAULT_KINDS = ['match_winner', 'championship_winner'] as const;
/** Sports with a single conventional basis the default can assert. */
export const SPORT_DEFAULT_SPORTS = ['soccer', 'basketball'] as const;

export interface LimitlessSportScopeRow extends ScopeBackfillRow {
  event_kind: string | null;
  sport: string | null;
  resolution_scope: string | null;
}

/** Cheap gate probe: how many limitless winner-slice rows are still promotable? */
export async function countLimitlessSportScopeCandidates(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM markets m
       JOIN llm_market_normalizations n ON n.market_id = m.id
       LEFT JOIN platform_events pe
         ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
      WHERE m.platform = 'limitless'
        AND n.event_kind = ANY($1)
        AND lower(pe.sport_canonical) = ANY($2)
        AND (m.resolution_scope IS NULL OR m.resolution_scope = 'unspecified')`,
    [SPORT_DEFAULT_KINDS as unknown as string[], SPORT_DEFAULT_SPORTS as unknown as string[]],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Stage-1h limitless sport-default promotion. Keyset-paginated over the SILENT
 * limitless winner slice (event_kind ∈ SPORT_DEFAULT_KINDS, sport ∈
 * SPORT_DEFAULT_SPORTS, scope NULL/'unspecified'); recomputes the scope WITH ctx
 * and promotes only the concrete results. Idempotent: after one full pass the
 * promotable rows are concrete, so the gate's count drops to the (near-zero)
 * mixed-phrasing residual the detector still returns 'unspecified' for.
 */
export async function backfillLimitlessSportScope(): Promise<ScopeBackfillResult> {
  let afterId = 0;
  let scanned = 0;
  let stamped = 0;
  const byScope: Record<string, number> = {};

  for (;;) {
    const rows = await query<LimitlessSportScopeRow>(
      `SELECT m.id, m.platform, m.title, mr.raw, n.event_kind,
              lower(pe.sport_canonical) AS sport, m.resolution_scope
         FROM markets m
         JOIN llm_market_normalizations n ON n.market_id = m.id
         LEFT JOIN platform_events pe
           ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
         LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
        WHERE m.platform = 'limitless'
          AND n.event_kind = ANY($3)
          AND lower(pe.sport_canonical) = ANY($4)
          AND (m.resolution_scope IS NULL OR m.resolution_scope = 'unspecified')
          AND m.id > $1
        ORDER BY m.id
        LIMIT $2`,
      [afterId, BATCH, SPORT_DEFAULT_KINDS as unknown as string[], SPORT_DEFAULT_SPORTS as unknown as string[]],
    );
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    scanned += rows.length;

    const params: Array<number | string> = [];
    const values: string[] = [];
    let vi = 0;
    for (const r of rows) {
      const scope = detectResolutionScope(
        String(r.title ?? ''),
        buildScopeDetectionText(r.platform, r.raw),
        { platform: r.platform, eventKind: r.event_kind, sport: r.sport },
      );
      // Only PROMOTE to a concrete convention; a still-'unspecified' verdict
      // (mixed-phrasing row) is left as-is (skip — do not force-stamp).
      if (scope === 'unspecified') continue;
      byScope[scope] = (byScope[scope] ?? 0) + 1;
      params.push(r.id, scope);
      values.push(`($${vi * 2 + 1}::int, $${vi * 2 + 2}::text)`);
      vi++;
    }
    if (values.length === 0) continue;
    const updated = await query<{ id: number }>(
      `UPDATE markets m
          SET resolution_scope = v.scope
         FROM (VALUES ${values.join(',')}) AS v(market_id, scope)
        WHERE m.id = v.market_id
          -- promote-only: never overwrite a concrete text stamp (race-safe vs sync)
          AND (m.resolution_scope IS NULL OR m.resolution_scope = 'unspecified')
        RETURNING m.id`,
      params,
    );
    stamped += updated.length;
  }

  if (scanned > 0) {
    log.info(
      `limitless sport-default scope: ${scanned} slice rows scanned, ${stamped} promoted ` +
      `(${Object.entries(byScope).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'})`,
    );
  }
  return { scanned, stamped, byScope };
}

if (import.meta.main) {
  try {
    const nullCount = await countNullScopeMarkets();
    const gate = shouldRunScopeBackfill(nullCount);
    console.log(`NULL-scope rows: ${nullCount} → gate=${gate.reason}`);
    if (gate.run) {
      const res = await backfillResolutionScope();
      console.log(res);
    }
    const sportCandidates = await countLimitlessSportScopeCandidates();
    console.log(`limitless sport-default candidates: ${sportCandidates}`);
    if (sportCandidates > 0) {
      const res2 = await backfillLimitlessSportScope();
      console.log(res2);
    }
  } finally {
    await endPool();
  }
}
