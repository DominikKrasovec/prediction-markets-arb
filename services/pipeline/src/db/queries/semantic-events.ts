/** Queries for the event-centric layer (semantic_events, legs, stage3 candidates). Never
 *  imports stage3/4 orchestrators; outcome-nodes are projected in Stage 4, not written here. */
import { query, withTx } from '@arb/db';
import { isStrikeLabelSubject } from '../entity/register.js';
import {
  parseMemberHalfLine, halfLinesConflict, halfLineKey, type HalfLine,
} from '../../util/half-line.js';
import { settlementDimensionSql } from '../../util/settlement-instrument.js';

/** Transaction-client shape for the fold gate, avoiding a direct `pg` dependency. */
interface TxClient {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}
import { beltHit } from '../../discriminators/telemetry.js';

/** Nulls a bare single-digit count-bucket subject and numeric strike labels; never nulls
 *  'Draw'/'Tie' (the draw machinery keys on canonical_subject ~ '(draw|tie)$'). */
export function bucketSubjectOrNull(s: string | null): string | null {
  if (s == null) return null;
  if (/^\s*\d\s*$/.test(s)) return null;
  if (isStrikeLabelSubject(s)) return null;
  return s;
}

export interface CandidateForMatch {
  id: number;
  platform_event_a: number;
  platform_event_b: number;
  cosine_distance: number;
}

/** Claims up to `limit` pending candidates (closest first) as 'in_progress', SKIP LOCKED. */
export async function claimEventCandidates(limit: number): Promise<CandidateForMatch[]> {
  return withTx(async (client) => {
    const res = await client.query<CandidateForMatch>(
      `WITH claimed AS (
         SELECT id FROM stage3_event_candidates
         WHERE status = 'pending'
         ORDER BY cosine_distance ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE stage3_event_candidates c
       SET status = 'in_progress'
       FROM claimed
       WHERE c.id = claimed.id
       RETURNING c.id, c.platform_event_a, c.platform_event_b, c.cosine_distance::float8 AS cosine_distance`,
      [limit],
    );
    return res.rows;
  });
}

export interface PlatformEventForMatch {
  id: number;
  platform: string;
  platform_event_id: string;
  title: string;
  grouping_type: string;
  canonical_subject: string | null;
  participants: string[];
  deadline: string | null;
  /** Authoritative fixture date; `deadline` is administrative padding and can diverge. */
  condition_date: string | null;
  condition_date_precision: string | null;
  total_children: number;
  /** Native outcome vector (which side YES pays); NULL when there's no outcomes array or it's the plain {Yes,No} vocabulary. */
  children: {
    market_id: number; title: string; resolution_scope: string | null;
    native_label: string | null; native_outcomes: string[] | null;
  }[];
}

/** Fetches a platform_event plus its highest-volume children, capped at `sampleSize`. */
export async function getPlatformEventForMatch(
  platformEventId: number,
  sampleSize: number,
): Promise<PlatformEventForMatch | null> {
  const evRows = await query<{
    id: number; platform: string; platform_event_id: string; title: string;
    grouping_type: string; canonical_subject: string | null;
    participants: string[]; deadline: string | null;
    condition_date: string | null; condition_date_precision: string | null;
  }>(
    `SELECT id, platform, platform_event_id, title, grouping_type,
            canonical_subject, participants, deadline::text AS deadline,
            condition_date::text AS condition_date, condition_date_precision
       FROM platform_events WHERE id = $1`,
    [platformEventId],
  );
  const ev = evRows[0];
  if (!ev) return null;

  const childRows = await query<{
    market_id: number; title: string; resolution_scope: string | null;
    native_label: string | null; native_outcomes: string[] | null; total: number;
  }>(
    `WITH kids AS (
       SELECT m.id AS market_id, m.title, m.resolution_scope, m.volume,
              COALESCE(mmr.raw->>'groupItemTitle', mmr.raw->>'yes_sub_title',
                       mmr.raw#>>'{custom_strike,Team}', n.condition_value,
                       n.outcome_label) AS native_label,
              -- Native outcome vector (which side YES pays); NULL for the
              -- plain {Yes,No}/{True,False} binary vocabulary.
              CASE
                WHEN jsonb_typeof(mmr.raw->'outcomes') = 'array'
                     AND NOT EXISTS (
                       SELECT 1 FROM jsonb_array_elements_text(mmr.raw->'outcomes') o(v)
                        WHERE lower(btrim(o.v)) IN ('yes','no','true','false'))
                THEN ARRAY(SELECT jsonb_array_elements_text(mmr.raw->'outcomes'))
              END AS native_outcomes
       FROM markets m
       LEFT JOIN market_metadata_raw mmr ON mmr.market_id = m.id
       LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
       WHERE m.platform = $1 AND m.platform_event_id = $2
     )
     SELECT market_id, title, resolution_scope, native_label, native_outcomes,
            (SELECT COUNT(*) FROM kids) AS total
     FROM kids
     ORDER BY volume DESC NULLS LAST, market_id
     LIMIT $3`,
    [ev.platform, ev.platform_event_id, sampleSize],
  );

  return {
    ...ev,
    participants: ev.participants ?? [],
    total_children: childRows.length > 0 ? Number(childRows[0].total) : 0,
    children: childRows.map((c) => ({
      market_id: c.market_id, title: c.title, resolution_scope: c.resolution_scope,
      native_label: c.native_label, native_outcomes: c.native_outcomes ?? null,
    })),
  };
}

