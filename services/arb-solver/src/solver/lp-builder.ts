import type { Cluster } from '../graph/types.js';
import type { PriceCache, PriceSnapshot } from '../clob/price-cache.js';
import { sideUsability } from '../clob/price-cache.js';
import {
  bookLadderEnabled,
  maxLadderLevels,
} from '../clob/token-map.js';
import { feePerShare, defaultFeeModel, type FeeModel } from './fees.js';
import { marketToQuestion } from './omega-constraints.js';
import { NO_EXECUTION_GATE } from './types.js';
import type { LPProblem, LPVariable, ExecutionParams } from './types.js';

/** 'synthetic' = NO leg priced as `1 − bestBid(YES)`; exact on Kalshi, an approximation elsewhere. */
export type LegPriceSource = 'book' | 'synthetic';

/** Every variable `buildLP` emits is actually a `PricedLPVariable`. */
export interface PricedLPVariable extends LPVariable {
  priceSource: LegPriceSource;
}

/** Infers legacy semantics (YES = book, NO = synthetic) when priceSource is absent. */
export function legPriceSource(v: LPVariable): LegPriceSource {
  const src = (v as Partial<PricedLPVariable>).priceSource;
  if (src === 'book' || src === 'synthetic') return src;
  return v.side === 'YES' ? 'book' : 'synthetic';
}

/** A real book level (CLOB_BOOK_LADDER=1) priced and capped at its actual size. */
interface LegTranche {
  price: number;
  fee: number;
  size: number;
}

/** Levels at the sentinel ($2) ask or non-positive size are dropped; null ⟹ caller emits the single top-of-book variable. */
function yesTranches(
  snapshot: PriceSnapshot | undefined,
  model: FeeModel,
  enforceFees: boolean,
  cap: number,
): LegTranche[] | null {
  const levels = snapshot?.askLevels;
  if (!levels || levels.length === 0) return null;
  const out: LegTranche[] = [];
  for (const [price, size] of levels) {
    if (!Number.isFinite(price) || price <= 0 || price > 1 || !(size > 0)) continue;
    out.push({ price, fee: enforceFees ? feePerShare(model, price, 'buy') : 0, size });
    if (out.length >= cap) break;
  }
  return out.length > 0 ? out : null;
}

