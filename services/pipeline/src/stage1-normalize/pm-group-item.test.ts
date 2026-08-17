/**
 * Tests for tryTemplatePmGroupItem — the PM groupItemTitle-driven handler for
 * binary sub-markets (pm:group-item-*). Covers each verb-classified shape plus
 * the four soundness traps:
 *   (a) display-index / placeholder / value groupItemTitles refused
 *   (b) negRisk exclusivity untouched (handler emits no grouping signal)
 *   (c) any-of "win a <major>" never becomes championship_winner rank≤1
 *   (d) per-map/per-game slot labels ("Map 1 Winner") refused
 */
import { describe, test, expect } from 'bun:test';
import { matchTemplate, type CandidateRow } from './text-deterministic.js';
import { extractEventDate } from './event-date-extractor.js';

function pmRow(
  title: string,
  git: string | null,
  overrides: Partial<CandidateRow> = {},
): CandidateRow {
  return {
    market_id: 1,
    platform: 'polymarket',
    platform_id: '0xabc',
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
    custom_strike: null,
    event_ticker: null,
    event_title: null,
    strike_date: null,
    rules_primary: null,
    yes_sub_title: null,
    subtitle: null,
    occurrence_datetime: null,
    expected_expiration_time: null,
    mve_selected_legs: null,
    mve_collection_ticker: null,
    kalshi_competition: null,
    description: null,
    slug: null,
    non_kalshi_event_title: null,
    outcomes_raw: null,
    sport_canonical: null,
    tags: null,
    market_category: null,
    parent_event_tags: null,
    limitless_market_type: null,
    limitless_home_team: null,
    limitless_away_team: null,
    limitless_sport_type: null,
    limitless_esport_title: null,
    limitless_league_name: null,
    limitless_start_ts: null,
    limitless_event_id: null,
    limitless_grouping_type: null,
    limitless_meta_type: null,
    native_question: null,
    is_neg_risk: null,
    pm_group_item_title: git,
    ...overrides,
  } as CandidateRow;
}

describe('pm:group-item — championship / award / draft winner', () => {
  test('entertainment award (outside Template C\'s sports gate) → championship_winner rank≤1', () => {
    const r = matchTemplate(
      pmRow('Will Poor Things win the 2026 Academy Award for Best Picture?', 'Poor Things', {
        category_unified: 'entertainment',
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-champ');
    expect(r!.subject_raw).toBe('Poor Things');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.value_primary).toBe(1);
    expect(r!.value_unit).toBe('rank');
    expect(r!.canonical_event_override).toBe('2026 Academy Award for Best Picture');
  });

  test('esports league-stage winner → championship_winner', () => {
    const r = matchTemplate(pmRow('Will LOUD win VCT 2026: Americas League Stage 1?', 'LOUD'));
    expect(r!.source_tag).toBe('pm:group-item-champ');
    expect(r!.subject_raw).toBe('LOUD');
    expect(r!.event_kind).toBe('championship_winner');
  });

  test('draft #1-overall slot → championship_winner (single-winner slot)', () => {
    const r = matchTemplate(
      pmRow('Will Adam Novotný be drafted 1st overall in the 2026 NHL Draft?', 'Adam Novotný'),
    );
    expect(r!.source_tag).toBe('pm:group-item-champ');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.value_primary).toBe(1);
  });

  test('tennis tour discriminator lifted for real championships (trap c, discriminator half)', () => {
    // category null so Template C's sports gate doesn't claim it first —
    // exercises the handler's own deriveTennisTour lift.
    const r = matchTemplate(
      pmRow(
        "Will Aryna Sabalenka win the 2026 Roland Garros Women's Singles?",
        'Aryna Sabalenka',
        { category_unified: null },
      ),
    );
    expect(r!.source_tag).toBe('pm:group-item-champ');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.canonical_event_tour).toBe('women');
  });
});

