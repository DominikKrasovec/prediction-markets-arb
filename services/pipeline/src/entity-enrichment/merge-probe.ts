/**
 * Merge probe: finds known_entities rows that may describe the same
 * real-world entity as a freshly-enriched row, and runs an LLM verifier
 * before merging. Additive — no candidates means no LLM call.
 */

import { query } from '@arb/db';
import { callLLM, loadPromptTemplate } from '@arb/llm';
import { createLogger } from '@arb/logger';
import { mergeKnownEntities, pickKeeper, type MergeUpdates } from './merge.js';
import { config } from '../config.js';
import {
  type EntitySnapshot,
  type RawEntitySnapshotRow,
  SNAPSHOT_SELECT_COLUMNS,
  MARKET_LINK_COUNT_LATERAL,
  SAMPLE_TITLES_LATERAL,
  rowToEntitySnapshot,
} from './entity-row-shared.js';
import { compatibleSportCanonicals } from '../db/entity/sport-hierarchy.js';
import { compatibleLeagueCanonicals } from '../db/entity/league-hierarchy.js';
import { computeAcronym, looksLikeAcronymOf, foldAscii, isStationScopedName } from '../db/entity/tokens.js';

export type { EntitySnapshot } from './entity-row-shared.js';

const verifyTemplate = loadPromptTemplate('entity_merge_verify');
const log = createLogger('entity-merge');

const MIN_CONFIDENCE = parseFloat(process.env.ENTITY_MERGE_MIN_CONFIDENCE ?? '0.85');
const MAX_CANDIDATES_PER_ENTITY = parseInt(process.env.ENTITY_MERGE_MAX_CANDIDATES_PER_ENTITY ?? '5');

/** League/competition-source stem tokens too generic to key the probe on; never strips the last remaining token. */
const LEAGUE_GENERIC_STEMS: ReadonlySet<string> = new Set([
  'league', 'liga', 'superliga', 'super', 'first', 'championship',
  'division', 'pro', 'premier', 'cup',
]);

