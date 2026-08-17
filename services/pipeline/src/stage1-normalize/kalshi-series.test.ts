/**
 * Unit tests for the Kalshi series registries + pure matchers
 * (kalshi-series.ts). Cover the soundness boundaries the generic shapers
 * depend on.
 */
import { describe, test, expect } from "bun:test";
import { parseMetricScopeFromTitle } from "./metric-scope.js";
import {
  parseSpreadTitle,
  parseSpreadYstTeam,
  parseTennisGamesSpread,
  extractSpreadFixture,
  parseGolfRoundScore,
  extractMusicUnitsSubject,
  extractRottenTomatoesSubject,
  isExactRottenTomatoesSeries,
  extractSoccer1HFixture,
  extractMotorsportEvent,
  parseDraftPickNumber,
  parseDraftYear,
  draftCanonicalEvent,
  lookupLadderSeries,
  lookupWinnerSeries,
  lookupDraftSeries,
  LADDER_SERIES,
  WINNER_SERIES,
  DRAFT_SERIES,
  lookupMajorGrandSlamSeries,
  parseWinAChampionship,
  majorGrandSlamCanonicalEvent,
  MAJOR_GRANDSLAM_SERIES,
  parseF5SpreadTitle,
  extractF5SpreadFixture,
  parseGolfRoundTopN,
  golfRoundCanonicalEvent,
  lookupExactSetScoreSeries,
  parseExactSetScore,
  EXACT_SET_SCORE_SERIES,
  UFC_VICTORY_ROUND_PREFIX,
  parseUfcVictoryRound,
  lookupAwardSeries,
  parseAwardTitle,
  isAwardTieNominee,
  awardCanonicalEvent,
  AWARD_SERIES,
  parseGolfRoundLeader,
  golfRoundLeaderCanonicalEvent,
  lookupDraftTopNSeries,
  parseDraftTopN,
  draftTopNCanonicalEvent,
  DRAFT_TOPN_SERIES,
  parseMidtermVoteTurnStatewide,
  parsePrimaryAdvance,
  primaryAdvanceCanonicalEvent,
  parseFedDecision,
  fedDecisionCanonicalEvent,
  fedDecisionStamp,
  lookupSeriesSport,
  parseUfcMethodOfVictory,
  parseWorldSeriesMatchup,
  parseSoccerCorrectScore,
  lookupSoccerCorrectScoreSeries,
  looksCorrectScoreLabel,
  parseSetWinner,
  lookupSetWinnerSeries,
  parse3BallMatchup,
  parseFirstHurricane,
  firstHurricaneCanonicalEvent,
  parseEmmyCount,
} from "./kalshi-series.js";

const APOS = String.fromCharCode(39);

// Real titles from the live DB.
describe("P4 gap 3a — tennis exact set-score parser (KXATPEXACTMATCH)", () => {
  const SPEC = EXACT_SET_SCORE_SERIES.KXATPEXACTMATCH;

  test("lookup gates on the series prefix only", () => {
    expect(lookupExactSetScoreSeries("KXATPEXACTMATCH-26MAY10RUBDAV")).toMatchObject({ prefix: "KXATPEXACTMATCH" });
    expect(lookupExactSetScoreSeries("KXWTAEXACTMATCH-26MAY10AAABBB")).toMatchObject({ prefix: "KXWTAEXACTMATCH" });
    expect(lookupExactSetScoreSeries("KXUFCVICROUND-26MAY16MOKMOR")).toBeNull();
    expect(lookupExactSetScoreSeries(null)).toBeNull();
  });

  test("live title + matching yst → winner/loser + set pair (2-1)", () => {
    const p = parseExactSetScore({
      title: "Will Andrey Rublev win the Andrey Rublev vs Alejandro Davidovich Fokina match by a set score of 2-1?",
      yes_sub_title: "Andrey Rublev wins 2-1",
    }, SPEC);
    expect(p).toEqual({ winner: "Andrey Rublev", loser: "Alejandro Davidovich Fokina", setsWon: 2, setsLost: 1 });
  });

  test("away-named winner orients loser correctly (2-0)", () => {
    const p = parseExactSetScore({
      title: "Will Alejandro Davidovich Fokina win the Andrey Rublev vs Alejandro Davidovich Fokina match by a set score of 2-0?",
      yes_sub_title: "Alejandro Davidovich Fokina wins 2-0",
    }, SPEC);
    expect(p).toEqual({ winner: "Alejandro Davidovich Fokina", loser: "Andrey Rublev", setsWon: 2, setsLost: 0 });
  });

  test("missing yst still parses from the title alone", () => {
    const p = parseExactSetScore({
      title: "Will Daniil Medvedev win the Pablo Llamas Ruiz vs Daniil Medvedev match by a set score of 2-0?",
      yes_sub_title: null,
    }, SPEC);
    expect(p).toEqual({ winner: "Daniil Medvedev", loser: "Pablo Llamas Ruiz", setsWon: 2, setsLost: 0 });
  });

  test("SOUNDNESS: yst disagreement (winner OR score) → bail", () => {
    const base = "Will Andrey Rublev win the Andrey Rublev vs Alejandro Davidovich Fokina match by a set score of 2-1?";
    expect(parseExactSetScore({ title: base, yes_sub_title: "Andrey Rublev wins 2-0" }, SPEC)).toBeNull();
    expect(parseExactSetScore({ title: base, yes_sub_title: "Alejandro Davidovich Fokina wins 2-1" }, SPEC)).toBeNull();
    expect(parseExactSetScore({ title: base, yes_sub_title: "garbage" }, SPEC)).toBeNull();
  });

  test("SOUNDNESS: winner not a participant / invalid BO3 line → bail", () => {
    expect(parseExactSetScore({
      title: "Will Carlos Alcaraz win the Andrey Rublev vs Alejandro Davidovich Fokina match by a set score of 2-0?",
      yes_sub_title: null,
    }, SPEC)).toBeNull();
    // 3-1 is a BO5 line — never emitted at BO3 grain
    expect(parseExactSetScore({
      title: "Will Andrey Rublev win the Andrey Rublev vs Alejandro Davidovich Fokina match by a set score of 3-1?",
      yes_sub_title: null,
    }, SPEC)).toBeNull();
    // 2-2 (winner must strictly lead)
    expect(parseExactSetScore({
      title: "Will Andrey Rublev win the Andrey Rublev vs Alejandro Davidovich Fokina match by a set score of 2-2?",
      yes_sub_title: null,
    }, SPEC)).toBeNull();
  });

  test("distinct scorelines/winners can never normalize identically (discriminator audit)", () => {
    const mk = (w: string, s: string) => parseExactSetScore({
      title: `Will ${w} win the Andrey Rublev vs Alejandro Davidovich Fokina match by a set score of ${s}?`,
      yes_sub_title: `${w} wins ${s}`,
    }, SPEC);
    const all = [mk("Andrey Rublev", "2-0"), mk("Andrey Rublev", "2-1"),
                 mk("Alejandro Davidovich Fokina", "2-0"), mk("Alejandro Davidovich Fokina", "2-1")];
    const keys = new Set(all.map((p) => `${p!.winner}|${p!.setsWon}-${p!.setsLost}`));
    expect(keys.size).toBe(4);
  });
});

// Real titles from the live DB.
describe("P4 gap 3b — UFC round-of-victory parser (KXUFCVICROUND)", () => {
  test("prefix constant matches the live series", () => {
    expect(UFC_VICTORY_ROUND_PREFIX).toBe("KXUFCVICROUND");
  });

  test("round leg + matching yst → winner/opponent/round", () => {
    const p = parseUfcVictoryRound({
      title: "Will Adriano Moraes win the Muhammad Mokaev vs. Adriano Moraes UFC fight in Round 3",
      yes_sub_title: "Adriano Moraes to win in Round 3",
    });
    expect(p).toEqual({ kind: "round", winner: "Adriano Moraes", opponent: "Muhammad Mokaev",
                        a: "Muhammad Mokaev", b: "Adriano Moraes", round: 3 });
  });

  test("hw821-A EXTEND: live titles carry the UFC EVENT NUMBER not literal 'UFC fight'", () => {
    // "… vs. John Garza 329 fight in Round 1" (live KXUFCVICROUND-26JUL11BASGAR).
    const p = parseUfcVictoryRound({
      title: "Will Farid Basharat win the Farid Basharat vs. John Garza 329 fight in Round 1",
      yes_sub_title: "Farid Basharat to win in Round 1",
    });
    expect(p).toEqual({ kind: "round", winner: "Farid Basharat", opponent: "John Garza",
                        a: "Farid Basharat", b: "John Garza", round: 1 });
    // bare "fight" (no descriptor) still parses too
    expect(parseUfcVictoryRound({
      title: "Will John Garza win the Farid Basharat vs. John Garza fight in Round 2",
      yes_sub_title: "John Garza to win in Round 2",
    })).toMatchObject({ kind: "round", winner: "John Garza", round: 2 });
  });

  test("5-round main-event legs (Round 4/5) parse", () => {
    const p = parseUfcVictoryRound({
      title: "Will Francis Ngannou win the Francis Ngannou vs. Philipe Lins UFC fight in Round 5",
      yes_sub_title: "Francis Ngannou to win in Round 5",
    });
    expect(p).toMatchObject({ kind: "round", winner: "Francis Ngannou", round: 5 });
  });

  test("decision/draw residual leg parses (live title, no trailing '?')", () => {
    const p = parseUfcVictoryRound({
      title: "Will either competitor win the Muhammad Mokaev vs. Adriano Moraes fight by decision or the fight result in a draw/no contest",
      yes_sub_title: "Decision / Draw / No Contest",
    });
    expect(p).toEqual({ kind: "decision_or_draw", a: "Muhammad Mokaev", b: "Adriano Moraes" });
  });

  test("SOUNDNESS: yst round/winner disagreement → bail", () => {
    const title = "Will Adriano Moraes win the Muhammad Mokaev vs. Adriano Moraes UFC fight in Round 3";
    expect(parseUfcVictoryRound({ title, yes_sub_title: "Adriano Moraes to win in Round 2" })).toBeNull();
    expect(parseUfcVictoryRound({ title, yes_sub_title: "Muhammad Mokaev to win in Round 3" })).toBeNull();
    expect(parseUfcVictoryRound({ title, yes_sub_title: "Decision / Draw / No Contest" })).toBeNull();
  });

  test("SOUNDNESS: winner not a participant / round out of range → bail", () => {
    expect(parseUfcVictoryRound({
      title: "Will Jon Jones win the Muhammad Mokaev vs. Adriano Moraes UFC fight in Round 1",
      yes_sub_title: null,
    })).toBeNull();
    expect(parseUfcVictoryRound({
      title: "Will Adriano Moraes win the Muhammad Mokaev vs. Adriano Moraes UFC fight in Round 6",
      yes_sub_title: null,
    })).toBeNull();
  });

  test("distinct rounds / sides / residual never collapse (discriminator audit)", () => {
    const legs = [
      parseUfcVictoryRound({ title: "Will Adriano Moraes win the Muhammad Mokaev vs. Adriano Moraes UFC fight in Round 1", yes_sub_title: null }),
      parseUfcVictoryRound({ title: "Will Adriano Moraes win the Muhammad Mokaev vs. Adriano Moraes UFC fight in Round 2", yes_sub_title: null }),
      parseUfcVictoryRound({ title: "Will Muhammad Mokaev win the Muhammad Mokaev vs. Adriano Moraes UFC fight in Round 1", yes_sub_title: null }),
      parseUfcVictoryRound({ title: "Will either competitor win the Muhammad Mokaev vs. Adriano Moraes fight by decision or the fight result in a draw/no contest", yes_sub_title: null }),
    ];
    const keys = new Set(legs.map((p) =>
      p!.kind === "round" ? `round|${p!.winner}|${p!.round}` : "decision_or_draw"));
    expect(keys.size).toBe(4);
  });
});