/** The semantic_event a platform_event already belongs to (non-archived), or null if unbound. */
export async function findSemanticEventIdForPlatformEvent(
  platformEventId: number,
): Promise<number | null> {
  const rows = await query<{ semantic_event_id: number }>(
    `SELECT sep.semantic_event_id
       FROM semantic_event_platforms sep
       JOIN semantic_events se ON se.id = sep.semantic_event_id
      WHERE sep.platform_event_id = $1 AND se.archived_at IS NULL
      LIMIT 1`,
    [platformEventId],
  );
  return rows[0]?.semantic_event_id ?? null;
}

export interface SemanticEventInsert {
  canonical_event: string;
  canonical_subject: string | null;
  grouping_kind: string;
  participants: string[];
  /** [lo, hi] ISO timestamps, or null. */
  deadline_window: [string, string] | null;
  confidence: number;
  llm_model: string;
  match_reasoning: string | null;
}

export interface LegInsert {
  outcome_id: string;
  outcome_label: string;
  outcome_subject: string | null;
  outcome_ordinal: number | null;
  is_residual: boolean;
  platform: string;
  market_id: number;
}

export interface PersistMatchArgs {
  candidateId: number;
  /** platform_event ids to bind (both sides on create; the new side on expand). */
  platformEventIds: number[];
  matchConfidence: number;
  legs: LegInsert[];
  // existingSemanticEventId (attach) and semanticEvent (create) are mutually exclusive.
  existingSemanticEventId?: number;
  semanticEvent?: SemanticEventInsert;
}

// An outcome node must never be fed by >=2 platform_events of the same platform (they're
// different questions); checked over the full leg-union to catch transitive collisions too.

/** One leg's identity for the sibling detector (platform_event_id = platform_events.id). */
export interface SiblingLegRef {
  outcome_id: string;
  platform: string;
  platform_event_id: number | null;
  is_residual: boolean;
}
export interface SiblingCollision {
  outcome_id: string;
  platform: string;
  platform_event_ids: number[];
}

/** Legit-repost exemption: pairs of platform_event ids known to be the same relisted question. */
const EXEMPT_SIBLING_PAIRS = new Set<string>([]);
function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
/** True iff every pair among `peIds` is exempt; an empty whitelist means any group collides. */
function allPairsExempt(peIds: number[]): boolean {
  for (let i = 0; i < peIds.length; i++)
    for (let j = i + 1; j < peIds.length; j++)
      if (!EXEMPT_SIBLING_PAIRS.has(pairKey(peIds[i], peIds[j]))) return false;
  return peIds.length >= 2;
}

/** First non-residual outcome node an incoming leg feeds together with >=2 same-platform platform_events, or null. */
export function findSamePlatformSiblingRefusal(
  existing: SiblingLegRef[],
  incoming: SiblingLegRef[],
): SiblingCollision | null {
  const feed = new Map<string, Map<string, Set<number>>>();
  const add = (l: SiblingLegRef) => {
    if (l.is_residual) return;
    if (l.platform_event_id == null) return; // NULL-tolerant: no evidence
    let byP = feed.get(l.outcome_id);
    if (!byP) { byP = new Map(); feed.set(l.outcome_id, byP); }
    let s = byP.get(l.platform);
    if (!s) { s = new Set(); byP.set(l.platform, s); }
    s.add(l.platform_event_id);
  };
  for (const l of existing) add(l);
  for (const l of incoming) add(l);
  const touched = new Set<string>();
  for (const l of incoming) {
    if (l.is_residual || l.platform_event_id == null) continue;
    touched.add(`${l.outcome_id}\u0000${l.platform}`);
  }
  for (const key of touched) {
    const sep = key.indexOf('\u0000');
    const oid = key.slice(0, sep);
    const platform = key.slice(sep + 1);
    const s = feed.get(oid)?.get(platform);
    if (s && s.size >= 2) {
      const pes = [...s].sort((a, b) => a - b);
      if (!allPairsExempt(pes)) return { outcome_id: oid, platform, platform_event_ids: pes };
    }
  }
  return null;
}

