/** Parses the genuine resolution_source oracle from platform-native raw payloads and fills NULL
 *  rows. Soundness contract: NULL over guessing — never a bare platform name or code-path tag. */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';

const log = createLogger('resolution-oracle');

// Every value the parser can ever emit. Existing DB spellings are reused verbatim so parsed
// values merge with handler-stamped ones rather than fragmenting.
export const RESOLUTION_ORACLES = new Set<string>([
  'UMA',
  'Chainlink', 'Binance', 'Pyth', 'Coinbase', 'CoinGecko', 'Kraken',
  'CF Benchmarks', 'CME Group', 'Yahoo Finance',
  'Federal Reserve', 'BLS', 'BEA', 'EIA', 'NWS', 'NOAA',
  'Associated Press', 'Bloomberg', 'Reuters', 'Nielsen', 'Billboard', 'Spotify',
  'HLTV', 'Dotabuff', 'Liquipedia', 'VLR.gg', 'gol.gg',
  'ATP Tour', 'WTA', 'ITF', 'FIFA', 'PGA Tour', 'PPA Tour', 'Formula 1', 'UFC',
  'NBA', 'NHL', 'NFL', 'MLB', 'MLS', 'NWSL', 'EFL',
  'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1', 'Serie A', 'Eredivisie',
  'ESPN', 'ESPNcricinfo', 'IPL', 'CBF', 'CONMEBOL', 'J.League',
  'Weather Underground',
]);

/** Host → canonical authority; matching is suffix-on-dot (host === domain || host endsWith
 *  '.'+domain), so subdomains resolve without a `notbinance.com`-style false positive.
 *  Unrecognized hosts fall through to the UMA fallback (precision over an ever-growing table). */
const HOST_ORACLE: ReadonlyArray<readonly [string, string]> = [
  ['chain.link', 'Chainlink'],
  ['pythdata.app', 'Pyth'],
  ['pyth.network', 'Pyth'],
  ['binance.com', 'Binance'],
  ['coinbase.com', 'Coinbase'],
  ['coingecko.com', 'CoinGecko'],
  ['kraken.com', 'Kraken'],
  ['cmegroup.com', 'CME Group'],
  ['finance.yahoo.com', 'Yahoo Finance'],
  ['yahoo.com', 'Yahoo Finance'],
  ['hltv.org', 'HLTV'],
  ['dotabuff.com', 'Dotabuff'],
  ['liquipedia.net', 'Liquipedia'],
  ['vlr.gg', 'VLR.gg'],
  ['gol.gg', 'gol.gg'],
  ['atptour.com', 'ATP Tour'],
  ['wtatennis.com', 'WTA'],
  ['itftennis.com', 'ITF'],
  ['pgatour.com', 'PGA Tour'],
  ['ppatour.com', 'PPA Tour'],
  ['formula1.com', 'Formula 1'],
  ['ufc.com', 'UFC'],
  ['fifa.com', 'FIFA'],
  ['nba.com', 'NBA'],
  ['nhl.com', 'NHL'],
  ['nfl.com', 'NFL'],
  ['mlb.com', 'MLB'],
  ['mlssoccer.com', 'MLS'],
  ['nwslsoccer.com', 'NWSL'],
  ['efl.com', 'EFL'],
  ['premierleague.com', 'Premier League'],
  ['laliga.com', 'La Liga'],
  ['bundesliga.com', 'Bundesliga'],
  ['ligue1.com', 'Ligue 1'],
  ['legaseriea.it', 'Serie A'],
  ['eredivisie.nl', 'Eredivisie'],
  ['jleague.jp', 'J.League'],
  ['cbf.com.br', 'CBF'],
  ['conmebol.com', 'CONMEBOL'],
  ['conmebollibertadores.com', 'CONMEBOL'],
  ['espncricinfo.com', 'ESPNcricinfo'],
  ['wunderground.com', 'Weather Underground'],
  // Cross-venue with the kalshi rules arm: a PM/predict Fed clause linking this host
  // matches Kalshi's 'Federal Reserve', the same-oracle signal basis-risk refinement wants.
  ['federalreserve.gov', 'Federal Reserve'],
  ['bls.gov', 'BLS'],
  ['bea.gov', 'BEA'],
];

