/**
 * Smoke tests comparing our ingestion paths to pmxt-style extraction.
 *
 * Read-only, no auth, no DB. Public endpoints only.
 *
 * Usage:
 *   bun services/ingestion/src/scripts/smoke-pmxt-compare.ts           # run all
 *   bun services/ingestion/src/scripts/smoke-pmxt-compare.ts gamma     # one section
 *   bun services/ingestion/src/scripts/smoke-pmxt-compare.ts kalshi
 *   bun services/ingestion/src/scripts/smoke-pmxt-compare.ts limitless
 */

import axios from 'axios';
import { io } from 'socket.io-client';

// ─── Helpers ────────────────────────────────────────────────────────────────

function pct(num: number, denom: number): string {
  if (denom === 0) return '–';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function section(name: string): void {
  console.log('\n' + '═'.repeat(72));
  console.log(`  ${name}`);
  console.log('═'.repeat(72));
}

function row(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(38)} ${value}`);
}

// ─── Smoke 1: Polymarket Gamma keyset clamp + price-field gap ───────────────

async function smokeGamma(): Promise<void> {
  section('Polymarket Gamma /events/keyset');
  const t0 = Date.now();

  const url = 'https://gamma-api.polymarket.com/events/keyset';

  // Probe the actual clamp value by asking for increasingly large pages.
  console.log('  Clamp probe (asked → returned):');
  for (const ask of [50, 100, 200, 500, 1000]) {
    const r = await axios.get(url, {
      params: { limit: ask, closed: true, order: 'id', ascending: false },
      timeout: 30_000,
    });
    const n = (r.data?.events ?? []).length;
    row(`  limit=${ask}`, `${n}${n < ask ? '  ← CLAMPED' : ''}`);
  }

  // Use the largest honored page for the field-availability analysis.
  const REQUESTED_LIMIT = 500;
  const res = await axios.get(url, {
    params: { limit: REQUESTED_LIMIT, closed: true, order: 'id', ascending: false },
    timeout: 30_000,
  });
  const events: any[] = res.data?.events ?? [];
  const nextCursor: string | null = res.data?.next_cursor ?? null;
  console.log('');
  row('next_cursor present', nextCursor ? 'yes' : 'no');

  // Count populated live-price/structural fields on nested markets.
  const allMarkets: any[] = events.flatMap((e) => e.markets ?? []);
  row('Total nested markets', allMarkets.length);

  const fields = [
    'bestBid', 'bestAsk', 'lastTradePrice', 'spread',
    'oneDayPriceChange', 'oneWeekPriceChange', 'oneMonthPriceChange',
    'orderPriceMinTickSize', 'liquidity', 'liquidityNum', 'openInterest',
    'volume24hr', 'oneDayVolume',
  ];
  console.log('\n  Field availability on nested markets (keyset response):');
  for (const f of fields) {
    const present = allMarkets.filter((m) => m[f] != null && m[f] !== '' && m[f] !== 0).length;
    row(`  ${f}`, `${present}/${allMarkets.length}  (${pct(present, allMarkets.length)})`);
  }

  // Direct-fetch one market and diff. Gamma exposes single-market lookup via
  // /markets?condition_ids=<hex> (returns an array). The /markets/<id> route
  // expects the numeric market id, not the hex conditionId.
  const sample = allMarkets.find((m) => m.conditionId);
  if (sample) {
    console.log('\n  Direct /markets?condition_ids=<hex> diff (one sample):');
    row('Sample conditionId', sample.conditionId);
    try {
      const direct = await axios.get('https://gamma-api.polymarket.com/markets', {
        params: { condition_ids: sample.conditionId },
        timeout: 30_000,
      });
      const arr = Array.isArray(direct.data) ? direct.data : (direct.data?.markets ?? []);
      const directMarket = arr[0];
      if (!directMarket) {
        row('Direct fetch', '(empty array)');
      } else {
        for (const f of ['bestBid', 'bestAsk', 'lastTradePrice', 'spread', 'oneDayPriceChange', 'oneWeekPriceChange', 'oneMonthPriceChange', 'orderPriceMinTickSize', 'liquidity', 'liquidityNum', 'openInterest', 'volume24hr', 'oneDayVolume']) {
          const fromKeyset = sample[f];
          const fromDirect = directMarket[f];
          const ksHas = fromKeyset != null && fromKeyset !== '' && fromKeyset !== 0;
          const dirHas = fromDirect != null && fromDirect !== '' && fromDirect !== 0;
          const gained = !ksHas && dirHas;
          row(`  ${f}`, `keyset=${JSON.stringify(fromKeyset)}  direct=${JSON.stringify(fromDirect)}${gained ? '  ← GAINED' : ''}`);
        }
      }
    } catch (e: any) {
      row('Direct fetch', `failed: HTTP ${e?.response?.status ?? '?'} ${e.message}`);
    }
  } else {
    console.log('  (no nested market with conditionId — skipping direct-fetch diff)');
  }

  row('Elapsed', `${Date.now() - t0}ms`);
}

// ─── Smoke 2: Limitless WS orderbook size scale ─────────────────────────────

async function smokeLimitless(): Promise<void> {
  section('Limitless WS orderbookUpdate size scale');
  const t0 = Date.now();

  // Find one active CLOB market via REST.
  const listRes = await axios.get(
    'https://api.limitless.exchange/markets/active',
    { params: { page: 1, limit: 25 }, timeout: 30_000 },
  );
  const candidates: any[] = (listRes.data?.data ?? []).filter((m: any) => m.tradeType === 'clob');
  const market = candidates[0];
  if (!market) {
    console.log('  No active CLOB market found — skipping.');
    return;
  }
  const slug: string = market.slug;
  row('Sample slug', slug);
  row('Trade type', market.tradeType);
  row('Liquidity (raw API)', market.liquidity);

  // REST orderbook for reference.
  let restBids: any[] = [];
  try {
    const restRes = await axios.get(
      `https://api.limitless.exchange/markets/${encodeURIComponent(slug)}/orderbook`,
      { timeout: 15_000 },
    );
    // shape varies — try common locations
    restBids = restRes.data?.bids ?? restRes.data?.orderbook?.bids ?? [];
    row('REST bids[0]', restBids[0] ? JSON.stringify(restBids[0]) : '(empty)');
  } catch (e: any) {
    row('REST orderbook fetch', `failed: ${e.message}`);
  }

  // Connect WS and capture first orderbookUpdate.
  console.log('\n  Connecting socket.io to wss://ws.limitless.exchange/markets...');
  const socket = io('wss://ws.limitless.exchange/markets', {
    transports: ['websocket'],
    reconnection: false,
  });

  const wsBid = await new Promise<any | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    socket.on('connect', () => {
      socket.emit('subscribe_market_prices', { marketSlugs: [slug] });
    });
    socket.on('orderbookUpdate', (msg: any) => {
      const ob = msg.orderbook ?? msg;
      const bids: any[] = ob.bids ?? [];
      clearTimeout(timer);
      resolve(bids[0] ?? null);
    });
    socket.on('connect_error', (err: Error) => {
      console.log(`  connect_error: ${err.message}`);
      clearTimeout(timer);
      resolve(null);
    });
  });

  socket.disconnect();

  if (!wsBid) {
    row('WS bids[0]', '(timed out — no orderbookUpdate within 15s)');
  } else {
    row('WS bids[0]', JSON.stringify(wsBid));
    const wsSize = Number(wsBid.size);
    const restSize = restBids[0]?.size != null ? Number(restBids[0].size) : null;
    if (restSize != null && restSize > 0) {
      row('WS size / REST size', `${(wsSize / restSize).toFixed(6)}`);
      if (Math.abs(wsSize / restSize - 1) < 0.01) {
        row('Conclusion', 'WS size matches REST — no scaling needed (already decimals)');
      } else if (Math.abs(wsSize / restSize - 1e6) / 1e6 < 0.01) {
        row('Conclusion', 'WS size is 1e6× REST — USDC base units, NEEDS /1e6');
      } else {
        row('Conclusion', `unclear ratio — inspect manually (WS=${wsSize}, REST=${restSize})`);
      }
    } else if (wsSize > 1e4) {
      row('Conclusion', `WS size=${wsSize} (>1e4) suggests USDC base units (would be /1e6)`);
    } else {
      row('Conclusion', `WS size=${wsSize} looks decimal-scaled (likely fine)`);
    }
  }

  row('Elapsed', `${Date.now() - t0}ms`);
}

