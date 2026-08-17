/**
 * Wire protocol shared by io-host.ts and io-worker.ts. Types only — no runtime
 * imports, so importing this on the main thread can never pull a CLOB adapter
 * into the solver process. Prices/stale/resolution ride a single FIFO
 * MessagePort in worker→host order; a `stale` must never overtake an
 * in-flight price for the same market. Commands (host→worker) run through a
 * single-flight queue keyed by `cmdId`, acked with `{kind:'ack', cmdId}` / `'cmderr'`.
 */

import type { PriceUpdate, MarketSubscription } from '../price-cache.js';
import type { ResolutionEvent } from '../adapters/base.js';
import type { Platform } from '@arb/types';
import type { NormalizedRestBook } from '../rest-crosscheck.js';

/** No-op handshake sent once, first, to prime the command FIFO ordering. */
export interface InitCmd {
  kind: 'init';
}

export interface StartTrackingCmd {
  kind: 'startTracking';
  cmdId: number;
  markets: MarketSubscription[];
}

export interface UpdateSubscriptionsCmd {
  kind: 'updateSubscriptions';
  cmdId: number;
  markets: MarketSubscription[];
}

export interface UnsubscribeMarketCmd {
  kind: 'unsubscribeMarket';
  cmdId: number;
  marketId: number;
}

export interface StopAllCmd {
  kind: 'stopAll';
  cmdId: number;
}

/** REST cross-check fetch; side-band request/response that does NOT ride the single-flight command queue, so it never blocks behind a subscription mutation. */
export interface CrosscheckFetchCmd {
  kind: 'crosscheckFetch';
  reqId: number;
  platform: Platform;
  id: string;
}

export interface CrosscheckDiagCmd {
  kind: 'crosscheckDiag';
  reqId: number;
  reset: boolean;
}

export type HostToWorker =
  | InitCmd
  | StartTrackingCmd
  | UpdateSubscriptionsCmd
  | UnsubscribeMarketCmd
  | StopAllCmd
  | CrosscheckFetchCmd
  | CrosscheckDiagCmd;

export interface ReadyMsg {
  kind: 'ready';
}

/** Coalesced PriceUpdate batch; the host loops it through the single-update `onPriceUpdate` callback one element at a time. */
export interface PriceBatchMsg {
  kind: 'priceBatch';
  updates: PriceUpdate[];
}

/** Rides the same FIFO as prices so a stale can never be overtaken by an in-flight price for the same market. */
export interface StaleMsg {
  kind: 'stale';
  marketIds: number[];
}

/** The host owns DB write-authority + cache eviction; the worker only forwards the raw event. */
export interface ResolvedMsg {
  kind: 'resolved';
  event: ResolutionEvent;
}

export interface AckMsg {
  kind: 'ack';
  cmdId: number;
}

export interface CmdErrMsg {
  kind: 'cmderr';
  cmdId: number;
  message: string;
}

/** Per-frame I/O-thread occupancy stat: synchronous handler wall-clock time, to prove the I/O thread never blocks on non-I/O work under solver CPU load. */
export interface OccupancyMsg {
  kind: 'occupancy';
  n: number;
  sumMs: number;
  maxMs: number;
  buckets: number[];
  framesPosted: number;
  batchesPosted: number;
}

export interface CrosscheckResultMsg {
  kind: 'crosscheckResult';
  reqId: number;
  book: NormalizedRestBook | null;
}

export interface CrosscheckDiagResultMsg {
  kind: 'crosscheckDiagResult';
  reqId: number;
  line: { summary: string; samples: string[] } | null;
}

export type WorkerToHost =
  | ReadyMsg
  | PriceBatchMsg
  | StaleMsg
  | ResolvedMsg
  | AckMsg
  | CmdErrMsg
  | OccupancyMsg
  | CrosscheckResultMsg
  | CrosscheckDiagResultMsg;

/** Batch flush interval (ms); ~6ms keeps clone-count low at the ~8k msg/s firehose without adding latency the reconnect-coverage gap doesn't already dwarf. */
export const IO_BATCH_MS = 6;

export const IO_BATCH_MAX = 4096;

export const IO_OCCUPANCY_REPORT_MS = 10_000;

export const OCCUPANCY_BUCKET_EDGES = [0.1, 0.5, 1, 5, 20, 100] as const;
export const OCCUPANCY_BUCKET_LABELS = [
  '<0.1', '0.1-0.5', '0.5-1', '1-5', '5-20', '20-100', '>100',
] as const;
