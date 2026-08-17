/**
 * Limitless Market Lifecycle WebSocket Listener
 *
 * Limitless Exchange uses Socket.IO v4.  This module uses socket.io-client
 * (consistent with clob/limitless/websocket.ts and the official docs).
 *
 * Endpoint: wss://ws.limitless.exchange/markets
 * Namespace: root (/)
 *
 * On connect → emit `subscribe_market_lifecycle`
 * On `marketCreated`  → save to `limitless_markets` via dbService
 * On `marketResolved` → write resolution to `markets` table
 * On disconnect       → records gap; refillCallback(gapSince) on reconnect.
 *
 * Circuit breaker: after CIRCUIT_OPEN_THRESHOLD consecutive failures the
 * reconnection delay is clamped to CIRCUIT_OPEN_DELAY_MS (5 min) so we do
 * not hammer the server when it is in a prolonged outage.
 */

import { io, Socket } from 'socket.io-client';
import { BaseLifecycleWatcher, type RefillCallback, type LifecycleEventCallback } from './base-watcher.js';
import { dbService } from '../scrapers/limitless/postgres.js';
import { fetchMarketBySlug } from '../scrapers/limitless/api-client.js';
import { writeAndPublishResolution, coerceResolvedAt } from '@arb/resolution-write';

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL = process.env.LIMITLESS_WS_URL
  ? `${process.env.LIMITLESS_WS_URL}/markets`
  : 'wss://ws.limitless.exchange/markets';

// socket.io-client built-in reconnect params
const RECONNECT_DELAY_MS     = 1_000;
const RECONNECT_DELAY_MAX_MS = 60_000; // 1 min normal cap

// Circuit breaker: after this many consecutive connect_error events, slow down
const CIRCUIT_OPEN_THRESHOLD = 10;
const CIRCUIT_OPEN_DELAY_MS  = 5 * 60_000; // 5 min when open

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Watcher class ────────────────────────────────────────────────────────────

export class LimitlessLifecycleWatcher extends BaseLifecycleWatcher {
  private socket: Socket | null = null;
  private circuitOpenTimeout: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;
  private circuitOpen = false;

  constructor(
    refillCallback: RefillCallback | null = null,
    verbose = false,
    onEvent: LifecycleEventCallback | null = null,
  ) {
    super('lifecycle:limitless', refillCallback, verbose, onEvent);
  }

  protected isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  connect(): Promise<void> {
    if (this.socket?.connected) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const apiKey = process.env.LIMITLESS_API_KEY;
      const opts: Parameters<typeof io>[1] = {
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: RECONNECT_DELAY_MS,
        reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
        reconnectionAttempts: Infinity,
        timeout: 15_000,
      };
      if (apiKey) {
        (opts as any).extraHeaders = { 'X-API-Key': apiKey };
      }

      this.logState(`Connecting to ${WS_URL}...`);
      this.socket = io(WS_URL, opts);

      // Resolve/reject only for the initial connection attempt
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };

      this.socket.once('connect', () => settle());
      this.socket.once('connect_error', (err: Error) => settle(err));

