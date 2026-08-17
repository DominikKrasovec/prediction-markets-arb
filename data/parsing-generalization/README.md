# Parsing-generalization experiments

Can we **generalize the Stage-1 regex/deterministic parsing rules** into a cheap
*learned* extractor — without GPUs and without calling an LLM per market?

Background (from the design conversation): [text-deterministic.ts](../../services/pipeline/src/stage1-normalize/text-deterministic.ts)
is a 3,578-line zoo of hand-built regex templates (A–U) plus reactive guards
(`B_SUFFIX_GUARDS`, contamination checks, negative lookaheads). It works but is
fragile and never generalizes — each new title shape needs a new hand-written
pattern. The Stage-1 task is really **structured slot-filling**:

- **Categorical slots** (closed sets): `condition_shape`, `event_kind`,
  `condition_direction`, `condition_metric`, `temporal_semantics`, `entity_type`.
  → classification.
- **Span slots**: `subject`, `participants[]`, `value`, `unit`, `date`. → NER.

This folder measures the **distillation hypothesis** for the *classification* half:

> We already have a large labeled dataset for free — every market the regexes or
> the LLM normalized is a `(title → slots)` pair — and `markets.embedding` already
> holds the title vectors. So train a tiny classifier on the **rules' outputs** and
> see if it predicts the right slot on titles the rules **couldn't** parse (the
> LLM-labeled tail). If it does, the regex zoo can become *training labels*, and a
> microsecond linear head replaces hand-written guards.

> Status: prototype / measurement only. Read-only DB access; no writes to live
> tables, no schema changes. Models train on CPU (no GPU — see note below).

---

## Why no GPU

The expensive step — text → 1536-dim vector — is already done (OpenAI computed
`markets.embedding`). A **linear probe** (multinomial logistic regression) or a
small 1–2 layer MLP on *frozen* embeddings is a tiny optimization problem
(≈ `1536 × #classes` weights). It trains in seconds–minutes on CPU; inference is a
single matrix-multiply (µs). GPUs only matter when you train the embedding model
itself (a billion-param transformer over raw text). The harness prints training
wall-clock so this is verified empirically, not asserted.

---

## What we measure

Label source is read from `llm_market_normalizations.match_source`:
- **rules** = `match_source LIKE 'text-deterministic-%' OR LIKE 'kalshi:%'`
- **llm**   = `match_source LIKE 'llm-%'` (the tail the regexes couldn't handle)
- rows with NULL `match_source` (pre-migration, ambiguous) are excluded.

Targets: `condition_shape` (default) and `event_kind`. For each target the harness
runs three evaluations + baselines:

| Evaluation | Train on | Test on | Question it answers |
|---|---|---|---|
| **In-distribution** | random 80% of all labeled | held-out 20% | Does the embedding even carry the slot? (ceiling) |
| **Rules → LLM (headline)** | **rules-labeled only** | **llm-labeled only** | Does a model that only saw the rules' outputs label the titles the rules *missed*? |
| **kNN-from-rules** | (param-free) | sampled llm-labeled | Same question, parameter-free: do the title's nearest rules-labeled neighbours carry the right slot? |

Baselines: **majority-class** accuracy (the floor) on each test set. Metrics:
**accuracy**, **macro-F1** (so rare slots count), per-class precision/recall, and
**unseen-class rate** (test rows whose slot never appears in the train labels — a
shape the rules never produced; the model can't predict it, and that's a finding).

Models compared:
- **logreg** — multinomial logistic regression (the deployable linear head),
  trained in JS with mini-batch Adam. Reports wall-clock.
- **knn** — k-nearest rules-labeled neighbours by embedding cosine, via the
  existing pgvector HNSW index (no training).

### Decision rule
- Headline **Rules→LLM accuracy ≫ majority baseline** and close to the
  in-distribution ceiling → the embedding space generalizes the rules; we can start
  retiring `condition_shape`/`event_kind` guards behind a flag and let the probe
  classify, routing only low-confidence titles to the LLM (active learning).
- Headline ≈ majority baseline → embeddings don't carry that slot; keep the regexes.
- High **unseen-class rate** → the LLM tail contains slot values the rules never
  emit; those need their own handling regardless.

---

## How to run

```bash
# label-source + per-class distribution (sizes the experiment)
npx tsx data/parsing-generalization/probe.ts stats

# distillation experiment for a target
npx tsx data/parsing-generalization/probe.ts run --target condition_shape
npx tsx data/parsing-generalization/probe.ts run --target event_kind
```

Connection uses the same `PG_*` env / `.env` as `@arb/db`. Each run writes a
timestamped `results-<target>-<ts>.{md,json}` next to this file.

---

## Results

**Verdict (both targets):** the title embedding carries the categorical slots
**extremely well in-distribution (~95%)** — a linear probe reproduces the rules'
decisions, trains in ~15s on CPU, infers in µs. But it **does not extrapolate**:
cross-platform transfer collapses, for two reasons — (1) classes absent from the
training platform can't be predicted (27.6% of Kalshi `event_kind`s never appear in
non-Kalshi rule-outputs), and (2) some slots are decided by *structured metadata*
(`strike_type`, rules prose) the title embedding never sees. So distillation is a
real win **as an in-distribution classifier trained on all platforms** + an
active-learning router — NOT as a free generalizer to the unparsed tail.

