/**
 * detectResolutionScope + buildScopeDetectionText — Stage 1h backfill's
 * per-platform extraction, and the negated-inclusion case: Kalshi's "does
 * not include extra time or penalties" phrasing must land REGULATION, not
 * incl_overtime (the inclusion branch's `includ...extra time` sub-pattern
 * matches inside the negation).
 */
import { describe, test, expect } from 'bun:test';
import { detectResolutionScope, buildScopeDetectionText } from './market-normalizer.js';

// Full-game enumeration arm: Kalshi declares the wide basis by enumerating
// the periods that count, with no `includ*` verb in front of the extra-time
// token. Without this arm it falls through to 'unspecified', which disarms
// every scope guard, while its Polymarket twin stamps 'regulation'.
describe('detectResolutionScope — Kalshi full-game enumeration (KXWCAST class)', () => {
  const kxwcast =
    '[kalshi:greater_or_equal floor=2 yes="Dani Olmo: 2+" no="Dani Olmo: 2+"] ' +
    'If Dani Olmo records at least 2 assists during the entire game (regulation, ' +
    'stoppage and any extra time periods) of the Spain vs Belgium professional ' +
    'FIFA World Cup soccer game originally scheduled for Jul 10, 2026, then the ' +
    'market resolves to Yes.';

  test('the live 157-row KXWCAST wording → incl_overtime (was unspecified)', () => {
    expect(detectResolutionScope('Dani Olmo: 2+ assists?', kxwcast)).toBe('incl_overtime');
  });

  test('the comma-and tournament variant → incl_overtime', () => {
    expect(detectResolutionScope('t',
      'across the tournament (including regulation, stoppage, and any extra time periods) ' +
      'of the 2026 Men\'s FIFA World Cup')).toBe('incl_overtime');
  });

  test('its Polymarket twin is UNCHANGED at regulation (the semicolon window)', () => {
    expect(detectResolutionScope('Dani Olmo: 2+ assists',
      'This market resolves considering only the result at the end of 90 minutes of ' +
      'regulation plus stoppage time; extra time and penalty shoot-outs are excluded.',
    )).toBe('regulation');
  });

  test('the ADVANCE-METHOD ladder is NOT stamped wide (no stoppage token between)', () => {
    // All three legs share ONE rules text; stamping it incl_overtime would put the
    // WRONG direction on the "win in Regulation Time" leg.
    const ladder =
      'If either team advances via a penalty shootout following the completion of ' +
      'regulation time and extra time, then the market resolves to Yes. Regulation ' +
      'Time: resolves to Yes if either team advances via regulation time, which ' +
      'includes the standard 90 minutes of play plus all stoppage/injury time.';
    expect(detectResolutionScope('Will Argentina win in Regulation Time?', ladder)).not.toBe('incl_overtime');
  });

  test('esports "regulation rounds and overtime rounds" is NOT stamped wide', () => {
    // Esports is deliberately scope-free downstream
    // (NO_OVERTIME_CONCEPT_SPORTS), so the arm must not reach it.
    expect(detectResolutionScope('Map 1: Odd/Even Total Kills?',
      'includes all kills recorded during the match across all rounds, including ' +
      'kills during regulation rounds and overtime rounds if applicable.',
    )).not.toBe('incl_overtime');
  });

  test('MIXED text still refuses: enumeration + shootout exclusion → unspecified', () => {
    // The arm is an alternative of inclusionRx, so it is tested against the
    // exclusion-STRIPPED residual and disagreeing components never guess a side.
    expect(detectResolutionScope('t',
      'Goals scored during regulation time, stoppage time, and extra time are included. ' +
      'Goals scored during penalty shootouts do not count toward this market.',
    )).toBe('unspecified');
  });
});

