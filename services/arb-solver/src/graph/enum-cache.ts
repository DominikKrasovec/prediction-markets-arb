/** Content-addressed cache of per-cluster enumeration outcomes: the key must encode
 *  exactly the inputs `interpretCluster` (omega-constraints.ts) consumes — content-based
 *  (id-independent) and canonical (order sorted, slot order within a set preserved).
 *  SHA-1 only — a weaker digest could silently reuse the wrong Ω. */
import { createHash } from 'node:crypto';
import type { Cluster } from './types.js';
import type { EnumerationOutcome } from '../solver/state-enumerator.js';
import { edgeIsHard } from '../solver/omega-constraints.js';
import type { config as appConfig } from '../config.js';

type AppConfig = typeof appConfig;

const SYMMETRIC_EDGE_TYPES = new Set(['equivalence', 'mutual_exclusion']);

/** The cached load-time enumeration decision; never write a tick-time `applyLivenessDemotion` re-enumeration here. */
export interface CachedEnum {
  outcome: EnumerationOutcome;
  pinned: number[];
  degenerate: boolean;
  relaxed: boolean;
  /** Outcome-set ids demoted Σ=1 → Σ≤1; a cache HIT must replay this onto the fresh cluster. */
  demotedSetIds: number[];
}

/** Config knobs that change enumeration outcomes; folded into `structureKey` so a config change misses the cache. */
export function configEpoch(cfg: AppConfig): string {
  const s = cfg.solver;
  const canon = JSON.stringify({
    maxStates: s.maxStates,
    clusterSizeCap: s.clusterSizeCap,
    facetClusterQuestionCap: s.facetClusterQuestionCap,
    relaxedRoute: s.relaxedRoute,
    minEdgeConfidence: s.minEdgeConfidence,
  });
  return createHash('sha1').update(canon).digest('hex');
}

/** Enumeration-structure key: sorted member qids + per-set encoding + hard non-self edges. */
export function structureKey(cluster: Cluster, configEpochStr: string): string {
  const members = [...cluster.questions.keys()].sort((a, b) => a - b).join(',');

  const sets = cluster.outcomeSets
    .map(
      (os) =>
        `${os.setType}|${os.isExhaustive === true ? '1' : '0'}|${os.slotQuestionIds.join(',')}`,
    )
    .sort();

  const edges = cluster.edges
    .filter((e) => edgeIsHard(e) && e.antecedentQuestionId !== e.consequentQuestionId)
    .map((e) => {
      let a = e.antecedentQuestionId;
      let b = e.consequentQuestionId;
      if (SYMMETRIC_EDGE_TYPES.has(e.edgeType) && a > b) [a, b] = [b, a];
      return `${e.edgeType}|${a}>${b}`;
    })
    .sort();

  const composed = `v1;${configEpochStr};M:${members};S:${sets.join('~')};E:${edges.join('~')}`;
  return createHash('sha1').update(composed).digest('hex');
}

/** Cache of per-cluster enumeration outcomes keyed by {@link structureKey}. */
export class EnumCache {
  private readonly map = new Map<string, CachedEnum>();

  get size(): number {
    return this.map.size;
  }
  get(key: string): CachedEnum | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  set(key: string, value: CachedEnum): this {
    this.map.set(key, value);
    return this;
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }

  /** Evicts every entry whose key was NOT observed this build; call once after a full build pass. */
  sweep(seen: Set<string>): number {
    let evicted = 0;
    for (const key of this.map.keys()) {
      if (!seen.has(key)) {
        this.map.delete(key);
        evicted++;
      }
    }
    return evicted;
  }
}
