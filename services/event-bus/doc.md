# event-bus

Minimal SSE (Server-Sent Events) broker. Lets services publish events and subscribe to named channels without direct service-to-service coupling.

## Responsibilities
- Accept `POST /publish` from any service → fan-out to all SSE subscribers on that channel
- Serve `GET /events?channels=X,Y` → keep SSE stream alive; heartbeat every 30 s
- Store last event per `(channel, type)` pair → `GET /last-event` for non-SSE consumers

## Directory layout

```
event-bus/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts    Express server on :3100; all logic lives here
```

## Endpoints (index.ts)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/events` | SSE stream; `?channels=markets,pipeline,arbitrage,prices` |
| `POST` | `/publish` | Body: `{ channel, type, data }` → fan-out to subscribers |
| `GET` | `/last-event` | `?channel=X&type=Y` → last emitted event for that pair |
| `GET` | `/health` | Liveness probe → `{ status, clients, uptime, channels }` |

## Known channels

| Channel | Published by | Consumed by |
|---------|--------------|-------------|
| `markets` | ingestion | pipeline (daemon sync loop) |
| `pipeline` | pipeline | dashboard |
| `arbitrage` | arb-solver | dashboard |
| `prices` | arb-solver | dashboard |

## Caveats
- In-memory only; restarts lose all stored last-events and disconnect all subscribers.
- No authentication — keep the port firewalled; it is not intended to be public.
- SSE connections are long-lived; ensure reverse proxies (nginx, etc.) disable request buffering and set suitable timeouts.
