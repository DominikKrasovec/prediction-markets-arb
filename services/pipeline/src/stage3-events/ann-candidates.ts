/**
 * Stage 3a — ANN candidacy (no LLM): self-kNN over platform_events.embedding (HNSW)
 * enqueues cross-platform candidate pairs for the Stage 3b LLM matcher, gated by the
 * deterministic fragments below; idempotent via UNIQUE(a,b). `runMarketAnnFallback`
 * is a market-grain second pass for the 1-market-vs-N-child granularity mismatch.
 */
import { query, queryWithHints } from '@arb/db';
import { createLogger } from '@arb/logger';
import { config } from '../config.js';
import { embedTexts, buildEmbeddingInput } from '../stage1-normalize/embedder.js';
import { bulkUpdateMarketEmbeddings } from '../db/queries/markets.js';
import { notParlaySql } from '../db/queries/match-source.js';
import { notAnonMarketSql } from '../stage1-normalize/text-deterministic.js';
import { datePrecisionLadderSql } from '../util/date-grain-sql.js';
import { STAGE_SUFFIX_TOKENS } from '../db/entity/taxonomy.js';

const log = createLogger('event-ann');

const ANN_K = 20;

// market-level fallback knobs (recall tuning only; soundness guards below are unconditional)
const MARKET_FALLBACK_ON = process.env.MARKET_ANN_FALLBACK !== '0';
const MARKET_FALLBACK_K = parseInt(process.env.MARKET_ANN_FALLBACK_K ?? '3', 10);
const MARKET_FALLBACK_DISTANCE_MAX = parseFloat(process.env.MARKET_ANN_FALLBACK_DISTANCE_MAX ?? '0.25');
/** Per-run cap on the targeted market re-embed (cost valve). */
const MARKET_FALLBACK_EMBED_MAX = parseInt(process.env.MARKET_ANN_FALLBACK_EMBED_MAX ?? '20000', 10);
const MARKET_FALLBACK_EMBED_PAGE = 500;
/** Trigram-similarity escape for `passesTitleSanity` when titles share no content token. */
const MARKET_FALLBACK_TRGM_ESCAPE = 0.18;

/** Incremental anchor gate: anchor side only (neighbor side stays ungated, so no candidate is dropped). */
const ANN_INCREMENTAL_ANCHOR = process.env.ANN_INCREMENTAL_ANCHOR !== '0';
const ANN_FULL_RECONCILE_MS = parseInt(process.env.ANN_FULL_RECONCILE_MS ?? String(3 * 60 * 60 * 1000), 10);

interface AnchorWatermark { sinceIso: string | null; lastFullMs: number; }
// sinceIso starts null so the FIRST pass after process start is a FULL scan.
const eventAnnWm: AnchorWatermark = { sinceIso: null, lastFullMs: 0 };
const marketAnnWm: AnchorWatermark = { sinceIso: null, lastFullMs: 0 };

/** This pass's anchor floor for `($5 IS NULL OR embedded_at > $5)`; NULL means a full scan. */
function anchorFloor(wm: AnchorWatermark, nowMs: number): { floorParam: string | null; full: boolean } {
  const full = !ANN_INCREMENTAL_ANCHOR || wm.sinceIso === null || nowMs - wm.lastFullMs >= ANN_FULL_RECONCILE_MS;
  return { floorParam: full ? null : wm.sinceIso, full };
}

/** Anon-market omission at the market-grain anchor loci; anchor-side only. */
const ANON_JOIN = ' JOIN market_metadata_raw mr ON mr.market_id = m.id';
const ANON_CLAUSE = ` AND ${notAnonMarketSql('m', 'mr')}`;

/** League fold key: strips a leading season/year and one trailing stage token, guarded so distinct leagues never collapse. */
const STAGE_SUFFIX_SQL = `(${STAGE_SUFFIX_TOKENS})`;

