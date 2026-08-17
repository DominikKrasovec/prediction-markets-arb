/**
 * Sentinel sink — in-memory ring buffer + JSONL append + structured log lines.
 * NO DB tables (a future migration can promote the JSONL stream to a table).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger, type Logger } from '@arb/logger';
import type { ReviewItem } from './types.js';

export interface SentinelSinkOptions {
  /** In-memory ring capacity (default 500 review items). */
  ringCapacity?: number;
  /** JSONL append path. `null`/absent → no file output (tests, dry runs).
   *  Suggested wiring value: `data/exports/sentinel-alerts.jsonl`. */
  jsonlPath?: string | null;
  /** Logger; `null` → silent. Default: `createLogger('sentinel:sink')`. */
  logger?: Logger | null;
}

export class SentinelSink {
  private readonly ring: ReviewItem[] = [];
  private readonly capacity: number;
  private readonly jsonlPath: string | null;
  private readonly log: Logger | null;
  private dirReady = false;

  constructor(opts: SentinelSinkOptions = {}) {
    this.capacity = Math.max(1, opts.ringCapacity ?? 500);
    this.jsonlPath = opts.jsonlPath ?? null;
    this.log = opts.logger === undefined ? createLogger('sentinel:sink') : opts.logger;
  }

  push(item: ReviewItem): void {
    this.ring.push(item);
    if (this.ring.length > this.capacity) {
      this.ring.splice(0, this.ring.length - this.capacity);
    }

    if (this.jsonlPath) {
      try {
        if (!this.dirReady) {
          mkdirSync(dirname(this.jsonlPath), { recursive: true });
          this.dirReady = true;
        }
        appendFileSync(this.jsonlPath, `${JSON.stringify(item)}\n`, 'utf8');
      } catch (err) {
        this.log?.error('JSONL append failed:', err);
      }
    }

    if (this.log) {
      const line =
        `${item.verdict} pair=${item.pairId} kind=${item.kind}` +
        `${item.postSpike ? ' POST-SPIKE' : ''} ` +
        `spread(last=${item.spread.lastMetric.toFixed(3)} max=${item.spread.maxMetric.toFixed(3)} ` +
        `dir=${item.spread.direction} consistency=${item.spread.signConsistency.toFixed(2)}) ` +
        `legA=${item.legA.platform}:${item.legA.marketId} "${item.legA.label}" ` +
        `legB=${item.legB.platform}:${item.legB.marketId} "${item.legB.label}" ` +
        `alert#${item.alertCount}`;
      // suspect-identity is the actionable identity-layer FP signal → WARN.
      if (item.verdict === 'suspect-identity') this.log.warn(line);
      else this.log.info(line);
    }
  }

  /** Most recent n items (oldest → newest). */
  recent(n = 50): ReviewItem[] {
    return this.ring.slice(-n);
  }

  all(): readonly ReviewItem[] {
    return this.ring;
  }

  get size(): number {
    return this.ring.length;
  }
}