// Refuses fusing conflicting half-lines (e.g. >57 vs >=57) onto one outcome node — reads the
// half-line from raw inputs so an unshaped tail is still covered; NULL-tolerant, residual-exempt.

/** One leg's half-line identity for the fold detector. */
export interface HalfLineLegRef {
  outcome_id: string;
  is_residual: boolean;
  half_line: HalfLine | null;
  /** True for a newly-attached leg; a collision is blamed only when one participates. */
  is_incoming: boolean;
}
export interface HalfLineFoldCollision {
  outcome_id: string;
  /** the two conflicting half-line keys (e.g. 'above:58' vs 'above:57'). */
  keys: [string, string];
}

/** First outcome node fed by two members with conflicting half-lines where at least one is incoming, or null. */
export function findHalfLineFoldRefusal(legs: HalfLineLegRef[]): HalfLineFoldCollision | null {
  const byOutcome = new Map<string, HalfLineLegRef[]>();
  for (const l of legs) {
    if (l.is_residual || l.half_line == null) continue; // no identity / no evidence
    (byOutcome.get(l.outcome_id) ?? byOutcome.set(l.outcome_id, []).get(l.outcome_id)!).push(l);
  }
  for (const [outcome_id, members] of byOutcome) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        if (!halfLinesConflict(a.half_line, b.half_line)) continue;
        if (!a.is_incoming && !b.is_incoming) continue; // pre-existing corruption — not our doing
        return { outcome_id, keys: [halfLineKey(a.half_line!), halfLineKey(b.half_line!)] };
      }
    }
  }
  return null;
}

/** Per-market half-line facts for the fold gate; raw inputs so an unshaped tail still yields a line. */
interface HalfLineFactRow {
  market_id: number;
  title: string | null;
  condition_direction: string | null;
  value_primary: string | null;
  value_unit: string | null;
  strike_type: string | null;
  floor_strike: string | null;
  cap_strike: string | null;
  custom_strike: string | null;
}

/** Loads half-lines for market ids: shaped norm -> Kalshi strike metadata -> title regex precedence. */
async function loadMemberHalfLines(
  client: TxClient, marketIds: number[],
): Promise<Map<number, HalfLine | null>> {
  const out = new Map<number, HalfLine | null>();
  if (marketIds.length === 0) return out;
  const res = await client.query<HalfLineFactRow>(
    `SELECT m.id AS market_id, m.title,
            n.condition_direction, n.value_primary::text AS value_primary, n.value_unit,
            mmr.raw->>'strike_type'  AS strike_type,
            mmr.raw->>'floor_strike' AS floor_strike,
            mmr.raw->>'cap_strike'   AS cap_strike,
            mmr.raw->>'custom_strike' AS custom_strike
       FROM markets m
       LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
       LEFT JOIN market_metadata_raw mmr ON mmr.market_id = m.id
      WHERE m.id = ANY($1::int[])`,
    [marketIds],
  );
  for (const r of res.rows) out.set(r.market_id, parseMemberHalfLine(r));
  return out;
}

/** Builds the full leg-union half-line refs (existing=not-incoming, new=incoming) and runs the pure detector. Read-only. */
async function computeHalfLineFoldRefusal(
  client: TxClient, sid: number | undefined, legs: LegInsert[],
): Promise<HalfLineFoldCollision | null> {
  const incomingNonResidual = legs.filter((l) => !l.is_residual);
  if (incomingNonResidual.length === 0) return null;

  interface ExRow { outcome_id: string; is_residual: boolean; market_id: number }
  const existing: ExRow[] = sid == null ? [] : (await client.query<ExRow>(
    `SELECT outcome_id, is_residual, market_id FROM semantic_event_legs WHERE semantic_event_id = $1`,
    [sid],
  )).rows;

  const marketIds = [...new Set([
    ...incomingNonResidual.map((l) => l.market_id),
    ...existing.filter((e) => !e.is_residual).map((e) => e.market_id),
  ])];
  const lines = await loadMemberHalfLines(client, marketIds);

  const refs: HalfLineLegRef[] = [
    ...existing.map((e) => ({
      outcome_id: e.outcome_id, is_residual: e.is_residual,
      half_line: lines.get(e.market_id) ?? null, is_incoming: false,
    })),
    ...legs.map((l) => ({
      outcome_id: l.outcome_id, is_residual: l.is_residual,
      half_line: lines.get(l.market_id) ?? null, is_incoming: true,
    })),
  ];
  return findHalfLineFoldRefusal(refs);
}

