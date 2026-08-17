/**
 * Stage 2c — embed every platform_event.
 *
 * Deterministic (no LLM reasoning — just a vector projection via OpenAI
 * embeddings, same model as markets.embedding). The embedding text folds the
 * event title + a volume-prioritised sample of child titles + canonical_subject
 * + participants + deadline, so the Stage 3a ANN can find cross-platform
 * counterparts of the same real-world event.
 *
 * Idempotent + resumable: only embeds events with NULL embedding, paginated so
 * a long OpenAI loop never holds a pg connection idle past the pool reaper.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { readEnv } from '@arb/types';
import { config } from '../config.js';
import { embedTexts } from '../stage1-normalize/embedder.js';
import { cleanParticipants, cleanSortChildren } from '../util/placeholder-outcomes.js';
import {
  ensureEventEmbeddingCache,
  eventEmbeddingContentHash,
  eventCacheKey,
  lookupEventEmbeddingCache,
  upsertEventEmbeddingCache,
} from './event-embedding-cache.js';

const log = createLogger('embed-events');
// Canonical name is EMBED_EVENT_PAGE_SIZE, not EMBED_PAGE_SIZE — the bare
// EMBED_PAGE_SIZE is a distinct knob (the Stage-1c market-embed page size).
const PAGE_SIZE = parseInt(
  readEnv('EMBED_EVENT_PAGE_SIZE', { alias: 'EVENT_EMBED_PAGE_SIZE' }) ?? '1000',
);

/**
 * Futures event_kinds whose `date:` we never fold, even when precision is fine.
 * These resolve far out and/or on a platform-specific guess day; the horizon guard
 * catches the far-future ones, this list also catches near-term mis-dated leaks
 * (e.g. esports `championship_winner` rows that kept a fine tournament timestamp).
 */
const FUTURES_DATELESS_KINDS = [
  'election_outcome_winner',
  'election_margin',
  'election_turnout',
  'election_seat_winner',
  'championship_winner',
  'award_winner',
  'crypto_launch_fdv',
];

export interface EventRow {
  id: number;
  /** Natural-key half — the embedding cache is keyed on (platform, platform_event_id). */
  platform: string;
  platform_event_id: string;
  title: string;
  canonical_subject: string | null;
  participants: string[] | null;
  league_canonical: string | null;
  /**
   * `condition_date::date` ALREADY GUARDED in SQL (selectPage): non-null only when
   * precision is fine (day/hour/minute), within the horizon, and not a futures kind.
   * NULL ⇒ no date line + the title is weighted instead. The padded `deadline` is
   * deliberately NOT folded (admin padding; differs by months for the same event).
   */
  embed_date: string | null;
  child_titles: string[] | null;
  /** Populated ONLY by the dump path (fetchEventEmbedRows onlyNull=false): the
   *  currently-stored embedding as a pgvector literal + its model. Undefined on
   *  the embed path (onlyNull=true). */
  stored_vec?: string | null;
  stored_model?: string | null;
}

/**
 * Build the embedding input string for one platform_event.
 *
 * Composition: title (weighted/repeated only when there is no date line —
 * title-weight and date are complementary recall boosters, applied mutually
 * exclusively); subject + league; participants (placeholders dropped,
 * deduped, sorted, killing cross-platform order/placeholder drift); date
 * (the already-guarded `embed_date`, helps recall reworded same-day events);
 * children (placeholders dropped, sorted, kept ~all).
 */
export function buildEventEmbeddingInput(ev: EventRow): string {
  const parts: string[] = [];
  const weight = ev.embed_date ? 1 : Math.max(1, config.events.titleWeightWhenDateless);
  for (let i = 0; i < weight; i++) parts.push(ev.title);
  if (ev.canonical_subject) parts.push(`subject: ${ev.canonical_subject}`);
  if (ev.league_canonical) parts.push(`league: ${ev.league_canonical}`);
  const participants = cleanParticipants(ev.participants);
  if (participants.length > 0) parts.push(`participants: ${participants.join(', ')}`);
  if (ev.embed_date) parts.push(`date: ${ev.embed_date}`);
  for (const t of cleanSortChildren(ev.child_titles)) parts.push(`- ${t}`);
  return parts.join('\n').trim();
}

/**
 * Fetch a page of EventRows with EXACTLY the columns `buildEventEmbeddingInput`
 * consumes — the SINGLE source for both the embed path and the dump path so the
 * content_hash is computed over identical inputs (no drift → cache hits).
 *
 *  · onlyNull=true  (embed path): `WHERE embedding IS NULL`, re-selected each
 *    iteration as rows get filled; no keyset needed. stored_vec/_model unset.
 *  · onlyNull=false (dump path):  `WHERE embedding IS NOT NULL AND id > afterId`,
 *    keyset-paginated, and also returns the currently-stored vector + model.
 */
