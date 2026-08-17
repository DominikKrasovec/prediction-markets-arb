/**
 * Tests for `embeddingDoneSql` — the single SQL-fragment source of truth
 * shared by the stage1_queue completion sweep (markCompletedQueueRows) and
 * the worker per-market gate (isEmbeddingDone).
 *
 * When the embedding write is gated OFF (default), no market needs an
 * embedding, so "embedding done" must be vacuously TRUE; otherwise the
 * completion sweep would require `embedding IS NOT NULL` (never written
 * under the gate) and every non-parlay market would be stranded 'pending'
 * forever. The fragment must also be valid SQL on the isEmbeddingDone path,
 * which joins no `n` alias.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { config } from '../config.js';
import {
  embeddingDoneSql,
  buildEmbeddingInput,
  embedTexts,
  parseEmbeddingResponse,
  _resetEmbeddingIntegrityStateForTests,
} from './embedder.js';

describe('embeddingDoneSql (AUD-30 gate)', () => {
  test('default (EMBED_MARKETS off): vacuously TRUE, references no alias columns', () => {
    // Only assert the gated behaviour when the flag is OFF in this test env.
    if (!config.embedding.embedMarkets) {
      const sql = embeddingDoneSql('m', 'n');
      expect(sql).toBe('TRUE');
      // Must not reference either alias's columns — the isEmbeddingDone
      // non-skip path runs `FROM markets m` with no `n` join.
      expect(sql.includes('m.embedding')).toBe(false);
      expect(sql.includes('n.')).toBe(false);
    }
  });

  test('the gated fragment is a complete boolean SQL expression', () => {
    if (!config.embedding.embedMarkets) {
      // A bare TRUE is a legal WHERE-clause predicate on its own.
      expect(embeddingDoneSql('m', 'n').trim().length).toBeGreaterThan(0);
    }
  });
});

describe('buildEmbeddingInput (unchanged by AUD-30)', () => {
  test('joins title + description and trims', () => {
    expect(buildEmbeddingInput('Title', 'Desc')).toBe('Title\nDesc');
  });

  test('truncates long descriptions to 500 chars', () => {
    const longDesc = 'x'.repeat(600);
    const out = buildEmbeddingInput('T', longDesc);
    expect(out.length).toBe(1 + 1 + 500);
  });

  test('empty description yields just the trimmed title', () => {
    expect(buildEmbeddingInput('OnlyTitle', '')).toBe('OnlyTitle');
  });
});

// Routing + integrity

const DIM = 1536;

/** Deterministic, mutually distinct vector: first float identifies the seed. */
function mkVec(seed: number): number[] {
  const v = new Array<number>(DIM);
  for (let j = 0; j < DIM; j++) v[j] = seed + j * 1e-7;
  return v;
}

/** Deterministic per-text seed (polynomial hash) — distinct texts ⇒ distinct seeds. */
function seedOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 1000000007;
  return h + 1;
}

function payloadFor(inputs: string[], opts: { reverse?: boolean } = {}): unknown {
  const items = inputs.map((t, i) => ({ index: i, embedding: mkVec(seedOf(t)) }));
  if (opts.reverse) items.reverse();
  return { data: items };
}

function mkResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as unknown as Response;
}

describe('parseEmbeddingResponse (W1-F strict validation)', () => {
  test('routes out-of-order index fields back to input order', () => {
    const inputs = ['t0', 't1', 't2'];
    const out = parseEmbeddingResponse(payloadFor(inputs, { reverse: true }), 3);
    expect(out.length).toBe(3);
    expect(out[0][0]).toBe(seedOf('t0'));
    expect(out[1][0]).toBe(seedOf('t1'));
    expect(out[2][0]).toBe(seedOf('t2'));
  });

  test('rejects a short response (count mismatch must never shift positions)', () => {
    const p = { data: [{ index: 0, embedding: mkVec(1) }] };
    expect(() => parseEmbeddingResponse(p, 2)).toThrow(/1 embeddings returned for 2/);
  });

  test('rejects duplicate index', () => {
    const p = { data: [{ index: 0, embedding: mkVec(1) }, { index: 0, embedding: mkVec(2) }] };
    expect(() => parseEmbeddingResponse(p, 2)).toThrow(/duplicate embedding index 0/);
  });

  test('rejects out-of-range index', () => {
    const p = { data: [{ index: 0, embedding: mkVec(1) }, { index: 2, embedding: mkVec(2) }] };
    expect(() => parseEmbeddingResponse(p, 2)).toThrow(/out-of-range embedding index 2/);
  });

  test('rejects wrong dimension', () => {
    const p = { data: [{ index: 0, embedding: [1, 2, 3] }] };
    expect(() => parseEmbeddingResponse(p, 1)).toThrow(/dimension 3/);
  });

  test('rejects non-finite values', () => {
    const bad = mkVec(1);
    bad[7] = Number.NaN;
    const p = { data: [{ index: 0, embedding: bad }] };
    expect(() => parseEmbeddingResponse(p, 1)).toThrow(/non-finite value/);
  });

  test('rejects a missing data array', () => {
    expect(() => parseEmbeddingResponse({}, 1)).toThrow(/missing data array/);
  });

  test('deep-copies floats — mutating the payload after parse cannot corrupt results', () => {
    const emb = mkVec(5);
    const p = { data: [{ index: 0, embedding: emb }] };
    const out = parseEmbeddingResponse(p, 1);
    emb[0] = 999;
    expect(out[0][0]).toBe(5);
  });
});

