/**
 * Stage-3a candidate-retrieval recall@k against ground truth: GOLD from
 * market_cross_refs (Predict's on-chain conditionId equivalences), SILVER
 * from semantic_event sibling pairs (circular — semantic_events were built
 * from pairs that passed this funnel, so silver is reported separately,
 * never folded into gold). Replays embedding distance, each Stage-3a gate,
 * top-k membership (gated + ungated), and the market-ANN fallback. READ-ONLY.
 * Run: `bun services/pipeline/src/scripts/measure-ann-recall.ts [--k N]
 * [--max-distance N] [--gold-only] [--no-fallback] [--assert-min-recall N]`
 * (bun, not tsx — the workspace @arb/* packages need its export condition).
 */
import { pathToFileURL } from 'url';
import { query, queryWithHints, endPool } from '@arb/db';
import { createLogger } from '@arb/logger';
import { config } from '../config.js';
import {
  GATE_ORDER,
  gateSql,
  eventPairGatesSql,
  passesTitleSanity,
  type GateName,
} from '../stage3-events/ann-candidates.js';

const log = createLogger('measure-ann-recall');

// Mirrors the un-exported ANN_K / fallback knobs in stage3-events/ann-candidates.ts (same env vars, same defaults).
const ANN_K_DEFAULT = 20;
const FALLBACK_K = parseInt(process.env.MARKET_ANN_FALLBACK_K ?? '3', 10);
const FALLBACK_DISTANCE_MAX = parseFloat(process.env.MARKET_ANN_FALLBACK_DISTANCE_MAX ?? '0.25');

// Re-exported production gate fragments — a gate added to GATE_ORDER is measured here by construction.
export { GATE_ORDER, gateSql };
export type { GateName };
export const allGatesSql = eventPairGatesSql;

// Corruption signature, verbatim from scripts/repair-shifted-embeddings.ts.
const PE_CORRUPT_SIGNATURE = `
  SELECT a.id
    FROM platform_events a
    JOIN platform_events b ON a.id = b.id + 1000
   WHERE a.embedding IS NOT NULL
     AND b.embedding IS NOT NULL
     AND (a.embedding <=> b.embedding) < 0.0005
     AND lower(btrim(a.title)) <> lower(btrim(b.title))
`;

// Classification

export type PairClass =
  | 'retrieved'
  | 'missing-embedding'
  | 'embedding-corrupted'
  | 'blocked-by-gate'
  | 'blocked-by-distance'
  | 'blocked-by-rank';

export interface PairFacts {
  missingEmbedding: boolean;
  corrupted: boolean;
  distance: number | null;
  failingGates: GateName[];
  topkUngated: boolean;
  topkGated: boolean;
}

// Precedence: missing-embedding > embedding-corrupted > retrieved > blocked-by-gate > blocked-by-distance > blocked-by-rank.
export function classifyPair(f: PairFacts, maxDistance: number): PairClass {
  if (f.missingEmbedding) return 'missing-embedding';
  if (f.corrupted) return 'embedding-corrupted';
  if (f.failingGates.length === 0 && f.distance !== null && f.distance < maxDistance && f.topkGated) return 'retrieved';
  if (f.failingGates.length > 0) return 'blocked-by-gate';
  if (f.distance === null || f.distance >= maxDistance) return 'blocked-by-distance';
  return 'blocked-by-rank';
}

// CLI

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

