import type { ConstraintGraph, QuestionNode, EdgeRef } from './types.js';
import { fold } from '@arb/types';
import { createLogger } from '@arb/logger';

const log = createLogger('graph:containment-belt');

/**
 * A belt: a purely subtractive guard that runs over an already-persisted graph
 * and removes constraints it can refute, so a stale or wrong upstream decision
 * cannot survive into a solve.
 *
 * This one detects an unsound mutex via three tells: CONTAINMENT (same
 * participant, monotone thresholds, so the narrower implies the wider),
 * WINNER+RUNG (a `<team>_wins` slot next to a same-team threshold slot — a rung
 * being one step of a numeric threshold ladder — which resolve together), and
 * PRICE CONTRADICTION (Σ best-YES-bids over the clique exceeds 1 + slack).
 * Removing a constraint only enlarges Ω, so a false positive costs at most one
 * real mutex's recall, never a fake arb.
 */

/** Σ-of-best-YES-bids overshoot beyond which a mutex clique is refuted. */
export const DEFAULT_PRICE_CONTRADICTION_SLACK = 0.15;

export interface ContainmentBeltOptions {
  /** Absent ⟹ the price-contradiction arm is dormant; the two structural arms still run. */
  yesBidOf?: (marketId: number) => number | null | undefined;
  /** Raise-only: a larger slack only makes the belt fire less, never suppresses it below default. */
  priceContradictionSlack?: number;
}

export interface ContainmentBeltResult {
  containmentHits: number;
  winnerRungHits: number;
  priceContradictionHits: number;
  zeroOverlapHits: number;
  setsFreed: number;
  freedSetIds: number[];
  edgesDropped: number;
  suspectPairs: Array<[number, number]>;
}

/** Process-lifetime latch for the price arm: a refutation can look innocent later
 *  once the book goes quiet, so drops are remembered and re-asserted on every reload. */
export interface ContainmentLatch {
  refutedSetIds: Set<number>;
  refutedPairs: Set<string>;
}

/** Hold ONE per process (module-level in the caller). */
export function newContainmentLatch(): ContainmentLatch {
  return { refutedSetIds: new Set<number>(), refutedPairs: new Set<string>() };
}

/** Call after every price-armed applyIntraSetContainmentBelt so its drops persist across reloads. */
export function latchBeltResult(latch: ContainmentLatch, res: ContainmentBeltResult): void {
  for (const id of res.freedSetIds) latch.refutedSetIds.add(id);
  for (const [a, b] of res.suspectPairs) latch.refutedPairs.add(pairKey(a, b));
}

/** Runs BEFORE the belt so a prior drop stays dropped even once the book is quiet. Idempotent. */
export function applyContainmentLatch(graph: ConstraintGraph, latch: ContainmentLatch): { setsFreed: number; edgesDropped: number } {
  let setsFreed = 0;
  let edgesDropped = 0;
  if (latch.refutedSetIds.size > 0) {
    const before = graph.outcomeSets.length;
    graph.outcomeSets = graph.outcomeSets.filter((os) => !latch.refutedSetIds.has(os.setId));
    setsFreed = before - graph.outcomeSets.length;
  }
  if (latch.refutedPairs.size > 0) {
    const before = graph.edges.length;
    graph.edges = graph.edges.filter(
      (e) => !(e.edgeType === 'mutual_exclusion' && latch.refutedPairs.has(pairKey(e.antecedentQuestionId, e.consequentQuestionId))),
    );
    edgesDropped = before - graph.edges.length;
    const seen = new Set<string>();
    const unioned: Array<[number, number]> = [];
    for (const [a, b] of graph.duplicateSuspectPairs ?? []) {
      const k = pairKey(a, b);
      if (!seen.has(k)) { seen.add(k); unioned.push([a, b]); }
    }
    for (const k of latch.refutedPairs) {
      if (seen.has(k)) continue;
      seen.add(k);
      const [a, b] = k.split(':').map(Number);
      unioned.push([a!, b!]);
    }
    graph.duplicateSuspectPairs = unioned;
  }
  if (setsFreed > 0 || edgesDropped > 0) {
    log.info(
      `mechanism-2 latch: re-asserted ${latch.refutedSetIds.size} refuted set(s) / ${latch.refutedPairs.size} pair(s) ` +
        `on reload — freed ${setsFreed} set(s), dropped ${edgesDropped} edge(s) (no price flap-back).`,
    );
  }
  return { setsFreed, edgesDropped };
}

/** Parsed outcome-slug facts for one slot question. */
interface SlotFacts {
  qid: number;
  participant: string | null;
  direction: 'up' | 'down' | null;
  value: number | null;
  isWinner: boolean;
}

