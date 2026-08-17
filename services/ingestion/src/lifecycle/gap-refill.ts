/**
 * Gap-refill helpers — targeted narrow REST queries used after a WSS reconnect.
 *
 * Instead of re-running the full scrapeActive() (which crawls every active
 * market across all pages), these functions use time-filter params to fetch
 * only markets created/resolved during the disconnect window.
 *
 * Typical gap is seconds to a few minutes, so each platform call stops after
 * 1-3 pages rather than 50+.
 *
 * Platform strategies:
 *   Kalshi      — min_created_ts / min_settled_ts (Unix seconds); cursor-paginated
 *   Polymarket  — keyset newest-first stop-early for new; closed_time_min for resolved
 *   Limitless   — active-slug diff: 1 GET + individual fetches for truly unknown slugs
 *   Predict     — already on REST poll; no gap refill needed here
 */

import axios from 'axios';
import { query } from '@arb/db';
import type { Platform } from '@arb/types';
import { fetchMarkets as fetchKalshiMarkets } from '../scrapers/kalshi/api-client.js';
import { dbService as kalshiDb }    from '../scrapers/kalshi/postgres.js';
import { dbService as polymarketDb } from '../scrapers/polymarket/postgres.js';
import { dbService as limitlessDb }  from '../scrapers/limitless/postgres.js';
import { fetchActiveSlugs, fetchMarketBySlug } from '../scrapers/limitless/api-client.js';
import {
  writeAndPublishResolution,
  coerceResolvedAt,
  parseWinnerFromOutcomes,
} from '@arb/resolution-write';

export interface GapRefillResult {
  newMarkets: number;
  newResolved: number;
  durationMs: number;
  pages: number;
}

// Gap-refill intentionally excludes 'predict' (the Predict scraper is already
// REST-poll based, so its lifecycle watcher never disconnects). Narrowing the
// canonical Platform type makes that exclusion explicit instead of shadowing
// the name with a smaller union.
type GapRefillPlatform = Exclude<Platform, 'predict'>;

// ─── Shared resolution writer (re-export wrapper) ─────────────────────────────

/**
 * Thin wrapper around the shared writeAndPublishResolution helper. Returns
 * true iff this call created a new resolution (so the caller can increment
 * its newResolved counter). 'amended' calls (filling a missing winner on an
 * already-resolved row) are not counted.
 */
async function writeResolution(
  platform: GapRefillPlatform,
  platformId: string,
  winning: string | null,
  resolvedAt: Date,
  source: string,
): Promise<boolean> {
  const { outcome } = await writeAndPublishResolution({
    platform, platformId, winning, resolvedAt, source,
  });
  return outcome === 'created';
}

// ─── Kalshi ───────────────────────────────────────────────────────────────────

/** Maximum pages to scan per Kalshi gap-refill phase (safety cap). */
const KALSHI_MAX_PAGES = 20;

export async function refillKalshi(since: Date): Promise<GapRefillResult> {
  const t0 = Date.now();
  let newMarkets = 0;
  let newResolved = 0;
  let pages = 0;

  // ── 1. New open markets created since the gap ──────────────────────────
  // fetchMarkets handles auth + rate-limiting + retries internally.
  // Client-side date filter because FetchMarketsOptions has no min_created_ts.
  await fetchKalshiMarkets({
    status: 'open',
    limit: 1000,
    maxMarkets: KALSHI_MAX_PAGES * 1000,
    onBatch: async (batch) => {
      const filtered = batch.filter((m) => {
        const raw = (m as any).raw;
        if (!raw?.created_time) return true; // no timestamp → include
        return new Date(raw.created_time) >= since;
      });
      if (filtered.length > 0) {
        const saved = await kalshiDb.saveMarkets(filtered);
        newMarkets += saved;
      }
      pages++;
    },
  }).catch(() => null);

  // ── 2. Markets settled since the gap ──────────────────────────────────
  await fetchKalshiMarkets({
    status: 'settled',
    limit: 200,
    maxMarkets: KALSHI_MAX_PAGES * 200,
    onBatch: async (batch) => {
      for (const m of batch) {
        if (!m.ticker) continue;
        const raw = (m as any).raw;
        const settledAt = raw?.settlement_timestamp
          ? new Date(raw.settlement_timestamp)
          : m.settlement_ts ? new Date(m.settlement_ts) : null;
        if (settledAt && settledAt < since) continue;

        const winning = m.result === 'yes' ? 'Yes' : m.result === 'no' ? 'No' : null;
        // IMPORTANT: keep the raw.settlement_timestamp first to mirror the
        // filter check above. KalshiMarket.settlement_ts (the typed column)
        // and raw.settlement_timestamp (the JSON blob) can disagree — if the
        // typed column is null but the raw blob has a value, falling back to
        // `new Date()` would corrupt the resolution-monitor watermark. Try
        // every authoritative source before that fallback fires.
        const rawTs = raw?.settlement_timestamp ?? m.settlement_ts ?? m.close_time ?? m.expiration_time;
        const { resolvedAt } = coerceResolvedAt(rawTs, `kalshi/gap-refill ${m.ticker}`);
        const wrote = await writeResolution(
          'kalshi', m.ticker, winning, resolvedAt, 'kalshi/gap-refill',
        );
        if (wrote) newResolved++;
      }
      pages++;
    },
  }).catch(() => null);

  return { newMarkets, newResolved, durationMs: Date.now() - t0, pages };
}

