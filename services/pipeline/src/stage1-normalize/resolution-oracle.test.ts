/**
 * resolution_source real-oracle parse. Per-platform vocabulary fixtures +
 * multi-source + no-match→NULL. The DB post-pass (runResolutionOraclePass) is
 * exercised elsewhere, not here (no DB in unit tests).
 */
import { describe, it, expect } from 'bun:test';
import { parseResolutionOracle, RESOLUTION_ORACLES } from './resolution-oracle.js';

const UMA_ADAPTER = '0x69c47De9D4D3Dad79590d61b9e05918E03775f24';

describe('parseResolutionOracle — polymarket', () => {
  it('maps crypto/finance resolutionSource hosts to the specific oracle', () => {
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://data.chain.link/streams/btc-usd', resolvedBy: UMA_ADAPTER })).toBe('Chainlink');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://www.binance.com/en/trade/BTC_USDT', resolvedBy: UMA_ADAPTER })).toBe('Binance');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://pythdata.app/', resolvedBy: UMA_ADAPTER })).toBe('Pyth');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://finance.yahoo.com/quote/AMZN', resolvedBy: UMA_ADAPTER })).toBe('Yahoo Finance');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://www.cmegroup.com/', resolvedBy: UMA_ADAPTER })).toBe('CME Group');
  });

  it('maps sports/esports resolutionSource hosts (incl. subdomains) to the authority', () => {
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://hltv.org', resolvedBy: UMA_ADAPTER })).toBe('HLTV');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://www.atptour.com/en/scores/current', resolvedBy: UMA_ADAPTER })).toBe('ATP Tour');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://www.fifa.com', resolvedBy: UMA_ADAPTER })).toBe('FIFA');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://www.laliga.com/', resolvedBy: UMA_ADAPTER })).toBe('La Liga');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://www.wunderground.com/history', resolvedBy: UMA_ADAPTER })).toBe('Weather Underground');
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://gol.gg/esports/home', resolvedBy: UMA_ADAPTER })).toBe('gol.gg');
  });

  it('falls back to UMA when resolutionSource is empty/unrecognized but resolvedBy is a UMA adapter', () => {
    // empty resolutionSource
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: '', resolvedBy: UMA_ADAPTER })).toBe('UMA');
    // unrecognized league host → still UMA-settled
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://some-obscure-league.example', resolvedBy: UMA_ADAPTER })).toBe('UMA');
    // x.com (deliberately unmapped) → UMA
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: 'https://x.com/somepost', resolvedBy: UMA_ADAPTER })).toBe('UMA');
  });

  it('reads a named authority from the description resolution-source clause before UMA', () => {
    const desc = 'This market will resolve to the player who wins the Cy Young Award. The resolution source for this market will be official information from MLB (https://www.mlb.com).';
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: '', resolvedBy: UMA_ADAPTER, description: desc })).toBe('MLB');
  });

  it('returns NULL when there is no signal at all', () => {
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: '', resolvedBy: '' })).toBeNull();
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: null, resolvedBy: null })).toBeNull();
    // resolvedBy present but NOT an eth address → not a UMA adapter → NULL
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: '', resolvedBy: 'not-an-address' })).toBeNull();
  });

  it('does not stamp UMA from a generic description clause with no recognized authority', () => {
    const generic = 'resolution source will be a consensus of credible reporting assessing who exercises effective governing authority';
    // empty resolvedBy → no UMA fallback → the generic clause names nobody → NULL
    expect(parseResolutionOracle({ platform: 'polymarket', resolutionSource: '', resolvedBy: '', description: generic })).toBeNull();
  });
});

