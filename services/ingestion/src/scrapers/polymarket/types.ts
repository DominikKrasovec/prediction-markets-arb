/** Polymarket API — no runtime constants needed */

/**
 * A Polymarket market as returned by `parseMarket()` in api-client.ts.
 *
 * NOTE on `raw` column contract: postgres.ts stores `JSON.stringify(m)` — the
 * full transformed object including the nested `rawData` field (original API
 * blob).  Downstream pipeline code (platform-groups.ts, sync.ts) reads
 * camelCase fields (e.g. `negRisk`, `eventId`) from the stored JSON, so the
 * contract is intentionally post-transform.  Do NOT change to `JSON.stringify(m.rawData)`
 * without updating every SQL consumer that reads `market_metadata_raw.raw`.
 */
export interface PolymarketMarket {
  id: string;
  eventId: string;
  question: string;
  description: string;
  conditionId: string;
  slug: string;
  resolutionSource: string;
  endDateIso: string;
  startDateIso: string;
  endDate: string;
  startDate: string;
  createdAt: string;
  updatedAt: string;
  category: string;
  tags: unknown[];
  outcomePrices: unknown[];
  volumeNum: number;
  liquidityNum: number;
  volume24hr: number;
  volume1wk: number;
  volume1mo: number;
  volume1yr: number;
  icon: string;
  image: string;
  outcomes: unknown[];
  clobTokenIds: unknown[];
  marketMakerAddress: string;
  enableOrderBook: boolean;
  closed: boolean;
  active: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  acceptingOrdersTimestamp: string;
  new: boolean;
  featured: boolean;
  restricted: boolean;
  volume: string;
  liquidity: string;
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: unknown | null;
  spread: unknown | null;
  oneWeekPriceChange: unknown | null;
  oneMonthPriceChange: unknown | null;
  resolvedBy: string;
  winningOutcome: unknown | null;
  questionID: string;
  submitted_by: string;
  negRisk: boolean;
  negRiskMarketID: string;
  negRiskRequestID: string;
  umaBond: string;
  umaReward: string;
  competitive: number;
  groupItemTitle: string;
  groupItemThreshold: string;
  /** Original API blob, preserved for raw-state reconstruction. */
  rawData: Record<string, unknown>;
}

/**
 * A Polymarket event as shaped by the batch loop in api-client.ts.
 */
export interface PolymarketEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  startDateIso: string;
  endDateIso: string;
  icon: string;
  image: string;
  creationDate: string;
  category: string;
  tags: unknown[];
  markets: unknown[];
  /** Original API blob. */
  rawData: Record<string, unknown>;
}