describe('pm:group-item — election winner (Template F contract)', () => {
  test('mayoral primary with "D.C." (F\'s middle class rejects the dot) → election_outcome_winner', () => {
    const r = matchTemplate(
      pmRow('Will Brian Schwalb win the 2026 Democratic D.C. Mayoral Primary?', 'Brian Schwalb', {
        category_unified: 'election',
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-election');
    expect(r!.event_kind).toBe('election_outcome_winner');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.value_primary).toBeNull();
    expect(r!.canonical_event_override).toBe('2026 Democratic D.C. Mayoral Primary');
  });

  test('parenthesized party label ("United Russia (ER)") → election_outcome_winner, ordinal kept in event', () => {
    const r = matchTemplate(
      pmRow(
        'Will United Russia (ER) win the second-most seats in the next Russian parliamentary election?',
        'United Russia (ER)',
        { category_unified: 'election' },
      ),
    );
    expect(r!.source_tag).toBe('pm:group-item-election');
    // "second-most" discriminator preserved so it can never collapse onto the
    // outright-winner question of the same election.
    expect(r!.canonical_event_override).toContain('second-most seats');
  });
});

describe('pm:group-item — stage advance', () => {
  test('"qualify for the League Phase" (verb Template D lacks) → stage_advance', () => {
    const r = matchTemplate(
      pmRow(
        'Will Juventus qualify for the League Phase of the 2026-27 UEFA Europa League?',
        'Juventus',
      ),
    );
    expect(r!.source_tag).toBe('pm:group-item-advance');
    expect(r!.event_kind).toBe('stage_advance');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.canonical_event_override).toBe('League Phase of the 2026-27 UEFA Europa League');
  });

  test('"make the playoffs" → stage_advance', () => {
    const r = matchTemplate(
      pmRow('Will the Connecticut Sun make the 2026 WNBA Playoffs?', 'Connecticut Sun'),
    );
    expect(r!.source_tag).toBe('pm:group-item-advance');
    expect(r!.event_kind).toBe('stage_advance');
  });
});

describe('pm:group-item — stat leader (rank≤1, never a count ladder)', () => {
  test('P2a: "win the most seats" → ELECTION race (kind-aligned with siblings), not leader', () => {
    const r = matchTemplate(
      pmRow(
        'Will AD+PD win the most seats in the House of Representatives in the 2026 Maltese general election?',
        'AD+PD',
        { category_unified: 'election', non_kalshi_event_title: 'Malta Parliamentary Election Winner' },
      ),
    );
    // Siblings phrased "win the <X> election" get election_outcome_winner via
    // the election tail; stamping championship_winner here would kind-fragment
    // one race. Both must land on the shared parent event title.
    expect(r!.source_tag).toBe('pm:group-item-election');
    expect(r!.event_kind).toBe('election_outcome_winner');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.value_primary).toBeNull();
    expect(r!.canonical_event_override).toBe('Malta Parliamentary Election Winner');
  });

  test('"hit the most home runs" with a real git → leader (COUNT_TRAP routes here, not champ)', () => {
    const r = matchTemplate(
      pmRow(
        'Will Aaron Judge hit the most home runs during the 2026 MLB regular season?',
        'Aaron Judge',
        { category_unified: 'entertainment' }, // dodge tryTemplateStatLeader's sports gate to exercise THIS handler
      ),
    );
    expect(r!.source_tag).toBe('pm:group-item-leader');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.value_primary).toBe(1);
  });

  test('P2a: yearless noun-phrase parent event gets the year appended (no cross-season fold)', () => {
    const r = matchTemplate(
      pmRow(
        'Will Yordan Alvarez lead the MLB in RBIs for the 2026 regular season?',
        'Yordan Alvarez',
        { category_unified: 'entertainment', non_kalshi_event_title: 'MLB: RBIs Leader' },
      ),
    );
    expect(r!.source_tag).toBe('pm:group-item-leader');
    expect(r!.canonical_event_override).toBe('MLB: RBIs Leader 2026');
  });

  test('P2a: raw-question parent event is NEVER stamped verbatim → gated noun phrase', () => {
    const r = matchTemplate(
      pmRow(
        'Will Alibaba have the best AI model at the end of May 2026?',
        'Alibaba',
        {
          category_unified: 'technology',
          non_kalshi_event_title: 'Which company has the best AI model end of May?',
        },
      ),
    );
    expect(r!.source_tag).toBe('pm:group-item-leader');
    // looksLikePredicate(parent) → statLeaderGatedEvent noun phrase, year included,
    // month re-appended (monthly recurring series must not fold across cycles
    // once the year-precision date coercion erases the day).
    expect(r!.canonical_event_override).toBe('Alibaba AI model leader 2026 May');
  });

  test('WP-4.1 unlock: lossy-BUT-recognized stat (long surface) → leader on the canonical stat token', () => {
    // "regular season home runs" is >2 words, but the stat vocab recognizes
    // "home runs" → 'home_runs', a reliable token that never folds distinct
    // stats. The event is built straight from it (`<git> home_runs leader
    // <year>`) instead of falling to generic.
    const r = matchTemplate(
      pmRow('Will Aaron Judge have the most regular season home runs in 2026?', 'Aaron Judge', {
        category_unified: 'entertainment',
        non_kalshi_event_title: 'Which player has the most regular season home runs?',
      }),
    );
    expect(r!.source_tag).toBe('pm:group-item-leader');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.value_primary).toBe(1);
    expect(r!.canonical_event_override).toBe('Aaron Judge home_runs leader 2026');
  });

  test('P2a: lossy stat compaction (3+-word stat, question parent) → generic, never a folded leader event', () => {
    // "Math AI model" and "Coding AI model" both compact to "AI model" — a
    // gated leader event would fold three distinct stat races (live
    // #3740720/#3740843). The full-title generic branch keeps them apart.
    const math = matchTemplate(
      pmRow('Will Alibaba have the best Math AI model at the end of May 2026?', 'Alibaba', {
        category_unified: 'technology',
        non_kalshi_event_title: 'Which company has the best Math AI model end of May?',
      }),
    );
    expect(math!.source_tag).toBe('pm:group-item-binary');
    expect(math!.canonical_event_override).toBe(
      'Will Alibaba have the best Math AI model at the end of May 2026?',
    );
  });

  test('P2a: no parent event → gated noun phrase with end_date year when title is yearless', () => {
    const r = matchTemplate(
      pmRow(
        'Will Jarren Duran lead the MLB in triples this season?',
        'Jarren Duran',
        { category_unified: 'entertainment', end_date: '2026-10-04T00:00:00Z' },
      ),
    );
    expect(r!.source_tag).toBe('pm:group-item-leader');
    expect(r!.canonical_event_override).toMatch(/\b2026\b/);
    expect(r!.canonical_event_override!.startsWith('Will ')).toBe(false);
  });
});

