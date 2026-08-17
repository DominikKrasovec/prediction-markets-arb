import type { Platform } from '@arb/types';
import {
  rejectCrossedBookEnabled,
  maxBookWidth,
  dustBand,
} from './token-map.js';

/** A real ask never reaches 1.5 in [0,1] price space; a frame with bid<=0 and ask>=this
 *  carries zero usable liquidity and is refused as a fresh live quote. */
export const PLACEHOLDER_ASK_FLOOR = 1.5;

export interface PriceSnapshot {
  marketId: number;
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  lastUpdate: number;
  staleSince: number | null;
  /** When the TOB fields actually last changed, distinct from lastUpdate (which
   *  advances on every frame). `0` until the first real quote. */
  lastTobChangeMs: number;
  /** Set only on the {@link PriceCache.read} copy when aged out; never persisted on the cached snapshot. */
  agedOut?: boolean;
  askLevels?: Array<[number, number]>;
  bidLevels?: Array<[number, number]>;
}

function ladderLevelChanged(
  a: ReadonlyArray<readonly [number, number]> | undefined,
  b: ReadonlyArray<readonly [number, number]> | undefined,
  i: number,
): boolean {
  const la = a?.[i];
  const lb = b?.[i];
  if (la === undefined && lb === undefined) return false;
  if (la === undefined || lb === undefined) return true;
  return la[0] !== lb[0] || la[1] !== lb[1];
}

/**
 * In-memory price cache keyed by market ID; all markets start at the ask=$2/bid=$0
 * sentinel. Updates tagged `outcome:'no'` route to a separate per-market slot
 * ({@link getNo}) and never clobber the primary (YES) snapshot ({@link get}).
 */
export class PriceCache {
  private cache = new Map<number, PriceSnapshot>();
  /** Absence means lp-builder falls back to the synthetic 1 - bestBid(YES). */
  private noCache = new Map<number, PriceSnapshot>();

  private ttlMs = Infinity;
  private tobTtlMs = Infinity;

  setTtl(ms: number): void {
    this.ttlMs = Number.isFinite(ms) && ms > 0 ? ms : Infinity;
  }

  setTobTtl(ms: number): void {
    this.tobTtlMs = Number.isFinite(ms) && ms > 0 ? ms : Infinity;
  }

  track(marketId: number): void {
    if (!this.cache.has(marketId)) {
      this.cache.set(marketId, {
        marketId,
        bestBid: 0,
        bestAsk: 2.0,
        bidSize: 0,
        askSize: 0,
        lastUpdate: 0,
        lastTobChangeMs: 0,
        staleSince: null,
      });
    }
  }

  /** @returns true iff any top-of-book field differs from the previously cached
   *  snapshot, or the market was previously unseen/sentinel — callers re-solve only then. */
  update(update: PriceUpdate): boolean {
    const book = update.outcome === 'no' ? this.noCache : this.cache;
    const prev = book.get(update.marketId);

    if (update.bestBid <= 0 && update.bestAsk >= PLACEHOLDER_ASK_FLOOR) {
      const wasLiveBook =
        prev !== undefined &&
        prev.lastUpdate > 0 &&
        prev.staleSince === null &&
        !(prev.bestBid <= 0 && prev.bestAsk >= PLACEHOLDER_ASK_FLOOR);
      book.set(update.marketId, {
        marketId: update.marketId,
        bestBid: 0,
        bestAsk: 2.0,
        bidSize: 0,
        askSize: 0,
        lastUpdate: wasLiveBook ? prev.lastUpdate : 0,
        lastTobChangeMs: 0,
        staleSince: wasLiveBook ? update.timestamp : null,
        askLevels: undefined,
        bidLevels: undefined,
      });
      return wasLiveBook;
    }

    const wasSentinel = prev === undefined || prev.lastUpdate === 0;
    // Distinct from topOfBookChanged below, which must not refresh the TOB-age clock.
    const tobFieldsChanged =
      wasSentinel ||
      prev.bestBid !== update.bestBid ||
      prev.bestAsk !== update.bestAsk ||
      prev.bidSize !== update.bidSize ||
      prev.askSize !== update.askSize;
    const topOfBookChanged =
      tobFieldsChanged ||
      ladderLevelChanged(prev.askLevels, update.askLevels, 1) ||
      ladderLevelChanged(prev.bidLevels, update.bidLevels, 1);

    book.set(update.marketId, {
      marketId: update.marketId,
      bestBid: update.bestBid,
      bestAsk: update.bestAsk,
      bidSize: update.bidSize,
      askSize: update.askSize,
      lastUpdate: update.timestamp,
      // prev is defined whenever wasSentinel is false, so `!` is safe.
      lastTobChangeMs: tobFieldsChanged ? update.timestamp : prev!.lastTobChangeMs,
      staleSince: null,
      askLevels: update.askLevels,
      bidLevels: update.bidLevels,
    });

    return topOfBookChanged;
  }

  /** Caller is responsible for scoping to markets on the given platform. */
  markStale(platform: Platform): void {
    const now = Date.now();
    for (const book of [this.cache, this.noCache]) {
      for (const snap of book.values()) {
        snap.staleSince = now;
        snap.bestAsk = 2.0;
        snap.bestBid = 0;
      }
    }
  }

  markStaleByIds(marketIds: number[]): void {
    const now = Date.now();
    for (const mid of marketIds) {
      for (const book of [this.cache, this.noCache]) {
        const snap = book.get(mid);
        if (snap) {
          snap.staleSince = now;
          snap.bestAsk = 2.0;
          snap.bestBid = 0;
        }
      }
    }
  }

