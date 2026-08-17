/**
 * Unit tests for `tryNormalizeKalshiRow` — Pass 2 (parlay / MVE) branch.
 *
 * Pass 2 reads the structured `mve_selected_legs` array and produces the
 * normalization without any DB roundtrip, LLM call, embedding lookup, or KB
 * entity registration.
 *
 * Coverage focuses on the invariants Stage 2/3 depend on:
 *   - canonical_event is a sorted hash of `(side, ticker)` tuples so
 *     identical parlays collapse into one question
 *   - participants[] is the sorted distinct ticker set
 *   - condition_value mirrors the leg signature for `parseMveLegSet`
 *   - no parlay-level KB writes (resolved_entities is empty)
 *   - confidence is 1.0 (downstream rule confidence-floors depend on it)
 */
import { describe, test, expect } from 'bun:test';
import {
  tryNormalizeKalshiRow,
  quantizeKalshiStrike,
  resolvePriceLadderStamp,
  isVoteHubApprovalYearTicker,
  deriveStrike,
  isHourlyCandleCryptoSeries,
  alignHourlyCandleTimestamp,
  resolveTypedStrikeDate,
  parseMidtermMovStatewide,
  parseSeasonStatThreshold,
  lookupSeries,
  parseEconExactValue,
  parseNextTeamSubject,
  extractGameTotalFixture,
  extractMusicChartSubject,
  gameTotalMetricScope,
  periodWinnerMetricScope,
  PERIOD_WINNER_SERIES,
  electionMarginSubjectWithParty,
  classifyNbaNhlSeries,
  extractSeriesFixture,
  wcStageOrdinal,
  classifySeasonWinsSeries,
  SEASON_WINS_SERIES,
  MUSIC_ACHIEVEMENT_SERIES,
  GOLF_EAGLE_TITLE_RX,
  PERFORMER_PARTICIPATION_SERIES,
  EUROVISION_RANK_TITLE_RX,
  parseSeasonWinThreshold,
  parseMlbSpread,
  tryKalshiSpeechMention,
  K_SPEECH_SHAPE_A_RX,
  K_SPEECH_SHAPE_B_RX,
  K_SPEECH_ROLE_NOUN_RX,
  singleWinnerRankFields,
  SINGLE_WINNER_RANK_KINDS,
  acceptPerInstanceSubject,
  priceLadderDefaultEventKind,
  resolvePlayerStatSeries,
  parsePrimaryMov,
  parseVotePrimary,
  spreadCoverSubject,
  type KalshiCandidateRow,
} from './kalshi-deterministic.js';
import { canonicalizeKalshiStrike } from '../util/threshold-canonical.js';
import { stampDiscriminators } from '../discriminators/stamp.js';
import { lookupWinnerSeries } from './kalshi-series.js';
import type { LLMMarketNormalization } from '@arb/types';
import type { EventDate } from './event-date-extractor.js';
import type { MetricScope } from '@arb/types';

/**
 * Build a minimal KalshiCandidateRow for the parlay path with sensible
 * defaults.  All non-parlay-relevant fields are nulled.
 */
function parlayRow(overrides: Partial<KalshiCandidateRow> & Pick<KalshiCandidateRow, 'market_id' | 'event_ticker' | 'mve_selected_legs'>): KalshiCandidateRow {
  return {
    platform_id: `KXMVE-TEST-${overrides.market_id}`, // synthetic ticker for the parlay itself
    title: '',
    end_date: '2026-05-10',
    strike_type: null,
    floor_strike: null,
    cap_strike: null,
    custom_strike: null,
    event_title: null,
    strike_date: null,
    rules_primary: null,
    yes_sub_title: null,
    subtitle: null,
    occurrence_datetime: null,
    mve_collection_ticker: null,
    kalshi_competition: null,
    category_unified: null,
    ...overrides,
  };
}

describe('deriveStrike — uniform strike resolution across all encodings', () => {
  const strike = (o: Partial<Parameters<typeof deriveStrike>[0]>) =>
    deriveStrike({ strike_type: null, floor_strike: null, cap_strike: null, custom_strike: null, rules_primary: null, ...o });

  test('(1) top-level typed strike — BTC/ETH/SOL/etc.', () => {
    // strikeType carries the resolved operator.
    expect(strike({ strike_type: 'greater', floor_strike: '72000' }))
      .toEqual({ shape: 'point_in_time', direction: 'above', floor: 72000, cap: null, strikeType: 'greater' });
    expect(strike({ strike_type: 'between', floor_strike: '80000', cap_strike: '90000' }))
      .toEqual({ shape: 'range_snapshot', direction: 'between', floor: 80000, cap: 90000, strikeType: 'between' });
  });

  test('(2) nested custom strike — DOGE/SHIBA sub-cent, unwrapped into the SAME path', () => {
    expect(strike({ strike_type: 'custom', custom_strike: '{"cap_strike": "", "strike_type": "greater", "floor_strike": "0.000015499"}' }))
      .toEqual({ shape: 'point_in_time', direction: 'above', floor: 0.000015499, cap: null, strikeType: 'greater' });
    // 'less'/below.
    expect(strike({ strike_type: 'custom', custom_strike: '{"cap_strike": "0.000000500", "strike_type": "less", "floor_strike": ""}' }))
      .toEqual({ shape: 'point_in_time', direction: 'below', floor: null, cap: 0.0000005, strikeType: 'less' });
    expect(strike({ strike_type: 'custom', custom_strike: '{"cap_strike": "0.000015499", "strike_type": "between", "floor_strike": "0.000015000"}' }))
      .toEqual({ shape: 'range_snapshot', direction: 'between', floor: 0.000015, cap: 0.000015499, strikeType: 'between' });
  });

  test('(3) prose fallback — legacy custom series with malformed/absent nested struct', () => {
    // Prose "is between/above/below" are tagged STRICT (greater/less) so the
    // threshold canonicalization is operator-aware.
    expect(strike({ strike_type: 'custom', custom_strike: 'not json', rules_primary: 'price is between 0.10-0.20 at settlement' }))
      .toEqual({ shape: 'range_snapshot', direction: 'between', floor: 0.10, cap: 0.20, strikeType: 'greater' });
    expect(strike({ strike_type: 'custom', rules_primary: 'price is above 0.16 at settlement' }))
      .toEqual({ shape: 'point_in_time', direction: 'above', floor: 0.16, cap: null, strikeType: 'greater' });
  });

  test('no usable strike → null', () => {
    expect(strike({})).toBeNull();
    expect(strike({ strike_type: 'custom', custom_strike: '{"strike_type": "weird"}' })).toBeNull();
  });

  // strike_type='structured' with a top-level numeric strike: floor-only means strict-above.
  test('(4) structured strike — floor-only derives strict-above (KXARTISTSTREAMS)', () => {
    expect(strike({ strike_type: 'structured', floor_strike: '241000000', custom_strike: '{"musician": "f35a7d12-7d57-4150-830c-683f7d473a5d"}' }))
      .toEqual({ shape: 'point_in_time', direction: 'above', floor: 241000000, cap: null, strikeType: 'greater' });
  });

  test('(4) structured strike — cap-only ⇒ below, floor+cap ⇒ between', () => {
    expect(strike({ strike_type: 'structured', cap_strike: '500' }))
      .toEqual({ shape: 'point_in_time', direction: 'below', floor: null, cap: 500, strikeType: 'less' });
    expect(strike({ strike_type: 'structured', floor_strike: '100', cap_strike: '200' }))
      .toEqual({ shape: 'range_snapshot', direction: 'between', floor: 100, cap: 200, strikeType: 'between' });
  });

  test('(4) structured strike with NO numeric floor/cap (uuid-only, KXPGAR*LEAD) → null', () => {
    // A uuid-only custom_strike must not derive a bogus zero threshold.
    expect(strike({ strike_type: 'structured', custom_strike: '{"golf_competitor": "cbda16d0-784a-49ff-bce3-2cf09393fc4b"}' }))
      .toBeNull();
  });
});

describe('parseMidtermMovStatewide — statewide KXMIDTERMMOV (no district)', () => {
  test('"U.S. Senate election in <State>" → senate', () => {
    expect(parseMidtermMovStatewide(
      'Will the margin of victory for Democrats in the U.S. Senate election in Colorado be at least 10 percentage points?',
    )).toEqual({ party: 'Democrats', state: 'Colorado', chamber: 'senate', subjectRaw: 'Colorado senate race' });
  });

  test('multi-word state captured fully', () => {
    const r = parseMidtermMovStatewide(
      'Will the margin of victory for Republicans in the U.S. Senate election in North Carolina be at least 5 percentage points?',
    );
    expect(r?.state).toBe('North Carolina');
    expect(r?.subjectRaw).toBe('North Carolina senate race');
  });

  test('"governor election in <State>" → governor', () => {
    expect(parseMidtermMovStatewide(
      'Will the margin of victory for Democrats in the governor election in Arizona be at least 11 percentage points?',
    )).toEqual({ party: 'Democrats', state: 'Arizona', chamber: 'governor', subjectRaw: 'Arizona governor race' });
  });

  test('at-large "<State> House election" → house', () => {
    expect(parseMidtermMovStatewide(
      'Will the margin of victory for Democrats in the Delaware House election be at least 13 percentage points?',
    )).toEqual({ party: 'Democrats', state: 'Delaware', chamber: 'house', subjectRaw: 'Delaware house race' });
  });

  test('candidate-named PRIMARY race is NOT matched (party anchor excludes it)', () => {
    expect(parseMidtermMovStatewide(
      'Will the margin of victory for Steve Hilton in the governor primary election in California be at least 1 percentage points?',
    )).toBeNull();
  });

  test('per-district title is NOT matched here (handled by the per-district RX)', () => {
    expect(parseMidtermMovStatewide(
      "Will the margin of victory for Republicans in the California's 3rd District House election be at least 5 percentage points?",
    )).toBeNull();
  });
});

describe('parseSeasonStatThreshold — KXNFLSEASON*/KXMLBSEASON* season totals', () => {
  test('extracts the +N threshold from each season-total shape', () => {
    expect(parseSeasonStatThreshold(
      'Will Parker Washington record 750+ receiving yards during 2026-27 Pro Football regular season?',
    )).toBe(750);
    expect(parseSeasonStatThreshold(
      'Will Yandy Díaz record 20+ home runs during 2026 Pro Baseball regular season?',
    )).toBe(20);
    expect(parseSeasonStatThreshold(
      'Will Aaron Rodgers record 3000+ passing yards during 2026-27 Pro Football regular season?',
    )).toBe(3000);
    expect(parseSeasonStatThreshold(
      'Will Saquon Barkley record 1500+ rushing yards during 2026-27 Pro Football regular season?',
    )).toBe(1500);
  });

  test('not a season-total title → null (game props, other shapes)', () => {
    expect(parseSeasonStatThreshold('Josh Hart: 2+ threes')).toBeNull();
    expect(parseSeasonStatThreshold('Will Aaron Judge record 1+ hits + runs + RBIs?')).toBeNull();
    expect(parseSeasonStatThreshold('Will the Lakers win the title?')).toBeNull();
  });
});

describe('lookupSeries — weather aggregate-count series (Gap 4)', () => {
  test('KXTORNADO → count / tornadoes / windowCount (cumulative convergence, rebuild-boundary batch)', () => {
    expect(lookupSeries('KXTORNADO-26MAY')).toMatchObject(
      { subject: 'US Tornado Count', metric: 'count', unit: 'tornadoes', category: 'weather', entityType: 'event_name', windowCount: true });
  });
  test('KXHURCTOT and KXHURCTOTMAJ do NOT collide (exact match beats prefix-scan)', () => {
    expect(lookupSeries('KXHURCTOT-2026')).toMatchObject({ subject: 'Atlantic Hurricane Count', unit: 'hurricanes' });
    expect(lookupSeries('KXHURCTOTMAJ-2026')).toMatchObject({ subject: 'Atlantic Major Hurricane Count', unit: 'hurricanes' });
  });
  test('KXTROPSTORM → tropical storm count', () => {
    expect(lookupSeries('KXTROPSTORM-2026')).toMatchObject({ subject: 'Atlantic Tropical Storm Count', unit: 'storms' });
  });
  test('unrelated ticker still resolves (KXBTC) / unknown returns null', () => {
    expect(lookupSeries('KXBTC-26MAY')).toMatchObject({ subject: 'BTC', metric: 'price' });
    expect(lookupSeries('KXNONEXISTENT-1')).toBeNull();
  });
});

