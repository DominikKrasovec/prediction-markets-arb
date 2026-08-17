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

export class OpenRouterProvider implements LLMProvider {
  readonly id = 'openrouter';
  readonly supportsStructuredOutput = true;
  readonly supportsEmbeddings = false;

  private client: OpenAI;

  constructor(private apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/prediction-markets-arb',
        'X-Title': 'prediction-markets-arb',
      },
    });
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
      max_tokens: request.maxTokens,
    };

    if (request.responseFormat === 'json') {
      params.response_format = { type: 'json_object' };
    }

    const completion = await withRetry(
      () => this.client.chat.completions.create(params).catch(wrapOpenAIError),
      { label: `openrouter/${request.model}` },
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
}
