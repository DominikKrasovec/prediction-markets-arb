/**
 * Kalshi series registries + pure title/strike matchers (DB-free, unit-testable).
 * Exhaustivity is decided downstream from the emitted fields, never by a registry row.
 */
import type { ConditionMetric, EventKind, MetricScope } from "@arb/types";
export type LadderSubjectGrain = "titleTeam" | "yesSubTitlePerson" | "titleSubject" | "titleGamesSpread";
export type LadderValueSource = "floor" | "cap" | "typed-auto";

export interface LadderSeriesSpec {
  archetype: "threshold_ladder";
  subjectGrain: LadderSubjectGrain;
  subjectType: "team" | "person" | "event_name";
  valueSource: LadderValueSource;
  unit: string;
  metric: ConditionMetric;
  eventKind: EventKind;
  category: "sports" | "entertainment";
  sport: string | null;
  league: string | null;
  requireStrikeType: string | null;
}

const SPREAD_SOCCER: ReadonlyArray<string> = [
  "KXMLSSPREAD", "KXEPLSPREAD", "KXLALIGASPREAD", "KXLIGUE1SPREAD", "KXBRASILEIROSPREAD",
  "KXSERIEASPREAD", "KXCOPADOBRASILSPREAD", "KXSAUDIPLSPREAD", "KXBUNDESLIGASPREAD",
  "KXEREDIVISIESPREAD", "KXLIGAMXSPREAD", "KXALEAGUESPREAD", "KXEFLCHAMPIONSHIPSPREAD",
  "KXARGPREMDIVSPREAD", "KXUCLSPREAD", "KXUELSPREAD", "KXFACUPSPREAD",
  "KXWCSPREAD", "KXWC1HSPREAD", "KXWC2HSPREAD",
  "KXCLUBFSPREAD", "KXUECLSPREAD",
];
const SPREAD_BASKETBALL: ReadonlyArray<string> = ["KXNBASPREAD", "KXWNBASPREAD"];
const SPREAD_WNBA_PERIOD: ReadonlyArray<string> = [
  "KXWNBA1QSPREAD", "KXWNBA2QSPREAD", "KXWNBA3QSPREAD", "KXWNBA4QSPREAD",
  "KXWNBA1HSPREAD", "KXWNBA2HSPREAD",
];
const SPREAD_HOCKEY: ReadonlyArray<string> = ["KXNHLSPREAD"];
const SPREAD_BASEBALL: ReadonlyArray<string> = ["KXKBOSPREAD"];
const SPREAD_AMFOOTBALL: ReadonlyArray<string> = ["KXUFLSPREAD"];
const SPREAD_CFL: ReadonlyArray<string> = ["KXCFLSPREAD"];

const SPREAD_LEAGUE_HINT: Record<string, { sport: string; league: string | null; unit: string }> = {};
for (const p of SPREAD_SOCCER) SPREAD_LEAGUE_HINT[p] = { sport: "soccer", league: null, unit: "goals" };
for (const p of SPREAD_BASKETBALL) SPREAD_LEAGUE_HINT[p] = { sport: "basketball", league: p === "KXNBASPREAD" ? "NBA" : "WNBA", unit: "points" };
for (const p of SPREAD_WNBA_PERIOD) SPREAD_LEAGUE_HINT[p] = { sport: "basketball", league: "WNBA", unit: "points" };
for (const p of SPREAD_HOCKEY) SPREAD_LEAGUE_HINT[p] = { sport: "ice hockey", league: "NHL", unit: "goals" };
for (const p of SPREAD_BASEBALL) SPREAD_LEAGUE_HINT[p] = { sport: "baseball", league: "KBO", unit: "runs" };
for (const p of SPREAD_AMFOOTBALL) SPREAD_LEAGUE_HINT[p] = { sport: "american football", league: "UFL", unit: "points" };
for (const p of SPREAD_CFL) SPREAD_LEAGUE_HINT[p] = { sport: "american football", league: "CFL", unit: "points" };

export const LADDER_SERIES: Record<string, LadderSeriesSpec> = {};
for (const [prefix, h] of Object.entries(SPREAD_LEAGUE_HINT)) {
  LADDER_SERIES[prefix] = {
    archetype: "threshold_ladder", subjectGrain: "titleTeam", subjectType: "team",
    valueSource: "floor", unit: h.unit, metric: "score", eventKind: "match_spread",
    category: "sports", sport: h.sport, league: h.league, requireStrikeType: "greater",
  };
}

LADDER_SERIES["KXNBASUMMERSPREAD"] = {
  archetype: "threshold_ladder", subjectGrain: "titleTeam", subjectType: "team",
  valueSource: "floor", unit: "points", metric: "score", eventKind: "match_spread",
  category: "sports", sport: "basketball", league: null, requireStrikeType: "greater",
};

LADDER_SERIES["KXATPGSPREAD"] = {
  archetype: "threshold_ladder", subjectGrain: "titleGamesSpread", subjectType: "person",
  valueSource: "floor", unit: "games", metric: "score", eventKind: "match_spread",
  category: "sports", sport: "tennis", league: null, requireStrikeType: "greater",
};

LADDER_SERIES["KXPGAROUNDSCORE"] = {
  archetype: "threshold_ladder", subjectGrain: "yesSubTitlePerson", subjectType: "person",
  valueSource: "typed-auto", unit: "strokes", metric: "score", eventKind: "player_prop_threshold",
  category: "sports", sport: "golf", league: null, requireStrikeType: null,
};

const MUSIC_UNITS: ReadonlyArray<string> = [
  "KXARTISTSTREAMS", "KXALBUMEQUIV", "KXALBUMSALES", "KXPUREALBUMS", "KXALBUMSTREAMSU",
];
for (const p of MUSIC_UNITS) {
  LADDER_SERIES[p] = {
    archetype: "threshold_ladder", subjectGrain: "titleSubject", subjectType: "event_name",
    valueSource: "floor", unit: "units", metric: "count", eventKind: "media_release",
    category: "entertainment", sport: null, league: null, requireStrikeType: null,
  };
}

LADDER_SERIES["KXRT"] = {
  archetype: "threshold_ladder", subjectGrain: "titleSubject", subjectType: "event_name",
  valueSource: "floor", unit: "score", metric: "score", eventKind: "media_release",
  category: "entertainment", sport: null, league: null, requireStrikeType: "greater",
};

export function lookupLadderSeries(eventTicker: string | null): { prefix: string; spec: LadderSeriesSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = LADDER_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}

const SPREAD_TITLE_RX = /^(?<team>.+?)\s+wins\s+(?:(?:1st|2nd|3rd|4th|first|second|third|fourth)\s+quarter\s+|(?:1st|2nd|first|second)\s+half\s+)?by\s+(?:over|more\s+than)\s+(?<value>\d+(?:\.\d+)?)\s+(?:goals?|points?|runs?)(?:\s+in\s+the\s+(?:1st|2nd|first|second)\s+half)?\??$/i;

export function parseSpreadTitle(title: string): { team: string; value: number } | null {
  const m = title.match(SPREAD_TITLE_RX);
  if (!m?.groups) return null;
  const team = m.groups.team.trim();
  const value = parseFloat(m.groups.value);
  if (!team || Number.isNaN(value)) return null;
  return { team, value };
}

const SPREAD_YST_TEAM_RX =
  /^(?<team>.+?)\s+wins\s+(?:the\s+)?[1-4][QH]\s+by\s+(?:over|more\s+than)\s+(?<value>\d+(?:\.\d+)?)\s+(?:goals?|points?|runs?)\s*$/i;

export function parseSpreadYstTeam(yst: string | null | undefined): { team: string; value: number } | null {
  if (!yst) return null;
  const m = yst.match(SPREAD_YST_TEAM_RX);
  if (!m?.groups) return null;
  const team = m.groups.team.trim();
  const value = parseFloat(m.groups.value);
  if (!team || Number.isNaN(value)) return null;
  return { team, value };
}

const SPREAD_RULES_FIXTURE_RX =
  /\b([A-Z][\w.\x27&\-]*(?:\s+[\w.\x27&\-]+){0,3}?)\s+(?:vs\.?|at)\s+([A-Z][\w.\x27&\-]*(?:\s+[\w.\x27&\-]+){0,3}?)\s+(?:professional|Pro\s+Basketball|in\s+the)\b/;

// Strips only anchored trailing gender qualifiers so a real team name is never truncated.
function stripFixtureLeagueQualifier(name: string): string {
  return name
    .replace(/\s+(?:men'?s|women'?s)\s+professional\s+basketball\s*$/i, "")
    .replace(/\s+professional\s+basketball\s*$/i, "")
    .replace(/\s+(?:men'?s|women'?s)\s*$/i, "")
    .trim();
}

