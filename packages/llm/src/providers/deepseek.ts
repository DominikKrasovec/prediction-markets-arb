import OpenAI from 'openai';
import type { LLMProvider, LLMRequest, LLMResponse } from '@arb/types';
import { estimateCost } from '../tracker.js';
import { withRetry, ApiError } from '../util/retry.js';

function wrapOpenAIError(err: unknown): never {
  if (err instanceof OpenAI.APIError) {
    const retryAfter = err.headers?.['retry-after'] ?? null;
    throw new ApiError(
      err.status,
      err.message,
      typeof retryAfter === 'string' ? parseInt(retryAfter, 10) * 1000 || null : null,
    );
  }
  throw err;
}

export class DeepSeekProvider implements LLMProvider {
  readonly id = 'deepseek';
  readonly supportsStructuredOutput = true;
  readonly supportsEmbeddings = false;

  private client: OpenAI;

  constructor(private apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.deepseek.com',
    });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();

    const isReasoner = request.model.includes('reasoner');

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ];

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
    };
 
    if (!isReasoner) {
      params.temperature = request.temperature ?? 0.2;
    }

    if (request.responseFormat === 'json') {
      params.response_format = { type: 'json_object' };
    }

    // deepseek-v4-flash defaults to thinking (chain-of-thought) mode.
    // For extraction / implication tasks we don't need CoT — disable it
    // so that (a) the system-prompt prefix is stable for disk-cache hits,
    // (b) latency is halved, and (c) output tokens are not wasted on reasoning.
    // Reasoner models keep thinking enabled.
    const finalParams = isReasoner
      ? params
      : { ...params, thinking: { type: 'disabled' } };

    const completion = await withRetry(
      () => this.client.chat.completions.create(finalParams as OpenAI.ChatCompletionCreateParamsNonStreaming).catch(wrapOpenAIError),
      { label: `deepseek/${request.model}` },
    );

    const latencyMs = Date.now() - start;
    const message = completion.choices[0]?.message as any;
    const content: string = message?.content ?? '';
    // V3.2 puts chain-of-thought in reasoning_content
    const reasoningContent: string = message?.reasoning_content ?? '';
    const usage = completion.usage as any;
    const inputTokens: number = usage?.prompt_tokens ?? 0;
    const outputTokens: number = usage?.completion_tokens ?? 0;
    // DeepSeek returns prompt_cache_hit_tokens for disk-cached prefix hits.
    const cacheHitTokens: number = usage?.prompt_cache_hit_tokens ?? 0;
    // Price the cache-hit subset at the discounted hit rate (V4-Flash hit
    // $0.0028/M vs miss $0.14/M). inputTokens is the TOTAL prompt count; the
    // miss portion is inputTokens - cacheHitTokens. Without this the stored
    // cost over-counts ~4.5x (63.3% of #231 input was cache hits).
    const costUsd = estimateCost(request.model, inputTokens, outputTokens, cacheHitTokens);

    let parsed: unknown | undefined;
    if (request.responseFormat === 'json') {
      // Try content first, then fall back to extracting JSON from reasoning
      parsed = this.tryParseJson(content) ?? this.tryExtractJson(reasoningContent);
    }

    return {
      content: content || reasoningContent,
      reasoningContent: reasoningContent || undefined,
      parsed,
      usage: { inputTokens, outputTokens, cacheHitTokens },
      model: completion.model,
      latencyMs,
      costUsd,
    };
  }

  private tryParseJson(text: string): unknown | undefined {
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      // Try extracting JSON from markdown code blocks
      return this.tryExtractJson(text);
    }
  }

  private tryExtractJson(text: string): unknown | undefined {
    if (!text) return undefined;
    // Look for JSON in code blocks first
    const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock) {
      try { return JSON.parse(codeBlock[1]); } catch {}
    }
    // Look for first { ... } block
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      try { return JSON.parse(text.slice(braceStart, braceEnd + 1)); } catch {}
    }
    return undefined;
  }
}
