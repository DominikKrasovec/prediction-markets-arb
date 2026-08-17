/**
 * Verdict classifier — pure functions over a finished/alerting breach episode.
 *
 * Decision table:
 *   one leg stale/inactive            → 'liveness'            (dead book, not identity)
 *   persistent ONE-directional spread
 *     + both books active             → 'suspect-identity'    (the identity-layer FP signal)
 *   oscillating or converging spread  → 'segmentation-latency'(microstructure, not semantics)
 *
 * Note on mutex pairs: the metric max(0, pA+pB−(1+fees)) is non-negative, so a
 * persistent violation is always "one-directional" → a persistent mutex breach
 * with both books active classifies as 'suspect-identity' (the asserted mutual
 * exclusion is wrong — or it is a real, live arb; either way a human looks).
 */

import type { SentinelConfig, SpreadHistorySummary, Verdict } from './types.js';

/** One recorded spread observation inside an episode. */
export interface EpisodeSample {
  t: number;
  /** Breach metric (≥ 0): equal-mode spread or mutex-mode overshoot. */
  metric: number;
  /** Signed spread mid_a − mid_b (equal mode); = metric for mutex mode. */
  signed: number;
}

export interface EpisodeInput {
  samples: EpisodeSample[];
  legAActive: boolean;
  legBActive: boolean;
}

/**
 * Convergence test: is the spread shrinking over the episode? Mean metric of
 * the second half < ratio × mean of the first half (needs ≥ 4 samples).
 */
export function isConverging(samples: readonly EpisodeSample[], ratio: number): boolean {
  if (samples.length < 4) return false;
  const half = Math.floor(samples.length / 2);
  const mean = (xs: readonly EpisodeSample[]): number =>
    xs.reduce((s, x) => s + x.metric, 0) / xs.length;
  const first = mean(samples.slice(0, half));
  const second = mean(samples.slice(half));
  return second < ratio * first;
}

/**
 * Sign consistency: max(#pos, #neg) / #non-zero signed samples. 1 when there
 * are no non-zero samples (a zero-signed episode cannot oscillate).
 */
export function signConsistencyOf(samples: readonly EpisodeSample[]): number {
  let pos = 0;
  let neg = 0;
  for (const s of samples) {
    if (s.signed > 0) pos++;
    else if (s.signed < 0) neg++;
  }
  const nonZero = pos + neg;
  if (nonZero === 0) return 1;
  return Math.max(pos, neg) / nonZero;
}

export function directionOf(
  samples: readonly EpisodeSample[],
  consistencyMin: number,
): SpreadHistorySummary['direction'] {
  let pos = 0;
  let neg = 0;
  for (const s of samples) {
    if (s.signed > 0) pos++;
    else if (s.signed < 0) neg++;
  }
  if (pos + neg === 0) return 'mixed';
  const dominant = Math.max(pos, neg) / (pos + neg);
  if (dominant < consistencyMin) return 'mixed';
  return pos >= neg ? 'a-over-b' : 'b-over-a';
}

/** Build the compact spread-history summary recorded on a review item. */
export function summarizeEpisode(
  samples: readonly EpisodeSample[],
  cfg: Pick<SentinelConfig, 'signConsistencyMin' | 'convergenceRatio'>,
): SpreadHistorySummary {
  const n = samples.length;
  const last = n > 0 ? samples[n - 1]! : null;
  const sum = samples.reduce((s, x) => s + x.metric, 0);
  return {
    samples: n,
    maxMetric: samples.reduce((m, x) => Math.max(m, x.metric), 0),
    meanMetric: n > 0 ? sum / n : 0,
    lastMetric: last?.metric ?? 0,
    lastSigned: last?.signed ?? 0,
    signConsistency: signConsistencyOf(samples),
    direction: directionOf(samples, cfg.signConsistencyMin),
    converging: isConverging(samples, cfg.convergenceRatio),
  };
}

/** Classify an alerting episode into a verdict. Pure. */
export function classifyEpisode(
  input: EpisodeInput,
  cfg: Pick<SentinelConfig, 'signConsistencyMin' | 'convergenceRatio'>,
): Verdict {
  // Liveness first: a divergence against a dead/inactive book proves nothing
  // about the identity layer — the "disagreement" is just staleness.
  if (!input.legAActive || !input.legBActive) return 'liveness';

  const consistency = signConsistencyOf(input.samples);
  const converging = isConverging(input.samples, cfg.convergenceRatio);

  if (consistency >= cfg.signConsistencyMin && !converging) return 'suspect-identity';
  return 'segmentation-latency';
}