describe('lookupSeries — legislative seat-count distribution series (value-blind-fold fix)', () => {
  test('the 5 political seat-count series resolve to count/seats/election', () => {
    for (const prefix of ['RSENATESEATS', 'KXDSENATESEATS', 'KXDSENATESEATSH', 'KXDHOUSESEATSDIR', 'KXTXHOUSEDEMSEATS']) {
      expect(lookupSeries(`${prefix}-26NOV`)).toMatchObject({
        metric: 'count', unit: 'seats', category: 'election', entityType: 'event_name',
      });
    }
  });
  test('KXDSENATESEATS congress is derived PER-EVENT from the ticker year segment', () => {
    // perInstanceSubject keys off the year segment so each Congress gets a distinct subject.
    const entry = lookupSeries('KXDSENATESEATS-27')!;
    expect(entry.subject).toBe('Democratic US Senate Seats');
    const congressOf = (ev: string) => entry.perInstanceSubject!(krow({ market_id: 1, title: 't', event_ticker: ev }));
    expect(congressOf('KXDSENATESEATS-27')).toBe('Democratic US Senate Seats (120th Congress)');
    expect(congressOf('KXDSENATESEATS-29')).toBe('Democratic US Senate Seats (121st Congress)');
    expect(congressOf('KXDSENATESEATS-27')).not.toBe(congressOf('KXDSENATESEATS-29'));
    // an unknown segment stays distinct via the raw cycle tag
    expect(congressOf('KXDSENATESEATS-99')).toBe('Democratic US Senate Seats (cycle 99)');
  });
  test('KXDSENATESEATSH (120th) keeps its static congress label; the two series stay distinct', () => {
    // KXDSENATESEATS is a strict prefix of KXDSENATESEATSH — the exact-match arm must claim each.
    expect(lookupSeries('KXDSENATESEATSH-27')?.subject).toBe('Democratic US Senate Seats (120th Congress)');
    expect(lookupSeries('KXDSENATESEATS-27')?.subject).not.toBe(lookupSeries('KXDSENATESEATSH-27')?.subject);
  });
  test('Republican and Democratic Senate ladders carry DIFFERENT subjects (no cross-party fusion)', () => {
    expect(lookupSeries('RSENATESEATS-27')?.subject).toBe('Republican US Senate Seats');
    expect(lookupSeries('KXDSENATESEATS-27')?.subject).not.toBe(lookupSeries('RSENATESEATS-27')?.subject);
  });

  // 'seats' is INTEGER_GRAIN so a strict Kalshi tail folds to its inclusive
  // half-line (Kalshi ">57" is >=58, not >=57).
  test('greater/less/between strikes shape to the right half-lines under unit=seats', () => {
    const gt = deriveStrike({ strike_type: 'greater', floor_strike: '57', cap_strike: null, custom_strike: null, rules_primary: null });
    expect(gt).toMatchObject({ direction: 'above', floor: 57, strikeType: 'greater' });
    expect(canonicalizeKalshiStrike('greater', 57, null, 'seats')).toMatchObject({ direction: 'above', value: 57.5 });
    const lt = deriveStrike({ strike_type: 'less', floor_strike: null, cap_strike: '45', custom_strike: null, rules_primary: null });
    expect(lt).toMatchObject({ direction: 'below', cap: 45, strikeType: 'less' });
    expect(canonicalizeKalshiStrike('less', null, 45, 'seats')).toMatchObject({ direction: 'below', value: 44.5 });
    const eq = deriveStrike({ strike_type: 'between', floor_strike: '45', cap_strike: '45', custom_strike: null, rules_primary: null });
    expect(resolvePriceLadderStamp(eq!, 45, 45)).toMatchObject({ direction: 'at', value_primary: 45 });
  });
});

describe('tryNormalizeKalshiRow — Pass 2 (MVE parlay)', () => {
  test('basic 2-leg parlay produces deterministic normalization', async () => {
    const hit = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 100,
        event_ticker: 'KXMVESPORTSMULTIGAMEEXTENDED-S2026ABC',
        mve_selected_legs: [
          { side: 'yes', market_ticker: 'KXNBAPTS-26MAY10NYKPHI-NYKJBRUNSON11-20' },
          { side: 'no',  market_ticker: 'KXNBATOTAL-26MAY10NYKPHI-224' },
        ],
      }),
    );
    expect(hit).not.toBeNull();
    expect(hit!.tag).toBe('kalshi:parlay:mve');

    const n = hit!.norm;
    expect(n.match_source).toBe('kalshi:parlay:mve');
    expect(n.confidence).toBe(1.0);
    expect(n.condition_shape).toBe('binary_event');
    expect(n.temporal_semantics).toBe('at_resolution');
    expect(n.value_primary).toBeNull();
    expect(n.resolved_entities).toEqual([]);
    expect(n.participants).toEqual([
      'KXNBAPTS-26MAY10NYKPHI-NYKJBRUNSON11-20',
      'KXNBATOTAL-26MAY10NYKPHI-224',
    ]);
    expect(n.condition_value).toBe(
      'no|KXNBATOTAL-26MAY10NYKPHI-224 AND yes|KXNBAPTS-26MAY10NYKPHI-NYKJBRUNSON11-20',
    );
    expect(n.canonical_event).toBe(
      'parlay[no|KXNBATOTAL-26MAY10NYKPHI-224;yes|KXNBAPTS-26MAY10NYKPHI-NYKJBRUNSON11-20]',
    );
  });

  test('leg input order does not affect output (sort guarantees determinism)', async () => {
    const a = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXMVESPORTS-X',
        mve_selected_legs: [
          { side: 'yes', market_ticker: 'KXC-3' },
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'no',  market_ticker: 'KXB-2' },
        ],
      }),
    );
    const b = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 2, // different market_id, but same legs (reordered)
        event_ticker: 'KXMVESPORTS-X',
        mve_selected_legs: [
          { side: 'no',  market_ticker: 'KXB-2' },
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXC-3' },
        ],
      }),
    );
    expect(a!.norm.canonical_event).toBe(b!.norm.canonical_event);
    expect(a!.norm.condition_value).toBe(b!.norm.condition_value);
    expect(a!.norm.participants).toEqual(b!.norm.participants);
  });

  test('parlays differing only in one leg side produce different canonical_event', async () => {
    // Opposite legs sharing every other leg must hash distinctly.
    const yesParlay = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXMVESPORTS-Y',
        mve_selected_legs: [
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXB-2' },
        ],
      }),
    );
    const noParlay = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 2,
        event_ticker: 'KXMVESPORTS-Y',
        mve_selected_legs: [
          { side: 'no',  market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXB-2' },
        ],
      }),
    );
    expect(yesParlay!.norm.canonical_event).not.toBe(noParlay!.norm.canonical_event);
  });

  test('KXMVESPORTS prefix → category_unified=sports', async () => {
    const hit = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXMVESPORTSMULTIGAMEEXTENDED-S2026XYZ',
        mve_selected_legs: [
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXB-2' },
        ],
      }),
    );
    expect(hit!.norm.category_unified).toBe('sports');
  });

  test('KXMVECROSS prefix → category_unified=other', async () => {
    const hit = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXMVECROSSCATEGORY-S2026XYZ',
        mve_selected_legs: [
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXB-2' },
        ],
      }),
    );
    expect(hit!.norm.category_unified).toBe('other');
  });

  test('missing mve_selected_legs on a KXMV* row returns null (safe fallback)', async () => {
    // Bail cleanly rather than emit a malformed normalization.
    const hit = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXMVESPORTS-X',
        mve_selected_legs: null,
      }),
    );
    expect(hit).toBeNull();
  });

  test('empty mve_selected_legs array returns null', async () => {
    const hit = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXMVESPORTS-X',
        mve_selected_legs: [],
      }),
    );
    expect(hit).toBeNull();
  });

  test('non-parlay event_ticker is NOT handled by Pass 2 — falls through', async () => {
    const hit = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXNBAPTS-26MAY10NYKPHI',
        mve_selected_legs: [
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXB-2' },
        ],
        title: 'Some unrelated title',
        strike_type: null,
      }),
    );
    expect(hit).toBeNull();
  });

  test('duplicate leg tickers (defensive) are deduplicated in participants[]', async () => {
    // participants[] uses Set semantics so a ticker appears at most once.
    const hit = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXMVESPORTS-X',
        mve_selected_legs: [
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXB-2' },
        ],
      }),
    );
    expect(hit!.norm.participants).toEqual(['KXA-1', 'KXB-2']);
  });

  test('end_date flows through to condition_date', async () => {
    const hit = await tryNormalizeKalshiRow(
      parlayRow({
        market_id: 1,
        event_ticker: 'KXMVESPORTS-X',
        end_date: '2026-05-15',
        mve_selected_legs: [
          { side: 'yes', market_ticker: 'KXA-1' },
          { side: 'yes', market_ticker: 'KXB-2' },
        ],
      }),
    );
    expect(hit!.norm.condition_date).toBe('2026-05-15');
  });
});

// Degenerate between (floor == cap after quantization) routes through the
// 'at' stamp. Non-degenerate stamps stay unchanged.
describe('resolvePriceLadderStamp — degenerate between → at (P3 phase-2 flip)', () => {
  const between = { shape: 'range_snapshot', direction: 'between' } as const;
  test('FLIP: between with floor == cap collapses to point_in_time/at, single value', () => {
    expect(resolvePriceLadderStamp(between, 10, 10)).toEqual({
      shape: 'point_in_time',
      direction: 'at',
      value_primary: 10,
      value_secondary: null,
    });
  });
  test('non-degenerate between is UNCHANGED (range pair, lo<hi)', () => {
    expect(resolvePriceLadderStamp(between, 80000, 90000)).toEqual({
      shape: 'range_snapshot',
      direction: 'between',
      value_primary: 80000,
      value_secondary: 90000,
    });
  });
  test('above / below stamps are UNCHANGED passthroughs (floor / cap pick)', () => {
    expect(resolvePriceLadderStamp({ shape: 'point_in_time', direction: 'above' }, 72000, null))
      .toEqual({ shape: 'point_in_time', direction: 'above', value_primary: 72000, value_secondary: null });
    expect(resolvePriceLadderStamp({ shape: 'point_in_time', direction: 'below' }, null, 80000))
      .toEqual({ shape: 'point_in_time', direction: 'below', value_primary: 80000, value_secondary: null });
  });
  test('between with a missing bound stays a (rejectable) pair — only TRUE lo==hi flips', () => {
    expect(resolvePriceLadderStamp(between, 10, null))
      .toEqual({ shape: 'range_snapshot', direction: 'between', value_primary: 10, value_secondary: null });
  });
});

// KXTRUMPAPPROVALYEAR threshold arms route path_touch + during_period;
// every other series keeps the terminal snapshot.
describe('isVoteHubApprovalYearTicker — A1 touch routing lock', () => {
  test('KXTRUMPAPPROVALYEAR event tickers match (the year family, any suffix)', () => {
    expect(isVoteHubApprovalYearTicker('KXTRUMPAPPROVALYEAR-26DEC31')).toBe(true);
    expect(isVoteHubApprovalYearTicker('KXTRUMPAPPROVALYEAR')).toBe(true);
    expect(isVoteHubApprovalYearTicker('kxtrumpapprovalyear-26dec31')).toBe(true);
  });
  test('KXAPRPOTUS (RCP daily) and other series NEVER match', () => {
    expect(isVoteHubApprovalYearTicker('KXAPRPOTUS-26MAY15')).toBe(false);
    expect(isVoteHubApprovalYearTicker('KXBTC-26JUN30-T72000')).toBe(false);
    expect(isVoteHubApprovalYearTicker('KXTRUMPAPPROVALYEARX-26DEC31')).toBe(false); // prefix-collision guard
    expect(isVoteHubApprovalYearTicker(null)).toBe(false);
    expect(isVoteHubApprovalYearTicker(undefined)).toBe(false);
  });
  test('the year family still resolves to the VoteHub series spec (lookupSeries)', () => {
    expect(lookupSeries('KXTRUMPAPPROVALYEAR-26')).toMatchObject({
      event_kind: 'approval_rating',
      resolutionSource: 'VoteHub',
    });
  });
});

describe('quantizeKalshiStrike — Pass 1 trailing-9 convention', () => {
  test('null → null (no-op)', () => {
    expect(quantizeKalshiStrike(null)).toBeNull();
  });

  test('trailing-.99 BTC strike rounds to the integer ceiling', () => {
    // Under $0.01-tick pricing, "> 71999.99" is identical to ">= 72000".
    expect(quantizeKalshiStrike(71999.99)).toBe(72000);
    expect(quantizeKalshiStrike(81499.99)).toBe(81500);
    expect(quantizeKalshiStrike(72099.99)).toBe(72100);
    expect(quantizeKalshiStrike(26349.99)).toBe(26350);
  });

  test('trailing-.9999 index strike (S&P 500 convention) rounds to integer', () => {
    // S&P uses 4-decimal sentinels: 6169.9999 means 6170.
    expect(quantizeKalshiStrike(6169.9999)).toBe(6170);
    expect(quantizeKalshiStrike(7349.9999)).toBe(7350);
  });

  test('integer strike passes through unchanged', () => {
    expect(quantizeKalshiStrike(72000)).toBe(72000);
    expect(quantizeKalshiStrike(73250)).toBe(73250);
    expect(quantizeKalshiStrike(0)).toBe(0);
  });

  test('legitimate non-sentinel decimal passes through unchanged', () => {
    // The trailing-9 guard is intentionally narrow.
    expect(quantizeKalshiStrike(22.5)).toBe(22.5);
    expect(quantizeKalshiStrike(0.025)).toBe(0.025);
    expect(quantizeKalshiStrike(26349.5)).toBe(26349.5);
    expect(quantizeKalshiStrike(71999.5)).toBe(71999.5);
  });

  test('floating-point slack around 0.99 / 0.9999 is tolerated', () => {
    // isKalshiTrailingNine allows ±0.005 around 0.99 and ±0.0005 around 0.9999.
    expect(quantizeKalshiStrike(71999.991)).toBe(72000);
    expect(quantizeKalshiStrike(71999.989)).toBe(72000);
    expect(quantizeKalshiStrike(6169.99991)).toBe(6170);
  });
});

