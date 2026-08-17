/**
 * Pure unit tests for estimateCost — the cache-aware cost-telemetry fix.
 *
 * Background (post-run ambers investigation item 4 / worklog addendum 11): the
 * stored `llm_logs.cost_usd` over-counted DeepSeek V4-Flash by 4.57x. Two
 * defects: (1) the price constant `[0.27, 1.10]` had BOTH numbers wrong (real
 * miss-input 0.14 / output 0.28), and (2) `estimateCost` had no cache-hit tier
 * at all though 63.3% of run #231's input tokens were prompt-cache hits served
 * at $0.0028/M. The fix makes PRICING a cache-aware triple
 * [hitInput, missInput, output] and prices the per-call cacheHitTokens at the
 * hit rate. Recompute over the #231 window = $7.82 = the operator's actual
 * billing.
 *
 * These tests are pure (no DB, no network) — they import only estimateCost.
 */
import { describe, test, expect } from 'bun:test';
import { estimateCost } from './tracker.js';

describe('estimateCost — cache-aware DeepSeek pricing (cost_usd fix)', () => {
  const M = 1_000_000;

  test('cache-miss input + output priced at the corrected V4-Flash rates', () => {
    // 1M all-miss input + 1M output = 0.14 + 0.28 = $0.42
    expect(estimateCost('deepseek-v4-flash', M, M, 0)).toBeCloseTo(0.42, 9);
  });

  test('cache-hit tokens are priced at the discounted hit rate, not the miss rate', () => {
    // 1M input all cache-hit, no output → 1M * 0.0028 = $0.0028
    expect(estimateCost('deepseek-v4-flash', M, 0, M)).toBeCloseTo(0.0028, 9);
    // vs all-miss same shape = $0.14 — the hit tier is ~50x cheaper.
    expect(estimateCost('deepseek-v4-flash', M, 0, 0)).toBeCloseTo(0.14, 9);
  });

  test('mixed hit/miss splits input on the hit boundary (miss = input - hits)', () => {
    // 1M input, 600k cache-hit / 400k miss, 500k output
    const cost = estimateCost('deepseek-v4-flash', M, 500_000, 600_000);
    const expected = (600_000 * 0.0028 + 400_000 * 0.14 + 500_000 * 0.28) / M;
    expect(cost).toBeCloseTo(expected, 12);
  });

  test('the old [0.27, 1.10] constant is gone — output no longer 1.10/M', () => {
    // Under the buggy constant, 1M output alone cost $1.10; now it is $0.28.
    expect(estimateCost('deepseek-v4-flash', 0, M, 0)).toBeCloseTo(0.28, 9);
    expect(estimateCost('deepseek-v4-flash', 0, M, 0)).not.toBeCloseTo(1.10, 2);
  });

  test('#231 window recompute reproduces the $7.82 actual billing (4.57x correction)', () => {
    // Aggregates from llm_logs WHERE created_at::date='2026-06-12' AND
    // model='deepseek-v4-flash' (probe-postrun-ambers-cost*; verified live):
    //   calls 21,693 · input 82,662,814 · output 12,225,709 ·
    //   cacheHitTokens 52,297,856 · stored cost_usd $35.77.
    const inputTokens = 82_662_814;
    const outputTokens = 12_225_709;
    const cacheHitTokens = 52_297_856;
    const stored = 35.7672396800000024555;
    const recomputed = estimateCost('deepseek-v4-flash', inputTokens, outputTokens, cacheHitTokens);
    expect(recomputed).toBeCloseTo(7.82, 2);
    expect(stored / recomputed).toBeCloseTo(4.57, 1);
    // 63.3% of input was cache hits — the structural reason a blended single
    // input rate cannot be correct.
    expect(cacheHitTokens / inputTokens).toBeCloseTo(0.633, 2);
  });

  test('cacheHitTokens defaults to 0 — cache-less callers unaffected', () => {
    // Same model, no cache arg → all input at the miss rate.
    expect(estimateCost('deepseek-v4-flash', M, 0)).toBeCloseTo(0.14, 9);
  });

  test('cacheHitTokens is clamped to [0, inputTokens] (defensive)', () => {
    // Over-reported hits never make the bill negative or below the all-hit floor.
    expect(estimateCost('deepseek-v4-flash', M, 0, 5 * M)).toBeCloseTo(0.0028, 9);
    expect(estimateCost('deepseek-v4-flash', M, 0, -100)).toBeCloseTo(0.14, 9);
  });

  test('non-cache models: hit rate == miss rate, so cacheHitTokens is a no-op', () => {
    // gpt-5.4-nano has no cache tier — both input tiers are 0.20.
    expect(estimateCost('gpt-5.4-nano', M, M, 0)).toBeCloseTo((0.20 + 1.25) / 1, 9);
    expect(estimateCost('gpt-5.4-nano', M, M, M)).toBeCloseTo((0.20 + 1.25) / 1, 9);
  });

  test('embeddings price input only (zero output rate), local models are free', () => {
    expect(estimateCost('text-embedding-3-small', M, 0)).toBeCloseTo(0.02, 9);
    expect(estimateCost('text-embedding-3-large', M, 0)).toBeCloseTo(0.13, 9);
    // output rate is 0 for embeddings — output tokens never add cost.
    expect(estimateCost('text-embedding-3-small', M, M)).toBeCloseTo(0.02, 9);
    expect(estimateCost('gemma3:4b', M, M, M)).toBe(0);
  });

  test('unknown model falls back to a non-zero default (never silently free)', () => {
    // default triple [1.00, 1.00, 3.00]: 1M miss-input + 1M output = $4.00
    expect(estimateCost('some-unknown-model', M, M, 0)).toBeCloseTo(4.0, 9);
  });
});
