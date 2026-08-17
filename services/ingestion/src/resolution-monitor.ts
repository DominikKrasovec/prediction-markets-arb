/**
 * Resolution monitor — periodically polls each platform's REST API for
 * recently-settled markets and writes `resolved_at` / `winning_outcome` to
 * the `markets` table. This is the **slow path** that complements the
 * adapter-level WSS push handlers in arb-solver: WSS catches resolutions in
 * seconds when available, the monitor catches the rest within `interval`.
 *
 * Per-platform algorithm:
 *  - Kalshi    : GET /markets?status=settled (cursor-paginated, idempotency guard on resolved_at IS NULL)
 *  - Polymarket: GET /markets?closed=true&closed_time_min=<checkpoint>
 *  - Predict   : GET /v1/markets?status=RESOLVED (cursor-paginated)
 *  - Limitless : diff active-slugs vs DB open set, then GET /markets/{slug}
 *
 * Checkpoints persist in the `pipeline_state` table under
 * `resolution_checkpoint_<platform>`.
 */

import axios from 'axios';
import { query } from '@arb/db';
import type { Platform } from '@arb/types';
import { createLogger } from '@arb/logger';

const log = createLogger('resolution-monitor');
import {
  writeAndPublishResolution,
  coerceResolvedAt,
  parseWinnerFromOutcomes,
  type ResolutionWriteOutcome,
} from '@arb/resolution-write';

interface ResolutionWrite {
  winning_outcome: string | null;
  resolved_at: Date;
  source: string;
}

// ---------------------------------------------------------------------------
// Shared DB helpers — writeResolution lives in @arb/resolution-write
// so the WSS lifecycle watchers, gap-refill, and this monitor all share one
// idempotency model. The thin wrapper here preserves this module's
// pre-existing call signature for the per-platform pollers below and
// returns the full 4-state outcome so they can distinguish:
//   created          → newly resolved (counts toward `total`)
//   amended          → existing row, winner backfilled (does NOT count
//                      toward `total` but IS evidence we've caught up)
//   already_resolved → row exists fully resolved (evidence we've caught up)
//   not_found        → row missing — neither news nor evidence
// publish-on-amended is handled inside writeAndPublishResolution.
// ---------------------------------------------------------------------------

async function writeResolution(
  platform: Platform,
  platformId: string,
  info: ResolutionWrite,
): Promise<ResolutionWriteOutcome> {
  const { outcome } = await writeAndPublishResolution({
    platform,
    platformId,
    winning: info.winning_outcome,
    resolvedAt: info.resolved_at,
    source: info.source,
  });
  return outcome;
}

async function getOpenPlatformIds(platform: Platform): Promise<string[]> {
  const rows = await query<{ platform_id: string }>(
    `SELECT platform_id FROM markets WHERE platform = $1 AND resolved_at IS NULL`,
    [platform],
  );
  return rows.map((r) => r.platform_id);
}

async function getCheckpoint(platform: Platform, defaultDaysBack = 7): Promise<Date> {
  // Watermark = max(resolved_at) for the platform, minus a 1-hour overlap so
  // edge cases (clock skew, late-arriving settlements) are caught. Falls back
  // to <defaultDaysBack> days ago when nothing has been resolved yet.
  const rows = await query<{ ts: Date | null }>(
    `SELECT MAX(resolved_at) AS ts FROM markets WHERE platform = $1`,
    [platform],
  );
  if (rows.length > 0 && rows[0].ts) {
    return new Date(rows[0].ts.getTime() - 3600_000);
  }
  return new Date(Date.now() - defaultDaysBack * 86400_000);
}

// NOTE: there used to be a no-op `publishResolved` stub here so the pollers
// could call it for source-diff clarity. It was misleading (the next reader
// would assume it published, when in fact publishing is now done inside
// `writeAndPublishResolution` and a real implementation here would
// double-publish). Removed entirely; the pollers now rely solely on the
// shared writer's publish behavior.