// ─── Smoke 3: Kalshi rule-templating prototype ──────────────────────────────

/**
 * Lifted-and-rewritten version of pmxt's templateRule. Replaces the candidate
 * name in a rules_primary string with `{x}` (Unicode-aware word boundaries).
 */
function templateRule(rule: string, candidate: string | null): string {
  if (!candidate) return rule;
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
  return rule.replace(matcher, '{x}');
}

function deriveCandidate(market: any): string | null {
  const sub = (market.yes_sub_title ?? market.subtitle ?? '').trim();
  if (!sub || sub.startsWith('::')) return null;
  return sub;
}

async function smokeKalshi(): Promise<void> {
  section('Kalshi rule-templating prototype');
  const t0 = Date.now();

  const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
  const eventsRes = await axios.get(`${BASE}/events`, {
    params: { status: 'open', limit: 50, with_nested_markets: true },
    timeout: 30_000,
  });
  const events: any[] = eventsRes.data?.events ?? [];
  row('Open events fetched', events.length);

  // Find events with ≥4 nested markets and mutually_exclusive=true.
  const candidates = events
    .filter((e: any) => Array.isArray(e.markets) && e.markets.length >= 4)
    .slice(0, 5);

  row('Events with ≥4 markets used', candidates.length);
  if (candidates.length === 0) {
    // Fall back: fetch markets for the first few events with no nested arrays.
    console.log('  (no nested-markets events from /events — falling back to /markets per event_ticker)');
    const eventsWithoutNested = events.slice(0, 5);
    for (const ev of eventsWithoutNested) {
      const mres = await axios.get(`${BASE}/markets`, {
        params: { event_ticker: ev.event_ticker, limit: 100 },
        timeout: 30_000,
      });
      ev.markets = mres.data?.markets ?? [];
    }
    candidates.push(...eventsWithoutNested.filter((e) => e.markets?.length >= 4).slice(0, 5));
    row('After fallback', candidates.length);
  }

  for (const ev of candidates) {
    console.log('\n  ─── ' + (ev.title || ev.event_ticker) + ' ───');
    row('  event_ticker', ev.event_ticker);
    row('  mutually_exclusive', ev.mutually_exclusive ?? '(absent)');
    row('  market count', ev.markets.length);

    const templates = new Map<string, number>();
    for (const m of ev.markets) {
      const rule = (m.rules_primary ?? '').trim();
      if (!rule) continue;
      const candidate = deriveCandidate(m);
      const templated = templateRule(rule, candidate);
      if (templated.includes('{x}')) {
        templates.set(templated, (templates.get(templated) ?? 0) + 1);
      }
    }

    if (templates.size === 0) {
      row('  voted template', '(no template extracted — sibling rules diverge or candidates not detectable)');
    } else {
      const sorted = [...templates.entries()].sort((a, b) => b[1] - a[1]);
      const [topTemplate, topCount] = sorted[0];
      const secondCount = sorted[1]?.[1] ?? 0;
      row('  vote winner', `${topCount}/${ev.markets.length} (runner-up: ${secondCount})`);
      console.log(`    template: ${topTemplate.slice(0, 240)}${topTemplate.length > 240 ? '…' : ''}`);
      const sampleRaw = (ev.markets[0].rules_primary ?? '').slice(0, 240);
      console.log(`    raw[0]:   ${sampleRaw}${(ev.markets[0].rules_primary?.length ?? 0) > 240 ? '…' : ''}`);
    }
  }

  row('Elapsed', `${Date.now() - t0}ms`);
}

