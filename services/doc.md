# services/

Top-level container for all long-running processes. Each subfolder is an independent Node.js service with its own `package.json` and `tsconfig.json`.

## Services

| Folder | Role | Port / Transport |
|--------|------|-----------------|
| [`event-bus/`](event-bus/doc.md) | Inter-service pub/sub broker via SSE | `:3100` HTTP |
| [`ingestion/`](ingestion/doc.md) | Scrape + lifecycle-watch all 4 platforms; write raw markets to DB | — (scheduled) |
| [`pipeline/`](pipeline/doc.md) | Enrich markets → group into questions → detect arb edges (batch or daemon) | — (scheduled / daemon) |
| [`arb-solver/`](arb-solver/doc.md) | Real-time LP solver; subscribes to live CLOB prices; publishes `arb:detected` | — (event-driven) |

## Data flow

```
Platforms (REST/WSS)
      │
      ▼
 ingestion  ──(markets:synced)──▶  pipeline  ──(arb edges)──▶  arb-solver
      │                                                               │
      └──────────────────────────────────────────────────────────────┘
                                                                      │
                                       event-bus (SSE) ◀──────────────┘
```

- **ingestion** → scrapes raw markets/events → Postgres
- **pipeline** → reads raw markets → enriches/normalises → writes questions + edges → Postgres
- **arb-solver** → reads constraint graph → subscribes to CLOB prices → solves LP → writes arb opportunities
- **event-bus** → thin SSE broker; services call `POST /publish`, consumers subscribe `GET /events`

## Caveats
- Services share `@arb/db` (connection pool) — do **not** run multiple instances of the same service against the same DB without verifying idempotency guarantees.
- `arb-solver` purposefully does _not_ run scrapers; CLOB price subscriptions were moved here from ingestion.