// ─── Polymarket ───────────────────────────────────────────────────────────────

const GAMMA_API = 'https://gamma-api.polymarket.com';
const POLY_MAX_PAGES = 20;

export async function refillPolymarket(since: Date): Promise<GapRefillResult> {
  const t0 = Date.now();
  let newMarkets = 0;
  let newResolved = 0;
  let pages = 0;

  // ── 1. New markets: keyset newest-first, stop when page falls before `since` ─
  {
    let nextCursor: string | null = null;
    let done = false;

    for (let i = 0; i < POLY_MAX_PAGES && !done; i++) {
      const params: Record<string, any> = {
        limit: 100,
        order: 'id',
        ascending: false,
        closed: false,
      };
      if (nextCursor) params.after_cursor = nextCursor;

      const res = await axios
        .get(`${GAMMA_API}/events/keyset`, { params, timeout: 20_000 })
        .catch(() => null);
      if (!res?.data) break;
      pages++;

      const events: any[] = res.data.events ?? [];
      if (!events.length) break;

      const newEventBatch: any[] = [];
      const newMarketBatch: any[] = [];

      for (const ev of events) {
        // creationDate is an ISO string; stop scanning once events are older than `since`
        const createdStr: string = ev.creationDate ?? ev.startDateIso ?? '';
        if (createdStr && new Date(createdStr) < since) {
          done = true; // remaining events in this and future pages are older
          break;
        }
        newEventBatch.push(ev);
        if (Array.isArray(ev.markets)) {
          for (const m of ev.markets) {
            newMarketBatch.push(m);
          }
        }
      }

      if (newEventBatch.length > 0) {
        // Persist parent event rows so enrichMarketCategoriesFromEvents()
        // can read category/tags from polymarket_events. Without this,
        // gap-refilled markets land with NULL category until the next full
        // scrape — silently degrading Stage 1b LLM input quality for the
        // entire window.
        await polymarketDb.saveEvents(newEventBatch).catch(() => 0);
      }
      if (newMarketBatch.length > 0) {
        const saved = await polymarketDb.saveMarkets(newMarketBatch);
        newMarkets += saved;
      }

      nextCursor = res.data.next_cursor ?? null;
      if (!nextCursor) break;
    }
  }

  // ── 2. Resolved markets: closed_time_min filter (ISO string) ──────────
  {
    let offset = 0;
    for (let i = 0; i < POLY_MAX_PAGES; i++) {
      const res = await axios
        .get(`${GAMMA_API}/markets`, {
          params: {
            closed: true,
            closed_time_min: since.toISOString(),
            limit: 500,
            offset,
          },
          timeout: 20_000,
        })
        .catch(() => null);
      if (!res || !Array.isArray(res.data) || res.data.length === 0) break;
      pages++;

      for (const m of res.data) {
        if (!m.conditionId) continue;
        const closedStr: string = m.closedTime ?? m.endDate ?? '';
        const { resolvedAt } = coerceResolvedAt(closedStr, `polymarket/gap-refill ${m.conditionId}`);

        const winning: string | null = parseWinnerFromOutcomes(m.outcomes, m.outcomePrices);

        const wrote = await writeResolution(
          'polymarket', m.conditionId, winning, resolvedAt, 'polymarket/gap-refill',
        );
        if (wrote) newResolved++;
      }

      if (res.data.length < 500) break; // last page
      offset += res.data.length;
    }
  }

  return { newMarkets, newResolved, durationMs: Date.now() - t0, pages };
}