      this.socket.on('connect', () => {
        this.consecutiveErrors = 0;
        this.circuitOpen = false;
        if (this.circuitOpenTimeout) {
          clearTimeout(this.circuitOpenTimeout);
          this.circuitOpenTimeout = null;
        }
        this.logState(
          `Connected${this.reconnectCount > 0 ? ` (reconnect #${this.reconnectCount})` : ''} -- subscribing to market_lifecycle`,
        );
        this.socket!.emit('subscribe_market_lifecycle');
        this.handleReconnectRefill();
      });

      this.socket.on('disconnect', (reason: string) => {
        this.disconnectedAt ??= new Date();
        this.logState(`Disconnected (reason=${reason})`);
      });

      this.socket.on('reconnect', (attemptNumber: number) => {
        this.reconnectCount++;
        this.log(`Reconnected after ${attemptNumber} attempt(s)`);
      });

      this.socket.on('reconnect_attempt', (attemptNumber: number) => {
        this.reconnectCount = Math.max(this.reconnectCount, attemptNumber);
        this.logState(
          `Reconnecting in ${this.circuitOpen ? CIRCUIT_OPEN_DELAY_MS / 1000 + 's (circuit open)' : 'backoff'}... (attempt ${attemptNumber})`,
        );
      });

      this.socket.on('connect_error', (err: Error) => {
        this.consecutiveErrors++;
        this.log(`WS error: ${err.message}`, true);

        // Open circuit after threshold to avoid IP rate limiting
        if (this.consecutiveErrors >= CIRCUIT_OPEN_THRESHOLD && !this.circuitOpen) {
          this.circuitOpen = true;
          this.logState(
            `Circuit open after ${this.consecutiveErrors} consecutive failures -- slowing reconnects to ${CIRCUIT_OPEN_DELAY_MS / 1000}s`,
          );
          this.socket!.io.reconnectionDelayMax(CIRCUIT_OPEN_DELAY_MS);
        }
      });

      this.socket.on('system', (msg: any) => {
        this.log(`System: ${JSON.stringify(msg)}`);
      });

      this.socket.on('exception', (err: any) => {
        this.log(`Exception: ${JSON.stringify(err)}`, true);
      });

      this.socket.on('marketCreated', (data: any) => {
        this.messagesReceived++;
        this.handleMarketCreated(data).catch((err: Error) =>
          this.log(`handleMarketCreated error: ${err.message}`, true));
      });

      this.socket.on('marketResolved', (data: any) => {
        this.messagesReceived++;
        this.handleMarketResolved(data).catch((err: Error) =>
          this.log(`handleMarketResolved error: ${err.message}`, true));
      });
    });
  }

  disconnect(): void {
    if (this.circuitOpenTimeout) { clearTimeout(this.circuitOpenTimeout); this.circuitOpenTimeout = null; }
    this.socket?.disconnect();
    this.socket = null;
    // Reset session counters so a subsequent connect() starts a fresh stats window.
    this.reconnectCount = 0;
    this.consecutiveErrors = 0;
    this.circuitOpen = false;
    this.disconnectedAt = null;
  }

  // ─── Private: event handlers ──────────────────────────────────────────────

  private async handleMarketCreated(data: any): Promise<void> {
    const slug: string = data?.slug ?? '';
    if (!slug) return;

    this.log(`Market created: ${slug} -- ${data?.title ?? ''}`);

    // The WSS marketCreated frame is a STUB (slug / title / type / categoryIds /
    // createdAt) — it lacks conditionId, tokens, prices and expirationTimestamp,
    // so saving it verbatim yields a normalization-blind row (conditionId NULL)
    // until the hourly REST scrape. Fetch the full market by slug so the saved
    // row is complete + tradeable immediately. Best-effort: on failure fall back
    // to the stub frame so a transient REST error never drops the detection.
    let full: any = null;
    try {
      full = await fetchMarketBySlug(slug);
    } catch (err: any) {
      this.log(`fetchMarketBySlug(${slug}) failed: ${err?.message ?? err}`, true);
    }

    await dbService.saveMarkets([
      full ?? {
        slug,
        address: data.address ?? null,
        conditionId: data.conditionId ?? null,
        tradeType: data.type === 'CLOB' ? 'clob'
          : typeof data.type === 'string' ? data.type.toLowerCase()
          : null,
        status: 'FUNDED',
        expired: false,
        expirationTimestamp: data.endDate ?? data.expirationDate ?? null,
        volume: '0',
        // Spread remaining fields so the raw column captures everything
        ...data,
      },
    ]);

    this.marketsCreated++;
    this.onEvent?.('created');
  }

  private async handleMarketResolved(data: any): Promise<void> {
    const slug: string = data?.slug ?? '';
    if (!slug) return;

    const winning: string | null = data?.winningOutcome ?? null;
    const { resolvedAt } = coerceResolvedAt(data?.resolutionDate, `limitless/wss ${slug}`);

    this.log(`Market resolved: ${slug} -> ${winning ?? 'unknown'}`);

    const { outcome } = await writeAndPublishResolution({
      platform: 'limitless',
      platformId: slug,
      winning,
      resolvedAt,
      source: 'limitless/wss',
    });

    if (outcome === 'created') {
      this.marketsResolved++;
      this.onEvent?.('resolved');
    } else if (outcome === 'amended') {
      this.log(`Market ${slug}: amended missing winner (${winning ?? 'still null'})`);
    }
  }

}
