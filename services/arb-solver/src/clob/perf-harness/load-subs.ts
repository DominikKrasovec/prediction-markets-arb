import { query } from '@arb/db';
import type { Platform } from '@arb/types';
import type { MarketSubscription } from '../price-cache.js';

/**
 * Load the full set of markets the live arb-solver would subscribe to.
 *
 * Mirrors arb-solver/src/graph/loader.ts + getMarketsToTrack():
 *  - only active (non-archived) questions
 *  - only open (resolved_at IS NULL) markets
 *  - only questions touched by the edge graph at minEdgeConfidence
 *  - dedup by market_id
 *
 * Per-outcome expansion (harness-only):
 *  - Polymarket: each `markets.platform_id` (= condition_id) expands to TWO
 *    subscriptions, one for clobTokenIds[0] (YES) and one for clobTokenIds[1]
 *    (NO). The two books are independent.
 *  - Limitless: each `marketType='group'` wrapper expands to its child slugs
 *    (from `raw->'markets'`). Children are not stored as separate
 *    `markets`/`limitless_markets` rows; without expansion we'd subscribe to
 *    wrapper slugs that never emit orderbook events.
 */
export interface LoadOptions {
  minEdgeConfidence?: number;
  platform?: Platform;
  maxSubs?: number;
  shuffle?: boolean;
  allOpen?: boolean;
  /** When true, Polymarket subscriptions are expanded to both YES and NO
   *  tokens (one sub per outcome). Default: true. */
  bothPolymarketSides?: boolean;
  /** When true, Limitless group wrappers (`marketType='group'`) are expanded
   *  to their child slugs. Default: true. */
  expandLimitlessGroups?: boolean;
}

interface MarketRow {
  market_id: number;
  platform: Platform;
  platform_id: string;
}

export async function loadClusterMarkets(opts: LoadOptions = {}): Promise<MarketSubscription[]> {
  const minConf = opts.minEdgeConfidence ?? 0.70;
  const platformFilter = opts.platform ? `AND m.platform = '${opts.platform}'` : '';
  const bothPolySides = opts.bothPolymarketSides !== false;
  const expandGroups = opts.expandLimitlessGroups !== false;

  const rows = opts.allOpen
    ? await query<MarketRow>(
        `SELECT id AS market_id, platform, platform_id
           FROM markets m
          WHERE m.resolved_at IS NULL
            AND m.platform_id IS NOT NULL
            ${platformFilter}`,
      )
    : await query<MarketRow>(
        `WITH edge_questions AS (
           SELECT antecedent_question_id AS qid
             FROM implication_edges
            WHERE archived_at IS NULL AND confidence >= $1
           UNION
           SELECT consequent_question_id
             FROM implication_edges
            WHERE archived_at IS NULL AND confidence >= $1
         )
         SELECT DISTINCT qm.market_id, m.platform, m.platform_id
           FROM edge_questions eq
           JOIN question_members qm ON qm.question_id = eq.qid
           JOIN questions q ON q.id = eq.qid AND q.archived_at IS NULL
           JOIN markets m ON m.id = qm.market_id AND m.resolved_at IS NULL
          WHERE m.platform_id IS NOT NULL
            ${platformFilter}`,
        [minConf],
      );

  let subs: MarketSubscription[] = rows.map((r) => ({
    marketId: r.market_id,
    platform: r.platform,
    platformId: r.platform_id,
  }));

  subs = await expandPolymarket(subs, bothPolySides);
  subs = await expandLimitless(subs, expandGroups);

  if (opts.maxSubs && opts.maxSubs > 0 && subs.length > opts.maxSubs) {
    if (opts.shuffle !== false) {
      // Fisher-Yates over (marketId, outcome) pairs. If a market has both YES
      // and NO subs, they might end up split across the cap — that's OK for a
      // stress test; pin both sides together by passing --max-subs as 2× the
      // intended market count if you want full pairs.
      for (let i = subs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [subs[i], subs[j]] = [subs[j], subs[i]];
      }
    }
    subs = subs.slice(0, opts.maxSubs);
  }

  return subs;
}

/**
 * Polymarket: translate each `markets.platform_id` (= hex condition_id) into
 * one (YES) or two (YES+NO) subscriptions keyed by clobTokenId.
 *
 * The unified `markets.platform_id` for polymarket = condition_id (hex). The
 * Polymarket CLOB WSS subscribes by `assets_ids` = `clobTokenIds[i]`. Subscribing
 * with a raw condition_id makes the server accept the request and silently
 * never emit. We translate via the `polymarket_markets.raw->'clobTokenIds'`
 * array: [0] = YES, [1] = NO.
 *
 * `bothSides=true` emits two subs per market (YES and NO). `bothSides=false`
 * keeps the legacy YES-only behavior.
 */
