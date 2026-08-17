# Hybrid-retrieval benchmark

Does adding a **lexical** retriever alongside the **dense** (embedding) one improve
candidate generation for our matching layers? This folder measures it — *before*
we change any production code.

- **Status:** prototype / measurement only. Nothing here touches production tables
  or schema. All DB access is `SELECT`-only; the lexical index is built in a
  session `TEMP` table that auto-drops. Safe to run while the pipeline is running.
- **Harness:** [`bench.ts`](./bench.ts) — run with `npx tsx`.
- **Results:** written to `results-<mode>-<timestamp>.{json,md}` in this folder,
  and summarised in the [Results](#results) table below.

---

## The question

Our matching is **dense-primary** in some stages and **lexical-only** in others
(see the architecture note in the conversation that spawned this):

| Stage | Candidate generation today | Lean |
|---|---|---|
| Subject resolve (Tier-2) | dense kNN over `entity_subjects.embedding` | dense |
| Cross-platform event match (Stage 3a) | dense HNSW kNN over `platform_events.embedding` | dense |
| Entity merge-probe / dedup | surface-eq + alias + `stems_tsv @@` (boolean) | **lexical-only** |

Dense and lexical fail in *opposite* directions:

- **dense** bridges paraphrase / spelling drift / acronyms ("Man Utd" ≈ "Manchester
  United", "Tipico Bundesliga" ≈ "Austrian Bundesliga") but can bury rare proper
  nouns, tickers, and numbers below the cosine floor.
- **lexical** nails exact rare-token overlap and out-of-vocabulary names but scores
  zero when there's no shared token.

**Hybrid retrieval** = run both, fuse the ranked lists (Reciprocal-Rank Fusion),
and feed the union to the (unchanged) LLM verifier. The bet is that the union
recovers true matches that either method alone misses, at ~no extra latency
(lexical is cheaper than the embedding call we already make).

---

## What we measure

This is a **candidate-retrieval** evaluation, *not* an end-to-end decision
evaluation. The LLM verifier downstream is the precision backstop — it can only
confirm a match that retrieval first surfaced. So we measure how well each method
puts the true counterpart in the top-`k` candidate set, and how much noise it adds.

No LLM is called. Three methods on the same query set / same `k`:

- `dense`   — embedding cosine kNN (HNSW), as deployed.
- `lexical` — Postgres FTS `ts_rank_cd(to_tsvector('english', text), plainto_tsquery(query))`.
  This is the ranked form of the `stems_tsv` we already store; deployable with no
  new infra. (True BM25 — via the ParadeDB/`pg_search` extension — would be a small
  further gain; noted but not required to prove the point.)
- `hybrid`  — Reciprocal-Rank Fusion: `score(d) = Σ_lists 1/(k0 + rank_list(d))`,
  `k0 = 60` (the standard default), re-ranked.

### Metrics

| Metric | What it tells us |
|---|---|
| **Recall@k** (k = 1, 5, 10, 20) | Fraction of queries whose true match is in the top-k. The ceiling on what the LLM can ever confirm. |
| **MRR** | Mean reciprocal rank of the first true match. Rewards ranking truth high enough to survive the `LIMIT`. |
| **FP@k** | Mean number of *wrong* candidates in the top-k = proxy for wasted LLM-verifier calls. Hybrid must not balloon this. |
| **Lexical-blind-spot rescue** | On queries where `lexical` misses at k=20, the Recall@20 of `dense`/`hybrid`. This is the exact size of the merge-probe blind spot — the headline number for adding dense to the lexical-only dedup. |
| **Dense-blind-spot rescue** | On queries where `dense` misses at k=20, the Recall@20 of `lexical`/`hybrid`. Sizes the value of adding lexical to the dense-only event matcher. |
| **Net-new / net-loss** | Count of queries `hybrid` finds that `lexical` doesn't (gain) and that `dense` does but `hybrid` doesn't (loss; should be ≈0). |

### How the query set + ground truth are built

**Ground truth is the already-curated KB** — no manual labelling.

- **Entity substrate (`entity_subjects`, runnable now):** every row maps a
  `subject_text` → a `canonical_subject` (a confirmed resolution produced by Tier-1
  alias lookup, Tier-2 embedding, or manual merge). Two rows with the same
  `canonical_subject` (+ domain) are the *same real-world entity*.
  - Eligible queries = rows whose canonical has **≥2 distinct `subject_text`s** in
    its domain (so a correct target exists once we exclude the query row itself).
  - Leave-one-out: the query row is excluded from the index; a retrieved row is
    **correct** iff its `canonical_subject` equals the query's (diacritic/case-folded).
  - This mirrors the live task exactly: "a new market phrasing arrives — does it
    resolve to the right canonical?"

- **Event substrate (`platform_events` + `semantic_event_platforms`, phase 2):**
  needs `platform_events.embedding` populated (Stage 2c — embedding in progress at
  time of writing). Confirmed cross-platform siblings = `platform_events` sharing a
  `semantic_event_id`. Query = one platform-event; correct = a retrieved
  *cross-platform* event in the same `semantic_event_id`.

### Mechanics / fairness notes

- **dense** runs against the real table's HNSW index (`enable_seqscan=off`,
  `hnsw.ef_search=100` for near-exact top-k). Domain/platform scoping replicates the
  production filters.
- **lexical** runs against a session `TEMP` copy with a GIN index on
  `to_tsvector('english', …)` — the real Snowball stemmer, the same one behind
  `stems_tsv`. The TEMP table keeps the benchmark from adding any column to a live
  table and auto-drops at disconnect.
- Both retrievers return up to `K_RETRIEVE = 50`; metrics are evaluated at
  k ∈ {1,5,10,20}. Fusion happens over the union by the row's stable key
  (`subject_text` for entities, `id` for events).
- Sampling is deterministic (`ORDER BY md5(key)`) so re-runs are comparable.

---

## How to run

```bash
# sanity: substrate sizes, embedding progress, label counts
npx tsx data/hybrid-retrieval-benchmark/bench.ts stats

# entity-resolution benchmark (runnable now; ~500-query sample by default)
npx tsx data/hybrid-retrieval-benchmark/bench.ts entity --sample 500

# event-matching benchmark (phase 2 — needs platform_events.embedding populated)
npx tsx data/hybrid-retrieval-benchmark/bench.ts events --sample 500
```

Connection uses the same `PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD` env vars
(and `.env`) as `@arb/db`, with the same local-dev defaults.

---

## Results

> Filled in by running the harness. Each run also drops a timestamped
> `results-*.md` / `.json` next to this file with the full per-method tables.

### Entity resolution — `entity_subjects` smoke test (2026-06-01, n=165)

⚠️ **Biased/thin substrate — directional only.** `entity_subjects` has just 81
canonicals with ≥2 surface forms (165 rows). Those multi-variant rows are exactly
the ones Tier-2 *embedding* resolved (that's how they were written), so `dense` is
graded on its home turf. Treat as a harness smoke test, not the verdict.

| method | R@1 | R@5 | R@10 | R@20 | MRR | FP@10 |
|---|---|---|---|---|---|---|
| dense | 100.0% | 100.0% | 100.0% | 100.0% | 1.000 | 8.95 |
| lexical | 44.8% | 46.7% | 46.7% | 46.7% | 0.458 | 0.12 |
| hybrid | 95.8% | 100.0% | 100.0% | 100.0% | 0.977 | 8.95 |

- Lexical misses @20: 88/165 (53.3%) → rescued by dense **100%**, by hybrid **100%**.
- Dense misses @20: 0/165 → dense never fails on this (self-selected) set.
- Net-new (hybrid hits, lexical misses): 88. Net-loss (dense hits, hybrid misses): 0.
- Read: dense dominates on paraphrase/drift (expected, given how the rows were
  selected); lexical is low-recall but ~75× more precise (FP@10 0.12 vs 8.95) — the
  complement profile that motivates hybrid rather than replacement.

### Entity resolution — `known_entities` (representative, 2026-06-01, n=2410)

Unbiased substrate: leave-one-out over entities with ≥2 surface forms, name
embeddings (`text-embedding-3-small`) persisted in the isolated table
`bench_known_entity_forms`. Correct iff a retrieved form belongs to the same
`entity_id`. This is the real test of the lexical-only merge-probe/dedup blind spot.

| method | R@1 | R@5 | R@10 | R@20 | MRR | FP@10 |
|---|---|---|---|---|---|---|
| dense | 28.7% | 52.8% | 65.2% | **76.4%** | 0.402 | 8.25 |
| lexical | 8.4% | 9.0% | 9.3% | **9.3%** | 0.087 | 0.38 |
| hybrid | 29.9% | 54.3% | 65.9% | **76.4%** | 0.416 | 8.21 |

- **Lexical blind spot:** lexical misses **90.7%** (2186/2410) of true pairs @20;
  dense rescues **74.9%** of those, hybrid **74.0%**. Net-new (hybrid hits, lexical
  misses): **1617**.
- **Lexical adds ~nothing on top of dense:** dense misses @20 = 23.6% (569);
  lexical rescues only **3.5%** of them; hybrid the same 3.5%. Net-loss (dense hits,
  hybrid misses): **20** — RRF re-ranking demotes some dense hits.
- **Conclusion for this layer:** the win is *adding a dense candidate leg*, not RRF
  fusion. Dense alone ≈ hybrid on recall, simpler, and avoids the 20 net-losses.

**Caveats (honest):**
- The benchmark's `lexical` is vanilla FTS (`ts_rank_cd` on the single held-out
  form). Production merge-probe lexical also has exact-alias equality + an acronym
  bridge (`looksLikeAcronymOf`) + multi-alias surface expansion, so real lexical
  recall is somewhat above 9.3% (mostly on acronym-shaped cases). The dense
  advantage is still large; treat 9.3% as a floor, not the exact production number.
- `dense` uses isolated name embeddings (canonical/alias text only) — exactly what a
  merge-probe dense leg would use, so this is faithful to the proposed change.
- HNSW `ef_search=100` over ~25k rows ≈ exact for top-50; ANN approximation is not a
  material confound here.

> Cleanup when done: `DROP TABLE bench_known_entity_forms;` (isolated; nothing else
> references it).

### Entity resolution — `known_entities` + **TF-IDF** (2026-06-02, n=5000) — ⭐ SUPERSEDES above

After a KB reseed (now 3,929 entities with ≥2 aliases). Added classic **TF-IDF
cosine** as a distinct lexical method (the prior "lexical" was Postgres `ts_rank_cd`,
relabeled `fts`). `hybrid` = RRF(dense + tfidf).

| method | R@1 | R@5 | R@10 | R@20 | MRR | FP@10 |
|---|---|---|---|---|---|---|
| dense | 46.3% | 71.5% | 78.0% | 83.0% | 0.574 | 8.63 |
| fts (ts_rank_cd) | 24.7% | 32.1% | 33.4% | 34.0% | 0.280 | 1.00 |
| **tfidf** | 54.6% | 80.1% | 84.2% | **86.7%** | 0.656 | 5.64 |
| **hybrid (dense+tfidf)** | 50.8% | 79.2% | 85.2% | **89.0%** | 0.631 | 8.50 |

- **TF-IDF beats dense** on recall (86.7% vs 83.0%) AND precision (FP@10 5.64 vs
  8.63). The earlier "lexical is hopeless" was an **artifact of `ts_rank_cd`** (34%) —
  classic TF-IDF cosine is a different, far stronger method. The user's original
  instinct to ask about TF-IDF specifically was correct.
- **dense ↔ tfidf are genuinely complementary:** tfidf rescues **50.6%** of dense's
  @20 misses; dense rescues **36.9%** of tfidf's. So a true hybrid IS justified here
  (unlike the dense+fts hybrid, which added ~nothing). Hybrid R@20 **89.0%** = best.
- Hybrid deltas: vs dense net-new **351** / net-loss 52; vs tfidf net-new 204 /
  net-loss 90 (RRF demotes some tfidf hits — a cost of fusion).

**Discrepancy analysis — which detections are better** (from `discrepancies-ke-*.md`):

- **dense uniquely wins** on zero-token-overlap semantics: cross-language
  (`moderaterna`→`moderate party`, `fuerza del pueblo`→`people's force`),
  ticker↔name (`xmr`→`monero`, `coinbase global inc.`→`coin`), pure acronyms
  (`canadian football league`→`cfl`). TF-IDF *structurally cannot* find these (no
  shared token → score 0). These detections are dense's irreplaceable value.
- **tfidf uniquely wins** on shared-token cases dense's geometry buries — especially
  **numbered entities** (`ny-10`/`tx-24`/`ok-02` districts), where dense returns
  adjacent districts at higher cosine (the numeric-disambiguator failure the pipeline
  currently patches with hand-written numeric guards). Also nicknames/org names:
  `roma`→`as roma` (dense returned `ra`,`reds`), `fever`→`indiana fever`.
- **fts (ts_rank_cd) is the loser** — in almost every disagreement it returns
  `(none)` or wrong same-suffix rows while tfidf finds the truth. Do **not** use FTS
  ranking as the lexical method.
- **Side-finding (⚠️ corrected by `kbaudit` below):** the "suspected duplicate"
  bucket surfaced same-text candidates under different `entity_id`s
  (`tx-14`, `universitatea cluj`, `o'higgins`, …). Initial read was "KB dups survive";
  the `kbaudit` verification (next section) shows that at the **canonical+scope level
  0 are true dups** — they are legit same-name-different-scope entities or
  ambiguous aliases. A handful (`universitatea cluj`) are *alias-level* near-dups the
  canonical check can't see. The LLM verifier still arbitrates these.

**Revised conclusion (supersedes the n=2410 block):** for entity dedup the strongest
single leg is **TF-IDF**, not dense and certainly not FTS. Build the merge-probe
candidate union as **TF-IDF + dense** (they cover disjoint failure modes); FTS
ranking is not worth adding. TF-IDF needs no embeddings/API — deployable via an
in-app index or a Postgres BM25 extension (ParadeDB/`pg_search`).

**Caveats:** TF-IDF here is folded raw tokens, no stemming, IDF = ln(1+N/df), cosine,
domain-scoped, built in JS over name strings. This is a name-matching substrate
(short strings) where rare-token IDF ≈ the entity signal; on longer text
(events/markets) the dense/lexical balance may shift — measure separately. HNSW
`ef_search=100` ≈ exact for top-50.

### Verification + char-3gram experiment (2026-06-02, n=5000)

Added a **char-3gram TF-IDF** method + a 3-way hybrid, and an audit of label quality.
Run `npx tsx …/bench.ts kbaudit` for the structural dup check.

| method | R@20 | MRR | FP@10 |
|---|---|---|---|
| dense | 83.0% | 0.574 | 8.63 |
| fts (ts_rank_cd) | 34.0% | 0.280 | 1.00 |
| tfidf (word) | 86.7% | 0.656 | 5.64 |
| tfidf_char (3gram) | 85.1% | 0.628 | 8.47 |
| **hybrid (dense+word-tfidf)** | **89.0%** | 0.631 | 8.50 |
| hybrid3 (dense+word+char) | 88.5% | 0.641 | 8.53 |

- **char-3gram TF-IDF ≈ word TF-IDF (85.1% vs 86.7%) but noisier** (FP@10 8.47 vs
  5.64). Adding it to the hybrid **does not help**: hybrid3 88.5% < hybrid 89.0%
  (vs hybrid: net-new 66, net-loss 93 — RRF noise from the 3rd list displaces hits).
  **Verdict: char-ngram is a reasonable idea but not worth adding; dense + word-TFIDF
  stays the best combo.** (A negative result, but a clean one.)

**Label-verification audit** (does the KB ground truth actually hold?):
- `kbaudit`: 163 canonical-name collisions, **0 same-scope** (all scope-differentiated,
  legit per the `(canonical, sport, league)` unique constraint). Surface forms shared
  across >1 entity: **1,426 / 31,380 (4.5%)** — ambiguous aliases + alias-level near-dups.
- per-query: **11.8%** of queries have a held-out form shared by ≥2 entities (inherent
  ambiguity); dense's top-1 is an exact-text twin of a *different* entity on **576**
  queries (these are scope/ambiguity, not bugs); only **109** of the best method's 576
  misses are "label-induced" (form has a twin) → **measured recall underestimates true
  recall by ≤~2pp**, and the method *ranking* is unaffected.
- **What's detected vs not:** the ~11% the best hybrid still misses are (a) genuine
  hard cases — nicknames with no shared token/weak semantics (`pens`→`pittsburgh
  penguins`), obscure acronyms; and (b) the ~2pp label-noise cases above. Everything
  with shared rare tokens (word-TFIDF), morphology/substring (char), or
  paraphrase/translation/ticker/acronym (dense) is caught.

**Still unmeasured / next sensible experiment — KB-scope filtering.** dense/tfidf drag
8.6 / 5.6 wrong candidates per query @10 (= wasted LLM-verify calls). Restricting
candidates to a compatible `sport`/`league`/`type`/`domain` (signals we already have
in `known_entities`) should cut FP sharply at ~no recall cost, since true siblings
share scope. Not yet run.

### ⚠️ Scope limitation — the benchmark mis-frames structured-identity outcomes (2026-06-02)

`junkaudit` shows the `ke` eval is **~68% real entities + ~31% structured-identity
strings** (seat/margin/vote thresholds like `above 60 seats…`); `entity_subjects` is
~20% junk incl. **8.6% candle titles** (candles are 0% in `known_entities`, so the
headline `ke` run never even saw the worst case).

For these rows the identity is a **structured tuple** — `(subject, ≥, value, unit)` or
`(asset, open, duration)` — **not free text.** Recall@k of text retrieval is the wrong
metric, and **no text-similarity method fixes it**: TF-IDF/char/dense all over-merge
candles (`…may 10, 1:00pm…` ≈ `…may 13, 10:00pm…` — shared boilerplate, time digits
are *low-IDF*) and degrade on `above 60 seats` vs `above 64 seats`. The
`numeric-token-intersection` guard (`resolvers.ts:338`) is a band-aid for exactly this.

**Correct fix is routing, not similarity:** if featurization already produced
`condition_shape`/`value_primary`/`grouping_type` (or candle detection), pass only the
base metric/asset to `resolveSubjectViaKB`, never the scalar label; let
`value/direction/unit` stay as features (`tryNumeric` matches on them). Purge polluted
`entity_subjects` AND re-resolve the already-wrong `platform_events.canonical_subject`.
The 89%/etc. numbers are valid for the ~68% real-entity rows only.

### Cross-platform events (`platform_events`) — **blocked on Stage 3**

16,000 / 27,092 events embedded, but **0** confirmed cross-platform sibling pairs
(`semantic_events` not yet produced — the Stage 3b LLM matcher hasn't run). Harness
is ready and auto-gates; re-run `events` once the pipeline populates
`semantic_event_platforms`.

---

## Interpreting the outcome (decision rule we agreed on)

- If **lexical-blind-spot rescue is large** → adding a dense kNN candidate source to
  the lexical-only merge-probe/dedup is worth building (closes a real gap).
- If **dense-blind-spot rescue is large** → adding lexical to the dense-only event
  matcher (Stage 3a) is worth building.
- If **hybrid Recall@k ≥ best single method** with **FP@k not materially higher** →
  hybrid is a free win for that stage.
- If either rescue rate is ≈0 → the upstream method already catches those cases and
  hybrid is mostly theoretical for that stage; don't build it there.
