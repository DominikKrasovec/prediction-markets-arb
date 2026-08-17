/**
 * Divergence detector — event-driven state machine per watch pair, fed by
 * price ticks. NO wall clock anywhere: event time comes from the tick's
 * `timestamp`; periodic evaluation (`sweep`) takes an explicit `now`.
 *
 * Per-pair state machine:
 *
 *            metric > threshold                window elapsed (+ activity gate)
 *   ┌──────┐ ─────────────────► ┌─────────┐ ─────────────────► ┌─────────┐
 *   │ IDLE │                    │ PENDING │                    │ ALERTED │
 *   └──────┘ ◄───────────────── └─────────┘                    └─────────┘
 *      ▲       metric ≤ threshold (episode closed — converged)      │
 *      └─────────────────────────────────────────────────────────────┘
 *                metric < threshold × clearRatio  (hysteresis re-arm)
 *
 *   PENDING window = persistenceWindowMs, or fastWindowMs when the episode is
 *   on the post-volume-spike fast path (exactly one leg spiked — info arrived,
 *   one leg moved, the other didn't follow). ALERTED fires exactly one
 *   ReviewItem; no re-alert until the metric clears below threshold×clearRatio.
 */

import {
  classifyEpisode,
  summarizeEpisode,
  type EpisodeSample,
} from './classifier.js';
import {
  DEFAULT_SENTINEL_CONFIG,
  type LegStatus,
  type PairStatus,
  type ReviewItem,
  type SentinelConfig,
  type SentinelTick,
  type WatchPair,
} from './types.js';

// Bounded ring caps (per MARKET, shared across pairs watching it).
const UPDATE_RING_CAP = 64;
const MID_RING_CAP = 64;

/** Shared per-market price/activity state (one per market, many pairs). */
interface LegState {
  marketId: number;
  bestBid: number | null;
  bestAsk: number | null;
  lastUpdateAt: number | null;
  /** Set by markStale (disconnect/resolution); cleared by the next tick. */
  staleFlagged: boolean;
  /** Recent update timestamps (activity gate + spike update count). */
  updateTimes: number[];
  /** Decimated mid history (spike detection). */
  midHistory: Array<{ t: number; mid: number }>;
}

function newLeg(marketId: number): LegState {
  return {
    marketId,
    bestBid: null,
    bestAsk: null,
    lastUpdateAt: null,
    staleFlagged: false,
    updateTimes: [],
    midHistory: [],
  };
}

/** A quote is usable when it's a real $0..1 book (the price-cache "unpriced"
 *  sentinel is ask=$2) and the leg isn't flagged stale. */
function quoteValid(leg: LegState): boolean {
  return (
    !leg.staleFlagged &&
    leg.lastUpdateAt !== null &&
    leg.bestBid !== null &&
    leg.bestAsk !== null &&
    leg.bestBid >= 0 &&
    leg.bestBid <= 1 &&
    leg.bestAsk >= 0 &&
    leg.bestAsk <= 1
  );
}

function midOf(leg: LegState): number | null {
  if (!quoteValid(leg)) return null;
  return (leg.bestBid! + leg.bestAsk!) / 2;
}

function countUpdatesSince(leg: LegState, cutoff: number): number {
  let n = 0;
  for (let i = leg.updateTimes.length - 1; i >= 0; i--) {
    if (leg.updateTimes[i]! >= cutoff) n++;
    else break; // timestamps are appended in order
  }
  return n;
}

/** Activity gate: live quote + enough recent updates (book-update count is the
 *  volume proxy — the WSS feed exposes updates, not trades). */
function legActive(leg: LegState, now: number, cfg: SentinelConfig): boolean {
  return (
    quoteValid(leg) &&
    countUpdatesSince(leg, now - cfg.activityWindowMs) >= cfg.minUpdatesInActivityWindow
  );
}

/** Did this leg's mid move ≥ spikeMoveMin within the burst window, with enough
 *  updates to look like an information event (not one stray quote)? */
