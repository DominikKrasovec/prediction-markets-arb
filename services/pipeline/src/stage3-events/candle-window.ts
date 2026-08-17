/** Deterministic crypto "Up or Down" candle parser: extracts (asset, duration) from the title
 *  so Stage-3b can confirm candle pairs without an LLM (the embedding can't tell "2:00-2:05"
 *  from "2:00-2:15"). */

export interface CandleWindow {
  asset: string;
  durationMin: number;
  /** True when the duration was inferred from an ambiguous single-hour title (could be a
   *  1-hour or a 5-min top-of-hour candle); the matcher defers a mismatch to the LLM. */
  ambiguous: boolean;
}

const CRYPTO_ASSETS: Record<string, string> = {
  bitcoin: 'BTC', btc: 'BTC',
  ethereum: 'ETH', eth: 'ETH',
  solana: 'SOL', sol: 'SOL',
  dogecoin: 'DOGE', doge: 'DOGE',
  xrp: 'XRP', ripple: 'XRP',
  bnb: 'BNB',
  sui: 'SUI',
  cardano: 'ADA', ada: 'ADA',
  avalanche: 'AVAX', avax: 'AVAX',
  chainlink: 'LINK', link: 'LINK',
  litecoin: 'LTC', ltc: 'LTC',
  polkadot: 'DOT', dot: 'DOT',
  hyperliquid: 'HYPE', hype: 'HYPE',
  near: 'NEAR',
  zec: 'ZEC', zcash: 'ZEC',
};

const ASSET_RX = /^\s*([A-Za-z]+)\s+up\s+or\s+down\b/i;
// Kalshi's KX{ASSET}15M series MARKET title (e.g. "ETH price up in next 15 mins?"); the
// Stage-3b matcher must pass this stable title, not the volatile platform_events display string.
const KALSHI_CANDLE_RX = /^\s*([A-Za-z]+)\s+price\s+up\s+in\s+next\s+(\d+)\s*min(?:ute)?s?\b/i;
const RANGE_RX = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const SINGLE_HOUR_RX = /,\s*(\d{1,2})\s*(am|pm)\s+et\b/i;
const DAILY_RX = /\bup\s+or\s+down\s+on\s+[a-z]{3}/i;

export function parseCandleAsset(title: string): string | null {
  const m = ASSET_RX.exec(title);
  if (!m) return null;
  return CRYPTO_ASSETS[m[1]!.toLowerCase()] ?? null;
}

function toMinuteOfDay(h: string, mm: string | undefined, ampm: string): number {
  let hr = parseInt(h, 10) % 12;
  if (ampm.toLowerCase() === 'pm') hr += 12;
  return hr * 60 + (mm ? parseInt(mm, 10) : 0);
}

function parseDurationSuffix(title: string): number | null {
  const t = title.toLowerCase();
  if (/\b5\s*min/.test(t)) return 5;
  if (/\b15\s*min/.test(t)) return 15;
  if (/\b30\s*min/.test(t)) return 30;
  if (/\b4\s*hours?\b/.test(t)) return 240;
  if (/\b1\s*hours?\b/.test(t) || /\bhourly\b/.test(t)) return 60;
  if (/\b1\s*days?\b/.test(t) || /\bdaily\b/.test(t)) return 1440;
  if (/\b1\s*weeks?\b/.test(t) || /\bweekly\b/.test(t)) return 10080;
  return null;
}

// Exact-equality snap is load-bearing: live single-hour rows are exactly 60 or exactly
// 1500/negative garbage, so a tolerance window would corrupt them instead of falling back.
const CANDLE_DURATION_WHITELIST = new Set([5, 15, 30, 60, 240, 1440, 10080]);

/** The OPEN is not parsed here — callers use platform_events.condition_date. `windowMin`
 *  (optional, the gated resolution window) lets an ambiguous single-hour title resolve
 *  deterministically when it snaps exactly to a known candle length. */
export function parseCandleWindow(title: string, windowMin?: number): CandleWindow | null {
  const k = KALSHI_CANDLE_RX.exec(title);
  if (k) {
    const kAsset = CRYPTO_ASSETS[k[1]!.toLowerCase()];
    const kDur = parseInt(k[2]!, 10);
    if (kAsset && Number.isInteger(kDur) && kDur > 0) {
      return { asset: kAsset, durationMin: kDur, ambiguous: false };
    }
    return null;
  }

  const asset = parseCandleAsset(title);
  if (!asset) return null;

  const r = RANGE_RX.exec(title);
  if (r) {
    const open = toMinuteOfDay(r[1]!, r[2], r[3]!);
    const close = toMinuteOfDay(r[4]!, r[5], r[6]!);
    const dur = ((close - open) % 1440 + 1440) % 1440;
    if (dur > 0) return { asset, durationMin: dur, ambiguous: false };
  }

  const suffix = parseDurationSuffix(title);
  if (suffix) return { asset, durationMin: suffix, ambiguous: false };

  if (SINGLE_HOUR_RX.test(title)) {
    if (
      windowMin != null &&
      Number.isFinite(windowMin) &&
      windowMin > 0 &&
      CANDLE_DURATION_WHITELIST.has(Math.round(windowMin))
    ) {
      return { asset, durationMin: Math.round(windowMin), ambiguous: false };
    }
    return { asset, durationMin: 60, ambiguous: true };
  }

  if (DAILY_RX.test(title)) return { asset, durationMin: 1440, ambiguous: false };

  return null;
}