const UP_DIRS = new Set(['over', 'above', 'greater', 'atleast', 'at_least', 'morethan', 'more_than', 'gt', 'ge']);
const DOWN_DIRS = new Set(['under', 'below', 'less', 'atmost', 'at_most', 'lessthan', 'less_than', 'fewer', 'lt', 'le']);

// `.+?` is non-greedy so the trailing `_<dir>_<value>` binds to the rightmost occurrence.
const THRESHOLD_RE = new RegExp(
  String.raw`^(.+?)_(over|above|greater|at_?least|more_?than|under|below|less|at_?most|less_?than|fewer|gt|ge|lt|le)_(\d+(?:\.\d+)?)$`,
);
// Spread slugs carry no over/under word and a leading '-' value, so THRESHOLD_RE misses them.
// A spread is monotone (-2.5 ⊂ -1.5), so both get a constant sentinel direction ('down') to
// compare equal-direction under isContainment; the value keeps its sign so rungs still differ.
const SPREAD_RE = /^spread_(.+?)_(-?\d+(?:\.\d+)?)$/;
const SIGNED_THRESHOLD_RE = /^(.+?)_(-\d+(?:\.\d+)?)$/;
const WINNER_RE = /^(.+?)_wins?$/;

function slugOf(canonicalKey: string | null | undefined): string {
  return (canonicalKey ?? '').split(':').pop() ?? '';
}

function factsOf(q: QuestionNode): SlotFacts {
  const slug = slugOf(q.canonicalKey);
  const t = THRESHOLD_RE.exec(slug);
  if (t) {
    const dirTok = t[2].replace(/_/g, '');
    const direction = UP_DIRS.has(t[2]) || UP_DIRS.has(dirTok) ? 'up' : DOWN_DIRS.has(t[2]) || DOWN_DIRS.has(dirTok) ? 'down' : null;
    return { qid: q.questionId, participant: fold(t[1]) || null, direction, value: Number.parseFloat(t[3]), isWinner: false };
  }
  const sp = SPREAD_RE.exec(slug) ?? SIGNED_THRESHOLD_RE.exec(slug);
  if (sp) {
    return { qid: q.questionId, participant: fold(sp[1]) || null, direction: 'down', value: Number.parseFloat(sp[2]), isWinner: false };
  }
  const w = WINNER_RE.exec(slug);
  if (w) return { qid: q.questionId, participant: fold(w[1]) || null, direction: null, value: null, isWinner: true };
  return { qid: q.questionId, participant: null, direction: null, value: null, isWinner: false };
}

/** Same participant, both thresholds, same direction, different value ⟹ one interval ⊂ the other. */
function isContainment(a: SlotFacts, b: SlotFacts): boolean {
  return (
    a.value !== null &&
    b.value !== null &&
    a.direction !== null &&
    a.direction === b.direction &&
    a.participant !== null &&
    a.participant === b.participant &&
    a.value !== b.value
  );
}

/** One `<team>_wins`, the other a threshold on the same team — both resolve YES together. */
function isWinnerRung(a: SlotFacts, b: SlotFacts): boolean {
  const winThenRung = a.isWinner && b.value !== null && a.participant !== null && a.participant === b.participant;
  const rungThenWin = b.isWinner && a.value !== null && b.participant !== null && b.participant === a.participant;
  return winThenRung || rungThenWin;
}

