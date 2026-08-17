import { getUnfeaturizedMarketsWithGroups } from '../db/queries/markets.js';
import { bulkInsertMarketFeatures } from '../db/queries/features.js';
import { backfillStage1Queue, getStage1QueueStats } from '../db/queries/stage1-queue.js';
import { enqueueStage23 } from '../db/queries/stage23-queue.js';
import type { SyncedMarket, MarketFeatures } from '@arb/types';
import { createLogger } from '@arb/logger';
import { extractDates, extractNumbers, extractCurrencies } from './entity-extractor.js';
import { detectHierarchy, detectConditionSignals } from './hierarchy-detector.js';
import { normalizeTextDeterministicBatch } from './text-deterministic.js';
import { embedAllMarkets, embeddingDoneSql } from './embedder.js';
import { config } from '../config.js';
import { query } from '@arb/db';
import { runEntityEnrichmentWorkers } from '../entity-enrichment/index.js';
import { warmKBCache, consumeNewEntityCount, loadStructuralSignalsIndex } from '../db/entity-registry.js';
import { foldAscii } from '../db/entity/tokens.js';

const log = createLogger('stage1');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them',
  'their', 'what', 'which', 'who', 'whom', 'when', 'where', 'why',
  'how', 'not', 'no', 'nor', 'if', 'then', 'else', 'so', 'up',
  'out', 'about', 'into', 'over', 'after', 'before', 'between',
  'under', 'again', 'further', 'once', 'here', 'there', 'all',
  'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'than', 'too', 'very', 'just', 'also',
]);
const MARKET_STOP_WORDS = new Set([
  'will', 'market', 'resolves', 'resolve', 'yes', 'no', 'binary',
  'prediction', 'bet', 'wager', 'outcome',
]);

function stripPunctuation(text: string): string {
  // foldAscii FIRST: JS `\w` (no `u` flag) is ASCII-only, so accented letters
  // would otherwise get replaced by a space, fragmenting word-bag/n-gram
  // similarity against the ASCII spelling.
  return foldAscii(text)
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[^\w\s\-'.,$%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(title: string): string {
  return stripPunctuation(title.toLowerCase()).trim();
}

function extractWordBag(text: string): string[] {
  const normalized = normalizeTitle(text);
  const words = normalized
    .split(/[\s\-_]+/)
    .filter((w) => w.length > 1)
    .filter((w) => !STOP_WORDS.has(w))
    .filter((w) => !MARKET_STOP_WORDS.has(w));
  return [...new Set(words)].sort();
}

function charNgrams(text: string, n: number): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length < n) return [normalized];
  const ngrams: string[] = [];
  for (let i = 0; i <= normalized.length - n; i++) {
    ngrams.push(normalized.slice(i, i + n));
  }
  return ngrams;
}

function fingerprint(normalizedTitle: string): { bigrams: Set<string>; trigrams: Set<string> } {
  return {
    bigrams: new Set(charNgrams(normalizedTitle, 2)),
    trigrams: new Set(charNgrams(normalizedTitle, 3)),
  };
}

const NEW_ENTITY_FLUSH_THRESHOLD = config.stage1.newEntityFlushThreshold;
const MARKETS_FLUSH_INTERVAL = config.stage1.marketsFlushInterval;