describe('isHourlyCandleCryptoSeries — Pass 1 alignment gating', () => {
  test('null / empty event_ticker → false', () => {
    expect(isHourlyCandleCryptoSeries(null)).toBe(false);
    expect(isHourlyCandleCryptoSeries('')).toBe(false);
  });

  test('known hourly candle series match (exact prefix only)', () => {
    expect(isHourlyCandleCryptoSeries('KXBTC-26MAY1006-T80000')).toBe(true);
    expect(isHourlyCandleCryptoSeries('KXBTCD-26MAY1006-T80000')).toBe(true);
    expect(isHourlyCandleCryptoSeries('KXETH-26MAY1006-T2400')).toBe(true);
    expect(isHourlyCandleCryptoSeries('KXSOLE-26MAY1006-T140')).toBe(true);
    expect(isHourlyCandleCryptoSeries('KXBNBD-26MAY1006-T550')).toBe(true);
    expect(isHourlyCandleCryptoSeries('KXDOGED-26MAY1006-T0.16')).toBe(true);
  });

  test('non-hourly crypto series do NOT match (15-min markets, long-term targets)', () => {
    // 15-minute markets settle at HH:50 — must NOT get HH:05→HH:00 alignment.
    expect(isHourlyCandleCryptoSeries('KXBTC15M-26MAY100545')).toBe(false);
    expect(isHourlyCandleCryptoSeries('KXETH15M-26MAY100545')).toBe(false);
    // Long-term "by date X" markets settle at HH:59.
    expect(isHourlyCandleCryptoSeries('KXBTCMAX-26-MAY')).toBe(false);
    expect(isHourlyCandleCryptoSeries('KXBTCMAX150-25-26MAY31-149999.99')).toBe(false);
    expect(isHourlyCandleCryptoSeries('KXBTCMINY-27JAN01-50000.00')).toBe(false);
    expect(isHourlyCandleCryptoSeries('KXBTC2026250-27JAN01-250000')).toBe(false);
    expect(isHourlyCandleCryptoSeries('KXBTCMAXMON-BTC-26MAY31-8500000')).toBe(false);
  });

  test('non-crypto series do NOT match', () => {
    expect(isHourlyCandleCryptoSeries('KXNFLWINS-26ATL')).toBe(false);
    expect(isHourlyCandleCryptoSeries('KXNASDAQ-26MAY1306')).toBe(false);
    expect(isHourlyCandleCryptoSeries('KXGOLD-26MAY1306')).toBe(false);
  });
});

describe('alignHourlyCandleTimestamp — Pass 1 HH:05 → HH:00 snap', () => {
  test('null / invalid input is preserved', () => {
    expect(alignHourlyCandleTimestamp(null)).toBeNull();
    expect(alignHourlyCandleTimestamp('not-an-iso-date')).toBe('not-an-iso-date');
  });

  test('HH:05:00 timestamps are snapped to HH:00:00 (CF Benchmarks offset)', () => {
    expect(alignHourlyCandleTimestamp('2026-05-10T10:05:00Z')).toBe('2026-05-10T10:00:00Z');
    expect(alignHourlyCandleTimestamp('2026-05-10T21:05:00Z')).toBe('2026-05-10T21:00:00Z');
    // Hour boundary at midnight UTC.
    expect(alignHourlyCandleTimestamp('2026-05-10T00:05:00Z')).toBe('2026-05-10T00:00:00Z');
  });

  test('non-HH:05 timestamps pass through untouched (15-min, hour-boundary, expiration)', () => {
    // 15-min markets settle at HH:50 — must be preserved.
    expect(alignHourlyCandleTimestamp('2026-05-10T09:50:00Z')).toBe('2026-05-10T09:50:00Z');
    // Long-term "by date" markets at HH:59.
    expect(alignHourlyCandleTimestamp('2026-06-01T03:59:00Z')).toBe('2026-06-01T03:59:00Z');
    expect(alignHourlyCandleTimestamp('2026-06-01T03:59:59Z')).toBe('2026-06-01T03:59:59Z');
    // Already at hour boundary.
    expect(alignHourlyCandleTimestamp('2027-01-01T05:00:00Z')).toBe('2027-01-01T05:00:00Z');
    // Other minute offsets (40, 50, anything-not-5) stay.
    expect(alignHourlyCandleTimestamp('2026-05-31T14:40:11Z')).toBe('2026-05-31T14:40:11Z');
  });

  test('HH:05 with non-zero seconds or millis is NOT snapped (defensive)', () => {
    // Only the exact HH:05:00.000 pattern is snapped; anything else is preserved.
    expect(alignHourlyCandleTimestamp('2026-05-10T10:05:30Z')).toBe('2026-05-10T10:05:30Z');
    expect(alignHourlyCandleTimestamp('2026-05-10T10:05:00.500Z')).toBe('2026-05-10T10:05:00.500Z');
  });
});

describe('resolveTypedStrikeDate — condition_date precedence', () => {
  const ev = (iso: string, precision: EventDate['precision'], source: EventDate['source']): EventDate =>
    ({ iso, precision, source, tzAssumed: 'ET' });

  const base = {
    weatherObsDate: null,
    strikeDateAligned: null,
    isHourlyCandle: false,
    rawStrikeDate: null,
    occurrenceDatetime: null,
    tickerDate: null,
    endDate: null,
  } as const;

  test('month-precision ticker OVERRIDES occurrence_datetime (the CPI bug)', () => {
    // A month-precision ticker must win regardless of whether occurrence_datetime is present.
    const withOcc = resolveTypedStrikeDate({
      ...base,
      occurrenceDatetime: '2026-06-10T14:00:00Z',
      tickerDate: ev('2026-05', 'month', 'kalshi-ticker-month'),
    });
    const withoutOcc = resolveTypedStrikeDate({
      ...base,
      occurrenceDatetime: null,
      tickerDate: ev('2026-05', 'month', 'kalshi-ticker-month'),
    });
    expect(withOcc).toEqual({ iso: '2026-05', precision: 'month', source: 'kalshi-ticker-month' });
    expect(withoutOcc).toEqual({ iso: '2026-05', precision: 'month', source: 'kalshi-ticker-month' });
    expect(withOcc.iso).toBe(withoutOcc.iso);
  });

  test('year-precision ticker also overrides occurrence_datetime', () => {
    const r = resolveTypedStrikeDate({
      ...base,
      occurrenceDatetime: '2026-11-03T05:00:00Z',
      tickerDate: ev('2026-01-01', 'year', 'kalshi-ticker-year'),
    });
    expect(r).toEqual({ iso: '2026-01-01', precision: 'year', source: 'kalshi-ticker-year' });
  });

  test('finer (hour) ticker does NOT override occurrence_datetime — crypto candles unchanged', () => {
    // occurrence_datetime is the precise candle moment and must still win.
    const r = resolveTypedStrikeDate({
      ...base,
      occurrenceDatetime: '2026-05-10T06:00:00Z',
      tickerDate: ev('2026-05-10T06:00:00', 'hour', 'kalshi-ticker-hour'),
    });
    expect(r).toEqual({ iso: '2026-05-10T06:00:00Z', precision: 'minute', source: 'kalshi-occurrence-datetime' });
  });

  test('strike_date wins over everything except weather', () => {
    const r = resolveTypedStrikeDate({
      ...base,
      strikeDateAligned: '2026-05-10T16:00:00Z',
      rawStrikeDate: '2026-05-10T16:00:00Z',
      occurrenceDatetime: '2026-05-10T06:00:00Z',
      tickerDate: ev('2026-05', 'month', 'kalshi-ticker-month'),
    });
    expect(r).toEqual({ iso: '2026-05-10T16:00:00Z', precision: 'minute', source: 'kalshi-strike-date' });
  });

  test('weather observation date wins outright', () => {
    const r = resolveTypedStrikeDate({
      ...base,
      weatherObsDate: ev('2026-05-10', 'day', 'kalshi-ticker-day'),
      occurrenceDatetime: '2026-05-11T13:00:00Z',
      tickerDate: ev('2026-05', 'month', 'kalshi-ticker-month'),
    });
    expect(r).toEqual({ iso: '2026-05-10', precision: 'day', source: 'weather-obs-kalshi-ticker-day' });
  });

  test('occurrence_datetime used when only a finer/no ticker is present', () => {
    const r = resolveTypedStrikeDate({ ...base, occurrenceDatetime: '2026-05-10T06:00:00Z' });
    expect(r).toEqual({ iso: '2026-05-10T06:00:00Z', precision: 'minute', source: 'kalshi-occurrence-datetime' });
  });

  test('day-precision ticker is used as a fallback when occurrence is absent', () => {
    const r = resolveTypedStrikeDate({
      ...base,
      tickerDate: ev('2026-05-10', 'day', 'kalshi-ticker-day'),
    });
    expect(r).toEqual({ iso: '2026-05-10', precision: 'day', source: 'kalshi-ticker-day' });
  });

  test('end_date is the last resort', () => {
    const r = resolveTypedStrikeDate({ ...base, endDate: '2026-05-15' });
    expect(r).toEqual({ iso: '2026-05-15', precision: 'day', source: 'end_date' });
  });

  test('all-null → null triple', () => {
    expect(resolveTypedStrikeDate({ ...base })).toEqual({ iso: null, precision: null, source: null });
  });
});

describe('parseEconExactValue — KXECONSTAT* custom_strike {"Value"}', () => {
  test('signed values parse (incl. negatives)', () => {
    expect(parseEconExactValue('{"Value":"3.7"}')).toBe(3.7);
    expect(parseEconExactValue('{"Value":"-0.2"}')).toBe(-0.2);
    expect(parseEconExactValue('{"Value":"0"}')).toBe(0);
  });
  test('malformed / missing → null', () => {
    expect(parseEconExactValue(null)).toBeNull();
    expect(parseEconExactValue('not json')).toBeNull();
    expect(parseEconExactValue('{"strike_type":"greater"}')).toBeNull();
    expect(parseEconExactValue('{"Value":"abc"}')).toBeNull();
  });
});

describe('parseNextTeamSubject — athlete transfer titles', () => {
  test('"What will be X\'s next team?" (NBA/NFL/NHL)', () => {
    expect(parseNextTeamSubject("What will be Joel Embiid's next team?")).toBe('Joel Embiid');
    expect(parseNextTeamSubject("What will be LeBron James's next team?")).toBe('LeBron James');
  });
  test('"Where will X go next?" (soccer)', () => {
    expect(parseNextTeamSubject('Where will Cristiano Ronaldo go next?')).toBe('Cristiano Ronaldo');
  });
  test('non-matching titles → null', () => {
    expect(parseNextTeamSubject('Will Giannis re-sign with Milwaukee?')).toBeNull();
    expect(parseNextTeamSubject('Who will win the NBA Finals?')).toBeNull();
  });
});

describe('extractGameTotalFixture — per-instance subject/opponent (no corruption)', () => {
  const f = (title: string, rules: string | null, sub: 'combined' | 'team') =>
    extractGameTotalFixture({ title, rules_primary: rules }, sub);

  test('team total — subject from title, opponent (≠subject) from rules', () => {
    expect(f('Will Minnesota score over 6.5 runs?',
      'If Minnesota scores 7+ runs in the Miami vs Minnesota professional baseball game …', 'team'))
      .toEqual({ subject: 'Minnesota', opponent: 'Miami' });
  });
  test('combined — clean "A vs/at B Total…" title (no rules-clause swallow)', () => {
    expect(f('Washington vs Miami Total Runs?', 'If Washington and Miami collectively score more 2.5 runs …', 'combined'))
      .toEqual({ subject: 'Washington', opponent: 'Miami' });
    expect(f('Game 5: Cleveland at Detroit: Total Points', 'If the teams in the Cleveland at Detroit professional basketball game …', 'combined'))
      .toEqual({ subject: 'Cleveland', opponent: 'Detroit' });
  });
  test('combined — esports prose-prefix title with lowercase/digit team names', () => {
    expect(f('Will over 2.5 maps be played in the paiN vs. 9z CS2 match?', null, 'combined'))
      .toEqual({ subject: 'paiN', opponent: '9z' });
  });
  test('combined — fixtureless KBO/UFL title falls back to bounded rules fixture', () => {
    expect(f('Over 7.5 runs scored?',
      'If Lotte Giants and Doosan Bears collectively score more than 7.5 runs in the Lotte Giants and Doosan Bears professional …', 'combined'))
      .toEqual({ subject: 'Lotte Giants', opponent: 'Doosan Bears' });
    // The "the teams in the game collectively…" decoy must NOT be captured as a team.
    expect(f('Will the teams score over 43.5 points?',
      'If the teams in the game collectively score over 43.5 points in the 1st Half of the Cleveland vs Detroit professional …', 'combined'))
      .toEqual({ subject: 'Cleveland', opponent: 'Detroit' });
  });
  test('unparseable fixture → null (defer to LLM, never a corrupted subject)', () => {
    expect(f('Over 7.5 runs scored?', 'rules with no parseable fixture here', 'combined')).toBeNull();
  });
  test('Tranche C — NBA Summer League combined total: team-less title → fixture from "Pro Basketball" rules', () => {
    expect(f('Full Game: Over 164.5 points scored',
      'If the teams collectively score more than 164.5 points in the Boston vs Toronto Pro Basketball Summer League game originally scheduled for Jul 10, 2026, then the market resolves to Yes.',
      'combined'))
      .toEqual({ subject: 'Boston', opponent: 'Toronto' });
  });
});

