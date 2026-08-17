import { test, expect, describe } from 'bun:test';
import {
  classifyOutcomeAxisByKey,
  classifyMemberGrainByTitle,
  memberOutcomeGrain,
  outcomeGrain,
  isNeutralGrain,
  isThresholdLikeGrain,
  distinctRealGrains,
  grainsHeterogeneous,
  partitionByGrain,
  effectiveRealGrains,
  outcomeGrainFromFacts,
  type OutcomeGrain,
} from './outcome-grain.js';

// Grain classifier.
// Full coverage of classifyOutcomeAxisByKey / outcomeGrain lives in the historical
// guards.test.ts (imports via the guards re-export); these pin the classifier's home
// module + the grain-token edges the partition helpers depend on.

describe('MUST-FIX 1(a): isThresholdLikeGrain (ladder ≠ mutex partition)', () => {
  test('over_under and spread are threshold-like; the mutex-partition grains are not', () => {
    expect(isThresholdLikeGrain('over_under')).toBe(true);
    expect(isThresholdLikeGrain('spread')).toBe(true);
    // numeric_band is a mutex-partition MEMBER (disjoint buckets), NOT a co-resolving
    // ladder rung — it must stay non-threshold-like so bands are never freed as rungs.
    for (const g of ['winner', 'exact_score', 'first_scorer', 'both_teams_score', 'conditional_matchup', 'numeric_band', 'neutral'] as OutcomeGrain[]) {
      expect(isThresholdLikeGrain(g)).toBe(false);
    }
  });

  test('set 67209 slots partition so the over/under + spread rungs isolate into threshold-like groups', () => {
    // A real fusion (real slugs). The finalize feed-A partition frees any
    // group whose every real grain isThresholdLikeGrain; the winner + neutral survive.
    const slugs = [
      'any_other_score', 'argentina_over_0.5', 'argentina_over_1.5', 'argentina_over_2.5',
      'argentina_over_3.5', 'argentina_wins', 'draw', 'spread_jordan_-1.5', 'spread_jordan_-2.5',
      'spread_switzerland_-1.5', 'spread_switzerland_-2.5', 'switzerland_over_0.5',
      'switzerland_over_1.5', 'switzerland_over_2.5', 'switzerland_wins',
    ];
    const isResidual = (s: string) => classifyOutcomeAxisByKey(s, null, null) === 'neutral';
    const groups = partitionByGrain(slugs, (s) => classifyOutcomeAxisByKey(s, null, null), isResidual);
    // Each non-residual group is single-grain; classify it and test the threshold-like predicate.
    const freed = groups.filter((grp) => {
      const grains = distinctRealGrains(grp, (s) => classifyOutcomeAxisByKey(s, null, null), isResidual);
      return grains.size > 0 && [...grains].every(isThresholdLikeGrain);
    });
    const freedSlugs = new Set(freed.flat());
    // over/under rungs (both teams) and all four spreads are freed.
    for (const s of ['argentina_over_0.5', 'argentina_over_3.5', 'switzerland_over_2.5', 'spread_jordan_-1.5', 'spread_switzerland_-2.5']) {
      expect(freedSlugs.has(s)).toBe(true);
    }
    // the winner outcomes are NOT freed (they stay a legit Σ≤1 mutex).
    expect(freedSlugs.has('argentina_wins')).toBe(false);
    expect(freedSlugs.has('switzerland_wins')).toBe(false);
  });
});

