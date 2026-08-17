import { config } from '../config.js';
import { createLogger } from '@arb/logger';
import { query } from '@arb/db';
import {
  selectMarketsNeedingEmbedding,
  countMarketsNeedingEmbedding,
  bulkUpdateMarketEmbeddings,
} from '../db/queries/markets.js';
import { isParlaySql } from '../db/queries/match-source.js';
import { embeddingLimiter, ApiError, parseRetryAfterMs, parseRetryAfterFromBody } from '@arb/llm';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIM = 1536;
const BATCH_SIZE = 100; // OpenAI supports up to 2048 inputs per request
// Concurrency + 429 backoff are global across all callers via embeddingLimiter.
// Fails fast instead of hanging on undici's ~5min default; withRetry re-attempts.
const EMBED_API_TIMEOUT_MS = parseInt(process.env.EMBED_API_TIMEOUT_MS ?? '60000');

const log = createLogger('embedder');

// Stale-vector guard: detects a position holding the previous call's vector
// unchanged despite different input text; re-requests once, then throws.

/** Two independent 1536-dim embeddings never share 8 leading floats by
 *  chance; equality implies the bytes were copied. */
const FP_FLOATS = 8;

interface CallFingerprint {
  textHashes: Int32Array; // FNV-1a per input text (collision → a missed alarm, never a false one)
  vecHeads: Float64Array;
  n: number;
}

let prevCallFp: CallFingerprint | null = null;

export function _resetEmbeddingIntegrityStateForTests(): void {
  prevCallFp = null;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function fingerprintCall(textHashes: Int32Array, vectors: number[][]): CallFingerprint {
  const n = vectors.length;
  const vecHeads = new Float64Array(n * FP_FLOATS);
  for (let i = 0; i < n; i++) {
    const v = vectors[i];
    for (let j = 0; j < FP_FLOATS; j++) vecHeads[i * FP_FLOATS + j] = v[j];
  }
  return { textHashes, vecHeads, n };
}

function findStalePositions(
  textHashes: Int32Array,
  vectors: number[][],
  prev: CallFingerprint,
): number[] {
  const bad: number[] = [];
  const m = Math.min(vectors.length, prev.n);
  for (let i = 0; i < m; i++) {
    if (textHashes[i] === prev.textHashes[i]) continue; // same input ⇒ identical vector is legit
    const v = vectors[i];
    let same = true;
    for (let j = 0; j < FP_FLOATS; j++) {
      if (v[j] !== prev.vecHeads[i * FP_FLOATS + j]) { same = false; break; }
    }
    if (same) bad.push(i);
  }
  return bad;
}

// Guarantees: texts.length entries, each freshly allocated and finite; a
// stale positional copy triggers one re-request, then throws.
export async function embedTexts(
  texts: string[]
): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  if (texts.length === 0) return [];

  const textHashes = new Int32Array(texts.length);
  for (let i = 0; i < texts.length; i++) textHashes[i] = fnv1a(texts[i]);

  let vectors = await embedTextsOnce(apiKey, texts);
  if (prevCallFp) {
    let stale = findStalePositions(textHashes, vectors, prevCallFp);
    if (stale.length > 0) {
      log.error(
        `embedTexts integrity violation: ${stale.length}/${texts.length} vector(s) are byte-identical ` +
        `to the previous call at the same position despite different input text ` +
        `(first positions: ${stale.slice(0, 5).join(', ')}) — re-requesting the whole batch`,
      );
      vectors = await embedTextsOnce(apiKey, texts);
      stale = findStalePositions(textHashes, vectors, prevCallFp);
      if (stale.length > 0) {
        throw new Error(
          `embedTexts integrity violation persisted after re-request: ${stale.length}/${texts.length} ` +
          `stale position(s) (first: ${stale.slice(0, 5).join(', ')}) — refusing to return corrupt vectors`,
        );
      }
    }
  }
  prevCallFp = fingerprintCall(textHashes, vectors);
  return vectors;
}

// Routes each chunk's vectors by explicit offset (not .flat()/positional zip)
// so out-of-order completion can't misroute; hole-checked after.
async function embedTextsOnce(apiKey: string, texts: string[]): Promise<number[][]> {
  const result: number[][] = new Array(texts.length);
  const jobs: Array<{ start: number; inputs: string[] }> = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    jobs.push({ start: i, inputs: texts.slice(i, i + BATCH_SIZE) });
  }
  await Promise.all(
    jobs.map(async (job) => {
      const vecs = await embeddingLimiter.run(
        () => callEmbeddingAPI(apiKey, job.inputs),
        { label: 'embed/text-embedding-3-small' },
      );
      for (let k = 0; k < vecs.length; k++) result[job.start + k] = vecs[k];
    }),
  );
  for (let i = 0; i < result.length; i++) {
    if (!Array.isArray(result[i])) {
      throw new Error(`embedTexts: position ${i} of ${texts.length} missing after all chunks resolved`);
    }
  }
  return result;
}

export function buildEmbeddingInput(title: string, description: string): string {
  const desc = description.length > 500 ? description.slice(0, 500) : description;
  return `${title}\n${desc}`.trim();
}

async function callEmbeddingAPI(apiKey: string, inputs: string[]): Promise<number[][]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      dimensions: EMBEDDING_DIM,
    }),
    signal: AbortSignal.timeout(EMBED_API_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    // Body-parsed delay (sub-second) is preferred over the seconds-rounded
    // Retry-After header; falls back to header, then null.
    const bodyMs = parseRetryAfterFromBody(text);
    const headerMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const retryMs = bodyMs ?? headerMs;
    throw new ApiError(response.status, `Embedding API error ${response.status}: ${text}`, retryMs);
  }

  const data = await response.json();
  return parseEmbeddingResponse(data, inputs.length);
}