/** persistMatch outcome: the semantic_event id, and whether the sibling guard refused the attach. */
export interface PersistMatchResult {
  semanticEventId: number;
  refused: boolean;
}

/** Persists a validated match in one transaction: create/reuse the semantic_event, run the
 *  sibling refusal (expansion only), bind platform_events, insert legs, mark the candidate done. */
export async function persistMatch(args: PersistMatchArgs): Promise<PersistMatchResult> {
  const { candidateId, platformEventIds, matchConfidence, legs } = args;
  return withTx(async (client) => {
    const foldCollision = await computeHalfLineFoldRefusal(client, args.existingSemanticEventId, legs);
    if (foldCollision) {
      beltHit('half_line_fold_refuse', {
        reason: args.existingSemanticEventId ? 'expand' : 'create',
        se: args.existingSemanticEventId ?? null,
        outcome: foldCollision.outcome_id, keys: foldCollision.keys.join(' vs '),
      });
      await client.query(
        `UPDATE stage3_event_candidates
           SET status = 'skipped', llm_reasoning = $2, processed_at = NOW()
         WHERE id = $1`,
        [candidateId,
          `value-blind-fold refusal: outcome "${foldCollision.outcome_id}" would fuse markets with `
          + `different half-lines (${foldCollision.keys[0]} vs ${foldCollision.keys[1]}) — a threshold/count `
          + `tail must not fold onto a node with a different YES-boundary`],
      );
      return { semanticEventId: args.existingSemanticEventId ?? 0, refused: true };
    }

    let sid: number;
    if (args.existingSemanticEventId) {
      sid = args.existingSemanticEventId;
    } else {
      const se = args.semanticEvent!;
      const windowSql = se.deadline_window
        ? `tstzrange($5::timestamptz, $6::timestamptz, '[]')`
        : `NULL`;
      const seSubject = bucketSubjectOrNull(se.canonical_subject);
      const params = se.deadline_window
        ? [se.canonical_event, seSubject, se.grouping_kind, se.participants,
           se.deadline_window[0], se.deadline_window[1], se.confidence, se.llm_model, se.match_reasoning]
        : [se.canonical_event, seSubject, se.grouping_kind, se.participants,
           se.confidence, se.llm_model, se.match_reasoning];
      // Param indices shift when there's no window; build the tail accordingly.
      const tail = se.deadline_window ? '$7, $8, $9' : '$5, $6, $7';
      const res = await client.query<{ id: number }>(
        `INSERT INTO semantic_events
           (canonical_event, canonical_subject, grouping_kind, participants, deadline_window, confidence, llm_model, match_reasoning)
         VALUES ($1, $2, $3, $4::text[], ${windowSql}, ${tail})
         RETURNING id`,
        params,
      );
      sid = res.rows[0].id;
    }

    // Expansion only — a create pair is cross-platform so cannot collide.
    if (args.existingSemanticEventId && legs.length > 0) {
      const newMarketIds = [...new Set(legs.map((l) => l.market_id))];
      const peRows = await client.query<{ market_id: number; pe_id: number | null }>(
        `SELECT m.id AS market_id, pe.id AS pe_id
           FROM markets m
           LEFT JOIN platform_events pe
             ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
          WHERE m.id = ANY($1::int[])`,
        [newMarketIds],
      );
      const peByMarket = new Map(peRows.rows.map((r) => [r.market_id, r.pe_id]));
      const incoming: SiblingLegRef[] = legs.map((l) => ({
        outcome_id: l.outcome_id,
        platform: l.platform,
        platform_event_id: peByMarket.get(l.market_id) ?? null,
        is_residual: l.is_residual,
      }));
      const exRows = await client.query<{ outcome_id: string; platform: string; pe_id: number | null; is_residual: boolean }>(
        `SELECT sel.outcome_id, sel.platform, pe.id AS pe_id, sel.is_residual
           FROM semantic_event_legs sel
           LEFT JOIN markets m ON m.id = sel.market_id
           LEFT JOIN platform_events pe
             ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
          WHERE sel.semantic_event_id = $1`,
        [sid],
      );
      const existing: SiblingLegRef[] = exRows.rows.map((r) => ({
        outcome_id: r.outcome_id,
        platform: r.platform,
        platform_event_id: r.pe_id,
        is_residual: r.is_residual,
      }));
      const collision = findSamePlatformSiblingRefusal(existing, incoming);
      if (collision) {
        beltHit('same_platform_sibling_refuse', {
          reason: 'transitive', se: sid, outcome: collision.outcome_id, platform: collision.platform,
        });
        await client.query(
          `UPDATE stage3_event_candidates
             SET status = 'skipped', llm_reasoning = $2, processed_at = NOW()
           WHERE id = $1`,
          [candidateId,
            `same-platform sibling-event refusal (transitive): attaching would feed outcome `
            + `"${collision.outcome_id}" with ${collision.platform_event_ids.length} distinct ${collision.platform} `
            + `platform_events (${collision.platform_event_ids.join(', ')}) — a platform never lists the same `
            + `question twice, so same-platform sibling events must not merge into one outcome node`],
        );
        return { semanticEventId: sid, refused: true };
      }
    }

    for (const peId of platformEventIds) {
      await client.query(
        `INSERT INTO semantic_event_platforms (semantic_event_id, platform_event_id, match_confidence)
         VALUES ($1, $2, $3)
         ON CONFLICT (semantic_event_id, platform_event_id) DO NOTHING`,
        [sid, peId, matchConfidence],
      );
    }

    if (legs.length > 0) {
      await client.query(
        `INSERT INTO semantic_event_legs
           (semantic_event_id, outcome_id, outcome_label, outcome_subject, outcome_ordinal, is_residual, platform, market_id)
         SELECT $1, t.outcome_id, t.outcome_label, t.outcome_subject, t.outcome_ordinal, t.is_residual, t.platform, t.market_id
         FROM unnest(
                $2::text[], $3::text[], $4::text[], $5::int[], $6::bool[], $7::text[], $8::int[]
              ) AS t(outcome_id, outcome_label, outcome_subject, outcome_ordinal, is_residual, platform, market_id)
         ON CONFLICT (semantic_event_id, outcome_id, platform, market_id) DO NOTHING`,
        [
          sid,
          legs.map((l) => l.outcome_id),
          legs.map((l) => l.outcome_label),
          legs.map((l) => bucketSubjectOrNull(l.outcome_subject)),
          legs.map((l) => l.outcome_ordinal),
          legs.map((l) => l.is_residual),
          legs.map((l) => l.platform),
          legs.map((l) => l.market_id),
        ],
      );
    }

    await client.query(
      `UPDATE stage3_event_candidates
         SET status = 'done', semantic_event_id = $2, processed_at = NOW()
       WHERE id = $1`,
      [candidateId, sid],
    );

    return { semanticEventId: sid, refused: false };
  });
}

