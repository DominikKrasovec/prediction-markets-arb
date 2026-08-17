/**
 * Entity-enrichment worker pool. Drains `entity_enrichment_queue` in claimed
 * batches: classifies each entity, sends the batch through one LLM call, and
 * UPSERT-merges the result into known_entities (metadata/aliases merged,
 * optional canonical swap guarded by the (canonical, sport, league) unique
 * constraint).
 */
import { query } from '@arb/db';
import { callLLM, loadPromptTemplate } from '@arb/llm';
import { createLogger } from '@arb/logger';
import {
  claimEnrichmentBatch,
  markEnrichmentDone,
  markEnrichmentFailed,
  markEnrichmentSkipped,
  recoverStuckEnrichment,
  setEnrichmentTypeHint,
  type EnrichmentClaim,
} from '../db/queries/entity-enrichment-queue.js';
import { classifyEntity, type EntityContext, type EntityClassification } from './entity-heuristic.js';
import {
  findMergeCandidates,
  verifyMerges,
  executeApprovedMerges,
  type MergeProposal,
} from './merge-probe.js';
import { resolveTaxonomyCanonical, normalizeSportCanonical, getTaxonomyContext, sportResolver, leagueResolver } from '../db/entity-registry.js';
import { ESPORTS_GAMES, ESPORTS_UMBRELLA } from '../db/entity/sport-hierarchy.js';
import { isCrossLeague } from '../db/entity/register.js';
import { looksLikePredicate, kbHasRealEntity } from '../db/entity/resolvers.js';
import { beltHit } from '../discriminators/telemetry.js';
import { ENTITY_TYPES, STRUCTURAL_ENTITY_TYPES, type DomainCategory } from '@arb/types';
import { parseJsonbArray, parseJsonbObject } from '@arb/db';
import { isStationScopedName, stationCityContext } from '../db/entity/tokens.js';
import {
  type BaseEntityRow,
  type EntitySnapshot,
  type RawEntitySnapshotRow,
  BASE_ENTITY_COLUMNS,
  SAMPLE_TITLES_COLUMN,
  SAMPLE_DESCRIPTIONS_COLUMN,
  SAMPLE_PLATFORMS_COLUMN,
  SAMPLE_TITLES_LATERAL,
  CO_ENTITIES_CANONICALS_COLUMN,
  CO_ENTITIES_TYPES_COLUMN,
  CO_ENTITIES_LATERAL,
  PARENT_EVENT_TITLES_COLUMN,
  PARENT_EVENT_TITLE_VALUES_COLUMN,
  PARENT_EVENT_TITLES_LATERAL,
  SNAPSHOT_SELECT_COLUMNS,
  MARKET_LINK_COUNT_LATERAL,
  rowToEntitySnapshot,
  extractUsefulDescription,
} from './entity-row-shared.js';

export interface EntityRow extends BaseEntityRow {
  sample_descriptions: string[];
  co_entities: { canonical: string; type: string }[];
  parent_events: { platform: string; title: string }[];
  tag_slugs: string[];
  limitless_sport: string | null;
  limitless_league: string | null;
  kalshi_ticker_prefix: string | null;
  predict_tag_names: string[] | null;
}

export interface LLMEnrichmentItem {
  canonical_corrected: string;
  type: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  // Aliases for a newly-proposed sport/league not in known_sports/known_leagues; registers a level-1 entity automatically.
  new_sport_aliases?: string[];
  new_league_aliases?: string[];
  confidence: number;
  notes?: string;
}

const DEFAULT_WORKERS = parseInt(process.env.ENTITY_ENRICHMENT_WORKERS ?? '4');
const DEFAULT_BATCH_SIZE = parseInt(process.env.ENTITY_ENRICHMENT_BATCH_SIZE ?? '25');
const IDLE_BACKOFF_MS = parseInt(process.env.ENTITY_ENRICHMENT_IDLE_BACKOFF_MS ?? '500');
const MIN_CONFIDENCE = parseFloat(process.env.ENTITY_ENRICHMENT_MIN_CONFIDENCE ?? '0.5');

const promptTemplate = loadPromptTemplate('entity_enrichment');
const log = createLogger('entity-enrichment');
const mergeLog = createLogger('entity-merge');

export interface EnrichmentWorkerOptions {
  workers?: number;
  batchSize?: number;
  drainAndExit?: boolean;
  maxRows?: number;
}