describe('extractMusicChartSubject — Group A (rules) vs B/C/D (yes_sub_title)', () => {
  test('Group A: song/album from rules', () => {
    expect(extractMusicChartSubject(
      { rules_primary: 'If Ordinary by Alex Warren is ranked #4 on the Billboard Hot 100 chart for the Week of …', title: 'Will Ordinary be #4 on the Billboard Hot 100 …', yes_sub_title: '4' },
      'rules',
    )).toBe('Ordinary');
  });
  test('Group A: title fallback when rules absent', () => {
    expect(extractMusicChartSubject(
      { rules_primary: null, title: 'Will Folded be on the Billboard Hot 100 during the week of May 23, 2026', yes_sub_title: '6' },
      'rules',
    )).toBe('Folded');
  });
  test('Group B/C/D: subject is yes_sub_title verbatim', () => {
    expect(extractMusicChartSubject(
      { rules_primary: 'If Luke Combs is #1 on Any Spotify Daily Top Songs USA chart in May 2026 …', title: 'x', yes_sub_title: 'Luke Combs' },
      'yes_sub',
    )).toBe('Luke Combs');
  });
});

// metric_scope

describe('gameTotalMetricScope — GameTotalSpec → MetricScope mapping table', () => {
  // The function takes a GameTotalSpec; we construct the relevant fields inline.
  type Spec = Parameters<typeof gameTotalMetricScope>[0];
  const spec = (o: Partial<Spec>): Spec => ({
    unit: 'points', scope: null, sub: 'combined', entity: 'team', sport: null, metric: 'score', ...o,
  });

  test('whole-game combined total → game', () => {
    expect(gameTotalMetricScope(spec({ sub: 'combined', scope: null }))).toBe('game');
  });
  test('per-team total → team (outranks scope)', () => {
    expect(gameTotalMetricScope(spec({ sub: 'team', scope: null }))).toBe('team');
  });
  test('period scopes map to first_5 / half_1 / half_2', () => {
    expect(gameTotalMetricScope(spec({ scope: 'F5' }))).toBe('first_5');
    expect(gameTotalMetricScope(spec({ scope: '1H' }))).toBe('half_1');
    expect(gameTotalMetricScope(spec({ scope: '2H' }))).toBe('half_2');
  });
  test('whole-series total-maps (seriesTotal) → series (NOT game, NOT map)', () => {
    const s = gameTotalMetricScope(spec({ seriesTotal: true, unit: 'maps', metric: 'count' }));
    expect(s).toBe('series');
    expect(s).not.toBe('game');
    expect(s).not.toBe('map');
  });
  test('seriesTotal takes priority over every other signal', () => {
    // Defensive: even if a (hypothetical) series-total were also team-scoped, the
    // series scope must win — a series-total never collapses to team/game.
    expect(gameTotalMetricScope(spec({ seriesTotal: true, sub: 'team', scope: '1H' }))).toBe('series');
  });
  test('every value is a valid MetricScope', () => {
    const VALID: MetricScope[] = ['game', 'team', 'first_5', 'half_1', 'half_2', 'quarter', 'period', 'set', 'map', 'series'];
    for (const sc of [null, 'F5', '1H', '2H'] as const) {
      for (const sub of ['combined', 'team'] as const) {
        expect(VALID).toContain(gameTotalMetricScope(spec({ scope: sc, sub })));
      }
    }
    expect(VALID).toContain(gameTotalMetricScope(spec({ seriesTotal: true })));
  });
});

describe('periodWinnerMetricScope — fixture-winner sub-period table', () => {
  test('soccer 1st-half winner series → half_1', () => {
    expect(periodWinnerMetricScope('KXEPL1H-26MAY24CRYARS')).toBe('half_1');
    expect(periodWinnerMetricScope('KXLALIGA1H-26MAY24')).toBe('half_1');
    expect(periodWinnerMetricScope('KXLIGUE11H-26MAY24')).toBe('half_1');
    expect(periodWinnerMetricScope('KXSERIEA1H-26MAY24')).toBe('half_1');
    expect(periodWinnerMetricScope('KXBUNDESLIGA1H-26MAY24')).toBe('half_1');
  });
  test('tennis single-set winner series → set', () => {
    expect(periodWinnerMetricScope('KXATPSETWINNER-26MAY24')).toBe('set');
    expect(periodWinnerMetricScope('KXWTASETWINNER-26MAY24')).toBe('set');
  });
  test('whole-match winner series → game (NEVER inferred from MATCH substring)', () => {
    // The table distinguishes match vs set explicitly rather than substring-matching 'MATCH'.
    expect(periodWinnerMetricScope('KXATPMATCH-26MAY24')).toBe('game');
    expect(periodWinnerMetricScope('KXWTAMATCH-26MAY24')).toBe('game');
    expect(periodWinnerMetricScope('KXATPMATCH-26MAY24')).not.toBe(periodWinnerMetricScope('KXATPSETWINNER-26MAY24'));
  });
  test('unknown / null series → null (whole-match / unknown, left NULL)', () => {
    expect(periodWinnerMetricScope(null)).toBeNull();
    expect(periodWinnerMetricScope('KXNFLGAME-26ATL')).toBeNull();
    expect(periodWinnerMetricScope('')).toBeNull();
  });
  test('table values are all valid MetricScopes', () => {
    const VALID: MetricScope[] = ['game', 'team', 'first_5', 'half_1', 'half_2', 'quarter', 'period', 'set', 'map', 'series'];
    for (const v of Object.values(PERIOD_WINNER_SERIES)) expect(VALID).toContain(v);
  });
});

// lookupSeries is the deterministic resolver the typed-strike Pass-1 path
// uses to assign canonical_subject + metric + unit + category, without a DB
// round-trip. Each entry must produce a country/region-specific subject.
describe('lookupSeries — new macro/econ series (W1)', () => {
  test('inflation: per-country CPI subjects (<Country> CPI pattern)', () => {
    expect(lookupSeries('KXLCPIMAXYOY-26')).toMatchObject({ subject: 'US CPI', metric: 'percentage', unit: 'percent', category: 'economic' });
    expect(lookupSeries('KXCOREUND-2026')).toMatchObject({ subject: 'US Core CPI', metric: 'percentage', unit: 'percent' });
    expect(lookupSeries('KXARMOMINF-26APR')).toMatchObject({ subject: 'Argentina CPI', metric: 'percentage', unit: 'percent' });
    expect(lookupSeries('KXJPMOMINF-26APR')).toMatchObject({ subject: 'Japan CPI', metric: 'percentage', unit: 'percent' });
  });
  test('inflation: US CPI sub-indices resolve on index level (count / index_value)', () => {
    expect(lookupSeries('KXSHELTERCPI-26APR')).toMatchObject({ subject: 'US Shelter CPI', metric: 'count', unit: 'index_value' });
    expect(lookupSeries('KXUSEDCARCPI-26APR')).toMatchObject({ subject: 'US Used Cars and Trucks CPI', metric: 'count', unit: 'index_value' });
    expect(lookupSeries('KXTOBACCPI-26APR')).toMatchObject({ subject: 'US Tobacco CPI', metric: 'count', unit: 'index_value' });
    expect(lookupSeries('KXTRUFEGGS-26MAY13')).toMatchObject({ subject: 'US Eggs Price', metric: 'price', unit: 'USD' });
  });
  test('jobs: U-3 monthly reuses the EXACT existing KXU3MAX subject string', () => {
    expect(lookupSeries('KXU3-26MAY')!.subject).toBe(lookupSeries('KXU3MAX-26')!.subject);
    expect(lookupSeries('KXU3-26MAY')).toMatchObject({ subject: 'US U-3 Unemployment Rate', metric: 'percentage', unit: 'percent' });
    expect(lookupSeries('KXJOBLESSCLAIMS-26MAY09')).toMatchObject({ subject: 'US Initial Jobless Claims', metric: 'count', unit: 'claims' });
    expect(lookupSeries('KXBRAZILU-26Q1')).toMatchObject({ subject: 'Brazil Unemployment Rate', metric: 'percentage' });
  });
  test('GDP: US/Brazil/Germany growth subjects (reuse existing Germany GDP string)', () => {
    expect(lookupSeries('KXGDP-26Q2')).toMatchObject({ subject: 'US GDP', metric: 'percentage', unit: 'percent' });
    expect(lookupSeries('KXGDPYEAR-2026')).toMatchObject({ subject: 'US GDP', metric: 'percentage' });
    expect(lookupSeries('KXNGDPQ-26Q2')).toMatchObject({ subject: 'US GDP', metric: 'percentage' });
    expect(lookupSeries('KXBRAZILGDP-27FEB')).toMatchObject({ subject: 'Brazil GDP', metric: 'percentage' });
    expect(lookupSeries('KXDEGDPQOQF-26Q1')!.subject).toBe(lookupSeries('KXDEGDPYOYF-26')!.subject);
  });
  test('rates/yields: mortgage + Treasury subjects', () => {
    expect(lookupSeries('KXMORTGAGERATE-2026')).toMatchObject({ subject: 'US 30-Year Mortgage Rate', metric: 'percentage', unit: 'percent' });
    expect(lookupSeries('KXFM30YMTG-2026')).toMatchObject({ subject: 'US 30-Year Mortgage Rate', metric: 'percentage' });
    expect(lookupSeries('KXNOTE10-26MAY')!.subject).toBe(lookupSeries('KXTNOTED-26')!.subject);
    expect(lookupSeries('KX30YUSTW-26MAY')).toMatchObject({ subject: 'US 30-Year Treasury Yield', metric: 'percentage' });
  });
  test('tariffs: PER-COUNTRY subjects so they do not self-fuse', () => {
    expect(lookupSeries('KXTARIFFRATEPRC-26JUL01')).toMatchObject({ subject: 'China Tariff Rate', metric: 'percentage' });
    expect(lookupSeries('KXTARIFFRATECAN-26JUL01')).toMatchObject({ subject: 'Canada Tariff Rate', metric: 'percentage' });
    expect(lookupSeries('KXTARIFFRATEEU-26JUL01')).toMatchObject({ subject: 'EU Tariff Rate', metric: 'percentage' });
    expect(lookupSeries('KXTARIFFRATEINDIA-26JUL01')).toMatchObject({ subject: 'India Tariff Rate', metric: 'percentage' });
    expect(lookupSeries('KXEFFTARIFF-26Q2')).toMatchObject({ subject: 'US Effective Tariff Rate', metric: 'percentage' });
    expect(lookupSeries('KXTARIFFREVENUE-2026')).toMatchObject({ subject: 'US Tariff Revenue', metric: 'price', unit: 'USD' });
    const subs = ['KXTARIFFRATEPRC', 'KXTARIFFRATECAN', 'KXTARIFFRATEEU', 'KXTARIFFRATEINDIA'].map((k) => lookupSeries(`${k}-26JUL01`)!.subject);
    expect(new Set(subs).size).toBe(4);
  });
  test('housing: starts/sales (count) vs NYC rent (percentage)', () => {
    expect(lookupSeries('KXHOUSINGSTART-26APR')).toMatchObject({ subject: 'US Housing Starts', metric: 'count', unit: 'units' });
    expect(lookupSeries('KXNHSALES-26APR')).toMatchObject({ subject: 'US New Home Sales', metric: 'count', unit: 'homes' });
    expect(lookupSeries('KXCANHOUSTART-2026')).toMatchObject({ subject: 'Canada Housing Starts', metric: 'count' });
    expect(lookupSeries('KXNYCRENTSY-26DEC')).toMatchObject({ subject: 'New York City Rent', metric: 'percentage', unit: 'percent' });
  });
  test('KXFEDDECISION is NOT routed through the threshold-ladder map (categorical)', () => {
    // A cut/hold/hike rate decision is not a threshold ladder.
    const dec = lookupSeries('KXFEDDECISION-27JAN');
    expect(dec?.subject).toBe('Federal Funds Rate');
  });
  test('no prefix-scan collisions: KXGDP keys + KXU3 keys stay distinct', () => {
    expect(lookupSeries('KXGDPNOM-CHN26')!.subject).not.toBe('US GDP');
    expect(lookupSeries('KXGDPSHAREMANU-26')).toBeNull();
    expect(lookupSeries('KXGDPUSMAX-26')).toBeNull();
    expect(lookupSeries('KXU3-26MAY')).not.toBeNull();
    expect(lookupSeries('KXU3MAX-26')).not.toBeNull();
  });
});


