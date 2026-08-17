/** SSE Event Bus — Channel & payload types */

export const CHANNELS = ['markets', 'pipeline', 'arbitrage', 'prices'] as const;
export type Channel = (typeof CHANNELS)[number];

export type MarketsEventType = 'synced';
export type PipelineEventType = 'started' | 'phase_complete' | 'completed' | 'error' | 'graph_updated' | 'sync' | 'stage23_start' | 'stage23_done' | 'solver:graph_reloaded';
export type ArbitrageEventType = 'arb:detected' | 'arb:expired';
export type PriceEventType = 'clob_update' | 'batch_update';

export interface MarketsSyncedPayload {
  platform: string;
  marketsUpserted: number;
  newMarkets: number;
  timestamp: string;
}

export interface PipelinePhasePayload {
  runId: number;
  phase: number;
  phaseName: string;
  stats: Record<string, number>;
  durationMs: number;
}

export interface ArbitrageOpportunityPayload {
  id: number;
  opportunityType: string;
  edgeDescription: string;
  legA: { platform: string; title: string; side: string; price: number };
  legB: { platform: string; title: string; side: string; price: number };
  combinedCost: number;
  expectedProfit: number;
  profitPct: number;
  maxSizeUsd: number;
  confidence: number;
  deterministic: boolean;
}

export interface BusEvent<T = unknown> {
  id: string;
  channel: Channel;
  type: string;
  data: T;
  timestamp: string;
}

export interface PublishRequest {
  channel: Channel;
  type: string;
  data: unknown;
}

export interface ClobPriceUpdatePayload {
  marketId: number;
  platform: string;
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
}

export interface GraphUpdatedPayload {
  outcomeSets: number;
  ruleEdges: number;
  llmEdges: number;
  transitiveEdges: number;
  timestamp: string;
}
