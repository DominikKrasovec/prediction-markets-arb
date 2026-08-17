import type { Platform } from '@arb/types';

/**
 * geo-compare instrumentation contract.
 *
 * Additive, zero-behavior-change instrumentation emitted by the production CLOB
 * adapters. The geo-compare harness (`GeoMetrics`/`GeoSink`) registers callbacks
 * via `ClobManager.onInstrumentation` / `BaseClobAdapter.onInstrumentation`; when
 * no callback is registered the adapters emit nothing (no-op fast path).
 *
 * Two event families:
 *   - {@link LifecycleEvent}  — connection-lifecycle timing (connect → first msg).
 *   - {@link ReliabilityEvent} — connect/disconnect/error/heartbeat/resolution.
 *
 * Both carry `t = Date.now()` (wall clock) and `hr = hrNowMs()` (sub-ms hrtime),
 * so the harness can compute sub-ms intervals (e.g. connect_start → ws_open) from
 * the monotonic `hr` while keeping a wall-clock anchor for cross-machine diffing.
 */

export type LifecyclePhase =
  | 'connect_start'
  | 'ws_open'
  | 'subscribe_sent'
  | 'first_message'
  | 'close'
  | 'reconnect_scheduled';

export type ReliabilityKind =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'reconnect'
  | 'heartbeat_in'
  | 'heartbeat_out'
  | 'resolution';

export interface LifecycleEvent {
  type: 'lifecycle';
  platform: Platform;
  phase: LifecyclePhase;
  /** Wall-clock ms (`Date.now()`). */
  t: number;
  /** Monotonic sub-ms timestamp (`hrNowMs()`). */
  hr: number;
  /** Per-adapter connection counter (++ at each connect_start). */
  connId: number;
  /** Optional context, e.g. subscription count or close reason. */
  detail?: string;
}

export interface ReliabilityEvent {
  type: 'reliability';
  platform: Platform;
  kind: ReliabilityKind;
  /** Wall-clock ms (`Date.now()`). */
  t: number;
  /** Monotonic sub-ms timestamp (`hrNowMs()`). */
  hr: number;
  /** Per-adapter connection counter when known. */
  connId?: number;
  /** Optional context (truncated ≤200 chars by the emitter). */
  detail?: string;
}

export type InstrEvent = LifecycleEvent | ReliabilityEvent;

/**
 * Sub-ms monotonic clock in milliseconds. `process.hrtime.bigint()` returns
 * nanoseconds as a BigInt monotonic counter; dividing by 1e6 yields fractional
 * milliseconds. Use for interval math only (no wall-clock meaning).
 */
export function hrNowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}