// ─── Smoke 4: Cross-platform template probe (Polymarket negRisk, Predict) ───

async function smokeTemplates(): Promise<void> {
  section('Cross-platform template probe');
  const t0 = Date.now();

  // ── 4a. Polymarket negRisk events ──
  console.log('\n  ── Polymarket (negRisk events) ──');

  // Pull a few pages of open events looking for negRisk groups.
  const polyEvents: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const r: any = await axios.get('https://gamma-api.polymarket.com/events/keyset', {
      params: { limit: 100, closed: false, order: 'id', ascending: false, ...(cursor ? { after_cursor: cursor } : {}) },
      timeout: 30_000,
    });
    polyEvents.push(...(r.data?.events ?? []));
    cursor = r.data?.next_cursor ?? null;
    if (!cursor) break;
  }

  const negRiskEvents = polyEvents.filter((e: any) =>
    Array.isArray(e.markets) && e.markets.length >= 4 &&
    e.markets.some((m: any) => m.negRisk === true),
  );
  row('Open events scanned', polyEvents.length);
  row('negRisk events with ≥4 markets', negRiskEvents.length);

  // Tally three independent detectors per event:
  //   A. shared-description: all siblings have identical description → already template
  //   B. shared-question:    all siblings have identical question (rare; usually slot-only)
  //   C. {x}-templating:     standard Kalshi-style vote, candidate from groupItemTitle
  let countSharedDesc = 0;
  let countSharedQuestion = 0;
  let countTemplated = 0;

  for (const ev of negRiskEvents) {
    const descs = new Set<string>(ev.markets.map((m: any) => String(m.description ?? '').trim()).filter(Boolean));
    const questions = new Set<string>(ev.markets.map((m: any) => String(m.question ?? '').trim()).filter(Boolean));

    const sharedDesc = descs.size === 1;
    const sharedQuestion = questions.size === 1;

    const templates = new Map<string, number>();
    for (const m of ev.markets) {
      const desc = String(m.description ?? '').trim();
      const candidate = String(m.groupItemTitle ?? '').trim() || null;
      if (!desc || !candidate) continue;
      const templated = templateRule(desc, candidate);
      if (templated.includes('{x}')) templates.set(templated, (templates.get(templated) ?? 0) + 1);
    }
    const topVote = [...templates.values()].sort((a, b) => b - a)[0] ?? 0;
    const templated = topVote >= Math.ceil(ev.markets.length * 0.6);

    if (sharedDesc) countSharedDesc++;
    if (sharedQuestion) countSharedQuestion++;
    if (templated) countTemplated++;
  }

  row('A. shared description across all siblings', `${countSharedDesc}/${negRiskEvents.length}`);
  row('B. shared question across all siblings', `${countSharedQuestion}/${negRiskEvents.length}`);
  row('C. {x}-template vote ≥60% of siblings', `${countTemplated}/${negRiskEvents.length}`);

  const anyDetector = negRiskEvents.filter((ev: any) => {
    const descs = new Set<string>(ev.markets.map((m: any) => String(m.description ?? '').trim()).filter(Boolean));
    const questions = new Set<string>(ev.markets.map((m: any) => String(m.question ?? '').trim()).filter(Boolean));
    const templates = new Map<string, number>();
    for (const m of ev.markets) {
      const desc = String(m.description ?? '').trim();
      const candidate = String(m.groupItemTitle ?? '').trim() || null;
      if (!desc || !candidate) continue;
      const templated = templateRule(desc, candidate);
      if (templated.includes('{x}')) templates.set(templated, (templates.get(templated) ?? 0) + 1);
    }
    const topVote = [...templates.values()].sort((a, b) => b - a)[0] ?? 0;
    return descs.size === 1 || questions.size === 1 || topVote >= Math.ceil(ev.markets.length * 0.6);
  }).length;
  row('Any of A/B/C', `${anyDetector}/${negRiskEvents.length}`);

  // Show one sample from each detector that fired.
  for (const ev of negRiskEvents.slice(0, 2)) {
    console.log('\n  ── ' + (ev.title || ev.slug) + ' ──');
    row('    market count', ev.markets.length);
    const descs = new Set<string>(ev.markets.map((m: any) => String(m.description ?? '').trim()).filter(Boolean));
    const questions = new Set<string>(ev.markets.map((m: any) => String(m.question ?? '').trim()).filter(Boolean));
    row('    distinct descriptions', descs.size);
    row('    distinct questions', questions.size);
    row('    groupItemTitle[0]', ev.markets[0].groupItemTitle ?? '(none)');
    if (descs.size === 1) {
      console.log('    → SHARED DESCRIPTION (description IS the template):');
      console.log(`      ${[...descs][0].slice(0, 200)}…`);
      console.log(`    → slots = [${ev.markets.slice(0, 5).map((m: any) => JSON.stringify(m.groupItemTitle ?? m.question)).join(', ')}, …]`);
    }
  }

  // ── 4b. Predict.fun: does the explicit `___` template come through? ──
  console.log('\n  ── Predict.fun (explicit ___ template) ──');
  try {
    const pr = await axios.get('https://api.predict.fun/markets', {
      params: { limit: 50, page: 1 },
      timeout: 30_000,
    });
    const items: any[] = pr.data?.markets ?? pr.data?.data ?? (Array.isArray(pr.data) ? pr.data : []);
    row('Markets fetched', items.length);

    const placeholderHits = items.filter((m: any) =>
      typeof m.categoryTitle === 'string' && m.categoryTitle.includes('___'),
    );
    row('Markets w/ ___ template', `${placeholderHits.length}/${items.length}`);

    const negRiskHits = items.filter((m: any) => m.isNegRisk === true);
    row('Markets w/ isNegRisk=true', `${negRiskHits.length}/${items.length}`);

    const variants = new Map<string, number>();
    for (const m of items) {
      const v = m.marketVariant ?? '(none)';
      variants.set(v, (variants.get(v) ?? 0) + 1);
    }
    console.log('  marketVariant distribution:');
    for (const [v, n] of [...variants.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${v.padEnd(24)} ${n}`);
    }

    if (placeholderHits[0]) {
      console.log('\n  Sample with ___ template:');
      row('  categoryTitle', placeholderHits[0].categoryTitle);
      row('  title (slot)', placeholderHits[0].title);
      row('  isNegRisk', placeholderHits[0].isNegRisk);
    }
    if (negRiskHits[0] && !placeholderHits.includes(negRiskHits[0])) {
      console.log('\n  Sample negRisk (no ___):');
      row('  categoryTitle', negRiskHits[0].categoryTitle);
      row('  title (slot)', negRiskHits[0].title);
    }
  } catch (e: any) {
    row('Predict API', `failed: HTTP ${e?.response?.status ?? '?'} ${e.message}`);
  }

  row('Elapsed', `${Date.now() - t0}ms`);
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const mode = (process.argv[2] ?? 'all').toLowerCase();

async function safeRun(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    console.error(`\n[${name}] failed: ${err?.message ?? err}${err?.response?.status ? ` (HTTP ${err.response.status})` : ''}`);
  }
}

(async () => {
  if (mode === 'gamma' || mode === 'all') await safeRun('gamma', smokeGamma);
  if (mode === 'kalshi' || mode === 'all') await safeRun('kalshi', smokeKalshi);
  if (mode === 'limitless' || mode === 'all') await safeRun('limitless', smokeLimitless);
  if (mode === 'templates' || mode === 'all') await safeRun('templates', smokeTemplates);
  console.log('\nDone.');
  process.exit(0);
})();
