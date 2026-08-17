/**
 * settlement-instrument extraction — unit tests over real raw samples pulled
 * from the DB. Every fixture cites its market_metadata_raw.market_id;
 * rules/description text is verbatim (PM descriptions trimmed to the
 * load-bearing paragraphs, marked with …).
 */
import { describe, test, expect } from 'bun:test';
import {
  extractSettlementInstrument, FUTURES_UNPINNED,
  extractCandleSettlement, candleSettlementCompatible,
  extractSettlementDimension, settlementDimensionSql,
  settlementDimensionConflict, settlementDimensionSetConflict,
  settlementDimensionCompatibleSql,
} from './settlement-instrument.js';

describe('extractSettlementInstrument — kalshi (rules_primary + custom_strike)', () => {
  test('market 4117125 (BTC, KXBTC family): CF Benchmarks index → cf-benchmarks', () => {
    expect(
      extractSettlementInstrument('kalshi', {
        rules_primary:
          "If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EDT is above 91499.99 at 5 PM EDT on May 15, 2026, then the market resolves to Yes.",
        custom_strike: null,
      }),
    ).toBe('cf-benchmarks');
  });

  test('market 4107887 (Natural Gas): pinned front_month_contract → futures:NGDM6 (pin beats the generic "contract" word in rules)', () => {
    expect(
      extractSettlementInstrument('kalshi', {
        rules_primary:
          'If the close price of the 1-minute candlestick for natural gasusing the NGDM6 contract on May 15, 2026 at 5:00 PM EDT is above 4.899 USD/MMBtu, then the market resolves to Yes.',
        rules_secondary:
          "Settlement is based on the nearest listed contract month, rolling forward to the next contract 5 business days before the current contract's last trading day.",
        custom_strike: { front_month_contract: 'NGDM6' },
      }),
    ).toBe('futures:NGDM6');
  });

  test('market 4105506 (Crude Oil): front-month futures language, NO pinned contract → futures:unpinned', () => {
    expect(
      extractSettlementInstrument('kalshi', {
        rules_primary:
          'If the front-month settle price for a barrel of West Texas Intermediate oil on May 12, 2026 is above $99.99, then the market resolves to Yes.',
      }),
    ).toBe(FUTURES_UNPINNED);
  });

  test('market 4130903 (Gasoline): "according to AAA" → aaa (the census-flagged gap; AAA lives in rules_primary)', () => {
    expect(
      extractSettlementInstrument('kalshi', {
        rules_primary:
          'If average regular gas prices for United States are strictly greater than $4.510 on May 11, 2026 according to AAA, then the market resolves to Yes.',
        custom_strike: null,
      }),
    ).toBe('aaa');
  });

  test("market 4107967 (Gold): no source named, front_month_contract 'N/A' → null (the unpinned-metals tail, review §3)", () => {
    expect(
      extractSettlementInstrument('kalshi', {
        rules_primary:
          'If the close price of the 1-minute candlestick for gold on May 15, 2026 at 5:00 PM EDT is above 5095.99 USD/t.oz, then the market resolves to Yes.',
        rules_secondary:
          'The settlement value is rounded to the nearest 2 decimal places. When confirming the settlement value, note the close price for the 1-minute candlestick at a given time is the price at the end of the immediately preceding one-minute interval.',
        custom_strike: { front_month_contract: 'N/A' },
      }),
    ).toBe(null);
  });

  test('market 4203875 (DOGE "When will Dogecoin hit $1?"): no source in rules → null (the 3 non-CF DOGE rows)', () => {
    expect(
      extractSettlementInstrument('kalshi', {
        rules_primary:
          'If the price of Dogecoin is above 0.99999999 before Jun 1, 2027, then the market resolves to Yes.',
      }),
    ).toBe(null);
  });
});