export async function fetchEventEmbedRows(opts: {
  onlyNull: boolean;
  limit: number;
  afterId?: number;
}): Promise<EventRow[]> {
  const whereEmb = opts.onlyNull ? 'pe.embedding IS NULL' : 'pe.embedding IS NOT NULL AND pe.id > $5';
  const storedCols = opts.onlyNull ? '' : ', pe.embedding::text AS stored_vec, pe.embedding_model AS stored_model';
  const params: unknown[] = [
    config.events.embedChildSample,       // $1
    config.events.embedDateHorizonDays,   // $2
    FUTURES_DATELESS_KINDS,               // $3
    opts.limit,                           // $4
  ];
  if (!opts.onlyNull) params.push(opts.afterId ?? 0); // $5
  return query<EventRow>(
    `SELECT pe.id, pe.platform, pe.platform_event_id, pe.title, pe.canonical_subject,
            pe.participants, pe.league_canonical,
            -- Fold condition_date only when fine-grained, within the upper
            -- horizon, and not a futures kind.
            CASE
              WHEN pe.condition_date IS NOT NULL
               AND pe.condition_date_precision IN ('day', 'hour', 'minute')
               AND pe.condition_date <= NOW() + make_interval(days => $2::int)
               AND COALESCE(pe.event_kind, '') <> ALL($3::text[])
              THEN pe.condition_date::date::text
              ELSE NULL
            END AS embed_date,
            (SELECT array_agg(s.t) FROM (
               SELECT m.title AS t
               FROM markets m
               WHERE m.platform = pe.platform
                 AND m.platform_event_id = pe.platform_event_id
               ORDER BY m.volume DESC NULLS LAST, m.id
               LIMIT $1
             ) s) AS child_titles${storedCols}
       FROM platform_events pe
      WHERE ${whereEmb}
      ORDER BY pe.id
      LIMIT $4`,
    params,
  );
}

async function selectPage(limit: number): Promise<EventRow[]> {
  return fetchEventEmbedRows({ onlyNull: true, limit });
}

/**
 * Pair a page of events with the vectors returned for that page. Throws on a
 * count mismatch so a misaligned batch can never reach the bulk UPDATE and
 * silently carry byte-copies of a previous page's vectors.
 */
export function zipPageVectors(
  page: ReadonlyArray<{ id: number }>,
  vectors: ReadonlyArray<number[]>,
): { id: number; vec: string }[] {
  if (vectors.length !== page.length) {
    throw new Error(
      `Stage 2c: embedTexts returned ${vectors.length} vectors for ${page.length} events — refusing to write misaligned page`,
    );
  }
  return page.map((ev, i) => ({ id: ev.id, vec: `[${vectors[i].join(',')}]` }));
}

async function bulkWriteEmbeddings(
  items: { id: number; vec: string }[],
  model: string,
): Promise<void> {
  if (items.length === 0) return;
  await query(
    `UPDATE platform_events pe
        SET embedding = v.vec::vector, embedding_model = $3, embedded_at = NOW()
       FROM (SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS vec) v
      WHERE pe.id = v.id`,
    [items.map((i) => i.id), items.map((i) => i.vec), model],
  );
}

/**
 * Split a page into cache-restore items (an exact natural-key +
 * content_hash + model match) and cache-miss items (must hit the API). Pure
 * — the sole decision point for the embedding-preserving wipe.
 */
export function partitionEventsByCache(
  page: ReadonlyArray<EventRow>,
  texts: ReadonlyArray<string>,
  hashes: ReadonlyArray<string>,
  hits: ReadonlyMap<string, string>,
): { restoreItems: { id: number; vec: string }[]; missPage: EventRow[]; missTexts: string[]; missHashes: string[] } {
  const restoreItems: { id: number; vec: string }[] = [];
  const missPage: EventRow[] = [];
  const missTexts: string[] = [];
  const missHashes: string[] = [];
  for (let i = 0; i < page.length; i++) {
    const ev = page[i];
    const vec = hits.get(eventCacheKey(ev.platform, ev.platform_event_id));
    if (vec) restoreItems.push({ id: ev.id, vec });
    else { missPage.push(ev); missTexts.push(texts[i]); missHashes.push(hashes[i]); }
  }
  return { restoreItems, missPage, missTexts, missHashes };
}

export async function embedAllPlatformEvents(): Promise<number> {
  const model = config.events.embeddingModel;
  // Embedding-preserving wipe: consult the persistent event_embedding_cache
  // first — an exact match restores the stored vector with no OpenAI call;
  // only true misses hit the API, and each miss is written back so the cache
  // stays warm for the next wipe.
  await ensureEventEmbeddingCache();
  let total = 0;      // rows written (restored + freshly embedded)
  let restored = 0;   // rows served from cache (no API cost)
  let embedded = 0;   // rows that hit the OpenAI API
  for (;;) {
    const page = await selectPage(PAGE_SIZE);
    if (page.length === 0) break;
    const texts = page.map(buildEventEmbeddingInput);
    const hashes = texts.map(eventEmbeddingContentHash);
    const hits = await lookupEventEmbeddingCache(
      page.map((ev, i) => ({ platform: ev.platform, platform_event_id: ev.platform_event_id, content_hash: hashes[i] })),
      model,
    );

    const { restoreItems, missPage, missTexts, missHashes } = partitionEventsByCache(page, texts, hashes, hits);

    if (restoreItems.length > 0) {
      await bulkWriteEmbeddings(restoreItems, model);
      restored += restoreItems.length;
    }
    if (missPage.length > 0) {
      const vectors = await embedTexts(missTexts);
      const items = zipPageVectors(missPage, vectors);
      await bulkWriteEmbeddings(items, model);
      // Keep the cache warm: persist every freshly-embedded event so the NEXT
      // wipe restores it without a dump step (idempotent upsert on natural key).
      await upsertEventEmbeddingCache(
        missPage.map((ev, i) => ({
          platform: ev.platform,
          platform_event_id: ev.platform_event_id,
          content_hash: missHashes[i],
          vec: items[i].vec,
          model,
        })),
      );
      embedded += missPage.length;
    }

    total += page.length;
    log.info(`Stage 2c: processed ${total} platform_events (restored=${restored} from cache, embedded=${embedded} via API)`);
    if (page.length < PAGE_SIZE) break;
  }
  if (total === 0) log.info('Stage 2c: all platform_events already embedded');
  else log.info(`Stage 2c: stored ${total} event embeddings (restored=${restored} cache-hit, embedded=${embedded} API — saved ${restored} embedding calls)`);
  return total;
}
