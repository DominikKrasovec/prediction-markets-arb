/**
 * Unified cross-platform category classifier — the single source of truth for
 * the keyword regex map + `classifyCategoryLabels`, both of which produce
 * `markets.category_unified`.
 *
 * Placed in @arb/types (not a new package) because it is a pure classifier over
 * the UNIFIED_CATEGORIES enum SoT with zero runtime deps, and both consumers
 * (the pipeline and the DB-less ingestion bench) already import @arb/types.
 * category-taxonomy.ts and unified-category.ts re-export
 * `classifyCategoryLabels` from here.
 */
import { type UnifiedCategory, UNIFIED_CATEGORIES } from './pipeline.js';

/**
 * Keyword map — case-insensitive substring match against a label or tag list.
 * Multiple hits: the order in UNIFIED_CATEGORIES wins (sports > crypto > ...).
 */
export const KEYWORDS: Record<UnifiedCategory, RegExp> = {
  sports: /\b(?:sports?|football|soccer|nba|nfl|mlb|nhl|tennis|boxing|mma|ufc|hockey|baseball|basketball|golf|cricket|rugby|esports?|dota2?|csgo|cs2|lol|league of legends|valorant|overwatch|props|off the pitch|football matches|finals?|playoffs?|championship|world cup|world series|super bowl|stanley cup|draft|mvp|game|epl|lal|fl1|ncaa[a-z]*|fifa|uefa|laliga|bundesliga|kbo|ipl|racing|pickleball|ppa|rebounds?|assists?)\b|o\/u|spread:/i,
  crypto: /\b(?:crypto(?:currency)?|bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|doge|dogecoin|bnb|binance|hype|hyperliquid|altcoin|stablecoin|defi|nfts?|web3|token|blockchain|up or down|crypto prices|pre-tge|satoshi|bch|trx|hbar|avax|xmr|ltc|ondo|monero|litecoin|chainlink|hedera|tron|avalanche|mantle)\b/i,
  election: /\b(?:elections?|primaries|primary|presidential|vice presidential|gubernatorial|senate|congressional|midterm|nominee|ballot|vote|voting|caucus|electoral|house race)\b/i,
  politics: /\b(?:politics|policy|policies|legislation|bill passed|executive order|supreme court|ruling|tariff|veto|filibuster|trump|biden|democrat|republican|gop)\b|current[- ]affairs/i,
  economic: /\b(?:economics?|economy|gdp|inflation|interest rate|federal reserve|\bfed\b|recession|unemployment|cpi|ppi|stock market|treasury|yield|bond|s&p|nasdaq|dow|oil|gas|wti|brent|commodities?|commodity|financials?|finance|compan(?:y|ies)|company news|ai stocks|korean market|gold|silver|xau|xag|heating oil|crude|platinum|palladium|sugar|corn|coffee|copper|nickel|wheat|soybean|lumber|business|earnings|revenue)\b/i,
  entertainment: /\b(?:entertainment|oscar|grammy|emmy|movie|film|album|billboard|concert|tour|netflix|spotify|disney|streaming|celebrity|mentions|culture|music|art|television)\b/i,
  technology: /\b(?:technology|tech|ai|artificial intelligence|gpt|openai|apple|microsoft|google|meta|tesla|spacex|launch|rocket|satellite|quantum|semiconductor|chip|science|twitter)\b/i,
  weather: /\b(?:weather|climate|temperature|temp|hurricane|storm|rain|snow|drought|wildfire)\b/i,
  geopolitical: /\bgeopolitic\w*|\b(?:war|conflict|invasion|sanction|nato|united nations|\bun\b|military|ceasefire|treaty|peace|diplomatic|annex|china|russia|ukraine|taiwan|iran|north korea|syria|israel|palestine|gaza|middle east|world)\b/i,
  other: /^(?!)/, // never matches; fallback is explicit
};

/**
 * Classify any label or array of labels to a UnifiedCategory.
 * Returns 'other' only if nothing matches — callers can then decide whether
 * to leave NULL or persist 'other'.
 */
export function classifyCategoryLabels(labels: (string | null | undefined)[]): UnifiedCategory {
  const text = labels.filter(Boolean).join(' | ');
  if (!text) return 'other';
  // Preserve priority: first in UNIFIED_CATEGORIES wins.
  for (const cat of UNIFIED_CATEGORIES) {
    if (cat === 'other') continue;
    if (KEYWORDS[cat].test(text)) return cat;
  }
  return 'other';
}
