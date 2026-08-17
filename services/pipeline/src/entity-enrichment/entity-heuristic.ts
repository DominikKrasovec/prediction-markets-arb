/** Rule-based entity classifier (regex/lookup only, no ML/LLM) resolving
 *  entity_type/sport_canonical/league_canonical deterministically. */
import type { EntityType } from '@arb/types';

export type EntityTypeHint = EntityType;

export interface EntityContext {
  canonical: string;
  aliases: string[];
  domain_category: string;
  current_type: string;
  sample_titles: string[];
  tag_slugs?: string[];
  limitless_sport?: string | null;
  limitless_league?: string | null;
  kalshi_ticker_prefix?: string | null;
  predict_tag_names?: string[] | null;
}

export interface EntityClassification {
  entity_type: EntityTypeHint;
  sport_canonical: string | null;
  /** Null = uncertain. */
  league_canonical: string | null;
  notes: string[];
}

const ALL_CAPS_TICKER = /^[A-Z0-9]{2,5}$/;
const PERSON_LIKE = /^[A-Z][A-Za-z]+(?:[\s\-'][A-Z][A-Za-z]+){1,3}$/;
const TEAM_KEYWORDS = [
  'fc', 'sc', 'united', 'city', 'rovers', 'wanderers', 'rangers',
  'esports', 'gaming', 'clan', 'squad',
];

/** First-token club-name signal ("Real Madrid", "RB Leipzig", "AC Milan") that would
 *  otherwise fall through PERSON_LIKE; matched against the first whitespace token only. */
const SPORTS_CLUB_PREFIX_TOKENS = new Set<string>([
  'real', 'atletico', 'atlético', 'athletic', 'deportivo', 'club',
  'fc', 'cf', 'sc', 'ac', 'as', 'us', 'rb', 'cd', 'cr', 'ec', 'sk', 'sv', 'fk',
  'rcd', 'tsg', 'msv', 'kv', 'kaa', 'krc', 'aj', 'rc', 'tsv', 'vfl', 'vfb',
  'ogc', 'osc', 'sd', 'ud', 'ca',
  'olympique', 'olimpia', 'olimpico', 'inter', 'lazio', 'roma',
  'team', 'gen.g',
]);

/** Whitelisted plural team nouns — a bare "ends in s" rule over-matches Latin/Spanish surnames.
 *  Multi-word irregulars ("Red Sox", "Maple Leafs") are handled by US_TEAM_PLURAL_PHRASES instead. */
const US_TEAM_PLURAL_TOKENS = new Set<string>([
  'tigers', 'yankees', 'mets', 'dodgers', 'astros', 'cubs', 'cardinals', 'pirates',
  'braves', 'phillies', 'nationals', 'marlins', 'reds', 'brewers', 'royals',
  'twins', 'mariners', 'orioles', 'rangers', 'rays', 'diamondbacks', 'rockies',
  'angels', 'guardians', 'athletics',
  'lakers', 'bulls', 'celtics', 'knicks', 'nets', 'sixers', 'raptors',
  'warriors', 'rockets', 'kings', 'clippers', 'nuggets', 'mavericks', 'grizzlies',
  'hawks', 'pelicans', 'hornets', 'pistons', 'cavaliers', 'pacers',
  'spurs', 'bucks', 'wizards', 'timberwolves', 'suns',
  'patriots', 'dolphins', 'jets', 'bills', 'steelers', 'ravens', 'browns', 'bengals',
  'texans', 'colts', 'jaguars', 'titans', 'chiefs', 'raiders', 'chargers', 'broncos',
  'cowboys', 'eagles', 'giants', 'commanders', 'bears', 'lions', 'packers', 'vikings',
  'falcons', 'panthers', 'saints', 'buccaneers', 'seahawks', 'rams',
  'islanders', 'devils', 'flyers', 'penguins', 'capitals', 'hurricanes',
  'bruins', 'sabres', 'senators', 'flames', 'canucks', 'oilers', 'sharks',
  'ducks', 'predators', 'stars', 'blackhawks', 'blues', 'panthers',
  'sounders', 'whitecaps', 'timbers', 'earthquakes', 'rapids', 'rowdies',
]);

const US_TEAM_PLURAL_PHRASES: ReadonlyArray<RegExp> = [
  /\bred\s+sox\s*$/i,
  /\bwhite\s+sox\s*$/i,
  /\bblue\s+jays\s*$/i,
  /\bmaple\s+leafs\s*$/i,
  /\bred\s+wings\s*$/i,
  /\btrail\s+blazers\s*$/i,
  /\bgolden\s+state\s+warriors\s*$/i,
];

/** Matches a 2-4 token canonical ending in a known plural team noun or phrase. */
function looksLikeUSTeamPlural(form: string): boolean {
  const trimmed = form.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  for (const phrase of US_TEAM_PLURAL_PHRASES) {
    if (phrase.test(trimmed)) return true;
  }
  const last = tokens[tokens.length - 1].toLowerCase();
  return US_TEAM_PLURAL_TOKENS.has(last);
}

/** Irregular US-team last tokens that don't end in 's' (Heat, Jazz, Magic, …). */
const US_TEAM_KNOWN_SINGULARS = new Set<string>([
  'heat', 'jazz', 'magic', 'thunder', 'wild', 'avalanche', 'lightning',
  'crew', 'galaxy', 'union', 'fire', 'storm', 'sky', 'dynamo',
]);

function looksLikeSportsTeam(form: string): boolean {
  const trimmed = form.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  const firstLower = tokens[0].toLowerCase();
  if (SPORTS_CLUB_PREFIX_TOKENS.has(firstLower)) return true;
  if (looksLikeUSTeamPlural(trimmed)) return true;
  const lastLower = tokens[tokens.length - 1].toLowerCase();
  if (US_TEAM_KNOWN_SINGULARS.has(lastLower)) return true;
  return false;
}

/** Polymarket tag slug → sport_canonical, matched case-insensitively; null = too broad to map. */
export const POLYMARKET_SLUG_TO_SPORT: Record<string, string | null> = {
  soccer: 'soccer',
  basketball: 'basketball',
  tennis: 'tennis',
  baseball: 'baseball',
  hockey: 'ice-hockey',
  cricket: 'cricket',
  golf: 'golf',
  rugby: 'rugby',
  mma: 'mma',
  boxing: 'boxing',
  volleyball: 'volleyball',
  nba: 'basketball',
  wnba: 'basketball',
  nfl: 'american-football',
  mlb: 'baseball',
  nhl: 'ice-hockey',
  epl: 'soccer',
  'la-liga': 'soccer',
  'ligue-1': 'soccer',
  bundesliga: 'soccer',
  'serie-a': 'soccer',
  'ncaa-basketball': 'basketball',
  'ncaa-football': 'american-football',
  'counter-strike-2': 'cs2',
  'league-of-legends': 'lol',
  'dota-2': 'dota2',
  valorant: 'valorant',
  'starcraft-2': 'starcraft2',
  'rocket-league': 'rocket-league',
  overwatch: 'overwatch',
  'overwatch-2': 'overwatch',
  esports: null,
  sports: null,
  games: null,
};

/** Limitless metadata.esportTitle → sport_canonical, matched case-insensitively. */
export const LIMITLESS_SPORT_MAP: Record<string, string> = {
  'counter-strike 2': 'cs2',
  'counter-strike: global offensive': 'cs:go',
  'league of legends': 'lol',
  'dota 2': 'dota2',
  valorant: 'valorant',
  'starcraft 2': 'starcraft2',
  'starcraft ii': 'starcraft2',
  'rocket league': 'rocket-league',
  overwatch: 'overwatch',
  'overwatch 2': 'overwatch',
  'rainbow six siege': 'rainbow-six',
  'call of duty': 'call-of-duty',
  fortnite: 'fortnite',
  'apex legends': 'apex-legends',
  pubg: 'pubg',
};

/** event_ticker prefix (split_part(event_ticker,'-',1), e.g. "KXNBA") → sport/league/asset_class. */
interface KalshiPrefixEntry {
  sport: string | null;
  league: string | null;
  asset_class: 'crypto' | 'commodity' | 'index' | 'equity' | 'economic' | null;
}

const KALSHI_TICKER_PREFIX_MAP: Record<string, KalshiPrefixEntry> = {
  KXNBA:                        { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBA1H:                      { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBA2H:                      { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBAAST:                     { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBABLK:                     { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBADRAFTPICK:               { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBAGAME:                    { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBAOVERTIME:                { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBAPLS:                     { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBAPTS:                     { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBAREB:                     { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBASERIES:                  { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBASPREAD:                  { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBASTL:                     { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBATOTAL:                   { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNBA3PT:                     { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXNEXTTEAMNBA:                { sport: 'basketball',          league: 'NBA',                          asset_class: null },
  KXWNBA:                       { sport: 'basketball',          league: 'WNBA',                         asset_class: null },
  KXACB:                        { sport: 'basketball',          league: 'ACB',                          asset_class: null },
  KXBSL:                        { sport: 'basketball',          league: 'BSL',                          asset_class: null },
  KXJBLEAGUE:                   { sport: 'basketball',          league: 'Japan B.League',               asset_class: null },
  KXJBLEAGUEGAME:               { sport: 'basketball',          league: 'Japan B.League',               asset_class: null },
  KXLNBELITE:                   { sport: 'basketball',          league: 'LNB Elite',                    asset_class: null },
  KXVTB:                        { sport: 'basketball',          league: 'VTB League',                   asset_class: null },
  KXMLB:                        { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXMLBAST:                     { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXMLBGAME:                    { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXMLBHOMERS:                  { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXMLBPLS:                     { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXMLBPTS:                     { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXMLBSERIES:                  { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXMLBSPREAD:                  { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXMLBTOTAL:                   { sport: 'baseball',            league: 'MLB',                          asset_class: null },
  KXKBO:                        { sport: 'baseball',            league: 'KBO',                          asset_class: null },
  KXKBOG:                       { sport: 'baseball',            league: 'KBO',                          asset_class: null },
  KXNPB:                        { sport: 'baseball',            league: 'NPB',                          asset_class: null },
  KXNFL:                        { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNFLAST:                     { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNFLGAME:                    { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNFLPLS:                     { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNFLPTS:                     { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNFLSERIES:                  { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNFLSPREAD:                  { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNFLTOTAL:                   { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNEXTTEAMNFL:                { sport: 'american-football',   league: 'NFL',                          asset_class: null },
  KXNCAAF:                      { sport: 'american-football',   league: 'NCAAF',                        asset_class: null },
  KXNHL:                        { sport: 'ice-hockey',          league: 'NHL',                          asset_class: null },
  KXNHLAST:                     { sport: 'ice-hockey',          league: 'NHL',                          asset_class: null },
  KXNHLGAME:                    { sport: 'ice-hockey',          league: 'NHL',                          asset_class: null },
  KXNHLPLS:                     { sport: 'ice-hockey',          league: 'NHL',                          asset_class: null },
  KXNHLPTS:                     { sport: 'ice-hockey',          league: 'NHL',                          asset_class: null },
  KXNHLSERIES:                  { sport: 'ice-hockey',          league: 'NHL',                          asset_class: null },
  KXNHLSPREAD:                  { sport: 'ice-hockey',          league: 'NHL',                          asset_class: null },
  KXNHLTOTAL:                   { sport: 'ice-hockey',          league: 'NHL',                          asset_class: null },
  KXAHLGAME:                    { sport: 'ice-hockey',          league: 'AHL',                          asset_class: null },
  KXEPL:                        { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPL1H:                      { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLBTTS:                    { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLGAME:                    { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLPLS:                     { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLRELEGATION:              { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLSERIES:                  { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLSPREAD:                  { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLTOP2:                    { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLTOP4:                    { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLTOP6:                    { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEPLTOTAL:                   { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXPREMIERLEAGUE:              { sport: 'soccer',              league: 'Premier League',               asset_class: null },
  KXEWSL:                       { sport: 'soccer',              league: "Women's Super League",         asset_class: null },
  KXEWSLGAME:                   { sport: 'soccer',              league: "Women's Super League",         asset_class: null },
  KXFACUP:                      { sport: 'soccer',              league: 'FA Cup',                       asset_class: null },
  KXLALIGA2:                    { sport: 'soccer',              league: 'La Liga 2',                    asset_class: null },
  KXLALIGA2GAME:                { sport: 'soccer',              league: 'La Liga 2',                    asset_class: null },
  KXLALIGA:                     { sport: 'soccer',              league: 'La Liga',                      asset_class: null },
  KXLALIGA1H:                   { sport: 'soccer',              league: 'La Liga',                      asset_class: null },
  KXLALIGABTTS:                 { sport: 'soccer',              league: 'La Liga',                      asset_class: null },
  KXLALIGAGAME:                 { sport: 'soccer',              league: 'La Liga',                      asset_class: null },
  KXLALIGARELEGATION:           { sport: 'soccer',              league: 'La Liga',                      asset_class: null },
  KXLALIGASPREAD:               { sport: 'soccer',              league: 'La Liga',                      asset_class: null },
  KXLALIGATOP4:                 { sport: 'soccer',              league: 'La Liga',                      asset_class: null },
  KXLALIGATOTAL:                { sport: 'soccer',              league: 'La Liga',                      asset_class: null },
  KXBUNDESLIGA2:                { sport: 'soccer',              league: '2. Bundesliga',                asset_class: null },
  KXBUNDESLIGA2GAME:            { sport: 'soccer',              league: '2. Bundesliga',                asset_class: null },
  KXBUNDESLIGA:                 { sport: 'soccer',              league: 'Bundesliga',                   asset_class: null },
  KXBUNDESLIGA1H:               { sport: 'soccer',              league: 'Bundesliga',                   asset_class: null },
  KXBUNDESLIGABTTS:             { sport: 'soccer',              league: 'Bundesliga',                   asset_class: null },
  KXBUNDESLIGAGAME:             { sport: 'soccer',              league: 'Bundesliga',                   asset_class: null },
  KXBUNDESLIGARELEGATION:       { sport: 'soccer',              league: 'Bundesliga',                   asset_class: null },
  KXBUNDESLIGASPREAD:           { sport: 'soccer',              league: 'Bundesliga',                   asset_class: null },
  KXBUNDESLIGATOP4:             { sport: 'soccer',              league: 'Bundesliga',                   asset_class: null },
  KXBUNDESLIGATOTAL:            { sport: 'soccer',              league: 'Bundesliga',                   asset_class: null },
  KXSERIEB:                     { sport: 'soccer',              league: 'Serie B',                      asset_class: null },
  KXSERIEA:                     { sport: 'soccer',              league: 'Serie A',                      asset_class: null },
  KXSERIEAGAME:                 { sport: 'soccer',              league: 'Serie A',                      asset_class: null },
  KXLIGUE1:                     { sport: 'soccer',              league: 'Ligue 1',                      asset_class: null },
  KXLIGUE11H:                   { sport: 'soccer',              league: 'Ligue 1',                      asset_class: null },
  KXLIGUE1BTTS:                 { sport: 'soccer',              league: 'Ligue 1',                      asset_class: null },
  KXLIGUE1GAME:                 { sport: 'soccer',              league: 'Ligue 1',                      asset_class: null },
  KXLIGUE1RELEGATION:           { sport: 'soccer',              league: 'Ligue 1',                      asset_class: null },
  KXLIGUE1SPREAD:               { sport: 'soccer',              league: 'Ligue 1',                      asset_class: null },
  KXLIGUE1TOP4:                 { sport: 'soccer',              league: 'Ligue 1',                      asset_class: null },
  KXLIGUE1TOTAL:                { sport: 'soccer',              league: 'Ligue 1',                      asset_class: null },
  KXEREDIVISIE:                 { sport: 'soccer',              league: 'Eredivisie',                   asset_class: null },
  KXEREDIVISIEGAME:             { sport: 'soccer',              league: 'Eredivisie',                   asset_class: null },
  KXMLS:                        { sport: 'soccer',              league: 'MLS',                          asset_class: null },
  KXMLSGAME:                    { sport: 'soccer',              league: 'MLS',                          asset_class: null },
  KXNWSLGAME:                   { sport: 'soccer',              league: 'NWSL',                         asset_class: null },
  KXWC:                         { sport: 'soccer',              league: 'FIFA World Cup',               asset_class: null },
  KXWCCONTINENT:                { sport: 'soccer',              league: 'FIFA World Cup',               asset_class: null },
  KXWCGAME:                     { sport: 'soccer',              league: 'FIFA World Cup',               asset_class: null },
  KXWCGOALLEADER:               { sport: 'soccer',              league: 'FIFA World Cup',               asset_class: null },
  KXWCGROUPQUAL:                { sport: 'soccer',              league: 'FIFA World Cup',               asset_class: null },
  KXWCGROUPWIN:                 { sport: 'soccer',              league: 'FIFA World Cup',               asset_class: null },
  KXWCROUND:                    { sport: 'soccer',              league: 'FIFA World Cup',               asset_class: null },
  KXWCSQUAD:                    { sport: 'soccer',              league: 'FIFA World Cup',               asset_class: null },
  KXCONMEBOLSUD:                { sport: 'soccer',              league: 'Copa Sudamericana',            asset_class: null },
  KXCONMEBOLLIBG:               { sport: 'soccer',              league: 'Copa Libertadores',            asset_class: null },
  KXBRASILEIR:                  { sport: 'soccer',              league: 'Brasileirão',                  asset_class: null },
  KXARGPREMDIV:                 { sport: 'soccer',              league: 'Argentine Primera División',   asset_class: null },
  KXPERLIGA1:                   { sport: 'soccer',              league: 'Liga 1 Perú',                  asset_class: null },
  KXPERLIGA1GAME:               { sport: 'soccer',              league: 'Liga 1 Perú',                  asset_class: null },
  KXECULP:                      { sport: 'soccer',              league: 'LigaPro Ecuador',              asset_class: null },
  KXDIMAYORG:                   { sport: 'soccer',              league: 'Dimayor (Colombia)',           asset_class: null },
  KXALLSVENSKAN:                { sport: 'soccer',              league: 'Allsvenskan',                  asset_class: null },
  KXELITSERIEN:                 { sport: 'soccer',              league: 'Eliteserien',                  asset_class: null },
  KXLIGAPORTUGAL:               { sport: 'soccer',              league: 'Primeira Liga',                asset_class: null },
  KXSUPERLIG:                   { sport: 'soccer',              league: 'Süper Lig',                    asset_class: null },
  KXEFLCHAMPIONSHIP:            { sport: 'soccer',              league: 'EFL Championship',             asset_class: null },
  KXEFLL1:                      { sport: 'soccer',              league: 'EFL League One',               asset_class: null },
  KXEFL:                        { sport: 'soccer',              league: 'EFL Championship',             asset_class: null },
  KXNWSL:                       { sport: 'soccer',              league: 'NWSL',                         asset_class: null },
  KXUSL:                        { sport: 'soccer',              league: 'USL Championship',             asset_class: null },
  KXJLEAGUE:                    { sport: 'soccer',              league: 'J-League',                     asset_class: null },
  KXISL:                        { sport: 'soccer',              league: 'Indian Super League',          asset_class: null },
  KXSAUDIP:                     { sport: 'soccer',              league: 'Saudi Pro League',             asset_class: null },
  KXEGYPL:                      { sport: 'soccer',              league: 'Egyptian Premier League',      asset_class: null },
  KXTHAIL1:                     { sport: 'soccer',              league: 'Thai League 1',                asset_class: null },
  KXATPMATCH:                   { sport: 'tennis',              league: 'ATP Tour',                     asset_class: null },
  KXATPSETWINNER:               { sport: 'tennis',              league: 'ATP Tour',                     asset_class: null },
  KXATPCHALLENGER:              { sport: 'tennis',              league: 'ATP Challenger',               asset_class: null },
  KXWTAMATCH:                   { sport: 'tennis',              league: 'WTA Tour',                     asset_class: null },
  KXWTACHALLENGER:              { sport: 'tennis',              league: 'WTA Challenger',               asset_class: null },
  KXITFMATCH:                   { sport: 'tennis',              league: 'ITF',                          asset_class: null },
  KXITFWMATCH:                  { sport: 'tennis',              league: 'ITF',                          asset_class: null },
  KXITTFMEN:                    { sport: 'table-tennis',        league: 'ITTF',                         asset_class: null },
  KXPGAH2H:                     { sport: 'golf',                league: 'PGA Tour',                     asset_class: null },
  KXUFCFIGHT:                   { sport: 'mma',                 league: 'UFC',                          asset_class: null },
  KXBOXING:                     { sport: 'boxing',              league: null,                           asset_class: null },
  KXIPL:                        { sport: 'cricket',             league: 'IPL',                          asset_class: null },
  KXBBL:                        { sport: 'cricket',             league: 'Big Bash League',              asset_class: null },
  KXCS2MAP:                     { sport: 'cs2',                 league: null,                           asset_class: null },
  KXCS2GAME:                    { sport: 'cs2',                 league: null,                           asset_class: null },
  KXCS2TOTALMAPS:               { sport: 'cs2',                 league: null,                           asset_class: null },
  KXLOLMAP:                     { sport: 'lol',                 league: null,                           asset_class: null },
  KXLOLGAME:                    { sport: 'lol',                 league: null,                           asset_class: null },
  KXLOLTOTALMAPS:               { sport: 'lol',                 league: null,                           asset_class: null },
  KXVALORANTMAP:                { sport: 'valorant',            league: null,                           asset_class: null },
  KXVALORANTGAME:               { sport: 'valorant',            league: null,                           asset_class: null },
  KXDOTA2MAP:                   { sport: 'dota2',               league: null,                           asset_class: null },
  KXCODMAP:                     { sport: 'call-of-duty',        league: null,                           asset_class: null },
  KXCODGAME:                    { sport: 'call-of-duty',        league: null,                           asset_class: null },
  KXCODTOTALMAPS:               { sport: 'call-of-duty',        league: null,                           asset_class: null },
  KXAFLGAME:                    { sport: 'australian-football', league: 'AFL',                          asset_class: null },
  KXRUGBYNRLMATCH:              { sport: 'rugby-league',        league: 'NRL',                          asset_class: null },
  KXNCAAMLAX:                   { sport: 'lacrosse',            league: 'NCAA',                         asset_class: null },

  KXBTC:                        { sport: null, league: null, asset_class: 'crypto' },
  KXETH:                        { sport: null, league: null, asset_class: 'crypto' },
  KXSOL:                        { sport: null, league: null, asset_class: 'crypto' },
  KXDOGE:                       { sport: null, league: null, asset_class: 'crypto' },
  KXXRP:                        { sport: null, league: null, asset_class: 'crypto' },
  KXBNB:                        { sport: null, league: null, asset_class: 'crypto' },
  KXHYPE:                       { sport: null, league: null, asset_class: 'crypto' },
  KXSHIB:                       { sport: null, league: null, asset_class: 'crypto' },
  KXAVAX:                       { sport: null, league: null, asset_class: 'crypto' },
  KXLINK:                       { sport: null, league: null, asset_class: 'crypto' },
  KXADA:                        { sport: null, league: null, asset_class: 'crypto' },
  KXDOT:                        { sport: null, league: null, asset_class: 'crypto' },
  KXMATIC:                      { sport: null, league: null, asset_class: 'crypto' },
  KXLTC:                        { sport: null, league: null, asset_class: 'crypto' },
  KXUNI:                        { sport: null, league: null, asset_class: 'crypto' },
  KXATOM:                       { sport: null, league: null, asset_class: 'crypto' },
  KXNEAR:                       { sport: null, league: null, asset_class: 'crypto' },

  KXGOLD:                       { sport: null, league: null, asset_class: 'commodity' },
  KXGOLDMON:                    { sport: null, league: null, asset_class: 'commodity' },
  KXSILVER:                     { sport: null, league: null, asset_class: 'commodity' },
  KXWTI:                        { sport: null, league: null, asset_class: 'commodity' },
  KXBRENT:                      { sport: null, league: null, asset_class: 'commodity' },
  KXNATGAS:                     { sport: null, league: null, asset_class: 'commodity' },
  KXHOIL:                       { sport: null, league: null, asset_class: 'commodity' },
  KXCOPPER:                     { sport: null, league: null, asset_class: 'commodity' },
  KXCOCOA:                      { sport: null, league: null, asset_class: 'commodity' },
  KXCOFFEE:                     { sport: null, league: null, asset_class: 'commodity' },
  KXSUGAR:                      { sport: null, league: null, asset_class: 'commodity' },
  KXWHEAT:                      { sport: null, league: null, asset_class: 'commodity' },
  KXCORN:                       { sport: null, league: null, asset_class: 'commodity' },
  KXSOYBEAN:                    { sport: null, league: null, asset_class: 'commodity' },
  KXLCATTLE:                    { sport: null, league: null, asset_class: 'commodity' },
  KXNICKEL:                     { sport: null, league: null, asset_class: 'commodity' },
  KXLITHIUM:                    { sport: null, league: null, asset_class: 'commodity' },

  KXNASDAQ100U:                 { sport: null, league: null, asset_class: 'index' },
  KXINXU:                       { sport: null, league: null, asset_class: 'index' },

  KXCPI:                        { sport: null, league: null, asset_class: 'economic' },
  KXCPICOREYOY:                 { sport: null, league: null, asset_class: 'economic' },
  KXGDP:                        { sport: null, league: null, asset_class: 'economic' },
  KXFED:                        { sport: null, league: null, asset_class: 'economic' },
  KXFEDMEET:                    { sport: null, league: null, asset_class: 'economic' },
  KXFEDDISSENT:                 { sport: null, league: null, asset_class: 'economic' },
  KXFEDHIKE:                    { sport: null, league: null, asset_class: 'economic' },
  KXRATECUT:                    { sport: null, league: null, asset_class: 'economic' },
  KXUE:                         { sport: null, league: null, asset_class: 'economic' },
  KXPCE:                        { sport: null, league: null, asset_class: 'economic' },
  KXPAYROLL:                    { sport: null, league: null, asset_class: 'economic' },
  KXADP:                        { sport: null, league: null, asset_class: 'economic' },
  KXISMPMI:                     { sport: null, league: null, asset_class: 'economic' },
};

/** Fallback for prefixes not in KALSHI_TICKER_PREFIX_MAP; scanned in order via startsWith,
 *  so more specific entries must precede their parents (e.g. KXBUNDESLIGA2 before KXBUNDESLIGA). */
const KALSHI_TICKER_FAMILY_PREFIXES: ReadonlyArray<readonly [string, KalshiPrefixEntry]> = [
  ['KXNBA',           { sport: 'basketball',        league: 'NBA',             asset_class: null }],
  ['KXWNBA',          { sport: 'basketball',        league: 'WNBA',            asset_class: null }],
  ['KXNFL',           { sport: 'american-football', league: 'NFL',             asset_class: null }],
  ['KXNCAAF',         { sport: 'american-football', league: 'NCAAF',           asset_class: null }],
  ['KXNHL',           { sport: 'ice-hockey',        league: 'NHL',             asset_class: null }],
  ['KXMLB',           { sport: 'baseball',          league: 'MLB',             asset_class: null }],
  ['KXKBO',           { sport: 'baseball',          league: 'KBO',             asset_class: null }],
  ['KXMLS',           { sport: 'soccer',            league: 'MLS',             asset_class: null }],
  ['KXEPL',           { sport: 'soccer',            league: 'Premier League',  asset_class: null }],
  ['KXLALIGA',        { sport: 'soccer',            league: 'La Liga',         asset_class: null }],
  ['KXBUNDESLIGA',    { sport: 'soccer',            league: 'Bundesliga',      asset_class: null }],
  ['KXSERIEA',        { sport: 'soccer',            league: 'Serie A',         asset_class: null }],
  ['KXLIGUE1',        { sport: 'soccer',            league: 'Ligue 1',         asset_class: null }],
  ['KXEREDIVISIE',    { sport: 'soccer',            league: 'Eredivisie',      asset_class: null }],
  ['KXBRASILEIR',     { sport: 'soccer',            league: 'Brasileirão',     asset_class: null }],
  ['KXSAUDIP',        { sport: 'soccer',            league: 'Saudi Pro League',asset_class: null }],
  ['KXATPCHALLENGER', { sport: 'tennis',            league: 'ATP Challenger',  asset_class: null }],
  ['KXATP',           { sport: 'tennis',            league: 'ATP Tour',        asset_class: null }],
  ['KXWTACHALLENGER', { sport: 'tennis',            league: 'WTA Challenger',  asset_class: null }],
  ['KXWTA',           { sport: 'tennis',            league: 'WTA Tour',        asset_class: null }],
  ['KXITF',           { sport: 'tennis',            league: 'ITF',             asset_class: null }],
  ['KXCS2',           { sport: 'cs2',               league: null,              asset_class: null }],
  ['KXLOL',           { sport: 'lol',               league: null,              asset_class: null }],
  ['KXVALORANT',      { sport: 'valorant',          league: null,              asset_class: null }],
  ['KXDOTA2',         { sport: 'dota2',             league: null,              asset_class: null }],
  ['KXCOD',           { sport: 'call-of-duty',      league: null,              asset_class: null }],
  ['KXBTC',           { sport: null, league: null, asset_class: 'crypto' }],
  ['KXETH',           { sport: null, league: null, asset_class: 'crypto' }],
  ['KXSOL',           { sport: null, league: null, asset_class: 'crypto' }],
  ['KXDOGE',          { sport: null, league: null, asset_class: 'crypto' }],
  ['KXXRP',           { sport: null, league: null, asset_class: 'crypto' }],
  ['KXGOLDMON',       { sport: null, league: null, asset_class: 'commodity' }],  // must precede KXGOLD
  ['KXGOLD',          { sport: null, league: null, asset_class: 'commodity' }],
  ['KXWTI',           { sport: null, league: null, asset_class: 'commodity' }],
  ['KXBRENT',         { sport: null, league: null, asset_class: 'commodity' }],
  ['KXNATGAS',        { sport: null, league: null, asset_class: 'commodity' }],
  ['KXFED',           { sport: null, league: null, asset_class: 'economic' }],
  ['KXCPI',           { sport: null, league: null, asset_class: 'economic' }],
  ['KXGDP',           { sport: null, league: null, asset_class: 'economic' }],
  ['KXUE',            { sport: null, league: null, asset_class: 'economic' }],
  ['KXPCE',           { sport: null, league: null, asset_class: 'economic' }],
  ['KXPAYROLL',       { sport: null, league: null, asset_class: 'economic' }],
];

/** Exact match first, then the ordered family-prefix scan; null when the prefix isn't a sports market. */
export function resolveKalshiTickerPrefix(prefix: string): KalshiPrefixEntry | null {
  const exact = KALSHI_TICKER_PREFIX_MAP[prefix];
  if (exact !== undefined) return exact;
  for (const [familyPrefix, entry] of KALSHI_TICKER_FAMILY_PREFIXES) {
    if (prefix.startsWith(familyPrefix)) return entry;
  }
  return null;
}

/** predict_categories tag name → sport_canonical; null = recognised category but not a sport. */
const PREDICT_TAG_TO_SPORT: Record<string, string | null> = {
  'NBA':     'basketball',
  'NCAAM':   'basketball',
  'NCAAB':   'basketball',
  'NHL':     'ice-hockey',
  'MLB':     'baseball',
  'NFL':     'american-football',
  'NCAAF':   'american-football',
  'Soccer':  'soccer',
  'MLS':     'soccer',
  'CS2':     'cs2',
  'LoL':     'lol',
  'Dota 2':  'dota2',
  'Esports': null,
  'Sports':  null,
  'Crypto':  null,
  'Finance': null,
  'Economy': null,
  'Politics': null,
  'Entertainment': null,
  'Technology': null,
};

const LEAGUE_TO_SPORT: Record<string, string> = {
  'premier league': 'soccer',
  'la liga': 'soccer',
  bundesliga: 'soccer',
  'serie a': 'soccer',
  'ligue 1': 'soccer',
  mls: 'soccer',
  'champions league': 'soccer',
  'europa league': 'soccer',
  eredivisie: 'soccer',
  nba: 'basketball',
  wnba: 'basketball',
  ncaab: 'basketball',
  ncaaf: 'american-football',
  nfl: 'american-football',
  mlb: 'baseball',
  nhl: 'ice-hockey',
  ipl: 'cricket',
  't20 world cup': 'cricket',
  'atp tour': 'tennis',
  'wta tour': 'tennis',
  'pga tour': 'golf',
  'liv golf': 'golf',
  ufc: 'mma',
  bellator: 'mma',
  'rugby world cup': 'rugby',
  'six nations': 'rugby',
};

const SPORT_KEYWORD_HINTS: Array<{ rx: RegExp; sport: string }> = [
  { rx: /\b(threes?|three[- ]pointers?|rebounds?|assists?|points scored|nba|wnba)\b/i, sport: 'basketball' },
  { rx: /\b(home runs?|hr scored|stolen bases?|runs scored|mlb|innings)\b/i,            sport: 'baseball' },
  { rx: /\b(touchdowns?|passing yards?|rushing yards?|nfl)\b/i,                         sport: 'american football' },
  { rx: /\b(goals scored|hat[- ]tricks?|nhl|saves)\b/i,                                 sport: 'ice hockey' },
  { rx: /\b(epl|premier league|la liga|champions league|fc)\b/i,                        sport: 'soccer' },
];

const LEAGUE_EXPLICIT: Array<{ rx: RegExp; canonical: string }> = [
  { rx: /\bChampions League\b/i,    canonical: 'Champions League' },
  { rx: /\bEuropa League\b/i,       canonical: 'Europa League' },
  { rx: /\bNBA\b/i,                 canonical: 'NBA' },
  { rx: /\bWNBA\b/i,                canonical: 'WNBA' },
  { rx: /\bNFL\b/i,                 canonical: 'NFL' },
  { rx: /\bMLB\b/i,                 canonical: 'MLB' },
  { rx: /\bNHL\b/i,                 canonical: 'NHL' },
  { rx: /\bMLS\b/i,                 canonical: 'MLS' },
  { rx: /\bUFC\b/i,                 canonical: 'UFC' },
  { rx: /\bBellator\b/i,            canonical: 'Bellator' },
  { rx: /\bATP Tour\b/i,            canonical: 'ATP Tour' },
  { rx: /\bWTA Tour\b/i,            canonical: 'WTA Tour' },
  { rx: /\bPremier League\b/i,      canonical: 'Premier League' },
  { rx: /\bLa Liga\b/i,             canonical: 'La Liga' },
  { rx: /\bBundesliga\b/i,          canonical: 'Bundesliga' },
  { rx: /\bSerie A\b/i,             canonical: 'Serie A' },
  { rx: /\bLigue 1\b/i,             canonical: 'Ligue 1' },
  { rx: /\bEredivisie\b/i,          canonical: 'Eredivisie' },
  { rx: /\bIPL\b/i,                 canonical: 'IPL' },
  { rx: /\bT20 World Cup\b/i,       canonical: 'T20 World Cup' },
  { rx: /\bPGA Tour\b/i,            canonical: 'PGA Tour' },
  { rx: /\bLIV Golf\b/i,            canonical: 'LIV Golf' },
  { rx: /\bRugby World Cup\b/i,     canonical: 'Rugby World Cup' },
  { rx: /\bSix Nations\b/i,         canonical: 'Six Nations' },
  { rx: /\bNCAAB\b/i,               canonical: 'NCAAB' },
  { rx: /\bNCAAF\b/i,               canonical: 'NCAAF' },
  { rx: /\bNCAA\b/i,                canonical: 'NCAA' },
];

/** "goals/saves" deliberately excluded — ambiguous between NHL and soccer. */
const LEAGUE_STAT_UNIT: Array<{ rx: RegExp; canonical: string }> = [
  { rx: /:\s*\d+\+\s*(?:rebounds?|threes?|three[- ]pointers?|blocks?|steals?)\b/i, canonical: 'NBA' },
  { rx: /:\s*\d+\+\s*(?:home\s*runs?|strikeouts?|rbis?)\b/i,                       canonical: 'MLB' },
  { rx: /:\s*\d+\+\s*(?:touchdowns?|pass(?:ing)?\s+yards?|rush(?:ing)?\s+yards?|receiving\s+yards?|receptions?|completions?)\b/i, canonical: 'NFL' },
];

/** Null when the evidence is insufficient or ambiguous; explicit league name wins over stat-unit inference. */
export function extractLeagueFromTitles(titles: string[]): string | null {
  const blob = titles.filter(Boolean).join(' | ');
  if (!blob) return null;

  for (const { rx, canonical } of LEAGUE_EXPLICIT) {
    if (rx.test(blob)) return canonical;
  }
  for (const { rx, canonical } of LEAGUE_STAT_UNIT) {
    if (rx.test(blob)) return canonical;
  }

  return null;
}

/** Returns entity_type:'unknown' when uncertain rather than guessing. */
export function classifyEntity(ctx: EntityContext): EntityClassification {
  const notes: string[] = [];
  const allForms = [ctx.canonical, ...ctx.aliases].filter(Boolean);
  const titleBlob = ctx.sample_titles.join(' | ');

  // First non-null wins: Kalshi prefix, then Polymarket tag, then Limitless, then Predict, then keyword scan.
  let sport_canonical: string | null = null;

  const kalshiResolved = ctx.kalshi_ticker_prefix
    ? resolveKalshiTickerPrefix(ctx.kalshi_ticker_prefix)
    : null;
  if (kalshiResolved?.sport) sport_canonical = kalshiResolved.sport;

  if (!sport_canonical) {
    for (const slug of (ctx.tag_slugs ?? [])) {
      const mapped = POLYMARKET_SLUG_TO_SPORT[slug.toLowerCase()] ?? undefined;
      if (mapped !== undefined && mapped !== null) { sport_canonical = mapped; break; }
    }
  }

  if (!sport_canonical && ctx.limitless_sport) {
    sport_canonical = LIMITLESS_SPORT_MAP[ctx.limitless_sport.toLowerCase()] ?? null;
  }

  if (!sport_canonical) {
    for (const tag of (ctx.predict_tag_names ?? [])) {
      const mapped = PREDICT_TAG_TO_SPORT[tag] ?? undefined;
      if (mapped !== undefined && mapped !== null) { sport_canonical = mapped; break; }
    }
  }

  if (!sport_canonical) {
    for (const { rx, sport } of SPORT_KEYWORD_HINTS) {
      if (rx.test(titleBlob)) { sport_canonical = sport; break; }
    }
  }

  const league_canonical: string | null =
    kalshiResolved?.league ?? ctx.limitless_league ?? extractLeagueFromTitles(ctx.sample_titles);

  if (!sport_canonical && league_canonical) {
    sport_canonical = LEAGUE_TO_SPORT[league_canonical.toLowerCase()] ?? null;
  }

  if ((ctx.domain_category === 'crypto' || ctx.domain_category === 'finance')) {
    const tickerForm = allForms.find((f) => ALL_CAPS_TICKER.test(f));
    if (tickerForm) {
      notes.push(`ticker_form=${tickerForm}`);
      return { entity_type: 'asset', sport_canonical: null, league_canonical: null, notes };
    }
  }

  if (ctx.domain_category === 'sports') {
    const allCapsForm = allForms.find((f) => ALL_CAPS_TICKER.test(f));
    const personForm  = allForms.find((f) => PERSON_LIKE.test(f) && f.split(/\s+/).length >= 2);
    const teamForm    = allForms.find((f) => TEAM_KEYWORDS.some((kw) => f.toLowerCase().includes(kw)));
    // Gated on sport_canonical so generic phrases like "Senate Democrats" aren't mistaken for clubs.
    const clubLikeForm = sport_canonical
      ? allForms.find((f) => looksLikeSportsTeam(f))
      : undefined;

    const playerPropMatch = ctx.sample_titles.some((t) =>
      new RegExp(`(?:yes|no)\\s+${escapeRx(ctx.canonical)}\\s*:\\s*\\d`, 'i').test(t)
      || allForms.some((f) =>
        new RegExp(`(?:yes|no)\\s+${escapeRx(f)}\\s*:\\s*\\d`, 'i').test(t)
      )
    );
    if (playerPropMatch && personForm) {
      notes.push('matched_player_prop_template');
      return { entity_type: 'person', sport_canonical, league_canonical, notes };
    }

    if (teamForm) {
      notes.push(`team_keyword=${teamForm}`);
      return { entity_type: 'team', sport_canonical, league_canonical, notes };
    }

    if (clubLikeForm) {
      notes.push(`club_like_pattern=${clubLikeForm}`);
      return { entity_type: 'team', sport_canonical, league_canonical, notes };
    }

    if (allCapsForm && allForms.length === 1) {
      // No full-name alias: default bare code to team (most Kalshi sports tickers are teams).
      notes.push('bare_all_caps_no_full_name');
      return { entity_type: 'team', sport_canonical, league_canonical, notes };
    }

    if (personForm) {
      // Club names also match PERSON_LIKE; when sport_canonical is set and clubLikeForm
      // didn't match, return 'unknown' rather than guessing 'person'.
      if (!sport_canonical) {
        notes.push(`person_pattern=${personForm}`);
        return { entity_type: 'person', sport_canonical, league_canonical, notes };
      }
      notes.push(`ambiguous_multiword_in_sport=${personForm}`);
      return { entity_type: 'unknown', sport_canonical, league_canonical, notes };
    }

    if (allCapsForm) {
      notes.push(`fallback_all_caps=${allCapsForm}`);
      return { entity_type: 'team', sport_canonical, league_canonical, notes };
    }
  }

  if (ctx.domain_category === 'politics') {
    const personForm = allForms.find((f) => PERSON_LIKE.test(f));
    if (personForm) {
      notes.push(`politics_person=${personForm}`);
      return { entity_type: 'person', sport_canonical: null, league_canonical: null, notes };
    }
  }

  return { entity_type: 'unknown', sport_canonical, league_canonical, notes };
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
