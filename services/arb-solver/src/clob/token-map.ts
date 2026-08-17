import { createLogger } from '@arb/logger';
import type { MarketSubscription } from './price-cache.js';

const log = createLogger('clob:token-map');

// Only Polymarket subscriptions are expanded into per-token YES/NO pairs: it alone has two
// independent CLOB books per market. Kalshi/Predict/Limitless price NO synthetically instead.

/** `CLOB_BOOK_LADDER=1` prices each leg across one LP variable per real book level (tranche)
 *  instead of a single top-of-book variable; default off reproduces today's behavior exactly. */
export function bookLadderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLOB_BOOK_LADDER === '1';
}

const DEFAULT_MAX_LADDER_LEVELS = 50;
export function maxLadderLevels(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.CLOB_MAX_LADDER_LEVELS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LADDER_LEVELS;
}

// A crossed Polymarket YES book (bestBid >= bestAsk, both sides real) is a corrupt
// reconstruction, not a real book — pricing off it manufactures a phantom NO-mirror arb.
export function rejectCrossedBookEnabled(): boolean {
  return true;
}

// A two-sided book that's implausibly wide or dust-only (see maxBookWidth/dustBand) is a
// placeholder/frozen-stale book; price-cache.ts drops its synthetic-NO leg rather than price off it.

const DEFAULT_MAX_BOOK_WIDTH = 0.5;
export function maxBookWidth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseFloat(env.CLOB_MAX_BOOK_WIDTH ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BOOK_WIDTH;
}

const DEFAULT_DUST_BAND = 0.02;
export function dustBand(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseFloat(env.CLOB_DUST_BAND ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DUST_BAND;
}

/** A verified (YES token, NO token) pair for one Polymarket condition_id. */
export interface TokenOutcomePair {
  yesTokenId: string;
  noTokenId: string;
  outcomes: [string, string];
}

// 'inverted-order': outcomes[0] is the NEGATIVE side, which would fabricate a cheap NO.
export type MappingFailure =
  | 'bad-token-array'
  | 'empty-token'
  | 'duplicate-tokens'
  | 'bad-outcomes-array'
  | 'inverted-order'
  | 'unverifiable-labels';

export type MappingVerdict =
  | { ok: true; pair: TokenOutcomePair }
  | { ok: false; reason: MappingFailure; detail: string };

// outcomes[0] must be the side the pipeline's question treats as YES. Anything unverifiable
// from labels alone (e.g. team-vs-team) keeps the one-sided subscription instead of guessing.
const AFFIRMATIVE_FIRST_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['yes', 'no'],
  ['up', 'down'],
  ['over', 'under'],
  ['odd', 'even'],
];

/** "Over 2.5" / "Under 2.5" → threshold strings, or null when not that shape. */
function overUnderSuffix(label: string, prefix: 'over' | 'under'): string | null {
  const p = `${prefix} `;
  return label.startsWith(p) ? label.slice(p.length).trim() : null;
}

/** Pure. Never guesses on ambiguity: an unproven mapping is rejected (caller falls back to the
 *  synthetic NO price), since a wrong token↔outcome assignment fabricates a cheap NO. */
