/**
 * Unified entry point for structured-JSON chat-completion LLM calls.
 *
 * Replaces the ~50-line boilerplate that lived at every call site
 * (provider.complete + logLLMCall success branch + try/catch + logLLMCall
 * failure branch). Centralises:
 *   - prompt rendering
 *   - maxTokens sizing via TOKEN_PROFILES (see profiles.ts)
 *   - llm_logs persistence (success AND failure)
 *   - cost / latency capture
 *
 * Failure handling: this helper THROWS after logging the failure to llm_logs.
 * Callers that want "null on failure" wrap the call in try/catch (most current
 * callers already do — they keep their existing wrapper, just drop the body).
 *
 * Out of scope: embeddings (provider.embed) have their own path.
 */
import type { PipelineTask, PromptTemplate, LLMResponse } from '@arb/types';
import { getProvider } from './registry.js';
import { getTaskConfig } from './config.js';
import { renderPrompt } from './prompt-loader.js';
import { logLLMCall } from './tracker.js';
import { maxTokensFor } from './profiles.js';

export interface CallLLMOptions {
  task: PipelineTask;
  template: PromptTemplate;
  /** Variables for `renderPrompt(template.userTemplate, vars)`. */
  vars: Record<string, unknown>;
  /**
   * Workload size used by `maxTokensFor(task, items)`. Pass the count of
   * items in the batch (cluster size, batch size, etc.). Omit for
   * single-prompt sites — floor will be used.
   */
  items?: number;
  /** Copied into llm_logs.context for post-hoc analysis. */
  context?: Record<string, unknown>;
  /** Defaults to 0 (deterministic). */
  temperature?: number;
  /** Optional pipeline_run_id for llm_logs join. */
  pipelineRunId?: number;
}

export interface CallLLMResult<T> {
  parsed: T | null;
  response: LLMResponse;
}

export async function callLLM<T = unknown>(opts: CallLLMOptions): Promise<CallLLMResult<T>> {
  const { task, template, vars, items, context, temperature = 0, pipelineRunId } = opts;
  const config = getTaskConfig(task);
  const provider = getProvider(config.provider);
  const userPrompt = renderPrompt(template.userTemplate, vars);
  const maxTokens = maxTokensFor(task, items ?? 1);

  const start = Date.now();
  try {
    const response = await provider.complete({
      model: config.model,
      systemPrompt: template.systemPrompt,
      userPrompt,
      responseFormat: 'json',
      jsonSchema: template.schema,
      temperature,
      maxTokens,
    });

    // Auto-propagate cacheHitTokens into llm_logs.context when the provider
    // reports it (currently only DeepSeek). Lets `SELECT context->>'cacheHitTokens'`
    // work uniformly across call sites without each one wiring it manually.
    const cacheHitTokens = response.usage.cacheHitTokens;
    const fullContext = cacheHitTokens !== undefined
      ? { ...(context ?? {}), cacheHitTokens }
      : context;

    await logLLMCall({
      pipelineRunId,
      phase: task,
      provider: config.provider,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      latencyMs: response.latencyMs,
      costUsd: response.costUsd,
      success: true,
      context: fullContext,
    });

    return { parsed: (response.parsed ?? null) as T | null, response };
  } catch (err) {
    await logLLMCall({
      pipelineRunId,
      phase: task,
      provider: config.provider,
      model: config.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - start,
      costUsd: 0,
      success: false,
      error: String(err),
      context,
    });
    throw err;
  }
}