function metadataCountry(metadata: Record<string, unknown> | undefined | null): string | null {
  if (!metadata) return null;
  const raw = metadata.country ?? metadata.nation;
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/** Strip generic competition-stem tokens; returns the original list unchanged if every token is generic. */
export function stripLeagueGenericStems(tokens: string[]): string[] {
  const kept = tokens.filter((t) => !LEAGUE_GENERIC_STEMS.has(t.toLowerCase()));
  return kept.length > 0 ? kept : tokens;
}

/** A proposed merge between an enriched entity (`source`) and a sibling. */
export interface MergeProposal {
  source: EntitySnapshot;
  candidate: EntitySnapshot;
  /** Corrections applied to the kept row only when the candidate is keeper and they beat its existing values. */
  sourceUpdates: MergeUpdates;
}

/** Find candidate sibling entities for every entity in `sources`, using the post-enrichment target canonical/aliases/metadata for both lookup and scope filters. */
export async function findMergeCandidates(
  sources: Array<{
    source: EntitySnapshot;
    targetCanonical: string;
    targetAliases: string[];
    targetMetadata: Record<string, unknown>;
    targetType: string;
  }>,
): Promise<MergeProposal[]> {
  if (sources.length === 0) return [];

  const proposals: MergeProposal[] = [];
  for (const s of sources) {
    const surface = new Set<string>();
    surface.add(foldAscii(s.targetCanonical).toLowerCase());
    for (const a of s.targetAliases) {
      const tl = foldAscii(a.trim()).toLowerCase();
      if (tl) surface.add(tl);
    }
    // Widen with the source's initials acronym so a sibling registered under just the acronym still matches.
    const sourceAcronym = computeAcronym(s.targetCanonical);
    if (sourceAcronym) surface.add(foldAscii(sourceAcronym).toLowerCase());
    if (surface.size === 0) continue;

    const surfaceArr = Array.from(surface);
    const targetSport  = (s.targetMetadata.sport_canonical  as string | undefined) ?? s.source.sport_canonical;
    const targetLeague = (s.targetMetadata.league_canonical as string | undefined) ?? s.source.league_canonical;

    // League rows carry league_canonical=NULL, so the league filter never narrows them; strip generic stems and require sport agreement instead.
    const isLeagueSource = s.source.type === 'league' || s.source.type === 'competition';

    const compatSports  = compatibleSportCanonicals(targetSport);
    const compatLeagues = compatibleLeagueCanonicals(targetLeague);

    // Non-permissive sport gate for league sources with a populated sport (drops the sport IS NULL arm).
    const strictSport = isLeagueSource && compatSports !== null && compatSports.length > 0;

    const stemTokens = surfaceArr
      .flatMap((str) => str.split(/\s+/))
      .filter((t) => t.length > 0);
    const effectiveStemTokens = isLeagueSource
      ? stripLeagueGenericStems(stemTokens)
      : stemTokens;
    const stemQueryString = effectiveStemTokens
      .map((t) => `'${t.replace(/'/g, "''")}'`)
      .join(' | ');
    const rows = await query<RawEntitySnapshotRow>(
      `SELECT ${SNAPSHOT_SELECT_COLUMNS}
       FROM known_entities ke
       ${MARKET_LINK_COUNT_LATERAL}
       ${SAMPLE_TITLES_LATERAL}
       WHERE ke.id <> $1
         AND (ke.domain_category = $2 OR ke.domain_category = 'other' OR $2 = 'other')
         AND ($3::text[] IS NULL OR
              CASE WHEN $9::bool
                   THEN ke.sport_canonical = ANY($3)
                   ELSE (ke.sport_canonical IS NULL OR ke.sport_canonical = ANY($3))
              END)
         AND ($4::text[] IS NULL OR ke.league_canonical IS NULL OR ke.league_canonical = ANY($4))
         AND (ke.type = $6 OR ke.type = 'unknown' OR $6 = 'unknown')
         AND (
           lower(immutable_unaccent(ke.canonical)) = ANY($5)
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(ke.aliases) a
             WHERE lower(immutable_unaccent(a)) = ANY($5)
           )
           OR ($8::text <> '' AND ke.stems_tsv @@ to_tsquery('english', $8))
         )
       ORDER BY (ke.enrichment_status = 'enriched') DESC, market_link_count DESC, ke.id ASC
       LIMIT $7`,
      [s.source.id, s.source.domain_category, compatSports, compatLeagues, surfaceArr, s.source.type, MAX_CANDIDATES_PER_ENTITY, stemQueryString, strictSport],
    );

    // Acronym-direction widening: when the source itself looks like an acronym, JS-filter same-type/scope-compatible rows by looksLikeAcronymOf.
    const sourceIsAcronym = /^[A-Z0-9]{2,5}$/.test(s.targetCanonical.trim());
    if (sourceIsAcronym) {
      const acronymRows = await query<RawEntitySnapshotRow>(
        `SELECT ${SNAPSHOT_SELECT_COLUMNS}
         FROM known_entities ke
         ${MARKET_LINK_COUNT_LATERAL}
         ${SAMPLE_TITLES_LATERAL}
         WHERE ke.id <> $1
           AND (ke.domain_category = $2 OR ke.domain_category = 'other' OR $2 = 'other')
           AND ($3::text[] IS NULL OR ke.sport_canonical IS NULL OR ke.sport_canonical = ANY($3))
           AND ($4::text[] IS NULL OR ke.league_canonical IS NULL OR ke.league_canonical = ANY($4))
           AND ke.type = $5
           AND ke.canonical ~ '\\s'
         ORDER BY (ke.enrichment_status = 'enriched') DESC, market_link_count DESC, ke.id ASC
         LIMIT 50`,
        [s.source.id, s.source.domain_category, compatSports, compatLeagues, s.source.type],
      );
      for (const r of acronymRows) {
        if (looksLikeAcronymOf(s.targetCanonical, r.canonical)) {
          rows.push(r);
        }
      }
    }

    const seenIds = new Set<number>();
    const dedupedRows: RawEntitySnapshotRow[] = [];
    for (const r of rows) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      dedupedRows.push(r);
      if (dedupedRows.length >= MAX_CANDIDATES_PER_ENTITY) break;
    }

    const sourceCountry = isLeagueSource
      ? (metadataCountry(s.targetMetadata) ?? metadataCountry(s.source.metadata))
      : null;

    for (const r of dedupedRows) {
      const candidate = rowToEntitySnapshot(r);

      // Station/venue-scoped and bare city/location entities are distinct by policy; mergeKnownEntities carries the same gate.
      if (isStationScopedName(s.targetCanonical) !== isStationScopedName(candidate.canonical)) {
        log.info(
          `[station-scope-gate] skip merge-probe source="${s.targetCanonical}" vs ` +
          `candidate="${candidate.canonical}" — station-scoped and bare-location ` +
          `entities are distinct by policy`,
        );
        continue;
      }

      if (isLeagueSource && sourceCountry) {
        const candCountry = metadataCountry(candidate.metadata);
        if (candCountry && candCountry !== sourceCountry) {
          log.info(
            `[league-country-gate] skip merge-probe source="${s.source.canonical}" ` +
            `(country=${sourceCountry}) vs candidate="${candidate.canonical}" ` +
            `(country=${candCountry}) — different national competition`,
          );
          continue;
        }
      }

      // Histogram gate: refuse/warn (per config mode) when category-overlap mass is below threshold on both sides.
      const mode = config.stage1.kbHistogramGateMode;
      if (mode !== 'off') {
        const gateOK = await histogramsOverlapEnough(s.source.id, candidate.id);
        if (!gateOK.ok) {
          log.warn(
            `[histogram-gate ${mode === 'enforce' ? 'REFUSE' : 'WARN'}] merge-probe ` +
            `source=${s.source.id} ("${s.source.canonical}") vs candidate=${candidate.id} ` +
            `("${candidate.canonical}"): max_overlap_mass=${gateOK.maxOverlap.toFixed(3)} ` +
            `< threshold=${config.stage1.kbHistogramGateMinMass} ` +
            `(top_overlap_category="${gateOK.topCategory ?? 'n/a'}")`,
          );
          if (mode === 'enforce') continue;
        }
      }

      proposals.push({
        source: s.source,
        candidate,
        sourceUpdates: {
          canonical: s.targetCanonical,
          type: s.targetType,
          metadataMerge: s.targetMetadata,
        },
      });
    }
  }
  return proposals;
}

