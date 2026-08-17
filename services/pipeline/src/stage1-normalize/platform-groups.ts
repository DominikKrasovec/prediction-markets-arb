import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import type { Platform } from '@arb/types';

const log = createLogger('platform-groups');

/**
 * Use platform-native grouping that the APIs already give us FOR FREE.
 *
 * - Polymarket: eventId groups related markets in the same event
 * - Predict:    categories group markets by topic (categorySlug)
 * - Kalshi:     event_ticker groups binary contracts for one resolution
 * - Limitless:  no native event grouping in the public API yet
 *
 * This is the cheapest, most reliable grouping signal — the platforms already did the work.
 */

interface PlatformGroupResult {
  market_id: number;
  platform: Platform;
  platform_group_id: string | null;
  platform_cross_ref: string | null;  // reserved for future cross-platform links
}

/**
 * Pure, no-DB function: derive the platform-native group ID for a market
 * from the raw scraper JSON. Used inline by sync.ts (so featurization can
 * happen in the same batch as upsert) and by `extractPlatformGroups()`
 * below as the daemon/backfill entry point.
 *
 * Keep this in lock-step with the SQL CASE in
 * `getUnfeaturizedMarketsWithGroups` (markets.ts) — both must produce the
 * same group ID for the same raw doc.
 */
export function computePlatformGroup(
  platform: Platform,
  raw: Record<string, unknown> | null | undefined
): { platform_group_id: string | null; platform_cross_ref: string | null } {
  if (!raw) return { platform_group_id: null, platform_cross_ref: null };
  const r = raw as Record<string, any>;
  let groupId: string | null = null;

  switch (platform) {
    case 'polymarket': {
      const negRisk = r.negRisk === true || r.negRisk === 'true';
      const negRiskId = typeof r.negRiskMarketID === 'string' && r.negRiskMarketID !== '' ? r.negRiskMarketID : null;
      if (negRisk && negRiskId) {
        groupId = `polymarket:negRisk:${negRiskId}`;
      } else if (r.eventId != null && r.eventId !== '') {
        groupId = `polymarket:event:${r.eventId}`;
      }
      break;
    }
    case 'kalshi': {
      const ticker = typeof r.event_ticker === 'string' && r.event_ticker !== ''
        ? r.event_ticker
        : null;
      if (ticker) {
        // Bundle (non-exclusive) tickers — multiple sibling markets within
        // the event group can resolve YES simultaneously; the mutex builder
        // must not fire edges across these pairs.
        //
        //   MENTION / SAY — speech/mention prop-bets (a speaker can say
        //                   multiple words in one speech).
        //   KXMVE*        — multi-game / cross-category parlay families.
        //                   Each child is a distinct parlay ticket with its
        //                   own leg set; two parlays sharing an event_ticker
        //                   can both win or both lose independently. The
        //                   broad `KXMVE` prefix future-proofs against new
        //                   parlay families; sync.ts `classifyMarketsUnified`
        //                   and entity-enrichment already use `^KXMVE`, so
        //                   keeping this path broad too prevents drift.
        groupId = /MENTION|SAY|KXMVE/i.test(ticker)
          ? `kalshi:bundle:${ticker}`
          : `kalshi:event:${ticker}`;
      }
      break;
    }
    case 'predict': {
      const slug = typeof r.categorySlug === 'string' && r.categorySlug !== '' ? r.categorySlug : null;
      if (slug) groupId = `predict:category:${slug}`;
      break;
    }
    case 'limitless':
      // No native event grouping in the public API yet.
      break;
  }

  return { platform_group_id: groupId, platform_cross_ref: null };
}

/**
 * Fetch platform-native group IDs from raw JSONB data stored alongside markets.
 * Returns group assignments per market.
 */
export async function extractPlatformGroups(): Promise<PlatformGroupResult[]> {
  log.info('Extracting platform-native grouping');
  const results: PlatformGroupResult[] = [];

  // Single SQL pass — fetch (id, platform, raw) for every active market and
  // dispatch into the pure `computePlatformGroup` helper.
  // `extractPlatformGroups` is the daemon/backfill entry point only; new
  // markets get their group ID inline at sync time.
  //
  // Notes on group-key semantics (mirrored in `computePlatformGroup`):
  //   - Polymarket negRisk = on-chain mutex protocol; every market sharing
  //     a `negRiskMarketID` resolves so exactly one is YES. That ID — NOT
  //     the UX-level `eventId` — is the correct mutex partition key. A
  //     single `eventId` can mix multiple independent negRisk groups and
  //     standalone binaries.
  //   - Kalshi speech/mention bundles ("Will X say Y?") are NOT mutually
  //     exclusive — a speaker can say multiple words in one speech. The
  //     `kalshi:bundle:` prefix steers isBundleIntraEventPair to skip_llm
  //     instead of letting M2 fire a false mutual_exclusion edge.
  const rows = await query<{
    id: number; platform: Platform; raw: Record<string, unknown> | null;
  }>(
    `SELECT m.id, m.platform, mm.raw
     FROM markets m
     LEFT JOIN market_metadata_raw mm ON mm.market_id = m.id`
  );

  for (const m of rows) {
    const { platform_group_id, platform_cross_ref } = computePlatformGroup(m.platform, m.raw);
    results.push({
      market_id: m.id,
      platform: m.platform,
      platform_group_id,
      platform_cross_ref,
    });
  }

  const withGroups = results.filter((r) => r.platform_group_id !== null).length;
  const withCrossRef = results.filter((r) => r.platform_cross_ref !== null).length;
  log.info(`${withGroups} markets with platform groups, ${withCrossRef} with cross-platform links`);

  return results;
}