// ---------------------------------------------------------------------------
// Per-platform pollers
// ---------------------------------------------------------------------------

async function pollKalshi(): Promise<number> {
  const baseUrl = process.env.KALSHI_BASE_URL ?? 'https://api.elections.kalshi.com/trade-api/v2';
  let cursor: string | undefined;
  let total = 0;

  // Kalshi /markets has no documented time-range filter — the supported params
  // are status, event_ticker, series_ticker, tickers, limit, cursor only.
  // We page through settled markets newest-first (the API's default order)
  // and stop early after SKIP_THRESHOLD consecutive markets that are already
  // tracked + resolved in our DB. This keeps the poll O(recent-resolutions)
  // instead of O(all-time settled). The 50-page cap remains as a safety bound.
  const SKIP_THRESHOLD = 200; // ~1 full page; tolerant of any sort-order quirks
  let consecutiveKnown = 0;

  for (let page = 0; page < 50; page++) {
    const params: Record<string, string | number> = {
      status: 'settled',
      limit: 200,
    };
    if (cursor) params.cursor = cursor;

    const res = await axios.get(`${baseUrl}/markets`, { params, timeout: 30_000 }).catch((err) => {
      log.error('[kalshi] fetch error:', err?.message ?? err);
      return null;
    });
    if (!res || !res.data) break;

    const markets: any[] = res.data.markets ?? [];
    for (const m of markets) {
      const ticker: string | undefined = m.ticker;
      if (!ticker) continue;
      const winning = m.result === 'yes' ? 'Yes' : m.result === 'no' ? 'No' : null;
      const settledTs = m.settlement_timestamp ?? m.close_time ?? m.expiration_time;
      const { resolvedAt } = coerceResolvedAt(settledTs, `kalshi/poll ${ticker}`);
      const outcome = await writeResolution('kalshi', ticker, {
        winning_outcome: winning,
        resolved_at: resolvedAt,
        source: 'kalshi/poll',
      });
      if (outcome === 'created') {
        total++;
        consecutiveKnown = 0;
      } else if (outcome === 'amended' || outcome === 'already_resolved') {
        // The DB is authoritative — both outcomes prove the row exists and
        // is at least partially resolved, so this is evidence of catch-up.
        // 'amended' won't be in our pre-loaded snapshot if the WSS firehose
        // wrote it during this poll, so we use the writer's classification
        // rather than `alreadyResolved.has(ticker)`. This was the bug that
        // let consecutiveKnown stall on busy exchanges.
        consecutiveKnown++;
        if (consecutiveKnown >= SKIP_THRESHOLD) return total;
      }
      // outcome === 'not_found' → untracked market (never scraped). Don't
      // advance consecutiveKnown — it's not evidence of catching up.
    }

    cursor = res.data.cursor;
    if (!cursor || markets.length === 0) break;
  }

  return total;
}

async function pollPolymarket(): Promise<number> {
  const since = await getCheckpoint('polymarket');
  let total = 0;

  // Use markets endpoint directly so we get conditionId (matches platform_id).
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const res = await axios
      .get('https://gamma-api.polymarket.com/markets', {
        params: {
          closed: true,
          closed_time_min: since.toISOString(),
          limit: 500,
          offset,
        },
        timeout: 30_000,
      })
      .catch((err) => {
        log.error('[polymarket] fetch error:', err?.message ?? err);
        return null;
      });
    if (!res || !Array.isArray(res.data) || res.data.length === 0) break;

    for (const m of res.data) {
      const conditionId: string | undefined = m.conditionId;
      if (!conditionId) continue;
      const closedTime: string | undefined = m.closedTime ?? m.endDate;
      const { resolvedAt } = coerceResolvedAt(closedTime, `polymarket/poll ${conditionId}`);

      // Robust winner extraction (tolerates float imprecision, rejects ambiguity).
      const winning: string | null = parseWinnerFromOutcomes(m.outcomes, m.outcomePrices);

      const outcome = await writeResolution('polymarket', conditionId, {
        winning_outcome: winning,
        resolved_at: resolvedAt,
        source: 'polymarket/poll',
      });
      if (outcome === 'created') total++;
    }

    offset += res.data.length;
    if (res.data.length < 500) break;
  }

  return total;
}

