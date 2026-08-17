/**
 * Experiment-DB builder (isolated `exp` schema; prod tables untouched).
 *
 *   schema  — create exp.dataset: one row per embedded market with the feature
 *             columns the rules use + the prod label (NULL if unnormalized) +
 *             the embedding. Read-only on public.*; writes only to schema `exp`.
 *   label   — apply the NEW Kalshi-tail rules (the subagents' extendable clusters)
 *             to derive (condition_shape, event_kind) for unnormalized Kalshi
 *             markets → exp.labels_new. condition_shape is taken from prod's
 *             dominant shape for that event_kind (keeps new labels consistent
 *             with existing ones).
 *
 * Usage:
 *   npx tsx data/parsing-generalization/exp-build.ts schema
 *   npx tsx data/parsing-generalization/exp-build.ts label
 */
import pg from 'pg';
import 'dotenv/config';

function makePool(): pg.Pool {
  return new pg.Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    database: process.env.PG_DATABASE || 'prediction_arb',
    user: process.env.PG_USER || 'arb',
    password: process.env.PG_PASSWORD || 'arb_local_dev',
    max: 4,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  schema — slim isolated dataset
// ═══════════════════════════════════════════════════════════════════════════
async function buildSchema(pool: pg.Pool): Promise<void> {
  console.log('Creating exp schema + exp.dataset (embedded markets only)…');
  await pool.query(`CREATE SCHEMA IF NOT EXISTS exp`);
  await pool.query(`DROP TABLE IF EXISTS exp.dataset`);
  await pool.query(`
    CREATE TABLE exp.dataset AS
    SELECT m.id AS market_id,
           m.platform,
           m.platform_id,
           CASE WHEN m.platform = 'kalshi' THEN split_part(m.platform_id, '-', 1) END AS ticker_prefix,
           m.title,
           left(coalesce(m.description, ''), 500) AS description,
           m.category_unified,
           mr.raw->>'yes_sub_title' AS yes_sub_title,
           mr.raw->>'subtitle'      AS subtitle,
           mr.raw->>'strike_type'   AS strike_type,
           mr.raw->>'floor_strike'  AS floor_strike,
           mr.raw->>'cap_strike'    AS cap_strike,
           ke.raw->>'title'         AS event_title,
           n.condition_shape        AS prod_condition_shape,
           n.event_kind             AS prod_event_kind,
           n.match_source           AS prod_match_source,
           m.embedding
      FROM markets m
      LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
      LEFT JOIN kalshi_events ke ON m.platform = 'kalshi' AND ke.event_ticker = mr.raw->>'event_ticker'
      LEFT JOIN llm_market_normalizations n ON n.market_id = m.id
     WHERE m.embedding IS NOT NULL`);
  await pool.query(`ALTER TABLE exp.dataset ADD PRIMARY KEY (market_id)`);
  await pool.query(`CREATE INDEX idx_exp_prefix ON exp.dataset (ticker_prefix) WHERE ticker_prefix IS NOT NULL`);
  await pool.query(`CREATE INDEX idx_exp_platform ON exp.dataset (platform)`);
  const c = await pool.query<{ n: string; emb: string; unl: string }>(
    `SELECT count(*) AS n,
            count(*) FILTER (WHERE embedding IS NOT NULL) AS emb,
            count(*) FILTER (WHERE prod_event_kind IS NULL) AS unl
       FROM exp.dataset`);
  console.log(`exp.dataset: ${c.rows[0].n} rows (${c.rows[0].emb} embedded, ${c.rows[0].unl} without a prod label)`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  label — the NEW Kalshi-tail rules (subagents' extendable clusters)
// ═══════════════════════════════════════════════════════════════════════════
//
// Each rule maps a ticker-prefix (exact or substring) → event_kind. condition_shape
// is filled later from prod's dominant shape for that kind. Ordered: first match
// wins, so put specific exact prefixes before broad substring patterns.

type Rule = { kind: string; why: string };
const EXACT: Record<string, Rule> = {
  // ── sports (agent A) ──
  KXMARMADROUND: { kind: 'stage_advance', why: 'NCAA round qualify' },
  KXNFLWINS: { kind: 'other', why: 'season win total' },
  KXNCAAFWINS: { kind: 'other', why: 'season win total' },
  KXMLBWINS: { kind: 'other', why: 'season win total' },
  KXMLBHRR: { kind: 'player_prop_threshold', why: 'combined hits+runs+rbis' },
  KXNEXTTEAMNBA: { kind: 'other', why: 'next team' },
  KXNEXTTEAMNFL: { kind: 'other', why: 'next team' },
  KXNBADRAFTPICK: { kind: 'other', why: 'draft slot' },
  KXMLBDRAFTPICK: { kind: 'other', why: 'draft slot' },
  KXNBADRAFTTEAM: { kind: 'other', why: 'drafted by team' },
  KXNBADRAFTTOP: { kind: 'other', why: 'top-N draft' },
  KXMLBTEAMTOTAL: { kind: 'match_total_metric', why: 'team total runs' },
  KXMLBTOTAL: { kind: 'match_total_metric', why: 'match total runs' },
  KXMLBF5TOTAL: { kind: 'match_total_metric', why: 'first-5-innings total' },
  KXWCSTAGEOFELIM: { kind: 'stage_advance', why: 'WC stage of elimination' },
  KXLOLMAP: { kind: 'match_winner', why: 'esports map winner' },
  KXCS2MAP: { kind: 'match_winner', why: 'esports map winner' },
  KXWCSQUAD: { kind: 'other', why: 'WC squad inclusion' },
  KXNFLSEASONRECYDS: { kind: 'player_prop_threshold', why: 'season receiving yards' },
  KXMLBSEASONHR: { kind: 'player_prop_threshold', why: 'season home runs' },
  KXWCROUND: { kind: 'stage_advance', why: 'WC round qualify' },
  KXPGAPLAYERCAT: { kind: 'award_winner', why: 'top category golfer' },
  KXCYCLING: { kind: 'championship_winner', why: 'cycling GC winner' },
  KXKFTOUR: { kind: 'championship_winner', why: 'golf tour winner' },
  KXNASCARRACE: { kind: 'championship_winner', why: 'race winner' },
  KXNASCARFASTLAP: { kind: 'other', why: 'fastest lap' },
  KXMLBSPREAD: { kind: 'match_spread', why: 'run spread' },
  KXNBASPREAD: { kind: 'match_spread', why: 'point spread' },
  KXMLSSPREAD: { kind: 'match_spread', why: 'goal spread' },
  KXWCAWARD: { kind: 'award_winner', why: 'golden/silver ball' },
  KXPGAMAKECUT: { kind: 'other', why: 'make cut' },
  KXPGAEAGLE: { kind: 'player_prop_threshold', why: 'eagle prop' },
  KXPGAROUNDSCORE: { kind: 'player_prop_threshold', why: 'round score' },
  KXPGA3BALL: { kind: 'match_winner', why: '3-ball group' },
  KXMLBDEBUT: { kind: 'other', why: 'MLB debut by date' },
  // ── non-sports (agent B) ──
  KXNBAMENTION: { kind: 'speech_mention', why: 'announcer prop' },
  KXMLBMENTION: { kind: 'speech_mention', why: 'announcer prop' },
  KXWORLDCUPHALFTIME: { kind: 'award_winner', why: 'halftime performer' },
  KXMIDTERMMOV: { kind: 'election_margin', why: 'margin of victory' },
  KXMIDTERMVOTETURN: { kind: 'election_turnout', why: 'vote turnout' },
  KXBBCHARTPOSITIONSONG: { kind: 'award_winner', why: 'Billboard rank' },
  KXBBCHARTPOSITIONALBUM: { kind: 'award_winner', why: 'Billboard rank' },
  KXARTISTSTREAMS: { kind: 'social_media_metric', why: 'streams threshold' },
  KXALBUMEQUIV: { kind: 'social_media_metric', why: 'album-equivalent units' },
  KXALBUMSALES: { kind: 'social_media_metric', why: 'album sales' },
  KXAMA: { kind: 'award_winner', why: 'AMA award' },
  KXRT: { kind: 'media_release', why: 'rotten tomatoes score' },
  KXCAPRIMARY: { kind: 'primary_winner', why: 'CA primary advance' },
  KXTONYAWARDS: { kind: 'award_winner', why: 'Tony award' },
  KXECONSTATU3: { kind: 'other', why: 'unemployment print' },
  KXECONSTATCPIYOY: { kind: 'other', why: 'CPI print' },
  KXTRUMPSAY: { kind: 'speech_mention', why: 'speech mention' },
  KXTRUMPMENTION: { kind: 'speech_mention', why: 'speech mention' },
};

// Ordered substring patterns for the long tail the agents said repeats the same
// shapes (KX1SONG/KX10SONG/KXGRAMMY*/…). First match wins.
const SUBSTRING: { needle: RegExp; kind: string; why: string }[] = [
  { needle: /MENTION|SAY/, kind: 'speech_mention', why: 'speech/announcer prop' },
  { needle: /SPREAD/, kind: 'match_spread', why: 'spread' },
  { needle: /TEAMTOTAL|F5TOTAL/, kind: 'match_total_metric', why: 'team total' },
  { needle: /VOTETURN|TURNOUT/, kind: 'election_turnout', why: 'turnout' },
  { needle: /PRIMARYMOV|MIDTERMMOV|\bMOV$/, kind: 'election_margin', why: 'margin' },
  { needle: /PRIMARY/, kind: 'primary_winner', why: 'primary' },
  { needle: /CHARTPOSITION|TOPSONG|TOPALBUM|^KX\d*SONG|^KX\d*ALBUM|SONGRELEASE|ALBUMRELEASE/, kind: 'award_winner', why: 'chart/release rank' },
  { needle: /STREAMS|ALBUMEQUIV|ALBUMSALES|PUREALBUMS/, kind: 'social_media_metric', why: 'streaming metric' },
  { needle: /SEASON(PASS|RSH|REC|RUSH)?YDS|PASSYDS|RSHYDS|RECYDS/, kind: 'player_prop_threshold', why: 'season yardage prop' },
  { needle: /NASDAQ|INXU|^KXINX|SPX|DOWJONES/, kind: 'price_snapshot', why: 'index level snapshot' },
  { needle: /TOTALMAPS|MAPS$/, kind: 'match_total_metric', why: 'esports total maps' },
  { needle: /MLBRFI|RFI$|MLBF5$/, kind: 'match_total_metric', why: 'first-inning/first-5 runs' },
  { needle: /TOPAPRANK|RANKLIST|RUNNERUP/, kind: 'award_winner', why: 'ranking/chart' },
  { needle: /GRAMMY|TONY|EMMY|OSCAR|CANNES|EUROVISION|SNLHOST|AWARD|\bAMA$/, kind: 'award_winner', why: 'award' },
  { needle: /PGAR\d+TOP\d+|PGATOP\d+/, kind: 'player_prop_threshold', why: 'golf finish rank' },
  { needle: /LEAD$/, kind: 'other', why: 'round leader' },
  { needle: /GDP|CPI|UNEMP|PAYROLL|JOBLESS/, kind: 'other', why: 'econ print' },
  { needle: /WINS$/, kind: 'other', why: 'season win total' },
  { needle: /DRAFT/, kind: 'other', why: 'draft' },
  { needle: /NEXTTEAM/, kind: 'other', why: 'next team' },
  { needle: /MAP$/, kind: 'match_winner', why: 'esports map winner' },
  { needle: /STAGEOFELIM|WCROUND|MADROUND|QUALIFY/, kind: 'stage_advance', why: 'stage advance' },
  { needle: /SQUAD/, kind: 'other', why: 'squad inclusion' },
  { needle: /ECONSTAT/, kind: 'other', why: 'econ print' },
];

function classify(prefix: string, title: string): Rule | null {
  // Title-shape price rules first — crypto/commodity price series (KXBTC, KXETHD,
  // KXNATGASD, …) the agents didn't enumerate but are unambiguous from the title.
  if (/\bprice range\b/i.test(title)) return { kind: 'price_range_snapshot', why: 'price range snapshot' };
  if (/\bclose price\b/i.test(title) && /\b(above|below)\b/i.test(title)) return { kind: 'price_snapshot', why: 'commodity close threshold' };
  if (/\bprice\b/i.test(title) && /\b(on|at)\s+[A-Z][a-z]{2}/.test(title)) return { kind: 'price_snapshot', why: 'price snapshot on date' };
  if (EXACT[prefix]) return EXACT[prefix];
  for (const s of SUBSTRING) if (s.needle.test(prefix)) return { kind: s.kind, why: s.why };
  return null;
}

async function label(pool: pg.Pool): Promise<void> {
  // 1. prod dominant shape per event_kind → keeps new labels consistent.
  const sh = await pool.query<{ event_kind: string; condition_shape: string; n: string }>(
    `SELECT event_kind, condition_shape, count(*) AS n
       FROM llm_market_normalizations
      WHERE event_kind IS NOT NULL AND condition_shape IS NOT NULL
      GROUP BY 1,2`);
  const best = new Map<string, { shape: string; n: number }>();
  for (const r of sh.rows) {
    const cur = best.get(r.event_kind);
    if (!cur || Number(r.n) > cur.n) best.set(r.event_kind, { shape: r.condition_shape, n: Number(r.n) });
  }
  // Fallback shapes for kinds with no/ambiguous prod presence.
  const FALLBACK_SHAPE: Record<string, string> = {
    match_spread: 'monotonic_threshold', match_total_metric: 'monotonic_threshold',
    player_prop_threshold: 'monotonic_threshold', championship_winner: 'monotonic_threshold',
    stage_advance: 'binary_event', match_winner: 'binary_event', award_winner: 'binary_event',
    primary_winner: 'binary_event', speech_mention: 'binary_event',
    election_margin: 'point_in_time', election_turnout: 'point_in_time',
    social_media_metric: 'monotonic_threshold', media_release: 'monotonic_threshold',
    price_snapshot: 'point_in_time', price_range_snapshot: 'range_snapshot',
    price_threshold: 'monotonic_threshold', candle_direction: 'point_in_time',
    other: 'binary_event',
  };
  const shapeFor = (kind: string) => best.get(kind)?.shape ?? FALLBACK_SHAPE[kind] ?? 'binary_event';

  // 2. unnormalized Kalshi markets.
  const rows = await pool.query<{ market_id: number; ticker_prefix: string; title: string }>(
    `SELECT market_id, ticker_prefix, title FROM exp.dataset
      WHERE platform = 'kalshi' AND prod_event_kind IS NULL AND ticker_prefix IS NOT NULL`);
  console.log(`unnormalized Kalshi to label: ${rows.rows.length}`);

  // 3. classify + collect.
  const out: { market_id: number; shape: string; kind: string; rule: string }[] = [];
  const unmatched = new Map<string, number>();
  const byKind = new Map<string, number>();
  for (const r of rows.rows) {
    const rule = classify(r.ticker_prefix, r.title ?? '');
    if (!rule) { unmatched.set(r.ticker_prefix, (unmatched.get(r.ticker_prefix) ?? 0) + 1); continue; }
    out.push({ market_id: r.market_id, shape: shapeFor(rule.kind), kind: rule.kind, rule: rule.why });
    byKind.set(rule.kind, (byKind.get(rule.kind) ?? 0) + 1);
  }

  // 4. write exp.labels_new.
  await pool.query(`DROP TABLE IF EXISTS exp.labels_new`);
  await pool.query(`CREATE TABLE exp.labels_new (
      market_id integer PRIMARY KEY,
      condition_shape text NOT NULL,
      event_kind text NOT NULL,
      rule text NOT NULL)`);
  for (let i = 0; i < out.length; i += 1000) {
    const b = out.slice(i, i + 1000);
    await pool.query(
      `INSERT INTO exp.labels_new (market_id, condition_shape, event_kind, rule)
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[])`,
      [b.map(x => x.market_id), b.map(x => x.shape), b.map(x => x.kind), b.map(x => x.rule)]);
  }

  // 5. report.
  const labeled = out.length;
  const totalUnl = rows.rows.length;
  console.log(`\nLabeled ${labeled}/${totalUnl} unnormalized Kalshi (${(100 * labeled / totalUnl).toFixed(1)}%) into exp.labels_new`);
  console.log('\nnew labels by event_kind:');
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${n}`);
  const unmatchedTotal = [...unmatched.values()].reduce((a, b) => a + b, 0);
  console.log(`\nunmatched: ${unmatchedTotal} markets across ${unmatched.size} prefixes. top unmatched:`);
  for (const [p, n] of [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${p.padEnd(24)} ${n}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  embed-titles — TITLE-ONLY embeddings (to test "does the desc help or hurt?")
// ═══════════════════════════════════════════════════════════════════════════
async function embedBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: inputs, dimensions: 1536 }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) {
        const d = (await res.json()) as { data: { embedding: number[]; index: number }[] };
        return d.data.sort((a, b) => a.index - b.index).map(x => x.embedding);
      }
      lastErr = new Error(`OpenAI embed ${res.status}: ${await res.text()}`);
    } catch (e) {
      lastErr = e; // network / header timeout — retry with backoff
    }
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw lastErr;
}

async function embedTitles(pool: pg.Pool): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  await pool.query(`CREATE TABLE IF NOT EXISTS exp.title_embeddings (market_id integer PRIMARY KEY, embedding vector(1536))`);
  const missing = await pool.query<{ market_id: number; title: string }>(
    `SELECT d.market_id, d.title FROM exp.dataset d
       LEFT JOIN exp.title_embeddings t ON t.market_id = d.market_id
      WHERE t.market_id IS NULL`);
  console.log(`title-only embeddings to generate: ${missing.rows.length}`);
  if (missing.rows.length === 0) return;
  const B = 100, CONC = 2;
  let done = 0;
  for (let i = 0; i < missing.rows.length; i += B * CONC) {
    const group = [] as { idx: number; rows: { market_id: number; title: string }[] }[];
    for (let c = 0; c < CONC; c++) {
      const chunk = missing.rows.slice(i + c * B, i + (c + 1) * B);
      if (chunk.length) group.push({ idx: c, rows: chunk });
    }
    await Promise.all(group.map(async g => {
      const vecs = await embedBatch(apiKey, g.rows.map(r => (r.title ?? '').slice(0, 400) || ' '));
      await pool.query(
        `INSERT INTO exp.title_embeddings (market_id, embedding)
         SELECT * FROM unnest($1::int[], $2::text[]::vector[])
         ON CONFLICT (market_id) DO NOTHING`,
        [g.rows.map(r => r.market_id), g.rows.map((r, j) => `[${vecs[j].join(',')}]`)]);
    }));
    done += group.reduce((s, g) => s + g.rows.length, 0);
    if (done % 5000 < B * CONC) console.log(`  …${done}/${missing.rows.length}`);
  }
  console.log(`title-only embeddings done: ${done}`);
}

async function main() {
  const mode = process.argv[2] ?? 'schema';
  const pool = makePool();
  try {
    if (mode === 'schema') await buildSchema(pool);
    else if (mode === 'label') await label(pool);
    else if (mode === 'embed-titles') await embedTitles(pool);
    else { console.error(`unknown mode: ${mode} (use: schema | label | embed-titles)`); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