describe('detectResolutionScope — negated inclusion (Kalshi soccer convention)', () => {
  const kalshiRules =
    'If Fluminense wins the Fluminense vs Sao Paulo professional Brasileiro Serie A soccer game ' +
    'originally scheduled for May 16, 2026 after 90 minutes plus stoppage time ' +
    '(does not include extra time or penalties), then the market resolves to Yes.';

  test('the live 1,611-row kalshi phrasing → regulation (NOT incl_overtime)', () => {
    expect(detectResolutionScope('Fluminense vs Sao Paulo Winner?', kalshiRules)).toBe('regulation');
  });

  test('other negation spellings → regulation', () => {
    expect(detectResolutionScope('t', 'the result will not include overtime')).toBe('regulation');
    expect(detectResolutionScope('t', "doesn't include any overtime periods")).toBe('regulation');
    expect(detectResolutionScope('t', 'not including penalties')).toBe('regulation');
  });

  test('POSITIVE inclusion still wins (Polymarket convention untouched)', () => {
    expect(
      detectResolutionScope('t', 'based on the final score including any overtime periods and shootouts'),
    ).toBe('incl_overtime');
    expect(detectResolutionScope('t', 'includes extra time and penalties')).toBe('incl_overtime');
  });

  test('existing branches unchanged: aggregate / knockout / regulation / unspecified', () => {
    expect(detectResolutionScope('t', 'winner on aggregate over two legs')).toBe('aggregate');
    expect(detectResolutionScope('Will X advance to the semifinal?', '')).toBe('incl_overtime');
    expect(detectResolutionScope('t', 'at the end of regulation')).toBe('regulation');
    expect(detectResolutionScope('t', 'settled within 90 minutes of play')).toBe('regulation');
    expect(detectResolutionScope('Will it rain tomorrow?', 'Resolves per NWS data.')).toBe('unspecified');
  });

  test('never returns null/undefined — the Stage-1h idempotency invariant', () => {
    expect(detectResolutionScope('', '')).toBe('unspecified');
  });
});

