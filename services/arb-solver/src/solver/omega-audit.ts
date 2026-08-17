import type { Cluster, WorldState, QuestionNode } from '../graph/types.js';
import type { PriceCache } from '../clob/price-cache.js';
import { sideUsability } from '../clob/price-cache.js';
import { enumerateStates, computePinnedQuestions } from './state-enumerator.js';
import { edgeIsHard, marketToQuestion, interpretCluster, constraintsToFacets } from './omega-constraints.js';
import { tryGetLoadedHiGHS } from './facet-lp.js';
import type { FacetConstraint } from './types.js';

/**
 * Ω-liveness audit: the runtime facts that make a fired portfolio's guarantee
 * trustworthy (dead books, liveness-relaxed worst-case recheck, closure).
 * Pure + read-only on the cluster; every relaxation only loosens the polytope,
 * so the recheck can refuse but never admit a basket the full Ω rejected.
 */

export interface AuditPosition {
  marketId: number;
  side: 'YES' | 'NO';
  shares: number;
}

export type RelaxedRecheck = 'pass' | 'fail' | 'overflow' | 'skipped-no-dropped-constraints';

// Generous vs the main solve cap so large fields compute exactly instead of overflow-refusing.
const RELAXED_MAX_STATES = 1 << 20;

export interface OmegaAudit {
  /** Closure question count (traded questions + partition siblings + hard-edge neighbours). */
  closureQuestionCount: number;
  /** market members across all closure questions. */
  closureBookCount: number;
  /** Dead books among the Ω-defining (closure) books. */
  deadBookCount: number;
  /** Unquoted questions in the closure. */
  unquotedClosureQuestionCount: number;
  /** quotedFraction over the closure (telemetry + grade signal, never a refusal). */
  quotedFraction: number;
  /** Liveness-relaxed worst-case recheck. */
  relaxedRecheck: RelaxedRecheck;
  /** The basket holds positions on markets of both members of a duplicate-suspect pair. */
  duplicateSuspectHeld: boolean;
  /** Pinned questions (empty outside degenerate clusters by construction). */
  pinnedQuestions: number[];
  /** A dead closure sibling shares an outcome set or hard edge with a traded question. */
  distance1UnquotedSibling: boolean;
  /** Sum of usable best YES bids across a hard-mutex clique containing a traded question; null if none found. */
  mutexPriceContradictionSigma: number | null;
  /** True when a held market side's ask is implausibly cheap vs. the live opposite-side bid. */
  staleComplementSideHeld: boolean;
  /** Worst bid(a)-ask(c) gap across contradicted strict_implication edges touching a traded question; null if none. */
  implicationPriceContradictionGap: number | null;
  /** True iff certified against the facet relaxation R ⊇ Ω rather than exact enumeration; caps grade at `caution`. */
  relaxedOmega: boolean;
  /** Exact world states this basket was certified against; 0 means the profit comes purely from the relaxed-facet LP. */
  stateCount: number;
  /** Cost of a cross-venue complement group under {@link SUM_OF_ASKS_FLOOR}; null if none found. */
  sumOfAsksBelowFloor: number | null;
  /** True iff the offending complement group touches a `candle_direction` question. */
  sumOfAsksCandleMember: boolean;
}

export function unquotedQuestions(
  cluster: Cluster,
  priceCache: PriceCache,
  now: number,
): Set<number> {
  const out = new Set<number>();
  for (const [qid, q] of cluster.questions) {
    if (!isQuestionQuoted(q, priceCache, now)) out.add(qid);
  }
  return out;
}

function isQuestionQuoted(q: QuestionNode, priceCache: PriceCache, now: number): boolean {
  for (const [, m] of q.markets) {
    const yes = priceCache.get(m.marketId, now);
    const no = priceCache.getNo(m.marketId, now);
    const u = sideUsability(yes, no);
    if (u.yes || u.no) return true;
  }
  return false;
}