### condition_shape (n=10k test, 2026-06-01)

| eval | model | accuracy | majority | macro-F1 |
|---|---|---|---|---|
| in-distribution | logreg | **95.4%** | 34.9% | 0.939 |
| cross-platform (non-Kalshi→Kalshi) | logreg | **40.2%** | 41.9% | 0.423 |
| cross-platform | knn(k=15) | 13.0% | 40.0% | — |

- In-dist per-class F1 all 0.90–0.97. Train wall-clock 15.5s (CPU, no GPU).
- Cross-platform is **below majority baseline** — collapse driven by Kalshi
  `point_in_time` (price snapshots): 100% precision, **10% recall**. That shape is
  decided by Kalshi `strike_type`/rules metadata absent from the title embedding.
- Coverage on 74k unlabeled tail: conf≥0.9 = 31.6%, ≥0.7 = 68% — but unreliable
  (cross-platform proves the model is confidently wrong out-of-distribution).

### event_kind (n=10k test, 2026-06-01)

| eval | model | accuracy | majority | macro-F1 |
|---|---|---|---|---|
| in-distribution | logreg | **95.6%** | 20.1% | 0.777 |
| cross-platform (non-Kalshi→Kalshi) | logreg | **52.2%** | 21.9% | 0.463 |
| cross-platform | knn(k=15) | 19.0% | 22.1% | — |

- In-dist strong across 22 classes (common classes 0.85–1.00 F1, `weather_extreme`
  1.00). macro-F1 lower (0.777) because rare classes have thin support.
- Cross-platform 2.4× baseline but mediocre, and **27.6% unseen-class**:
  `election_margin`, `election_turnout`, `stage_advance` score 0% — they're
  essentially absent from non-Kalshi training, so the model can't predict them.
  Shared classes transfer better (`match_winner` 0.81, `championship_winner` 0.79).
- Coverage on tail thinner (conf≥0.9 = 11.8%) — the unparsed tail is genuinely
  out-of-distribution.

---

## Unnormalized-tail triage (subagents, 2026-06-01)

The 74k unnormalized embedded markets split: **kalshi 37,305 / polymarket 35,995 /
predict 674 / limitless 114**. Two subagents triaged the **Kalshi** half by series
ticker prefix (`probe.ts unnormalized` → `unnormalized-report.json`).

**Verdict: the Kalshi tail is ~90%+ ZOO-EXTENDABLE, not ambiguous.**
- Sports series (~9.3k analyzed): **~93–95% extendable**; only announcer-props
  (`KXNBAMENTION`/`KXMLBMENTION`, ~310) + WC-halftime performer (~133) truly ambiguous.
