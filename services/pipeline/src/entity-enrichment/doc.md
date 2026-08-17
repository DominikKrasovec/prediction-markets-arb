# pipeline/src/entity-enrichment/

Async LLM worker pool for entity knowledge-base (KB) enrichment. Classifies, deduplicates, and enriches entity records that were created during Stage 1 normalisation.

## Files

| File | Role |
|------|------|
| `index.ts` | `runEntityEnrichmentWorkers(opts)` — entry point. Starts a bounded pool of workers that drain the `entity_enrichment_queue` table. Supports `{ drainAndExit: true }` (batch mode) and continuous mode (daemon). |
| `worker.ts` | Single worker loop: claims a batch of pending queue rows, runs heuristic/probe/classify, then applies the result. Hosts the two KB-write functions: `prepareEnrichment(row, result)` (level-1 prepare/guard) and `applyEnrichment(row, result)` (canonical-swap + KB write). Marks rows done / skipped / failed. |
| `classify-client.ts` | Batches entity records and calls the LLM with a structured classification prompt. Returns `{ type, canonical_name, aliases, metadata }` per entity. |
| `entity-heuristic.ts` | Fast heuristic pre-filter before LLM: checks sport/league acronyms, crypto asset tickers, known provider names. Returns a match or `null`. |
| `merge.ts` | `mergeKnownEntities(keepId, dropId, updates?)` — collapses two `known_entities` rows into one in a single transaction (moves market links + relations, repoints `llm_market_normalizations` FKs, unions aliases, optionally promotes a corrected canonical, deletes the dropped row, rewrites `entity_category_counts`). Called by `merge-probe.ts` after the LLM verifier confirms a duplicate. |
| `merge-probe.ts` | Queries the entity KB for likely-duplicate entries (name similarity + same type), runs the histogram gate, and invokes the LLM verifier before calling `mergeKnownEntities`. |
| `entity-row-shared.ts` | Shared `BaseEntityRow` type + base SELECT/SQL fragments for the three entity-row loaders (`worker.ts` `loadEntities`/`loadEntitySnapshots`, `merge-probe.ts` candidate query) so a column added in one place can't silently drift from the others. |
| `__fixtures__/` | Static fixtures (`golden-markets.ts`, `enrichment-cases.ts`) used by the enrichment tests. |

## Processing flow per entity

```
entity_enrichment_queue row (worker.ts)
  │
  ├─ entity-heuristic.ts   → fast match? → apply + mark done
  │
  ├─ merge-probe.ts        → existing KB candidate? → histogram gate → LLM confirm → merge.ts mergeKnownEntities
  │
  ├─ classify-client.ts    → LLM classification → type + canonical_name + aliases
  │
  └─ worker.ts             → prepareEnrichment → applyEnrichment → KB write (registerEntities)
```

## Caveats
- Worker concurrency is controlled by `config.stage1.enrichmentWorkerCount`; set low on LLM-rate-limited environments.
- Heuristic matching is intentionally conservative — false positives here silently merge unrelated entities.
- `merge-probe.ts` uses DB name-similarity (trigram index); ensure `pg_trgm` extension is enabled.
- `merge-probe.ts` also runs the **KB category-histogram gate** (migration 029) before the LLM verifier call. When `KB_HISTOGRAM_GATE_MODE=enforce`, candidate pairs whose category distributions have no shared bucket above `KB_HISTOGRAM_GATE_MIN_MASS` are dropped before the LLM is invoked. `warn` mode logs the verdict but proceeds. Carve-outs: cold entities, dominant-category='other', and unclassified source markets always pass.
- `merge.ts` rewrites `entity_category_counts` inside the merge transaction (`mergeEntityCategoryCountsTx`) so per-entity histograms stay consistent with the link distribution after a merge collapses two entities.
- **Structural-rename propagation** — both `mergeKnownEntities` (merge.ts step 4b) AND `applyEnrichment`'s canonical-swap branch (worker.ts) rewrite `known_entities.metadata.league_canonical` / `metadata.sport_canonical` on every OTHER entity that referenced the old canonical name. Subject entities (team, person, organization, …) store the structural scope as text inside their metadata JSONB, NOT as a foreign key — so without this propagation, renaming "NBA" → "National Basketball Association" leaves every team's `metadata.league_canonical='NBA'` stale and the T1 scope filter (`_t1FromCache`) rejects the team from scoped lookups. Fires only when the renamed entity's `type` is `league` / `competition` / `sport`.
- **Text-reference propagation to `llm_market_normalizations` and `platform_events`** is NOT done inline by `mergeKnownEntities` or `applyEnrichment` — those tables are rewritten by `backfillSubjectsViaKB` (Stage 1f), which is the single chokepoint after every entity-enrichment phase. Inline propagation would re-warm the entire KB cache per merge; the once-per-Stage-1 backfill amortises it.
- Failed rows are retried up to `maxRetries` times; permanently failed rows remain in the queue with `status='failed'` for manual inspection.
- The `__fixtures__/` folder contains real entity examples from past runs — useful for debugging classification regressions.