// Closed under outcome-set siblings and hard-edge neighbours, iterated to fixpoint.
export function closure(cluster: Cluster, tradedQuestionIds: Iterable<number>): Set<number> {
  const inClosure = new Set<number>(tradedQuestionIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const os of cluster.outcomeSets) {
      if (os.slotQuestionIds.some((q) => inClosure.has(q))) {
        for (const q of os.slotQuestionIds) {
          if (cluster.questions.has(q) && !inClosure.has(q)) {
            inClosure.add(q);
            changed = true;
          }
        }
      }
    }
    for (const e of cluster.edges) {
      if (!edgeIsHard(e)) continue;
      if (inClosure.has(e.antecedentQuestionId) && !inClosure.has(e.consequentQuestionId) && cluster.questions.has(e.consequentQuestionId)) {
        inClosure.add(e.consequentQuestionId);
        changed = true;
      }
      if (inClosure.has(e.consequentQuestionId) && !inClosure.has(e.antecedentQuestionId) && cluster.questions.has(e.antecedentQuestionId)) {
        inClosure.add(e.antecedentQuestionId);
        changed = true;
      }
    }
  }
  return inClosure;
}

function statePayout(
  positions: AuditPosition[],
  marketToQid: Map<number, number>,
  state: WorldState,
): number {
  let payout = 0;
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid === undefined) continue;
    const resolvesYes = state.get(qid) ?? false;
    if ((p.side === 'YES' && resolvesYes) || (p.side === 'NO' && !resolvesYes)) payout += p.shares;
  }
  return payout;
}

export interface RelaxedResult {
  verdict: RelaxedRecheck;
  relaxedWorstUsd: number | null;
}

// Drops every outcome set / hard edge with a slot/endpoint in `unquoted` (questions never dropped), re-enumerates,
// and recomputes worst payout. 'overflow' on empty enumeration of a non-empty cluster resolves toward refusal.
export function relaxedRecheck(
  cluster: Cluster,
  positions: AuditPosition[],
  totalCostUsd: number,
  minProfitUsd: number,
  unquoted: Set<number>,
  opts: { maxStates: number; clusterSizeCap: number },
): RelaxedResult {
  const marketToQid = marketToQuestion(cluster);
  const tradedQids = new Set<number>();
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid !== undefined) tradedQids.add(qid);
  }

  // Safe: the relaxed Ω only adds states vs. the full Ω, so relaxedWorst <= fullWorst.
  const touchedSets = cluster.outcomeSets.filter((os) => os.slotQuestionIds.some((q) => unquoted.has(q)));
  const droppedEdges = cluster.edges.filter(
    (e) => edgeIsHard(e) && (unquoted.has(e.antecedentQuestionId) || unquoted.has(e.consequentQuestionId)),
  );

  const dropTouchesTraded =
    touchedSets.some((os) => os.slotQuestionIds.some((q) => tradedQids.has(q))) ||
    droppedEdges.some((e) => tradedQids.has(e.antecedentQuestionId) || tradedQids.has(e.consequentQuestionId));
  if (!dropTouchesTraded) {
    return { verdict: 'skipped-no-dropped-constraints', relaxedWorstUsd: null };
  }

  const touchedIds = new Set(touchedSets.map((os) => os.setId));
  const relaxedSets = cluster.outcomeSets.flatMap((os): typeof os[] => {
    if (!touchedIds.has(os.setId)) return [os];
    // Drop a set entirely if fewer than 2 quoted slots remain.
    const liveSlots = os.slotQuestionIds.filter((q) => !unquoted.has(q));
    if (liveSlots.length < 2) return [];
    return [{ ...os, slotQuestionIds: liveSlots, isExhaustive: false }];
  });
  const keptEdges = cluster.edges.filter((e) => !droppedEdges.includes(e));
  const relaxed: Cluster = {
    ...cluster,
    outcomeSets: relaxedSets,
    edges: keptEdges,
    validStates: [],
  };
  const relaxedStates = enumerateStates(relaxed, { ...opts, maxStates: RELAXED_MAX_STATES });
  if (relaxedStates.length === 0) {
    return { verdict: 'overflow', relaxedWorstUsd: null };
  }

  let worst = Infinity;
  for (const s of relaxedStates) {
    const p = statePayout(positions, marketToQid, s);
    if (p < worst) worst = p;
  }
  const pass = worst >= totalCostUsd + minProfitUsd;
  return { verdict: pass ? 'pass' : 'fail', relaxedWorstUsd: worst };
}

