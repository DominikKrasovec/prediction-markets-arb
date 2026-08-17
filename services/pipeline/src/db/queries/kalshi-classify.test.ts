/**
 * Unit tests for the pure Kalshi grouping classifier.
 *
 * These pin the decision rule: bundle-first, categorical-second,
 * unknown-default. Real-DB samples drive the cases — see the
 * investigation in the design doc for the source data.
 */
import { describe, test, expect } from 'bun:test';
import {
  classifyKalshiEvent,
  classifyKalshiTitle,
  extractKalshiTemplate,
  templatePromotesToCategorical,
  isMonotonicThresholdPromotion,
  isMonotonicStrikeTypePromotion,
  isIndependentSelectionPromotion,
  nativeMutexGrouping,
} from './kalshi-classify.js';

describe('nativeMutexGrouping (P-GROUP §3.7 case a/c1 native-mutex verdict)', () => {
  test('mutually_exclusive=true (negRisk-analog) → categorical_exclusive', () => {
    // The one-of-n MECNET settlement proof — the certifier still gates Σ=1 vs Σ≤1.
    expect(nativeMutexGrouping(true)).toBe('categorical_exclusive');
  });
  test('mutually_exclusive=false (proven independent) → bundle_nonexclusive', () => {
    // casting / talk-show-guest / relegation / cumulative-ladder class — never mutex.
    expect(nativeMutexGrouping(false)).toBe('bundle_nonexclusive');
  });
  test('absent (null) → null (caller keeps its title/template verdict)', () => {
    expect(nativeMutexGrouping(null)).toBeNull();
  });
});

describe('classifyKalshiTitle (single-title helper)', () => {
  test('empty / null / undefined → unknown', () => {
    expect(classifyKalshiTitle('')).toBe('unknown');
    expect(classifyKalshiTitle(null)).toBe('unknown');
    expect(classifyKalshiTitle(undefined)).toBe('unknown');
  });

  test('"Who will win …" → categorical_exclusive', () => {
    expect(classifyKalshiTitle('Who will win the 2026 Michigan Senate race?'))
      .toBe('categorical_exclusive');
    expect(classifyKalshiTitle('Who will win MVP?'))
      .toBe('categorical_exclusive');
  });

  test('"Who will be the next …" → categorical_exclusive', () => {
    expect(classifyKalshiTitle('Who will be the next manager of Manchester United?'))
      .toBe('categorical_exclusive');
    expect(classifyKalshiTitle("Who will be Trump's next Attorney General?"))
      .toBe('categorical_exclusive');
  });

  test('"Who will hold the X Title on/by date" → categorical_exclusive', () => {
    expect(classifyKalshiTitle('Who will hold the WBC Bantamweight Title on January 1, 2027?'))
      .toBe('categorical_exclusive');
  });

  test('"Who will be Fantasy Football: …" → categorical_exclusive', () => {
    expect(classifyKalshiTitle('Who will be Fantasy Football: 2026-27 Season Top QB?'))
      .toBe('categorical_exclusive');
  });

  test('"Who will headline …" → categorical_exclusive', () => {
    expect(classifyKalshiTitle('Who will headline the Pro Football Championship Halftime Show?'))
      .toBe('categorical_exclusive');
  });

  test('"Who will perform the next …" → categorical_exclusive', () => {
    expect(classifyKalshiTitle('Who will perform the next James Bond Song?'))
      .toBe('categorical_exclusive');
  });

  test('"Who will be picked 1st …" → categorical_exclusive', () => {
    expect(classifyKalshiTitle('Who will be picked 1st in the Pro Football Draft?'))
      .toBe('categorical_exclusive');
  });

  test('"Which managers will be out …" → bundle_nonexclusive', () => {
    expect(classifyKalshiTitle('Which Pro Baseball Managers will be out before Dec 1, 2026?'))
      .toBe('bundle_nonexclusive');
    expect(classifyKalshiTitle('Which Pro Football coaches will be out before Sep 1, 2026?'))
      .toBe('bundle_nonexclusive');
  });

  test('"Which EPL teams will qualify …" → bundle_nonexclusive', () => {
    expect(classifyKalshiTitle('Which EPL teams will qualify for the Champions League?'))
      .toBe('bundle_nonexclusive');
  });

  test('"Who will host SNL Season 51?" → bundle_nonexclusive (multi-host)', () => {
    expect(classifyKalshiTitle('Who will host Saturday Night Live Season 51?'))
      .toBe('bundle_nonexclusive');
  });

  test('"Who will perform at … halftime show?" → bundle_nonexclusive (collabs)', () => {
    expect(classifyKalshiTitle('Who will perform at the 2026 FIFA World Cup final halftime show?'))
      .toBe('bundle_nonexclusive');
  });

  test('"Who will run for … nomination?" → bundle_nonexclusive', () => {
    expect(classifyKalshiTitle('Who will run for the Democratic presidential nomination in 2028?'))
      .toBe('bundle_nonexclusive');
  });

  test('"Who will IPO before …" → bundle_nonexclusive', () => {
    expect(classifyKalshiTitle('Who will IPO before 2027?'))
      .toBe('bundle_nonexclusive');
  });

  test('"Who will dissent at … FOMC meeting?" → bundle_nonexclusive', () => {
    expect(classifyKalshiTitle('Who will dissent at the June 2026 FOMC meeting?'))
      .toBe('bundle_nonexclusive');
  });

  test('"Who will be named in Epstein documents …" → bundle_nonexclusive', () => {
    expect(classifyKalshiTitle('Who will be named in Epstein documents released in 2026?'))
      .toBe('bundle_nonexclusive');
  });

  test('case-insensitive', () => {
    expect(classifyKalshiTitle('WHO WILL WIN MVP?')).toBe('categorical_exclusive');
    expect(classifyKalshiTitle('which managers will be out before dec 1, 2026?'))
      .toBe('bundle_nonexclusive');
  });

  test('unmatched title → unknown', () => {
    expect(classifyKalshiTitle('Bitcoin price on May 10, 2026?')).toBe('unknown');
    expect(classifyKalshiTitle('Lakers vs Celtics: who wins?')).toBe('unknown');
  });

  test('bundle vs categorical disambiguation: SNL host (bundle) vs "next host" (categorical)', () => {
    // Saturday Night Live Season N has many episode hosts.
    expect(classifyKalshiTitle('Who will host Saturday Night Live Season 51?'))
      .toBe('bundle_nonexclusive');
    // A specific singular successor question — different shape ("the next host").
    expect(classifyKalshiTitle("Who will be the next host of Saturday Night Live?"))
      .toBe('categorical_exclusive');
  });
});