describe("B-kalshi-majors-recall AUD-14-B — per-player win-a-major/grand-slam (INDEPENDENT, never Σ=1)", () => {
  test("parseWinAChampionship: tennis Grand Slam → noun 'grand slam'", () => {
    expect(parseWinAChampionship("Will Alexander Bublik win a Tennis Grand Slam in 2026?")).toEqual({ player: "Alexander Bublik", competitionNoun: "grand slam", year: 2026 });
    expect(parseWinAChampionship("Will Alex de Minaur win a Tennis Grand Slam in 2026?")).toEqual({ player: "Alex de Minaur", competitionNoun: "grand slam", year: 2026 });
    expect(parseWinAChampionship("Will Felix Auger-Aliassime win a Tennis Grand Slam in 2026?")).toEqual({ player: "Felix Auger-Aliassime", competitionNoun: "grand slam", year: 2026 });
  });
  test("parseWinAChampionship: 'win a major' → noun 'major'", () => {
    expect(parseWinAChampionship("Will Joao Fonseca win a major in 2026?")).toEqual({ player: "Joao Fonseca", competitionNoun: "major", year: 2026 });
    expect(parseWinAChampionship("Will Scottie Scheffler win a PGA Tour Major in 2027?")).toEqual({ player: "Scottie Scheffler", competitionNoun: "major", year: 2027 });
  });
  test("parseWinAChampionship REJECTS the non-per-player-win forms (soundness boundary)", () => {
    expect(parseWinAChampionship("Who will win a PGA Tour Major in 2026?")).toBeNull();            // Pass-4 owns it
    expect(parseWinAChampionship("How many golf major championships will Scottie Scheffler win in 2026?")).toBeNull();
    expect(parseWinAChampionship("How many Grand Slams will Carlos Alcaraz win in 2026?")).toBeNull();
    expect(parseWinAChampionship("Will Jannik Sinner win more major tournaments in 2026?")).toBeNull();
    expect(parseWinAChampionship("Will any man other than Carlos Alcaraz and Jannik Sinner win any ATP Tennis Grand Slam in 2026?")).toBeNull();
    expect(parseWinAChampionship("")).toBeNull();
  });
  test("majorGrandSlamCanonicalEvent: '<year> <noun>' (cross-platform merge key)", () => {
    expect(majorGrandSlamCanonicalEvent("grand slam", 2026)).toBe("2026 grand slam");
    expect(majorGrandSlamCanonicalEvent("major", 2026)).toBe("2026 major");
  });
  test("lookupMajorGrandSlamSeries: ATP/WTA/Fonseca routed; field/count series EXCLUDED", () => {
    expect(lookupMajorGrandSlamSeries("KXATPGRANDSLAM-26")?.spec.sport).toBe("tennis");
    expect(lookupMajorGrandSlamSeries("KXWTAGRANDSLAM-26")?.spec.sport).toBe("tennis");
    expect(lookupMajorGrandSlamSeries("KXGRANDSLAMJFONSECA-26")?.spec.sport).toBe("tennis");
    expect(lookupMajorGrandSlamSeries("KXATPGRANDSLAMFIELD-26")).toBeNull(); // field/residual
    expect(lookupMajorGrandSlamSeries("KXGOLFMAJOR-26RMCI")).toBeNull();     // count ladder
    expect(lookupMajorGrandSlamSeries("KXGRANDSLAM-CALC26")).toBeNull();     // count ladder
    expect(lookupMajorGrandSlamSeries("KXPGAMAJORWIN-26")).toBeNull();       // Pass-4 categorical
    expect(lookupMajorGrandSlamSeries(null)).toBeNull();
  });
  test("registry isolation: major/grand-slam prefixes are not ladder/winner/draft prefixes", () => {
    for (const p of Object.keys(MAJOR_GRANDSLAM_SERIES)) {
      expect(LADDER_SERIES[p]).toBeUndefined();
      expect(WINNER_SERIES[p]).toBeUndefined();
      expect(DRAFT_SERIES[p]).toBeUndefined();
    }
  });
});

describe("B-kalshi-majors-recall — MLB F5 spread (metric_scope=first_5, DISJOINT from whole-game)", () => {
  test("parseF5SpreadTitle reads team+line from the 'first 5 innings' form", () => {
    expect(parseF5SpreadTitle("Washington wins first 5 innings by over 2.5 runs?")).toEqual({ team: "Washington", value: 2.5 });
    expect(parseF5SpreadTitle("Colorado wins first 5 innings by over 1.5 runs?")).toEqual({ team: "Colorado", value: 1.5 });
  });
  test("parseF5SpreadTitle REJECTS the whole-game spread title (keeps the two distinct)", () => {
    expect(parseF5SpreadTitle("Washington wins by over 2.5 runs?")).toBeNull();
    expect(parseF5SpreadTitle("Minnesota wins by over 15.5 points?")).toBeNull();
    expect(parseF5SpreadTitle("")).toBeNull();
  });
  test("extractF5SpreadFixture orients opponent from the rules fixture", () => {
    const r = extractF5SpreadFixture({ title: "A's wins first 5 innings by over 1.5 runs?", rules_primary: "If A's wins by more than 1.5 runs in the first 5 innings of the A's vs Baltimore professional baseball game originally scheduled for May 10" });
    expect(r?.team).toBe("A's");
    expect(r?.opponent).toBe("Baltimore");
    expect(r?.value).toBe(1.5);
  });
  test("extractF5SpreadFixture orients when the title team is the SECOND fixture side", () => {
    const r = extractF5SpreadFixture({ title: "Miami wins first 5 innings by over 1.5 runs?", rules_primary: "If Miami wins by more than 1.5 runs in the first 5 innings of the Washington vs Miami professional baseball game originally scheduled for May 10" });
    expect(r?.team).toBe("Miami");
    expect(r?.opponent).toBe("Washington");
  });
  test("extractF5SpreadFixture still shapes (opponent=null) when rules absent", () => {
    expect(extractF5SpreadFixture({ title: "Colorado wins first 5 innings by over 2.5 runs?", rules_primary: null })).toEqual({ team: "Colorado", value: 2.5, opponent: null });
  });
});

describe("B-kalshi-majors-recall — golf per-round TOP-N (per-player rank≤N, round-scoped)", () => {
  test("parseGolfRoundTopN reads tournament+player+n+round when prefix and title AGREE", () => {
    expect(parseGolfRoundTopN("KXPGAR1TOP10-PGC26", "PGA Championship: Will Aaron Rai finish top 10 in Round 1?")).toEqual({ tournament: "PGA Championship", player: "Aaron Rai", n: 10, round: 1 });
    expect(parseGolfRoundTopN("KXPGAR2TOP5-PGC26", "PGA Championship: Will Aaron Rai finish top 5 in Round 2?")).toEqual({ tournament: "PGA Championship", player: "Aaron Rai", n: 5, round: 2 });
    expect(parseGolfRoundTopN("KXPGAR3TOP20-PGC26", "PGA Championship: Will Stephan Jaeger finish top 20 in Round 3?")).toEqual({ tournament: "PGA Championship", player: "Stephan Jaeger", n: 20, round: 3 });
  });
  test("parseGolfRoundTopN BAILS on prefix↔title disagreement and the whole-tournament form", () => {
    expect(parseGolfRoundTopN("KXPGAR1TOP10-PGC26", "PGA Championship: Will Dustin Johnson finish top 5 in Round 1?")).toBeNull();   // N mismatch
    expect(parseGolfRoundTopN("KXPGAR1TOP10-PGC26", "PGA Championship: Will Dustin Johnson finish top 10 in Round 2?")).toBeNull(); // round mismatch
    expect(parseGolfRoundTopN("KXPGATOP10-PGC26", "PGA Championship: Will Tiger Woods finish top 10?")).toBeNull();                 // whole-tournament (Pass-7)
    expect(parseGolfRoundTopN(null, "x")).toBeNull();
  });
  test("golfRoundCanonicalEvent: round-scoped, distinct per round", () => {
    expect(golfRoundCanonicalEvent(2026, "PGA Championship", 1)).toBe("2026 pga championship round 1");
    expect(golfRoundCanonicalEvent(2026, "PGA Championship", 2)).toBe("2026 pga championship round 2");
    expect(golfRoundCanonicalEvent(2026, "PGA Championship", 1)).not.toBe("2026 pga championship"); // ≠ whole-tournament KXPGATOP
  });
});

describe("bg-reports — tennis game-spread parser (KXATPGSPREAD)", () => {
  test("parseTennisGamesSpread extracts player, line, and IN-TITLE opponent", () => {
    expect(parseTennisGamesSpread("Will Jannik Sinner win at least 4.5 more games than Novak Djokovic?"))
      .toEqual({ player: "Jannik Sinner", value: 4.5, opponent: "Novak Djokovic" });
    // multi-word names on both sides + single "game" (not "games") grammar guard.
    expect(parseTennisGamesSpread("Will Pablo Carreno Busta win at least 1.5 more games than Matej Dodig?"))
      .toEqual({ player: "Pablo Carreno Busta", value: 1.5, opponent: "Matej Dodig" });
  });
  test("parseTennisGamesSpread rejects the goals-spread / non-matching forms", () => {
    expect(parseTennisGamesSpread("Bremen wins by more than 1.5 goals?")).toBeNull();
    expect(parseTennisGamesSpread("")).toBeNull();
  });
  test("KXATPGSPREAD is registered as a match_spread ladder (metric score / unit games / person)", () => {
    const hit = lookupLadderSeries("KXATPGSPREAD-26JUL22SINDJO-4.5");
    expect(hit?.spec.eventKind).toBe("match_spread");
    expect(hit?.spec.subjectGrain).toBe("titleGamesSpread");
    expect(hit?.spec.subjectType).toBe("person");
    expect(hit?.spec.unit).toBe("games");
    expect(hit?.spec.requireStrikeType).toBe("greater");
  });
  test("KXCLUBFSPREAD / KXUECLSPREAD are registered soccer goal-spread ladders", () => {
    for (const p of ["KXCLUBFSPREAD", "KXUECLSPREAD"]) {
      const hit = lookupLadderSeries(p + "-26JUL22ABC-1.5");
      expect(hit?.spec.eventKind).toBe("match_spread");
      expect(hit?.spec.unit).toBe("goals");
      expect(hit?.spec.sport).toBe("soccer");
      expect(hit?.spec.subjectGrain).toBe("titleTeam");
    }
  });
});

