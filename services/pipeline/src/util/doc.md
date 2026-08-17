# pipeline/src/util/

Shared utilities for the pipeline service.

## Files

| File | Role |
|------|------|
| `concurrency.ts` | `runWithConcurrency(tasks, limit)` — bounded concurrency helper. Runs an array of async tasks with at most `limit` in flight at any time. Used throughout Stage 1 and entity enrichment to prevent DB/LLM overload. |
| `parlay-legs.ts` | `parseParlayLegs(title)` — parses a comma-delimited parlay title into a discriminated-union `Leg[]` (`threshold` / `spread` / `total` / `binary` / `unknown`), or `null`. Also exports `isParlayMarket`. Consumed by `db/sync.ts` — the parlay write-guard at sync that keeps combination parlays out of the pipeline. |
| `placeholder-outcomes.ts` | `isPlaceholderParticipant(name)` / `isPlaceholderChild(title)` (+ `cleanParticipants`, `cleanSortChildren`, `placeholderSlotsInSet`) — detect/strip generic TBD slots ("Team A", "Player 9", "the field") so they're excluded from BOTH the event-embedding text and Ω construction. A placeholder slot names no real entity, so leaving it in an event embedding drags unrelated events together, and leaving it in Ω mints a world that can never settle. |

## Caveats
- `concurrency.ts` is a simple queue-based implementation; it does not support cancellation or priority ordering.
- `parlay-legs.ts` is the single source of truth for parlay-leg parsing. (The old Stage 1 `llm-normalizer.ts` and Stage 3 rule-engine consumers — `implication-edges.ts`, `parlay-implication.ts` — were all deleted in the event-centric rewire; the only remaining caller is `db/sync.ts`'s parlay write-guard.)
- A leg the grammar can't parse confidently is returned as `kind: 'unknown'`, so consumers can decline rather than acting on a misparsed leg.