describe('classifyKalshiEvent (event-level — multi-title)', () => {
  test('empty input → unknown', () => {
    expect(classifyKalshiEvent([])).toBe('unknown');
  });

  test('all categorical-pattern siblings → categorical_exclusive', () => {
    expect(classifyKalshiEvent([
      'Who will be the next manager of Manchester United?',
      'Who will be the next manager of Manchester United?',
      'Who will be the next manager of Manchester United?',
    ])).toBe('categorical_exclusive');
  });

  test('all bundle-pattern siblings → bundle_nonexclusive', () => {
    expect(classifyKalshiEvent([
      'Who will IPO before 2027?',
      'Who will IPO before 2027?',
    ])).toBe('bundle_nonexclusive');
  });

  test('one bundle sibling poisons the verdict (Gap 3 protection)', () => {
    expect(classifyKalshiEvent([
      'Who will win Best Picture?',
      'Who will win Best Picture?',
      'Which nominees will win an Oscar?',
    ])).toBe('bundle_nonexclusive');
  });

  test('one outlier title with NO pattern match cannot poison categorical (Gap 3 protection)', () => {
    expect(classifyKalshiEvent([
      "Who will be Trump's next Attorney General?",
      "Some unmatchable typo here",
      "Who will be Trump's next Attorney General?",
    ])).toBe('categorical_exclusive');
  });

  test('all-unmatched siblings → unknown', () => {
    expect(classifyKalshiEvent([
      'Bitcoin price on May 10, 2026?',
      'Will the Lakers win their next game?',
    ])).toBe('unknown');
  });

  test('order-independence', () => {
    const titles = [
      "Who will be Trump's next Attorney General?",
      'Unmatched outlier',
      "Who will be Trump's next Attorney General?",
    ];
    expect(classifyKalshiEvent(titles))
      .toBe(classifyKalshiEvent([...titles].reverse()));
  });

  test('whitespace / null / empty entries ignored', () => {
    expect(classifyKalshiEvent([
      '',
      '   ',
      null,
      undefined,
      'Who will win MVP?',
    ])).toBe('categorical_exclusive');
  });

  test('monotone-bundle: adding a bundle title to a categorical set flips to bundle', () => {
    const baseSet = [
      "Who will be Trump's next Attorney General?",
      "Who will be Trump's next Attorney General?",
    ];
    expect(classifyKalshiEvent(baseSet)).toBe('categorical_exclusive');
    expect(classifyKalshiEvent([...baseSet, 'Who will dissent at the June 2026 FOMC meeting?']))
      .toBe('bundle_nonexclusive');
  });

  test('monotone-bundle: bundle stays bundle when more titles arrive', () => {
    const baseSet = ['Who will IPO before 2027?'];
    expect(classifyKalshiEvent(baseSet)).toBe('bundle_nonexclusive');
    expect(classifyKalshiEvent([...baseSet, 'Who will win MVP?']))
      .toBe('bundle_nonexclusive');
  });

  test('real DB sample — "Who will perform at FIFA halftime" (133 siblings)', () => {
    const titles = Array(133).fill('Who will perform at the 2026 FIFA World Cup final halftime show?');
    expect(classifyKalshiEvent(titles)).toBe('bundle_nonexclusive');
  });

  test('real DB sample — "Who will be the next Head Coach" (22 siblings)', () => {
    const titles = Array(22).fill('Who will be the next Head Coach of the Portland Pro Basketball Team?');
    expect(classifyKalshiEvent(titles)).toBe('categorical_exclusive');
  });

  test('real DB sample — WBC title-holder series (19 siblings)', () => {
    const titles = Array(19).fill('Who will hold the WBC Bantamweight Title on January 1, 2027?');
    expect(classifyKalshiEvent(titles)).toBe('categorical_exclusive');
  });

  test('real DB sample — "Which Pro Baseball Managers will be out" (28 siblings)', () => {
    const titles = Array(28).fill('Which Pro Baseball Managers will be out before Dec 1, 2026?');
    expect(classifyKalshiEvent(titles)).toBe('bundle_nonexclusive');
  });
});