async function expandPolymarket(
  subs: MarketSubscription[],
  bothSides: boolean,
): Promise<MarketSubscription[]> {
  const poly = subs.filter((s) => s.platform === 'polymarket');
  if (poly.length === 0) return subs;
  const tokens = await loadPolymarketTokens(poly.map((s) => s.platformId));
  return subs.flatMap((s) => {
    if (s.platform !== 'polymarket') return [s];
    const tok = tokens.get(s.platformId);
    if (!tok) return [];
    const out: MarketSubscription[] = [
      { ...s, platformId: tok.yes, outcome: 'yes' },
    ];
    if (bothSides && tok.no) {
      out.push({ ...s, platformId: tok.no, outcome: 'no' });
    }
    return out;
  });
}

/**
 * Limitless: replace each `marketType='group'` wrapper slug with the child
 * slugs nested in `raw->'markets'`. Children of group wrappers are not stored
 * as their own `limitless_markets` rows; without expansion the perf harness
 * would subscribe to wrapper slugs that never emit `orderbookUpdate`.
 *
 * The Limitless WSS is slug-keyed and exposes only one orderbook per slug
 * (per `GET /markets/:slug/orderbook`, the returned `tokenId` matches the YES
 * `positionIds[0]`). There is no `subscribe_orderbook_by_token` event, so NO
 * coverage is not possible via the WSS as of writing. The `outcome` field on
 * Limitless subs is left undefined to signal that ambiguity.
 */
async function expandLimitless(
  subs: MarketSubscription[],
  expandGroups: boolean,
): Promise<MarketSubscription[]> {
  if (!expandGroups) return subs;
  const lim = subs.filter((s) => s.platform === 'limitless');
  if (lim.length === 0) return subs;
  const groupChildren = await loadLimitlessGroupChildren(lim.map((s) => s.platformId));
  return subs.flatMap((s) => {
    if (s.platform !== 'limitless') return [s];
    const children = groupChildren.get(s.platformId);
    if (!children) return [s]; // single-style market — keep slug as-is
    // Group wrapper — replace with N child subs. Each child inherits the
    // parent's marketId (so the JSONL still groups under the wrapper's
    // markets.id) but uses the child's slug for the WSS subscription.
    if (children.length === 0) return [];
    return children.map((slug) => ({ ...s, platformId: slug }));
  });
}

interface PolyTokens {
  yes: string;
  no: string | null;
}

async function loadPolymarketTokens(conditionIds: string[]): Promise<Map<string, PolyTokens>> {
  if (conditionIds.length === 0) return new Map();
  const rows = await query<{ condition_id: string; yes_tok: string | null; no_tok: string | null }>(
    `SELECT condition_id,
            (raw->'clobTokenIds'->>0) AS yes_tok,
            (raw->'clobTokenIds'->>1) AS no_tok
       FROM polymarket_markets
      WHERE condition_id = ANY($1::text[])`,
    [conditionIds],
  );
  const map = new Map<string, PolyTokens>();
  for (const r of rows) {
    if (!r.yes_tok) continue;
    map.set(r.condition_id, { yes: r.yes_tok, no: r.no_tok });
  }
  return map;
}

/**
 * slug → child slugs if the row is a `marketType='group'` wrapper. Single
 * markets and unknown slugs are absent from the returned map (the caller
 * leaves their subscriptions unchanged).
 */
async function loadLimitlessGroupChildren(slugs: string[]): Promise<Map<string, string[]>> {
  if (slugs.length === 0) return new Map();
  const rows = await query<{ slug: string; children: any }>(
    `SELECT slug, raw->'markets' AS children
       FROM limitless_markets
      WHERE slug = ANY($1::text[])
        AND raw->>'marketType' = 'group'`,
    [slugs],
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = Array.isArray(r.children) ? r.children : [];
    const childSlugs = arr
      .map((m: any) => m?.slug)
      .filter((s: any): s is string => typeof s === 'string' && s.length > 0);
    map.set(r.slug, childSlugs);
  }
  return map;
}

export function summariseByPlatform(subs: MarketSubscription[]): Record<Platform, number> {
  const counts = { kalshi: 0, polymarket: 0, limitless: 0, predict: 0 } as Record<Platform, number>;
  for (const s of subs) counts[s.platform]++;
  return counts;
}

export function summariseByOutcome(subs: MarketSubscription[]): {
  yes: number;
  no: number;
  none: number;
} {
  let yes = 0,
    no = 0,
    none = 0;
  for (const s of subs) {
    if (s.outcome === 'yes') yes++;
    else if (s.outcome === 'no') no++;
    else none++;
  }
  return { yes, no, none };
}