export function foldLeagueKeySqlExpr(col: string): string {
  const base = `regexp_replace(trim(${col}), '^(19|20)\\d{2}([\\s–-]\\d{2})?\\s+', '')`;
  const stripped = `regexp_replace(${base}, '\\s+${STAGE_SUFFIX_SQL}\\s*$', '', 'i')`;
  return `lower(replace(CASE
    WHEN ${base} ~* '^[a-z0-9]{2,4}\\s+championship\\s*$' THEN ${base}
    ELSE COALESCE(
    NULLIF(
      NULLIF(${stripped}, ''),
      CASE WHEN ${stripped} ~* '^${STAGE_SUFFIX_SQL}$' THEN ${stripped} END
    ),
    ${base}) END, ' ', ''))`;
}

/** Pure TS mirror of `foldLeagueKeySqlExpr`, kept in parity by a DB test. */
export { foldLeagueKey } from '../db/entity/taxonomy.js';

// NULL-date participant-set gate: blocks a date-less single-team event from bridging every dated fixture of that team when participant sets differ.
const FIXTURE_KINDS = [
  'match_total_metric', 'match_spread', 'match_winner', 'both_teams_score',
  'exact_score', 'halftime_leader', 'match_event_prop', 'player_prop_threshold',
] as const;

const FIXTURE_KINDS_SQL =
  `ARRAY[${FIXTURE_KINDS.map((k) => `'${k}'`).join(',')}]`;

/** SQL: fold-normalized participant set as a sorted text[] (comparable with `<>`). */
function foldedParticipantSetSqlExpr(alias: string): string {
  return `(SELECT array_agg(fp ORDER BY fp) FROM (
            SELECT DISTINCT lower(regexp_replace(p, '[^a-zA-Z0-9]+', '', 'g')) AS fp
            FROM unnest(${alias}.participants) AS p
          ) fps_${alias})`;
}

/** TS mirror of the SQL participant fold (unit-test parity). */
export function foldParticipantKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

/** TS mirror: TRUE iff both sets are known and their folded participant sets differ. */
export function participantSetsProvablyDiffer(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  const fold = (xs: readonly string[]) => [...new Set(xs.map(foldParticipantKey))].sort();
  const fa = fold(a);
  const fb = fold(b);
  return fa.length !== fb.length || fa.some((x, i) => x !== fb[i]);
}

// Placeholder-date bypass: a single-occurrence categorical's condition_date is unreliable padding; relaxation-only OR-arm requiring >=2 shared folded-roster members.

/** SQL: TRUE iff `a` and `b` share ≥2 folded-roster members. */
function foldedRosterOverlapAtLeast2Sql(a: string, b: string): string {
  return `(SELECT count(*) FROM
            (SELECT DISTINCT lower(regexp_replace(p, '[^a-zA-Z0-9]+', '', 'g')) AS fp
               FROM unnest(${a}.participants) AS p) fr_${a}
            JOIN
            (SELECT DISTINCT lower(regexp_replace(p, '[^a-zA-Z0-9]+', '', 'g')) AS fp
               FROM unnest(${b}.participants) AS p) fr_${b} USING (fp)) >= 2`;
}

function categoricalRosterDateBypassSql(a: string, b: string): string {
  return `(${a}.grouping_type = 'categorical_exclusive'
            AND ${b}.grouping_type = 'categorical_exclusive'
            AND NOT COALESCE(${a}.event_kind = ANY(${FIXTURE_KINDS_SQL}), FALSE)
            AND NOT COALESCE(${b}.event_kind = ANY(${FIXTURE_KINDS_SQL}), FALSE)
            AND ${foldedRosterOverlapAtLeast2Sql(a, b)})`;
}