export interface EnrichmentWorkerResult {
  enriched: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

export async function runEntityEnrichmentWorkers(
  opts: EnrichmentWorkerOptions = {},
): Promise<EnrichmentWorkerResult> {
  const workers = opts.workers ?? DEFAULT_WORKERS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const drainAndExit = opts.drainAndExit ?? true;
  const maxRows = opts.maxRows ?? Infinity;
  const start = Date.now();

  const reclaimed = await recoverStuckEnrichment();
  if (reclaimed > 0) {
    log.info(`Reclaimed ${reclaimed} stuck rows`);
  }

  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  let reservedRows = 0;
  let activeWorkers = 0;

  const workerLoop = async (workerId: string): Promise<void> => {
    while (true) {
      const remainingBudget = maxRows - reservedRows;
      if (remainingBudget <= 0) return;

      const claimLimit = Math.min(batchSize, remainingBudget);
      reservedRows += claimLimit;
      activeWorkers++;

      let claims: EnrichmentClaim[];
      try {
        claims = await claimEnrichmentBatch(workerId, claimLimit);
      } catch (err) {
        reservedRows -= claimLimit;
        activeWorkers--;
        throw err;
      }

      if (claims.length === 0) {
        reservedRows -= claimLimit;
        activeWorkers--;
        if (drainAndExit && activeWorkers === 0) return;
        await sleep(IDLE_BACKOFF_MS);
        continue;
      }

      if (claims.length < claimLimit) {
        reservedRows -= claimLimit - claims.length;
      }

      try {
        const r = await processClaims(claims);
        enriched += r.enriched;
        skipped += r.skipped;
        failed += r.failed;
      } finally {
        activeWorkers--;
      }
    }
  };

  log.info(
    `Starting ${workers} workers (batch=${batchSize}, drainAndExit=${drainAndExit})`,
  );
  await Promise.all(Array.from({ length: workers }, (_, i) => workerLoop(`enrich-w${i}`)));

  const durationMs = Date.now() - start;
  log.info(
    `Done: enriched=${enriched} skipped=${skipped} failed=${failed} (${durationMs}ms)`,
  );
  return { enriched, skipped, failed, durationMs };
}

// Per-batch processing

async function processClaims(claims: EnrichmentClaim[]): Promise<{ enriched: number; skipped: number; failed: number }> {
  const ids = claims.map((c) => c.entity_id);
  const rows = await loadEntities(ids);
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  let missingRows = 0;

  const entityContexts: { claim: EnrichmentClaim; row: EntityRow; entityCtx: EntityContext }[] = [];

  for (const claim of claims) {
    const row = rowsById.get(claim.entity_id);
    if (!row) {
      await markEnrichmentSkipped(claim.id, 'entity_not_found');
      missingRows++;
      continue;
    }
    const entityCtx: EntityContext = {
      canonical:            row.canonical,
      aliases:              row.aliases,
      domain_category:      (row.domain_category as DomainCategory),
      current_type:         row.type,
      sample_titles:        row.sample_titles ?? [],
      tag_slugs:            row.tag_slugs ?? [],
      limitless_sport:      row.limitless_sport ?? null,
      limitless_league:     row.limitless_league ?? null,
      kalshi_ticker_prefix: row.kalshi_ticker_prefix ?? null,
      predict_tag_names:    row.predict_tag_names ?? null,
    };
    entityContexts.push({ claim, row, entityCtx });
  }

  const classifyResults = entityContexts.map((e) => classifyEntity(e.entityCtx));

  type WroteOutcome = { kind: 'wrote'; claim: EnrichmentClaim; row: EntityRow; prepared: PreparedEnrichment };
  type CollisionOutcome = { kind: 'collision'; claim: EnrichmentClaim; row: EntityRow; prepared: PreparedEnrichment; collidesWithId: number };

  const wrote: WroteOutcome[] = [];
  const collisions: CollisionOutcome[] = [];

  const contexts: { claim: EnrichmentClaim; row: EntityRow; classification: EntityClassification }[] = [];

  for (let i = 0; i < entityContexts.length; i++) {
    const { claim, row } = entityContexts[i];
    const classification = classifyResults[i];
    await setEnrichmentTypeHint(claim.id, classification.entity_type);

    contexts.push({ claim, row, classification });
  }

  let llmResults: LLMEnrichmentItem[] = [];
  if (contexts.length > 0) {
    try {
      llmResults = await callEnrichmentLLM(contexts);
    } catch (err) {
      const msg = String(err);
      for (const c of contexts) {
        await markEnrichmentFailed(c.claim.id, msg);
      }
      log.warn(`Batch LLM call failed: ${msg}`);
      contexts.length = 0;
    }
  }

  let earlySkipped = 0;
  let earlyFailed = 0;

  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i];
    const result = llmResults[i];
    if (!result) {
      await markEnrichmentFailed(ctx.claim.id, 'missing_llm_result_for_index');
      earlyFailed++;
      continue;
    }
    if (typeof result.canonical_corrected !== 'string' || result.canonical_corrected.trim().length === 0) {
      await markEnrichmentSkipped(ctx.claim.id, 'empty_canonical_corrected');
      await query(`UPDATE known_entities SET enrichment_status = 'failed', updated_at = NOW() WHERE id = $1`, [ctx.row.id]);
      earlySkipped++;
      continue;
    }
    const confidence = Number(result.confidence);
    if (!Number.isFinite(confidence)) {
      await markEnrichmentSkipped(ctx.claim.id, 'invalid_confidence');
      await query(`UPDATE known_entities SET enrichment_status = 'failed', updated_at = NOW() WHERE id = $1`, [ctx.row.id]);
      earlySkipped++;
      continue;
    }
    if (confidence < MIN_CONFIDENCE) {
      await markEnrichmentSkipped(ctx.claim.id, `low_confidence:${confidence.toFixed(2)}`);
      await query(`UPDATE known_entities SET enrichment_status = 'failed', updated_at = NOW() WHERE id = $1`, [ctx.row.id]);
      earlySkipped++;
      continue;
    }

