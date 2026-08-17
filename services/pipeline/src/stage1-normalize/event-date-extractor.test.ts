import { describe, test, expect } from 'bun:test';
import { extractEventDate, type ExtractEventDateInput } from './event-date-extractor.js';

function row(overrides: Partial<ExtractEventDateInput>): ExtractEventDateInput {
  return {
    platform: 'polymarket',
    platform_id: 'x',
    title: '',
    slug: null,
    end_date: null,
    mve_selected_legs: null,
    ...overrides,
  };
}

describe('extractEventDate — slug-based signals', () => {
  test('Limitless slug-unix-ms is no longer trusted (it is post-time); title-mdy wins', () => {
    // The slug-unix-ms suffix on Limitless is the market post time, not the
    // event time, so it is gated off for Limitless and the title regex wins.
    const r = row({
      platform: 'limitless',
      slug: 'laliga-osasuna-vs-espanyol-may-17-2026-1777798833223',
      title: 'LaLiga, Osasuna vs Espanyol, May 17, 2026',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('title-mdy');
    expect(ed?.precision).toBe('day');
    expect(ed?.iso).toBe('2026-05-17');
  });

  test('Limitless candle "Up or Down - 5 Min" → end_date − 5min (candle open, matches Polymarket)', () => {
    const r = row({
      platform: 'limitless',
      slug: 'btc-up-or-down-5-min-1778700400019',
      title: 'BTC Up or Down - 5 Min',
      end_date: '2026-05-13T20:10:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('limitless-candle-open');
    expect(ed?.precision).toBe('minute');
    expect(ed?.iso).toBe('2026-05-13T20:05:00Z');
  });

  test('Limitless candle "Up or Down - 1 hour" → end_date − 60min', () => {
    const r = row({
      platform: 'limitless',
      slug: 'btc-up-or-down-1-hour-1778403605866',
      title: 'BTC Up or Down - 1 hour',
      end_date: '2026-05-10T10:00:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('limitless-candle-open');
    expect(ed?.iso).toBe('2026-05-10T09:00:00Z');
  });

  test('Limitless candle "Up or Down - Daily" → end_date − 24h', () => {
    const r = row({
      platform: 'limitless',
      slug: 'doge-up-or-down-daily-1778702410677',
      title: 'DOGE Up or Down - Daily',
      end_date: '2026-05-14T20:00:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('limitless-candle-open');
    expect(ed?.iso).toBe('2026-05-13T20:00:00Z');
  });

  test('Limitless candle "Up or Down - Weekly" → end_date − 7 days', () => {
    const r = row({
      platform: 'limitless',
      slug: 'btc-up-or-down-1-week-1778493606673',
      title: 'BTC Up or Down - Weekly',
      end_date: '2026-05-18T10:00:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('limitless-candle-open');
    expect(ed?.iso).toBe('2026-05-11T10:00:00Z');
  });

  test('Limitless sports BTTS title-md → day precision (NOT slug-unix-ms post-time)', () => {
    const r = row({
      platform: 'limitless',
      slug: 'both-osasuna-and-atletico-madrid-score-on-may-12-1777368602323',
      title: 'Both Osasuna and Atletico Madrid score on May 12?',
      end_date: '2026-05-13T19:30:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('title-md');
    expect(ed?.precision).toBe('day');
    expect(ed?.iso).toBe('2026-05-12');
  });

  test('Polymarket crypto Up/Down slug-unix-sec → minute precision UTC', () => {
    const r = row({
      platform: 'polymarket',
      slug: 'xrp-updown-5m-1778452200',
      title: 'XRP Up or Down - May 10, 6:30PM-6:35PM ET',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('slug-unix-sec');
    expect(ed?.precision).toBe('minute');
    expect(ed?.iso.startsWith('2026-05-')).toBe(true);
  });

  test('Polymarket slug-iso date (sports/ML) → day precision', () => {
    const r = row({
      platform: 'polymarket',
      slug: 'arg-ros-ind-2026-05-10-exact-score-1-2',
      title: 'Exact Score: CA Rosario Central 1 - 2 CA Independiente?',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('slug-iso');
    expect(ed?.precision).toBe('day');
    expect(ed?.iso).toBe('2026-05-10');
  });

  test('slug-iso wins over title patterns when both present', () => {
    const r = row({
      slug: 'nba-det-cle-2026-05-11-total-212pt5',
      title: 'Pistons vs. Cavaliers: O/U 212.5 on May 12, 2026',
    });
    const ed = extractEventDate(r);
    expect(ed?.iso).toBe('2026-05-11');
    expect(ed?.source).toBe('slug-iso');
  });
});

describe('extractEventDate — Kalshi ticker signals', () => {
  test('YYMonDDHHMM → minute precision ET', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXMLBKS-26MAY131910DETNYM-NYMCSCOTT45-4',
      title: 'Christian Scott: 4+ strikeouts?',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-minute');
    expect(ed?.precision).toBe('minute');
    expect(ed?.iso).toBe('2026-05-13T19:10:00');
    expect(ed?.tzAssumed).toBe('ET');
  });

  test('YYMonDDHH → hour precision ET', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXHYPED-26MAY1006-T11.9999',
      title: 'HYPE price on May 10, 2026?',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-hour');
    expect(ed?.precision).toBe('hour');
    expect(ed?.iso).toBe('2026-05-10T06:00:00');
  });

  test('YYMonDD → day precision ET', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXAAAGASMIN-26DEC31-3.40',
      title: 'Will average gas prices be below $3.40 by Dec 31, 2026?',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-day');
    expect(ed?.precision).toBe('day');
    expect(ed?.iso).toBe('2026-12-31');
  });

  test('YYMon → month precision', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXFARMBILL-26MAY-SEP01',
      title: 'Will an omnibus farm law become law before Sep 1, 2026?',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-month');
    expect(ed?.precision).toBe('month');
    // Full 'YYYY-MM-01' (::date-castable), not the truncated 'YYYY-MM'.
    expect(ed?.iso).toBe('2026-05-01');
    expect(ed!.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('Kalshi election year-only tag → year precision', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXBRPRES-26-LULA',
      title: 'Will Luiz Inácio Lula da Silva win the 2026 Brazilian presidential election?',
      end_date: '2027-10-25T14:00:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-year');
    expect(ed?.precision).toBe('year');
    expect(ed?.iso).toBe('2026-01-01');
  });

  test('Kalshi US 2028 election year-only tag', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXPRESPERSON-28-MRUB',
      title: 'Who will win the next presidential election?',
      end_date: '2029-11-07T15:00:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-year');
    expect(ed?.iso).toBe('2028-01-01');
  });

  test('Kalshi PGA H2H tournament-code year (TRC26 → 2026)', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXPGAH2H-TRC26LABEXSCH-XSCH',
      title: 'Will Xander Schauffele beat Ludvig Aberg in the Truist Championship?',
      end_date: '2026-05-25T02:10:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-year');
    expect(ed?.precision).toBe('year');
    expect(ed?.iso).toBe('2026-01-01');
  });

  test('Kalshi PGA H2H PGC26 → 2026', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXPGAH2H-PGC26CYOUBDEC-CYOU',
      title: 'Will Cameron Young beat Bryson DeChambeau in the PGA Championship?',
      end_date: '2026-06-01T02:00:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-year');
    expect(ed?.iso).toBe('2026-01-01');
  });

  test('tournament-year fallback does NOT fire when explicit dated ticker wins', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXBTCD-26MAY16H00',
      title: 'BTC up/down',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-day');
    expect(ed?.iso).toBe('2026-05-16');
  });

  test('year-only pattern does NOT fire when ticker has a month tag', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXAAAGASMIN-26DEC31-3.40',
      title: 'Will average gas prices be below $3.40 by Dec 31, 2026?',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-ticker-day');
    expect(ed?.iso).toBe('2026-12-31');
  });

  test('Kalshi parlay aggregates leg dates (MIN)', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXMVESPORTSMULTIGAMEEXTENDED-S2026FC6B65C199C-C9A374E780C',
      title: 'yes ...',
      mve_selected_legs: [
        { side: 'yes', market_ticker: 'KXNBASPREAD-26MAY15SASMIN-SAS5' },
        { side: 'yes', market_ticker: 'KXMLBGAME-26MAY13NYY-NYY' },
        { side: 'no',  market_ticker: 'KXNBATOTAL-26MAY14DETCLE-220.5' },
      ],
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-leg-min');
    expect(ed?.iso).toBe('2026-05-13');
    expect(ed?.precision).toBe('day');
  });
});

describe('extractEventDate — title regex fallback', () => {
  test('"Month DD, YYYY" → day precision', () => {
    const r = row({
      title: 'Will Yankees win on November 4, 2025?',
      platform_id: 'no-date-in-id',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('title-mdy');
    expect(ed?.iso).toBe('2025-11-04');
  });

  test('ISO date in title (Predict pattern)', () => {
    const r = row({
      platform: 'predict',
      platform_id: '163323',
      title: 'Will Belgium win on 2026-06-21?',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('title-iso');
    expect(ed?.iso).toBe('2026-06-21');
  });

  test('"Month DD" + time-of-day ET combines to minute precision', () => {
    const r = row({
      platform: 'predict',
      platform_id: '320056',
      title: 'Bitcoin Up or Down - May 10, 8PM-8:05PM ET',
      end_date: '2026-05-10T00:00:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source === 'title-md' || ed?.source === 'title-iso').toBe(true);
    // 8PM ET = 00:00 UTC next day in EDT (-4).
    expect(ed?.iso.startsWith('2026-05-')).toBe(true);
  });

  test('"in <Month> <YYYY>" (no day) → month-END day + month precision (WP-3.3 DATE_EOM)', () => {
    // The month-grain deadline stamps the month-end day ('2026-05-31') at
    // month precision, so it ISO-equals the "by end of May" day-stamp and the
    // two phrasings of one deadline fold. Day is invisible at month grain
    // (util/date-grain-sql.ts).
    const ed = extractEventDate(row({ title: 'Will Elon Musk post 200-219 tweets in May 2026?' }));
    expect(ed?.source).toBe('title-month-year');
    expect(ed?.precision).toBe('month');
    expect(ed?.iso).toBe('2026-05-31');
  });

  test('"after the <Month> <YYYY> meeting" (rate-decision phrasing) → month-END grain', () => {
    const ed = extractEventDate(row({ title: 'Will there be no change in Fed interest rates after the June 2026 meeting?' }));
    expect(ed?.source).toBe('title-month-year');
    expect(ed?.precision).toBe('month');
    expect(ed?.iso).toBe('2026-06-30');
  });

  test('month abbreviation "Sept 2026" → month-END grain', () => {
    const ed = extractEventDate(row({ title: 'What will NVDA hit in Sept 2026?: above $224' }));
    expect(ed?.source).toBe('title-month-year');
    expect(ed?.precision).toBe('month');
    expect(ed?.iso).toBe('2026-09-30');
  });

  // bare-month deadline branch (no year, no day)
  test('"hit … in <Month>?" (no year) → month-END day + month precision, not end_date', () => {
    // PM "hit … in May?" must not fall to the end_date fallback (PM's
    // May-31→Jun-1 buffer would stamp 2026-06-01), or it never folds with
    // Predict's "by end of May" 2026-05-31.
    const ed = extractEventDate(row({
      title: 'Will Palantir Technologies Inc. (PLTR) hit (HIGH) $174 in May?',
      end_date: '2026-06-01T00:00:00Z',
    }));
    expect(ed?.source).toBe('title-month-deadline');
    expect(ed?.precision).toBe('month');
    expect(ed?.iso).toBe('2026-05-31'); // ISO-equal to the "by end of May" day-stamp
  });

  test('"hit … by end of <Month>?" → month-END day + month precision', () => {
    const ed = extractEventDate(row({
      title: 'Will Crude Oil (CL) hit (HIGH) $100 by end of June?',
      end_date: '2026-06-30T00:00:00Z',
    }));
    expect(ed?.source).toBe('title-month-deadline');
    expect(ed?.precision).toBe('month');
    expect(ed?.iso).toBe('2026-06-30');
  });

  test('"by end of <Month>?" deadline (non-price) → month-END grain', () => {
    const ed = extractEventDate(row({
      title: 'Will the government shut down by end of September?',
      end_date: '2026-10-01T00:00:00Z',
    }));
    expect(ed?.source).toBe('title-month-deadline');
    expect(ed?.iso).toBe('2026-09-30');
    expect(ed?.precision).toBe('month');
  });

  test('pm:inflation DATA-MONTH "in <Month>?" (no hit / no by-end-of) stays on the end_date CPI-print stamp', () => {
    // "in May" names the measured month, NOT a deadline — must NOT flip
    // (resolves ~Jun 10 when May CPI prints). The "hit"/"by end of" gate excludes it.
    const ed = extractEventDate(row({
      title: 'Will monthly inflation increase by 0.3% in May?',
      end_date: '2026-06-10T00:00:00Z',
    }));
    expect(ed?.source).toBe('end_date');
    expect(ed?.precision).toBe('day');
    expect(ed?.iso).toBe('2026-06-10');
  });

  test('deadline branch needs an end_date for the year — no end_date falls through', () => {
    const ed = extractEventDate(row({ title: 'Will X hit (HIGH) $5 in May?', end_date: null }));
    expect(ed?.source).not.toBe('title-month-deadline');
  });

  test('year-rollover guard: December deadline whose end_date buffered into next Jan', () => {
    const ed = extractEventDate(row({
      title: 'Will BTC hit (HIGH) $200000 in December?',
      end_date: '2027-01-01T00:00:00Z', // PM Dec-31→Jan-1 buffer
    }));
    expect(ed?.source).toBe('title-month-deadline');
    expect(ed?.iso).toBe('2026-12-31'); // previous year, not 2027
    expect(ed?.precision).toBe('month');
  });

  test('a real "Month DD, YYYY" day still wins over the month-year pattern', () => {
    const ed = extractEventDate(row({ title: 'Will X happen on May 17, 2026?' }));
    expect(ed?.source).toBe('title-mdy');
    expect(ed?.iso).toBe('2026-05-17');
  });

  test('"Month DD" (inferred year) still wins over the month-year pattern', () => {
    const ed = extractEventDate(row({
      title: 'Will Y close higher on May 17 after the June 2026 meeting?',
      end_date: '2026-05-17T00:00:00Z',
    }));
    expect(ed?.source).toBe('title-md');
    expect(ed?.iso).toBe('2026-05-17');
  });

  test('year-only → year precision (event-anchored)', () => {
    const r = row({
      title: 'Will Player N win 2026 MLS Goalkeeper of the Year?',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('title-year');
    expect(ed?.precision).toBe('year');
    expect(ed?.iso).toBe('2026-01-01');
  });

  test('end_date fallback when no other signal', () => {
    const r = row({
      title: 'Some untemplated market',
      end_date: '2026-07-15T23:59:00Z',
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('end_date');
    expect(ed?.precision).toBe('day');
    expect(ed?.iso).toBe('2026-07-15');
  });

  test('returns null when no signal at all', () => {
    const r = row({ title: 'Some untemplated market' });
    expect(extractEventDate(r)).toBe(null);
  });
});

describe('extractEventDate — invalid input safety', () => {
  test('rejects impossible date (Feb 30)', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXFOO-26FEB30-X',
    });
    const ed = extractEventDate(r);
    // Falls through past invalid kalshi-ticker-day to other patterns; with no
    // title and no end_date should be null.
    expect(ed).toBe(null);
  });

  test('rejects malformed slug timestamp out of range', () => {
    const r = row({
      platform: 'limitless',
      slug: 'foo-9999999999999',  // year > 2500
    });
    const ed = extractEventDate(r);
    // Should fall through to other patterns or null
    expect(ed?.source).not.toBe('slug-unix-ms');
  });
});

describe('extractEventDate — AUD-50 month precision is ::date-castable', () => {
  test('kalshi-ticker-month iso matches /^\d{4}-\d{2}-\d{2}$/ (full YYYY-MM-01)', () => {
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXFARMBILL-26MAY-SEP01',
      title: 'Will an omnibus farm law become law before Sep 1, 2026?',
    });
    const ed = extractEventDate(r);
    expect(ed?.precision).toBe('month');
    expect(ed?.iso).toBe('2026-05-01');
    // The iso must be castable to ::date in SQL.
    expect(ed!.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(ed!.iso))).toBe(false);
  });

  test('parlay aggregating month-precise legs also returns YYYY-MM-01', () => {
    // A parlay whose coarsest leg is month-precise (KXFARMBILL YYMon) must emit
    // a full castable date, not a truncated YYYY-MM.
    const r = row({
      platform: 'kalshi',
      platform_id: 'KXMVE-S2026X-Y',
      title: 'parlay',
      mve_selected_legs: [
        { side: 'yes', market_ticker: 'KXNBASPREAD-26JUN15SASMIN-SAS5' }, // day-precise
        { side: 'yes', market_ticker: 'KXFARMBILL-26MAY-SEP01' },         // month-precise → coarsest
      ],
    });
    const ed = extractEventDate(r);
    expect(ed?.source).toBe('kalshi-leg-min');
    expect(ed?.precision).toBe('month');
    expect(ed!.iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ed!.iso.endsWith('-01')).toBe(true);
  });
});


// UTC day-carry on title time-of-day riders: a wall-clock hour computed as
// (hr + offset) % 24 must carry onto the NEXT calendar date when the wrap
// crosses midnight UTC, not stay on the unmodified date — otherwise every
// western-zone evening title lands exactly 24h early.
describe('extractEventDate — P2 title time-of-day day-carry', () => {
  test('>=20:00 ET rolls the date FORWARD one day (title-mdy)', () => {
    const ed = extractEventDate(row({ title: 'Will the Yankees win on May 17, 2026 at 8PM ET?' }));
    expect(ed?.source).toBe('title-mdy');
    expect(ed?.iso).toBe('2026-05-18T00:00:00Z');
    expect(ed?.precision).toBe('hour');
  });

  test('afternoon ET times are UNCHANGED (no carry)', () => {
    const ed = extractEventDate(row({ title: 'Will the Yankees win on May 17, 2026 at 1PM ET?' }));
    expect(ed?.iso).toBe('2026-05-17T17:00:00Z');
    const morning = extractEventDate(row({ title: 'Will X happen on May 17, 2026 at 9AM ET?' }));
    expect(morning?.iso).toBe('2026-05-17T13:00:00Z');
  });

  test('the carry is the ONLY difference — 7:59PM ET stays, 8:00PM ET rolls', () => {
    // 7:59PM EDT = 23:59Z same day; 8:00PM EDT = 00:00Z next day.
    expect(extractEventDate(row({ title: 'Game on May 17, 2026, 7:59PM ET' }))?.iso)
      .toBe('2026-05-17T23:59:00Z');
    expect(extractEventDate(row({ title: 'Game on May 17, 2026, 8:00PM ET' }))?.iso)
      .toBe('2026-05-18T00:00:00Z');
  });

  test('EST (UTC−5) carries one hour earlier than EDT (UTC−4)', () => {
    // 7PM EST = 00:00Z next day (carry); 7PM EDT = 23:00Z same day (no carry).
    expect(extractEventDate(row({ title: 'Match on January 10, 2026 at 7PM EST' }))?.iso)
      .toBe('2026-01-11T00:00:00Z');
    expect(extractEventDate(row({ title: 'Match on January 10, 2026 at 7PM EDT' }))?.iso)
      .toBe('2026-01-10T23:00:00Z');
  });

  test('PT/PST carry across midnight too (max offset 8h can never carry twice)', () => {
    expect(extractEventDate(row({ title: 'Match on May 17, 2026 at 5PM PT' }))?.iso)
      .toBe('2026-05-18T00:00:00Z');
    // 11PM PST = 07:00Z NEXT day — exactly one day of carry, never two.
    expect(extractEventDate(row({ title: 'Match on May 17, 2026 at 11PM PST' }))?.iso)
      .toBe('2026-05-18T07:00:00Z');
  });

  test('UTC/GMT riders are a no-op (offset 0 ⇒ carry 0)', () => {
    expect(extractEventDate(row({ title: 'Snapshot on May 17, 2026 at 11PM UTC' }))?.iso)
      .toBe('2026-05-17T23:00:00Z');
  });

  test('the carry rolls MONTH and YEAR boundaries correctly', () => {
    expect(extractEventDate(row({ title: 'Game on May 31, 2026 at 9PM ET' }))?.iso)
      .toBe('2026-06-01T01:00:00Z');
    expect(extractEventDate(row({ title: 'Game on December 31, 2026 at 9PM ET' }))?.iso)
      .toBe('2027-01-01T01:00:00Z');
  });

  test('the title-iso and title-md branches carry identically', () => {
    expect(extractEventDate(row({ title: 'Will X win on 2026-06-21 at 10PM ET?' }))?.iso)
      .toBe('2026-06-22T02:00:00Z');
    const md = extractEventDate(row({ title: 'Game on May 17 at 8PM ET', end_date: '2026-06-01T00:00:00Z' }));
    expect(md?.source).toBe('title-md');
    expect(md?.iso).toBe('2026-05-18T00:00:00Z');
  });
});
