/**
 * Seed-time league/competition de-duplication. Always-run from seedEntityKB:
 * for every seeded league/competition, anchors the live row that owns its
 * canonical, re-asserts the curated alias set onto it, and folds any other
 * colliding row that is proven-same (sport/country/cross_league compatible,
 * not itself a different seed's anchor) into it. Idempotent; uses the
 * transactional `mergeKnownEntities` primitive so a fold is atomic. The
 * `mergeKnownEntities` import is lazy to break a module-load cycle.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { areSportsCompatible } from './entity/sport-hierarchy.js';
import { LEAGUES, COMPETITIONS, type EntitySeed } from './seed-entity-kb.js';

const log = createLogger('dedup-leagues');

/** Mirrors the SQL `lower(immutable_unaccent(x))` collision key. */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Normalises an ISO-2 code and an LLM full-name value to compare equal. */
const COUNTRY_FOLD: Record<string, string> = {
  gb: 'gb', england: 'gb', 'united kingdom': 'gb', uk: 'gb', wales: 'gb',
  scotland: 'scotland', // distinct nation — Scottish Premiership must NOT read as GB
  in: 'in', india: 'in', ru: 'ru', russia: 'ru', es: 'es', spain: 'es',
  de: 'de', germany: 'de', it: 'it', italy: 'it', fr: 'fr', france: 'fr',
  us: 'us', usa: 'us', 'united states': 'us', br: 'br', brazil: 'br',
  cz: 'cz', 'czech republic': 'cz', czechia: 'cz', kr: 'kr', 'south korea': 'kr',
  sa: 'sa', 'saudi arabia': 'sa', ar: 'ar', argentina: 'ar', eg: 'eg', egypt: 'eg',
  jp: 'jp', japan: 'jp', nl: 'nl', netherlands: 'nl', pt: 'pt', portugal: 'pt',
  at: 'at', austria: 'at', be: 'be', belgium: 'be', tr: 'tr', turkey: 'tr',
  hr: 'hr', croatia: 'hr', ca: 'ca', canada: 'ca', au: 'au', australia: 'au',
};
function foldCountry(c: string | null | undefined): string | null {
  if (c == null) return null;
  const k = c.trim().toLowerCase();
  if (!k) return null;
  return COUNTRY_FOLD[k] ?? k;
}
function countriesCompatible(a: string | null, b: string | null): boolean {
  const fa = foldCountry(a);
  const fb = foldCountry(b);
  return fa == null || fb == null || fa === fb;
}

interface LiveRow {
  id: number;
  canonical: string;
  type: string;
  sport_canonical: string | null;
  country: string | null;
  cross_league: boolean | null;
  enrichment_status: string;
  link_count: number;
  aliasFolds: Set<string>;
}

export interface DedupResult {
  seedsConsidered: number;
  anchorsFound: number;
  aliasesReasserted: number;
  rowsFolded: number;
  rowsFoldedLinks: number;
  childRowsFolded: number;
  rowsLeftSeparate: number;
  folds: Array<{ keepId: number; keepCanonical: string; dropId: number; dropCanonical: string; dropLinks: number }>;
  leftSeparate: Array<{ seedCanonical: string; candidateId: number; candidateCanonical: string; reason: string }>;
}

async function loadLiveLeagueRows(): Promise<LiveRow[]> {
  const rows = await query<{
    id: number;
    canonical: string;
    type: string;
    sport_canonical: string | null;
    country: string | null;
    cross_league: boolean | null;
    enrichment_status: string;
    aliases: unknown;
    link_count: number;
  }>(
    `SELECT ke.id, ke.canonical, ke.type, ke.sport_canonical,
            ke.metadata->>'country' AS country,
            (ke.metadata->>'cross_league')::bool AS cross_league,
            ke.enrichment_status, ke.aliases,
            (SELECT count(*)::int FROM market_entity_links mel WHERE mel.entity_id = ke.id) AS link_count
       FROM known_entities ke
      WHERE ke.type IN ('league','competition')`,
  );
  return rows.map((r) => {
    const aliasArr: string[] = Array.isArray(r.aliases)
      ? (r.aliases as string[])
      : JSON.parse((r.aliases as string) || '[]');
    const folds = new Set<string>([fold(r.canonical)]);
    for (const a of aliasArr) folds.add(fold(a));
    return {
      id: r.id,
      canonical: r.canonical,
      type: r.type,
      sport_canonical: r.sport_canonical,
      country: r.country,
      cross_league: r.cross_league == null ? null : r.cross_league === true,
      enrichment_status: r.enrichment_status,
      link_count: r.link_count,
      aliasFolds: folds,
    };
  });
}

