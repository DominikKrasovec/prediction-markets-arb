// Main-thread handle for the dedicated I/O worker (WS keep-alive / solver-CPU
// isolation). IoHost mirrors ClobManager's public surface exactly, so entry
// points swap `new ClobManager()` → `new IoHost()` on one line; the host only
// spawns the worker, forwards commands, and re-dispatches its batched events.
// Gated by CLOB_IO_THREAD (default OFF).
import { Worker } from 'node:worker_threads';
import { createLogger } from '@arb/logger';
import type { PriceUpdate } from '../price-cache.js';
import type { MarketSubscription } from '../price-cache.js';
import type { ResolutionEvent } from '../adapters/base.js';
import type { InstrEvent } from '../geo-compare/instrumentation.js';
import type { NormalizedRestBook, RestBookRef } from '../rest-crosscheck.js';
import type { HostToWorker, WorkerToHost, OccupancyMsg } from './io-protocol.js';
import { OCCUPANCY_BUCKET_LABELS } from './io-protocol.js';

type CrosscheckDiagLine = { summary: string; samples: string[] } | null;

const log = createLogger('clob:io-host');

// null until the worker's first occupancy report.
export interface IoOccupancy {
  n: number;
  meanMs: number;
  maxMs: number;
  buckets: number[];
  framesPosted: number;
  batchesPosted: number;
}

export class IoHost {
  private readonly worker: Worker;
  private readonly callbacks: Array<(update: PriceUpdate) => void> = [];
  private readonly resolutionCallbacks: Array<(event: ResolutionEvent) => void> = [];
  private readonly instrCallbacks: Array<(e: InstrEvent) => void> = [];
  private readonly staleCallbacks: Array<(marketIds: number[]) => void> = [];

  private readonly pending = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();
  private nextCmdId = 1;

  // Distinct id space from command cmdId; info-only, never reject.
  private readonly crosscheckPending = new Map<number, (book: NormalizedRestBook | null) => void>();
  private readonly crosscheckDiagPending = new Map<number, (line: CrosscheckDiagLine) => void>();
  private nextReqId = 1;

  private readyPromise: Promise<void>;
  private terminated = false;
  private lastOccupancy: IoOccupancy | null = null;

  constructor() {
    // Worker threads do not inherit the parent's --import hooks, so under
    // tsx (import.meta.url ends .ts) spawn io-worker.ts with execArgv
    // ['--import','tsx']; under a compiled build spawn the sibling .js.
    const isTs = import.meta.url.endsWith('.ts');
    const workerUrl = new URL(isTs ? './io-worker.ts' : './io-worker.js', import.meta.url);
    const workerOpts: ConstructorParameters<typeof Worker>[1] = isTs
      ? { execArgv: ['--import', 'tsx'] }
      : {};

    let resolveReady!: () => void;
    let rejectReady!: (e: unknown) => void;
    this.readyPromise = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    this.worker = new Worker(workerUrl, workerOpts);
    this.worker.on('message', (msg: WorkerToHost) => {
      switch (msg.kind) {
        case 'ready':
          resolveReady();
          return;
        case 'priceBatch':
          for (const u of msg.updates) {
            for (const cb of this.callbacks) cb(u);
          }
          return;
        case 'stale':
          for (const cb of this.staleCallbacks) cb(msg.marketIds);
          return;
        case 'resolved':
          for (const cb of this.resolutionCallbacks) cb(msg.event);
          return;
        case 'ack': {
          const slot = this.pending.get(msg.cmdId);
          if (slot) {
            this.pending.delete(msg.cmdId);
            slot.resolve();
          }
          return;
        }
        case 'cmderr': {
          const slot = this.pending.get(msg.cmdId);
          if (slot) {
            this.pending.delete(msg.cmdId);
            slot.reject(new Error(msg.message));
          }
          return;
        }
        case 'occupancy':
          this.lastOccupancy = toOccupancy(msg);
          return;
        case 'crosscheckResult': {
          const resolve = this.crosscheckPending.get(msg.reqId);
          if (resolve) {
            this.crosscheckPending.delete(msg.reqId);
            resolve(msg.book);
          }
          return;
        }
        case 'crosscheckDiagResult': {
          const resolve = this.crosscheckDiagPending.get(msg.reqId);
          if (resolve) {
            this.crosscheckDiagPending.delete(msg.reqId);
            resolve(msg.line);
          }
          return;
        }
      }
    });

    this.worker.on('error', (err) => {
      log.error('I/O worker error (socket feeds are DOWN — solver will idle on sentinel prices):', err);
      rejectReady(err);
      this.failAllPending(err);
    });
    this.worker.on('exit', (code) => {
      if (!this.terminated && code !== 0) {
        const err = new Error(`I/O worker exited with code ${code} (socket feeds are DOWN)`);
        log.error(err.message);
        rejectReady(err);
        this.failAllPending(err);
      }
    });

    this.worker.postMessage({ kind: 'init' } satisfies HostToWorker);
  }