describe('detectResolutionScope — passive exclusion (audit-round-2 #1)', () => {
  // The verbatim Polymarket exact-score boilerplate: true basis =
  // regulation. The bare `extra[ -]?time and penalt` inclusion alternative
  // must not fire on it.
  const pmExactScoreBoilerplate =
    'This market will resolve to "Yes" if the final score of the match is exactly ' +
    'the listed score, considering only the result at the end of 90 minutes of ' +
    'regulation plus stoppage time; extra time and penalty shoot-outs are excluded. ' +
    'Otherwise, this market will resolve to "No".';

  test('the live 16,777-row PM exact-score boilerplate → regulation (NOT incl_overtime)', () => {
    expect(detectResolutionScope('Exact Score: Red Star FC 0 - 0 Rodez Aveyron Football?', pmExactScoreBoilerplate))
      .toBe('regulation');
  });

  test('passive-exclusion phrasing matrix → regulation', () => {
    expect(detectResolutionScope('t', 'extra time and penalty shoot-outs are excluded')).toBe('regulation');
    expect(detectResolutionScope('t', 'overtime is excluded')).toBe('regulation');
    expect(detectResolutionScope('t', 'extra time will be excluded')).toBe('regulation');
    expect(detectResolutionScope('t', 'penalties are not counted')).toBe('regulation');
    expect(detectResolutionScope('t', 'extra time will not be counted')).toBe('regulation');
    expect(detectResolutionScope('t', 'goals scored in extra time do not count')).toBe('regulation');
    expect(detectResolutionScope('t', 'penalty shoot-outs do not count toward the result')).toBe('regulation');
    expect(detectResolutionScope('t', 'overtime is excluded from consideration')).toBe('regulation');
    expect(detectResolutionScope('t', 'extra time is not considered')).toBe('regulation');
    expect(detectResolutionScope('t', 'shootouts are not included in the final score')).toBe('regulation');
  });

  test('clause window: exclusion verb in a NEIGHBOURING sentence does not flip inclusion', () => {
    // "overtime" and "excluded" live in different sentences — the [^.!?;]{0,60}
    // window must not bridge them; the genuine inclusion still wins.
    expect(detectResolutionScope('t',
      'The final score includes any overtime periods. Postponed matches are excluded from this market.',
    )).toBe('incl_overtime');
  });

  test('genuine "extra time counts / included" texts still incl_overtime (regression gate)', () => {
    expect(detectResolutionScope('t', 'based on the final score including any overtime periods and shootouts'))
      .toBe('incl_overtime');
    expect(detectResolutionScope('t', 'the result includes extra time and penalties')).toBe('incl_overtime');
    expect(detectResolutionScope('t', 'resolves on the final score after extra time and penalties if necessary'))
      .toBe('incl_overtime');
    expect(detectResolutionScope('t', 'including penalty shootouts')).toBe('incl_overtime');
  });

  test('kalshi negated (active-voice) rows still regulation', () => {
    expect(detectResolutionScope('A vs B Winner?',
      'after 90 minutes plus stoppage time (does not include extra time or penalties), then the market resolves to Yes',
    )).toBe('regulation');
  });

  test('MIXED inclusion+exclusion phrasings → unspecified (never guess)', () => {
    expect(detectResolutionScope('t', 'including extra time but not penalties')).toBe('unspecified');
    expect(detectResolutionScope('t', 'includes overtime, excluding penalty shootouts')).toBe('unspecified');
    expect(detectResolutionScope('t', 'including extra time; penalty shoot-outs are excluded')).toBe('unspecified');
  });

  // Counts-voice inclusion gap: "extra time counts but penalties are
  // excluded" must not stamp regulation (extra time genuinely counts).
  // Counts-voice is inclusion evidence, checked on the pre-span-removal
  // text in the mixed arm.
  test('MIXED counts-voice inclusion + exclusion → unspecified (was regulation, wrong direction)', () => {
    expect(detectResolutionScope('t', 'extra time counts but penalties are excluded')).toBe('unspecified');
    expect(detectResolutionScope('t', 'overtime counts but penalty shoot-outs are excluded')).toBe('unspecified');
    expect(detectResolutionScope('t', 'extra time is counted; penalty shoot-outs are excluded')).toBe('unspecified');
    expect(detectResolutionScope('t', 'goals in extra time count toward the result but shootouts are excluded'))
      .toBe('unspecified');
  });

  test('PURE counts-voice inclusion → incl_overtime', () => {
    expect(detectResolutionScope('t', 'extra time counts')).toBe('incl_overtime');
    expect(detectResolutionScope('t', 'overtime is counted')).toBe('incl_overtime');
    expect(detectResolutionScope('t', 'penalties will be counted')).toBe('incl_overtime');
    expect(detectResolutionScope('t', 'goals scored in extra time count toward the final score')).toBe('incl_overtime');
  });

  test('NEGATED counts-voice stays exclusion (regulation) — the tempered window never crosses a negator', () => {
    expect(detectResolutionScope('t', 'extra time does not count')).toBe('regulation');
    expect(detectResolutionScope('t', 'extra time will not be counted')).toBe('regulation');
    expect(detectResolutionScope('t', 'penalties are not counted')).toBe('regulation');
    // 'never count' is exclusion voice outside passiveExclusionRx's verb
    // set, so it carries no exclusion evidence, and the tempered window
    // keeps it out of inclusion too: 'unspecified', never incl_overtime.
    expect(detectResolutionScope('t', 'goals scored in extra time never count toward the result')).toBe('unspecified');
  });

  test('CONTRACTION / lexical negation never reads as inclusion (closing-audit regression)', () => {
    // "doesn't"/"won't" carry the negation in the n't suffix — the bare
    // tokens not/never/no never appear. None of these may ever return
    // incl_overtime; 'unspecified' (no exclusion-voice match) is the safe
    // landing.
    expect(detectResolutionScope('t', "extra time doesn't count toward the result")).not.toBe('incl_overtime');
    expect(detectResolutionScope('t', "overtime won't count towards the final score")).not.toBe('incl_overtime');
    expect(detectResolutionScope('t', 'goals in extra time fail to count toward the total')).not.toBe('incl_overtime');
    expect(detectResolutionScope('t', 'penalties cannot be counted')).not.toBe('incl_overtime');
    // curly-apostrophe glyph variant of the contraction
    expect(detectResolutionScope('t', 'extra time doesn’t count toward the result')).not.toBe('incl_overtime');
  });

  test('noun-compound "count" is NOT counts-voice inclusion', () => {
    // 'count' as a noun ("the penalty count exceeds five") must not read as
    // post-regulation inclusion — only 'counts' (3sg verb), 'count
    // toward/for/in', and the passive 'is/are/will be counted' qualify.
    expect(detectResolutionScope('t', 'the penalty count exceeds five')).toBe('unspecified');
    expect(detectResolutionScope('t', 'total shootout count for the season')).toBe('unspecified');
  });

  test('odd/ambiguous phrasings stay unspecified', () => {
    expect(detectResolutionScope('t', 'unless the match goes to extra time')).toBe('unspecified');
    expect(detectResolutionScope('t', 'the match may go to extra time')).toBe('unspecified');
  });

  test('aggregate still tested first', () => {
    expect(detectResolutionScope('t', 'winner on aggregate over two legs; extra time and penalties are excluded'))
      .toBe('aggregate');
  });
});

