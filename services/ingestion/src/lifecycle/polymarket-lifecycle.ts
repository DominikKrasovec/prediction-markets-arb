/**
 * Polymarket Market Lifecycle WebSocket Listener
 *
 * Connects to wss://ws-subscriptions-clob.polymarket.com/ws/market and sends
 * a subscription with `custom_feature_enabled: true` to receive:
 *   - `new_market`      → newly deployed markets
 *   - `market_resolved` → resolved markets
 *
 * No authentication required (public endpoint).
 *
 * On `new_market`      → save to `polymarket_markets` via dbService
 * On `market_resolved` → write resolution to `markets` table
 * On disconnect        → records gap start; on reconnect triggers
 *                        caller-supplied refillCallback(gapSince).
 *
 * Keep-alive: send string "PING" every 5s (server replies "PONG").
 */

import WebSocket from 'ws';
import { BaseLifecycleWatcher, type RefillCallback, type LifecycleEventCallback } from './base-watcher.js';
import { dbService } from '../scrapers/polymarket/postgres.js';
import {
  writeAndPublishResolution,
  coerceResolvedAt,
  parseWinnerFromOutcomes,
} from '@arb/resolution-write';
import { ensurePolymarketEvent } from './event-backfill.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL_MS  = 5_000;
// Stale-socket watchdog: 45s ≈ 9 missed PING/PONG cycles at 5s cadence.
// Polymarket's text-frame "PING"/"PONG" replaces WS-level pings, so the
// watchdog must be tighter than Kalshi's 60s. Limitless leaves keep-alive
// to socket.io's transport-level heartbeat and so has no manual watchdog.
const STALE_TIMEOUT_MS  = 45_000;

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── Watcher class ────────────────────────────────────────────────────────────

export class PolymarketLifecycleWatcher extends BaseLifecycleWatcher {
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageTs = 0;

  constructor(
    refillCallback: RefillCallback | null = null,
    verbose = false,
    onEvent: LifecycleEventCallback | null = null,
  ) {
    super('lifecycle:polymarket', refillCallback, verbose, onEvent);
  }