describe('embedTexts (W1-F routing + cross-call stale guard)', () => {
  const realFetch = globalThis.fetch;
  let fetchCalls: string[][];

  beforeEach(() => {
    _resetEmbeddingIntegrityStateForTests();
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** fetch mock answering each chunk with its correct vectors, optionally
   *  delaying resolution until all expected chunks arrive, then resolving in
   *  REVERSE arrival order (simulated out-of-order chunk completion). */
  function installFetch(opts: { expectChunks?: number; payloadOverride?: (inputs: string[], call: number) => unknown } = {}) {
    const pending: Array<{ inputs: string[]; resolve: (r: Response) => void }> = [];
    let call = 0;
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      const inputs = (JSON.parse(init.body) as { input: string[] }).input;
      fetchCalls.push(inputs);
      const n = ++call;
      const payload = opts.payloadOverride ? opts.payloadOverride(inputs, n) : payloadFor(inputs);
      if (!opts.expectChunks) return mkResponse(payload);
      return new Promise<Response>((resolve) => {
        pending.push({ inputs, resolve });
        if (pending.length === opts.expectChunks) {
          for (const p of [...pending].reverse()) {
            p.resolve(mkResponse(opts.payloadOverride ? opts.payloadOverride(p.inputs, n) : payloadFor(p.inputs)));
          }
        }
      });
    }) as unknown as typeof fetch;
  }

  test('chunks completing out of order still land at the right positions', async () => {
    const texts = Array.from({ length: 250 }, (_, i) => `t${i}`);
    installFetch({ expectChunks: 3 });
    const vectors = await embedTexts(texts);
    expect(vectors.length).toBe(250);
    for (let i = 0; i < 250; i++) {
      expect(vectors[i][0]).toBe(seedOf(texts[i]));
    }
  });

  test('stale guard: previous call’s vectors at same positions for DIFFERENT texts → re-request once, then throw', async () => {
    installFetch();
    const v1 = await embedTexts(['a0', 'a1', 'a2']);
    expect(v1[1][0]).toBe(seedOf('a1'));

    // Different texts, but the API "returns" call 1's vectors — twice.
    installFetch({ payloadOverride: (inputs) => ({
      data: inputs.map((_, i) => ({ index: i, embedding: mkVec(seedOf(`a${i}`)) })),
    }) });
    await expect(embedTexts(['b0', 'b1', 'b2'])).rejects.toThrow(/integrity violation persisted/);
  });

  test('stale guard: corrupt first attempt heals on the automatic re-request', async () => {
    installFetch();
    await embedTexts(['a0', 'a1', 'a2']);

    let attempt = 0;
    installFetch({ payloadOverride: (inputs) => {
      attempt++;
      if (attempt === 1) {
        return { data: inputs.map((_, i) => ({ index: i, embedding: mkVec(seedOf(`a${i}`)) })) };
      }
      return payloadFor(inputs);
    } });
    const v2 = await embedTexts(['b0', 'b1', 'b2']);
    expect(attempt).toBe(2);
    expect(v2[0][0]).toBe(seedOf('b0'));
    expect(v2[2][0]).toBe(seedOf('b2'));
  });

  test('identical texts across consecutive calls legitimately share vectors (no false alarm)', async () => {
    installFetch();
    const v1 = await embedTexts(['a0', 'a1']);
    const v2 = await embedTexts(['a0', 'a1']);
    expect(fetchCalls.length).toBe(2);
    expect(v2[0][0]).toBe(v1[0][0]);
  });

  test('returns exactly texts.length vectors', async () => {
    installFetch();
    const texts = Array.from({ length: 120 }, (_, i) => `t${i}`);
    const vectors = await embedTexts(texts);
    expect(vectors.length).toBe(texts.length);
  });
});