/** Mutates `graph` in place; idempotent (a re-run finds the set/edges already removed). */
export function applyIntraSetContainmentBelt(
  graph: ConstraintGraph,
  options: ContainmentBeltOptions = {},
): ContainmentBeltResult {
  const slack = Math.max(options.priceContradictionSlack ?? DEFAULT_PRICE_CONTRADICTION_SLACK, DEFAULT_PRICE_CONTRADICTION_SLACK);
  const yesBidOf = options.yesBidOf;

  let containmentHits = 0;
  let winnerRungHits = 0;
  let priceContradictionHits = 0;
  let zeroOverlapHits = 0;
  let setsFreed = 0;
  let edgesDropped = 0;
  const suspectPairs: Array<[number, number]> = [];
  const seenSuspect = new Set<string>();
  const record = (a: number, b: number): void => {
    const k = pairKey(a, b);
    if (seenSuspect.has(k)) return;
    seenSuspect.add(k);
    suspectPairs.push([a, b]);
  };

  // A set that trips any tell is dropped whole — no clean sound sub-mutex remains once a rung is fused in.
  const setIdsToFree = new Set<number>();
  for (const os of graph.outcomeSets) {
    if (os.setType !== 'categorical') continue;
    const facts = os.slotQuestionIds
      .map((qid) => graph.questions.get(qid))
      .filter((q): q is QuestionNode => q != null)
      .map(factsOf);

    let structuralHit = false;
    let winnerRungHit = false;
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const a = facts[i]!;
        const b = facts[j]!;
        if (isContainment(a, b)) {
          structuralHit = true;
          record(a.qid, b.qid);
        }
        if (isWinnerRung(a, b)) {
          structuralHit = true;
          winnerRungHit = true;
          record(a.qid, b.qid);
        }
      }
    }
    let zeroOverlapHit = false;
    if (!structuralHit && crossPlatformZeroOverlap(os.slotQuestionIds, graph)) {
      zeroOverlapHit = true;
      structuralHit = true;
      for (let i = 0; i < os.slotQuestionIds.length; i++) {
        for (let j = i + 1; j < os.slotQuestionIds.length; j++) record(os.slotQuestionIds[i]!, os.slotQuestionIds[j]!);
      }
    }

    if (structuralHit) {
      if (winnerRungHit) winnerRungHits++;
      if (zeroOverlapHit) zeroOverlapHits++;
      else containmentHits++;
      setIdsToFree.add(os.setId);
      log.info(
        `mechanism-2 containment belt: categorical set ${os.setId} "${os.setName}" tripped the ` +
          `${zeroOverlapHit ? 'cross-platform zero-overlap two-partition' : (winnerRungHit ? 'winner+rung + ' : '') + 'containment'} tell — ` +
          `freeing its ${os.slotQuestionIds.length} slot(s) to free questions (removes a fake mutex, which can only enlarge Ω).`,
      );
      continue;
    }

    if (yesBidOf) {
      const sum = cliqueBidSum(os.slotQuestionIds, graph, yesBidOf);
      if (sum !== null && sum > 1 + slack) {
        priceContradictionHits++;
        setIdsToFree.add(os.setId);
        for (let i = 0; i < os.slotQuestionIds.length; i++) {
          for (let j = i + 1; j < os.slotQuestionIds.length; j++) record(os.slotQuestionIds[i]!, os.slotQuestionIds[j]!);
        }
        log.info(
          `mechanism-2 price-contradiction belt: categorical set ${os.setId} "${os.setName}" — ` +
            `Σ best-YES-bids ${sum.toFixed(3)} > 1 + ${slack} across a mutex clique; the order book ` +
            `refutes the mutex. Freeing the set (dropping a constraint only enlarges Ω).`,
        );
      }
    }
  }
  if (setIdsToFree.size > 0) {
    const before = graph.outcomeSets.length;
    graph.outcomeSets = graph.outcomeSets.filter((os) => !setIdsToFree.has(os.setId));
    setsFreed = before - graph.outcomeSets.length;
  }
  const freedSetIds = [...setIdsToFree];

  // Some mutex shapes carry no outcome set, just pairwise mutual_exclusion edges.
  const mutexEdges = graph.edges.filter((e) => e.edgeType === 'mutual_exclusion');
  if (mutexEdges.length > 0) {
    const components = mutexComponents(mutexEdges);
    const edgeIdsToDrop = new Set<number>();
    for (const comp of components) {
      if (comp.size < 2) continue;
      const qids = [...comp];
      const facts = qids
        .map((qid) => graph.questions.get(qid))
        .filter((q): q is QuestionNode => q != null)
        .map(factsOf);

      let hit = false;
      let winnerRungHit = false;
      let priceHit = false;

      for (let i = 0; i < facts.length; i++) {
        for (let j = i + 1; j < facts.length; j++) {
          const a = facts[i]!;
          const b = facts[j]!;
          if (isContainment(a, b)) {
            hit = true;
            record(a.qid, b.qid);
          }
          if (isWinnerRung(a, b)) {
            hit = true;
            winnerRungHit = true;
            record(a.qid, b.qid);
          }
        }
      }
      if (yesBidOf) {
        const sum = cliqueBidSum(qids, graph, yesBidOf);
        if (sum !== null && sum > 1 + slack) {
          priceHit = true;
          hit = true;
          for (let i = 0; i < qids.length; i++) {
            for (let j = i + 1; j < qids.length; j++) record(qids[i]!, qids[j]!);
          }
          log.info(
            `mechanism-2 price-contradiction belt: mutex-edge clique of ${qids.length} question(s) — ` +
              `Σ best-YES-bids ${sum.toFixed(3)} > 1 + ${slack}; dropping the clique's mutex edges (only enlarges Ω).`,
          );
        }
      }

      if (hit) {
        if (winnerRungHit) winnerRungHits++;
        if (priceHit) priceContradictionHits++;
        else containmentHits++;
        for (const e of mutexEdges) {
          if (comp.has(e.antecedentQuestionId) && comp.has(e.consequentQuestionId)) edgeIdsToDrop.add(e.edgeId);
        }
      }
    }
    if (edgeIdsToDrop.size > 0) {
      const before = graph.edges.length;
      graph.edges = graph.edges.filter((e) => !edgeIdsToDrop.has(e.edgeId));
      edgesDropped = before - graph.edges.length;
    }
  }

  if (suspectPairs.length > 0) {
    const seen = new Set<string>();
    const unioned: Array<[number, number]> = [];
    for (const [a, b] of [...(graph.duplicateSuspectPairs ?? []), ...suspectPairs]) {
      const k = pairKey(a, b);
      if (seen.has(k)) continue;
      seen.add(k);
      unioned.push([a, b]);
    }
    graph.duplicateSuspectPairs = unioned;
  }

  if (setsFreed > 0 || edgesDropped > 0) {
    log.warn(
      `mechanism-2 intra-set containment + price-contradiction belt: ${containmentHits} containment, ` +
        `${winnerRungHits} winner+rung, ${zeroOverlapHits} zero-overlap, ${priceContradictionHits} price-contradiction hit(s) — ` +
        `freed ${setsFreed} categorical set(s), dropped ${edgesDropped} mutex edge(s), ` +
        `recorded ${suspectPairs.length} suspect pair(s) for the trigger belt.`,
    );
  }

  return { containmentHits, winnerRungHits, priceContradictionHits, zeroOverlapHits, setsFreed, freedSetIds, edgesDropped, suspectPairs };
}

