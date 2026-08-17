/**
 * Stage 3b-pre -- deterministic crypto-candle matcher (no LLM). "Up or Down"
 * candle events are fully identified by (asset, open, duration), so a
 * same-window pair is confirmed/rejected arithmetically instead of by the
 * embedding, which can't tell candle windows apart. A pair whose title
 * doesn't parse as a candle is left pending for the LLM. Runs before
 * runEventMatch, so the LLM's pending pool is candle-free.
 */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import {
  persistMatch, markCandidate, findSemanticEventIdForPlatformEvent,
  getSemanticEventLegSubjects,
  type LegInsert,
} from '../db/queries/semantic-events.js';
import { parseCandleWindow } from './candle-window.js';
import { candleSettlementCompatible } from '../util/settlement-instrument.js';
import { beltHit } from '../discriminators/telemetry.js';

const log = createLogger('candle-match');

/** Candle length (minutes) at/below which an unknown settlement token is a hard
 *  skip rather than an LLM defer: short candles diverge in sign across feeds,
 *  daily/weekly moves dwarf inter-feed basis. */
export const CANDLE_SETTLEMENT_REQUIRED_MAX_MIN = 60;

export interface CandleIdentityLeg {
  asset: string;
  durationMin: number;
  ambiguous: boolean;
  open: string | null;
  /** Composite settlement token (oracle|tie), or null = unknown. */
  settlement: string | null;
}

export type CandleIdentityVerdict =
  | { verdict: 'match' }
  | { verdict: 'skip'; belt: 'candle_oracle_mismatch' | 'candle_open_mismatch' | null; reason: string }
  | { verdict: 'defer'; belt: 'candle_open_mismatch' | null; reason: string };

/** condition_date is UTC; +-60s covers rounding. */
function sameOpen(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a), tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= 60_000;
}

/** The single place the identity rules live: window (asset/duration/open) first,
 *  then settlement (P1) so a window reject keeps its specific reason. A
 *  both-known-and-incompatible settlement is always a SKIP, never a defer. */
export function candleIdentityMatch(a: CandleIdentityLeg, b: CandleIdentityLeg): CandleIdentityVerdict {
  const openMatches = sameOpen(a.open, b.open);
  const knownOpensDiffer = !!a.open && !!b.open && !openMatches;
  const windowMatches = a.asset === b.asset && a.durationMin === b.durationMin && openMatches;

  if (!windowMatches) {
    // duration-ambiguity defer only applies when the open is compatible
    const confidentReject = a.asset !== b.asset || knownOpensDiffer;
    if (!confidentReject && (a.ambiguous || b.ambiguous)) {
      return {
        verdict: 'defer',
        belt: (!a.open || !b.open) ? 'candle_open_mismatch' : null,
        reason: `ambiguous duration with compatible open (${a.asset} ${a.durationMin}m @${a.open ?? '?'} vs ${b.asset} ${b.durationMin}m @${b.open ?? '?'})`,
      };
    }
    return {
      verdict: 'skip',
      belt: knownOpensDiffer ? 'candle_open_mismatch' : null,
      reason: `window mismatch (${a.asset} ${a.durationMin}m @${a.open ?? '?'} vs ${b.asset} ${b.durationMin}m @${b.open ?? '?'})`,
    };
  }

  if (candleSettlementCompatible(a.settlement, b.settlement)) return { verdict: 'match' };

  if (a.settlement != null && b.settlement != null) {
    return {
      verdict: 'skip',
      belt: 'candle_oracle_mismatch',
      reason: `settlement mismatch — "${a.settlement}" vs "${b.settlement}": a different oracle stream or tie rule is a DIFFERENT question even on an identical window`,
    };
  }

  const intraday = Math.min(a.durationMin, b.durationMin) <= CANDLE_SETTLEMENT_REQUIRED_MAX_MIN;
  if (intraday) {
    return {
      verdict: 'skip',
      belt: 'candle_oracle_mismatch',
      reason: `settlement unknown on ${a.settlement == null && b.settlement == null ? 'both sides' : 'one side'} for a ≤${CANDLE_SETTLEMENT_REQUIRED_MAX_MIN}m candle (${a.settlement ?? 'NULL'} vs ${b.settlement ?? 'NULL'}) — intraday feeds disagree in SIGN, so an unproven settlement basis cannot be merged`,
    };
  }
  return {
    verdict: 'defer',
    belt: null,
    reason: `settlement unknown on a ${Math.min(a.durationMin, b.durationMin)}m candle — deferred to the LLM (daily/weekly moves dwarf inter-feed basis)`,
  };
}