export function extractSpreadFixture(
  row: { title: string; rules_primary: string | null; yes_sub_title?: string | null },
): { team: string; value: number; opponent: string | null } | null {
  const parsed = parseSpreadTitle(row.title) ?? parseSpreadYstTeam(row.yes_sub_title ?? null);
  if (!parsed) return null;
  let opponent: string | null = null;
  const rm = (row.rules_primary ?? "").match(SPREAD_RULES_FIXTURE_RX);
  if (rm) {
    const a = stripFixtureLeagueQualifier(rm[1].trim());
    const b = stripFixtureLeagueQualifier(rm[2].trim());
    const teamLc = parsed.team.toLowerCase();
    const aLc = a.toLowerCase();
    const bLc = b.toLowerCase();
    if (aLc === teamLc || aLc.includes(teamLc) || teamLc.includes(aLc)) opponent = b;
    else if (bLc === teamLc || bLc.includes(teamLc) || teamLc.includes(bLc)) opponent = a;
    else opponent = b;
  }
  return { team: parsed.team, value: parsed.value, opponent };
}

const TENNIS_GAMES_SPREAD_TITLE_RX =
  /^Will\s+(?<player>.+?)\s+win\s+at\s+least\s+(?<value>\d+(?:\.\d+)?)\s+more\s+games?\s+than\s+(?<opponent>.+?)\s*\??$/i;

export function parseTennisGamesSpread(
  title: string,
): { player: string; value: number; opponent: string } | null {
  const m = title.match(TENNIS_GAMES_SPREAD_TITLE_RX);
  if (!m?.groups) return null;
  const player = m.groups.player.trim();
  const opponent = m.groups.opponent.trim();
  const value = parseFloat(m.groups.value);
  if (!player || !opponent || Number.isNaN(value)) return null;
  return { player, value, opponent };
}

const GOLF_ROUND_TITLE_RX = /^Will\s+(?<player>.+?)\s+shoot\s+(?:under|over)\s+(?<value>\d+(?:\.\d+)?)\s+in\s+Round\s+(?<round>\d+)\??$/i;
const GOLF_ROUND_YST_RX = /^R(?<round>\d+):\s*(?<player>.+?)\s+(?:under|over)\s+(?<value>\d+(?:\.\d+)?)\s+strokes?$/i;

export function parseGolfRoundScore(
  row: { title: string; yes_sub_title: string | null },
): { player: string; round: number } | null {
  const y = (row.yes_sub_title ?? "").match(GOLF_ROUND_YST_RX);
  if (y?.groups) {
    const round = parseInt(y.groups.round, 10);
    const player = y.groups.player.trim();
    if (player && Number.isInteger(round)) return { player, round };
  }
  const m = row.title.match(GOLF_ROUND_TITLE_RX);
  if (m?.groups) {
    const round = parseInt(m.groups.round, 10);
    const player = m.groups.player.trim();
    if (player && Number.isInteger(round)) return { player, round };
  }
  return null;
}

const MUSIC_TITLE_RX = /^Will\s+(?<subject>.+?)\s+have\s+(?:at\s+least\s+|above\s+)?[\d,]+/i;

export function extractMusicUnitsSubject(title: string): string | null {
  const m = title.match(MUSIC_TITLE_RX);
  const s = m?.groups?.subject?.trim();
  return s && s.length > 0 ? s : null;
}

const RT_TITLE_RX = /^(?<movie>.+?)\s+Rotten\s+Tomatoes\s+score\??$/i;

export function extractRottenTomatoesSubject(title: string): string | null {
  const m = title.match(RT_TITLE_RX);
  const s = m?.groups?.movie?.trim();
  return s && s.length > 0 ? s : null;
}

export function isExactRottenTomatoesSeries(eventTicker: string | null): boolean {
  if (!eventTicker) return false;
  return eventTicker.split("-")[0] === "KXRT";
}

export interface WinnerSeriesSpec {
  archetype: "categorical_winner";
  subjectGrain: "yesSubTitle";
  subjectType: "team" | "person" | "event_name";
  eventKind: EventKind;
  metricScope: "half_1" | null;
  residualRX: RegExp | null;
  sport: string;
  league: string | null;
  eventFrom: "fixture" | "titleEvent" | "eventTitle";
  subjectCategory?: "sports" | "entertainment";
}

const SOCCER_1H: ReadonlyArray<string> = ["KXEPL1H", "KXLALIGA1H", "KXLIGUE11H", "KXSERIEA1H", "KXBUNDESLIGA1H", "KXUCL1H", "KXUEL1H"];
export const WINNER_SERIES: Record<string, WinnerSeriesSpec> = {};
for (const p of SOCCER_1H) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "team",
    eventKind: "halftime_leader", metricScope: "half_1", residualRX: /^tie$|^draw$/i,
    sport: "soccer", league: null, eventFrom: "fixture",
  };
}
const MOTORSPORT: ReadonlyArray<string> = [
  "KXNASCARRACE", "KXNASCARCUPSERIES", "KXNASCARTRUCKSERIES", "KXNASCARAUTOPARTSSERIES", "KXCYCLING",
];
for (const p of MOTORSPORT) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
    eventKind: "championship_winner", metricScope: null, residualRX: null,
    sport: "motorsport", league: null, eventFrom: "titleEvent",
  };
}

WINNER_SERIES["KXKFTOUR"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "championship_winner", metricScope: null, residualRX: null,
  sport: "golf", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};
WINNER_SERIES["KXPGAPLAYERCAT"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "championship_winner", metricScope: null, residualRX: null,
  sport: "golf", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};
WINNER_SERIES["KXNASCARFASTLAP"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "championship_winner", metricScope: null, residualRX: null,
  sport: "motorsport", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};
const AWARD_RESIDUAL_RX = /^(?:tie|co-?winners?|tie\s*\/\s*co-?winners?|no\s+winner|none)$/i;
WINNER_SERIES["KXWCAWARD"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
  sport: "soccer", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};
WINNER_SERIES["KXTONYAWARDS"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "event_name",
  eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
  sport: "", league: null, eventFrom: "eventTitle", subjectCategory: "entertainment",
};

const MLB_AWARD_SERIES: ReadonlyArray<string> = [
  "KXMLBNLMVP", "KXMLBALMVP", "KXMLBNLMOTY", "KXMLBALMOTY", "KXMLBNLCPOTY", "KXMLBALCPOTY",
  "KXMLBNLCY", "KXMLBALCY", "KXMLBNLROTY", "KXMLBALROTY", "KXMLBEOTY",
];
for (const p of MLB_AWARD_SERIES) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
    eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
    sport: "baseball", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
const WNBA_AWARD_SERIES: ReadonlyArray<string> = ["KXWNBAMVP", "KXWNBACOY", "KXWNBA6POY"];
for (const p of WNBA_AWARD_SERIES) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
    eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
    sport: "basketball", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
WINNER_SERIES["KXSEXYMAN"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
  sport: "", league: null, eventFrom: "eventTitle", subjectCategory: "entertainment",
};
const SOCCER_CHAMP_SERIES: ReadonlyArray<string> = [
  "KXPERLIGA1", "KXDENSUPERLIGA", "KXLIGAMX", "KXLALIGA",
];
for (const p of SOCCER_CHAMP_SERIES) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "team",
    eventKind: "championship_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
    sport: "soccer", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
const UFC_TITLE_SERIES: ReadonlyArray<string> = [
  "KXUFCLIGHTWEIGHTTITLE", "KXUFCWELTERWEIGHTTITLE", "KXUFCHEAVYWEIGHTTITLE",
  "KXUFCLHEAVYWEIGHTTITLE", "KXUFCBANTAMWEIGHTTITLE", "KXUFCFLYWEIGHTTITLE",
  "KXUFCFEATHERWEIGHTTITLE", "KXUFCMIDDLEWEIGHTTITLE",
];
for (const p of UFC_TITLE_SERIES) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
    eventKind: "championship_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
    sport: "mma", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
WINNER_SERIES["KXWCGROUPWIN"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "team",
  eventKind: "championship_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
  sport: "soccer", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};

const CYCLING_STAGE_JERSEY: ReadonlyArray<string> = ["KXCYCLINGSTAGE", "KXCYCLINGJERSEY"];
for (const p of CYCLING_STAGE_JERSEY) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
    eventKind: "championship_winner", metricScope: null, residualRX: null,
    sport: "cycling", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