function recentSpike(leg: LegState, now: number, cfg: SentinelConfig): boolean {
  const mid = midOf(leg);
  if (mid === null) return false;
  if (countUpdatesSince(leg, now - cfg.spikeBurstMs) < cfg.spikeMinUpdates) return false;
  for (const h of leg.midHistory) {
    if (now - h.t <= cfg.spikeBurstMs && Math.abs(mid - h.mid) >= cfg.spikeMoveMin) {
      return true;
    }
  }
  return false;
}

interface SpreadObs {
  /** Breach metric, ≥ 0. */
  metric: number;
  /** Signed spread mid_a − mid_b (equal mode); = metric for mutex mode. */
  signed: number;
}

/** Compute the pair's divergence observation, or null when unmeasurable. */
function pairSpread(
  pair: WatchPair,
  legA: LegState,
  legB: LegState,
  cfg: SentinelConfig,
): SpreadObs | null {
  const midA = midOf(legA);
  const midB = midOf(legB);
  if (midA === null || midB === null) return null;

  if (pair.mode === 'mutex') {
    // Mutual exclusion: pYES_a + pYES_b must stay ≤ 1 + fee allowance.
    const metric = Math.max(0, midA + midB - (1 + cfg.mutexFeeAllowance));
    return { metric, signed: metric };
  }

  const signed = midA - midB;
  const metric = cfg.useCrossablePrices
    ? // Execution-aware: only monetizable disagreement counts (sell A at its
      // bid vs buy B at its ask, both ways). Immune to wide-book mid noise.
      Math.max(0, legA.bestBid! - legB.bestAsk!, legB.bestBid! - legA.bestAsk!)
    : Math.abs(signed);
  return { metric, signed };
}

interface Episode {
  startedAt: number;
  fastPath: boolean;
  spikeLeg: 'a' | 'b' | null;
  samples: EpisodeSample[];
  /** Current decimation gap; doubles when the sample buffer is thinned. */
  sampleGapMs: number;
  lastSampleAt: number;
  /** A leg's quote went invalid (stale/disconnect) during the episode. */
  sawStaleLeg: boolean;
}

class PairMonitor {
  state: 'idle' | 'pending' | 'alerted' = 'idle';
  episode: Episode | null = null;
  alertCount = 0;
  firstAlertAt: number | null = null;
  lastItem: ReviewItem | null = null;

  constructor(
    readonly pair: WatchPair,
    private readonly cfg: SentinelConfig,
    private readonly legA: LegState,
    private readonly legB: LegState,
  ) {}

  private threshold(): number {
    return this.pair.mode === 'mutex' ? this.cfg.mutexThreshold : this.cfg.spreadThreshold;
  }

  private windowMs(): number {
    return this.episode?.fastPath ? this.cfg.fastWindowMs : this.cfg.persistenceWindowMs;
  }

  /** Evaluate at event time `now`. Returns a ReviewItem when an alert fires. */
  evaluate(now: number): ReviewItem | null {
    const sp = pairSpread(this.pair, this.legA, this.legB, this.cfg);

    if (sp === null) {
      // Unmeasurable (a leg has no live quote). An OPEN divergence episode
      // still ages toward its window — losing one book mid-divergence is the
      // classic liveness case and must be surfaced, not silently dropped.
      if (this.state === 'pending' && this.episode) {
        this.episode.sawStaleLeg = true;
        if (now - this.episode.startedAt >= this.windowMs()) return this.fire(now);
      }
      return null;
    }

    const breached = sp.metric > this.threshold();

    switch (this.state) {
      case 'idle': {
        if (breached) this.openEpisode(now, sp);
        return null;
      }
      case 'pending': {
        this.recordSample(now, sp);
        if (!breached) {
          // Converged before the persistence window — healthy market
          // behavior (truly equivalent legs converge). No alert.
          this.closeEpisode();
          return null;
        }
        this.updateFastPath(now);
        if (now - this.episode!.startedAt >= this.windowMs()) return this.fire(now);
        return null;
      }
      case 'alerted': {
        this.recordSample(now, sp);
        // Hysteresis: re-arm only after a DEEP clear (threshold × clearRatio),
        // so a pair hovering at the threshold cannot re-alert continuously.
        if (sp.metric < this.threshold() * this.cfg.clearRatio) this.closeEpisode();
        return null;
      }
    }
  }