// Facet-LP analogue of {@link relaxedRecheck} for an over-capped cluster with no enumerated `validStates`:
// minimizes the basket's affine payoff over the relaxed facet region. One-sided sound: R' ⊇ conv(Ω_relaxed),
// so the computed worst may fail a sound basket but can never pass an unsound one.
export function relaxedRecheckFacet(
  cluster: Cluster,
  positions: AuditPosition[],
  totalCostUsd: number,
  minProfitUsd: number,
  unquoted: Set<number>,
): RelaxedResult {
  const marketToQid = marketToQuestion(cluster);
  const tradedQids = new Set<number>();
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid !== undefined) tradedQids.add(qid);
  }

  const touchedSets = cluster.outcomeSets.filter((os) => os.slotQuestionIds.some((q) => unquoted.has(q)));
  const droppedEdges = cluster.edges.filter(
    (e) => edgeIsHard(e) && (unquoted.has(e.antecedentQuestionId) || unquoted.has(e.consequentQuestionId)),
  );

  const dropTouchesTraded =
    touchedSets.some((os) => os.slotQuestionIds.some((q) => tradedQids.has(q))) ||
    droppedEdges.some((e) => tradedQids.has(e.antecedentQuestionId) || tradedQids.has(e.consequentQuestionId));
  if (!dropTouchesTraded) {
    return { verdict: 'skipped-no-dropped-constraints', relaxedWorstUsd: null };
  }

  const touchedIds = new Set(touchedSets.map((os) => os.setId));
  const relaxedSets = cluster.outcomeSets.flatMap((os): typeof os[] => {
    if (!touchedIds.has(os.setId)) return [os];
    const liveSlots = os.slotQuestionIds.filter((q) => !unquoted.has(q));
    if (liveSlots.length < 2) return [];
    return [{ ...os, slotQuestionIds: liveSlots, isExhaustive: false }];
  });
  const keptEdges = cluster.edges.filter((e) => !droppedEdges.includes(e));
  const shadow: Cluster = { ...cluster, outcomeSets: relaxedSets, edges: keptEdges };
  // isUnquoted always false here: exhaustivity is already demoted on the touched sets; don't double-demote.
  const facets = constraintsToFacets(interpretCluster(shadow, { isUnquoted: () => false }));

  // C = Σ NO-leg shares, w_q = ΣYES_q − ΣNO_q.
  const w = new Map<number, number>();
  let C = 0;
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid === undefined) continue;
    if (p.side === 'YES') w.set(qid, (w.get(qid) ?? 0) + p.shares);
    else {
      w.set(qid, (w.get(qid) ?? 0) - p.shares);
      C += p.shares;
    }
  }

  const worst = minPayoutOverFacets(facets, [...cluster.questions.keys()], w, C);
  if (worst === null) return { verdict: 'overflow', relaxedWorstUsd: null };
  const pass = worst >= totalCostUsd + minProfitUsd;
  return { verdict: pass ? 'pass' : 'fail', relaxedWorstUsd: worst };
}