const LPGA_ROUND_LEAD: ReadonlyArray<string> = ["KXLPGAR2LEAD", "KXLPGAR3LEAD"];
for (const p of LPGA_ROUND_LEAD) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
    eventKind: "championship_winner", metricScope: null, residualRX: null,
    sport: "golf", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
const MLB_TROPHY_SERIES: ReadonlyArray<string> = ["KXMLBGG", "KXMLBSS"];
for (const p of MLB_TROPHY_SERIES) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "event_name",
    eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
    sport: "baseball", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
const NCAA_BB_APRANK: ReadonlyArray<string> = ["KXNCAAWBAPRANK", "KXNCAAMBAPRANK"];
for (const p of NCAA_BB_APRANK) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "team",
    eventKind: "championship_winner", metricScope: null, residualRX: null,
    sport: "basketball (ncaa)", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
WINNER_SERIES["KXNCAAFAPRANK"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "team",
  eventKind: "championship_winner", metricScope: null, residualRX: null,
  sport: "american football (ncaa)", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};
WINNER_SERIES["KXNFLT100"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "award_winner", metricScope: null, residualRX: null,
  sport: "american football", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};
WINNER_SERIES["KXSTARTINGQBWEEK1"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "other", metricScope: null, residualRX: null,
  sport: "american football", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};
const LOVE_ISLAND_COUPLE: ReadonlyArray<string> = ["KXLIUKCOUPLE", "KXLIUSACOUPLE"];
for (const p of LOVE_ISLAND_COUPLE) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "event_name",
    eventKind: "championship_winner", metricScope: null, residualRX: null,
    sport: "", league: null, eventFrom: "eventTitle", subjectCategory: "entertainment",
  };
}

WINNER_SERIES["KXMUSICREPORT"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "event_name",
  eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
  sport: "", league: null, eventFrom: "eventTitle", subjectCategory: "entertainment",
};

// KXNBAMVP and KXESPYS/KXSPORTSEMMY are claimed by other handlers; do not add them here.
const NFL_AWARD_SERIES: ReadonlyArray<string> = [
  "KXNFLMVP", "KXNFLOPOTY", "KXNFLDPOTY", "KXNFLCOTY", "KXNFLPROOTY", "KXNFLEXECOTY",
];
for (const p of NFL_AWARD_SERIES) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
    eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
    sport: "american football", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
WINNER_SERIES["KXNBADPOY"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
  sport: "basketball", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};

WINNER_SERIES["KXOSCARPIC"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "event_name",
  eventKind: "award_winner", metricScope: null, residualRX: AWARD_RESIDUAL_RX,
  sport: "", league: null, eventFrom: "eventTitle", subjectCategory: "entertainment",
};
WINNER_SERIES["KXEUROVISION"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "event_name",
  eventKind: "championship_winner", metricScope: null, residualRX: null,
  sport: "", league: null, eventFrom: "eventTitle", subjectCategory: "entertainment",
};
WINNER_SERIES["KXAMERICANIDOL"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "championship_winner", metricScope: null, residualRX: null,
  sport: "", league: null, eventFrom: "eventTitle", subjectCategory: "entertainment",
};

// KXNBARECORD / KXMLBTEAMSTAT are already shaped elsewhere; do not add them here.
const NFL_TEAM_SUPERLATIVE: ReadonlyArray<string> = [
  "KXNFLTEAMPTS", "KXNFLTEAMDPTS", "KXNFL1SEED", "KXRECORDNFLWORST",
];
for (const p of NFL_TEAM_SUPERLATIVE) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "team",
    eventKind: "championship_winner", metricScope: null, residualRX: null,
    sport: "american football", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
const MLB_TEAM_SUPERLATIVE: ReadonlyArray<string> = [
  "KXMLBWORSTRECORD", "KXMLBWSTREAK", "KXMLBLSTREAK",
];
for (const p of MLB_TEAM_SUPERLATIVE) {
  WINNER_SERIES[p] = {
    archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "team",
    eventKind: "championship_winner", metricScope: null, residualRX: null,
    sport: "baseball", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
  };
}
WINNER_SERIES["KXLEADERWNBAPTS"] = {
  archetype: "categorical_winner", subjectGrain: "yesSubTitle", subjectType: "person",
  eventKind: "championship_winner", metricScope: null, residualRX: null,
  sport: "basketball", league: null, eventFrom: "eventTitle", subjectCategory: "sports",
};

export function lookupWinnerSeries(eventTicker: string | null): { prefix: string; spec: WinnerSeriesSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = WINNER_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}

const SOCCER_1H_RULES_RX =
  /\bin\s+the\s+([A-Z][\w.\x27&\-]*(?:\s+[\w.\x27&\-]+){0,3}?)\s+vs\.?\s+([A-Z][\w.\x27&\-]*(?:\s+[\w.\x27&\-]+){0,3}?)\s+professional\b/;

export function extractSoccer1HFixture(rulesPrimary: string | null): { a: string; b: string } | null {
  const m = (rulesPrimary ?? "").match(SOCCER_1H_RULES_RX);
  if (!m) return null;
  const a = m[1].trim();
  const b = m[2].trim();
  if (!a || !b) return null;
  return { a, b };
}

const MOTORSPORT_WINNER_RX = /^Will\s+.+?\s+be\s+the\s+(?<race>.+?)\s+(?:Winner|Champion)\??$/i;
const MOTORSPORT_WIN_THE_RX = /^Will\s+.+?\s+win\s+the\s+(?<race>.+?)\??$/i;

export function extractMotorsportEvent(title: string): string | null {
  const a = title.match(MOTORSPORT_WINNER_RX);
  if (a?.groups?.race) return a.groups.race.trim();
  const b = title.match(MOTORSPORT_WIN_THE_RX);
  if (b?.groups?.race) return b.groups.race.trim();
  return null;
}

export interface DraftSeriesSpec {
  branch: "pick" | "team" | "1st";
  sport: string;
  league: string;
  slotType: "player" | "team";
}

export const DRAFT_SERIES: Record<string, DraftSeriesSpec> = {
  KXNBADRAFTPICK: { branch: "pick", sport: "basketball",        league: "NBA", slotType: "player" },
  KXMLBDRAFTPICK: { branch: "pick", sport: "baseball",          league: "MLB", slotType: "player" },
  KXNHLDRAFTPICK: { branch: "pick", sport: "ice hockey",        league: "NHL", slotType: "player" },
  KXNFLDRAFTPICK: { branch: "pick", sport: "american football", league: "NFL", slotType: "player" },
  KXNBADRAFTTEAM: { branch: "team", sport: "basketball",        league: "NBA", slotType: "team" },
  KXNFLDRAFT1ST:  { branch: "1st",  sport: "american football", league: "NFL", slotType: "team" },
  KXNBADRAFT1:    { branch: "1st",  sport: "basketball",        league: "NBA", slotType: "player" },
};

export function lookupDraftSeries(eventTicker: string | null): { prefix: string; spec: DraftSeriesSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = DRAFT_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}