  private openEpisode(now: number, sp: SpreadObs): void {
    const spikeA = recentSpike(this.legA, now, this.cfg);
    const spikeB = recentSpike(this.legB, now, this.cfg);
    // Post-volume-spike fast path: exactly ONE leg moved (info arrived, the
    // other leg didn't follow). Both spiking = joint repricing, normal window.
    const fastPath = spikeA !== spikeB;
    this.episode = {
      startedAt: now,
      fastPath,
      spikeLeg: fastPath ? (spikeA ? 'a' : 'b') : null,
      samples: [],
      sampleGapMs: this.cfg.minSampleGapMs,
      lastSampleAt: -Infinity,
      sawStaleLeg: false,
    };
    this.state = 'pending';
    this.recordSample(now, sp);
  }

  private closeEpisode(): void {
    this.episode = null;
    this.state = 'idle';
  }

  /**
   * Re-check the post-spike premise while pending. Upgrades when exactly one
   * leg shows a fresh spike; DOWNGRADES when both legs show spikes — that's a
   * joint repricing (e.g. one feed ran a second ahead at episode open, the
   * other leg's jump only became visible on its next tick), not a
   * one-leg-didn't-follow event. Once spike evidence ages out of the burst
   * window (both checks false), the current flag is kept.
   */
  private updateFastPath(now: number): void {
    const ep = this.episode!;
    const spikeA = recentSpike(this.legA, now, this.cfg);
    const spikeB = recentSpike(this.legB, now, this.cfg);
    if (spikeA && spikeB) {
      ep.fastPath = false;
      ep.spikeLeg = null;
    } else if (spikeA !== spikeB) {
      ep.fastPath = true;
      ep.spikeLeg = spikeA ? 'a' : 'b';
    }
  }

  private recordSample(now: number, sp: SpreadObs): void {
    const ep = this.episode!;
    if (ep.samples.length > 0 && now - ep.lastSampleAt < ep.sampleGapMs) return;
    ep.samples.push({ t: now, metric: sp.metric, signed: sp.signed });
    ep.lastSampleAt = now;
    // Bounded memory under fast feeds: thin to every-other sample and double
    // the gap — keeps full-episode shape for the convergence test.
    if (ep.samples.length >= this.cfg.maxEpisodeSamples) {
      ep.samples = ep.samples.filter((_, i) => i % 2 === 0);
      ep.sampleGapMs *= 2;
    }
  }

  private legStatus(side: 'a' | 'b', now: number): LegStatus {
    const ref = side === 'a' ? this.pair.legA : this.pair.legB;
    const leg = side === 'a' ? this.legA : this.legB;
    return {
      ...ref,
      lastBid: leg.bestBid,
      lastAsk: leg.bestAsk,
      lastUpdateAt: leg.lastUpdateAt,
      active: legActive(leg, now, this.cfg),
    };
  }

  private fire(now: number): ReviewItem {
    const ep = this.episode!;
    const legA = this.legStatus('a', now);
    const legB = this.legStatus('b', now);
    const verdict = classifyEpisode(
      { samples: ep.samples, legAActive: legA.active, legBActive: legB.active },
      this.cfg,
    );
    this.alertCount++;
    if (this.firstAlertAt === null) this.firstAlertAt = now;
    const item: ReviewItem = {
      pairId: this.pair.pairId,
      kind: this.pair.kind,
      mode: this.pair.mode,
      verdict,
      postSpike: ep.fastPath,
      spikeLeg: ep.spikeLeg,
      ...(this.pair.edgeId !== undefined ? { edgeId: this.pair.edgeId } : {}),
      ...(this.pair.edgeType !== undefined ? { edgeType: this.pair.edgeType } : {}),
      questionIds: [this.pair.legA.questionId, this.pair.legB.questionId],
      legA,
      legB,
      spread: summarizeEpisode(ep.samples, this.cfg),
      episodeStartedAt: ep.startedAt,
      alertedAt: now,
      firstAlertAt: this.firstAlertAt,
      alertCount: this.alertCount,
    };
    this.lastItem = item;
    this.state = 'alerted';
    return item;
  }

  status(): PairStatus {
    return {
      pairId: this.pair.pairId,
      kind: this.pair.kind,
      state: this.state,
      lastItem: this.lastItem,
      alertCount: this.alertCount,
    };
  }
}

