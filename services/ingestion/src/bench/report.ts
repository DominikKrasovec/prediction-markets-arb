/**
 * lifecycle-bench — end-of-run aggregation → summary.json + markdown report.
 *
 * Pure consumer of {@link BenchSink}'s in-memory views. Produces:
 *   - reachability matrix (connect / first frame / created / resolved)
 *   - connection-lifecycle timing (connect→ws_open→subscribe→first-frame)
 *   - throughput (messages, heartbeats, msgs/sec) + reliability + uptime %
 *   - CREATIONS: per-platform detection latency (vs creation ts) + by-type
 *   - RESOLUTIONS: per-platform detection latency (vs settlement ts) + by-type
 *   - a by-market-type breakdown per platform (creations + resolutions)
 *   - Predict REST poll (created head + resolved head: latency, items, new ids)
 */

import { summarize, type BenchPlatform, type BenchSink, type Dist, type DiscoveryEvent, type LifecycleEvent } from './metrics.js';

const WSS_PLATFORMS: BenchPlatform[] = ['kalshi', 'polymarket', 'limitless'];
const TOP_TYPES = 12;

// A discovery's detection latency only counts as a real-time-push measurement
// when it lands in a plausible window. Outside it the matched timestamp isn't a
// live-push signal:
//   - < -FUTURE_GRACE  → the ts is in the future (a scheduled open/close field) ;
//   - > BACKLOG_MAX    → the event is stale (e.g. a backlog/replay burst the feed
//                        sends right after subscribe — its age is not our latency).
const FUTURE_GRACE_MS = 60_000;
const BACKLOG_MAX_MS = 120_000;
const isLiveLatency = (ms: number | null): ms is number =>
  ms !== null && ms >= -FUTURE_GRACE_MS && ms <= BACKLOG_MAX_MS;

export interface BenchSummary {
  runId: string;
  label: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  clockOffsetMs: number | null;
  sourceCommit: string | null;
  platforms: BenchPlatform[];
  perPlatform: Record<string, PlatformSummary>;
  predictPoll: PredictPollSummary | null;
}

interface TypeRow { type: string; count: number; detectP50: number | null; }

interface KindMetrics {
  count: number;
  detect: Dist;        // over live-window samples only
  live: number;        // samples used in `detect`
  future: number;      // excluded: ts in the future (scheduled field)
  stale: number;       // excluded: > BACKLOG_MAX (subscribe-time replay/backlog)
  noTs: number;        // no usable timestamp field
  tsFields: Record<string, number>;
  byType: TypeRow[];   // keyed by UNIFIED category
  byNative: TypeRow[]; // keyed by granular native label
}

interface PlatformSummary {
  isWss: boolean;
  reachable: boolean;
  gotFirstFrame: boolean;
  connections: number;
  handshakeMs: Dist;
  subscribeMs: Dist;
  firstFrameMs: Dist;
  messages: number;
  heartbeats: number;
  msgsPerSec: number;
  uptimePct: number | null;
  reliability: { connected: number; disconnected: number; error: number; reconnect: number; heartbeatIn: number; heartbeatOut: number };
  created: KindMetrics;
  resolved: KindMetrics;
}

interface PredictHeadSummary {
  polls: number;
  failedPolls: number;
  latencyMs: Dist;
  itemsPerPoll: Dist;
  baselineItems: number;
  newAfterBaseline: number;
}

interface PredictPollSummary {
  created: PredictHeadSummary;
  resolved: PredictHeadSummary;
}

// ─── Build summary ─────────────────────────────────────────────────────────────

export function buildSummary(
  sink: BenchSink,
  meta: {
    label: string;
    startedAtMs: number;
    endedAtMs: number;
    clockOffsetMs: number | null;
    sourceCommit: string | null;
    platforms: BenchPlatform[];
  },
): BenchSummary {
  const perPlatform: Record<string, PlatformSummary> = {};
  for (const platform of meta.platforms) {
    perPlatform[platform] = buildPlatform(sink, platform, meta.startedAtMs, meta.endedAtMs);
  }
  return {
    runId: sink.runId,
    label: meta.label,
    startedAt: new Date(meta.startedAtMs).toISOString(),
    endedAt: new Date(meta.endedAtMs).toISOString(),
    durationSec: (meta.endedAtMs - meta.startedAtMs) / 1000,
    clockOffsetMs: meta.clockOffsetMs,
    sourceCommit: meta.sourceCommit,
    platforms: meta.platforms,
    perPlatform,
    predictPoll: meta.platforms.includes('predict') ? buildPredict(sink) : null,
  };
}

