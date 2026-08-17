/**
 * ClobAdapter contract tests — parameterized over every adapter class.
 *
 * These tests are the **spec** for what every CLOB adapter must fulfill.
 *
 * Adding a new platform: add it to ADAPTER_CLASSES below. These tests
 * will automatically run against it. If any fails, the adapter is
 * non-conformant.
 *
 * What we test here (no network required):
 *   1. Interface shape conformance (start/stop/subscribe/unsubscribe/onPriceUpdate/onMarketResolved).
 *   2. `platform` field is a canonical Platform literal.
 *   3. Callbacks registered via `onPriceUpdate` and `onMarketResolved`
 *      are fanned out by the base class's `emit` / `emitResolution`
 *      helpers (verified by exercising the protected methods).
 *   4. `ResolutionEvent` payloads carry the adapter's `platform`.
 *
 * What we DO NOT test here:
 *   - WebSocket connection lifecycle (requires real WS server / mock).
 *   - Subscribe/unsubscribe idempotency (requires running adapter).
 */
import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import { BaseClobAdapter, type ClobAdapter, type ResolutionEvent } from './base.js';
import { PolymarketAdapter } from './polymarket.js';
import { PredictAdapter } from './predict.js';
import { LimitlessAdapter } from './limitless.js';
import { KalshiAdapter } from './kalshi.js';
import type { PriceUpdate } from '../price-cache.js';

const CANONICAL_PLATFORMS: ReadonlySet<Platform> = new Set([
  'kalshi', 'limitless', 'polymarket', 'predict',
]);

/**
 * Registry of every adapter class under contract test. This MUST mirror
 * the array constructed in ClobManager — if you add an adapter there,
 * add it here too (or extract a shared registry and import it). Mirrored
 * by hand for now because ClobManager constructs its array inside its
 * constructor, not as a module-level export.
 */
const ADAPTER_CLASSES: Array<new () => ClobAdapter> = [
  PolymarketAdapter,
  PredictAdapter,
  LimitlessAdapter,
  KalshiAdapter,
];

describe('ClobAdapter registry', () => {
  test('covers all 4 canonical platforms exactly once', () => {
    const platforms = ADAPTER_CLASSES.map((C) => new C().platform);
    expect(new Set(platforms).size).toBe(platforms.length); // no dupes
    for (const p of CANONICAL_PLATFORMS) {
      expect(platforms).toContain(p);
    }
  });
});

describe.each(ADAPTER_CLASSES.map((C) => {
  const instance = new C();
  return [instance.platform, instance];
}))('ClobAdapter contract: %s', (_label, adapter) => {
  test('extends BaseClobAdapter', () => {
    expect(adapter).toBeInstanceOf(BaseClobAdapter);
  });

  test('platform field is a canonical Platform literal', () => {
    expect(CANONICAL_PLATFORMS.has(adapter.platform)).toBe(true);
  });

  test('exposes start/subscribe/unsubscribe/stop as functions', () => {
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.subscribe).toBe('function');
    expect(typeof adapter.unsubscribe).toBe('function');
    expect(typeof adapter.stop).toBe('function');
  });

  test('exposes onPriceUpdate / onMarketResolved as functions', () => {
    expect(typeof adapter.onPriceUpdate).toBe('function');
    expect(typeof adapter.onMarketResolved).toBe('function');
  });

  test('onPriceUpdate fans out to N callbacks via base emit', () => {
    const received: PriceUpdate[] = [];
    const cb1 = (u: PriceUpdate) => { received.push(u); };
    const cb2 = (u: PriceUpdate) => { received.push(u); };
    adapter.onPriceUpdate(cb1);
    adapter.onPriceUpdate(cb2);

    // Use a typed escape hatch — `emit` is protected on BaseClobAdapter
    // but we need to verify the contract from outside.
    const escape = adapter as unknown as { emit: (u: PriceUpdate) => void };
    const update: PriceUpdate = {
      marketId: 1,
      platform: adapter.platform,
      bestBid: 0.5,
      bestAsk: 0.6,
      bidSize: 100,
      askSize: 100,
      timestamp: Date.now(),
    };
    escape.emit(update);
    expect(received).toHaveLength(2);
    expect(received[0]).toBe(update);
  });

  test('onMarketResolved fans out and preserves payload', () => {
    const received: ResolutionEvent[] = [];
    adapter.onMarketResolved((e) => received.push(e));

    const escape = adapter as unknown as { emitResolution: (e: ResolutionEvent) => void };
    const event: ResolutionEvent = {
      platform: adapter.platform,
      platformId: 'test-mkt',
      winningOutcome: 'Yes',
    };
    escape.emitResolution(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
    expect(received[0].platform).toBe(adapter.platform);
  });

  test('ResolutionEvent.winningOutcome can be null (ambiguous resolution)', () => {
    // Contract: adapters MUST allow null in winningOutcome — never invent
    // a default. The type permits it; tests assert the shape.
    const event: ResolutionEvent = {
      platform: adapter.platform,
      platformId: 'test-mkt',
      winningOutcome: null,
    };
    expect(event.winningOutcome).toBeNull();
  });

  test('emit before any callback registered is a no-op (does not throw)', () => {
    const fresh = new (adapter.constructor as new () => ClobAdapter)();
    const escape = fresh as unknown as { emit: (u: PriceUpdate) => void };
    expect(() => {
      escape.emit({
        marketId: 1,
        platform: fresh.platform,
        bestBid: 0,
        bestAsk: 0,
        bidSize: 0,
        askSize: 0,
        timestamp: 0,
      });
    }).not.toThrow();
  });
});