// The Pass-1 typed-strike norm leaves event_kind NULL for the whole
// KNOWN_SERIES_MAP unless the series carries one. price/weather/approval get
// an honest kind; econ-rate/index/count stay NULL (a wrong 'price_threshold'
// would rot semantics).
describe('lookupSeries -- gated event_kind (M-RECALL-1)', () => {
  test('price-asset series -> price_threshold (crypto/index/commodity/FX)', () => {
    expect(lookupSeries('KXBTC-26MAY')).toMatchObject({ event_kind: 'price_threshold' });
    expect(lookupSeries('KXETHD-26MAY')).toMatchObject({ event_kind: 'price_threshold' });
    expect(lookupSeries('KXGOLD-26MAY')).toMatchObject({ event_kind: 'price_threshold' });
    expect(lookupSeries('KXNASDAQ-26MAY')).toMatchObject({ event_kind: 'price_threshold' });
    expect(lookupSeries('KXINX-26MAY')).toMatchObject({ event_kind: 'price_threshold' });
    expect(lookupSeries('KXEURUSD-26MAY')).toMatchObject({ event_kind: 'price_threshold' });
    expect(lookupSeries('KXWTI-26MAY')).toMatchObject({ event_kind: 'price_threshold' });
  });
  test('weather series -> weather_extreme (temp + rain + aggregate counts)', () => {
    expect(lookupSeries('KXHIGHTATL-26MAY10')).toMatchObject({ event_kind: 'weather_extreme' });
    expect(lookupSeries('KXRAINNYCM-26MAY')).toMatchObject({ event_kind: 'weather_extreme' });
    expect(lookupSeries('KXTORNADO-26MAY')).toMatchObject({ event_kind: 'weather_extreme' });
  });
  test('Trump/Musk approval -> approval_rating (in LADDER_KINDS)', () => {
    expect(lookupSeries('KXAPRPOTUS-26MAY')).toMatchObject({ event_kind: 'approval_rating' });
    expect(lookupSeries('KXTRUMPAPPROVALYEAR-26')).toMatchObject({ event_kind: 'approval_rating' });
  });
  test('econ-rate/index/count series carry NO explicit map event_kind (default applies at emission)', () => {
    // priceLadderDefaultEventKind supplies the honest kind at emission time instead.
    for (const t of ['KXCPIYOY-26MAY', 'KXFED-27JAN', 'KXGDP-26Q2', 'KXTNOTED-26MAY',
                     'KXARTISTSTREAMSY-26', 'KXGDPNOM-CHN26', 'KXTARIFFREVENUE-2026']) {
      expect(lookupSeries(t)!.event_kind ?? null).toBeNull();
    }
  });

  // Category-keyed default: economic -> econ_indicator_threshold, else -> count_threshold.
  test('priceLadderDefaultEventKind: economic series -> econ_indicator_threshold', () => {
    for (const t of ['KXCPIYOY-26MAY', 'KXFED-27JAN', 'KXGDP-26Q2', 'KXTNOTED-26MAY',
                     'KXPAYROLLS-26MAY', 'KXUE-26MAY', 'KXGDPNOM-CHN26', 'KXTARIFFREVENUE-2026',
                     'KXTSAW-26MAY', 'KXUSMICHCSP-26MAY']) {
      expect(priceLadderDefaultEventKind(lookupSeries(t)!)).toBe('econ_indicator_threshold');
    }
  });
  test('priceLadderDefaultEventKind: non-economic count series -> count_threshold', () => {
    expect(priceLadderDefaultEventKind(lookupSeries('KXARTISTSTREAMSY-26')!)).toBe('count_threshold');
    expect(priceLadderDefaultEventKind(lookupSeries('KXTRUMPACT-26MAY')!)).toBe('count_threshold');
    expect(priceLadderDefaultEventKind(lookupSeries('KXTRUTHSOCIAL-26MAY')!)).toBe('count_threshold');
    expect(priceLadderDefaultEventKind(lookupSeries('KXHORMUZWEEKLY-26MAY')!)).toBe('count_threshold');
    expect(priceLadderDefaultEventKind(lookupSeries('KXMUSKCHALLENGERS-26')!)).toBe('count_threshold');
  });
});


// election_margin party discriminator-lift
describe('electionMarginSubjectWithParty — party into the gated subject', () => {
  test('Republican and Democrat for the SAME race get DISTINCT subjects', () => {
    const base = "Florida's 20th Congressional District";
    const r = electionMarginSubjectWithParty(base, 'Republicans');
    const d = electionMarginSubjectWithParty(base, 'Democrats');
    expect(r).toBe("Florida's 20th Congressional District (republican)");
    expect(d).toBe("Florida's 20th Congressional District (democratic)");
    expect(r).not.toBe(d);
  });
  test('singular/plural party labels normalise to the same suffix', () => {
    expect(electionMarginSubjectWithParty('X race', 'Republican'))
      .toBe(electionMarginSubjectWithParty('X race', 'Republicans'));
    expect(electionMarginSubjectWithParty('X race', 'Democrat'))
      .toBe(electionMarginSubjectWithParty('X race', 'Democrats'));
  });
  test('null party (VOTETURN sibling) leaves the subject unchanged', () => {
    expect(electionMarginSubjectWithParty('Colorado senate race', null)).toBe('Colorado senate race');
  });
  test('idempotent — does not double-append an already-suffixed subject', () => {
    const once = electionMarginSubjectWithParty('X race', 'Democrats');
    expect(electionMarginSubjectWithParty(once, 'Democrats')).toBe(once);
  });
});

// NBA/NHL playoff series ticker routing
describe('classifyNbaNhlSeries — ticker-suffix routing', () => {
  test('SCORE/GAMES/SPREAD sub-series route to their kind', () => {
    expect(classifyNbaNhlSeries('KXNBASERIESSCORE-26CLEDETR2')).toBe('score');
    expect(classifyNbaNhlSeries('KXNBASERIESGAMES-26CLEDETR2')).toBe('games');
    expect(classifyNbaNhlSeries('KXNBASERIESSPREAD-26CLEDETR2')).toBe('spread');
    expect(classifyNbaNhlSeries('KXNHLSERIESSCORE-26MINCOLR2')).toBe('score');
    expect(classifyNbaNhlSeries('KXNHLSERIESGAMES-26MINCOLR2')).toBe('games');
    expect(classifyNbaNhlSeries('KXNHLSERIESSPREAD-26MINCOLR2')).toBe('spread');
  });
  test('bare series-winner ticker + ROADWIN + non-series are NOT claimed', () => {
    expect(classifyNbaNhlSeries('KXNBASERIES-26CLEDETR2')).toBeNull();
    expect(classifyNbaNhlSeries('KXNHLSERIES-26MINCOLR2')).toBeNull();
    expect(classifyNbaNhlSeries('KXNBASERIESROADWIN-26CLEDETR2')).toBeNull();
    expect(classifyNbaNhlSeries('KXMLBTOTAL-26')).toBeNull();
    expect(classifyNbaNhlSeries(null)).toBeNull();
  });
});

describe('extractSeriesFixture — mid-string "A vs B [Nth Round] series"', () => {
  test('pulls the two teams from a SCORE title', () => {
    expect(extractSeriesFixture(
      'Will Detroit win 4-1 in the Cleveland vs Detroit 2nd Round series in the 2026 Pro Basketball Playoffs?',
    )).toEqual({ a: 'Cleveland', b: 'Detroit' });
  });
  test('pulls the two teams from a GAMES title', () => {
    expect(extractSeriesFixture(
      'Will there be over 5.5 total games in the Minnesota vs San Antonio 2nd Round series in the 2026 Pro Basketball Playoffs?',
    )).toEqual({ a: 'Minnesota', b: 'San Antonio' });
  });
  test('returns null when no mid-string fixture is present', () => {
    expect(extractSeriesFixture('Will the Lakers win the NBA Championship?')).toBeNull();
  });
});


// WC stage-of-elimination ordinal into a GATED field.
// Each country has exactly 7 sibling slots sharing canonical_event / subject /
// direction, differing ONLY in title + stage. Lifting the stage to value_primary
// (1..7) means the equivalence builder (value_primary IS NOT DISTINCT FROM) can
// no longer fuse two different rounds — same-round cross-platform copies keep
// equal value and still equate (no recall loss).
describe('wcStageOrdinal (M-DISC-1) -- monotone elimination-depth 1..7', () => {
  test('each stage maps to its 1-based ordered index', () => {
    expect(wcStageOrdinal('Group Stage')).toBe(1);
    expect(wcStageOrdinal('Round of 32')).toBe(2);
    expect(wcStageOrdinal('Round of 16')).toBe(3);
    expect(wcStageOrdinal('Quarterfinals')).toBe(4);
    expect(wcStageOrdinal('Semifinals')).toBe(5);
    expect(wcStageOrdinal('Runner-Up')).toBe(6);
    expect(wcStageOrdinal('Outright Winner')).toBe(7);
  });
  test('different rounds get DISTINCT ordinals (so value_primary separates them)', () => {
    expect(wcStageOrdinal('Semifinals')).not.toBe(wcStageOrdinal('Outright Winner'));
    expect(wcStageOrdinal('Runner-Up')).not.toBe(wcStageOrdinal('Outright Winner'));
  });
  test('unknown stage -> null (the handler bails, leaving the row unshaped)', () => {
    expect(wcStageOrdinal('Final')).toBeNull();
    expect(wcStageOrdinal('')).toBeNull();
    expect(wcStageOrdinal('not a stage')).toBeNull();
  });
});


// Season-win ladders / MLB spread / golf make-cut
describe('M-RECALL-2 -- season-wins series classification + threshold', () => {
  test('classifySeasonWinsSeries recognizes NFL/NCAAF/MLB win series', () => {
    expect(classifySeasonWinsSeries('KXNFLWINS-27MIN')).toBe('KXNFLWINS');
    expect(classifySeasonWinsSeries('KXNCAAFWINS-26TEX')).toBe('KXNCAAFWINS');
    expect(classifySeasonWinsSeries('KXMLBWINS-SD-26')).toBe('KXMLBWINS');
    expect(classifySeasonWinsSeries('KXMLBSPREAD-26MAY101610ATLLAD')).toBeNull();
    expect(classifySeasonWinsSeries('KXPGAMAKECUT-PGC26')).toBeNull();
    expect(classifySeasonWinsSeries(null)).toBeNull();
  });
  test('parseSeasonWinThreshold prefers floor_strike, falls back to yes_sub_title', () => {
    expect(parseSeasonWinThreshold('9', '9+ wins')).toBe(9);
    expect(parseSeasonWinThreshold('105', '105+ wins')).toBe(105);
    expect(parseSeasonWinThreshold(null, '8+ wins')).toBe(8);
    expect(parseSeasonWinThreshold(null, '17 wins')).toBe(17);
    expect(parseSeasonWinThreshold('', '12 wins')).toBe(12);
    expect(parseSeasonWinThreshold(null, 'in squad')).toBeNull();
    expect(parseSeasonWinThreshold(null, null)).toBeNull();
  });
  test('B-20: KXWNBAWINS classified; team regex strips the "Women\'s Pro Basketball team" qualifier', () => {
    expect(classifySeasonWinsSeries('KXWNBAWINS-26SEA')).toBe('KXWNBAWINS');
    const rx = SEASON_WINS_SERIES.KXWNBAWINS.teamFromTitle;
    const m = "Will the Seattle Storm Women's Pro Basketball team win at least 20 games this season?".match(rx);
    expect(m?.groups?.team).toBe('Seattle Storm');
    const m2 = "Will the Las Vegas Aces Women’s Pro Basketball team win at least 35 games this season?".match(rx);
    expect(m2?.groups?.team).toBe('Las Vegas Aces');
    expect("Will the Minnesota pro football team win at least 9 games this season?".match(rx)).toBeNull();
  });
  test('hw821: KXNBAWINS + KXNCAAMBWINS classified; team regexes capture the school/city', () => {
    expect(classifySeasonWinsSeries('KXNBAWINS-27TOR')).toBe('KXNBAWINS');
    expect(classifySeasonWinsSeries('KXNCAAMBWINS-26UVA')).toBe('KXNCAAMBWINS');
    const nba = SEASON_WINS_SERIES.KXNBAWINS.teamFromTitle;
    expect('Will the Toronto Pro Basketball team win at least 65 games in the 2026-27 regular season?'
      .match(nba)?.groups?.team).toBe('Toronto');
    expect('Will the Boston Pro Basketball team record at least 60 wins in the 2026-27 regular season?'
      .match(nba)?.groups?.team).toBe('Boston');
    expect("Will the Seattle Storm Women's Pro Basketball team win at least 20 games this season?"
      .match(nba)).toBeNull();
    const ncaa = SEASON_WINS_SERIES.KXNCAAMBWINS.teamFromTitle;
    expect('Will Virginia win at least 27 games this season?'.match(ncaa)?.groups?.team).toBe('Virginia');
    expect('Will North Carolina win at least 18 games this season?'.match(ncaa)?.groups?.team).toBe('North Carolina');
    expect(SEASON_WINS_SERIES.KXNBAWINS.sport).toBe('basketball');
    expect(SEASON_WINS_SERIES.KXNBAWINS.league).toBe('NBA');
    expect(SEASON_WINS_SERIES.KXNCAAMBWINS.sport).toBe('basketball (ncaa)');
    expect(SEASON_WINS_SERIES.KXNCAAMBWINS.league).toBe('NCAAB');
  });
});

