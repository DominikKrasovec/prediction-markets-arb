/**
 * Embedding-preserving-wipe cache — DB-free unit tests.
 *
 * Covers the mechanism's soundness core without touching the shared DB:
 *   · content_hash is deterministic + drift-sensitive (⇒ a changed embed-input
 *     never restores a stale vector — the merge-quality guarantee);
 *   · partitionEventsByCache: hash-match RESTORES, hash-miss RE-EMBEDS, cold
 *     cache (empty hits) ⇒ every event re-embeds (current behavior, no regression).
 */
import { describe, test, expect } from 'bun:test';
import {
  eventEmbeddingContentHash,
  eventCacheKey,
} from './event-embedding-cache.js';
import { partitionEventsByCache, buildEventEmbeddingInput, type EventRow } from './embed-events.js';

const ev = (over: Partial<EventRow>): EventRow => ({
  id: 1,
  platform: 'kalshi',
  platform_event_id: 'KXFOO-1',
  title: 'Some event title',
  canonical_subject: null,
  participants: null,
  league_canonical: null,
  embed_date: null,
  child_titles: null,
  ...over,
});

describe('eventEmbeddingContentHash', () => {
  test('deterministic — identical embed-input → identical hash (64-hex sha256)', () => {
    const h = eventEmbeddingContentHash('a\nb\n- c');
    expect(h).toBe(eventEmbeddingContentHash('a\nb\n- c'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('drift-sensitive — ANY embed-input change → different hash (never restores stale)', () => {
    const base = buildEventEmbeddingInput(ev({ child_titles: ['x', 'y'] }));
    expect(eventEmbeddingContentHash(base))
      .not.toBe(eventEmbeddingContentHash(buildEventEmbeddingInput(ev({ child_titles: ['x', 'z'] })))); // child changed
    expect(eventEmbeddingContentHash(base))
      .not.toBe(eventEmbeddingContentHash(buildEventEmbeddingInput(ev({ child_titles: ['x', 'y'], canonical_subject: 'Subj' })))); // subject added
    expect(eventEmbeddingContentHash(base))
      .not.toBe(eventEmbeddingContentHash(buildEventEmbeddingInput(ev({ child_titles: ['x', 'y'], embed_date: '2026-07-07' })))); // date added
  });
});

describe('eventCacheKey', () => {
  test('joins the natural key with a NUL separator', () => {
    expect(eventCacheKey('kalshi', 'KXFOO-1')).toBe(`kalshi${String.fromCharCode(0)}KXFOO-1`);
    // distinct events never collide
    expect(eventCacheKey('kalshi', 'A')).not.toBe(eventCacheKey('kalshi', 'B'));
    expect(eventCacheKey('polymarket', 'A')).not.toBe(eventCacheKey('kalshi', 'A'));
  });
});

describe('partitionEventsByCache', () => {
  const page: EventRow[] = [
    ev({ id: 10, platform: 'kalshi', platform_event_id: 'A' }),
    ev({ id: 11, platform: 'kalshi', platform_event_id: 'B' }),
    ev({ id: 12, platform: 'polymarket', platform_event_id: 'C' }),
  ];
  const texts = page.map(buildEventEmbeddingInput);
  const hashes = texts.map(eventEmbeddingContentHash);

  test('hash-match RESTORES — a cache hit yields a restore item, not an API miss', () => {
    const hits = new Map([[eventCacheKey('kalshi', 'B'), '[0.1,0.2]']]);
    const r = partitionEventsByCache(page, texts, hashes, hits);
    expect(r.restoreItems).toEqual([{ id: 11, vec: '[0.1,0.2]' }]);
    expect(r.missPage.map((e) => e.id)).toEqual([10, 12]); // the two non-hits re-embed
    expect(r.missTexts).toEqual([texts[0], texts[2]]);
    expect(r.missHashes).toEqual([hashes[0], hashes[2]]);
  });

  test('hash-miss RE-EMBEDS — an absent key (content_hash/model mismatch in lookup) goes to missPage', () => {
    // lookupEventEmbeddingCache only returns keys whose content_hash + model match,
    // so a drifted/stale event simply is not in `hits` → it must re-embed.
    const hits = new Map<string, string>(); // event B's hash changed ⇒ lookup returned nothing
    const r = partitionEventsByCache([page[1]], [texts[1]], [hashes[1]], hits);
    expect(r.restoreItems).toEqual([]);
    expect(r.missPage.map((e) => e.id)).toEqual([11]);
    expect(r.missHashes).toEqual([hashes[1]]);
  });

  test('cold cache (empty hits) ⇒ EVERY event re-embeds — identical to pre-cache behavior', () => {
    const r = partitionEventsByCache(page, texts, hashes, new Map());
    expect(r.restoreItems).toEqual([]);
    expect(r.missPage).toEqual(page);
    expect(r.missTexts).toEqual(texts);
    expect(r.missHashes).toEqual(hashes);
  });

  test('mixed page — restores + misses partition disjointly and completely', () => {
    const hits = new Map([
      [eventCacheKey('kalshi', 'A'), '[1]'],
      [eventCacheKey('polymarket', 'C'), '[3]'],
    ]);
    const r = partitionEventsByCache(page, texts, hashes, hits);
    expect(r.restoreItems.map((i) => i.id).sort()).toEqual([10, 12]);
    expect(r.missPage.map((e) => e.id)).toEqual([11]);
    expect(r.restoreItems.length + r.missPage.length).toBe(page.length); // no leaks/dupes
  });
});
