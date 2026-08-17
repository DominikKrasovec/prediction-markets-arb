import 'dotenv/config';
import { readEnv } from '@arb/types';

export const config = {
  pg: {
    host: process.env.PG_HOST ?? 'localhost',
    port: parseInt(process.env.PG_PORT ?? '5432'),
    database: process.env.PG_DATABASE ?? 'prediction_arb',
    user: process.env.PG_USER ?? 'arb',
    password: process.env.PG_PASSWORD ?? 'arb_local_dev',
  },

  pairing: {
    // Crypto window stays < the 5-min candle interval so it can never reach an adjacent candle.
    sameEventCryptoToleranceMs: parseInt(process.env.PAIR_DATE_TOL_CRYPTO_MS ?? `${4 * 60 * 1000}`),
    sameEventHourToleranceMs: parseInt(process.env.PAIR_DATE_TOL_HOUR_MS ?? `${60 * 60 * 1000}`),
    sameEventDefaultToleranceMs: parseInt(process.env.PAIR_DATE_TOL_DEFAULT_MS ?? `${24 * 60 * 60 * 1000}`),
  },

  embedding: {
    embedMarkets: process.env.EMBED_MARKETS === '1',
    skipParlayMarkets: process.env.EMBED_PARLAYS !== '1',
  },

  events: {
    // Cosine DISTANCE (pgvector `<=>`), not similarity: similarity = 1 − distance.
    annCosineDistanceMax: parseFloat(process.env.EVENT_ANN_COSINE_DISTANCE_MAX ?? '0.35'),
    minMatchConfidence: parseFloat(process.env.EVENT_MATCH_MIN_CONFIDENCE ?? '0.6'),
    childrenSampleSize: parseInt(process.env.EVENT_MATCH_CHILDREN_SAMPLE ?? '20'),
    matchDrainBatch: parseInt(process.env.EVENT_MATCH_DRAIN_BATCH ?? '200'),
    // Max candidates one daemon tick drains through paid LLM calls; a non-positive value is clamped up.
    matchTickCap: (() => {
      const n = parseInt(process.env.STAGE3_TICK_CAP ?? '2000');
      return Number.isFinite(n) && n > 0 ? n : 2000;
    })(),
    // Daily (UTC) llm_logs.cost_usd ceiling; crossing it halts Stage-3b LLM spend for the rest of the day.
    dailyCostLimitUsd: (() => {
      const n = parseFloat(process.env.STAGE3_DAILY_COST_LIMIT_USD ?? '10');
      return Number.isFinite(n) && n > 0 ? n : 10;
    })(),
    embeddingModel: readEnv('EMBED_MODEL', { alias: 'EVENT_EMBEDDING_MODEL' }) ?? 'text-embedding-3-small',
    embedChildSample: parseInt(readEnv('EMBED_CHILD_SAMPLE', { alias: 'EVENT_EMBED_CHILD_SAMPLE' }) ?? '60'),
    embedDateHorizonDays: parseInt(
      readEnv('EMBED_DATE_HORIZON_DAYS', { alias: 'EVENT_EMBED_DATE_HORIZON_DAYS' }) ?? '120',
    ),
    titleWeightWhenDateless: parseInt(process.env.EVENT_TITLE_WEIGHT_DATELESS ?? '3'),
  },

  arb: {
    minProfit: parseFloat(process.env.ARB_MIN_PROFIT ?? '0.01'),
    minEdgeConfidence: parseFloat(
      readEnv('SOLVE_MIN_EDGE_CONFIDENCE', { alias: 'MIN_EDGE_CONFIDENCE' }) ?? '0.70',
    ),
  },

  stage1: {
    newEntityFlushThreshold: parseInt(process.env.NEW_ENTITY_FLUSH_THRESHOLD ?? '1000', 10),
    marketsFlushInterval: parseInt(process.env.MARKETS_FLUSH_INTERVAL ?? '10000', 10),
    entityEnrichmentSkip: process.env.ENTITY_ENRICHMENT_SKIP === '1',

    // off = no gate; warn = log would-be-rejections but let merges through; enforce = actually block them.
    kbHistogramGateMode: ((process.env.KB_HISTOGRAM_GATE_MODE ?? 'off') as 'off' | 'warn' | 'enforce'),
    kbHistogramGateMinMass: parseFloat(process.env.KB_HISTOGRAM_GATE_MIN_MASS ?? '0.10'),
  },

  llm: {
    implicationMinConfidence: parseFloat(process.env.LLM_IMPLICATION_MIN_CONFIDENCE ?? '0.70'),
  },

  batchSize: parseInt(process.env.PIPELINE_BATCH_SIZE ?? '500'),
  intervals: {
    fullRunMs: parseInt(process.env.FULL_RUN_INTERVAL_MS ?? '300000'), // 5 minutes
  },
} as const;