// ─── Limitless ────────────────────────────────────────────────────────────────

/** Polite delay between individual Limitless market fetches (ms). */
const LIMITLESS_FETCH_DELAY_MS = 250;

export async function refillLimitless(since: Date): Promise<GapRefillResult> {
  const t0 = Date.now();
  let newMarkets = 0;
  let newResolved = 0;
  let pages = 1; // the active-slugs GET counts as page 1

  // ── Step 1: fetch the current active-slug set (one cheap call) ────────
  const slugEntries = await fetchActiveSlugs().catch(() => null);
  if (!slugEntries) {
    return { newMarkets, newResolved, durationMs: Date.now() - t0, pages: 0 };
  }

  const activeSet = new Set<string>(slugEntries.map((e) => e.slug).filter(Boolean));

  // ── Step 2: query our DB for open + all-known limitless slugs ─────────
  // We also pull `end_date` for open slugs so we can detect resolutions
  // that the active-slugs diff would miss (markets that have already ended
  // per their advertised end_date but Limitless still lists them as active —
  // e.g. delayed cleanup, conditional resolution, edge-case caching). These
  // get a follow-up status probe regardless of their presence in activeSet.
  const [openRows, knownRows] = await Promise.all([
    query<{ platform_id: string; end_date: Date | null }>(
      `SELECT platform_id, end_date
         FROM markets
        WHERE platform = 'limitless'
          AND resolved_at IS NULL`,
      [],
    ),
    query<{ slug: string }>(
      `SELECT slug FROM limitless_markets`,
      [],
    ),
  ]);
  const openSet  = new Set(openRows.map(r => r.platform_id));
  const knownSet = new Set(knownRows.map(r => r.slug));

  // Slugs that LOOK like they should already be resolved (end_date < now),
  // even if Limitless still has them in /active/slugs. Capped to keep refill
  // bounded on platforms with thousands of stale-listed markets.
  const STALE_PROBE_CAP = 50;
  const nowMs = Date.now();
  const staleProbeCandidates = openRows
    .filter(r => activeSet.has(r.platform_id)
              && r.end_date instanceof Date
              && r.end_date.getTime() < nowMs)
    .map(r => r.platform_id)
    .slice(0, STALE_PROBE_CAP);

  // ── Step 3: new markets = active slugs not yet in limitless_markets ───
  const unknownSlugs = [...activeSet].filter(s => !knownSet.has(s));
  for (const slug of unknownSlugs) {
    const m = await fetchMarketBySlug(slug).catch(() => null);
    if (!m) continue;
    pages++;
    // Skip if this slug was created well before the gap (missed pre-fill edge case)
    const createdStr: string = (m as any).createdAt ?? (m as any).createDate ?? '';
    if (createdStr && new Date(createdStr) < since) continue;

    const saved = await limitlessDb.saveMarkets([m]);
    newMarkets += saved;

    await sleep(LIMITLESS_FETCH_DELAY_MS);
  }

  // ── Step 4: resolved = (a) open slugs no longer in active set, plus
  //                       (b) open slugs whose advertised end_date has
  //                           passed even though Limitless still lists them
  //                           as active (deduped). ─────────────────────────
  const disappeared = [...openSet].filter(s => !activeSet.has(s));
  const resolveCandidates = Array.from(new Set([...disappeared, ...staleProbeCandidates]));
  for (const slug of resolveCandidates) {
    const m = await fetchMarketBySlug(slug).catch(() => null);
    if (!m) continue;
    pages++;
    // Only write resolution if the platform confirms the market is done
    if (m.status !== 'RESOLVED' && m.expired !== true) continue;

    const { resolvedAt } = coerceResolvedAt((m as any).resolutionDate, `limitless/gap-refill ${slug}`);
    const winning: string | null = (m as any).winningOutcome ?? null;
    const wrote = await writeResolution(
      'limitless', slug, winning, resolvedAt, 'limitless/gap-refill',
    );
    if (wrote) newResolved++;

    await sleep(LIMITLESS_FETCH_DELAY_MS);
  }

  return { newMarkets, newResolved, durationMs: Date.now() - t0, pages };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