/** Alias UNION onto the anchor row; returns the number of NEW aliases written. */
async function reassertAliases(anchorId: number, aliases: string[]): Promise<number> {
  if (aliases.length === 0) return 0;
  const before = await query<{ n: number }>(
    `SELECT jsonb_array_length(aliases)::int AS n FROM known_entities WHERE id = $1`,
    [anchorId],
  );
  await query(
    `UPDATE known_entities
        SET aliases = (
              SELECT jsonb_agg(DISTINCT alias ORDER BY alias)
              FROM (
                SELECT jsonb_array_elements_text(aliases) AS alias
                UNION
                SELECT unnest($2::text[])
              ) sub
            ),
            updated_at = NOW()
      WHERE id = $1`,
    [anchorId, aliases],
  );
  const after = await query<{ n: number }>(
    `SELECT jsonb_array_length(aliases)::int AS n FROM known_entities WHERE id = $1`,
    [anchorId],
  );
  return Math.max(0, (after[0]?.n ?? 0) - (before[0]?.n ?? 0));
}

type MergeFn = (typeof import('../entity-enrichment/merge.js'))['mergeKnownEntities'];

/** Pre-folds child entity rows whose merge-driven league_canonical rewrite
 *  would otherwise collide with an existing anchor-side twin. Best-effort per child. */
async function foldChildLeagueRefs(
  mergeKnownEntities: MergeFn,
  dupLeagueCanonical: string,
  anchorLeagueCanonical: string,
): Promise<number> {
  if (dupLeagueCanonical === anchorLeagueCanonical) return 0;
  const pairs = await query<{ drop_id: number; keep_id: number; canonical: string }>(
    `SELECT d.id AS drop_id, k.id AS keep_id, d.canonical
       FROM known_entities d
       JOIN known_entities k
         ON lower(immutable_unaccent(k.canonical)) = lower(immutable_unaccent(d.canonical))
        AND k.sport_canonical IS NOT DISTINCT FROM d.sport_canonical
        AND k.type = d.type
        AND k.league_canonical = $2
        AND k.id <> d.id
      WHERE d.league_canonical = $1`,
    [dupLeagueCanonical, anchorLeagueCanonical],
  );
  let folded = 0;
  const done = new Set<number>();
  for (const p of pairs) {
    if (done.has(p.drop_id)) continue;
    if (p.keep_id === p.drop_id) continue;
    try {
      const m = await mergeKnownEntities(p.keep_id, p.drop_id);
      if (!m.refused) { folded++; done.add(p.drop_id); }
    } catch (err) {
      log.warn(
        `[dedup-leagues] child pre-fold failed drop=${p.drop_id} "${p.canonical}" → keep=${p.keep_id}: ${err}`,
      );
    }
  }
  return folded;
}

