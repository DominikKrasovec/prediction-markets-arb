// Stage 2a entity resolution: fills platform_events identity fields from native scraper
// fields via one batched KB resolve per event; only touches unresolved events (idempotent).
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import { warmKBCache, loadStructuralSignalsIndex } from '../db/entity-registry.js';
import { resolveSubjectViaKB, isNonEntityLabel, looksLikePredicate, kbHasRealEntity } from '../db/entity/resolvers.js';
import { beltHit } from '../discriminators/telemetry.js';
import { inferEntityScope } from '../stage1-normalize/infer-entity-scope.js';
import { unifiedToDomain } from '../db/category-taxonomy.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import {
  FIXTURE_LABEL_POLLUTED_KINDS, parseFixtureMatchupTitle, resolveTeamCanonical,
} from '../stage3-events/idioms/team-identity.js';
import type { UnifiedCategory } from '@arb/types';

const log = createLogger('resolve-event-identity');
const PAGE = parseInt(process.env.EVENT_IDENTITY_PAGE_SIZE ?? '500', 10);
const RESOLVE_CONCURRENCY = parseInt(process.env.EVENT_IDENTITY_CONCURRENCY ?? '8', 10);

export interface EventIdentityStats {
  resolved: number;
  multiSubject: number;
  h2h: number;
  scoped: number;
}

interface EventRow {
  id: number;
  platform: string;
  title: string;
  category: string | null;
  labels: string[] | null;
  event_ticker: string | null;
  tags: string[] | null;
  market_category: string | null;
}

// EXACT lowercase match only, never substring, so real entities containing these words (Motherwell) survive.
const RESIDUAL_LABELS = new Set([
  'draw', 'tie', 'tie/co-winners', 'tie / co-winners', 'decision / draw / no contest',
  'no contest', 'other', 'another', 'field', 'the field', 'any other',
  'none of the above', 'none of these',
  // 'Yes'/'No' are Kalshi's generic binary outcome labels; dropped before the kbHasRealEntity bypass.
  'yes', 'no',
]);
export function isResidualLabel(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t) return true;
  if (/^draw\s*\(/.test(t)) return true;
  if (/^(any other|another)\b/.test(t)) return true;
  return RESIDUAL_LABELS.has(t);
}

export { isNonEntityLabel };

// Parses an A-vs-B matchup title via the shared parseFixtureMatchupTitle, which also
// strips comp prefixes/suffixes and rejects 3-way titles.
export function parseMatchupTitle(title: string): [string, string] | null {
  // Strips a trailing "ends in a draw?" predicate so the A-vs-B fixture underneath parses.
  const t = title.replace(/\s+end(?:s|ed|ing)?\s+in\s+(?:a\s+)?draw\b\s*\??\s*$/i, '').trim();
  return parseFixtureMatchupTitle(t);
}

/** Strip trailing question/role boilerplate so the title reduces toward a subject phrase. */
export function cleanSubjectTitle(title: string): string {
  return title
    .replace(/\s*\?+\s*$/g, '')
    .replace(/\b(winner|who will win|who wins|who will be)\b.*$/i, '')
    .trim() || title.trim();
}

async function selectPage(limit: number, afterId: number): Promise<EventRow[]> {
  // Paginated by an id cursor: (NULL, {}) still matches the predicate, so it loops forever without it.
  return query<EventRow>(
    `WITH ev AS (
       SELECT id, platform, platform_event_id, title, category
       FROM platform_events
       WHERE id > $2 AND canonical_subject IS NULL AND participants = '{}'
       ORDER BY id
       LIMIT $1
     ),
     lab AS (
       SELECT ev.id AS pe_id,
              array_agg(DISTINCT l.label) FILTER (WHERE l.label IS NOT NULL AND l.label <> '') AS labels
       FROM ev
       JOIN markets m ON m.platform = ev.platform AND m.platform_event_id = ev.platform_event_id
       LEFT JOIN market_metadata_raw mmr ON mmr.market_id = m.id
       CROSS JOIN LATERAL (
         SELECT COALESCE(
                  mmr.raw->>'groupItemTitle',
                  mmr.raw->>'yes_sub_title',
                  mmr.raw#>>'{custom_strike,Team}'
                ) AS label
       ) l
       GROUP BY ev.id
     ),
     scp AS (
       SELECT DISTINCT ON (ev.id) ev.id AS pe_id,
              mmr.raw->>'event_ticker' AS event_ticker,
              COALESCE(m.tags, '{}') || COALESCE(m.tag_slugs, '{}') AS tags,
              m.category AS market_category
       FROM ev
       JOIN markets m ON m.platform = ev.platform AND m.platform_event_id = ev.platform_event_id
       LEFT JOIN market_metadata_raw mmr ON mmr.market_id = m.id
       ORDER BY ev.id, m.id
     )
     SELECT ev.id, ev.platform, ev.title, ev.category,
            lab.labels, scp.event_ticker, scp.tags, scp.market_category
     FROM ev
     LEFT JOIN lab ON lab.pe_id = ev.id
     LEFT JOIN scp ON scp.pe_id = ev.id
     ORDER BY ev.id`,
    [limit, afterId],
  );
}