// Returns null (resolves to 'overflow') when HiGHS isn't loaded or the LP isn't Optimal.
// Sync via `tryGetLoadedHiGHS`: the audit runs inside a synchronous grade path.
function minPayoutOverFacets(
  facets: FacetConstraint[],
  questionIds: number[],
  w: Map<number, number>,
  C: number,
): number | null {
  const highs = tryGetLoadedHiGHS();
  if (!highs) return null;
  const qPos = new Map<number, number>();
  questionIds.forEach((q, i) => qPos.set(q, i));
  const objTerms: string[] = [];
  for (const [q, coef] of w) {
    const i = qPos.get(q);
    if (i === undefined || coef === 0) continue;
    objTerms.push(`${coef >= 0 ? '+' : ''}${coef} z${i}`);
  }
  const lines: string[] = ['Minimize', `  obj: ${objTerms.join(' ') || '0'}`, 'Subject To'];
  facets.forEach((f, fi) => {
    const terms = f.coeff
      .filter(([q]) => qPos.has(q))
      .map(([q, c]) => `${c >= 0 ? '+' : ''}${c} z${qPos.get(q)}`)
      .join(' ');
    if (terms.length === 0) return;
    lines.push(`  f${fi}: ${terms} ${f.kind === 'le' ? '<=' : '='} ${f.rhs}`);
  });
  lines.push('Bounds');
  questionIds.forEach((_, i) => lines.push(`  0 <= z${i} <= 1`));
  lines.push('End');
  const raw = highs.solve(lines.join('\n'));
  if (raw?.Status !== 'Optimal') return null;
  return C + (raw.ObjectiveValue ?? 0);
}

// A suspect pair (a,b) is probably the same real-world outcome minted as two mutex slots;
// blocks any basket holding a position on either member.
export function duplicateSuspectHeld(cluster: Cluster, positions: AuditPosition[]): boolean {
  const pairs = cluster.duplicateSuspectPairs;
  if (!pairs || pairs.length === 0) return false;
  const marketToQid = marketToQuestion(cluster);
  const heldQids = new Set<number>();
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid !== undefined) heldQids.add(qid);
  }
  return pairs.some(([a, b]) => heldQids.has(a) || heldQids.has(b));
}

// A true k-way mutex admits at most one YES, so a fair sum of YES prices is ≤1; a persistent
// sum far above 1 means the mutex is structurally false. Slack tolerates transient mispricing.
export const MUTEX_SIGMA_SLACK = 0.25;

export function mutexPriceContradictionSigma(
  cluster: Cluster,
  positions: AuditPosition[],
  priceCache: PriceCache,
  now: number,
): number | null {
  const adj = new Map<number, Set<number>>();
  for (const e of cluster.edges) {
    if (e.edgeType !== 'mutual_exclusion' || !edgeIsHard(e)) continue;
    if (e.antecedentQuestionId === e.consequentQuestionId) continue;
    let a = adj.get(e.antecedentQuestionId);
    if (!a) { a = new Set(); adj.set(e.antecedentQuestionId, a); }
    a.add(e.consequentQuestionId);
    let b = adj.get(e.consequentQuestionId);
    if (!b) { b = new Set(); adj.set(e.consequentQuestionId, b); }
    b.add(e.antecedentQuestionId);
  }
  if (adj.size === 0) return null;

  const yesBid = (qid: number): number => {
    const q = cluster.questions.get(qid);
    if (!q) return 0;
    let best = 0;
    for (const [, m] of q.markets) {
      const yes = priceCache.get(m.marketId, now);
      const no = priceCache.getNo(m.marketId, now);
      if (!sideUsability(yes, no).yes) continue;
      if (yes && yes.bestBid > best) best = yes.bestBid;
    }
    return best;
  };

  const marketToQid = marketToQuestion(cluster);
  const tradedQids = new Set<number>();
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid !== undefined) tradedQids.add(qid);
  }

  let worstSigma: number | null = null;
  for (const seed of tradedQids) {
    const neighbors = adj.get(seed);
    if (!neighbors || neighbors.size === 0) continue;
    const members = [seed];
    const candidates = [...neighbors].sort((a, b) => yesBid(b) - yesBid(a));
    for (const c of candidates) {
      const cAdj = adj.get(c);
      if (cAdj && members.every((m) => m === c || cAdj.has(m))) members.push(c);
    }
    if (members.length < 3) continue; // a 2-cycle is a box-arb candidate, not clique evidence
    let sigma = 0;
    let usableBids = 0;
    for (const m of members) {
      const b = yesBid(m);
      if (b > 0) { sigma += b; usableBids++; }
    }
    if (usableBids < 2) continue;
    if (sigma > 1 + MUTEX_SIGMA_SLACK && (worstSigma === null || sigma > worstSigma)) {
      worstSigma = sigma;
    }
  }
  return worstSigma;
}

