/** Seeds curated structural entities (sports, leagues, teams, providers) into
 *  known_entities/entity_relations. Idempotent. */
import { query } from '@arb/db';
import { createLogger } from '@arb/logger';
import type { EntityType } from '@arb/types';
import { mergeAliasVariants } from './entity/register.js';
import { seedLeagueDedup, type DedupResult as LeagueDedupSummary } from './dedup-leagues.js';
import { classifyBareAliases, BARE_ALIAS_SCOPED_TYPES } from './entity/bare-alias.js';

const log = createLogger('seed-entity-kb');

export interface EntitySeed {
  canonical: string;
  type: EntityType;
  aliases: string[];
  metadata: Record<string, unknown>;
  domain_category: string;
}

interface RelationSeed {
  parentCanonical: string;
  childCanonical: string;
  relation: 'plays_for' | 'competes_in' | 'part_of' | 'located_in' | 'covers';
}

interface TeamEntry {
  league: string;
  sport: string;
  country?: string;
}

const SPORTS: EntitySeed[] = [
  { canonical: 'basketball',    type: 'sport', aliases: ['hoops', 'nba basketball'],        metadata: { kind: 'sport' }, domain_category: 'sports' },
  // Bare 'football' is ambiguous between soccer and gridiron; disambiguated elsewhere.
  { canonical: 'american football', type: 'sport', aliases: ['gridiron', 'nfl football'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'soccer',        type: 'sport', aliases: ['association football', 'futbol', 'soccer football'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'baseball',      type: 'sport', aliases: ['mlb baseball', "america's pastime"],             metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'ice hockey',    type: 'sport', aliases: ['hockey', 'nhl hockey'],           metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'tennis',        type: 'sport', aliases: ['grand slam tennis', 'atp tennis', 'wta tennis'],  metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'golf',          type: 'sport', aliases: ['pga golf', 'lpga golf'],           metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'boxing',        type: 'sport', aliases: ['prizefighting'],                   metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'mma',           type: 'sport', aliases: ['mixed martial arts', 'ufc fighting', 'cage fighting'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'cricket',       type: 'sport', aliases: ['test cricket', 'odi cricket', 't20 cricket'],    metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'esports',       type: 'sport', aliases: ['competitive gaming', 'e-sports'],   metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'dota 2',        type: 'sport', aliases: ['dota2', 'dota', 'defense of the ancients 2'],   metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'league of legends', type: 'sport', aliases: ['lol', 'lol esports'],         metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'cs2',           type: 'sport', aliases: ['counter-strike 2', 'csgo', 'cs:go', 'counter strike global offensive', 'cs:2'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'valorant',      type: 'sport', aliases: ['vlr', 'valorant esports'],         metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'rugby union',   type: 'sport', aliases: ['rugby', 'rugby 15s'],              metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'rugby league',  type: 'sport', aliases: ['nrl', 'rugby 13s'],                metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'formula 1',     type: 'sport', aliases: ['f1', 'formula one', 'f1 racing', 'formula 1 racing'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'nascar',        type: 'sport', aliases: ['stock car racing', 'nascar racing'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'cycling',       type: 'sport', aliases: ['pro cycling', 'grand tour cycling', 'tour de france'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'swimming',      type: 'sport', aliases: ['competitive swimming', 'olympic swimming'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'athletics',     type: 'sport', aliases: ['track and field', 'track & field', 'olympic athletics'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'volleyball',    type: 'sport', aliases: ['beach volleyball', 'indoor volleyball'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'basketball (ncaa)', type: 'sport', aliases: ['college basketball', 'ncaab', 'march madness basketball'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'american football (ncaa)', type: 'sport', aliases: ['college football', 'ncaaf', 'cfb'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'horse racing',  type: 'sport', aliases: ['thoroughbred racing', 'kentucky derby racing'], metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'snooker',       type: 'sport', aliases: ['snooker/pool', 'cue sports'],       metadata: { kind: 'sport' }, domain_category: 'sports' },
  { canonical: 'darts',         type: 'sport', aliases: ['pdc darts', 'bdo darts'],           metadata: { kind: 'sport' }, domain_category: 'sports' },
];

// tour_gender is set only for leagues restricted by charter to one gender; left null
// for mixed bodies (UFC, F1) and leagues whose club names span both genders.
export const LEAGUES: EntitySeed[] = [
  { canonical: 'NBA', type: 'league', aliases: ['National Basketball Association', 'nba', 'the nba', 'nba league'], metadata: { kind: 'league', sport_canonical: 'basketball', tour_gender: 'men', country: 'US', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXNBAPTS', 'KXNBAREB', 'KXNBAAST', 'KXNBASTL', 'KXNBABLK', 'KXNBA3PT', 'KXNBASPREAD', 'KXNBATOTAL', 'KXNBAGAME', 'KXNBA'] } }, domain_category: 'sports' },
  { canonical: 'WNBA', type: 'league', aliases: ["Women's National Basketball Association", 'wnba'], metadata: { kind: 'league', sport_canonical: 'basketball', tour_gender: 'women', country: 'US', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXWNBA'] } }, domain_category: 'sports' },
  { canonical: 'EuroLeague', type: 'league', aliases: ['Turkish Airlines EuroLeague', 'euroleague basketball', 'EuroLeague Basketball'], metadata: { kind: 'league', sport_canonical: 'basketball', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'NCAAB', type: 'league', aliases: ['NCAA Basketball', 'College Basketball', 'NCAA Mens Basketball', 'ncaa basketball'], metadata: { kind: 'league', sport_canonical: 'basketball (ncaa)', country: 'US', platform_signals: { kalshi_ticker_prefixes: ['KXNCAAMBKB', 'KXNCAAWBKB'] } }, domain_category: 'sports' },
  { canonical: 'G League', type: 'league', aliases: ['NBA G League', 'NBA Development League', 'nba g league'], metadata: { kind: 'league', sport_canonical: 'basketball', country: 'US' }, domain_category: 'sports' },

  { canonical: 'NFL', type: 'league', aliases: ['National Football League', 'nfl', 'the nfl', 'nfl league'], metadata: { kind: 'league', sport_canonical: 'american football', tour_gender: 'men', country: 'US', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXNFLPLAYOFF', 'KXNFLSPREAD', 'KXNFLTOTAL', 'KXNFLRSHYDS', 'KXNFL'] } }, domain_category: 'sports' },
  { canonical: 'NCAAF', type: 'league', aliases: ['NCAA Football', 'College Football', 'CFB', 'ncaa football'], metadata: { kind: 'league', sport_canonical: 'american football (ncaa)', country: 'US' }, domain_category: 'sports' },
  { canonical: 'CFL', type: 'league', aliases: ['Canadian Football League', 'cfl'], metadata: { kind: 'league', sport_canonical: 'american football', country: 'CA' }, domain_category: 'sports' },
  { canonical: 'XFL', type: 'league', aliases: ['xfl', 'the xfl'], metadata: { kind: 'league', sport_canonical: 'american football', country: 'US' }, domain_category: 'sports' },

  { canonical: 'Premier League', type: 'league', aliases: ['EPL', 'English Premier League', 'BPL', 'Barclays Premier League', 'PL', 'premier league', 'english premier league'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'GB', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXEPLGAME', 'KXEPLTOTAL', 'KXEPLBTTS', 'KXEPLSPREAD', 'KXEPLGOAL', 'KXEPL'] } }, domain_category: 'sports' },
  { canonical: 'La Liga', type: 'league', aliases: ['Spanish La Liga', 'Liga Española', 'La Liga Santander', 'primera division', 'spanish first division'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'ES', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXLALIGAGAME', 'KXLALIGATOTAL', 'KXLALIGABTTS', 'KXLALIGASPREAD', 'KXLALIGA'] } }, domain_category: 'sports' },
  // Own prefixes keep the longest-prefix resolver from letting KXLALIGA swallow Segunda.
  { canonical: 'La Liga 2', type: 'league', aliases: ['Segunda División', 'Segunda Division', 'la liga 2', 'LaLiga Hypermotion', 'spanish second division'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'ES', level: 'second_tier', platform_signals: { kalshi_ticker_prefixes: ['KXLALIGA2GAME', 'KXLALIGA2'] } }, domain_category: 'sports' },
  { canonical: 'Bundesliga', type: 'league', aliases: ['German Bundesliga', '1. Bundesliga', 'bundesliga'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'DE', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXBUNDESLIGAGAME', 'KXBUNDESLIGATOTAL', 'KXBUNDESLIGA'] } }, domain_category: 'sports' },
  { canonical: '2. Bundesliga', type: 'league', aliases: ['2 Bundesliga', 'Zweite Bundesliga', 'german second division', '2. bundesliga'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'DE', level: 'second_tier', platform_signals: { kalshi_ticker_prefixes: ['KXBUNDESLIGA2GAME', 'KXBUNDESLIGA2'] } }, domain_category: 'sports' },
  { canonical: 'Serie A', type: 'league', aliases: ['Italian Serie A', 'Serie A TIM', 'serie a'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'IT', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXSERIEAGAME', 'KXSERIEATOTAL', 'KXSERIEABTTS', 'KXSERIEASPREAD', 'KXSERIEA'] } }, domain_category: 'sports' },
  { canonical: 'Ligue 1', type: 'league', aliases: ['French Ligue 1', 'Ligue 1 Uber Eats', 'ligue 1'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'FR', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXLIGUE1GAME', 'KXLIGUE'] } }, domain_category: 'sports' },
  { canonical: 'Eredivisie', type: 'league', aliases: ['Dutch Eredivisie', 'eredivisie'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'NL', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'Primeira Liga', type: 'league', aliases: ['Portuguese Primeira Liga', 'Liga NOS', 'Liga Portugal', 'primeira liga'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'PT', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'Austrian Bundesliga', type: 'league', aliases: ['Österreichische Fußball-Bundesliga', 'austrian bundesliga', 'österreich bundesliga', 'austrian football bundesliga', 'admiral bundesliga'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'AT', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'HNL', type: 'league', aliases: ['Hrvatska Nogometna Liga', 'Croatian First Football League', 'SuperSport HNL', 'croatian first league', 'croatian hnl', 'hnl'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'HR', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'Süper Lig', type: 'league', aliases: ['Turkish Süper Lig', 'turkish super lig', 'super lig', 'süper lig'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'TR', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'Belgian Pro League', type: 'league', aliases: ['Jupiler Pro League', 'belgian pro league', 'belgian first division'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'BE', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'MLS', type: 'league', aliases: ['Major League Soccer', 'mls', 'major league soccer'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'US', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXMLS'] } }, domain_category: 'sports' },
  { canonical: 'Championship', type: 'league', aliases: ['EFL Championship', 'English Championship', 'second division england'], metadata: { kind: 'league', sport_canonical: 'soccer', country: 'GB', level: 'second_tier' }, domain_category: 'sports' },
  // cross_league:true stops Stage 1 from treating this as a team's league_canonical.
  { canonical: 'Champions League', type: 'league', aliases: ['UEFA Champions League', 'UCL', 'European Champions League', 'champions league', 'uefa champions league'], metadata: { kind: 'league', sport_canonical: 'soccer', level: 'top_flight', cross_league: true, platform_signals: { kalshi_ticker_prefixes: ['KXUCLGAME', 'KXUCLBTTS', 'KXUCLTOTAL', 'KXUCLSPREAD', 'KXUCLGOAL', 'KXUCL'] } }, domain_category: 'sports' },
  { canonical: 'Europa League', type: 'league', aliases: ['UEFA Europa League', 'UEL', 'europa league'], metadata: { kind: 'league', sport_canonical: 'soccer', cross_league: true }, domain_category: 'sports' },
  { canonical: 'Conference League', type: 'league', aliases: ['UEFA Conference League', 'UECL', 'europa conference league'], metadata: { kind: 'league', sport_canonical: 'soccer', cross_league: true }, domain_category: 'sports' },
  { canonical: 'FIFA World Cup', type: 'competition', aliases: ['World Cup', 'FIFA World Cup', 'world cup football', 'world cup soccer'], metadata: { kind: 'competition', sport_canonical: 'soccer', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'Copa do Brasil', type: 'competition', aliases: ['copa do brasil', 'brazil cup', 'brazilian cup'], metadata: { kind: 'competition', sport_canonical: 'soccer', country: 'BR', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'Copa Sudamericana', type: 'competition', aliases: ['copa sudamericana', 'CONMEBOL Sudamericana', 'sudamericana'], metadata: { kind: 'competition', sport_canonical: 'soccer', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'Copa Libertadores', type: 'competition', aliases: ['copa libertadores', 'CONMEBOL Libertadores', 'libertadores'], metadata: { kind: 'competition', sport_canonical: 'soccer', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'FA Cup', type: 'competition', aliases: ['fa cup', 'English FA Cup', 'the fa cup', 'emirates fa cup'], metadata: { kind: 'competition', sport_canonical: 'soccer', country: 'GB', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'EFL Cup', type: 'competition', aliases: ['efl cup', 'Carabao Cup', 'carabao cup', 'league cup', 'english league cup'], metadata: { kind: 'competition', sport_canonical: 'soccer', country: 'GB', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'Coppa Italia', type: 'competition', aliases: ['coppa italia', 'italian cup'], metadata: { kind: 'competition', sport_canonical: 'soccer', country: 'IT', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'Copa del Rey', type: 'competition', aliases: ['copa del rey', 'spanish cup'], metadata: { kind: 'competition', sport_canonical: 'soccer', country: 'ES', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'DFB-Pokal', type: 'competition', aliases: ['dfb-pokal', 'dfb pokal', 'german cup'], metadata: { kind: 'competition', sport_canonical: 'soccer', country: 'DE', scope: 'tournament', cross_league: true }, domain_category: 'sports' },
  { canonical: 'Copa Argentina', type: 'competition', aliases: ['copa argentina', 'argentine cup'], metadata: { kind: 'competition', sport_canonical: 'soccer', country: 'AR', scope: 'tournament', cross_league: true }, domain_category: 'sports' },

  { canonical: 'MLB', type: 'league', aliases: ['Major League Baseball', 'mlb', 'major league baseball', 'big leagues'], metadata: { kind: 'league', sport_canonical: 'baseball', tour_gender: 'men', country: 'US', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXMLBSPREAD', 'KXMLBTOTAL', 'KXMLBGAME', 'KXMLBHRR', 'KXMLBHR', 'KXMLBHIT', 'KXMLBKS', 'KXMLBSTAT', 'KXMLBPLAYOFFS', 'KXMLB'] } }, domain_category: 'sports' },
  { canonical: 'NPB', type: 'league', aliases: ['Nippon Professional Baseball', 'Japanese Baseball'], metadata: { kind: 'league', sport_canonical: 'baseball', country: 'JP', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'KBO', type: 'league', aliases: ['Korea Baseball Organization', 'Korean Baseball', 'KBO League'], metadata: { kind: 'league', sport_canonical: 'baseball', country: 'KR', level: 'top_flight' }, domain_category: 'sports' },

  { canonical: 'NHL', type: 'league', aliases: ['National Hockey League', 'nhl', 'the nhl', 'nhl hockey'], metadata: { kind: 'league', sport_canonical: 'ice hockey', tour_gender: 'men', country: 'US', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXNHLGOAL', 'KXNHLFIRSTGOAL', 'KXNHLPTS', 'KXNHLAST', 'KXNHLSPREAD', 'KXNHLTOTAL', 'KXNHLGAME', 'KXNHL'] } }, domain_category: 'sports' },
  { canonical: 'AHL', type: 'league', aliases: ['American Hockey League', 'ahl'], metadata: { kind: 'league', sport_canonical: 'ice hockey', country: 'US' }, domain_category: 'sports' },
  { canonical: 'KHL', type: 'league', aliases: ['Kontinental Hockey League', 'khl', 'russian hockey'], metadata: { kind: 'league', sport_canonical: 'ice hockey', country: 'RU', level: 'top_flight' }, domain_category: 'sports' },

  // KXFOMEN/KXFOWOMEN/KXCALCFO are single-tour, so they carry tour_gender directly.
  { canonical: 'ATP Tour', type: 'league', aliases: ['ATP', 'Association of Tennis Professionals', 'atp tour', 'mens tennis tour'], metadata: { kind: 'league', sport_canonical: 'tennis', tour_gender: 'men', platform_signals: { kalshi_ticker_prefixes: ['KXATPMATCH', 'KXATP1RANK', 'KXWTASERENA', 'KXATP', 'KXFOMEN', 'KXCALCFO'] } }, domain_category: 'sports' },
  { canonical: 'WTA Tour', type: 'league', aliases: ['WTA', "Women's Tennis Association", 'wta tour', 'womens tennis tour'], metadata: { kind: 'league', sport_canonical: 'tennis', tour_gender: 'women', platform_signals: { kalshi_ticker_prefixes: ['KXWTAMATCH', 'KXWTA', 'KXFOWOMEN'] } }, domain_category: 'sports' },
  // Grand Slam is cross-league: ATP and WTA players compete under one entity.
  { canonical: 'Grand Slam', type: 'league', aliases: ['grand slam tennis', 'tennis grand slam'], metadata: { kind: 'league', sport_canonical: 'tennis', level: 'top_flight', cross_league: true, platform_signals: { kalshi_ticker_prefixes: ['KXATPGRANDSLAMFIELD', 'KXATPGRANDSLAM', 'KXWTAGRANDSLAM', 'KXGRANDSLAM'] } }, domain_category: 'sports' },

  { canonical: 'PGA Tour', type: 'league', aliases: ['PGA', 'pga tour', 'professional golfers association', 'PGA TOUR'], metadata: { kind: 'league', sport_canonical: 'golf', tour_gender: 'men', country: 'US', platform_signals: { kalshi_ticker_prefixes: ['KXPGAMAJORWIN', 'KXPGAMAKECUT', 'KXPGATOUR', 'KXPGATOP', 'KXPGAR', 'KXPGA'] } }, domain_category: 'sports' },
  { canonical: 'European Tour', type: 'league', aliases: ['DP World Tour', 'european tour golf', 'dpwt'], metadata: { kind: 'league', sport_canonical: 'golf', tour_gender: 'men' }, domain_category: 'sports' },
  { canonical: 'LIV Golf', type: 'league', aliases: ['LIV', 'liv golf', 'liv golf league'], metadata: { kind: 'league', sport_canonical: 'golf', tour_gender: 'men' }, domain_category: 'sports' },
  { canonical: 'Korn Ferry Tour', type: 'league', aliases: ['korn ferry tour', 'korn ferry', 'kft golf'], metadata: { kind: 'league', sport_canonical: 'golf', tour_gender: 'men' }, domain_category: 'sports' },
  { canonical: 'LPGA Tour', type: 'league', aliases: ['LPGA', 'lpga tour', "ladies professional golf association", 'womens golf tour'], metadata: { kind: 'league', sport_canonical: 'golf', tour_gender: 'women' }, domain_category: 'sports' },
  { canonical: 'Masters Tournament', type: 'competition', aliases: ['The Masters', 'Augusta National', 'the masters golf', 'masters golf'], metadata: { kind: 'competition', sport_canonical: 'golf', tour_gender: 'men', scope: 'tournament' }, domain_category: 'sports' },

  { canonical: 'UFC', type: 'league', aliases: ['Ultimate Fighting Championship', 'ufc', 'the ufc'], metadata: { kind: 'league', sport_canonical: 'mma', country: 'US', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXUFCFIGHT', 'KXUFCROUNDS', 'KXUFCMOF', 'KXUFC'] } }, domain_category: 'sports' },
  { canonical: 'Bellator', type: 'league', aliases: ['Bellator MMA', 'bellator'], metadata: { kind: 'league', sport_canonical: 'mma' }, domain_category: 'sports' },
  { canonical: 'PFL', type: 'league', aliases: ['Professional Fighters League', 'pfl mma'], metadata: { kind: 'league', sport_canonical: 'mma' }, domain_category: 'sports' },

  { canonical: 'IPL', type: 'league', aliases: ['Indian Premier League', 'ipl', 'indian premier league'], metadata: { kind: 'league', sport_canonical: 'cricket', country: 'IN', level: 'top_flight', platform_signals: { kalshi_ticker_prefixes: ['KXIPLGAME', 'KXIPLPLAYOFF', 'KXIPLFINALS', 'KXIPLTEAMTOTAL', 'KXIPL'] } }, domain_category: 'sports' },
  { canonical: 'ICC', type: 'league', aliases: ['International Cricket Council', 'icc', 'icc cricket'], metadata: { kind: 'league', sport_canonical: 'cricket' }, domain_category: 'sports' },
  { canonical: 'The Ashes', type: 'competition', aliases: ['ashes cricket', 'the ashes series'], metadata: { kind: 'competition', sport_canonical: 'cricket', scope: 'series', league_canonical: 'ICC' }, domain_category: 'sports' },

  { canonical: 'The International', type: 'competition', aliases: ['TI', 'Dota 2 World Championship', 'ti dota', 'the international dota'], metadata: { kind: 'competition', sport_canonical: 'dota 2', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'ESL Pro League', type: 'league', aliases: ['ESL', 'esl pro league cs', 'esl counter-strike'], metadata: { kind: 'league', sport_canonical: 'cs2' }, domain_category: 'sports' },
  { canonical: 'IEM', type: 'competition', aliases: ['Intel Extreme Masters', 'iem', 'intel extreme masters'], metadata: { kind: 'competition', sport_canonical: 'cs2', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'BLAST Premier', type: 'league', aliases: ['blast', 'blast premier cs', 'blast counter-strike'], metadata: { kind: 'league', sport_canonical: 'cs2' }, domain_category: 'sports' },
  { canonical: 'LoL World Championship', type: 'competition', aliases: ['Worlds', 'League of Legends Worlds', 'LoL Worlds', 'lol worlds', 'worlds lol'], metadata: { kind: 'competition', sport_canonical: 'league of legends', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'VCT', type: 'league', aliases: ['Valorant Champions Tour', 'vct valorant', 'valorant champions tour'], metadata: { kind: 'league', sport_canonical: 'valorant' }, domain_category: 'sports' },

  { canonical: 'Six Nations', type: 'competition', aliases: ['Six Nations Championship', '6 Nations', 'six nations rugby', '6 nations rugby'], metadata: { kind: 'competition', sport_canonical: 'rugby union', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'Rugby World Cup', type: 'competition', aliases: ['RWC', 'rugby world cup', 'rugby union world cup'], metadata: { kind: 'competition', sport_canonical: 'rugby union', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'Premiership Rugby', type: 'league', aliases: ['English Premiership Rugby', 'english premiership rugby', 'gallagher premiership'], metadata: { kind: 'league', sport_canonical: 'rugby union', country: 'GB', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'Top 14', type: 'league', aliases: ['French Top 14', 'top 14 rugby', 'french rugby league'], metadata: { kind: 'league', sport_canonical: 'rugby union', country: 'FR', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'Super Rugby', type: 'league', aliases: ['super rugby pacific', 'super rugby trans-tasman'], metadata: { kind: 'league', sport_canonical: 'rugby union', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'NRL', type: 'league', aliases: ['National Rugby League', 'nrl rugby league', 'australian rugby league'], metadata: { kind: 'league', sport_canonical: 'rugby league', country: 'AU', level: 'top_flight' }, domain_category: 'sports' },

  { canonical: 'Formula 1 Championship', type: 'league', aliases: ['F1 World Championship', 'FIA Formula One', 'f1 championship', 'formula 1 world championship'], metadata: { kind: 'league', sport_canonical: 'formula 1', level: 'top_flight' }, domain_category: 'sports' },
  { canonical: 'NASCAR Cup Series', type: 'league', aliases: ['NASCAR', 'Cup Series', 'nascar cup', 'nascar cup series'], metadata: { kind: 'league', sport_canonical: 'nascar', country: 'US', level: 'top_flight' }, domain_category: 'sports' },
];

export const COMPETITIONS: EntitySeed[] = [
  { canonical: 'NBA Playoffs', type: 'competition', aliases: ['NBA postseason', 'nba playoffs', 'nba playoff'], metadata: { kind: 'competition', league_canonical: 'NBA', sport_canonical: 'basketball', tour_gender: 'men', scope: 'playoff' }, domain_category: 'sports' },
  { canonical: 'NBA Finals', type: 'competition', aliases: ['NBA Championship', 'nba finals', 'nba championship', 'win nba finals', 'advance to nba finals'], metadata: { kind: 'competition', league_canonical: 'NBA', sport_canonical: 'basketball', tour_gender: 'men', scope: 'playoff' }, domain_category: 'sports' },
  { canonical: 'Stanley Cup', type: 'competition', aliases: ['Stanley Cup Playoffs', 'Stanley Cup Finals', 'nhl playoffs', 'stanley cup', 'nhl finals'], metadata: { kind: 'competition', league_canonical: 'NHL', sport_canonical: 'ice hockey', tour_gender: 'men', scope: 'playoff' }, domain_category: 'sports' },
  { canonical: 'Super Bowl', type: 'competition', aliases: ['NFL Championship', 'nfl super bowl', 'super bowl', 'nfl championship game'], metadata: { kind: 'competition', league_canonical: 'NFL', sport_canonical: 'american football', tour_gender: 'men', scope: 'playoff' }, domain_category: 'sports' },
  { canonical: 'NFL Playoffs', type: 'competition', aliases: ['NFL postseason', 'nfl playoffs', 'nfl playoff'], metadata: { kind: 'competition', league_canonical: 'NFL', sport_canonical: 'american football', tour_gender: 'men', scope: 'playoff' }, domain_category: 'sports' },
  { canonical: 'MLB World Series', type: 'competition', aliases: ['World Series', 'mlb world series', 'world series baseball', 'fall classic'], metadata: { kind: 'competition', league_canonical: 'MLB', sport_canonical: 'baseball', tour_gender: 'men', scope: 'playoff' }, domain_category: 'sports' },
  { canonical: 'MLB Playoffs', type: 'competition', aliases: ['MLB postseason', 'mlb playoffs', 'mlb playoff'], metadata: { kind: 'competition', league_canonical: 'MLB', sport_canonical: 'baseball', tour_gender: 'men', scope: 'playoff' }, domain_category: 'sports' },
  { canonical: 'March Madness', type: 'competition', aliases: ['NCAA Tournament', 'ncaa tournament basketball', 'march madness basketball', 'ncaa march madness', 'college basketball tournament'], metadata: { kind: 'competition', league_canonical: 'NCAAB', sport_canonical: 'basketball (ncaa)', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'College Football Playoff', type: 'competition', aliases: ['CFP', 'cfp football', 'college football playoff', 'ncaaf playoffs'], metadata: { kind: 'competition', league_canonical: 'NCAAF', sport_canonical: 'american football (ncaa)', tour_gender: 'men', scope: 'playoff' }, domain_category: 'sports' },
  { canonical: 'Wimbledon', type: 'competition', aliases: ['Wimbledon Championships', 'the championships wimbledon', 'wimbledon tennis'], metadata: { kind: 'competition', league_canonical: 'Grand Slam', sport_canonical: 'tennis', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'US Open Tennis', type: 'competition', aliases: ['US Open', 'us open tennis', 'usta open', 'flushing meadows'], metadata: { kind: 'competition', league_canonical: 'Grand Slam', sport_canonical: 'tennis', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'French Open', type: 'competition', aliases: ['Roland Garros', 'roland garros', 'french open tennis'], metadata: { kind: 'competition', league_canonical: 'Grand Slam', sport_canonical: 'tennis', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'Australian Open', type: 'competition', aliases: ['AO', 'australian open tennis', 'ao tennis'], metadata: { kind: 'competition', league_canonical: 'Grand Slam', sport_canonical: 'tennis', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'Champions League Final', type: 'competition', aliases: ['UCL Final', 'european cup final', 'champions league final'], metadata: { kind: 'competition', league_canonical: 'Champions League', sport_canonical: 'soccer', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'UEFA Euro', type: 'competition', aliases: ['European Championship', 'Euro 2024', 'Euro 2028', 'euros football', 'european football championship'], metadata: { kind: 'competition', sport_canonical: 'soccer', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'Copa America', type: 'competition', aliases: ['CONMEBOL Copa America', 'copa america', 'copa america soccer'], metadata: { kind: 'competition', sport_canonical: 'soccer', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'Olympics', type: 'competition', aliases: ['Summer Olympics', 'Olympic Games', 'olympic games', 'summer olympic games'], metadata: { kind: 'competition', scope: 'tournament' }, domain_category: 'sports' },
  { canonical: 'Winter Olympics', type: 'competition', aliases: ['Winter Olympic Games', 'winter olympics'], metadata: { kind: 'competition', scope: 'tournament' }, domain_category: 'sports' },
];

const PROVIDERS: EntitySeed[] = [
  { canonical: 'Binance', type: 'data_provider', aliases: ['binance', 'binance.com', 'binance exchange', 'Binance Exchange'], metadata: { kind: 'data_provider', domain: 'exchange', covers: ['BTC', 'ETH', 'crypto'] }, domain_category: 'crypto' },
  { canonical: 'Coinbase', type: 'data_provider', aliases: ['coinbase', 'coinbase.com', 'coinbase pro', 'coinbase exchange', 'Coinbase Pro'], metadata: { kind: 'data_provider', domain: 'exchange', covers: ['BTC', 'ETH', 'crypto'] }, domain_category: 'crypto' },
  { canonical: 'Kraken', type: 'data_provider', aliases: ['kraken', 'kraken.com', 'kraken exchange'], metadata: { kind: 'data_provider', domain: 'exchange', covers: ['BTC', 'ETH', 'crypto'] }, domain_category: 'crypto' },
  { canonical: 'OKX', type: 'data_provider', aliases: ['okx', 'okex', 'OKEx'], metadata: { kind: 'data_provider', domain: 'exchange', covers: ['BTC', 'ETH', 'crypto'] }, domain_category: 'crypto' },
  { canonical: 'Bybit', type: 'data_provider', aliases: ['bybit', 'bybit.com', 'bybit exchange'], metadata: { kind: 'data_provider', domain: 'exchange', covers: ['BTC', 'ETH', 'crypto'] }, domain_category: 'crypto' },
  { canonical: 'Chainlink', type: 'data_provider', aliases: ['chainlink', 'LINK oracle', 'chainlink oracle', 'chainlink price feed'], metadata: { kind: 'data_provider', domain: 'oracle', covers: ['BTC', 'ETH', 'crypto'] }, domain_category: 'crypto' },
  { canonical: 'Pyth Network', type: 'data_provider', aliases: ['Pyth', 'pyth', 'pyth oracle', 'pyth network', 'pyth.network'], metadata: { kind: 'data_provider', domain: 'oracle', covers: ['BTC', 'ETH', 'crypto'] }, domain_category: 'crypto' },
  { canonical: 'CF Benchmarks', type: 'data_provider', aliases: ['CF', 'cf benchmarks', 'cf bitcoin settlement price', 'CME CF', 'cme cf bitcoin reference rate', 'CF Benchmarks BRTI', 'CF Benchmarks ERTI', 'SOLUSD_RTI', 'XRPUSD_RTI', 'BNBUSD_RTI', 'DOGEUSD_RTI', 'UHYPEUSDRTI'], metadata: { kind: 'data_provider', domain: 'candle_aggregator', covers: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE', 'crypto'] }, domain_category: 'crypto' },
  { canonical: 'CoinGecko', type: 'data_provider', aliases: ['coingecko', 'coin gecko', 'coingecko.com'], metadata: { kind: 'data_provider', domain: 'candle_aggregator', covers: ['crypto'] }, domain_category: 'crypto' },
  { canonical: 'CoinMarketCap', type: 'data_provider', aliases: ['CMC', 'coinmarketcap', 'coin market cap', 'coinmarketcap.com'], metadata: { kind: 'data_provider', domain: 'candle_aggregator', covers: ['crypto'] }, domain_category: 'crypto' },

  { canonical: 'NBA (official)', type: 'data_provider', aliases: ['NBA official', 'nba.com', 'official NBA', 'NBA official information', 'Official NBA statistics', 'official nba stats', 'nba official stats', 'nba stats official'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['NBA', 'basketball'] }, domain_category: 'sports' },
  { canonical: 'NFL (official)', type: 'data_provider', aliases: ['NFL official', 'nfl.com', 'official NFL', 'NFL official information', 'nfl official stats'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['NFL', 'american football'] }, domain_category: 'sports' },
  { canonical: 'NHL (official)', type: 'data_provider', aliases: ['NHL official', 'nhl.com', 'official NHL', 'NHL official information', 'nhl official stats'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['NHL', 'ice hockey'] }, domain_category: 'sports' },
  { canonical: 'MLB (official)', type: 'data_provider', aliases: ['MLB official', 'mlb.com', 'official MLB', 'MLB official information', 'mlb official stats'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['MLB', 'baseball'] }, domain_category: 'sports' },
  { canonical: 'UEFA (official)', type: 'data_provider', aliases: ['UEFA official', 'uefa.com', 'official UEFA', 'UEFA official information'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['Champions League', 'Europa League', 'Conference League', 'soccer'] }, domain_category: 'sports' },
  { canonical: 'FIFA (official)', type: 'data_provider', aliases: ['FIFA official', 'fifa.com', 'official FIFA'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['FIFA World Cup', 'soccer'] }, domain_category: 'sports' },
  { canonical: 'ATP (official)', type: 'data_provider', aliases: ['ATP official', 'atptour.com', 'ATP Tour official', 'atp official tennis'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['ATP Tour', 'tennis'] }, domain_category: 'sports' },
  { canonical: 'WTA (official)', type: 'data_provider', aliases: ['WTA official', 'wtatennis.com', 'WTA Tour official'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['WTA Tour', 'tennis'] }, domain_category: 'sports' },
  { canonical: 'PGA Tour (official)', type: 'data_provider', aliases: ['PGA Tour official', 'pgatour.com', 'pga tour official stats'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['PGA Tour', 'golf'] }, domain_category: 'sports' },
  { canonical: 'UFC (official)', type: 'data_provider', aliases: ['UFC official', 'ufc.com', 'official UFC results'], metadata: { kind: 'data_provider', domain: 'league_official', covers: ['UFC', 'mma'] }, domain_category: 'sports' },
  { canonical: 'ESPN', type: 'data_provider', aliases: ['espn', 'espn.com', 'ESPN Sports'], metadata: { kind: 'data_provider', domain: 'media', covers: ['basketball', 'american football', 'baseball', 'ice hockey', 'soccer'] }, domain_category: 'sports' },

  { canonical: 'Dotabuff', type: 'data_provider', aliases: ['dotabuff', 'dotabuff.com', 'Dotabuff (dotabuff.com)'], metadata: { kind: 'data_provider', domain: 'esports_stats', covers: ['dota 2'] }, domain_category: 'sports' },
  { canonical: 'OpenDota', type: 'data_provider', aliases: ['opendota', 'opendota.com'], metadata: { kind: 'data_provider', domain: 'esports_stats', covers: ['dota 2'] }, domain_category: 'sports' },
  { canonical: 'gol.gg', type: 'data_provider', aliases: ['gol.gg', 'golgg', 'gol gg lol', 'gol gg league of legends'], metadata: { kind: 'data_provider', domain: 'esports_stats', covers: ['league of legends'] }, domain_category: 'sports' },
  { canonical: 'HLTV', type: 'data_provider', aliases: ['hltv', 'hltv.org', 'hltv cs', 'hltv counter-strike'], metadata: { kind: 'data_provider', domain: 'esports_stats', covers: ['cs2'] }, domain_category: 'sports' },

  { canonical: 'Yahoo Finance', type: 'data_provider', aliases: ['yahoo finance', 'finance.yahoo.com', 'yahoo financial'], metadata: { kind: 'data_provider', domain: 'candle_aggregator', covers: ['stocks', 'finance'] }, domain_category: 'finance' },
  { canonical: 'Bloomberg', type: 'data_provider', aliases: ['bloomberg', 'bloomberg.com', 'bloomberg terminal'], metadata: { kind: 'data_provider', domain: 'media', covers: ['finance', 'economic'] }, domain_category: 'finance' },
  { canonical: 'Reuters', type: 'data_provider', aliases: ['reuters', 'reuters.com', 'reuters news'], metadata: { kind: 'data_provider', domain: 'media' }, domain_category: 'other' },
  { canonical: 'AP', type: 'data_provider', aliases: ['Associated Press', 'ap news', 'apnews.com', 'ap wire'], metadata: { kind: 'data_provider', domain: 'media' }, domain_category: 'other' },
  { canonical: 'Federal Reserve', type: 'data_provider', aliases: ['Fed', 'federal reserve', 'fed reserve', 'fomc', 'Federal Open Market Committee', 'Federal Reserve Bank'], metadata: { kind: 'data_provider', domain: 'election_authority', covers: ['economic', 'finance'] }, domain_category: 'finance' },
  { canonical: 'FiveThirtyEight', type: 'data_provider', aliases: ['538', 'fivethirtyeight', 'fivethirtyeight.com'], metadata: { kind: 'data_provider', domain: 'media', covers: ['election', 'politics'] }, domain_category: 'politics' },
  { canonical: 'PredictIt', type: 'data_provider', aliases: ['predictit', 'predictit.org'], metadata: { kind: 'data_provider', domain: 'media', covers: ['election', 'politics'] }, domain_category: 'politics' },
  { canonical: 'Cook Political Report', type: 'data_provider', aliases: ['Cook Report', 'cook political', 'cook political report'], metadata: { kind: 'data_provider', domain: 'media', covers: ['election'] }, domain_category: 'politics' },
];

const RELATIONS: RelationSeed[] = [
  { parentCanonical: 'NBA',          childCanonical: 'basketball',               relation: 'part_of' },
  { parentCanonical: 'WNBA',         childCanonical: 'basketball',               relation: 'part_of' },
  { parentCanonical: 'EuroLeague',   childCanonical: 'basketball',               relation: 'part_of' },
  { parentCanonical: 'NCAAB',        childCanonical: 'basketball (ncaa)',         relation: 'part_of' },
  { parentCanonical: 'G League',     childCanonical: 'basketball',               relation: 'part_of' },
  { parentCanonical: 'NFL',          childCanonical: 'american football',        relation: 'part_of' },
  { parentCanonical: 'NCAAF',        childCanonical: 'american football (ncaa)', relation: 'part_of' },
  { parentCanonical: 'CFL',          childCanonical: 'american football',        relation: 'part_of' },
  { parentCanonical: 'XFL',          childCanonical: 'american football',        relation: 'part_of' },
  { parentCanonical: 'Premier League', childCanonical: 'soccer',                 relation: 'part_of' },
  { parentCanonical: 'La Liga',      childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Bundesliga',   childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Serie A',      childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Ligue 1',      childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Eredivisie',   childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Primeira Liga',childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'MLS',          childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Championship', childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Austrian Bundesliga', childCanonical: 'soccer',            relation: 'part_of' },
  { parentCanonical: 'HNL',          childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Süper Lig',    childCanonical: 'soccer',                   relation: 'part_of' },
  { parentCanonical: 'Belgian Pro League', childCanonical: 'soccer',             relation: 'part_of' },
  { parentCanonical: 'Champions League', childCanonical: 'soccer',               relation: 'part_of' },
  { parentCanonical: 'Europa League',    childCanonical: 'soccer',               relation: 'part_of' },
  { parentCanonical: 'Conference League', childCanonical: 'soccer',              relation: 'part_of' },
  { parentCanonical: 'FIFA World Cup',   childCanonical: 'soccer',               relation: 'part_of' },
  { parentCanonical: 'MLB',          childCanonical: 'baseball',                 relation: 'part_of' },
  { parentCanonical: 'NPB',          childCanonical: 'baseball',                 relation: 'part_of' },
  { parentCanonical: 'KBO',          childCanonical: 'baseball',                 relation: 'part_of' },
  { parentCanonical: 'NHL',          childCanonical: 'ice hockey',               relation: 'part_of' },
  { parentCanonical: 'AHL',          childCanonical: 'ice hockey',               relation: 'part_of' },
  { parentCanonical: 'KHL',          childCanonical: 'ice hockey',               relation: 'part_of' },
  { parentCanonical: 'ATP Tour',     childCanonical: 'tennis',                   relation: 'part_of' },
  { parentCanonical: 'WTA Tour',     childCanonical: 'tennis',                   relation: 'part_of' },
  { parentCanonical: 'Grand Slam',   childCanonical: 'tennis',                   relation: 'part_of' },
  { parentCanonical: 'PGA Tour',     childCanonical: 'golf',                     relation: 'part_of' },
  { parentCanonical: 'European Tour',childCanonical: 'golf',                     relation: 'part_of' },
  { parentCanonical: 'LIV Golf',     childCanonical: 'golf',                     relation: 'part_of' },
  { parentCanonical: 'Korn Ferry Tour', childCanonical: 'golf',                  relation: 'part_of' },
  { parentCanonical: 'LPGA Tour',    childCanonical: 'golf',                     relation: 'part_of' },
  { parentCanonical: 'Masters Tournament', childCanonical: 'golf',               relation: 'part_of' },
  { parentCanonical: 'UFC',          childCanonical: 'mma',                      relation: 'part_of' },
  { parentCanonical: 'Bellator',     childCanonical: 'mma',                      relation: 'part_of' },
  { parentCanonical: 'PFL',          childCanonical: 'mma',                      relation: 'part_of' },
  { parentCanonical: 'IPL',          childCanonical: 'cricket',                  relation: 'part_of' },
  { parentCanonical: 'ICC',          childCanonical: 'cricket',                  relation: 'part_of' },
  { parentCanonical: 'The International',    childCanonical: 'dota 2',           relation: 'part_of' },
  { parentCanonical: 'ESL Pro League',       childCanonical: 'cs2',              relation: 'part_of' },
  { parentCanonical: 'IEM',                  childCanonical: 'cs2',              relation: 'part_of' },
  { parentCanonical: 'BLAST Premier',        childCanonical: 'cs2',              relation: 'part_of' },
  { parentCanonical: 'LoL World Championship', childCanonical: 'league of legends', relation: 'part_of' },
  { parentCanonical: 'VCT',                  childCanonical: 'valorant',         relation: 'part_of' },
  { parentCanonical: 'Six Nations',          childCanonical: 'rugby union',      relation: 'part_of' },
  { parentCanonical: 'Rugby World Cup',      childCanonical: 'rugby union',      relation: 'part_of' },
  { parentCanonical: 'Premiership Rugby',    childCanonical: 'rugby union',      relation: 'part_of' },
  { parentCanonical: 'Top 14',               childCanonical: 'rugby union',      relation: 'part_of' },
  { parentCanonical: 'Super Rugby',          childCanonical: 'rugby union',      relation: 'part_of' },
  { parentCanonical: 'NRL',                  childCanonical: 'rugby league',     relation: 'part_of' },
  { parentCanonical: 'Formula 1 Championship', childCanonical: 'formula 1',      relation: 'part_of' },
  { parentCanonical: 'NASCAR Cup Series',    childCanonical: 'nascar',           relation: 'part_of' },
  { parentCanonical: 'NBA Playoffs',    childCanonical: 'NBA',     relation: 'part_of' },
  { parentCanonical: 'NBA Finals',      childCanonical: 'NBA',     relation: 'part_of' },
  { parentCanonical: 'Stanley Cup',     childCanonical: 'NHL',     relation: 'part_of' },
  { parentCanonical: 'Super Bowl',      childCanonical: 'NFL',     relation: 'part_of' },
  { parentCanonical: 'NFL Playoffs',    childCanonical: 'NFL',     relation: 'part_of' },
  { parentCanonical: 'MLB World Series',childCanonical: 'MLB',     relation: 'part_of' },
  { parentCanonical: 'MLB Playoffs',    childCanonical: 'MLB',     relation: 'part_of' },
  { parentCanonical: 'March Madness',   childCanonical: 'NCAAB',   relation: 'part_of' },
  { parentCanonical: 'College Football Playoff', childCanonical: 'NCAAF', relation: 'part_of' },
  { parentCanonical: 'Wimbledon',       childCanonical: 'Grand Slam', relation: 'part_of' },
  { parentCanonical: 'US Open Tennis',  childCanonical: 'Grand Slam', relation: 'part_of' },
  { parentCanonical: 'French Open',     childCanonical: 'Grand Slam', relation: 'part_of' },
  { parentCanonical: 'Australian Open', childCanonical: 'Grand Slam', relation: 'part_of' },
  { parentCanonical: 'Champions League Final', childCanonical: 'Champions League', relation: 'part_of' },
  { parentCanonical: 'NBA (official)',  childCanonical: 'NBA',               relation: 'covers' },
  { parentCanonical: 'NFL (official)',  childCanonical: 'NFL',               relation: 'covers' },
  { parentCanonical: 'NHL (official)',  childCanonical: 'NHL',               relation: 'covers' },
  { parentCanonical: 'MLB (official)',  childCanonical: 'MLB',               relation: 'covers' },
  { parentCanonical: 'UEFA (official)', childCanonical: 'Champions League',  relation: 'covers' },
  { parentCanonical: 'UEFA (official)', childCanonical: 'Europa League',     relation: 'covers' },
  { parentCanonical: 'FIFA (official)', childCanonical: 'FIFA World Cup',    relation: 'covers' },
  { parentCanonical: 'ATP (official)',  childCanonical: 'ATP Tour',          relation: 'covers' },
  { parentCanonical: 'WTA (official)',  childCanonical: 'WTA Tour',          relation: 'covers' },
  { parentCanonical: 'UFC (official)',  childCanonical: 'UFC',               relation: 'covers' },
  { parentCanonical: 'Dotabuff',        childCanonical: 'dota 2',            relation: 'covers' },
  { parentCanonical: 'OpenDota',        childCanonical: 'dota 2',            relation: 'covers' },
  { parentCanonical: 'gol.gg',          childCanonical: 'league of legends', relation: 'covers' },
  { parentCanonical: 'HLTV',            childCanonical: 'cs2',               relation: 'covers' },
];

const TEAM_MAP: Record<string, TeamEntry> = {
  'atl': { league: 'NBA', sport: 'basketball', country: 'US' }, 'atlanta hawks': { league: 'NBA', sport: 'basketball', country: 'US' },
  'bos': { league: 'NBA', sport: 'basketball', country: 'US' }, 'boston celtics': { league: 'NBA', sport: 'basketball', country: 'US' },
  'bkn': { league: 'NBA', sport: 'basketball', country: 'US' }, 'brooklyn nets': { league: 'NBA', sport: 'basketball', country: 'US' },
  'cha': { league: 'NBA', sport: 'basketball', country: 'US' }, 'charlotte hornets': { league: 'NBA', sport: 'basketball', country: 'US' },
  'chi': { league: 'NBA', sport: 'basketball', country: 'US' }, 'chicago bulls': { league: 'NBA', sport: 'basketball', country: 'US' },
  'cle': { league: 'NBA', sport: 'basketball', country: 'US' }, 'cleveland cavaliers': { league: 'NBA', sport: 'basketball', country: 'US' },
  'dal': { league: 'NBA', sport: 'basketball', country: 'US' }, 'dallas mavericks': { league: 'NBA', sport: 'basketball', country: 'US' },
  'den': { league: 'NBA', sport: 'basketball', country: 'US' }, 'denver nuggets': { league: 'NBA', sport: 'basketball', country: 'US' },
  'det': { league: 'NBA', sport: 'basketball', country: 'US' }, 'detroit pistons': { league: 'NBA', sport: 'basketball', country: 'US' },
  'gsw': { league: 'NBA', sport: 'basketball', country: 'US' }, 'golden state warriors': { league: 'NBA', sport: 'basketball', country: 'US' },
  'hou': { league: 'NBA', sport: 'basketball', country: 'US' }, 'houston rockets': { league: 'NBA', sport: 'basketball', country: 'US' },
  'ind': { league: 'NBA', sport: 'basketball', country: 'US' }, 'indiana pacers': { league: 'NBA', sport: 'basketball', country: 'US' },
  'lac': { league: 'NBA', sport: 'basketball', country: 'US' }, 'la clippers': { league: 'NBA', sport: 'basketball', country: 'US' }, 'los angeles clippers': { league: 'NBA', sport: 'basketball', country: 'US' },
  'lal': { league: 'NBA', sport: 'basketball', country: 'US' }, 'la lakers': { league: 'NBA', sport: 'basketball', country: 'US' }, 'los angeles lakers': { league: 'NBA', sport: 'basketball', country: 'US' },
  'mem': { league: 'NBA', sport: 'basketball', country: 'US' }, 'memphis grizzlies': { league: 'NBA', sport: 'basketball', country: 'US' },
  'mia': { league: 'NBA', sport: 'basketball', country: 'US' }, 'miami heat': { league: 'NBA', sport: 'basketball', country: 'US' },
  'mil': { league: 'NBA', sport: 'basketball', country: 'US' }, 'milwaukee bucks': { league: 'NBA', sport: 'basketball', country: 'US' },
  'min': { league: 'NBA', sport: 'basketball', country: 'US' }, 'minnesota timberwolves': { league: 'NBA', sport: 'basketball', country: 'US' },
  'nop': { league: 'NBA', sport: 'basketball', country: 'US' }, 'new orleans pelicans': { league: 'NBA', sport: 'basketball', country: 'US' },
  'nyk': { league: 'NBA', sport: 'basketball', country: 'US' }, 'new york knicks': { league: 'NBA', sport: 'basketball', country: 'US' },
  'okc': { league: 'NBA', sport: 'basketball', country: 'US' }, 'oklahoma city thunder': { league: 'NBA', sport: 'basketball', country: 'US' },
  'orl': { league: 'NBA', sport: 'basketball', country: 'US' }, 'orlando magic': { league: 'NBA', sport: 'basketball', country: 'US' },
  'phi': { league: 'NBA', sport: 'basketball', country: 'US' }, 'philadelphia 76ers': { league: 'NBA', sport: 'basketball', country: 'US' },
  'phx': { league: 'NBA', sport: 'basketball', country: 'US' }, 'phoenix suns': { league: 'NBA', sport: 'basketball', country: 'US' },
  'por': { league: 'NBA', sport: 'basketball', country: 'US' }, 'portland trail blazers': { league: 'NBA', sport: 'basketball', country: 'US' },
  'sac': { league: 'NBA', sport: 'basketball', country: 'US' }, 'sacramento kings': { league: 'NBA', sport: 'basketball', country: 'US' },
  'sas': { league: 'NBA', sport: 'basketball', country: 'US' }, 'san antonio spurs': { league: 'NBA', sport: 'basketball', country: 'US' },
  'tor': { league: 'NBA', sport: 'basketball', country: 'US' }, 'toronto raptors': { league: 'NBA', sport: 'basketball', country: 'US' },
  'uta': { league: 'NBA', sport: 'basketball', country: 'US' }, 'utah jazz': { league: 'NBA', sport: 'basketball', country: 'US' },
  'was': { league: 'NBA', sport: 'basketball', country: 'US' }, 'washington wizards': { league: 'NBA', sport: 'basketball', country: 'US' },
  'ari': { league: 'NFL', sport: 'american football', country: 'US' }, 'arizona cardinals': { league: 'NFL', sport: 'american football', country: 'US' },
  'atl falcons': { league: 'NFL', sport: 'american football', country: 'US' }, 'atlanta falcons': { league: 'NFL', sport: 'american football', country: 'US' },
  'bal': { league: 'NFL', sport: 'american football', country: 'US' }, 'baltimore ravens': { league: 'NFL', sport: 'american football', country: 'US' },
  'buf': { league: 'NFL', sport: 'american football', country: 'US' }, 'buffalo bills': { league: 'NFL', sport: 'american football', country: 'US' },
  'car': { league: 'NFL', sport: 'american football', country: 'US' }, 'carolina panthers': { league: 'NFL', sport: 'american football', country: 'US' },
  'chib': { league: 'NFL', sport: 'american football', country: 'US' }, 'chicago bears': { league: 'NFL', sport: 'american football', country: 'US' },
  'cin': { league: 'NFL', sport: 'american football', country: 'US' }, 'cincinnati bengals': { league: 'NFL', sport: 'american football', country: 'US' },
  'cle browns': { league: 'NFL', sport: 'american football', country: 'US' }, 'cleveland browns': { league: 'NFL', sport: 'american football', country: 'US' },
  'dal cowboys': { league: 'NFL', sport: 'american football', country: 'US' }, 'dallas cowboys': { league: 'NFL', sport: 'american football', country: 'US' },
  'den broncos': { league: 'NFL', sport: 'american football', country: 'US' }, 'denver broncos': { league: 'NFL', sport: 'american football', country: 'US' },
  'det lions': { league: 'NFL', sport: 'american football', country: 'US' }, 'detroit lions': { league: 'NFL', sport: 'american football', country: 'US' },
  'gb': { league: 'NFL', sport: 'american football', country: 'US' }, 'green bay packers': { league: 'NFL', sport: 'american football', country: 'US' },
  'hou texans': { league: 'NFL', sport: 'american football', country: 'US' }, 'houston texans': { league: 'NFL', sport: 'american football', country: 'US' },
  'ind colts': { league: 'NFL', sport: 'american football', country: 'US' }, 'indianapolis colts': { league: 'NFL', sport: 'american football', country: 'US' },
  'jac': { league: 'NFL', sport: 'american football', country: 'US' }, 'jacksonville jaguars': { league: 'NFL', sport: 'american football', country: 'US' },
  'kc': { league: 'NFL', sport: 'american football', country: 'US' }, 'kansas city chiefs': { league: 'NFL', sport: 'american football', country: 'US' },
  'lvr': { league: 'NFL', sport: 'american football', country: 'US' }, 'las vegas raiders': { league: 'NFL', sport: 'american football', country: 'US' },
  'lac chargers': { league: 'NFL', sport: 'american football', country: 'US' }, 'los angeles chargers': { league: 'NFL', sport: 'american football', country: 'US' },
  'lar': { league: 'NFL', sport: 'american football', country: 'US' }, 'los angeles rams': { league: 'NFL', sport: 'american football', country: 'US' },
  'mia dolphins': { league: 'NFL', sport: 'american football', country: 'US' }, 'miami dolphins': { league: 'NFL', sport: 'american football', country: 'US' },
  'min vikings': { league: 'NFL', sport: 'american football', country: 'US' }, 'minnesota vikings': { league: 'NFL', sport: 'american football', country: 'US' },
  'ne': { league: 'NFL', sport: 'american football', country: 'US' }, 'new england patriots': { league: 'NFL', sport: 'american football', country: 'US' },
  'no': { league: 'NFL', sport: 'american football', country: 'US' }, 'new orleans saints': { league: 'NFL', sport: 'american football', country: 'US' },
  'nyg': { league: 'NFL', sport: 'american football', country: 'US' }, 'new york giants': { league: 'NFL', sport: 'american football', country: 'US' },
  'nyj': { league: 'NFL', sport: 'american football', country: 'US' }, 'new york jets': { league: 'NFL', sport: 'american football', country: 'US' },
  'phi eagles': { league: 'NFL', sport: 'american football', country: 'US' }, 'philadelphia eagles': { league: 'NFL', sport: 'american football', country: 'US' },
  'pit': { league: 'NFL', sport: 'american football', country: 'US' }, 'pittsburgh steelers': { league: 'NFL', sport: 'american football', country: 'US' },
  'sf': { league: 'NFL', sport: 'american football', country: 'US' }, 'san francisco 49ers': { league: 'NFL', sport: 'american football', country: 'US' },
  'sea': { league: 'NFL', sport: 'american football', country: 'US' }, 'seattle seahawks': { league: 'NFL', sport: 'american football', country: 'US' },
  'tb': { league: 'NFL', sport: 'american football', country: 'US' }, 'tampa bay buccaneers': { league: 'NFL', sport: 'american football', country: 'US' },
  'ten': { league: 'NFL', sport: 'american football', country: 'US' }, 'tennessee titans': { league: 'NFL', sport: 'american football', country: 'US' },
  'was commanders': { league: 'NFL', sport: 'american football', country: 'US' }, 'washington commanders': { league: 'NFL', sport: 'american football', country: 'US' },
  'ana': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'anaheim ducks': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'bos bruins': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'boston bruins': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'buf sabres': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'buffalo sabres': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'cgy': { league: 'NHL', sport: 'ice hockey', country: 'CA' }, 'calgary flames': { league: 'NHL', sport: 'ice hockey', country: 'CA' },
  'car hurricanes': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'carolina hurricanes': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'chi blackhawks': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'chicago blackhawks': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'col': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'colorado avalanche': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'cbj': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'columbus blue jackets': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'dal stars': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'dallas stars': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'det red wings': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'detroit red wings': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'edm': { league: 'NHL', sport: 'ice hockey', country: 'CA' }, 'edmonton oilers': { league: 'NHL', sport: 'ice hockey', country: 'CA' },
  'fla': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'florida panthers': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'lak': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'los angeles kings': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'min wild': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'minnesota wild': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'mtl': { league: 'NHL', sport: 'ice hockey', country: 'CA' }, 'montreal canadiens': { league: 'NHL', sport: 'ice hockey', country: 'CA' },
  'nsh': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'nashville predators': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'njd': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'new jersey devils': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'nyi': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'new york islanders': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'nyr': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'new york rangers': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'ott': { league: 'NHL', sport: 'ice hockey', country: 'CA' }, 'ottawa senators': { league: 'NHL', sport: 'ice hockey', country: 'CA' },
  'phi flyers': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'philadelphia flyers': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'pit penguins': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'pittsburgh penguins': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'sea kraken': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'seattle kraken': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'sjn': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'san jose sharks': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'stl': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'st. louis blues': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'tbl': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'tampa bay lightning': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'tor maple leafs': { league: 'NHL', sport: 'ice hockey', country: 'CA' }, 'toronto maple leafs': { league: 'NHL', sport: 'ice hockey', country: 'CA' },
  'van': { league: 'NHL', sport: 'ice hockey', country: 'CA' }, 'vancouver canucks': { league: 'NHL', sport: 'ice hockey', country: 'CA' },
  'vgk': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'vegas golden knights': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'wpg': { league: 'NHL', sport: 'ice hockey', country: 'CA' }, 'winnipeg jets': { league: 'NHL', sport: 'ice hockey', country: 'CA' },
  'wsh': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'washington capitals': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'uah': { league: 'NHL', sport: 'ice hockey', country: 'US' }, 'utah hockey club': { league: 'NHL', sport: 'ice hockey', country: 'US' },
  'ari diamondbacks': { league: 'MLB', sport: 'baseball', country: 'US' }, 'arizona diamondbacks': { league: 'MLB', sport: 'baseball', country: 'US' },
  'atl braves': { league: 'MLB', sport: 'baseball', country: 'US' }, 'atlanta braves': { league: 'MLB', sport: 'baseball', country: 'US' },
  'bal orioles': { league: 'MLB', sport: 'baseball', country: 'US' }, 'baltimore orioles': { league: 'MLB', sport: 'baseball', country: 'US' },
  'bos red sox': { league: 'MLB', sport: 'baseball', country: 'US' }, 'boston red sox': { league: 'MLB', sport: 'baseball', country: 'US' },
  'chc': { league: 'MLB', sport: 'baseball', country: 'US' }, 'chicago cubs': { league: 'MLB', sport: 'baseball', country: 'US' },
  'cws': { league: 'MLB', sport: 'baseball', country: 'US' }, 'chicago white sox': { league: 'MLB', sport: 'baseball', country: 'US' },
  'cin reds': { league: 'MLB', sport: 'baseball', country: 'US' }, 'cincinnati reds': { league: 'MLB', sport: 'baseball', country: 'US' },
  'cle guardians': { league: 'MLB', sport: 'baseball', country: 'US' }, 'cleveland guardians': { league: 'MLB', sport: 'baseball', country: 'US' },
  'col rockies': { league: 'MLB', sport: 'baseball', country: 'US' }, 'colorado rockies': { league: 'MLB', sport: 'baseball', country: 'US' },
  'det tigers': { league: 'MLB', sport: 'baseball', country: 'US' }, 'detroit tigers': { league: 'MLB', sport: 'baseball', country: 'US' },
  'hou astros': { league: 'MLB', sport: 'baseball', country: 'US' }, 'houston astros': { league: 'MLB', sport: 'baseball', country: 'US' },
  'kc royals': { league: 'MLB', sport: 'baseball', country: 'US' }, 'kansas city royals': { league: 'MLB', sport: 'baseball', country: 'US' },
  'laa': { league: 'MLB', sport: 'baseball', country: 'US' }, 'los angeles angels': { league: 'MLB', sport: 'baseball', country: 'US' },
  'lad': { league: 'MLB', sport: 'baseball', country: 'US' }, 'los angeles dodgers': { league: 'MLB', sport: 'baseball', country: 'US' },
  'mia marlins': { league: 'MLB', sport: 'baseball', country: 'US' }, 'miami marlins': { league: 'MLB', sport: 'baseball', country: 'US' },
  'mil brewers': { league: 'MLB', sport: 'baseball', country: 'US' }, 'milwaukee brewers': { league: 'MLB', sport: 'baseball', country: 'US' },
  'min twins': { league: 'MLB', sport: 'baseball', country: 'US' }, 'minnesota twins': { league: 'MLB', sport: 'baseball', country: 'US' },
  'nym': { league: 'MLB', sport: 'baseball', country: 'US' }, 'new york mets': { league: 'MLB', sport: 'baseball', country: 'US' },
  'nyy': { league: 'MLB', sport: 'baseball', country: 'US' }, 'new york yankees': { league: 'MLB', sport: 'baseball', country: 'US' },
  'oak': { league: 'MLB', sport: 'baseball', country: 'US' }, 'oakland athletics': { league: 'MLB', sport: 'baseball', country: 'US' },
  'phi phillies': { league: 'MLB', sport: 'baseball', country: 'US' }, 'philadelphia phillies': { league: 'MLB', sport: 'baseball', country: 'US' },
  'pit pirates': { league: 'MLB', sport: 'baseball', country: 'US' }, 'pittsburgh pirates': { league: 'MLB', sport: 'baseball', country: 'US' },
  'sd': { league: 'MLB', sport: 'baseball', country: 'US' }, 'san diego padres': { league: 'MLB', sport: 'baseball', country: 'US' },
  'sf giants': { league: 'MLB', sport: 'baseball', country: 'US' }, 'san francisco giants': { league: 'MLB', sport: 'baseball', country: 'US' },
  'sea mariners': { league: 'MLB', sport: 'baseball', country: 'US' }, 'seattle mariners': { league: 'MLB', sport: 'baseball', country: 'US' },
  'stl cardinals': { league: 'MLB', sport: 'baseball', country: 'US' }, 'st. louis cardinals': { league: 'MLB', sport: 'baseball', country: 'US' },
  'tb rays': { league: 'MLB', sport: 'baseball', country: 'US' }, 'tampa bay rays': { league: 'MLB', sport: 'baseball', country: 'US' },
  'tex': { league: 'MLB', sport: 'baseball', country: 'US' }, 'texas rangers': { league: 'MLB', sport: 'baseball', country: 'US' },
  'tor blue jays': { league: 'MLB', sport: 'baseball', country: 'CA' }, 'toronto blue jays': { league: 'MLB', sport: 'baseball', country: 'CA' },
  'wsh nationals': { league: 'MLB', sport: 'baseball', country: 'US' }, 'washington nationals': { league: 'MLB', sport: 'baseball', country: 'US' },
  'arsenal': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'aston villa': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'brentford': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'brighton': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'chelsea': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'crystal palace': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'everton': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'fulham': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'ipswich': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'leicester city': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'liverpool': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'manchester city': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'manchester united': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'newcastle united': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'nottingham forest': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'southampton': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'tottenham hotspur': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'tottenham': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'west ham united': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'wolverhampton wanderers': { league: 'Premier League', sport: 'soccer', country: 'GB' }, 'wolves': { league: 'Premier League', sport: 'soccer', country: 'GB' },
  'real madrid': { league: 'La Liga', sport: 'soccer', country: 'ES' }, 'barcelona': { league: 'La Liga', sport: 'soccer', country: 'ES' },
  'atletico madrid': { league: 'La Liga', sport: 'soccer', country: 'ES' }, 'athletic bilbao': { league: 'La Liga', sport: 'soccer', country: 'ES' },
  'real sociedad': { league: 'La Liga', sport: 'soccer', country: 'ES' }, 'real betis': { league: 'La Liga', sport: 'soccer', country: 'ES' },
  'villarreal': { league: 'La Liga', sport: 'soccer', country: 'ES' }, 'valencia': { league: 'La Liga', sport: 'soccer', country: 'ES' },
  'sevilla': { league: 'La Liga', sport: 'soccer', country: 'ES' }, 'osasuna': { league: 'La Liga', sport: 'soccer', country: 'ES' }, 'getafe': { league: 'La Liga', sport: 'soccer', country: 'ES' },
  'bayer leverkusen': { league: 'Bundesliga', sport: 'soccer', country: 'DE' }, 'borussia dortmund': { league: 'Bundesliga', sport: 'soccer', country: 'DE' },
  'dortmund': { league: 'Bundesliga', sport: 'soccer', country: 'DE' }, 'bvb': { league: 'Bundesliga', sport: 'soccer', country: 'DE' },
  'bayern munich': { league: 'Bundesliga', sport: 'soccer', country: 'DE' }, 'eintracht frankfurt': { league: 'Bundesliga', sport: 'soccer', country: 'DE' },
  'rb leipzig': { league: 'Bundesliga', sport: 'soccer', country: 'DE' }, 'vfb stuttgart': { league: 'Bundesliga', sport: 'soccer', country: 'DE' },
  'borussia monchengladbach': { league: 'Bundesliga', sport: 'soccer', country: 'DE' }, 'werder bremen': { league: 'Bundesliga', sport: 'soccer', country: 'DE' },
  'napoli': { league: 'Serie A', sport: 'soccer', country: 'IT' }, 'inter milan': { league: 'Serie A', sport: 'soccer', country: 'IT' },
  'ac milan': { league: 'Serie A', sport: 'soccer', country: 'IT' }, 'juventus': { league: 'Serie A', sport: 'soccer', country: 'IT' },
  'as roma': { league: 'Serie A', sport: 'soccer', country: 'IT' }, 'lazio': { league: 'Serie A', sport: 'soccer', country: 'IT' },
  'atalanta': { league: 'Serie A', sport: 'soccer', country: 'IT' }, 'fiorentina': { league: 'Serie A', sport: 'soccer', country: 'IT' }, 'torino': { league: 'Serie A', sport: 'soccer', country: 'IT' },
  'psg': { league: 'Ligue 1', sport: 'soccer', country: 'FR' }, 'paris saint-germain': { league: 'Ligue 1', sport: 'soccer', country: 'FR' },
  'olympique marseille': { league: 'Ligue 1', sport: 'soccer', country: 'FR' }, 'olympique lyonnais': { league: 'Ligue 1', sport: 'soccer', country: 'FR' },
  'monaco': { league: 'Ligue 1', sport: 'soccer', country: 'FR' }, 'lille': { league: 'Ligue 1', sport: 'soccer', country: 'FR' },
  'lens': { league: 'Ligue 1', sport: 'soccer', country: 'FR' }, 'nice': { league: 'Ligue 1', sport: 'soccer', country: 'FR' },
  'inter miami': { league: 'MLS', sport: 'soccer', country: 'US' }, 'inter miami cf': { league: 'MLS', sport: 'soccer', country: 'US' },
  'lafc': { league: 'MLS', sport: 'soccer', country: 'US' }, 'la galaxy': { league: 'MLS', sport: 'soccer', country: 'US' },
  'seattle sounders': { league: 'MLS', sport: 'soccer', country: 'US' }, 'atlanta united': { league: 'MLS', sport: 'soccer', country: 'US' },
  'portland timbers': { league: 'MLS', sport: 'soccer', country: 'US' }, 'new england revolution': { league: 'MLS', sport: 'soccer', country: 'US' },
  'new york city fc': { league: 'MLS', sport: 'soccer', country: 'US' }, 'new york red bulls': { league: 'MLS', sport: 'soccer', country: 'US' },
  'fc cincinnati': { league: 'MLS', sport: 'soccer', country: 'US' }, 'colorado rapids': { league: 'MLS', sport: 'soccer', country: 'US' },
  'columbus crew': { league: 'MLS', sport: 'soccer', country: 'US' }, 'sporting kansas city': { league: 'MLS', sport: 'soccer', country: 'US' },
  'real salt lake': { league: 'MLS', sport: 'soccer', country: 'US' },
};

// Aliases must cover every spelling/pair form, or lookup can resolve 'Bitcoin' to the wrong canonical.
const CRYPTO_ASSETS: EntitySeed[] = [
  {
    canonical: 'BTC', type: 'asset',
    aliases: ['Bitcoin', 'bitcoin', 'BTC/USD', 'BTC/USDT', 'BTCUSD', 'BTCUSDT', 'XBT', 'BTC'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'BTC' }, domain_category: 'crypto',
  },
  {
    canonical: 'ETH', type: 'asset',
    aliases: ['Ethereum', 'ethereum', 'Ether', 'ether', 'ETH/USD', 'ETH/USDT', 'ETHUSD', 'ETHUSDT', 'ETH'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'ETH' }, domain_category: 'crypto',
  },
  {
    canonical: 'SOL', type: 'asset',
    aliases: ['Solana', 'solana', 'SOL/USD', 'SOL/USDT', 'SOLUSDT', 'sol'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'SOL' }, domain_category: 'crypto',
  },
  {
    canonical: 'XRP', type: 'asset',
    aliases: ['Ripple', 'ripple', 'XRP/USD', 'XRP/USDT', 'XRPUSD', 'XRPUSDT', 'XRP'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'XRP' }, domain_category: 'crypto',
  },
  {
    canonical: 'BNB', type: 'asset',
    aliases: ['Binance Coin', 'BNB/USD', 'BNB/USDT', 'BNBUSD', 'BNB'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'BNB' }, domain_category: 'crypto',
  },
  {
    canonical: 'DOGE', type: 'asset',
    aliases: ['Dogecoin', 'dogecoin', 'DOGE/USD', 'DOGE/USDT', 'DOGEUSD', 'DOGEUSDT', 'doge'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'DOGE' }, domain_category: 'crypto',
  },
  {
    canonical: 'ADA', type: 'asset',
    aliases: ['Cardano', 'cardano', 'ADA/USD', 'ADAUSD'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'ADA' }, domain_category: 'crypto',
  },
  {
    canonical: 'AVAX', type: 'asset',
    // 'Avalanche' collides with the NHL team; scoped by the crypto-only alias deny-list.
    aliases: ['Avalanche', 'avalanche', 'AVAX/USD', 'AVAXUSD'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'AVAX' }, domain_category: 'crypto',
  },
  {
    canonical: 'LINK', type: 'asset',
    aliases: ['Chainlink', 'LINK/USD', 'LINKUSD'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'LINK' }, domain_category: 'crypto',
  },
  {
    canonical: 'LTC', type: 'asset',
    aliases: ['Litecoin', 'litecoin', 'LTC/USD', 'LTCUSD'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'LTC' }, domain_category: 'crypto',
  },
  {
    canonical: 'SUI', type: 'asset',
    aliases: ['Sui', 'sui', 'SUI/USD', 'SUIUSD'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'SUI' }, domain_category: 'crypto',
  },
  {
    canonical: 'TRX', type: 'asset',
    aliases: ['Tron', 'tron', 'TRX/USD', 'TRXUSD'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'TRX' }, domain_category: 'crypto',
  },
  {
    canonical: 'HYPE', type: 'asset',
    aliases: ['Hyperliquid', 'hyperliquid', 'HYPE/USD', 'HYPE/USDT', 'HYPEUSD', 'hype'],
    metadata: { kind: 'asset', asset_type: 'crypto', symbol: 'HYPE' }, domain_category: 'crypto',
  },
  {
    canonical: 'NASDAQ 100', type: 'asset',
    aliases: ['Nasdaq 100', 'NASDAQ', 'nasdaq', 'NDX', 'QQQ', 'Nasdaq-100', 'NASDAQ 100 Index'],
    metadata: { kind: 'asset', asset_type: 'index', symbol: 'NDX' }, domain_category: 'finance',
  },
  {
    canonical: 'S&P 500', type: 'asset',
    aliases: ['S&P500', 'SP500', 'SPX', 'S&P 500 Index', 'Standard and Poors 500', 'sp500'],
    metadata: { kind: 'asset', asset_type: 'index', symbol: 'SPX' }, domain_category: 'finance',
  },
  {
    canonical: 'Gold', type: 'asset',
    aliases: ['gold', 'XAUUSD', 'XAU', 'gold price', 'gold close price', 'Gold Price'],
    metadata: { kind: 'asset', asset_type: 'commodity', symbol: 'XAU' }, domain_category: 'finance',
  },
  {
    canonical: 'WTI Crude Oil', type: 'asset',
    aliases: ['WTI', 'wti', 'crude oil', 'West Texas Intermediate', 'WTIUSD', 'USOIL'],
    metadata: { kind: 'asset', asset_type: 'commodity', symbol: 'WTI' }, domain_category: 'finance',
  },
  {
    canonical: 'Brent Crude Oil', type: 'asset',
    aliases: ['Brent', 'brent', 'BRENTUSD', 'UKOIL', 'brent oil'],
    metadata: { kind: 'asset', asset_type: 'commodity', symbol: 'BRENT' }, domain_category: 'finance',
  },
  {
    canonical: 'Heating Oil', type: 'asset',
    aliases: ['heating oil', 'HOILUSD', 'distillate fuel oil'],
    metadata: { kind: 'asset', asset_type: 'commodity', symbol: 'HOIL' }, domain_category: 'finance',
  },
  {
    canonical: 'Silver', type: 'asset',
    aliases: ['silver', 'XAGUSD', 'XAG', 'silver price'],
    metadata: { kind: 'asset', asset_type: 'commodity', symbol: 'XAG' }, domain_category: 'finance',
  },
];

async function upsertEntity(seed: EntitySeed): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO known_entities (canonical, type, aliases, domain_category, metadata)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)
     ON CONFLICT ON CONSTRAINT known_entities_canonical_sport_league_key DO UPDATE SET
       type            = EXCLUDED.type,
       aliases         = (
         SELECT jsonb_agg(DISTINCT alias ORDER BY alias)
         FROM (
           SELECT jsonb_array_elements_text(known_entities.aliases) AS alias
           UNION
           SELECT jsonb_array_elements_text(EXCLUDED.aliases)
         ) sub
       ),
       metadata        = EXCLUDED.metadata || known_entities.metadata,
       domain_category = EXCLUDED.domain_category,
       -- Bump updated_at only when this actually changes, so idempotent reapplies stay quiet.
       updated_at      = CASE WHEN
             known_entities.type IS DISTINCT FROM EXCLUDED.type
          OR known_entities.domain_category IS DISTINCT FROM EXCLUDED.domain_category
          OR NOT (known_entities.aliases @> EXCLUDED.aliases)
          OR (EXCLUDED.metadata || known_entities.metadata) IS DISTINCT FROM known_entities.metadata
         THEN NOW() ELSE known_entities.updated_at END
     RETURNING id`,
    [seed.canonical, seed.type, JSON.stringify(seed.aliases), seed.domain_category, JSON.stringify(seed.metadata)],
  );
  return result[0].id;
}

/** Authoritative upsert: forces `enrichment_status='enriched'` so the row is never
 *  re-queued. Use only for hand-curated ground-truth seeds — generic seeds use
 *  `upsertEntity` so an LLM-corrected canonical is not reverted. */
async function upsertAuthoritativeEntity(seed: EntitySeed): Promise<number> {
  const result = await query<{ id: number }>(AUTHORITATIVE_UPSERT_SQL,
    [seed.canonical, seed.type, JSON.stringify(seed.aliases), seed.domain_category, JSON.stringify(seed.metadata)],
  );
  return result[0].id;
}

/** The metadata merge must keep `|| EXCLUDED.metadata` with the existing map
 *  on the left: seed wins only on named keys, unrelated keys survive. */
export const AUTHORITATIVE_UPSERT_SQL =
  `INSERT INTO known_entities (canonical, type, aliases, domain_category, metadata, enrichment_status)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, 'enriched')
     ON CONFLICT ON CONSTRAINT known_entities_canonical_sport_league_key DO UPDATE SET
       type            = EXCLUDED.type,
       aliases         = (
         SELECT jsonb_agg(DISTINCT alias ORDER BY alias)
         FROM (
           SELECT jsonb_array_elements_text(known_entities.aliases) AS alias
           UNION
           SELECT jsonb_array_elements_text(EXCLUDED.aliases)
         ) sub
       ),
       metadata        = COALESCE(known_entities.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       domain_category = EXCLUDED.domain_category,
       enrichment_status = 'enriched',
       updated_at      = CASE WHEN
             known_entities.type IS DISTINCT FROM EXCLUDED.type
          OR known_entities.domain_category IS DISTINCT FROM EXCLUDED.domain_category
          OR known_entities.enrichment_status IS DISTINCT FROM 'enriched'
          OR NOT (known_entities.aliases @> EXCLUDED.aliases)
          OR (COALESCE(known_entities.metadata, '{}'::jsonb) || EXCLUDED.metadata) IS DISTINCT FROM known_entities.metadata
         THEN NOW() ELSE known_entities.updated_at END
     RETURNING id`;

export async function upsertRelation(parentId: number, childId: number, relation: string): Promise<void> {
  await query(
    `INSERT INTO entity_relations (parent_id, child_id, relation)
     VALUES ($1, $2, $3)
     ON CONFLICT (parent_id, child_id, relation) DO NOTHING`,
    [parentId, childId, relation],
  );
}

export async function seedCryptoAssets(): Promise<number> {
  let upserted = 0;
  for (const seed of CRYPTO_ASSETS) {
    const id = await upsertEntity(seed);
    await mergeAliasVariants(id);
    upserted++;
  }
  return upserted;
}

// Locks canonical/aliases for major US parties and Donald Trump onto one entity each.
export const POLITICS_OVERRIDES: EntitySeed[] = [
  {
    canonical: 'Democratic Party',
    type: 'organization',
    // 'Democrat' stays an alias: unambiguous as a party noun, and outcome labels emit it bare.
    aliases: ['Democratic', 'Democrat', 'Democrats', 'Democratics', 'Dems', 'DNC', 'Democratic National Committee'],
    metadata: { kind: 'political_party', country: 'USA' },
    domain_category: 'politics',
  },
  {
    canonical: 'Republican Party',
    type: 'organization',
    aliases: ['Republican', 'Republicans', 'GOP', 'RNC', 'Republican National Committee', 'Grand Old Party'],
    metadata: { kind: 'political_party', country: 'USA' },
    domain_category: 'politics',
  },
  {
    canonical: 'Donald Trump',
    type: 'person',
    aliases: [
      'Trump',
      'Donald J. Trump',
      'Donald Trump Jr.',
      'Donald J. Trump Jr.',
      'Trump Jr.',
      'DJT',
      'DJTJ',
    ],
    // party_as_of flags staleness for curators.
    metadata: { kind: 'person', role: 'politician', country: 'USA', party: 'Republican Party', party_as_of: '2026-06' },
    domain_category: 'politics',
  },
  // party:'Independent' is read by the independent-aggregate containment guard.
  {
    canonical: 'Dan Osborn',
    type: 'person',
    aliases: ['Dan Osborn (as an independent)'],
    metadata: { kind: 'person', role: 'politician', country: 'USA', party: 'Independent', party_as_of: '2026-07' },
    domain_category: 'politics',
  },
  {
    canonical: 'Ken Block',
    type: 'person',
    aliases: [],
    metadata: { kind: 'person', role: 'politician', country: 'USA', party: 'Independent', party_as_of: '2026-07' },
    domain_category: 'politics',
  },
  {
    canonical: 'Mike Duggan',
    type: 'person',
    aliases: [],
    metadata: { kind: 'person', role: 'politician', country: 'USA', party: 'Independent', party_as_of: '2026-07' },
    domain_category: 'politics',
  },
];

/** Idempotent; authoritative on metadata. */
export async function seedPoliticsOverrides(): Promise<number> {
  for (const seed of POLITICS_OVERRIDES) {
    const id = await upsertAuthoritativeEntity(seed);
    await mergeAliasVariants(id);
  }
  return POLITICS_OVERRIDES.length;
}

// metadata->>'confederation' must equal the aggregate-role node's continent subject.
export const CONTINENT_BY_CONFEDERATION: Readonly<Record<string, string>> = {
  UEFA: 'Europe',
  CONMEBOL: 'South America',
  CONCACAF: 'North America',
  AFC: 'Asia',
  CAF: 'Africa',
  OFC: 'Oceania',
};

/** Australia is AFC (member since 2006), not OFC. */
export const NATIONAL_TEAM_CONFEDERATIONS: ReadonlyArray<{ team: string; confederation: keyof typeof CONTINENT_BY_CONFEDERATION }> = [
  { team: 'Argentina', confederation: 'CONMEBOL' },
  { team: 'Brazil', confederation: 'CONMEBOL' },
  { team: 'Colombia', confederation: 'CONMEBOL' },
  { team: 'Ecuador', confederation: 'CONMEBOL' },
  { team: 'Paraguay', confederation: 'CONMEBOL' },
  { team: 'Uruguay', confederation: 'CONMEBOL' },
  { team: 'Canada', confederation: 'CONCACAF' },
  { team: 'Curaçao', confederation: 'CONCACAF' },
  { team: 'Haiti', confederation: 'CONCACAF' },
  { team: 'Jamaica', confederation: 'CONCACAF' },
  { team: 'Mexico', confederation: 'CONCACAF' },
  { team: 'Panama', confederation: 'CONCACAF' },
  { team: 'USA', confederation: 'CONCACAF' },
  { team: 'Austria', confederation: 'UEFA' },
  { team: 'Belgium', confederation: 'UEFA' },
  { team: 'Bosnia and Herzegovina', confederation: 'UEFA' },
  { team: 'Croatia', confederation: 'UEFA' },
  { team: 'Czechia', confederation: 'UEFA' },
  { team: 'England', confederation: 'UEFA' },
  { team: 'France', confederation: 'UEFA' },
  { team: 'Germany', confederation: 'UEFA' },
  { team: 'Netherlands', confederation: 'UEFA' },
  { team: 'Norway', confederation: 'UEFA' },
  { team: 'Portugal', confederation: 'UEFA' },
  { team: 'Scotland', confederation: 'UEFA' },
  { team: 'Spain', confederation: 'UEFA' },
  { team: 'Sweden', confederation: 'UEFA' },
  { team: 'Switzerland', confederation: 'UEFA' },
  { team: 'Türkiye', confederation: 'UEFA' },
  { team: 'Italy', confederation: 'UEFA' },
  { team: 'Algeria', confederation: 'CAF' },
  { team: 'Cape Verde', confederation: 'CAF' },
  { team: 'Congo DR', confederation: 'CAF' },
  { team: 'Egypt', confederation: 'CAF' },
  { team: 'Ghana', confederation: 'CAF' },
  { team: 'Ivory Coast', confederation: 'CAF' },
  { team: 'Morocco', confederation: 'CAF' },
  { team: 'Senegal', confederation: 'CAF' },
  { team: 'South Africa', confederation: 'CAF' },
  { team: 'Tunisia', confederation: 'CAF' },
  { team: 'Nigeria', confederation: 'CAF' },
  { team: 'Australia', confederation: 'AFC' },
  { team: 'IR Iran', confederation: 'AFC' },
  { team: 'Iraq', confederation: 'AFC' },
  { team: 'Japan', confederation: 'AFC' },
  { team: 'Jordan', confederation: 'AFC' },
  { team: 'Qatar', confederation: 'AFC' },
  { team: 'Saudi Arabia', confederation: 'AFC' },
  { team: 'South Korea', confederation: 'AFC' },
  { team: 'Uzbekistan', confederation: 'AFC' },
  { team: 'New Zealand', confederation: 'OFC' },
  { team: 'New Caledonia', confederation: 'OFC' },
];

export const CONFEDERATION_ORGS: EntitySeed[] = Object.entries({
  UEFA: ['Union of European Football Associations'],
  CONMEBOL: ['South American Football Confederation', 'Confederación Sudamericana de Fútbol'],
  CONCACAF: ['Confederation of North, Central America and Caribbean Association Football'],
  AFC: ['Asian Football Confederation'],
  CAF: ['Confederation of African Football'],
  OFC: ['Oceania Football Confederation'],
}).map(([code, fullNames]) => ({
  canonical: code,
  type: 'organization' as EntityType,
  aliases: fullNames,
  metadata: { kind: 'confederation', continent: CONTINENT_BY_CONFEDERATION[code] },
  domain_category: 'sports',
}));

/** Additive: only stamps confederation metadata where a key is missing, so converged
 *  runs write nothing. */
export async function seedConfederations(): Promise<{ orgsUpserted: number; teamsStamped: number }> {
  let orgsUpserted = 0;
  for (const seed of CONFEDERATION_ORGS) {
    const id = await upsertEntity(seed);
    await mergeAliasVariants(id);
    orgsUpserted++;
  }
  let teamsStamped = 0;
  for (const { team, confederation } of NATIONAL_TEAM_CONFEDERATIONS) {
    const continent = CONTINENT_BY_CONFEDERATION[confederation];
    const rows = await query<{ id: number }>(
      `UPDATE known_entities
       SET metadata   = $2::jsonb || COALESCE(metadata, '{}'::jsonb),
           updated_at = NOW()
       WHERE type IN ('team', 'country')
         AND lower(immutable_unaccent(canonical)) = lower(immutable_unaccent($1))
         AND (metadata IS NULL
              OR NOT (metadata ? 'confederation')
              OR NOT (metadata ? 'confederation_code'))
       RETURNING id`,
      [team, JSON.stringify({ confederation: continent, confederation_code: confederation })],
    );
    teamsStamped += rows.length;
  }
  return { orgsUpserted, teamsStamped };
}

// Kalshi truncates same-city labels to "<City> <letter>" (e.g. "Los Angeles F"=LAFC);
// pinned as exact aliases per team, scoped by sport+league, so exact match wins over fuzzy.
export interface SameCityTeamCode {
  canonical: string;
  sport: string;
  league: string;
  codes: string[];
}

export const SAME_CITY_TEAM_CODES: readonly SameCityTeamCode[] = [
  // MLS — Los Angeles (two teams: F=Football Club, G=Galaxy)
  { canonical: 'Los Angeles FC',      sport: 'soccer',   league: 'MLS', codes: ['Los Angeles F', 'LA F'] },
  { canonical: 'Los Angeles Galaxy',  sport: 'soccer',   league: 'MLS', codes: ['Los Angeles G', 'LA G'] },
  // MLB — Los Angeles (A=Angels, D=Dodgers)
  { canonical: 'Los Angeles Angels',  sport: 'baseball', league: 'MLB', codes: ['Los Angeles A', 'LA A'] },
  { canonical: 'Los Angeles Dodgers', sport: 'baseball', league: 'MLB', codes: ['Los Angeles D', 'LA D'] },
  // MLB — New York (M=Mets, Y=Yankees)
  { canonical: 'New York Mets',       sport: 'baseball', league: 'MLB', codes: ['New York M', 'NY M'] },
  { canonical: 'New York Yankees',    sport: 'baseball', league: 'MLB', codes: ['New York Y', 'NY Y'] },
];

/** All pinned letter-codes (folded); each must live on exactly its owning team. */
function _allPinnedCodeFolds(): Set<string> {
  const out = new Set<string>();
  for (const e of SAME_CITY_TEAM_CODES) for (const c of e.codes) out.add(c.toLowerCase());
  return out;
}

/** The long "<City> <letter>" form (not the short "LA D"), used to derive the city. */
export function longCodeOf(entry: SameCityTeamCode): string {
  return entry.codes.reduce((a, b) => (b.length > a.length ? b : a), entry.codes[0] ?? '');
}
/** Sport+city key (strips the trailing letter token) grouping same-city siblings. */
export function cityKeyOf(entry: SameCityTeamCode): string {
  return `${entry.sport}|${longCodeOf(entry).replace(/\s+\S+$/, '').toLowerCase()}`;
}

/** Idempotent: pins codes on the correct team, strips them elsewhere. */
export async function seedSameCityTeamCodes(): Promise<{
  teamsUpdated: number;
  codesAdded: number;
  poisonRemoved: number;
  normsRepointed: number;
}> {
  let teamsUpdated = 0;
  let codesAdded = 0;
  let poisonRemoved = 0;
  let normsRepointed = 0;

  const ownerByCodeFold = new Map<string, number>(); // code fold → owning entity id
  for (const entry of SAME_CITY_TEAM_CODES) {
    const rows = await query<{ id: number; aliases: string[] }>(
      `SELECT id, aliases FROM known_entities
       WHERE type = 'team'
         AND lower(immutable_unaccent(canonical)) = lower(immutable_unaccent($1))
         AND (sport_canonical IS NULL OR sport_canonical = $2)
         AND (league_canonical IS NULL OR league_canonical = $3)
       ORDER BY
         CASE WHEN sport_canonical = $2 AND league_canonical = $3 THEN 0
              WHEN sport_canonical = $2 THEN 1 ELSE 2 END,
         id ASC
       LIMIT 1`,
      [entry.canonical, entry.sport, entry.league],
    );
    if (rows.length === 0) {
      // Row not minted yet; a later tick pins it once it exists.
      log.info(`[same-city-codes] team "${entry.canonical}" (${entry.sport}/${entry.league}) not present yet — deferring code pin`);
      continue;
    }
    const id = rows[0].id;
    const existing: string[] = Array.isArray(rows[0].aliases) ? rows[0].aliases : JSON.parse((rows[0].aliases as unknown as string) || '[]');
    const existingFolds = new Set(existing.map((a) => a.toLowerCase()));
    const toAdd = entry.codes.filter((c) => !existingFolds.has(c.toLowerCase()));
    for (const c of entry.codes) ownerByCodeFold.set(c.toLowerCase(), id);
    if (toAdd.length > 0) {
      await query(
        `UPDATE known_entities
         SET aliases = (
               SELECT jsonb_agg(DISTINCT alias ORDER BY alias)
               FROM (
                 SELECT jsonb_array_elements_text(aliases) AS alias
                 UNION
                 SELECT unnest($2::text[])
               ) sub
             ),
             updated_at = NOW()
         WHERE id = $1`,
        [id, toAdd],
      );
      codesAdded += toAdd.length;
    }
    await mergeAliasVariants(id);
    teamsUpdated++;
  }

  // Strip every pinned code (and its despace variant) from any non-owner team row.
  for (const entry of SAME_CITY_TEAM_CODES) {
    for (const code of entry.codes) {
      const codeFold = code.toLowerCase();
      const owner = ownerByCodeFold.get(codeFold) ?? null;
      const despace = code.replace(/\s+/g, '').toLowerCase();
      const removed = await query<{ id: number }>(
        `UPDATE known_entities
         SET aliases = COALESCE((
               SELECT jsonb_agg(alias)
               FROM jsonb_array_elements_text(aliases) AS alias
               WHERE lower(immutable_unaccent(alias)) <> lower(immutable_unaccent($2))
                 AND lower(immutable_unaccent(alias)) <> lower(immutable_unaccent($3))
             ), '[]'::jsonb),
             updated_at = NOW()
         WHERE type = 'team'
           AND ($1::int IS NULL OR id <> $1)
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(aliases) AS a
             WHERE lower(immutable_unaccent(a)) = lower(immutable_unaccent($2))
                OR lower(immutable_unaccent(a)) = lower(immutable_unaccent($3))
           )
         RETURNING id`,
        [owner, code, despace],
      );
      if (removed.length > 0) {
        poisonRemoved += removed.length;
        log.info(`[same-city-codes] removed poison alias "${code}"/"${despace}" from ${removed.length} non-owner team row(s)`);
      }
    }
  }

  // Repoint norms stuck on a same-city sibling from before the alias pin existed.
  // `\m`/`\M` are Postgres word-boundary anchors, not standard regex `\b`.
  const codeToRx = (code: string): string => '\\m' + code.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&') + '\\M';
  const byCityKey = new Map<string, SameCityTeamCode[]>();
  for (const e of SAME_CITY_TEAM_CODES) {
    const k = cityKeyOf(e);
    let s = byCityKey.get(k);
    if (!s) { s = []; byCityKey.set(k, s); }
    s.push(e);
  }
  for (const entry of SAME_CITY_TEAM_CODES) {
    // Only repoint once the owner row is confirmed present this run.
    const ownerConfirmed = entry.codes.some((c) => ownerByCodeFold.has(c.toLowerCase()));
    if (!ownerConfirmed) continue;
    const cohort = byCityKey.get(cityKeyOf(entry)) ?? [entry];
    const siblingEntries = cohort.filter((e) => e.canonical.toLowerCase() !== entry.canonical.toLowerCase());
    const siblings = siblingEntries.map((e) => e.canonical);
    if (siblings.length === 0) continue;
    // Skip titles that also mention a sibling's code (ambiguous intra-city matchup).
    const siblingCodeRxs = siblingEntries.flatMap((e) => e.codes.map(codeToRx));
    for (const code of entry.codes) {
      const codeRx = codeToRx(code);
      const res = await query<{ id: number }>(
        `UPDATE llm_market_normalizations n
            SET canonical_subject = $2,
                canonical_event = CASE
                  WHEN n.canonical_event IS NULL THEN NULL
                  ELSE replace(n.canonical_event, n.canonical_subject, $2) END
           FROM markets m
          WHERE n.market_id = m.id
            AND m.title ~* $1
            AND NOT (m.title ~* ANY($4::text[]))
            AND n.canonical_subject = ANY($3::text[])
          RETURNING n.market_id AS id`,
        [codeRx, entry.canonical, siblings, siblingCodeRxs],
      );
      if (res.length > 0) {
        normsRepointed += res.length;
        log.info(`[same-city-codes] repointed ${res.length} stale norm(s) "${code}" → "${entry.canonical}" (was a same-city sibling)`);
      }
    }
  }

  return { teamsUpdated, codesAdded, poisonRemoved, normsRepointed };
}

// Clubs sharing a bare namesake distinguished only by a <=2-char suffix (tokenization
// drops it) need an entry here; a >=3-char qualifier survives tokenization on its own.
export interface NamesakeClub {
  canonical: string;
  sport: string;
  league: string;
  aliasForms: string[];
  /** Must be disjoint across the group: a title matching two clubs' rx is skipped as ambiguous. */
  titleRx: string[];
}
export interface NamesakeGroup {
  stem: string;
  clubs: NamesakeClub[];
}

export const NAMESAKE_CLUB_GROUPS: readonly NamesakeGroup[] = [
  {
    stem: 'Botafogo',
    clubs: [
      // Legitimately owns the bare alias; repoint-source only, no new alias pinned.
      {
        canonical: 'Botafogo FR', sport: 'soccer', league: 'Serie A',
        aliasForms: [],
        titleRx: ['\\mbotafogo[ /-]?fr\\M'],
      },
      {
        canonical: 'Botafogo-SP', sport: 'soccer', league: 'brazilian série b',
        aliasForms: ['Botafogo FC'],
        titleRx: ['\\mbotafogo[ /-]?fc\\M', '\\mbotafogo[ /-]?sp\\M', 'botafogo de ribeir'],
      },
    ],
  },
];

/** Title-rx fragments of every club in `group` except `exceptCanonical`. */
export function namesakeSiblingTitleRx(group: NamesakeGroup, exceptCanonical: string): string[] {
  const ex = exceptCanonical.toLowerCase();
  return group.clubs.filter((c) => c.canonical.toLowerCase() !== ex).flatMap((c) => c.titleRx);
}

/** Idempotent; mirrors {@link seedSameCityTeamCodes}'s pin/strip/repoint structure. */
export async function seedNamesakeClubCodes(): Promise<{
  clubsUpdated: number;
  aliasesAdded: number;
  poisonRemoved: number;
  normsRepointed: number;
}> {
  let clubsUpdated = 0;
  let aliasesAdded = 0;
  let poisonRemoved = 0;
  let normsRepointed = 0;

  const ownerByCanonicalFold = new Map<string, number>();

  // (a) pin each club's distinctive forms as exact aliases on the scope-matched row.
  for (const group of NAMESAKE_CLUB_GROUPS) {
    for (const club of group.clubs) {
      const rows = await query<{ id: number; aliases: string[] }>(
        `SELECT id, aliases FROM known_entities
         WHERE type = 'team'
           AND lower(immutable_unaccent(canonical)) = lower(immutable_unaccent($1))
           AND (sport_canonical IS NULL OR sport_canonical = $2)
           AND (league_canonical IS NULL OR league_canonical = $3)
         ORDER BY
           CASE WHEN sport_canonical = $2 AND league_canonical = $3 THEN 0
                WHEN sport_canonical = $2 THEN 1 ELSE 2 END,
           id ASC
         LIMIT 1`,
        [club.canonical, club.sport, club.league],
      );
      if (rows.length === 0) {
        log.info(`[namesake-codes] club "${club.canonical}" (${club.sport}/${club.league}) not present yet — deferring`);
        continue;
      }
      const id = rows[0].id;
      ownerByCanonicalFold.set(club.canonical.toLowerCase(), id);
      const existing: string[] = Array.isArray(rows[0].aliases)
        ? rows[0].aliases
        : JSON.parse((rows[0].aliases as unknown as string) || '[]');
      const existingFolds = new Set(existing.map((a) => a.toLowerCase()));
      const toAdd = club.aliasForms.filter((a) => !existingFolds.has(a.toLowerCase()));
      if (toAdd.length > 0) {
        await query(
          `UPDATE known_entities
           SET aliases = (
                 SELECT jsonb_agg(DISTINCT alias ORDER BY alias)
                 FROM (
                   SELECT jsonb_array_elements_text(aliases) AS alias
                   UNION
                   SELECT unnest($2::text[])
                 ) sub
               ),
               updated_at = NOW()
           WHERE id = $1`,
          [id, toAdd],
        );
        aliasesAdded += toAdd.length;
      }
      await mergeAliasVariants(id);
      clubsUpdated++;
    }
  }

  // (b) strip each pinned form (+ despace variant) from any non-owner team row.
  for (const group of NAMESAKE_CLUB_GROUPS) {
    for (const club of group.clubs) {
      const owner = ownerByCanonicalFold.get(club.canonical.toLowerCase()) ?? null;
      for (const form of club.aliasForms) {
        const despace = form.replace(/\s+/g, '').toLowerCase();
        const removed = await query<{ id: number }>(
          `UPDATE known_entities
           SET aliases = COALESCE((
                 SELECT jsonb_agg(alias)
                 FROM jsonb_array_elements_text(aliases) AS alias
                 WHERE lower(immutable_unaccent(alias)) <> lower(immutable_unaccent($2))
                   AND lower(immutable_unaccent(alias)) <> lower(immutable_unaccent($3))
               ), '[]'::jsonb),
               updated_at = NOW()
           WHERE type = 'team'
             AND ($1::int IS NULL OR id <> $1)
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(aliases) AS a
               WHERE lower(immutable_unaccent(a)) = lower(immutable_unaccent($2))
                  OR lower(immutable_unaccent(a)) = lower(immutable_unaccent($3))
             )
           RETURNING id`,
          [owner, form, despace],
        );
        if (removed.length > 0) {
          poisonRemoved += removed.length;
          log.info(`[namesake-codes] removed poison alias "${form}" from ${removed.length} non-owner team row(s)`);
        }
      }
    }
  }

  // (c) repoint norms naming club C to a sibling's canonical, substring-replacing it with C's.
  // llm_market_normalizations has no updated_at column; do not add one here.
  for (const group of NAMESAKE_CLUB_GROUPS) {
    for (const club of group.clubs) {
      if (!ownerByCanonicalFold.has(club.canonical.toLowerCase())) continue;
      const siblingRx = namesakeSiblingTitleRx(group, club.canonical);
      const siblings = group.clubs.filter(
        (s) => s.canonical.toLowerCase() !== club.canonical.toLowerCase(),
      );
      for (const sib of siblings) {
        const res = await query<{ id: number }>(
          `UPDATE llm_market_normalizations n
              SET canonical_subject = replace(n.canonical_subject, $1, $2),
                  canonical_event   = CASE WHEN n.canonical_event IS NULL THEN NULL
                                           ELSE replace(n.canonical_event, $1, $2) END
             FROM markets m
            WHERE n.market_id = m.id
              AND (m.title ~* ANY($3::text[]))
              AND NOT (m.title ~* ANY($4::text[]))
              AND (n.canonical_subject ILIKE '%' || $1 || '%'
                   OR n.canonical_event ILIKE '%' || $1 || '%')
            RETURNING n.market_id AS id`,
          [sib.canonical, club.canonical, club.titleRx, siblingRx],
        );
        if (res.length > 0) {
          normsRepointed += res.length;
          log.info(`[namesake-codes] repointed ${res.length} stale norm(s) "${sib.canonical}" → "${club.canonical}" (title names the namesake sibling)`);
        }
      }
    }
  }

  return { clubsUpdated, aliasesAdded, poisonRemoved, normsRepointed };
}

export interface BareAliasSweepResult {
  rowsUpdated: number;
  unscopedRemoved: number;
  crossClaimedRemoved: number;
  misScopedFlagged: number;
}

/** Drops bare aliases the write gate (db/entity/register.ts) would now refuse: those on
 *  an unscoped team, or claimed by another entity too. Idempotent. */
export interface BareAliasSweepRow {
  id: number;
  canonical: string;
  type: string;
  league_canonical: string | null;
  aliases: string[] | string;
}

/** One planned rewrite: the row keeps `kept` and loses `dropped`. */
export interface BareAliasSweepPlan {
  id: number;
  canonical: string;
  league_canonical: string | null;
  kept: string[];
  dropped: string[];
  unscopedDropped: number;
  crossClaimedDropped: number;
}

/** Pure core of {@link sweepBareAliasScope}, kept DB-free: a module-level `@arb/db`
 *  mock leaks across the whole `bun test` process and breaks other suites. */
export function planBareAliasSweep(
  rows: readonly BareAliasSweepRow[],
  multiClaimedFolds: ReadonlySet<string>,
): BareAliasSweepPlan[] {
  const plans: BareAliasSweepPlan[] = [];
  for (const row of rows) {
    if (!BARE_ALIAS_SCOPED_TYPES.has(row.type)) continue;
    const aliases: string[] = Array.isArray(row.aliases) ? row.aliases : JSON.parse(row.aliases || '[]');
    if (aliases.length === 0) continue;
    const { bare } = classifyBareAliases(row.canonical, aliases);
    if (bare.length === 0) continue;
    const unscoped = row.league_canonical == null || row.league_canonical === '';

    const drop = new Set<string>();
    let unscopedDropped = 0;
    let crossClaimedDropped = 0;
    for (const a of bare) {
      if (unscoped) {
        drop.add(a);
        unscopedDropped++;
      } else if (multiClaimedFolds.has(a.toLowerCase())) {
        drop.add(a);
        crossClaimedDropped++;
      }
    }
    if (drop.size === 0) continue;
    plans.push({
      id: row.id,
      canonical: row.canonical,
      league_canonical: row.league_canonical,
      kept: aliases.filter((a) => !drop.has(a)),
      dropped: [...drop],
      unscopedDropped,
      crossClaimedDropped,
    });
  }
  return plans;
}

export async function sweepBareAliasScope(): Promise<BareAliasSweepResult> {
  const out: BareAliasSweepResult = {
    rowsUpdated: 0, unscopedRemoved: 0, crossClaimedRemoved: 0, misScopedFlagged: 0,
  };

  const rows = await query<BareAliasSweepRow>(
    `SELECT id, canonical, type, league_canonical, aliases
       FROM known_entities
      WHERE type = ANY($1::text[])
        AND jsonb_array_length(aliases) > 0`,
    [[...BARE_ALIAS_SCOPED_TYPES]],
  );
  if (rows.length === 0) return out;

  // Fold -> count of distinct entities carrying it; arm-2 test is `claims > 1`.
  const claimRows = await query<{ form: string; n: number }>(
    `SELECT form, count(DISTINCT id)::int AS n FROM (
       SELECT id, lower(a) AS form FROM known_entities, LATERAL jsonb_array_elements_text(aliases) AS a
       UNION ALL
       SELECT id, lower(canonical) FROM known_entities
     ) f
     GROUP BY form HAVING count(DISTINCT id) > 1`,
  );
  const multiClaimed = new Set(claimRows.map((r) => r.form));

  for (const plan of planBareAliasSweep(rows, multiClaimed)) {
    await query(
      `UPDATE known_entities SET aliases = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(plan.kept), plan.id],
    );
    out.rowsUpdated++;
    out.unscopedRemoved += plan.unscopedDropped;
    out.crossClaimedRemoved += plan.crossClaimedDropped;
    log.info(
      `[bare-alias-sweep] entity ${plan.id} "${plan.canonical}" ` +
      `(league=${plan.league_canonical ?? 'NULL'}): dropped [${plan.dropped.join(', ')}]`,
    );
  }

  // FLAG-ONLY: rows whose sport and league disagree (never auto-corrected).
  const misScoped = await query<{ id: number; canonical: string; sport_canonical: string; league_canonical: string }>(
    `SELECT e.id, e.canonical, e.sport_canonical, e.league_canonical
       FROM known_entities e
       JOIN known_entities l
         ON lower(l.canonical) = lower(e.league_canonical)
        AND l.type IN ('league','competition')
      WHERE e.type = 'team'
        AND e.sport_canonical IS NOT NULL
        AND l.sport_canonical IS NOT NULL
        AND lower(e.sport_canonical) <> lower(l.sport_canonical)`,
  );
  out.misScopedFlagged = misScoped.length;
  for (const m of misScoped.slice(0, 25)) {
    log.warn(
      `[bare-alias-sweep] MIS-SCOPED (flag only, not fixed): entity ${m.id} "${m.canonical}" ` +
      `sport=${m.sport_canonical} but league="${m.league_canonical}" is a different sport.`,
    );
  }

  return out;
}

interface SeedResult {
  entitiesUpserted: number;
  relationsWritten: number;
  relationsSkipped: number;
}

/** Idempotent — safe to call on every run. */
export async function seedStructuralEntities(): Promise<SeedResult> {
  const allSeeds: EntitySeed[] = [...SPORTS, ...LEAGUES, ...COMPETITIONS, ...PROVIDERS];
  const idMap = new Map<string, number>();

  let entitiesUpserted = 0;
  for (const seed of allSeeds) {
    const id = await upsertEntity(seed);
    await mergeAliasVariants(id);
    idMap.set(seed.canonical, id);
    entitiesUpserted++;
  }

  let relationsWritten = 0;
  let relationsSkipped = 0;
  for (const rel of RELATIONS) {
    const parentId = idMap.get(rel.parentCanonical);
    const childId  = idMap.get(rel.childCanonical);
    if (parentId == null || childId == null) {
      relationsSkipped++;
      continue;
    }
    await upsertRelation(parentId, childId, rel.relation);
    relationsWritten++;
  }

  return { entitiesUpserted, relationsWritten, relationsSkipped };
}

interface TeamSeedResult {
  resolved: number;
  alreadySet: number;
  unresolved: number;
}

/** Idempotent. */
export async function seedTeamLeagues(): Promise<TeamSeedResult> {
  const teams = await query<{
    id: number;
    canonical: string;
    aliases: string[];
    metadata: Record<string, unknown>;
    league_canonical: string | null;
    sport_canonical: string | null;
  }>(
    `SELECT id, canonical, aliases, metadata, league_canonical, sport_canonical
     FROM known_entities WHERE type = 'team' ORDER BY canonical`,
  );

  const leagueRows = await query<{ id: number; canonical: string }>(
    `SELECT id, canonical FROM known_entities WHERE type IN ('league', 'competition')`,
  );
  const leagueIdMap = new Map(leagueRows.map(r => [r.canonical, r.id]));

  let resolved = 0;
  let alreadySet = 0;
  let unresolved = 0;

  for (const team of teams) {
    if (team.league_canonical && team.sport_canonical) { alreadySet++; continue; }

    const canonicalLower = team.canonical.toLowerCase();
    let hit = TEAM_MAP[canonicalLower];

    if (!hit && Array.isArray(team.aliases)) {
      for (const alias of team.aliases) {
        const aliasLower = (alias as string).toLowerCase();
        if (TEAM_MAP[aliasLower]) { hit = TEAM_MAP[aliasLower]; break; }
      }
    }

    if (!hit) { unresolved++; continue; }

    const newMeta = {
      ...(team.metadata ?? {}),
      kind: 'team',
      league_canonical: hit.league,
      sport_canonical: hit.sport,
      ...(hit.country ? { country: hit.country } : {}),
    };
    // Bumps updated_at only when league/sport were missing, so it never re-bumps.
    await query(
      `UPDATE known_entities SET metadata = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(newMeta), team.id],
    );

    const leagueId = leagueIdMap.get(hit.league);
    if (leagueId != null) {
      await upsertRelation(team.id, leagueId, 'competes_in');
    }
    resolved++;
  }

  return { resolved, alreadySet, unresolved };
}

/** Structural/team seeding runs only below STRUCTURAL_THRESHOLD rows; every other
 *  step always runs (idempotent). */
export async function seedEntityKB(): Promise<{ seeded: boolean; structural: SeedResult; teams: TeamSeedResult; assetsUpserted: number; politicsUpserted: number; confederations: { orgsUpserted: number; teamsStamped: number }; sameCityCodes: { teamsUpdated: number; codesAdded: number; poisonRemoved: number; normsRepointed: number }; namesakeCodes: { clubsUpdated: number; aliasesAdded: number; poisonRemoved: number; normsRepointed: number }; leagueDedup: LeagueDedupSummary; bareAliasSweep: BareAliasSweepResult }> {
  const assetsUpserted = await seedCryptoAssets();
  const politicsUpserted = await seedPoliticsOverrides();
  const confederations = await seedConfederations();
  const sameCityCodes = await seedSameCityTeamCodes();
  const namesakeCodes = await seedNamesakeClubCodes();
  if (namesakeCodes.aliasesAdded > 0 || namesakeCodes.poisonRemoved > 0 || namesakeCodes.normsRepointed > 0) {
    log.info(
      `Namesake codes: ${namesakeCodes.clubsUpdated} clubs, ${namesakeCodes.aliasesAdded} aliases, ` +
      `${namesakeCodes.poisonRemoved} poison removed, ${namesakeCodes.normsRepointed} norms repointed.`,
    );
  }

  const [structuralCount] = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM known_entities
     WHERE type IN ('sport', 'league', 'competition', 'data_provider')`,
  );
  const existingCount = parseInt(structuralCount.cnt, 10);

  const STRUCTURAL_THRESHOLD = 50;
  const doStructural = existingCount < STRUCTURAL_THRESHOLD;

  let structural: SeedResult = { entitiesUpserted: 0, relationsWritten: 0, relationsSkipped: 0 };
  let teams: TeamSeedResult = { resolved: 0, alreadySet: 0, unresolved: 0 };
  if (doStructural) {
    log.info(`KB has ${existingCount} structural entities (< ${STRUCTURAL_THRESHOLD}) — seeding...`);
    structural = await seedStructuralEntities();
    log.info(`Structural: ${structural.entitiesUpserted} upserted, ${structural.relationsWritten} relations`);

    teams = await seedTeamLeagues();
    log.info(`Teams: ${teams.resolved} resolved, ${teams.alreadySet} already set, ${teams.unresolved} unresolved`);
  }

  // Folds only sport/country-compatible exact-fold collisions, so a shared acronym
  // across two real leagues stays separate.
  const leagueDedup = await seedLeagueDedup();
  if (leagueDedup.rowsFolded > 0 || leagueDedup.aliasesReasserted > 0) {
    log.info(
      `League dedup: ${leagueDedup.rowsFolded} dup rows folded ` +
      `(${leagueDedup.rowsFoldedLinks} links moved), ` +
      `${leagueDedup.aliasesReasserted} curated aliases re-asserted, ` +
      `${leagueDedup.rowsLeftSeparate} collisions left separate.`,
    );
  }

  // Runs last, after every seed/dedup path has written its curated aliases.
  const bareAliasSweep = await sweepBareAliasScope();
  if (bareAliasSweep.rowsUpdated > 0 || bareAliasSweep.misScopedFlagged > 0) {
    log.info(
      `Bare-alias sweep: ${bareAliasSweep.rowsUpdated} team row(s) rewritten — ` +
      `${bareAliasSweep.unscopedRemoved} unscoped-owner + ${bareAliasSweep.crossClaimedRemoved} ` +
      `cross-claimed alias(es) dropped; ${bareAliasSweep.misScopedFlagged} mis-scoped row(s) flagged.`,
    );
  }

  return { seeded: doStructural, structural, teams, assetsUpserted, politicsUpserted, confederations, sameCityCodes, namesakeCodes, leagueDedup, bareAliasSweep };
}
