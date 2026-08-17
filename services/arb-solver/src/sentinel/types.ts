// Identity-layer divergence sentinel: watches equivalent/mutex market pairs for
// persistent post-news price disagreement. Platform-agnostic, time-injected (no wall clocks).

import type { Platform } from '@arb/types';

export type PairKind =
  | 'equiv-edge'
  | 'member-fungibility'
  | 'mutex-edge';

export type PairMode =
  | 'equal'
  | 'mutex';

export interface LegRef {
  marketId: number;
  platform: Platform;
  platformId: string;
  questionId: number;
  // The loader does not carry market titles; pass RegistryOptions.marketTitles for real ones.
  label: string;
}

export interface WatchPair {
  pairId: string;
  kind: PairKind;
  mode: PairMode;
  legA: LegRef;
  legB: LegRef;
  edgeId?: number;
  edgeType?: string;
  edgeConfidence?: number;
}

export interface SentinelTick {
  marketId: number;
  bestBid: number;
  // $2 = the price-cache "unpriced" sentinel → ignored.
  bestAsk: number;
  timestamp: number;
  bidSize?: number;
  askSize?: number;
}

export interface SentinelConfig {
  spreadThreshold: number;
  mutexFeeAllowance: number;
  mutexThreshold: number;
  persistenceWindowMs: number;
  fastWindowMs: number;
  activityWindowMs: number;
  minUpdatesInActivityWindow: number;
  // An alerted pair re-arms only after the metric drops below threshold × clearRatio.
  clearRatio: number;
  spikeMoveMin: number;
  spikeBurstMs: number;
  spikeMinUpdates: number;
  minSampleGapMs: number;
  maxEpisodeSamples: number;
  // Crossable disagreement max(0, bid_a-ask_b, bid_b-ask_a) instead of |mid_a-mid_b|.
  useCrossablePrices: boolean;
  signConsistencyMin: number;
  convergenceRatio: number;
}

export const DEFAULT_SENTINEL_CONFIG: SentinelConfig = {
  spreadThreshold: 0.05,
  mutexFeeAllowance: 0.02,
  mutexThreshold: 0.03,
  persistenceWindowMs: 60 * 60_000, // 60 min
  fastWindowMs: 10 * 60_000, // 10 min
  activityWindowMs: 30 * 60_000, // 30 min
  minUpdatesInActivityWindow: 2,
  clearRatio: 0.5,
  spikeMoveMin: 0.1,
  spikeBurstMs: 5 * 60_000,
  spikeMinUpdates: 3,
  minSampleGapMs: 1_000,
  maxEpisodeSamples: 512,
  useCrossablePrices: false,
  signConsistencyMin: 0.9,
  convergenceRatio: 0.6,
};

export type Verdict =
  | 'suspect-identity'
  | 'segmentation-latency'
  | 'liveness';

export interface SpreadHistorySummary {
  samples: number;
  maxMetric: number;
  meanMetric: number;
  lastMetric: number;
  // Mutex mode: equals the metric.
  lastSigned: number;
  signConsistency: number;
  direction: 'a-over-b' | 'b-over-a' | 'mixed';
  converging: boolean;
}

export interface LegStatus extends LegRef {
  lastBid: number | null;
  lastAsk: number | null;
  lastUpdateAt: number | null;
  active: boolean;
}

export interface ReviewItem {
  pairId: string;
  kind: PairKind;
  mode: PairMode;
  verdict: Verdict;
  // True via the post-volume-spike fast path: info arrived, one leg moved, the other didn't.
  postSpike: boolean;
  spikeLeg: 'a' | 'b' | null;
  edgeId?: number;
  edgeType?: string;
  questionIds: [number, number];
  legA: LegStatus;
  legB: LegStatus;
  spread: SpreadHistorySummary;
  episodeStartedAt: number;
  alertedAt: number;
  firstAlertAt: number;
  alertCount: number;
}

export interface PairStatus {
  pairId: string;
  kind: PairKind;
  state: 'idle' | 'pending' | 'alerted';
  lastItem: ReviewItem | null;
  alertCount: number;
}

export interface SentinelSummary {
  pairsWatched: number;
  pairsPending: number;
  pairsAlerted: number;
  byVerdict: Record<Verdict, number>;
  topSuspects: ReviewItem[];
}
