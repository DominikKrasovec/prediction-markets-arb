import OpenAI from 'openai';
import type { LLMProvider, LLMRequest, LLMResponse } from '@arb/types';
import { estimateCost } from '../tracker.js';
import { withRetry, ApiError } from '../util/retry.js';
import { embeddingLimiter } from '../util/rate-limiter.js';

/** Convert openai SDK errors to ApiError so withRetry can inspect the status */
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

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';
  readonly supportsStructuredOutput = true;
  readonly supportsEmbeddings = true;

  private client: OpenAI;

  constructor(private apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ];

    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      messages,
      temperature: request.temperature ?? 0.2,
      max_completion_tokens: request.maxTokens,
    };

    if (request.responseFormat === 'json' && request.jsonSchema) {
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: false,
          schema: request.jsonSchema,
        },
      };
    } else if (request.responseFormat === 'json') {
      params.response_format = { type: 'json_object' };
    }

    const completion = await withRetry(
      () => this.client.chat.completions.create(params).catch(wrapOpenAIError),
      { label: `openai/${request.model}` },
    );

    const latencyMs = Date.now() - start;
    const content = completion.choices[0]?.message?.content ?? '';
    const usage = completion.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const costUsd = estimateCost(request.model, inputTokens, outputTokens);

    let parsed: unknown | undefined;
    if (request.responseFormat === 'json' && content) {
      try {
        parsed = JSON.parse(content);
      } catch {
        // Return raw content if JSON parsing fails
      }
    }

    return {
      content,
      parsed,
      usage: { inputTokens, outputTokens },
      model: completion.model,
      latencyMs,
      costUsd,
    };
  }

  async embed(texts: string[], model = 'text-embedding-3-small'): Promise<number[][]> {
    // Route through the SHARED embedding limiter so these (Stage 2a entity
    // resolver) calls coordinate concurrency + 429 backoff with the raw-fetch
    // embed path (embedTexts) — they hit the same account rate-limit bucket.
    const response = await embeddingLimiter.run(
      () => this.client.embeddings.create({ model, input: texts }).catch(wrapOpenAIError),
      { label: `openai-embed/${model}` },
    );

    return response.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}