/** Per-category overlap = min(shareA, shareB); passes when the max clears the threshold. Cold or 'other'-dominated sides always pass. */
async function histogramsOverlapEnough(
  sourceId: number,
  candidateId: number,
): Promise<{ ok: boolean; maxOverlap: number; topCategory: string | null }> {
  const probe = await query<{ entity_id: number; category: string; n: number }>(
    `SELECT entity_id, category, n FROM entity_category_counts WHERE entity_id = ANY($1)`,
    [[sourceId, candidateId]],
  );
  const dist = new Map<number, Map<string, number>>([[sourceId, new Map()], [candidateId, new Map()]]);
  for (const r of probe) {
    dist.get(r.entity_id)!.set(r.category, Number(r.n));
  }
  const src = dist.get(sourceId)!;
  const cnd = dist.get(candidateId)!;
  const srcTotal = [...src.values()].reduce((a, b) => a + b, 0);
  const cndTotal = [...cnd.values()].reduce((a, b) => a + b, 0);
  if (srcTotal === 0 || cndTotal === 0) {
    return { ok: true, maxOverlap: 1, topCategory: null };
  }
  const dominant = (m: Map<string, number>) => {
    let bestCat = '', bestN = -1;
    for (const [k, v] of m) if (v > bestN) { bestN = v; bestCat = k; }
    return bestCat;
  };
  if (dominant(src) === 'other' || dominant(cnd) === 'other') {
    return { ok: true, maxOverlap: 1, topCategory: 'other' };
  }
  const categories = new Set<string>([...src.keys(), ...cnd.keys()]);
  let maxOverlap = 0;
  let topCategory: string | null = null;
  for (const cat of categories) {
    const sShare = (src.get(cat) ?? 0) / srcTotal;
    const cShare = (cnd.get(cat) ?? 0) / cndTotal;
    const ov = Math.min(sShare, cShare);
    if (ov > maxOverlap) { maxOverlap = ov; topCategory = cat; }
  }
  const ok = maxOverlap >= config.stage1.kbHistogramGateMinMass;
  return { ok, maxOverlap, topCategory };
}

interface VerifyResult {
  same: boolean;
  confidence: number;
  keep?: 'a' | 'b';
  notes?: string;
}