// Keyword vocabulary for the description clause; ordered, first match wins. Excludes bare
// short ambiguous tokens (e.g. "AP") that collide with common words.
const CLAUSE_VOCAB: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfederal reserve\b/i, 'Federal Reserve'],
  [/\bFOMC\b/, 'Federal Reserve'],
  [/\bbureau of labor statistics\b/i, 'BLS'],
  [/\bbureau of economic analysis\b/i, 'BEA'],
  [/\bassociated press\b/i, 'Associated Press'],
  [/\bbloomberg\b/i, 'Bloomberg'],
  [/\breuters\b/i, 'Reuters'],
  [/\bnielsen\b/i, 'Nielsen'],
  [/\bbillboard\b/i, 'Billboard'],
  [/\bspotify\b/i, 'Spotify'],
  [/\bchainlink\b/i, 'Chainlink'],
  [/\bbinance\b/i, 'Binance'],
  [/\bcoinbase\b/i, 'Coinbase'],
  [/\bcoingecko\b/i, 'CoinGecko'],
  [/\bpyth\b/i, 'Pyth'],
  [/\bespncricinfo\b/i, 'ESPNcricinfo'],
  [/\bespn\b/i, 'ESPN'],
  [/\bindian premier league\b|\bIPL\b/, 'IPL'],
  [/\bpremier league\b/i, 'Premier League'],
  [/\bla ?liga\b/i, 'La Liga'],
  [/\bbundesliga\b/i, 'Bundesliga'],
  [/\bserie a\b/i, 'Serie A'],
  [/\bligue 1\b/i, 'Ligue 1'],
  [/\beredivisie\b/i, 'Eredivisie'],
  [/\bformula 1\b|\bformula1\b/i, 'Formula 1'],
  [/\bpga tour\b/i, 'PGA Tour'],
  [/\batp tour\b|\batptour\b/i, 'ATP Tour'],
  [/\bwta\b/, 'WTA'],
  [/\bufc\b/i, 'UFC'],
  [/\bNBA\b/, 'NBA'],
  [/\bNHL\b/, 'NHL'],
  [/\bNFL\b/, 'NFL'],
  [/\bMLB\b/, 'MLB'],
  [/\bMLS\b/, 'MLS'],
  [/\bFIFA\b/, 'FIFA'],
];