function kindMetrics(discs: DiscoveryEvent[]): KindMetrics {
  const tsFields: Record<string, number> = {};
  for (const d of discs) if (d.tsField) tsFields[d.tsField] = (tsFields[d.tsField] ?? 0) + 1;

  const live = discs.filter((d) => isLiveLatency(d.detectMs));
  const future = discs.filter((d) => d.detectMs !== null && d.detectMs < -FUTURE_GRACE_MS).length;
  const stale = discs.filter((d) => d.detectMs !== null && d.detectMs > BACKLOG_MAX_MS).length;

  return {
    count: discs.length,
    detect: summarize(live.map((d) => d.detectMs as number)),
    live: live.length,
    future,
    stale,
    noTs: discs.filter((d) => d.detectMs === null).length,
    tsFields,
    byType: groupRows(discs, (d) => d.marketType || 'unknown'),
    byNative: groupRows(discs, (d) => d.nativeType || 'unknown'),
  };
}

/** Group discoveries by a key → rows of {type, count, detectP50 (live only)}, count-desc. */
function groupRows(discs: DiscoveryEvent[], keyOf: (d: DiscoveryEvent) => string): TypeRow[] {
  const samples = new Map<string, number[]>();
  const counts = new Map<string, number>();
  for (const d of discs) {
    const k = keyOf(d);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (isLiveLatency(d.detectMs)) {
      const arr = samples.get(k) ?? [];
      arr.push(d.detectMs);
      samples.set(k, arr);
    }
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count, detectP50: summarize(samples.get(type) ?? []).p50 }))
    .sort((a, b) => b.count - a.count);
}

function buildPlatform(sink: BenchSink, platform: BenchPlatform, startMs: number, endMs: number): PlatformSummary {
  const isWss = WSS_PLATFORMS.includes(platform);
  const disc = sink.discoveries.filter((d) => d.platform === platform);
  const created = kindMetrics(disc.filter((d) => d.kind === 'created'));
  const resolved = kindMetrics(disc.filter((d) => d.kind === 'resolved'));

  if (!isWss) {
    return {
      isWss: false,
      reachable: sink.polls.some((p) => p.platform === platform && p.ok),
      gotFirstFrame: false,
      connections: 0,
      handshakeMs: summarize([]), subscribeMs: summarize([]), firstFrameMs: summarize([]),
      messages: 0, heartbeats: 0, msgsPerSec: 0, uptimePct: null,
      reliability: { connected: 0, disconnected: 0, error: 0, reconnect: 0, heartbeatIn: 0, heartbeatOut: 0 },
      created, resolved,
    };
  }

  const lc = sink.lifecycle.filter((e) => e.platform === platform);
  const byConn = new Map<number, LifecycleEvent[]>();
  for (const e of lc) {
    const arr = byConn.get(e.connId) ?? [];
    arr.push(e);
    byConn.set(e.connId, arr);
  }
  const handshake: number[] = [];
  const subscribe: number[] = [];
  const firstFrame: number[] = [];
  for (const evs of byConn.values()) {
    const phase = (p: string) => evs.find((e) => e.phase === p);
    const cs = phase('connect_start'); const wo = phase('ws_open');
    const ss = phase('subscribe_sent'); const fm = phase('first_message');
    if (cs && wo) handshake.push(wo.hr - cs.hr);
    if (wo && ss) subscribe.push(ss.hr - wo.hr);
    if (ss && fm) firstFrame.push(fm.hr - ss.hr);
  }

  const msg = sink.msgStats.get(platform);
  const rel = sink.reliabilityCountsFor(platform);

  return {
    isWss: true,
    reachable: [...byConn.values()].some((evs) => evs.some((e) => e.phase === 'ws_open')),
    gotFirstFrame: lc.some((e) => e.phase === 'first_message'),
    connections: byConn.size,
    handshakeMs: summarize(handshake),
    subscribeMs: summarize(subscribe),
    firstFrameMs: summarize(firstFrame),
    messages: msg?.messages ?? 0,
    heartbeats: msg?.heartbeats ?? 0,
    msgsPerSec: msg && msg.firstFrameT && msg.lastFrameT && msg.lastFrameT > msg.firstFrameT
      ? msg.messages / ((msg.lastFrameT - msg.firstFrameT) / 1000)
      : 0,
    uptimePct: computeUptimePct(lc, startMs, endMs),
    reliability: {
      connected: rel.connected ?? 0,
      disconnected: rel.disconnected ?? 0,
      error: rel.error ?? 0,
      reconnect: rel.reconnect ?? 0,
      heartbeatIn: rel.heartbeat_in ?? 0,
      heartbeatOut: rel.heartbeat_out ?? 0,
    },
    created, resolved,
  };
}