describe('classifyOutcomeAxisByKey', () => {
  test('bare named subject → winner', () => {
    expect(classifyOutcomeAxisByKey('argentina_wins', null, null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('democrat', null, null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('lck', null, null)).toBe('winner');
  });
  test('structured keys → their grain, spread BEFORE exact_score', () => {
    expect(classifyOutcomeAxisByKey('argentina_over_0.5', null, null)).toBe('over_under');
    expect(classifyOutcomeAxisByKey('arg_2_1_che', null, null)).toBe('exact_score');
    expect(classifyOutcomeAxisByKey('argentina_-2.5', null, null)).toBe('spread'); // margin, not "2-5"
    expect(classifyOutcomeAxisByKey('both_teams_to_score', null, null)).toBe('both_teams_score');
    expect(classifyOutcomeAxisByKey('republican_defeats_janet_mills', null, null)).toBe('conditional_matchup');
  });
  test('neutral complement tokens → neutral (draw_0_0 stays exact_score)', () => {
    expect(classifyOutcomeAxisByKey('draw', null, null)).toBe('neutral');
    expect(classifyOutcomeAxisByKey('any_other_score', null, null)).toBe('neutral');
    expect(classifyOutcomeAxisByKey('draw_0_0', null, null)).toBe('exact_score');
    expect(isNeutralGrain('neutral')).toBe(true);
    expect(isNeutralGrain('winner')).toBe(false);
  });
  test('feed-B numeric outcome_id (bare market_id) → winner (backstop stays inert)', () => {
    for (const id of ['16713', '5738', '99999', '1897']) {
      expect(classifyOutcomeAxisByKey(id, null, null)).toBe('winner');
    }
  });
  test('outcomeGrain: event_kind upgrades an ambiguous key only (upgrade-only)', () => {
    expect(outcomeGrain('argentina', null, null, ['exact_score'])).toBe('exact_score');
    expect(outcomeGrain('argentina_over_0.5', null, null, ['match_winner'])).toBe('over_under'); // structured key wins
    expect(outcomeGrain('argentina', null, null, [null, undefined])).toBe('winner');
  });
  test('first-scorer verb idioms (2026-07-29); the ambiguous `<x>_first` SUFFIX is NOT one', () => {
    expect(classifyOutcomeAxisByKey('fk_jablonec_scores_first', null, null)).toBe('first_scorer');
    expect(classifyOutcomeAxisByKey('first_blood_g1', null, null)).toBe('first_scorer');
    expect(classifyOutcomeAxisByKey('opening_goal_home', null, null)).toBe('first_scorer');
    // "score_first_half" is a SCOPE qualifier, and BTTS is matched first.
    expect(classifyOutcomeAxisByKey('both_teams_score_first_half', null, null)).toBe('both_teams_score');
    expect(classifyOutcomeAxisByKey('both_teams_score', null, null)).toBe('both_teams_score');
    // The suffix is ambiguous with proper nouns in KEY space (live election
    // categoricals) → left at the 'winner' default on purpose.
    expect(classifyOutcomeAxisByKey('nz_first', null, null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('latvia_first', null, null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('fc_sion_first', null, null)).toBe('winner');
  });
  test('feed-A subject/label sharpen an ambiguous key (SE 3644 exact-score grid)', () => {
    // keys with no ADJACENT digit pair read 'winner'; the label carries the scoreline.
    expect(classifyOutcomeAxisByKey('avai_0_america_1', null, null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('avai_0_america_1', 'Avaí FC 0 - 1 América FC', null)).toBe('exact_score');
    expect(classifyOutcomeAxisByKey('du_plessis_ko_tko', 'Du Plessis to win by KO/TKO', null)).toBe('spread');
  });
});

// MEMBER grain — the question-node BINDING key
describe('classifyMemberGrainByTitle / memberOutcomeGrain', () => {
  test('the live first-scorer ⊕ match-winner fusion is separated', () => {
    // Two unshaped first-scorer legs + one shaped Limitless match-winner leg,
    // all under ONE outcome_id.
    expect(memberOutcomeGrain('Will FC Sion record the first goal of the game?', null)).toBe('first_scorer');
    expect(memberOutcomeGrain('FC Sion to score first vs. FK BATE Barysaŭ?', null)).toBe('first_scorer');
    expect(memberOutcomeGrain('UECL, FC Sion vs Bate Borisov: FC Sion', 'match_winner')).toBe('winner');
    // The winner leg declares its grain in the TITLE.
    expect(memberOutcomeGrain('KF Drita vs Kauno Winner?', null)).toBe('winner');
    expect(memberOutcomeGrain('FC Drita to score first vs. FK Kauno Žalgiris?', null)).toBe('first_scorer');
  });
  test('the COMPLEMENT market abstains, so no-goal ≡ neither-scores-first survives', () => {
    expect(classifyMemberGrainByTitle('Will no goal be scored?')).toBeNull();
    expect(classifyMemberGrainByTitle('Tigres FC vs. Itagui Leones FC: Neither team to score first?')).toBeNull();
    expect(classifyMemberGrainByTitle('Exact Score: Any Other Score?')).toBeNull();
  });
  test('ABSTAINS on a title with no unambiguous idiom (never a default)', () => {
    expect(classifyMemberGrainByTitle('UECL, Ballkani vs Bohemians: Ballkani')).toBeNull();
    expect(classifyMemberGrainByTitle('Will BTC be above $89,000 on July 30?')).toBeNull();
    expect(classifyMemberGrainByTitle(null)).toBeNull();
    expect(classifyMemberGrainByTitle('   ')).toBeNull();
  });
  test('ordering: exact_score before winner, spread before over_under, BTTS before first_scorer', () => {
    // Kalshi halftime scorelines say "wins d-d" — a scoreline, not a moneyline.
    expect(classifyMemberGrainByTitle('Will the 1st half score be Belgium wins 1-0?')).toBe('exact_score');
    expect(classifyMemberGrainByTitle('Will the 1st half score be Draw 0-0?')).toBe('exact_score');
    expect(classifyMemberGrainByTitle('Spain vs. Belgium - Exact Score: ESP 0 - 1 BEL')).toBe('exact_score');
    // the MLB run line, both spellings — one set, one grain.
    expect(classifyMemberGrainByTitle('Tampa Bay wins first 5 innings by over 1.5 runs?')).toBe('spread');
    expect(classifyMemberGrainByTitle('1st 5 Innings Spread: Tampa Bay Rays (-1.5)')).toBe('spread');
    // the UFC METHOD markets are NOT a margin: "by KO" has no numeric margin.
    expect(classifyMemberGrainByTitle('Will Valter Walker win by KO or TKO?')).not.toBe('spread');
    expect(classifyMemberGrainByTitle('Both Teams to Score in the First Half?')).toBe('both_teams_score');
    // "A defeats B, with B as the nominee" is NOT "A wins".
    expect(classifyMemberGrainByTitle('Will JD Vance defeat Gavin Newsom in the 2028 presidential election?')).toBe('conditional_matchup');
    expect(classifyMemberGrainByTitle('Will JD Vance win the 2028 US Presidential Election?')).toBe('winner');
  });
  test('event_kind is the SECONDARY signal — only when the title abstains', () => {
    expect(memberOutcomeGrain('Some untagged listing', 'match_winner')).toBe('winner');
    expect(memberOutcomeGrain('Some untagged listing', 'exact_score')).toBe('exact_score');
    expect(memberOutcomeGrain('Some untagged listing', null)).toBeNull();
    expect(memberOutcomeGrain('Some untagged listing', 'weather_reading')).toBeNull();
    // a decisive title is never downgraded by a coarse kind.
    expect(memberOutcomeGrain('Bohemian FC to score first vs. FC Ballkani?', 'match_winner')).toBe('first_scorer');
  });
});

// Belt P: numeric_band grain
describe('classifyOutcomeAxisByKey: numeric_band', () => {
  test('magnitude/count bucket keys → numeric_band', () => {
    for (const k of ['seats_190_194', '250_280b', 'lt_1t', 'seats_230+', 'seats_below_190', '400b_plus']) {
      expect(classifyOutcomeAxisByKey(k, null, null)).toBe('numeric_band');
    }
  });
  test('band is tested AFTER spread/over_under and BEFORE exact_score', () => {
    expect(classifyOutcomeAxisByKey('over_2.5', null, null)).toBe('over_under'); // OU wins
    expect(classifyOutcomeAxisByKey('2_1', null, null)).toBe('exact_score');     // bare pair refused by band
    expect(classifyOutcomeAxisByKey('0_0', null, null)).toBe('exact_score');
    // a bare-prefix margin pair ('Republicans win by 0-49 seats') is NOT a band — its
    // 1-2-digit pair is refused, so it stays off the numeric_band path (Belt V excludes
    // the exact_score grain it lands on, so it never gets a value-axis interval).
    expect(classifyOutcomeAxisByKey('rep_by_0_49', null, null)).not.toBe('numeric_band');
  });
  test('bare names / neutral / party keys are unaffected', () => {
    expect(classifyOutcomeAxisByKey('democratic_party', null, null)).toBe('winner');
    expect(classifyOutcomeAxisByKey('other', null, null)).toBe('neutral');
    expect(classifyOutcomeAxisByKey('trump_2024', null, null)).toBe('winner'); // single value, not a band
  });
});

// Fixture ("Which party will win the House in 2026?")
// A coarse 3-way winner partition ⊕ a fine 11-way seat-bin partition folded into one
// Σ≤1 mutex: every world lights exactly one slot from EACH → the mutex is false on
// every cross pair. Belt P splits the two partitions apart by grain.
describe('Belt P — set 659 party ⊕ seat-bin fold', () => {
  const SEATS = [
    'seats_below_190', 'seats_190_194', 'seats_195_199', 'seats_200_204', 'seats_205_209',
    'seats_210_214', 'seats_215_219', 'seats_220_224', 'seats_225_229', 'seats_230+',
  ];
  const set659: GSlot[] = [
    s('democratic_party'), s('republican_party'),
    ...SEATS.map((k) => s(k)),
    s('other', true),
  ];

  test('the fused fold spans winner + numeric_band grains → heterogeneous', () => {
    expect([...distinctRealGrains(set659, gk, gr)].sort()).toEqual(['numeric_band', 'winner']);
    expect(grainsHeterogeneous(set659, gk, gr)).toBe(true);
  });

  test('partitionByGrain: {winner×2} ⊕ {numeric_band×10} ⊕ neutral(other) freed', () => {
    const groups = partitionByGrain(set659, gk, gr);
    const winnerGroup = groups.find((g) => g.some((x) => x.outcome_id === 'democratic_party'))!;
    expect(winnerGroup.map((x) => x.outcome_id).sort()).toEqual(['democratic_party', 'republican_party']);
    const bandGroup = groups.find((g) => g.some((x) => x.outcome_id === 'seats_190_194'))!;
    expect(bandGroup.length).toBe(10);
    expect(bandGroup.every((x) => gk(x) === 'numeric_band')).toBe(true);
    const neutralGroup = groups.find((g) => g.some((x) => x.outcome_id === 'other'))!;
    expect(neutralGroup.map((x) => x.outcome_id)).toEqual(['other']);
    // all slots preserved (subtractive re-partition)
    expect(groups.reduce((n, g) => n + g.length, 0)).toBe(set659.length);
  });
});

// numeric_band LONE-BUCKET guard.
// A single count/cap axis whose exact buckets tokenize as bare integers/`_to_` ranges
// (→ 'winner') while ONLY the open overflow bucket parses as numeric_band must NOT be
// mistaken for a winner⊕numeric_band FUSION. The genuine cross-EVENT fusion
// (≥2 slots per side) is untouched and still splits.
describe('F12 — numeric_band lone-bucket collapse', () => {
  test('effectiveRealGrains: {winner:n, numeric_band:1} collapses to the majority', () => {
    expect([...effectiveRealGrains(new Map([['winner', 4], ['numeric_band', 1]]))]).toEqual(['winner']);
    expect([...effectiveRealGrains(new Map([['winner', 1], ['numeric_band', 6]]))]).toEqual(['numeric_band']);
    // both sides ≥2 → NOT collapsed (a genuine fusion)
    expect([...effectiveRealGrains(new Map([['winner', 2], ['numeric_band', 2]])).values()].sort())
      .toEqual(['numeric_band', 'winner']);
    // scoped to the {winner, numeric_band} PAIR only — never touches other splits
    expect(effectiveRealGrains(new Map([['winner', 3], ['exact_score', 1]])).size).toBe(2);
    expect(effectiveRealGrains(new Map([['winner', 1], ['spread', 1]])).size).toBe(2);
  });

  test('se2320 "how many dissent" {0,1,2,3}⊕{4+} — NOT heterogeneous, NOT split', () => {
    const dissents: GSlot[] = [s('0'), s('1'), s('2'), s('3'), s('4+')];
    expect(gk(s('4+'))).toBe('numeric_band'); // the lone overflow bucket
    expect(gk(s('0'))).toBe('winner');          // bare counts fall to the winner default
    expect(grainsHeterogeneous(dissents, gk, gr)).toBe(false);
    expect(partitionByGrain(dissents, gk, gr).length).toBe(1); // one axis, kept whole
  });

  test('se2782 "Senate primaries lost" {0,1,2,3,4}⊕{4plus} — NOT split', () => {
    const lost: GSlot[] = [s('0'), s('1'), s('2'), s('3'), s('4'), s('4plus')];
    expect(grainsHeterogeneous(lost, gk, gr)).toBe(false);
    expect(partitionByGrain(lost, gk, gr).length).toBe(1);
  });

  test('symmetric: lone winner-tokenized bucket among ≥2 bands — NOT split', () => {
    // 'no_ipo' falls to the winner default; the priced brackets are bands.
    const cap: GSlot[] = [s('no_ipo'), s('250_280b'), s('400b_plus'), s('lt_1t')];
    expect(gk(s('no_ipo'))).toBe('winner');
    expect(grainsHeterogeneous(cap, gk, gr)).toBe(false);
    expect(partitionByGrain(cap, gk, gr).length).toBe(1);
  });

  test('genuine fusion se2108 (party ⊕ ≥2 seat bands) STILL splits — guard is precise', () => {
    const set2108: GSlot[] = [
      s('democratic_party'), s('republican_party'),
      s('seats_190_194'), s('seats_195_199'), s('seats_200_204'),
      s('other', true),
    ];
    expect(grainsHeterogeneous(set2108, gk, gr)).toBe(true);
    const groups = partitionByGrain(set2108, gk, gr);
    const winnerGroup = groups.find((g) => g.some((x) => x.outcome_id === 'democratic_party'))!;
    expect(winnerGroup.map((x) => x.outcome_id).sort()).toEqual(['democratic_party', 'republican_party']);
    const bandGroup = groups.find((g) => g.some((x) => x.outcome_id === 'seats_190_194'))!;
    expect(bandGroup.every((x) => gk(x) === 'numeric_band')).toBe(true);
    expect(bandGroup.length).toBe(3);
  });
});

// A fused categorical fixture: match-winner + per-team goals ladders + spreads
// + exact scores + BTTS + the neutral complement. All can co-occur in one
// real result, so a single mutex across them is unsound.
type GSlot = { outcome_id: string; is_residual: boolean };
const gk = (s: GSlot): OutcomeGrain => classifyOutcomeAxisByKey(s.outcome_id, null, null);
const gr = (s: GSlot): boolean => s.is_residual;
const s = (outcome_id: string, is_residual = false): GSlot => ({ outcome_id, is_residual });

const SE2669: GSlot[] = [
  s('argentina_wins'), s('switzerland_wins'), s('draw'),          // winner (+ neutral draw)
  s('argentina_over_0.5'), s('argentina_over_1.5'),               // over_under
  s('argentina_-1.5'), s('argentina_win_by_more_than_2.5'),       // spread
  s('arg_2_1_che'), s('exact_1-0'),                               // exact_score
  s('both_teams_to_score'),                                        // both_teams_score
  s('any_other_score', true),                                     // residual/neutral
];

describe('SE 2669 (set 67209 $667k fake) — grain partition', () => {
  test('spans 5 real grains → heterogeneous', () => {
    const grains = distinctRealGrains(SE2669, gk, gr);
    expect([...grains].sort()).toEqual(['both_teams_score', 'exact_score', 'over_under', 'spread', 'winner']);
    expect(grainsHeterogeneous(SE2669, gk, gr)).toBe(true);
  });

  test('partitionByGrain splits into per-grain groups; NO group mixes grains', () => {
    const groups = partitionByGrain(SE2669, gk, gr);
    expect(groups.length).toBeGreaterThan(1);
    // every group is single-grain over its non-residual, non-neutral slots
    for (const g of groups) {
      const realGrains = distinctRealGrains(g, gk, gr);
      expect(realGrains.size).toBeLessThanOrEqual(1);
    }
    // all slots preserved (subtractive re-partition — nothing dropped, nothing merged)
    expect(groups.reduce((n, g) => n + g.length, 0)).toBe(SE2669.length);
    // the winner group holds the two decisive outcomes; the neutral 'draw' + residual
    // 'any_other_score' land in their OWN neutral bucket (freed downstream, not fused
    // into a foreign grain's mutex).
    const winnerGroup = groups.find((g) => g.some((x) => x.outcome_id === 'argentina_wins'))!;
    const winnerIds = winnerGroup.map((x) => x.outcome_id).sort();
    expect(winnerIds).toEqual(['argentina_wins', 'switzerland_wins']);
    const neutralGroup = groups.find((g) => g.some((x) => x.outcome_id === 'draw'))!;
    expect(neutralGroup.map((x) => x.outcome_id).sort()).toEqual(['any_other_score', 'draw']);
  });

  test('first-seen order: the FIRST grain keeps the unsuffixed slot ordering', () => {
    const groups = partitionByGrain(SE2669, gk, gr);
    // 'argentina_wins' is the first slot → winner group is first (subKey '' downstream)
    expect(groups[0][0].outcome_id).toBe('argentina_wins');
  });
});

// Party + candidate + conditional fixture
test('SE 2069 (Maine, set 1094): winner + conditional_matchup → split', () => {
  const se2069: GSlot[] = [
    s('democrat'), s('republican'), s('graham_platner_wins'), s('janet_mills_wins'),
    s('republican_defeats_graham_platner'), s('republican_defeats_janet_mills'),
    s('other', true),
  ];
  expect([...distinctRealGrains(se2069, gk, gr)].sort()).toEqual(['conditional_matchup', 'winner']);
  const groups = partitionByGrain(se2069, gk, gr);
  // winner + conditional_matchup + the neutral bucket for the 'other' residual
  expect(groups.length).toBe(3);
  for (const g of groups) expect(distinctRealGrains(g, gk, gr).size).toBeLessThanOrEqual(1);
  // the two REAL-grain groups carry the party/candidate winners and the `defeats` conditionals
  const winnerGroup = groups.find((g) => g.some((x) => x.outcome_id === 'democrat'))!;
  expect(winnerGroup.map((x) => x.outcome_id).sort()).toEqual(['democrat', 'graham_platner_wins', 'janet_mills_wins', 'republican']);
  const condGroup = groups.find((g) => g.some((x) => x.outcome_id.includes('defeats')))!;
  expect(condGroup.every((x) => gk(x) === 'conditional_matchup')).toBe(true);
});

// Single-grain sets are UNTOUCHED (no recall loss)
describe('single-grain categorical → ONE group, unpartitioned', () => {
  test('pure election winner set (democrat/republican/other) unchanged', () => {
    const election: GSlot[] = [s('democrat_wins'), s('republican_wins'), s('other', true)];
    expect(grainsHeterogeneous(election, gk, gr)).toBe(false);
    const groups = partitionByGrain(election, gk, gr);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(3);
  });
  test('pure 1X2 with draw complement unchanged (draw excluded from grain count)', () => {
    const x12: GSlot[] = [s('argentina_wins'), s('switzerland_wins'), s('draw')];
    expect(grainsHeterogeneous(x12, gk, gr)).toBe(false); // {winner}; draw is neutral
    expect(partitionByGrain(x12, gk, gr).length).toBe(1);
  });
  test('pure exact-score grid with residual unchanged', () => {
    const grid: GSlot[] = [s('exact_0-0'), s('exact_1-0'), s('exact_2-1'), s('any_other_score', true)];
    expect(grainsHeterogeneous(grid, gk, gr)).toBe(false);
    expect(partitionByGrain(grid, gk, gr).length).toBe(1);
  });
  test('SE 2777 (MSI regions+teams, set 67283) is all-winner → NOT grain-split (mechanism-4 territory)', () => {
    const msi: GSlot[] = [s('t1'), s('lck'), s('lpl'), s('g2_esports'), s('other_region', true)];
    expect(grainsHeterogeneous(msi, gk, gr)).toBe(false);
    expect(partitionByGrain(msi, gk, gr).length).toBe(1);
  });
});

// The value/label-gated grain upgrade. Each test pins either a co-slotting
// case the upgrade must catch, or a guard that keeps it from false-splitting
// a sound Sigma=1 fold.

describe('outcomeGrainFromFacts — structured upgrades (P4)', () => {
  test('a structured KEY grain always wins and is never downgraded', () => {
    expect(outcomeGrainFromFacts({ outcome_id: 'argentina_over_0.5' })).toBe('over_under');
    // even with a contradicting kind + a scoreline-shaped value pair
    expect(outcomeGrainFromFacts({
      outcome_id: 'argentina_over_0.5', event_kinds: ['match_winner'], value_primary: 2, value_secondary: 1,
    })).toBe('over_under');
    // 'neutral' (the complement) is final too
    expect(outcomeGrainFromFacts({ outcome_id: 'draw', event_kinds: ['exact_score'] })).toBe('neutral');
  });

  test('event_kind upgrades an ambiguous bare key (the historical outcomeGrain arm)', () => {
    expect(outcomeGrainFromFacts({ outcome_id: 'argentina', event_kinds: ['exact_score'] })).toBe('exact_score');
    expect(outcomeGrainFromFacts({ outcome_id: 'argentina', event_kinds: [null, 'match_spread'] })).toBe('spread');
    expect(outcomeGrainFromFacts({ outcome_id: 'argentina', event_kinds: ['match_winner'] })).toBe('winner');
  });

  test('VALUE-GATED: a NULL-kind slot with a scoreline pair is exact_score (stripped-slug class)', () => {
    expect(outcomeGrainFromFacts({
      outcome_id: 'hibernian', event_kinds: [null], value_primary: 2, value_secondary: 1,
    })).toBe('exact_score');
    // pg may hand numerics back as text
    expect(outcomeGrainFromFacts({ outcome_id: 'hibernian', value_primary: '0', value_secondary: '0' })).toBe('exact_score');
  });

  test('the value arm never eats an INTERVAL: big numbers, half-lines, one-sided values', () => {
    // a 45..57 seat bucket / a 1.5-goal half-line / a lone bound are not scorelines
    expect(outcomeGrainFromFacts({ outcome_id: 'seats', value_primary: 45, value_secondary: 57 })).toBe('winner');
    expect(outcomeGrainFromFacts({ outcome_id: 'x', value_primary: 1.5, value_secondary: 2.5 })).toBe('winner');
    expect(outcomeGrainFromFacts({ outcome_id: 'x', value_primary: 2, value_secondary: null })).toBe('winner');
    expect(outcomeGrainFromFacts({ outcome_id: 'x', value_primary: -1, value_secondary: 2 })).toBe('winner');
  });

  test('a KNOWN non-mapping kind BLOCKS the value arm (the platform said it is not a score)', () => {
    // "0 to 3 rate cuts" style bucket: kind known, so the value pair must not upgrade.
    expect(outcomeGrainFromFacts({
      outcome_id: 'cuts', event_kinds: ['count_threshold'], value_primary: 0, value_secondary: 3,
    })).toBe('winner');
  });

  test('PHRASE upgrade from the bare label: score-first (Hibernian) / BTTS / defeats', () => {
    expect(outcomeGrainFromFacts({ outcome_id: 'hibernian', label: 'Hibernian to score first' })).toBe('first_scorer');
    expect(outcomeGrainFromFacts({ outcome_id: 'x', subject: 'Both Teams to Score' })).toBe('both_teams_score');
    expect(outcomeGrainFromFacts({ outcome_id: 'x', label: 'Republican defeats Janet Mills' })).toBe('conditional_matchup');
  });

  test('the score-first SLUG form is recognised key-only (the live Hibernian key)', () => {
    expect(classifyOutcomeAxisByKey('hibernian_scores_first', null, null)).toBe('first_scorer');
    expect(classifyOutcomeAxisByKey('malmo_score_first', null, null)).toBe('first_scorer');
    // "score first HALF" is a period-scope total, not a first-scorer market
    expect(classifyOutcomeAxisByKey('team_score_first_half', null, null)).toBe('winner');
  });

  test('NUMERIC families never upgrade from free-ish label text (the feed-B title trap)', () => {
    // a date or a weather bucket in a label must NOT read as exact_score / band —
    // those false-splits are why the phrase set is restricted to phrase-keyed grains.
    expect(outcomeGrainFromFacts({ outcome_id: 'rapid_vienna', label: 'Win on 2026-05-17' })).toBe('winner');
    expect(outcomeGrainFromFacts({ outcome_id: 'phoenix', label: '81-82°F' })).toBe('winner');
    expect(outcomeGrainFromFacts({ outcome_id: 'villa', label: 'Villa (-1.5)' })).toBe('winner');
  });

  test('the Hibernian fold now SPLITS: score-first leaves the 1X2 partition', () => {
    type S = { id: string; g: OutcomeGrain; r: boolean };
    const slots: S[] = [
      { id: 'hibernian', g: outcomeGrainFromFacts({ outcome_id: 'hibernian', event_kinds: ['match_winner'] }), r: false },
      { id: 'malmo', g: outcomeGrainFromFacts({ outcome_id: 'malmo', event_kinds: ['match_winner'] }), r: false },
      { id: 'draw', g: outcomeGrainFromFacts({ outcome_id: 'draw' }), r: true },
      { id: 'first', g: outcomeGrainFromFacts({ outcome_id: 'hibernian', label: 'Hibernian scores first' }), r: false },
    ];
    expect(grainsHeterogeneous(slots, (s) => s.g, (s) => s.r)).toBe(true);
    expect(partitionByGrain(slots, (s) => s.g, (s) => s.r).length).toBeGreaterThan(1);
  });
});
