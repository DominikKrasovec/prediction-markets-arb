/**
 * PRE-WIPE embedding dump — seed `event_embedding_cache` from the CURRENT
 * platform_events embeddings so the next wipe+rebuild restores them instead
 * of re-embedding every event (see stage2-events/event-embedding-cache.ts).
 *
 * WHEN TO RUN. Immediately BEFORE `scripts/wipe-stage1-3-and-kb.sql`, while the
 * embeddings still exist:
 *
 *   bun services/pipeline/src/scripts/dump-event-embeddings.ts
 *   docker exec -i prediction-arb-pg psql -U arb -d prediction_arb \
 *     < scripts/wipe-stage1-3-and-kb.sql
 *
 * The cache is ALSO kept warm automatically at embed time (Stage 2c upserts every
 * fresh embedding), so this seed is only strictly required the FIRST time (to
 * capture embeddings that predate the mechanism); thereafter it is a
 * belt-and-suspenders that also refreshes entries whose embed-input changed.
 *
 * Read-only w.r.t. platform_events; writes ONLY to the (not-wiped) cache table.
 * content_hash is computed via the SAME `buildEventEmbeddingInput` the embedder
 * uses (single source), so a dumped hash matches the re-embed-time hash exactly
 * for an unchanged event.
 */
import { endPool } from '@arb/db';
import { createLogger } from '@arb/logger';
import { readEnv } from '@arb/types';
import { buildEventEmbeddingInput, fetchEventEmbedRows } from '../stage2-events/embed-events.js';
import {
  ensureEventEmbeddingCache,
  eventEmbeddingContentHash,
  upsertEventEmbeddingCache,
  type CacheUpsertItem,
} from '../stage2-events/event-embedding-cache.js';

const log = createLogger('dump-event-embeddings');
const PAGE = parseInt(readEnv('EMBED_DUMP_PAGE', { alias: 'EVENT_EMBED_DUMP_PAGE' }) ?? '2000');

async function main(): Promise<void> {
  await ensureEventEmbeddingCache();
  let afterId = 0;
  let dumped = 0;
  let skippedNoVec = 0;
  for (;;) {
    const page = await fetchEventEmbedRows({ onlyNull: false, limit: PAGE, afterId });
    if (page.length === 0) break;
    afterId = page[page.length - 1].id;
    const items: CacheUpsertItem[] = [];
    for (const ev of page) {
      // stored_vec/_model are guaranteed non-null here (WHERE embedding IS NOT NULL),
      // but guard defensively — a null vector must never be cached.
      if (!ev.stored_vec || !ev.stored_model) { skippedNoVec++; continue; }
      const hash = eventEmbeddingContentHash(buildEventEmbeddingInput(ev));
      items.push({
        platform: ev.platform,
        platform_event_id: ev.platform_event_id,
        content_hash: hash,
        vec: ev.stored_vec,
        model: ev.stored_model,
      });
    }
    await upsertEventEmbeddingCache(items);
    dumped += items.length;
    log.info(`dumped ${dumped} event embeddings into event_embedding_cache (afterId=${afterId})`);
    if (page.length < PAGE) break;
  }
  log.info(`DONE: seeded ${dumped} embeddings into event_embedding_cache${skippedNoVec ? ` (skipped ${skippedNoVec} rows with a null vector/model)` : ''}`);
  await endPool();
}

main().catch((e) => { console.error(e); process.exit(1); });