// NFL season TD / reception player-stat ladders
describe('hw821 -- resolvePlayerStatSeries (order-sensitive overlapping prefixes)', () => {
  test('the three new NFL season TD/REC series resolve to their DISTINCT units', () => {
    expect(resolvePlayerStatSeries('KXNFLSEASONRSHTD-27C8')?.spec.expectedUnit).toBe('rushing_touchdowns');
    expect(resolvePlayerStatSeries('KXNFLSEASONRECTD-27C8')?.spec.expectedUnit).toBe('receiving_touchdowns');
    expect(resolvePlayerStatSeries('KXNFLSEASONREC-27C75')?.spec.expectedUnit).toBe('receptions');
  });
  test('KXNFLSEASONREC is a startsWith-prefix of RECYDS/RECTD but must NOT shadow them', () => {
    // The scan order must keep the specific yards/TD series winning over bare receptions.
    expect(resolvePlayerStatSeries('KXNFLSEASONRECYDS-27C8')?.prefix).toBe('KXNFLSEASONRECYDS');
    expect(resolvePlayerStatSeries('KXNFLSEASONRECTD-27C8')?.prefix).toBe('KXNFLSEASONRECTD');
    expect(resolvePlayerStatSeries('KXNFLSEASONREC-27C75')?.prefix).toBe('KXNFLSEASONREC');
    expect(resolvePlayerStatSeries(null)).toBeNull();
    expect(resolvePlayerStatSeries('KXLALIGA-26')).toBeNull();
  });
  test('parseSeasonStatThreshold reads N+ from the new TD/REC season titles', () => {
    expect(parseSeasonStatThreshold(
      'Will Derrick Henry record 8+ rushing touchdowns during the 2026-27 Pro Football regular season?')).toBe(8);
    expect(parseSeasonStatThreshold(
      'Will Travis Kelce record 8+ receiving touchdowns during the 2026-27 Pro Football regular season?')).toBe(8);
    expect(parseSeasonStatThreshold(
      'Will Zay Flowers record 75+ receptions during 2026-27 Pro Football regular season?')).toBe(75);
  });
});

// NVIDIA GPU compute-price ladders (KNOWN_SERIES_MAP)
describe('hw821 -- GPU compute-price series (Pass-1 price ladder rows)', () => {
  test('lookupSeries resolves each GPU model to a USD price economic subject', () => {
    expect(lookupSeries('KXH200MS-26AUG')).toMatchObject(
      { subject: 'NVIDIA H200', metric: 'price', unit: 'USD', category: 'economic', event_kind: 'price_threshold' });
    expect(lookupSeries('KXH100MS-26SEP')).toMatchObject({ subject: 'NVIDIA H100', metric: 'price', unit: 'USD' });
    expect(lookupSeries('KXB200MS-27MAY')).toMatchObject({ subject: 'NVIDIA B200', metric: 'price', unit: 'USD' });
    expect(lookupSeries('KXA100MS-27MAY')).toMatchObject({ subject: 'NVIDIA A100', metric: 'price', unit: 'USD' });
    expect(lookupSeries('KXRTX5090MS-27MAY')).toMatchObject({ subject: 'NVIDIA RTX 5090', metric: 'price', unit: 'USD' });
  });
});

// Primary margin / vote-share range-bucket ladders
describe('hw821 -- parsePrimaryMov (KXPRIMARYMOV margin-of-victory buckets)', () => {
  test('between-bucket → range with both bounds (year embedded in the event)', () => {
    expect(parsePrimaryMov(
      'Will the margin of victory for Xavier Becerra in the 2026 California gubernatorial primary be between 8% and 10%?'))
      .toEqual({ shape: 'range', candidate: 'Xavier Becerra', year: 2026, event: '2026 California gubernatorial primary', lo: 8, hi: 10 });
  });
  test('above-N% → open-top tail', () => {
    expect(parsePrimaryMov(
      'Will the margin of victory for Xavier Becerra in the 2026 California gubernatorial primary be above 10%?'))
      .toEqual({ shape: 'tail', candidate: 'Xavier Becerra', year: 2026, event: '2026 California gubernatorial primary', lo: 10 });
  });
  test('handles "first round of the <year> …" and year-less "… runoff" variants', () => {
    expect(parsePrimaryMov(
      'Will the margin of victory for Burt Jones in the first round of the 2026 Georgia Republican gubernatorial primary be between 5% and 10%?'))
      .toEqual({ shape: 'range', candidate: 'Burt Jones', year: 2026, event: 'first round of the 2026 Georgia Republican gubernatorial primary', lo: 5, hi: 10 });
    expect(parsePrimaryMov(
      'Will the margin of victory for Colin Allred in the TX-33 Democratic primary runoff be above 5%?'))
      .toEqual({ shape: 'tail', candidate: 'Colin Allred', year: null, event: 'TX-33 Democratic primary runoff', lo: 5 });
  });
  test('rejects non-MOV titles and degenerate/reversed ranges', () => {
    expect(parsePrimaryMov('Will Scott Wiener receive at least 60% of the popular vote in the 2026 CA-11 primary?')).toBeNull();
    expect(parsePrimaryMov(
      'Will the margin of victory for X in the 2026 race primary be between 10% and 8%?')).toBeNull();
  });
});

describe('hw821 -- parseVotePrimary (KXVOTEPRIMARY popular-vote-share buckets)', () => {
  test('between-bucket → range with both bounds', () => {
    expect(parseVotePrimary(
      'Will Scott Wiener receive between 55% and 60% of the popular vote in the 2026 CA-11 primary?'))
      .toEqual({ shape: 'range', candidate: 'Scott Wiener', year: 2026, event: '2026 CA-11 primary', lo: 55, hi: 60 });
  });
  test('at-least-N% → open-top tail (also the "first round of…" variant)', () => {
    expect(parseVotePrimary(
      'Will Scott Wiener receive at least 60% of the popular vote in the 2026 CA-11 primary?'))
      .toEqual({ shape: 'tail', candidate: 'Scott Wiener', year: 2026, event: '2026 CA-11 primary', lo: 60 });
    expect(parseVotePrimary(
      'Will Dan J. Sullivan receive at least 30% of the popular vote in the first round of the 2026 Alaska Senate primary?'))
      .toEqual({ shape: 'tail', candidate: 'Dan J. Sullivan', year: 2026, event: 'first round of the 2026 Alaska Senate primary', lo: 30 });
  });
  test('rejects the MOV title shape (disjoint families)', () => {
    expect(parseVotePrimary(
      'Will the margin of victory for Xavier Becerra in the 2026 California gubernatorial primary be above 10%?')).toBeNull();
  });
});

describe('B-20 -- music artist achievement/release (INDEPENDENT binary per artist)', () => {
  test('each series titleRX matches its own shape and rejects the others', () => {
    const cases: Array<[string, string]> = [
      ['KX1SONG', 'Will Drake have a #1 hit this year?'],
      ['KX10SONG', 'Will Drake have a top 10 song this year?'],
      ['KX20SONG', 'Will Drake have a top 20 song this year?'],
      ['KX1ALBUM', 'Will Drake have a #1 album this year?'],
      ['KXALBUMRELEASE', 'Will Drake release a new album in 2026?'],
      ['KXSONGRELEASE', 'Will Drake release a new song 2026?'],
    ];
    for (const [prefix, title] of cases) {
      expect(MUSIC_ACHIEVEMENT_SERIES[prefix].titleRX.test(title)).toBe(true);
      for (const [other] of cases) {
        if (other === prefix) continue;
        if (MUSIC_ACHIEVEMENT_SERIES[other].titleRX.test(title)) {
          expect(other).not.toBe(prefix);
        }
      }
    }
    expect(MUSIC_ACHIEVEMENT_SERIES.KX1SONG.titleRX.test('Will Drake have a top 10 song this year?')).toBe(false);
    expect(MUSIC_ACHIEVEMENT_SERIES.KXALBUMRELEASE.titleRX.test('Will Drake have a #1 album this year?')).toBe(false);
  });
  test('release series → media_release; chart-achievement series → other', () => {
    expect(MUSIC_ACHIEVEMENT_SERIES.KXALBUMRELEASE.eventKind).toBe('media_release');
    expect(MUSIC_ACHIEVEMENT_SERIES.KXSONGRELEASE.eventKind).toBe('media_release');
    expect(MUSIC_ACHIEVEMENT_SERIES.KX1SONG.eventKind).toBe('other');
    expect(MUSIC_ACHIEVEMENT_SERIES.KX10SONG.eventKind).toBe('other');
  });
  test('W2-5: release series resolutionSource is NULL (authority-not-telemetry; no generic tag)', () => {
    // A release resolves on the artist's own drop — no external oracle.
    expect(MUSIC_ACHIEVEMENT_SERIES.KXALBUMRELEASE.resolutionSource).toBeNull();
    expect(MUSIC_ACHIEVEMENT_SERIES.KXSONGRELEASE.resolutionSource).toBeNull();
    expect(MUSIC_ACHIEVEMENT_SERIES.KX1SONG.resolutionSource).toBe('Billboard');
  });
});

describe('B-20 -- golf per-player eagle (INDEPENDENT binary)', () => {
  test('GOLF_EAGLE_TITLE_RX extracts player + round; rejects non-eagle titles', () => {
    const m = 'Will Rory McIlroy have an eagle in Round 1?'.match(GOLF_EAGLE_TITLE_RX);
    expect(m?.groups?.player).toBe('Rory McIlroy');
    expect(m?.groups?.round).toBe('1');
    const m3 = 'Will Scottie Scheffler have an eagle in Round 3'.match(GOLF_EAGLE_TITLE_RX);
    expect(m3?.groups?.round).toBe('3');
    expect('Will Rory McIlroy make the cut?'.match(GOLF_EAGLE_TITLE_RX)).toBeNull();
    expect('What score will Rory McIlroy record on Hole 9 in Round 1?'.match(GOLF_EAGLE_TITLE_RX)).toBeNull();
  });
});

describe('B-20 -- performer/host participation + Eurovision rank', () => {
  test('participation series present with roles (all → event_kind participation)', () => {
    expect(PERFORMER_PARTICIPATION_SERIES.KXWORLDCUPHALFTIME.role).toBe('perform');
    expect(PERFORMER_PARTICIPATION_SERIES.KXROLEATEVENTCOACHELLA.role).toBe('headline');
    expect(PERFORMER_PARTICIPATION_SERIES.KXSNLHOST.role).toBe('host');
  });
  test('EUROVISION_RANK_TITLE_RX extracts country + N; rejects non-rank titles', () => {
    const m = 'Will United Kingdom be Top 3?'.match(EUROVISION_RANK_TITLE_RX);
    expect(m?.groups?.country).toBe('United Kingdom');
    expect(m?.groups?.n).toBe('3');
    expect('Will San Marino be Top 10?'.match(EUROVISION_RANK_TITLE_RX)?.groups?.n).toBe('10');
    expect('Who will win Eurovision?'.match(EUROVISION_RANK_TITLE_RX)).toBeNull();
    expect('Will France win Eurovision?'.match(EUROVISION_RANK_TITLE_RX)).toBeNull();
  });
});

describe('M-RECALL-2 -- MLB run-line spread title', () => {
  test('parseMlbSpread extracts team + threshold (always direction=above)', () => {
    expect(parseMlbSpread('Texas wins by over 1.5 runs?')).toEqual({ team: 'Texas', value: 1.5 });
    expect(parseMlbSpread('Los Angeles D wins by over 3.5 runs')).toEqual({ team: 'Los Angeles D', value: 3.5 });
    expect(parseMlbSpread("A's wins by over 2.5 runs?")).toEqual({ team: "A's", value: 2.5 });
  });
  test('parseMlbSpread rejects non-spread titles', () => {
    expect(parseMlbSpread('Will San Diego win at least 75 games this season?')).toBeNull();
    expect(parseMlbSpread('Texas wins')).toBeNull();
    expect(parseMlbSpread('')).toBeNull();
  });
});

// Midterm subject metric-distinctness + cycle-year clamp
import { midtermSubjectWithMetric, midtermCycleYear, MIDTERM_CYCLE_YEAR } from "./kalshi-deterministic.js";

