/**
 * Kalshi Market Lifecycle WebSocket Listener
 *
 * Subscribes to the `market_lifecycle_v2` channel for real-time push
 * notifications about newly created and settled markets — no polling required.
 *
 * Requires: KALSHI_KEY_ID + (KALSHI_KEY_PEM | KALSHI_KEY_PATH) env vars.
 *
 * On `created`   event → save market to `kalshi_markets` via dbService
 * On `settled`   event → write resolution to `markets` table
 * On disconnect        → records gap start; on reconnect triggers the
 *                        caller-supplied refillCallback(gapSince) so a
 *                        targeted REST scrape fills any missed events.
 *
 * Authentication: RSA-PSS signed headers (same as REST/CLOB WS).
 */

import WebSocket from 'ws';
import { BaseLifecycleWatcher, type RefillCallback, type LifecycleEventCallback } from './base-watcher.js';
import { createAuthHeaders } from '@arb/kalshi-auth';
import { dbService } from '../scrapers/kalshi/postgres.js';
import { writeAndPublishResolution, coerceResolvedAt } from '@arb/resolution-write';
import { ensureKalshiEvent } from './event-backfill.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_PATH = '/trade-api/ws/v2';
const PING_INTERVAL_MS  = 10_000;
// Stale-socket watchdog: 60s ≈ 5 missed server heartbeats (Kalshi server
// frames every ~10s once subscribed). Polymarket uses 45s because its
// PING/PONG cadence is 5s (9 missed); Limitless leaves it to socket.io's
// own keep-alive. If no frame arrives in this window the TCP connection has
// silently died and we force a terminate → reconnect.
const STALE_TIMEOUT_MS  = 60_000;

/**
 * Kalshi market_ticker = event_ticker + '-' + strikeId, so dropping the final
 * '-' segment recovers the event ticker. Last-resort fallback inside
 * handleCreated when neither additional_metadata.event_ticker nor a top-level
 * event_ticker is present (created frames observed so far always carry the
 * former, so this rarely fires). handleSettled doesn't need it.
 */
function deriveKalshiEventTicker(marketTicker: string): string {
  const parts = marketTicker.split('-');
  return parts.length >= 3 ? parts.slice(0, -1).join('-') : marketTicker;
}

// ─── Watcher class ────────────────────────────────────────────────────────────

export class KalshiLifecycleWatcher extends BaseLifecycleWatcher {
  private ws: WebSocket | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private cmdId = 1;
  private lastMessageTs = 0;

  constructor(
    refillCallback: RefillCallback | null = null,
    verbose = false,
    onEvent: LifecycleEventCallback | null = null,
  ) {
    super('lifecycle:kalshi', refillCallback, verbose, onEvent);
  }