describe('extractKalshiTemplate', () => {
  test('empty input', () => {
    const t = extractKalshiTemplate([]);
    expect(t.template).toBeNull();
    expect(t.vote_count).toBe(0);
    expect(t.vote_ratio).toBe(0);
  });

  test('all rows lack candidates → no template', () => {
    const t = extractKalshiTemplate([
      { rules_primary: 'If X happens, YES.', candidate: null },
      { rules_primary: 'If X happens, YES.', candidate: null },
    ]);
    expect(t.template).toBeNull();
    expect(t.vote_ratio).toBe(0);
  });

  test('candidate not in rule → not counted as templated', () => {
    const t = extractKalshiTemplate([
      { rules_primary: 'If the score is 1-0, YES.', candidate: 'Donald Trump' },
      { rules_primary: 'If the score is 2-0, YES.', candidate: 'Donald Trump' },
    ]);
    expect(t.template).toBeNull();
  });

  test('real shape — KXNEWPOPE (7 candidates, identical template)', () => {
    const rule = (name: string) =>
      `If ${name} becomes the first person elected Pope before Jan 1, 2070, then the market resolves to Yes.`;
    const markets = [
      { rules_primary: rule('Pierbattista Pizzaballa'), candidate: 'Pierbattista Pizzaballa' },
      { rules_primary: rule('Matteo Zuppi'),            candidate: 'Matteo Zuppi' },
      { rules_primary: rule('Peter Erdo'),              candidate: 'Peter Erdo' },
      { rules_primary: rule('Luis Antonio Tagle'),      candidate: 'Luis Antonio Tagle' },
      { rules_primary: rule('Robert Sarah'),            candidate: 'Robert Sarah' },
      { rules_primary: rule('Mario Grech'),             candidate: 'Mario Grech' },
      { rules_primary: rule('Anders Arborelius'),       candidate: 'Anders Arborelius' },
    ];
    const t = extractKalshiTemplate(markets);
    expect(t.template).toBe(
      'If {x} becomes the first person elected Pope before Jan 1, 2070, then the market resolves to Yes.'
    );
    expect(t.vote_count).toBe(7);
    expect(t.total_with_rule).toBe(7);
    expect(t.vote_ratio).toBe(1);
    expect(templatePromotesToCategorical(t)).toBe(true);
  });

  test('Unicode-safe word boundaries (José, O\'Brien)', () => {
    const t = extractKalshiTemplate([
      { rules_primary: 'If José wins, YES.', candidate: 'José' },
      { rules_primary: "If O'Brien wins, YES.", candidate: "O'Brien" },
      { rules_primary: 'If Müller wins, YES.', candidate: 'Müller' },
      { rules_primary: 'If Smith wins, YES.', candidate: 'Smith' },
    ]);
    expect(t.template).toBe('If {x} wins, YES.');
    expect(t.vote_count).toBe(4);
  });

  test('partial vote: 3 of 4 share template, 1 has different rule', () => {
    const t = extractKalshiTemplate([
      { rules_primary: 'If {real} wins X, YES.'.replace('{real}', 'A'), candidate: 'A' },
      { rules_primary: 'If {real} wins X, YES.'.replace('{real}', 'B'), candidate: 'B' },
      { rules_primary: 'If {real} wins X, YES.'.replace('{real}', 'C'), candidate: 'C' },
      { rules_primary: 'Different rule entirely about D.', candidate: 'D' },
    ]);
    expect(t.template).toBe('If {x} wins X, YES.');
    expect(t.vote_count).toBe(3);
    expect(t.total_with_rule).toBe(4);
    expect(t.vote_ratio).toBeCloseTo(0.75, 10);
    expect(templatePromotesToCategorical(t)).toBe(false);   // 75% < 80% floor
  });

  test('templatePromotesToCategorical floors at 4 siblings', () => {
    // 3/3 = 100% vote, but too few siblings to be reliable.
    const small = extractKalshiTemplate([
      { rules_primary: 'If A wins, YES.', candidate: 'A' },
      { rules_primary: 'If B wins, YES.', candidate: 'B' },
      { rules_primary: 'If C wins, YES.', candidate: 'C' },
    ]);
    expect(small.vote_ratio).toBe(1);
    expect(templatePromotesToCategorical(small)).toBe(false);

    // 4/4 = 100% vote → passes.
    const enough = extractKalshiTemplate([
      { rules_primary: 'If A wins, YES.', candidate: 'A' },
      { rules_primary: 'If B wins, YES.', candidate: 'B' },
      { rules_primary: 'If C wins, YES.', candidate: 'C' },
      { rules_primary: 'If D wins, YES.', candidate: 'D' },
    ]);
    expect(templatePromotesToCategorical(enough)).toBe(true);
  });

  test('candidate substring inside another word does NOT template', () => {
    // "Trump" must not match "Trumpet" — guarded by Unicode word boundaries.
    const t = extractKalshiTemplate([
      { rules_primary: 'If Trump wins, YES.', candidate: 'Trump' },
      { rules_primary: 'If the Trumpet plays first, YES.', candidate: 'Trumpet' },
    ]);
    // Both substitute their own candidate cleanly, but they produce different
    // templates ("If {x} wins" vs "If the {x} plays first") so no majority.
    expect(t.vote_count).toBe(1);
  });
});

