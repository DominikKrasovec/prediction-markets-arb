import { describe, test, expect } from 'bun:test';
import {
  verifyTokenOutcomeMapping,
  expandTwoSidedSubscriptions,
  rejectCrossedBookEnabled,
  type TokenOutcomePair,
} from './token-map.js';
import type { MarketSubscription } from './price-cache.js';

// Real raw payloads (probed read-only from polymarket_markets)

/** condition_id 0xc6be068d… "Ethereum above 2,300 on May 10, 6AM ET?" */
const YES_NO = {
  toks: [
    '10375262570564793419317537498687393230186441641621450604944595573097527230288',
    '97466016105671079052292678686886126103311281365778220510460745565714738386108',
  ],
  outs: ['Yes', 'No'],
};

/** condition_id 0xf8078728… "BNB Up or Down - May 11, 5:10AM-5:15AM ET" */
const UP_DOWN = {
  toks: [
    '47338708867636522721746721847931790427968811850619846951333139207270549602420',
    '86037129547969187482570153402419037781331480202563962472439719035947780303577',
  ],
  outs: ['Up', 'Down'],
};

/** condition_id 0xf6f49e06… "Games Total: O/U 2.5" */
const OVER_UNDER = {
  toks: [
    '84801823784009343442165799071301490484145409877413407391037365666113586793011',
    '107556824113834793266096681054319163501198673209663273490274740363048174177249',
  ],
  outs: ['Over', 'Under'],
};

/** condition_id 0x01aa7271… "Map 1: Odd/Even Total Kills?" */
const ODD_EVEN = {
  toks: [
    '96278517944375734657932421551404158346634489059487650385713301543083276364408',
    '55562244613696153697979116782961553163252847917409739072278382206537723968086',
  ],
  outs: ['Odd', 'Even'],
};

/** condition_id 0x4b450c96… "Juan Estevez vs. Andrea Collarini: Total Sets O/U 2.5" */
const OVER_X = {
  toks: [
    '36607794955519186501628399802986526359310568318166605757275981469516905781834',
    '4119988593988010309133132827158992598521062130389077940125674502844938050892',
  ],
  outs: ['Over 2.5', 'Under 2.5'],
};

/** condition_id 0x52f953bd… "Pistons vs. Cavaliers" — team-vs-team labels. */
const TEAM_PAIR = {
  toks: [
    '73202237238299039889130523430877944882369151336851431990911935047048378362723',
    '102860925866954003158841129327041711410011624382962867117087237151352260776640',
  ],
  outs: ['Pistons', 'Cavaliers'],
};

describe('verifyTokenOutcomeMapping — verified families (real payloads)', () => {
  test('["Yes","No"] → token[0]=YES, token[1]=NO', () => {
    const v = verifyTokenOutcomeMapping(YES_NO.toks, YES_NO.outs);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.pair.yesTokenId).toBe(YES_NO.toks[0]);
      expect(v.pair.noTokenId).toBe(YES_NO.toks[1]);
      expect(v.pair.outcomes).toEqual(['Yes', 'No']);
    }
  });

  test('["Up","Down"] (candle markets, direction=above) → affirmative-first', () => {
    const v = verifyTokenOutcomeMapping(UP_DOWN.toks, UP_DOWN.outs);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.pair.yesTokenId).toBe(UP_DOWN.toks[0]);
  });

  test('["Over","Under"] (totals, direction=above) → affirmative-first', () => {
    const v = verifyTokenOutcomeMapping(OVER_UNDER.toks, OVER_UNDER.outs);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.pair.noTokenId).toBe(OVER_UNDER.toks[1]);
  });

  test('["Odd","Even"] → affirmative-first', () => {
    expect(verifyTokenOutcomeMapping(ODD_EVEN.toks, ODD_EVEN.outs).ok).toBe(true);
  });

  test('["Over 2.5","Under 2.5"] (matching threshold) → affirmative-first', () => {
    const v = verifyTokenOutcomeMapping(OVER_X.toks, OVER_X.outs);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.pair.yesTokenId).toBe(OVER_X.toks[0]);
  });

  test('label matching is case/whitespace-insensitive', () => {
    expect(verifyTokenOutcomeMapping(YES_NO.toks, ['YES', ' no ']).ok).toBe(true);
  });
});