describe('extractSettlementInstrument — non-kalshi (description)', () => {
  test('market 4209334 (polymarket BTC hourly): Binance BTC/USDT → binance', () => {
    expect(
      extractSettlementInstrument('polymarket', {
        description:
          'This market will resolve to "Yes" if the "Close" price for the BTC/USDT 1 hour candle that ends on the time and date specified in the title is higher than the price specified in the title. Otherwise, this market will resolve to "No".\n\nThe resolution source for this market is Binance, specifically the BTC/USDT "Close" prices currently available at https://www.binance.com/en/trade/BTC_USDT with "1h" and "Candles" selected on the top bar.',
      }),
    ).toBe('binance');
  });

  test('market 3675249 (polymarket SPY weekly touch): published by Pyth → pyth', () => {
    expect(
      extractSettlementInstrument('polymarket', {
        description:
          'This market will resolve to "Yes" if, at any point during the week of May 11 2026, any 1-minute candle for S&P 500 (SPY) has a final "High" price equal to or above the listed price. Otherwise, this market will resolve to "No".\n\n…\n\nPrices will be used exactly as published by Pyth, without rounding.\n\n…\n\nThe resolution source for this market is Pyth — specifically, the S&P 500 (SPY) "High" prices available at https://pythdata.app/explore/Equity.US.SPY%2FUSD, with the chart settings configured for 1-minute candles.',
      }),
    ).toBe('pyth');
  });

  test('market 3675183 (polymarket NG weekly touch): BOTH Pyth and Active-Month futures language → pyth (named feed wins; the kalshi side being futures:NGDM6 ≠ pyth is what refuses the NG roll-divergence class)', () => {
    expect(
      extractSettlementInstrument('polymarket', {
        description:
          'This market will resolve to "Yes" if, at any point after market creation and during the week of May 11 2026, any 1-minute candle for the Active Month of Natural Gas futures has a final "High" price equal to or above the listed price. Otherwise, this market will resolve to "No".\n\nPrices will be used exactly as published by Pyth, without rounding.\n\nIf the Active Month contract does not trade at all during the listed time frame, this market will resolve to "No".\n\n…\n\nThe active month changes at the start of the second trading session prior to that contract\'s last trading session, at which point the next listed contract becomes the active month (i.e., for the final three trading sessions of the nearest listed contract, the contract for the next month is the active month).\n\n…\n\nThe resolution source for this market is Pyth — specifically, the Active Month Natural Gas futures "High" prices available at https://pythdata.app/explore?search=NGD, with the chart settings configured for 1-minute candles.',
      }),
    ).toBe('pyth');
  });

  test('market 3787421 (polymarket Gold GC): CME Active Month settlement, NO Pyth → futures:unpinned', () => {
    expect(
      extractSettlementInstrument('polymarket', {
        description:
          'This market will resolve to "Yes" if, on any trading day, the official CME settlement price for the Active Month (front month) of Gold (GC) futures is equal to or above the listed price by the final trading day of December 2026. Otherwise, the market will resolve to "No".\n\nFor CME Gold (GC) futures contracts, the Active Month is the nearest of CME\'s designated delivery-cycle months (February, April, June, August, October, December) that is not the spot month.\n\n…\n\nThe resolution source for this market is the CME Group website — specifically, the daily "Settlement" price for the Active Month of Gold (GC) futures.',
      }),
    ).toBe(FUTURES_UNPINNED);
  });

  test('market 3722616 (polymarket gasoline): American Automobile Association (AAA) → aaa', () => {
    expect(
      extractSettlementInstrument('polymarket', {
        description:
          'This market will resolve to "Yes" if on any day between market creation and May 31, 2026, the average US regular gas price is equal to or above the listed price. Otherwise, the market will resolve to "No".\n\nOnly the first two decimal digits of the reported price will be considered (e.g., if the price is reported as $3.257, this market will use $3.25 as the price).\n\nThe resolution source for this market will be information from the American Automobile Association (AAA), presently found here: https://gasprices.aaa.com/. Specifically, the cell under "Regular" and for the row "Current Avg".',
      }),
    ).toBe('aaa');
  });

  test('market 3646430 (predict NVDA monthly touch): predict mirrors the PM description style → pyth', () => {
    expect(
      extractSettlementInstrument('predict', {
        description:
          'This market will resolve to "Yes" if, at any point during May 2026, any 1-minute candle for NVIDIA (NVDA) has a final "High" price equal to or above the listed price. Otherwise, this market will resolve to "No".\n\n…\n\nPrices will be used exactly as published by Pyth, without rounding.',
      }),
    ).toBe('pyth');
  });

  test('market 3677288 (polymarket AAPL weekly close): exchange closing price, no feed named → null', () => {
    expect(
      extractSettlementInstrument('polymarket', {
        description:
          'This market will resolve to "Yes" if the official closing price for Apple (AAPL) on the final day of trading of the specified week (normally Friday) is higher than the listed price. Otherwise, this market will resolve to "No."\n\nIf the final session is shortened (for example, due to a market-holiday schedule), the closing price of that shortened session will be used.',
      }),
    ).toBe(null);
  });
});