describe("AUD-10 SPREAD — per-team orientation + opponent from rules", () => {
  test("parseSpreadTitle extracts the NAMED team + line (goals/points/runs)", () => {
    expect(parseSpreadTitle("Manchester City wins by over 2.5 goals?")).toEqual({ team: "Manchester City", value: 2.5 });
    expect(parseSpreadTitle("Minnesota wins by over 15.5 points?")).toEqual({ team: "Minnesota", value: 15.5 });
    expect(parseSpreadTitle("Montreal wins by over 1.5 goals")).toEqual({ team: "Montreal", value: 1.5 });
    // "more than" verb variant — live KXMLSSPREAD/KXLIGAMXSPREAD phrasing.
    expect(parseSpreadTitle("Inter Miami wins by more than 1.5 goals?")).toEqual({ team: "Inter Miami", value: 1.5 });
  });
  test("parseSpreadTitle rejects non-spread titles", () => {
    expect(parseSpreadTitle("Manchester City vs Crystal Palace: First Half Winner?")).toBeNull();
    expect(parseSpreadTitle("")).toBeNull();
  });
  test("extractSpreadFixture keeps subject = title team, opponent = OTHER rules team", () => {
    const r = extractSpreadFixture({
      title: "Tottenham wins by over 2.5 goals?",
      rules_primary: "If Tottenham wins by more than 2.5 goals in the Tottenham vs Leeds United professional EPL soccer game originally scheduled for May",
    });
    expect(r?.team).toBe("Tottenham");
    expect(r?.opponent).toBe("Leeds United");
    expect(r?.value).toBe(2.5);
  });
  test("extractSpreadFixture orients opponent when title team is the SECOND fixture side", () => {
    const r = extractSpreadFixture({
      title: "Celta Vigo wins by over 1.5 goals?",
      rules_primary: "If Celta Vigo wins by more than 1.5 goals in the Bilbao vs Celta Vigo professional La Liga soccer game originally scheduled for Ma",
    });
    expect(r?.team).toBe("Celta Vigo");
    expect(r?.opponent).toBe("Bilbao");
  });
  test("extractSpreadFixture still shapes (opponent=null) when rules fixture is unparseable", () => {
    const r = extractSpreadFixture({ title: "Montreal wins by over 1.5 goals?", rules_primary: null });
    expect(r?.team).toBe("Montreal");
    expect(r?.opponent).toBeNull();
  });
  test("Tranche C — extractSpreadFixture reads the 'Pro Basketball' summer-league rules terminator", () => {
    const r = extractSpreadFixture({
      title: "Milwaukee wins by over 6.5 points?",
      rules_primary: "If Milwaukee wins by more than 6.5 points in the Milwaukee vs Miami Pro Basketball Summer League game originally scheduled for Jul 10, 2026, then the market resolves to Yes.",
    });
    expect(r?.team).toBe("Milwaukee");
    expect(r?.opponent).toBe("Miami");
    expect(r?.value).toBe(6.5);
  });
  test("Tranche C — KXNBASUMMERSPREAD is a match_spread ladder (league-null, points)", () => {
    const s = lookupLadderSeries("KXNBASUMMERSPREAD-26JUL10MILMIA");
    expect(s?.spec.eventKind).toBe("match_spread");
    expect(s?.spec.subjectGrain).toBe("titleTeam");
    expect(s?.spec.unit).toBe("points");
    expect(s?.spec.league).toBeNull();
  });
  test("Tranche C — KXMUSICREPORT is an eventTitle categorical winner (entertainment)", () => {
    const w = lookupWinnerSeries("KXMUSICREPORT-TOPVYNLSALE27DEC31");
    expect(w?.spec.eventFrom).toBe("eventTitle");
    expect(w?.spec.subjectType).toBe("event_name");
    expect(w?.spec.subjectCategory).toBe("entertainment");
  });
  test("LADDER_SERIES spread rows carry match_spread + per-team titleTeam grain", () => {
    const epl = lookupLadderSeries("KXEPLSPREAD-26MAY13MCICRY");
    expect(epl?.spec.eventKind).toBe("match_spread");
    expect(epl?.spec.subjectGrain).toBe("titleTeam");
    expect(epl?.spec.unit).toBe("goals");
    const nba = lookupLadderSeries("KXNBASPREAD-26MAY10SASMIN");
    expect(nba?.spec.unit).toBe("points");
    expect(nba?.spec.league).toBe("NBA");
  });
  test("KXMLBSPREAD is NOT a generic ladder row (kept bespoke in tryMlbSpread)", () => {
    expect(lookupLadderSeries("KXMLBSPREAD-26MAY101610ATLLAD")).toBeNull();
  });

  test("KXCFLSPREAD is a match_spread ladder (american football, league CFL, points)", () => {
    const s = lookupLadderSeries("KXCFLSPREAD-26JUL12HAMSSK");
    expect(s?.spec.eventKind).toBe("match_spread");
    expect(s?.spec.subjectGrain).toBe("titleTeam");
    expect(s?.spec.sport).toBe("american football");
    expect(s?.spec.league).toBe("CFL");
    expect(s?.spec.unit).toBe("points");
  });
  test("KXWCSPREAD full-time is a soccer goal match_spread; CFL points title parses", () => {
    const wc = lookupLadderSeries("KXWCSPREAD-26JUL11ARGSUI");
    expect(wc?.spec.eventKind).toBe("match_spread");
    expect(wc?.spec.sport).toBe("soccer");
    expect(wc?.spec.unit).toBe("goals");
    // CFL over-verb title (points)
    expect(parseSpreadTitle("Hamilton Tiger-Cats wins by over 3.5 points?"))
      .toEqual({ team: "Hamilton Tiger-Cats", value: 3.5 });
    // WC more-than verb title (goals)
    expect(parseSpreadTitle("Argentina wins by more than 2.5 goals?"))
      .toEqual({ team: "Argentina", value: 2.5 });
  });
  test("KXWC1HSPREAD/KXWC2HSPREAD are registered; the half-suffix title parses (metric_scope keeps them distinct downstream)", () => {
    expect(lookupLadderSeries("KXWC1HSPREAD-26JUL11ARGSUI")?.spec.eventKind).toBe("match_spread");
    expect(lookupLadderSeries("KXWC2HSPREAD-26JUL11ARGSUI")?.spec.eventKind).toBe("match_spread");
    // The widened SPREAD_TITLE_RX admits the trailing "in the 1st/2nd Half".
    expect(parseSpreadTitle("Argentina wins by more than 1.5 goals in the 1st Half?"))
      .toEqual({ team: "Argentina", value: 1.5 });
    expect(parseSpreadTitle("Switzerland wins by more than 1.5 goals in the 2nd Half?"))
      .toEqual({ team: "Switzerland", value: 1.5 });
    // extractSpreadFixture still pulls the opponent from the 1H rules.
    const fx = extractSpreadFixture({
      title: "Argentina wins by more than 1.5 goals in the 1st Half?",
      rules_primary: "If Argentina win by more than 1.5 goals in the 1st Half of the Argentina vs Switzerland professional FIFA World Cup soccer game originally scheduled for Jul 11, 2026, then the market resolves to Yes.",
    });
    expect(fx?.team).toBe("Argentina");
    expect(fx?.opponent).toBe("Switzerland");
  });

  test("KXWNBA{1Q,2Q,3Q,4Q,1H,2H}SPREAD are match_spread ladders (basketball, WNBA, points)", () => {
    for (const p of ["KXWNBA1QSPREAD", "KXWNBA2QSPREAD", "KXWNBA3QSPREAD", "KXWNBA4QSPREAD", "KXWNBA1HSPREAD", "KXWNBA2HSPREAD"]) {
      const s = lookupLadderSeries(p + "-26JUL22ATLSEA");
      expect(s?.spec.eventKind).toBe("match_spread");
      expect(s?.spec.subjectGrain).toBe("titleTeam");
      expect(s?.spec.sport).toBe("basketball");
      expect(s?.spec.league).toBe("WNBA");
      expect(s?.spec.unit).toBe("points");
      expect(s?.spec.requireStrikeType).toBe("greater");
    }
  });
  test("period-spread title parses with the INLINE period token (quarter + half)", () => {
    expect(parseSpreadTitle("Atlanta wins 1st Quarter by over 10.5 points?"))
      .toEqual({ team: "Atlanta", value: 10.5 });
    expect(parseSpreadTitle("Seattle wins 4th Quarter by over 1.5 points?"))
      .toEqual({ team: "Seattle", value: 1.5 });
    expect(parseSpreadTitle("Atlanta wins 1st Half by over 10.5 points?"))
      .toEqual({ team: "Atlanta", value: 10.5 });
    expect(parseSpreadTitle("Las Vegas wins 2nd Half by over 5.5 points?"))
      .toEqual({ team: "Las Vegas", value: 5.5 });
  });
  test("period-spread metric_scope stamps per period (quarter / half_1 / half_2), whole-game stays NULL", () => {
    expect(parseMetricScopeFromTitle("Atlanta wins 1st Quarter by over 10.5 points?")).toBe("quarter");
    expect(parseMetricScopeFromTitle("Seattle wins 4th Quarter by over 1.5 points?")).toBe("quarter");
    expect(parseMetricScopeFromTitle("Atlanta wins 1st Half by over 10.5 points?")).toBe("half_1");
    expect(parseMetricScopeFromTitle("Las Vegas wins 2nd Half by over 5.5 points?")).toBe("half_2");
    // whole-game spread carries NO period token → NULL (never fuses with a period row)
    expect(parseMetricScopeFromTitle("Atlanta wins by over 10.5 points?")).toBeNull();
  });
  test("extractSpreadFixture strips the (women's|men's) professional basketball opponent suffix", () => {
    const r = extractSpreadFixture({
      title: "Atlanta wins 1st Quarter by over 10.5 points?",
      rules_primary: "If Atlanta wins the 1st quarter by more than 10.5 points in the Atlanta vs Seattle women's professional basketball game originally scheduled for Jul 22, 2026, then the market resolves to Yes.",
    });
    expect(r?.team).toBe("Atlanta");
    expect(r?.opponent).toBe("Seattle"); // NOT "Seattle women's"
    expect(r?.value).toBe(10.5);
    // men's league variant strips identically
    const m = extractSpreadFixture({
      title: "Atlanta wins 1st Quarter by over 10.5 points?",
      rules_primary: "If Atlanta wins the 1st quarter by more than 10.5 points in the Atlanta vs Boston men's professional basketball game.",
    });
    expect(m?.opponent).toBe("Boston");
  });
  test("period-spread yes_sub_title fallback resolves the subject for the 'Will X win the 1H' + 'A vs B:' title shapes", () => {
    // Shape A — title has "win the" (no "wins"), so parseSpreadTitle fails; the
    // favored team is read from the uniform yes_sub_title.
    expect(parseSpreadYstTeam("San Antonio wins the 2H by over 11.5 points")).toEqual({ team: "San Antonio", value: 11.5 });
    expect(parseSpreadYstTeam("Minnesota wins the 1H by over 5.5 points")).toEqual({ team: "Minnesota", value: 5.5 });
    // Shape D — title names both teams via a colon, the yst carries the 1Q..4Q token.
    expect(parseSpreadYstTeam("Toronto wins 4Q by over 3.5 points")).toEqual({ team: "Toronto", value: 3.5 });
    expect(parseSpreadYstTeam("Golden State wins 3Q by over 1.5 points")).toEqual({ team: "Golden State", value: 1.5 });
    // non-period yst / empty → null (fallback never hijacks a normal spread)
    expect(parseSpreadYstTeam("Tottenham wins by over 2.5 goals")).toBeNull();
    expect(parseSpreadYstTeam(null)).toBeNull();
  });
  test("extractSpreadFixture 'Will X win the 2H' shape: subject from yst, opponent from rules (no gender suffix here)", () => {
    const r = extractSpreadFixture({
      title: "Will San Antonio win the 2H by over 11.5 points?",
      yes_sub_title: "San Antonio wins the 2H by over 11.5 points",
      rules_primary: "If San Antonio wins the 2nd Half by more than 11.5 points in the San Antonio vs Minnesota professional basketball game originally scheduled for May 15",
    });
    expect(r?.team).toBe("San Antonio");
    expect(r?.opponent).toBe("Minnesota");
    expect(parseMetricScopeFromTitle("Will San Antonio win the 2H by over 11.5 points?")).toBe("half_2");
  });
  test("extractSpreadFixture 'A vs B: 4th Quarter' shape: subject from yst, opponent = the OTHER fixture side (gender stripped)", () => {
    const r = extractSpreadFixture({
      title: "Dallas vs Toronto: 4th Quarter by over 3.5 points?",
      yes_sub_title: "Toronto wins 4Q by over 3.5 points",
      rules_primary: "If Toronto wins the 4th quarter (excluding overtime) by more than 3.5 points in the Dallas vs Toronto women's professional basketball game originally scheduled for Jul 22, 2026",
    });
    expect(r?.team).toBe("Toronto");
    expect(r?.opponent).toBe("Dallas"); // NOT polluted; oriented to the non-subject side
    expect(parseMetricScopeFromTitle("Dallas vs Toronto: 4th Quarter by over 3.5 points?")).toBe("quarter");
  });
  test("whole-game spread + soccer 'wins by more than N goals' are NOT affected by the period/strip widening (no regression)", () => {
    // whole-game basketball spread — no period, opponent unpolluted
    expect(parseSpreadTitle("Minnesota wins by over 15.5 points?")).toEqual({ team: "Minnesota", value: 15.5 });
    // soccer more-than verb still parses + orients opponent cleanly
    const r = extractSpreadFixture({
      title: "Tottenham wins by over 2.5 goals?",
      rules_primary: "If Tottenham wins by more than 2.5 goals in the Tottenham vs Leeds United professional EPL soccer game originally scheduled for May",
    });
    expect(r?.team).toBe("Tottenham");
    expect(r?.opponent).toBe("Leeds United"); // multi-word team name NOT truncated
  });
});