/** TS mirror of `categoricalRosterDateBypassSql`. */
const FIXTURE_KINDS_FOR_BYPASS: ReadonlySet<string> = new Set(FIXTURE_KINDS);
export function categoricalRosterDateBypass(
  aGrouping: string | null | undefined,
  bGrouping: string | null | undefined,
  aKind: string | null | undefined,
  bKind: string | null | undefined,
  aParticipants: readonly string[] | null | undefined,
  bParticipants: readonly string[] | null | undefined,
): boolean {
  if (aGrouping !== 'categorical_exclusive' || bGrouping !== 'categorical_exclusive') return false;
  if (aKind && FIXTURE_KINDS_FOR_BYPASS.has(aKind)) return false;
  if (bKind && FIXTURE_KINDS_FOR_BYPASS.has(bKind)) return false;
  if (!aParticipants || !bParticipants) return false;
  const fa = new Set(aParticipants.map(foldParticipantKey).filter(Boolean));
  const fb = new Set(bParticipants.map(foldParticipantKey).filter(Boolean));
  let overlap = 0;
  for (const x of fa) if (fb.has(x)) overlap++;
  return overlap >= 2;
}

/** Deterministic pair-gate fragments shared by the event pass, market fallback, and the recall harness; each must be a self-contained boolean with NO SQL comments. */
export const GATE_ORDER = [
  'grouping', 'sport', 'league', 'period_scope', 'never_same_kind', 'participant_set', 'date',
] as const;
export type GateName = (typeof GATE_ORDER)[number];

export function gateSql(gate: GateName, cryptoParam: string, hourParam: string): string {
  switch (gate) {
    case 'grouping':
      return `(a.grouping_type = b.grouping_type
                  OR a.grouping_type = 'unknown'
                  OR b.grouping_type = 'unknown')`;
    // NULL on either side passes
    case 'sport':
      return `(a.sport_canonical IS NULL OR b.sport_canonical IS NULL
                  OR a.sport_canonical = b.sport_canonical)`;
    // spacing/case/stage-normalized key so spelling drift doesn't block a true match
    case 'league':
      return `(a.league_canonical IS NULL OR b.league_canonical IS NULL
                  OR ${foldLeagueKeySqlExpr('a.league_canonical')} = ${foldLeagueKeySqlExpr('b.league_canonical')})`;
    case 'period_scope':
      return `NOT COALESCE(
                   (a.event_kind = 'halftime_leader'
                      AND b.event_kind = ANY(ARRAY['match_winner','exact_score','match_total_metric','match_spread','both_teams_score','match_event_prop']))
                   OR (b.event_kind = 'halftime_leader'
                      AND a.event_kind = ANY(ARRAY['match_winner','exact_score','match_total_metric','match_spread','both_teams_score','match_event_prop']))
                 , FALSE)`;
    case 'never_same_kind':
      return `NOT COALESCE(
                   (a.event_kind = 'championship_winner' AND b.event_kind = 'stage_advance')
                   OR (b.event_kind = 'championship_winner' AND a.event_kind = 'stage_advance')
                   OR (a.event_kind = 'candle_direction' AND b.event_kind = 'price_threshold')
                   OR (b.event_kind = 'candle_direction' AND a.event_kind = 'price_threshold')
                   OR (a.event_kind = 'election_margin' AND b.event_kind = 'election_outcome_winner')
                   OR (b.event_kind = 'election_margin' AND a.event_kind = 'election_outcome_winner')
                 , FALSE)`;
    case 'participant_set':
      return `NOT COALESCE(
                   a.event_kind = ANY(${FIXTURE_KINDS_SQL})
                   AND b.event_kind = ANY(${FIXTURE_KINDS_SQL})
                   AND (a.condition_date IS NULL OR b.condition_date IS NULL)
                   AND COALESCE(array_length(a.participants, 1), 0) > 0
                   AND COALESCE(array_length(b.participants, 1), 0) > 0
                   AND ${foldedParticipantSetSqlExpr('a')} <> ${foldedParticipantSetSqlExpr('b')}
                 , FALSE)`;
    case 'date':
      return `(${datePrecisionLadderSql('a', 'b', cryptoParam, hourParam)}
                  OR ${categoricalRosterDateBypassSql('a', 'b')})`;
  }
}

