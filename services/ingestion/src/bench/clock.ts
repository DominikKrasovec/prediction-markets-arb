/**
 * Minimal SNTP (RFC 4330) offset probe — copied from geo-compare/clock.ts so
 * this harness stays self-contained (no cross-service import).
 *
 * Returns the local-clock offset to true time in **milliseconds** (positive ⇒
 * local clock is BEHIND true time; add it to local time to approximate true
 * time). Used to skew-correct new-market *detection latency*
 * (`(localRecv + offset) - serverCreationTs`) so the number is comparable across
 * machines. Never throws — resolves `null` on any failure, so detection latency
 * gracefully degrades to "uncorrected / unavailable".
 */

import { createSocket } from 'node:dgram';

const NTP_UNIX_EPOCH_DELTA_SEC = 2_208_988_800;
const TWO_POW_32 = 4_294_967_296;

function readNtpTimestampMs(buf: Buffer, offset: number): number {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  if (seconds === 0 && fraction === 0) return 0;
  const unixSeconds = seconds - NTP_UNIX_EPOCH_DELTA_SEC;
  return unixSeconds * 1000 + (fraction / TWO_POW_32) * 1000;
}

export async function measureSntpOffset(
  server = 'pool.ntp.org',
  timeoutMs = 3000,
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const socket = createSocket('udp4');

    const finish = (result: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket.removeAllListeners();
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    socket.on('error', () => finish(null));
    socket.on('message', (msg: Buffer) => {
      const t3 = Date.now();
      try {
        if (msg.length < 48) return finish(null);
        const t1 = readNtpTimestampMs(msg, 32);
        const t2 = readNtpTimestampMs(msg, 40);
        if (t1 === 0 || t2 === 0) return finish(null);
        const offset = ((t1 - t0) + (t2 - t3)) / 2;
        if (!Number.isFinite(offset)) return finish(null);
        finish(offset);
      } catch {
        finish(null);
      }
    });

    const packet = Buffer.alloc(48);
    packet[0] = 0x23; // LI=0, VN=4, Mode=3 (client)

    let t0 = Date.now();
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      t0 = Date.now();
      socket.send(packet, 0, packet.length, 123, server, (err) => {
        if (err) finish(null);
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * Scan a discovery payload for a plausible server timestamp and return
 * `{ epochMs, field }`, or `{ epochMs: null }` if none found.
 *
 * The lifecycle payloads don't document a single canonical timestamp field, so
 * we probe a priority-ordered list of known/likely fields and accept the first
 * that parses to a sane epoch (numeric s/ms, or ISO string). The list is chosen
 * by `kind`:
 *   - `created`  → creation-time fields (when the market was listed);
 *   - `resolved` → settlement/resolution-time fields (when it was decided).
 * The generic frame timestamp (`ts`/`timestamp`/`time`) is the last resort for
 * both — it marks when the platform emitted the frame, a tight upper bound on
 * the true event time.
 */
const CREATED_TS_FIELDS = [
  // True creation fields only. NOT open_ts/open_time — those are the *scheduled
  // open* (often in the future, e.g. Kalshi candle/temp markets), which is not
  // the creation moment and would yield a negative detection latency.
  'created_ts', 'created_time', 'createdAt', 'created_at', 'create_time',
  'publishedAt', 'published_at',
  'server_time', 'serverTime', 'ts', 'timestamp', 'time',
];

const RESOLVED_TS_FIELDS = [
  // Kalshi settle/determine frames use *_ts; PM/Limitless use *Date / *_time.
  'settlement_timestamp', 'settlement_ts', 'settled_ts', 'settled_time', 'settledAt',
  'determination_ts', 'determined_ts', 'determination_time', 'determined_time',
  'resolved_time', 'resolvedAt', 'resolution_time', 'resolutionDate', 'resolution_date',
  'closedTime', 'close_time', 'closeTime', 'closed_time',
  'expiration_time', 'expirationDate', 'endDate', 'end_date',
  'server_time', 'serverTime', 'ts', 'timestamp', 'time',
];

export function extractServerTs(
  payload: unknown,
  kind: 'created' | 'resolved' = 'created',
): { epochMs: number | null; field: string | null } {
  if (!payload || typeof payload !== 'object') return { epochMs: null, field: null };
  const obj = payload as Record<string, unknown>;
  const fields = kind === 'resolved' ? RESOLVED_TS_FIELDS : CREATED_TS_FIELDS;
  for (const f of fields) {
    if (!(f in obj)) continue;
    const epochMs = toEpochMs(obj[f]);
    if (epochMs !== null) return { epochMs, field: f };
  }
  return { epochMs: null, field: null };
}

/** Coerce a numeric (s or ms) or ISO-string value to epoch-ms, else null. */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Heuristic: < 1e12 ⇒ seconds, else ms. (1e12 ms ≈ 2001; 1e12 s ≈ 33658.)
    const ms = v < 1e12 ? v * 1000 : v;
    return sane(ms) ? ms : null;
  }
  if (typeof v === 'string') {
    const num = Number(v);
    if (Number.isFinite(num) && v.trim() !== '') return toEpochMs(num);
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) && sane(parsed) ? parsed : null;
  }
  return null;
}

/** Reject epochs outside [2015, 2035] — guards against unit/field misreads. */
function sane(ms: number): boolean {
  return ms > 1_420_000_000_000 && ms < 2_050_000_000_000;
}
