/**
 * Identity-layer divergence sentinel — public surface.
 * See README.md in this directory for what it asserts + wiring instructions.
 */

export {
  DEFAULT_SENTINEL_CONFIG,
  type LegRef,
  type LegStatus,
  type PairKind,
  type PairMode,
  type PairStatus,
  type ReviewItem,
  type SentinelConfig,
  type SentinelSummary,
  type SentinelTick,
  type SpreadHistorySummary,
  type Verdict,
  type WatchPair,
} from './types.js';
export { buildWatchPairs, questionLabel, type RegistryOptions } from './registry.js';
export { DivergenceDetector } from './detector.js';
export {
  classifyEpisode,
  summarizeEpisode,
  isConverging,
  signConsistencyOf,
  directionOf,
  type EpisodeInput,
  type EpisodeSample,
} from './classifier.js';
export { SentinelSink, type SentinelSinkOptions } from './sink.js';
export { IdentitySentinel } from './sentinel.js';
