import type { LLMProvider, LLMRequest, LLMResponse } from '@arb/types';
import { estimateCost } from '../tracker.js';
import { ApiError } from '../util/retry.js';
import { createLogger } from '@arb/logger';

const log = createLogger('ollama');

// Read lazily at call time so vars set after module load are picked up
// (e.g. from a --gemma-base-url CLI flag in the bench script).
// Accepts OLLAMA_ROOT_URL (no /v1 suffix) OR OLLAMA_BASE_URL (/v1 suffix).
function getOllamaRootUrl(): string {
  if (process.env.OLLAMA_ROOT_URL) return process.env.OLLAMA_ROOT_URL;
  if (process.env.OLLAMA_BASE_URL) return process.env.OLLAMA_BASE_URL.replace(/\/v1\/?$/, '');
  return 'http://localhost:11434';
}
function getOllamaNumCtx(): number { return parseInt(process.env.OLLAMA_NUM_CTX ?? '16384'); }
// CPU inference for larger models can take many minutes.
function getOllamaTimeoutMs(): number {
  return parseInt(process.env.OLLAMA_TIMEOUT_MS ?? String(20 * 60 * 1000));
}

// Node.js global fetch (undici under the hood) has a hard 300s bodyTimeout
// that fires independently of AbortSignal.timeout, killing slow CPU inference.
// IMPORTANT: global fetch() silently IGNORES the `dispatcher` option.
// The fix is to call undici.fetch() directly, which does accept it.
type FetchFn = (url: string, init: Record<string, unknown>) => Promise<Response>;
let _inferenceFetch: FetchFn | undefined;

async function getInferenceFetch(): Promise<FetchFn> {
  if (_inferenceFetch) return _inferenceFetch;
  try {
    // @ts-ignore — undici is a Node.js built-in; types not in devDeps
    const { fetch: undiciFetch, Agent } = await import('undici');
    // @ts-ignore
    const agent = new Agent({ bodyTimeout: 0, headersTimeout: 60_000 });
    // @ts-ignore
    _inferenceFetch = (url, init) => undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
  } catch {
    // undici unavailable — fall back to global fetch (300s bodyTimeout applies)
    _inferenceFetch = (url, init) => fetch(url, init as RequestInit);
  }
  return _inferenceFetch;
}

/**
 * Ollama / llama-server local inference provider.
 *
 * KEY BEHAVIOUR: Ollama caches the loaded model session. Once loaded at
 * num_ctx=4096 (the default), subsequent /v1 requests with a different
 * num_ctx are silently ignored. We fix this by calling /api/generate with
 * an empty prompt before the first inference — this forces Ollama to load
 * (or reload) the model at OLLAMA_NUM_CTX, then keep it loaded.
 * For llama-server the /api/ps warmup call fails silently and is skipped.
 *
 * Override via env vars:
 *   OLLAMA_ROOT_URL   (default: http://localhost:11434) — no /v1 suffix
 *   OLLAMA_BASE_URL   (alternative: http://localhost:11434/v1) — /v1 stripped
 *   OLLAMA_NUM_CTX    (default: 16384)
 *   OLLAMA_TIMEOUT_MS (default: 1200000 = 20 min)
 */
export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  readonly supportsStructuredOutput = true;
  readonly supportsEmbeddings = false;

  /** Tracks which (model, num_ctx) pairs have been warmed up this process. */
  private warmedUp = new Set<string>();

  /**
   * Ensures the model will be loaded at OLLAMA_NUM_CTX on the next inference.
   * Skips gracefully when /api/ps is unavailable (e.g. llama-server).
   */
  async ensureContext(model: string): Promise<void> {
    const numCtx = getOllamaNumCtx();
    const key = `${model}@${numCtx}`;
    if (this.warmedUp.has(key)) return;
    try {
      const psResp = await fetch(`${getOllamaRootUrl()}/api/ps`);
      if (psResp.ok) {
        const ps = await psResp.json() as { models?: Array<{ name: string; context_length: number }> };
        const loaded = ps.models?.find(
          m => m.name === model || m.name.split(':')[0] === model.split(':')[0],
        );
        if (!loaded) {
          this.warmedUp.add(key);
          log.info(`${model} not loaded; first call will load at num_ctx=${numCtx}`);
          return;
        }
        if (loaded.context_length === numCtx) {
          this.warmedUp.add(key);
          return;
        }
        log.info(`${model} loaded at ctx=${loaded.context_length}, need ${numCtx} — force-unloading`);
        const unload = await fetch(`${getOllamaRootUrl()}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false }),
        });
        if (unload.ok) await unload.json();
        log.info(`${model} unloaded; next /v1 call will load at num_ctx=${numCtx}`);;
      }
    } catch {
      // /api/ps unavailable — proceed anyway (llama-server path)
    }
    this.warmedUp.add(key);
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    await this.ensureContext(request.model);
    const start = Date.now();
    const rootUrl = getOllamaRootUrl();

    const body: Record<string, unknown> = {
      model: request.model,
      num_ctx: getOllamaNumCtx(),
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      temperature: request.temperature ?? 0.2,
      stream: false,
    };

    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const inferenceFetch = await getInferenceFetch();
    const resp = await inferenceFetch(`${rootUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ollama',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(getOllamaTimeoutMs()),
    }) as Response;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ApiError(resp.status, `Ollama ${resp.status}: ${text}`, null);
    }

    const completion = await resp.json() as Record<string, unknown>;
    const latencyMs = Date.now() - start;
    const choices = completion.choices as Array<{ message: { content: string } }> | undefined;
    const content = choices?.[0]?.message?.content ?? '';
    const usage = completion.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const costUsd = estimateCost(request.model, inputTokens, outputTokens);

    let parsed: unknown | undefined;
    if (request.responseFormat === 'json' && content) {
      parsed = this.tryParseJson(content);
    }

    return {
      content,
      parsed,
      usage: { inputTokens, outputTokens },
      model: (completion.model as string | undefined) ?? request.model,
      latencyMs,
      costUsd,
    };
  }

  private tryParseJson(text: string): unknown | undefined {
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return this.tryExtractJson(text);
    }
  }

  private tryExtractJson(text: string): unknown | undefined {
    if (!text) return undefined;
    const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock) {
      try { return JSON.parse(codeBlock[1]); } catch {}
    }
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      try { return JSON.parse(text.slice(braceStart, braceEnd + 1)); } catch {}
    }
    return undefined;
  }
}