describe('verifyTokenOutcomeMapping — rejections', () => {
  test('team-vs-team labels are unverifiable (real payload)', () => {
    const v = verifyTokenOutcomeMapping(TEAM_PAIR.toks, TEAM_PAIR.outs);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('unverifiable-labels');
  });

  test('INVERTED ["No","Yes"] is rejected loudly, never swapped', () => {
    const v = verifyTokenOutcomeMapping(YES_NO.toks, ['No', 'Yes']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('inverted-order');
  });

  test('INVERTED ["Under 2.5","Over 2.5"] is rejected as inverted', () => {
    const v = verifyTokenOutcomeMapping(OVER_X.toks, ['Under 2.5', 'Over 2.5']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('inverted-order');
  });

  test('INVERTED ["Down","Up"] is rejected as inverted', () => {
    const v = verifyTokenOutcomeMapping(UP_DOWN.toks, ['Down', 'Up']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('inverted-order');
  });

  test('mismatched over/under thresholds are unverifiable', () => {
    const v = verifyTokenOutcomeMapping(OVER_X.toks, ['Over 2.5', 'Under 3.5']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('unverifiable-labels');
  });

  test('empty clobTokenIds array (real row: condition_id "") → bad-token-array', () => {
    const v = verifyTokenOutcomeMapping([], ['Yes', 'No']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad-token-array');
  });

  test('missing / non-array clobTokenIds → bad-token-array', () => {
    const v = verifyTokenOutcomeMapping(undefined, ['Yes', 'No']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad-token-array');
  });

  test('empty-string token id → empty-token', () => {
    const v = verifyTokenOutcomeMapping(['', YES_NO.toks[1]], ['Yes', 'No']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('empty-token');
  });

  test('duplicate token ids → duplicate-tokens', () => {
    const v = verifyTokenOutcomeMapping([YES_NO.toks[0], YES_NO.toks[0]], ['Yes', 'No']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('duplicate-tokens');
  });

  test('3-element outcomes → bad-outcomes-array', () => {
    const v = verifyTokenOutcomeMapping(YES_NO.toks, ['Yes', 'No', 'Maybe']);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad-outcomes-array');
  });
});

// expansion

const sub = (
  marketId: number,
  platform: MarketSubscription['platform'],
  platformId: string,
  outcome?: 'yes' | 'no',
): MarketSubscription => ({ marketId, platform, platformId, outcome });

describe('expandTwoSidedSubscriptions', () => {
  const pair: TokenOutcomePair = {
    yesTokenId: YES_NO.toks[0],
    noTokenId: YES_NO.toks[1],
    outcomes: ['Yes', 'No'],
  };
  const map = new Map([['0xc6be', pair]]);

  test('verified PM market expands to YES+NO token subs, marketId preserved', () => {
    const out = expandTwoSidedSubscriptions([sub(7, 'polymarket', '0xc6be')], map);
    expect(out).toEqual([
      { marketId: 7, platform: 'polymarket', platformId: YES_NO.toks[0], outcome: 'yes' },
      { marketId: 7, platform: 'polymarket', platformId: YES_NO.toks[1], outcome: 'no' },
    ]);
  });

  test('unverified PM market passes through unchanged (synthetic fallback)', () => {
    const original = sub(8, 'polymarket', '0xdead');
    expect(expandTwoSidedSubscriptions([original], map)).toEqual([original]);
  });

  test('non-Polymarket platforms are never expanded', () => {
    const subs = [
      sub(1, 'kalshi', 'KXBTC-XYZ'),
      sub(2, 'predict', '12345'),
      sub(3, 'limitless', 'some-slug'),
    ];
    expect(expandTwoSidedSubscriptions(subs, map)).toEqual(subs);
  });

  test('already-token-level subs (outcome tagged, e.g. geo manifests) are not re-expanded', () => {
    const subs = [
      sub(7, 'polymarket', YES_NO.toks[0], 'yes'),
      sub(7, 'polymarket', YES_NO.toks[1], 'no'),
    ];
    expect(expandTwoSidedSubscriptions(subs, map)).toEqual(subs);
  });

  test('mixed list: only the verified untagged PM sub doubles', () => {
    const out = expandTwoSidedSubscriptions(
      [sub(1, 'kalshi', 'T'), sub(7, 'polymarket', '0xc6be'), sub(8, 'polymarket', '0xdead')],
      map,
    );
    expect(out).toHaveLength(4);
  });
});

describe('rejectCrossedBookEnabled (FIX ①, PERMANENT)', () => {
  test('unconditionally on — the CLOB_REJECT_CROSSED_BOOK=0 escape hatch was retired', () => {
    expect(rejectCrossedBookEnabled()).toBe(true);
  });
});