/** Sum connected windows (ws_open → close, or run-end if still open) / run window. */
function computeUptimePct(lc: LifecycleEvent[], startMs: number, endMs: number): number | null {
  const opens = lc.filter((e) => e.phase === 'ws_open').sort((a, b) => a.t - b.t);
  if (opens.length === 0) return 0;
  const closes = lc.filter((e) => e.phase === 'close').sort((a, b) => a.t - b.t);
  let connectedMs = 0;
  for (const open of opens) {
    const close = closes.find((c) => c.t > open.t && c.connId === open.connId);
    const end = close ? close.t : endMs;
    connectedMs += Math.max(0, Math.min(end, endMs) - open.t);
  }
  return Math.min(100, (connectedMs / Math.max(1, endMs - startMs)) * 100);
}

function buildHead(sink: BenchSink, kind: 'created' | 'resolved'): PredictHeadSummary {
  const polls = sink.polls.filter((p) => p.platform === 'predict' && p.pollKind === kind);
  const ok = polls.filter((p) => p.ok);
  return {
    polls: polls.length,
    failedPolls: polls.filter((p) => !p.ok).length,
    latencyMs: summarize(ok.map((p) => p.latencyMs)),
    itemsPerPoll: summarize(ok.map((p) => p.itemsSeen)),
    baselineItems: polls[0]?.itemsSeen ?? 0,
    newAfterBaseline: polls.slice(1).reduce((a, p) => a + p.newIds, 0),
  };
}