interface IdentityUpdate {
  id: number;
  canonical_subject: string | null;
  participants: string[];
  sport: string | null;
  league: string | null;
}

async function resolveOne(ev: EventRow, stats: EventIdentityStats): Promise<IdentityUpdate> {
  const domain = unifiedToDomain((ev.category ?? null) as UnifiedCategory | null);
  const scope = inferEntityScope({
    platform: ev.platform,
    event_ticker: ev.event_ticker,
    tags: ev.tags,
    parent_event_tags: null,
    market_category: ev.market_category,
  });

  // "X Up or Down" candle events: resolve only the asset prefix; candles match deterministically elsewhere.
  const uod = /^(.*?)\s+up\s+or\s+down\b/i.exec(ev.title);
  if (uod) {
    const assetText = uod[1]!.trim();
    const subj = assetText && !isNonEntityLabel(assetText)
      ? await resolveSubjectViaKB(assetText, domain, scope)
      : null;
    if (scope?.sport || scope?.league) stats.scoped++;
    stats.resolved++;
    return { id: ev.id, canonical_subject: subj, participants: subj ? [subj] : [], sport: scope?.sport ?? null, league: scope?.league ?? null };
  }

  // Drop residuals and non-entity condition values before KB resolution — never embed a value string.
  const filtered: string[] = [];
  for (const l of ev.labels ?? []) {
    if (!l || isResidualLabel(l)) continue;
    if (isNonEntityLabel(l)) {
      if (await kbHasRealEntity(l)) beltHit('non_entity_label_kbhit');
      else continue;
    }
    filtered.push(l);
  }
  // >=2 labels sharing the "<team|party|coach> <1-2 letters/digits>" shape are an anonymized
  // placeholder sequence, dropped unless individually a real KB entity (protects "Team GB").
  const PLACEHOLDER_SEQ_RX = /^(?:team|party|coach)\s+(?:[a-z]{1,2}|\d{1,2})$/i;
  const seqCount = filtered.filter((l) => PLACEHOLDER_SEQ_RX.test(l.trim())).length;
  let rawLabels = filtered;
  if (seqCount >= 2) {
    rawLabels = [];
    for (const l of filtered) {
      if (!PLACEHOLDER_SEQ_RX.test(l.trim()) || (await kbHasRealEntity(l))) rawLabels.push(l);
    }
  }
  const resolvedParts = [
    ...new Set(await Promise.all(rawLabels.map((l) => resolveSubjectViaKB(l, domain, scope)))),
  ].sort();

  const matchup = parseMatchupTitle(ev.title);
  const isH2H = matchup !== null;
  const nonResidual = resolvedParts.length;

  let canonical_subject: string | null;
  let participants: string[];
  if (isH2H || nonResidual === 2) {
    // Head-to-head fixture: the participant pair IS the identity, never a single subject.
    canonical_subject = null;
    if (resolvedParts.length >= 2) {
      participants = resolvedParts;
    } else if (matchup) {
      // No usable native labels: resolve the two title-parsed sides instead.
      const [ra, rb] = await Promise.all([
        resolveSubjectViaKB(matchup[0], domain, scope),
        resolveSubjectViaKB(matchup[1], domain, scope),
      ]);
      participants = [...new Set([ra, rb])].sort();
    } else {
      participants = resolvedParts;
    }
    stats.h2h++;
  } else if (nonResidual >= 3) {
    // Multi-subject axis (election, "Next Team"): subject is the axis, not a participant.
    canonical_subject = null;
    participants = resolvedParts;
    stats.multiSubject++;
  } else {
    // Skips KB resolution when the cleaned title is itself a condition value or a
    // predicate/metric question, unless it fold-matches a real registered entity.
    const cleaned = cleanSubjectTitle(ev.title);
    const nel = isNonEntityLabel(cleaned);
    const lp = looksLikePredicate(cleaned);
    const cleanedIsReal = await kbHasRealEntity(cleaned);
    let subj: string | null;
    if (nel || lp) {
      if (cleanedIsReal) {
        if (nel) beltHit('non_entity_label_kbhit');
        if (lp) beltHit('looks_predicate_kbhit');
        subj = await resolveSubjectViaKB(cleaned, domain, scope);
      } else {
        subj = null;
      }
    } else {
      subj = await resolveSubjectViaKB(cleaned, domain, scope);
    }
    // resolveCanonical echoes its input on every refusal path; a non-real echo is a
    // refusal, never a resolution.
    if (subj !== null && subj === cleaned && !cleanedIsReal) {
      beltHit('subject_echo_refused');
      subj = null;
    }
    canonical_subject = subj;
    participants = subj
      ? (resolvedParts.length ? [...new Set([subj, ...resolvedParts])].sort() : [subj])
      : resolvedParts;
  }

  if (scope?.sport || scope?.league) stats.scoped++;
  stats.resolved++;
  return { id: ev.id, canonical_subject, participants, sport: scope?.sport ?? null, league: scope?.league ?? null };
}