describe('isMonotonicThresholdPromotion (blocks fake categorical mutex)', () => {
  // Real DB shape — KXMLBSEASONHR: player templated away, "20+" threshold stays.
  const seasonStats = (player: string) => ({
    rules_primary: `If ${player} records 20+ home runs across all games during the 2026 Pro Baseball regular season, then the market resolves to Yes.`,
    candidate: player,
  });

  test('(a) per-entity threshold survives in template → blocked (Season Stats)', () => {
    const t = extractKalshiTemplate([
      seasonStats('Yandy Díaz'), seasonStats('Will Smith'),
      seasonStats('Trea Turner'), seasonStats('Trevor Story'),
    ]);
    expect(templatePromotesToCategorical(t)).toBe(true); // would have promoted
    expect(isMonotonicThresholdPromotion(t, ['Yandy Díaz', 'Will Smith', 'Trea Turner', 'Trevor Story'])).toBe(true);
  });

  test('(b) "N+" candidates are ladder rungs → blocked (Win totals / Arsenal cups)', () => {
    // Win totals: one event per team, threshold IS the candidate.
    const t = extractKalshiTemplate([
      { rules_primary: 'If Oakland has 65+ wins in the 2026 pro baseball team regular season, then the market resolves to Yes.', candidate: '65+ wins' },
      { rules_primary: 'If Oakland has 70+ wins in the 2026 pro baseball team regular season, then the market resolves to Yes.', candidate: '70+ wins' },
      { rules_primary: 'If Oakland has 75+ wins in the 2026 pro baseball team regular season, then the market resolves to Yes.', candidate: '75+ wins' },
      { rules_primary: 'If Oakland has 80+ wins in the 2026 pro baseball team regular season, then the market resolves to Yes.', candidate: '80+ wins' },
    ]);
    expect(isMonotonicThresholdPromotion(t, ['65+ wins', '70+ wins', '75+ wins', '80+ wins'])).toBe(true);
    expect(isMonotonicThresholdPromotion(t, ['1+ Trophies', '2+ Trophies', '3+ Trophies', '4+ Trophies'])).toBe(true);
  });

  test('name-selection race (Pope) → NOT blocked', () => {
    const rule = (n: string) => `If ${n} becomes the first person elected Pope before Jan 1, 2070, then the market resolves to Yes.`;
    const names = ['Pierbattista Pizzaballa', 'Matteo Zuppi', 'Peter Erdo', 'Luis Antonio Tagle'];
    const t = extractKalshiTemplate(names.map((n) => ({ rules_primary: rule(n), candidate: n })));
    expect(templatePromotesToCategorical(t)).toBe(true);
    expect(isMonotonicThresholdPromotion(t, names)).toBe(false); // "2070" is a year, not a threshold
  });

  test('exact-value buckets and spread buckets → NOT blocked', () => {
    // Spread: "over 1.5" is not the cumulative "N+" form, and the full-string
    // candidate is templated away so no threshold survives in the template.
    const spread = extractKalshiTemplate([
      { rules_primary: 'If Anaheim wins by over 1.5 goals, then the market resolves to Yes.', candidate: 'Anaheim wins by over 1.5 goals' },
      { rules_primary: 'If Buffalo wins by over 1.5 goals, then the market resolves to Yes.', candidate: 'Buffalo wins by over 1.5 goals' },
      { rules_primary: 'If Anaheim wins by over 2.5 goals, then the market resolves to Yes.', candidate: 'Anaheim wins by over 2.5 goals' },
      { rules_primary: 'If Buffalo wins by over 2.5 goals, then the market resolves to Yes.', candidate: 'Buffalo wins by over 2.5 goals' },
    ]);
    expect(isMonotonicThresholdPromotion(spread, ['Anaheim wins by over 1.5 goals', 'Buffalo wins by over 1.5 goals'])).toBe(false);
    // Division winners: team-name candidates, no threshold anywhere.
    const t = extractKalshiTemplate([
      { rules_primary: 'If Arizona wins the division, YES.', candidate: 'Arizona' },
      { rules_primary: 'If Atlanta wins the division, YES.', candidate: 'Atlanta' },
      { rules_primary: 'If Baltimore wins the division, YES.', candidate: 'Baltimore' },
      { rules_primary: 'If Boston wins the division, YES.', candidate: 'Boston' },
    ]);
    expect(isMonotonicThresholdPromotion(t, ['Arizona', 'Atlanta', 'Baltimore', 'Boston'])).toBe(false);
  });
});