describe('pm:group-item — generic guarded binary fallback', () => {
  test('unclassifiable predicate with real subject → event_kind other, binary_event, full-title event', () => {
    const r = matchTemplate(
      pmRow('Will Camila Cabello perform at the 2026 FIFA World Cup Final halftime show?', 'Camila Cabello', {
        category_unified: 'entertainment',
      }),
    );
    expect(r!.source_tag).toBe('pm:group-item-binary');
    expect(r!.event_kind).toBe('other');
    expect(r!.condition_shape).toBe('binary_event');
    // Full title as event — two different predicates on the same subject can
    // never share a canonical_event.
    expect(r!.canonical_event_override).toBe(
      'Will Camila Cabello perform at the 2026 FIFA World Cup Final halftime show?',
    );
  });

  // Valued/threshold git predicates are shaped as numeric_threshold with a
  // real value/unit. Season win-totals stamp the Kalshi season-wins
  // convention (player_prop_threshold / count / unit='wins'), integer-grain
  // half-line canonicalized, so a team's rungs collapse to one per-team ladder.
  test('WP-4.1: "win 100+ games" (inclusive N+) → numeric_threshold ≥99.5 wins', () => {
    const r = matchTemplate(
      pmRow('Will the Boston Red Sox win 100+ games in the 2026 MLB regular season?', 'Boston Red Sox'),
    );
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-valued');
    expect(r!.condition_shape).toBe('monotonic_threshold');
    expect(r!.condition_direction).toBe('above');
    expect(r!.condition_metric).toBe('count');
    expect(r!.event_kind).toBe('player_prop_threshold');
    expect(r!.value_primary).toBe(99.5); // ≥100 integer-grain fold → 99.5
    expect(r!.value_unit).toBe('wins');
    expect(r!.subject_raw).toBe('Boston Red Sox');
  });

  test('WP-4.1: "win more than 90.5 games" (strict half-line) → numeric_threshold >90.5 wins', () => {
    const r = matchTemplate(
      pmRow('Will the Chicago Cubs win more than 90.5 games in the 2026 MLB regular season?', 'Chicago Cubs'),
    );
    expect(r!.source_tag).toBe('pm:group-item-valued');
    expect(r!.value_primary).toBe(90.5); // already a strict half-line → unchanged
    expect(r!.value_unit).toBe('wins');
    expect(r!.condition_direction).toBe('above');
  });

  test('WP-4.1: "win 100 or more games" (or-more inclusive) → ≥99.5 wins', () => {
    const r = matchTemplate(
      pmRow('Will the Detroit Tigers win 100 or more games during the 2026 MLB Regular Season?', 'Detroit Tigers'),
    );
    expect(r!.source_tag).toBe('pm:group-item-valued');
    expect(r!.value_primary).toBe(99.5);
    expect(r!.value_unit).toBe('wins');
  });

  test('WP-4.1: "score at least 30 goals" → ≥29.5 goals (non-win count noun kept, folded)', () => {
    const r = matchTemplate(
      pmRow('Will Erling Haaland score at least 30 goals in the 2026 season?', 'Erling Haaland', {
        category_unified: 'entertainment',
      }),
    );
    expect(r!.source_tag).toBe('pm:group-item-valued');
    expect(r!.value_primary).toBe(29.5);
    expect(r!.value_unit).toBe('goals');
    expect(r!.condition_direction).toBe('above');
  });

  test('WP-4.1: a valued row never emits a NULL value (the refusal\'s whole point)', () => {
    const r = matchTemplate(
      pmRow('Will the Chicago Cubs win more than 90.5 games in the 2026 MLB regular season?', 'Chicago Cubs'),
    );
    expect(r!.value_primary).not.toBeNull();
  });

  test('WP-4.1: exact-count "win 3 games" (no direction word) is NOT a valued threshold', () => {
    // No at-least/more-than/+/or-more marker → PM_GIT_VALUED_RX bails → the
    // handler never fabricates a direction; the predicate is not in the refuse
    // set either (no numeric operator), so it lands on the guarded binary.
    const r = matchTemplate(
      pmRow('Will the New York Mets win 3 games in May 2026?', 'New York Mets', {
        category_unified: 'entertainment',
      }),
    );
    expect(r!.source_tag).toBe('pm:group-item-binary');
    expect(r!.source_tag).not.toBe('pm:group-item-valued');
    expect(r!.value_primary).toBeNull();
  });

  test('WP-4.1: "vs" residue stays REFUSED (H2H arm deliberately not built — Template B owns H2H)', () => {
    // A non-sports git-anchored "vs" is a COMPARISON, not a match; Template B
    // (sports-gated, runs first) owns every real H2H. The "vs" clause of
    // PM_GIT_GENERIC_REFUSE_RX therefore correctly DROPS this rather than minting
    // a fake match_winner (belt.pm_git_refuse). Pins the §3.11 drop decision.
    expect(
      matchTemplate(pmRow('Will Bitcoin vs Gold in 2026?', 'Bitcoin', { category_unified: 'crypto' })),
    ).toBeNull();
  });

  test('WP-4.1: negated predicate stays REFUSED (genuinely LLM-shaped, class-a)', () => {
    // "^not …" is in PM_GIT_GENERIC_REFUSE_RX; the valued arm does not claim it,
    // so it falls through to the belt-counted refusal. category=entertainment so
    // Template C's sports gate doesn't intercept with a lazy-captured subject.
    expect(
      matchTemplate(pmRow('Will Sabrina Carpenter not perform at the 2026 Met Gala?', 'Sabrina Carpenter', {
        category_unified: 'entertainment',
      })),
    ).toBeNull();
  });

  test('git in OBJECT position is refused (subject discipline)', () => {
    expect(matchTemplate(pmRow('Will Donald Trump visit China in 2026?', 'China', { category_unified: 'politics' }))).toBeNull();
    expect(matchTemplate(pmRow('Will Trump say "Cookie" in May?', 'Cookie', { category_unified: 'politics' }))).toBeNull();
  });
});