/** TRUE iff slots split cleanly across ≥2 platforms with no cross-platform outcome and
 *  ≥2 outcomes on each of ≥2 sides — the aggregate-vs-member merge shape (a team ⊂ its region). */
function crossPlatformZeroOverlap(slotQuestionIds: readonly number[], graph: ConstraintGraph): boolean {
  const perPlatform = new Map<string, number>();
  const platforms = new Set<string>();
  for (const qid of slotQuestionIds) {
    const q = graph.questions.get(qid);
    if (!q) continue;
    const ps = new Set<string>();
    for (const m of q.markets.values()) ps.add(m.platform);
    if (ps.size === 0) continue;
    if (ps.size >= 2) return false;
    for (const p of ps) platforms.add(p);
    const p = [...ps][0]!;
    perPlatform.set(p, (perPlatform.get(p) ?? 0) + 1);
  }
  if (platforms.size < 2) return false;
  let sidesWith2 = 0;
  for (const n of perPlatform.values()) if (n >= 2) sidesWith2++;
  return sidesWith2 >= 2;
}

/** Σ of best YES bids; a multi-market question uses the MAX bid (most aggressive,
 *  which biases toward flagging — safe since flagging only enlarges Ω). Null when no member is quoted. */
function cliqueBidSum(
  qids: readonly number[],
  graph: ConstraintGraph,
  yesBidOf: (marketId: number) => number | null | undefined,
): number | null {
  let sum = 0;
  let anyQuoted = false;
  for (const qid of qids) {
    const q = graph.questions.get(qid);
    if (!q) continue;
    let best: number | null = null;
    for (const [mid] of q.markets) {
      const bid = yesBidOf(mid);
      if (bid == null || !Number.isFinite(bid) || bid <= 0) continue;
      if (best === null || bid > best) best = bid;
    }
    if (best !== null) {
      sum += best;
      anyQuoted = true;
    }
  }
  return anyQuoted ? sum : null;
}

/** Connected components of the mutual-exclusion edge graph (union-find, node = qid). */
function mutexComponents(mutexEdges: readonly EdgeRef[]): Array<Set<number>> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = parent.get(x) ?? x;
    if (r === x) {
      parent.set(x, x);
      return x;
    }
    while (r !== (parent.get(r) ?? r)) {
      const gp = parent.get(r) ?? r;
      parent.set(r, parent.get(gp) ?? gp);
      r = parent.get(r) ?? r;
    }
    parent.set(x, r);
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of mutexEdges) {
    if (!parent.has(e.antecedentQuestionId)) parent.set(e.antecedentQuestionId, e.antecedentQuestionId);
    if (!parent.has(e.consequentQuestionId)) parent.set(e.consequentQuestionId, e.consequentQuestionId);
    union(e.antecedentQuestionId, e.consequentQuestionId);
  }
  const groups = new Map<number, Set<number>>();
  for (const node of parent.keys()) {
    const r = find(node);
    let g = groups.get(r);
    if (!g) {
      g = new Set<number>();
      groups.set(r, g);
    }
    g.add(node);
  }
  return [...groups.values()];
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export const _internals = { factsOf, isContainment, isWinnerRung, cliqueBidSum, mutexComponents, slugOf };