export async function markCandidate(
  id: number,
  status: 'failed' | 'skipped' | 'done',
  llmReasoning?: string | null,
): Promise<void> {
  await query(
    `UPDATE stage3_event_candidates
       SET status = $2, llm_reasoning = COALESCE($3, llm_reasoning), processed_at = NOW()
     WHERE id = $1`,
    [id, status, llmReasoning ?? null],
  );
}

/** Bare transient-failure sentinels; a guard-reject reason always carries a trailing
 *  '[reason]' suffix, so these never collide with a sound rejection. */
export const TRANSIENT_SENTINELS = ['LLM returned no JSON', 'platform_event row missing'] as const;

/** Re-queues while retry_count < maxRetries, else terminal; must stay in sync with the SQL `CASE WHEN retry_count < $N`. */
export function nextTransientStatus(retryCount: number, maxRetries = 3): 'pending' | 'failed' {
  return retryCount < maxRetries ? 'pending' : 'failed';
}

/** Flips a transient failure back to pending (incrementing retry_count) below maxRetries, else
 *  terminal; guard rejects and no_match stay terminal. */
export async function markTransientFailure(
  id: number,
  reason: string | null,
  maxRetries = 3,
): Promise<void> {
  await query(
    `UPDATE stage3_event_candidates
       SET status = CASE WHEN retry_count < $3 THEN 'pending' ELSE 'failed' END,
           retry_count = retry_count + 1,
           llm_reasoning = COALESCE($2, llm_reasoning),
           processed_at = NOW()
     WHERE id = $1`,
    [id, reason ?? null, maxRetries],
  );
}