describe('pm:group-item — trap (a): placeholder / display-index / value labels refused', () => {
  const cases: [string, string][] = [
    ['Will Person J win the 2026 Michigan Democratic Primary?', 'Person J'],
    ['Will Option 2 win the 2026 award?', 'Option 2'],
    ['Will B win the NC-11 House seat?', 'B'],
    ['Will the 2026 trade deficit be between 700B and 800B?', '700–800B'],
    ['Will Elon Musk post <40 tweets from May 14 to May 16, 2026?', '<40'],
    ['Will the Green Party win at least 800 council seat elections in the 2026 United Kingdom local elections?', '800+'],
    ['Tim Walz in jail by March 31?', 'March 31, 2026'],
    ['Will another party win the MI-12 House seat?', 'Other'],
  ];
  for (const [title, git] of cases) {
    test(`git="${git}" → refused`, () => {
      expect(matchTemplate(pmRow(title, git, { category_unified: 'election' }))).toBeNull();
    });
  }
});

describe('pm:group-item — an "any of N" family is never a one-winner race', () => {
  test('"win a Grand Slam" → generic other/binary, NOT championship_winner rank≤1', () => {
    const r = matchTemplate(
      pmRow('Will Carlos Alcaraz win a Grand Slam in 2026?', 'Carlos Alcaraz'),
    );
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-binary');
    expect(r!.event_kind).toBe('other');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.value_primary).toBeNull();
  });

  test('"win another major" → generic, never rank≤1', () => {
    const r = matchTemplate(pmRow('Will Rory McIlroy win another major in 2026?', 'Rory McIlroy'));
    expect(r).not.toBeNull();
    expect(r!.event_kind).toBe('other');
    expect(r!.condition_shape).toBe('binary_event');
  });
});