  protected isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) { resolve(); return; }

      const baseUrl = process.env.KALSHI_WS_URL ?? 'wss://api.elections.kalshi.com';
      // Avoid doubling the path if the env var already includes it
      const url = baseUrl.endsWith(WS_PATH) ? baseUrl : baseUrl + WS_PATH;

      let authHeaders: Record<string, string>;
      try {
        authHeaders = createAuthHeaders('GET', WS_PATH);
      } catch (err: any) {
        reject(new Error(`Kalshi lifecycle WS auth failed: ${err.message}`));
        return;
      }

      this.logState(`Connecting to ${url}…`);
      this.ws = new WebSocket(url, { headers: authHeaders });

      const connectTimeout = setTimeout(() => {
        reject(new Error('Kalshi lifecycle WS connection timeout (15s)'));
        this.ws?.terminate();
      }, 15_000);

      this.ws.on('open', () => {
        clearTimeout(connectTimeout);
        this.reconnectAttempts = 0;
        this.logState(`Connected ✓${this.reconnectCount > 0 ? ` (reconnect #${this.reconnectCount})` : ''} — subscribing to market_lifecycle_v2`);
        this.startPingInterval();
        this.sendSubscribe();
        this.handleReconnectRefill();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.messagesReceived++;
        this.lastMessageTs = Date.now();
        try {
          const env = JSON.parse(data.toString()) as { type: string; sid?: number; msg?: any };
          this.handleEnvelope(env);
        } catch { /* malformed message */ }
      });

      this.ws.on('pong', () => {
        this.lastMessageTs = Date.now(); // reset stale watchdog on heartbeat
      });

      this.ws.on('close', (code, reason) => {
        this.stopPingInterval();
        // Record first disconnect time (don't overwrite an existing gap start)
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
    // Reset session counters so a subsequent connect() starts a fresh stats window.
    this.reconnectCount = 0;
    this.reconnectAttempts = 0;
    this.disconnectedAt = null;
  }

  // ─── Private: subscribe ───────────────────────────────────────────────────

  private sendSubscribe(): void {
    const msg = {
      id: this.cmdId++,
      cmd: 'subscribe',
      params: { channels: ['market_lifecycle_v2'] },
    };
    this.ws?.send(JSON.stringify(msg));
    this.log('Subscription sent: market_lifecycle_v2 (global — no per-ticker list needed)');
  }

  // ─── Private: message routing ─────────────────────────────────────────────

  private handleEnvelope(env: { type: string; sid?: number; msg?: any }): void {
    if (env.type !== 'market_lifecycle_v2') return;
    const msg = env.msg;
    if (!msg) return;

    const eventType: string = msg.event_type ?? '';
    const ticker: string = msg.market_ticker ?? '';
    if (!ticker) return;

    if (eventType === 'created') {
      this.handleCreated(msg).catch((err) =>
        this.log(`handleCreated error (${ticker}): ${err.message}`, true));
    } else if (eventType === 'settled' || eventType === 'determined') {
      this.handleSettled(msg).catch((err) =>
        this.log(`handleSettled error (${ticker}): ${err.message}`, true));
    }
    // 'activated', 'deactivated', 'close_date_updated' etc. are informational;
    // we don't need to act on them here.
  }

  // ─── Private: event handlers ──────────────────────────────────────────────

  private async handleCreated(msg: any): Promise<void> {
    const ticker: string = msg.market_ticker;

    // The market_lifecycle_v2 'created' frame nests the market fields under
    // `additional_metadata` (top level carries only market_ticker / open_ts /
    // close_ts / event_type / price_level_structure). So event_ticker is NOT at
    // msg.event_ticker — read it from additional_metadata, falling back to the
    // top level and then to deriving it from the market ticker.
    const am = (msg.additional_metadata && typeof msg.additional_metadata === 'object')
      ? msg.additional_metadata : {};
    const eventTicker: string =
      (typeof am.event_ticker === 'string' && am.event_ticker) ? am.event_ticker :
      (typeof msg.event_ticker === 'string' && msg.event_ticker) ? msg.event_ticker :
      deriveKalshiEventTicker(ticker);
    this.log(`Market created: ${ticker} (event ${eventTicker})`);

    // Ensure the parent kalshi_events row exists so downstream
    // enrichMarketCategoriesFromEvents (category) and populatePlatformEvents
    // (event title) have proper inputs. One REST follow-up via the rate-limited
    // singleton client; idempotent + cached so sibling markets of the same
    // event collapse to one fetch.
    if (eventTicker) {
      await ensureKalshiEvent(eventTicker);
    }

    // Persist a FLAT raw blob: the Stage-1 normalizer and the platform-groups /
    // sync SQL read snake_case fields (event_ticker, strike_type, floor_strike,
    // custom_strike, rules_primary, yes_sub_title, …) from kalshi_markets.raw at
    // the TOP level. The WSS frame nests them under additional_metadata, so we
    // promote them here; the hourly REST scrape later overwrites raw with the
    // full API blob (this is the low-latency interim row, no longer a
    // normalization-blind stub with event_ticker='').
    const raw: Record<string, unknown> = { ...msg, ...am, ticker, event_ticker: eventTicker };
    delete raw.additional_metadata;

    await dbService.saveMarkets([{
      ticker,
      event_ticker: eventTicker,
      status: msg.status ?? 'open',
      yes_bid_dollars: msg.yes_bid != null ? String(msg.yes_bid) : undefined,
      yes_ask_dollars: msg.yes_ask != null ? String(msg.yes_ask) : undefined,
      volume_fp: '0',
      raw,
    } as any]);

    this.marketsCreated++;
    this.onEvent?.('created');
  }

  private async handleSettled(msg: any): Promise<void> {
    const ticker: string = msg.market_ticker;
    const result: string | undefined = msg.result;
    const winning = result === 'yes' ? 'Yes' : result === 'no' ? 'No' : null;
    // The 'settled' / 'determined' frames carry the settle time as epoch SECONDS
    // in settled_ts / determination_ts — NOT settlement_timestamp. coerceResolvedAt
    // parses a bare number as MILLISECONDS, so a raw seconds value would resolve
    // to 1970; convert seconds→ms via Date first. Fall back to the legacy fields
    // for forward-compatibility.
    const tsSec = msg.settled_ts ?? msg.determination_ts;
    const settledTs = tsSec != null && Number.isFinite(Number(tsSec))
      ? new Date(Number(tsSec) * 1000)
      : (msg.settlement_timestamp ?? msg.close_time ?? msg.expiration_time);
    const { resolvedAt } = coerceResolvedAt(settledTs, `kalshi/wss ${ticker}`);

    this.log(`Market settled: ${ticker} → ${winning ?? result ?? 'unknown'}`);

    const { outcome } = await writeAndPublishResolution({
      platform: 'kalshi',
      platformId: ticker,
      winning,
      resolvedAt,
      source: 'kalshi/wss',
    });

    if (outcome === 'created') {
      this.marketsResolved++;
      this.onEvent?.('resolved');
    } else if (outcome === 'amended') {
      this.log(`Market ${ticker}: amended missing winner (${winning ?? 'still null'})`);
    }
  }

  // ─── Private: connection lifecycle ───────────────────────────────────────

  private startPingInterval(): void {
    if (this.pingInterval) return;
    this.lastMessageTs = Date.now(); // baseline on fresh connect
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // Stale-socket watchdog: TCP can die silently without a close event.
      if (Date.now() - this.lastMessageTs > STALE_TIMEOUT_MS) {
        this.log(`No message for ${STALE_TIMEOUT_MS / 1000}s — forcing reconnect`, true);
        this.disconnectedAt ??= new Date();
        this.ws!.terminate(); // triggers 'close' → scheduleReconnect
        return;
      }
      this.ws.ping();
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

}