// Stage 1: per batch, regex-featurize then deterministic-template-normalize;
// periodically flush entity enrichment. After the loop, embed all markets.
// Template-miss markets carry no normalization row — deferred to Stage 3b
// leg mapping, not an LLM fallback.
export async function runStage1(): Promise<{ featurized: number; textDetNormalized: number; llmNormalized: number; embedded: number; queueStats: { pending: number; processing: number; done: number; failed: number }; newMarketIds: number[] }> {
  const backfilled = await backfillStage1Queue();
  if (backfilled > 0) {
    log.info(`Backfilled ${backfilled} markets into stage1_queue`);
  }

  let totalFeaturized = 0;
  let textDetCount = 0;
  let embedCount = 0;

  await warmKBCache();
  consumeNewEntityCount();

  // Without this, isCrossLeague always returns false, so cross-league team
  // entities get stamped with a league_canonical that collides with a
  // sibling market's scope-NULL canonical on the unique constraint.
  await loadStructuralSignalsIndex();

  let midRunNewEntities = 0;
  let lastFlushAt = 0;
  let flushCount = 0;

  const batchTimingLog = createLogger('stage1-timing');
  while (true) {
    const batchStart = Date.now();
    const fetchStart = Date.now();
    const batch = await getUnfeaturizedMarketsWithGroups(config.batchSize);
    const fetchMs = Date.now() - fetchStart;
    if (batch.length === 0) break;

    if (
      totalFeaturized === 0 ||
      Math.floor(totalFeaturized / 5000) < Math.floor((totalFeaturized + batch.length) / 5000)
    ) {
      log.info(`1a featurizing... ${totalFeaturized + batch.length} done`);
    }

    const featurizeStart = Date.now();
    const featuresBatch = batch.map((m) => featurizeMarket(m, m));
    const featurizeMs = Date.now() - featurizeStart;

    const insertStart = Date.now();
    await bulkInsertMarketFeatures(featuresBatch);
    const insertMs = Date.now() - insertStart;
    totalFeaturized += batch.length;

    const batchIds = batch.map((m) => m.id);

    // llm_market_normalizations now holds deterministic-template results only
    // (table name predates the rewire).
    const textDetStart = Date.now();
    const normalizedIds = await normalizeTextDeterministicBatch(batchIds);
    const textDetMs = Date.now() - textDetStart;
    textDetCount += normalizedIds.size;

    let flushMs = 0;
    if (!config.stage1.entityEnrichmentSkip) {
      midRunNewEntities += consumeNewEntityCount();
      const hitEntityThreshold =
        config.stage1.newEntityFlushThreshold > 0 &&
        midRunNewEntities >= config.stage1.newEntityFlushThreshold;
      const hitMarketInterval =
        config.stage1.marketsFlushInterval > 0 &&
        totalFeaturized - lastFlushAt >= config.stage1.marketsFlushInterval;
      if (hitEntityThreshold || hitMarketInterval) {
        const reason = hitEntityThreshold
          ? `${midRunNewEntities} new entities`
          : `${totalFeaturized - lastFlushAt} markets since last flush`;
        log.info(`Mid-run enrichment flush (${reason})`);
        const flushStart = Date.now();
        // Blocking: the next batch only starts once the KB cache is re-warmed,
        // so subsequent markets resolve against fresh entity metadata.
        await runEntityEnrichmentWorkers({ drainAndExit: true });
        await warmKBCache();
        flushMs = Date.now() - flushStart;
        flushCount++;
        consumeNewEntityCount();
        midRunNewEntities = 0;
        lastFlushAt = totalFeaturized;
      }
    }

    const totalMs = Date.now() - batchStart;
    const line =
      `batch n=${batch.length} fetch=${fetchMs}ms featurize=${featurizeMs}ms ` +
      `insert=${insertMs}ms textDet=${textDetMs}ms (matched=${normalizedIds.size}) ` +
      `flush=${flushMs}ms (flushes=${flushCount}) ` +
      `total=${totalMs}ms (cumulative ${totalFeaturized})`;
    if (totalMs > 5000) batchTimingLog.info(line);
    else                 batchTimingLog.debug(line);
  }

  if (totalFeaturized > 0) {
    log.info(`1a: Featurized ${totalFeaturized} markets (regex pass)`);
  }
  if (textDetCount > 0) {
    log.info(`1b: Deterministic template normalization: ${textDetCount} markets`);
  }

  embedCount = await embedAllMarkets();
  if (embedCount > 0) {
    log.info(`1c: Embedded ${embedCount} markets`);
  }

  const { rowCount: closed, marketIds: completedMarketIds } = await markCompletedQueueRows();
  if (closed > 0) {
    log.info(`Marked ${closed} queue rows done`);
  }

  await enqueueStage23(completedMarketIds);

  const queueStats = await getStage1QueueStats();
  return {
    featurized: totalFeaturized,
    textDetNormalized: textDetCount,
    llmNormalized: 0, // LLM normalization removed; kept for interface/caller compat
    embedded: embedCount,
    queueStats,
    newMarketIds: completedMarketIds,
  };
}

// Pure: no I/O, no LLM.
export function featurizeMarket(
  market: SyncedMarket,
  platformGroup?: { platform_group_id: string | null; platform_cross_ref: string | null }
): MarketFeatures {
  const title = market.title;
  const description = market.description ?? '';

  const normalized = normalizeTitle(title);
  const wordBag = extractWordBag(title);
  const fp = fingerprint(normalized);

  const dates = extractDates(`${title} ${description}`, 'title');
  // market.end_date is intentionally NOT pushed as a deadline — it's often an
  // arbitrary resolution deadline, not the event date.
  const numbers = extractNumbers(`${title} ${description}`);
  const currencies = extractCurrencies(`${title} ${description}`);

  const hierarchy = detectHierarchy(title, description);
  const signals = detectConditionSignals(title, description);

  return {
    market_id: market.id,
    platform: market.platform,
    platform_id: market.platform_id,
    normalized_title: normalized,
    title_words: wordBag,
    title_bigrams: [...fp.bigrams],
    title_trigrams: [...fp.trigrams],
    dates,
    numbers,
    currencies,
    hierarchy_type: hierarchy?.hierarchy_type ?? null,
    hierarchy_value: hierarchy?.hierarchy_value ?? null,
    hierarchy_level: hierarchy?.hierarchy_level ?? null,
    platform_group_id: platformGroup?.platform_group_id ?? null,
    platform_cross_ref: platformGroup?.platform_cross_ref ?? null,
    outcome_space: 'binary', // dead column (no readers); constant satisfies the non-nullable type
    condition_shape: signals.condition_shape,
    condition_direction: signals.condition_direction,
    temporal_semantics: signals.temporal_semantics,
  };
}

if (process.argv[1]?.includes('stage1-normalize')) {
  runStage1()
    .then((n) => { log.info(`Done: ${n}`); process.exit(0); })
    .catch((err) => { log.error('fatal:', err); process.exit(1); });
}

// Idempotent. Does not mark rows for resolved markets — those stay pending
// (never claimed, since the worker only fetches resolved_at IS NULL markets);
// a janitor sweep can GC them later.
async function markCompletedQueueRows(): Promise<{ rowCount: number; marketIds: number[] }> {
  const rows = await query<{ market_id: number }>(
    `UPDATE stage1_queue q
     SET status = 'done', updated_at = NOW()
     WHERE q.status IN ('pending','processing')
       AND EXISTS (SELECT 1 FROM market_features mf WHERE mf.market_id = q.market_id)
       -- no llm_market_normalizations row required: template-miss markets
       -- legitimately carry none.
       AND EXISTS (
         SELECT 1 FROM markets m
           LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
          WHERE m.id = q.market_id
            AND ${embeddingDoneSql('m', 'n')}
       )
     RETURNING q.market_id`
  );
  return { rowCount: rows.length, marketIds: rows.map((r) => r.market_id) };
}

export { runStage1Workers } from './worker.js';
