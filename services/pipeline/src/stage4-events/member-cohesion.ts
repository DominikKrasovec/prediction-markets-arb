/**
 * Member-agreement invariant at question mint (the last-line belt): re-checks
 * that every member market fused onto one outcome-node actually agrees
 * (platform structure, shaped fields, temporal, title-only signals), since
 * the Stage-3b LLM leg-mapping attaches members with no deterministic check.
 * NULL-tolerant: a field check refuses only when both sides are non-NULL and
 * differ, so a refusal only forgoes an assertion, never adds a false one.
 */
import { parseCandleWindow } from '../stage3-events/candle-window.js';
import { numericRegionConflict } from '../stage3-events/numeric-region.js';
import { precisionRank, grainKeyAt, exactTimestampKey as exactTimestamp } from '../util/date-grain.js';
import {
  FIXTURE_START_KINDS,
  fixtureStartInstantMs,
  fixtureStartInstantsDiverge,
} from '../util/fixture-instant.js';
import { memberOutcomeGrain } from '../util/outcome-grain.js';
import { foldTextKey } from '../util/sql-fragments.js';
import { extractPredicateGrainFromText } from '../discriminators/specs/predicate-grain.js';
import { isHalfScope } from './equivalence-edge.js';
import { parseGameOrdinal } from '../discriminators/specs/game-ordinal.js';

export interface MemberFacts {
  market_id: number;
  platform: string;
  title: string | null;
  platform_event_id: string | null;
  end_date?: string | null;
  event_ticker?: string | null;
  yes_sub_title?: string | null;
  event_kind: string | null;
  condition_metric?: string | null;
  condition_direction: string | null;
  value_primary: number | string | null;
  value_secondary: number | string | null;
  value_unit: string | null;
  condition_date: string | null;
  condition_date_precision?: string | null; // NULL treated as day precision
  condition_shape?: string | null;
  strike_type?: string | null;
  metric_scope?: string | null;
}

export type CohesionVerdict = { ok: true } | { ok: false; reason: string };

const fold = foldTextKey;

// Parses the title only (never value_primary), so a representational fold
// ("3+ goals" vs "over 2.5") never manufactures a false conflict.
const MEMBER_RUNG_RX = /(?:^|[^a-z])(over|under|above|below)[_\s]?(\d+(?:\.\d+)?)/i;
function titleRungLine(title: string | null | undefined): { dir: 'above' | 'below'; value: number } | null {
  if (!title) return null;
  const m = title.match(MEMBER_RUNG_RX);
  if (!m) return null;
  const v = Number(m[2]);
  if (!Number.isFinite(v)) return null;
  const d = m[1].toLowerCase();
  return { dir: d === 'over' || d === 'above' ? 'above' : 'below', value: v };
}

function candleWindowMin(f: MemberFacts): number | undefined {
  if (f.condition_date == null || f.end_date == null) return undefined;
  const open = Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(f.condition_date.trim())
    ? f.condition_date.trim() : f.condition_date.trim() + 'Z');
  const close = Date.parse(f.end_date);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return undefined;
  return (close - open) / 60_000;
}

