# prediction-markets-arb

Cross-platform combinatorial arbitrage detection for prediction markets. The system ingests and normalizes markets from **Kalshi**, **Polymarket**, **Predict** and **Limitless** into a shared identity layer, links logically related markets into a graph over a common outcome space (Ω), and proves arbitrage with a facet-based linear program fed by live order-book prices.

This repository accompanies the Bachelor of Science thesis **"Kombinatorična arbitraža med napovednimi trgi"** (Combinatorial Arbitrage Across Prediction Markets), Dominik Krašovec, Faculty of Computer and Information Science, University of Ljubljana, 2026. The code is published to make the research reproducible.

## Architecture

Three cooperating services (see `diagrams/` for the full picture):

| Service | Directory | Role |
| --- | --- | --- |
| Ingestion | `services/ingestion` | Pulls raw markets from the four platforms via REST, tracks market lifecycle via WebSocket, unifies them into a common store |
| Pipeline | `services/pipeline` | Deterministic (regex-first) normalization, entity knowledge base, cross-platform event identity, logical-edge graph construction (stages 0–4) |
| Arb solver | `services/arb-solver` | Builds Ω per market cluster, subscribes to live order books, and solves a facet H-representation LP (module `services/arb-solver/src/solver/facet-lp.ts`) to certify arbitrage |

Supporting workspaces live in `packages/` (DB access, event bus, LLM client, shared types) and `services/event-bus`.

Key design points:

- **Deterministic first.** Normalization and identity are driven by regex templates (`services/pipeline/src/stage1-normalize`), an entity knowledge base and SQL filters. An LLM is used only to adjudicate cross-platform event identity and to merge duplicate entities.
- **Combinatorial structures over Ω.** Implications, threshold ladders, mutual exclusions and exhaustive partitions are encoded as facet rows, so the solver catches arbitrage that pairwise equivalence checks miss.
- **Facet LP.** Dualization replaces the exponential state enumeration (O(2ⁿ) constraints) with n+1 rows and O(n+r) variables; a typical cluster solves in 2–4 ms (HiGHS via WebAssembly).
- **Soundness gates.** Exhaustiveness certification, settlement-rule compatibility, order-book freshness and depth checks guard against fake arbitrage.

## Stack

TypeScript (run with `tsx`), PostgreSQL with pgvector, HiGHS (WASM), SSE as the internal event bus. Node/npm workspaces; tests run with `bun test`.

## Getting started

```sh
npm install
docker compose -f docker/docker-compose.yml up -d   # PostgreSQL + schema (docker/init.sql)
cp .env.example .env                                # fill in credentials / API keys
npm run dev:ingestion                               # then dev:pipeline, dev:solver, ...
```

The system was evaluated passively (detection only, no order submission). Nothing in this repository places trades.

## Disclaimer

Research prototype built for a thesis evaluation. It is not investment advice and not production trading software. Platform APIs, fee schedules and settlement rules change. Numbers reported in the thesis reflect the observation window described there.

Code was written with assistance of generative artificial intelligence.