describe('extractSettlementInstrument — degenerate raw shapes and AAA case-sensitivity', () => {
  test('null / non-object / array raw → null', () => {
    expect(extractSettlementInstrument('kalshi', null)).toBe(null);
    expect(extractSettlementInstrument('polymarket', undefined)).toBe(null);
    expect(extractSettlementInstrument('kalshi', 'rules')).toBe(null);
    expect(extractSettlementInstrument('polymarket', [1, 2])).toBe(null);
  });

  test('empty object (limitless-style raw with no description/rules) → null', () => {
    expect(extractSettlementInstrument('limitless', {})).toBe(null);
    expect(extractSettlementInstrument('kalshi', {})).toBe(null);
  });

  test('AAA match is case-SENSITIVE: a lowercase aaa URL alone does not qualify', () => {
    expect(
      extractSettlementInstrument('polymarket', {
        description: 'Resolution data presently found at https://gasprices.aaa.com/.',
      }),
    ).toBe(null);
    // …and AAA must be a standalone word, not a substring
    expect(
      extractSettlementInstrument('kalshi', { rules_primary: 'rated AAAA by the agency' }),
    ).toBe(null);
  });

  test("kalshi custom_strike 'N/A' / empty / missing falls through to the rules-text rules", () => {
    expect(
      extractSettlementInstrument('kalshi', {
        rules_primary: 'If the NYMEX front-month settle is above $3, then Yes.',
        custom_strike: { front_month_contract: 'N/A' },
      }),
    ).toBe(FUTURES_UNPINNED);
    expect(
      extractSettlementInstrument('kalshi', {
        rules_primary: 'If the NYMEX front-month settle is above $3, then Yes.',
        custom_strike: { front_month_contract: '' },
      }),
    ).toBe(FUTURES_UNPINNED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractCandleSettlement. Fixtures are verbatim prose from live
// event_kind='candle_direction' rows. Per-family counts are in the
// extractor's header.
// ─────────────────────────────────────────────────────────────────────────────
describe('extractCandleSettlement — oracle half', () => {
  test('polymarket Chainlink stream slug → chainlink:<asset-pair>', () => {
    expect(extractCandleSettlement('polymarket', {
      description:
        'This market will resolve to "Up" if the Chainlink SOL/USD price at the end of the '
        + 'window is greater than or equal to the price at the beginning. Resolution source: '
        + 'https://data.chain.link/streams/sol-usd',
    })).toBe('chainlink:sol-usd|tie:up');
  });

  test("predict's stream slug keeps its discriminating part, drops the '-datalink' decoration", () => {
    expect(extractCandleSettlement('predict', {
      description:
        'This market will resolve to "Up" if the ETH/USDT price at the end of the time range '
        + 'specified in the title is greater than the price at the beginning of that range.\r\n\r\n'
        + 'If the two prices are exactly equal, the market will resolve 50-50.\r\n\r\n'
        + 'The primary resolution source for this market is Chainlink, specifically the ETH/USDT '
        + 'data stream available at https://data.chain.link/streams/eth-usdt-topofbook-datalink'
        + '?timeframe=1d&chart=candlestick.',
    })).toBe('chainlink:eth-usdt-topofbook|tie:5050');
  });

  test("limitless keeps 'cexprice', drops the '-streams' decoration", () => {
    expect(extractCandleSettlement('limitless', {
      description:
        '<p>This market will resolve to "Up" if the <a href="https://data.chain.link/streams/'
        + 'btc-usd-cexprice-streams">Chainlink BTC/USD</a> price on July 11, 2026, at 02:20 UTC is '
        + 'greater than or equal to the price captured on July 11, 2026, at 02:15 UTC. Otherwise, '
        + 'this market will resolve to "Down".</p>',
    })).toBe('chainlink:btc-usd-cexprice|tie:up');
  });

  test('kalshi CF Benchmarks 60-second RTI (rules_primary)', () => {
    expect(extractCandleSettlement('kalshi', {
      rules_primary:
        "If the simple average of the sixty seconds of CF Benchmarks' BNBUSDRTI before 10:00 AM "
        + "EDT on Jul 13, 2026 is at least the simple average of the sixty seconds of CF Benchmarks' "
        + 'BNBUSDRTI before 9:45 AM EDT on July 13, 2026, then the market resolves to Yes.',
    })).toBe('cf-benchmarks-rti:60s|tie:up');
  });

  test('the legacy Binance 1h family (no Chainlink stream named) → binance', () => {
    expect(extractCandleSettlement('polymarket', {
      description:
        'This market will resolve to "Up" if the close price is greater than or equal to the open '
        + 'price for the XRP/USDT 1 hour candle that begins on the time and date specified in the '
        + 'title. Otherwise, this market will resolve to "Down".\n\nThe resolution source for this '
        + 'market is information from Binance, specifically the XRPUSDT candles.',
    })).toBe('binance|tie:up');
  });

  test('no oracle named → NULL (never a guess)', () => {
    expect(extractCandleSettlement('limitless', { description: 'Up or Down - 5 Min' })).toBe(null);
    expect(extractCandleSettlement('limitless', { description: '' })).toBe(null);
    expect(extractCandleSettlement('polymarket', {})).toBe(null);
  });

  test('TOTAL — any raw shape is tolerated', () => {
    expect(extractCandleSettlement('polymarket', null)).toBe(null);
    expect(extractCandleSettlement('polymarket', 'not an object')).toBe(null);
    expect(extractCandleSettlement('polymarket', [1, 2, 3])).toBe(null);
    expect(extractCandleSettlement('polymarket', { description: 42 })).toBe(null);
  });
});

describe('extractCandleSettlement — tie half', () => {
  test("'50-50' wins over a bare comparator (predict's text carries BOTH)", () => {
    expect(extractCandleSettlement('predict', {
      description:
        'resolves Up if the price is greater than the open. https://data.chain.link/streams/btc-usdt '
        + 'If the two prices are exactly equal, the market will resolve 50-50.',
    })).toBe('chainlink:btc-usdt|tie:5050');
  });

  test('a known oracle with an UNREADABLE tie rule is NULL, not a half-identity', () => {
    expect(extractCandleSettlement('polymarket', {
      description: 'Resolution source: https://data.chain.link/streams/btc-usd',
    })).toBe(null);
  });

  test("'strictly greater' settles a tie DOWN", () => {
    expect(extractCandleSettlement('polymarket', {
      description:
        'Resolves Up only if the close is strictly greater than the open. '
        + 'Source: https://data.chain.link/streams/btc-usd',
    })).toBe('chainlink:btc-usd|tie:down');
  });
});

describe('candleSettlementCompatible', () => {
  const PM_BTC = 'chainlink:btc-usd|tie:up';
  const PREDICT_BTC = 'chainlink:btc-usdt-topofbook|tie:5050';
  const LIMITLESS_BTC = 'chainlink:btc-usd-cexprice|tie:up';

  test('identical tokens are compatible — the 7 sound daily Binance candles stay merged', () => {
    expect(candleSettlementCompatible('binance|tie:up', 'binance|tie:up')).toBe(true);
    expect(candleSettlementCompatible(PM_BTC, PM_BTC)).toBe(true);
  });

  test('DIFFERENT oracle streams for the same asset are NOT compatible (the intraday class)', () => {
    expect(candleSettlementCompatible(PM_BTC, PREDICT_BTC)).toBe(false);
    expect(candleSettlementCompatible(PM_BTC, LIMITLESS_BTC)).toBe(false);
    expect(candleSettlementCompatible(PREDICT_BTC, LIMITLESS_BTC)).toBe(false);
  });

  test('same oracle but a DIFFERENT tie rule is NOT compatible', () => {
    expect(candleSettlementCompatible('binance|tie:up', 'binance|tie:5050')).toBe(false);
  });

  test('NULL on either side is never compatible (the caller decides skip vs defer)', () => {
    expect(candleSettlementCompatible(null, PM_BTC)).toBe(false);
    expect(candleSettlementCompatible(PM_BTC, null)).toBe(false);
    expect(candleSettlementCompatible(null, null)).toBe(false);
  });
});

// ── the settlement dimension ──────────────────────────────────────────────────
// Every fixture below is verbatim raw text, cited by market_id. The two
// families that diverge are locked positively; the families that agree
// across venues are locked to null, because this fact refusing anything
// there would cost sound cross-venue merges.

describe('extractSettlementDimension — the two DIVERGENT motorsport families', () => {
  test('market 6262175 (kalshi KXF1TOPCONSTRUCTOR-BELGP26): "either driver … exactly first" → race-p1', () => {
    expect(extractSettlementDimension('kalshi', {
      rules_primary:
        'If either driver from Audi F1 Team finishes in exactly first in the main race originally '
        + 'scheduled for July 19, 2026 at the 2026 Belgian Grand Prix, then the market resolves to Yes.',
    })).toBe('motorsport:race-p1');
  });

  test('market 6444032 (polymarket, same GP, same team): "most points" → constructor-points', () => {
    expect(extractSettlementDimension('polymarket', {
      description:
        'This market will resolve to the constructor who scored the most points for the specified session.\n\n'
        + 'For this market, the specified session is the 2026 F1 Belgian Grand Prix, currently scheduled for '
        + 'Jul 19, 2026. Results from other sessions (e.g. sprints) will not count for this market.',
    })).toBe('motorsport:constructor-points');
  });

  test('the PM negRisk RESIDUAL (market 17508631) carries its FAMILY dimension', () => {
    // It is the slot whose presence made the fused set look exhaustive; scoping it
    // to constructor-points is what lets the certifier see the mixed basket.
    expect(extractSettlementDimension('polymarket', {
      description: 'This market will resolve to the constructor who scored the most points for the specified session.',
    })).toBe('motorsport:constructor-points');
  });

  test('the two DIVERGE — this pair is the whole point of the fact', () => {
    const k = extractSettlementDimension('kalshi', {
      rules_primary:
        'If either driver from Mercedes AMG Motorsport finishes in exactly first in the main race '
        + 'originally scheduled for July 19, 2026 at the 2026 Belgian Grand Prix, then the market resolves to Yes.',
    });
    const p = extractSettlementDimension('polymarket', {
      description: 'This market will resolve to the constructor who scored the most points for the specified session.',
    });
    expect(settlementDimensionConflict(k, p)).toBe(true);
  });

  test('the DRIVER-level race family reads the SAME quantity as the team-level one', () => {
    // KXF1RACE — deliberately the same token: a driver-P1 market and a team-P1
    // market measure ONE quantity; they differ by SUBJECT, another guard's job.
    expect(extractSettlementDimension('kalshi', {
      rules_primary:
        'If Alexander Albon finishes in exactly first in the main race originally scheduled for '
        + 'July 19, 2026 at the 2026 Belgian Grand Prix, then the market resolves to Yes.',
    })).toBe('motorsport:race-p1');
  });
});

describe('extractSettlementDimension — families deliberately LEFT NULL (no split)', () => {
  test('pole position (kalshi KXF1POLE x PM pole) — adjudicated EQUIVALENT', () => {
    expect(extractSettlementDimension('kalshi', {
      rules_primary: 'If Alexander Albon is awarded Pole Position for the 2026 Belgian Grand Prix, then the market resolves to Yes.',
    })).toBe(null);
    expect(extractSettlementDimension('polymarket', {
      description: 'This is a polymarket on the driver who achieves pole position at the 2026 F1 Belgian Grand Prix, scheduled for Jul 18, 2026.',
    })).toBe(null);
  });

  test('fastest lap (KXF1FASTLAP x PM fastest lap)', () => {
    expect(extractSettlementDimension('kalshi', {
      rules_primary: 'If Alexander Albon records the fastest valid lap time in the main race at the 2026 Belgian Grand Prix, then the market resolves to Yes.',
    })).toBe(null);
    expect(extractSettlementDimension('polymarket', {
      description: 'This is a polymarket on the driver who achieves the fastest lap at the 2026 F1 Belgian Grand Prix, scheduled for Jul 19, 2026.',
    })).toBe(null);
  });

  test('constructors CHAMPIONSHIP (KXF1CONSTRUCTORS x PM season champion) — both the season table', () => {
    expect(extractSettlementDimension('kalshi', {
      rules_primary: 'If Alpine wins the 2026 F1 Constructors Championship, then the market resolves to Yes.',
    })).toBe(null);
    expect(extractSettlementDimension('polymarket', {
      description: 'This market will resolve according to the constructor that finishes 1st in the constructor standings for the 2026 F1 season.',
    })).toBe(null);
  });

  test('PM race-winner wording extracts nothing — one-side-NULL keeps the SOUND KXF1RACE merge', () => {
    expect(extractSettlementDimension('polymarket', {
      description: 'This is a polymarket on the winner of the 2026 F1 Belgian Grand Prix, scheduled for Jul 19, 2026.',
    })).toBe(null);
  });

  test('non-motorsport prose never yields a dimension', () => {
    expect(extractSettlementDimension('kalshi', {
      rules_primary: 'If the Milwaukee Brewers win the game against the New York Mets, then the market resolves to Yes.',
    })).toBe(null);
  });

  test('TOTAL — any raw shape is tolerated', () => {
    expect(extractSettlementDimension('kalshi', null)).toBe(null);
    expect(extractSettlementDimension('kalshi', 'not an object')).toBe(null);
    expect(extractSettlementDimension('kalshi', [1, 2, 3])).toBe(null);
    expect(extractSettlementDimension('kalshi', { rules_primary: 42 })).toBe(null);
    expect(extractSettlementDimension('kalshi', {})).toBe(null);
  });

  test('the TITLE is never read (F-B lint): title-only evidence yields nothing', () => {
    // PM titles literally say "highest constructor score"; a title-reading
    // extractor would classify markets whose settlement RULE is unknown.
    expect(extractSettlementDimension('polymarket', {
      title: 'Will Mercedes have the highest constructor score at the 2026 F1 Belgian Grand Prix?',
    })).toBe(null);
  });
});

describe('settlementDimensionConflict / SetConflict — both-known-and-differ only', () => {
  const P1 = 'motorsport:race-p1';
  const PTS = 'motorsport:constructor-points';

  test('two known, different => conflict', () => {
    expect(settlementDimensionConflict(P1, PTS)).toBe(true);
    expect(settlementDimensionConflict(PTS, P1)).toBe(true);
  });

  test('equal => no conflict', () => {
    expect(settlementDimensionConflict(P1, P1)).toBe(false);
  });

  test('NULL/undefined on either side => never a conflict (subtractive-only)', () => {
    expect(settlementDimensionConflict(null, PTS)).toBe(false);
    expect(settlementDimensionConflict(P1, null)).toBe(false);
    expect(settlementDimensionConflict(undefined, undefined)).toBe(false);
  });

  test('set form returns the SORTED pair, or null when the known dims agree', () => {
    expect(settlementDimensionSetConflict([P1, null, PTS, P1])).toEqual([PTS, P1]);
    expect(settlementDimensionSetConflict([P1, null, P1])).toBe(null);
    expect(settlementDimensionSetConflict([null, undefined])).toBe(null);
    expect(settlementDimensionSetConflict([])).toBe(null);
    expect(settlementDimensionSetConflict([''])).toBe(null);
  });
});

describe('vocabulary separation — the THREE token families share one column', () => {
  // llm_market_normalizations.settlement_instrument carries level instruments
  // (Phase D), candle tokens (P1) and dimensions (P6b). The backfill's runtime
  // invariant asserts they never cross; this locks the SHAPES that make that
  // invariant decidable.
  const level = extractSettlementInstrument('kalshi', {
    rules_primary: "…CF Benchmarks' Bitcoin Real-Time Index…", custom_strike: null,
  })!;
  const candle = extractCandleSettlement('polymarket', {
    description: 'greater than or equal to the open. https://data.chain.link/streams/btc-usd',
  })!;
  const dim = extractSettlementDimension('kalshi', {
    rules_primary: 'If either driver from Audi F1 Team finishes in exactly first in the main race, then the market resolves to Yes.',
  })!;

  test('every family is non-empty and pairwise distinguishable by SHAPE alone', () => {
    expect(level).toBeTruthy();
    expect(candle).toBeTruthy();
    expect(dim).toBeTruthy();
    // candle ⇔ contains '|tie:'
    expect(candle.includes('|tie:')).toBe(true);
    expect(level.includes('|tie:')).toBe(false);
    expect(dim.includes('|tie:')).toBe(false);
    // dimension ⇔ 'motorsport:' prefix
    expect(dim.startsWith('motorsport:')).toBe(true);
    expect(level.startsWith('motorsport:')).toBe(false);
    expect(candle.startsWith('motorsport:')).toBe(false);
  });
});

describe('settlementDimensionSql — SQL twin literal-lock', () => {
  const sql = settlementDimensionSql('mmr.raw');

  test('reads ONLY description + rules_primary off the passed raw expression', () => {
    expect(sql).toContain("mmr.raw->>'description'");
    expect(sql).toContain("mmr.raw->>'rules_primary'");
    expect(sql).not.toContain('title');
  });

  test('emits exactly the TS vocabulary, in the TS order (points before P1)', () => {
    expect(sql.indexOf("'motorsport:constructor-points'"))
      .toBeLessThan(sql.indexOf("'motorsport:race-p1'"));
    expect(sql.indexOf("'motorsport:constructor-points'")).toBeGreaterThan(-1);
  });

  test('carries the same two literals the TS regexes use', () => {
    expect(sql).toContain('constructor who scored the most points');
    expect(sql).toContain('highest constructor score');
    expect(sql).toContain('finish(es)? in (exactly )?first in the main race');
  });

  test('case-insensitive matching on both arms', () => {
    expect(sql.match(/~\*/g)?.length).toBe(2);
  });
});

describe('settlementDimensionCompatibleSql — the keep-conjunct', () => {
  const frag = settlementDimensionCompatibleSql('a.dim', 'b.dim');

  test('is a NEGATED both-known-and-differ test (NULL passes)', () => {
    expect(frag.startsWith('NOT (')).toBe(true);
    expect(frag).toContain('a.dim IS NOT NULL');
    expect(frag).toContain('b.dim IS NOT NULL');
    expect(frag).toContain('IS DISTINCT FROM');
  });

  test('composes with the extraction twin (the cross-ref builder shape)', () => {
    const inline = settlementDimensionCompatibleSql(
      settlementDimensionSql('rs.raw'), settlementDimensionSql('rt.raw'),
    );
    expect(inline).toContain("rs.raw->>'rules_primary'");
    expect(inline).toContain("rt.raw->>'rules_primary'");
  });
});