/** Resets crashed-run 'in_progress' candidates back to 'pending'; call once at drain start. */
export async function resetStaleInProgress(maxRetries = 3): Promise<number> {
  const rows = await query<{ n: number }>(
    `WITH upd AS (
       UPDATE stage3_event_candidates SET status = 'pending'
       WHERE status = 'in_progress'
          -- Re-arm stuck 'failed' rows by exact sentinel equality (not LIKE), plus retry bound.
          OR (status = 'failed'
              AND retry_count < ${'$1'}
              AND llm_reasoning IN ('LLM returned no JSON', 'platform_event row missing'))
       RETURNING 1
     ) SELECT COUNT(*)::int AS n FROM upd`,
    [maxRetries],
  );
  return rows[0]?.n ?? 0;
}

export async function countPendingCandidates(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM stage3_event_candidates WHERE status = 'pending'`,
  );
  return rows[0]?.n ?? 0;
}

/** Per-child-market meta consumed by the Stage 3b guards (see getChildMarketMeta). */
export interface ChildMarketMeta {
  platform: string;
  platform_event_id: number | null;
  resolution_scope: string | null;
  /** platform_events.sport_canonical; cricket's tie is not a draw. */
  sport: string | null;
  canonical_subject: string | null;
  event_kind: string | null;
  metric_scope: string | null;
  canonical_event: string | null;
  condition_date: string | null;
  condition_date_precision: string | null;
  end_date: string | null;
  condition_direction: string | null;
  condition_shape: string | null;
  condition_metric: string | null;
  value_primary: string | null;
  value_secondary: string | null;
  value_unit: string | null;
  strike_type: string | null;
  floor_strike: string | null;
  cap_strike: string | null;
  weather_text: string | null;
  settlement_dimension: string | null;
  native_label: string | null;
  /** NULL when there's no outcomes array or it's the plain {Yes,No} vocabulary;
   *  the moneyline family has no scalar native label. */
  native_outcomes: string[] | null;
  title: string | null;
  discriminators: Record<string, string> | null;
  /** split_part(event_ticker,'-',1); NULL off-Kalshi. */
  kalshi_series: string | null;
}

/** market_id → guard meta for every child market of the given platform_events (full set). */
export async function getChildMarketMeta(
  platformEventIds: number[],
): Promise<Map<number, ChildMarketMeta>> {
  const map = new Map<number, ChildMarketMeta>();
  if (platformEventIds.length === 0) return map;
  const rows = await query<ChildMarketMeta & { market_id: number }>(
    `SELECT m.id AS market_id, m.platform, pe.id AS platform_event_id, m.resolution_scope, pe.sport_canonical AS sport,
            n.canonical_subject, n.event_kind,
            n.metric_scope, n.canonical_event,
            n.condition_date::text AS condition_date, n.condition_date_precision, m.end_date::text AS end_date,
            n.condition_direction, n.condition_shape, n.condition_metric,
            n.value_primary::text AS value_primary, n.value_secondary::text AS value_secondary,
            n.value_unit,
            mmr.raw->>'strike_type' AS strike_type,
            mmr.raw->>'floor_strike' AS floor_strike,
            mmr.raw->>'cap_strike' AS cap_strike,
            CASE WHEN n.event_kind LIKE 'weather%'
                 THEN left(COALESCE(mmr.raw->>'rules_primary', mmr.raw->>'description'), 2000)
            END AS weather_text,
            -- Not event_kind gated: these markets can be unshaped.
            ${settlementDimensionSql('mmr.raw')} AS settlement_dimension,
            COALESCE(mmr.raw->>'groupItemTitle', mmr.raw->>'yes_sub_title',
                     mmr.raw#>>'{custom_strike,Team}', n.condition_value,
                     n.outcome_label) AS native_label,
            -- NULL for the plain {Yes,No} binary vocabulary.
            CASE
              WHEN jsonb_typeof(mmr.raw->'outcomes') = 'array'
                   AND NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements_text(mmr.raw->'outcomes') o(v)
                      WHERE lower(btrim(o.v)) IN ('yes','no','true','false'))
              THEN ARRAY(SELECT jsonb_array_elements_text(mmr.raw->'outcomes'))
            END AS native_outcomes,
            m.title AS title,
            n.discriminators AS discriminators,
            CASE WHEN m.platform = 'kalshi'
                 THEN split_part(mmr.raw->>'event_ticker', '-', 1)
            END AS kalshi_series
       FROM platform_events pe
       JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
       LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
       LEFT JOIN market_metadata_raw mmr ON mmr.market_id = m.id
      WHERE pe.id = ANY($1::int[])`,
    [platformEventIds],
  );
  for (const r of rows) {
    const { market_id, ...meta } = r;
    map.set(market_id, meta);
  }
  return map;
}

/** Per-market canonical_subject/event_kind of legs already bound to a semantic_event (N-platform expansion only). */
export async function getSemanticEventLegSubjects(
  semanticEventId: number,
): Promise<{
  canonical_subject: string | null;
  event_kind: string | null;
  metric_scope: string | null;
  /** Distinct from the SE-level canonical_event: per-market fixture identity for the cross-fixture guard. */
  market_canonical_event: string | null;
  condition_date: string | null;
  condition_date_precision: string | null;
  title: string | null;
  /** split_part(event_ticker,'-',1); NULL off-Kalshi. */
  kalshi_series: string | null;
  outcome_id: string;
  outcome_subject: string | null;
  market_id: number;
  /** Sibling guard: >=2 platform_event_ids per (outcome, platform) across the leg union is a collision. */
  platform: string | null;
  platform_event_id: number | null;
}[]> {
  const rows = await query<{
    canonical_subject: string | null;
    event_kind: string | null;
    metric_scope: string | null;
    market_canonical_event: string | null;
    condition_date: string | null;
    condition_date_precision: string | null;
    title: string | null;
    kalshi_series: string | null;
    outcome_id: string;
    outcome_subject: string | null;
    market_id: number;
    platform: string | null;
    platform_event_id: number | null;
  }>(
    // outcome_id/outcome_subject/market_id feed prior-leg union reconciliation in validateMatch;
    // market_canonical_event (not the SE-level canonical_event, which drifts cross-platform) feeds
    // the cross-fixture guard.
    `SELECT n.canonical_subject, n.event_kind, n.metric_scope,
            n.canonical_event AS market_canonical_event,
            n.condition_date::text AS condition_date, n.condition_date_precision,
            m.title AS title,
            CASE WHEN m.platform = 'kalshi'
                 THEN split_part(mmr.raw->>'event_ticker', '-', 1)
            END AS kalshi_series,
            sel.outcome_id, sel.outcome_subject, sel.market_id,
            m.platform AS platform, pe.id AS platform_event_id
       FROM semantic_event_legs sel
       LEFT JOIN llm_market_normalizations n ON n.market_id = sel.market_id
       LEFT JOIN markets m ON m.id = sel.market_id
       LEFT JOIN platform_events pe ON pe.platform = m.platform AND pe.platform_event_id = m.platform_event_id
       LEFT JOIN market_metadata_raw mmr ON mmr.market_id = sel.market_id
      WHERE sel.semantic_event_id = $1`,
    [semanticEventId],
  );
  return rows;
}

/** Guard-reject reason tails salvageable on retry (matched via LIKE against llm_reasoning's trailing '[reason]']). */
export const SALVAGEABLE_FAILURE_LIKE_PATTERNS = [
  '%has no leg (phantom outcome)]',
  '%" shared by outcomes %',
  '% claimed by two outcomes %',
  '%double-mapped market across the expansion union]',
] as const;

/** SQL for the re-queue, exported for the no-DB string-invariant tests. */
export function requeueSalvageableFailedSql(): string {
  const likes = SALVAGEABLE_FAILURE_LIKE_PATTERNS
    .map((p) => `llm_reasoning LIKE '${p}'`)
    .join('\n            OR ');
  return `
    WITH upd AS (
      UPDATE stage3_event_candidates
         SET status = 'pending', retry_count = retry_count + 1
       WHERE status = 'failed'
         AND retry_count < $1
         AND (${likes}
            OR llm_reasoning = '${TRANSIENT_SENTINELS[0]}')
       RETURNING 1
    ) SELECT COUNT(*)::int AS n FROM upd
  `;
}

/** Re-arms salvageable 'failed' candidates (retry_count < maxRetries); re-armed rows re-enter the same claim→validate→persist gate. */
export async function requeueSalvageableFailedCandidates(maxRetries = 1): Promise<number> {
  const rows = await query<{ n: number }>(requeueSalvageableFailedSql(), [maxRetries]);
  return rows[0]?.n ?? 0;
}

/** One KB hit for a subject surface form: its `type`, and whether the hit was on the canonical name. */
export interface SubjectTypeRow {
  subj: string;
  type: string | null;
  is_canonical: boolean;
}

/** Collapses (subject × KB-hit) rows to one type per subject: a canonical hit wins; alias-only
 *  hits agree or the subject is untyped (null). */
export function collapseSubjectTypeRows(rows: SubjectTypeRow[]): Map<string, string | null> {
  const canon = new Map<string, string | null>();
  const aliasTypes = new Map<string, Set<string | null>>();
  for (const r of rows) {
    if (r.is_canonical) {
      // Prefer a non-null canonical type if two canonical rows collide.
      if (!canon.has(r.subj) || canon.get(r.subj) == null) canon.set(r.subj, r.type);
    } else {
      let s = aliasTypes.get(r.subj);
      if (!s) { s = new Set(); aliasTypes.set(r.subj, s); }
      s.add(r.type);
    }
  }
  const out = new Map<string, string | null>();
  for (const [subj, t] of canon) out.set(subj, t);
  for (const [subj, types] of aliasTypes) {
    if (out.has(subj)) continue; // canonical hit already decided this subject
    out.set(subj, types.size === 1 ? [...types][0] : null);
  }
  return out;
}

/** Lowercased subject → KB entity `type`, resolved by canonical or alias; subjects with no KB row are absent. */
export async function getSubjectTypes(subjects: string[]): Promise<Map<string, string | null>> {
  const lowered = [...new Set(subjects.map((s) => s.toLowerCase().trim()).filter(Boolean))];
  if (lowered.length === 0) return new Map<string, string | null>();
  const rows = await query<SubjectTypeRow>(
    `SELECT s AS subj, ke.type, (lower(ke.canonical) = s) AS is_canonical
       FROM unnest($1::text[]) s
       JOIN known_entities ke
         ON lower(ke.canonical) = s
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ke.aliases) a WHERE lower(a) = s)`,
    [lowered],
  );
  return collapseSubjectTypeRows(rows);
}

/** One KB hit for a subject surface form, carrying the person `role`. */
export interface SubjectTypingRow extends SubjectTypeRow {
  role: string | null;
}

/** Role-carrying sibling of collapseSubjectTypeRows: same canonical-wins/alias-agreement policy, over {type, role}. */
export function collapseSubjectTypingRows(
  rows: SubjectTypingRow[],
): Map<string, { type: string | null; role: string | null }> {
  const canon = new Map<string, { type: string | null; role: string | null }>();
  const aliasHits = new Map<string, { type: string | null; role: string | null }[]>();
  for (const r of rows) {
    if (r.is_canonical) {
      const prev = canon.get(r.subj);
      if (!prev || prev.type == null) canon.set(r.subj, { type: r.type, role: r.role });
    } else {
      let a = aliasHits.get(r.subj);
      if (!a) { a = []; aliasHits.set(r.subj, a); }
      a.push({ type: r.type, role: r.role });
    }
  }
  const out = new Map<string, { type: string | null; role: string | null }>();
  for (const [subj, v] of canon) out.set(subj, v);
  for (const [subj, hits] of aliasHits) {
    if (out.has(subj)) continue;
    const types = new Set(hits.map((h) => h.type));
    if (types.size !== 1) { out.set(subj, { type: null, role: null }); continue; }
    const roles = new Set(hits.map((h) => h.role));
    out.set(subj, { type: [...types][0], role: roles.size === 1 ? [...roles][0] : null });
  }
  return out;
}

/** Role-carrying sibling of getSubjectTypes; `role` = known_entities.metadata->>'role'. */
export async function getSubjectTypings(
  subjects: string[],
): Promise<Map<string, { type: string | null; role: string | null }>> {
  const lowered = [...new Set(subjects.map((s) => s.toLowerCase().trim()).filter(Boolean))];
  if (lowered.length === 0) return new Map();
  const rows = await query<SubjectTypingRow>(
    `SELECT s AS subj, ke.type, ke.metadata->>'role' AS role, (lower(ke.canonical) = s) AS is_canonical
       FROM unnest($1::text[]) s
       JOIN known_entities ke
         ON lower(ke.canonical) = s
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ke.aliases) a WHERE lower(a) = s)`,
    [lowered],
  );
  return collapseSubjectTypingRows(rows);
}

/** Party-carrying sibling of getSubjectTypes; `party` = known_entities.metadata->>'party' (curated seeds only). */
export async function getSubjectPartyTypings(
  subjects: string[],
): Promise<Map<string, { type: string | null; party: string | null }>> {
  const lowered = [...new Set(subjects.map((s) => s.toLowerCase().trim()).filter(Boolean))];
  if (lowered.length === 0) return new Map();
  const rows = await query<SubjectTypingRow>(
    `SELECT s AS subj, ke.type, ke.metadata->>'party' AS role, (lower(ke.canonical) = s) AS is_canonical
       FROM unnest($1::text[]) s
       JOIN known_entities ke
         ON lower(ke.canonical) = s
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(ke.aliases) a WHERE lower(a) = s)`,
    [lowered],
  );
  const collapsed = collapseSubjectTypingRows(rows);
  return new Map([...collapsed].map(([k, v]) => [k, { type: v.type, party: v.role }]));
}
