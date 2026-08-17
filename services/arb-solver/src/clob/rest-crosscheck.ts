/**
 * Re-fetches a leg's authoritative REST orderbook and compares it to the WSS
 * snapshot the solver priced off, stamping a verdict onto the arb record as
 * an annotation only — never affects which arbs fire, profit, or grading.
 */

import type { Platform } from '@arb/types';
// Must stay a static import: this package is ESM, and a CommonJS require() throws at runtime.
import { createAuthHeaders } from '@arb/kalshi-auth';

export type RestVerdict =
  | 'valid'
  | 'stale'
  | 'crossed'
  | 'mismatch'
  | 'rest-unavailable';

/** $/share, 0..1 on the YES side, like the WSS `OrderBook`. */
export interface NormalizedRestBook {
  bestBid: number;
  bestAsk: number;
  askLevels: Array<[number, number]>;
  bidLevels: Array<[number, number]>;
}

export interface WssBookRef {
  bestBid: number;
  bestAsk: number;
  lastUpdate?: number;
  staleSince?: number | null;
}

export interface CompareResult {
  verdict: RestVerdict;
  deltaBps: number | null;
  restBestBid: number | null;
  restBestAsk: number | null;
}

/**
 * Caller must resolve the platform-native id before calling `fetchRestBook`:
 * kalshi=ticker, polymarket=clobTokenId (not the condition_id), predict=numeric
 * market id, limitless=slug (YES book only; NO is derived as 1 - YES_bid).
 */
export interface RestBookRef {
  platform: Platform;
  id: string;
}

const FETCH_BUDGET_MS = (() => {
  const v = parseInt(process.env.REST_CROSSCHECK_FETCH_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
})();

const TTL_MS = (() => {
  const v = parseInt(process.env.REST_CROSSCHECK_TTL_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 3000;
})();

const CONCURRENCY = (() => {
  const v = parseInt(process.env.REST_CROSSCHECK_CONCURRENCY ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 24;
})();

const TOLERANCE = (() => {
  const v = parseFloat(process.env.REST_CROSSCHECK_TOLERANCE ?? '');
  return Number.isFinite(v) && v > 0 ? v : 0.02;
})();

// Opt-in per-platform failure tally distinguishing why a fetch degraded to 'rest-unavailable'; zero-cost when off.
const DEBUG = process.env.REST_CROSSCHECK_DEBUG === '1';
type FailReason = 'auth-throw' | 'abort' | 'http-4xx' | 'http-5xx' | 'http-other' | 'network' | 'parse' | 'ok';
const failTally = new Map<string, number>();
function tally(platform: Platform, reason: FailReason): void {
  if (!DEBUG) return;
  const k = `${platform}:${reason}`;
  failTally.set(k, (failTally.get(k) ?? 0) + 1);
}
export function restCrosscheckDebugTally(reset = false): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of failTally) out[k] = v;
  if (reset) failTally.clear();
  return out;
}

// Separate diagnostics gate from REST_CROSSCHECK_DEBUG above; never affects a verdict.
const DIAG = process.env.REST_CROSSCHECK === '1';

type DiagOutcome =
  | 'ok'
  | 'http-429'
  | 'http-4xx'
  | 'http-5xx'
  | 'http-other'
  | 'timeout'
  | 'abort'
  | 'neterror'
  | 'parse';

interface PlatformDiag {
  counts: Record<DiagOutcome, number>;
  lat: number[];
  latMax: number;
}

const LAT_CAP = 512;
const SAMPLE_CAP = 3;

function newPlatformDiag(): PlatformDiag {
  return {
    counts: {
      ok: 0, 'http-429': 0, 'http-4xx': 0, 'http-5xx': 0, 'http-other': 0,
      timeout: 0, abort: 0, neterror: 0, parse: 0,
    },
    lat: [],
    latMax: 0,
  };
}

const platformDiag = new Map<Platform, PlatformDiag>();
const diagSamples: string[] = [];
const diagSampleKeys = new Set<string>();

function diagGet(p: Platform): PlatformDiag {
  let d = platformDiag.get(p);
  if (!d) { d = newPlatformDiag(); platformDiag.set(p, d); }
  return d;
}

function diagRecord(platform: Platform, outcome: DiagOutcome, latencyMs: number, detail?: string): void {
  if (!DIAG) return;
  const d = diagGet(platform);
  d.counts[outcome]++;
  if (latencyMs > d.latMax) d.latMax = latencyMs;
  if (d.lat.length < LAT_CAP) d.lat.push(latencyMs);
  if (outcome !== 'ok' && detail && diagSamples.length < SAMPLE_CAP) {
    const key = `${platform}|${outcome}|${detail}`;
    if (!diagSampleKeys.has(key)) {
      diagSampleKeys.add(key);
      diagSamples.push(`${platform} ${detail} → ${outcome}`);
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function restCrosscheckDiagLine(reset = false): { summary: string; samples: string[] } | null {
  if (!DIAG) return null;
  const lim = limiterGauge();
  const parts: string[] = [];
  for (const [platform, d] of platformDiag) {
    const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    const tally = (Object.entries(d.counts) as Array<[DiagOutcome, number]>)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(',');
    const sorted = [...d.lat].sort((a, b) => a - b);
    parts.push(`${platform}{${tally} p50=${percentile(sorted, 50)}ms max=${d.latMax}ms}`);
  }
  const limStr = `limiter[inflight=${lim.active}/${lim.cap} queued=${lim.queued}]`;
  const summary = parts.length > 0 ? `${parts.join(' ')} ${limStr}` : limStr;
  const samples = [...diagSamples];
  if (reset) {
    for (const d of platformDiag.values()) {
      for (const k of Object.keys(d.counts) as DiagOutcome[]) d.counts[k] = 0;
      d.lat.length = 0;
      d.latMax = 0;
    }
    diagSamples.length = 0;
    diagSampleKeys.clear();
  }
  return { summary, samples };
}

const KALSHI_REST_BASE = process.env.KALSHI_REST_URL ?? 'https://api.elections.kalshi.com';
const POLYMARKET_REST_URL = process.env.POLYMARKET_REST_URL || 'https://clob.polymarket.com';
const PREDICT_REST_BASE = process.env.PREDICT_REST_URL || 'https://api.predict.fun';
const LIMITLESS_REST_BASE = process.env.LIMITLESS_REST_URL || 'https://api.limitless.exchange';

interface LimiterGauge { active: number; queued: number; cap: number; }
let limiterGauge: () => LimiterGauge = () => ({ active: 0, queued: 0, cap: CONCURRENCY });

function createConcurrencyLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  limiterGauge = () => ({ active, queued: queue.length, cap: concurrency });
  function dispatch() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    queue.shift()!();
  }
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      dispatch();
    });
    try {
      return await fn();
    } finally {
      active--;
      dispatch();
    }
  };
}