export class DivergenceDetector {
  private readonly cfg: SentinelConfig;
  private readonly legs = new Map<number, LegState>();
  private readonly monitors: PairMonitor[] = [];
  private readonly byMarket = new Map<number, PairMonitor[]>();
  /** Decimation gap for the mid-history ring, derived so the ring's coverage
   *  always spans the spike burst window. */
  private readonly midGapMs: number;

  constructor(pairs: WatchPair[], cfg: Partial<SentinelConfig> = {}) {
    this.cfg = { ...DEFAULT_SENTINEL_CONFIG, ...cfg };
    this.midGapMs = Math.max(
      this.cfg.minSampleGapMs,
      Math.ceil((this.cfg.spikeBurstMs * 2) / MID_RING_CAP),
    );
    for (const pair of pairs) {
      const monitor = new PairMonitor(
        pair,
        this.cfg,
        this.leg(pair.legA.marketId),
        this.leg(pair.legB.marketId),
      );
      this.monitors.push(monitor);
      for (const marketId of [pair.legA.marketId, pair.legB.marketId]) {
        const list = this.byMarket.get(marketId);
        if (list) list.push(monitor);
        else this.byMarket.set(marketId, [monitor]);
      }
    }
  }

  private leg(marketId: number): LegState {
    let leg = this.legs.get(marketId);
    if (!leg) {
      leg = newLeg(marketId);
      this.legs.set(marketId, leg);
    }
    return leg;
  }

  /** Feed one price tick. Event time = tick.timestamp. Returns fired alerts. */
  onTick(tick: SentinelTick): ReviewItem[] {
    const leg = this.legs.get(tick.marketId);
    if (!leg) return []; // not a watched market

    // Reject non-book ticks (the price-cache "unpriced" sentinel is ask=$2;
    // anything outside $0..1 is not a usable quote, and counting it as
    // activity would defeat the staleness gate).
    if (tick.bestBid < 0 || tick.bestBid > 1 || tick.bestAsk < 0 || tick.bestAsk > 1) {
      return [];
    }

    leg.bestBid = tick.bestBid;
    leg.bestAsk = tick.bestAsk;
    leg.lastUpdateAt = tick.timestamp;
    leg.staleFlagged = false;

    leg.updateTimes.push(tick.timestamp);
    if (leg.updateTimes.length > UPDATE_RING_CAP) {
      leg.updateTimes.splice(0, leg.updateTimes.length - UPDATE_RING_CAP);
    }

    const mid = (tick.bestBid + tick.bestAsk) / 2;
    const lastMid = leg.midHistory[leg.midHistory.length - 1];
    if (!lastMid || tick.timestamp - lastMid.t >= this.midGapMs) {
      leg.midHistory.push({ t: tick.timestamp, mid });
      if (leg.midHistory.length > MID_RING_CAP) {
        leg.midHistory.splice(0, leg.midHistory.length - MID_RING_CAP);
      }
    }

    const out: ReviewItem[] = [];
    for (const monitor of this.byMarket.get(tick.marketId) ?? []) {
      const item = monitor.evaluate(tick.timestamp);
      if (item) out.push(item);
    }
    return out;
  }

  /** Flag markets stale (WS disconnect / resolution). Cleared by next tick. */
  markStale(marketIds: number[], _now: number): void {
    for (const marketId of marketIds) {
      const leg = this.legs.get(marketId);
      if (leg) leg.staleFlagged = true;
    }
  }

  /**
   * Periodic evaluation at explicit time `now`: persistence windows can elapse
   * (and stale-leg liveness alerts fire) without any fresh tick on the pair.
   * Only non-idle monitors are touched — idle pairs can't transition without a
   * price change.
   */
  sweep(now: number): ReviewItem[] {
    const out: ReviewItem[] = [];
    for (const monitor of this.monitors) {
      if (monitor.state === 'idle') continue;
      const item = monitor.evaluate(now);
      if (item) out.push(item);
    }
    return out;
  }

  statuses(): PairStatus[] {
    return this.monitors.map(m => m.status());
  }

  get pairCount(): number {
    return this.monitors.length;
  }
}
