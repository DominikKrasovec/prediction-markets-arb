import type { PipelineTask, TaskModelConfig } from '@arb/types';

const DEFAULTS: Record<PipelineTask, TaskModelConfig> = {
  embedding:             { provider: 'openai',   model: 'text-embedding-3-small' },
  extraction:            { provider: 'deepseek', model: 'deepseek-v4-flash' },
  implication:           { provider: 'deepseek', model: 'deepseek-v4-flash' },
  implication_cluster:   { provider: 'deepseek', model: 'deepseek-v4-flash' },
  edge_audit:            { provider: 'deepseek', model: 'deepseek-v4-flash' },
  entity_enrichment:     { provider: 'deepseek', model: 'deepseek-v4-flash' },
  entity_merge_verify:   { provider: 'deepseek', model: 'deepseek-v4-flash' },
  regex_induction:       { provider: 'deepseek', model: 'deepseek-v4-flash' },
  // Stage 3b cross-platform event matcher (event-centric rewire). Reuses the
  // same DeepSeek model as extraction/implication so it shares the provider's
  // retry + prompt-cache stack.
  event_match:           { provider: 'deepseek', model: 'deepseek-v4-flash' },
};

export function getTaskConfig(task: PipelineTask): TaskModelConfig {
  const envPrefix = `LLM_${task.toUpperCase()}`;
  return {
    provider: process.env[`${envPrefix}_PROVIDER`] || DEFAULTS[task].provider,
    model:    process.env[`${envPrefix}_MODEL`]    || DEFAULTS[task].model,
  };
}