describe('isIndependentSelectionPromotion (blocks non-numeric fake categorical mutex)', () => {
  // Each template below is a REAL templated rule from the live DB (entity → {x}).
  // INDEPENDENT / LADDER → must be blocked (true).
  const tmpl = (template: string) => ({ template, vote_count: 9, total_with_rule: 9, vote_ratio: 1 });

  test('World Cup squad selection → blocked (many players make the squad)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} is selected for the final squad for the Brazil national team for the 2026 FIFA World Cup, then the market resolves to Yes.',
    ))).toBe(true);
  });

  test('award nominations → blocked (many nominees)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} has been nominated for Best Picture at the 99th Academy Awards, then the market resolves to Yes.',
    ))).toBe(true);
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} has been nominated for Album of the Year at the 69th Grammy Awards, then the market resolves to Yes.',
    ))).toBe(true);
  });

  test('tournament qualification → blocked (many qualify / advance)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      "If {x} qualifies for the 2027 Men's College Basketball Round of 32, then the market resolves to Yes.",
    ))).toBe(true);
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} is one of the teams to qualify for the Final in the 2026 FIFA World Cup, then the market resolves to Yes.',
    ))).toBe(true);
  });

  test('"ranked / finishes top N" → blocked (up to N are YES; ladder across N)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} is ranked top 10 on the College Football AP Poll Week 1 Rankings for the 2026-27 season, then the market resolves to Yes.',
    ))).toBe(true);
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} finishes in the top 5 (including ties) in the 2026 LIV Golf Virginia, then the market resolves to Yes.',
    ))).toBe(true);
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} finishes Top 10 at the Eurovision Song Contest 2026 Grand Final, then the market resolves to Yes.',
    ))).toBe(true);
  });

  test('chart achievement & release → blocked (each artist independent)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} has a #1 song on the Billboard Hot 100 (including features), by the Billboard issue for the week of Dec 26, 2026, then the market resolves to Yes.',
    ))).toBe(true);
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} has a top 10 song on the Billboard Hot 100, by the Billboard issue for the week of Dec 26, 2026, then the market resolves to Yes.',
    ))).toBe(true);
    expect(isIndependentSelectionPromotion(tmpl('If {x} releases a new album in 2026, then the market resolves to Yes.'))).toBe(true);
  });

  test('golf "make the cut" / eagle / #1-seed / search-trend → blocked (independent, 2026-06-06)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} has made the cut at the 2026 PGA Championship, then the market resolves to Yes.',
    ))).toBe(true);
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} records an eagle in round 1 of the 2026 Masters Tournament, then the market resolves to Yes.',
    ))).toBe(true);
    expect(isIndependentSelectionPromotion(tmpl(
      "If {x} is selected as a #1 seed in the 2027 Men's College Basketball Tournament, then the market resolves to Yes.",
    ))).toBe(true);
    // genuine single-winner golf mutex (lowest strokes) must STILL be allowed (regression)
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} records the lowest total strokes among all PGA Championship past champion golfers, then the market resolves to Yes.',
    ))).toBe(false);
  });

  test('speech-mention prop → blocked (many phrases can be said)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If the play by play or color commentator(s) says {x} as part of Pistons vs Cavaliers Professional Basketball Game, then the market resolves to Yes.',
    ))).toBe(true);
  });

  // GENUINE one-winner mutex → must NOT be blocked (false).
  test('award WINNER → not blocked (one winner)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} has won Best Hip-Hop Album at the 2026 American Music Awards, then the market resolves to Yes.',
    ))).toBe(false);
  });

  test('election / primary winner → not blocked (one winner)', () => {
    expect(isIndependentSelectionPromotion(tmpl('If {x} wins the 2026 Alaska Senate election, then the market resolves to Yes.'))).toBe(false);
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} wins the nomination for the Republican Party to contest the 2026 AL-01 House seat, then the market resolves to Yes.',
    ))).toBe(false);
  });

  test('exact chart POSITION (ranked #N) → not blocked (one song per slot)', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If SOS by SZA is ranked #{x} on the Billboard 200 chart for the Week of May 23, 2026, then the market resolves to Yes.',
    ))).toBe(false);
  });

  test('"top <noun>" with NO digit (lowest-strokes winner) → not blocked', () => {
    expect(isIndependentSelectionPromotion(tmpl(
      'If {x} records the lowest total strokes among all PGA Championship past champion golfers who complete the full tournament, then the market resolves to Yes.',
    ))).toBe(false);
  });

  test('null template → not blocked', () => {
    expect(isIndependentSelectionPromotion({ template: null, vote_count: 0, total_with_rule: 0, vote_ratio: 0 })).toBe(false);
  });
});