- Non-sports (~16k): **~90%+ extendable**; only open-ended speech props
  (`KXTRUMPSAY`/`KXTRUMPMENTION`, ~130) and bespoke sub-cent crypto ranges (`KXSHIBA`)
  genuinely need an LLM.

**Why they fall through is uniform and shallow** — not "the proposition is unclear":
- The YES candidate is **already structured in `yes_sub_title`** (100% populated on
  the sports clusters); the numeric threshold is in **typed `floor_strike`/`cap_strike`**;
  the type is encoded in the **series ticker prefix**. The embedding never sees these.
- They miss only because the deterministic passes are **narrowly gated**: Pass 4
  requires a `^who will win` title, `KNOWN_SERIES_MAP` excludes sports, Pass 7
  hardcodes `KXPGATOP\d+`, and several handlers exist but their regex is too tight
  (e.g. midterm `MOV`/`VOTETURN` require a *district* number — but 100% of the misses
  are *statewide*; CA-primary handler wants "place first" but titles say "advance").

**Highest-value rule groups to add (would label ~roughly the whole tail):**
1. Season-total threshold family (`KXNFLWINS`/`KXNCAAFWINS`/`KXMLBWINS`/`KXMLBSEASONHR`/
   `KXNFLSEASONRECYDS`, ~1.5k) — one ticker-routed typed-strike rule.
2. Kalshi "wins by over N" spread + "score over N" team-total family (~1.4k).
3. Generalize Pass 4 / Pass 7 to all `yes_sub_title`-bearing winner/finish series
   (NASCAR, golf tail, draft, squad, round, stage; ~3k+).
4. Statewide midterm `MOV`+`VOTETURN` regex variants (~1.1k) — widen existing regex.
5. Generic "categorical-on-`yes_sub_title`" award pass (AMA/Tony/Billboard/charts/
   streams, >2k) + add `KXRT`/`KXALBUMEQUIV`/`KXARTISTSTREAMS` to `KNOWN_SERIES_MAP`.

**Implications:**
- This is exactly the "temporary rules → labels → train the model" loop: adding these
  would label ~33k Kalshi markets, hugely expanding training data and covering the
  classes that were `unseen` in the earlier cross-platform cut.
- It **confirms the metadata-dependence finding**: the answer lives in `yes_sub_title`/
  strikes/ticker, *not* the title embedding — so a feature-augmented model (or, for
  Kalshi, almost pure structured-field parsing) is the right tool, not embedding-alone.
- The genuinely fuzzy frontier is the **Polymarket half (~36k)**, free-text titles
  with no structured candidate field — that's where embeddings/learned extraction
  actually earn their keep. (Not yet triaged.)

## Experiment DB + improved-model comparison (2026-06-01)

Built an isolated `exp` schema (read-only on prod; `exp-build.ts`):
- `exp.dataset` — 173,496 embedded markets + feature columns + prod label + the
  title+desc embedding.
- `exp.labels_new` — the new Kalshi-tail rules (subagents' clusters + crypto/commodity
  price series + a few generic patterns) label **29,748 / 46,590 (63.9%)** of
  unnormalized Kalshi markets, filling the sparse classes (price_snapshot,
  election_margin/turnout, social_media_metric) that caused the earlier
  cross-platform "unseen-class" collapse. Combined labeled set ≈ 129k.
- `exp.title_embeddings` — TITLE-ONLY embeddings for all 173k (to test the desc).

Then compared three featurizations (logreg, CPU, on the **expanded** labels):

### event_kind
| featurization | in-dist acc | macro-F1 | x-plat acc | x-plat macro-F1 |
|---|---|---|---|---|
| dense title+desc (current) | 93.1% | 0.868 | 27.4% | 0.168 |
| **dense title-only** | **98.9%** | **0.949** | **35.9%** | **0.234** |
| TF-IDF title | 98.8% | 0.951 | 26.8% | 0.189 |

### condition_shape
| featurization | in-dist acc | macro-F1 | x-plat acc | x-plat macro-F1 |
|---|---|---|---|---|
| dense title+desc (current) | 93.1% | 0.926 | 49.7% | 0.458 |
| **dense title-only** | 96.1% | 0.935 | **54.0%** | 0.461 |
| **TF-IDF title** | **97.2%** | **0.957** | 48.9% | 0.444 |

