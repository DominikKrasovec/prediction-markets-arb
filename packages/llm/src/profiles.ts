/**
 * Per-task tuning profiles for LLM chat-completion call sites.
 *
 *   TOKEN_PROFILES        — `maxTokens` sizing rule
 *   CONCURRENCY_PROFILES  — how many in-flight calls of this task to allow
 *
 * Profiles are the single source of truth; previously each call site
 * hard-coded its own `maxTokens` scalar (which caused the 2026-05-27
 * implication_cluster truncation incident — fixed 1200-token cap silently
 * truncated 50% of size-6+ clusters into invalid JSON).
 *
 * Env overrides:
 *   LLM_MAXTOKENS_<TASK>             — override floor; if items*perItem is
 *                                      larger, that still wins
 *   LLM_<TASK>_CONCURRENCY           — override default concurrency
 */
import type { PipelineTask } from '@arb/types';

/**
 * maxTokens = max(floor, items * perItem)
 *
 * `items` is the workload count the caller passes (e.g. cluster size, batch
 * size). Single-pair / single-prompt sites pass nothing → just `floor`.
 *
 * Sized empirically from llm_logs avg output tokens at each batch size.
 */
const TOKEN_PROFILES: Record<PipelineTask, { floor: number; perItem: number }> = {
  embedding:           { floor: 0,    perItem: 0    }, // unused — embeddings go through provider.embed()
  extraction:          { floor: 4000, perItem: 2000 }, // stage1: multi-entity markets generate 1.5-2k each
  implication:         { floor: 400,  perItem: 0    }, // stage3 pair phase: ~70-100 tok output
  implication_cluster: { floor: 2000, perItem: 500  }, // stage3 cluster phase: ~150 tok/pair × N*(N-1)/2 pairs
  edge_audit:          { floor: 1000, perItem: 200  },
  entity_enrichment:   { floor: 2000, perItem: 350  }, // ~250 tok per entity
  entity_merge_verify: { floor: 800,  perItem: 150  },
  regex_induction:     { floor: 1500, perItem: 0    }, // single-cluster prompt
  event_match:         { floor: 3000, perItem: 0    }, // stage3b: one event pair/call; outcome_set + leg_mapping can be large
};

/**
 * Default in-flight concurrency per task. Cluster phase was previously
 * sequential (1) — every call site that issues multiple LLM requests now
 * gets a real default.
 */
const CONCURRENCY_PROFILES: Record<PipelineTask, number> = {
  embedding:           2,  // EMBED_API_CONCURRENCY legacy
  extraction:          10, // LLM_EXTRACTION_CONCURRENCY legacy
  implication:         10, // LLM_IMPLICATION_CONCURRENCY legacy
  implication_cluster: 5,  // new — was sequential (1)
  edge_audit:          10,
  entity_enrichment:   4,  // ENTITY_ENRICHMENT_WORKERS legacy
  entity_merge_verify: 4,
  regex_induction:     4,
  event_match:         6,  // stage3b: one call per ANN candidate pair (spec §11.3 suggested 5–10)
};

/**
 * Returns the maxTokens cap to apply for `task` given `items` workload items.
 * Pass items=1 (or omit) for single-prompt sites.
 *
 * Env override `LLM_MAXTOKENS_<TASK>` raises the floor but never lowers the
 * computed value — safer default (env can only loosen the cap, never tighten
 * past what the workload needs).
 */
export function maxTokensFor(task: PipelineTask, items: number = 1): number {
  const profile = TOKEN_PROFILES[task];
  const envKey = `LLM_MAXTOKENS_${task.toUpperCase()}`;
  const envFloor = process.env[envKey] ? parseInt(process.env[envKey]!, 10) : 0;
  const floor = Math.max(profile.floor, envFloor);
  return Math.max(floor, items * profile.perItem);
}

/**
 * Returns the in-flight concurrency limit for `task`.
 *
 * Env override `LLM_<TASK>_CONCURRENCY` wins outright when set — used for
 * rate-limit tuning per environment without code change.
 */
export function concurrencyFor(task: PipelineTask): number {
  const envKey = `LLM_${task.toUpperCase()}_CONCURRENCY`;
  const envVal = process.env[envKey];
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return CONCURRENCY_PROFILES[task];
}
