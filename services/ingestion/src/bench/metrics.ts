/**
 * lifecycle-bench — instrumentation contract + JSONL sink + aggregation helpers.
 *
 * This is the new-market-DISCOVERY analogue of the CLOB price-feed geo-compare
 * harness (services/arb-solver/src/clob/geo-compare). It measures how fast and
 * how reliably we *detect newly-created markets* on each platform's discovery
 * feed — the WSS lifecycle channels (Kalshi/Polymarket/Limitless) and the
 * Predict REST poll — WITHOUT writing any discovered market to the DB.
 *
 * Design notes:
 *  - DB-less by construction. Nothing here imports `@arb/db`; the harness can run
 *    on any box (local or a DB-less VPS), exactly like geo-compare's run-geo.
 *  - Memory-bounded for long ("run on the server for longer") sessions: rare
 *    events (per-connection lifecycle phases, discoveries, poll samples) are kept
 *    in full; high-volume frames (heartbeats / generic messages) are reduced to
 *    running counters. Every event is also streamed to JSONL so a long run's
 *    durable record never lives only in memory.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export type BenchPlatform = 'kalshi' | 'polymarket' | 'limitless' | 'predict';

// ─── Event families ─────────────────────────────────────────────────────────

export type LifecyclePhase =
  | 'connect_start'
  | 'ws_open'
  | 'subscribe_sent'
  | 'first_message'
  | 'close'
  | 'reconnect_scheduled';

export interface LifecycleEvent {
  type: 'lifecycle';
  platform: BenchPlatform;
  phase: LifecyclePhase;
  /** Wall-clock ms (`Date.now()`). */
  t: number;
  /** Monotonic sub-ms timestamp (`hrNowMs()`) for interval math. */
  hr: number;
  /** Per-feed connection counter (++ at each connect_start). */
  connId: number;
  detail?: string;
}

export type ReliabilityKind =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnect'
  | 'heartbeat_in'
  | 'heartbeat_out';

export interface ReliabilityEvent {
  type: 'reliability';
  platform: BenchPlatform;
  kind: ReliabilityKind;
  t: number;
  hr: number;
  connId?: number;
  detail?: string;
}

/** A newly-detected market (`created`) or a settled one (`resolved`). */
export interface DiscoveryEvent {
  type: 'discovery';
  platform: BenchPlatform;
  kind: 'created' | 'resolved';
  t: number;
  hr: number;
  connId?: number;
  /** Platform identifier (ticker / conditionId / slug / numeric id). */
  id: string;
  /** Server/creation epoch-ms extracted from the payload, if any was found. */
  serverTs: number | null;
  /** Which payload field supplied `serverTs` (audit trail). */
  tsField: string | null;
  /**
   * Skew-corrected detection latency: `(t + clockOffsetMs) - serverTs`.
   * For `created` this is vs the creation timestamp; for `resolved` it is vs the
   * settlement/resolution timestamp. null when the payload carried no usable
   * timestamp. Bounded by NTP accuracy.
   */
  detectMs: number | null;
  /**
   * UNIFIED cross-platform category — the markets.category_unified vocabulary
   * (10 labels), via @arb/types classifyCategoryLabels. Primary bucket; this is
   * what makes the by-type breakdown comparable across platforms.
   */
  marketType: string;
  /** Granular platform-native label (e.g. KXBTC15M, CRYPTO_UP_DOWN), 'unknown' if none. */
  nativeType: string;
  /** Which payload field supplied `nativeType` (audit trail). */
  typeField: string | null;
  title?: string;
}

/** One REST poll cycle (Predict, or any REST-fallback feed). */
export interface PollSample {
  type: 'poll';
  platform: BenchPlatform;
  /** Which lifecycle phase this poll watches: new listings vs resolutions. */
  pollKind: 'created' | 'resolved';
  t: number;
  hr: number;
  ok: boolean;
  /** Wall request duration of the whole poll (all pages). */
  latencyMs: number;
  /** Markets observed in this poll. */
  itemsSeen: number;
  /** Ids not seen in any prior poll this run (the discovery signal for REST). */
  newIds: number;
  pages: number;
  error?: string;
}

export type BenchEvent =
  | LifecycleEvent
  | ReliabilityEvent
  | DiscoveryEvent
  | PollSample;

// ─── Clocks ──────────────────────────────────────────────────────────────────

/**
 * Sub-ms monotonic clock in ms. `process.hrtime.bigint()` is a nanosecond
 * monotonic counter; /1e6 → fractional ms. Interval math only (no wall meaning).
 */
export function hrNowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

// ─── Percentile / summary helpers ─────────────────────────────────────────────