**Findings:**
1. **The description HURTS.** Title-only beats title+desc on every metric: event_kind
   +5.8 pts in-dist (93.1→98.9%) / +8.5 pts x-plat; condition_shape +3.0 / +4.3.
   The 500-char settlement boilerplate dilutes the signal. ⚠️ **Caveat:**
   `markets.embedding` also feeds Stage 2/3 cross-platform matching + entity Tier-2;
   title-only is proven better *for classification* only — test the matching impact
   (separate experiment) before changing prod `buildEmbeddingInput`.
2. **TF-IDF ties (or beats) dense in-distribution** — event_kind 98.8% vs 98.9%,
   condition_shape 97.2% vs 96.1% — free, interpretable, no API. Slot classification
   is keyword-driven, so a lexical vectorizer is competitive. Dense only wins
   **cross-platform** (event_kind 35.9 vs 26.8%), where it bridges Kalshi vocab the
   lexical model never saw in non-Kalshi training.
3. **Cross-platform stays hard** (event_kind ≤36%) — and is *lower* than the
   prod-only probe earlier (52%) precisely because the expanded labels added many
   Kalshi-only event_kinds to the test set that don't exist on other platforms. This
   is genuine distribution divergence: a deployable model must **train on all
   platforms** (the in-dist scenario, ~96–99%), not extrapolate across them.

**Net:** for an in-distribution slot classifier, **title-only TF-IDF or title-only
dense both reach ~97–99%** (CPU, no GPU), versus the current title+desc dense at
~93%. The expanded Kalshi labels are what make the in-dist training cover the
Kalshi-specific classes.

> Experiment-DB cleanup when done: `DROP SCHEMA exp CASCADE;` (≈2-3GB:
> dataset+title_embeddings+labels_new) and `DROP TABLE bench_known_entity_forms;`.

## Log (what we tried, chronological)

- **2026-06-01 (a)** — Built the harness for the planned "Rules → LLM-tail"
  generalization cut.
- **2026-06-01 (b)** — `stats` revealed the cut is **not measurable**: the Stage-1
  LLM normalization path is currently stripped (regex-first rewire), so there are
  **0 `llm-*` rows**. Label sources are only `text-det` (80,604) and `kalshi`
  (18,804). Also: **74,088 embedded markets have no normalization at all** — the
  regex zoo covers ~57% of normalizable markets and silently drops ~43%.
- **2026-06-01 (c)** — Pivoted the harness to what's measurable now:
  1. **in-distribution** (random 80/20 over rules-labeled) — does the embedding
     carry the slot at all (ceiling)?
  2. **cross-platform** (train non-Kalshi rule-outputs → test Kalshi) — does the
     learned signal transfer across surface-form distributions (the generalization
     regex can't do)?
  3. **coverage** — the in-dist model's confidence on the 74k unlabeled tail =
     how much of what the regexes dropped a learned head could confidently
     auto-label (needs spot-check; no ground truth).
  Results recorded in the per-target sections above + timestamped `results-*` files.
- **2026-06-01 (d)** — Ran both targets. In-dist ~95% (slot is learnable, cheap,
  CPU); cross-platform collapses (unseen classes + metadata-decided slots).
- **2026-06-01 (e)** — Subagents triaged the Kalshi unnormalized tail → ~90%+ rule-
  extendable (see section above).
- **2026-06-01 (f)** — Built isolated `exp` schema, labeled 29.7k Kalshi-tail markets
  via new rules, generated title-only embeddings, and ran the 3-way featurization
  comparison. Results: **description hurts** (title-only > title+desc everywhere);
  **TF-IDF ties dense in-distribution**; dense wins cross-platform. See section
  above. Still open: feature-augmented model (embedding ⊕ structured fields) for the
  cross-platform gap; NER/span half; and testing title-only embeddings on the
  Stage 2/3 *matching* use-case.