/** Synthetic tranches price each YES bid level as NO `1 − b`, fee as a SELL of YES at `b`. */
function noTranches(
  noFromBook: boolean,
  noSnap: PriceSnapshot | undefined,
  yesSnap: PriceSnapshot | undefined,
  model: FeeModel,
  enforceFees: boolean,
  cap: number,
): LegTranche[] | null {
  if (noFromBook) {
    const levels = noSnap?.askLevels;
    if (!levels || levels.length === 0) return null;
    const out: LegTranche[] = [];
    for (const [price, size] of levels) {
      if (!Number.isFinite(price) || price <= 0 || price > 1 || !(size > 0)) continue;
      out.push({ price, fee: enforceFees ? feePerShare(model, price, 'buy') : 0, size });
      if (out.length >= cap) break;
    }
    return out.length > 0 ? out : null;
  }
  const levels = yesSnap?.bidLevels;
  if (!levels || levels.length === 0) return null;
  const out: LegTranche[] = [];
  for (const [bid, size] of levels) {
    if (!Number.isFinite(bid) || bid <= 0 || bid >= 1 || !(size > 0)) continue;
    const noPrice = 1 - bid;
    out.push({ price: noPrice, fee: enforceFees ? feePerShare(model, bid, 'sell') : 0, size });
    if (out.length >= cap) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * Both the V-rep LP (`buildLP`) and the H-rep facet LP (`buildFacetLP`) consume
 * this identical leg set — factoring it out guarantees the two engines price a
 * basket byte-for-byte identically. `twoSidedBooks=false` is a test seam forcing
 * the synthetic NO path.
 */
export interface LegBuild {
  variables: PricedLPVariable[];
  objective: number[];
  numVars: number;
  guaranteedPayoutVarIndex?: number;
}

/** Returns null when no side of any market is usable (`varIndex === 0`). */
export function buildLegVariables(
  cluster: Cluster,
  priceCache: PriceCache,
  exec: ExecutionParams = NO_EXECUTION_GATE,
  twoSidedBooks: boolean = true,
  bookLadder: boolean = bookLadderEnabled(),
): LegBuild | null {
  const variables: PricedLPVariable[] = [];
  const objective: number[] = [];
  let varIndex = 0;
  const ladderCap = maxLadderLevels();
  // Profit-max (G) formulation only kicks in once a leg is split into >1 tranche.
  let anyTranched = false;

  for (const [, question] of cluster.questions) {
    for (const [, market] of question.markets) {
      const snapshot = priceCache.get(market.marketId);

      const noSnap = twoSidedBooks ? priceCache.getNo(market.marketId) : undefined;

      // sideUsability (price-cache.ts) is the single source of truth for buyability:
      // a dead book emits zero variables and no price is ever derived from a sentinel.
      const usab = sideUsability(snapshot, noSnap);
      const noFromBook = usab.noFromBook;
      const emitYes = usab.yes;
      const emitNo = usab.no;
      const askYes = emitYes ? snapshot!.bestAsk : 0;
      const askNo = !emitNo ? 0 : noFromBook ? noSnap!.bestAsk : 1 - snapshot!.bestBid;
      // null ⟹ uncapped (depth cap disabled).
      const yesDepth = exec.enforceDepthCap ? (snapshot?.askSize ?? 0) : null;
      const noDepth = exec.enforceDepthCap
        ? noFromBook
          ? noSnap!.askSize
          : (snapshot?.bidSize ?? 0)
        : null;
      const model = market.feeModel ?? defaultFeeModel(market.platform);
      const feeYes = exec.enforceFees ? feePerShare(model, askYes, 'buy') : 0;
      // Synthetic NO leg is a SELL of YES at bestBid(YES) = 1 − askNo.
      const feeNo = exec.enforceFees
        ? noFromBook
          ? feePerShare(model, askNo, 'buy')
          : feePerShare(model, 1 - askNo, 'sell')
        : 0;

      const yesLad = bookLadder
        ? yesTranches(snapshot, model, exec.enforceFees, ladderCap)
        : null;
      const noLad = bookLadder
        ? noTranches(noFromBook, noSnap, snapshot, model, exec.enforceFees, ladderCap)
        : null;

      if (!emitYes) {
      } else if (yesLad) {
        if (yesLad.length > 1) anyTranched = true;
        for (let li = 0; li < yesLad.length; li++) {
          const t = yesLad[li];
          variables.push({
            index: varIndex,
            marketId: market.marketId,
            platform: market.platform,
            side: 'YES',
            askPrice: t.price,
            feePerShare: t.fee,
            maxShares: t.size,
            priceSource: 'book',
            level: li,
          });
          objective.push(t.price + t.fee);
          varIndex++;
        }
      } else {
        variables.push({
          index: varIndex,
          marketId: market.marketId,
          platform: market.platform,
          side: 'YES',
          askPrice: askYes,
          feePerShare: feeYes,
          maxShares: yesDepth,
          priceSource: 'book',
        });
        objective.push(askYes + feeYes);
        varIndex++;
      }

      const noSource: LegPriceSource = noFromBook ? 'book' : 'synthetic';
      if (!emitNo) {
        // no variable emitted
      } else if (noLad) {
        if (noLad.length > 1) anyTranched = true;
        for (let li = 0; li < noLad.length; li++) {
          const t = noLad[li];
          variables.push({
            index: varIndex,
            marketId: market.marketId,
            platform: market.platform,
            side: 'NO',
            askPrice: t.price,
            feePerShare: t.fee,
            maxShares: t.size,
            priceSource: noSource,
            level: li,
          });
          objective.push(t.price + t.fee);
          varIndex++;
        }
      } else {
        variables.push({
          index: varIndex,
          marketId: market.marketId,
          platform: market.platform,
          side: 'NO',
          askPrice: askNo,
          feePerShare: feeNo,
          maxShares: noDepth,
          priceSource: noSource,
        });
        objective.push(askNo + feeNo);
        varIndex++;
      }
    }
  }

  if (varIndex === 0) return null;

  // G is a guaranteed-payout variable, not a leg: state rows become payout(s) − G ≥ 0
  // and the objective adds −1·G, so the LP maximizes (G − cost) = profit.
  // Normally the profit-max form is chosen exactly when some leg was split
  // across book levels. SOLVE_FORCE_PROFIT_MAX=1 selects it unconditionally,
  // so a one-level (top-of-book) run stays on the SAME objective and the same
  // absolute-dollar minProfit gate as a full-depth run. Bench/counterfactual
  // use only; unset (the default) leaves production behaviour byte-identical.
  const profitMax = anyTranched || process.env.SOLVE_FORCE_PROFIT_MAX === '1';
  let gIndex: number | undefined;
  if (profitMax) {
    gIndex = varIndex;
    variables.push({
      index: gIndex,
      marketId: -1,
      platform: variables[0]?.platform ?? 'polymarket',
      side: 'YES',
      askPrice: 0,
      feePerShare: 0,
      maxShares: null,
      priceSource: 'book',
    });
    objective.push(-1); // minimize cost − G  ⟺  maximize G − cost = profit
    varIndex++;
  }

  return { variables, objective, numVars: varIndex, guaranteedPayoutVarIndex: gIndex };
}

export function buildLP(
  cluster: Cluster,
  priceCache: PriceCache,
  exec: ExecutionParams = NO_EXECUTION_GATE,
  twoSidedBooks: boolean = true,
  bookLadder: boolean = bookLadderEnabled(),
): LPProblem | null {
  // A relaxed cluster has no enumerated worlds; building an unconstrained LP here
  // would fabricate a $0-cost $1-guarantee arb, so refuse it before the empty-states check.
  if (cluster.relaxed) return null;
  if (cluster.validStates.length === 0) return null;

  const legs = buildLegVariables(cluster, priceCache, exec, twoSidedBooks, bookLadder);
  if (!legs) return null;
  const { variables, objective, numVars: varIndex, guaranteedPayoutVarIndex: gIndex } = legs;
  const profitMax = gIndex !== undefined;

  const constraints: number[][] = [];
  const rhs: number[] = [];

  const m2q = marketToQuestion(cluster);
  const varQuestionMap: number[] = variables.map((v) => (v.marketId === -1 ? -1 : m2q.get(v.marketId) ?? -1));

  for (const state of cluster.validStates) {
    const row = new Array(varIndex).fill(0);

    for (let i = 0; i < variables.length; i++) {
      const v = variables[i];
      const qid = varQuestionMap[i];
      if (profitMax && i === gIndex) {
        // payout(s) − G ≥ 0
        row[i] = -1;
        continue;
      }
      const questionResolvesYes = state.get(qid) ?? false;

      if (v.side === 'YES' && questionResolvesYes) {
        // YES share pays $1 when question resolves YES
        row[i] = 1;
      } else if (v.side === 'NO' && !questionResolvesYes) {
        // NO share pays $1 when question resolves NO
        row[i] = 1;
      }
    }

    constraints.push(row);
    // Min-cost-$1 LP: payout ≥ 1. Profit-max LP: payout − G ≥ 0.
    rhs.push(profitMax ? 0 : 1);
  }

  return {
    numVars: varIndex,
    objective,
    constraints,
    rhs,
    variables,
    clusterId: cluster.id,
    guaranteedPayoutVarIndex: gIndex,
  };
}