// Pairwise agreement between two would-be members of one outcome-node.
// Returns the refusal reason, or null when the pair coheres (or is unprovable).
export function memberPairConflict(a: MemberFacts, b: MemberFacts): string | null {
  if (
    a.platform === 'kalshi' && b.platform === 'kalshi' &&
    a.event_ticker != null && b.event_ticker != null && a.event_ticker === b.event_ticker &&
    a.yes_sub_title != null && b.yes_sub_title != null &&
    fold(a.yes_sub_title) !== fold(b.yes_sub_title)
  ) {
    return `kalshi siblings: event_ticker '${a.event_ticker}' with yes_sub_title '${a.yes_sub_title}' vs '${b.yes_sub_title}'`;
  }
  if (
    a.platform === b.platform &&
    a.platform_event_id != null && b.platform_event_id != null &&
    a.platform_event_id === b.platform_event_id &&
    a.title != null && b.title != null &&
    fold(a.title) !== fold(b.title)
  ) {
    return `same-platform_event siblings: pe '${a.platform_event_id}' with differing titles '${a.title}' vs '${b.title}'`;
  }

  if (a.event_kind != null && b.event_kind != null && a.event_kind !== b.event_kind) {
    return `event_kind '${a.event_kind}' vs '${b.event_kind}'`;
  }
  const ga = memberOutcomeGrain(a.title, a.event_kind);
  const gb = memberOutcomeGrain(b.title, b.event_kind);
  if (ga !== null && gb !== null && ga !== gb) {
    return `outcome grain '${ga}' vs '${gb}'`;
  }
  const numericConflict = numericRegionConflict(a, b);
  if (numericConflict !== null) return numericConflict;

  const isCandle = a.event_kind === 'candle_direction' || b.event_kind === 'candle_direction';
  if (a.condition_date != null && b.condition_date != null) {
    if (isCandle) {
      if (exactTimestamp(a.condition_date) !== exactTimestamp(b.condition_date)) {
        return `candle open mismatch: condition_date '${a.condition_date}' vs '${b.condition_date}'`;
      }
    } else {
      // Compared at the coarser of the two stamped precisions — a year-padded
      // placeholder date must not day-grain-refuse a true duplicate.
      const rank = Math.max(precisionRank(a.condition_date_precision), precisionRank(b.condition_date_precision));
      if (grainKeyAt(a.condition_date, rank) !== grainKeyAt(b.condition_date, rank)) {
        return `condition_date day '${a.condition_date}' vs '${b.condition_date}'`;
      }
      const kindInScope = (k: string | null) => k != null && FIXTURE_START_KINDS.has(k);
      if (kindInScope(a.event_kind) || kindInScope(b.event_kind)) {
        if (fixtureStartInstantsDiverge(fixtureStartInstantMs(a), fixtureStartInstantMs(b))) {
          return `fixture start instants diverge: '${a.condition_date}' vs '${b.condition_date}' are different games (>= tolerance apart)`;
        }
      }
    }
  }
  if (isCandle && a.title != null && b.title != null) {
    const wa = parseCandleWindow(a.title, candleWindowMin(a));
    const wb = parseCandleWindow(b.title, candleWindowMin(b));
    if (wa && wb && !wa.ambiguous && !wb.ambiguous && wa.durationMin !== wb.durationMin) {
      return `candle duration ${wa.durationMin}m vs ${wb.durationMin}m`;
    }
  }

  {
    const la = titleRungLine(a.title);
    const lb = titleRungLine(b.title);
    if (la && lb && (la.dir !== lb.dir || la.value !== lb.value)) {
      return `rung line ${la.dir} ${la.value} vs ${lb.dir} ${lb.value} (title)`;
    }
  }

  {
    const ga = extractPredicateGrainFromText(a.title);
    const gb = extractPredicateGrainFromText(b.title);
    if (ga != null && gb != null && ga !== gb) {
      return `predicate grain '${ga}' vs '${gb}' (title)`;
    }
  }

  // isHalfScope is shared with the equivalence-edge HT-FT fold; keep in sync.
  if (isHalfScope(a.metric_scope, a.title) !== isHalfScope(b.metric_scope, b.title)) {
    return `half/full-time scope mismatch: '${a.title}' vs '${b.title}'`;
  }

  {
    const oa = parseGameOrdinal(a.title);
    const ob = parseGameOrdinal(b.title);
    if (oa != null && ob != null && oa !== ob) {
      return `game_ordinal ${oa} vs ${ob} (title)`;
    }
  }
  return null;
}

// May `candidate` join a node already holding `existing` members? Refuses on
// the first conflicting accepted member.
export function memberCohesion(
  existing: ReadonlyArray<MemberFacts>,
  candidate: MemberFacts,
): CohesionVerdict {
  for (const e of existing) {
    const conflict = memberPairConflict(e, candidate);
    if (conflict !== null) {
      return { ok: false, reason: `vs member ${e.market_id}: ${conflict}` };
    }
  }
  return { ok: true };
}

export interface RefusedMember {
  market_id: number;
  node_key: string;
  reason: string;
}

// Groups rows by node_key, anchors on the lowest market_id (deterministic),
// then admits each further candidate only if it coheres with EVERY
// already-accepted member (not just the anchor) — returns the refused set.
export function partitionCohesiveMembers(
  rows: ReadonlyArray<MemberFacts & { node_key: string }>,
): { refused: RefusedMember[] } {
  const byNode = new Map<string, (MemberFacts & { node_key: string })[]>();
  for (const r of rows) {
    const g = byNode.get(r.node_key);
    if (g) g.push(r);
    else byNode.set(r.node_key, [r]);
  }
  const refused: RefusedMember[] = [];
  for (const [nodeKey, members] of byNode) {
    if (members.length < 2) continue;
    const ordered = members.slice().sort((x, y) => x.market_id - y.market_id);
    const accepted: MemberFacts[] = [ordered[0]];
    for (let i = 1; i < ordered.length; i++) {
      const verdict = memberCohesion(accepted, ordered[i]);
      if (verdict.ok) accepted.push(ordered[i]);
      else refused.push({ market_id: ordered[i].market_id, node_key: nodeKey, reason: verdict.reason });
    }
  }
  return { refused };
}