describe('parseResolutionOracle — predict', () => {
  it('stamps UMA when the market shares a Polymarket conditionId', () => {
    expect(parseResolutionOracle({ platform: 'predict', polymarketConditionIds: '["0xabc123"]' })).toBe('UMA');
    expect(parseResolutionOracle({ platform: 'predict', polymarketConditionIds: '["0xabc","0xdef"]' })).toBe('UMA');
  });

  it('reads an explicit named authority from the description clause (Binance/NBA/IPL)', () => {
    expect(parseResolutionOracle({ platform: 'predict', description: 'The resolution source for this market is Binance, specifically the BNB/USDT High and Low prices.' })).toBe('Binance');
    expect(parseResolutionOracle({ platform: 'predict', description: 'The resolution source for this market will be information from the NBA.' })).toBe('NBA');
    expect(parseResolutionOracle({ platform: 'predict', description: 'resolution source will be the IPL (https://www.iplt20.com).' })).toBe('IPL');
  });

  it('captures the Federal Reserve as the clause authority (cross-venue with kalshi), not generic UMA', () => {
    const fed = { platform: 'predict', polymarketConditionIds: '["0xabc"]', description: 'This market resolves per the FOMC decision. The resolution source for this market is the official website of the Federal Reserve at https://www.federalreserve.gov/monetarypolicy/openmarket.htm.' };
    expect(parseResolutionOracle(fed)).toBe('Federal Reserve');
  });

  it('prefers a named clause authority over the shared-condition UMA fallback', () => {
    const input = { platform: 'predict', polymarketConditionIds: '["0xabc"]', description: 'The resolution source for this market will be official information from MLB (https://www.mlb.com).' };
    expect(parseResolutionOracle(input)).toBe('MLB');
  });

  it('returns NULL for empty conditionIds and generic/absent clauses', () => {
    expect(parseResolutionOracle({ platform: 'predict', polymarketConditionIds: '[]' })).toBeNull();
    expect(parseResolutionOracle({ platform: 'predict', polymarketConditionIds: 'null' })).toBeNull();
    expect(parseResolutionOracle({ platform: 'predict', polymarketConditionIds: null, description: 'The resolution source for this market is the official final statistics of the event as recognized by the governing body or event organizers.' })).toBeNull();
  });
});

describe('parseResolutionOracle — kalshi', () => {
  it('recovers the Federal Reserve rate-decision authority (Fed + rate context)', () => {
    const rules = 'This market is mutually exclusive. Therefore, if the Federal Reserve hikes by 50bps, the 50bps market will resolve to Yes and the 25bps market will resolve to No.';
    expect(parseResolutionOracle({ platform: 'kalshi', rulesSecondary: rules })).toBe('Federal Reserve');
  });

  it('does NOT stamp Fed on an incidental mention without a rate context', () => {
    const rules = 'The Federal Reserve building is a landmark; this market is about tourism visits.';
    expect(parseResolutionOracle({ platform: 'kalshi', rulesPrimary: rules })).toBeNull();
  });

  it('recovers a spelled-out agency in rules text', () => {
    expect(parseResolutionOracle({ platform: 'kalshi', rulesPrimary: 'Settled per the Bureau of Labor Statistics release.' })).toBe('BLS');
  });

  it('returns NULL for the sports/election tail with no named oracle', () => {
    const rules = 'If Senegal is one of the teams to qualify for the Semifinals in the 2026 FIFA World Cup, then the market resolves to Yes.';
    // "FIFA World Cup" is the event, not a stated resolution source → NULL (honest).
    expect(parseResolutionOracle({ platform: 'kalshi', rulesPrimary: rules })).toBeNull();
    expect(parseResolutionOracle({ platform: 'kalshi', rulesPrimary: 'If the Democratic Party wins the 2026 gubernatorial election in Wisconsin, then the market resolves to Yes.' })).toBeNull();
  });
});

describe('parseResolutionOracle — limitless', () => {
  it('reads a named authority from the description clause, else NULL', () => {
    expect(parseResolutionOracle({ platform: 'limitless', description: 'The resolution source will be official information from the NBA.' })).toBe('NBA');
    // the common goal/card-total descriptions name no oracle
    expect(parseResolutionOracle({ platform: 'limitless', description: 'This market will resolve to "YES" if the combined total goals is 3 or higher.' })).toBeNull();
    expect(parseResolutionOracle({ platform: 'limitless', description: null })).toBeNull();
  });
});

describe('parseResolutionOracle — invariants', () => {
  it('never throws and only ever emits a controlled-enum member', () => {
    const fuzz: any[] = [
      { platform: 'polymarket', resolutionSource: 'garbage', resolvedBy: '0x' },
      { platform: 'unknown-platform', description: 'resolution source will be NBA' },
      { platform: 'kalshi', rulesPrimary: undefined, rulesSecondary: undefined },
      { platform: 'predict', polymarketConditionIds: '{not json' },
      { platform: 'limitless' },
    ];
    for (const f of fuzz) {
      const out = parseResolutionOracle(f);
      expect(out === null || RESOLUTION_ORACLES.has(out)).toBe(true);
    }
  });

  it('unknown platform → NULL (never a platform tag)', () => {
    expect(parseResolutionOracle({ platform: 'unknown', resolvedBy: UMA_ADAPTER })).toBeNull();
  });
});