export interface CandleMatchStats {
  matched: number;
  expanded: number;
  skipped: number;
  deferred: number;
}

interface CandleCandidateRow {
  cand_id: number;
  a_id: number; a_plat: string; a_title: string; a_mkt_title: string | null; a_open: string | null; a_market: number; a_end: string | null;
  b_id: number; b_plat: string; b_title: string; b_mkt_title: string | null; b_open: string | null; b_market: number; b_end: string | null;
  a_settlement: string | null; b_settlement: string | null;
}

export async function matchCryptoCandles(): Promise<CandleMatchStats> {
  const stats: CandleMatchStats = { matched: 0, expanded: 0, skipped: 0, deferred: 0 };

  // each candle event has exactly one child market (binary); LIMIT 1 takes that leg
  const rows = await query<CandleCandidateRow>(
    `SELECT c.id AS cand_id,
            a.id AS a_id, a.platform AS a_plat, a.title AS a_title, ma.title AS a_mkt_title,
            a.condition_date::text AS a_open, ma.market_id AS a_market, ma.end_date::text AS a_end,
            b.id AS b_id, b.platform AS b_plat, b.title AS b_title, mb.title AS b_mkt_title,
            b.condition_date::text AS b_open, mb.market_id AS b_market, mb.end_date::text AS b_end,
            sa.settlement AS a_settlement, sb.settlement AS b_settlement
       FROM stage3_event_candidates c
       JOIN platform_events a ON a.id = c.platform_event_a
       JOIN platform_events b ON b.id = c.platform_event_b
       -- m.title: Kalshi's platform_events title is a volatile display string;
       -- the MARKET title is the stable, parseable one (loop reads it for Kalshi)
       JOIN LATERAL (SELECT m.id AS market_id, m.end_date, m.title FROM markets m
              WHERE m.platform = a.platform AND m.platform_event_id = a.platform_event_id
              ORDER BY m.id LIMIT 1) ma ON true
       JOIN LATERAL (SELECT m.id AS market_id, m.end_date, m.title FROM markets m
              WHERE m.platform = b.platform AND m.platform_event_id = b.platform_event_id
              ORDER BY m.id LIMIT 1) mb ON true
       -- settlement token per side, unanimous-known (conflicting members -> NULL)
       LEFT JOIN LATERAL (
         SELECT CASE WHEN count(DISTINCT nz.settlement_instrument) = 1
                     THEN min(nz.settlement_instrument) END AS settlement
           FROM markets m
           JOIN llm_market_normalizations nz ON nz.market_id = m.id
          WHERE m.platform = a.platform AND m.platform_event_id = a.platform_event_id
            AND nz.settlement_instrument IS NOT NULL) sa ON true
       LEFT JOIN LATERAL (
         SELECT CASE WHEN count(DISTINCT nz.settlement_instrument) = 1
                     THEN min(nz.settlement_instrument) END AS settlement
           FROM markets m
           JOIN llm_market_normalizations nz ON nz.market_id = m.id
          WHERE m.platform = b.platform AND m.platform_event_id = b.platform_event_id
            AND nz.settlement_instrument IS NOT NULL) sb ON true
      WHERE c.status = 'pending'
        AND ( (a.platform IN ('polymarket','predict','limitless') AND a.title ILIKE '%up or down%')
           OR (a.platform = 'kalshi' AND a.event_kind = 'candle_direction') )
        AND ( (b.platform IN ('polymarket','predict','limitless') AND b.title ILIKE '%up or down%')
           OR (b.platform = 'kalshi' AND b.event_kind = 'candle_direction') )
      ORDER BY c.id`,
  );

  const windowMin = (open: string | null, end: string | null): number | undefined => {
    if (!open || !end) return undefined;
    const to = Date.parse(open), te = Date.parse(end);
    if (!Number.isFinite(to) || !Number.isFinite(te)) return undefined;
    return (te - to) / 60_000;
  };

  for (const r of rows) {
    const aTitle = (r.a_plat === 'kalshi' ? r.a_mkt_title : null) ?? r.a_title;
    const bTitle = (r.b_plat === 'kalshi' ? r.b_mkt_title : null) ?? r.b_title;
    const wa = parseCandleWindow(aTitle, windowMin(r.a_open, r.a_end));
    const wb = parseCandleWindow(bTitle, windowMin(r.b_open, r.b_end));

    if (!wa || !wb) { stats.deferred++; continue; }

    const decision = candleIdentityMatch(
      { asset: wa.asset, durationMin: wa.durationMin, ambiguous: wa.ambiguous, open: r.a_open, settlement: r.a_settlement },
      { asset: wb.asset, durationMin: wb.durationMin, ambiguous: wb.ambiguous, open: r.b_open, settlement: r.b_settlement },
    );
    if (decision.verdict !== 'match') {
      if (decision.belt) beltHit(decision.belt, { path: 'candle', cand: String(r.cand_id) });
      if (decision.verdict === 'defer') { stats.deferred++; continue; }
      await markCandidate(r.cand_id, 'skipped', `deterministic candle: ${decision.reason}`);
      stats.skipped++;
      continue;
    }

    const outcomeId = `${wa.asset.toLowerCase()}_up`;
    const leg = (plat: string, market_id: number): LegInsert => ({
      outcome_id: outcomeId, outcome_label: 'Up', outcome_subject: null,
      outcome_ordinal: null, is_residual: false, platform: plat, market_id,
    });

    const existing =
      (await findSemanticEventIdForPlatformEvent(r.a_id)) ??
      (await findSemanticEventIdForPlatformEvent(r.b_id)) ??
      undefined;

    // same-platform sibling-event guard: a platform never lists the same candle twice
    if (existing != null) {
      const priorTok = await query<{ settlement: string | null }>(
        `SELECT CASE WHEN count(DISTINCT nz.settlement_instrument) = 1
                     THEN min(nz.settlement_instrument) END AS settlement
           FROM semantic_event_legs sel
           JOIN llm_market_normalizations nz ON nz.market_id = sel.market_id
          WHERE sel.semantic_event_id = $1
            AND nz.settlement_instrument IS NOT NULL`,
        [existing],
      );
      const established = priorTok[0]?.settlement ?? null;
      const incoming = r.a_settlement ?? r.b_settlement;
      const expansionOk =
        established == null || incoming == null
          ? Math.min(wa.durationMin, wb.durationMin) > CANDLE_SETTLEMENT_REQUIRED_MAX_MIN
          : candleSettlementCompatible(established, incoming);
      if (!expansionOk) {
        beltHit('candle_oracle_mismatch', { path: 'candle-expansion', outcome: outcomeId });
        await markCandidate(r.cand_id, 'skipped',
          `deterministic candle: expansion settlement refusal — incoming basis "${incoming ?? 'NULL'}" is not compatible with the `
          + `semantic event's established basis "${established ?? 'NULL'}" on a ${Math.min(wa.durationMin, wb.durationMin)}m candle`);
        stats.skipped++;
        continue;
      }

      const prior = await getSemanticEventLegSubjects(existing);
      const feed = new Map<string, Set<number>>();
      const note = (platform: string | null, oid: string, peId: number | null) => {
        if (!platform || peId == null) return;
        const k = `${platform}\u0000${oid}`;
        let s = feed.get(k);
        if (!s) { s = new Set(); feed.set(k, s); }
        s.add(peId);
      };
      note(r.a_plat, outcomeId, r.a_id);
      note(r.b_plat, outcomeId, r.b_id);
      for (const pl of prior) note(pl.platform, pl.outcome_id, pl.platform_event_id);
      const collide = [...feed.values()].some((s) => s.size >= 2);
      if (collide) {
        beltHit('same_platform_sibling_refuse', { path: 'candle', outcome: outcomeId });
        await markCandidate(r.cand_id, 'skipped',
          `deterministic candle: same-platform sibling-event refusal — attaching would fuse ≥2 distinct `
          + `same-platform candle events onto outcome "${outcomeId}" (a platform never lists the same candle twice)`);
        stats.skipped++;
        continue;
      }
    }

    const persistResult = await persistMatch({
      candidateId: r.cand_id,
      platformEventIds: [r.a_id, r.b_id],
      matchConfidence: 1.0,
      legs: [leg(r.a_plat, r.a_market), leg(r.b_plat, r.b_market)],
      existingSemanticEventId: existing,
      semanticEvent: existing ? undefined : {
        canonical_event: `${wa.asset} Up or Down ${wa.durationMin}m @ ${(r.a_open ?? '').slice(0, 16)}`,
        canonical_subject: wa.asset,
        grouping_kind: 'categorical_exclusive',
        participants: [],
        deadline_window: null,
        confidence: 1.0,
        llm_model: 'deterministic-candle',
        match_reasoning: `deterministic candle match: ${wa.asset} ${wa.durationMin}m, same open`,
      },
    });

    if (persistResult.refused) { stats.skipped++; continue; }

    if (existing) stats.expanded++; else stats.matched++;
  }

  log.info(
    `Stage 3b-pre (deterministic candles): matched=${stats.matched} expanded=${stats.expanded} ` +
    `skipped=${stats.skipped} deferred→LLM=${stats.deferred}`,
  );
  return stats;
}
