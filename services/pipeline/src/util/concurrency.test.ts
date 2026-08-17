/**
 * Pure unit tests for `keyedSerialize` (services/pipeline/src/util/concurrency.ts)
 * — the keyed async-mutex that serialises same-fold entity registrations so the
 * concurrent-burst diacritic/despace fork race cannot fire.
 *
 * No DB, no I/O — drives the primitive with fake async fns + manual deferrals so
 * the FIFO-per-key ordering, the run-EVERY-fn (not coalesce) contract, the
 * onQueued-only-on-wait signal, the rejection-doesn't-starve-the-queue property,
 * and the chain drain (no map leak) are all pinned deterministically.
 */
import { describe, test, expect } from 'bun:test';
import { keyedSerialize, _keyedSerializeChainCount } from './concurrency.js';

/** A promise you can resolve/reject from the outside. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('keyedSerialize — FIFO serialisation per key', () => {
  test('same key runs sequentially (2nd fn starts only after 1st settles)', async () => {
    const order: string[] = [];
    const d1 = deferred<number>();

    const p1 = keyedSerialize('k', async () => {
      order.push('1-start');
      const v = await d1.promise;
      order.push('1-end');
      return v;
    });
    const p2 = keyedSerialize('k', async () => {
      // This MUST NOT start until fn1 has ended.
      order.push('2-start');
      order.push('2-end');
      return 2;
    });

    await tick();
    // fn1 has started and is parked on d1; fn2 must NOT have started yet.
    expect(order).toEqual(['1-start']);

    d1.resolve(1);
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  test('runs EVERY fn (does NOT coalesce like singleFlight): both spellings processed', async () => {
    // The key correctness property vs singleFlight: caller 2 must run its OWN fn
    // (so the 2nd spelling gets registered/bridged), not receive caller 1's result.
    let runs = 0;
    const r1 = await keyedSerialize('k', async () => { runs++; return 'a'; });
    const r2 = await keyedSerialize('k', async () => { runs++; return 'b'; });
    expect(runs).toBe(2);
    expect(r1).toBe('a');
    expect(r2).toBe('b');
  });

  test('different keys run concurrently (no cross-key blocking)', async () => {
    const order: string[] = [];
    const dA = deferred<void>();
    const pA = keyedSerialize('A', async () => { order.push('A-start'); await dA.promise; order.push('A-end'); });
    const pB = keyedSerialize('B', async () => { order.push('B-start'); order.push('B-end'); });
    await tick();
    // B is on a different key, so it ran while A is parked.
    expect(order).toContain('B-start');
    expect(order).toContain('B-end');
    expect(order).not.toContain('A-end');
    dA.resolve();
    await Promise.all([pA, pB]);
  });

  test('onQueued fires ONLY when a call had to wait behind an in-flight same-key chain', async () => {
    const queued: number[] = [];
    const d1 = deferred<void>();

    // First caller does NOT wait → onQueued must NOT fire.
    const p1 = keyedSerialize('k', async () => { await d1.promise; }, () => queued.push(1));
    await tick();
    expect(queued).toEqual([]);

    // Second caller arrives while the first is in flight → onQueued fires (sync).
    const p2 = keyedSerialize('k', async () => { /* noop */ }, () => queued.push(2));
    expect(queued).toEqual([2]);

    d1.resolve();
    await Promise.all([p1, p2]);
  });

  test('a rejected fn does NOT starve the queue: the next waiter still runs', async () => {
    const order: string[] = [];
    const p1 = keyedSerialize('k', async () => { order.push('1'); throw new Error('boom'); });
    const p2 = keyedSerialize('k', async () => { order.push('2'); return 'ok'; });

    // fn1's rejection propagates to ITS caller only.
    await expect(p1).rejects.toThrow('boom');
    // fn2 still ran and resolved normally.
    expect(await p2).toBe('ok');
    expect(order).toEqual(['1', '2']);
  });

  test('chain drains: the key map does not leak after all work settles', async () => {
    const before = _keyedSerializeChainCount();
    await keyedSerialize('drain-key-1', async () => 1);
    await keyedSerialize('drain-key-1', async () => 2);
    // Give the drain microtask/.then a turn to delete the settled key.
    await tick();
    expect(_keyedSerializeChainCount()).toBe(before);
  });
});
