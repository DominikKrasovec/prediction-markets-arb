/**
 * Embedding-preserving-wipe cache for platform_events. A full wipe+rebuild
 * (`scripts/wipe-stage1-3-and-kb.sql`) truncates platform_events, taking its
 * embeddings with it; without this cache, Stage 2c would re-embed every
 * event against the embeddings API on the next run even when the rebuilt
 * events are byte-identical (markets, the embed source, are not wiped).
 *
 * Mechanism: a persistent side table `event_embedding_cache`, keyed on the
 * event natural key (platform, platform_event_id), stores (content_hash,
 * embedding, embedding_model). content_hash is the sha256 of exactly the
 * string the embedder embeds — `buildEventEmbeddingInput(ev)` (single
 * source; if the embed-input serialization changes, the hash changes and
 * the entry is re-embedded, never restored). The table is in the wipe
 * script's not-wiped block, so it survives the truncate.
 *
 * Soundness: restore fires only on an exact (natural key + content_hash +
 * embedding_model) match. Any drift in the embed-input text or a model
 * change causes a mismatch, and a mismatch never restores — it re-embeds.
 * Cold cache means every event re-embeds.
 *
 * The cache is kept warm automatically: Stage 2c writes each freshly-embedded
 * event into the cache at embed time (`upsertEventEmbeddingCache`), so after
 * any rebuild the cache already covers everything it embedded.
 */
import { createHash } from 'node:crypto';
import { query } from '@arb/db';

/** Canonical DDL, run here (IF NOT EXISTS, idempotent) as a safety net since
 *  there is no automatic migration runner. */
export const EVENT_EMBEDDING_CACHE_DDL = `
CREATE TABLE IF NOT EXISTS event_embedding_cache (
  platform          TEXT NOT NULL,
  platform_event_id TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  embedding         vector(1536) NOT NULL,
  embedding_model   TEXT NOT NULL,
  cached_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (platform, platform_event_id)
)`;

let ensured = false;
/** Create the cache table if it is missing (idempotent; runs once per process). */
export async function ensureEventEmbeddingCache(): Promise<void> {
  if (ensured) return;
  await query(EVENT_EMBEDDING_CACHE_DDL);
  ensured = true;
}
/** Test hook — reset the once-per-process guard. */
export function _resetEventEmbeddingCacheEnsuredForTests(): void {
  ensured = false;
}

/** sha256 hex of exactly the embed-input string. */
export function eventEmbeddingContentHash(embedInput: string): string {
  return createHash('sha256').update(embedInput, 'utf8').digest('hex');
}

/** Ephemeral in-memory map key for a (platform, platform_event_id) natural key.
 *  A NUL separator (never present in a platform name or ticker) keeps the join
 *  unambiguous. Never persisted — the DB cache uses the two real columns. */
const CACHE_KEY_SEP = String.fromCharCode(0);
export function eventCacheKey(platform: string, platformEventId: string): string {
  return platform + CACHE_KEY_SEP + platformEventId;
}

export interface CacheProbe {
  platform: string;
  platform_event_id: string;
  content_hash: string;
}

/**
 * Batch cache lookup. Returns a Map from eventCacheKey → the stored embedding as
 * a pgvector literal ('[...]'), ONLY for probes whose (natural key, content_hash,
 * embedding_model) ALL match a cache row — i.e. only sound restores. Non-matching
 * probes are absent from the map (⇒ the caller re-embeds them).
 */
export async function lookupEventEmbeddingCache(
  probes: ReadonlyArray<CacheProbe>,
  model: string,
): Promise<Map<string, string>> {
  const hits = new Map<string, string>();
  if (probes.length === 0) return hits;
  const rows = await query<{ platform: string; platform_event_id: string; vec: string }>(
    `SELECT c.platform, c.platform_event_id, c.embedding::text AS vec
       FROM event_embedding_cache c
       JOIN (SELECT unnest($1::text[]) AS platform,
                    unnest($2::text[]) AS platform_event_id,
                    unnest($3::text[]) AS content_hash) q
         ON c.platform = q.platform
        AND c.platform_event_id = q.platform_event_id
        AND c.content_hash = q.content_hash
      WHERE c.embedding_model = $4`,
    [
      probes.map((p) => p.platform),
      probes.map((p) => p.platform_event_id),
      probes.map((p) => p.content_hash),
      model,
    ],
  );
  for (const r of rows) hits.set(eventCacheKey(r.platform, r.platform_event_id), r.vec);
  return hits;
}

export interface CacheUpsertItem {
  platform: string;
  platform_event_id: string;
  content_hash: string;
  /** pgvector literal '[...]'. */
  vec: string;
  model: string;
}

/** Idempotent batch upsert (one row per natural key; latest content wins). */
export async function upsertEventEmbeddingCache(items: ReadonlyArray<CacheUpsertItem>): Promise<void> {
  if (items.length === 0) return;
  await query(
    `INSERT INTO event_embedding_cache
       (platform, platform_event_id, content_hash, embedding, embedding_model, cached_at)
     SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]),
            unnest($4::text[])::vector, unnest($5::text[]), NOW()
     ON CONFLICT (platform, platform_event_id) DO UPDATE
       SET content_hash    = EXCLUDED.content_hash,
           embedding       = EXCLUDED.embedding,
           embedding_model = EXCLUDED.embedding_model,
           cached_at       = NOW()`,
    [
      items.map((i) => i.platform),
      items.map((i) => i.platform_event_id),
      items.map((i) => i.content_hash),
      items.map((i) => i.vec),
      items.map((i) => i.model),
    ],
  );
}
