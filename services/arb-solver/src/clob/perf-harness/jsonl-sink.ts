import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@arb/types';
import type { PriceUpdate } from '../price-cache.js';

/**
 * Per-platform JSONL writer for the CLOB perf harness.
 *
 * Layout:
 *   <runDir>/
 *     manifest.json
 *     kalshi.jsonl
 *     polymarket.jsonl
 *     limitless.jsonl
 *     predict.jsonl
 *     summary.json   (written at shutdown)
 *
 * One JSON object per line. Each row contains the full PriceUpdate plus the
 * harness-side `recvTs` (when our callback fired). Lines are batched and
 * flushed on a 250 ms timer to amortize fs.write overhead; the batch is also
 * flushed when it exceeds 1024 rows.
 */

const FLUSH_INTERVAL_MS = 250;
const MAX_BATCH = 1024;

interface SinkRow extends PriceUpdate {
  recvTs: number;
}

export class JsonlSink {
  private streams = new Map<Platform, WriteStream>();
  private buffers = new Map<Platform, string[]>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(public readonly runDir: string) {
    mkdirSync(runDir, { recursive: true });
  }

  start(platforms: Platform[]): void {
    for (const p of platforms) {
      const path = join(this.runDir, `${p}.jsonl`);
      const s = createWriteStream(path, { flags: 'a', encoding: 'utf8' });
      this.streams.set(p, s);
      this.buffers.set(p, []);
    }
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  write(u: PriceUpdate): void {
    if (this.closed) return;
    const buf = this.buffers.get(u.platform);
    if (!buf) return;
    const row: SinkRow = { ...u, recvTs: Date.now() };
    buf.push(JSON.stringify(row));
    if (buf.length >= MAX_BATCH) this.flushPlatform(u.platform);
  }

  private flushPlatform(platform: Platform): void {
    const buf = this.buffers.get(platform);
    const stream = this.streams.get(platform);
    if (!buf || !stream || buf.length === 0) return;
    const chunk = buf.join('\n') + '\n';
    buf.length = 0;
    stream.write(chunk);
  }

  private flush(): void {
    for (const p of this.streams.keys()) this.flushPlatform(p);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush();
    await Promise.all(
      [...this.streams.values()].map(
        (s) =>
          new Promise<void>((resolve) => {
            s.end(() => resolve());
          }),
      ),
    );
  }
}
