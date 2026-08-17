/**
 * Dedicated I/O worker — real logic. Loaded by the thin bootstrap
 * `io-worker.ts` via a dynamic import after it installs the tsx ESM hook
 * (under tsx) — see io-worker.ts for why the split is mandatory. Under a
 * compiled build the bootstrap dynamic-imports the sibling `.js` of this
 * file with the hook a no-op. Because the bootstrap has already registered
 * tsx (or we're running compiled `.js`), this module can use normal static
 * `.js` value imports below — they resolve correctly in-worker.
 *
 * This worker_thread constructs the real `ClobManager` (four adapters: raw
 * `ws` for PM/Kalshi/Predict, `socket.io-client` for Limitless) unchanged and
 * owns everything on the socket's loop: book reconstruction, the per-shard
 * keepalive, integrity/seq/hash checks, the async REST-resync, the two-sided
 * token-map `@arb/db` load, and the platformId→marketId reverse map. It
 * forwards the manager's public events (price updates / resolution /
 * connection-stale) to the parent over a single FIFO MessagePort, and applies
 * subscription-mutating commands the parent posts back. The parent
 * (io-host.ts) mirrors the `ClobManager` surface so callers change one line
 * each.
 *
 * Default-OFF (`CLOB_IO_THREAD` unset): neither this file nor io-host.ts is
 * loaded — the entry points keep the in-process `new ClobManager()`,
 * byte-identical without the split. The split exists only to A/B-profile the
 * two architectures.
 *
 * `dotenv/config` is imported by the bootstrap before this module loads, so
 * the in-worker ClobManager's own pg pool for the two-sided token-map load
 * resolves the right Postgres port.
 */
import { parentPort } from 'node:worker_threads';
import { ClobManager } from '../manager.js';
import type { ClobManager as ClobManagerType } from '../manager.js';
import type { PriceUpdate } from '../price-cache.js';
import type { ResolutionEvent } from '../adapters/base.js';
import { fetchRestBook, restCrosscheckDiagLine } from '../rest-crosscheck.js';
import type { NormalizedRestBook } from '../rest-crosscheck.js';
import type { CrosscheckFetchCmd, CrosscheckDiagCmd } from './io-protocol.js';
import type { HostToWorker, WorkerToHost, PriceBatchMsg } from './io-protocol.js';
import {
  IO_BATCH_MS,
  IO_BATCH_MAX,
  IO_OCCUPANCY_REPORT_MS,
  OCCUPANCY_BUCKET_EDGES,
} from './io-protocol.js';

if (!parentPort) {
  throw new Error('io-worker must be run as a worker_thread (no parentPort)');
}
const port = parentPort;

// ── occupancy instrumentation (the success metric) ───────────────────────────
// Every synchronous handler that runs on THIS thread in response to a socket
// frame / disconnect / resolution is timed; the distribution proves the I/O
// thread never blocks on non-I/O work for >Xms even while the solver saturates
// the other cores. Reset each report window.
const occBuckets = new Array(OCCUPANCY_BUCKET_EDGES.length + 1).fill(0) as number[];
let occN = 0;
let occSumMs = 0;
let occMaxMs = 0;
let framesPostedWindow = 0;
let batchesPostedWindow = 0;
function recordOccupancy(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  occN++;
  occSumMs += ms;
  if (ms > occMaxMs) occMaxMs = ms;
  let i = 0;
  while (i < OCCUPANCY_BUCKET_EDGES.length && ms >= OCCUPANCY_BUCKET_EDGES[i]) i++;
  occBuckets[i]++;
}

