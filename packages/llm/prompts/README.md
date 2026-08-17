# packages/llm/prompts/

Prompt templates for every LLM task in the pipeline. Each subdirectory holds the
system prompt, user template, and (optionally) examples for one task. Templates
are loaded by `loadPromptTemplate(dir)` and rendered per call with
`renderPrompt(template, vars)` (Mustache, with HTML-escaping disabled so titles
with `"`/`/`/`&` pass through verbatim).

## Files per task

| File | Purpose |
|------|---------|
| `system.md` | System prompt: the LLM's role, constraints, and output contract. |
| `user-template.md` | User message with `{{variable}}` Mustache placeholders. |
| `schema.json` | **Fallback** JSON Schema for structured output. Only used when the task is *not* in `RUNTIME_SCHEMAS` (`src/schemas.ts`); for tasks that are (extraction, implication, implication-cluster, entity_enrichment, …) the runtime schema derived from `@arb/types` const arrays wins and the on-disk file is ignored. See `src/prompt-loader.ts:48` + `src/schemas.test.ts`. |
| `examples.json` | Few-shot examples (optional). |
| `rubric.md` | Supplementary reference notes (only `implication/` has one). **Not** auto-loaded by `loadPromptTemplate` — purely documentation for prompt authors. |

## Subdirectories (one per task)

Loader key = directory name passed to `loadPromptTemplate(...)`. Model/provider per task is configured separately in `src/config.ts` (env `LLM_<TASK>_*`).

- **extraction/** — Stage 1b per-market normalization (`llm-normalizer.ts`). Extracts `canonical_subject`, resolved entities, and the condition taxonomy (`condition_shape/direction/metric`, `value_*`, `temporal_semantics`, `condition_date`, `resolution_source`). Feeds the `canonical_key` used for Stage 2 grouping.
- **implication/** — Stage 3 focused pair validation (`llm-implication.ts`). One relationship per pair (`equivalent`, `strict_implication_AtoB/BtoA`, `conditional`, `mutual_exclusion`, `independent`) with confidence; verdicts ≥ `LLM_IMPLICATION_MIN_CONFIDENCE` (default 0.70) become edges via `upsertLLMEdge`.
- **implication-cluster/** — Stage 3 clustered implication (`llm-cluster.ts`). Batches unclassified pairs sharing a topic cluster into a single call (more token-efficient than pairwise).
- **entity_enrichment/** — Entity-KB classification (`entity-enrichment/worker.ts`). Returns type / canonical name / aliases / metadata for queued entities.
- **entity_merge_verify/** — Entity-KB merge verifier (`entity-enrichment/merge-probe.ts`). Confirms whether two candidate KB rows are the same real-world entity before `mergeKnownEntities`.
- **regex_induction/** — Used by `scripts/induce-regex-patterns.ts` to propose new deterministic-template regexes from sampled titles.
- **edge-audit/** — Edge-audit task prompt (`edge_audit` in `config.ts`).

> The old `grouping/` and `logical-rules/` prompt folders were removed when
> Stage 2 switched to hash-key canonical grouping (no LLM) and Stage 3 adopted
> the rule-engine + pair-LLM architecture.