  protected isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) { resolve(); return; }

      this.logState(`Connecting to ${WS_URL}…`);
      this.ws = new WebSocket(WS_URL);

      const connectTimeout = setTimeout(() => {
        reject(new Error('Polymarket lifecycle WS connection timeout (15s)'));
        this.ws?.terminate();
      }, 15_000);

      this.ws.on('open', () => {
        clearTimeout(connectTimeout);
        this.reconnectAttempts = 0;
        this.logState(`Connected ✓${this.reconnectCount > 0 ? ` (reconnect #${this.reconnectCount})` : ''} — sending lifecycle subscription`);

        // custom_feature_enabled=true activates new_market + market_resolved events
        this.ws!.send(JSON.stringify({
          assets_ids: [],
          type: 'market',
          custom_feature_enabled: true,
        }));

        this.startPingInterval();
        this.handleReconnectRefill();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.messagesReceived++;
        this.lastMessageTs = Date.now();
        const raw = data.toString();
        if (raw === 'PONG') return; // keepalive response — ignore
        try {
          // Polymarket can send newline-delimited JSON or a JSON array per frame
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              for (const item of parsed) this.handleMessage(item);
            } else {
              this.handleMessage(parsed);
            }
          }
        } catch { /* malformed message */ }
      });

      this.ws.on('close', (code, reason) => {
        this.stopPingInterval();
        this.disconnectedAt ??= new Date();
        this.logState(`Disconnected (code=${code}, reason=${reason.toString() || 'none'})`);
        if (this.shouldReconnect) this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        this.log(`WS error: ${err.message}`, true);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPingInterval();
    if (this.reconnectTimeout) { clearTimeout(this.reconnectTimeout); this.reconnectTimeout = null; }
    this.ws?.close(1000, 'intentional');
    this.ws = null;
    this.reconnectCount = 0;
    this.reconnectAttempts = 0;
    this.disconnectedAt = null;
  }

  // ─── Private: message routing ─────────────────────────────────────────────

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;

    const eventType: string = msg.event_type ?? msg.type ?? '';

    if (eventType === 'new_market') {
      this.handleNewMarket(msg).catch((err) =>
        this.log(`handleNewMarket error: ${err.message}`, true));
    } else if (eventType === 'market_resolved') {
      this.handleMarketResolved(msg).catch((err) =>
        this.log(`handleMarketResolved error: ${err.message}`, true));
    }
  }

  // ─── Private: event handlers ──────────────────────────────────────────────

  private async handleNewMarket(msg: any): Promise<void> {
    const conditionId: string = msg.condition_id ?? msg.conditionId ?? '';
    if (!conditionId) return;

    this.log(`New market: ${conditionId} — ${msg.question ?? msg.slug ?? ''}`);

    // The new_market frame has no top-level event_id/eventId, but it DOES carry
    // the parent event inline as `event_message.id` — read it from the frame
    // (no REST round-trip). Without it, ensurePolymarketEvent can't fire and the
    // parent polymarket_events row (category, tags[]) never lands until the
    // hourly scrape. Rare frames lacking event_message.id fall back to null →
    // category enrichment then lands on the next scrape, exactly as before.
    const eventId: string | null = msg.event_id ?? msg.eventId ?? msg.event_message?.id ?? null;

    // Ensure the parent polymarket_events row exists so
    // enrichMarketCategoriesFromEvents has `category` / `tags[]`. Cached so
    // siblings of the same event collapse to a single fetch.
    if (eventId) {
      await ensurePolymarketEvent(String(eventId));
    }

    // Map the WSS payload to the shape expected by polymarket dbService.saveMarkets.
    // The lifecycle event mirrors the Gamma REST market object.
    await dbService.saveMarkets([{
      conditionId,
      eventId,
      slug: msg.slug ?? null,
      active: true,
      closed: false,
      volumeNum: 0,
      ...msg,
    }]);

    this.marketsCreated++;
    this.onEvent?.('created');
  }

  private async handleMarketResolved(msg: any): Promise<void> {
    const conditionId: string = msg.condition_id ?? msg.conditionId ?? '';
    if (!conditionId) return;

    // Prefer explicit winning_outcome; fall back to robust parsing of
    // outcomePrices (handles float imprecision and rejects ambiguous resolutions).
    let winning: string | null = msg.winning_outcome ?? msg.outcome ?? null;
    if (!winning && msg.outcomePrices && msg.outcomes) {
      winning = parseWinnerFromOutcomes(msg.outcomes, msg.outcomePrices);
    }

    const tsCandidate = msg.resolved_time ?? msg.closedTime ?? msg.endDate;
    const { resolvedAt } = coerceResolvedAt(tsCandidate, `polymarket/wss ${conditionId}`);

    this.log(`Market resolved: ${conditionId} → ${winning ?? 'unknown'}`);

    const { outcome } = await writeAndPublishResolution({
      platform: 'polymarket',
      platformId: conditionId,
      winning,
      resolvedAt,
      source: 'polymarket/wss',
    });

    if (outcome === 'created') {
      this.marketsResolved++;
      this.onEvent?.('resolved');
    } else if (outcome === 'amended') {
      this.log(`Market ${conditionId}: amended missing winner (${winning ?? 'still null'})`);
    }
  }

  // ─── Private: connection lifecycle ───────────────────────────────────────

  private startPingInterval(): void {
    if (this.pingInterval) return;
    this.lastMessageTs = Date.now();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageTs > STALE_TIMEOUT_MS) {
        this.log(`No message for ${STALE_TIMEOUT_MS / 1000}s — forcing reconnect`, true);
        this.disconnectedAt ??= new Date();
        this.ws!.terminate();
        return;
      }
      this.ws.send('PING');
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

}