  get(marketId: number, now: number = Date.now()): PriceSnapshot | undefined {
    return this.read(this.cache, marketId, now);
  }

  /** `undefined` when no NO book was ever received — lp-builder then uses the synthetic fallback. */
  getNo(marketId: number, now: number = Date.now()): PriceSnapshot | undefined {
    return this.read(this.noCache, marketId, now);
  }

  private read(
    book: Map<number, PriceSnapshot>,
    marketId: number,
    now: number,
  ): PriceSnapshot | undefined {
    const snap = book.get(marketId);
    if (!snap) return undefined;
    const agedOut =
      this.ttlMs !== Infinity && snap.lastUpdate > 0 && now - snap.lastUpdate > this.ttlMs;
    // Guarded on lastTobChangeMs>0 to skip the first-quote window.
    const tobAgedOut =
      this.tobTtlMs !== Infinity &&
      snap.lastUpdate > 0 &&
      snap.lastTobChangeMs > 0 &&
      now - snap.lastTobChangeMs > this.tobTtlMs;
    if (snap.staleSince !== null || agedOut || tobAgedOut) {
      // Blank the depth ladders too so lp-builder can't tranche a stale book.
      return {
        ...snap,
        bestAsk: 2.0,
        bestBid: 0,
        askLevels: undefined,
        bidLevels: undefined,
        agedOut: agedOut || tobAgedOut,
      };
    }
    return snap;
  }

  evict(marketIds: Set<number>): void {
    for (const book of [this.cache, this.noCache]) {
      for (const mid of book.keys()) {
        if (!marketIds.has(mid)) {
          book.delete(mid);
        }
      }
    }
  }

  /** Primary (YES) books only — persistence writes one row per market_id. */
  getLiveSnapshots(): PriceSnapshot[] {
    return [...this.cache.values()].filter(
      s => s.staleSince === null && s.lastUpdate > 0
    );
  }

  get size(): number {
    return this.cache.size;
  }
}

/** Single source of truth for "is this a sentinel, never a tradeable quote". */
export function isDeadSnapshot(snap: PriceSnapshot | undefined): snap is undefined {
  if (!snap) return true;
  if (snap.lastUpdate === 0) return true;
  if (snap.staleSince !== null) return true;
  if (snap.agedOut === true) return true;
  if (
    snap.bestBid > 0 &&
    snap.bestAsk < 2.0 &&
    snap.bestBid <= dustBand() &&
    snap.bestAsk >= 1 - dustBand()
  ) {
    return true;
  }
  return false;
}

export interface SideUsability {
  yes: boolean;
  no: boolean;
  /** True iff NO is priced from a real independent NO-token book, not synthetic. */
  noFromBook: boolean;
}

function realNoBookUsable(snap: PriceSnapshot | undefined): snap is PriceSnapshot {
  return (
    snap !== undefined &&
    snap.staleSince === null &&
    snap.lastUpdate > 0 &&
    snap.bestAsk > 0 &&
    snap.bestAsk <= 1.0 &&
    snap.askSize > 0
  );
}

/** The one place that decides which (market, side) securities exist; refuses to emit
 *  a side backed only by a sentinel field (never the fabricated 1 - 0 = 1.00 price). */
export function sideUsability(
  yesSnap: PriceSnapshot | undefined,
  noSnap: PriceSnapshot | undefined,
): SideUsability {
  const yesDead = isDeadSnapshot(yesSnap);
  const noFromBook = realNoBookUsable(noSnap);

  const yesBothReal = yesSnap !== undefined && yesSnap.bestBid > 0 && yesSnap.bestAsk < 2.0;
  const yesCrossed = rejectCrossedBookEnabled() && yesBothReal && yesSnap!.bestBid >= yesSnap!.bestAsk;
  const yesWide = yesBothReal && yesSnap!.bestAsk - yesSnap!.bestBid > maxBookWidth();
  const yesDust = yesBothReal && yesSnap!.bestBid <= dustBand() && yesSnap!.bestAsk >= 1 - dustBand();
  const suppressSyntheticNo = (yesCrossed || yesWide || yesDust) && !noFromBook;

  const yes =
    !yesDead &&
    !yesDust &&
    yesSnap!.bestAsk > 0 &&
    yesSnap!.bestAsk <= 1.0 &&
    yesSnap!.askSize > 0;

  const syntheticNoUsable =
    !yesDead && yesSnap!.bestBid > 0 && yesSnap!.bidSize > 0 && !suppressSyntheticNo;
  const no = noFromBook || syntheticNoUsable;

  return { yes, no, noFromBook };
}

export interface PriceUpdate {
  marketId: number;
  platform: Platform;
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  timestamp: number;
  wireTs?: number;
  wireHr?: number;
  emitHr?: number;
  serverTs?: number;
  msgKind?: 'snapshot' | 'delta' | 'full' | 'unknown';
  /** Adapters with one merged book (Kalshi/Predict) leave this undefined or set 'yes'. */
  outcome?: 'yes' | 'no';
  /** Ascending by price, capped to CLOB_MAX_LADDER_LEVELS. */
  askLevels?: Array<[number, number]>;
  /** Descending by price, used to synthesize NO tranches. */
  bidLevels?: Array<[number, number]>;
}

export interface MarketSubscription {
  marketId: number;
  platformId: string;
  platform: Platform;
  outcome?: 'yes' | 'no';
}