  onPriceUpdate(cb: (update: PriceUpdate) => void): void {
    this.callbacks.push(cb);
  }

  onMarketResolved(cb: (event: ResolutionEvent) => void): void {
    this.resolutionCallbacks.push(cb);
  }

  // Mirrored for surface-completeness; inert here since run-geo.ts (the only
  // instrumentation registrant) keeps its own in-process ClobManager.
  onInstrumentation(cb: (e: InstrEvent) => void): void {
    this.instrCallbacks.push(cb);
  }

  onConnectionStale(cb: (marketIds: number[]) => void): void {
    this.staleCallbacks.push(cb);
  }

  // Lets the entry point await worker readiness BEFORE startTracking.
  ready(): Promise<void> {
    return this.readyPromise;
  }

  async startTracking(markets: MarketSubscription[]): Promise<void> {
    await this.readyPromise;
    return this.sendCommand((cmdId) => ({ kind: 'startTracking', cmdId, markets }));
  }

  updateSubscriptions(newMarkets: MarketSubscription[]): Promise<void> {
    return this.sendCommand((cmdId) => ({ kind: 'updateSubscriptions', cmdId, markets: newMarkets }));
  }

  unsubscribeMarket(marketId: number): Promise<void> {
    return this.sendCommand((cmdId) => ({ kind: 'unsubscribeMarket', cmdId, marketId }));
  }

  // Stops every adapter in the worker, THEN terminates the worker.
  async stopAll(): Promise<void> {
    try {
      await this.sendCommand((cmdId) => ({ kind: 'stopAll', cmdId }));
    } catch (err) {
      // Worker may already be dead; fall through to terminate so shutdown can't hang.
      log.error('I/O worker stopAll did not ack cleanly (terminating anyway):', err);
    }
    this.terminated = true;
    await this.worker.terminate();
  }

  getOccupancy(): IoOccupancy | null {
    return this.lastOccupancy;
  }

  occupancyStr(): string {
    const o = this.lastOccupancy;
    if (!o || o.n === 0) return 'n=0';
    const h = o.buckets
      .map((c, i) => (c ? `${OCCUPANCY_BUCKET_LABELS[i]}:${c}` : ''))
      .filter(Boolean)
      .join(' ');
    return `mean=${o.meanMs.toFixed(3)} max=${o.maxMs.toFixed(1)}ms n=${o.n} ` +
      `frames=${o.framesPosted} batches=${o.batchesPosted} [${h}]`;
  }

  // Info-only: never rejects — on a dead/terminated worker it resolves null,
  // which the cross-check maps to 'rest-unavailable'.
  fetchRestBook(ref: RestBookRef): Promise<NormalizedRestBook | null> {
    if (this.terminated) return Promise.resolve(null);
    const reqId = this.nextReqId++;
    const p = new Promise<NormalizedRestBook | null>((resolve) => {
      this.crosscheckPending.set(reqId, resolve);
    });
    this.worker.postMessage({ kind: 'crosscheckFetch', reqId, platform: ref.platform, id: ref.id } satisfies HostToWorker);
    return p;
  }

  // Resolves null on a dead worker. `reset` clears per-interval counters worker-side.
  crosscheckDiag(reset: boolean): Promise<CrosscheckDiagLine> {
    if (this.terminated) return Promise.resolve(null);
    const reqId = this.nextReqId++;
    const p = new Promise<CrosscheckDiagLine>((resolve) => {
      this.crosscheckDiagPending.set(reqId, resolve);
    });
    this.worker.postMessage({ kind: 'crosscheckDiag', reqId, reset } satisfies HostToWorker);
    return p;
  }

  private sendCommand(make: (cmdId: number) => HostToWorker): Promise<void> {
    if (this.terminated) return Promise.reject(new Error('IoHost terminated'));
    const cmdId = this.nextCmdId++;
    const p = new Promise<void>((resolve, reject) => {
      this.pending.set(cmdId, { resolve, reject });
    });
    this.worker.postMessage(make(cmdId));
    return p;
  }

  private failAllPending(err: unknown): void {
    for (const [cmdId, slot] of this.pending) {
      this.pending.delete(cmdId);
      slot.reject(err);
    }
    // Cross-check requests must never reject; degrade to null instead.
    for (const [reqId, resolve] of this.crosscheckPending) {
      this.crosscheckPending.delete(reqId);
      resolve(null);
    }
    for (const [reqId, resolve] of this.crosscheckDiagPending) {
      this.crosscheckDiagPending.delete(reqId);
      resolve(null);
    }
  }
}

function toOccupancy(msg: OccupancyMsg): IoOccupancy {
  return {
    n: msg.n,
    meanMs: msg.n > 0 ? msg.sumMs / msg.n : 0,
    maxMs: msg.maxMs,
    buckets: msg.buckets,
    framesPosted: msg.framesPosted,
    batchesPosted: msg.batchesPosted,
  };
}