    const outcome = await applyEnrichment(ctx.row, result);
    if (outcome.kind === 'wrote') {
      wrote.push({ kind: 'wrote', claim: ctx.claim, row: ctx.row, prepared: outcome.prepared });
    } else if (outcome.kind === 'collision') {
      collisions.push({ kind: 'collision', claim: ctx.claim, row: ctx.row, prepared: outcome.prepared, collidesWithId: outcome.collidesWithId });
    } else {
      await markEnrichmentSkipped(ctx.claim.id, outcome.reason);
      await query(`UPDATE known_entities SET enrichment_status = 'failed', updated_at = NOW() WHERE id = $1`, [ctx.row.id]);
      earlySkipped++;
    }
  }

  const mergeOutcomes = await runMergeProbe(wrote, collisions);

  let enriched = 0, skipped = 0, failed = 0;

  for (const w of wrote) {
    const result = mergeOutcomes.byClaim.get(w.claim.id);
    if (result?.merged) {
      await markEnrichmentDone(w.claim.id);
    } else {
      await markEnrichmentDone(w.claim.id);
    }
    enriched++;
  }

  for (const c of collisions) {
    const result = mergeOutcomes.byClaim.get(c.claim.id);
    if (result?.merged) {
      await markEnrichmentDone(c.claim.id);
      enriched++;
    } else {
      const reason = `collision_unresolved:other_id=${c.collidesWithId}`;
      await markEnrichmentSkipped(c.claim.id, reason);
      await query(`UPDATE known_entities SET enrichment_status = 'failed', updated_at = NOW() WHERE id = $1`, [c.row.id]);
      skipped++;
    }
  }

  return {
    enriched,
    skipped: skipped + earlySkipped + missingRows,
    failed: failed + earlyFailed,
  };
}

// Merge probe orchestration

interface MergeProbeOutcomes {
  byClaim: Map<number, { merged: boolean; keptId: number }>;
}