describe('pm:group-item — trap (d): per-map/per-game slot labels refused', () => {
  test('"Map 1 Winner" / "Game 2 Winner" gits never become subjects', () => {
    expect(
      matchTemplate(
        pmRow('Valorant: NAVI Junior vs Team Liquid Academy - Map 1 Winner', 'Map 1 Winner'),
      ),
    ).toBeNull();
    expect(
      matchTemplate(pmRow('Dota 2: BetBoom Team vs Aurora - Game 2 Winner', 'Game 2 Winner')),
    ).toBeNull();
  });
});

describe('pm:group-item — trap (b): negRisk exclusivity untouched', () => {
  test('handler output carries NO grouping/mutex assertion fields (native negRisk is the only exclusivity source)', () => {
    const r = matchTemplate(
      pmRow('Will Brian Schwalb win the 2026 Democratic D.C. Mayoral Primary?', 'Brian Schwalb', {
        category_unified: 'election',
      }),
    )!;
    // TemplateMatch has no grouping surface at all — assert nothing grouping-
    // shaped leaked in (guards against a future field addition being stamped
    // here without revisiting the native-only doctrine).
    for (const k of Object.keys(r)) {
      expect(k.includes('grouping')).toBe(false);
      expect(k.includes('mutex')).toBe(false);
      expect(k.includes('neg_risk')).toBe(false);
    }
  });
});

describe('pm:group-item — P0: membership selections never one-winner', () => {
  test('"be named TO the PFA Team of the Year" (11-member squad) → generic, never champ rank≤1', () => {
    const r = matchTemplate(
      pmRow(
        'Will Jordan Pickford be named to the 2026 PFA Premier League Team of the Year?',
        'Jordan Pickford',
        { non_kalshi_event_title: 'EPL: 2026 PFA Team of the Year' },
      ),
    );
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-binary');
    expect(r!.event_kind).toBe('other');
    expect(r!.condition_shape).toBe('binary_event');
    expect(r!.value_primary).toBeNull();
  });

  test('single-slot named award stays champ (control: Sexiest Man Alive)', () => {
    const r = matchTemplate(
      pmRow(
        "Will Glen Powell be named People's 2026 Sexiest Man Alive?",
        'Glen Powell',
        { category_unified: 'entertainment' },
      ),
    );
    expect(r!.source_tag).toBe('pm:group-item-champ');
    expect(r!.event_kind).toBe('championship_winner');
  });
});

describe('pm:group-item — P1a: multi-laureate awards never one-winner', () => {
  test('Fields Medal (2-4 laureates/cycle, rules resolve to the winnerS) → generic', () => {
    const r = matchTemplate(
      pmRow('Will Yu Deng win the 2026 Fields Medal?', 'Yu Deng', { category_unified: 'other' }),
    );
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-binary');
    expect(r!.event_kind).toBe('other');
    expect(r!.condition_shape).toBe('binary_event');
  });

  test('Nobel Peace Prize stays champ (PM rules force a single winner via precedence order)', () => {
    const r = matchTemplate(
      pmRow('Will Donald Trump win the Nobel Peace Prize in 2026?', 'Donald Trump', {
        category_unified: 'politics',
      }),
    );
    expect(r!.source_tag).toBe('pm:group-item-champ');
    expect(r!.event_kind).toBe('championship_winner');
    expect(r!.value_primary).toBe(1);
  });
});

