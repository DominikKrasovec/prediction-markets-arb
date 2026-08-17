/**
 * In-process cache of `known_entities`, keyed by foldAscii+lowercase so
 * accented and unaccented spellings share a bucket. Invalidated whenever a
 * row is written to known_entities. Underscore-prefixed exports are
 * module-internal; the public barrel re-exports only the rest.
 */

import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import type { KBLookupResult, KBRow, KBScope } from './types.js';
import { areSportsCompatible } from './sport-hierarchy.js';
import { isAliasDenied } from './alias-deny-list.js';
import { foldAscii } from './tokens.js';

const log = createLogger('entity-kb');

function _kbKey(s: string): string {
  return foldAscii(s).toLowerCase();
}

// No migration runner exists; created here (idempotent) to back the hot lower(canonical) probe.
export const KNOWN_ENTITIES_LOWER_CANONICAL_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS idx_known_entities_lower_canonical ON known_entities (lower(canonical))`;
let _lowerCanonicalIndexEnsured = false;
export async function ensureKnownEntitiesLowerCanonicalIndex(): Promise<void> {
  if (_lowerCanonicalIndexEnsured) return;
  await query(KNOWN_ENTITIES_LOWER_CANONICAL_INDEX_DDL);
  _lowerCanonicalIndexEnsured = true;
}
export function _resetLowerCanonicalIndexEnsuredForTests(): void {
  _lowerCanonicalIndexEnsured = false;
}

export const _kbByCanonical = new Map<string, KBRow[]>();
export const _kbByAlias = new Map<string, KBRow[]>();
let _kbLoaded = false;

export const _resolvedSubjectCache = new Map<string, string>();

let _newEntityCount = 0;

export function consumeNewEntityCount(): number {
  const n = _newEntityCount;
  _newEntityCount = 0;
  return n;
}

// External per-consumer caches keyed by known_entities.id; must clear on any KB mutation since ids can be dropped by merges.
const _externalInvalidators: Array<() => void> = [];

export function registerKBCacheInvalidator(fn: () => void): void {
  _externalInvalidators.push(fn);
}

function _runExternalInvalidators(): void {
  for (const fn of _externalInvalidators) {
    try { fn(); } catch (err) {
      log.warn(`KB cache invalidator threw: ${(err as Error).message}`);
    }
  }
}

export async function _ensureKBCache(): Promise<void> {
  if (_kbLoaded) return;
  const rows = await query<{
    id: number; canonical: string; domain_category: string; type: string;
    aliases: string; sport_canonical: string | null; league_canonical: string | null;
    tour_gender: string | null;
  }>(
    `SELECT id, canonical, domain_category, type, aliases::text,
            sport_canonical, league_canonical, metadata->>'tour_gender' AS tour_gender
       FROM known_entities`,
  );
  for (const r of rows) {
    const aliases: string[] = typeof r.aliases === 'string' ? JSON.parse(r.aliases) : r.aliases;
    const row: KBRow = {
      id: r.id, canonical: r.canonical, domain_category: r.domain_category,
      type: r.type, aliases,
      sport_canonical: r.sport_canonical,
      league_canonical: r.league_canonical,
      tour_gender: r.tour_gender,
    };
    const key = _kbKey(r.canonical);
    const bucket = _kbByCanonical.get(key);
    if (bucket) bucket.push(row); else _kbByCanonical.set(key, [row]);
    for (const alias of aliases) {
      const ak = _kbKey(alias);
      const ab = _kbByAlias.get(ak);
      if (ab) ab.push(row); else _kbByAlias.set(ak, [row]);
    }
  }
  _kbLoaded = true;
}

/** Test-only: primes the cache without touching @arb/db. */
export function _primeKBCacheForTests(rows: readonly KBRow[]): void {
  _kbByCanonical.clear();
  _kbByAlias.clear();
  _resolvedSubjectCache.clear();
  for (const row of rows) {
    const key = _kbKey(row.canonical);
    const bucket = _kbByCanonical.get(key);
    if (bucket) bucket.push(row); else _kbByCanonical.set(key, [row]);
    for (const alias of row.aliases) {
      const ak = _kbKey(alias);
      const ab = _kbByAlias.get(ak);
      if (ab) ab.push(row); else _kbByAlias.set(ak, [row]);
    }
  }
  _kbLoaded = true;
}

export function _kbCacheInsert(row: KBRow): void {
  _newEntityCount++;
  const key = _kbKey(row.canonical);
  const bucket = _kbByCanonical.get(key);
  if (bucket) { if (!bucket.find(r => r.id === row.id)) bucket.push(row); }
  else _kbByCanonical.set(key, [row]);
  for (const alias of row.aliases) {
    const ak = _kbKey(alias);
    const ab = _kbByAlias.get(ak);
    if (ab) { if (!ab.find(r => r.id === row.id)) ab.push(row); }
    else _kbByAlias.set(ak, [row]);
  }
}

/** Omit `id` to flush the whole cache. For an updated (not deleted) row, use `rehydrateKBCacheRow` instead — this leaves a gap that can mint a duplicate entity. */
export function invalidateKBCache(id?: number): void {
  if (id === undefined) {
    _kbByCanonical.clear();
    _kbByAlias.clear();
    _kbLoaded = false;
    _runExternalInvalidators();
    return;
  }
  for (const [k, arr] of _kbByCanonical) {
    const filtered = arr.filter(r => r.id !== id);
    if (filtered.length === 0) _kbByCanonical.delete(k);
    else _kbByCanonical.set(k, filtered);
  }
  for (const [k, arr] of _kbByAlias) {
    const filtered = arr.filter(r => r.id !== id);
    if (filtered.length === 0) _kbByAlias.delete(k);
    else _kbByAlias.set(k, filtered);
  }
  _runExternalInvalidators();
}

/** Re-reads row `id` from the DB into the cache; use instead of `invalidateKBCache(id)` when the row still exists. No-op if the cache isn't warm. */
export async function rehydrateKBCacheRow(id: number): Promise<void> {
  invalidateKBCache(id);
  if (!_kbLoaded) return;
  const rows = await query<{
    id: number; canonical: string; domain_category: string; type: string;
    aliases: string; sport_canonical: string | null; league_canonical: string | null;
    tour_gender: string | null;
  }>(
    `SELECT id, canonical, domain_category, type, aliases::text,
            sport_canonical, league_canonical, metadata->>'tour_gender' AS tour_gender
       FROM known_entities WHERE id = $1`,
    [id],
  );
  if (rows.length > 0) {
    const r = rows[0];
    const aliases: string[] = typeof r.aliases === 'string' ? JSON.parse(r.aliases) : r.aliases;
    _kbCacheInsert({
      id: r.id, canonical: r.canonical, domain_category: r.domain_category,
      type: r.type, aliases,
      sport_canonical: r.sport_canonical,
      league_canonical: r.league_canonical,
      tour_gender: r.tour_gender,
    });
  }
}

/** Drops resolvedSubjectCache entries pointing at any of `canonicals` (e.g. after a merge collapses an entity). */
export function purgeSubjectCacheByCanonicals(canonicals: string[]): void {
  if (canonicals.length === 0) return;
  const targets = new Set(canonicals.map((c) => _kbKey(c)));
  for (const [key, value] of _resolvedSubjectCache) {
    if (targets.has(_kbKey(value))) {
      _resolvedSubjectCache.delete(key);
    }
  }
}

export async function warmKBCache(): Promise<void> {
  await ensureKnownEntitiesLowerCanonicalIndex();
  _kbLoaded = false;
  _kbByCanonical.clear();
  _kbByAlias.clear();
  _resolvedSubjectCache.clear();
  _runExternalInvalidators();
  await _ensureKBCache();
  log.info(`Warm cache loaded: ${_kbByCanonical.size} canonicals, ${_kbByAlias.size} aliases`);
}

/** Cache-only; returns [] if not warmed. */
export function _kbNameRowsSync(name: string): KBRow[] {
  if (!_kbLoaded) return [];
  const k = _kbKey(name);
  if (!k) return [];
  return [...(_kbByCanonical.get(k) ?? []), ...(_kbByAlias.get(k) ?? [])];
}

export function _kbCacheLoaded(): boolean {
  return _kbLoaded;
}

/** Cache-only; returns [] if not warmed. */
export function _kbRowsByLowerCanonical(canonicalLower: string): KBRow[] {
  if (!_kbLoaded) return [];
  const bucket = _kbByCanonical.get(_kbKey(canonicalLower));
  if (!bucket) return [];
  return bucket.filter((r) => r.canonical.toLowerCase() === canonicalLower);
}

/** Warm-cache-only handle for discriminator specs: never queries the DB, and returns a fact only when all matching KB rows agree on it. */
export function kbFactsHandle(): import('../../discriminators/registry.js').WarmKbCache {
  const consensus = (vals: (string | null)[]): string | null => {
    const s = new Set(vals.filter((v): v is string => v != null));
    return s.size === 1 ? [...s][0] : null;
  };
  return {
    lookupCanonical(name: string) {
      if (!_kbLoaded) return null;
      const rows = _kbNameRowsSync(name);
      if (rows.length === 0) return null;
      return {
        type: consensus(rows.map((r) => r.type)),
        sport_canonical: consensus(rows.map((r) => r.sport_canonical)),
        league_canonical: consensus(rows.map((r) => r.league_canonical)),
        tour_gender: consensus(rows.map((r) => r.tour_gender ?? null)),
      };
    },
  };
}

/** Mirrors tier1()'s 3-step query logic from the in-process cache; falls back to a live query only if the cache isn't loaded. */
export async function _t1FromCache(
  textLower: string,
  originalText: string,
  domain: string,
  typeFilter: string[] | null,
  scope: KBScope | null = null,
): Promise<KBLookupResult | null> {
  await _ensureKBCache();

  const sportHint  = scope?.sport ?? null;
  const leagueHint = scope?.league ?? null;

  const domainScore = (r: KBRow) =>
    r.domain_category === domain ? 0 : (r.domain_category === 'other' || domain === 'other' ? 1 : 2);

  // axis score: 0 exact match, 1 scope-agnostic (null), 2 conflicting scope (reject); null hint skips the axis.
  const axisScore = (rowValue: string | null, hint: string | null): number => {
    if (hint === null) return 0;
    if (rowValue === hint) return 0;
    if (rowValue === null) return 1;
    return 2;
  };
  const sportScore = (r: KBRow): number => {
    if (sportHint === null) return 0;
    if (r.sport_canonical === sportHint) return 0;
    if (r.sport_canonical === null) return 1;
    if (areSportsCompatible(r.sport_canonical, sportHint)) return 1;
    return 2;
  };
  const leagueScore = (r: KBRow) => axisScore(r.league_canonical, leagueHint);

  const typeOk = (r: KBRow) => typeFilter === null || typeFilter.includes(r.type);

  // Hard filter (not just a sort key): a wrong-scope row can be the only candidate in a single-entity bucket.
  const scopeOk = (r: KBRow) =>
    sportScore(r) < 2 && leagueScore(r) < 2 && domainScore(r) < 2;

  // Rank by sport, then league, then domain; final tie-break is folded canonical text then id, not load order (must survive a rebuild).
  const rank = (a: KBRow, b: KBRow) => {
    const s = sportScore(a) - sportScore(b);
    if (s !== 0) return s;
    const l = leagueScore(a) - leagueScore(b);
    if (l !== 0) return l;
    const d = domainScore(a) - domainScore(b);
    if (d !== 0) return d;
    const af = _kbKey(a.canonical);
    const bf = _kbKey(b.canonical);
    if (af < bf) return -1;
    if (af > bf) return 1;
    return a.id - b.id;
  };

  const foldedKey = _kbKey(textLower);

  // Deny-list applies to alias tiers (T1b/T1c) only, never to a canonical match; domain-scoped entries stay honored in their home domain.
  const aliasAllowed = (r: KBRow) => !isAliasDenied(foldedKey, r.type, _kbKey(r.canonical), domain);

  const canonBucket = _kbByCanonical.get(foldedKey)?.filter(r => typeOk(r) && scopeOk(r)) ?? [];
  if (canonBucket.length > 0) {
    canonBucket.sort(rank);
    return { id: canonBucket[0].id, canonical: canonBucket[0].canonical };
  }

  const aliasBucketCS = _kbByAlias.get(foldedKey)
    ?.filter(r => typeOk(r) && scopeOk(r) && aliasAllowed(r) && r.aliases.includes(originalText)) ?? [];
  if (aliasBucketCS.length > 0) {
    aliasBucketCS.sort(rank);
    return { id: aliasBucketCS[0].id, canonical: aliasBucketCS[0].canonical };
  }

  const aliasBucketCI = _kbByAlias.get(foldedKey)?.filter(r => typeOk(r) && scopeOk(r) && aliasAllowed(r)) ?? [];
  if (aliasBucketCI.length > 0) {
    aliasBucketCI.sort(rank);
    return { id: aliasBucketCI[0].id, canonical: aliasBucketCI[0].canonical };
  }

  return null;
}
