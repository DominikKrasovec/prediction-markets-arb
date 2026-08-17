/**
 * Pair registry — pure extraction of sentinel watch pairs from the loaded
 * constraint graph (`graph/loader.ts` types). No DB, no clock, no I/O.
 *
 * Sources:
 *  (a) `edge_type='equivalence'` edges (the loader does not load the
 *      `pattern` column, so this matches on the coarse edge_type) → endpoint
 *      member-market pairs. Cross-product is capped, cross-platform combos
 *      preferred.
 *  (b) Same-question multi-platform members (question_members fungibility)
 *      → cross-platform member pairs.
 *  (c) Optional `edge_type='mutual_exclusion'` edges → one representative
 *      pair per edge, mode 'mutex' (Σ ≤ 1+fees). Off by default.
 *
 * A market belongs to exactly one question, so equiv-edge pairs and
 * fungibility pairs can never collide; dedupe only has to handle
 * duplicate/reversed edges.
 */

import type { ConstraintGraph, QuestionNode, MarketRef } from '../graph/types.js';
import type { LegRef, WatchPair } from './types.js';

export interface RegistryOptions {
  /** Watch equivalence-edge endpoint pairs (default true). */
  includeEquivEdges?: boolean;
  /** Watch same-question cross-platform member pairs (default true). */
  includeMemberFungibility?: boolean;
  /** Watch mutual-exclusion edge pairs, mode 'mutex' (default false). */
  includeMutexEdges?: boolean;
  /** Cap on member-market combos emitted per equivalence edge (default 6). */
  maxPairsPerEdge?: number;
  /** Cap on member pairs emitted per multi-platform question (default 6). */
  maxPairsPerQuestion?: number;
  /** Optional marketId → title map for human-readable leg labels (the graph
   *  loader does not carry market titles). Falls back to the question label. */
  marketTitles?: Map<number, string>;
}

const DEFAULTS: Required<Omit<RegistryOptions, 'marketTitles'>> = {
  includeEquivEdges: true,
  includeMemberFungibility: true,
  includeMutexEdges: false,
  maxPairsPerEdge: 6,
  maxPairsPerQuestion: 6,
};

/** Loader edge_type values that assert equivalence / mutual exclusion. */
const EQUIV_EDGE_TYPES = new Set(['equivalence']);
const MUTEX_EDGE_TYPES = new Set(['mutual_exclusion']);

/** Human-readable label for a question node (loader fields only). */
export function questionLabel(q: QuestionNode): string {
  let label = q.canonicalSubject;
  if (q.conditionShape) {
    label += ` [${q.conditionShape}${q.conditionValue ? ` ${q.conditionValue}` : ''}]`;
  }
  if (q.conditionDate) label += ` @${q.conditionDate}`;
  return label;
}

function legOf(q: QuestionNode, m: MarketRef, titles?: Map<number, string>): LegRef {
  return {
    marketId: m.marketId,
    platform: m.platform,
    platformId: m.platformId,
    questionId: q.questionId,
    label: titles?.get(m.marketId) ?? questionLabel(q),
  };
}

/** Unordered dedupe key — kind + the two market ids. */
function pairKey(kind: WatchPair['kind'], a: number, b: number): string {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `${kind}|${lo}|${hi}`;
}

function sortedMembers(q: QuestionNode): MarketRef[] {
  return [...q.markets.values()].sort((x, y) => x.marketId - y.marketId);
}

/**
 * Extract the sentinel watch-pair set from a loaded constraint graph.
 * Pure function — deterministic for a given graph + options.
 */