/** Parse the hostname out of a URL (defensive — the field may be a bare host or path). */
function hostOf(url: string): string | null {
  const m = url.trim().match(/^https?:\/\/([^/\s?#]+)/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

function hostToOracle(host: string | null): string | null {
  if (!host) return null;
  for (const [domain, oracle] of HOST_ORACLE) {
    if (host === domain || host.endsWith('.' + domain)) return oracle;
  }
  return null;
}

function oracleFromResolutionSourceUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return hostToOracle(hostOf(url));
}

/** An Ethereum contract address (0x + 40 hex) — the shape of PM `resolvedBy` / any adapter. */
const ETH_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Isolates the "resolution source …" clause (≤220-char window) and reads the first named
 *  authority: URL host first, then the keyword vocabulary; null if none is recognized. */
function oracleFromDescriptionClause(description: string | null | undefined): string | null {
  if (!description) return null;
  const idx = description.toLowerCase().indexOf('resolution source');
  if (idx < 0) return null;
  const window = description.slice(idx, idx + 220);

  const urlMatch = window.match(/https?:\/\/[^\s"')]+/i);
  if (urlMatch) {
    const oracle = hostToOracle(hostOf(urlMatch[0]));
    if (oracle) return oracle;
  }
  for (const [rx, oracle] of CLAUSE_VOCAB) {
    if (rx.test(window)) return oracle;
  }
  return null;
}

/** Kalshi rules describe settlement mechanics far more than they name an oracle, so only
 *  high-confidence, context-gated authorities are recovered here. */
function oracleFromKalshiRules(
  rulesPrimary: string | null | undefined,
  rulesSecondary: string | null | undefined,
): string | null {
  const text = `${rulesPrimary ?? ''} ${rulesSecondary ?? ''}`;
  if (text.trim() === '') return null;
  const lower = text.toLowerCase();

  // Requires Fed + a rate-context token, so an incidental mention in unrelated econ prose can't false-stamp.
  if (
    (/\bfederal reserve\b/.test(lower) || /\bfomc\b/.test(lower)) &&
    /\bbasis point|\bbps\b|\brate\b|\bhike|\bcut\b|target range/.test(lower)
  ) {
    return 'Federal Reserve';
  }
  if (/\bassociated press\b/.test(lower)) return 'Associated Press';
  if (/\bbureau of labor statistics\b/.test(lower)) return 'BLS';
  if (/\bbureau of economic analysis\b/.test(lower)) return 'BEA';
  if (/\bnational weather service\b/.test(lower)) return 'NWS';
  if (/\benergy information administration\b/.test(lower)) return 'EIA';
  return null;
}

/** True when `polymarketConditionIds` is a non-empty JSON array — the market settles
 *  against the SAME UMA CTF condition as its Polymarket twin. */
function predictSharesUmaCondition(polymarketConditionIds: string | null | undefined): boolean {
  if (!polymarketConditionIds) return false;
  const s = polymarketConditionIds.trim();
  if (s === '' || s === '[]' || s === 'null') return false;
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return s.length > 2;
  }
}

export interface OracleParseInput {
  platform: string;
  resolutionSource?: string | null;
  /** PM `resolvedBy` — the UMA CTF-adapter contract address. */
  resolvedBy?: string | null;
  polymarketConditionIds?: string | null;
  description?: string | null;
  rulesPrimary?: string | null;
  rulesSecondary?: string | null;
}

/** Pure + total (never throws; null on any doubt). Non-null output is always a member of {@link RESOLUTION_ORACLES}. */
export function parseResolutionOracle(input: OracleParseInput): string | null {
  let oracle: string | null = null;
  switch (input.platform) {
    case 'polymarket':
      // resolutionSource URL wins, then a named authority in the description, then UMA.
      oracle =
        oracleFromResolutionSourceUrl(input.resolutionSource) ??
        oracleFromDescriptionClause(input.description) ??
        (input.resolvedBy && ETH_ADDRESS.test(input.resolvedBy.trim()) ? 'UMA' : null);
      break;

    case 'predict':
      oracle =
        oracleFromDescriptionClause(input.description) ??
        (predictSharesUmaCondition(input.polymarketConditionIds) ? 'UMA' : null);
      break;

    case 'kalshi':
      oracle = oracleFromKalshiRules(input.rulesPrimary, input.rulesSecondary);
      break;

    case 'limitless':
      oracle = oracleFromDescriptionClause(input.description);
      break;

    default:
      oracle = null;
  }

  if (oracle != null && !RESOLUTION_ORACLES.has(oracle)) return null;
  return oracle;
}

export interface ResolutionOracleStats {
  scanned: number;
  stamped: number;
  byPlatform: Record<string, number>;
  byOracle: Record<string, number>;
  durationMs: number;
}

interface OracleRow {
  market_id: number;
  platform: string;
  pm_resolution_source: string | null;
  pm_resolved_by: string | null;
  predict_pm_condition_ids: string | null;
  description: string | null;
  rules_primary: string | null;
  rules_secondary: string | null;
}

/** Fills NULL `resolution_source` rows. Additive + idempotent: only NULL rows are touched and
 *  the UPDATE re-asserts `IS NULL`, so a second run is a no-op. Keyset-paginated on market_id. */
export async function runResolutionOraclePass(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<ResolutionOracleStats> {
  const batchSize = opts.batchSize ?? 2000;
  const dryRun = opts.dryRun ?? false;
  const start = Date.now();

  const stats: ResolutionOracleStats = {
    scanned: 0,
    stamped: 0,
    byPlatform: {},
    byOracle: {},
    durationMs: 0,
  };

  let lastId = 0;
  for (;;) {
    const rows = await query<OracleRow>(
      `SELECT n.market_id,
              m.platform,
              mr.raw->>'resolutionSource'       AS pm_resolution_source,
              mr.raw->>'resolvedBy'             AS pm_resolved_by,
              mr.raw->>'polymarketConditionIds' AS predict_pm_condition_ids,
              mr.raw->>'description'            AS description,
              mr.raw->>'rules_primary'          AS rules_primary,
              mr.raw->>'rules_secondary'        AS rules_secondary
         FROM llm_market_normalizations n
         JOIN markets m               ON m.id = n.market_id
         JOIN market_metadata_raw mr  ON mr.market_id = n.market_id
        WHERE n.resolution_source IS NULL
          AND n.market_id > $1
        ORDER BY n.market_id
        LIMIT $2`,
      [lastId, batchSize],
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].market_id;
    stats.scanned += rows.length;

    const ids: number[] = [];
    const oracles: string[] = [];
    for (const r of rows) {
      const oracle = parseResolutionOracle({
        platform: r.platform,
        resolutionSource: r.pm_resolution_source,
        resolvedBy: r.pm_resolved_by,
        polymarketConditionIds: r.predict_pm_condition_ids,
        description: r.description,
        rulesPrimary: r.rules_primary,
        rulesSecondary: r.rules_secondary,
      });
      if (oracle == null) continue;
      ids.push(r.market_id);
      oracles.push(oracle);
      stats.stamped += 1;
      stats.byPlatform[r.platform] = (stats.byPlatform[r.platform] ?? 0) + 1;
      stats.byOracle[oracle] = (stats.byOracle[oracle] ?? 0) + 1;
    }

    if (!dryRun && ids.length > 0) {
      // Re-asserts IS NULL so this never clobbers a value another path already set.
      await query(
        `UPDATE llm_market_normalizations AS n
            SET resolution_source = v.oracle
           FROM (SELECT unnest($1::int[]) AS market_id, unnest($2::text[]) AS oracle) AS v
          WHERE n.market_id = v.market_id
            AND n.resolution_source IS NULL`,
        [ids, oracles],
      );
    }

    if (rows.length < batchSize) break;
  }

  stats.durationMs = Date.now() - start;
  log.info(
    `RESOLUTION_ORACLE_CENSUS ${JSON.stringify({
      scanned: stats.scanned,
      stamped: stats.stamped,
      byPlatform: stats.byPlatform,
      dryRun,
      durationMs: stats.durationMs,
    })}`,
  );
  return stats;
}