export function parseDraftPickNumber(eventTicker: string | null): number | null {
  if (!eventTicker) return null;
  const parts = eventTicker.split("-");
  const suffix = parts[parts.length - 1];
  if (!suffix) return null;
  if (!/^\d+$/.test(suffix)) return null;
  const n = parseInt(suffix, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseDraftYear(eventTicker: string | null): number | null {
  if (!eventTicker) return null;
  const parts = eventTicker.split("-");
  for (const seg of [parts[1], parts[parts.length - 1]]) {
    if (seg && /^\d{1,2}$/.test(seg)) {
      const yy = parseInt(seg, 10);
      return 2000 + yy;
    }
  }
  return null;
}

export function draftCanonicalEvent(
  spec: DraftSeriesSpec,
  year: number,
  pickN: number | null,
  player: string | null,
): string {
  if (spec.branch === "pick" && pickN != null) {
    return year + " " + spec.league + " draft pick " + pickN;
  }
  if (spec.branch === "team" && player) {
    return year + " " + spec.league + " draft destination: " + player.toLowerCase();
  }
  return year + " " + spec.league + " draft 1st overall pick";
}

// Never sum=1: multiple players can win different majors in the same year.
export interface MajorGrandSlamSeriesSpec { sport: string; }
export const MAJOR_GRANDSLAM_SERIES: Record<string, MajorGrandSlamSeriesSpec> = {
  KXATPGRANDSLAM: { sport: "tennis" },
  KXWTAGRANDSLAM: { sport: "tennis" },
  KXGRANDSLAMJFONSECA: { sport: "tennis" },
};
export function lookupMajorGrandSlamSeries(eventTicker: string | null): { prefix: string; spec: MajorGrandSlamSeriesSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = MAJOR_GRANDSLAM_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}
const WIN_A_CHAMPIONSHIP_RX =
  /^Will\s+(?<player>[\p{L}][\p{L}\p{M}.'’\-]*(?:\s+[\p{L}][\p{L}\p{M}.'’\-]*)*?)\s+win\s+a\s+(?<noun>(?:tennis\s+)?grand\s+slam|(?:pga\s+tour\s+)?major)(?:\s+championship)?\s+in\s+(?<year>20\d{2})\s*\??$/iu;
function collapseCompetitionNoun(raw: string): "grand slam" | "major" | null {
  const s = raw.toLowerCase().trim();
  if (/grand\s+slam/.test(s)) return "grand slam";
  if (/major/.test(s)) return "major";
  return null;
}
export function parseWinAChampionship(title: string): { player: string; competitionNoun: "grand slam" | "major"; year: number } | null {
  const m = title.match(WIN_A_CHAMPIONSHIP_RX);
  if (!m?.groups) return null;
  const player = m.groups.player.trim();
  const noun = collapseCompetitionNoun(m.groups.noun);
  const year = parseInt(m.groups.year, 10);
  if (!player || !noun || !Number.isInteger(year)) return null;
  return { player, competitionNoun: noun, year };
}
export function majorGrandSlamCanonicalEvent(competitionNoun: "grand slam" | "major", year: number): string {
  return year + " " + competitionNoun;
}

const F5_SPREAD_TITLE_RX =
  /^(?<team>.+?)\s+wins\s+first\s+5\s+innings\s+by\s+over\s+(?<value>\d+(?:\.\d+)?)\s+runs\??$/i;
export function parseF5SpreadTitle(title: string): { team: string; value: number } | null {
  const m = title.match(F5_SPREAD_TITLE_RX);
  if (!m?.groups) return null;
  const team = m.groups.team.trim();
  const value = parseFloat(m.groups.value);
  if (!team || Number.isNaN(value)) return null;
  return { team, value };
}
export function extractF5SpreadFixture(row: { title: string; rules_primary: string | null }): { team: string; value: number; opponent: string | null } | null {
  const parsed = parseF5SpreadTitle(row.title);
  if (!parsed) return null;
  let opponent: string | null = null;
  const rm = (row.rules_primary ?? "").match(SPREAD_RULES_FIXTURE_RX);
  if (rm) {
    const a = rm[1].trim();
    const b = rm[2].trim();
    const teamLc = parsed.team.toLowerCase();
    const aLc = a.toLowerCase();
    const bLc = b.toLowerCase();
    if (aLc === teamLc || aLc.includes(teamLc) || teamLc.includes(aLc)) opponent = b;
    else if (bLc === teamLc || bLc.includes(teamLc) || teamLc.includes(bLc)) opponent = a;
    else opponent = b;
  }
  return { team: parsed.team, value: parsed.value, opponent };
}

// N+round are encoded in both the prefix and the title; both must agree.
const PGAR_TOP_PREFIX_RX = /^KXPGAR(?<round>\d+)TOP(?<n>\d+)\b/;
const PGAR_TOP_TITLE_RX =
  /^(?<tournament>[^:]+?):\s*Will\s+(?<player>[\p{L}][\p{L}\p{M}\s.'’\-]+?)\s+finish\s+top\s+(?<n>\d+)\s+in\s+Round\s+(?<round>\d+)\s*\??$/iu;
export function parseGolfRoundTopN(eventTicker: string | null, title: string): { tournament: string; player: string; n: number; round: number } | null {
  if (!eventTicker) return null;
  const pm = eventTicker.match(PGAR_TOP_PREFIX_RX);
  if (!pm?.groups) return null;
  const tm = title.match(PGAR_TOP_TITLE_RX);
  if (!tm?.groups) return null;
  const nPrefix = parseInt(pm.groups.n, 10);
  const rPrefix = parseInt(pm.groups.round, 10);
  const nTitle = parseInt(tm.groups.n, 10);
  const rTitle = parseInt(tm.groups.round, 10);
  if (!Number.isInteger(nPrefix) || !Number.isInteger(rPrefix)) return null;
  if (nPrefix !== nTitle || rPrefix !== rTitle) return null;
  const tournament = tm.groups.tournament.trim();
  const player = tm.groups.player.trim();
  if (!tournament || !player) return null;
  return { tournament, player, n: nTitle, round: rTitle };
}
export function golfRoundCanonicalEvent(year: number, tournament: string, round: number): string {
  return year + " " + tournament.toLowerCase() + " round " + round;
}

// value_unit='sets' keeps this from fusing with a goal exact-score (Stage-4 gates on value_unit).
export interface ExactSetScoreSeriesSpec { sport: string; bestOf: 3; }
export const EXACT_SET_SCORE_SERIES: Record<string, ExactSetScoreSeriesSpec> = {
  KXATPEXACTMATCH: { sport: "tennis", bestOf: 3 },
  KXWTAEXACTMATCH: { sport: "tennis", bestOf: 3 },
};
export function lookupExactSetScoreSeries(eventTicker: string | null): { prefix: string; spec: ExactSetScoreSeriesSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = EXACT_SET_SCORE_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}

const EXACT_SET_SCORE_TITLE_RX =
  /^Will\s+(?<w>.+?)\s+win\s+the\s+(?<a>.+?)\s+vs\.?\s+(?<b>.+?)\s+match\s+by\s+a\s+set\s+score\s+of\s+(?<sa>\d)\s*-\s*(?<sb>\d)\s*\??$/i;
const EXACT_SET_SCORE_YST_RX = /^(?<w>.+?)\s+wins\s+(?<sa>\d)\s*-\s*(?<sb>\d)$/i;

/** Whitespace-and-case-invariant fold for participant identity checks. */
function foldName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

export interface ExactSetScoreParse {
  winner: string;
  loser: string;
  /** Always the larger number (enforced). */
  setsWon: number;
  setsLost: number;
}

export function parseExactSetScore(
  row: { title: string; yes_sub_title: string | null },
  spec: ExactSetScoreSeriesSpec,
): ExactSetScoreParse | null {
  const m = row.title.trim().match(EXACT_SET_SCORE_TITLE_RX);
  if (!m?.groups) return null;
  const winner = m.groups.w.trim();
  const a = m.groups.a.trim();
  const b = m.groups.b.trim();
  const sa = parseInt(m.groups.sa, 10);
  const sb = parseInt(m.groups.sb, 10);
  const fw = foldName(winner);
  let loser: string;
  if (fw === foldName(a)) loser = b;
  else if (fw === foldName(b)) loser = a;
  else return null;
  // Valid completed best-of-3 line only: winner has exactly 2 sets, loser 0 or 1.
  const need = Math.ceil((spec.bestOf + 1) / 2);
  if (sa !== need || sb < 0 || sb >= need) return null;
  const yst = row.yes_sub_title?.trim();
  if (yst) {
    const y = yst.match(EXACT_SET_SCORE_YST_RX);
    if (!y?.groups) return null;
    if (foldName(y.groups.w.trim()) !== fw) return null;
    if (parseInt(y.groups.sa, 10) !== sa || parseInt(y.groups.sb, 10) !== sb) return null;
  }
  return { winner, loser, setsWon: sa, setsLost: sb };
}

// event_kind='other' keeps these off the match_winner equiv/mutex joins (which gate on equal event_kind).
export const UFC_VICTORY_ROUND_PREFIX = "KXUFCVICROUND";

const UFC_VIC_ROUND_TITLE_RX =
  /^Will\s+(?<w>.+?)\s+win\s+the\s+(?<a>.+?)\s+vs\.?\s+(?<b>.+?)\s+(?:(?:UFC|\d+)\s+)?fight\s+in\s+Round\s+(?<n>\d)\s*\??$/i;
const UFC_VIC_ROUND_YST_RX = /^(?<w>.+?)\s+to\s+win\s+in\s+Round\s+(?<n>\d)$/i;
const UFC_VIC_RESIDUAL_TITLE_RX =
  /^Will\s+either\s+competitor\s+win\s+the\s+(?<a>.+?)\s+vs\.?\s+(?<b>.+?)\s+(?:UFC\s+)?fight\s+by\s+decision\s+or\s+the\s+fight\s+results?\s+in\s+a\s+draw\s*\/\s*no\s+contest\s*\??$/i;
const UFC_VIC_RESIDUAL_YST_RX = /^Decision\s*\/\s*Draw\s*\/\s*No\s+Contest$/i;

export type UfcVictoryRoundParse =
  | { kind: "round"; winner: string; opponent: string; a: string; b: string; round: number }
  | { kind: "decision_or_draw"; a: string; b: string };

export function parseUfcVictoryRound(
  row: { title: string; yes_sub_title: string | null },
): UfcVictoryRoundParse | null {
  const title = row.title.trim();
  const yst = row.yes_sub_title?.trim();

  const r = title.match(UFC_VIC_ROUND_TITLE_RX);
  if (r?.groups) {
    const winner = r.groups.w.trim();
    const a = r.groups.a.trim();
    const b = r.groups.b.trim();
    const round = parseInt(r.groups.n, 10);
    if (!Number.isInteger(round) || round < 1 || round > 5) return null;
    const fw = foldName(winner);
    let opponent: string;
    if (fw === foldName(a)) opponent = b;
    else if (fw === foldName(b)) opponent = a;
    else return null;
    if (yst) {
      const y = yst.match(UFC_VIC_ROUND_YST_RX);
      if (!y?.groups) return null;
      if (foldName(y.groups.w.trim()) !== fw) return null;
      if (parseInt(y.groups.n, 10) !== round) return null;
    }
    return { kind: "round", winner, opponent, a, b, round };
  }

  const d = title.match(UFC_VIC_RESIDUAL_TITLE_RX);
  if (d?.groups) {
    if (yst && !UFC_VIC_RESIDUAL_YST_RX.test(yst)) return null;
    return { kind: "decision_or_draw", a: d.groups.a.trim(), b: d.groups.b.trim() };
  }
  return null;
}

// Do not manufacture exhaustivity here; sum=1 is decided downstream by finalize.isExhaustiveSet.
export interface AwardSeriesSpec {
  awardNoun: string;
  category: "entertainment";
  subjectType: "event_name";
}
export const AWARD_SERIES: Record<string, AwardSeriesSpec> = {
  KXAMA:            { awardNoun: "american music award",       category: "entertainment", subjectType: "event_name" },
  KXSPORTSEMMY:     { awardNoun: "sports emmy",                category: "entertainment", subjectType: "event_name" },
  KXGRAMMYNOMNAOTY: { awardNoun: "grammy",                     category: "entertainment", subjectType: "event_name" },
};
export function lookupAwardSeries(eventTicker: string | null): { prefix: string; spec: AwardSeriesSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = AWARD_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}

// Absent = single-winner = never refuses. Listed here with cardinality > 1 means the
// outcome-set certifier refuses to emit any mutex/one-hot over this series.
export const AWARD_MAX_WINNERS: Readonly<Record<string, number>> = {
  KXFIELDS: 4,
  KXGRAMMYNOMNAOTY: 8,
  KXGRAMMYNOMAOTY: 8,
  KXGRAMMYNOMROTY: 8,
  KXGRAMMYNOMSOTY: 8,
};
export function awardMaxWinners(eventTicker: string | null | undefined): number | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  return AWARD_MAX_WINNERS[prefix] ?? null;
}
const AWARD_TITLE_RX =
  /^(?<year>20\d{2})\s+.+?\s+for\s+(?<category>.+?)\s*\??$/i;
export function parseAwardTitle(title: string): { year: number; category: string } | null {
  const m = title.match(AWARD_TITLE_RX);
  if (!m?.groups) return null;
  const year = parseInt(m.groups.year, 10);
  const category = m.groups.category.trim();
  if (!Number.isInteger(year) || !category) return null;
  return { year, category };
}
/** Is this nominee the "Tie" outcome (a residual label, never a real subject)? */
export function isAwardTieNominee(yesSubTitle: string | null): boolean {
  return (yesSubTitle ?? "").trim().toLowerCase() === "tie";
}
export function awardCanonicalEvent(year: number, awardNoun: string, category: string): string {
  return `${year} ${awardNoun} ${category}`.toLowerCase();
}

const GOLF_ROUND_LEAD_PREFIX_RX = /^KXPGAR(?<round>\d+)LEAD\b/;
const GOLF_ROUND_LEAD_TITLE_RX =
  /^Will\s+(?<player>[\p{L}][\p{L}\p{M}\s.'’\-]+?)\s+lead\s+at\s+the\s+end\s+of\s+Round\s+(?<round>\d+)\s+in\s+the\s+(?<tournament>.+?)\s*\??$/iu;
export function parseGolfRoundLeader(
  eventTicker: string | null,
  row: { title: string; yes_sub_title: string | null },
): { player: string; round: number; tournament: string } | null {
  if (!eventTicker) return null;
  const pm = eventTicker.match(GOLF_ROUND_LEAD_PREFIX_RX);
  if (!pm?.groups) return null;
  const rPrefix = parseInt(pm.groups.round, 10);
  const tm = row.title.match(GOLF_ROUND_LEAD_TITLE_RX);
  if (!tm?.groups) return null;
  const rTitle = parseInt(tm.groups.round, 10);
  if (!Number.isInteger(rPrefix) || rPrefix !== rTitle) return null;
  // Prefer yes_sub_title for the player; when present it must fold-match the
  // title player or we bail.
  const titlePlayer = tm.groups.player.trim();
  const yst = (row.yes_sub_title ?? "").trim();
  const player = yst || titlePlayer;
  if (!player) return null;
  if (yst && titlePlayer && yst.toLowerCase().replace(/\s+/g, "") !== titlePlayer.toLowerCase().replace(/\s+/g, "")) {
    return null;
  }
  const tournament = tm.groups.tournament.trim();
  if (!tournament) return null;
  return { player, round: rTitle, tournament };
}
export function golfRoundLeaderCanonicalEvent(year: number, tournament: string, round: number): string {
  return `${year} ${tournament.toLowerCase()} round ${round} leader`;
}

export interface DraftTopNSeriesSpec {
  sport: string;
  league: string;
}
export const DRAFT_TOPN_SERIES: Record<string, DraftTopNSeriesSpec> = {
  KXNBADRAFTTOP: { sport: "basketball", league: "NBA" },
  KXMLBDRAFTTOP: { sport: "baseball",   league: "MLB" },
};
export function lookupDraftTopNSeries(eventTicker: string | null): { prefix: string; spec: DraftTopNSeriesSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = DRAFT_TOPN_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}
const DRAFT_TOPN_FIELD_TITLE_RX = /\btop\s+(?<n>\d+)\s+draft\s+picks?\s+in\s+(?<year>20\d{2})\b/i;
const DRAFT_TOPN_PLAYER_TITLE_RX =
  /^Will\s+.+?\s+be\s+a\s+(?:(?<topn>top\s+(?<tn>\d+))|(?<round>1st\s+Round))\s+draft\s+pick\s+in\s+(?<year>20\d{2})\s*\??$/i;
export type DraftTopNParse =
  | { kind: "rank_threshold"; rankN: number; year: number; player: string }
  | { kind: "first_round"; year: number; player: string };
export function parseDraftTopN(
  eventTicker: string | null,
  row: { title: string; yes_sub_title: string | null },
): DraftTopNParse | null {
  const player = (row.yes_sub_title ?? "").trim();
  if (!player) return null;
  const fm = row.title.match(DRAFT_TOPN_FIELD_TITLE_RX);
  if (fm?.groups) {
    const rankN = parseInt(fm.groups.n, 10);
    const year = parseInt(fm.groups.year, 10);
    if (!Number.isInteger(rankN) || rankN < 1 || !Number.isInteger(year)) return null;
    return { kind: "rank_threshold", rankN, year, player };
  }
  const pm = row.title.match(DRAFT_TOPN_PLAYER_TITLE_RX);
  if (pm?.groups) {
    const year = parseInt(pm.groups.year, 10);
    if (!Number.isInteger(year)) return null;
    if (pm.groups.round) return { kind: "first_round", year, player };
    const rankN = parseInt(pm.groups.tn, 10);
    if (!Number.isInteger(rankN) || rankN < 1) return null;
    return { kind: "rank_threshold", rankN, year, player };
  }
  return null;
}
export function draftTopNCanonicalEvent(year: number, league: string): string {
  return `${year} ${league.toLowerCase()} draft`;
}

const MIDTERM_VOTETURN_STATEWIDE_RX =
  /^Will the total vote count for all participants in\s+(?<state>[A-Za-z][A-Za-z .'\-]+?)\s+(?<chamber>Senate|Governor|House)\s+General\s+Election\b/i;
export function parseMidtermVoteTurnStatewide(
  title: string,
): { state: string; chamber: "senate" | "governor" | "house"; subjectRaw: string } | null {
  const m = title.match(MIDTERM_VOTETURN_STATEWIDE_RX);
  if (!m?.groups) return null;
  const state = m.groups.state.trim();
  const chamberRaw = m.groups.chamber.toLowerCase();
  const chamber = chamberRaw === "senate" ? "senate" : chamberRaw === "governor" ? "governor" : "house";
  if (!state) return null;
  return { state, chamber, subjectRaw: `${state} ${chamber} race` };
}

const PRIMARY_ADVANCE_TITLE_RX =
  /^Will\s+(?<candidate>[\p{L}][\p{L}\p{M}\s.'’\-]+?)\s+advance\s+in\s+the\s+(?<year>20\d{2})\s+(?<district>[A-Z]{2}(?:-\d{1,2})?)\s+primary\s*\??$/iu;
export function parsePrimaryAdvance(
  title: string,
): { candidate: string; year: number; district: string } | null {
  const m = title.match(PRIMARY_ADVANCE_TITLE_RX);
  if (!m?.groups) return null;
  const candidate = m.groups.candidate.trim();
  const year = parseInt(m.groups.year, 10);
  const district = m.groups.district.trim();
  if (!candidate || /^who$/i.test(candidate) || !Number.isInteger(year) || !district) return null;
  return { candidate, year, district };
}
export function primaryAdvanceCanonicalEvent(year: number, district: string, party: string | null): string {
  const partySeg = party ? ` ${party.toLowerCase()}` : "";
  return `${year} ${district.toLowerCase()}${partySeg} primary`;
}

// Not certified sum=1: unlisted magnitudes remain admissible; mutex <=1.
const FED_DECISION_TITLE_RX =
  /^Will the Federal Reserve\s+(?<action>Hike|Cut)\s+rates\s+by\s+(?<gt>>)?(?<bps>\d+)bps\s+at\s+their\s+(?<month>[A-Za-z]+)\s+(?<year>20\d{2})\s+meeting\s*\??$/i;
export type FedDecisionParse = {
  action: "hike" | "cut" | "maintain";
  /** Signed basis points: positive=hike, negative=cut, 0=maintain. */
  bps: number;
  /** Whether the magnitude is a strict ">" lower bound (e.g. ">25bps"). */
  isStrictGreater: boolean;
  month: string;
  year: number;
};
export function parseFedDecision(title: string): FedDecisionParse | null {
  const m = title.match(FED_DECISION_TITLE_RX);
  if (!m?.groups) return null;
  const rawBps = parseInt(m.groups.bps, 10);
  const year = parseInt(m.groups.year, 10);
  if (!Number.isInteger(rawBps) || rawBps < 0 || !Number.isInteger(year)) return null;
  const month = m.groups.month.trim();
  if (!month) return null;
  const isStrictGreater = m.groups.gt === ">";
  // "Hike by 0bps" is the maintain outcome.
  let action: "hike" | "cut" | "maintain";
  let bps: number;
  if (rawBps === 0) {
    action = "maintain";
    bps = 0;
  } else if (/^hike$/i.test(m.groups.action)) {
    action = "hike";
    bps = rawBps;
  } else {
    action = "cut";
    bps = -rawBps;
  }
  return { action, bps, isStrictGreater, month, year };
}
export function fedDecisionCanonicalEvent(month: string, year: number): string {
  return `federal reserve rate decision ${month.toLowerCase()} ${year}`;
}
// Strict-greater maintain ('>0bps') has no sound stamp on this table -> null.
export function fedDecisionStamp(
  p: FedDecisionParse,
): { direction: "at" | "above" | "below"; bps: number } | null {
  if (p.isStrictGreater) {
    if (p.action === "maintain") return null;
    return { direction: p.action === "cut" ? "below" : "above", bps: p.bps };
  }
  return { direction: "at", bps: p.bps };
}

// Families not covered here leave sport_canonical=NULL downstream.
export interface SeriesSportSpec {
  sport: string;
  tourGender?: "itf-m" | "itf-w";
}

// [seriesTickerPrefix-base, spec] — base matched via prefix.startsWith(base).
const SERIES_SPORT_ENTRIES: ReadonlyArray<readonly [string, SeriesSportSpec]> = [
  ["KXLOL",       { sport: "league of legends" }],
  ["KXCS2",       { sport: "cs2" }],
  ["KXDOTA2",     { sport: "dota 2" }],
  ["KXVALORANT",  { sport: "valorant" }],
  // Enumerate CoD sub-series individually to avoid prefix-matching KXCODINGMODEL.
  ["KXCODMAP",       { sport: "esports" }],
  ["KXCODGAME",      { sport: "esports" }],
  ["KXCODTOTALMAPS", { sport: "esports" }],
  ["KXR6",        { sport: "esports" }],
  ["KXITFMATCH",  { sport: "tennis", tourGender: "itf-m" }],
  ["KXITFWMATCH", { sport: "tennis", tourGender: "itf-w" }],
  ["KXSQUASH",    { sport: "squash" }],
  ["KXPSASQUASH", { sport: "squash" }],
  ["KXWC",             { sport: "soccer" }],
  ["KXBRASILEIRO",     { sport: "soccer" }],
  ["KXCOPADOBRASIL",   { sport: "soccer" }],
  ["KXSAUDIPL",        { sport: "soccer" }],
  ["KXEREDIVISIE",     { sport: "soccer" }],
  ["KXARGPREMDIV",     { sport: "soccer" }],
  ["KXLIGAPORTUGAL",   { sport: "soccer" }],
  ["KXISL",            { sport: "soccer" }],
  ["KXBOLPDIV",        { sport: "soccer" }],
  ["KXCHNSL",          { sport: "soccer" }],
  ["KXSLGREECE",       { sport: "soccer" }],
  ["KXNWSL",           { sport: "soccer" }],
  ["KXBELGIANPL",      { sport: "soccer" }],
  ["KXELITESERIEN",    { sport: "soccer" }],
  ["KXSWISSLEAGUE",    { sport: "soccer" }],
  ["KXEKSTRAKLASA",    { sport: "soccer" }],
  ["KXPERLIGA1",       { sport: "soccer" }],
  ["KXURYPD",          { sport: "soccer" }],
  ["KXAPFDDH",         { sport: "soccer" }],
  ["KXTHAIL1",         { sport: "soccer" }],
  ["KXECULP",          { sport: "soccer" }],
  ["KXEGYPL",          { sport: "soccer" }],
  ["KXEWSL",           { sport: "soccer" }],
  ["KXALLSVENSKAN",    { sport: "soccer" }],
  ["KXJLEAGUE",        { sport: "soccer" }],
  ["KXVENFUTVE",       { sport: "soccer" }],
  ["KXDENSUPERLIGA",   { sport: "soccer" }],
  ["KXHNL",            { sport: "soccer" }],
  ["KXDIMAYOR",        { sport: "soccer" }],
  ["KXLIGAMX",         { sport: "soccer" }],
  ["KXSERIEB",         { sport: "soccer" }],
  ["KXSUPERLIG",       { sport: "soccer" }],
  ["KXCHLLDP",         { sport: "soccer" }],
  ["KXEFLCHAMPIONSHIP", { sport: "soccer" }],
  ["KXEFLL1",          { sport: "soccer" }],
  ["KXUEL",            { sport: "soccer" }],
  ["KXUECL",           { sport: "soccer" }],
  ["KXALEAGUE",        { sport: "soccer" }],
  ["KXKLEAGUE",        { sport: "soccer" }],
  ["KXSCOTTISHPREM",   { sport: "soccer" }],
  ["KXUAEPL",          { sport: "soccer" }],
  ["KXCZEFL",          { sport: "soccer" }],
  ["KXBALLERLEAGUE",   { sport: "soccer" }],
  ["KXKBO",            { sport: "baseball" }],
  ["KXNPB",            { sport: "baseball" }],
  ["KXNCAABB",         { sport: "baseball" }],
  ["KXNCAABASEBALL",   { sport: "baseball" }],
  ["KXNEXTTEAMMLB",    { sport: "baseball" }],
  ["KXNEXTTEAMNBA",    { sport: "basketball" }],
  ["KXNEXTNBACOACH",   { sport: "basketball" }],
  ["KXACB",            { sport: "basketball" }],
  ["KXARGLNB",         { sport: "basketball" }],
  ["KXLNBELITE",       { sport: "basketball" }],
  ["KXBBSERIEA",       { sport: "basketball" }],
  ["KXCBA",            { sport: "basketball" }],
  ["KXBSL",            { sport: "basketball" }],
  ["KXJBLEAGUE",       { sport: "basketball" }],
  ["KXNZNBL",          { sport: "basketball" }],
  ["KXABA",            { sport: "basketball" }],
  ["KXVTB",            { sport: "basketball" }],
  ["KXGBL",            { sport: "basketball" }],
  ["KXNCAAMB",         { sport: "basketball (ncaa)" }],
  ["KXNCAAWB",         { sport: "basketball (ncaa)" }],
  ["KXMARMAD",         { sport: "basketball (ncaa)" }],
  ["KXWMARMAD",        { sport: "basketball (ncaa)" }],
  ["KXNEXTTEAMNFL",    { sport: "american football" }],
  ["KXSTARTINGQBWEEK1", { sport: "american football" }],
  ["KXUFL",            { sport: "american football" }],
  ["KXNCAAF",          { sport: "american football (ncaa)" }],
  ["KXCOUNTYCHAMPMATCH", { sport: "cricket" }],
  ["KXT20MATCH",       { sport: "cricket" }],
  ["KXAHL",            { sport: "ice hockey" }],
  ["KXSHL",            { sport: "ice hockey" }],
  ["KXKHL",            { sport: "ice hockey" }],
  ["KXNEXTTEAMNHL",    { sport: "ice hockey" }],
  ["KXRUGBYNRL",       { sport: "rugby league" }],
  ["KXRUGBYESL",       { sport: "rugby league" }],
  ["KXNRLCHAMP",       { sport: "rugby league" }],
  ["KXSLRCHAMP",       { sport: "rugby league" }],
  ["KXNCAAMLAX",       { sport: "lacrosse" }],
  ["KXNCAALAX",        { sport: "lacrosse" }],
  ["KXPLL",            { sport: "lacrosse" }],
  ["KXDARTS",          { sport: "darts" }],
  ["KXPREMDARTS",      { sport: "darts" }],
  ["KXBOXING",         { sport: "boxing" }],
];

// Longest-base-first: a more specific base (e.g. KXNCAABASEBALL) must match before a shorter one.
const SERIES_SPORT_ENTRIES_SORTED = [...SERIES_SPORT_ENTRIES]
  .sort((a, b) => b[0].length - a[0].length);

export function lookupSeriesSport(
  eventTicker: string | null,
): { base: string; spec: SeriesSportSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const hit = SERIES_SPORT_ENTRIES_SORTED.find((e) => prefix.startsWith(e[0]));
  return hit ? { base: hit[0], spec: hit[1] } : null;
}

export const __SERIES_SPORT_TEST__ = { SERIES_SPORT_ENTRIES };

// Bespoke series families: pure registries + title/strike parsers, DB-free.
export const UFC_METHOD_OF_VICTORY_PREFIX = "KXUFCMOV";
// Ordered finish-method vocabulary -> 1-based ordinal (the gated value_primary).
export const UFC_MOV_METHOD_VOCAB: readonly string[] = ["KO/TKO/DQ", "Submission", "Decision"];
const UFC_MOV_EVENT_TITLE_RX = /^(?<a>.+?)\s+vs\.?\s+(?<b>.+?):\s*Method of Victory$/i;
const UFC_MOV_RESIDUAL_METHOD_RX = /^draw(?:\s*\/\s*no\s+contest)?$/i;

function parseUfcMovCustomStrike(customStrike: string | null): { method: string; participant: string } | null {
  if (!customStrike) return null;
  let p: unknown;
  try { p = JSON.parse(customStrike); } catch { return null; }
  const o = p as { Method?: unknown; Participant?: unknown } | null;
  const method = o?.Method == null ? null : String(o.Method).trim();
  const participant = o?.Participant == null ? null : String(o.Participant).trim();
  if (!method || !participant) return null;
  return { method, participant };
}

export type UfcMethodOfVictoryParse =
  | { kind: "method"; a: string; b: string; winner: string; method: string; methodOrdinal: number }
  | { kind: "decision_or_draw"; a: string; b: string };

export function parseUfcMethodOfVictory(
  row: { event_title: string | null; custom_strike: string | null },
): UfcMethodOfVictoryParse | null {
  const fm = (row.event_title ?? "").trim().match(UFC_MOV_EVENT_TITLE_RX);
  if (!fm?.groups) return null;
  const a = fm.groups.a.trim();
  const b = fm.groups.b.trim();
  if (a.length < 2 || b.length < 2) return null;
  const cs = parseUfcMovCustomStrike(row.custom_strike);
  if (!cs) return null;
  if (UFC_MOV_RESIDUAL_METHOD_RX.test(cs.method)) return { kind: "decision_or_draw", a, b };
  const ordinalIdx = UFC_MOV_METHOD_VOCAB.findIndex((v) => v.toLowerCase() === cs.method.toLowerCase());
  if (ordinalIdx < 0) return null;
  const fp = foldName(cs.participant);
  let winner: string;
  if (fp === foldName(a)) winner = a;
  else if (fp === foldName(b)) winner = b;
  else return null;
  return { kind: "method", a, b, winner, method: UFC_MOV_METHOD_VOCAB[ordinalIdx], methodOrdinal: ordinalIdx + 1 };
}

// Subject stays the literal pair string; never decompose into two teams.
export const WORLD_SERIES_MATCHUP_PREFIX = "KXTEAMSINWS";
export function parseWorldSeriesMatchup(
  row: { yes_sub_title: string | null; custom_strike: string | null },
): { pair: string } | null {
  let pair: string | null = null;
  if (row.custom_strike) {
    try {
      const o = JSON.parse(row.custom_strike) as { Team?: unknown };
      if (o?.Team != null) pair = String(o.Team).trim();
    } catch { /* fall through to yes_sub_title */ }
  }
  if (!pair) pair = (row.yes_sub_title ?? "").trim();
  if (!pair) return null;
  if (!/\svs\.?\s/i.test(pair)) return null;
  return { pair };
}

// Subject = home team (first in "A vs B"), never the winner (a draw has no winner).
export const SOCCER_CORRECT_SCORE_PREFIX = "KXWCSCORE";

// Half-scoped series need both metric_scope != NULL and a canonical_event suffix:
// scope alone lets the NULL full-time side merge on the equivalence gate.
export interface SoccerCorrectScoreSpec { scope: MetricScope | null; canonicalSuffix: string; }
export const SOCCER_CORRECT_SCORE_SERIES: Record<string, SoccerCorrectScoreSpec> = {
  KXWCSCORE:   { scope: null,     canonicalSuffix: "" },
  KXWC1HSCORE: { scope: "half_1", canonicalSuffix: " 1st half" },
  KXMLSSCORE:        { scope: null, canonicalSuffix: "" },
  KXUECLSCORE:       { scope: null, canonicalSuffix: "" },
  KXUELSCORE:        { scope: null, canonicalSuffix: "" },
  KXBRASILEIROSCORE: { scope: null, canonicalSuffix: "" },
  KXLIGAMXSCORE:     { scope: null, canonicalSuffix: "" },
};
// Anchored to a scoreline (never a bare team name) to avoid collapsing distinct scorelines into a fake one-hot.
const CORRECT_SCORE_LABEL_RX = /(?:\bwins?\b|\bdraw\b)[^0-9]{0,20}\d{1,2}\s*[-–]\s*\d{1,2}\b/i;
export function looksCorrectScoreLabel(label: string | null | undefined): boolean {
  return label != null && CORRECT_SCORE_LABEL_RX.test(label);
}

export function lookupSoccerCorrectScoreSeries(
  eventTicker: string | null,
): { prefix: string; spec: SoccerCorrectScoreSpec } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = SOCCER_CORRECT_SCORE_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}
const SCORE_EVENT_TITLE_RX = /^(?<a>.+?)\s+vs\.?\s+(?<b>.+?):\s*.*Correct Score$/i;
const SCORE_INNER_RX =
  /^(?:Draw\s+(?<da>\d+)\s*-\s*(?<db>\d+)|(?<w>.+?)\s+wins\s+(?<wa>\d+)\s*-\s*(?<wb>\d+))$/i;
const SCORE_YST_RX = /^Reg(?:ulation)?\s*Time:\s*(?<inner>.+?)\s*$/i;
// SCORE_YST_RX intentionally doesn't match the 1H yst ("Draw 1H 0-0"), so the 1H inner scoreline comes from the title.
const SCORE_TITLE_RX = /^Will the (?:final|1st half|first half) score be\s+(?<inner>.+?)\s*\??$/i;

function parseScoreCustomStrike(customStrike: string | null): { home: number; away: number } | null {
  if (!customStrike) return null;
  let p: unknown;
  try { p = JSON.parse(customStrike); } catch { return null; }
  const o = p as { home_score?: unknown; away_score?: unknown } | null;
  if (o?.home_score == null || o?.away_score == null) return null;
  const home = parseInt(String(o.home_score), 10);
  const away = parseInt(String(o.away_score), 10);
  if (!Number.isInteger(home) || !Number.isInteger(away)) return null;
  return { home, away };
}

export interface SoccerCorrectScoreParse {
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  isDraw: boolean;
}

export function parseSoccerCorrectScore(
  row: { event_title: string | null; yes_sub_title: string | null; title: string; custom_strike: string | null },
): SoccerCorrectScoreParse | null {
  const fm = (row.event_title ?? "").trim().match(SCORE_EVENT_TITLE_RX);
  if (!fm?.groups) return null;
  const home = fm.groups.a.trim();
  const away = fm.groups.b.trim();
  if (home.length < 2 || away.length < 2) return null;

  const ystInner = (row.yes_sub_title ?? "").trim().match(SCORE_YST_RX)?.groups?.inner;
  const titleInner = row.title.trim().match(SCORE_TITLE_RX)?.groups?.inner;
  const inner = (ystInner ?? titleInner ?? "").trim();
  const sm = inner.match(SCORE_INNER_RX);
  if (!sm?.groups) return null;

  let homeGoals: number;
  let awayGoals: number;
  let isDraw: boolean;
  if (sm.groups.da != null) {
    const da = parseInt(sm.groups.da, 10);
    const db = parseInt(sm.groups.db, 10);
    if (!Number.isInteger(da) || da !== db) return null;
    homeGoals = da; awayGoals = db; isDraw = true;
  } else {
    const w = (sm.groups.w ?? "").trim();
    const wa = parseInt(sm.groups.wa, 10);
    const wb = parseInt(sm.groups.wb, 10);
    if (!Number.isInteger(wa) || !Number.isInteger(wb) || wa <= wb) return null;
    const fw = foldName(w);
    if (fw === foldName(home)) { homeGoals = wa; awayGoals = wb; }
    else if (fw === foldName(away)) { homeGoals = wb; awayGoals = wa; }
    else return null;
    isDraw = false;
  }
  const cs = parseScoreCustomStrike(row.custom_strike);
  if (cs && (cs.home !== homeGoals || cs.away !== awayGoals)) return null;
  return { home, away, homeGoals, awayGoals, isDraw };
}

export const SET_WINNER_SERIES: Record<string, { sport: string }> = {
  KXATPSETWINNER: { sport: "tennis" },
  KXWTASETWINNER: { sport: "tennis" },
};
export function lookupSetWinnerSeries(eventTicker: string | null): { prefix: string; spec: { sport: string } } | null {
  if (!eventTicker) return null;
  const prefix = eventTicker.split("-")[0];
  if (!prefix) return null;
  const spec = SET_WINNER_SERIES[prefix];
  return spec ? { prefix, spec } : null;
}
const SET_WINNER_TITLE_RX =
  /^Will\s+(?<player>.+?)\s+win\s+set\s+(?<set>\d+)\s+in\s+the\s+(?<a>.+?)\s+vs\.?\s+(?<b>.+?)\s+match\b/i;
export function parseSetWinner(
  eventTicker: string | null,
  row: { title: string; yes_sub_title: string | null },
): { player: string; setOrdinal: number; a: string; b: string } | null {
  if (!eventTicker) return null;
  const parts = eventTicker.split("-");
  const suffix = parts[parts.length - 1];
  const setFromTicker = suffix && /^\d+$/.test(suffix) ? parseInt(suffix, 10) : null;
  const tm = row.title.trim().match(SET_WINNER_TITLE_RX);
  if (!tm?.groups) return null;
  const setFromTitle = parseInt(tm.groups.set, 10);
  if (!Number.isInteger(setFromTitle) || setFromTitle < 1) return null;
  // Ticker suffix (when numeric) must agree with the title's set ordinal.
  if (setFromTicker != null && setFromTicker !== setFromTitle) return null;
  const a = tm.groups.a.trim();
  const b = tm.groups.b.trim();
  const titlePlayer = tm.groups.player.trim();
  const yst = (row.yes_sub_title ?? "").trim();
  const player = yst || titlePlayer;
  if (!player || a.length < 2 || b.length < 2) return null;
  // The winner must be one of the two named players (fold-compare).
  const fp = foldName(player);
  if (fp !== foldName(a) && fp !== foldName(b)) return null;
  return { player, setOrdinal: setFromTitle, a, b };
}

// Subject comes from the title, not yes_sub_title (which carries "<P> beats <X> and <Y>").
export const PGA_3BALL_PREFIX = "KXPGA3BALL";
const PGA_3BALL_TITLE_RX =
  /^Will\s+(?<player>.+?)\s+win\s+the\s+(?<round>\d+)(?:st|nd|rd|th)\s+round\s+3-ball\s+matchup\s*\??$/i;
export function parse3BallMatchup(row: { title: string }): { player: string; round: number } | null {
  const m = row.title.trim().match(PGA_3BALL_TITLE_RX);
  if (!m?.groups) return null;
  const player = m.groups.player.trim();
  const round = parseInt(m.groups.round, 10);
  if (!player || !Number.isInteger(round) || round < 1) return null;
  return { player, round };
}

// Subject is the literal storm name, never KB-minted as an entity.
export const FIRST_HURRICANE_PREFIX = "KXFIRSTHURRICANE";
export const HURRICANE_BASINS: Readonly<Record<string, string>> = {
  ATL: "Atlantic", EPAC: "Eastern Pacific", CPAC: "Central Pacific",
};
const HURRICANE_TICKER_RX = /^(?<yy>\d{2})[A-Z]{3}\d{2}(?<basin>ATL|EPAC|CPAC)$/;
export function parseFirstHurricane(
  eventTicker: string | null,
  row: { yes_sub_title: string | null; custom_strike: string | null },
): { storm: string; basinCode: string; basin: string; year: number } | null {
  if (!eventTicker) return null;
  const seg = eventTicker.split("-")[1] ?? "";
  const tm = seg.match(HURRICANE_TICKER_RX);
  if (!tm?.groups) return null;
  const basinCode = tm.groups.basin;
  const basin = HURRICANE_BASINS[basinCode];
  if (!basin) return null;
  const year = 2000 + parseInt(tm.groups.yy, 10);
  let storm: string | null = null;
  if (row.custom_strike) {
    try {
      const o = JSON.parse(row.custom_strike) as { storm?: unknown };
      if (o?.storm != null) storm = String(o.storm).trim();
    } catch { /* fall through */ }
  }
  if (!storm) storm = (row.yes_sub_title ?? "").trim();
  if (!storm) return null;
  return { storm, basinCode, basin, year };
}
export function firstHurricaneCanonicalEvent(year: number, basin: string): string {
  return `${year} first hurricane ${basin.toLowerCase()}`;
}

export const EMMY_COUNT_PREFIX = "KXEMMYCOUNT";
const EMMY_SHOW_EVENT_TITLE_RX = /^How many Emmys will\s+'(?<show>.+?)'\s+win\s*\??$/i;
const EMMY_SHOW_TITLE_RX = /^How many awards will\s+(?<show>.+?)\s+win\s+at\s+the\b/i;
export function parseEmmyCount(
  row: { title: string; event_title: string | null; custom_strike: string | null; floor_strike: string | null; cap_strike: string | null },
): { show: string; count: number } | null {
  // Count: custom_strike {"Count":"N"} preferred; fall back to floor==cap.
  let count: number | null = null;
  if (row.custom_strike) {
    try {
      const o = JSON.parse(row.custom_strike) as { Count?: unknown };
      if (o?.Count != null) { const n = parseInt(String(o.Count), 10); if (Number.isInteger(n)) count = n; }
    } catch { /* fall through */ }
  }
  if (count == null && row.floor_strike != null && row.floor_strike === row.cap_strike) {
    const n = parseInt(row.floor_strike, 10);
    if (Number.isInteger(n)) count = n;
  }
  if (count == null || count < 0) return null;
  // Show: prefer the quoted event_title; fall back to the title.
  const show =
    (row.event_title ?? "").trim().match(EMMY_SHOW_EVENT_TITLE_RX)?.groups?.show?.trim() ??
    row.title.trim().match(EMMY_SHOW_TITLE_RX)?.groups?.show?.trim() ?? null;
  if (!show) return null;
  return { show, count };
}
