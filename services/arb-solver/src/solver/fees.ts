import type { Platform } from '@arb/types';

// Per-market, form-aware taker-fee model for the execution gate (Axis 3),
// folded into the LP's objective coefficient. Monotone-tightening: every
// default/unknown rounds toward a HIGHER fee, so it can only shrink or
// reject an arb, never manufacture one. BERNOULLI (Kalshi/Polymarket/Predict)
// uses rate*(p*(1-p))^exponent; LIMITLESS_CURVE applies a flat conservative
// buy/sell-asymmetric upper bound. No gas term on any venue.

export type FeeForm = 'bernoulli' | 'limitless-curve';

export interface FeeModel {
  form: FeeForm;
  rate: number;
  exponent: number;
}

// Keys are our unified taxonomy slugs (markets.category_unified), NOT
// Polymarket's prose category names.
const PM_CATEGORY_RATE: Record<string, number> = {
  crypto: 0.07,
  economic: 0.05,
  entertainment: 0.05,
  weather: 0.05,
  other: 0.05,
  politics: 0.04,
  election: 0.04,
  technology: 0.04,
  sports: 0.03,
  geopolitical: 0.0,
};
const PM_DEFAULT_RATE = 0.05;

// KX-prefixed series roots priced at the reduced tier (S&P 500, Nasdaq-100).
const KALSHI_INDEX_SERIES_ROOTS: readonly string[] = ['KXINX', 'KXNASDAQ100'];
const KALSHI_INDEX_FEE_RATE = 0.035;
const KALSHI_GENERAL_FEE_RATE = 0.07;

export function feePerShare(model: FeeModel, price: number, side: 'buy' | 'sell'): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(price) ? price : 0));
  let fee: number;
  if (model.form === 'limitless-curve') {
    fee = (side === 'buy' ? 0.03 : 0.015) * p;
  } else {
    const rate = Number.isFinite(model.rate) && model.rate > 0 ? model.rate : 0;
    const exponent = Number.isFinite(model.exponent) && model.exponent > 0 ? model.exponent : 1;
    fee = rate * Math.pow(p * (1 - p), exponent);
  }
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

export function defaultFeeModel(platform: Platform): FeeModel {
  switch (platform) {
    case 'kalshi':
      return { form: 'bernoulli', rate: 0.07, exponent: 1 };
    case 'polymarket':
      return { form: 'bernoulli', rate: PM_DEFAULT_RATE, exponent: 1 };
    case 'predict':
      return { form: 'bernoulli', rate: 0.02, exponent: 1 };
    case 'limitless':
      return { form: 'limitless-curve', rate: 0, exponent: 1 };
    default: {
      const _exhaustive: never = platform;
      void _exhaustive;
      return { form: 'bernoulli', rate: 0.07, exponent: 1 };
    }
  }
}

export function resolveFeeModel(
  platform: Platform,
  inputs: {
    categoryUnified?: string | null;
    feeRateBps?: string | number | null;
    eventTicker?: string | null;
  },
): FeeModel {
  switch (platform) {
    case 'kalshi': {
      const prefix = (inputs.eventTicker ?? '').split('-')[0]?.trim() ?? '';
      const indexSeries = KALSHI_INDEX_SERIES_ROOTS.some((root) => prefix.startsWith(root));
      const rate = indexSeries ? KALSHI_INDEX_FEE_RATE : KALSHI_GENERAL_FEE_RATE;
      return { form: 'bernoulli', rate, exponent: 1 };
    }
    case 'polymarket': {
      const cat = inputs.categoryUnified?.trim().toLowerCase() ?? '';
      const rate = cat in PM_CATEGORY_RATE ? PM_CATEGORY_RATE[cat] : PM_DEFAULT_RATE;
      return { form: 'bernoulli', rate, exponent: 1 };
    }
    case 'predict': {
      const bps = Number(inputs.feeRateBps);
      const rate = Number.isFinite(bps) && bps > 0 ? bps / 10000 : 0.02;
      return { form: 'bernoulli', rate, exponent: 1 };
    }
    case 'limitless':
      return { form: 'limitless-curve', rate: 0, exponent: 1 };
    default:
      return defaultFeeModel(platform);
  }
}