describe("hw821 round-3 — WC 1st-half correct score parameterization", () => {
  test("lookupSoccerCorrectScoreSeries: full-time NULL scope, 1H half_1 + period suffix", () => {
    const ft = lookupSoccerCorrectScoreSeries("KXWCSCORE-26JUL14FRAESP");
    expect(ft?.spec.scope).toBeNull();
    expect(ft?.spec.canonicalSuffix).toBe("");
    const h1 = lookupSoccerCorrectScoreSeries("KXWC1HSCORE-26JUL14FRAESP");
    expect(h1?.spec.scope).toBe("half_1");
    expect(h1?.spec.canonicalSuffix).toBe(" 1st half");
    expect(lookupSoccerCorrectScoreSeries("KXNBAGAME-1")).toBeNull();
  });
  test("parseSoccerCorrectScore reads the 1H title inner + event_title fixture (away winner orientation)", () => {
    // France vs Spain: Spain (AWAY) wins 2-0 at half → home_goals=0, away_goals=2.
    const p = parseSoccerCorrectScore({
      event_title: "France vs Spain: 1st Half Correct Score",
      title: "Will the 1st half score be Spain wins 2-0?",
      yes_sub_title: "Spain wins 1H 2-0",
      custom_strike: JSON.stringify({ home_score: "0", away_score: "2" }),
    });
    expect(p).toEqual({ home: "France", away: "Spain", homeGoals: 0, awayGoals: 2, isDraw: false });
  });
  test("parseSoccerCorrectScore reads a 1H draw", () => {
    const p = parseSoccerCorrectScore({
      event_title: "Argentina vs Switzerland: 1st Half Correct Score",
      title: "Will the 1st half score be Draw 1-1?",
      yes_sub_title: "Draw 1H 1-1",
      custom_strike: JSON.stringify({ home_score: "1", away_score: "1" }),
    });
    expect(p).toEqual({ home: "Argentina", away: "Switzerland", homeGoals: 1, awayGoals: 1, isDraw: true });
  });
  test("full-time correct score still parses (no regression)", () => {
    const p = parseSoccerCorrectScore({
      event_title: "Spain vs Belgium: Regulation Time Correct Score",
      title: "Will the final score be Spain wins 1-0?",
      yes_sub_title: "Reg Time: Spain wins 1-0",
      custom_strike: JSON.stringify({ home_score: "1", away_score: "0" }),
    });
    expect(p).toEqual({ home: "Spain", away: "Belgium", homeGoals: 1, awayGoals: 0, isDraw: false });
  });
});

// Domestic/continental correct-score families (KXMLSSCORE / KXUECLSCORE /
// KXUELSCORE / KXBRASILEIROSCORE / KXLIGAMXSCORE). Real title forms pulled
// from the live DB — the per-market yes_sub_title carries no "Reg Time:"
// prefix on the domestic families (MLS/UECL/Brasileiro/LigaMX), so the inner
// scoreline is sourced from the title; KXUEL/KXUECL do carry it.
describe("exact-score root fix — domestic/continental soccer correct-score onboarding", () => {
  test("lookupSoccerCorrectScoreSeries: all five families registered, full-time NULL scope + bare suffix", () => {
    for (const prefix of ["KXMLSSCORE", "KXUECLSCORE", "KXUELSCORE", "KXBRASILEIROSCORE", "KXLIGAMXSCORE"]) {
      const hit = lookupSoccerCorrectScoreSeries(`${prefix}-26JUL22COLSD`);
      expect(hit?.prefix).toBe(prefix);
      expect(hit?.spec.scope).toBeNull();          // folds with PM Template Z
      expect(hit?.spec.canonicalSuffix).toBe("");  // bare "<A> vs B" canonical_event
    }
  });

  test("KXMLSSCORE home winner — 'Will the final score be <home> wins A-B?' (title-sourced inner)", () => {
    // San Diego FC (HOME) wins 4-0. yes_sub_title has no "Reg Time:" prefix → title.
    const p = parseSoccerCorrectScore({
      event_title: "San Diego FC vs Colorado Rapids: Correct Score",
      title: "Will the final score be San Diego FC wins 4-0?",
      yes_sub_title: "San Diego FC wins 4-0",
      custom_strike: JSON.stringify({ home_score: "4", away_score: "0", home_team_id: "h", away_team_id: "a" }),
    });
    expect(p).toEqual({ home: "San Diego FC", away: "Colorado Rapids", homeGoals: 4, awayGoals: 0, isDraw: false });
  });

  test("KXMLSSCORE draw — 'Draw A-A' (level, custom_strike cross-checked)", () => {
    const p = parseSoccerCorrectScore({
      event_title: "Portland Timbers vs FC Dallas: Correct Score",
      title: "Will the final score be Draw 3-3?",
      yes_sub_title: "Draw 3-3",
      custom_strike: JSON.stringify({ home_score: "3", away_score: "3" }),
    });
    expect(p).toEqual({ home: "Portland Timbers", away: "FC Dallas", homeGoals: 3, awayGoals: 3, isDraw: true });
  });

  test("KXUELSCORE AWAY winner + 'Reg Time:' yst + 'Regulation Time Correct Score' event_title", () => {
    // PAOK is the AWAY team (away_score=3) and wins 3-1 → home_goals=1, away_goals=3.
    const p = parseSoccerCorrectScore({
      event_title: "FC Dynamo Kyiv vs PAOK Thessaloniki: Regulation Time Correct Score",
      title: "Will the final score be PAOK Thessaloniki wins 3-1?",
      yes_sub_title: "Reg Time: PAOK Thessaloniki wins 3-1",
      custom_strike: JSON.stringify({ home_score: "1", away_score: "3" }),
    });
    expect(p).toEqual({ home: "FC Dynamo Kyiv", away: "PAOK Thessaloniki", homeGoals: 1, awayGoals: 3, isDraw: false });
  });

  test("multi-digit scoreline parses (regex is \\d+, not \\d) — synthetic 10-0 rout", () => {
    const p = parseSoccerCorrectScore({
      event_title: "Tigres UANL vs Club Leon: Correct Score",
      title: "Will the final score be Tigres UANL wins 10-0?",
      yes_sub_title: "Tigres UANL wins 10-0",
      custom_strike: JSON.stringify({ home_score: "10", away_score: "0" }),
    });
    expect(p).toEqual({ home: "Tigres UANL", away: "Club Leon", homeGoals: 10, awayGoals: 0, isDraw: false });
  });

  test("custom_strike disagreement with title scoreline → bail (unshaped beats mis-oriented)", () => {
    expect(parseSoccerCorrectScore({
      event_title: "Santos FC SP vs Chapecoense SC: Correct Score",
      title: "Will the final score be Santos FC SP wins 3-2?",
      yes_sub_title: "Santos FC SP wins 3-2",
      custom_strike: JSON.stringify({ home_score: "2", away_score: "1" }), // byte anomaly
    })).toBeNull();
  });

  test("looksCorrectScoreLabel: scoreline forms TRUE (incl. playoff-series), bare/ladder/grade FALSE", () => {
    // correct-score + playoff-series scoreline native labels → winner-projectable fakes
    expect(looksCorrectScoreLabel("San Diego FC wins 4-0")).toBe(true);
    expect(looksCorrectScoreLabel("Draw 0-0")).toBe(true);
    expect(looksCorrectScoreLabel("DET wins 4-3")).toBe(true);          // NBA series score
    expect(looksCorrectScoreLabel("Montreal Canadiens wins 4-2")).toBe(true);
    // NOT scorelines → never refused
    expect(looksCorrectScoreLabel("San Diego FC")).toBe(false);         // bare winner (moneyline)
    expect(looksCorrectScoreLabel("Draw")).toBe(false);
    expect(looksCorrectScoreLabel("Bogey or worse")).toBe(false);       // KXPGAHOLESCORE grade
    expect(looksCorrectScoreLabel("-16 or better")).toBe(false);        // KXPGAWINNINGSCORE ladder
    expect(looksCorrectScoreLabel(null)).toBe(false);
  });
});

describe("AUD-11 golf round-score — per-player INDEPENDENT stroke ladder", () => {
  test("parseGolfRoundScore reads player + round from yes_sub_title (preferred)", () => {
    expect(parseGolfRoundScore({ title: "Will Zach Haynes shoot under 75.5 in Round 1?", yes_sub_title: "R1: Zach Haynes under 75.5 strokes" }))
      .toEqual({ player: "Zach Haynes", round: 1 });
  });
  test("parseGolfRoundScore falls back to the title when yes_sub_title is missing", () => {
    expect(parseGolfRoundScore({ title: "Will Xander Schauffele shoot under 69.5 in Round 1?", yes_sub_title: null }))
      .toEqual({ player: "Xander Schauffele", round: 1 });
  });
  test("parseGolfRoundScore rejects non-round titles", () => {
    expect(parseGolfRoundScore({ title: "PGA Championship: Will Tiger Woods make the cut?", yes_sub_title: null })).toBeNull();
  });
  test("LADDER_SERIES golf row is player_prop_threshold (INDEPENDENT), person grain", () => {
    const g = lookupLadderSeries("KXPGAROUNDSCORE-PGC26R1");
    expect(g?.spec.eventKind).toBe("player_prop_threshold");
    expect(g?.spec.subjectGrain).toBe("yesSubTitlePerson");
    expect(g?.spec.sport).toBe("golf");
  });
});

