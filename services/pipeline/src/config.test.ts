/**
 * Tests for config.ts — verifies every section's defaults and that no two
 * consumers can silently diverge by reading the same env var independently.
 */
import { describe, test, expect } from 'bun:test';
import { config } from './config.js';

describe('config.stage1', () => {
  test('newEntityFlushThreshold defaults to 1000', () => {
    // Only valid when NEW_ENTITY_FLUSH_THRESHOLD is not set in the test env.
    if (!process.env.NEW_ENTITY_FLUSH_THRESHOLD) {
      expect(config.stage1.newEntityFlushThreshold).toBe(1000);
    }
  });

  test('marketsFlushInterval defaults to 10000', () => {
    if (!process.env.MARKETS_FLUSH_INTERVAL) {
      expect(config.stage1.marketsFlushInterval).toBe(10000);
    }
  });

  test('newEntityFlushThreshold is a finite integer', () => {
    expect(Number.isFinite(config.stage1.newEntityFlushThreshold)).toBe(true);
    expect(Number.isInteger(config.stage1.newEntityFlushThreshold)).toBe(true);
  });

  test('marketsFlushInterval is a finite integer', () => {
    expect(Number.isFinite(config.stage1.marketsFlushInterval)).toBe(true);
    expect(Number.isInteger(config.stage1.marketsFlushInterval)).toBe(true);
  });

  test('entityEnrichmentSkip defaults to false', () => {
    // Three sites previously open-coded `process.env.X !== '1'`. The default
    // (skip OFF) must stay false so a missing env var means "run enrichment
    // normally", not "secretly skip enrichment".
    if (process.env.ENTITY_ENRICHMENT_SKIP !== '1') {
      expect(config.stage1.entityEnrichmentSkip).toBe(false);
    }
  });

  test('entityEnrichmentSkip is a boolean (never null/undefined)', () => {
    // The three readers do `if (!config.stage1.entityEnrichmentSkip)` which
    // would treat `null`/`undefined` as falsy too — but locking the type
    // here means a future refactor that accidentally drops the `=== '1'`
    // strict-equality (and starts returning `string | undefined`) fails
    // this test instead of silently disabling enrichment.
    expect(typeof config.stage1.entityEnrichmentSkip).toBe('boolean');
  });
});

describe('config.embedding (AUD-30)', () => {
  test('embedMarkets defaults to false (market-level embedding gated OFF)', () => {
    // The market-level ANN is retired; markets.embedding has no live reader.
    // The default must be OFF so a normal run pays zero OpenAI cost. A
    // missing/unset EMBED_MARKETS env must mean "do not embed", never "embed".
    if (process.env.EMBED_MARKETS !== '1') {
      expect(config.embedding.embedMarkets).toBe(false);
    }
  });

  test('embedMarkets is a strict boolean (never string|undefined)', () => {
    // Embedder/index gate on `if (!config.embedding.embedMarkets)`; locking the
    // type here means a refactor that drops the `=== '1'` strict-equality fails
    // this test instead of silently re-enabling embedding.
    expect(typeof config.embedding.embedMarkets).toBe('boolean');
  });

  test('skipParlayMarkets still present (live knob)', () => {
    expect(typeof config.embedding.skipParlayMarkets).toBe('boolean');
  });

  test('orphan embedding knobs removed from config', () => {
    // similarity / requireEntityOverlap / requireDateOverlap /
    // minEntityOverlapForEmbedding / annK have zero code readers
    // (ann-candidates.ts uses its own local ANN_K); this pins that they stay
    // absent.
    const e = config.embedding as Record<string, unknown>;
    expect('similarity' in e).toBe(false);
    expect('requireEntityOverlap' in e).toBe(false);
    expect('requireDateOverlap' in e).toBe(false);
    expect('minEntityOverlapForEmbedding' in e).toBe(false);
    expect('annK' in e).toBe(false);
  });
});

describe('config.llm', () => {
  test('implicationMinConfidence defaults to 0.70', () => {
    if (!process.env.LLM_IMPLICATION_MIN_CONFIDENCE) {
      expect(config.llm.implicationMinConfidence).toBeCloseTo(0.70, 5);
    }
  });

  test('implicationMinConfidence is between 0 and 1 inclusive', () => {
    expect(config.llm.implicationMinConfidence).toBeGreaterThanOrEqual(0);
    expect(config.llm.implicationMinConfidence).toBeLessThanOrEqual(1);
  });

  test('implicationMinConfidence is a finite number', () => {
    expect(Number.isFinite(config.llm.implicationMinConfidence)).toBe(true);
  });
});

describe('config section presence', () => {
  test('config.stage1 exists', () => {
    expect(config.stage1).toBeDefined();
  });

  test('config.llm exists', () => {
    expect(config.llm).toBeDefined();
  });

  test('config.arb.minEdgeConfidence and config.llm.implicationMinConfidence both default to 0.70', () => {
    // Both thresholds share the same conceptual default — document it here so
    // any divergence (e.g. arb changed to 0.8 but llm not) is immediately
    // visible in tests rather than silently hidden.
    if (
      !process.env.SOLVE_MIN_EDGE_CONFIDENCE &&
      !process.env.MIN_EDGE_CONFIDENCE &&
      !process.env.LLM_IMPLICATION_MIN_CONFIDENCE
    ) {
      expect(config.arb.minEdgeConfidence).toBeCloseTo(config.llm.implicationMinConfidence, 5);
    }
  });
});