async function writePage(updates: IdentityUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  await query(
    `UPDATE platform_events pe SET
       canonical_subject = u.canonical_subject,
       participants      = COALESCE(u.participants, '{}'),
       sport_canonical   = u.sport,
       league_canonical  = u.league,
       updated_at        = NOW()
     FROM jsonb_to_recordset($1::jsonb)
       AS u(id int, canonical_subject text, participants text[], sport text, league text)
     WHERE pe.id = u.id`,
    [JSON.stringify(updates)],
  );
}

// Runs as the entity step of Stage 2a (after date/category roll-up, before the 2c embed).
// Behind STAGE2A_ENTITY (default on).
export async function resolveEventIdentity(): Promise<EventIdentityStats> {
  const stats: EventIdentityStats = { resolved: 0, multiSubject: 0, h2h: 0, scoped: 0 };

  await warmKBCache();
  await loadStructuralSignalsIndex();

  let afterId = 0;
  for (;;) {
    const page = await selectPage(PAGE, afterId);
    if (page.length === 0) break;
    const updates = await mapWithConcurrency(page, RESOLVE_CONCURRENCY, (ev) => resolveOne(ev, stats));
    await writePage(updates);
    afterId = page[page.length - 1].id; // page is ORDER BY ev.id — last row is the max id
    log.info(`Stage 2a entity: resolved ${stats.resolved} events ` +
      `(multi-subject=${stats.multiSubject} h2h=${stats.h2h} scoped=${stats.scoped})`);
    if (page.length < PAGE) break;
  }

  log.info(`Stage 2a entity complete: ${stats.resolved} events resolved, ` +
    `${stats.multiSubject} multi-subject, ${stats.h2h} head-to-head, ${stats.scoped} sport/league-scoped`);
  return stats;
}

export interface FixtureParticipantBackfillStats {
  scanned: number;
  /** stamped with BOTH real team canonicals. */
  stamped: number;
  /** title parsed but only ONE side resolved to a KB team — stamps nothing. */
  oneSideOnly: number;
  noParse: number;
}

interface FixtureRow {
  id: number;
  event_kind: string;
  title: string;
  category: string | null;
  sport: string | null;
  league: string | null;
  participants: string[] | null;
}

// Fixture-kind events with outcome-label-polluted participants (score/prop labels, not
// team names) have no usable team identity; parses the "A vs B" title instead and stamps
// participants only when both sides resolve to distinct real KB teams.
export async function backfillFixtureParticipants(): Promise<FixtureParticipantBackfillStats> {
  const stats: FixtureParticipantBackfillStats = { scanned: 0, stamped: 0, oneSideOnly: 0, noParse: 0 };
  await warmKBCache();

  const kinds = [...FIXTURE_LABEL_POLLUTED_KINDS];
  let afterId = 0;
  for (;;) {
    const page = await query<FixtureRow>(
      `SELECT id, event_kind, title, category,
              sport_canonical AS sport, league_canonical AS league, participants
         FROM platform_events
        WHERE id > $2 AND event_kind = ANY($1::text[])
        ORDER BY id
        LIMIT $3`,
      [kinds, afterId, PAGE],
    );
    if (page.length === 0) break;
    afterId = page[page.length - 1].id;

    const updates: { id: number; participants: string[] }[] = [];
    await mapWithConcurrency(page, RESOLVE_CONCURRENCY, async (ev) => {
      stats.scanned++;
      const parsed = parseFixtureMatchupTitle(ev.title);
      if (!parsed) { stats.noParse++; return; }
      const domain = unifiedToDomain((ev.category ?? null) as UnifiedCategory | null);
      const [ta, tb] = await Promise.all([
        resolveTeamCanonical(parsed[0], domain, ev.sport, ev.league),
        resolveTeamCanonical(parsed[1], domain, ev.sport, ev.league),
      ]);
      if (!ta || !tb || ta === tb) { if (ta || tb) stats.oneSideOnly++; return; }
      const teams = [ta, tb].sort();
      const cur = [...(ev.participants ?? [])].sort();
      if (cur.length === 2 && cur[0] === teams[0] && cur[1] === teams[1]) { stats.stamped++; return; }
      updates.push({ id: ev.id, participants: teams });
      stats.stamped++;
    });

    if (updates.length > 0) {
      await query(
        `UPDATE platform_events pe SET participants = u.participants, updated_at = NOW()
           FROM jsonb_to_recordset($1::jsonb) AS u(id int, participants text[])
          WHERE pe.id = u.id`,
        [JSON.stringify(updates)],
      );
    }
    if (page.length < PAGE) break;
  }

  log.info(`Stage 2a R4 fixture-participant backfill: scanned ${stats.scanned}, ` +
    `stamped ${stats.stamped} (both teams), one-side-only ${stats.oneSideOnly}, no-parse ${stats.noParse}`);
  return stats;
}