export function verifyTokenOutcomeMapping(
  clobTokenIds: unknown,
  outcomes: unknown,
): MappingVerdict {
  if (!Array.isArray(clobTokenIds) || clobTokenIds.length !== 2) {
    const got = Array.isArray(clobTokenIds) ? `length ${clobTokenIds.length}` : typeof clobTokenIds;
    return { ok: false, reason: 'bad-token-array', detail: `clobTokenIds not a 2-element array (${got})` };
  }
  const t0 = typeof clobTokenIds[0] === 'string' ? clobTokenIds[0].trim() : '';
  const t1 = typeof clobTokenIds[1] === 'string' ? clobTokenIds[1].trim() : '';
  if (!t0 || !t1) {
    return { ok: false, reason: 'empty-token', detail: 'empty or non-string token id' };
  }
  if (t0 === t1) {
    return { ok: false, reason: 'duplicate-tokens', detail: `both slots carry token ${t0}` };
  }
  if (
    !Array.isArray(outcomes) || outcomes.length !== 2 ||
    typeof outcomes[0] !== 'string' || typeof outcomes[1] !== 'string'
  ) {
    return { ok: false, reason: 'bad-outcomes-array', detail: 'outcomes not a 2-element string array' };
  }
  const raw: [string, string] = [outcomes[0], outcomes[1]];
  const o0 = raw[0].trim().toLowerCase();
  const o1 = raw[1].trim().toLowerCase();

  for (const [aff, neg] of AFFIRMATIVE_FIRST_PAIRS) {
    if (o0 === aff && o1 === neg) {
      return { ok: true, pair: { yesTokenId: t0, noTokenId: t1, outcomes: raw } };
    }
    if (o0 === neg && o1 === aff) {
      return {
        ok: false, reason: 'inverted-order',
        detail: `outcomes[0]="${raw[0]}" is the negative side of [${aff}/${neg}]`,
      };
    }
  }

  const over0 = overUnderSuffix(o0, 'over');
  const under1 = overUnderSuffix(o1, 'under');
  if (over0 !== null && under1 !== null && over0 === under1) {
    return { ok: true, pair: { yesTokenId: t0, noTokenId: t1, outcomes: raw } };
  }
  const under0 = overUnderSuffix(o0, 'under');
  const over1 = overUnderSuffix(o1, 'over');
  if (under0 !== null && over1 !== null && under0 === over1) {
    return {
      ok: false, reason: 'inverted-order',
      detail: `outcomes[0]="${raw[0]}" is the Under side`,
    };
  }

  return {
    ok: false, reason: 'unverifiable-labels',
    detail: `["${raw[0]}","${raw[1]}"] does not prove which side is the question's YES`,
  };
}

export type PolymarketTokenMapLoader = (
  conditionIds: string[],
) => Promise<Map<string, TokenOutcomePair>>;

// `@arb/db` is imported lazily so importing this module on a DB-less box stays side-effect free.
// A mapping that fails verification is omitted, not defaulted, keeping the one-sided subscription.
export const loadVerifiedPolymarketTokenMap: PolymarketTokenMapLoader = async (conditionIds) => {
  const out = new Map<string, TokenOutcomePair>();
  if (conditionIds.length === 0) return out;

  const { query } = await import('@arb/db');
  const rows = await query<{ condition_id: string; clob_token_ids: unknown; outcomes: unknown }>(
    `SELECT condition_id,
            raw->'clobTokenIds' AS clob_token_ids,
            raw->'outcomes'     AS outcomes
       FROM polymarket_markets
      WHERE condition_id = ANY($1::text[])`,
    [conditionIds],
  );

  const byId = new Map(rows.map((r) => [r.condition_id, r]));
  const failures = new Map<MappingFailure | 'no-row', number>();
  for (const cid of conditionIds) {
    const row = byId.get(cid);
    if (!row) {
      failures.set('no-row', (failures.get('no-row') ?? 0) + 1);
      continue;
    }
    const verdict = verifyTokenOutcomeMapping(row.clob_token_ids, row.outcomes);
    if (verdict.ok) {
      out.set(cid, verdict.pair);
    } else {
      failures.set(verdict.reason, (failures.get(verdict.reason) ?? 0) + 1);
      // Inverted order fabricates a cheap NO; surface individually, not just in the bucket tally.
      if (verdict.reason === 'inverted-order') {
        log.warn(`token mapping INVERTED for ${cid}: ${verdict.detail} — falling back to synthetic NO`);
      }
    }
  }
  if (failures.size > 0) {
    const summary = [...failures.entries()].map(([k, n]) => `${k}=${n}`).join(' ');
    log.info(
      `token-map verification: ${out.size}/${conditionIds.length} verified; ` +
      `fallback-to-synthetic buckets: ${summary}`,
    );
  }
  return out;
};

// Pure. Expands a condition_id-keyed Polymarket sub with a verified mapping into a
// (yesTokenId,'yes') + (noTokenId,'no') pair; everything else passes through unchanged.
export function expandTwoSidedSubscriptions(
  subs: MarketSubscription[],
  tokenMap: Map<string, TokenOutcomePair>,
): MarketSubscription[] {
  return subs.flatMap((s) => {
    if (s.platform !== 'polymarket' || s.outcome !== undefined) return [s];
    const pair = tokenMap.get(s.platformId);
    if (!pair) return [s];
    return [
      { ...s, platformId: pair.yesTokenId, outcome: 'yes' as const },
      { ...s, platformId: pair.noTokenId, outcome: 'no' as const },
    ];
  });
}
