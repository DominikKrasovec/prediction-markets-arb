/** LLM Layer — Provider, request, response types */

export interface LLMProvider {
  readonly id: string;
  readonly supportsStructuredOutput: boolean;
  readonly supportsEmbeddings: boolean;
  complete(request: LLMRequest): Promise<LLMResponse>;
  embed?(texts: string[], model?: string): Promise<number[][]>;
}

export interface LLMRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseFormat?: 'json' | 'text';
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  reasoningContent?: string;
  parsed?: unknown;
  usage: TokenUsage;
  model: string;
  latencyMs: number;
  costUsd: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
}

export type PipelineTask = 'embedding' | 'extraction' | 'implication' | 'implication_cluster' | 'edge_audit' | 'entity_enrichment' | 'entity_merge_verify' | 'regex_induction' | 'event_match';

export interface TaskModelConfig {
  provider: string;
  model: string;
}

export interface LLMLogEntry {
  pipelineRunId?: number;
  phase: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  success: boolean;
  error?: string;
  context?: Record<string, unknown>;
}

export interface PromptTemplate {
  systemPrompt: string;
  userTemplate: string;
  schema?: Record<string, unknown>;
  examples?: unknown[];
  contentHash: string;
}