/** Runs the LLM `entity_merge_verify` task on every proposed pair in one batch; results align with `proposals` order. */
export async function verifyMerges(proposals: MergeProposal[]): Promise<VerifyResult[]> {
  if (proposals.length === 0) return [];

  try {
    const { parsed } = await callLLM<{ pairs?: VerifyResult[] }>({
      task: 'entity_merge_verify',
      template: verifyTemplate,
      vars: {
        count: proposals.length,
        pairs: proposals.map((p, idx) => ({
          index: idx + 1,
          a_id: p.source.id,
          a_canonical: p.source.canonical,
          a_aliases_json: JSON.stringify(p.source.aliases),
          a_type: p.source.type,
          a_domain_category: p.source.domain_category,
          a_metadata_json: JSON.stringify(p.source.metadata),
          a_sample_titles: p.source.sample_titles,
          b_id: p.candidate.id,
          b_canonical: p.candidate.canonical,
          b_aliases_json: JSON.stringify(p.candidate.aliases),
          b_type: p.candidate.type,
          b_domain_category: p.candidate.domain_category,
          b_metadata_json: JSON.stringify(p.candidate.metadata),
          b_sample_titles: p.candidate.sample_titles,
        })),
      },
      items: proposals.length,
      context: { batchSize: proposals.length },
    });
    if (parsed && Array.isArray(parsed.pairs) && parsed.pairs.length === proposals.length) {
      return parsed.pairs;
    }
    throw new Error('LLM verifier response missing pairs[] of expected length');
  } catch (err) {
    // Verifier failure means "do not merge" — strictly safer than guessing.
    log.warn(`verifier failed (${proposals.length} pairs): ${err}. Skipping all proposed merges.`);
    return proposals.map(() => ({ same: false, confidence: 0 }));
  }
}

/** Runs mergeKnownEntities for every proposal above MIN_CONFIDENCE; returns source id -> kept id (callers must treat the source row as gone when the keeper is the candidate). */
export async function executeApprovedMerges(
  proposals: MergeProposal[],
  results: VerifyResult[],
): Promise<Map<number, { keptId: number; merged: boolean }>> {
  const outcomes = new Map<number, { keptId: number; merged: boolean }>();
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const r = results[i];
    // Already merged via an earlier proposal for the same source row in this batch — it may no longer exist.
    if (outcomes.has(p.source.id) && outcomes.get(p.source.id)!.merged) continue;

    if (!r.same || r.confidence < MIN_CONFIDENCE) {
      if (!outcomes.has(p.source.id)) outcomes.set(p.source.id, { keptId: p.source.id, merged: false });
      continue;
    }

    const a = p.source;
    const b = p.candidate;
    let keep: EntitySnapshot, drop: EntitySnapshot;
    if (r.keep === 'a')      { keep = a; drop = b; }
    else if (r.keep === 'b') { keep = b; drop = a; }
    else                     { ({ keep, drop } = pickKeeper(a, b)); }

    // Only apply the worker's intended corrections when the source row is the keeper.
    const keeperIsSource = keep.id === p.source.id;
    const updates: MergeUpdates = keeperIsSource
      ? p.sourceUpdates
      : {};

    try {
      const stat = await mergeKnownEntities(keep.id, drop.id, updates);
      if (stat.refused) {
        // Policy gate (station-scope) blocked the merge — nothing was written.
        log.info(
          `merge refused by policy gate for id=${drop.id} ("${drop.canonical}") → ` +
          `id=${keep.id} ("${keep.canonical}")`,
        );
        if (!outcomes.has(p.source.id)) outcomes.set(p.source.id, { keptId: p.source.id, merged: false });
        continue;
      }
      if (stat.alreadyMerged) {
        // Concurrent batch already collapsed this pair (both sides enriched in parallel workers).
        log.info(`already merged id=${drop.id} → id=${keep.id} (concurrent batch)`);
      } else {
        log.info(
          `merged id=${drop.id} ("${drop.canonical}") → id=${keep.id} ("${keep.canonical}"). ` +
          `marketLinksMoved=${stat.marketLinksMoved} aliasesAdded=${stat.aliasesAdded} ` +
          `confidence=${r.confidence.toFixed(2)} notes="${r.notes ?? ''}"`,
        );
      }
      outcomes.set(p.source.id, { keptId: keep.id, merged: true });
    } catch (err) {
      log.warn(`merge failed for ${drop.id}→${keep.id}: ${err}`);
      if (!outcomes.has(p.source.id)) outcomes.set(p.source.id, { keptId: p.source.id, merged: false });
    }
  }
  return outcomes;
}
