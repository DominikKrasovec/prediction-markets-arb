import { describe, test, expect } from 'bun:test';
import { expandLabelIdiom, idiomsAgree, type IdiomCtx } from './label-expansion.js';

// The guards feed canonicalOutcomeKey(s,null) output — already lowercase, foldAscii'd,
// [^a-z0-9]->space. All fixtures below are in that folded form.

const soccer: IdiomCtx = { eventKind: 'match_winner', sport: 'soccer', resolutionScope: 'regulation' };
const soccerHT: IdiomCtx = { eventKind: 'halftime_leader', sport: 'soccer', resolutionScope: 'unspecified' };
const soccerNoScope: IdiomCtx = { eventKind: 'both_teams_score', sport: 'soccer' };

describe('G1 draw/tie idiom bridge', () => {
  test('tie<->draw bridges in a draw-capable soccer fixture (both orderings)', () => {
    expect(idiomsAgree('tie', 'draw', soccer)).toBe(true);
    expect(idiomsAgree('draw', 'tie', soccer)).toBe(true);
    expect(idiomsAgree('tied', 'draw', soccerHT)).toBe(true);
    expect(idiomsAgree('deadlock', 'draw', soccerNoScope)).toBe(true);
  });

  test('CRICKET EXCLUSION: tie != draw in cricket (different settlement outcomes)', () => {
    const cricket: IdiomCtx = { eventKind: 'match_winner', sport: 'cricket', resolutionScope: 'regulation' };
    expect(idiomsAgree('tie', 'draw', cricket)).toBe(false);
    // sport substring match (defensive): 'test cricket' also excluded.
    expect(idiomsAgree('tie', 'draw', { ...cricket, sport: 'Test Cricket' })).toBe(false);
  });

  test('SCOPE GATE: at incl_overtime there is no tie slot -> no bridge', () => {
    expect(idiomsAgree('tie', 'draw', { ...soccer, resolutionScope: 'incl_overtime' })).toBe(false);
  });

  test('KIND GATE: award_winner "co-winners tie" is a different semantic -> no bridge', () => {
    expect(idiomsAgree('tie', 'draw', { ...soccer, eventKind: 'award_winner' })).toBe(false);
    // unknown kind -> no bridge (kind must be provably a draw-axis kind).
    expect(idiomsAgree('tie', 'draw', { sport: 'soccer' })).toBe(false);
    expect(idiomsAgree('tie', 'draw', undefined)).toBe(false);
  });

  test('home-team-as-draw is NOT a draw token (Limitless convention, excluded)', () => {
    // "england"/"spain" encode the draw slot on Limitless — England winning != a draw.
    expect(idiomsAgree('england', 'draw', soccer)).toBe(false);
    expect(idiomsAgree('spain', 'draw', soccer)).toBe(false);
    expect(idiomsAgree('tottenham hotspur', 'draw', soccer)).toBe(false);
  });

  test('tiebreaker must NOT match (exact token, not substring)', () => {
    expect(idiomsAgree('tiebreaker', 'draw', soccer)).toBe(false);
    expect(idiomsAgree('tie break', 'draw', soccer)).toBe(false);
  });
});

describe('G2 NRFI within-bucket fold + cross-bucket BLOCK', () => {
  test('no_run bucket members bridge each other', () => {
    expect(idiomsAgree('nrfi', 'no run first inning')).toBe(true);
    expect(idiomsAgree('nrfi', 'no run scored in first inning')).toBe(true);
    expect(idiomsAgree('nrfi', 'no run in first inning')).toBe(true);
    expect(idiomsAgree('nrfi', 'no run first inning yes')).toBe(true);
    expect(idiomsAgree('no run first inning', 'no runs scored in first inning')).toBe(true);
  });

  test('run bucket members bridge each other', () => {
    expect(idiomsAgree('yrfi', 'run scored in first inning')).toBe(true);
    expect(idiomsAgree('yrfi', 'will there be a run scored in the first inning')).toBe(true);
  });

  // The single most dangerous entry: cross-bucket = polarity inversion = fake arb.
  test('CROSS-BUCKET BLOCK: no_run != run (nrfi must NOT bridge yrfi / "will there be a run")', () => {
    expect(idiomsAgree('nrfi', 'will there be a run scored in the first inning')).toBe(false);
    expect(idiomsAgree('nrfi', 'run scored in first inning')).toBe(false);
    expect(idiomsAgree('nrfi', 'first inning run yes')).toBe(false);
    expect(idiomsAgree('no run first inning', 'yrfi')).toBe(false);
  });

  test('bare yes/no carry no metric -> identity (polarity owned by the classifier)', () => {
    expect(idiomsAgree('nrfi', 'yes')).toBe(false);
    expect(idiomsAgree('nrfi', 'no')).toBe(false);
  });
});

