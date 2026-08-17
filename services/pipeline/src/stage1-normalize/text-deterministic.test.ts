/**
 * Tests for matchTemplate — specifically the ordering between generic
 * Template B (H2H "X vs Y") and the anchored-suffix variants H (totals),
 * J (draw), L (Both Teams to Score). Templates H, J, L must run before B,
 * and B's H2H_VS_RX carries a negative lookahead as defense-in-depth so its
 * lazy capture cannot absorb a suffix into the team name.
 */
import { describe, test, expect } from 'bun:test';
import { matchTemplate, deriveCanonicalEvent, deriveCanonicalEventCore, cricketSidePropKind, parseCricketSideProp, gatedEventAlias, statLeaderGatedEvent, isAnonSubject, isAnonymizedMarket, type CandidateRow, type TemplateMatch } from './text-deterministic.js';
import { normalizeOutcomeLabel } from './event-name-normalizer.js';
import { looksLikePredicate } from '../db/entity/resolvers.js';
import { parseFedDecision, fedDecisionStamp } from './kalshi-series.js';

function row(title: string, overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    market_id: 1,
    platform: 'kalshi',
    title,
    end_date: null,
    category_unified: 'sports',
    hierarchy_type: null,
    hierarchy_value: null,
    hierarchy_level: null,
    feat_condition_shape: null,
    feat_condition_direction: null,
    feat_temporal: null,
    numbers: null,
    platform_event_id: null,
    event_match_context: null,
    strike_type: null,
    floor_strike: null,
    cap_strike: null,
    event_ticker: null,
    event_title: null,
    strike_date: null,
    rules_primary: null,
    yes_sub_title: null,
    subtitle: null,
    occurrence_datetime: null,
    slug: null,
    non_kalshi_event_title: null,
    native_question: null,
    is_neg_risk: null,
    ...overrides,
  } as CandidateRow;
}

/** Build a Predict CandidateRow. Defaults platform='predict'. Pass `q` as the
 *  native_question (Predict's real proposition, which the title usually hides). */
function prow(
  title: string,
  q: string | null = null,
  overrides: Partial<CandidateRow> = {},
): CandidateRow {
  return row(title, { platform: 'predict', native_question: q, ...overrides });
}

describe('matchTemplate — draw markets (Template J should beat B)', () => {
  test('"Will Real Oviedo vs. Getafe CF end in a draw?" → J, subject="Draw" (P0 fix), both teams in participants', () => {
    const r = matchTemplate(row('Will Real Oviedo vs. Getafe CF end in a draw?'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-J');
    // The draw node's subject is the DRAW outcome, not the first team.
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.participants_raw).toEqual(['Real Oviedo', 'Getafe CF']);
    expect(r!.outcome_label).toBe('draw');
    expect(r!.event_kind).toBe('match_winner');
  });

  test('"Will Arsenal FC vs. Chelsea FC end in a draw?" → J, subject="Draw"', () => {
    const r = matchTemplate(row('Will Arsenal FC vs. Chelsea FC end in a draw?'));
    expect(r!.source_tag).toBe('text-deterministic-J');
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.participants_raw).toEqual(['Arsenal FC', 'Chelsea FC']);
  });

  test('"Bayer 04 Leverkusen vs. VfL Wolfsburg: Draw at halftime?" → J-half, subject="Draw"', () => {
    const r = matchTemplate(row('Bayer 04 Leverkusen vs. VfL Wolfsburg: Draw at halftime?'));
    expect(r!.source_tag).toBe('text-deterministic-J-half');
    expect(r!.event_kind).toBe('halftime_leader');
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.participants_raw).toEqual(['Bayer 04 Leverkusen', 'VfL Wolfsburg']);
    expect(r!.outcome_label).toBe('draw');
    expect(r!.metric_scope).toBe('half_1');
  });

  test('full-match draw (Template J) keeps metric_scope NULL (whole-match default)', () => {
    const r = matchTemplate(row('Will Arsenal FC vs. Chelsea FC end in a draw?'));
    expect(r!.metric_scope ?? null).toBeNull();
  });

  test('"Hamburger SV leading at halftime?" → K stamps metric_scope=half_1', () => {
    const r = matchTemplate(row('Hamburger SV leading at halftime?'));
    expect(r!.source_tag).toBe('text-deterministic-K');
    expect(r!.event_kind).toBe('halftime_leader');
    expect(r!.metric_scope).toBe('half_1');
  });
});

