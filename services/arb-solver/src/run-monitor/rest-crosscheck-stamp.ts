/**
 * REST cross-check STAMP builder — re-fetches each traded leg's authoritative
 * REST orderbook and compares it to the WSS book the solver priced off.
 * INFO ONLY: never changes which arbs are detected, the portfolio, or the
 * execution grade. Never throws — every fetch path degrades to 'rest-unavailable'.
 */

import type { Platform } from '@arb/types';
import {
  fetchRestBook,
  compareBooks,
  type RestVerdict,
  type WssBookRef,
  type NormalizedRestBook,
  type RestBookRef,
} from '../clob/rest-crosscheck.js';
import {
  loadVerifiedPolymarketTokenMap,
  type PolymarketTokenMapLoader,
} from '../clob/token-map.js';

export interface RestLegCheck {
  marketId: number;
  platform: Platform;
  platformId: string;
  side: 'YES' | 'NO';
  wssBestBid: number;
  wssBestAsk: number;
  restBestBid: number | null;
  restBestAsk: number | null;
  /** |wss − rest| / rest × 1e4 on the consumed side, or null when unavailable. */
  deltaBps: number | null;
  verdict: RestVerdict;
  /** True when derived from a synthetic-NO (1 − YES) comparison rather than a native NO book. */
  derived?: boolean;
}

export interface RestValidation {
  checkedAt: string;
  budgetMs: number;
  timedOut: boolean;
  allValid: boolean;
  perLeg: RestLegCheck[];
}

export interface StampWssBook {
  bestBid: number;
  bestAsk: number;
  lastUpdate?: number;
  staleSince?: number | null;
}

export interface StampClusterMarket {
  marketId: number;
  platform: Platform;
  platformId: string;
  yesBook: StampWssBook | null;
  noBook: StampWssBook | null;
}

export interface StampLeg {
  marketId: number;
  platform: Platform;
  platformId: string;
  side: 'YES' | 'NO';
}

export interface BuildRestValidationInput {
  legs: StampLeg[];
  clusterMarkets: StampClusterMarket[];
  budgetMs: number;
  tokenMapLoader?: PolymarketTokenMapLoader;
  restFetcher?: (ref: RestBookRef) => Promise<NormalizedRestBook | null>;
}

const NO_BOOK: WssBookRef = { bestBid: 0, bestAsk: 2.0, staleSince: null };

function unavailableLeg(leg: StampLeg, wss: StampWssBook | null): RestLegCheck {
  return {
    marketId: leg.marketId,
    platform: leg.platform,
    platformId: leg.platformId,
    side: leg.side,
    wssBestBid: wss?.bestBid ?? 0,
    wssBestAsk: wss?.bestAsk ?? 2.0,
    restBestBid: null,
    restBestAsk: null,
    deltaBps: null,
    verdict: 'rest-unavailable',
  };
}

/** Never throws — returns a well-formed stamp even if the PM token-map load fails.
 *  `timedOut` is always false here; the caller sets it when its budget race pre-empts this promise. */
export async function buildRestValidation(
  input: BuildRestValidationInput,
): Promise<RestValidation> {
  const { legs, clusterMarkets, budgetMs } = input;
  const checkedAt = new Date().toISOString();
  const fetchBook = input.restFetcher ?? fetchRestBook;

  const byMarket = new Map<number, StampClusterMarket>(
    clusterMarkets.map((m) => [m.marketId, m]),
  );

  // A failure here is swallowed: PM legs go 'rest-unavailable' rather than guess a token.
  const pmConditionIds = [
    ...new Set(legs.filter((l) => l.platform === 'polymarket').map((l) => l.platformId)),
  ];
  let pmTokenMap = new Map<string, { yesTokenId: string; noTokenId: string }>();
  if (pmConditionIds.length > 0) {
    const loader = input.tokenMapLoader ?? loadVerifiedPolymarketTokenMap;
    try {
      pmTokenMap = await loader(pmConditionIds);
    } catch {
      pmTokenMap = new Map();
    }
  }

  const perLeg = await Promise.all(
    legs.map(async (leg): Promise<RestLegCheck> => {
      try {
        const market = byMarket.get(leg.marketId);
        const yesBook = market?.yesBook ?? null;
        const noBook = market?.noBook ?? null;

        let wss: StampWssBook | null;
        let consumedSide: 'ask' | 'bid';
        let fetchId: string | null;
        let derived = false;

        if (leg.side === 'YES') {
          wss = yesBook;
          consumedSide = 'ask';
          fetchId =
            leg.platform === 'polymarket'
              ? pmTokenMap.get(leg.platformId)?.yesTokenId ?? null
              : leg.platformId;
        } else if (leg.platform === 'polymarket' && noBook) {
          wss = noBook;
          consumedSide = 'ask';
          fetchId = pmTokenMap.get(leg.platformId)?.noTokenId ?? null;
        } else {
          // Synthetic NO (no native NO book): NO_ask = 1 − YES_bid, so comparing the
          // WSS YES-bid to the REST YES-bid is algebraically identical to comparing
          // NO_ask on both sides — no bid/ask inversion needed.
          wss = yesBook;
          consumedSide = 'bid';
          derived = true;
          fetchId =
            leg.platform === 'polymarket'
              ? pmTokenMap.get(leg.platformId)?.yesTokenId ?? null
              : leg.platformId;
        }

        // A missing PM token is never guessed — a wrong token fabricates a fake confirmation.
        if (!wss || fetchId == null) {
          return unavailableLeg(leg, wss);
        }

        const rest = await fetchBook({ platform: leg.platform, id: fetchId });
        const cmp = compareBooks(
          { bestBid: wss.bestBid, bestAsk: wss.bestAsk, staleSince: wss.staleSince ?? null, lastUpdate: wss.lastUpdate },
          rest,
          consumedSide,
        );

        return {
          marketId: leg.marketId,
          platform: leg.platform,
          platformId: leg.platformId,
          side: leg.side,
          wssBestBid: wss.bestBid,
          wssBestAsk: wss.bestAsk,
          restBestBid: cmp.restBestBid,
          restBestAsk: cmp.restBestAsk,
          deltaBps: cmp.deltaBps,
          verdict: cmp.verdict,
          ...(derived ? { derived: true } : {}),
        };
      } catch {
        const market = byMarket.get(leg.marketId);
        return unavailableLeg(leg, market?.yesBook ?? null);
      }
    }),
  );

  return {
    checkedAt,
    budgetMs,
    timedOut: false,
    allValid: perLeg.length > 0 && perLeg.every((p) => p.verdict === 'valid'),
    perLeg,
  };
}

/** Most → least severe, for a compact list indicator. */
const VERDICT_SEVERITY: Record<RestVerdict, number> = {
  crossed: 4,
  mismatch: 3,
  'rest-unavailable': 2,
  stale: 1,
  valid: 0,
};
export function worstVerdict(perLeg: RestLegCheck[]): RestVerdict {
  let worst: RestVerdict = 'valid';
  for (const l of perLeg) {
    if (VERDICT_SEVERITY[l.verdict] > VERDICT_SEVERITY[worst]) worst = l.verdict;
  }
  return worst;
}