describe('isMonotonicThresholdPromotion — extended candidate forms (M-LADDER-1)', () => {
  // KXARTISTSTREAMSY: yes_sub_title candidates are "Above N.NB" (strike_type 'greater').
  // The extended CUMULATIVE_CANDIDATE_RX must now catch the leading "Above N" half-line
  // form, so a shared template over these LADDER rungs is blocked from categorical.
  test('"Above N" stream-ladder candidates → blocked (regex extension)', () => {
    const t = { template: 'If {x}, then the market resolves to Yes.', vote_count: 6, total_with_rule: 6, vote_ratio: 1 };
    expect(isMonotonicThresholdPromotion(t as any, ['Above 2.6B', 'Above 2.5B', 'Above 2.4B', 'Above 2.3B', 'Above 2.2B', 'Above 2.1B'])).toBe(true);
  });

  test('"Over / Greater than N" half-line candidates → blocked', () => {
    const t = { template: 'shared', vote_count: 4, total_with_rule: 4, vote_ratio: 1 };
    expect(isMonotonicThresholdPromotion(t as any, ['Over 100', 'Over 200', 'Greater than 300', 'Over 400'])).toBe(true);
  });

  test('team-name candidates (no leading threshold) → NOT blocked (regression)', () => {
    const t = { template: 'If {x} wins the division, YES.', vote_count: 4, total_with_rule: 4, vote_ratio: 1 };
    // "Above Average Joe" would be a false positive if the regex were unanchored on
    // "above" alone — but it requires a DIGIT after the half-line word, so a team name
    // beginning with "Above"/"Over" without a number stays promotable.
    expect(isMonotonicThresholdPromotion(t as any, ['Arizona', 'Atlanta', 'Baltimore', 'Boston'])).toBe(false);
  });

  test('mid-string spread bucket ("wins by over 1.5") still NOT blocked by candidate form', () => {
    // anchored ^ means the threshold must lead — a spread candidate with the number
    // mid-string does not match the candidate regex (the template path handles spreads).
    const t = { template: 'If {x}, YES.', vote_count: 4, total_with_rule: 4, vote_ratio: 1 };
    expect(isMonotonicThresholdPromotion(t as any, ['Anaheim wins by over 1.5 goals', 'Buffalo wins by over 1.5 goals', 'Anaheim wins by over 2.5 goals', 'Boston wins by over 2.5 goals'])).toBe(false);
  });
});

