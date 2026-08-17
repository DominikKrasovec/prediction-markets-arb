# docker/

PostgreSQL 16 + pgvector infrastructure for the implication graph pipeline.

## Files

- **docker-compose.yml** — Defines the `prediction-arb-pg` container (pgvector/pgvector:pg16), mapped to **host port 5433** (container 5432), plus the `event-bus` service. The ingestion, pipeline and arb-solver services are not containerized; run them by hand (see below). Volume-persisted data.
- **init.sql** — Full database schema (tables, HNSW vector index, GIN indexes, views, recursive graph traversal functions), applied automatically on first container start.

## Usage

```bash
cd docker
docker compose up -d
# Verify (note the non-default host port 5433):
psql -h localhost -p 5433 -U arb -d prediction_arb -c "\dx"
```

Then start the services from the repo root, in order:

```bash
npm run dev:ingestion   # market scrape + lifecycle watchers
npm run dev:pipeline    # normalization, identity layer, graph build
npm run dev:solver      # arbitrage detector over live order books
```
