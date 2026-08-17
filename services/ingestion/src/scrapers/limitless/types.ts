// ============================================================================
// Limitless Exchange — Type Definitions
// ============================================================================

export interface LimitlessCollateralToken {
  address: string;
  decimals: 6;
  symbol: 'USDC';
}

export interface LimitlessVenue {
  exchange: string;  // verifyingContract for EIP-712 BUY
  adapter: string;   // approve CTF tokens here for SELL
}

/** Token IDs from the API (yes = YES positionId, no = NO positionId as BigInt strings) */
export interface LimitlessTokens {
  yes: string;
  no: string;
}

export type LimitlessTradeType = 'clob' | 'amm' | 'group';
export type LimitlessStatus = 'FUNDED' | 'RESOLVED' | string;

/**
 * NOTE on `raw` column contract: postgres.ts stores `JSON.stringify(m)` — the
 * full typed market object. Downstream SQL consumers read camelCase fields
 * (e.g. `conditionId`, `tradeType`) from the stored JSON. Same contract as
 * polymarket and predict; opposite of kalshi (which stores only the API blob).
 */
export interface LimitlessMarket {
  id: number;
  address?: string;             // may not always be present at top level
  conditionId: string;          // hex bytes32
  title: string;
  description: string;
  slug: string;                 // primary key for all API calls
  stableSlug?: string;
  collateralToken: LimitlessCollateralToken;
  /** Space-separated string "0.97 0.03" or tuple depending on API version */
  prices: string | [number, number];
  /** Token IDs for YES and NO outcomes */
  tokens: LimitlessTokens;
  /** Alias — populated from tokens if present */
  positionIds?: [string, string];
  venue: LimitlessVenue;
  tradeType: LimitlessTradeType;
  status: LimitlessStatus;
  expired: boolean;
  expirationTimestamp: number;  // ms epoch
  volume: string;               // raw USDC (6 dec)
  volumeFormatted: string;
  liquidity?: string;
  openInterest?: string;
  /** May be a comma-separated string or an array depending on API version */
  categories: string | string[];
  tags: string | string[];
  marketType?: string;
}

/** Lightweight slug entry from /markets/active/slugs */
export interface LimitlessSlugEntry {
  slug: string;
  strikePrice?: number;
  ticker?: string;
  deadline?: string;
  markets?: LimitlessMarket[];
}

/** Paginated response from GET /markets/active */
export interface ActiveMarketsResponse {
  data: LimitlessMarket[];
  totalMarketsCount: number;
}

/** Normalize a raw market from the API into a consistent shape */
export function normalizeMarket(m: LimitlessMarket): LimitlessMarket {
  // Ensure positionIds is populated from tokens
  if (!m.positionIds && m.tokens) {
    m.positionIds = [String(m.tokens.yes), String(m.tokens.no)];
  }
  return m;
}