describe("WKR-2 music-units — per-instance subject (MANDATORY, no fake hub)", () => {
  test("extractMusicUnitsSubject keeps the WHOLE 'Album by Artist' so albums stay distinct", () => {
    expect(extractMusicUnitsSubject("Will BROWN by Chris Brown have above 80000 Album Equivalent Units on Luminate during May 08, 2026 - May 14, 2026?"))
      .toBe("BROWN by Chris Brown");
    expect(extractMusicUnitsSubject("Will Starboy by The Weeknd have above 71,438,906 Streams on Luminate from May 08 - May 14?"))
      .toBe("Starboy by The Weeknd");
  });
  test("extractMusicUnitsSubject reads the bare-artist streams form", () => {
    expect(extractMusicUnitsSubject("Will BTS have 491000000 Streams on Luminate during May 08 - May 14, 2026?")).toBe("BTS");
    expect(extractMusicUnitsSubject("Will Iceman have at least 90,000 Pure Album Sales on the Hits Daily Double Top 50 Chart for the week immediately following the wide release of Iceman?"))
      .toBe("Iceman");
  });
  test("LADDER_SERIES music rows are media_release + titleSubject (NEVER categorical)", () => {
    for (const t of ["KXARTISTSTREAMS-BTS26MAY14", "KXALBUMEQUIV-BRO26MAY14", "KXALBUMSTREAMSU-STARBWEEKND26MAY14"]) {
      const m = lookupLadderSeries(t);
      expect(m?.spec.eventKind).toBe("media_release");
      expect(m?.spec.subjectGrain).toBe("titleSubject");
      expect(m?.spec.metric).toBe("count");
    }
  });
  test("KXARTISTSTREAMSY (the historical fake-hub series) is NOT routed here", () => {
    expect(lookupLadderSeries("KXARTISTSTREAMSY-BIGGIE26")).toBeNull();
  });
});

describe("WKR-5 KXRT Rotten-Tomatoes — EXACT prefix TRAP gate", () => {
  test("extractRottenTomatoesSubject reads the movie", () => {
    expect(extractRottenTomatoesSubject("Scary Movie Rotten Tomatoes score?")).toBe("Scary Movie");
    expect(extractRottenTomatoesSubject("Supergirl Rotten Tomatoes score?")).toBe("Supergirl");
  });
  test("isExactRottenTomatoesSeries: KXRT yes; KXRTX5090MON / KXRTICKET TRAPS NO", () => {
    expect(isExactRottenTomatoesSeries("KXRT-SCA")).toBe(true);
    expect(isExactRottenTomatoesSeries("KXRTX5090MON-26MAY31")).toBe(false);
    expect(isExactRottenTomatoesSeries("KXRTICKET-28NOV07")).toBe(false);
    expect(isExactRottenTomatoesSeries("KXRTX5090W")).toBe(false);
  });
  test("lookupLadderSeries KXRT resolves; the TRAPS do NOT cross-archetype", () => {
    expect(lookupLadderSeries("KXRT-SCA")?.spec.eventKind).toBe("media_release");
    expect(lookupLadderSeries("KXRTX5090MON-26MAY31")).toBeNull();
    expect(lookupLadderSeries("KXRTICKET-28NOV07")).toBeNull();
  });
});

describe("WKR-3 soccer-1H — Tie residual present (finalize MAY make Sum=1)", () => {
  test("extractSoccer1HFixture pulls the fixture {a,b} from rules", () => {
    expect(extractSoccer1HFixture("If Manchester City is the winner of the first half in the Manchester City vs Crystal Palace professional EPL soccer game"))
      .toEqual({ a: "Manchester City", b: "Crystal Palace" });
    expect(extractSoccer1HFixture("If Tie is the result of the first half in the Bilbao vs Celta Vigo professional La Liga soccer game originally scheduled"))
      .toEqual({ a: "Bilbao", b: "Celta Vigo" });
  });
  test("WINNER_SERIES soccer-1H rows: halftime_leader + half_1 + Tie residualRX", () => {
    for (const t of ["KXEPL1H-26MAY13MCICRY", "KXLALIGA1H-26MAY17ATHRCC", "KXUCL1H-26X"]) {
      const w = lookupWinnerSeries(t);
      expect(w?.spec.eventKind).toBe("halftime_leader");
      expect(w?.spec.metricScope).toBe("half_1");
      expect(w?.spec.residualRX).not.toBeNull();
      expect(w?.spec.residualRX?.test("Tie")).toBe(true);
      expect(w?.spec.residualRX?.test("Manchester City")).toBe(false);
      expect(w?.spec.eventFrom).toBe("fixture");
    }
  });
});

describe("WKR-6 NASCAR/cycling — NO residual (mutex Sum<=1)", () => {
  test("extractMotorsportEvent reads the per-instance RACE/event from the title", () => {
    expect(extractMotorsportEvent("Will Zane Smith be the Go Bowling at The Glen Winner?")).toBe("Go Bowling at The Glen");
    expect(extractMotorsportEvent("Will Zane Smith be the NASCAR Cup Series Champion?")).toBe("NASCAR Cup Series");
    expect(extractMotorsportEvent("Will Josh Kench win the 2026 Giro d" + APOS + "Italia?")).toBe("2026 Giro d" + APOS + "Italia");
  });
  test("WINNER_SERIES motorsport rows: championship_winner + residualRX=null", () => {
    for (const t of ["KXNASCARRACE-GOBAT26", "KXNASCARCUPSERIES-NCS26", "KXCYCLING-26GIRO"]) {
      const w = lookupWinnerSeries(t);
      expect(w?.spec.eventKind).toBe("championship_winner");
      expect(w?.spec.residualRX).toBeNull();
      expect(w?.spec.metricScope).toBeNull();
      expect(w?.spec.eventFrom).toBe("titleEvent");
    }
  });
});

describe("B-20 eventTitle categorical winners (golf/nascar/awards)", () => {
  test("golf/nascar winner rows: championship_winner + eventTitle + no residual", () => {
    for (const t of ["KXKFTOUR-COLCC26", "KXPGAPLAYERCAT-PGC26EUR", "KXNASCARFASTLAP-BET26"]) {
      const w = lookupWinnerSeries(t);
      expect(w?.spec.eventKind).toBe("championship_winner");
      expect(w?.spec.eventFrom).toBe("eventTitle");
      expect(w?.spec.subjectType).toBe("person");
      expect(w?.spec.residualRX).toBeNull();
      expect(w?.spec.subjectCategory).toBe("sports");
    }
  });
  test("golf winner sports: KFTOUR/PLAYERCAT golf, NASCARFASTLAP motorsport", () => {
    expect(lookupWinnerSeries("KXKFTOUR-COLCC26")?.spec.sport).toBe("golf");
    expect(lookupWinnerSeries("KXPGAPLAYERCAT-PGC26EUR")?.spec.sport).toBe("golf");
    expect(lookupWinnerSeries("KXNASCARFASTLAP-BET26")?.spec.sport).toBe("motorsport");
  });
  test("award winners: award_winner kind + tie/co-winners residual (never a KB entity)", () => {
    const wc = lookupWinnerSeries("KXWCAWARD-26GBALL");
    expect(wc?.spec.eventKind).toBe("award_winner");
    expect(wc?.spec.subjectType).toBe("person");
    expect(wc?.spec.sport).toBe("soccer");
    expect(wc?.spec.eventFrom).toBe("eventTitle");
    const tony = lookupWinnerSeries("KXTONYAWARDS-26BACT");
    expect(tony?.spec.eventKind).toBe("award_winner");
    expect(tony?.spec.subjectType).toBe("event_name");
    expect(tony?.spec.subjectCategory).toBe("entertainment");
    // residual placeholder outcomes stay literal
    for (const w of [wc, tony]) {
      expect(w?.spec.residualRX?.test("Tie")).toBe(true);
      expect(w?.spec.residualRX?.test("Tie/Co-Winners")).toBe(true);
      expect(w?.spec.residualRX?.test("Co-Winners")).toBe(true);
      // real nominees/players are NOT residual
      expect(w?.spec.residualRX?.test("Neymar")).toBe(false);
      expect(w?.spec.residualRX?.test("Carrie Coon")).toBe(false);
    }
  });
});