export async function pollPredict(): Promise<number> {
  // Predict has no time-range filter so we page through status=RESOLVED
  // newest-first and early-exit after SKIP_THRESHOLD consecutive markets that
  // are already tracked + resolved in our DB.
  //
  // API quirks (Predict /v1/markets):
  //   - Pagination uses `first` (string) + `after`, NOT `limit` + `cursor`.
  //     Sending the wrong param names causes the server to ignore them and
  //     return the same first page on every request — pagination is broken.
  //   - The market schema has no resolution timestamp field. The only date
  //     returned is `createdAt` (market creation time). We store that as
  //     `resolved_at` as the best available approximation. This is semantically
  //     imperfect (creation ≠ resolution time) but avoids inflating
  //     `resolved_at` to `now` which would corrupt any future watermark-based
  //     filtering. A resolution-date field does not exist in the Predict API.
  //   - Response body is `{ success, cursor, data: [...] }`.
  const SKIP_THRESHOLD = 50;
  let total = 0;
  let consecutiveKnown = 0;
  let after: string | undefined;

  for (let page = 0; page < 50; page++) {
    const params: Record<string, string> = {
      status: 'RESOLVED',
      first: '100',
    };
    if (after) params.after = after;

    const res = await axios
      .get('https://api.predict.fun/v1/markets', {
        params,
        headers: { 'x-api-key': process.env.PREDICT_API_KEY ?? '' },
        timeout: 30_000,
      })
      .catch((err) => {
        log.error('[predict] fetch error:', err?.message ?? err);
        return null;
      });
    if (!res || !res.data) break;

    const markets: any[] = res.data.data ?? [];

    for (const m of markets) {
      const id = m.id != null ? String(m.id) : undefined;
      if (!id) continue;

      // Predict API does not expose a resolution timestamp — `createdAt` is
      // the only date field available on the market object. We use it as an
      // approximation so resolved_at stays in the past rather than inflating
      // to new Date() (which would corrupt any checkpoint-watermark query).
      const { resolvedAt } = coerceResolvedAt(m.createdAt, `predict/poll ${id}`);

      let winning: string | null = null;
      const outcomes: any[] = m.outcomes ?? [];
      const won = outcomes.find((o: any) => o?.status === 'WON');
      if (won) winning = won.name ?? won.title ?? null;

      const outcome = await writeResolution('predict', id, {
        winning_outcome: winning,
        resolved_at: resolvedAt,
        source: 'predict/poll',
      });
      if (outcome === 'created') {
        total++;
        consecutiveKnown = 0;
      } else if (outcome === 'amended' || outcome === 'already_resolved') {
        consecutiveKnown++;
        if (consecutiveKnown >= SKIP_THRESHOLD) return total;
      }
      // outcome === 'not_found' → market not in our DB; don't count it.
    }

    if (markets.length === 0) break;
    after = res.data.cursor ?? undefined;
    if (!after) break;
  }

  return total;
}