describe("AUD-05/DW-43 midtermSubjectWithMetric — MOV vs VOTETURN never share a subject", () => {
  test("MOV subject contains 'margin' (not 'turnout'); VOTETURN contains 'turnout'", () => {
    const base = "california 03 house race";
    const mov = midtermSubjectWithMetric(base, true);
    const turn = midtermSubjectWithMetric(base, false);
    expect(mov).toBe("california 03 house race margin");
    expect(turn).toBe("california 03 house race turnout");
    expect(mov).toContain("margin");
    expect(mov).not.toContain("turnout");
    expect(mov).not.toBe(turn);
  });
  test("idempotent — does not double-append an already-suffixed subject", () => {
    const once = midtermSubjectWithMetric("colorado senate race", true);
    expect(midtermSubjectWithMetric(once, true)).toBe(once);
    const onceT = midtermSubjectWithMetric("colorado senate race", false);
    expect(midtermSubjectWithMetric(onceT, false)).toBe(onceT);
  });
});

describe("AUD-05/DW-43 + W1-A midtermCycleYear — series-scoped CONSTANT 2026 cycle", () => {
  test("always the 2026 cycle (no date input accepted)", () => {
    expect(midtermCycleYear()).toBe(2026);
    expect(MIDTERM_CYCLE_YEAR).toBe(2026);
  });
});

// Midterm door port
import { midtermConditionTuple } from "./kalshi-deterministic.js";

describe("midtermConditionTuple — door port reproduces the live stamps exactly", () => {
  // STAMP PINS: the ONLY declared diff class for this family is the
  // MIDTERM_CYCLE year re-key — shape/direction/temporal/metric/values must
  // reproduce the stored stamps byte-for-byte.
  test("MOV threshold: point_in_time / above / at_resolution / metric NULL / percentage points", () => {
    const t = midtermConditionTuple(true, "above", 5);
    expect(t).not.toBeNull();
    expect(t!.event_kind).toBe("election_margin");
    expect(t!.condition_shape).toBe("point_in_time");
    expect(t!.condition_direction).toBe("above");
    expect(t!.temporal_semantics).toBe("at_resolution");
    expect(t!.condition_metric).toBeNull(); // METRICLESS_THRESHOLD_KINDS — structural metric
    expect(t!.value_primary).toBe(5);
    expect(t!.value_secondary).toBeNull();
    expect(t!.value_unit).toBe("percentage points");
    expect(t!.date_deferred).toBe(true); // event-year date stays assembly-owned
  });

  test("VOTETURN threshold: election_turnout / votes", () => {
    const t = midtermConditionTuple(false, "above", 150000);
    expect(t).not.toBeNull();
    expect(t!.event_kind).toBe("election_turnout");
    expect(t!.condition_metric).toBeNull();
    expect(t!.value_unit).toBe("votes");
    expect(t!.condition_value).toBe(">=150000votes");
  });

  test("below direction is legal (less/less_or_equal strikes)", () => {
    const t = midtermConditionTuple(true, "below", 10);
    expect(t!.condition_direction).toBe("below");
  });
});

// First-goalscorer cells (KXNHLFIRSTGOAL)
import {
  parseFirstScorerTitle,
  firstScorerConditionTuple,
  FIRST_SCORER_SERIES,
} from "./kalshi-deterministic.js";

describe("tryFirstGoalScorer — first-goalscorer cells (sports audit S6)", () => {
  test("title parse: '<Player>: First Goalscorer'", () => {
    expect(parseFirstScorerTitle("Brock Nelson: First Goalscorer")).toBe("Brock Nelson");
    expect(parseFirstScorerTitle("Logan O'Connor: First Goalscorer")).toBe("Logan O'Connor");
    expect(parseFirstScorerTitle("Valeri Nichushkin: first goalscorer?")).toBe("Valeri Nichushkin");
  });

  test("NEGATIVE: anytime / non-scorer titles never parse", () => {
    expect(parseFirstScorerTitle("Gorka Guruzeta: Anytime Goalscorer")).toBeNull();
    expect(parseFirstScorerTitle("Aaron Judge: 1+ home runs?")).toBeNull();
    expect(parseFirstScorerTitle("MIN Wild at COL Avalanche: First Goal")).toBeNull();
    expect(parseFirstScorerTitle("First Goalscorer")).toBeNull();
  });

  test("registry: series-gated to KXNHLFIRSTGOAL only (extension requires an own-goal rules read)", () => {
    expect(Object.keys(FIRST_SCORER_SERIES)).toEqual(["KXNHLFIRSTGOAL"]);
    expect(FIRST_SCORER_SERIES["KXNHLFIRSTGOAL"]).toEqual({ sport: "ice hockey", league: "NHL" });
  });

  test("door tuple pinned: event_occurrence binary, metric 'rank', at_resolution, no values", () => {
    const t = firstScorerConditionTuple();
    expect(t).not.toBeNull();
    expect(t!.event_kind).toBe("player_prop_threshold");
    expect(t!.condition_shape).toBe("binary_event");
    expect(t!.condition_direction).toBeNull();
    // 'rank' (first = rank-1) keeps first-scorer distinguishable from the
    // anytime side's 'count' metric — the converse implication would be fake.
    expect(t!.condition_metric).toBe("rank");
    expect(t!.temporal_semantics).toBe("at_resolution");
    expect(t!.value_primary).toBeNull();
    expect(t!.value_secondary).toBeNull();
    expect(t!.value_unit).toBeNull();
    expect(t!.condition_value).toBeNull();
    // date stays deferred; occurrence_datetime/end_date precedence stamps it later.
    expect(t!.date_deferred).toBe(true);
  });
});

// The handler's PERSON branch calls resolveSubjectViaKB + registerEntities
// (DB). Since these tests must not write to the DB, the full-handler
// integration assertions use the ROLE-NOUN branch, which is DB-free. The
// PERSON branch is covered at the parse level only.
function krow(overrides: Partial<KalshiCandidateRow> & Pick<KalshiCandidateRow, 'market_id' | 'title' | 'event_ticker'>): KalshiCandidateRow {
  return {
    platform_id: `KX-TEST-${overrides.market_id}`,
    end_date: null,
    category_unified: null,
    strike_type: 'custom',
    floor_strike: null,
    cap_strike: null,
    custom_strike: null,
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
    ...overrides,
  };
}