// All prefixes verified live against kalshi_events.
describe("hw821-A eventTitle winner rows (cycling / LPGA / MLB awards / AP-rank / couples)", () => {
  test("cycling stage + jersey: championship_winner, person, cycling, NO residual", () => {
    for (const t of ["KXCYCLINGSTAGE-26TDFRSTAGE18", "KXCYCLINGJERSEY-26TDFRPOLKADOT"]) {
      const w = lookupWinnerSeries(t);
      expect(w?.spec.eventKind).toBe("championship_winner");
      expect(w?.spec.subjectType).toBe("person");
      expect(w?.spec.sport).toBe("cycling");
      expect(w?.spec.eventFrom).toBe("eventTitle");
      expect(w?.spec.residualRX).toBeNull(); // no Tie slot → stays Σ≤1
    }
    // MUST NOT collide with the existing KXCYCLING (motorsport) row — disjoint prefix.
    expect(lookupWinnerSeries("KXCYCLING-26GIRO")?.spec.sport).toBe("motorsport");
  });
  test("LPGA round leaders: championship_winner golf, NO residual (Σ≤1)", () => {
    for (const t of ["KXLPGAR2LEAD-THEAEC26", "KXLPGAR3LEAD-THEAEC26"]) {
      const w = lookupWinnerSeries(t);
      expect(w?.spec.eventKind).toBe("championship_winner");
      expect(w?.spec.sport).toBe("golf");
      expect(w?.spec.subjectType).toBe("person");
      expect(w?.spec.residualRX).toBeNull();
    }
  });
  test("MLB Gold Glove / Silver Slugger: award_winner, event_name (mixed person/team grain), Tie/Co-Winners residual", () => {
    for (const t of ["KXMLBGG-26NLTEAM", "KXMLBSS-26NLTEAM"]) {
      const w = lookupWinnerSeries(t);
      expect(w?.spec.eventKind).toBe("award_winner");
      expect(w?.spec.subjectType).toBe("event_name"); // Team award = team, position award = person
      expect(w?.spec.sport).toBe("baseball");
      // real residual slot present
      expect(w?.spec.residualRX?.test("Tie/Co-Winners")).toBe(true);
      expect(w?.spec.residualRX?.test("Co-Winners")).toBe(true);
      expect(w?.spec.residualRX?.test("Atlanta")).toBe(false);      // real team not residual
      expect(w?.spec.residualRX?.test("Elly De La Cruz")).toBe(false); // real player not residual
    }
  });
  test("NCAA AP-rank (M/W basketball, football): championship_winner team, sport-scoped, NO residual", () => {
    expect(lookupWinnerSeries("KXNCAAMBAPRANK-26W1R1")?.spec.sport).toBe("basketball (ncaa)");
    expect(lookupWinnerSeries("KXNCAAWBAPRANK-27W10R1")?.spec.sport).toBe("basketball (ncaa)");
    expect(lookupWinnerSeries("KXNCAAFAPRANK-26W1R1")?.spec.sport).toBe("american football (ncaa)");
    for (const t of ["KXNCAAMBAPRANK-26W1R1", "KXNCAAWBAPRANK-27W10R1", "KXNCAAFAPRANK-26W1R1"]) {
      const w = lookupWinnerSeries(t);
      expect(w?.spec.eventKind).toBe("championship_winner"); // ∈ RANK_GRAIN_KINDS → rank_grain='1'
      expect(w?.spec.subjectType).toBe("team");
      expect(w?.spec.league).toBeNull(); // sport-only; a league would mis-scope M vs W
      expect(w?.spec.residualRX).toBeNull();
    }
  });
  test("NFL Top 100 (#N ranked player): award_winner person, NO residual", () => {
    const w = lookupWinnerSeries("KXNFLT100-26R1");
    expect(w?.spec.eventKind).toBe("award_winner");
    expect(w?.spec.subjectType).toBe("person");
    expect(w?.spec.sport).toBe("american football");
    expect(w?.spec.residualRX).toBeNull();
  });
  test("Starting QB Week 1: subject = the QB (person), event_kind 'other' (role designation off winner joins)", () => {
    const w = lookupWinnerSeries("KXSTARTINGQBWEEK1-W1-26SEP15-LV");
    expect(w?.spec.eventKind).toBe("other");
    expect(w?.spec.subjectType).toBe("person");
    expect(w?.spec.eventFrom).toBe("eventTitle"); // per-team partition lives in event_title
    expect(w?.spec.residualRX).toBeNull();
  });
  test("Love Island winning couple: championship_winner, event_name subject, entertainment, NO residual", () => {
    for (const t of ["KXLIUKCOUPLE-26AUG31", "KXLIUSACOUPLE-26AUG31"]) {
      const w = lookupWinnerSeries(t);
      expect(w?.spec.eventKind).toBe("championship_winner");
      expect(w?.spec.subjectType).toBe("event_name"); // a couple is neither person nor team
      expect(w?.spec.subjectCategory).toBe("entertainment");
      expect(w?.spec.residualRX).toBeNull();
    }
  });
  test("registry hygiene: all new winner prefixes disjoint from ladder/draft", () => {
    for (const p of ["KXCYCLINGSTAGE", "KXCYCLINGJERSEY", "KXLPGAR2LEAD", "KXLPGAR3LEAD",
                     "KXMLBGG", "KXMLBSS", "KXNCAAMBAPRANK", "KXNCAAWBAPRANK", "KXNCAAFAPRANK",
                     "KXNFLT100", "KXSTARTINGQBWEEK1", "KXLIUKCOUPLE", "KXLIUSACOUPLE"]) {
      expect(WINNER_SERIES[p]).toBeDefined();
      expect(LADDER_SERIES[p]).toBeUndefined();
      expect(DRAFT_SERIES[p]).toBeUndefined();
    }
  });
});

describe("AUD-12 draft — per-pick grain + non-integer round-form bail", () => {
  test("parseDraftPickNumber: integer suffix -> N; non-integer (round-form) -> null", () => {
    expect(parseDraftPickNumber("KXNBADRAFTPICK-26-15")).toBe(15);
    expect(parseDraftPickNumber("KXMLBDRAFTPICK-26-5")).toBe(5);
    expect(parseDraftPickNumber("KXNFLDRAFTPICK-27-1")).toBe(1);
    expect(parseDraftPickNumber("KXNBADRAFTTOP-26-R1")).toBeNull();
    expect(parseDraftPickNumber("KXNBADRAFTPICK-26-0")).toBeNull();
    expect(parseDraftPickNumber(null)).toBeNull();
  });
  test("parseDraftYear: middle segment -> year; 1ST single-segment falls back to last", () => {
    expect(parseDraftYear("KXNBADRAFTPICK-26-15")).toBe(2026);
    expect(parseDraftYear("KXNFLDRAFTPICK-27-1")).toBe(2027);
    expect(parseDraftYear("KXNFLDRAFT1ST-27")).toBe(2027);
  });
  test("draftCanonicalEvent: per-pick event carries the pick N (PICK branch)", () => {
    expect(draftCanonicalEvent(DRAFT_SERIES.KXNBADRAFTPICK, 2026, 10, null)).toBe("2026 NBA draft pick 10");
    expect(draftCanonicalEvent(DRAFT_SERIES.KXMLBDRAFTPICK, 2026, 5, null)).toBe("2026 MLB draft pick 5");
  });
  test("draftCanonicalEvent: TEAM branch keyed on player; 1ST branch fixed", () => {
    expect(draftCanonicalEvent(DRAFT_SERIES.KXNBADRAFTTEAM, 2026, null, "Aday Mara")).toBe("2026 NBA draft destination: aday mara");
    expect(draftCanonicalEvent(DRAFT_SERIES.KXNFLDRAFT1ST, 2027, null, null)).toBe("2027 NFL draft 1st overall pick");
  });
  test("lookupDraftSeries: PICK/TEAM/1ST routed; TOP/MATCHUP/COMP/CAT EXCLUDED (deferred)", () => {
    expect(lookupDraftSeries("KXNBADRAFTPICK-26-15")?.spec.branch).toBe("pick");
    expect(lookupDraftSeries("KXNBADRAFTTEAM-26AMAR")?.spec.branch).toBe("team");
    expect(lookupDraftSeries("KXNFLDRAFT1ST-27")?.spec.branch).toBe("1st");
    expect(lookupDraftSeries("KXNBADRAFT1-26")?.spec.slotType).toBe("player");
    expect(lookupDraftSeries("KXNBADRAFTTOP-26-R1")).toBeNull();
    expect(lookupDraftSeries("KXNBADRAFTMATCHUP-26")).toBeNull();
    expect(lookupDraftSeries("KXNBADRAFTCAT-26")).toBeNull();
  });
});

describe("registry hygiene — archetype/lookup isolation", () => {
  test("a ladder prefix is not also a winner/draft prefix and vice versa", () => {
    for (const p of Object.keys(LADDER_SERIES)) {
      expect(WINNER_SERIES[p]).toBeUndefined();
      expect(DRAFT_SERIES[p]).toBeUndefined();
    }
    for (const p of Object.keys(WINNER_SERIES)) expect(DRAFT_SERIES[p]).toBeUndefined();
  });
  test("lookups return null for an unknown / null ticker", () => {
    expect(lookupLadderSeries(null)).toBeNull();
    expect(lookupWinnerSeries("KXUNKNOWN-1")).toBeNull();
    expect(lookupDraftSeries(null)).toBeNull();
  });
});

// WS2 Class-A families — pure parsers on real captured rows. All
// titles/strikes copied verbatim from the live DB.

describe("WS2-1 AWARD winners (KXAMA / …)", () => {
  test("lookup gates on the prefix only", () => {
    expect(lookupAwardSeries("KXAMA-26-BCA")).toMatchObject({ prefix: "KXAMA" });
    expect(lookupAwardSeries("KXSPORTSEMMY-26-X")).toMatchObject({ prefix: "KXSPORTSEMMY" });
    // KXTONYAWARDS lives in WINNER_SERIES (eventTitle mode), not
    // AWARD_SERIES (disjoint-registry invariant).
    expect(lookupAwardSeries("KXTONYAWARDS-26-X")).toBeNull();
    expect(lookupWinnerSeries("KXTONYAWARDS-26BACT")?.spec.eventKind).toBe("award_winner");
    expect(lookupAwardSeries("KXNBADRAFTTOP-26-10")).toBeNull();
    expect(lookupAwardSeries(null)).toBeNull();
  });
  test("parses year + category from the live title shapes", () => {
    expect(parseAwardTitle("2026 American Music Award for Best Country Album?"))
      .toEqual({ year: 2026, category: "Best Country Album" });
    expect(parseAwardTitle("2026 American Music Award for Collaboration of the Year?"))
      .toEqual({ year: 2026, category: "Collaboration of the Year" });
    expect(parseAwardTitle("2026 American Music Award for Song of the summer?"))
      .toEqual({ year: 2026, category: "Song of the summer" });
  });
  test("non-award title → null", () => {
    expect(parseAwardTitle("Pro basketball top 10 draft picks in 2026?")).toBeNull();
  });
  test("Tie nominee is detected (kept off real-entity resolution)", () => {
    expect(isAwardTieNominee("Tie")).toBe(true);
    expect(isAwardTieNominee("tie ")).toBe(true);
    expect(isAwardTieNominee("Taylor Swift")).toBe(false);
    expect(isAwardTieNominee(null)).toBe(false);
  });
  test("canonical_event folds year+award+category (lowercased)", () => {
    expect(awardCanonicalEvent(2026, "american music award", "Best Pop Song"))
      .toBe("2026 american music award best pop song");
  });
  test("registry hygiene — award prefixes disjoint from ladder/winner/draft", () => {
    for (const p of Object.keys(AWARD_SERIES)) {
      expect(LADDER_SERIES[p]).toBeUndefined();
      expect(WINNER_SERIES[p]).toBeUndefined();
      expect(DRAFT_SERIES[p]).toBeUndefined();
      expect(DRAFT_TOPN_SERIES[p]).toBeUndefined();
    }
  });
});

describe("WS2-2 GOLF round-leader (KXPGAR{N}LEAD)", () => {
  test("live row: yst player + round match prefix", () => {
    expect(parseGolfRoundLeader("KXPGAR1LEAD-PGC26", {
      title: "Will Shane Lowry lead at the end of Round 1 in the PGA Championship?",
      yes_sub_title: "Shane Lowry",
    })).toEqual({ player: "Shane Lowry", round: 1, tournament: "PGA Championship" });
  });
  test("round in the prefix must agree with the round in the title", () => {
    // KXPGAR2LEAD prefix but a Round-1 title → mismatch → bail (never mis-round).
    expect(parseGolfRoundLeader("KXPGAR2LEAD-PGC26", {
      title: "Will Shane Lowry lead at the end of Round 1 in the PGA Championship?",
      yes_sub_title: "Shane Lowry",
    })).toBeNull();
  });
  test("yst that disagrees with the title player → bail", () => {
    expect(parseGolfRoundLeader("KXPGAR1LEAD-PGC26", {
      title: "Will Shane Lowry lead at the end of Round 1 in the PGA Championship?",
      yes_sub_title: "Rory McIlroy",
    })).toBeNull();
  });
  test("falls back to the title player when yst is empty", () => {
    expect(parseGolfRoundLeader("KXPGAR3LEAD-PGC26", {
      title: "Will Kota Kaneko lead at the end of Round 3 in the PGA Championship?",
      yes_sub_title: null,
    })).toEqual({ player: "Kota Kaneko", round: 3, tournament: "PGA Championship" });
  });
  test("non-leader prefix → null", () => {
    expect(parseGolfRoundLeader("KXPGAROUNDSCORE-PGC26", {
      title: "Will Shane Lowry lead at the end of Round 1 in the PGA Championship?",
      yes_sub_title: "Shane Lowry",
    })).toBeNull();
  });
  test("round-scoped canonical_event keeps rounds disjoint", () => {
    expect(golfRoundLeaderCanonicalEvent(2026, "PGA Championship", 1))
      .toBe("2026 pga championship round 1 leader");
    expect(golfRoundLeaderCanonicalEvent(2026, "PGA Championship", 2))
      .toBe("2026 pga championship round 2 leader");
  });
});

