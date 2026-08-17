import { getPool } from '@arb/db';
import type { LLMLogEntry } from '@arb/types';

// Pricing per 1M tokens, CACHE-AWARE TRIPLE: [cacheHitInput, cacheMissInput, output].
//
// Why a triple, not the old [input, output] pair: providers that serve a disk-
// cached prompt prefix bill the cached tokens at a tiny fraction of the miss
// rate. DeepSeek reports `prompt_cache_hit_tokens` (deepseek.ts:79) and 63.3% of
// run #231's input was cache hits — so a single blended input rate over-counts
// by ~4.5x (post-run ambers investigation item 4: stored $35.77 vs real $7.82
// billing; the [0.27,1.10] constant was 4.57x too high). The hit rate varies per
// run, so the cache split MUST be priced from the per-call hit count, not a
// blended constant.
//
// For providers with no cache tier (OpenAI, Ollama local) hitInput == missInput
// so cacheHitTokens makes no difference (and callers pass 0 anyway).
// Local Ollama models have zero marginal cost — listed as [0, 0, 0].
const PRICING: Record<string, [number, number, number]> = {
  'gpt-5.4-nano':             [0.20, 0.20, 1.25],
  'text-embedding-3-small':   [0.02, 0.02, 0],
  'text-embedding-3-large':   [0.13, 0.13, 0],
  // DeepSeek V4 Flash (verified June 2026): cache-hit $0.0028/M, cache-miss
  // (input) $0.14/M, output $0.28/M. Was [0.27, 1.10] — both wrong, and the
  // pair could not represent the cache-hit tier at all.
  'deepseek-v4-flash':        [0.0028, 0.14, 0.28],
  // Ollama local models (free)
  'gemma3:1b':                [0, 0, 0],
  'gemma3:4b':                [0, 0, 0],
  'gemma3:12b':               [0, 0, 0],
  'gemma4:e2b':               [0, 0, 0],
  'gemma4:e4b-unsloth':       [0, 0, 0],
  'gemma4:4b':                [0, 0, 0],
  'gemma4:12b':               [0, 0, 0],
  'gemma4-16k':               [0, 0, 0],
  'gemma4-16k:latest':        [0, 0, 0],
};

/**
 * Estimate the USD cost of one LLM call, pricing cache-hit input tokens at the
 * provider's discounted hit rate.
 *
 * `inputTokens` is the TOTAL prompt token count (matches DeepSeek's
 * `prompt_tokens`); `cacheHitTokens` is the subset of those served from the
 * prompt-prefix cache (`prompt_cache_hit_tokens`). The cache-miss portion is
 * `inputTokens - cacheHitTokens`. Pass `cacheHitTokens = 0` (the default) for
 * providers with no cache tier — then all input is priced at the miss rate,
 * which for those models equals the hit rate so the result is unchanged.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens = 0,
): number {
  const [hitInput, missInput, output] = PRICING[model] || [1.00, 1.00, 3.00];
  const hitTokens = Math.max(0, Math.min(cacheHitTokens, inputTokens));
  const missTokens = inputTokens - hitTokens;
  return (hitTokens * hitInput + missTokens * missInput + outputTokens * output) / 1_000_000;
}

export async function logLLMCall(entry: LLMLogEntry): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO llm_logs (pipeline_run_id, phase, provider, model, input_tokens, output_tokens, latency_ms, cost_usd, success, error, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.pipelineRunId ?? null,
      entry.phase,
      entry.provider,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.latencyMs,
      entry.costUsd,
      entry.success,
      entry.error ?? null,
      entry.context ? JSON.stringify(entry.context) : null,
    ]
  );
}