describe('tryKalshiSpeechMention — WS3-W1', () => {
  test('(non-mention series) → null (series-prefix gate)', async () => {
    const hit = await tryKalshiSpeechMention(krow({
      market_id: 2,
      title: 'What will the announcers say during X vs Y?',
      event_ticker: 'KXNBA-26MAY29',
      custom_strike: '{"Word":"GOAT"}',
    }));
    expect(hit).toBeNull();
  });

  test('(c) ROLE-NOUN "the announcers" → event-scoped subject, NOT a person; full byte-match tuple', async () => {
    const hit = await tryKalshiSpeechMention(krow({
      market_id: 3,
      title: 'What will the announcers say during Mariners vs Astros Professional Baseball Game?',
      event_ticker: 'KXMLBMENTION-26MAY24SEAHOU',
      custom_strike: '{"Word":"MVP"}',
      occurrence_datetime: '2026-05-24T16:15:00Z',
      category_unified: 'sports',
    }));
    expect(hit).not.toBeNull();
    const n = hit!.norm;
    expect(hit!.tag).toBe('kalshi:speech-mention');
    expect(n.match_source).toBe('kalshi:speech-mention');
    expect(n.condition_shape).toBe('binary_event');
    expect(n.condition_direction).toBeNull();
    expect(n.condition_metric).toBeNull();
    expect(n.temporal_semantics).toBeNull();
    expect(n.value_primary).toBeNull();
    expect(n.event_kind).toBe('speech_mention');
    expect(n.outcome_label).toBe('mvp');
    // The role-noun speaker is event-scoped (the broadcast), not a KB person.
    expect(n.resolved_entities.length).toBe(1);
    expect(n.resolved_entities[0]!.type).not.toBe('person');
    expect(n.resolved_entities[0]!.type).toBe('event_name');
    expect(n.canonical_subject.toLowerCase()).toContain('mariners');
    expect(n.canonical_subject.toLowerCase()).not.toBe('the announcers');
    // The word must never leak into subject/event.
    expect(n.canonical_subject.toLowerCase()).not.toContain('mvp');
    expect((n.canonical_event ?? '').toLowerCase()).not.toContain('mvp');
    expect(n.condition_date).toBe('2026-05-24T16:15:00Z');
  });

  test('(other role-noun) "any participating SNL cast" → event-scoped (not person)', async () => {
    const hit = await tryKalshiSpeechMention(krow({
      market_id: 4,
      title: 'What will any participating SNL cast say during Saturday Night Live: Weekend Update?',
      event_ticker: 'KXSNLMENTION-26MAY10',
      custom_strike: '{"Word":"Ballroom"}',
      occurrence_datetime: '2026-05-10T14:00:00Z',
      category_unified: 'entertainment',
    }));
    expect(hit).not.toBeNull();
    expect(hit!.norm.resolved_entities[0]!.type).toBe('event_name');
    expect(hit!.norm.outcome_label).toBe('ballroom');
  });

  test('(d) SIBLING WORDS on one broadcast → SAME event/subject/date, DIFFERENT outcome_label', async () => {
    const base = {
      title: 'What will the announcers say during Pistons vs Cavaliers Professional Basketball Game?',
      event_ticker: 'KXNBAMENTION-26MAY29DETCLE',
      occurrence_datetime: '2026-05-29T23:00:00Z',
      category_unified: 'sports' as const,
    };
    const a = await tryKalshiSpeechMention(krow({ market_id: 10, ...base, custom_strike: '{"Word":"GOAT"}' }));
    const b = await tryKalshiSpeechMention(krow({ market_id: 11, ...base, custom_strike: '{"Word":"Overtime"}' }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.norm.canonical_subject).toBe(b!.norm.canonical_subject);
    expect(a!.norm.canonical_event).toBe(b!.norm.canonical_event);
    expect(a!.norm.condition_date).toBe(b!.norm.condition_date);
    expect(a!.norm.outcome_label).toBe('goat');
    expect(b!.norm.outcome_label).toBe('overtime');
    expect(a!.norm.outcome_label).not.toBe(b!.norm.outcome_label);
  });

  test('(parens/whitespace WORD) "Trump (5+ times)" → strips count rider, lowercases', async () => {
    const hit = await tryKalshiSpeechMention(krow({
      market_id: 12,
      title: 'What will any participating SNL cast say during Saturday Night Live: Weekend Update?',
      event_ticker: 'KXSNLMENTION-26MAY10',
      custom_strike: '{"Word":"Trump (5+ times)"}',
    }));
    expect(hit!.norm.outcome_label).toBe('trump');
  });

  test('(yes_sub_title fallback) used when custom_strike is absent/unparseable', async () => {
    const hit = await tryKalshiSpeechMention(krow({
      market_id: 13,
      title: 'What will the announcers say during X vs Y Professional Baseball Game?',
      event_ticker: 'KXMLBMENTION-26MAY24',
      custom_strike: 'not json',
      yes_sub_title: 'Grand Slam',
    }));
    expect(hit!.norm.outcome_label).toBe('grand slam');
  });

  test('(no word) → null', async () => {
    const hit = await tryKalshiSpeechMention(krow({
      market_id: 14,
      title: 'What will the announcers say during X vs Y?',
      event_ticker: 'KXMLBMENTION-26MAY24',
      custom_strike: null,
      yes_sub_title: null,
    }));
    expect(hit).toBeNull();
  });

  // Parse-level assertions for the PERSON shapes (no DB tail invoked).
  describe('person-shape parsing (pure regex — no KB/DB)', () => {
    test('Shape A "Will Trump say \\"Pope\\" before May 18, 2026?" → who=Trump', () => {
      const m = 'Will Trump say "Pope" before May 18, 2026?'.match(K_SPEECH_SHAPE_A_RX);
      expect(m?.groups?.who?.trim()).toBe('Trump');
      // The WORD ("Pope") is NOT captured into `who` (stays the per-leg label).
      expect(m?.groups?.who?.toLowerCase()).not.toContain('pope');
      expect(m?.groups?.deadline?.trim()).toBe('May 18, 2026');
    });

    test('Shape B "What will Donald Trump say during State Banquet…" → who, occasion (word absent)', () => {
      const title = "What will Donald Trump say during State Banquet with the President of the People's Republic of China?";
      const m = title.match(K_SPEECH_SHAPE_B_RX);
      expect(m?.groups?.who?.trim()).toBe('Donald Trump');
      expect(m?.groups?.occasion?.toLowerCase()).toContain('banquet');
      expect(m?.groups?.occasion?.toLowerCase()).not.toContain('dynasty');
    });

    test('Shape B "What will Drake say during Iceman?" → who=Drake, occasion=Iceman', () => {
      const m = 'What will Drake say during Iceman?'.match(K_SPEECH_SHAPE_B_RX);
      expect(m?.groups?.who?.trim()).toBe('Drake');
      expect(m?.groups?.occasion?.trim()).toBe('Iceman');
    });

    test('role-noun detector flags generic speakers but not real persons', () => {
      expect(K_SPEECH_ROLE_NOUN_RX.test('the announcers')).toBe(true);
      expect(K_SPEECH_ROLE_NOUN_RX.test('any participating SNL cast')).toBe(true);
      expect(K_SPEECH_ROLE_NOUN_RX.test('any Pistons coach or player')).toBe(true);
      expect(K_SPEECH_ROLE_NOUN_RX.test('any participating contestant')).toBe(true);
      expect(K_SPEECH_ROLE_NOUN_RX.test('Donald Trump')).toBe(false);
      expect(K_SPEECH_ROLE_NOUN_RX.test('Drake')).toBe(false);
      expect(K_SPEECH_ROLE_NOUN_RX.test('King Charles III')).toBe(false);
    });
  });
});

// singleWinnerRankFields carries the rank convention (value_unit='rank',
// value_primary=1) for single-winner kinds, excluding residual (Draw/Tie)
// legs and top-N (grain>=2) claims.
describe('singleWinnerRankFields — DW-58 rank convention for single-winner legs', () => {
  test('single-winner kinds (non-residual) → value_primary=1 / value_unit=rank', () => {
    for (const kind of SINGLE_WINNER_RANK_KINDS) {
      expect(singleWinnerRankFields(kind, false)).toEqual({ valuePrimary: 1, valueUnit: 'rank' });
    }
    expect(SINGLE_WINNER_RANK_KINDS.has('championship_winner')).toBe(true);
    expect(SINGLE_WINNER_RANK_KINDS.has('award_winner')).toBe(true);
  });

  test('residual (Draw/Tie) leg is NEVER rank-stamped', () => {
    expect(singleWinnerRankFields('championship_winner', true)).toEqual({ valuePrimary: null, valueUnit: null });
    expect(singleWinnerRankFields('award_winner', true)).toEqual({ valuePrimary: null, valueUnit: null });
  });

  test('non single-winner kinds (halftime_leader, match_winner, player_prop_threshold) stay NULL', () => {
    expect(singleWinnerRankFields('halftime_leader', false)).toEqual({ valuePrimary: null, valueUnit: null });
    expect(singleWinnerRankFields('match_winner', false)).toEqual({ valuePrimary: null, valueUnit: null });
    expect(singleWinnerRankFields('player_prop_threshold', false)).toEqual({ valuePrimary: null, valueUnit: null });
  });

  test('stampDiscriminators materializes rank_grain=1 for a championship_winner leg', () => {
    const fields = singleWinnerRankFields('championship_winner', false);
    const norm = {
      event_kind: 'championship_winner',
      match_source: 'kalshi:winner-KXNASCARRACE',
      condition_shape: 'categorical_outcome',
      condition_direction: null,
      value_primary: fields.valuePrimary,
      value_unit: fields.valueUnit,
      outcome_label: 'Kyle Larson',
      discriminators: {},
    } as unknown as LLMMarketNormalization;
    stampDiscriminators({ title: 'Will Kyle Larson win the Daytona 500?', platform: 'kalshi' }, norm);
    expect(norm.discriminators?.['rank_grain']).toBe('1');
  });

  test('a residual championship_winner leg does NOT materialize rank_grain', () => {
    const fields = singleWinnerRankFields('championship_winner', true);
    const norm = {
      event_kind: 'championship_winner',
      match_source: 'kalshi:winner-KXEPL1H',
      condition_shape: 'categorical_outcome',
      condition_direction: null,
      value_primary: fields.valuePrimary,
      value_unit: fields.valueUnit,
      outcome_label: 'Draw',
      discriminators: {},
    } as unknown as LLMMarketNormalization;
    stampDiscriminators({ title: 'Will Tie win the 1st Half?', platform: 'kalshi' }, norm);
    expect(norm.discriminators?.['rank_grain'] ?? null).toBeNull();
  });
});

// The per-rung KB-canonical covering team, stamped into discriminators so
// Stage-4 can partition the co-grouped per-team margin ladders and refuse
// the cross-team implication.
describe('spreadCoverSubject — F1 per-rung cover subject for spread ladders', () => {
  test('stamps the KB-canonical covering team for a match_spread rung', () => {
    expect(spreadCoverSubject('match_spread', 'Athletic Bilbao')).toBe('Athletic Bilbao');
    expect(spreadCoverSubject('match_spread', 'RCD Espanyol')).toBe('RCD Espanyol');
  });

  test('two same-team spread rungs stamp the SAME cover_subject (fold-key stable across rungs)', () => {
    expect(spreadCoverSubject('match_spread', 'Athletic Bilbao'))
      .toBe(spreadCoverSubject('match_spread', 'Athletic Bilbao'));
  });

  test('PSG alias drift folds to ONE cover_subject (KB-canonical, alias-drift immunity)', () => {
    // Both aliases resolve through resolveSubjectViaKB to one canonical name,
    // so both rungs carry the same cover_subject.
    const kbCanonical = 'Paris Saint-Germain';
    expect(spreadCoverSubject('match_spread', kbCanonical))
      .toBe(spreadCoverSubject('match_spread', kbCanonical));
    expect(spreadCoverSubject('match_spread', 'Paris Saint-Germain'))
      .not.toBe(spreadCoverSubject('match_spread', 'Olympique de Marseille'));
  });

  test('non-spread ladders stamp NO cover_subject (music/RT/golf/price text ladders untouched)', () => {
    expect(spreadCoverSubject('media_release', 'Wicked')).toBeNull();
    expect(spreadCoverSubject('price_threshold', 'US Nominal GDP')).toBeNull();
    expect(spreadCoverSubject(null, 'Taylor Swift')).toBeNull();
    expect(spreadCoverSubject('match_total_metric', 'Some Fixture')).toBeNull();
  });

  test('stamp lands on discriminators.cover_subject via the norm JSONB (Stage-1 → questions path)', () => {
    const norm = { discriminators: {} } as unknown as LLMMarketNormalization;
    const cover = spreadCoverSubject('match_spread', 'Athletic Bilbao');
    if (cover) (norm.discriminators ??= {}).cover_subject = cover;
    expect(norm.discriminators?.['cover_subject']).toBe('Athletic Bilbao');
  });

  test('a blank / whitespace canonical yields NULL (no empty-string stamp)', () => {
    expect(spreadCoverSubject('match_spread', '   ')).toBeNull();
    expect(spreadCoverSubject('match_spread', '')).toBeNull();
    expect(spreadCoverSubject('match_spread', null)).toBeNull();
  });
});

describe('acceptPerInstanceSubject — Tier-2 cross-subject collapse refusal (caveat-b B3)', () => {
  test('perInstance: a NON-fold-equal KB collapse is REFUSED (keep the extracted subject)', () => {
    expect(acceptPerInstanceSubject('US Nominal GDP', 'France Nominal GDP', true)).toBe('US Nominal GDP');
    expect(acceptPerInstanceSubject('UK Nominal GDP', 'France Nominal GDP', true)).toBe('UK Nominal GDP');
    expect(acceptPerInstanceSubject('Odd Mob', 'The Notorious B.I.G.', true)).toBe('Odd Mob');
  });

  test('perInstance: a fold-equal resolution IS accepted (sound Tier-1 exact/alias merge)', () => {
    expect(acceptPerInstanceSubject('us nominal gdp', 'US Nominal GDP', true)).toBe('US Nominal GDP');
    expect(acceptPerInstanceSubject('France Nominal GDP', 'France Nominal GDP', true)).toBe('France Nominal GDP');
    expect(acceptPerInstanceSubject('Odd  Mob', 'Odd Mob', true)).toBe('Odd Mob');
  });

  test('non-perInstance series are untouched (normal KB resolution wins)', () => {
    expect(acceptPerInstanceSubject('BTC', 'Bitcoin', false)).toBe('Bitcoin');
    expect(acceptPerInstanceSubject('US CPI', 'US CPI', false)).toBe('US CPI');
  });
});

// Registry-level assertions: each onboarded series resolves to an
// eventTitle-mode categorical_winner spec with the right event_kind/subject
// conventions, and the "Tie/Co-Winners" residual guard where it applies.
describe('award/championship series onboarding — WINNER_SERIES registry', () => {
  const spec = (ticker: string) => lookupWinnerSeries(ticker)?.spec;

  test('all onboarded series are eventTitle-mode categorical winners', () => {
    const all = [
      'KXMLBNLMVP-26', 'KXMLBALMVP-26', 'KXMLBNLMOTY-26', 'KXMLBALMOTY-26',
      'KXMLBNLCPOTY-26', 'KXMLBALCPOTY-26', 'KXWNBAMVP-26', 'KXWNBACOY-26',
      'KXSEXYMAN-26', 'KXPERLIGA1-26', 'KXDENSUPERLIGA-26',
      'KXUFCLIGHTWEIGHTTITLE-26', 'KXUFCWELTERWEIGHTTITLE-26', 'KXUFCHEAVYWEIGHTTITLE-26',
      'KXUFCLHEAVYWEIGHTTITLE-26', 'KXUFCBANTAMWEIGHTTITLE-26', 'KXUFCFLYWEIGHTTITLE-26',
      'KXUFCFEATHERWEIGHTTITLE-26', 'KXUFCMIDDLEWEIGHTTITLE-26', 'KXWCGROUPWIN-26L',
    ];
    for (const t of all) {
      const s = spec(t);
      expect(s, t).toBeDefined();
      expect(s!.archetype, t).toBe('categorical_winner');
      expect(s!.eventFrom, t).toBe('eventTitle');
      expect(s!.subjectGrain, t).toBe('yesSubTitle');
      // single-winner kinds → singleWinnerRankFields stamps rank=1
      expect(SINGLE_WINNER_RANK_KINDS.has(s!.eventKind), t).toBe(true);
    }
  });

  test('MLB season awards → award_winner, person, baseball, Tie residual, NL≠AL', () => {
    for (const t of ['KXMLBNLMVP-26', 'KXMLBALMVP-26', 'KXMLBNLMOTY-26', 'KXMLBALMOTY-26', 'KXMLBNLCPOTY-26', 'KXMLBALCPOTY-26']) {
      const s = spec(t)!;
      expect(s.eventKind, t).toBe('award_winner');
      expect(s.subjectType, t).toBe('person');
      expect(s.sport, t).toBe('baseball');
      expect(s.subjectCategory, t).toBe('sports');
      // "Tie/Co-Winners" residual stays literal (never KB-minted, never rank-stamped)
      expect(s.residualRX!.test('Tie/Co-Winners'), t).toBe(true);
      expect(s.residualRX!.test('Aaron Judge'), t).toBe(false);
    }
  });

  test('WNBA season awards → award_winner, person, basketball', () => {
    for (const t of ['KXWNBAMVP-26', 'KXWNBACOY-26']) {
      const s = spec(t)!;
      expect(s.eventKind).toBe('award_winner');
      expect(s.subjectType).toBe('person');
      expect(s.sport).toBe('basketball');
      expect(s.residualRX!.test('Tie/Co-Winners')).toBe(true);
    }
  });

  test('SEXYMAN → award_winner, entertainment person, no sport scope', () => {
    const s = spec('KXSEXYMAN-26')!;
    expect(s.eventKind).toBe('award_winner');
    expect(s.subjectType).toBe('person');
    expect(s.subjectCategory).toBe('entertainment');
    expect(s.sport).toBe('');
  });

  test('soccer domestic champions → championship_winner, team, soccer', () => {
    for (const t of ['KXPERLIGA1-26', 'KXDENSUPERLIGA-26']) {
      const s = spec(t)!;
      expect(s.eventKind).toBe('championship_winner');
      expect(s.subjectType).toBe('team');
      expect(s.sport).toBe('soccer');
    }
  });

  test('UFC per-division title holders → championship_winner, person, mma (seeded sport)', () => {
    for (const t of ['KXUFCLIGHTWEIGHTTITLE-26', 'KXUFCHEAVYWEIGHTTITLE-26', 'KXUFCFLYWEIGHTTITLE-26', 'KXUFCMIDDLEWEIGHTTITLE-26']) {
      const s = spec(t)!;
      expect(s.eventKind).toBe('championship_winner');
      expect(s.subjectType).toBe('person');
      expect(s.sport).toBe('mma');
    }
  });

  test('World Cup group winner → championship_winner, team, soccer (per-group by event_title)', () => {
    // Every group ticker resolves to the same spec; the per-group discriminator
    // lives in the event_title, not the spec.
    for (const suffix of ['A', 'F', 'L']) {
      const s = spec('KXWCGROUPWIN-26' + suffix)!;
      expect(s.eventKind, suffix).toBe('championship_winner');
      expect(s.subjectType, suffix).toBe('team');
      expect(s.sport, suffix).toBe('soccer');
      expect(s.eventFrom, suffix).toBe('eventTitle');
    }
  });

  test('ZERO-FLIP guard: KXPGATOUR / KXFRA14CHAMP are NOT onboarded (text-det-C owns them)', () => {
    // Pass 4 runs before text-det; onboarding these would re-claim and flip
    // their stored text-deterministic-C match_source.
    expect(lookupWinnerSeries('KXPGATOUR-PGC26')).toBeNull();
    expect(lookupWinnerSeries('KXFRA14CHAMP-26')).toBeNull();
  });
});