const limit = createConcurrencyLimiter(CONCURRENCY);

interface CacheEntry {
  at: number;
  promise: Promise<NormalizedRestBook | null>;
}
const bookCache = new Map<string, CacheEntry>();

function cacheKey(ref: RestBookRef): string {
  return `${ref.platform}:${ref.id}`;
}

export function _resetRestCrosscheckCache(): void {
  bookCache.clear();
}

async function fetchJson(
  url: string,
  headers: Record<string, string> | undefined,
  platform: Platform,
): Promise<any | null> {
  const ctrl = new AbortController();
  let timedOut = false;
  const t0 = Date.now();
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, FETCH_BUDGET_MS);
  // Query stripped from logged path to keep tokens/keys out of samples.
  const reqPath = (() => { try { const u = new URL(url); return `GET ${u.host}${u.pathname}`; } catch { return 'GET <url>'; } })();
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const latency = Date.now() - t0;
    if (!r.ok) {
      tally(platform, r.status >= 500 ? 'http-5xx' : r.status >= 400 ? 'http-4xx' : 'http-other');
      const outcome: DiagOutcome =
        r.status === 429 ? 'http-429'
          : r.status >= 500 ? 'http-5xx'
          : r.status >= 400 ? 'http-4xx'
          : 'http-other';
      diagRecord(platform, outcome, latency, `${reqPath} → HTTP ${r.status} ${r.statusText}`);
      return null;
    }
    try {
      const j = await r.json();
      tally(platform, 'ok');
      diagRecord(platform, 'ok', Date.now() - t0);
      return j;
    } catch (err) {
      tally(platform, 'parse');
      diagRecord(platform, 'parse', Date.now() - t0, `${reqPath} → parse ${(err as Error)?.name ?? 'error'}: ${(err as Error)?.message ?? ''}`);
      return null;
    }
  } catch (err) {
    const latency = Date.now() - t0;
    const isAbort = (err as Error)?.name === 'AbortError';
    tally(platform, isAbort ? 'abort' : 'network');
    if (isAbort) {
      const outcome: DiagOutcome = timedOut ? 'timeout' : 'abort';
      diagRecord(platform, outcome, latency, timedOut ? `${reqPath} → timeout after ${FETCH_BUDGET_MS}ms` : `${reqPath} → aborted`);
    } else {
      // Undici nests the real errno on error.cause.code.
      const e = err as { code?: string; name?: string; message?: string; cause?: { code?: string; message?: string } };
      const code = e?.code ?? e?.cause?.code ?? e?.name ?? 'error';
      const msg = e?.cause?.message ?? e?.message ?? '';
      diagRecord(platform, 'neterror', latency, `${reqPath} → neterror-${code}: ${msg}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Kalshi returns only YES/NO bids; YES ask = 1 - best NO bid.
function normalizeKalshi(j: any): NormalizedRestBook | null {
  const ob = j?.orderbook_fp ?? j?.orderbook;
  if (!ob) return null;
  const yesBids: Array<[number, number]> = [];
  for (const [p, s] of ob.yes_dollars ?? ob.yes ?? []) {
    const price = parseFloat(String(p));
    const size = parseFloat(String(s));
    if (Number.isFinite(price) && size > 0) yesBids.push([price, size]);
  }
  const askLevels: Array<[number, number]> = [];
  for (const [p, s] of ob.no_dollars ?? ob.no ?? []) {
    const q = parseFloat(String(p));
    const size = parseFloat(String(s));
    if (Number.isFinite(q) && size > 0) {
      const yesAsk = 1 - q;
      if (yesAsk > 0) askLevels.push([yesAsk, size]);
    }
  }
  yesBids.sort((a, b) => b[0] - a[0]);
  askLevels.sort((a, b) => a[0] - b[0]);
  return {
    bestBid: yesBids[0]?.[0] ?? 0,
    bestAsk: askLevels[0]?.[0] ?? 2.0,
    bidLevels: yesBids,
    askLevels,
  };
}

function normalizePolymarket(j: any): NormalizedRestBook | null {
  if (!j || (!Array.isArray(j.bids) && !Array.isArray(j.asks))) return null;
  const bidLevels: Array<[number, number]> = [];
  for (const lvl of j.bids ?? []) {
    const price = parseFloat(String(lvl.price));
    const size = parseFloat(String(lvl.size));
    if (Number.isFinite(price) && size > 0) bidLevels.push([price, size]);
  }
  const askLevels: Array<[number, number]> = [];
  for (const lvl of j.asks ?? []) {
    const price = parseFloat(String(lvl.price));
    const size = parseFloat(String(lvl.size));
    if (Number.isFinite(price) && size > 0) askLevels.push([price, size]);
  }
  bidLevels.sort((a, b) => b[0] - a[0]);
  askLevels.sort((a, b) => a[0] - b[0]);
  return {
    bestBid: bidLevels[0]?.[0] ?? 0,
    bestAsk: askLevels[0]?.[0] ?? 2.0,
    bidLevels,
    askLevels,
  };
}

function normalizePredict(j: any): NormalizedRestBook | null {
  const d = j?.data;
  if (!d || (!Array.isArray(d.bids) && !Array.isArray(d.asks))) return null;
  const bidLevels: Array<[number, number]> = [];
  for (const pair of d.bids ?? []) {
    const price = parseFloat(String(pair?.[0]));
    const size = parseFloat(String(pair?.[1]));
    if (Number.isFinite(price) && size > 0) bidLevels.push([price, size]);
  }
  const askLevels: Array<[number, number]> = [];
  for (const pair of d.asks ?? []) {
    const price = parseFloat(String(pair?.[0]));
    const size = parseFloat(String(pair?.[1]));
    if (Number.isFinite(price) && size > 0) askLevels.push([price, size]);
  }
  bidLevels.sort((a, b) => b[0] - a[0]);
  askLevels.sort((a, b) => a[0] - b[0]);
  return {
    bestBid: bidLevels[0]?.[0] ?? 0,
    bestAsk: askLevels[0]?.[0] ?? 2.0,
    bidLevels,
    askLevels,
  };
}

function normalizeLimitless(j: any): NormalizedRestBook | null {
  if (!j || (!Array.isArray(j.bids) && !Array.isArray(j.asks))) return null;
  const bidLevels: Array<[number, number]> = [];
  for (const lvl of j.bids ?? []) {
    const price = Number(lvl.price);
    const size = Number(lvl.size);
    if (Number.isFinite(price) && size > 0) bidLevels.push([price, size]);
  }
  const askLevels: Array<[number, number]> = [];
  for (const lvl of j.asks ?? []) {
    const price = Number(lvl.price);
    const size = Number(lvl.size);
    if (Number.isFinite(price) && size > 0) askLevels.push([price, size]);
  }
  bidLevels.sort((a, b) => b[0] - a[0]);
  askLevels.sort((a, b) => a[0] - b[0]);
  return {
    bestBid: bidLevels[0]?.[0] ?? 0,
    bestAsk: askLevels[0]?.[0] ?? 2.0,
    bidLevels,
    askLevels,
  };
}

function endpointFor(
  ref: RestBookRef,
): { url: string; headers?: Record<string, string>; normalize: (j: any) => NormalizedRestBook | null } | null {
  switch (ref.platform) {
    case 'kalshi': {
      try {
        const path = `/trade-api/v2/markets/${ref.id}/orderbook`;
        const headers = createAuthHeaders('GET', path) as Record<string, string>;
        return {
          url: `${KALSHI_REST_BASE}${path}`,
          headers,
          normalize: normalizeKalshi,
        };
      } catch (err) {
        tally('kalshi', 'auth-throw');
        diagRecord('kalshi', 'neterror', 0, `auth-throw: ${(err as Error)?.message ?? ''}`);
        if (DEBUG) console.error(`[rest-crosscheck] kalshi auth-throw: ${(err as Error)?.message}`);
        return null;
      }
    }
    case 'polymarket':
      return {
        url: `${POLYMARKET_REST_URL}/book?token_id=${encodeURIComponent(ref.id)}`,
        normalize: normalizePolymarket,
      };
    case 'predict': {
      const apiKey = process.env.PREDICT_API_KEY;
      return {
        url: `${PREDICT_REST_BASE}/v1/markets/${encodeURIComponent(ref.id)}/orderbook`,
        headers: apiKey ? { 'x-api-key': apiKey } : undefined,
        normalize: normalizePredict,
      };
    }
    case 'limitless': {
      const apiKey = process.env.LIMITLESS_API_KEY;
      return {
        url: `${LIMITLESS_REST_BASE}/markets/${encodeURIComponent(ref.id)}/orderbook`,
        headers: apiKey ? { 'X-API-Key': apiKey } : undefined,
        normalize: normalizeLimitless,
      };
    }
    default:
      return null;
  }
}

/** Never throws; returns null on any failure (network, non-2xx, parse, abort, missing creds). */
export async function fetchRestBook(ref: RestBookRef): Promise<NormalizedRestBook | null> {
  const key = cacheKey(ref);
  const now = Date.now();
  const cached = bookCache.get(key);
  if (cached && now - cached.at < TTL_MS) return cached.promise;

  const promise = limit(async (): Promise<NormalizedRestBook | null> => {
    const ep = endpointFor(ref);
    if (!ep) return null;
    const j = await fetchJson(ep.url, ep.headers, ref.platform);
    if (j == null) return null;
    try {
      return ep.normalize(j);
    } catch {
      return null;
    }
  });

  bookCache.set(key, { at: now, promise });
  for (const [k, e] of bookCache) {
    if (now - e.at >= TTL_MS) bookCache.delete(k);
  }
  return promise;
}

// consumedSide: 'ask' for a YES leg (buys at ask), 'bid' for a NO leg (sells YES into the bid). staleSince takes precedence over any REST verdict.
export function compareBooks(
  wss: WssBookRef,
  rest: NormalizedRestBook | null,
  consumedSide: 'ask' | 'bid' = 'ask',
): CompareResult {
  if (wss.staleSince != null) {
    return {
      verdict: 'stale',
      deltaBps: null,
      restBestBid: rest ? rest.bestBid : null,
      restBestAsk: rest ? rest.bestAsk : null,
    };
  }

  if (!rest) {
    return { verdict: 'rest-unavailable', deltaBps: null, restBestBid: null, restBestAsk: null };
  }

  // Corrupt / locked REST book.
  const hasBid = rest.bestBid > 0;
  const hasAsk = rest.bestAsk < 2.0; // 2.0 is the no-ask sentinel
  if (hasBid && hasAsk && rest.bestBid >= rest.bestAsk) {
    return { verdict: 'crossed', deltaBps: null, restBestBid: rest.bestBid, restBestAsk: rest.bestAsk };
  }

  const wssPrice = consumedSide === 'ask' ? wss.bestAsk : wss.bestBid;
  const restPrice = consumedSide === 'ask' ? rest.bestAsk : rest.bestBid;

  // No REST quote on the consumed side ⟹ cannot confirm.
  const restHasConsumedSide = consumedSide === 'ask' ? hasAsk : hasBid;
  if (!restHasConsumedSide) {
    return { verdict: 'rest-unavailable', deltaBps: null, restBestBid: rest.bestBid, restBestAsk: rest.bestAsk };
  }

  const diff = Math.abs(wssPrice - restPrice);
  const deltaBps = restPrice > 0 ? (diff / restPrice) * 1e4 : null;
  const verdict: RestVerdict = diff <= TOLERANCE ? 'valid' : 'mismatch';
  return { verdict, deltaBps, restBestBid: rest.bestBid, restBestAsk: rest.bestAsk };
}

/** The active tolerance ($) — exposed for tests / logging. */
export function restCrosscheckTolerance(): number {
  return TOLERANCE;
}