/** The conjunction of every `GATE_ORDER` fragment, in order. */
export function eventPairGatesSql(cryptoParam: string, hourParam: string): string {
  return GATE_ORDER.map((g) => gateSql(g, cryptoParam, hourParam)).join('\n             AND ');
}

export async function runEventAnnCandidates(): Promise<number> {
  const maxDistance = config.events.annCosineDistanceMax;
  const cryptoMs = config.pairing.sameEventCryptoToleranceMs;
  const hourMs   = config.pairing.sameEventHourToleranceMs;

  const nowMs = Date.now();
  const { floorParam, full } = anchorFloor(eventAnnWm, nowMs);
  const advanceIso = new Date().toISOString();

  const rows = await queryWithHints<{ inserted: number }>(
    `WITH ins AS (
       INSERT INTO stage3_event_candidates (platform_event_a, platform_event_b, cosine_distance)
       SELECT LEAST(p.a_id, p.b_id), GREATEST(p.a_id, p.b_id), MIN(p.distance)
       FROM (
         SELECT a.id AS a_id, n.id AS b_id, n.distance
         FROM platform_events a
         CROSS JOIN LATERAL (
           SELECT b.id, b.embedding <=> a.embedding AS distance
           FROM platform_events b
           WHERE b.id <> a.id
             AND b.embedding IS NOT NULL
             AND b.platform <> a.platform
             AND ${eventPairGatesSql('$3', '$4')}
           ORDER BY b.embedding <=> a.embedding
           LIMIT $2
         ) n
         WHERE a.embedding IS NOT NULL
           AND ($5::timestamptz IS NULL OR a.embedded_at > $5)
           AND n.distance < $1
       ) p
       GROUP BY LEAST(p.a_id, p.b_id), GREATEST(p.a_id, p.b_id)
       ON CONFLICT (platform_event_a, platform_event_b) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*)::int AS inserted FROM ins`,
    [maxDistance, ANN_K, cryptoMs, hourMs, floorParam],
    { enable_seqscan: 'off' },
  );

  eventAnnWm.sinceIso = advanceIso;
  if (full) eventAnnWm.lastFullMs = nowMs;

  const inserted = rows[0]?.inserted ?? 0;
  log.info(
    `Stage 3a: enqueued ${inserted} new candidate event pairs ` +
    `(distance < ${maxDistance} [= similarity > ${(1 - maxDistance).toFixed(2)}], ` +
    `crypto <${cryptoMs}ms / hour <${hourMs}ms / day-same, k=${ANN_K}; ` +
    `anchor=${full ? 'FULL' : `incr since ${floorParam}`})`,
  );

  // failure-contained: a fallback error must never kill the event pass's result
  let fallbackInserted = 0;
  if (MARKET_FALLBACK_ON) {
    try {
      fallbackInserted = await runMarketAnnFallback();
    } catch (err) {
      log.error(`Stage 3a market-ANN fallback failed (event-level candidates unaffected): ${err}`);
    }
  } else {
    log.info('Stage 3a market-ANN fallback skipped (MARKET_ANN_FALLBACK=0)');
  }

  return inserted + fallbackInserted;
}

// Market-level ANN fallback: covers 1-market-vs-N-child granularity mismatch, where
// event embeddings diverge but market embeddings stay close. Rows are tagged
// llm_reasoning='[src:market-ann-fallback]' until Stage 3b overwrites it.

/** Tokens too generic to prove two titles talk about the same thing. */
const SANITY_STOPWORDS = new Set([
  'will', 'would', 'the', 'this', 'that', 'these', 'those',
  'who', 'what', 'when', 'where', 'which', 'how', 'why',
  'his', 'her', 'their', 'its', 'they',
  'win', 'wins', 'won', 'winner', 'winners',
  'and', 'for', 'not', 'with', 'from', 'against',
  'more', 'than', 'least', 'most', 'over', 'under', 'above', 'below', 'between',
  'before', 'after', 'end', 'out', 'any', 'all', 'are', 'was', 'were',
  'does', 'did', 'you', 'yes', 'year',
  'market', 'resolve', 'resolves', 'officially', 'announce', 'announced',
]);
const BARE_YEAR_RX = /^20\d\d$/;

function contentTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // fold combining diacritics: Mirandés → mirandes
      .split(/[^a-z0-9.$%]+/)               // keep $/%/. so '5.5%', '>$4m' survive as tokens
      .filter((t) => t.length >= 3 && !BARE_YEAR_RX.test(t) && !SANITY_STOPWORDS.has(t)),
  );
}

/** True when the two titles share at least one CONTENT token (subject signal). */
export function sharesContentToken(a: string, b: string): boolean {
  const ta = contentTokens(a);
  if (ta.size === 0) return false;
  for (const t of contentTokens(b)) if (ta.has(t)) return true;
  return false;
}

/** Rejects the shifted-embedding signature: a tiny distance with no textual relationship. */
export function passesTitleSanity(aTitle: string, bTitle: string, titleTrgm: number): boolean {
  return titleTrgm >= MARKET_FALLBACK_TRGM_ESCAPE || sharesContentToken(aTitle, bTitle);
}

/** Targeted re-embed of the fallback anchor population; MARKET_ANN_FALLBACK_EMBED_MAX bounds it. */
async function embedFallbackMarkets(): Promise<number> {
  let total = 0;
  for (;;) {
    const pageLimit = Math.min(MARKET_FALLBACK_EMBED_PAGE, MARKET_FALLBACK_EMBED_MAX - total);
    if (pageLimit <= 0) {
      log.warn(`market-ANN fallback: hit MARKET_ANN_FALLBACK_EMBED_MAX=${MARKET_FALLBACK_EMBED_MAX} — remaining NULL-embedding anchors deferred to the next run`);
      break;
    }
    const page = await query<{ id: number; title: string; description: string | null }>(
      `SELECT m.id, m.title, m.description
         FROM markets m
         JOIN platform_events pe
           ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
         LEFT JOIN llm_market_normalizations n ON n.market_id = m.id${ANON_JOIN}
        WHERE m.embedding IS NULL
          AND m.end_date > NOW()
          AND ${notParlaySql('n')}${ANON_CLAUSE}
          AND NOT EXISTS (SELECT 1 FROM semantic_event_platforms sep WHERE sep.platform_event_id = pe.id)
        ORDER BY m.id
        LIMIT $1`,
      [pageLimit],
    );
    if (page.length === 0) break;
    const texts = page.map((m) => buildEmbeddingInput(m.title, m.description ?? ''));
    const vectors = await embedTexts(texts);
    if (vectors.length !== page.length) {
      throw new Error(`market-ANN fallback embed: ${vectors.length} vectors for ${page.length} markets — refusing misaligned write`);
    }
    await bulkUpdateMarketEmbeddings(
      page.map((m, i) => ({ id: m.id, vec: `[${vectors[i].join(',')}]` })),
      'text-embedding-3-small',
    );
    total += page.length;
    if (page.length < pageLimit) break;
  }
  if (total > 0) log.info(`market-ANN fallback: embedded ${total} anchor markets (targeted AUD-30 bypass)`);
  return total;
}

interface FallbackHit {
  pe_a: number;
  pe_b: number;
  distance: number;
  a_title: string;
  b_title: string;
  title_trgm: number;
}