describe('G3 over/under line-descriptor fold (direction + line preserved)', () => {
  test('two-sided descriptors fold at the SAME line', () => {
    expect(idiomsAgree('o u 2 5', 'total goals over under 2 5')).toBe(true);
    expect(idiomsAgree('o u 2 5', 'over under 2 5')).toBe(true);
    expect(idiomsAgree('o u 2 5', 'over under 2 5 goals')).toBe(true);
    expect(idiomsAgree('o u 2 5 games', 'games total o u 2 5')).toBe(true);
    expect(idiomsAgree('over under 11 5', 'o u 11 5')).toBe(true);
  });

  test('CROSS-LINE BLOCK: different numeric line never folds (strike mismatch)', () => {
    expect(idiomsAgree('o u 2 5', 'total goals over under 3 5')).toBe(false);
    expect(idiomsAgree('o u 2 5', 'o u 3 5')).toBe(false);
  });

  test('DIRECTION BLOCK: over != under != two-sided (complement flip)', () => {
    expect(idiomsAgree('over 2 5', 'under 2 5')).toBe(false);
    expect(idiomsAgree('o u 2 5', 'total goals over 2 5')).toBe(false);   // two-sided vs one-sided over
    expect(idiomsAgree('o u 2 5', 'over 2 5 goals')).toBe(false);
  });

  test('one-sided same direction + same line folds descriptor only', () => {
    expect(idiomsAgree('over 2 5', 'total goals over 2 5')).toBe(true);
    expect(idiomsAgree('under 3 5', 'total goals under 3 5')).toBe(true);
  });

  test('no digit -> not a line -> identity (not an idiom)', () => {
    expect(idiomsAgree('over', 'under')).toBe(false);
    expect(expandLabelIdiom('over under').startsWith('#')).toBe(false);
  });

  test('unit-suffixed pure descriptors fold (goals/runs/rounds)', () => {
    expect(idiomsAgree('o u 8 5', 'total runs over under 8 5')).toBe(true);
    expect(idiomsAgree('o u 0 5 rounds', 'over under 0 5 rounds')).toBe(true);
  });

  // PURE-descriptor gate: an over/under label that CARRIES A SUBJECT must NOT fold
  // (else the expander discards the subject and bridges two different teams).
  test('ENTITY GATE: subject-bearing over/under labels never bridge (fake-arb guard)', () => {
    // two DIFFERENT teams, same line/direction — MUST NOT bridge.
    expect(idiomsAgree('arsenal wins by over 2 5 goals', 'chelsea wins by over 2 5 goals')).toBe(false);
    // truncation-bug class ("los angeles d" could be a different LA team) — MUST NOT bridge.
    expect(idiomsAgree('los angeles d over 6 5 runs scored', 'los angeles dodgers over 6 5 runs scored')).toBe(false);
    // diacritic / KB-alias team pairs (handled upstream by foldAscii / KB, not here).
    expect(idiomsAgree('alaves wins by over 2 5 goals', 'alav s wins by over 2 5 goals')).toBe(false);
    expect(idiomsAgree('newcastle wins by over 2 5 goals', 'newcastle united jets fc wins by over 2 5 goals')).toBe(false);
    // verbose tennis native vs abbreviated subject — an entity token blocks the fold.
    expect(idiomsAgree('tommy paul vs luciano darderi set 1 o u 8 5', 'set 1 games o u 8 5')).toBe(false);
    // even a "same" subject on both sides is left to the plain fold, not the OU idiom.
    expect(expandLabelIdiom('arsenal wins by over 2 5 goals').startsWith('#')).toBe(false);
  });
});

describe('idiomsAgree / expandLabelIdiom contract', () => {
  test('non-idiom strings return identity and never bridge', () => {
    expect(expandLabelIdiom('arsenal', soccer)).toBe('arsenal');
    expect(idiomsAgree('arsenal', 'chelsea', soccer)).toBe(false);
  });
  test('diacritic person-name residue is NOT an idiom (no double-bridge)', () => {
    // These fold-equal upstream via foldAscii; the idiom module must not re-bridge
    // two genuinely-different folded name spellings.
    expect(idiomsAgree('jennifer guti rrez', 'jennifer g tierrez', soccer)).toBe(false);
  });
  test('NULL-tolerant', () => {
    expect(idiomsAgree(null, 'draw', soccer)).toBe(false);
    expect(idiomsAgree('tie', null, soccer)).toBe(false);
    expect(expandLabelIdiom('', soccer)).toBe('');
  });
  test('pure/total: identity when no idiom, ctx-independent for NRFI/OU', () => {
    expect(expandLabelIdiom('nrfi')).toBe(expandLabelIdiom('nrfi', soccer));
    expect(expandLabelIdiom('o u 2 5')).toBe(expandLabelIdiom('o u 2 5', soccer));
  });
});