export interface Dist {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

/** Nearest-rank percentiles over a numeric sample. Empty → all-null. */
export function summarize(values: number[]): Dist {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) {
    return { n: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  }
  const at = (p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    min: xs[0],
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: xs[xs.length - 1],
    mean: sum / xs.length,
  };
}

// ─── JSONL sink ────────────────────────────────────────────────────────────────

/**
 * Streams every event to a per-family JSONL file under the run dir and keeps a
 * memory-bounded in-process view for the end-of-run report.
 *
 * Run dir layout (mirrors geo-compare §2):
 *   <out>/lifecycle-bench-<runId>/
 *     manifest.json      run metadata (written at start)
 *     lifecycle.jsonl    connection phase timings
 *     reliability.jsonl  connect/disconnect/error/reconnect/heartbeat
 *     discovery.jsonl    created / resolved detections
 *     poll.jsonl         REST poll cycles
 *     summary.json       aggregated report (written at stop)
 */
export class BenchSink {
  readonly runDir: string;
  readonly runId: string;

  private readonly streams = new Map<string, WriteStream>();

  // In-memory (bounded) views for the report.
  readonly lifecycle: LifecycleEvent[] = [];
  readonly discoveries: DiscoveryEvent[] = [];
  readonly polls: PollSample[] = [];
  /** Reliability is reduced to per-platform per-kind counters. */
  private readonly reliabilityCounts = new Map<BenchPlatform, Record<string, number>>();
  /** Per-platform running message + heartbeat counters and first/last frame ts. */
  readonly msgStats = new Map<
    BenchPlatform,
    { messages: number; heartbeats: number; firstFrameT: number | null; lastFrameT: number | null }
  >();

  /** Per-(platform,kind) raw-payload sample counts, capped at `rawSampleCap`. */
  private readonly rawSampleCounts = new Map<string, number>();

  constructor(
    outRoot: string,
    runId: string,
    /** Max raw payloads to dump per (platform, kind) for field discovery; 0 = off. */
    private readonly rawSampleCap = 0,
  ) {
    this.runId = runId;
    this.runDir = join(outRoot, `lifecycle-bench-${runId}`);
    mkdirSync(this.runDir, { recursive: true });
  }

  /**
   * Persist up to `rawSampleCap` raw discovery payloads per (platform, kind) to
   * `raw-samples.jsonl`. WSS lifecycle frames are lighter than the full REST
   * objects, so these samples are how we learn which timestamp/type fields a
   * feed actually sends (and refine clock.ts/classify.ts). Bounded → safe on
   * long runs.
   */
  captureRaw(platform: BenchPlatform, kind: string, payload: unknown): void {
    if (this.rawSampleCap <= 0) return;
    const key = `${platform}:${kind}`;
    const n = this.rawSampleCounts.get(key) ?? 0;
    if (n >= this.rawSampleCap) return;
    this.rawSampleCounts.set(key, n + 1);
    this.stream('raw-samples').write(JSON.stringify({ platform, kind, payload }) + '\n');
  }

  private stream(family: string): WriteStream {
    let s = this.streams.get(family);
    if (!s) {
      s = createWriteStream(join(this.runDir, `${family}.jsonl`), { flags: 'a' });
      this.streams.set(family, s);
    }
    return s;
  }

  writeManifest(meta: Record<string, unknown>): void {
    createWriteStream(join(this.runDir, 'manifest.json')).end(JSON.stringify(meta, null, 2));
  }

  private bumpMsg(platform: BenchPlatform): {
    messages: number;
    heartbeats: number;
    firstFrameT: number | null;
    lastFrameT: number | null;
  } {
    let m = this.msgStats.get(platform);
    if (!m) {
      m = { messages: 0, heartbeats: 0, firstFrameT: null, lastFrameT: null };
      this.msgStats.set(platform, m);
    }
    return m;
  }

  /** Record a generic inbound frame (kept as a counter only). */
  noteFrame(platform: BenchPlatform, t: number, isHeartbeat: boolean): void {
    const m = this.bumpMsg(platform);
    m.messages++;
    if (isHeartbeat) m.heartbeats++;
    if (m.firstFrameT === null) m.firstFrameT = t;
    m.lastFrameT = t;
  }

  emit(ev: BenchEvent): void {
    switch (ev.type) {
      case 'lifecycle':
        this.lifecycle.push(ev);
        this.stream('lifecycle').write(JSON.stringify(ev) + '\n');
        break;
      case 'reliability': {
        let rec = this.reliabilityCounts.get(ev.platform);
        if (!rec) { rec = {}; this.reliabilityCounts.set(ev.platform, rec); }
        rec[ev.kind] = (rec[ev.kind] ?? 0) + 1;
        this.stream('reliability').write(JSON.stringify(ev) + '\n');
        break;
      }
      case 'discovery':
        this.discoveries.push(ev);
        this.stream('discovery').write(JSON.stringify(ev) + '\n');
        break;
      case 'poll':
        this.polls.push(ev);
        this.stream('poll').write(JSON.stringify(ev) + '\n');
        break;
    }
  }

  /** Per-kind reliability counters for one platform (empty record if none). */
  reliabilityCountsFor(platform: BenchPlatform): Record<string, number> {
    return this.reliabilityCounts.get(platform) ?? {};
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.streams.values()].map(
        (s) => new Promise<void>((res) => s.end(res)),
      ),
    );
  }
}
