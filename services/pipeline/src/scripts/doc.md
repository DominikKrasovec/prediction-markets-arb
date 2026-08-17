# pipeline/src/scripts/

One-off maintenance, backfill, and migration scripts. **Not** part of a normal pipeline run; executed manually via `npx tsx scripts/<name>.ts`. Many are dated point-in-time fixes (filenames carry the date) and are kept for provenance, not re-use.

## Categories

| Group | Scripts | Purpose |
|-------|---------|---------|
| **Backfills** | `backfill-cross-platform-fixes.ts`, `backfill-kalshi-league-id.ts`, `backfill-kalshi-weather.ts`, `backfill-polymarket-weather.ts`, `backfill-text-det-scoped.ts` | Re-derive a specific column/signal (league id, weather station, scoped text-det fields) on already-normalized rows after the relevant Stage 1 logic changed. |
| **Renormalizers** (dated) | `renormalize-poisoned-subjects.ts`, `renormalize-date-fixes-2026-05-27.ts`, `renormalize-kalshi-reference-period-2026-05-28.ts`, `renormalize-esports-props-2026-05-28.ts` | Re-run Stage 1 normalization over a targeted subset of markets to apply a specific fix. Dated → point-in-time. |
| **Entity-KB merges / cleanup** | `merge-trump.ts`, `merge-democratic-party.ts`, `merge-team-suffix-duplicates.ts`, `merge-national-team-suffix.ts`, `merge-house-race-padding.ts`, `scrub-alias-pollution.ts`, `reconcile-entity-kb.ts` | Manually collapse known duplicate `known_entities` rows / scrub bad aliases / reconcile KB drift. |
| **Re-enqueue / re-run** | `enqueue-restructured-markets.ts` | Push a market subset back into a queue for re-processing. |
| **Wipes** (destructive) | `wipe-stage1-to-3.ts`, `wipe-parlay-embeddings.ts`, `purge-combination-parlays.ts` | Reset Stage 1–3 output (or just parlay embeddings), or purge multi-leg combination parlays, for a full re-run. |
| **Analysis / smoke** | `induce-regex-patterns.ts`, `smoke-event-name-normalizer.ts`, `prototype-semantic-implication.ts` | `induce-regex-patterns.ts` analyses titles and proposes new regex templates (stdout, manual review). `smoke-event-name-normalizer.ts` spot-checks event-name normalization. `prototype-semantic-implication.ts` is the BOUNDED (≤200 pairs) semantic-relation judge prototype — read-only on the edge graph, writes only llm_logs + a markdown report. |
| **Regression checks** (read-only, re-runnable) | `check-resolved-consistency.ts`, `soundness-regression-asserts.ts` | `check-resolved-consistency.ts` validates the edge graph against platform ground truth over RESOLVED markets (equivalence endpoints must agree; strict implication must hold; mutex ≤1 YES; Σ=1 sets exactly 1 YES among fully-resolved slots) and prints a resolved-coverage denominator; `--assert` exits 1 on violations. Run with `bun` (resolves the workspace `bun` export condition). |

## Caveats
- These scripts connect to the DB via `@arb/db` / `DATABASE_URL`; the **wipe** scripts are destructive — run against staging first.
- `induce-regex-patterns.ts` is exploratory — its output requires human review before patterns are added to `text-deterministic.ts`.
- Dated `renormalize-*` / backfill scripts are historical; they document a past fix and are not expected to be re-run.
