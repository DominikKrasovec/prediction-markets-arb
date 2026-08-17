/**
 * lifecycle-bench — Predict REST-poll discovery probe (creations + resolutions).
 *
 * Predict has no WSS lifecycle channel (see services/ingestion/src/index.ts §4),
 * so both new-market discovery and resolution detection there are REST-poll only
 * (in prod: the periodic scrape + the resolution-monitor). Each tick this probe
 * polls two heads — OPEN (creations) and RESOLVED (resolutions) — sorted
 * published-desc, and for each market id NOT seen before in that head emits a
 * `discovery` event (with market type + a detection latency vs the payload's
 * creation / resolution timestamp). It also emits a per-head `poll` sample
 * (latency / item count). It writes nothing to the DB.
 *
 * Caveats (surfaced in the report):
 *   - The FIRST poll of each head is the baseline (first observation), not an
 *     event during the run; baseline ids are seeded into the seen-set and not
 *     emitted as discoveries.
 *   - We page the published-desc head (bounded by maxCategories), not the whole
 *     catalogue. For CREATIONS that's the right slice (new markets sort to the
 *     top). For RESOLUTIONS it is a *coverage-limited proxy*: a market that was
 *     published long ago but just resolved may not sit near the published-desc
 *     head, so it can be missed. Per-event resolution latency (vs resolvedAt) is
 *     still accurate for the markets we do catch; the count is a lower bound.
 */

import { fetchCategories } from '../scrapers/predict/api-client.js';
import { MarketStatus, CategorySortBy } from '../scrapers/predict/types.js';
import { hrNowMs, type BenchSink } from './metrics.js';
import { extractServerTs } from './clock.js';
import { unifiedCategory, nativeType } from './classify.js';

interface Head {
  status: string;
  kind: 'created' | 'resolved';
  seen: Set<string>;
  baselineDone: boolean;
}

// Hard cap per fetch: the REST poll has no socket-level watchdog (unlike the WSS
// feeds), so a hung request (dead keep-alive socket where axios's own timeout
// doesn't fire) would otherwise stall the poll loop forever. This guarantees the
// await always settles → the loop always reschedules.
const POLL_FETCH_TIMEOUT_MS = 45_000;

/** Reject after `ms` if `p` hasn't settled (the underlying request may keep running). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export class PredictPollBench {
  private readonly heads: Head[] = [
    { status: MarketStatus.OPEN, kind: 'created', seen: new Set(), baselineDone: false },
    { status: MarketStatus.RESOLVED, kind: 'resolved', seen: new Set(), baselineDone: false },
  ];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly sink: BenchSink,
    private readonly pollIntervalMs: number,
    private readonly clockOffsetMs: number,
    private readonly firstPage = 50,
    private readonly maxCategories = 50,
  ) {}

  start(): void {
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick(); }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      // Poll both heads sequentially (keeps API pressure low + ordering simple).
      for (const head of this.heads) {
        if (this.stopped) break;
        await this.pollHead(head);
      }
    } finally {
      // ALWAYS reschedule — a hung/throwing poll must never kill the loop.
      this.scheduleNext(this.pollIntervalMs);
    }
  }

  private async pollHead(head: Head): Promise<void> {
    const startWall = Date.now();
    const startHr = hrNowMs();
    const markets = new Map<string, Record<string, unknown>>();
    let pages = 0;
    let ok = true;
    let error: string | undefined;

    try {
      await withTimeout(fetchCategories({
        first: this.firstPage,
        status: head.status,
        sort: CategorySortBy.PUBLISHED_AT_DESC,
        maxCategories: this.maxCategories,
        onBatch: async (_categories, batch) => {
          pages++;
          for (const m of batch as Array<Record<string, unknown>>) {
            const id = String(m.id ?? m.conditionId ?? '');
            if (id) markets.set(id, m);
          }
        },
      }), POLL_FETCH_TIMEOUT_MS, `predict ${head.kind} poll`);
    } catch (e: any) {
      ok = false;
      error = e?.message ?? String(e);
    }

    // Diff vs prior polls of THIS head; emit discoveries only after the baseline.
    let newIds = 0;
    for (const [id, market] of markets) {
      if (head.seen.has(id)) continue;
      head.seen.add(id);
      newIds++;
      if (!head.baselineDone) continue; // baseline = first observation, not an event
      this.emitDiscovery(head.kind, id, market);
    }
    head.baselineDone = true;

    this.sink.emit({
      type: 'poll',
      platform: 'predict',
      pollKind: head.kind,
      t: startWall,
      hr: startHr,
      ok,
      latencyMs: Date.now() - startWall,
      itemsSeen: markets.size,
      newIds,
      pages,
      error,
    });
  }

  private emitDiscovery(kind: 'created' | 'resolved', id: string, market: Record<string, unknown>): void {
    const t = Date.now();
    const { epochMs, field } = extractServerTs(market, kind);
    const detectMs = epochMs !== null ? (t + this.clockOffsetMs) - epochMs : null;
    const native = nativeType('predict', market);
    this.sink.captureRaw('predict', kind, market);
    this.sink.emit({
      type: 'discovery',
      platform: 'predict',
      kind,
      t,
      hr: hrNowMs(),
      id,
      serverTs: epochMs,
      tsField: field,
      detectMs,
      marketType: unifiedCategory('predict', market),
      nativeType: native.type,
      typeField: native.field,
      title: typeof market.title === 'string' ? market.title : undefined,
    });
  }
}