export async function runMarketAnnFallback(): Promise<number> {
  const cryptoMs = config.pairing.sameEventCryptoToleranceMs;
  const hourMs   = config.pairing.sameEventHourToleranceMs;

  await embedFallbackMarkets();

  const nowMs = Date.now();
  const { floorParam, full } = anchorFloor(marketAnnWm, nowMs);
  const advanceIso = new Date().toISOString();

  // title sanity is applied in TS on the hits below: one implementation, no drift
  const hits = await queryWithHints<FallbackHit>(
    `WITH fb AS (
       SELECT m.id AS mkt_id, m.platform, m.title, m.embedding, pe.id AS pe_id
       FROM markets m
       JOIN platform_events pe
         ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id${ANON_JOIN}
       WHERE m.embedding IS NOT NULL
         AND ($5::timestamptz IS NULL OR m.embedded_at > $5)
         AND m.end_date > NOW()${ANON_CLAUSE}
         AND NOT EXISTS (SELECT 1 FROM semantic_event_platforms sep WHERE sep.platform_event_id = pe.id)
     ),
     hits AS (
       SELECT f.pe_id AS a_pe, f.title AS a_title,
              n.platform AS b_platform, n.platform_event_id AS b_peid,
              n.title AS b_title, n.distance
       FROM fb f
       CROSS JOIN LATERAL (
         SELECT b.title, b.platform, b.platform_event_id,
                b.embedding <=> f.embedding AS distance
         FROM markets b
         WHERE b.embedding IS NOT NULL
           AND b.platform <> f.platform
           AND b.end_date > NOW()
         ORDER BY b.embedding <=> f.embedding
         LIMIT $2
       ) n
       WHERE n.distance < $1
     )
     SELECT a.id AS pe_a, b.id AS pe_b,
            h.distance::float8 AS distance,
            h.a_title, h.b_title,
            similarity(h.a_title, h.b_title)::float8 AS title_trgm
     FROM hits h
     JOIN platform_events b ON b.platform = h.b_platform AND b.platform_event_id = h.b_peid
     JOIN platform_events a ON a.id = h.a_pe
     WHERE b.id <> a.id
       AND NOT EXISTS (SELECT 1 FROM stage3_event_candidates c
                       WHERE c.platform_event_a = LEAST(a.id, b.id)
                         AND c.platform_event_b = GREATEST(a.id, b.id))
       AND ${eventPairGatesSql('$3', '$4')}`,
    [MARKET_FALLBACK_DISTANCE_MAX, MARKET_FALLBACK_K, cryptoMs, hourMs, floorParam],
    { enable_seqscan: 'off' },
  );

  marketAnnWm.sinceIso = advanceIso;
  if (full) marketAnnWm.lastFullMs = nowMs;
  log.info(`market-ANN fallback: anchor=${full ? 'FULL' : `incr since ${floorParam}`}, ${hits.length} raw hits`);

  let sanityRejected = 0;
  const pairs = new Map<string, { a: number; b: number; distance: number }>();
  for (const h of hits) {
    if (!passesTitleSanity(h.a_title, h.b_title, h.title_trgm)) {
      sanityRejected++;
      continue;
    }
    const a = Math.min(h.pe_a, h.pe_b);
    const b = Math.max(h.pe_a, h.pe_b);
    const key = `${a}:${b}`;
    const prev = pairs.get(key);
    if (!prev || h.distance < prev.distance) pairs.set(key, { a, b, distance: h.distance });
  }

  let inserted = 0;
  if (pairs.size > 0) {
    const list = [...pairs.values()];
    const rows = await query<{ n: number }>(
      `WITH ins AS (
         INSERT INTO stage3_event_candidates (platform_event_a, platform_event_b, cosine_distance, llm_reasoning)
         SELECT t.a, t.b, t.d, '[src:market-ann-fallback]'
         FROM unnest($1::int[], $2::int[], $3::float8[]) AS t(a, b, d)
         ON CONFLICT (platform_event_a, platform_event_b) DO NOTHING
         RETURNING 1
       )
       SELECT COUNT(*)::int AS n FROM ins`,
      [list.map((p) => p.a), list.map((p) => p.b), list.map((p) => p.distance)],
    );
    inserted = rows[0]?.n ?? 0;
  }

  log.info(
    `Stage 3a market-ANN fallback: ${hits.length} market-level hits → ` +
    `${pairs.size} pe pairs (${sanityRejected} title-sanity rejects), ${inserted} newly enqueued ` +
    `(dist < ${MARKET_FALLBACK_DISTANCE_MAX}, k=${MARKET_FALLBACK_K})`,
  );
  return inserted;
}
