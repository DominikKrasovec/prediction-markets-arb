import type { Cluster } from '../graph/types.js';
import type { PriceCache, PriceSnapshot } from '../clob/price-cache.js';

/**
 * A fingerprint of every input `buildLP` would read for a cluster: each
 * market's YES + NO snapshot top-of-book (bid/ask/sizes + staleSince) and the
 * full ladder levels, plus the per-market fee model. If two consecutive
 * drains produce the same fingerprint, the rendered LP is identical, so the
 * second solve can be skipped. Conservative by construction: any field that
 * changes the LP changes the string here. Shared by `run-monitor/run.ts` and
 * `index.ts` so the dedup is identical in both loops.
 */
export function clusterFingerprint(cluster: Cluster, priceCache: PriceCache, now: number): string {
  const parts: string[] = [];
  for (const [, q] of cluster.questions) {
    for (const [mid, m] of q.markets) {
      const y = priceCache.get(mid, now);
      const n = priceCache.getNo(mid, now);
      const snap = (s: PriceSnapshot | undefined): string =>
        s
          ? `${s.bestBid},${s.bestAsk},${s.bidSize},${s.askSize},${s.staleSince ?? 0},` +
            `${s.askLevels ? s.askLevels.map((l) => l.join(':')).join('|') : ''},` +
            `${s.bidLevels ? s.bidLevels.map((l) => l.join(':')).join('|') : ''}`
          : '∅';
      parts.push(`${mid}=${snap(y)};${snap(n)};${m.feeModel ? `${m.feeModel.form}:${m.feeModel.rate}:${m.feeModel.exponent}` : 'd'}`);
    }
  }
  return parts.join('#');
}