describe('pm:group-item — P1b: event-phrase quality gate on one-winner branches', () => {
  test('yearless bare "Eastern Conference" → generic (would fold across seasons AND leagues)', () => {
    const r = matchTemplate(
      pmRow('Will the Columbus Blue Jackets win the Eastern Conference?', 'Columbus Blue Jackets'),
    );
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-binary');
    expect(r!.event_kind).toBe('other');
    expect(r!.condition_shape).toBe('binary_event');
  });

  test('deictic "their division" → generic', () => {
    const r = matchTemplate(pmRow('Will the New York Yankees win their division?', 'New York Yankees'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-binary');
    expect(r!.event_kind).toBe('other');
  });

  test('gold-medal phrasing → generic (per-discipline any-of hole)', () => {
    const r = matchTemplate(
      // category null dodges tryTemplateStatLeader's sports gate so THIS
      // handler's leader branch (and its event gate) is what's exercised.
      pmRow('Will Norway win the most gold medals at the 2030 Winter Olympics?', 'Norway', {
        category_unified: null,
      }),
    );
    // leader-RX claims "win the most …"; the leader event gate must also hold.
    if (r?.source_tag === 'pm:group-item-leader' || r?.source_tag === 'pm:group-item-champ') {
      throw new Error(`gold-medal phrasing stamped one-winner: ${r.source_tag}`);
    }
    expect(r?.source_tag ?? 'pm:group-item-binary').toBe('pm:group-item-binary');
  });

  test('year-carrying conference event stays champ (control)', () => {
    const r = matchTemplate(
      // category null dodges Template C's sports gate — exercises THIS handler.
      pmRow('Will the Florida Panthers win the 2026 Eastern Conference Finals?', 'Florida Panthers', {
        category_unified: null,
      }),
    );
    expect(r!.source_tag).toBe('pm:group-item-champ');
    expect(r!.event_kind).toBe('championship_winner');
  });
});

describe('pm:group-item — duplicate fixture-prop titles (halftime policy)', () => {
  // Every duplicate (git,title) group this branch claims stamps distinct
  // condition_dates — PM slugs embed the fixture date (slug-iso, day
  // precision), so identical titles across fixtures cannot fold into one
  // question. The generic branch therefore keeps claiming bare fixture props;
  // this test pins both halves of that policy.
  test('bare present-progressive prop is claimed generic with the full title as event', () => {
    const r = matchTemplate(pmRow('FK Bodø/Glimt leading at halftime?', 'FK Bodø/Glimt'));
    expect(r).not.toBeNull();
    expect(r!.source_tag).toBe('pm:group-item-binary');
    expect(r!.event_kind).toBe('other');
    expect(r!.canonical_event_override).toBe('FK Bodø/Glimt leading at halftime?');
  });

  test('slug-iso dates discriminate identical fixture-prop titles (the fold guard)', () => {
    const a = extractEventDate(
      pmRow('FK Bodø/Glimt leading at halftime?', 'FK Bodø/Glimt', {
        slug: 'nor-bod-vik-2026-05-16-halftime-leader',
        end_date: '2026-05-16T19:00:00Z',
      }),
    );
    const b = extractEventDate(
      pmRow('FK Bodø/Glimt leading at halftime?', 'FK Bodø/Glimt', {
        slug: 'nor-bod-ros-2026-05-24-halftime-leader',
        end_date: '2026-05-24T17:00:00Z',
      }),
    );
    expect(a?.iso).toBe('2026-05-16');
    expect(b?.iso).toBe('2026-05-24');
    expect(a!.iso).not.toBe(b!.iso);
  });
});

describe('pm:group-item — non-PM / missing-git rows untouched', () => {
  test('kalshi row with same title shape is not claimed', () => {
    const r = matchTemplate(
      pmRow('Will Poor Things win the 2026 Academy Award for Best Picture?', 'Poor Things', {
        platform: 'kalshi',
        category_unified: 'entertainment',
      }),
    );
    expect(r?.source_tag?.startsWith('pm:group-item') ?? false).toBe(false);
  });

  test('PM row without groupItemTitle falls through', () => {
    const r = matchTemplate(
      pmRow('Will Poor Things win the 2026 Academy Award for Best Picture?', null, {
        category_unified: 'entertainment',
      }),
    );
    expect(r?.source_tag?.startsWith('pm:group-item') ?? false).toBe(false);
  });
});