describe("WS2-3 DRAFT top-N (KXNBADRAFTTOP / KXMLBDRAFTTOP)", () => {
  test("lookup gates on the prefix", () => {
    expect(lookupDraftTopNSeries("KXNBADRAFTTOP-26-10")).toMatchObject({ prefix: "KXNBADRAFTTOP" });
    expect(lookupDraftTopNSeries("KXMLBDRAFTTOP-26-5")).toMatchObject({ prefix: "KXMLBDRAFTTOP" });
    expect(lookupDraftTopNSeries("KXNBADRAFTPICK-26-1")).toBeNull();
  });
  test("field-title 'top N draft picks' + yst player → rank threshold", () => {
    expect(parseDraftTopN("KXNBADRAFTTOP-26-10", {
      title: "Pro basketball top 10 draft picks in 2026?",
      yes_sub_title: "Darryn Peterson",
    })).toEqual({ kind: "rank_threshold", rankN: 10, year: 2026, player: "Darryn Peterson" });
  });
  test("per-player 'top 15 draft pick' title → rank threshold", () => {
    expect(parseDraftTopN("KXNBADRAFTTOP-26-15", {
      title: "Will Aday Mara be a top 15 draft pick in 2026?",
      yes_sub_title: "Aday Mara",
    })).toEqual({ kind: "rank_threshold", rankN: 15, year: 2026, player: "Aday Mara" });
  });
  test("'1st Round draft pick' → distinct first_round rung (never folds to a numeric rank)", () => {
    expect(parseDraftTopN("KXNBADRAFTTOP-26-R1", {
      title: "Will Nate Ament be a 1st Round draft pick in 2026?",
      yes_sub_title: "Nate Ament",
    })).toEqual({ kind: "first_round", year: 2026, player: "Nate Ament" });
  });
  test("missing yes_sub_title → null (player always from yst)", () => {
    expect(parseDraftTopN("KXNBADRAFTTOP-26-10", {
      title: "Pro basketball top 10 draft picks in 2026?",
      yes_sub_title: null,
    })).toBeNull();
  });
  test("canonical_event is the draft (per-player rungs share it)", () => {
    expect(draftTopNCanonicalEvent(2026, "NBA")).toBe("2026 nba draft");
  });
});

describe("WS2-4 STATEWIDE turnout (KXMIDTERMVOTETURN, no district)", () => {
  test("Senate statewide → senate subject", () => {
    expect(parseMidtermVoteTurnStatewide(
      "Will the total vote count for all participants in Rhode Island Senate General Election be above 520000?",
    )).toEqual({ state: "Rhode Island", chamber: "senate", subjectRaw: "Rhode Island senate race" });
  });
  test("Governor statewide → governor subject", () => {
    expect(parseMidtermVoteTurnStatewide(
      "Will the total vote count for all participants in Idaho Governor General Election be above 710000?",
    )).toEqual({ state: "Idaho", chamber: "governor", subjectRaw: "Idaho governor race" });
  });
  test("multi-word state captured fully", () => {
    expect(parseMidtermVoteTurnStatewide(
      "Will the total vote count for all participants in West Virginia Senate General Election be above 830000?",
    )?.state).toBe("West Virginia");
  });
  test("per-district title (with a district number) is NOT matched here", () => {
    expect(parseMidtermVoteTurnStatewide(
      "Will the total vote count for all participants in California 03 House General Election be above 400000?",
    )).toBeNull();
  });
});

describe("WS2-5 PRIMARY advance (KXCAPRIMARY top-two)", () => {
  test("live 'advance' title → candidate/year/district", () => {
    expect(parsePrimaryAdvance("Will Laura Koscki advance in the 2026 CA-03 primary?"))
      .toEqual({ candidate: "Laura Koscki", year: 2026, district: "CA-03" });
    expect(parsePrimaryAdvance("Will Ami Bera advance in the 2026 CA-03 primary?"))
      .toEqual({ candidate: "Ami Bera", year: 2026, district: "CA-03" });
  });
  test("'Who will advance' field/header row → null", () => {
    expect(parsePrimaryAdvance("Who will advance in the 2026 CA-48 primary?")).toBeNull();
  });
  test("'place first' title is NOT claimed here (own handler)", () => {
    expect(parsePrimaryAdvance("Will Ami Bera place first in the 2026 CA-03 primary?")).toBeNull();
  });
  test("canonical_event folds year+district+party", () => {
    expect(primaryAdvanceCanonicalEvent(2026, "CA-03", "Republican")).toBe("2026 ca-03 republican primary");
    expect(primaryAdvanceCanonicalEvent(2026, "CA-37", null)).toBe("2026 ca-37 primary");
  });
});

describe("WS2-6 CENTRAL-BANK rate decision (KXFEDDECISION)", () => {
  test("Hike 0bps → maintain (signed bps 0)", () => {
    expect(parseFedDecision("Will the Federal Reserve Hike rates by 0bps at their June 2027 meeting?"))
      .toEqual({ action: "maintain", bps: 0, isStrictGreater: false, month: "June", year: 2027 });
  });
  test("Cut 25bps → negative signed bps", () => {
    expect(parseFedDecision("Will the Federal Reserve Cut rates by 25bps at their March 2027 meeting?"))
      .toEqual({ action: "cut", bps: -25, isStrictGreater: false, month: "March", year: 2027 });
  });
  test("Hike 25bps → positive signed bps", () => {
    expect(parseFedDecision("Will the Federal Reserve Hike rates by 25bps at their June 2026 meeting?"))
      .toEqual({ action: "hike", bps: 25, isStrictGreater: false, month: "June", year: 2026 });
  });
  test("'>25bps' captures the strict-greater flag", () => {
    expect(parseFedDecision("Will the Federal Reserve Cut rates by >25bps at their December 2027 meeting?"))
      .toEqual({ action: "cut", bps: -25, isStrictGreater: true, month: "December", year: 2027 });
  });
  test("a +25 hike and a -25 cut never produce the same signed bps", () => {
    const hike = parseFedDecision("Will the Federal Reserve Hike rates by 25bps at their June 2026 meeting?");
    const cut = parseFedDecision("Will the Federal Reserve Cut rates by 25bps at their June 2026 meeting?");
    expect(hike?.bps).not.toBe(cut?.bps);
  });
  test("non-fed title → null", () => {
    expect(parseFedDecision("Will the ECB cut rates in 2026?")).toBeNull();
  });
  test("canonical_event keys the per-meeting set", () => {
    expect(fedDecisionCanonicalEvent("June", 2026)).toBe("federal reserve rate decision june 2026");
  });

  // Unified rate-decision convention: the strict '>' discriminator moves out
  // of the label into the GATED direction: >N hike → above/+N, >N cut → below/−N.
  describe("fedDecisionStamp — unified signed-Δ-line convention", () => {
    const stamp = (t: string) => fedDecisionStamp(parseFedDecision(t)!);
    test("exact hike → at/+25", () => {
      expect(stamp("Will the Federal Reserve Hike rates by 25bps at their June 2026 meeting?"))
        .toEqual({ direction: "at", bps: 25 });
    });
    test("exact cut → at/−25", () => {
      expect(stamp("Will the Federal Reserve Cut rates by 25bps at their June 2026 meeting?"))
        .toEqual({ direction: "at", bps: -25 });
    });
    test("maintain (0bps) → at/0", () => {
      expect(stamp("Will the Federal Reserve Hike rates by 0bps at their June 2026 meeting?"))
        .toEqual({ direction: "at", bps: 0 });
    });
    test("cumulative '>25bps' hike → above/+25 (was exact-shaped at/+25, gated-field-identical to the true exact)", () => {
      expect(stamp("Will the Federal Reserve Hike rates by >25bps at their June 2026 meeting?"))
        .toEqual({ direction: "above", bps: 25 });
    });
    test("cumulative '>25bps' cut → below/−25", () => {
      expect(stamp("Will the Federal Reserve Cut rates by >25bps at their June 2026 meeting?"))
        .toEqual({ direction: "below", bps: -25 });
    });
    test("pathological '>0bps' → null (unshaped beats unsound)", () => {
      expect(stamp("Will the Federal Reserve Hike rates by >0bps at their June 2026 meeting?")).toBeNull();
    });
    test("the five per-event shapes are a pairwise-DISTINCT (direction,value) set", () => {
      const rungs = [
        "Will the Federal Reserve Hike rates by 0bps at their June 2026 meeting?",
        "Will the Federal Reserve Hike rates by 25bps at their June 2026 meeting?",
        "Will the Federal Reserve Cut rates by 25bps at their June 2026 meeting?",
        "Will the Federal Reserve Hike rates by >25bps at their June 2026 meeting?",
        "Will the Federal Reserve Cut rates by >25bps at their June 2026 meeting?",
      ].map((t) => stamp(t));
      expect(new Set(rungs.map((r) => `${r!.direction}/${r!.bps}`)).size).toBe(5);
    });
  });
});

// Series-ticker → sport table.
describe("lookupSeriesSport (P-SPORT)", () => {
  const sport = (t: string) => lookupSeriesSport(t)?.spec.sport ?? null;

  test("spec §3.4 named targets stamp the right sport", () => {
    expect(sport("KXITFMATCH-25MONASTIR")).toBe("tennis");
    expect(sport("KXITFWMATCH-25MONZON")).toBe("tennis");
    expect(sport("KXLOLMAP-25NIPWBG")).toBe("league of legends");
    expect(sport("KXSQUASHMATCH-25X")).toBe("squash");
  });

  test("ITF carries the tour_gender axis (wave-2 seam), league untouched", () => {
    expect(lookupSeriesSport("KXITFMATCH-25X")?.spec.tourGender).toBe("itf-m");
    expect(lookupSeriesSport("KXITFWMATCH-25X")?.spec.tourGender).toBe("itf-w");
    // sport-only: no league field on the spec (KBScope league left to KB paths)
    expect(sport("KXITFMATCH-25X")).toBe("tennis");
  });

  test("esports games map to specific KB sports; CoD/R6 → seeded umbrella", () => {
    expect(sport("KXCS2MAP-25X")).toBe("cs2");
    expect(sport("KXDOTA2GAME-25X")).toBe("dota 2");
    expect(sport("KXVALORANTMAP-25X")).toBe("valorant");
    expect(sport("KXCODMAP-25X")).toBe("esports");
    expect(sport("KXR6GAME-25X")).toBe("esports");
  });

  test("CoD base is sub-series-specific — must NOT catch KXCODINGMODEL (economic)", () => {
    // bare KXCOD would prefix-match the AI-coding-model economic series; excluded.
    expect(lookupSeriesSport("KXCODINGMODEL-26DEC")).toBeNull();
    expect(sport("KXCODMAP-25X")).toBe("esports");
    expect(sport("KXCODGAME-25X")).toBe("esports");
    expect(sport("KXCODTOTALMAPS-25X")).toBe("esports");
  });

  test("foreign fixture leagues map to their sport (verified vs competition)", () => {
    expect(sport("KXBRASILEIROGAME-25X")).toBe("soccer");
    expect(sport("KXBRASILEIROSPREAD-25X")).toBe("soccer"); // SPREAD/TOTAL variants via base
    expect(sport("KXWCGAME-26X")).toBe("soccer");
    expect(sport("KXKBOGAME-25X")).toBe("baseball");
    expect(sport("KXACBGAME-25X")).toBe("basketball");
    expect(sport("KXNCAAFWINS-25X")).toBe("american football (ncaa)");
    expect(sport("KXCOUNTYCHAMPMATCH-25X")).toBe("cricket");
    expect(sport("KXAHLGAME-25X")).toBe("ice hockey");
    expect(sport("KXBOXING-25X")).toBe("boxing");
  });

  test("baseball KXNCAABB vs basketball KXNCAAMB do not cross (distinct bases)", () => {
    expect(sport("KXNCAABBGAME-25X")).toBe("baseball");
    expect(sport("KXNCAAMBAPRANK-25X")).toBe("basketball (ncaa)");
    expect(sport("KXNCAAMLAXGAME-25X")).toBe("lacrosse");
  });

  test("unknown / non-target prefix → null (current behavior preserved)", () => {
    expect(lookupSeriesSport("KXEPLGAME-25X")).toBeNull();   // handled by KALSHI_LEAGUE_FAMILIES, not this table
    expect(lookupSeriesSport("KXBTCMAXY-25X")).toBeNull();   // crypto
    expect(lookupSeriesSport("KXMIDTERMMOV-26X")).toBeNull(); // election
    expect(lookupSeriesSport(null)).toBeNull();
    expect(lookupSeriesSport("")).toBeNull();
  });
});