interface TruthPair {
  pe_a: number;
  pe_b: number;
  src: 'gold' | 'silver' | 'both';
  title_a?: string;
  title_b?: string;
  missingEmbedding?: boolean;
  corrupted?: boolean;
  distance?: number | null;
  failingGates?: GateName[];
  topkUngated?: boolean;
  topkGated?: boolean;
  rescuedByFallback?: boolean;
  cls?: PairClass;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const pct = (num: number, den: number): string => (den === 0 ? 'n/a' : `${((100 * num) / den).toFixed(2)}%`);

async function assemblePairs(goldOnly: boolean): Promise<TruthPair[]> {
  const gold = await query<{ pe_a: number; pe_b: number }>(`
    SELECT DISTINCT LEAST(pa.id, pb.id) AS pe_a, GREATEST(pa.id, pb.id) AS pe_b
    FROM market_cross_refs x
    JOIN markets ms ON ms.id = x.source_market_id
    JOIN markets mt ON mt.id = x.target_market_id
    JOIN platform_events pa ON pa.platform = ms.platform AND pa.platform_event_id = ms.platform_event_id
    JOIN platform_events pb ON pb.platform = mt.platform AND pb.platform_event_id = mt.platform_event_id
    WHERE ms.platform <> mt.platform
  `);
  const byKey = new Map<string, TruthPair>();
  for (const g of gold) byKey.set(`${g.pe_a}:${g.pe_b}`, { pe_a: g.pe_a, pe_b: g.pe_b, src: 'gold' });

  if (!goldOnly) {
    const silver = await query<{ pe_a: number; pe_b: number }>(`
      SELECT DISTINCT LEAST(s1.platform_event_id, s2.platform_event_id) AS pe_a,
                      GREATEST(s1.platform_event_id, s2.platform_event_id) AS pe_b
      FROM semantic_event_platforms s1
      JOIN semantic_event_platforms s2
        ON s1.semantic_event_id = s2.semantic_event_id
       AND s1.platform_event_id < s2.platform_event_id
      JOIN semantic_events se ON se.id = s1.semantic_event_id AND se.archived_at IS NULL
      JOIN platform_events p1 ON p1.id = s1.platform_event_id
      JOIN platform_events p2 ON p2.id = s2.platform_event_id
      WHERE p1.platform <> p2.platform
    `);
    for (const s of silver) {
      const key = `${s.pe_a}:${s.pe_b}`;
      const prev = byKey.get(key);
      if (prev) prev.src = 'both';
      else byKey.set(key, { pe_a: s.pe_a, pe_b: s.pe_b, src: 'silver' });
    }
  }
  return [...byKey.values()];
}

async function fillFacts(pairs: TruthPair[], cryptoMs: number, hourMs: number): Promise<void> {
  const gateCols = GATE_ORDER.map((g, i) => `${gateSql(g, '$3', '$4')} AS gate_${i}`).join(',\n           ');
  for (const c of chunk(pairs, 2000)) {
    const rows = await query<Record<string, unknown>>(
      `SELECT t.ord::int AS ord,
              a.title AS title_a, b.title AS title_b,
              (a.embedding IS NULL OR b.embedding IS NULL) AS missing_embedding,
              CASE WHEN a.embedding IS NOT NULL AND b.embedding IS NOT NULL
                   THEN (a.embedding <=> b.embedding)::float8 END AS distance,
           ${gateCols}
         FROM unnest($1::int[], $2::int[]) WITH ORDINALITY AS t(pe_a, pe_b, ord)
         JOIN platform_events a ON a.id = t.pe_a
         JOIN platform_events b ON b.id = t.pe_b`,
      [c.map((p) => p.pe_a), c.map((p) => p.pe_b), cryptoMs, hourMs],
    );
    for (const r of rows) {
      const p = c[(r.ord as number) - 1];
      p.title_a = r.title_a as string;
      p.title_b = r.title_b as string;
      p.missingEmbedding = r.missing_embedding as boolean;
      p.distance = (r.distance as number | null) ?? null;
      p.failingGates = GATE_ORDER.filter((_, i) => r[`gate_${i}`] === false);
    }
  }
}

async function fillTopK(
  pairs: TruthPair[],
  k: number,
  gated: boolean,
  cryptoMs: number,
  hourMs: number,
): Promise<void> {
  const field = gated ? 'topkGated' : 'topkUngated';
  for (const p of pairs) p[field] = false;
  const gatesClause = gated ? `AND ${allGatesSql('$5', '$6')}` : '';
  for (const c of chunk(pairs, 500)) {
    // Two anchor rows per pair (a->b, b->a); bool_or folds the directions.
    const pairIdx: number[] = [];
    const anchorIds: number[] = [];
    const partnerIds: number[] = [];
    c.forEach((p, i) => {
      pairIdx.push(i, i);
      anchorIds.push(p.pe_a, p.pe_b);
      partnerIds.push(p.pe_b, p.pe_a);
    });
    const params: unknown[] = [pairIdx, anchorIds, partnerIds, k];
    if (gated) params.push(cryptoMs, hourMs);
    const rows = await queryWithHints<{ pair_idx: number; hit: boolean }>(
      `SELECT x.pair_idx, bool_or(n.id = x.partner_id) AS hit
         FROM unnest($1::int[], $2::int[], $3::int[]) AS x(pair_idx, anchor_id, partner_id)
         JOIN platform_events a ON a.id = x.anchor_id AND a.embedding IS NOT NULL
         CROSS JOIN LATERAL (
           SELECT b.id
           FROM platform_events b
           WHERE b.id <> a.id
             AND b.embedding IS NOT NULL
             AND b.platform <> a.platform
             ${gatesClause}
           ORDER BY b.embedding <=> a.embedding
           LIMIT $4
         ) n
        GROUP BY x.pair_idx`,
      params,
      { enable_seqscan: 'off' },
    );
    for (const r of rows) if (r.hit) c[r.pair_idx][field] = true;
  }
}

// Deviates from production by dropping the unbound-pe population check (fresh-rebuild semantics); keeps end_date > NOW() and title-sanity.
async function fillFallbackRescue(pairs: TruthPair[]): Promise<void> {
  for (const p of pairs) p.rescuedByFallback = false;
  for (const c of chunk(pairs, 200)) {
    const pairIdx: number[] = [];
    const anchorPe: number[] = [];
    const partnerPe: number[] = [];
    c.forEach((p, i) => {
      pairIdx.push(i, i);
      anchorPe.push(p.pe_a, p.pe_b);
      partnerPe.push(p.pe_b, p.pe_a);
    });
    const rows = await queryWithHints<{ pair_idx: number; a_title: string; b_title: string; title_trgm: number }>(
      `WITH anchors AS (
         SELECT x.pair_idx, x.partner_pe, m.id AS mkt_id, m.title, m.embedding, m.platform
         FROM unnest($1::int[], $2::int[], $3::int[]) AS x(pair_idx, anchor_pe, partner_pe)
         JOIN platform_events pe ON pe.id = x.anchor_pe
         JOIN markets m ON m.platform = pe.platform AND m.platform_event_id = pe.platform_event_id
         WHERE m.embedding IS NOT NULL AND m.end_date > NOW()
       )
       SELECT a.pair_idx, a.title AS a_title, n.b_title,
              similarity(a.title, n.b_title)::float8 AS title_trgm
       FROM anchors a
       CROSS JOIN LATERAL (
         SELECT mb.title AS b_title, mb.platform AS b_platform, mb.platform_event_id AS b_peid,
                mb.embedding <=> a.embedding AS distance
         FROM markets mb
         WHERE mb.embedding IS NOT NULL
           AND mb.platform <> a.platform
           AND mb.end_date > NOW()
         ORDER BY mb.embedding <=> a.embedding
         LIMIT $4
       ) n
       JOIN platform_events pb
         ON pb.platform = n.b_platform AND pb.platform_event_id = n.b_peid AND pb.id = a.partner_pe
       WHERE n.distance < $5`,
      [pairIdx, anchorPe, partnerPe, FALLBACK_K, FALLBACK_DISTANCE_MAX],
      { enable_seqscan: 'off' },
    );
    for (const r of rows) {
      if (!c[r.pair_idx].rescuedByFallback && passesTitleSanity(r.a_title, r.b_title, r.title_trgm)) {
        c[r.pair_idx].rescuedByFallback = true;
      }
    }
  }
}

interface TierReport {
  tier: string;
  total: number;
  corrupted: number;
  missing: number;
  usable: number;
  embOnlyTopK: number;
  withinDistance: number;
  gatesPass: number;
  retrieved: number;
  rescued: number;
  combined: number;
}

function reportTier(tier: string, pairs: TruthPair[]): TierReport {
  const corrupted = pairs.filter((p) => p.cls === 'embedding-corrupted');
  const missing = pairs.filter((p) => p.cls === 'missing-embedding');
  const usable = pairs.filter((p) => p.cls !== 'embedding-corrupted' && p.cls !== 'missing-embedding');
  const retrieved = usable.filter((p) => p.cls === 'retrieved');
  const rescued = usable.filter((p) => p.cls !== 'retrieved' && p.rescuedByFallback);
  return {
    tier,
    total: pairs.length,
    corrupted: corrupted.length,
    missing: missing.length,
    usable: usable.length,
    embOnlyTopK: usable.filter((p) => p.topkUngated).length,
    withinDistance: usable.filter((p) => p.distance != null && p.distance < MAX_DISTANCE).length,
    gatesPass: usable.filter((p) => (p.failingGates ?? []).length === 0).length,
    retrieved: retrieved.length,
    rescued: rescued.length,
    combined: retrieved.length + rescued.length,
  };
}

const K = parseInt(argValue('--k') ?? String(ANN_K_DEFAULT), 10);
const MAX_DISTANCE = parseFloat(argValue('--max-distance') ?? String(config.events.annCosineDistanceMax));
const GOLD_ONLY = process.argv.includes('--gold-only');
const NO_FALLBACK = process.argv.includes('--no-fallback');
const ASSERT_MIN_RECALL = argValue('--assert-min-recall');

async function main(): Promise<void> {
  const cryptoMs = config.pairing.sameEventCryptoToleranceMs;
  const hourMs = config.pairing.sameEventHourToleranceMs;
  log.info(`replaying Stage-3a candidacy: k=${K}, maxDistance=${MAX_DISTANCE}, crypto<${cryptoMs}ms, hour<${hourMs}ms` +
    `${GOLD_ONLY ? ' (gold only)' : ''}${NO_FALLBACK ? ' (fallback replay off)' : ''}`);

  const pairs = await assemblePairs(GOLD_ONLY);
  const corruptIds = new Set((await query<{ id: number }>(PE_CORRUPT_SIGNATURE)).map((r) => r.id));
  for (const p of pairs) p.corrupted = corruptIds.has(p.pe_a) || corruptIds.has(p.pe_b);
  const nGold = pairs.filter((p) => p.src !== 'silver').length;
  log.info(`truth pairs: ${pairs.length} total — gold ${nGold} (incl. ${pairs.filter((p) => p.src === 'both').length} also silver), ` +
    `silver-only ${pairs.length - nGold}; corrupted platform_events in DB: ${corruptIds.size}`);

  await fillFacts(pairs, cryptoMs, hourMs);

  log.info('replaying ungated top-k (pure-embedding paper bound)…');
  await fillTopK(pairs, K, false, cryptoMs, hourMs);
  log.info('replaying gated top-k (production Stage-3a semantics)…');
  await fillTopK(pairs, K, true, cryptoMs, hourMs);

  for (const p of pairs) {
    p.cls = classifyPair(
      {
        missingEmbedding: p.missingEmbedding ?? true,
        corrupted: p.corrupted ?? false,
        distance: p.distance ?? null,
        failingGates: p.failingGates ?? [],
        topkUngated: p.topkUngated ?? false,
        topkGated: p.topkGated ?? false,
      },
      MAX_DISTANCE,
    );
  }

  // Gate-blocked pairs can't be rescued (the fallback applies the same event gates), so they're excluded from the replay.
  if (!NO_FALLBACK) {
    const missed = pairs.filter(
      (p) => p.cls !== 'retrieved' && p.cls !== 'blocked-by-gate' && (p.failingGates ?? []).length === 0,
    );
    log.info(`replaying market-ANN fallback (k=${FALLBACK_K}, dist<${FALLBACK_DISTANCE_MAX}) for ${missed.length} missed pairs…`);
    await fillFallbackRescue(missed);
  }

  const goldPairs = pairs.filter((p) => p.src !== 'silver');
  const silverPairs = pairs.filter((p) => p.src === 'silver');

  const tiers = [reportTier('GOLD (cross-refs)', goldPairs)];
  if (silverPairs.length > 0) tiers.push(reportTier('SILVER-only (SE siblings — circular!)', silverPairs));

  console.log('\n=== Stage-3a retrieval funnel (corruption-excluded denominators) ===');
  console.table(
    tiers.map((t) => ({
      tier: t.tier,
      pairs: t.total,
      corrupted: t.corrupted,
      'missing-emb': t.missing,
      usable: t.usable,
      [`emb-only R@${K}`]: `${t.embOnlyTopK} (${pct(t.embOnlyTopK, t.usable)})`,
      [`dist<${MAX_DISTANCE}`]: `${t.withinDistance} (${pct(t.withinDistance, t.usable)})`,
      'gates pass': `${t.gatesPass} (${pct(t.gatesPass, t.usable)})`,
      [`event-pass R@${K}`]: `${t.retrieved} (${pct(t.retrieved, t.usable)})`,
      'fallback +': t.rescued,
      'combined R': `${t.combined} (${pct(t.combined, t.usable)})`,
    })),
  );

  console.log('\n=== Classification breakdown ===');
  const classes: PairClass[] = ['retrieved', 'blocked-by-gate', 'blocked-by-distance', 'blocked-by-rank', 'embedding-corrupted', 'missing-embedding'];
  console.table(
    classes.map((cls) => ({
      class: cls,
      gold: goldPairs.filter((p) => p.cls === cls).length,
      'gold rescued-by-fallback': goldPairs.filter((p) => p.cls === cls && p.rescuedByFallback).length,
      silver: silverPairs.filter((p) => p.cls === cls).length,
      'silver rescued-by-fallback': silverPairs.filter((p) => p.cls === cls && p.rescuedByFallback).length,
    })),
  );

  console.log('\n=== Per-gate recall loss (independent evaluation) ===');
  console.table(
    GATE_ORDER.map((g) => {
      const fails = (set: TruthPair[]) => set.filter((p) => (p.failingGates ?? []).includes(g) && !p.corrupted && !p.missingEmbedding);
      // sole blocker: only failing gate, and otherwise reachable (dist<max, inside ungated top-k) — the loss this gate alone causes.
      const sole = (set: TruthPair[]) =>
        fails(set).filter((p) => (p.failingGates ?? []).length === 1 && p.distance != null && p.distance < MAX_DISTANCE && p.topkUngated);
      return {
        gate: g,
        'gold fails': fails(goldPairs).length,
        'gold SOLE blocker (pure loss)': sole(goldPairs).length,
        'silver fails': fails(silverPairs).length,
        'silver SOLE blocker': sole(silverPairs).length,
      };
    }),
  );

  console.log('\n=== Example misses (up to 5 per class, gold preferred) ===');
  for (const cls of classes.slice(1)) {
    const ex = [...goldPairs, ...silverPairs].filter((p) => p.cls === cls).slice(0, 5);
    if (ex.length === 0) continue;
    console.log(`-- ${cls}:`);
    for (const p of ex) {
      console.log(
        `   pe ${p.pe_a} ↔ ${p.pe_b} [${p.src}] dist=${p.distance?.toFixed(4) ?? 'NULL'}` +
        `${(p.failingGates ?? []).length ? ` gates=[${p.failingGates!.join(',')}]` : ''}` +
        `${p.rescuedByFallback ? ' (RESCUED by market fallback)' : ''}\n` +
        `      A: ${(p.title_a ?? '').slice(0, 80)}\n      B: ${(p.title_b ?? '').slice(0, 80)}`,
      );
    }
  }

  const goldReport = tiers[0];
  const goldCombinedRecall = goldReport.usable === 0 ? 0 : goldReport.combined / goldReport.usable;
  console.log(`\nGOLD combined Stage-3a recall@${K} (corruption-excluded): ${(100 * goldCombinedRecall).toFixed(2)}%`);
  if (ASSERT_MIN_RECALL !== undefined) {
    const min = parseFloat(ASSERT_MIN_RECALL);
    if (!(goldCombinedRecall >= min)) {
      console.error(`FAIL: gold combined recall ${(100 * goldCombinedRecall).toFixed(2)}% < required ${(100 * min).toFixed(2)}%`);
      process.exitCode = 1;
    } else {
      console.log(`OK: gold combined recall ≥ ${(100 * min).toFixed(2)}%`);
    }
  }
}

const isMain =
  process.argv[1] != null &&
  import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  main()
    .catch((err) => {
      log.error('fatal:', err);
      process.exitCode = 1;
    })
    .finally(() => endPool());
}