async function pollLimitless(): Promise<number> {
  // Limitless has no "status=resolved" feed. Strategy:
  //   (a) fetch the active-slug set; any of our open tracked slugs not in
  //       that set is a candidate for resolution (the disappearance signal).
  //   (b) ALSO probe up to STALE_PROBE_CAP open slugs whose end_date is in
  //       the past — these are likely resolved but Limitless has not yet
  //       removed them from /active/slugs (delayed cleanup, conditional
  //       resolution, edge-case caching). Without this probe such markets
  //       would be silently skipped indefinitely.
  let total = 0;

  const openRows = await query<{ platform_id: string; end_date: Date | null }>(
    `SELECT platform_id, end_date
       FROM markets
      WHERE platform = 'limitless' AND resolved_at IS NULL`,
    [],
  );
  if (openRows.length === 0) return 0;

  const activeRes = await axios
    .get('https://api.limitless.exchange/markets/active/slugs', { timeout: 30_000 })
    .catch((err) => {
      log.error('[limitless] active-slugs fetch error:', err?.message ?? err);
      return null;
    });
  if (!activeRes || !Array.isArray(activeRes.data)) return 0;

  const activeSet = new Set<string>(
    (activeRes.data as any[]).map((e: any) => (typeof e === 'string' ? e : e.slug)),
  );

  const STALE_PROBE_CAP = 50;
  const nowMs = Date.now();
  const disappeared = openRows
    .filter((r) => !activeSet.has(r.platform_id))
    .map((r) => r.platform_id);
  const stale = openRows
    .filter((r) => activeSet.has(r.platform_id)
                && r.end_date instanceof Date
                && r.end_date.getTime() < nowMs)
    .map((r) => r.platform_id)
    .slice(0, STALE_PROBE_CAP);
  const candidates = Array.from(new Set([...disappeared, ...stale]));
  if (candidates.length === 0) return 0;

  for (const slug of candidates) {
    const res = await axios
      .get(`https://api.limitless.exchange/markets/${encodeURIComponent(slug)}`, { timeout: 15_000 })
      .catch(() => null);
    if (!res || !res.data) continue;

    const m = res.data;
    const status: string | undefined = m.status;
    const expired: boolean | undefined = m.expired;
    if (status !== 'RESOLVED' && expired !== true) continue;

    const tsCandidate = m.resolutionDate ?? m.expirationDate;
    const { resolvedAt } = coerceResolvedAt(tsCandidate, `limitless/poll ${slug}`);
    const winning: string | null = m.winningOutcome ?? null;

    const outcome = await writeResolution('limitless', slug, {
      winning_outcome: winning,
      resolved_at: resolvedAt,
      source: 'limitless/poll',
    });
    if (outcome === 'created') total++;

    // small gap to be polite
    await new Promise((r) => setTimeout(r, 300));
  }

  return total;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Per-platform poll outcome. `error` is set to the rejection reason when the
 * platform's REST poll threw — without this, callers cannot distinguish "0
 * newly resolved" from "the entire poll failed". `runResolutionMonitor` will
 * still log internally, but it now also returns these structured outcomes.
 */
export interface ResolutionMonitorResult {
  kalshi:     { resolved: number; error: unknown | null };
  polymarket: { resolved: number; error: unknown | null };
  predict:    { resolved: number; error: unknown | null };
  limitless:  { resolved: number; error: unknown | null };
  totalResolved: number;
  errors: number;
  durationMs: number;
}

export async function runResolutionMonitor(): Promise<ResolutionMonitorResult> {
  const start = Date.now();
  log.info('running...');
  const results = await Promise.allSettled([
    pollKalshi(),
    pollPolymarket(),
    pollPredict(),
    pollLimitless(),
  ]);
  const labels: Platform[] = ['kalshi', 'polymarket', 'predict', 'limitless'];
  const out: ResolutionMonitorResult = {
    kalshi:     { resolved: 0, error: null },
    polymarket: { resolved: 0, error: null },
    predict:    { resolved: 0, error: null },
    limitless:  { resolved: 0, error: null },
    totalResolved: 0,
    errors: 0,
    durationMs: 0,
  };
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const slot = out[labels[i]];
    if (r.status === 'fulfilled') {
      slot.resolved = r.value;
      out.totalResolved += r.value;
      if (r.value > 0) log.info(`${labels[i]}: ${r.value} newly resolved`);
    } else {
      slot.error = r.reason;
      out.errors++;
      log.error(`${labels[i]} failed:`, r.reason);
    }
  }
  out.durationMs = Date.now() - start;
  log.info(
    `[resolution-monitor] done in ${out.durationMs}ms, ${out.totalResolved} total newly resolved` +
    (out.errors > 0 ? ` (${out.errors} platform error${out.errors === 1 ? '' : 's'})` : ''),
  );
  return out;
}