// Validates index bijection + dimension + finiteness; deep-copies every float.
export function parseEmbeddingResponse(payload: unknown, inputCount: number): number[][] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new ApiError(502, 'Embedding API: malformed response — missing data array');
  }
  if (data.length !== inputCount) {
    throw new ApiError(502, `Embedding API: ${data.length} embeddings returned for ${inputCount} inputs`);
  }
  const out: number[][] = new Array(inputCount);
  for (const item of data as Array<{ embedding?: unknown; index?: unknown }>) {
    const idx = item?.index;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= inputCount) {
      throw new ApiError(502, `Embedding API: out-of-range embedding index ${String(idx)} (inputs: ${inputCount})`);
    }
    if (out[idx] !== undefined) {
      throw new ApiError(502, `Embedding API: duplicate embedding index ${idx}`);
    }
    const emb = item.embedding;
    if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) {
      throw new ApiError(
        502,
        `Embedding API: embedding at index ${idx} has dimension ${Array.isArray(emb) ? emb.length : 'none'} (expected ${EMBEDDING_DIM})`,
      );
    }
    const copy = new Array<number>(EMBEDDING_DIM);
    for (let j = 0; j < EMBEDDING_DIM; j++) {
      const v = emb[j];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ApiError(502, `Embedding API: non-finite value at embedding[${idx}][${j}]`);
      }
      copy[j] = v;
    }
    out[idx] = copy;
  }
  for (let i = 0; i < inputCount; i++) {
    if (out[i] === undefined) throw new ApiError(502, `Embedding API: missing embedding for index ${i}`);
  }
  return out;
}

// isEmbeddingDone and embeddingDoneSql must agree byte-for-byte with the
// batch queue-completion sweep (markCompletedQueueRows in stage1-normalize/index.ts).
export function embeddingDoneSql(marketAlias: string, normAlias: string): string {
  // Vacuously TRUE when embedding is gated off, else every non-parlay market
  // would be stranded 'pending' forever (embedding is never written under the gate).
  if (!config.embedding.embedMarkets) return 'TRUE';
  return config.embedding.skipParlayMarkets
    ? `(${marketAlias}.embedding IS NOT NULL OR ${isParlaySql(normAlias)})`
    : `${marketAlias}.embedding IS NOT NULL`;
}

export async function isEmbeddingDone(marketId: number): Promise<boolean> {
  const sql = config.embedding.skipParlayMarkets
    ? `SELECT TRUE AS ok
         FROM markets m
         LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
        WHERE m.id = $1
          AND ${embeddingDoneSql('m', 'n')}
        LIMIT 1`
    : `SELECT TRUE AS ok FROM markets m WHERE m.id = $1 AND ${embeddingDoneSql('m', 'n')} LIMIT 1`;
  const rows = await query<{ ok: boolean }>(sql, [marketId]);
  return rows.length > 0;
}

// Page size bridges pg-pool's ~10s idle reaper and gives crash-resumption
// (each page COMMITs its bulk UPDATE).
const EMBED_PAGE_SIZE = parseInt(process.env.EMBED_PAGE_SIZE ?? '2000');

export async function embedMarkets(
  markets: ReadonlyArray<{ id: number; title: string; description: string | null }>,
): Promise<number> {
  // Market-level embedding is off by default — the event ANN reads
  // platform_events.embedding instead; set EMBED_MARKETS=1 to opt back in.
  if (!config.embedding.embedMarkets) return 0;
  if (markets.length === 0) return 0;
  const texts = markets.map((m) => buildEmbeddingInput(m.title, m.description ?? ''));
  const vectors = await embedTexts(texts);
  if (vectors.length !== markets.length) {
    throw new Error(`embedMarkets: ${vectors.length} vectors for ${markets.length} markets — refusing to write misaligned page`);
  }
  const items = markets.map((m, i) => ({ id: m.id, vec: `[${vectors[i].join(',')}]` }));
  await bulkUpdateMarketEmbeddings(items, EMBEDDING_MODEL);
  return markets.length;
}

export async function embedAllMarkets(): Promise<number> {
  if (!config.embedding.embedMarkets) {
    log.info('Stage 1c (market embedding) skipped — EMBED_MARKETS off (AUD-30); event ANN rebuilds from title text');
    return 0;
  }
  const skipParlays = config.embedding.skipParlayMarkets;
  const totalBacklog = await countMarketsNeedingEmbedding({ skipParlays });

  if (totalBacklog === 0) {
    log.info('All markets already embedded');
    return 0;
  }

  log.info(
    `Embedding ${totalBacklog} markets in pages of ${EMBED_PAGE_SIZE}` +
    (skipParlays ? ' (FLAG: skipping kalshi:parlay:* markets — see config.embedding.skipParlayMarkets)' : '')
  );

  let totalEmbedded = 0;
  for (;;) {
    const page = await selectMarketsNeedingEmbedding({ skipParlays, limit: EMBED_PAGE_SIZE });
    if (page.length === 0) break;
    totalEmbedded += await embedMarkets(page);
    log.info(`Stage 1c progress: ${totalEmbedded}/${totalBacklog} embedded`);
    if (page.length < EMBED_PAGE_SIZE) break;
  }

  log.info(`Stored ${totalEmbedded} embeddings`);
  return totalEmbedded;
}