// Minimum executable bid-over-ask gap that convicts a strict_implication.
export const IMPLICATION_CONTRADICTION_SLACK = 0.10;

export function implicationPriceContradictionGap(
  cluster: Cluster,
  positions: AuditPosition[],
  priceCache: PriceCache,
  now: number,
): number | null {
  const marketToQid = marketToQuestion(cluster);
  const tradedQids = new Set<number>();
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid !== undefined) tradedQids.add(qid);
  }
  if (tradedQids.size === 0) return null;

  const bidYes = (qid: number): number => {
    const q = cluster.questions.get(qid);
    if (!q) return 0;
    let best = 0;
    for (const [, m] of q.markets) {
      const yes = priceCache.get(m.marketId, now);
      const no = priceCache.getNo(m.marketId, now);
      if (!sideUsability(yes, no).yes) continue;
      if (yes && yes.bestBid > best) best = yes.bestBid;
    }
    return best;
  };
  const askYes = (qid: number): number | null => {
    const q = cluster.questions.get(qid);
    if (!q) return null;
    let best: number | null = null;
    for (const [, m] of q.markets) {
      const yes = priceCache.get(m.marketId, now);
      const no = priceCache.getNo(m.marketId, now);
      if (!sideUsability(yes, no).yes) continue;
      if (yes && yes.bestAsk > 0 && (best === null || yes.bestAsk < best)) best = yes.bestAsk;
    }
    return best;
  };

  let worst: number | null = null;
  for (const e of cluster.edges) {
    if (e.edgeType !== 'strict_implication' || !edgeIsHard(e)) continue;
    if (e.antecedentQuestionId === e.consequentQuestionId) continue;
    if (!tradedQids.has(e.antecedentQuestionId) && !tradedQids.has(e.consequentQuestionId)) continue;
    const bidA = bidYes(e.antecedentQuestionId);
    if (bidA <= 0) continue;
    const askC = askYes(e.consequentQuestionId);
    if (askC === null) continue;
    const gap = bidA - askC;
    if (gap > IMPLICATION_CONTRADICTION_SLACK && (worst === null || gap > worst)) worst = gap;
  }
  return worst;
}

// Cross-venue sum-of-asks divergence veto. A complement group's payoff is exactly $1 in every
// world of Ω, so a sum of asks far below 1 means two venues are quoting different events.
export const SUM_OF_ASKS_FLOOR = 0.60;

function bestUsableYesAsk(
  q: QuestionNode | undefined,
  priceCache: PriceCache,
  now: number,
): { ask: number; platform: string; candle: boolean } | null {
  if (!q) return null;
  let best: { ask: number; platform: string; candle: boolean } | null = null;
  for (const [, m] of q.markets) {
    const yes = priceCache.get(m.marketId, now);
    const no = priceCache.getNo(m.marketId, now);
    if (!sideUsability(yes, no).yes) continue;
    if (!yes || !(yes.bestAsk > 0)) continue;
    if (best === null || yes.bestAsk < best.ask) {
      best = { ask: yes.bestAsk, platform: m.platform, candle: m.eventKind === 'candle_direction' };
    }
  }
  return best;
}