export async function seedLeagueDedup(): Promise<DedupResult> {
  const result: DedupResult = {
    seedsConsidered: 0,
    anchorsFound: 0,
    aliasesReasserted: 0,
    rowsFolded: 0,
    rowsFoldedLinks: 0,
    childRowsFolded: 0,
    rowsLeftSeparate: 0,
    folds: [],
    leftSeparate: [],
  };

  const seeds: EntitySeed[] = [...LEAGUES, ...COMPETITIONS];
  const seedCanonicalFolds = new Set(seeds.map((s) => fold(s.canonical)));

  const { mergeKnownEntities } = await import('../entity-enrichment/merge.js');

  let live = await loadLiveLeagueRows();
  const droppedIds = new Set<number>();

  for (const s of seeds) {
    result.seedsConsidered++;
    const sCanonFold = fold(s.canonical);
    const sFolds = new Set<string>([sCanonFold, ...s.aliases.map(fold)]);
    const sSport = (s.metadata.sport_canonical as string | undefined) ?? null;
    const sCountry = (s.metadata.country as string | undefined) ?? null;
    const sCrossLeague = s.metadata.cross_league === true;

    const anchorCandidates = live
      .filter((r) =>
        !droppedIds.has(r.id) &&
        fold(r.canonical) === sCanonFold &&
        areSportsCompatible(sSport, r.sport_canonical) &&
        countriesCompatible(sCountry, r.country))
      .sort((a, b) => {
        const aExact = sSport != null && a.sport_canonical === sSport;
        const bExact = sSport != null && b.sport_canonical === sSport;
        if (aExact !== bExact) return aExact ? -1 : 1;
        if ((a.enrichment_status === 'enriched') !== (b.enrichment_status === 'enriched')) {
          return a.enrichment_status === 'enriched' ? -1 : 1;
        }
        if (a.link_count !== b.link_count) return b.link_count - a.link_count;
        return a.id - b.id;
      });
    let anchor = anchorCandidates[0] ?? null;

    if (anchor == null) {
      continue;
    }
    result.anchorsFound++;

    const reasserted = await reassertAliases(anchor.id, s.aliases);
    result.aliasesReasserted += reasserted;

    for (const cand of live) {
      if (cand.id === anchor.id || droppedIds.has(cand.id)) continue;
      let shares = false;
      for (const f of cand.aliasFolds) {
        if (sFolds.has(f)) { shares = true; break; }
      }
      if (!shares) continue;

      const candCanonFold = fold(cand.canonical);
      if (candCanonFold !== sCanonFold && seedCanonicalFolds.has(candCanonFold)) {
        result.rowsLeftSeparate++;
        result.leftSeparate.push({
          seedCanonical: s.canonical, candidateId: cand.id, candidateCanonical: cand.canonical,
          reason: `candidate canonical "${cand.canonical}" is itself a seeded league/competition`,
        });
        continue;
      }
      if (!areSportsCompatible(sSport, cand.sport_canonical)) {
        result.rowsLeftSeparate++;
        result.leftSeparate.push({
          seedCanonical: s.canonical, candidateId: cand.id, candidateCanonical: cand.canonical,
          reason: `sport incompatible (seed=${sSport ?? 'NULL'} vs cand=${cand.sport_canonical ?? 'NULL'})`,
        });
        continue;
      }
      if (!countriesCompatible(sCountry, cand.country)) {
        result.rowsLeftSeparate++;
        result.leftSeparate.push({
          seedCanonical: s.canonical, candidateId: cand.id, candidateCanonical: cand.canonical,
          reason: `country incompatible (seed=${sCountry ?? 'NULL'} vs cand=${cand.country ?? 'NULL'})`,
        });
        continue;
      }
      if (cand.cross_league != null && sCrossLeague !== cand.cross_league) {
        result.rowsLeftSeparate++;
        result.leftSeparate.push({
          seedCanonical: s.canonical, candidateId: cand.id, candidateCanonical: cand.canonical,
          reason: `cross_league flag mismatch (seed=${sCrossLeague} vs cand=${cand.cross_league})`,
        });
        continue;
      }

      try {
        const childFolds = await foldChildLeagueRefs(mergeKnownEntities, cand.canonical, anchor.canonical);
        result.childRowsFolded += childFolds;
        const m = await mergeKnownEntities(anchor.id, cand.id);
        if (m.refused) {
          result.rowsLeftSeparate++;
          result.leftSeparate.push({
            seedCanonical: s.canonical, candidateId: cand.id, candidateCanonical: cand.canonical,
            reason: 'mergeKnownEntities refused (station-scope policy gate)',
          });
          continue;
        }
        droppedIds.add(cand.id);
        result.rowsFolded++;
        result.rowsFoldedLinks += cand.link_count;
        result.folds.push({
          keepId: anchor.id, keepCanonical: anchor.canonical,
          dropId: cand.id, dropCanonical: cand.canonical, dropLinks: cand.link_count,
        });
        log.info(
          `[dedup-leagues] folded id=${cand.id} "${cand.canonical}" → anchor id=${anchor.id} ` +
          `"${anchor.canonical}" (seed "${s.canonical}", ${cand.link_count} links moved` +
          `${m.alreadyMerged ? ', already-merged' : ''})`,
        );
        for (const f of cand.aliasFolds) anchor.aliasFolds.add(f);
        anchor.aliasFolds.add(fold(cand.canonical));
      } catch (err) {
        result.rowsLeftSeparate++;
        result.leftSeparate.push({
          seedCanonical: s.canonical, candidateId: cand.id, candidateCanonical: cand.canonical,
          reason: `merge error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
        });
        log.warn(`[dedup-leagues] merge failed id=${cand.id} → ${anchor.id}: ${err}`);
      }
    }
  }

  live = live.filter((r) => !droppedIds.has(r.id));
  void live;

  return result;
}