async function runMergeProbe(
  wrote: { claim: EnrichmentClaim; row: EntityRow; prepared: PreparedEnrichment }[],
  collisions: { claim: EnrichmentClaim; row: EntityRow; prepared: PreparedEnrichment; collidesWithId: number }[],
): Promise<MergeProbeOutcomes> {
  const byClaim = new Map<number, { merged: boolean; keptId: number }>();
  if (wrote.length === 0 && collisions.length === 0) return { byClaim };

  if (process.env.ENTITY_MERGE_PROBE_SKIP === '1') return { byClaim };

  const allRowIds = [
    ...wrote.map((w) => w.row.id),
    ...collisions.flatMap((c) => [c.row.id, c.collidesWithId]),
  ];
  const snapshots = await loadEntitySnapshots(Array.from(new Set(allRowIds)));

  const directProposals: MergeProposal[] = [];
  const collisionByClaim = new Map<number, { source: EntitySnapshot; candidate: EntitySnapshot }>();
  for (const c of collisions) {
    const source = snapshots.get(c.row.id);
    const candidate = snapshots.get(c.collidesWithId);
    if (!source || !candidate) continue;
    const proposal: MergeProposal = {
      source,
      candidate,
      sourceUpdates: {
        canonical: c.prepared.correctedCanonical,
        type: c.prepared.newType,
        metadataMerge: c.prepared.mergedMetadata,
      },
    };
    directProposals.push(proposal);
    collisionByClaim.set(c.claim.id, { source, candidate });
  }

  const wroteSources = wrote
    .map((w) => {
      const snap = snapshots.get(w.row.id);
      if (!snap) return null;
      return {
        source: snap,
        targetCanonical: w.prepared.correctedCanonical,
        targetAliases: w.prepared.mergedAliases,
        targetMetadata: w.prepared.mergedMetadata,
        targetType: w.prepared.newType,
      };
    })
    .filter(<T,>(v: T | null): v is T => v !== null);

  const scannedProposals = await findMergeCandidates(wroteSources);

  const seenPairs = new Set<string>();
  const allProposals: MergeProposal[] = [];
  for (const p of [...directProposals, ...scannedProposals]) {
    const key = `${p.source.id}:${p.candidate.id}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    allProposals.push(p);
  }

  if (allProposals.length === 0) return { byClaim };

  mergeLog.info(`Probing ${allProposals.length} candidate pair(s) (collisions=${directProposals.length}, alias-overlap=${scannedProposals.length})`);

  const verifyResults = await verifyMerges(allProposals);
  const sourceOutcomes = await executeApprovedMerges(allProposals, verifyResults);

  const claimBySourceId = new Map<number, number>();
  for (const w of wrote) claimBySourceId.set(w.row.id, w.claim.id);
  for (const c of collisions) claimBySourceId.set(c.row.id, c.claim.id);

  for (const [sourceId, outcome] of sourceOutcomes) {
    const claimId = claimBySourceId.get(sourceId);
    if (claimId !== undefined) {
      byClaim.set(claimId, { merged: outcome.merged, keptId: outcome.keptId });
    }
  }

  return { byClaim };
}

async function loadEntitySnapshots(ids: number[]): Promise<Map<number, EntitySnapshot>> {
  if (ids.length === 0) return new Map();
  const rows = await query<RawEntitySnapshotRow>(
    `SELECT ${SNAPSHOT_SELECT_COLUMNS}
     FROM known_entities ke
     ${MARKET_LINK_COUNT_LATERAL}
     ${SAMPLE_TITLES_LATERAL}
     WHERE ke.id = ANY($1::int[])`,
    [ids],
  );
  const m = new Map<number, EntitySnapshot>();
  for (const r of rows) {
    m.set(r.id, rowToEntitySnapshot(r));
  }
  return m;
}

// DB I/O

async function loadEntities(ids: number[]): Promise<EntityRow[]> {
  if (ids.length === 0) return [];
  const rawRows = await query<{
    id: number; canonical: string; type: string;
    aliases: unknown; metadata: unknown;
    domain_category: string; enrichment_status: string;
    sample_titles: string[];
    sample_descriptions: (string | null)[];
    sample_platforms: string[];
    co_entity_canonicals: string[];
    co_entity_types: string[];
    parent_event_platforms: string[];
    parent_event_titles: string[];
    tag_slugs: string[];
    limitless_sport: string | null; limitless_league: string | null;
    kalshi_ticker_prefix: string | null;
    predict_tag_names: string[] | null;
  }>(
    `SELECT ${BASE_ENTITY_COLUMNS},
            ${SAMPLE_TITLES_COLUMN},
            ${SAMPLE_DESCRIPTIONS_COLUMN},
            ${SAMPLE_PLATFORMS_COLUMN},
            ${CO_ENTITIES_CANONICALS_COLUMN},
            ${CO_ENTITIES_TYPES_COLUMN},
            ${PARENT_EVENT_TITLES_COLUMN},
            ${PARENT_EVENT_TITLE_VALUES_COLUMN},
            COALESCE(poly_slugs.slugs, ARRAY[]::text[]) AS tag_slugs,
            lim_meta.esport_title                        AS limitless_sport,
            lim_meta.league_name                         AS limitless_league,
            kalshi_meta.ticker_prefix                    AS kalshi_ticker_prefix,
            predict_meta.tag_names                       AS predict_tag_names
     FROM known_entities ke
     ${SAMPLE_TITLES_LATERAL}
     ${CO_ENTITIES_LATERAL}
     ${PARENT_EVENT_TITLES_LATERAL}
     LEFT JOIN LATERAL (
       SELECT ARRAY(
         SELECT DISTINCT unnest(m2.tag_slugs)
         FROM market_entity_links mel2
         JOIN markets m2 ON m2.id = mel2.market_id
         WHERE mel2.entity_id = ke.id
           AND m2.tag_slugs IS NOT NULL
           AND array_length(m2.tag_slugs, 1) > 0
       ) AS slugs
     ) poly_slugs ON TRUE
     LEFT JOIN LATERAL (
       SELECT
         MAX(mmr.raw -> 'metadata' ->> 'esportTitle') AS esport_title,
         MAX(mmr.raw -> 'metadata' ->> 'leagueName')  AS league_name
       FROM market_entity_links mel3
       JOIN markets m3         ON m3.id = mel3.market_id
       JOIN market_metadata_raw mmr ON mmr.market_id = m3.id
       WHERE mel3.entity_id = ke.id
         AND m3.platform = 'limitless'
         AND (mmr.raw -> 'metadata' ->> 'esportTitle' IS NOT NULL
           OR mmr.raw -> 'metadata' ->> 'leagueName'  IS NOT NULL)
     ) lim_meta ON TRUE
     LEFT JOIN LATERAL (
       SELECT split_part(
         COALESCE(
           MIN(mmr.raw ->> 'event_ticker') FILTER (WHERE split_part(mmr.raw ->> 'event_ticker', '-', 1) NOT LIKE 'KXMVE%'),
           MIN(mmr.raw ->> 'event_ticker')
         ), '-', 1) AS ticker_prefix
       FROM market_entity_links mel4
       JOIN markets m4          ON m4.id = mel4.market_id AND m4.platform = 'kalshi'
       JOIN market_metadata_raw mmr ON mmr.market_id = m4.id
       WHERE mel4.entity_id = ke.id
         AND mmr.raw ->> 'event_ticker' IS NOT NULL
     ) kalshi_meta ON TRUE
     LEFT JOIN LATERAL (
       SELECT ARRAY(
         SELECT DISTINCT t->>'name'
         FROM market_entity_links mel5
         JOIN markets m5 ON m5.id = mel5.market_id AND m5.platform = 'predict'
         JOIN predict_categories pc ON pc.raw->>'slug' = m5.category
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(pc.raw->'tags', '[]'::jsonb)) t
         WHERE mel5.entity_id = ke.id
           AND t->>'name' IS NOT NULL
       ) AS tag_names
     ) predict_meta ON TRUE
     WHERE ke.id = ANY($1::int[])`,
    [ids],
  );
  return rawRows.map((r) => {
    const sample_descriptions: string[] = [];
    for (let i = 0; i < r.sample_descriptions.length; i++) {
      const extracted = extractUsefulDescription(
        r.sample_descriptions[i],
        r.sample_platforms[i] ?? '',
      );
      if (extracted) sample_descriptions.push(extracted);
    }
    const co_entities = r.co_entity_canonicals.map((canonical, i) => ({
      canonical,
      type: r.co_entity_types[i] ?? 'unknown',
    }));
    // platforms[i]/titles[i] are positionally aligned (both sort by platform ASC in the LATERAL).
    const parent_events = r.parent_event_platforms.map((platform, i) => ({
      platform,
      title: r.parent_event_titles[i] ?? '',
    })).filter((pe) => pe.title.length > 0);
    return {
      ...r,
      aliases: parseJsonbArray(r.aliases),
      metadata: parseJsonbObject(r.metadata),
      sample_descriptions,
      co_entities,
      parent_events,
    };
  });
}

export interface PreparedEnrichment {
  correctedCanonical: string;
  newType: string;
  mergedAliases: string[];
  mergedMetadata: Record<string, unknown>;
}

type ApplyOutcome =
  | { kind: 'wrote'; prepared: PreparedEnrichment }
  | { kind: 'collision'; prepared: PreparedEnrichment; collidesWithId: number }
  | { kind: 'invalid'; reason: string };


// isNonPerson must be derived from the post-swap type, not the row's current type; despace fold only applies when true (two people despace-folding to the same string stay separate).
export function buildFoldCollisionQuery(
  correctedCanonical: string,
  rowId: number,
  sportArg: string | null,
  leagueArg: string | null,
  isNonPerson: boolean,
): { text: string; params: [string, number, string | null, string | null, boolean] } {
  const text = `SELECT id FROM known_entities
     WHERE id <> $2
       AND (sport_canonical IS NOT DISTINCT FROM ($3::text))
       AND (league_canonical IS NOT DISTINCT FROM ($4::text))
       AND (
             lower(immutable_unaccent(canonical)) = lower(immutable_unaccent($1))
             OR ($5::bool AND lower(immutable_unaccent(replace(canonical,' ',''))) =
                              lower(immutable_unaccent(replace($1,' ',''))))
           )
     LIMIT 1`;
  return { text, params: [correctedCanonical, rowId, sportArg, leagueArg, isNonPerson] };
}


const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set(ENTITY_TYPES);

// Renaming a level-1 taxonomy canonical would orphan every level-2 row referencing it by string.
const TAXONOMY_TYPES: ReadonlySet<string> = new Set(STRUCTURAL_ENTITY_TYPES);

// True only when the candidate resolves to a real KB sport and NOT also a real KB league (e.g. NRL resolves to both and is kept).
export function decideDropSportAsLeague(
  leagueResolved: string | null,
  sportResolved: string | null,
): boolean {
  if (sportResolved == null) return false;
  if (leagueResolved != null) return false;
  return true;
}

/** Rejects junk and compound strings (e.g. 'baseball/basketball') before auto-creating a level-1 taxonomy entity from LLM output. */
export function looksLikePlausibleTaxonomyName(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length < 2 || trimmed.length > 80) return false;
  if (!/[a-z]/i.test(trimmed)) return false;
  if (/[\/,&;|]/.test(trimmed)) return false;
  if (/\b(and|or|vs)\b/i.test(trimmed)) return false;
  return true;
}

// Feeds resolveSubjectViaKB's T1 lookup — a bad alias here routes unrelated markets to the wrong canonical.
export function isAcceptableAlias(
  alias: string,
  canonical: string,
  entityType: string,
): boolean {
  if (typeof alias !== 'string') return false;
  const trimmed = alias.trim();
  if (trimmed.length < 2 || trimmed.length > 120) return false;
  if (!/[a-z]/i.test(trimmed)) return false;

  if (trimmed.toLowerCase() === canonical.toLowerCase()) return false;

  // Question-shaped or partial-phrase aliases cause T1 to route unrelated markets to the wrong canonical.
  if (/^(?:Will|Who|Which|What|Can|Could|Does|Did|Is|Are|Should|How|When|Where|Why)\b/i.test(trimmed)) {
    return false;
  }
  if (/^(?:\w+\s+)?(?:will|the|of|a|an)\s*$/i.test(trimmed)) return false;

  // person-only: a single-word capitalized surname alias cross-domain-bleeds across unrelated people.
  if (entityType === 'person'
      && /^[A-Z][a-z]+$/.test(trimmed)
      && trimmed.length <= 12) {
    return false;
  }

  // Weather subjects are station-scoped; an alias must not erase that discriminator.
  if (isStationScopedName(trimmed) && !isStationScopedName(canonical)) {
    return false;
  }
  const cityTail = stationCityContext(canonical);
  if (cityTail && trimmed.toLowerCase() === cityTail.toLowerCase()) {
    return false;
  }

  return true;
}

// Only applies when a swap is proposed, the row is not level-1 taxonomy, and kbKnown is false (a fold-known KB entity is legitimate even if it trips the predicate heuristic).
export function blocksPredicateCanonicalSwap(
  proposedCanonical: string,
  isTaxonomyRow: boolean,
  wantsSwap: boolean,
  kbKnown: boolean,
): boolean {
  if (!wantsSwap || isTaxonomyRow) return false;
  if (kbKnown) return false;
  return looksLikePredicate(proposedCanonical);
}

// A station name must not become a bare city, nor a bare city become a station name.
export function blocksStationCanonicalSwap(
  existingCanonical: string,
  proposedCanonical: string,
  wantsSwap: boolean,
): boolean {
  if (!wantsSwap) return false;
  return isStationScopedName(existingCanonical) !== isStationScopedName(proposedCanonical);
}

export async function prepareEnrichment(row: EntityRow, result: LLMEnrichmentItem): Promise<PreparedEnrichment | { kind: 'invalid'; reason: string }> {
  const currentAliases = row.aliases;
  const currentMetadata = row.metadata;

  let correctedCanonical = result.canonical_corrected.trim();
  if (!correctedCanonical) {
    return { kind: 'invalid', reason: 'empty_canonical_corrected' };
  }

  // Level-1 taxonomy canonicals have no cascading update path, so a swap is forbidden here; swap detection is case-sensitive for taxonomy rows, case-insensitive otherwise.
  const isTaxonomyRow = TAXONOMY_TYPES.has(row.type);
  let wantsSwap = isTaxonomyRow
    ? correctedCanonical !== row.canonical
    : correctedCanonical.toLowerCase() !== row.canonical.toLowerCase();

  if (wantsSwap && isTaxonomyRow) {
    log.warn(`taxonomy: blocked canonical swap on level-1 ${row.type} id=${row.id} "${row.canonical}" → "${correctedCanonical}" (keeping "${row.canonical}")`);
    correctedCanonical = row.canonical;
    wantsSwap = false;
  }

  const swapKbKnown = wantsSwap && !isTaxonomyRow && (await kbHasRealEntity(correctedCanonical));
  if (blocksPredicateCanonicalSwap(correctedCanonical, isTaxonomyRow, wantsSwap, swapKbKnown)) {
    log.warn(`enrichment: blocked predicate-title canonical swap on ${row.type} id=${row.id} "${row.canonical}" → "${correctedCanonical}" (keeping "${row.canonical}")`);
    correctedCanonical = row.canonical;
    wantsSwap = false;
  } else if (swapKbKnown && looksLikePredicate(correctedCanonical)) {
    beltHit('looks_predicate_kbhit');
  }

  if (blocksStationCanonicalSwap(row.canonical, correctedCanonical, wantsSwap)) {
    log.warn(`enrichment: blocked station-scope canonical swap on ${row.type} id=${row.id} "${row.canonical}" → "${correctedCanonical}" (keeping "${row.canonical}")`);
    correctedCanonical = row.canonical;
    wantsSwap = false;
  }

  // Existing aliases are not re-filtered through isAcceptableAlias — only new LLM-emitted ones are.
  const aliasSet = new Map<string, string>();
  for (const a of currentAliases) aliasSet.set(a.toLowerCase(), a);
  for (const a of Array.isArray(result.aliases) ? result.aliases : []) {
    if (!a || typeof a !== 'string') continue;
    if (a.toLowerCase() === correctedCanonical.toLowerCase()) continue;
    if (!isAcceptableAlias(a, correctedCanonical, row.type)) {
      log.info(`alias-quality: rejected "${a}" for ${row.type} "${correctedCanonical}" (id=${row.id})`);
      continue;
    }
    aliasSet.set(a.toLowerCase(), a);
  }
  if (wantsSwap) aliasSet.set(row.canonical.toLowerCase(), row.canonical);
  aliasSet.delete(correctedCanonical.toLowerCase());
  const mergedAliases = Array.from(aliasSet.values());

  const resultMetadata = result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)
    ? result.metadata
    : {};
  const mergedMetadata: Record<string, unknown> = { ...resultMetadata, ...currentMetadata };

  // Merge is first-write-wins, except: an existing generic 'esports' sport_canonical yields to an incoming specific ESPORTS_GAMES entry.
  const incomingSport = typeof resultMetadata.sport_canonical === 'string'
    ? resultMetadata.sport_canonical
    : null;
  const existingSport = typeof currentMetadata.sport_canonical === 'string'
    ? currentMetadata.sport_canonical
    : null;
  if (incomingSport && existingSport
      && existingSport.toLowerCase() === ESPORTS_UMBRELLA
      && ESPORTS_GAMES.has(incomingSport.toLowerCase())) {
    mergedMetadata.sport_canonical = incomingSport;
  }

  // Sport must resolve before league — league creation needs the sport's canonical form as parent.
  if (typeof mergedMetadata.sport_canonical === 'string') {
    const candidate = mergedMetadata.sport_canonical.trim().toLowerCase();
    // cached: string=resolved canonical, null=known-ambiguous (clear it), undefined=novel (slow-path resolver).
    const leagueCtx = typeof mergedMetadata.league_canonical === 'string'
      ? mergedMetadata.league_canonical : null;
    const cached = await normalizeSportCanonical(candidate, { league: leagueCtx });
    if (typeof cached === 'string') {
      mergedMetadata.sport_canonical = cached;
    } else if (cached === null) {
      delete mergedMetadata.sport_canonical;
    } else if (looksLikePlausibleTaxonomyName(candidate)) {
      const hit = await sportResolver.resolve(
        candidate,
        row.domain_category,
        { _origin: 'llm_taxonomy_enrichment' },
        {
          aliases: Array.isArray(result.new_sport_aliases) ? result.new_sport_aliases : [],
          lowercaseCanonical: true,
          initialEnrichmentStatus: 'enriched',
          forceSportsDomain: true,
        },
      );
      if (hit) mergedMetadata.sport_canonical = hit.canonical;
    } else {
      delete mergedMetadata.sport_canonical;
    }
  }
  if (typeof mergedMetadata.league_canonical === 'string') {
    const candidate = mergedMetadata.league_canonical.trim().toLowerCase();
    const sportCanonical = typeof mergedMetadata.sport_canonical === 'string'
      ? mergedMetadata.sport_canonical.toLowerCase()
      : null;
    if (sportCanonical && candidate === sportCanonical) {
      log.warn(`taxonomy: dropping league_canonical "${candidate}" — equals sport_canonical (id=${row.id})`);
      delete mergedMetadata.league_canonical;
    } else {
    const cached = await resolveTaxonomyCanonical(candidate, 'league');
    const sportResolved = await resolveTaxonomyCanonical(candidate, 'sport');
    if (decideDropSportAsLeague(cached, sportResolved)) {
      log.warn(`taxonomy: dropping league_canonical "${candidate}" — resolves to SPORT "${sportResolved}", not a league (id=${row.id})`);
      delete mergedMetadata.league_canonical;
    } else if (cached) {
      mergedMetadata.league_canonical = cached;
    } else if (looksLikePlausibleTaxonomyName(candidate)) {
      const parentSport = typeof mergedMetadata.sport_canonical === 'string'
        ? mergedMetadata.sport_canonical
        : null;
      const extraMetadata: Record<string, unknown> = { _origin: 'llm_taxonomy_enrichment' };
      if (parentSport) extraMetadata.sport_canonical = parentSport;
      const hit = await leagueResolver.resolve(
        candidate,
        row.domain_category,
        extraMetadata,
        {
          aliases: Array.isArray(result.new_league_aliases) ? result.new_league_aliases : [],
          lowercaseCanonical: true,
          initialEnrichmentStatus: 'enriched',
          forceSportsDomain: true,
        },
      );
      if (hit) mergedMetadata.league_canonical = hit.canonical;
    } else {
      delete mergedMetadata.league_canonical;
    }
    }
  }

  const sanitizedType = VALID_ENTITY_TYPES.has(result.type) ? result.type : 'unknown';
  let newType = sanitizedType === 'unknown' ? row.type : sanitizedType;

  const isPoliticsDomain = row.domain_category === 'politics';
  if (isPoliticsDomain && looksLikePoliticalPartyName(correctedCanonical)) {
    if (newType !== 'organization') {
      log.info(
        `politics post-correction: id=${row.id} canonical="${correctedCanonical}" ` +
        `type "${newType}" → "organization" (matches party-name pattern)`,
      );
    }
    newType = 'organization';
    mergedMetadata.kind = 'political_party';
    delete mergedMetadata.role; // role is person-only
  } else if (
    isPoliticsDomain &&
    newType === 'person' &&
    !mergedMetadata.sport_canonical
  ) {
    const role = typeof mergedMetadata.role === 'string' ? mergedMetadata.role : null;
    if (role !== 'politician' && role !== 'coach' && role !== 'executive' && role !== 'other') {
      if (role) {
        log.info(
          `politics post-correction: id=${row.id} canonical="${correctedCanonical}" ` +
          `role "${role}" → "politician" (politics-domain person, no sport signal)`,
        );
      }
      mergedMetadata.role = 'politician';
    }
  }

  // A cup must never be stamped as league_canonical on a team row (would fork the team one-per-cup); competes_in keeps that linkage instead.
  if (newType === 'team' &&
      typeof mergedMetadata.league_canonical === 'string' &&
      isCrossLeague(mergedMetadata.league_canonical)) {
    log.info(
      `taxonomy: dropping cross-league cup "${mergedMetadata.league_canonical}" from ` +
      `team league_canonical (id=${row.id}) — competes_in keeps the linkage`,
    );
    delete mergedMetadata.league_canonical;
  }

  mergedMetadata.kind = newType === 'organization' && mergedMetadata.kind === 'political_party'
    ? 'political_party'
    : newType;

  return { correctedCanonical, newType, mergedAliases, mergedMetadata };
}

function looksLikePoliticalPartyName(canonical: string): boolean {
  const c = canonical.trim();
  if (!c) return false;
  if (/\b(Party|Parti|Partei|Partido|Partito|Liberals?|Conservatives?|Greens|Tories|Socialists?|Communists?|Democrats?|Republicans?)\b/i.test(c)) {
    return true;
  }
  if (/^GOP$/i.test(c)) return true;
  if (/^Democratics?$/i.test(c)) return true;
  return false;
}

export async function applyEnrichment(row: EntityRow, result: LLMEnrichmentItem): Promise<ApplyOutcome> {
  const preparedOrInvalid = await prepareEnrichment(row, result);
  if ('kind' in preparedOrInvalid) return preparedOrInvalid;
  const prepared = preparedOrInvalid;
  const { correctedCanonical, newType, mergedAliases, mergedMetadata } = prepared;
  const wantsSwap = correctedCanonical.toLowerCase() !== row.canonical.toLowerCase();

  // Racy under concurrent workers; 23505 on the UPDATE below is also caught and re-queried.
  const sportArg = (mergedMetadata.sport_canonical as string | undefined) ?? null;
  const leagueArg = (mergedMetadata.league_canonical as string | undefined) ?? null;
  const foldCollisionQ = buildFoldCollisionQuery(
    correctedCanonical, row.id, sportArg, leagueArg, newType !== 'person',
  );
  const collision = await query<{ id: number }>(foldCollisionQ.text, foldCollisionQ.params);
  if (collision.length > 0) {
    return { kind: 'collision', prepared, collidesWithId: collision[0].id };
  }

  try {
    await query(
      `UPDATE known_entities
       SET canonical          = $2,
           type               = $3,
           aliases            = $4::jsonb,
           metadata           = $5::jsonb,
           enrichment_status  = 'enriched',
           updated_at         = NOW()
       WHERE id = $1`,
      [
        row.id,
        correctedCanonical,
        newType,
        JSON.stringify(mergedAliases),
        JSON.stringify(mergedMetadata),
      ],
    );
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e?.code === '23505' && e?.constraint === 'known_entities_canonical_sport_league_key') {
      const raceQ = buildFoldCollisionQuery(
        correctedCanonical, row.id, sportArg, leagueArg, newType !== 'person',
      );
      const race = await query<{ id: number }>(raceQ.text, raceQ.params);
      if (race.length > 0) {
        return { kind: 'collision', prepared, collidesWithId: race[0].id };
      }
      return { kind: 'invalid', reason: 'canonical_collision_race_unresolved' };
    }
    throw err;
  }

  if (wantsSwap) {
    log.info(
      `swap id=${row.id}: "${row.canonical}" → "${correctedCanonical}" ` +
      `(type ${row.type}→${newType}, sport=${mergedMetadata.sport_canonical ?? '∅'})`,
    );

    // sport_canonical/league_canonical are text in metadata JSONB, not a FK, so a rename must rewrite every dependent reference.
    if (newType === 'sport' || newType === 'league' || newType === 'competition') {
      const metaKey = newType === 'sport' ? 'sport_canonical' : 'league_canonical';
      await query(
        `UPDATE known_entities
           SET metadata   = jsonb_set(metadata, ARRAY[$1::text], to_jsonb($2::text)),
               updated_at = NOW()
         WHERE metadata->>$1 = $3`,
        [metaKey, correctedCanonical, row.canonical],
      );
    }
  } else {
    const aliasCount = Array.isArray(result.aliases) ? result.aliases.length : 0;
    log.info(
      `enrich id=${row.id}: "${row.canonical}" type=${newType} ` +
      `aliases+${aliasCount} sport=${mergedMetadata.sport_canonical ?? '∅'}`,
    );
  }
  return { kind: 'wrote', prepared };
}

// LLM call

function buildPlatformSignals(row: EntityRow): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];

  if (row.tag_slugs && row.tag_slugs.length > 0) {
    out.push({ label: 'polymarket_tags', value: JSON.stringify(row.tag_slugs) });
  }
  if (row.limitless_sport) {
    out.push({ label: 'limitless_sport', value: row.limitless_sport });
  }
  if (row.limitless_league) {
    out.push({ label: 'limitless_league', value: row.limitless_league });
  }
  if (row.kalshi_ticker_prefix) {
    out.push({ label: 'kalshi_ticker_prefix', value: row.kalshi_ticker_prefix });
  }
  if (row.predict_tag_names && row.predict_tag_names.length > 0) {
    out.push({ label: 'predict_tags', value: JSON.stringify(row.predict_tag_names) });
  }

  return out;
}

// Every key is referenced by prompts/entity_enrichment/user-template.md; keep the two in sync.
export function buildEnrichmentPromptVars(
  contexts: { row: EntityRow; classification: EntityClassification }[],
  taxonomy: { sports: string[]; leagues: string[] },
): Record<string, unknown> {
  return {
    count: contexts.length,
    known_sports:  taxonomy.sports,
    known_leagues: taxonomy.leagues,
    entities: contexts.map((c, idx) => {
      const platformSignals = buildPlatformSignals(c.row);
      const sampleDescriptions = c.row.sample_descriptions ?? [];
      const coEntities = c.row.co_entities ?? [];
      const parentEvents = c.row.parent_events ?? [];
      return {
        index: idx + 1,
        canonical_now: c.row.canonical,
        aliases_json: JSON.stringify(c.row.aliases),
        domain_category: c.row.domain_category,
        type_hint: c.classification.entity_type,
        sport_hint_or_null: c.classification.sport_canonical ? `"${c.classification.sport_canonical}"` : 'null',
        sample_titles: c.row.sample_titles ?? [],
        // null (not []) so Mustache skips the section entirely.
        platform_signals_section: platformSignals.length > 0
          ? { signals: platformSignals }
          : null,
        sample_descriptions_section: sampleDescriptions.length > 0
          ? { descriptions: sampleDescriptions }
          : null,
        co_entities_section: coEntities.length > 0
          ? { co_entities: coEntities }
          : null,
        parent_events_section: parentEvents.length > 0
          ? { parent_events: parentEvents }
          : null,
      };
    }),
  };
}

async function callEnrichmentLLM(
  contexts: { claim: EnrichmentClaim; row: EntityRow; classification: EntityClassification }[],
): Promise<LLMEnrichmentItem[]> {
  const taxonomy = await getTaxonomyContext();
  const { parsed, response } = await callLLM<{ entities?: LLMEnrichmentItem[] }>({
    task: 'entity_enrichment',
    template: promptTemplate,
    vars: buildEnrichmentPromptVars(contexts, taxonomy),
    items: contexts.length,
    context: { batchSize: contexts.length },
  });
  if (parsed && Array.isArray(parsed.entities)) return parsed.entities;
  if (Array.isArray(response.parsed)) return response.parsed as LLMEnrichmentItem[];
  throw new Error('LLM response missing entities[] array');
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