function bestUsableNoAsk(
  q: QuestionNode | undefined,
  priceCache: PriceCache,
  now: number,
): { ask: number; platform: string; candle: boolean } | null {
  if (!q) return null;
  let best: { ask: number; platform: string; candle: boolean } | null = null;
  for (const [, m] of q.markets) {
    const yes = priceCache.get(m.marketId, now);
    const no = priceCache.getNo(m.marketId, now);
    if (!sideUsability(yes, no).no) continue;
    if (!no || !(no.bestAsk > 0)) continue;
    if (best === null || no.bestAsk < best.ask) {
      best = { ask: no.bestAsk, platform: m.platform, candle: m.eventKind === 'candle_direction' };
    }
  }
  return best;
}

function isCrossVenueQuestion(q: QuestionNode | undefined): boolean {
  if (!q) return false;
  const seen = new Set<string>();
  for (const [, m] of q.markets) {
    seen.add(m.platform);
    if (seen.size >= 2) return true;
  }
  return false;
}

function venuesOf(q: QuestionNode | undefined): Set<string> {
  const out = new Set<string>();
  if (q) for (const [, m] of q.markets) out.add(m.platform);
  return out;
}

// Checks three complement-group shapes: (a) same-question cross-venue YES/NO, (b) equivalence-edge
// YES(a)/NO(b), (c) exhaustive one-hot slot sum — each pays exactly $1 in every world of Ω.
export function sumOfAsksDivergence(
  cluster: Cluster,
  positions: AuditPosition[],
  priceCache: PriceCache,
  now: number,
): { sigma: number; candleMember: boolean } | null {
  const marketToQid = marketToQuestion(cluster);
  const tradedQids = new Set<number>();
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid !== undefined) tradedQids.add(qid);
  }
  if (tradedQids.size === 0) return null;

  let worst: { sigma: number; candleMember: boolean } | null = null;
  const consider = (sigma: number, candle: boolean): void => {
    if (sigma >= SUM_OF_ASKS_FLOOR) return;
    if (worst === null || sigma < worst.sigma) worst = { sigma, candleMember: candle };
  };

  // (a) same-question cross-venue merge: YES + NO must be liftable on DIFFERENT venues.
  for (const qid of tradedQids) {
    const q = cluster.questions.get(qid);
    if (!isCrossVenueQuestion(q)) continue;
    const yes = bestUsableYesAsk(q, priceCache, now);
    const no = bestUsableNoAsk(q, priceCache, now);
    if (!yes || !no || yes.platform === no.platform) continue;
    consider(yes.ask + no.ask, yes.candle || no.candle);
  }

  // (b) equivalence-merged pair across venues: YES(a) + NO(b) (and the mirror).
  for (const e of cluster.edges) {
    if (e.edgeType !== 'equivalence' || !edgeIsHard(e)) continue;
    if (e.antecedentQuestionId === e.consequentQuestionId) continue;
    if (!tradedQids.has(e.antecedentQuestionId) && !tradedQids.has(e.consequentQuestionId)) continue;
    const qa = cluster.questions.get(e.antecedentQuestionId);
    const qb = cluster.questions.get(e.consequentQuestionId);
    if (!qa || !qb) continue;
    const va = venuesOf(qa);
    const crossVenue = [...venuesOf(qb)].some((v) => !va.has(v)) || va.size >= 2;
    if (!crossVenue) continue;
    const yesA = bestUsableYesAsk(qa, priceCache, now);
    const noB = bestUsableNoAsk(qb, priceCache, now);
    if (yesA && noB) consider(yesA.ask + noB.ask, yesA.candle || noB.candle);
    const yesB = bestUsableYesAsk(qb, priceCache, now);
    const noA = bestUsableNoAsk(qa, priceCache, now);
    if (yesB && noA) consider(yesB.ask + noA.ask, yesB.candle || noA.candle);
  }

  // (c) exhaustive one-hot spanning ≥2 venues: Σ of every slot's best usable YES ask.
  for (const os of cluster.outcomeSets) {
    if (os.setType !== 'categorical' || os.isExhaustive !== true) continue;
    const slots = os.slotQuestionIds.filter((s) => cluster.questions.has(s));
    if (slots.length < 2 || slots.length !== os.slotQuestionIds.length) continue; // a lost slot is no partition
    if (!slots.some((s) => tradedQids.has(s))) continue;
    const venues = new Set<string>();
    let sigma = 0;
    let candle = false;
    let allQuoted = true;
    for (const s of slots) {
      const yes = bestUsableYesAsk(cluster.questions.get(s), priceCache, now);
      if (!yes) { allQuoted = false; break; }
      sigma += yes.ask;
      candle = candle || yes.candle;
      venues.add(yes.platform);
    }
    if (!allQuoted || venues.size < 2) continue;
    consider(sigma, candle);
  }

  return worst;
}