export function buildWatchPairs(graph: ConstraintGraph, options: RegistryOptions = {}): WatchPair[] {
  const opts = { ...DEFAULTS, ...options };
  const pairs: WatchPair[] = [];
  const seen = new Set<string>();

  const push = (pair: WatchPair): void => {
    const key = pairKey(pair.kind, pair.legA.marketId, pair.legB.marketId);
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(pair);
  };

  // (a) equivalence edges → member cross-product, cross-platform combos first.
  if (opts.includeEquivEdges) {
    for (const edge of graph.edges) {
      if (!EQUIV_EDGE_TYPES.has(edge.edgeType)) continue;
      const qa = graph.questions.get(edge.antecedentQuestionId);
      const qb = graph.questions.get(edge.consequentQuestionId);
      if (!qa || !qb) continue; // endpoint filtered out by the loader (no live members)

      const combos: Array<{ a: MarketRef; b: MarketRef }> = [];
      for (const ma of sortedMembers(qa)) {
        for (const mb of sortedMembers(qb)) {
          if (ma.marketId === mb.marketId) continue;
          combos.push({ a: ma, b: mb });
        }
      }
      // Cross-platform disagreement is the identity-layer signal; same-platform
      // combos are kept only as backfill under the cap.
      combos.sort((x, y) => {
        const xp = x.a.platform !== x.b.platform ? 0 : 1;
        const yp = y.a.platform !== y.b.platform ? 0 : 1;
        if (xp !== yp) return xp - yp;
        return x.a.marketId - y.a.marketId || x.b.marketId - y.b.marketId;
      });
      for (const { a, b } of combos.slice(0, opts.maxPairsPerEdge)) {
        const lo = Math.min(a.marketId, b.marketId);
        const hi = Math.max(a.marketId, b.marketId);
        push({
          pairId: `eq:${edge.edgeId}:${lo}-${hi}`,
          kind: 'equiv-edge',
          mode: 'equal',
          legA: legOf(qa, a, options.marketTitles),
          legB: legOf(qb, b, options.marketTitles),
          edgeId: edge.edgeId,
          edgeType: edge.edgeType,
          edgeConfidence: edge.confidence,
        });
      }
    }
  }

  // (b) same-question multi-platform members (fungibility assertion).
  if (opts.includeMemberFungibility) {
    for (const q of graph.questions.values()) {
      if (q.markets.size < 2) continue;
      const members = sortedMembers(q);
      const combos: Array<{ a: MarketRef; b: MarketRef }> = [];
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          // Only cross-PLATFORM members assert fungibility worth watching —
          // same-platform duplicates inside one question are a dedupe artifact.
          if (members[i]!.platform === members[j]!.platform) continue;
          combos.push({ a: members[i]!, b: members[j]! });
        }
      }
      for (const { a, b } of combos.slice(0, opts.maxPairsPerQuestion)) {
        push({
          pairId: `fung:q${q.questionId}:${a.marketId}-${b.marketId}`,
          kind: 'member-fungibility',
          mode: 'equal',
          legA: legOf(q, a, options.marketTitles),
          legB: legOf(q, b, options.marketTitles),
        });
      }
    }
  }

  // (c) optional mutex edges → one representative pair per edge, mode 'mutex'.
  if (opts.includeMutexEdges) {
    for (const edge of graph.edges) {
      if (!MUTEX_EDGE_TYPES.has(edge.edgeType)) continue;
      const qa = graph.questions.get(edge.antecedentQuestionId);
      const qb = graph.questions.get(edge.consequentQuestionId);
      if (!qa || !qb) continue;
      const ma = sortedMembers(qa)[0];
      const mb = sortedMembers(qb)[0];
      if (!ma || !mb || ma.marketId === mb.marketId) continue;
      const lo = Math.min(ma.marketId, mb.marketId);
      const hi = Math.max(ma.marketId, mb.marketId);
      push({
        pairId: `mux:${edge.edgeId}:${lo}-${hi}`,
        kind: 'mutex-edge',
        mode: 'mutex',
        legA: legOf(qa, ma, options.marketTitles),
        legB: legOf(qb, mb, options.marketTitles),
        edgeId: edge.edgeId,
        edgeType: edge.edgeType,
        edgeConfidence: edge.confidence,
      });
    }
  }

  return pairs;
}