// ── price batching (single FIFO, coalesced; stale/resolved flush in-line) ─────
// A pending batch accumulates PriceUpdates in arrival order. It is flushed on the
// IO_BATCH_MS timer, OR immediately (BEFORE) a stale/resolved is posted so the
// global FIFO order across price/stale/resolved is preserved — a stale must never
// be overtaken by an in-flight price for the same market.
let pending: PriceUpdate[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function flushBatch(): void {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  if (pending.length === 0) return;
  const msg: PriceBatchMsg = { kind: 'priceBatch', updates: pending };
  framesPostedWindow += pending.length;
  batchesPostedWindow++;
  pending = [];
  port.postMessage(msg);
}

function scheduleFlush(): void {
  if (batchTimer) return;
  batchTimer = setTimeout(flushBatch, IO_BATCH_MS);
}

function postNow(msg: WorkerToHost): void {
  port.postMessage(msg);
}

// ── construct the REAL manager UNCHANGED, forward its events ──────────────────
const manager: ClobManagerType = new ClobManager();

manager.onPriceUpdate((update: PriceUpdate) => {
  const t0 = performance.now();
  pending.push(update);
  if (pending.length >= IO_BATCH_MAX) flushBatch();
  else scheduleFlush();
  recordOccupancy(performance.now() - t0);
});

manager.onConnectionStale((marketIds: number[]) => {
  const t0 = performance.now();
  // Preserve global FIFO order: flush any in-flight price batch FIRST so a stale
  // can't be overtaken by a price for the same market.
  flushBatch();
  postNow({ kind: 'stale', marketIds });
  recordOccupancy(performance.now() - t0);
});

manager.onMarketResolved((event: ResolutionEvent) => {
  const t0 = performance.now();
  flushBatch();
  postNow({ kind: 'resolved', event });
  recordOccupancy(performance.now() - t0);
});

// ── single-flight command queue ───────────────────────────────────────────────
// All subscription-mutating commands (startTracking / updateSubscriptions /
// unsubscribeMarket / stopAll) are async and their interleaving matters (a
// resolved-market unsubscribe must not race a graph-reload re-subscribe). Apply
// them strictly in receipt order with one `await` between dequeues, so two
// mutations can never overlap. Each resolves with an ack (or cmderr) the host
// uses to settle the Promise its mirrored method returned.
const cmdQueue: HostToWorker[] = [];
let draining = false;

async function applyCommand(cmd: HostToWorker): Promise<void> {
  switch (cmd.kind) {
    case 'init':
      // The manager is constructed at module load; init is a no-op handshake.
      return;
    case 'startTracking':
      await manager.startTracking(cmd.markets);
      postNow({ kind: 'ack', cmdId: cmd.cmdId });
      return;
    case 'updateSubscriptions':
      await manager.updateSubscriptions(cmd.markets);
      postNow({ kind: 'ack', cmdId: cmd.cmdId });
      return;
    case 'unsubscribeMarket':
      await manager.unsubscribeMarket(cmd.marketId);
      postNow({ kind: 'ack', cmdId: cmd.cmdId });
      return;
    case 'stopAll':
      await manager.stopAll();
      // Flush any final batch, then ack — the host terminates the worker after.
      flushBatch();
      postNow({ kind: 'ack', cmdId: cmd.cmdId });
      return;
  }
}

async function drainCommands(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (cmdQueue.length > 0) {
      const cmd = cmdQueue.shift()!;
      try {
        await applyCommand(cmd);
      } catch (err) {
        // A failed mutation must settle the host's await rather than hang it.
        if ('cmdId' in cmd) {
          postNow({ kind: 'cmderr', cmdId: cmd.cmdId, message: String((err as Error)?.stack ?? err) });
        }
      }
    }
  } finally {
    draining = false;
  }
}

// ── side-band REST cross-check ───────────────────────────────────────────────
// The info-only REST cross-check fetches run on THIS thread (idle between
// socket frames) instead of the main solver thread, so their abort timers
// fire on time and true latency is realized. These are handled out-of-band —
// not pushed onto the single-flight cmdQueue — so a cross-check can never
// block behind (or delay) a subscription mutation, and a slow REST GET can
// never stall a startTracking / updateSubscriptions ack. They call the same
// read-only `fetchRestBook` the in-process path used; no adapter, book, or
// subscription state is touched. Timing them via recordOccupancy would
// pollute the socket-handler distribution (a GET await yields the loop, so
// it is not handler-blocking time), so they are deliberately not recorded
// there.
async function handleCrosscheckFetch(cmd: CrosscheckFetchCmd): Promise<void> {
  let book: NormalizedRestBook | null = null;
  try {
    book = await fetchRestBook({ platform: cmd.platform, id: cmd.id });
  } catch {
    book = null; // info-only: any failure degrades to unavailable
  }
  postNow({ kind: 'crosscheckResult', reqId: cmd.reqId, book });
}

function handleCrosscheckDiag(cmd: CrosscheckDiagCmd): void {
  postNow({ kind: 'crosscheckDiagResult', reqId: cmd.reqId, line: restCrosscheckDiagLine(cmd.reset) });
}

port.on('message', (cmd: HostToWorker) => {
  // Side-band cross-check messages bypass the ordered command queue.
  if (cmd.kind === 'crosscheckFetch') {
    void handleCrosscheckFetch(cmd);
    return;
  }
  if (cmd.kind === 'crosscheckDiag') {
    handleCrosscheckDiag(cmd);
    return;
  }
  cmdQueue.push(cmd);
  void drainCommands();
});

// ── periodic occupancy report ────────────────────────────────────────────────
const occTimer = setInterval(() => {
  postNow({
    kind: 'occupancy',
    n: occN,
    sumMs: occSumMs,
    maxMs: occMaxMs,
    buckets: occBuckets.slice(),
    framesPosted: framesPostedWindow,
    batchesPosted: batchesPostedWindow,
  });
  occN = 0;
  occSumMs = 0;
  occMaxMs = 0;
  for (let i = 0; i < occBuckets.length; i++) occBuckets[i] = 0;
  framesPostedWindow = 0;
  batchesPostedWindow = 0;
}, IO_OCCUPANCY_REPORT_MS);
// Don't let the report timer keep the worker alive on its own.
if (typeof occTimer.unref === 'function') occTimer.unref();

// Signal readiness only after the manager + adapters + command loop are live, so
// the host's ready() gate guarantees the first command never races construction.
postNow({ kind: 'ready' });