export const COMPLEMENT_SLACK = 0.10;

export function staleComplementSideHeld(
  cluster: Cluster,
  positions: AuditPosition[],
  priceCache: PriceCache,
  now: number,
): boolean {
  const marketToQid = marketToQuestion(cluster);
  for (const p of positions) {
    if (marketToQid.get(p.marketId) === undefined) continue;
    const yes = priceCache.get(p.marketId, now);
    const no = priceCache.getNo(p.marketId, now);
    const u = sideUsability(yes, no);
    if (p.side === 'NO') {
      // A synthetic NO (derived from the YES bid) is coherent by construction; only a real NO book is checked.
      if (u.noFromBook && u.yes && no && yes && yes.bestBid > 0 && no.bestAsk > 0 &&
          no.bestAsk < (1 - yes.bestBid) - COMPLEMENT_SLACK) {
        return true;
      }
    } else {
      if (u.yes && u.noFromBook && yes && no && no.bestBid > 0 && yes.bestAsk > 0 &&
          yes.bestAsk < (1 - no.bestBid) - COMPLEMENT_SLACK) {
        return true;
      }
    }
  }
  return false;
}

// Returns violations of the fired-portfolio invariants (empty: clean); a non-empty result
// must force the cluster's output to `blocked` at the call site. `grade` gates (e) only.
export function checkFiredPortfolioTripwires(
  cluster: Cluster,
  variables: ReadonlyArray<{ marketId: number; side: 'YES' | 'NO' }>,
  audit: OmegaAudit | undefined,
  priceCache: PriceCache,
  now: number,
  grade?: 'clean' | 'caution' | 'risky' | 'blocked',
): string[] {
  const out: string[] = [];
  if (!audit) {
    out.push(`c${cluster.id}: (c) fired portfolio missing omegaAudit`);
  } else {
    if (audit.pinnedQuestions.length > 0) {
      out.push(`c${cluster.id}: (b) fired on pinned cluster [${audit.pinnedQuestions.join(',')}]`);
    }
    if (audit.relaxedRecheck !== 'pass' && audit.relaxedRecheck !== 'skipped-no-dropped-constraints') {
      out.push(`c${cluster.id}: (d) fired portfolio relaxedRecheck='${audit.relaxedRecheck}'`);
    }
    // (e) applyOmegaGrade should have demoted this to `risky` already.
    if (audit.stateCount === 0 && (grade === 'clean' || grade === 'caution')) {
      out.push(
        `c${cluster.id}: (e) fired portfolio graded '${grade}' with stateCount=0 ` +
        `(unverified: relaxed-LP objective, no state enumeration backs this profit)`,
      );
    }
  }
  for (const v of variables) {
    if (v.marketId === -1) continue; // guaranteed-payout slack G
    const u = sideUsability(priceCache.get(v.marketId, now), priceCache.getNo(v.marketId, now));
    const sideUsable = v.side === 'YES' ? u.yes : u.no;
    if (!sideUsable) {
      out.push(`c${cluster.id}: (a) LP var ${v.side} M${v.marketId} priced from a DEAD/unusable book`);
    }
  }
  return out;
}

