# arb-solver/src/graph/

Loads the constraint graph from Postgres and builds the BFS cluster structure that the solver operates on.

## Files

| File | Role |
|------|------|
| `types.ts` | Core graph types: `QuestionNode` (one question + its concrete markets), `MarketRef` (a market within a question), `OutcomeSetRef` (a set of slot questions — `setType` ∈ `categorical` / `threshold_series` / `tournament` / `bundle`, with an `isExhaustive?` flag meaningful only for `categorical`: true ⟹ Σ=1 one-hot, false/absent ⟹ Σ≤1 with an all-FALSE world), `EdgeRef` (directed implication edge between questions), `Cluster` (connected component), `WorldState` (one full resolution assignment), `ConstraintGraph`. |
| `loader.ts` | `loadConstraintGraph(minEdgeConfidence = 0.70)` — queries the DB for open questions + their open market members, active implication edges above the confidence threshold, and outcome sets with slots; assembles a `ConstraintGraph`. (Periodic reload is driven by `reloadGraph()` in `index.ts`, which calls this.) |
| `cluster-builder.ts` | `buildClusters(graph, opts?)` — BFS over connected components, where two questions are connected if they share an implication edge **or** belong to the same outcome set → `Cluster[]`. `opts.clusterSizeCap` (from `config.solver.clusterSizeCap`) drives a warn-only "explosion-prone" flag and a Union-Find bridge log (genuine multi-node merges only); both are observability — component membership / merge behavior is unchanged. `buildMarketIndex(clusters)` → `Map<marketId, Cluster>` for O(1) cluster lookup on price update. |

## Key types

```typescript
interface ConstraintGraph {
  questions: Map<number, QuestionNode>;
  outcomeSets: OutcomeSetRef[];
  edges: EdgeRef[];
}

interface Cluster {
  id: number;
  questions: Map<number, QuestionNode>; // questions in this component
  outcomeSets: OutcomeSetRef[];         // intra-cluster outcome sets
  edges: EdgeRef[];                     // intra-cluster edges
  marketIds: Set<number>;               // all concrete markets in the cluster
  validStates: WorldState[];            // precomputed by state-enumerator
  dirty: boolean;
}
```

## Caveats
- `loadConstraintGraph` issues the 3 core read-only SQL queries (questions, edges, outcome-sets) — plus a one-time `information_schema` column-exists self-check (GATE-0, below) — and only loads non-archived questions / non-resolved markets / non-archived edges (cheap via the migration-017 partial indexes). The question query also gates on `end_date > now()` (immediate liveness fallback when `resolved_at` is unwritten) so settled fixtures cannot enter Ω.
- **GATE-0 fail-safe**: the loader reads `outcome_sets.is_exhaustive` (migration 061) to decide Σ=1 (provably exhaustive one-hot) vs Σ≤1 (mutual exclusion only, all-FALSE world enumerated) for categorical sets. If the column is ABSENT (migration unapplied) it fails SAFE — selects a literal `FALSE` so every categorical set is treated as Σ≤1 (the only direction that cannot manufacture a fake buy-all-YES arb). A NULL/absent value likewise defaults to non-exhaustive (`isExhaustive ?? false`); migration 070 flips the column DEFAULT to FALSE so the DB agrees.
- Low-confidence edges are filtered at load time (`minEdgeConfidence` from config) to prevent the state enumerator from producing zero valid states.
- `reloadGraph()` (defined in `index.ts`, not here) is polled every 60 s against the event bus' `pipeline / graph_updated` signal; between reloads the graph may lag new pipeline output — acceptable at this interval.
- Very large clusters produce a combinatorial explosion in `enumerateStates`; the enumerator caps at `opts.maxStates` (now wired from `config.solver.maxStates`, env `MAX_VALID_STATES`, default `10_000`) and skips the cluster with a **structured DROP diagnostic** (cluster id, question/free counts, `cause=free-2^n|cartesian`, projected size, per-set breakdown) plus a bundle/tournament `DROP-PREVIEW` warn. Opt-less calls fall back to the `MAX_VALID_STATES` default, so the historical behavior is byte-identical.