function buildPredict(sink: BenchSink): PredictPollSummary {
  return { created: buildHead(sink, 'created'), resolved: buildHead(sink, 'resolved') };
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

const d = (x: number | null, unit = 'ms') => (x === null ? '—' : `${x.toFixed(x < 10 ? 2 : 1)}${unit}`);
const dist = (s: Dist) => `n=${s.n} p50=${d(s.p50)} p95=${d(s.p95)} p99=${d(s.p99)} max=${d(s.max)}`;
const distN = (s: Dist) => `n=${s.n} p50=${d(s.p50, '')} p95=${d(s.p95, '')} max=${d(s.max, '')}`;

function kindLatencyTable(s: BenchSummary, kind: 'created' | 'resolved'): string[] {
  const L: string[] = [];
  L.push('| platform | count | live | detection latency (live) | excl. future/stale/no-ts | ts field(s) |');
  L.push('|---|---|---|---|---|---|');
  for (const p of Object.keys(s.perPlatform)) {
    const m = s.perPlatform[p][kind];
    const fields = Object.entries(m.tsFields).map(([k, v]) => `${k}×${v}`).join(', ') || '—';
    const excl = `${m.future}/${m.stale}/${m.noTs}`;
    L.push(`| ${p} | ${m.count} | ${m.live} | ${m.live > 0 ? dist(m.detect) : '—'} | ${excl} | ${fields} |`);
  }
  return L;
}

export function renderMarkdown(s: BenchSummary): string {
  const L: string[] = [];
  L.push(`# lifecycle-bench report — ${s.label}`);
  L.push('');
  L.push(`- run: \`${s.runId}\`  •  ${s.startedAt} → ${s.endedAt}  (${s.durationSec.toFixed(0)}s)`);
  L.push(`- platforms: ${s.platforms.join(', ')}`);
  L.push(`- clock offset (SNTP): ${s.clockOffsetMs === null ? 'unavailable (detection latency uncorrected)' : d(s.clockOffsetMs)}`);
  L.push(`- source commit: ${s.sourceCommit ?? '—'}`);
  L.push('');

  // Reachability
  L.push('## Reachability');
  L.push('');
  L.push('| platform | connected | first frame | created | resolved |');
  L.push('|---|---|---|---|---|');
  for (const p of Object.keys(s.perPlatform)) {
    const x = s.perPlatform[p];
    const conn = x.isWss ? (x.reachable ? '✓' : '✗') : (x.reachable ? '✓ (REST)' : '✗');
    const ff = x.isWss ? (x.gotFirstFrame ? '✓' : '✗') : 'n/a';
    L.push(`| ${p} | ${conn} | ${ff} | ${x.created.count} | ${x.resolved.count} |`);
  }
  L.push('');

  // Connection lifecycle (WSS only)
  L.push('## Connection lifecycle (WSS feeds)');
  L.push('');
  for (const p of Object.keys(s.perPlatform)) {
    const x = s.perPlatform[p];
    if (!x.isWss) continue;
    L.push(`**${p}** — ${x.connections} connection(s), uptime ${x.uptimePct === null ? '—' : x.uptimePct.toFixed(1) + '%'}`);
    L.push(`  - handshake (connect→open): ${dist(x.handshakeMs)}`);
    L.push(`  - subscribe (open→sub sent): ${dist(x.subscribeMs)}`);
    L.push(`  - first frame (sub→first msg): ${dist(x.firstFrameMs)}`);
    L.push('');
  }

  // Throughput + reliability (WSS only)
  L.push('## Throughput & reliability (WSS feeds)');
  L.push('');
  L.push('| platform | msgs | hb | msgs/s | conn | disc | err | recon | uptime |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const p of Object.keys(s.perPlatform)) {
    const x = s.perPlatform[p];
    if (!x.isWss) continue;
    const r = x.reliability;
    L.push(`| ${p} | ${x.messages} | ${x.heartbeats} | ${x.msgsPerSec.toFixed(2)} | ${r.connected} | ${r.disconnected} | ${r.error} | ${r.reconnect} | ${x.uptimePct === null ? '—' : x.uptimePct.toFixed(1) + '%'} |`);
  }
  L.push('');

  // Creations
  L.push('## New-market detection latency — CREATIONS');
  L.push('');
  L.push('Skew-corrected `(localRecv + clockOffset) − creationTs` where the payload carries a creation timestamp (WSS) or vs publishedAt (Predict poll). Bounded by NTP accuracy.');
  L.push(`Only live-window samples count toward latency; \`excl.\` = future-dated (scheduled ts) / stale (>${BACKLOG_MAX_MS / 1000}s, subscribe-time backlog) / no usable ts.`);
  L.push('');
  L.push(...kindLatencyTable(s, 'created'));
  L.push('');

  // Resolutions
  L.push('## Resolution detection latency — RESOLUTIONS');
  L.push('');
  L.push('Skew-corrected `(localRecv + clockOffset) − settlementTs`. WSS feeds push resolutions in real time; Predict is a coverage-limited REST proxy (see poll section).');
  L.push('Same live-window filter as creations — a subscribe-time backlog of recent resolutions shows up under `excl.` stale, not as latency.');
  L.push('');
  L.push(...kindLatencyTable(s, 'resolved'));
  L.push('');

  // Cross-platform category matrix (the payoff of unified bucketing)
  const cnt = (rows: TypeRow[], type: string) => rows.find((r) => r.type === type)?.count ?? 0;
  const cats = new Set<string>();
  for (const p of Object.keys(s.perPlatform)) {
    for (const r of s.perPlatform[p].created.byType) cats.add(r.type);
    for (const r of s.perPlatform[p].resolved.byType) cats.add(r.type);
  }
  if (cats.size > 0) {
    const plats = Object.keys(s.perPlatform);
    const ordered = [...cats].sort((a, b) => {
      const tot = (c: string) => plats.reduce((n, p) => n + cnt(s.perPlatform[p].created.byType, c) + cnt(s.perPlatform[p].resolved.byType, c), 0);
      return tot(b) - tot(a);
    });
    L.push('## Cross-platform category matrix (unified)');
    L.push('');
    L.push('Cell = `created / resolved` per unified category × platform. Same vocabulary as `markets.category_unified`.');
    L.push('');
    L.push(`| unified category | ${plats.join(' | ')} |`);
    L.push(`|---|${plats.map(() => '---').join('|')}|`);
    for (const c of ordered) {
      const cells = plats.map((p) => {
        const cc = cnt(s.perPlatform[p].created.byType, c);
        const rr = cnt(s.perPlatform[p].resolved.byType, c);
        return cc === 0 && rr === 0 ? '·' : `${cc} / ${rr}`;
      });
      L.push(`| ${c} | ${cells.join(' | ')} |`);
    }
    L.push('');
  }

  // By market type — unified primary table + native drill-down, per platform
  L.push('## By market type (unified category + native detail)');
  L.push('');
  for (const p of Object.keys(s.perPlatform)) {
    const x = s.perPlatform[p];
    if (x.created.count === 0 && x.resolved.count === 0) continue;
    const merged = new Map<string, { c: number; cP50: number | null; r: number; rP50: number | null }>();
    for (const row of x.created.byType) merged.set(row.type, { c: row.count, cP50: row.detectP50, r: 0, rP50: null });
    for (const row of x.resolved.byType) {
      const e = merged.get(row.type) ?? { c: 0, cP50: null, r: 0, rP50: null };
      e.r = row.count; e.rP50 = row.detectP50; merged.set(row.type, e);
    }
    const rows = [...merged.entries()].sort((a, b) => (b[1].c + b[1].r) - (a[1].c + a[1].r)).slice(0, TOP_TYPES);
    L.push(`**${p}** — ${merged.size} unified categor${merged.size === 1 ? 'y' : 'ies'}${merged.size > TOP_TYPES ? ` (top ${TOP_TYPES})` : ''}`);
    L.push('');
    L.push('| unified category | created | created p50 | resolved | resolved p50 |');
    L.push('|---|---|---|---|---|');
    for (const [type, e] of rows) {
      L.push(`| ${type} | ${e.c} | ${d(e.cP50)} | ${e.r} | ${d(e.rP50)} |`);
    }
    // Native drill-down: combined created+resolved counts for the granular labels.
    const nativeMerged = new Map<string, number>();
    for (const row of x.created.byNative) nativeMerged.set(row.type, (nativeMerged.get(row.type) ?? 0) + row.count);
    for (const row of x.resolved.byNative) nativeMerged.set(row.type, (nativeMerged.get(row.type) ?? 0) + row.count);
    const nativeTop = [...nativeMerged.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_TYPES);
    L.push('');
    L.push(`  - native: ${nativeTop.map(([t, n]) => `${t}×${n}`).join(', ')}`);
    L.push('');
  }

  // Predict REST poll
  if (s.predictPoll) {
    const pp = s.predictPoll;
    const head = (h: PredictHeadSummary) =>
      `polls ${h.polls} (${h.failedPolls} failed) • latency ${dist(h.latencyMs)} • items/poll ${distN(h.itemsPerPoll)} • baseline ${h.baselineItems} • new after baseline **${h.newAfterBaseline}**`;
    L.push('## Predict REST poll (published-desc head)');
    L.push('');
    L.push(`- CREATED head (status=OPEN): ${head(pp.created)}`);
    L.push(`- RESOLVED head (status=RESOLVED): ${head(pp.resolved)}`);
    L.push('  - RESOLVED via published-desc is a coverage-limited proxy: older-published markets that just resolved may be missed (count = lower bound). Per-event latency vs resolvedAt is still accurate.');
    L.push('');
  }

  L.push('---');
  L.push('_No discovered markets were written to the DB. This run measured diagnostics only._');
  return L.join('\n');
}