describe('buildScopeDetectionText — per-platform raw extraction (Stage 1h)', () => {
  test('kalshi: rules_primary + rules_secondary via buildKalshiDescription (header included)', () => {
    const text = buildScopeDetectionText('kalshi', {
      strike_type: 'structured',
      yes_sub_title: 'Tie',
      rules_primary: 'after 90 minutes plus stoppage time (does not include extra time or penalties)',
      rules_secondary: 'secondary rules text',
    });
    expect(text).toContain('does not include extra time');
    expect(text).toContain('secondary rules text');
    // and the composed text drives the detector to regulation
    expect(detectResolutionScope('A vs B Winner?', text)).toBe('regulation');
  });

  test('predict: native description field', () => {
    expect(buildScopeDetectionText('predict', { description: 'resolves at end of regulation' }))
      .toBe('resolves at end of regulation');
  });

  test('polymarket/limitless: description ?? rules ?? rules_primary fallback chain', () => {
    expect(buildScopeDetectionText('polymarket', { description: 'incl any overtime' })).toBe('incl any overtime');
    expect(buildScopeDetectionText('limitless', { rules: 'regular time only' })).toBe('regular time only');
    expect(buildScopeDetectionText('polymarket', { rules_primary: 'fallback' })).toBe('fallback');
  });

  test('missing/null raw → empty string (detector then sees title only)', () => {
    expect(buildScopeDetectionText('predict', null)).toBe('');
    expect(buildScopeDetectionText('kalshi', undefined)).toBe('');
    expect(buildScopeDetectionText('polymarket', 'not-an-object')).toBe('');
  });
});

describe('detectResolutionScope — knockout-progression anchor gate (W2-1, caveat-d D1)', () => {
  test('REAL sports knockouts keep incl_overtime (round/trophy anchor present)', () => {
    expect(detectResolutionScope('Will Denver Nuggets advance to the 2026 NBA Finals?', '')).toBe('incl_overtime');
    expect(detectResolutionScope('Will Detroit Pistons advance to the Conference Finals?', '')).toBe('incl_overtime');
    expect(detectResolutionScope("Will Kansas qualify for the men's Round of 8?", '')).toBe('incl_overtime');
    expect(detectResolutionScope('Will X reach the semifinal?', '')).toBe('incl_overtime');
    expect(detectResolutionScope('Will X advance to the semifinal?', '')).toBe('incl_overtime'); // legacy case preserved
    expect(detectResolutionScope('t', 'the winner must progress to the next round')).toBe('incl_overtime');
    expect(detectResolutionScope('t', 'the team that qualifies for the quarter-finals')).toBe('incl_overtime');
    expect(detectResolutionScope('t', 'first to lift the trophy')).toBe('incl_overtime');
    expect(detectResolutionScope('Will Team A win the cup?', '')).toBe('incl_overtime');
    expect(detectResolutionScope('Will Team A win the tie?', '')).toBe('incl_overtime');
  });

  test('bare advance/qualify with NO round anchor no longer guesses incl_overtime', () => {
    // election settlement text — "qualified candidates/participants" (the dominant D1 false trigger)
    expect(detectResolutionScope('Will the total vote count for all participants exceed 300000?',
      'If the total vote count for all qualified candidates in the House General Election is above 300000, resolves Yes.'))
      .not.toBe('incl_overtime');
    // Colombia presidential first round — "advance to the second round" (political, not a knockout anchor)
    expect(detectResolutionScope('Will candidate X advance to the second round?',
      'The presidential election first round is scheduled for May 31, 2026.')).not.toBe('incl_overtime');
    // generic / token-launch / acquisition phrasing that merely contains the bare verb
    expect(detectResolutionScope('Will any token qualify for a Binance Alpha listing?', '')).not.toBe('incl_overtime');
    expect(detectResolutionScope('Will Trump acquire Greenland before 2027?',
      'Resolves Yes if the United States officially announces sovereignty.')).not.toBe('incl_overtime');
    // and they honestly bottom out at unspecified (no other signal present)
    expect(detectResolutionScope('Will any token qualify for a listing?', '')).toBe('unspecified');
  });

  test('progression negator-tempered: a negator between the verb and the anchor breaks the bind', () => {
    // "qualified …" must not reach across a negator to the anchor "final round"
    expect(detectResolutionScope('t', 'qualified candidates who will not compete in the final round of voting'))
      .not.toBe('incl_overtime');
  });
});