describe('isMonotonicStrikeTypePromotion — gated strike_type ladder guard (M-LADDER-1)', () => {
  test('≥80% half-line strike_type ("greater") single-subject → blocked (KXARTISTSTREAMSY)', () => {
    const strikes = ['greater', 'greater', 'greater', 'greater', 'greater', 'greater'];
    expect(isMonotonicStrikeTypePromotion(strikes, 1)).toBe(true);
  });

  test('mixed less/less_or_equal/greater half-lines, single subject → blocked', () => {
    expect(isMonotonicStrikeTypePromotion(['greater', 'greater_or_equal', 'less', 'less_or_equal'], 1)).toBe(true);
  });

  test('cross-subject spread (≥2 subjects) with half-line strike_type → NOT blocked (genuine mutex)', () => {
    // KXNHLSPREAD: "Anaheim by 1.5" vs "Buffalo by 1.5" — half-line strike_type but a
    // real one-of-N team mutex, not a ladder. Exempted by the subjectCount>=2 gate.
    expect(isMonotonicStrikeTypePromotion(['greater', 'greater', 'less', 'less'], 2)).toBe(false);
  });

  test("'between' / 'structured' strike types → NOT blocked (KXBILLSCOUNT between-tiling)", () => {
    // genuine between-range partitions tile the line and stay Σ=1 (the strike_type guard
    // leaves them promotable; the Stage-4 belt independently keeps them exhaustive).
    expect(isMonotonicStrikeTypePromotion(['between', 'between', 'between', 'between'], 1)).toBe(false);
    expect(isMonotonicStrikeTypePromotion(['structured', 'structured', 'structured', 'structured'], 1)).toBe(false);
  });

  test('fewer than 4 strike types → NOT blocked (sample-size floor)', () => {
    expect(isMonotonicStrikeTypePromotion(['greater', 'greater', 'greater'], 1)).toBe(false);
  });

  test('mostly-non-monotonic with one half-line → NOT blocked (below 80%)', () => {
    expect(isMonotonicStrikeTypePromotion(['greater', 'between', 'structured', 'custom'], 1)).toBe(false);
  });

  test('null / empty strike types tolerated (filtered out)', () => {
    expect(isMonotonicStrikeTypePromotion([null, null, undefined as any, ''], 1)).toBe(false);
    // 4 real greater + 2 nulls = 4/4 present, all monotonic → blocked
    expect(isMonotonicStrikeTypePromotion(['greater', 'greater', 'greater', 'greater', null, ''], 1)).toBe(true);
  });
});