// 7 bespoke families. Real rows from the live DB.

describe("R2-1 KXUFCMOV — method-of-victory (gated method ordinal, draw residual)", () => {
  const evt = "Benoit Saint-Denis vs. Paddy Pimblett: Method of Victory";
  test("method leg: fighter subject + method ordinal (KO/TKO/DQ=1, Sub=2, Dec=3)", () => {
    const p = parseUfcMethodOfVictory({ event_title: evt, custom_strike: '{"Method": "Submission", "Participant": "Benoit Saint-Denis"}' });
    expect(p).toEqual({ kind: "method", a: "Benoit Saint-Denis", b: "Paddy Pimblett", winner: "Benoit Saint-Denis", method: "Submission", methodOrdinal: 2 });
    const ko = parseUfcMethodOfVictory({ event_title: evt, custom_strike: '{"Method": "KO/TKO/DQ", "Participant": "Paddy Pimblett"}' });
    expect(ko?.kind === "method" ? ko.methodOrdinal : null).toBe(1);
    const dec = parseUfcMethodOfVictory({ event_title: evt, custom_strike: '{"Method": "Decision", "Participant": "Paddy Pimblett"}' });
    expect(dec?.kind === "method" ? dec.methodOrdinal : null).toBe(3);
  });
  test("draw/no-contest residual leg", () => {
    expect(parseUfcMethodOfVictory({ event_title: evt, custom_strike: '{"Method": "Draw/No Contest", "Participant": "Draw/No Contest"}' }))
      .toEqual({ kind: "decision_or_draw", a: "Benoit Saint-Denis", b: "Paddy Pimblett" });
    expect(parseUfcMethodOfVictory({ event_title: evt, custom_strike: '{"Method": "Draw", "Participant": "Draw"}' })?.kind).toBe("decision_or_draw");
  });
  test("bails: unknown method, participant not in fixture, unparseable event_title", () => {
    expect(parseUfcMethodOfVictory({ event_title: evt, custom_strike: '{"Method": "Split Draw", "Participant": "Benoit Saint-Denis"}' })).toBeNull();
    expect(parseUfcMethodOfVictory({ event_title: evt, custom_strike: '{"Method": "Submission", "Participant": "Conor McGregor"}' })).toBeNull();
    expect(parseUfcMethodOfVictory({ event_title: "not a fixture", custom_strike: '{"Method": "Submission", "Participant": "Benoit Saint-Denis"}' })).toBeNull();
    expect(parseUfcMethodOfVictory({ event_title: evt, custom_strike: null })).toBeNull();
  });
});

describe("R2-2 KXTEAMSINWS — matchup pair stays a LITERAL (never decompose)", () => {
  test("pair from custom_strike Team, fallback yes_sub_title", () => {
    expect(parseWorldSeriesMatchup({ yes_sub_title: null, custom_strike: '{"Team": "A' + APOS + 's vs Atlanta"}' }))
      .toEqual({ pair: "A" + APOS + "s vs Atlanta" });
    expect(parseWorldSeriesMatchup({ yes_sub_title: "Houston vs Miami", custom_strike: null }))
      .toEqual({ pair: "Houston vs Miami" });
  });
  test("bails when not a pair", () => {
    expect(parseWorldSeriesMatchup({ yes_sub_title: "Houston", custom_strike: '{"Team": "Houston"}' })).toBeNull();
    expect(parseWorldSeriesMatchup({ yes_sub_title: "", custom_strike: null })).toBeNull();
  });
});

describe("R2-3 KXWCSCORE — soccer correct-score (HOME-oriented, Template-Z fold)", () => {
  const evt = "France vs Spain: Regulation Time Correct Score";
  test("home win: home team + home/away goals", () => {
    const p = parseSoccerCorrectScore({ event_title: evt, yes_sub_title: "Reg Time: France wins 5-2", title: "Will the final score be France wins 5-2?", custom_strike: '{"home_score":"5","away_score":"2"}' });
    expect(p).toEqual({ home: "France", away: "Spain", homeGoals: 5, awayGoals: 2, isDraw: false });
  });
  test("away win: home goals < away goals (orientation stays home-first)", () => {
    const p = parseSoccerCorrectScore({ event_title: evt, yes_sub_title: "Reg Time: Spain wins 3-1", title: "x", custom_strike: '{"home_score":"1","away_score":"3"}' });
    expect(p).toEqual({ home: "France", away: "Spain", homeGoals: 1, awayGoals: 3, isDraw: false });
  });
  test("draw keeps home subject, level score", () => {
    const p = parseSoccerCorrectScore({ event_title: evt, yes_sub_title: "Reg Time: Draw 1-1", title: "x", custom_strike: '{"home_score":"1","away_score":"1"}' });
    expect(p).toEqual({ home: "France", away: "Spain", homeGoals: 1, awayGoals: 1, isDraw: true });
  });
  test("bails: custom_strike scores disagree with title, winner not a participant, non-level draw", () => {
    expect(parseSoccerCorrectScore({ event_title: evt, yes_sub_title: "Reg Time: France wins 5-2", title: "x", custom_strike: '{"home_score":"4","away_score":"2"}' })).toBeNull();
    expect(parseSoccerCorrectScore({ event_title: evt, yes_sub_title: "Reg Time: Brazil wins 2-1", title: "x", custom_strike: null })).toBeNull();
    expect(parseSoccerCorrectScore({ event_title: evt, yes_sub_title: "Reg Time: Draw 2-1", title: "x", custom_strike: null })).toBeNull();
  });
});

describe("R2-4 KXATPSETWINNER / KXWTASETWINNER — per-set winner", () => {
  test("set ordinal from ticker suffix + title agree; winner fold-matches a fixture player", () => {
    const p = parseSetWinner("KXATPSETWINNER-26JUL12SINZVE-3", { title: "Will Jannik Sinner win set 3 in the Jannik Sinner vs Alexander Zverev match", yes_sub_title: "Jannik Sinner" });
    expect(p).toEqual({ player: "Jannik Sinner", setOrdinal: 3, a: "Jannik Sinner", b: "Alexander Zverev" });
    expect(lookupSetWinnerSeries("KXWTASETWINNER-26-1")?.spec.sport).toBe("tennis");
    expect(lookupSetWinnerSeries("KXATPMATCH-26")).toBeNull();
  });
  test("bails when ticker set ordinal disagrees with title, or winner not in fixture", () => {
    expect(parseSetWinner("KXATPSETWINNER-26JUL12SINZVE-2", { title: "Will Jannik Sinner win set 3 in the Jannik Sinner vs Alexander Zverev match", yes_sub_title: "Jannik Sinner" })).toBeNull();
    expect(parseSetWinner("KXATPSETWINNER-26JUL12SINZVE-3", { title: "Will Rafael Nadal win set 3 in the Jannik Sinner vs Alexander Zverev match", yes_sub_title: "Rafael Nadal" })).toBeNull();
  });
});

describe("R2-5 KXPGA3BALL — subject from TITLE, round parsed, tie-allowed", () => {
  test("player + round from title", () => {
    expect(parse3BallMatchup({ title: "Will Niklas Norgaard Moller win the 2nd round 3-ball matchup?" }))
      .toEqual({ player: "Niklas Norgaard Moller", round: 2 });
    expect(parse3BallMatchup({ title: "Will Victor Perez win the 1st round 3-ball matchup?" })?.round).toBe(1);
  });
  test("bails on non-3-ball titles", () => {
    expect(parse3BallMatchup({ title: "Will Victor Perez win the 2026 Genesis Scottish Open?" })).toBeNull();
  });
});

describe("R2-6 KXFIRSTHURRICANE — literal storm name + basin/year in ce", () => {
  test("storm from custom_strike, basin+year from ticker", () => {
    expect(parseFirstHurricane("KXFIRSTHURRICANE-26DEC01CPAC", { yes_sub_title: "Lala", custom_strike: '{"storm": "Lala"}' }))
      .toEqual({ storm: "Lala", basinCode: "CPAC", basin: "Central Pacific", year: 2026 });
    expect(parseFirstHurricane("KXFIRSTHURRICANE-26DEC01ATL", { yes_sub_title: "Arthur", custom_strike: null })?.basin).toBe("Atlantic");
    expect(parseFirstHurricane("KXFIRSTHURRICANE-26DEC01EPAC", { yes_sub_title: "Alvin", custom_strike: null })?.basin).toBe("Eastern Pacific");
  });
  test("canonical_event carries basin + year; bails on unknown basin", () => {
    expect(firstHurricaneCanonicalEvent(2026, "Atlantic")).toBe("2026 first hurricane atlantic");
    expect(parseFirstHurricane("KXFIRSTHURRICANE-26DEC01XXX", { yes_sub_title: "Bob", custom_strike: null })).toBeNull();
  });
});

describe("R2-7 KXEMMYCOUNT — exact-count bucket (never a monotone ladder)", () => {
  test("count from custom_strike Count; show from quoted event_title", () => {
    expect(parseEmmyCount({ title: "How many awards will The Pitt win at the 78th Emmy Awards?", event_title: "How many Emmys will 'The Pitt' win?", custom_strike: '{"Count": "9"}', floor_strike: "9", cap_strike: "9" }))
      .toEqual({ show: "The Pitt", count: 9 });
  });
  test("falls back to floor==cap and to the title for the show", () => {
    expect(parseEmmyCount({ title: "How many awards will Hacks win at the 78th Emmy Awards?", event_title: null, custom_strike: null, floor_strike: "4", cap_strike: "4" }))
      .toEqual({ show: "Hacks", count: 4 });
  });
  test("bails when floor!=cap (a range) and no Count", () => {
    expect(parseEmmyCount({ title: "How many awards will X win at the 78th Emmy Awards?", event_title: null, custom_strike: null, floor_strike: "4", cap_strike: "6" })).toBeNull();
  });
});
