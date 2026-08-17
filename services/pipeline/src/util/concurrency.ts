/**
 * Run `fn` over each item of `items` with at most `limit` promises in-flight
 * at any time. Results are returned in input order. Errors reject the whole
 * batch (caller can wrap `fn` in try/catch for per-item tolerance).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const out = new Array<R>(n);
  if (n === 0) return out;
  const workers = Math.max(1, Math.min(limit, n));
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= n) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()));
  return out;
}

/**
 * Keyed async-mutex (per-key FIFO promise-chain) serialiser. Unlike
 * `singleFlight` (@arb/llm), which coalesces concurrent callers onto one
 * `fn` call, `keyedSerialize` runs every `fn`, one at a time per `key`:
 * caller N's `fn` starts only after caller N-1's promise settles (fulfilled
 * or rejected).
 *
 * `onQueued` fires synchronously only when this call had to wait behind an
 * in-flight chain for the same key.
 *
 * Per-process only; pair with a DB-level unique constraint or equivalent for
 * cross-process dedup. A rejected `fn` does not break the chain for the next
 * waiter; the rejection propagates only to its own caller.
 */
const _serializeChains = new Map<string, Promise<unknown>>();

export function keyedSerialize<T>(
  key: string,
  fn: () => Promise<T>,
  onQueued?: () => void,
): Promise<T> {
  const existing = _serializeChains.get(key);
  if (existing && onQueued) {
    try { onQueued(); } catch { /* logging must never break the chain */ }
  }
  // Absent predecessor → resolved root so the first caller runs immediately.
  const prevTail = existing ?? Promise.resolve();

  // `.then(run, run)` runs `fn` whether the predecessor fulfilled or
  // rejected, so one caller's failure never starves the queue.
  const run = (): Promise<T> => fn();
  const result = prevTail.then(run, run);

  // Non-rejecting tail so a failed `fn` does not poison the chain for the
  // next waiter.
  const tail = result.catch(() => undefined);
  _serializeChains.set(key, tail);

  // The identity check matters: a later keyedSerialize(key, ...) overwrites
  // the slot, and that newer chain must keep it.
  void tail.then(() => {
    if (_serializeChains.get(key) === tail) _serializeChains.delete(key);
  });

  return result;
}

/** Test-only: number of live keyed chains (for leak assertions). */
export function _keyedSerializeChainCount(): number {
  return _serializeChains.size;
}