describe('matchTemplate — over/under (Template H should beat B)', () => {
  test('"Arsenal FC vs. Chelsea FC: O/U 2.5" → H, value=2.5', () => {
    const r = matchTemplate(row('Arsenal FC vs. Chelsea FC: O/U 2.5'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.subject_raw).toBe('Arsenal FC');
    expect(r!.participants_raw).toEqual(['Chelsea FC']);
    expect(r!.value_primary).toBe(2.5);
  });

  test('"Pavlovic vs. Walton: Total Sets O/U 2.5" → H', () => {
    const r = matchTemplate(row('Pavlovic vs. Walton: Total Sets O/U 2.5'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.subject_raw).toBe('Pavlovic');
    expect(r!.participants_raw).toEqual(['Walton']);
  });
});

describe('matchTemplate — Template H corners + soccer half-total extensions', () => {
  test('"…: O/U 12.5 Total Corners" → H, corners metric, non-mutex threshold', () => {
    const r = matchTemplate(row('Deportivo Toluca FC vs. Club Necaxa: O/U 12.5 Total Corners'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.subject_raw).toBe('Deportivo Toluca FC');
    expect(r!.participants_raw).toEqual(['Club Necaxa']);
    expect(r!.value_primary).toBe(12.5);
    expect(r!.value_unit).toBe('corner');
    expect(r!.condition_metric).toBeNull();
    expect(r!.event_kind).toBe('match_total_metric');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_unit_inferred).toBe(false);
    expect(r!.metric_scope ?? null).toBeNull();
  });

  test('corners O/U and goals O/U on the same fixture carry DISTINCT units (no fuse)', () => {
    const corners = matchTemplate(row('Deportivo Toluca FC vs. Club Necaxa: O/U 12.5 Total Corners'));
    const goals = matchTemplate(row('Deportivo Toluca FC vs. Club Necaxa: O/U 2.5'));
    expect(corners!.value_unit).toBe('corner');
    expect(goals!.value_unit).toBe('goals');
    expect(corners!.value_unit).not.toBe(goals!.value_unit);
  });

  test('"…: <TeamB> O/U 2.5 Corners" → H team-total, subject=named team, scope=team', () => {
    const r = matchTemplate(row('CF Pachuca vs. Querétaro FC: Querétaro FC O/U 2.5 Corners'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.subject_raw).toBe('Querétaro FC');
    expect(r!.participants_raw).toEqual(['CF Pachuca']);
    expect(r!.metric_scope).toBe('team');
    expect(r!.value_unit).toBe('corner');
  });

  test('"…: <TeamA> O/U 5.5 Corners" → team-total on team A', () => {
    const r = matchTemplate(row('HŠK Zrinjski Mostar vs. KF Valur: HŠK Zrinjski Mostar O/U 5.5 Corners'));
    expect(r!.subject_raw).toBe('HŠK Zrinjski Mostar');
    expect(r!.participants_raw).toEqual(['KF Valur']);
    expect(r!.metric_scope).toBe('team');
  });

  test('"…: 1st Half O/U 2.5" → H, metric_scope half_1, goals', () => {
    const r = matchTemplate(row('Pohang Steelers FC vs. Jeonbuk Hyundai Motors FC: 1st Half O/U 2.5'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.metric_scope).toBe('half_1');
    expect(r!.value_primary).toBe(2.5);
    expect(r!.value_unit).toBe('goals');
    expect(r!.value_unit_inferred).toBe(true);
  });

  test('"…: 2nd Half O/U 0.5" → metric_scope half_2', () => {
    const r = matchTemplate(row('Pohang Steelers FC vs. Jeonbuk Hyundai Motors FC: 2nd Half O/U 0.5'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.metric_scope).toBe('half_2');
  });

  test('"…: Second Half O/U 1.5" (spelled-out) → half_2', () => {
    const r = matchTemplate(row('Pohang Steelers FC vs. Jeonbuk Hyundai Motors FC: Second Half O/U 1.5'));
    expect(r!.metric_scope).toBe('half_2');
  });

  test('"…: 1st Half O/U 5.5 Total Corners" → half_1 AND corners', () => {
    const r = matchTemplate(row('CA Paranaense vs. SC Internacional: 1st Half O/U 5.5 Total Corners'));
    expect(r!.metric_scope).toBe('half_1');
    expect(r!.value_unit).toBe('corner');
    expect(r!.value_unit_inferred).toBe(false);
  });

  test('"…: <Team> 2nd Half O/U 0.5" (team × half) is NOT shaped by H', () => {
    const r = matchTemplate(row('Pohang Steelers FC vs. Jeonbuk Hyundai Motors FC: Pohang Steelers FC 2nd Half O/U 0.5'));
    expect(r?.source_tag).not.toBe('text-deterministic-H');
  });

  test('"…: Total Corners Odd or Even?" (no O/U) is NOT shaped by H', () => {
    const r = matchTemplate(row('CF América vs. Club Santos Laguna: Total Corners Odd or Even?'));
    expect(r?.source_tag).not.toBe('text-deterministic-H');
  });

  test('unrecognised pre-qualifier ("Winner O/U 5.5") is declined, not over-captured', () => {
    const r = matchTemplate(row('Arsenal FC vs. Chelsea FC: Winner O/U 5.5 Corners'));
    expect(r?.source_tag).not.toBe('text-deterministic-H');
  });

  test('plain "…: O/U 2.5" still stamps goals / NULL scope (no regression)', () => {
    const r = matchTemplate(row('Arsenal FC vs. Chelsea FC: O/U 2.5'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.subject_raw).toBe('Arsenal FC');
    expect(r!.participants_raw).toEqual(['Chelsea FC']);
    expect(r!.value_unit).toBe('goals');
    expect(r!.metric_scope ?? null).toBeNull();
    expect(r!.condition_metric).toBeNull();
    expect(r!.event_kind).toBe('match_total_metric');
  });
});

describe('matchTemplate — Both Teams to Score (Template L should beat B)', () => {
  test('"Arsenal FC vs. Chelsea FC: Both Teams to Score" → L', () => {
    const r = matchTemplate(row('Arsenal FC vs. Chelsea FC: Both Teams to Score'));
    expect(r!.source_tag).toBe('text-deterministic-L');
    expect(r!.subject_raw).toBe('Arsenal FC');
    expect(r!.participants_raw).toEqual(['Chelsea FC']);
  });

  test('"Both Arsenal and Fulham score on May 2?" → L', () => {
    const r = matchTemplate(row('Both Arsenal and Fulham score on May 2?'));
    expect(r!.source_tag).toBe('text-deterministic-L');
  });
});

describe('matchTemplate — Template M2 ("<A> and <B> have N+/N or more total <stat>?")', () => {
  test('"…have 3 or more total goals?" → M2, above/2.5/goals', () => {
    const r = matchTemplate(row('Vikingur Reykjavik and Hapoel Beer Sheva have 3 or more total goals?'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-M2');
    expect(r!.subject_raw).toBe('Vikingur Reykjavik');
    expect(r!.participants_raw).toEqual(['Hapoel Beer Sheva']);
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(2.5);
    expect(r!.value_unit).toBe('goal');
    expect(r!.event_kind).toBe('match_total_metric');
  });

  test('"…4+ total cards?" variant → M2, above/3.5/card', () => {
    const r = matchTemplate(row('Cremonese and Lazio have 4+ total cards?'));
    expect(r!.source_tag).toBe('text-deterministic-M2');
    expect(r!.value_primary).toBe(3.5);
    expect(r!.value_unit).toBe('card');
  });

  test('"3 or more" ≡ "3+" — identical stamp', () => {
    const a = matchTemplate(row('Arsenal and Chelsea have 3 or more total goals?'));
    const b = matchTemplate(row('Arsenal and Chelsea have 3+ total goals?'));
    expect(a!.source_tag).toBe('text-deterministic-M2');
    expect(b!.source_tag).toBe('text-deterministic-M2');
    expect(a!.value_primary).toBe(b!.value_primary);
    expect(a!.value_unit).toBe(b!.value_unit);
    expect(a!.condition_direction).toBe(b!.condition_direction);
  });

  test('single-team phrasing refuses M2', () => {
    expect(matchTemplate(row('Arsenal have 3 or more total goals?'))).toBeNull();
  });

  test('non-sports category refuses M2', () => {
    const r = matchTemplate(row('Arsenal and Chelsea have 3 or more total goals?', { category_unified: 'politics' }));
    expect(r?.source_tag).not.toBe('text-deterministic-M2');
  });
});

describe('matchTemplate — generic H2H (Template B still works for plain "X vs Y")', () => {
  test('"Lakers vs Celtics" → B', () => {
    const r = matchTemplate(row('Lakers vs Celtics'));
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Lakers');
    expect(r!.participants_raw).toEqual(['Celtics']);
  });

  test('"Will Manchester United beat Liverpool?" → B', () => {
    const r = matchTemplate(row('Will Manchester United beat Liverpool?'));
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Manchester United');
    expect(r!.participants_raw).toEqual(['Liverpool']);
  });

  test('"Arsenal or Chelsea to win" → B', () => {
    const r = matchTemplate(row('Arsenal or Chelsea to win'));
    expect(r!.source_tag).toBe('text-deterministic-B');
  });
});

describe('matchTemplate — defense-in-depth: B refuses suffix-owned titles', () => {
  // Even if TEMPLATES were ever re-ordered to put B first, the negative
  // lookahead in H2H_VS_RX refuses these titles.
  test('"X vs Y end in a draw" is never tagged B', () => {
    const r = matchTemplate(row('Will Real Oviedo vs. Getafe CF end in a draw?'));
    expect(r!.source_tag).not.toBe('text-deterministic-B');
  });

  test('"X vs Y: Both Teams to Score" is never tagged B', () => {
    const r = matchTemplate(row('Arsenal FC vs. Chelsea FC: Both Teams to Score'));
    expect(r!.source_tag).not.toBe('text-deterministic-B');
  });

  test('"X vs Y: O/U N" is never tagged B', () => {
    const r = matchTemplate(row('Arsenal FC vs. Chelsea FC: O/U 2.5'));
    expect(r!.source_tag).not.toBe('text-deterministic-B');
  });
});

describe('matchTemplate — esports / playoffs / announcer-prop suffixes refuse Template B', () => {
  test('"Will X win the A vs. B League of Legends match?" is never tagged B', () => {
    const r = matchTemplate(row('Will FALKE Esports win the FALKE Esports vs. Barça eSports League of Legends match?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-B');
  });

  test('"Will X win the A vs. B Valorant match?" is never tagged B', () => {
    const r = matchTemplate(row('Will FunPlus Phoenix win the FunPlus Phoenix vs. Bilibili Gaming Valorant match?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-B');
  });

  test('"X vs Y 2026 2nd Round series winner?" is never tagged B', () => {
    const r = matchTemplate(row('Vegas Golden Knights vs Anaheim Ducks 2026 2nd Round series winner?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-B');
  });

  test('"What will the announcers say during X vs Y Professional Baseball Game?" is never tagged B', () => {
    const r = matchTemplate(row('What will the announcers say during Cubs vs Braves Professional Baseball Game?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-B');
  });

  test('"Will X vs Y be the matchup in the Pro Baseball Championship Series?" is never tagged B', () => {
    const r = matchTemplate(row('Will Toronto vs Arizona be the matchup in the Pro Baseball Championship Series?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-B');
  });

  test('"X: A vs B Winner?" with prefix is never tagged B with bad-suffix capture', () => {
    const r = matchTemplate(row('La Velada del Año VI: Alondrissa vs Angie Velasco Winner?'));
    if (r !== null) {
      // B may still match via the dedicated H2H_VS_WINNER_RX, but the b
      // capture must not include "Winner" in the team name.
      expect(r.participants_raw[0]).not.toContain('Winner');
    }
  });
});

describe('matchTemplate — Kalshi MLB suffixes refuse Template B', () => {
  test('"X vs Y Total Runs?" rejected by B', () => {
    const r = matchTemplate(row('Tampa Bay vs Boston Total Runs?'));
    if (r !== null) {
      expect(r.source_tag).not.toBe('text-deterministic-B');
    }
  });

  test('"X vs Y First Inning Run?" rejected by B', () => {
    const r = matchTemplate(row('New York M vs Arizona First Inning Run?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-B');
  });

  test('"X vs Y first 5 innings winner?" rejected by B', () => {
    const r = matchTemplate(row('St. Louis vs A\'s first 5 innings winner?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-B');
  });
});

describe('matchTemplate — "Will the X" article stripping', () => {
  // `(?:will\s+(?:the\s+)?)?` plus optional `(?:the\s+)?` before b strips
  // articles on both sides.

  test('Template F: "Will the Democratic Party win the WV-AL House seat?" → person="Democratic Party"', () => {
    const r = matchTemplate(row('Will the Democratic Party win the WV-AL House seat?', {
      category_unified: 'politics',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-F');
    expect(r!.subject_raw).toBe('Democratic Party');
  });

  test('Template F: "Will Joe Biden win the 2024 election?" → person="Joe Biden"', () => {
    const r = matchTemplate(row('Will Joe Biden win the 2024 election?', {
      category_unified: 'politics',
    }));
    expect(r!.source_tag).toBe('text-deterministic-F');
    expect(r!.subject_raw).toBe('Joe Biden');
  });

  test('Template G: "Will the Lakers win?" → team="Lakers"', () => {
    const r = matchTemplate(row('Will the Lakers win?'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-G');
    expect(r!.subject_raw).toBe('Lakers');
  });

  test('Template G: "Will Arsenal win?" → team="Arsenal" (no article)', () => {
    const r = matchTemplate(row('Will Arsenal win?'));
    expect(r!.source_tag).toBe('text-deterministic-G');
    expect(r!.subject_raw).toBe('Arsenal');
  });

  test('Template B (beat): "Will the Lakers beat the Celtics?" → a="Lakers", b="Celtics"', () => {
    const r = matchTemplate(row('Will the Lakers beat the Celtics?'));
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Lakers');
    expect(r!.participants_raw).toEqual(['Celtics']);
  });
});

describe('matchTemplate — Template E refuses team-margin "wins by" markets', () => {
  // These are TEAM-margin markets, not player props.
  test('"X wins by over N goals?" rejected by E', () => {
    const r = matchTemplate(row('AC Goianiense wins by over 2.5 goals?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-E');
  });

  test('"X loses by over N goals?" rejected by E', () => {
    const r = matchTemplate(row('Liverpool loses by over 1.5 goals?'));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-E');
  });

  test('Legitimate player-prop "Player over N stat" still matches E', () => {
    const r = matchTemplate(row('Patrick Mahomes over 250.5 passing yards'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-E');
    expect(r!.subject_raw).toBe('Patrick Mahomes');
  });
});

describe('matchTemplate — Template Y "Will X win the A vs B [sport] match?"', () => {
  test('darts match — explicit sport keyword → sport=darts', () => {
    const r = matchTemplate(row('Will Gian van Veen win the Josh Rock vs Gian van Veen darts match?'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe('Gian van Veen');
    expect(r!.participants_raw).toEqual(['Josh Rock', 'Gian van Veen']);
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.sport_canonical).toBe('darts');
    expect(r!.canonical_event_override).toBe('Josh Rock vs Gian van Veen');
  });

  test('darts H2H from the other side — symmetric extraction', () => {
    const r = matchTemplate(row('Will Josh Rock win the Josh Rock vs Gian van Veen darts match?'));
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe('Josh Rock');
    expect(r!.participants_raw).toEqual(['Josh Rock', 'Gian van Veen']);
  });

  test('tennis ITF code → sport=tennis even without "tennis" keyword', () => {
    const r = matchTemplate(row('Will Julia Riera win the Riera vs Liutova: W100 Indian Harbour Beach FL Final match?'));
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe('Julia Riera');
    expect(r!.participants_raw).toEqual(['Riera', 'Liutova']);
    expect(r!.sport_canonical).toBe('tennis');
    expect(r!.canonical_event_override).toBe('Riera vs Liutova: W100 Indian Harbour Beach FL Final');
  });

  test('plain "Final" tail without ITF code — no sport, still extracts', () => {
    const r = matchTemplate(row('Will Calvin Hemery win the Bax vs Hemery: Final match?'));
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe('Calvin Hemery');
    expect(r!.participants_raw).toEqual(['Bax', 'Hemery']);
    expect(r!.sport_canonical).toBeNull();
  });

  test('non-sports category is rejected', () => {
    const r = matchTemplate(row(
      'Will Trump win the Trump vs Biden debate match?',
      { category_unified: 'election' },
    ));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-Y');
  });

  test('does NOT match generic H2H "X vs Y" (Template B reaches it)', () => {
    const r = matchTemplate(row('Lakers vs Thunder'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
  });
});

// Template Y's H2H door also claims Kalshi game/fight winner families that
// share its "Will <who> win the <A> vs <B> <sport> <noun>?" grammar but end
// in game/fight (not match) and carry team / MMA sports.
describe('matchTemplate — Template Y hw821 game/fight/doubles widen', () => {
  test('KXNFLGAME "Pro Football game?" → Y, team, sport=american football', () => {
    const r = matchTemplate(row('Will Arizona win the Carolina vs Arizona Pro Football game?',
      { event_ticker: 'KXNFLGAME-26AUG06CARARI' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe('Arizona');
    expect(r!.participants_raw).toEqual(['Carolina', 'Arizona']);
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.sport_canonical).toBe('american football');
    expect(r!.entity_type).toBe('team');
    expect(r!.canonical_event_override).toBe('Carolina vs Arizona');
  });

  test('KXNCAAFGAME "college football game?" → Y, american football, apostrophe name', () => {
    const r = matchTemplate(row("Will Hawai'i win the Hawai'i vs Stanford college football game?",
      { event_ticker: 'KXNCAAFGAME-26AUG29HAWSTAN' }));
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe("Hawai'i");
    expect(r!.participants_raw).toEqual(["Hawai'i", 'Stanford']);
    expect(r!.sport_canonical).toBe('american football');
    expect(r!.entity_type).toBe('team');
  });

  test('KXCFLGAME bare "football game?" → sport via event_ticker fallback', () => {
    const r = matchTemplate(row(
      'Will Hamilton Tiger-Cats win the Hamilton Tiger-Cats vs Saskatchewan Roughriders football game?',
      { event_ticker: 'KXCFLGAME-26JUL12HAMSSK' }));
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe('Hamilton Tiger-Cats');
    expect(r!.participants_raw).toEqual(['Hamilton Tiger-Cats', 'Saskatchewan Roughriders']);
    expect(r!.sport_canonical).toBe('american football');
    expect(r!.entity_type).toBe('team');
  });

  test('bare "football game?" WITHOUT a football ticker is NOT stamped american football (soccer ambiguity guard)', () => {
    const r = matchTemplate(row(
      'Will Hamilton win the Hamilton vs Saskatchewan football game?',
      { event_ticker: 'KXSOMEOTHER-1' }));
    // Still claimed by Y (grammar matches), but sport stays null: never
    // mapped to american football off bare "football".
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.sport_canonical).toBeNull();
  });

  test('KXUFCFIGHT "professional MMA fight scheduled for <date>?" → Y, mma, person', () => {
    const r = matchTemplate(row(
      'Will Farid Basharat win the Basharat vs Garza professional MMA fight scheduled for Jul 11, 2026?',
      { event_ticker: 'KXUFCFIGHT-26JUL11BASGAR' }));
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe('Farid Basharat');
    expect(r!.participants_raw).toEqual(['Basharat', 'Garza']);
    expect(r!.sport_canonical).toBe('mma');
    expect(r!.entity_type).toBe('person');
  });

  test('KXITFDOUBLES pair names with "/" → Y, tennis, pair subjects preserved', () => {
    const r = matchTemplate(row(
      'Will Deckers / Faucon win the Deckers / Faucon vs Perego / Piatti: M15 Hillcrest Semifinal match?',
      { event_ticker: 'KXITFDOUBLES-26JUL10DECFAUPERPIA' }));
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.subject_raw).toBe('Deckers / Faucon');
    expect(r!.participants_raw).toEqual(['Deckers / Faucon', 'Perego / Piatti']);
    expect(r!.sport_canonical).toBe('tennis');
    expect(r!.canonical_event_override).toBe('Deckers / Faucon vs Perego / Piatti: M15 Hillcrest Semifinal');
  });

  test('existing darts "match?" still matches (no regression from terminal-noun widen)', () => {
    const r = matchTemplate(row('Will Josh Rock win the Josh Rock vs Gian van Veen darts match?'));
    expect(r!.source_tag).toBe('text-deterministic-Y');
    expect(r!.sport_canonical).toBe('darts');
  });
});

describe('Template Z any_other — parent-event suffix stripping', () => {
  // Polymarket parent-event titles for sub-market parents append
  // " - <MarketType>" (e.g. " - Exact Score", " - Halftime Result", " - Total
  // Corners"); this must be stripped before team B's name is captured.
  test('"X vs. Y - Exact Score" parent title yields clean team names', () => {
    const r = matchTemplate(row('Exact Score: Any Other Score?', {
      non_kalshi_event_title: 'San Jose Earthquakes vs. FC Dallas - Exact Score',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-Z');
    expect(r!.subject_raw).toBe('San Jose Earthquakes');
    expect(r!.participants_raw).toEqual(['FC Dallas']);
    expect(r!.outcome_label).toBe('any_other');
  });

  test('"X vs. Y - Halftime Result" parent title yields clean team names', () => {
    const r = matchTemplate(row('Exact Score: Any Other Score?', {
      non_kalshi_event_title: 'Arsenal FC vs. Burnley FC - Halftime Result',
    }));
    expect(r!.subject_raw).toBe('Arsenal FC');
    expect(r!.participants_raw).toEqual(['Burnley FC']);
  });

  test('hyphenated team names without surrounding spaces are preserved', () => {
    const r = matchTemplate(row('Exact Score: Any Other Score?', {
      non_kalshi_event_title: 'Saint-Étienne vs. Stoke-on-Trent - Exact Score',
    }));
    expect(r!.subject_raw).toBe('Saint-Étienne');
    expect(r!.participants_raw).toEqual(['Stoke-on-Trent']);
  });

  test('parent title without market-type suffix still parses', () => {
    const r = matchTemplate(row('Exact Score: Any Other Score?', {
      non_kalshi_event_title: 'Arsenal FC vs. Burnley FC',
    }));
    expect(r!.subject_raw).toBe('Arsenal FC');
    expect(r!.participants_raw).toEqual(['Burnley FC']);
  });
});

describe('matchTemplate — crypto resolution_source override', () => {
  // Template A / Q emit 'CF Benchmarks' for crypto (matching Kalshi's
  // KNOWN_SERIES_MAP) and null for non-crypto financial markets (matching
  // Kalshi's null for KXNASDAQ / KXINXU / KXGOLD / KXWTI / KXBRENT), so
  // Polymarket/Limitless collapse with Kalshi's rows at Stage 2 hash-grouping.

  test('Template A crypto: "Will the price of Bitcoin be above $80,000 on May 10?" → CF Benchmarks', () => {
    const r = matchTemplate(row('Will the price of Bitcoin be above $80,000 on May 10?', {
      category_unified: 'crypto',
      platform: 'polymarket',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-A');
    expect(r!.resolution_source).toBe('CF Benchmarks');
  });

  test('Template A crypto range_snapshot: "Will Bitcoin be between..." → CF Benchmarks', () => {
    const r = matchTemplate(row('Will the price of Bitcoin be between $78,000 and $80,000 on May 14?', {
      category_unified: 'crypto',
      platform: 'polymarket',
    }));
    expect(r).not.toBeNull();
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.resolution_source).toBe('CF Benchmarks');
  });

  test('Template A economic (S&P, NASDAQ, Gold): resolution_source is null', () => {
    const r = matchTemplate(row('Will the price of Gold be above $3,500 on May 14?', {
      category_unified: 'economic',
      platform: 'polymarket',
    }));
    expect(r).not.toBeNull();
    expect(r!.resolution_source).toBeNull();
  });

  test('Template Q Limitless UTC-clock crypto: "BTC above $80000 on May 14, 09:00 UTC" → CF Benchmarks', () => {
    const r = matchTemplate(row('BTC above $80000 on May 14, 09:00 UTC', {
      category_unified: 'crypto',
      platform: 'limitless',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-Q');
    expect(r!.resolution_source).toBe('CF Benchmarks');
  });

  test('M-SOUND-2: un-migrated templates leave resolution_source undefined; build-norm emits NULL (not source_tag)', () => {
    // Only Templates A/Q set resolution_source explicitly. Every other
    // template leaves it undefined at the TemplateMatch level; the build site
    // emits NULL resolution_source for those, not the source_tag. The path
    // tag survives independently in match_source.
    const r = matchTemplate(row('Will Real Oviedo vs. Getafe CF end in a draw?'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-J');
    expect(r!.resolution_source).toBeUndefined();
  });
});

describe('matchTemplate — Template G per-fixture opponent extraction (Pattern E)', () => {
  test('Predict "Will X win on DATE?" pulls opponent from sibling H2H title', () => {
    const r = matchTemplate(row('Will Croatia win on 2026-06-23?', {
      platform: 'predict',
      event_match_context: 'Will Croatia vs. Panama end in a draw?',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-G');
    expect(r!.subject_raw).toBe('Croatia');
    expect(r!.canonical_event_override).toBe('croatia vs panama');
    expect(r!.participants_raw).toEqual(['Panama']);
  });

  test('Predict per-fixture with FC suffix on subject matches sibling without FC', () => {
    const r = matchTemplate(row('Will Sevilla FC win on 2026-05-13?', {
      platform: 'predict',
      event_match_context: 'Will Sevilla vs. Villarreal end in a draw?',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-G');
    expect(r!.canonical_event_override).toBe('sevilla vs villarreal');
  });

  test('falls through (no override) when no sibling H2H context provided', () => {
    const r = matchTemplate(row('Will Croatia win on 2026-06-23?', {
      platform: 'predict',
      event_match_context: null,
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-G');
    expect(r!.canonical_event_override).toBeNull();
  });

  test('refuses sibling context when subject not in H2H pair (defensive)', () => {
    const r = matchTemplate(row('Will Brazil win on 2026-06-23?', {
      platform: 'predict',
      event_match_context: 'Will Croatia vs. Panama end in a draw?',
    }));
    expect(r).not.toBeNull();
    expect(r!.canonical_event_override).toBeNull();
  });
});

describe('matchTemplate — Template P (weather)', () => {
  test('exact-temp form ("be 76°F on May 11?") → range_snapshot 1° bucket, not binary_event', () => {
    const r = matchTemplate(row('Will the highest temperature in Atlanta be 76°F on May 11?', {
      platform: 'polymarket',
      category_unified: 'weather',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-P');
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.condition_direction).toBe('between');
    expect(r!.value_primary).toBe(76);
    expect(r!.value_secondary).toBe(77);
    expect(r!.value_unit).toBe('fahrenheit');
    // Stable canonical_event so the trailing date doesn't shard markets
    // across days/platforms: (subject + condition_date) disambiguates.
    expect(r!.canonical_event_override).toBe('highest temperature in Atlanta');
  });

  test('exact-temp form with Celsius ("be 10°C on May 11?") → range_snapshot 1°C bucket', () => {
    const r = matchTemplate(row('Will the highest temperature in Amsterdam be 10°C on May 11?', {
      platform: 'polymarket',
      category_unified: 'weather',
    }));
    expect(r).not.toBeNull();
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.condition_direction).toBe('between');
    expect(r!.value_primary).toBe(10);
    expect(r!.value_secondary).toBe(11);
    expect(r!.value_unit).toBe('celsius');
    expect(r!.canonical_event_override).toBe('highest temperature in Amsterdam');
  });

  test('range form ("be between 84-85°F on May 10?") → range_snapshot preserved with override', () => {
    const r = matchTemplate(row('Will the highest temperature in Atlanta be between 84-85°F on May 10?', {
      platform: 'polymarket',
      category_unified: 'weather',
    }));
    expect(r).not.toBeNull();
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.condition_direction).toBe('between');
    expect(r!.value_primary).toBe(84);
    expect(r!.value_secondary).toBe(85);
    expect(r!.canonical_event_override).toBe('highest temperature in Atlanta');
  });

  test('threshold form ("be 76°F or higher on May 11?") → point_in_time with stable canonical_event', () => {
    const r = matchTemplate(row('Will the highest temperature in Atlanta be 76°F or higher on May 11?', {
      platform: 'polymarket',
      category_unified: 'weather',
    }));
    expect(r).not.toBeNull();
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.condition_direction).toBe('above');
    // "76°F or higher" is inclusive >=76; fahrenheit is integer-grain so it
    // canonicalizes to the strict half-line 75.5 (>=76 is equivalent to
    // >75.5), distinct from a Kalshi ">76°" rung (-> 76.5).
    expect(r!.value_primary).toBe(75.5);
    expect(r!.value_secondary).toBeNull();
    expect(r!.canonical_event_override).toBe('highest temperature in Atlanta');
  });

  test('lowest-temperature form → "lowest temperature in <city>"', () => {
    const r = matchTemplate(row('Will the lowest temperature in Boston be 32°F or below on May 13?', {
      platform: 'polymarket',
      category_unified: 'weather',
    }));
    expect(r).not.toBeNull();
    expect(r!.condition_direction).toBe('below');
    expect(r!.canonical_event_override).toBe('lowest temperature in Boston');
  });

  test('"maximum temperature" phrasing collapses to "highest temperature" canonical', () => {
    // Kalshi titles use "maximum"/"minimum"; Polymarket uses "highest"/"lowest".
    // Both must produce the same canonical_event override.
    const r = matchTemplate(row('Will the maximum temperature in Atlanta be 86°F or higher on May 10?', {
      platform: 'polymarket',
      category_unified: 'weather',
    }));
    expect(r).not.toBeNull();
    expect(r!.canonical_event_override).toBe('highest temperature in Atlanta');
  });
});

describe('matchTemplate — Template B "X vs Y winner?" (Kalshi)', () => {
  // H2H_VS_WINNER_RX is tried before B_SUFFIX_GUARDS, so a bare "X vs Y
  // winner?" title matches instead of being refused, aligning Kalshi sports
  // markets with Polymarket Template B "X vs Y" output for the same fixture.
  test('bare "X vs Y winner?" → Template B match_winner', () => {
    const r = matchTemplate(row('Doosan Bears vs Kia Tigers winner?', { category_unified: 'sports' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Doosan Bears');
    expect(r!.participants_raw).toEqual(['Kia Tigers']);
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.condition_shape).toBe('binary_event');
  });

  test('capital "Winner?" also matches (case-insensitive)', () => {
    const r = matchTemplate(row('Miami vs Minnesota Winner?', { category_unified: 'sports' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Miami');
    expect(r!.participants_raw).toEqual(['Minnesota']);
  });

  test('first-goal PROP is NOT a match_winner (S1 — score-first equivalence factory)', () => {
    // "X to score first vs. Y?" is a scoring-order prop, not a match winner:
    // shaping it match_winner would let the equivalence builder pair it with
    // the genuine winner question.
    const r1 = matchTemplate(row('Santos FC to score first vs. Botafogo FR?', { category_unified: 'sports' }));
    expect(r1?.event_kind).not.toBe('match_winner');
    const r2 = matchTemplate(row('Sporting Kansas City to score first vs. St. Louis City SC?', { category_unified: 'sports' }));
    expect(r2?.event_kind).not.toBe('match_winner');
    const ok = matchTemplate(row('Botafogo vs Santos Winner?', { category_unified: 'sports' }));
    expect(ok?.event_kind).toBe('match_winner');
  });

  test('game-state PROP in colon-prefix is NOT a match_winner (Bug B — extra innings)', () => {
    // "Will the game go to extra innings?: A vs B" — H2H_VS_RX must not
    // capture the fixture after the colon as a clean winner.
    const r = matchTemplate(row('Will the game go to extra innings?: Seattle Mariners vs. Tampa Bay Rays', { category_unified: 'sports' }));
    expect(r?.event_kind).not.toBe('match_winner');
  });

  test('"vs." with period also matches', () => {
    const r = matchTemplate(row('Maccabi Raanana vs. Maccabi Ironi Ramat Gan Winner?', { category_unified: 'sports' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Maccabi Raanana');
    expect(r!.participants_raw).toEqual(['Maccabi Ironi Ramat Gan']);
  });

  test('refuses suffix-contaminated b-capture ("Total Runs" leaks)', () => {
    // H2H_VS_WINNER_RX is tried before B_SUFFIX_GUARDS, so its own
    // contamination check must reject this title.
    const r = matchTemplate(row('Boston vs Yankees Total Runs winner?', { category_unified: 'sports' }));
    expect(r).toBeNull();
  });

  test('refuses round-series suffix contamination', () => {
    const r = matchTemplate(row('Cleveland vs Detroit 2nd Round series winner?', { category_unified: 'sports' }));
    expect(r).toBeNull();
  });

  test('"Game N: A at B Winner?" → Template B with game-N canonical_event', () => {
    const r = matchTemplate(row('Game 5: Anaheim at Vegas Winner?', { category_unified: 'sports' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Anaheim');
    expect(r!.participants_raw).toEqual(['Vegas']);
    // The game-N anchor rides canonical_event_suffix, which must survive
    // deriveCanonicalEventCore's KB-name fixture rebuild: otherwise every
    // game of a playoff series would collapse onto one canonical_event.
    expect(r!.canonical_event_override).toBe('Anaheim vs Vegas');
    expect(r!.canonical_event_suffix).toBe('game 5');
  });

  test('P4 gap 4: two game-N markets of ONE series derive DISTINCT canonical_event (KB rebuild kept)', () => {
    const derive = (title: string, yst: string) => {
      const tpl = matchTemplate(row(title, { yes_sub_title: yst }))!;
      return deriveCanonicalEvent({
        template: tpl,
        canonical_subject: tpl.subject_raw === 'Anaheim' || tpl.subject_raw === 'Vegas'
          ? (tpl.subject_raw === 'Anaheim' ? 'Anaheim Ducks' : 'Vegas Golden Knights')
          : tpl.subject_raw,
        canonicalParticipants: [tpl.subject_raw === 'Anaheim' ? 'Vegas Golden Knights' : 'Anaheim Ducks'],
        categoryUnified: 'sports',
        title, nonKalshiEventTitle: null, eventDateIso: null,
      });
    };
    const g4 = derive('Game 4: Vegas at Anaheim Winner?', 'Vegas');
    const g5 = derive('Game 5: Anaheim at Vegas Winner?', 'Anaheim');
    const g6 = derive('Game 6: Vegas at Anaheim Winner?', 'Vegas');
    // KB-name fixture core survives AND the per-game anchor survives.
    expect(g4).toBe('Anaheim Ducks vs Vegas Golden Knights game 4');
    expect(g5).toBe('Anaheim Ducks vs Vegas Golden Knights game 5');
    expect(g6).toBe('Anaheim Ducks vs Vegas Golden Knights game 6');
    expect(new Set([g4, g5, g6]).size).toBe(3);
  });
});

// A Kalshi event can have several siblings sharing one title (e.g. "Arsenal
// vs Everton Winner?"); the outcome each pays on lives only in
// yes_sub_title ('Tie' / 'Everton' / 'Arsenal'). Each sibling must
// normalize to a distinct subject, or Stage 4 would assert Tie equivalent to
// Everton-wins equivalent to Arsenal-wins.
describe('Template B — Kalshi yes_sub_title lift (siblings get distinct subjects)', () => {
  const TITLE = 'Arsenal vs Everton Winner?';

  test('yst = home team → that team is the subject', () => {
    const r = matchTemplate(row(TITLE, { yes_sub_title: 'Arsenal' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.subject_raw).toBe('Arsenal');
    expect(r!.participants_raw).toEqual(['Everton']);
  });

  test('yst = away team → SUBJECT FLIPS to that team', () => {
    const r = matchTemplate(row(TITLE, { yes_sub_title: 'Everton' }));
    expect(r!.subject_raw).toBe('Everton');
    expect(r!.participants_raw).toEqual(['Arsenal']);
    expect(r!.event_kind).toBe('match_winner');
  });

  test("yst = 'Tie' → Draw leg (Template-J convention), event_kind stays match_winner", () => {
    const r = matchTemplate(row(TITLE, { yes_sub_title: 'Tie' }));
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.participants_raw).toEqual(['Arsenal', 'Everton']);
    expect(r!.outcome_label).toBe('draw');
    expect(r!.event_kind).toBe('match_winner');
  });

  test('yst matching NEITHER participant nor tie → bail (unshaped beats a guessed subject)', () => {
    expect(matchTemplate(row(TITLE, { yes_sub_title: 'Liverpool' }))).toBeNull();
    // The set-score discriminator ("Will X win the A vs B match by a set
    // score of 2-0?", yst='X wins 2-0') bails instead of minting a junk subject.
    expect(matchTemplate(row(
      'Will Mattia Bellucci win the Mattia Bellucci vs Martin Landaluce match by a set score of 2-0?',
      { yes_sub_title: 'Mattia Bellucci wins 2-0' },
    ))).toBeNull();
  });

  test('fold/space-insensitive compare (diacritics + spacing drift)', () => {
    const r = matchTemplate(row('Atletico Mineiro vs Botafogo Winner?', { yes_sub_title: 'Atlético  Mineiro' }));
    expect(r!.subject_raw).toBe('Atletico Mineiro');
  });

  test('the three siblings share a fixture-symmetric canonical_event, only the SUBJECT differs', () => {
    const legs = ['Arsenal', 'Everton', 'Tie'].map((yst) =>
      matchTemplate(row(TITLE, { yes_sub_title: yst }))!,
    );
    const ces = legs.map((tpl) => deriveCanonicalEvent({
      template: tpl,
      canonical_subject: tpl.subject_raw === 'Draw' ? 'Draw' : tpl.subject_raw,
      canonicalParticipants: tpl.subject_raw === 'Draw'
        ? ['Arsenal', 'Draw', 'Everton']                      // resolveSubjectAndParticipants adds the subject
        : [tpl.subject_raw, tpl.participants_raw[0]!].sort(),
      categoryUnified: 'sports',
      title: TITLE, nonKalshiEventTitle: null, eventDateIso: null,
    }));
    expect(ces[0]).toBe('Arsenal vs Everton');
    expect(new Set(ces).size).toBe(1);                        // ONE fixture key
    const subjects = legs.map((l) => l.subject_raw);
    expect(new Set(subjects).size).toBe(3);                   // THREE distinct subjects
    expect(subjects.sort()).toEqual(['Arsenal', 'Draw', 'Everton']);
  });

  // Kalshi runs several independent three-way partitions of one baseball
  // game at different innings cut-points. The "…first N innings tie?" title
  // must not fall through to the generic H2H_VS_RX, whose lazy capture would
  // eat the suffix and mint junk KB entities that alias-collide across
  // marks, leaving different innings-cut-point tie nodes identical on every
  // gated field.
  test('innings-tie leg: fixture parses CLEAN, suffix + metric_scope carry the mark', () => {
    const r = matchTemplate(row('Arizona vs Los Angeles D first 3 innings tie?', {
      yes_sub_title: 'Tie', event_ticker: 'KXMLBF3-26JUL10ARILAD-TIE',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Draw');
    // The suffix must not leak into the participant.
    expect(r!.participants_raw).toEqual(['Arizona', 'Los Angeles D']);
    expect(r!.canonical_event_suffix).toBe('first 3 innings');
    expect(r!.metric_scope).toBe('first_3');
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.outcome_label).toBe('draw');
  });

  test('innings-tie leg: F3 / F5 / F7 of ONE fixture get THREE distinct canonical_events + scopes', () => {
    const compose = (mark: number): { ce: string; scope: string | null | undefined } => {
      const title = `Arizona vs Los Angeles D first ${mark} innings tie?`;
      const r = matchTemplate(row(title, {
        yes_sub_title: 'Tie', event_ticker: `KXMLBF${mark}-26JUL10ARILAD-TIE`,
      }))!;
      return {
        ce: deriveCanonicalEvent({
          template: r,
          canonical_subject: 'Draw',
          canonicalParticipants: ['Arizona Diamondbacks', 'Los Angeles Dodgers'],
          categoryUnified: 'sports',
          title, nonKalshiEventTitle: null, eventDateIso: null,
        }),
        scope: r.metric_scope,
      };
    };
    const legs = [3, 5, 7].map(compose);
    expect(legs[0]!.ce).toBe('Arizona Diamondbacks vs Los Angeles Dodgers first 3 innings');
    expect(legs[1]!.ce).toBe('Arizona Diamondbacks vs Los Angeles Dodgers first 5 innings');
    expect(legs[2]!.ce).toBe('Arizona Diamondbacks vs Los Angeles Dodgers first 7 innings');
    expect(new Set(legs.map((l) => l.ce)).size).toBe(3);
    expect(legs.map((l) => l.scope)).toEqual(['first_3', 'first_5', 'first_7']);
  });

  test('innings-tie leg: an UNNAMED mark is refused (unshaped beats a borrowed mark)', () => {
    expect(matchTemplate(row('Arizona vs Los Angeles D first 4 innings tie?', {
      yes_sub_title: 'Tie', event_ticker: 'KXMLBF4-26JUL10ARILAD-TIE',
    }))).toBeNull();
  });

  test('innings-tie leg: a ticker/title mark DISAGREEMENT is refused', () => {
    expect(matchTemplate(row('Arizona vs Los Angeles D first 3 innings tie?', {
      yes_sub_title: 'Tie', event_ticker: 'KXMLBF7-26JUL10ARILAD-TIE',
    }))).toBeNull();
  });

  test('innings-tie leg: the WINNER siblings stay unshaped (B_SUFFIX_GUARDS, unchanged)', () => {
    expect(matchTemplate(row('Will Arizona be the Arizona vs Los Angeles D first 3 innings winner?', {
      yes_sub_title: 'Arizona', event_ticker: 'KXMLBF3-26JUL10ARILAD-ARI',
    }))).toBeNull();
  });

  test('"Game N: A at B Winner?" with yst=Tie → Draw leg keeps the game-N anchor (suffix)', () => {
    const r = matchTemplate(row('Game 5: Anaheim at Vegas Winner?', { yes_sub_title: 'Tie' }));
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.canonical_event_override).toBe('Anaheim vs Vegas');
    expect(r!.canonical_event_suffix).toBe('game 5');
    // The draw leg lands on the SAME per-game key as the team legs.
    const ce = deriveCanonicalEvent({
      template: r!,
      canonical_subject: 'Draw',
      canonicalParticipants: ['Anaheim Ducks', 'Vegas Golden Knights'],
      categoryUnified: 'sports',
      title: 'Game 5: Anaheim at Vegas Winner?', nonKalshiEventTitle: null, eventDateIso: null,
    });
    expect(ce).toBe('Anaheim Ducks vs Vegas Golden Knights game 5');
  });

  test('"Game N: A at B Winner?" with yst=away team → subject flips', () => {
    const r = matchTemplate(row('Game 5: Anaheim at Vegas Winner?', { yes_sub_title: 'Vegas' }));
    expect(r!.subject_raw).toBe('Vegas');
    expect(r!.participants_raw).toEqual(['Anaheim']);
  });

  test('non-Kalshi platforms are untouched (no yst exists)', () => {
    const r = matchTemplate(row('Lakers vs Celtics', { platform: 'polymarket' }));
    expect(r!.subject_raw).toBe('Lakers');
    expect(r!.participants_raw).toEqual(['Celtics']);
  });

  test('Kalshi row WITHOUT yst keeps the existing first-team behavior', () => {
    const r = matchTemplate(row(TITLE));
    expect(r!.subject_raw).toBe('Arsenal');
    expect(r!.participants_raw).toEqual(['Everton']);
  });
});

describe('matchTemplate — "be the matchup" titles end UNSHAPED (B and C both refuse)', () => {
  test('vs-form (B leak: junk participants, question ids 145226-145229)', () => {
    expect(matchTemplate(row(
      'Will New York vs Cleveland be the matchup in the 2026 Pro Basketball Eastern Conference Finals?',
      { yes_sub_title: 'New York vs Cleveland' },
    ))).toBeNull();
    expect(matchTemplate(row(
      'Will San Antonio vs Philadelphia be the matchup in the 2025-26 Pro Basketball Finals?',
    ))).toBeNull();
  });
  test('and-form (C leak: championship_winner with a matchup-pair subject, 241 live rows)', () => {
    expect(matchTemplate(row(
      'Will Montreal and Minnesota be the matchup in the 2026 Pro Hockey Championship Series?',
    ))).toBeNull();
    expect(matchTemplate(row(
      'Will Boston vs Cincinnati be the matchup in the Pro Baseball Championship Series?',
    ))).toBeNull();
  });
});

describe('matchTemplate — Template AC finish-top-N (year now optional)', () => {
  test('with year (golf, Polymarket format) — canonical_event keeps year prefix', () => {
    const r = matchTemplate(row('Will Tiger Woods finish in the Top 10 at the 2026 PGA Championship?', {
      platform: 'polymarket',
      category_unified: 'sports',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-AC');
    expect(r!.value_primary).toBe(10);
    expect(r!.value_unit).toBe('rank');
    expect(r!.canonical_event_override).toBe('2026 pga championship');
  });

  test('without year (Kalshi NASCAR format) — canonical_event omits year', () => {
    const r = matchTemplate(row('Will Kris Wright finish in the top 3 at NASCAR ECOSAVE 200?', {
      platform: 'kalshi',
      category_unified: 'sports',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-AC');
    expect(r!.value_primary).toBe(3);
    expect(r!.canonical_event_override).toBe('nascar ecosave 200');
  });

  test('without year, doubled-NASCAR prefix preserved (Kalshi quirk)', () => {
    const r = matchTemplate(row('Will William Byron finish in the top 20 at NASCAR NASCAR All-Star Race?', {
      platform: 'kalshi',
      category_unified: 'sports',
    }));
    expect(r).not.toBeNull();
    expect(r!.value_primary).toBe(20);
    expect(r!.canonical_event_override).toBe('nascar nascar all-star race');
  });
});

describe('matchTemplate — Template AF (Kalshi totals / BTTS via event_title)', () => {
  // Cross-platform alignment goal: Kalshi totals ("Will over 2.5 goals be
  // scored?") and BTTS ("Will both teams score?") have no fixture context in
  // the title — they need to read event_title. After Template AF + the
  // extended post-process (normalizeFixtureCanonicalEvent across all sports
  // shapes), these line up with Polymarket Template H (O/U) and Template L
  // (BTTS) for the same fixture.
  test('"Will over 2.5 goals be scored?" → Template H-compatible monotonic_threshold', () => {
    const r = matchTemplate(row('Will over 2.5 goals be scored?', {
      platform: 'kalshi',
      category_unified: 'sports',
      event_title: 'Remo vs Bahia: Total Goals',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-AF');
    expect(r!.subject_raw).toBe('Remo');
    expect(r!.participants_raw).toEqual(['Bahia']);
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(2.5);
    expect(r!.value_unit).toBe('goals');
    expect(r!.event_kind).toBe('match_total_metric');
  });

  test('"Will under 1.5 cards be scored?" → below direction', () => {
    const r = matchTemplate(row('Will under 1.5 cards be scored?', {
      platform: 'kalshi',
      category_unified: 'sports',
      event_title: 'AC Milan vs Atalanta: Total Cards',
    }));
    expect(r).not.toBeNull();
    expect(r!.condition_direction).toBe('below');
    expect(r!.value_primary).toBe(1.5);
    expect(r!.value_unit).toBe('cards');
  });

  test('"Will both teams score?" → Template L-compatible binary_event BTTS', () => {
    const r = matchTemplate(row('Will both teams score?', {
      platform: 'kalshi',
      category_unified: 'sports',
      event_title: 'Lorient vs Le Havre: BTTS',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-AF');
    expect(r!.subject_raw).toBe('Lorient');
    expect(r!.participants_raw).toEqual(['Le Havre']);
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.event_kind).toBe('both_teams_score');
  });

  test('refuses when event_title is missing (no fixture context)', () => {
    const r = matchTemplate(row('Will over 2.5 goals be scored?', {
      platform: 'kalshi',
      category_unified: 'sports',
      event_title: null,
    }));
    expect(r).toBeNull();
  });

  test('refuses when event_title is not a fixture ("X vs Y")', () => {
    const r = matchTemplate(row('Will over 2.5 goals be scored?', {
      platform: 'kalshi',
      category_unified: 'sports',
      event_title: 'Random tournament summary',
    }));
    expect(r).toBeNull();
  });
});

describe('deriveCanonicalEvent', () => {
  const matchWinnerTpl = (): TemplateMatch => ({
    subject_raw: 'X',
    participants_raw: ['Y'],
    condition_shape: 'binary_event',
    condition_direction: null,
    condition_metric: null,
    temporal_semantics: null,
    value_primary: null,
    value_secondary: null,
    value_unit: null,
    outcome_label: null,
    event_kind: 'match_winner',
    entity_type: 'team',
    source_tag: 'text-deterministic-B',
  });

  test('KB-resolved canonical names override raw title (spelling-drift fix)', () => {
    // Limitless's "FSV Mainz 05" and Polymarket's "1. FSV Mainz 05" KB-resolve
    // to the same entity (canonical = "1. FSV Mainz 05"), so both produce the
    // SAME canonical_event regardless of the raw title spelling.
    const limitlessSide = deriveCanonicalEvent({
      template: matchWinnerTpl(),
      canonical_subject: '1. FSV Mainz 05',
      canonicalParticipants: ['1. FC Heidenheim 1846'],
      categoryUnified: 'sports',
      title: 'FSV Mainz 05 vs 1. FC Heidenheim: 11+ total corners?',
      nonKalshiEventTitle: null,
      eventDateIso: '2026-05-10',
    });
    const polymarketSide = deriveCanonicalEvent({
      template: matchWinnerTpl(),
      canonical_subject: '1. FSV Mainz 05',
      canonicalParticipants: ['1. FC Heidenheim 1846'],
      categoryUnified: 'sports',
      title: 'Will 1. FC Heidenheim 1846 beat 1. FSV Mainz 05?',
      nonKalshiEventTitle: '1. FC Heidenheim 1846 vs. 1. FSV Mainz 05 - Match Winner',
      eventDateIso: '2026-05-10',
    });
    expect(limitlessSide).toBe(polymarketSide);
    expect(limitlessSide).toBe('1. FC Heidenheim 1846 vs 1. FSV Mainz 05');
  });

  test('alphabetizes resolved-name fixtures (A vs B and B vs A converge)', () => {
    const ab = deriveCanonicalEvent({
      template: matchWinnerTpl(),
      canonical_subject: 'Atalanta',
      canonicalParticipants: ['AC Milan'],
      categoryUnified: 'sports',
      title: 'X', nonKalshiEventTitle: null, eventDateIso: null,
    });
    const ba = deriveCanonicalEvent({
      template: matchWinnerTpl(),
      canonical_subject: 'AC Milan',
      canonicalParticipants: ['Atalanta'],
      categoryUnified: 'sports',
      title: 'Y', nonKalshiEventTitle: null, eventDateIso: null,
    });
    expect(ab).toBe(ba);
    expect(ab).toBe('AC Milan vs Atalanta');
  });

  test('works for monotonic_threshold (Template H O/U) and categorical_outcome (Template Z exact_score)', () => {
    const ouTpl: TemplateMatch = {
      ...matchWinnerTpl(),
      condition_shape: 'monotonic_threshold',
      condition_direction: 'above',
      value_primary: 2.5,
      value_unit: 'goals',
      event_kind: 'match_total_metric',
    };
    const exactTpl: TemplateMatch = {
      ...matchWinnerTpl(),
      condition_shape: 'categorical_outcome',
      value_primary: 2,
      value_secondary: 1,
      value_unit: 'goals',
      outcome_label: '2-1',
      event_kind: 'exact_score',
    };
    const winner = deriveCanonicalEvent({
      template: matchWinnerTpl(),
      canonical_subject: 'Atalanta', canonicalParticipants: ['AC Milan'],
      categoryUnified: 'sports', title: 'X', nonKalshiEventTitle: null, eventDateIso: null,
    });
    const ou = deriveCanonicalEvent({
      template: ouTpl,
      canonical_subject: 'Atalanta', canonicalParticipants: ['AC Milan'],
      categoryUnified: 'sports', title: 'Y', nonKalshiEventTitle: null, eventDateIso: null,
    });
    const exact = deriveCanonicalEvent({
      template: exactTpl,
      canonical_subject: 'Atalanta', canonicalParticipants: ['AC Milan'],
      categoryUnified: 'sports', title: 'Z', nonKalshiEventTitle: null, eventDateIso: null,
    });
    // All three shapes for the same fixture produce the SAME canonical_event.
    expect(winner).toBe('AC Milan vs Atalanta');
    expect(ou).toBe('AC Milan vs Atalanta');
    expect(exact).toBe('AC Milan vs Atalanta');
  });

  test('falls back to text normalization when participants array does NOT carry exactly one opponent', () => {
    const result = deriveCanonicalEvent({
      template: matchWinnerTpl(),
      canonical_subject: '1. FC Heidenheim 1846',
      canonicalParticipants: [],
      categoryUnified: 'sports',
      title: '1. FC Heidenheim 1846 vs. 1. FSV Mainz 05',
      nonKalshiEventTitle: null,
      eventDateIso: null,
    });
    expect(result).toBe('1. FSV Mainz 05 vs 1. Heidenheim');
  });

  test('event-anchored kinds (championship_winner) use normalizeEventNoun, not fixture path', () => {
    const champTpl: TemplateMatch = {
      ...matchWinnerTpl(),
      condition_shape: 'monotonic_threshold',
      condition_direction: 'below',
      value_primary: 1,
      value_unit: 'rank',
      event_kind: 'championship_winner',
      canonical_event_override: 'Will Argentina win the 2026 FIFA World Cup?',
    };
    const result = deriveCanonicalEvent({
      template: champTpl,
      canonical_subject: 'Argentina',
      canonicalParticipants: [],
      categoryUnified: 'sports',
      title: champTpl.canonical_event_override!,
      nonKalshiEventTitle: null,
      eventDateIso: '2026-06-21',
    });
    // Key invariant: must not fall through to the fixture branch (participants is empty).
    expect(result.toLowerCase()).toContain('2026');
    expect(result.toLowerCase()).toContain('world cup');
  });

  test('non-sports categories pass through raw (no fixture normalization)', () => {
    const cryptoTpl: TemplateMatch = {
      ...matchWinnerTpl(),
      condition_shape: 'monotonic_threshold',
      event_kind: 'price_threshold',
    };
    const result = deriveCanonicalEvent({
      template: cryptoTpl,
      canonical_subject: 'BTC',
      canonicalParticipants: [],
      categoryUnified: 'crypto',
      title: 'Will BTC reach $100k by Dec 31?',
      nonKalshiEventTitle: null,
      eventDateIso: null,
    });
    expect(result).toBe('Will BTC reach $100k by Dec 31?');
  });
});

describe('Template B — set-winner must not collapse into the match-winner question', () => {
  test('Set N Winner rides the set number on outcome_label; match stays null', () => {
    const set1 = matchTemplate(row('Set 1 Winner: Tabilo vs Kovacevic', { category_unified: 'sports' }));
    const set2 = matchTemplate(row('Set 2 Winner: Tabilo vs Kovacevic', { category_unified: 'sports' }));
    const match = matchTemplate(row('Valencia: Tabilo vs Kovacevic', { category_unified: 'sports' }));
    expect(set1?.source_tag).toBe('text-deterministic-B');
    expect(set1!.subject_raw).toBe('Tabilo');
    expect(set1!.participants_raw).toEqual(['Kovacevic']);
    expect(set1!.outcome_label).toBe('set 1');
    expect(set2!.outcome_label).toBe('set 2');
    expect(match?.source_tag).toBe('text-deterministic-B');
    expect(match!.outcome_label).toBeNull();
  });
});

describe('Template AE — coalition variants must be distinct questions', () => {
  const ae = (title: string) => matchTemplate(row(title, { category_unified: 'election' }));
  test('different party sets get distinct sorted outcome_labels', () => {
    const pnl = ae('Will the next governing coalition of Romania include PNL?');
    const psdPnl = ae('Will the next governing coalition of Romania include PSD + PNL?');
    const pnlPsd = ae('Will the next governing coalition of Romania include PNL + PSD?');
    expect(pnl?.source_tag).toBe('text-deterministic-AE');
    expect(pnl!.outcome_label).toBe('pnl');
    expect(psdPnl!.outcome_label).toBe('pnl+psd');
    expect(pnlPsd!.outcome_label).toBe('pnl+psd');
    expect(pnl!.outcome_label).not.toBe(psdPnl!.outcome_label);
  });
});

describe('Template N — candle window discriminates same-open candles', () => {
  const n = (title: string, slug: string | null = null) =>
    matchTemplate(row(title, { category_unified: 'crypto', slug }));
  test('window from slug (5m / 15m / 4h / hourly)', () => {
    expect(n('BTC Up or Down - 5 Min', 'btc-updown-5m-1778702400')!.outcome_label).toBe('5m');
    expect(n('BTC Up or Down - 15 Min', 'btc-updown-15m-1778702411970')!.outcome_label).toBe('15m');
    expect(n('Bitcoin Up or Down - May 13, 4:00PM-8:00PM ET', 'btc-updown-4h-1778702400')!.outcome_label).toBe('4h');
    expect(n('BNB Up or Down - Hourly', 'bnb-up-or-down-hourly-1778702401480')!.outcome_label).toBe('1h');
  });
  test('window from title duration suffix and time-range when slug absent', () => {
    expect(n('BNB Up or Down - 15 Min')!.outcome_label).toBe('15m');
    expect(n('Bitcoin Up or Down - May 13, 4:00PM-4:05PM ET')!.outcome_label).toBe('5m');
    expect(n('Bitcoin Up or Down - May 13, 4:00PM-4:15PM ET')!.outcome_label).toBe('15m');
  });
  test('bare single time (no parseable window) → null label', () => {
    const bare = n('Bitcoin Up or Down - May 13, 4PM ET');
    expect(bare?.source_tag).toBe('text-deterministic-N');
    expect(bare!.outcome_label).toBeNull();
  });
});

describe('Template U — esports sub-game props must NOT collapse into one question', () => {
  const ctx = 'Dota 2: 1win essence vs Power Ranger (BO3) - Group Stage';
  const u = (title: string): TemplateMatch | null =>
    matchTemplate(row(title, { category_unified: 'sports', event_match_context: ctx }));

  test('distinct binary props in the same game get DISTINCT outcome_labels', () => {
    const roshan = u('Game 1: Both Teams Beat Roshan?');
    const rampage = u('Game 1: Any Player Rampage?');
    expect(roshan?.source_tag).toBe('text-deterministic-U');
    expect(rampage?.source_tag).toBe('text-deterministic-U');
    expect(roshan!.outcome_label).toBe('both teams beat roshan | game 1');
    expect(rampage!.outcome_label).toBe('any player rampage | game 1');
    expect(roshan!.outcome_label).not.toBe(rampage!.outcome_label);
    // Binary props are match_event_prop (edge-inert dedicated kind), never
    // the valued totals kind match_total_metric.
    expect(roshan!.event_kind).toBe('match_event_prop');
    expect(rampage!.event_kind).toBe('match_event_prop');
  });

  test('same prop in different games gets DISTINCT outcome_labels', () => {
    const g1 = u('Game 1: Both Teams Destroy Barracks?');
    const g3 = u('Game 3: Both Teams Destroy Barracks?');
    expect(g1!.outcome_label).toBe('both teams destroy barracks | game 1');
    expect(g3!.outcome_label).toBe('both teams destroy barracks | game 3');
    expect(g1!.outcome_label).not.toBe(g3!.outcome_label);
  });

  test('First Blood in Game N captures predicate + game', () => {
    const fb1 = u('First Blood in Game 1?');
    const fb2 = u('First Blood in Game 2?');
    expect(fb1!.outcome_label).toBe('first blood | game 1');
    expect(fb2!.outcome_label).toBe('first blood | game 2');
  });

  test('per-game O/U markets differ only by game → distinct outcome_labels', () => {
    const g1 = u('Total Kills Over/Under 27.5 in Game 1?');
    const g2 = u('Total Kills Over/Under 27.5 in Game 2?');
    expect(g1!.value_primary).toBe(27.5);
    expect(g1!.value_unit).toBe('kill');
    expect(g1!.outcome_label).toBe('game 1');
    expect(g2!.outcome_label).toBe('game 2');
    expect(g1!.outcome_label).not.toBe(g2!.outcome_label);
    expect(g1!.event_kind).toBe('match_total_metric');
  });

  test('match-level plain O/U (no game scope) keeps a null label', () => {
    const m = u('O/U 0.5 Maps');
    expect(m?.source_tag).toBe('text-deterministic-U');
    expect(m!.outcome_label).toBeNull();
  });

  test('Map N props are scoped just like Game N', () => {
    const map1 = u('Map 1: Both Teams Destroy Barracks?');
    const map2 = u('Map 2: Both Teams Destroy Barracks?');
    expect(map1!.outcome_label).toBe('both teams destroy barracks | map 1');
    expect(map2!.outcome_label).toBe('both teams destroy barracks | map 2');
  });
});

// Limitless-native handlers (L1-L5)

/** Build a Limitless CandidateRow. Defaults platform='limitless'. */
function lrow(title: string, overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    ...row(title),
    platform: 'limitless',
    end_date: '2026-06-30T00:00:00Z',
    ...overrides,
  } as CandidateRow;
}

describe('L1 — Limitless match_winner (football 1X2 + esports H2H)', () => {
  const mw = { limitless_market_type: 'match_winner', limitless_start_ts: '1782327600' };

  test('football home-win leg → match_winner, subject=home, participant=away, date from epoch', () => {
    const r = matchTemplate(lrow('World Cup, Bosnia & Herzegovina vs Qatar, Jun 24, 2026: Bosnia & Herzegovina', {
      ...mw, limitless_home_team: 'Bosnia & Herzegovina', limitless_away_team: 'Qatar', limitless_sport_type: 'football',
    }));
    expect(r!.source_tag).toBe('limitless:match-winner');
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.subject_raw).toBe('Bosnia & Herzegovina');
    expect(r!.participants_raw).toEqual(['Qatar']);
    expect(r!.outcome_label).toBeNull();
    expect(r!.sport_canonical).toBe('soccer');
    expect(r!.condition_date_override).toBe('2026-06-24T19:00:00Z');
    expect(r!.canonical_event_override).toBeUndefined();
  });

  test('football away-win leg → subject=away, participant=home', () => {
    const r = matchTemplate(lrow('Ligue 1, Metz vs Lorient, May 10, 2026: Lorient', {
      ...mw, limitless_home_team: 'Metz', limitless_away_team: 'Lorient', limitless_sport_type: 'football',
    }));
    expect(r!.subject_raw).toBe('Lorient');
    expect(r!.participants_raw).toEqual(['Metz']);
  });

  test('football draw leg → nativeDraw() subject="Draw", both teams in participants (fix)', () => {
    // The draw slot's subject is the DRAW OUTCOME, not the home team, matching
    // the Template-B/J convention.
    const r = matchTemplate(lrow('LaLiga, Celta Vigo vs Levante, May 12, 2026: Draw', {
      ...mw, limitless_home_team: 'Celta Vigo', limitless_away_team: 'Levante', limitless_sport_type: 'football',
    }));
    expect(r!.outcome_label).toBe('draw');
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.participants_raw).toEqual(['Celta Vigo', 'Levante']);
  });

  test('esports H2H (sportType null, esportTitle) → cs-go maps to cs2 sport_canonical', () => {
    const r = matchTemplate(lrow('TheMongolz vs Spirit: Spirit', {
      ...mw, limitless_home_team: 'TheMongolz', limitless_away_team: 'Spirit', limitless_esport_title: 'cs-go',
    }));
    expect(r!.subject_raw).toBe('Spirit');
    expect(r!.participants_raw).toEqual(['TheMongolz']);
    expect(r!.sport_canonical).toBe('cs2');
    expect(r!.entity_type).toBe('team');
  });

  test('leading-space homeTeam still aligns after trim', () => {
    const r = matchTemplate(lrow('REBORN vs Beşiktaş Esports: REBORN', {
      ...mw, limitless_home_team: 'REBORN', limitless_away_team: 'Beşiktaş Esports', limitless_esport_title: 'valorant',
    }));
    expect(r!.subject_raw).toBe('REBORN');
  });

  test('suffix not matching home/away/Draw → refuse', () => {
    const r = matchTemplate(lrow('A vs B: Something Else', {
      ...mw, limitless_home_team: 'A', limitless_away_team: 'B',
    }));
    expect(r).toBeNull();
  });

  test('REGRESSION: real org "Team WE" is native-verified so the anon bail must not drop it', () => {
    // "Team WE" (LPL org) false-positives ANON_ROLE_NOUN_RX (`team` + 2-letter
    // token). L1 subjects come from structured pandascore homeTeam/awayTeam,
    // so the template asserts subject_native_verified and tryNormalizeText
    // skips isAnonSubject for it, without changing the shared belt.
    const r = matchTemplate(lrow('Team WE vs Ninjas in Pyjamas: Team WE', {
      ...mw, limitless_home_team: 'Team WE', limitless_away_team: 'Ninjas in Pyjamas',
      limitless_esport_title: 'league-of-legends',
    }));
    expect(r!.source_tag).toBe('limitless:match-winner');
    expect(r!.subject_raw).toBe('Team WE');
    expect(r!.participants_raw).toEqual(['Ninjas in Pyjamas']);
    expect(r!.sport_canonical).toBe('league of legends');
    expect(r!.subject_native_verified).toBe(true);
    // "Team WE" still trips isAnonSubject on its own; only the
    // native-verified flag routes around it. PM text-label placeholders
    // ("Team A") keep bailing.
    expect(isAnonSubject('Team WE')).toBe(true);
    expect(isAnonSubject('Team A')).toBe(true);
    expect(isAnonSubject('Team USA')).toBe(false);
  });

  test('sibling away leg of the same fixture also carries the native-verified flag', () => {
    const r = matchTemplate(lrow('Team WE vs Ninjas in Pyjamas: Ninjas in Pyjamas', {
      ...mw, limitless_home_team: 'Team WE', limitless_away_team: 'Ninjas in Pyjamas',
      limitless_esport_title: 'league-of-legends',
    }));
    expect(r!.subject_raw).toBe('Ninjas in Pyjamas');
    expect(r!.participants_raw).toEqual(['Team WE']);
    expect(r!.subject_native_verified).toBe(true);
  });
});

describe('L2 — Limitless election colon-suffix', () => {
  const ev = { category_unified: 'election' as const, limitless_event_id: 'evt1' };

  test('"Election Winner: <Person>" → election_outcome_winner, subject=person', () => {
    const r = matchTemplate(lrow('2026 Seoul Mayoral Election Winner: Oh Se-hoon', ev));
    expect(r!.source_tag).toBe('limitless:election');
    expect(r!.event_kind).toBe('election_outcome_winner');
    expect(r!.subject_raw).toBe('Oh Se-hoon');
    expect(r!.condition_shape).toBe('categorical_outcome');
    expect(r!.canonical_event_override).toBe('2026 Seoul Mayoral Election Winner');
  });

  test('double-colon "...: Party Winner: <Party>" splits on LAST colon + strips (PPP)', () => {
    const r = matchTemplate(lrow('2026 South Korean Local Elections: Party Winner: People Power Party (PPP)', ev));
    expect(r!.subject_raw).toBe('People Power Party');
    expect(r!.canonical_event_override).toBe('2026 South Korean Local Elections: Party Winner');
  });

  test('"Other" catch-all is refused', () => {
    const r = matchTemplate(lrow('Colombia Presidential Election: Other', ev));
    expect(r).toBeNull();
  });

  test('no _limitlessEventId → not claimed by election handler', () => {
    const r = matchTemplate(lrow('Netanyahu out by end of 2026?', { category_unified: 'politics', limitless_event_id: null }));
    expect(r?.source_tag).not.toBe('limitless:election');
  });
});

describe('L3 — Limitless crypto buckets + ATH', () => {
  test('"≥80k" bucket → point_in_time above, value 80000, USD, CF Benchmarks', () => {
    const r = matchTemplate(lrow('Bitcoin price on June 30?: ≥80k', { category_unified: 'crypto' }));
    expect(r!.source_tag).toBe('limitless:crypto-bucket');
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(80000);
    expect(r!.value_unit).toBe('usd');
    expect(r!.resolution_source).toBe('CF Benchmarks');
    expect(r!.canonical_event_override).toBe('Bitcoin price on June 30');
  });

  test('range bucket "50-60k" → range_snapshot lo/hi', () => {
    const r = matchTemplate(lrow('Bitcoin price on June 30?: 50-60k', { category_unified: 'crypto' }));
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.value_primary).toBe(50000);
    expect(r!.value_secondary).toBe(60000);
  });

  test('unitless range (ETH/SOL) "2500-3000" → no k multiplier', () => {
    const r = matchTemplate(lrow('Ethereum price on June 30?: 2500-3000', { category_unified: 'crypto' }));
    expect(r!.value_primary).toBe(2500);
    expect(r!.value_secondary).toBe(3000);
  });

  test('ATH binary → value_primary null (dynamic strike), by_date', () => {
    const r = matchTemplate(lrow('Bitcoin all time high by September 30, 2026?', { category_unified: 'crypto' }));
    expect(r!.source_tag).toBe('limitless:crypto-ath');
    expect(r!.value_primary).toBeNull();
    expect(r!.subject_raw).toBe('Bitcoin');
    expect(r!.canonical_event_override).toBe('Bitcoin all time high');
  });
});

describe('L4 — Limitless sports winner / award / group / squad / advance ladders', () => {
  const base = { category_unified: 'sports' as const, limitless_event_id: 'e1' };

  test('overall winner → championship_winner rank<=1', () => {
    const r = matchTemplate(lrow('UEFA Champions League Winner: Inter', base));
    expect(r!.source_tag).toBe('limitless:sports-winner');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.value_primary).toBe(1);
    expect(r!.value_unit).toBe('rank');
    expect(r!.subject_raw).toBe('Inter');
  });

  test('group winner keeps group letter in canonical_event', () => {
    const r = matchTemplate(lrow('FIFA World Cup Group A Winner: Mexico', base));
    expect(r!.canonical_event_override).toBe('FIFA World Cup Group A Winner');
    expect(r!.entity_type).toBe('team');
  });

  test('Top Scorer (Nation) → entity_type team (nation), not person', () => {
    const r = matchTemplate(lrow('FIFA World Cup: Top Scorer (Nation): France', base));
    expect(r!.entity_type).toBe('team');
    expect(r!.subject_raw).toBe('France');
  });

  test('Top Goalscorer (player) → entity_type person', () => {
    const r = matchTemplate(lrow('2026 FIFA World Cup: Top Goalscorer: Lionel Messi', base));
    expect(r!.entity_type).toBe('person');
  });

  test('squad selection → independent binary_event (kind=other)', () => {
    const r = matchTemplate(lrow('2026 FIFA World Cup: Player to make Brazil Squad: Alisson', base));
    expect(r!.source_tag).toBe('limitless:squad');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.subject_raw).toBe('Alisson');
  });

  test('advance/qualify → stage_advance binary_event', () => {
    const r = matchTemplate(lrow('FIFA World Cup: Team to advance to Knockout Stages: Brazil', base));
    expect(r!.source_tag).toBe('limitless:advance');
    expect(r!.event_kind).toBe('stage_advance');
  });

  test('MVP single-award → award_winner categorical', () => {
    const r = matchTemplate(lrow('Who will be named HLTV MVP of PGL Astana 2026?: m0NESY', base));
    expect(r!.source_tag).toBe('limitless:sports-mvp');
    expect(r!.event_kind).toBe('award_winner');
  });

  test('next manager → personnel_move, candidate=subject, club=participant (cross-platform merge)', () => {
    const r = matchTemplate(lrow('Next Manchester United manager?: Thomas Tuchel', base));
    expect(r!.source_tag).toBe('limitless:next-manager');
    expect(r!.event_kind).toBe('personnel_move');
    expect(r!.condition_shape).toBe('categorical_outcome');
    expect(r!.subject_raw).toBe('Thomas Tuchel');
    expect(r!.participants_raw).toEqual(['Manchester United']);
    expect(r!.entity_type).toBe('person');
  });

  test('"Which continent will win…?" is claimed here, NOT Template C', () => {
    const r = matchTemplate(lrow('Which continent will win the 2026 FIFA World Cup?: Europe', base));
    expect(r!.source_tag).toBe('limitless:sports-winner');
    expect(r!.entity_type).toBe('location');
  });

  test('"Champion: Other" catch-all refused', () => {
    const r = matchTemplate(lrow('2026 NBA Champion: Other', base));
    expect(r).toBeNull();
  });
});

describe('L5 — Limitless economic ladders', () => {
  const ec = { category_unified: 'economic' as const };

  test('inflation INTERIOR point bucket → direction "at" (NOT above)', () => {
    const r = matchTemplate(lrow('May Inflation US - Annual: 3.7%', ec));
    expect(r!.source_tag).toBe('limitless:econ-cpi');
    expect(r!.condition_direction).toBe('at');
    expect(r!.value_primary).toBe(3.7);
    expect(r!.canonical_event_override).toContain('CPI YoY');
  });

  test('inflation ≤ cap → below; ≥ cap → above', () => {
    expect(matchTemplate(lrow('April Inflation US - Annual: ≤3.1%', ec))!.condition_direction).toBe('below');
    expect(matchTemplate(lrow('May Inflation US - Annual: ≥4.4%', ec))!.condition_direction).toBe('above');
  });

  test('Monthly inflation → CPI MoM canonical_event (distinct from YoY)', () => {
    const r = matchTemplate(lrow('April Inflation US - Monthly: 0.4%', ec));
    expect(r!.canonical_event_override).toContain('CPI MoM');
  });

  test('jobs range bucket → range_snapshot, k multiplier, count/jobs', () => {
    const r = matchTemplate(lrow('How many jobs added in May?: 100k – 150k', ec));
    expect(r!.source_tag).toBe('limitless:econ-jobs');
    expect(r!.value_primary).toBe(100000);
    expect(r!.value_secondary).toBe(150000);
    expect(r!.value_unit).toBe('jobs');
  });

  test('Fed decision CUMULATIVE cut → below/−50 (policy_action, bps)', () => {
    const r = matchTemplate(lrow('Fed Decision in July?: 50+ bps decrease', ec));
    expect(r!.source_tag).toBe('limitless:econ-fed');
    expect(r!.event_kind).toBe('policy_action');
    expect(r!.condition_direction).toBe('below');
    expect(r!.value_primary).toBe(-50);
    expect(r!.value_unit).toBe('bps');
  });

  test('Fed decision CUMULATIVE hike → above/+50', () => {
    const r = matchTemplate(lrow('Fed Decision in July?: 50+ bps increase', ec));
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(50);
  });

  test('Fed decision EXACT moves → at/signed (hike +25, cut −25 stay gated-field distinct)', () => {
    const hike = matchTemplate(lrow('Fed Decision in July?: 25 bps increase', ec));
    const cut = matchTemplate(lrow('Fed Decision in July?: 25 bps decrease', ec));
    expect(hike!.condition_direction).toBe('at');
    expect(hike!.value_primary).toBe(25);
    expect(cut!.condition_direction).toBe('at');
    expect(cut!.value_primary).toBe(-25);
  });

  test('Fed No change → at/0 bps', () => {
    const r = matchTemplate(lrow('Fed Decision in June?: No change', ec));
    expect(r!.value_primary).toBe(0);
    expect(r!.condition_direction).toBe('at');
  });

  test('NVDA monthly hit → price_threshold above, USD', () => {
    const r = matchTemplate(lrow('What will NVIDIA (NVDA) hit in May 2026?: above $232', ec));
    expect(r!.source_tag).toBe('limitless:econ-stock');
    expect(r!.subject_raw).toBe('NVDA');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(232);
  });
});

describe('Template N candle fix — Limitless equity/commodity candles', () => {
  test('"Tesla (TSLA) Up or Down - Weekly" → N, subject=TSLA', () => {
    const r = matchTemplate(lrow('Tesla (TSLA) Up or Down - Weekly', { category_unified: 'crypto' }));
    expect(r!.source_tag).toBe('text-deterministic-N');
    expect(r!.subject_raw).toBe('TSLA');
    expect(r!.outcome_label).toBe('1w');
  });

  test('long ticker "Oil (UKOILSPOT) Up or Down - Daily" → subject=UKOILSPOT', () => {
    const r = matchTemplate(lrow('Oil (UKOILSPOT) Up or Down - Daily', { category_unified: 'crypto' }));
    expect(r!.source_tag).toBe('text-deterministic-N');
    expect(r!.subject_raw).toBe('UKOILSPOT');
  });

  test('"S&P 500 ETF (SPY) Up or Down - Weekly" (& char) → subject=SPY', () => {
    const r = matchTemplate(lrow('S&P 500 ETF (SPY) Up or Down - Weekly', { category_unified: 'crypto' }));
    expect(r!.subject_raw).toBe('SPY');
  });
});

describe('L6 — Limitless vs-pair ratio binaries (description-parsed)', () => {
  const btcGold = '<p>This market compares the price changes of Bitcoin and gold.</p><p>This market will resolve to “YES” if the “Open” price of the TradingView (https://www.tradingview.com/chart/?symbol=PYTH%3ABTCUSD%2FPYTH%3AXAUUSD) 1-day candle for BTC/XAU is strictly greater than 17.412542 on May 18, 2026. Otherwise, the market will resolve to “NO”.</p>';
  const nflxParamount = '<p>This market compares the stock price changes of Netflix and Paramount.</p><p>This market will resolve to “YES” if the “Open” price of the TradingView (...) 1-day candle for NFLX/PSKY is strictly greater than 8.365123 on May 11, 2026, at 13:30 UTC. Otherwise, the market will resolve to “NO”.</p>';

  test('"BTC vs Gold" → subject/participant from description pair, threshold=ratio, no oracle', () => {
    const r = matchTemplate(lrow('BTC vs Gold', { category_unified: 'crypto', description: btcGold }));
    expect(r!.source_tag).toBe('limitless:ratio-pair');
    expect(r!.subject_raw).toBe('BTC');
    expect(r!.participants_raw).toEqual(['XAU']);
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(17.412542);
    expect(r!.value_unit).toBe('ratio');
    expect(r!.resolution_source).toBeNull();
    expect(r!.canonical_event_override).toBe('BTC vs XAU');
    expect(r!.condition_date_override).toBe('2026-05-18T00:00:00Z');
  });

  test('econ "Netflix vs Paramount" → NFLX/PSKY tickers from description (not joke title)', () => {
    const r = matchTemplate(lrow('Netflix vs Paramount', { category_unified: 'economic', description: nflxParamount }));
    expect(r!.source_tag).toBe('limitless:ratio-pair');
    expect(r!.subject_raw).toBe('NFLX');
    expect(r!.participants_raw).toEqual(['PSKY']);
  });

  test('vs-pair title with no ratio description → refuse (defer)', () => {
    const r = matchTemplate(lrow('BTC vs Gold', { category_unified: 'crypto', description: '<p>Some unrelated prose.</p>' }));
    expect(r).toBeNull();
  });
});

describe('deriveCanonicalEventCore — personnel_move / participation (cross-platform merge + H2H-collision fix)', () => {
  const core = (over: Partial<Parameters<typeof deriveCanonicalEventCore>[0]>) =>
    deriveCanonicalEventCore({
      eventKind: 'personnel_move', conditionShape: 'categorical_outcome', conditionMetric: null,
      valueUnit: null, rawCanonicalEvent: 'raw', canonicalSubject: 'Jose Mourinho',
      canonicalParticipants: ['Jose Mourinho', 'Real Madrid'], categoryUnified: 'sports', eventDateIso: null,
      ...over,
    });

  test('next-manager categorical → "next <club> manager" (the cross-platform merge key)', () => {
    expect(core({})).toBe('next real madrid manager');
  });

  test('same key regardless of which candidate (mutex legs share canonical_event)', () => {
    expect(core({ canonicalSubject: 'Xabi Alonso', canonicalParticipants: ['Xabi Alonso', 'Real Madrid'] }))
      .toBe('next real madrid manager');
  });

  test('personnel_move BINARY does NOT mint "A vs B" (the shipped-L7 collision fix)', () => {
    const r = core({ conditionShape: 'binary_event', rawCanonicalEvent: 'arne slot out as liverpool', canonicalSubject: 'Arne Slot', canonicalParticipants: ['Arne Slot', 'Liverpool'] });
    expect(r).not.toContain(' vs ');
    expect(r).toBe('arne slot out as liverpool');
  });

  test('participation does NOT mint "A vs B" (would collide with the fixture)', () => {
    const r = deriveCanonicalEventCore({
      eventKind: 'participation', conditionShape: 'binary_event', conditionMetric: null, valueUnit: null,
      rawCanonicalEvent: 'lamine yamal to play vs cabo verde', canonicalSubject: 'Lamine Yamal',
      canonicalParticipants: ['Lamine Yamal', 'Cabo Verde'], categoryUnified: 'sports', eventDateIso: null,
    });
    expect(r).not.toBe('Cabo Verde vs Lamine Yamal');
    expect(r).toContain('lamine yamal');
  });

  test('control: a real match_winner H2H still alphabetises to "A vs B"', () => {
    const r = deriveCanonicalEventCore({
      eventKind: 'match_winner', conditionShape: 'binary_event', conditionMetric: null, valueUnit: null,
      rawCanonicalEvent: 'x', canonicalSubject: 'Real Madrid', canonicalParticipants: ['Real Madrid', 'Barcelona'],
      categoryUnified: 'sports', eventDateIso: null,
    });
    expect(r).toBe('Barcelona vs Real Madrid');
  });
});

describe('Template AL — Polymarket manager (personnel_move, merges with Kalshi/Limitless)', () => {
  const pm = (title: string) => matchTemplate(lrow(title, { platform: 'polymarket', category_unified: 'sports' }) as CandidateRow);

  test('"Will X be appointed as manager of Real Madrid?" → next-manager, cand=subject, club=participant', () => {
    const r = pm('Will Andoni Iraola be appointed as manager of Real Madrid?');
    expect(r!.source_tag).toBe('pm:next-manager');
    expect(r!.event_kind).toBe('personnel_move');
    expect(r!.condition_shape).toBe('categorical_outcome');
    expect(r!.subject_raw).toBe('Andoni Iraola');
    expect(r!.participants_raw).toEqual(['Real Madrid']);
  });

  test('"Will X be the next head coach of the Toronto Maple Leafs?" → next-manager', () => {
    const r = pm('Will Peter Laviolette be the next head coach of the Toronto Maple Leafs?');
    expect(r!.source_tag).toBe('pm:next-manager');
    expect(r!.participants_raw).toEqual(['Toronto Maple Leafs']);
  });

  test('"X out as <Club> coach by <date>" → personnel_move binary (verbatim Limitless merge)', () => {
    const r = pm('Arne Slot out as Liverpool Head Coach by May 31, 2026?');
    expect(r!.source_tag).toBe('pm:manager-out');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.subject_raw).toBe('Arne Slot');
    expect(r!.participants_raw).toEqual(['Liverpool']);
  });

  test('"out as … by the end of 2026?" stamps the actual year END (DATE4 declared flip)', () => {
    const r = pm('Erik ten Hag out as Manchester United Manager by the end of 2026?');
    expect(r!.source_tag).toBe('pm:manager-out');
    expect(r!.condition_date_override).toBe('2026-12-31T00:00:00Z');
    expect(r!.condition_date_precision_override).toBe('day');
  });

  test('"out as … by the end of June 2026?" stamps the month END', () => {
    const r = pm('Erik ten Hag out as Manchester United Manager by the end of June 2026?');
    expect(r!.source_tag).toBe('pm:manager-out');
    expect(r!.condition_date_override).toBe('2026-06-30T00:00:00Z');
  });

  test('"end of February 2028" is leap-correct (monthEndIso)', () => {
    const r = pm('Erik ten Hag out as Manchester United Manager by the end of February 2028?');
    expect(r!.condition_date_override).toBe('2028-02-29T00:00:00Z');
  });

  test('residual quirk RETIRED (rebuild-boundary batch item 4): bare "by 2026" no longer fabricates a Jan-1 DAY stamp', () => {
    // The override goes null → the assembly chain falls through to
    // extractEventDate's TITLE_YEAR (<year>-01-01 + precision 'year' +
    // source 'title-year') — the honest year-grain stamp. Census: 0 live
    // rows (vacuous on corpus, forward-correct).
    const r = pm('Erik ten Hag out as Manchester United Manager by 2026?');
    expect(r!.source_tag).toBe('pm:manager-out');
    expect(r!.condition_date_override).toBeNull();
  });

  test('"Coach of the Year" award is NOT claimed (excluded)', () => {
    const r = pm('Will Sandy Brondello win the 2026 WNBA Coach of the Year award?');
    expect(r?.source_tag).not.toBe('pm:next-manager');
  });

  test('anon candidate leg ("any other person") is refused', () => {
    const r = pm('Will any other person be the next manager of Manchester United?');
    expect(r?.source_tag).not.toBe('pm:next-manager');
  });
});

describe('L7 — Limitless personnel "by the end of <period>" (in-period deadline doctrine)', () => {
  const np = { category_unified: 'sports' as const, limitless_event_id: null };

  test('limitless:manager "out as … by the end of 2026?" stamps 2026-12-31 (DATE4 declared flip)', () => {
    const r = matchTemplate(lrow('Ruben Amorim out as Manchester United manager by the end of 2026?', np));
    expect(r!.source_tag).toBe('limitless:manager');
    expect(r!.condition_date_override).toBe('2026-12-31T00:00:00Z');
    expect(r!.condition_date_precision_override).toBe('day');
  });

  test('limitless:transfer "to leave X by the end of June 2026?" stamps the month END', () => {
    const r = matchTemplate(lrow('Vinicius Jr to leave Real Madrid by the end of June 2026?', np));
    expect(r!.source_tag).toBe('limitless:transfer');
    expect(r!.condition_date_override).toBe('2026-06-30T00:00:00Z');
  });

  test('year-less "by the end of June?" borrows the end_date year (deterministic, no clock)', () => {
    const r = matchTemplate(lrow('Vinicius Jr to leave Real Madrid by the end of June?', {
      ...np, end_date: '2026-07-02T00:00:00Z',
    }));
    expect(r!.source_tag).toBe('limitless:transfer');
    expect(r!.condition_date_override).toBe('2026-06-30T00:00:00Z');
  });

  test('non-calendar "end of the season" stays null (falls to the event-date chain, unchanged)', () => {
    const r = matchTemplate(lrow('Vinicius Jr to leave Real Madrid by the end of the season?', np));
    expect(r!.source_tag).toBe('limitless:transfer');
    expect(r!.condition_date_override).toBeNull();
  });
});

describe('L5 econ ladders — eggs / valuation / arrows / above-__ / earnings', () => {
  const ec = { category_unified: 'economic' as const, end_date: '2026-04-30T00:00:00Z' };

  test('eggs range bucket → range_snapshot USD, subject="Dozen Eggs"', () => {
    const r = matchTemplate(lrow('Price of Dozen Eggs in April?: $3.50–3.75', ec));
    expect(r!.source_tag).toBe('limitless:econ-commodity');
    expect(r!.subject_raw).toBe('Dozen Eggs');
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.condition_direction).toBe('between');
    expect(r!.value_primary).toBe(3.5);
    expect(r!.value_secondary).toBe(3.75);
    expect(r!.value_unit).toBe('usd');
  });
  test('eggs ≥ cap → above', () => {
    expect(matchTemplate(lrow('Price of Dozen Eggs in April?: ≥$3.75', ec))!.condition_direction).toBe('above');
  });

  test('Stripe valuation $B range (descending lo-hi) → sorted USD', () => {
    const r = matchTemplate(lrow('Stripe next round valuation: $120B-$100B', { ...ec }) as CandidateRow);
    expect(r!.source_tag).toBe('limitless:econ-valuation');
    expect(r!.subject_raw).toBe('Stripe');
    expect(r!.value_primary).toBe(100e9);
    expect(r!.value_secondary).toBe(120e9);
  });
  test('SpaceX valuation "No IPO before 2027" catch-all → refused', () => {
    expect(matchTemplate(lrow('SpaceX IPO Closing Market Cap: No IPO before 2027', ec))).toBeNull();
  });

  test('Korean arrow ↑ → above, local currency (unit null)', () => {
    const r = matchTemplate(lrow('Which levels will KOSPI hit in May?: ↑ 7,500.00', ec));
    expect(r!.source_tag).toBe('limitless:econ-arrow');
    expect(r!.subject_raw).toBe('KOSPI');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(7500);
    expect(r!.value_unit).toBeNull();
  });
  test('arrow ↓ → below', () => {
    expect(matchTemplate(lrow('Which price will Samsung Electronics hit in May?: ↓ 190,000.00', ec))!.condition_direction).toBe('below');
  });

  test('above-__ threshold ($) → monotonic above USD', () => {
    const r = matchTemplate(lrow('U.S. jet fuel above __ in next weekly EIA release?: $4.200', ec));
    expect(r!.source_tag).toBe('limitless:econ-above');
    expect(r!.subject_raw).toBe('U.S. jet fuel');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(4.2);
    expect(r!.value_unit).toBe('usd');
  });
  test('above-__ "65B" → ×1e9 USD', () => {
    const r = matchTemplate(lrow('NVIDIA Data Center Revenue above __ in Q1?: 65B', ec));
    expect(r!.value_primary).toBe(65e9);
  });

  test('earnings-beat binary (no colon-suffix) → ticker subject', () => {
    const r = matchTemplate(lrow('Will Circle Internet (CRCL) beat quarterly earnings?', ec));
    expect(r!.source_tag).toBe('limitless:econ-earnings');
    expect(r!.subject_raw).toBe('CRCL');
    expect(r!.condition_shape).toBe('binary_event');
  });
});

// Predict-native families (Templates AG-AK + Template C/B/U extensions).

describe('Predict championship futures (Template C, via native_question)', () => {
  test('World Cup winner → C, subject from question, canonical_event = question', () => {
    const r = matchTemplate(prow('2026 World Cup Winner: France', 'Will France win the 2026 FIFA World Cup?'));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.value_primary).toBe(1);
    expect(r!.subject_raw).toBe('France');
    expect(r!.canonical_event_override).toBe('Will France win the 2026 FIFA World Cup?');
  });
  test('bare "Conference" tail (CHAMPIONSHIP_RX lacks it) → C', () => {
    const r = matchTemplate(prow('NHL: Eastern Conference Champion: Boston Bruins', 'Will the Boston Bruins win the Eastern Conference?'));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.subject_raw).toBe('Boston Bruins');
  });
  test('digit-leading team "Philadelphia 76ers" → C', () => {
    const r = matchTemplate(prow('2026 NBA Champion: Philadelphia 76ers', 'Will the Philadelphia 76ers win the 2026 NBA Finals?'));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.subject_raw).toBe('Philadelphia 76ers');
  });
  test('en-dash "2025–2026 NBA MVP" tail → C', () => {
    const r = matchTemplate(prow('2026 NBA MVP: Cade Cunningham', 'Will Cade Cunningham win the 2025–2026 NBA MVP?'));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.subject_raw).toBe('Cade Cunningham');
  });
  test('World Cup group "win Group A in the …" preamble stripped → C', () => {
    const r = matchTemplate(prow('World Cup Group A Winner: Mexico', 'Will Mexico win Group A in the 2026 FIFA World Cup?'));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.subject_raw).toBe('Mexico');
  });
  test('non-negRisk Stanley Cup winner still matches (no isNegRisk gate) → C', () => {
    const r = matchTemplate(prow('2026 NHL Stanley Cup: Detroit Red Wings', 'Will the Detroit Red Wings win the 2026 NHL Stanley Cup?', { is_neg_risk: false }));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.subject_raw).toBe('Detroit Red Wings');
  });
  test('degenerate "Competition Winner: Korea vs Japan" (no win-verb) → NOT C', () => {
    const r = matchTemplate(prow('0x1 Season 1 Competition Winner: Korea vs Japan', '0x1 Season 1 Competition Winner: Korea vs Japan'));
    expect(r?.source_tag).not.toBe('text-deterministic-C');
  });
});

describe('Predict H2H digit-leading + esports map-winner (Templates B / U)', () => {
  test('"76ers vs. Knicks" digit-leading → B match_winner', () => {
    const r = matchTemplate(prow('76ers vs. Knicks'));
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.subject_raw).toBe('76ers');
    expect(r!.participants_raw).toEqual(['Knicks']);
  });
  test('"Map 1 Winner" → U, teams from event_match_context, map in canonical_event', () => {
    const r = matchTemplate(prow('Map 1 Winner', 'Counter-Strike: Sinners vs Astralis - Map 1 Winner', {
      event_match_context: 'Counter-Strike: Sinners vs Astralis (BO3) - IEM Atlanta Group B',
    }));
    expect(r!.source_tag).toBe('text-deterministic-U');
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.outcome_label).toBe('map 1');
    // The map-N suffix must survive deriveCanonicalEventCore's KB-name rebuild.
    expect(r!.canonical_event_override).toBe('Astralis vs Sinners');
    expect(r!.canonical_event_suffix).toBe('map 1');
    const ce = deriveCanonicalEvent({
      template: r!,
      canonical_subject: 'Sinners',
      canonicalParticipants: ['Astralis'],
      categoryUnified: 'sports',
      title: 'Map 1 Winner', nonKalshiEventTitle: null, eventDateIso: null,
    });
    expect(ce).toBe('Astralis vs Sinners map 1');
  });
});

describe('Predict macro & politics (Template AG)', () => {
  test('Fed rate-cut count = disjoint exact buckets (categorical, NOT ladder)', () => {
    const r = matchTemplate(prow('How many Fed rate cuts in 2026?: 3 (75 bps)'));
    expect(r!.source_tag).toBe('text-deterministic-AG');
    expect(r!.event_kind).toBe('policy_action');
    expect(r!.condition_shape).toBe('categorical_outcome');
    expect(r!.value_primary).toBe(3);
    expect(r!.canonical_event_override).toBe('fed rate cuts count 2026');
  });
  test('AG Fed decision EXACT cut → at/−25 signed (was at/+25 unsigned — the cut≡hike collision)', () => {
    const r = matchTemplate(prow('Fed Decision in June?: 25 bps decrease'));
    expect(r!.source_tag).toBe('text-deterministic-AG');
    expect(r!.event_kind).toBe('policy_action');
    expect(r!.condition_direction).toBe('at');
    expect(r!.value_primary).toBe(-25);
    expect(r!.value_unit).toBe('bps');
  });
  test('AG Fed decision EXACT hike → at/+25 (distinct from the cut on value sign)', () => {
    const hike = matchTemplate(prow('Fed Decision in June?: 25 bps increase'));
    const cut = matchTemplate(prow('Fed Decision in June?: 25 bps decrease'));
    expect(hike!.condition_direction).toBe('at');
    expect(hike!.value_primary).toBe(25);
    expect([cut!.condition_direction, cut!.value_primary]).not.toEqual([hike!.condition_direction, hike!.value_primary]);
  });
  test('AG Fed decision CUMULATIVE cut → below/−50 (was above/+50, hike-shaped)', () => {
    const r = matchTemplate(prow('Fed Decision in June?: 50+ bps decrease'));
    expect(r!.condition_direction).toBe('below');
    expect(r!.value_primary).toBe(-50);
  });
  test('AG Fed decision CUMULATIVE hike → above/+50', () => {
    const r = matchTemplate(prow('Fed Decision in June?: 50+ bps increase'));
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(50);
  });
  test('AG Fed decision No change → at/0 bps (aligns with PM/limitless no-change arm)', () => {
    const r = matchTemplate(prow('Fed Decision in June?: No change'));
    expect(r!.condition_direction).toBe('at');
    expect(r!.value_primary).toBe(0);
    expect(r!.value_unit).toBe('bps');
  });
  test('AG Fed decision direction-less bps outcome → label-only slot (sign unknowable; unshaped beats unsound)', () => {
    const r = matchTemplate(prow('Fed Decision in June?: 25 bps'));
    expect(r!.source_tag).toBe('text-deterministic-AG');
    expect(r!.condition_direction).toBeNull();
    expect(r!.value_primary).toBeNull();
    expect(r!.outcome_label).toBe('25 bps');
  });
  test('Balance of Power combo label canonicalized (R Senate, R House ≡ Republicans Sweep)', () => {
    const a = matchTemplate(prow('Balance of Power: 2026 Midterms: R Senate, R House'));
    const b = matchTemplate(prow('Balance of Power: 2026 Midterms: Republicans Sweep'));
    expect(a!.source_tag).toBe('text-deterministic-AG');
    expect(a!.event_kind).toBe('election_outcome_winner');
    expect(a!.outcome_label).toBe('r-r');
    expect(b!.outcome_label).toBe('r-r');
  });
  test('Senate party control → AG election_seat_winner', () => {
    const r = matchTemplate(prow('Which party will win the Senate in 2026?: Democratic Party'));
    expect(r!.event_kind).toBe('election_seat_winner');
    expect(r!.canonical_event_override).toBe('2026 us midterms senate control');
  });
  test('chain migration → AG categorical, Polymarket subject', () => {
    const r = matchTemplate(prow('What chain will Polymarket migrate to in 2026?: Aptos'));
    expect(r!.source_tag).toBe('text-deterministic-AG');
    expect(r!.subject_raw).toBe('Polymarket');
    expect(r!.outcome_label).toBe('aptos');
  });
});

describe('Predict tweet count-buckets (Template AH)', () => {
  test('bare range bucket "0-5" → AH range_snapshot lo/hi', () => {
    const r = matchTemplate(prow('Number of CZ tweets May 4th - May 11th 2026: 0-5'));
    expect(r!.source_tag).toBe('text-deterministic-AH');
    expect(r!.event_kind).toBe('social_media_metric');
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.value_primary).toBe(0);
    expect(r!.value_secondary).toBe(5);
    expect(r!.subject_raw).toBe('CZ');
  });
  test('open-top "41+" → legacy monotonic above + during_period (CUM_CONV, addendum 2)', () => {
    const r = matchTemplate(prow('Number of CZ tweets May 4th - May 11th 2026: 41+'));
    expect(r!.value_primary).toBe(41);
    expect(r!.value_secondary).toBeNull();
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.temporal_semantics).toBe('during_period');
    expect(r!.outcome_label).toBe('41+');
  });
  test('embedded-question bucket "between 11 and 15 times" → lo/hi', () => {
    const r = matchTemplate(prow('Number of CZ tweets May 11th - May 18th 2026: Will CZ tweet between 11 and 15 times between May 11th - May 18th 2026?'));
    expect(r!.value_primary).toBe(11);
    expect(r!.value_secondary).toBe(15);
  });
});

describe('Predict ordinal ranking (Template AJ, isNegRisk-gated)', () => {
  test('largest company (negRisk) → AJ categorical mutex, rank in canonical_event', () => {
    const r = matchTemplate(prow('Largest Company end of May?: NVIDIA', 'Will NVIDIA be the largest company in the world by market cap on May 31?', { category_unified: 'economic', is_neg_risk: true, end_date: '2026-06-01T00:00:00Z' }));
    expect(r!.source_tag).toBe('text-deterministic-AJ');
    expect(r!.condition_shape).toBe('categorical_outcome');
    expect(r!.subject_raw).toBe('NVIDIA');
    expect(r!.canonical_event_override).toBe('largest company by market cap 2026-05-31');
  });
  test('AJ_ENDDATE determinism: the no-year date follows end_date, NOT the run-date clock', () => {
    const r = matchTemplate(prow('Largest Company end of May?: NVIDIA', 'Will NVIDIA be the largest company in the world by market cap on May 31?', { category_unified: 'economic', is_neg_risk: true, end_date: '2027-01-15T00:00:00Z' }));
    expect(r!.canonical_event_override).toBe('largest company by market cap 2027-05-31');
    expect(r!.condition_date_override).toBe('2027-05-31');
  });
  test('AJ explicit year in the phrase always wins over end_date', () => {
    const r = matchTemplate(prow('Largest Company?: NVIDIA', 'Will NVIDIA be the largest company in the world by market cap on December 31, 2026?', { category_unified: 'economic', is_neg_risk: true, end_date: '2028-01-15T00:00:00Z' }));
    expect(r!.condition_date_override).toBe('2026-12-31');
  });
  test('2nd-largest is a SEPARATE event (rank baked into canonical_event)', () => {
    const r = matchTemplate(prow('2nd largest company end of May?: NVIDIA', 'Will NVIDIA be the second-largest company in the world by market cap on May 31?', { category_unified: 'economic', is_neg_risk: true, end_date: '2026-06-01T00:00:00Z' }));
    expect(r!.value_primary).toBe(2);
    expect(r!.canonical_event_override).toBe('second largest company by market cap 2026-05-31');
  });
  test('KOL #1 (negRisk) → AJ categorical mutex', () => {
    const r = matchTemplate(prow("Who will rank #1 …: Elon Musk", "Will Elon Musk (@elonmusk) rank #1 on Xhunt's leaderboard for the English Category on the week of May 4th?", { category_unified: 'entertainment', is_neg_risk: true }));
    expect(r!.source_tag).toBe('text-deterministic-AJ');
    expect(r!.condition_shape).toBe('categorical_outcome');
    expect(r!.subject_raw).toBe('Elon Musk');
  });
  test('KOL top-3 (isNegRisk=false) → independent binary_event, NOT mutex', () => {
    const r = matchTemplate(prow('Nikita Bier', "Will Nikita Bier (@nikitabier) rank on the top 3 on Xhunt's KOL leaderboard for the English Category on the week of May 11th?", { category_unified: 'entertainment', is_neg_risk: false }));
    expect(r!.source_tag).toBe('text-deterministic-AJ');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.value_primary).toBe(3);
  });
  test('residual "Other" subject → deferred (null), no junk KB entity', () => {
    const r = matchTemplate(prow('Largest Company end of May?: Other', 'Will any other company be the largest company in the world by market cap on May 31?', { category_unified: 'economic', is_neg_risk: true }));
    expect(r).toBeNull();
  });
});

describe('Predict crypto/finance events (Template AK)', () => {
  const cf = (q: string, cat: CandidateRow['category_unified'] = 'crypto') =>
    prow('bare-title', q, { category_unified: cat, is_neg_risk: false });
  test('fundraise commitment = monotonic LADDER (NOT categorical)', () => {
    const r = matchTemplate(cf('Over $100M committed to the Printr public sale?'));
    expect(r!.source_tag).toBe('text-deterministic-AK');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.subject_raw).toBe('Printr');
    expect(r!.value_primary).toBe(100_000_000);
    expect(r!.resolution_source).toBeNull();
  });
  test('FDV reuses AA contract (crypto_launch_fdv, "<x> launch fdv")', () => {
    const r = matchTemplate(cf('Polymarket official token FDV above $10B one day after launch?'));
    expect(r!.event_kind).toBe('crypto_launch_fdv');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.value_primary).toBe(10_000_000_000);
    expect(r!.canonical_event_override).toBe('polymarket launch fdv');
  });
  test('token launch deadline → binary, reuses AB canonical_event', () => {
    const r = matchTemplate(cf('Will Abstract launch a token by December 31, 2026'));
    expect(r!.event_kind).toBe('token_launch');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.canonical_event_override).toBe('abstract token launch');
  });
  test('airdrop deadline → binary, distinct canonical_event', () => {
    const r = matchTemplate(cf('Will Hyperliquid perform an airdrop by December 31, 2026?'));
    expect(r!.event_kind).toBe('token_launch');
    expect(r!.canonical_event_override).toBe('hyperliquid token airdrop');
  });
  test('IPO closing market-cap ladder precedes IPO deadline (ordering hazard)', () => {
    const r = matchTemplate(cf('Kraken IPO closing market cap above $16B?', 'economic'));
    expect(r!.source_tag).toBe('text-deterministic-AK');
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.value_primary).toBe(16_000_000_000);
    expect(r!.canonical_event_override).toBe('kraken ipo');
  });
  test('IPO deadline binary (independent — multiple cos can IPO)', () => {
    const r = matchTemplate(cf('Anduril Industries IPO before 2027?', 'economic'));
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.canonical_event_override).toBe('anduril industries ipo');
  });
  test('barrier race parses values from question (not corrupted outcomes)', () => {
    const r = matchTemplate(cf('Will BNB hit $1 or $1,000,000 first?'));
    expect(r!.condition_shape).toBe('categorical_outcome');
    expect(r!.value_primary).toBe(1);
    expect(r!.value_secondary).toBe(1_000_000);
  });
  test('negRisk crypto categorical is NOT claimed by AK', () => {
    const r = matchTemplate(prow('bare', 'Will Polymarket migrate to Aptos?', { category_unified: 'crypto', is_neg_risk: true }));
    expect(r?.source_tag).not.toBe('text-deterministic-AK');
  });
});

describe('metric_scope — total-emitting templates', () => {
  test('bare "X vs Y: O/U 2.5" (H) → metric_scope null (NULL-tolerant game total)', () => {
    const r = matchTemplate(row('Arsenal FC vs. Chelsea FC: O/U 2.5'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.metric_scope).toBeNull();
  });
  test('"X vs Y: 1H O/U 114.5" (H qualifier) → half_1', () => {
    const r = matchTemplate(row('Bulls vs. Thunder: 1H O/U 114.5'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.metric_scope).toBe('half_1');
  });
  test('"X vs Y: 2H O/U 113.5" (H qualifier) → half_2', () => {
    const r = matchTemplate(row('Bulls vs. Thunder: 2H O/U 113.5'));
    expect(r!.metric_scope).toBe('half_2');
  });
  test('"X vs Y: Set 1 Games O/U 10.5" (H qualifier) → set', () => {
    const r = matchTemplate(row('Pavlovic vs. Walton: Set 1 Games O/U 10.5'));
    expect(r!.source_tag).toBe('text-deterministic-H');
    expect(r!.metric_scope).toBe('set');
  });
  test('"X vs Y: Total Sets O/U 2.5" (whole-match) → metric_scope null', () => {
    const r = matchTemplate(row('Pavlovic vs. Walton: Total Sets O/U 2.5'));
    expect(r!.metric_scope).toBeNull();
  });
  test('"X vs Y: 3+ total goals?" (M) → metric_scope null (combined match total)', () => {
    const r = matchTemplate(row('Liverpool vs Chelsea: 3+ total goals?'));
    expect(r!.source_tag).toBe('text-deterministic-M');
    expect(r!.metric_scope).toBeNull();
  });
  test('esports per-map total (U) → metric_scope map', () => {
    const r = matchTemplate(prow('Total Kills Over/Under 46.5 in Game 1?', null, {
      event_match_context: 'Dota 2: Team A vs Team B (BO3) - Group Stage',
    }));
    expect(r!.source_tag).toBe('text-deterministic-U');
    expect(r!.metric_scope).toBe('map');
  });
  test('esports match-level O/U (U, no scope group) → metric_scope null', () => {
    const r = matchTemplate(prow('O/U 0.5 Rounds', null, {
      event_match_context: 'Dota 2: Team A vs Team B (BO3) - Group Stage',
    }));
    expect(r!.source_tag).toBe('text-deterministic-U');
    expect(r!.metric_scope).toBeNull();
  });
});

/** Build a Polymarket macro CandidateRow: title + parent event title. */
function pmrow(title: string, parent: string, overrides: Partial<CandidateRow> = {}): CandidateRow {
  return row(title, {
    platform: 'polymarket',
    category_unified: 'economic',
    non_kalshi_event_title: parent,
    end_date: '2026-06-10T00:00:00Z',
    ...overrides,
  });
}

describe('PM inflation / CPI buckets (tryTemplatePmInflation)', () => {
  test('US Annual interior point → at, subject US CPI, YoY canonical', () => {
    const r = matchTemplate(pmrow('Will annual inflation increase by 3.4% in April?', 'April Inflation US - Annual'));
    expect(r!.source_tag).toBe('pm:inflation');
    expect(r!.subject_raw).toBe('US CPI');
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.condition_direction).toBe('at');
    expect(r!.value_primary).toBe(3.4);
    expect(r!.value_unit).toBe('percent');
    expect(r!.condition_metric).toBe('percentage');
    expect(r!.event_kind).toBe('other');
    expect(r!.metric_scope).toBeNull();
    expect(r!.canonical_event_override).toBe('Inflation in April 2026 (CPI YoY)');
  });
  test('US Monthly → MoM canonical (distinct from US-Annual)', () => {
    const annual = matchTemplate(pmrow('Will annual inflation increase by 3.4% in April?', 'April Inflation US - Annual'));
    const monthly = matchTemplate(pmrow('Will monthly inflation increase by 0.4% in April?', 'April Inflation US - Monthly'));
    expect(monthly!.canonical_event_override).toBe('Inflation in April 2026 (CPI MoM)');
    expect(monthly!.canonical_event_override).not.toBe(annual!.canonical_event_override);
  });
  test('≤ cap → below; ≥ cap → above', () => {
    const lo = matchTemplate(pmrow('Will annual inflation increase by ≤3.1% in April?', 'April Inflation US - Annual'));
    const hi = matchTemplate(pmrow('Will annual inflation increase by ≥4.1% in April?', 'April Inflation US - Annual'));
    expect(lo!.condition_direction).toBe('below');
    expect(lo!.value_primary).toBe(3.1);
    expect(hi!.condition_direction).toBe('above');
    expect(hi!.value_primary).toBe(4.1);
  });
  test('"at least"/"or higher" → above; "less than"/"or less" → below', () => {
    const a = matchTemplate(pmrow('Will Brazil’s Annual Inflation in 2026 be at least 7.00%?', 'Brazil Annual Inflation 2026'));
    expect(a!.subject_raw).toBe('Brazil CPI');
    expect(a!.condition_direction).toBe('above');
    expect(a!.value_primary).toBe(7);
    const b = matchTemplate(pmrow('Will Argentina’s annual inflation be less than 20%?', 'Argentina Annual Inflation 2026'));
    expect(b!.subject_raw).toBe('Argentina CPI');
    expect(b!.condition_direction).toBe('below');
    expect(b!.value_primary).toBe(20);
  });
  test('between range incl. negatives (China deflation) → range_snapshot', () => {
    const r = matchTemplate(pmrow("Will China's annual inflation in 2026 be between -0.9% and -0.5%?", 'China Annual Inflation 2026'));
    expect(r!.subject_raw).toBe('China CPI');
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.value_primary).toBe(-0.9);
    expect(r!.value_secondary).toBe(-0.5);
  });
  test('multi-word countries resolve correctly (South Africa / South Korea / UK)', () => {
    const sa = matchTemplate(pmrow('Will South African inflation be greater than 5.0% in 2026?', 'South Africa Annual Inflation 2026'));
    expect(sa!.subject_raw).toBe('South Africa CPI');
    const sk = matchTemplate(pmrow('Will South Korea’s 2026 Annual Inflation be at least 3.0%?', 'South Korea Annual Inflation 2026'));
    expect(sk!.subject_raw).toBe('South Korea CPI');
    const uk = matchTemplate(pmrow('Will the UK’s 2026 inflation be at least 4.5%?', 'U.K. Annual Inflation 2026'));
    expect(uk!.subject_raw).toBe('UK CPI');
  });
  test('COUNTRY-BAIL: no country token in parent → null (NEVER defaults to US)', () => {
    const r = matchTemplate(pmrow('Will inflation reach more than 5% in 2026?', 'How high will inflation get in 2026?'));
    expect(r?.source_tag).not.toBe('pm:inflation');
    expect(r).toBeNull();
  });
});

describe('PM index-level price ladders (tryTemplatePmIndexLevel)', () => {
  test('"hit N" → above, monotonic_threshold, subject matches Limitless', () => {
    const r = matchTemplate(pmrow('Will the DFM Real Estate Index hit 18,000 in 2026?', 'What level will the Dubai Real Estate Index hit in 2026?'));
    expect(r!.source_tag).toBe('pm:index-level');
    expect(r!.subject_raw).toBe('Dubai Real Estate Index');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(18000);
    expect(r!.event_kind).toBe('price_threshold');
    expect(r!.condition_metric).toBe('price');
    expect(r!.metric_scope).toBeNull();
  });
  test('"dip to N" → below, stays monotonic (NOT categorical)', () => {
    const r = matchTemplate(pmrow('Will the DFM Real Estate Index dip to 10,000 in 2026?', 'What level will the Dubai Real Estate Index hit in 2026?'));
    expect(r!.condition_direction).toBe('below');
    expect(r!.value_primary).toBe(10000);
    expect(r!.condition_shape).toBe('monotonic_threshold');
  });
  test('non-index PM market is NOT claimed', () => {
    const r = matchTemplate(pmrow('Will the DFM Real Estate Index hit 18,000 in 2026?', 'Some unrelated event'));
    expect(r?.source_tag).not.toBe('pm:index-level');
  });
});

describe('PM central-bank rate decisions (tryTemplatePmRateDecision)', () => {
  test('"decreases by 25 bps" (EXACT move) → at −25 signed, subject = bank (#14)', () => {
    const r = matchTemplate(pmrow('Bank of England decreases interest rates by 25 bps after July 2026 meeting?', 'Bank of England decision in July?'));
    expect(r!.source_tag).toBe('pm:rate-decision');
    expect(r!.subject_raw).toBe('Bank of England');
    expect(r!.condition_direction).toBe('at');
    expect(r!.value_primary).toBe(-25);
    expect(r!.value_unit).toBe('bps');
    expect(r!.event_kind).toBe('policy_action');
  });
  test('"increases by 50+ bps" (CUMULATIVE) → above 50 (unchanged)', () => {
    const r = matchTemplate(pmrow('Bank of Japan increases interest rates by 50+ bps after the July 2026 meeting?', 'Bank of Japan Decision in July?'));
    expect(r!.subject_raw).toBe('Bank of Japan');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(50);
  });
  test('"no change" → 0 bps, direction at', () => {
    const r = matchTemplate(pmrow('No change in Bank of England’s interest rates after July 2026 meeting?', 'Bank of England decision in July?'));
    expect(r!.value_primary).toBe(0);
    expect(r!.condition_direction).toBe('at');
  });
  test('"ECB announce a 25 bps decrease" → European Central Bank, at −25 (#14)', () => {
    const r = matchTemplate(pmrow('Will the ECB announce a 25 bps decrease at the July 2026 meeting?', 'ECB Interest Rates: July 2026'));
    expect(r!.subject_raw).toBe('European Central Bank');
    expect(r!.condition_direction).toBe('at');
    expect(r!.value_primary).toBe(-25);
  });
  test('"Fed increase ... 25 bps" → Federal Funds Rate (aligns with Kalshi KXFED), at +25 (#14)', () => {
    const r = matchTemplate(pmrow('Will the Fed increase interest rates by 25 bps after the July 2026 meeting?', 'Fed Decision in July?'));
    expect(r!.subject_raw).toBe('Federal Funds Rate');
    expect(r!.condition_direction).toBe('at');
    expect(r!.value_primary).toBe(25);
  });
  test('#14 regression — Bank of Canada June set (live q105309/q105311): exact-25-cut is NOT a rung under 50+-cut', () => {
    const exact = matchTemplate(pmrow('Will the Bank of Canada announce a 25 bps decrease at the June meeting?', 'Bank of Canada decision in June?'));
    const cumul = matchTemplate(pmrow('Will the Bank of Canada announce a 50+ bps decrease at the June meeting?', 'Bank of Canada decision in June?'));
    expect(exact!.condition_direction).toBe('at');
    expect(exact!.value_primary).toBe(-25);
    expect(cumul!.condition_direction).toBe('below');
    expect(cumul!.value_primary).toBe(-50);
    expect(exact!.condition_direction).not.toBe(cumul!.condition_direction);
  });
  test('#14 regression — Bank of Japan June set (live q98292/q98290): exact-25-hike vs 50+-hike split at/above', () => {
    const exact = matchTemplate(pmrow('Bank of Japan increases interest rates by 25 bps after the June 2026 meeting?', 'Bank of Japan Decision in June?'));
    const cumul = matchTemplate(pmrow('Bank of Japan increases interest rates by 50+ bps after the June 2026 meeting?', 'Bank of Japan Decision in June?'));
    expect(exact!.condition_direction).toBe('at');
    expect(exact!.value_primary).toBe(25);
    expect(cumul!.condition_direction).toBe('above');
    expect(cumul!.value_primary).toBe(50);
  });
  test('#14: exact ±25 pair inside one event stays gated-field DISTINCT (signed values)', () => {
    const hike = matchTemplate(pmrow('Will the Bank of Canada increase the target for the overnight rate by 25 bps at the July interest rate announcement?', 'Bank of Canada Decision in July?'));
    const cut = matchTemplate(pmrow('Will the Bank of Canada decrease the target for the overnight rate by 25 bps at the July interest rate announcement?', 'Bank of Canada Decision in July?'));
    expect(hike!.condition_direction).toBe('at');
    expect(cut!.condition_direction).toBe('at');
    expect(hike!.value_primary).toBe(25);
    expect(cut!.value_primary).toBe(-25);
  });
  test('audit-r2 #2 truth table — the five decision shapes are pairwise DISTINCT (direction,value) stamps', () => {
    const rows = [
      matchTemplate(pmrow('No change in Bank of Canada’s interest rates after the June meeting?', 'Bank of Canada decision in June?')),
      matchTemplate(pmrow('Will the Bank of Canada announce a 25 bps increase at the June meeting?', 'Bank of Canada decision in June?')),
      matchTemplate(pmrow('Will the Bank of Canada announce a 25 bps decrease at the June meeting?', 'Bank of Canada decision in June?')),
      matchTemplate(pmrow('Will the Bank of Canada announce a 25+ bps increase at the June meeting?', 'Bank of Canada decision in June?')),
      matchTemplate(pmrow('Will the Bank of Canada announce a 25+ bps decrease at the June meeting?', 'Bank of Canada decision in June?')),
    ];
    const expected = ['at/0', 'at/25', 'at/-25', 'above/25', 'below/-25'];
    rows.forEach((r, i) => {
      expect(r!.source_tag).toBe('pm:rate-decision');
      expect(`${r!.condition_direction}/${r!.value_primary}`).toBe(expected[i]!);
    });
    expect(new Set(rows.map((r) => `${r!.condition_direction}/${r!.value_primary}`)).size).toBe(5);
  });
  test('banks stay DISTINCT subjects (no cross-bank merge)', () => {
    const boe = matchTemplate(pmrow('Bank of England increases interest rates by 25 bps after July 2026 meeting?', 'Bank of England decision in July?'));
    const boj = matchTemplate(pmrow('Bank of Japan increases interest rates by 25 bps after the July 2026 meeting?', 'Bank of Japan Decision in July?'));
    const bom = matchTemplate(pmrow('Bank of Mexico increases interest rates by 25 bps after August 2026 meeting?', 'Bank of Mexico Decision in August?'));
    expect(new Set([boe!.subject_raw, boj!.subject_raw, bom!.subject_raw]).size).toBe(3);
  });
  test('BAIL on non-numeric political variant "Fed abolished before 2027?"', () => {
    const r = matchTemplate(pmrow('Fed abolished before 2027?', 'Fed abolished before 2027?'));
    expect(r?.source_tag).not.toBe('pm:rate-decision');
  });
  test('BAIL on multi-leg combo "Cut–Cut–Cut"', () => {
    const r = matchTemplate(pmrow('Will the Fed Cut–Cut–Cut in the next three decisions (Apr–Jun–Jul)?', 'Fed decisions (Apr-Jul)'));
    expect(r?.source_tag).not.toBe('pm:rate-decision');
  });
});

describe('audit-r2 #2 / audit-r3 #2 — cross-emitter rate-decision convention parity (pm × predict-AG × limitless × kalshi)', () => {
  const ec = { category_unified: 'economic' as const };
  // tryCentralBankRateDecision needs a DB round trip, but its whole gated
  // stamp is the pure pair
  // parseFedDecision → fedDecisionStamp plus the constants
  // policy_action/count/bps — replicate that contract here so the parity test
  // exercises the same derivation the emitter ships.
  const kalshiStamp = (title: string) => {
    const p = parseFedDecision(title);
    if (!p) return null;
    const s = fedDecisionStamp(p);
    if (!s) return null;
    return {
      event_kind: 'policy_action', condition_metric: 'count', value_unit: 'bps',
      condition_direction: s.direction, value_primary: s.bps,
    };
  };
  // All four emitters must produce the SAME (event_kind, metric, unit,
  // direction, value) stamp for the same decision, and a cut must NEVER
  // equal a hike on the gated fields. Kalshi cumulative rungs are STRICT
  // ('>25bps' => above/+25) while the others are '50+' (>=50); both live on
  // the same open-interval convention.
  const cases: ReadonlyArray<[string, () => any, string, number]> = [
    ['kalshi exact hike',  () => kalshiStamp('Will the Federal Reserve Hike rates by 25bps at their July 2026 meeting?'), 'at', 25],
    ['kalshi exact cut',   () => kalshiStamp('Will the Federal Reserve Cut rates by 25bps at their July 2026 meeting?'), 'at', -25],
    ['kalshi cumul hike',  () => kalshiStamp('Will the Federal Reserve Hike rates by >25bps at their July 2026 meeting?'), 'above', 25],
    ['kalshi cumul cut',   () => kalshiStamp('Will the Federal Reserve Cut rates by >25bps at their July 2026 meeting?'), 'below', -25],
    ['kalshi no change',   () => kalshiStamp('Will the Federal Reserve Hike rates by 0bps at their July 2026 meeting?'), 'at', 0],
    ['pm exact hike',      () => matchTemplate(pmrow('Will the Fed increase interest rates by 25 bps after the July 2026 meeting?', 'Fed Decision in July?')), 'at', 25],
    ['pm exact cut',       () => matchTemplate(pmrow('Will the Fed decrease interest rates by 25 bps after the July 2026 meeting?', 'Fed Decision in July?')), 'at', -25],
    ['pm cumul cut',       () => matchTemplate(pmrow('Will the Fed decrease interest rates by 50+ bps after the July 2026 meeting?', 'Fed Decision in July?')), 'below', -50],
    ['ag exact hike',      () => matchTemplate(prow('Fed Decision in July?: 25 bps increase')), 'at', 25],
    ['ag exact cut',       () => matchTemplate(prow('Fed Decision in July?: 25 bps decrease')), 'at', -25],
    ['ag cumul hike',      () => matchTemplate(prow('Fed Decision in July?: 50+ bps increase')), 'above', 50],
    ['ag cumul cut',       () => matchTemplate(prow('Fed Decision in July?: 50+ bps decrease')), 'below', -50],
    ['ag no change',       () => matchTemplate(prow('Fed Decision in July?: No change')), 'at', 0],
    ['ll exact hike',      () => matchTemplate(lrow('Fed Decision in July?: 25 bps increase', ec)), 'at', 25],
    ['ll exact cut',       () => matchTemplate(lrow('Fed Decision in July?: 25 bps decrease', ec)), 'at', -25],
    ['ll cumul hike',      () => matchTemplate(lrow('Fed Decision in July?: 50+ bps increase', ec)), 'above', 50],
    ['ll cumul cut',       () => matchTemplate(lrow('Fed Decision in July?: 50+ bps decrease', ec)), 'below', -50],
    ['ll no change',       () => matchTemplate(lrow('Fed Decision in July?: No change', ec)), 'at', 0],
  ];
  test('every emitter stamps policy_action/count/bps + the unified signed (direction,value)', () => {
    for (const [name, get, dir, vp] of cases) {
      const r = get();
      expect(`${name}: ${r?.event_kind}|${r?.condition_metric}|${r?.value_unit}`).toBe(`${name}: policy_action|count|bps`);
      expect(`${name}: ${r?.condition_direction}/${r?.value_primary}`).toBe(`${name}: ${dir}/${vp}`);
    }
  });
  test('no two OPPOSITE-direction moves share (kind,metric,unit,direction,value) across ANY emitter pair', () => {
    const stamps = cases.map(([name, get]) => {
      const r = get();
      return { name, key: `${r!.event_kind}|${r!.condition_metric}|${r!.value_unit}|${r!.condition_direction}|${r!.value_primary}` };
    });
    for (const a of stamps) {
      for (const b of stamps) {
        const oppose =
          (/hike/.test(a.name) && /cut/.test(b.name)) || (/cut/.test(a.name) && /hike/.test(b.name)) ||
          (/no change/.test(a.name) !== /no change/.test(b.name) && (/no change/.test(a.name) || /no change/.test(b.name)));
        if (oppose) expect(`${a.name} vs ${b.name}: ${a.key}`).not.toBe(`${a.name} vs ${b.name}: ${b.key}`);
      }
    }
  });
});

describe('matchTemplate — bare metric headers + prop-prefix props refuse mis-shaping (2026-06-06)', () => {
  // "Games Total: O/U 2.5" is a MATCH-level betting line, not a player.
  test('"Games Total: O/U 2.5" is NOT a player_prop with subject "Games Total"', () => {
    const r = matchTemplate(row('Games Total: O/U 2.5'));
    expect(r?.source_tag).not.toBe('text-deterministic-E');
    expect(r?.subject_raw).not.toBe('Games Total');
  });
  test('"Maps Total: O/U 2.5" likewise refused', () => {
    const r = matchTemplate(row('Maps Total: O/U 2.5'));
    expect(r?.subject_raw).not.toBe('Maps Total');
  });
  test('a REAL player O/U is unaffected', () => {
    const r = matchTemplate(row('Aaron Gordon: O/U 4.5'));
    expect(r?.source_tag).toBe('text-deterministic-E');
    expect(r?.subject_raw).toBe('Aaron Gordon');
  });
  test('"Will there be a run scored in the first inning?: A vs B" is never tagged B', () => {
    const r = matchTemplate(row('Will there be a run scored in the first inning?: San Francisco Giants vs. Los Angeles Dodgers'));
    expect(r?.source_tag).not.toBe('text-deterministic-B');
    if (r) expect(r.subject_raw).not.toBe('San Francisco Giants');
  });
});


describe('cricketSidePropKind — pure detector', () => {
  test('detects the live cricket-prop dash-suffixes', () => {
    expect(cricketSidePropKind('Indian Premier League: Delhi Capitals vs Rajasthan Royals - Most Sixes Draw')).toBe('most_sixes');
    expect(cricketSidePropKind('Pakistan Super League: Karachi Kings vs Hyderabad Kingsmen - Team Top Batter Draw')).toBe('top_batter');
    expect(cricketSidePropKind('IPL: A vs B - Toss Match Double Draw')).toBe('toss_match');
    expect(cricketSidePropKind('Legends Cricket League: A vs B - Completed match?')).toBe('completed_match');
    expect(cricketSidePropKind('T20 Series Afghanistan vs Sri Lanka: Afghanistan vs Sri Lanka - Who wins the toss?')).toBe('who_wins_the_toss');
  });
  test('does NOT fire on esports tournament-stage dash-suffixes or plain winners', () => {
    expect(cricketSidePropKind('CS2: Team Spirit vs FaZe Clan - DreamLeague Group A')).toBeNull();
    expect(cricketSidePropKind('LoL: T1 vs Gen.G - LCK Rounds 1-2')).toBeNull();
    expect(cricketSidePropKind('Counter-Strike: K27 vs Gentle Mates (BO3) - PGL Astana Group Stage')).toBeNull();
    expect(cricketSidePropKind('Lakers vs Celtics')).toBeNull();
    expect(cricketSidePropKind('Will Arsenal beat Chelsea?')).toBeNull();
    expect(cricketSidePropKind('')).toBeNull();
  });
});

describe('matchTemplate — cricket side-prop is event_kind=other, NOT match_winner', () => {
  test('"... - Most Sixes Draw" → other, Draw subject + prop suffix (W1-A F2)', () => {
    const r = matchTemplate(row('Indian Premier League: Delhi Capitals vs Rajasthan Royals - Most Sixes Draw'));
    expect(r).not.toBeNull();
    expect(r!.event_kind).toBe('other');
    expect(r!.source_tag).toBe('text-deterministic-B');
    // The prop family rides canonical_event_suffix, which survives
    // deriveCanonicalEventCore's KB-name fixture rebuild.
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.participants_raw).toEqual(['Delhi Capitals', 'Rajasthan Royals']);
    expect(r!.canonical_event_suffix).toBe('prop most_sixes');
  });
  test('"... - Who wins the toss?" → other, fixture-level (no side)', () => {
    const r = matchTemplate(row('T20 Series Afghanistan vs Sri Lanka: Afghanistan vs Sri Lanka - Who wins the toss?'));
    expect(r!.event_kind).toBe('other');
    expect(r!.subject_raw).toBe('Afghanistan');
    expect(r!.canonical_event_suffix).toBe('prop who_wins_the_toss');
  });
  test('GUARD: a genuine cricket "A vs B" winner stays match_winner', () => {
    const r = matchTemplate(row('Indian Premier League: Delhi Capitals vs Rajasthan Royals'));
    expect(r).not.toBeNull();
    expect(r!.event_kind).toBe('match_winner');
  });
  test('GUARD: an esports tournament-stage winner stays match_winner', () => {
    const r = matchTemplate(row('LoL: Weibo Gaming vs Ninjas in Pyjamas (BO3) - LPL Group Ascend'));
    expect(r!.event_kind).toBe('match_winner');
  });
});

describe('parseCricketSideProp — pure side parser', () => {
  test('sided draw tails (incl. "Double" decoration)', () => {
    expect(parseCricketSideProp('IPL: CSK vs LSG - Most Sixes Draw')).toEqual({ propKind: 'most_sixes', side: 'draw' });
    expect(parseCricketSideProp('IPL: CSK vs LSG - Toss Match Double Draw')).toEqual({ propKind: 'toss_match', side: 'draw' });
    expect(parseCricketSideProp('PSL: A vs B - Team Top Batter Draw')).toEqual({ propKind: 'top_batter', side: 'draw' });
  });
  test('sided team tails ("<Team> Winner")', () => {
    expect(parseCricketSideProp('IPL: Gujarat Titans vs Sunrisers Hyderabad - Most Sixes Sunrisers Hyderabad Winner'))
      .toEqual({ propKind: 'most_sixes', side: 'Sunrisers Hyderabad' });
    expect(parseCricketSideProp('IPL: GT vs SH - Toss Match Double Gujarat Titans Winner'))
      .toEqual({ propKind: 'toss_match', side: 'Gujarat Titans' });
    expect(parseCricketSideProp('T20: Scotland vs USA - Team Top Batter Scotland Winner'))
      .toEqual({ propKind: 'top_batter', side: 'Scotland' });
  });
  test('fixture-level tails (no side)', () => {
    expect(parseCricketSideProp('LCL: A vs B - Completed match?')).toEqual({ propKind: 'completed_match', side: null });
    expect(parseCricketSideProp('T20: A vs B - Who wins the toss?')).toEqual({ propKind: 'who_wins_the_toss', side: null });
  });
  test('unmodeled tail shapes → unrecognized (caller must bail, never guess)', () => {
    expect(parseCricketSideProp('IPL: A vs B - Most Sixes Over 12.5')).toEqual({ propKind: 'most_sixes', side: 'unrecognized' });
    expect(parseCricketSideProp('IPL: A vs B - Rohit Sharma Top Batter')).toEqual({ propKind: 'top_batter', side: 'unrecognized' });
  });
  test('non-prop titles → null', () => {
    expect(parseCricketSideProp('Lakers vs Celtics')).toBeNull();
    expect(parseCricketSideProp('CS2: Team Spirit vs FaZe Clan - DreamLeague Group A')).toBeNull();
  });
});

describe('W1-A F2 — two different cricket prop tails NEVER produce identical normalizations', () => {
  const fixture = 'Indian Premier League: Chennai Super Kings vs Lucknow Super Giants';

  test('sided siblings of ONE family: distinct subjects (TeamA / TeamB / Draw), same family suffix', () => {
    const aWin = matchTemplate(row(`${fixture} - Most Sixes Chennai Super Kings Winner`, { platform: 'polymarket' }));
    const bWin = matchTemplate(row(`${fixture} - Most Sixes Lucknow Super Giants Winner`, { platform: 'polymarket' }));
    const draw = matchTemplate(row(`${fixture} - Most Sixes Draw`, { platform: 'polymarket' }));
    expect(aWin!.subject_raw).toBe('Chennai Super Kings');
    expect(bWin!.subject_raw).toBe('Lucknow Super Giants');
    expect(draw!.subject_raw).toBe('Draw');
    expect(aWin!.canonical_event_suffix).toBe('prop most_sixes');
    expect(bWin!.canonical_event_suffix).toBe('prop most_sixes');
    expect(draw!.canonical_event_suffix).toBe('prop most_sixes');
  });

  test('different families on one fixture: same subject, DIFFERENT canonical_event suffix', () => {
    const toss = matchTemplate(row(`${fixture} - Who wins the toss?`, { platform: 'polymarket' }));
    const completed = matchTemplate(row(`${fixture} - Completed match?`, { platform: 'polymarket' }));
    expect(toss!.canonical_event_suffix).toBe('prop who_wins_the_toss');
    expect(completed!.canonical_event_suffix).toBe('prop completed_match');
    expect(toss!.canonical_event_suffix).not.toBe(completed!.canonical_event_suffix);
  });

  test('the suffix SURVIVES deriveCanonicalEvent (the override did not — root cause)', () => {
    const toss = matchTemplate(row(`${fixture} - Toss Match Double Draw`, { platform: 'polymarket' }))!;
    const sixes = matchTemplate(row(`${fixture} - Most Sixes Draw`, { platform: 'polymarket' }))!;
    const ce = (tpl: TemplateMatch) => deriveCanonicalEvent({
      template: tpl,
      canonical_subject: 'Draw',
      canonicalParticipants: ['Chennai Super Kings', 'Draw', 'Lucknow Super Giants'],
      categoryUnified: 'sports',
      title: 'X', nonKalshiEventTitle: null, eventDateIso: null,
    });
    expect(ce(toss)).toBe('Chennai Super Kings vs Lucknow Super Giants prop toss_match');
    expect(ce(sixes)).toBe('Chennai Super Kings vs Lucknow Super Giants prop most_sixes');
    expect(ce(toss)).not.toBe(ce(sixes));
  });

  test('side that matches neither participant → bail (unshaped, never a guessed subject)', () => {
    const r = matchTemplate(row(`${fixture} - Most Sixes Mumbai Indians Winner`, { platform: 'polymarket' }));
    expect(r).toBeNull();
  });

  test('unrecognized prop tail → bail', () => {
    const r = matchTemplate(row(`${fixture} - Most Sixes Over 12.5`, { platform: 'polymarket' }));
    expect(r).toBeNull();
  });
});


describe('statLeaderGatedEvent (no predicate canonical_event)', () => {
  test('Kalshi stat-leader override is a GATED noun phrase, not the raw question', () => {
    const r = matchTemplate(row('Will Kyle Schwarber lead pro baseball in WAR for the 2026 regular season?'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-stat-leader');
    expect(r!.canonical_event_override).not.toMatch(/^will /i);
    expect(r!.canonical_event_override!.endsWith('?')).toBe(false);
    expect(r!.canonical_event_override).toContain('Kyle Schwarber');
    expect(r!.canonical_event_override).toContain('2026');
    expect(looksLikePredicate(r!.canonical_event_override!)).toBe(false);
  });
  test('statLeaderGatedEvent strips Will/? and re-anchors on the gated subject', () => {
    const out = statLeaderGatedEvent('Yordan Alvarez', 'Will Yordan Alvarez lead the MLB in RBIs for the 2026 regular season?');
    expect(out.startsWith('Yordan Alvarez')).toBe(true);
    expect(out.toLowerCase().startsWith('will')).toBe(false);
    expect(out.endsWith('?')).toBe(false);
    expect(looksLikePredicate(out)).toBe(false);
    const a = statLeaderGatedEvent('Yordan Alvarez', 'Will Yordan Alvarez lead the MLB in RBIs for the 2025 regular season?');
    expect(out).not.toBe(a);
  });
});

describe('looksLikePredicate recall-preservation anchors', () => {
  test('predicate/question canonicals trip (true)', () => {
    expect(looksLikePredicate('will kyle schwarber lead pro baseball in war for the 2026 regular season')).toBe(true);
  });
  test('real event canonicals SURVIVE (false) -- no recall loss', () => {
    expect(looksLikePredicate('2026 ca-19 primary')).toBe(false);
    expect(looksLikePredicate('2026 California Lieutenant Governor election')).toBe(false);
    expect(looksLikePredicate('CA-19 House Election Winner')).toBe(false);
    expect(looksLikePredicate('Colombian presidential election')).toBe(false);
  });
});

describe('gatedEventAlias', () => {
  test('drops a looksLikePredicate question title -> []', () => {
    expect(gatedEventAlias('Will X place first in the 2026 CA-19 primary?')).toEqual([]);
    expect(gatedEventAlias('Will Kyle Schwarber lead pro baseball in WAR for the 2026 regular season?')).toEqual([]);
  });
  test('drops a value-shaped string (isNonEntityLabel) -> []', () => {
    expect(gatedEventAlias('Democrats, 41+ pts')).toEqual([]);
  });
  test('keeps a real event-name variant', () => {
    expect(gatedEventAlias('Colombian presidential election')).toEqual(['Colombian presidential election']);
  });
  test('empty/null -> []', () => {
    expect(gatedEventAlias(null)).toEqual([]);
    expect(gatedEventAlias('')).toEqual([]);
    expect(gatedEventAlias('   ')).toEqual([]);
  });
});

describe('Template J draw — discriminator lift (PM-TEMPLATE-J-DRAW P0 + PLX-06)', () => {
  test('PM draw end-in-a-draw subject is Draw, both teams in participants', () => {
    const r = matchTemplate(row('Will Brazil vs. Morocco end in a draw?', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-J');
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.participants_raw).toEqual(['Brazil', 'Morocco']);
    expect(r!.outcome_label).toBe('draw');
    expect(r!.event_kind).toBe('match_winner');
  });

  test('Predict 1X2 draw routes through J native title -> subject Draw (PLX-06)', () => {
    const r = matchTemplate(row('Will Jordan vs. Argentina end in a draw?', { platform: 'predict' }));
    expect(r!.source_tag).toBe('text-deterministic-J');
    expect(r!.subject_raw).toBe('Draw');
    expect(r!.participants_raw).toEqual(['Jordan', 'Argentina']);
  });

  test('SOUNDNESS: draw subject is NEVER the first team', () => {
    const r = matchTemplate(row('Will Real Oviedo vs. Getafe CF end in a draw?'));
    expect(r!.subject_raw).not.toBe('Real Oviedo');
    expect(r!.subject_raw).toBe('Draw');
  });

  test('keep-bespoke: a NON-draw H2H winner keeps its TEAM subject', () => {
    const r = matchTemplate(row('Brazil vs. Morocco', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).not.toBe('Draw');
  });
});

describe('CHAMPIONSHIP_POLY widen + COUNT_TRAP lockstep', () => {
  test('PM win Ligue 1 -> championship_winner', () => {
    const r = matchTemplate(row('Will PSG win Ligue 1?', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.subject_raw).toBe('PSG');
  });

  test('PM win Serie A -> championship_winner', () => {
    const r = matchTemplate(row('Will Inter Milan win Serie A?', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.subject_raw).toBe('Inter Milan');
  });

  test('PM win Eredivisie -> championship_winner', () => {
    const r = matchTemplate(row('Will Ajax win the Eredivisie?', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.event_kind).toBe('championship_winner');
  });

  // The bail is capture-shape general: ^\d+\s+<lowercase> is never a real entity name.
  test('SOUNDNESS: numeric-fragment subject ("1 contenders") bails out of Template C', () => {
    const r = matchTemplate(row(
      'Will 1 contenders win the jackpot at The American Rodeo Championship Weekend 2026?',
      { platform: 'polymarket' },
    ));
    if (r) expect(r.source_tag).not.toBe('text-deterministic-C');
    const r0 = matchTemplate(row(
      'Will 0 contenders win the jackpot at The American Rodeo Championship Weekend 2026?',
      { platform: 'polymarket' },
    ));
    if (r0) expect(r0.source_tag).not.toBe('text-deterministic-C');
  });

  test('coverage kept: real digit-leading subjects still capture ("100 Thieves", "1. FC Köln")', () => {
    const r = matchTemplate(row('Will 100 Thieves win the LCS Championship?', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.subject_raw).toBe('100 Thieves');
    const k = matchTemplate(row('Will 1. FC Köln win the Bundesliga title?', { platform: 'polymarket' }));
    expect(k!.source_tag).toBe('text-deterministic-C');
    expect(k!.subject_raw).toBe('1. FC Köln');
  });

  test('SOUNDNESS: MLB win-more-than-90.5-games is NOT championship (COUNT_TRAP)', () => {
    const r = matchTemplate(row('Will the New York Yankees win more than 90.5 games in the 2026 MLB Regular Season?', { platform: 'polymarket' }));
    expect(r?.event_kind).not.toBe('championship_winner');
    if (r) expect(r.source_tag).not.toBe('text-deterministic-C');
  });

  test('SOUNDNESS: win 100+ games still trapped', () => {
    const r = matchTemplate(row('Will the Dodgers win 100+ games this season?', { platform: 'polymarket' }));
    if (r) expect(r.source_tag).not.toBe('text-deterministic-C');
  });

  test('keep-bespoke: plain win the World Cup is NOT trapped', () => {
    const r = matchTemplate(row('Will Spain win the World Cup?', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.event_kind).toBe('championship_winner');
  });
});

describe('Predict majors / grand slam (AUD-14)', () => {
  test('golf win a major in 2026 -> championship_winner', () => {
    const r = matchTemplate(prow('Scottie Scheffler', 'Will Scottie Scheffler win a major in 2026?'));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.subject_raw).toBe('Scottie Scheffler');
    expect(r!.value_primary).toBe(1);
    expect(r!.value_unit).toBe('rank');
  });

  test('tennis win a Grand Slam in 2026 -> championship_winner', () => {
    const r = matchTemplate(prow('Carlos Alcaraz', 'Will Carlos Alcaraz win a Grand Slam in 2026?'));
    expect(r!.source_tag).toBe('text-deterministic-C');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.subject_raw).toBe('Carlos Alcaraz');
  });
});


describe('Cross-platform RELEGATION handler (stage_advance, INDEPENDENT)', () => {
  test('Kalshi La Liga relegation', () => {
    const r = matchTemplate(row('Will Alaves be Relegated from La Liga in 2025-26 Season?', { platform: 'kalshi' }));
    expect(r!.source_tag).toBe('text-deterministic-relegation');
    expect(r!.event_kind).toBe('stage_advance');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.subject_raw).toBe('Alaves');
    expect(r!.participants_raw).toEqual([]);
    expect(r!.canonical_event_override).toBe('la liga 2025-26 relegation');
  });

  test('PM en-dash season relegation', () => {
    const r = matchTemplate(row('Will Arsenal be relegated from the English Premier League after the 2025-26 season?', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-relegation');
    expect(r!.subject_raw).toBe('Arsenal');
    expect(r!.canonical_event_override).toBe('english premier league 2025-26 relegation');
  });
  test('boundary: REAL en-dash season –2025–26– normalises to 2025-26', () => {
    const r = matchTemplate(row('Will Arsenal be relegated from the English Premier League after the 2025–26 season?', { platform: 'polymarket' }));
    expect(r!.source_tag).toBe('text-deterministic-relegation');
    expect(r!.canonical_event_override).toBe('english premier league 2025-26 relegation');
  });

  test('Predict reads native_question (title is bare club)', () => {
    const r = matchTemplate(prow('Tottenham', 'Will Tottenham be relegated from the English Premier League after the 2025-26 season?'));
    expect(r!.source_tag).toBe('text-deterministic-relegation');
    expect(r!.subject_raw).toBe('Tottenham');
    expect(r!.canonical_event_override).toBe('english premier league 2025-26 relegation');
  });

  test('Limitless colon-suffix relegation set', () => {
    const r = matchTemplate(row('EPL - Which Clubs Get Relegated?: West Ham', { platform: 'limitless', limitless_event_id: 'evt-rel-1' }));
    expect(r!.source_tag).toBe('text-deterministic-relegation');
    expect(r!.subject_raw).toBe('West Ham');
    expect(r!.canonical_event_override).toBe('english premier league relegation');
  });

  test('SOUNDNESS: relegation is INDEPENDENT binary_event, no mutex/exhaustive signal', () => {
    const r = matchTemplate(row('Will Levante be Relegated from La Liga in 2025-26 Season?', { platform: 'kalshi' }));
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.event_kind).toBe('stage_advance');
    expect(r!.value_primary).toBeNull();
    expect(r!.outcome_label).toBeNull();
  });

  test('keep-bespoke: North London combo is NOT a relegation row', () => {
    const r = matchTemplate(row('North London: How does it end?: Arsenal to win the league + Tottenham to be relegated', { platform: 'limitless', limitless_event_id: 'evt-combo' }));
    expect(r?.source_tag).not.toBe('text-deterministic-relegation');
  });

  test('cross-platform merge key: PM and Predict EPL relegation share canonical_event', () => {
    const pm = matchTemplate(row('Will West Ham be relegated from the English Premier League after the 2025-26 season?', { platform: 'polymarket' }));
    const pr = matchTemplate(prow('West Ham', 'Will West Ham be relegated from the English Premier League after the 2025-26 season?'));
    expect(pm!.canonical_event_override).toBe(pr!.canonical_event_override);
    expect(pm!.subject_raw).toBe(pr!.subject_raw);
  });
});

describe('Predict stage_advance advance-to-finals (PL-PREDICT-04)', () => {
  test('advance to the Conference Finals -> stage_advance', () => {
    const r = matchTemplate(prow('Boston Celtics', 'Will the Boston Celtics advance to the Conference Finals in the 2026 NBA Playoffs?'));
    expect(r!.source_tag).toBe('text-deterministic-predict-advance');
    expect(r!.event_kind).toBe('stage_advance');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.subject_raw).toBe('Boston Celtics');
  });

  test('advance to the 2026 NBA Finals -> stage_advance', () => {
    const r = matchTemplate(prow('Denver Nuggets', 'Will the Denver Nuggets advance to the 2026 NBA Finals?'));
    expect(r!.source_tag).toBe('text-deterministic-predict-advance');
    expect(r!.event_kind).toBe('stage_advance');
  });
});

describe('PM top-N primary advance rank latch (DW-58)', () => {
  const CA_DESCR =
    'The California primary is currently scheduled to take place on June 2, 2026.\n\n' +
    'This market will resolve "Yes" if the listed candidate advances from the primary to the general election.';
  const AK_DESCR =
    'The non-partisan primary election for Governor of Alaska is scheduled to take place on August 18, 2026. ' +
    'The top four candidates in this election by number of votes won will advance to the general election for Governor of Alaska.';
  const pmrow = (title: string, over: Partial<CandidateRow> = {}) =>
    row(title, { platform: 'polymarket', category_unified: 'election', description: CA_DESCR, ...over });

  test('CA district form → primary_winner rank≤2 latch, race ce, event-year date', () => {
    const r = matchTemplate(pmrow('Will Brandon Riker advance from the CA-48 primary election?'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-pm-primary-advance');
    expect(r!.event_kind).toBe('primary_winner');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('below');
    expect(r!.condition_metric).toBeNull();
    expect(r!.value_primary).toBe(2);
    expect(r!.value_unit).toBe('rank');
    expect(r!.temporal_semantics).toBe('at_resolution');
    expect(r!.subject_raw).toBe('Brandon Riker');
    expect(r!.canonical_event_override).toBe('2026 ca-48 primary');
    expect(r!.condition_date_override).toBe('2026-01-01');
    expect(r!.condition_date_precision_override).toBe('year');
    expect(r!.condition_date_source_override).toBe('event-year');
  });

  test('bare "Primary?" variant (no "election") is claimed; year falls back to end_date when the description has no date', () => {
    const r = matchTemplate(pmrow('Will Jamie Smith advance from the CA-31 Primary?',
      { description: null, end_date: '2026-06-01T22:00:00.000Z' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-pm-primary-advance');
    expect(r!.canonical_event_override).toBe('2026 ca-31 primary');
    expect(r!.condition_date_source_override).toBe('end_date-year');
  });

  test('California Governor statewide form → rank 2 (statutory top-two), year from title', () => {
    const r = matchTemplate(pmrow('Will Katie Porter advance from the 2026 California Governor primary election?',
      { description: null }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-pm-primary-advance');
    expect(r!.value_primary).toBe(2);
    expect(r!.canonical_event_override).toBe('2026 california governor primary');
  });

  test('Alaska Governor → rank 4, proven by the description "top four … advance"', () => {
    const r = matchTemplate(pmrow('Will Dave Bronson advance from the 2026 Alaska Governor primary election?',
      { description: AK_DESCR }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-pm-primary-advance');
    expect(r!.value_primary).toBe(4);
    expect(r!.value_unit).toBe('rank');
    expect(r!.canonical_event_override).toBe('2026 alaska governor primary');
  });

  test('Alaska WITHOUT a provable advance count bails (no guessed rank)', () => {
    const r = matchTemplate(pmrow('Will Dave Bronson advance from the 2026 Alaska Governor primary election?',
      { description: null }));
    expect(r?.source_tag).not.toBe('text-deterministic-pm-primary-advance');
  });

  test('non-top-two district state (TX) bails — advance there is not provably rank≤2', () => {
    const r = matchTemplate(pmrow('Will Jane Doe advance from the TX-18 primary election?'));
    expect(r?.source_tag).not.toBe('text-deterministic-pm-primary-advance');
  });

  test('placeholder pseudo-candidates are never claimed', () => {
    const r = matchTemplate(pmrow('Will another Democrat advance from the CA-48 primary election?'));
    expect(r?.source_tag).not.toBe('text-deterministic-pm-primary-advance');
  });

  test('"advance to the runoff" / "advance to the general election for" forms are NOT claimed', () => {
    expect(matchTemplate(pmrow('Will Karen Bass advance to the runoff?'))?.source_tag)
      .not.toBe('text-deterministic-pm-primary-advance');
    expect(matchTemplate(pmrow('Will Joe Kent advance to the general election for WA-03?'))?.source_tag)
      .not.toBe('text-deterministic-pm-primary-advance');
  });

  test('sports advance stays with Template D / stage_advance (Eurovision/WC untouched)', () => {
    const r = matchTemplate(pmrow('Will Mexico advance to the knockout stages at the 2026 FIFA World Cup?',
      { category_unified: 'sports' }));
    expect(r?.source_tag).not.toBe('text-deterministic-pm-primary-advance');
    if (r) expect(r.event_kind).toBe('stage_advance');
  });

  test('platform-gated: the same title on kalshi is not claimed here', () => {
    const r = matchTemplate(row('Will Brandon Riker advance from the CA-48 primary election?'));
    expect(r?.source_tag).not.toBe('text-deterministic-pm-primary-advance');
  });
});


describe('Predict standalone esports H2H from own title (PL-PREDICT-06)', () => {
  test('LoL prefixed BO3 matchup -> standalone binary H2H (O8 flip)', () => {
    const r = matchTemplate(prow('LoL: Team WE vs Ninjas in Pyjamas (BO3) - LPL Group Ascend'));
    expect(r!.source_tag).toBe('text-deterministic-predict-esports-h2h');
    expect(r!.event_kind).toBe('match_winner');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.temporal_semantics).toBe('at_resolution');
    expect(r!.condition_direction).toBeNull();
    expect(r!.value_primary).toBeNull();
    expect(r!.subject_raw).toBe('Team WE');
    expect(r!.participants_raw).toEqual(['Team WE', 'Ninjas in Pyjamas']);
  });

  test('O8 convergence: predict H2H now stamps the SAME shape class as the PM Template-B twin', () => {
    const predict = matchTemplate(prow('LoL: Team WE vs Ninjas in Pyjamas (BO3) - LPL Group Ascend'));
    const pm = matchTemplate(row('Team WE vs. Ninjas in Pyjamas'));
    expect(pm!.source_tag).toBe('text-deterministic-B');
    expect(pm!.condition_shape).toBe('binary_event');
    expect(predict!.condition_shape).toBe(pm!.condition_shape);
    expect(predict!.event_kind).toBe(pm!.event_kind);
  });

  test('Competition Winner colon-prefix matchup -> binary H2H (was unshaped)', () => {
    const r = matchTemplate(prow('0x1 Season 1 Competition Winner: Korea vs Japan'));
    expect(r!.source_tag).toBe('text-deterministic-predict-esports-h2h');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.participants_raw).toEqual(['Korea', 'Japan']);
  });

  test('SOUNDNESS: bare basketball 76ers vs Knicks NOT claimed here (stays Template B)', () => {
    const r = matchTemplate(prow('76ers vs. Knicks'));
    expect(r!.source_tag).toBe('text-deterministic-B');
  });

  test('keep-bespoke: when a vs-sibling exists defer to Template U/B', () => {
    const r = matchTemplate(prow('Map 1 Winner', null, { event_match_context: 'LoL: Team WE vs Anyone Legend (BO3)' }));
    expect(r?.source_tag).not.toBe('text-deterministic-predict-esports-h2h');
  });
});

describe('PLX-01 Limitless condition_date from startMatchTimestampInUTC (not end_date+1)', () => {
  const startTs = String(Math.floor(Date.UTC(2026, 4, 13, 19, 30, 0) / 1000));

  test('Template M total goals sources minute-precision date from startTs', () => {
    const r = matchTemplate(row('Liverpool vs Chelsea: 3+ total goals?', { platform: 'limitless', limitless_start_ts: startTs, end_date: '2026-05-14T00:00:00Z' }));
    expect(r!.source_tag).toBe('text-deterministic-M');
    expect(r!.condition_date_precision_override).toBe('minute');
    expect(r!.condition_date_source_override).toBe('limitless-match-start');
    expect(r!.condition_date_override).toBe('2026-05-13T19:30:00Z');
  });

  test('Template L both teams score sources minute-precision date from startTs', () => {
    const r = matchTemplate(row('Arsenal FC vs. Chelsea FC: Both Teams to Score', { platform: 'limitless', limitless_start_ts: startTs, end_date: '2026-05-14T00:00:00Z' }));
    expect(r!.source_tag).toBe('text-deterministic-L');
    expect(r!.condition_date_precision_override).toBe('minute');
    expect(r!.condition_date_override).toBe('2026-05-13T19:30:00Z');
  });

  test('SOUNDNESS: non-Limitless PM rows do NOT get the override', () => {
    const r = matchTemplate(row('Liverpool vs Chelsea: 3+ total goals?', { platform: 'polymarket', end_date: '2026-05-14T00:00:00Z' }));
    expect(r!.source_tag).toBe('text-deterministic-M');
    expect(r!.condition_date_override).toBeUndefined();
  });
});

// PM econ / count / RT bucket families.

describe('P4 gap 1 — PM percent buckets (pm:econ-pct-bucket)', () => {
  const econ = (title: string, overrides: Partial<CandidateRow> = {}) =>
    matchTemplate(row(title, { platform: 'polymarket', category_unified: 'economic', ...overrides }));

  test('"be between X% and Y%" → range_snapshot/between, Kalshi GDP subject (id 3754278)', () => {
    const r = econ('Will China GDP growth in Q2 2026 be between 5.5% and 5.8%?');
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:econ-pct-bucket');
    expect(r!.subject_raw).toBe('China GDP');
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.condition_direction).toBe('between');
    expect(r!.value_primary).toBe(5.5);
    expect(r!.value_secondary).toBe(5.8);
    expect(r!.value_unit).toBe('percent');
    expect(r!.condition_metric).toBe('percentage');
    expect(r!.temporal_semantics).toBe('on_date');
  });

  test('possessive + (YoY) GDP form → same country subject (id 3778499)', () => {
    const r = econ('Will Brazil’s Q1 2026 GDP growth rate (YoY) be between 0.7% and 1.0%?');
    expect(r!.subject_raw).toBe('Brazil GDP');
    expect(r!.value_primary).toBe(0.7);
    expect(r!.value_secondary).toBe(1.0);
  });

  test('annual GDP form → Eurozone GDP (id 3794270)', () => {
    const r = econ('Will Eurozone annual GDP growth in 2026 be between 0% and 1.0%?');
    expect(r!.subject_raw).toBe('Eurozone GDP');
  });

  test('"be less than X%" → point_in_time/below (matches Kalshi deriveShapeAndDirection)', () => {
    const r = econ('Will China GDP growth in Q2 2026 be less than 4.0%?');
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.condition_direction).toBe('below');
    expect(r!.value_primary).toBe(4.0);
  });

  test('"be at least X%" → point_in_time/above', () => {
    const r = econ('Will China GDP growth in Q2 2026 be at least 6.1%?');
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(6.1);
  });

  test('non-GDP metric phrase keeps a period-free subject (Walmart family)', () => {
    const r = econ('Will Walmart Q1 US comparable sales growth be between 4.3% and 4.6%?');
    expect(r).not.toBeNull();
    expect(r!.subject_raw).toBe('Walmart US comparable sales growth');
    const r2 = econ('Will Walmart Q1 US comparable sales growth be above 4.6%?');
    expect(r2!.condition_direction).toBe('above');
    expect(r2!.subject_raw).toBe(r!.subject_raw);
  });

  test('SOUNDNESS: margin-of-victory "win … BY between X% and Y%" is NEVER claimed', () => {
    const r = matchTemplate(row(
      'Will the Democratic Party win the popular vote in the 2026 U.S. House of Representatives midterm elections by between 0% and 2%?',
      { platform: 'polymarket', category_unified: 'politics' },
    ));
    expect(r?.source_tag ?? null).not.toBe('pm:econ-pct-bucket');
  });

  test('SOUNDNESS: non-polymarket and non-econ/politics categories bail', () => {
    expect(matchTemplate(row('Will China GDP growth in Q2 2026 be between 5.5% and 5.8%?',
      { platform: 'predict', category_unified: 'economic' }))?.source_tag ?? null)
      .not.toBe('pm:econ-pct-bucket');
    expect(matchTemplate(row('Will China GDP growth in Q2 2026 be between 5.5% and 5.8%?',
      { platform: 'polymarket', category_unified: 'sports' }))).toBeNull();
  });

  test('SOUNDNESS: inverted between-bounds bail', () => {
    expect(econ('Will China GDP growth in Q2 2026 be between 5.8% and 5.5%?')).toBeNull();
  });
});

describe('P4 gap 1 — PM count buckets (pm:count-bucket)', () => {
  const tech = (title: string, overrides: Partial<CandidateRow> = {}) =>
    matchTemplate(row(title, { platform: 'polymarket', category_unified: 'technology', ...overrides }));

  test('"N to M tornadoes occur" → cumulative_count.range on the Kalshi subject (id 3730633)', () => {
    const r = tech('Will 200 to 229 tornadoes occur in the United States in May 2026?');
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:count-bucket');
    expect(r!.subject_raw).toBe('US Tornado Count');
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.condition_direction).toBe('between');
    expect(r!.temporal_semantics).toBe('during_period');
    expect(r!.value_primary).toBe(200);
    expect(r!.value_secondary).toBe(229);
    expect(r!.value_unit).toBe('tornadoes');
    expect(r!.condition_metric).toBe('count');
    expect(r!.event_kind).toBe('weather_extreme');
  });

  test('"fewer than N tornadoes occur" → below boundary stays TERMINAL (PIT on_date; id 3730632)', () => {
    const r = tech('Will fewer than 200 tornadoes occur in the United States in May 2026?');
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.condition_direction).toBe('below');
    expect(r!.temporal_semantics).toBe('on_date');
    expect(r!.value_primary).toBe(200);
  });

  test('"N or more tornadoes occur" → legacy monotonic above + during_period (CUM_CONV; id 3781264)', () => {
    const r = tech('Will 1250 or more tornadoes occur in the United States in 2026?');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.temporal_semantics).toBe('during_period');
    expect(r!.value_primary).toBe(1250);
  });

  test('NOAA resolution_source is stamped ONLY from the market description', () => {
    const withNoaa = tech('Will 200 to 229 tornadoes occur in the United States in May 2026?',
      { description: 'This market will resolve according to NOAA Storm Prediction Center data.' });
    expect(withNoaa!.resolution_source).toBe('NOAA');
    const without = tech('Will 200 to 229 tornadoes occur in the United States in May 2026?');
    expect(without!.resolution_source).toBeNull();
  });

  test('"there be at least N measles cases" → above on US Measles Cases (id 3805754)', () => {
    const r = tech('Will there be at least 10000 measles cases in the U.S. in 2026?');
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:count-bucket');
    expect(r!.subject_raw).toBe('US Measles Cases');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.temporal_semantics).toBe('during_period');
    expect(r!.value_primary).toBe(10000);
    expect(r!.value_unit).toBe('cases');
    expect(r!.event_kind).toBe('other');
    const r2 = tech('Will there be at least 2200 measles cases in the U.S. by May 31, 2026?');
    expect(r2!.value_primary).toBe(2200);
  });

  test('SOUNDNESS: unmapped nouns + non-US context bail (no free-phrase count entities)', () => {
    expect(tech('Will 10 to 12 hurricanes occur in the Atlantic in 2026?')).toBeNull();
    expect(tech('Will 200 to 229 tornadoes occur in Canada in May 2026?')).toBeNull();
    expect(tech('Will there be at least 12 albums ranked #1 on the Billboard 200 in 2026?')).toBeNull();
  });
});

describe('P4 gap 1 — PM Rotten Tomatoes thresholds (pm:rt-score)', () => {
  const ent = (title: string) =>
    matchTemplate(row(title, { platform: 'polymarket', category_unified: 'entertainment' }));

  test('"score at least N on the Tomatometer" → KXRT ladder contract (id 3710783)', () => {
    const r = ent('Will "The Sheep Detectives" score at least 70 on the Rotten Tomatoes Tomatometer?');
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:rt-score');
    expect(r!.subject_raw).toBe('The Sheep Detectives');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.condition_metric).toBe('score');
    expect(r!.value_primary).toBe(70);
    expect(r!.value_unit).toBe('score');
    expect(r!.event_kind).toBe('media_release');
    expect(r!.temporal_semantics).toBe('at_resolution');
    expect(r!.canonical_event_override).toBe('The Sheep Detectives');
  });

  test('colon-titled movies survive (id 3711080-style)', () => {
    const r = ent('Will "Star Wars: The Mandalorian and Grogu" score at least 65 on the Rotten Tomatoes Tomatometer?');
    expect(r!.subject_raw).toBe('Star Wars: The Mandalorian and Grogu');
  });

  test('distinct thresholds stay distinct rungs of one ladder', () => {
    const a = ent('Will "Obsession" score at least 55 on the Rotten Tomatoes Tomatometer?');
    const b = ent('Will "Obsession" score at least 80 on the Rotten Tomatoes Tomatometer?');
    expect(a!.canonical_event_override).toBe(b!.canonical_event_override);
    expect(a!.value_primary).not.toBe(b!.value_primary);
  });

  test('SOUNDNESS: out-of-range score / non-PM bail', () => {
    expect(ent('Will "Obsession" score at least 700 on the Rotten Tomatoes Tomatometer?')).toBeNull();
    expect(matchTemplate(row('Will "Obsession" score at least 70 on the Rotten Tomatoes Tomatometer?',
      { platform: 'kalshi', category_unified: 'entertainment' }))?.source_tag ?? null).not.toBe('pm:rt-score');
  });
});

describe('P4 gap 1 — Template A (HIGH)/(LOW) watermark family', () => {
  const econ = (title: string) =>
    matchTemplate(row(title, { platform: 'polymarket', category_unified: 'economic' }));

  test('comma in corporate name no longer blocks the PREFIX form (id 3677044)', () => {
    const r = econ('Will Amazon.com, Inc. (AMZN) hit (HIGH) $300 Week of May 11 2026?');
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-A');
    expect(r!.subject_raw).toBe('AMZN');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(300);
    expect(r!.value_unit).toBe('usd');
  });

  test('PREFIX (LOW) → below (id 3675276)', () => {
    const r = econ('Will Robinhood Markets, Inc. (HOOD) hit (LOW) $60 Week of May 11 2026?');
    expect(r!.condition_direction).toBe('below');
    expect(r!.value_primary).toBe(60);
  });

  test('POSTFIX stock form (id 3794956)', () => {
    const r = econ('Will S&P 500 (SPX) hit $6,500 (LOW) in June?');
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-A');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('below');
    expect(r!.value_primary).toBe(6500);
    expect(r!.value_unit).toBe('usd');
  });

  test('POSTFIX with "the" article + (HIGH) (id 3744859)', () => {
    const r = econ('Will the Ornn H200 Index hit $5.00 (HIGH) by May 31, 2026?');
    expect(r!.condition_direction).toBe('above');
    expect(r!.value_primary).toBe(5);
    expect(r!.subject_raw).toBe('Ornn H200 Index');
  });

  test('FX pair keeps the FULL pair as subject + quote-currency unit (id 3786641)', () => {
    const r = econ('Will USD/CAD hit 1.55 (High) in 2026?');
    expect(r).not.toBeNull();
    expect(r!.subject_raw).toBe('USD/CAD');
    expect(r!.value_unit).toBe('CAD');
    expect(r!.condition_direction).toBe('above');
    const r2 = econ('Will USD/KRW hit 2000 (High) in 2026?');
    expect(r2!.subject_raw).toBe('USD/KRW');
    expect(r2!.value_unit).toBe('KRW');
    expect(r!.subject_raw).not.toBe(r2!.subject_raw);
  });

  test('PERCENT watermark emits the Kalshi how-HIGH/LOW ladder contract (id 3787066)', () => {
    const r = econ('Will the U.S. 30-year Fixed-Rate Mortgage hit 6.00% (LOW) by December 31, 2026?');
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-A');
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.condition_direction).toBe('below');
    expect(r!.condition_metric).toBe('percentage');
    expect(r!.value_unit).toBe('percent');
    expect(r!.temporal_semantics).toBe('on_date');
    expect(r!.value_primary).toBe(6);
    const hi = econ('Will the U.S. 30-year Fixed-Rate Mortgage hit 7.00% (HIGH) by December 31, 2026?');
    expect(hi!.condition_direction).toBe('above');
  });

  test('SOUNDNESS: the (LOW) earnings-ticker trap is not claimed', () => {
    const r = econ("Will Lowe's (LOW) beat quarterly earnings?");
    expect(r?.source_tag ?? null).not.toBe('text-deterministic-A');
  });
});

describe('P4 gap 1 — percent-bucket claim-steal guards', () => {
  test('approval ratings stay with Template X even without a date suffix', () => {
    const r = matchTemplate(row("Will Trump's approval rating be between 45% and 50%?", {
      platform: 'polymarket', category_unified: 'politics',
    }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-X');
    expect(r!.event_kind).toBe('approval_rating');
  });
});

describe('Template X — A1 = TOUCH (addendum 2): year-window vs dated arms', () => {
  const pol = (title: string) =>
    matchTemplate(row(title, { platform: 'polymarket', category_unified: 'politics' }));

  test('"hit X% in <year>" (year window) → path_touch: monotonic_threshold + during_period', () => {
    const r = pol("Will Trump's approval rating hit 50% in 2026?");
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-X');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.temporal_semantics).toBe('during_period');
    expect(r!.condition_direction).toBe('above');
    expect(r!.condition_metric).toBe('percentage');
    expect(r!.value_primary).toBe(50);
    expect(r!.value_unit).toBe('percent');
  });

  test.each(['reach', 'exceed'])('"%s X% in <year>" rides the same touch arm', (verb) => {
    const r = pol(`Will Trump's approval rating ${verb} 45% in 2026?`);
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.temporal_semantics).toBe('during_period');
  });

  test('dated variants stay terminal snapshots (point_in_time + on_date)', () => {
    const r = pol("Will Trump's 538 approval rating be 49% or more on February 14?");
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-X');
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.temporal_semantics).toBe('on_date');
    expect(r!.condition_direction).toBe('above');
  });

  test('a touch VERB with a dated anchor stays snapshot (the window, not the verb, is the discriminator)', () => {
    // "for May 14, 2026" — dated reading, no window.
    const r = pol("Will Donald Trump's approval rating hit 40.2% for May 14, 2026?");
    expect(r).not.toBeNull();
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.temporal_semantics).toBe('on_date');
  });

  test('bare bounded verbs in a year window do NOT flip (A1 scope is hit/reach/exceed only)', () => {
    const r = pol("Will Trump's approval rating be above 45% in 2026?");
    expect(r).not.toBeNull();
    expect(r!.condition_shape).toBe('point_in_time');
    expect(r!.temporal_semantics).toBe('on_date');
  });

  test('range arm is untouched (terminal_range, on_date)', () => {
    const r = pol("Will Trump's approval rating be between 45.0% and 45.4% on June 13?");
    expect(r!.condition_shape).toBe('range_snapshot');
    expect(r!.temporal_semantics).toBe('on_date');
    expect(r!.condition_direction).toBe('between');
  });
});

// isAnonymizedMarket is the embed/ANN/LLM skip predicate over a per-child
// subject label. It generalizes isAnonSubject by (1) being NULL-tolerant and
// (2) dropping the `^will\s` artifact branch.
describe('isAnonymizedMarket (WS1 omission predicate)', () => {
  test('flags PM/Kalshi placeholder labels (role-noun + short token)', () => {
    expect(isAnonymizedMarket('Candidate A')).toBe(true);
    expect(isAnonymizedMarket('Company H')).toBe(true);
    expect(isAnonymizedMarket('Player AH')).toBe(true);
    expect(isAnonymizedMarket('Person AA')).toBe(true);
    expect(isAnonymizedMarket('Party 21')).toBe(true);
    expect(isAnonymizedMarket('Driver A')).toBe(true);
    expect(isAnonymizedMarket('Nominee B')).toBe(true);
  });

  test('flags residual catch-all outcomes', () => {
    expect(isAnonymizedMarket('Other')).toBe(true);
    expect(isAnonymizedMarket('another party')).toBe(true);
    expect(isAnonymizedMarket('any other driver')).toBe(true);
    expect(isAnonymizedMarket('the field')).toBe(true);
    expect(isAnonymizedMarket('no winner')).toBe(true);
  });

  test('flags bare single-uppercase-letter + 1-2-lowercase placeholders', () => {
    expect(isAnonymizedMarket('A')).toBe(true);
    expect(isAnonymizedMarket('E')).toBe(true);
    expect(isAnonymizedMarket('bk')).toBe(true);
    expect(isAnonymizedMarket('bq')).toBe(true);
  });

  test('does NOT flag real entity labels', () => {
    expect(isAnonymizedMarket('Boston Celtics')).toBe(false);
    expect(isAnonymizedMarket('CDU')).toBe(false);
    expect(isAnonymizedMarket('SPD')).toBe(false);
    expect(isAnonymizedMarket('USA')).toBe(false);
    expect(isAnonymizedMarket('Team USA')).toBe(false);
    expect(isAnonymizedMarket('Club Brugge')).toBe(false);
    expect(isAnonymizedMarket('Real Madrid')).toBe(false);
  });

  test('NULL / empty label is NOT anon (a missing label must not omit a market)', () => {
    expect(isAnonymizedMarket(null)).toBe(false);
    expect(isAnonymizedMarket('')).toBe(false);
    expect(isAnonymizedMarket('   ')).toBe(false);
  });

  test('REGRESSION: deliberate `^will` divergence from isAnonSubject', () => {
    // isAnonSubject keeps the `^will` artifact branch, anchored to the
    // mis-capture shape "Will " + 1-2-char/numeric placeholder token, so it
    // never eats a real Will-first-name person. isAnonymizedMarket has no
    // such branch.
    expect(isAnonSubject('Will E')).toBe(true);
    expect(isAnonSubject('Will AB')).toBe(true);
    expect(isAnonSubject('Will 12')).toBe(true);
    expect(isAnonymizedMarket('Will E')).toBe(false);
    expect(isAnonSubject('Will Smith')).toBe(false);
    expect(isAnonymizedMarket('Will Smith')).toBe(false);
    expect(isAnonSubject('Will Venable')).toBe(false);
    expect(isAnonymizedMarket('Will Venable')).toBe(false);
    expect(isAnonSubject('Will Hardy')).toBe(false);
    expect(isAnonSubject('Will Zalatoris')).toBe(false);
    expect(isAnonSubject('Candidate A')).toBe(true);
    expect(isAnonymizedMarket('Candidate A')).toBe(true);
    expect(isAnonSubject('Boston Celtics')).toBe(false);
    expect(isAnonymizedMarket('Boston Celtics')).toBe(false);
  });

  test('fix ④ REGRESSION: role-noun index digits bounded to 1-2 (Club 360 is real)', () => {
    // PM enumerates 1-2-digit placeholder indices; 3+-digit "names" are real entities.
    expect(isAnonSubject('Club 360')).toBe(false);
    expect(isAnonymizedMarket('Club 360')).toBe(false);
    expect(isAnonSubject('Party 21')).toBe(true);
    expect(isAnonymizedMarket('Party 21')).toBe(true);
    expect(isAnonSubject('Player 5')).toBe(true);
    expect(isAnonymizedMarket('Company 100')).toBe(false);
  });
});

describe('tryTemplateWCount — WS3-W2 (PM word-count)', () => {
  test('cumulative_count tuple: above/count/during_period, value 10, unit times', () => {
    const r = matchTemplate(row('Will "Flank" be said 10+ times during the IEM Atlanta 2026 Grand Finals?', { platform: 'polymarket', category_unified: 'sports' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-W-count');
    expect(r!.event_kind).toBe('speech_mention');
    expect(r!.condition_metric).toBe('count');
    expect(r!.condition_direction).toBe('above');
    expect(r!.temporal_semantics).toBe('during_period');
    expect(r!.value_primary).toBe(10);
    expect(r!.value_unit).toBe('times');
    expect(normalizeOutcomeLabel(r!.outcome_label)).toBe('flank');
    // The broadcast subject is the occasion, not a person; the WORD never leaks into it.
    expect(r!.subject_raw.toLowerCase()).toContain('iem atlanta');
    expect(r!.subject_raw.toLowerCase()).not.toContain('flank');
    expect(r!.participant_type_confidence).toBe('low');
  });

  test('podcast occasion, larger count', () => {
    const r = matchTemplate(row('Will "AI" be said 20+ times during the next episode of the All-In Podcast?', { platform: 'polymarket', category_unified: 'economic' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-W-count');
    expect(r!.value_primary).toBe(20);
    expect(normalizeOutcomeLabel(r!.outcome_label)).toBe('ai');
  });

  test('non-PM platform is NOT claimed (PM-native gate)', () => {
    const r = matchTemplate(row('Will "Flank" be said 10+ times during the IEM Atlanta 2026 Grand Finals?', { platform: 'kalshi', category_unified: 'sports' }));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-W-count');
  });

  test('speaker-bearing "X say WORD N+ times" is NOT claimed by W-count (no "be said")', () => {
    const r = matchTemplate(row('Will the White House Press Secretary say "Iran" 5+ times during the next White House Press Briefing?', { platform: 'polymarket', category_unified: 'politics' }));
    if (r !== null) expect(r.source_tag).not.toBe('text-deterministic-W-count');
  });

  test('REGRESSION: "announcers say during X" (kalshi) still never tagged B', () => {
    const r = matchTemplate(row('What will the announcers say during Cubs vs Braves Professional Baseball Game?'));
    if (r !== null) {
      expect(r.source_tag).not.toBe('text-deterministic-B');
      expect(r.source_tag).not.toBe('text-deterministic-W-count');
    }
  });
});

// Kalshi KXFOMEN/KXFOWOMEN titles carry no tour token, so the tour must be
// derived from native metadata and injected into the championship
// canonical_event: otherwise both tours would share one canonical_event.
describe('Template C — tennis tour/gender canonical_event lift', () => {
  const KALSHI_MEN = {
    event_ticker: 'KXFOMEN-26',
    event_title: "Men's French Open Winner",
    kalshi_competition: 'ATP French Open',
    rules_primary: "If Carlos Alcaraz wins the 2026 Men's French Open professional tennis tournament, then the market resolves to Yes.",
  };
  const KALSHI_WOMEN = {
    event_ticker: 'KXFOWOMEN-26',
    event_title: "Women's French Open Winner",
    kalshi_competition: 'WTA French Open',
    rules_primary: "If Coco Gauff wins the 2026 Women's French Open professional tennis tournament, then the market resolves to Yes.",
  };

  const derive = (title: string, overrides: Partial<CandidateRow>) => {
    const tpl = matchTemplate(row(title, overrides));
    expect(tpl).not.toBeNull();
    expect(tpl!.source_tag).toBe('text-deterministic-C');
    return deriveCanonicalEvent({
      template: tpl!,
      canonical_subject: tpl!.subject_raw,
      canonicalParticipants: [],
      categoryUnified: 'sports',
      title,
      nonKalshiEventTitle: (overrides.non_kalshi_event_title as string | null) ?? null,
      eventDateIso: '2026-06-07',
    });
  };

  test('Kalshi men’s row gains the tour qualifier and lands on the PM string', () => {
    expect(derive('Will Carlos Alcaraz win the French Open?', KALSHI_MEN))
      .toBe('2026 men s france open');
  });

  test('Kalshi women’s row gains the tour qualifier', () => {
    expect(derive('Will Coco Gauff win the French Open?', KALSHI_WOMEN))
      .toBe('2026 women s france open');
  });

  test('cross-tour Kalshi rows no longer share a canonical_event (the 500-edge bridge)', () => {
    expect(derive('Will Jack Draper win the French Open?', KALSHI_MEN))
      .not.toBe(derive('Will Iga Swiatek win the French Open?', KALSHI_WOMEN));
  });

  test('same-tour cross-platform merge: PM gendered title yields the SAME string as Kalshi', () => {
    const pm = derive('Will Jannik Sinner win the 2026 Men’s French Open?', { platform: 'polymarket' });
    const kalshi = derive('Will Jannik Sinner win the French Open?', KALSHI_MEN);
    expect(pm).toBe('2026 men s france open');
    expect(kalshi).toBe(pm);
  });

  test('unknown tour → NULL → canonical_event unchanged (never guess)', () => {
    const tpl = matchTemplate(row('Will Novak Djokovic win the French Open?'))!;
    expect(tpl.canonical_event_tour ?? null).toBeNull();
    expect(derive('Will Novak Djokovic win the French Open?', {}))
      .toBe('2026 france open');
  });

  test('explicit ATP/WTA signal also threads the tour league as KB scope', () => {
    const men = matchTemplate(row('Will Carlos Alcaraz win the French Open?', KALSHI_MEN))!;
    expect(men.league_canonical).toBe('ATP Tour');
    expect(men.sport_canonical).toBe('tennis');
    const women = matchTemplate(row('Will Coco Gauff win the French Open?', KALSHI_WOMEN))!;
    expect(women.league_canonical).toBe('WTA Tour');
    const pm = matchTemplate(row('Will Jannik Sinner win the 2026 Men’s French Open?', { platform: 'polymarket' }))!;
    expect(pm.league_canonical ?? null).toBeNull();
  });

  test('any-of family stays tour-folded: Kalshi "win a Tennis Grand Slam" keeps ce "2026 grand slam"', () => {
    // The tour qualifier must never split the cross-platform "win a major /
    // a slam" merge key even though the tour IS derivable.
    const tpl = matchTemplate(row('Will Amanda Anisimova win a Tennis Grand Slam in 2026?', {
      event_ticker: 'KXWTAGRANDSLAM-26',
    }));
    if (tpl && tpl.event_kind === 'championship_winner') {
      const ce = deriveCanonicalEvent({
        template: tpl,
        canonical_subject: tpl.subject_raw,
        canonicalParticipants: [],
        categoryUnified: 'sports',
        title: 'Will Amanda Anisimova win a Tennis Grand Slam in 2026?',
        nonKalshiEventTitle: null,
        eventDateIso: '2026-01-01',
      });
      expect(ce).toBe('2026 grand slam');
    }
  });
});

describe('fix ② — subject_native_verified on structured/vs-pair subjects', () => {
  test('PM Template-B vs-pair: "Team WE vs Oh My God" is verified (other side real)', () => {
    const r = matchTemplate(row('Team WE vs Oh My God', { platform: 'polymarket' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Team WE');
    expect(r!.subject_native_verified).toBe(true);
    expect(isAnonSubject('Team WE')).toBe(true);
  });

  test('PM Template-B prefixed vs-pair: "LoL: Team WE vs Oh My God (BO3)" is verified', () => {
    const r = matchTemplate(row('LoL: Team WE vs Oh My God (BO3)', { platform: 'polymarket' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Team WE');
    expect(r!.subject_native_verified).toBe(true);
  });

  test('fully-redacted vs-pair is NOT verified (door still bails)', () => {
    const r = matchTemplate(row('Team A vs Team B', { platform: 'polymarket' }));
    expect(r).not.toBeNull();
    expect(r!.subject_raw).toBe('Team A');
    expect(r!.subject_native_verified ?? false).toBe(false);
  });

  test('Kalshi yst-lift: subject from structured yes_sub_title is verified', () => {
    const r = matchTemplate(row('Arsenal vs Everton Winner?', { yes_sub_title: 'Arsenal' }));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('text-deterministic-B');
    expect(r!.subject_raw).toBe('Arsenal');
    expect(r!.subject_native_verified).toBe(true);
  });

  test('Kalshi yst-lift frees a Will-first-name label ("Will Smith" the prospect)', () => {
    const r = matchTemplate(row('Will Smith vs Jamie Benn Winner?', { yes_sub_title: 'Will Smith' }));
    expect(r).not.toBeNull();
    expect(r!.subject_raw).toBe('Will Smith');
    expect(r!.subject_native_verified).toBe(true);
  });

  test('pm:group-item: subject IS the structured groupItemTitle → verified', () => {
    const r = matchTemplate(row('Will Arsenal qualify for the league phase of the Champions League?', {
      platform: 'polymarket',
      category_unified: 'sports',
      pm_group_item_title: 'Arsenal',
    } as Partial<CandidateRow>));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-advance');
    expect(r!.subject_raw).toBe('Arsenal');
    expect(r!.subject_native_verified).toBe(true);
  });

  test('pm:group-item: placeholder gits still refused (trap-a gates precede the flag)', () => {
    const r = matchTemplate(row('Will Person J win the 2028 US presidential election?', {
      platform: 'polymarket',
      category_unified: 'politics',
      pm_group_item_title: 'Person J',
    } as Partial<CandidateRow>));
    expect(r).toBeNull();
  });
});