export function computeOmegaAudit(
  cluster: Cluster,
  positions: AuditPosition[],
  totalCostUsd: number,
  minProfitUsd: number,
  priceCache: PriceCache,
  now: number,
  opts: { maxStates: number; clusterSizeCap: number },
): OmegaAudit {
  const marketToQid = marketToQuestion(cluster);
  const tradedQids = new Set<number>();
  for (const p of positions) {
    const qid = marketToQid.get(p.marketId);
    if (qid !== undefined) tradedQids.add(qid);
  }
  const closureQids = closure(cluster, tradedQids);
  const unquoted = unquotedQuestions(cluster, priceCache, now);

  let closureBookCount = 0;
  let deadBookCount = 0;
  for (const qid of closureQids) {
    const q = cluster.questions.get(qid);
    if (!q) continue;
    for (const [, m] of q.markets) {
      closureBookCount++;
      const yes = priceCache.get(m.marketId, now);
      const no = priceCache.getNo(m.marketId, now);
      const u = sideUsability(yes, no);
      if (!u.yes && !u.no) deadBookCount++;
    }
  }
  const closureUnquoted = [...closureQids].filter((q) => unquoted.has(q));
  const unquotedClosureQuestionCount = closureUnquoted.length;
  const quotedFraction =
    closureQids.size > 0 ? (closureQids.size - unquotedClosureQuestionCount) / closureQids.size : 1;

  // Distance-1: a dead closure sibling that shares a set or hard edge with a traded question.
  let distance1 = false;
  for (const deadQ of closureUnquoted) {
    if (tradedQids.has(deadQ)) continue;
    const sharesSet = cluster.outcomeSets.some(
      (os) => os.slotQuestionIds.includes(deadQ) && os.slotQuestionIds.some((q) => tradedQids.has(q)),
    );
    const sharesEdge = cluster.edges.some(
      (e) =>
        edgeIsHard(e) &&
        ((e.antecedentQuestionId === deadQ && tradedQids.has(e.consequentQuestionId)) ||
          (e.consequentQuestionId === deadQ && tradedQids.has(e.antecedentQuestionId))),
    );
    if (sharesSet || sharesEdge) {
      distance1 = true;
      break;
    }
  }

  const isRelaxedOmega = cluster.relaxed === true || cluster.validStates.length === 0;
  const relaxed = isRelaxedOmega
    ? relaxedRecheckFacet(cluster, positions, totalCostUsd, minProfitUsd, unquoted)
    : relaxedRecheck(cluster, positions, totalCostUsd, minProfitUsd, unquoted, opts);

  // Recompute the pin set fresh at fire time (not a cached echo), unioned with the load-time result.
  const freshPins = computePinnedQuestions(cluster);
  const loadPins = cluster.pinnedQuestions ?? [];
  const pinnedQuestions = [...new Set([...loadPins, ...freshPins])];

  const divergence = sumOfAsksDivergence(cluster, positions, priceCache, now);

  return {
    closureQuestionCount: closureQids.size,
    closureBookCount,
    deadBookCount,
    unquotedClosureQuestionCount,
    quotedFraction,
    relaxedRecheck: relaxed.verdict,
    duplicateSuspectHeld: duplicateSuspectHeld(cluster, positions),
    pinnedQuestions,
    distance1UnquotedSibling: distance1,
    mutexPriceContradictionSigma: mutexPriceContradictionSigma(cluster, positions, priceCache, now),
    staleComplementSideHeld: staleComplementSideHeld(cluster, positions, priceCache, now),
    implicationPriceContradictionGap: implicationPriceContradictionGap(cluster, positions, priceCache, now),
    relaxedOmega: isRelaxedOmega,
    stateCount: cluster.validStates.length,
    sumOfAsksBelowFloor: divergence?.sigma ?? null,
    sumOfAsksCandleMember: divergence?.candleMember ?? false,
  };
}
